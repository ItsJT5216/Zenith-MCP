import { z } from "zod";
import { accessSync, statSync, constants as fsConstants } from "fs";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import path from "path";
import { getBashTimeoutSeconds, getBashMaxTimeoutSeconds } from '../core/shared.js';
import { getCallerWorkingDirectory } from '../core/caller-cwd.js';
import type { ToolServer, ToolContext, ToolCallExtra } from './types.js';
import { errorMessage } from './types.js';

// Process mechanics only. The timeout default and its cap are configuration
// (advanced.bash_timeout_seconds / bash_max_timeout_seconds) — never literals here.
/** Grace between SIGTERM and SIGKILL to the process group when a command is stopped. */
const TERM_GRACE_MS = 2_000;
/** Grace between the shell's `exit` and its `close` before the pipes are cut. */
const EXIT_GRACE_MS = 250;
/** While a stopped command's group is waited on, how often its emptiness is re-checked. */
const GROUP_POLL_MS = 50;
/** Rendered pieces are joined into the transcript in batches of this many. */
const TEXT_BATCH_PIECES = 1024;

interface BashArgs {
    command: string;
    timeout?: number;
}

type ExitStatus = { code: number | null; signal: NodeJS.Signals | null };
type StopReason = 'timeout' | 'cancel';

// ---------------------------------------------------------------------------
// Shell resolution — mirrors the ripgrep resolver in core/shared.ts: PATH scan
// plus well-known locations, cached module-level. Unlike rg there is no
// bare-name fallback and no `sh`: the tool is named bash, and bashisms failing
// under sh would be a silent lie. No `which`/`where` subprocess either.
// ---------------------------------------------------------------------------

const BASH_BIN: string = process.platform === 'win32' ? 'bash.exe' : 'bash';

const WELL_KNOWN_BASH_PATHS: string[] = (() => {
    if (process.platform !== 'win32') {
        return ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash'];
    }
    const paths: string[] = [];
    for (const envKey of ['ProgramFiles', 'ProgramFiles(x86)']) {
        const programFiles = process.env[envKey];
        if (programFiles !== undefined && programFiles.length > 0) {
            paths.push(path.join(programFiles, 'Git', 'bin', BASH_BIN));
        }
    }
    return paths;
})();

let _bashPath: string | null = null;

function candidateShell(dir: string): string | null {
    // Absolute from the start: a relative PATH entry would otherwise be checked
    // against this process's cwd and later spawned against the command's.
    const candidate = path.resolve(dir, BASH_BIN);
    try {
        if (!statSync(candidate).isFile()) return null;
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
    } catch { return null; }
}

function scanPath(): string | null {
    const pathEnv = process.env.PATH;
    if (pathEnv === undefined) return null;
    for (const dir of pathEnv.split(path.delimiter)) {
        if (dir.length === 0) continue;
        const found = candidateShell(dir);
        if (found !== null) return found;
    }
    return null;
}

function scanWellKnown(): string | null {
    for (const known of WELL_KNOWN_BASH_PATHS) {
        const found = candidateShell(path.dirname(known));
        if (found !== null) return found;
    }
    return null;
}

function resolveBashPath(): string {
    if (_bashPath !== null) return _bashPath;
    // Windows has a well-known impostor: System32\bash.exe is the WSL launcher and
    // usually precedes Git's bin on PATH, so Git Bash's known locations go first there.
    const found = process.platform === 'win32'
        ? scanWellKnown() ?? scanPath()
        : scanPath() ?? scanWellKnown();
    if (found === null) throw new Error('bash not found.');
    _bashPath = found;
    return found;
}

// Extends the ripgrep spawn precedent in one deliberate way: `detached` makes
// the shell a process-group leader so the whole pipeline can be signalled at
// once. Node's kill() reaches only the direct child; orphaned grandchildren
// would keep running AND hold the stdout pipe open so `close` never fires. Env
// is inherited (no `env`, exactly like rg). stdin is closed so nothing ever
// waits on input. A synchronous spawn failure (an over-long argument list, say)
// is the tool failing, in the tool's words.
function spawnBash(shell: string, command: string, cwd: string) {
    try {
        return spawn(shell, ['-c', command], {
            cwd,
            detached: process.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
    } catch (err) {
        throw new Error(`Spawn failed: ${errorMessage(err)}`);
    }
}

// ---------------------------------------------------------------------------
// Live children — every shell whose call is still in flight. Swept (SIGKILL to
// the group) when this process exits and on SIGTERM/SIGINT/SIGHUP, so a server
// shutdown does not leave a running command behind. What outlives its call — a
// service the command deliberately started detached — is not tracked and not
// swept. The listeners are prepended, so they run before any other and a `once`
// listener registered earlier is still counted; only when this listener is the
// only one is the signal re-raised with its default disposition, so how the
// server dies is unchanged. Installed on first spawn, so registering the tool
// (once per request in the HTTP entrypoint) adds nothing.
// ---------------------------------------------------------------------------

const _liveChildren: Set<ChildProcess> = new Set();
let _sweepInstalled = false;

function killTreeNow(pid: number): void {
    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
        return;
    }
    try { process.kill(-pid, 'SIGKILL'); } catch { /* group already gone */ }
}

function sweepLiveChildren(): void {
    for (const child of _liveChildren) {
        if (child.pid !== undefined) killTreeNow(child.pid);
    }
    _liveChildren.clear();
}

function installShutdownSweep(): void {
    if (_sweepInstalled) return;
    _sweepInstalled = true;
    process.once('exit', sweepLiveChildren);
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
        const onSignal = (): void => {
            sweepLiveChildren();
            if (process.listenerCount(sig) === 1) {
                process.removeListener(sig, onSignal);
                process.kill(process.pid, sig);
            }
        };
        process.prependListener(sig, onSignal);
    }
}

// ---------------------------------------------------------------------------
// Terminal rendering. Output is rendered as it arrives — the way a terminal
// shows it — straight into the transcript, never held as per-line arrays.
// Sequences are recognised structurally (ECMA-48: CSI, ESC sequences, control
// strings), so one split across two chunks, or a control string spanning lines,
// renders correctly. The model is one line at a time with cells being code
// points (a tab or a wide character is one cell): printable text, CR, backspace,
// erase-in-line (EL 0/1/2), cursor to column (CHA) and cursor back/forward
// (CUB/CUF). Everything else is removed — colours and other CSI/ESC sequences,
// control strings (OSC/DCS/SOS/PM/APC, swallowed with their payload up to ST or
// BEL, newlines included) and stray control bytes. Cursor motion never creates
// cells — only written text does — so nothing in the output can make the
// renderer allocate beyond the text it received; a move past the end of the line
// lands at the end. Completed pieces are joined into the transcript in batches,
// so the transcript costs about its own size.
// ---------------------------------------------------------------------------

/** Characters that need attention in text: C0 controls except tab, DEL, C1 controls, interlinear annotation marks. */
const SPECIAL_RE = /[\x00-\x08\x0a-\x1f\x7f\x80-\x9f\ufff9-\ufffb]/g;
/** The same on a line nothing has been rendered to yet — its newlines pass straight through. */
const PRISTINE_SPECIAL_RE = /[\x00-\x08\x0b-\x1f\x7f\x80-\x9f\ufff9-\ufffb]/g;
/** What ends a control string: BEL (OSC only), ESC (ST, or a new sequence), 8-bit ST, CAN, SUB. */
const OSC_END_RE = /[\x07\x18\x1a\x1b\x9c]/g;
const ST_END_RE = /[\x18\x1a\x1b\x9c]/g;
const CSI_PLAIN_PARAMS_RE = /^[\d;]*$/;
/** A parameter string this long is not a sequence anyone meant; extra bytes are not kept. */
const CSI_PARAMS_MAX = 64;

function nextCodePoint(s: string, i: number): number {
    const c = s.charCodeAt(i);
    return c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00 ? i + 2 : i + 1;
}

function prevCodePoint(s: string, i: number): number {
    const c = s.charCodeAt(i - 1);
    return c >= 0xdc00 && c <= 0xdfff && i >= 2 && (s.charCodeAt(i - 2) & 0xfc00) === 0xd800 ? i - 2 : i - 1;
}

function countCodePoints(s: string): number {
    let n = 0;
    for (let i = 0; i < s.length; i = nextCodePoint(s, i)) n++;
    return n;
}

class TerminalRenderer {
    private text = '';
    /** The current line as rendered so far; `cursor` is a code-unit index into it on a code point boundary. */
    private line = '';
    private cursor = 0;
    /** Printable text not yet written at `cursor`. */
    private run = '';
    /** Completed pieces of transcript waiting to be joined onto `text`. */
    private pieces: string[] = [];
    private state: 'ground' | 'esc' | 'esc-intermediate' | 'csi' | 'string' | 'string-esc' = 'ground';
    private csi = '';
    private oscString = false;

    feed(chunk: string): void {
        let i = 0;
        while (i < chunk.length) {
            switch (this.state) {
                case 'ground': i = this.ground(chunk, i); break;
                case 'esc': i = this.escape(chunk, i); break;
                case 'esc-intermediate': i = this.escapeIntermediate(chunk, i); break;
                case 'csi': i = this.controlSequence(chunk, i); break;
                case 'string': i = this.controlString(chunk, i); break;
                case 'string-esc': i = this.controlStringEscape(chunk, i); break;
            }
        }
    }

    /** The transcript. Whatever is still inside an unterminated sequence or control string is not part of it. */
    finish(): string {
        this.flushRun();
        this.emit(this.line);
        this.line = '';
        this.cursor = 0;
        this.flushPieces();
        return this.text;
    }

    private emit(piece: string): void {
        if (piece.length === 0) return;
        this.pieces.push(piece);
        if (this.pieces.length >= TEXT_BATCH_PIECES) this.flushPieces();
    }

    private flushPieces(): void {
        if (this.pieces.length === 0) return;
        this.text += this.pieces.join('');
        this.pieces.length = 0;
    }

    private ground(chunk: string, i: number): number {
        const pristine = this.line.length === 0 && this.cursor === 0;
        const re = pristine ? PRISTINE_SPECIAL_RE : SPECIAL_RE;
        re.lastIndex = i;
        const m = re.exec(chunk);
        const end = m === null ? chunk.length : m.index;
        if (end > i) {
            const span = chunk.slice(i, end);
            const nl = pristine ? span.lastIndexOf('\n') : -1;
            if (nl === -1) {
                this.run += span;
            } else {
                this.emit(this.run + span.slice(0, nl + 1));
                this.run = span.slice(nl + 1);
            }
        }
        if (m === null) return chunk.length;
        this.control(chunk.charCodeAt(end));
        return end + 1;
    }

    private control(code: number): void {
        switch (code) {
            case 0x0a:
                this.flushRun();
                this.emit(this.line + '\n');
                this.line = '';
                this.cursor = 0;
                return;
            case 0x0d:
                this.flushRun();
                this.cursor = 0;
                return;
            case 0x08:
                this.flushRun();
                if (this.cursor > 0) this.cursor = prevCodePoint(this.line, this.cursor);
                return;
            case 0x1b:
                this.state = 'esc';
                return;
            case 0x9b:
                this.state = 'csi';
                this.csi = '';
                return;
            case 0x9d:
                this.state = 'string';
                this.oscString = true;
                return;
            case 0x90: case 0x98: case 0x9e: case 0x9f:
                this.state = 'string';
                this.oscString = false;
                return;
            default:
                return; // no other control renders anything
        }
    }

    private escape(chunk: string, i: number): number {
        const code = chunk.charCodeAt(i);
        if (code === 0x5b) { this.state = 'csi'; this.csi = ''; return i + 1; }                 // ESC [
        if (code === 0x5d) { this.state = 'string'; this.oscString = true; return i + 1; }      // ESC ]
        if (code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) {                 // ESC P X ^ _
            this.state = 'string';
            this.oscString = false;
            return i + 1;
        }
        if (code >= 0x20 && code <= 0x2f) { this.state = 'esc-intermediate'; return i + 1; }  // intermediate: a final byte follows
        if (code < 0x20) return this.controlInsideSequence(code, i);
        this.state = 'ground';
        if (code >= 0x30 && code <= 0x7e) return i + 1;                                        // final byte: complete, renders nothing
        return i;                                                                              // not a sequence: the ESC is dropped, this character is text
    }

    /** After an intermediate byte only more intermediates or the final byte belong to the sequence. */
    private escapeIntermediate(chunk: string, i: number): number {
        const code = chunk.charCodeAt(i);
        if (code >= 0x20 && code <= 0x2f) return i + 1;
        if (code < 0x20) return this.controlInsideSequence(code, i);
        this.state = 'ground';
        if (code >= 0x30 && code <= 0x7e) return i + 1;
        return i;
    }

    private controlSequence(chunk: string, i: number): number {
        const code = chunk.charCodeAt(i);
        if (code >= 0x20 && code <= 0x3f) {                                                    // parameter and intermediate bytes
            if (this.csi.length < CSI_PARAMS_MAX) this.csi += chunk.charAt(i);
            return i + 1;
        }
        if (code < 0x20) return this.controlInsideSequence(code, i);
        if (code === 0x7f) return i + 1;                                                       // DEL inside a sequence is ignored
        this.state = 'ground';
        if (code >= 0x40 && code <= 0x7e) { this.dispatch(code); return i + 1; }               // final byte
        return i;                                                                              // malformed: dropped, this character is text
    }

    // A C0 control inside a sequence: CAN and SUB abandon it, ESC starts over, and
    // any other executes at once — a newline still breaks the line — while the
    // sequence goes on.
    private controlInsideSequence(code: number, i: number): number {
        if (code === 0x18 || code === 0x1a) { this.state = 'ground'; return i + 1; }
        if (code === 0x1b) { this.state = 'esc'; this.csi = ''; return i + 1; }
        const state = this.state;
        this.control(code);
        this.state = state;
        return i + 1;
    }

    private dispatch(final: number): void {
        if (!CSI_PLAIN_PARAMS_RE.test(this.csi)) return;                                       // private and intermediate forms are not modelled
        const semi = this.csi.indexOf(';');
        const first = semi === -1 ? this.csi : this.csi.slice(0, semi);
        const param = (dflt: number): number => (first.length === 0 ? dflt : Number(first));  // an omitted parameter means its default
        switch (final) {
            case 0x4b: this.eraseInLine(param(0)); return;                                    // K   EL
            case 0x47: this.moveToCell(Math.max(1, param(1)) - 1); return;                     // G   CHA
            case 0x44: this.moveBack(Math.max(1, param(1))); return;                           // D   CUB
            case 0x43: this.moveForward(Math.max(1, param(1))); return;                        // C   CUF
            default: return;
        }
    }

    private controlString(chunk: string, i: number): number {
        const re = this.oscString ? OSC_END_RE : ST_END_RE;
        re.lastIndex = i;
        const m = re.exec(chunk);
        if (m === null) return chunk.length;                                                   // still inside: all of it is swallowed
        this.state = chunk.charCodeAt(m.index) === 0x1b ? 'string-esc' : 'ground';            // BEL, 8-bit ST, CAN or SUB ends it here
        return m.index + 1;
    }

    private controlStringEscape(chunk: string, i: number): number {
        if (chunk.charCodeAt(i) === 0x5c) { this.state = 'ground'; return i + 1; }             // ESC \ is ST
        this.state = 'esc';                                                                    // any other ESC ends the string and starts a sequence
        return i;
    }

    private flushRun(): void {
        if (this.run.length === 0) return;
        if (this.cursor === this.line.length) {
            this.line += this.run;
        } else {
            let end = this.cursor;
            for (let n = countCodePoints(this.run); n > 0 && end < this.line.length; n--) end = nextCodePoint(this.line, end);
            this.line = this.line.slice(0, this.cursor) + this.run + this.line.slice(end);
        }
        this.cursor += this.run.length;
        this.run = '';
    }

    private eraseInLine(mode: number): void {
        this.flushRun();
        if (mode === 0) {                                                                      // cursor to end of line
            this.line = this.line.slice(0, this.cursor);
            return;
        }
        const before = countCodePoints(this.line.slice(0, this.cursor));
        if (mode === 1) {                                                                      // start of line through the cursor cell
            const onCell = this.cursor < this.line.length;
            const rest = onCell ? this.line.slice(nextCodePoint(this.line, this.cursor)) : '';
            this.line = ' '.repeat(before + (onCell ? 1 : 0)) + rest;
            this.cursor = before;
            return;
        }
        if (mode === 2) {                                                                      // the whole line; the cursor stays put
            this.line = ' '.repeat(before);
            this.cursor = before;
        }
    }

    private moveToCell(cell: number): void {
        this.flushRun();
        this.cursor = 0;
        this.moveForward(cell);
    }

    private moveForward(cells: number): void {
        this.flushRun();
        let i = this.cursor;
        for (let n = cells; n > 0 && i < this.line.length; n--) i = nextCodePoint(this.line, i);
        this.cursor = i;
    }

    private moveBack(cells: number): void {
        this.flushRun();
        let i = this.cursor;
        for (let n = cells; n > 0 && i > 0; n--) i = prevCodePoint(this.line, i);
        this.cursor = i;
    }
}

export function register(server: ToolServer, ctx: ToolContext): void {
    server.registerTool("bash", {
        title: "Bash",
        description: "Run a bash command in your current working directory; to work elsewhere, use absolute paths. Returns a terminal transcript: a prompt line (<cwd>$ <command>), stdout and stderr merged with ANSI stripped, and a status line with the exit code. Output is returned in full. stdin is closed; start services detached with output redirected.",
        inputSchema: z.object({
            command: z.string().min(1).describe("Command to run."),
            timeout: z.number().int().min(1).optional().describe("Seconds. Default and cap come from config (bash_timeout_seconds, bash_max_timeout_seconds)."),
        }).strict(),
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true }
    }, async (args: BashArgs, extra?: ToolCallExtra) => {
        if (args.command.includes('\0')) throw new Error('Command contains null byte.');
        const signal = extra?.signal;

        // The command runs where the caller is working (core/caller-cwd.ts): the
        // nearest ancestor process's cwd — the launcher shell, or the MCP client on
        // stdio — realpath'd and stat'd as a directory by the walk. It is the same
        // base a relative path resolves against, so bash and the file tools can
        // never disagree about where a relative path lands. There is no cwd
        // parameter: to work elsewhere, the command uses absolute paths. validatePath
        // applies the sandbox policy, when one is enabled, exactly as it does to
        // every other tool's path — a working directory outside the boundary is
        // refused, not redirected, and the refusal names the directory and why,
        // since the caller chose nothing. A directory that vanishes between the walk
        // and the spawn surfaces from the spawn itself (see the 'error' handler).
        // The working directory decides where the command runs and nothing else.
        const callerCwd = getCallerWorkingDirectory();
        const cwd = await ctx.validatePath(callerCwd).catch((err: unknown) => {
            throw new Error(`Cannot run in the caller's working directory ${callerCwd}: ${errorMessage(err)}`);
        });

        const timeoutS = Math.min(args.timeout ?? getBashTimeoutSeconds(), getBashMaxTimeoutSeconds());
        const shell = resolveBashPath();
        const prompt = `${cwd}$ ${args.command}\n`;
        if (signal?.aborted) return { content: [{ type: "text", text: `${prompt}[cancelled]` }] };

        const proc = spawnBash(shell, args.command, cwd);
        installShutdownSweep();
        _liveChildren.add(proc);

        // One decoder per stream: a multibyte sequence split across chunks must
        // decode correctly, and one stream's partial sequence must never be
        // completed by the other's bytes. Both render into ONE transcript in
        // arrival order — that is what a terminal shows. Output is kept in full.
        const renderer = new TerminalRenderer();
        const stdoutDecoder = new TextDecoder('utf-8');
        const stderrDecoder = new TextDecoder('utf-8');

        let stopping: StopReason | null = null;
        let transcript = '';
        let timeoutTimer: NodeJS.Timeout | undefined;
        let termGraceTimer: NodeJS.Timeout | undefined;
        let exitGraceTimer: NodeJS.Timeout | undefined;
        let groupPoll: NodeJS.Timeout | undefined;
        let onAbort: (() => void) | undefined;
        let status: ExitStatus;
        try {
            status = await new Promise<ExitStatus>((resolve, reject) => {
                const pid = proc.pid;
                let settled = false;
                let exitStatus: ExitStatus | undefined;
                let closeStatus: ExitStatus | undefined;
                // Once a stop is under way: the tree is known to be dead or SIGKILL is out.
                let treeDead = false;

                const retire = (): void => { _liveChildren.delete(proc); };
                // Whether anything is left in the command's process group. Zombies count
                // until reaped; Windows has no groups, so only taskkill's word counts there.
                const groupGone = (): boolean => {
                    if (pid === undefined) return true;
                    if (process.platform === 'win32') return false;
                    try {
                        process.kill(-pid, 0);
                        return false;
                    } catch (err) {
                        return (err as NodeJS.ErrnoException).code === 'ESRCH';
                    }
                };
                // The tool itself failing: the call is over, whatever the command is doing.
                const fail = (err: Error): void => {
                    if (settled) return;
                    settled = true;
                    retire();
                    proc.stdout.destroy();
                    proc.stderr.destroy();
                    reject(err);
                };
                // ESRCH means the group is already gone. Anything else is the tool failing
                // to stop its own command.
                const killGroup = (sig: NodeJS.Signals): boolean => {
                    if (pid === undefined) return true;
                    try {
                        process.kill(-pid, sig);
                        return true;
                    } catch (err) {
                        if ((err as NodeJS.ErrnoException).code === 'ESRCH') return true;
                        fail(new Error(`Kill failed: ${errorMessage(err)}`));
                        return false;
                    }
                };
                // Immediate, unconditional: for the paths where the call is failing anyway.
                const killTree = (): boolean => {
                    if (pid === undefined) return true;
                    if (process.platform !== 'win32') return killGroup('SIGKILL');
                    const result = spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
                    if (result.status === 0) return true;
                    fail(new Error(`Kill failed: ${result.error !== undefined ? errorMessage(result.error) : `taskkill exited with code ${result.status}`}`));
                    return false;
                };
                // Every byte of output is rendered through here. V8 strings have a hard
                // length limit, and exceeding it inside a stream callback would be an
                // uncaught exception that takes the server down; it becomes the tool
                // failing instead, and the pipeline is stopped.
                const guarded = (step: () => void): boolean => {
                    try {
                        step();
                        return true;
                    } catch (err) {
                        if (!killTree()) return false;
                        fail(err instanceof RangeError
                            ? new Error('Output exceeded the maximum string length; process group killed.')
                            : new Error(`Capture failed: ${errorMessage(err)}`));
                        return false;
                    }
                };
                const finalize = (s: ExitStatus): void => {
                    if (settled) return;
                    if (!guarded(() => {
                        renderer.feed(stdoutDecoder.decode());
                        renderer.feed(stderrDecoder.decode());
                        transcript = renderer.finish();
                    })) return;
                    settled = true;
                    retire();
                    resolve(s);
                };
                // `close` normally follows `exit` within microseconds. When it does not, a
                // descendant is holding the inherited pipes; it must not hang the tool, so
                // the pipes are cut and the shell's own status is used.
                const scheduleExitGrace = (): void => {
                    if (exitGraceTimer !== undefined) return;
                    exitGraceTimer = setTimeout(() => {
                        if (exitStatus === undefined) return;
                        proc.stdout.destroy();
                        proc.stderr.destroy();
                        finalize(exitStatus);
                    }, EXIT_GRACE_MS);
                };
                // The one place a call may complete. While a stop is under way nothing
                // completes until the group is dead or SIGKILL is out — otherwise a
                // descendant that ignored SIGTERM (and did not keep the pipes) would
                // survive behind a status line saying the group was killed.
                const settle = (): void => {
                    if (settled) return;
                    if (stopping !== null && !treeDead) return;
                    if (closeStatus !== undefined) {
                        finalize(closeStatus);
                        return;
                    }
                    if (exitStatus !== undefined) scheduleExitGrace();
                };
                const stop = (reason: StopReason): void => {
                    if (settled || stopping !== null) return;
                    stopping = reason;
                    clearTimeout(exitGraceTimer); // a pending grace must not complete the call under the escalation
                    exitGraceTimer = undefined;
                    if (process.platform === 'win32') {
                        // No process groups on Windows: taskkill /T walks the tree, /F forces.
                        const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
                        killer.on('error', (err) => fail(new Error(`Kill failed: ${errorMessage(err)}`)));
                        killer.on('exit', (code) => {
                            if (code !== 0) {
                                fail(new Error(`Kill failed: taskkill exited with code ${code}`));
                                return;
                            }
                            treeDead = true;
                            if (exitStatus === undefined) proc.kill();
                            settle();
                        });
                        return;
                    }
                    if (!killGroup('SIGTERM')) return;
                    groupPoll = setInterval(() => {
                        if (!groupGone()) return;
                        clearInterval(groupPoll);
                        treeDead = true;
                        settle();
                    }, GROUP_POLL_MS);
                    termGraceTimer = setTimeout(() => {
                        if (settled) return;
                        clearInterval(groupPoll);
                        if (!killGroup('SIGKILL')) return;
                        treeDead = true;
                        settle();
                    }, TERM_GRACE_MS);
                };

                proc.stdout.on('data', (chunk: Buffer) => { guarded(() => renderer.feed(stdoutDecoder.decode(chunk, { stream: true }))); });
                proc.stderr.on('data', (chunk: Buffer) => { guarded(() => renderer.feed(stderrDecoder.decode(chunk, { stream: true }))); });
                proc.stdout.on('error', (err) => { if (killTree()) fail(new Error(`Capture failed: ${errorMessage(err)}`)); });
                proc.stderr.on('error', (err) => { if (killTree()) fail(new Error(`Capture failed: ${errorMessage(err)}`)); });

                proc.on('error', (err) => {
                    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                        fail(new Error(`Spawn failed: ${errorMessage(err)}`));
                        return;
                    }
                    // Node reports a working directory that vanished since the walk stat'd it
                    // with the same code as a shell that cannot be executed; the directory
                    // itself tells them apart.
                    try {
                        statSync(cwd);
                    } catch {
                        fail(new Error('Working directory not found.'));
                        return;
                    }
                    _bashPath = null; // re-resolve on the next call
                    fail(new Error('bash not found.'));
                });
                proc.on('exit', (code, sig) => {
                    exitStatus = { code, signal: sig };
                    settle();
                });
                proc.on('close', (code, sig) => {
                    closeStatus = { code, signal: sig };
                    settle();
                });

                if (pid === undefined) return; // spawn failed; `error` settles this promise
                timeoutTimer = setTimeout(() => stop('timeout'), timeoutS * 1000);
                onAbort = () => stop('cancel');
                signal?.addEventListener('abort', onAbort, { once: true });
            });
        } finally {
            clearTimeout(timeoutTimer);
            clearTimeout(termGraceTimer);
            clearTimeout(exitGraceTimer);
            clearInterval(groupPoll);
            if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
        }

        // Render: prompt line, the output (omitted when empty, otherwise ending in
        // exactly one newline), status line. The exit code is data — only the tool
        // itself failing goes through the throw channel above.
        const body = transcript.length === 0 ? '' : transcript.endsWith('\n') ? transcript : `${transcript}\n`;
        let statusLine: string;
        if (stopping === 'timeout') statusLine = `[timed out after ${timeoutS}s; process group killed]`;
        else if (stopping === 'cancel') statusLine = '[cancelled; process group killed]';
        else if (status.signal !== null) statusLine = `[terminated by ${status.signal}]`;
        else if (status.code !== null) statusLine = `[exit code ${status.code}]`;
        else statusLine = '[exit code unknown]';
        return { content: [{ type: "text", text: `${prompt}${body}${statusLine}` }] };
    });
}

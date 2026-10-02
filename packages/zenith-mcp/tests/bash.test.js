/**
 * bash tool — contract tests.
 *
 * Every case names the contract clause it pins. The tool takes no working
 * directory: a command runs where the caller is, and the transcript's prompt
 * line carries that directory as core/caller-cwd answers it (realpath'd), so
 * `callerCwd` is used wherever a path appears in an expectation. `tmpDir` is
 * where a command may leave a file and, in the sandbox case, the boundary;
 * mkTmpDir returns a realpath so that it compares with the caller's directory
 * like for like on platforms where the temp root is a symlink (macOS /var →
 * /private/var).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { getCallerWorkingDirectory } from '../dist/core/caller-cwd.js';

/** The tool's source, read from disk for the drift pin — the way detection-encapsulation.test.js reads src/. */
const BASH_SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'tools', 'bash.ts');

/** Where the tool runs a command — the caller's working directory; realpath'd by the primitive, so it matches the prompt line. */
const callerCwd = getCallerWorkingDirectory();

function mkTmpDir() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bash-test-')));
}

function captureHandler() {
    const calls = [];
    const server = {
        registerTool: (name, schema, handler) => {
            calls.push({ name, schema, handler });
        },
    };
    return { server, calls };
}

function mkCtx(baseDir) {
    return {
        validatePath: async (p) => path.resolve(p),
        getAllowedDirectories: () => [baseDir],
    };
}

// Timeout cases spend a 1 s limit plus up to 2 s of SIGTERM grace before SIGKILL.
const SLOW = 10_000;

// The stopping contract these cases pin — process groups, SIGTERM then SIGKILL,
// `$$`/`$!` pids — is POSIX; on Windows the tool stops a command with taskkill
// and none of it applies.
const posixOnly = it.skipIf(process.platform === 'win32');
// Only Linux refuses a single argument over 128 KiB (MAX_ARG_STRLEN) at spawn time.
const linuxOnly = it.skipIf(process.platform !== 'linux');

// Once a spawn has happened the tool listens for SIGTERM/SIGINT/SIGHUP to sweep its
// children (re-raising when it is the only listener). Vitest's worker has its own
// listeners, so nothing is re-raised here — this only checks the hook is present.
function shutdownListenersInstalled() {
    return ['SIGTERM', 'SIGINT', 'SIGHUP'].every((sig) => process.listenerCount(sig) > 0);
}

// Poll every 50 ms until the pid is gone or the deadline passes. Gone means
// ESRCH from kill(pid, 0) or, on Linux, a zombie (`Z` in /proc/<pid>/stat): a
// killed grandchild is reparented to init or a subreaper whose reap latency is
// not the tool's to control, and kill(pid, 0) still succeeds on a zombie.
async function pidGone(pid, withinMs) {
    const deadline = Date.now() + withinMs;
    for (;;) {
        try {
            process.kill(pid, 0);
        } catch (err) {
            if (err.code === 'ESRCH') return true;
            throw err;
        }
        if (process.platform === 'linux') {
            let stat = '';
            try {
                stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
            } catch (err) {
                if (err.code === 'ENOENT' || err.code === 'ESRCH') return true;
            }
            if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) return true;
        }
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

describe('bash tool', () => {
    let tmpDir, registration, handler;

    beforeEach(async () => {
        tmpDir = mkTmpDir();
        const ctx = mkCtx(tmpDir);
        const mod = await import('../dist/tools/bash.js');
        const { server, calls } = captureHandler();
        mod.register(server, ctx);
        registration = calls[0];
        handler = registration.handler;
    });

    afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    async function run(args) {
        const result = await handler(args);
        return result.content[0].text;
    }

    // Contract: name `bash`, title `Bash`, the exact description, destructive annotations.
    it('registers as bash with the contract title, description and annotations', () => {
        expect(registration.name).toBe('bash');
        expect(registration.schema.title).toBe('Bash');
        expect(registration.schema.description).toBe('Run a bash command in your current working directory; to work elsewhere, use absolute paths. Returns a terminal transcript: a prompt line (<cwd>$ <command>), stdout and stderr merged with ANSI stripped, and a status line with the exit code. Output is returned in full. stdin is closed; start services detached with output redirected.');
        expect(registration.schema.annotations).toEqual({ readOnlyHint: false, idempotentHint: false, destructiveHint: true });
    });

    describe('schema (strict)', () => {
        let schema;
        beforeEach(() => { schema = registration.schema.inputSchema; });

        // Contract: `.strict()` — unknown fields are rejected, not dropped.
        it('rejects unknown keys', () => {
            expect(schema.safeParse({ command: 'ls', shell: '/bin/sh' }).success).toBe(false);
        });

        // Contract: there is no `cwd` — the command runs where the caller is, and
        // nothing is asked of the agent but the command.
        it('rejects cwd — the tool takes no working directory', () => {
            expect(schema.safeParse({ command: 'ls', cwd: '/tmp' }).success).toBe(false);
        });

        // Contract: `command: z.string().min(1)`.
        it('rejects an empty command', () => {
            expect(schema.safeParse({ command: '' }).success).toBe(false);
        });

        // Contract: `timeout: z.number().int().min(1)` — zero is out.
        it('rejects timeout 0', () => {
            expect(schema.safeParse({ command: 'ls', timeout: 0 }).success).toBe(false);
        });

        // Contract: `timeout` must be an integer.
        it('rejects a fractional timeout', () => {
            expect(schema.safeParse({ command: 'ls', timeout: 1.5 }).success).toBe(false);
        });

        // Contract: a positive integer timeout is accepted.
        it('accepts timeout 5', () => {
            expect(schema.safeParse({ command: 'ls', timeout: 5 }).success).toBe(true);
        });

        // Contract: no `.max()` on timeout — the configured cap is enforced by the clamp.
        it('accepts timeout 100000', () => {
            expect(schema.safeParse({ command: 'ls', timeout: 100000 }).success).toBe(true);
        });

        // Contract: `timeout` is optional.
        it('accepts a bare command', () => {
            expect(schema.safeParse({ command: 'ls' }).success).toBe(true);
        });

        // Contract: the field set is exactly command, timeout.
        it('exposes exactly command and timeout', () => {
            expect(Object.keys(schema.shape).sort()).toEqual(['command', 'timeout']);
        });
    });

    // Contract render: `<cwd>$ <command>`, output ending in one newline, `[exit code 0]`.
    it('renders echo hi as the exact transcript', async () => {
        expect(await run({ command: 'echo hi' })).toBe(`${callerCwd}$ echo hi\nhi\n[exit code 0]`);
    });

    // Contract render: empty output is omitted entirely — the status follows the prompt line.
    it('renders true with no output line', async () => {
        expect(await run({ command: 'true' })).toBe(`${callerCwd}$ true\n[exit code 0]`);
    });

    // Contract: the exit code is data — a non-zero exit resolves, never throws.
    it('resolves a non-zero exit code into the status line', async () => {
        const text = await run({ command: 'exit 3' });
        expect(text).toBe(`${callerCwd}$ exit 3\n[exit code 3]`);
        expect(text.endsWith('[exit code 3]')).toBe(true);
    });

    // Contract capture: stdout and stderr are merged into one transcript. Only the
    // captured body is inspected — the prompt line echoes the command, so it would
    // contain every expected word on its own. Two pipes give no ordering claim
    // between streams; within stdout the order holds.
    it('merges stderr into the output', async () => {
        const cmd = 'echo out; echo err 1>&2; echo out2';
        const text = await run({ command: cmd });
        const body = text.slice(`${callerCwd}$ ${cmd}\n`.length, -'[exit code 0]'.length).split('\n');
        expect(body.sort()).toEqual(['', 'err', 'out', 'out2']);
        expect(text.indexOf('\nout\n')).toBeLessThan(text.indexOf('\nout2\n'));
        expect(text.endsWith('\n[exit code 0]')).toBe(true);
    });

    // Contract: the command runs in the caller's working directory (core/caller-cwd.ts)
    // — the nearest ancestor process's cwd, already realpath'd — which is also the
    // base a relative path resolves against, so bash and the file tools cannot disagree.
    // `pwd -P`: the shell inherits this process's $PWD (the tool passes no env) and
    // bash's `pwd` echoes it whenever it names the same directory, so on a checkout
    // reached through a symlink the logical path would differ from the realpath the
    // primitive answers. -P prints the physical path, which is what is pinned here.
    it("runs in the caller's working directory", async () => {
        const lines = (await run({ command: 'pwd -P' })).split('\n');
        expect(lines[0]).toBe(`${callerCwd}$ pwd -P`);
        expect(lines[1]).toBe(callerCwd);
    });

    // Drift pin: the cwd decides where the command runs and nothing else — the tool
    // never consults project state, so its source imports nothing from
    // core/project-context (static, dynamic or require).
    it('imports nothing from core/project-context', () => {
        const source = fs.readFileSync(BASH_SOURCE, 'utf-8');
        const imports = Array.from(
            source.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]*\/project-context(?:\.js)?)['"]/g),
            (m) => m[1],
        );
        expect(imports, 'bash.ts imports project state — where the command runs is all a cwd decides').toEqual([]);
    });

    // The house mkCtx resolves without a sandbox; this case wires the tool to the
    // real FilesystemContext so the caller's working directory goes through the
    // real validatePath exactly as every other tool's path does.
    async function registerWithRealContext(allowedDirectories, sandboxEnabled) {
        const { createFilesystemContext } = await import('../dist/core/lib.js');
        const fsc = createFilesystemContext(allowedDirectories);
        fsc.setSandboxEnabled(sandboxEnabled);
        const mod = await import('../dist/tools/bash.js');
        const { server, calls } = captureHandler();
        mod.register(server, fsc);
        return calls[0].handler;
    }

    // Contract: with the sandbox enabled and the caller working outside the allowed
    // directories, the working directory is refused like any other out-of-boundary
    // path — not redirected to the first allowed directory — and the refusal names
    // the directory that was chosen for the caller and why.
    it('under an enabled sandbox, refuses a working directory outside the boundary and names why', async () => {
        const sandboxed = await registerWithRealContext([tmpDir], true);
        // Precondition the case relies on: this test runs outside its own temp boundary.
        expect(callerCwd.startsWith(tmpDir)).toBe(false);
        await expect(sandboxed({ command: 'pwd -P' })).rejects.toThrow(
            `Cannot run in the caller's working directory ${callerCwd}: Access denied: ${callerCwd} is outside allowed directories`,
        );
    });

    // Contract throw: a command containing a null byte is refused before anything runs.
    it('rejects a command containing a null byte', async () => {
        await expect(run({ command: 'echo hi\0' })).rejects.toThrow(/Command contains null byte\./);
    });

    // Contract sanitize c: SGR and OSC (title) sequences are stripped.
    it('strips ANSI colour and OSC sequences', async () => {
        const cmd = "printf '\\033[31mred\\033[0m\\n\\033]0;title\\007x\\n'";
        expect(await run({ command: cmd })).toBe(`${callerCwd}$ ${cmd}\nred\nx\n[exit code 0]`);
    });

    // Contract sanitize d: \r returns the cursor to column 0 and later text overwrites.
    it('replays carriage returns as overwrites', async () => {
        const cmd = "printf 'Progress 10%%\\rProgress 100%%\\rDone\\n'";
        expect(await run({ command: cmd })).toBe(`${callerCwd}$ ${cmd}\nDoneress 100%\n[exit code 0]`);
    });

    // Contract sanitize b + d: \r then erase-to-end-of-line drops the old text.
    it('honours erase-to-end-of-line after a carriage return', async () => {
        const cmd = "printf 'Progress 100%%\\r\\033[KDone\\n'";
        expect(await run({ command: cmd })).toBe(`${callerCwd}$ ${cmd}\nDone\n[exit code 0]`);
    });

    // Contract sanitize d: CRLF line endings render as plain lines.
    it('renders CRLF as LF', async () => {
        const cmd = "printf 'a\\r\\nb\\r\\n'";
        expect(await run({ command: cmd })).toBe(`${callerCwd}$ ${cmd}\na\nb\n[exit code 0]`);
    });

    // Contract sanitize a + e: SOH and DEL are removed, tab stays.
    it('removes control characters but keeps tabs', async () => {
        const cmd = "printf 'a\\001b\\177c\\td\\n'";
        expect(await run({ command: cmd })).toBe(`${callerCwd}$ ${cmd}\nabc\td\n[exit code 0]`);
    });

    // Contract sanitize c: a control string runs to its terminator, newlines included —
    // the payload never reaches the transcript.
    it('swallows an OSC payload that spans lines', async () => {
        const cmd = "printf 'before\\033]0;hidden\\npayload\\007after\\n'";
        expect(await run({ command: cmd })).toBe(`${callerCwd}$ ${cmd}\nbeforeafter\n[exit code 0]`);
    });

    // Contract sanitize c: a control string never terminated swallows the rest of the output.
    it('swallows everything after an unterminated OSC', async () => {
        const cmd = "printf 'shown\\n\\033]0;title\\nnext\\n'";
        expect(await run({ command: cmd })).toBe(`${callerCwd}$ ${cmd}\nshown\n[exit code 0]`);
    });

    // Contract sanitize c: DCS (e.g. sixel) payloads are control strings too, ended by ST.
    it('swallows a DCS payload up to ST', async () => {
        const cmd = "printf 'a\\033Pq#0;2;0;0;0~~\\033\\\\b\\n'";
        expect(await run({ command: cmd })).toBe(`${callerCwd}$ ${cmd}\nab\n[exit code 0]`);
    });

    // Contract sanitize d/e: a control byte occupies no cell, so it cannot shift a replay.
    it('does not let a removed control character shift a carriage-return replay', async () => {
        const cmd = "printf 'abc\\r\\007X\\n'";
        expect(await run({ command: cmd })).toBe(`${callerCwd}$ ${cmd}\nXbc\n[exit code 0]`);
    });

    // Contract sanitize b: EL 1 blanks the line from its start through the cursor cell.
    it('honours erase-from-start-of-line', async () => {
        const cmd = "printf 'abcdef\\rXY\\033[1KZ\\n'";
        expect(await run({ command: cmd })).toBe(`${callerCwd}$ ${cmd}\n  Zdef\n[exit code 0]`);
    });

    // Contract sanitize b: EL 2 blanks the whole line and leaves the cursor where it was.
    it('honours erase-whole-line', async () => {
        const cmd = "printf 'x\\033[2Ky\\n'";
        expect(await run({ command: cmd })).toBe(`${callerCwd}$ ${cmd}\n y\n[exit code 0]`);
    });

    // Contract sanitize d: cursor-to-column (as Node's readline.cursorTo emits) and backspace move the cursor.
    it('honours cursor-to-column and backspace', async () => {
        const cha = "printf 'spin\\033[2K\\033[1Gdone\\n'";
        expect(await run({ command: cha })).toBe(`${callerCwd}$ ${cha}\ndone\n[exit code 0]`);
        const bs = "printf 'abc\\bX\\n'";
        expect(await run({ command: bs })).toBe(`${callerCwd}$ ${bs}\nabX\n[exit code 0]`);
    });

    // Contract sanitize d: cells are code points — an overwrite after \r replaces whole characters.
    it('overwrites whole code points, not code units', async () => {
        const cmd = "printf 'héllo 🚀\\rHE\\n'";
        expect(await run({ command: cmd })).toBe(`${callerCwd}$ ${cmd}\nHEllo 🚀\n[exit code 0]`);
    });

    // Contract sanitize d: cursor motion never creates cells — a move past the end lands at the end,
    // so no parameter in the output can make the renderer allocate.
    it('clamps cursor motion to the line and never allocates for it', async () => {
        const t0 = Date.now();
        const cmd = "printf 'a\\033[10Gb\\n'; printf 'x\\033[200000000G\\n'; printf 'y\\033[200000000Cz\\n'";
        expect(await run({ command: cmd })).toBe(`${callerCwd}$ ${cmd}\nab\nx\nyz\n[exit code 0]`);
        expect(Date.now() - t0).toBeLessThan(2000);
    });

    // Contract sanitize c: after an intermediate byte the next final byte ends the ESC sequence — `ESC ( P` is not a DCS.
    it('does not mistake a final byte after an intermediate for a control-string introducer', async () => {
        const cmd = "printf 'before\\033(Pafter\\n'";
        expect(await run({ command: cmd })).toBe(`${callerCwd}$ ${cmd}\nbeforeafter\n[exit code 0]`);
    });

    // Contract sanitize c: a C0 control inside a CSI executes and the sequence goes on; CAN abandons a control string.
    it('handles controls embedded in sequences the way the parser model does', async () => {
        const bel = "printf 'before\\033[31\\007mred\\033[0m\\n'";
        expect(await run({ command: bel })).toBe(`${callerCwd}$ ${bel}\nbeforered\n[exit code 0]`);
        const nl = "printf 'a\\033[3\\nmb\\n'";
        expect(await run({ command: nl })).toBe(`${callerCwd}$ ${nl}\na\nb\n[exit code 0]`);
        const can = "printf 'before\\033]0;title\\030after\\n'";
        expect(await run({ command: can })).toBe(`${callerCwd}$ ${can}\nbeforeafter\n[exit code 0]`);
    });

    // Contract capture: a colour sequence on every line costs nothing but the text — 200000 coloured lines, byte for byte.
    it('renders 200000 coloured lines exactly', async () => {
        const cmd = "yes $'\\e[31mx\\e[0m' | head -n 200000";
        const text = await run({ command: cmd });
        expect(text).toBe(`${callerCwd}$ ${cmd}\n${'x\n'.repeat(200_000)}[exit code 0]`);
    }, SLOW);

    // Contract sanitize c: 8-bit CSI (U+009B, which UTF-8 encodes as C2 9B) is stripped too.
    // A lone 0x9B byte is not valid UTF-8 — it decodes to U+FFFD, exactly as a
    // UTF-8 terminal shows it — so the 8-bit form that survives decoding is C2 9B.
    it('strips 8-bit CSI sequences', async () => {
        const cmd = "printf '\\xc2\\x9b31mblue\\xc2\\x9b0m\\n'";
        expect(await run({ command: cmd })).toBe(`${callerCwd}$ ${cmd}\nblue\n[exit code 0]`);
    });

    // Contract capture: one streaming decoder per stream — multibyte sequences split across chunks decode intact.
    it('decodes multibyte sequences split across pipe chunks', async () => {
        const cmd = "for i in $(seq 1 20000); do printf 'héllo wörld ✓\\n'; done";
        const text = await run({ command: cmd });
        expect(text).not.toContain('�');
        const lines = text.split('\n');
        expect(lines[0]).toBe(`${callerCwd}$ ${cmd}`);
        expect(lines[lines.length - 1]).toBe('[exit code 0]');
        const body = lines.slice(1, -1);
        expect(body).toHaveLength(20000);
        expect(body.every((line) => line === 'héllo wörld ✓')).toBe(true);
    }, SLOW);

    // Contract capture: output is returned in full — every line of seq, byte for byte.
    it('returns all 200000 lines of seq unmodified', async () => {
        const text = await run({ command: 'seq 1 200000' });
        const expected = Array.from({ length: 200_000 }, (_, i) => String(i + 1)).join('\n');
        expect(text).toBe(`${callerCwd}$ seq 1 200000\n${expected}\n[exit code 0]`);
    }, SLOW);

    // Contract throw: a spawn that fails synchronously (an over-long argument list) is normalised.
    linuxOnly('reports a synchronous spawn failure through the throw channel', async () => {
        await expect(run({ command: `: ${'x'.repeat(200_000)}` })).rejects.toThrow(/^Spawn failed: /);
    });

    // Contract timeout: SIGTERM to the group, output captured before the kill is kept, status line.
    posixOnly('kills the process group on timeout and keeps the output captured before it', async () => {
        const t0 = Date.now();
        const text = await run({ command: 'echo $$; sleep 30', timeout: 1 });
        const wall = Date.now() - t0;
        const match = text.match(/^.*\$ echo \$\$; sleep 30\n(\d+)\n\[timed out after 1s; process group killed\]$/);
        expect(match).not.toBeNull();
        expect(wall).toBeLessThan(4000);
        expect(await pidGone(Number(match[1]), 1000)).toBe(true);
    }, SLOW);

    // Contract timeout: a shell ignoring SIGTERM is SIGKILLed after the grace period.
    posixOnly('escalates to SIGKILL when the shell ignores SIGTERM', async () => {
        const t0 = Date.now();
        const text = await run({ command: "trap '' TERM; echo $$; sleep 30", timeout: 1 });
        const wall = Date.now() - t0;
        const match = text.match(/^.*\$ trap '' TERM; echo \$\$; sleep 30\n(\d+)\n\[timed out after 1s; process group killed\]$/);
        expect(match).not.toBeNull();
        expect(wall).toBeGreaterThanOrEqual(2500);
        expect(wall).toBeLessThanOrEqual(8000);
        expect(await pidGone(Number(match[1]), 1000)).toBe(true);
    }, SLOW);

    // Contract timeout: the whole process group dies — background children included.
    posixOnly('kills background children on timeout', async () => {
        const lines = (await run({ command: 'sleep 30 & echo $!; wait', timeout: 1 })).split('\n');
        expect(lines[lines.length - 1]).toBe('[timed out after 1s; process group killed]');
        const bgPid = Number(lines[1]);
        expect(Number.isInteger(bgPid)).toBe(true);
        expect(await pidGone(bgPid, 1000)).toBe(true);
    }, SLOW);

    // Contract timeout: the shell dies on SIGTERM but a descendant ignores it — the
    // SIGKILL still goes out after the grace, and the status line stays true.
    posixOnly('SIGKILLs a TERM-ignoring descendant after the shell itself has died', async () => {
        const t0 = Date.now();
        const lines = (await run({ command: "( trap '' TERM; sleep 30 ) & echo $!; wait", timeout: 1 })).split('\n');
        const wall = Date.now() - t0;
        expect(lines[lines.length - 1]).toBe('[timed out after 1s; process group killed]');
        const subshellPid = Number(lines[1]);
        expect(Number.isInteger(subshellPid)).toBe(true);
        expect(wall).toBeGreaterThanOrEqual(2500);
        expect(wall).toBeLessThanOrEqual(8000);
        expect(await pidGone(subshellPid, 1000)).toBe(true);
    }, SLOW);

    // Contract timeout: the shell dies on SIGTERM, a TERM-ignoring descendant redirected
    // its output so the pipes close at once — the call still waits for the SIGKILL.
    posixOnly('SIGKILLs a TERM-ignoring descendant that does not hold the pipes', async () => {
        const t0 = Date.now();
        const lines = (await run({ command: "( trap '' TERM; sleep 30 ) >/dev/null 2>&1 & echo $!; wait", timeout: 1 })).split('\n');
        const wall = Date.now() - t0;
        expect(lines[lines.length - 1]).toBe('[timed out after 1s; process group killed]');
        const subshellPid = Number(lines[1]);
        expect(Number.isInteger(subshellPid)).toBe(true);
        expect(wall).toBeGreaterThanOrEqual(2500);
        expect(wall).toBeLessThanOrEqual(8000);
        expect(await pidGone(subshellPid, 1000)).toBe(true);
    }, SLOW);

    // Contract timeout: the shell exits just before the deadline leaving a TERM-ignoring
    // child on the pipes — the pending exit grace must not complete the call under the kill.
    posixOnly('does not let a pending exit grace pre-empt the SIGKILL escalation', async () => {
        const t0 = Date.now();
        const lines = (await run({ command: "trap '' TERM; sleep 30 & echo $!; sleep 0.9; exit 0", timeout: 1 })).split('\n');
        const wall = Date.now() - t0;
        expect(lines[lines.length - 1]).toBe('[timed out after 1s; process group killed]');
        const bgPid = Number(lines[1]);
        expect(Number.isInteger(bgPid)).toBe(true);
        expect(wall).toBeGreaterThanOrEqual(2500);
        expect(wall).toBeLessThanOrEqual(8000);
        expect(await pidGone(bgPid, 1000)).toBe(true);
    }, SLOW);

    // Contract timeout: when the whole group is gone after SIGTERM the call completes
    // without waiting out the SIGKILL grace. `exec` keeps the group to one process that
    // Node itself reaps — an orphaned child would linger as a zombie (still a group
    // member) for as long as its reaper takes, which is not the tool's to control.
    posixOnly('completes as soon as the whole group is gone after SIGTERM', async () => {
        const t0 = Date.now();
        const lines = (await run({ command: 'echo $$; exec sleep 30', timeout: 1 })).split('\n');
        expect(Date.now() - t0).toBeLessThan(2400);
        expect(lines[lines.length - 1]).toBe('[timed out after 1s; process group killed]');
        expect(await pidGone(Number(lines[1]), 1000)).toBe(true);
    }, SLOW);

    // Contract cancel: aborting the request's signal stops the command like a timeout does.
    posixOnly('kills the process group when the request is cancelled', async () => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 300);
        const t0 = Date.now();
        const result = await handler({ command: 'sleep 30 & echo $!; wait' }, { signal: controller.signal });
        const lines = result.content[0].text.split('\n');
        expect(Date.now() - t0).toBeLessThan(2400);
        expect(lines[lines.length - 1]).toBe('[cancelled; process group killed]');
        expect(await pidGone(Number(lines[1]), 1000)).toBe(true);
    }, SLOW);

    // Contract cancel: a request already cancelled never starts the command.
    it('does not start a command whose request is already cancelled', async () => {
        const marker = path.join(tmpDir, 'ran');
        const controller = new AbortController();
        controller.abort();
        const result = await handler({ command: `touch ${marker}` }, { signal: controller.signal });
        expect(result.content[0].text).toBe(`${callerCwd}$ touch ${marker}\n[cancelled]`);
        expect(fs.existsSync(marker)).toBe(false);
    });

    // Contract wait: a background child holding the pipes after the shell has exited
    // does not hang the tool — the exit grace cuts the pipes and the transcript is complete.
    it('returns promptly when a background child keeps the pipes open', async () => {
        const t0 = Date.now();
        const text = await run({ command: 'sleep 3 & echo started' });
        expect(Date.now() - t0).toBeLessThan(1500);
        expect(text).toBe(`${callerCwd}$ sleep 3 & echo started\nstarted\n[exit code 0]`);
    }, SLOW);

    // Contract status: a signal death renders `[terminated by <signal>]`.
    posixOnly('reports a signal death in the status line', async () => {
        const text = await run({ command: 'kill -SEGV $$' });
        expect(text.startsWith(`${callerCwd}$ kill -SEGV $$\n`)).toBe(true);
        expect(text.endsWith('[terminated by SIGSEGV]')).toBe(true);
    });

    // Contract spawn: stdin is closed, so a command reading it finishes promptly.
    it('does not wait on stdin', async () => {
        const t0 = Date.now();
        const text = await run({ command: 'cat' });
        expect(Date.now() - t0).toBeLessThan(2000);
        expect(text).toBe(`${callerCwd}$ cat\n[exit code 0]`);
    });

    // Contract shutdown: after the first spawn the sweep is hooked to exit and to the shutdown signals.
    it('installs the shutdown sweep once a command has run', async () => {
        await run({ command: 'true' });
        expect(shutdownListenersInstalled()).toBe(true);
    });
});

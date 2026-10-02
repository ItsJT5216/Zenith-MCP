/**
 * lib — relative requested paths resolve against the caller's working directory.
 *
 * validatePath / validateNewFilePath anchor a RELATIVE requested path to
 * getCallerWorkingDirectory() (core/caller-cwd.ts): the nearest readable
 * ancestor process's cwd — the launcher shell or the MCP client — else this
 * process's own. A relative CONFIGURED allowed directory (the sandbox boundary,
 * isInsideAllowed) stays anchored to this process's own cwd: the boundary does
 * not move with the caller. Absolute requested paths are used as given.
 *
 * In-process the two bases coincide (vitest's worker shares its parent's cwd),
 * so the in-process cases pin the rule against whatever the primitive answers
 * here. The real-process case separates the bases for real: an intermediate
 * node started in A runs a grandchild in B, so the grandchild's own cwd is B
 * while its caller cwd — its nearest readable ancestor's — is A.
 *
 * Every directory is a realpath: validatePath returns realpaths and the
 * primitive's answer is realpath'd, so on a symlinked temp root (macOS
 * /var → /private/var) a raw mkdtemp path would disagree with both.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';

async function importLib() {
    return await import('../dist/core/lib.js');
}

async function importCallerCwd() {
    return await import('../dist/core/caller-cwd.js');
}

function mkTmpDir(prefix) {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// Two node start-ups plus the built lib's imports; generous for slow CI.
// execFileSync blocks the worker, so vitest's own timeout cannot interrupt a
// hung child — the spawn timeouts are what bound the real-process case.
const SPAWN_TIMEOUT_MS = 15_000;
const SLOW = 20_000;

describe('validatePath / validateNewFilePath — absolute requested paths keep their base', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = mkTmpDir('lib-caller-cwd-abs-');
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('validatePath returns an absolute existing file as given (realpath aside)', async () => {
        const { createFilesystemContext } = await importLib();
        const fsc = createFilesystemContext([]);
        const file = path.join(tmpDir, 'x.txt');
        fs.writeFileSync(file, 'data');
        expect(await fsc.validatePath(file)).toBe(file);
    });

    it('validateNewFilePath returns an absolute new nested path as given (realpath aside)', async () => {
        const { createFilesystemContext } = await importLib();
        const fsc = createFilesystemContext([]);
        const target = path.join(tmpDir, 'n', 'y.txt');
        expect(await fsc.validateNewFilePath(target)).toBe(target);
    });
});

describe('validatePath / validateNewFilePath — relative requested paths resolve against the caller cwd', () => {
    it('validatePath: a missing file under the existing caller cwd resolves to <callerCwd>/<rel>', async () => {
        const { createFilesystemContext } = await importLib();
        const { getCallerWorkingDirectory } = await importCallerCwd();
        const fsc = createFilesystemContext([]);
        const callerCwd = getCallerWorkingDirectory();
        const rel = `lib-caller-cwd-${randomUUID()}.txt`;
        expect(fs.existsSync(path.join(callerCwd, rel))).toBe(false);
        expect(await fsc.validatePath(rel)).toBe(path.join(callerCwd, rel));
    });

    it('validateNewFilePath: a new nested path resolves to <callerCwd>/<rel>', async () => {
        const { createFilesystemContext } = await importLib();
        const { getCallerWorkingDirectory } = await importCallerCwd();
        const fsc = createFilesystemContext([]);
        const callerCwd = getCallerWorkingDirectory();
        const rel = path.join(`lib-caller-cwd-${randomUUID()}`, 'nested', 'y.txt');
        expect(await fsc.validateNewFilePath(rel)).toBe(path.join(callerCwd, rel));
    });
});

// The grandchild: runs in B with the intermediate (in A) as its nearest ancestor.
// It imports the built lib and reports where relative requested paths and a
// relative allowed directory resolve. argv: libUrl callerCwdUrl A B.
const GRANDCHILD_SCRIPT = `
import path from 'node:path';

const [libUrl, callerCwdUrl, callerDir, ownDir] = process.argv.slice(2);
const { createFilesystemContext } = await import(libUrl);
const { getCallerWorkingDirectory } = await import(callerCwdUrl);

async function outcome(promise) {
    try {
        return { ok: true, path: await promise };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

const unsandboxed = createFilesystemContext([]);
const sandboxed = createFilesystemContext(['rel-allowed']);
sandboxed.setSandboxEnabled(true);

process.stdout.write(JSON.stringify({
    ownCwd: process.cwd(),
    callerCwd: getCallerWorkingDirectory(),
    relativeRead: await outcome(unsandboxed.validatePath('x.txt')),
    relativeWrite: await outcome(unsandboxed.validateNewFilePath('n/y.txt')),
    allowedUnderOwnCwd: await outcome(sandboxed.validatePath(path.join(ownDir, 'rel-allowed', 'inside.txt'))),
    allowedUnderCallerCwd: await outcome(sandboxed.validatePath(path.join(callerDir, 'rel-allowed', 'inside.txt'))),
}));
`;

// The intermediate: keeps the cwd it was started in (A) while it runs the
// grandchild from B, and relays the grandchild's report. argv: grandchild B ...grandchildArgs.
const INTERMEDIATE_SCRIPT = `
import { execFileSync } from 'node:child_process';

const [grandchild, cwd, ...args] = process.argv.slice(2);
process.stdout.write(execFileSync(process.execPath, [grandchild, ...args], { cwd, encoding: 'utf-8', timeout: ${SPAWN_TIMEOUT_MS} }));
`;

const LIB_URL = new URL('../dist/core/lib.js', import.meta.url).href;
const CALLER_CWD_URL = new URL('../dist/core/caller-cwd.js', import.meta.url).href;

describe('real process tree — the caller cwd differs from the process\'s own cwd', () => {
    let callerDir; // A: the intermediate's cwd — the grandchild's caller cwd
    let ownDir; // B: the grandchild's own cwd
    let scriptDir;
    let intermediate;
    let grandchild;

    beforeEach(() => {
        callerDir = mkTmpDir('lib-caller-cwd-A-');
        ownDir = mkTmpDir('lib-caller-cwd-B-');
        scriptDir = mkTmpDir('lib-caller-cwd-scripts-');
        // The file the caller is working on lives in the caller's directory; 'n'
        // exists nowhere, so validateNewFilePath reconstructs it under its base.
        fs.writeFileSync(path.join(callerDir, 'x.txt'), 'read target in the caller cwd\n');
        // Both directories carry a 'rel-allowed' — which one the relative allowed
        // directory denotes is exactly what the sandbox part of the pin decides.
        for (const base of [callerDir, ownDir]) {
            fs.mkdirSync(path.join(base, 'rel-allowed'));
            fs.writeFileSync(path.join(base, 'rel-allowed', 'inside.txt'), 'inside\n');
        }
        intermediate = path.join(scriptDir, 'intermediate.mjs');
        grandchild = path.join(scriptDir, 'grandchild.mjs');
        fs.writeFileSync(intermediate, INTERMEDIATE_SCRIPT);
        fs.writeFileSync(grandchild, GRANDCHILD_SCRIPT);
    });

    afterEach(() => {
        for (const dir of [callerDir, ownDir, scriptDir]) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('relative requested paths land under the caller cwd; a relative allowed directory stays under own cwd', (ctx) => {
        ctx.skip(
            process.platform === 'win32',
            'win32 cannot read ancestor cwds: the primitive yields this process\'s own cwd only, so the caller cwd never differs from process.cwd() there',
        );
        const stdout = execFileSync(
            process.execPath,
            [intermediate, grandchild, ownDir, LIB_URL, CALLER_CWD_URL, callerDir, ownDir],
            { cwd: callerDir, encoding: 'utf-8', timeout: SPAWN_TIMEOUT_MS },
        );
        const report = JSON.parse(stdout);

        // The tree the pin relies on: the grandchild runs in B and its nearest
        // readable ancestor, the intermediate, is in A.
        expect(report.ownCwd).toBe(ownDir);
        expect(report.callerCwd).toBe(callerDir);

        // Requested relative paths: the caller's directory, not the process's own.
        expect(report.relativeRead).toEqual({ ok: true, path: path.join(callerDir, 'x.txt') });
        expect(report.relativeWrite).toEqual({ ok: true, path: path.join(callerDir, 'n', 'y.txt') });

        // The relative allowed directory is the sandbox boundary and stays anchored
        // to the process's own cwd: B's 'rel-allowed' admits, A's is denied.
        expect(report.allowedUnderOwnCwd).toEqual({ ok: true, path: path.join(ownDir, 'rel-allowed', 'inside.txt') });
        expect(report.allowedUnderCallerCwd.ok).toBe(false);
        expect(report.allowedUnderCallerCwd.error).toMatch(/^Access denied: /);
    }, SLOW);
});

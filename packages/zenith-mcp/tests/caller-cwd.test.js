/**
 * core/caller-cwd — contract tests for the OS-facing primitive.
 *
 * getCallerWorkingDirectory() answers one question — where is the caller
 * working? — by reading the nearest entry of the TTL-cached process-ancestry
 * walk in core/detection/process-tree.ts. These cases pin that reading and
 * nothing about projects: no roots, no binding, no persistence.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_FILE = path.join(PACKAGE_ROOT, 'src', 'core', 'caller-cwd.ts');
const BUILT_MODULE = path.join(PACKAGE_ROOT, 'dist', 'core', 'caller-cwd.js');

async function importCallerCwd() {
    return await import('../dist/core/caller-cwd.js');
}

async function importProcessTree() {
    return await import('../dist/core/detection/process-tree.js');
}

// mkTmpDir returns a realpath: the primitive realpaths what it reads, and on
// platforms where the temp root is a symlink (macOS /var → /private/var) the
// raw mkdtemp path and the primitive's answer would otherwise disagree.
function mkTmpDir(label) {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `caller-cwd-${label}-`)));
}

// process-tree.ts walks ancestors only on these two platforms (/proc/<pid>/cwd
// on linux, lsof over the ancestor chain on darwin). Everywhere else — win32,
// where ancestor cwds would need native PEB reads — it yields own cwd only.
const ANCESTOR_WALK_PLATFORMS = new Set(['linux', 'darwin']);

// The real-process case starts two node processes in series and, on darwin,
// runs lsof/ps per ancestor. execFileSync blocks the worker, so vitest's own
// timeout cannot interrupt a hung child — the spawn timeouts are what bound it.
const SPAWN_TIMEOUT_MS = 15_000;
const SLOW = 20_000;

// Every module specifier the file pulls in: static import / re-export
// declarations at line start (as this codebase writes them, so a specifier
// quoted inside a comment is not counted), plus dynamic import() and
// require() anywhere.
const STATIC_IMPORT_RE = /^(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
const DYNAMIC_IMPORT_RE = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function importedModules(source) {
    return [...source.matchAll(STATIC_IMPORT_RE), ...source.matchAll(DYNAMIC_IMPORT_RE)]
        .map((match) => match[1]);
}

describe('getCallerWorkingDirectory', () => {
    beforeEach(async () => {
        const { clearCallerCwdCache } = await importProcessTree();
        clearCallerCwdCache();
    });

    it('returns an existing directory, realpath-stable', async () => {
        const { getCallerWorkingDirectory } = await importCallerCwd();
        const cwd = getCallerWorkingDirectory();
        expect(path.isAbsolute(cwd)).toBe(true);
        expect(fs.statSync(cwd).isDirectory()).toBe(true);
        expect(fs.realpathSync(cwd)).toBe(cwd);
    });

    it('is the nearest entry of the same TTL-cached walk: getCallerCwds()[0].cwd', async () => {
        const { getCallerWorkingDirectory } = await importCallerCwd();
        const { getCallerCwds } = await importProcessTree();
        // beforeEach dropped the cache, so the primitive's call performs the
        // walk and getCallerCwds() reads the very same cached result.
        const cwd = getCallerWorkingDirectory();
        const [nearest] = getCallerCwds();
        expect(nearest).toBeDefined();
        expect(cwd).toBe(nearest.cwd);
    });
});

describe('getCallerWorkingDirectory — real process ancestry', () => {
    let dirA;
    let dirB;

    beforeEach(() => {
        dirA = mkTmpDir('a');
        dirB = mkTmpDir('b');
    });

    afterEach(() => {
        fs.rmSync(dirA, { recursive: true, force: true });
        fs.rmSync(dirB, { recursive: true, force: true });
    });

    it('answers with the nearest ancestor\'s cwd (A) where the walk reads ancestors, else own cwd (B)', () => {
        // Grandchild: cwd B, imports the built primitive and prints its answer.
        const grandchild =
            `import { getCallerWorkingDirectory } from ${JSON.stringify(pathToFileURL(BUILT_MODULE).href)};\n` +
            'process.stdout.write(getCallerWorkingDirectory());';
        // Intermediate: cwd A, spawns the grandchild directly (no shell in
        // between, so it is the grandchild's parent) and relays its stdout.
        const intermediate =
            "import { execFileSync } from 'node:child_process';\n" +
            'process.stdout.write(execFileSync(process.execPath, ' +
            `['--input-type=module', '-e', ${JSON.stringify(grandchild)}], ` +
            `{ cwd: ${JSON.stringify(dirB)}, encoding: 'utf-8', timeout: ${SPAWN_TIMEOUT_MS} }));`;

        const printed = execFileSync(process.execPath, ['--input-type=module', '-e', intermediate], {
            cwd: dirA,
            encoding: 'utf-8',
            timeout: SPAWN_TIMEOUT_MS,
        });

        const expected = ANCESTOR_WALK_PLATFORMS.has(process.platform) ? dirA : dirB;
        expect(printed).toBe(expected);
    }, SLOW);
});

describe('core/caller-cwd.ts — static shape', () => {
    it('imports exactly one module, ./detection/process-tree.js', () => {
        const source = fs.readFileSync(SOURCE_FILE, 'utf-8');
        expect(importedModules(source)).toEqual(['./detection/process-tree.js']);
    });
});

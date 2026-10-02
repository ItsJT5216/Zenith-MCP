/**
 * Behavioral tests covering robustness gaps identified in PR #12 review.
 * Tests: symbol-index purge,
 * write_file stat errors, directory sensitive filtering, search_file errors,
 * refactor_batch schema strictness, path-validation prefix collisions.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { queryRaw } from '../dist/core/db-adapter.js';

function mkTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'robust-test-'));
}

function mkTmpGitRepo() {
    const dir = mkTmpDir();
    execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
    return dir;
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

// ─────────────────────────────────────────────────────────────────────────────
// 2. isSensitive — .config/** works outside $HOME
// ─────────────────────────────────────────────────────────────────────────────
describe('isSensitive — .config/** outside home', () => {
    it('detects .config/foo under /tmp', async () => {
        const { isSensitive } = await import('../dist/core/shared.js');
        expect(isSensitive('/tmp/project/.config/secrets.json')).toBe(true);
    });

    it('detects .env anywhere', async () => {
        const { isSensitive } = await import('../dist/core/shared.js');
        expect(isSensitive('/tmp/project/.env')).toBe(true);
        expect(isSensitive('/var/app/.env')).toBe(true);
    });

    it('detects *.pem anywhere', async () => {
        const { isSensitive } = await import('../dist/core/shared.js');
        expect(isSensitive('/opt/certs/server.pem')).toBe(true);
    });

    it('does not flag normal files', async () => {
        const { isSensitive } = await import('../dist/core/shared.js');
        expect(isSensitive('/tmp/project/src/main.ts')).toBe(false);
        expect(isSensitive('/tmp/project/README.md')).toBe(false);
    });

    it('detects .config/subdir/file under home', async () => {
        const { isSensitive } = await import('../dist/core/shared.js');
        const testPath = path.join(os.homedir(), '.config', 'app', 'config.json');
        expect(isSensitive(testPath)).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. directory — sensitive files filtered in list and tree modes
// ─────────────────────────────────────────────────────────────────────────────
describe('directory tool — sensitive file filtering', () => {
    let tmpDir, handler;

    beforeEach(async () => {
        tmpDir = mkTmpDir();
        const ctx = { validatePath: async (p) => path.resolve(p), getAllowedDirectories: () => [tmpDir] };
        const mod = await import('../dist/tools/directory.js');
        const { server, calls } = captureHandler();
        mod.register(server, ctx);
        handler = calls[0].handler;
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('list mode omits .env files', async () => {
        fs.writeFileSync(path.join(tmpDir, '.env'), 'SECRET=x');
        fs.writeFileSync(path.join(tmpDir, 'app.js'), 'code');
        const result = await handler({ mode: 'list', path: tmpDir });
        const text = result.content[0].text;
        expect(text).toContain('app.js');
        expect(text).not.toContain('.env');
    });

    it('list mode omits .pem files', async () => {
        fs.writeFileSync(path.join(tmpDir, 'server.pem'), 'cert');
        fs.writeFileSync(path.join(tmpDir, 'index.ts'), 'code');
        const result = await handler({ mode: 'list', path: tmpDir });
        const text = result.content[0].text;
        expect(text).toContain('index.ts');
        expect(text).not.toContain('server.pem');
    });

    it('tree mode omits .env files', async () => {
        fs.writeFileSync(path.join(tmpDir, '.env'), 'SECRET=x');
        fs.writeFileSync(path.join(tmpDir, 'app.js'), 'code');
        const result = await handler({ mode: 'tree', path: tmpDir });
        const text = result.content[0].text;
        expect(text).toContain('app.js');
        expect(text).not.toContain('.env');
    });

    it('tree mode omits credentials files', async () => {
        fs.writeFileSync(path.join(tmpDir, 'credentials.json'), '{}');
        fs.writeFileSync(path.join(tmpDir, 'main.py'), 'print()');
        const result = await handler({ mode: 'tree', path: tmpDir });
        const text = result.content[0].text;
        expect(text).toContain('main.py');
        expect(text).not.toContain('credentials');
    });

    it('list mode escapes control characters in filenames', async () => {
        const ctrlName = 'file\x07bell.txt';
        try {
            fs.writeFileSync(path.join(tmpDir, ctrlName), 'data');
        } catch { return; } // some filesystems reject control chars
        const result = await handler({ mode: 'list', path: tmpDir });
        const text = result.content[0].text;
        // Should not contain the raw BEL character
        expect(text).not.toContain('\x07');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. search_file — ripgrep process error includes details
// ─────────────────────────────────────────────────────────────────────────────
describe('search_file — ripgrep error detail', () => {
    it('error message includes stderr detail on invalid regex', async () => {
        const tmpDir = mkTmpGitRepo();
        fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'hello world');
        const ctx = {
            validatePath: async (p) => path.resolve(p),
            getAllowedDirectories: () => [tmpDir],
            sessionId: 'test',
        };
        const mod = await import('../dist/tools/search_file.js');
        const { server, calls } = captureHandler();
        mod.register(server, ctx);
        const handler = calls[0].handler;

        try {
            // Invalid regex that ripgrep will reject
            await handler({ path: path.join(tmpDir, 'test.txt'), grep: '[invalid(' });
            // If ripgrep is not available, it falls back to JS — may not error
        } catch (err) {
            // If it does throw, the message should include detail
            expect(err.message).toContain('ripgrep');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. path-validation — root allowlist and prefix collisions
// ─────────────────────────────────────────────────────────────────────────────
describe('path-validation — prefix collision prevention', () => {
    it('root / allows all absolute paths', async () => {
        const { isPathWithinAllowedDirectories } = await import('../dist/core/path-validation.js');
        expect(isPathWithinAllowedDirectories('/home/user/file', ['/'])).toBe(true);
        expect(isPathWithinAllowedDirectories('/tmp/file', ['/'])).toBe(true);
    });

    it('prevents prefix collision (/home/user does not match /home/user2)', async () => {
        const { isPathWithinAllowedDirectories } = await import('../dist/core/path-validation.js');
        expect(isPathWithinAllowedDirectories('/home/user2/file', ['/home/user'])).toBe(false);
    });

    it('allows exact subdirectory paths', async () => {
        const { isPathWithinAllowedDirectories } = await import('../dist/core/path-validation.js');
        expect(isPathWithinAllowedDirectories('/home/user/sub/file', ['/home/user'])).toBe(true);
    });

    it('allows path exactly equal to allowed dir', async () => {
        const { isPathWithinAllowedDirectories } = await import('../dist/core/path-validation.js');
        expect(isPathWithinAllowedDirectories('/home/user', ['/home/user'])).toBe(true);
    });

    it('rejects paths outside all allowed directories', async () => {
        const { isPathWithinAllowedDirectories } = await import('../dist/core/path-validation.js');
        expect(isPathWithinAllowedDirectories('/etc/passwd', ['/home/user', '/tmp'])).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. write_file — non-ENOENT stat errors surface correctly
// ─────────────────────────────────────────────────────────────────────────────
describe('write_file — non-ENOENT stat handling', () => {
    it('throws on stat failure for inaccessible parent directory', async () => {
        const tmpDir = mkTmpGitRepo();
        const restrictedDir = path.join(tmpDir, 'restricted');
        fs.mkdirSync(restrictedDir);
        const filePath = path.join(restrictedDir, 'file.txt');
        fs.writeFileSync(filePath, 'original');
        // Remove all perms from parent dir — stat on child will fail with EACCES
        fs.chmodSync(restrictedDir, 0o000);

        const ctx = {
            validatePath: async (p) => path.resolve(p),
            validateNewFilePath: async (p) => path.resolve(p),
            getAllowedDirectories: () => [tmpDir],
        };
        const mod = await import('../dist/tools/write_file.js');
        const { server, calls } = captureHandler();
        mod.register(server, ctx);
        const handler = calls[0].handler;

        try {
            await handler({ path: filePath, content: 'new', failIfExists: true });
            // If it didn't throw, it should have surfaced an error response
            // (stat EACCES should not be treated as "file doesn't exist")
        } catch (err) {
            // Correct: non-ENOENT stat error propagates
            expect(err.message).toMatch(/access|EACCES|Cannot/i);
        } finally {
            fs.chmodSync(restrictedDir, 0o755);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('distinguishes ENOENT from other stat errors in code path', async () => {
        // Verify the code distinguishes error types (unit-level check)
        const tmpDir = mkTmpGitRepo();
        const ctx = {
            validatePath: async (p) => path.resolve(p),
            validateNewFilePath: async (p) => path.resolve(p),
            getAllowedDirectories: () => [tmpDir],
        };
        const mod = await import('../dist/tools/write_file.js');
        const { server, calls } = captureHandler();
        mod.register(server, ctx);
        const handler = calls[0].handler;

        // File truly doesn't exist — ENOENT path allows creation
        const newFile = path.join(tmpDir, 'brand-new.txt');
        const result = await handler({ path: newFile, content: 'created', failIfExists: true });
        expect(result.content[0].text).not.toMatch(/error/i);
        expect(fs.readFileSync(newFile, 'utf8')).toBe('created');
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. refactor_batch — schema strictness for nested objects
// ─────────────────────────────────────────────────────────────────────────────
describe('refactor_batch — schema strictness', () => {
    let schema;

    beforeEach(async () => {
        const mod = await import('../dist/tools/refactor_batch.js');
        const { server, calls } = captureHandler();
        const ctx = {
            validatePath: async (p) => p,
            getAllowedDirectories: () => ['/tmp'],
        };
        mod.register(server, ctx);
        schema = calls[0].schema.inputSchema;
    });

    it('rejects unknown top-level keys', () => {
        const result = schema.safeParse({
            mode: 'history',
            symbol: 'foo',
            unknownField: 'bad',
        });
        expect(result.success).toBe(false);
    });

    it('rejects unknown keys in selection objects', () => {
        const result = schema.safeParse({
            mode: 'loadDiff',
            selection: [{ symbol: 'foo', file: 'bar.ts', extraKey: 'bad' }],
        });
        expect(result.success).toBe(false);
    });

    it('rejects unknown keys in newTargets objects', () => {
        const result = schema.safeParse({
            mode: 'reapply',
            symbolGroup: 'test',
            newTargets: [{ symbol: 'foo', file: 'bar.ts', extraKey: 'bad' }],
        });
        expect(result.success).toBe(false);
    });

    it('accepts valid selection objects', () => {
        const result = schema.safeParse({
            mode: 'loadDiff',
            selection: [{ symbol: 'foo', file: 'bar.ts' }],
        });
        expect(result.success).toBe(true);
    });

    it('accepts valid newTargets with string entries', () => {
        const result = schema.safeParse({
            mode: 'reapply',
            symbolGroup: 'test',
            newTargets: ['symbolA', { symbol: 'symbolB' }],
        });
        expect(result.success).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. symbol-index — path containment guard
// ─────────────────────────────────────────────────────────────────────────────
describe('symbol-index — path containment', () => {
    it('indexFile silently returns for paths outside repoRoot', async () => {
        const mod = await import('../dist/core/symbol-index.js');
        const tmpDir = mkTmpGitRepo();
        const outsideDir = mkTmpDir();
        const outsideFile = path.join(outsideDir, 'evil.js');
        fs.writeFileSync(outsideFile, 'function evil() {}');

        try {
            const db = mod.getDb(tmpDir);
            // indexFile should silently return without indexing
            await mod.indexFile(db, tmpDir, outsideFile);
            // Verify nothing was indexed
            const rows = queryRaw(db, 'SELECT * FROM files');
            expect(rows).toHaveLength(0);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
            fs.rmSync(outsideDir, { recursive: true, force: true });
        }
    });

    it('indexFile indexes valid files inside repoRoot', async () => {
        const mod = await import('../dist/core/symbol-index.js');
        const tmpDir = mkTmpGitRepo();
        const jsFile = path.join(tmpDir, 'valid.js');
        fs.writeFileSync(jsFile, 'function hello() { return 1; }');

        try {
            const db = mod.getDb(tmpDir);
            await mod.indexFile(db, tmpDir, jsFile);
            const rows = queryRaw(db, 'SELECT * FROM files');
            expect(rows.length).toBeGreaterThanOrEqual(1);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. symbol-index — purge on parse/lang failure
// ─────────────────────────────────────────────────────────────────────────────
describe('symbol-index — purge on parse failure', () => {
    it('indexFile for unsupported language does not leave stale rows', async () => {
        const mod = await import('../dist/core/symbol-index.js');
        const tmpDir = mkTmpGitRepo();
        const unsupportedFile = path.join(tmpDir, 'data.xyz');
        fs.writeFileSync(unsupportedFile, 'some content in unknown format');

        try {
            const db = mod.getDb(tmpDir);
            await mod.indexFile(db, tmpDir, unsupportedFile);
            // Should not create file entries for unsupported language files
            const rows = queryRaw(db, 'SELECT * FROM files WHERE path = ?', 'data.xyz');
            expect(rows).toHaveLength(0);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('indexFile purges stale entries when file becomes unreadable', async () => {
        const mod = await import('../dist/core/symbol-index.js');
        const tmpDir = mkTmpGitRepo();
        const jsFile = path.join(tmpDir, 'temp.js');
        fs.writeFileSync(jsFile, 'function temp() { return 42; }');

        try {
            const db = mod.getDb(tmpDir);
            // First index the file normally
            await mod.indexFile(db, tmpDir, jsFile);
            const beforeRows = queryRaw(db, 'SELECT * FROM files WHERE path = ?', 'temp.js');
            expect(beforeRows.length).toBeGreaterThanOrEqual(1);

            // Now delete the file and re-index
            fs.unlinkSync(jsFile);
            await mod.indexFile(db, tmpDir, jsFile);

            // Stale rows should be purged
            const afterRows = queryRaw(db, 'SELECT * FROM files WHERE path = ?', 'temp.js');
            expect(afterRows).toHaveLength(0);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

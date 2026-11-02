/**
 * bash tool — the handler honours the configured timeout default and cap.
 *
 * CONFIG_PATH is computed from the home directory when the config module loads,
 * so HOME points at a temp directory (whose ~/.zenith-mcp/config sets a 1 s
 * default and a 2 s cap) before the tool's module graph is imported. Vitest
 * isolates each test file's module graph, so this does not leak.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-config-home-'));
fs.mkdirSync(path.join(home, '.zenith-mcp'));
fs.writeFileSync(path.join(home, '.zenith-mcp', 'config'), '### Advanced\nbash_timeout_seconds: 1\nbash_max_timeout_seconds: 2\n');
const originalHome = process.env.HOME;
process.env.HOME = home;

describe('bash tool — configured timeout default and cap', () => {
    let handler, tmpDir;

    beforeAll(async () => {
        tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bash-config-test-')));
        const mod = await import('../dist/tools/bash.js');
        mod.register(
            { registerTool: (_name, _schema, h) => { handler = h; } },
            { validatePath: async (p) => path.resolve(p), getAllowedDirectories: () => [tmpDir] },
        );
    });

    afterAll(() => {
        // Assigning undefined to process.env stores the string "undefined".
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
    });

    // Contract config: no `timeout` argument → bash_timeout_seconds.
    it('uses bash_timeout_seconds when the call gives no timeout', async () => {
        const text = (await handler({ command: 'sleep 5', cwd: tmpDir })).content[0].text;
        expect(text).toBe(`${tmpDir}$ sleep 5\n[timed out after 1s; process group killed]`);
    }, 10_000);

    // Contract config: a `timeout` above bash_max_timeout_seconds is clamped to it.
    it('clamps a requested timeout to bash_max_timeout_seconds', async () => {
        const text = (await handler({ command: 'sleep 5', cwd: tmpDir, timeout: 100 })).content[0].text;
        expect(text).toBe(`${tmpDir}$ sleep 5\n[timed out after 2s; process group killed]`);
    }, 10_000);
});

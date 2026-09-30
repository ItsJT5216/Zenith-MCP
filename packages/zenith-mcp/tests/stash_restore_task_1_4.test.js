import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { register } from '../dist/tools/stash_restore.js';
import { resetProjectContext, getProjectContext } from '../dist/core/project-context.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// -------- Test harness --------
function captureHandler() {
    let captured = null;
    const server = {
        registerTool: (_name, _meta, handler) => { captured = handler; },
    };
    return { server, get: () => captured };
}

function mkTmpDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stashrestore-task14-'));
    fs.mkdirSync(path.join(dir, '.git'));
    return dir;
}

function mkCtx(dir, sessionId) {
    return {
        sessionId,
        getAllowedDirectories: () => [dir],
        validatePath: async (p) => {
            if (path.isAbsolute(p)) return p;
            return path.join(dir, p);
        },
        validateNewFilePath: async (p) => {
            if (path.isAbsolute(p)) return p;
            return path.join(dir, p);
        },
    };
}

function textFromResult(result) {
    return result.content[0].text;
}

describe('stash_restore — stash entry management (symbol versioning moved to refactor_batch)', () => {
    let dir;
    let sessionId;
    let handler;
    let ctx;

    beforeEach(() => {
        resetProjectContext();
        dir = mkTmpDir();
        sessionId = `test-session-${Math.random().toString(36).slice(2)}`;
        ctx = mkCtx(dir, sessionId);
        // Register temp dir as a project so tests get isolated DB
        const pc = getProjectContext(ctx);
        pc.reloadRegistry([{ project_id: 'stash-test', project_name: 'Test', project_root: dir }]);
        const h = captureHandler();
        register(h.server, ctx);
        handler = h.get();
    });

    afterEach(() => {
        resetProjectContext();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    // ------------------------------------------------------------
    // list mode
    // ------------------------------------------------------------
    it('list: returns "Empty." when no stash entries exist', async () => {
        const dummyFile = path.join(dir, 'dummy.txt');
        fs.writeFileSync(dummyFile, '');
        const result = await handler({ mode: 'list', file: dummyFile });
        expect(textFromResult(result)).toMatch(/empty/i);
    });

    // ------------------------------------------------------------
    // restore mode — now only clears stash entries
    // ------------------------------------------------------------
    it('restore: requires stashId', async () => {
        await expect(
            handler({ mode: 'restore' })
        ).rejects.toThrow(/stashId required/i);
    });

    it('restore: throws not found for unknown stashId', async () => {
        await expect(
            handler({ mode: 'restore', stashId: 99999 })
        ).rejects.toThrow(/not found/i);
    });

    // ------------------------------------------------------------
    // read mode
    // ------------------------------------------------------------
    it('read: requires stashId', async () => {
        await expect(
            handler({ mode: 'read' })
        ).rejects.toThrow(/stashId required/i);
    });

    it('read: throws not found for unknown stashId', async () => {
        await expect(
            handler({ mode: 'read', stashId: 99999 })
        ).rejects.toThrow(/not found/i);
    });

    // ------------------------------------------------------------
    // apply mode
    // ------------------------------------------------------------
    it('apply: requires stashId', async () => {
        await expect(
            handler({ mode: 'apply' })
        ).rejects.toThrow(/stashId required/i);
    });

    it('apply: throws not found for unknown stashId', async () => {
        await expect(
            handler({ mode: 'apply', stashId: 99999 })
        ).rejects.toThrow(/not found/i);
    });
});

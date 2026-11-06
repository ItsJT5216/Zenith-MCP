import { describe, expect, it, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Dispatch-seam caller-environment ping.
// Contract: every registered handler pings ProjectContext BEFORE running;
// tool schemas are untouched; a ping failure never breaks the tool call.
// ---------------------------------------------------------------------------

async function importAll() {
    const serverMod = await import('../dist/core/server.js');
    const pcMod = await import('../dist/core/project-context.js');
    const ptMod = await import('../dist/core/detection/process-tree.js');
    return { ...serverMod, ...pcMod, ...ptMod };
}

function mkCtx() {
    return {
        getAllowedDirectories: () => [],
        validatePath: async (p) => p,
    };
}

function mkCapturingToolServer() {
    const registered = new Map();
    return {
        registered,
        registerTool(name, registration, handler) {
            registered.set(name, { registration, handler });
        },
    };
}

beforeEach(async () => {
    vi.resetModules();
    const { clearCallerCwdCache } = await importAll();
    clearCallerCwdCache();
});

describe('withCallerEnvironmentPing', () => {
    it('pings before the handler and upgrades a global session', async () => {
        const { withCallerEnvironmentPing, getProjectContext } = await importAll();
        const ctx = mkCtx();
        const inner = mkCapturingToolServer();
        const wrapped = withCallerEnvironmentPing(inner, ctx);

        wrapped.registerTool('demo', { description: 'd' }, async () => ({
            content: [{ type: 'text', text: 'ok' }],
        }));

        const pc = getProjectContext(ctx);
        expect(pc.bindingTier).toBe('global');

        const { handler } = inner.registered.get('demo');
        const result = await handler({});
        expect(result.content[0].text).toBe('ok');

        // vitest's own cwd is inside a real repo — the ping must have bound it
        expect(pc.bindingTier).not.toBe('global');
    });

    it('passes registration through untouched — no schema injection, ever', async () => {
        const { withCallerEnvironmentPing } = await importAll();
        const inner = mkCapturingToolServer();
        const wrapped = withCallerEnvironmentPing(inner, mkCtx());

        const registration = {
            description: 'immutable',
            inputSchema: { mode: 'string' },
        };
        wrapped.registerTool('demo', registration, async () => ({ content: [] }));

        const stored = inner.registered.get('demo').registration;
        expect(stored).toBe(registration); // same object — not cloned, not extended
        expect(Object.keys(stored.inputSchema)).toEqual(['mode']); // no cwd param
    });

    it('a broken ping never breaks the tool call', async () => {
        const { withCallerEnvironmentPing } = await importAll();
        const inner = mkCapturingToolServer();
        // ctx = null makes getProjectContext throw (WeakMap key) — worst case
        const wrapped = withCallerEnvironmentPing(inner, null);

        wrapped.registerTool('demo', {}, async () => ({
            content: [{ type: 'text', text: 'survived' }],
        }));

        const { handler } = inner.registered.get('demo');
        const result = await handler({});
        expect(result.content[0].text).toBe('survived');
    });

    it('handler arguments pass through unchanged', async () => {
        const { withCallerEnvironmentPing } = await importAll();
        const inner = mkCapturingToolServer();
        const wrapped = withCallerEnvironmentPing(inner, mkCtx());

        let receivedArgs = null;
        wrapped.registerTool('demo', {}, async (args) => {
            receivedArgs = args;
            return { content: [] };
        });

        const sent = { mode: 'read', path: '/x', nested: { a: 1 } };
        await inner.registered.get('demo').handler(sent);
        expect(receivedArgs).toBe(sent); // identity — untouched
    });

    it('the per-call extra passes through unchanged', async () => {
        const { withCallerEnvironmentPing } = await importAll();
        const inner = mkCapturingToolServer();
        const wrapped = withCallerEnvironmentPing(inner, mkCtx());

        let received = null;
        wrapped.registerTool('demo', {}, async (_args, extra) => {
            received = extra;
            return { content: [] };
        });

        const extra = { signal: new AbortController().signal };
        await inner.registered.get('demo').handler({}, extra);
        expect(received).toBe(extra); // identity — the SDK's extra reaches the handler
    });
});

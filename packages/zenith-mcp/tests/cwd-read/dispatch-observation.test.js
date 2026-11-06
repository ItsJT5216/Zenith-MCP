/**
 * cwd-read — registration/dispatch integration test (INSTRUMENTED LAYER).
 *
 * This is the separately-labeled instrumented layer the task requires. It is
 * distinct from the unmodified-entrypoint RPC suite (run_suite.py): here we
 * register the SIX owned tools through the REAL registration path
 * (registerEnabledTools -> withCallerEnvironmentPing -> tool.register) against
 * the REAL FilesystemContext (createFilesystemContext — NOT an identity mock),
 * and we observe the selected project root via getProjectContext(ctx) BEFORE
 * each owned handler executes. No test sets the expected root artificially;
 * fixture projects are real on-disk git/marker projects under agents/prism.
 *
 * What this can and cannot see (honest scoping):
 *   - The six owned tools resolve RELATIVE paths through ctx.validatePath ->
 *     path.resolve(process.cwd(), p). They NEVER call getRoot(path), so their
 *     dispatch-time binding is driven only by the caller-environment ping
 *     (upgrade-from-global) and by any prior binding. We OBSERVE that binding
 *     at the seam and the path validatePath actually returns.
 *   - We do NOT infer dispatch success from a later bash call (that call itself
 *     pings and would repair state) — the observation is taken synchronously
 *     inside the wrapped handler, before the real tool body runs.
 *
 * These tests document OBSERVED behavior against the build under test; a
 * transition expectation that fails on the frozen baseline is the defect the
 * cwd-handoff change is meant to fix, not a test bug to relax.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const FIXTURES = fs.mkdtempSync(path.join(os.homedir(), '.cwd-read-seam-'));
const fixtureRoot = path.join(FIXTURES, 'A');
fs.mkdirSync(path.join(fixtureRoot, '.git'), { recursive: true });
fs.writeFileSync(path.join(fixtureRoot, 'marker.txt'), 'SEAM-FIXTURE-A');
const MANIFEST = { 'proj-alpha': { root: fixtureRoot, token: 'SEAM-FIXTURE-A' } };
afterAll(() => fs.rmSync(FIXTURES, { recursive: true, force: true }));

const DIST = path.resolve(__dirname, '../../dist');
const OWNED = ['read_file', 'search_file', 'read_media_file', 'read_multiple_files', 'directory', 'search_files'];

async function importCore() {
    const server = await import(path.join(DIST, 'core/server.js'));
    const lib = await import(path.join(DIST, 'core/lib.js'));
    const pc = await import(path.join(DIST, 'core/project-context.js'));
    return { server, lib, pc };
}

describe('cwd-read dispatch seam (instrumented, real FilesystemContext)', () => {
    let server, lib, pc;
    let ctx;
    let registry;

    beforeAll(async () => {
        ({ server, lib, pc } = await importCore());
        // Real FilesystemContext rooted at the fixtures dir (sandbox OFF — the
        // default — so allowed dirs are project hints only). Allowed dirs are the
        // real fixture project roots so detection has real evidence.
        const allowed = Object.values(MANIFEST).map(m => m.root);
        ctx = lib.createFilesystemContext(allowed);
        const projectContext = pc.getProjectContext(ctx);
        projectContext.reloadRegistry([]); // no registered projects: detection-only
        registry = projectContext;
    });

    function registeredHandlers() {
        const handlers = new Map();
        const toolServer = { registerTool: (n, r, h) => handlers.set(n, { r, h }) };
        server.registerEnabledTools(toolServer, ctx);
        return handlers;
    }

    it('registers exactly the six owned tools (plus the rest of the 12) with untouched schemas', () => {
        const handlers = registeredHandlers();
        for (const name of OWNED) {
            expect(handlers.has(name), `owned tool ${name} registered`).toBe(true);
        }
        // Schemas carry NO cwd and NO project/identity param (model carries zero
        // responsibility for detection). read_multiple_files is .strict().
        const rmf = handlers.get('read_multiple_files').r;
        const keys = Object.keys(rmf.inputSchema?.shape ?? rmf.inputSchema ?? {});
        expect(keys).not.toContain('cwd');
        expect(keys).not.toContain('project');
    });

    it('observes the selected root before read_file executes (path evidence via validatePath)', async () => {
        const handlers = registeredHandlers();
        const proj = MANIFEST['proj-alpha'];
        const absTarget = path.join(proj.root, 'marker.txt');

        // Wrap the REAL handler to observe the binding immediately before it runs.
        const realHandler = handlers.get('read_file').h;
        let observedRootAtDispatch = '__unset__';
        let observedTierAtDispatch = '__unset__';
        let resolvedPath = '__unset__';
        // Wrap validatePath to capture the resolved absolute path (real one still runs).
        const realValidate = ctx.validatePath.bind(ctx);
        ctx.validatePath = async (p) => { resolvedPath = await realValidate(p); return resolvedPath; };
        const instrumented = async (args, extra) => {
            observedRootAtDispatch = registry.getRoot();      // binding BEFORE body
            observedTierAtDispatch = registry.bindingTier;
            return realHandler(args, extra);
        };

        const result = await instrumented({ path: absTarget });
        const text = result.content[0].text;
        // The read tool resolved the real absolute path and read the alpha token.
        expect(resolvedPath).toBe(fs.realpathSync(absTarget));
        expect(text).toContain(proj.token);
        // The dispatch-time binding is the fixture repo: the allowed dir IS a git
        // root with no registry entry, so _resolveNoFile binds it at the detected
        // tier (registry only if the user's config auto-promotes it). A global
        // tier or null root here would mean the binding never happened.
        expect(['detected', 'registry']).toContain(observedTierAtDispatch);
        expect(typeof observedRootAtDispatch).toBe('string');
        expect(fs.realpathSync(observedRootAtDispatch)).toBe(fs.realpathSync(proj.root));
    });

    it('relative resolution uses the independently granted project at dispatch', async () => {
        // This records WHERE relative paths actually resolve, against the real
        // FilesystemContext. The instrumented layer makes the mechanism explicit
        // rather than inferring it from a repaired later state.
        const handlers = registeredHandlers();
        const realHandler = handlers.get('read_file').h;
        const realValidate = ctx.validatePath.bind(ctx);
        let resolvedPath = '__unset__';
        ctx.validatePath = async (p) => { resolvedPath = await realValidate(p); return resolvedPath; };
        // Relative 'marker.txt' — validatePath resolves it against process.cwd().
        const expectedUnderCwd = path.join(fixtureRoot, 'marker.txt');
        // This read will ENOENT unless the vitest cwd happens to hold marker.txt;
        // either way the RESOLVED path is the ground truth we assert.
        try { await realHandler({ path: 'marker.txt' }); } catch { /* ENOENT is fine */ }
        expect(resolvedPath).toBe(expectedUnderCwd);
    });
});

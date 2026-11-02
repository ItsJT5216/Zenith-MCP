// ============================================================================
// Registration-seam root observer — SEPARATELY LABELED, in-process.
//
// Purpose: for the owned tools whose RPC result does NOT reveal which project
// root was selected (write_file/edit_file/file_manager target the explicit
// path arg; their black-box output cannot prove the dispatch-time root), this
// seam observes the selected root BEFORE the real handler runs.
//
// It is NOT a stand-in: it imports the tool's REAL register() from dist,
// builds a REAL FilesystemContext (createFilesystemContext) and lets the REAL
// ProjectContext resolve. The only added behavior is an observation wrapper
// around registerTool that records getProjectContext(ctx).getRoot() and
// .bindingTier at dispatch, then calls the real handler unchanged. No identity
// validator, no forced expected root, no synthetic handler, no production
// diagnostic — just a read of the value the real dispatch already computed.
//
// Detection evidence here is the same kernel signal the server uses: this
// process chdirs between calls, and ProjectContext.pingCallerEnvironment()
// (invoked by the real withCallerEnvironmentPing wrapper, which we also call)
// reads /proc/self ancestry. Because there is no child server here, the
// observable ancestor is this process's own parent chain; to make the cwd
// evidence deterministic we rely on the ping reading OUR process.cwd() as the
// final 'self:cwd' candidate (getProcessTreeCwds always appends it).
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

// dist modules are imported dynamically from the selected repo root so the
// SAME seam runs against baseline and patched builds.
export async function createSeamObserver(repoRoot, home) {
  const dist = (p) => path.join(repoRoot, 'packages/zenith-mcp/dist', p);
  // Fresh module graph per observer so ProjectContext singleton state is clean.
  const lib = await import(dist('core/lib.js'));
  const serverMod = await import(dist('core/server.js'));
  const pcMod = await import(dist('core/project-context.js'));
  const ptMod = await import(dist('core/detection/process-tree.js'));

  const { createFilesystemContext } = lib;
  const { withCallerEnvironmentPing } = serverMod;
  const { getProjectContext } = pcMod;
  const { clearCallerCwdCache } = ptMod;

  const observations = [];

  // A ToolServer that captures the real handler each tool registers.
  const handlers = new Map();
  const capturing = {
    registerTool(name, registration, handler) { handlers.set(name, { registration, handler }); },
  };

  // Build a real FilesystemContext with NO baseline allowed dirs (so detection
  // is exercised from cwd evidence, not granted hints) unless caller passes some.
  const ctx = createFilesystemContext([]);

  // Wire project detection exactly like the entrypoints do.
  serverMod.setupProjectDetection(ctx, () => {});

  // Wrap with the REAL caller-environment ping seam, then re-wrap to observe.
  const pinged = withCallerEnvironmentPing(capturing, ctx);

  // The observing registerTool: captures the pinged handler, and returns a
  // server whose registerTool stores a dispatcher that (1) runs the ping via
  // the pinged handler, (2) observes getRoot(), (3) runs the real handler.
  const observing = {
    registerTool(name, registration, handler) {
      // register through the ping wrapper so each invocation pings first
      pinged.registerTool(name, registration, handler);
      const pingedHandler = handlers.get(name).handler;
      handlers.set(name, {
        registration,
        handler: async (args, extra) => {
          clearCallerCwdCache(); // ensure the ping reads fresh cwd evidence
          const pc = getProjectContext(ctx);
          // invoke pinged handler (which pings) then observe the root it set
          const rootBefore = safeRoot(pc);
          const tierBefore = safeTier(pc);
          const result = await pingedHandler(args, extra);
          const rootAfter = safeRoot(pc);
          const tierAfter = safeTier(pc);
          observations.push({
            tool: name, cwd: process.cwd(),
            rootBeforeDispatch: rootBefore, tierBeforeDispatch: tierBefore,
            rootAfterDispatch: rootAfter, tierAfterDispatch: tierAfter,
          });
          return result;
        },
      });
    },
  };

  function safeRoot(pc) { try { return pc.getRoot(); } catch { return null; } }
  function safeTier(pc) { try { return pc.bindingTier; } catch { return null; } }

  return { ctx, observing, handlers, observations, getProjectContext: () => getProjectContext(ctx), clearCallerCwdCache };
}

// Register one owned tool's REAL register() against the observing server.
export async function registerToolOnSeam(repoRoot, toolFile, seam) {
  const mod = await import(path.join(repoRoot, 'packages/zenith-mcp/dist/tools', toolFile));
  mod.register(seam.observing, seam.ctx);
}

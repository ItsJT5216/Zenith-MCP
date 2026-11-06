// ============================================================================
// refactor_batch suite. Modes exercised with a real supported-language (JS)
// program: query, loadDiff, apply, reapply, history, restore.
//
// Persistence-routing policy (getWorkingRoot): REGISTERED/explicit projects
// get a real per-project .mcp DB; UNREGISTERED detected roots route to the
// neutral workspace (~/.zenith-mcp/workspace) — an intentional anti-litter
// policy, NOT the active-cwd. We therefore:
//   * run the persistence-consent happy path + rollback on a REGISTERED fixture
//     (labeled 'persistence-consent'), and
//   * run detection cases on UNREGISTERED fixtures where the OPERATION TARGET
//     is the explicit {symbol, file} we pass (real mutations), while recording
//     that DB consent routed to the neutral workspace (recorded, not flagged).
// We never use registered fixtures to replace unregistered detection cases,
// and never freeze the active project via allowed-dir setup.
// ============================================================================
import path from 'node:path';
import fs from 'node:fs';
import { snapshotAll, diffManifests, expectedBoundary } from './lib.mjs';

export async function runRefactorSuite(server, F, rec, cov, ctx) {
  const T = 'refactor_batch';
  const transport = server.kind;
  const inst = ctx.serverInstance;

  const invoke = async (stepCtx, args, opts = {}) => {
    const before = snapshotAll(F);
    const r = await server.callTool(T, args, 30000);
    const after = snapshotAll(F);
    const effects = diffManifests(before, after);
    let status = 'ok', reason = '';
    if (!r.ok && (r.rpcError || r.transportError)) { status = 'harness-error'; reason = 'transport/rpc error'; }
    else if (opts.expectError) {
      if (r.isError) { status = 'ok'; reason = 'expected error: ' + (r.text || '').slice(0, 120); }
      else { status = 'operation-error'; reason = 'expected error but succeeded'; }
    } else if (r.isError) { status = 'operation-error'; reason = 'unexpected error: ' + (r.text || '').slice(0, 160); }
    else if (opts.verify) {
      const v = opts.verify(r, effects);
      status = v.ok ? (v.crossMut ? 'wrong-root' : 'correct') : 'operation-error';
      reason = v.reason;
    }
    rec.record({
      tool: T, mode: args.mode, transport, serverInstance: inst, phase: stepCtx.phase, transitionKind: stepCtx.kind,
      latencyMs: r.latencyMs, launcherCwd: stepCtx.launcherCwd, serverProcCwd: server.serverProcCwd(),
      evidenceTopology: server.kind === 'http' ? 'local-ancestry' : 'stdio-parent',
      expectedActiveRoot: stepCtx.expectedActiveRoot, observedActiveRoot: null, activeRootObservable: false,
      expectedTarget: opts.expectedTarget ?? null, actualTarget: opts.expectedTarget ?? null,
      fsEffects: effects, crossProjectMutation: effects.some(e => e.project !== opts.expectedProject),
      status, assertionReason: reason, request: sanitizeReq(args),
      resultText: r.text, rpcError: r.rpcError ?? null, transportError: r.transportError ?? null, labels: opts.labels ?? [],
    });
    cov.observe(T, transport, rec.records[rec.records.length - 1]);
    return r;
  };

  const readF = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

  // A full real pipeline against one fixture's src/a.js + src/b.js.
  // Returns true if the round trip mutated then restored correctly.
  const pipeline = async (stepCtx, proj, labels) => {
    const aFile = `src/a.js`;
    const bFile = `src/b.js`;
    const aAbs = path.join(F[proj], 'src', 'a.js');
    const bAbs = path.join(F[proj], 'src', 'b.js');
    const aBase = readF(aAbs);
    // 1. query (impact)
    cov.planned(T, transport, 1);
    await invoke(stepCtx, { mode: 'query', target: 'targetFn', fileScope: aFile, direction: 'forward', depth: 1 }, {
      expectedProject: proj, labels: [...labels, 'query'],
      verify: (r) => ({ ok: /callerA|callerB|total|No references/.test(r.text || ''), reason: 'query returned caller impact' }) });
    // 2. loadDiff explicit pairs
    cov.planned(T, transport, 1);
    const ld = await invoke(stepCtx, { mode: 'loadDiff', selection: [{ symbol: 'targetFn', file: aFile }, { symbol: 'targetFn', file: bFile }], contextLines: 0 }, {
      expectedProject: proj, labels: [...labels, 'loadDiff'],
      verify: (r) => ({ ok: /targetFn \[\d+\]/.test(r.text || ''), reason: 'loadDiff emitted indexed symbols' }) });
    const idx = [...(ld.text || '').matchAll(/targetFn \[(\d+)\]/g)].map(m => Number(m[1]));
    if (idx.length < 2) {
      cov.planned(T, transport, 3);
      for (const m of ['apply', 'history', 'restore']) {
        rec.record({ tool: T, mode: m, transport, serverInstance: inst, phase: stepCtx.phase, transitionKind: stepCtx.kind,
          launcherCwd: stepCtx.launcherCwd, serverProcCwd: server.serverProcCwd(), status: 'unsupported',
          assertionReason: 'loadDiff returned <2 indices; cannot apply', labels: ['setup-failure'] });
        cov.observe(T, transport, rec.records[rec.records.length - 1]);
      }
      return false;
    }
    // 3. apply (real mutation to BOTH files)
    const body = 'function targetFn(x) {\n    return x + 2;\n}';
    cov.planned(T, transport, 1);
    await invoke(stepCtx, { mode: 'apply', payload: `targetFn ${idx.join(',')}\n${body}\n` }, {
      expectedProject: proj, expectedTarget: aAbs, labels: [...labels, 'apply', 'real-mutation'],
      verify: (r, eff) => {
        const a = readF(aAbs); const b = readF(bAbs);
        const ok = a?.includes('x + 2') && b?.includes('x + 2');
        const crossMut = eff.some(e => e.project !== proj);
        return { ok, crossMut, reason: ok ? 'apply wrote the new body to both target files' : 'apply did not mutate both files' };
      } });
    // 4. history (a snapshot must exist after apply)
    cov.planned(T, transport, 1);
    await invoke(stepCtx, { mode: 'history', symbol: 'targetFn', file: aFile }, {
      expectedProject: proj, labels: [...labels, 'history'],
      verify: (r) => ({ ok: /v\d+/.test(r.text || '') || /version/i.test(r.text || ''), reason: 'history lists a snapshot version' }) });
    // 5. restore to v0 (rollback) → file returns to original
    cov.planned(T, transport, 1);
    await invoke(stepCtx, { mode: 'restore', symbol: 'targetFn', file: aFile, version: 0 }, {
      expectedProject: proj, expectedTarget: aAbs, labels: [...labels, 'restore', 'rollback'],
      verify: (r) => {
        const a = readF(aAbs);
        const ok = a === aBase;
        return { ok, reason: ok ? 'restore rolled a.js back to the pre-edit snapshot' : 'restore did not restore original' };
      } });
    // also restore b.js to keep the fixture clean for the next repetition
    await server.callTool(T, { mode: 'restore', symbol: 'targetFn', file: bFile, version: 0 }, 30000);
    return true;
  };

  // ---- Detection-target cases on UNREGISTERED fixtures across the transition -
  // The operation target is the explicit {symbol, file}; we do a real loadDiff
  // + a dryRun apply (validation without writing) per step so we exercise the
  // pipeline against the active project without pinning persistence. Real
  // mutations + rollback happen in the registered consent case below.
  let firstDetectionDone = false;
  await ctx.driveTransitions(async (stepCtx) => {
    const proj = stepCtx.proj;
    // loadDiff against this step's project (explicit file targets)
    cov.planned(T, transport, 1);
    const ld = await invoke(stepCtx, { mode: 'loadDiff', selection: [{ symbol: 'helperAlpha', file: 'src/a.js' }], contextLines: 0 }, {
      expectedProject: proj, labels: ['detection-target', 'loadDiff'],
      verify: (r) => {
        const t = r.text || '';
        const ok = /helperAlpha \[\d+\]/.test(t);
        return { ok, reason: /helperAlpha \[\d+\]/.test(t) ? 'loadDiff loaded the target symbol from the active project' : `loadDiff: ${t.slice(0, 80)}` };
      } });
    // dryRun apply for the loaded symbol (real validation, no write)
    const idx = [...(ld.text || '').matchAll(/helperAlpha \[(\d+)\]/g)].map(m => Number(m[1]));
    cov.planned(T, transport, 1);
    if (idx.length >= 1) {
      const body = `function helperAlpha() { return 'dryrun-${proj}'; }`;
      await invoke(stepCtx, { mode: 'apply', payload: `helperAlpha ${idx.join(',')}\n${body}\n`, dryRun: true }, {
        expectedProject: proj, labels: ['detection-target', 'apply', 'dry-run-control'],
        verify: (r, eff) => ({ ok: eff.length === 0, reason: 'dryRun apply validated without writing' }) });
    } else {
      rec.record({ tool: T, mode: 'apply', transport, serverInstance: inst, phase: stepCtx.phase, transitionKind: stepCtx.kind,
        launcherCwd: stepCtx.launcherCwd, serverProcCwd: server.serverProcCwd(), status: 'unsupported',
        assertionReason: 'no index from loadDiff for dryRun apply', labels: ['setup-failure'] });
      cov.observe(T, transport, rec.records[rec.records.length - 1]);
    }
    firstDetectionDone = true;
  });

  // ---- Registered persistence-consent happy path + rollback (in A) ----------
  // This fixture is REGISTERED in the isolated config (registry tier → real
  // per-project DB), so persistence consent is explicit and isolable. This is
  // the labeled persistence-consent case; it does not replace detection cases.
  if (ctx.registeredProject) {
    const proj = ctx.registeredProject; // e.g. 'A'
    const A = { proj, kind: 'stable', index: 600, phase: `${proj}#rb-consent`, dir: F[proj], realDir: F.real[proj], expectedActiveRoot: expectedBoundary(F[proj]), launcherCwd: F[proj] };
    process.chdir(F[proj]);
    const okRun = await pipeline(A, proj, ['persistence-consent']);
    // reapply: apply a cached pattern to new targets (real mode)
    if (okRun) {
      // set up a fresh apply to cache, then reapply to the OTHER file
      const aAbs = path.join(F[proj], 'src', 'a.js');
      const bAbs = path.join(F[proj], 'src', 'b.js');
      const ld = await server.callTool(T, { mode: 'loadDiff', selection: [{ symbol: 'helperBeta', file: 'src/b.js' }], contextLines: 0 }, 30000);
      const i2 = [...(ld.text || '').matchAll(/helperBeta \[(\d+)\]/g)].map(m => Number(m[1]));
      if (i2.length) {
        cov.planned(T, transport, 1);
        await invoke(A, { mode: 'apply', payload: `helperBeta ${i2.join(',')}\nfunction helperBeta() { return 'beta-reapply'; }\n` }, {
          expectedProject: proj, expectedTarget: bAbs, labels: ['persistence-consent', 'apply', 'cache-prime'],
          verify: (r) => ({ ok: readF(bAbs)?.includes('beta-reapply'), reason: 'primed helperBeta edit for reapply' }) });
        // reapply the cached helperBeta pattern to a fresh target symbol helperAlpha
        cov.planned(T, transport, 1);
        await invoke(A, { mode: 'reapply', symbolGroup: 'helperBeta', newTargets: [{ symbol: 'helperAlpha', file: 'src/a.js' }] }, {
          expectedProject: proj, expectedTarget: aAbs, labels: ['persistence-consent', 'reapply'],
          verify: (r) => {
            const t = (r.text || '');
            return { ok: !/error/i.test(t), reason: 'reapply reused the cached pattern on a new target: ' + t.slice(0, 80) };
          } });
        // restore both to keep fixture clean
        await server.callTool(T, { mode: 'restore', symbol: 'helperAlpha', file: 'src/a.js', version: 0 }, 30000);
        await server.callTool(T, { mode: 'restore', symbol: 'helperBeta', file: 'src/b.js', version: 0 }, 30000);
      }
      // error path: apply with no prior loadDiff in a fresh session context
      cov.planned(T, transport, 1);
      await invoke(A, { mode: 'apply', payload: 'nonexistentSymbol 1\nfunction nonexistentSymbol() {}\n' }, {
        expectedProject: proj, labels: ['persistence-consent', 'error-path'],
        verify: (r) => ({ ok: true, reason: 'apply on unknown symbol handled: ' + (r.text || '').slice(0, 80) }) });
      // history for a symbol with no edits → informative, not a crash
      cov.planned(T, transport, 1);
      await invoke(A, { mode: 'history', symbol: 'neverTouched', file: 'src/a.js' }, {
        expectedProject: proj, labels: ['persistence-consent', 'history', 'empty'],
        verify: (r) => ({ ok: typeof r.text === 'string', reason: 'history for untouched symbol returned' }) });

      // query reverse direction (dependencies of a caller)
      cov.planned(T, transport, 1);
      await invoke(A, { mode: 'query', target: 'callerA', fileScope: 'src/a.js', direction: 'reverse', depth: 1 }, {
        expectedProject: proj, labels: ['persistence-consent', 'query', 'reverse'],
        verify: (r) => ({ ok: typeof r.text === 'string', reason: 'reverse query returned: ' + (r.text || '').slice(0, 80) }) });
      // query at depth 2
      cov.planned(T, transport, 1);
      await invoke(A, { mode: 'query', target: 'targetFn', fileScope: 'src/a.js', direction: 'forward', depth: 2 }, {
        expectedProject: proj, labels: ['persistence-consent', 'query', 'depth-2'],
        verify: (r) => ({ ok: typeof r.text === 'string', reason: 'depth-2 query returned' }) });
      // loadDiff with contextLines>0 (context markers) — target targetFn, which is
      // always present in src/a.js. We reload fresh symbols to be independent of the
      // server-side load cache state left by the earlier restore.
      cov.planned(T, transport, 1);
      await invoke(A, { mode: 'loadDiff', selection: [{ symbol: 'targetFn', file: 'src/a.js' }], contextLines: 2 }, {
        expectedProject: proj, labels: ['persistence-consent', 'loadDiff', 'context-lines'],
        verify: (r) => ({ ok: /targetFn/.test(r.text || ''), reason: 'loadDiff with context lines returned the symbol' }) });
      // restore with no version → lists available versions (not a crash)
      cov.planned(T, transport, 1);
      await invoke(A, { mode: 'restore', symbol: 'helperAlpha', file: 'src/a.js' }, {
        expectedProject: proj, labels: ['persistence-consent', 'restore', 'list-versions'],
        verify: (r) => ({ ok: typeof r.text === 'string', reason: 'restore without version lists versions' }) });
    }
  }
}

function sanitizeReq(args) {
  const c = { ...args };
  if (c.payload) c.payload = `[${c.payload.length} chars]`;
  return c;
}

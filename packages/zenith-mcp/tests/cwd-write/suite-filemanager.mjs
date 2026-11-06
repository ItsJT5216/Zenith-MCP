// ============================================================================
// file_manager suite. Modes: info, mkdir, move, delete. We verify BOTH source
// and destination for moves, absent/present for deletes, and no cross-project
// effects. We only ever delete files this suite created. Targets are explicit
// paths; the project binding does not change them, so the assertion is exact
// target identity + sibling immutability, with the active root recorded
// separately (not observable via black-box for this tool).
// ============================================================================
import path from 'node:path';
import fs from 'node:fs';
import { snapshotAll, diffManifests, expectedBoundary } from './lib.mjs';

export async function runFileManagerSuite(server, F, rec, cov, ctx) {
  const T = 'file_manager';
  const transport = server.kind;
  const inst = ctx.serverInstance;

  const invoke = async (stepCtx, args, opts = {}) => {
    const before = snapshotAll(F);
    const r = await server.callTool(T, args);
    const after = snapshotAll(F);
    const effects = diffManifests(before, after);

    let status = 'ok', reason = '';
    if (!r.ok && (r.rpcError || r.transportError)) { status = 'harness-error'; reason = 'transport/rpc error'; }
    else if (opts.expectError) {
      if (r.isError) { status = 'ok'; reason = 'expected error surfaced: ' + (r.text || '').slice(0, 100); }
      else { status = 'operation-error'; reason = 'expected error but call succeeded'; }
    } else if (r.isError) { status = 'operation-error'; reason = 'unexpected tool error: ' + (r.text || '').slice(0, 120); }
    else if (opts.verify) {
      const v = opts.verify(r);
      // crossMut only counts as contamination when this case did not intend a
      // cross-project operation (a deliberate cross-project move is legitimate).
      const crossMut = !opts.allowCross && effects.some(e => e.project !== opts.expectedProject);
      if (v.ok && !crossMut) { status = 'correct'; reason = v.reason; }
      else if (!v.ok) { status = 'operation-error'; reason = v.reason; }
      else { status = 'wrong-root'; reason = 'cross-project contamination: ' + v.reason; }
    }

    rec.record({
      tool: T, mode: args.mode, transport, serverInstance: inst, phase: stepCtx.phase, transitionKind: stepCtx.kind,
      latencyMs: r.latencyMs, launcherCwd: stepCtx.launcherCwd, serverProcCwd: server.serverProcCwd(),
      evidenceTopology: server.kind === 'http' ? 'local-ancestry' : 'stdio-parent',
      expectedActiveRoot: stepCtx.expectedActiveRoot, observedActiveRoot: null, activeRootObservable: false,
      expectedTarget: opts.expectedTarget ?? null, actualTarget: opts.expectedTarget ?? null,
      fsEffects: effects, crossProjectMutation: !opts.allowCross && effects.some(e => e.project !== opts.expectedProject),
      status, assertionReason: reason, request: args,
      resultText: r.text, rpcError: r.rpcError ?? null, transportError: r.transportError ?? null, labels: opts.labels ?? [],
    });
    cov.observe(T, transport, rec.records[rec.records.length - 1]);
    return r;
  };

  const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
  const readF = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

  // ---- Per-transition: mkdir + a move inside that project + a delete --------
  let n = 0;
  await ctx.driveTransitions(async (stepCtx) => {
    const proj = stepCtx.proj;
    const dir = F[proj];
    // mkdir a fresh dir
    const mk = path.join(dir, `fm-dir-${stepCtx.index}`);
    cov.planned(T, transport, 1);
    await invoke(stepCtx, { mode: 'mkdir', path: mk },
      { expectedProject: proj, expectedTarget: mk, labels: ['mkdir'], verify: () => ({ ok: exists(mk), reason: exists(mk) ? 'mkdir created dir' : 'mkdir missing' }) });
    // create a file, then move it within the project (verify src absent + dst present + content)
    const src = path.join(dir, `fm-src-${n}.txt`);
    const dst = path.join(mk, `fm-dst-${n}.txt`);
    fs.writeFileSync(src, `moveme-${proj}-${n}\n`);
    cov.planned(T, transport, 1);
    await invoke(stepCtx, { mode: 'move', source: src, destination: dst },
      { expectedProject: proj, expectedTarget: dst, labels: ['move'], verify: () => {
        const srcGone = !exists(src); const dstHere = exists(dst); const content = readF(dst) === `moveme-${proj}-${n}\n`;
        const ok = srcGone && dstHere && content;
        return { ok, reason: ok ? 'move: source removed, destination present with exact content' : `move: srcGone=${srcGone} dstHere=${dstHere} content=${content}` };
      } });
    // info on the moved file
    cov.planned(T, transport, 1);
    await invoke(stepCtx, { mode: 'info', path: dst },
      { expectedProject: proj, expectedTarget: dst, labels: ['info'], verify: (res) => ({ ok: exists(dst) && /^size: \d+$/m.test(res.text ?? ''), reason: 'info returned size metadata for target' }) });
    // delete the file we created
    cov.planned(T, transport, 1);
    await invoke(stepCtx, { mode: 'delete', path: dst },
      { expectedProject: proj, expectedTarget: dst, labels: ['delete', 'own-file'], verify: () => ({ ok: !exists(dst), reason: !exists(dst) ? 'delete removed the file it created' : 'delete left file' }) });
    n++;
  });

  // ---- Breadth in A ---------------------------------------------------------
  const A = { proj: 'A', kind: 'stable', index: 400, phase: 'A#fm-breadth', dir: F.A, realDir: F.real.A, expectedActiveRoot: expectedBoundary(F.A), launcherCwd: F.A };
  process.chdir(F.A);

  // move ACROSS projects: A → B, while ambient cwd is A. Verify src(A) gone, dst(B) present.
  const crossSrc = path.join(F.A, 'cross-move.txt');
  const crossDst = path.join(F.B, 'cross-moved.txt');
  fs.writeFileSync(crossSrc, 'cross-A-to-B\n');
  cov.planned(T, transport, 1);
  await invoke(A, { mode: 'move', source: crossSrc, destination: crossDst },
    { expectedProject: null, expectedTarget: crossDst, allowCross: true, labels: ['move', 'cross-project', 'absolute-target', 'intentional-cross'], verify: () => {
      const ok = !exists(crossSrc) && exists(crossDst) && readF(crossDst) === 'cross-A-to-B\n';
      return { ok, reason: ok ? 'cross-project move: A source removed, B destination exact' : 'cross-project move mismatch' };
    } });

  // delete a directory → error ("Not a file.")
  cov.planned(T, transport, 1);
  await invoke(A, { mode: 'delete', path: path.join(F.A, 'fm-dir-0') },
    { expectError: true, expectedProject: 'A', labels: ['error-path', 'delete-dir'] });
  // delete a missing file → error ("Unable to locate file.")
  cov.planned(T, transport, 1);
  await invoke(A, { mode: 'delete', path: path.join(F.A, 'never-existed.txt') },
    { expectError: true, expectedProject: 'A', labels: ['error-path', 'delete-missing'] });
  // move with missing source → error
  cov.planned(T, transport, 1);
  await invoke(A, { mode: 'move', source: path.join(F.A, 'no-src.txt'), destination: path.join(F.A, 'no-dst.txt') },
    { expectError: true, expectedProject: 'A', labels: ['error-path', 'move-missing-src'] });
  // mkdir nested under space-dir project
  cov.planned(T, transport, 1);
  await invoke(A, { mode: 'mkdir', path: path.join(F.S, 'space dir') },
    { expectedProject: 'S', expectedTarget: path.join(F.S, 'space dir'), labels: ['mkdir', 'spaces'], verify: () => ({ ok: exists(path.join(F.S, 'space dir')), reason: 'mkdir a space-named dir (parent F.S exists)' }) });
  // move within symlink alias → real B
  const linkSrc = path.join(F.B, 'link-move-src.txt');
  fs.writeFileSync(linkSrc, 'link-move\n');
  cov.planned(T, transport, 1);
  await invoke(A, { mode: 'move', source: path.join(F.betaAlias, 'link-move-src.txt'), destination: path.join(F.betaAlias, 'link-move-dst.txt') },
    { expectedProject: 'B', expectedTarget: path.join(F.B, 'link-move-dst.txt'), labels: ['move', 'symlink'], verify: () => {
      const ok = !exists(linkSrc) && readF(path.join(F.B, 'link-move-dst.txt')) === 'link-move\n';
      return { ok, reason: ok ? 'move via symlink alias landed on real project B' : 'symlink move mismatch' };
    } });
  // info on a real file returns metadata text (size/isFile)
  cov.planned(T, transport, 1);
  await invoke(A, { mode: 'info', path: path.join(F.A, 'marker.txt') },
    { expectedProject: 'A', expectedTarget: path.join(F.A, 'marker.txt'), labels: ['info'], verify: (res) => ({ ok: exists(path.join(F.A, 'marker.txt')) && /^size: \d+$/m.test(res.text ?? ''), reason: 'info on existing file returned size metadata' }) });
  // recovery: a normal mkdir after errors still works
  cov.planned(T, transport, 1);
  await invoke(A, { mode: 'mkdir', path: path.join(F.A, 'fm-recovery') },
    { expectedProject: 'A', expectedTarget: path.join(F.A, 'fm-recovery'), labels: ['mkdir', 'recovery'], verify: () => ({ ok: exists(path.join(F.A, 'fm-recovery')), reason: 'recovery mkdir' }) });
}

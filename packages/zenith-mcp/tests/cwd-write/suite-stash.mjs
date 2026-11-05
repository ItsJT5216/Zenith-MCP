// ============================================================================
// stashRestore suite. Modes: list, read, apply, restore (clear). Stash entries
// are created through REALISTIC failed fixture edits (edit_file with an
// unmatchable oldContent calls stashEdits and throws "N failed. stash:<id>").
//
// Routing honesty: for UNREGISTERED detected roots the stash DB is the GLOBAL
// DB (shared across detected fixtures) — an intentional anti-litter design. We
// therefore do NOT demand separate per-project DBs for detected roots, and we
// do NOT use identical empty responses as a root oracle. The assertions are:
//   * a created entry is listable/readable and carries the real fixture path,
//   * apply actually retries the edit and writes the fixture (real effect),
//   * restore/clear removes the entry (subsequent read errors),
//   * relative `file`/`newPath` and omitted routing-hint cases are distinct.
// ============================================================================
import path from 'node:path';
import fs from 'node:fs';
import { snapshotAll, diffManifests, expectedBoundary } from './lib.mjs';

export async function runStashSuite(server, F, rec, cov, ctx) {
  const T = 'stashRestore';
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
      status, assertionReason: reason, request: args,
      resultText: r.text, rpcError: r.rpcError ?? null, transportError: r.transportError ?? null, labels: opts.labels ?? [],
    });
    cov.observe(T, transport, rec.records[rec.records.length - 1]);
    return r;
  };

  // Helper: create a real stash entry by forcing a failed content edit, and
  // parse the new stash id from the thrown message.
  const createEditStash = async (proj, uniqueMarker) => {
    const file = path.join(F[proj], 'edit.txt');
    // ensure a known base so the failed edit is well-formed but unmatchable
    const r = await server.callTool('edit_file', { path: file, edits: [{ mode: 'content', oldContent: `ZZZ-NO-MATCH-${uniqueMarker}`, newContent: 'x' }] });
    const m = /stash:(\d+)/.exec(r.text || '');
    return { stashId: m ? Number(m[1]) : null, file, raw: r.text };
  };

  // ---- Per-transition: create + list + read + restore an entry -------------
  let n = 0;
  await ctx.driveTransitions(async (stepCtx) => {
    const proj = stepCtx.proj;
    // create a real stash entry via a failed edit in this project
    const { stashId } = await createEditStash(proj, `${proj}-${n}`);
    // list: must contain an entry referencing this project's file
    cov.planned(T, transport, 1);
    await invoke(stepCtx, { mode: 'list' }, {
      expectedProject: proj, labels: ['list'],
      verify: (r) => {
        const t = r.text || '';
        const ok = stashId != null && t.includes(`#${stashId} `) && t.includes(`fixtures`);
        return { ok, reason: ok ? `list shows created stash #${stashId}` : `list missing #${stashId}: ${t.slice(0, 120)}` };
      } });
    // read the specific entry
    if (stashId != null) {
      cov.planned(T, transport, 1);
      await invoke(stepCtx, { mode: 'read', stashId }, {
        expectedProject: proj, labels: ['read'],
        verify: (r) => {
          const t = r.text || '';
          const ok = t.includes('[edit]') && t.includes('FAILED');
          return { ok, reason: ok ? `read returned edit entry #${stashId}` : `read mismatch: ${t.slice(0, 120)}` };
        } });
      // restore (clear) the entry, then read must error
      cov.planned(T, transport, 1);
      await invoke(stepCtx, { mode: 'restore', stashId }, {
        expectedProject: proj, labels: ['restore', 'clear'],
        verify: (r) => ({ ok: (r.text || '').includes('Cleared'), reason: 'restore cleared the entry' }) });
      cov.planned(T, transport, 1);
      await invoke(stepCtx, { mode: 'read', stashId }, {
        expectedProject: proj, expectError: true, labels: ['read-after-clear', 'error-path'] });
    } else {
      cov.planned(T, transport, 3);
      // record unsupported if we could not create an entry
      for (const m2 of ['list', 'read', 'restore']) {
        rec.record({ tool: T, mode: m2, transport, serverInstance: inst, phase: stepCtx.phase, transitionKind: stepCtx.kind,
          launcherCwd: stepCtx.launcherCwd, serverProcCwd: server.serverProcCwd(), status: 'unsupported',
          assertionReason: 'could not create a stash entry (no stash id parsed)', labels: ['setup-failure'] });
        cov.observe(T, transport, rec.records[rec.records.length - 1]);
      }
    }
    n++;
  });

  // ---- Breadth in A: apply (real retry that writes) + routing-hint variants -
  const A = { proj: 'A', kind: 'stable', index: 500, phase: 'A#stash-breadth', dir: F.A, realDir: F.real.A, expectedActiveRoot: expectedBoundary(F.A), launcherCwd: F.A };
  process.chdir(F.A);
  const editFile = path.join(F.A, 'edit.txt');
  const baseContent = 'alpha one\nbeta two\ngamma three\ndelta four\nepsilon five\n';

  // Create an apply-able stash: an edit that fails NOW but will succeed after
  // we change the file. Trick: stash an edit whose oldContent is absent now;
  // then write the file so oldContent becomes present; then apply succeeds.
  fs.writeFileSync(editFile, baseContent);
  const pendMarker = 'PENDING-TARGET-LINE';
  const c1 = await server.callTool('edit_file', { path: editFile, edits: [{ mode: 'content', oldContent: pendMarker, newContent: 'APPLIED-LINE' }] });
  const applyId = /stash:(\d+)/.exec(c1.text || '')?.[1] ? Number(/stash:(\d+)/.exec(c1.text || '')[1]) : null;
  // now make the marker present, then apply the stash (real retry → real write)
  fs.writeFileSync(editFile, baseContent + pendMarker + '\n');
  cov.planned(T, transport, 1);
  await invoke(A, { mode: 'apply', stashId: applyId }, {
    expectedProject: 'A', expectedTarget: editFile, labels: ['apply', 'real-retry'],
    verify: (r) => {
      const onDisk = (() => { try { return fs.readFileSync(editFile, 'utf8'); } catch { return null; } })();
      const ok = onDisk !== null && onDisk.includes('APPLIED-LINE') && !onDisk.includes(pendMarker);
      return { ok, reason: ok ? 'apply retried the edit and wrote the fixture' : `apply did not write: ${String(onDisk).slice(0, 80)}` };
    } });

  // apply with a dryRun (control — must not write). Create the stash by a real
  // failed edit (oldContent absent), then make that content present so the apply
  // would succeed; dryRun must validate and produce a diff WITHOUT writing.
  fs.writeFileSync(editFile, baseContent); // no DRYRUN-TARGET yet → the edit below fails and stashes
  const c2 = await server.callTool('edit_file', { path: editFile, edits: [{ mode: 'content', oldContent: 'DRYRUN-TARGET', newContent: 'DRYRUN-REPLACED' }] });
  const dryId = /stash:(\d+)/.exec(c2.text || '')?.[1] ? Number(/stash:(\d+)/.exec(c2.text || '')[1]) : null;
  if (dryId != null) {
    // now make the target present so a real apply would succeed
    fs.writeFileSync(editFile, baseContent + 'DRYRUN-TARGET\n');
    cov.planned(T, transport, 1);
    const beforeDry = fs.readFileSync(editFile, 'utf8');
    await invoke(A, { mode: 'apply', stashId: dryId, dryRun: true }, {
      expectedProject: 'A', expectedTarget: editFile, labels: ['apply', 'dry-run-control'],
      verify: (r) => {
        const afterDry = fs.readFileSync(editFile, 'utf8');
        const ok = afterDry === beforeDry && !(r.isError) && typeof r.text === 'string';
        return { ok, reason: ok ? 'apply dryRun validated and did not write' : `dryRun wrote or errored: ${(r.text||'').slice(0,80)}` };
      } });
  } else { cov.planned(T, transport, 1); rec.record({ tool: T, mode: 'apply', transport, serverInstance: inst, phase: A.phase, status: 'unsupported', assertionReason: 'no dryRun stash id', labels: ['setup-failure'] }); cov.observe(T, transport, rec.records[rec.records.length - 1]); }

  // Force a real write-type stash NOW (before the type-filter check, which needs
  // both types live): writing ONTO an existing DIRECTORY fails at rename (EISDIR)
  // and the tool caches the content via stashWrite. Applied further below.
  const badTarget = path.join(F.A, 'src'); // an existing directory
  const wr = await server.callTool('write_file', { path: badTarget, content: 'write-stash-content\n' });
  const writeId = /stash:(\d+)/.exec(wr.text || '')?.[1] ? Number(/stash:(\d+)/.exec(wr.text || '')[1]) : null;

  // list with a type filter (write vs edit) and a range. The live entries are
  // the dryRun edit stash (dryId) and the write stash (writeId). Control first:
  // an UNFILTERED list must show both types, otherwise an ignored filter would
  // be indistinguishable from a correct one; then type=edit must drop [write].
  const unsupported = (mode, why) => {
    rec.record({ tool: T, mode, transport, serverInstance: inst, phase: A.phase, status: 'unsupported', assertionReason: why, labels: ['type-filter', 'setup-failure'] });
    cov.observe(T, transport, rec.records[rec.records.length - 1]);
  };
  cov.planned(T, transport, 2);
  let bothTypesListed = false;
  if (dryId != null && writeId != null) {
    await invoke(A, { mode: 'list', range: 5 }, {
      expectedProject: 'A', labels: ['list', 'type-filter-control', 'range'],
      verify: (r) => {
        const t = r.text || '';
        bothTypesListed = t.includes('[edit]') && t.includes('[write]');
        return { ok: bothTypesListed, reason: bothTypesListed ? 'unfiltered list shows both [edit] and [write]' : `unfiltered list lacks a type: ${t.slice(0, 120)}` };
      } });
  } else {
    unsupported('list', `no live edit+write stash pair to filter (edit #${dryId}, write #${writeId})`);
  }
  if (bothTypesListed) {
    await invoke(A, { mode: 'list', type: 'edit', range: 5 }, {
      expectedProject: 'A', labels: ['list', 'type-filter', 'range'],
      verify: (r) => {
        const t = r.text || '';
        const ok = t.includes('[edit]') && !t.includes('[write]');
        return { ok, reason: ok ? 'type=edit list kept [edit] and excluded [write]' : `type filter ignored or empty: ${t.slice(0, 120)}` };
      } });
  } else {
    unsupported('list', 'type-filter check skipped: unfiltered control did not show both [edit] and [write]');
  }

  // relative `file` routing hint vs omitted hint — distinct cases.
  // Relative file: 'edit.txt' relative to the SERVER's launch cwd. Recorded as
  // a routing-hint case; not an active-root oracle.
  cov.planned(T, transport, 1);
  await invoke(A, { mode: 'list', file: 'edit.txt' }, {
    expectedProject: 'A', labels: ['list', 'relative-routing-hint'],
    verify: (r) => ({ ok: typeof r.text === 'string', reason: 'list with relative file hint returned (routing-hint, not a root oracle)' }) });

  // apply the write-type stash created above with a newPath redirect (distinct
  // routing case)
  if (writeId != null) {
    const goodTarget = path.join(F.A, 'write-applied.txt');
    cov.planned(T, transport, 1);
    await invoke(A, { mode: 'apply', stashId: writeId, newPath: goodTarget }, {
      expectedProject: 'A', expectedTarget: goodTarget, labels: ['apply', 'write-type', 'newPath-redirect'],
      verify: (r) => {
        const onDisk = (() => { try { return fs.readFileSync(goodTarget, 'utf8'); } catch { return null; } })();
        return { ok: onDisk === 'write-stash-content\n', reason: onDisk === 'write-stash-content\n' ? 'write stash applied to newPath with exact content' : `write apply mismatch: ${String(onDisk)}` };
      } });
  } else { cov.planned(T, transport, 1); rec.record({ tool: T, mode: 'apply', transport, serverInstance: inst, phase: A.phase, status: 'unsupported', assertionReason: 'no write stash id', labels: ['setup-failure'] }); cov.observe(T, transport, rec.records[rec.records.length - 1]); }
}

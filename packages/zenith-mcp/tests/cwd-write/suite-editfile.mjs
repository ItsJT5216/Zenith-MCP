// ============================================================================
// edit_file suite. Modes: content (oldContent→newContent), block
// (block_start/block_end→replacement_block), symbol (symbol→newText, nearLine).
// Target is the explicit `path` (validatePath → realpath). We assert the exact
// changed fixture content AND that sibling fixtures are unchanged. Includes
// real success in every mode, an ambiguity/error case, a dryRun that must NOT
// write, and recovery. dryRun is a control, never a substitute for real writes.
// ============================================================================
import path from 'node:path';
import fs from 'node:fs';
import { snapshotAll, diffManifests, expectedBoundary } from './lib.mjs';

export async function runEditFileSuite(server, F, rec, cov, ctx) {
  const T = 'edit_file';
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
      if (r.isError) { status = 'ok'; reason = 'expected error surfaced: ' + (r.text || '').slice(0, 120); }
      else { status = 'operation-error'; reason = 'expected error but call succeeded'; }
    } else if (r.isError) { status = 'operation-error'; reason = 'unexpected tool error: ' + (r.text || '').slice(0, 160); }
    else if (opts.expectContent != null && opts.expectedAbs) {
      let onDisk = null;
      try { onDisk = fs.readFileSync(opts.expectedAbs, 'utf8'); } catch {}
      const crossMut = effects.some(e => e.project !== opts.expectedProject);
      if (onDisk === opts.expectContent && !crossMut) { status = 'correct'; reason = 'exact edited content + siblings unchanged'; }
      else if (onDisk !== opts.expectContent) { status = 'operation-error'; reason = 'edited content mismatch'; }
      else { status = 'wrong-root'; reason = 'edit contaminated a sibling project'; }
    } else if (opts.dryRunNoWrite && opts.expectedAbs) {
      // dryRun: file must be UNCHANGED (still its original content)
      let onDisk = null;
      try { onDisk = fs.readFileSync(opts.expectedAbs, 'utf8'); } catch {}
      const hasPreview = (r.text || '').trim().length > 0;
      if (effects.length === 0 && onDisk === opts.unchangedContent && hasPreview) { status = 'ok'; reason = 'dryRun produced a diff without writing'; }
      else { status = 'operation-error'; reason = 'dryRun mutated the file or produced no diff'; }
    }

    rec.record({
      tool: T, mode: args.edits?.[0]?.mode ?? 'edit', transport, serverInstance: inst,
      phase: stepCtx.phase, transitionKind: stepCtx.kind, latencyMs: r.latencyMs,
      launcherCwd: stepCtx.launcherCwd, serverProcCwd: server.serverProcCwd(),
      evidenceTopology: server.kind === 'http' ? 'local-ancestry' : 'stdio-parent',
      expectedActiveRoot: stepCtx.expectedActiveRoot, observedActiveRoot: null, activeRootObservable: false,
      expectedTarget: opts.expectedAbs ?? null, actualTarget: opts.expectedAbs ?? null,
      fsEffects: effects, crossProjectMutation: effects.some(e => e.project !== opts.expectedProject),
      status, assertionReason: reason, request: { path: args.path, edits: `[${args.edits?.length ?? 0} edits]`, dryRun: !!args.dryRun },
      resultText: r.text, rpcError: r.rpcError ?? null, transportError: r.transportError ?? null, labels: opts.labels ?? [],
    });
    cov.observe(T, transport, rec.records[rec.records.length - 1]);
    return r;
  };

  // ---- Per-transition content edits across A/B/C ----------------------------
  // Each project has edit.txt with known lines; we rewrite a unique line per
  // step and verify the exact result + sibling immutability.
  let editN = 0;
  await ctx.driveTransitions(async (stepCtx) => {
    const proj = stepCtx.proj;
    const file = path.join(F[proj], 'edit.txt');
    const original = 'alpha one\nbeta two\ngamma three\ndelta four\nepsilon five\n';
    const tag = `${proj.toLowerCase()}-edited-${editN++}`;
    // content-mode: replace 'gamma three' with a unique tag
    const expect = original.replace('gamma three', tag);
    cov.planned(T, transport, 1);
    const r = await invoke(stepCtx, { path: file, edits: [{ mode: 'content', oldContent: 'gamma three', newContent: tag }] },
      { expectedAbs: file, expectedProject: proj, expectContent: expect, labels: ['transition-edit', 'content-mode'] });
    // restore for the next repetition-independent step (idempotent fixture)
    if (!r.isError) {
      await server.callTool(T, { path: file, edits: [{ mode: 'content', oldContent: tag, newContent: 'gamma three' }] });
    }
  });

  // ---- Breadth in A ---------------------------------------------------------
  const A = { proj: 'A', kind: 'stable', index: 300, phase: 'A#edit-breadth', dir: F.A, realDir: F.real.A, expectedActiveRoot: expectedBoundary(F.A), launcherCwd: F.A };
  process.chdir(F.A);
  const editFile = path.join(F.A, 'edit.txt');
  const baseContent = 'alpha one\nbeta two\ngamma three\ndelta four\nepsilon five\n';
  const setFile = (c) => fs.writeFileSync(editFile, c);

  // content mode real success
  cov.planned(T, transport, 1); setFile(baseContent);
  await invoke(A, { path: editFile, edits: [{ mode: 'content', oldContent: 'beta two', newContent: 'BETA-2' }] },
    { expectedAbs: editFile, expectedProject: 'A', expectContent: baseContent.replace('beta two', 'BETA-2'), labels: ['content-mode'] });

  // block mode real success (replace lines 3..4 block)
  cov.planned(T, transport, 1); setFile(baseContent);
  await invoke(A, { path: editFile, edits: [{ mode: 'block', block_start: 'gamma three', block_end: 'delta four', replacement_block: 'GAMMA-3\nDELTA-4' }] },
    { expectedAbs: editFile, expectedProject: 'A', expectContent: 'alpha one\nbeta two\nGAMMA-3\nDELTA-4\nepsilon five\n', labels: ['block-mode'] });

  // symbol mode real success on src/a.js (helperAlpha body)
  const ajs = path.join(F.A, 'src', 'a.js');
  const ajsBase = fs.readFileSync(ajs, 'utf8');
  cov.planned(T, transport, 1);
  const symRes = await invoke(A, { path: ajs, edits: [{ mode: 'symbol', symbol: 'helperAlpha', newText: "function helperAlpha() { return 'ALPHA-EDITED'; }" }] },
    { expectedAbs: ajs, expectedProject: 'A', expectContent: ajsBase.replace("return 'alpha-A'", "return 'ALPHA-EDITED'"), labels: ['symbol-mode'] });
  // restore symbol file
  if (!symRes.isError) fs.writeFileSync(ajs, ajsBase);

  // dryRun: must produce a diff and NOT write
  cov.planned(T, transport, 1); setFile(baseContent);
  await invoke(A, { path: editFile, edits: [{ mode: 'content', oldContent: 'delta four', newContent: 'DELTA-4' }], dryRun: true },
    { expectedAbs: editFile, expectedProject: 'A', dryRunNoWrite: true, unchangedContent: baseContent, labels: ['dry-run-control'] });

  // ambiguity error: block mode with two identical block boundaries → the engine
  // throws "Ambiguous: ... Provide startLine or nearLine" (content mode replaces
  // the first occurrence and is intentionally NOT ambiguous, so block mode is the
  // real ambiguity control).
  cov.planned(T, transport, 1); setFile('dup line\nmiddle\ndup line\nunique\n');
  await invoke(A, { path: editFile, edits: [{ mode: 'block', block_start: 'dup line', block_end: 'dup line', replacement_block: 'x' }] },
    { expectError: true, expectedProject: 'A', labels: ['ambiguity', 'error-path'] });

  // not-found error then recovery. Note: a not-found content edit stashes the
  // failed edit (stashEdits) — that is the production stash path, surfaced as a
  // tool error containing "stash:<id>". We then recover with a real edit.
  cov.planned(T, transport, 2); setFile(baseContent);
  await invoke(A, { path: editFile, edits: [{ mode: 'content', oldContent: 'no such text', newContent: 'x' }] },
    { expectError: true, expectedProject: 'A', labels: ['not-found', 'error-path', 'stash-on-failure'] });
  await invoke(A, { path: editFile, edits: [{ mode: 'content', oldContent: 'epsilon five', newContent: 'EPS-5' }] },
    { expectedAbs: editFile, expectedProject: 'A', expectContent: baseContent.replace('epsilon five', 'EPS-5'), labels: ['recovery'] });

  // batch of two content edits in one call
  cov.planned(T, transport, 1); setFile(baseContent);
  await invoke(A, { path: editFile, edits: [
      { mode: 'content', oldContent: 'alpha one', newContent: 'A1' },
      { mode: 'content', oldContent: 'epsilon five', newContent: 'E5' } ] },
    { expectedAbs: editFile, expectedProject: 'A', expectContent: 'A1\nbeta two\ngamma three\ndelta four\nE5\n', labels: ['batch'] });
  setFile(baseContent);

  // ---- Additional breadth -----------------------------------------------------
  // content edit on line 1 (boundary)
  cov.planned(T, transport, 1); setFile(baseContent);
  await invoke(A, { path: editFile, edits: [{ mode: 'content', oldContent: 'alpha one', newContent: 'A-ONE' }] },
    { expectedAbs: editFile, expectedProject: 'A', expectContent: baseContent.replace('alpha one', 'A-ONE'), labels: ['content-mode', 'first-line'] });
  // content edit on the last line (boundary)
  cov.planned(T, transport, 1); setFile(baseContent);
  await invoke(A, { path: editFile, edits: [{ mode: 'content', oldContent: 'epsilon five', newContent: 'E-FIVE' }] },
    { expectedAbs: editFile, expectedProject: 'A', expectContent: baseContent.replace('epsilon five', 'E-FIVE'), labels: ['content-mode', 'last-line'] });
  // multi-line content replacement
  cov.planned(T, transport, 1); setFile(baseContent);
  await invoke(A, { path: editFile, edits: [{ mode: 'content', oldContent: 'beta two\ngamma three', newContent: 'B2\nG3\nG3b' }] },
    { expectedAbs: editFile, expectedProject: 'A', expectContent: 'alpha one\nB2\nG3\nG3b\ndelta four\nepsilon five\n', labels: ['content-mode', 'multiline'] });
  // block mode single-line replace (start==end)
  cov.planned(T, transport, 1); setFile(baseContent);
  await invoke(A, { path: editFile, edits: [{ mode: 'block', block_start: 'delta four', block_end: 'delta four', replacement_block: 'D-FOUR' }] },
    { expectedAbs: editFile, expectedProject: 'A', expectContent: baseContent.replace('delta four', 'D-FOUR'), labels: ['block-mode', 'single-line'] });
  // block mode replacing a 3-line span with 1 line (shrink)
  cov.planned(T, transport, 1); setFile(baseContent);
  await invoke(A, { path: editFile, edits: [{ mode: 'block', block_start: 'beta two', block_end: 'delta four', replacement_block: 'MIDDLE' }] },
    { expectedAbs: editFile, expectedProject: 'A', expectContent: 'alpha one\nMIDDLE\nepsilon five\n', labels: ['block-mode', 'shrink'] });
  // symbol edit on the OTHER symbol (helperAlpha in a.js) then restore
  cov.planned(T, transport, 1);
  {
    const ajs2 = path.join(F.A, 'src', 'a.js');
    const base2 = fs.readFileSync(ajs2, 'utf8');
    const rr = await invoke(A, { path: ajs2, edits: [{ mode: 'symbol', symbol: 'callerA', newText: 'function callerA() { return 42; }' }] },
      { expectedAbs: ajs2, expectedProject: 'A', expectContent: base2.replace('function callerA() { return targetFn(1); }', 'function callerA() { return 42; }'), labels: ['symbol-mode', 'caller'] });
    if (!rr.isError) fs.writeFileSync(ajs2, base2);
  }
  // symbol edit with nearLine disambiguation on b.js (targetFn appears in both files,
  // but file-scoped to b.js so it is unambiguous there)
  cov.planned(T, transport, 1);
  {
    const bjs = path.join(F.A, 'src', 'b.js');
    const bbase = fs.readFileSync(bjs, 'utf8');
    const rr = await invoke(A, { path: bjs, edits: [{ mode: 'symbol', symbol: 'helperBeta', newText: "function helperBeta() { return 'B-EDITED'; }" }] },
      { expectedAbs: bjs, expectedProject: 'A', expectContent: bbase.replace("return 'beta-A'", "return 'B-EDITED'"), labels: ['symbol-mode'] });
    if (!rr.isError) fs.writeFileSync(bjs, bbase);
  }
  // whitespace-tolerant content edit (old content with different indentation matches)
  cov.planned(T, transport, 1); setFile('  indented line\n  another\n');
  await invoke(A, { path: editFile, edits: [{ mode: 'content', oldContent: 'indented line', newContent: 'INDENTED' }] },
    { expectedAbs: editFile, expectedProject: 'A', expectContent: '  INDENTED\n  another\n', labels: ['content-mode', 'whitespace-tolerant'] });
  setFile(baseContent);
  // dryRun on a block edit (control, no write)
  cov.planned(T, transport, 1); setFile(baseContent);
  await invoke(A, { path: editFile, edits: [{ mode: 'block', block_start: 'gamma three', block_end: 'gamma three', replacement_block: 'G-THREE' }], dryRun: true },
    { expectedAbs: editFile, expectedProject: 'A', dryRunNoWrite: true, unchangedContent: baseContent, labels: ['dry-run-control', 'block-mode'] });
  // edit a file inside the space project (absolute path with space)
  cov.planned(T, transport, 1);
  {
    const sFile = path.join(F.S, 'edit.txt');
    const sBase = fs.readFileSync(sFile, 'utf8');
    await invoke(A, { path: sFile, edits: [{ mode: 'content', oldContent: 'gamma three', newContent: 'gamma-S' }] },
      { expectedAbs: sFile, expectedProject: 'S', expectContent: sBase.replace('gamma three', 'gamma-S'), labels: ['spaces', 'content-mode'] });
  }
  // edit through the beta symlink alias → lands on real B, A unchanged
  cov.planned(T, transport, 1);
  {
    const bFile = path.join(F.B, 'edit.txt');
    const bBase = fs.readFileSync(bFile, 'utf8');
    await invoke(A, { path: path.join(F.betaAlias, 'edit.txt'), edits: [{ mode: 'content', oldContent: 'beta two', newContent: 'beta-LINK' }] },
      { expectedAbs: bFile, expectedProject: 'B', expectContent: bBase.replace('beta two', 'beta-LINK'), labels: ['symlink', 'content-mode'] });
  }
  // no-edits error (empty edits array) → "No edits provided."
  cov.planned(T, transport, 1); setFile(baseContent);
  await invoke(A, { path: editFile, edits: [] },
    { expectError: true, expectedProject: 'A', labels: ['error-path', 'no-edits'] });
  // edit a missing file → error
  cov.planned(T, transport, 1);
  await invoke(A, { path: path.join(F.A, 'no-such-file.txt'), edits: [{ mode: 'content', oldContent: 'x', newContent: 'y' }] },
    { expectError: true, expectedProject: 'A', labels: ['error-path', 'missing-file'] });
  setFile(baseContent);
}

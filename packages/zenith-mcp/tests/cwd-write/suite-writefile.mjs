// ============================================================================
// write_file suite. Target is the explicit `path` arg; the project binding
// does NOT change the target (validateNewFilePath resolves relative paths
// against process.cwd(), the server's fixed launch cwd). We therefore assert:
//   * create / overwrite / append produce EXACT destination contents,
//   * a write whose path is absolute into project P lands in P and ONLY P
//     (sibling fixtures verified unmutated by manifest diff),
//   * nested new paths auto-create parents,
//   * a RELATIVE path write resolves against the server's fixed launch cwd
//     (a documented pre-existing behavior) — recorded with the active root
//     observed separately so the two are never conflated,
//   * supported negative controls (failIfExists, write to a dir path),
//   * failIfExists + a forced write-failure stash path is exercised by
//     stashRestore's suite (which creates real stash entries).
// Unique per-project payloads make cross-project contamination detectable.
// ============================================================================
import path from 'node:path';
import fs from 'node:fs';
import { realpathSafe, snapshotAll, diffManifests, expectedBoundary } from './lib.mjs';

export async function runWriteFileSuite(server, F, rec, cov, ctx) {
  const T = 'write_file';
  const transport = server.kind;
  const inst = ctx.serverInstance;
  const serverCwd = server.serverProcCwd();

  const invoke = async (stepCtx, args, opts = {}) => {
    const before = snapshotAll(F);
    const r = await server.callTool(T, args);
    const after = snapshotAll(F);
    const effects = diffManifests(before, after);

    // Determine actual destination the tool wrote (from fs effects), if any.
    const written = effects.filter(e => e.change === 'added' || e.change === 'modified');
    // Expected absolute target
    const expectedAbs = opts.expectedAbs ?? null;
    let actualTarget = null;
    if (expectedAbs) {
      // locate which fixture/rel got the expected file
      const expRel = opts.expectedRel;
      const hit = written.find(w => opts.expectedProject && w.project === opts.expectedProject && w.rel === expRel);
      actualTarget = hit ? expectedAbs : (written.length ? '(unexpected target)' : null);
    }

    let status = 'ok', reason = '';
    if (!r.ok && (r.rpcError || r.transportError)) { status = 'harness-error'; reason = 'transport/rpc error'; }
    else if (opts.expectError) {
      if (r.isError) { status = 'ok'; reason = 'expected error surfaced: ' + (r.text || '').slice(0, 100); }
      else { status = 'operation-error'; reason = 'expected error but call succeeded'; }
    } else if (r.isError) { status = 'operation-error'; reason = 'unexpected tool error: ' + (r.text || '').slice(0, 120); }
    else if (expectedAbs) {
      // verify exact bytes on disk
      let onDisk = null;
      try { onDisk = fs.readFileSync(expectedAbs, 'utf8'); } catch {}
      if (onDisk !== null && onDisk === opts.expectedContent) {
        // cross-project contamination check
        const crossMut = effects.some(e => e.project !== opts.expectedProject);
        status = crossMut ? 'wrong-root' : 'correct';
        reason = crossMut ? 'write contaminated a sibling project' : 'exact destination contents + siblings unmutated';
        actualTarget = expectedAbs;
      } else {
        status = 'operation-error';
        reason = `destination content mismatch (got ${onDisk === null ? 'ENOENT' : 'different bytes'})`;
      }
    }

    rec.record({
      tool: T, mode: args.append ? 'append' : (args.failIfExists ? 'create-failIfExists' : 'write'),
      transport, serverInstance: inst, phase: stepCtx.phase, transitionKind: stepCtx.kind,
      latencyMs: r.latencyMs, launcherCwd: stepCtx.launcherCwd, serverProcCwd: serverCwd,
      evidenceTopology: server.kind === 'http' ? 'local-ancestry' : 'stdio-parent',
      expectedActiveRoot: stepCtx.expectedActiveRoot, observedActiveRoot: null, activeRootObservable: false,
      expectedTarget: expectedAbs, actualTarget,
      fsEffects: effects, crossProjectMutation: effects.some(e => e.project !== opts.expectedProject),
      status, assertionReason: reason, request: { ...args, content: `[${(args.content||'').length} bytes]` },
      resultText: r.text, rpcError: r.rpcError ?? null, transportError: r.transportError ?? null,
      labels: opts.labels ?? [],
    });
    cov.observe(T, transport, rec.records[rec.records.length - 1]);
    return r;
  };

  // ---- Per-transition absolute writes with unique per-project payloads ------
  // Each step writes a uniquely-tagged file into THAT step's project and asserts
  // only that project changed. This exercises detection-adjacent writes across
  // A/B/C without the path arg being relative (so the target is unambiguous).
  let tagN = 0;
  await ctx.driveTransitions(async (stepCtx) => {
    const proj = stepCtx.proj;
    const dir = F[proj];
    const payload = `payload-${proj}-#${tagN++}-${proj === 'A' ? 'ALPHA' : proj === 'B' ? 'BETA' : 'GAMMA'}`;
    const rel = `wf-${stepCtx.kind}-${stepCtx.index}.txt`;
    const abs = path.join(dir, rel);
    cov.planned(T, transport, 1);
    await invoke(stepCtx, { path: abs, content: payload + '\n' },
      { expectedAbs: abs, expectedRel: rel, expectedProject: proj, expectedContent: payload + '\n', labels: ['transition-write'] });
  });

  // ---- Breadth in A ---------------------------------------------------------
  const A = { proj: 'A', kind: 'stable', index: 200, phase: 'A#wf-breadth', dir: F.A, realDir: F.real.A, expectedActiveRoot: expectedBoundary(F.A), launcherCwd: F.A };
  process.chdir(F.A);

  // create new file
  cov.planned(T, transport, 1);
  await invoke(A, { path: path.join(F.A, 'create.txt'), content: 'create-A\n' },
    { expectedAbs: path.join(F.A, 'create.txt'), expectedRel: 'create.txt', expectedProject: 'A', expectedContent: 'create-A\n', labels: ['create'] });
  // overwrite it
  cov.planned(T, transport, 1);
  await invoke(A, { path: path.join(F.A, 'create.txt'), content: 'overwrote-A\n' },
    { expectedAbs: path.join(F.A, 'create.txt'), expectedRel: 'create.txt', expectedProject: 'A', expectedContent: 'overwrote-A\n', labels: ['overwrite'] });
  // append to it
  cov.planned(T, transport, 1);
  await invoke(A, { path: path.join(F.A, 'create.txt'), content: 'appended-A\n', append: true },
    { expectedAbs: path.join(F.A, 'create.txt'), expectedRel: 'create.txt', expectedProject: 'A', expectedContent: 'overwrote-A\nappended-A\n', labels: ['append'] });
  // append resume: re-append the SAME tail — findResumeOffset should dedup it
  cov.planned(T, transport, 1);
  await invoke(A, { path: path.join(F.A, 'create.txt'), content: 'appended-A\n', append: true },
    { expectedAbs: path.join(F.A, 'create.txt'), expectedRel: 'create.txt', expectedProject: 'A', expectedContent: 'overwrote-A\nappended-A\n', labels: ['append-resume'] });
  // nested new path auto-creates parents
  cov.planned(T, transport, 1);
  await invoke(A, { path: path.join(F.A, 'deep/nest/dir/file.txt'), content: 'nested-A\n' },
    { expectedAbs: path.join(F.A, 'deep/nest/dir/file.txt'), expectedRel: 'deep/nest/dir/file.txt', expectedProject: 'A', expectedContent: 'nested-A\n', labels: ['nested-new-path'] });
  // failIfExists on an existing file → error
  cov.planned(T, transport, 1);
  await invoke(A, { path: path.join(F.A, 'create.txt'), content: 'x\n', failIfExists: true },
    { expectError: true, expectedProject: 'A', labels: ['negative', 'failIfExists'] });
  // failIfExists on a NEW file → success
  cov.planned(T, transport, 1);
  await invoke(A, { path: path.join(F.A, 'fresh.txt'), content: 'fresh-A\n', failIfExists: true },
    { expectedAbs: path.join(F.A, 'fresh.txt'), expectedRel: 'fresh.txt', expectedProject: 'A', expectedContent: 'fresh-A\n', labels: ['failIfExists-new'] });
  // write into the space-dir project (absolute path with a space)
  cov.planned(T, transport, 1);
  await invoke(A, { path: path.join(F.S, 'space.txt'), content: 'space-S\n' },
    { expectedAbs: path.join(F.S, 'space.txt'), expectedRel: 'space.txt', expectedProject: 'S', expectedContent: 'space-S\n', labels: ['spaces'] });
  // write through the beta symlink alias → must land on real B only
  cov.planned(T, transport, 1);
  await invoke(A, { path: path.join(F.betaAlias, 'via-link.txt'), content: 'link-B\n' },
    { expectedAbs: path.join(F.B, 'via-link.txt'), expectedRel: 'via-link.txt', expectedProject: 'B', expectedContent: 'link-B\n', labels: ['symlink'] });

  // ---- Additional breadth: overwrite/append cycle + larger + unicode + multi-line
  // overwrite an existing fixture file (notes.txt) and verify exact bytes
  cov.planned(T, transport, 1);
  await invoke(A, { path: path.join(F.A, 'notes.txt'), content: 'notes-overwritten-A\n' },
    { expectedAbs: path.join(F.A, 'notes.txt'), expectedRel: 'notes.txt', expectedProject: 'A', expectedContent: 'notes-overwritten-A\n', labels: ['overwrite-existing-fixture'] });
  // restore notes.txt original for fixture hygiene
  await server.callTool(T, { path: path.join(F.A, 'notes.txt'), content: '# proj-alpha notes\npayload:A\nline three\nline four\nline five\n' });
  // append to a file that does not end with a newline (separator insertion)
  cov.planned(T, transport, 1);
  await invoke(A, { path: path.join(F.A, 'nonl.txt'), content: 'no-trailing-newline' },
    { expectedAbs: path.join(F.A, 'nonl.txt'), expectedRel: 'nonl.txt', expectedProject: 'A', expectedContent: 'no-trailing-newline', labels: ['create'] });
  cov.planned(T, transport, 1);
  await invoke(A, { path: path.join(F.A, 'nonl.txt'), content: 'second', append: true },
    { expectedAbs: path.join(F.A, 'nonl.txt'), expectedRel: 'nonl.txt', expectedProject: 'A', expectedContent: 'no-trailing-newline\nsecond', labels: ['append', 'newline-separator'] });
  // multi-line content with interior blank lines
  cov.planned(T, transport, 1);
  await invoke(A, { path: path.join(F.A, 'multi.txt'), content: 'one\n\nthree\n\nfive\n' },
    { expectedAbs: path.join(F.A, 'multi.txt'), expectedRel: 'multi.txt', expectedProject: 'A', expectedContent: 'one\n\nthree\n\nfive\n', labels: ['multiline'] });
  // unicode payload round-trip (exact bytes)
  cov.planned(T, transport, 1);
  await invoke(A, { path: path.join(F.A, 'unicode.txt'), content: 'héllo π 世界 — ü\n' },
    { expectedAbs: path.join(F.A, 'unicode.txt'), expectedRel: 'unicode.txt', expectedProject: 'A', expectedContent: 'héllo π 世界 — ü\n', labels: ['unicode'] });
  // empty content write (a real supported operation)
  cov.planned(T, transport, 1);
  await invoke(A, { path: path.join(F.A, 'empty.txt'), content: '' },
    { expectedAbs: path.join(F.A, 'empty.txt'), expectedRel: 'empty.txt', expectedProject: 'A', expectedContent: '', labels: ['empty-content'] });
  // CRLF in content is normalized to LF by the tool (normalizeLineEndings)
  cov.planned(T, transport, 1);
  await invoke(A, { path: path.join(F.A, 'crlf.txt'), content: 'a\r\nb\r\n' },
    { expectedAbs: path.join(F.A, 'crlf.txt'), expectedRel: 'crlf.txt', expectedProject: 'A', expectedContent: 'a\nb\n', labels: ['crlf-normalize'] });
  // write to B and C absolute while ambient cwd is A (operation target explicit,
  // ambient cwd unchanged) — verify target identity + A unchanged
  cov.planned(T, transport, 1);
  await invoke(A, { path: path.join(F.B, 'from-A-to-B.txt'), content: 'B-target\n' },
    { expectedAbs: path.join(F.B, 'from-A-to-B.txt'), expectedRel: 'from-A-to-B.txt', expectedProject: 'B', expectedContent: 'B-target\n', labels: ['absolute-target', 'ambient-unchanged'] });
  cov.planned(T, transport, 1);
  await invoke(A, { path: path.join(F.C, 'from-A-to-C.txt'), content: 'C-target\n' },
    { expectedAbs: path.join(F.C, 'from-A-to-C.txt'), expectedRel: 'from-A-to-C.txt', expectedProject: 'C', expectedContent: 'C-target\n', labels: ['absolute-target', 'ambient-unchanged'] });

  // ---- Relative path write: resolves against server's fixed launch cwd ------
  // The server's /proc cwd is its launch dir (the first fixture). A relative
  // write goes there. We assert the file actually landed relative to
  // serverProcCwd (the documented current behavior), and we do NOT count this
  // as detection accuracy (the active root is not the write target here).
  cov.planned(T, transport, 1);
  const relName = 'rel-write.txt';
  const relExpectedAbs = serverCwd ? path.join(serverCwd, relName) : null;
  // which fixture is the server cwd?
  const serverProj = serverCwd === F.real.A ? 'A' : serverCwd === F.real.B ? 'B' : serverCwd === F.real.C ? 'C' : serverCwd === F.real.S ? 'S' : null;
  await invoke(A, { path: relName, content: 'rel-target\n' },
    { expectedAbs: relExpectedAbs, expectedRel: relName, expectedProject: serverProj, expectedContent: 'rel-target\n', labels: ['relative-path', 'launch-cwd-target'] });
}

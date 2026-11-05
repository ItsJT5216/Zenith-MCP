// ============================================================================
// bash suite — the only owned tool whose operation TARGET comes from the
// active binding when `cwd` is omitted. Its transcript prompt line `<cwd>$ …`
// is a black-box observable of the selected root. We assert:
//   * pwd with no cwd reflects the independently-known launcher-cwd project,
//   * a relative fixture read resolves inside the selected project,
//   * a captured child cwd is immutable once started (overlapping a later call),
//   * nonzero exit is reported as command DATA (not a thrown tool error),
//   * timeout/abort control on bounded disposable children,
//   * an explicit absolute cwd on B while ambient cwd is A operates on B WITHOUT
//     switching the active root for later implicit calls (labeled override control).
// No rm, no modifications outside fixtures. Explicit-cwd cases are a separately
// labeled override control and NEVER counted in detection accuracy.
// ============================================================================
import path from 'node:path';
import fs from 'node:fs';
import { realpathSafe, sleep, snapshotAll, diffManifests, expectedBoundary } from './lib.mjs';

// The tool escapes the prompt for display — backslash doubled, CR and LF as
// `\r` / `\n` — so the prompt is always exactly one line. The same escaping
// is applied to the command we look for, and undone on the cwd we read back,
// so a working directory whose name holds a backslash or a line break still
// compares equal to the real path.
const escapePrompt = (v) => v.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
const unescapePrompt = (v) => v.replace(/\\(\\|r|n)/g, (_, c) => (c === '\\' ? '\\' : c === 'r' ? '\r' : '\n'));

/**
 * Split a bash transcript by position: line 1 is the prompt `<cwd>$ <command>`,
 * the last line is the status, everything between is the command's output.
 * Returns null when line 1 is not the prompt for `command`. Checks on what the
 * command printed must look at `body` only — the prompt carries the cwd path,
 * and a path can contain any text a body check is looking for.
 */
export function parseTranscript(text, command) {
  const lines = (text || '').split('\n');
  const esc = escapePrompt(command).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^(.*)\\$ ${esc}$`).exec(lines[0] ?? '');
  if (!m) return null;
  return {
    cwd: unescapePrompt(m[1]),
    body: lines.slice(1, -1).join('\n'),
    status: lines.length > 1 ? lines[lines.length - 1] : '',
  };
}

export async function runBashSuite(server, F, rec, cov, ctx) {
  const T = 'bash';
  const transport = server.kind;
  const inst = ctx.serverInstance;

  const invoke = async (stepCtx, command, opts = {}) => {
    const before = snapshotAll(F);
    const r = await server.callTool(T, { command, ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(opts.timeout ? { timeout: opts.timeout } : {}) }, opts.timeoutMs);
    const after = snapshotAll(F);
    const effects = diffManifests(before, after);

    const parsed = r.text ? parseTranscript(r.text, command) : null;
    const observed = parsed ? parsed.cwd : null;
    const isOverride = !!opts.cwd;
    // Expected active root: from the launcher cwd we set (detection), unless override.
    const expectedRoot = isOverride ? null : stepCtx.expectedActiveRoot;
    // Expected target (the dir the command ran in): override ? realpath(override) : expectedRoot
    const expectedTarget = isOverride ? realpathSafe(opts.cwd) : stepCtx.expectedActiveRoot;

    let status = 'correct';
    let reason = '';
    if (!r.ok && (r.rpcError || r.transportError)) { status = 'harness-error'; reason = 'transport/rpc error'; }
    else if (!r.isError && observed === null) {
      // The prompt is where the active root is read from; a transcript whose
      // first line is not `<cwd>$ <command>` proves nothing and must not be
      // recorded under the default status.
      status = 'harness-error'; reason = `prompt line not parseable: ${JSON.stringify((r.text || '').split('\n')[0].slice(0, 160))}`;
    }
    else if (opts.expectError) {
      // a tool-level throw surfaces as isError content
      if (r.isError) { status = 'ok'; reason = 'expected tool error surfaced'; }
      else { status = 'operation-error'; reason = 'expected error but call succeeded'; }
    } else if (r.isError) { status = 'operation-error'; reason = 'unexpected tool error: ' + (r.text || '').slice(0, 120); }
    else if (!isOverride && observed && expectedRoot && realpathSafe(observed) !== realpathSafe(expectedRoot)) {
      status = 'wrong-root'; reason = `prompt cwd ${observed} != expected ${expectedRoot}`;
    } else if (opts.expectText && !(parsed ? parsed.body : '').includes(opts.expectText)) {
      // the body — not the prompt, whose path may contain the text — identifies
      // the project the command really ran in
      status = 'wrong-root'; reason = `body lacks "${opts.expectText}"`;
    } else if (opts.expectTranscript && !opts.expectTranscript(r.text || '')) {
      // breadth cases: the transcript shape (status line, merged stderr, ANSI
      // stripping, timeout line) is the behaviour under test, not just the cwd
      status = 'operation-error'; reason = `transcript mismatch: ${JSON.stringify((r.text || '').slice(-160))}`;
    } else if (!isOverride && observed && expectedRoot) {
      status = 'correct'; reason = 'prompt cwd matches expected active root';
    } else if (isOverride) {
      status = 'ok'; reason = 'explicit-cwd override control (not counted in detection accuracy)';
    }

    const labels = [];
    if (isOverride) labels.push('override-control');
    if (opts.labels) labels.push(...opts.labels);

    rec.record({
      tool: T, mode: opts.mode ?? 'run', transport, serverInstance: inst,
      phase: stepCtx.phase, transitionKind: isOverride ? 'absolute-override' : stepCtx.kind,
      latencyMs: r.latencyMs, launcherCwd: stepCtx.launcherCwd, serverProcCwd: server.serverProcCwd(),
      evidenceTopology: server.kind === 'http' ? 'local-ancestry' : 'stdio-parent',
      expectedActiveRoot: expectedRoot, observedActiveRoot: observed,
      activeRootObservable: !isOverride && observed != null,
      expectedTarget, actualTarget: observed,
      fsEffects: effects, crossProjectMutation: effects.some(e => e.project !== stepCtx.proj) ? true : false,
      status, assertionReason: reason, request: { command, ...(opts.cwd ? { cwd: opts.cwd } : {}) },
      resultText: r.text, rpcError: r.rpcError ?? null, transportError: r.transportError ?? null, labels,
    });
    cov.observe(T, transport, rec.records[rec.records.length - 1]);
    return r;
  };

  // ---- Detection-following core: one pwd + one relative read per step -------
  // (driven by the transition sequence)
  await ctx.driveTransitions(async (stepCtx) => {
    cov.planned(T, transport, 2);
    // pwd without cwd — target is the active binding
    await invoke(stepCtx, 'pwd');
    // relative fixture read WITHOUT cwd: `cat marker.txt` resolves in the
    // selected project. The file content uniquely identifies the project.
    const expectText = stepCtx.expectedActiveRoot ? `hello from ${path.basename(stepCtx.expectedActiveRoot)}` : undefined;
    await invoke(stepCtx, 'cat marker.txt', { mode: 'relative-read', expectText });
  });

  // ---- Immutable captured cwd: a started child overlaps a later call --------
  // The transition walk ends parked on A (final return), so the active root is A
  // here (no explicit-cwd override has run yet). Start a long-running child that
  // records its OWN cwd at spawn, then issue a quick call after chdir to B; the
  // long child's captured cwd must still be A (immutable post-spawn) while the
  // later invocation follows the new binding.
  const A0 = { proj: 'A', kind: 'stable', index: 99, phase: 'A#pre-breadth', dir: F.A, realDir: F.real.A, expectedActiveRoot: expectedBoundary(F.A), launcherCwd: F.A };
  process.chdir(F.A);
  cov.planned(T, transport, 3);
  const longCmd = `pwd > ${path.join(F.A, 'long-cwd.txt')}; sleep 2; echo long-done`;
  const longPromise = invoke({ ...A0, phase: 'A#long-start', kind: 'stable' }, longCmd, { mode: 'immutable-cwd', labels: ['overlap'], timeoutMs: 15000 });
  await sleep(200);
  process.chdir(F.B);
  await invoke({ proj: 'B', kind: 'immediate', index: 101, phase: 'B#overlap', dir: F.B, realDir: F.real.B, expectedActiveRoot: expectedBoundary(F.B), launcherCwd: process.cwd() }, 'pwd', { mode: 'overlap-later', labels: ['overlap'] });
  await longPromise;
  let captured = null;
  try { captured = fs.readFileSync(path.join(F.A, 'long-cwd.txt'), 'utf8').trim(); } catch {}
  rec.record({
    tool: T, mode: 'immutable-cwd-verify', transport, serverInstance: inst, phase: 'A#long-verify', transitionKind: 'stable',
    launcherCwd: process.cwd(), serverProcCwd: server.serverProcCwd(), evidenceTopology: server.kind === 'http' ? 'local-ancestry' : 'stdio-parent',
    expectedActiveRoot: expectedBoundary(F.A), observedActiveRoot: captured, activeRootObservable: true,
    expectedTarget: F.real.A, actualTarget: captured,
    fsEffects: [], crossProjectMutation: false,
    status: captured && realpathSafe(captured) === F.real.A ? 'correct' : 'wrong-root',
    assertionReason: 'long-running child captured its spawn-time cwd (must be A even after a later call under B)',
    request: { command: longCmd }, labels: ['overlap', 'immutable-cwd'],
  });
  cov.observe(T, transport, rec.records[rec.records.length - 1]);

  // ---- bash breadth cases (run while parked in A) ---------------------------
  const A = { proj: 'A', kind: 'stable', index: 100, phase: 'A#breadth', dir: F.A, realDir: F.real.A, expectedActiveRoot: expectedBoundary(F.A), launcherCwd: F.A };
  process.chdir(F.A);
  // Re-establish the ambient cwd as A with an implicit call so the breadth cases
  // start from a known binding (the overlap test left the parent in B).
  await invoke(A, 'pwd', { mode: 'reestablish', labels: ['setup'] });

  const breadth = [];
  const plan = (n, fn) => { cov.planned(T, transport, n); return fn; };

  // 1. nonzero exit reported as DATA (grep no-match → exit 1), not a tool throw
  breadth.push(plan(1, () => invoke(A, 'grep -q ZZZ marker.txt; echo done', { mode: 'nonzero-data', labels: ['exit-code-data'] })));
  // 2. exit 3 surfaces as data
  breadth.push(plan(1, () => invoke(A, 'exit 3', { mode: 'nonzero-data', labels: ['exit-code-data'], expectTranscript: (t) => t.endsWith('[exit code 3]') })));
  // 3. stderr merged into the transcript (a whole `err` line, not the prompt's echo)
  breadth.push(plan(1, () => invoke(A, 'echo out; echo err 1>&2', { mode: 'merge', expectTranscript: (t) => /^err$/m.test(t) })));
  // 4. ANSI stripped (red escape): a bare `red` line and no ESC byte anywhere
  breadth.push(plan(1, () => invoke(A, "printf '\\033[31mred\\033[0m\\n'", { mode: 'ansi-strip', expectTranscript: (t) => /^red$/m.test(t) && !t.includes('\u001b') })));
  // 5. relative nested read from a subdirectory of the selected project
  breadth.push(plan(1, () => invoke(A, 'cat src/a.js | head -1', { mode: 'relative-read-nested' })));
  // 6. a write INSIDE the fixture via bash redirect (allowed; inside fixtures)
  breadth.push(plan(1, () => invoke(A, "printf 'bash-wrote-A\\n' > bash-out.txt; cat bash-out.txt", { mode: 'write-in-fixture', labels: ['writes-in-fixture'] })));
  // 7. meaningful error: missing explicit cwd (override control, error path)
  breadth.push(plan(1, () => invoke(A, 'pwd', { cwd: path.join(F.A, 'no-such-dir'), mode: 'bad-cwd', expectError: true, labels: ['error-path'] })));
  // 8. meaningful error: explicit cwd that is a file, not a dir
  breadth.push(plan(1, () => invoke(A, 'pwd', { cwd: path.join(F.A, 'marker.txt'), mode: 'cwd-not-dir', expectError: true, labels: ['error-path'] })));
  // 9. recovery: after the bad-cwd error, a normal implicit pwd still works
  breadth.push(plan(1, () => invoke(A, 'pwd', { mode: 'recovery', labels: ['recovery'] })));
  // 10. timeout control: bounded disposable child killed after 1s
  breadth.push(plan(1, () => invoke(A, 'echo start; sleep 30', { timeout: 1, mode: 'timeout', labels: ['timeout-control'], timeoutMs: 20000, expectTranscript: (t) => t.endsWith('[timed out after 1s; process group killed]') })));
  // 11. symlinked alias path: run pwd with explicit cwd = beta-link (realpath → B)
  breadth.push(plan(1, () => invoke(A, 'pwd', { cwd: F.betaAlias, mode: 'symlink-alias', labels: ['symlink'] })));
  // 12. space-dir project: explicit cwd into the space project (realpath has space)
  breadth.push(plan(1, () => invoke(A, 'pwd', { cwd: F.S, mode: 'space-dir', labels: ['spaces'] })));

  await Promise.all([]); // (breadth is sequential below)
  for (const b of breadth) await b();
}

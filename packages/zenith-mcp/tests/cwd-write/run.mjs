// ============================================================================
// cwd-write mutation-test suite — main orchestrator.
//
// Usage:
//   node run.mjs --repo-root <repo> --out-dir <dir> [--repetitions 3]
//     [--transports stdio,http] [--base <dir>] [--home-base <dir>] [--fixtures-base <dir>]
// Servers are spawned with $ZENITH_NODE if set, else this process's Node.
//
// The SAME suite runs against the frozen baseline and the final patched build
// by passing a different --repo-root. All state (fixtures, isolated HOMEs,
// outputs) lives under caller-chosen directories; nothing touches production
// source, real HOME, or other worktrees.
//
// Structure per (transport, repetition):
//   * fresh fixtures + fresh isolated HOME (fresh HTTP token),
//   * launch ONE long-running server as a child of THIS process,
//   * for each owned tool, drive A->B->A->C->B->A (chdir of THIS parent) plus
//     tool-specific breadth, capturing ground truth + fs manifests per call,
//   * then the cross-cutting cases (two concurrent servers, same-server batch,
//     independent HTTP-client control for the http transport).
// Outputs: <out-dir>/<label>.events.jsonl + <out-dir>/<label>.summary.json.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  buildFixtures, makeIsolatedHome, snapshotAll, diffManifests, expectedBoundary,
  realpathSafe, NODE_BIN,
} from './lib.mjs';
import { makeServer } from './server.mjs';
import { Recorder, Coverage } from './report.mjs';
import { driveTransitions } from './transitions.mjs';
import { runBashSuite, parseTranscript } from './suite-bash.mjs';
import { runWriteFileSuite } from './suite-writefile.mjs';
import { runEditFileSuite } from './suite-editfile.mjs';
import { runFileManagerSuite } from './suite-filemanager.mjs';
import { runStashSuite } from './suite-stash.mjs';
import { runRefactorSuite } from './suite-refactor.mjs';

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(argv[i]);
    if (m) {
      if (m[2] !== undefined) { a[m[1]] = m[2]; }
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { a[m[1]] = argv[++i]; }
      else { a[m[1]] = true; }
    }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const REPO_ROOT = args['repo-root'];
const OUT_DIR = args['out-dir'];
const REPETITIONS = Math.max(1, parseInt(args['repetitions'] ?? '3', 10));
const TRANSPORTS = String(args['transports'] ?? 'stdio,http').split(',').map(s => s.trim()).filter(Boolean);

if (!REPO_ROOT || !OUT_DIR) {
  console.error('required: --repo-root <repo> --out-dir <dir>');
  process.exit(2);
}
if (!fs.existsSync(path.join(REPO_ROOT, 'packages/zenith-mcp/dist/cli/stdio.js'))) {
  console.error('repo-root has no built dist/cli/stdio.js: ' + REPO_ROOT);
  process.exit(2);
}
// Isolated HOMEs and fixtures live under --base (default <out-dir>/base): a
// caller-chosen directory, created here, never a fixed machine path.
const BASE = path.resolve(args['base'] ?? path.join(OUT_DIR, 'base'));
const HOME_BASE = args['home-base'] ?? path.join(BASE, 'home');
const FIX_BASE = args['fixtures-base'] ?? path.join(BASE, 'fixtures-run');
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(BASE, { recursive: true });

const globalRecord = {
  repoRoot: REPO_ROOT,
  outDir: OUT_DIR,
  repetitions: REPETITIONS,
  transports: TRANSPORTS,
  startedAt: new Date().toISOString(),
  runs: [],
};

async function runOneServer(transport, rep) {
  const label = `${transport}-rep${rep}`;
  const home = path.join(HOME_BASE, `${label}`);
  const fixRoot = path.join(FIX_BASE, `${label}`);
  const token = 'flint-' + crypto.randomBytes(16).toString('hex');
  // Alpha is registered on every run so the refactor persistence-consent case
  // has a registered fixture; detection cases still use B/C unregistered.
  const projects = [{ id: 'alpha', root: path.join(fixRoot, 'proj-alpha'), name: 'Alpha' }];
  makeIsolatedHome(home, { port: 0, projects });
  const F = buildFixtures(fixRoot);

  const rec = new Recorder(OUT_DIR, label);
  const cov = new Coverage();
  // Launch the server with THIS process parked in fixture A (ancestor[0] = A).
  process.chdir(F.A);
  const server = makeServer(transport, REPO_ROOT, { home, cwd: F.A, token });
  const serverInstance = `${label}-pid`;
  await server.start();
  const serverInstanceId = `${serverInstance}:${server.pid}`;

  // sanity: capture the 12 registered tools on this transport
  try {
    const list = await server.rpc('tools/list', {});
    const names = (list.result?.tools ?? list.rpc?.result?.tools ?? []).map(t => t.name);
    rec.record({ tool: '(server)', mode: 'tools/list', transport, serverInstance: serverInstanceId,
      phase: 'boot', transitionKind: 'first', launcherCwd: process.cwd(), serverProcCwd: server.serverProcCwd(),
      evidenceTopology: transport === 'http' ? 'local-ancestry' : 'stdio-parent',
      status: names.length === 12 ? 'ok' : 'operation-error',
      assertionReason: `tools/list returned ${names.length} tools`,
      resultText: JSON.stringify(names), labels: ['bootstrap', 'tools-list'] });
  } catch (e) {
    rec.record({ tool: '(server)', mode: 'tools/list', transport, serverInstance: serverInstanceId, phase: 'boot',
      status: 'harness-error', assertionReason: 'tools/list failed: ' + e.message, labels: ['bootstrap'] });
  }

  // The driver each suite uses: drives the real transition sequence (chdir of
  // THIS parent + waits) and invokes the suite's per-step handler.
  const drive = async (onStep) => driveTransitions(F, onStep);

  const suiteCtx = {
    serverInstance: serverInstanceId,
    driveTransitions: drive,
    registeredProject: 'A',
  };

  // Run the six owned-tool suites against this ONE long-running server.
  const suites = [
    ['bash', runBashSuite],
    ['write_file', runWriteFileSuite],
    ['edit_file', runEditFileSuite],
    ['file_manager', runFileManagerSuite],
    ['stashRestore', runStashSuite],
    ['refactor_batch', runRefactorSuite],
  ];
  for (const [name, fn] of suites) {
    process.chdir(F.A); // park in A before each suite's own transition walk
    try {
      await fn(server, F, rec, cov, suiteCtx);
    } catch (e) {
      rec.record({ tool: name, mode: '(suite)', transport, serverInstance: serverInstanceId, phase: 'suite',
        status: 'harness-error', assertionReason: 'suite threw: ' + (e && e.message), launcherCwd: process.cwd(),
        serverProcCwd: server.serverProcCwd(), labels: ['suite-error'] });
      cov.observe(name, transport, rec.records[rec.records.length - 1]);
    }
  }

  // ---- Cross-cutting case 1: same-server concurrent batch ------------------
  // A batch of concurrent write_file calls to DISTINCT absolute targets in the
  // currently-active project. (We do NOT claim two simultaneous different
  // implicit-cwd requests are separable — see TEST-PLAN for the source limit.)
  process.chdir(F.A);
  {
    const before = snapshotAll(F);
    const batch = await Promise.all([0, 1, 2, 3].map(i =>
      server.callTool('write_file', { path: path.join(F.A, `conc-${i}.txt`), content: `conc-A-${i}\n` })
    ));
    const after = snapshotAll(F);
    const effects = diffManifests(before, after);
    const allOk = batch.every(r => r.ok) && [0, 1, 2, 3].every(i => {
      try { return fs.readFileSync(path.join(F.A, `conc-${i}.txt`), 'utf8') === `conc-A-${i}\n`; } catch { return false; }
    });
    rec.record({ tool: 'write_file', mode: 'write', transport, serverInstance: serverInstanceId,
      phase: 'A#concurrent-batch', transitionKind: 'concurrent', launcherCwd: process.cwd(), serverProcCwd: server.serverProcCwd(),
      evidenceTopology: transport === 'http' ? 'local-ancestry' : 'stdio-parent',
      expectedActiveRoot: expectedBoundary(F.A), observedActiveRoot: null, activeRootObservable: false,
      expectedTarget: path.join(F.A, 'conc-0..3.txt'), actualTarget: allOk ? path.join(F.A, 'conc-0..3.txt') : '(mismatch)',
      fsEffects: effects, crossProjectMutation: effects.some(e => e.project !== 'A'),
      status: allOk ? 'correct' : 'operation-error',
      assertionReason: 'same-server concurrent batch of 4 distinct absolute writes all landed with exact content',
      labels: ['concurrent', 'same-server-batch'] });
    cov.planned('write_file', transport, 1);
    cov.observe('write_file', transport, rec.records[rec.records.length - 1]);
  }

  await server.stop();
  rec.close();
  return { label, transport, rep, coverage: cov.summary(), eventsPath: rec.eventsPath, serverStderr: server.stderr };
}

// ---- Cross-cutting case 2: two independently launched servers concurrently --
// Two servers (separate processes, separate isolated HOMEs), each driven by
// THIS parent parked in a DIFFERENT fixture. Asserts each server's implicit
// bash pwd reflects ITS OWN launch ancestry, independently.
async function runTwoServerIsolation(transport, rep) {
  const label = `${transport}-rep${rep}-twoserver`;
  const rec = new Recorder(OUT_DIR, label);
  const cov = new Coverage();
  const homeA = path.join(HOME_BASE, `${label}-A`);
  const homeB = path.join(HOME_BASE, `${label}-B`);
  const fixA = path.join(FIX_BASE, `${label}-A`);
  const fixB = path.join(FIX_BASE, `${label}-B`);
  const FA = buildFixtures(fixA); // has its own proj-alpha etc.
  const FB = buildFixtures(fixB);
  makeIsolatedHome(homeA, { port: 0 });
  makeIsolatedHome(homeB, { port: 0 });
  const tokenA = 'flint-' + crypto.randomBytes(16).toString('hex');
  const tokenB = 'flint-' + crypto.randomBytes(16).toString('hex');

  // Launch server A with this parent in FA/proj-alpha; server B in FB/proj-beta.
  process.chdir(FA.A);
  const sA = makeServer(transport, REPO_ROOT, { home: homeA, cwd: FA.A, token: tokenA });
  await sA.start();
  process.chdir(FB.B);
  const sB = makeServer(transport, REPO_ROOT, { home: homeB, cwd: FB.B, token: tokenB });
  await sB.start();

  // For stdio each server is a separate child; the cwd evidence each sees is its
  // OWN parent's cwd at launch. But this single process is the parent of BOTH —
  // and it can only have one cwd at a time. So for stdio we rely on each server
  // having been spawned while this parent was parked in the respective fixture,
  // then we keep the parent cwd fixed and read each server's first detection.
  // For HTTP the same holds: each server's ancestry is this parent.
  // We capture each server's implicit bash pwd (no cwd) — its first-detection.
  process.chdir(FA.A); // park parent in A
  const rA = await sA.callTool('bash', { command: 'pwd' });
  const promptA = parseTranscript(rA.text, 'pwd')?.cwd ?? null;
  process.chdir(FB.B);
  const rB = await sB.callTool('bash', { command: 'pwd' });
  const promptB = parseTranscript(rB.text, 'pwd')?.cwd ?? null;

  rec.record({ tool: 'bash', mode: 'run', transport, serverInstance: `twoserver-A:${sA.pid}`, phase: 'two-server-A',
    transitionKind: 'concurrent', launcherCwd: realpathSafe(FA.A), serverProcCwd: sA.serverProcCwd(),
    evidenceTopology: transport === 'http' ? 'local-ancestry' : 'stdio-parent',
    expectedActiveRoot: expectedBoundary(FA.A), observedActiveRoot: promptA, activeRootObservable: true,
    expectedTarget: expectedBoundary(FA.A), actualTarget: promptA,
    status: promptA === expectedBoundary(FA.A) ? 'correct' : 'wrong-root',
    assertionReason: 'independent server A first-detection reflects its own launch ancestry (fixture A)',
    labels: ['concurrent', 'two-server', 'independent-instance'] });
  cov.planned('bash', transport, 1); cov.observe('bash', transport, rec.records[rec.records.length - 1]);
  rec.record({ tool: 'bash', mode: 'run', transport, serverInstance: `twoserver-B:${sB.pid}`, phase: 'two-server-B',
    transitionKind: 'concurrent', launcherCwd: realpathSafe(FB.B), serverProcCwd: sB.serverProcCwd(),
    evidenceTopology: transport === 'http' ? 'local-ancestry' : 'stdio-parent',
    expectedActiveRoot: expectedBoundary(FB.B), observedActiveRoot: promptB, activeRootObservable: true,
    expectedTarget: expectedBoundary(FB.B), actualTarget: promptB,
    status: promptB === expectedBoundary(FB.B) ? 'correct' : 'wrong-root',
    assertionReason: 'independent server B first-detection reflects its own launch ancestry (fixture B)',
    labels: ['concurrent', 'two-server', 'independent-instance'] });
  cov.planned('bash', transport, 1); cov.observe('bash', transport, rec.records[rec.records.length - 1]);

  await sA.stop(); await sB.stop();
  rec.close();
  return { label, coverage: cov.summary(), eventsPath: rec.eventsPath };
}

// ---- Cross-cutting case 3 (HTTP only): independent HTTP-client control ------
// A separate requester PROCESS whose cwd differs from the server's fixed launch
// ancestry. Over this stateless HTTP transport there is NO requester-cwd signal
// (the SDK's per-call extra carries only an AbortSignal; no roots). We honestly
// record that the requester cwd is NOT server evidence: the server keeps its
// launch-ancestry root regardless of the requester's cwd.
async function runIndependentHttpClient(rep) {
  const label = `http-rep${rep}-independent-client`;
  const rec = new Recorder(OUT_DIR, label);
  const cov = new Coverage();
  const home = path.join(HOME_BASE, label);
  const fixRoot = path.join(FIX_BASE, label);
  makeIsolatedHome(home, { port: 0 });
  const F = buildFixtures(fixRoot);
  const token = 'flint-' + crypto.randomBytes(16).toString('hex');
  // Server launched with this parent in A (its ancestry = A).
  process.chdir(F.A);
  const server = makeServer('http', REPO_ROOT, { home, cwd: F.A, token });
  await server.start();

  // The independent requester is a SEPARATE node process spawned with cwd=C.
  // It is NOT a server ancestor. It sends bash pwd with no cwd. The server must
  // answer with its OWN ancestry root (A), proving the requester's cwd (C) is
  // not consulted over this transport.
  const requesterSrc = `
    const token = process.env.TKN; const base = process.env.BASE;
    (async () => {
      const r = await fetch(base + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + token, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bash', arguments: { command: 'pwd' } } }) });
      const ct = r.headers.get('content-type') ?? ''; const t = await r.text();
      let rpc; if (ct.includes('text/event-stream')) { const dl = t.split('\\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).filter(Boolean); rpc = JSON.parse(dl[dl.length-1]); } else rpc = JSON.parse(t);
      console.log('REQUESTER_CWD=' + process.cwd());
      console.log('RESULT=' + JSON.stringify(rpc.result?.content?.[0]?.text ?? null));
    })().catch(e => { console.error('ERR', e.message); process.exit(1); });
  `;
  const reqFile = path.join(fixRoot, 'requester.mjs');
  fs.writeFileSync(reqFile, requesterSrc);
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync(NODE_BIN, [reqFile], {
    cwd: F.C, // the requester runs in fixture C — NOT a server ancestor
    env: { PATH: '/usr/bin:/bin', HOME: home, TKN: token, BASE: server.base, CI: '1', NO_COLOR: '1' },
    encoding: 'utf8', timeout: 20000,
  });
  const outText = res.stdout || '';
  // The requester prints RESULT=<JSON string of the transcript>. Parse once to
  // get the transcript text, then read the cwd off its prompt line.
  let observed = null;
  const m2 = /RESULT=("[\s\S]*?")\s*$/.exec(outText.trim());
  if (m2) {
    try { const transcript = JSON.parse(m2[1]); observed = typeof transcript === 'string' ? (parseTranscript(transcript, 'pwd')?.cwd ?? null) : null; }
    catch { observed = null; }
  }
  // A requester failure leaves `observed` null; the record below marks that
  // harness-error via status.
  const serverRoot = expectedBoundary(F.A);
  const requesterCwd = realpathSafe(F.C);

  rec.record({ tool: 'bash', mode: 'run', transport: 'http', serverInstance: `independent-client:${server.pid}`,
    phase: 'independent-http-client', transitionKind: 'independent-http-client',
    launcherCwd: requesterCwd, serverProcCwd: server.serverProcCwd(),
    evidenceTopology: 'independent-http-client',
    expectedActiveRoot: serverRoot, observedActiveRoot: observed, activeRootObservable: observed != null,
    expectedTarget: serverRoot, actualTarget: observed,
    status: observed === serverRoot ? 'correct' : (observed == null ? 'harness-error' : 'wrong-root'),
    assertionReason: `independent HTTP requester cwd=${requesterCwd} is NOT a server ancestor; server kept its launch-ancestry root ${serverRoot} (no requester-cwd signal exists over stateless HTTP)`,
    request: { command: 'pwd' }, resultText: observed, labels: ['independent-http-client', 'control', 'source-limit'] });
  cov.planned('bash', 'http', 1); cov.observe('bash', 'http', rec.records[rec.records.length - 1]);

  await server.stop();
  rec.close();
  return { label, coverage: cov.summary(), eventsPath: rec.eventsPath };
}

(async () => {
  for (const transport of TRANSPORTS) {
    for (let rep = 0; rep < REPETITIONS; rep++) {
      const r = await runOneServer(transport, rep);
      globalRecord.runs.push({ label: r.label, eventsPath: r.eventsPath, coverage: r.coverage });
      const iso = await runTwoServerIsolation(transport, rep);
      globalRecord.runs.push({ label: iso.label, eventsPath: iso.eventsPath, coverage: iso.coverage });
      if (transport === 'http') {
        const ind = await runIndependentHttpClient(rep);
        globalRecord.runs.push({ label: ind.label, eventsPath: ind.eventsPath, coverage: ind.coverage });
      }
      // fresh fixtures next repetition
    }
  }
  globalRecord.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(OUT_DIR, 'run-index.json'), JSON.stringify(globalRecord, null, 1));
  console.log('RUN_INDEX=' + path.join(OUT_DIR, 'run-index.json'));
  console.log('RUNS=' + globalRecord.runs.length);
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });

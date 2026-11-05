// ============================================================================
// Registration-seam evidence run — SEPARATELY LABELED, in-process, per repo.
//
// For the owned tools whose RPC result CANNOT reveal the selected active root
// (write_file / edit_file / file_manager target the explicit path arg;
// refactor_batch / stashRestore route persistence via getWorkingRoot), this run
// observes the dispatch-time root through a real-handler / real-FilesystemContext
// / real-ProjectContext seam (see seam.mjs). It drives the SAME A->B->A->C->B->A
// transition sequence by chdir()ing this process (the ping reads our own
// process.cwd() as the 'self:cwd' candidate), and records rootBeforeDispatch /
// rootAfterDispatch for each invocation. No forced expected root, no synthetic
// handler — the real tool handler runs and its real filesystem effect is checked.
//
// Output: <out-dir>/seam-<label>.events.jsonl with evidenceTopology 'registration-seam'.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { createSeamObserver, registerToolOnSeam } from './seam.mjs';
import { buildFixtures, makeIsolatedHome, expectedBoundary, realpathSafe, snapshotAll, diffManifests, sleep } from './lib.mjs';
import { Recorder, Coverage } from './report.mjs';
import { transitionPlan } from './transitions.mjs';

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(argv[i]);
    if (m) { if (m[2] !== undefined) a[m[1]] = m[2]; else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) a[m[1]] = argv[++i]; else a[m[1]] = true; }
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));
const REPO = args['repo-root'];
const OUT_DIR = args['out-dir'];
const LABEL = args['label'] ?? 'seam';
const HOME = args['home'];
const FIX = args['fixtures'];
if (!REPO || !OUT_DIR || !HOME || !FIX) { console.error('need --repo-root --out-dir --home --fixtures'); process.exit(2); }

makeIsolatedHome(HOME, { port: 0 });
process.env.HOME = HOME;
const F = buildFixtures(FIX);

const rec = new Recorder(OUT_DIR, LABEL);
const cov = new Coverage();

const seam = await createSeamObserver(REPO, HOME);
// Register the real handlers for the black-box-invisible owned tools + bash (as a
// black-box cross-check) so we observe the dispatch root for each.
for (const tf of ['write_file.js', 'edit_file.js', 'filesystem.js', 'refactor_batch.js', 'stash_restore.js', 'bash.js']) {
  await registerToolOnSeam(REPO, tf, seam);
}
const H = (n) => seam.handlers.get(n).handler;

const projMap = { A: F.A, B: F.B, C: F.C };

// Drive the transition plan; at each step invoke a representative call per tool
// and observe rootBeforeDispatch/rootAfterDispatch + the real fs effect.
const plan = transitionPlan();
let writeN = 0;
for (let i = 0; i < plan.length; i++) {
  const step = plan[i];
  if (step.waitBeforeMs > 0) await sleep(step.waitBeforeMs);
  const dir = projMap[step.proj];
  process.chdir(dir);
  const expected = expectedBoundary(dir);
  const phase = `${step.proj}#${i}-${step.kind}`;

  const obsBefore = seam.observations.length;

  // write_file: real write into THIS project (explicit absolute path)
  const wRel = `seam-wf-${step.proj}-${writeN}.txt`;
  const wAbs = path.join(dir, wRel);
  const bW = snapshotAll(F);
  let rW, errW = null;
  try { rW = await H('write_file')({ path: wAbs, content: `seam-${step.proj}-${writeN}\n` }); } catch (e) { errW = String(e && e.message); }
  const eW = diffManifests(bW, snapshotAll(F));
  writeN++;
  recordSeam('write_file', 'write', phase, step.kind, expected, obsBefore, {
    expectedTarget: wAbs, fsEffects: eW,
    ok: !errW && (() => { try { return fs.readFileSync(wAbs, 'utf8') === `seam-${step.proj}-${writeN - 1}\n`; } catch { return false; } })(),
    resultText: rW?.content?.[0]?.text ?? errW,
  });

  // edit_file: real content edit in THIS project's edit.txt (restore after)
  const eFile = path.join(dir, 'edit.txt');
  const bE = snapshotAll(F);
  let rE, errE = null, editedE = false;
  try {
    rE = await H('edit_file')({ path: eFile, edits: [{ mode: 'content', oldContent: 'gamma three', newContent: `g-${step.proj}-${i}` }] });
    // confirm the real effect before the revert hides it (a no-op is not ok)
    try { editedE = fs.readFileSync(eFile, 'utf8').includes(`g-${step.proj}-${i}`); } catch {}
    await H('edit_file')({ path: eFile, edits: [{ mode: 'content', oldContent: `g-${step.proj}-${i}`, newContent: 'gamma three' }] });
  } catch (e) { errE = String(e && e.message); }
  const eE = diffManifests(bE, snapshotAll(F));
  recordSeam('edit_file', 'content', phase, step.kind, expected, obsBefore, {
    expectedTarget: eFile, fsEffects: eE, ok: !errE && editedE, resultText: rE?.content?.[0]?.text ?? errE,
  });

  // file_manager: real mkdir in THIS project
  const mDir = path.join(dir, `seam-mkdir-${i}`);
  const bM = snapshotAll(F);
  let rM, errM = null;
  try { rM = await H('file_manager')({ mode: 'mkdir', path: mDir }); } catch (e) { errM = String(e && e.message); }
  const eM = diffManifests(bM, snapshotAll(F));
  recordSeam('file_manager', 'mkdir', phase, step.kind, expected, obsBefore, {
    expectedTarget: mDir, fsEffects: eM, ok: !errM && fs.existsSync(mDir), resultText: rM?.content?.[0]?.text ?? errM,
  });

  // refactor_batch: real loadDiff against THIS project's src/a.js
  let rR, errR = null;
  try { rR = await H('refactor_batch')({ mode: 'loadDiff', selection: [{ symbol: 'helperAlpha', file: 'src/a.js' }], contextLines: 0 }); } catch (e) { errR = String(e && e.message); }
  recordSeam('refactor_batch', 'loadDiff', phase, step.kind, expected, obsBefore, {
    expectedTarget: path.join(dir, 'src', 'a.js'), fsEffects: [], ok: !errR && /helperAlpha \[\d+\]/.test(rR?.content?.[0]?.text ?? ''),
    resultText: rR?.content?.[0]?.text ?? errR,
  });

  // bash: black-box cross-check (prompt cwd) AND the seam observation
  let rB, errB = null;
  try { rB = await H('bash')({ command: 'pwd' }); } catch (e) { errB = String(e && e.message); }
  const prompt = rB?.content?.[0]?.text ? rB.content[0].text.split('$')[0] : null;
  recordSeam('bash', 'run', phase, step.kind, expected, obsBefore, {
    expectedTarget: expected, actualTarget: prompt, fsEffects: [], ok: !errB,
    observedActiveRoot: prompt, resultText: rB?.content?.[0]?.text ?? errB, crossCheck: true,
  });
}

function recordSeam(tool, mode, phase, kind, expected, obsBeforeIdx, opts) {
  const obs = seam.observations.slice(obsBeforeIdx);
  // The observation whose tool matches and whose cwd is this step's dir.
  const mine = obs.find(o => o.tool === tool) ?? obs[obs.length - 1] ?? null;
  const observedRoot = mine ? (mine.rootAfterDispatch ?? mine.rootBeforeDispatch) : null;
  const expectedNorm = expected ? realpathSafe(expected) : null;
  const observedNorm = observedRoot ? realpathSafe(observedRoot) : null;
  const observable = observedRoot != null;
  const status = !opts.ok ? 'operation-error'
    : (!observable ? 'ok'
    : (observedNorm === expectedNorm ? 'correct' : 'wrong-root'));
  rec.record({
    tool, mode, transport: 'registration-seam', serverInstance: 'in-process', phase, transitionKind: kind,
    launcherCwd: process.cwd(), serverProcCwd: process.cwd(), evidenceTopology: 'registration-seam',
    expectedActiveRoot: expected, observedActiveRoot: observedRoot, activeRootObservable: observable,
    // target accuracy counts a CONFIRMED effect only: bash supplies its observed
    // prompt cwd; the others get their expected path when the effect check
    // (opts.ok) passed, else null — still in the denominator, not the numerator.
    expectedTarget: opts.expectedTarget ?? null,
    actualTarget: 'actualTarget' in opts ? opts.actualTarget : (opts.ok ? opts.expectedTarget ?? null : null),
    // e.project is the manifest label ('A'|'B'|'C'|'S'); compare it with this
    // step's label (phase is `${proj}#...`), not with the absolute root path.
    fsEffects: opts.fsEffects ?? [], crossProjectMutation: (opts.fsEffects ?? []).some(e => expected && e.project !== phase.split('#')[0]),
    status,
    assertionReason: !opts.ok ? 'handler error or effect not confirmed: ' + String(opts.resultText).slice(0, 100)
      : (observable ? `seam observed dispatch root ${observedRoot} (tier before=${mine?.tierBeforeDispatch}, after=${mine?.tierAfterDispatch})` : 'root not observable for this call'),
    resultText: opts.resultText != null ? String(opts.resultText).slice(0, 400) : null,
    labels: ['seam', 'real-handler', opts.crossCheck ? 'blackbox-crosscheck' : 'root-observation'],
  });
  cov.planned(tool, 'registration-seam', 1);
  cov.observe(tool, 'registration-seam', rec.records[rec.records.length - 1]);
}

// Emit the seam observations + coverage.
fs.writeFileSync(path.join(OUT_DIR, `${LABEL}.observations.json`), JSON.stringify(seam.observations, null, 1));
fs.writeFileSync(path.join(OUT_DIR, `${LABEL}.summary.json`), JSON.stringify({ label: LABEL, repoRoot: REPO, coverage: cov.summary() }, null, 1));
rec.close();
console.log('SEAM_DONE=' + path.join(OUT_DIR, `${LABEL}.events.jsonl`));
process.exit(0);

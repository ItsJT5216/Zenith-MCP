// ============================================================================
// node:test unit checks for the cwd-write harness (review fixes on PR #108).
//
// Run:  node --test packages/zenith-mcp/tests/cwd-write/fixes-test.mjs
//
// Deliberately NOT a vitest file (no `.test.` in the name): these checks need
// no built dist and must not be collected by `pnpm test`. They import the
// harness modules that are side-effect free (lib.mjs, report.mjs, the
// suite-*.mjs generators) and drive the suites with an in-memory fake server.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFixtures, expectedBoundary } from './lib.mjs';
import { Recorder, Coverage } from './report.mjs';
import { transitionPlan } from './transitions.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Fake-server harness: runs a real suite generator against an in-memory tool
// model (`respond(name, args)` -> text | { text, isError }) over fresh fixtures,
// driving the real transition plan without its TTL waits. Each suite's
// `invoke` then classifies exactly as it would against a live server, so the
// recorded `status` per case is what we assert on.
// ---------------------------------------------------------------------------
function fakeServer(respond) {
  return {
    kind: 'stdio',
    serverProcCwd: () => process.cwd(),
    async callTool(name, args) {
      const r = await respond(name, args);
      const o = typeof r === 'string' ? { text: r } : r;
      return { ok: !o.isError, isError: !!o.isError, text: o.text ?? '', raw: {}, latencyMs: 0 };
    },
  };
}

async function driveFast(F, onStep) {
  const plan = transitionPlan();
  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    const dir = F[step.proj];
    process.chdir(dir);
    await onStep({ proj: step.proj, kind: step.kind, index: i, phase: `${step.proj}#${i}-${step.kind}`,
      dir, realDir: fs.realpathSync(dir), expectedActiveRoot: expectedBoundary(dir), launcherCwd: process.cwd() });
  }
}

async function runSuite(runFn, respond, { registeredProject = null, fixturesSubdir = 'fx' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-write-unit-'));
  const F = buildFixtures(path.join(root, fixturesSubdir));
  const rec = new Recorder(path.join(root, 'out'), 'unit');
  const cov = new Coverage();
  const cwd0 = process.cwd();
  try {
    await runFn(fakeServer(respond), F, rec, cov, { serverInstance: 'unit', driveTransitions: (onStep) => driveFast(F, onStep), registeredProject });
  } finally {
    process.chdir(cwd0);
    rec.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  return { F, rec, cov };
}

const statusesOf = (rec, pred) => rec.records.filter(pred).map(r => r.status);

// ---------------------------------------------------------------------------
// C19-a3/a4/a5/a7/a8/a9/a10 — every imported binding is referenced.
// ---------------------------------------------------------------------------
function importedBindings(src) {
  const names = [];
  const re = /^import\s+([^;]+?)\s+from\s+['"][^'"]+['"];?/gm;
  let m;
  while ((m = re.exec(src))) {
    const clause = m[1];
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) for (const part of braces[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) names.push(name);
    }
    const star = /\*\s+as\s+(\w+)/.exec(clause);
    if (star) names.push(star[1]);
    const dflt = /^(\w+)\s*(?:,|$)/.exec(clause.trim());
    if (dflt) names.push(dflt[1]);
  }
  return names;
}

function unusedImports(file) {
  const src = fs.readFileSync(file, 'utf8');
  const body = src
    .replace(/^import\s+[^;]+?\s+from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  return importedBindings(src).filter(n => !new RegExp(`\\b${n}\\b`).test(body));
}

test('cwd-write runners and cwd-index-routing.test.js import only what they use', () => {
  const files = fs.readdirSync(HERE).filter(f => f.endsWith('.mjs')).map(f => path.join(HERE, f));
  files.push(path.join(HERE, '..', 'cwd-index-routing.test.js'));
  const report = {};
  for (const f of files) {
    const unused = unusedImports(f);
    if (unused.length) report[path.relative(HERE, f)] = unused;
  }
  assert.deepEqual(report, {});
});

// ---------------------------------------------------------------------------
// C20-a4 / C21-a18 — no machine-specific Node or base paths; NODE_BIN resolves
// from $ZENITH_NODE, else the running Node, and fails clearly otherwise.
// ---------------------------------------------------------------------------
test('no cwd-write code file hard-codes an author home path', () => {
  const offenders = fs.readdirSync(HERE)
    .filter(f => /\.(mjs|py)$/.test(f))
    .filter(f => /\/home\/[a-z]+\//.test(fs.readFileSync(path.join(HERE, f), 'utf8')));
  assert.deepEqual(offenders, []);
});

test('resolveNodeBin prefers ZENITH_NODE, falls back to process.execPath, rejects a bad binary', async () => {
  const { resolveNodeBin, NODE_BIN } = await import('./lib.mjs');
  assert.equal(resolveNodeBin({}), process.execPath);
  assert.equal(resolveNodeBin({ ZENITH_NODE: process.execPath }), process.execPath);
  assert.throws(() => resolveNodeBin({ ZENITH_NODE: path.join(HERE, 'no-such-node') }), /Node binary is not executable: .*no-such-node.*ZENITH_NODE/);
  assert.equal(NODE_BIN, resolveNodeBin());
});

// ---------------------------------------------------------------------------
// C21-t1 — stash type filter: an ignored `type: 'edit'` must not pass.
// In-memory stash model: edit_file / write_file stash on failure; stashRestore
// list/read/restore/apply behave like the tool, except where `ignoreType` or
// `noWriteStash` injects the defect under test.
// ---------------------------------------------------------------------------
function stashModel({ ignoreType = false, noWriteStash = false } = {}) {
  const entries = []; let nextId = 1;
  const readF = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
  return (name, args) => {
    if (name === 'edit_file') {
      const cur = readF(args.path) ?? '';
      const e = args.edits[0];
      if (!cur.includes(e.oldContent)) {
        const id = nextId++; entries.push({ id, type: 'edit', filePath: args.path, edit: e });
        return { isError: true, text: `1 failed. stash:${id}\nNot found: ${e.oldContent}` };
      }
      fs.writeFileSync(args.path, cur.replace(e.oldContent, e.newContent));
      return 'ok';
    }
    if (name === 'write_file') {
      let isDir = false; try { isDir = fs.statSync(args.path).isDirectory(); } catch {}
      if (isDir) {
        if (noWriteStash) return { isError: true, text: 'EISDIR: illegal operation on a directory' };
        const id = nextId++; entries.push({ id, type: 'write', filePath: args.path, content: args.content });
        return { isError: true, text: `EISDIR. stash:${id}` };
      }
      fs.writeFileSync(args.path, args.content); return 'ok';
    }
    if (name !== 'stashRestore') return 'ok';
    const find = () => entries.find(x => x.id === args.stashId);
    if (args.mode === 'list') {
      let rows = [...entries].reverse();
      if (args.type && !ignoreType) rows = rows.filter(x => x.type === args.type);
      if (typeof args.range === 'number') rows = rows.slice(0, args.range);
      return rows.length ? rows.map(x => `#${x.id} [${x.type}] ${x.filePath} (attempt 1/2)`).join('\n') : 'Empty.';
    }
    const en = find();
    if (!en) return { isError: true, text: `Stash #${args.stashId} not found.` };
    if (args.mode === 'read') return en.type === 'edit' ? `[edit] ${en.filePath}\n#1 [FAILED] content` : `[write] ${en.filePath}\n${en.content}`;
    if (args.mode === 'restore') { entries.splice(entries.indexOf(en), 1); return 'Cleared.'; }
    if (args.mode === 'apply') {
      if (en.type === 'edit') {
        const cur = readF(en.filePath) ?? '';
        if (!cur.includes(en.edit.oldContent)) return { isError: true, text: '1 failed.' };
        if (args.dryRun) return `--- ${en.filePath}\n-${en.edit.oldContent}\n+${en.edit.newContent}`;
        fs.writeFileSync(en.filePath, cur.replace(en.edit.oldContent, en.edit.newContent));
      } else {
        if (args.dryRun) return `${en.content.length} bytes`;
        fs.writeFileSync(args.newPath || en.filePath, en.content);
      }
      entries.splice(entries.indexOf(en), 1); return 'Applied.';
    }
    return 'ok';
  };
}

const isTypeFilterCase = (r) => r.labels.includes('type-filter') && !r.labels.includes('setup-failure') && r.request?.type === 'edit';
const isTypeFilterSetupFailure = (r) => r.labels.includes('type-filter') && r.labels.includes('setup-failure');

test('C21-t1 control: a working type filter is recorded correct, with a passing unfiltered control', async () => {
  const { runStashSuite } = await import('./suite-stash.mjs');
  const { rec } = await runSuite(runStashSuite, stashModel());
  assert.deepEqual(statusesOf(rec, r => r.labels.includes('type-filter-control')), ['correct']);
  assert.deepEqual(statusesOf(rec, isTypeFilterCase), ['correct']);
  assert.deepEqual(statusesOf(rec, isTypeFilterSetupFailure), []);
});

test('C21-t1: a list that ignores `type` is recorded operation-error, not correct', async () => {
  const { runStashSuite } = await import('./suite-stash.mjs');
  const { rec } = await runSuite(runStashSuite, stashModel({ ignoreType: true }));
  const cases = rec.records.filter(isTypeFilterCase);
  assert.deepEqual(cases.map(r => r.status), ['operation-error']);
  assert.match(cases[0].assertionReason, /type filter ignored/);
});

test('C21-t1: without a live write stash the type-filter case is unsupported/setup-failure, not correct', async () => {
  const { runStashSuite } = await import('./suite-stash.mjs');
  const { rec } = await runSuite(runStashSuite, stashModel({ noWriteStash: true }));
  assert.deepEqual(statusesOf(rec, isTypeFilterCase), []);
  assert.deepEqual(statusesOf(rec, isTypeFilterSetupFailure), ['unsupported', 'unsupported']);
});

// ---------------------------------------------------------------------------
// C21-t2 — edit_file dryRun must return a non-empty preview.
// ---------------------------------------------------------------------------
const editModel = ({ dryRunText }) => (name, args) => {
  if (name !== 'edit_file') return 'ok';
  if (args.dryRun) return dryRunText;
  return 'ok'; // non-dryRun calls are not under test here; the file is left as is
};
const isDryRun = (r) => r.labels.includes('dry-run-control');

test('C21-t2 control: a dryRun that returns a diff and leaves the file alone is ok', async () => {
  const { runEditFileSuite } = await import('./suite-editfile.mjs');
  const { rec } = await runSuite(runEditFileSuite, editModel({ dryRunText: '--- a\n+++ b\n-delta four\n+DELTA-4' }));
  assert.deepEqual(statusesOf(rec, isDryRun), ['ok', 'ok']);
});

test('C21-t2: an empty dryRun response is operation-error even though nothing was written', async () => {
  const { runEditFileSuite } = await import('./suite-editfile.mjs');
  const { rec } = await runSuite(runEditFileSuite, editModel({ dryRunText: '' }));
  assert.deepEqual(statusesOf(rec, isDryRun), ['operation-error', 'operation-error']);
});

// ---------------------------------------------------------------------------
// C21-t3 / C21-a19 — bash: transcript content, not only the prompt cwd.
// Canned bash model shaped like the tool (`<cwd>$ <cmd>\n<body><status>`),
// with per-command overrides to inject the defect under test.
// ---------------------------------------------------------------------------
const ANSI_CMD = "printf '\\033[31mred\\033[0m\\n'";
function bashModel(overrides = {}) {
  const body = {
    'pwd': (cwd) => `${cwd}\n[exit code 0]`,
    'cat marker.txt': (cwd) => fs.readFileSync(path.join(cwd, 'marker.txt'), 'utf8') + '[exit code 0]',
    'exit 3': () => '[exit code 3]',
    'echo out; echo err 1>&2': () => 'out\nerr\n[exit code 0]',
    [ANSI_CMD]: () => 'red\n[exit code 0]',
    'echo start; sleep 30': () => 'start\n[timed out after 1s; process group killed]',
  };
  return (name, args) => {
    if (name !== 'bash') return 'ok';
    let cwd = process.cwd();
    if (args.cwd) {
      let st = null; try { st = fs.statSync(args.cwd); } catch {}
      if (!st) return { isError: true, text: `cwd does not exist: ${args.cwd}` };
      if (!st.isDirectory()) return { isError: true, text: `cwd is not a directory: ${args.cwd}` };
      cwd = fs.realpathSync(args.cwd);
    }
    // The tool shows the prompt escaped (backslash doubled, CR and LF as backslash-r / backslash-n) so it is one line.
    const shown = (v) => v.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
    const prompt = `${shown(cwd)}$ ${shown(args.command)}\n`;
    const over = overrides[args.command];
    if (over) { const o = over(cwd); if (o != null) return prompt + o; }
    return prompt + (body[args.command] ? body[args.command](cwd) : '[exit code 0]');
  };
}
const byCommand = (cmd) => (r) => r.request?.command === cmd && !r.request?.cwd;

test('C21-t3/a19 control: a tool-shaped transcript keeps every breadth and relative-read case correct', async () => {
  const { runBashSuite } = await import('./suite-bash.mjs');
  const { rec } = await runSuite(runBashSuite, bashModel());
  for (const cmd of ['exit 3', 'echo out; echo err 1>&2', ANSI_CMD, 'echo start; sleep 30']) {
    assert.deepEqual(statusesOf(rec, byCommand(cmd)), ['correct'], cmd);
  }
  assert.deepEqual(statusesOf(rec, r => r.mode === 'relative-read'), Array(10).fill('correct'));
});

test('C21-t3: a wrong status line, missing stderr, leftover ESC or wrong timeout line is operation-error', async () => {
  const { runBashSuite } = await import('./suite-bash.mjs');
  const { rec } = await runSuite(runBashSuite, bashModel({
    'exit 3': () => '[exit code 0]',
    'echo out; echo err 1>&2': () => 'out\n[exit code 0]',
    [ANSI_CMD]: () => '\u001b[31mred\u001b[0m\n[exit code 0]',
    'echo start; sleep 30': () => 'start\n[exit code 0]',
  }));
  for (const cmd of ['exit 3', 'echo out; echo err 1>&2', ANSI_CMD, 'echo start; sleep 30']) {
    const recs = rec.records.filter(byCommand(cmd));
    assert.deepEqual(recs.map(r => r.status), ['operation-error'], cmd);
    assert.match(recs[0].assertionReason, /^transcript mismatch/);
  }
});

test('bash: a transcript whose prompt line cannot be parsed is harness-error, never the default correct', async () => {
  const { runBashSuite } = await import('./suite-bash.mjs');
  // A server that shows the raw (unescaped) command on the prompt: the parser
  // finds no cwd for a command containing a backslash.
  const raw = bashModel();
  const { rec } = await runSuite(runBashSuite, (name, args) => {
    const out = raw(name, args);
    if (typeof out !== 'string' || args.command !== ANSI_CMD) return out;
    return out.replace(/^.*\$ .*\n/, (line) => line.replace(/\\\\/g, '\\'));
  });
  const recs = rec.records.filter(byCommand(ANSI_CMD));
  assert.deepEqual(recs.map(r => r.status), ['harness-error']);
  assert.match(recs[0].assertionReason, /^prompt line not parseable/);
  // every other case still parses and is judged on its merits
  assert.deepEqual(statusesOf(rec, byCommand('exit 3')), ['correct']);
});

test('bash: parseTranscript reads the cwd back unescaped and keeps the prompt and status out of the body', async () => {
  const { parseTranscript } = await import('./suite-bash.mjs');
  const shown = (v) => v.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  const cwd = '/tmp/odd\\dir/two\nlines';
  const p = parseTranscript(`${shown(cwd)}$ pwd\n${cwd}\n[exit code 0]`, 'pwd');
  assert.equal(p.cwd, cwd);
  assert.equal(p.status, '[exit code 0]');
  const q = parseTranscript('/hello from A$ cat marker.txt\ncat: marker.txt: No such file\n[exit code 1]', 'cat marker.txt');
  assert.deepEqual(q, { cwd: '/hello from A', body: 'cat: marker.txt: No such file', status: '[exit code 1]' });
  assert.equal(parseTranscript('/x$ ls\nfoo\n[exit code 0]', 'pwd'), null);
});

test('bash: a working directory with a backslash in its name is read back as the real path, not the escaped one', async () => {
  const { runBashSuite } = await import('./suite-bash.mjs');
  const { rec } = await runSuite(runBashSuite, bashModel(), { fixturesSubdir: 'back\\slash/fx' });
  // every implicit-cwd pwd and relative-read step compares the prompt cwd with the real fixture path
  const pwds = statusesOf(rec, byCommand('pwd'));
  assert.ok(pwds.length >= 10 && pwds.every(st => st === 'correct'), pwds.join(','));
  assert.deepEqual(statusesOf(rec, r => r.mode === 'relative-read'), Array(10).fill('correct'));
});

test('bash: a failed relative read is not correct just because the expected text appears in the prompt path', async () => {
  const { runBashSuite } = await import('./suite-bash.mjs');
  // The fixture path contains "hello from proj-alpha" — the text `cat marker.txt`
  // must print in project proj-alpha — so it is on every prompt line, while the
  // read itself fails with nothing useful in the body.
  const { rec } = await runSuite(runBashSuite, bashModel({
    'cat marker.txt': () => 'cat: marker.txt: No such file or directory\n[exit code 1]',
  }), { fixturesSubdir: 'hello from proj-alpha/fx' });
  const recs = rec.records.filter(r => r.mode === 'relative-read');
  assert.equal(recs.length, 10);
  assert.ok(recs.some(r => r.expectedActiveRoot.endsWith('/proj-alpha')));
  assert.ok(recs.every(r => r.status !== 'correct'), recs.map(r => r.status).join(','));
  assert.ok(recs.every(r => /^body lacks "hello from /.test(r.assertionReason)));
});

test('C21-a19: `cat marker.txt` whose body comes from another project is wrong-root despite a matching prompt cwd', async () => {
  const { runBashSuite } = await import('./suite-bash.mjs');
  const { rec } = await runSuite(runBashSuite, bashModel({
    // parked in proj-beta the prompt cwd is right, but the body is proj-alpha's marker
    'cat marker.txt': (cwd) => path.basename(cwd) === 'proj-beta' ? 'hello from proj-alpha\n[exit code 0]' : null,
  }));
  const reads = rec.records.filter(r => r.mode === 'relative-read');
  assert.equal(reads.length, 10);
  const beta = reads.filter(r => r.phase.startsWith('B#'));
  assert.equal(beta.length, 3);
  assert.deepEqual(beta.map(r => r.status), ['wrong-root', 'wrong-root', 'wrong-root']);
  assert.match(beta[0].assertionReason, /body lacks "hello from proj-beta"/);
  assert.deepEqual(reads.filter(r => !r.phase.startsWith('B#')).map(r => r.status), Array(7).fill('correct'));
});

// ---------------------------------------------------------------------------
// C21-t5 — file_manager info must return size metadata, not merely succeed.
// ---------------------------------------------------------------------------
const fmModel = ({ infoText }) => (name, args) => {
  if (name !== 'file_manager') return 'ok';
  try {
    if (args.mode === 'mkdir') { fs.mkdirSync(args.path, { recursive: true }); return 'Created.'; }
    if (args.mode === 'move') { fs.renameSync(args.source, args.destination); return 'Moved.'; }
    if (args.mode === 'delete') { if (fs.statSync(args.path).isDirectory()) throw new Error('Not a file.'); fs.unlinkSync(args.path); return 'Deleted.'; }
    if (args.mode === 'info') { const st = fs.statSync(args.path); return infoText(st); }
  } catch (e) { return { isError: true, text: e.message }; }
  return 'ok';
};
const isInfo = (r) => r.mode === 'info';

test('C21-t5 control: info with a `size:` line is correct', async () => {
  const { runFileManagerSuite } = await import('./suite-filemanager.mjs');
  const { rec } = await runSuite(runFileManagerSuite, fmModel({ infoText: (st) => `size: ${st.size}\nisFile: true` }));
  assert.deepEqual(statusesOf(rec, isInfo), Array(11).fill('correct'));
});

test('C21-t5: info that succeeds without size metadata is operation-error', async () => {
  const { runFileManagerSuite } = await import('./suite-filemanager.mjs');
  const { rec } = await runSuite(runFileManagerSuite, fmModel({ infoText: () => 'isFile: true' }));
  assert.deepEqual(statusesOf(rec, isInfo), Array(11).fill('operation-error'));
});

// ---------------------------------------------------------------------------
// C21-a20 — refactor_batch detection-target loadDiff: "No symbols loaded." is
// a failed load, never a correct one.
// ---------------------------------------------------------------------------
const refactorModel = ({ loadDiffText }) => (name, args) => {
  if (name !== 'refactor_batch') return 'ok';
  if (args.mode === 'loadDiff') return loadDiffText;
  return 'ok';
};
const isDetectionLoad = (r) => r.labels.includes('detection-target') && r.labels.includes('loadDiff');

test('C21-a20 control: a loadDiff that indexes helperAlpha is correct', async () => {
  const { runRefactorSuite } = await import('./suite-refactor.mjs');
  const { rec } = await runSuite(runRefactorSuite, refactorModel({ loadDiffText: 'helperAlpha [1]\nfunction helperAlpha() {}' }));
  assert.deepEqual(statusesOf(rec, isDetectionLoad), Array(10).fill('correct'));
});

test('C21-a20: "No symbols loaded." is operation-error and the dryRun apply is unsupported, not correct', async () => {
  const { runRefactorSuite } = await import('./suite-refactor.mjs');
  const { rec } = await runSuite(runRefactorSuite, refactorModel({ loadDiffText: 'No symbols loaded.' }));
  assert.deepEqual(statusesOf(rec, isDetectionLoad), Array(10).fill('operation-error'));
  assert.deepEqual(statusesOf(rec, r => r.mode === 'apply' && r.labels.includes('setup-failure')), Array(10).fill('unsupported'));
});

// ---------------------------------------------------------------------------
// C18-a1 — the evidence-log write is a documented, bounded sink: the record is
// a whitelisted shape (resultText truncated to 4000) and one JSON line each.
// ---------------------------------------------------------------------------
test('C18-a1: Recorder writes one escaped JSON line of a whitelisted shape and documents the sink', async () => {
  const src = fs.readFileSync(path.join(HERE, 'report.mjs'), 'utf8');
  const sink = src.indexOf("fs.writeSync(this.fd, JSON.stringify(rec) + '\\n');");
  assert.ok(sink > 0, 'the evidence-log write is still the single JSON.stringify sink');
  assert.ok(src.slice(0, sink).includes('js/http-to-file-access'), 'the sink is justified inline for CodeQL reviewers');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-write-rec-'));
  try {
    const rec = new Recorder(root, 'unit');
    const hostile = 'line1\nline2\r\n\u2028' + 'x'.repeat(5000);
    rec.record({ tool: 'bash', transport: 'http', serverInstance: 's', status: 'ok', resultText: hostile, evil: 'not-a-field' });
    rec.close();
    const lines = fs.readFileSync(path.join(root, 'unit.events.jsonl'), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'exactly one line per record even with embedded newlines');
    const back = JSON.parse(lines[0]);
    assert.equal('evil' in back, false, 'unknown keys are not written');
    assert.ok(back.resultText.length < hostile.length && back.resultText.endsWith('more]'), 'resultText is truncated');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

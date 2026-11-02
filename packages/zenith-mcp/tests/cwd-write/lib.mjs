// ============================================================================
// cwd-write mutation-test harness — shared core.
//
// This module is the controlled LAUNCHER / CLIENT-PARENT for the server under
// test. It owns no production code and no competing project resolver. It:
//   * builds fresh, independently-labeled fixture projects (A/B/C) on disk,
//   * launches dist/cli/stdio.js or dist/server/http.js as a CHILD of this
//     process (so this process's cwd is the server's ancestor[0] cwd — the
//     kernel-recorded detection evidence, readable at /proc/<serverPid>/..
//     via the server's own /proc/<pid> and our own /proc/self/cwd),
//   * drives project transitions by chdir()ing ITSELF (the parent) between
//     calls — mutating the test launcher cwd is permitted; we never touch the
//     server's process.cwd as a "solution",
//   * speaks raw newline-delimited JSON-RPC (stdio) or POST /mcp (HTTP 2026-07
//     -28 stateless framing, bearer auth), capturing exact request/result,
//   * snapshots before/after filesystem manifests of the fixtures,
//   * and records every invocation as a JSONL evidence record.
//
// Ground truth is INDEPENDENT: the expected active root is derived from the
// launcher cwd we set (resolved to its realpath + its detected boundary by
// walking for .git / markers ourselves), never from the server's answer.
// ============================================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';

export const NODE_BIN = '/home/tanner/Projects/Zenith-Worktrees/bash/tooling/node-v26.3.0-linux-x64/bin/node';

// The marker set mirrors core/detection/boundaries.ts PROJECT_MARKERS — used
// ONLY to compute the independent expected boundary for a fixture dir, never
// to influence the server.
const MARKERS = ['.git','package.json','Cargo.toml','pyproject.toml','setup.py','requirements.txt','go.mod','pom.xml','build.gradle','build.gradle.kts','composer.json','Gemfile','mix.exs','stack.yaml','CMakeLists.txt','deno.json'];

export function realpathSafe(p) { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }

// Independent expected project boundary for a directory: nearest ancestor (or
// self) holding a marker, stopping at fs root / home. Mirrors the documented
// detection shape so our EXPECTATION is computed without the server.
export function expectedBoundary(startDir) {
  let dir = realpathSafe(startDir);
  const home = realpathSafe(process.env.HOME || '/nonexistent');
  const root = path.parse(dir).root;
  while (true) {
    for (const m of MARKERS) { try { fs.statSync(path.join(dir, m)); return dir; } catch {} }
    if (dir === root || dir === home) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Fixture construction. Three sibling projects with distinct identities and
// payloads, plus a space-dir and a symlinked alias for the path-handling cases.
// Each project gets a .git marker (git-boundary) so its detected root is the
// project dir itself, and per-project text + JS program fixtures.
// ---------------------------------------------------------------------------
export function buildFixtures(fixturesRoot) {
  fs.rmSync(fixturesRoot, { recursive: true, force: true });
  fs.mkdirSync(fixturesRoot, { recursive: true });

  const mkProject = (name, payloadTag) => {
    const dir = path.join(fixturesRoot, name);
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(dir, 'marker.txt'), `hello from ${name}\n`);
    fs.writeFileSync(path.join(dir, 'notes.txt'),
      [`# ${name} notes`, `payload:${payloadTag}`, 'line three', 'line four', 'line five'].join('\n') + '\n');
    // A small supported-language (JS) program with two refactorable symbols +
    // two callers, so edit_file symbol mode and refactor_batch have real targets.
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'a.js'),
`function targetFn(x) { return x + 1; }

function callerA() { return targetFn(1); }

function helperAlpha() { return 'alpha-${payloadTag}'; }
`);
    fs.writeFileSync(path.join(dir, 'src', 'b.js'),
`function targetFn(x) { return x + 1; }

function callerB() { return targetFn(2); }

function helperBeta() { return 'beta-${payloadTag}'; }
`);
    // A plain editable text file for content/block edits.
    fs.writeFileSync(path.join(dir, 'edit.txt'),
`alpha one
beta two
gamma three
delta four
epsilon five
`);
    return dir;
  };

  const A = mkProject('proj-alpha', 'A');
  const B = mkProject('proj-beta', 'B');
  const C = mkProject('proj-gamma', 'C');

  // Space-dir project (detection + writes under a path containing a space).
  const S = mkProject('proj delta space', 'S');

  // A symlinked alias to proj-beta — write through the alias must land on the
  // real project (target identity), and detection must resolve the realpath.
  const betaAlias = path.join(fixturesRoot, 'beta-link');
  fs.symlinkSync(B, betaAlias);

  return { fixturesRoot, A, B, C, S, betaAlias,
           real: { A: realpathSafe(A), B: realpathSafe(B), C: realpathSafe(C), S: realpathSafe(S) } };
}

// Recursive manifest: relpath -> { type, sha256 (files), link (symlinks) }.
export function snapshotManifest(rootDir) {
  const out = {};
  const walk = (cur, rel) => {
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === '.git') continue; // marker; not part of mutation accounting
      const abs = path.join(cur, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out[r] = { type: 'dir' }; walk(abs, r); }
      else if (e.isSymbolicLink()) { out[r] = { type: 'symlink', link: fs.readlinkSync(abs) }; }
      else if (e.isFile()) {
        const buf = fs.readFileSync(abs);
        out[r] = { type: 'file', sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length };
      }
    }
  };
  walk(rootDir, '');
  return out;
}

export function snapshotAll(F) {
  const m = {};
  for (const key of ['A','B','C','S']) m[key] = snapshotManifest(F[key]);
  return m;
}

// Diff two manifests → list of {project, rel, change, beforeSha?, afterSha?}.
export function diffManifests(before, after) {
  const changes = [];
  for (const proj of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[proj] || {}; const a = after[proj] || {};
    const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
    for (const rel of keys) {
      const eb = b[rel]; const ea = a[rel];
      if (!eb && ea) changes.push({ project: proj, rel, change: 'added', afterSha: ea.sha256 });
      else if (eb && !ea) changes.push({ project: proj, rel, change: 'removed', beforeSha: eb.sha256 });
      else if (eb && ea && (eb.sha256 !== ea.sha256 || eb.type !== ea.type))
        changes.push({ project: proj, rel, change: 'modified', beforeSha: eb.sha256, afterSha: ea.sha256 });
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Isolated HOME + config. No wizard, no real ~/.zenith-mcp, fresh token.
// ---------------------------------------------------------------------------
export function makeIsolatedHome(homeDir, { port = 0, projects = [] } = {}) {
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(homeDir, '.zenith-mcp'), { recursive: true });
  const lines = [`Port: ${port}`, ''];
  // ### Projects uses the config's own format: an `== Title ==` comment
  // boundary, then `Project_ID:` / `Project_Root:` / `Project_Name:` keys.
  if (projects.length) {
    lines.push('### Projects');
    for (const p of projects) {
      lines.push(`== ${p.name ?? p.id} ==`);
      lines.push(`Project_ID: ${p.id}`);
      lines.push(`Project_Root: ${p.root}`);
      if (p.name) lines.push(`Project_Name: ${p.name}`);
      lines.push('');
    }
  }
  fs.writeFileSync(path.join(homeDir, '.zenith-mcp', 'config'), lines.join('\n'), 'utf8');
  return homeDir;
}

export function baseEnv(homeDir, extra = {}) {
  return {
    PATH: '/usr/bin:/bin',
    HOME: homeDir,
    XDG_CONFIG_HOME: path.join(homeDir, 'config'),
    XDG_CACHE_HOME: path.join(homeDir, 'cache'),
    XDG_DATA_HOME: path.join(homeDir, 'data'),
    CI: '1', NO_COLOR: '1', npm_config_userconfig: '/dev/null',
    ...extra,
  };
}

export function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

export function readProcCwd(pid) { try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return null; } }

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ============================================================================
// Server under test: launch (stdio / http) + raw JSON-RPC clients.
//
// The server is spawned as a CHILD of this launcher process. This process's
// cwd is therefore the server's ancestor[0] cwd — the kernel-recorded
// detection evidence ProjectContext reads via getCallerCwds(). We control and
// independently know that cwd; the server's own /proc/<pid>/cwd is captured
// too (it is fixed at launch and must NOT become the unnoticed oracle).
// ============================================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { NODE_BIN, baseEnv, freePort, readProcCwd, sleep } from './lib.mjs';

export class StdioServer {
  constructor(repoRoot, { home, cwd, allowedDirs = [] }) {
    this.kind = 'stdio';
    this.repoRoot = repoRoot;
    this.entry = path.join(repoRoot, 'packages/zenith-mcp/dist/cli/stdio.js');
    this.home = home;
    this.launchCwd = cwd;
    this.allowedDirs = allowedDirs;
    this.child = null;
    this.stderr = '';
    this._buf = '';
    this._pending = new Map();
    this._nextId = 1;
  }
  async start() {
    const env = baseEnv(this.home);
    // Spawn with cwd = the fixture we are simulating being "in". We ALSO
    // process.chdir() there, so this process (the parent) is the cwd evidence.
    this.child = spawn(NODE_BIN, [this.entry, ...this.allowedDirs], {
      env, stdio: ['pipe', 'pipe', 'pipe'], cwd: this.launchCwd,
    });
    this.pid = this.child.pid;
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', d => { this.stderr += d; });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', d => {
      this._buf += d;
      let i;
      while ((i = this._buf.indexOf('\n')) >= 0) {
        const line = this._buf.slice(0, i).trim(); this._buf = this._buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m && m.id !== undefined && this._pending.has(m.id)) { this._pending.get(m.id)(m); this._pending.delete(m.id); }
      }
    });
    // bounded boot wait: probe with a tools/list until it answers
    const deadline = Date.now() + 15000;
    for (;;) {
      if (this.child.exitCode !== null) throw new Error('stdio server exited at boot:\n' + this.stderr);
      try { await this.rpc('tools/list', {}, 3000); return; }
      catch (e) { if (Date.now() > deadline) throw new Error('stdio boot timeout: ' + e.message + '\n' + this.stderr); await sleep(120); }
    }
  }
  rpc(method, params, timeoutMs = 20000) {
    const id = this._nextId++;
    const req = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => { if (this._pending.has(id)) { this._pending.delete(id); reject(new Error('rpc timeout ' + method)); } }, timeoutMs);
      this._pending.set(id, (m) => { clearTimeout(to); resolve(m); });
      this.child.stdin.write(JSON.stringify(req) + '\n');
    });
  }
  async callTool(name, args, timeoutMs) {
    const t0 = process.hrtime.bigint();
    let msg, err = null;
    try { msg = await this.rpc('tools/call', { name, arguments: args }, timeoutMs); }
    catch (e) { err = e; }
    const latencyMs = Number(process.hrtime.bigint() - t0) / 1e6;
    return this._shapeToolResult(msg, err, latencyMs);
  }
  _shapeToolResult(msg, err, latencyMs) {
    if (err) return { ok: false, transportError: err.message, latencyMs };
    if (msg.error) return { ok: false, rpcError: msg.error, latencyMs };
    const res = msg.result || {};
    const text = (res.content || []).map(c => c.type === 'text' ? c.text : '').join('\n');
    return { ok: !res.isError, isError: !!res.isError, text, raw: res, latencyMs };
  }
  serverProcCwd() { return readProcCwd(this.pid); }
  async stop() {
    if (this.child && this.child.exitCode === null) {
      this.child.kill('SIGTERM');
      await Promise.race([new Promise(r => this.child.once('exit', r)), sleep(3000)]);
      if (this.child.exitCode === null) { this.child.kill('SIGKILL'); await sleep(150); }
    }
  }
}

export class HttpServer {
  constructor(repoRoot, { home, cwd, allowedDirs = [], token }) {
    this.kind = 'http';
    this.repoRoot = repoRoot;
    this.entry = path.join(repoRoot, 'packages/zenith-mcp/dist/server/http.js');
    this.home = home;
    this.launchCwd = cwd;
    this.allowedDirs = allowedDirs;
    this.token = token;
    this.child = null;
    this.stderr = '';
    this._nextId = 1;
  }
  async start() {
    this.port = await freePort();
    this.base = `http://127.0.0.1:${this.port}`;
    const env = baseEnv(this.home, { ZENITH_API_KEY: this.token });
    this.child = spawn(NODE_BIN, [this.entry, ...this.allowedDirs, '--host=127.0.0.1', `--port=${this.port}`], {
      env, stdio: ['ignore', 'ignore', 'pipe'], cwd: this.launchCwd,
    });
    this.pid = this.child.pid;
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', d => { this.stderr += d; });
    const deadline = Date.now() + 15000;
    for (;;) {
      if (this.child.exitCode !== null) throw new Error('http server exited at boot:\n' + this.stderr);
      try { const r = await fetch(this.base + '/health'); if (r.ok) return; } catch {}
      if (Date.now() > deadline) throw new Error('http health timeout:\n' + this.stderr);
      await sleep(100);
    }
  }
  async _post(body, timeoutMs = 20000) {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(this.base + '/mcp', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: controller.signal,
      });
      const ct = res.headers.get('content-type') ?? '';
      const text = await res.text();
      let rpc;
      if (ct.includes('text/event-stream')) {
        const dl = text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(Boolean);
        rpc = dl.length ? JSON.parse(dl[dl.length - 1]) : null;
      } else { rpc = text ? JSON.parse(text) : null; }
      return { httpStatus: res.status, rpc };
    } finally { clearTimeout(to); }
  }
  async rpc(method, params, timeoutMs) {
    const id = this._nextId++;
    return this._post({ jsonrpc: '2.0', id, method, params }, timeoutMs);
  }
  async callTool(name, args, timeoutMs) {
    const t0 = process.hrtime.bigint();
    let out, err = null;
    try { out = await this.rpc('tools/call', { name, arguments: args }, timeoutMs); }
    catch (e) { err = e; }
    const latencyMs = Number(process.hrtime.bigint() - t0) / 1e6;
    if (err) return { ok: false, transportError: err.message, latencyMs };
    const { httpStatus, rpc } = out;
    if (!rpc) return { ok: false, transportError: `no rpc body (http ${httpStatus})`, httpStatus, latencyMs };
    if (rpc.error) return { ok: false, rpcError: rpc.error, httpStatus, latencyMs };
    const res = rpc.result || {};
    const text = (res.content || []).map(c => c.type === 'text' ? c.text : '').join('\n');
    return { ok: !res.isError, isError: !!res.isError, text, raw: res, httpStatus, latencyMs };
  }
  serverProcCwd() { return readProcCwd(this.pid); }
  async stop() {
    if (this.child && this.child.exitCode === null) {
      this.child.kill('SIGTERM');
      await Promise.race([new Promise(r => this.child.once('exit', r)), sleep(3000)]);
      if (this.child.exitCode === null) { this.child.kill('SIGKILL'); await sleep(150); }
    }
  }
}

export function makeServer(transport, repoRoot, opts) {
  return transport === 'stdio' ? new StdioServer(repoRoot, opts) : new HttpServer(repoRoot, opts);
}

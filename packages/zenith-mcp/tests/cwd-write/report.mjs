// ============================================================================
// Evidence recorder + coverage accounting.
//
// Every measured invocation becomes one JSONL record capturing: tool, mode,
// transport, server instance id, sequence index, latency, evidence topology
// (what cwd evidence the server could see), expected vs observed active root
// (when observable), expected vs actual operation target, actual filesystem
// effects (manifest diff), status, and the assertion reason.
//
// Metrics are reported as THREE separate rates: active-root accuracy, target
// accuracy, and operational success — with explicit denominators. No claim of
// 100% by silently excluding failures: every skipped / errored case is kept in
// the accounting with its denominator stated.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

export class Recorder {
  constructor(outDir, runLabel) {
    this.outDir = outDir;
    fs.mkdirSync(outDir, { recursive: true });
    this.eventsPath = path.join(outDir, `${runLabel}.events.jsonl`);
    this.seq = 0;
    this.fd = fs.openSync(this.eventsPath, 'a');
    this.records = [];
  }

  // record one invocation. Fields are deliberately explicit; missing evidence
  // is recorded as null, never fabricated.
  record(ev) {
    const rec = {
      seq: this.seq++,
      tool: ev.tool,
      mode: ev.mode ?? null,
      transport: ev.transport,
      serverInstance: ev.serverInstance,
      phase: ev.phase ?? null,                 // e.g. 'A#1-first', 'B#1-immediate', 'post-ttl'
      transitionKind: ev.transitionKind ?? null, // 'first'|'stable'|'immediate'|'post-ttl'|'return'|'absolute-override'|'concurrent'
      latencyMs: ev.latencyMs != null ? Math.round(ev.latencyMs * 100) / 100 : null,
      // evidence topology
      launcherCwd: ev.launcherCwd ?? null,      // our (parent) cwd = ancestor[0] evidence
      serverProcCwd: ev.serverProcCwd ?? null,  // server's fixed /proc cwd
      evidenceTopology: ev.evidenceTopology ?? null, // 'local-ancestry' | 'independent-http-client' | 'stdio-parent' | ...
      // expected vs observed
      expectedActiveRoot: ev.expectedActiveRoot ?? null,
      observedActiveRoot: ev.observedActiveRoot ?? null,  // null when black-box-invisible
      activeRootObservable: !!ev.activeRootObservable,
      expectedTarget: ev.expectedTarget ?? null,
      actualTarget: ev.actualTarget ?? null,
      // fs effects
      fsEffects: ev.fsEffects ?? [],            // manifest-diff entries attributable to this call
      crossProjectMutation: ev.crossProjectMutation ?? null, // bool when we checked siblings
      // outcome
      status: ev.status,                        // 'correct'|'wrong-root'|'operation-error'|'harness-error'|'unsupported'|'ok'
      assertionReason: ev.assertionReason ?? null,
      request: ev.request ?? null,              // exact RPC arguments
      resultText: ev.resultText != null ? truncate(ev.resultText, 4000) : null,
      rpcError: ev.rpcError ?? null,
      transportError: ev.transportError ?? null,
      labels: ev.labels ?? [],                  // e.g. ['override-control','seam','persistence-consent']
    };
    this.records.push(rec);
    // CodeQL js/http-to-file-access ("Network data written to file") flags this
    // write: over the HTTP transport `resultText` is the server's response body,
    // and recording it verbatim IS this file's purpose — it is the evidence log.
    // Bounded by construction: the record is the fixed, whitelisted shape built
    // above (no response-controlled keys), the server text is truncated to 4000
    // chars, JSON.stringify yields exactly one escaped line per record, and the
    // path is harness-owned (<out-dir>/<label>.events.jsonl, never taken from a
    // response). Accepted as an intentional test-harness sink.
    fs.writeSync(this.fd, JSON.stringify(rec) + '\n');
    return rec;
  }

  close() { try { fs.closeSync(this.fd); } catch {} }
}

function truncate(s, n) { return s.length > n ? s.slice(0, n) + `…[${s.length - n} more]` : s; }

// ---------------------------------------------------------------------------
// Coverage accounting. planned = cases the generator emitted; attempted =
// cases actually invoked; correct / wrong-root / operation-error /
// harness-error / unsupported are disjoint outcome buckets.
// ---------------------------------------------------------------------------
export class Coverage {
  constructor() { this.byTool = new Map(); }
  _bucket(tool, transport) {
    const k = `${tool}::${transport}`;
    if (!this.byTool.has(k)) this.byTool.set(k, {
      tool, transport, planned: 0, attempted: 0,
      correct: 0, wrongRoot: 0, operationError: 0, harnessError: 0, unsupported: 0,
      // separate metric numerators/denominators
      activeRoot: { num: 0, den: 0 },   // observable active-root checks
      target: { num: 0, den: 0 },       // operation-target correctness
      opSuccess: { num: 0, den: 0 },    // real work succeeded
    });
    return this.byTool.get(k);
  }
  planned(tool, transport, n = 1) { this._bucket(tool, transport).planned += n; }

  observe(tool, transport, rec) {
    const b = this._bucket(tool, transport);
    b.attempted += 1;
    switch (rec.status) {
      case 'correct': b.correct++; break;
      case 'wrong-root': b.wrongRoot++; break;
      case 'operation-error': b.operationError++; break;
      case 'harness-error': b.harnessError++; break;
      case 'unsupported': b.unsupported++; break;
      case 'ok': b.correct++; break; // non-detection success case
      default: b.harnessError++; break;
    }
    if (rec.activeRootObservable) {
      b.activeRoot.den++;
      if (rec.observedActiveRoot && rec.expectedActiveRoot && normalize(rec.observedActiveRoot) === normalize(rec.expectedActiveRoot)) b.activeRoot.num++;
    }
    if (rec.expectedTarget != null) {
      b.target.den++;
      if (rec.actualTarget != null && normalize(rec.actualTarget) === normalize(rec.expectedTarget)) b.target.num++;
    }
    // operational success = the call did its real work without transport/rpc error
    if (rec.status === 'correct' || rec.status === 'ok') b.opSuccess.num++;
    if (rec.status !== 'unsupported' && rec.status !== 'harness-error') b.opSuccess.den++;
  }

  summary() {
    const tools = [...this.byTool.values()].map(b => ({
      tool: b.tool, transport: b.transport,
      planned: b.planned, attempted: b.attempted,
      correct: b.correct, wrongRoot: b.wrongRoot, operationError: b.operationError,
      harnessError: b.harnessError, unsupported: b.unsupported,
      activeRootAccuracy: b.activeRoot.den ? round(b.activeRoot.num / b.activeRoot.den) : null,
      activeRootDenom: b.activeRoot.den,
      targetAccuracy: b.target.den ? round(b.target.num / b.target.den) : null,
      targetDenom: b.target.den,
      operationalSuccess: b.opSuccess.den ? round(b.opSuccess.num / b.opSuccess.den) : null,
      opSuccessDenom: b.opSuccess.den,
    }));
    return tools;
  }
}

function normalize(p) { return p.replace(/\/+$/, ''); }
function round(x) { return Math.round(x * 1000) / 1000; }

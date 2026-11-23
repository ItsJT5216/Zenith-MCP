import { readFile } from "node:fs/promises";

export interface ReplayMetrics {
  totalEvents: number;
  sessionCount: number;
  avgActiveK: number;
  describeRate: number;
  tier56Rate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  avgAlpha: number;
  avgRouterEnumSize: number;
  canaryEvents: number;
  controlEvents: number;
  recallAt15: number;
  canaryRecall: number;
  controlRecall: number;
  canaryDescribeRate: number;
  controlDescribeRate: number;
}

export interface CutoverGate {
  name: string;
  passed: boolean;
  threshold: number;
  actual: number;
  message: string;
}

interface RawEvent {
  sessionId?: string;
  scorerLatencyMs?: number;
  activeK?: number;
  routerDescribes?: string[];
  fallbackTier?: number;
  routerEnumSize?: number;
  alpha?: number;
  group?: string;
  directToolCalls?: string[];
  routerProxies?: string[];
  activeToolIds?: string[];
  type?: string;
}

const GATE_P95_MS = 50.0;
const GATE_TIER56_RATE = 0.05;
const MIN_EVENTS_PER_GROUP = 20;
const GATE_RECALL_IMPROVEMENT = 0.05;
const GATE_DESCRIBE_DROP = 0.20;

function _percentile(sortedVals: number[], p: number): number {
  if (sortedVals.length === 0) return 0.0;
  const idx = Math.min(Math.floor(p * sortedVals.length), sortedVals.length - 1);
  return sortedVals[idx];
}

function _computeGroupRecall(groupEvents: RawEvent[]): [number, number] {
  let total = 0;
  let hits = 0;
  for (const ev of groupEvents) {
    const activeTools = new Set(ev.activeToolIds ?? []);
    for (const call of ev.directToolCalls ?? []) {
      total++;
      if (activeTools.has(call)) hits++;
    }
    for (const proxyCall of ev.routerProxies ?? []) {
      total++;
      if (activeTools.has(proxyCall)) hits++;
    }
  }
  return total > 0 ? [hits / total, total] : [0.0, 0];
}

function _computeDescribeRate(groupEvents: RawEvent[]): number {
  if (groupEvents.length === 0) return 0.0;
  const describeCount = groupEvents.filter(
    (ev) => ev.routerDescribes && ev.routerDescribes.length > 0
  ).length;
  return describeCount / groupEvents.length;
}

function _parseEvents(content: string): RawEvent[] {
  const events: RawEvent[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as RawEvent;
      if (parsed.type === "alert") continue;
      events.push(parsed);
    } catch {
      continue;
    }
  }
  return events;
}

function _computeMetrics(events: RawEvent[]): ReplayMetrics {
  if (events.length === 0) return _emptyMetrics();

  const total = events.length;
  const sessions = new Set<string>();
  const latencies: number[] = [];
  let describeCount = 0;
  let tier56Count = 0;
  let totalK = 0;
  let totalAlpha = 0.0;
  let totalEnum = 0;
  let canaryCount = 0;
  let controlCount = 0;

  for (const ev of events) {
    sessions.add(ev.sessionId ?? "");
    latencies.push(ev.scorerLatencyMs ?? 0);
    totalK += ev.activeK ?? 0;
    totalAlpha += ev.alpha ?? 0.0;
    totalEnum += ev.routerEnumSize ?? 0;

    if (ev.routerDescribes && ev.routerDescribes.length > 0) describeCount++;
    if ((ev.fallbackTier ?? 1) >= 5) tier56Count++;

    if (ev.group === "canary") canaryCount++;
    else if (ev.group === "control") controlCount++;
  }

  latencies.sort((a, b) => a - b);

  return {
    totalEvents: total,
    sessionCount: sessions.size,
    avgActiveK: totalK / total,
    describeRate: describeCount / total,
    tier56Rate: tier56Count / total,
    p50LatencyMs: _percentile(latencies, 0.5),
    p95LatencyMs: _percentile(latencies, 0.95),
    p99LatencyMs: _percentile(latencies, 0.99),
    avgAlpha: totalAlpha / total,
    avgRouterEnumSize: totalEnum / total,
    canaryEvents: canaryCount,
    controlEvents: controlCount,
    recallAt15: 0.0,
    canaryRecall: 0.0,
    controlRecall: 0.0,
    canaryDescribeRate: 0.0,
    controlDescribeRate: 0.0,
  };
}

function _emptyMetrics(): ReplayMetrics {
  return {
    totalEvents: 0,
    sessionCount: 0,
    avgActiveK: 0.0,
    describeRate: 0.0,
    tier56Rate: 0.0,
    p50LatencyMs: 0.0,
    p95LatencyMs: 0.0,
    p99LatencyMs: 0.0,
    avgAlpha: 0.0,
    avgRouterEnumSize: 0.0,
    canaryEvents: 0,
    controlEvents: 0,
    recallAt15: 0.0,
    canaryRecall: 0.0,
    controlRecall: 0.0,
    canaryDescribeRate: 0.0,
    controlDescribeRate: 0.0,
  };
}

export async function evaluateReplay(logPath: string): Promise<ReplayMetrics> {
  let content: string;
  try {
    content = await readFile(logPath, "utf-8");
  } catch {
    return _emptyMetrics();
  }
  const events = _parseEvents(content);
  return _computeMetrics(events);
}

export function checkCutoverGates(
  metrics: ReplayMetrics,
  events?: RawEvent[]
): CutoverGate[] {
  const gates: CutoverGate[] = [];

  // Gate 1: p95 latency
  const p95Pass = metrics.p95LatencyMs < GATE_P95_MS;
  gates.push({
    name: "p95_latency",
    passed: p95Pass,
    threshold: GATE_P95_MS,
    actual: metrics.p95LatencyMs,
    message: `p95 latency ${metrics.p95LatencyMs.toFixed(1)}ms ${p95Pass ? "<" : ">="} ${GATE_P95_MS}ms`,
  });

  // Gate 2: Tier 5-6 rate
  const tierPass = metrics.tier56Rate < GATE_TIER56_RATE;
  gates.push({
    name: "tier56_rate",
    passed: tierPass,
    threshold: GATE_TIER56_RATE,
    actual: metrics.tier56Rate,
    message: `Tier 5-6 rate ${(metrics.tier56Rate * 100).toFixed(1)}% ${tierPass ? "<" : ">="} ${(GATE_TIER56_RATE * 100).toFixed(0)}%`,
  });

  if (events !== undefined) {
    const nonShadow = events.filter((ev) => ev.group !== "shadow");
    const canaryEvs = nonShadow.filter((ev) => ev.group === "canary");
    const controlEvs = nonShadow.filter((ev) => ev.group === "control");

    const [canaryRecall, canaryTotal] = _computeGroupRecall(canaryEvs);
    const [controlRecall, controlTotal] = _computeGroupRecall(controlEvs);

    metrics.canaryRecall = canaryRecall;
    metrics.controlRecall = controlRecall;
    metrics.recallAt15 = canaryRecall;

    if (canaryTotal < MIN_EVENTS_PER_GROUP || controlTotal < MIN_EVENTS_PER_GROUP) {
      gates.push({
        name: "recall_at_15",
        passed: false,
        threshold: GATE_RECALL_IMPROVEMENT,
        actual: 0.0,
        message: `Insufficient data: canary=${canaryTotal}, control=${controlTotal}, need ${MIN_EVENTS_PER_GROUP} per group`,
      });
    } else {
      const recallImprovement = canaryRecall - controlRecall;
      const recallPass = recallImprovement >= GATE_RECALL_IMPROVEMENT;
      gates.push({
        name: "recall_at_15",
        passed: recallPass,
        threshold: GATE_RECALL_IMPROVEMENT,
        actual: recallImprovement,
        message: `Recall@15 improvement ${(recallImprovement * 100).toFixed(1)}% ${recallPass ? ">=5%" : "<5%"} (canary=${(canaryRecall * 100).toFixed(1)}%, control=${(controlRecall * 100).toFixed(1)}%)`,
      });
    }

    const canaryDescribe = _computeDescribeRate(canaryEvs);
    const controlDescribe = _computeDescribeRate(controlEvs);

    metrics.canaryDescribeRate = canaryDescribe;
    metrics.controlDescribeRate = controlDescribe;

    const canaryN = canaryEvs.length;
    const controlN = controlEvs.length;

    if (canaryN < MIN_EVENTS_PER_GROUP || controlN < MIN_EVENTS_PER_GROUP) {
      gates.push({
        name: "describe_rate_drop",
        passed: false,
        threshold: GATE_DESCRIBE_DROP,
        actual: 0.0,
        message: `Insufficient data: canary=${canaryN}, control=${controlN}, need ${MIN_EVENTS_PER_GROUP} per group`,
      });
    } else {
      let describeDrop: number;
      if (controlDescribe > 0) {
        describeDrop = (controlDescribe - canaryDescribe) / controlDescribe;
      } else {
        describeDrop = canaryDescribe === 0 ? 0.0 : -1.0;
      }
      const describePass = describeDrop >= GATE_DESCRIBE_DROP;
      gates.push({
        name: "describe_rate_drop",
        passed: describePass,
        threshold: GATE_DESCRIBE_DROP,
        actual: describeDrop,
        message: `Describe rate drop ${(describeDrop * 100).toFixed(1)}% ${describePass ? ">=20%" : "<20%"} (canary=${(canaryDescribe * 100).toFixed(1)}%, control=${(controlDescribe * 100).toFixed(1)}%)`,
      });
    }
  } else {
    gates.push({
      name: "describe_rate",
      passed: true,
      threshold: 0.10,
      actual: metrics.describeRate,
      message:
        `Describe rate ${(metrics.describeRate * 100).toFixed(1)}%` +
        (metrics.describeRate > 0.10 ? " WARNING: exceeds 10%" : " OK"),
    });
  }

  return gates;
}

export async function evaluateReplayWithGates(
  logPath: string
): Promise<{ metrics: ReplayMetrics; gates: CutoverGate[] }> {
  let content: string;
  try {
    content = await readFile(logPath, "utf-8");
  } catch {
    const metrics = _emptyMetrics();
    return { metrics, gates: checkCutoverGates(metrics, []) };
  }

  const events = _parseEvents(content);
  const metrics = _computeMetrics(events);
  const gates = checkCutoverGates(metrics, events);
  return { metrics, gates };
}

export function formatReport(metrics: ReplayMetrics, gates: CutoverGate[]): string {
  const lines: string[] = [
    "=".repeat(60),
    "  BMXF Rollout Replay Report",
    "=".repeat(60),
    "",
    `  Events:        ${metrics.totalEvents}`,
    `  Sessions:      ${metrics.sessionCount}`,
    `  Canary events: ${metrics.canaryEvents}`,
    `  Control events:${metrics.controlEvents}`,
    "",
    `  Avg active K:  ${metrics.avgActiveK.toFixed(1)}`,
    `  Avg alpha:     ${metrics.avgAlpha.toFixed(3)}`,
    `  Router enum:   ${metrics.avgRouterEnumSize.toFixed(1)} avg`,
    "",
    "  Latency:",
    `    p50:  ${metrics.p50LatencyMs.toFixed(1)}ms`,
    `    p95:  ${metrics.p95LatencyMs.toFixed(1)}ms`,
    `    p99:  ${metrics.p99LatencyMs.toFixed(1)}ms`,
    "",
    `  Describe rate: ${(metrics.describeRate * 100).toFixed(1)}%`,
    `  Tier 5-6 rate: ${(metrics.tier56Rate * 100).toFixed(1)}%`,
  ];

  if (metrics.canaryRecall > 0 || metrics.controlRecall > 0 || metrics.recallAt15 > 0) {
    lines.push(
      "",
      "  Per-Group Recall (Phase 9 Gates):",
      `    Canary recall:   ${(metrics.canaryRecall * 100).toFixed(1)}%`,
      `    Control recall:  ${(metrics.controlRecall * 100).toFixed(1)}%`,
      `    Recall@15:       ${(metrics.recallAt15 * 100).toFixed(1)}%  (canary headline)`,
    );
  }

  if (metrics.canaryDescribeRate > 0 || metrics.controlDescribeRate > 0) {
    lines.push(
      "",
      "  Per-Group Describe Rate:",
      `    Canary:   ${(metrics.canaryDescribeRate * 100).toFixed(1)}%`,
      `    Control:  ${(metrics.controlDescribeRate * 100).toFixed(1)}%`,
    );
  }

  lines.push(
    "",
    "-".repeat(60),
    "  Cutover Gates:",
    "-".repeat(60),
  );

  const allPass = gates.every((g) => g.passed);
  for (const g of gates) {
    lines.push(`  [${g.passed ? "PASS" : "FAIL"}] ${g.message}`);
  }

  lines.push("");
  lines.push(
    `  Overall: ${allPass ? "ALL GATES PASS" : "BLOCKED -- fix failing gates"}`
  );
  lines.push("=".repeat(60));

  return lines.join("\n");
}

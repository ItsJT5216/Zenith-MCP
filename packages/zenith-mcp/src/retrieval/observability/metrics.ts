import { performance } from "node:perf_hooks";
import type { RankingEvent } from "../models.js";

export interface MetricSnapshot {
  eventCount: number;
  describeRate: number;
  tier56Rate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  avgActiveK: number;
  avgRouterEnumSize: number;
  rescoreRate30m: number;
  rescoreRate10m: number;
}

const EMPTY_SNAPSHOT: MetricSnapshot = {
  eventCount: 0,
  describeRate: 0.0,
  tier56Rate: 0.0,
  p50LatencyMs: 0.0,
  p95LatencyMs: 0.0,
  p99LatencyMs: 0.0,
  avgActiveK: 0.0,
  avgRouterEnumSize: 0.0,
  rescoreRate30m: 0.0,
  rescoreRate10m: 0.0,
};

export class RollingMetrics {
  private readonly _windowMs: number;
  private _events: Array<{ ts: number; event: RankingEvent }> = [];
  private _rescoreTimes: number[] = [];

  constructor(windowSeconds = 1800) {
    this._windowMs = windowSeconds * 1000;
  }

  record(event: RankingEvent): void {
    const now = performance.now();
    this._events.push({ ts: now, event });
    this._evict(now);
  }

  recordRescore(): void {
    const now = performance.now();
    this._rescoreTimes.push(now);
    this._evictRescore(now);
  }

  private _evict(now: number): void {
    const cutoff = now - this._windowMs;
    let i = 0;
    for (const item of this._events) {
      if (!(item.ts < cutoff)) break;
      i++;
    }
    if (i > 0) this._events = this._events.slice(i);
  }

  private _evictRescore(now: number): void {
    const cutoff = now - this._windowMs;
    let i = 0;
    for (const ts of this._rescoreTimes) {
      if (!(ts < cutoff)) break;
      i++;
    }
    if (i > 0) this._rescoreTimes = this._rescoreTimes.slice(i);
  }

  snapshot(group?: string): MetricSnapshot {
    const now = performance.now();
    this._evict(now);
    this._evictRescore(now);

    const events = this._events
      .map((e) => e.event)
      .filter((ev) => group === undefined || ev.group === group);

    if (events.length === 0) {
      return { ...EMPTY_SNAPSHOT };
    }

    const total = events.length;
    const describeCount = events.filter(
      (ev) => ev.routerDescribes && ev.routerDescribes.length > 0
    ).length;
    const tier56Count = events.filter(
      (ev) => (ev.fallbackTier ?? 1) >= 5
    ).length;

    const latencies = events
      .map((ev) => ev.scorerLatencyMs ?? 0)
      .sort((a, b) => a - b);

    const pct = (sorted: number[], p: number): number => {
      if (sorted.length === 0) return 0.0;
      const idx = Math.min(Math.floor(p * sorted.length), sorted.length - 1);
      return sorted[idx];
    };

    const totalK = events.reduce((s, ev) => s + (ev.activeK ?? 0), 0);
    const totalEnum = events.reduce(
      (s, ev) => s + (ev.routerEnumSize ?? 0),
      0
    );

    const tenMinWindowMs = Math.min(600_000, this._windowMs);
    const tenMinCutoff = now - tenMinWindowMs;
    const rescoreCount10m = this._rescoreTimes.filter((t) => t >= tenMinCutoff).length;

    const snap: MetricSnapshot = {
      eventCount: total,
      describeRate: describeCount / total,
      tier56Rate: tier56Count / total,
      p50LatencyMs: pct(latencies, 0.5),
      p95LatencyMs: pct(latencies, 0.95),
      p99LatencyMs: pct(latencies, 0.99),
      avgActiveK: totalK / total,
      avgRouterEnumSize: totalEnum / total,
      rescoreRate30m:
        this._rescoreTimes.length / (this._windowMs / 1000),
      rescoreRate10m: rescoreCount10m / (tenMinWindowMs / 1000),
    };

    return snap;
  }
}

export const ALERT_DESCRIBE_RATE = 0.10;
export const ALERT_TIER56_RATE = 0.05;
export const ALERT_P95_MS = 75.0;
export const ALERT_RESCORE_RATE = 0.2;

export class AlertChecker {
  private readonly _describeRate: number;
  private readonly _tier56Rate: number;
  private readonly _p95Ms: number;
  private readonly _rescoreThreshold: number;

  constructor(
    describeRate = ALERT_DESCRIBE_RATE,
    tier56Rate = ALERT_TIER56_RATE,
    p95Ms = ALERT_P95_MS,
    rescoreThreshold = ALERT_RESCORE_RATE
  ) {
    this._describeRate = describeRate;
    this._tier56Rate = tier56Rate;
    this._p95Ms = p95Ms;
    this._rescoreThreshold = rescoreThreshold;
  }

  check(snapshot: MetricSnapshot): string[] {
    const alerts: string[] = [];

    if (snapshot.eventCount === 0 && snapshot.rescoreRate10m === 0.0) {
      return alerts;
    }

    if (snapshot.describeRate > this._describeRate) {
      alerts.push(
        `HIGH_DESCRIBE_RATE: ${(snapshot.describeRate * 100).toFixed(1)}% > ${(this._describeRate * 100).toFixed(0)}%`
      );
    }

    if (snapshot.tier56Rate > this._tier56Rate) {
      alerts.push(
        `HIGH_TIER56_RATE: ${(snapshot.tier56Rate * 100).toFixed(1)}% > ${(this._tier56Rate * 100).toFixed(0)}%`
      );
    }

    if (snapshot.p95LatencyMs > this._p95Ms) {
      alerts.push(
        `HIGH_P95_LATENCY: ${snapshot.p95LatencyMs.toFixed(1)}ms > ${this._p95Ms.toFixed(0)}ms`
      );
    }

    if (snapshot.rescoreRate10m > this._rescoreThreshold) {
      alerts.push(
        `HIGH_RESCORE_RATE: ${snapshot.rescoreRate10m.toFixed(2)}/s > ${this._rescoreThreshold.toFixed(1)}/s (10m window)`
      );
    }

    return alerts;
  }
}

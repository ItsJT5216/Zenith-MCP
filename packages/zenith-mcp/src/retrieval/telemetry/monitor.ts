import { performance } from "node:perf_hooks";

import type { WorkspaceEvidence } from "../models.js";
import type { TelemetryScanner } from "./scanner.js";

export interface RootMonitorOptions {
  scanner?: TelemetryScanner;
  significanceThreshold?: number;
  minDebounceMs?: number;
  rootUris?: string[];
  now?: () => number;
}

export class RootMonitor {
  private readonly _scanner: TelemetryScanner | undefined;
  private _rootUris: string[];
  private readonly _threshold: number;
  private readonly _minDebounceMs: number;
  private readonly _now: () => number;

  private _pollScheduleIdx = 0;
  private readonly _pollSchedule: readonly number[] = [5000, 10000, 20000, 30000];
  private _lastPollTime = 0.0;
  private _lastTriggerTime = 0.0;
  private _cumulativeSignificance = 0.0;
  private _idlePollCount = 0;

  constructor(options: RootMonitorOptions = {}) {
    this._scanner = options.scanner;
    this._rootUris = [...(options.rootUris ?? [])];
    this._threshold = options.significanceThreshold ?? 0.7;
    this._minDebounceMs = options.minDebounceMs ?? 10_000;
    this._now = options.now ?? (() => performance.now());
  }

  get pollIntervalMs(): number {
    return this._pollSchedule[
      Math.min(this._pollScheduleIdx, this._pollSchedule.length - 1)
    ];
  }

  shouldPoll(): boolean {
    return (this._now() - this._lastPollTime) >= this.pollIntervalMs;
  }

  get rootUris(): string[] {
    return [...this._rootUris];
  }

  setRootUris(uris: string[]): void {
    this._rootUris = [...uris];
  }

  async poll(rootUris?: string[]): Promise<number> {
    this._lastPollTime = this._now();

    let significance: number;
    if (this._scanner === undefined) {
      significance = 0.0;
    } else {
      const activeUris = rootUris ?? this._rootUris;
      if (activeUris.length === 0) {
        console.warn("RootMonitor.poll() skipped: no root URIs configured");
        significance = 0.0;
      } else {
        try {
          const evidence = await this._scanner.scanRoots(activeUris);
          significance = this._estimateSignificance(evidence);
        } catch (exc) {
          console.warn(`Scanner failed during poll: ${exc}`);
          significance = 0.0;
        }
      }
    }

    this.recordChange(significance);

    if (significance < this._threshold * 0.3) {
      this._idlePollCount++;
      if (this._idlePollCount >= 2) {
        this._pollScheduleIdx = Math.min(
          this._pollScheduleIdx + 1,
          this._pollSchedule.length - 1
        );
        this._idlePollCount = 0;
      }
    } else {
      this._pollScheduleIdx = 0;
      this._idlePollCount = 0;
    }

    return significance;
  }

  recordChange(significance: number): void {
    this._cumulativeSignificance += Math.max(0.0, significance);
  }

  checkForChanges(): boolean {
    if (this._cumulativeSignificance < this._threshold) {
      return false;
    }
    const now = this._now();
    if ((now - this._lastTriggerTime) < this._minDebounceMs) {
      return false;
    }
    this._lastTriggerTime = now;
    return true;
  }

  acknowledge(): void {
    this._cumulativeSignificance = 0.0;
    this._lastTriggerTime = this._now();
    this._pollScheduleIdx = 0;
    this._idlePollCount = 0;
  }

  reset(): void {
    this._pollScheduleIdx = 0;
    this._lastPollTime = 0.0;
    this._lastTriggerTime = 0.0;
    this._cumulativeSignificance = 0.0;
    this._idlePollCount = 0;
  }

  private _estimateSignificance(evidence: WorkspaceEvidence): number {
    if (evidence === null || evidence === undefined) return 0.0;
    return evidence.workspaceConfidence;
  }
}


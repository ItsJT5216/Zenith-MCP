/**
 * Core data models for the retrieval pipeline.
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

// ─── Shared contracts ───────────────────────────────────────────────────────

export interface ToolMapping {
  serverName: string;
  tool: Tool;
  handler?: unknown;
  namespace?: string;
  /** Original Zod input schema for runtime validation before dispatch. */
  inputZodSchema?: unknown;
}

export interface PromptMapping {
  serverName: string;
  client?: unknown;
  prompt: unknown;
}

export interface ResourceMapping {
  serverName: string;
  client?: unknown;
  resource: unknown;
}

export interface RetrievalContext {
  sessionId: string;
  query: string;
  toolCallHistory: string[];
  serverHint?: string | undefined;
  queryMode: "env" | "nl";
}

export interface ScoredTool {
  toolKey: string;
  toolMapping: ToolMapping;
  score: number;
  tier: "full" | "summary";
}

export interface RetrievalConfig {
  enabled: boolean;
  topK: number;
  fullDescriptionCount: number;
  anchorTools: string[];
  shadowMode: boolean;
  scorer: "bmx" | "passthrough";
  maxK: number;
  enableRoutingTool: boolean;
  enableTelemetry: boolean;
  telemetryPollInterval: number;
  canaryPercentage: number;
  rolloutStage: "shadow" | "canary" | "ga";
}

// ─── Phase 2: Tool catalog types ───────────────────────────────────────────

export interface ToolDoc {
  toolKey: string;
  toolName: string;
  namespace: string;
  description: string;
  parameterNames: string;
  retrievalAliases: string;
}

export interface ToolCatalogSnapshot {
  version: string;
  schemaHash: string;
  builtAt: number;
  docs: ToolDoc[];
}

// ─── Phase 2: Telemetry types ───────────────────────────────────────────────

export interface RootEvidence {
  rootUri: string;
  rootName?: string | undefined;
  tokens: Record<string, number>;
  features: Record<string, unknown>;
  confidence: number;
  fingerprintHash: string;
  partialScan: boolean;
}

export interface WorkspaceEvidence {
  roots: RootEvidence[];
  workspaceConfidence: number;
  mergedTokens: Record<string, number>;
  workspaceHash: string;
}

// ─── Phase 2: Session routing state ────────────────────────────────────────

export interface SessionRoutingState {
  sessionId: string;
  catalogVersion: string;
  turnNumber: number;
  envHash?: string;
  envConfidence: number;
  convConfidence: number;
  alpha: number;
  activeK: number;
  fallbackTier: number;
  activeToolIds: string[];
  routerEnumToolIds: string[];
  recentRouterDescribes: string[];
  recentRouterProxies: Record<string, number[]>;
  lastRankScores: Record<string, number>;
  consecutiveLowRank: Record<string, number>;
}

// ─── Phase 2: Observability ─────────────────────────────────────────────────

export interface RankingEvent {
  sessionId: string;
  turnNumber: number;
  catalogVersion: string;
  workspaceHash?: string | undefined;
  workspaceConfidence: number;
  convConfidence: number;
  alpha: number;
  activeK: number;
  fallbackTier: number;
  activeToolIds: string[];
  routerEnumSize: number;
  directToolCalls: string[];
  routerDescribes: string[];
  routerProxies: string[];
  scorerLatencyMs: number;
  group: "canary" | "control";
  timestamp: number;
}

// ─── Phase 2: Frequency prior ────────────────────────────────────────────────

export interface FrequencyPriorSource {
  readRankingEvents(sinceEpochSeconds: number): Promise<RankingEvent[]>;
}

// ─── Factory helpers ────────────────────────────────────────────────────────

export function defaultRetrievalConfig(overrides?: Partial<RetrievalConfig>): RetrievalConfig {
  return {
    enabled: false,
    topK: 15,
    fullDescriptionCount: 3,
    anchorTools: [],
    shadowMode: false,
    scorer: "bmx",
    maxK: 20,
    enableRoutingTool: true,
    enableTelemetry: true,
    telemetryPollInterval: 30,
    canaryPercentage: 0.0,
    rolloutStage: "shadow",
    ...overrides,
  };
}

export function createRetrievalContext(
  sessionId: string,
  overrides?: Partial<RetrievalContext>,
): RetrievalContext {
  return {
    sessionId,
    query: "",
    toolCallHistory: [],
    serverHint: undefined,
    queryMode: "env",
    ...overrides,
  };
}


/**
 * RetrievalPipeline — single entry point for tool filtering and ranking.
 * Converted from src/zenithmcp/retrieval/pipeline.py
 *
 * Pure data-processing class with NO transport layer (HAZARD 1).
 * Session IDs always passed in as plain strings (HAZARD 2).
 */

import { performance } from "node:perf_hooks";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import type {
  FrequencyPriorSource,
  RankingEvent,
  RetrievalConfig,
  RetrievalContext,
  ScoredTool,
  SessionRoutingState,
  ToolMapping,
  WorkspaceEvidence,
} from "./models.js";

import type { ToolRetriever } from "./base.js";
import { SessionStateManager } from "./session.js";
import { getSessionGroup } from "./rollout.js";
import type { TelemetryScanner } from "./telemetry/scanner.js";
import type { RetrievalLogger } from "./observability/logger.js";
import type { RollingMetrics } from "./observability/metrics.js";
import { buildRoutingToolSchema } from "./routing-tool.js";
import { RelevanceRanker } from "./ranking/ranker.js";
import { STATIC_CATEGORIES, TIER6_NAMESPACE_PRIORITY } from "./static-categories.js";

// ── Fusion module (Tier 1) ────────────────────────────────────────────────────
import { weightedRrf as _weightedRrf, computeAlpha as _computeAlpha } from "./ranking/fusion.js";

// ── Conversation term extraction ─────────────────────────────────────────────

const STOPWORDS = new Set([
  "the","a","an","is","are","was","were","be",
  "to","of","and","in","for","on","with",
  "true","false","null","none",
]);

const VERB_LEX: Record<string, string[]> = {
  list:   ["get","fetch","show","enumerate"],
  create: ["add","new","make","insert"],
  search: ["find","query","lookup"],
  delete: ["remove","destroy","drop"],
  update: ["edit","modify","change","patch"],
  run:    ["execute","invoke","start"],
  get:    ["fetch","read","retrieve"],
};

const TOK_RE = /[a-z0-9]+/g;

export function extractConversationTerms(raw: string): string {
  if (!raw) return "";

  const text = raw.toLowerCase().replace(/[_-]/g, " ");
  const tokens = text.match(TOK_RE) ?? [];

  // Remove stopwords & dedup
  const clean: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (!STOPWORDS.has(t) && !seen.has(t)) { seen.add(t); clean.push(t); }
  }

  // Adjacent bigrams
  const bigrams: string[] = [];
  for (let i = 0; i < clean.length - 1; i++) bigrams.push(clean[i] + " " + clean[i + 1]);

  const combined = [...clean, ...bigrams];

  // Action-verb expansion
  for (const t of clean) {
    const syns = VERB_LEX[t];
    if (syns) combined.push(...syns);
  }

  // Final dedup
  const fin: string[] = [];
  const finSeen = new Set<string>();
  for (const t of combined) {
    if (!finSeen.has(t)) { finSeen.add(t); fin.push(t); }
  }

  return fin.join(" ");
}

// ── FrequencyPriorSource typeguard ───────────────────────────────────────────

function isFrequencyPriorSource(x: unknown): x is FrequencyPriorSource {
  return (
    typeof x === "object" && x !== null &&
    "readRankingEvents" in x &&
    typeof (x as Record<string, unknown>).readRankingEvents === "function"
  );
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

export class RetrievalPipeline {
  private readonly retriever: ToolRetriever;
  private readonly ssm: SessionStateManager;
  private readonly logger: RetrievalLogger;
  private readonly config: RetrievalConfig;
  private readonly reg: Record<string, ToolMapping>;
  private readonly scanner: TelemetryScanner | undefined;
  private readonly metrics: RollingMetrics | undefined;

  /** Tier-3 keyword retriever — set externally if available. */
  public keywordRetriever: ToolRetriever | null = null;
  private readonly ranker = new RelevanceRanker();

  // Per-session maps
  private _turns             = new Map<string, number>();
  private _roots             = new Map<string, string[]>();
  private _evidence          = new Map<string, WorkspaceEvidence>();
  private _toolHist          = new Map<string, string[]>();
  private _argKeys           = new Map<string, string[]>();
  private _routerDescribes   = new Map<string, string[]>();
  private _routerProxies     = new Map<string, string[]>();
  /** Direct-call ledger — ONLY non-proxy calls (HAZARD 5). */
  private _directCalls       = new Map<string, string[]>();
  // Per-turn ledgers — reset at the start of each getToolsForList call
  private _turnDirectCalls       = new Map<string, string[]>();
  private _turnRouterDescribes   = new Map<string, string[]>();
  private _turnRouterProxies     = new Map<string, string[]>();
  private _curTurnUsed       = new Map<string, Set<string>>();
  private _prevTurnUsed      = new Map<string, Set<string>>();
  private _states            = new Map<string, SessionRoutingState>();
  private _inTurn            = new Map<string, boolean>();
  private _pendingRebuild: Record<string, ToolMapping> | null = null;
  private _snapVer           = new Map<string, string>();

  constructor(o: {
    retriever: ToolRetriever;
    sessionManager: SessionStateManager;
    logger: RetrievalLogger;
    config: RetrievalConfig;
    toolRegistry: Record<string, ToolMapping>;
    telemetryScanner?: TelemetryScanner | undefined;
    rollingMetrics?: RollingMetrics;
  }) {
    this.retriever = o.retriever;
    this.ssm       = o.sessionManager;
    this.logger    = o.logger;
    this.config    = o.config;
    this.reg       = o.toolRegistry;          // reference — not copy
    this.scanner   = o.telemetryScanner;
    this.metrics   = o.rollingMetrics;
  }

  // ── Roots / telemetry ────────────────────────────────────────────────

  async setSessionRoots(sid: string, uris: string[]): Promise<void> {
    this._roots.set(sid, uris);
    if (this.config.enableTelemetry && this.scanner) {
      this._evidence.set(sid, await this.scanner.scanRoots(uris));
    }
  }

  // ── Context accessors ─────────────────────────────────────────────────

  getSessionToolHistory(sid: string): string[]     { return [...(this._toolHist.get(sid) ?? [])]; }
  getSessionArgumentKeys(sid: string): string[]    { return [...(this._argKeys.get(sid) ?? [])]; }
  getSessionRouterDescribes(sid: string): string[] { return [...(this._routerDescribes.get(sid) ?? [])]; }

  // ── Index helpers ─────────────────────────────────────────────────────

  private idxOk(): boolean {
    // TODO: Wire when BMXF retriever is connected
    if ('isIndexReady' in this.retriever && typeof (this.retriever as Record<string, unknown>).isIndexReady === 'function') {
      return (this.retriever as unknown as { isIndexReady(): boolean }).isIndexReady();
    }
    return false;
  }

  private hasKw(): boolean { return this.keywordRetriever !== null; }

  private rotateTurnLedgers(sid: string): void {
    this._turnDirectCalls.set(sid, []);
    this._turnRouterDescribes.set(sid, []);
    this._turnRouterProxies.set(sid, []);
  }

  private hasFreq(): boolean {
    return isFrequencyPriorSource(this.logger);
  }

  // ── Tier 4 ────────────────────────────────────────────────────────────

  private classify(ev: WorkspaceEvidence | undefined): [string | null, boolean] {
    if (!ev) return [null, false];
    const keys = new Set(Object.keys(ev.mergedTokens));

    if (keys.has("infra:terraform") || keys.has("infra:kubernetes") || keys.has("manifest:Chart.yaml"))
      return ["infrastructure", true];
    if (keys.has("manifest:Cargo.toml") || keys.has("lang:rust"))
      return ["rust_cli", true];
    if (keys.has("manifest:pyproject.toml") || keys.has("lang:python"))
      return ["python_web", true];
    if (keys.has("manifest:package.json") || keys.has("lang:javascript") || keys.has("lang:typescript"))
      return ["node_web", true];
    if (ev.workspaceConfidence >= 0.45)
      return ["generic", true];
    return [null, false];
  }

  private staticDefaults(pt: string, k: number): ScoredTool[] {
    const cat = STATIC_CATEGORIES[pt];
    if (!cat) return [];

    const result: ScoredTool[] = [];
    const used = new Set<string>();

    for (const ns of cat.always ?? []) {
      for (const [key, m] of Object.entries(this.reg)) {
        if (!used.has(key) && m.serverName === ns) {
          result.push({ toolKey: key, toolMapping: m, score: 1.0, tier: "full" });
          used.add(key);
          break;
        }
      }
    }
    for (const ns of cat.likely ?? []) {
      if (result.length >= k) break;
      for (const [key, m] of Object.entries(this.reg)) {
        if (!used.has(key) && m.serverName === ns) {
          result.push({ toolKey: key, toolMapping: m, score: 0.8, tier: "full" });
          used.add(key);
          break;
        }
      }
    }
    return result.slice(0, k);
  }

  // ── Tier 5 ────────────────────────────────────────────────────────────

  private async freqPrior(k: number): Promise<ScoredTool[]> {
    if (!isFrequencyPriorSource(this.logger)) return [];

    const cutoff = Date.now() / 1000 - 7 * 86400;
    const events = await this.logger.readRankingEvents(cutoff);

    const scores = new Map<string, number>();
    for (const ev of events) {
      const days = (Date.now() / 1000 - ev.timestamp) / 86400;
      const decay = Math.exp(-0.1 * days);
      const used = [
        ...(ev.directToolCalls ?? []),
        ...(ev.routerProxies ?? []),
      ];
      for (const toolId of used) {
        scores.set(toolId, (scores.get(toolId) ?? 0) + decay);
      }
    }

    return Object.entries(this.reg)
      .filter(([key]) => scores.has(key))
      .sort(([a], [b]) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0))
      .slice(0, k)
      .map(([key, mapping]) => ({
        toolKey: key,
        toolMapping: mapping,
        score: scores.get(key) ?? 0,
        tier: "full" as const,
      }));
  }

  // ── Tier 6 ────────────────────────────────────────────────────────────

  private universal(): ScoredTool[] {
    const sel: ScoredTool[] = [];
    const used = new Set<string>();

    // namespace → sorted keys
    const nsMap = new Map<string, string[]>();
    for (const key of Object.keys(this.reg)) {
      const i = key.indexOf("__");
      const ns = i >= 0 ? key.slice(0, i) : "";
      let arr = nsMap.get(ns);
      if (!arr) { arr = []; nsMap.set(ns, arr); }
      arr.push(key);
    }
    for (const a of nsMap.values()) a.sort();

    // Step 1: priority pass
    for (const ns of TIER6_NAMESPACE_PRIORITY) {
      if (sel.length >= 12) break;
      const arr = nsMap.get(ns);
      if (arr) {
        for (const key of arr) {
          if (!used.has(key)) {
            sel.push({ toolKey: key, toolMapping: this.reg[key], score: 1.0, tier: "full" });
            used.add(key);
            break;
          }
        }
      }
    }

    // Step 2: fill remaining
    if (sel.length < 12) {
      for (const key of Object.keys(this.reg).filter((k) => !used.has(k)).sort()) {
        if (sel.length >= 12) break;
        sel.push({ toolKey: key, toolMapping: this.reg[key], score: 0.5, tier: "summary" });
        used.add(key);
      }
    }
    return sel.slice(0, 12);
  }

  // ── Main entry: getToolsForList ────────────────────────────────────────

  async getToolsForList(sid: string, conversationContext?: string): Promise<Tool[]> {
    // 1. Kill-switch
    if (!this.config.enabled) return Object.values(this.reg).map((m) => m.tool);

    const t0 = performance.now();

    // 2. Session group
    const group = getSessionGroup(sid, this.config);

    // 3. Shadow-mode guard (precedes rollout-stage check)
    const isFiltered = !this.config.shadowMode &&
      (this.config.rolloutStage === "ga" ||
        (this.config.rolloutStage === "canary" && group === "canary"));

    // 4. Turn-boundary entry
    if (this._inTurn.get(sid)) {
      this._prevTurnUsed.set(sid, this._curTurnUsed.get(sid) ?? new Set());
      this._curTurnUsed.delete(sid);
      this._inTurn.set(sid, false);
    } else {
      if (!this._prevTurnUsed.has(sid)) this._prevTurnUsed.set(sid, new Set());
    }

    // 5. Pending rebuild (only if NO session is mid-turn — HAZARD 4)
    if (this._pendingRebuild !== null && !Array.from(this._inTurn.values()).some(Boolean)) {
      if ('rebuildIndex' in this.retriever && typeof (this.retriever as Record<string, unknown>).rebuildIndex === 'function') {
        (this.retriever as unknown as { rebuildIndex(r: Record<string, ToolMapping>): void }).rebuildIndex(this._pendingRebuild);
      }
      this._pendingRebuild = null;
    }

    // 6. Load/create state + SSM session
    let state = this._states.get(sid);
    if (!state) {
      state = {
        sessionId: sid, turnNumber: 0, activeToolIds: [], routerEnumToolIds: [],
        alpha: 0, activeK: 0, fallbackTier: 1,
        envConfidence: 0, convConfidence: 0,
        consecutiveLowRank: {}, recentRouterProxies: {}, catalogVersion: "",
        recentRouterDescribes: [], lastRankScores: {},
      };
      this._states.set(sid, state);
    }
    this.ssm.getOrCreateSession(sid);

    // 7. Increment turn
    state.turnNumber += 1;
    const turn = state.turnNumber;
    this._turns.set(sid, turn);

    // 8. Pin catalog version
    let ver = "";
    if ('getSnapshotVersion' in this.retriever && typeof (this.retriever as Record<string, unknown>).getSnapshotVersion === 'function') {
      ver = (this.retriever as unknown as { getSnapshotVersion(): string }).getSnapshotVersion() ?? "";
    }
    this._snapVer.set(sid, ver);
    state.catalogVersion = ver;

    const allKeys = Object.keys(this.reg);
    const candidates = Object.values(this.reg);

    // 9. Dynamic K
    let dK = this.config.topK;
    const ev = this._evidence.get(sid);
    if (ev) {
      const langs = Object.keys(ev.mergedTokens).filter((k) => k.startsWith("lang:"));
      if (langs.length > 1) dK = this.config.maxK;
    }
    dK = Math.min(this.config.maxK, dK);
    const directK = dK; // routing tool is additive — not a K slot (HAZARD 7)

    // 10. Build query strings
    const envQ = ev?.mergedTokens ? Object.keys(ev.mergedTokens).join(" ") : "";
    const convQ = conversationContext ? extractConversationTerms(conversationContext) : "";

    // 11. Confidences
    const wsConf = ev?.workspaceConfidence ?? 0;
    const cvConf = convQ ? Math.min(1.0, convQ.split(" ").length / 10) : 0;

    // 12. Explicit tool mention
    const rawLower = (conversationContext ?? "").toLowerCase();
    const explicitMention = rawLower
      ? allKeys.some((k) => {
          const suffix = k.split("__").pop()!.toLowerCase();
          return suffix.length > 0 && rawLower.includes(suffix);
        })
      : false;

    // 13. 6-tier fallback ladder
    let tier = 1;
    let scored: ScoredTool[] | null = null;
    let alpha = 0;

    const envCtx: RetrievalContext  = { sessionId: sid, query: envQ,  queryMode: "env", toolCallHistory: this._toolHist.get(sid) ?? [] };
    const convCtx: RetrievalContext = { sessionId: sid, query: convQ, queryMode: "nl", toolCallHistory: this._toolHist.get(sid) ?? [] };

    // Tier 1: BMXF blend
    if (!scored && this.idxOk() && envQ && convQ && turn > 0) {
      try {
        const eR = await this.retriever.retrieve(envCtx, candidates);
        const cR = await this.retriever.retrieve(convCtx, candidates);
        alpha = _computeAlpha(turn, wsConf, cvConf, false, explicitMention);
        scored = _weightedRrf(eR, cR, alpha);
        tier = 1;
      } catch { scored = null; }
    }

    // Tier 2: BMXF env-only
    if (!scored && this.idxOk() && envQ) {
      try { scored = await this.retriever.retrieve(envCtx, candidates); tier = 2; }
      catch { scored = null; }
    }

    // Tier 3: Keyword env-only
    if (!scored && this.hasKw() && envQ && this.keywordRetriever) {
      try { scored = await this.keywordRetriever.retrieve(envCtx, candidates); tier = 3; }
      catch { scored = null; }
    }

    // Tier 4: Static categories
    if (!scored) {
      const [pt, conf] = this.classify(ev);
      if (conf && pt) {
        const s = this.staticDefaults(pt, dK);
        if (s.length) { scored = s; tier = 4; }
      }
    }

    // Tier 5: Frequency prior
    if (!scored && this.hasFreq()) {
      const f = await this.freqPrior(dK);
      if (f.length) { scored = f; tier = 5; }
    }

    // Tier 6: Universal fallback
    if (!scored) { scored = this.universal(); tier = 6; }

    // 14. Rank with specificity-aware tiebreaking
    scored = this.ranker.rank(scored);

    // 15. Promote
    const curActive = this.ssm.getActiveTools(sid);
    const activeSet = new Set(curActive);
    const promo: string[] = [];

    // Criterion 1: within K-2
    for (const s of scored.slice(0, Math.max(1, dK - 2))) {
      if (!activeSet.has(s.toolKey)) promo.push(s.toolKey);
    }
    // Criterion 2: router-proxied >= 2 of last 3 turns
    for (const [tk, tArr] of Object.entries(state.recentRouterProxies)) {
      const recent = (tArr as number[]).filter((t) => t >= turn - 3);
      if (recent.length >= 2 && !activeSet.has(tk) && !promo.includes(tk)) promo.push(tk);
    }
    this.ssm.promote(sid, promo);

    // 16. Demote (only after turn 1)
    const afterPromo = this.ssm.getActiveTools(sid);
    const scoreMap = new Map(scored.map((s) => [s.toolKey, s.score]));
    const rankMap  = new Map(scored.map((s, i) => [s.toolKey, i]));
    const k3 = dK + 3;
    const demoCand: string[] = [];

    if (turn > 1) {
      for (const tk of afterPromo) {
        const rank = rankMap.get(tk) ?? scored.length;
        if (rank >= k3) {
          state.consecutiveLowRank[tk] = (state.consecutiveLowRank[tk] ?? 0) + 1;
          if ((state.consecutiveLowRank[tk] ?? 0) >= 2) demoCand.push(tk);
        } else {
          state.consecutiveLowRank[tk] = 0;
        }
      }
    }

    const prevUsed = this._prevTurnUsed.get(sid) ?? new Set();
    const demoted = this.ssm.demote(sid, demoCand, prevUsed, 3);
    for (const k of demoted) delete state.consecutiveLowRank[k];

    // 17. Post-boundary sync
    const postActive = this.ssm.getActiveTools(sid);
    state.activeToolIds = [...postActive].sort((a, b) => {
      const sa = scoreMap.get(a) ?? -Infinity;
      const sb = scoreMap.get(b) ?? -Infinity;
      return sb !== sa ? sb - sa : a < b ? -1 : a > b ? 1 : 0;
    });
    state.routerEnumToolIds = allKeys.filter((k) => !postActive.has(k));

    // 18. Scoring signals
    state.alpha        = alpha;
    state.activeK      = state.activeToolIds.length;
    state.fallbackTier = tier;
    state.envConfidence  = wsConf;
    state.convConfidence = cvConf;

    const latencyMs = performance.now() - t0;

    // 19. Build RankingEvent (HAZARD 5: directCalls from ledger, NOT toolHist)
    const event: RankingEvent = {
      sessionId:         sid,
      turnNumber:        turn,
      catalogVersion:    ver,
      workspaceHash:     ev?.workspaceHash,
      workspaceConfidence: wsConf,
      convConfidence:    cvConf,
      alpha,
      activeK:           state.activeToolIds.length,
      fallbackTier:      tier,
      activeToolIds:     [...state.activeToolIds],
      routerEnumSize:    state.routerEnumToolIds.length,
      directToolCalls:   [...(this._turnDirectCalls.get(sid) ?? [])],
      routerDescribes:   [...(this._turnRouterDescribes.get(sid) ?? [])],
      routerProxies:     [...(this._turnRouterProxies.get(sid) ?? [])],
      scorerLatencyMs:   latencyMs,
      group,
      timestamp:         Date.now() / 1000,
    };

    // 20. Log
    await this.logger.log(event);

    // 21. Rotate turn ledgers after event capture
    this.rotateTurnLedgers(sid);

    // 22. Mark mid-turn
    this._inTurn.set(sid, true);

    // 23. Return
    if (isFiltered) {
      const capped = state.activeToolIds.slice(0, directK);
      const demIds = state.routerEnumToolIds;
      const result: Tool[] = [];
      for (const k of capped) { const m = this.reg[k]; if (m) result.push(m.tool); }

      if (this.config.enableRoutingTool && demIds.length) {
        result.push(buildRoutingToolSchema(demIds));
      }
      return result;
    }

    return Object.values(this.reg).map((m) => m.tool);
  }

  // ── Catalog rebuild (HAZARD 6) ────────────────────────────────────────

  rebuildCatalog(registry: Record<string, ToolMapping>): void {
    if (Array.from(this._inTurn.values()).some(Boolean)) {
      this._pendingRebuild = { ...registry };
      return;
    }
    if ('rebuildIndex' in this.retriever && typeof (this.retriever as Record<string, unknown>).rebuildIndex === 'function') {
      (this.retriever as unknown as { rebuildIndex(r: Record<string, ToolMapping>): void }).rebuildIndex(registry);
    }
    this.metrics?.recordRescore();
  }

  // ── Tool usage recording ──────────────────────────────────────────────

  async onToolCalled(
    sid: string,
    toolName: string,
    args: Record<string, unknown>,
    isRouterProxy?: boolean,
  ): Promise<boolean> {
    if (!this.config.enabled) return false;

    // Turn-scoped usage (demotion protection)
    let u = this._curTurnUsed.get(sid);
    if (!u) { u = new Set(); this._curTurnUsed.set(sid, u); }
    u.add(toolName);

    // Session history — ALL calls including proxy (conv context)
    let h = this._toolHist.get(sid);
    if (!h) { h = []; this._toolHist.set(sid, h); }
    h.push(toolName);

    // Argument keys (conv context)
    let ak = this._argKeys.get(sid);
    if (!ak) { ak = []; this._argKeys.set(sid, ak); }
    ak.push(...Object.keys(args));

    // Direct-call ledger — ONLY non-proxy (HAZARD 5)
    if (!isRouterProxy) {
      let d = this._directCalls.get(sid);
      if (!d) { d = []; this._directCalls.set(sid, d); }
      d.push(toolName);
      const turnDirect = this._turnDirectCalls.get(sid) ?? [];
      turnDirect.push(toolName);
      this._turnDirectCalls.set(sid, turnDirect);
    }

    // Router proxy accounting (CF-2)
    if (isRouterProxy) {
      let rp = this._routerProxies.get(sid);
      if (!rp) { rp = []; this._routerProxies.set(sid, rp); }
      rp.push(toolName);
      const turnProxy = this._turnRouterProxies.get(sid) ?? [];
      turnProxy.push(toolName);
      this._turnRouterProxies.set(sid, turnProxy);

      const state = this._states.get(sid);
      if (state) {
        const curTurn = state.turnNumber;
        const tl: number[] = (state.recentRouterProxies[toolName] as number[]) ?? [];
        if (!tl.length || tl[tl.length - 1] !== curTurn) tl.push(curTurn);
        const cutoff = curTurn - 3;
        state.recentRouterProxies[toolName] = tl.filter((t) => t >= cutoff);
      }
    }

    return false;
  }

  // ── Router describe ───────────────────────────────────────────────────

  recordRouterDescribe(sid: string, toolName: string): void {
    let d = this._routerDescribes.get(sid);
    if (!d) { d = []; this._routerDescribes.set(sid, d); }
    d.push(toolName);
    const turnDescribe = this._turnRouterDescribes.get(sid) ?? [];
    turnDescribe.push(toolName);
    this._turnRouterDescribes.set(sid, turnDescribe);
  }

  // ── Session cleanup ───────────────────────────────────────────────────

  cleanupSession(sid: string): void {
    this._turns.delete(sid);
    this._roots.delete(sid);
    this._evidence.delete(sid);
    this._toolHist.delete(sid);
    this._argKeys.delete(sid);
    this._routerDescribes.delete(sid);
    this._routerProxies.delete(sid);
    this._directCalls.delete(sid);
    this._turnDirectCalls.delete(sid);
    this._turnRouterDescribes.delete(sid);
    this._turnRouterProxies.delete(sid);
    this._curTurnUsed.delete(sid);
    this._prevTurnUsed.delete(sid);
    this._states.delete(sid);
    this._inTurn.delete(sid);
    this._snapVer.delete(sid);
    this.ssm.cleanupSession(sid);
  }
}


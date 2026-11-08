/**
 * Per-session tool set management with bounded demotion support.
 */
import type { RetrievalConfig } from "./models.js";

export class SessionStateManager {
  private readonly _config: RetrievalConfig;
  private readonly _sessions: Map<string, Set<string>> = new Map();

  constructor(config: RetrievalConfig) {
    this._config = config;
  }

  getOrCreateSession(sessionId: string): Set<string> {
    if (!this._sessions.has(sessionId)) {
      this._sessions.set(sessionId, new Set(this._config.anchorTools));
    }
    // Return a copy — callers cannot mutate internal state
    return new Set(this._sessions.get(sessionId));
  }

  getActiveTools(sessionId: string): Set<string> {
    const session = this._sessions.get(sessionId);
    if (!session) return new Set();
    return new Set(session);
  }

  addTools(sessionId: string, toolKeys: string[]): string[] {
    const session = this._sessions.get(sessionId);
    if (!session) return [];
    const newKeys = toolKeys.filter((k) => !session.has(k));
    for (const k of newKeys) session.add(k);
    return newKeys;
  }

  promote(sessionId: string, toolKeys: string[]): string[] {
    return this.addTools(sessionId, toolKeys);
  }

  demote(
    sessionId: string,
    toolKeys: string[],
    usedThisTurn: Set<string>,
    maxPerTurn = 3,
  ): string[] {
    const session = this._sessions.get(sessionId);
    if (!session) return [];

    const safeToDemote = toolKeys.filter(
      (k) => session.has(k) && !usedThisTurn.has(k),
    );
    const demoted = safeToDemote.slice(0, maxPerTurn);
    for (const k of demoted) session.delete(k);
    return demoted;
  }

  cleanupSession(sessionId: string): void {
    this._sessions.delete(sessionId);
  }
}


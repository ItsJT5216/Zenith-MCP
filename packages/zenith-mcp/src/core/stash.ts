import { getProjectContext } from './project-context.js';
import type { FsContext } from './project-context.js';
import type { Edit } from './edit-engine.js';
import {
    DbConnection,
    insertStash,
    getStash,
    updateStashAttempts,
    deleteStash,
    pruneExpiredStash,
    listStash as adapterListStash
} from './db-adapter.js';

const MAX_ATTEMPTS = 2;
export const STASH_TTL_MS = 48 * 60 * 60 * 1000;
const cleanupScheduled = new WeakSet<DbConnection>();

type StashPayload =
    | { edits: Edit[]; failedIndices: number[] }
    | { content: string; mode: string };

function getDb(ctx: FsContext, filePath?: string): { conn: DbConnection; isGlobal: boolean } {
    const pc = getProjectContext(ctx);
    const { db, isGlobal } = pc.getStashDb(filePath);
    return { conn: db, isGlobal };
}

function isExpired(createdAt: number, now = Date.now()): boolean {
    return createdAt <= now - STASH_TTL_MS;
}

/**
 * Wake a one-shot janitor because stash functionality was actually used.
 * There is deliberately no watcher/timer/background resident. Concurrent calls
 * coalesce per DB connection; a later tool use can schedule another pass.
 */
function scheduleCleanupForConnection(conn: DbConnection): void {
    if (cleanupScheduled.has(conn)) return;
    cleanupScheduled.add(conn);
    setImmediate(() => {
        try {
            pruneExpiredStash(conn, Date.now() - STASH_TTL_MS);
        } catch {
            // Maintenance must never fail the user's tool call.
        } finally {
            cleanupScheduled.delete(conn);
        }
    });
}

export function scheduleStashCleanup(ctx: FsContext, filePath?: string): void {
    const { conn } = getDb(ctx, filePath);
    scheduleCleanupForConnection(conn);
}

export function stashEntry(ctx: FsContext, type: string, filePath: string, payload: StashPayload) {
    const { conn } = getDb(ctx, filePath);
    scheduleCleanupForConnection(conn);
    return insertStash(conn, {
        type,
        filePath,
        payload: JSON.stringify(payload),
        createdAt: Date.now()
    });
}

export function getStashEntry(ctx: FsContext, id: number, filePath?: string) {
    const { conn } = getDb(ctx, filePath);
    const row = getStash(conn, id);
    if (!row) return null;
    if (isExpired(row.created_at)) {
        deleteStash(conn, id);
        return null;
    }
    return {
        id: row.id,
        type: row.type,
        filePath: row.file_path ?? null,
        payload: JSON.parse(row.payload),
        attempts: row.attempts,
        createdAt: row.created_at,
    };
}

export function consumeAttempt(ctx: FsContext, id: number, filePath: string) {
    const { conn } = getDb(ctx, filePath);
    const row = getStash(conn, id);
    if (!row) return false;
    if (isExpired(row.created_at)) {
        deleteStash(conn, id);
        return false;
    }
    const next = row.attempts + 1;
    updateStashAttempts(conn, id, next);
    if (next > MAX_ATTEMPTS) {
        deleteStash(conn, id);
        return false;
    }
    return true;
}

export function clearStash(ctx: FsContext, id: number, filePath?: string) {
    const { conn } = getDb(ctx, filePath);
    deleteStash(conn, id);
}

export type ListStashOptions = {
    type?: 'edit' | 'write';
    /** 1-based inclusive newest-first start position. Defaults to 1. */
    start?: number;
    /** 1-based inclusive newest-first end position. Defaults to 10. */
    end?: number;
};

export function listStash(ctx: FsContext, filePath?: string, options: ListStashOptions = {}) {
    const { conn, isGlobal } = getDb(ctx, filePath);
    const start = Math.max(1, Math.trunc(options.start ?? 1));
    const end = Math.max(start, Math.trunc(options.end ?? 10));
    const rows = adapterListStash(conn, {
        ...(filePath !== undefined ? { filePath } : {}),
        ...(options.type !== undefined ? { type: options.type } : {}),
        sinceTimestamp: Date.now() - STASH_TTL_MS,
        start,
        end,
    });
    const entries = rows.map((row) => ({
        id: row.id,
        type: row.type,
        filePath: row.file_path ?? null,
        attempts: row.attempts,
        createdAt: row.created_at,
    }));
    return { entries, isGlobal };
}

export function stashEdits(ctx: FsContext, filePath: string, edits: Edit[], failedIndices: number[]) {
    return stashEntry(ctx, 'edit', filePath, { edits, failedIndices });
}

export function stashWrite(ctx: FsContext, filePath: string, content: string, mode: string) {
    return stashEntry(ctx, 'write', filePath, { content, mode: mode || 'overwrite' });
}

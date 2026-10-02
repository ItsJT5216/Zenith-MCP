import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

// ---------------------------------------------------------------------------
// Process-tree caller-cwd detection — read by exactly two modules.
//
// ⚠ Do NOT import this module anywhere except core/project-context.ts (the
// one resolver: it decides what the candidates mean) and core/caller-cwd.ts
// (it reads the nearest candidate and decides nothing). A guard test
// (tests/detection-encapsulation.test.js) fails the suite if any other module
// imports it.
//
// The kernel records which process spawned us (ppid) and each ancestor's
// current working directory. For terminal-launched MCP hosts, an ancestor's
// cwd IS the directory the user is cd'd into — a definitive, model-free
// signal. For GUI hosts (cwd of "/", home, app bundles) the walk yields
// nothing useful and the junk filter discards it; that is correct behavior,
// not a failure.
//
// Lineage: ported from utils/process-tree.ts (recovered 2026-07-14), upgraded:
//   - TTL cache so a per-tool-call ping costs nothing between refreshes
//     (the original ran once at startup and went stale forever)
//   - ancestor depth 8 (was 5) — deep wrapper chains (turbo → pnpm → npx →
//     node → …) exhausted the old cap
//   - macOS walks the ancestor CHAIN via `ps` (the original only inspected
//     the direct parent), still bounded and timeout-guarded
//   - Windows: ancestor cwds are not readable without native PEB access; we
//     return only our own cwd there, and say so, rather than pretend
// ---------------------------------------------------------------------------

export interface CwdCandidate {
    cwd: string;
    /** Diagnostic label, e.g. "ancestor[1]:bash" or "self:cwd". */
    source: string;
}

const MAX_DEPTH = 8;
const DARWIN_MAX_DEPTH = 4; // each darwin ancestor costs an lsof exec

// ---------------------------------------------------------------------------
// Raw walk (uncached)
// ---------------------------------------------------------------------------

function readLinuxAncestors(): CwdCandidate[] {
    const candidates: CwdCandidate[] = [];
    const seen = new Set<string>();
    let pid = process.ppid;

    for (let depth = 0; depth < MAX_DEPTH && pid > 1; depth++) {
        let statusText: string;
        try {
            statusText = fs.readFileSync(`/proc/${pid}/status`, 'utf-8');
        } catch {
            break; // process gone or /proc unavailable
        }

        try {
            const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
            if (cwd && !seen.has(cwd)) {
                seen.add(cwd);
                const nameLine = statusText.split('\n').find(l => l.startsWith('Name:'));
                const name = nameLine?.split('\t')[1]?.trim() ?? `pid:${pid}`;
                candidates.push({ cwd, source: `ancestor[${depth}]:${name}` });
            }
        } catch {
            // cwd unreadable (permissions) — still continue up the chain
        }

        const ppidLine = statusText.split('\n').find(l => l.startsWith('PPid:'));
        if (!ppidLine) break;
        const next = parseInt(ppidLine.split('\t')[1]?.trim() ?? '0', 10);
        if (isNaN(next) || next <= 1 || next === pid) break;
        pid = next;
    }
    return candidates;
}

function readDarwinAncestors(): CwdCandidate[] {
    const candidates: CwdCandidate[] = [];
    const seen = new Set<string>();
    let pid = process.ppid;

    for (let depth = 0; depth < DARWIN_MAX_DEPTH && pid > 1; depth++) {
        try {
            const lsofOut = execFileSync(
                'lsof',
                ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
                { encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }
            );
            for (const line of lsofOut.split('\n')) {
                if (line.startsWith('n') && line.length > 1) {
                    const cwd = line.slice(1);
                    if (cwd && !seen.has(cwd)) {
                        seen.add(cwd);
                        candidates.push({ cwd, source: `ancestor[${depth}]:pid:${pid}` });
                    }
                }
            }
        } catch {
            // lsof missing/timed out for this ancestor — still try to walk up
        }

        try {
            const ppidOut = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
                encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
            });
            const next = parseInt(ppidOut.trim(), 10);
            if (isNaN(next) || next <= 1 || next === pid) break;
            pid = next;
        } catch {
            break;
        }
    }
    return candidates;
}

/**
 * Walk the process tree for candidate working directories, nearest ancestor
 * first. Always ends with our own process.cwd() as the final candidate.
 * Uncached — prefer {@link getCallerCwds} in hot paths.
 */
export function getProcessTreeCwds(): CwdCandidate[] {
    let candidates: CwdCandidate[] = [];

    if (os.platform() === 'linux') {
        candidates = readLinuxAncestors();
    } else if (os.platform() === 'darwin') {
        candidates = readDarwinAncestors();
    }
    // win32: ancestor cwds require native PEB reads — own cwd only (documented)

    const ownCwd = process.cwd();
    if (!candidates.some(c => c.cwd === ownCwd)) {
        candidates.push({ cwd: ownCwd, source: 'self:cwd' });
    }
    return candidates;
}

/**
 * Like {@link getProcessTreeCwds}, but realpath'd, deduplicated, and filtered
 * to existing directories.
 */
export function getProcessTreeCwdsResolved(): CwdCandidate[] {
    const result: CwdCandidate[] = [];
    const seen = new Set<string>();
    for (const { cwd, source } of getProcessTreeCwds()) {
        try {
            const resolved = fs.realpathSync(path.resolve(cwd));
            if (seen.has(resolved)) continue;
            if (!fs.statSync(resolved).isDirectory()) continue;
            seen.add(resolved);
            result.push({ cwd: resolved, source });
        } catch {
            // nonexistent / inaccessible — skip
        }
    }
    return result;
}

// ---------------------------------------------------------------------------
// TTL-cached entry point — what ProjectContext actually calls per tool call.
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 5000;
let _cached: CwdCandidate[] | null = null;
let _cachedAt = 0;

/**
 * TTL-cached resolved candidates. The walk (and on macOS, its subprocesses)
 * runs at most once per TTL window no matter how many tool calls ping it.
 */
export function getCallerCwds(ttlMs: number = DEFAULT_TTL_MS): CwdCandidate[] {
    if (_cached && Date.now() - _cachedAt < ttlMs) return _cached;
    _cached = getProcessTreeCwdsResolved();
    // Stamp AFTER the walk: a slow walk (macOS lsof chains) stamped before
    // completion would leave the cache expired-on-arrival, re-running the
    // full walk on every subsequent call (review finding P2-6).
    _cachedAt = Date.now();
    return _cached;
}

/** Test hook — drops the TTL cache. */
export function clearCallerCwdCache(): void {
    _cached = null;
    _cachedAt = 0;
}

import path from 'path';
import fs from 'fs';
import os from 'os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getDb } from './symbol-index.js';
import { ProjectRegistry } from './project-registry.js';
import type { ProjectManifest } from './project-registry.js';
import { normalizePath } from './path-utils.js';
import {
    DbConnection,
    openDb,
    initStashSchema,
    initObservationSchema,
    recordProjectObservation,
} from './db-adapter.js';
import type { ProjectEntry } from '../config/schema.js';
import { expandTilde, CONFIG_PATH } from '../config/schema.js';
import { loadConfig } from '../config/loader.js';
import { findProjectBoundary, isJunkRoot } from './detection/boundaries.js';
import { getCallerCwds } from './detection/process-tree.js';

const ZENITH_HOME = path.join(os.homedir(), '.zenith-mcp');
const GLOBAL_DB_PATH = path.join(ZENITH_HOME, 'global-stash.db');

// ---------------------------------------------------------------------------
// Filesystem context interface
// ---------------------------------------------------------------------------

export interface FsContext {
    getAllowedDirectories(): string[];
    validatePath?: (p: string) => string | Promise<string>;
}

// ---------------------------------------------------------------------------
// Project root registry — persists manually-init'd project roots so they
// survive reconnects without requiring git.
// ---------------------------------------------------------------------------

let _globalDb: DbConnection | null = null;

function getGlobalDb(): DbConnection {
    if (_globalDb) return _globalDb;
    fs.mkdirSync(ZENITH_HOME, { recursive: true });
    _globalDb = openDb(GLOBAL_DB_PATH);
    return _globalDb;
}

// ---------------------------------------------------------------------------
// ProjectContext — the single authority on "what project am I in?"
//
// Binding tiers, strongest first (a weaker signal never displaces a stronger):
//   explicit  — initProject() binding; sticky for the session
//   registry  — config-file project match (~/.zenith-mcp/config, ### Projects)
//   detected  — git/marker boundary found from tool-call path evidence,
//               granted allowed dirs, or the caller's process-tree cwd via
//               pingCallerEnvironment()
//
// Tier is strength; ORIGIN is provenance, tracked separately in
// _boundOrigin. pingCallerEnvironment() re-evaluates every call unless the
// current binding is explicit or selected by configured/granted roots:
// environment is ambient evidence, so a binding LEARNED from it (origin
// 'environment', any tier) must never disable the discovery that produced
// it, and a positive path/detection binding follows the environment the
// moment the caller demonstrably moved. A config/registry binding is the
// user's fixed answer while valid; detected grants have the same precedence.
//
//   global    — ~/.zenith-mcp/global-stash.db. A fallback, NEVER a refusal.
//
// Materialization policy (anti-litter): detection is SIGNAL, promotion is
// CONSENT. Only explicit/registry tiers may host a .mcp database; detected
// roots route persistence to the global DB and are observation-counted for
// the opt-in auto_promote_sessions policy. Detected-tier binding still gives
// correct identity, clamping, and notifications — it just never writes into
// the user's directories.
//
// Detection helpers live in ./detection/ as pure functions. They are PRIVATE
// to this class — tests/detection-encapsulation.test.js fails the suite if
// anything else imports them. That guard exists because this codebase once
// grew three competing resolvers out of exactly this kind of drift
// (removed 2026-05-25 in b18fa09, remnants deleted 2026-07-14, detection
// restored INSIDE this class 2026-07-14). One resolver. Keep it that way.
// ---------------------------------------------------------------------------

type BindingTier = 'explicit' | 'registry' | 'detected' | 'global';

/** Where the current binding came from. Distinct from tier: tier is
 *  precedence strength, origin is provenance. The environment ping
 *  distinguishes them — a registry-TIER binding with environment ORIGIN
 *  (caller cwd matched a registered project) stays ambient and re-derives,
 *  while a config/registry-origin binding is a deliberate, fixed answer. */
type BindingOrigin = 'explicit' | 'config' | 'detection' | 'environment' | null;

export class ProjectContext {
    private _ctx: FsContext;
    private _boundRoot: string | null;
    private _isGlobal: boolean;
    private _resolved: boolean;
    private _explicit: boolean;
    private _tier: BindingTier;
    private _generation: number = 0;
    /** Cache-isolation salt: the boundary LRU is module-global, but sessions
     *  (one ProjectContext each in the HTTP entrypoint) have different allowed
     *  dirs — without a per-instance salt they could poison each other's
     *  clamped results (review finding P2-3). */
    private static _nextInstanceId = 1;
    private readonly _instanceId: number = ProjectContext._nextInstanceId++;
    /** Distinct-session marker for observation counting — unique per instance
     *  AND per process, so restarts count as new sessions. */
    private readonly _sessionMarker: string =
        `${process.pid}:${this._instanceId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
    /** Roots already observed/notified this session (idempotence gate). */
    private _observedRoots: Set<string> = new Set();
    private _registry: ProjectRegistry;
    private _notifiedRoots: Set<string> = new Set();
    private _notifyFn: ((message: string) => void) | null = null;
    private _lastConfigMtimeMs: number = 0;
    /** Provenance of the current binding — see BindingOrigin. */
    private _boundOrigin: BindingOrigin = null;

    constructor(ctx: FsContext) {
        this._ctx = ctx;
        this._boundRoot = null;
        this._isGlobal = false;
        this._resolved = false;
        this._explicit = false;
        this._tier = 'global';
        this._registry = new ProjectRegistry();
    }

    /** Current binding tier — diagnostic surface for tests and logging. */
    get bindingTier(): BindingTier {
        return this._tier;
    }

    /** Current binding origin — diagnostic surface for tests and logging. */
    get bindingOrigin(): BindingOrigin {
        return this._boundOrigin;
    }

    /** Isolate this invocation's binding without creating another observation session.
     *  Registry/observation sets are shared; mutable routing fields are copied.
     *  AsyncLocalStorage ends with the call's async work, not a client connection. */
    runForCall<T>(handler: () => T): T {
        const project = Object.assign(Object.create(ProjectContext.prototype) as ProjectContext, this);
        let cwd: string | undefined;
        try { cwd = this.getRoot() ?? this._ctx.getAllowedDirectories()[0]; } catch { /* best effort */ }
        return _callContext.run({ ctx: this._ctx, project, cwd }, handler);
    }

    // --- Public API ---

    /**
     * Get the project root. Resolution: registry match first, then git/marker
     * boundary detection (tool-call path evidence), then global fallback.
     * Pass an optional filePath to trigger the per-access auto-switch.
     */
    getRoot(filePath?: string): string | null {
        if (filePath) {
            // Registry-first auto-switch — the registry IS the answer
            this._handlePathAccess(filePath);
            return this._boundRoot;
        }

        // No file path — return current binding (may be null/global)
        if (this._resolved) return this._boundRoot;
        this._resolveNoFile();
        return this._boundRoot;
    }

    /** Persistence root: only explicit/registered projects may host a .mcp DB.
     *  Unregistered detection uses the neutral workspace. This is NOT the cwd
     *  selector for relative filesystem operations or bash execution. */
    getWorkingRoot(hint?: string): string {
        const root = this.getRoot(hint);
        // Materialization gate (same policy as getStashDb): only registered
        // or explicit projects may host a .mcp database. Detected roots,
        // granted dirs, and file dirnames are NEVER returned here — that is
        // exactly how .mcp litter happened historically. Everything
        // unregistered goes to the neutral workspace, which is real, ours,
        // and scatters nothing.
        //
        // SEAM (edit-tool merge): when the global DB gains symbol schema
        // (getSymbolDb + absolute-path keying), replace the workspace floor
        // below with global-DB routing — one line, tools unchanged.
        if (root && (this._tier === 'explicit' || this._tier === 'registry')) return root;

        const workspace = path.join(ZENITH_HOME, 'workspace');
        try {
            fs.mkdirSync(workspace, { recursive: true });
            return workspace;
        } catch {
            // Pathological (read-only home) — degrade to home itself rather
            // than break the non-null contract. getDb may still fail there,
            // but never-refuse means WE don't originate the refusal.
            return os.homedir();
        }
    }

    /**
     * Get the stash DB for the current project context.
     */
    getStashDb(filePath?: string): { db: DbConnection; root: string | null; isGlobal: boolean } {
        const root = this.getRoot(filePath);
        // Materialization gate: only REGISTERED (config/promoted) and EXPLICIT
        // (stashInit) projects get project-scoped DBs. A DETECTED root is
        // routing identity, not consent to create .mcp there — its
        // persistence goes to the global DB until the project is promoted.
        // This is the anti-litter policy: detection is signal, promotion is
        // deliberate.
        if (root && (this._tier === 'explicit' || this._tier === 'registry')) {
            const conn = getDb(root);
            ensureStashTables(conn);
            return { db: conn, root, isGlobal: false };
        }
        const conn = getGlobalDb();
        ensureStashTables(conn);
        return { db: conn, root: null, isGlobal: true };
    }

    /**
     * Is the current context using the global fallback?
     */
    get isGlobal(): boolean {
        if (!this._resolved) this._resolveNoFile();
        return this._isGlobal;
    }

    /**
     * Force re-resolution. Called when MCP roots change.
     * Explicit bindings (set via initProject) are preserved — they are sticky.
     */
    refresh(): void {
        this._generation++; // invalidate cached boundary results
        if (!this._explicit) {
            this._boundRoot = null;
            this._isGlobal = false;
            this._resolved = false;
            this._tier = 'global';
            this._boundOrigin = null;
        }
        // Don't re-sync from SQLite on refresh — config registry is authoritative
        if (!this._explicit) {
            this._resolveNoFile();
        }
    }

    /**
     * Manually register a project root (stashInit).
     * In-memory only — config file is the persistent source of truth.
     */
    initProject(rootPath: string, name?: string): string {
        const abs = path.resolve(rootPath);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
            throw new Error(`Not a directory: ${abs}`);
        }

        // Register in-memory for immediate use
        this._registry.register({
            project_id: path.basename(abs),
            project_name: name || path.basename(abs),
            project_root: abs,
        });

        // Bind to this project immediately (sticky — overrides any auto-promote)
        this._boundRoot = abs;
        this._isGlobal = false;
        this._resolved = true;
        this._explicit = true;
        this._tier = 'explicit';
        this._boundOrigin = 'explicit';
        return abs;
    }

    /**
     * Register an MCP root as a session hint. Does NOT set _explicit,
     * does NOT persist to SQLite, does NOT block auto-switching.
     * Only binds if it matches a registered project.
     */
    registerSessionRoot(rootPath: string, _name?: string): void {
        const normalizedRoot = normalizePath(path.resolve(rootPath));
        if (this._explicit) return;

        // Registered project? Bind at registry tier.
        const manifest = this._registry.findProject(normalizedRoot);
        if (manifest) {
            this._boundRoot = normalizePath(path.resolve(manifest.project_root));
            this._isGlobal = false;
            this._resolved = true;
            this._tier = 'registry';
            this._boundOrigin = 'config';
            console.error(
                `[ProjectContext] Session root matched project: ${manifest.project_id}`
            );
            return;
        }

        // Unregistered MCP root — boundary-detect it. Only upgrades from
        // global; a session hint never displaces registry or path evidence.
        if (this._tier === 'global') {
            const boundary = this._detectBoundary(normalizedRoot);
            if (boundary) {
                this._bindDetected(boundary.root, boundary.method, 'session root');
            }
        }
    }

    /**
     * Reload the registry from config entries. Atomic replacement.
     * Config file is authoritative — SQLite-persisted entries are NOT merged.
     */
    reloadRegistry(entries: ProjectEntry[]): void {
        const manifests: ProjectManifest[] = [];
        for (const e of entries) {
            if (!e.project_id || !e.project_root) continue;

            let resolvedRoot = normalizePath(path.resolve(expandTilde(e.project_root)));
            // Canonicalize symlinks so registry matches realpath'd tool paths
            try { resolvedRoot = fs.realpathSync(resolvedRoot); } catch { /* dir may not exist yet */ }

            const m: ProjectManifest = {
                project_id: e.project_id,
                project_name: e.project_name,
                project_root: resolvedRoot,
            };
            if (e.description != null) m.description = e.description;
            if (e.language != null) m.language = e.language;
            if (e.tags !== undefined) m.tags = e.tags;
            if (e.include !== undefined) m.include = e.include;
            if (e.exclude !== undefined) m.exclude = e.exclude;
            if (e.entry_point != null) m.entry_point = e.entry_point;

            manifests.push(m);
        }

        // Replace entirely — old registry is GC'd, no _syncRegistry
        this._registry = new ProjectRegistry(manifests);
        this._generation++; // invalidate cached boundary results

        // This registry now represents the current config state. Snapshot the
        // config mtime so the next registry miss does not immediately reload
        // the same file and replace a registry that was just established.
        try {
            this._lastConfigMtimeMs = fs.statSync(CONFIG_PATH).mtimeMs;
        } catch {
            this._lastConfigMtimeMs = 0;
        }

        // Re-evaluate current binding against new registry. Only REGISTRY-tier
        // bindings depend on the registry; detected bindings stand on their
        // own filesystem evidence and survive a registry reload.
        if (this._boundRoot && !this._explicit && this._tier === 'registry') {
            const match = this._registry.findProject(this._boundRoot);
            if (!match) {
                this._boundRoot = null;
                this._isGlobal = true;
                this._tier = 'global';
                this._boundOrigin = null;
            }
        }

        // Clear notification dedup so new paths can be notified fresh
        this._notifiedRoots.clear();

        console.error(`[ProjectContext] Registry reloaded: ${manifests.length} projects`);
    }

    /**
     * Set the notification function (fires sendLoggingMessage).
     */
    setNotifyFn(fn: (message: string) => void): void {
        this._notifyFn = fn;
    }

    // --- Private resolution ---

    /**
     * Registry-based auto-switch. Called from getRoot() on every file access.
     * Fast-path: if path is inside current bound root, no-op (one string check).
     * Only hits the registry when path is OUTSIDE current root.
     * Lazy reload: on miss, re-reads config if file changed since last load.
     */
    private _handlePathAccess(resolvedPath: string): void {
        // Fast path — same project, free string comparison
        if (this._boundRoot !== null) {
            if (this._isPathInside(resolvedPath, this._boundRoot)) {
                // Registry outranks detected: a detected binding yields when a
                // registered project claims this exact path (review finding
                // P2-8 — e.g. a config-registered subpackage nested inside a
                // detected monorepo root could otherwise never win). The
                // lookup is in-memory only — no filesystem cost on this path.
                if (this._tier === 'detected') {
                    const claim = this._registry.findProject(resolvedPath);
                    if (claim) {
                        const claimRoot = normalizePath(path.resolve(claim.project_root));
                        if (claimRoot !== this._boundRoot) {
                            this._boundRoot = claimRoot;
                            console.error(
                                `[ProjectContext] Registered project outranks detected root: ${claim.project_id} (${claimRoot})`
                            );
                        }
                        this._tier = 'registry';
                        // The claim came from path evidence, not from the
                        // environment ping — the binding is now path-held.
                        this._boundOrigin = 'detection';
                    }
                }
                return;
            }
        }

        // Path is outside current root — check registry
        let manifest = this._registry.findProject(resolvedPath);

        // Lazy reload: if miss, check if config file changed and retry once
        if (!manifest) {
            if (this._tryLazyReload()) {
                manifest = this._registry.findProject(resolvedPath);
            }
        }

        if (manifest && !this._explicit) {
            // Matched a registered project — switch. Gated on !_explicit:
            // explicit bindings are sticky against EVERY signal, registry
            // included (review finding P1-1 — the guard was historically
            // missing from this branch, contradicting initProject's contract).
            const newRoot = normalizePath(path.resolve(manifest.project_root));
            if (newRoot !== this._boundRoot) {
                this._boundRoot = newRoot;
                this._isGlobal = false;
                this._resolved = true;
                console.error(
                    `[ProjectContext] Switched to project: ${manifest.project_id} (${newRoot})`
                );
            }
            this._tier = 'registry';
            this._boundOrigin = 'detection';
        } else if (!this._explicit) {
            // No registry match — tool-call path evidence through the boundary
            // finders (git → markers, clamped, junk-filtered, cached).
            const boundary = this._detectBoundary(resolvedPath);
            if (boundary) {
                this._bindDetected(boundary.root, boundary.method, 'path evidence');
            } else {
                // No evidence at all. Absence of evidence never demotes an
                // affirmative binding (review finding P2-4): one stray read of
                // ~/notes.txt must not flip the session's DB routing to global
                // and reopen the door to environment rebinding. Only an
                // unresolved session settles to global here.
                if (!this._resolved) {
                    this._boundRoot = null;
                    this._isGlobal = true;
                    this._resolved = true;
                    this._tier = 'global';
                    this._boundOrigin = null;
                }
                // Notify once per unique unrecognized root (gated on allowed dirs)
                this._notifyGlobalFallback(resolvedPath);
            }
        }
        // If _explicit, ignore — explicit bindings are sticky
    }

    /**
     * Bind a DETECTED root — the single funnel for all four detection sites
     * (path evidence, allowed dirs, caller cwd, session roots). Detection is
     * SIGNAL, not consent: binding here sets routing identity only; the
     * materialization gates in getStashDb/getWorkingRoot decide whether a
     * project DB may exist. Also records the observation (once per root per
     * session), notifies the host, and applies the opt-in auto-promotion
     * policy (advanced.auto_promote_sessions, or the
     * ZENITH_AUTO_PROMOTE_SESSIONS env override).
     */
    private _bindDetected(root: string, method: 'git' | 'marker', source: string): void {
        let promoted = false;

        if (!this._observedRoots.has(root)) {
            this._observedRoots.add(root);
            try {
                const conn = getGlobalDb();
                initObservationSchema(conn);
                const count = recordProjectObservation(conn, {
                    rootPath: root,
                    method,
                    sessionId: this._sessionMarker,
                });

                let threshold = 0;
                const envOverride = parseInt(process.env['ZENITH_AUTO_PROMOTE_SESSIONS'] ?? '', 10);
                if (!isNaN(envOverride) && envOverride >= 0) {
                    threshold = envOverride;
                } else {
                    try { threshold = loadConfig().advanced.auto_promote_sessions; } catch { /* defaults */ }
                }

                if (threshold > 0 && count >= threshold) {
                    // Opt-in auto-promotion: in-memory registration only. The
                    // config file stays the user-owned source of truth — we
                    // never write to it uninvited.
                    this._registry.register({
                        project_id: path.basename(root),
                        project_name: path.basename(root),
                        project_root: root,
                    });
                    promoted = true;
                    this._notify(
                        `Auto-promoted "${root}" to a registered project after ${count} distinct sessions ` +
                        `(auto_promote_sessions=${threshold}). Its project database is active for this session — ` +
                        `add it to ~/.zenith-mcp/config under ### Projects to make it permanent.`
                    );
                } else {
                    const promoteHint = threshold > 0
                        ? ` Auto-promotes after ${threshold} distinct sessions.`
                        : '';
                    this._notify(
                        `Detected ${method}-based project at "${root}" (seen in ${count} distinct ` +
                        `session${count === 1 ? '' : 's'}). Routing persistence to the global DB until it is ` +
                        `registered — add it to ~/.zenith-mcp/config under ### Projects or run stashInit to promote.` +
                        promoteHint
                    );
                }
            } catch { /* observation + notification are best-effort, never block binding */ }
        }

        if (root !== this._boundRoot) {
            this._boundRoot = root;
            console.error(
                `[ProjectContext] ${promoted ? 'Promoted' : 'Detected'} project via ${method} (${source}): ${root}`
            );
        }
        this._isGlobal = false;
        this._resolved = true;
        const registered = this._registry.findProject(root);
        this._tier = promoted || registered?.project_root === root ? 'registry' : 'detected';
        // An auto-promotion earned through CALLER-CWD evidence is not a
        // user-fixed selection: keep the origin environmental so the ping
        // keeps re-deriving when the caller's cwd moves. The registry match
        // still wins later pings (see pingCallerEnvironment), so a promoted
        // root re-binds after a detour through another project — it is
        // never accidentally downgraded.
        this._boundOrigin = source.startsWith('caller cwd') ? 'environment'
            : source === 'allowed dir' || source === 'session root' ? 'config' : 'detection';
    }

    /** Fire the host notification channel, tolerating unready transports. */
    private _notify(message: string): void {
        if (!this._notifyFn) return;
        try { this._notifyFn(message); } catch { /* transport not ready */ }
    }

    /** Boundary detection with the session's allowed dirs and cache generation. */
    private _detectBoundary(absPath: string, noCache = false): { root: string; method: 'git' | 'marker' } | null {
        let allowedDirs: string[] = [];
        try { allowedDirs = this._ctx.getAllowedDirectories(); } catch { /* mock ctx */ }
        return findProjectBoundary(absPath, {
            allowedDirectories: allowedDirs,
            generation: this._generation,
            cacheSalt: this._instanceId,
            noCache,
        });
    }

    /**
     * No-file resolution: registry match on allowed dirs first, then boundary
     * detection of the allowed dirs themselves (a granted dir that IS a repo
     * is a strong, user-supplied signal), then global. Process-tree evidence
     * is deliberately NOT consulted here — it arrives only via
     * pingCallerEnvironment() at the dispatch seam.
     */
    private _resolveNoFile(): void {
        this._resolved = true;

        // Check if any allowed directory matches a registered project
        const allowedDirs = this._ctx.getAllowedDirectories();
        for (const dir of allowedDirs) {
            try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
            const manifest = this._registry.findProject(dir);
            if (manifest) {
                this._boundRoot = normalizePath(path.resolve(manifest.project_root));
                this._isGlobal = false;
                this._tier = 'registry';
                this._boundOrigin = 'config';
                return;
            }
        }

        // No registry match — boundary-detect the granted directories
        // themselves (an allowed dir that IS a repo is a strong signal).
        for (const dir of allowedDirs) {
            try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
            const boundary = this._detectBoundary(dir, true);
            if (boundary) {
                this._bindDetected(boundary.root, boundary.method, 'allowed dir');
                return;
            }
        }

        // Nothing — global mode. Process-tree evidence arrives separately via
        // pingCallerEnvironment() at the dispatch seam; it upgrades from here.
        this._boundRoot = null;
        this._isGlobal = true;
        this._tier = 'global';
        this._boundOrigin = null;
    }

    /** Re-read ambient evidence on every dispatch, including after detection.
     *  Deliberate explicit/granted selections still win. Ambient registry matches
     *  remain ambient, and incidental file access does not pin later calls. */
    pingCallerEnvironment(): void {
        if (this._explicit) return;
        this._tryLazyReload();
        // Recheck grants so path access or changed hints cannot erase their
        // precedence; a missing grant is not accepted as a usable directory.
        if (!this._resolved || this._ctx.getAllowedDirectories().length > 0) this._resolveNoFile();
        if (this._boundOrigin === 'config' && this._boundRoot) {
            try { if (fs.statSync(this._boundRoot).isDirectory()) return; } catch { /* retry evidence */ }
        }

        for (const candidate of getCallerCwds()) {
            if (isJunkRoot(candidate.cwd)) continue;
            const manifest = this._registry.findProject(candidate.cwd);
            if (manifest) {
                const newRoot = normalizePath(path.resolve(manifest.project_root));
                try { if (!fs.statSync(newRoot).isDirectory()) continue; } catch { continue; }
                if (newRoot !== this._boundRoot || this._tier !== 'registry') {
                    console.error(`[ProjectContext] Caller cwd matched project: ${manifest.project_id} (${candidate.source})`);
                }
                this._boundRoot = newRoot;
                this._isGlobal = false;
                this._resolved = true;
                this._tier = 'registry';
                this._boundOrigin = 'environment';
                return;
            }

            // Ambient evidence must not reuse a permanent positive/negative
            // boundary cache after markers or directories change. The nearest
            // positive candidate wins EVEN when it agrees with the current root;
            // skipping that candidate would let a weaker ancestor replace it.
            const boundary = this._detectBoundary(candidate.cwd, true);
            if (boundary) {
                this._bindDetected(boundary.root, boundary.method, `caller cwd, ${candidate.source}`);
                return;
            }
        }

        // Preserve a valid prior affirmative binding when evidence is unavailable,
        // but never keep a deleted/non-directory root as a usable cwd.
        if (this._boundRoot) {
            try { if (fs.statSync(this._boundRoot).isDirectory()) return; } catch { /* invalidate */ }
            this._boundRoot = null;
            this._isGlobal = true;
            this._resolved = true;
            this._tier = 'global';
            this._boundOrigin = null;
        }
    }

    /**
     * Only notify for paths under allowed directories — suppress system/temp paths.
     * Deduplicate by finding the nearest project-ish root.
     */
    private _notifyGlobalFallback(resolvedPath: string): void {
        if (!this._notifyFn) return;

        // Only notify for paths under allowed directories
        const allowedDirs = this._ctx.getAllowedDirectories();
        if (allowedDirs.length > 0) {
            const isUnderAllowed = allowedDirs.some(
                dir => resolvedPath === dir || resolvedPath.startsWith(dir + path.sep)
            );
            if (!isUnderAllowed) return;
        }

        // Deduplicate by the probable project root of this unregistered path
        const rootGuess = this._findNearestProjectishRoot(resolvedPath);
        if (this._notifiedRoots.has(rootGuess)) return;
        this._notifiedRoots.add(rootGuess);

        this._notifyFn(
            `Path "${rootGuess}" is not a registered project. Using global DB. ` +
            `Add it to ~/.zenith-mcp/config under ### Projects to enable project-scoped features.`
        );
    }

    /**
     * Walk up from resolvedPath looking for .git or common markers.
     * Capped at allowed-directory boundaries to avoid unbounded filesystem traversal.
     * Used ONLY for notification dedup keys — NOT for project resolution.
     */
    private _findNearestProjectishRoot(resolvedPath: string): string {
        const markers = ['.git', 'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml'];
        const allowedDirs = this._ctx.getAllowedDirectories();
        let dir = path.dirname(resolvedPath);
        const root = path.parse(dir).root;

        while (dir !== root) {
            for (const marker of markers) {
                try {
                    fs.statSync(path.join(dir, marker));
                    return dir;
                } catch { /* not found, keep walking */ }
            }
            // Stop at the allowed-dir boundary — don't walk above it
            if (allowedDirs.some(ad => dir === ad)) break;
            dir = path.dirname(dir);
        }

        return path.dirname(resolvedPath);
    }

    /**
     * Check if a path is inside (or equal to) a root directory.
     * Uses case-insensitive comparison on Windows/macOS where filesystems are
     * typically case-insensitive.
     */
    private _isPathInside(filePath: string, root: string): boolean {
        if (process.platform === 'win32' || process.platform === 'darwin') {
            const fp = filePath.toLowerCase();
            const rt = root.toLowerCase();
            return fp === rt || fp.startsWith(rt + path.sep);
        }
        return filePath === root || filePath.startsWith(root + path.sep);
    }

    /**
     * Lazy reload: re-read config file only if its mtime changed since last load.
     * Returns true if the registry was actually refreshed (caller should retry lookup).
     */
    private _tryLazyReload(): boolean {
        try {
            const stat = fs.statSync(CONFIG_PATH);
            if (stat.mtimeMs === this._lastConfigMtimeMs) return false;
            this._lastConfigMtimeMs = stat.mtimeMs;
        } catch {
            // Config file doesn't exist — nothing to reload
            return false;
        }

        try {
            const config = loadConfig();
            this.reloadRegistry(config.projects);
            return true;
        } catch {
            return false;
        }
    }

}

// ---------------------------------------------------------------------------
// Stash table setup — reused by both project DBs and the global DB
// ---------------------------------------------------------------------------

function ensureStashTables(conn: DbConnection): void {
    initStashSchema(conn);
}

// ---------------------------------------------------------------------------
// Singleton + integration hooks
// ---------------------------------------------------------------------------

// Invocation-local routing, not a session/caller map. The process context still
// owns registry/observation lifetime; each async call owns its root snapshot.
const _callContext = new AsyncLocalStorage<{ ctx: FsContext; project: ProjectContext; cwd: string | undefined }>();

/** Registered/explicit operation roots may be marker-only, not necessarily git.
 *  Undefined preserves legacy standalone indexing for other cases; a neutral
 *  storage directory must never masquerade as the source file's project root. */
export function getCallPersistenceRoot(filePath: string): string | undefined {
    const project = _callContext.getStore()?.project;
    if (!project) return undefined;
    const root = project.getRoot(filePath);
    if (!root || (project.bindingTier !== 'explicit' && project.bindingTier !== 'registry')) return undefined;
    const relative = path.relative(root, filePath);
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
        ? root : undefined;
}

export function getCallWorkingDirectory(ctx: FsContext): string | undefined {
    const call = _callContext.getStore();
    return call?.ctx === ctx ? call.cwd : undefined;
}

let _instances = new WeakMap<FsContext, ProjectContext>();

export function getProjectContext(ctx: FsContext): ProjectContext {
    const call = _callContext.getStore();
    if (call?.ctx === ctx) return call.project;
    let instance = _instances.get(ctx);
    if (!instance) {
        instance = new ProjectContext(ctx);
        _instances.set(ctx, instance);
    }
    return instance;
}

/** Reset the context — for test isolation only. */
export function resetProjectContext(ctx?: FsContext): void {
    if (ctx) {
        _instances.delete(ctx);
        return;
    }
    _instances = new WeakMap<FsContext, ProjectContext>();
}

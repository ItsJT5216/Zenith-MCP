#!/usr/bin/env node
import { loadDotEnvFiles } from '../core/env-loader.js';

// Load `.env` files before this entrypoint reads `process.env`. ESM static
// imports are evaluated before this module's body, so any env var consumed
// at an imported module's top level will already have been read — keep
// entrypoint-level reads (including the API-key check below) after this
// call. The shared loader walks cwd → package root → workspace root and
// honours the `ZENITH_ENV_FILE` override.
const _loadedEnvFiles = loadDotEnvFiles(import.meta.url);

// ---------------------------------------------------------------------------
// http.ts — Native HTTP entrypoint for MCP (2026-07-28 spec, stateless)
//
// Usage:
//   node dist/server/http.js [allowed-directory ...] [--port=3100] [--host=0.0.0.0]
//
// Supports:
//   POST /mcp          — MCP requests: modern 2026-07-28 envelope, plus 2025-era
//                        requests served per-request via the SDK's built-in
//                        `legacy: 'stateless'` fallback (no sessions, no
//                        Mcp-Session-Id; GET/DELETE answered 405 by the SDK)
//   GET  /health       — Simple health check
//
// Statelessness: every request is served by a FRESH McpServer instance from the
// factory below (upstream guidance — a reused singleton leaks onclose handlers,
// modelcontextprotocol/typescript-sdk#2607). Process-wide state lives outside
// the factory: one FilesystemContext, module-level tool caches, and SQLite.
// Project scope is derived per tool call by ProjectContext (core/detection) —
// no MCP Roots dependency.
// ---------------------------------------------------------------------------

import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { createRequire } from 'module';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createFilesystemContext } from '../core/lib.js';
import {
    registerEnabledTools,
    resolveInitialAllowedDirectories,
    validateDirectories,
    SERVER_INSTRUCTIONS,
    setupProjectDetection,
} from '../core/server.js';
import { ripgrepAvailable } from '../core/shared.js';
import { configExists, loadConfig } from '../config/index.js';
import type { ToolServer } from '../tools/types.js';

const _require = createRequire(import.meta.url);
const _pkg = _require('../../package.json') as { version: string };

// ---------------------------------------------------------------------------
// First-run wizard — ensure config exists before proceeding
// ---------------------------------------------------------------------------
if (!configExists()) {
    console.error(
        'No Zenith-MCP config found.\n' +
        'Run the stdio server once interactively to complete first-time setup:\n' +
        '  npx zenith-mcp /path/to/your/project\n' +
        '(replace /path/to/your/project with an absolute path to a directory you want the server to access)\n' +
        'Then restart the HTTP server.',
    );
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let cliPort: number | undefined;
let host = '0.0.0.0';
const dirArgs: string[] = [];
for (const arg of args) {
    if (arg.startsWith('--port=')) {
        const portStr = arg.slice('--port='.length);
        cliPort = parseInt(portStr, 10);
    } else if (arg.startsWith('--host=')) {
        host = arg.slice('--host='.length);
    } else if (!arg.startsWith('--')) {
        dirArgs.push(arg);
    }
}

// Load config and resolve port: CLI --port flag overrides config value
const config = loadConfig();
const port = cliPort ?? config.port;

// ---------------------------------------------------------------------------
// API key authentication — Bearer token via ZENITH_API_KEY env var.
//
// This is a high-entropy bearer token, not a user-chosen password. We never
// persist it, never log it, and never expose any derived value over the
// wire — it is only compared in-memory against the request header. The
// correct primitive for that comparison is `timingSafeEqual` on the raw
// bytes, with an independent length check to keep the comparison constant
// time even when the caller-supplied token has a different length than the
// configured key. We deliberately do NOT hash the key: any hash function
// (including HMAC) is the wrong abstraction here — there is no value to
// digest at rest, and hashing only invites tooling to treat the bytes as a
// password.
// ---------------------------------------------------------------------------
const ZENITH_API_KEY = process.env.ZENITH_API_KEY || process.env.ZENITH_MCP_API_KEY || '';
if (!ZENITH_API_KEY) {
    console.error(
        'ZENITH_API_KEY or ZENITH_MCP_API_KEY environment variable is required for the HTTP transport.\n' +
        'Zenith accepts only a Bearer token format for authorization.',
    );
    process.exit(1);
}

// Pre-encode the expected key once at startup and reuse the buffer for
// every comparison. The value is process-lifetime immutable and never
// handed to callers.
const EXPECTED_API_KEY_BYTES = Buffer.from(ZENITH_API_KEY, 'utf8');

const authRateLimiter = rateLimit({
    windowMs: 60_000,
    limit: 3_000,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests' },
    handler: (_req, res, _next, options) => {
        res.status(options.statusCode).json(options.message);
    },
});

// Resolve and validate the baseline allowed directories from CLI args.
// These are process-level: with no sessions there is nothing to widen or
// narrow per client, and project scope is derived per tool call.
const baselineAllowedDirs = await resolveInitialAllowedDirectories(dirArgs);
if (baselineAllowedDirs.length > 0) {
    await validateDirectories(baselineAllowedDirs);
}

function writeErrorLog(message: string, err: unknown): void {
    const detail = err instanceof Error && err.stack ? err.stack : String(err);
    process.stderr.write(`${message} ${detail}\n`);
}

// ---------------------------------------------------------------------------
// Process context + per-request server factory.
//
// ONE FilesystemContext for the whole process; every per-request McpServer
// reads it. Project detection is wired once at boot — its notifications go to
// stderr because a stateless server has no persistent client channel to log to.
// ---------------------------------------------------------------------------
const ctx = createFilesystemContext([...baselineAllowedDirs]);

setupProjectDetection(ctx, (message) => {
    console.error(`[zenith-mcp] ${message}`);
});

const handler = createMcpHandler(
    () => {
        const server = new McpServer(
            { name: 'zenith-mcp', version: _pkg.version },
            { instructions: SERVER_INSTRUCTIONS },
        );
        registerEnabledTools(server as unknown as ToolServer, ctx);
        return server;
    },
    { legacy: 'stateless', keepAliveMs: 15_000 },
);

const mcpNodeHandler = toNodeHandler(handler, {
    onerror: (error) => writeErrorLog('[mcp] adapter error:', error),
});

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '4mb' }));

function requireApiKey(req: Request, res: Response, next: NextFunction): void {
    const authMatch = req.headers.authorization?.match(/^Bearer\s+(\S.*)$/i);
    const provided = authMatch?.[1] ?? '';
    const providedBytes = Buffer.from(provided, 'utf8');

    // Constant-time equality: compare the provided bytes against the
    // expected key when lengths match, otherwise compare the expected key
    // against itself. This keeps timingSafeEqual on equal-length inputs
    // (avoiding throws) and runs in constant time relative to the expected
    // key length without any per-request allocation or copy.
    const lengthEqual = providedBytes.length === EXPECTED_API_KEY_BYTES.length;
    const compareBuffer = lengthEqual ? providedBytes : EXPECTED_API_KEY_BYTES;
    const bytesEqual = timingSafeEqual(compareBuffer, EXPECTED_API_KEY_BYTES);

    if (bytesEqual && lengthEqual) {
        next();
    } else {
        res.status(401).json({ error: 'Invalid or missing API key.' });
    }
}

app.get('/', (_req, res) => {
    res.json({
        name: 'zenith-mcp',
        status: 'ok',
        mcp: '/mcp',
    });
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        auth: {
            mcp: 'api-key',
        },
        baselineDirs: baselineAllowedDirs.length,
    });
});

// ── MCP: all verbs on /mcp go to the SDK handler ──────────────────────────────
// express.json() has already consumed the request stream, so the parsed body is
// handed to the adapter as its documented third argument. Method semantics are
// the SDK's: POST serves modern + 2025-stateless traffic; GET and DELETE
// (2025 session operations) are answered 405.
app.all('/mcp', authRateLimiter, requireApiKey, (req, res) => {
    mcpNodeHandler(req, res, req.body).catch((err: unknown) => {
        writeErrorLog('[mcp] unhandled error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(port, host, () => {
    console.error(`Zenith-MCP HTTP Server listening on http://${host}:${port}`);
    console.error(`  MCP (2026-07-28, stateless; 2025 fallback): POST /mcp`);
    console.error(`  Health:          GET /health`);
    if (_loadedEnvFiles.length > 0) {
        console.error(`  Loaded env:      ${_loadedEnvFiles.join(', ')}`);
    } else {
        console.error(`  Loaded env:      none (set ZENITH_ENV_FILE or place .env in cwd/package/workspace root)`);
    }
    ripgrepAvailable().then(ok =>
        console.error(ok ? '  Ripgrep: available' : '  Ripgrep: not found — JS fallback for search')
    );
});

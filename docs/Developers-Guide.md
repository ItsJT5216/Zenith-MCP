# Zenith-MCP Developer Documentation & Cheat Sheet

Internal developer guidance for Zenith-MCP tool design, implementation, and maintenance.

This document is intentionally stricter and more implementation-focused than the public README. The README sells the project. This file keeps tool behavior honest, compact, and aligned with the current MCP contract.

---

## CRITICAL: Context Efficiency Is a Product Feature

Zenith-MCP is used by agents. Tool output is model context. Context bloat directly hurts reasoning, memory, latency, and edit reliability.

Previous tool design failures produced extreme output bloat: roughly 7.5× useless output for every 1× useful information.

### Design Rule

Return only **new, decision-relevant information**.

Do not return information the caller already knows, can infer from the request, or can retrieve from a separate tool whose scope already covers that job.

### Required Workflow

- Do not parrot request inputs back in responses.
- Do not return paths, selectors, mode names, line ranges, old text, new text, diffs, metadata, or summaries unless they are required for disambiguation or recovery.
- Keep every tool inside its explicit scope.
- Do not duplicate metadata, diagnostics, diff inspection, search, or file-info functionality across unrelated tools.
- Prefer minimal success responses.
- Avoid decorative headers, separators, and "nice" formatting that costs tokens without changing the caller's next action.

### Response Discipline

Success should usually be tiny:

```text
Applied.
```

Dry-run should usually be minimal:

```text
Dry run successful.
```

Failure should include only actionable new information:

```json
{"error":"OLD_TEXT_NOT_FOUND"}
```

```json
{"error":"PARSE_ERROR","message":"Expression expected.","line":91}
```

### Single-Target Rule

If the caller sent one path, do not echo that path back.

Include identifiers such as path, edit index, or symbol only when needed to distinguish multiple targets, multiple failures, or recovery steps.

### Enforced Repo Policy

When designing or modifying tools, optimize for:

- minimal output
- scope-correct output
- non-duplicative output
- actionable failure details
- zero "look how powerful I am" backend boasting in tool returns

When unsure whether to include a field, omit it unless it clearly changes the caller's next action.

---

## 1. Architecture Snapshot

Zenith-MCP is a TypeScript monorepo managed with `pnpm`. The repository is split into two workspace packages:

- **`packages/zenith-mcp`** — The core Model Context Protocol (MCP) server.
- **`packages/zenith-toon`** — The TypeScript-based TOON compression library (zero runtime dependencies).

All source code is written in TypeScript and resides inside the respective package `src/` directories. Output builds compile to `dist/` directories via `tsc`.

### Entry Points

- **`packages/zenith-mcp/src/cli/stdio.ts`** → `dist/cli/stdio.js` (binary: `zenith-mcp`)
  - stdio transport
  - One process, one `FilesystemContext`, one `McpServer`
  - CLI directories provide the baseline allowed-directory sandbox
  - Starts with or without directories; MCP Roots are not used (project scope is derived per call)

- **`packages/zenith-mcp/src/server/http.ts`** → `dist/server/http.js` (binary: `zenith-mcp-http`)
  - Express HTTP server
  - Streamable HTTP plus legacy SSE
  - Bearer-token auth (fatal exit if no key set)
  - Per-session `{ ctx, server }` isolation
  - Idle session reaping via `session_ttl_ms` config setting

### Core Orchestrator

- **`packages/zenith-mcp/src/core/server.ts`**
  - `registerEnabledTools(toolServer, ctx)` — each entrypoint creates its own `McpServer` and passes it in; `withCallerEnvironmentPing` forwards the SDK's per-call `extra` to every handler
  - `TOOL_REGISTRY` constant: single source of truth for all 12 tools
  - Config-driven tool enable/disable
  - Loads adapter settings
  - Retrieval code exists under `src/retrieval/`, but it is disabled by default and excluded from the main package compile
  - No MCP Roots wiring — project scope is derived per call by `ProjectContext`

### Core Modules (`packages/zenith-mcp/src/`)

| Module | Responsibility |
|--------|----------------|
| `core/lib.ts` | `FilesystemContext`, path validation, file I/O, diffs, stats |
| `core/shared.ts` | Ripgrep integration, BM25 search/ranking, sensitive-file detection |
| `core/tree-sitter.ts` | WASM grammar loading, query loading, symbols, definitions, syntax checks, structural fingerprints |
| `core/edit-engine.ts` | Pure in-memory content/block/symbol edit verification and application |
| `core/symbol-index.ts` | SQLite symbol DB, impact graph, version snapshots, patterns |
| `core/db-adapter.ts` | Node.js native `node:sqlite` abstraction layer (pure functional adapter) |
| `core/project-context.ts` | Single routing authority: explicit binding → config-file registry (`~/.zenith-mcp/config`) → global fallback |
| `core/project-registry.ts` | Explicit project matching/registration |
| `core/stash.ts` | SQLite-backed edit/write stash API |
| `core/compression.ts` | Compression budget math and subprocess bridge invocation |
| `core/toon_bridge.ts` | In-process TOON compression via `zenith-toon` imports |
| `adapters/` | MCP client config adapters |
| `config/` | Adapter settings, config schemas, and wizards |
| `retrieval/` | Opt-in tool retrieval/filtering pipeline |

### Build Artifacts

- All compiled JS goes to `dist/` (gitignored).
- `grammars/` (containing WASM grammars) is tracked source in `packages/zenith-mcp/grammars/`.
- Build copies `grammars/` into `dist/grammars/`.

---

## 2. Security Model

### Allowed Directory Sandbox

All filesystem operations must validate target paths through `ctx.validatePath()` before any filesystem read/write/stat/delete/move.

Validation flow:

1. Expand `~`
2. Resolve to absolute path
3. Normalize
4. Check requested path against allowed directories
5. Resolve symlinks with `realpath`
6. Re-check resolved path against allowed directories
7. Return the validated path

If validation fails, the tool must fail before touching the filesystem.

The [`bash`](#bash) tool is the one exception: `ctx.validatePath()` gates only its `cwd`. The command runs with the server's privileges and is not confined to the allowed directories.

### Sensitive File Filtering

`isSensitive()` blocks credential-like files from search/index/discovery output using configured `minimatch` patterns.

Typical defaults include:

- `.env`
- `*.pem`
- `*.key`
- `*.crt`
- `*credentials*`
- `*secret*`
- `.config/**`

Direct read/write security is primarily the allowed-directory sandbox. Search/index/discovery tools also apply sensitive-file filtering.

### Write Safety

Writes follow the established safe-write pattern:

- Create parent directories when appropriate
- Use exclusive creation (`wx`) where needed
- Use temp-file + `rename()` for atomic replacement
- Verify write size when available
- Stash failed write payloads when recovery is useful

---

## 3. Search & Semantics

### Tree-sitter

Zenith uses `web-tree-sitter` and tracked WASM grammars to parse code structurally (40+ languages, lazy-loaded, LRU-cached).

Tree-sitter powers:

- `edit_file` symbol mode
- `search_file` symbol lookup
- `search_files` symbol mode
- `search_files` definition mode
- `refactor_batch` symbol loading/outlier detection
- Syntax warnings after edits
- Structured compression anchors

Guidelines:

- Use symbols for code-aware targeting.
- Use grep/content search only when text matching is the right operation.
- Never fake symbol behavior with line-number guesses when tree-sitter can locate the target.

### BM25 + Ripgrep

`search_files content` uses a staged pipeline:

1. BM25 file pre-filter over file paths and content snippets
2. Ripgrep over candidate files
3. BM25 post-rank when result lines exceed the ranking threshold (`RANK_THRESHOLD = 50`)
4. Budget-aware truncation

The BM25 implementation (`BM25Index` class) is zero-dependency, inline, and uses entropy weighting (high-entropy terms are downweighted) plus sigmoid TF saturation.

Keep output result-focused. Do not dump search diagnostics unless they explain a failure or change the caller's next step.

### Symbol Index

Each project can get a `.mcp/symbols.db` SQLite database.

Key tables:

- `files`
- `symbols`
- `edges`
- `versions`
- `patterns`

Used for:

- Impact queries
- Caller/callee traversal
- Version snapshots
- Rollback
- Reapply pattern support

The `.mcp/` database directory is generated project state and should stay gitignored.

---

## 4. Editing Model

### `edit_file`

`edit_file` is the primary surgical edit tool.

Supported edit modes:

- `content`
  - `oldContent`
  - `newContent`

- `block`
  - `block_start`
  - `block_end`
  - `replacement_block`

- `symbol`
  - `symbol`
  - `newText`
  - `nearLine` (optional)

Top-level args:

- `path`
- `edits[]`
- `dryRun`

### Edit Verification

The edit engine is memory-first:

1. Read file
2. Normalize line endings
3. Apply every edit to an in-memory working string
4. If any edit fails, write nothing
5. If dry-run, return a minimal preview/diff
6. If successful, atomic-write the result
7. Snapshot touched symbols best-effort
8. Return minimal success plus only necessary warnings

Content matching tries:

1. Exact match
2. Trimmed trailing whitespace match
3. Indentation-stripped match near `nearLine` (±50-line window)

Symbol matching uses tree-sitter bounds. Prefer this for code edits when the symbol is known.

### Stash Recovery

Failed edit/write payloads can be stashed and retried through `stashRestore`.

Current `stashRestore` modes:

- `apply`
- `restore`
- `list`
- `read`

Important distinction:

- `stashRestore restore` clears a stash entry by ID.
- Symbol version rollback is handled by `refactor_batch restore`.
- Symbol history is handled by `refactor_batch history`.
- Project root registration is not a `stashRestore` mode.

Keep stash responses concise. Return the stash ID and only the failed edit indices/details needed for the next correction.

---

## 5. Current Tool Catalog

| Tool | Scope | Key Args |
|------|-------|----------|
| `read_file` | Read one text file with windowing/truncation/compression | `path`, `maxChars`, `head`, `tail`, `offset`, `aroundLine`, `context`, `ranges`, `showLineNumbers`, `compression` |
| `read_media_file` | Read supported media as base64 | `path` |
| `read_multiple_files` | Read up to 50 files with budget balancing; output is line-numbered by default | `paths`, `maxCharsPerFile`, `compression` |
| `write_file` | Create/overwrite/append text | `path`, `content`, `failIfExists`, `append` |
| `edit_file` | Surgical content/block/symbol edits | `path`, `edits[]`, `dryRun` |
| `directory` | Directory list/tree exploration | `mode: list/tree`, `path`, `depth`, `includeSizes`, `sortBy`, `excludePatterns`, `showSymbols`, `showSymbolNames` |
| `search_files` | Multi-file content/files/symbol/definition search | `mode`, `path`, mode-specific query fields |
| `search_file` | Single-file grep or symbol lookup | `path`, `grep`, `grepContext`, `symbol`, `nearLine`, `expandLines`, `maxChars` |
| `file_manager` | mkdir/delete/move/info | `mode`, `path`, `source`, `destination` |
| `stashRestore` | Retry/inspect/clear stashed edit/write failures | `mode: apply/restore/list/read`, `stashId`, `corrections`, `newPath`, `dryRun`, `type` |
| `refactor_batch` | Cross-file symbol refactoring and symbol version rollback | `mode: query/loadDiff/apply/reapply/restore/history` |
| `bash` | Run a bash command; terminal-style transcript, exit code reported as data | `command`, `cwd`, `timeout` |

### Tool Notes

#### `read_file`

No `mode` enum. Uses a single flat schema, not a discriminated union.

Use it for reading text ranges/windows. Do not add grep or symbol lookup here; those belong to `search_file`.

#### `search_file`

Single-file grep/symbol lookup.

Use for:

- "grep this one file"
- "read this symbol body"
- "show context around this symbol"

#### `directory`

Modes:

- `list`
- `tree`

No `roots` mode. No `listAllowed`.

Allowed directories come from the command line and are exposed through context, not a public directory mode.

#### `search_files`

Modes:

- `content`
- `files`
- `symbol`
- `definition`

Keep modes distinct. Do not make `content` return file metadata beyond what is needed for search hits.

#### `file_manager`

Modes:

- `mkdir`
- `delete`
- `move`
- `info`

`delete` is file-only unless intentionally changed and reviewed.

#### `refactor_batch`

Modes:

- `query`
- `loadDiff`
- `apply`
- `reapply`
- `restore`
- `history`

Schema highlights:

- `query`: `target`, `fileScope`, `direction`, `depth`
- `loadDiff`: `selection`, `contextLines`, `loadMore`
- `apply`: `payload`, `dryRun`
- `reapply`: `symbolGroup`, `newTargets`, `ack`, `dryRun`
- `restore`: `symbol`, `file`, `version`, `dryRun`
- `history`: `symbol`, `file`

Do not document or call `load`; the mode is `loadDiff`.

Do not use `target`/`fileScope` for `restore` or `history`; those use `symbol`/`file`.

#### `bash`

Runs `bash -c <command>` and returns a terminal-style transcript.

- First line is the prompt: `<cwd>$ <command>`.
- Last line is the status: `[exit code N]`, `[terminated by SIGxxx]`, `[timed out after Ns; process group killed]`, `[cancelled; process group killed]`, or `[cancelled]` when the request was cancelled before the shell started. `[exit code unknown]` is the fallback for an exit Node reports with neither a code nor a signal, which its `exit` event documents as never happening.
- A non-zero exit is data on the status line, not a tool error. The error channel is only for the tool itself failing: invalid `cwd`, `bash not found.`, spawn failure.
- `timeout` defaults to `bash_timeout_seconds` (120) and is clamped to `bash_max_timeout_seconds` (600); both live under `### Advanced`.
- Output is returned in full, rendered as it arrives the way a terminal shows it: `\r`, backspace, erase-in-line and cursor-to-column are modelled per line (cells are code points, so a tab or a wide character is one cell); colours and other sequences, control strings (OSC/DCS/SOS/PM/APC, newlines included) and stray control bytes are removed.
- stdin is closed. Start services detached with output redirected.
- On timeout, or when the client cancels the request (the SDK's `extra.signal`, forwarded to every handler by `withCallerEnvironmentPing`), the command's process group gets SIGTERM, then SIGKILL after 2 s (Windows: `taskkill /T /F`); captured output is still returned. The call completes only once the group is gone or the SIGKILL is out, so a descendant in the group that ignores SIGTERM is still killed; a job moved to its own group (`set -m`) is not reached.
- Commands still running are swept (SIGKILL to the group) when the server exits or receives SIGTERM/SIGINT/SIGHUP; the listener runs first and re-raises the signal with its default disposition only when it is the sole listener. A process that outlives its command (a detached service) is not tracked or swept.
- Cursor motion in the output never creates cells — a move past the end of the line lands at the end — so no escape parameter can make the renderer allocate.
- An explicit `cwd` is path evidence: it rebinds project detection exactly like a file tool's path.
- The allowed-directory sandbox gates only `cwd`. The command runs with the server's privileges and can reach anything the server process can.

Enabled by default like every tool; `bash: disabled` under `### Tools` turns it off.

---

## 6. Project Root Resolution

Project root resolution is separate from filesystem access control.

Allowed directories answer:

> What can the agent access?

Project root resolution answers:

> Where should project-scoped state such as `.mcp/symbols.db` live?

Resolution ladder:

1. Git repo from the file path or cwd
2. MCP roots / allowed directories
3. Project markers such as `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, etc.
4. Explicit project registry
5. Global fallback at `~/.zenith-mcp/`

Never let project-root fallback expand filesystem permissions. Only `allowedDirectories` control access.

---

## 7. Refactor Workflow

Typical safe workflow:

1. `search_files` or `refactor_batch query`
2. `refactor_batch loadDiff`
3. Inspect outliers
4. `refactor_batch apply` with `dryRun: true`
5. `refactor_batch apply`
6. `refactor_batch history` / `restore` only when rollback is needed

### Query

`query` uses the symbol graph:

- `forward`: callers of target
- `reverse`: callees from target
- `depth`: 1–5

### loadDiff

`loadDiff` loads symbol bodies plus context.

It also computes outlier flags from symbol structure:

- Parameter shape
- Return type
- Parent scope
- Decorators
- Modifiers

### apply

`apply` gates on:

- Loaded cache exists
- Payload parses
- Outliers acknowledged
- Character budget
- Syntax checks
- Per-file edit atomicity

A failed edit in one file must not write that file. Other independent files may still apply if their bundles pass.

### reapply

`reapply` uses a cached successful payload against new targets.

It must repeat outlier detection and syntax gates. Cached payload is not permission to skip validation.

### restore/history

Use these for symbol version snapshots:

```json
{"mode":"history","symbol":"AuthService.login","file":"src/auth.ts"}
```

```json
{"mode":"restore","symbol":"AuthService.login","file":"src/auth.ts","version":0,"dryRun":true}
```

---

## 8. Adapter System

Adapters live in `packages/zenith-mcp/src/adapters/`.

Purpose: auto-configure external MCP clients to register Zenith.

Key pieces:

- `packages/zenith-mcp/src/adapters/base.ts`
  - `MCPConfigAdapter` abstract base class
- `packages/zenith-mcp/src/adapters/platforms/`
  - Per-client adapter implementations
- `packages/zenith-mcp/src/adapters/registry.ts`
  - Adapter registry with `configureRegistry()`, `listAdapters()`
- `packages/zenith-mcp/src/adapters/helpers/`
  - JSON5, TOML, YAML parsing and output format helpers

Settings (in `~/.zenith-mcp/config`):

- `auto_write.status` — enable/disable auto-write
- `auto_write.backup_dir` — backup directory for config file changes
- `auto_write.backup_mode` — `file`, `sqlite`, or `none`
- `auto_write.custom_mcp_paths` — additional MCP config paths to scan

There is no separate CLI — the first-run wizard handles initial setup.

Keep adapter write operations conservative:

- Read native config
- Preserve unknown fields
- Backup before mutation
- Write only necessary changes
- Never print entire config files unless explicitly requested

---

## 9. Config Management

Config management lives in `packages/zenith-mcp/src/config/`.

Config file: `~/.zenith-mcp/config` (plain-text format with `###` subsection headers, `key: value` pairs, `#` comments).

Modules:

- `parser.ts` — Reads/writes the plain-text config format; produces an ordered `RawConfig` array for round-trip fidelity
- `schema.ts` — `ZenithConfig` interface, `DEFAULT_CONFIG`, `configToRaw()`, `rawToConfig()`
- `loader.ts` — `loadConfig()`, `saveConfig()`, `mergeToolsIntoConfig()` (dynamic tool discovery)
- `wizard.ts` — First-run interactive wizard (auto-write, backup mode, port, char_budget)
- `auto-write.ts` — Registers Zenith in other MCP clients via adapters
- `backup.ts` — SQLite/file/none backup modes

Key sections in the config file: `### Tools` (dynamic enable/disable), `### Auto Write`, `### Zenith-Rag`, `### Advanced` (all tuning params).

Developer rule: MCP tool responses should remain minimal regardless of config system verbosity.

---

## 10. Retrieval Pipeline

Retrieval is opt-in and disabled by default.

Enabled via `defaultRetrievalConfig()` in `packages/zenith-mcp/src/retrieval/models.ts` (defaults to `enabled: false`).

Purpose: reduce active tool-list bloat when Zenith manages or proxies larger tool sets.

Fallback ladder:

1. BMXF blend of environment + conversation signals
2. BMXF environment-only
3. Keyword environment-only
4. Static project categories
5. Frequency prior
6. Universal fallback

Key components:

- `packages/zenith-mcp/src/retrieval/pipeline.ts`
- `packages/zenith-mcp/src/retrieval/session.ts`
- `packages/zenith-mcp/src/retrieval/ranking/`
- `packages/zenith-mcp/src/retrieval/telemetry/`
- `packages/zenith-mcp/src/retrieval/observability/`
- `packages/zenith-mcp/src/retrieval/routing-tool.ts`
- `packages/zenith-mcp/src/retrieval/zenith-integration.ts`

The synthetic routing tool can expose demoted tools on demand. Track proxy usage separately from direct usage.

> **Note:** The retrieval source directory is currently excluded from the main TypeScript compilation in `tsconfig.json`.

---

## 11. Compression

Compression is TypeScript-based under `packages/zenith-toon` and has no Python dependency.

Flow:

1. `read_file` / `read_multiple_files` request compression
2. `compressTextFile()` computes the budget (`DEFAULT_COMPRESSION_KEEP_RATIO = 0.70`)
3. `runToonBridge()` spawns the compiled JS bridge (subprocess with 30s timeout)
4. `toon_bridge_cli.js` reads the file, parses tree-sitter structure, and performs compression in-process via `zenith-toon` package
5. Caller accepts compressed output only if it is actually useful (`isCompressionUseful()`)

Important nuance:

- `compression.ts` uses a Node subprocess for isolation/timeouts.
- The bridge itself performs in-process TypeScript compression.
- "No Python" does not mean "no child process."

---

## 12. Adding or Changing a Tool

Checklist:

1. Add or edit `packages/zenith-mcp/src/tools/<tool>.ts`.
2. Export `register(server, ctx)`.
3. Use strict Zod schemas.
4. Every filesystem path must pass through `ctx.validatePath()` before filesystem access.
5. Set annotations:
   - `readOnlyHint`
   - `idempotentHint`
   - `destructiveHint`
6. Register the tool in `TOOL_REGISTRY` in `packages/zenith-mcp/src/core/server.ts`.
7. Add/update tests.
8. Keep output minimal.
9. Update README only for public-facing behavior.
10. Update ARCHITECTURE.md for detailed implementation behavior.
11. Update this file for developer-facing cheat-sheet changes.

Path field checklist:

- Single target: `path`
- Source/destination pair: `source`, `destination`
- Refactor symbol file hint: `file`
- Query scope hint: `fileScope`

Do not invent parallel names unless there is a compatibility reason.

---

## 13. Testing Notes

The project uses **Vitest**.

General flow:

```bash
pnpm install
pnpm build
pnpm test          # vitest run --coverage
```

Tests may import compiled `dist/` modules or source directly (Vitest compiles TS on-the-fly).

Tree-sitter tests require grammars to exist under `packages/zenith-mcp/dist/grammars/`, which the build script copies from `packages/zenith-mcp/grammars/`.

Generated local state to clean when needed:

- `dist/` directories
- `coverage/`
- `.mcp/`
- `~/.zenith-mcp/`

---

## 14. Code Snippets

### Rank Search Results

```ts
import { bm25RankResults, getCharBudget } from '../core/shared.js';

const ranked = bm25RankResults(rawRipgrepLines, 'authentication logic', getCharBudget());
```

### Validate Before Filesystem Access

```ts
const validPath = await ctx.validatePath(args.path);
const content = await fs.readFile(validPath, 'utf8');
```

### Minimal Tool Return

```ts
return {
  content: [{ type: 'text', text: 'Applied.' }],
};
```

---

## 15. Things Not To Regress

- Do not reintroduce `read_text_file`.
- Do not add grep or symbol modes back into `read_file`.
- Do not document `directory.roots`.
- Do not document `directory.listAllowed`.
- Do not use `refactor_batch load`; use `loadDiff`.
- Do not use `target`/`fileScope` for `refactor_batch restore/history`; use `symbol`/`file`.
- Do not move runtime-only generated state into git.
- Do not put grammars back under `dist/` as source of truth.
- Do not make tool returns verbose just because the backend has impressive internals.
- Do not describe BMX-Plus as BPE or as using pre-trained models — it is an original, unpublished lexical search algorithm built on BM25's TF saturation curve with term-adaptive entropy-aware IDF, variance-blended informativeness, and tanh Soft-AND coverage bonus. TAAT posting-list architecture. No pre-trained components. Benchmarked on 9 BEIR datasets (~8.2M docs), 1.5–26× speedups, NDCG@10 within ±0.02 of BM25.

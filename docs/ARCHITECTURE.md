# Zenith-MCP Architecture

## 1. System Overview

Zenith-MCP is a high-performance Model Context Protocol (MCP) server engineered for agentic workflows. It implements advanced filesystem operations, code comprehension, and context compression to minimize token footprint and maximize reasoning efficiency.

The repository is structured as a TypeScript monorepo using `pnpm` workspace management, divided into two core packages:

- **`packages/zenith-mcp`** — The MCP server implementing the protocol, filesystem capabilities, adapters, and search.
- **`packages/zenith-toon`** — Zenith's TypeScript TOON compression codec, invoked by Zenith-MCP through a Node subprocess bridge.

```
                     ┌───────────────────┐
                     │    MCP Client     │
                     └─────────┬─────────┘
                               │ (JSON-RPC via stdio/HTTP)
                               ▼
                     ┌───────────────────┐
                     │ packages/zenith-  │
                     │ mcp (Server)      │
                     └─────────┬─────────┘
                               │
            ┌──────────────────┴──────────────────┐
            ▼                                     ▼
  ┌───────────────────┐                 ┌───────────────────┐
  │   SQLite DBs      │                 │  packages/zenith- │
  │ (Symbols, Stash)  │                 │  toon (Codec)     │
  └───────────────────┘                 └───────────────────┘
```

### Repository Layout

```
zenith-mcp-monorepo/
├── packages/
│   ├── zenith-mcp/          # Main MCP server
│   │   ├── src/
│   │   │   ├── adapters/    # IDE platform adapters
│   │   │   ├── cli/         # CLI entry (stdio transport)
│   │   │   ├── config/      # Config loading & validation
│   │   │   ├── core/        # Server, DB, symbols, edits, tree-sitter
│   │   │   ├── retrieval/   # Opt-in tool retrieval/filtering pipeline
│   │   │   ├── scripts/     # Utility scripts
│   │   │   ├── server/      # HTTP/SSE transport (Express)
│   │   │   ├── tools/       # MCP tool implementations
│   │   │   └── utils/       # Project scope utilities
│   │   ├── tests/           # Vitest test suite
│   │   └── grammars/        # Tree-sitter WASM grammars (source of truth)
│   └── zenith-toon/         # TOON compression codec library
│       └── src/
├── src/                     # Root-level bridge & types
│   ├── core/                # toon_bridge_cli.js
│   └── types/               # Vendor type declarations
├── docs/                    # Documentation & design notes
├── patches/                 # @modelcontextprotocol/sdk patch
├── turbo.json               # Turborepo pipeline config
├── pnpm-workspace.yaml      # pnpm workspace definition
└── tsconfig.json            # Root TypeScript project references
```

---

## 2. Compilation and Build Pipeline

All sources are written in TypeScript under `src/` in each package.

- **Build Output**: Compiled JavaScript outputs to `dist/` directories (gitignored).
- **Grammars**: Tree-sitter WASM grammars reside in `packages/zenith-mcp/grammars/` (tracked source) and are copied to `packages/zenith-mcp/dist/grammars/` during the build process to enable runtime loading.
- **Build Command**: `tsc && shx cp -r grammars dist/ && shx chmod +x dist/cli/*.js dist/server/*.js`
- **Build Order**: zenith-toon → zenith-mcp (enforced via TypeScript project references and pnpm sequential build)
- **TypeScript**: ES2022 target, NodeNext module resolution, strict mode with `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`

---

## 3. Server Lifecycle & Execution Modes

### 3.1 stdio Transport (Single-Tenant)

- **Entry Point**: `packages/zenith-mcp/src/cli/stdio.ts` → `dist/cli/stdio.js`
- **Binary**: `zenith-mcp`
- Runs as a persistent subprocess spawned by the MCP client.
- Allocates a single `FilesystemContext` initialized with allowed paths passed via command-line arguments.
- Starts with or without allowed directories; MCP Roots are not used — project scope is derived per call by `ProjectContext` (§5.8).
- First-run wizard routes to stderr to keep stdout clean for JSON-RPC.

### 3.2 HTTP Transport (Multi-Tenant)

- **Entry Point**: `packages/zenith-mcp/src/server/http.ts` → `dist/server/http.js`
- **Binary**: `zenith-mcp-http`
- Runs as an **Express** HTTP server supporting Streamable HTTP and legacy SSE transports.
- Employs Bearer Token authentication via `ZENITH_MCP_API_KEY` (fallbacks: `MCP_BRIDGE_API_KEY`, `COMMANDER_API_KEY`). Fatal exit if no key is set.
- Maintains isolated `FilesystemContext` and `McpServer` instances per session token.
- Automatically reaps inactive sessions via configurable `session_ttl_ms` (default: 30 minutes).
- Session reaper interval: 60 seconds.

**Endpoints:**

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/mcp` | Streamable HTTP (initialize + messages) |
| `GET` | `/mcp` | Streamable HTTP SSE notification stream |
| `DELETE` | `/mcp` | Session teardown |
| `GET` | `/sse` | Legacy SSE transport |
| `POST` | `/messages` | Legacy SSE message endpoint |
| `GET` | `/health` | Health check (session count, baseline dirs, TTL) |

---

## 4. Security & Path Sandboxing

To prevent directory traversal and unauthorized filesystem modifications:

1. All path arguments must pass through `FilesystemContext.validatePath()`.
2. Paths are expanded (`~`), resolved to absolute coordinates, and normalized.
3. Symlinks are resolved via `fs.realpathSync` and re-checked against allowed directories.
4. If the path falls outside allowed boundaries, an access-denied error is thrown before any filesystem operation.
5. New file creation uses the `wx` (exclusive) flag to prevent symlink exploitation.
6. Search, indexing, and directory-traversal tools apply `isSensitive()` filtering to block credential-like files (`.env`, `*.pem`, `*.key`, `*credentials*`, `*secret*`, etc.) via configurable `minimatch` patterns.
7. Enforcement is opt-in: the top-level `Sandbox` config flag (default `disabled`) turns the allowed directories from project-context hints into the enforced boundary. Even then the `bash` tool (§6.12) is the exception: `validatePath()` gates only its `cwd`; the command runs with the server process's privileges, and `bash: disabled` under `### Tools` is the control.

---

## 5. Core Architectural Modules

### 5.1 `core/server.ts` — Tool Orchestration

```typescript
export function registerEnabledTools(toolServer: ToolServer, ctx: ToolContext): void
```

- Each entrypoint constructs its own `McpServer` (HTTP: one per request; stdio: one per connection) and passes it in as the SDK-agnostic `ToolServer`; `withCallerEnvironmentPing` wraps every handler and forwards the SDK's per-call `extra` (the cancellation signal) to it.
- **`TOOL_REGISTRY`** constant: Array of `{ name, register }` — single source of truth for all 12 tools.
- Config-driven tool enable/disable via `syncedConfig.tools[entry.name]`.
- Loads adapter settings and configures adapter registry when enabled.
- Retrieval code exists under `src/retrieval/`, but it is disabled by default and excluded from the main package compile.
- No MCP Roots wiring — scope is derived per call (§5.8).

### 5.2 `core/lib.ts` — Filesystem Access Layer

- **`FilesystemContext` interface**: `getAllowedDirectories()`, `setAllowedDirectories()`, `validatePath()`, `validateNewFilePath()`
- **`createFilesystemContext(initialAllowedDirectories)`**: Factory with symlink-safe, ancestor-aware path validation.
- Atomic file writes: exclusive creation (`wx`) → temp-file + `rename()` fallback.
- Diff utilities: `createUnifiedDiff()`, `createMinimalDiff()`.
- File I/O: `readFileContent()`, `writeFileContent()`, `applyFileEdits()`, `tailFile()`, `headFile()`, `offsetReadFile()`.
- Resume overlap detection via `findResumeOffset()`.

### 5.3 `core/shared.ts` — Search & BM25 Infrastructure

- **`BM25Index` class**: Full BM25 implementation with entropy-weighted IDF scoring and sigmoid TF saturation. Methods: `static tokenize(text)`, `build(docs)`, `search(query, topK)`.
- `bm25RankResults()` — Rank lines by BM25 relevance within a character budget.
- `bm25PreFilterFiles()` — Pre-filter files using BM25 on path + content snippets.
- Ripgrep integration: `ripgrepSearch()` (JSON-mode with sensitive file filtering), `ripgrepFindFiles()`.
- Config-driven: `getCharBudget()` (10K–2M, default 400K), `getSearchCharBudget()`, `getDefaultExcludes()`, `getSensitivePatterns()`.
- `isSensitive(filePath)` — Multi-strategy sensitive file detection.

### 5.4 `core/tree-sitter.ts` — Code Comprehension

- Lazily loads `web-tree-sitter` WASM grammars on first access (40+ languages).
- LRU-cached after first load for minimal startup penalty.
- Exposes APIs for: symbol extraction, definition location, AST syntax error detection, structural fingerprints (3-gram node fingerprints for Jaccard similarity), and compression structure generation.
- Powers: `edit_file` symbol mode, `search_file` symbol lookup, `search_files` symbol/structural/definition modes, `refactor_batch` symbol loading/outlier detection, post-edit syntax warnings, and structured compression anchors.

### 5.5 `core/edit-engine.ts` — In-Memory Edit Engine

Pure computation (no I/O). Applies edits in three modes:

- **content mode**: `oldContent`/`newContent` with three-strategy matching: exact → trim-trailing-whitespace → indent-stripped within ±50-line window.
- **block mode**: `block_start`/`block_end` boundary matching with disambiguation.
- **symbol mode**: DB-backed `loadSymbolInFile()` lookup via the symbol-index with `nearLine` proximity sort.

All edits in a file bundle succeed or fail atomically. Post-edit syntax error detection via `syntaxWarn()`.

### 5.6 `core/symbol-index.ts` — Symbol DB & Call Graph

- Manages per-repository SQLite databases at `.mcp/symbols.db` (auto-gitignored).
- **Tables**: `files`, `symbols`, `edges`, `versions`, `patterns`.
- Indexes definition scopes, container boundaries, and edge dependencies.
- **Impact queries**: Forward/reverse call-graph traversal with configurable depth and disambiguation.
- **Version snapshots**: Auto-snapshots symbol bodies on edit with MD5 dedup, configurable TTL, point-in-time rollback.
- Batch indexing (50 files per batch) with hash-based staleness detection.

### 5.7 `core/db-adapter.ts` — SQLite Abstraction Layer

- Uses **Node.js native `node:sqlite`** (`DatabaseSync`), NOT `better-sqlite3`.
- Pure functional adapter pattern — all functions take `DbConnection` as first parameter.
- Prepared statement cache (`Map<string, StatementSync>`) and nested transaction support via SAVEPOINTs.
- Connection settings: WAL mode, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`.
- **Schema modules**: `initSymbolSchema()`, `initStashSchema()`, `initBackupSchema()`.

### 5.8 `core/project-context.ts` — Project Root Resolution

`ProjectContext` is the single routing authority for where project-scoped state (`.mcp/symbols.db`) lives. Resolution is deliberately explicit — there is no automatic git or marker detection:

1. Explicit binding via `initProject` (in-memory, sticky for the session)
2. Config-file registry matching (`~/.zenith-mcp/config`, `### Projects` section — the authoritative, persistent registry)
3. Global fallback at `~/.zenith-mcp/` for any unregistered allowed path

**Important**: Project root resolution never expands filesystem permissions. Only `allowedDirectories` control access.

Global SQLite DB at `~/.zenith-mcp/global-stash.db` (stash tables today; symbol schema arrives with the AstIntelligence global tier). Note: `core/symbol-index.ts`'s `findRepoRoot`/`getDb` git-walk is a legacy internal primitive of the symbol machinery, not a routing authority. Project routing lives in `ProjectContext`, which consults `core/detection/boundaries.ts` — do not introduce a second resolver.

### 5.9 `core/project-registry.ts` — Project Manifest Registry

`ProjectRegistry` class with triple-indexed lookup (`_byId`, `_byName`, `_byPath`) and multi-strategy matching:

1. Exact project_id (case-insensitive)
2. Exact project_name (case-insensitive)
3. Leading path-segment match
4. Exact normalized path match
5. Longest path-prefix match

### 5.10 `core/stash.ts` — Stash Management

Stores pending or failed write/edit actions in SQLite for recovery/retry via the `stashRestore` tool.

- `stashEntry()`, `getStashEntry()`, `consumeAttempt()` (auto-delete after 2 attempts), `clearStash()`, `listStash()`.
- Convenience: `stashEdits()` (failed edits), `stashWrite()` (failed writes).

### 5.11 `core/compression.ts` — Subprocess Bridge

- `computeCompressionBudget(rawLength, maxChars, keepRatio)` — Budget calculation (default keep ratio: 0.70).
- `isCompressionUseful()` — Type guard validating compression actually shrinks and fits budget.
- `runToonBridge()` — Spawns `toon_bridge_cli.js` in a subprocess with 30-second timeout for isolation.
- `compressTextFile()` — Full compression pipeline orchestrator.
- `truncateToBudget()` — Line-aware fallback truncation.

### 5.12 `core/toon_bridge.ts` — In-Process TOON Compression

- `compressToon(content, budget, filePath?)` — Main entry point:
  1. Short-circuit if content ≤ budget.
  2. Try tree-sitter `getCompressionStructure()` for structural blocks.
  3. If structure available: `compressSourceStructured()` (from zenith-toon).
  4. Else: `compressString()` (from zenith-toon).
- Back-compat CLI shim for subprocess invocation.

---

## 6. Tool Schema Deep Dive

### 6.1 `read_file`

Flat parameter schema (no mode enum):

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `path` | string | required | File path |
| `maxChars` | number | 50000 (max 400000) | Character budget |
| `head` | number | — | First N lines |
| `tail` | number | — | Last N lines |
| `offset` | number | — | Start line (0-based) |
| `aroundLine` | number | — | Center window on this line |
| `context` | number | 30 | Window radius |
| `ranges` | `{startLine, endLine}[]` | — | Explicit line ranges |
| `showLineNumbers` | boolean | — | Show line numbers |
| `compression` | boolean | — | Enable TOON compression |

Merges overlapping/adjacent windows. Truncates at the final newline within budget.

### 6.2 `read_media_file`

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | Media file path |

Supported: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, `.svg`, `.mp3`, `.wav`, `.ogg`, `.flac`.

### 6.3 `read_multiple_files`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `paths` | string[] | required | Up to 50 files |
| `maxCharsPerFile` | number | — | Per-file budget |
| `compression` | boolean | true | Enable compression |
| `showLineNumbers` | boolean | false | Show line numbers |

Allocates budget proportionally by file size. Concurrent reads (concurrency limit: 8). Failed reads don't stop the operation.

### 6.4 `write_file`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `path` | string | required | File path |
| `content` | string | required | File content |
| `failIfExists` | boolean | — | Fail if file exists |
| `append` | boolean | — | Append mode with overlap detection |

Auto-creates parent directories. Atomic writes via temp-file + rename. Stashes content on write failure.

### 6.5 `edit_file`

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | File path |
| `edits[]` | array | Edit operations (see modes below) |
| `dryRun` | boolean | Preview without writing |

**Edit Modes:**

- **`content`**: `oldContent` / `newContent` — exact text replacement with 3-strategy matching
- **`block`**: `block_start` / `block_end` / `replacement_block` — boundary-delimited replacement
- **`symbol`**: `symbol` / `newText` / `nearLine` (optional) — AST-aware symbol replacement

All-or-nothing: if any edit fails, zero edits are written. Failed edits are stashed.

### 6.6 `directory`

Discriminated union on `mode`:

- **`list`**: `path`, `depth` (default 1, max 10), `includeSizes`, `sortBy` (`"name"` | `"size"`)
- **`tree`**: `path`, `excludePatterns`, `showSymbols`, `showSymbolNames`

`list` caps at 250 items per level. `tree` caps at 500 nodes with optional tree-sitter symbol statistics.

### 6.7 `search_files`

Discriminated union on `mode`:

| Mode | Key Parameters | Description |
|------|---------------|-------------|
| `content` | `path`, `contentQuery`, `pattern`, `contextLines`, `literalSearch`, `countOnly`, `maxResults` | BM25 pre-filter + ripgrep + BM25 post-rank |
| `files` | `path`, `pattern`, `namePattern`, `pathContains`, `extensions`, `maxResults` | File discovery |
| `symbol` | `path`, `symbolQuery`, `symbolKind` | Symbol search via tree-sitter |
| `structural` | `path`, `structuralQuery` | AST Jaccard similarity matching |
| `definition` | `path`, `definesSymbol`, `namePattern`, `pathContains`, `extensions`, `maxResults` | Definition lookup via AST queries |

### 6.8 `search_file`

Single-file search with `grep` or `symbol` mode:

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | Target file |
| `grep` | string | Regex pattern (with `grepContext` lines) |
| `symbol` | string | Symbol name lookup |
| `nearLine` | number | Disambiguation hint |
| `expandLines` | number | Surrounding context |
| `maxChars` | number | Output budget |

### 6.9 `file_manager`

Discriminated union on `mode`:

| Mode | Parameters | Description |
|------|-----------|-------------|
| `mkdir` | `path` | Create directory |
| `delete` | `path` | Delete file (file-only) |
| `move` | `source`, `destination` | Move/rename |
| `info` | `path` | File metadata |

### 6.10 `stashRestore`

Discriminated union on `mode`:

| Mode | Parameters | Description |
|------|-----------|-------------|
| `apply` | `stashId`, `corrections`, `newPath`, `dryRun` | Retry stashed edits/writes |
| `restore` | `stashId` | Clear a stash entry by ID |
| `list` | `type` | List stash entries |
| `read` | `stashId` | Read stash entry details |

### 6.11 `refactor_batch`

Discriminated union on `mode`:

| Mode | Key Parameters | Description |
|------|---------------|-------------|
| `query` | `target`, `fileScope`, `direction`, `depth` | Symbol graph traversal (callers/callees) |
| `loadDiff` | `selection`, `contextLines`, `loadMore` | Load symbol bodies + outlier detection |
| `apply` | `payload`, `dryRun` | Multi-file atomic edits with syntax gates |
| `reapply` | `symbolGroup`, `newTargets`, `ack`, `dryRun` | Apply cached pattern to new targets |
| `restore` | `symbol`, `file`, `version`, `dryRun` | Rollback to a version snapshot |
| `history` | `symbol`, `file` | View symbol version history |

### 6.12 `bash`

Run a bash command and return a terminal-style transcript:

| Parameter | Type | Description |
|-----------|------|-------------|
| `command` | string | Command to run with `bash -c` (required) |
| `cwd` | string | Working directory (validated); defaults to the project root, else the first allowed directory, else the server's working directory |
| `timeout` | integer | Seconds (≥ 1); defaults to `bash_timeout_seconds`, clamped to `bash_max_timeout_seconds` |

The default `cwd` is resolved through `ProjectContext` (§5.8) — project root, else the first allowed directory, else the server's working directory — and an explicit `cwd` is validated like any other path. The command runs in its own process group with stdin closed; on timeout the whole group receives SIGTERM, then SIGKILL after 2 s, and whatever output was captured is still returned. stdout and stderr are merged in arrival order and sanitized the way a terminal renders them (ANSI/OSC escapes stripped, `\r` returns to column 0 and overwrites, erase-line sequences honoured so progress bars collapse to their final frame, control bytes other than tab removed, UTF-8 decoded correctly across chunk boundaries), and the output is returned in full. The result is always `<cwd>$ <command>`, the output, then a status line — `[exit code N]`, `[terminated by SIGxxx]`, `[timed out after Ns; process group killed]`, `[cancelled; process group killed]`, or `[cancelled]` when the request was cancelled before the shell started (`[exit code unknown]` is the fallback for an exit Node reports with neither a code nor a signal, which its `exit` event documents as never happening) — so a non-zero exit is data rather than an error, the error channel is reserved for the tool itself failing (invalid `cwd`, `bash not found.`, spawn failure), and the timeout default (120 s) and cap (600 s) come from the `bash_timeout_seconds` / `bash_max_timeout_seconds` config keys (§8).

An explicit `cwd` is path evidence for project detection exactly like a file tool's path: it rebinds `ProjectContext` when it lies in a different project. The path sandbox (§4) gates only that `cwd` — the command itself runs with the server process's privileges and can reach any file or resource the server can.

Stopping a command — on timeout, or when the client cancels the request (the SDK's abort signal, forwarded to every tool by `withCallerEnvironmentPing`) — sends SIGTERM to the process group, then SIGKILL 2 s later; on Windows, which has no process groups, `taskkill /T /F` and its exit code stand in for both. The call completes only once the group is observed empty or the SIGKILL has gone out, so a descendant in the group that ignores SIGTERM cannot survive behind a `[timed out …; process group killed]` or `[cancelled; process group killed]` status line. The kill reaches the command's process group; a job the command moved to another group (`set -m`) is not reached. A background child that outlives the shell while holding its pipes is cut off 250 ms after the shell exits, and the shell's own status is reported. A shell whose call is in flight is tracked and swept — SIGKILL to its group — when the server exits or receives SIGTERM/SIGINT/SIGHUP; the listener runs first and re-raises the signal with its default disposition only when it is the sole listener. What outlives its call — a service the command started detached — is not tracked and not swept.

Rendering follows ECMA-48 structurally rather than by pattern: CSI and ESC sequences are recognised whether or not a pipe chunk boundary splits them; control strings (OSC/DCS/SOS/PM/APC) are swallowed with their payload up to ST or BEL — newlines included, so a title or hyperlink payload never reaches the transcript; stray control bytes are removed. What is modelled per line, with cells being code points (a tab or a wide character is one cell): printable text, `\r`, backspace, erase-in-line (EL 0/1/2), cursor-to-column (CHA) and cursor back/forward (CUB/CUF); colours and every other sequence are dropped. Output is rendered as it arrives straight into the transcript, completed pieces joined in batches, so memory stays at roughly the transcript's own size; cursor motion never creates cells (a move past the end of the line lands at the end), so nothing in the output can make the renderer allocate beyond the text it received.

---

## 7. Client Configuration & Adapters

### Adapter System

Adapters in `src/adapters/platforms/` auto-configure external MCP clients to register Zenith. The system supports multiple popular MCP clients (Claude Desktop, Cursor, VS Code, Windsurf, Cline, JetBrains, etc.).

| Component | Path | Purpose |
|-----------|------|---------|
| `base.ts` | `adapters/` | `MCPConfigAdapter` abstract base class |
| `platforms/` | `adapters/` | Per-client adapter implementations |
| `registry.ts` | `adapters/` | Registry with `configureRegistry()`, `listAdapters()` |
| `helpers/` | `adapters/` | JSON5, TOML, YAML parsing and output format helpers |

- Adapters back up before modifying configuration files.
- Auto-configuration is controlled in `~/.zenith-mcp/config` under `### Auto Write`.
- A first-run interactive wizard runs on server initialization if no configuration exists.

---

## 8. Configuration File Schema

Settings are saved in `~/.zenith-mcp/config` in a plain-text structure:

```text
Port: 7000

### Tools
read_file: enabled
edit_file: enabled
search_files: enabled

### Auto Write
status: disabled
backup_dir: ~/.zenith-mcp/mcp_backups/
backup_mode: file
custom_mcp_paths:

### Advanced
char_budget: 400000
search_char_budget: 15000
refactor_max_chars: 30000
refactor_max_context: 30
refactor_version_ttl_hours: 24
session_ttl_ms: 1800000
bash_timeout_seconds: 120
bash_max_timeout_seconds: 600
default_excludes: node_modules,.git,.next,...
sensitive_patterns: **/.env,**/*.pem,...
```

Config modules in `packages/zenith-mcp/src/config/`:

| Module | Purpose |
|--------|---------|
| `parser.ts` | Ordered `RawConfig` array for round-trip fidelity (unknown fields and comments preserved) |
| `schema.ts` | `ZenithConfig` interface, `DEFAULT_CONFIG`, `configToRaw()`, `rawToConfig()` |
| `loader.ts` | `loadConfig()`, `saveConfig()`, `mergeToolsIntoConfig()` |
| `wizard.ts` | First-run interactive wizard (auto-write, backup mode, port, char_budget) |
| `auto-write.ts` | Registers Zenith in other MCP clients via adapters |
| `backup.ts` | SQLite/file/none backup modes |

---

## 9. Dynamic Retrieval & Interception Pipeline

The retrieval pipeline is **opt-in and disabled by default** (`defaultRetrievalConfig().enabled = false`). It is designed to reduce active tool-list bloat when Zenith manages or proxies larger tool sets — it is NOT a search ranking pipeline.

**6-Stage Fallback Hierarchy:**

1. **BMXF Blend**: Combines environmental context (workspace analysis) and conversational signals with Weighted RRF fusion.
2. **BMXF Env-Only**: Ranks tools using workspace fingerprint.
3. **Keyword Env-Only**: Matches keywords against tool schemas.
4. **Static Categories**: Ranks tools based on project classification (e.g., Rust, Python, Go, Node).
5. **Frequency Prior**: Demotes tools that are historically unused.
6. **Universal Fallback**: Exposes up to 12 core namespace tools.

Exposes a synthetic `request_tool` to allow client-side promotion of demoted/inactive tools.

Key components: `pipeline.ts`, `session.ts`, `ranking/`, `telemetry/`, `observability/`, `routing-tool.ts`, `zenith-integration.ts`, `zenith-tool-registry.ts`.

> **Note:** The retrieval source directory (`src/retrieval/**`) is currently excluded from the main TypeScript compilation in `tsconfig.json`.

---

## 10. Compression Architecture

Context compression replaces raw file text with structurally-aware compressed representations.

### Flow

1. **Analysis**: Tree-sitter extracts the source code AST, mapping functions, control structures, and declaration bodies via `getCompressionStructure()`.
2. **Codec Bridge**: `core/toon_bridge.ts` sends the structural mapping to `zenith-toon`'s `compressSourceStructured()`. Falls back to `compressString()` when tree-sitter structure is unavailable.
3. **Execution**: The TOON codec reduces text size based on character budget constraints by preserving signature headers and collapsing interior execution blocks while maintaining syntax validity.
4. **Validation**: The caller verifies that compressed output is actually useful (`isCompressionUseful()`) — shorter than the original AND fits the budget — before injecting it into context.

### Subprocess Isolation

`compression.ts` spawns a Node subprocess (`toon_bridge_cli.js`) with a 30-second timeout for memory boundary enforcement. The bridge itself performs in-process TypeScript compression. This is "no Python dependency" but NOT "no child process."

---

## 11. zenith-toon Package

Zero-dependency TypeScript compression codec library.

| Module | Role |
|--------|------|
| `pipeline.ts` | `ToonPipeline` — main compression orchestration |
| `sagerank.ts` | `SageRank` — multi-signal importance ranking for text segments |
| `bmx-plus.ts` | `BMXPlus` — custom BM25 variant for high-speed text relevance scoring |
| `string-codec.ts` | `StringCodec` — multi-strategy string encoding |
| `budget.ts` | `BudgetAllocator` — proportional token/character budget distribution |
| `dedup.ts` | Near-duplicate detection and removal |
| `config.ts` | Configuration types |
| `presets.ts` | Profiles: compact, balanced, verbose |
| `router.ts` | Content-type routing for compression strategy selection |
| `encoder.ts` | Encoder abstraction with caching |
| `types.ts` | Core types |
| `utils.ts` | Shared utilities |

### BMX-Plus

BMX-Plus (`BMXPlusIndex` class) is an original, unpublished lexical search algorithm created by the project author. It uses **no pre-trained models** — it is a pure algorithmic scoring function built on BM25's proven TF saturation curve with three innovations:

1. **Term-adaptive entropy-aware IDF** — Each term receives a scaling factor γ_t = IDF_t / IDF_max. Rare terms get full entropy weight; common terms get none — independent of corpus size.
2. **Variance-blended informativeness** — Shannon entropy (when TFs vary across documents) is smoothly blended with IDF-derived informativeness (1 − df/N) using TF variance as the interpolation weight, avoiding hard discontinuities.
3. **tanh Soft-AND coverage bonus** — Inspired by RankEvolve, a `tanh(termScore)` coverage accumulator rewards documents that match multiple query terms rather than letting a single dominant term inflate the score.

All scoring is executed within a **Term-At-A-Time (TAAT) posting-list architecture** — the primary source of BMX-Plus's speed advantage over document-at-a-time BM25 implementations. Additional algorithmic details:

- **Self-tuning parameters**: α and β are derived from corpus statistics (average document length, total document count) — no manual tuning required.
- **Lucene-variant IDF**: `log((N − df + 0.5) / (df + 0.5) + 1)` (always non-negative).
- **Fast sigmoid**: Padé rational approximation to σ(x) for entropy computation (|error| < 0.01, branch-free hot path).
- **Lazy entropy recomputation**: Incremental updates (`updateIndex`/`removeFromIndex`) mark terms dirty; entropies are flushed only for query-relevant terms at search time.
- **BM25 TF saturation**: k1 = 1.5, b = 0.75 (standard parameters, unchanged).

#### BEIR Benchmark Results

Benchmarked against standard BM25 across 9 BEIR datasets spanning 3.6K to 4.6M documents (~8.2M total):

| Dataset | Corpus | Queries | NDCG@10 (BM25) | NDCG@10 (BMX+) | Δ NDCG@10 | Recall@100 (BM25) | Recall@100 (BMX+) | Speedup |
|---------|--------|---------|----------------|----------------|-----------|-------------------|-------------------|---------|
| nfcorpus | 3,633 | 323 | 0.3054 | 0.3013 | −0.0041 | 0.2358 | 0.2350 | **26.2×** |
| scifact | 5,183 | 300 | 0.6623 | 0.6615 | −0.0009 | 0.8759 | 0.8826 | **7.0×** |
| arguana | 8,674 | 1,406 | 0.3484 | 0.3508 | +0.0024 | 0.9523 | 0.9523 | **3.7×** |
| scidocs | 25,657 | 1,000 | 0.1514 | 0.1503 | −0.0010 | 0.3491 | 0.3460 | **6.3×** |
| fiqa | 57,638 | 648 | 0.2357 | 0.2317 | −0.0040 | 0.5090 | 0.5110 | **3.7×** |
| trec-covid | 171,332 | 50 | 0.5849 | 0.5654 | −0.0195 | 0.0987 | 0.0935 | **3.1×** |
| webis-touche2020 | 382,545 | 49 | 0.3654 | 0.3651 | −0.0003 | 0.5731 | 0.5683 | **6.8×** |
| quora | 522,931 | 5,000 | 0.7368 | 0.7459 | +0.0092 | 0.9475 | 0.9531 | **1.5×** |
| dbpedia-entity | 4,635,922 | 67 | 0.3092 | 0.3079 | −0.0013 | 0.4802 | 0.4878 | **3.7×** |

**Summary**: Across all 9 datasets, BMX-Plus achieves **1.5–26× speedups** (median ~3.7×) while NDCG@10 deltas stay within ±0.02 of BM25 (median −0.001). On two datasets (arguana, quora) BMX-Plus outperforms BM25 in both NDCG@10 and recall@100.

### Exports

The package exports two primary compression functions consumed by `zenith-mcp`:

- `compressSourceStructured(content, budget, blocks: StructureBlock[])` — Structure-aware compression using tree-sitter AST blocks.
- `compressString(content, budget)` — Plain string compression fallback.

---

## 12. Database Architecture

### Per-Project Database

SQLite (via Node.js native `node:sqlite`) in WAL mode at `.mcp/symbols.db`:

| Table | Contents |
|-------|----------|
| `files` | Indexed file metadata (path, hash) |
| `symbols` | Extracted code symbols (definitions, references) |
| `edges` | Caller → callee dependency links |
| `versions` | Symbol body snapshots with MD5 dedup |
| `patterns` | Reapply pattern cache |

### Stash Tables

For project-scoped work, stash and config backup tables are created in the same `.mcp/symbols.db` database. If no project root can be resolved, stash data falls back to `~/.zenith-mcp/global-stash.db`.

| Table | Contents |
|-------|----------|
| `stash` | Failed edit/write payloads for recovery |
| `config_backups` | Config backup history |

### Global Database

SQLite at `~/.zenith-mcp/global-stash.db`:

| Table | Contents |
|-------|----------|
| `stash` | Stashed failed write/edit payloads (`initStashSchema`) |
| `config_backups` | Config backup snapshots (written via `config/backup.ts`) |

Project registration is NOT stored here — the authoritative registry is the `### Projects` section of `~/.zenith-mcp/config`. (A `project_roots` table exists in per-project `.mcp/symbols.db` files as a legacy write-only artifact, and `initGlobalSchema` is dormant; the AstIntelligence global tier will add symbol tables to this DB.)

---

## 13. Build & Test

```bash
# Install dependencies
pnpm install

# Build (zenith-toon first, then zenith-mcp)
pnpm build

# Run tests
pnpm test              # vitest run --coverage

# Type-check
pnpm check

# Clean
pnpm clean
```

### Tech Stack

| Technology | Version | Purpose |
|------------|---------|---------|
| TypeScript | ^7.0.2 | Primary language |
| Node.js | ^26.3.0 | Runtime (required for native `node:sqlite`) |
| pnpm | 11.22.0 | Package manager |
| Turborepo | ^2.10.10 | Monorepo build orchestration |
| Express | ^5.2.1 | HTTP server framework |
| express-rate-limit | ^8.6.2 | Rate limiting |
| @modelcontextprotocol/sdk | 1.30.0 | Protocol implementation (patched) |
| @modelcontextprotocol/server | 2.0.0 | HTTP/SSE transport server |
| web-tree-sitter | ^0.26.12 | Code parsing (WASM) |
| Zod | ^4.4.3 | Schema validation |
| Vitest | ^4.1.10 | Test framework |
| minimatch | ^10.2.6 | Pattern matching |
| diff | ^9.0.0 | Diff computation |
| js-yaml | ^5.3.0 | YAML parsing |
| json5 | ^2.2.3 | JSON5 parsing |
| jsonc-parser | ^3.3.1 | JSONC parsing |
| @iarna/toml | — | TOML parsing |

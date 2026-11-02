# Zenith-MCP

> **The MCP filesystem your agent actually deserves.** Stop pasting line numbers. Stop grepping. Stop hoping your multi-file refactor didn't silently break the one odd function with a different signature. Zenith reads code like you do — by structure, not text — and edits it with the precision of an IDE engine, not a text replacement tool.

[![npm](https://img.shields.io/npm/v/zenith-mcp?label=zenith-mcp&color=6366f1)](https://www.npmjs.com/package/zenith-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/protocol-MCP-blue)](https://modelcontextprotocol.io)

---

## Why Zenith?

Most MCP filesystem servers give you a hammer and ask you to sculpt. Zenith gives you a precision instrument intentionally built for serious AI-assisted development. Not just read and write — Zenith gives your AI agent genuine code intelligence: AST-aware editing, impact-graph refactoring, semantic search, and a version-controlled symbol database, all inside a hardened security sandbox.

| Capability | Typical MCP server | Zenith-MCP |
|---|---|---|
| **Edit precision** | Full-file overwrite or fragile text replacement | 3-mode surgical editing: content-match, block-boundary, or **AST symbol** — no line numbers needed |
| **Code understanding** | None | Tree-sitter AST parsing for **40+ languages**, lazy-loaded WASM, LRU-cached |
| **Search intelligence** | Grep or basic glob | BM25 pre-filter + ripgrep + BM25 post-rank, structural similarity, definition lookup |
| **Cross-file refactoring** | Not available | Impact-graph traversal (callers/callees), outlier detection, atomic multi-file apply with rollback |
| **Edit safety** | Write and hope | All-or-nothing in-memory validation → atomic temp-file swap → SQLite stash on failure |
| **Symbol versioning** | Not available | Every symbol edit auto-snapshots the original; point-in-time rollback via `refactor_batch` |
| **Security model** | CWD or basic prefix check | `validatePath` with symlink resolution + re-check, exclusive-write `wx` flag, sensitive-file blocking, per-session isolation |
| **Transport** | stdio only | stdio **and** HTTP (Streamable HTTP + legacy SSE, bearer auth, per-session context, idle reaping) |

---

## What It Does (And Why It Matters)

### True code-awareness via Tree-sitter

Zenith ships WASM grammars for JavaScript, TypeScript, TSX, Python, Go, Rust, Java, C, C++, C#, Kotlin, PHP, Ruby, Swift, Bash, CSS, JSON, YAML, SQL, Markdown, Dart, Elixir, GraphQL, HCL, HTML, Lua, Make, Nix, Perl, Prisma, Proto, R, SCSS, Svelte, TOML, Vue, XML, CMake, Dockerfile, and more. Grammars are lazy-loaded on first use and cached after first load — minimal startup penalty.

This unlocks capabilities that are simply impossible with text search:

- **`edit_file` symbol mode** — "Replace the `AuthService.login` method" without knowing its line number. Zenith finds the AST bounds and replaces exactly the right block, then re-indents the new code to match the file.
- **`search_file` symbol lookup** — Read just the body of `BM25Index.score` across a 10,000-line file, with optional surrounding context.
- **`search_files` structural mode** — Find all functions with the same AST shape (Jaccard similarity over 3-gram node fingerprints) to detect copy-paste patterns or candidates for a common abstraction.
- **`search_files` definition mode** — Locate every file that *defines* `AuthService.login` using the parse tree, not a fragile regex.
- **Syntax gate** — After any edit, `syntaxWarn()` walks the new AST and warns if `ERROR` or missing nodes were introduced.

### Intelligent two-stage search

Searching a 50,000-file monorepo without drowning the LLM context is a hard problem. Zenith solves it with a pipeline:

1. **BM25 pre-filter** — builds an in-memory BM25 corpus (file paths weighted 3×, first 8 KB of content) and selects the top-100 candidate files.
2. **ripgrep** — blazing-fast regex search scoped to those 100 files (with `.gitignore` awareness). Falls back to a pure-JS implementation when `rg` isn't available.
3. **BM25 post-rank** — if results exceed 50 lines, BM25 re-ranks individual result lines and fills the character budget with the most relevant hits.

The BM25 implementation is zero-dependency, inline (~120 lines), and uses entropy weighting (high-entropy terms are downweighted) plus sigmoid TF saturation for better precision than vanilla BM25.

### All-or-nothing atomic edits with stash recovery

Edit safety is not an afterthought. Every `edit_file` call:

1. Validates **all** edits against an in-memory copy of the file — exact match, then trimmed-whitespace match, then indent-stripped match within a ±50-line window.
2. If **any** edit fails, **zero** edits are applied and the file is untouched.
3. Failed edits are stashed to SQLite with their full payload. The AI retries via `stashRestore apply` with only the correction needed — unchanged edits rehydrate from the stash automatically.
4. Successful edits write to a temp file, verify the byte size, then `fs.rename()` for an atomic swap.

Block edits (`block_start` / `block_end`) and symbol edits (AST-located) follow the same pipeline.

### Cross-file impact refactoring

`refactor_batch` implements a full refactoring workflow:

1. **`query`** — traverses the per-project SQLite symbol graph (`edges` table) to find all callers (`forward`) or callees (`reverse`) of a symbol, up to 5 levels deep.
2. **`loadDiff`** — fetches each symbol's body plus N lines of context. Runs **outlier detection**: computes `getSymbolStructure()` for each occurrence (param shape, return type, decorators, modifiers, parent scope) and flags deviations from the modal pattern.
3. **`apply`** — parses a diff-style payload, gates on acknowledged outliers and syntax validity, then applies edits atomically per file. Successful patterns are cached for `reapply`.
4. **`reapply`** — applies a cached edit pattern to new targets without repeating the full workflow.

### Per-project symbol database

Each git repository gets a `.mcp/symbols.db` (auto-gitignored) with:
- `symbols` — definitions and references from the full Tree-sitter parse
- `edges` — caller → callee links for impact traversal
- `versions` — point-in-time snapshots of every symbol body touched by `edit_file` or `refactor_batch`, with a configurable TTL

Rollback is a single tool call: `refactor_batch restore`.

### TOON compression engine

The `zenith-toon` package provides intelligent context compression for tool outputs:

- **Structure-aware**: Uses tree-sitter AST analysis to identify code structure, preserving signature headers while compressing interior blocks.
- **BMX-Plus scoring**: An original, unpublished lexical search algorithm created by the project author. Built on BM25's TF saturation curve with three innovations: term-adaptive entropy-aware IDF (γ_t = IDF_t / IDF_max), variance-blended informativeness (Shannon entropy ↔ IDF smoothly interpolated via TF variance), and tanh Soft-AND coverage bonus. All executed within a TAAT (Term-At-A-Time) posting-list architecture. Uses **no pre-trained models** — purely algorithmic. Benchmarked against standard BM25 across 9 BEIR datasets (~8.2M documents total), achieving **1.5–26× speedups** (median ~3.7×) while NDCG@10 deltas stay within ±0.02 of BM25.
- **SageRank**: Multi-signal importance ranking for text segments (structural importance, semantic density, position, references).
- **Budget management**: Character-aware budget allocation ensures tool outputs fit within context windows without losing critical information.

### Security-first design

- **`validatePath()`** — expands `~`, normalizes, prefix-checks against allowed directories, calls `fs.realpath()` to resolve symlinks, then re-checks the resolved path. Throws before any `fs` call if the check fails.
- **Exclusive writes** — new file creation uses the `wx` flag. Pre-existing symlinks at the target path cannot be exploited.
- **Sensitive file blocking** — `isSensitive()` uses `minimatch` globs to block `.env`, `*.pem`, `*.key`, `*credentials*`, `*secret*`, and more from appearing in search results and symbol indexing.
- **Per-session isolation (HTTP)** — each HTTP client gets its own `FilesystemContext`. MCP root negotiations for one session never affect another.

---

## Features

- **Read/write files** — text, media, and batch reads with budget-aware truncation and optional compression
- **Surgical editing** — content-match, block-replace, and symbol-aware edits with dry-run preview
- **Intelligent search** — content search with BM25 ranking, file discovery, symbol search, structural similarity, definition lookup, and single-file grep/symbol search
- **Cross-file refactoring** — impact analysis, batch symbol loading, and coordinated multi-file edits with rollback
- **Code awareness** — Tree-sitter AST parsing for 40+ languages (lazy-loaded WASM grammars)
- **Symbol indexing & versioning** — per-project SQLite index with impact graphs and automatic version snapshots
- **Stash & restore** — retry failed edits and restore symbol versions
- **Per-call project scope** — no session state and no MCP Roots: every call derives its scope from path evidence, the project registry and client detection, with an opt-in allowed-directory sandbox (`Sandbox: enabled`)
- **Dual transport** — stdio (local) and HTTP (remote with Streamable HTTP + legacy SSE)

---

## Quick Start

### Prerequisites
- **Node.js** ≥ 22.0.0 (required for native `node:sqlite`)
- **pnpm** 11+

### stdio (Local)

Standard MCP stdio transport for local clients like Claude Desktop or VS Code.

```bash
npx zenith-mcp /path/to/dir1 /path/to/dir2
```

### HTTP (Remote)

Express-based HTTP server supporting both Streamable HTTP and legacy SSE transports.

```bash
ZENITH_MCP_API_KEY=secret npx zenith-mcp-http /path/to/dir1 --port=3100 --host=0.0.0.0
```

**HTTP Endpoints:**

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/mcp` | Streamable HTTP (initialize + messages) |
| `GET` | `/mcp` | Streamable HTTP SSE notification stream |
| `DELETE` | `/mcp` | Streamable HTTP session teardown |
| `GET` | `/sse` | Legacy SSE transport |
| `POST` | `/messages` | Legacy SSE message endpoint |
| `GET` | `/health` | Health check |

Sessions are isolated per client and reaped after 30 minutes of idle time (configurable via `session_ttl_ms` in `~/.zenith-mcp/config`). All HTTP requests require `Authorization: Bearer <API_KEY>`.

### Building from Source

```bash
git clone https://github.com/itstanner5216/zenith-mcp.git
cd zenith-mcp
pnpm install
pnpm build     # Builds zenith-toon first, then zenith-mcp
```

---

## Directory Access Control

Allowed directories come from the command line:

```bash
zenith-mcp /path/to/dir1 /path/to/dir2
```

The server also starts with none: tools then resolve project scope per call (path evidence, the project registry, client detection) or fall back to the global workspace. MCP Roots are not used — the server is stateless and derives scope per call.

By default the allowed directories are project-context hints and do not restrict access. `Sandbox: enabled` in the config file turns them into the enforced boundary:

> **Why no fallback?** With the sandbox enabled, allowed directories are a strict security boundary — they determine what the AI can read and write through the filesystem tools. The server intentionally does *not* fall back to `process.cwd()` or auto-detected git roots for allowed directories, because that could accidentally expose sensitive files. A separate "project root" resolver (used only for the symbol index and stash database) does have fallbacks (git → marker detection → registry → global), but that layer never grants filesystem access.

### How It Works
1. **Server Startup** — the CLI directories are resolved, validated and recorded
2. **Sandbox** — with `Sandbox: enabled`, all filesystem tool operations are restricted to those directories; symlinks are resolved and validated. With the default (`disabled`) they are project-context hints only
3. **`bash`** — the [`bash`](#bash) tool is the one exception: the sandbox confines only its `cwd`, and the command itself runs with the server's privileges

---

## Tools

### `read_file`
Read a text file with flexible options (streaming line chunks, windowed reads, or exact line ranges). Uses a single flat parameter schema.

- `path` (string)
- `maxChars` (number, optional, default 50000, up to 400000)
- `head` (number, optional) — first N lines
- `tail` (number, optional) — last N lines
- `offset` (number, optional) — start line (0-based), combine with `head`
- `aroundLine` (number, optional) — center window on this line
- `context` (number, optional, default 30) — window radius
- `ranges` (array of `{startLine, endLine}`, optional) — explicit line ranges
- `showLineNumbers` (boolean, optional)
- `compression` (boolean, optional) — compress via structured in-process TS compression

> **Note:** For grep and symbol-based searching within a single file, use `search_file` instead.

### `read_media_file`
Read an image or audio file. Returns base64 data with MIME type.
- `path` (string)
- Supported: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, `.svg`, `.mp3`, `.wav`, `.ogg`, `.flac`

### `read_multiple_files`
Read up to 50 files concurrently with dynamic character budget balancing.
- `paths` (string[])
- `maxCharsPerFile` (number, optional)
- `compression` (boolean, optional, default true) — compress whitespace
- `showLineNumbers` (boolean, optional, default false)
- Failed reads won't stop the entire operation

### `write_file`
Create, overwrite, or append to a file. Auto-creates parent directories. Atomic writes with temp-file + rename.
- `path` (string)
- `content` (string)
- `failIfExists` (boolean, optional) — fail if file already exists
- `append` (boolean, optional) — append instead of overwriting; smart-resumes overlapping tails

### `edit_file`
Surgical file editing with three modes. Supports dry-run preview. Failed edits are stashed for retry.

- **mode: `content`**
  - `oldContent` (string) — exact text to find (uses exact, trimmed, and indent-stripped matching)
  - `newContent` (string)

- **mode: `block`**
  - `block_start` (string) — trimmed first line of the block to replace
  - `block_end` (string) — trimmed last line of the block
  - `replacement_block` (string)

- **mode: `symbol`**
  - `symbol` (string) — symbol name, dot-qualified for methods
  - `newText` (string)
  - `nearLine` (number, optional)

All modes support `dryRun` to preview changes without writing.

### `directory`
Directory exploration with two modes.

- **mode: `list`** — list directory contents
  - `path` (string)
  - `depth` (number, optional, default 1, max 10) — recursion depth
  - `includeSizes` (boolean, optional, default false)
  - `sortBy` (enum `"name" | "size"`, optional, default `"name"`) — requires `includeSizes`

- **mode: `tree`** — recursive directory tree with optional symbol metadata
  - `path` (string)
  - `excludePatterns` (string[], optional) — glob patterns to exclude
  - `showSymbols` (boolean, optional, default false) — show symbol counts per file
  - `showSymbolNames` (boolean, optional, default false) — show symbol names per file

### `search_files`
Multi-mode search with ripgrep + BM25 ranking and JS fallback.

- **mode: `content`** — text/regex search (always case-insensitive)
  - `path`, `contentQuery`, `pattern`, `contextLines`, `literalSearch`, `countOnly`, `includeHidden`, `maxResults`

- **mode: `files`** — file discovery
  - `path`, `pattern`, `namePattern`, `pathContains`, `extensions`, `includeMetadata`, `includeHidden`, `maxResults`

- **mode: `symbol`** — find symbols by name
  - `path`, `symbolQuery`, `symbolKind`

- **mode: `structural`** — find code with similar AST shape
  - `path`, `structuralQuery`

- **mode: `definition`** — find symbol definitions
  - `path`, `definesSymbol`, `namePattern`, `pathContains`, `extensions`, `maxResults`

### `search_file`
Single-file grep or symbol lookup.
- `path` (string)
- `grep` (string, optional) — regex pattern
- `grepContext` (number, optional) — context lines for grep
- `symbol` (string, optional) — symbol name lookup
- `nearLine` (number, optional) — disambiguation hint
- `expandLines` (number, optional) — surrounding context
- `maxChars` (number, optional)

### `file_manager`
File system operations with four modes.
- **`mkdir`**: `path`
- **`delete`**: `path` (file-only)
- **`move`**: `source`, `destination`
- **`info`**: `path` (file metadata)

### `stashRestore`
Retry, inspect, or clear stashed edit/write failures.
- **`apply`**: `stashId`, `corrections`, `newPath`, `dryRun` — retry with optional corrections
- **`restore`**: `stashId` — clear a stash entry
- **`list`**: `type` — list stash entries
- **`read`**: `stashId` — inspect stash details

### `refactor_batch`
Cross-file symbol refactoring with impact analysis and version rollback.
- **`query`**: `target`, `fileScope`, `direction`, `depth` — traverse symbol graph
- **`loadDiff`**: `selection`, `contextLines`, `loadMore` — load symbol bodies + outlier detection
- **`apply`**: `payload`, `dryRun` — apply multi-file edits atomically
- **`reapply`**: `symbolGroup`, `newTargets`, `ack`, `dryRun` — apply cached pattern
- **`restore`**: `symbol`, `file`, `version`, `dryRun` — rollback to snapshot
- **`history`**: `symbol`, `file` — view version history

### `bash`
Run a bash command and get a terminal-style transcript.
- `command` (string) — run with `bash -c`
- `cwd` (string, optional) — validated working directory; defaults to the project root, else the first allowed directory, else the server's working directory. An explicit `cwd` is path evidence: it rebinds project detection exactly like a file tool's path
- `timeout` (integer seconds ≥ 1, optional) — defaults to `bash_timeout_seconds` (120); anything above `bash_max_timeout_seconds` (600) is clamped to that cap
- The allowed-directory sandbox confines only `cwd`. The command runs with the server's own privileges and can reach anything the server process can; `bash: disabled` under `### Tools` turns the tool off where that is not acceptable
- Output is a transcript: `<cwd>$ <command>` on the first line, then stdout and stderr merged in arrival order and rendered as a terminal shows them (ANSI stripped; `\r`, backspace, erase-line and cursor-to-column replayed per line; control-string payloads such as titles and hyperlinks dropped), then a status line — `[exit code N]`, `[terminated by SIGxxx]`, `[timed out after Ns; process group killed]`, `[cancelled; process group killed]`, or `[cancelled]` when the request was cancelled before the shell started (nothing ran). `[exit code unknown]` is the fallback for an exit Node reports with neither a code nor a signal, which its `exit` event documents as never happening
- On timeout, or when the client cancels the request, the command's process group gets SIGTERM, then SIGKILL after 2 s (Windows: `taskkill /T /F`); the output captured so far is still returned. A job the command moved to its own group (`set -m`) is not reached. Commands still running when the server exits or receives SIGTERM/SIGINT/SIGHUP are swept; a process that outlives its command (a detached service) is not
- Output is returned in full. stdin is closed — start services detached with output redirected
- A non-zero exit is reported as data on the status line, not as an error; the error channel is only for the tool itself failing (bad `cwd`, bash missing, spawn failure)

---

## Architecture

### Monorepo Structure
```
zenith-mcp/
├── packages/
│   ├── zenith-mcp/     # Main MCP server
│   └── zenith-toon/    # TOON compression codec library
├── src/                # Root-level bridge scripts & type declarations
├── docs/               # Documentation & design notes
└── patches/            # Dependency patches
```

### Key Components

- **Core Engine** (`src/core/`) — Server factory, filesystem context, path validation, SQLite abstraction, file I/O, diffs
- **Tree-sitter** (`src/core/tree-sitter.ts`) — WASM grammar loading, AST parsing, symbol extraction, structural fingerprints
- **Edit Engine** (`src/core/edit-engine.ts`) — Pure in-memory 3-mode edit application with atomic verification
- **Symbol Index** (`src/core/symbol-index.ts`) — Per-project SQLite DB with symbol graph and version snapshots
- **BM25 Search** (`src/core/shared.ts`) — Entropy-weighted BM25 ranking with ripgrep integration
- **TOON Compression** (`src/core/compression.ts`, `toon_bridge.ts`) — Structure-aware context compression via zenith-toon
- **Adapters** (`src/adapters/`) — Auto-configuration for multiple MCP client platforms
- **Config** (`src/config/`) — Plain-text config management with wizard, auto-write, and backup

### Database

SQLite via Node.js native `node:sqlite` in WAL mode:

| Database | Location | Tables |
|----------|----------|--------|
| Per-project | `.mcp/symbols.db` | `files`, `symbols`, `edges`, `versions`, `patterns`, `stash`, `config_backups` |
| Global | `~/.zenith-mcp/global-stash.db` | `project_roots` |

---

## Configuration

Settings are stored in `~/.zenith-mcp/config` using a plain-text format:

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

### Advanced
char_budget: 400000
search_char_budget: 15000
session_ttl_ms: 1800000
bash_timeout_seconds: 120
bash_max_timeout_seconds: 600
default_excludes: node_modules,.git,.next,...
sensitive_patterns: **/.env,**/*.pem,...
```

A first-run wizard runs automatically if no configuration exists.

---

## Client Configuration

### Cursor IDE
Add to `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "zenith-mcp": {
      "command": "npx",
      "args": ["zenith-mcp", "/path/to/project"]
    }
  }
}
```

### Claude Desktop
Add to your Claude Desktop config:
```json
{
  "mcpServers": {
    "zenith-mcp": {
      "command": "npx",
      "args": ["zenith-mcp", "/path/to/project"]
    }
  }
}
```

### VS Code
Add to `.vscode/mcp.json`:
```json
{
  "mcpServers": {
    "zenith-mcp": {
      "command": "npx",
      "args": ["zenith-mcp", "/path/to/project"]
    }
  }
}
```

### OpenCode
Add to `opencode.json`:
```json
{
  "mcp": {
    "zenith-mcp": {
      "command": "npx",
      "args": ["zenith-mcp", "/path/to/project"]
    }
  }
}
```

---

## Development

### Build
```bash
pnpm install
pnpm build     # Builds zenith-toon first, then zenith-mcp
```

### Test
```bash
pnpm test      # vitest run --coverage
```

### Type Check
```bash
pnpm check     # Type-check without emitting
```

### Clean
```bash
pnpm clean     # Remove build artifacts
```

---

## Tech Stack

| Technology | Version | Purpose |
|------------|---------|---------|
| TypeScript | ^5.8.2 | Primary language |
| Node.js | ≥ 22.0.0 | Runtime (native `node:sqlite`) |
| pnpm | 11.2.1 | Package manager |
| Turborepo | ^2.5.0 | Monorepo build orchestration |
| Express | ^5.2.1 | HTTP server |
| MCP SDK | ^1.25.2 | Protocol implementation |
| web-tree-sitter | ^0.26.8 | Code parsing (40+ languages) |
| Zod | ^4.3.6 | Schema validation |
| Vitest | ^4.1.5 | Test framework |

---

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run `pnpm build && pnpm test`
5. Submit a pull request

## License

MIT

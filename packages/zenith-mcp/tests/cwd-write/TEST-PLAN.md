# Flint — cwd-write project-detection test suite (six owned tools)

Independent, repeated-call project-detection tests for the six Zenith-MCP tools
`bash`, `write_file`, `edit_file`, `file_manager`, `stashRestore`, `refactor_batch`.
This is **test construction**, not production implementation. Nothing here edits
production source, dependencies, lockfiles, existing tests, or frozen archives.

## What is being measured

A long-running server must keep consulting usable current-directory evidence after
first detecting a project. The suite drives a controlled launcher (the server's
parent) through the project sequence **A → B → A → C → B → A** and records, per
tool invocation, whether the server followed. The frozen baseline (pre-change)
is expected to **fail** the transition steps (it pins the first detected root);
the patched build is expected to follow. The suite is a measurement harness, not
a rubber stamp — it records `wrong-root` honestly with independent ground truth.

## Ground truth is independent

- The **expected active root** is computed from the launcher cwd the test itself
  set, resolved to its realpath and its marker boundary *by the harness* (walking
  for `.git` / `package.json` / etc.), never read back from the server.
- The **observed** root comes from evidence the server cannot be fed by the test:
  - `bash`: the transcript prompt line `<cwd>$ <command>` (black-box observable).
  - all six: the **registration seam** (`run-seam.mjs`) — a real handler + real
    `createFilesystemContext` + real `ProjectContext`, observed at dispatch.
- **Operation target** correctness is asserted by before/after **filesystem
  manifests** (recursive sha256), so a write to the wrong project is detected as
  a cross-project mutation, not by trusting HTTP 200 or a called ping.
- Parent/server OS cwds are captured independently (`/proc/<pid>/cwd` for the
  server, `/proc/self/cwd` + `process.cwd()` for the launcher).

## Transports

- **stdio** (`dist/cli/stdio.js`): newline-delimited JSON-RPC; the server is a
  child of the launcher, so the launcher's cwd is `ancestor[0]` evidence.
- **HTTP** (`dist/server/http.js`): POST `/mcp` with 2026-07-28 stateless framing
  (bare `tools/call`, no session), `Accept: application/json, text/event-stream`,
  bearer auth with a fresh per-run token (never logged). Bound to 127.0.0.1 on an
  ephemeral port. The HTTP server's evidence is its **own launch ancestry** (its
  parent = the launcher) — this tests *local* ancestry, not remote caller discovery.

## The three evidence planes

1. **stdio RPC** — parent-cwd oracle; bash prompt is the observable.
2. **HTTP RPC (local-ancestry)** — server launch-ancestry oracle; same observable.
3. **registration seam** — observes the dispatch-time root for tools whose RPC
   output cannot reveal it (write_file / edit_file / file_manager / refactor_batch
   / stashRestore). Kept separate from unmodified-entrypoint RPC evidence
   (`evidenceTopology: 'registration-seam'`). No identity validators, no forced
   expected root, no synthetic handler, no production diagnostic added.

## Per-tool coverage (planned ≥ 30 per tool per transport)

- **bash** — `pwd` + relative fixture read per transition step; nonzero exit as
  command DATA; merged stderr; ANSI strip; immutable captured cwd of an
  already-started child overlapping a later call; timeout control on bounded
  disposable children; meaningful errors (missing cwd, cwd-is-a-file) + recovery;
  symlink alias; space-dir; explicit `cwd` cross-project **override controls**
  (labeled `override-control`, never counted in detection accuracy).
- **write_file** — create/overwrite/append/append-resume; unique per-project
  payloads; exact destination bytes + sibling immutability; nested new paths;
  unicode / empty / CRLF-normalize / no-trailing-newline; failIfExists (existing
  + new); space/symlink; absolute cross-project writes with ambient cwd unchanged;
  a relative-path write (resolves against the server's fixed launch cwd — recorded
  as `launch-cwd-target`, not detection accuracy).
- **edit_file** — content / block / symbol modes with real success; boundary
  lines, multi-line, block shrink, whitespace-tolerant; ambiguity (block mode),
  not-found, no-edits, missing-file errors + recovery; dryRun controls (must not
  write) that never substitute for real writes; space + symlink targets.
- **file_manager** — info/mkdir/move/delete per transition; move verifies BOTH
  source-absent and destination-present-with-exact-content; delete only files the
  suite created; delete-dir / delete-missing / move-missing-src errors + recovery;
  deliberate cross-project move (labeled `intentional-cross`); space + symlink.
- **stashRestore** — list/read/apply/restore with REAL test-created entries
  (failed `edit_file` content edits → `stash:<id>`; a failed `write_file` onto an
  existing directory → EISDIR → `stashWrite`). `apply` performs a real retry that
  writes the fixture; `restore` clears (subsequent read errors). Relative `file`/
  `newPath` and omitted routing-hint cases are distinct. **Routing honesty:**
  unregistered detected roots route to the shared global stash DB by design
  (anti-litter) — we do not demand separate per-project DBs, nor use identical
  empty responses as a root oracle.
- **refactor_batch** — query / loadDiff / apply / reapply / history / restore on a
  small real JS program (two `targetFn` defs + two callers + two helpers). The
  labeled **persistence-consent** happy path + rollback runs on a REGISTERED
  fixture (registry tier → real per-project `.mcp` DB). Detection cases run on
  UNREGISTERED fixtures with explicit `{symbol, file}` targets (real mutations);
  their symbol DB routes to the neutral workspace — a recorded, intentional
  policy (`getWorkingRoot`), kept separate from active-root detection. Registered
  fixtures are never used to replace unregistered detection cases, and the active
  project is never frozen via allowed-dir setup.

## Transition phases (separately reported, never hidden by a blanket wait)

`first` · `stable` · `immediate` (within the 5s TTL) · `post-ttl` (after >5s) ·
`return` (back to an earlier project). Immediate and post-TTL outcomes are
distinct records (`transitionKind`), so a stale result is never masked.

## Concurrency

- **Two independent servers** (`-twoserver`): two processes, two isolated HOMEs,
  each launched while the parent was parked in a different fixture; each server's
  first-detection `bash pwd` must reflect its OWN ancestry.
- **Same-server concurrent batch**: 4 concurrent `write_file` calls to DISTINCT
  absolute targets — all must land with exact content.
- **Independent HTTP-client control** (HTTP only): a separate requester process
  runs with cwd=C (NOT a server ancestor) while the server's ancestry stays A.
  Over this stateless HTTP transport there is **no requester-cwd signal** (the
  SDK's per-call `extra` carries only an AbortSignal; no roots). The control
  honestly records that the server keeps its launch-ancestry root; it does not
  invent a client-identity mechanism.

## Source limitation (recorded, not worked around)

A single OS process has ONE cwd at a time. The launcher is the parent of the
server(s) it spawns, so two *simultaneous* implicit-cwd requests that must be
attributed to two *different* client cwds cannot be separated by this harness —
there is no per-request client-cwd channel in the 2026-07-28 stateless design.
This is recorded as a source limit (`source-limit` label); we do not fabricate
per-request identity. The independent-HTTP-client control demonstrates the limit
rather than hiding it.

## Metrics (three separate rates, explicit denominators)

Per tool per transport: `planned / attempted / correct / wrong-root /
operation-error / harness-error / unsupported`, plus
**active-root accuracy** (observable checks only), **target accuracy**
(operation-target identity), and **operational success** (real work done), each
with its denominator stated. No 100% claim by exclusion: skipped/error cases stay
in the accounting.

## How to run

The runner must be launched through Python subprocess with a clean env (the
inherited terminal aborts the pinned Node with exit 134 — see
tooling/README.md). `run.py` does this (clean env, RLIMIT_CORE=0, piped logs).
It uses `$ZENITH_NODE` when set, else `node` on PATH; fixtures and isolated
HOMEs are created under `--base` (default `<out-dir>/base`).

```bash
# frozen baseline
python3 run.py \
  --repo-root <baseline-repo> \
  --out-dir   <out>/baseline --repetitions 3 --transports stdio,http

# final patched build (same suite, different --repo-root)
python3 run.py \
  --repo-root <patched-repo> \
  --out-dir   <out>/patched --repetitions 3 --transports stdio,http

# registration-seam evidence (in-process; one repo at a time)
node run-seam.mjs --repo-root <repo> --out-dir <out> --label seam-<name> \
  --home <isolated-home> --fixtures <fixtures-dir>
```

Every repetition uses FRESH fixtures and a FRESH isolated HOME (and a fresh HTTP
token). `--repetitions` ≥ 3 is supported; state never carries between reps.

---

## Executed results (frozen baseline, this run)

What actually ran, with exit statuses and denominators. Planned vs executed: every
planned case was attempted (planned == attempted on every per-tool row; the only
`attempted > planned` deltas are the same-server concurrent batch and the bash
re-establish probe, which are counted on top of the transition+breadth plan).

**Runner**: `run.py` (Python subprocess, clean env, RLIMIT_CORE=0) driving `run.mjs`
against the frozen baseline build, 3 repetitions, both transports. Raw evidence:
`agents/flint/out/baseline-final/*.events.jsonl` (1409 records total). Consolidated:
`results-baseline/COVERAGE-baseline.json` (copied into the deliverable).

### Per-tool / per-transport (3 repetitions combined)

| tool | transport | planned | attempted | correct | wrong-root | op-err | harness-err | unsup | activeRootAcc (den) | targetAcc (den) | opSuccess (den) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| bash | stdio | 105 | 108 | 75 | 33 | 0 | 0 | 0 | 0.656 (96) | 0.639 (108) | 0.694 (108) |
| bash | http | 105 | 108 | 75 | 33 | 0 | 0 | 0 | 0.656 (96) | 0.639 (108) | 0.694 (108) |
| write_file | stdio | 90 | 90 | 90 | 0 | 0 | 0 | 0 | n/a (0) | 1.0 (87) | 1.0 (90) |
| write_file | http | 90 | 90 | 90 | 0 | 0 | 0 | 0 | n/a (0) | 1.0 (87) | 1.0 (90) |
| edit_file | stdio | 93 | 93 | 93 | 0 | 0 | 0 | 0 | n/a (0) | 1.0 (81) | 1.0 (93) |
| edit_file | http | 93 | 93 | 93 | 0 | 0 | 0 | 0 | n/a (0) | 1.0 (81) | 1.0 (93) |
| file_manager | stdio | 144 | 144 | 144 | 0 | 0 | 0 | 0 | n/a (0) | 1.0 (135) | 1.0 (144) |
| file_manager | http | 144 | 144 | 144 | 0 | 0 | 0 | 0 | n/a (0) | 1.0 (135) | 1.0 (144) |
| stashRestore | stdio | 135 | 135 | 135 | 0 | 0 | 0 | 0 | n/a (0) | 1.0 (9) | 1.0 (135) |
| stashRestore | http | 135 | 135 | 135 | 0 | 0 | 0 | 0 | n/a (0) | 1.0 (9) | 1.0 (135) |
| refactor_batch | stdio | 99 | 99 | 99 | 0 | 0 | 0 | 0 | n/a (0) | 1.0 (12) | 1.0 (99) |
| refactor_batch | http | 99 | 99 | 99 | 0 | 0 | 0 | 0 | n/a (0) | 1.0 (12) | 1.0 (99) |

Every tool exceeds the ≥30-measured-invocations-per-transport floor (30–48 per tool
per transport per repetition; 90–144 across the 3 repetitions).

### Reading the baseline numbers

- **bash active-root accuracy 0.656 / 33 wrong-root**: the defect. On each A→B→A→C→B→A
  transition the baseline's `bash` (no `cwd`) keeps executing in the FIRST detected
  root (proj-alpha) while the launcher's cwd is in beta/gamma. The wrong-root set is
  exactly the transition steps (B#2, B#3, C#6 immediate+post-ttl, B#8, B#overlap),
  reproducible across all 3 reps on both transports. `correct` counts include the
  steps where the launcher was actually in A (first/return/stable) plus the labeled
  explicit-`cwd` override controls and the non-detection breadth cases.
- **Other tools, 0 RPC wrong-root**: their OPERATION TARGET is the explicit path the
  caller supplied, which is correct behavior — so the black-box RPC evidence shows
  100% target accuracy. The selected-ROOT defect for these tools is not visible at
  the RPC boundary (a write to `/B/x` writes `/B/x` regardless of the binding); it is
  captured by the seam below, not by RPC.
- **registration seam (in-process, real handler + real FS context)**: 5 wrong-root of
  10 observable transitions for EACH of write_file / edit_file / file_manager /
  refactor_batch / bash — the dispatch-time root stays pinned at proj-alpha across the
  B and C transitions. This is the same defect, observed where black-box RPC cannot
  see it. Kept in `run-seam.mjs` / `seam-*.events.jsonl`, labeled
  `evidenceTopology: 'registration-seam'`, separate from the RPC evidence.
- **twoServerIsolation: 12/12 correct.** Two independent servers (separate processes +
  isolated HOMEs) each detect their own launch ancestry.
- **independentHttpClientControl: 3/3 correct.** An independent HTTP requester running
  in fixture C (not a server ancestor) gets the server's launch-ancestry root (A),
  demonstrating there is no requester-cwd signal over this stateless HTTP transport.

### Dist fingerprints of the build under test (frozen baseline)

Verified against `baseline-dist-sha256.json` (all matched):
- `dist/cli/stdio.js`  f7f66d2f8ebdbbdd8ec34b8d0314bba2707ec8ed163eb9b0388e61102e8ac1ae
- `dist/server/http.js` ebfb297c9d7f23b774aaa79183e1063565e71d565ed2fb14d15502806ded66cb
- `dist/core/project-context.js` 257f195e60b4b9f6e305ddbb2e14833564036deaf75439957df4599d9d4abb70
- `dist/tools/bash.js` 790023489d001aa2a679a3aa744022f7b1bcb2efca3ed35c18ae938463bb2d69
Node: v26.3.0 (pinned).

### Cleanup

After the run: no stray `stdio.js`/`http.js` servers left running (all children
SIGTERM/SIGKILL'd and reaped by the harness), RLIMIT_CORE=0 so no crash dumps, fixtures
and isolated HOMEs are self-contained under the runner's base dir. Verified `ps` clean.

### Known harness notes (not product defects)

- `bash` `targetAccuracy` 0.639 < `activeRootAccuracy` because the explicit-`cwd`
  override controls set an override target (not the active root); they are labeled
  `override-control` and excluded from detection accuracy but still counted as targets.
- The `operationalSuccess` for bash (0.694) reflects the wrong-root transition cases
  (the command still ran successfully — just in the wrong project on the baseline).
  No harness errors and no unsupported cases occurred on the baseline.

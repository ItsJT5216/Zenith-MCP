# Prism cwd-read suite

An independent, repeated-call project-detection test suite for the six
read/search Zenith-MCP tools: `read_file`, `search_file`, `read_media_file`,
`read_multiple_files`, `directory`, `search_files`. It tests the INTENDED
behavior against independent filesystem/process ground truth; assertions are
never relaxed to fit the implementation under test.

**Intended behavior under test:** the same running server keeps considering
CURRENT project evidence on repeated calls after first detection — a relative
operation resolves against the invocation's selected active project, not a
stale launch directory.

## Layout

| File | Role |
|------|------|
| `run.py` | Orchestrator entrypoint. Forwards to the harness. Accepts `--repo-root` and `--out-dir` so the SAME assertions run on the frozen baseline and the final build. |
| `dispatch-observation.test.js` | INSTRUMENTED registration/dispatch layer (vitest). Real handlers + real `FilesystemContext`; observes the selected root before the owned handler runs. No identity mocks; never sets the expected root. |
| `MANIFEST.md` | What is measured and how results are counted. |
| `README.md` | This file. |

The harness implementation (server spawn, ground-truth capture, the per-tool
matrix) lives in the author's scratch `agents/prism/` (`harness.py`,
`matrix.py`, `verifiers.py`, `run_suite.py`, `build_fixtures.py`,
`independent_requester.py`). `run.py` sets `sys.path` to `PRISM_HOME` (default
the scratch dir) and forwards.

## Running

Requires the pinned toolchain on Tanner's machine and a built `dist` in the
chosen repo root. No new dependencies (Python stdlib + Node only).

```bash
# Frozen baseline (orchestrator's stable reference build)
python3 tests/cwd-read/run.py \
  --repo-root /home/tanner/Projects/Zenith-Worktrees/bash/reference/zenith-cwd-handoff/repo \
  --out-dir  /home/tanner/Projects/Zenith-Worktrees/bash/agents/prism/results/baseline \
  --run-id 1

# Final / patched build (after the orchestrator's coordinated rebuild)
python3 tests/cwd-read/run.py \
  --repo-root /home/tanner/Projects/Zenith-Worktrees/bash/zenith-cwd-handoff/repo \
  --out-dir  /home/tanner/Projects/Zenith-Worktrees/bash/agents/prism/results/patched \
  --run-id 1
```

Useful flags: `--transport both|stdio|http` (default both), `--tools all|a,b,c`
(default the six owned tools), `--quick` (skips the slow post-TTL legs for smoke
runs; the full run is the one that reports post-TTL accuracy).

The instrumented dispatch layer runs under the repo's normal vitest:
```bash
cd packages/zenith-mcp
vitest run tests/cwd-read/dispatch-observation.test.js
```

## Outputs (written to --out-dir)

- `records-run<N>.json` — one machine-readable record per invocation: tool,
  mode, transport, server instance, sequence index, timing, evidence topology,
  parent /proc cwd, server /proc cwd, expected active root, observed project,
  expected args, status, and assertion reason.
- `table-run<N>.txt` — per-tool human table of planned / attempted / correct /
  wrong-root / operation-error / harness-error / unsupported.
- `meta-run<N>.json` — run metadata: repo root, transport, tools, settle, the
  captured tools/list inventory per transport, and the summary map.

Active-root accuracy (`correct`/`wrong-root`) is reported separately from
operational success (`operation-error`) and from harness health
(`harness-error`, `unsupported`), which are never folded into the denominator.

## Isolation guarantees

- Servers are spawned from `<repo-root>/packages/zenith-mcp/dist/cli/stdio.js`
  and `dist/server/http.js` — never the live Zenith endpoint.
- HTTP listeners bind `127.0.0.1` on ephemeral ports with fresh per-server
  tokens (kept out of logs and result files).
- Each server gets a fresh isolated `HOME` with a pre-created valid config; the
  first-run wizard never runs against a real HOME.
- Fixtures live under `agents/prism/fixtures` — outside `/tmp`, outside the
  isolated HOME, and outside any unintended ancestor project.
- The suite only terminates processes it started, and verifies cleanup.

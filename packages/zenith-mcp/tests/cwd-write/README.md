# tests/cwd-write — repeated-call project-detection suite (six owned tools)

Independent, substantial, repeated-call project-detection tests for
`bash`, `write_file`, `edit_file`, `file_manager`, `stashRestore`, `refactor_batch`.
See **TEST-PLAN.md** for the full design, ground-truth method, source limits, and
metrics. This is test construction only — it adds no production code and no
competing project resolver.

## Files

| file | role |
|---|---|
| `run.py` | entry-point launcher. Runs the Node runner through Python subprocess with a clean env + RLIMIT_CORE=0 (the inherited terminal aborts the pinned Node — see `tooling/README.md`). Node binary: `$ZENITH_NODE` if set, else `node` on the launcher's PATH; fixtures and isolated HOMEs go under `--base` (default `<out-dir>/base`). |
| `run.mjs` | orchestrator: builds fresh fixtures + isolated HOME per run, launches the server under test (stdio/HTTP) as a child, drives A→B→A→C→B→A per tool, plus the two-server / same-server-batch / independent-HTTP-client cases. |
| `run-seam.mjs` | the labeled registration-seam root-observation run (in-process, real handler + real FilesystemContext + real ProjectContext) for tools whose RPC output cannot reveal the selected root. |
| `lib.mjs` | fixtures, manifests (recursive sha256), isolated HOME/config, expected-boundary computation, env. |
| `server.mjs` | `StdioServer` / `HttpServer` launchers + raw JSON-RPC clients (no SDK dependency in the hot path). |
| `report.mjs` | `Recorder` (JSONL evidence) + `Coverage` (planned/attempted/correct/wrong-root/operation-error/harness-error/unsupported + three separate accuracy metrics). |
| `seam.mjs` | `createSeamObserver` — the registerTool-wrapping observation seam. |
| `transitions.mjs` | the A→B→A→C→B→A transition plan + driver (first/stable/immediate/post-ttl/return). |
| `suite-{bash,writefile,editfile,filemanager,stash,refactor}.mjs` | per-tool case generators. |
| `fixes-test.mjs`, `test_run_py.py` | unit checks of the harness itself (no built server needed): `node --test packages/zenith-mcp/tests/cwd-write/fixes-test.mjs` drives the suites against an in-memory fake server; `python3 -m unittest discover -s packages/zenith-mcp/tests/cwd-write -p 'test_*.py'` covers `run.py`. Not collected by vitest. |

## Run

The runner accepts an explicit repo/build root and output directory, so the SAME
suite runs against the frozen baseline and the final build:

```bash
python3 run.py --repo-root <repo> --out-dir <out> --repetitions 3 --transports stdio,http
```

`<repo>` must contain a built `packages/zenith-mcp/dist`. The runner spawns the
real entrypoints `dist/cli/stdio.js` and `dist/server/http.js` with the Node
binary named by `$ZENITH_NODE`, else the `node` that runs the launcher.

These `.mjs` files are not `*.test.*`, so `pnpm test` (vitest) does not collect
them; they run standalone via `run.py`.

## Ownership

Only `tests/cwd-write/` is owned by this work. No production source, dependency,
lockfile, existing test, or frozen archive is modified. Fixtures live outside
`/tmp`, outside the isolated HOME, and outside any unintended ancestor marker root.

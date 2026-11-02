# Prism cwd-read suite — deliverable manifest

Owner: Prism (Read Test Engineer). Scope: the six read/search tools only
(`read_file`, `search_file`, `read_media_file`, `read_multiple_files`,
`directory`, `search_files`). The other six tools (including `bash`) belong to
the second author and are out of scope here, except for a supplementary,
non-counted bash pwd probe (not used as one of the six).

## What this suite measures

Whether the SAME running server continues to consider CURRENT project evidence
on repeated calls after first detection. Specifically: a relative operation
should resolve against the invocation's selected active project, not a stale
launch directory, across:

- first detection
- stable repeated calls (back-to-back, no restart, no cache clearing)
- immediate transitions inside the original 5-second caller-cwd TTL
- transitions after that TTL (post-TTL), recorded separately from immediate
- the transition sequence A -> B -> A -> C -> B -> A on one server
- cross-project ABSOLUTE controls (labeled `xproj-*`): an absolute op into B
  while the caller stays in A must read B WITHOUT moving the active project for
  the subsequent implicit op

## Mechanics (no schema/header/cwd shortcuts)

- No test invocation supplies `cwd` or any project/identity header.
- The harness process is the server's PARENT; it controls its own cwd
  (`os.chdir`) so the server's `pingCallerEnvironment()` (which reads
  `/proc/<ppid>/cwd`) sees the current project. Server OS cwd is held constant.
- Over HTTP the independent requester is NOT a server ancestor; the active
  project is the server's own launch cwd. A separately-labeled negative control
  (`http-independent-client`) holds server ancestry fixed while varying only the
  independent requester cwd.
- Relative fixture paths (`marker.txt`, `src/notes_<tag>.txt`, ...) are SHARED
  across fixture projects so the path itself never reveals the answer.
- Absolute paths appear only in the labeled cross-project controls.

## Files

- `run.py`                  — orchestrator entrypoint (wraps the prism harness)
- `dispatch-observation.test.js` — INSTRUMENTED registration/dispatch layer
  (real handlers + real FilesystemContext; observes the selected root before
  the owned handler runs; no identity mocks; does not set the expected root)
- `MANIFEST.md`             — this file
- `README.md`               — how to run + how to read results

The heavy lifting (server spawning, ground-truth capture, the per-tool matrix)
lives in the author's scratch at `agents/prism/` (`harness.py`, `matrix.py`,
`verifiers.py`, `run_suite.py`, `build_fixtures.py`). `run.py` forwards to it so
the SAME assertions run against the frozen baseline and the final build.

## Counting rule

`planned` counts every measured invocation. `attempted` = pass + wrong-root +
operation-error. `correct` = pass. `wrong-root` is an active-root/targeting
failure (the operation hit the wrong project tree). `operation-error` is a
product error that is NOT attributable to the wrong tree. `harness-error` and
`unsupported` are never folded into the denominator or reported as accuracy.
Active-root accuracy is reported separately from operational success.

---
"zenith-mcp": minor
---

Add the `bash` tool: run a command with bash in the caller's working directory (there is no working-directory parameter; to work elsewhere, use absolute paths) and get a terminal-style transcript — prompt line, stdout/stderr merged and rendered as a terminal shows them (ANSI stripped; `\r`, erase-line and cursor-to-column replayed per line; control-string payloads dropped), full output, and the exit code as data on the last line. Timeout default and cap are configurable (`bash_timeout_seconds`, default 120; `bash_max_timeout_seconds`, default 600); timeouts and request cancellation stop the whole process group (SIGTERM→SIGKILL; `taskkill` on Windows), and live shells are swept on server exit and shutdown signals. Tool handlers now receive the SDK's per-call `extra` (`ToolCallExtra`, carrying the cancellation signal) as a second argument.

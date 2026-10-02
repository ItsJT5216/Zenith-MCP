---
"zenith-mcp": minor
---

Relative paths given to the filesystem tools (`read_file`, `read_multiple_files`, `read_media_file`, `write_file`, `edit_file`, `directory`, `file_manager`, `search_file`, `search_files`, `refactor_batch`, `stash_restore`) now resolve against the caller's working directory — where the launcher shell or MCP client is working, read from process ancestry by the new `core/caller-cwd.ts` — instead of the server's own working directory. Absolute paths are unchanged, and the configured allowed directories (the sandbox boundary) still resolve against the server's own working directory. `ProjectContext` is not involved: this decides where a relative path lands, not which project Zenith binds to.

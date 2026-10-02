import { getCallerCwds } from './detection/process-tree.js';

// ---------------------------------------------------------------------------
// Caller working directory — the OS-facing primitive.
//
// This is the base behind relative filesystem paths (validatePath /
// validateNewFilePath) and the bash tool's default working directory. It
// answers exactly one question — where is the caller working? — from the
// kernel's record of our process ancestry: the nearest ancestor whose cwd is
// readable (the launcher shell, or the MCP client on stdio), realpath'd and
// existing. Linux reads /proc/<pid>/cwd, macOS uses lsof/ps, Windows cannot
// read ancestor cwds and so answers with our own; when no ancestor cwd is
// readable on any platform the answer is likewise this process's own cwd.
//
// It is NOT a project detector. No git or marker walks, no registry lookup,
// no binding, no persistence, no DB routing — every one of those decisions
// stays in core/project-context.ts, which answers the other question ("what
// project should Zenith bind to?") and keeps answering it exactly as before.
// This module is the one consumer of core/detection/ that is not a resolver:
// it reads the ancestry walk and decides nothing about what the result means.
// ---------------------------------------------------------------------------

/**
 * Where the caller is working: the nearest readable ancestor's cwd
 * (realpath'd, existing), else this process's own cwd. Reads the same
 * TTL-cached ancestry walk ProjectContext's ping uses: between refreshes a
 * call costs nothing; the first call after the 5 s TTL runs the walk itself
 * (a few /proc reads on Linux; lsof/ps per ancestor on macOS).
 */
export function getCallerWorkingDirectory(): string {
    const [nearest] = getCallerCwds();
    // Under noUncheckedIndexedAccess the first element is possibly undefined.
    // The walk always appends our own cwd, and the resolved list drops an entry
    // only when it cannot be realpath'd or stat'd — so the list is empty only
    // when even our own cwd fails that, and the raw cwd is then the one answer
    // left. Not a substitution for a value the walk would otherwise have given.
    return nearest?.cwd ?? process.cwd();
}

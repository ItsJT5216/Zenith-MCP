// ---------------------------------------------------------------------------
// core/server.ts — SDK-agnostic server orchestration
//
// This file owns ONLY logic that is genuinely shared across all entrypoints:
//   - resolveInitialAllowedDirectories / validateDirectories  (CLI + HTTP)
//   - TOOL_REGISTRY                                            (single source of truth)
//   - registerEnabledTools(toolServer, ctx)                    (config load + tool wiring)
//
// What this file deliberately does NOT do:
//   - construct an McpServer (that is each entrypoint's job — HTTP builds one
//       per request in its factory, stdio one per connection via serveStdio)
//
// Each entrypoint constructs its own McpServer, then calls
// registerEnabledTools to load tools against its process FilesystemContext.
// ---------------------------------------------------------------------------

import fs from "fs/promises";
import path from "path";
import { normalizePath, expandHome } from './path-utils.js';
import { getProjectContext } from './project-context.js';
import { type ToolServer, type ToolContext, type ToolCallExtra } from '../tools/types.js';
import { type FilesystemContext } from './lib.js';

import { register as registerReadFile } from '../tools/read_file.js';
import { register as registerSearchFile } from '../tools/search_file.js';
import { register as registerReadMediaFile } from '../tools/read_media_file.js';
import { register as registerReadMultipleFiles } from '../tools/read_multiple_files.js';
import { register as registerWriteFile } from '../tools/write_file.js';
import { register as registerEditFile } from '../tools/edit_file.js';
import { register as registerDirectory } from '../tools/directory.js';
import { register as registerSearchFiles } from '../tools/search_files.js';
import { register as registerFilesystem } from '../tools/filesystem.js';
import { register as registerStashRestore } from '../tools/stash_restore.js';
import { register as registerRefactorBatch } from '../tools/refactor_batch.js';
import { register as registerBash } from '../tools/bash.js';
import { configureRegistry } from '../adapters/index.js';
import { loadConfig, syncToolsWithConfig, patchToolsInConfig, expandTilde } from '../config/index.js';
import type { ZenithConfig } from '../config/index.js';

export async function resolveInitialAllowedDirectories(args: string[]): Promise<string[]> {
  const resolved = await Promise.all(args.map(async (dir: string) => {
    const expanded = expandHome(dir);
    const absolute = path.resolve(expanded);
    try {
      const result = await fs.realpath(absolute);
      return normalizePath(result);
    } catch {
      return normalizePath(absolute);
    }
  }));
  return [...new Set(resolved)]; // deduplicate
}

export async function validateDirectories(directories: string[]): Promise<void> {
  const errors: string[] = [];
  await Promise.all(directories.map(async (dir: string) => {
    try {
      const stats = await fs.stat(dir);
      if (!stats.isDirectory()) {
        errors.push(`${dir} is not a directory`);
      }
    } catch (error) {
      errors.push(`Cannot access directory ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));

  if (errors.length > 0) {
    throw new Error(`Directory validation failed:\n  ${errors.join('\n  ')}`);
  }
}

/**
 * Maps each register function to its tool name string (the first argument
 * passed to `server.registerTool(name, ...)` inside each tool file).
 *
 * This is the single source of truth for tool-name discovery. When a new
 * tool file is added, append an entry here and it will be picked up
 * automatically by config merging and the enabled/disabled guard.
 */
const TOOL_REGISTRY: Array<{
  name: string;
  register: (server: ToolServer, ctx: ToolContext) => void;
}> = [
  { name: "read_file",           register: registerReadFile },
  { name: "search_file",         register: registerSearchFile },
  { name: "read_media_file",     register: registerReadMediaFile },
  { name: "read_multiple_files", register: registerReadMultipleFiles },
  { name: "write_file",          register: registerWriteFile },
  { name: "edit_file",           register: registerEditFile },
  { name: "directory",           register: registerDirectory },
  { name: "search_files",        register: registerSearchFiles },
  { name: "file_manager",        register: registerFilesystem },
  { name: "stashRestore",        register: registerStashRestore },
  { name: "refactor_batch",      register: registerRefactorBatch },
  { name: "bash",                register: registerBash },
];

/**
 * Default server instructions string. Each entrypoint passes this (or its own
 * override) into its SDK-specific `new McpServer(..., { instructions })` call.
 */
export const SERVER_INSTRUCTIONS =
  "Each call must set mode and the corresponding params, unless the schema lists the param explicitly as optional. Global Mode Rule: tool params apply only to the mode specified in the tools description. A param is shared only when explicitly listed for multiple modes.";

/**
 * Loads config, syncs the on-disk tool list against the in-code TOOL_REGISTRY,
 * configures the auto-write adapter if enabled, and calls each enabled tool's
 * `register(toolServer, ctx)` against the supplied SDK-agnostic ToolServer.
 *
 * `ToolServer` is this package's minimal abstraction for the subset of
 * `registerTool(...)` behavior used by the tool modules. It is intended to map
 * cleanly onto the MCP SDK servers at runtime, but the SDKs' TypeScript
 * declarations are not currently assignable to `ToolServer` in every entrypoint
 * without an adapter or cast. Keep this contract SDK-agnostic here, and let
 * SDK-specific entrypoints bridge any typing differences as needed.
 */
export function registerEnabledTools(toolServer: ToolServer, ctx: ToolContext): void {
  // ── Config: load, sync discovered tools, patch if needed ─────────────
  const config: ZenithConfig = loadConfig();

  const availableToolNames: string[] = TOOL_REGISTRY.map((t) => t.name);
  const { config: syncedConfig, changed } = syncToolsWithConfig(config, availableToolNames);

  // Only write to disk if tools actually changed, and use surgical patching
  // so comments, formatting, and unknown sections are preserved.
  if (changed) {
    patchToolsInConfig(syncedConfig.tools);
  }

  // ── Sandbox enforcement is OPT-IN via config (default off) ───────────
  // Wire the explicit `sandbox` flag into the filesystem context so access
  // enforcement is governed by operator intent, NOT by the mere presence of
  // allowed directories (those are always populated from CLI args / MCP roots
  // and exist purely as project-context hints). Set before any tool registers.
  ctx.setSandboxEnabled?.(syncedConfig.sandbox);

  // ── Auto-write adapter setup (guarded by config flag) ────────────────
  if (syncedConfig.auto_write.status) {
    const resolvedBackupDir = syncedConfig.auto_write.backup_dir
      ? expandTilde(syncedConfig.auto_write.backup_dir)
      : undefined;
    configureRegistry(resolvedBackupDir);
  }

  // ── Register only the tools that are enabled in config ───────────────
  // Every handler is wrapped with the caller-environment ping: a server-side,
  // model-free detection signal (process-tree cwds, TTL-cached, upgrade-from-
  // global only). Tool schemas are untouched — the model carries ZERO
  // responsibility for project detection, by design.
  const pingedServer = withCallerEnvironmentPing(toolServer, ctx);
  for (const entry of TOOL_REGISTRY) {
    if (syncedConfig.tools[entry.name]) {
      entry.register(pingedServer, ctx);
    }
  }
}

/**
 * Wrap a ToolServer so every tool call pings ProjectContext with caller
 * environment evidence before the real handler runs. The walk is throttled
 * (TTL cache inside the process-tree reader) and the ping is a no-op unless
 * the session is currently in global fallback — path evidence, registry
 * matches, and explicit bindings always outrank environment inference.
 *
 * The ping must NEVER break a tool call: detection failures are swallowed.
 */
export function withCallerEnvironmentPing(toolServer: ToolServer, ctx: ToolContext): ToolServer {
  return {
    registerTool<TArgs>(
      name: string,
      registration: Parameters<ToolServer['registerTool']>[1],
      handler: (args: TArgs, extra?: ToolCallExtra) => ReturnType<Parameters<ToolServer['registerTool']>[2]>
    ): void {
      toolServer.registerTool<TArgs>(name, registration, (args: TArgs, extra?: ToolCallExtra) => {
        try {
          getProjectContext(ctx).pingCallerEnvironment();
        } catch {
          // Detection is best-effort by contract — never fail a tool call.
        }
        return handler(args, extra);
      });
    },
  };
}

// ---------------------------------------------------------------------------
// setupProjectDetection — config-based project registry
// ---------------------------------------------------------------------------

/**
 * Wire project detection for a session: load config projects, set notify fn.
 * Called once per session/entrypoint after server + ctx are ready.
 * Registry auto-refreshes lazily on mismatch (no file watcher needed).
 */
export function setupProjectDetection(
  ctx: FilesystemContext,
  notifyFn: (message: string) => void,
): void {
  const pc = getProjectContext(ctx);

  // Load initial projects from config (always call, even if empty, to clear legacy state)
  const config = loadConfig();
  pc.reloadRegistry(config.projects);

  // Set notification function (fires sendLoggingMessage)
  pc.setNotifyFn(notifyFn);
}

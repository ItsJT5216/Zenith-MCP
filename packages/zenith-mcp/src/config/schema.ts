import { homedir } from "node:os";
import { join } from "node:path";
import type { RawConfig } from "./parser.js";

// ---------------------------------------------------------------------------
// ProjectEntry — user-declared project in config
// ---------------------------------------------------------------------------

export interface ProjectEntry {
  project_id: string;
  project_name: string | null;
  project_root: string;
  description?: string | null;
  language?: string | null;
  tags?: string[];
  include?: string[];
  exclude?: string[];
  entry_point?: string | null;
}

// ---------------------------------------------------------------------------
// ZenithConfig — typed representation of the Zenith-MCP config file
// ---------------------------------------------------------------------------

export interface ZenithConfig {
  port: number;
  sandbox: boolean;
  tools: Record<string, boolean>;
  projects: ProjectEntry[];
  auto_write: {
    status: boolean;
    backup_dir: string;
    backup_mode: "file" | "sqlite" | "none";
    custom_mcp_paths: string[];
  };
  rag: {
    status: boolean;
    postgres_url: string;
    username: string;
    password: string;
  };
  advanced: {
    char_budget: number;
    search_char_budget: number;
    refactor_max_chars: number;
    refactor_max_context: number;
    refactor_version_ttl_hours: number;
    session_ttl_ms: number;
    /** Default wall-clock limit, in seconds, for a `bash` tool call that does not pass `timeout`. */
    bash_timeout_seconds: number;
    /** Upper bound, in seconds, on any `bash` tool call's timeout — a larger request is clamped to it. */
    bash_max_timeout_seconds: number;
    default_excludes: string;
    sensitive_patterns: string;
    /**
     * Auto-promotion threshold: when a DETECTED (unregistered) project has
     * been observed in this many distinct sessions, promote it in-memory to
     * registry tier (enables its project-scoped .mcp DB) and notify.
     * 0 (default) = off: detection only notifies with promotion instructions;
     * the config file stays the sole persistent source of truth either way.
     */
    auto_promote_sessions: number;
  };
}

// ---------------------------------------------------------------------------
// Defaults (sourced from shared.ts constants)
// ---------------------------------------------------------------------------

const DEFAULT_EXCLUDES_STR =
  "node_modules,.git,.next,.venv,venv,.env.local,dist,build,out,output,.cache,.turbo,.nuxt,.output,.svelte-kit,.parcel-cache,__pycache__,.pytest_cache,.mypy_cache,coverage,.nyc_output,.coverage,.DS_Store,*.min.js,*.min.css,*.map,.tsbuildinfo";

const DEFAULT_SENSITIVE_STR =
  "**/.env,**/*.pem,**/*.key,**/*.crt,**/*credentials*,**/*secret*,**/docker-compose.yaml,**/docker-compose.yml,**/.config/**";

export const DEFAULT_CONFIG: ZenithConfig = {
  port: 7000,
  sandbox: false,
  tools: {},
  projects: [],
  auto_write: {
    status: false,
    backup_dir: "",
    backup_mode: "file",
    custom_mcp_paths: [],
  },
  rag: {
    status: false,
    postgres_url: "",
    username: "",
    password: "",
  },
  advanced: {
    char_budget: 400_000,
    search_char_budget: 15_000,
    refactor_max_chars: 30_000,
    refactor_max_context: 30,
    refactor_version_ttl_hours: 24,
    session_ttl_ms: 1_800_000,
    bash_timeout_seconds: 120,
    bash_max_timeout_seconds: 600,
    auto_promote_sessions: 0,
    default_excludes: DEFAULT_EXCLUDES_STR,
    sensitive_patterns: DEFAULT_SENSITIVE_STR,
  },
};

// ---------------------------------------------------------------------------
// Config file path
// ---------------------------------------------------------------------------

export const CONFIG_PATH: string = join(homedir(), ".zenith-mcp", "config");

// ---------------------------------------------------------------------------
// Helpers — tilde expansion for user-provided paths
// ---------------------------------------------------------------------------

/**
 * Replace a leading `~` or `~/` with the actual home directory.
 * Node's `fs` functions do NOT expand tilde — they would create a literal
 * directory named `~` in the cwd.  Call this on any user-supplied path
 * before passing it to the filesystem.
 */
export function expandTilde(p: string): string {
  if (p.includes('\0')) throw new Error('Path contains null byte');
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

// ---------------------------------------------------------------------------
// Helpers — status booleans <-> "enabled"/"disabled" strings
// ---------------------------------------------------------------------------

function statusToStr(v: boolean): string {
  return v ? "enabled" : "disabled";
}

function strToStatus(v: string): boolean {
  return v.trim().toLowerCase() === "enabled";
}

// ---------------------------------------------------------------------------
// Helpers — RawConfig entry constructors
// ---------------------------------------------------------------------------

type RawEntry =
  | { type: "section"; name: string; raw: string }
  | { type: "subsection"; name: string; raw: string }
  | { type: "kv"; key: string; value: boolean | number | string; rawValue: string; inlineComment: string | null }
  | { type: "comment"; text: string }
  | { type: "blank" };

function subsection(name: string): RawEntry {
  return { type: "subsection", name, raw: `### ${name}` };
}

function kv(key: string, value: boolean | number | string, rawValue?: string): RawEntry {
  return {
    type: "kv",
    key,
    value,
    rawValue: rawValue ?? String(value),
    inlineComment: null,
  };
}

function comment(text: string): RawEntry {
  return { type: "comment", text };
}

function blank(): RawEntry {
  return { type: "blank" };
}

// ---------------------------------------------------------------------------
// configToRaw — typed config -> parser's RawConfig array
// ---------------------------------------------------------------------------

export function configToRaw(config: ZenithConfig): RawConfig {
  const entries: RawEntry[] = [];

  // Top-level port and sandbox (no section header — they sit above all sections)
  entries.push(kv("Port", config.port, String(config.port)));
  entries.push(kv("Sandbox", config.sandbox, statusToStr(config.sandbox)));
  entries.push(blank());

  // ### Tools
  entries.push(subsection("Tools"));
  const toolNames = Object.keys(config.tools).sort();
  if (toolNames.length === 0) {
    entries.push(comment("# (no tools configured)"));
  } else {
    for (const name of toolNames) {
      const enabled = config.tools[name];
      if (enabled === undefined) continue;
      entries.push(kv(name, enabled, statusToStr(enabled)));
    }
  }
  entries.push(blank());

  // ### Projects
  entries.push(subsection("Projects"));
  if (config.projects.length === 0) {
    entries.push(comment("# (no projects configured)"));
  } else {
    for (const proj of config.projects) {
      entries.push(comment(`== ${proj.project_name ?? proj.project_id} ==`));
      entries.push(kv("Project_ID", proj.project_id, proj.project_id));
      entries.push(kv("Project_Root", proj.project_root, proj.project_root));
      if (proj.project_name != null) {
        entries.push(kv("Project_Name", proj.project_name, proj.project_name));
      }
      if (proj.description != null) {
        entries.push(kv("Description", proj.description, proj.description));
      }
      if (proj.language != null) {
        entries.push(kv("Language", proj.language, proj.language));
      }
      if (proj.tags !== undefined && proj.tags.length > 0) {
        entries.push(kv("Tags", proj.tags.join(","), proj.tags.join(",")));
      }
      if (proj.include !== undefined && proj.include.length > 0) {
        entries.push(kv("Include", proj.include.join(","), proj.include.join(",")));
      }
      if (proj.exclude !== undefined && proj.exclude.length > 0) {
        entries.push(kv("Exclude", proj.exclude.join(","), proj.exclude.join(",")));
      }
      if (proj.entry_point != null) {
        entries.push(kv("Entry_Point", proj.entry_point, proj.entry_point));
      }
      entries.push(blank());
    }
  }
  entries.push(blank());

  // ### Auto Write
  entries.push(subsection("Auto Write"));
  entries.push(kv("status", config.auto_write.status, statusToStr(config.auto_write.status)));
  entries.push(kv("backup_dir", config.auto_write.backup_dir, config.auto_write.backup_dir));
  entries.push(kv("backup_mode", config.auto_write.backup_mode, config.auto_write.backup_mode));
  entries.push(kv("custom_mcp_paths", config.auto_write.custom_mcp_paths.join(","), config.auto_write.custom_mcp_paths.join(",")));
  entries.push(blank());

  // ### Zenith-Rag
  entries.push(subsection("Zenith-Rag"));
  entries.push(kv("status", config.rag.status, statusToStr(config.rag.status)));
  entries.push(kv("postgres_url", config.rag.postgres_url, config.rag.postgres_url));
  entries.push(kv("username", config.rag.username, config.rag.username));
  entries.push(kv("password", config.rag.password, config.rag.password));
  entries.push(blank());

  // ### Advanced
  entries.push(subsection("Advanced"));
  entries.push(kv("char_budget", config.advanced.char_budget, String(config.advanced.char_budget)));
  entries.push(kv("search_char_budget", config.advanced.search_char_budget, String(config.advanced.search_char_budget)));
  entries.push(kv("refactor_max_chars", config.advanced.refactor_max_chars, String(config.advanced.refactor_max_chars)));
  entries.push(kv("refactor_max_context", config.advanced.refactor_max_context, String(config.advanced.refactor_max_context)));
  entries.push(kv("refactor_version_ttl_hours", config.advanced.refactor_version_ttl_hours, String(config.advanced.refactor_version_ttl_hours)));
  entries.push(kv("session_ttl_ms", config.advanced.session_ttl_ms, String(config.advanced.session_ttl_ms)));
  entries.push(kv("bash_timeout_seconds", config.advanced.bash_timeout_seconds, String(config.advanced.bash_timeout_seconds)));
  entries.push(kv("bash_max_timeout_seconds", config.advanced.bash_max_timeout_seconds, String(config.advanced.bash_max_timeout_seconds)));
  entries.push(kv("auto_promote_sessions", config.advanced.auto_promote_sessions, String(config.advanced.auto_promote_sessions)));
  entries.push(kv("default_excludes", config.advanced.default_excludes, config.advanced.default_excludes));
  entries.push(kv("sensitive_patterns", config.advanced.sensitive_patterns, config.advanced.sensitive_patterns));

  return entries as RawConfig;
}

// ---------------------------------------------------------------------------
// rawToConfig — parser's RawConfig array -> typed config
// ---------------------------------------------------------------------------

/** A whole decimal integer in safe range, or NaN. Unlike parseInt, "45oops", "1.9" and "1e3" are not numbers. */
function parseDecimalInteger(raw: string): number {
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) ? n : NaN;
}

export function rawToConfig(raw: RawConfig): ZenithConfig {
  // Start from a deep copy of defaults so every field is guaranteed present.
  const config: ZenithConfig = structuredClone(DEFAULT_CONFIG);

  // Track which subsection we're inside so we route keys correctly.
  let currentSection: string | null = null;

  // Project parsing state
  let currentProject: Partial<ProjectEntry> | null = null;

  function flushProject(): void {
    if (currentProject && currentProject.project_id && currentProject.project_root) {
      config.projects.push({
        project_id: currentProject.project_id,
        project_name: currentProject.project_name ?? null,
        project_root: currentProject.project_root,
        ...(currentProject.description != null ? { description: currentProject.description } : {}),
        ...(currentProject.language != null ? { language: currentProject.language } : {}),
        ...(currentProject.tags !== undefined ? { tags: currentProject.tags } : {}),
        ...(currentProject.include !== undefined ? { include: currentProject.include } : {}),
        ...(currentProject.exclude !== undefined ? { exclude: currentProject.exclude } : {}),
        ...(currentProject.entry_point != null ? { entry_point: currentProject.entry_point } : {}),
      });
    }
    currentProject = null;
  }

  for (const entry of raw as RawEntry[]) {
    // Only ### subsection headers set the routing context.
    if (entry.type === "subsection") {
      // Flush any pending project when leaving the projects section
      if (currentSection === "projects") flushProject();
      currentSection = entry.name.toLowerCase();
      continue;
    }
    if (entry.type === "section") {
      continue;
    }

    // Inside ### Projects: detect `== Title ==` boundaries from comment entries
    if (currentSection === "projects" && entry.type === "comment") {
      const titleMatch = entry.text.match(/^==\s*(.+?)\s*==$/);
      if (titleMatch) {
        flushProject();
        currentProject = { project_name: titleMatch[1] ?? null };
      }
      continue;
    }

    if (entry.type !== "kv") continue;

    const key = entry.key;
    const raw_val = entry.rawValue?.trim() ?? String(entry.value ?? "");

    // Top-level (before any subsection header)
    if (currentSection === null) {
      if (key.toLowerCase() === "port") {
        const n = parseInt(raw_val, 10);
        if (!isNaN(n)) config.port = n;
      } else if (key.toLowerCase() === "sandbox") {
        config.sandbox = strToStatus(raw_val);
      }
      continue;
    }

    // ### Projects — route keys to current project entry
    if (currentSection === "projects") {
      if (!currentProject) {
        // Keys before the first == Title == — treat as implicit entry
        currentProject = {};
      }
      switch (key) {
        case "Project_ID":
          currentProject.project_id = raw_val;
          break;
        case "Project_Root":
          currentProject.project_root = raw_val;
          break;
        case "Project_Name":
          currentProject.project_name = raw_val;
          break;
        case "Description":
          currentProject.description = raw_val;
          break;
        case "Language":
          currentProject.language = raw_val;
          break;
        case "Tags":
          currentProject.tags = raw_val ? raw_val.split(",").map(s => s.trim()).filter(Boolean) : [];
          break;
        case "Include":
          currentProject.include = raw_val ? raw_val.split(",").map(s => s.trim()).filter(Boolean) : [];
          break;
        case "Exclude":
          currentProject.exclude = raw_val ? raw_val.split(",").map(s => s.trim()).filter(Boolean) : [];
          break;
        case "Entry_Point":
          currentProject.entry_point = raw_val;
          break;
      }
      continue;
    }

    // ### Tools — every key is a dynamic tool name
    if (currentSection === "tools") {
      config.tools[key] = strToStatus(raw_val);
      continue;
    }

    // ### Auto Write
    if (currentSection === "auto write") {
      switch (key) {
        case "status":
          config.auto_write.status = strToStatus(raw_val);
          break;
        case "backup_dir":
          config.auto_write.backup_dir = raw_val;
          break;
        case "backup_mode":
          if (raw_val === "file" || raw_val === "sqlite" || raw_val === "none") {
            config.auto_write.backup_mode = raw_val;
          }
          break;
        case "custom_mcp_paths":
          config.auto_write.custom_mcp_paths = raw_val
            ? raw_val.split(",").map((s) => s.trim()).filter(Boolean)
            : [];
          break;
        // unknown keys are silently ignored (preserved in RawConfig for round-trip)
      }
      continue;
    }

    // ### Zenith-Rag
    if (currentSection === "zenith-rag") {
      switch (key) {
        case "status":
          config.rag.status = strToStatus(raw_val);
          break;
        case "postgres_url":
          config.rag.postgres_url = raw_val;
          break;
        case "username":
          config.rag.username = raw_val;
          break;
        case "password":
          config.rag.password = raw_val;
          break;
      }
      continue;
    }

    // ### Advanced
    if (currentSection === "advanced") {
      switch (key) {
        case "char_budget": {
          const n = parseInt(raw_val, 10);
          if (!isNaN(n)) config.advanced.char_budget = n;
          break;
        }
        case "search_char_budget": {
          const n = parseInt(raw_val, 10);
          if (!isNaN(n)) config.advanced.search_char_budget = n;
          break;
        }
        case "refactor_max_chars": {
          const n = parseInt(raw_val, 10);
          if (!isNaN(n)) config.advanced.refactor_max_chars = n;
          break;
        }
        case "refactor_max_context": {
          const n = parseInt(raw_val, 10);
          if (!isNaN(n)) config.advanced.refactor_max_context = n;
          break;
        }
        case "refactor_version_ttl_hours": {
          const n = parseInt(raw_val, 10);
          if (!isNaN(n)) config.advanced.refactor_version_ttl_hours = n;
          break;
        }
        case "session_ttl_ms": {
          const n = parseInt(raw_val, 10);
          if (!isNaN(n)) config.advanced.session_ttl_ms = n;
          break;
        }
        case "bash_timeout_seconds": {
          const n = parseDecimalInteger(raw_val);
          if (n > 0) config.advanced.bash_timeout_seconds = n;
          break;
        }
        case "bash_max_timeout_seconds": {
          const n = parseDecimalInteger(raw_val);
          if (n > 0) config.advanced.bash_max_timeout_seconds = n;
          break;
        }
        case "auto_promote_sessions": {
          const n = parseInt(raw_val, 10);
          if (!isNaN(n) && n >= 0) config.advanced.auto_promote_sessions = n;
          break;
        }
        case "default_excludes":
          config.advanced.default_excludes = raw_val;
          break;
        case "sensitive_patterns":
          config.advanced.sensitive_patterns = raw_val;
          break;
      }
      continue;
    }

    // Any other section — ignore keys (they stay in RawConfig for round-trip).
  }

  // Flush the last project if file ends inside ### Projects
  if (currentSection === "projects") flushProject();

  return config;
}
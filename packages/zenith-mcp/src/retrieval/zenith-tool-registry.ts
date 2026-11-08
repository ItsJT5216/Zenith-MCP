/**
 * Zenith's local tool registry — tracks tools on the single Zenith server.
 * Extracted from tool_to_server dict pattern in mcp_proxy.py.
 *
 * HAZARD 1: Plain class, no MCP inheritance.
 * Handlers are stored but never invoked by this class.
 */

import { createHash } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolMapping } from "./models.js";

export function makeToolKey(namespace: string, toolName: string): string {
  return `${namespace}__${toolName}`;
}

export function hashToolList(tools: Tool[]): string {
  const fps = tools
    .map((t) => [t.name, t.description ?? "", JSON.stringify(t.inputSchema ?? {})].join("|"))
    .sort();
  return createHash("sha256").update(fps.join(";;"), "utf-8").digest("hex").slice(0, 16);
}

export class ZenithToolRegistry {
  private _m = new Map<string, ToolMapping>();

  register(tool: Tool, handler?: unknown, inputZodSchema?: unknown): ToolMapping {
    const key = makeToolKey("zenith", tool.name);
    const mapping: ToolMapping = { serverName: "zenith", tool, handler, inputZodSchema };
    this._m.set(key, mapping);
    return mapping;
  }

  unregister(toolName: string): boolean {
    return this._m.delete(makeToolKey("zenith", toolName));
  }

  get(toolKey: string): ToolMapping | undefined {
    return this._m.get(toolKey);
  }

  list(): ToolMapping[] {
    return [...this._m.values()];
  }

  /** Shallow copy — callers can iterate without aliasing registry state. */
  asRecord(): Record<string, ToolMapping> {
    const r: Record<string, ToolMapping> = {};
    for (const [k, v] of this._m) r[k] = v;
    return r;
  }

  /** Live read-only view for consumers that must observe late registrations. */
  asLiveRecord(): Record<string, ToolMapping> {
    return new Proxy({} as Record<string, ToolMapping>, {
      ownKeys: () => {
        return [...this._m.keys()];
      },
      getOwnPropertyDescriptor: (_target, key) => {
        return typeof key === "string" && this._m.has(key)
          ? { enumerable: true, configurable: true }
          : undefined;
      },
      get: (_target, key) => {
        return typeof key === "string" ? this._m.get(key) : undefined;
      },
      has: (_target, key) => {
        return typeof key === "string" && this._m.has(key);
      },
    });
  }

  hash(): string {
    return hashToolList([...this._m.values()].map((m) => m.tool));
  }
}

/**
 * Two-tier description assembly for token-optimized tool lists.
 *
 * Full tier: complete description + full inputSchema (top-K tools).
 * Summary tier: truncated description + simplified schema (remaining tools).
 * ~90% token reduction for summary-tier tools.
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { RetrievalConfig, ScoredTool } from "./models.js";

const MAX_SUMMARY_CHARS = 80;
const SENTENCE_BOUNDARY = /(?<=[.!?])\s+/;

function truncateDescription(desc: string): string {
  if (!desc || desc.length <= MAX_SUMMARY_CHARS) return desc;

  // Try first sentence
  // Nonempty input and a nonempty separator with limit 2 always produce a first segment.
  const parts = desc.split(SENTENCE_BOUNDARY, 2) as [string, ...string[]];
  if (parts.length > 1 && parts[0].length <= MAX_SUMMARY_CHARS) {
    return parts[0];
  }

  // Fall back to char limit
  return desc.slice(0, MAX_SUMMARY_CHARS).trimEnd() + "…";
}

function stripDescriptions(schema: unknown): unknown {
  if (!isObject(schema)) return schema;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "description") continue;
    if (key === "properties" && isObject(value)) {
      result[key] = Object.fromEntries(
        Object.entries(value).map(([propName, propVal]) => [
          propName,
          stripDescriptions(propVal),
        ]),
      );
    } else if (key === "items" && isObject(value)) {
      result[key] = stripDescriptions(value);
    } else if (isObject(value)) {
      result[key] = stripDescriptions(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

import { isObject } from "./utils.js";

export class TieredAssembler {
  assemble(
    tools: ScoredTool[],
    config: RetrievalConfig,
    routingToolSchema?: Tool,
  ): Tool[] {
    const result: Tool[] = [];

    if (tools.length === 0 && !routingToolSchema) {
      return result;
    }

    for (let i = 0; i < tools.length; i++) {
      const scored = tools[i];
      const original = scored.toolMapping.tool;

      if (i < config.fullDescriptionCount) {
        scored.tier = "full";
        result.push({
          name: original.name,
          description: original.description ?? "",
          inputSchema: structuredClone(original.inputSchema ?? {}),
        });
      } else {
        scored.tier = "summary";
        result.push({
          name: original.name,
          description: truncateDescription(original.description ?? ""),
          inputSchema: stripDescriptions(
            structuredClone(original.inputSchema ?? {}),
          ) as Tool["inputSchema"],
        });
      }
    }

    if (routingToolSchema) {
      result.push(routingToolSchema);
    }

    return result;
  }
}


#!/usr/bin/env npx ts-node --esm
/**
 * Dumps the full MCP tool schema exactly as a model would see it.
 * 
 * Usage:
 *   npx ts-node --esm scripts/dump-schema.ts [output-file]
 *   # or after build:
 *   node dist/scripts/dump-schema.js [output-file]
 * 
 * If output-file is provided, writes JSON there. Otherwise prints to stdout.
 */

// scripts/dump-schema.ts uses the v2 client (@modelcontextprotocol/client) to
// match the v2 server both entrypoints now run; the dumped schema is exactly
// what a modern client negotiates from serveStdio.
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Script lives in dist/scripts/, so go up two levels to project root
const projectRoot = path.resolve(__dirname, "../..");

async function main() {
  const outputFile = process.argv[2];
  
  // Create transport that spawns the server
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(projectRoot, "dist/cli/stdio.js"), projectRoot],
  });

  // Create client
  const client = new Client(
    { name: "schema-dumper", version: "1.0.0" },
    { capabilities: {} }
  );

  try {
    // Connect to server
    await client.connect(transport);

    // Request tool list - this is exactly what a model sees
    const result = await client.listTools();

    const output = JSON.stringify(result, null, 2);

    if (outputFile) {
      await fs.writeFile(outputFile, output, "utf-8");
      console.error(`Schema written to: ${outputFile}`);
      console.error(`Total tools: ${result.tools.length}`);
    } else {
      console.log(output);
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});

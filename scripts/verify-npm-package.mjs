#!/usr/bin/env node
// Verify the *exact* archive to be published from a fresh npm installation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(readFileSync(join(root, '.release/manifest.json'), 'utf8'));
assert.equal(metadata.name, 'zenith-mcp');
assert.equal(metadata.tarball, join(root, '.release', 'zenith-mcp-' + metadata.version + '.tgz'));
assert(existsSync(metadata.tarball), 'Missing archive; run pnpm release:pack first');
assert.equal(createHash('sha256').update(readFileSync(metadata.tarball)).digest('hex'),
  metadata.sha256, 'Archive changed since staging');
assert.equal('sha512-' + createHash('sha512').update(readFileSync(metadata.tarball)).digest('base64'),
  metadata.integrity, 'Tarball SRI does not match the staged artifact');
const scratch = mkdtempSync(join(tmpdir(), 'zenith-npm-install-'));
try {
  const install = spawnSync('npm', [
    'install', '--prefix', scratch, '--ignore-scripts', '--no-audit',
    '--no-fund', '--no-progress', '--omit=dev', metadata.tarball,
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(install.status, 0, 'Clean npm install failed:\n' + install.stderr + '\n' + install.stdout);
  const installed = join(scratch, 'node_modules/zenith-mcp');
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'zenith-mcp');
  assert.equal(manifest.version, metadata.version);
  assert.equal(manifest.dependencies?.['zenith-toon'], undefined,
    'TOON was left as an external dependency');
  assert.equal(manifest.bin?.['zenith-mcp'], 'dist/cli/stdio.js');
  const toon = await import(pathToFileURL(join(installed, 'dist/toon/index.js')));
  assert.equal(typeof toon.compressFile, 'function', 'TOON runtime export unavailable');
  const bridge = await import(pathToFileURL(join(installed, 'dist/core/compression.js')));
  assert.equal(typeof bridge.compressForTool, 'function', 'Bundled TOON bridge failed to import');
  // A clean install must also work as an MCP stdio server, not just load modules.
  const home = join(scratch, 'sandbox-home');
  const project = join(scratch, 'project');
  mkdirSync(join(home, '.zenith-mcp'), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(home, '.zenith-mcp/config'), ''); // Skip the interactive setup wizard.
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {},
      clientInfo: { name: 'zenith-package-smoke', version: '1.0' },
    } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ].map(value => JSON.stringify(value)).join('\n') + '\n';
  const server = spawnSync(process.execPath, [join(installed, 'dist/cli/stdio.js'), project], {
    cwd: scratch, env: { ...process.env, HOME: home },
    input, encoding: 'utf8', timeout: 12000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(server.status, 0, 'Installed MCP server failed to initialize:\n' +
    server.stderr + '\n' + server.stdout);
  const messages = server.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const initialized = messages.find(m => m.id === 1);
  const tools = messages.find(m => m.id === 2);
  assert.equal(initialized?.result?.serverInfo?.version, metadata.version, 'MCP version mismatch');
  assert(tools?.result?.tools?.some(t => t.name === 'read_file'), 'MCP tools/list missing read_file');
  console.log('PASS: installed MCP stdio initialized and exposed its native tools');
  console.log('PASS: clean npm install of ' + manifest.name + '@' +
    manifest.version + '; bundled TOON and compression bridge both import.');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

#!/usr/bin/env node
// Assemble one public zenith-mcp archive from the two internal workspace builds.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseRoot = join(root, '.release');
const stageDir = join(releaseRoot, 'zenith-mcp');
const mcpDir = join(root, 'packages/zenith-mcp');
const toonDir = join(root, 'packages/zenith-toon');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function visitJs(dir, onFile) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const pathname = join(dir, item.name);
    if (item.isDirectory()) visitJs(pathname, onFile);
    else if (item.isFile() && pathname.endsWith('.js')) onFile(pathname);
  }
}

const sourceManifest = JSON.parse(readFileSync(join(mcpDir, 'package.json'), 'utf8'));
const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
assert(rootManifest.version === sourceManifest.version,
  'Root and zenith-mcp versions differ; both must be updated before publishing');
assert(sourceManifest.name === 'zenith-mcp', 'Only zenith-mcp may be published');
assert(sourceManifest.dependencies?.['zenith-toon'] === 'workspace:*',
  'Expected the internal TOON workspace dependency');
for (const file of ['dist/cli/stdio.js', 'dist/core/compression.js']) {
  assert(existsSync(join(mcpDir, file)), 'Missing compiled Zenith file: ' + file);
}
for (const file of ['dist/index.js', 'dist/compress-source.js']) {
  assert(existsSync(join(toonDir, file)), 'Missing compiled TOON file: ' + file);
}

mkdirSync(releaseRoot, { recursive: true });
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });
cpSync(join(mcpDir, 'dist'), join(stageDir, 'dist'), { recursive: true });
cpSync(join(toonDir, 'dist'), join(stageDir, 'dist/toon'), { recursive: true });

const compressorPath = join(stageDir, 'dist/core/compression.js');
const compressor = readFileSync(compressorPath, 'utf8');
const bareImport = /\bfrom\s+(['"])zenith-toon\1/g;
const occurrences = [...compressor.matchAll(bareImport)];
assert(occurrences.length === 1,
  'Expected one TOON import in compression.js; found ' + occurrences.length);
writeFileSync(compressorPath, compressor.replace(bareImport, "from '../toon/index.js'"), 'utf8');

// Never quietly publish another unresolved workspace import.
visitJs(join(stageDir, 'dist'), (file) => {
  const code = readFileSync(file, 'utf8');
  assert(!/(?:from\s*|import\(\s*|require\(\s*)['"]zenith-toon(?:['"]|\/)/.test(code),
    'Unbundled TOON import in ' + file);
});
const manifest = structuredClone(sourceManifest);
delete manifest.dependencies['zenith-toon'];
delete manifest.devDependencies;
delete manifest.scripts; // Local build scripts must not execute on customer machines.
manifest.files = ['dist'];
writeFileSync(join(stageDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
for (const file of ['README.md', 'LICENSE']) {
  const source = join(root, file);
  if (existsSync(source) && statSync(source).isFile()) {
    copyFileSync(source, join(stageDir, file));
  }
}
const tarball = join(releaseRoot, 'zenith-mcp-' + manifest.version + '.tgz');
rmSync(tarball, { force: true });
const packed = spawnSync('npm', [
  'pack', stageDir, '--pack-destination', releaseRoot, '--ignore-scripts', '--json',
], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
if (packed.status !== 0) {
  throw new Error('npm pack failed:\n' + (packed.stderr || packed.stdout));
}
const packOutput = JSON.parse(packed.stdout);
const packInfo = Array.isArray(packOutput) ? packOutput[0] : packOutput[sourceManifest.name];
assert(packInfo.name === 'zenith-mcp' && packInfo.version === manifest.version,
  'Unexpected packed package identity');
for (const file of ['dist/toon/index.js', 'dist/core/compression.js', 'dist/cli/stdio.js']) {
  assert(packInfo.files.some(f => f.path === file), 'Missing from archive: ' + file);
}
const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex');
writeFileSync(join(releaseRoot, 'manifest.json'),
  JSON.stringify({ name: manifest.name, version: manifest.version, tarball, sha256, integrity: packInfo.integrity }, null, 2) + '\n');
console.log('Packed ' + manifest.name + '@' + manifest.version + ' as ONE npm package.');
console.log('Included TOON without an external dependency (' + packInfo.files.length + ' files).');
console.log('Artifact: ' + tarball);

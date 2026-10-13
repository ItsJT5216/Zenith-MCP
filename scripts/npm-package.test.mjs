import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stage = join(root, '.release/zenith-mcp');
const manifest = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8'));
const source = JSON.parse(readFileSync(join(root, 'packages/zenith-mcp/package.json'), 'utf8'));
const built = readFileSync(join(root, 'packages/zenith-mcp/dist/core/compression.js'), 'utf8');
const staged = readFileSync(join(stage, 'dist/core/compression.js'), 'utf8');
const archive = JSON.parse(readFileSync(join(root, '.release/manifest.json'), 'utf8'));

test('npm package contains only one public package name', () => {
  assert.equal(manifest.name, 'zenith-mcp');
  assert.equal(archive.name, 'zenith-mcp');
  assert.equal(manifest.version, source.version);
  assert.equal(manifest.dependencies['zenith-toon'], undefined);
  assert.equal(source.dependencies['zenith-toon'], 'workspace:*');
});

test('TOON is vendored only in staged output, not mutated in local build', () => {
  assert.match(built, /from ['"]zenith-toon['"]/);
  assert.match(staged, /from ['"]\.\.\/toon\/index\.js['"]/);
  assert.doesNotMatch(staged, /from ['"]zenith-toon['"]/);
  assert.match(readFileSync(join(stage, 'dist/toon/index.js'), 'utf8'), /compressFile/);
});

test('npm archive never exposes workspace paths or secrets', () => {
  const result = spawnSync('npm', ['pack', stage, '--dry-run', '--json', '--ignore-scripts'],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  const files = (Array.isArray(parsed) ? parsed[0] : parsed['zenith-mcp']).files;
  assert(files.some(file => file.path === 'dist/toon/index.js'));
  assert(files.some(file => file.path === 'dist/cli/stdio.js'));
  assert(files.every(file => file.path === 'package.json' || file.path === 'README.md' ||
    file.path === 'LICENSE' || file.path.startsWith('dist/')));
  assert(!files.some(file => /(?:^|\/)(?:\.env|\.npmrc|src|node_modules)(?:\/|$)/.test(file.path)));
});

test('the single npm tarball contains no leaked separate TOON package', () => {
  assert(!readdirSync(join(stage, 'dist')).includes('node_modules'));
  assert.equal(manifest.scripts, undefined);
  assert.equal(manifest.devDependencies, undefined);
});

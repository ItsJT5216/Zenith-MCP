#!/usr/bin/env node
// Only publish a checksum-locked archive that passed release:verify.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const tagIndex = args.indexOf('--tag');
const tag = tagIndex >= 0 ? args[tagIndex + 1] : 'latest';
assert(['latest', 'next'].includes(tag), 'Allowed release tags: latest, next');
assert(args.every((arg, i) => ['--dry-run', '--tag'].includes(arg) || (i === tagIndex + 1 && arg === tag)),
  'Unexpected publish arguments');
const metadata = JSON.parse(readFileSync(join(root, '.release/manifest.json'), 'utf8'));
assert.equal(metadata.name, 'zenith-mcp');
assert.equal(metadata.tarball, join(root, '.release', 'zenith-mcp-' + metadata.version + '.tgz'));
assert.equal(createHash('sha256').update(readFileSync(metadata.tarball)).digest('hex'),
  metadata.sha256, 'Archive checksum changed since staging');

assert.equal('sha512-' + createHash('sha512').update(readFileSync(metadata.tarball)).digest('base64'),
  metadata.integrity, 'Archive SRI changed since staging');
let alreadyPublished = false;
if (!dryRun) {
  const existing = spawnSync('npm', [
    'view', 'zenith-mcp@' + metadata.version, 'dist.integrity', '--json',
  ], { encoding: 'utf8' });
  if (existing.status === 0) {
    const value = JSON.parse(existing.stdout);
    const remoteIntegrity = Array.isArray(value) ? value[0] : value;
    assert.equal(remoteIntegrity, metadata.integrity,
      'Registry already contains this version with DIFFERENT package contents; do not re-tag');
    alreadyPublished = true;
  } else {
    assert(/E404|404 Not Found/.test(existing.stderr),
      'Unable to verify whether version is available: ' + existing.stderr);
  }
}
if (alreadyPublished) {
  console.log('Archive already on npm; moving the ' + tag + ' dist-tag to verified version ' + metadata.version);
  const retag = spawnSync('npm', ['dist-tag', 'add', 'zenith-mcp@' + metadata.version, tag, '--loglevel=error'],
    { cwd: root, encoding: 'utf8' });
  process.stdout.write(retag.stdout);
  process.stderr.write(retag.stderr);
  if (retag.status !== 0) process.exit(retag.status ?? 1);
  process.exit(0);
}
console.log('Publishing ' + metadata.name + '@' + metadata.version +
  ' with tag ' + tag + (dryRun ? ' (dry run)' : ''));
const publish = spawnSync('npm', [
  'publish', metadata.tarball, '--access', 'public', '--tag', tag, '--loglevel=error',
  ...(dryRun ? ['--dry-run'] : []),
], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
process.stdout.write(publish.stdout);
process.stderr.write(publish.stderr);
if (publish.status !== 0) process.exit(publish.status ?? 1);

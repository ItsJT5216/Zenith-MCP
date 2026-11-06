import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './cwd-context-test-support.mjs';
// getCallerCwds() defaults to a 0 ms TTL only on Linux (/proc walk); macOS keeps
// the 5 s cache and Windows returns its own cwd only, so the refresh check below
// is Linux-specific by construction (same gate as bash.test.js).
const linuxOnly = it.skipIf(process.platform !== 'linux');
let h;
beforeEach(async () => { h = await setup(); });
afterEach(() => h.cleanup());

describe('continued discovery on one real ProjectContext (unit observation injection)', () => {
  it('follows A B A C B A without cache clears or state serialization', () => {
    const { pc } = h.context();
    for (const key of ['A', 'B', 'A', 'C', 'B', 'A']) {
      h.move(path.join(h.roots[key], 'work'));
      pc.pingCallerEnvironment();
      expect(pc.getRoot()).toBe(h.roots[key]);
    }
  });
  it('nearest agreeing candidate wins instead of falling through to server cwd', () => {
    const { pc } = h.context();
    for (let i = 0; i < 12; i++) {
      pc.pingCallerEnvironment();
      expect(pc.getRoot()).toBe(h.roots.A);
    }
  });
  it('a registered ambient project remains refreshable', () => {
    const { pc } = h.context();
    pc.reloadRegistry(Object.entries(h.roots).map(([key, root]) => ({ project_id: key, project_name: key, project_root: root })));
    for (const key of ['A', 'B', 'A']) {
      h.move(h.roots[key]); pc.pingCallerEnvironment();
      expect(pc.getRoot()).toBe(h.roots[key]);
      expect(pc.bindingTier).toBe('registry');
      expect(pc.bindingOrigin).toBe('environment');
    }
  });
  it('incidental path access does not turn off the next ambient detection', () => {
    const { pc } = h.context(); pc.pingCallerEnvironment();
    pc.getRoot(path.join(h.roots.B, 'same.txt'));
    pc.pingCallerEnvironment(); expect(pc.getRoot()).toBe(h.roots.A);
    h.move(h.roots.C); pc.pingCallerEnvironment(); expect(pc.getRoot()).toBe(h.roots.C);
  });
  it('sees a newly created marker despite a prior cached miss', () => {
    const root = path.join(h.base, 'plain'); fs.mkdirSync(root);
    const { pc } = h.context();
    pc.getRoot(path.join(root, 'new.txt')); // may cache absence
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    h.move(root); pc.pingCallerEnvironment(); expect(pc.getRoot()).toBe(root);
  });
  it('redetects the boundary when a git marker is removed', () => {
    const outer = path.join(h.base, 'outer'), inner = path.join(outer, 'inner');
    fs.mkdirSync(path.join(inner, '.git'), { recursive: true });
    fs.writeFileSync(path.join(outer, 'package.json'), '{}');
    const { pc } = h.context(); h.move(inner); pc.pingCallerEnvironment(); expect(pc.getRoot()).toBe(inner);
    fs.rmdirSync(path.join(inner, '.git'));
    pc.pingCallerEnvironment(); expect(pc.getRoot()).toBe(outer);
  });
  linuxOnly('Linux default candidate refresh does not return a stale cached array', () => {
    const first = h.pt.getCallerCwds(); h.move(h.roots.B);
    const second = h.pt.getCallerCwds();
    expect(second[0].cwd).toBe(h.roots.B); expect(second).not.toBe(first);
  });
  it('retains the explicitly requested TTL API for other callers', () => {
    const first = h.pt.getCallerCwds(60_000); h.move(h.roots.B);
    expect(h.pt.getCallerCwds(60_000)).toBe(first);
  });
  it('does not export the worker state-rehydration test seam', () => {
    const { pc } = h.context();
    expect(pc._dumpState).toBeUndefined(); expect(pc._bindState).toBeUndefined();
  });
});

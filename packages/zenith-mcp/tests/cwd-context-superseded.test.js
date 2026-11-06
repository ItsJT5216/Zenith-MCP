import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './cwd-context-test-support.mjs';
let h;
beforeEach(async () => { h = await setup(); });
afterEach(() => h.cleanup());

// Replaces the worker's cross-process serialized-state tests. No original
// repository assertion is removed: deliberate registry grants remain protected.
describe('call-local routing without persistence or observation-session changes', () => {
  it('relative paths use the selected root, not a nested process launch directory', async () => {
    const { ctx, pc } = h.context(); pc.pingCallerEnvironment();
    await pc.runForCall(async () => {
      expect(await ctx.validatePath('same.txt')).toBe(path.join(h.roots.A, 'same.txt'));
      expect(await ctx.validateNewFilePath('new/deep/file.txt')).toBe(path.join(h.roots.A, 'new/deep/file.txt'));
    });
  });
  it('absolute operations cannot change the call-local relative base', async () => {
    const { ctx, pc } = h.context(); pc.pingCallerEnvironment();
    await pc.runForCall(async () => {
      h.pcMod.getProjectContext(ctx).getRoot(path.join(h.roots.B, 'same.txt'));
      expect(await ctx.validatePath('same.txt')).toBe(path.join(h.roots.A, 'same.txt'));
      expect(await ctx.validatePath(path.join(h.roots.B, 'same.txt'))).toBe(path.join(h.roots.B, 'same.txt'));
    });
    expect(pc.getRoot()).toBe(h.roots.A);
  });
  it('overlapping calls retain their own root and relative-path base across awaits', async () => {
    const { ctx, pc } = h.context(); pc.pingCallerEnvironment();
    let release; const gate = new Promise(resolve => { release = resolve; });
    const first = pc.runForCall(async () => {
      await gate;
      expect(h.pcMod.getProjectContext(ctx).getRoot()).toBe(h.roots.A);
      return ctx.validatePath('same.txt');
    });
    h.move(h.roots.B); pc.pingCallerEnvironment();
    const second = pc.runForCall(async () => {
      expect(h.pcMod.getProjectContext(ctx).getRoot()).toBe(h.roots.B);
      return ctx.validatePath('same.txt');
    });
    release();
    expect(await first).toBe(path.join(h.roots.A, 'same.txt'));
    expect(await second).toBe(path.join(h.roots.B, 'same.txt'));
  });
  it('preserves frozen sandbox enforcement for call-local paths', async () => {
    const { ctx, pc } = h.context([h.roots.A]); ctx.setSandboxEnabled(true); pc.pingCallerEnvironment();
    await pc.runForCall(async () => {
      expect(await ctx.validatePath('same.txt')).toBe(path.join(h.roots.A, 'same.txt'));
      await expect(ctx.validatePath(path.join(h.roots.B, 'same.txt'))).rejects.toThrow('Access denied');
      await expect(ctx.validateNewFilePath(path.join(h.roots.B, 'new.txt'))).rejects.toThrow('Access denied');
    });
  });
  it('does not leak invocation state after rejection', async () => {
    const { ctx, pc } = h.context(); pc.pingCallerEnvironment();
    await expect(pc.runForCall(async () => { throw new Error('sentinel'); })).rejects.toThrow('sentinel');
    expect(h.pcMod.getCallWorkingDirectory(ctx)).toBeUndefined();
    expect(h.pcMod.getProjectContext(ctx)).toBe(pc);
  });
  it('symlink validation still canonicalizes absolute and relative targets', async () => {
    const { ctx, pc } = h.context(); fs.symlinkSync(h.roots.B, path.join(h.roots.A, 'linked'));
    pc.pingCallerEnvironment();
    await pc.runForCall(async () => {
      expect(await ctx.validatePath('linked/same.txt')).toBe(path.join(h.roots.B, 'same.txt'));
      expect(await ctx.validateNewFilePath('linked/new.txt')).toBe(path.join(h.roots.B, 'new.txt'));
    });
  });
});

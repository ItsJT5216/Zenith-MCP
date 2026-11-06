import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './cwd-context-test-support.mjs';
let h;
beforeEach(async () => { h = await setup(); });
afterEach(() => h.cleanup());

describe('index consumers share invocation project and persistence consent', () => {
  it('a registered marker-only project supplies its root to legacy index consumers', async () => {
    fs.rmdirSync(path.join(h.roots.C, '.git'));
    fs.writeFileSync(path.join(h.roots.C, 'package.json'), '{}');
    const { pc } = h.context();
    pc.reloadRegistry([{ project_id: 'C', project_name: 'C', project_root: h.roots.C }]);
    h.move(h.roots.C); pc.pingCallerEnvironment();
    const { findRepoRoot } = await import('../dist/core/symbol-index.js');
    pc.runForCall(() => expect(findRepoRoot(path.join(h.roots.C, 'same.txt'))).toBe(h.roots.C));
  });
  it('does not confuse the neutral storage directory with an unregistered source root', async () => {
    const { pc } = h.context(); pc.pingCallerEnvironment();
    const { findRepoRoot } = await import('../dist/core/symbol-index.js');
    pc.runForCall(() => {
      expect(h.pcMod.getCallPersistenceRoot(path.join(h.roots.A, 'same.txt'))).toBeUndefined();
      expect(findRepoRoot(path.join(h.roots.A, 'same.txt'))).toBe(h.roots.A);
    });
  });
  it('operation-specific index routing does not alter the captured active cwd', async () => {
    const { pc, ctx } = h.context();
    pc.reloadRegistry([{ project_id: 'B', project_name: 'B', project_root: h.roots.B }]);
    pc.pingCallerEnvironment();
    const { findRepoRoot } = await import('../dist/core/symbol-index.js');
    await pc.runForCall(async () => {
      expect(findRepoRoot(path.join(h.roots.B, 'same.txt'))).toBe(h.roots.B);
      expect(await ctx.validatePath('same.txt')).toBe(path.join(h.roots.A, 'same.txt'));
    });
    expect(pc.getRoot()).toBe(h.roots.A);
  });
});

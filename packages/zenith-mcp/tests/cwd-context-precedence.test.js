import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './cwd-context-test-support.mjs';
let h;
beforeEach(async () => { h = await setup(); });
afterEach(() => h.cleanup());

describe('deliberate selections and persistence consent', () => {
  it('preserves explicit initProject across ambient and absolute-path evidence', () => {
    const { pc } = h.context(); pc.initProject(h.roots.C); h.move(h.roots.B);
    pc.pingCallerEnvironment(); pc.getRoot(path.join(h.roots.A, 'same.txt'));
    expect(pc.getRoot()).toBe(h.roots.C); expect(pc.bindingTier).toBe('explicit');
  });
  it('preserves a detected granted directory, not only a registered grant', () => {
    const { pc } = h.context([h.roots.C]);
    for (const key of ['A', 'B', 'A']) {
      h.move(h.roots[key]); pc.pingCallerEnvironment(); expect(pc.getRoot()).toBe(h.roots.C);
    }
  });
  it('preserves registered granted directories after path evidence', () => {
    const { pc } = h.context([h.roots.C]);
    pc.reloadRegistry([{ project_id: 'C', project_name: 'C', project_root: h.roots.C }]);
    pc.getRoot(path.join(h.roots.C, 'same.txt'));
    pc.pingCallerEnvironment(); expect(pc.getRoot()).toBe(h.roots.C);
  });
  it('follows a changed granted root without accepting stale prior grant', () => {
    const { ctx, pc } = h.context([h.roots.A]); pc.pingCallerEnvironment();
    ctx.setAllowedDirectories([h.roots.B]); pc.pingCallerEnvironment(); expect(pc.getRoot()).toBe(h.roots.B);
  });
  it('a missing grant does not mask available ambient evidence', () => {
    const { pc } = h.context([path.join(h.base, 'missing')]); pc.pingCallerEnvironment(); expect(pc.getRoot()).toBe(h.roots.A);
  });
  it('detection does not consent to project-local persistence', () => {
    const { pc } = h.context(); pc.pingCallerEnvironment();
    expect(pc.getStashDb().isGlobal).toBe(true);
    expect(fs.existsSync(path.join(h.roots.A, '.mcp'))).toBe(false);
  });
  it('repeated pings do not repeat observed-root notifications', () => {
    const { pc } = h.context(); const messages = []; pc.setNotifyFn(m => messages.push(m));
    for (let i = 0; i < 8; i++) pc.pingCallerEnvironment();
    expect(messages.filter(m => m.includes('Detected')).length).toBe(1);
  });
  it('opportunistic promotion is retained but does not freeze discovery', () => {
    const old = process.env.ZENITH_AUTO_PROMOTE_SESSIONS;
    process.env.ZENITH_AUTO_PROMOTE_SESSIONS = '1';
    try {
      const { pc } = h.context();
      for (const key of ['A', 'B', 'A', 'A']) {
        h.move(h.roots[key]); pc.pingCallerEnvironment();
        expect(pc.getRoot()).toBe(h.roots[key]); expect(pc.bindingTier).toBe('registry');
      }
    } finally { if (old === undefined) delete process.env.ZENITH_AUTO_PROMOTE_SESSIONS; else process.env.ZENITH_AUTO_PROMOTE_SESSIONS = old; }
  });
});

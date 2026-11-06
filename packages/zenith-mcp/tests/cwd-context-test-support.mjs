import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';

// Unit tests inject only the process-directory observation. Boundary discovery,
// path validation, registry/DB policy, and the long-lived context remain real.
// Real-kernel end-to-end evidence is provided by the transport suites separately.
export async function setup() {
  vi.resetModules();
  const base = fs.mkdtempSync(path.join(os.homedir(), '.cwd-unit-'));
  const roots = {};
  for (const key of ['A', 'B', 'C']) {
    roots[key] = path.join(base, key);
    fs.mkdirSync(path.join(roots[key], '.git'), { recursive: true });
    fs.mkdirSync(path.join(roots[key], 'work'));
    fs.writeFileSync(path.join(roots[key], 'same.txt'), key);
  }
  let current = roots.A;
  const originalReadlink = fs.readlinkSync.bind(fs);
  const spy = vi.spyOn(fs, 'readlinkSync').mockImplementation((p, ...args) => {
    if (/^\/proc\/\d+\/cwd$/.test(String(p))) return current;
    return originalReadlink(p, ...args);
  });
  const pcMod = await import('../dist/core/project-context.js');
  const lib = await import('../dist/core/lib.js');
  const pt = await import('../dist/core/detection/process-tree.js');
  return {
    base, roots, pcMod, lib, pt,
    move: (p) => { current = p; },
    context: (allowed = []) => {
      const ctx = lib.createFilesystemContext(allowed);
      return { ctx, pc: pcMod.getProjectContext(ctx) };
    },
    cleanup: () => { spy.mockRestore(); fs.rmSync(base, { recursive: true, force: true }); },
  };
}

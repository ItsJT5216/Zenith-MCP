// ============================================================================
// Transition driver: walks the launcher (server parent) through the required
// project sequence A -> B -> A -> C -> B -> A on ONE long-running server,
// capturing first detection, stable repeats, immediate (<5s TTL) transitions,
// post-TTL transitions, and returns — separately labeled, never hidden by a
// blanket wait.
//
// The driver yields "steps"; each step chdirs the launcher to the project and
// labels the transition kind. The per-tool suites decide what to invoke at
// each step. expectedActiveRoot is computed independently from the launcher
// cwd we just set (its realpath boundary), never from the server.
// ============================================================================
import { expectedBoundary, realpathSafe, sleep } from './lib.mjs';

export const TTL_MS = 5000;

// The required transition sequence with its phases. Each entry:
//   { proj: 'A'|'B'|'C', kind, waitBeforeMs }
// kind: first | stable | immediate | post-ttl | return
export function transitionPlan() {
  return [
    { proj: 'A', kind: 'first',     waitBeforeMs: 0 },
    { proj: 'A', kind: 'stable',    waitBeforeMs: 0 },
    { proj: 'B', kind: 'immediate', waitBeforeMs: 0 },        // within TTL of A#stable
    { proj: 'B', kind: 'stable',    waitBeforeMs: 0 },
    { proj: 'A', kind: 'return',    waitBeforeMs: 0 },        // immediate return to A
    { proj: 'A', kind: 'stable',    waitBeforeMs: TTL_MS + 600 }, // post-TTL, still A
    { proj: 'C', kind: 'immediate', waitBeforeMs: 0 },
    { proj: 'C', kind: 'post-ttl',  waitBeforeMs: TTL_MS + 600 }, // wait, still C
    { proj: 'B', kind: 'return',    waitBeforeMs: 0 },        // return to B
    { proj: 'A', kind: 'return',    waitBeforeMs: 0 },        // final return to A
  ];
}

// Drive the plan, invoking `onStep(stepCtx)` per step.
// stepCtx: { proj, kind, index, dir, realDir, expectedActiveRoot, launcherCwd }
export async function driveTransitions(F, onStep) {
  const plan = transitionPlan();
  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    if (step.waitBeforeMs > 0) await sleep(step.waitBeforeMs);
    const dir = F[step.proj];
    process.chdir(dir); // mutate the LAUNCHER (parent) cwd — the server's cwd evidence
    const realDir = realpathSafe(dir);
    const ctx = {
      proj: step.proj,
      kind: step.kind,
      index: i,
      phase: `${step.proj}#${i}-${step.kind}`,
      dir,
      realDir,
      expectedActiveRoot: expectedBoundary(dir),
      launcherCwd: process.cwd(),
    };
    await onStep(ctx);
  }
}

import { defineConfig } from 'vitest/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Constraint-enforcement suite for zenith-toon.
//
// Tests import the package source directly (NodeNext `.js` specifiers resolve to
// the `.ts` sources under Vitest), so the suite gates the real implementation
// without requiring a prior `tsc` build. The static-source guards additionally
// read sibling-package files (zenith-mcp) straight off disk.
//
// The removal engine isn't built yet (the one intentional red). While src/removal.ts
// is absent, alias bmx-plus's `./removal.js` import to a test-only passthrough stub
// so the suite can EXERCISE engines that statically import it — e.g. the BMX+ knee,
// which writes metadata.bmx BEFORE the removal handoff. The alias self-disables the
// moment removal.ts exists, so it can never shadow the real engine; tsc ignores this
// file, so `tsc --build` stays red on ./removal.js exactly as designed.
const removalBuilt = fs.existsSync(path.resolve(__dirname, 'src/removal.ts'));
const removalAlias = removalBuilt
  ? {}
  : { './removal.js': path.resolve(__dirname, 'tests/_stubs/removal-stub.ts') };

export default defineConfig({
  resolve: { alias: removalAlias },
  test: {
    include: ['tests/constraints/**/*.test.ts'],
    environment: 'node',
    // The constraint suite is deterministic and self-contained; fail fast on the
    // first Priority-0 violation so CI output points straight at the drift.
    bail: 1,
    passWithNoTests: false,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'cobertura'],
      reportsDirectory: './coverage',
      reportOnFailure: true,
    },
  },
});

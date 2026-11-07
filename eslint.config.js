// ESLint flat config — run with `pnpm lint` (also enforced by CI).
//
// Deliberately small and high-signal:
//   * ESLint's own recommended rules (real bugs: undefined names, duplicate
//     keys, unreachable code, …) for every file
//   * typescript-eslint's recommended rules for the TypeScript sources
//   * the two rules the repo already states in AGENTS.md and enforces by hand:
//       - no non-null assertions (Rule 6)
//       - no `any`
//   * unused variables in test files are warnings, not errors, so the first run
//     does not fail on test scaffolding; tighten to "error" once the backlog is clear
//
// The CI workflow runs `pnpm exec eslint .` only when this file exists.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/grammars/**',
      '**/_legacy_old_arch/**',
      '**/.turbo/**',
    ],
  },

  // Plain JavaScript (vitest tests, node:test files, scripts): ESLint recommended + Node globals.
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  // TypeScript sources: typescript-eslint recommended, scoped to .ts files only.
  ...tseslint.configs.recommended.map((cfg) => ({ ...cfg, files: ['**/*.ts', '**/*.mts', '**/*.cts'] })),
  {
    files: ['packages/*/src/**/*.ts'],
    rules: {
      // AGENTS.md Rule 6: non-null assertions hide real nullability.
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },

  // Test code: unused bindings are a warning for now (tsc does not check the JS tests).
  {
    files: ['packages/*/tests/**/*.{js,mjs,cjs}', 'scripts/**/*.{js,mjs,cjs}'],
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['packages/*/tests/**/*.{ts,mts,cts}', 'scripts/**/*.{ts,mts,cts}'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);

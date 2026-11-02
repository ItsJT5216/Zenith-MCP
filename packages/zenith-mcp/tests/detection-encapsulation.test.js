import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Drift guard: core/detection/* is PRIVATE to ProjectContext.
//
// History lesson (2026): this codebase once grew three competing project
// resolvers because detection utilities were importable from anywhere.
// This test makes the sole-consumer rule mechanical instead of hopeful:
// if any module other than core/project-context.ts imports from
// core/detection/, the suite fails and names the offender.
// ---------------------------------------------------------------------------

const SRC_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'src'
);

const ALLOWED_IMPORTERS = new Set([
    path.join(SRC_ROOT, 'core', 'project-context.ts'),
]);

function walkSourceFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walkSourceFiles(full, out);
        } else if (entry.isFile() && /\.(ts|js|mts|mjs)$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

describe('detection module encapsulation', () => {
    it('only core/project-context.ts imports from core/detection/', () => {
        const offenders = [];
        for (const file of walkSourceFiles(SRC_ROOT)) {
            if (file.includes(`${path.sep}core${path.sep}detection${path.sep}`)) continue;
            if (ALLOWED_IMPORTERS.has(file)) continue;
            const content = fs.readFileSync(file, 'utf-8');
            if (/from\s+['"][^'"]*\/detection\/[^'"]*['"]/.test(content) ||
                /require\(\s*['"][^'"]*\/detection\/[^'"]*['"]\s*\)/.test(content)) {
                offenders.push(path.relative(SRC_ROOT, file));
            }
        }
        expect(offenders, `detection helpers imported outside ProjectContext by: ${offenders.join(', ')} — all binding decisions belong to ProjectContext`).toEqual([]);
    });

    it('the allowed importer actually exists (guard stays honest)', () => {
        for (const allowed of ALLOWED_IMPORTERS) {
            expect(fs.existsSync(allowed)).toBe(true);
        }
    });
});

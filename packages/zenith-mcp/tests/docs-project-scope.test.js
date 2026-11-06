import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Doc-consistency guard: the project-scope resolution ladders in
// docs/ARCHITECTURE.md §5.8 and docs/Developers-Guide.md §6 must describe the
// order core/project-context.ts actually implements (explicit > registry >
// detected > global), must not claim MCP Roots take part, and must keep the
// persistence rule straight (detected roots select scope but never host a
// project-local .mcp/symbols.db). Review findings C11-main, C21-a6, C21-a7.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PKG_SRC = path.join(REPO_ROOT, 'packages', 'zenith-mcp', 'src');

function read(rel) {
    return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}

/** Text between a heading line and the next heading of the same level. */
function section(doc, heading, nextHeadingPrefix) {
    const start = doc.indexOf(heading);
    expect(start, `heading "${heading}" present`).toBeGreaterThanOrEqual(0);
    const rest = doc.slice(start + heading.length);
    const end = rest.indexOf(`\n${nextHeadingPrefix}`);
    return end === -1 ? rest : rest.slice(0, end);
}

function numberedItems(text) {
    return text.split('\n')
        .map(line => /^(\d+)\.\s+(.*)$/.exec(line))
        .filter(Boolean)
        .map(m => m[2]);
}

function tierOf(item) {
    if (/^Explicit binding/.test(item)) return 'explicit';
    if (/^(Config-file|Explicit project) registry/.test(item)) return 'registry';
    if (/^Detected boundary/.test(item)) return 'detected';
    if (/^Global fallback/.test(item)) return 'global';
    return `unknown:${item}`;
}

describe('project-scope docs match core/project-context.ts', () => {
    const arch = read('docs/ARCHITECTURE.md');
    const guide = read('docs/Developers-Guide.md');
    const archSection = section(arch, '### 5.8 `core/project-context.ts`', '### ');
    const guideSection = section(guide, '## 6. Project Root Resolution', '## ');

    it('the source defines exactly the four tiers the docs describe', () => {
        const src = fs.readFileSync(path.join(PKG_SRC, 'core', 'project-context.ts'), 'utf-8');
        expect(src).toContain("type BindingTier = 'explicit' | 'registry' | 'detected' | 'global';");
        // The persistence gate the docs describe — only explicit/registry may host a project DB.
        expect(src).toContain("if (root && (this._tier === 'explicit' || this._tier === 'registry'))");
    });

    it('ARCHITECTURE §5.8 lists the tiers in implementation order and names the detected tier', () => {
        expect(archSection).not.toContain('there is no automatic git or marker detection');
        expect(numberedItems(archSection).map(tierOf)).toEqual(['explicit', 'registry', 'detected', 'global']);
    });

    it('ARCHITECTURE §5.8 separates scope selection from persistence eligibility', () => {
        expect(archSection).toContain('Detected roots select scope only');
        expect(archSection).toMatch(/only explicit and registry bindings can host a project-local `\.mcp\/symbols\.db`/);
    });

    it('Developers-Guide §6 uses the same order and no longer lists MCP roots as a source', () => {
        expect(guideSection).not.toMatch(/MCP roots \/ allowed directories/);
        expect(numberedItems(guideSection).map(tierOf)).toEqual(['explicit', 'registry', 'detected', 'global']);
        expect(guideSection).toContain('MCP Roots are not consulted');
    });

    it('README summarises the same order (registry outranks detection)', () => {
        const readme = read('README.md');
        expect(readme).not.toContain('git → marker detection → registry → global');
        expect(readme).toContain('project registry → git/marker detection → global');
    });

    it('refresh() really has no production caller, as both docs now state', () => {
        const offenders = [];
        const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.isFile() && /\.ts$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
                    if (full.endsWith(path.join('core', 'project-context.ts'))) continue;
                    if (/\.refresh\(\)/.test(fs.readFileSync(full, 'utf-8'))) offenders.push(path.relative(PKG_SRC, full));
                }
            }
        };
        walk(PKG_SRC);
        expect(offenders, 'if refresh() gains a caller, update ARCHITECTURE §5.8 and Developers-Guide §6').toEqual([]);
        expect(archSection).toContain('`refresh()` has no production caller');
        expect(guideSection).toContain('`refresh()` has no production caller');
    });
});

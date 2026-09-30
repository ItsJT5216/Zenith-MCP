import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { applyEditList } from '../dist/core/edit-engine.js';

const jsSource = `function alpha(x) {
    return x + 1;
}

function beta(y) {
    return y * 2;
}

function gamma(z) {
    return z - 3;
}
`;

// Symbol-mode edits go through the DB-backed symbol-index path now;
// every symbol-mode test needs a real file under a `findRepoRoot`-able
// directory (i.e. with `.git/` above it). See edit-engine-core.test.js
// for the equivalent fixture and rationale.
let testDir;
let testFilePath;

beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-engine-snapshots-'));
    fs.mkdirSync(path.join(testDir, '.git'));
    testFilePath = path.join(testDir, 'test.js');
    fs.writeFileSync(testFilePath, jsSource);
});

afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
});

describe('applyEditList pendingSnapshots', () => {
    it('always returns pendingSnapshots as an array (never undefined) — no edits', async () => {
        const result = await applyEditList(jsSource, [], { filePath: testFilePath, isBatch: false });
        expect(Array.isArray(result.pendingSnapshots)).toBe(true);
        expect(result.pendingSnapshots).toHaveLength(0);
        expect(result.workingContent).toBe(jsSource);
        expect(result.errors).toHaveLength(0);
    });

    it('one successful symbol-mode edit yields exactly one snapshot entry', async () => {
        const edits = [{
            mode: 'symbol',
            symbol: 'alpha',
            newText: 'function alpha(x) {\n    return x + 100;\n}',
        }];
        const result = await applyEditList(jsSource, edits, { filePath: testFilePath, isBatch: false });

        expect(result.errors).toHaveLength(0);
        expect(result.pendingSnapshots).toHaveLength(1);

        const snap = result.pendingSnapshots[0];
        expect(snap.symbol).toBe('alpha');
        expect(snap.filePath).toBe(testFilePath);
        expect(typeof snap.line).toBe('number');
        // originalText should be the exact alpha source before edit
        expect(snap.originalText).toBe('function alpha(x) {\n    return x + 1;\n}');
    });

    // Multi-symbol batch where the FIRST edit changes line counts: the
    // DB-backed `loadSymbolInFile` returns DISK-frame coordinates, and the
    // edit-engine's splice ledger (`lineShifts` + `mapDiskLine`) replays
    // prior in-batch shifts to map them into the in-flight `workingContent`
    // frame. This was originally skipped when the DB-backed symbol-index
    // path landed without that ledger (deferred in PR #20); the ledger
    // shipped in the PR #20 x PR #23 integration, so the regression test
    // is live again.
    it('originalText equals joined lines [sym.line, sym.endLine] of working content AT time of edit', async () => {
        // Two symbol edits — second's originalText must reflect post-first-edit state
        const edits = [
            {
                mode: 'symbol',
                symbol: 'alpha',
                newText: 'function alpha(x) {\n    // replaced\n    return x;\n}',
            },
            {
                mode: 'symbol',
                symbol: 'beta',
                newText: 'function beta(y) {\n    return y;\n}',
            },
        ];
        const result = await applyEditList(jsSource, edits, { filePath: testFilePath, isBatch: true });

        expect(result.errors).toHaveLength(0);
        expect(result.pendingSnapshots).toHaveLength(2);

        // Beta's original text was unchanged by alpha's edit since it's a separate symbol.
        expect(result.pendingSnapshots[1].originalText).toBe('function beta(y) {\n    return y * 2;\n}');

        // Verify the snapshot's originalText matches the joined lines [line, endLine] of the
        // working content AT THE MOMENT of the edit. We can reconstruct the state after the
        // first edit and check that beta's lines in that state match the snapshot.
        const afterFirst = jsSource.split('\n');
        // apply first edit manually: replace alpha block
        afterFirst.splice(0, 3, 'function alpha(x) {', '    // replaced', '    return x;', '}');
        const stateBeforeBeta = afterFirst.join('\n');
        const stateLines = stateBeforeBeta.split('\n');
        const betaSnap = result.pendingSnapshots[1];
        const reconstructed = stateLines.slice(betaSnap.line - 1, betaSnap.line - 1 + snapLineCount('function beta(y) {\n    return y * 2;\n}')).join('\n');
        expect(reconstructed).toBe(betaSnap.originalText);
    });

    it('block-mode edits produce zero snapshot entries', async () => {
        const edits = [{
            mode: 'block',
            block_start: 'function alpha(x) {',
            block_end: '}',
            replacement_block: 'function alpha(x) {\n    return x + 999;\n}',
        }];
        const result = await applyEditList(jsSource, edits, { filePath: testFilePath, isBatch: false });

        expect(result.errors).toHaveLength(0);
        expect(result.pendingSnapshots).toHaveLength(0);
    });

    it('content-mode edits produce zero snapshot entries', async () => {
        const edits = [{
            mode: 'content',
            oldContent: '    return x + 1;',
            newContent: '    return x + 1000;',
        }];
        const result = await applyEditList(jsSource, edits, { filePath: testFilePath, isBatch: false });

        expect(result.errors).toHaveLength(0);
        expect(result.pendingSnapshots).toHaveLength(0);
    });

    it('failed symbol-mode edits produce zero snapshot entries (symbol not found)', async () => {
        const edits = [{
            mode: 'symbol',
            symbol: 'nonexistent_symbol_xyz',
            newText: 'function nonexistent_symbol_xyz() {}',
        }];
        const result = await applyEditList(jsSource, edits, { filePath: testFilePath, isBatch: false });

        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.pendingSnapshots).toHaveLength(0);
    });

    it('failed symbol-mode edits produce zero snapshots (unsupported file type)', async () => {
        const edits = [{
            mode: 'symbol',
            symbol: 'foo',
            newText: 'foo',
        }];
        const result = await applyEditList(jsSource, edits, { filePath: '/tmp/test.unknownext', isBatch: false });

        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.pendingSnapshots).toHaveLength(0);
    });

    it('mixed batch: successful symbol + failed symbol + block + content — only successful symbol snapshots', async () => {
        const edits = [
            {
                mode: 'symbol',
                symbol: 'alpha',
                newText: 'function alpha(x) {\n    return 0;\n}',
            },
            {
                mode: 'symbol',
                symbol: 'doesNotExist',
                newText: 'irrelevant',
            },
            {
                mode: 'block',
                block_start: 'function beta(y) {',
                block_end: '}',
                replacement_block: 'function beta(y) {\n    return 42;\n}',
            },
            {
                mode: 'content',
                oldContent: '    return z - 3;',
                newContent: '    return z - 333;',
            },
        ];
        const result = await applyEditList(jsSource, edits, { filePath: testFilePath, isBatch: true });

        expect(result.errors.length).toBe(1); // only doesNotExist failed
        expect(result.pendingSnapshots).toHaveLength(1);
        expect(result.pendingSnapshots[0].symbol).toBe('alpha');
    });
});

function snapLineCount(s) {
    return s.split('\n').length;
}

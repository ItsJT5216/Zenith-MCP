import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const compressForToolMock = vi.fn();

vi.mock('../dist/core/compression.js', async () => {
    const actual = await vi.importActual('../dist/core/compression.js');
    return {
        ...actual,
        compressForTool: compressForToolMock,
    };
});

function createMockServer() {
    const tools = new Map();
    return {
        tools,
        registerTool(name, _config, handler) {
            tools.set(name, handler);
        },
    };
}

function createCtx(rootDir) {
    return {
        async validatePath(requestedPath) {
            const resolved = path.resolve(rootDir, requestedPath);
            if (!resolved.startsWith(rootDir)) {
                throw new Error('Access denied');
            }
            return resolved;
        },
    };
}

async function writeFixture(rootDir, relPath, content) {
    const fullPath = path.join(rootDir, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf8');
}

async function registerTool(modulePath, toolName, rootDir) {
    const server = createMockServer();
    const mod = await import(modulePath);
    mod.register(server, createCtx(rootDir));
    return server.tools.get(toolName);
}

describe('tool compression behavior', () => {
    let rootDir;

    beforeEach(async () => {
        rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zenith-mcp-tests-'));
        vi.clearAllMocks();
    });

    afterEach(async () => {
        if (rootDir) {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    it('keeps read_file uncompressed by default', async () => {
        const content = 'const value = 1;\n'.repeat(40);
        await writeFixture(rootDir, 'sample.js', content);

        const handler = await registerTool('../dist/tools/read_file.js', 'read_file', rootDir);
        const result = await handler({ path: 'sample.js' });

        // Tool formats output as "N. line" (1-based line number, dot, space, content)
        const firstLine = result.content[0].text.split('\n')[0];
        expect(firstLine).toBe('1. const value = 1;');
        expect(compressForToolMock).not.toHaveBeenCalled();
    });

    it('uses compression for read_file only when requested', async () => {
        const content = 'const value = 1;\n'.repeat(40);
        await writeFixture(rootDir, 'sample.js', content);
        // compressForTool returns string|null directly (not an object with .text)
        compressForToolMock.mockResolvedValue('COMPRESSED_OUTPUT');

        const handler = await registerTool('../dist/tools/read_file.js', 'read_file', rootDir);
        const result = await handler({ path: 'sample.js', compression: true });

        expect(result.content[0].text).toBe('COMPRESSED_OUTPUT');
        expect(compressForToolMock).toHaveBeenCalledOnce();
    });

    it('compresses read_multiple_files by default and allows opt-out', async () => {
        await writeFixture(rootDir, 'one.js', 'export const one = 1;\n'.repeat(50));
        await writeFixture(rootDir, 'two.js', 'export const two = 2;\n'.repeat(50));

        // compressForTool returns a string directly (not { text: ... })
        // Reads run concurrently; the mock must follow file identity, not the
        // nondeterministic order in which filesystem promises complete.
        compressForToolMock.mockImplementation(async (filePath) => {
            if (path.basename(filePath) === 'one.js') return 'ONE_COMPRESSED';
            if (path.basename(filePath) === 'two.js') return 'TWO_COMPRESSED';
            throw new Error(`Unexpected compression input: ${filePath}`);
        });

        const handler = await registerTool('../dist/tools/read_multiple_files.js', 'read_multiple_files', rootDir);
        const compressed = await handler({ paths: ['one.js', 'two.js'] });

        expect(compressed.content[0].text).toContain('- one.js\nONE_COMPRESSED');
        expect(compressed.content[0].text).toContain('- two.js\nTWO_COMPRESSED');
        expect(compressForToolMock).toHaveBeenCalledTimes(2);

        compressForToolMock.mockReset();

        const raw = await handler({ paths: ['one.js', 'two.js'], compression: false });

        // Without compression the tool emits "N. line" formatted lines
        const rawText = raw.content[0].text;
        expect(rawText).toContain('- one.js\n1. export const one = 1;');
        expect(rawText).toContain('- two.js\n1. export const two = 2;');
        expect(compressForToolMock).not.toHaveBeenCalled();
    });

    it('falls back to a real size reduction when multi-file compression fails', async () => {
        const content = 'a'.repeat(1000);
        await writeFixture(rootDir, 'plain.txt', content);
        // compressForTool returns null → tool uses its own "N. line" fallback
        compressForToolMock.mockResolvedValue(null);

        const handler = await registerTool('../dist/tools/read_multiple_files.js', 'read_multiple_files', rootDir);
        const result = await handler({ paths: ['plain.txt'], maxCharsPerFile: 5000 });

        // When compressForTool returns null, the tool emits "N. line" format content
        // The file fits in one line so the output is "1. " + truncated-a-content
        const resultText = result.content[0].text;
        expect(resultText).toMatch(/^- plain\.txt\n1\. a+$/);
        // The fallback must have reduced size: the a-run must not exceed the original 1000 chars
        const aaMatch = resultText.match(/1\. (a+)$/);
        expect(aaMatch).not.toBeNull();
        expect(aaMatch[1].length).toBeLessThanOrEqual(1000);
        expect(compressForToolMock).toHaveBeenCalledOnce();
    });

    it('caps search_files content output at 15000 characters', async () => {
        const lines = Array.from(
            { length: 600 },
            (_, i) => `line ${i}: needle ${'x'.repeat(40)}`
        ).join('\n');
        await writeFixture(rootDir, 'search-target.txt', lines);

        const handler = await registerTool('../dist/tools/search_files.js', 'search_files', rootDir);
        const result = await handler({
            path: '.',
            contentQuery: 'needle',
            literalSearch: true,
            maxResults: 500,
        });

        expect(result.content[0].text.length).toBeLessThanOrEqual(15000);
    });
});

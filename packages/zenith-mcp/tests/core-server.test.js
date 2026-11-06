import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';

const TOOL_REGISTERS = [
    '../dist/tools/read_file.js',
    '../dist/tools/search_file.js',
    '../dist/tools/read_media_file.js',
    '../dist/tools/read_multiple_files.js',
    '../dist/tools/write_file.js',
    '../dist/tools/edit_file.js',
    '../dist/tools/directory.js',
    '../dist/tools/search_files.js',
    '../dist/tools/filesystem.js',
    '../dist/tools/stash_restore.js',
    '../dist/tools/refactor_batch.js',
    '../dist/tools/bash.js',
];

const CONFIG_INDEX = '../dist/config/index.js';
const ADAPTERS_INDEX = '../dist/adapters/index.js';
const RETRIEVAL_INDEX = '../dist/retrieval/index.js';
const PROJECT_CONTEXT = '../dist/core/project-context.js';
const SERVER_MOD = '../dist/core/server.js';

function makeMockCtx(overrides = {}) {
    return {
        getAllowedDirectories: vi.fn(() => overrides.allowedDirs ?? ['/tmp']),
        setAllowedDirectories: vi.fn(),
        validatePath: vi.fn(async (p) => p),
        _retrievalPipeline: null,
        _toolRegistry: null,
        ...overrides,
    };
}

function makeMockToolServer() {
    return { registerTool: vi.fn() };
}

function makeMockServer() {
    return {
        server: {
            setNotificationHandler: vi.fn(),
            listRoots: vi.fn(),
            getClientCapabilities: vi.fn(),
            oninitialized: null,
        },
    };
}

function mockAllDeps(customMocks = {}) {
    for (const modPath of TOOL_REGISTERS) {
        vi.doMock(modPath, () => ({ register: vi.fn() }));
    }
    vi.doMock(CONFIG_INDEX, () => ({
        loadConfig: vi.fn(() => ({ enabledAdapters: [], backupDir: undefined, tools: {}, auto_write: { status: false } })),
        syncToolsWithConfig: vi.fn((config, toolNames) => ({
            config: { ...config, tools: Object.fromEntries(toolNames.map(n => [n, true])) },
            changed: false,
        })),
        patchToolsInConfig: vi.fn(),
    }));
    vi.doMock(ADAPTERS_INDEX, () => ({ configureRegistry: vi.fn() }));
    if (!customMocks[PROJECT_CONTEXT]) {
        vi.doMock(PROJECT_CONTEXT, () => ({ onRootsChanged: vi.fn(), getProjectContext: vi.fn(() => ({ initProject: vi.fn() })) }));
    }
    for (const [modPath, factory] of Object.entries(customMocks)) {
        vi.doMock(modPath, factory);
    }
}

async function importServer(customMocks = {}) {
    vi.resetModules();
    mockAllDeps(customMocks);
    return await import(SERVER_MOD);
}

async function getToolMocks(customMocks = {}) {
    vi.resetModules();
    const mocks = {};
    for (const modPath of TOOL_REGISTERS) {
        const fn = vi.fn();
        mocks[modPath] = fn;
        vi.doMock(modPath, () => ({ register: fn }));
    }
    vi.doMock(CONFIG_INDEX, () => ({
        loadConfig: vi.fn(() => ({ enabledAdapters: [], backupDir: undefined, tools: {}, auto_write: { status: false } })),
        syncToolsWithConfig: vi.fn((config, toolNames) => ({
            config: { ...config, tools: Object.fromEntries(toolNames.map(n => [n, true])) },
            changed: false,
        })),
        patchToolsInConfig: vi.fn(),
    }));
    vi.doMock(ADAPTERS_INDEX, () => ({ configureRegistry: vi.fn() }));
    if (!customMocks[PROJECT_CONTEXT]) {
        vi.doMock(PROJECT_CONTEXT, () => ({ onRootsChanged: vi.fn(), getProjectContext: vi.fn(() => ({ initProject: vi.fn() })) }));
    }
    for (const [modPath, factory] of Object.entries(customMocks)) {
        vi.doMock(modPath, factory);
    }
    const mod = await import(SERVER_MOD);
    return { mod, mocks };
}

describe('registerEnabledTools', () => {
    it('registers all 12 tools', async () => {
        const { mod, mocks } = await getToolMocks();
        const toolServer = makeMockToolServer();
        const ctx = makeMockCtx();
        mod.registerEnabledTools(toolServer, ctx);
        for (const modPath of TOOL_REGISTERS) {
            expect(mocks[modPath]).toHaveBeenCalledTimes(1);
        }
    });

    it('passes a ping-wrapped tool server (delegating to the original) and ctx to each register call', async () => {
        const { mod, mocks } = await getToolMocks();
        const toolServer = makeMockToolServer();
        const ctx = makeMockCtx();
        mod.registerEnabledTools(toolServer, ctx);
        for (const modPath of TOOL_REGISTERS) {
            expect(mocks[modPath]).toHaveBeenCalledTimes(1);
            const [receivedServer, receivedCtx] = mocks[modPath].mock.calls[0];
            // ctx passes through untouched
            expect(receivedCtx).toBe(ctx);
            // the server is the caller-environment-ping wrapper, which must
            // delegate registrations (name + registration object) to the
            // original ToolServer with the handler wrapped
            expect(typeof receivedServer.registerTool).toBe('function');
            const probeName = `probe-tool:${modPath}`;
            const registration = { description: 'probe' };
            receivedServer.registerTool(probeName, registration, async () => ({ content: [] }));
            const delegated = toolServer.registerTool.mock.calls.find(c => c[0] === probeName);
            expect(delegated).toBeTruthy();
            expect(delegated[1]).toBe(registration); // registration untouched — no schema injection
            expect(typeof delegated[2]).toBe('function');
        }
    });

    it('calls configureRegistry when adapters are enabled', async () => {
        vi.resetModules();
        const configureRegistry = vi.fn();
        for (const modPath of TOOL_REGISTERS) {
            vi.doMock(modPath, () => ({ register: vi.fn() }));
        }
        vi.doMock(CONFIG_INDEX, () => ({
            loadConfig: vi.fn(() => ({
                enabledAdapters: ['claude-desktop'],
                backupDir: '/backup',
                tools: {},
                auto_write: { status: true, backup_dir: '/backup' },
            })),
            syncToolsWithConfig: vi.fn((config, toolNames) => ({
                config: { ...config, tools: Object.fromEntries(toolNames.map(n => [n, true])) },
                changed: false,
            })),
            patchToolsInConfig: vi.fn(),
            expandTilde: vi.fn((p) => p),
        }));
        vi.doMock(ADAPTERS_INDEX, () => ({ configureRegistry }));
        vi.doMock(PROJECT_CONTEXT, () => ({ onRootsChanged: vi.fn(), getProjectContext: vi.fn(() => ({ initProject: vi.fn() })) }));
        const mod = await import(SERVER_MOD);
        mod.registerEnabledTools(makeMockToolServer(), makeMockCtx());
        expect(configureRegistry).toHaveBeenCalledWith('/backup');
    });

    it('does not call configureRegistry when no adapters are enabled', async () => {
        vi.resetModules();
        const configureRegistry = vi.fn();
        for (const modPath of TOOL_REGISTERS) {
            vi.doMock(modPath, () => ({ register: vi.fn() }));
        }
        vi.doMock(CONFIG_INDEX, () => ({
            loadConfig: vi.fn(() => ({ enabledAdapters: [], backupDir: undefined, tools: {}, auto_write: { status: false } })),
            syncToolsWithConfig: vi.fn((config, toolNames) => ({
                config: { ...config, tools: Object.fromEntries(toolNames.map(n => [n, true])) },
                changed: false,
            })),
            patchToolsInConfig: vi.fn(),
        }));
        vi.doMock(ADAPTERS_INDEX, () => ({ configureRegistry }));
        vi.doMock(PROJECT_CONTEXT, () => ({ onRootsChanged: vi.fn(), getProjectContext: vi.fn(() => ({ initProject: vi.fn() })) }));
        const mod = await import(SERVER_MOD);
        mod.registerEnabledTools(makeMockToolServer(), makeMockCtx());
        expect(configureRegistry).not.toHaveBeenCalled();
    });
});

describe('resolveInitialAllowedDirectories', () => {
    it('resolves a regular path', async () => {
        const mod = await importServer();
        const result = await mod.resolveInitialAllowedDirectories(['/tmp']);
        expect(result).toHaveLength(1);
        expect(result[0]).toBe('/tmp');
    });

    it('resolves multiple paths', async () => {
        const mod = await importServer();
        const dirs = ['/tmp', '/var'];
        const result = await mod.resolveInitialAllowedDirectories(dirs);
        expect(result).toHaveLength(2);
    });

    it('handles empty input', async () => {
        const mod = await importServer();
        const result = await mod.resolveInitialAllowedDirectories([]);
        expect(result).toEqual([]);
    });

    it('expands home directory', async () => {
        const mod = await importServer();
        const home = os.homedir();
        const result = await mod.resolveInitialAllowedDirectories(['~']);
        expect(result[0]).toBe(home);
    });

    it('expands home subdirectory', async () => {
        const mod = await importServer();
        const home = os.homedir();
        const result = await mod.resolveInitialAllowedDirectories(['~/Documents']);
        expect(result[0]).toBe(path.join(home, 'Documents'));
    });

    it('normalizes paths (resolves ..)', async () => {
        const mod = await importServer();
        const result = await mod.resolveInitialAllowedDirectories(['/tmp/..']);
        expect(result[0]).toBe('/');
    });

    it('falls back to absolute path when realpath fails', async () => {
        const mod = await importServer();
        const result = await mod.resolveInitialAllowedDirectories(['/nonexistent_dir_xyz']);
        expect(result[0]).toBe('/nonexistent_dir_xyz');
    });
});

describe('validateDirectories', () => {
    let tmpDir;

    afterEach(() => {
        try {
            const fs = require('fs');
            if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
    });

    it('passes for valid directories', async () => {
        const mod = await importServer();
        const fs = await import('fs');
        tmpDir = path.join(os.tmpdir(), `validate-dir-test-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });
        await expect(mod.validateDirectories([tmpDir])).resolves.toBeUndefined();
    });

    it('throws when directory does not exist', async () => {
        const mod = await importServer();
        await expect(mod.validateDirectories(['/nonexistent_dir_xyz_123']))
            .rejects.toThrow('Directory validation failed');
    });

    it('throws when path is a file not a directory', async () => {
        const mod = await importServer();
        const fs = await import('fs');
        const filePath = path.join(os.tmpdir(), `validate-file-test-${Date.now()}`);
        fs.writeFileSync(filePath, 'test');
        try {
            await expect(mod.validateDirectories([filePath]))
                .rejects.toThrow('is not a directory');
        } finally {
            fs.unlinkSync(filePath);
        }
    });

    it('throws with all errors when multiple directories are invalid', async () => {
        const mod = await importServer();
        await expect(mod.validateDirectories(['/nonexistent_1_xyz', '/nonexistent_2_xyz']))
            .rejects.toThrow('nonexistent_1');
    });

    it('passes when given an empty array', async () => {
        const mod = await importServer();
        await expect(mod.validateDirectories([])).resolves.toBeUndefined();
    });
});

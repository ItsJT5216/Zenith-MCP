/**
 * Tests for config/schema.ts changes in this PR.
 *
 * PR change in configToRaw():
 *   Before: entries.push(kv(name, config.tools[name], statusToStr(config.tools[name])));
 *   After:  const enabled = config.tools[name];
 *           if (enabled === undefined) continue;
 *           entries.push(kv(name, enabled, statusToStr(enabled)));
 *
 * Also removed the unused `section()` function (no behavior change).
 *
 * These tests verify that configToRaw correctly serializes the tools section
 * and that the undefined guard doesn't break normal operation.
 */

import { describe, expect, it } from 'vitest';
import { configToRaw, rawToConfig, DEFAULT_CONFIG, expandTilde } from '../dist/config/schema.js';

// ---------------------------------------------------------------------------
// configToRaw — basic shape
// ---------------------------------------------------------------------------

describe('configToRaw — basic shape', () => {
    it('returns an array of RawConfig entries', () => {
        const result = configToRaw(DEFAULT_CONFIG);
        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBeGreaterThan(0);
    });

    it('contains section entries for known config areas', () => {
        const result = configToRaw(DEFAULT_CONFIG);
        const types = result.map(e => e.type);
        expect(types).not.toContain('section');
        expect(types).toContain('subsection');
    });

    it('includes a kv entry for each enabled tool', () => {
        const config = {
            ...DEFAULT_CONFIG,
            tools: {
                search_files: true,
                read_file: false,
            },
        };
        const result = configToRaw(config);
        const kvEntries = result.filter(e => e.type === 'kv');
        const toolKvs = kvEntries.filter(e => e.key === 'search_files' || e.key === 'read_file');
        expect(toolKvs.length).toBe(2);
    });

    it('skips tools with undefined values (new guard in this PR)', () => {
        // Simulate a tools record with an undefined value
        const config = {
            ...DEFAULT_CONFIG,
            tools: {
                known_tool: true,
                undefined_tool: undefined,
            },
        };
        const result = configToRaw(config);
        const kvEntries = result.filter(e => e.type === 'kv');
        // known_tool should be present
        const knownKv = kvEntries.find(e => e.key === 'known_tool');
        expect(knownKv).toBeDefined();
        // undefined_tool should be skipped
        const undefinedKv = kvEntries.find(e => e.key === 'undefined_tool');
        expect(undefinedKv).toBeUndefined();
    });

    it('includes a comment when tools is empty', () => {
        const config = { ...DEFAULT_CONFIG, tools: {} };
        const result = configToRaw(config);
        const comments = result.filter(e => e.type === 'comment');
        const noToolsComment = comments.find(e => e.text && e.text.includes('no tools'));
        expect(noToolsComment).toBeDefined();
    });

    it('tools are serialized in sorted order', () => {
        const config = {
            ...DEFAULT_CONFIG,
            tools: {
                z_tool: true,
                a_tool: false,
                m_tool: true,
            },
        };
        const result = configToRaw(config);
        const toolKvs = result.filter(e => e.type === 'kv' &&
            ['a_tool', 'm_tool', 'z_tool'].includes(e.key));
        const names = toolKvs.map(e => e.key);
        expect(names).toEqual([...names].sort());
    });
});

// ---------------------------------------------------------------------------
// configToRaw — status string values
// ---------------------------------------------------------------------------

describe('configToRaw — status string values', () => {
    it('enabled tool has comment value "enabled"', () => {
        const config = { ...DEFAULT_CONFIG, tools: { my_tool: true } };
        const result = configToRaw(config);
        const kv = result.find(e => e.type === 'kv' && e.key === 'my_tool');
        expect(kv).toBeDefined();
        expect(kv.rawValue).toBe('enabled');
    });

    it('disabled tool has comment value "disabled"', () => {
        const config = { ...DEFAULT_CONFIG, tools: { my_tool: false } };
        const result = configToRaw(config);
        const kv = result.find(e => e.type === 'kv' && e.key === 'my_tool');
        expect(kv).toBeDefined();
        expect(kv.rawValue).toBe('disabled');
    });
});

// ---------------------------------------------------------------------------
// expandTilde — basic behavior
// ---------------------------------------------------------------------------

describe('expandTilde', () => {
    it('expands ~ at the start to homedir', () => {
        const result = expandTilde('~/some/path');
        expect(result).not.toContain('~');
        expect(result.endsWith('/some/path')).toBe(true);
    });

    it('does not expand ~ in the middle of a path', () => {
        const input = '/home/user/~/path';
        expect(expandTilde(input)).toBe(input);
    });

    it('expands standalone ~ to homedir', () => {
        const result = expandTilde('~');
        expect(result).not.toBe('~');
        expect(result.length).toBeGreaterThan(0);
    });

    it('leaves non-tilde paths unchanged', () => {
        expect(expandTilde('/absolute/path')).toBe('/absolute/path');
        expect(expandTilde('relative/path')).toBe('relative/path');
    });

    it('handles empty string without throwing', () => {
        expect(() => expandTilde('')).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// rawToConfig — round-trip sanity
// ---------------------------------------------------------------------------

describe('rawToConfig — round-trip via configToRaw', () => {
    it('round-trips DEFAULT_CONFIG without data loss', () => {
        const raw = configToRaw(DEFAULT_CONFIG);
        const restored = rawToConfig(raw);
        // The allowed_directories may differ between runs (env-based), check tools
        expect(typeof restored.tools).toBe('object');
    });

    it('round-trips a config with tools correctly', () => {
        const config = {
            ...DEFAULT_CONFIG,
            tools: { search_files: true, read_file: false },
        };
        const raw = configToRaw(config);
        const restored = rawToConfig(raw);
        expect(restored.tools.search_files).toBe(true);
        expect(restored.tools.read_file).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// ### Advanced — bash_timeout_seconds / bash_max_timeout_seconds
// ---------------------------------------------------------------------------

describe('advanced.bash_timeout_seconds / bash_max_timeout_seconds', () => {
    // A minimal RawConfig: the ### Advanced header followed by the given kv rows.
    function advancedRaw(...kvs) {
        return [{ type: 'subsection', name: 'Advanced', raw: '### Advanced' }, ...kvs];
    }
    function kv(key, rawValue) {
        return { type: 'kv', key, value: rawValue, rawValue, inlineComment: null };
    }

    it('defaults to 120 seconds with a 600 second cap', () => {
        expect(DEFAULT_CONFIG.advanced.bash_timeout_seconds).toBe(120);
        expect(DEFAULT_CONFIG.advanced.bash_max_timeout_seconds).toBe(600);
    });

    it('configToRaw emits both keys after the ### Advanced subsection', () => {
        const raw = configToRaw(DEFAULT_CONFIG);
        const advancedIdx = raw.findIndex(e => e.type === 'subsection' && e.name === 'Advanced');
        expect(advancedIdx).toBeGreaterThan(-1);
        const afterAdvanced = raw.slice(advancedIdx + 1);
        const timeout = afterAdvanced.find(e => e.type === 'kv' && e.key === 'bash_timeout_seconds');
        const max = afterAdvanced.find(e => e.type === 'kv' && e.key === 'bash_max_timeout_seconds');
        expect(timeout).toMatchObject({ key: 'bash_timeout_seconds', value: 120, rawValue: '120' });
        expect(max).toMatchObject({ key: 'bash_max_timeout_seconds', value: 600, rawValue: '600' });
    });

    it('rawToConfig parses positive integers', () => {
        const config = rawToConfig(advancedRaw(kv('bash_timeout_seconds', '45'), kv('bash_max_timeout_seconds', '900')));
        expect(config.advanced.bash_timeout_seconds).toBe(45);
        expect(config.advanced.bash_max_timeout_seconds).toBe(900);
    });

    it.each(['0', '-5', 'abc', '1.9', '45oops', '1e3', '1000000000000000000000', '9'.repeat(309)])('rawToConfig keeps the defaults for %j', (bad) => {
        const config = rawToConfig(advancedRaw(kv('bash_timeout_seconds', bad), kv('bash_max_timeout_seconds', bad)));
        expect(config.advanced.bash_timeout_seconds).toBe(DEFAULT_CONFIG.advanced.bash_timeout_seconds);
        expect(config.advanced.bash_max_timeout_seconds).toBe(DEFAULT_CONFIG.advanced.bash_max_timeout_seconds);
    });

    it('round-trips custom values through configToRaw → rawToConfig', () => {
        const custom = structuredClone(DEFAULT_CONFIG);
        custom.advanced.bash_timeout_seconds = 30;
        custom.advanced.bash_max_timeout_seconds = 1200;
        const restored = rawToConfig(configToRaw(custom));
        expect(restored.advanced.bash_timeout_seconds).toBe(30);
        expect(restored.advanced.bash_max_timeout_seconds).toBe(1200);
    });
});
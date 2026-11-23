import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { minimatch } from "minimatch";
import { getDefaultExcludes, isSensitive, ripgrepAvailable, ripgrepSearch, ripgrepFindFiles, bm25RankResults, bm25PreFilterFiles, getCharBudget, getSearchCharBudget, RANK_THRESHOLD } from '../core/shared.js';
import type { RipgrepResult } from '../core/shared.js';
import { isSupported, getLangForFile } from '../core/tree-sitter.js';
// Search tools are SYMBOL-FACT CONSUMERS — per docs/toon-constraints §0.5
// they read from the DB-backed adapter, never the tree-sitter extractor.
// `loadFileDefinitions` indexes each file on demand via `ensureIndexFresh`
// so the symbol rows always reflect current disk content.
import { loadFileDefinitions } from '../core/indexed-symbols.js';
import type { SymbolFilterOptions } from '../core/indexed-symbols.js';
import { ToolServer, ToolContext } from './types.js';

interface SearchFilesArgs {
    mode: "content" | "files" | "symbol" | "definition";
    path: string;
    maxResults?: number;
    contentQuery?: string;
    pattern?: string;
    contextLines?: number;
    literalSearch?: boolean;
    countOnly?: boolean;
    includeHidden?: boolean;
    pathContains?: string;
    extensions?: string[];
    namePattern?: string;
    includeMetadata?: boolean;
    symbolQuery?: string;
    symbolKind?: 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum' | 'module' | 'any';
    definesSymbol?: string;
}

export function register(server: ToolServer, ctx: ToolContext) {
    server.registerTool<SearchFilesArgs>("search_files", {
        title: "Search Files",
        description: "Search file contents, find files, or search symbols.",
        inputSchema: z.object({
            mode: z.enum(["content", "files", "symbol", "definition"]).describe("Search mode."),
            path: z.string().describe("Directory to search."),
            maxResults: z.number().optional().describe("Max results."),
            contentQuery: z.string().optional().describe("Text or regex."),
            pattern: z.string().optional().describe("File glob pattern."),
            contextLines: z.number().optional().describe("Context lines around each match."),
            literalSearch: z.boolean().optional().describe("Treat contentQuery as literal string."),
            countOnly: z.boolean().optional().describe("Return counts only."),
            includeHidden: z.boolean().optional().describe("Include hidden files."),
            pathContains: z.string().optional().describe("Substring in full path."),
            extensions: z.array(z.string()).optional().describe("Filter by extensions, e.g. ['.ts']."),
            namePattern: z.string().optional().describe("Glob against filename only."),
            includeMetadata: z.boolean().optional().describe("Include size and modified date."),
            symbolQuery: z.string().optional().describe("Substring to match symbol names."),
            symbolKind: z.enum(['function', 'class', 'method', 'interface', 'type', 'enum', 'module', 'any']).optional().describe("Filter by symbol kind."),
            definesSymbol: z.string().optional().describe("Symbol to find."),
        }),
        annotations: { readOnlyHint: true }
    }, async (args: SearchFilesArgs) => {
        const rootPath = await ctx.validatePath(args.path);
        const defaultExcludeGlobs = getDefaultExcludes().map(p => `**/${p}/**`);
        // ---- SYMBOL SEARCH / LIST MODE ----
        if (args.mode === "symbol") {
            const listAll = !args.symbolQuery;
            const userMaxResults = Math.min(500, Math.max(1, args.maxResults ?? 50));
            // Discover files — reuse ripgrep for speed
            const hasRg = await ripgrepAvailable();
            let filePaths: string[] = [];
            if (hasRg) {
                const results = await ripgrepFindFiles(rootPath, {
                    namePattern: args.pattern || null,
                    maxResults: 2000,
                    excludePatterns: defaultExcludeGlobs,
                });
                if (results)
                    filePaths = results;
            }
            // JS fallback
            if (filePaths.length === 0) {
                async function walk(dir: string) {
                    if (filePaths.length >= 2000)
                        return;
                    let entries;
                    try {
                        entries = await fs.readdir(dir, { withFileTypes: true });
                    }
                    catch {
                        return;
                    } 
                    for (const entry of entries) {
                        if (filePaths.length >= 2000)
                            return;
                        const fullPath = path.join(dir, entry.name); 
                        if (getDefaultExcludes().some(p => entry.name === p))
                            continue;
                        if (isSensitive(fullPath))
                            continue;
                        if (entry.isDirectory()) {
                            await walk(fullPath);
                        }
                        else {
                            filePaths.push(fullPath);
                        }
                    }
                }
                await walk(rootPath);
            }
            // Filter to supported files
            const supportedFiles = filePaths.filter(f => isSupported(f));
            if (supportedFiles.length === 0) {
                return { content: [{ type: "text" as const, text: 'No supported files found.' }] };
            }
            const MAX_FILE_SIZE = 512 * 1024;
            const BATCH_SIZE = 50;
            const typeFilter = args.symbolKind && args.symbolKind !== 'any' ? args.symbolKind : undefined;
            if (listAll) {
                const outputLines: string[] = [];
                for (let i = 0; i < supportedFiles.length; i += BATCH_SIZE) {
                    const batch = supportedFiles.slice(i, i + BATCH_SIZE);
                    const results = await Promise.all(batch.map(async (filePath) => {
                        try {
                            const stat = await fs.stat(filePath); 
                            if (stat.size > MAX_FILE_SIZE || stat.size === 0)
                                return null;
                            const langName = getLangForFile(filePath);
                            if (!langName)
                                return null;
                            const symOpts: SymbolFilterOptions = {};
                            if (typeFilter !== undefined) symOpts.typeFilter = typeFilter;
                            const defs = await loadFileDefinitions(filePath, symOpts);
                            if (!defs || defs.length === 0)
                                return null;
                            const rel = path.relative(rootPath, filePath);
                            const names = defs.map(d => `${d.name} (${d.type}:${d.line})`);
                            return { rel, defs, names };
                        }
                        catch {
                            return null;
                        }
                    }));
                    for (const result of results) {
                        if (!result)
                            continue;
                        outputLines.push(`${result.rel}: ${result.names.join(', ')}`);
                    }
                }
                const budgetLines: string[] = [];
                let charCount = 0;
                for (const line of outputLines) {
                    if (charCount + line.length + 1 > getCharBudget())
                        break;
                    budgetLines.push(line);
                    charCount += line.length + 1;
                }
                return { content: [{ type: "text" as const, text: budgetLines.join('\n') }] };
            }
            else {
                // ---- SYMBOL QUERY MODE ----
                const symbolQuery = args.symbolQuery;
                const outputLines: string[] = [];
                for (let i = 0; i < supportedFiles.length; i += BATCH_SIZE) {
                    const batch = supportedFiles.slice(i, i + BATCH_SIZE);
                    const results = await Promise.all(batch.map(async (filePath) => {
                        try {
                            const stat = await fs.stat(filePath); 
                            if (stat.size > MAX_FILE_SIZE || stat.size === 0)
                                return null;
                            const langName = getLangForFile(filePath);
                            if (!langName)
                                return null;
                            const symOpts: SymbolFilterOptions = {};
                            if (symbolQuery !== undefined) symOpts.nameFilter = symbolQuery;
                            if (typeFilter !== undefined) symOpts.typeFilter = typeFilter;
                            const defs = await loadFileDefinitions(filePath, symOpts);
                            if (!defs || defs.length === 0)
                                return null;
                            const rel = path.relative(rootPath, filePath);
                            return defs.map(d => ({
                                line: `${rel}:${d.line}  [${d.type}] ${d.name} (lines ${d.line}-${d.endLine})`,
                                file: rel,
                            }));
                        }
                        catch {
                            return null;
                        }
                    }));
                    for (const result of results) {
                        if (!result)
                            continue;
                        for (const entry of result) {
                            outputLines.push(entry.line);
                        }
                        if (outputLines.length >= userMaxResults)
                            break;
                    }
                    if (outputLines.length >= userMaxResults)
                        break;
                }
                const budgetLines: string[] = [];
                let charCount = 0;
                for (const line of outputLines.slice(0, userMaxResults)) {
                    if (charCount + line.length + 1 > getCharBudget())
                        break;
                    budgetLines.push(line);
                    charCount += line.length + 1;
                }
                const text = budgetLines.length > 0 ? budgetLines.join('\n') : 'No matches.';
                return { content: [{ type: "text" as const, text }] };
            }
        }
        // ---- DEFINITION MODE (find files defining a symbol) ----
        if (args.mode === "definition") {
            const userMaxResults = Math.min(500, Math.max(1, args.maxResults ?? 100));
            const hasRg = await ripgrepAvailable();
            let rawResults: string[] = [];
            if (hasRg) {
                const extGlobs = args.extensions?.length ? args.extensions.map((e: string) => `*${e}`) : null;
                const singleExtGlob = (extGlobs?.length === 1 && !args.namePattern) ? extGlobs[0] : undefined;
                const effectivePattern: string | null = singleExtGlob !== undefined
                    ? singleExtGlob
                    : (args.namePattern || null);
                const results = await ripgrepFindFiles(rootPath, {
                    namePattern: effectivePattern,
                    pathContains: args.pathContains || null,
                    maxResults: Math.min(userMaxResults * 5, 2000),
                    excludePatterns: defaultExcludeGlobs,
                });
                if (results !== null)
                    rawResults = results;
            }
            if (rawResults.length === 0) {
            const nameRegex = args.namePattern
                    ? new RegExp(args.namePattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*').replace(/\\\?/g, '.'), 'i')
                : null;
                async function walk(dir: string) {
                    if (rawResults.length >= userMaxResults * 5)
                        return;
                    let entries;
                    try {
                        entries = await fs.readdir(dir, { withFileTypes: true });
                    }
                    catch {
                        return;
                    } 
                    for (const entry of entries) {
                        if (rawResults.length >= userMaxResults * 5)
                            return;
                        const fullPath = path.join(dir, entry.name); 
                        if (getDefaultExcludes().some(p => entry.name === p))
                            continue;
                        if (isSensitive(fullPath))
                            continue;
                        if (entry.isDirectory()) {
                            try {
                                await ctx.validatePath(fullPath);
                            }
                            catch {
                                continue;
                            }
                            await walk(fullPath);
                        }
                        else if (entry.isFile()) {
                            const nameMatch = !nameRegex || nameRegex.test(entry.name);
                            const pathMatch = !args.pathContains || fullPath.toLowerCase().includes(args.pathContains.toLowerCase());
                            if (nameMatch && pathMatch)
                                rawResults.push(fullPath);
                        }
                    }
                }
                await walk(rootPath);
            }
            if (args.extensions?.length) {
                const extSet = new Set(args.extensions.map((e: string) => e.toLowerCase()));
                rawResults = rawResults.filter(f => extSet.has(path.extname(f).toLowerCase()));
            }
            const supportedFiles = rawResults.filter(f => isSupported(f));
            if (supportedFiles.length === 0) {
                return { content: [{ type: "text" as const, text: 'No supported files found for symbol search.' }] };
            }
            const BATCH_SIZE = 50;
            const MAX_FILE_SIZE = 512 * 1024;
            if (!args.definesSymbol) {
                throw new Error('definesSymbol is required for definition mode.');
            }
            const symbolName = args.definesSymbol;
            interface DefinitionSymbol {
                name: string;
                type: string;
                line: number;
                endLine: number;
            }
            const symbolMatches: Array<{ filePath: string; matches: DefinitionSymbol[] }> = [];
            for (let i = 0; i < supportedFiles.length; i += BATCH_SIZE) {
                const batch = supportedFiles.slice(i, i + BATCH_SIZE);
                const results = await Promise.all(batch.map(async (filePath) => {
                    try {
                        const stat = await fs.stat(filePath); 
                        if (stat.size > MAX_FILE_SIZE || stat.size === 0)
                            return null;
                        const langName = getLangForFile(filePath);
                        if (!langName)
                            return null;
                        const defs = await loadFileDefinitions(filePath);
                        if (!defs)
                            return null;
                        const parts = symbolName.split('.');
                        const targetName = parts[parts.length - 1];
                        const parentNames = parts.slice(0, -1);
                        let matches = defs.filter(d => d.name === targetName);
                        if (matches.length === 0)
                            return null;
                        if (parentNames.length > 0) {
                            matches = matches.filter(sym => {
                                let current = sym;
                                for (let pi = parentNames.length - 1; pi >= 0; pi--) {
                                    const parent = defs.find(d => d.name === parentNames[pi] &&
                                        d.line <= current.line &&
                                        d.endLine >= current.endLine &&
                                        d !== current);
                                    if (!parent)
                                        return false;
                                    current = parent;
                                }
                                return true;
                            });
                            if (matches.length === 0)
                                return null;
                        }
                        return { filePath, matches };
                    }
                    catch {
                        return null;
                    }
                }));
                for (const result of results) {
                    if (result)
                        symbolMatches.push(result);
                }
                if (symbolMatches.length >= userMaxResults)
                    break;
            }
            if (symbolMatches.length === 0) {
                return { content: [{ type: "text" as const, text: 'No matches.' }] };
            }
            const outputLines: string[] = [];
            for (const { filePath, matches } of symbolMatches) {
                for (const sym of matches) {
                    if (outputLines.length >= userMaxResults)
                        break;
                    outputLines.push(`${filePath}:${sym.line}  [${sym.type}] ${sym.name} (lines ${sym.line}-${sym.endLine})`);
                }
                if (outputLines.length >= userMaxResults)
                    break;
            }
            const budgetLines: string[] = [];
            let charCount = 0;
            for (const line of outputLines) {
                if (charCount + line.length + 1 > getCharBudget())
                    break;
                budgetLines.push(line);
                charCount += line.length + 1;
            }
            return { content: [{ type: "text" as const, text: budgetLines.join('\n') }] };
        }
        // ---- FILES MODE ----
        if (args.mode === "files") {
            const userMaxResults = Math.min(500, Math.max(1, args.maxResults ?? 100));
            const hasRg = await ripgrepAvailable();
            let rawResults: string[] = [];
            if (hasRg) {
                const extGlobs = args.extensions?.length ? args.extensions.map((e: string) => `*${e}`) : null;
                const singleExtGlob = (extGlobs?.length === 1 && !args.namePattern) ? extGlobs[0] : undefined;
                const fallbackPattern: string | null = singleExtGlob !== undefined
                    ? singleExtGlob
                    : (args.namePattern || null);
                const effectivePattern: string | null = args.pattern || fallbackPattern;
                const results = await ripgrepFindFiles(rootPath, {
                    namePattern: effectivePattern,
                    pathContains: args.pathContains || null,
                    maxResults: Math.min(userMaxResults * 2, 2000),
                    excludePatterns: defaultExcludeGlobs,
                });
                if (results !== null)
                    rawResults = results;
            }
            if (rawResults.length === 0) {
            const nameRegex = args.namePattern
                ? new RegExp(args.namePattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.'), 'i')
                : null;
                async function walk(dir: string) {
                    if (rawResults.length >= userMaxResults)
                        return;
                    let entries;
                    try {
                        entries = await fs.readdir(dir, { withFileTypes: true });
                    }
                    catch {
                        return;
                    } 
                    for (const entry of entries) {
                        if (rawResults.length >= userMaxResults)
                            return;
                        const fullPath = path.join(dir, entry.name); 
                        const rel = path.relative(rootPath, fullPath);
                        if (getDefaultExcludes().some(p => entry.name === p))
                            continue;
                        if (isSensitive(fullPath))
                            continue;
                        if (entry.isDirectory()) {
                            try {
                                await ctx.validatePath(fullPath);
                            }
                            catch {
                                continue;
                            }
                            await walk(fullPath);
                        }
                        else if (entry.isFile()) {
                            const nameMatch = !nameRegex || nameRegex.test(entry.name);
                            const patternMatch = !args.pattern || minimatch(rel, args.pattern, { dot: true });
                            const pathMatch = !args.pathContains || fullPath.toLowerCase().includes(args.pathContains.toLowerCase());
                            if (nameMatch && patternMatch && pathMatch)
                                rawResults.push(fullPath);
                        }
                    }
                }
                await walk(rootPath);
            }
            if (args.extensions?.length) {
                const extSet = new Set(args.extensions.map((e: string) => e.toLowerCase()));
                rawResults = rawResults.filter(f => extSet.has(path.extname(f).toLowerCase()));
            }
            rawResults = rawResults.slice(0, userMaxResults);
            rawResults.sort();
            let outputLines: string[];
            if (args.includeMetadata && rawResults.length > 0) {
                outputLines = await Promise.all(rawResults.map(async (filePath) => {
                    try {
                        const validPath = await ctx.validatePath(filePath);
                        const stat = await fs.stat(validPath); 
                        const sizeKB = (stat.size / 1024).toFixed(1);
                        const modified = stat.mtime.toISOString().slice(0, 10);
                        return `${filePath}  (${sizeKB}KB, ${modified})`;
                    }
                    catch {
                        return filePath;
                    }
                }));
            }
            else {
                outputLines = rawResults;
            }
            const budgetLines: string[] = [];
            let charCount = 0;
            for (const line of outputLines) {
                if (charCount + line.length + 1 > getCharBudget())
                    break;
                budgetLines.push(line);
                charCount += line.length + 1;
            }
            const text = budgetLines.length > 0 ? budgetLines.join('\n') : 'No files found.';
            return { content: [{ type: "text" as const, text }] };
        }
        // ---- CONTENT SEARCH MODE ----
        if (!args.contentQuery) {
            throw new Error('contentQuery required for content mode.');
        }
        const userMaxResults = Math.min(500, Math.max(1, args.maxResults ?? 50));
        const contextLines = Math.max(0, args.contextLines ?? 0);
        const allExcludes = defaultExcludeGlobs;

        // JS fallback only supports literal search — untrusted regex compilation is a ReDoS risk
        const hasRg = await ripgrepAvailable();
        if (!hasRg && !args.literalSearch) {
            throw new Error('Regex content search requires ripgrep. Use literalSearch: true for the JS fallback.');
        }

        const contentRegex = args.literalSearch
            ? new RegExp(args.contentQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
            : null; // regex search is handled by ripgrep only

        function contentFileFilter(fullPath: string, relativePath: string): boolean {
            if (args.pathContains && !fullPath.toLowerCase().includes(args.pathContains.toLowerCase())) {
                return false;
            }
            if (args.extensions?.length) {
                const ext = path.extname(fullPath).toLowerCase();
                if (!args.extensions.some(e => e.toLowerCase() === ext)) return false;
            }
            if (args.pattern) {
                const pat = args.pattern;
                const matches = minimatch(relativePath, pat, { dot: true }) ||
                    (!pat.includes('/') && minimatch(relativePath, `**/${pat}`, { dot: true }));
                if (!matches) return false;
            }
            return true;
        }

        // ---- RIPGREP PATH ----
        if (hasRg) {
            // Do not use ripgrepCountMatches for countOnly here.
            // ripgrep's count path reports occurrence counts, while the JS fallback
            // counts matching lines, which makes results depend on whether ripgrep
            // is available. Fall through so countOnly uses the shared non-shortcut
            // behavior instead of returning environment-dependent counts.

            let rgResults: RipgrepResult[] | null = null;
            if (args.contentQuery.length > 2) {
                try {
                    let candidateFiles = await bm25PreFilterFiles(rootPath, args.contentQuery, 100, allExcludes);
                    candidateFiles = candidateFiles.filter(f => contentFileFilter(f, path.relative(rootPath, f)));
                    if (candidateFiles.length > 0) {
                        rgResults = await ripgrepSearch(rootPath, {
                            contentQuery: args.contentQuery,
                            filePattern: args.pattern || null,
                            ignoreCase: true,
                            maxResults: Math.max(userMaxResults, 500),
                            excludePatterns: allExcludes,
                            contextLines,
                            literalSearch: args.literalSearch ?? false,
                            includeHidden: args.includeHidden ?? false,
                            fileList: candidateFiles,
                        });
                    }
                }
                catch {
                    // BM25 pre-filter failed — fall through to full ripgrep search
                }
            }
            if (rgResults === null) {
                rgResults = await ripgrepSearch(rootPath, {
                    contentQuery: args.contentQuery,
                    filePattern: args.pattern || null,
                    ignoreCase: true,
                    maxResults: Math.max(userMaxResults, 500),
                    excludePatterns: allExcludes,
                    contextLines,
                    literalSearch: args.literalSearch ?? false,
                    includeHidden: args.includeHidden ?? false,
                });
            }
            if (rgResults === null && !args.literalSearch) {
                throw new Error('Search failed — ripgrep process error.');
            }
            if (rgResults !== null) {
                // Apply extensions/pathContains filters to results
                rgResults = rgResults.filter(r => contentFileFilter(r.file, path.relative(rootPath, r.file)));
                if (rgResults.length === 0) {
                    return { content: [{ type: "text" as const, text: 'No matches.' }] };
                }
                if (args.countOnly) {
                    const fileSet = new Set(rgResults.map(r => r.file));
                    return { content: [{ type: "text" as const, text: `matches: ${rgResults.length}\nfiles: ${fileSet.size}` }] };
                }
                const rawLines = rgResults.map(r => `${r.file}:${r.line}: ${r.content}`);
                let outputLines: string[];
                if (rawLines.length > RANK_THRESHOLD) {
                    const { ranked } = bm25RankResults(rawLines, args.contentQuery, getSearchCharBudget());
                    outputLines = ranked;
                }
                else {
                    outputLines = [];
                    let charCount = 0;
                    for (const line of rawLines) {
                        if (charCount + line.length + 1 > getSearchCharBudget())
                            break;
                        outputLines.push(line);
                        charCount += line.length + 1;
                    }
                }
                return { content: [{ type: "text" as const, text: outputLines.join('\n') }] };
            }
        }
        // ------------------------------------------------------------------
        // JS fallback (content mode — literal search only)
        // ------------------------------------------------------------------
        const contentResults: string[] = [];
        const maxJsFallback = Math.min(200, userMaxResults);
        async function grepFile(filePath: string) {
            if (contentResults.length >= maxJsFallback || !contentRegex)
                return;
            try {
                const content = await fs.readFile(filePath, 'utf-8');
                const lines = content.split('\n');
                let lineNumber = 0;
                for (const line of lines) {
                    lineNumber++;
                    if (contentResults.length >= maxJsFallback)
                        break;
                    contentRegex.lastIndex = 0; // Reset stateful regex before each test
                    if (contentRegex.test(line)) {
                        contentResults.push(`${filePath}:${lineNumber}: ${line.trim().slice(0, 500)}`);
                    }
                }
            }
            catch { /* skip binary/unreadable files */ }
        }
        async function walk(dir: string) {
            if (contentResults.length >= maxJsFallback)
                return;
            let entries;
            try {
                entries = await fs.readdir(dir, { withFileTypes: true });
            }
            catch {
                return;
            }
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                const rel = path.relative(rootPath, fullPath);
                const excluded = allExcludes.some(pat => minimatch(rel, pat, { dot: true }) ||
                    minimatch(rel, pat.replace(/^\*\*\//, ''), { dot: true }));
                if (excluded)
                    continue;
                if (isSensitive(fullPath))
                    continue;
                if (entry.isDirectory()) {
                    await walk(fullPath);
                }
                else if (entry.isFile()) {
                    if (contentFileFilter(fullPath, rel)) {
                        await grepFile(fullPath);
                    }
                }
            }
        }
        await walk(rootPath);
        if (args.countOnly) {
            const fileSet = new Set(contentResults.map(r => r.split(':')[0]));
            return { content: [{ type: "text" as const, text: `matches: ${contentResults.length}\nfiles: ${fileSet.size}` }] };
        }
        let finalOutput: string[];
        if (contentResults.length > RANK_THRESHOLD) {
            const { ranked } = bm25RankResults(contentResults, args.contentQuery, getSearchCharBudget());
            finalOutput = ranked;
        }
        else {
            finalOutput = [];
            let charCount = 0;
            for (const line of contentResults) {
                if (charCount + line.length + 1 > getSearchCharBudget())
                    break;
                finalOutput.push(line);
                charCount += line.length + 1;
            }
        }
        const text = finalOutput.length > 0 ? finalOutput.join('\n') : 'No matches.';
        return { content: [{ type: "text" as const, text }] };
    });
}

import fs from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { createTwoFilesPatch } from 'diff';
import { minimatch } from 'minimatch';
import { normalizePath, expandHome } from './path-utils.js';
import { getCallerWorkingDirectory } from './caller-cwd.js';

function hasCode(e: unknown): e is { code: string } {
    return typeof e === 'object' && e !== null && 'code' in e && typeof (e as Record<string, unknown>).code === 'string';
}



export interface FilesystemContext {
    getAllowedDirectories(): string[];
    setAllowedDirectories(directories: string[]): void;
    setSandboxEnabled(enabled: boolean): void;
    validatePath(requestedPath: string): Promise<string>;
    validateNewFilePath(requestedPath: string): Promise<string>;
}

export function createFilesystemContext(initialAllowedDirectories: string[] = []): FilesystemContext {
    let _allowedDirectories = [...initialAllowedDirectories];
    // Access enforcement is OPT-IN. Default off so allowed directories stay
    // project-context hints (the historical "Zenith is intentionally not a
    // sandbox" behavior) until an operator explicitly enables the `sandbox`
    // config flag — registerEnabledTools wires that flag in via setSandboxEnabled().
    let _sandboxEnabled = false;
    // Security boundary is distinct from mutable project/context roots.
    // Enabling the sandbox freezes the directories that existed at that moment
    // (normally the operator-provided CLI roots). Later MCP Roots may enrich
    // project detection but must never widen filesystem access.
    let _sandboxDirectories: string[] = [];

    function getAllowedDirectories() {
        return [..._allowedDirectories];
    }

    function setAllowedDirectories(directories: string[]) {
        _allowedDirectories = [...directories];
    }

    function setSandboxEnabled(enabled: boolean) {
        _sandboxEnabled = enabled;
        _sandboxDirectories = enabled ? [..._allowedDirectories] : [];
    }

    async function isInsideAllowed(candidate: string): Promise<boolean> {
        // Access enforcement is OPT-IN via the `sandbox` config flag. When it is
        // disabled (the default), allowed directories are project-context hints
        // only and never block filesystem access — this decouples "which dirs are
        // known" (always populated from CLI args / MCP roots) from "is access
        // enforced" (only when the operator opts in). Historically these were
        // conflated: any configured dir silently turned enforcement on.
        if (!_sandboxEnabled) return true;
        // Sandbox enabled but no boundary configured: fail closed. An enabled
        // sandbox without roots must never degrade into unrestricted access.
        if (_sandboxDirectories.length === 0) return false;
        for (const allowed of _sandboxDirectories) {
            const expanded = expandHome(allowed);
            const absoluteAllowed = path.isAbsolute(expanded)
                ? path.resolve(expanded)
                : path.resolve(process.cwd(), expanded);
            let realAllowed: string;
            try {
                realAllowed = await fs.realpath(absoluteAllowed);
            } catch {
                // Allowed dir is missing or unreadable: fall back to lexical resolve
                // so the allowlist is still meaningful when symlink resolution fails.
                realAllowed = absoluteAllowed;
            }
            const withSep = realAllowed.endsWith(path.sep) ? realAllowed : realAllowed + path.sep;
            if (candidate === realAllowed || candidate.startsWith(withSep)) {
                return true;
            }
        }
        return false;
    }

    async function validatePath(requestedPath: string) {
        const expandedPath = expandHome(requestedPath);
        // A relative requested path resolves against the caller's working directory
        // (core/caller-cwd.ts): where the launcher shell or MCP client is working, not
        // where this server runs. The configured sandbox boundary (isInsideAllowed)
        // deliberately stays anchored to this process's own cwd and does not move with it.
        const absolute = path.isAbsolute(expandedPath)
            ? path.resolve(expandedPath)
            : path.resolve(getCallerWorkingDirectory(), expandedPath);
        normalizePath(absolute);

        try {
            const realPath = await fs.realpath(absolute);
            normalizePath(realPath);
            if (!(await isInsideAllowed(realPath))) {
                throw new Error(`Access denied: ${requestedPath} is outside allowed directories`);
            }
            return realPath;
        } catch (error: unknown) {
            if (error instanceof Error && error.message.startsWith('Access denied')) {
                throw error;
            }
            if (hasCode(error) && error.code === 'ENOENT') {
                const parentDir = path.dirname(absolute);
                try {
                    const realParentPath = await fs.realpath(parentDir);
                    normalizePath(realParentPath);
                    if (!(await isInsideAllowed(realParentPath))) {
                        throw new Error(`Access denied: ${requestedPath} is outside allowed directories`);
                    }
                    return absolute;
                } catch (parentError) {
                    if (parentError instanceof Error && parentError.message.startsWith('Access denied')) {
                        throw parentError;
                    }
                    // Re-throw access-denied and other non-filesystem errors unchanged.
                    // Wrap filesystem errors (ENOENT, EACCES, etc.) with a friendlier message.
                    if (!hasCode(parentError)) throw parentError;
                    throw new Error(`Parent directory does not exist: ${parentDir}`);
                }
            }
            throw error;
        }
    }

    async function resolveNearestExistingAncestor(targetPath: string): Promise<{ realAncestor: string; missingSegments: string[] }> {
        const missingSegments: string[] = [];
        let cursor = path.resolve(targetPath);
        while (true) {
            try {
                return { realAncestor: await fs.realpath(cursor), missingSegments };
            } catch (error: unknown) {
                if (!hasCode(error) || error.code !== 'ENOENT') throw error;
                const parent = path.dirname(cursor);
                if (parent === cursor) {
                    throw new Error(`No existing ancestor found for path: ${targetPath}`);
                }
                missingSegments.unshift(path.basename(cursor));
                cursor = parent;
            }
        }
    }

    async function validateNewFilePath(requestedPath: string): Promise<string> {
        const expandedPath = expandHome(requestedPath);
        // Same base as validatePath: a relative requested path resolves against the
        // caller's working directory (core/caller-cwd.ts); the boundary does not move with it.
        const absolute = path.isAbsolute(expandedPath)
            ? path.resolve(expandedPath)
            : path.resolve(getCallerWorkingDirectory(), expandedPath);
        normalizePath(absolute);
        const { realAncestor, missingSegments } = await resolveNearestExistingAncestor(absolute);
        normalizePath(realAncestor);
        // The nearest existing ancestor is the only segment of a not-yet-existing
        // target that can be realpath-resolved, so it is the symlink-collapsed
        // anchor the allowlist must gate — exactly as validatePath gates the
        // realpath of an ENOENT target's existing parent before returning. When
        // When the sandbox is enabled, the frozen sandbox boundary (not the
        // mutable project/context roots) gates the existing ancestor.
        if (!(await isInsideAllowed(realAncestor))) {
            throw new Error(`Access denied: ${requestedPath} is outside allowed directories`);
        }
        const resolvedTarget = missingSegments.reduce(
            (currentPath, segment) => path.join(currentPath, segment),
            realAncestor,
        );
        normalizePath(resolvedTarget);
        // Re-check the reconstructed target itself. With the ancestor already
        // confirmed inside an allowed dir the descent stays inside it, but
        // checking the returned path mirrors validatePath gating its returned
        // realPath and keeps the write contract identical to the read contract.
        if (!(await isInsideAllowed(resolvedTarget))) {
            throw new Error(`Access denied: ${requestedPath} is outside allowed directories`);
        }
        return resolvedTarget;
    }

    return { getAllowedDirectories, setAllowedDirectories, setSandboxEnabled, validatePath, validateNewFilePath };
}

export function formatSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) {
        throw new RangeError(`bytes must be a non-negative finite number: ${bytes}`);
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    if (bytes === 0) return '0 B';
    const unitIndex = Math.min(
        Math.floor(Math.log(bytes) / Math.log(1024)),
        units.length - 1,
    );
    if (unitIndex <= 0) return `${bytes} ${units[0]}`;
    return `${(bytes / Math.pow(1024, unitIndex)).toFixed(2)} ${units[unitIndex]}`;
}

function trimTerminalEmptyLine(lines: string[]): string[] {
    return lines.length > 0 && lines[lines.length - 1] === ''
        ? lines.slice(0, -1)
        : lines;
}

/**
 * Detect how many incoming lines overlap with the tail of an existing file.
 * Used by append-mode writes to avoid duplicating content on resume.
 * Trailing empty lines (artifacts of split('\n') on newline-terminated files)
 * are stripped from both arrays before comparison.
 */
export function findResumeOffset(existingTailLines: string[], incomingLines: string[]): number {
    const existing = trimTerminalEmptyLine(existingTailLines);
    const incoming = trimTerminalEmptyLine(incomingLines);
    if (!existing.length || !incoming.length)
        return 0;
    const trim = (s: string) => s.trimEnd();
    const firstIncomingRaw = incoming[0];
    if (firstIncomingRaw === undefined)
        throw new Error('findResumeOffset: incomingLines[0] missing despite non-empty check');
    const firstIncoming = trim(firstIncomingRaw);
    for (let i = 0; i < existing.length; i++) {
        const existingAtI = existing[i];
        if (existingAtI === undefined)
            throw new Error(`findResumeOffset: existingTailLines[${i}] out of range`);
        if (trim(existingAtI) !== firstIncoming)
            continue;
        const overlapLen = Math.min(existing.length - i, incoming.length);
        let matched = true;
        for (let j = 0; j < overlapLen; j++) {
            const existingAtIJ = existing[i + j];
            const incomingAtJ = incoming[j];
            if (existingAtIJ === undefined || incomingAtJ === undefined)
                throw new Error(`findResumeOffset: index out of range at i=${i}, j=${j}`);
            if (trim(existingAtIJ) !== trim(incomingAtJ)) {
                matched = false;
                break;
            }
        }
        if (matched) return overlapLen;
    }
    return 0;
}

export function normalizeLineEndings(text: string): string {
    return text.replace(/\r\n/g, '\n');
}

export function createUnifiedDiff(originalContent: string, newContent: string, filepath = 'file'): string {
    const normalizedOriginal = normalizeLineEndings(originalContent);
    const normalizedNew = normalizeLineEndings(newContent);
    return createTwoFilesPatch(filepath, filepath, normalizedOriginal, normalizedNew, 'original', 'modified');
}

export function createMinimalDiff(originalContent: string, newContent: string, filepath = 'file'): string {
    const normalizedOriginal = normalizeLineEndings(originalContent);
    const normalizedNew = normalizeLineEndings(newContent);
    return createTwoFilesPatch(filepath, filepath, normalizedOriginal, normalizedNew, '', '', { context: 0 });
}



export async function getFileStats(filePath: string) {
    const stats = await fs.stat(filePath);
    return {
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime,
        accessed: stats.atime,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        permissions: stats.mode.toString(8).slice(-3),
    };
}

export async function readFileContent(filePath: string, encoding = 'utf-8') {
    return await fs.readFile(filePath, encoding as BufferEncoding);
}

export async function writeFileContent(filePath: string, content: string) {
    try {
        await fs.writeFile(filePath, content, { encoding: "utf-8", flag: 'wx' });
    } catch (error: unknown) {
        if (hasCode(error) && error.code === 'EEXIST') {
            const tempPath = `${filePath}.${randomBytes(16).toString('hex')}.tmp`;
            try {
                await fs.writeFile(tempPath, content, 'utf-8');
                await fs.rename(tempPath, filePath);
            } catch (renameError) {
                try { await fs.unlink(tempPath); } catch (unlinkErr) { void unlinkErr; /* temp file cleanup after rename failure */ }
                throw renameError;
            }
        } else {
            throw error;
        }
    }
}

export async function applyFileEdits(filePath: string, edits: Array<{ oldText: string; newText: string }>, dryRun = false) {
    const content = normalizeLineEndings(await fs.readFile(filePath, 'utf-8'));
    let modifiedContent = content;
    for (const edit of edits) {
        const normalizedOld = normalizeLineEndings(edit.oldText);
        const normalizedNew = normalizeLineEndings(edit.newText);
        if (normalizedOld.length === 0) {
            throw new Error('applyFileEdits: oldText must not be empty');
        }

        const exactMatches = countOccurrences(modifiedContent, normalizedOld);
        if (exactMatches > 1) {
            throw new Error(`Ambiguous edit: found ${exactMatches} exact matches for:\n${edit.oldText}`);
        }
        if (exactMatches === 1) {
            modifiedContent = modifiedContent.replace(normalizedOld, normalizedNew);
            continue;
        }

        // Whitespace-tolerant fallback: collect all candidate positions first
        const oldLines = normalizedOld.split('\n');
        const contentLines = modifiedContent.split('\n');
        const candidateIndexes: number[] = [];
        for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
            const potentialMatch = contentLines.slice(i, i + oldLines.length);
            const isMatch = oldLines.every((oldLine, j) => {
                const contentLine = potentialMatch[j];
                if (contentLine === undefined)
                    throw new Error(`applyFileEdits: potentialMatch[${j}] missing for window at i=${i}`);
                return oldLine.trim() === contentLine.trim();
            });
            if (isMatch) candidateIndexes.push(i);
        }
        if (candidateIndexes.length === 0) {
            throw new Error(`Could not find exact match for edit:\n${edit.oldText}`);
        }
        if (candidateIndexes.length > 1) {
            throw new Error(
                `Ambiguous whitespace-tolerant edit: found ${candidateIndexes.length} matches for:\n${edit.oldText}`
            );
        }
        const matchIndex = candidateIndexes[0];
        if (matchIndex === undefined) {
            throw new Error('applyFileEdits: internal error — candidateIndexes[0] missing after length check');
        }
        const firstContentLine = contentLines[matchIndex];
        if (firstContentLine === undefined)
            throw new Error(`applyFileEdits: contentLines[${matchIndex}] missing despite matched window`);
        const originalIndent = firstContentLine.match(/^\s*/)?.[0] ?? '';
        const newLines = normalizedNew.split('\n').map((line, j) => {
            if (j === 0) return originalIndent + line.trimStart();
            const oldIndent = oldLines[j]?.match(/^\s*/)?.[0] ?? '';
            const newIndent = line.match(/^\s*/)?.[0] ?? '';
            if (oldIndent && newIndent) {
                const relativeIndent = newIndent.length - oldIndent.length;
                return originalIndent + ' '.repeat(Math.max(0, relativeIndent)) + line.trimStart();
            }
            return line;
        });
        contentLines.splice(matchIndex, oldLines.length, ...newLines);
        modifiedContent = contentLines.join('\n');
    }
    const diff = createUnifiedDiff(content, modifiedContent, filePath);
    let numBackticks = 3;
    while (diff.includes('`'.repeat(numBackticks))) { numBackticks++; }
    const formattedDiff = `${'`'.repeat(numBackticks)}diff\n${diff}${'`'.repeat(numBackticks)}\n\n`;
    if (!dryRun) {
        const tempPath = `${filePath}.${randomBytes(16).toString('hex')}.tmp`;
        try {
            await fs.writeFile(tempPath, modifiedContent, 'utf-8');
            await fs.rename(tempPath, filePath);
        } catch (error) {
            try { await fs.unlink(tempPath); } catch (unlinkErr) { void unlinkErr; /* temp file cleanup after failed atomic write */ }
            throw error;
        }
    }
    return formattedDiff;
}

export function countOccurrences(text: string, search: string): number {
    let count = 0;
    let pos = 0;
    const normText = normalizeLineEndings(text);
    const normSearch = normalizeLineEndings(search);
    if (normSearch.length === 0) {
        throw new Error('countOccurrences: search must not be empty');
    }
    while (true) {
        const idx = normText.indexOf(normSearch, pos);
        if (idx === -1) break;
        count++;
        pos = idx + normSearch.length;
    }
    return count;
}

export async function tailFile(filePath: string, numLines: number) {
    const n = Math.floor(numLines);
    if (!Number.isFinite(n) || n <= 0) return '';
    const cap = Math.min(n, 50_000);

    const stat = await fs.stat(filePath);
    if (stat.size <= 131_072) {
        const stream = createReadStream(filePath, { encoding: 'utf-8' });
        const rl = createInterface({ input: stream, crlfDelay: Infinity });
        const ring = new Array<string>(cap);
        let count = 0;
        try {
            for await (const line of rl) {
                ring[count % cap] = line;
                count++;
            }
        } finally {
            rl.close();
            stream.destroy();
        }
        if (count === 0) return '';
        if (count <= cap) return ring.slice(0, count).join('\n');
        const start = count % cap;
        return [...ring.slice(start), ...ring.slice(0, start)].join('\n');
    }

    const CHUNK_SIZE = 65_536;
    const handle = await fs.open(filePath, 'r');
    try {
        let position = stat.size;
        const chunks: string[] = [];
        let lineCount = 0;

        while (position > 0 && lineCount <= cap) {
            const readSize = Math.min(CHUNK_SIZE, position);
            position -= readSize;
            const buf = Buffer.alloc(readSize);
            await handle.read(buf, 0, readSize, position);
            const chunk = buf.toString('utf-8');
            for (let i = 0; i < chunk.length; i++) {
                if (chunk[i] === '\n') lineCount++;
            }
            chunks.push(chunk);
        }

        // Reverse chunks (read back-to-front) and join once
        chunks.reverse();
        const tail = chunks.join('');
        const lines = tail.replace(/\r\n/g, '\n').split('\n');
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
        const result = lines.slice(-cap);
        return result.join('\n');
    } finally {
        await handle.close();
    }
}

export async function headFile(filePath: string, numLines: number) {
    if (numLines <= 0) return '';
    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    const lines: string[] = [];
    try {
        for await (const line of rl) {
            lines.push(line);
            if (lines.length >= numLines) break;
        }
        return lines.join('\n');
    } finally {
        rl.close();
        stream.destroy();
    }
}

export async function offsetReadFile(filePath: string, offset: number, length: number) {
    if (length <= 0) return { content: '', linesReturned: 0, hasMore: false };
    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    const collected: string[] = [];
    let lineNum = 0;
    let hasMore = false;
    try {
        for await (const line of rl) {
            if (lineNum >= offset) {
                if (collected.length < length) {
                    collected.push(line);
                } else {
                    hasMore = length > 0;
                    break;
                }
            }
            lineNum++;
        }
        return { content: collected.join('\n'), linesReturned: collected.length, hasMore };
    } finally {
        rl.close();
        stream.destroy();
    }
}

export async function searchFilesWithValidation(rootPath: string, pattern: string, allowedDirectories: string[], options: { excludePatterns?: string[] } = {}) {
    void allowedDirectories;
    const { excludePatterns = [] } = options;
    const results: string[] = [];
    async function search(currentPath: string) {
        const entries = await fs.readdir(currentPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentPath, entry.name);
            const relativePath = path.relative(rootPath, fullPath);
            const shouldExclude = excludePatterns.some(excludePattern => minimatch(relativePath, excludePattern, { dot: true }));
            if (shouldExclude) continue;
            if (minimatch(relativePath, pattern, { dot: true })) {
                results.push(fullPath);
            }
            if (entry.isDirectory()) {
                await search(fullPath);
            }
        }
    }
    await search(rootPath);
    return results;
}

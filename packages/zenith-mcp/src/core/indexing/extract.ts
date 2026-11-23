// ---------------------------------------------------------------------------
// indexing/extract.ts — Single-parse orchestrator for one file
//
// Invariant: Parses source ONCE. Shares the tree rootNode with all extractors.
// Returns a ParsedFileRecord with no DB awareness. Pure data extraction.
// ---------------------------------------------------------------------------

import { Parser, type Node, type QueryCapture } from 'web-tree-sitter';
import { loadLanguage, getCompiledQuery } from '../tree-sitter/runtime.js';
import { extractStructureForDef } from '../tree-sitter/structure.js';
import { extractAnchorsForDef } from '../tree-sitter/anchors.js';
import { extractImportsFromSymbols } from '../tree-sitter/imports.js';
import { extractImportStatements } from '../tree-sitter/import-bindings.js';
import { extractInjections } from '../tree-sitter/injections.js';
import { extractLocals } from '../tree-sitter/locals.js';
import { bodySlice, bodyHash } from '../tree-sitter/body.js';
import { selectDefinitionNode, type SymbolInfo } from '../tree-sitter/symbols.js';
import type { ParsedFileRecord, SymbolRow, StructureRow, AnchorRow, RawEdgeRow, LocalScopeRow, ImportBindingRow } from './types.js';

export async function extractParsedFile(
    source: string, langName: string, relPath: string, hash: string
): Promise<ParsedFileRecord | null> {
    const language = await loadLanguage(langName);
    if (!language) return null;

    const query = await getCompiledQuery(langName);
    if (!query) return null;

    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source);
    if (!tree) { parser.delete(); return null; }

    try {
        const rootNode = tree.rootNode;

        // --- Step 1: Run tags query to get symbols (same logic as symbols.ts) ---
        const matches = query.matches(rootNode);
        const rawSymbols: SymbolInfo[] = [];
        const seen = new Set<string>();
        const defNodes = new Map<string, { primary: Node; span: Node }>();
        for (const match of matches) {
            let nameCapture: QueryCapture | null = null;
            let bodyCapture: QueryCapture | null = null;
            for (const cap of match.captures) {
                if (cap.name.startsWith('name.')) nameCapture = cap;
                else if (cap.name.startsWith('definition.') || cap.name.startsWith('reference.')) bodyCapture = cap;
            }
            if (!nameCapture) continue;
            const tag = nameCapture.name;
            let kind: string, type: string;
            if (tag.startsWith('name.definition.')) { kind = 'def'; type = tag.slice(16); }
            else if (tag.startsWith('name.reference.')) { kind = 'ref'; type = tag.slice(15); }
            else continue;
            const name = nameCapture.node.text;
            const line = nameCapture.node.startPosition.row + 1;
            const column = nameCapture.node.startPosition.column;
            let endLine: number;
            let selPrimary: Node | null = null;
            let selSpan: Node | null = null;
            if (kind === 'def') {
                // Deterministic span policy (same as symbols.ts getSymbols): the tightest
                // DEF_TYPES ancestor of the NAME owns the symbol's end. Last-capture-wins
                // let a parent container's range bleed into child symbols.
                const selected = selectDefinitionNode(nameCapture.node);
                if (selected) {
                    selPrimary = selected.primaryNode;
                    selSpan = selected.spanNode;
                    endLine = selPrimary.endPosition.row + 1;
                } else if (bodyCapture) {
                    endLine = bodyCapture.node.endPosition.row + 1;
                } else {
                    endLine = nameCapture.node.endPosition.row + 1;
                }
            } else {
                endLine = bodyCapture ? bodyCapture.node.endPosition.row + 1 : nameCapture.node.endPosition.row + 1;
            }
            const key = `${name}:${kind}:${line}`;
            if (seen.has(key)) continue;
            seen.add(key);
            if (selPrimary !== null && selSpan !== null) {
                defNodes.set(`${name}:${line}:${column}`, { primary: selPrimary, span: selSpan });
            }
            rawSymbols.push({ name, kind, type, line, endLine, column });
        }
        rawSymbols.sort((a, b) => a.line - b.line);

        const defs = rawSymbols.filter(s => s.kind === 'def');

        // --- Step 2: Build SymbolRows with containment + body hash ---
        const symbols: SymbolRow[] = [];
        for (const s of rawSymbols) {
            let bHash: string | null = null;
            let parentKey: string | null = null;
            const visibility: string | null = null;

            if (s.kind === 'def') {
                const slice = bodySlice(source, s.line, s.endLine);
                bHash = bodyHash(slice);
                // Parent containment: smallest STRICTLY enclosing AST definition.
                // Line spans alone cannot distinguish same-line nesting: for
                // `type T = { p: string }`, both defs occupy line 1 and the old
                // symmetric row test made T and p each other's parent. The cached
                // selected nodes provide exact byte containment; only fall back to
                // rows when a grammar did not produce a selectable definition node.
                let bestParent: SymbolInfo | null = null;
                let bestSpan = Infinity;
                const childNodes = defNodes.get(`${s.name}:${s.line}:${s.column}`);
                for (const d of defs) {
                    if (d === s) continue;
                    const parentNodes = defNodes.get(`${d.name}:${d.line}:${d.column}`);
                    if (childNodes && parentNodes) {
                        const strictlyContains =
                            parentNodes.span.startIndex <= childNodes.span.startIndex
                            && parentNodes.span.endIndex >= childNodes.span.endIndex
                            && (parentNodes.span.startIndex < childNodes.span.startIndex
                                || parentNodes.span.endIndex > childNodes.span.endIndex);
                        if (!strictlyContains) continue;
                        const span = parentNodes.span.endIndex - parentNodes.span.startIndex;
                        if (span < bestSpan) { bestSpan = span; bestParent = d; }
                    } else {
                        const strictlyContains =
                            d.line <= s.line && d.endLine >= s.endLine
                            && (d.line < s.line || d.endLine > s.endLine);
                        if (!strictlyContains) continue;
                        const span = d.endLine - d.line;
                        if (span < bestSpan) { bestSpan = span; bestParent = d; }
                    }
                }
                if (bestParent) parentKey = `${bestParent.name}:${bestParent.line}:${bestParent.column}`;
            }

            const captureTag = s.kind === 'def' ? `definition.${s.type}` : `reference.${s.type}`;
            symbols.push({ name: s.name, kind: s.kind === 'def' ? 'def' : 'ref', type: s.type, captureTag, line: s.line, endLine: s.endLine, column: s.column, bodyHash: bHash, parentSymbolKey: parentKey, visibility });
        }

        // --- Step 3: Structure extraction (shares rootNode) ---
        const structures: StructureRow[] = [];
        for (const s of defs) {
            const cached = defNodes.get(`${s.name}:${s.line}:${s.column}`);
            const struct = cached ? extractStructureForDef(cached.span, langName) : null;
            if (struct) {
                const key = `${s.name}:${s.line}:${s.column}`;
                structures.push({ parentSymbolKey: key, params: struct.params, returnKind: struct.returnKind, decorators: struct.decorators, modifiers: struct.modifiers, parentKind: struct.parentKind });
                // Derive visibility
                const sym = symbols.find(sym => sym.line === s.line && sym.column === s.column && sym.kind === 'def');
                if (sym) {
                    if (struct.modifiers.includes('export') || struct.modifiers.includes('public') || struct.modifiers.includes('pub')) sym.visibility = 'public';
                    else if (struct.modifiers.includes('private')) sym.visibility = 'private';
                    else if (struct.modifiers.includes('protected')) sym.visibility = 'protected';
                }
            }
        }

        // --- Step 4: Anchor extraction (shares rootNode, uses cached def nodes) ---
        const anchors: AnchorRow[] = [];
        const lines = source.split('\n');
        for (const s of defs) {
            const cached = defNodes.get(`${s.name}:${s.line}:${s.column}`);
            if (!cached) continue;
            // PRIMARY, not span: the anchor walk prunes nested DEF_NODE_TYPES at depth>0
            // (anchors.ts:234-237). Walking the decorated_definition wrapper hits the inner
            // function_definition at depth 1 and prunes the entire body — zero anchors.
            // This also fixes exported defs: the old positional walk matched export_statement
            // (identical row span) and the walk pruned at the function child — live anchor loss.
            const defAnchors = extractAnchorsForDef(cached.primary, langName, s.line - 1);
            const key = `${s.name}:${s.line}:${s.column}`;
            for (const a of defAnchors) {
                // a.line is 0-based (anchors.ts contract). We persist it 1-based
                // (`a.line + 1`) on purpose so every line column in the DB shares one
                // unit with the rest of the index, and TOON's compressFile converts
                // back with `a.line - 1` to index the source. The `text` slice below
                // indexes `lines` by the 0-based a.line — the row the anchor sits on.
                const lineText = lines[a.line];
                const text = lineText ? lineText.slice(0, 80) : '';
                anchors.push({ parentSymbolKey: key, kind: a.kind, line: a.line + 1, endLine: a.endLine + 1, priority: a.priority, text });
            }
        }

        // --- Step 5: Imports (post-processes symbols, no re-parse) ---
        // Spans and bindings come from the SAME statement node, so bindings can
        // never cross-contaminate statements that share a line (PR-78 review).
        const importStatements = extractImportStatements(rootNode, langName);
        const importBindings: ImportBindingRow[] = importStatements
            .flatMap(stmt => stmt.bindings)
            .sort((a, b) => (a.line - b.line) || (a.column - b.column));
        const imports = importStatements.length > 0
            ? importStatements.map(stmt => ({
                module: stmt.span.module,
                importedNames: [...new Set(stmt.bindings.map(binding => binding.localName))],
                line: stmt.span.line,
                startLine: stmt.span.startLine,
                endLine: stmt.span.endLine,
            }))
            : extractImportsFromSymbols(rawSymbols);

        // --- Step 6: Injections (shares rootNode) ---
        const injections = await extractInjections(rootNode, langName);
        const injectionRows = injections.map(inj => ({
            hostLang: inj.hostLang, injectedLang: inj.injectedLang,
            startLine: inj.startLine, endLine: inj.endLine,
            startByte: inj.startByte, endByte: inj.endByte,
        }));

        // --- Step 7: Locals (shares rootNode) ---
        const localScopes = await extractLocals(rootNode, langName);
        const locals: LocalScopeRow[] = (localScopes ?? []).map(scope => {
            // Innermost enclosing def, not first-match. defs is line-sorted, so a
            // scope nested in a method would otherwise bind to the outer class (which
            // appears first). Mirror the bestSpan containment used in Step 2 (parent
            // linkage) and Step 8 (edges): pick the def with the tightest span.
            let bestParent: SymbolInfo | null = null;
            let bestSpan = Infinity;
            for (const d of defs) {
                if (d.line <= scope.startLine && d.endLine >= scope.endLine) {
                    const span = d.endLine - d.line;
                    if (span < bestSpan) { bestSpan = span; bestParent = d; }
                }
            }
            const parentKey = bestParent ? `${bestParent.name}:${bestParent.line}:${bestParent.column}` : null;
            return { parentSymbolKey: parentKey, scopeKind: scope.scopeKind, startLine: scope.startLine, endLine: scope.endLine, parameters: scope.parameters, locals: scope.locals };
        });

        // --- Step 8: Edges (innermost-def containment) ---
        const defEntries = symbols.filter(s => s.kind === 'def');
        const edges: RawEdgeRow[] = [];
        for (const ref of symbols.filter(s => s.kind === 'ref')) {
            let bestDef: SymbolRow | null = null;
            let bestSpan = Infinity;
            for (const def of defEntries) {
                if (ref.line >= def.line && ref.line <= def.endLine) {
                    const span = def.endLine - def.line;
                    if (span < bestSpan) { bestSpan = span; bestDef = def; }
                }
            }
            if (bestDef) edges.push({ containerDefKey: `${bestDef.name}:${bestDef.line}:${bestDef.column}`, referencedName: ref.name, referenceKind: ref.type });
        }

        return { relPath, hash, lang: langName, symbols, structures, anchors, imports, importBindings, injections: injectionRows, locals, edges };
    } finally {
        tree.delete();
        parser.delete();
    }
}

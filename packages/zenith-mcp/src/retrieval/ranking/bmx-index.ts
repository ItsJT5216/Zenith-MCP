/**
 * BMX (BM𝒳) — Entropy-Weighted Lexical Search Index for Hybrid Retrieval.
 *
 * Implements the BMX algorithm (arXiv:2408.06643, Li et al., August 2024),
 * a deterministic, CPU-only successor to BM25 that adds entropy-weighted
 * query-document similarity scoring atop a restructured TF-IDF core.
 */
import type { ToolDoc } from "../models.js";

interface TermData {
  docFreq: number;
  idf: number;
  entropy: number;
  totalFreq: number;
  postingListTFs: Map<string, number>;
  invertedIndex: Set<string>;
}

export class BMXIndex {
  // Optional parameter overrides
  alphaOverride?: number | undefined;
  betaOverride?: number | undefined;
  normalizeScores = false;

  // Internal state
  private _documents: Map<string, string[]> = new Map();
  private _docLengths: Map<string, number> = new Map();
  private _avgDocLength = 0.0;
  private _totalDocs = 0;
  private _isBuilt = false;

  // BMX-specific state
  private _alpha = 1.0;
  private _beta = 0.01;
  private _terms: Map<string, TermData> = new Map();
  private _dirtyTerms: Set<string> = new Set();

  private _getOrCreateTerm(term: string): TermData {
    let data = this._terms.get(term);
    if (!data) {
      data = {
        docFreq: 0,
        idf: 0,
        entropy: 0,
        totalFreq: 0,
        postingListTFs: new Map(),
        invertedIndex: new Set()
      };
      this._terms.set(term, data);
    }
    return data;
  }

  // BMXF field indexes
  private _fieldIndexes: Map<string, BMXIndex> = new Map();
  private _fieldWeights: Map<string, number> = new Map();

  constructor(opts?: {
    alphaOverride?: number | undefined;
    betaOverride?: number | undefined;
    normalizeScores?: boolean;
  }) {
    if (opts?.alphaOverride !== undefined) this.alphaOverride = opts.alphaOverride;
    if (opts?.betaOverride !== undefined) this.betaOverride = opts.betaOverride;
    if (opts?.normalizeScores !== undefined) this.normalizeScores = opts.normalizeScores;
  }

  // ─── Tokenization ────────────────────────────────────────────────────────

  private _tokenize(text: string): string[] {
    if (!text) return [];
    const lower = text.toLowerCase();
    const matches = lower.match(/[a-z0-9_]+/g) ?? [];
    return matches.filter((t) => t.length > 1 || t === "a" || t === "i");
  }

  // ─── Core math primitives ───────────────────────────────────────────────

  private static _sigmoid(x: number): number {
    if (x >= 500) return 1.0;
    if (x <= -500) return 0.0;
    return 1 / (1 + Math.exp(-x));
  }

  private static _shannonEntropy(probabilities: number[]): number {
    let h = 0;
    for (const p of probabilities) {
      if (0 < p && p < 1) h -= p * Math.log(p);
    }
    return h;
  }

  private _computeAlpha(): number {
    if (this.alphaOverride !== undefined) return this.alphaOverride;
    return Math.max(0.5, Math.min(1.5, this._avgDocLength / 100));
  }

  private _computeBeta(): number {
    if (this.betaOverride !== undefined) return this.betaOverride;
    if (this._totalDocs <= 0) return 0.0;
    return 1 / Math.log(1 + this._totalDocs);
  }

  // ─── Entropy computation ─────────────────────────────────────────────────

  private _computeTermEntropies(terms?: Set<string>): void {
    const targetTerms = terms ?? new Set(this._terms.keys());
    for (const term of targetTerms) {
      const data = this._terms.get(term);
      if (!data || data.docFreq <= 1 || data.totalFreq <= 0 || data.postingListTFs.size === 0) {
        if (data) data.entropy = 0.0;
        continue;
      }
      const probs = [...data.postingListTFs.values()].map((tf) => tf / data.totalFreq);
      const rawEntropy = BMXIndex._shannonEntropy(probs);
      const maxEntropy = Math.log(data.docFreq);
      data.entropy = maxEntropy > 0 ? rawEntropy / maxEntropy : 0.0;
    }
  }

  private _flushDirtyEntropies(queryTerms?: Set<string>): void {
    if (this._dirtyTerms.size === 0) return;
    const toFlush = queryTerms ? new Set([...this._dirtyTerms].filter((t) => queryTerms.has(t))) : new Set(this._dirtyTerms);
    if (toFlush.size > 0) {
      this._computeTermEntropies(toFlush);
      for (const t of toFlush) this._dirtyTerms.delete(t);
    }
  }

  private _getNormalizedEntropy(queryTokens: string[]): Map<string, number> {
    const uniqueTokens = [...new Set(queryTokens)];
    const rawInfo = new Map<string, number>();
    for (const t of uniqueTokens) {
      rawInfo.set(t, 1.0 - (this._terms.get(t)?.entropy ?? 1.0));
    }
    const maxInfo = Math.max(...rawInfo.values(), 0);
    if (maxInfo === 0) return new Map(uniqueTokens.map((t) => [t, 0.0]));
    return new Map([...rawInfo.entries()].map(([t, i]) => [t, i / maxInfo]));
  }

  private _resetIndexState(): void {
    this._documents.clear();
    this._docLengths.clear();
    this._terms.clear();
    this._totalDocs = 0;
    this._avgDocLength = 0.0;
    this._alpha = 1.0;
    this._beta = 0.01;
    this._isBuilt = false;
    this._dirtyTerms.clear();
    this._fieldIndexes.clear();
    this._fieldWeights.clear();
  }

  // ─── Index building ──────────────────────────────────────────────────────

  buildIndex(chunks: Array<{ chunk_id: string; text: string }>): void {
    this._resetIndexState();

    if (chunks.length === 0) {
      this._isBuilt = true;
      return;
    }

    let totalLength = 0;

    // Pass 1: tokenize, compute doc lengths
    for (const chunk of chunks) {
      const chunkId = chunk.chunk_id;
      if (!chunkId) continue;
      const tokens = this._tokenize(chunk.text ?? "");
      this._documents.set(chunkId, tokens);
      this._docLengths.set(chunkId, tokens.length);
      totalLength += tokens.length;
    }

    this._totalDocs = this._documents.size;
    if (this._totalDocs === 0) {
      this._isBuilt = true;
      return;
    }

    this._avgDocLength = totalLength / this._totalDocs;

    // Pass 2: document frequencies + posting list TFs + inverted index + total freqs
    for (const [chunkId, tokens] of this._documents.entries()) {
      const termCounts = new Map<string, number>();
      for (const t of tokens) termCounts.set(t, (termCounts.get(t) ?? 0) + 1);
      for (const [term, count] of termCounts) {
        const data = this._getOrCreateTerm(term);
        data.docFreq += 1;
        data.totalFreq += count;
        data.postingListTFs.set(chunkId, count);
        data.invertedIndex.add(chunkId);
      }
    }

    // Precompute IDF (Lucene variant)
    for (const [, data] of this._terms) {
      data.idf = Math.log(((this._totalDocs - data.docFreq + 0.5) / (data.docFreq + 0.5)) + 1.0);
    }

    // Precompute term entropies (full build)
    this._computeTermEntropies();

    // Compute dynamic parameters
    this._alpha = this._computeAlpha();
    this._beta = this._computeBeta();

    this._isBuilt = true;
  }

  // ─── Search ─────────────────────────────────────────────────────────────

  search(query: string, topK = 30, normalize?: boolean): Array<[string, number]> {
    if (!this._isBuilt) return [];
    if (!query) return [];

    const queryTokens = this._tokenize(query);
    if (queryTokens.length === 0) return [];

    const uniqueQuery = new Set(queryTokens);
    const m = queryTokens.length;

    this._flushDirtyEntropies(uniqueQuery);

    const normEntropy = this._getNormalizedEntropy(queryTokens);
    const eBar = queryTokens.reduce((acc, t) => acc + (normEntropy.get(t) ?? 0), 0) / m;

    const doNormalize = normalize ?? this.normalizeScores;

    // Collect candidate documents
    const candidateIds = new Set<string>();
    for (const token of uniqueQuery) {
      const posting = this._terms.get(token)?.invertedIndex;
      if (posting) for (const id of posting) candidateIds.add(id);
    }

    const scores = new Map<string, number>();
    for (const chunkId of candidateIds) {
      const docTokens = this._documents.get(chunkId)!;
      const score = this._scoreDocument(chunkId, docTokens, uniqueQuery, queryTokens, normEntropy, eBar, m);
      if (score > 0) scores.set(chunkId, score);
    }

    if (doNormalize && scores.size > 0) {
      const scoreMax = this._computeScoreMax(m);
      if (scoreMax > 0) {
        for (const [cid, s] of scores) scores.set(cid, s / scoreMax);
      }
    }

    return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK);
  }

  private _scoreDocument(
    chunkId: string,
    docTokens: string[],
    uniqueQuery: Set<string>,
    queryTokens: string[],
    normEntropy: Map<string, number>,
    eBar: number,
    m: number,
  ): number {
    const docLength = this._docLengths.get(chunkId) ?? 0;
    if (docLength === 0) return 0;

    const termFreqs = new Map<string, number>();
    for (const t of docTokens) termFreqs.set(t, (termFreqs.get(t) ?? 0) + 1);

    const uniqueDoc = new Set(docTokens);
    const overlap = [...uniqueQuery].filter((t) => uniqueDoc.has(t)).length;
    const sQd = overlap / m;

    const lenRatio = this._avgDocLength > 0 ? docLength / this._avgDocLength : 1;
    const K = this._alpha * (lenRatio + eBar);

    let score = 0;
    for (const token of queryTokens) {
      const tf = termFreqs.get(token) ?? 0;
      if (tf === 0) continue;

      const termData = this._terms.get(token);
      const idf = termData?.idf ?? 0;
      
      if (idf <= 0) {
        const eQi = normEntropy.get(token) ?? 0;
        score += this._beta * eQi * sQd;
        continue;
      }

      const tfSat = BMXIndex._sigmoid(this._alpha * (tf - K / 2) / Math.max(K, 0.01));
      const tfComponent = idf * tfSat;

      const eQi = Math.max(normEntropy.get(token) ?? 0, 0.1);
      const entropyComponent = this._beta * eQi * sQd;

      score += tfComponent + entropyComponent;
    }

    return score;
  }

  private _computeScoreMax(m: number): number {
    if (this._totalDocs <= 0 || m <= 0) return 1.0;
    const maxIdf = Math.log(1 + (this._totalDocs - 0.5) / 1.5);
    return m * (maxIdf + this._beta);
  }

  // ─── Incremental updates ───────────────────────────────────────────────

  updateIndex(chunkId: string, text: string): void {
    this.removeFromIndex(chunkId);

    const tokens = this._tokenize(text);
    if (tokens.length === 0) return;

    this._documents.set(chunkId, tokens);
    this._docLengths.set(chunkId, tokens.length);
    this._totalDocs++;

    const totalLength = [...this._docLengths.values()].reduce((a, b) => a + b, 0);
    this._avgDocLength = totalLength / this._totalDocs;

    const termCounts = new Map<string, number>();
    for (const t of tokens) termCounts.set(t, (termCounts.get(t) ?? 0) + 1);
    const affectedTerms = new Map<string, TermData>();

    for (const [term, count] of termCounts) {
      const data = this._getOrCreateTerm(term);
      data.docFreq += 1;
      data.totalFreq += count;
      data.postingListTFs.set(chunkId, count);
      data.invertedIndex.add(chunkId);
      affectedTerms.set(term, data);
    }

    for (const data of affectedTerms.values()) {
      data.idf = Math.log(((this._totalDocs - data.docFreq + 0.5) / (data.docFreq + 0.5)) + 1.0);
    }

    for (const t of affectedTerms.keys()) this._dirtyTerms.add(t);
    this._alpha = this._computeAlpha();
    this._beta = this._computeBeta();
    this._isBuilt = true;
  }

  removeFromIndex(chunkId: string): boolean {
    const tokens = this._documents.get(chunkId);
    if (tokens === undefined) return false;
    const termCounts = new Map<string, number>();
    for (const t of tokens) termCounts.set(t, (termCounts.get(t) ?? 0) + 1);

    this._documents.delete(chunkId);
    this._docLengths.delete(chunkId);
    this._totalDocs--;

    const totalLength = [...this._docLengths.values()].reduce((a, b) => a + b, 0);
    this._avgDocLength = this._totalDocs > 0 ? totalLength / this._totalDocs : 0;

    const affectedTerms = new Map<string, TermData>();
    for (const [term, count] of termCounts) {
      const data = this._terms.get(term);
      if (!data) continue;

      data.docFreq -= 1;
      data.totalFreq -= count;
      data.postingListTFs.delete(chunkId);
      data.invertedIndex.delete(chunkId);

      if (data.docFreq <= 0) {
        this._terms.delete(term);
      } else {
        affectedTerms.set(term, data);
      }
    }

    for (const data of affectedTerms.values()) {
      data.idf = Math.log(((this._totalDocs - data.docFreq + 0.5) / (data.docFreq + 0.5)) + 1.0);
    }
    for (const t of affectedTerms.keys()) this._dirtyTerms.add(t);
    this._alpha = this._computeAlpha();
    this._beta = this._computeBeta();

    return true;
  }

  // ─── Diagnostics ─────────────────────────────────────────────────────────

  getIndexStats(): {
    totalDocuments: number;
    uniqueTerms: number;
    avgDocLength: number;
    isBuilt: boolean;
    alpha: number;
    beta: number;
    alphaOverride: number | undefined;
    betaOverride: number | undefined;
    normalizeScores: boolean;
    avgEntropy: number;
  } {
    const entropies = [...this._terms.values()].map(t => t.entropy);
    return {
      totalDocuments: this._totalDocs,
      uniqueTerms: this._terms.size,
      avgDocLength: this._avgDocLength,
      isBuilt: this._isBuilt,
      alpha: this._alpha,
      beta: this._beta,
      alphaOverride: this.alphaOverride,
      betaOverride: this.betaOverride,
      normalizeScores: this.normalizeScores,
      avgEntropy: entropies.length > 0 ? entropies.reduce((a, b) => a + b, 0) / entropies.length : 0,
    };
  }

  clear(): void {
    this._resetIndexState();
    this._fieldIndexes.clear();
    this._fieldWeights.clear();
  }

  // ─── BMXF field-weighted wrapper ───────────────────────────────────────

  buildFieldIndex(toolDocs: ToolDoc[]): void {
    this._fieldIndexes.clear();
    this._fieldWeights = new Map([
      ["toolName", 3.0],
      ["namespace", 2.5],
      ["retrievalAliases", 1.5],
      ["description", 1.0],
      ["parameterNames", 0.5],
    ]);

    for (const fieldName of this._fieldWeights.keys()) {
      const fieldIdx = new BMXIndex({
        alphaOverride: this.alphaOverride,
        betaOverride: this.betaOverride,
        normalizeScores: this.normalizeScores,
      });
      const chunks = toolDocs.map((doc) => {
        const text = (doc as unknown as Record<string, unknown>)[fieldName] as string | undefined ?? "";
        return { chunk_id: doc.toolKey, text };
      });
      fieldIdx.buildIndex(chunks);
      this._fieldIndexes.set(fieldName, fieldIdx);
    }
  }

  searchFields(query: string, topK = 30): Array<[string, number]> {
    if (this._fieldIndexes.size === 0) return [];

    const combined = new Map<string, number>();
    for (const [fieldName, weight] of this._fieldWeights) {
      const fieldIdx = this._fieldIndexes.get(fieldName);
      if (!fieldIdx) continue;
      const results = fieldIdx.search(query, topK * 2);
      for (const [chunkId, score] of results) {
        combined.set(chunkId, (combined.get(chunkId) ?? 0) + weight * score);
      }
    }

    return [...combined.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK);
  }
}

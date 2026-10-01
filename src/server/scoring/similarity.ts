import { tokenize } from '../lib/text';

/**
 * Lightweight lexical-semantic similarity (TF-IDF cosine over stemmed tokens + bigrams).
 * It is deterministic, explainable, cheap and needs no external service. It is the default
 * implementation of the replaceable similarity layer; an embedding provider can be added
 * behind the same `SimilarityModel` interface without changing callers.
 */
export type TermVector = Map<string, number>;

export interface SimilarityModel {
  vector(text: string): TermVector;
  cosine(a: TermVector, b: TermVector): number;
  similarity(a: string, b: string): number;
}

export function termCounts(text: string, bigrams = true): TermVector {
  const toks = tokenize(text);
  const v: TermVector = new Map();
  for (let i = 0; i < toks.length; i++) {
    v.set(toks[i], (v.get(toks[i]) ?? 0) + 1);
    if (bigrams && i + 1 < toks.length) {
      const bg = `${toks[i]}_${toks[i + 1]}`;
      v.set(bg, (v.get(bg) ?? 0) + 1);
    }
  }
  return v;
}

export function cosine(a: TermVector, b: TermVector): number {
  if (!a.size || !b.size) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [, w] of a) na += w * w;
  for (const [, w] of b) nb += w * w;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const [t, w] of small) {
    const o = large.get(t);
    if (o) dot += w * o;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export class TfIdfModel implements SimilarityModel {
  private idf = new Map<string, number>();
  private defaultIdf: number;

  constructor(documents: string[] = []) {
    const df = new Map<string, number>();
    for (const doc of documents) {
      for (const t of new Set(termCounts(doc).keys())) df.set(t, (df.get(t) ?? 0) + 1);
    }
    const n = Math.max(1, documents.length);
    for (const [t, c] of df) this.idf.set(t, Math.log((n + 1) / (c + 1)) + 1);
    this.defaultIdf = Math.log(n + 1) + 1;
  }

  vector(text: string): TermVector {
    const tf = termCounts(text);
    const v: TermVector = new Map();
    for (const [t, c] of tf) v.set(t, (1 + Math.log(c)) * (this.idf.get(t) ?? this.defaultIdf));
    return v;
  }

  cosine(a: TermVector, b: TermVector): number {
    return cosine(a, b);
  }

  similarity(a: string, b: string): number {
    return cosine(this.vector(a), this.vector(b));
  }

  /** Terms contributing most to the overlap between two vectors (for explanations). */
  topSharedTerms(a: TermVector, b: TermVector, n = 6): string[] {
    const shared: [string, number][] = [];
    for (const [t, w] of a) {
      const o = b.get(t);
      if (o && !t.includes('_')) shared.push([t, w * o]);
    }
    return shared
      .sort((x, y) => y[1] - x[1])
      .slice(0, n)
      .map(([t]) => t);
  }
}

export function jaccard(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

export const plainSimilarity: SimilarityModel = new TfIdfModel();

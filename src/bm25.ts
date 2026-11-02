/**
 * BM25 over mixed Chinese/English text with no dependencies.
 *
 * ReMe's default configuration is BM25 (its `search` job works without an
 * embedding model). Python uses jieba to segment Chinese; here CJK runs are
 * indexed as character bigrams, which is the standard dependency-free
 * substitute and behaves well for short queries.
 */

const K1 = 1.2;
const B = 0.75;

export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  const latin = lower.match(/[a-z0-9_]+/g);
  if (latin) tokens.push(...latin);
  const cjk = lower.match(/[㐀-鿿぀-ヿ]+/g);
  if (cjk) {
    for (const run of cjk) {
      if (run.length === 1) {
        tokens.push(run);
        continue;
      }
      for (let i = 0; i < run.length - 1; i += 1) tokens.push(run.slice(i, i + 2));
    }
  }
  return tokens;
}

export interface Document {
  id: number;
  text: string;
  meta: Record<string, unknown>;
}

export interface Hit {
  doc: Document;
  score: number;
}

export interface SearchOptions {
  limit?: number;
  minScore?: number;
}

export class BM25 {
  docs: Document[] = [];
  termFreqs: Map<string, number>[] = [];
  lengths: number[] = [];
  docFreqs: Map<string, number> = new Map();
  totalLength = 0;
  dirty = true;
  idfCache: Map<string, number> = new Map();
  #live = 0;

  add(doc: Omit<Document, "id">): number {
    const id = this.docs.length;
    const tokens = tokenize(doc.text);
    const tf = new Map<string, number>();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    this.docs.push({ ...doc, id });
    this.termFreqs.push(tf);
    this.lengths.push(tokens.length);
    this.totalLength += tokens.length;
    this.#live += 1;
    for (const term of tf.keys()) {
      this.docFreqs.set(term, (this.docFreqs.get(term) ?? 0) + 1);
    }
    this.dirty = true;
    return id;
  }

  /**
   * Tombstone one document. Ids of the survivors stay stable, so stored
   * references (this store's chunk list) survive a per-file reindex.
   */
  remove(id: number): boolean {
    const doc = this.docs[id];
    if (!doc) return false;
    const tf = this.termFreqs[id] ?? new Map<string, number>();
    for (const [term, count] of tf) {
      const df = this.docFreqs.get(term);
      if (df === undefined) continue;
      const next = df - count;
      if (next > 0) this.docFreqs.set(term, next);
      else this.docFreqs.delete(term);
      this.idfCache.delete(term);
    }
    this.totalLength -= this.lengths[id] ?? 0;
    this.#live -= 1;
    this.docs[id] = undefined as unknown as Document;
    this.termFreqs[id] = new Map();
    this.lengths[id] = 0;
    this.dirty = true;
    return true;
  }

  get size(): number {
    return this.#live;
  }

  get averageLength(): number {
    return this.size === 0 ? 0 : this.totalLength / this.size;
  }

  idf(term: string): number {
    const cached = this.idfCache.get(term);
    if (cached !== undefined) return cached;
    const df = this.docFreqs.get(term) ?? 0;
    const idf = Math.log(1 + (this.size - df + 0.5) / (df + 0.5));
    this.idfCache.set(term, idf);
    return idf;
  }

  search(query: string, options: SearchOptions = {}): Hit[] {
    const limit = options.limit ?? 5;
    const minScore = options.minScore ?? 0;
    const terms = tokenize(query);
    if (terms.length === 0 || this.size === 0) return [];
    const avgdl = this.averageLength || 1;
    // Tombstoned ids stay in the array, so the loop bound is the physical
    // length, not the live count.
    const scores: number[] = new Array(this.docs.length).fill(0);
    // Repeated query terms should not multiply the score, but they do raise
    // the weight of the concept, so count them.
    const queryTf = new Map<string, number>();
    for (const term of terms) queryTf.set(term, (queryTf.get(term) ?? 0) + 1);

    for (const [term, qtf] of queryTf) {
      const df = this.docFreqs.get(term) ?? 0;
      if (df === 0) continue;
      const idf = this.idf(term);
      for (let i = 0; i < this.docs.length; i += 1) {
        const tf = this.termFreqs[i]?.get(term);
        if (!tf) continue;
        const norm = tf * (K1 + 1);
        const denom = tf + K1 * (1 - B + (B * (this.lengths[i] ?? 0)) / avgdl);
        scores[i] = (scores[i] ?? 0) + (idf * norm * qtf) / denom;
      }
    }

    const hits: Hit[] = [];
    for (let i = 0; i < this.docs.length; i += 1) {
      const doc = this.docs[i];
      const score = scores[i] ?? 0;
      if (doc && score > minScore) hits.push({ doc, score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }
}

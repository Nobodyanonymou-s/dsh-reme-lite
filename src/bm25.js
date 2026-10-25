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

/**
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const lower = text.toLowerCase();
  /** @type {string[]} */
  const tokens = [];
  const latin = lower.match(/[a-z0-9_]+/g);
  if (latin) tokens.push(...latin);
  const cjk = lower.match(/[\u3400-\u9fff\u3040-\u30ff]+/g);
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

/**
 * @typedef {{ id: number, text: string, meta: Record<string, unknown> }} Document
 * @typedef {{ doc: Document, score: number }} Hit
 */

export class BM25 {
  constructor() {
    /** @type {Document[]} */
    this.docs = [];
    /** @type {Map<string, number>[]} */
    this.termFreqs = [];
    /** @type {number[]} */
    this.lengths = [];
    /** @type {Map<string, number>} */
    this.docFreqs = new Map();
    this.totalLength = 0;
    this.dirty = true;
    /** @type {Map<string, number>} */
    this.idfCache = new Map();
  }

  /** @param {Omit<Document, "id">} doc */
  add(doc) {
    const id = this.docs.length;
    const tokens = tokenize(doc.text);
    /** @type {Map<string, number>} */
    const tf = new Map();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    this.docs.push({ ...doc, id });
    this.termFreqs.push(tf);
    this.lengths.push(tokens.length);
    this.totalLength += tokens.length;
    for (const term of tf.keys()) {
      this.docFreqs.set(term, (this.docFreqs.get(term) ?? 0) + 1);
    }
    this.dirty = true;
    return id;
  }

  get size() {
    return this.docs.length;
  }

  get averageLength() {
    return this.size === 0 ? 0 : this.totalLength / this.size;
  }

  /** @param {string} term */
  idf(term) {
    const cached = this.idfCache.get(term);
    if (cached !== undefined) return cached;
    const df = this.docFreqs.get(term) ?? 0;
    const idf = Math.log(1 + (this.size - df + 0.5) / (df + 0.5));
    this.idfCache.set(term, idf);
    return idf;
  }

  /**
   * @param {string} query
   * @param {{ limit?: number, minScore?: number }} [options]
   * @returns {Hit[]}
   */
  search(query, options = {}) {
    const limit = options.limit ?? 5;
    const minScore = options.minScore ?? 0;
    const terms = tokenize(query);
    if (terms.length === 0 || this.size === 0) return [];
    const avgdl = this.averageLength || 1;
    /** @type {number[]} */
    const scores = new Array(this.size).fill(0);
    // Repeated query terms should not multiply the score, but they do raise
    // the weight of the concept, so count them.
    /** @type {Map<string, number>} */
    const queryTf = new Map();
    for (const term of terms) queryTf.set(term, (queryTf.get(term) ?? 0) + 1);

    for (const [term, qtf] of queryTf) {
      const df = this.docFreqs.get(term) ?? 0;
      if (df === 0) continue;
      const idf = this.idf(term);
      for (let i = 0; i < this.size; i += 1) {
        const tf = this.termFreqs[i].get(term);
        if (!tf) continue;
        const norm = tf * (K1 + 1);
        const denom = tf + K1 * (1 - B + (B * this.lengths[i]) / avgdl);
        scores[i] += (idf * norm * qtf) / denom;
      }
    }

    /** @type {Hit[]} */
    const hits = [];
    for (let i = 0; i < this.size; i += 1) {
      if (scores[i] > minScore) hits.push({ doc: this.docs[i], score: scores[i] });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }
}

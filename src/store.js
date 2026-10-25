/**
 * Workspace-backed memory store.
 *
 * Layout (same shape as ReMe's, minus what we do not implement):
 *
 *   <root>/
 *   ├── daily/YYYY-MM-DD.md      # lightly processed notes (auto block + human text)
 *   ├── digest/personal|procedure|wiki/*.md   # durable knowledge
 *   ├── session/dialog/*.jsonl   # raw source records (never indexed)
 *   └── metadata/                # derived; safe to delete
 *
 * Only `daily/` and `digest/` are indexed, exactly like ReMe: the raw session
 * records and the derived index stay out of retrieval.
 */

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, resolve, sep } from "node:path";

import { BM25 } from "./bm25.js";
import { chunkMarkdown, extractWikilinks, linkKey } from "./markdown.js";

/** @typedef {{ relPath: string, startLine: number, endLine: number, heading: string, text: string, score: number, via?: string }} SearchHit */

export const INDEXED_DIRS = ["daily", "digest"];

export class MemoryStore {
  /**
   * @param {{ root: string, maxChars?: number }} options
   */
  constructor(options) {
    this.root = resolve(options.root);
    this.maxChars = options.maxChars ?? 900;
    /** @type {{ relPath: string, mtimeMs: number, chunks: import("./markdown.js").Chunk[] }[]} */
    this.files = [];
    /** @type {import("./bm25.js").Document[]} */
    this.chunks = [];
    /** @type {Map<string, string>} */
    this.byKey = new Map();
    this.index = new BM25();
    this.builtAt = 0;
  }

  get indexPath() {
    return join(this.root, "metadata", "index.json");
  }

  async ensureLayout() {
    await mkdir(join(this.root, "daily"), { recursive: true });
    await mkdir(join(this.root, "digest"), { recursive: true });
    await mkdir(join(this.root, "session", "dialog"), { recursive: true });
    await mkdir(join(this.root, "metadata"), { recursive: true });
  }

  /**
   * Resolve a user-supplied relative path inside the workspace, refusing
   * escapes.
   * @param {string} relPath
   * @returns {string}
   */
  resolveInside(relPath) {
    const cleaned = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
    const absolute = resolve(this.root, cleaned);
    const rel = relative(this.root, absolute);
    if (rel === "" || rel.startsWith("..") || rel.includes(`..${sep}`)) {
      throw new Error(`path escapes memory workspace: ${relPath}`);
    }
    return absolute;
  }

  /**
   * Rebuild the in-memory index from Markdown on disk. Unchanged files are
   * re-chunked only when their mtime moved.
   * @returns {Promise<{ files: number, chunks: number }>}
   */
  async rebuild() {
    await this.ensureLayout();
    /** @type {typeof this.files} */
    const next = [];
    for (const dir of INDEXED_DIRS) {
      const found = await this.#walk(join(this.root, dir));
      for (const absolute of found) {
        const info = await stat(absolute);
        const relPath = relative(this.root, absolute).split(sep).join(posix.sep);
        const previous = this.files.find((f) => f.relPath === relPath);
        if (previous && previous.mtimeMs === info.mtimeMs) {
          next.push(previous);
          continue;
        }
        const text = await readFile(absolute, "utf8");
        next.push({
          relPath,
          mtimeMs: info.mtimeMs,
          chunks: chunkMarkdown(text, { maxChars: this.maxChars }),
        });
      }
    }
    this.files = next;
    this.chunks = [];
    this.byKey = new Map();
    this.index = new BM25();
    for (const file of this.files) {
      this.byKey.set(linkKey(file.relPath), file.relPath);
      this.byKey.set(linkKey(posix.basename(file.relPath)), file.relPath);
      for (const chunk of file.chunks) {
        const id = this.index.add({
          text: `${chunk.heading}\n${chunk.text}`,
          meta: { relPath: file.relPath, chunk },
        });
        this.chunks.push({ id, relPath: file.relPath, chunk });
      }
    }
    this.builtAt = Date.now();
    await this.#writeManifest();
    return { files: this.files.length, chunks: this.chunks.length };
  }

  /**
   * @param {string} dir
   * @returns {Promise<string[]>}
   */
  async #walk(dir) {
    /** @type {string[]} */
    const out = [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await this.#walk(absolute)));
      } else if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) {
        out.push(absolute);
      }
    }
    return out;
  }

  async #writeManifest() {
    const manifest = {
      builtAt: this.builtAt,
      files: this.files.map((f) => ({ path: f.relPath, chunks: f.chunks.length })),
    };
    try {
      await writeFile(this.indexPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    } catch {
      // The manifest is diagnostic only; never fail a search over it.
    }
  }

  /**
   * @param {string} query
   * @param {{ limit?: number, minScore?: number, expandLinks?: boolean }} [options]
   * @returns {SearchHit[]}
   */
  search(query, options = {}) {
    const limit = Math.min(Math.max(options.limit ?? 5, 1), 50);
    const minScore = Math.max(0, options.minScore ?? 0);
    const expandLinks = options.expandLinks ?? true;
    const hits = this.index.search(query, { limit: Math.max(limit * 3, 12), minScore });
    /** @type {SearchHit[]} */
    const results = hits.map((hit) => {
      const meta = /** @type {{ relPath: string, chunk: import("./markdown.js").Chunk }} */ (
        hit.doc.meta
      );
      return {
        relPath: meta.relPath,
        startLine: meta.chunk.startLine,
        endLine: meta.chunk.endLine,
        heading: meta.chunk.heading,
        text: meta.chunk.text,
        score: hit.score,
      };
    });

    if (expandLinks) results.push(...this.#expandLinks(results));

    /** @type {Map<string, SearchHit>} */
    const deduped = new Map();
    for (const hit of results) {
      const key = `${hit.relPath}:${hit.startLine}`;
      const existing = deduped.get(key);
      if (!existing || existing.score < hit.score) deduped.set(key, hit);
    }
    return [...deduped.values()]
      .filter((hit) => hit.score > minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * One-hop wikilink neighbours of the direct hits, at a discount. This is
   * ReMe's "bounded link expansion": it lets a query reach a note you never
   * mentioned, without dragging in the whole graph.
   * @param {SearchHit[]} hits
   * @returns {SearchHit[]}
   */
  #expandLinks(hits) {
    /** @type {SearchHit[]} */
    const extra = [];
    const seen = new Set(hits.map((hit) => hit.relPath));
    for (const hit of hits.slice(0, 3)) {
      for (const target of extractWikilinks(hit.text)) {
        const resolved = this.byKey.get(linkKey(target));
        if (!resolved || seen.has(resolved)) continue;
        seen.add(resolved);
        const file = this.files.find((f) => f.relPath === resolved);
        if (!file) continue;
        for (const chunk of file.chunks.slice(0, 2)) {
          extra.push({
            relPath: resolved,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            heading: chunk.heading,
            text: chunk.text,
            score: hit.score * 0.4,
            via: hit.relPath,
          });
        }
      }
    }
    return extra;
  }

  /**
   * Write a memory node and reindex.
   * @param {{ relPath: string, content: string }} input
   * @returns {Promise<{ relPath: string, bytes: number }>}
   */
  async write(input) {
    const relPath = input.relPath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!/\.(md|markdown)$/i.test(relPath)) {
      throw new Error(`memory nodes must be .md: ${relPath}`);
    }
    const absolute = this.resolveInside(relPath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, input.content, "utf8");
    await this.rebuild();
    return { relPath, bytes: Buffer.byteLength(input.content, "utf8") };
  }

  /**
   * @param {string} relPath
   * @returns {Promise<string>}
   */
  async read(relPath) {
    return readFile(this.resolveInside(relPath), "utf8");
  }

  /** @param {number} [limit] */
  async recentDaily(limit = 7) {
    const files = this.files
      .filter((file) => file.relPath.startsWith("daily/"))
      .sort((a, b) => (a.relPath < b.relPath ? 1 : -1));
    return files.slice(0, limit).map((file) => file.relPath);
  }

  digestTitles() {
    return this.files
      .filter((file) => file.relPath.startsWith("digest/"))
      .map((file) => file.relPath);
  }

  stats() {
    /** @type {Record<string, number>} */
    const byDir = {};
    for (const file of this.files) {
      const dir = file.relPath.split("/")[0];
      byDir[dir] = (byDir[dir] ?? 0) + file.chunks.length;
    }
    return {
      root: this.root,
      files: this.files.length,
      chunks: this.index.size,
      byDir,
      builtAt: new Date(this.builtAt).toISOString(),
    };
  }
}

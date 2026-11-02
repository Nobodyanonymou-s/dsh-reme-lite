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

import { PathLocks, atomicWriteFile } from "./atomic.ts";
import { BM25 } from "./bm25.ts";
import { chunkMarkdown, extractWikilinks, linkKey, parseFrontmatter } from "./markdown.ts";
import type { Chunk } from "./markdown.ts";
import { isSuperseded, parseScope, visibleTo } from "./scope.ts";
import type { ScopeMeta, ScopeMode } from "./scope.ts";

export interface SearchHit {
  relPath: string;
  startLine: number;
  endLine: number;
  heading: string;
  text: string;
  score: number;
  via?: string;
}

export const INDEXED_DIRS = ["daily", "digest"];

interface IndexedFile {
  relPath: string;
  mtimeMs: number;
  chunks: Chunk[];
  meta: ScopeMeta;
}

interface IndexedChunk {
  id: number;
  relPath: string;
  chunk: Chunk;
}

export interface ChunkMeta {
  relPath: string;
  chunk: Chunk;
}

export interface SearchScope {
  /** Identity of the searching agent; private nodes stay with their writer. */
  viewer: string;
  /** `mine` (default): my nodes plus the team layer. `team`: everything. */
  mode: ScopeMode;
}

export interface SearchOptions {
  limit?: number;
  minScore?: number;
  expandLinks?: boolean;
  scope?: SearchScope;
  /** Exact room filter; a node with no room matches every room query. */
  room?: string;
  /**
   * Nodes marked `status: superseded` / `retired` are history, not current
   * truth, and stay out of retrieval in every scope; this flag is how a caller
   * asks for the trail explicitly (auditing a correction).
   */
  includeSuperseded?: boolean;
}

export class MemoryStore {
  root: string;
  maxChars: number;
  files: IndexedFile[] = [];
  chunks: IndexedChunk[] = [];
  byKey: Map<string, string> = new Map();
  index = new BM25();
  builtAt = 0;
  #locks: PathLocks;
  /** Serializes every index mutation (full rebuild and per-file reindex alike). */
  #mutations: Promise<unknown> = Promise.resolve();
  lastRebuildMs: number | null = null;

  constructor(options: { root: string; maxChars?: number; locks?: PathLocks }) {
    this.root = resolve(options.root);
    this.maxChars = options.maxChars ?? 900;
    this.#locks = options.locks ?? new PathLocks();
  }

  get indexPath(): string {
    return join(this.root, "metadata", "index.json");
  }

  async ensureLayout(): Promise<void> {
    await mkdir(join(this.root, "daily"), { recursive: true });
    await mkdir(join(this.root, "digest"), { recursive: true });
    await mkdir(join(this.root, "session", "dialog"), { recursive: true });
    await mkdir(join(this.root, "metadata"), { recursive: true });
  }

  /**
   * Resolve a user-supplied relative path inside the workspace, refusing
   * escapes.
   */
  resolveInside(relPath: string): string {
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
   */
  rebuild(): Promise<{ files: number; chunks: number }> {
    return this.#serialize(() => this.#rebuildInner());
  }

  async #rebuildInner(): Promise<{ files: number; chunks: number }> {
    const startedAt = Date.now();
    await this.ensureLayout();
    const next: IndexedFile[] = [];
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
        next.push(await this.#loadFile(relPath, absolute, info.mtimeMs));
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
          meta: { relPath: file.relPath, chunk } satisfies ChunkMeta,
        });
        this.chunks.push({ id, relPath: file.relPath, chunk });
      }
    }
    this.builtAt = Date.now();
    this.lastRebuildMs = Date.now() - startedAt;
    await this.#writeManifest();
    return { files: this.files.length, chunks: this.chunks.length };
  }

  async #loadFile(relPath: string, absolute: string, mtimeMs: number): Promise<IndexedFile> {
    const text = await readFile(absolute, "utf8");
    const { data } = parseFrontmatter(text);
    return {
      relPath,
      mtimeMs,
      chunks: chunkMarkdown(text, { maxChars: this.maxChars }),
      meta: parseScope(data),
    };
  }

  /**
   * Bring one file's index entries in line with disk: re-chunk only that file,
   * tombstone its old BM25 documents, add the new ones. This is what a write
   * needs — a full-directory walk per saved node does not scale to a shared
   * team workspace, and it widens the window where two writers interleave.
   *
   * `force` is set by our own writes: two writes inside one filesystem mtime
   * tick report identical mtimes, and the skip-if-unchanged check would then
   * leave the index holding the replaced text.
   */
  async #reindexPath(relPath: string, force = false): Promise<void> {
    const absolute = resolve(this.root, relPath);
    const info = await stat(absolute).catch(() => null);
    const previous = this.files.find((f) => f.relPath === relPath);
    if (!force && previous && info && previous.mtimeMs === info.mtimeMs) return;

    // Drop the old entries first — chunks, BM25 documents, and both link keys.
    if (previous) {
      this.byKey.delete(linkKey(previous.relPath));
      this.byKey.delete(linkKey(posix.basename(previous.relPath)));
      this.chunks = this.chunks.filter((entry) => entry.relPath !== relPath);
      // A bare filename key may legitimately belong to another file once this
      // one is gone; the next full rebuild re-derives the whole key map.
      for (let id = 0; id < this.index.docs.length; id += 1) {
        const doc = this.index.docs[id];
        if (doc && (doc.meta as unknown as ChunkMeta).relPath === relPath) this.index.remove(id);
      }
      this.files = this.files.filter((f) => f.relPath !== relPath);
    }

    if (!info) return; // deleted on disk: removal above is the whole update

    const loaded = await this.#loadFile(relPath, absolute, info.mtimeMs);
    this.files.push(loaded);
    this.byKey.set(linkKey(loaded.relPath), loaded.relPath);
    this.byKey.set(linkKey(posix.basename(loaded.relPath)), loaded.relPath);
    for (const chunk of loaded.chunks) {
      const id = this.index.add({
        text: `${chunk.heading}\n${chunk.text}`,
        meta: { relPath: loaded.relPath, chunk } satisfies ChunkMeta,
      });
      this.chunks.push({ id, relPath: loaded.relPath, chunk });
    }
    this.builtAt = Date.now();
    await this.#writeManifest();
  }

  /** All index mutations run one at a time; reads stay unsynchronized. */
  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#mutations.then(operation, operation);
    this.#mutations = next.catch(() => {});
    return next;
  }

  async #walk(dir: string): Promise<string[]> {
    const out: string[] = [];
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

  async #writeManifest(): Promise<void> {
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

  search(query: string, options: SearchOptions = {}): SearchHit[] {
    const limit = Math.min(Math.max(options.limit ?? 5, 1), 50);
    const minScore = Math.max(0, options.minScore ?? 0);
    const expandLinks = options.expandLinks ?? true;
    const viewer = options.scope?.viewer ?? "";
    const mode = options.scope?.mode ?? "mine";
    const includeSuperseded = options.includeSuperseded ?? false;
    const retrievable = (relPath: string): boolean => {
      const file = this.files.find((f) => f.relPath === relPath);
      if (!file) return false;
      // Corrections must not answer with the claim they just replaced, in any
      // scope: a superseded node is history. Link expansion uses this same
      // predicate, so a superseded neighbour does not expand either.
      if (!includeSuperseded && isSuperseded(file.meta)) return false;
      if (!visibleTo(file.meta, viewer, mode)) return false;
      // An unlabelled room means "the whole team", so it matches every query;
      // a labelled node matches only its own room.
      if (options.room !== undefined && file.meta.room !== undefined && file.meta.room !== options.room) {
        return false;
      }
      return true;
    };
    const hits = this.index.search(query, { limit: Math.max(limit * 3, 12), minScore });
    const results: SearchHit[] = hits
      .map((hit) => {
        const meta = hit.doc.meta as unknown as ChunkMeta;
        return {
          relPath: meta.relPath,
          startLine: meta.chunk.startLine,
          endLine: meta.chunk.endLine,
          heading: meta.chunk.heading,
          text: meta.chunk.text,
          score: hit.score,
        };
      })
      .filter((hit) => retrievable(hit.relPath));

    if (expandLinks) results.push(...this.#expandLinks(results, retrievable));

    const deduped = new Map<string, SearchHit>();
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
   * mentioned, without dragging in the whole graph. Neighbours the caller
   * cannot see under the active scope are not expanded — a link must not leak
   * what the filter just hid.
   */
  #expandLinks(hits: SearchHit[], retrievable: (relPath: string) => boolean): SearchHit[] {
    const extra: SearchHit[] = [];
    const seen = new Set(hits.map((hit) => hit.relPath));
    for (const hit of hits.slice(0, 3)) {
      for (const target of extractWikilinks(hit.text)) {
        const resolved = this.byKey.get(linkKey(target));
        if (!resolved || seen.has(resolved)) continue;
        if (!retrievable(resolved)) continue;
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
   * Write a memory node: serialized per path, renamed into place atomically,
   * then reindexed incrementally — only this file's entries move.
   *
   * `beforeWrite` sees the text being replaced, inside the same per-path lock
   * the replacement runs under. Callers that need the overwritten content
   * (the conflict log takes an excerpt of it) use it instead of reading first
   * on their own: a read outside the lock can race another writer and record
   * an "old value" that was never on disk.
   */
  async write(input: {
    relPath: string;
    content: string;
    beforeWrite?: (existing: string | null) => Promise<void> | void;
  }): Promise<{ relPath: string; bytes: number }> {
    const relPath = input.relPath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!/\.(md|markdown)$/i.test(relPath)) {
      throw new Error(`memory nodes must be .md: ${relPath}`);
    }
    const absolute = this.resolveInside(relPath);
    return this.#locks.run(absolute, async () => {
      if (input.beforeWrite) {
        const existing = await readFile(absolute, "utf8").catch(() => null);
        await input.beforeWrite(existing);
      }
      await mkdir(dirname(absolute), { recursive: true });
      await atomicWriteFile(absolute, input.content);
      await this.#serialize(() => this.#reindexPath(relPath, true));
      return { relPath, bytes: Buffer.byteLength(input.content, "utf8") };
    });
  }

  async read(relPath: string): Promise<string> {
    return readFile(this.resolveInside(relPath), "utf8");
  }

  /**
   * Rewrite a node in place through the same machinery as `write` — per-path
   * lock, atomic rename, forced reindex of just this file. Built for the
   * metadata-only edit a correction needs (marking the old node superseded),
   * where the body must survive untouched: `transform` receives the text on
   * disk and returns the next one, so no caller has to read outside the lock
   * and risk writing back over a concurrent change. A missing node throws.
   */
  async rewrite(relPath: string, transform: (text: string) => string): Promise<{ relPath: string; bytes: number }> {
    const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!/\.(md|markdown)$/i.test(normalized)) {
      throw new Error(`memory nodes must be .md: ${normalized}`);
    }
    const absolute = this.resolveInside(normalized);
    return this.#locks.run(absolute, async () => {
      const current = await readFile(absolute, "utf8");
      const next = transform(current);
      await atomicWriteFile(absolute, next);
      await this.#serialize(() => this.#reindexPath(normalized, true));
      return { relPath: normalized, bytes: Buffer.byteLength(next, "utf8") };
    });
  }

  async recentDaily(limit = 7): Promise<string[]> {
    const files = this.files
      .filter((file) => file.relPath.startsWith("daily/"))
      .sort((a, b) => (a.relPath < b.relPath ? 1 : -1));
    return files.slice(0, limit).map((file) => file.relPath);
  }

  digestTitles(): string[] {
    return this.files
      .filter((file) => file.relPath.startsWith("digest/"))
      .map((file) => file.relPath);
  }

  stats(): {
    root: string;
    files: number;
    chunks: number;
    byDir: Record<string, number>;
    builtAt: string;
    lastRebuildMs: number | null;
  } {
    const byDir: Record<string, number> = {};
    for (const file of this.files) {
      const dir = file.relPath.split("/")[0] ?? "";
      byDir[dir] = (byDir[dir] ?? 0) + file.chunks.length;
    }
    return {
      root: this.root,
      files: this.files.length,
      chunks: this.index.size,
      byDir,
      builtAt: new Date(this.builtAt).toISOString(),
      lastRebuildMs: this.lastRebuildMs,
    };
  }
}

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

import { BM25 } from "./bm25.ts";
import { chunkMarkdown, extractWikilinks, linkKey } from "./markdown.ts";
import type { Chunk } from "./markdown.ts";

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

export interface SearchOptions {
  limit?: number;
  minScore?: number;
  expandLinks?: boolean;
}

export class MemoryStore {
  root: string;
  maxChars: number;
  files: IndexedFile[] = [];
  chunks: IndexedChunk[] = [];
  byKey: Map<string, string> = new Map();
  index = new BM25();
  builtAt = 0;

  constructor(options: { root: string; maxChars?: number }) {
    this.root = resolve(options.root);
    this.maxChars = options.maxChars ?? 900;
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
  async rebuild(): Promise<{ files: number; chunks: number }> {
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
          meta: { relPath: file.relPath, chunk } satisfies ChunkMeta,
        });
        this.chunks.push({ id, relPath: file.relPath, chunk });
      }
    }
    this.builtAt = Date.now();
    await this.#writeManifest();
    return { files: this.files.length, chunks: this.chunks.length };
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
    const hits = this.index.search(query, { limit: Math.max(limit * 3, 12), minScore });
    const results: SearchHit[] = hits.map((hit) => {
      const meta = hit.doc.meta as unknown as ChunkMeta;
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
   * mentioned, without dragging in the whole graph.
   */
  #expandLinks(hits: SearchHit[]): SearchHit[] {
    const extra: SearchHit[] = [];
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
   */
  async write(input: { relPath: string; content: string }): Promise<{ relPath: string; bytes: number }> {
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

  async read(relPath: string): Promise<string> {
    return readFile(this.resolveInside(relPath), "utf8");
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

  stats(): { root: string; files: number; chunks: number; byDir: Record<string, number>; builtAt: string } {
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
    };
  }
}

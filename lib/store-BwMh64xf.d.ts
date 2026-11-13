/**
 * Per-path serialization. The stored chain never rejects: a failed operation
 * must not poison the writes queued behind it. The map entry is dropped when
 * the chain goes idle, so a long-lived process does not accumulate one entry
 * per file ever written.
 */
declare class PathLocks {
  #private;
  run<T>(absolute: string, operation: () => Promise<T>): Promise<T>;
}
interface Document {
  id: number;
  text: string;
  meta: Record<string, unknown>;
}
interface Hit {
  doc: Document;
  score: number;
}
interface SearchOptions$1 {
  limit?: number;
  minScore?: number;
}
declare class BM25 {
  #private;
  docs: Document[];
  termFreqs: Map<string, number>[];
  lengths: number[];
  docFreqs: Map<string, number>;
  totalLength: number;
  dirty: boolean;
  idfCache: Map<string, number>;
  add(doc: Omit<Document, "id">): number;
  /**
   * Tombstone one document. Ids of the survivors stay stable, so stored
   * references (this store's chunk list) survive a per-file reindex.
   */
  remove(id: number): boolean;
  get size(): number;
  get averageLength(): number;
  idf(term: string): number;
  search(query: string, options?: SearchOptions$1): Hit[];
}
interface Chunk {
  heading: string;
  startLine: number;
  endLine: number;
  text: string;
}
/**
 * Ownership and visibility for a workspace more than one agent reads.
 *
 * Every node the plugin writes carries provenance frontmatter:
 *
 *   agent:       who wrote it (preset id or session short id)
 *   session:     which session it came from
 *   room:        optional team-room label; empty means "the whole team"
 *   visibility:  only written when "private" — absent means team-shared
 *
 * The layering is deliberately two-tier, not per-agent ACL:
 *
 *   team layer   no `visibility` field (digest knowledge, auto-captured daily
 *                pages, anything written before agents existed) — everyone
 *                reads it in every scope.
 *   private      `visibility: private` — the writer's tentative judgment,
 *                visible to the writer in the default scope and to everyone
 *                only under `scope=team` (an audit view, not a wall).
 *
 * The failure this prevents: one agent's working guess read by another agent
 * as an established fact. Private is the default for `daily/` writes; `digest/`
 * writes are the team layer by default. `memory_write` can override either.
 */
type ScopeMode = "mine" | "team";
interface ScopeMeta {
  agent?: string;
  session?: string;
  room?: string;
  visibility?: string;
}
interface SearchHit {
  relPath: string;
  startLine: number;
  endLine: number;
  heading: string;
  text: string;
  score: number;
  via?: string;
}
declare const INDEXED_DIRS: string[];
interface IndexedFile {
  relPath: string;
  mtimeMs: number;
  chunks: Chunk[];
  meta: ScopeMeta;
  /** Parsed frontmatter: the link graph and the index page read name/description/updated. */
  front: Record<string, string>;
}
interface IndexedChunk {
  id: number;
  relPath: string;
  chunk: Chunk;
}
interface ChunkMeta {
  relPath: string;
  chunk: Chunk;
}
interface SearchScope {
  /** Identity of the searching agent; private nodes stay with their writer. */
  viewer: string;
  /** `mine` (default): my nodes plus the team layer. `team`: everything. */
  mode: ScopeMode;
}
interface SearchOptions {
  limit?: number;
  minScore?: number;
  expandLinks?: boolean;
  scope?: SearchScope;
  /** Exact room filter; a node with no room matches every room query. */
  room?: string;
}
declare class MemoryStore {
  #private;
  root: string;
  maxChars: number;
  files: IndexedFile[];
  chunks: IndexedChunk[];
  byKey: Map<string, string>;
  index: BM25;
  builtAt: number;
  lastRebuildMs: number | null;
  constructor(options: {
    root: string;
    maxChars?: number;
    locks?: PathLocks;
  });
  get indexPath(): string;
  ensureLayout(): Promise<void>;
  /**
   * Resolve a user-supplied relative path inside the workspace, refusing
   * escapes.
   */
  resolveInside(relPath: string): string;
  /**
   * Rebuild the in-memory index from Markdown on disk. Unchanged files are
   * re-chunked only when their mtime moved.
   */
  rebuild(): Promise<{
    files: number;
    chunks: number;
  }>;
  search(query: string, options?: SearchOptions): SearchHit[];
  /**
   * Write a memory node: serialized per path, renamed into place atomically,
   * then reindexed incrementally — only this file's entries move.
   */
  write(input: {
    relPath: string;
    content: string;
  }): Promise<{
    relPath: string;
    bytes: number;
  }>;
  read(relPath: string): Promise<string>;
  recentDaily(limit?: number): Promise<string[]>;
  digestTitles(): string[];
  stats(): {
    root: string;
    files: number;
    chunks: number;
    byDir: Record<string, number>;
    builtAt: string;
    lastRebuildMs: number | null;
  };
}
export { SearchHit as a, MemoryStore as i, INDEXED_DIRS as n, SearchOptions as o, IndexedFile as r, SearchScope as s, ChunkMeta as t };
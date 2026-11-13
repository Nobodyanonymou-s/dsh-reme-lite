/**
 * The representation layer around the store: a persistent link graph, the
 * generated digest index page, and near-duplicate detection.
 *
 * Everything here is derived — rebuildable from the nodes alone in a few
 * milliseconds, never authoritative. The graph lands in `metadata/` (outside
 * retrieval), and the index page is a page of pointers under a hard size cap:
 * a wiki that grows past the corpus it summarizes stops being an abstraction,
 * so gists are clipped before the page can become a second copy of the notes.
 * Nothing in this module rewrites a body node; dangling links and duplicate
 * pairs are reported for whoever consolidates next.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";

import { tokenize } from "./bm25.ts";
import { dateKey } from "./capture.ts";
import { extractWikilinks, linkKey } from "./markdown.ts";
import type { IndexedFile, MemoryStore } from "./store.ts";

/** The generated pointer page. Excluded from the graph and from the page itself. */
export const INDEX_PAGE_PATH = "digest/index.md";

/** Per digest node: the whole page may spend 2 × nodes × this many characters. */
export const INDEX_CHARS_PER_NODE = 120;

/** A gist is clipped to this before its entry line can grow past the budget. */
export const INDEX_GIST_MAX_CHARS = 100;

export interface LinkGraph {
  builtAt: string;
  /** Key: workspace-relative posix path; `digest/index.md` is never a node. */
  nodes: Record<string, { out: string[]; in: string[] }>;
  /** Targets that resolve to no node; `target` keeps the spelling in the source. */
  dangling: Array<{ from: string; target: string }>;
}

export interface DuplicatePair {
  a: string;
  b: string;
  /** Jaccard similarity of the two token bags, 0 to 1. */
  similarity: number;
}

/**
 * Wikilink namespaces this plugin family uses as internal markers, not
 * knowledge links. `[[node-memory:dream]]` is the dream reminder that lands in
 * daily pages, `[[recol:dream]]` a sibling plugin's; both resolve to nothing
 * and would pollute the dangling list forever. Add future marker prefixes
 * here instead of scattering them through the graph logic.
 */
export const INTERNAL_LINK_NAMESPACES = ["node-memory", "recol"];

/** True for targets like `[[node-memory:dream]]`: plugin plumbing, not a note. */
function isInternalMarker(target: string): boolean {
  return new RegExp(`^(${INTERNAL_LINK_NAMESPACES.join("|")}):`).test(target);
}

/** Body nodes of the digest layer, the derived index page excluded. */
export function digestNodes(store: MemoryStore): IndexedFile[] {
  return store.files.filter(
    (file) => file.relPath.startsWith("digest/") && file.relPath !== INDEX_PAGE_PATH,
  );
}

/**
 * Every wikilink of every node, resolved once against the index. Chunks never
 * split a line, so a link inside a chunk is a link in the file. `in` is the
 * reverse of the resolvable `out` edges; an unresolvable target becomes a
 * dangling entry instead of an edge to nowhere.
 */
export function buildLinkGraph(store: MemoryStore): LinkGraph {
  const nodes: LinkGraph["nodes"] = {};
  const dangling: LinkGraph["dangling"] = [];
  const sources = store.files.filter((file) => file.relPath !== INDEX_PAGE_PATH);
  for (const file of sources) nodes[file.relPath] = { out: [], in: [] };
  for (const file of sources) {
    const targets = new Set<string>();
    for (const chunk of file.chunks) {
      for (const target of extractWikilinks(chunk.text)) {
        // Internal markers ride in the page text but name no node; skipping
        // them here keeps them out of `out`, of `dangling`, and of `in` alike.
        if (isInternalMarker(target)) continue;
        targets.add(target);
      }
    }
    nodes[file.relPath]!.out = [...targets];
    for (const target of targets) {
      const resolved = store.byKey.get(linkKey(target));
      if (resolved) nodes[resolved]?.in.push(file.relPath);
      else dangling.push({ from: file.relPath, target });
    }
  }
  return { builtAt: new Date().toISOString(), nodes, dangling };
}

/**
 * Where a broken link could point instead: first a node whose frontmatter
 * name matches the target exactly (file names and titles drift apart), then
 * BM25 over the target text. The page holding the broken link is never its own
 * candidate — "point it at itself" is no advice. Candidates are hints for
 * whoever fixes the link; the store never rewrites a node on its own.
 */
export function candidatePaths(target: string, store: MemoryStore, exclude?: string): string[] {
  // Guard against future call sites: an internal marker never has candidates,
  // so BM25 must not be asked to improvise hits for plugin plumbing.
  if (isInternalMarker(target)) return [];
  const nameToPath = new Map<string, string>();
  for (const file of store.files) {
    if (file.relPath === INDEX_PAGE_PATH || file.relPath === exclude) continue;
    const name = linkKey(file.front.name ?? "");
    // First writer wins: a duplicate name must not make the hint unstable.
    if (name && !nameToPath.has(name)) nameToPath.set(name, file.relPath);
  }
  const exact = nameToPath.get(linkKey(target));
  if (exact) return [exact];
  // Link expansion stays off: a candidate is a direct hit, not a neighbour.
  const paths: string[] = [];
  for (const hit of store.search(target, { limit: 3, expandLinks: false })) {
    if (hit.relPath !== exclude && !paths.includes(hit.relPath)) paths.push(hit.relPath);
  }
  return paths;
}

/**
 * One line about a node: its description, else its frontmatter name, else the
 * file name. Whitespace collapses — the index page is one pointer per line.
 * Shared with the session brief, so both name a node the same way.
 */
export function gistOf(file: IndexedFile): string {
  const raw =
    file.front.description ||
    file.front.name ||
    posix.basename(file.relPath).replace(/\.(md|markdown)$/i, "");
  return raw.replace(/\s+/g, " ").trim();
}

/** Fixed reading order for the digest domains; anything else trails alphabetically. */
const INDEX_SECTIONS = ["personal", "procedure", "wiki", "self"];

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The generated pointer page over digest nodes. Every entry is one line — a
 * wikilink and a clipped gist — grouped by domain and newest first. The hard
 * part of the anti-bloat contract: the whole page is capped at
 * 2 × nodes × INDEX_CHARS_PER_NODE characters, gist clipping absorbs whatever
 * the fixed header leaves of the budget.
 */
export function renderIndexPage(store: MemoryStore, options: { now?: Date } = {}): string {
  const nodes = digestNodes(store);
  const head = [
    "---",
    "name: 索引 / Index",
    "description: digest 节点的生成指针页（generated pointer page over digest nodes）",
    `updated: ${dateKey(options.now ?? new Date())}`,
    "---",
    "",
    "本页是生成的指针页，正文节点不要复制这里的内容。",
    // Two trailing empties leave a blank line between the head and the first
    // `## section` (and before the `- (none)` placeholder), so the generated
    // file reads cleanly; `head.length` keeps the newline inside the cap budget.
    "",
    "",
  ].join("\n");
  if (!nodes.length) return `${head}- (none)\n`;

  const rows = nodes
    .map((file) => ({
      relPath: file.relPath,
      section: file.relPath.split("/")[1] ?? "misc",
      updated: file.front.updated ?? "",
      gist: gistOf(file),
    }))
    .sort((a, b) =>
      a.updated === b.updated ? byName(a.relPath, b.relPath) : b.updated.localeCompare(a.updated),
    );

  const sections = [
    ...INDEX_SECTIONS.filter((name) => rows.some((row) => row.section === name)),
    ...[...new Set(rows.map((row) => row.section))]
      .filter((name) => !INDEX_SECTIONS.includes(name))
      .sort(byName),
  ];
  const overhead =
    head.length + sections.reduce((sum, name) => sum + name.length + "## \n\n".length, 0);
  // The pointer itself must survive any clipping, so it sets the floor.
  const widest = Math.max(...rows.map((row) => `- [[${key(row.relPath)}]] — `.length));
  const allowance = Math.max(
    widest + 1,
    Math.floor((2 * INDEX_CHARS_PER_NODE * nodes.length - overhead) / nodes.length),
  );

  const body = sections
    .map((section) => {
      const lines = rows
        .filter((row) => row.section === section)
        .map((row) => {
          const pointer = `- [[${key(row.relPath)}]] — `;
          const budget = Math.min(INDEX_GIST_MAX_CHARS, allowance - pointer.length);
          return `${pointer}${clip(row.gist, budget)}`;
        });
      return [`## ${section}`, ...lines].join("\n");
    })
    .join("\n\n");
  return `${head}${body}\n`;
}

/** Wikilink spelling of a path: no extension, so it resolves like a written link. */
function key(relPath: string): string {
  return relPath.replace(/\.(md|markdown)$/i, "");
}

function clip(text: string, max: number): string {
  if (max <= 0) return "";
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Pairs of digest nodes whose token bags nearly coincide (Jaccard over the
 * BM25 tokenizer, so Chinese compares by character bigrams). Report only:
 * merging is the consolidator's call, made with supersedes in memory_write.
 */
export function nearDuplicates(
  store: MemoryStore,
  options: { threshold?: number } = {},
): DuplicatePair[] {
  const threshold = options.threshold ?? 0.8;
  const nodes = digestNodes(store);
  const bags = new Map<string, Set<string>>();
  for (const node of nodes) {
    bags.set(
      node.relPath,
      new Set(tokenize(node.chunks.map((chunk) => chunk.text).join("\n"))),
    );
  }
  const pairs: DuplicatePair[] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i]!.relPath;
      const b = nodes[j]!.relPath;
      const similarity = jaccard(bags.get(a)!, bags.get(b)!);
      if (similarity >= threshold) pairs.push({ a, b, similarity });
    }
  }
  return pairs.sort((x, y) => y.similarity - x.similarity);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * Regenerate the derived representation: the index page when there is anything
 * to point at (written through the store, so it stays indexed and searchable),
 * and the link graph as `metadata/links.json` in manifest style — diagnostic,
 * deletable, never a reason for a dream to fail.
 */
export async function writeRepresentation(store: MemoryStore): Promise<{ wrote: string[] }> {
  const graph = buildLinkGraph(store);
  const wrote: string[] = [];
  if (digestNodes(store).length >= 1) {
    await store.write({ relPath: INDEX_PAGE_PATH, content: renderIndexPage(store) });
    wrote.push(INDEX_PAGE_PATH);
  }
  const directory = join(store.root, "metadata");
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(join(directory, "links.json"), `${JSON.stringify(graph, null, 2)}\n`, "utf8");
    wrote.push("metadata/links.json");
  } catch {
    // Derived data only; never fail a consolidation over the graph write.
  }
  return { wrote };
}

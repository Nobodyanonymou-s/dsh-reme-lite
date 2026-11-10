/**
 * Heatmap data.
 *
 * DSH's settings page is a browser; it cannot read the workspace. The Host can,
 * so it aggregates counts here and serves them over a same-origin route the
 * client fetches. Only aggregates leave the process — never memory text.
 *
 * Kinds, in increasing weight (a day takes the strongest kind it contains):
 *   normal        green   ordinary journal entry
 *   notable       blue    the agent judged it significant
 *   user-declared purple  the user said it was important
 *   conflict      red     contradicts something already recorded
 *
 * Alongside the heatmap the payload carries a `digest` segment: knowledge-base
 * health as aggregates only (size, dangling links, orphans, near-duplicates),
 * so a summary layer quietly outgrowing the corpus it summarizes is visible.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { dateKey } from "./capture.ts";
import { buildLinkGraph, digestNodes, INDEX_PAGE_PATH, nearDuplicates } from "./links.ts";
import { parseFrontmatter } from "./markdown.ts";
import type { MemoryStore } from "./store.ts";

export type MemoryKind = "normal" | "notable" | "user-declared" | "conflict";

export const KINDS: readonly MemoryKind[] = ["normal", "notable", "user-declared", "conflict"];
const WEIGHT: Record<MemoryKind, number> = { normal: 0, notable: 1, "user-declared": 2, conflict: 3 };

export function normalizeKind(value: unknown): MemoryKind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value)
    ? (value as MemoryKind)
    : "normal";
}

interface CollectedFile {
  relPath: string;
  kind: MemoryKind;
  date: string;
  /** Whole file length in characters — the digest bloat gauge, not bytes. */
  chars: number;
}

async function collect(root: string): Promise<CollectedFile[]> {
  const out: CollectedFile[] = [];
  for (const dir of ["daily", "digest"]) {
    for (const absolute of await walk(join(root, dir))) {
      const relPath = absolute.slice(root.length + 1).split("\\").join("/");
      // The generated pointer page is not a memory entry: counting it would
      // inflate both the heatmap and the total. It is reported on its own.
      if (relPath === INDEX_PAGE_PATH) continue;
      let text;
      try {
        text = await readFile(absolute, "utf8");
      } catch {
        continue;
      }
      const { data } = parseFrontmatter(text);
      // The date comes from the path when the workspace is organized by day,
      // otherwise from frontmatter — a digest node is dated when it was written.
      const fromPath = /(\d{4}-\d{2}-\d{2})/.exec(relPath);
      let date = fromPath?.[1] ?? String(data.updated ?? data.date ?? "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        // Nodes written before `updated` existed still belong on the calendar:
        // the write time is their date.
        const info = await stat(absolute).catch(() => null);
        if (info === null) continue;
        date = dateKey(info.mtime);
      }
      out.push({ relPath, kind: normalizeKind(data.kind), date, chars: text.length });
    }
  }
  return out;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(absolute)));
    else if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) out.push(absolute);
  }
  return out;
}

export interface StatusInput {
  root: string;
  task?: Record<string, unknown> | null;
  days?: number;
  /**
   * The live index, when the caller has one: the graph-derived health numbers
   * (dangling links, orphans, near-duplicates) are only computed against it.
   * Without it those three stay `null` — the fields always exist, so an old
   * client cannot trip over a missing key.
   */
  store?: MemoryStore;
}

export interface StatusDay {
  date: string;
  total: number;
  kind: MemoryKind;
  kinds: Record<string, number>;
}

/**
 * Knowledge-base health, aggregates only — the wiki-bloat warning Anthropic
 * ran into (a summary layer grown past the corpus it summarizes) must be
 * visible before it is acted on. No node text ever travels in this segment.
 */
export interface DigestStatus {
  nodes: number;
  chars: number;
  byDir: Record<string, number>;
  indexPage: { path: string; chars: number } | null;
  danglingLinks: number | null;
  orphanNodes: number | null;
  nearDuplicates: number | null;
  lastDreamAt: string | null;
}

export interface StatusPayload {
  generatedAt: string;
  workspace: string;
  total: number;
  kinds: readonly MemoryKind[];
  days: StatusDay[];
  task: unknown;
  digest: DigestStatus;
}

/** Second-level directory of a digest path; loose files at the root are `misc`. */
function digestDir(relPath: string): string {
  const segment = relPath.split("/");
  return segment.length >= 3 ? segment[1]! : "misc";
}

/** The generated pointer page, reported separately because collect skips it. */
async function indexPageStatus(root: string): Promise<DigestStatus["indexPage"]> {
  let text: string;
  try {
    text = await readFile(join(root, INDEX_PAGE_PATH), "utf8");
  } catch {
    return null;
  }
  return { path: INDEX_PAGE_PATH, chars: text.length };
}

/**
 * Digest segment: size and directory spread come from the walk (always
 * available), the graph-derived numbers from the caller's store. The three
 * graph numbers are warnings for whoever consolidates next — never a trigger
 * that runs a dream on its own.
 */
async function digestStatus(
  collected: CollectedFile[],
  root: string,
  store?: MemoryStore,
  task?: Record<string, unknown> | null,
): Promise<DigestStatus> {
  const nodes = collected.filter((file) => file.relPath.startsWith("digest/"));
  const byDir: Record<string, number> = {};
  for (const file of nodes) {
    const dir = digestDir(file.relPath);
    byDir[dir] = (byDir[dir] ?? 0) + 1;
  }
  const graph = store ? buildLinkGraph(store) : null;
  const lastRunAt = task?.lastRunAt;
  return {
    nodes: nodes.length,
    chars: nodes.reduce((sum, file) => sum + file.chars, 0),
    byDir,
    indexPage: await indexPageStatus(root),
    danglingLinks: graph ? graph.dangling.length : null,
    orphanNodes:
      graph && store
        ? digestNodes(store).filter((file) => (graph.nodes[file.relPath]?.in.length ?? 0) === 0).length
        : null,
    nearDuplicates: store ? nearDuplicates(store).length : null,
    lastDreamAt: typeof lastRunAt === "string" && lastRunAt ? lastRunAt : null,
  };
}

export async function buildStatus(input: StatusInput): Promise<StatusPayload> {
  const days = input.days ?? 180;
  const files = await collect(input.root);
  const digest = await digestStatus(files, input.root, input.store, input.task);
  const byDate = new Map<string, { total: number; kind: MemoryKind; kinds: Record<string, number> }>();
  for (const file of files) {
    const entry = byDate.get(file.date) ?? { total: 0, kind: "normal", kinds: {} };
    entry.total += 1;
    entry.kinds[file.kind] = (entry.kinds[file.kind] ?? 0) + 1;
    if (WEIGHT[file.kind] > WEIGHT[entry.kind]) entry.kind = file.kind;
    byDate.set(file.date, entry);
  }

  const sorted = [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return {
    generatedAt: new Date().toISOString(),
    // The heatmap describes the user's memory entries in this workspace; the
    // path and the total ship with the payload so the page can say so plainly.
    workspace: input.root,
    total: files.length,
    kinds: KINDS,
    days: sorted.slice(-days).map(([date, entry]) => ({
      date,
      total: entry.total,
      kind: entry.kind,
      kinds: entry.kinds,
    })),
    task: input.task ?? null,
    digest,
  };
}

export async function buildDays(root: string): Promise<StatusDay[]> {
  return (await buildStatus({ root })).days;
}

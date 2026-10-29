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
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { dateKey } from "./capture.js";
import { parseFrontmatter } from "./markdown.js";

/** @typedef {"normal" | "notable" | "user-declared" | "conflict"} MemoryKind */

export const KINDS = ["normal", "notable", "user-declared", "conflict"];
const WEIGHT = { normal: 0, notable: 1, "user-declared": 2, conflict: 3 };

/** @param {unknown} value */
export function normalizeKind(value) {
  return typeof value === "string" && KINDS.includes(value) ? value : "normal";
}

/**
 * @param {string} root
 * @returns {Promise<{ relPath: string, kind: MemoryKind, date: string }[]>}
 */
async function collect(root) {
  /** @type {{ relPath: string, kind: MemoryKind, date: string }[]} */
  const out = [];
  for (const dir of ["daily", "digest"]) {
    for (const absolute of await walk(join(root, dir))) {
      const relPath = absolute.slice(root.length + 1).split("\\").join("/");
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
      let date = fromPath ? fromPath[1] : String(data.updated ?? data.date ?? "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        // Nodes written before `updated` existed still belong on the calendar:
        // the write time is their date.
        const info = await stat(absolute).catch(() => null);
        if (info === null) continue;
        date = dateKey(info.mtime);
      }
      out.push({ relPath, kind: normalizeKind(data.kind), date });
    }
  }
  return out;
}

/** @param {string} dir @returns {Promise<string[]>} */
async function walk(dir) {
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
    if (entry.isDirectory()) out.push(...(await walk(absolute)));
    else if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) out.push(absolute);
  }
  return out;
}

/**
 * @param {{ root: string, task?: Record<string, unknown> | null, days?: number }} input
 * @returns {Promise<{ generatedAt: string, kinds: string[], days: { date: string, total: number, kind: MemoryKind, kinds: Record<string, number> }[], task: unknown }>}
 */
export async function buildStatus(input) {
  const days = input.days ?? 180;
  const files = await collect(input.root);
  /** @type {Map<string, { total: number, kind: MemoryKind, kinds: Record<string, number> }>} */
  const byDate = new Map();
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
  };
}

/**
 * @param {string} root
 * @returns {Promise<{ date: string, total: number, kind: MemoryKind, kinds: Record<string, number> }[]>}
 */
export async function buildDays(root) {
  return (await buildStatus({ root })).days;
}

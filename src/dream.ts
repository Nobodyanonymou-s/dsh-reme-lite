/**
 * Consolidation ("dream") material.
 *
 * ReMe's `auto_dream` hands a model a batch of daily notes and asks it to
 * create / refine / correct digest nodes. We cannot assume a model is
 * reachable from inside a plugin, so the material is built here and given to
 * whoever will do the writing: an agent we spawned, the current session's
 * agent, or the user via the `memory_dream` tool. One builder, three callers.
 *
 * The writer usually cannot read the transcript itself: its fs tools stop at
 * the session workspace, which the memory root sits outside of. Pointing at
 * `session/dialog/*.jsonl` would be a rule nobody can follow, so a bounded
 * recent slice travels inside the material for reconciliation.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { buildLinkGraph, candidatePaths, digestNodes, nearDuplicates } from "./links.ts";
import type { LinkGraph, DuplicatePair } from "./links.ts";
import type { MemoryStore } from "./store.ts";
import { SOURCE } from "./turns.ts";

export type Language = "zh" | "en";

export interface DreamMaterialInput {
  store: MemoryStore;
  pendingTurns?: number;
  days?: number;
  language?: Language;
  /** How many days of raw dialogue travel with the material. */
  transcriptDays?: number;
  /** Hard character cap on that transcript block, whatever the day holds. */
  transcriptBudget?: number;
}

export async function buildDreamMaterial(input: DreamMaterialInput): Promise<string> {
  const days = input.days ?? 7;
  const recent = await input.store.recentDaily(days);
  // digestNodes, not digestTitles: the generated index page is a pointer
  // sheet, not knowledge, and must not read as one more node to maintain.
  const digest = digestNodes(input.store).map((file) => file.relPath);
  const pending = input.pendingTurns ?? 0;
  const transcripts = await transcriptSection(input.store.root, {
    days: input.transcriptDays,
    budget: input.transcriptBudget,
  });
  // The representation layer travels with the material so the writer can fix
  // links and duplicates in the same pass that adds content.
  const graph = buildLinkGraph(input.store);
  const duplicates = nearDuplicates(input.store);

  return [
    "# Consolidation material",
    "",
    `Workspace: ${input.store.root}`,
    `Indexed: ${input.store.files.length} files / ${input.store.index.size} chunks`,
    `Unflushed turns in memory: ${pending}`,
    "",
    "## Recent daily pages",
    recent.length ? recent.map((path) => `- ${path}`).join("\n") : "- (none)",
    "",
    "## Existing digest nodes",
    digest.length ? digest.map((path) => `- ${path}`).join("\n") : "- (none)",
    "",
    danglingSection(input.store, graph),
    "",
    duplicateSection(duplicates),
    "",
    transcripts,
    "",
    "## Rules",
    DREAM_RULES,
    "",
    kindRules(input.language),
  ].join("\n");
}

/** Dangling entries that fit in the material; a large backlog is a listing job, not a reading one. */
const MAX_DANGLING_LINKS = 20;
/** Duplicate pairs shown; more than that means the digest needs a pass of its own. */
const MAX_DUPLICATE_PAIRS = 5;

/**
 * Broken links with a hint each: a node whose frontmatter name matches the
 * target, else BM25 over the target text. The store never rewrites the link —
 * the reader points it at the real node, drops it, or creates the missing one.
 */
function danglingSection(store: MemoryStore, graph: LinkGraph): string {
  const lines = ["## Dangling wikilinks"];
  if (!graph.dangling.length) return [...lines, "- (none)"].join("\n");
  for (const link of graph.dangling.slice(0, MAX_DANGLING_LINKS)) {
    const candidates = candidatePaths(link.target, store, link.from);
    const hint = candidates.length ? ` — candidates: ${candidates.join(", ")}` : " — (no candidates)";
    lines.push(`- ${link.from} → [[${link.target}]]${hint}`);
  }
  return lines.join("\n");
}

/** Near-identical digest nodes as a pair list; merging stays a human-reviewed edit. */
function duplicateSection(pairs: DuplicatePair[]): string {
  const lines = ["## Possible duplicates"];
  if (!pairs.length) return [...lines, "- (none)"].join("\n");
  for (const pair of pairs.slice(0, MAX_DUPLICATE_PAIRS)) {
    lines.push(`- ${pair.a} ↔ ${pair.b} (${pair.similarity.toFixed(2)})`);
  }
  return lines.join("\n");
}

export const DREAM_RULES = [
  "1. Read only the recent daily pages you need; do not load the whole workspace.",
  "2. Extract what will still matter next month: preferences, decisions,",
  "   procedures, entities. Drop one-off chatter.",
  "3. Create or merge digest nodes with memory_write: digest/personal,",
  "   digest/procedure, digest/wiki. One topic per node.",
  "4. Every digest node cites its sources with [[daily/YYYY-MM-DD]] links.",
  "5. Reconcile against the recent transcripts before merging, but only",
  "   re-check conclusions that could have changed: dates, names, ports,",
  "   preferences, plans in flight, status. When a note no longer matches,",
  "   correct that node in place and add one line saying what changed and why",
  "   (the old value stays readable in that line) instead of adding a second",
  '   one; when you cannot verify, say "unverified" — never present an',
  "   unverified note as confirmed.",
  "6. Fix the representation layer before adding content: point dangling",
  "   wikilinks at the real node (or drop the link — never the node); merge",
  "   near-duplicate nodes into the newer one instead of keeping both, and",
  "   rewrite the old node's body down to a one-line pointer at the new",
  "   one; digest/index.md is generated — never copy its lines into body pages.",
  "7. If a new fact contradicts an existing digest node, correct that node",
  "   instead of adding a second, conflicting one.",
  "8. Prefer few good nodes over many thin ones. Deleting nothing is fine:",
  "   adding one correct node beats rewriting five.",
  "9. digest nodes are the team layer — every agent reads them. Anything you",
  "   are still unsure about stays in daily/ (private to its writer), not in",
  "   digest: a settled team layer is worth more than a fast one.",
].join("\n");

const DIALOG_DIR = join("session", "dialog");
const TRANSCRIPT_DAYS = 3;
const TRANSCRIPT_BUDGET = 12000;
/** Assistant replies are trimmed to this; the user's words never are. */
const ASSISTANT_CAP = 300;
const DAY_MS = 86_400_000;

interface DialogLine {
  role: "user" | "assistant";
  text: string;
  time: number;
}

/** One question and the conclusion it ended on. */
interface DialogTurn {
  user: DialogLine;
  reply: DialogLine | null;
}

/**
 * The reconciliation slice of the material: recent raw dialogue, one entry per
 * question. The block, heading included, is capped at `budget`, so the
 * transcript cannot grow with the workspace and eat the consolidation context.
 */
export async function transcriptSection(
  root: string,
  options: { days?: number; budget?: number; now?: number } = {},
): Promise<string> {
  const days = Math.max(1, options.days ?? TRANSCRIPT_DAYS);
  const budget = Math.max(0, options.budget ?? TRANSCRIPT_BUDGET);
  const now = options.now ?? Date.now();

  const header = [
    `## Recent transcripts (last ${days} days, for verification only)`,
    "Ground truth only — verify against it, never copy it into digest nodes.",
  ];
  // The body gets what the heading and its disclaimer leave of the budget.
  const allowance = budget - (header.join("\n").length + 1);

  const turns = groupByUserTurn(await readDialog(join(root, DIALOG_DIR), { now, days }));
  const body = newestFirst(turns.map(renderTurn), allowance);

  return [...header, body.length ? body.join("\n") : "- (none)"].join("\n");
}

/**
 * Read every transcript line inside the window, oldest first. The journal is
 * append-only and crash-prone by design, so each line is handled on its own:
 * a torn final line or a malformed record is skipped, never fatal, or one bad
 * session would take the whole consolidation pass down with it.
 */
async function readDialog(dir: string, range: { now: number; days: number }): Promise<DialogLine[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return []; // no transcript directory yet: nothing to reconcile against
  }
  const lines: DialogLine[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const absolute = join(dir, name);
    // Sessions accumulate forever, so a file whose last append predates the
    // window cannot hold a line inside it — skip the parse entirely.
    const info = await stat(absolute).catch(() => null);
    if (info && range.now - info.mtimeMs >= range.days * DAY_MS) continue;
    let raw: string;
    try {
      raw = await readFile(absolute, "utf8");
    } catch {
      continue; // deleted between the listing and the read
    }
    for (const row of raw.split("\n")) {
      const line = row.trim();
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const record = parsed as Record<string, unknown>;
      const role = record.role === "user" || record.role === "assistant" ? record.role : null;
      const text = typeof record.text === "string" && record.text.trim() ? record.text : null;
      if (!role || !text) continue;
      if (isOwnInjection(record, text)) continue;
      const time = Date.parse(typeof record.at === "string" ? record.at : "");
      if (!Number.isFinite(time)) continue;
      if (range.now - time >= range.days * DAY_MS) continue;
      lines.push({ role, text, time });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

/**
 * The plugin's own injections sit in the transcript like any other turn, but
 * they are our output, not ground truth — a node reconciled against them would
 * end up confirming itself. Old transcripts carry no source field, so those
 * lines are recognised by content; the source check covers whatever comes next.
 */
function isOwnInjection(record: Record<string, unknown>, text: string): boolean {
  const source = record.source;
  if (source && typeof source === "object" && !Array.isArray(source)) {
    const marked = source as Record<string, unknown>;
    if (marked.kind === SOURCE || marked.plugin === SOURCE) return true;
  }
  const head = text.trimStart();
  return (
    head.startsWith("# 长期记忆") ||
    head.startsWith("# Long-term memory") ||
    text.includes("[[node-memory:dream]]")
  );
}

/**
 * Collapse the window into one entry per question. The transcript has no turn
 * numbers, so a user line is the boundary; the last assistant line before the
 * next question is that turn's conclusion, and the steps before it are
 * narration on the way there. Assistant lines opening the window answer a
 * question older than the window — kept they would verify nothing, so they go.
 */
function groupByUserTurn(lines: DialogLine[]): DialogTurn[] {
  const turns: DialogTurn[] = [];
  let current: DialogTurn | null = null;
  for (const line of lines) {
    if (line.role === "user") {
      if (current) turns.push(current);
      current = { user: line, reply: null };
    } else if (current) {
      current.reply = line;
    }
  }
  if (current) turns.push(current);
  return turns;
}

function renderTurn(turn: DialogTurn): string {
  const lines = [`- ${stamp(turn.user.time)} user: ${turn.user.text}`];
  if (turn.reply) {
    lines.push(`- ${stamp(turn.reply.time)} assistant: ${capAssistant(turn.reply.text)}`);
  }
  return lines.join("\n");
}

function capAssistant(text: string): string {
  return text.length > ASSISTANT_CAP ? `${text.slice(0, ASSISTANT_CAP)}…` : text;
}

function stamp(time: number): string {
  const date = new Date(time);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Keep the newest entries that fit and drop the rest, oldest first: what
 * reconciliation needs is the latest state of the facts, not the history.
 * The kept slice stays contiguous so a turn never loses its answer. One
 * exception: a paste larger than the whole block must not blank the section —
 * an empty "(none)" under a budget that could have shown the newest question
 * hides the very thing reconciliation needs most. The oversized newest entry
 * goes in clipped instead; only a block too small to hold even a timestamp
 * degrades to (none).
 */
function newestFirst(entries: string[], allowance: number): string[] {
  const kept: string[] = [];
  let spent = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry === undefined) continue;
    const cost = entry.length + 1; // the joining newline, charged to be safe
    if (spent + cost > allowance) {
      // Charge the trailing newline the section joins with, so an exactly-full
      // clip still lands inside the budget.
      if (kept.length === 0 && allowance >= CLIP_FLOOR) {
        return [`${entry.slice(0, allowance - 2)}…`];
      }
      break;
    }
    kept.unshift(entry);
    spent += cost;
  }
  return kept;
}

/** Below this many characters a clipped entry is noise, not evidence. */
const CLIP_FLOOR = 30;

/**
 * How a node earns its colour. Written for a model that reads it once, so it is
 * an ordered decision list with concrete trigger phrases, not a taxonomy.
 * Order == severity: the first match wins. Both languages carry the same rules;
 * the trigger phrases are language-specific on purpose.
 */

const KIND_RULES_TEXT: Record<Language, string> = {
  zh: [
    "## 标注规则（决定热力图颜色）",
    "",
    "按顺序判一次，命中即停。拿不准就绿。宁可漏标，不可滥标。",
    "",
    "1. **红 conflict** — 新材料与已有节点矛盾（同一事实两个值：日期、端口、人名、偏好；",
    "   或旧结论已被推翻）。修正旧节点并标红，不要新建第二个。红的作用是让人看见，",
    "   不是让人难堪：正文写清「原来是什么、现在是什么、因为什么」。",
    "2. **紫 user-declared** — 用户**本人**用强调、决定或纠正的方式表达过：",
    "   「记住」「这个重要」「一定要」「以后都这样」「我决定」「就按这个来」「不是…是…」。",
    "   只认用户原话或其直接改写；不要把自己的推断、也不要替用户升级成紫。",
    "3. **蓝 notable** — 你判断半年后还想知道的：决策与理由、踩过的坑、可复用的步骤、",
    "   稳定的偏好与边界、人与组织的关系。一次性状态、临时情绪、随手能查到的公共常识都不算。",
    "   蓝靠校准：用户把蓝当噪音（「这也记？」）就提高门槛；用户抱怨漏记再放宽。",
    "4. **绿 normal** — 其余全部。默认值，不写 kind。",
    "",
    "标了非绿时，在正文末尾加一行理由，让颜色可追溯：",
    "`> 标紫：用户 10-25 原话「以后都按周五发版」`",
    "`> 标红：原记 23:00，今日改口 22:30`",
  ].join("\n"),
  en: [
    "## Labelling rules (they decide the heatmap colour)",
    "",
    "Decide once, in order; the first match wins. When unsure, use green. Missing a colour is cheaper than inventing one.",
    "",
    "1. **red conflict** — the new material contradicts an existing node (one fact, two values:",
    "   a date, a port, a person, a preference; or an old conclusion has been overturned).",
    "   Correct the old node and mark it red; do not add a second node. Red exists to be seen,",
    "   not to assign blame — the body says what it used to be, what it is now, and why.",
    "2. **purple user-declared** — the user **themselves** stressed it, decided it, or corrected it:",
    '   "remember this", "this matters", "always", "from now on", "I decided", "let\'s do it this way",',
    '   "it\'s not X, it\'s Y". Only their own words or a direct paraphrase. Never promote your own',
    "   inference to purple, and never decide on the user's behalf what matters.",
    "3. **blue notable** — you judge it worth knowing in six months: decisions and their reasons,",
    "   traps you fell into, reusable procedures, stable preferences and boundaries, people and how",
    "   they relate. One-off states, passing moods, and public facts you could look up do not count.",
    "   Blue is calibrated, not defined: if the user treats blue as noise (\"why is this saved?\"),",
    "   raise the bar; if they complain about missing memories, lower it.",
    "4. **green normal** — everything else. The default; do not write `kind`.",
    "",
    "For any non-green node, end the body with one line of justification so the colour stays auditable:",
    '`> purple: user said on 10-25, "we ship on Fridays from now on"`',
    "`> red: was 23:00, changed to 22:30 today`",
  ].join("\n"),
};

export function kindRules(language: Language = "zh"): string {
  return KIND_RULES_TEXT[language === "en" ? "en" : "zh"];
}

/** @deprecated kept for imports that predate the language split. */
export const KIND_RULES = KIND_RULES_TEXT.zh;

/**
 * The prompt used when a background agent performs the consolidation itself.
 * Kept here so the tool output and the scheduled task agree on the rules.
 */
export function dreamPrompt(material: string): string {
  return [
    "You are consolidating long-term memory. Work in the files, then report.",
    "",
    material,
    "",
    "When you are done, reply with a short list of files you created or changed.",
    "Do not ask questions; make the smallest useful set of edits.",
  ].join("\n");
}

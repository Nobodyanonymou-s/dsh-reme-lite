/**
 * The opt-in session brief: five fixed sections injected at `agent/created`
 * when `briefEnabled` is on (default off — turning it on is an experiment, not
 * a default, because one wrong note here rides into every later session).
 *
 * Two constraints shape the module, both from the injection literature:
 * it must stay small (a character budget, rows dropped whole), and it must
 * read like an index, not prose — every row names the path it came from.
 *
 * Admission is structural, not editorial. The brief reads only the digest
 * nodes the index already holds, so a `daily/` page or an assistant aside
 * cannot reach this code at all; the "about you" section narrows further to
 * personal nodes the user declared or that cite a source wikilink. The
 * "unverified" section is a placeholder until a prediction ledger exists —
 * it never synthesizes content to fill itself.
 *
 * Pure and synchronous: the caller guarantees the store index is fresh.
 */

import { excerpt } from "./capture.ts";
import { digestNodes, gistOf } from "./links.ts";
import { extractWikilinks } from "./markdown.ts";
import { normalizeKind } from "./status.ts";
import type { MemoryKind } from "./status.ts";
import type { IndexedFile, MemoryStore } from "./store.ts";

export interface BriefOptions {
  language?: "zh" | "en";
  /** Character budget for the whole brief, title and headings included. */
  budget?: number;
}

export const BRIEF_BUDGET_DEFAULT = 900;
export const BRIEF_BUDGET_MIN = 200;
export const BRIEF_BUDGET_MAX = 4000;

/** Rows each section may hold; the section skeleton itself is never trimmed. */
const STATE_ROWS = 3;
const ABOUT_ROWS = 3;
const SUPERSEDED_ROWS = 2;
/** One-line cap on the weakness reminder, same clip the daily page uses. */
const WEAKNESS_CHARS = 140;
/** The lesson page the weakness section reads; absent means "（无）". */
const WEAKNESS_PATH = "digest/self/操作教训.md";

/**
 * Kind priority for budget drops: conflict survives longest, normal goes
 * first — the same ordering the heatmap and the dream rubric already use.
 */
const KIND_WEIGHT: Record<MemoryKind, number> = { normal: 0, notable: 1, "user-declared": 2, conflict: 3 };

const WORDS = {
  zh: {
    title: "# 会话简报",
    state: "当前状态",
    about: "关于你",
    superseded: "已推翻的",
    unverified: "待验证的",
    weakness: "一个弱点提醒",
    none: "（无）",
  },
  en: {
    title: "# Session brief",
    state: "Current state",
    about: "About you",
    superseded: "Superseded",
    unverified: "Unverified",
    weakness: "One weakness",
    none: "(none)",
  },
} as const;

/** One candidate line of the brief, with the keys the budget drop needs. */
interface Row {
  text: string;
  /** Kind weight — the budget drops lowest-weight rows first. */
  weight: number;
  /** Sort key inside a weight (newest first is kept); 0 without a date. */
  at: number;
}

function updatedAt(file: IndexedFile): number {
  const time = Date.parse(file.front.updated ?? "");
  return Number.isFinite(time) ? time : 0;
}

/** `（path，date）` — the pointer every row carries so it can be audited. */
function where(language: "zh" | "en", file: IndexedFile): string {
  const date = (file.front.updated ?? "").trim();
  return language === "en"
    ? ` (${file.relPath}${date ? `, ${date}` : ""})`
    : `（${file.relPath}${date ? `，${date}` : ""}）`;
}

/**
 * One row: a gist plus the pointer that makes it auditable. No role label —
 * until a decision kind exists, any prefix here would assert something the
 * data cannot back, and a mislabelled row rides into every later session.
 */
function rowOf(language: "zh" | "en", file: IndexedFile): Row {
  return {
    text: `- ${gistOf(file)}${where(language, file)}`,
    weight: KIND_WEIGHT[normalizeKind(file.front.kind)],
    at: updatedAt(file),
  };
}

/** A personal node enters "about you" only when it names where it came from. */
function citesSource(file: IndexedFile): boolean {
  return file.chunks.some((chunk) => extractWikilinks(chunk.text).length > 0);
}

/** First body line of the lesson page — headings and blanks skipped. */
function weaknessRow(store: MemoryStore): Row | null {
  const file = store.files.find((entry) => entry.relPath === WEAKNESS_PATH);
  if (!file) return null;
  for (const chunk of file.chunks) {
    for (const line of chunk.text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      // A lesson is exactly what "notable" means: judged to last.
      return { text: `- ${excerpt(trimmed, WEAKNESS_CHARS)}`, weight: KIND_WEIGHT.notable, at: updatedAt(file) };
    }
  }
  return null;
}

function clampBudget(value: number | undefined): number {
  const parsed = Math.round(Number(value ?? BRIEF_BUDGET_DEFAULT));
  if (!Number.isFinite(parsed)) return BRIEF_BUDGET_DEFAULT;
  return Math.min(BRIEF_BUDGET_MAX, Math.max(BRIEF_BUDGET_MIN, parsed));
}

/**
 * Build the brief for whatever the index holds right now. Empty sections stay
 * in the output as placeholders: the five-part shape is the contract, so a
 * thin workspace still reads as a brief rather than as a different document.
 */
export function buildBrief(store: MemoryStore, options: BriefOptions = {}): string {
  const language = options.language === "en" ? "en" : "zh";
  const budget = clampBudget(options.budget);
  const words = WORDS[language];

  // The generated index page is pointers, not knowledge — digestNodes already
  // excludes it, and with it the whole daily/ layer stays structurally out.
  const nodes = [...digestNodes(store)].sort(
    (a, b) => updatedAt(b) - updatedAt(a) || (a.relPath < b.relPath ? -1 : 1),
  );

  const sections: Array<{ heading: string; rows: Array<Row | null> }> = [
    {
      // No `decision` kind exists yet, so the latest updates are the data
      // source — neutrally worded, since a label would overstate what the
      // rows are. The section switches to decisions when the type appears.
      heading: words.state,
      rows: nodes.slice(0, STATE_ROWS).map((file) => rowOf(language, file)),
    },
    {
      heading: words.about,
      rows: nodes
        .filter(
          (file) =>
            file.relPath.startsWith("digest/personal/") &&
            (normalizeKind(file.front.kind) === "user-declared" || citesSource(file)),
        )
        .slice(0, ABOUT_ROWS)
        .map((file) => rowOf(language, file)),
    },
    {
      heading: words.superseded,
      rows: nodes
        .filter((file) => (file.front.supersedes ?? "").trim() !== "" || normalizeKind(file.front.kind) === "conflict")
        .slice(0, SUPERSEDED_ROWS)
        .map((file) => rowOf(language, file)),
    },
    // Placeholder until a prediction ledger exists — never filled with guesses.
    { heading: words.unverified, rows: [] },
    { heading: words.weakness, rows: [] },
  ];
  const weakness = weaknessRow(store);
  if (weakness) sections[4]!.rows = [weakness];

  const render = (): string => {
    const parts: string[] = [words.title];
    for (const section of sections) {
      const lines = section.rows
        .filter((row): row is Row => row !== null)
        .map((row) => row.text);
      parts.push("", `## ${section.heading}`, lines.length ? lines.join("\n") : words.none);
    }
    return parts.join("\n");
  };

  // Sort by what goes first, not by what reads first: the budget eats
  // lowest-weight rows whole (oldest first inside a weight) until the text
  // fits. Headings and placeholders are not rows — the skeleton always
  // survives, and a section that loses every row falls back to （无）.
  const droppable = sections.flatMap((section, index) =>
    section.rows.map((row, at) => ({ index, at, row: row as Row })),
  );
  droppable.sort((a, b) => a.row.weight - b.row.weight || a.row.at - b.row.at);

  let text = render();
  for (const target of droppable) {
    if (text.length <= budget) break;
    sections[target.index]!.rows[target.at] = null;
    text = render();
  }
  return text;
}

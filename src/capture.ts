/**
 * Turn capture: the durable half of memory that needs no model.
 *
 * Every completed turn is appended to `session/dialog/<session>.jsonl` first
 * (so nothing is lost on a crash), and the day's index page gets an excerpt
 * list inside a single auto-managed block. Human text outside that block is
 * never rewritten — the same boundary QwenPaw uses for `notes:auto`.
 */

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const AUTO_START = "<!-- notes:auto -->";
export const AUTO_END = "<!-- /notes:auto -->";

export interface Turn {
  role: "user" | "assistant";
  text: string;
  at: string;
}

export function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

export function dialogFileName(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return `${safe || "session"}-${shortHash(sessionId)}.jsonl`;
}

export function dateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function excerpt(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export class Capture {
  root: string;
  interval: number;
  buffers: Map<string, Turn[]> = new Map();
  lastHash: Map<string, string> = new Map();
  droppedDuplicates = 0;
  capturedTurns = 0;

  constructor(options: { root: string; interval?: number; timeZone?: string }) {
    this.root = options.root;
    this.interval = Math.max(1, options.interval ?? 5);
  }

  get pending(): number {
    let total = 0;
    for (const turns of this.buffers.values()) total += turns.length;
    return total;
  }

  /**
   * Record one completed turn. Returns true when a durable write happened.
   */
  async record(sessionId: string, turn: Turn): Promise<boolean> {
    const text = turn.text.trim();
    if (!text) return false;
    // Skip a turn identical to the previous one in the same session: retries
    // and replays would otherwise inflate the journal.
    const hash = shortHash(`${turn.role}:${text}`);
    if (this.lastHash.get(sessionId) === hash) {
      this.droppedDuplicates += 1;
      return false;
    }
    this.lastHash.set(sessionId, hash);

    const file = join(this.root, "session", "dialog", dialogFileName(sessionId));
    await mkdir(join(this.root, "session", "dialog"), { recursive: true });
    await appendFile(
      file,
      `${JSON.stringify({ session_id: sessionId, role: turn.role, at: turn.at, text })}\n`,
      "utf8",
    );
    this.capturedTurns += 1;

    const buffer = this.buffers.get(sessionId) ?? [];
    buffer.push({ ...turn, text });
    this.buffers.set(sessionId, buffer);
    if (buffer.length >= this.interval) await this.flush(sessionId);
    return true;
  }

  /**
   * Fold the buffer into today's daily page.
   */
  async flush(sessionId: string): Promise<string[] | null> {
    const turns = this.buffers.get(sessionId);
    if (!turns || turns.length === 0) return null;
    this.buffers.set(sessionId, []);

    const byDate = new Map<string, Turn[]>();
    for (const turn of turns) {
      const key = dateKey(new Date(turn.at));
      byDate.set(key, [...(byDate.get(key) ?? []), turn]);
    }

    const written: string[] = [];
    for (const [key, dayTurns] of byDate) {
      const relPath = `daily/${key}.md`;
      const absolute = join(this.root, "daily", `${key}.md`);
      const existing = await readFile(absolute, "utf8").catch(() => null);
      const block = buildAutoBlock(dayTurns, sessionId);
      const next =
        existing === null
          ? `---\nname: ${key}\ndescription: auto-captured conversation notes\n---\n\n${AUTO_START}\n${block}\n${AUTO_END}\n`
          : upsertAutoBlock(existing, block);
      await mkdir(join(this.root, "daily"), { recursive: true });
      await writeFile(absolute, next, "utf8");
      written.push(relPath);
    }
    return written;
  }

  /** Drain every session buffer. */
  async flushAll(): Promise<string[]> {
    const written: string[] = [];
    for (const sessionId of [...this.buffers.keys()]) {
      const result = await this.flush(sessionId);
      if (result) written.push(...result);
    }
    return written;
  }

  stats(): { sessions: number; pending: number; capturedTurns: number; droppedDuplicates: number } {
    return {
      sessions: this.buffers.size,
      pending: this.pending,
      capturedTurns: this.capturedTurns,
      droppedDuplicates: this.droppedDuplicates,
    };
  }
}

function buildAutoBlock(turns: Turn[], sessionId: string): string {
  const lines = turns.map((turn) => {
    const time = new Date(turn.at).toISOString().slice(11, 16);
    const who = turn.role === "user" ? "user" : "assistant";
    return `- ${time} **${who}**: ${excerpt(turn.text)}`;
  });
  const short = sessionId.replace(/^session-/, "").slice(0, 8);
  lines.push("", `_session: ${short}_`);
  return lines.join("\n");
}

/**
 * Merge the incoming auto block into the page's existing one.
 *
 * Every session writes the page for the day it was active in, so replacing the
 * block wholesale loses the other sessions' turns: on a day with more than one
 * session the later flush silently erased the earlier notes. Merge instead —
 * keep chronological order, drop exact repeats, and list every contributing
 * session in the trailer.
 */
export function upsertAutoBlock(existing: string, block: string): string {
  const start = existing.indexOf(AUTO_START);
  const end = existing.indexOf(AUTO_END);
  if (start === -1 || end === -1 || end < start) {
    const trimmed = existing.replace(/\n+$/, "");
    return `${trimmed}\n\n${AUTO_START}\n${block}\n${AUTO_END}\n`;
  }
  const before = existing.slice(0, start + AUTO_START.length);
  const after = existing.slice(end);
  const current = parseBlock(existing.slice(start, end));
  const incoming = parseBlock(block);
  const merged = formatBlock(
    mergeTurnLines(current.turns, incoming.turns),
    [...current.sessions, ...incoming.sessions],
  );
  return `${before}\n${merged}\n${after}`;
}

function turnTime(line: string): string | null {
  const match = /^- (\d{2}:\d{2}) /.exec(line);
  return match?.[1] ?? null;
}

/**
 * Merge turn lines: keep chronological order and drop exact repeats (a crash
 * between the journal write and the page write replays the same turn).
 */
export function mergeTurnLines(existing: string[], incoming: string[]): string[] {
  const merged = [...existing];
  for (const line of incoming) {
    if (merged.includes(line)) continue;
    const time = turnTime(line);
    let at = merged.length;
    if (time !== null) {
      const later = merged.findIndex((other) => {
        const otherTime = turnTime(other);
        return otherTime !== null && otherTime > time;
      });
      if (later !== -1) at = later;
    }
    merged.splice(at, 0, line);
  }
  return merged;
}

/**
 * Split one auto block into its turn lines and contributing sessions.
 * Older pages carry a single `_session: <id>_` trailer; merged pages carry a
 * comma-separated list under the same label.
 */
function parseBlock(text: string): { turns: string[]; sessions: string[] } {
  const body = text.replace(AUTO_START, "").replace(AUTO_END, "");
  const turns: string[] = [];
  const sessions: string[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trimEnd();
    if (!line) continue;
    const trailer = /^_session:\s*(.*)_$/.exec(line);
    if (trailer?.[1]) {
      for (const part of trailer[1].split(",")) {
        const id = part.trim();
        if (id) sessions.push(id);
      }
      continue;
    }
    turns.push(line);
  }
  return { turns, sessions };
}

function formatBlock(turns: string[], sessions: string[]): string {
  const unique = [...new Set(sessions.filter(Boolean))];
  if (unique.length === 0) return turns.join("\n");
  return [...turns, "", `_session: ${unique.join(", ")}_`].join("\n");
}

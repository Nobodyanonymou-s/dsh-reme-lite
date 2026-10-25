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

/**
 * @typedef {{ role: "user" | "assistant", text: string, at: string }} Turn
 */

/** @param {string} value */
export function shortHash(value) {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

/**
 * @param {string} sessionId
 */
export function dialogFileName(sessionId) {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return `${safe || "session"}-${shortHash(sessionId)}.jsonl`;
}

/** @param {Date} date */
export function dateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * @param {string} text
 * @param {number} [max]
 */
export function excerpt(text, max = 140) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export class Capture {
  /**
   * @param {{ root: string, interval?: number, timeZone?: string }} options
   */
  constructor(options) {
    this.root = options.root;
    this.interval = Math.max(1, options.interval ?? 5);
    /** @type {Map<string, Turn[]>} */
    this.buffers = new Map();
    /** @type {Map<string, string>} */
    this.lastHash = new Map();
    this.droppedDuplicates = 0;
    this.capturedTurns = 0;
  }

  get pending() {
    let total = 0;
    for (const turns of this.buffers.values()) total += turns.length;
    return total;
  }

  /**
   * Record one completed turn. Returns true when a durable write happened.
   * @param {string} sessionId
   * @param {Turn} turn
   */
  async record(sessionId, turn) {
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
   * @param {string} sessionId
   */
  async flush(sessionId) {
    const turns = this.buffers.get(sessionId);
    if (!turns || turns.length === 0) return null;
    this.buffers.set(sessionId, []);

    /** @type {Map<string, Turn[]>} */
    const byDate = new Map();
    for (const turn of turns) {
      const key = dateKey(new Date(turn.at));
      byDate.set(key, [...(byDate.get(key) ?? []), turn]);
    }

    /** @type {string[]} */
    const written = [];
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
  async flushAll() {
    /** @type {string[]} */
    const written = [];
    for (const sessionId of [...this.buffers.keys()]) {
      const result = await this.flush(sessionId);
      if (result) written.push(...result);
    }
    return written;
  }

  stats() {
    return {
      sessions: this.buffers.size,
      pending: this.pending,
      capturedTurns: this.capturedTurns,
      droppedDuplicates: this.droppedDuplicates,
    };
  }
}

/**
 * @param {Turn[]} turns
 * @param {string} sessionId
 */
function buildAutoBlock(turns, sessionId) {
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
 * Replace the auto block in place, or append one. Text outside the block is
 * preserved byte for byte.
 * @param {string} existing
 * @param {string} block
 */
export function upsertAutoBlock(existing, block) {
  const start = existing.indexOf(AUTO_START);
  const end = existing.indexOf(AUTO_END);
  if (start !== -1 && end !== -1 && end > start) {
    const before = existing.slice(0, start + AUTO_START.length);
    const after = existing.slice(end);
    return `${before}\n${block}\n${after}`;
  }
  const trimmed = existing.replace(/\n+$/, "");
  return `${trimmed}\n\n${AUTO_START}\n${block}\n${AUTO_END}\n`;
}

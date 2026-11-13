/**
 * Turn-shaped capture: what a session event means, and which slice of it
 * deserves the daily page.
 *
 * The Host emits one `assistant/message` per model step, so a single turn can
 * carry several of them — the narration between tool calls included. The
 * transcript keeps every step; the daily page keeps only the user's words and
 * each turn's final reply. `TurnCapture` is the buffer that tells the two
 * apart: it journals assistant steps as they arrive and holds the daily
 * projection back until the turn closes.
 */

import { Capture } from "./capture.ts";
import type { Turn } from "./capture.ts";

/** Writer identity this plugin stamps on its own injections. */
export const SOURCE = "node-memory";

/** Narrow an unknown value to a record without asserting anything about its shape. */
export function textOfRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function textOf(data: any): string {
  if (typeof data?.text === "string") return data.text;
  const content = data?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && (part.type === "text" || typeof part.text === "string"))
      .map((part) => String(part.text ?? ""))
      .join("")
      .trim();
  }
  return "";
}

/**
 * The source kind a message declares for itself, or null when it declares
 * none. The Host stamps a real prompt `{ kind: "user" }`; harness-injected
 * context — time samples, runtime snapshots, schedule reminders, skill and
 * AGENTS.md instructions — each carries its own kind. No declaration means an
 * older host that never stamped anything, which callers treat as human rather
 * than risk dropping a real question (too much beats too little).
 */
export function sourceKindOf(message: unknown): string | null {
  const kind = textOfRecord(textOfRecord(message)?.source)?.kind;
  return typeof kind === "string" ? kind : null;
}

/**
 * Extract a capturable turn from a session event, tolerating payload shapes.
 */
export function turnFromEvent(event: unknown): Turn | null {
  const record = textOfRecord(event);
  const type = typeof record?.type === "string" ? record.type : "";
  const role: Turn["role"] | null = type.startsWith("user/")
    ? "user"
    : type.startsWith("assistant/")
      ? "assistant"
      : null;
  if (!role) return null;
  const data = textOfRecord(record?.data) ?? {};
  // `user/message` carries the message directly; `assistant/message` wraps it in
  // `data.message` and puts the raw stream in `data.stream`. Getting this wrong
  // silently captures nothing, which is worse than crashing.
  const message = role === "assistant" ? (textOfRecord(data.message) ?? data) : data;
  const messageSource = textOfRecord(message.source);
  if (messageSource?.kind === SOURCE) return null;
  if (messageSource?.plugin === SOURCE) return null;
  const text = textOf(message);
  if (!text) return null;
  const eventTime = record?.time;
  const messageTime = message.time;
  const at =
    typeof eventTime === "string"
      ? eventTime
      : typeof messageTime === "string"
        ? messageTime
        : new Date().toISOString();
  return { role, text, at, sourceKind: sourceKindOf(message) };
}

/** One assistant reply held back from the daily page until its turn closes. */
interface Staged {
  turn: Turn;
  /** Host turn number, when the event carried one; null on hosts without it. */
  number: number | null;
}

export class TurnCapture {
  #capture: Capture;
  /** One staged reply per session: the latest assistant step of the open turn. */
  #staged: Map<string, Staged> = new Map();
  /** Per-session event queue: staging and settling must see events in order. */
  #queues: Map<string, Promise<unknown>> = new Map();

  constructor(capture: Capture) {
    this.#capture = capture;
  }

  /**
   * Feed one session event through the capture path. Assistant steps are only
   * staged — each one still lands in the transcript immediately — and the daily
   * page is written when the turn closes, by `turn/end` or, on hosts that never
   * send it, by the next user message.
   *
   * Events arrive one at a time but their handling is async, so they queue per
   * session: a `turn/end` that overtook the step it closes would find nothing
   * staged and the turn's reply would be lost. The rejection goes to the caller;
   * the queue itself keeps flowing so one bad event cannot wedge the session.
   */
  ingest(sessionId: string, event: unknown): Promise<void> {
    const run = (this.#queues.get(sessionId) ?? Promise.resolve()).then(() =>
      this.#consume(sessionId, event),
    );
    this.#queues.set(sessionId, run.catch(() => {}));
    return run;
  }

  async #consume(sessionId: string, event: unknown): Promise<void> {
    const record = textOfRecord(event);
    const type = typeof record?.type === "string" ? record.type : "";
    const data = textOfRecord(record?.data) ?? {};

    if (type === "turn/end") {
      const ended = typeof data.turn === "number" ? data.turn : null;
      await this.#settle(sessionId, (staged) => ended === null || staged.number === null || staged.number <= ended);
      return;
    }

    const turn = turnFromEvent(event);
    if (!turn) return; // tool calls and our own injections settle nothing

    if (turn.role === "user") {
      // Shaped like a user message is not the same as said by the user:
      // harness-injected context (time samples, runtime snapshots, schedule
      // reminders) journals as ground truth but is nobody's question, so it
      // neither settles a staged reply nor reaches the daily page. An absent
      // source means an older host — read it as human, too much beats too
      // little.
      const kind = turn.sourceKind ?? null;
      const human = kind === null || kind === "user";
      if (human) {
        // Settle first: on a host without turn/end this message is the only
        // boundary left, and the staged reply answers the previous question —
        // it must land on the page before this question does, even when both
        // fall in the same minute.
        await this.#settle(sessionId, () => true);
      }
      // The journal is ground truth and takes everything, injections included.
      await this.#capture.journal(sessionId, turn);
      if (human) await this.#capture.project(sessionId, turn);
      return;
    }

    if (data.interrupted === true) {
      // An interrupted turn is a half answer: it stays in the transcript and
      // off the daily page, marker line included. Anything staged is an
      // earlier step of the turn being cut off, so it goes too.
      await this.#capture.journal(sessionId, turn);
      this.#staged.delete(sessionId);
      return;
    }

    // Every step reaches the transcript as it happens; only the latest one
    // waits for the turn to close before it reaches the daily page.
    await this.#capture.journal(sessionId, turn);
    const number = typeof data.turn === "number" ? data.turn : null;
    const staged = this.#staged.get(sessionId);
    if (staged && staged.number !== null && number !== null && number > staged.number) {
      // A new turn began without a turn/end: the staged reply is the previous
      // turn's last word and must not be overwritten by this one.
      await this.#settle(sessionId, () => true);
    }
    // A later step of the same turn replaces the earlier one — the page wants
    // the conclusion, not the narration on the way to it.
    this.#staged.set(sessionId, { turn, number });
  }

  /**
   * Settle every staged reply, then drain the projection. Shutdown order
   * matters twice over: the queue first, or a step still being journaled has
   * not staged its reply yet; the settle pass next, or the turn in flight
   * loses its answer.
   */
  async flushAll(): Promise<string[]> {
    await Promise.all([...this.#queues.values()]);
    for (const sessionId of [...this.#staged.keys()]) {
      await this.#settle(sessionId, () => true);
    }
    return this.#capture.flushAll();
  }

  /** Project the staged reply into the daily page when it belongs there. */
  async #settle(sessionId: string, belongs: (staged: Staged) => boolean): Promise<void> {
    const staged = this.#staged.get(sessionId);
    if (!staged || !belongs(staged)) return;
    this.#staged.delete(sessionId);
    await this.#capture.project(sessionId, staged.turn);
  }
}

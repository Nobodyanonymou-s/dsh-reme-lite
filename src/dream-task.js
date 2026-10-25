/**
 * The consolidation task record.
 *
 * Turning the switch off must PAUSE the task, never delete it: the history of
 * what ran and what failed is part of the memory system's own record, and a
 * user who flips the switch back on should find their schedule intact.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { nextRun } from "./schedule.js";

export const TASK_ID = "dream";
export const DEFAULT_CRON = "0 23 * * *";
const MAX_RUNS = 20;

/**
 * @typedef {object} DreamRun
 * @property {string} at
 * @property {"ok" | "error" | "skipped"} status
 * @property {string} [detail]
 *
 * @typedef {object} DreamState
 * @property {string} id
 * @property {boolean} enabled
 * @property {string} cron
 * @property {string | null} timeZone
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string | null} pausedAt
 * @property {string | null} lastRunAt
 * @property {"ok" | "error" | "skipped" | null} lastStatus
 * @property {string | null} lastError
 * @property {string | null} nextRunAt
 * @property {DreamRun[]} runs
 */

/** @param {Partial<DreamState>} [input] @returns {DreamState} */
export function defaultState(input = {}) {
  const now = new Date().toISOString();
  return {
    id: TASK_ID,
    enabled: false,
    cron: input.cron ?? DEFAULT_CRON,
    timeZone: input.timeZone ?? null,
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    pausedAt: null,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    nextRunAt: null,
    runs: [],
    ...input,
    id: TASK_ID,
  };
}

export class DreamTaskStore {
  /** @param {{ root: string }} options */
  constructor(options) {
    this.root = options.root;
    this.file = join(this.root, "metadata", "dream-task.json");
  }

  /**
   * Missing or corrupt task files fall back to a disabled default instead of
   * throwing: a broken metadata file must never stop DSH from starting.
   * @returns {Promise<DreamState>}
   */
  async load() {
    try {
      const text = await readFile(this.file, "utf8");
      const parsed = JSON.parse(text);
      return defaultState({
        ...parsed,
        runs: Array.isArray(parsed.runs) ? parsed.runs.slice(-MAX_RUNS) : [],
      });
    } catch {
      return defaultState();
    }
  }

  /** @param {DreamState} state */
  async save(state) {
    const next = { ...state, updatedAt: new Date().toISOString() };
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(temporary, this.file);
    return next;
  }

  /**
   * Switch on: create (or resume) the task and compute its next run.
   * @param {{ cron?: string, timeZone?: string | null, from?: Date }} [options]
   */
  async enable(options = {}) {
    const current = await this.load();
    const cron = options.cron ?? current.cron ?? DEFAULT_CRON;
    const timeZone = options.timeZone ?? current.timeZone ?? null;
    const from = options.from ?? new Date();
    const state = {
      ...current,
      enabled: true,
      cron,
      timeZone,
      pausedAt: null,
      nextRunAt: nextRun(cron, { from, timeZone: timeZone ?? undefined })?.toISOString() ?? null,
    };
    return this.save(state);
  }

  /**
   * Switch off: stop, keep everything.
   * @param {{ reason?: string }} [options]
   */
  async disable() {
    const current = await this.load();
    return this.save({
      ...current,
      enabled: false,
      pausedAt: new Date().toISOString(),
      nextRunAt: null,
    });
  }

  /**
   * @param {{ status: "ok" | "error" | "skipped", detail?: string, from?: Date }} result
   */
  async recordRun(result) {
    const current = await this.load();
    const at = new Date().toISOString();
    const runs = [...current.runs, { at, status: result.status, detail: result.detail }].slice(
      -MAX_RUNS,
    );
    const from = result.from ?? new Date();
    return this.save({
      ...current,
      lastRunAt: at,
      lastStatus: result.status,
      lastError: result.status === "error" ? (result.detail ?? "unknown error") : null,
      runs,
      nextRunAt: current.enabled
        ? (nextRun(current.cron, { from, timeZone: current.timeZone ?? undefined })?.toISOString() ??
          null)
        : null,
    });
  }

  /**
   * @param {DreamState} state
   * @param {Date} [now]
   */
  isDue(state, now = new Date()) {
    if (!state.enabled) return false;
    if (!state.nextRunAt) return true;
    const due = Date.parse(state.nextRunAt);
    return Number.isFinite(due) && due <= now.getTime();
  }
}

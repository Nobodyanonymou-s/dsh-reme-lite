/**
 * The consolidation task record.
 *
 * Turning the switch off must PAUSE the task, never delete it: the history of
 * what ran and what failed is part of the memory system's own record, and a
 * user who flips the switch back on should find their schedule intact.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { nextRun } from "./schedule.ts";

export const TASK_ID = "dream";
export const DEFAULT_CRON = "0 23 * * *";
const MAX_RUNS = 20;

export interface DreamRun {
  at: string;
  status: "ok" | "error" | "skipped";
  detail?: string;
}

export interface DreamState {
  id: string;
  enabled: boolean;
  cron: string;
  timeZone: string | null;
  createdAt: string;
  updatedAt: string;
  pausedAt: string | null;
  lastRunAt: string | null;
  lastStatus: "ok" | "error" | "skipped" | null;
  lastError: string | null;
  nextRunAt: string | null;
  runs: DreamRun[];
  /** Written by bindHostReminder when the Host owns the delivery arm. */
  hostScheduleId?: string | null;
  hostSessionId?: string | null;
}

export function defaultState(input: Partial<DreamState> = {}): DreamState {
  const now = new Date().toISOString();
  return {
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
    // The task id is fixed; an input carrying a different id is ignored.
    id: TASK_ID,
  };
}

export class DreamTaskStore {
  root: string;
  file: string;

  constructor(options: { root: string }) {
    this.root = options.root;
    this.file = join(this.root, "metadata", "dream-task.json");
  }

  /**
   * Missing or corrupt task files fall back to a disabled default instead of
   * throwing: a broken metadata file must never stop DSH from starting.
   */
  async load(): Promise<DreamState> {
    try {
      const text = await readFile(this.file, "utf8");
      const parsed = JSON.parse(text) as Partial<DreamState>;
      return defaultState({
        ...parsed,
        runs: Array.isArray(parsed.runs) ? parsed.runs.slice(-MAX_RUNS) : [],
      });
    } catch {
      return defaultState();
    }
  }

  async save(state: DreamState): Promise<DreamState> {
    const next = { ...state, updatedAt: new Date().toISOString() };
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(temporary, this.file);
    return next;
  }

  /**
   * Switch on: create (or resume) the task and compute its next run.
   */
  async enable(options: { cron?: string; timeZone?: string | null; from?: Date } = {}): Promise<DreamState> {
    const current = await this.load();
    const cron = options.cron ?? current.cron ?? DEFAULT_CRON;
    const timeZone = options.timeZone ?? current.timeZone ?? null;
    const from = options.from ?? new Date();
    const state: DreamState = {
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
   */
  async disable(): Promise<DreamState> {
    const current = await this.load();
    return this.save({
      ...current,
      enabled: false,
      pausedAt: new Date().toISOString(),
      nextRunAt: null,
    });
  }

  async recordRun(result: { status: "ok" | "error" | "skipped"; detail?: string; from?: Date }): Promise<DreamState> {
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

  isDue(state: DreamState, now: Date = new Date()): boolean {
    if (!state.enabled) return false;
    if (!state.nextRunAt) return true;
    const due = Date.parse(state.nextRunAt);
    return Number.isFinite(due) && due <= now.getTime();
  }
}

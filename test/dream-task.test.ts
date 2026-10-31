import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";

import { DreamTaskStore, defaultState } from "../src/dream-task.ts";

async function store(): Promise<{ root: string; tasks: DreamTaskStore }> {
  const root = await mkdtemp(join(tmpdir(), "mem-task-"));
  return { root, tasks: new DreamTaskStore({ root }) };
}

it("a missing task file yields a disabled default", async () => {
  const { tasks } = await store();
  const state = await tasks.load();
  assert.equal(state.enabled, false);
  assert.equal(state.id, "dream");
  assert.deepEqual(state.runs, []);
});

it("enable creates the task with a computed next run", async () => {
  const { tasks } = await store();
  const state = await tasks.enable({
    cron: "0 23 * * *",
    timeZone: "Asia/Shanghai",
    from: new Date("2026-10-25T10:00:00Z"),
  });
  assert.equal(state.enabled, true);
  assert.equal(state.cron, "0 23 * * *");
  assert.equal(state.nextRunAt, "2026-10-25T15:00:00.000Z");
  assert.equal(state.pausedAt, null);
});

it("disable pauses without deleting history", async () => {
  const { tasks } = await store();
  await tasks.enable({ from: new Date("2026-10-25T10:00:00Z") });
  await tasks.recordRun({ status: "ok", detail: "4 files" });
  const before = await tasks.load();

  const off = await tasks.disable();
  assert.equal(off.enabled, false);
  assert.equal(off.nextRunAt, null);
  assert.ok(off.pausedAt, "pausedAt is recorded");
  assert.equal(off.createdAt, before.createdAt, "createdAt survives the pause");
  assert.equal(off.lastRunAt, before.lastRunAt, "last run survives the pause");
  assert.equal(off.runs.length, 1, "run history survives the pause");
  assert.equal(off.cron, before.cron, "schedule definition survives the pause");

  // Re-enabling resumes the same record rather than starting over.
  const again = await tasks.enable({ from: new Date("2026-10-26T10:00:00Z") });
  assert.equal(again.createdAt, before.createdAt);
  assert.equal(again.runs.length, 1);
});

it("runs are recorded, trimmed and advance the schedule", async () => {
  const { tasks } = await store();
  await tasks.enable({ from: new Date("2026-10-25T10:00:00Z") });
  const state = await tasks.recordRun({
    status: "ok",
    detail: "wrote digest/wiki/x.md",
    from: new Date("2026-10-25T15:00:01Z"),
  });
  assert.equal(state.lastStatus, "ok");
  assert.equal(state.lastError, null);
  assert.equal(state.runs.length, 1);
  assert.equal(state.nextRunAt, "2026-10-26T15:00:00.000Z");

  for (let i = 0; i < 25; i += 1) {
    await tasks.recordRun({ status: "skipped", from: new Date("2026-10-25T15:00:01Z") });
  }
  const trimmed = await tasks.load();
  assert.equal(trimmed.runs.length, 20);
});

it("failures keep the error and the task stays enabled", async () => {
  const { tasks } = await store();
  await tasks.enable({ from: new Date("2026-10-25T10:00:00Z") });
  const state = await tasks.recordRun({ status: "error", detail: "agent unavailable" });
  assert.equal(state.enabled, true);
  assert.equal(state.lastStatus, "error");
  assert.equal(state.lastError, "agent unavailable");
});

it("a corrupt task file degrades to disabled instead of throwing", async () => {
  const { root, tasks } = await store();
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(join(root, "metadata"), { recursive: true });
  await writeFile(join(root, "metadata", "dream-task.json"), "{ not json", "utf8");
  const state = await tasks.load();
  assert.equal(state.enabled, false);
});

it("isDue respects the switch and the clock", async () => {
  const { tasks } = await store();
  const off = defaultState();
  assert.equal(tasks.isDue(off, new Date()), false);

  const on = defaultState({
    enabled: true,
    nextRunAt: "2026-10-25T15:00:00.000Z",
  });
  assert.equal(tasks.isDue(on, new Date("2026-10-25T14:59:00Z")), false);
  assert.equal(tasks.isDue(on, new Date("2026-10-25T15:00:00Z")), true);
});

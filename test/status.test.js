import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildDays, buildStatus, KINDS, normalizeKind } from "../src/status.js";

/** @param {string} root @param {string} rel @param {string} body @param {string} [frontmatter] */
async function put(root, rel, body, frontmatter = "") {
  const absolute = join(root, rel);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, `---\n${frontmatter}---\n\n${body}\n`, "utf8");
}

test("unknown kinds degrade to normal", () => {
  assert.equal(normalizeKind("conflict"), "conflict");
  assert.equal(normalizeKind("nonsense"), "normal");
  assert.equal(normalizeKind(undefined), "normal");
  assert.deepEqual(KINDS, ["normal", "notable", "user-declared", "conflict"]);
});

test("a day takes the strongest kind it contains", async () => {
  const root = await mkdtemp(join(tmpdir(), "mem-status-"));
  await put(root, "daily/2026-10-20.md", "a", "kind: notable\n");
  await put(root, "daily/2026-10-20/x.md", "b", "kind: normal\n");
  await put(root, "digest/wiki/y.md", "c", "kind: conflict\nupdated: 2026-10-20\n");

  const days = await buildDays(root);
  const day = days.find((entry) => entry.date === "2026-10-20");
  assert.ok(day);
  assert.equal(day.total, 3);
  assert.equal(day.kind, "conflict", "red wins over blue and green");
  assert.equal(day.kinds.notable, 1);
});

test("dates come from the path, or from frontmatter for digest nodes", async () => {
  const root = await mkdtemp(join(tmpdir(), "mem-status2-"));
  await put(root, "daily/2026-10-19.md", "x");
  await put(root, "digest/personal/pref.md", "y", "updated: 2026-10-18\n");

  const days = await buildDays(root);
  assert.deepEqual(
    days.map((entry) => entry.date),
    ["2026-10-18", "2026-10-19"],
    "sorted ascending",
  );
  assert.equal(days[1].kind, "normal");
});

test("status payload carries the task snapshot and is ordered", async () => {
  const root = await mkdtemp(join(tmpdir(), "mem-status3-"));
  await put(root, "daily/2026-10-01.md", "a", "kind: user-declared\n");
  await put(root, "daily/2026-10-03.md", "b");

  const status = await buildStatus({
    root,
    task: { enabled: true, cron: "0 23 * * *", runs: 2 },
  });
  assert.equal(status.days.length, 2);
  assert.deepEqual(status.days.map((entry) => entry.date), ["2026-10-01", "2026-10-03"]);
  assert.equal(status.days[0].kind, "user-declared");
  assert.equal(status.task.cron, "0 23 * * *");
  assert.ok(status.generatedAt);
  assert.deepEqual(status.kinds, KINDS);
  assert.equal(status.total, 2, "total counts memory entries, not files touched");
  assert.equal(status.workspace, root);
});

test("an empty workspace yields an empty heatmap, not an error", async () => {
  const root = await mkdtemp(join(tmpdir(), "mem-status4-"));
  const status = await buildStatus({ root });
  assert.deepEqual(status.days, []);
});

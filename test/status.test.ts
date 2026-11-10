import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";

import { writeRepresentation } from "../src/links.ts";
import { renderNode } from "../src/markdown.ts";
import { MemoryStore } from "../src/store.ts";
import { buildDays, buildStatus, KINDS, normalizeKind } from "../src/status.ts";

/** @param {string} root @param {string} rel @param {string} body @param {string} [frontmatter] */
async function put(root: string, rel: string, body: string, frontmatter = ""): Promise<void> {
  const absolute = join(root, rel);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, `---\n${frontmatter}---\n\n${body}\n`, "utf8");
}

it("unknown kinds degrade to normal", () => {
  assert.equal(normalizeKind("conflict"), "conflict");
  assert.equal(normalizeKind("nonsense"), "normal");
  assert.equal(normalizeKind(undefined), "normal");
  assert.deepEqual(KINDS, ["normal", "notable", "user-declared", "conflict"]);
});

it("a day takes the strongest kind it contains", async () => {
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

it("dates come from the path, or from frontmatter for digest nodes", async () => {
  const root = await mkdtemp(join(tmpdir(), "mem-status2-"));
  await put(root, "daily/2026-10-19.md", "x");
  await put(root, "digest/personal/pref.md", "y", "updated: 2026-10-18\n");

  const days = await buildDays(root);
  assert.deepEqual(
    days.map((entry) => entry.date),
    ["2026-10-18", "2026-10-19"],
    "sorted ascending",
  );
  assert.equal(days[1]!.kind, "normal");
});

it("a digest node without a date still lands on the day it was written", async () => {
  const root = await mkdtemp(join(tmpdir(), "mem-status5-"));
  const absolute = join(root, "digest/wiki/old.md");
  await put(root, "digest/wiki/old.md", "x", "kind: conflict\n");
  const written = new Date("2026-10-14T20:30:00");
  await utimes(absolute, written, written);

  const days = await buildDays(root);
  assert.equal(days.length, 1, "the node is not dropped from the calendar");
  assert.equal(days[0]!.date, "2026-10-14");
  assert.equal(days[0]!.kind, "conflict", "its colour survives");
});

it("status payload carries the task snapshot and is ordered", async () => {
  const root = await mkdtemp(join(tmpdir(), "mem-status3-"));
  await put(root, "daily/2026-10-01.md", "a", "kind: user-declared\n");
  await put(root, "daily/2026-10-03.md", "b");

  const status = await buildStatus({
    root,
    task: { enabled: true, cron: "0 23 * * *", runs: 2 },
  });
  assert.equal(status.days.length, 2);
  assert.deepEqual(status.days.map((entry) => entry.date), ["2026-10-01", "2026-10-03"]);
  assert.equal(status.days[0]!.kind, "user-declared");
  assert.equal((status.task as { cron?: string }).cron, "0 23 * * *");
  assert.ok(status.generatedAt);
  assert.deepEqual(status.kinds, KINDS);
  assert.equal(status.total, 2, "total counts memory entries, not files touched");
  assert.equal(status.workspace, root);
});

it("an empty workspace yields an empty heatmap, not an error", async () => {
  const root = await mkdtemp(join(tmpdir(), "mem-status4-"));
  const status = await buildStatus({ root });
  assert.deepEqual(status.days, []);
});

/**
 * The health fixture: one node with a dangling link, one orphan, a
 * near-duplicate pair (the two differ by one character, which keeps their
 * Jaccard above 0.8), and a daily page that links into the digest.
 */
async function makeHealthWorkspace(): Promise<{ root: string; store: MemoryStore }> {
  const root = await mkdtemp(join(tmpdir(), "mem-health-"));
  const store = new MemoryStore({ root });
  const entries: Array<{ relPath: string; name: string; description?: string; body: string }> = [
    {
      relPath: "digest/wiki/发布流程.md",
      name: "发布流程",
      description: "发布窗口",
      body: "发布流程的窗口在周五，回滚见 [[不存在目标]]，细节见 [[重复甲]]。\n",
    },
    {
      relPath: "digest/personal/孤儿笔记.md",
      name: "孤儿笔记",
      description: "没有人链接",
      body: "孤儿笔记只被写下来，从未被谁链接，见 [[发布流程]]。\n",
    },
    {
      relPath: "digest/wiki/重复甲.md",
      name: "重复甲",
      description: "铁律",
      body: "顶点计划的三条铁律：先对齐口径，再动手实现，最后交付样机并记录踩坑。\n",
    },
    {
      relPath: "digest/wiki/重复乙.md",
      name: "重复乙",
      description: "铁律",
      body: "顶点计划的三条铁律：先对齐口径，再动手实现，最后交付样机并记录坑点。\n",
    },
    { relPath: "daily/2026-11-01.md", name: "2026-11-01", body: "今天的日志，链接 [[发布流程]]。\n" },
  ];
  for (const entry of entries) {
    await store.write({
      relPath: entry.relPath,
      content: renderNode({ name: entry.name, description: entry.description, updated: "2026-11-01" }, entry.body),
    });
  }
  await store.rebuild();
  return { root, store };
}

it("digest health reports bloat, dangling links, orphans, and near-duplicates", async () => {
  const { root, store } = await makeHealthWorkspace();
  await writeRepresentation(store); // generates digest/index.md and metadata/links.json

  const status = await buildStatus({
    root,
    store,
    task: { enabled: true, lastRunAt: "2026-11-08T15:00:00.000Z" },
  });
  const digest = status.digest;
  assert.equal(digest.nodes, 4, "the daily page is not a digest node");
  assert.deepEqual(digest.byDir, { personal: 1, wiki: 3 });
  assert.equal(digest.danglingLinks, 1, "[[不存在目标]] resolves to nothing");
  assert.equal(digest.orphanNodes, 2, "重复乙 and 孤儿笔记 have no inbound link — daily links count as inbound");
  assert.equal(digest.nearDuplicates, 1, "one pair over the 0.8 Jaccard line");
  assert.equal(digest.lastDreamAt, "2026-11-08T15:00:00.000Z", "no second source of truth for the last run");

  // Full text of the four nodes, frontmatter included, generated page excluded.
  const texts = await Promise.all(
    [
      "digest/wiki/发布流程.md",
      "digest/personal/孤儿笔记.md",
      "digest/wiki/重复甲.md",
      "digest/wiki/重复乙.md",
    ].map((rel) => readFile(join(root, rel), "utf8")),
  );
  assert.equal(digest.chars, texts.reduce((sum, text) => sum + text.length, 0));

  assert.equal(digest.indexPage?.path, "digest/index.md");
  assert.ok((digest.indexPage?.chars ?? 0) > 0, "the generated page reports its own size");
  // And it stays out of the heatmap and the total as well.
  assert.equal(status.total, 5, "four digest nodes plus one daily page");
  assert.deepEqual(status.days.map((day) => day.date), ["2026-11-01"]);
});

it("without a store the graph-derived numbers are null and the rest still report", async () => {
  const { root } = await makeHealthWorkspace();
  const status = await buildStatus({ root });
  assert.equal(status.digest.nodes, 4);
  assert.deepEqual(status.digest.byDir, { personal: 1, wiki: 3 });
  assert.ok(status.digest.chars > 0);
  assert.equal(status.digest.danglingLinks, null);
  assert.equal(status.digest.orphanNodes, null);
  assert.equal(status.digest.nearDuplicates, null);
  assert.equal(status.digest.lastDreamAt, null);
});

it("an empty workspace reports an all-zero, all-null digest without throwing", async () => {
  const root = await mkdtemp(join(tmpdir(), "mem-health-empty-"));
  // No store: the graph-derived numbers cannot exist, so they are null — the
  // fields themselves must still be present.
  assert.deepEqual((await buildStatus({ root })).digest, {
    nodes: 0,
    chars: 0,
    byDir: {},
    indexPage: null,
    danglingLinks: null,
    orphanNodes: null,
    nearDuplicates: null,
    lastDreamAt: null,
  });
  // With a live (empty) index, zero really is zero, not an unknown.
  assert.deepEqual((await buildStatus({ root, store: new MemoryStore({ root }) })).digest, {
    nodes: 0,
    chars: 0,
    byDir: {},
    indexPage: null,
    danglingLinks: 0,
    orphanNodes: 0,
    nearDuplicates: 0,
    lastDreamAt: null,
  });
});

it("the payload carries aggregates only — no node text and no link targets", async () => {
  const { root, store } = await makeHealthWorkspace();
  const json = JSON.stringify(await buildStatus({ root, store }));
  assert.ok(!json.includes("踩坑"), "near-duplicate body text must not travel");
  assert.ok(!json.includes("不存在目标"), "a dangling target's spelling must not travel either");
  assert.ok(!json.includes("孤儿笔记"), "node names are content too");
});

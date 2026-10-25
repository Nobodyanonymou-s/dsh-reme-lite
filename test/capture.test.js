import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_END,
  AUTO_START,
  Capture,
  dateKey,
  excerpt,
  upsertAutoBlock,
} from "../src/capture.js";

test("auto block replaces itself and leaves human text alone", () => {
  const existing = [
    "---",
    "name: 2026-10-25",
    "---",
    "",
    "我自己的笔记：周五部署。",
    "",
    AUTO_START,
    "- old line",
    AUTO_END,
    "",
    "尾部：人工补充。",
    "",
  ].join("\n");

  const next = upsertAutoBlock(existing, "- new line");
  assert.ok(next.includes("new line"));
  assert.ok(next.includes("我自己的笔记：周五部署。"));
  assert.ok(next.includes("尾部：人工补充。"));
  assert.equal(next.split(AUTO_START).length, 2, "exactly one auto block");
  assert.ok(!next.includes("old line"));
});

test("auto block is appended when the page has none", () => {
  const next = upsertAutoBlock("# 手写页面\n\n正文", "- captured");
  assert.ok(next.startsWith("# 手写页面"));
  assert.ok(next.includes(AUTO_START));
  assert.ok(next.trimEnd().endsWith(AUTO_END));
});

test("capture flushes on interval and dedupes repeats", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readFile } = await import("node:fs/promises");

  const root = await mkdtemp(join(tmpdir(), "mem-capture-"));
  const capture = new Capture({ root, interval: 2 });
  const at = new Date().toISOString();

  assert.equal(await capture.record("s1", { role: "user", text: "部署窗口是周五", at }), true);
  assert.equal(await capture.record("s1", { role: "user", text: "部署窗口是周五", at }), false);
  await capture.record("s1", { role: "assistant", text: "已记录", at });

  const page = join(root, "daily", `${dateKey(new Date(at))}.md`);
  const text = await readFile(page, "utf8");
  assert.ok(text.includes("- 部署窗口是周五") || text.includes("部署窗口是周五"));
  assert.ok(text.includes(AUTO_START));
  assert.equal(capture.pending, 0);
  assert.equal(capture.droppedDuplicates, 1);
});

test("excerpt collapses whitespace and truncates", () => {
  assert.equal(excerpt("a\n\n  b"), "a b");
  assert.equal(excerpt("x".repeat(10), 5), "xxxx…");
});

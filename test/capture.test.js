import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AUTO_END,
  AUTO_START,
  Capture,
  dateKey,
  excerpt,
  mergeTurnLines,
  upsertAutoBlock,
} from "../src/capture.js";

test("auto block merges new turns instead of replacing the day", () => {
  const existing = [
    "---",
    "name: 2026-10-25",
    "---",
    "",
    "我自己的笔记：周五部署。",
    "",
    AUTO_START,
    "- 10:00 **assistant**: old line",
    "",
    "_session: aaaa_",
    AUTO_END,
    "",
    "尾部：人工补充。",
    "",
  ].join("\n");

  const next = upsertAutoBlock(existing, "- 12:30 **assistant**: new line\n\n_session: bbbb_");
  assert.ok(next.includes("old line"), "an earlier session's turn survives");
  assert.ok(next.includes("new line"));
  assert.ok(next.includes("我自己的笔记：周五部署。"));
  assert.ok(next.includes("尾部：人工补充。"));
  assert.equal(next.split(AUTO_START).length, 2, "exactly one auto block");
  assert.match(next, /_session: aaaa, bbbb_/, "both contributors are recorded");
});

test("merged turns stay in chronological order", () => {
  const existing = [`${AUTO_START}`, "- 12:00 **user**: 中午", "", "_session: aaaa_", AUTO_END].join("\n");
  const next = upsertAutoBlock(existing, "- 09:00 **user**: 早上\n- 14:00 **user**: 下午\n\n_session: bbbb_");
  assert.ok(next.indexOf("早上") < next.indexOf("中午"));
  assert.ok(next.indexOf("中午") < next.indexOf("下午"));
});

test("merging the same turn twice keeps one line", () => {
  assert.deepEqual(mergeTurnLines(["- 09:00 **user**: x"], ["- 09:00 **user**: x"]), ["- 09:00 **user**: x"]);
});

test("a line without a timestamp cannot be ordered and goes last", () => {
  // A stray non-turn line inside the block (a hand edit, an old format) has no
  // `- HH:MM ` prefix; appending keeps the timed turns in order instead of
  // guessing where it belongs.
  const merged = mergeTurnLines(["- 09:00 **user**: a", "- 12:00 **user**: b"], ["手改的一行"]);
  assert.deepEqual(merged, ["- 09:00 **user**: a", "- 12:00 **user**: b", "手改的一行"]);
});

test("auto block is appended when the page has none", () => {
  const next = upsertAutoBlock("# 手写页面\n\n正文", "- captured");
  assert.ok(next.startsWith("# 手写页面"));
  assert.ok(next.includes(AUTO_START));
  assert.ok(next.trimEnd().endsWith(AUTO_END));
});

test("a second session's flush keeps the first session's turns and hand-written text", async () => {
  const root = await mkdtemp(join(tmpdir(), "mem-capture-"));
  await mkdir(join(root, "daily"), { recursive: true });
  const page = join(root, "daily", "2026-10-28.md");
  await writeFile(page, "---\nname: 2026-10-28\ndescription: auto-captured conversation notes\n---\n\n手写：今天不加班。\n");

  const capture = new Capture({ root, interval: 1 });
  await capture.record("session-aaaa", { role: "user", text: "上午问的", at: "2026-10-28T09:30:00" });
  await capture.record("session-bbbb", { role: "assistant", text: "下午答的", at: "2026-10-28T15:30:00" });

  const text = await readFile(page, "utf8");
  assert.match(text, /手写：今天不加班。/, "human text outside the block is untouched");
  assert.match(text, /上午问的/);
  assert.match(text, /下午答的/);
  assert.match(text, /_session: aaaa, bbbb_/);
  assert.equal(text.split(AUTO_START).length, 2, "one block, not two");
});

test("capture flushes on interval and dedupes repeats", async () => {
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

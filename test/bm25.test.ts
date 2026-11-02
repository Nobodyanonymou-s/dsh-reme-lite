import assert from "node:assert/strict";
import { it } from "vitest";

import { BM25, tokenize } from "../src/bm25.ts";

it("tokenizer mixes latin words and CJK bigrams", () => {
  const tokens = tokenize("PostgreSQL 数据库");
  assert.ok(tokens.includes("postgresql"));
  assert.ok(tokens.includes("数据"));
  assert.ok(tokens.includes("据库"));
});

it("single-character CJK runs survive", () => {
  assert.deepEqual(tokenize("锂"), ["锂"]);
});

it("bm25 ranks the matching document first", () => {
  const index = new BM25();
  index.add({ text: "周报每周五下午四点发出，格式是 Markdown", meta: { id: "report" } });
  index.add({ text: "数据库使用 PostgreSQL，Redis 只做缓存", meta: { id: "db" } });
  index.add({ text: "今天天气不错", meta: { id: "weather" } });

  const [top] = index.search("PostgreSQL 数据库");
  assert.ok(top);
  assert.equal(top.doc.meta.id, "db");
  assert.ok(top.score > 0);
});

it("bm25 finds CJK queries without segmentation", () => {
  const index = new BM25();
  index.add({ text: "部署窗口是周五下午四点", meta: { id: "deploy" } });
  index.add({ text: "周报格式用 Markdown", meta: { id: "report" } });
  const [top] = index.search("部署窗口");
  assert.ok(top);
  assert.equal(top.doc.meta.id, "deploy");
});

it("unmatched and empty queries return nothing", () => {
  const index = new BM25();
  index.add({ text: "alpha", meta: {} });
  assert.deepEqual(index.search("zebra"), []);
  assert.deepEqual(index.search("   "), []);
});

it("minScore filters weak hits", () => {
  const index = new BM25();
  index.add({ text: "alpha beta", meta: { id: "a" } });
  index.add({ text: "alpha gamma", meta: { id: "b" } });
  assert.equal(index.search("alpha").length, 2);
  const strict = index.search("alpha", { minScore: 1000 });
  assert.equal(strict.length, 0);
});

it("removing a document keeps later documents findable", () => {
  const index = new BM25();
  const first = index.add({ text: "回滚 手工脚本", meta: { id: "old" } });
  index.add({ text: "回滚 自动流水线", meta: { id: "new" } });
  const tail = index.add({ text: "回滚 流水线演练", meta: { id: "tail" } });

  assert.equal(index.remove(first), true);
  assert.equal(index.size, 2);

  // The removed text stops matching entirely.
  assert.equal(index.search("手工脚本").length, 0);

  // Survivors stay findable — including the one after the tombstone, whose id
  // no longer sits inside `size`. (Both survivors share the 流水/水线 bigrams,
  // so the query legitimately reaches both; the point is that neither is lost.)
  const rerolled = index.search("自动流水线");
  assert.equal(rerolled.length, 2);
  assert.ok(rerolled.every((hit) => hit.doc.meta.id !== "old"), "the tombstone never matches");
  const drills = index.search("演练");
  assert.equal(drills.length, 1);
  assert.equal(drills[0]!.doc.meta.id, "tail");
  assert.equal(tail, 2, "survivor ids never shift");

  // Removing twice is a no-op.
  assert.equal(index.remove(first), false);
  assert.equal(index.size, 2);
});

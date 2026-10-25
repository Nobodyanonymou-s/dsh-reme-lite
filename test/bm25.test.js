import assert from "node:assert/strict";
import test from "node:test";

import { BM25, tokenize } from "../src/bm25.js";

test("tokenizer mixes latin words and CJK bigrams", () => {
  const tokens = tokenize("PostgreSQL 数据库");
  assert.ok(tokens.includes("postgresql"));
  assert.ok(tokens.includes("数据"));
  assert.ok(tokens.includes("据库"));
});

test("single-character CJK runs survive", () => {
  assert.deepEqual(tokenize("锂"), ["锂"]);
});

test("bm25 ranks the matching document first", () => {
  const index = new BM25();
  index.add({ text: "周报每周五下午四点发出，格式是 Markdown", meta: { id: "report" } });
  index.add({ text: "数据库使用 PostgreSQL，Redis 只做缓存", meta: { id: "db" } });
  index.add({ text: "今天天气不错", meta: { id: "weather" } });

  const [top] = index.search("PostgreSQL 数据库");
  assert.equal(top.doc.meta.id, "db");
  assert.ok(top.score > 0);
});

test("bm25 finds CJK queries without segmentation", () => {
  const index = new BM25();
  index.add({ text: "部署窗口是周五下午四点", meta: { id: "deploy" } });
  index.add({ text: "周报格式用 Markdown", meta: { id: "report" } });
  const [top] = index.search("部署窗口");
  assert.equal(top.doc.meta.id, "deploy");
});

test("unmatched and empty queries return nothing", () => {
  const index = new BM25();
  index.add({ text: "alpha", meta: {} });
  assert.deepEqual(index.search("zebra"), []);
  assert.deepEqual(index.search("   "), []);
});

test("minScore filters weak hits", () => {
  const index = new BM25();
  index.add({ text: "alpha beta", meta: { id: "a" } });
  index.add({ text: "alpha gamma", meta: { id: "b" } });
  assert.equal(index.search("alpha").length, 2);
  const strict = index.search("alpha", { minScore: 1000 });
  assert.equal(strict.length, 0);
});

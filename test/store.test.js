import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { renderNode } from "../src/markdown.js";
import { MemoryStore } from "../src/store.js";

async function makeStore() {
  const root = await mkdtemp(join(tmpdir(), "mem-store-"));
  const store = new MemoryStore({ root });
  await store.write({
    relPath: "daily/2026-10-25.md",
    content: renderNode(
      { name: "2026-10-25" },
      "# 部署\n\n部署窗口是周五下午四点，回滚方案见 [[digest/wiki/上线手册]]。",
    ),
  });
  await store.write({
    relPath: "digest/wiki/上线手册.md",
    content: renderNode(
      { name: "上线手册", description: "发布流程" },
      "# 上线手册\n\n周报格式用 Markdown，主库 PostgreSQL，Redis 只做缓存。\n\n来源：[[daily/2026-10-25]]",
    ),
  });
  return { root, store };
}

test("indexes only daily and digest", async () => {
  const { root, store } = await makeStore();
  const stats = store.stats();
  assert.equal(stats.files, 2);
  assert.ok(stats.chunks >= 2);
  assert.deepEqual(Object.keys(stats.byDir).sort(), ["daily", "digest"]);

  // A file outside those directories must be invisible to retrieval.
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(join(root, "session", "dialog"), { recursive: true });
  await writeFile(join(root, "session", "dialog", "x.jsonl"), '{"text":"秘密口令"}\n');
  await store.rebuild();
  assert.equal(store.search("秘密口令").length, 0);
});

test("retrieval returns path and real line numbers", async () => {
  const { store } = await makeStore();
  const [top] = store.search("部署窗口");
  assert.equal(top.relPath, "daily/2026-10-25.md");
  assert.ok(top.startLine >= 1);
  assert.ok(top.endLine >= top.startLine);

  const lines = (await store.read("daily/2026-10-25.md")).split("\n");
  const slice = lines.slice(top.startLine - 1, top.endLine).join("\n");
  assert.ok(slice.includes("部署窗口"), `line range must contain the text, got: ${slice}`);
});

test("wikilink neighbours are added at a discount", async () => {
  const { store } = await makeStore();
  const hits = store.search("PostgreSQL");
  assert.equal(hits[0].relPath, "digest/wiki/上线手册.md");
  const linked = hits.find((hit) => hit.relPath === "daily/2026-10-25.md");
  assert.ok(linked, "link expansion should surface the cited daily page");
  assert.ok(linked.score < hits[0].score, "expanded hits rank below direct hits");
  assert.ok(linked.via?.includes("上线手册"));
});

test("link expansion can be disabled", async () => {
  const { store } = await makeStore();
  const hits = store.search("PostgreSQL", { expandLinks: false });
  assert.ok(hits.every((hit) => hit.relPath !== "daily/2026-10-25.md"));
});

test("paths cannot escape the workspace", async () => {
  const { store } = await makeStore();
  await assert.rejects(() => store.write({ relPath: "../evil.md", content: "x" }), /escapes/);
  await assert.rejects(() => store.write({ relPath: "notes.txt", content: "x" }), /must be \.md/);
});

test("rebuild picks up external edits", async () => {
  const { root, store } = await makeStore();
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    join(root, "digest", "wiki", "新节点.md"),
    renderNode({ name: "新节点" }, "# 新节点\n\n季度预算审批走财务系统。\n"),
  );
  await store.rebuild();
  const [top] = store.search("季度预算");
  assert.equal(top.relPath, "digest/wiki/新节点.md");
});

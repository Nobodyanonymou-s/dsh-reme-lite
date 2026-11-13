import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";

import { buildDreamMaterial } from "../src/dream.ts";
import {
  buildLinkGraph,
  candidatePaths,
  INDEX_GIST_MAX_CHARS,
  nearDuplicates,
  renderIndexPage,
  writeRepresentation,
} from "../src/links.ts";
import { renderNode } from "../src/markdown.ts";
import { MemoryStore } from "../src/store.ts";

async function makeStore(): Promise<{ root: string; store: MemoryStore }> {
  const root = await mkdtemp(join(tmpdir(), "mem-links-"));
  const store = new MemoryStore({ root });
  await store.write({
    relPath: "daily/2026-10-25.md",
    content: renderNode({ name: "2026-10-25" }, "# 部署\n\n部署窗口是周五下午四点。\n"),
  });
  await store.write({
    relPath: "digest/wiki/发布流程.md",
    content: renderNode(
      { name: "发布流程", description: "发布窗口与审批顺序", updated: "2026-11-01" },
      "# 发布流程\n\n发布窗口在周五 22:00，错过顺延一天。发布窗口结束前要发周报，见 [[daily/2026-10-25]]。\n",
    ),
  });
  await store.write({
    relPath: "digest/personal/报告格式.md",
    content: renderNode(
      { name: "报告格式", description: "周报用 Markdown", updated: "2026-11-03" },
      "# 报告格式\n\n周报用 Markdown，不带表情符号。\n",
    ),
  });
  return { root, store };
}

it("reports dangling wikilinks and hints the real node by frontmatter name", async () => {
  const { root, store } = await makeStore();
  await store.write({
    relPath: "digest/wiki/部署.md",
    content: renderNode({ name: "部署" }, "回滚方案见 [[X]]，窗口细节见 [[上线手册]]。\n"),
  });
  await store.write({
    relPath: "digest/wiki/未知话题.md",
    content: renderNode({ name: "X" }, "X 话题的长期知识。\n"),
  });
  await store.write({
    relPath: "digest/wiki/manual.md",
    content: renderNode({ name: "手册" }, "上线手册规定发布窗口只在工作日开。\n"),
  });

  const { wrote } = await writeRepresentation(store);
  assert.ok(wrote.includes("digest/index.md") && wrote.includes("metadata/links.json"));

  const graph = JSON.parse(await readFile(join(root, "metadata", "links.json"), "utf8"));
  assert.ok(
    graph.dangling.some((link: { from: string; target: string }) =>
      link.from === "digest/wiki/部署.md" && link.target === "X"),
    "an unresolvable target is dangling",
  );
  assert.ok(
    graph.dangling.some((link: { from: string; target: string }) =>
      link.from === "digest/wiki/部署.md" && link.target === "上线手册"),
    "the original spelling travels with the dangling entry",
  );

  // Exact frontmatter-name match first, then BM25 over the target text.
  assert.deepEqual(candidatePaths("X", store), ["digest/wiki/未知话题.md"]);
  assert.ok(candidatePaths("上线手册", store).includes("digest/wiki/manual.md"));
});

it("internal plugin markers are neither links nor dangling entries", async () => {
  const { store } = await makeStore();
  await store.write({
    relPath: "digest/wiki/整理.md",
    content: renderNode(
      { name: "整理" },
      "定时整理提醒 [[node-memory:dream]] 与 [[recol:dream]] 会出现在 daily 页里。\n",
    ),
  });
  const graph = buildLinkGraph(store);
  assert.deepEqual(graph.nodes["digest/wiki/整理.md"], { out: [], in: [] });
  assert.deepEqual(graph.dangling, []);
  // The candidate guard exists so BM25 never improvises hints for plumbing.
  assert.deepEqual(candidatePaths("node-memory:dream", store), []);
});

it("a real broken link is still reported next to internal markers", async () => {
  const { store } = await makeStore();
  await store.write({
    relPath: "digest/wiki/整理.md",
    content: renderNode(
      { name: "整理" },
      "提醒标记 [[node-memory:dream]]、[[recol:dream]]，真正想链接的是 [[不存在的话题]]。\n",
    ),
  });
  const graph = buildLinkGraph(store);
  assert.deepEqual(graph.dangling, [{ from: "digest/wiki/整理.md", target: "不存在的话题" }]);
  assert.ok(!graph.nodes["digest/wiki/整理.md"]!.out.includes("node-memory:dream"));
});

it("a node without links has empty out and in, and no dangling entries", async () => {
  const { store } = await makeStore();
  const graph = buildLinkGraph(store);
  assert.deepEqual(graph.nodes["digest/personal/报告格式.md"], { out: [], in: [] });
  assert.deepEqual(graph.dangling, []);
});

it("labelled, section-anchored, and self links all resolve to the same target", async () => {
  const { store } = await makeStore();
  await store.write({
    relPath: "digest/wiki/上线手册.md",
    content: renderNode(
      { name: "上线手册" },
      "窗口安排见 [[上线手册|同页]] 与 [[上线手册#窗口]]，自引用 [[上线手册]]。\n",
    ),
  });
  const graph = buildLinkGraph(store);
  assert.deepEqual(graph.nodes["digest/wiki/上线手册.md"], {
    out: ["上线手册"],
    in: ["digest/wiki/上线手册.md"],
  });
  assert.deepEqual(graph.dangling, []);
});

it("the index page groups by domain, sorts by updated, and respects the size cap", async () => {
  const { store } = await makeStore();
  await store.write({
    relPath: "digest/wiki/上线手册.md",
    content: renderNode({ name: "上线手册", updated: "2026-11-05" }, "冻结主库，跑迁移，验证书链。\n"),
  });
  const long = "发布窗口、审批顺序、回滚路径、周报口径，以及历史上每一次改口的时间和原因。".repeat(5);
  await store.write({
    relPath: "digest/procedure/发布检查单.md",
    content: renderNode({ name: "发布检查单", description: long, updated: "2026-11-04" }, "逐项打勾。\n"),
  });

  const nodes = 4; // the three fixture nodes plus this one, index page not written yet
  const page = renderIndexPage(store);
  assert.ok(
    page.length <= 2 * nodes * 120,
    `index page must stay a pointer page, got ${page.length} > ${2 * nodes * 120}`,
  );
  assert.match(page, /^---\nname: 索引 \/ Index\n/);
  assert.match(page, /本页是生成的指针页，正文节点不要复制这里的内容。/);
  // The generated file is read directly too, so a blank line must separate the
  // fixed head from the first section (and from the empty-store placeholder).
  assert.ok(page.includes("\n\n## personal"), "blank line before the first section");
  assert.ok(!page.includes("\n\n\n"), "no stray double blank lines");

  // Fixed domain order, then newest first inside a domain.
  assert.ok(page.indexOf("## personal") < page.indexOf("## procedure"), "fixed domain order");
  assert.ok(page.indexOf("## procedure") < page.indexOf("## wiki"), "fixed domain order");
  assert.ok(page.indexOf("上线手册") < page.indexOf("发布流程"), "updated descending within a domain");
  assert.match(page, /- \[\[digest\/wiki\/上线手册\]\] — 上线手册\n/);

  // A gist never grows into a second body: it is clipped to the exported cap.
  assert.ok(!page.includes(long), "the long description never lands verbatim");
  assert.ok(page.includes(`${long.slice(0, INDEX_GIST_MAX_CHARS - 1)}…`));
});

it("the empty index page keeps the same blank line before its placeholder", async () => {
  const root = await mkdtemp(join(tmpdir(), "mem-links-empty-page-"));
  const page = renderIndexPage(new MemoryStore({ root }));
  assert.ok(page.endsWith("- (none)\n"), "the placeholder line is the whole body");
  assert.ok(page.includes("本页是生成的指针页，正文节点不要复制这里的内容。\n\n- (none)"), "blank line before the placeholder");
});

it("near-duplicate digest nodes are reported with a similarity inside 0-1", async () => {
  const { store } = await makeStore();
  const body =
    "发布窗口固定在周五 22:00 到 23:00，发布前要跑完回归清单，回滚走上一版镜像，窗口里的变更要单独登记。";
  await store.write({
    relPath: "digest/procedure/发布清单.md",
    content: renderNode({ name: "发布清单", updated: "2026-11-01" }, body),
  });
  await store.write({
    relPath: "digest/procedure/发布清单副本.md",
    content: renderNode({ name: "发布清单副本", updated: "2026-11-02" }, `${body}\n\n窗口结束后补周报。`),
  });
  await store.write({
    relPath: "digest/wiki/上线手册.md",
    content: renderNode(
      { name: "上线手册" },
      "上线手册：先冻结主库，再跑迁移脚本，最后验证证书链与域名解析。",
    ),
  });

  const pairs = nearDuplicates(store);
  assert.equal(pairs.length, 1, "only the near-identical pair is listed");
  const pair = pairs[0]!;
  assert.equal(pair.a, "digest/procedure/发布清单.md");
  assert.equal(pair.b, "digest/procedure/发布清单副本.md");
  assert.ok(pair.similarity >= 0.8 && pair.similarity <= 1, `similarity is a ratio, got ${pair.similarity}`);
});

it("writes the index page and the link graph, and skips the page with no digest nodes", async () => {
  const { root, store } = await makeStore();
  const { wrote } = await writeRepresentation(store);
  assert.deepEqual(wrote, ["digest/index.md", "metadata/links.json"]);

  const page = await store.read("digest/index.md");
  assert.match(page, /^---\n/);
  assert.ok(store.files.some((file) => file.relPath === "digest/index.md"), "the page stays indexed");

  // The material lists knowledge nodes, not the generated pointer sheet:
  // presenting index.md as "one more node to maintain" contradicts the rule
  // that calls it generated.
  const material = await buildDreamMaterial({ store });
  const listing = material.slice(material.indexOf("## Existing digest nodes"), material.indexOf("## Dangling"));
  assert.ok(listing.includes(".md"), "the section lists the body nodes");
  assert.ok(!listing.includes("digest/index.md"), "the generated page is not listed as a node");

  const graph = JSON.parse(await readFile(join(root, "metadata", "links.json"), "utf8"));
  assert.equal(typeof graph.builtAt, "string");
  assert.ok(graph.nodes["digest/wiki/发布流程.md"]);
  assert.ok(!Object.keys(graph.nodes).includes("digest/index.md"), "the derived page is never a node");
  assert.ok(Array.isArray(graph.dangling));

  const empty = new MemoryStore({ root: await mkdtemp(join(tmpdir(), "mem-links-empty-")) });
  await empty.rebuild();
  const skipped = await writeRepresentation(empty);
  assert.deepEqual(skipped.wrote, ["metadata/links.json"], "no digest nodes, no generated page");
  await assert.rejects(() => empty.read("digest/index.md"), /ENOENT/);
});

it("the index page never crowds the body page out of retrieval", async () => {
  const { store } = await makeStore();
  await writeRepresentation(store);
  const hits = store.search("发布窗口 周五", { limit: 5 });
  assert.ok(
    hits.some((hit) => hit.relPath === "digest/wiki/发布流程.md"),
    `the body page survives the generated page, got: ${hits.map((hit) => hit.relPath).join(", ")}`,
  );
});

it("dream material reflects the same graph the store holds", async () => {
  const { store } = await makeStore();
  await store.write({
    relPath: "digest/wiki/部署.md",
    content: renderNode({ name: "部署" }, "回滚方案见 [[X]]。\n"),
  });
  await store.write({
    relPath: "digest/wiki/未知话题.md",
    content: renderNode({ name: "X" }, "X 话题的长期知识。\n"),
  });
  const material = await buildDreamMaterial({ store });
  assert.match(
    material,
    /digest\/wiki\/部署\.md → \[\[X\]\] — candidates: digest\/wiki\/未知话题\.md/,
    "the candidate hint names the frontmatter-name match",
  );
});

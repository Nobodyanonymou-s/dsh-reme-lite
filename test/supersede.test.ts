import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";

import { apply } from "../src/index.ts";
import { parseFrontmatter, renderNode, upsertFrontmatter } from "../src/markdown.ts";
import { MemoryStore } from "../src/store.ts";

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 80));

/** Same minimal host as conflict.test.ts: no schedule service needed here. */
function makeCtx(): { ctx: any; tools: any[] } {
  const tools: any[] = [];
  const ctx: any = {
    logger: { warn() {}, info() {} },
    effect: (fn: () => void) => {
      fn();
      return () => {};
    },
    on: () => () => {},
    provide: () => {},
    tools: {
      register: (tool: unknown) => {
        tools.push(tool);
        return () => {};
      },
    },
  };
  return { ctx, tools };
}

const EXEC = {
  agent: { session: { id: "session-librarian", header: { id: "session-librarian", agentPreset: "librarian" } } },
};

async function plugin() {
  const root = await mkdtemp(join(tmpdir(), "mem-supersede-"));
  const { ctx, tools } = makeCtx();
  apply(ctx as never, { workspace: root, dreamEnabled: false, agentName: "librarian" });
  await settle();
  return { root, tools };
}

async function makeStore(): Promise<MemoryStore> {
  const root = await mkdtemp(join(tmpdir(), "mem-supersede-store-"));
  return new MemoryStore({ root });
}

const OLD_BODY = "# 发布窗口\n\n发布窗口是周五下午四点，回滚先切流量。";

it("upsertFrontmatter changes only the keys it is given", () => {
  const original = renderNode(
    {
      name: "发布窗口",
      description: "release window",
      updated: "2026-11-01",
      tags: ["release", "window"],
      kind: "notable",
      agent: "librarian",
      session: "9f21ab",
      room: "hangar",
      visibility: "private",
    },
    OLD_BODY,
  );
  const marked = upsertFrontmatter(original, { status: "superseded" });

  const before = parseFrontmatter(original);
  const after = parseFrontmatter(marked);
  assert.equal(after.body, before.body, "the body is untouched");
  assert.equal(after.data.status, "superseded");
  // Every field the node already had survives the merge, value included.
  for (const [key, value] of Object.entries(before.data)) {
    assert.equal(after.data[key], value, `${key} keeps its value`);
  }
  // Field order still matches renderNode, so the node does not change shape.
  assert.match(marked, /^---\nname: 发布窗口\ndescription: release window\nupdated: 2026-11-01\ntags: release, window\nkind: notable\nstatus: superseded\nagent: librarian\n/);

  // A flat key renderNode does not know about is kept too, and marking twice is stable.
  const withExtra = upsertFrontmatter(`${original}`, { owner: "team-a", status: "superseded" });
  assert.match(withExtra, /owner: team-a\n/);
  assert.equal(upsertFrontmatter(marked, { status: "superseded" }), marked);
});

it("superseded and retired nodes stay out of retrieval in every scope", async () => {
  const store = await makeStore();
  await store.write({
    relPath: "digest/wiki/旧结论.md",
    content: renderNode(
      { name: "旧结论", agent: "librarian", status: "superseded", supersedes: undefined },
      "# 旧结论\n\n发布窗口是周五下午四点。",
    ),
  });
  await store.write({
    relPath: "digest/wiki/弃用流程.md",
    content: renderNode({ name: "弃用流程", agent: "librarian", status: "retired" }, "# 弃用流程\n\n旧的下线步骤。"),
  });
  await store.write({
    relPath: "digest/wiki/发布流程.md",
    content: renderNode({ name: "发布流程", agent: "librarian" }, "# 发布流程\n\n发布窗口改到周三上午十点。"),
  });

  for (const scope of [{ viewer: "librarian", mode: "mine" as const }, { viewer: "builder", mode: "team" as const }]) {
    const hits = store.search("发布窗口", { scope, limit: 10 });
    assert.ok(
      hits.every((hit) => hit.relPath !== "digest/wiki/旧结论.md"),
      `${scope.mode} must not answer with the corrected-away text`,
    );
    assert.equal(store.search("下线步骤", { scope }).length, 0, "retired is history too");
  }

  const trail = store.search("发布窗口", { includeSuperseded: true, limit: 10 });
  assert.ok(trail.some((hit) => hit.relPath === "digest/wiki/旧结论.md"), "the trail is reachable on request");
  assert.equal(store.search("下线步骤", { includeSuperseded: true }).length, 1);
});

it("link expansion does not resurrect a superseded neighbour", async () => {
  const store = await makeStore();
  await store.write({
    relPath: "digest/wiki/新结论.md",
    content: renderNode({ name: "新结论", agent: "librarian" }, "# 新结论\n\n细节见 [[digest/wiki/旧结论]]。"),
  });
  await store.write({
    relPath: "digest/wiki/旧结论.md",
    content: renderNode({ name: "旧结论", agent: "librarian", status: "superseded" }, "# 旧结论\n\n发布窗口是周五下午四点。"),
  });

  const hits = store.search("新结论");
  assert.ok(hits.length > 0);
  assert.ok(hits.every((hit) => hit.relPath !== "digest/wiki/旧结论.md"), "a link must not expand into history");
  const withTrail = store.search("新结论", { includeSuperseded: true });
  assert.ok(withTrail.some((hit) => hit.relPath === "digest/wiki/旧结论.md"), "…unless the caller asks for it");
});

it("G4 acceptance: correcting a node keeps the old one, points at it, and retrieval shows only the new", async () => {
  const { root, tools } = await plugin();
  const write = tools.find((tool: any) => tool.name === "memory_write");
  const search = tools.find((tool: any) => tool.name === "memory_search");

  await write.execute({ path: "digest/wiki/发布窗口.md", content: OLD_BODY, name: "发布窗口" }, EXEC);
  const result = await write.execute(
    {
      path: "digest/wiki/发布窗口-2026-11.md",
      content: "# 发布窗口\n\n发布窗口改到周三上午十点。",
      name: "发布窗口",
      supersedes: "digest/wiki/发布窗口.md",
    },
    EXEC,
  );
  assert.match(result, /Wrote digest\/wiki\/发布窗口-2026-11\.md/);
  assert.match(result, /Marked digest\/wiki\/发布窗口\.md as superseded/);

  // The old node is still on disk: same body, marked as history.
  const oldText = await readFile(join(root, "digest/wiki/发布窗口.md"), "utf8");
  assert.equal(parseFrontmatter(oldText).body.trim(), OLD_BODY.trim(), "the body survives byte for byte");
  assert.match(oldText, /status: superseded/);
  assert.ok(!oldText.includes("周三上午十点"), "the old node does not gain the new text");

  const newText = await readFile(join(root, "digest/wiki/发布窗口-2026-11.md"), "utf8");
  assert.match(newText, /supersedes: digest\/wiki\/发布窗口\.md/);

  // Default retrieval: the current truth only.
  const fresh = await search.execute({ query: "发布窗口" }, EXEC);
  assert.match(fresh, /发布窗口-2026-11\.md/);
  assert.ok(!fresh.includes("发布窗口.md:"), "the superseded path is not served by default");
  assert.ok(fresh.includes("周三上午十点"));

  // Asking for the trail shows both.
  const trail = await search.execute({ query: "发布窗口", include_superseded: true }, EXEC);
  assert.match(trail, /发布窗口-2026-11\.md/);
  assert.match(trail, /发布窗口\.md:\d+-\d+/, "the history is reachable explicitly");
});

it("superseding a nonexistent path is refused and writes nothing", async () => {
  const { root, tools } = await plugin();
  const write = tools.find((tool: any) => tool.name === "memory_write");

  const result = await write.execute(
    {
      path: "digest/wiki/新节点.md",
      content: "# 新节点\n\n新结论。",
      supersedes: "digest/wiki/不存在.md",
    },
    EXEC,
  );
  assert.match(result, /Error: supersedes target does not exist: digest\/wiki\/不存在\.md/);
  const created = await readFile(join(root, "digest/wiki/新节点.md"), "utf8").catch(() => null);
  assert.equal(created, null, "a refused correction must not leave the new node behind");
});

it("self-supersede is refused", async () => {
  const { root, tools } = await plugin();
  const write = tools.find((tool: any) => tool.name === "memory_write");
  await write.execute({ path: "digest/wiki/自指.md", content: "# 自指\n\n旧内容。" }, EXEC);

  const result = await write.execute(
    { path: "digest/wiki/自指.md", content: "# 自指\n\n新内容。", supersedes: "digest\\wiki\\自指.md" },
    EXEC,
  );
  assert.match(result, /Error: supersedes must differ from the path being written\./);
  // The node keeps its previous content: nothing was replaced.
  const text = await readFile(join(root, "digest/wiki/自指.md"), "utf8");
  assert.match(text, /旧内容/);
});

it("a supersedes target outside the memory nodes is refused", async () => {
  const { tools } = await plugin();
  const write = tools.find((tool: any) => tool.name === "memory_write");

  assert.match(
    await write.execute({ path: "digest/wiki/a.md", content: "x", supersedes: "session/dialog/a.json" }, EXEC),
    /Error: supersedes must start with daily\/ or digest\/\./,
  );
  assert.match(
    await write.execute({ path: "digest/wiki/a.md", content: "x", supersedes: "daily/2026-11-01.txt" }, EXEC),
    /Error: supersedes must point at a \.md memory node\./,
  );
  assert.match(
    await write.execute({ path: "digest/wiki/a.md", content: "x", supersedes: "digest/../../escaped.md" }, EXEC),
    /Error: supersedes path escapes the memory workspace/,
  );
});

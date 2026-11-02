import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";

import { renderNode } from "../src/markdown.ts";
import { MemoryStore } from "../src/store.ts";

async function makeStore(): Promise<MemoryStore> {
  const root = await mkdtemp(join(tmpdir(), "mem-scope-"));
  return new MemoryStore({ root });
}

const A = "librarian";
const B = "builder";

async function writeAgent(
  store: MemoryStore,
  input: { relPath: string; body: string; agent: string; privateNode?: boolean; room?: string },
): Promise<void> {
  await store.write({
    relPath: input.relPath,
    content: renderNode(
      {
        name: input.relPath,
        agent: input.agent,
        ...(input.room ? { room: input.room } : {}),
        ...(input.privateNode ? { visibility: "private" } : {}),
      },
      input.body,
    ),
  });
}

it("G1 acceptance: another agent's private node is invisible by default, visible under scope=team", async () => {
  const store = await makeStore();
  await writeAgent(store, {
    relPath: "daily/2026-11-02.md",
    body: "# 猜测\n\n发布窗口可能改到周三，未证实，先记下来。",
    agent: A,
    privateNode: true,
  });

  // Agent B, the default scope: A's tentative judgment must not read as fact.
  const asB = store.search("发布窗口", { scope: { viewer: B, mode: "mine" } });
  assert.equal(asB.length, 0, "B's default retrieval must not hit A's private node");

  // The writer still finds their own note.
  const asA = store.search("发布窗口", { scope: { viewer: A, mode: "mine" } });
  assert.equal(asA.length > 0, true, "the writer sees their own private node");

  // The audit view sees everything.
  const audit = store.search("发布窗口", { scope: { viewer: B, mode: "team" } });
  assert.equal(audit.length > 0, true, "scope=team reaches private nodes");
});

it("the team layer and pre-agent nodes are visible to everyone", async () => {
  const store = await makeStore();
  // A digest node written by A with no visibility restriction: team layer.
  await writeAgent(store, {
    relPath: "digest/wiki/上线手册.md",
    body: "# 上线手册\n\n主库 PostgreSQL，Redis 只做缓存。",
    agent: A,
  });
  // A node from before agents existed: no agent field at all.
  await store.write({
    relPath: "digest/wiki/旧笔记.md",
    content: "---\nname: 旧笔记\n---\n\n# 旧笔记\n\n历史遗留的部署清单。\n",
  });

  for (const viewer of [A, B]) {
    assert.equal(
      store.search("PostgreSQL", { scope: { viewer, mode: "mine" } }).length > 0,
      true,
      `${viewer} sees the team layer`,
    );
    assert.equal(
      store.search("部署清单", { scope: { viewer, mode: "mine" } }).length > 0,
      true,
      `${viewer} sees legacy nodes`,
    );
  }
});

it("the room filter narrows to labelled nodes only", async () => {
  const store = await makeStore();
  await writeAgent(store, {
    relPath: "digest/wiki/机库方案.md",
    body: "# 机库方案\n\n承重结构选型备忘。",
    agent: A,
    room: "hangar",
  });
  await writeAgent(store, {
    relPath: "digest/wiki/通用规范.md",
    body: "# 通用规范\n\n安全规范全文。",
    agent: A,
  });

  const inRoom = store.search("承重结构", { room: "hangar" });
  assert.deepEqual(inRoom.map((hit) => hit.relPath), ["digest/wiki/机库方案.md"]);

  // A labelled node does not match another room's query.
  assert.deepEqual(store.search("承重结构", { room: "runway" }), []);

  // A node without a room label is "the whole team's" and matches any room.
  const unlabeled = store.search("安全规范", { room: "hangar" });
  assert.equal(unlabeled.length > 0, true, "unlabelled nodes match every room query");
});

it("link expansion does not leak a private neighbour", async () => {
  const store = await makeStore();
  await writeAgent(store, {
    relPath: "digest/wiki/公开页.md",
    body: "# 公开页\n\n结论见 [[digest/wiki/秘密假设]]，此处不展开。",
    agent: A,
  });
  await writeAgent(store, {
    relPath: "digest/wiki/秘密假设.md",
    body: "# 秘密假设\n\n预算大概会被砍三成，别外传。",
    agent: A,
    privateNode: true,
  });

  const asB = store.search("公开页", { scope: { viewer: B, mode: "mine" } });
  assert.equal(asB.length > 0, true);
  assert.ok(
    asB.every((hit) => hit.relPath !== "digest/wiki/秘密假设.md"),
    "a wikilink must not expand into a node the viewer cannot see",
  );
  const asA = store.search("公开页", { scope: { viewer: A, mode: "mine" } });
  assert.ok(
    asA.some((hit) => hit.relPath === "digest/wiki/秘密假设.md"),
    "the writer still gets the expansion",
  );
});

it("G2 acceptance: concurrent writes to one node lose nothing and leave no debris", async () => {
  const store = await makeStore();
  const relPath = "digest/wiki/共享节点.md";
  const rounds = 24;
  await Promise.all(
    Array.from({ length: rounds }, (_, i) =>
      store.write({
        relPath,
        content: renderNode({ name: "共享节点", agent: `agent-${i % 3}` }, `# 共享节点\n\n第 ${i} 版内容，标记 seven-brick-wall。`),
      }),
    ),
  );

  // Exactly one well-formed file: a complete frontmatter block, one body.
  const text = await store.read(relPath);
  assert.match(text, /^---\n[\s\S]*?\n---\n\n# 共享节点\n\n第 \d+ 版内容/);
  assert.equal([...text.matchAll(/^---$/gm)].length, 2, "frontmatter opens and closes exactly once");

  // The index agrees with disk: one file, no duplicate entries, searchable.
  assert.equal(store.files.filter((f) => f.relPath === relPath).length, 1);
  assert.ok(store.search("seven-brick-wall").length > 0, "the final content is retrievable");
  assert.ok(store.search("共享节点").length > 0);

  // No temp-file debris anywhere in the workspace.
  for (const dir of ["digest", "daily", "metadata"]) {
    const names = await readdir(join(store.root, dir)).catch(() => [] as string[]);
    assert.deepEqual(
      names.filter((name) => name.includes(".tmp-")),
      [],
      `${dir} has no temp residue`,
    );
  }
});

it("rewriting a node replaces the old text in the index", async () => {
  const store = await makeStore();
  await store.write({
    relPath: "digest/wiki/改写.md",
    content: renderNode({ name: "改写" }, "# 改写\n\n旧结论：回滚靠手工脚本。"),
  });
  await store.write({
    relPath: "digest/wiki/改写.md",
    content: renderNode({ name: "改写" }, "# 改写\n\n新结论：回滚走自动流水线。"),
  });

  assert.equal(store.search("手工脚本").length, 0, "the replaced text stops matching");
  assert.equal(store.search("自动流水线").length > 0, true, "the new text matches");
  assert.equal(store.files.length, 1);
  assert.equal(store.chunks.filter((c) => c.relPath === "digest/wiki/改写.md").length, store.chunks.length);
});

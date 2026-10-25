import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildDreamMaterial, DREAM_RULES, KIND_RULES, dreamPrompt, kindRules } from "../src/dream.js";
import { DreamQueue } from "../src/dream-queue.js";
import { MemoryStore } from "../src/store.js";

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "mem-dream-"));
  const store = new MemoryStore({ root });
  await store.write({
    relPath: "daily/2026-10-24.md",
    content: "---\nname: 2026-10-24\n---\n\n用户偏好：周报用 Markdown。\n",
  });
  await store.write({
    relPath: "digest/personal/报告格式.md",
    content: "---\nname: 报告格式\n---\n\n周报用 Markdown。来源：[[daily/2026-10-24]]\n",
  });
  return { root, store };
}

test("material lists what exists and what to do", async () => {
  const { store } = await workspace();
  const material = await buildDreamMaterial({ store, pendingTurns: 3, days: 7 });
  assert.match(material, /Recent daily pages/);
  assert.match(material, /daily\/2026-10-24\.md/);
  assert.match(material, /digest\/personal\/报告格式\.md/);
  assert.match(material, /Unflushed turns in memory: 3/);
  assert.ok(material.includes(DREAM_RULES));
  assert.ok(material.includes(KIND_RULES), "the colour rubric travels with the material");
  assert.ok(KIND_RULES.indexOf("conflict") < KIND_RULES.indexOf("user-declared"), "rubric is ordered by severity");
});

test("material degrades to explicit empty sections", async () => {
  const root = await mkdtemp(join(tmpdir(), "mem-empty-"));
  const store = new MemoryStore({ root });
  await store.rebuild();
  const material = await buildDreamMaterial({ store });
  assert.match(material, /Recent daily pages\n- \(none\)/);
  assert.match(material, /Existing digest nodes\n- \(none\)/);
});

test("the agent prompt embeds the material and forbids questions", () => {
  const prompt = dreamPrompt("MATERIAL");
  assert.ok(prompt.includes("MATERIAL"));
  assert.match(prompt, /Do not ask questions/);
});

test("queue is FIFO and survives reload", async () => {
  const { root } = await workspace();
  const queue = new DreamQueue({ root });
  const first = await queue.push({ material: "a", at: new Date("2026-10-25T00:00:00Z") });
  await queue.push({ material: "b", at: new Date("2026-10-25T01:00:00Z") });

  const reopened = new DreamQueue({ root });
  const list = await reopened.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].id, first.id);
  assert.equal(list[0].material, "a");

  const head = await reopened.peek();
  assert.equal(head.material, "a");
  assert.equal(await reopened.remove(head.id), true);
  assert.equal((await reopened.list()).length, 1);
  assert.equal(await reopened.clear(), 1);
  assert.equal(await reopened.size(), 0);
});

test("an empty queue reads as zero, not an error", async () => {
  const root = await mkdtemp(join(tmpdir(), "mem-noqueue-"));
  const queue = new DreamQueue({ root });
  assert.deepEqual(await queue.list(), []);
  assert.equal(await queue.peek(), null);
  assert.equal(await queue.size(), 0);
});

test("the colour rubric exists in both working languages", () => {
  const en = kindRules("en");
  assert.match(en, /conflict/);
  assert.match(en, /purple user-declared/);
  assert.match(en, /"remember this"/, "English trigger phrases are spelled out");
  assert.match(en, /When unsure, use green/);
  assert.ok(en.indexOf("conflict") < en.indexOf("user-declared"));

  const zh = kindRules("zh");
  assert.match(zh, /紫 user-declared/);
  assert.match(zh, /「记住」/);
  assert.match(zh, /拿不准就绿/);
});
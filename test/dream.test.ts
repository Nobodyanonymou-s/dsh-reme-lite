import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";

import { buildDreamMaterial, DREAM_RULES, KIND_RULES, dreamPrompt, kindRules } from "../src/dream.ts";
import { DreamQueue } from "../src/dream-queue.ts";
import { MemoryStore } from "../src/store.ts";

async function workspace(): Promise<{ root: string; store: MemoryStore }> {
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

const MINUTE = 60_000;
const TRANSCRIPT_BUDGET = 12000;

interface FixtureLine {
  role: "user" | "assistant";
  text: string;
  minutesAgo: number;
  /** Stands in for the source field a future transcript format may carry. */
  source?: Record<string, unknown>;
}

function dialogLine(line: FixtureLine): string {
  return JSON.stringify({
    session_id: "s1-abc",
    role: line.role,
    at: new Date(Date.now() - line.minutesAgo * MINUTE).toISOString(),
    text: line.text,
    ...(line.source ? { source: line.source } : {}),
  });
}

async function writeDialog(root: string, lines: FixtureLine[], name = "s1-abc.jsonl"): Promise<void> {
  const dir = join(root, "session", "dialog");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), `${lines.map(dialogLine).join("\n")}\n`, "utf8");
}

/**
 * The transcript slice of the material, cut out between its heading and the
 * rules: budget and filtering claims are checked against the slice alone.
 */
function transcriptSlice(material: string): string {
  const start = material.indexOf("## Recent transcripts");
  const end = material.indexOf("\n## Rules", start);
  assert.ok(start >= 0, "the material carries a transcript section");
  assert.ok(end > start, "the transcript section sits before the rules");
  return material.slice(start, end);
}

/** A transcript with the shapes reconciliation has to tell apart. */
async function dialogWorkspace(): Promise<{ store: MemoryStore; long: string }> {
  const { root, store } = await workspace();
  const long = "端口确认完毕。" + "补充说明，路由与证书都不需要改动。".repeat(40);
  await writeDialog(root, [
    // Assistant steps before the first question answer a turn outside the window.
    { role: "assistant", text: "（上一问的收尾，无需重复。）", minutesAgo: 40 },
    { role: "user", text: "把部署端口改成 8443。", minutesAgo: 30 },
    { role: "assistant", text: "我先看下当前配置。", minutesAgo: 29 },
    { role: "assistant", text: "已把部署端口改为 8443，重启后生效。", minutesAgo: 28 },
    // Our own injections, in both the old (content-only) and future (sourced) shape.
    { role: "assistant", text: "[[node-memory:dream]] 长期记忆索引已更新。", minutesAgo: 27 },
    { role: "assistant", text: "# 长期记忆\n- 部署端口 8443", minutesAgo: 26 },
    { role: "assistant", text: "记忆已写入。", minutesAgo: 25, source: { kind: "node-memory" } },
    // Harness-injected context rides in the journal shaped like a user turn.
    {
      role: "user",
      text: "Current runtime context. This snapshot supersedes the earlier one.",
      minutesAgo: 20,
      source: { kind: "runtime-context" },
    },
    { role: "user", text: "再确认一下端口。", minutesAgo: 10 },
    { role: "assistant", text: long, minutesAgo: 9 },
    // Older than the default window: must stay out.
    { role: "user", text: "十年前的旧偏好：编辑器用 Vim。", minutesAgo: 60 * 24 * 10 },
  ]);
  return { store, long };
}

it("material carries recent transcripts for reconciliation", async () => {
  const { store, long } = await dialogWorkspace();
  const material = await buildDreamMaterial({ store, pendingTurns: 0 });
  const section = transcriptSlice(material);

  assert.match(material, /Recent transcripts \(last 3 days, for verification only\)/);
  assert.match(material, /Ground truth only — verify against it, never copy it into digest nodes\./);

  // The question and its conclusion travel; the narration on the way does not.
  assert.ok(section.includes("把部署端口改成 8443。"));
  assert.ok(section.includes("已把部署端口改为 8443，重启后生效。"));
  assert.ok(!section.includes("我先看下当前配置。"));
  assert.ok(!section.includes("（上一问的收尾，无需重复。）"));
  assert.ok(section.indexOf("已把部署端口改为 8443") < section.indexOf("再确认一下端口。"), "turns stay in order");

  // Our own injections never come back as ground truth.
  assert.ok(!section.includes("[[node-memory:dream]]"));
  assert.ok(!section.includes("# 长期记忆"));
  assert.ok(!section.includes("记忆已写入。"));

  // Harness-injected context is not the user's words either: it journals, but
  // a time sample or a snapshot must not be reconciled as if anyone said it.
  assert.ok(!section.includes("Current runtime context"), "the injected user line stays out of the material");
  assert.ok(section.includes("把部署端口改成 8443。"), "the human questions around it are untouched");

  // One long reply is trimmed to the cap; the user's words never are.
  assert.ok(section.includes(`${long.slice(0, 300)}…`));
  assert.ok(!section.includes(long));

  assert.ok(section.length <= TRANSCRIPT_BUDGET, `transcript block must stay within budget, got ${section.length}`);
});

it("harness-injected user lines never read as something anyone said", async () => {
  const { root, store } = await workspace();
  await writeDialog(root, [
    { role: "user", text: "把超时改成 30 秒。", minutesAgo: 30 },
    { role: "assistant", text: "已把超时改为 30 秒。", minutesAgo: 29 },
    // Harness injections shaped like user turns — the two kinds the field
    // evidence showed landing in the journal.
    {
      role: "user",
      text: "Time sampled while preparing turn 2, step 1: 2026-11-13T22:55:34+08:00",
      minutesAgo: 20,
      source: { kind: "time-context" },
    },
    { role: "user", text: "[SCHEDULE REMINDER BATCH] 两条提醒已到期", minutesAgo: 19, source: { kind: "schedule" } },
    { role: "user", text: "再确认一下超时。", minutesAgo: 10 },
    { role: "assistant", text: "超时仍是 30 秒。", minutesAgo: 9 },
  ]);
  const section = transcriptSlice(await buildDreamMaterial({ store }));

  assert.ok(!section.includes("Time sampled while preparing"), "the time sample stays out of the material");
  assert.ok(!section.includes("[SCHEDULE REMINDER BATCH]"), "the schedule reminder stays out too");
  assert.ok(section.includes("把超时改成 30 秒。") && section.includes("再确认一下超时。"), "the human questions around them are untouched");
  assert.ok(section.includes("超时仍是 30 秒。"), "and so are their conclusions");
});

it("a workspace without transcripts degrades to (none)", async () => {
  const root = await mkdtemp(join(tmpdir(), "mem-notranscript-"));
  const store = new MemoryStore({ root });
  const material = await buildDreamMaterial({ store });
  assert.match(material, /Recent transcripts \(last 3 days[^\n]*\nGround truth only[^\n]*\n- \(none\)/);
});

it("transcriptDays decides how far the window reaches", async () => {
  const { store } = await dialogWorkspace();
  const narrow = transcriptSlice(await buildDreamMaterial({ store }));
  assert.ok(!narrow.includes("十年前的旧偏好"), "rows outside the window stay out");
  const wide = transcriptSlice(await buildDreamMaterial({ store, transcriptDays: 30 }));
  assert.ok(wide.includes("十年前的旧偏好"), "a wider window reaches them");
});

it("the transcript block keeps the newest turns once the budget runs out", async () => {
  const { root, store } = await workspace();
  await writeDialog(root, [
    {
      role: "user",
      text: "旧的一问：上周的部署窗口是什么时候？顺便说一下当时的发布流程，方便我回忆。",
      minutesAgo: 50,
    },
    { role: "assistant", text: "旧的一答：上周三是 22:00 到 23:00。", minutesAgo: 49 },
    { role: "user", text: "新的一问：今天的部署窗口是什么时候？", minutesAgo: 5 },
    { role: "assistant", text: "新的一答：今天 22:00 到 23:00。", minutesAgo: 4 },
  ]);
  const section = transcriptSlice(await buildDreamMaterial({ store, transcriptBudget: 300 }));

  assert.ok(section.length <= 300, `transcript block must stay within budget, got ${section.length}`);
  assert.ok(section.includes("新的一问"));
  assert.ok(section.includes("新的一答"));
  assert.ok(!section.includes("旧的一问"), "the oldest turn is what gets dropped");
});

it("an oversized paste is clipped in, never a blank (none)", async () => {
  const { root, store } = await workspace();
  await writeDialog(root, [
    { role: "user", text: "旧的一问：上周的部署窗口是什么时候？", minutesAgo: 50 },
    { role: "user", text: `把整份报告粘进来：${"季度数据行。".repeat(800)}`, minutesAgo: 5 },
    { role: "assistant", text: "新的一答：已看完，结论是 Q3 增长 12%。", minutesAgo: 4 },
  ]);
  const section = transcriptSlice(await buildDreamMaterial({ store, transcriptBudget: 300 }));

  // The newest turn is bigger than the whole block: dropping it wholesale
  // would show "(none)" exactly when the user pasted something worth
  // reconciling. It goes in clipped instead.
  assert.ok(section.length <= 300, `transcript block must stay within budget, got ${section.length}`);
  assert.ok(section.includes("季度数据行"), "the head of the paste survives");
  assert.ok(!section.includes("(none)"), "an oversized entry never blanks the section");
  assert.ok(!section.includes("旧的一问"), "the older turn still yields to the newer one");
});

it("the reconciliation rule sits between citing and correcting", () => {
  const cites = DREAM_RULES.indexOf("cites");
  const reconcile = DREAM_RULES.indexOf("Reconcile");
  const contradicts = DREAM_RULES.indexOf("contradicts");
  assert.ok(cites !== -1 && reconcile !== -1 && contradicts !== -1);
  assert.ok(cites < reconcile, "citing sources comes first");
  assert.ok(reconcile < contradicts, "reconciling against the transcript precedes the contradiction rule");
  // memory_write on this baseline has no supersedes parameter: a rule that
  // tells the model to use one would be a rule it cannot follow.
  assert.match(DREAM_RULES, /correct that node in place/);
  assert.doesNotMatch(DREAM_RULES, /supersedes=/);
  assert.match(DREAM_RULES, /"unverified"/);
  assert.ok(DREAM_RULES.includes("9. digest nodes are the team layer"), "the rules stay numbered");
});

it("the representation rule sits between reconciliation and contradiction", () => {
  const reconcile = DREAM_RULES.indexOf("Reconcile");
  const representation = DREAM_RULES.indexOf("representation layer");
  const contradicts = DREAM_RULES.indexOf("contradicts");
  assert.ok(reconcile !== -1 && representation !== -1 && contradicts !== -1);
  assert.ok(reconcile < representation, "fixing the representation follows reconciliation");
  assert.ok(representation < contradicts, "and precedes the contradiction rule");
  assert.match(DREAM_RULES, /never the node/);
  assert.match(DREAM_RULES, /near-duplicate nodes into the newer one/);
  assert.match(DREAM_RULES, /never copy its lines into body pages/);
});

it("material reports dangling links and duplicates without rewriting the nodes", async () => {
  const root = await mkdtemp(join(tmpdir(), "mem-dream-repr-"));
  const store = new MemoryStore({ root });
  const body =
    "发布窗口固定在周五 22:00，发布前要跑完回归清单，回滚走上一版镜像，窗口里的变更要单独登记。";
  await store.write({
    relPath: "digest/procedure/发布清单.md",
    content: `---\nname: 发布清单\nupdated: 2026-11-01\n---\n\n${body}\n`,
  });
  await store.write({
    relPath: "digest/procedure/发布清单副本.md",
    content: `---\nname: 发布清单副本\nupdated: 2026-11-02\n---\n\n${body}\n\n窗口结束后补周报。\n`,
  });
  await store.write({
    relPath: "digest/wiki/部署.md",
    content: "---\nname: 部署\n---\n\n细节见 [[不存在的节点]]。\n",
  });
  const watched = [
    "digest/procedure/发布清单.md",
    "digest/procedure/发布清单副本.md",
    "digest/wiki/部署.md",
  ];
  const before = await Promise.all(watched.map((path) => store.read(path)));

  const material = await buildDreamMaterial({ store });

  assert.match(material, /## Dangling wikilinks/);
  assert.match(material, /## Possible duplicates/);
  assert.match(material, /digest\/wiki\/部署\.md → \[\[不存在的节点\]\] — \(no candidates\)/,
    "the page holding a broken link is never its own candidate");
  assert.ok(
    material.includes("digest/procedure/发布清单.md ↔ digest/procedure/发布清单副本.md"),
    "the near-duplicate pair is named in the material",
  );
  assert.match(material, /\(0\.\d{2}\)/, "each pair carries its similarity");

  const after = await Promise.all(watched.map((path) => store.read(path)));
  assert.deepEqual(after, before, "reporting never rewrites the nodes it describes");
});

it("material lists what exists and what to do", async () => {
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

it("material degrades to explicit empty sections", async () => {
  const root = await mkdtemp(join(tmpdir(), "mem-empty-"));
  const store = new MemoryStore({ root });
  await store.rebuild();
  const material = await buildDreamMaterial({ store });
  assert.match(material, /Recent daily pages\n- \(none\)/);
  assert.match(material, /Existing digest nodes\n- \(none\)/);
});

it("the agent prompt embeds the material and forbids questions", () => {
  const prompt = dreamPrompt("MATERIAL");
  assert.ok(prompt.includes("MATERIAL"));
  assert.match(prompt, /Do not ask questions/);
});

it("queue is FIFO and survives reload", async () => {
  const { root } = await workspace();
  const queue = new DreamQueue({ root });
  const first = await queue.push({ material: "a", at: new Date("2026-10-25T00:00:00Z") });
  await queue.push({ material: "b", at: new Date("2026-10-25T01:00:00Z") });

  const reopened = new DreamQueue({ root });
  const list = await reopened.list();
  assert.equal(list.length, 2);
  const firstEntry = list[0];
  assert.ok(firstEntry, "the oldest request survives the reload");
  assert.equal(firstEntry.id, first.id);
  assert.equal(firstEntry.material, "a");

  const head = await reopened.peek();
  assert.ok(head, "peek returns the oldest request");
  assert.equal(head.material, "a");
  assert.equal(await reopened.remove(head.id), true);
  assert.equal((await reopened.list()).length, 1);
  assert.equal(await reopened.clear(), 1);
  assert.equal(await reopened.size(), 0);
});

it("an empty queue reads as zero, not an error", async () => {
  const root = await mkdtemp(join(tmpdir(), "mem-noqueue-"));
  const queue = new DreamQueue({ root });
  assert.deepEqual(await queue.list(), []);
  assert.equal(await queue.peek(), null);
  assert.equal(await queue.size(), 0);
});

it("the colour rubric exists in both working languages", () => {
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

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";

import { Capture } from "../src/capture.ts";
import { TurnCapture } from "../src/turns.ts";

/** Session events as bare objects, shaped the way the Host emits them. */
function userMessage(text: string, at?: string, source?: unknown) {
  return {
    type: "user/message",
    ...(at ? { time: at } : {}),
    data: {
      ...(source ? { source } : {}),
      content: [{ type: "text", text }],
    },
  };
}

function assistantMessage(
  text: string,
  options: { turn?: number; step?: number; interrupted?: boolean; at?: string } = {},
) {
  return {
    type: "assistant/message",
    ...(options.at ? { time: options.at } : {}),
    data: {
      ...(options.turn === undefined ? {} : { turn: options.turn }),
      ...(options.step === undefined ? {} : { step: options.step }),
      message: { content: [{ type: "text", text }] },
      ...(options.interrupted ? { interrupted: true } : {}),
    },
  };
}

function turnStart(turn: number) {
  return { type: "turn/start", data: { turn } };
}

function turnEnd(turn: number) {
  return { type: "turn/end", data: { turn, reason: "stop" } };
}

/** interval=1: every turn that reaches the projection lands on the page at once. */
async function harness(): Promise<{ root: string; capture: Capture; turns: TurnCapture }> {
  const root = await mkdtemp(join(tmpdir(), "mem-turns-"));
  const capture = new Capture({ root, interval: 1 });
  const turns = new TurnCapture(capture);
  return { root, capture, turns };
}

async function dailyPage(root: string): Promise<string> {
  const dir = join(root, "daily");
  const files = await readdir(dir);
  assert.equal(files.length, 1, "exactly one daily page");
  const file = files[0];
  assert.ok(file);
  return readFile(join(dir, file), "utf8");
}

async function transcript(root: string): Promise<Array<{ role: string; text: string; source?: { kind?: string } }>> {
  const dir = join(root, "session", "dialog");
  const files = await readdir(dir);
  const file = files[0];
  assert.ok(file, "the transcript file exists");
  const raw = await readFile(join(dir, file), "utf8");
  return raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { role: string; text: string; source?: { kind?: string } });
}

it("a turn keeps the user's words and its final reply, not the narration", async () => {
  const { root, capture, turns } = await harness();
  const session = "session-1";
  await turns.ingest(session, userMessage("问一下 X 什么时候发布", "2026-11-10T02:00:00.000Z"));
  await turns.ingest(session, turnStart(1));
  await turns.ingest(session, assistantMessage("我先看看 X 的配置", { turn: 1, step: 1, at: "2026-11-10T02:00:20.000Z" }));
  await turns.ingest(session, assistantMessage("结论：X 周五发布", { turn: 1, step: 2, at: "2026-11-10T02:01:00.000Z" }));
  await turns.ingest(session, turnEnd(1));

  const page = await dailyPage(root);
  assert.match(page, /\*\*user\*\*: 问一下 X 什么时候发布/);
  assert.match(page, /\*\*assistant\*\*: 结论：X 周五发布/);
  assert.doesNotMatch(page, /我先看看/, "mid-turn narration stays off the page");

  assert.deepEqual(
    (await transcript(root)).map((line) => line.text),
    ["问一下 X 什么时候发布", "我先看看 X 的配置", "结论：X 周五发布"],
    "the transcript keeps every step",
  );
  assert.equal(capture.capturedTurns, 2, "the counter follows the daily projection, not the transcript");
});

it("an interrupted turn stays in the transcript and off the daily page", async () => {
  const { root, turns } = await harness();
  const session = "session-2";
  await turns.ingest(session, userMessage("第一问", "2026-11-10T02:00:00.000Z"));
  await turns.ingest(session, assistantMessage("第一答", { turn: 1, at: "2026-11-10T02:00:30.000Z" }));
  await turns.ingest(session, turnEnd(1));
  await turns.ingest(session, userMessage("第二问", "2026-11-10T02:01:00.000Z"));
  await turns.ingest(session, assistantMessage("写到一半被停掉了", { turn: 2, interrupted: true, at: "2026-11-10T02:01:30.000Z" }));

  const page = await dailyPage(root);
  assert.match(page, /第一答/);
  assert.match(page, /第二问/);
  assert.doesNotMatch(page, /写到一半被停掉了/, "no daily line for the interrupted turn, marker or not");

  assert.ok(
    (await transcript(root)).some((line) => line.text === "写到一半被停掉了"),
    "the transcript keeps the half answer",
  );
});

it("consecutive turns each keep their own last reply", async () => {
  const { root, turns } = await harness();
  const session = "session-3";
  await turns.ingest(session, userMessage("第一轮的问题", "2026-11-10T02:00:00.000Z"));
  await turns.ingest(session, assistantMessage("一轮的旁白", { turn: 1, step: 1, at: "2026-11-10T02:00:20.000Z" }));
  await turns.ingest(session, assistantMessage("一轮的结论", { turn: 1, step: 2, at: "2026-11-10T02:00:40.000Z" }));
  await turns.ingest(session, turnEnd(1));
  await turns.ingest(session, userMessage("第二轮的问题", "2026-11-10T02:01:00.000Z"));
  await turns.ingest(session, assistantMessage("二轮的旁白", { turn: 2, step: 1, at: "2026-11-10T02:01:20.000Z" }));
  await turns.ingest(session, assistantMessage("二轮的结论", { turn: 2, step: 2, at: "2026-11-10T02:01:40.000Z" }));
  await turns.ingest(session, turnEnd(2));

  const page = await dailyPage(root);
  assert.match(page, /一轮的结论/);
  assert.match(page, /二轮的结论/);
  assert.doesNotMatch(page, /的旁白/, "no narration from either turn");
  const order = [page.indexOf("第一轮的问题"), page.indexOf("一轮的结论"), page.indexOf("第二轮的问题"), page.indexOf("二轮的结论")];
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
    "the two turns do not bleed into each other",
  );
});

it("without turn/end the next user message settles the staged reply", async () => {
  const { root, turns } = await harness();
  const session = "session-4";
  await turns.ingest(session, userMessage("user1", "2026-11-10T02:00:00.000Z"));
  await turns.ingest(session, assistantMessage("asst1", { at: "2026-11-10T02:00:30.000Z" }));
  await turns.ingest(session, assistantMessage("asst2", { at: "2026-11-10T02:01:00.000Z" }));
  await turns.ingest(session, userMessage("user2", "2026-11-10T02:02:00.000Z"));
  await turns.ingest(session, assistantMessage("asst3", { at: "2026-11-10T02:02:30.000Z" }));
  await turns.ingest(session, userMessage("user3", "2026-11-10T02:03:00.000Z"));

  const page = await dailyPage(root);
  assert.doesNotMatch(page, /asst1/, "the superseded step never reaches the page");
  for (const text of ["user1", "asst2", "user2", "asst3", "user3"]) assert.match(page, new RegExp(text));
  const order = ["user1", "asst2", "user2", "asst3", "user3"].map((text) => page.indexOf(text));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "each staged reply settles before the next question");
});

it("a reply lands before the question that follows it in the same minute", async () => {
  const { root, turns } = await harness();
  const session = "session-5";
  await turns.ingest(session, userMessage("上一问", "2026-11-10T02:01:00.000Z"));
  await turns.ingest(session, assistantMessage("上一答", { at: "2026-11-10T02:02:00.000Z" }));
  // Same minute as the reply: the page's `- HH:MM` lines cannot order them, so
  // the buffer's order decides — and the buffer must keep reply before question.
  await turns.ingest(session, userMessage("下一问", "2026-11-10T02:02:30.000Z"));

  const page = await dailyPage(root);
  assert.ok(page.indexOf("上一答") < page.indexOf("下一问"), "the answer precedes the follow-up");
});

it("a new turn number settles the previous reply even without turn/end", async () => {
  const { root, turns } = await harness();
  const session = "session-6";
  await turns.ingest(session, userMessage("第一问", "2026-11-10T02:00:00.000Z"));
  await turns.ingest(session, assistantMessage("第一答", { turn: 1, at: "2026-11-10T02:00:30.000Z" }));
  await turns.ingest(session, assistantMessage("第二答", { turn: 2, at: "2026-11-10T02:01:00.000Z" }));
  await turns.ingest(session, turnEnd(2));

  const page = await dailyPage(root);
  assert.match(page, /第一答/, "the earlier turn's reply was not overwritten by the later one");
  assert.match(page, /第二答/);
});

it("the plugin's own injections reach neither sink", async () => {
  const { root, turns } = await harness();
  const session = "session-7";
  await turns.ingest(session, userMessage("问一下 X", "2026-11-10T02:00:00.000Z"));
  await turns.ingest(session, assistantMessage("先看看 X 的配置", { turn: 1, step: 1, at: "2026-11-10T02:00:20.000Z" }));
  // An injection in mid-turn must not settle the staged step either.
  await turns.ingest(session, userMessage("这段是插件注入的守则，不该被记住", undefined, { kind: "node-memory", form: "instructions" }));
  await turns.ingest(session, assistantMessage("结论：X 周五发布", { turn: 1, step: 2, at: "2026-11-10T02:01:00.000Z" }));
  await turns.ingest(session, turnEnd(1));

  const page = await dailyPage(root);
  assert.doesNotMatch(page, /插件注入的守则/);
  assert.doesNotMatch(page, /先看看/, "the injection did not settle the staged narration early");
  assert.match(page, /结论：X 周五发布/);

  const lines = await transcript(root);
  assert.deepEqual(
    lines.map((line) => line.text),
    ["问一下 X", "先看看 X 的配置", "结论：X 周五发布"],
    "the transcript takes the turn's own steps and nothing injected",
  );
});

it("flushAll settles the turn still in flight", async () => {
  const { root, capture, turns } = await harness();
  const session = "session-8";
  await turns.ingest(session, userMessage("问一下 Y", "2026-11-10T02:00:00.000Z"));
  await turns.ingest(session, assistantMessage("结论：Y 周六发布", { turn: 1, at: "2026-11-10T02:00:30.000Z" }));

  const before = await dailyPage(root);
  assert.match(before, /问一下 Y/);
  assert.doesNotMatch(before, /结论：Y 周六发布/, "the staged reply waits for the turn to close");

  await turns.flushAll();
  const after = await dailyPage(root);
  assert.match(after, /结论：Y 周六发布/, "the shutdown write lands on the daily page");
  assert.equal(capture.pending, 0);
});

it("harness-injected context journals but never reaches the daily page", async () => {
  const { root, capture, turns } = await harness();
  const session = "session-9";
  await turns.ingest(session, userMessage("真正的第一问", "2026-11-10T02:00:00.000Z"));
  await turns.ingest(session, assistantMessage("先看 X 的配置", { turn: 1, step: 1, at: "2026-11-10T02:00:20.000Z" }));
  // Injected between the steps of one turn: it is nobody's question, so it
  // must not settle the staged step-1 narration onto the page either.
  await turns.ingest(
    session,
    userMessage(
      "Time sampled while preparing turn 1, step 2: 2026-11-10T10:00:30+08:00",
      "2026-11-10T02:00:30.000Z",
      { kind: "time-context" },
    ),
  );
  await turns.ingest(session, assistantMessage("结论：X 周五发布", { turn: 1, step: 2, at: "2026-11-10T02:01:00.000Z" }));
  await turns.ingest(session, turnEnd(1));
  await turns.ingest(
    session,
    userMessage("Current runtime context. This snapshot supersedes the earlier one.", "2026-11-10T02:01:10.000Z", {
      kind: "runtime-context",
    }),
  );
  await turns.ingest(session, userMessage("[SCHEDULE REMINDER BATCH] 两条提醒已到期", "2026-11-10T02:01:20.000Z", { kind: "schedule" }));
  await turns.ingest(session, userMessage("AGENTS.md 注入的协作守则", "2026-11-10T02:01:30.000Z", { kind: "agent-instructions" }));

  const page = await dailyPage(root);
  assert.match(page, /真正的第一问/);
  assert.match(page, /结论：X 周五发布/);
  assert.doesNotMatch(page, /先看 X 的配置/, "the mid-turn injection settled nothing");
  for (const injected of [
    "Time sampled while preparing",
    "Current runtime context",
    "[SCHEDULE REMINDER BATCH]",
    "AGENTS.md 注入的协作守则",
  ]) {
    assert.ok(!page.includes(injected), `the ${injected} injection stays off the daily page`);
  }

  const lines = await transcript(root);
  assert.deepEqual(
    lines.map((line) => line.text),
    [
      "真正的第一问",
      "先看 X 的配置",
      "Time sampled while preparing turn 1, step 2: 2026-11-10T10:00:30+08:00",
      "结论：X 周五发布",
      "Current runtime context. This snapshot supersedes the earlier one.",
      "[SCHEDULE REMINDER BATCH] 两条提醒已到期",
      "AGENTS.md 注入的协作守则",
    ],
    "the journal is ground truth and keeps the injections",
  );
  assert.deepEqual(
    lines.map((line) => line.source?.kind ?? null),
    [null, null, "time-context", null, "runtime-context", "schedule", "agent-instructions"],
    "each journaled injection carries its source kind",
  );
  assert.equal(capture.capturedTurns, 2, "only the human words and the final reply were projected");
});

it("a sourced human message and an unsourced one both reach both sinks", async () => {
  const { root, capture, turns } = await harness();
  const session = "session-10";
  // The Host stamps a real prompt `{ kind: "user" }`.
  await turns.ingest(session, userMessage("带 source 的问题", "2026-11-10T02:00:00.000Z", { kind: "user" }));
  // Older hosts send no source at all: dropping it would drop real questions.
  await turns.ingest(session, userMessage("没有 source 的旧问题", "2026-11-10T02:01:00.000Z"));
  await turns.ingest(session, assistantMessage("两个都答了", { turn: 1, at: "2026-11-10T02:01:30.000Z" }));
  await turns.ingest(session, turnEnd(1));

  const page = await dailyPage(root);
  assert.match(page, /带 source 的问题/);
  assert.match(page, /没有 source 的旧问题/);
  assert.match(page, /两个都答了/);

  const lines = await transcript(root);
  assert.deepEqual(lines.map((line) => line.text), ["带 source 的问题", "没有 source 的旧问题", "两个都答了"]);
  assert.equal(lines[0]?.source?.kind, "user", "the human kind is journaled too");
  assert.equal(lines[1]?.source, undefined, "a message without source journals without one");
  assert.equal(capture.capturedTurns, 3);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { apply, createUserMessage, hasGuidance, name, resolveLanguage, toJsonSchema, turnFromEvent } from "../src/plugin.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

/** Minimal cordis-like context that records what the plugin registers. */
function makeCtx(schedule) {
  /** @type {Map<string, Function[]>} */
  const handlers = new Map();
  const tools = [];
  const provided = {};
  const ctx = {
    logger: { warn() {}, info() {} },
    effect: (fn) => {
      fn();
      return () => {};
    },
    on: (event, handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
    provide: (key, value) => {
      provided[key] = value;
    },
    tools: {
      register: (tool) => {
        tools.push(tool);
        return () => {};
      },
    },
    schedule,
    emit(event, ...args) {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
  };
  return { ctx, tools, provided, handlers };
}

function fakeSchedule(initialRows = []) {
  const rows = [...initialRows];
  const creates = [];
  const deletes = [];
  return {
    rows,
    creates,
    deletes,
    async create(sessionId, request) {
      creates.push({ sessionId, request });
      const record = { id: `schedule-${creates.length}`, ...request, sessionId };
      rows.push(record);
      return record;
    },
    async catalog() {
      return rows.map((row) => ({ ...row }));
    },
    async delete({ sessionId, id }) {
      deletes.push({ sessionId, id });
      const index = rows.findIndex((row) => row.id === id);
      if (index === -1) return { id, deleted: false, code: "schedule_not_found" };
      rows.splice(index, 1);
      return { id, deleted: true };
    },
  };
}

function fakeAgent(sessionId, injected) {
  return {
    session: { id: sessionId, header: { id: sessionId }, events: [] },
    inbox: { nextStep: [] },
    inject: (message) => injected.push(message),
  };
}

async function workspace() {
  return mkdtemp(join(tmpdir(), "mem-plugin-"));
}

test("plugin identity is declared and host packages are not imported", () => {
  assert.equal(name, "node-memory");
  // The plugin must stay import-clean: a bare `@deepseek-ai/*` specifier fails
  // to resolve when the Host mounts it by file path, before any code runs.
  const source = readFileSync(new URL("../src/plugin.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^import .*@deepseek-ai/m);
});

test("inlined helpers match the Host contract", () => {
  // toJsonSchema: the authoring DSL the Host's defineTool compiles.
  const schema = toJsonSchema({
    query: { type: "string", required: true, description: "q" },
    limit: { type: "integer" },
  });
  assert.deepEqual(schema, {
    type: "object",
    properties: { query: { type: "string", description: "q" }, limit: { type: "integer" } },
    required: ["query"],
    additionalProperties: false,
  });

  // createUserMessage: frozen, cloned, role user, fresh id.
  const message = createUserMessage({ content: [{ type: "text", text: "hi" }], source: { kind: "node-memory" } });
  assert.equal(message.role, "user");
  assert.equal(typeof message.id, "string");
  assert.ok(message.id.length > 10);
  assert.ok(Object.isFrozen(message));
  assert.throws(() => {
    message.content[0].text = "mutated";
  }, TypeError);
});

test("a fresh session gets guidance and binds a host reminder", async () => {
  const root = await workspace();
  const schedule = fakeSchedule();
  const { ctx } = makeCtx(schedule);
  apply(ctx, {
    workspace: root,
    dreamEnabled: true,
    dreamCron: "0 23 * * *",
    dreamTimeZone: "Asia/Shanghai",
  });
  await settle();

  const injected = [];
  const agent = fakeAgent("session-1", injected);
  ctx.emit("agent/created", { agent });
  await settle();

  assert.equal(schedule.creates.length, 1, "exactly one reminder");
  const [{ sessionId, request }] = schedule.creates;
  assert.equal(sessionId, "session-1");
  assert.equal(request.title, "记忆整理");
  assert.ok(request.prompt.includes("[[node-memory:dream]]"), "prompt carries the marker");
  assert.deepEqual(request.cron, { expression: "0 23 * * *", time_zone: "Asia/Shanghai" });

  assert.ok(injected.length >= 1);
  assert.match(injected[0].content[0].text, /长期记忆/);
  assert.equal(injected[0].source.kind, "node-memory");
});

test("guidance is injected once per session", async () => {
  const root = await workspace();
  const { ctx } = makeCtx(fakeSchedule());
  apply(ctx, { workspace: root, dreamEnabled: false });
  await settle();

  // One persisted session, two agent constructions over it: exactly what a
  // resume looks like. The second must not re-inject.
  const session = { id: "session-2", header: { id: "session-2" }, events: [] };
  const first = [];
  ctx.emit("agent/created", {
    agent: { session, inbox: { nextStep: [] }, inject: (message) => first.push(message) },
  });
  await settle();
  assert.equal(first.length, 1, "first construction injects guidance");

  // `user/message` carries the message itself as the event payload.
  session.events = first.map((message) => ({ type: "user/message", data: message }));
  const second = [];
  ctx.emit("agent/created", {
    agent: { session, inbox: { nextStep: [] }, inject: (message) => second.push(message) },
  });
  await settle();

  assert.equal(hasGuidance(session), true);
  assert.equal(second.length, 0, "resumed session is not re-injected");
});

test("switching off removes the host reminder but keeps the task record", async () => {
  const root = await workspace();
  await mkdir(join(root, "metadata"), { recursive: true });
  await writeFile(
    join(root, "metadata", "dream-task.json"),
    JSON.stringify({
      id: "dream",
      enabled: true,
      cron: "0 23 * * *",
      timeZone: "Asia/Shanghai",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      runs: [{ at: "2026-10-02T15:00:00.000Z", status: "ok" }],
      nextRunAt: "2026-10-26T15:00:00.000Z",
    }),
    "utf8",
  );

  const schedule = fakeSchedule([
    {
      id: "schedule-old",
      sessionId: "session-old",
      title: "记忆整理",
      prompt: "[[node-memory:dream]] x",
    },
  ]);
  const { ctx } = makeCtx(schedule);
  apply(ctx, { workspace: root, dreamEnabled: false });
  await settle();

  assert.equal(schedule.deletes.length, 1, "the delivery arm is removed");
  assert.equal(schedule.rows.length, 0);

  const state = JSON.parse(await readFile(join(root, "metadata", "dream-task.json"), "utf8"));
  assert.equal(state.enabled, false, "the task is paused");
  assert.equal(state.createdAt, "2026-10-01T00:00:00.000Z", "history survives the switch");
  assert.equal(state.runs.length, 1);
  assert.ok(state.pausedAt, "pausing is timestamped");
});

test("turns are captured, plugin messages are not", async () => {
  const root = await workspace();
  const { ctx } = makeCtx(fakeSchedule());
  apply(ctx, { workspace: root, dreamEnabled: false, captureInterval: 1 });
  await settle();

  const session = { id: "session-3", header: { id: "session-3" } };
  ctx.emit("session/event", session, {
    type: "user/message",
    data: { content: [{ type: "text", text: "部署窗口是周五下午四点" }] },
    time: new Date("2026-10-25T02:00:00Z").toISOString(),
  });
  ctx.emit("session/event", session, {
    type: "assistant/message",
    data: { message: { content: [{ type: "text", text: "记下了" }] } },
    time: new Date("2026-10-25T02:01:00Z").toISOString(),
  });
  ctx.emit("session/event", session, {
    type: "user/message",
    data: {
      source: { kind: "node-memory", form: "instructions" },
      content: [{ type: "text", text: "这段是插件注入的守则，不该被记住" }],
    },
  });
  await settle();

  const dir = join(root, "session", "dialog");
  const files = await readdir(dir);
  assert.equal(files.length, 1);
  const text = await readFile(join(dir, files[0]), "utf8");
  assert.match(text, /部署窗口是周五下午四点/);
  assert.match(text, /记下了/, "assistant text lives under data.message");
  assert.doesNotMatch(text, /插件注入的守则/);
});

test("memory_search returns line-ranged evidence for written nodes", async () => {
  const root = await workspace();
  const { ctx, tools } = makeCtx(fakeSchedule());
  apply(ctx, { workspace: root, dreamEnabled: false });
  await settle();

  const write = tools.find((tool) => tool.name === "memory_write");
  const search = tools.find((tool) => tool.name === "memory_search");
  assert.ok(write && search);

  const wrote = await write.execute(
    {
      path: "digest/wiki/发布流程.md",
      content: "# 发布流程\n\n发布窗口是周五下午四点，回滚先切流量。",
      name: "发布流程",
    },
    {},
  );
  assert.match(wrote, /Wrote digest\/wiki\/发布流程\.md/);

  const found = await search.execute({ query: "发布窗口" }, {});
  assert.match(found, /digest\/wiki\/发布流程\.md:\d+-\d+/);
  assert.match(found, /周五下午四点/);

  const empty = await search.execute({ query: "量子纠缠" }, {});
  assert.equal(empty, "No relevant memory found.");
});

test("memory_schedule reports the switch and refuses to diverge from it", async () => {
  const root = await workspace();
  const schedule = fakeSchedule();
  const { ctx, tools } = makeCtx(schedule);
  apply(ctx, { workspace: root, dreamEnabled: true, dreamCron: "0 23 * * *" });
  await settle();

  const tool = tools.find((item) => item.name === "memory_schedule");
  const agent = fakeAgent("session-4", []);
  ctx.emit("agent/created", { agent });
  await settle();

  const status = await tool.execute({ action: "status" }, { agent });
  assert.match(status, /switch \(config dreamEnabled\): true/);
  assert.match(status, /host reminder: schedule-1/);

  // A tool call cannot flip a setting that the UI owns.
  const refused = await tool.execute({ action: "disable" }, { agent });
  assert.match(refused, /cordis\.patch\.yml/);
  assert.equal(schedule.deletes.length, 0, "refusal must not mutate the Host");
});

test("memory_dream delivers material and consumes queued requests", async () => {
  const root = await workspace();
  const { ctx, tools } = makeCtx(fakeSchedule());
  apply(ctx, { workspace: root, dreamEnabled: false });
  await settle();

  const write = tools.find((tool) => tool.name === "memory_write");
  const dream = tools.find((tool) => tool.name === "memory_dream");
  await write.execute(
    { path: "daily/2026-10-24.md", content: "# 10-24\n\n周报用 Markdown。" },
    {},
  );

  // Simulate the timer fallback having queued a request earlier.
  await mkdir(join(root, "metadata", "dream-queue"), { recursive: true });
  await writeFile(
    join(root, "metadata", "dream-queue", "2026-10-25T00-00-00-000Z-abcd.json"),
    JSON.stringify({
      id: "2026-10-25T00-00-00-000Z-abcd",
      createdAt: "2026-10-25T00:00:00.000Z",
      reason: "timer",
      material: "stale material",
    }),
    "utf8",
  );

  const material = await dream.execute({}, {});
  assert.match(material, /Recent daily pages/);
  assert.match(material, /daily\/2026-10-24\.md/);
  assert.match(material, /已消费 1 个待整理请求/);
  assert.deepEqual(await readdir(join(root, "metadata", "dream-queue")), []);
});

test("status distinguishes 'no reminder yet' from 'switch is off'", async () => {
  const root = await workspace();
  const { ctx, tools } = makeCtx(fakeSchedule());
  apply(ctx, { workspace: root, dreamEnabled: false });
  await settle();

  const status = await tools
    .find((item) => item.name === "memory_schedule")
    .execute({ action: "status" }, { agent: fakeAgent("session-6", []) });

  assert.match(status, /switch \(config dreamEnabled\): false/);
  assert.match(status, /switch is off; the task record is kept/);
});

test("no schedule service degrades to the local timer path", async () => {
  const root = await workspace();
  const { ctx, tools } = makeCtx(undefined);
  apply(ctx, { workspace: root, dreamEnabled: true });
  await settle();

  const agent = fakeAgent("session-5", []);
  ctx.emit("agent/created", { agent });
  await settle();

  const status = await tools
    .find((item) => item.name === "memory_schedule")
    .execute({ action: "status" }, { agent });
  assert.match(status, /no schedule service/);
});

test("turnFromEvent handles both message envelopes", () => {
  assert.equal(turnFromEvent({ type: "tool/call", data: {} }), null);
  assert.equal(
    turnFromEvent({ type: "user/message", data: { source: { kind: "node-memory" }, text: "x" } }),
    null,
  );

  const user = turnFromEvent({
    type: "user/message",
    data: { content: [{ type: "text", text: "问" }] },
    time: "2026-10-25T00:00:00.000Z",
  });
  assert.deepEqual(user, { role: "user", text: "问", at: "2026-10-25T00:00:00.000Z" });

  const assistant = turnFromEvent({
    type: "assistant/message",
    data: { message: { content: [{ type: "text", text: "答" }] }, stream: [] },
    time: "2026-10-25T00:00:01.000Z",
  });
  assert.deepEqual(assistant, { role: "assistant", text: "答", at: "2026-10-25T00:00:01.000Z" });
});

test("working language follows the system unless pinned", () => {
  assert.equal(resolveLanguage("zh", {}), "zh");
  assert.equal(resolveLanguage("en", {}), "en");
  assert.equal(resolveLanguage("auto", { LC_ALL: "zh_CN.UTF-8" }), "zh");
  assert.equal(resolveLanguage("auto", { LANG: "en_US.UTF-8" }), "en");
  assert.equal(resolveLanguage(undefined, { LC_ALL: "zh_CN.UTF-8" }), "zh");
});
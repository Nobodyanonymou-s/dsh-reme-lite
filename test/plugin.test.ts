import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "vitest";

import { apply, createUserMessage, hasGuidance, name, resolveLanguage, toJsonSchema, turnFromEvent } from "../src/index.ts";

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 80));

/** The fakes mirror a host we do not have types for; every read off them is `any`. */
type AnyRecord = Record<string, any>;

interface FakeHost {
  ctx: any;
  tools: any[];
  provided: Record<string, unknown>;
  handlers: Map<string, Array<(...args: any[]) => void>>;
}

/** Minimal cordis-like context that records what the plugin registers. */
function makeCtx(schedule: unknown): FakeHost {
  const handlers = new Map<string, Array<(...args: any[]) => void>>();
  const tools: any[] = [];
  const provided: Record<string, unknown> = {};
  const ctx: any = {
    logger: { warn() {}, info() {} },
    effect: (fn: () => void) => {
      fn();
      return () => {};
    },
    on: (event: string, handler: (...args: any[]) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
    provide: (key: string, value: unknown) => {
      provided[key] = value;
    },
    tools: {
      register: (tool: unknown) => {
        tools.push(tool);
        return () => {};
      },
    },
    schedule,
    emit(event: string, ...args: any[]) {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
  };
  return { ctx, tools, provided, handlers };
}

function fakeSchedule(initialRows: any[] = []): any {
  const rows = [...initialRows];
  const creates: any[] = [];
  const deletes: Array<{ sessionId: string; id: string }> = [];
  return {
    rows,
    creates,
    deletes,
    async create(sessionId: string, request: unknown) {
      creates.push({ sessionId, request });
      const record = { id: `schedule-${creates.length}`, ...(request as AnyRecord), sessionId };
      rows.push(record);
      return record;
    },
    async catalog(): Promise<any[]> {
      return rows.map((row) => ({ ...row }));
    },
    async delete({ sessionId, id }: { sessionId: string; id: string }) {
      deletes.push({ sessionId, id });
      const index = rows.findIndex((row: AnyRecord) => row.id === id);
      if (index === -1) return { id, deleted: false, code: "schedule_not_found" };
      rows.splice(index, 1);
      return { id, deleted: true };
    },
  };
}

function fakeAgent(sessionId: string, injected: any[]) {
  return {
    session: { id: sessionId, header: { id: sessionId }, events: [] },
    inbox: { nextStep: [] },
    inject: (message: unknown) => injected.push(message),
  };
}

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mem-plugin-"));
}

it("plugin identity is declared and host packages are not imported", () => {
  assert.equal(name, "node-memory");
  // The plugin must stay import-clean: a bare `@deepseek-ai/*` specifier fails
  // to resolve when the Host mounts it by file path, before any code runs.
  //
  // Part 1 — source contract: a `@deepseek-ai` specifier may only appear on an
  // `import type` line (erased at compile time) or inside the optional dynamic
  // import of the schemastery schema; never as a runtime import.
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^import\s+(?!type\b)[^;]*@deepseek-ai/m);

  // Part 2 — artifact contract: the built entry must keep the same promise, no
  // matter how the bundler reshuffles it. The one allowed occurrence is the
  // dynamic `import("@deepseek-ai/schemastery")` that resolves the optional
  // Config schema; a static `from "@deepseek-ai/…"` is a packaging bug.
  const artifact = new URL("../lib/index.js", import.meta.url);
  assert.ok(existsSync(artifact), "lib/index.js missing — run pnpm build");
  const built = readFileSync(artifact, "utf8");
  const occurrences =
    built.match(/from\s*["']@deepseek-ai[^"']*["']|import\s*\(\s*["']@deepseek-ai[^"']*["']/g) ?? [];
  const offenders = occurrences.filter((occurrence) => !occurrence.includes('import("@deepseek-ai/schemastery"'));
  assert.deepEqual(offenders, [], "the built plugin must not statically import a @deepseek-ai package");
});

it("inlined helpers match the Host contract", () => {
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
  const message = createUserMessage({
    content: [{ type: "text", text: "hi" }],
    source: { kind: "node-memory" },
  }) as { role: string; id: string; content: Array<{ type: string; text: string }> };
  assert.equal(message.role, "user");
  assert.equal(typeof message.id, "string");
  assert.ok(message.id.length > 10);
  assert.ok(Object.isFrozen(message));
  const part = message.content[0];
  assert.ok(part, "the cloned message keeps its single text part");
  assert.throws(() => {
    part.text = "mutated";
  }, TypeError);
});

it("a fresh session gets guidance and binds a host reminder", async () => {
  const root = await workspace();
  const schedule = fakeSchedule();
  const { ctx } = makeCtx(schedule);
  // `auto` follows the runner's locale; pin it so the assertions below mean
  // the same thing wherever the suite runs.
  apply(ctx as never, {
    workspace: root,
    dreamEnabled: true,
    dreamCron: "0 23 * * *",
    dreamTimeZone: "Asia/Shanghai",
    language: "zh",
  });
  await settle();

  const injected: any[] = [];
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

it("guidance is injected once per session", async () => {
  const root = await workspace();
  const { ctx } = makeCtx(fakeSchedule());
  apply(ctx as never, { workspace: root, dreamEnabled: false });
  await settle();

  // One persisted session, two agent constructions over it: exactly what a
  // resume looks like. The second must not re-inject.
  const session: { id: string; header: { id: string }; events: any[] } = {
    id: "session-2",
    header: { id: "session-2" },
    events: [],
  };
  const first: any[] = [];
  ctx.emit("agent/created", {
    agent: { session, inbox: { nextStep: [] }, inject: (message: unknown) => first.push(message) },
  });
  await settle();
  assert.equal(first.length, 1, "first construction injects guidance");

  // `user/message` carries the message itself as the event payload.
  session.events = first.map((message) => ({ type: "user/message", data: message }));
  const second: any[] = [];
  ctx.emit("agent/created", {
    agent: { session, inbox: { nextStep: [] }, inject: (message: unknown) => second.push(message) },
  });
  await settle();

  assert.equal(hasGuidance(session), true);
  assert.equal(second.length, 0, "resumed session is not re-injected");
});

it("switching off removes the host reminder but keeps the task record", async () => {
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
  apply(ctx as never, { workspace: root, dreamEnabled: false });
  await settle();

  assert.equal(schedule.deletes.length, 1, "the delivery arm is removed");
  assert.equal(schedule.rows.length, 0);

  const state = JSON.parse(await readFile(join(root, "metadata", "dream-task.json"), "utf8"));
  assert.equal(state.enabled, false, "the task is paused");
  assert.equal(state.createdAt, "2026-10-01T00:00:00.000Z", "history survives the switch");
  assert.equal(state.runs.length, 1);
  assert.ok(state.pausedAt, "pausing is timestamped");
});

it("turns are captured, plugin messages are not", async () => {
  const root = await workspace();
  const { ctx } = makeCtx(fakeSchedule());
  apply(ctx as never, { workspace: root, dreamEnabled: false, captureInterval: 1 });
  await settle();

  const session = { id: "session-3", header: { id: "session-3" } };
  ctx.emit("session/event", session, { type: "turn/start", data: { turn: 1 } });
  ctx.emit("session/event", session, {
    type: "user/message",
    data: { content: [{ type: "text", text: "部署窗口是周五下午四点" }] },
    time: new Date("2026-10-25T02:00:00Z").toISOString(),
  });
  ctx.emit("session/event", session, {
    type: "assistant/message",
    data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "我先看一下配置" }] } },
    time: new Date("2026-10-25T02:00:30Z").toISOString(),
  });
  ctx.emit("session/event", session, {
    type: "assistant/message",
    data: { turn: 1, step: 2, message: { content: [{ type: "text", text: "记下了" }] } },
    time: new Date("2026-10-25T02:01:00Z").toISOString(),
  });
  ctx.emit("session/event", session, { type: "turn/end", data: { turn: 1, reason: "stop" } });
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
  const written = files[0];
  assert.ok(written, "exactly one turn file was written");
  const text = await readFile(join(dir, written), "utf8");
  assert.match(text, /部署窗口是周五下午四点/);
  assert.match(text, /记下了/, "assistant text lives under data.message");
  assert.match(text, /我先看一下配置/, "the transcript keeps mid-turn narration");
  assert.doesNotMatch(text, /插件注入的守则/);

  // The daily page is the salient slice: the user's words and the turn's final
  // reply, nothing else.
  const dailyDir = join(root, "daily");
  const pages = await readdir(dailyDir);
  assert.equal(pages.length, 1);
  const page = pages[0];
  assert.ok(page, "one daily page was written");
  const daily = await readFile(join(dailyDir, page), "utf8");
  assert.match(daily, /\*\*user\*\*: 部署窗口是周五下午四点/);
  assert.match(daily, /\*\*assistant\*\*: 记下了/);
  assert.doesNotMatch(daily, /我先看一下配置/, "mid-turn narration stays off the page");
  assert.doesNotMatch(daily, /插件注入的守则/);
});

it("memory_search returns line-ranged evidence for written nodes", async () => {
  const root = await workspace();
  const { ctx, tools } = makeCtx(fakeSchedule());
  apply(ctx as never, { workspace: root, dreamEnabled: false });
  await settle();

  const write = tools.find((tool: any) => tool.name === "memory_write");
  const search = tools.find((tool: any) => tool.name === "memory_search");
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

it("memory_schedule reports the switch and refuses to diverge from it", async () => {
  const root = await workspace();
  const schedule = fakeSchedule();
  const { ctx, tools } = makeCtx(schedule);
  apply(ctx as never, { workspace: root, dreamEnabled: true, dreamCron: "0 23 * * *" });
  await settle();

  const tool = tools.find((item: any) => item.name === "memory_schedule");
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

it("memory_dream delivers material and consumes queued requests", async () => {
  const root = await workspace();
  const { ctx, tools } = makeCtx(fakeSchedule());
  apply(ctx as never, { workspace: root, dreamEnabled: false, language: "zh" });
  await settle();

  const write = tools.find((tool: any) => tool.name === "memory_write");
  const dream = tools.find((tool: any) => tool.name === "memory_dream");
  await write.execute({ path: "daily/2026-10-24.md", content: "# 10-24\n\n周报用 Markdown。" }, {});

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

it("status distinguishes 'no reminder yet' from 'switch is off'", async () => {
  const root = await workspace();
  const { ctx, tools } = makeCtx(fakeSchedule());
  apply(ctx as never, { workspace: root, dreamEnabled: false });
  await settle();

  const status = await tools
    .find((item: any) => item.name === "memory_schedule")
    .execute({ action: "status" }, { agent: fakeAgent("session-6", []) });

  assert.match(status, /switch \(config dreamEnabled\): false/);
  assert.match(status, /switch is off; the task record is kept/);
});

it("no schedule service degrades to the local timer path", async () => {
  const root = await workspace();
  const { ctx, tools } = makeCtx(undefined);
  apply(ctx as never, { workspace: root, dreamEnabled: true });
  await settle();

  const agent = fakeAgent("session-5", []);
  ctx.emit("agent/created", { agent });
  await settle();

  const status = await tools
    .find((item: any) => item.name === "memory_schedule")
    .execute({ action: "status" }, { agent });
  assert.match(status, /no schedule service/);
});

it("turnFromEvent handles both message envelopes", () => {
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
  assert.deepEqual(user, { role: "user", text: "问", at: "2026-10-25T00:00:00.000Z", sourceKind: null });

  const assistant = turnFromEvent({
    type: "assistant/message",
    data: { message: { content: [{ type: "text", text: "答" }] }, stream: [] },
    time: "2026-10-25T00:00:01.000Z",
  });
  assert.deepEqual(assistant, { role: "assistant", text: "答", at: "2026-10-25T00:00:01.000Z", sourceKind: null });
});

it("working language follows the system unless pinned", () => {
  assert.equal(resolveLanguage("zh", {}), "zh");
  assert.equal(resolveLanguage("en", {}), "en");
  assert.equal(resolveLanguage("auto", { LC_ALL: "zh_CN.UTF-8" }), "zh");
  assert.equal(resolveLanguage("auto", { LANG: "en_US.UTF-8" }), "en");
  assert.equal(resolveLanguage(undefined, { LC_ALL: "zh_CN.UTF-8" }), "zh");
});

it("a new session takes the reminder over from the session that enabled it", async () => {
  const root = await workspace();
  const schedule = fakeSchedule([
    {
      id: "schedule-old",
      sessionId: "session-old",
      title: "记忆整理",
      prompt: "[[node-memory:dream]] x",
      lastDelivery: { scheduledAt: "2026-10-27T15:00:00.000Z", deliveredAt: "2026-10-27T15:00:00.054Z", messageId: "m" },
    },
  ]);
  const { ctx } = makeCtx(schedule);
  apply(ctx as never, { workspace: root, dreamEnabled: true, dreamCron: "0 23 * * *", dreamTimeZone: "Asia/Shanghai" });
  await settle();

  // A reminder left on the old session is invisible from here: the Host only
  // delivers into the bound session. It must move to the session in use.
  ctx.emit("agent/created", { agent: fakeAgent("session-new", []) });
  await settle();

  assert.equal(schedule.creates.length, 1, "one reminder is bound to the new session");
  assert.equal(schedule.creates[0].sessionId, "session-new");
  assert.deepEqual(schedule.rows.map((row: AnyRecord) => row.sessionId), ["session-new"], "the old row is gone");
  assert.deepEqual(schedule.deletes, [{ sessionId: "session-old", id: "schedule-old" }]);

  // Re-entering the same session must not churn the delivery arm.
  ctx.emit("agent/created", { agent: fakeAgent("session-new", []) });
  await settle();
  assert.equal(schedule.creates.length, 1);
  assert.equal(schedule.deletes.length, 1);
});

it("the move keeps the old row when binding fails", async () => {
  const root = await workspace();
  const schedule = fakeSchedule([
    { id: "schedule-old", sessionId: "session-old", title: "记忆整理", prompt: "[[node-memory:dream]] x" },
  ]);
  schedule.create = async () => {
    throw new Error("host refused");
  };
  const { ctx } = makeCtx(schedule);
  apply(ctx as never, { workspace: root, dreamEnabled: true, dreamCron: "0 23 * * *" });
  await settle();

  ctx.emit("agent/created", { agent: fakeAgent("session-new", []) });
  await settle();

  assert.equal(schedule.deletes.length, 0, "no delivery arm is lost when the new one cannot be created");
  assert.deepEqual(schedule.rows.map((row: AnyRecord) => row.id), ["schedule-old"]);
});

it("memory_dream records the scheduled occurrence it was asked to run", async () => {
  const root = await workspace();
  await mkdir(join(root, "metadata"), { recursive: true });
  await writeFile(
    join(root, "metadata", "dream-task.json"),
    JSON.stringify({
      id: "dream",
      enabled: true,
      cron: "0 23 * * *",
      timeZone: "Asia/Shanghai",
      createdAt: "2026-10-20T00:00:00.000Z",
      updatedAt: "2026-10-20T00:00:00.000Z",
      runs: [],
      lastRunAt: null,
      nextRunAt: "2026-10-29T15:00:00.000Z",
    }),
    "utf8",
  );

  const { ctx, tools } = makeCtx(fakeSchedule());
  apply(ctx as never, { workspace: root, dreamEnabled: true, dreamCron: "0 23 * * *", dreamTimeZone: "Asia/Shanghai" });
  await settle();

  const reminder = {
    type: "user/message",
    time: Date.parse("2026-10-28T15:00:00.227Z"),
    data: {
      source: { kind: "schedule" },
      content: [
        {
          type: "text",
          text: '[SCHEDULE REMINDER BATCH]\nThis is a scheduled message from the user\nreminders_json: [{"schedule_id":"s","occurrence_at":"2026-10-28T15:00:00.000Z","reminder_prompt":"[[node-memory:dream]]\\n定时记忆整理时间到了。"}]',
        },
      ],
    },
  };
  const agent = {
    session: { id: "session-7", header: { id: "session-7" }, events: [reminder] },
    inbox: { nextStep: [] },
    inject() {},
  };

  const dream = tools.find((item: any) => item.name === "memory_dream");
  await dream.execute({}, { agent });

  const state = JSON.parse(await readFile(join(root, "metadata", "dream-task.json"), "utf8"));
  assert.equal(state.lastStatus, "ok");
  assert.equal(state.runs.length, 1);
  assert.equal(state.runs[0].status, "ok");
  assert.match(state.runs[0].detail, /2026-10-28T15:00:00\.000Z/);
  assert.equal(state.nextRunAt, "2026-10-29T15:00:00.000Z", "the next run follows the occurrence, not the call");
  assert.ok(state.lastRunAt, "the run is timestamped");

  // A manual dream in a session with no reminder must not fake a run.
  await dream.execute({}, { agent: { session: { id: "session-8", events: [] }, inbox: { nextStep: [] } } });
  const after = JSON.parse(await readFile(join(root, "metadata", "dream-task.json"), "utf8"));
  assert.equal(after.runs.length, 1);
});

it("status says where the reminder is bound and when it last fired", async () => {
  const root = await workspace();
  const schedule = fakeSchedule([
    {
      id: "schedule-1",
      sessionId: "session-4",
      title: "记忆整理",
      prompt: "[[node-memory:dream]]",
      lastDelivery: {
        scheduledAt: "2026-10-28T15:00:00.000Z",
        deliveredAt: "2026-10-28T15:00:00.194Z",
        messageId: "m",
      },
    },
  ]);
  const { ctx, tools } = makeCtx(schedule);
  apply(ctx as never, { workspace: root, dreamEnabled: true, dreamCron: "0 23 * * *" });
  await settle();

  const agent = fakeAgent("session-4", []);
  ctx.emit("agent/created", { agent });
  await settle();

  const status = await tools.find((item: any) => item.name === "memory_schedule").execute({ action: "status" }, { agent });
  assert.match(status, /session 4 \(this session\)/, "the bound session is short and marked as this one");
  assert.match(status, /delivered 2026-10-28T15:00:00\.194Z/);
});

it("memory_write dates the node so it shows on the heatmap", async () => {
  const root = await workspace();
  const { ctx, tools } = makeCtx(fakeSchedule());
  apply(ctx as never, { workspace: root, dreamEnabled: false });
  await settle();

  const write = tools.find((item: any) => item.name === "memory_write");
  await write.execute({ path: "digest/wiki/dated.md", content: "# dated", kind: "conflict" }, {});

  const text = await readFile(join(root, "digest/wiki/dated.md"), "utf8");
  assert.match(text, /^---\n/);
  assert.match(text, /updated: \d{4}-\d{2}-\d{2}\n/, "a digest path has no date of its own");
  assert.match(text, /kind: conflict/);
});

it("an occurrence without a timestamp falls back to the event time", async () => {
  const root = await workspace();
  await mkdir(join(root, "metadata"), { recursive: true });
  await writeFile(
    join(root, "metadata", "dream-task.json"),
    JSON.stringify({
      id: "dream",
      enabled: true,
      cron: "0 23 * * *",
      timeZone: "Asia/Shanghai",
      createdAt: "2026-10-20T00:00:00.000Z",
      updatedAt: "2026-10-20T00:00:00.000Z",
      runs: [],
      lastRunAt: null,
    }),
    "utf8",
  );
  const { ctx, tools } = makeCtx(fakeSchedule());
  apply(ctx as never, { workspace: root, dreamEnabled: false });
  await settle();

  // The occurrence instant normally rides in reminders_json; an older Host
  // build omitted it. The delivery event still happened at a known time.
  const reminder = {
    type: "user/message",
    time: Date.parse("2026-10-28T15:00:00.900Z"),
    data: {
      source: { kind: "schedule" },
      content: [
        {
          type: "text",
          text: '[SCHEDULE REMINDER BATCH]\nreminders_json: [{"schedule_id":"s","reminder_prompt":"[[node-memory:dream]]\\n整理。"}]',
        },
      ],
    },
  };
  const agent = {
    session: { id: "session-9", header: { id: "session-9" }, events: [reminder] },
    inbox: { nextStep: [] },
    inject() {},
  };
  await tools.find((item: any) => item.name === "memory_dream").execute({}, { agent });

  const state = JSON.parse(await readFile(join(root, "metadata", "dream-task.json"), "utf8"));
  assert.equal(state.runs.length, 1, "the run is still recorded");
  assert.match(state.runs[0].detail, /2026-10-28T15:00:00\.900Z/, "the event time stands in");
});

it("a stale row that fails to delete does not block the others", async () => {
  const root = await workspace();
  const schedule = fakeSchedule([
    { id: "schedule-stuck", sessionId: "session-stuck", title: "记忆整理", prompt: "[[node-memory:dream]] x" },
    { id: "schedule-loose", sessionId: "session-loose", title: "记忆整理", prompt: "[[node-memory:dream]] x" },
  ]);
  const realDelete = schedule.delete;
  schedule.delete = async (args: { id: string }) => {
    if (args.id === "schedule-stuck") throw new Error("host wedged");
    return realDelete(args);
  };
  const { ctx } = makeCtx(schedule);
  apply(ctx as never, { workspace: root, dreamEnabled: true, dreamCron: "0 23 * * *" });
  await settle();

  ctx.emit("agent/created", { agent: fakeAgent("session-new", []) });
  await settle();

  assert.deepEqual(
    schedule.rows.map((row: AnyRecord) => row.id).sort(),
    ["schedule-1", "schedule-stuck"],
    "the loose row is gone; the new binding and the wedged row remain",
  );
});

it("the consumed note follows the pinned language", async () => {
  const root = await workspace();
  const { ctx, tools } = makeCtx(fakeSchedule());
  apply(ctx as never, { workspace: root, dreamEnabled: false, language: "en" });
  await settle();

  await mkdir(join(root, "metadata", "dream-queue"), { recursive: true });
  await writeFile(
    join(root, "metadata", "dream-queue", "2026-10-25T00-00-00-000Z-abcd.json"),
    JSON.stringify({ id: "2026-10-25T00-00-00-000Z-abcd", createdAt: "2026-10-25T00:00:00.000Z", reason: "timer", material: "stale" }),
    "utf8",
  );

  const material = await tools.find((item: any) => item.name === "memory_dream").execute({}, {});
  assert.match(material, /\(1 pending consolidation request\(s\) consumed\.\)/);
});

it("a host delivery record credits the scheduled run without session history", async () => {
  const root = await workspace();
  await mkdir(join(root, "metadata"), { recursive: true });
  await writeFile(
    join(root, "metadata", "dream-task.json"),
    JSON.stringify({
      id: "dream",
      enabled: true,
      cron: "0 23 * * *",
      timeZone: "Asia/Shanghai",
      createdAt: "2026-10-20T00:00:00.000Z",
      updatedAt: "2026-10-20T00:00:00.000Z",
      runs: [],
      lastRunAt: null,
      nextRunAt: "2026-10-30T15:00:00.000Z",
    }),
    "utf8",
  );

  const schedule = fakeSchedule([
    {
      id: "schedule-1",
      sessionId: "session-9",
      title: "记忆整理",
      prompt: "[[node-memory:dream]]",
      lastDelivery: {
        scheduledAt: "2026-10-29T15:00:00.000Z",
        deliveredAt: "2026-10-29T15:00:00.052Z",
        messageId: "m",
      },
    },
  ]);
  const { ctx, tools } = makeCtx(schedule);
  apply(ctx as never, { workspace: root, dreamEnabled: true, dreamCron: "0 23 * * *", dreamTimeZone: "Asia/Shanghai" });
  await settle();

  // A session snapshot inside a tool call does not necessarily carry the event
  // history, so the Host's delivery record is what proves the run happened.
  const agent = {
    session: { id: "session-9", header: { id: "session-9" }, events: [] },
    inbox: { nextStep: [] },
    inject() {},
  };
  await tools.find((item: any) => item.name === "memory_dream").execute({}, { agent });

  const state = JSON.parse(await readFile(join(root, "metadata", "dream-task.json"), "utf8"));
  assert.equal(state.runs.length, 1);
  assert.match(state.runs[0].detail, /2026-10-29T15:00:00\.000Z/);
  assert.equal(state.lastStatus, "ok");
  assert.equal(state.nextRunAt, "2026-10-30T15:00:00.000Z", "the next run follows the delivered occurrence");
});

it("memory_write stamps the writer identity and defaults visibility by path", async () => {
  const root = await workspace();
  const { ctx, tools } = makeCtx(fakeSchedule());
  apply(ctx as never, { workspace: root, dreamEnabled: false });
  await settle();

  const write = tools.find((tool: any) => tool.name === "memory_write");
  const exec = {
    agent: { session: { id: "session-9f21ab", header: { id: "session-9f21ab", agentPreset: "librarian" } } },
  };

  // daily/: the writer's tentative layer — private by default.
  const daily = await write.execute(
    { path: "daily/2026-11-02.md", content: "# 猜测\n\n发布窗口可能改到周三，未证实。" },
    exec,
  );
  assert.match(daily, /Visibility: private to you\./);
  const dailyText = await readFile(join(root, "daily", "2026-11-02.md"), "utf8");
  assert.match(dailyText, /agent: librarian/);
  assert.match(dailyText, /session: 9f21ab/);
  assert.match(dailyText, /visibility: private/);

  // digest/, the curated layer — team-shared by default, no visibility line.
  const digest = await write.execute(
    { path: "digest/wiki/发布流程.md", content: "# 发布流程\n\n发布窗口是周五下午四点。" },
    exec,
  );
  assert.match(digest, /Visibility: team\./);
  const digestText = await readFile(join(root, "digest/wiki/发布流程.md"), "utf8");
  assert.match(digestText, /agent: librarian/);
  assert.doesNotMatch(digestText, /visibility:/);

  // An explicit scope overrides the path default, and room is recorded.
  await write.execute(
    { path: "daily/2026-11-03.md", content: "# 当日\n\n团队站会记录。", scope: "team", room: "hangar" },
    exec,
  );
  const shared = await readFile(join(root, "daily", "2026-11-03.md"), "utf8");
  assert.doesNotMatch(shared, /visibility:/);
  assert.match(shared, /room: hangar/);
});

it("memory_search isolates agents' private notes and scope=team is the audit view", async () => {
  const root = await workspace();
  const { ctx, tools } = makeCtx(fakeSchedule());
  apply(ctx as never, { workspace: root, dreamEnabled: false });
  await settle();

  const write = tools.find((tool: any) => tool.name === "memory_write");
  const search = tools.find((tool: any) => tool.name === "memory_search");

  const librarian = { agent: { session: { id: "session-aaaaaaaa", header: { id: "session-aaaaaaaa", agentPreset: "librarian" } } } };
  const builder = { agent: { session: { id: "session-bbbbbbbb", header: { id: "session-bbbbbbbb", agentPreset: "builder" } } } };

  await write.execute(
    { path: "daily/2026-11-02.md", content: "# 猜测\n\n预算大概会被砍三成，未证实。" },
    librarian,
  );

  // The builder's default retrieval: the librarian's tentative note is absent.
  const asBuilder = await search.execute({ query: "预算" }, builder);
  assert.equal(asBuilder, "No relevant memory found.");

  // scope=team is the audit view: it reaches private notes.
  const audit = await search.execute({ query: "预算", scope: "team" }, builder);
  assert.match(audit, /daily\/2026-11-02\.md/);

  // The writer finds their own note with the default scope.
  const asWriter = await search.execute({ query: "预算" }, librarian);
  assert.match(asWriter, /daily\/2026-11-02\.md/);

  // A digest node is the team layer: visible to the builder by default.
  await write.execute(
    { path: "digest/wiki/预算流程.md", content: "# 预算流程\n\n预算审批走财务系统。" },
    librarian,
  );
  const teamLayer = await search.execute({ query: "预算审批" }, builder);
  assert.match(teamLayer, /digest\/wiki\/预算流程\.md/);
});

it("agentIdentity prefers the configured name, then the preset, then the session", async () => {
  const { agentIdentity } = await import("../src/index.ts");
  const exec = { agent: { session: { id: "session-abcdef12", header: { id: "session-abcdef12", agentPreset: "librarian" } } } };
  assert.equal(agentIdentity(exec, { agentName: "whale-7" }), "whale-7");
  assert.equal(agentIdentity(exec, { agentName: "" }), "librarian");
  assert.equal(
    agentIdentity({ agent: { session: { id: "session-abcdef12", header: { id: "session-abcdef12" } } } }, { agentName: "" }),
    "abcdef12",
  );
  assert.equal(agentIdentity(undefined, { agentName: "" }), "host");
});

it("a session-only identity writes the team layer, not a private one", async () => {
  const root = await workspace();
  const { ctx, tools } = makeCtx(fakeSchedule());
  apply(ctx as never, { workspace: root, dreamEnabled: false });
  await settle();

  const write = tools.find((tool: any) => tool.name === "memory_write");
  const search = tools.find((tool: any) => tool.name === "memory_search");
  // No agentName, no agentPreset: the identity degrades to the session short
  // id, which changes with every session. Private-to-a-session would orphan
  // the note from tomorrow's session — the single-user regression.
  const exec = { agent: { session: { id: "session-cccccccc", header: { id: "session-cccccccc" } } } };

  const wrote = await write.execute(
    { path: "daily/2026-11-02.md", content: "# 猜测\n\n发布窗口可能改到周三，未证实。" },
    exec,
  );
  assert.match(wrote, /Visibility: team\./);
  const text = await readFile(join(root, "daily", "2026-11-02.md"), "utf8");
  assert.doesNotMatch(text, /visibility:/);

  // Tomorrow's session — a different short id — still finds the note.
  const tomorrow = { agent: { session: { id: "session-dddddddd", header: { id: "session-dddddddd" } } } };
  const found = await search.execute({ query: "发布窗口" }, tomorrow);
  assert.match(found, /daily\/2026-11-02\.md/);
});

it("stableIdentity requires a name or a preset, not a bare session id", async () => {
  const { stableIdentity } = await import("../src/index.ts");
  const presetExec = { agent: { session: { id: "s-1", header: { id: "s-1", agentPreset: "librarian" } } } };
  const bareExec = { agent: { session: { id: "s-2", header: { id: "s-2" } } } };
  assert.equal(stableIdentity(presetExec, { agentName: "" }), true);
  assert.equal(stableIdentity(bareExec, { agentName: "" }), false);
  assert.equal(stableIdentity(bareExec, { agentName: "whale-7" }), true);
  assert.equal(stableIdentity(undefined, { agentName: "" }), false);
});

// --- the opt-in session brief (issue 05) -------------------------------------

/**
 * Write a memory node straight to disk, frontmatter included — the shape a
 * dream run would leave behind, without going through the tool.
 */
async function writeNode(root: string, relPath: string, front: Record<string, string>, body: string): Promise<void> {
  const lines = ["---", ...Object.entries(front).map(([key, value]) => `${key}: ${value}`), "---", "", body, ""];
  const absolute = join(root, relPath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, lines.join("\n"), "utf8");
}

/**
 * A small but complete digest for the brief tests: a notable wiki node, a
 * user-declared personal node citing its source, a conflict node that carries
 * `supersedes`, the lesson page — and a daily page holding an assistant aside
 * that must never reach the brief by any route.
 */
async function briefWorkspace(): Promise<string> {
  const root = await workspace();
  await writeNode(
    root,
    "digest/wiki/发布流程.md",
    { name: "发布流程", description: "每周五下午四点发版", updated: "2026-11-08", kind: "notable" },
    "发布窗口是周五下午四点，回滚先切流量。",
  );
  await writeNode(
    root,
    "digest/personal/协作文风.md",
    { name: "协作文风", description: "回复先结论后细节", updated: "2026-11-07", kind: "user-declared" },
    "用户明确要求：先结论后细节。来源：[[daily/2026-11-07]]",
  );
  await writeNode(
    root,
    "digest/wiki/部署端口.md",
    {
      name: "部署端口",
      description: "部署端口原记 8080，现已改 3000",
      updated: "2026-11-09",
      kind: "conflict",
      supersedes: "digest/wiki/旧端口.md",
    },
    "端口以 3000 为准。",
  );
  await writeNode(root, "digest/self/操作教训.md", { name: "操作教训", updated: "2026-11-06" }, "# 操作教训\n\n先回滚再排查，不要现场调参。");
  await writeNode(
    root,
    "daily/2026-11-09.md",
    { name: "2026-11-09", description: "auto-captured conversation notes" },
    "<!-- notes:auto -->\n- 10:00 **user**: 提到菲比斯计划\n- 10:05 **assistant**: 我先查一下克罗诺配置\n<!-- /notes:auto -->",
  );
  return root;
}

/** One section's rows out of a rendered brief — assertions target the section, not the whole text. */
function sectionOf(brief: string, heading: string): string {
  return brief.match(new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n\\n## |$)`))?.[1]?.trim() ?? "";
}

/**
 * A personal-heavy digest for the selection tests: one old user-declared
 * preference plus three newer personal nodes (a conflict and two notables,
 * each citing a source). Under recency the newer asides evict the preference
 * — the 0.5.1 failure a real workspace probe caught; under kind-first
 * selection the preference holds its slot and the newest notable misses out.
 * No node carries `supersedes`, so the superseded section must stay empty.
 */
async function briefPreferenceWorkspace(): Promise<string> {
  const root = await workspace();
  await writeNode(
    root,
    "digest/personal/饮食偏好.md",
    {
      name: "饮食偏好",
      description: "他自述的饮食偏好：猪鸡牛等肉类、绿叶菜、土豆番茄，忌大蒜；减脂周期 10-20 至 12-31",
      updated: "2026-11-02",
      kind: "user-declared",
    },
    "忌大蒜，减脂周期至 12-31。来源：[[daily/2026-11-02]]",
  );
  await writeNode(
    root,
    "digest/personal/工作区布局.md",
    {
      name: "工作区布局",
      description: "项目根只放项目目录与四个抽屉，散文件一律不进根，工具路径按抽屉归位",
      updated: "2026-11-10",
      kind: "conflict",
    },
    "根目录约定以抽屉结构为准。来源：[[digest/wiki/工作区约定]]",
  );
  await writeNode(
    root,
    "digest/personal/造工具方式.md",
    {
      name: "造工具方式",
      description: "造工具先写一次性脚本跑通流程，再决定是否沉淀为可复用工具",
      updated: "2026-11-09",
      kind: "notable",
    },
    "先脚本后工具。来源：[[daily/2026-11-09]]",
  );
  await writeNode(
    root,
    "digest/personal/记忆建模.md",
    {
      name: "记忆建模",
      description: "记忆条目写触发条件而非一律谨慎",
      updated: "2026-11-08",
      kind: "notable",
    },
    "写触发条件不写告诫。来源：[[daily/2026-11-08]]",
  );
  await writeNode(root, "digest/self/操作教训.md", { name: "操作教训", updated: "2026-11-06" }, "# 操作教训\n\n先回滚再排查，不要现场调参。");
  return root;
}

it("without briefEnabled a fresh session gets guidance only — no brief", async () => {
  const root = await briefWorkspace();
  const { ctx } = makeCtx(fakeSchedule());
  apply(ctx as never, { workspace: root, dreamEnabled: false, language: "zh" });
  await settle();

  const injected: any[] = [];
  ctx.emit("agent/created", { agent: fakeAgent("session-brief-off", injected) });
  await settle();

  assert.equal(injected.length, 1, "guidance only, even though digest content exists");
  assert.match(injected[0].content[0].text, /长期记忆/);
  assert.doesNotMatch(injected[0].content[0].text, /会话简报/);
});

it("briefEnabled injects a five-section brief after the guidance", async () => {
  const root = await briefWorkspace();
  const { ctx } = makeCtx(fakeSchedule());
  apply(ctx as never, { workspace: root, dreamEnabled: false, briefEnabled: true, briefBudget: 2000, language: "zh" });
  await settle();

  const injected: any[] = [];
  ctx.emit("agent/created", { agent: fakeAgent("session-brief-on", injected) });
  await settle();

  assert.equal(injected.length, 2, "guidance first, brief second");
  assert.equal(injected[1].source.kind, "node-memory");
  assert.equal(injected[1].source.form, "instructions", "the brief shares the guidance's source form");

  const brief = injected[1].content[0].text;
  assert.match(brief, /^# 会话简报$/m);
  assert.equal((brief.match(/^## /gm) ?? []).length, 5, "the five fixed sections");
  assert.ok(brief.length <= 2000, `within the budget, got ${brief.length}`);

  assert.match(brief, /## 当前状态/);
  // No role label: until a decision kind exists, one would mislabel every
  // recent update as a decision — and a wrong label rides into every session.
  assert.match(brief, /- 部署端口原记 8080，现已改 3000（digest\/wiki\/部署端口\.md，2026-11-09）/);
  assert.match(brief, /- 每周五下午四点发版（digest\/wiki\/发布流程\.md，2026-11-08）/);
  assert.match(brief, /## 关于你/);
  assert.match(brief, /回复先结论后细节（digest\/personal\/协作文风\.md，2026-11-07）/);
  assert.match(brief, /## 已推翻的/);
  assert.match(brief, /- 部署端口原记 8080，现已改 3000（digest\/wiki\/部署端口\.md，2026-11-09）/);
  assert.match(brief, /## 待验证的\n（无）/);
  assert.match(brief, /## 一个弱点提醒/);
  assert.match(brief, /先回滚再排查，不要现场调参/);

  assert.doesNotMatch(brief, /菲比斯/, "the daily page never enters the brief");
  assert.doesNotMatch(brief, /克罗诺/, "the assistant aside never enters the brief");
});

it("the same brief is not injected twice into one session", async () => {
  const root = await briefWorkspace();
  const { ctx } = makeCtx(fakeSchedule());
  apply(ctx as never, { workspace: root, dreamEnabled: false, briefEnabled: true, language: "zh" });
  await settle();

  const session: { id: string; header: { id: string }; events: any[] } = {
    id: "session-brief-dup",
    header: { id: "session-brief-dup" },
    events: [],
  };
  const first: any[] = [];
  ctx.emit("agent/created", {
    agent: { session, inbox: { nextStep: [] }, inject: (message: unknown) => first.push(message) },
  });
  await settle();
  assert.equal(first.length, 2, "guidance and brief on the first construction");

  // The Host replaying `agent/created` over a resumed session: whatever the
  // process already injected is in the events, and must not be injected again.
  session.events = first.map((message) => ({ type: "user/message", data: message }));
  const second: any[] = [];
  ctx.emit("agent/created", {
    agent: { session, inbox: { nextStep: [] }, inject: (message: unknown) => second.push(message) },
  });
  await settle();
  assert.equal(second.length, 0, "guidance and brief alike stay deduped");
});

it("an over-budget brief drops whole rows and keeps every heading", async () => {
  const root = await workspace();
  // Enough bulk that a 300-character budget must eat rows — and the drop
  // order is by section first: current state sheds its lowest-weight rows,
  // about you only gives one up when state has hit its one-row floor, and
  // every section that still has rows keeps at least one.
  await writeNode(root, "digest/wiki/清单甲.md", { name: "清单甲", description: "清单甲记录了常规巡检的完整步骤与联系人名单供随时查阅", updated: "2026-11-01" }, "常规巡检步骤。");
  await writeNode(root, "digest/self/操作教训.md", { name: "操作教训", updated: "2026-11-09" }, "# 操作教训\n\n变更窗口内先冻结配置再观察指标，宁可多等一个周期也不要现场调参，历史两次事故都源于现场改动。");
  await writeNode(root, "digest/personal/偏好甲.md", { name: "偏好甲", description: "用户在例会上明确要求所有回复都先给结论再给细节依据", updated: "2026-11-04", kind: "user-declared" }, "先结论后细节。来源：[[daily/2026-11-04]]");
  await writeNode(root, "digest/personal/偏好乙.md", { name: "偏好乙", description: "用户强调周五下午不安排发布以免占用复盘时间窗口", updated: "2026-11-05", kind: "user-declared" }, "周五下午不发版。来源：[[daily/2026-11-05]]");
  await writeNode(root, "digest/personal/偏好丙.md", { name: "偏好丙", description: "用户要求涉及生产环境的操作必须先在预发环境演练一遍", updated: "2026-11-06", kind: "user-declared" }, "生产操作先预发。来源：[[daily/2026-11-06]]");
  await writeNode(root, "digest/wiki/端口旧值.md", { name: "端口旧值", description: "部署端口原记 8080 与现值不一致本节点记录旧值仅作追溯", updated: "2026-11-07", kind: "conflict" }, "旧端口 8080 已废弃。");
  await writeNode(root, "digest/wiki/阈值旧值.md", { name: "阈值旧值", description: "告警阈值原记百分之九十现改百分之八十五旧结论不再生效", updated: "2026-11-08", kind: "conflict" }, "旧阈值已废弃。");

  const { ctx } = makeCtx(fakeSchedule());
  apply(ctx as never, { workspace: root, dreamEnabled: false, briefEnabled: true, briefBudget: 300, language: "zh" });
  await settle();

  const injected: any[] = [];
  ctx.emit("agent/created", { agent: fakeAgent("session-brief-budget", injected) });
  await settle();

  assert.equal(injected.length, 2);
  const brief = injected[1].content[0].text;
  assert.ok(brief.length <= 300, `within the 300-char budget, got ${brief.length}`);
  assert.equal((brief.match(/^## /gm) ?? []).length, 5, "the skeleton never loses a heading");
  // State goes first: the kindless lesson row, then the older conflict. The
  // section floor stops the diet there — its newest conflict row survives.
  assert.doesNotMatch(brief, /digest\/self\/操作教训\.md/, "the lowest-weight state row goes before anything else");
  assert.doesNotMatch(brief, /端口旧值/, "inside a section the older row goes first, kind aside");
  assert.match(brief, /告警阈值原记/, "the state floor keeps one row — the newest conflict");
  // About you is defended: only one row beyond the floor goes, and it goes
  // whole — never clipped mid-line.
  assert.doesNotMatch(brief, /例会上明确要求/, "the oldest preference row goes once state has hit its floor");
  assert.match(brief, /周五下午不安排发布/, "the remaining preference rows hold");
  // Single-row sections are all floor: the weakness line survives a budget
  // that once dropped it.
  assert.match(brief, /变更窗口/, "the weakness line is a one-row section, so the floor keeps it");
  assert.ok(brief.includes("（无）"), "superseded has no chain in this workspace and reads its placeholder");
  assert.doesNotMatch(brief, /清单甲/, "rows outside every section stay out entirely");
});

it("about you ranks kind before recency; superseded stays empty without a chain", async () => {
  const root = await briefPreferenceWorkspace();
  const { ctx } = makeCtx(fakeSchedule());
  apply(ctx as never, { workspace: root, dreamEnabled: false, briefEnabled: true, briefBudget: 900, language: "zh" });
  await settle();

  const injected: any[] = [];
  ctx.emit("agent/created", { agent: fakeAgent("session-brief-pref", injected) });
  await settle();

  assert.equal(injected.length, 2);
  const brief = injected[1].content[0].text;

  const about = sectionOf(brief, "关于你");
  // The preference is the oldest candidate here; recency alone would have
  // filled all three slots with the newer asides, which is what 0.5.1 did on
  // a real workspace.
  assert.match(about, /忌大蒜.*饮食偏好\.md，2026-11-02/, "the declared preference holds a slot despite being the oldest");
  assert.match(about, /工作区布局\.md/, "the personal conflict with a source ranks with it");
  assert.ok(
    about.indexOf("工作区布局") < about.indexOf("忌大蒜"),
    "conflict outranks user-declared, user-declared outranks notable",
  );
  assert.doesNotMatch(about, /记忆建模/, "the newest notable is the row that misses out, not the older preference");

  assert.equal(sectionOf(brief, "已推翻的"), "（无）", "no supersedes chain anywhere, so the section stays empty");
  assert.doesNotMatch(sectionOf(brief, "已推翻的"), /工作区布局/, "a conflict kind alone never lands in superseded");
});

it("superseded lists a node only when it carries a real supersedes chain", async () => {
  const root = await briefPreferenceWorkspace();
  await writeNode(
    root,
    "digest/wiki/端口订正.md",
    {
      name: "端口订正",
      description: "部署端口订正为 3000，旧值 8080 作废",
      updated: "2026-11-11",
      kind: "conflict",
      supersedes: "digest/wiki/旧端口.md",
    },
    "端口以 3000 为准。",
  );
  const { ctx } = makeCtx(fakeSchedule());
  apply(ctx as never, { workspace: root, dreamEnabled: false, briefEnabled: true, briefBudget: 900, language: "zh" });
  await settle();

  const injected: any[] = [];
  ctx.emit("agent/created", { agent: fakeAgent("session-brief-chain", injected) });
  await settle();

  assert.equal(injected.length, 2);
  const brief = injected[1].content[0].text;

  const superseded = sectionOf(brief, "已推翻的");
  assert.match(superseded, /部署端口订正为 3000，旧值 8080 作废（digest\/wiki\/端口订正\.md，2026-11-11）/);
  // Same kind, no chain: the workspace-layout conflict is a live correction,
  // so it stays in about you rather than reading as an overturned conclusion.
  assert.doesNotMatch(superseded, /工作区布局/, "kind: conflict without a chain is not superseded");
  assert.match(sectionOf(brief, "关于你"), /工作区布局\.md/);
});

it("a tight budget sheds state rows first and about you keeps the preference", async () => {
  const root = await briefPreferenceWorkspace();
  const { ctx } = makeCtx(fakeSchedule());
  apply(ctx as never, { workspace: root, dreamEnabled: false, briefEnabled: true, briefBudget: 400, language: "zh" });
  await settle();

  const injected: any[] = [];
  ctx.emit("agent/created", { agent: fakeAgent("session-brief-floor", injected) });
  await settle();

  assert.equal(injected.length, 2);
  const brief = injected[1].content[0].text;
  assert.ok(brief.length <= 400, `within the 400-char budget, got ${brief.length}`);
  assert.equal((brief.match(/^## /gm) ?? []).length, 5, "the skeleton never loses a heading");
  assert.doesNotMatch(brief, /记忆建模/, "the budget eats the quietest state row before anything else");
  const about = sectionOf(brief, "关于你");
  assert.match(about, /饮食偏好\.md/, "about you keeps the declared preference once the budget bites");
  assert.doesNotMatch(about, /^（无）$/, "the section floor keeps about you from emptying out");
});

it("an empty workspace still yields the five-section placeholder brief", async () => {
  const root = await workspace();
  const { ctx } = makeCtx(fakeSchedule());
  apply(ctx as never, { workspace: root, dreamEnabled: false, briefEnabled: true, language: "zh" });
  await settle();

  const injected: any[] = [];
  ctx.emit("agent/created", { agent: fakeAgent("session-brief-empty", injected) });
  await settle();

  assert.equal(injected.length, 2, "the brief injects even with nothing to say");
  const brief = injected[1].content[0].text;
  assert.equal((brief.match(/^## /gm) ?? []).length, 5);
  assert.equal((brief.match(/（无）/g) ?? []).length, 5, "every section reads its placeholder");
  assert.ok(brief.length <= 900);
});

it("a settings.json switch overrides the unset mount config for the brief", async () => {
  const root = await briefWorkspace();
  await mkdir(join(root, "metadata"), { recursive: true });
  await writeFile(join(root, "metadata", "settings.json"), `${JSON.stringify({ briefEnabled: true })}\n`, "utf8");
  const { ctx } = makeCtx(fakeSchedule());
  apply(ctx as never, { workspace: root, dreamEnabled: false, language: "zh" });
  await settle();

  const injected: any[] = [];
  ctx.emit("agent/created", { agent: fakeAgent("session-brief-saved", injected) });
  await settle();
  assert.equal(injected.length, 2, "the page's saved choice wins over an unset mount key");
});

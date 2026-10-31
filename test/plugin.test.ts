import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const written = files[0];
  assert.ok(written, "exactly one turn file was written");
  const text = await readFile(join(dir, written), "utf8");
  assert.match(text, /部署窗口是周五下午四点/);
  assert.match(text, /记下了/, "assistant text lives under data.message");
  assert.doesNotMatch(text, /插件注入的守则/);
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
  assert.deepEqual(user, { role: "user", text: "问", at: "2026-10-25T00:00:00.000Z" });

  const assistant = turnFromEvent({
    type: "assistant/message",
    data: { message: { content: [{ type: "text", text: "答" }] }, stream: [] },
    time: "2026-10-25T00:00:01.000Z",
  });
  assert.deepEqual(assistant, { role: "assistant", text: "答", at: "2026-10-25T00:00:01.000Z" });
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

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";

import { apply } from "../src/index.ts";
import { buildStatus } from "../src/status.ts";

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 80));

/**
 * A smaller host than plugin.test.ts needs: no schedule service (the conflict
 * path does not care about reminders), plus an optional web server so the
 * status route can be driven the way the browser drives it.
 */
function makeCtx(routes?: Map<string, any>): { ctx: any; tools: any[] } {
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
    ...(routes ? { webServer: { register: (route: any) => (routes.set(route.path, route.handler), () => {}) } } : {}),
  };
  return { ctx, tools };
}

function fakeResponse(): { code: number; body: string } {
  const response = { code: 0, body: "" };
  // The Host's response surface is wider than what `send` uses; `any` keeps the
  // fake honest about not implementing the rest.
  return Object.assign(response, {
    writeHead(code: number) {
      response.code = code;
    },
    end(body?: string) {
      response.body = String(body ?? "");
    },
  }) as { code: number; body: string };
}

const LIBRARIAN = { agent: { session: { id: "session-librarian", header: { id: "session-librarian", agentPreset: "librarian" } } } };

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mem-conflict-"));
}

/** What a conflict line looks like once parsed, in the tests that wrote it. */
interface Recorded {
  at: string;
  agent: string;
  relPath: string;
  oldExcerpt: string;
  newExcerpt: string;
}

async function plugin(routes?: Map<string, any>) {
  const root = await workspace();
  const { ctx, tools } = makeCtx(routes);
  apply(ctx as never, { workspace: root, dreamEnabled: false, agentName: "librarian" });
  await settle();
  return { root, tools };
}

it("a kind=conflict write lands a durable line naming who, where, old and new", async () => {
  const { root, tools } = await plugin();
  const write = tools.find((tool: any) => tool.name === "memory_write");

  await write.execute({ path: "digest/wiki/发布窗口.md", content: "# 发布窗口\n\n发布窗口是周五下午四点。" }, LIBRARIAN);
  const result = await write.execute(
    { path: "digest/wiki/发布窗口.md", content: "# 发布窗口\n\n发布窗口改到周三上午十点。", kind: "conflict" },
    LIBRARIAN,
  );

  assert.match(result, /Conflict recorded — see metadata\/conflicts\.jsonl/);
  const node = await readFile(join(root, "digest/wiki/发布窗口.md"), "utf8");
  assert.match(node, /kind: conflict/, "the node itself still carries the red kind");

  const text = await readFile(join(root, "metadata", "conflicts.jsonl"), "utf8");
  const [entry] = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Recorded);
  assert.ok(entry, "exactly one line");
  assert.equal(entry.agent, "librarian");
  assert.equal(entry.relPath, "digest/wiki/发布窗口.md");
  assert.match(entry.oldExcerpt, /周五下午四点/, "the value being replaced is on the record");
  assert.match(entry.newExcerpt, /周三上午十点/);
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(entry.at), "the entry is timestamped");
});

it("a second conflicting write appends, so the trail keeps both rounds", async () => {
  const { root, tools } = await plugin();
  const write = tools.find((tool: any) => tool.name === "memory_write");
  const conflict = { path: "digest/wiki/端口.md", kind: "conflict" };

  await write.execute({ path: "digest/wiki/端口.md", content: "# 端口\n\n服务端口是 8080。" }, LIBRARIAN);
  await write.execute({ ...conflict, content: "# 端口\n\n服务端口是 9090。" }, LIBRARIAN);
  await write.execute({ ...conflict, content: "# 端口\n\n服务端口是 7070。" }, LIBRARIAN);

  const text = await readFile(join(root, "metadata", "conflicts.jsonl"), "utf8");
  const lines = text.trim().split("\n");
  assert.equal(lines.length, 2, "one line per conflicting write, not one per write");
  const lastLine = lines.at(-1);
  assert.ok(lastLine, "the second round is on file");
  const last = JSON.parse(lastLine) as Recorded;
  assert.match(last.oldExcerpt, /9090/, "the second round saw the first round's result");
  assert.match(last.newExcerpt, /7070/);
});

it("non-conflicting writes record nothing", async () => {
  const { root, tools } = await plugin();
  const write = tools.find((tool: any) => tool.name === "memory_write");

  const first = await write.execute({ path: "digest/wiki/普通.md", content: "# 普通\n\n普通记录。" }, LIBRARIAN);
  // A plain overwrite of the same node is not a contradiction: no line either.
  const second = await write.execute({ path: "digest/wiki/普通.md", content: "# 普通\n\n改写后的普通记录。" }, LIBRARIAN);
  assert.doesNotMatch(first, /Conflict recorded/);
  assert.doesNotMatch(second, /Conflict recorded/);

  const text = await readFile(join(root, "metadata", "conflicts.jsonl"), "utf8").catch(() => "");
  assert.equal(text, "", "the log stays empty");
});

it("the conflict log reader skips a corrupt line instead of failing", async () => {
  const { ConflictLog } = await import("../src/conflict.ts");
  const root = await workspace();
  const log = new ConflictLog({ root });
  await log.record({ agent: "a", relPath: "daily/x.md", oldExcerpt: "old", newExcerpt: "new" });
  await log.record({ agent: "b", relPath: "daily/y.md" });
  const broken = await readFile(log.file, "utf8");
  await writeFile(log.file, `${broken}{"at":"torn","agent":\n`, "utf8");

  assert.equal(await log.total(), 2);
  const recent = await log.recent(1);
  assert.equal(recent[0]?.agent, "b", "newest first");
  assert.equal((await log.recent(5)).length, 2);
});

it("buildStatus carries the conflict summary and stays backward compatible", async () => {
  const { ConflictLog } = await import("../src/conflict.ts");
  const root = await workspace();
  const log = new ConflictLog({ root });
  await log.record({ agent: "librarian", relPath: "daily/x.md", oldExcerpt: "a", newExcerpt: "b" });

  const status = await buildStatus({
    root,
    conflicts: { total: await log.total(), recent: await log.recent(20) },
  });
  assert.equal(status.conflicts.total, 1);
  assert.equal(status.conflicts.recent[0]?.relPath, "daily/x.md");

  // A caller that predates the field (or the client page of an older build)
  // still gets a payload shaped the same way.
  const legacy = await buildStatus({ root });
  assert.deepEqual(legacy.conflicts, { total: 0, recent: [] });
});

it("/node-memory/status.json serves the conflict summary", async () => {
  const routes = new Map<string, any>();
  const { root, tools } = await plugin(routes);
  const write = tools.find((tool: any) => tool.name === "memory_write");
  await write.execute({ path: "digest/wiki/发布流程.md", content: "# 发布流程\n\n发布窗口是周五下午四点。" }, LIBRARIAN);
  await write.execute(
    { path: "digest/wiki/发布流程.md", content: "# 发布流程\n\n发布窗口改到周三上午十点。", kind: "conflict" },
    LIBRARIAN,
  );

  const handler = routes.get("/node-memory/status.json");
  assert.ok(handler, "the status route is registered");
  const response = fakeResponse();
  await handler({}, response);
  const payload = JSON.parse(response.body) as {
    conflicts: { total: number; recent: Array<{ relPath: string; agent: string }> };
  };
  assert.equal(response.code, 200);
  assert.equal(payload.conflicts.total, 1);
  assert.equal(payload.conflicts.recent[0]?.relPath, "digest/wiki/发布流程.md");
  assert.equal(payload.conflicts.recent[0]?.agent, "librarian");
});

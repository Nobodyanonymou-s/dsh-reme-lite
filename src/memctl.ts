#!/usr/bin/env node
/**
 * Offline control surface for the memory workspace.
 * Useful for demos and smoke tests without starting DSH.
 *
 *   node bin/memctl.js init
 *   node bin/memctl.js write digest/wiki/demo "some durable fact"
 *   node bin/memctl.js search "durable fact"
 *   node bin/memctl.js capture session-1 user "we ship on Friday 4pm"
 *   node bin/memctl.js schedule status | enable [cron] | disable
 *   node bin/memctl.js dream
 *   node bin/memctl.js stat
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { Capture } from "./capture.ts";
import { buildDreamMaterial } from "./dream.ts";
import { DreamTaskStore } from "./dream-task.ts";
import { renderNode } from "./markdown.ts";
import { describeNextRun } from "./schedule.ts";
import { MemoryStore } from "./store.ts";

const root = process.env.DSH_MEMORY_ROOT || join(homedir(), ".dsh", "memory");
const [, , command, ...args] = process.argv;

const store = new MemoryStore({ root });
const tasks = new DreamTaskStore({ root });

/**
 * @param {string} text
 */
function fail(text: string): void {
  console.error(text);
  process.exitCode = 1;
}

switch (command) {
  case "init": {
    await store.ensureLayout();
    const result = await store.rebuild();
    console.log(`workspace: ${root}`);
    console.log(`indexed: ${result.files} files / ${result.chunks} chunks`);
    break;
  }
  case "write": {
    const [relPath, ...words] = args;
    if (!relPath || words.length === 0) {
      fail("usage: memctl write <daily|digest/...md> <content>");
      break;
    }
    await store.rebuild();
    const written = await store.write({
      relPath,
      content: renderNode({ name: relPath.split("/").pop()?.replace(/\.md$/, "") }, words.join(" ")),
    });
    console.log(`wrote ${written.relPath} (${written.bytes} bytes)`);
    break;
  }
  case "search": {
    const query = args.join(" ");
    if (!query) {
      fail("usage: memctl search <query>");
      break;
    }
    await store.rebuild();
    const hits = store.search(query, { limit: 5 });
    if (hits.length === 0) {
      console.log("No relevant memory found.");
      break;
    }
    for (const hit of hits) {
      console.log(`${hit.relPath}:${hit.startLine}-${hit.endLine}  ${hit.score.toFixed(2)}${hit.via ? ` (via ${hit.via})` : ""}`);
      console.log(`  ${hit.heading || "-"}`);
      console.log(`  ${hit.text.replace(/\s+/g, " ").slice(0, 160)}`);
    }
    break;
  }
  case "capture": {
    const [sessionId, role, ...words] = args;
    if (!sessionId || !role || words.length === 0) {
      fail("usage: memctl capture <session> <user|assistant> <text>");
      break;
    }
    const capture = new Capture({ root, interval: 2 });
    await capture.record(sessionId, {
      role: role === "assistant" ? "assistant" : "user",
      text: words.join(" "),
      at: new Date().toISOString(),
    });
    console.log(`captured; pending=${capture.pending}`);
    break;
  }
  case "schedule": {
    const action = args[0] ?? "status";
    if (action === "enable") {
      const cron = args[1] ?? "0 23 * * *";
      const timeZone = args[2] ?? null;
      const state = await tasks.enable({ cron, timeZone });
      console.log(
        `enabled  cron="${state.cron}"  next=${describeNextRun(state.cron, { timeZone: state.timeZone ?? undefined })}`,
      );
      console.log("note: memctl edits the task record directly; the plugin treats config dreamEnabled as authoritative.");
    } else if (action === "disable") {
      const state = await tasks.disable();
      console.log(
        `paused   record kept · last run ${state.lastRunAt ?? "never"} · runs kept ${state.runs.length}`,
      );
    } else {
      const state = await tasks.load();
      console.log(
        JSON.stringify(
          {
            enabled: state.enabled,
            cron: state.cron,
            timeZone: state.timeZone,
            nextRunAt: state.nextRunAt,
            next: state.enabled
              ? describeNextRun(state.cron, { timeZone: state.timeZone ?? undefined })
              : "-",
            lastRunAt: state.lastRunAt,
            lastStatus: state.lastStatus,
            lastError: state.lastError,
            runs: state.runs.length,
            pausedAt: state.pausedAt,
            createdAt: state.createdAt,
          },
          null,
          2,
        ),
      );
    }
    break;
  }
  case "dream": {
    await store.rebuild();
    console.log(await buildDreamMaterial({ store, days: Number(args[0]) || 7 }));
    break;
  }
  case "stat":
  default: {
    await store.rebuild();
    console.log(JSON.stringify(store.stats(), null, 2));
    if (!command) console.log("usage: memctl <init|write|search|capture|stat>");
    break;
  }
}

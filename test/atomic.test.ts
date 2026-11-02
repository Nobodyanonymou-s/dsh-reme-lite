import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";

import { PathLocks, atomicWriteFile } from "../src/atomic.ts";

it("atomicWriteFile lands the content and leaves no temp files behind", async () => {
  const root = await mkdtemp(join(tmpdir(), "mem-atomic-"));
  const target = join(root, "daily", "2026-11-02.md");
  await atomicWriteFile(target, "---\nname: day\n---\n\nfirst\n");
  await atomicWriteFile(target, "---\nname: day\n---\n\nsecond\n");
  assert.equal(await readFile(target, "utf8"), "---\nname: day\n---\n\nsecond\n");
  const residue = (await readdir(join(root, "daily"))).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(residue, [], "temp files must not survive a successful write");
});

it("PathLocks runs same-path operations one at a time, in order", async () => {
  const locks = new PathLocks();
  const events: string[] = [];
  let active = 0;
  let peak = 0;

  const job = (name: string) =>
    locks.run("C:/ws/daily/x.md", async () => {
      active += 1;
      peak = Math.max(peak, active);
      events.push(`start ${name}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push(`end ${name}`);
      active -= 1;
      return name;
    });

  const results = await Promise.all([job("a"), job("b"), job("c")]);
  assert.deepEqual(results, ["a", "b", "c"]);
  assert.equal(peak, 1, "operations on the same path never overlap");
  // FIFO: each operation ends before the next begins.
  assert.deepEqual(events, ["start a", "end a", "start b", "end b", "start c", "end c"]);
});

it("PathLocks isolates different paths and survives a failed operation", async () => {
  const locks = new PathLocks();
  const first = locks.run("C:/ws/a.md", async () => {
    throw new Error("boom");
  });
  await assert.rejects(first, /boom/);

  // A rejected operation must not poison the chain behind it.
  const after = await locks.run("C:/ws/a.md", async () => "ok");
  assert.equal(after, "ok");

  // Different paths do not wait for each other.
  let released = false;
  const slow = locks.run("C:/ws/b.md", () => {
    return new Promise<string>((resolve) => {
      setTimeout(() => {
        released = true;
        resolve("slow");
      }, 20);
    });
  });
  const fast = await locks.run("C:/ws/c.md", async () => "fast");
  assert.equal(fast, "fast");
  assert.equal(released, false, "an unrelated path is not blocked");
  assert.equal(await slow, "slow");
});

it("an interleaved capture-style merge keeps both writers' turns", async () => {
  // The read-modify-write pattern Capture.flush uses: two sessions fold into
  // the same day page concurrently; without the lock one side's turns vanish.
  const locks = new PathLocks();
  const root = await mkdtemp(join(tmpdir(), "mem-atomic-"));
  const page = join(root, "daily", "2026-11-02.md");
  await mkdir(join(root, "daily"), { recursive: true });
  await writeFile(page, "---\nname: day\n---\n\n# day\n\n- 00:00 **user**: seed\n", "utf8");

  const appendLine = (line: string) =>
    locks.run(page, async () => {
      const text = await readFile(page, "utf8");
      const next = `${text.replace(/\n+$/, "")}\n${line}\n`;
      await writeFile(page, next, "utf8");
    });

  await Promise.all(Array.from({ length: 10 }, (_, i) => appendLine(`- 0${i}:00 **user**: turn ${i}`)));
  const finalText = await readFile(page, "utf8");
  for (let i = 0; i < 10; i += 1) {
    assert.ok(finalText.includes(`turn ${i}`), `turn ${i} survived the concurrent flushes`);
  }
});

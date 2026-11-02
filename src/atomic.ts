/**
 * Write safety for a workspace more than one agent writes to.
 *
 * Two primitives, both process-local:
 *
 *   - `atomicWriteFile` — write a sibling temp file, then rename over the
 *     target. A reader never observes a half-written node, and a crash leaves
 *     either the old file or the new one, never a torn one.
 *   - `PathLocks` — serialize read-modify-write cycles per absolute path, so
 *     two agents flushing the same daily page or writing the same node cannot
 *     interleave and lose one side's update.
 *
 * Cross-process safety is explicitly out of scope: two Host processes sharing
 * one workspace directory need an external lock, which a dependency-free
 * plugin does not ship. One Host, many agents — that is the boundary.
 */

import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Windows can transiently refuse the rename (indexer, antivirus); back off. */
const RENAME_ATTEMPTS = 4;

export async function atomicWriteFile(absolute: string, content: string): Promise<void> {
  const directory = dirname(absolute);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basenameOf(absolute)}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`);
  try {
    await writeFile(temporary, content, "utf8");
    let lastError: unknown = null;
    for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt += 1) {
      try {
        await rename(temporary, absolute);
        return;
      } catch (error) {
        lastError = error;
        // EPERM/EBUSY on Windows is usually a watcher holding the target for a
        // moment; EEXIST never happens (rename replaces), so retry the rest.
        await sleep(25 * (attempt + 1));
      }
    }
    throw lastError ?? new Error(`atomic rename failed: ${absolute}`);
  } finally {
    // A rename that ultimately failed leaves the temp file behind; a succeeded
    // one already moved it. `force` covers both.
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function basenameOf(absolute: string): string {
  const parts = absolute.split(/[\\/]/);
  return parts[parts.length - 1] ?? "file";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Per-path serialization. The stored chain never rejects: a failed operation
 * must not poison the writes queued behind it. The map entry is dropped when
 * the chain goes idle, so a long-lived process does not accumulate one entry
 * per file ever written.
 */
export class PathLocks {
  #chains = new Map<string, Promise<unknown>>();

  run<T>(absolute: string, operation: () => Promise<T>): Promise<T> {
    const key = absolute.split(/[\\/]/).join("/");
    const previous = this.#chains.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const guarded = next.catch(() => {});
    this.#chains.set(key, guarded);
    void guarded.then(() => {
      if (this.#chains.get(key) === guarded) this.#chains.delete(key);
    });
    return next;
  }
}

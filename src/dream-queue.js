/**
 * Consolidation requests that have not been executed yet.
 *
 * A scheduled run may fire while nothing can execute it (no background agent
 * available, or the host is idle). Instead of dropping the run, the material
 * is persisted as a request. The next session picks it up and the agent does
 * the work with the normal tools — "the task is due" and "the task was done"
 * are two different states, and the queue is where they differ.
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const REQUEST_ID = /^\d{4}-\d{2}-\d{2}T[\d-]+Z-[a-z0-9]{4}$/;

export class DreamQueue {
  /** @param {{ root: string }} options */
  constructor(options) {
    this.root = options.root;
    this.dir = join(options.root, "metadata", "dream-queue");
  }

  async ensure() {
    await mkdir(this.dir, { recursive: true });
  }

  /**
   * @param {{ material: string, reason?: string, at?: Date }} request
   * @returns {Promise<{ id: string, path: string }>}
   */
  async push(request) {
    await this.ensure();
    const at = request.at ?? new Date();
    const stamp = at.toISOString().replace(/[:.]/g, "-");
    const id = `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
    const path = join(this.dir, `${id}.json`);
    await writeFile(
      path,
      `${JSON.stringify(
        {
          id,
          createdAt: at.toISOString(),
          reason: request.reason ?? "scheduled",
          material: request.material,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return { id, path };
  }

  /**
   * Oldest first: a backlog should be consolidated in the order it happened.
   * @returns {Promise<{ id: string, createdAt: string, reason: string, material: string }[]>}
   */
  async list() {
    let names;
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const requests = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await readFile(join(this.dir, name), "utf8"));
        if (REQUEST_ID.test(parsed.id ?? "") || name.endsWith(".json")) {
          requests.push({
            id: String(parsed.id ?? name.replace(/\.json$/, "")),
            createdAt: String(parsed.createdAt ?? ""),
            reason: String(parsed.reason ?? "scheduled"),
            material: String(parsed.material ?? ""),
          });
        }
      } catch {
        // A half-written request must not block the queue.
      }
    }
    return requests.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  async peek() {
    const [first] = await this.list();
    return first ?? null;
  }

  /** @param {string} id */
  async remove(id) {
    const safe = id.replace(/[^A-Za-z0-9._-]/g, "");
    if (!safe) return false;
    try {
      await rm(join(this.dir, `${safe}.json`), { force: true });
      return true;
    } catch {
      return false;
    }
  }

  async clear() {
    const requests = await this.list();
    for (const request of requests) await this.remove(request.id);
    return requests.length;
  }

  async size() {
    return (await this.list()).length;
  }
}

/**
 * The durable record of every `kind: conflict` write.
 *
 * A conflict that is only a red cell on the heatmap is invisible — nobody
 * opens the calendar. This log is the "one line in the room" a team needs:
 * who wrote the contradiction, against which path, and what the node used to
 * say. It is append-only JSONL because a conflict log that can be edited is a
 * conflict log that will be tidied away.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ConflictEntry {
  at: string;
  agent: string;
  relPath: string;
  note?: string;
  oldExcerpt?: string;
  newExcerpt?: string;
}

export interface ConflictInput {
  agent: string;
  relPath: string;
  note?: string;
  oldExcerpt?: string;
  newExcerpt?: string;
}

export class ConflictLog {
  root: string;
  file: string;

  constructor(options: { root: string }) {
    this.root = options.root;
    this.file = join(options.root, "metadata", "conflicts.jsonl");
  }

  async record(entry: ConflictInput): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const line: ConflictEntry = { at: new Date().toISOString(), ...entry };
    await appendFile(this.file, `${JSON.stringify(line)}\n`, "utf8");
  }

  /** Newest first, bounded by `limit`. */
  async recent(limit = 20): Promise<ConflictEntry[]> {
    const lines = await this.#lines();
    return lines.slice(-limit).reverse();
  }

  /** Well-formed lines on file; a corrupt line is skipped, never thrown. */
  async total(): Promise<number> {
    return (await this.#lines()).length;
  }

  /**
   * One entry per well-formed line. The log lives next to `metadata/` files a
   * crash can tear, and one bad line must not hide the others — so parsing is
   * permissive by design: a line that is not a JSON object is dropped.
   */
  async #lines(): Promise<ConflictEntry[]> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      return [];
    }
    const out: ConflictEntry[] = [];
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        const record = parsed as Record<string, unknown>;
        out.push({
          at: String(record.at ?? ""),
          agent: String(record.agent ?? ""),
          relPath: String(record.relPath ?? ""),
          ...(typeof record.note === "string" ? { note: record.note } : {}),
          ...(typeof record.oldExcerpt === "string" ? { oldExcerpt: record.oldExcerpt } : {}),
          ...(typeof record.newExcerpt === "string" ? { newExcerpt: record.newExcerpt } : {}),
        });
      } catch {
        // Not JSON: a torn line from a crash. The rest of the log still counts.
      }
    }
    return out;
  }
}

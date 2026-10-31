/**
 * Markdown as memory: frontmatter, heading-aware chunking with real line
 * numbers, and wikilink extraction. Mirrors ReMe's "file is the source of
 * truth, the index is derived" contract without any Python.
 */

export interface Parsed {
  data: Record<string, string>;
  body: string;
  offset: number;
}

function unquote(value: string): string {
  const v = value.trim();
  if (
    (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
    (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
  ) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Split leading YAML frontmatter from the body.
 * `offset` is the number of file lines the frontmatter occupies, so a body
 * line `i` (0-based) is file line `offset + i + 1`.
 */
export function parseFrontmatter(text: string): Parsed {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return { data: {}, body: text, offset: 0 };
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { data: {}, body: text, offset: 0 };
  const data: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (m?.[1] && m[2] !== undefined) data[m[1]] = unquote(m[2]);
  }
  return { data, body: lines.slice(end + 1).join("\n"), offset: end + 1 };
}

export interface Chunk {
  heading: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface ChunkOptions {
  maxChars?: number;
  withFrontmatter?: boolean;
}

interface Section {
  heading: string;
  start: number;
  lines: string[];
}

interface Block {
  start: number;
  lines: string[];
}

interface ChunkAcc {
  heading: string;
  start: number;
  end: number;
  text: string;
}

/**
 * Chunk a Markdown document by heading, then merge small blocks up to
 * `maxChars`. Line ranges are 1-based and point at the original file,
 * frontmatter included.
 */
export function chunkMarkdown(text: string, options: ChunkOptions = {}): Chunk[] {
  const maxChars = options.maxChars ?? 900;
  const withFrontmatter = options.withFrontmatter ?? true;
  const { data, body, offset } = parseFrontmatter(text);
  const lines = body.split("\n");
  const lineOffset = withFrontmatter ? offset : 0;

  const sections: Section[] = [];
  let current: Section = { heading: "", start: 0, lines: [] };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m?.[2]) {
      if (current.lines.some((l) => l.trim())) sections.push(current);
      current = { heading: m[2], start: i, lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.some((l) => l.trim())) sections.push(current);

  const chunks: Chunk[] = [];
  for (const section of sections) {
    // A node whose body starts straight with prose has no heading; fall back to
    // the frontmatter name so evidence still shows a topic.
    const heading = section.heading || data.name || "";
    const blocks: Block[] = [];
    let block: Block | null = null;
    for (let j = 0; j < section.lines.length; j += 1) {
      const line = section.lines[j];
      if (line === undefined) continue;
      if (!line.trim()) {
        if (block) {
          blocks.push(block);
          block = null;
        }
        continue;
      }
      // `start` must be absolute within the body, not within the section,
      // otherwise every chunk after the first heading reports the wrong lines.
      if (!block) block = { start: section.start + j, lines: [] };
      block.lines.push(line);
    }
    if (block) blocks.push(block);

    let acc: ChunkAcc | null = null;
    for (const b of blocks) {
      const blockText = b.lines.join("\n");
      const end = b.start + b.lines.length - 1;
      if (!acc) {
        acc = { heading, start: b.start, end, text: blockText };
        continue;
      }
      const merged = `${acc.text}\n\n${blockText}`;
      if (merged.length <= maxChars) {
        acc.text = merged;
        acc.end = end;
      } else {
        chunks.push(toChunk(acc, lineOffset));
        acc = { heading, start: b.start, end, text: blockText };
      }
    }
    if (acc) chunks.push(toChunk(acc, lineOffset));
  }
  return chunks;
}

function toChunk(acc: ChunkAcc, lineOffset: number): Chunk {
  // A chunk made only of its heading line is still useful: it anchors the
  // topic. Keep the heading text but do not let it dominate scoring.
  return {
    heading: acc.heading,
    startLine: lineOffset + acc.start + 1,
    endLine: lineOffset + acc.end + 1,
    text: acc.text,
  };
}

/**
 * Extract `[[target]]` / `[[target|label]]` / `[[target#section]]` targets.
 */
export function extractWikilinks(text: string): string[] {
  const out = new Set<string>();
  const re = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  let m = re.exec(text);
  while (m?.[1]) {
    out.add(m[1].trim());
    m = re.exec(text);
  }
  return [...out];
}

/**
 * Normalize a link target or file path into a lookup key: lowercase,
 * forward slashes, no leading `./`, no `.md` suffix.
 */
export function linkKey(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\.(md|markdown)$/i, "")
    .toLowerCase();
}

export interface NodeMeta {
  name?: string;
  description?: string;
  updated?: string;
  tags?: string[];
  kind?: string;
}

/**
 * Render a memory node with frontmatter.
 */
export function renderNode(meta: NodeMeta, body: string): string {
  const fields = ["---"];
  if (meta.name) fields.push(`name: ${meta.name}`);
  if (meta.description) fields.push(`description: ${meta.description}`);
  // `updated` dates the node for the heatmap: digest paths carry no date, so
  // without it a node is invisible on the calendar.
  if (meta.updated) fields.push(`updated: ${meta.updated}`);
  if (meta.tags?.length) fields.push(`tags: ${meta.tags.join(", ")}`);
  // `kind` drives the heatmap colour; written only when it is not the default.
  if (meta.kind && meta.kind !== "normal") fields.push(`kind: ${meta.kind}`);
  fields.push("---");
  return `${fields.join("\n")}\n\n${body.replace(/^\n+/, "")}\n`;
}

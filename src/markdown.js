/**
 * Markdown as memory: frontmatter, heading-aware chunking with real line
 * numbers, and wikilink extraction. Mirrors ReMe's "file is the source of
 * truth, the index is derived" contract without any Python.
 */

/** @typedef {{ data: Record<string, string>, body: string, offset: number }} Parsed */

/**
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
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
 * @param {string} text
 * @returns {Parsed}
 */
export function parseFrontmatter(text) {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return { data: {}, body: text, offset: 0 };
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { data: {}, body: text, offset: 0 };
  /** @type {Record<string, string>} */
  const data = {};
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (m) data[m[1]] = unquote(m[2]);
  }
  return { data, body: lines.slice(end + 1).join("\n"), offset: end + 1 };
}

/**
 * @typedef {{ heading: string, startLine: number, endLine: number, text: string }} Chunk
 */

/**
 * Chunk a Markdown document by heading, then merge small blocks up to
 * `maxChars`. Line ranges are 1-based and point at the original file,
 * frontmatter included.
 * @param {string} text
 * @param {{ maxChars?: number, withFrontmatter?: boolean }} [options]
 * @returns {Chunk[]}
 */
export function chunkMarkdown(text, options = {}) {
  const maxChars = options.maxChars ?? 900;
  const withFrontmatter = options.withFrontmatter ?? true;
  const { data, body, offset } = parseFrontmatter(text);
  const lines = body.split("\n");
  const lineOffset = withFrontmatter ? offset : 0;

  /** @type {{ heading: string, start: number, lines: string[] }[]} */
  const sections = [];
  let current = { heading: "", start: 0, lines: [] };
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i]);
    if (m) {
      if (current.lines.some((line) => line.trim())) sections.push(current);
      current = { heading: m[2], start: i, lines: [lines[i]] };
    } else {
      current.lines.push(lines[i]);
    }
  }
  if (current.lines.some((line) => line.trim())) sections.push(current);

  /** @type {Chunk[]} */
  const chunks = [];
  for (const section of sections) {
    // A node whose body starts straight with prose has no heading; fall back to
    // the frontmatter name so evidence still shows a topic.
    const heading = section.heading || data.name || "";
    /** @type {{ start: number, lines: string[] }[]} */
    const blocks = [];
    /** @type {{ start: number, lines: string[] } | null} */
    let block = null;
    for (let j = 0; j < section.lines.length; j += 1) {
      const line = section.lines[j];
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

    /** @type {{ heading: string, start: number, end: number, text: string } | null} */
    let acc = null;
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

/**
 * @param {{ heading: string, start: number, end: number, text: string }} acc
 * @param {number} lineOffset
 * @returns {Chunk}
 */
function toChunk(acc, lineOffset) {
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
 * @param {string} text
 * @returns {string[]}
 */
export function extractWikilinks(text) {
  /** @type {Set<string>} */
  const out = new Set();
  const re = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  let m = re.exec(text);
  while (m) {
    out.add(m[1].trim());
    m = re.exec(text);
  }
  return [...out];
}

/**
 * Normalize a link target or file path into a lookup key: lowercase,
 * forward slashes, no leading `./`, no `.md` suffix.
 * @param {string} value
 * @returns {string}
 */
export function linkKey(value) {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\.(md|markdown)$/i, "")
    .toLowerCase();
}

/**
 * Render a memory node with frontmatter.
 * @param {{ name?: string, description?: string, tags?: string[], kind?: string }} meta
 * @param {string} body
 * @returns {string}
 */
export function renderNode(meta, body) {
  const fields = ["---"];
  if (meta.name) fields.push(`name: ${meta.name}`);
  if (meta.description) fields.push(`description: ${meta.description}`);
  if (meta.tags?.length) fields.push(`tags: ${meta.tags.join(", ")}`);
  // `kind` drives the heatmap colour; written only when it is not the default.
  if (meta.kind && meta.kind !== "normal") fields.push(`kind: ${meta.kind}`);
  fields.push("---");
  return `${fields.join("\n")}\n\n${body.replace(/^\n+/, "")}\n`;
}

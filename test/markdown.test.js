import assert from "node:assert/strict";
import test from "node:test";

import {
  chunkMarkdown,
  extractWikilinks,
  linkKey,
  parseFrontmatter,
  renderNode,
} from "../src/markdown.js";

const DOC = ["---", "name: t", "---", "# A", "", "alpha beta", "", "## B", "", "gamma"].join("\n");

test("frontmatter is split and counted", () => {
  const parsed = parseFrontmatter(DOC);
  assert.equal(parsed.offset, 3);
  assert.equal(parsed.data.name, "t");
  assert.ok(parsed.body.startsWith("# A"));
});

test("chunk line numbers point at real file lines", () => {
  const chunks = chunkMarkdown(DOC);
  assert.equal(chunks.length, 2);

  const [first, second] = chunks;
  assert.equal(first.heading, "A");
  assert.equal(first.startLine, 4);
  assert.equal(first.endLine, 6);
  assert.match(first.text, /alpha beta/);

  // "gamma" is file line 10, but the chunk starts at its heading "## B" on
  // line 8 — file line 1-3 are frontmatter, 4 "# A", 6 "alpha beta", 8 "## B".
  assert.equal(second.heading, "B");
  assert.equal(second.startLine, 8);
  assert.equal(second.endLine, 10);
  assert.match(DOC.split("\n")[second.endLine - 1], /gamma/);
});

test("documents without frontmatter start at line 1", () => {
  const chunks = chunkMarkdown("# Title\n\nbody text");
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks[0].endLine, 3);
});

test("long sections split on block boundaries", () => {
  const text = `# T\n\n${"a".repeat(400)}\n\n${"b".repeat(400)}\n\n${"c".repeat(400)}`;
  const chunks = chunkMarkdown(text, { maxChars: 500 });
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) assert.ok(chunk.text.length <= 900);
});

test("wikilinks are extracted and normalized", () => {
  const links = extractWikilinks("see [[digest/wiki/x|X]] and [[daily/2026-10-25#noon]] and [[y]]");
  assert.deepEqual(links, ["digest/wiki/x", "daily/2026-10-25", "y"]);
  assert.equal(linkKey("./Digest\\Wiki\\X.md"), "digest/wiki/x");
});

test("frontmatter name becomes the heading when the body has none", () => {
  const chunks = chunkMarkdown("---\nname: 记忆方案\n---\n\n正文内容。\n");
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].heading, "记忆方案");
});

test("renderNode emits frontmatter then body", () => {
  const text = renderNode({ name: "n", description: "d", updated: "2026-10-28" }, "# body");
  assert.ok(text.startsWith("---\nname: n\ndescription: d\nupdated: 2026-10-28\n---\n\n# body"));
  assert.ok(text.endsWith("\n"));
  const bare = renderNode({ name: "n" }, "# body");
  assert.ok(!bare.includes("updated:"), "no date is invented when the caller has none");
});

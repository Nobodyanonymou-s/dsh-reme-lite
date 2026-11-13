import { randomUUID } from "node:crypto";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
// src/atomic.ts
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
/** Windows can transiently refuse the rename (indexer, antivirus); back off. */
const RENAME_ATTEMPTS = 4;
async function atomicWriteFile(absolute, content) {
	const directory = dirname(absolute);
	await mkdir(directory, { recursive: true });
	const temporary = join(directory, `.${basenameOf(absolute)}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`);
	try {
		await writeFile(temporary, content, "utf8");
		let lastError = null;
		for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt += 1) try {
			await rename(temporary, absolute);
			return;
		} catch (error) {
			lastError = error;
			await sleep(25 * (attempt + 1));
		}
		throw lastError ?? /* @__PURE__ */ new Error(`atomic rename failed: ${absolute}`);
	} finally {
		await rm(temporary, { force: true }).catch(() => {});
	}
}
function basenameOf(absolute) {
	const parts = absolute.split(/[\\/]/);
	return parts[parts.length - 1] ?? "file";
}
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
* Per-path serialization. The stored chain never rejects: a failed operation
* must not poison the writes queued behind it. The map entry is dropped when
* the chain goes idle, so a long-lived process does not accumulate one entry
* per file ever written.
*/
var PathLocks = class {
	#chains = /* @__PURE__ */ new Map();
	run(absolute, operation) {
		const key = absolute.split(/[\\/]/).join("/");
		const next = (this.#chains.get(key) ?? Promise.resolve()).then(operation, operation);
		const guarded = next.catch(() => {});
		this.#chains.set(key, guarded);
		guarded.then(() => {
			if (this.#chains.get(key) === guarded) this.#chains.delete(key);
		});
		return next;
	}
};
// src/bm25.ts
/**
* BM25 over mixed Chinese/English text with no dependencies.
*
* ReMe's default configuration is BM25 (its `search` job works without an
* embedding model). Python uses jieba to segment Chinese; here CJK runs are
* indexed as character bigrams, which is the standard dependency-free
* substitute and behaves well for short queries.
*/
const K1 = 1.2;
const B = .75;
function tokenize(text) {
	const lower = text.toLowerCase();
	const tokens = [];
	const latin = lower.match(/[a-z0-9_]+/g);
	if (latin) tokens.push(...latin);
	const cjk = lower.match(/[㐀-鿿぀-ヿ]+/g);
	if (cjk) for (const run of cjk) {
		if (run.length === 1) {
			tokens.push(run);
			continue;
		}
		for (let i = 0; i < run.length - 1; i += 1) tokens.push(run.slice(i, i + 2));
	}
	return tokens;
}
var BM25 = class {
	docs = [];
	termFreqs = [];
	lengths = [];
	docFreqs = /* @__PURE__ */ new Map();
	totalLength = 0;
	dirty = true;
	idfCache = /* @__PURE__ */ new Map();
	#live = 0;
	add(doc) {
		const id = this.docs.length;
		const tokens = tokenize(doc.text);
		const tf = /* @__PURE__ */ new Map();
		for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
		this.docs.push({
			...doc,
			id
		});
		this.termFreqs.push(tf);
		this.lengths.push(tokens.length);
		this.totalLength += tokens.length;
		this.#live += 1;
		for (const term of tf.keys()) this.docFreqs.set(term, (this.docFreqs.get(term) ?? 0) + 1);
		this.dirty = true;
		return id;
	}
	/**
	* Tombstone one document. Ids of the survivors stay stable, so stored
	* references (this store's chunk list) survive a per-file reindex.
	*/
	remove(id) {
		if (!this.docs[id]) return false;
		const tf = this.termFreqs[id] ?? /* @__PURE__ */ new Map();
		for (const [term, count] of tf) {
			const df = this.docFreqs.get(term);
			if (df === void 0) continue;
			const next = df - count;
			if (next > 0) this.docFreqs.set(term, next);
			else this.docFreqs.delete(term);
			this.idfCache.delete(term);
		}
		this.totalLength -= this.lengths[id] ?? 0;
		this.#live -= 1;
		this.docs[id] = void 0;
		this.termFreqs[id] = /* @__PURE__ */ new Map();
		this.lengths[id] = 0;
		this.dirty = true;
		return true;
	}
	get size() {
		return this.#live;
	}
	get averageLength() {
		return this.size === 0 ? 0 : this.totalLength / this.size;
	}
	idf(term) {
		const cached = this.idfCache.get(term);
		if (cached !== void 0) return cached;
		const df = this.docFreqs.get(term) ?? 0;
		const idf = Math.log(1 + (this.size - df + .5) / (df + .5));
		this.idfCache.set(term, idf);
		return idf;
	}
	search(query, options = {}) {
		const limit = options.limit ?? 5;
		const minScore = options.minScore ?? 0;
		const terms = tokenize(query);
		if (terms.length === 0 || this.size === 0) return [];
		const avgdl = this.averageLength || 1;
		const scores = new Array(this.docs.length).fill(0);
		const queryTf = /* @__PURE__ */ new Map();
		for (const term of terms) queryTf.set(term, (queryTf.get(term) ?? 0) + 1);
		for (const [term, qtf] of queryTf) {
			if ((this.docFreqs.get(term) ?? 0) === 0) continue;
			const idf = this.idf(term);
			for (let i = 0; i < this.docs.length; i += 1) {
				const tf = this.termFreqs[i]?.get(term);
				if (!tf) continue;
				const norm = tf * 2.2;
				const denom = tf + K1 * (.25 + B * (this.lengths[i] ?? 0) / avgdl);
				scores[i] = (scores[i] ?? 0) + idf * norm * qtf / denom;
			}
		}
		const hits = [];
		for (let i = 0; i < this.docs.length; i += 1) {
			const doc = this.docs[i];
			const score = scores[i] ?? 0;
			if (doc && score > minScore) hits.push({
				doc,
				score
			});
		}
		hits.sort((a, b) => b.score - a.score);
		return hits.slice(0, limit);
	}
};
// src/markdown.ts
function unquote(value) {
	const v = value.trim();
	if (v.startsWith("\"") && v.endsWith("\"") && v.length >= 2 || v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1);
	return v;
}
/**
* Split leading YAML frontmatter from the body.
* `offset` is the number of file lines the frontmatter occupies, so a body
* line `i` (0-based) is file line `offset + i + 1`.
*/
function parseFrontmatter(text) {
	const lines = text.split("\n");
	if (lines[0]?.trim() !== "---") return {
		data: {},
		body: text,
		offset: 0
	};
	let end = -1;
	for (let i = 1; i < lines.length; i += 1) if (lines[i]?.trim() === "---") {
		end = i;
		break;
	}
	if (end === -1) return {
		data: {},
		body: text,
		offset: 0
	};
	const data = {};
	for (const line of lines.slice(1, end)) {
		const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
		if (m?.[1] && m[2] !== void 0) data[m[1]] = unquote(m[2]);
	}
	return {
		data,
		body: lines.slice(end + 1).join("\n"),
		offset: end + 1
	};
}
/**
* Chunk a Markdown document by heading, then merge small blocks up to
* `maxChars`. Line ranges are 1-based and point at the original file,
* frontmatter included.
*/
function chunkMarkdown(text, options = {}) {
	const maxChars = options.maxChars ?? 900;
	const withFrontmatter = options.withFrontmatter ?? true;
	const { data, body, offset } = parseFrontmatter(text);
	const lines = body.split("\n");
	const lineOffset = withFrontmatter ? offset : 0;
	const sections = [];
	let current = {
		heading: "",
		start: 0,
		lines: []
	};
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		if (line === void 0) continue;
		const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
		if (m?.[2]) {
			if (current.lines.some((l) => l.trim())) sections.push(current);
			current = {
				heading: m[2],
				start: i,
				lines: [line]
			};
		} else current.lines.push(line);
	}
	if (current.lines.some((l) => l.trim())) sections.push(current);
	const chunks = [];
	for (const section of sections) {
		const heading = section.heading || data.name || "";
		const blocks = [];
		let block = null;
		for (let j = 0; j < section.lines.length; j += 1) {
			const line = section.lines[j];
			if (line === void 0) continue;
			if (!line.trim()) {
				if (block) {
					blocks.push(block);
					block = null;
				}
				continue;
			}
			if (!block) block = {
				start: section.start + j,
				lines: []
			};
			block.lines.push(line);
		}
		if (block) blocks.push(block);
		let acc = null;
		for (const b of blocks) {
			const blockText = b.lines.join("\n");
			const end = b.start + b.lines.length - 1;
			if (!acc) {
				acc = {
					heading,
					start: b.start,
					end,
					text: blockText
				};
				continue;
			}
			const merged = `${acc.text}\n\n${blockText}`;
			if (merged.length <= maxChars) {
				acc.text = merged;
				acc.end = end;
			} else {
				chunks.push(toChunk(acc, lineOffset));
				acc = {
					heading,
					start: b.start,
					end,
					text: blockText
				};
			}
		}
		if (acc) chunks.push(toChunk(acc, lineOffset));
	}
	return chunks;
}
function toChunk(acc, lineOffset) {
	return {
		heading: acc.heading,
		startLine: lineOffset + acc.start + 1,
		endLine: lineOffset + acc.end + 1,
		text: acc.text
	};
}
/**
* Extract `[[target]]` / `[[target|label]]` / `[[target#section]]` targets.
*/
function extractWikilinks(text) {
	const out = /* @__PURE__ */ new Set();
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
function linkKey(value) {
	return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\.(md|markdown)$/i, "").toLowerCase();
}
/**
* Render a memory node with frontmatter.
*/
function renderNode(meta, body) {
	const fields = ["---"];
	if (meta.name) fields.push(`name: ${meta.name}`);
	if (meta.description) fields.push(`description: ${meta.description}`);
	if (meta.updated) fields.push(`updated: ${meta.updated}`);
	if (meta.tags?.length) fields.push(`tags: ${meta.tags.join(", ")}`);
	if (meta.kind && meta.kind !== "normal") fields.push(`kind: ${meta.kind}`);
	if (meta.agent) fields.push(`agent: ${meta.agent}`);
	if (meta.session) fields.push(`session: ${meta.session}`);
	if (meta.room) fields.push(`room: ${meta.room}`);
	if (meta.visibility === "private") fields.push(`visibility: private`);
	fields.push("---");
	return `${fields.join("\n")}\n\n${body.replace(/^\n+/, "")}\n`;
}
// src/scope.ts
/** Read the scope fields out of parsed frontmatter; unknown values pass through as-is. */
function parseScope(data) {
	const meta = {};
	const agent = (data.agent ?? "").trim();
	const session = (data.session ?? "").trim();
	const room = (data.room ?? "").trim();
	const visibility = (data.visibility ?? "").trim();
	if (agent) meta.agent = agent;
	if (session) meta.session = session;
	if (room) meta.room = room;
	if (visibility) meta.visibility = visibility;
	return meta;
}
function isPrivate(meta) {
	return meta?.visibility === "private";
}
/**
* Whether a node is retrievable by `viewer` under `mode`.
*
* `mine` (the default) is "my material plus the team layer": a private node is
* visible only to its own writer. `team` shows everything — the audit view.
*/
function visibleTo(meta, viewer, mode = "mine") {
	if (mode === "team") return true;
	if (!isPrivate(meta)) return true;
	return Boolean(viewer) && meta?.agent === viewer;
}
/**
* Stamp a write with provenance. `visibility` is only recorded when private,
* so the common (team) case leaves the frontmatter unchanged in shape from
* what a single-agent workspace always wrote.
*/
function stampScope(input) {
	const meta = { agent: input.agent };
	if (input.session) meta.session = input.session;
	if (input.room) meta.room = input.room;
	if (input.private) meta.visibility = "private";
	return meta;
}
// src/store.ts
/**
* Workspace-backed memory store.
*
* Layout (same shape as ReMe's, minus what we do not implement):
*
*   <root>/
*   ├── daily/YYYY-MM-DD.md      # lightly processed notes (auto block + human text)
*   ├── digest/personal|procedure|wiki/*.md   # durable knowledge
*   ├── session/dialog/*.jsonl   # raw source records (never indexed)
*   └── metadata/                # derived; safe to delete
*
* Only `daily/` and `digest/` are indexed, exactly like ReMe: the raw session
* records and the derived index stay out of retrieval.
*/
const INDEXED_DIRS = ["daily", "digest"];
var MemoryStore = class {
	root;
	maxChars;
	files = [];
	chunks = [];
	byKey = /* @__PURE__ */ new Map();
	index = new BM25();
	builtAt = 0;
	#locks;
	/** Serializes every index mutation (full rebuild and per-file reindex alike). */
	#mutations = Promise.resolve();
	lastRebuildMs = null;
	constructor(options) {
		this.root = resolve(options.root);
		this.maxChars = options.maxChars ?? 900;
		this.#locks = options.locks ?? new PathLocks();
	}
	get indexPath() {
		return join(this.root, "metadata", "index.json");
	}
	async ensureLayout() {
		await mkdir(join(this.root, "daily"), { recursive: true });
		await mkdir(join(this.root, "digest"), { recursive: true });
		await mkdir(join(this.root, "session", "dialog"), { recursive: true });
		await mkdir(join(this.root, "metadata"), { recursive: true });
	}
	/**
	* Resolve a user-supplied relative path inside the workspace, refusing
	* escapes.
	*/
	resolveInside(relPath) {
		const cleaned = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
		const absolute = resolve(this.root, cleaned);
		const rel = relative(this.root, absolute);
		if (rel === "" || rel.startsWith("..") || rel.includes(`..${sep}`)) throw new Error(`path escapes memory workspace: ${relPath}`);
		return absolute;
	}
	/**
	* Rebuild the in-memory index from Markdown on disk. Unchanged files are
	* re-chunked only when their mtime moved.
	*/
	rebuild() {
		return this.#serialize(() => this.#rebuildInner());
	}
	async #rebuildInner() {
		const startedAt = Date.now();
		await this.ensureLayout();
		const next = [];
		for (const dir of INDEXED_DIRS) {
			const found = await this.#walk(join(this.root, dir));
			for (const absolute of found) {
				const info = await stat(absolute);
				const relPath = relative(this.root, absolute).split(sep).join(posix.sep);
				const previous = this.files.find((f) => f.relPath === relPath);
				if (previous && previous.mtimeMs === info.mtimeMs) {
					next.push(previous);
					continue;
				}
				next.push(await this.#loadFile(relPath, absolute, info.mtimeMs));
			}
		}
		this.files = next;
		this.chunks = [];
		this.byKey = /* @__PURE__ */ new Map();
		this.index = new BM25();
		for (const file of this.files) {
			this.byKey.set(linkKey(file.relPath), file.relPath);
			this.byKey.set(linkKey(posix.basename(file.relPath)), file.relPath);
			for (const chunk of file.chunks) {
				const id = this.index.add({
					text: `${chunk.heading}\n${chunk.text}`,
					meta: {
						relPath: file.relPath,
						chunk
					}
				});
				this.chunks.push({
					id,
					relPath: file.relPath,
					chunk
				});
			}
		}
		this.builtAt = Date.now();
		this.lastRebuildMs = Date.now() - startedAt;
		await this.#writeManifest();
		return {
			files: this.files.length,
			chunks: this.chunks.length
		};
	}
	async #loadFile(relPath, absolute, mtimeMs) {
		const text = await readFile(absolute, "utf8");
		const { data } = parseFrontmatter(text);
		return {
			relPath,
			mtimeMs,
			chunks: chunkMarkdown(text, { maxChars: this.maxChars }),
			meta: parseScope(data),
			front: data
		};
	}
	/**
	* Bring one file's index entries in line with disk: re-chunk only that file,
	* tombstone its old BM25 documents, add the new ones. This is what a write
	* needs — a full-directory walk per saved node does not scale to a shared
	* team workspace, and it widens the window where two writers interleave.
	*
	* `force` is set by our own writes: two writes inside one filesystem mtime
	* tick report identical mtimes, and the skip-if-unchanged check would then
	* leave the index holding the replaced text.
	*/
	async #reindexPath(relPath, force = false) {
		const absolute = resolve(this.root, relPath);
		const info = await stat(absolute).catch(() => null);
		const previous = this.files.find((f) => f.relPath === relPath);
		if (!force && previous && info && previous.mtimeMs === info.mtimeMs) return;
		if (previous) {
			this.byKey.delete(linkKey(previous.relPath));
			this.byKey.delete(linkKey(posix.basename(previous.relPath)));
			this.chunks = this.chunks.filter((entry) => entry.relPath !== relPath);
			for (let id = 0; id < this.index.docs.length; id += 1) {
				const doc = this.index.docs[id];
				if (doc && doc.meta.relPath === relPath) this.index.remove(id);
			}
			this.files = this.files.filter((f) => f.relPath !== relPath);
		}
		if (!info) return;
		const loaded = await this.#loadFile(relPath, absolute, info.mtimeMs);
		this.files.push(loaded);
		this.byKey.set(linkKey(loaded.relPath), loaded.relPath);
		this.byKey.set(linkKey(posix.basename(loaded.relPath)), loaded.relPath);
		for (const chunk of loaded.chunks) {
			const id = this.index.add({
				text: `${chunk.heading}\n${chunk.text}`,
				meta: {
					relPath: loaded.relPath,
					chunk
				}
			});
			this.chunks.push({
				id,
				relPath: loaded.relPath,
				chunk
			});
		}
		this.builtAt = Date.now();
		await this.#writeManifest();
	}
	/** All index mutations run one at a time; reads stay unsynchronized. */
	#serialize(operation) {
		const next = this.#mutations.then(operation, operation);
		this.#mutations = next.catch(() => {});
		return next;
	}
	async #walk(dir) {
		const out = [];
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return out;
		}
		for (const entry of entries) {
			const absolute = join(dir, entry.name);
			if (entry.isDirectory()) out.push(...await this.#walk(absolute));
			else if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) out.push(absolute);
		}
		return out;
	}
	async #writeManifest() {
		const manifest = {
			builtAt: this.builtAt,
			files: this.files.map((f) => ({
				path: f.relPath,
				chunks: f.chunks.length
			}))
		};
		try {
			await writeFile(this.indexPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
		} catch {}
	}
	search(query, options = {}) {
		const limit = Math.min(Math.max(options.limit ?? 5, 1), 50);
		const minScore = Math.max(0, options.minScore ?? 0);
		const expandLinks = options.expandLinks ?? true;
		const viewer = options.scope?.viewer ?? "";
		const mode = options.scope?.mode ?? "mine";
		const retrievable = (relPath) => {
			const file = this.files.find((f) => f.relPath === relPath);
			if (!file) return false;
			if (!visibleTo(file.meta, viewer, mode)) return false;
			if (options.room !== void 0 && file.meta.room !== void 0 && file.meta.room !== options.room) return false;
			return true;
		};
		const results = this.index.search(query, {
			limit: Math.max(limit * 3, 12),
			minScore
		}).map((hit) => {
			const meta = hit.doc.meta;
			return {
				relPath: meta.relPath,
				startLine: meta.chunk.startLine,
				endLine: meta.chunk.endLine,
				heading: meta.chunk.heading,
				text: meta.chunk.text,
				score: hit.score
			};
		}).filter((hit) => retrievable(hit.relPath));
		if (expandLinks) results.push(...this.#expandLinks(results, retrievable));
		const deduped = /* @__PURE__ */ new Map();
		for (const hit of results) {
			const key = `${hit.relPath}:${hit.startLine}`;
			const existing = deduped.get(key);
			if (!existing || existing.score < hit.score) deduped.set(key, hit);
		}
		return [...deduped.values()].filter((hit) => hit.score > minScore).sort((a, b) => b.score - a.score).slice(0, limit);
	}
	/**
	* One-hop wikilink neighbours of the direct hits, at a discount. This is
	* ReMe's "bounded link expansion": it lets a query reach a note you never
	* mentioned, without dragging in the whole graph. Neighbours the caller
	* cannot see under the active scope are not expanded — a link must not leak
	* what the filter just hid.
	*/
	#expandLinks(hits, retrievable) {
		const extra = [];
		const seen = new Set(hits.map((hit) => hit.relPath));
		for (const hit of hits.slice(0, 3)) for (const target of extractWikilinks(hit.text)) {
			const resolved = this.byKey.get(linkKey(target));
			if (!resolved || seen.has(resolved)) continue;
			if (!retrievable(resolved)) continue;
			seen.add(resolved);
			const file = this.files.find((f) => f.relPath === resolved);
			if (!file) continue;
			for (const chunk of file.chunks.slice(0, 2)) extra.push({
				relPath: resolved,
				startLine: chunk.startLine,
				endLine: chunk.endLine,
				heading: chunk.heading,
				text: chunk.text,
				score: hit.score * .4,
				via: hit.relPath
			});
		}
		return extra;
	}
	/**
	* Write a memory node: serialized per path, renamed into place atomically,
	* then reindexed incrementally — only this file's entries move.
	*/
	async write(input) {
		const relPath = input.relPath.replace(/\\/g, "/").replace(/^\/+/, "");
		if (!/\.(md|markdown)$/i.test(relPath)) throw new Error(`memory nodes must be .md: ${relPath}`);
		const absolute = this.resolveInside(relPath);
		return this.#locks.run(absolute, async () => {
			await mkdir(dirname(absolute), { recursive: true });
			await atomicWriteFile(absolute, input.content);
			await this.#serialize(() => this.#reindexPath(relPath, true));
			return {
				relPath,
				bytes: Buffer.byteLength(input.content, "utf8")
			};
		});
	}
	async read(relPath) {
		return readFile(this.resolveInside(relPath), "utf8");
	}
	async recentDaily(limit = 7) {
		return this.files.filter((file) => file.relPath.startsWith("daily/")).sort((a, b) => a.relPath < b.relPath ? 1 : -1).slice(0, limit).map((file) => file.relPath);
	}
	digestTitles() {
		return this.files.filter((file) => file.relPath.startsWith("digest/")).map((file) => file.relPath);
	}
	stats() {
		const byDir = {};
		for (const file of this.files) {
			const dir = file.relPath.split("/")[0] ?? "";
			byDir[dir] = (byDir[dir] ?? 0) + file.chunks.length;
		}
		return {
			root: this.root,
			files: this.files.length,
			chunks: this.index.size,
			byDir,
			builtAt: new Date(this.builtAt).toISOString(),
			lastRebuildMs: this.lastRebuildMs
		};
	}
};
export { linkKey as a, tokenize as c, extractWikilinks as i, PathLocks as l, MemoryStore as n, parseFrontmatter as o, stampScope as r, renderNode as s, INDEXED_DIRS as t, atomicWriteFile as u };

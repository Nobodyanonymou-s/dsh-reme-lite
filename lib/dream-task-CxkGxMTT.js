import { a as linkKey, c as tokenize, i as extractWikilinks, l as PathLocks, u as atomicWriteFile } from "./store-DN5GjwT-.js";
import { createHash } from "node:crypto";
import { dirname, join, posix } from "node:path";
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
// src/capture.ts
/**
* Turn capture: the durable half of memory that needs no model.
*
* Every turn is appended to `session/dialog/<session>.jsonl` first (so nothing
* is lost on a crash), and the day's index page gets an excerpt list inside a
* single auto-managed block. The two sinks diverge on purpose: the journal is
* the complete transcript, the page only what is worth re-reading. Human text
* outside that block is never rewritten — the same boundary QwenPaw uses for
* `notes:auto`.
*/
const AUTO_START = "<!-- notes:auto -->";
const AUTO_END = "<!-- /notes:auto -->";
function shortHash(value) {
	return createHash("sha1").update(value).digest("hex").slice(0, 12);
}
function dialogFileName(sessionId) {
	return `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "session"}-${shortHash(sessionId)}.jsonl`;
}
function dateKey(date) {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function excerpt(text, max = 140) {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
var Capture = class {
	root;
	interval;
	buffers = /* @__PURE__ */ new Map();
	lastHash = /* @__PURE__ */ new Map();
	droppedDuplicates = 0;
	capturedTurns = 0;
	#locks;
	constructor(options) {
		this.root = options.root;
		this.interval = Math.max(1, options.interval ?? 5);
		this.#locks = options.locks ?? new PathLocks();
	}
	get pending() {
		let total = 0;
		for (const turns of this.buffers.values()) total += turns.length;
		return total;
	}
	/**
	* Append one turn to the raw transcript. The transcript is the ground truth
	* later passes reconcile against, so it takes everything a caller offers —
	* including the mid-turn narration the daily page drops. Returns true when a
	* line was written; a repeat of the session's previous turn writes nothing.
	*/
	async journal(sessionId, turn) {
		const text = turn.text.trim();
		if (!text) return false;
		const hash = shortHash(`${turn.role}:${text}`);
		if (this.lastHash.get(sessionId) === hash) {
			this.droppedDuplicates += 1;
			return false;
		}
		this.lastHash.set(sessionId, hash);
		const file = join(this.root, "session", "dialog", dialogFileName(sessionId));
		await mkdir(join(this.root, "session", "dialog"), { recursive: true });
		const source = turn.sourceKind ? { source: { kind: turn.sourceKind } } : {};
		await appendFile(file, `${JSON.stringify({
			session_id: sessionId,
			role: turn.role,
			at: turn.at,
			text,
			...source
		})}\n`, "utf8");
		return true;
	}
	/**
	* Stage one turn for the daily page. Callers decide what deserves the page;
	* `TurnCapture` sends only the user's words and each turn's final reply here.
	*/
	async project(sessionId, turn) {
		const text = turn.text.trim();
		if (!text) return false;
		this.capturedTurns += 1;
		const buffer = this.buffers.get(sessionId) ?? [];
		buffer.push({
			...turn,
			text
		});
		this.buffers.set(sessionId, buffer);
		if (buffer.length >= this.interval) await this.flush(sessionId);
		return true;
	}
	/**
	* Record one completed turn: journal it raw, then project it. Returns true
	* when a durable write happened.
	*/
	async record(sessionId, turn) {
		if (!await this.journal(sessionId, turn)) return false;
		await this.project(sessionId, turn);
		return true;
	}
	/**
	* Fold the buffer into today's daily page. The read-modify-write runs under
	* the shared per-path lock and lands with an atomic rename, so two sessions
	* flushing the same day keep both their turns — the merge below settles the
	* content, the lock settles the timing.
	*/
	async flush(sessionId) {
		const turns = this.buffers.get(sessionId);
		if (!turns || turns.length === 0) return null;
		this.buffers.set(sessionId, []);
		const byDate = /* @__PURE__ */ new Map();
		for (const turn of turns) {
			const key = dateKey(new Date(turn.at));
			byDate.set(key, [...byDate.get(key) ?? [], turn]);
		}
		const written = [];
		for (const [key, dayTurns] of byDate) {
			const relPath = `daily/${key}.md`;
			const absolute = join(this.root, "daily", `${key}.md`);
			const block = buildAutoBlock(dayTurns, sessionId);
			await this.#locks.run(absolute, async () => {
				const existing = await readFile(absolute, "utf8").catch(() => null);
				const next = existing === null ? `---\nname: ${key}\ndescription: auto-captured conversation notes\n---\n\n${AUTO_START}\n${block}\n${AUTO_END}\n` : upsertAutoBlock(existing, block);
				await mkdir(join(this.root, "daily"), { recursive: true });
				await atomicWriteFile(absolute, next);
			});
			written.push(relPath);
		}
		return written;
	}
	/** Drain every session buffer. */
	async flushAll() {
		const written = [];
		for (const sessionId of [...this.buffers.keys()]) {
			const result = await this.flush(sessionId);
			if (result) written.push(...result);
		}
		return written;
	}
	stats() {
		return {
			sessions: this.buffers.size,
			pending: this.pending,
			capturedTurns: this.capturedTurns,
			droppedDuplicates: this.droppedDuplicates
		};
	}
};
function buildAutoBlock(turns, sessionId) {
	const lines = turns.map((turn) => {
		return `- ${new Date(turn.at).toISOString().slice(11, 16)} **${turn.role === "user" ? "user" : "assistant"}**: ${excerpt(turn.text)}`;
	});
	const short = sessionId.replace(/^session-/, "").slice(0, 8);
	lines.push("", `_session: ${short}_`);
	return lines.join("\n");
}
/**
* Merge the incoming auto block into the page's existing one.
*
* Every session writes the page for the day it was active in, so replacing the
* block wholesale loses the other sessions' turns: on a day with more than one
* session the later flush silently erased the earlier notes. Merge instead —
* keep chronological order, drop exact repeats, and list every contributing
* session in the trailer.
*/
function upsertAutoBlock(existing, block) {
	const start = existing.indexOf(AUTO_START);
	const end = existing.indexOf(AUTO_END);
	if (start === -1 || end === -1 || end < start) return `${existing.replace(/\n+$/, "")}\n\n${AUTO_START}\n${block}\n${AUTO_END}\n`;
	const before = existing.slice(0, start + 19);
	const after = existing.slice(end);
	const current = parseBlock(existing.slice(start, end));
	const incoming = parseBlock(block);
	return `${before}\n${formatBlock(mergeTurnLines(current.turns, incoming.turns), [...current.sessions, ...incoming.sessions])}\n${after}`;
}
function turnTime(line) {
	return /^- (\d{2}:\d{2}) /.exec(line)?.[1] ?? null;
}
/**
* Merge turn lines: keep chronological order and drop exact repeats (a crash
* between the journal write and the page write replays the same turn).
*/
function mergeTurnLines(existing, incoming) {
	const merged = [...existing];
	for (const line of incoming) {
		if (merged.includes(line)) continue;
		const time = turnTime(line);
		let at = merged.length;
		if (time !== null) {
			const later = merged.findIndex((other) => {
				const otherTime = turnTime(other);
				return otherTime !== null && otherTime > time;
			});
			if (later !== -1) at = later;
		}
		merged.splice(at, 0, line);
	}
	return merged;
}
/**
* Split one auto block into its turn lines and contributing sessions.
* Older pages carry a single `_session: <id>_` trailer; merged pages carry a
* comma-separated list under the same label.
*/
function parseBlock(text) {
	const body = text.replace(AUTO_START, "").replace(AUTO_END, "");
	const turns = [];
	const sessions = [];
	for (const raw of body.split("\n")) {
		const line = raw.trimEnd();
		if (!line) continue;
		const trailer = /^_session:\s*(.*)_$/.exec(line);
		if (trailer?.[1]) {
			for (const part of trailer[1].split(",")) {
				const id = part.trim();
				if (id) sessions.push(id);
			}
			continue;
		}
		turns.push(line);
	}
	return {
		turns,
		sessions
	};
}
function formatBlock(turns, sessions) {
	const unique = [...new Set(sessions.filter(Boolean))];
	if (unique.length === 0) return turns.join("\n");
	return [
		...turns,
		"",
		`_session: ${unique.join(", ")}_`
	].join("\n");
}
// src/links.ts
/**
* The representation layer around the store: a persistent link graph, the
* generated digest index page, and near-duplicate detection.
*
* Everything here is derived — rebuildable from the nodes alone in a few
* milliseconds, never authoritative. The graph lands in `metadata/` (outside
* retrieval), and the index page is a page of pointers under a hard size cap:
* a wiki that grows past the corpus it summarizes stops being an abstraction,
* so gists are clipped before the page can become a second copy of the notes.
* Nothing in this module rewrites a body node; dangling links and duplicate
* pairs are reported for whoever consolidates next.
*/
/** The generated pointer page. Excluded from the graph and from the page itself. */
const INDEX_PAGE_PATH = "digest/index.md";
/**
* Wikilink namespaces this plugin family uses as internal markers, not
* knowledge links. `[[node-memory:dream]]` is the dream reminder that lands in
* daily pages, `[[recol:dream]]` a sibling plugin's; both resolve to nothing
* and would pollute the dangling list forever. Add future marker prefixes
* here instead of scattering them through the graph logic.
*/
const INTERNAL_LINK_NAMESPACES = ["node-memory", "recol"];
/** True for targets like `[[node-memory:dream]]`: plugin plumbing, not a note. */
function isInternalMarker(target) {
	return new RegExp(`^(${INTERNAL_LINK_NAMESPACES.join("|")}):`).test(target);
}
/** Body nodes of the digest layer, the derived index page excluded. */
function digestNodes(store) {
	return store.files.filter((file) => file.relPath.startsWith("digest/") && file.relPath !== "digest/index.md");
}
/**
* Every wikilink of every node, resolved once against the index. Chunks never
* split a line, so a link inside a chunk is a link in the file. `in` is the
* reverse of the resolvable `out` edges; an unresolvable target becomes a
* dangling entry instead of an edge to nowhere.
*/
function buildLinkGraph(store) {
	const nodes = {};
	const dangling = [];
	const sources = store.files.filter((file) => file.relPath !== INDEX_PAGE_PATH);
	for (const file of sources) nodes[file.relPath] = {
		out: [],
		in: []
	};
	for (const file of sources) {
		const targets = /* @__PURE__ */ new Set();
		for (const chunk of file.chunks) for (const target of extractWikilinks(chunk.text)) {
			if (isInternalMarker(target)) continue;
			targets.add(target);
		}
		nodes[file.relPath].out = [...targets];
		for (const target of targets) {
			const resolved = store.byKey.get(linkKey(target));
			if (resolved) nodes[resolved]?.in.push(file.relPath);
			else dangling.push({
				from: file.relPath,
				target
			});
		}
	}
	return {
		builtAt: (/* @__PURE__ */ new Date()).toISOString(),
		nodes,
		dangling
	};
}
/**
* Where a broken link could point instead: first a node whose frontmatter
* name matches the target exactly (file names and titles drift apart), then
* BM25 over the target text. The page holding the broken link is never its own
* candidate — "point it at itself" is no advice. Candidates are hints for
* whoever fixes the link; the store never rewrites a node on its own.
*/
function candidatePaths(target, store, exclude) {
	if (isInternalMarker(target)) return [];
	const nameToPath = /* @__PURE__ */ new Map();
	for (const file of store.files) {
		if (file.relPath === "digest/index.md" || file.relPath === exclude) continue;
		const name = linkKey(file.front.name ?? "");
		if (name && !nameToPath.has(name)) nameToPath.set(name, file.relPath);
	}
	const exact = nameToPath.get(linkKey(target));
	if (exact) return [exact];
	const paths = [];
	for (const hit of store.search(target, {
		limit: 3,
		expandLinks: false
	})) if (hit.relPath !== exclude && !paths.includes(hit.relPath)) paths.push(hit.relPath);
	return paths;
}
/**
* One line about a node: its description, else its frontmatter name, else the
* file name. Whitespace collapses — the index page is one pointer per line.
* Shared with the session brief, so both name a node the same way.
*/
function gistOf(file) {
	return (file.front.description || file.front.name || posix.basename(file.relPath).replace(/\.(md|markdown)$/i, "")).replace(/\s+/g, " ").trim();
}
/** Fixed reading order for the digest domains; anything else trails alphabetically. */
const INDEX_SECTIONS = [
	"personal",
	"procedure",
	"wiki",
	"self"
];
function byName(a, b) {
	return a < b ? -1 : a > b ? 1 : 0;
}
/**
* The generated pointer page over digest nodes. Every entry is one line — a
* wikilink and a clipped gist — grouped by domain and newest first. The hard
* part of the anti-bloat contract: the whole page is capped at
* 2 × nodes × INDEX_CHARS_PER_NODE characters, gist clipping absorbs whatever
* the fixed header leaves of the budget.
*/
function renderIndexPage(store, options = {}) {
	const nodes = digestNodes(store);
	const head = [
		"---",
		"name: 索引 / Index",
		"description: digest 节点的生成指针页（generated pointer page over digest nodes）",
		`updated: ${dateKey(options.now ?? /* @__PURE__ */ new Date())}`,
		"---",
		"",
		"本页是生成的指针页，正文节点不要复制这里的内容。",
		"",
		""
	].join("\n");
	if (!nodes.length) return `${head}- (none)\n`;
	const rows = nodes.map((file) => ({
		relPath: file.relPath,
		section: file.relPath.split("/")[1] ?? "misc",
		updated: file.front.updated ?? "",
		gist: gistOf(file)
	})).sort((a, b) => a.updated === b.updated ? byName(a.relPath, b.relPath) : b.updated.localeCompare(a.updated));
	const sections = [...INDEX_SECTIONS.filter((name) => rows.some((row) => row.section === name)), ...[...new Set(rows.map((row) => row.section))].filter((name) => !INDEX_SECTIONS.includes(name)).sort(byName)];
	const overhead = head.length + sections.reduce((sum, name) => sum + name.length + 5, 0);
	const widest = Math.max(...rows.map((row) => `- [[${key(row.relPath)}]] — `.length));
	const allowance = Math.max(widest + 1, Math.floor((240 * nodes.length - overhead) / nodes.length));
	return `${head}${sections.map((section) => {
		const lines = rows.filter((row) => row.section === section).map((row) => {
			const pointer = `- [[${key(row.relPath)}]] — `;
			const budget = Math.min(100, allowance - pointer.length);
			return `${pointer}${clip(row.gist, budget)}`;
		});
		return [`## ${section}`, ...lines].join("\n");
	}).join("\n\n")}\n`;
}
/** Wikilink spelling of a path: no extension, so it resolves like a written link. */
function key(relPath) {
	return relPath.replace(/\.(md|markdown)$/i, "");
}
function clip(text, max) {
	if (max <= 0) return "";
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
/**
* Pairs of digest nodes whose token bags nearly coincide (Jaccard over the
* BM25 tokenizer, so Chinese compares by character bigrams). Report only:
* merging is the consolidator's call, made with supersedes in memory_write.
*/
function nearDuplicates(store, options = {}) {
	const threshold = options.threshold ?? .8;
	const nodes = digestNodes(store);
	const bags = /* @__PURE__ */ new Map();
	for (const node of nodes) bags.set(node.relPath, new Set(tokenize(node.chunks.map((chunk) => chunk.text).join("\n"))));
	const pairs = [];
	for (let i = 0; i < nodes.length; i += 1) for (let j = i + 1; j < nodes.length; j += 1) {
		const a = nodes[i].relPath;
		const b = nodes[j].relPath;
		const similarity = jaccard(bags.get(a), bags.get(b));
		if (similarity >= threshold) pairs.push({
			a,
			b,
			similarity
		});
	}
	return pairs.sort((x, y) => y.similarity - x.similarity);
}
function jaccard(a, b) {
	if (!a.size || !b.size) return 0;
	let shared = 0;
	for (const token of a) if (b.has(token)) shared += 1;
	return shared / (a.size + b.size - shared);
}
/**
* Regenerate the derived representation: the index page when there is anything
* to point at (written through the store, so it stays indexed and searchable),
* and the link graph as `metadata/links.json` in manifest style — diagnostic,
* deletable, never a reason for a dream to fail.
*/
async function writeRepresentation(store) {
	const graph = buildLinkGraph(store);
	const wrote = [];
	if (digestNodes(store).length >= 1) {
		await store.write({
			relPath: INDEX_PAGE_PATH,
			content: renderIndexPage(store)
		});
		wrote.push(INDEX_PAGE_PATH);
	}
	const directory = join(store.root, "metadata");
	await mkdir(directory, { recursive: true });
	try {
		await writeFile(join(directory, "links.json"), `${JSON.stringify(graph, null, 2)}\n`, "utf8");
		wrote.push("metadata/links.json");
	} catch {}
	return { wrote };
}
// src/turns.ts
/** Writer identity this plugin stamps on its own injections. */
const SOURCE = "node-memory";
/** Narrow an unknown value to a record without asserting anything about its shape. */
function textOfRecord(value) {
	return value && typeof value === "object" ? value : null;
}
function textOf(data) {
	if (typeof data?.text === "string") return data.text;
	const content = data?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.filter((part) => part && (part.type === "text" || typeof part.text === "string")).map((part) => String(part.text ?? "")).join("").trim();
	return "";
}
/**
* The source kind a message declares for itself, or null when it declares
* none. The Host stamps a real prompt `{ kind: "user" }`; harness-injected
* context — time samples, runtime snapshots, schedule reminders, skill and
* AGENTS.md instructions — each carries its own kind. No declaration means an
* older host that never stamped anything, which callers treat as human rather
* than risk dropping a real question (too much beats too little).
*/
function sourceKindOf(message) {
	const kind = textOfRecord(textOfRecord(message)?.source)?.kind;
	return typeof kind === "string" ? kind : null;
}
/**
* Extract a capturable turn from a session event, tolerating payload shapes.
*/
function turnFromEvent(event) {
	const record = textOfRecord(event);
	const type = typeof record?.type === "string" ? record.type : "";
	const role = type.startsWith("user/") ? "user" : type.startsWith("assistant/") ? "assistant" : null;
	if (!role) return null;
	const data = textOfRecord(record?.data) ?? {};
	const message = role === "assistant" ? textOfRecord(data.message) ?? data : data;
	const messageSource = textOfRecord(message.source);
	if (messageSource?.kind === "node-memory") return null;
	if (messageSource?.plugin === "node-memory") return null;
	const text = textOf(message);
	if (!text) return null;
	const eventTime = record?.time;
	const messageTime = message.time;
	return {
		role,
		text,
		at: typeof eventTime === "string" ? eventTime : typeof messageTime === "string" ? messageTime : (/* @__PURE__ */ new Date()).toISOString(),
		sourceKind: sourceKindOf(message)
	};
}
var TurnCapture = class {
	#capture;
	/** One staged reply per session: the latest assistant step of the open turn. */
	#staged = /* @__PURE__ */ new Map();
	/** Per-session event queue: staging and settling must see events in order. */
	#queues = /* @__PURE__ */ new Map();
	constructor(capture) {
		this.#capture = capture;
	}
	/**
	* Feed one session event through the capture path. Assistant steps are only
	* staged — each one still lands in the transcript immediately — and the daily
	* page is written when the turn closes, by `turn/end` or, on hosts that never
	* send it, by the next user message.
	*
	* Events arrive one at a time but their handling is async, so they queue per
	* session: a `turn/end` that overtook the step it closes would find nothing
	* staged and the turn's reply would be lost. The rejection goes to the caller;
	* the queue itself keeps flowing so one bad event cannot wedge the session.
	*/
	ingest(sessionId, event) {
		const run = (this.#queues.get(sessionId) ?? Promise.resolve()).then(() => this.#consume(sessionId, event));
		this.#queues.set(sessionId, run.catch(() => {}));
		return run;
	}
	async #consume(sessionId, event) {
		const record = textOfRecord(event);
		const type = typeof record?.type === "string" ? record.type : "";
		const data = textOfRecord(record?.data) ?? {};
		if (type === "turn/end") {
			const ended = typeof data.turn === "number" ? data.turn : null;
			await this.#settle(sessionId, (staged) => ended === null || staged.number === null || staged.number <= ended);
			return;
		}
		const turn = turnFromEvent(event);
		if (!turn) return;
		if (turn.role === "user") {
			const kind = turn.sourceKind ?? null;
			const human = kind === null || kind === "user";
			if (human) await this.#settle(sessionId, () => true);
			await this.#capture.journal(sessionId, turn);
			if (human) await this.#capture.project(sessionId, turn);
			return;
		}
		if (data.interrupted === true) {
			await this.#capture.journal(sessionId, turn);
			this.#staged.delete(sessionId);
			return;
		}
		await this.#capture.journal(sessionId, turn);
		const number = typeof data.turn === "number" ? data.turn : null;
		const staged = this.#staged.get(sessionId);
		if (staged && staged.number !== null && number !== null && number > staged.number) await this.#settle(sessionId, () => true);
		this.#staged.set(sessionId, {
			turn,
			number
		});
	}
	/**
	* Settle every staged reply, then drain the projection. Shutdown order
	* matters twice over: the queue first, or a step still being journaled has
	* not staged its reply yet; the settle pass next, or the turn in flight
	* loses its answer.
	*/
	async flushAll() {
		await Promise.all([...this.#queues.values()]);
		for (const sessionId of [...this.#staged.keys()]) await this.#settle(sessionId, () => true);
		return this.#capture.flushAll();
	}
	/** Project the staged reply into the daily page when it belongs there. */
	async #settle(sessionId, belongs) {
		const staged = this.#staged.get(sessionId);
		if (!staged || !belongs(staged)) return;
		this.#staged.delete(sessionId);
		await this.#capture.project(sessionId, staged.turn);
	}
};
// src/dream.ts
/**
* Consolidation ("dream") material.
*
* ReMe's `auto_dream` hands a model a batch of daily notes and asks it to
* create / refine / correct digest nodes. We cannot assume a model is
* reachable from inside a plugin, so the material is built here and given to
* whoever will do the writing: an agent we spawned, the current session's
* agent, or the user via the `memory_dream` tool. One builder, three callers.
*
* The writer usually cannot read the transcript itself: its fs tools stop at
* the session workspace, which the memory root sits outside of. Pointing at
* `session/dialog/*.jsonl` would be a rule nobody can follow, so a bounded
* recent slice travels inside the material for reconciliation.
*/
async function buildDreamMaterial(input) {
	const days = input.days ?? 7;
	const recent = await input.store.recentDaily(days);
	const digest = digestNodes(input.store).map((file) => file.relPath);
	const pending = input.pendingTurns ?? 0;
	const transcripts = await transcriptSection(input.store.root, {
		days: input.transcriptDays,
		budget: input.transcriptBudget
	});
	const graph = buildLinkGraph(input.store);
	const duplicates = nearDuplicates(input.store);
	return [
		"# Consolidation material",
		"",
		`Workspace: ${input.store.root}`,
		`Indexed: ${input.store.files.length} files / ${input.store.index.size} chunks`,
		`Unflushed turns in memory: ${pending}`,
		"",
		"## Recent daily pages",
		recent.length ? recent.map((path) => `- ${path}`).join("\n") : "- (none)",
		"",
		"## Existing digest nodes",
		digest.length ? digest.map((path) => `- ${path}`).join("\n") : "- (none)",
		"",
		danglingSection(input.store, graph),
		"",
		duplicateSection(duplicates),
		"",
		transcripts,
		"",
		"## Rules",
		DREAM_RULES,
		"",
		kindRules(input.language)
	].join("\n");
}
/** Dangling entries that fit in the material; a large backlog is a listing job, not a reading one. */
const MAX_DANGLING_LINKS = 20;
/** Duplicate pairs shown; more than that means the digest needs a pass of its own. */
const MAX_DUPLICATE_PAIRS = 5;
/**
* Broken links with a hint each: a node whose frontmatter name matches the
* target, else BM25 over the target text. The store never rewrites the link —
* the reader points it at the real node, drops it, or creates the missing one.
*/
function danglingSection(store, graph) {
	const lines = ["## Dangling wikilinks"];
	if (!graph.dangling.length) return [...lines, "- (none)"].join("\n");
	for (const link of graph.dangling.slice(0, MAX_DANGLING_LINKS)) {
		const candidates = candidatePaths(link.target, store, link.from);
		const hint = candidates.length ? ` — candidates: ${candidates.join(", ")}` : " — (no candidates)";
		lines.push(`- ${link.from} → [[${link.target}]]${hint}`);
	}
	return lines.join("\n");
}
/** Near-identical digest nodes as a pair list; merging stays a human-reviewed edit. */
function duplicateSection(pairs) {
	const lines = ["## Possible duplicates"];
	if (!pairs.length) return [...lines, "- (none)"].join("\n");
	for (const pair of pairs.slice(0, MAX_DUPLICATE_PAIRS)) lines.push(`- ${pair.a} ↔ ${pair.b} (${pair.similarity.toFixed(2)})`);
	return lines.join("\n");
}
const DREAM_RULES = [
	"1. Read only the recent daily pages you need; do not load the whole workspace.",
	"2. Extract what will still matter next month: preferences, decisions,",
	"   procedures, entities. Drop one-off chatter.",
	"3. Create or merge digest nodes with memory_write: digest/personal,",
	"   digest/procedure, digest/wiki. One topic per node.",
	"4. Every digest node cites its sources with [[daily/YYYY-MM-DD]] links.",
	"5. Reconcile against the recent transcripts before merging, but only",
	"   re-check conclusions that could have changed: dates, names, ports,",
	"   preferences, plans in flight, status. When a note no longer matches,",
	"   correct that node in place and add one line saying what changed and why",
	"   (the old value stays readable in that line) instead of adding a second",
	"   one; when you cannot verify, say \"unverified\" — never present an",
	"   unverified note as confirmed.",
	"6. Fix the representation layer before adding content: point dangling",
	"   wikilinks at the real node (or drop the link — never the node); merge",
	"   near-duplicate nodes into the newer one instead of keeping both, and",
	"   rewrite the old node's body down to a one-line pointer at the new",
	"   one; digest/index.md is generated — never copy its lines into body pages.",
	"7. If a new fact contradicts an existing digest node, correct that node",
	"   instead of adding a second, conflicting one.",
	"8. Prefer few good nodes over many thin ones. Deleting nothing is fine:",
	"   adding one correct node beats rewriting five.",
	"9. digest nodes are the team layer — every agent reads them. Anything you",
	"   are still unsure about stays in daily/ (private to its writer), not in",
	"   digest: a settled team layer is worth more than a fast one."
].join("\n");
const DIALOG_DIR = join("session", "dialog");
const TRANSCRIPT_DAYS = 3;
const TRANSCRIPT_BUDGET = 12e3;
/** Assistant replies are trimmed to this; the user's words never are. */
const ASSISTANT_CAP = 300;
const DAY_MS = 864e5;
/**
* The reconciliation slice of the material: recent raw dialogue, one entry per
* question. The block, heading included, is capped at `budget`, so the
* transcript cannot grow with the workspace and eat the consolidation context.
*/
async function transcriptSection(root, options = {}) {
	const days = Math.max(1, options.days ?? TRANSCRIPT_DAYS);
	const budget = Math.max(0, options.budget ?? TRANSCRIPT_BUDGET);
	const now = options.now ?? Date.now();
	const header = [`## Recent transcripts (last ${days} days, for verification only)`, "Ground truth only — verify against it, never copy it into digest nodes."];
	const allowance = budget - (header.join("\n").length + 1);
	const body = newestFirst(groupByUserTurn(await readDialog(join(root, DIALOG_DIR), {
		now,
		days
	})).map(renderTurn), allowance);
	return [...header, body.length ? body.join("\n") : "- (none)"].join("\n");
}
/**
* Read every transcript line inside the window, oldest first. The journal is
* append-only and crash-prone by design, so each line is handled on its own:
* a torn final line or a malformed record is skipped, never fatal, or one bad
* session would take the whole consolidation pass down with it.
*/
async function readDialog(dir, range) {
	let names;
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const lines = [];
	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		const absolute = join(dir, name);
		const info = await stat(absolute).catch(() => null);
		if (info && range.now - info.mtimeMs >= range.days * DAY_MS) continue;
		let raw;
		try {
			raw = await readFile(absolute, "utf8");
		} catch {
			continue;
		}
		for (const row of raw.split("\n")) {
			const line = row.trim();
			if (!line) continue;
			let parsed;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
			const record = parsed;
			const role = record.role === "user" || record.role === "assistant" ? record.role : null;
			const text = typeof record.text === "string" && record.text.trim() ? record.text : null;
			if (!role || !text) continue;
			if (isOwnInjection(record, text)) continue;
			const kind = sourceKindOf(record);
			if (role === "user" && kind !== null && kind !== "user") continue;
			const time = Date.parse(typeof record.at === "string" ? record.at : "");
			if (!Number.isFinite(time)) continue;
			if (range.now - time >= range.days * DAY_MS) continue;
			lines.push({
				role,
				text,
				time
			});
		}
	}
	return lines.sort((a, b) => a.time - b.time);
}
/**
* The plugin's own injections sit in the transcript like any other turn, but
* they are our output, not ground truth — a node reconciled against them would
* end up confirming itself. Old transcripts carry no source field, so those
* lines are recognised by content; the source check covers whatever comes next.
*/
function isOwnInjection(record, text) {
	const source = record.source;
	if (source && typeof source === "object" && !Array.isArray(source)) {
		const marked = source;
		if (marked.kind === "node-memory" || marked.plugin === "node-memory") return true;
	}
	const head = text.trimStart();
	return head.startsWith("# 长期记忆") || head.startsWith("# Long-term memory") || text.includes("[[node-memory:dream]]");
}
/**
* Collapse the window into one entry per question. The transcript has no turn
* numbers, so a user line is the boundary; the last assistant line before the
* next question is that turn's conclusion, and the steps before it are
* narration on the way there. Assistant lines opening the window answer a
* question older than the window — kept they would verify nothing, so they go.
*/
function groupByUserTurn(lines) {
	const turns = [];
	let current = null;
	for (const line of lines) if (line.role === "user") {
		if (current) turns.push(current);
		current = {
			user: line,
			reply: null
		};
	} else if (current) current.reply = line;
	if (current) turns.push(current);
	return turns;
}
function renderTurn(turn) {
	const lines = [`- ${stamp(turn.user.time)} user: ${turn.user.text}`];
	if (turn.reply) lines.push(`- ${stamp(turn.reply.time)} assistant: ${capAssistant(turn.reply.text)}`);
	return lines.join("\n");
}
function capAssistant(text) {
	return text.length > ASSISTANT_CAP ? `${text.slice(0, ASSISTANT_CAP)}…` : text;
}
function stamp(time) {
	const date = new Date(time);
	const pad = (value) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/**
* Keep the newest entries that fit and drop the rest, oldest first: what
* reconciliation needs is the latest state of the facts, not the history.
* The kept slice stays contiguous so a turn never loses its answer. One
* exception: a paste larger than the whole block must not blank the section —
* an empty "(none)" under a budget that could have shown the newest question
* hides the very thing reconciliation needs most. The oversized newest entry
* goes in clipped instead; only a block too small to hold even a timestamp
* degrades to (none).
*/
function newestFirst(entries, allowance) {
	const kept = [];
	let spent = 0;
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (entry === void 0) continue;
		const cost = entry.length + 1;
		if (spent + cost > allowance) {
			if (kept.length === 0 && allowance >= CLIP_FLOOR) return [`${entry.slice(0, allowance - 2)}…`];
			break;
		}
		kept.unshift(entry);
		spent += cost;
	}
	return kept;
}
/** Below this many characters a clipped entry is noise, not evidence. */
const CLIP_FLOOR = 30;
/**
* How a node earns its colour. Written for a model that reads it once, so it is
* an ordered decision list with concrete trigger phrases, not a taxonomy.
* Order == severity: the first match wins. Both languages carry the same rules;
* the trigger phrases are language-specific on purpose.
*/
const KIND_RULES_TEXT = {
	zh: [
		"## 标注规则（决定热力图颜色）",
		"",
		"按顺序判一次，命中即停。拿不准就绿。宁可漏标，不可滥标。",
		"",
		"1. **红 conflict** — 新材料与已有节点矛盾（同一事实两个值：日期、端口、人名、偏好；",
		"   或旧结论已被推翻）。修正旧节点并标红，不要新建第二个。红的作用是让人看见，",
		"   不是让人难堪：正文写清「原来是什么、现在是什么、因为什么」。",
		"2. **紫 user-declared** — 用户**本人**用强调、决定或纠正的方式表达过：",
		"   「记住」「这个重要」「一定要」「以后都这样」「我决定」「就按这个来」「不是…是…」。",
		"   只认用户原话或其直接改写；不要把自己的推断、也不要替用户升级成紫。",
		"3. **蓝 notable** — 你判断半年后还想知道的：决策与理由、踩过的坑、可复用的步骤、",
		"   稳定的偏好与边界、人与组织的关系。一次性状态、临时情绪、随手能查到的公共常识都不算。",
		"   蓝靠校准：用户把蓝当噪音（「这也记？」）就提高门槛；用户抱怨漏记再放宽。",
		"4. **绿 normal** — 其余全部。默认值，不写 kind。",
		"",
		"标了非绿时，在正文末尾加一行理由，让颜色可追溯：",
		"`> 标紫：用户 10-25 原话「以后都按周五发版」`",
		"`> 标红：原记 23:00，今日改口 22:30`"
	].join("\n"),
	en: [
		"## Labelling rules (they decide the heatmap colour)",
		"",
		"Decide once, in order; the first match wins. When unsure, use green. Missing a colour is cheaper than inventing one.",
		"",
		"1. **red conflict** — the new material contradicts an existing node (one fact, two values:",
		"   a date, a port, a person, a preference; or an old conclusion has been overturned).",
		"   Correct the old node and mark it red; do not add a second node. Red exists to be seen,",
		"   not to assign blame — the body says what it used to be, what it is now, and why.",
		"2. **purple user-declared** — the user **themselves** stressed it, decided it, or corrected it:",
		"   \"remember this\", \"this matters\", \"always\", \"from now on\", \"I decided\", \"let's do it this way\",",
		"   \"it's not X, it's Y\". Only their own words or a direct paraphrase. Never promote your own",
		"   inference to purple, and never decide on the user's behalf what matters.",
		"3. **blue notable** — you judge it worth knowing in six months: decisions and their reasons,",
		"   traps you fell into, reusable procedures, stable preferences and boundaries, people and how",
		"   they relate. One-off states, passing moods, and public facts you could look up do not count.",
		"   Blue is calibrated, not defined: if the user treats blue as noise (\"why is this saved?\"),",
		"   raise the bar; if they complain about missing memories, lower it.",
		"4. **green normal** — everything else. The default; do not write `kind`.",
		"",
		"For any non-green node, end the body with one line of justification so the colour stays auditable:",
		"`> purple: user said on 10-25, \"we ship on Fridays from now on\"`",
		"`> red: was 23:00, changed to 22:30 today`"
	].join("\n")
};
function kindRules(language = "zh") {
	return KIND_RULES_TEXT[language === "en" ? "en" : "zh"];
}
KIND_RULES_TEXT.zh;
/**
* The prompt used when a background agent performs the consolidation itself.
* Kept here so the tool output and the scheduled task agree on the rules.
*/
function dreamPrompt(material) {
	return [
		"You are consolidating long-term memory. Work in the files, then report.",
		"",
		material,
		"",
		"When you are done, reply with a short list of files you created or changed.",
		"Do not ask questions; make the smallest useful set of edits."
	].join("\n");
}
// src/schedule.ts
function parseField(field, minimum, maximum, options = {}) {
	const allowSeven = options.allowSeven ?? false;
	const values = /* @__PURE__ */ new Set();
	let restricted = false;
	for (const part of field.split(",")) {
		const text = part.trim();
		if (!text) throw new Error(`empty cron field part in "${field}"`);
		const [rangeText = "", stepText] = text.split("/");
		const step = stepText === void 0 ? 1 : Number(stepText);
		if (!Number.isInteger(step) || step < 1) throw new Error(`invalid cron step "${text}"`);
		let start;
		let end;
		if (rangeText === "*") {
			start = minimum;
			end = maximum;
		} else if (rangeText.includes("-")) {
			const [a, b] = rangeText.split("-");
			start = Number(a);
			end = Number(b);
			restricted = true;
		} else {
			start = Number(rangeText);
			end = stepText === void 0 ? start : maximum;
			restricted = true;
		}
		if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error(`invalid cron value "${text}"`);
		if (start < minimum || end > maximum || start > end) throw new Error(`cron value out of range "${text}" (${minimum}-${maximum})`);
		for (let value = start; value <= end; value += step) values.add(allowSeven && value === 7 ? 0 : value);
	}
	return {
		values,
		restricted
	};
}
function parseCron(expression) {
	const parts = String(expression ?? "").trim().split(/\s+/);
	if (parts.length !== 5) throw new Error(`cron needs 5 fields, got ${parts.length}: "${expression}"`);
	const minutes = parseField(parts[0] ?? "", 0, 59);
	const hours = parseField(parts[1] ?? "", 0, 23);
	const days = parseField(parts[2] ?? "", 1, 31);
	const months = parseField(parts[3] ?? "", 1, 12);
	const weekdays = parseField(parts[4] ?? "", 0, 6, { allowSeven: true });
	return {
		minutes: minutes.values,
		hours: hours.values,
		days: days.values,
		months: months.values,
		weekdays: weekdays.values,
		domRestricted: days.restricted,
		dowRestricted: weekdays.restricted
	};
}
/**
* Wall-clock parts of an instant in a timezone.
*/
function toCivil(date, timeZone) {
	if (!timeZone) return {
		year: date.getFullYear(),
		month: date.getMonth() + 1,
		day: date.getDate(),
		hour: date.getHours(),
		minute: date.getMinutes()
	};
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23"
	});
	const parts = {};
	for (const part of formatter.formatToParts(date)) if (part.type !== "literal") parts[part.type] = part.value;
	return {
		year: Number(parts.year),
		month: Number(parts.month),
		day: Number(parts.day),
		hour: Number(parts.hour) % 24,
		minute: Number(parts.minute)
	};
}
/**
* Offset of a timezone at an instant, in minutes east of UTC.
*/
function offsetMinutesAt(utcMs, timeZone) {
	const civil = toCivil(new Date(utcMs), timeZone);
	const asUtc = Date.UTC(civil.year, civil.month - 1, civil.day, civil.hour, civil.minute);
	return Math.round((asUtc - utcMs) / 6e4);
}
function fromCivil(civil, timeZone) {
	if (!timeZone) return new Date(civil.year, civil.month - 1, civil.day, civil.hour, civil.minute, 0, 0);
	const naive = Date.UTC(civil.year, civil.month - 1, civil.day, civil.hour, civil.minute, 0, 0);
	let instant = naive - offsetMinutesAt(naive, timeZone) * 6e4;
	const second = toCivil(new Date(instant), timeZone);
	if (second.hour !== civil.hour || second.minute !== civil.minute || second.day !== civil.day) instant = naive - offsetMinutesAt(instant, timeZone) * 6e4;
	return new Date(instant);
}
function nextMinute(civil) {
	const next = {
		...civil,
		minute: civil.minute + 1
	};
	if (next.minute < 60) return next;
	next.minute = 0;
	return nextHour(next);
}
function nextHour(civil) {
	const next = {
		...civil,
		minute: 0,
		hour: civil.hour + 1
	};
	if (next.hour < 24) return next;
	next.hour = 0;
	return nextDay(next);
}
function nextDay(civil) {
	const next = {
		...civil,
		hour: 0,
		minute: 0,
		day: civil.day + 1
	};
	const daysInMonth = new Date(Date.UTC(next.year, next.month, 0)).getUTCDate();
	if (next.day <= daysInMonth) return next;
	next.day = 1;
	return nextMonth(next);
}
function nextMonth(civil) {
	const next = {
		...civil,
		day: 1,
		hour: 0,
		minute: 0,
		month: civil.month + 1
	};
	if (next.month <= 12) return next;
	next.month = 1;
	next.year += 1;
	return next;
}
function dayMatches(fields, civil) {
	const weekday = new Date(Date.UTC(civil.year, civil.month - 1, civil.day)).getUTCDay();
	const dom = fields.days.has(civil.day);
	const dow = fields.weekdays.has(weekday);
	if (fields.domRestricted && fields.dowRestricted) return dom || dow;
	if (fields.domRestricted) return dom;
	if (fields.dowRestricted) return dow;
	return true;
}
/**
* Next instant strictly after `from` that matches the expression.
* Returns null if nothing matches within five years (bad expression).
*/
function nextRun(expression, options = {}) {
	const { from = /* @__PURE__ */ new Date(), timeZone } = options;
	const fields = parseCron(expression);
	let civil = toCivil(from, timeZone);
	civil = nextMinute(civil);
	for (let guard = 0; guard < 2e5; guard += 1) {
		if (!fields.months.has(civil.month)) {
			civil = nextMonth(civil);
			continue;
		}
		if (!dayMatches(fields, civil)) {
			civil = nextDay(civil);
			continue;
		}
		if (!fields.hours.has(civil.hour)) {
			civil = nextHour(civil);
			continue;
		}
		if (!fields.minutes.has(civil.minute)) {
			civil = nextMinute(civil);
			continue;
		}
		const instant = fromCivil(civil, timeZone);
		if (instant.getTime() > from.getTime()) return instant;
		civil = nextMinute(civil);
	}
	return null;
}
/**
* Human-readable summary for logs and status output.
*/
function describeNextRun(expression, options = {}) {
	try {
		const next = nextRun(expression, options);
		if (!next) return "no upcoming run";
		const civil = toCivil(next, options.timeZone);
		const pad = (n) => String(n).padStart(2, "0");
		return `${civil.year}-${pad(civil.month)}-${pad(civil.day)} ${pad(civil.hour)}:${pad(civil.minute)}${options.timeZone ? ` (${options.timeZone})` : ""}`;
	} catch (error) {
		return `invalid schedule: ${error instanceof Error ? error.message : String(error)}`;
	}
}
// src/dream-task.ts
/**
* The consolidation task record.
*
* Turning the switch off must PAUSE the task, never delete it: the history of
* what ran and what failed is part of the memory system's own record, and a
* user who flips the switch back on should find their schedule intact.
*/
const TASK_ID = "dream";
const DEFAULT_CRON = "0 23 * * *";
function defaultState(input = {}) {
	const now = (/* @__PURE__ */ new Date()).toISOString();
	return {
		enabled: false,
		cron: input.cron ?? "0 23 * * *",
		timeZone: input.timeZone ?? null,
		createdAt: input.createdAt ?? now,
		updatedAt: now,
		pausedAt: null,
		lastRunAt: null,
		lastStatus: null,
		lastError: null,
		nextRunAt: null,
		runs: [],
		...input,
		id: TASK_ID
	};
}
var DreamTaskStore = class {
	root;
	file;
	constructor(options) {
		this.root = options.root;
		this.file = join(this.root, "metadata", "dream-task.json");
	}
	/**
	* Missing or corrupt task files fall back to a disabled default instead of
	* throwing: a broken metadata file must never stop DSH from starting.
	*/
	async load() {
		try {
			const text = await readFile(this.file, "utf8");
			const parsed = JSON.parse(text);
			return defaultState({
				...parsed,
				runs: Array.isArray(parsed.runs) ? parsed.runs.slice(-20) : []
			});
		} catch {
			return defaultState();
		}
	}
	async save(state) {
		const next = {
			...state,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		await mkdir(dirname(this.file), { recursive: true });
		const temporary = `${this.file}.tmp`;
		await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
		await rename(temporary, this.file);
		return next;
	}
	/**
	* Switch on: create (or resume) the task and compute its next run.
	*/
	async enable(options = {}) {
		const current = await this.load();
		const cron = options.cron ?? current.cron ?? "0 23 * * *";
		const timeZone = options.timeZone ?? current.timeZone ?? null;
		const from = options.from ?? /* @__PURE__ */ new Date();
		const state = {
			...current,
			enabled: true,
			cron,
			timeZone,
			pausedAt: null,
			nextRunAt: nextRun(cron, {
				from,
				timeZone: timeZone ?? void 0
			})?.toISOString() ?? null
		};
		return this.save(state);
	}
	/**
	* Switch off: stop, keep everything.
	*/
	async disable() {
		const current = await this.load();
		return this.save({
			...current,
			enabled: false,
			pausedAt: (/* @__PURE__ */ new Date()).toISOString(),
			nextRunAt: null
		});
	}
	async recordRun(result) {
		const current = await this.load();
		const at = (/* @__PURE__ */ new Date()).toISOString();
		const runs = [...current.runs, {
			at,
			status: result.status,
			detail: result.detail
		}].slice(-20);
		const from = result.from ?? /* @__PURE__ */ new Date();
		return this.save({
			...current,
			lastRunAt: at,
			lastStatus: result.status,
			lastError: result.status === "error" ? result.detail ?? "unknown error" : null,
			runs,
			nextRunAt: current.enabled ? nextRun(current.cron, {
				from,
				timeZone: current.timeZone ?? void 0
			})?.toISOString() ?? null : null
		});
	}
	isDue(state, now = /* @__PURE__ */ new Date()) {
		if (!state.enabled) return false;
		if (!state.nextRunAt) return true;
		const due = Date.parse(state.nextRunAt);
		return Number.isFinite(due) && due <= now.getTime();
	}
};
export { Capture as _, dreamPrompt as a, shortHash as b, textOf as c, INDEX_PAGE_PATH as d, buildLinkGraph as f, writeRepresentation as g, nearDuplicates as h, buildDreamMaterial as i, textOfRecord as l, gistOf as m, DreamTaskStore as n, SOURCE as o, digestNodes as p, describeNextRun as r, TurnCapture as s, DEFAULT_CRON as t, turnFromEvent as u, dateKey as v, excerpt as y };

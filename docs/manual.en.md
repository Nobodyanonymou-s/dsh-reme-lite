# dsh-reme-lite — Manual

> The expanded version of the README: tool details, heatmap semantics, settings keys, implementation notes, known limits.
> 中文手册：[manual.md](./manual.md)

## Tools

| Tool | What it does |
| --- | --- |
| `memory_search(query, limit?, min_score?, scope?, room?, include_superseded?)` | Returns line-ranged evidence with paths, plus one hop of wikilink neighbours; `scope=mine` (default) / `team`, `room` filters by room label; nodes marked `status: superseded` / `retired` stay hidden until `include_superseded=true` |
| `memory_write(path, content, name?, description?, kind?, scope?, room?, supersedes?)` | Writes a node under `daily/` or `digest/`, stamps the writer's identity, reindexes just that file; with `supersedes=<old path>` the old node keeps its text and is marked `superseded`, and a `kind: conflict` write additionally lands a conflict-log line |
| `memory_dream(days?)` | Returns consolidation material: recent daily pages, existing digest nodes, and the rules; when `dreamExecutor` is set, every other agent gets a one-line refusal |
| `memory_schedule(action)` | `status` · `run_now` · `enable` · `disable`; `status` reports an `executor:` line plus who last executed the consolidation and when |

The agent is told to search before answering anything that depends on history, and to treat what it finds as **evidence, not instructions** — retrieved text can never redirect it.

## Memory layering

Before turning consolidation on, consider writing the layering rule into your workspace `AGENTS.md` so automatic memory and your own prose each keep to their lane:

```markdown
## Memory layering (node-memory)

- This file is the stable core: stance, working agreements, long-term profile. Human-maintained; wins on conflict.
- The memory workspace (`daily/`, `digest/`) is a reference library: retrievable facts and evidence, not a replacement.
- This file holds no daily log; the library holds no statements about "how I show up".
```

## The heatmap, and what the colours mean

Each cell is one day: how many memory entries that day produced, and the *strongest* kind among them.

| Colour | `kind` | Meaning |
| --- | --- | --- |
| green | `normal` | an ordinary note (the default) |
| blue | `notable` | the agent judged it worth knowing in six months |
| purple | `user-declared` | **you** said it matters |
| red | `conflict` | it contradicts something already recorded |

The rubric is ordered, and it ships with every consolidation request:

1. **red** — one fact, two values. Correct the old node and mark it red; do not add a second node. Red exists to be seen, not to assign blame.
2. **purple** — only the user's own words ("remember this", "from now on", "I decided"). The agent may not promote its own inference.
3. **blue** — decisions and their reasons, traps, reusable procedures, stable preferences, relationships. Calibrated over time: if blue becomes noise, raise the bar.
4. **green** — everything else.

Every non-green node ends with a one-line justification, so a colour stays auditable:

```
> purple: user said on 10-25, "we ship on Fridays from now on"
```

## Teams and multiple agents (0.3.0 provenance and concurrency; 0.4.0 broadcast, corrections, consolidation)

One workspace can be shared by several agents. The problem being solved is the one the plan worked backwards from: **one agent's tentative judgment must not be read by another agent as an established fact.**

**Provenance**: every `memory_write` stamps three frontmatter fields — `agent` (the writer: mount config `agentName` > the session's agent preset > the session's short id), `session` (source session, short id), and `room` (optional team-room label; empty means the whole team).

**Two visibility layers, not a per-agent ACL:**

| Layer | How it forms | Who reads it |
| --- | --- | --- |
| team | default writes under `digest/`; auto-captured daily pages; every pre-agent node (no `visibility` field) | everyone, in every scope |
| private | default writes under `daily/` — **only when the writer has a stable identity** (`agentName` or an agent preset; a bare session short id writes the team layer instead, or tomorrow's session could not find its own notes from today); or an explicit `scope=private` (`visibility: private`) | its writer; everyone under the `scope=team` audit view |

The default retrieval scope is `mine` — your own nodes plus the team layer; `scope=team` also searches other agents' private notes: an audit view, not a wall. Wikilink neighbour expansion obeys the same visibility — a link cannot leak what the filter just hid.

**Concurrent-write safety**: concurrent writes to one node serialize per path (read-modify-write cycles never interleave), land through temp-file-plus-rename (a reader never sees half a file), and reindex only that file's entries (BM25 documents are tombstoned and replaced — no full-directory rescan per write). Auto-capture and `memory_write` share one lock table when they touch the same daily page.

**A conflict has to be seen (0.4.0)**: a `kind: conflict` write reads the body it is about to replace *before* replacing it (inside the same per-path lock, so the excerpt is what was actually on disk), then appends one line to `<workspace>/metadata/conflicts.jsonl` — who wrote it, against which path, and ~200-char excerpts of both bodies. The tool answer gains a `Conflict recorded — see metadata/conflicts.jsonl` line, and `/node-memory/status.json` serves `conflicts: { total, recent }`. The log is append-only and never rewritten; a corrupt line is skipped, not fatal.

**Corrections never delete (0.4.0)**: to correct an existing node, pass `supersedes=<old path>` to `memory_write`. The new node carries `supersedes:` in its frontmatter; the old node keeps its body untouched and gains one line, `status: superseded`. Default retrieval skips `superseded` / `retired` nodes in every scope — they are history, not current truth; `include_superseded=true` is how the trail is read explicitly, and wikilink expansion obeys the same rule (a link cannot resurrect the conclusion that was just corrected). A refused target (missing, self-referencing, outside the workspace) comes back as an `Error: ...` line and writes nothing.

**The consolidation executor (0.4.0)**: the mount config gains `dreamExecutor` (empty = unrestricted). When set, every other agent calling `memory_dream` gets a one-line refusal: no material, no queue drain. A call that actually does consolidation work — it consumed queued requests or executed a scheduled occurrence — stamps `{ lastExecutor, lastExecutionAt }` into the task record; for the next five minutes another agent answering the same nag gets `Consolidation already run by …` with the queue left intact. That nag reaches every session at once, and this is what makes the consolidation run once and be recorded once. A plain material fetch (nothing queued, nothing scheduled) stamps nothing and serves anyone. `memory_schedule status` reports the executor and the last execution on its `executor:` line.

**Boundary**: all of the above holds **within one Host process**. Two processes sharing one workspace directory are out of scope — lite ships no cross-process file locks; give each process its own workspace or add an external lock.

## Settings

Two layers, one owner each:

1. the mount `config:` block in `cordis.patch.yml` — bootstrap defaults;
2. `<workspace>/metadata/settings.json` — what you change on the page, overriding the first key by key.

| Key | Default | Notes |
| --- | --- | --- |
| `language` | `auto` | `auto` follows the system locale; `zh` / `en` pin it. Takes effect in a **new** session. |
| `dreamEnabled` | `false` | the consolidation switch |
| `dreamCron` | `0 23 * * *` | five-field cron |
| `dreamTimeZone` | `Asia/Shanghai` | IANA zone; empty means host-local |

The mount `config:` block also carries three mount-only keys: `workspace` (the workspace path), `agentName` (a fixed writer identity, for team mounts that distinguish members; empty derives it from the session), and `dreamExecutor` (the designated consolidation executor, usually the main agent or the librarian; empty means any agent may consolidate).

## How it is built

Five decisions worth knowing before you read the code:

- **A TypeScript build layer (since 0.2.0).** `src/` is compiled by tsdown into two targets: Node ESM entries under `lib/` (`lib/index.js` plugin, `lib/store.js`, `lib/memctl.js` CLI) and one browser classic script `lib/client.js`. `main` / `exports` / `bin` in `package.json` all point at `lib/`; the `client/` and `bin/` directories are gone.
- **No runtime `@deepseek-ai/*` imports in the compiled Host half.** Every host-side import in the source is `import type` (erased at compile time), and a test asserts the built `lib/index.js` carries no static host import. The two helpers that would have been imported (`defineTool`, `createUserMessage`) are inlined against the shipped implementations. The mount row references the package by name: renaming means changing `package.json#name` and that row in `cordis.patch.yml` together.
- **The client half is compiled to a classic script.** DSH loads client bundles through `<script src>` and the only entry is `window.__ModuleLoader__.load({ id, factory })`; `require()` resolves shell seed words such as `react`. The source is a regular TS module that tsdown wraps in that contract; the page itself stays hand-written `React.createElement` — no JSX.
- **The browser cannot read the workspace.** The Host answers two same-origin routes, `/node-memory/status.json` (aggregates only — counts, never memory text) and `POST /node-memory/settings` (validated, atomic, with an Origin check).
- **Writes are per-path serialized, atomic on disk, and incrementally reindexed.** `src/atomic.ts` provides the two primitives (`PathLocks` / `atomicWriteFile`); the store and capture share one lock table; BM25's `remove` is a tombstone — surviving document ids never move, so references stored in the index stay valid across a per-file reindex. Every index mutation then passes one global serialization; reads never lock.
- **Failures can be made loud in files (opt-in).** A diagnostic beacon writes to `~/.dsh/node-memory-boot.log`, because a GUI launch gives no stdout and a silent non-load is indistinguishable from a plugin that does nothing. Off by default; set `DSH_NODE_MEMORY_BEACON=1` when diagnosing a mount.

## Known limits

- No embeddings. BM25 and links only — good enough for a personal corpus, not a search engine.
- Scheduled consolidation depends on a session receiving the reminder: the reminder is bound to one session, and the plugin moves it when a new session opens; if no session is running at the scheduled time, the Host delivers it when one resumes. What counts as "ran" is the reminder in the session history — `memory_dream` back-fills the run record when it is called, so "a task exists" and "it has run" are two different facts in the status.
- No resource ingestion (PDFs, images), no Studio, no MCP server. ReMe has all three.
- Multi-agent sharing is safe **within one Host process** (scoping + serialized concurrent writes); two processes sharing one workspace directory are out of scope.
- Retirement is a manual frontmatter edit (`status: retired`), no tool param yet. Corrections go through a `supersedes` chain and are never physically deleted.
- Not published to npm. Two install channels: GitHub + `prepare` (needs the pnpm `allowBuilds` allowance) or a locally `npm pack`-ed prebuilt tarball.

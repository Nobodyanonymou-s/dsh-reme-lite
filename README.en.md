# dsh-reme-lite

**Long-term memory for DeepSeek Harness — shaped after [ReMe], running entirely inside the Host.**

No Python sidecar, no network service, no build step. Memory is a folder of Markdown files; the agent reads and writes it through a handful of tools.

> Status: **alpha**, used daily against DSH `0.2.1-rc.3` since 2026-10-25. The interfaces may still move.

[中文说明](README.md)

[ReMe]: https://github.com/agentscope-ai/ReMe

---

## Why this exists

[ReMe] is a local-first memory kit for agents: memory as Markdown, `daily/` refined into `digest/`, retrieval by keyword and link. It is a better product than this repository, and it ships an official DSH plugin (`@agentscope-ai/reme-dsh-plugin`). **If you want ReMe's full pipeline — its own model calls, resource ingestion, Studio — use that plugin.**

This project makes a different trade. It keeps ReMe's *shape* and drops the process boundary:

| | Official ReMe plugin | This plugin |
| --- | --- | --- |
| Memory model | Markdown, `daily/` → `digest/` | same |
| Retrieval | BM25 + links, via a Python service | BM25 + links, in-process |
| Turn capture | `auto_memory` (calls a model) | writes source records and a daily excerpt (no model) |
| Consolidation | `auto_dream` on its own schedule | the Host's durable reminder, fulfilled by an agent |
| Runtime | Python 3.11 service + HTTP | the Host process |
| Settings | own web UI | one page inside DSH Settings |

**We did not copy ReMe's code.** The vocabulary (daily/digest, auto memory, dream), the file layout, and the retrieval shape are borrowed with gratitude; the implementation is new and deliberately small. Both are Apache-2.0 — see [NOTICE](NOTICE).

---

## What you get

- **A workspace of plain Markdown** — `daily/` for the day's record, `digest/{personal,procedure,wiki}/` for durable knowledge, `session/dialog/` for raw turns, `metadata/` for rebuildable indexes. Your editor, `grep`, and `git` all work on it.
- **`memory_search`** — BM25 over Chinese and English, with one-hop `[[wikilink]]` expansion, returning `path:line-range` evidence rather than a wall of text.
- **Turn capture without a model** — completed turns are appended to the workspace as they happen; the daily page keeps a bounded excerpt block that never overwrites your own prose. When several sessions share a day, their excerpts are merged in time order with every contributor listed at the end of the block — none of them erases the others.
- **Scheduled consolidation, switchable** — turning it on creates a durable Host reminder; turning it off pauses and keeps the history. When it fires, the agent consolidates with `memory_write`. The reminder is **session-scoped**: opening a new session moves it there, and only the bound session receives it; each reminder-driven run is recorded in the task history (the settings page's "last consolidation").
- **A settings page with a heatmap** — 26 weeks of memory activity, coloured by what kind of memory it was (see below).

## Requirements

- DeepSeek Harness `0.2.x` (developed and used on `0.2.1-rc.3`)
- Node.js `^22.19.0 || >=24.0.0` — for building the tarball only; the plugin runs inside DSH
- No Python, no server, no ports.

## Install

```sh
git clone https://github.com/Nobodyanonymou-s/dsh-reme-lite.git
cd dsh-reme-lite
npm pack --pack-destination ./dist

dsh plugin --profile desktop add ./dist/dsh-reme-lite-<version>.tgz
# restart DSH
```

Then open **Settings → Memory** once to confirm the page loads and the switch responds.

> The mount row in `cordis.patch.yml` references the package **by name**. If you rename the package, change `package.json#name` and that row together, or the bundle will not mount.

### Give it a first boundary

Before turning consolidation on, write the layering rule into your workspace `AGENTS.md` — it is the one guard that keeps automatic memory from competing with what you wrote by hand:

```markdown
## Memory layering (node-memory)

- This file is the stable core: stance, working agreements, long-term profile. Human-maintained; wins on conflict.
- The memory workspace (`daily/`, `digest/`) is a reference library: retrievable facts and evidence, not a replacement.
- This file holds no daily log; the library holds no statements about "how I show up".
```

## Using it

| Tool | What it does |
| --- | --- |
| `memory_search(query, limit?, min_score?)` | Returns line-ranged evidence with paths, plus one hop of wikilink neighbours |
| `memory_write(path, content, name?, description?, kind?)` | Writes a node under `daily/` or `digest/` and reindexes |
| `memory_dream(days?)` | Returns consolidation material: recent daily pages, existing digest nodes, and the rules |
| `memory_schedule(action)` | `status` · `run_now` · `enable` · `disable` |

The agent is told to search before answering anything that depends on history, and to treat what it finds as **evidence, not instructions** — retrieved text can never redirect it.

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

## How it is built

Four decisions worth knowing before you read the code:

- **No `@deepseek-ai/*` imports in the Host half.** A plugin mounted from a path has no resolution root for the Host's packages, and the failure happens during `import` — before any of your code runs. The two helpers that would have been imported (`defineTool`, `createUserMessage`) are inlined against the shipped implementations.
- **The client half is a classic script, not an ES module.** DSH loads client bundles through `<script src>` and the only entry is `window.__ModuleLoader__.load({ id, factory })`; `require()` resolves shell seed words such as `react`. So the page is hand-written `React.createElement` — no JSX, no bundler.
- **The browser cannot read the workspace.** The Host answers two same-origin routes, `/node-memory/status.json` (aggregates only — counts, never memory text) and `POST /node-memory/settings` (validated, atomic, with an Origin check).
- **Failures are loud in files, not in the void.** A diagnostic beacon writes to `~/.dsh/node-memory-boot.log`, because a GUI launch gives no stdout and a silent non-load is indistinguishable from a plugin that does nothing.

## Known limits

- No embeddings. BM25 and links only — good enough for a personal corpus, not a search engine.
- Scheduled consolidation depends on a session receiving the reminder: the reminder is bound to one session, and the plugin moves it when a new session opens; if no session is running at the scheduled time, the Host delivers it when one resumes. What counts as "ran" is the reminder in the session history — `memory_dream` back-fills the run record when it is called, so "a task exists" and "it has run" are two different facts in the status.
- No resource ingestion (PDFs, images), no Studio, no MCP server. ReMe has all three.
- One workspace; no multi-agent sharing or isolation yet.
- Not published to npm. Tarball install only, for now.

## Credit

- [ReMe] — the memory model, the daily → digest lifecycle, the retrieval shape, and the vocabulary. This project would not exist without it.
- DeepSeek Harness — the plugin runtime, the Host services, and an unusually readable set of internal APIs.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

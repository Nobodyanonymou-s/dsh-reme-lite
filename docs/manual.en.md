# dsh-reme-lite — Manual

> The expanded version of the README: tool details, heatmap semantics, settings keys, implementation notes, known limits.
> 中文手册：[manual.md](./manual.md)

## Tools

| Tool | What it does |
| --- | --- |
| `memory_search(query, limit?, min_score?)` | Returns line-ranged evidence with paths, plus one hop of wikilink neighbours |
| `memory_write(path, content, name?, description?, kind?)` | Writes a node under `daily/` or `digest/` and reindexes |
| `memory_dream(days?)` | Returns consolidation material: recent daily pages, existing digest nodes, and the rules |
| `memory_schedule(action)` | `status` · `run_now` · `enable` · `disable` |

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

Five decisions worth knowing before you read the code:

- **A TypeScript build layer (since 0.2.0).** `src/` is compiled by tsdown into two targets: Node ESM entries under `lib/` (`lib/index.js` plugin, `lib/store.js`, `lib/memctl.js` CLI) and one browser classic script `lib/client.js`. `main` / `exports` / `bin` in `package.json` all point at `lib/`; the `client/` and `bin/` directories are gone.
- **No runtime `@deepseek-ai/*` imports in the compiled Host half.** Every host-side import in the source is `import type` (erased at compile time), and a test asserts the built `lib/index.js` carries no static host import. The two helpers that would have been imported (`defineTool`, `createUserMessage`) are inlined against the shipped implementations. The mount row references the package by name: renaming means changing `package.json#name` and that row in `cordis.patch.yml` together.
- **The client half is compiled to a classic script.** DSH loads client bundles through `<script src>` and the only entry is `window.__ModuleLoader__.load({ id, factory })`; `require()` resolves shell seed words such as `react`. The source is a regular TS module that tsdown wraps in that contract; the page itself stays hand-written `React.createElement` — no JSX.
- **The browser cannot read the workspace.** The Host answers two same-origin routes, `/node-memory/status.json` (aggregates only — counts, never memory text) and `POST /node-memory/settings` (validated, atomic, with an Origin check).
- **Failures can be made loud in files (opt-in).** A diagnostic beacon writes to `~/.dsh/node-memory-boot.log`, because a GUI launch gives no stdout and a silent non-load is indistinguishable from a plugin that does nothing. Off by default; set `DSH_NODE_MEMORY_BEACON=1` when diagnosing a mount.

## Known limits

- No embeddings. BM25 and links only — good enough for a personal corpus, not a search engine.
- Scheduled consolidation depends on a session receiving the reminder: the reminder is bound to one session, and the plugin moves it when a new session opens; if no session is running at the scheduled time, the Host delivers it when one resumes. What counts as "ran" is the reminder in the session history — `memory_dream` back-fills the run record when it is called, so "a task exists" and "it has run" are two different facts in the status.
- No resource ingestion (PDFs, images), no Studio, no MCP server. ReMe has all three.
- One workspace; no multi-agent sharing or isolation yet.
- Not published to npm. Two install channels: GitHub + `prepare` (needs the pnpm `allowBuilds` allowance) or a locally `npm pack`-ed prebuilt tarball.

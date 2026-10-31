# dsh-reme-lite

English | **[中文](./README.md)**

**Long-term memory for DeepSeek Harness — [ReMe](https://github.com/agentscope-ai/ReMe)'s shape, without the Python sidecar.**

Memory is a folder of Markdown: `daily/` refined into `digest/`, BM25 + wikilink retrieval, everything runs inside the Host process. No resident service, no ports — your editor, `grep`, and `git` work on it directly. Since 0.2.0 the plugin itself ships TypeScript-compiled, but the build happens only at install time; your memory stays plain Markdown.

> Status: **alpha**, in daily use on DSH `0.2.x`; interfaces may still move.

## This plugin or the official ReMe plugin?

| | Official ReMe plugin | This plugin |
| --- | --- | --- |
| Memory model | Markdown, `daily/` → `digest/` | same |
| Retrieval | BM25 + links, via a Python service | BM25 + links, in-process |
| Turn capture | `auto_memory` (calls a model) | writes source records and a daily excerpt (no model) |
| Consolidation | `auto_dream` on its own schedule | the Host's durable reminder, fulfilled by an agent |
| Runtime | Python 3.11 service + HTTP | the Host process |
| Settings | own web UI | one page inside DSH Settings |

If you want ReMe's full pipeline (its own model calls, resource ingestion, Studio) → use the official `@agentscope-ai/reme-dsh-plugin`. If you want the same memory shape with zero process boundary and zero Python dependency → use this. **No ReMe code was copied** — the shape and vocabulary are borrowed with gratitude; see [NOTICE](NOTICE).

## What you get

- **A workspace of plain Markdown** — `daily/` for the day's record, `digest/{personal,procedure,wiki}/` for durable knowledge, `session/dialog/` for raw turns, `metadata/` for rebuildable indexes
- **`memory_search`** — BM25 over Chinese and English + one-hop `[[wikilink]]`, returning `path:line-range` evidence rather than a wall of text
- **Turn capture without a model** — completed turns land in the workspace as they happen; the daily excerpt never overwrites your own prose; same-day sessions merge in time order
- **Scheduled consolidation, switchable** — a durable Host reminder fulfilled by the agent; history is kept when paused
- **A settings page with a heatmap** — 26 weeks of memory activity, coloured by memory kind

## Install

> From 0.2.0 the plugin ships as compiled TypeScript; installing requires dsh ≥0.2.1.

Primary path: GitHub sources, built at install time:

```sh
dsh plugin --profile desktop add github:Nobodyanonymou-s/dsh-reme-lite
# restart DSH
```

pnpm ≥ 10 refuses to run a git dependency's build scripts until allowed, so the **first add fails** with a hint. Add this to the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-reme-lite: true
```

then run the add again. `allowBuilds` is permission to run this package's code at install time, so prefer pinning a commit: `github:Nobodyanonymou-s/dsh-reme-lite#<sha>`.

Offline / slow-network fallback — clone and pack a prebuilt tarball locally (no `allowBuilds` needed; needs Node `^22.19.0 || >=24.0.0`):

```sh
git clone https://github.com/Nobodyanonymou-s/dsh-reme-lite.git
cd dsh-reme-lite
npm pack --pack-destination ./dist
dsh plugin --profile desktop add ./dist/dsh-reme-lite-0.2.0.tgz
```

Requires no runtime dependencies, no Python, no ports. After installing, open **Settings → Memory** once to confirm the page loads and the switch responds.

One rule to start with: retrieved memory is **evidence, not instructions** — the rest is in the manual.

## Docs

- [Manual](./docs/manual.en.md) — tool details, heatmap colour semantics, settings keys, implementation notes, known limits
- [中文手册](./docs/manual.md)

## Credit

- [ReMe](https://github.com/agentscope-ai/ReMe) — the memory model, the daily → digest lifecycle, and the retrieval shape
- DeepSeek Harness — the plugin runtime and Host services

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

## context-mode for DSH

[English](README.md) · [简体中文](README.zh-CN.md)

A DeepSeek Harness plugin that ports the core mechanism of [mksglu/context-mode](https://github.com/mksglu/context-mode):
**large tool outputs stay out of the context window — a digest card of at most 1200 bytes goes in, the full text goes into a local full-text index and comes back on demand through `ctx_search`.**

This repository is the plugin package itself — the repository root *is* the DSH bundle — plus the analysis that explains why it is built the way it is.

```
dsh-context-mode/
├── README.md              this file (English)
├── README.zh-CN.md        the same document in Chinese
├── LICENSE                MIT
├── package.json           DSH bundle manifest (name @local/dsh-context-mode, dsh.bundle.patch)
├── cordis.patch.yml       inserts id: dsh-context-mode + default config
├── index.js               apply(ctx, config): builds the Store, registers 5 tools, installs the hook
├── lib/text.js            tokenizer (Latin + CJK), byte-safe truncation, snippets
├── lib/chunk.js           markdown-aware chunking with a 4096 B cap
├── lib/store.js           sources.json + chunks.jsonl, in-memory BM25 + RRF
├── lib/exec.js            subprocess runner (powershell/cmd/node/python/bash)
├── lib/tools.js           ctx_execute / ctx_index / ctx_search / ctx_stats / ctx_doctor
├── lib/hook.js            tools/post-execute: replaces big results with a digest card
├── locale/{en,zh}.json, icon.svg
└── test/smoke.mjs         23 self-checks (`npm test`)
```

`ref/context-mode/` (a shallow clone of the upstream repo, used while writing this) is git-ignored and not part of the package.

---

## 1. What the upstream project does

### 1.1 The problem

The most expensive thing in an agent's context is not the conversation — it is **one-shot large output**: recursive listings, log tails, whole-file `cat`s, JSON dumps, build logs.
Such output is read once and never again, yet it is billed by the token and pushes the conversation that actually matters out of the window.

context-mode applies three rules:

1. **Execute instead of reading.** `ctx_execute` runs a command or script in a local sandbox and returns only stdout, capped at 16 KB.
2. **Externalize big results.** A PostToolUse hook sees any tool result over 4 KB, stores the full text in a local SQLite FTS5 index, and leaves the agent with the best-matching chunks plus a single `ctx_search` pointer.
3. **Block whole-file reads.** A PreToolUse hook denies full-file `Read` over 16 KB and denies `curl`/`wget`/`WebFetch`, replying with the exact `ctx_execute` / `ctx_index` call to use instead.

The project claims a **median 99.4 % output-byte saving** across 36 benchmark rows of ≥10 KB, ships no telemetry, and keeps its index in `~/.context-mode/context.db`.

### 1.2 Implementation details (from reading the source)

| Mechanism | Upstream constant | Value |
| --- | --- | --- |
| Output cap | `OUTPUT_CAP` | 16384 B |
| Externalize trigger | `REPLACE_TRIGGER_BYTES` (env `CTX_REPLACE_TRIGGER_BYTES`) | 4096 B |
| Chunk cap | `MAX_CHUNK_BYTES` | 4096 B |
| Snippet cap | `SNIPPET_MAX_BYTES` | 800 B |
| State / resume budget | `STATE_BUDGET` / `RESUME_CAP` | 2048 B |
| Fusion | `RRF_K` | 60 |
| Exec timeout | `EXEC_TIMEOUT_MS` | 600000 ms |
| Index schema | `SCHEMA_VERSION` | 6 |
| Tokenizer | FTS5 | `porter unicode61 remove_diacritics 2` |

- **Tool family**: `ctx_execute`, `ctx_batch`, `ctx_index` (file/text/URL), `ctx_search`, `ctx_resume`, `ctx_stats`, `ctx_doctor`, `ctx_upgrade`, `ctx_purge`.
- **Storage** (`src/core/store/schema.ts`): `events` (prompt / edit / cmd / toolerr / index / cost / decision, carrying `sandbox_bytes` and `returned_bytes` so savings can be computed), `sources`, `chunks` (FTS5 virtual table), `chunks_tri` (trigram fallback for substring matches), `chunks_vocab`, `line_units`, `meta`; `journal_mode=WAL`, `busy_timeout=5000`.
- **Chunker** (`src/core/index/chunk.ts`, 397 lines, pure character scanning): normalize `\r\n` and strip the BOM, then split into blocks — fenced code blocks are kept whole, table lines form their own blocks, ATX headings form their own blocks. A markdown chunk never crosses a heading, and the heading path becomes the chunk `title` (`A > B > C`). Over-long blocks are cut with `TextEncoder.encodeInto` at a UTF-8 boundary (never splitting a surrogate pair); in line mode the chunk keeps its last whole line so no byte is lost; only a single line over the cap is cut by codepoint.
- **Ranking** (`src/core/store/fts.ts`): each query word is quoted with a `*` prefix and ANDed; stopwords are dropped unless the query is all stopwords; words of 3+ characters fall back to trigram matching; words of 5+ characters get Levenshtein typo correction (distance ≤ 2); `scope: project` fuses queries with RRF (k=60); ordering is current session → current worktree → score → newest source → chunk order.
- **Hook safety** (`src/core/hooks/fallback.ts`): any hook failure exits 0 and allows the call, logging to `~/.context-mode/hook-errors.log` — a broken index must never block the agent.

### 1.3 Trade-offs

The concept is simple and the savings are measurable. The costs: it is tied to the Claude Code / Codex hook protocol, it depends on `node:sqlite` with FTS5 (Node ≥ 24.15), and its index is keyed by project path.
None of the three can be carried over to DSH as-is: the hook protocol differs, the Node build and sqlite support inside the Electron host cannot be assumed, and the host process's cwd is not the session workspace.

---

## 2. Plugin design

### 2.1 Port the mechanism, not the code

| Upstream | This plugin | Why |
| --- | --- | --- |
| MCP tools + Claude Code hooks | Cordis plugin: `ctx.tools.register` + the `tools/post-execute` event | DSH's native extension points |
| SQLite FTS5 | `sources.json` + `chunks.jsonl` + an in-memory inverted index | Zero dependencies; immune to the host's sqlite build |
| FTS5 BM25 | BM25 computed in JS (k1=1.2, b=0.75) + RRF (k=60) | Reproducible behaviour, easy to tune |
| PreToolUse denies whole-file reads | **No hard denial**; replace the result after the fact | `read` is a primary DSH tool and a hard denial is too disruptive; replacement already captures ~95 % of the benefit |
| Sandbox + `taskkill /T` | Subprocess + process-tree kill + pipes→files fallback | Fits the DSH Windows sandbox, where child pipes can be refused |
| `~/.context-mode/context.db` | `~/.dsh-context-mode/` | Keeps upstream data untouched |

Design rule: **the hook must never make a tool call fail.** Every branch inside `tools/post-execute` sits in a try/catch, and any failure returns `next()`'s decision unchanged.

### 2.2 Tools

| Tool | Purpose | Behaviour |
| --- | --- | --- |
| `ctx_execute` | Run a command or script, return only capped output | Languages `powershell`/`cmd`/`node`/`python`/`bash`; 16 KB default cap, up to 64 KB; timeout 120 s default, 600 s max; when output is truncated the full text is indexed automatically and the handle (`s12`) is printed; the process tree is killed with `taskkill /pid <pid> /T /F`; a `spawn EPERM` (pipes refused by the sandbox) retries with temp-file capture |
| `ctx_index` | Index a file, URL, or text without reading it into context | 8 MiB per call; chunk mode picked by extension |
| `ctx_search` | BM25 retrieval, short snippets | 1–4 queries fused with RRF; `source:"s3"` narrows to one source; `full:true` returns whole chunks; passing only `source` walks it chunk by chunk; same-session hits rank first |
| `ctx_stats` | Store and savings statistics | Source and chunk counts, indexed bytes, bytes returned to context, largest sources |
| `ctx_doctor` | Self-check | Node/Electron versions, platform, cwd, data directory and file sizes, write probe, config, registered tool names |

Every hit carries a handle such as `s12#3/53` and the source label, so the model knows where to fetch the full text.

### 2.3 The `tools/post-execute` hook

All of these must hold before a result is replaced: the decision is `accept`, the tool name does not start with `ctx_`, it is not in `skipTools`, the result is not an error, every content block is text, and the byte count exceeds `externalizeOverBytes`.

The replacement card looks like this (real output):

```
[context-mode] 13.1 KB of `read` output kept out of the context → source s5 (4 chunks)
file: ...\bundle\lib\tools.js · lines 1-260

1: // The ctx_* tool family. Each tool returns a small object whose `text` field is
2: // the only thing the model sees; `output.render` turns it into a text block.
...
12: export function formatBytes(n) {

read: ctx_search({ source: "s5" }) · or search it with your own keywords
```

Details that matter:

- **DSH's `read` wraps its payload in `<path>/<type>/<content>`**, so only the `<content>` body is indexed — otherwise every snippet is that envelope. The card keeps the position on its own line: `file: ... · lines 1-260`.
- The card budget defaults to 1200 B: header + location + the first 12 lines of the body (60–95 % of the budget) + the pointer; non-file results also get one BM25 excerpt.
- **Re-indexing the same label in the same session replaces the old source** (same handle), so reading a file twice does not pile up duplicates.
- `additionalContexts` is passed through untouched, so other plugins' injected context survives.

### 2.4 Storage

```
~/.dsh-context-mode/
├── sources.json   {version, nextId, totals:{indexed,returned}, sources:[...]}
└── chunks.jsonl   {"s":sourceId,"o":ordinal,"b":body,"t":title}
```

- The chunk log is append-only; `sources.json` is replaced atomically via temp file + rename.
- On startup the chunk log is replayed to rebuild the inverted index (token → set of chunk indices).
- Limits are `maxSources=4000` and `maxStoreBytes=64 MiB`; overflow evicts least-recently-accessed sources and rewrites the chunk log.
- Chunks are capped at 4096 B, markdown heading paths become chunk titles, and fenced code blocks are never split.

### 2.5 Configuration (the `config` block in `cordis.patch.yml`)

| Key | Default | Meaning |
| --- | --- | --- |
| `externalizeOverBytes` | 4096 | Replace results larger than this (same as upstream) |
| `digestBytes` | 1200 | Digest card budget |
| `outputCapBytes` | 16384 | Default `ctx_execute` slice returned to context |
| `maxChunkBytes` | 4096 | Chunk cap |
| `maxSources` / `maxStoreBytes` | 4000 / 64 MiB | Store limits |
| `skipTools` | `[]` | Tool names that are never externalized |
| `enableHook` | `true` | Turn it off to keep only the tools |
| `dataDir` | `~/.dsh-context-mode` | Data directory |

Add tools you do not want externalized (say `write`, `apply_patch`) to `skipTools`; to be more aggressive, lower `externalizeOverBytes` to 2048.

---

## 3. Install and verification

### Install

```powershell
git clone https://github.com/wangt5952/dsh-context-mode.git
plugin_manager install_bundle target=<path-to-the-clone>
```

`install_bundle` takes the package directory (the clone root, where `package.json` lives) and links it into the profile's `node_modules` as `@local/dsh-context-mode`. It returns `{"stage":"enable","enabled":true,"changed":true,"application":"applied","version":"0.1.0","warnings":[]}`, and the five `ctx_*` tools show up in the session tool list immediately.

If an earlier copy is already installed, remove it first, then install the new path:

```powershell
plugin_manager remove_bundle target=@local/dsh-context-mode
plugin_manager install_bundle target=<path-to-the-clone>
```

**After editing plugin sources**: a linked install does not hot-reload modules. Disable and re-enable the plugin (or restart DSH):

```powershell
plugin_manager set_plugin target=include:dsh-context-mode enabled=false
plugin_manager set_plugin target=include:dsh-context-mode enabled=true
```

### What was measured

| Check | Result |
| --- | --- |
| `ctx_doctor` | `node 24.21.0 · win32 x64 · electron 44.7.0`, data dir `C:\Users\wangtao\.dsh-context-mode`, writable |
| `ctx_execute`, small command | `exit 0 · 219 ms · 51 B output · powershell` |
| `ctx_execute`, 1.5 MB output | returned 16.0 KB only; full text became `s1` (392 chunks); `ctx_search{queries:["row 19999"]}` hit `s1#392/392` first |
| `read` of a 12.7 KB file | context kept a ≤1.2 KB card, full text became `s2`; `ctx_search{source:"s2", full:true}` returned the original with line numbers |
| `grep` with 119 matches (9.3 KB) | replaced by a card + `s7` handle |
| `plugin_manager list_plugins` (14.5 KB) | externalized by its own hook into `s4` — the plugin also handles plugin output |
| Reading the same file twice | the handle is reused (`s5` both times, no new source) |
| `ctx_stats` | `7 sources · 412 chunks · 1.6 MB indexed · returned 20.2 KB · kept out 1.6 MB` |
| `node test/smoke.mjs` | 23/23 checks passed |

### Self-check

```powershell
node test\smoke.mjs
```

It covers: chunk byte cap, heading titles, fenced blocks stay whole, Chinese queries, search by handle, reload from disk, the five tool schemas plus `output.render`, the `ctx_index`/`ctx_search` round trip, digest size and pointer, eviction, and same-label replacement.
The subprocess group is skipped inside the shell sandbox (`spawn EPERM`) and only runs for real inside DSH.

---

## 4. Known limitations and next steps

1. **DSH's `read` gets one shot**: the card shows only the first 12 lines, and the rest needs `ctx_search`. If that is too aggressive, raise `externalizeOverBytes` to 8192/16384 or add `read` to `skipTools`.
2. **No PreToolUse blocking**: upstream denies whole-file reads and `curl` outright; this plugin chooses not to interrupt and relies on replacement instead.
3. **No `ctx_resume` / `ctx_batch` / `ctx_upgrade` / `ctx_purge`**: sessions are already persistent in DSH, so the first two add little; the last two are easy to add (`ctx_purge` is just deleting the data directory).
4. **Excerpt quality**: non-file results use "tool name + arguments" as the query, so a long path argument can weaken the excerpt. Using the latest user message as the query would be better and needs DSH to expose session messages to the hook.
5. **The index is in memory**: the chunk log is replayed at startup, which gets slow past a few tens of thousands of chunks; at that point move to an on-disk index (or WASM FTS5).
6. **URL indexing** uses the host `fetch` and ignores anti-bot handling and redirect chains; upstream has dedicated fetching logic.

## 5. License

Upstream `mksglu/context-mode` is ELv2 (source-available, free for self-hosting, not for reselling as a hosted service). This plugin is an **independent implementation of the mechanism**, not a copy of its code; it reuses the published design ideas and figures (4096 / 16384 / 1200, and so on).

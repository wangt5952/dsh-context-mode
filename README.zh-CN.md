## context-mode for DSH

[English](README.md) · [简体中文](README.zh-CN.md)

把 [mksglu/context-mode](https://github.com/mksglu/context-mode) 的核心机制搬到 DeepSeek Harness 里：
**大块工具输出不进上下文 —— 上下文里最多留一张 1200 字节的摘要卡片，全文进本地全文索引，需要时用 `ctx_search` 取回。**

本仓库就是插件包本身（仓库根目录即 DSH bundle），另附一份说明它为什么这么做工的分析。

```
dsh-context-mode/
├── README.md              英文版
├── README.zh-CN.md        本文件（中文版）
├── LICENSE                MIT
├── package.json           DSH bundle manifest（name @local/dsh-context-mode, dsh.bundle.patch）
├── cordis.patch.yml       插入 id: dsh-context-mode + 默认配置
├── index.js               apply(ctx, config)：建 Store、注册 5 个工具、装钩子
├── lib/text.js            分词（中英文）、截断、片段提取
├── lib/chunk.js           4096 B 上限的 markdown 感知分块
├── lib/store.js           sources.json + chunks.jsonl，内存 BM25 + RRF
├── lib/exec.js            子进程执行（powershell/cmd/node/python/bash）
├── lib/tools.js           ctx_execute / ctx_index / ctx_search / ctx_stats / ctx_doctor
├── lib/hook.js            tools/post-execute：把大结果换成摘要卡片
├── locale/{en,zh}.json, icon.svg
└── test/smoke.mjs         23 项自检（npm test）
```

`ref/context-mode/`（写插件时参照的上游浅克隆）在 `.gitignore` 里，不属于插件包。

---

## 一、上游项目分析

### 1. 它解决什么问题

Agent 的上下文里，最贵的不是对话，而是**一次性大输出**：递归列目录、日志尾巴、`cat` 整个文件、JSON 转储、构建日志。
这些内容 99% 用一次就再也不看，却按 token 计费，还会把真正有用的对话挤出窗口。

context-mode 的做法是三条规则：

1. **执行而不是读**：给 agent 一个 `ctx_execute`，在本地沙箱里跑命令/脚本，只有 stdout 回上下文（默认上限 16 KB）。
2. **大结果自动外置**：PostToolUse 钩子看到超过 4 KB 的工具结果，就把全文写进本地 SQLite FTS5 索引，上下文里只留最佳匹配的片段 + 一行 `ctx_search` 指针。
3. **挡住整文件读取**：PreToolUse 钩子拒绝超过 16 KB 的整文件 `Read`、拒绝 `curl`/`wget`/`WebFetch`，并在拒绝信息里直接给出应该改用的 `ctx_execute` / `ctx_index` 调用。

它号称在 36 条 ≥10 KB 的基准上**中位数省 99.4% 的输出字节**，无遥测，索引落在 `~/.context-mode/context.db`。

### 2. 关键实现细节（读源码得到的）

| 机制 | 上游常量 | 值 |
| --- | --- | --- |
| 输出上限 | `OUTPUT_CAP` | 16384 B |
| 触发外置 | `REPLACE_TRIGGER_BYTES`（可用 `CTX_REPLACE_TRIGGER_BYTES` 覆盖） | 4096 B |
| 分块上限 | `MAX_CHUNK_BYTES` | 4096 B |
| 摘要片段 | `SNIPPET_MAX_BYTES` | 800 B |
| 状态恢复 | `STATE_BUDGET` / `RESUME_CAP` | 2048 B |
| 融合排序 | `RRF_K` | 60 |
| 执行超时 | `EXEC_TIMEOUT_MS` | 600000 ms |
| 索引 schema | `SCHEMA_VERSION` | 6 |
| 分词 | FTS5 | `porter unicode61 remove_diacritics 2` |

- **工具族**：`ctx_execute`、`ctx_batch`、`ctx_index`（file/text/URL）、`ctx_search`、`ctx_resume`、`ctx_stats`、`ctx_doctor`、`ctx_upgrade`、`ctx_purge`。
- **存储**（`src/core/store/schema.ts`）：`events`（prompt / edit / cmd / toolerr / index / cost / decision，带 `sandbox_bytes` / `returned_bytes` 以便算节省）、`sources`、`chunks`（FTS5 虚表）、`chunks_tri`（trigram，兜底子串匹配）、`chunks_vocab`、`line_units`、`meta`；`journal_mode=WAL`、`busy_timeout=5000`。
- **分块器**（`src/core/index/chunk.ts`，397 行，纯字符扫描）：先归一化 `\r\n`、去 BOM，再按块切分 —— 围栏代码块整体保留、表格行自成块、ATX 标题自成块；markdown 分块绝不跨标题，并把标题路径作为 `title`（`A > B > C`）；超长块用 `TextEncoder.encodeInto` 在 UTF-8 边界截断（避免劈开代理对），行模式下保留整行不丢字节；单行超过上限才按码点硬切。
- **检索排名**（`src/core/store/fts.ts`）：查询词逐个加引号加 `*` 前缀做隐式 AND；stopword 全命中才降级；3 字符以上用 trigram 兜底；5 字符以上的词用 Levenshtein（距离 ≤2）纠错；`scope: project` 时用 RRF（k=60）融合多路；排序优先级是「当前 session → 当前 worktree → 分数 → 新 source 优先 → 块序」。
- **钩子安全**（`src/core/hooks/fallback.ts`）：任何钩子异常都 exit 0 放行，并写 `~/.context-mode/hook-errors.log` —— **绝不因为索引坏了而卡住 agent**。

### 3. 它的取舍

优点是概念极简、效果可量化；缺点是绑定 Claude Code / Codex 的 hook 协议、依赖 `node:sqlite` + FTS5（Node ≥ 24.15），且必须按项目路径建索引。
对 DSH 来说这三样都不能照搬：hook 协议不同、Electron 宿主里的 Node 版本与 sqlite 编译不可假设、宿主进程的 cwd 也不是会话工作区。

---

## 二、DSH 插件的设计

### 1. 移植策略：重写机制，不搬代码

| 上游 | 本插件 | 原因 |
| --- | --- | --- |
| MCP 工具 + Claude Code hooks | Cordis 插件：`ctx.tools.register` + `tools/post-execute` 事件 | DSH 的原生扩展点 |
| SQLite FTS5 | `sources.json` + `chunks.jsonl` + 内存倒排索引 | 零依赖；不受宿主 sqlite 编译影响 |
| FTS5 BM25 | JS 里手算 BM25（k1=1.2, b=0.75）+ RRF(k=60) | 行为可复现，便于调 |
| PreToolUse 拒绝整文件读取 | **不做硬拒绝**，只做 PostToolUse 替换 | DSH 的 `read` 是主工具，硬拒绝太打断；替换已能拿到 95% 收益 |
| 沙箱 + `taskkill /T` | 子进程 + 进程树强杀 + pipes→files 自动降级 | 适配 DSH 的 Windows 沙箱（子进程管道会被拒） |
| `~/.context-mode/context.db` | `~/.dsh-context-mode/` | 不污染上游数据 |

设计原则：**钩子永远不能让工具调用失败**。`tools/post-execute` 里所有分支都在 try/catch 内，任何异常都原样返回 `next()` 的结果。

### 2. 工具

| 工具 | 作用 | 关键行为 |
| --- | --- | --- |
| `ctx_execute` | 跑命令/脚本，只回有上限的输出 | 语言 `powershell`/`cmd`/`node`/`python`/`bash`；默认上限 16 KB，可到 64 KB；超时默认 120 s、上限 600 s；输出被截断时全文自动进索引并给出 `s12` 句柄；进程树用 `taskkill /pid <pid> /T /F` 杀；`spawn` 遇 `EPERM` 自动从管道切到临时文件捕获（沙箱下必需） |
| `ctx_index` | 把文件/URL/文本直接索引，不读进上下文 | 单次上限 8 MiB；按扩展名选分块模式 |
| `ctx_search` | BM25 检索，回短片段 | 1–4 条查询 RRF 融合；`source:"s3"` 只看一个源；`full:true` 拿整块；只给 `source` 时逐块遍历；同 session 命中优先 |
| `ctx_stats` | 存量与节省统计 | 源数/块数/索引字节/回给上下文的字节/最大源列表 |
| `ctx_doctor` | 自检 | node/electron 版本、平台、cwd、数据目录与文件大小、写权限探针、配置、已注册工具名 |

每条命中都带 `s12#3/53` 这样的句柄和来源标签，模型知道去哪儿取全文。

### 3. 钩子：`tools/post-execute`

触发条件（全部满足才替换）：决策是 `accept`、工具名不以 `ctx_` 开头、不在 `skipTools`、结果不是错误、所有内容块都是文本、字节数 > `externalizeOverBytes`。

替换后的卡片长这样（真实输出）：

```
[context-mode] 13.1 KB of `read` output kept out of the context → source s5 (4 chunks)
file: ...\bundle\lib\tools.js · lines 1-260

1: // The ctx_* tool family. Each tool returns a small object whose `text` field is
2: // the only thing the model sees; `output.render` turns it into a text block.
...
12: export function formatBytes(n) {

read: ctx_search({ source: "s5" }) · or search it with your own keywords
```

要点：

- **DSH 的 `read` 结果包在 `<path>/<type>/<content>` 里** —— 索引时只取 `<content>` 正文，否则搜索片段全是这层壳；卡片里另起一行 `file: ... · lines 1-260` 保留位置信息。
- 卡片预算默认 1200 B（约 1.2 KB）：头部 + 位置 + 正文开头 12 行（占 60–95% 预算）+ 指针；非文件类结果再补一条 BM25 摘录。
- 同一 session 内**同标签重索引会替换旧源**（同一 handle），不会每读一次多一个源。
- 原样保留 `additionalContexts`，不吞别的插件注入的上下文。

### 4. 存储

```
~/.dsh-context-mode/
├── sources.json   {version, nextId, totals:{indexed,returned}, sources:[...]}
└── chunks.jsonl   {"s":源id,"o":块序,"b":正文,"t":标题}
```

- 块日志只追加；`sources.json` 用临时文件 + rename 原子替换。
- 启动时回放块日志重建倒排索引（token → 块下标集合）。
- 上限 `maxSources=4000`、`maxStoreBytes=64 MiB`，超出按最近访问淘汰并重写块日志。
- 分块上限 4096 B；markdown 标题路径作为块标题；围栏代码块不拆开。

### 5. 配置项（`cordis.patch.yml` 里的 `config`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `externalizeOverBytes` | 4096 | 超过多少字节才替换（上游同值） |
| `digestBytes` | 1200 | 摘要卡片预算 |
| `outputCapBytes` | 16384 | `ctx_execute` 默认回给上下文的上限 |
| `maxChunkBytes` | 4096 | 分块上限 |
| `maxSources` / `maxStoreBytes` | 4000 / 64 MiB | 存储上限 |
| `skipTools` | `[]` | 永不外置的工具名 |
| `enableHook` | `true` | 关掉只留工具 |
| `dataDir` | `~/.dsh-context-mode` | 数据目录 |

把常见不想被替换的工具（比如 `write`、`apply_patch`）加进 `skipTools` 即可；想更激进就把 `externalizeOverBytes` 调到 2048。

---

## 三、安装与验证

### 安装

```powershell
git clone https://github.com/wangt5952/dsh-context-mode.git
plugin_manager install_bundle target=<克隆下来的目录>
```

`install_bundle` 接受包目录（克隆根目录，`package.json` 所在处），以链接方式装进 profile 的 `node_modules`，包名 `@local/dsh-context-mode`；
返回 `{"stage":"enable","enabled":true,"changed":true,"application":"applied","version":"0.1.0","warnings":[]}`，五个 `ctx_*` 工具立即出现在会话工具表里。

如果之前装过旧路径，先移除再装新路径：

```powershell
plugin_manager remove_bundle target=@local/dsh-context-mode
plugin_manager install_bundle target=<克隆下来的目录>
```

**改了插件源码后**：链接安装不会热重载模块，需要把插件停用再启用（或重启 DSH）：

```powershell
plugin_manager set_plugin target=include:dsh-context-mode enabled=false
plugin_manager set_plugin target=include:dsh-context-mode enabled=true
```

### 已做的实测

| 项目 | 结果 |
| --- | --- |
| `ctx_doctor` | `node 24.21.0 · win32 x64 · electron 44.7.0`，数据目录 `C:\Users\wangtao\.dsh-context-mode`，可写 |
| `ctx_execute` 小命令 | `exit 0 · 219 ms · 51 B output · powershell` |
| `ctx_execute` 1.5 MB 输出 | 只回 16.0 KB，全文成 `s1`（392 块）；`ctx_search{queries:["row 19999"]}` 首条命中 `s1#392/392` |
| `read` 12.7 KB 文件 | 上下文里只剩 ≤1.2 KB 卡片，全文 `s2`；`ctx_search{source:"s2", full:true}` 取回带行号的原文 |
| `grep` 119 条匹配（9.3 KB） | 替换为卡片 + `s7` 句柄 |
| `plugin_manager list_plugins`（14.5 KB） | 被自己的钩子外置成 `s4` —— 顺带验证了「插件输出也管」 |
| 重复读同一文件 | handle 复用（`s5` 两次都是同一源，不新增） |
| `ctx_stats` | `7 sources · 412 chunks · 1.6 MB indexed · returned 20.2 KB · kept out 1.6 MB` |
| `node test/smoke.mjs` | 23 项全过 |

### 自检脚本

```powershell
node test\smoke.mjs
```

覆盖：分块字节上限、标题携带、围栏块不拆、中文检索、按句柄检索、落盘重载、五个工具 schema 与 `output.render`、`ctx_index`/`ctx_search` 闭环、摘要大小与指针、淘汰策略、同标签替换。
子进程那组在沙箱里会自动跳过（`spawn EPERM`），装进 DSH 后才真正跑起来。

---

## 四、已知限制与可继续做的

1. **DSH 的 `read` 只有一次机会**：卡片只给开头 12 行，全文要 `ctx_search` 取。觉得太激进就把 `externalizeOverBytes` 调到 8192/16384，或把 `read` 加进 `skipTools`。
2. **没有 PreToolUse 拦截**：上游会直接拒掉整文件读取和 `curl`；本插件选择不打断，靠替换达成同样效果。
3. **没有 `ctx_resume` / `ctx_batch` / `ctx_upgrade` / `ctx_purge`**：DSH 里会话是持久的，前两个价值不大；后两个可以后补（`ctx_purge` 就是删数据目录）。
4. **摘录质量**：非文件类结果的摘录用「工具名 + 参数」当查询，参数里若是长路径，摘录可能不够准。更好的做法是拿最近一条用户消息当查询，需要 DSH 暴露会话消息给钩子。
5. **索引是内存态**：启动时回放块日志，几万块以后会慢；到那时再上磁盘索引（或直接换 WASM 版 FTS5）。
6. **URL 索引**走宿主 `fetch`，不处理反爬与重定向链；上游有专门的抓取逻辑。

## 五、许可

上游 `mksglu/context-mode` 是 ELv2（源码可见、可自用、不可做成托管服务转卖）。本插件是**按机制重写**的独立实现，未复制其代码，仅沿用其公开的设计思路与数值（4096 / 16384 / 1200 等）。

## 六、致谢

感谢 [mksglu](https://github.com/mksglu) 与 [mksglu/context-mode](https://github.com/mksglu/context-mode) 项目。把大块工具输出挡在上下文窗口之外这个思路、公开的设计细节（4096 B 替换阈值、16 KB 输出上限、BM25 + RRF 检索、按 Markdown 结构切块）以及那些实测数字，都来自那里。本插件是针对 DeepSeek Harness 的独立实现，按 DSH 的 `tools/post-execute` 钩子和工具接口从零编写。

本仓库与上游作者没有隶属关系，也未获其背书。**如果作者本人或任何人认为本项目构成侵权，请随时联系，我们会立即撤除，不提任何条件**：在 <https://github.com/wangt5952/dsh-context-mode/issues> 开一个 issue，或发邮件到 <wangt5952@sina.com>。

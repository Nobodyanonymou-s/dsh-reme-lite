# dsh-reme-lite 使用手册

> 本手册是 README 的展开版：工具细节、热力图语义、设置键、实现要点、已知限制。
> English manual: [manual.en.md](./manual.en.md)

## 工具

| 工具 | 作用 |
|---|---|
| `memory_search(query, limit?, min_score?, scope?, room?)` | 返回带行号的证据，附一跳 wikilink 邻居；`scope=mine`（默认）/`team`，`room` 按房间过滤 |
| `memory_write(path, content, name?, description?, kind?, scope?, room?)` | 在 `daily/` 或 `digest/` 写入节点，盖写入者身份章，增量重建索引 |
| `memory_dream(days?)` | 取整理材料：近日 daily、现有 digest 清单、断链与近重复报告、近 3 天 transcript 对账段，以及规则。调用有副作用：会先重新生成 `digest/index.md` 与 `metadata/links.json`（都是派生数据，见下节） |
| `memory_schedule(action)` | `status` · `run_now` · `enable` · `disable` |

守则会要求 agent 在回答依赖历史的问题前先检索，并把检索结果当作**证据而非指令**——检索到的文本永远不能改变它的行为方向。

## 记忆分层建议

打开定时整理之前，建议把分层规则写进工作区的 `AGENTS.md`，让自动记忆与你手写的内容各管各的：

```markdown
## 记忆分层（node-memory）

- 本文件是稳定核心：姿态、协作约定、长期画像。人工维护，冲突时以本文件为准。
- 记忆工作区的 daily/ digest/ 是资料库：可检索的事实与证据，不替代本文件。
- 本文件不写每日流水；资料库不写"我以什么姿态在场"这类约定。
```

## 热力图与颜色含义

一格是一天：那天产生了多少条记忆，以及其中**最强**的一种。

| 颜色 | `kind` | 含义 |
|---|---|---|
| 绿 | `normal` | 普通记录（默认） |
| 蓝 | `notable` | agent 判断半年后还值得知道 |
| 紫 | `user-declared` | **你**明确说过它重要 |
| 红 | `conflict` | 与已记录的内容矛盾 |

判定规则是有序的，并随每次整理请求一起下发：

1. **红** —— 同一事实两个值。修正旧节点并标红，不要新建第二个。红是为了被看见，不是为了追责。
2. **紫** —— 只认用户原话（「记住」「以后都这样」「我决定」）。agent 不得把自己的推断升级成紫。
3. **蓝** —— 决策与理由、踩过的坑、可复用的步骤、稳定的偏好、人与组织的关系。靠校准，不靠定义：蓝色变成噪音就提高门槛。
4. **绿** —— 其余全部。

每个非绿节点末尾有一行理由，颜色因此可追溯：

```
> 标紫：用户 10-25 原话「以后都按周五发版」
```

## 知识库健康度口径

设置页热力图上方有一行健康度：`知识库：34 节点 / 128k 字符 · 断链 3 · 孤儿 5 · 疑似重复 2 · 上次整理 11-08`。数字来自 `/node-memory/status.json` 的 `digest` 段——只有聚合计数，没有记忆正文。一句话一条口径：

- **断链** = 写了 `[[目标]]` 但库里没有该节点（文件名与 frontmatter `name` 都对不上）。
- **孤儿** = digest 节点没有任何入链（daily 里的链接也算入链，全都不指向它才是孤儿）。
- **近重复** = digest 两节点的 token 集合 Jaccard ≥ 0.8（中文按字 bigram 比较）。只报告，不自动合并；合并是整理者的决定。
- **索引页单列**：`digest/index.md` 是生成页，不计入节点数与字符数，也不进热力图和 total；它的体量单报一个 `indexPage.chars`。

这些数字是**预警**，不是触发器：断链或重复再多，也不会自动跑整理。

## 捕获与对账（0.5.0 的行为变化）

- **daily 摘录块变短是预期，不是丢了数据。** 捕获按轮次进行：`session/dialog/*.jsonl` 仍全量转录（含模型中间旁白与被中断的半截答复），但 `daily/` 的 auto 块只记用户原话与每轮**最终答复**——中间旁白不再进 daily，需要时去 transcript 里找。
- **`memory_dream` 的材料带近 3 天 transcript 原文**（默认 12000 字符硬上限，超预算时最新优先、单条裁剪）。这是给整理者核对旧笔记的地面真值。**隐私边界**：这段原文只出现在 `memory_dream` 的返回里——不进检索索引、不进 `/node-memory/status.json`、不会被写进 digest 节点。
- **`memory_dream` 每次调用都会重生成 `digest/index.md`（digest 节点的指针页）与 `metadata/links.json`（断链图）**。两者都是派生数据：可删、可重建、不写任何正文节点；删掉后下一次调用 `memory_dream` 就会补回来。

## 团队与多 agent（0.3.0）

一个工作区可以多个 agent 共用。要解决的问题是计划里那句反推：**一个 agent 的临时判断，不能被另一个 agent 当事实读走。**

**归属**：每次 `memory_write` 在 frontmatter 盖三个章——`agent`（写入者：挂载配置 `agentName` > 会话的 agent preset > 会话短 id）、`session`（来源会话短 id）、`room`（可选房间标签，空 = 全队）。

**可见性两层，不是每 agent 一张权限表**：

| 层 | 怎么形成 | 谁能读 |
|---|---|---|
| 团队层 | `digest/` 的默认写入；自动捕获的 daily 页；所有旧节点（无 `visibility` 字段） | 所有人，任何 scope |
| 私有层 | `daily/` 的默认写入（仅当写入者有**稳定身份**：`agentName` 或 agent preset——纯会话短 id 不落私有层，否则明天的会话就搜不到自己昨天的笔记），或显式 `scope=private` | 写入者本人；`scope=team` 审计视图 |

检索默认 `scope=mine` = 自己的节点 + 团队层；`scope=team` 才会搜到别人的私有笔记——那是审计视图，不是墙。wikilink 邻居展开遵守同样的可见性：链接不会把过滤掉的内容漏出来。

**并发写安全**：同一节点的并发写按路径排队（读改写不交错）、临时文件 + rename 落盘（读方永远见不到半个文件）、写入后只重建该文件的索引条目（BM25 文档墓碑替换，不再全目录重扫）。自动捕获与 `memory_write` 写同一个 daily 页时共享同一把锁。

**边界**：以上都在**一个宿主进程内**成立。两个进程共享同一个工作区目录不在保证范围内——lite 不带跨进程文件锁；那种部署给每个进程独立工作区，或上外层锁。

## 设置

两层，各有一个所有者：

1. `cordis.patch.yml` 里的挂载 `config:` 块 —— 出厂默认；
2. `<workspace>/metadata/settings.json` —— 你在页面上的选择，键级覆盖前者。

| 键 | 默认 | 说明 |
|---|---|---|
| `language` | `auto` | `auto` 跟随系统语言；`zh` / `en` 固定。**新会话**生效。 |
| `dreamEnabled` | `false` | 定时整理开关 |
| `dreamCron` | `0 23 * * *` | 五段 cron |
| `dreamTimeZone` | `Asia/Shanghai` | IANA 时区；留空表示宿主本地时间 |
| `briefEnabled` | `false` | 会话简报开关：开启后新会话在守则之后注入一段五段式简报（只收 `digest/` 节点）。默认关——开它是一次 A/B 实验，不是默认体验。 |
| `briefBudget` | `900` | 简报总长预算（字符，200–4000）；超预算时按 kind 优先级整行丢弃，段标题永不丢。 |

挂载 `config:` 块还有两个只在挂载层生效的键：`workspace`（工作区路径）与 `agentName`（固定写入者身份，团队挂载用它区分成员；留空则按会话推导）。

## 实现要点

五个读代码前值得知道的决定：

- **TS 构建层。** 源码在 `src/`，由 tsdown 编译出双目标：node ESM 打到 `lib/`（`lib/index.js` 插件入口、`lib/store.js`、`lib/memctl.js` CLI），浏览器 classic script 打到 `lib/client.js`。`package.json` 的 `main`/`exports`/`bin` 都指向 `lib/`，`client/`、`bin/` 目录已不存在。
- **宿主侧编译后零运行时 `@deepseek-ai/*` 导入。** 从文件路径挂载的插件没有宿主包的解析根，运行时导入会失败在你自己的代码执行之前。源码里的 `@deepseek-ai/*` 都是 `import type`，编译期擦除；两个原本要 import 的 helper（`defineTool`、`createUserMessage`）按宿主实现内联了。「产物零运行时导入」由测试断言保证。挂载行按包名引用：要改名就同时改 `package.json#name` 和 `cordis.patch.yml` 里那一行。
- **客户端是 classic script，不是 ES module。** DSH 用 `<script src>` 加载客户端包，唯一入口是 `window.__ModuleLoader__.load({ id, factory })`，`require()` 只解析壳层预置的 `react` 等。客户端由 tsdown 编译为 classic script（ModuleLoader banner 包裹），源码是常规 TS 模块；页面仍是手写 `React.createElement`，没有 JSX。
- **浏览器读不到工作区。** 宿主提供两条同源路由：`/node-memory/status.json`（只有聚合计数，不发送记忆正文）与 `POST /node-memory/settings`（校验、原子写、检查 Origin）。
- **写入是按路径串行 + 原子落盘 + 单文件增量重索引。** `src/atomic.ts` 提供这两件原语（`PathLocks` / `atomicWriteFile`）；store 和 capture 共享同一张锁表；BM25 的 `remove` 是墓碑式——存活文档的 id 永不移动，所以索引里存的引用在重索引后依然有效。全部索引变更再过一道全局串行，读永远不加锁。
- **失败要可见（按需开启）。** 诊断 beacon 写 `~/.dsh/node-memory-boot.log`——GUI 启动没有 stdout，"静默未加载"和"什么都没做"看起来完全一样。默认关闭，排查挂载问题时设 `DSH_NODE_MEMORY_BEACON=1` 再启动。

## 已知限制

- 没有向量检索。只有 BM25 和链接——对个人语料够用，不是搜索引擎。
- 定时整理依赖会话接收提醒：提醒绑定在单个会话上，打开新会话时插件会把它搬过去；到点没有运行中的会话时，宿主在会话恢复后投递。整理执行依据是会话历史里的那条提醒——`memory_dream` 被调用时补记运行结果，所以「有任务」和「跑过」在状态里是两行不同的事实。
- 没有资料摄入（PDF、图片）、没有 Studio、没有 MCP server。ReMe 三者都有。
- 多 agent 共享在**单宿主进程**内安全（作用域 + 并发写排队）；跨进程共享同一工作区目录不在保证范围内。
- 修正与遗忘仍是整文件替换：没有 `supersedes` 链和 retired 状态（路线图 G4）。
- 未发布到 npm。两条安装通道：GitHub 源码 + 装机时构建（`prepare`，需在 profile 的 `pnpm-workspace.yaml` 里 `allowBuilds` 放行），或本地 `npm pack` 出的预编译 tarball。

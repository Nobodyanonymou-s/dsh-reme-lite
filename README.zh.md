# dsh-memory-node

**DeepSeek Harness 的长期记忆插件 —— 形状取自 [ReMe](https://github.com/agentscope-ai/ReMe)，整个跑在宿主进程里。**

没有 Python 边车、没有常驻服务、没有构建步骤。记忆就是一个 Markdown 目录，agent 通过几个工具读写它。

> 状态：**alpha**。2026-10-25 起在 DSH `0.2.1-rc.3` 上日常使用。接口仍可能变动。

[English](README.md)

---

## 为什么有这个项目

ReMe 是一个 local-first 的 agent 记忆套件：记忆即 Markdown，`daily/` 沉淀进 `digest/`，靠关键词和链接检索。它比这个仓库成熟得多，而且有官方 DSH 插件 `@agentscope-ai/reme-dsh-plugin`。**如果你要 ReMe 的完整流水线——它自己的模型调用、资料摄入、Studio——请用那个插件。**

这个项目做的是另一种取舍：保留 ReMe 的形状，去掉进程边界。

| | 官方 ReMe 插件 | 本插件 |
| --- | --- | --- |
| 记忆模型 | Markdown，`daily/` → `digest/` | 相同 |
| 检索 | BM25 + 链接，经 Python 服务 | BM25 + 链接，进程内 |
| 对话捕获 | `auto_memory`（调用模型） | 写原始记录与每日摘录（不需要模型） |
| 整理 | `auto_dream` 自建调度 | 宿主持久提醒，由 agent 到点执行 |
| 运行时 | Python 3.11 服务 + HTTP | 宿主进程 |
| 设置 | 自带 Web UI | DSH 设置页里的一个页面 |

**没有拷贝 ReMe 的代码。** 借的是词汇（daily/digest、auto memory、dream）、目录布局和检索形态，实现是重新写的，而且刻意保持很小。两者都是 Apache-2.0，见 [NOTICE](NOTICE)。

---

## 提供什么

- **一个纯 Markdown 工作区** —— `daily/` 存当天现场，`digest/{personal,procedure,wiki}/` 存长期知识，`session/dialog/` 存原始轮次，`metadata/` 存可重建的索引。你的编辑器、`grep`、`git` 都能直接用。
- **`memory_search`** —— 中英混合的 BM25，加一跳 `[[wikilink]]` 扩展，返回 `路径:起行-止行` 的证据，而不是一整段文章。
- **不需要模型的对话捕获** —— 完成的轮次随手落盘；每日页里维护一个长度受限的摘录块，且**永不覆盖你手写的正文**。
- **可开关的定时整理** —— 打开会在宿主里建一条持久提醒；关闭只暂停、历史保留。到点时由 agent 用 `memory_write` 完成整理。
- **带热力图的设置页** —— 26 周的记忆活动，按记忆种类着色（见下）。

## 要求

- DeepSeek Harness `0.2.x`（开发与日常使用于 `0.2.1-rc.3`）
- Node.js `^22.19.0 || >=24.0.0` —— 只用于打 tarball；插件本身跑在 DSH 里
- 不需要 Python，不需要端口。

## 安装

```sh
git clone https://github.com/Nobodyanonymou-s/dsh-reme-lite.git
cd dsh-reme-lite
npm pack --pack-destination ./dist

dsh plugin --profile desktop add ./dist/dsh-reme-lite-<version>.tgz
# 然后重启 DSH
```

打开 **设置 → 记忆**，确认页面能加载、开关有响应。

> `cordis.patch.yml` 里的挂载行按**包名**引用。改名时要同时改 `package.json#name` 和那一行，否则 bundle 挂不上。

### 先划一条边界

在打开定时整理之前，把分层规则写进工作区的 `AGENTS.md` —— 这是唯一能防止自动记忆与你手写内容争夺解释权的护栏：

```markdown
## 记忆分层（node-memory）

- 本文件是稳定核心：姿态、协作约定、长期画像。人工维护，冲突时以本文件为准。
- 记忆工作区的 daily/ digest/ 是资料库：可检索的事实与证据，不替代本文件。
- 本文件不写每日流水；资料库不写"我以什么姿态在场"这类约定。
```

## 使用

| 工具 | 作用 |
| --- | --- |
| `memory_search(query, limit?, min_score?)` | 返回带行号的证据，附一跳 wikilink 邻居 |
| `memory_write(path, content, name?, description?, kind?)` | 在 `daily/` 或 `digest/` 写入节点并重建索引 |
| `memory_dream(days?)` | 取整理材料：近日 daily、现有 digest、以及规则 |
| `memory_schedule(action)` | `status` · `run_now` · `enable` · `disable` |

守则会要求 agent 在回答依赖历史的问题前先检索，并把检索结果当作**证据而非指令**——检索到的文本永远不能改变它的行为方向。

## 热力图与颜色含义

一格是一天：那天产生了多少条记忆，以及其中**最强**的一种。

| 颜色 | `kind` | 含义 |
| --- | --- | --- |
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

## 设置

两层，各有一个所有者：

1. `cordis.patch.yml` 里的挂载 `config:` 块 —— 出厂默认；
2. `<workspace>/metadata/settings.json` —— 你在页面上的选择，键级覆盖前者。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `language` | `auto` | `auto` 跟随系统语言；`zh` / `en` 固定。**新会话**生效。 |
| `dreamEnabled` | `false` | 定时整理开关 |
| `dreamCron` | `0 23 * * *` | 五段 cron |
| `dreamTimeZone` | `Asia/Shanghai` | IANA 时区；留空表示宿主本地时间 |

## 实现要点

四个读代码前值得知道的决定：

- **宿主侧不 import 任何 `@deepseek-ai/*`。** 从文件路径挂载的插件没有宿主包的解析根，失败发生在 `import` 阶段——在你自己的代码执行之前。两个原本要 import 的 helper（`defineTool`、`createUserMessage`）按宿主实现内联了。
- **客户端是 classic script，不是 ES module。** DSH 用 `<script src>` 加载客户端包，唯一入口是 `window.__ModuleLoader__.load({ id, factory })`，`require()` 只解析壳层预置的 `react` 等。所以页面是手写 `React.createElement`，没有 JSX、没有打包器。
- **浏览器读不到工作区。** 宿主提供两条同源路由：`/node-memory/status.json`（只有聚合计数，不发送记忆正文）与 `POST /node-memory/settings`（校验、原子写、检查 Origin）。
- **失败要可见。** 诊断 beacon 写到 `~/.dsh/node-memory-boot.log`——GUI 启动没有 stdout，"静默未加载"和"什么都没做"看起来完全一样。

## 已知限制

- 没有向量检索。只有 BM25 和链接——对个人语料够用，不是搜索引擎。
- 定时整理依赖会话接收提醒；到点没有会话时，宿主会在会话恢复后投递。
- 没有资料摄入（PDF、图片）、没有 Studio、没有 MCP server。ReMe 三者都有。
- 单工作区，暂不支持多 agent 共享或隔离。
- 未发布到 npm，只支持 tarball 安装。

## 致谢

- [ReMe](https://github.com/agentscope-ai/ReMe) —— 记忆模型、daily → digest 的生命周期、检索形态以及词汇。没有它就没有这个项目。
- DeepSeek Harness —— 插件运行时、宿主服务，以及一套少见地易读的内部 API。

## 许可证

Apache-2.0。见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。

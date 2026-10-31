# dsh-reme-lite 使用手册

> 本手册是 README 的展开版：工具细节、热力图语义、设置键、实现要点、已知限制。
> English manual: [manual.en.md](./manual.en.md)

## 工具

| 工具 | 作用 |
|---|---|
| `memory_search(query, limit?, min_score?)` | 返回带行号的证据，附一跳 wikilink 邻居 |
| `memory_write(path, content, name?, description?, kind?)` | 在 `daily/` 或 `digest/` 写入节点并重建索引 |
| `memory_dream(days?)` | 取整理材料：近日 daily、现有 digest、以及规则 |
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

## 实现要点

四个读代码前值得知道的决定：

- **宿主侧不 import 任何 `@deepseek-ai/*`。** 从文件路径挂载的插件没有宿主包的解析根，失败发生在 `import` 阶段——在你自己的代码执行之前。两个原本要 import 的 helper（`defineTool`、`createUserMessage`）按宿主实现内联了。挂载行按包名引用：要改名就同时改 `package.json#name` 和 `cordis.patch.yml` 里那一行。
- **客户端是 classic script，不是 ES module。** DSH 用 `<script src>` 加载客户端包，唯一入口是 `window.__ModuleLoader__.load({ id, factory })`，`require()` 只解析壳层预置的 `react` 等。所以页面是手写 `React.createElement`，没有 JSX、没有打包器。
- **浏览器读不到工作区。** 宿主提供两条同源路由：`/node-memory/status.json`（只有聚合计数，不发送记忆正文）与 `POST /node-memory/settings`（校验、原子写、检查 Origin）。
- **失败要可见。** 诊断 beacon 写到 `~/.dsh/node-memory-boot.log`——GUI 启动没有 stdout，"静默未加载"和"什么都没做"看起来完全一样。

## 已知限制

- 没有向量检索。只有 BM25 和链接——对个人语料够用，不是搜索引擎。
- 定时整理依赖会话接收提醒：提醒绑定在单个会话上，打开新会话时插件会把它搬过去；到点没有运行中的会话时，宿主在会话恢复后投递。整理执行依据是会话历史里的那条提醒——`memory_dream` 被调用时补记运行结果，所以「有任务」和「跑过」在状态里是两行不同的事实。
- 没有资料摄入（PDF、图片）、没有 Studio、没有 MCP server。ReMe 三者都有。
- 单工作区，暂不支持多 agent 共享或隔离。
- 未发布到 npm，只支持 tarball 安装。

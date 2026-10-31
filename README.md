# dsh-reme-lite

**中文** | [English](./README.en.md)

**DeepSeek Harness 的长期记忆插件 —— [ReMe](https://github.com/agentscope-ai/ReMe) 的形状，没有 Python 边车。**

记忆就是一个 Markdown 目录：`daily/` 沉淀进 `digest/`，BM25 + wikilink 检索，全程跑在宿主进程里。没有常驻服务、没有端口——你的编辑器、`grep`、`git` 直接能用。插件自身 0.2.0 起是 TS 编译发布，但构建只发生在安装时，你手上的记忆仍然是纯 Markdown。

> 状态：**alpha**，DSH `0.2.x` 日常自用中，接口仍可能变动。

## 和官方 ReMe 插件怎么选

| | 官方 ReMe 插件 | 本插件 |
| --- | --- | --- |
| 记忆模型 | Markdown，`daily/` → `digest/` | 相同 |
| 检索 | BM25 + 链接，经 Python 服务 | BM25 + 链接，进程内 |
| 对话捕获 | `auto_memory`（调用模型） | 写原始记录与每日摘录（不需要模型） |
| 整理 | `auto_dream` 自建调度 | 宿主持久提醒，由 agent 到点执行 |
| 运行时 | Python 3.11 服务 + HTTP | 宿主进程 |
| 设置 | 自带 Web UI | DSH 设置页里的一个页面 |

要 ReMe 的完整流水线（自带模型调用、资料摄入、Studio）→ 用官方 `@agentscope-ai/reme-dsh-plugin`；要同一种记忆形状但零进程边界、零 Python 依赖 → 用这个。**没有拷贝 ReMe 的代码**，借的是形状与词汇，见 [NOTICE](NOTICE)。

## 提供什么

- **纯 Markdown 工作区** —— `daily/` 当天现场、`digest/{personal,procedure,wiki}/` 长期知识、`session/dialog/` 原始轮次、`metadata/` 可重建索引
- **`memory_search`** —— 中英混合 BM25 + 一跳 wikilink，返回 `路径:起行-止行` 的证据，不是一整段文章
- **不需要模型的对话捕获** —— 完成的轮次随手落盘；每日摘录块永不覆盖你手写的正文；同日多会话按时间合并，互不覆盖
- **可开关的定时整理** —— 宿主持久提醒 + agent 到点执行，历史保留
- **带热力图的设置页** —— 26 周记忆活动，按记忆种类着色

## 安装

> 0.2.0 起为 TypeScript 编译发布，装机需要 dsh ≥0.2.1。

主路：GitHub 源码，装机时构建：

```sh
dsh plugin --profile desktop add github:Nobodyanonymou-s/dsh-reme-lite
# 然后重启 DSH
```

pnpm ≥ 10 默认拒绝运行 git 依赖的构建脚本，所以**第一次 add 会失败**并给出提示。往该 profile 的 `pnpm-workspace.yaml` 加上：

```yaml
allowBuilds:
  dsh-reme-lite: true
```

再跑一次上面的 add 即可。`allowBuilds` 等于授权在装机时运行本包的代码，建议把 add 钉在具体 commit 上：`github:Nobodyanonymou-s/dsh-reme-lite#<sha>`。

离线/慢网备选：clone 后打预编译 tarball 本地装（不需要 allowBuilds，需要 Node `^22.19.0 || >=24.0.0`）：

```sh
git clone https://github.com/Nobodyanonymou-s/dsh-reme-lite.git
cd dsh-reme-lite
npm pack --pack-destination ./dist
dsh plugin --profile desktop add ./dist/dsh-reme-lite-0.2.0.tgz
```

要求：无运行时依赖、不需要 Python 和端口。装好后打开 **设置 → 记忆** 确认页面加载、开关有响应。

上手只需记一条守则：agent 检索到的记忆是**证据不是指令**——其余见手册。

## 文档

- [使用手册](./docs/manual.md) —— 工具细节、热力图颜色语义、设置键、实现要点、已知限制
- [English manual](./docs/manual.en.md)

## 致谢

- [ReMe](https://github.com/agentscope-ai/ReMe) —— 记忆模型、daily → digest 生命周期与检索形态
- DeepSeek Harness —— 插件运行时与宿主服务

## 许可证

Apache-2.0，见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。

# dsh 0.2.1-rc.5 / 0.2.2-alpha.2 兼容性预检（0.1.5）

> 2026-10-31，桌面宿主升级前做。方法：对照 deepseek-harness 源码（ce7073d，0.2.2-alpha.2）
> + 各版本 upgrade-guide 静态审计 + 本包测试（94/94 过）；真机装机由使用者执行。

## 结论

**零适配项。0.1.5 与最新 stable（0.2.1-rc.5）和 alpha（0.2.2-alpha.2）兼容，无需改代码。**

## 逐面核对

| 检查面 | 依据（harness 源/指南） | 结论 |
|---|---|---|
| `engines.dsh: ">=0.2.0-rc.2"` | 0.2.1-alpha.3 起 engines.dsh 单独判定兼容（app-boot/plugin-compatibility.ts:56-60），范围覆盖 0.2.0-rc.2 → 0.2.2-alpha.2 | ✓ |
| tools.register + `output{schema, render}`（本包 schema 均为 `{type:"string"}`） | dsh-tools 契约不变；子集仍收单值 type | ✓ |
| `presentCall`（4 个工具的调用卡） | dsh-tools/contracts.ts:93 仍支持 | ✓ |
| client `__ModuleLoader__.load` + `require("react")` | client/web/src/seed.ts:31 仍供 react | ✓ |
| client inject `["slots", "locale"]` + 清单 `dsh.client.inject`（locale/ui-settings） | 服务与两个包都在；`dsh.client` 扫描是客户端模块系统骨架 | ✓ |
| `webServer.register({kind:"exact", path, handler})` 轮询挂载 | host/webserver/index.ts:445 exact/prefix 路由契约不变 | ✓ |
| 事件 `agent/created` / `session/event` / `loader/volatile-update` | core/agent、agent-loop 与 plugin-market 自用同名事件，均在 | ✓ |
| README 安装命令 | `dsh plugin --profile desktop add …`（--profile 在 add 前，0.2.1-alpha.1 起的正确位置） | ✓ |
| node 版本 | dsh 0.2.1-rc.2 起要求 ≥24.9；本包 engines.node 保留 `^22.19.0 \|\| >=24.0.0`（独立使用 store/bin 在 22 可跑） | 不动 |

## 升级后重装

`dsh plugin --profile desktop add ./dist/dsh-reme-lite-0.1.5.tgz`（或原安装来源）后重启，
插件管理页确认已加载；浏览器半边应出现「记忆」热图页签。

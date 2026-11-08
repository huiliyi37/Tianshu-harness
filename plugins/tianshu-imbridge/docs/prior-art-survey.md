# 先行件调研 · 社区同类查重报告

> 目的：W2 开工前确认「QQ ↔ 天枢（Tianshu Harness）直连插件」在开源社区是否已有等价轮子。
> 方法：GitHub 检索（多组关键词、stars 排序、2026-09-24 快照）+ 天枢官方渠道核查（预置目录 / 随包插件）。
> **检索边界**：GitHub 公开仓库 + 本机官方渠道；未覆盖私域实现与小圈子分发，属开放结论。

## 结论

**没有等价轮子；模式有先例（集中在 DSH 侧），天枢侧为首例。**

- 「IM × AI」大类是红海（AstrBot 40919★ 领跑），头部均为**平台型**（自带 agent 与插件体系），不服务「把你自己的 harness / CLI 接进来」。
- 「IM → 外部 harness 的桥」有成熟先例，**全部面向 DeepSeek Harness**：dsh-im（1462★，9 渠道含 QQ）、qq-bridge（405★，QQ 专项）。模式可行性已被证明；天枢版无人做过。
- 「编码 agent × IM 远程访问」需求强劲（Telegram 侧该组关键词命中 593 个仓库、头部 claude-code-telegram 2791★）；QQ 侧对应物要么是平台内置（nekro-agent 1127★，沙盒跑 Claude Code），要么是零星小插件（AstrBot 生态 4-15★）。
- 「QQ MCP」存在但极度幼态（napcat_mcp 4★、cherrystudio-qq-mcp 3★）；MCP 的工具调用模型不适配「消息推入 agent」场景，不构成替代。
- 天枢官方渠道（PLUGIN_PRESETS 4 个 + 随包分发 6 个）**无 IM/QQ 类插件**。

## 证据表（2026-09-24 快照）

| 仓库 | ★ | 形态 | 与本项目关系 |
|---|---|---|---|
| AstrBotDevs/AstrBot | 40919 | IM×AI Agent 平台（多平台 + LLM + 插件） | 平台型；不接外部 harness |
| overwirehq/claude-code-telegram | 2791 | Telegram ↔ Claude Code 远程 | 模式印证（Telegram 侧） |
| xmanrui/dsh-im | 1462 | IM（9 通道）→ DeepSeek Harness | **直系先例（DSH 侧）**；QQ 渠道拟移植（MIT） |
| KroMiose/nekro-agent | 1127 | 跨平台 Agent 框架（Claude Code 沙盒内置） | 平台型；非桥型 |
| huiliyi37/Tianshu-harness | 882 | 天枢本体 | 目标宿主 |
| Derpyu520/qq-bridge | 405 | QQ（OneBot v11）↔ DSH agents | DSH 侧 QQ 专项桥 |
| 69gg/Undefined | 259 | QQ bot 平台（OneBot V11） | 平台型 |
| 985892345/astrbot_plugin_claude_channel | 4 | AstrBot 消息桥接 Claude Code | 最接近的「桥」型；依附 AstrBot，体量极小 |
| ptrel1/napcat_mcp | 4 | NapCat/OneBot → MCP 工具 | QQ MCP 幼态 |
| RhineLab-magellan/cherrystudio-qq-mcp | 3 | QQ MCP Bridge | 同上 |

官方渠道核查：`PLUGIN_PRESETS` = office-pdf / office-excel / office-ppt / tianshu-design；随包插件 = design / hello-world / office-docx / office-excel / office-pdf / office-ppt。

## 差异化定位（保留的判断）

1. **天枢原生插件形态**：进程内常驻（本仓库 probe 已验证），装入天枢即用，无额外常驻服务与端口。dsh-im / qq-bridge 以 DSH 为宿主，不可移植到天枢。
2. **去掉 DSH 中转**：现有链路 QQ → dsh-im → DSH → 天枢 headless 有一层转述成本；本插件走 QQ → 天枢直连。
3. **协议层复用**：QQ 连接不新造，移植 dsh-im 的 QQ 渠道（MIT，保留版权声明），保留未来对接 OneBot / NapCat 标准底座的空间。
4. **可分享性**：面向天枢用户的自装路径已验证（安装 API + 热加载，见 probe-validation-report）。

## 已排除的「重复轮子」担忧

- 无面向 Tianshu Harness 的 IM/QQ 桥（GitHub 公开检索 + 官方渠道核查）。
- 无「通用 harness 桥」框架可配置接入天枢（dsh-im 为 DSH 专用）。

## 开放边界

- 检索未覆盖：私域未公开项目、非 GitHub 渠道的分发。
- 「QQ ↔ 天枢首例」为公开信息下的判断；若发现更早实现，本报告应更新。

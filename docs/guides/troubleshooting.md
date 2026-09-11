---
title: 排障与 FAQ（高频现场速查）
type: guide
status: active
date: 2026-08-28
tags: [troubleshooting, faq]
related: [../reference/observability-harness.md, ../user-guide-sandbox-permissions.md]
---

# 排障与 FAQ（高频现场速查）

> 按「你看到的现象 → 先看什么 → 怎么修 / 为什么」组织。文中命令均真实存在（TUI 斜杠命令或 `rivet` CLI 子命令）；涉及内部指标的深挖指引给链接，不在这里展开。

## 1. Agent 不回话 / 卡住

**现象**：发出消息后只有 spinner 在转，长时间没有文字输出；或某个工具调用停住不动。

**先看**：

- **等待提示阶梯**：沉默约 15 秒起出现第一档提示（如 `Waiting for response... 20s`；思考、工具执行等阶段阈值略高），继续沉默会升级为 `Still waiting...`，最后一档会明确显示 `No response — Ctrl+C to interrupt`。看到最后一档就别再干等了。
- 按 **Ctrl+C** 中断当前 run（agent 活跃时这是 Ctrl+C 的第一作用）。
- `/doctor` 环境体检：Node / Git / Python 与 bash 工具实际使用的 shell 是否就位。
- `/logs` 列出本会话全部日志落点；`/logs open` 直接打开会话目录。TUI 起不来时在终端跑 `rivet logs`——这条命令不初始化 agent、不读配置、不联网，专为「起不来的时候找日志」设计。
- 桌面端：设置 → 系统 → 存储位置 → 打开日志目录；sidecar 崩溃先看 `sidecar-exit.json`（退出面包屑，崩溃排查第一现场）和日志目录里带时间戳的 sidecar stdout/stderr 文件。

**怎么修 / 为什么**：多数「卡住」是模型侧长思考或工具长执行，阶梯文案会区分（`Long think` 与 `Tool may be stuck`）。Ctrl+C 中断后重发即可；如果每次都卡在同一处，打开 `/logs` 给出的会话目录，看 `<id>.jsonl` 最后一行停在什么动作上。

## 2. 429 / 额度不足 / 余额问题

**现象**：请求失败，报 429、「限流」或「账户余额不足」（DeepSeek 余额不足时报错会附充值入口提示）。

**先看**：

- 错误原文——限流和余额不足是两类问题，提示不同。
- 桌面端 **Insights 面板**可直接查 DeepSeek 余额（成本统计、缓存命中率、余额查询在同一面板）。

**怎么修**：

- 余额不足 → 去服务商控制台充值后重试。
- 纯限流 → 稍等片刻重发；持续 429 用 `/model` 切轻量档模型（如 deepseek-v4-flash）。
- 长期降成本：`/effort` 降推理强度（档位 off/low/medium/high/max/auto，多数 pro 档模型默认 high、flash 档默认 medium）；并关注缓存命中率——命中与未命中的 input 单价差可达 50 倍，见本文第 8 节与 [observability-harness](../reference/observability-harness.md)。

## 3. API key / 认证失败

**现象**：启动或发消息时报认证失败、401、invalid key。

**先看**：`/connect` 打开服务商连接向导重新配置（选内置或自定义服务商，粘贴 API 密钥；支持从中断草稿恢复）。

**怎么修 / 为什么**：

- **在 config.json 里找不到 key 是正常的**：密钥明文只存 `~/.rivet/secrets.json`（0600 权限），配置文件里只有 `keyRef` 引用。
- 也可以走环境变量（如 `export DEEPSEEK_API_KEY=sk-xxx`），仅当前 shell 有效。
- codex 等订阅型服务商走 OAuth 浏览器授权：`/login` 或终端 `rivet config login codex`。
- 配错了想整组清除：`/disconnect`——删除该 provider 条目、其注册的模型列表，并清除托管密钥。

## 4. MCP 连不上

**现象**：配置了 MCP server 但没起来，工具列表里没有 `mcp__` 开头的工具。

**先看**：

- `/mcp` 查看 MCP 状态与可用子命令。
- `/debug mcp` 逐 server 显示连接状态（connected / error + 错误原因）与已注册工具数——server 进程报错（命令不存在、参数错误、环境变量缺失）都显示在这里。
- `/trust status` 查项目授信状态。**未授信项目的项目级配置中 `mcp.servers` 会被整段忽略**（安全键不合并），这是「配了却没拉起」的最常见原因。

**怎么修**：确认项目可信后执行 `/trust` 授信（仅对本机生效、不写回仓库；安全键自下次会话起生效，需重启）。授信后仍连不上，按 `/debug mcp` 的 error 文案修 server 配置本身。

> 完整配置字段（`env` / `timeoutMs` / 代理注入 / 远程型 / `-32000` 排查）见 mcp-servers.md。


## 5. 权限弹窗太频繁

**现象**：几乎每个工具调用都弹确认，打断心流。

**先看**：`/permission`（无参数弹出交互式选择面板）查看当前档位与已有 allow/deny 规则。

**怎么修**：

- 三档统一入口：`/permission supervise`（监督：高风险全弹确认）、`/permission auto`（自动，默认档：低/无风险自动过，高风险仍确认）、`/permission unattended confirm`（全自动：免审批，写沙箱仍开，有 `/rollback` 兜底）。
- 更精细的做法不是升档，而是补规则：给常用安全命令写 allow 规则或 bash 前缀白名单（`bash.allowlist`），命中即跳过审批；deny 规则优先级最高。写法与示例见 [沙箱与权限模型](../user-guide-sandbox-permissions.md)。

## 6. 改坏了想回滚

**现象**：agent 改错了文件，想回到之前的某个状态。

**先看 / 怎么修**（三种机制，按需选）：

- **双击 ESC 倒带**（间隔 <400ms）：打开消息历史，选任一过往用户消息倒带到该点，可选「仅对话 / 仅代码改动 / 两者」三种粒度，代码动作附文件影响预览。TUI 与桌面端均可用。
- `/rollback`：预览/恢复 git 检查点（`confirm` 执行）——适合整段任务级回退。
- `/undo`：文件级版本化。无参数列出最近快照，`/undo preview <n>` 先看会动哪些文件，`/undo <n>` 执行恢复。

## 7. 终端显示异常（乱码 / 对齐错位 / 方块）

**现象**：图标变成方块或问号、表格和边框对不齐、颜色显示异常。

**怎么修**：

- 方块 / 乱字形 → 设 `RIVET_ASCII_UI=1` 强制纯 ASCII UI（降级终端）。
- 中文对齐错位 → 设 `RIVET_AMBIGUOUS_WIDTH` 覆盖 CJK 宽度判定（各终端对宽字符判定不一）。
- 颜色不用手动管：truecolor / 256 色 / 16 色三轨自动降级；`/theme list` 换主题，`/theme auto` 探测终端背景色自动适配明暗。

详见 [README 终端 UI 节](../../README.md#终端-uitui) 及「环境变量 → TUI 显示」表。

## 8. 缓存命中率掉了 / 成本突然升高

**现象**：GlanceBar 状态栏上的命中率明显低于平时的 95–99% 稳态区间，或单轮成本异常升高。

**先看**：

- `/debug cache`：当前命中率、read/write tokens、成本与缓存折扣。
- 会话目录下 `<id>/cache-log.jsonl`：逐 API 请求的 input / cacheRead / hitRate / model / turn（确切路径用 `/logs` 查）。

**为什么 / 怎么修**：前缀缓存靠「请求前缀字节完全一致」命中，四种常见碎裂原因：

1. **切模型**（`/model`）——缓存按模型命名，换模型等于换一个缓存命名空间；
2. **切星域**（`/domain`）——系统提示词与工具白名单都变，前缀重建；
3. **改工具集**（工具 preset 调整、MCP 工具增减）——工具定义指纹变化；
4. **压缩边界**——上下文压缩重写历史，边界后第一个请求重建前缀（只断一次，随后恢复稳态）。

前三种是有意切换，代价是一次性的，不用修。如果**什么都没切**却持续 miss，才需要深挖：复算命令与计费口径见 [observability-harness](../reference/observability-harness.md) 文末「复算本文数字」。

## 9. Windows 特有问题

**现象 A：提示 WebView2 运行时过旧、会话区滚动卡顿。** 界面渲染依赖 WebView2 Runtime（建议 ≥ 120）。在提示条或「设置 → 运行时与关于」里点「运行修复工具」；窗口完全打不开时，用开始菜单「修复 WebView2」，或从 [Releases](https://github.com/huiliyi37/Tianshu-Tui/releases/latest) 下载 `windows-repair` 目录运行 `repair-webview2.cmd`；也可手动安装 WebView2 离线安装包后重启。

**现象 B：shell 命令执行异常。** 桌面版安装包内嵌 PortableGit（完整 Git + Git Bash，开箱即用，不依赖自装 Git；已装系统 Git 时优先用系统版）。CLI 用户自装 Git for Windows 即可获得可靠的 POSIX 命令执行——`/doctor` 会告诉你 bash 工具实际用的是哪个 shell，未用 Git Bash 时会给出警告。

## 10. 桌面端窗口打不开 / 白屏

**先看**：

- sidecar 日志：设置 → 系统 → 存储位置 → 打开日志目录；或在终端跑 `rivet logs open desktop` 直接打开。GUI 启动失败的关键线索在带时间戳的 sidecar stdout/stderr 文件里。
- `sidecar-exit.json`：sidecar 退出面包屑，崩溃排查第一现场（`rivet logs` 的输出里标了它的实际路径）。

**怎么修**：

- 白屏 / 渲染卡顿先查 WebView2 版本并跑修复工具（见第 9 节现象 A）。
- 确认存储位置指向有效目录：设置 → 存储位置里的 `current` 字段是当前实际数据目录。注意桌面端**不读** shell 里的 `RIVET_HOME`，以设置里为准。

## 还有问题

在终端跑 `rivet logs --json`，把输出的结构化落点清单贴进 issue——它列出所有会话/日志文件的实际路径与写入门控，维护者能据此快速定位。

- Bug 报告 / 功能请求 → [GitHub Issues](https://github.com/huiliyi37/Tianshu-Tui/issues)
- 使用问题 / 讨论 → [GitHub Discussions](https://github.com/huiliyi37/Tianshu-Tui/discussions)
- 安全漏洞 → 走[私密报告](https://github.com/huiliyi37/Tianshu-Tui/security/advisories/new)，不要开公开 issue

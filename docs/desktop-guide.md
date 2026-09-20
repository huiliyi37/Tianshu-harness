# 桌面端用户指南

> 适用于天枢桌面端（Tauri）。CLI 命令仍为 `rivet`，桌面端经 sidecar HTTP/SSE 驱动同一 agent 内核——本指南只讲桌面端独有的 UI、配置入口与交互模型。通用概念（Provider 配置、审查纪律、沙箱权限）见对应的 CLI 用户手册。

## 目录

- [三种会话模式：Plan / Ask / Agent](#三种会话模式plan--ask--agent)
- [审查门：自动审查与手动触发](#审查门自动审查与手动触发)
- [招牌特性](#招牌特性)
  - [Cockpit 驾驶舱](#cockpit-驾驶舱)
  - [SideChat 旁路提问](#sidechat-旁路提问)
  - [RewindOverlay 时间旅行](#rewindoverlay-时间旅行)
  - [GoalBar 自主目标](#goalbar-自主目标)
- [个性化与存储](#个性化与存储)
  - [主题系统与 ThemeStudio](#主题系统与-themestudio)
  - [Glass 模式与壁纸](#glass-模式与壁纸)
  - [存储位置与清理](#存储位置与清理)
  - [额外读写目录（PermissionDirs）](#额外读写目录permissiondirs)
- [进阶能力](#进阶能力)
  - [Mirror 镜像加速（GFW 用户）](#mirror-镜像加速gfw-用户)
  - [Computer Use（GUI 自动化）](#computer-usegui-自动化)
  - [星域与工具档位](#星域与工具档位)
- [功能一览与快捷键](#功能一览与快捷键)
- [语音输入](#语音输入)
- [检查点与回滚](#检查点与回滚)
- [参考](#参考)

---

## 三种会话模式：Plan / Ask / Agent

新建线程后，在输入框左下 **`+`（Plus 菜单）** 首层可切换三种模式，或按 `⇧Tab` 快速循环：

| 模式 | 行为 | 适用场景 |
|---|---|---|
| **Agent**（默认） | 直接读写文件、跑命令、自主完成编码 | 日常编码任务 |
| **Plan** | 只读代码与调研，**不写实现**。产出带 Mermaid 图 + TDD 步骤的计划文档存到 `.rivet/plans/`，审批后再切回 Agent 执行 | 复杂任务、多模块改动——先进 Plan 模式少走弯路 |
| **Ask** | 纯问答，不碰文件 | 想问问题、解读代码、要建议，不想被改代码 |

> Plan 模式产出的计划文档可用 `/plan-close <slug>` 关闭归档；如开启了"自动建议 plan mode"，多模块任务入口会主动提示你先进 Plan 模式（由 `RIVET_PLAN_MODE_SUGGEST` 控制，默认 `auto`）。

---

## 审查门：自动审查与手动触发

天枢的审查门有三个层级，**桌面端用户最容易混淆的是"持久配置"和"会话级开关"的区别**。

### 三层开关对比

| 层级 | 入口 | 作用域 | 持久？ |
|---|---|---|---|
| **持久配置** | Settings → Routing → 「关闭提交后自动审查（skipAuto）」复选框 | 所有新会话 | ✅ 写入配置文件，跨会话生效 |
| **会话级覆盖** | Plus 菜单 → ⚖ 审查 → Auto / Off 单选 | 仅当前会话 | ❌ 会话结束即失效 |
| **进程级硬关闭** | 环境变量 `RIVET_REVIEW_DISCIPLINE=0`（CI/headless 场景） | 整个进程 | — |

### skipAuto 复选框 vs Plus 菜单 off —— 关键区别

这是桌面端最易混淆的点：

- **Settings → Routing 的 `skipAuto` 复选框**改的是**配置文件**（`~/.rivet/config.json` 的 `agent.review.skipAuto`）。**只对新会话生效**——改了之后，当前已开的会话不会变，下一次新建线程才会按新配置走。它是"全局默认"。
- **Plus 菜单 → ⚖ 审查 → Off** 改的是**当前会话的内存状态**（`reviewGateOverride`）。**立即生效**，但只影响当前会话——会话关闭后失效，下次新会话仍按 `skipAuto` 配置走。它是"临时覆盖"。

### 默认行为（v2.22+）

`skipAuto` **开箱默认 `true`**——即新用户开箱即"自动审查默认关"。需要审查时：

- **手动触发**：Plus 菜单 → ⚖ 审查 → L1 / L2 / Max，或斜杠命令 `/review`、`/review max`。**显式触发的审查永远放行**，不受 `skipAuto` 影响。
- **恢复自动审查**：Settings → Routing 取消勾选 `skipAuto`（全局，新会话生效），或在当前会话 Plus 菜单切回 Auto（仅当前会话）。

> 核心原则：一切"关闭"只抑制**系统自动审查**；用户显式 `review_level`（手动 `/review`）永远放行。off 模式下主控的测试/验证/提交环节完全不受影响。

详见 [`docs/review-discipline.md`](./review-discipline.md)。

---

## 招牌特性

### Cockpit 驾驶舱

运行时仪表盘，5 个 tab 实时展示 agent 内部状态（2 秒轮询）。**入口不在侧栏**——按 `⌘K` 打开命令面板，搜 "cockpit" 进入；也可用斜杠命令 `/cockpit`。

| Tab | 展示内容 |
|---|---|
| **Summary** | 会话概览：模型、星域、token 用量、累计成本、turn 数 |
| **Safety** | doom loop 检测、风险信号、活跃 hook 告警 |
| **Verify** | 验证状态：改动文件的 RED 闸门、证据门、交付就绪度 |
| **Model** | 缓存命中率（input/cacheRead/cacheCreate）、推测解码命中、模型路由轨迹 |
| **Context** | 上下文占用、压缩状态、pinned anchors、压力指标 |

> 开发者向。普通用户日常用不到，但遇到"为什么变慢了""缓存命中如何""agent 现在在干嘛"时，Cockpit 是最直接的诊断入口。

### SideChat 旁路提问

按 `⌘;` 打开一个**不影响主任务的轻量会话**。

- 主线程正在跑长任务，你想临时问个问题（"这个函数干啥的""换个思路怎么样"）——用 SideChat，不会打断主 agent 的执行，也不污染主上下文。
- SideChat 是独立会话，有自己的上下文，结束后即丢弃。

> 这个入口很隐蔽（侧栏没有，只有 `⌘;` 快捷键），是桌面端最容易被忽略的实用特性。

### RewindOverlay 时间旅行

回退到任一历史消息点。**入口**：Plus 菜单 → ⟲ 时间旅行，或 `Esc Esc`（空输入连按两次 Esc），或斜杠命令 `/rewind`。

选定点后，**三种回退粒度三选一**：

| 模式 | 回退范围 |
|---|---|
| **仅对话** | 只回滚对话历史，文件改动保留 |
| **仅代码** | 只回滚文件改动（精确到 per-message），对话保留 |
| **对话 + 代码** | 两者都回滚（最彻底） |

代码模式有 per-message 精确预览，确认后才执行。运行中（agent 正在跑）禁用 Rewind。

> 这是唯一的"真后悔药"。`/undo` 是轻量版——只撤销最近一次文件改动，`/undo preview N` 可预览第 N 步。

### GoalBar 自主目标

用 `/goal <目标> --max N` 启动一个**跨多轮的自主目标**——agent 会持续迭代直到达成目标或耗尽预算 N。

启动后，输入框上方出现 **GoalBar** 状态条，实时显示：
- 迭代数 / 目标 / 已耗时 / 预算剩余
- 暂停 / 继续 / 取消按钮

`/cancel-goal` 终止正在跑的目标。

> 适合明确的、可迭代验证的任务（"让测试全过""把性能优化到 X ms"）。不适合开放式探索——那种用 Plan 模式更合适。

---

## 个性化与存储

### 主题系统与 ThemeStudio

Settings → 外观 提供 26 套内置主题（含暗色/亮色各半，如 `dark`/`light`/`nebula`/`sakura`/`cyberpunk`/`cupertino`/`catppuccin-mocha`/`tokyo-night`/`gruvbox-dark`/`nord`/`dracula` 等）。

**ThemeStudio**（Settings → 外观 → 主题工作室）支持：
- 自定义任意 CSS 变量（`--bg`/`--text`/`--accent`/`--panel` 等全量 token）
- 导入/导出主题 JSON（与他人分享）
- 自定义主题存 `~/.rivet/themes/*.json`

> 主题切换走 View Transitions API 做 220ms 交叉淡入（开启系统"减少动效"时跳过）。跟随系统模式（`system`）会实时监听 OS 的深浅色切换。

### Glass 模式与壁纸

**Glass 模式**（Settings → 外观 → 壁纸与材质）让侧栏/主区/Composer 变成半透明毛玻璃，透出底层壁纸。

- 开启后可调透明度与模糊度（Glass Custom 面板）
- Windows 下模糊度上限 12px（系统限制）
- **半透明表面的可读性**：Glass 模式下文字仍用主题的 `--text`，对比度依赖壁纸明暗。若觉得看不清：① 调高 Glass 透明度；② 用「智能基于壁纸调和配色」（Settings → 外观，会从壁纸取样算最佳正文色）；③ 用 Text Contrast 滑块（Settings → 外观）提升次级文字对比度。

**自定义壁纸**：Settings → 外观 → 壁纸，支持 cover/contain/center 三种 fit。设了壁纸会自动启用 Glass 效果（即使没开 Glass 开关）。

### 存储位置与清理

天枢的会话日志、记忆、缓存默认存在 `~/.rivet/`。桌面端支持**自定义存储位置**，优先级：

1. **`RIVET_HOME` 环境变量**（最高）
2. **桌面端便携模式**：exe 不在 `Program Files` 下时，数据存 `<exe目录>/TianshuData/.rivet`
3. **桌面端 Settings → System → Storage 设置**：写入 `%APPDATA%\app.tianshu.desktop\launcher.json` 的 `rivetHome` 字段
4. **平台默认**：macOS/Linux 为 `~/.rivet/`；Windows 为 `%LOCALAPPDATA%\.rivet/`（注意不是 `%USERPROFILE%\.rivet`）

> 当前实际生效的路径可在 Settings → System → Storage 查看（`current` 字段）。

首次启动会弹 **FirstRunStorageDialog** 让你选存储位置——选错可在 Settings 改。

**清理**：Settings → System → Storage → 存储用量，可按天清理历史会话、全清、或单条删除。

### 额外读写目录（PermissionDirs）

默认 agent 只能读写当前项目目录。若你的任务需要访问项目外的目录（如 monorepo 的兄弟包、配置目录），在 Settings → Behavior → 额外读写目录 添加：

- **读目录**：agent 可读取（不能写）
- **写目录**：agent 可读写

两条独立列表，文件夹选择器 + 手动输入。等价于 CLI 的 `agent.permissions.additionalReadDirs` / `additionalWriteDirs`（详见 [`user-guide-sandbox-permissions.md`](./user-guide-sandbox-permissions.md)）。

---

## 进阶能力

### Mirror 镜像加速（GFW 用户）

国内用户访问 GitHub/npm/pypi/go/rust 生态的包经常超时。Settings → Integrations → Mirror 提供镜像加速：

- **china 预设**：一键应用五个生态的国内镜像（推荐）
- **default 预设**：逐个生态自选镜像源
- 覆盖：GitHub（git clone / fetch）、npm、pypi、go modules、rust crates

> 生效时机：**下一次 bash 执行**（bash 工具每次调用前重载镜像配置），无需重启。CLI 等价：`/mirror on|off|china|default`。

### Computer Use（GUI 自动化）

让 agent 操控图形界面——点击、输入、截屏识别。基于 CDP 直连系统 Chrome（无需另装浏览器）。

- **macOS**：需在系统设置授权"辅助功能"权限。Settings → Integrations → 计算机控制 可 per-app 授权（"始终允许操控 X 应用"）
- **Windows**：支持 COM 自动化（见 [`docs/computer-use-windows-com-smoke.md`](./computer-use-windows-com-smoke.md)）
- **Pro 功能**：Computer Use 是 Pro 档差异化能力（见 Basic/Pro 双层说明）

> 典型场景：操作不支持 CLI 的工具、自动化图形工作流、跨应用联动。开启 `RIVET_COMPUTER_USE_AUTOMOUNT` 可让 browser-debug 自动挂载 computer-use。

### 星域与工具档位

新会话的初始星域在 Settings → System → 「默认星域」设置（默认启明，固定不自动切换；选 Auto 才按任务关键词路由）。星域决定系统提示词、工具白名单与决策阈值。

**最小集绑定星域**（Settings → System，默认星域卡旁）：一键组合「钉定默认星域 + taiyi 14 件最小工具档」——新会话启动即该域的最小集形态，**不含 lean 资源减配**。清空 = 恢复默认域启明（该域工具档覆盖会保留，可在 Settings → Behavior → Lean 资源档 → 按域覆盖中删除）。

**工具档位**（Settings → Behavior → 工具档位）控制每个会话装配的工具集，四档：

| 档位 | 工具数 | 适用 |
|---|---|---|
| minimal | 30 | 日常开发全能力，省 token |
| frontend（默认） | 31 | + `browser_debug` 浏览器验证 |
| full | 51 | 全集（编排 / semantic_search / computer_use / 办公工具族），system prompt 开销更大 |
| taiyi | 14 | 最小评测档——钉定太一域时自动落此档，无需手选 |

> 生效时机：档位与绑定都在**新会话**装配（会话中途 `/domain` 切换不换工具——改工具指纹会重建前缀缓存）。想给某个星域单独配档位/lean/阈值：Settings → Behavior → Lean 资源档 → 按域覆盖（`runtime.domains.<域>`，域列表随新增星域自动扩展）。

---

## 功能一览与快捷键

除招牌特性外，桌面端还有一组日常高频能力：

- **集成终端**：`⌘/Ctrl+J` 或 `` Ctrl+` `` 唤出内嵌终端（xterm.js + Rust portable-pty），不必离开天枢就能跑命令
- **+ 菜单**：议事会 ♟、团队模式 ⬡、派子代理、模型切换、星域选择一键触达（不再需要手敲 slash 命令）
- **推理强度选择器**：`/effort`（无参数）弹出交互面板，上下选档位（Auto/Max/High/Medium/Low/Off），回车确认
- **思考计时器**：agent 执行时显示实时 elapsed（如 "思考中 · explore · 1m 23s"），超过 10 分钟变红提示可能卡住
- **@file 文件预览**：消息中提及的文件可点击，右侧抽屉展示文件内容（语法高亮 + 行号）
- **DeepSeek 余额查询**：Insights 面板顶部显示账户余额和欠费状态（调官方 API）
- **自定义 Provider**：设置 → 连接模型服务商 → + 自定义 Provider，支持任意 OpenAI 兼容端点（Ollama/vLLM/直连 OpenAI），API Key 可选
- **sidecar 内存自适应**：堆上限按机器内存自动分档（8G→2G / 16G→4G / 32G→6G / 64G+→8G，`RIVET_SIDECAR_HEAP_MB` 可覆盖），≤8GB 机器自动启用 lean 资源档
- **watchdog 自动恢复**：边界停滞时自动续跑，桌面端时间线可见恢复事件（⟳ 自动恢复 / ⏹ 配额耗尽）
- **多会话并发**：标签栏管理多个会话，独立 cwd + 模型 + 审批模式
- **功能面板**（左侧栏 `⌘1…9` 切换）：Mission Control（多会话控制台）、Inbox（收件箱）、Automations（定时任务）、Skills / Hooks 管理、Git / GitHub、Changes（改动审查）、Delegation（委派舰队与团队波次 DAG）、Cockpit 驾驶舱
- **Popout 独立窗口**：把单个会话线程弹成独立窗口，多屏并行
- **JobsDock / TodoDock 常驻抽屉**：后台任务停靠条（展开日志 / Kill / 在终端打开）、跨标签常驻 todo
- **手机遥控**：设置 → Network → Remote Access 开启后，手机浏览器扫码看进度、批审批——详见 [远程访问指南](remote-access.md)

### 桌面端快捷键

`⌘/Ctrl+/` 随时唤出快捷键速查表（ShortcutOverlay）。核心快捷键：

| 快捷键 | 作用 |
|--------|------|
| `⌘/Ctrl+K` | 命令面板 |
| `⌘/Ctrl+N` | 新会话 |
| `⌘/Ctrl+1…9` | 切换功能面板 |
| `⌘/Ctrl+,` | 设置 |
| `⌘/Ctrl+Shift+]` / `[` | 下/上一个会话标签 |
| `⌘/Ctrl+W` | 关闭标签 |
| `⌘/Ctrl+B` | 切侧栏 |
| `⌘/Ctrl+Shift+B` | 切审查面板 |
| `⌘/Ctrl+J` · `` Ctrl+` `` | 切集成终端 |
| `⌘/Ctrl+;` | SideChat 旁路提问 |
| `⌘/Ctrl+.` | Zen 模式（隐藏侧栏的纯 UI 专注模式） |
| `⌘/Ctrl+O` | 视图模式循环（standard → verbose → summary） |
| `Shift+Tab` | Plan / Agent 模式切换 |
| `Esc Esc` | 倒带（桌面端 Rewind） |

## 语音输入

输入框的麦克风按钮支持语音输入，**macOS 与 Windows 通用**。识别由**本地 whisper.cpp 引擎**完成——离线、隐私（录音不上传任何服务器），中英文混杂场景的精度优于系统自带识别。

**首次使用引导**：

- 首次点击麦克风会自动下载识别模型（tiny 约 75MB，国内走镜像加速）。下载未完成时点击会提示「语音识别失败（whisper-unavailable）」，稍候重试即可。
- macOS 首次使用会请求麦克风权限：点击「允许」即可；若误拒，到「系统设置 → 隐私与安全性 → 麦克风」中开启本应用。
- Windows 若提示权限被拒，在「系统设置 → 隐私 → 麦克风」中允许本应用。

**注意事项**：

- 识别全程在本地完成，录音不离开设备。
- 点击一次开始录音，再点一次结束并识别。
- 本地引擎不可用时（如模型未下载），macOS 自动回退系统语音识别；Windows 则提示模型未就绪。
- 追求更高精度可换用 base 模型（约 244MB）：`desktop/scripts/fetch-whisper-runtime.js --with-base` 预下载。
- 网络受限环境可设 `RIVET_WHISPER_PROXY=http://代理:端口` 加速模型下载。

---

## 检查点与回滚

**检查点**：Auto 自治档位下，可设每 N 轮暂停同步进度摘要。Settings → Behavior → 检查点间隔（默认 0 = 关闭；可选 20/25/30/自定义）。检查点是粗粒度的 git 级回滚锚点。

**回滚层次**（从轻到重）：

| 操作 | 范围 | 入口 |
|---|---|---|
| `/undo` | 撤销最近一次文件改动 | 斜杠命令 |
| `/rewind` 或 RewindOverlay | 回退到任一历史消息，三粒度选择 | Plus 菜单 / `Esc Esc` / `/rewind` |
| 检查点回滚 | 回退到上一个检查点 | Review 面板「回滚点」标签 |

> 三者关系：`/undo` 最快但只能退一步；RewindOverlay 最灵活（可选对话/代码/两者）；检查点最粗但最稳（git 级）。日常用 `/undo`，复杂回退用 RewindOverlay。

---

## 参考

- [Provider 配置手册](./user-guide-provider-config.md) —— 模型 Provider、API Key、子代理路由
- [审查纪律规范](./review-discipline.md) —— 审查门的完整规范、三级开关、重入护栏
- [沙箱与权限](./user-guide-sandbox-permissions.md) —— `agent.permissions`、path-grants 详解
- [README](../README.md) —— 项目总览
- [用户手册](./user-guide.md) —— CLI 命令全表、TUI 键位、配置文件与环境变量、日志排查
- [发版记录](./releases/) —— 每个版本的特性与修复

---

> 本指南覆盖桌面端独有特性。遇到本文未覆盖的问题，先查 [用户手册](./user-guide.md) 的「斜杠命令」「配置文件」「环境变量」章节，或用 `⌘K` 命令面板探索——桌面端几乎所有功能都能从命令面板触达。

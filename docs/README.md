# 天枢文档中心与规范 · Tianshu Documentation Hub & Specification

> [🏠 返回主文档 (README.md)](../README.md) · [🌐 English README](../README.en.md)
>
> 本文件是 `docs/` 文档库的总纲与核心导航入口：先提供面向用户与研究者的中英双语核心文档地图，再规定仓库内文档类型、目录地图、命名规范、frontmatter 标准与索引用法。
> This page serves as both the **Core Documentation Portal** for Tianshu Harness (with bilingual navigation to user guides, CVM papers, star domain archives, and architecture references) and the **Documentation Governance Specification** for `docs/`.
> 索引不手维护——[INDEX.md](INDEX.md) / [docs.json](docs.json) / [MINDMAP.md](MINDMAP.md) 均由 `scripts/docs-index.ts` 生成。

## 📚 核心文档导航 · Core Documentation Portal

### 使用与配置手册 · Usage & Configuration Guides

| 文档 · Document | 中文说明 | English Summary |
|---|---|---|
| [用户手册](user-guide.md) | CLI / TUI 完整参考：启动参数、星域切换、Plan/Goal/Council/Team、前缀缓存、斜杠命令、环境变量与配置 | Complete CLI/TUI reference: flags, star domains, Plan/Goal/Council/Team workflows, prefix cache, 90+ slash commands, and config |
| [安装与平台说明](guides/installation.md) | 桌面端安装包、一键脚本、npm 全局安装、Android/Termux、源码构建与 Shell 补全 | Desktop installers (macOS/Windows/Linux), one-liner scripts, npm global install, Android/Termux, build from source, and shell completions |
| [桌面端用户指南](desktop-guide.md) | Tauri 桌面端独有特性：三种会话模式、审查门、Cockpit 驾驶舱、SideChat、时间旅行、WSL 连接、主题与玻璃材质 | Tauri desktop app guide: Agent/Plan/Ask modes, review gate, 8-tab Cockpit, SideChat, Rewind time-travel, WSL runtime, and ThemeStudio |
| [Provider 配置手册](user-guide-provider-config.md) | 内置 Provider 预设（DeepSeek / GLM / MiMo / MiniMax / Codex 等）、多 Key 池、子代理与议事会异构路由、生图配置 | Built-in provider presets, multi-key pool, worker/review/compaction routing, heterogeneous Council seats, and text-to-image setup |
| [权限与沙箱指南](user-guide-sandbox-permissions.md) | 三档审批模式（监督 / 自动 / 全自动）、操作系统级沙箱（macOS Seatbelt / Linux bwrap / Windows 回滚兜底）、路径授权与安全防线 | Three-tier permission modes, OS-level filesystem sandboxing, path grants, SSRF/sensitive-file guards, and rollback protection |
| [识图能力手册](user-guide-vision.md) | 视觉通道诚实性、同/跨 Provider 自动识图桥、`/vision` 向导、`ask_image` 多轮追问与 `browser_debug` 截图闭环 | Vision channel modes, same-/cross-provider vision bridges, `/vision` wizard, `ask_image` follow-ups, and `browser_debug` screenshot verification |
| [远程访问指南](remote-access.md) | `tianshu serve` 局域网同 Wi-Fi 直连（LAN Direct）、HTTPS 隧道、Host 白名单与 `/mobile` 安全边界 | `tianshu serve` LAN Direct same-Wi-Fi connection, HTTPS tunnels (Tailscale Serve), Host allowlist, and `/mobile` security boundaries |
| [手机端操作手册](guides/mobile-guide.md) | 手机/平板扫码直连桌面端：实时查看会话流、处理工具与计划审批、发起新任务 | Step-by-step mobile/tablet companion guide: QR code pairing, live session timeline, tool/plan approvals, and remote task launch |
| [排障与 FAQ](guides/troubleshooting.md) | 高频现场速查：卡住诊断、429/余额、API Key 迁移、MCP 排障、缓存碎裂、Windows WebView2 / 杀毒软件拦截与 npm EACCES/EEXIST | Troubleshooting & FAQ: stuck runs, 429/quota, key migration, MCP debugging, cache fragmentation, Windows WebView2/AV issues, and npm errors |

### 理念、架构与星图 · Philosophy, Architecture & Star Atlas

| 文档 · Document | 中文说明 | English Summary |
|---|---|---|
| [CVM 认知虚拟机理念](reference/cvm-cognitive-runtime.md) | 为何 Agent 需要一层认知运行时：从工具调用器到可观测、可纠偏的认知控制流（CC BY-NC-ND 4.0） | Why coding agents need a Cognitive Virtual Machine (CVM): from raw tool loops to observable, self-correcting cognitive control flow |
| [CVM 运行时实证影响](CVM运行时对Agent模型的实证影响.md) | 7 组真实工程故障的 A/B 实证对比：验证债务、空洞完成、探索螺旋与伪绿灯的运行时拦截证据（CC BY-NC-ND 4.0） | Empirical A/B evaluation across 7 real-world failure modes: verification debt, hollow completion, exploration spirals, and false greens |
| [指标观测与真实数据](reference/observability-harness.md) | 真实工程会话前缀缓存命中率（95–99%，主样本 99.6%）、成本节省账单与复算脚本 | Real production session telemetry: 95–99% prefix-cache hit rates (99.6% primary sample), cost savings breakdown, and verification scripts |
| [架构总览](architecture-overview.md) | 六层运行时架构、Agent Loop、75 个 RuntimeHook 模块、Prompt Engine 冻结前缀与 16 星域装配 | Six-layer runtime architecture, Agent Loop, 75 RuntimeHook modules, Prompt Engine frozen prefix, and 16 Star Domains |
| [工程质量指标](engineering-metrics.md) | 源码与测试约 1:1 规模快照（21,500+ 静态测试用例）、迭代里程碑与复现命令（中英双语） | Bilingual engineering metrics (~1:1 test-to-source ratio, 21,500+ static test cases), growth milestones, and reproduction commands |
| [星域碑文 (中文)](stars/genesis-stele.md) · [Genesis Stele (EN)](stars/genesis-stele.en.md) | 十六星域公理、星图速览、各主星模型认领星位时的原始铭文与太一创世碑（中英双语全文） | The 16 Star Domains: axioms, star map overview, primary model inscriptions, and the Taiyi Genesis Stele (full Chinese & English editions) |
| [天枢 3.0 宣言](releases/manifesto-v3.0.0.md) | 天枢 3.0「盘古创世纪」版本宣言：群星就位、太一归中 | Tianshu 3.0 "Pangu Genesis" release manifesto |

---

## 核心理念

1. **元数据内嵌、索引生成**——元数据写在每篇文档头部的 frontmatter 里，索引是构建产物，可随时重建（借 KEP/PEP 范式）。手维护的总索引必然腐烂。
2. **一篇文档只属一类**——spec 写 What/Why、design 写 How+权衡、plan 做执行追踪、analysis 做事后归因。写混了说明该拆（防 blur，借 Diátaxis）。
3. **superseded 不删档**——被取代的文档标记状态并指向替代者，它曾是决策这件事本身仍有价值（借 ADR）。
4. **升级不推翻**——既有的日期前缀、blockquote 元信息头、teamtask 边界 README、briefs 分层索引等约定全部保留；新文档在此之上补 frontmatter 即可被机器索引。

## 文档类型（受控 `type` 枚举）

| type | 职责（一句话） | 落点目录 | 命名 |
|------|--------------|---------|------|
| `plan` | 执行计划：任务分解 + checkbox 追踪 | `plans/` | `YYYY-MM-DD-主题.md` |
| `spec` | 事前规格：做什么/为什么（需求 + 验收标准） | `specs/` | `YYYY-MM-DD-主题.md` |
| `design` | 事前权衡：怎么做（trade-off + 备选方案） | `design/` | `YYYY-MM-DD-主题.md` |
| `decision` | 决策记录：为什么选这条路（ADR 五段式） | `decisions/` | `NNNN-标题.md`（单调递增、不复用） |
| `analysis` | 事后归因：分析 / 复盘 / handoff | `analysis/` | `YYYY-MM-DD-主题.md` |
| `research` | 外部调研：竞品 / 技术 / 生态 | `research/` | `YYYY-MM-DD-主题.md` |
| `changelog` | 变更记录（发生了什么） | `changelog/` | `YYYY-MM-DD-主题.md` |
| `issue` | 单点问题追踪 | `known-issues/` | `YYYY-MM-DD-主题.md` |
| `release` | 版本发布说明 | `releases/` | `v2.x.y.md`（语义命名） |
| `guide` | 手册指南（用户 / 开发者） | `guides/` | 语义命名，无日期前缀 |
| `reference` | 架构参考 / 长期有效资料 | `reference/` | 语义命名，无日期前缀 |

边界判断（一文档一类型，混淆时按此分流）：

- 「要不要做、做成什么样」→ `spec`；「怎么实现、为什么这么实现」→ `design`；「下一步谁做什么」→ `plan`
- 「为什么选了 A 不选 B」的单点决策 → `decision`（不从属任何 feature，长期有效）
- 「发生了什么、根因是什么」→ `analysis`；「改了哪些东西」→ `changelog`
- 「外面世界怎么样」→ `research`；「我们自己怎么用」→ `guide` / `reference`

## 目录地图

新文档落点为上表目录。历史保留区不动，由 INDEX 统一逻辑视图：

| 目录 | 定位 |
|------|------|
| `plans/` `specs/` `decisions/` `guides/` `reference/` | 新规范落点（各带边界 README） |
| `design/` `analysis/` `research/` `changelog/` `known-issues/` `releases/` | 既有目录，沿用 |
| `superpowers/` | 历史主仓（plans 339 / specs 212 等），保留不动；新文档请用顶层对应目录 |
| `teamtask/` | 系统级收束专项（自带边界 README） |
| `stars/` | 星域档案（自带命名公约） |
| `brand/` `dev/` `prompt-changelog/` `prompt-versions/` `cache-baseline/` | 专项资料区 |
| `tasks/` `reviews/` `sessions/` | 历史散点区，不再新增，新文档去对应类型目录 |
| `archive/` | 归档区（见下文归档规则） |
| `_templates/` | 各类型模板 |
| 顶层散落文件 | 历史遗留，不再新增；新文档一律进类型目录 |

工具草稿区（`.rivet/plans/`、`.cursor/plans/`、`.zcode/plans/`）是各 agent 工具的运行时产物，**不改其行为**；定稿后的晋升路径：按命名规范移入对应 docs 类型目录 + 补 frontmatter。

## 命名规范

- **带时间性的类型**（plan / spec / design / analysis / research / changelog / issue）：`YYYY-MM-DD-主题.md`，日期为创建日。排序友好，且是索引的日期兜底来源
- **长期有效的类型**（release / guide / reference / decision）：语义命名（`v2.23.0.md`、`user-guide.md`、`0007-cache-freeze.md`）
- 英文部分用 kebab-case；中文文件名允许（既有 15% 为中文名），但不要中英混杂造词
- 避免空格；避免 `副本`、`final`、`v2-final` 这类后缀——迭代用 `supersedes` 表达

## Frontmatter 标准

新文档在文件顶部写 YAML frontmatter（模板见 `_templates/`）：

```yaml
---
title: 文档标题             # 必填
type: plan                  # 必填，受控枚举（见上表）
status: draft               # 必填，见状态机
date: 2026-07-27            # 必填，YYYY-MM-DD
updated: 2026-07-27         # 可选
related: [../specs/xxx.md]  # 可选，关联文档（相对路径或仓库根相对路径）
supersedes: ../plans/yyy.md # 可选，本文档取代的旧文档
tags: [cache, hooks]        # 可选
---
```

**状态机**：`draft`（起草）→ `active`（进行中/生效中）→ `accepted`（已定稿）→ `done`（已完成）；终态 `deprecated`（不再推荐）/ `superseded`（已被取代，配 `superseded` 方的 `supersedes` 字段互指）。decision 类额外遵循 ADR 纪律：编号单调递增不复用，`superseded` 不删档。

**与存量惯例的兼容**：索引生成器三级兜底——frontmatter 优先；无 frontmatter 时用文件名日期前缀 + blockquote 元信息头（`> 日期：` / `> 状态：`）+ 首个 H1。存量文档不强制补 frontmatter，顺手时补录即可。注意：`type` 字段是规范 frontmatter 的 schema 标记，`npm run docs:check` 只校验含 `type` 的文档（Cursor plan 等外来 schema 不受影响）。

## 引用与关联

- 文档间引用优先用**相对路径 markdown 链接**（GitHub/IDE 可点击）；反引号纯路径仍允许（agent grep 场景），二者并存
- 关联关系进 frontmatter `related` / `supersedes` 字段（机器可建关联图），正文链接给人类
- 引用代码用 `` `src/path/file.ts:42` `` 格式（精确、可导航）

## 索引与思维导图

```bash
npm run docs:index   # 重新生成 INDEX.md / docs.json / MINDMAP.md
npm run docs:check   # 校验 frontmatter 合法性 + 文档卫生检查（只校验不生成）
```

- **[INDEX.md](INDEX.md)** — 全量索引，按 type 分组、日期倒序，含状态列
- **[docs.json](docs.json)** — 机读索引，供脚本/工具消费（如"列出所有 status=active 的 plan"）
- **[MINDMAP.md](MINDMAP.md)** — 思维导图大纲。VSCode markmap 插件直接打开，或 `npx markmap-cli docs/MINDMAP.md` 渲染成交互式 HTML；每个分组仅展开最近 20 篇防爆炸

三件套已提交进仓库方便 GitHub 浏览；内容过期时跑 `npm run docs:index` 重建即可，不要手工编辑（文件头有生成标记）。

## 归档规则

- `deprecated` / `superseded` 状态的文档满一个版本周期后，移入 `archive/`（保留原文件名，frontmatter 不动）
- `archive/` 不参与索引；移动时在原文档的 `related` 文档里更新链接
- 不确定是否该归档 → 只改 `status`，不动位置

## 写新文档的流程

1. 判断类型（一文档一类型，拿不准看边界判断节）
2. 从 `_templates/` 复制对应模板到对应目录，按命名规范改名
3. 填 frontmatter（`type`/`status`/`date` 必填）
4. 写完跑 `npm run docs:index` 更新索引，`npm run docs:check` 确认校验通过

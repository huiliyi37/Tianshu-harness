# 天枢架构总览 · Architecture Overview

> [🏠 返回主文档](../README.md) · [🌐 English README](../README.en.md) · [📊 工程质量指标](./engineering-metrics.md) · [📚 用户手册](./user-guide.md)
>
> **v3.31.0** · Node.js 24+ / TypeScript strict / 纯 ANSI TUI（`src/tui/engine/`）+ Tauri 桌面端 / node:test / ESM
>
> 规模：CLI 源码约 1,475 文件 / 29.5 万行，测试约 1,875 文件 / 31.9 万行（21,514 用例静态声明），75 个运行时 hook 模块，16 个内置星域。
> 逐期数据与迭代里程碑见 [`engineering-metrics.md`](./engineering-metrics.md)。
>
> 开发代号曾用 **Rivet**；CLI 主命令为 `tianshu`（兼容别名 `rivet`）。Agent 导航索引见根目录 [`AGENTS.md`](../AGENTS.md)。

> **🌐 Executive Summary (English)**
> **Tianshu Harness** is a six-layer agentic coding runtime built around three core engineering commitments:
> 1. **Cognitive Virtual Machine (CVM)** — Every agent turn flows through a 5-phase `RuntimeHookPipeline` (`preTurn → afterPerception → postTool → postTurn → postSession`, conditionally assembling from **75 runtime hook modules**) paired with a `CognitiveLedger` and `AdvisoryBus` to detect and correct verification debt, hollow completions, and doom loops before side effects land.
> 2. **Prefix-Cache-First Prompt Engine** — System prompts (`static.ts` frozen base + volatile domain block) and tool schemas are frozen at session start; dynamic context is injected via byte-stable cross-turn `appendixDelta` blocks, and history compaction rewrites only at user boundaries (`turn === 0`), sustaining **95–99%** steady-state prefix-cache hit rates.
> 3. **16 Star Domains (`STAR_DOMAINS`)** — Switchable cognitive disciplines that configure methodology prompts, tool whitelists, and decision/courage thresholds (`courageThreshold`), shared across all surfaces (**Layer 0**: pure-ANSI TUI, Tauri Desktop, VS Code/Cursor extension, Headless CLI `tianshu -p`, and HTTP/SSE Sidecar `src/server/`).

## 项目定位

天枢是针对前缀缓存与认知控制流深度优化的全功能编程智能体运行时。差异化不在「多几个工具」，而在：

- **CVM（认知虚拟机）** — 模型动作经五阶段 RuntimeHookPipeline 过滤与纠正，再落到物理工具
- **Prefix-cache-first** — 冻结前缀、字节稳定 appendix、仅用户边界压缩，把命中率做成一级成本指标
- **星域纪律** — 16 套可切换认知姿态（提示词 / 决策阈值 / 勇气阈值），而非角色扮演皮肤

## 六层架构 · Six-Layer Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 0: Surfaces                                                  │
│  TUI: src/tui/engine/（纯 ANSI） · Desktop: desktop/（Tauri/React） │
│  VS Code/Cursor 插件: vscode-extension/（sidecar 客户端 + E4 委托）  │
│  Headless: tianshu -p · Sidecar HTTP/SSE: src/server/               │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 1: Agent Loop (src/agent/)                                   │
│  loop.ts → turn orchestration → tool-execution → completion         │
│  RuntimeHookPipeline（5 phases，条件装配 75 个运行时 hook 模块）     │
│  Coordinator / WorkerSession / Plan·Team·Council / DeliveryGate     │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 2: Context & Cognition (src/context/ + memory/)              │
│  CognitiveLedger · ClaimStore · Stigmergy · PressureMonitor         │
│  TaskContract · Antibody · ProjectMemory · UnifiedMemory            │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 3: Prompt & Compact (src/prompt/ + compact/ + cache/)        │
│  PromptEngine: static(frozen) + volatile + appendixDelta             │
│  Boundary compaction · CacheAdvisor · Request freezer               │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 4: Tools & Repo Intel (src/tools/ + repo/ + search/ + lsp/)  │
│  Kernel ≤26 工具 · EXTENDED（office/browser/computer_use）          │
│  Meridian 图 · Physarum · semantic/hybrid search · MCP · LSP        │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 5: API & Model (src/api/ + model/ + auth/)                   │
│  OpenAI-compat · Anthropic · Codex OAuth · FallbackStream           │
│  Provider presets · Capability cards · Adaptive worker routing      │
└─────────────────────────────────────────────────────────────────────┘
```

## 核心子系统

### Agent Loop

`src/agent/loop.ts` 每轮大致：

1. **preTurn** → RuntimeHookPipeline
2. **Perception** → 流式接收模型输出（`turn-perception.ts`）
3. **Tool Execution** → 执行 tool calls（`tool-execution.ts`，每工具后 **postTool**）
4. **Compaction 决策** → `runCompaction`（`turn-orchestrator.ts`；历史重写仅在 `turn===0`）
5. **postTurn** → 回合收尾 hooks
6. **postSession** → 会话级 hooks（经 orchestrator 调度）

关键控制器与门禁：TurnHarness、EvidenceTracker、DeliveryGate、RepairPipeline（DeepSeek tool-JSON-in-content）、wave-gate（计划分波）、GoalTracker。

### RuntimeHookPipeline

5 phases: `preTurn → afterPerception → postTool → postTurn → postSession`

- 装配入口：`createDefaultRuntimeHooks()`（`create-runtime-hooks.ts`）
- **不是**固定 9 个 hook。内置 **75 个运行时 hook 模块**，按 deps / 环境变量门控；默认会话实际激活约 18+
- 常驻基线含：perception、signal-consumer、kick、vigor、theta、stigmergy、radio
- Advisory 类（self-verify、edit-tool-advisory、spec-verify-gate、context-pressure…）经 `AdvisoryBus` 注入 system-reminder，**不重写** `frozenBase` / `volatileBlock`
- 改 hook 行为前先看 gate 条件，勿假设某 hook 一定在跑

### Prompt Engine（缓存优化核心）

```
System = static.ts（会话内冻结） + volatile（动态区） + appendixDelta（跨回合增量）
```

硬约束（详见 CLAUDE.md Known Constraints）：

- appendix 块必须字节稳定；量化在渲染层做
- 压缩历史重写只在用户边界（`turn===0`）
- frozen 快照 commit 不得依赖可被 `invalidateFreshCache()` 清空的守卫
- `stream()` 对 request 的变换必须 copy-on-write（防侧路重入双写）

### Tools

`createDefaultToolRegistry`（`src/tools/default-registry.ts`）维护 **kernel budget ≤26**。超出会触发认知过载退化（见 kernel-budget 测试）。

| 层 | 示例 |
|----|------|
| Kernel | read/write/edit/hash_edit、bash、job、grep/ast_grep/ast_edit、glob、diff、git、run_tests、todo、web_search/fetch、repo_map、plan_submit/close、skill… |
| 装配注入 | delegate_task/batch、team_orchestrate、council_convene、deliver_task、memory/recall、repo_graph、semantic_search、browser_debug… |
| EXTENDED（默认关） | 办公套件（docx/xlsx/pptx/pdf/image）、browser、computer_use（Pro 门控） |

星域 `toolWhitelist` 是真实交集过滤器；内置 16 星域当前白名单为全集 → 交集退化为恒等（太一域另通过默认 `toolPreset: "taiyi"` 装配 14 件核心工具），但拼错 authority 会 fail-closed 返回 `[]`。

### 星域 · Plan · Team · Council

| 机制 | 作用 |
|------|------|
| `/domain` + 自动路由 | 切换 16 星域的提示词后缀 / 决策风格 / 勇气阈值 |
| Plan Mode | 调研 → 结构化计划 → 审批 → 分波执行（wave-gate） |
| `/team` | 多 worker 并行，文件冲突感知调度 |
| `/council` | 多席位审查，可选反驳轮 |

### Multi-Model Delegation

WorkerProfile + WorkOrder → 独立无头会话；按任务类型自适应路由（capable / cheap 等）；批量聚合策略可配。议事会席位有 tierFloor（只抬升不降级）。

### Compaction

`src/compact/` + `compact-boundary-coordinator`：会话分裂 → maybeCompact → T9 质量压缩 → 陈旧轮 → 堆驱动微压缩；命中即止。1M 窗口与健康缓存时可延迟压缩。

### Repo Intel

- **Meridian**（`src/repo/meridian-*`）— 导入图 / 影响半径
- **Physarum** — 文件访问偏好（信息素式路径强化）
- **search/** — tree-sitter chunk + hybrid / embedding 检索
- **LSP** — 诊断回流

### Surfaces

| 表面 | 路径 | 说明 |
|------|------|------|
| TUI | `src/tui/` | 纯 ANSI 引擎；SteerBuffer 承接流式中输入 |
| Desktop | `desktop/` | Tauri；经 `src/server/` 会话池与 SSE |
| VS Code/Cursor 插件 | `vscode-extension/` | 同 sidecar 通道；E4 客户端工具委托（原生 diff/可见终端）+ 自包含运行时自举。见 `docs/VSCODE-EXTENSION-RELEASE.md` |
| Headless | `tianshu -p` | 脚本 / CI（兼容 `rivet -p`） |
| MCP | `src/mcp/` | 外部工具以 `mcp__*` 进入同一审批链 |

## 关键设计决策

1. **Prefix Cache 是架构级承诺** — 不是事后优化；一切注入路径优先 appendix / reminder，避免翻写前缀。
2. **CVM** — hook + AdvisoryBus + CognitiveLedger，让模型看见并修正自身状态。
3. **条件装配 > 固定清单** — hook / 工具 / 星域能力均按 deps 与开关启用。
4. **Immutable + copy-on-write** — 尤其 API 客户端变换层，防重入污染缓存 key。
5. **Fail-closed** — 未知星域、路径逃逸、高危命令、敏感文件：拒绝并解释。
6. **测试与源码近 1:1** — 事故修复必带回归；指标见 [`engineering-metrics.md`](./engineering-metrics.md)。

## 目录速查

完整表见 [`AGENTS.md`](../AGENTS.md)。规模最大的模块（`.ts`/`.tsx` 文件数，2026-07-26）：

| 目录 | 含测试 | 纯源码 | 角色 |
|------|-------|-------|------|
| `src/agent/` | 893 | 407 | 心脏 |
| `src/tools/` | 312 | 154 | 动作面 |
| `src/tui/` | 278 | 115 | 终端表面 |
| `src/server/` | 91 | 36 | 桌面 sidecar |
| `src/context/` | 69 | 30 | 认知状态 |
| `src/api/` | 51 | 22 | 模型接入 |
| `src/prompt/` | 49 | 18 | 提示词与缓存锚 |
| `desktop/` | — | 204 | GUI 表面 |

## 相关文档

- [`AGENTS.md`](../AGENTS.md) — Agent 导航、运行时数据、缓存排查、安全闸门
- [`CLAUDE.md`](../CLAUDE.md) — 构建约定与 Known Constraints
- [`star.md`](../star.md) — 星图叙事
- [`engineering-metrics.md`](./engineering-metrics.md) — 规模与测试指标
- [`user-guide.md`](./user-guide.md) — 用户手册

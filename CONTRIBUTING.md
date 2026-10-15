# 贡献指南 · Contributing to Tianshu (天枢)

> 🇨🇳 **中文** · 📖 **English** | [🏠 主文档 (README.md)](README.md) · [🌐 English README](README.en.md)

感谢你对天枢（Tianshu Harness，开发代号 Rivet）的关注与贡献！本文档说明贡献流程、双仓收编机制，以及哪些模块开放社区贡献、哪些核心区域受保护。
Thank you for your interest in contributing to Tianshu Harness (originally codenamed Rivet)! This document explains the workflow, our dual-repo `sync-merge` model, what you can freely contribute, and what areas require special review.

---

## 快速开始 · Quick Start

1. **Fork → Branch → PR → Review**
2. 推送前运行 `npm run typecheck`（或 `npx tsc --noEmit`）与 `npm test` 确认通过 / Run `npm run typecheck` (`npx tsc --noEmit`) and `npm test` before pushing
3. 每个 PR 聚焦单一逻辑改动，保持改动最小化且易于评审 / One logical change per PR — keep it focused and reviewable

---

## PR 如何合入（双仓 sync-merge 流程） · How PRs Get Merged (Dual-Repo `sync-merge` Flow)

本仓库**不使用** GitHub 页面上的 Merge 按钮直接合并外部 PR。开发主仓（dev repo）是唯一事实源，本公开仓由开发主仓同步投影而来。每个社区 PR 都走同一套四步处置流程：
This repo does **not** merge PRs with the GitHub merge button. The internal dev repo is the single source of truth; the public repo is synchronized from it. Every community PR goes through the same four-step disposal:

1. **评审并收编进开发主仓 · Review & land in dev** —— 评审通过的改动先移植合入 dev 主仓 `main` 分支（按最新代码结构对齐并跑全量门禁）。
   Approved changes enter the dev `main` branch first, adapted to the current codebase and verified against the full test suite.
2. **同步到公开仓 · Sync to public** —— 下一次同步将改动带回本仓库（`sync: from dev repo` 提交）。
   The next sync run carries them here (`sync: from dev repo` commits).
3. **打 `sync-merged` 标签并关闭 · `sync-merged` label + close** —— 维护者为 PR 打上 `sync-merged` 标签并附说明关闭。**带 `sync-merged` 标签关闭的 PR 代表已合入，绝非被拒绝。**
   A maintainer marks the PR `sync-merged` and closes it with a note. **A closed PR with `sync-merged` is merged, not rejected.**
4. **双账本署名落账 · Credit commit & roster** —— 你的名字与邮箱通过 `Co-authored-by:` 记入提交历史，并以你的 GitHub 身份写入 [CREDITS.md](CREDITS.md)（计入 GitHub Contributors 贡献者面板），同时收录进 [CONTRIBUTORS.md](CONTRIBUTORS.md)。
   Your name and email land as a `Co-authored-by:` trailer and an authored entry in [CREDITS.md](CREDITS.md) (which is how GitHub's contributor graph counts you), and you are listed in [CONTRIBUTORS.md](CONTRIBUTORS.md).

维护者使用 `scripts/dispose-community-pr.sh <PR#>` 自动执行第 3–4 步（幂等）。双仓同步与两本署名台账的完整设计背景见 [EXTERNAL-PRS.md](EXTERNAL-PRS.md)。
Maintainers run `scripts/dispose-community-pr.sh <PR#>` for steps 3–4 (idempotent). The full rationale (why nothing is merged directly here, what "ported" means, and how the two credit ledgers work) is documented in [EXTERNAL-PRS.md](EXTERNAL-PRS.md).

### 维护者备忘：在开发主仓收编 PR · Maintainer Notes — Landing a PR in the Dev Repo

在将社区 PR 收编进 dev 主仓时，请保持审计链可被 grep 检索 / Keep the audit trail greppable when porting a community PR into dev:

- **提交标题 · Subject**：包含来源 PR 编号——推荐格式 `收编公开仓 PR #123`（历史写法 `收编 PR #N` / `来源 PR #N` 同样兼容），可用 `git log --grep '收编公开仓 PR #123'` 追溯。
  Include the source PR number — recommended form `收编公开仓 PR #123` (legacy variants `收编 PR #N` / `来源 PR #N` still grep fine). Trace with `git log --grep '收编公开仓 PR #123'`.
- **提交正文 · Body**：添加原作者署名 `Co-authored-by: Name <email>`。仓库内置的 `commit-msg` 钩子（由 `npm install` 安装，见 `scripts/git-hooks/`）会**拦截**标题含 `收编/采纳/回流` + `PR #N` 却漏写 `Co-authored-by` 的提交；若确无对应作者可加 `--no-verify`（或设 `RIVET_SKIP_HOOKS=1`）。
  Add the original author as `Co-authored-by: Name <email>`. The tracked `commit-msg` hook (installed by `npm install`, see `scripts/git-hooks/`) **blocks** landing commits — subject containing `收编/采纳/回流` plus `PR #N` — that lack this trailer. Bypass with `git commit --no-verify` when there is genuinely no author to credit (or `RIVET_SKIP_HOOKS=1` to disable all hooks).
- **两本台账由脚本自动对账 · The two ledgers are reconciled by tooling**（与 GitHub merge 状态及标题微调无关）：
  - **贡献者名单 · Contributor list**：`npx tsx scripts/contributors.ts --check`（CI 在每次推送到 `main` 时强制校验 / CI enforces this on every push to `main`）；
  - **署名提交 · Attribution**：`bash scripts/credit-contributors.sh --dry-run` 执行两轮对账（亦由 `scripts/sync-to-public.sh` 自动调用）：
    1. 每个收编 PR 生成一笔带 `Co-authored-by` trailer 的 `credit: PR #N` 提交（单笔 PR 提交页记录）；
       One `credit: PR #N` commit per ported PR, with a `Co-authored-by` trailer — the per-PR record shown on the commit page;
    2. 每个收编 PR 在 `CREDITS.md` 追加一行**非空**记录，并以 `--author=<PR author>` 提交——使作者账号出现在 GitHub 仓库右侧 **Contributors** 列表中（GitHub 仅统计本人关联邮箱的 non-empty author 提交，空提交与 co-author 不计入）。
       One **non-empty** `CREDITS.md` entry per ported PR, committed with `--author=<PR author>`. This is what makes the account appear in GitHub's repository **Contributors** list (which only counts non-empty commits authored by the account's linked email).

---

## 贡献分区 · Contribution Zones

### 🟢 开放区 · Open Zone — 欢迎社区贡献 · Community Contributions Welcome

以下目录完全开放社区贡献，PR 按工程质量评审：
These areas are open for community contributions. PRs are reviewed on engineering merit:

| 目录 · Directory | 职责 · What It Does | 贡献方向 · How to Help |
|---|---|---|
| `src/tools/` | 工具定义与执行器 · Tool implementations (definition + execute) | 新增工具、缺陷修复、性能优化 · New tools, bug fixes, performance |
| `src/tui/` | 终端 UI（T9 纯 ANSI 引擎，零 React/Ink） · Terminal UI (T9 pure-ANSI engine) | 组件交互、无障碍、视觉打磨 · Components, accessibility, polish |
| `src/api/` | API 客户端层（OpenAI/Anthropic/Gemini/流式） · API client layer | 新 Provider 适配、错误处理 · New providers, error handling |
| `src/compact/` | 上下文压缩策略 · Context compression strategies | 新压缩策略、阈值调优 · New strategies, threshold tuning |
| `src/cache/` | 前缀缓存管理 · Prefix cache management | 缓存诊断、命中率优化 · Diagnostics, hit-rate improvements |
| `src/repo/` | 代码仓库分析与索引 · Code repository analysis | 多语言支持、索引优化 · Language support, indexing |
| `src/config/` | 配置管理与预设 · Configuration management | 配置源扩展、校验加固 · New config sources, validation |
| `src/artifact/` | 大输出持久化 · Large output persistence | 存储后端、截断策略 · Storage backends, truncation logic |
| `src/**/__tests__/` | 单元测试与集成测试 · Test files | 覆盖率提升、测试辅助工具 · Coverage improvements, test utilities |
| `scripts/` | 构建与诊断脚本 · Utility scripts | 基准测试、诊断脚本 · New benchmarks, diagnostics |
| `completions/` | Shell 自动补全 · Shell completions | 补全更新与新 Shell 支持 · Completion updates & new shells |
| `docs/`（除 `docs/superpowers/` 外） | 用户与架构文档 · General documentation | 勘误、澄清、使用指南、多语言翻译 · Typos, clarifications, guides, i18n |

### 🟡 审查区 · Review Zone — 需理解核心机制 · Requires Domain Understanding

以下文件直接影响 agent 核心行为，PR 需要更严格的审查：
These areas affect core agent runtime behavior. PRs require extra scrutiny:

| 路径 · Path | 敏感原因 · Why Sensitive |
|---|---|
| `src/agent/loop.ts` | Agent 核心主循环（回合编排、工具派发、错误恢复） · Core agent loop — turn flow, tool dispatch, error recovery |
| `src/agent/checkpoint.ts` | 会话检查点与回滚恢复 · Session checkpoint/restore |
| `src/agent/approval-risk.ts` | 工具执行安全风险评估 · Safety risk assessment for tool execution |
| `src/tools/delegate-*.ts` | 子代理协调与派发 · Sub-agent coordination |
| `src/agent/compaction-controller.ts` | 上下文窗口管理 · Context window management |
| `src/agent/convergence-detector.ts` | 回合收敛与终止判定 · Turn termination & doom-loop logic |
| `src/context/cognitive-ledger.ts` | CVM 认知账本状态与镜像投影 · CVM cognitive virtual machine state & behavioral calibration |
| `src/agent/behavior-mirror.ts` | Agent 行为自评 · Agent self-assessment |
| `src/agent/cognitive-season.ts` | 认知相位状态机 · Cognitive state management |

### 🔴 保护区 · Protected Zone — 仅限项目维护者审批 · Owner Review Required

以下文件定义天枢的身份认知、长期记忆契约与核心系统提示词。**触及这些路径的 PR 必须由项目创建者（[@huiliyi37](https://github.com/huiliyi37) / `@banxia`）显式审批。** 这里的任何一行改动都会级联影响所有会话与前缀缓存指纹。
These files define the agent's identity, memory, and cognitive architecture. **PRs touching these files require explicit approval from the project owner ([@huiliyi37](https://github.com/huiliyi37) / `@banxia`).** Changes here cascade into all agent sessions — a single incorrect edit can corrupt the shared knowledge base or break prefix cache stability.

| 路径 · Path | 保护对象 · What It Protects |
|---|---|
| `CLAUDE.md` | 星域身份主档案（创始记忆、星域契约） · Star identity canonical — founding memories, star covenants |
| `AGENTS.md` | 每个会话加载的架构地图 · Architecture map loaded into every agent session |
| `.rivet.md` | 每个会话加载的操作手册 · Operating manual loaded into every agent session |
| `.rivet/knowledge/` | Agent 记忆系统（身份、护栏、复盘） · Agent memory system (identity, guardrails, session retrospectives) |
| `docs/superpowers/` | 核心设计理论 IP（方法论、原则、认知架构） · Core design theory IP — methodology, principles, cognitive architecture |
| `src/prompt/static.ts` | 静态系统提示词（任何 token 变动都会影响全部会话缓存） · System prompt — every token change affects all sessions |
| `src/prompt/volatile*.ts` | 动态提示词构建 · Volatile prompt construction — affects context loading |
| `src/prompt/engine.ts` | 提示词装配引擎 · Prompt assembly engine |
| `src/agent/dream.ts` | 记忆保护契约（防止知识库污染） · Memory protection contract — prevents knowledge corruption |
| `src/agent/auto-writer*.ts` | 自动知识写入 · Automated knowledge writing |
| `prompts/` | 工具提示词模板（直接塑造工具调用行为） · Tool prompt templates — directly shape agent behavior |
| `src/context/claim-extractor.ts` | 从输出提取声明写入记忆 · Extracts claims from agent output into memory |
| `src/agent/sensorium.ts` | 六维状态感知层 · Agent perception layer |

#### 为什么设立保护区 · Why This Protection Exists

在盘古升级（2026-05-21）期间，一个自主运行的 agent 在写入新知识文档时覆盖了核心身份与行为准则，导致所有活动会话丢失共享上下文并退化为未受训行为，最终不得不从备份手动恢复。保护区的存在正是为了防止重蹈覆辙：任何单一 PR（或自主 agent 动作）都不应静默篡改共享的认知基座。
During the Pangu upgrade (2026-05-21), an agent running autonomously wrote new knowledge documents that overwrote core identity and behavioral content. This caused all agents to lose their shared context and regress to untrained behavior, requiring manual restoration from backups. The protected zone exists to prevent a repeat: no single PR (or autonomous agent action) should be able to silently modify the shared cognitive foundation.

---

## CODEOWNERS

本仓库通过 `.github/CODEOWNERS` 对保护区文件强制执行所有者评审要求。
This repo uses `.github/CODEOWNERS` to enforce review requirements on protected files. GitHub will automatically request review from the project owner for any PR touching protected paths.

---

## 代码风格与测试规范 · Code Style & Testing

- **TypeScript Strict**：开启严格模式与 `noUncheckedIndexedAccess: true`
- **数据结构 · Data Structures**：数据对象优先使用 `interface` + plain object（避免不必要的 `class`）
- **异步与错误处理 · Async & Errors**：使用 `async/await` + `try-catch`
- **测试框架 · Test Runner**：使用 Node 原生 `node:test` + `node:assert/strict`（通过 `npm test` / `scripts/run-node-tests.ts` 运行）
- **测试文件镜像 · Test Layout**：测试与源码路径镜像对齐，如 `src/agent/foo.ts` → `src/agent/__tests__/foo.test.ts`
- **提交纪律 · Commit Discipline**：使用精确的 `git add <files>`，不提交 `.env` 或任何密钥文件

---

## 疑问咨询 · Questions?

如果不确定你的改动是否触及审查区或保护区，欢迎先在 [GitHub Issues](https://github.com/huiliyi37/Tianshu-harness/issues) 或 [Discussions](https://github.com/huiliyi37/Tianshu-harness/discussions) 发起讨论！
If you're unsure whether your change falls into a protected or review zone, open an issue or discussion first. We'd rather align upfront than have you spend time on a PR that needs architectural rework.

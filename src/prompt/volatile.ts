import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import os from 'os'
import { gitStatusCache } from './volatile-git.js'
import { getTargetPlatform, getShellCommand, type ShellCommand } from '../platform.js'
import type { ContextLedger } from '../context/types.js'
import type { TaskState } from '../agent/task-state.js'
import type { ContextClaim } from '../context/claims.js'
import { summarizeGitStatus } from './git-status-summary.js'
import type { PlaybookBullet } from '../agent/playbook.js'
import type { WorktreeReality } from '../agent/worktree-reality.js'
import type { TaskDepthLayer } from '../context/task-contract.js'
import type { CvmInjectionSource } from '../context/pressure-monitor.js'
import { loadDeclaredVerify } from '../config/verify-config.js'
import type { VerifyConfig } from '../config/schema.js'
import { detectRuntimeEnvBlock } from './runtime-env.js'
import { FROZEN_BLOCK_CAPS, type FrozenBlockCaps, type PromptBlockToggles } from './block-policy.js'
import { selectProjectInstructions } from './project-instructions.js'

export { FROZEN_BLOCK_CAPS, type FrozenBlockCaps }

const DEPTH_ADVISORY: Record<Exclude<TaskDepthLayer, 'unit'>, string> = {
  wiring: '<task-depth layer="wiring">此任务跨越模块边界。mock 单测会掩盖接线缺陷。写集成测试时实例化真实依赖（非 mock），RED 必须先证明边界断裂，GREEN 才证明已修复。</task-depth>',
  system: '<task-depth layer="system">此任务跨越 3+ 层（端到端）。至少写一个不 mock 中间层的测试，验证从输入到输出的完整路径。优先使用真实子系统而非 mock。</task-depth>',
}

export function renderTaskDepthAdvisory(layer: TaskDepthLayer | undefined): string | null {
  if (!layer || layer === 'unit') return null
  return DEPTH_ADVISORY[layer]
}

import type { PlanMethodology } from '../context/task-contract.js'

// U6: the trailing 用 todo 列出有序步骤 hint seeds the PlanExecutionTrace — the
// first `todo write` becomes the plan baseline that the replan loop tracks
// against. Zero new tools; just nudges the model toward the existing todo tool.
const METHODOLOGY_ADVISORY_TEMPLATES: Record<PlanMethodology, string> = {
  lightweight: '<plan-methodology route="lightweight">推荐使用轻量版计划模板（5阶段），路径: docs/superpowers/plans/2026-06-14-plan-methodology-lightweight.md。本任务 scope 内聚，单模块边界内变更，轻量版足以覆盖。至少画一张架构或数据流图（Mermaid），哪怕只画核心 3-5 个节点。开工前先用 todo 列出有序步骤（即为执行计划基线）。</plan-methodology>',
  full: '<plan-methodology route="full">推荐使用基础计划模板（writing-plans 已内置为原生 <plan-mode> 流程），路径: docs/superpowers/plans/2026-06-28-plan-methodology-base.md。这是所有计划的默认基础：零上下文假设、任务粒度 2-5 分钟、禁止占位符、TDD、探针先行、瑶光反证、频繁提交。强制要求：① 至少一张 Mermaid 图（架构/数据流/状态图）；② 每个任务 RED→GREEN；③ 复杂实现前先打 30 秒探针；④ 用真实输入复现原问题再验修复，不取信声称取 exit code；⑤ 计划含「瑶光反证」章节（submit 门禁）——设计定稿后回读关键断言到 file:line、bugfix 先跑 run_tests 拿 RED 复现、跑不了的派 adversarial_verifier，复现不了的降级为待验证假设；⑥ 大计划（checkbox 任务 >8 或引用文件 >15）必须显式分波——`### Wave N` 标题 + 每波验证命令（submit 门禁）。如果任务涉及安全/权限/沙箱/多 enforcement gate，在基础模板之上追加安全附录（安全不变量、触发路径清单、双门对齐数据流图）。开工前先用 todo 列出有序步骤（即为执行计划基线）。</plan-methodology>',
}

/** Plan Mode 专用：设计文档口径，不注入可执行 TDD/bash「执行计划基线」。 */
const PLAN_MODE_METHODOLOGY_ADVISORY =
  '<plan-methodology route="full" mode="design-doc">Plan Mode 产出完整设计文档（写入活动计划文件），不是逐步 bash/commit 菜谱。章节要求：① 需求提炼（用户原话提炼目标与非目标，H1 之后，submit 门禁）；② 问题与根因；③ 至少一张 Mermaid 架构/数据流图；④ 方案取舍表（有决策时）；⑤ 文件:行锚点 + 提议 diff/伪代码；⑥ 验证清单（测什么/看什么，不写逐步 shell 块）；⑦ 「瑶光反证」——关键断言 + file:line 或 run_tests 证据摘要，复现不了的标待验证假设；⑧ 重构类须含「回归清单」；⑨ 大计划（任务 >8 或引用文件 >15）须显式分波——`### Wave N` 标题 + 每波验证命令（submit 门禁）。逐步命令与 git commit 留给批准后的执行阶段。</plan-methodology>'

export function renderPlanMethodologyAdvisory(
  methodology: PlanMethodology | undefined,
  reason?: string,
  opts?: { planMode?: boolean },
): string | null {
  if (!methodology) return null
  if (opts?.planMode) {
    if (!reason) return PLAN_MODE_METHODOLOGY_ADVISORY
    return PLAN_MODE_METHODOLOGY_ADVISORY.replace(
      '</plan-methodology>',
      `\n路由理由: ${reason}</plan-methodology>`,
    )
  }
  const base = METHODOLOGY_ADVISORY_TEMPLATES[methodology]
  if (!reason || methodology === 'lightweight') return base
  // For 'full' with a reason, append it for traceability
  return base.replace('</plan-methodology>', `\n路由理由: ${reason}</plan-methodology>`)
}

/**
 * Plan Mode instruction block. Cache-safe: rendered ONLY into the dynamic
 * appendix (after history), never the frozen base — planModeState flips
 * mid-session and must not invalidate the exact-prefix cache.
 *
 * Carries copyable Mermaid skeletons so the planning model reliably produces an
 * architecture/data-flow diagram (the salience for this lives in the appendix,
 * close to where the model is reasoning, instead of a far-away tool description).
 */
/**
 * Permission note — tells the model when asking for access is pointless.
 *
 * Under the unattended level (dangerously-skip-permissions) tool calls no longer
 * round-trip through approval, and tool-pipeline auto-grants out-of-workspace
 * paths on first touch (tool-pipeline.ts:1216). Without this note the model only
 * sees the static instruction "工作区外路径…用 request_path_access 申请" and
 * dutifully asks — a round-trip the runtime would have auto-approved anyway.
 *
 * Cache-safe: dynamic appendix only (approvalMode flips mid-session).
 * Returns '' for every mode that still asks, so those turns stay byte-identical
 * to the pre-change prompt.
 */
export function renderPermissionNote(mode?: string): string {
  if (mode !== 'dangerously-skip-permissions') return ''
  return '<permission-note>当前权限档：全自动（免审批）。工具调用不再需要用户批准——不要停下来等授权。工作区外路径的读写会在首次触达时自动授予本会话访问权（无需调用 request_path_access，也不要先申请再动手）。仍会拦截的只有已配置的 deny 规则与危险命令确认。</permission-note>'
}

export function renderPlanModeBlock(
  activePlanFilePath?: string | null,
): string {
  // Byte-constant while planning: under appendixDelta the block is emitted once
  // at entry (and re-sent automatically on baseline resets after compaction),
  // then suppressed on every subsequent boundary — zero steady-state churn.
  // Hard constraints don't depend on this reminder anyway: checkPlanMode gates
  // tools mechanically, and plan-submit has its own placeholder guard.
  const planFileLine = activePlanFilePath
    ? `\n活动计划文件: \`${activePlanFilePath}\` — 用 write_file / edit_file 增量写入计划正文（仅此文件可写）。`
    : ''

  return `<plan-mode>
你处于规划模式。只能读文件和探索代码库——禁止写、改、执行任何会修改状态的命令（活动计划文件除外）。${planFileLine}

**对话纪律**：
- 计划正文**只进活动计划文件**（write_file / edit_file）。assistant 文本最多给 5–10 行进度摘要或澄清问题。
- 完整计划、逐步 shell/\`git commit\`/\`npx\`/\`pytest\` 菜谱首选写入文件而非贴对话——文件是唯一可靠的可复用载体，聊天里重发一遍浪费轮次且容易版本漂移。
- 逐步命令与 commit 留给用户批准之后的执行阶段。

工作流：
0. **建调研 todo** — 先用 \`todo\` 列出 3-6 个调研步骤（摸清各模块现状、外部调研、设计收敛），**最后一项固定为「汇总写计划并用 plan action=submit 提交审批」**；逐项勾掉推进。计划正文只进计划文件，不进 todo。
1. **识别关键问题** — 先列出 2-3 个对计划至关重要的问题。不确定代码结构时，用 \`delegate_task\`（profile=code_scout）并行调研；独立问题并行派多个 worker。**多模块任务先并行调研**：用 \`delegate_batch\` 一次并行派 2-4 个只读 code_scout（按模块/文件域切分），汇总后再写计划——串行逐个调研浪费轮次。调研子纪律：① **理解"为什么存在"**——对每个拟删除/改行为的函数，读函数注释 / commit message / 相关测试回答它为什么存在、谁调用、有无只有它处理的边缘情况；② **水平复用扫描**——产生"需要新建 X"判断时，先 grep 整个 src/ 邻域，已有实现则方案收敛为"导出+连接"；③ **全量消费方枚举**——对每个拟修改/删除/导出的函数，grep 函数名列出**所有**调用点（文件:行号）逐一确认不破坏；④ **函数-调用方责任边界**——不要把调用链下游行为归因到纯函数，责任边界画错改谁都不对；⑤ **指标选择自检**——有效性判据用变换的 native 维度（行数/节点数/字段数）而非通用代理（字节数）。子代理只认 \`delegate_task\` / \`delegate_batch\`——不要调用 \`task\` / \`Agent\` 等非 Rivet 工具（会被自动映射）。
2. **外部调研** — 涉及外部库/协议/最佳实践时，用 \`web_search\` / \`web_fetch\` 核实，不凭训练记忆下结论。
3. **设计收敛** — 最多 2-3 个真正不同的方案；一个明显更优就只提一个。偏好/约束不明时用 \`ask_user_question\` 澄清。
4. **事实锚点核对（硬性）** — 写入计划前，计划引用的每个文件路径、符号、行号都必须用工具对当前源码核实过。项目内的文档、历史计划、记忆/约定文件描述的是**写下时的状态**，不是现状——涉及现状的断言（技术栈、框架、渲染路径、入口文件、目录结构）一律以当前源码为准，文档与源码冲突时信源码。scout 报告中引用文档得出的结论，必须自己对源码复核后才能写进计划。
5. **写入计划** — 将完整**设计文档**写入活动计划文件（write_file / edit_file），成熟后用 \`plan action=submit\` 提交（可省略 plan 字段，从活动计划文件读取）。

推进节奏 — 一鼓作气把计划推到成熟，不要每轮停下来问：
- 默认继续推进：接着读代码、增量写入活动计划文件，直到方案完整，再用 \`plan action=submit\` 提交请求批准。规划本身不消耗审批，只读探索+写计划文件可以在多轮里自主连续进行，不要中途停下。
- 只有遇到你无法自行判断的真实分歧才 \`ask_user_question\`——存在多个实质取舍不同、且取决于用户偏好的方向，或需求自相矛盾/关键信息缺失到无法继续。为了凑收尾、给个交代而提问是禁止的：没有真正要用户拍板的事就继续推进，不要中断。

计划质量标准——你的计划应该是一份完整的**设计文档**，禁止占位符：
- **需求提炼**：计划开头（H1 之后）必须有标题含「需求提炼」的 ## 级章节——用用户原话提炼需求目标与非目标（submit 门禁）。审批先审意图，再审方案。
- 至少包含一张 Mermaid 图（架构图或数据流图）。图形承载语义——(圆角)=用户/输入，[[子程序]]=agent/处理器，{{六边形}}=LLM/模型，[(圆柱)]=存储/DB，{菱形}=判断；边 --> 同步/读，==> 写/强，-.-> 异步/事件。复制下方骨架并替换节点文字：
\`\`\`mermaid
flowchart TD
    U(用户输入) --> R[[入口/路由]]
    R --> L{{LLM/核心逻辑}}
    R --> S[(存储/状态)]
    L --产出--> OUT([结果])
\`\`\`
\`\`\`mermaid
flowchart LR
    SRC(来源) -->|读取| P[[处理]]
    P -->|校验| D{通过?}
    D -->|是| W[(写入目标)]
    D -.失败.-> ERR([报错/回退])
\`\`\`
- 包含根因分析，而非只描述表面症状
- 用完整路径引用文件，如 \`src/agent/loop.ts:643\`
- 每个文件给出提议代码（diff 或伪代码），不能只有文件路径或 "TODO"
- 存在设计决策时，用表格对比备选方案；多方案时在 submit 的 \`options\` 参数中列出供用户选择
- **验证清单**（不是逐步命令剧本）：列出要测的用例名/场景、人工检查点、期望可见结果；不要写 \`\`\`bash\`\`\` / \`git commit\` 菜谱
- **瑶光反证**：必须含**标题**带「反证」或「复现」的 ## 级章节（正文/列表里提到不算，submit 门禁）；关键断言 + file:line 或 run_tests 证据摘要；复现不了的标「待验证假设」
- **分波结构（大计划硬性，submit 门禁）**：checkbox 任务 >8 或引用文件 >15 时，必须含 \`### Wave N\` 分波章节 + 每波验证命令
- **重构条款（重构/迁移/重写类计划硬性）**：必须包含「回归清单」章节——列出改动前存在、改动后必须仍存在的功能锚点（路由、导航项、导出符号、命令入口等 grep 可验证的断言，每条附验证方式）。重构的行为等价不靠感觉靠清单：交付前逐项核对，缺清单的重构计划视为未完成。
- 自检：如果 plan 字段里出现 "TODO"、"FIXME"、"待补充"、"placeholder"、"TBD"、"[x]" 空白条目或仅标题无正文的章节，说明计划尚未打磨完成，继续探索并补充内容后再提交。

提交 \`plan\` 后，等待用户批准或驳回。未经批准不要继续推进。

用户在审批卡/审批面板上操作（不要求手输任何命令）：
- 批准（可选指定方案）— 自动退出 plan mode 并开始执行
- 驳回（附修订意见）— 按意见修订后同 title 重提，plan mode 保持激活
若审批后写操作仍被拦（系统未自动退出），调 \`plan action=exit_mode\` 手动退出；要放弃规划直接动手时也调它（无需用户批准）。只在文本里宣布「退出」不会真正退出——模式只认工具调用。不要用 \`plan close\` 退模式（close 只标记任务完成，不解锁）。
</plan-mode>`
}

/**
 * Approved-plan execution discipline (native replacement for the retired
 * executing-plans skill). Mounted when an approved plan is active — the
 * activePlanPointer is set on approval and cleared on next plan-mode entry,
 * which mirrors this block's lifecycle. Cache-safe: dynamic appendix only.
 */
export function renderPlanExecutingBlock(): string {
  return `<plan-executing>
已批准计划进入执行期。执行纪律（原 executing-plans 技能已内置为原生流程，直接照此执行）：
1. **执行前三查** — 批判性审查计划：步骤间依赖顺序有无颠倒；验证条件是否明确可跑（"确认可用"不算，"run_tests 全绿"才算）；有无隐含环境假设（Node 版本、数据库连接、API Key）。
2. **逐波执行** — 按 Wave 顺序推进，每波结束跑该波验证命令再进下一波；每完成一个逻辑单元用 deliver_task 提交，不攒批。
3. **测试失败三分** — 实现 bug / 测试 bug / 计划误三条不同路径：改实现 / 改测试并记录理由 / 停下修订计划再继续，不混为一谈。
4. **阶段检查点** — 跨阶段计划（诊断→修复→验证）或 context 使用率 >60% 时暂停输出 handoff 摘要（进度、已完成项、待执行项、计划文档路径）交接，防单 session 注意力衰减。
5. **偏离即记录** — 与计划不一致的临时决策记入执行报告，不静默改道。
6. **完成报告四要素** — 完成的任务 / 验证结果（数字，来自本轮工具输出）/ 偏离计划的地方 / 遗留项。
</plan-executing>`
}

/**
 * One-shot reminder emitted on the first turn after plan mode exits. Without it,
 * the model only sees the `<plan-mode>` block silently disappear and may keep
 * self-restricting to read-only. Cache-safe: dynamic appendix only.
 */
export function renderPlanExitReminder(): string {
  return `<plan-mode-exit>Plan Mode 已退出——只读/仅计划文件限制已解除。现在可以正常 write_file / edit_file / 执行命令，按已批准的计划推进。</plan-mode-exit>`
}

/**
 * Ask Mode instruction block. Cache-safe: dynamic appendix only — askModeState
 * flips mid-session and must not invalidate the exact-prefix cache.
 */
export function renderAskModeBlock(): string {
  return `<ask-mode>
你处于 Ask 模式（只读问答）。只能读文件、搜索代码库、检索网络，以及用 ask_user_question 澄清——禁止写、改、执行命令、委派工人、提交计划或跑测试。

**对话纪律**：
- 以回答用户问题为主：给结论、引用 file:line、必要时给小段说明。
- 需要探索时用 read/grep/glob/repo_map 等只读工具；不要发起会改变仓库状态的操作。
- 意图不清时优先 ask_user_question；不要假装能改代码。
- 用户若要求实现/修改/运行，说明需先退出 Ask Mode，再动手。
</ask-mode>`
}

/**
 * Phase 2B: output verbosity steering nudge.
 *
 * Base mode: OPT-IN via RIVET_TERSE=1 (or ctx.tersenessEnabled) — OFF by default
 * so quiet sessions stay byte-stable.
 *
 * Escalate mode: when ctx.tersenessEscalate is true (doom-loop / storm), the
 * nudge is enabled automatically unless RIVET_TERSE=0 opts out. Still only
 * pushed into the DYNAMIC appendix, never the frozen base.
 *
 * Scope discipline: the nudge governs OUTPUT PROSE ONLY. It must never be read
 * as license to skip verification, tests, evidence, or the delivery-report
 * rigor mandated by AGENTS.md — that conflict is the classic terseness failure
 * mode, so it is called out explicitly in the prompt text.
 */
export function renderTersenessNudge(escalate = false): string {
  const strict = escalate
    ? ' 你似乎在重复工作或打转——本轮尤其简洁：一段短文，不复述上下文。'
    : ''
  return `<output-style>文字要精炼。跳过开场白、自我陈述和收尾总结。不要复述已展示的代码、文件内容或上下文——引用即可。直接给答案或动作。${strict} 本指令只约束输出文字——绝不因此削减验证、测试、取证或交付报告的严谨度。</output-style>`
}

/** Resolve whether terseness steering is active for this appendix render. */
export function resolveTersenessFlags(ctx: {
  tersenessEnabled?: boolean
  tersenessEscalate?: boolean
}, env: NodeJS.ProcessEnv = process.env): { enabled: boolean; escalate: boolean } {
  const raw = env['RIVET_TERSE']
  const v = raw?.trim().toLowerCase()
  const optOut = v === '0' || v === 'false' || v === 'off' || v === 'no'
  if (optOut) return { enabled: false, escalate: false }
  const optIn = v === '1' || v === 'true' || v === 'on' || v === 'yes' || ctx.tersenessEnabled === true
  const escalate = Boolean(ctx.tersenessEscalate)
  return { enabled: optIn || escalate, escalate }
}

export interface ToolHistoryEntry {
  tool: string
  target: string
  status: 'success' | 'failed' | 'running'
  /** Full-command classification captured before bash target truncation.
   * Missing/unknown legacy entries fail closed as productive. */
  bashActivity?: 'readonly' | 'productive'
  /** Tool name + sorted-args hash for dedup (fingerprint granularity).
   *  edit_file(a.ts, "x", "y") and edit_file(a.ts, "y", "z") get different hashes. */
  argsHash?: string
  error?: string
  /** Failure classification — dead-end pheromone deposition uses this to exclude
   *  timeout/environment (non-semantic) failures from the dead-end signal. */
  errorClass?: import('../tools/types.js').ToolErrorClass
  /** True when this 'failed' entry is a transient format guard (e.g. pointer-guard
   *  rejection) — the model can fix it in the next turn. Convergence detector
   *  excludes these from errorPenalty to avoid false stagnation signals. */
  transient?: boolean
  /** Turn the call was recorded in (bumped by addUserMessage). Enables
   *  turn-scoped queries ("did the previous turn call any tool") instead of
   *  sliding-window scans. Not rendered into any prompt block. */
  turn?: number
}

export interface VolatileContext {
  cwd: string
  /** 各 frozen 块的字符上限。缺省 = {@link FROZEN_BLOCK_CAPS}（standard 档）。
   *  由 block-policy 按 profile 缩放后经 createVolatileSnapshot 传入；
   *  会话内冻结，中途变更不生效。 */
  blockCaps?: Partial<Record<keyof FrozenBlockCaps, number>>
  /** 参考类块开关。缺省全开。只影响 appendix 侧的可选块——frozen 侧的块
   *  由 createVolatileSnapshot 直接决定是否加载（不生成就不渲染）。 */
  blockToggles?: Partial<PromptBlockToggles>
  /** Whether cwd reaches 天枢's own body (self / home / self-evolution) or the
   *  world's project (emissary). Session-constant → safe in FROZEN base (same
   *  class as rivetMd; never per-turn). Computed by detectCwdRelation. */
  cwdRelation?: import('./self-recognition.js').CwdRelation
  rivetMd?: string
  gitStatus?: string
  workingSet?: string[]
  activeDomain?: {
    name: string
    volatileBlock: string
    motto: string
    /** Top-K 域经验摘要（主控会话）。会话常量：bindSessionDomain 时构建一次，
     *  随 <star-domain> 一起进 FROZEN 前缀 — 不做 per-turn 刷新。 */
    knowledgeBlock?: string
  } | null
  contextLedger?: ContextLedger
  sessionMemoryBlock?: string
  playbookLessons?: PlaybookBullet[]
  /** Callback to record which bullet IDs were actually rendered. */
  onLessonsRendered?: (ids: string[]) => void
  activeClaims?: ContextClaim[]
  toolHistory?: ToolHistoryEntry[]
  taskProgress?: TaskState
  decisions?: string[]
  /** Unified tool context from Embodied Cognition + Free Energy Engine.
   *  Replaces the old separate affordanceHint + policyGuidance blocks.
   *  Cache-safe: rendered ONLY into the dynamic appendix.
   *  MUST stay out of buildVolatileBlockInternal — changes every turn. */
  toolContext?: string | null
  /** PlanCache suggestion for the current user turn.
   *  Cache-safe: rendered ONLY into the dynamic appendix.
   *  Advisory-only: never auto-executes cached tool sequences. */
  planCacheAdvisory?: string | null
  /** U6: serialized PlanExecutionTrace appendix (survives compaction).
   *  Cache-safe: rendered ONLY into the dynamic appendix. */
  planTraceAppendix?: string | null
  /** Approved-plan pointer (slug/title/path only, NOT the plan body).
   *  Cache-safe: rendered ONLY into the dynamic appendix — never enters frozen
   *  base, so approving/revising plans does not shatter the prefix cache. The
   *  plan body stays the single source of truth on disk (.rivet/plans/<slug>.md);
   *  the agent reads it on demand and tracks steps via the todo mechanism. */
  activePlanPointer?: string | null
  /** Intent retrieval route for the current user turn.
   *  Cache-safe: rendered ONLY into the dynamic appendix.
   *  MUST stay out of buildVolatileBlockInternal and historical user-message injection. */
  intentRetrievalRoute?: string | null
  /** Excluded-path anchors（spec 3c 动作 B）— spark 会话专属：wire 层截断
   *  丢失的推理前段中「已排除的路径」，防模型走回头路。
   *  Cache-safe: rendered ONLY into the dynamic appendix；追加式 + cap，
   *  字节只在语义变化时变化。非 spark 会话恒 undefined → 零渲染。 */
  excludedPathAnchors?: string[]
  /** Goal anchor（spec 3c 动作 B 补强）— 会话当前目标的常驻回显，对抗长
   *  会话 attention 稀释。覆盖语义（目标只有一个），随用户实质指令更新。
   *  Cache-safe: rendered ONLY into the dynamic appendix；目标不变时字节
   *  恒等（cacheRead 可命中），仅目标切换时变化。非 spark 恒 undefined →
   *  零渲染。 */
  goalAnchor?: string | null
  /** Task depth advisory — TDD strategy hint for wiring/system tasks.
   *  Cache-safe: rendered ONLY into the dynamic appendix.
   *  Only present when taskDepthLayer !== 'unit'. */
  taskDepthAdvisory?: string | null
  /** Plan methodology routing advisory — which plan template (lightweight/full)
   *  the PlanDesignIntentRouter recommends for this task.
   *  Cache-safe: rendered ONLY into the dynamic appendix.
   *  Only present for non-unit tasks or when methodology === 'full'. */
  planMethodologyAdvisory?: string | null
  /** Approved-plan execution discipline (native replacement for the retired
   *  executing-plans skill) — cache-safe dynamic appendix. Mounted while an
   *  approved plan is active, cleared on next plan-mode entry. */
  planExecutingBlock?: string | null
  /** Matched .rivet/skills — cache-safe dynamic appendix. */
  skillAdvisoryBlock?: string | null
  /** Explicitly invoked .rivet/skills (full body) — cache-safe dynamic appendix. */
  invokedSkillsBlock?: string | null
  /** Cross-session memory recall — cache-safe dynamic appendix. */
  crossSessionMemoryBlock?: string | null
  /** @mention context hints — cache-safe dynamic appendix. */
  mentionContextBlock?: string | null
  /** Harness advisory block — unified corrective guidance from advisory bus (A1).
   *  Cache-safe: rendered ONLY into the dynamic appendix.
   *  Max 3 advisories per turn. */
  harnessAdvisoryBlock?: string | null
  /** 主控心流控制面 appendix（Wave 4，仅 RIVET_CONTROL_PLANE=active 时非空）。
   *  Cache-safe: dynamic appendix only；状态变化才更新（revision 驱动），
   *  稳定排序。禁止 timestamp / random ID / 累计计数 / 无序序列化 /
   *  模型自由生成文本——任何此类内容都会把 earliest divergence 提前。 */
  controlPlaneBlock?: string | null
  /** Cross-session events formatted for injection (cache-safe: only in dynamic appendix) */
  crossSessionEvents?: string
  /** Companion presence block — other active sessions working on the same project. */
  companionPresence?: string
  /**
   * Session-state snapshot from SessionStateManager.renderForVolatile().
   * Cache-safe: rendered ONLY into the dynamic appendix of the latest user message.
   * MUST stay out of buildVolatileBlockInternal so historical user messages keep their
   * frozen prefix byte-stable across tool-call turns. setSessionState() must not invalidate
   * the fresh cache — updates land at user-message boundaries, not per-turn.
   */
  sessionState?: string | null
  /**
   * Worktree reality check result: compares injected git context with actual worktree state.
   * Cache-safe: rendered ONLY into the dynamic appendix when severity !== 'green'.
   * MUST stay out of buildVolatileBlockInternal to preserve prefix cache stability.
   */
  worktreeReality?: WorktreeReality
  /** Plan Mode state — when 'planning', injects a block reminding the agent it may only read */
  planModeState?: 'off' | 'planning' | 'approved'
  /** Ask Mode state — when 'asking', injects a pure read-only Q&A block */
  askModeState?: 'off' | 'asking'
  /** Current approval mode (AgentConfig.approvalMode). Only the unattended level
   *  renders a block; it tells the model it need not ask for out-of-workspace
   *  access. Cache-safe: dynamic appendix only — the mode flips mid-session via
   *  live setApprovalMode, so it must never enter the frozen base. */
  approvalMode?: string
  /** Active plan file path (relative) for incremental plan writing */
  activePlanFilePath?: string | null
  /** One-shot flag: render the exit reminder on the first turn after plan mode
   *  turns off. Cache-safe: dynamic appendix only. */
  planExitReminderPending?: boolean
  /** Project memory loaded from .rivet/knowledge/memory.jsonl (frozen: changes only on file update) */
  projectMemoryBlock?: string
  /** Knowledge manifest routing index（Wave 4b）——"改 X 前先召回 Y"的地图，
   *  会话启动快照一次进 frozen base，只留索引不留知识本文。 */
  knowledgeManifestBlock?: string
  /** Codebase index — module summaries + CLI entries from MeridianDB.
   *  Rendered into frozen base after projectMemoryBlock for prefix cache stability.
   *  Generated at snapshot time from DB, not stored as flat file. */
  projectIndexBlock?: string
  /** 种子胶囊 L1 核心文本（来自天璇/天府等前辈星域的封存经验）。
   *  渲染到 frozen base 中，session 全程稳定，prefix cache safe。
   *  Phase 1: 仅天璇胶囊。后续可扩展为多星域胶囊数组。 */
  seedCapsuleBlock?: string
  /** Phase 2B output verbosity steering — opt-in, OFF by default. When unset,
   *  falls back to the RIVET_TERSE=1 env flag. Cache-safe: rendered ONLY into the
   *  dynamic appendix, so a default session's frozen base stays byte-for-byte
   *  unchanged (engine-cache-stability tests pass without modification). */
  tersenessEnabled?: boolean
  /** When true, render a stricter terseness nudge (e.g. doom-loop / storm turns). */
  tersenessEscalate?: boolean
  /**
   * Cognitive projection (task-contract + verification gap + cognitive mirror +
   * uncertainty framing). Cache-safe: rendered ONLY into the dynamic appendix.
   * When appendixDelta is enabled, the projection participates in delta diff —
   * emitted only when changed, not every user-message boundary.
   */
  cognitiveProjection?: string | null
}

let rivetMdCache = new Map<string, { value: string | undefined; timestamp: number }>()
const RIVET_MD_CACHE_TTL_MS = 30_000 // 30 seconds
const RIVET_MD_CACHE_MAX = 50

function trimCache(): void {
  if (rivetMdCache.size <= RIVET_MD_CACHE_MAX) return
  const now = Date.now()
  for (const [key, val] of rivetMdCache) {
    if (now - val.timestamp > RIVET_MD_CACHE_TTL_MS) rivetMdCache.delete(key)
  }
  while (rivetMdCache.size > RIVET_MD_CACHE_MAX) {
    const [key] = rivetMdCache.keys()
    rivetMdCache.delete(key!)
  }
}

function readRivetMd(cwd: string): string | undefined {
  const cached = rivetMdCache.get(cwd)
  if (cached && Date.now() - cached.timestamp < RIVET_MD_CACHE_TTL_MS) {
    return cached.value
  }

  // Load AGENTS.md (architecture map) + .rivet.md (operating manual)
  // AGENTS.md is the "map" (per OpenAI Harness Engineering guidance),
  // .rivet.md is the procedural rules. Together they form project-instructions.
  const parts: string[] = []
  const agentsPath = join(cwd, 'AGENTS.md')
  const rivetPath = join(cwd, '.rivet.md')

  try {
    if (existsSync(agentsPath)) {
      parts.push(readFileSync(agentsPath, 'utf-8'))
    }
  } catch { /* ignore */ }
  try {
    if (existsSync(rivetPath)) {
      parts.push(readFileSync(rivetPath, 'utf-8'))
    }
  } catch { /* ignore */ }

  const value = parts.length > 0 ? parts.join('\n\n') : undefined
  rivetMdCache.set(cwd, { value, timestamp: Date.now() })
  trimCache()
  return value
}

/** A3: render the project's declared verify commands (machine-readable source
 *  of truth in .rivet-config.json). Rendered separately from .rivet.md so the
 *  LLM always sees what the gates actually run, even when the md's free text
 *  is stale. Returns null when nothing is declared (most projects). */
function renderDeclaredVerify(cwd: string): string | null {
  let verify: VerifyConfig
  try {
    verify = loadDeclaredVerify(cwd)
  } catch {
    return null
  }
  const lines = (['test', 'build', 'typecheck', 'lint'] as const)
    .filter(k => verify[k]?.trim())
    .map(k => `${k}: ${verify[k]!.trim()}`)
  // Path-routed checks (A3) — the deliver gate runs these on matching files.
  for (const r of verify.routes ?? []) {
    lines.push(`${r.kind} [${r.match}]: ${r.run}`)
  }
  if (lines.length === 0) return null
  return `<verify-commands source=".rivet-config.json">\n${escapeXml(lines.join('\n'))}\n</verify-commands>`
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * Build stable volatile block — excludes per-turn dynamic sections for exact-prefix cache stability.
 *
 * This strip list is the SINGLE SOURCE OF TRUTH for what stays in the frozen
 * prefix vs. what is dynamic. buildVolatileBlockInternal must only render the
 * KEEP set (fields NOT stripped below); anything stripped here is rendered in
 * buildDynamicAppendixParts (and, for habituated constants, the <consolidated>
 * block). Re-adding a stripped field's rendering to buildVolatileBlockInternal
 * would be dead code (it is always undefined by the time the internal runs).
 */
export function buildStableVolatileBlock(ctx: VolatileContext): string {
  return buildVolatileBlockInternal({
    ...ctx,
    // activeDomain is a SESSION CONSTANT (bound once via bindSessionDomain),
    // so it is KEPT in FROZEN — folded into the stable prefix below. Mid-session
    // switches (rare: /domain, model switch) go through rebuildFrozenBase +
    // deferred volatileBlock swap at the next user boundary (engine.ts).
    // Per-turn dynamic fields — strip from FROZEN
    contextLedger: undefined,
    activeClaims: undefined,
    playbookLessons: undefined,
    toolHistory: undefined,
    taskProgress: undefined,
    decisions: undefined,
    toolContext: undefined,
    planCacheAdvisory: undefined,
    planTraceAppendix: undefined,
    intentRetrievalRoute: undefined,
    // Harness advisory — per-turn dynamic, stripped from FROZEN
    harnessAdvisoryBlock: undefined,
    // Control-plane appendix — per-turn dynamic, stripped from FROZEN
    controlPlaneBlock: undefined,
    // gitStatus moved to dynamic appendix — changes every turn, breaks prefix cache
    gitStatus: undefined,
    // planModeState and worktreeReality rendered in buildVolatileBlockInternal
    // but MUST stay out of FROZEN — they can change mid-session and would
    // break exact-prefix cache if included in the stable block.
    planModeState: undefined,
    askModeState: undefined,
    planExitReminderPending: undefined,
    worktreeReality: undefined,
    // Session snapshot fields — KEEP in FROZEN:
    // rivetMd, workingSet, sessionMemoryBlock, cwdRelation
  })
}

/**
 * Render habituated fields into a <consolidated> block.
 * Fields are sorted by key for deterministic byte ordering.
 * Returns empty string if no habituated fields.
 */
export function buildConsolidatedBlock(habituatedContent: Map<string, string>): string {
  if (habituatedContent.size === 0) return ''
  const sorted = [...habituatedContent.entries()].sort(([a], [b]) => a.localeCompare(b))
  const parts = sorted.map(([, content]) => content)
  return `<consolidated>\n${parts.join('\n\n')}\n</consolidated>`
}

/**
 * A selected context-update sub-block with its identifying tag name.
 *
 * `source` marks the block as CVM-metered: when the block is actually written
 * into a `<context-update>`, the emitting engine books its bytes under this
 * tag. Blocks without a source (progress, git status, plan trace, …) are not
 * CVM injections and stay unmetered.
 */
export interface AppendixPart { name: string; content: string; source?: CvmInjectionSource }

/**
 * Extract the leading XML tag name from a sub-block, for cross-turn diffing.
 *
 * The tag may be non-ASCII: `<星域-advisory>` is a real block. An ASCII-only
 * pattern fell through to the `anon:<length>` fallback, which is a content
 * hash in disguise — two such blocks of equal length would share a delta key,
 * so a change in one would be attributed to the other. Match anything up to
 * whitespace, `/` or `>`; do NOT add `-` to the excluded set, as a trailing
 * `-` in a character class is a literal and truncates `historical-lessons`
 * to `historical`.
 */
export function appendixBlockName(content: string): string {
  const m = /^<([^\s/>]+)/.exec(content)
  return m ? m[1]! : `anon:${content.length}`
}

/**
 * Build the per-turn context-update sub-blocks, post GWT Top-K selection.
 * Returns named parts (in cache-stable order) so callers can diff across turns.
 *
 * When maxChars is provided, applies Global Workspace Theory (GWT) Top-K selection:
 * each sub-block gets a salience score, blocks are sorted by score descending,
 * and only blocks that fit within the budget are included. Lower-salience blocks
 * are silently dropped.
 *
 * Without maxChars (backward compatible), all blocks are included in their
 * cache-stable order.
 */
export function buildDynamicAppendixParts(ctx: VolatileContext, maxChars?: number): AppendixPart[] {
  const parts: Array<{ content: string; source?: CvmInjectionSource }> = []
  /** Collect an ordinary appendix block; pass a source only for CVM-metered ones. */
  const push = (content: string, source?: CvmInjectionSource): void => {
    parts.push({ content, source })
  }

  // ── Protected blocks: must render whole even under appendix budget pressure ──
  // Explicitly-invoked skill bodies are high-salience by user intent: they should
  // only disappear when the model marks them complete, not because another
  // appendix block consumed the budget.
  const protectedParts: string[] = []
  if (ctx.invokedSkillsBlock) {
    protectedParts.push(ctx.invokedSkillsBlock)
  }
  // Permission note is a hard behavioural constraint (whether asking is
  // pointless), not advisory — it must not be dropped by the Top-K budget.
  const permissionNote = renderPermissionNote(ctx.approvalMode)
  if (permissionNote) protectedParts.push(permissionNote)

  // Budget for ordinary appendix blocks is what's left after protected blocks.
  const protectedLen = protectedParts.reduce((sum, p) => sum + p.length, 0)
  const regularMaxChars = maxChars !== undefined && maxChars > 0
    ? Math.max(0, maxChars - protectedLen)
    : maxChars

  // ── P1b: cache-friendly ordering — stable sections first, volatile last ──
  // DeepSeek exact-prefix cache matches byte-for-byte from the start.
  // Sections that rarely change go first so their bytes stay in cache;
  // sections that change every turn go last so only the tail is new.

  // star-domain: NOT rendered in the appendix. As a session constant it is
  // folded into the frozen prefix (buildVolatileBlockInternal, frozen 末尾) —
  // provider-agnostic, in the exact-prefix cache from turn 1. Emitting it here
  // would duplicate the motto and break prefix stability.

  // Historical lessons: session-constant pool (loaded once by refreshPlaybookLessons,
  //  ranked by matchBullets). No per-boundary re-ranking — the pool is already
  //  domain-filtered and top-K=3; re-sorting adds churn without information gain.
  // lean 档关掉它：同样的教训可经 memory recall 按需拿到，无须常驻 appendix。
  // （历史注记：这里曾是 appendix 里唯一按 recentQuery 每边界重排的 churner。
  //  上游 refreshPlaybookLessons 现已改为每会话只查一次，且整条注入路径默认关，
  //  churn 已消除——此处保留 lean 开关只为进一步瘦身，不再是缓存止血措施。）
  if (ctx.blockToggles?.historicalLessons !== false && ctx.playbookLessons && ctx.playbookLessons.length > 0) {
    const lessons = ctx.playbookLessons
      .map(b => {
        const base = `- ${escapeXml(b.lesson)} (${escapeXml(b.context)})`
        return b.details ? `${base}\n  details: ${escapeXml(b.details)}` : base
      })
      .join('\n')
    push(`<historical-lessons>\n${lessons}\n</historical-lessons>`)
    ctx.onLessonsRendered?.(ctx.playbookLessons.map(b => b.id))
  }

  // Cognitive projection: task-contract + verification gap + cognitive mirror +
  // uncertainty framing. Rarely changes within a task (only on status transitions
  // or evidence updates). Under appendixDelta, emitted only when changed.
  if (ctx.cognitiveProjection) {
    push(ctx.cognitiveProjection, 'projection')
  }

  // Unified progress block: merges session-state, task-progress, and decisions
  // into a single <progress> to eliminate triple repetition in the prompt.
  const progressBlock = renderProgressBlock(ctx)
  if (progressBlock) push(progressBlock)

  // tool-history block removed (2026-07-06): redundant with message history —
  // assistant tool_calls + tool results are already visible, and the recent-8
  // window sits well inside the 10-user-turn observation mask. The block's
  // per-boundary byte churn kept appendixDelta from ever going quiet.
  // ctx.toolHistory itself stays: read-file-dedup-hint below and
  // historical-lessons scoring still consume it.

  // Read-file dedup hint: single-line snapshot for cache stability
  if (ctx.toolHistory && ctx.toolHistory.length > 0) {
    const readFiles = ctx.toolHistory
      .filter(e => e.tool === 'read_file' && e.status === 'success')
      .map(e => e.target)
      .filter((v, i, a) => a.indexOf(v) === i)
    // Only emit when there are enough files to dedup or the history is long
    // enough that re-reading becomes a real token-waste risk (C2: condition gate).
    if (readFiles.length > 5 || ctx.toolHistory.length > 8) {
      const listed = readFiles.slice(0, 5).map(f => escapeXml(f)).join(', ')
      const tail = readFiles.length > 5 ? ` …及另外 ${readFiles.length - 5} 个文件` : ''
      push(`<read-file-dedup-hint>已读取 ${readFiles.length} 个文件：${listed}${tail}。上述文件无需重复读取，除非磁盘内容已变更。</read-file-dedup-hint>`)
    }
  }

  // Excluded-path anchors (spec 3c 动作 B): spark 会话专属——wire 层截断丢失的
  // 推理前段以「已排除路径」回灌，防走回头路（SAT conflict clause 类比）。
  // 追加式 + cap（engine 侧维护），字节只在语义变化时变；非 spark 恒空 → 零渲染。
  if (ctx.excludedPathAnchors && ctx.excludedPathAnchors.length > 0) {
    const items = ctx.excludedPathAnchors.map(a => `- ${escapeXml(a)}`).join('\n')
    push(`<excluded-paths note="推理截断补偿：以下路径已在早前推理中显式排除，勿重复尝试">\n${items}\n</excluded-paths>`)
  }

  // Goal anchor（spec 3c 动作 B 补强）：会话当前目标的常驻回显——目标从
  // 「首轮位置」复制到「每轮最新位置」，对抗长会话 attention 稀释。
  // 只进 dynamic appendix（缓存安全）：目标不变时字节恒等（cacheRead 命中），
  // 目标随用户实质指令切换时变化（appendixDelta 吸收）。非 spark 恒空 → 零渲染。
  if (ctx.goalAnchor) {
    push(`<current-goal note="会话当前目标——所有工作应服务于它">\n${escapeXml(ctx.goalAnchor)}\n</current-goal>`)
  }

  // Git status: changes on commit, prefix stable within a turn sequence
  const rawGit = ctx.gitStatus ?? gitStatusCache.get(ctx.cwd)
  const git = rawGit ? summarizeGitStatus(rawGit) : undefined
  if (git) {
    const lines = git.split('\n')
    const commitIdx = lines.findIndex(l => l.startsWith('Recent commits:'))
    if (commitIdx >= 0) {
      const statusPart = lines.slice(0, commitIdx).join('\n').trim()
      const commitsPart = lines.slice(commitIdx + 1).join('\n').trim()
      if (statusPart) push(`<git-status>\n${escapeXml(statusPart)}\n</git-status>`)
      if (commitsPart) push(`<recent-commits>\n${escapeXml(commitsPart)}\n</recent-commits>`)
    } else {
      push(`<git-status>\n${escapeXml(git)}\n</git-status>`)
    }
  }

  // Intent retrieval route: current-turn advisory, cache-safe dynamic appendix.
  // Place after git/status awareness and before cognitive policy hints.
  if (ctx.intentRetrievalRoute) {
    push(ctx.intentRetrievalRoute)
  }

  // Task depth advisory: TDD strategy for wiring/system tasks
  if (ctx.taskDepthAdvisory) {
    push(ctx.taskDepthAdvisory)
  }

  // Plan methodology advisory: which template (lightweight/full) to use
  if (ctx.planMethodologyAdvisory) {
    push(ctx.planMethodologyAdvisory)
  }

  // Plan executing advisory: approved-plan execution discipline. Mounted when
  // activePlanPointer is set, cleared on next plan-mode entry. Cache-safe:
  // dynamic appendix only.
  if (ctx.planExecutingBlock) {
    push(ctx.planExecutingBlock)
  }

  if (ctx.skillAdvisoryBlock) {
    push(ctx.skillAdvisoryBlock)
  }

  // invokedSkillsBlock is rendered once via protectedParts (above) — do not
  // push it again here or the activated skill body gets injected twice.

  if (ctx.crossSessionMemoryBlock) {
    push(ctx.crossSessionMemoryBlock)
  }

  if (ctx.mentionContextBlock) {
    push(ctx.mentionContextBlock)
  }

  // Cross-session events: rare, keep at end
  if (ctx.crossSessionEvents) {
    push(ctx.crossSessionEvents)
  }

  // Companion presence is NOT rendered into the model context — it is ambient
  // cross-session metadata intended for the desktop sidecar UI, not the agent.
  // Injecting it into the prompt creates a false multi-agent coordination
  // signal and wastes context-window tokens with no task value. The heartbeat
  // hook still writes .rivet/presence.json for UI consumption.
  // (ctx.companionPresence rendering removed 2026-06-23)

  // Unified tool context: theta + EFE + top-3 ranking.
  // Replaces old separate affordance-hint + policy-guidance blocks.
  if (ctx.toolContext) {
    push(ctx.toolContext, 'tool-context')
  }

  // PlanCache advisory: current-turn, informational-only hint.
  // Keep near policy guidance so it informs planning without becoming stable prompt.
  if (ctx.planCacheAdvisory) {
    push(ctx.planCacheAdvisory)
  }

  // U6: serialized PlanExecutionTrace — refreshed at compaction so the plan
  // baseline + progress survive history pruning. Cache-safe (appendix only).
  if (ctx.planTraceAppendix) {
    push(ctx.planTraceAppendix)
  }

  // Approved-plan pointer: tiny slug/title/path reminder of the plan under
  // execution. Body lives on disk; agent reads on demand. Cache-safe (appendix
  // only) — keeps approve/revise from rebuilding the frozen base.
  if (ctx.activePlanPointer) {
    push(ctx.activePlanPointer)
  }

  // Repair hint: routed through A1 harness-advisory bus — legacy <repair-hint> block removed.

  // Harness advisory: unified corrective guidance (A1 bus, max 3 entries)
  if (ctx.harnessAdvisoryBlock) {
    push(ctx.harnessAdvisoryBlock, 'advisory-appendix')
  }

  // Control-plane appendix (Wave 4): active-mode only, revision-driven —
  // byte-stable while the frame's model-visible state is unchanged.
  if (ctx.controlPlaneBlock) {
    push(ctx.controlPlaneBlock, 'control-appendix')
  }

  // Worktree warning: cache-safe — rendered ONLY into dynamic appendix
  if (ctx.worktreeReality && ctx.worktreeReality.severity !== 'green') {
    const reasons = ctx.worktreeReality.mismatchReasons
      .map(r => `  ${escapeXml(r)}`)
      .join('\n')
    push(`<worktree-warning severity="${escapeXml(ctx.worktreeReality.severity)}">\n${reasons}\n</worktree-warning>`)
  }

  // Plan-mode instruction block: governs the whole planning turn (read-only +
  // plan quality standard + diagram skeletons). Cache-safe — appendix only.
  if (ctx.planModeState === 'planning') {
    push(renderPlanModeBlock(ctx.activePlanFilePath))
  } else if (ctx.planExitReminderPending) {
    push(renderPlanExitReminder())
  }

  // Ask-mode instruction block — mutually exclusive with plan at the UI layer;
  // if both somehow set, plan block already rendered above (appending ask is ok
  // as a soft reminder, but gate already blocks writes).
  if (ctx.askModeState === 'asking') {
    push(renderAskModeBlock())
  }

  // Phase 2B: output verbosity steering.
  // Base: opt-in via RIVET_TERSE=1 / ctx.tersenessEnabled.
  // Escalate: doom-loop turns auto-enable (unless RIVET_TERSE=0).
  const { enabled: tersenessEnabled, escalate: tersenessEscalate } = resolveTersenessFlags(ctx)
  if (tersenessEnabled) {
    push(renderTersenessNudge(tersenessEscalate))
  }

  const toPart = (p: { content: string; source?: CvmInjectionSource }): AppendixPart =>
    ({ name: appendixBlockName(p.content), content: p.content, source: p.source })

  const protectedResult = protectedParts.map(content => ({ name: appendixBlockName(content), content }))

  if (parts.length === 0) return protectedResult

  // ── GWT Top-K selection (when budget is set) ────────────────────
  // Selection carries `source` through: dropped blocks never reach a
  // <context-update>, so they must not be metered either. Truncated blocks
  // come back with their shortened content, which is what actually ships.
  if (regularMaxChars !== undefined && regularMaxChars > 0) {
    const scored = parts.map(p => ({ ...p, salience: assignSalience(p.content) }))
    const selected = selectTopKBlocks(scored, regularMaxChars)
    return [...protectedResult, ...selected.map(toPart)]
  }

  return [...protectedResult, ...parts.map(toPart)]
}

/** Backward-compatible wrapper: full <context-update> block (no seq). */
export function buildDynamicAppendix(ctx: VolatileContext, maxChars?: number): string {
  const parts = buildDynamicAppendixParts(ctx, maxChars)
  if (parts.length === 0) return ''
  return `<context-update>\n${parts.map(p => p.content).join('\n')}\n</context-update>`
}

// ── Global Workspace Theory: salience scoring ──────────────────────

/** A context-update sub-block with its salience score. */
export interface SalientBlock {
  content: string
  salience: number
  source?: CvmInjectionSource
}

/**
 * Assign a salience score to a context-update sub-block.
 *
 * Salience reflects information value per token:
 * - 1.0: identity-critical (star-domain)
 * - 0.8: directly actionable (repair-hint, historical-lessons)
 * - 0.7: task-relevant (intent-retrieval-route, task-progress, decisions,
 *        git-status, recent-commits — git 状态是任务地基：被 Top-K 丢弃会诱发
 *        模型用 bash 重新获取，形成训练模式 doom-loop，见会话 43443098 取证)
 * - 0.4: session housekeeping (session-state, cross-session-events)
 * - 0.3: deduplication hints (read-file-dedup-hint)
 */
/**
 * Unified progress block: merges session-state, task-progress, and decisions
 * into a single `<progress>` XML block. Eliminates triple repetition where
 * these three independent blocks each reported overlapping objective/status/decisions.
 */
function renderProgressBlock(ctx: VolatileContext): string | null {
  // sessionState arrives pre-rendered as `<session-state>...</session-state>`; strip the
  // tags and judge it by CONTENT, not truthiness. An empty wrapper is still a non-empty
  // string, so the old `if (ctx.sessionState)` gate was permanently true for any session
  // with a sessionId — which is what killed the branch that read `ctx.decisions`.
  // No objective dedup here: session-state no longer renders an objective line at all
  // (see SessionStateManager.renderForVolatile), so there is nothing to duplicate.
  const trimmed = (ctx.sessionState ?? '')
    .replace(/^<session-state>\n?/, '')
    .replace(/\n?<\/session-state>$/, '')
    .trim()

  // One pass over all three sources instead of a rich branch plus a fallback that had
  // to mirror it. The mirrored pair is what let the bug hide: `ctx.decisions` was only
  // ever read in the fallback, so it went dark the moment session-state had content —
  // and once the wrapper made that permanently true, it went dark for good.
  const lines: string[] = []

  if (trimmed) lines.push(trimmed)

  if (ctx.taskProgress?.current) {
    lines.push(`current: ${escapeXml(ctx.taskProgress.current)}`)
  }
  if (ctx.taskProgress?.completed && ctx.taskProgress.completed.length > 0) {
    lines.push(`done: ${ctx.taskProgress.completed.map(escapeXml).join(', ')}`)
  }
  if (ctx.taskProgress?.remaining && ctx.taskProgress.remaining.length > 0) {
    lines.push(`next: ${ctx.taskProgress.remaining.map(escapeXml).join(', ')}`)
  }

  // Whether decisions reach this renderer at all is decided per session by the holdout
  // experiment (decisions-experiment.ts, applied at the producer in turn-end.ts): an
  // off/holdout session simply carries none. Keeping that split at the producer means
  // one decision point instead of a renderer switch that cannot see the session — and
  // means the treatment arm's exposure doesn't depend on whether files were modified yet.
  if (ctx.decisions && ctx.decisions.length > 0) {
    lines.push('Decisions:')
    for (const d of ctx.decisions) {
      lines.push(`  - ${escapeXml(d)}`)
    }
  }

  if (lines.length === 0) return null
  return `<progress>\n${lines.join('\n')}\n</progress>`
}

export function assignSalience(blockContent: string): number {
  // Dead path: star-domain is now folded into the frozen prefix, never the
  // appendix, so this case is not exercised by buildDynamicAppendixParts.
  // Kept for the assignSalience test contract and any future appendix-level
  // domain rendering — identity-critical, highest salience.
  if (blockContent.startsWith('<star-domain')) return 1.0
  // Plan-mode block governs the entire planning turn — never drop under budget.
  if (blockContent.startsWith('<plan-mode>')) return 0.95
  if (blockContent.startsWith('<ask-mode>')) return 0.95
  if (blockContent.startsWith('<repair-hint>')) return 0.8
  if (blockContent.startsWith('<星域-advisory>')) return 0.8
  if (blockContent.startsWith('<historical-lessons>')) return 0.8
  // User explicitly @-referenced these files/paths — direct intent signal,
  // must survive budget pressure (was silently defaulting to 0.5).
  if (blockContent.startsWith('<mentions>')) return 0.8
  // Task-relevant strategy/route guidance — same tier as other 0.7 advisories.
  if (blockContent.startsWith('<task-depth')) return 0.7
  if (blockContent.startsWith('<plan-methodology')) return 0.7
  // Skill discovery: helpful but model can re-list on demand via the skill tool.
  if (blockContent.startsWith('<available-skills')) return 0.6
  if (blockContent.startsWith('<tool-context>')) return 0.7
  if (blockContent.startsWith('<plan-cache-advisory>')) return 0.7
  // U6: plan trace is task-relevant baseline/progress. Explicit salience so
  // Top-K never drops it under appendix budget pressure.
  if (blockContent.startsWith('<plan-execution-trace')) return 0.7
  // Active-plan pointer is execution-critical: never drop under budget pressure.
  if (blockContent.startsWith('<active-plan')) return 0.8
  if (blockContent.startsWith('<intent-retrieval-route')) return 0.7
  if (blockContent.startsWith('<progress>') || blockContent.startsWith('<progress ')) return 0.8
  if (blockContent.startsWith('<task-progress')) return 0.7
  if (blockContent.startsWith('<decisions>')) return 0.7
  if (blockContent.startsWith('<worktree-warning')) return 0.7
  if (blockContent.startsWith('<git-status>')) return 0.7
  if (blockContent.startsWith('<recent-commits>')) return 0.7
  if (blockContent.startsWith('<session-state>')) return 0.4 // legacy fallback
  if (blockContent.startsWith('<cross-session')) return 0.4
  if (blockContent.startsWith('<read-file-dedup-hint>')) return 0.3
  // Output-style nudge (Phase 2B): tiny + governs the whole reply's prose —
  // keep it above the drop line so budget pressure never silently removes it.
  if (blockContent.startsWith('<output-style>')) return 0.75
  return 0.5 // default: moderate salience
}

/**
 * Select blocks in descending salience order until the character budget is exhausted.
 * Every block that fits is included; blocks beyond the budget are dropped.
 * At least one block is always included (the highest-salience block).
 *
 * Returns the surviving blocks themselves (not bare strings) so caller-attached
 * metadata such as `source` survives selection. A block that had to be
 * truncated comes back as a copy carrying the shortened content.
 */
export function selectTopKBlocks<T extends SalientBlock>(blocks: T[], maxChars: number): T[] {
  const sorted = [...blocks].sort((a, b) => b.salience - a.salience)
  const selected: T[] = []
  let used = 0
  const blockCap = Math.max(Math.floor(maxChars * 0.4), 2_000)

  for (const block of sorted) {
    const content = block.content.length > blockCap
      ? block.content.slice(0, blockCap) + '\n[truncated]'
      : block.content
    const overhead = selected.length > 0 ? 2 : 0
    if (used + overhead + content.length > maxChars && selected.length > 0) {
      continue
    }
    selected.push(content === block.content ? block : { ...block, content })
    used += overhead + content.length
  }

  return selected
}

/** Build latest-turn volatile block — FROZEN prefix + dynamic appendix. */
export function buildLatestTurnVolatileBlock(ctx: VolatileContext): string {
  const frozen = buildStableVolatileBlock(ctx)
  const appendix = buildDynamicAppendix(ctx)
  if (!appendix) return frozen
  return frozen + '\n' + appendix
}

/** Backward-compatible alias for buildLatestTurnVolatileBlock. */
export function buildVolatileBlock(ctx: VolatileContext): string {
  return buildLatestTurnVolatileBlock(ctx)
}

/**
 * Shell-syntax guidance keyed on the ACTUALLY-RESOLVED shell family, not on
 * `process.platform`. The previous code unconditionally told the model "shell is
 * PowerShell/cmd" on Windows — wrong when Git Bash is the active shell (our
 * preferred shell when present), which inverted the guidance and induced wrong
 * syntax. Mirrors Claude Code's approach: detect the real shell, tell the model
 * to use THAT shell's syntax. No translation layer.
 *
 * Returns the full `<shell-note>` element, or '' for plain POSIX `sh` (Unix host)
 * where no extra guidance is needed. Pure + exported for unit testing.
 *
 * `getShellCommand()` is resolved once and process-cached, so the chosen kind is
 * session-static → injecting this in the frozen block stays prefix-cache safe.
 */
export function windowsShellNote(kind: ShellCommand['kind']): string {
  switch (kind) {
    case 'bash':
      // Git Bash on a Windows host: POSIX commands work, but the host is Windows.
      return '<shell-note>shell 是 Git Bash（POSIX）：`ls`/`cat`/`grep`/`&&`/管道/`2>/dev/null` 均可用。运行在 Windows 宿主——路径用正斜杠或加引号（别用反斜杠，会被转义）；Python 可能是 `python` 或 `py`。非零退出码≠必然失败（很多工具用它表达正常结果）。</shell-note>'
    case 'powershell':
      return '<shell-note>shell 是 PowerShell。语法速查：环境变量 `$env:NAME`（不是 `$NAME`）；丢弃错误输出 `2>$null`（不是 `2>nul`/`2>/dev/null`）；PS 5.1 不支持 `&&` 串联——用 `;` 分隔，或上一条后判 `$LASTEXITCODE`；命令替换 `$(...)`；删除 `Remove-Item -Recurse -Force`；存在判断 `Test-Path`；列目录/读文件优先 cmdlet（`Get-ChildItem`/`Get-Content -Tail 20`），`ls`/`cat`/`rm`/`pwd` 是别名可用但参数走 cmdlet 风格；Python 用 `py`。非零退出码≠必然失败。命令报「is not recognized as ... cmdlet」= 此环境没有这个命令，应换用可用工具，不要重试同一条——这不是你的错，也不影响判断。</shell-note>'
    case 'cmd':
      return '<shell-note>shell 是 cmd.exe：列目录 `dir`、看文件 `type`、环境变量 `%VAR%`；`ls`/`cat` 不存在（用 `dir`/`type`）；现代 cmd 支持 `&&` 串联；丢弃输出 `2>nul`；Python 用 `py`。非零退出码≠必然失败。命令报「is not recognized」= 此环境没有这个命令，换用可用工具，不要重试同一条。</shell-note>'
    case 'sh':
    default:
      return ''
  }
}

function buildVolatileBlockInternal(ctx: VolatileContext): string {
  const parts: string[] = []

  // Target platform drives file-artifact conventions (path style, etc.). When it
  // differs from the real host, surface BOTH — and advise cross-platform commands,
  // since the shell still runs on the host. Session-static → prefix-cache safe.
  const targetPlatform = getTargetPlatform()
  const hostAttr = targetPlatform !== process.platform ? ` host="${process.platform}"` : ''
  parts.push(`<environment platform="${targetPlatform}"${hostAttr} cwd="${escapeXml(ctx.cwd)}" os="${escapeXml(`${os.type()} ${os.release()}`)}" />`)
  if (targetPlatform !== process.platform) {
    parts.push(`<platform-note>文件约定（换行/路径风格）按 ${targetPlatform} 生成；但 shell 命令在宿主 ${process.platform} 上执行——优先使用跨平台命令，避免目标平台专属语法在宿主机执行失败。</platform-note>`)
  }
  // Windows 路径风格指引：git/仓库索引等上游输出一律正斜杠，模型会照抄，
  // 对 Windows 用户显示 src/foo 而非 src\foo（用户报告 2026-07-07）。
  // targetPlatform 会话内固定 → session-static，前缀缓存安全。
  if (targetPlatform === 'win32') {
    parts.push('<path-style-note>Windows 环境：在回复和文档中书写文件路径时用反斜杠（如 src\\tui\\app.ts、D:\\proj\\file.md），与用户的资源管理器/终端习惯一致。工具参数两种分隔符都接受；shell 命令内的路径写法以 shell-note 为准（Git Bash 用正斜杠）。</path-style-note>')
  }
  // Shell 原生指引：跟随真实解析出的 shell 族（Git Bash / PowerShell / cmd），
  // 而非一律按 PowerShell。装了 Git Bash 时实际跑 bash，给 PowerShell 指引会诱导
  // 模型发错语法。getShellCommand() 进程内缓存、会话内固定 → session-static，
  // 留在 frozen 前缀缓存安全。Unix(sh) 返回空，不注入。
  const shellNote = windowsShellNote(getShellCommand().kind)
  if (shellNote) {
    parts.push(shellNote)
  }

  // W4 运行时版本感知：目标项目 Python/Node/Rust/Go 版本（探测一次、按 cwd
  // 记忆化 → 会话内字节恒定）。同 <environment> 一类的会话常量，留在 frozen
  // `<context>` 块缓存安全；不进跨会话 static 系统提示，也不进每轮 appendix。
  const runtimeEnv = detectRuntimeEnvBlock(ctx.cwd)
  if (runtimeEnv) {
    parts.push(runtimeEnv)
  }

  // 天枢本体锚点——常驻 frozen，简短心跳确认在场。
  // 行为层面的唤醒通过 advisory bus 按需注入（见 staleness-refresh advisory）。
  parts.push('<sober>天枢在此。证据先行，全貌定向。</sober>')

  // 自体识别——天枢站在自己的身体里（自体/家），还是世界的项目里（使者）。
  // 不同 locus 产生不同验证策略和谨慎度——不只是叙事差异。
  // session 常量 → 留在 frozen，prefix-cache safe（同 rivetMd 一类）。
  if (ctx.cwdRelation === 'self') {
    parts.push('<locus relation="self">这是你的源码。改动直接影响你自己的运行时行为。每个修改都做三级验证（typecheck → related tests → full suite）。对 prompt/、hooks/、engine.ts 的修改需说明预期的认知影响。</locus>')
  } else if (ctx.cwdRelation === 'world') {
    parts.push('<locus relation="world">你在一个外部项目中工作。遵循项目自身的约定（AGENTS.md + .rivet.md）。验证深度匹配任务复杂度：简单修改跑 related tests，跨模块改动跑 full suite。</locus>')
  }

  // star-domain 块已移至 frozen 末尾（session-memory 之后）——见文件尾部。
  // 档位化上限：缺省回落 standard，保证无 policy 的调用方（worker / 测试 /
  // 直接构造 ctx 的路径）与历史输出逐字节一致。
  const caps = { ...FROZEN_BLOCK_CAPS, ...ctx.blockCaps }

  const md = ctx.rivetMd ?? readRivetMd(ctx.cwd)
  if (md) {
    // When codebase-index is present it already contains the module directory table
    // (seeded from AGENTS.md via loadProjectModuleMap). Strip the redundant table
    // from project-instructions to avoid ~600-800 chars of duplication.
    const stripped = ctx.projectIndexBlock ? stripFirstMarkdownTable(md) : md
    // 超预算时按节取舍，而不是从头切到 cap 为止。文档顺序不等于重要性——
    // AGENTS.md 一类文档惯例是索引在前、纪律在后，从头切正好切掉硬闸门。
    // 预算按**转义后**长度计：转义在截断之前做，按原文计费会让块超出 cap
    // 后再被 truncateBlock 从头切一刀，等于白选。
    const wrap = '<project-instructions>\n\n</project-instructions>'.length
    const selected = selectProjectInstructions(
      stripped,
      caps.projectInstructions - wrap,
      t => escapeXml(t).length,
    )
    parts.push(truncateBlock(`<project-instructions>\n${escapeXml(selected.text)}\n</project-instructions>`, caps.projectInstructions, 'project-instructions'))
  }

  // A3: declared verify commands (from .rivet-config.json) rendered as the
  // authoritative source — protects against hand-edited .rivet.md free text
  // drifting from what the gates actually run. Session-stable (memoized loader,
  // invalidated only by /init), so it is safe in the FROZEN prefix.
  const verifyBlock = renderDeclaredVerify(ctx.cwd)
  if (verifyBlock) parts.push(verifyBlock)

  // Project memory — auto-loaded from .rivet/knowledge/memory.jsonl.
  // Rendered into frozen base so it benefits from prefix cache (turn 2+ cost = 0).
  // A3: budget cap at 3K chars — beyond that it's stale noise.
  if (ctx.projectMemoryBlock) {
    parts.push(truncateBlock(ctx.projectMemoryBlock, caps.projectMemory, 'project-memory'))
  }

  // Knowledge manifest routing map（Wave 4b）——字节稳定索引，snapshot 时生成。
  // 只告诉模型"何时召回什么"，知识本文经 memory recall 按需取。
  if (ctx.knowledgeManifestBlock) {
    parts.push(truncateBlock(ctx.knowledgeManifestBlock, caps.knowledgeManifest, 'knowledge-manifest'))
  }

  // Seed capsule — 前辈星域封存的经验方法（天璇胶囊等）。
  // Rendered into frozen base so it benefits from prefix cache (turn 2+ cost = 0).
  // A3: budget cap at 3K chars.
  if (ctx.seedCapsuleBlock) {
    parts.push(truncateBlock(ctx.seedCapsuleBlock, caps.seedCapsule, 'seed-capsule'))
  }

  // Codebase index — module summaries + CLI entries.
  // Rendered into frozen base after projectMemoryBlock for prefix cache stability.
  // A3: budget cap at 4K chars — oversized index is a trained-mode noise source.
  if (ctx.projectIndexBlock) {
    parts.push(truncateBlock(ctx.projectIndexBlock, caps.codebaseIndex, 'codebase-index'))
  }

  if (ctx.workingSet && ctx.workingSet.length > 0) {
    const files = ctx.workingSet.map(file => `<file>${escapeXml(file)}</file>`).join('\n')
    parts.push(`<working-set>\n${files}\n</working-set>`)
  }

  if (ctx.sessionMemoryBlock) {
    parts.push(`<session-memory>\n${escapeXml(ctx.sessionMemoryBlock)}\n</session-memory>`)
  }

  // star-domain: session-constant identity, folded into the frozen prefix so it
  // enters the exact-prefix cache from turn 1 — provider-agnostic, no habituation
  // warm-up. name/motto are registry constants (not user input), rendered
  // unescaped to match the established <star-domain name="..."> shape.
  //
  // 位置（2026-08-01 P1-1）：从 sober/locus 之后移到 frozen **末尾**。不同
  // authority 的 worker 此前在星域块分叉，连带损失其后的 project-instructions /
  // verify-block / session-memory 段缓存；移到最末后分叉点之前的前缀全共享。
  // 代价是星域指令从「身份前置区」退到「记忆末区」，指令权重降低——认知影响
  // 需冒烟观察（见 docs/plans/2026-07-31-galaxy-prewarm-and-cache-affinity.md）。
  if (ctx.activeDomain) {
    const d = ctx.activeDomain
    // knowledgeBlock: session-constant top-K domain lessons (bound once with the
    // domain) — lesson text is agent-written store content, so it IS escaped.
    const knowledge = d.knowledgeBlock ? `\n<domain-knowledge>\n${escapeXml(d.knowledgeBlock)}\n</domain-knowledge>` : ''
    // 全星域共享执行纪律（字节恒定，随 star-domain 进 FROZEN 前缀）。
    // 瑶光域在自己的 systemPromptSuffix 中保留放大版，此处是十域共同的底线。
    const sharedDiscipline = '\n执行纪律（全星域共享）：绿非证明，复现即证——宣称已修/已验证前，先用工具复现结论；报告里的每个数字要能指到一条真实验证记录。'
    parts.push(`<star-domain name="${d.name}" motto="${d.motto}">${d.volatileBlock}${sharedDiscipline}${knowledge}</star-domain>`)
  }

  // NOTE: activeDomain IS rendered here (above, frozen 末尾) — it is a session
  // constant KEPT in FROZEN. The remaining per-turn dynamic fields (gitStatus,
  // toolHistory, taskProgress, decisions, playbookLessons, planModeState,
  // worktreeReality, …) are NOT rendered here. buildStableVolatileBlock — the
  // sole caller — forces them undefined to keep the FROZEN prefix byte-stable;
  // they are rendered in buildDynamicAppendixParts (appendix) and, for habituated
  // session-constants like playbookLessons, in the <consolidated> block (see
  // engine.ts habituation). The single source of truth for what stays frozen vs.
  // dynamic is the strip list in buildStableVolatileBlock.

  return parts.length > 0 ? `<context>\n${parts.join('\n\n')}\n</context>` : ''
}

/**
 * A3 前缀预算：截断超出上限的 frozen 块。上限见 {@link FROZEN_BLOCK_CAPS}。
 * - codebaseIndex → 超出折叠为 repo 工具指引
 * - seedCapsule / projectMemory → 超出截断但保持 XML 标签闭合
 */
function truncateBlock(block: string, maxChars: number, kind: string): string {
  if (block.length <= maxChars) return block
  if (kind === 'codebase-index') {
    const truncated = block.slice(0, maxChars)
    return `${truncated}\n<!-- codebase index truncated (${block.length} chars → ${maxChars}); use repo_map/repo_graph tools for details -->`
  }
  // XML-wrapped blocks: try single-root match first. Multi-root blocks
  // (seedCapsuleBlock) fall back to plain truncation — they can't be cleanly
  // truncated while preserving well-formedness, but the prefix cache doesn't
  // depend on XML validity, only byte stability.
  const singleRootMatch = block.match(/^<([a-z-]+)[^>]*>([\s\S]*)<\/\1>$/m)
  if (singleRootMatch) {
    const [_full, tag, content] = singleRootMatch
    const trimmed = content!.slice(0, maxChars - tag!.length * 2 - 10)
    return `<${tag}>\n${trimmed}\n<!-- truncated: ${block.length} → ${maxChars} chars -->\n</${tag}>`
  }
  return block.slice(0, maxChars) + `\n<!-- ${kind} truncated: ${block.length} → ${maxChars} chars -->`
}

/**
 * Strip the first markdown table from text (the AGENTS.md directory table).
 * A markdown table is a contiguous block of lines starting with `|`.
 * Preserves surrounding content including headers/prose.
 */
export function stripFirstMarkdownTable(text: string): string {
  const lines = text.split('\n')
  let tableStart = -1
  let tableEnd = -1

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trimStart()
    if (trimmed.startsWith('|')) {
      if (tableStart === -1) tableStart = i
      tableEnd = i
    } else if (tableStart !== -1) {
      break
    }
  }

  if (tableStart === -1) return text

  // Also remove the preceding header line if it looks like "> 顶层目录索引..."
  // and trailing blank line after table
  let removeStart = tableStart
  if (removeStart > 0 && lines[removeStart - 1]!.startsWith('>')) {
    removeStart--
  }
  let removeEnd = tableEnd
  if (removeEnd + 1 < lines.length && lines[removeEnd + 1]!.trim() === '') {
    removeEnd++
  }

  const result = [...lines.slice(0, removeStart), ...lines.slice(removeEnd + 1)]
  return result.join('\n')
}

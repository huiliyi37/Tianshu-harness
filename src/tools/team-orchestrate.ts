import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { classifyOrchestrationScale } from '../agent/task-size-gate.js'
import type { TeamRunSummary } from '../agent/team-orchestrator.js'
import { deserializeUnifiedPlan, unifiedPlanToTeamTasks, validateUnifiedPlan } from '../agent/unified-plan.js'
import { groupTeamTasks } from '../agent/team-grouping.js'
import { parseTeamTasks, type TeamTask } from '../agent/team-plan.js'
import { formatSealStatus, verifyPlanSeal, type SealedUnifiedPlan } from '../agent/council/council-seal.js'
import { clearPlan, consumePlan, getStoredPlan, storePlan } from '../agent/plan-store.js'
import { profileRegistry } from '../agent/profile-registry.js'
import { shapeWriteBudgetForProfile } from '../agent/budget-shape.js'
import { progressiveTimeout, WORKER_EXIT_GRACE_MS } from '../agent/timeout-ladder.js'
import { MAX_BUDGET_CONTINUATIONS } from '../agent/worker-continuation.js'
import { buildTeamPanelModel, encodeTeamPanelModel } from '../tui/team-panel-model.js'
import { buildTeamOutcome } from '../agent/orchestration-outcome.js'
import { validatePathSafe } from './path-validate.js'
import { createActivityStreamer, createDelegationActivityMapper, terminalActivity } from './worker-activity-stream.js'
import type { CoordinatorRun, WorkerActivityEvent } from '../agent/coordinator.js'
import type { Tool, ToolCallParams, ToolResult } from './types.js'
// Shared execution kernel — the dispatch + scope-health + review gate + telemetry
// closure live in the agent layer so plan_task and team_orchestrate share one path.
import {
  executePlanWaves,
  EXECUTE_PLAN_WAVES_GUARDRAIL,
  teamReviewChangedFiles,
  teamReviewForceLevel,
  teamReviewFocusHint,
  type PlanExecutorDeps,
  type TeamImpactAnalyzer,
} from '../agent/plan-executor.js'
import { resolvePlanConstraints, constraintsFromUnifiedPlan } from '../agent/plan-constraints.js'
import type { PlanWithObligations } from '../agent/council/council-obligations.js'

// Back-compat re-exports: TeamOrchestrateCoordinator was the tool-layer name for
// the executor's dependency surface; tests/bootstrap still reference these and the
// review helpers from this module.
export type TeamOrchestrateCoordinator = PlanExecutorDeps
export type { TeamImpactAnalyzer }
export { teamReviewChangedFiles, teamReviewForceLevel, teamReviewFocusHint }

const inputSchema = z.object({
  mode: z.enum(['standard', 'max']).default('standard'),
  objective: z.string().min(1),
  planPath: z.string().optional(),
  planMarkdown: z.string().optional(),
  /** UnifiedPlan JSON from plan_task output — bypasses Markdown parsing and max planner fanout. */
  planJson: z.string().optional(),
  maxParallel: z.number().int().min(1).max(5).optional(),
  fromWave: z.number().int().min(0).optional(),
  /** 多波自动推进：缺省时无 fromWave → 从 wave 0 自动推进到末波/首个阻塞；
   *  有 fromWave → 只执行该波（人工恢复语义）。显式 true → 从 fromWave
   *  （缺省 0）推进到底；false → 只执行起始波。 */
  autoAdvance: z.boolean().optional(),
  /** 两阶段确认（星河收编 #7）：显式 confirm:false → 只展示波次分派方案不派发；
   *  confirm:true → 点火。缺省 undefined → 直接执行（现状行为，向后兼容）。 */
  confirm: z.boolean().optional(),
})

/**
 * team_orchestrate 工具层超时上限——1 小时护栏。
 *
 * 为什么需要护栏：timeoutMs 是整次调用（可多波自动推进，≤10 波）的墙钟上限。
 * 公式按「最坏波次 × 最坏 worker 预算 × 续跑次数」放大后，异常计划（循环/
 * 巨量任务）可能把天花板推到小时级以上。真正的卡死判定归 worker 内部
 * 600s budget + worker-liveness 静默探测（timeout-ladder.ts 注释声明的架构
 * 意图）——工具层只需兜住「多波/续跑不误杀」，不必兜「死循环早发现」。
 */
export const TEAM_TIMEOUT_CEIL_MS = 3_600_000 // 1 hour

/**
 * 工具层超时 = 单 worker 最坏预算 × tier 倍率 × 波次数 × 续跑次数 + GRACE，
 * 封顶 TEAM_TIMEOUT_CEIL_MS。对齐 delegate 系 delegationToolTimeoutMs 的
 * 同源公式（profile-registry.ts:717），修复固定 600s 在多波/长预算下先于
 * 内层开枪、整调用 reject 丢 partial 的硬缺陷（B+A 方案）。
 *
 * tasks 可解析（planJson 或 plan-store peek）时按真实分组算波数；无任务
 * 上下文时用护栏上界兜底（不误杀、不失控）。
 *
 * - budget：各任务 profile.defaultTimeoutMs 的最大值（无 profile 时
 *   progressiveTimeout(sessionTurn)，缺省 480s）；无任务时 600s。
 * - tierMul：1.5（strong 档上界，profile-registry.ts TIER_TIMEOUT_MULTIPLIER）。
 * - waves：groupTeamTasks 静态波数（与执行同函数同参数，是执行波数上界）。
 * - runs：1 + MAX_BUDGET_CONTINUATIONS（续跑每轮带完整 budget）。
 */
export function teamOrchestrateTimeoutMs(params?: ToolCallParams): number {
  let tasks: TeamTask[] | undefined
  const planJson = params?.input?.planJson as string | undefined
  const plan = planJson ? deserializeUnifiedPlan(planJson) : undefined
  const stored = !planJson && !plan ? getStoredPlan(params?.sessionId) : undefined
  if (plan) {
    tasks = unifiedPlanToTeamTasks(plan)
  } else if (stored) {
    const storedPlan = deserializeUnifiedPlan(stored)
    if (storedPlan) tasks = unifiedPlanToTeamTasks(storedPlan)
  }

  let budget = 600_000
  let waves = EXECUTE_PLAN_WAVES_GUARDRAIL
  if (tasks && tasks.length > 0) {
    let maxProfileBudget = 0
    for (const t of tasks) {
      const pb = t.profile ? profileRegistry.get(t.profile)?.defaultTimeoutMs : undefined
      if (pb && pb > maxProfileBudget) maxProfileBudget = pb
    }
    // 预算发准（2026-08-18）：任务形状定价后的单 worker 预算也进 max——否则
    // 多文件任务的 shape timeout 超过这里取到的 flat profile 默认，外层会先
    // 于内层开枪（正是该函数当初要修的缺陷形态）。
    for (const t of tasks) {
      const shaped = shapeWriteBudgetForProfile(t.files, t.profile)
      if (shaped && shaped.timeoutMs > maxProfileBudget) maxProfileBudget = shaped.timeoutMs
    }
    budget = maxProfileBudget > 0 ? maxProfileBudget : progressiveTimeout(params?.sessionTurnCount)
    waves = groupTeamTasks(tasks).length
  }

  const tierMul = 1.5
  const runs = 1 + MAX_BUDGET_CONTINUATIONS
  return Math.min(TEAM_TIMEOUT_CEIL_MS, budget * tierMul * waves * runs + WORKER_EXIT_GRACE_MS)
}

/**
 * Render the council merge ledger (max mode, first wave) so the perspective work
 * isn't silently dropped: cross-perspective conflicts, deferred alternatives, and
 * the risk ledger. Each section is capped to keep the panel readable; a trailing
 * count signals how many were elided. Advisory — never blocks dispatch.
 */
function formatPlanMerge(planMerge: NonNullable<TeamRunSummary['planMerge']>): string[] {
  const CAP = 3
  const lines: string[] = []
  const section = (
    title: string,
    items: string[],
  ): void => {
    if (items.length === 0) return
    lines.push(title)
    for (const item of items.slice(0, CAP)) lines.push(`  - ${item}`)
    if (items.length > CAP) lines.push(`  …（另 ${items.length - CAP} 条）`)
  }
  section(
    '计划冲突（议事会意见分歧——请裁决）：',
    planMerge.conflicts.map(c => c.description),
  )
  section(
    '已补入执行图的分片（正交分片，已并入）：',
    planMerge.augmented.map(a => `${a.title} — ${a.reason}`),
  )
  section(
    '暂缓的备选方案（不在基础计划中）：',
    planMerge.deferred.map(d => `${d.title} — ${d.reason}`),
  )
  section(
    '风险账本：',
    planMerge.risks.map(r => `[${r.severity}]${r.taskId ? ` ${r.taskId}:` : ''} ${r.claim}`),
  )
  return lines
}

/** 内部共用：git status --short 全部行（core.quotePath=false——中文/非 ASCII
 *  路径不转八进制，否则剥引号后也匹配不到 UTF-8 changedFile；同仓
 *  diff-collector.ts 已踩过此坑）。非 git 目录/超时返回 null（调用方降级跳过）。 */
function gitStatusRows(cwd: string): string[] | null {
  try {
    const out = execFileSync('git', ['-c', 'core.quotePath=false', 'status', '--short'], { cwd, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    return out.split('\n').filter(l => l.trim().length > 0)
  } catch {
    return null
  }
}

/** D: blocked 时的工作树归属收集——git status --short 过滤本波次 worker 的
 *  changedFiles（系统捕获的 changedFiles 已在结果契约里），命中行原样列出，
 *  不再猜归属。无 git 环境/超时返回 []（跳过该段）。
 *  匹配规则：普通路径相等 / 路径在目录下 / rename 取 `->` 后新路径 /
 *  未跟踪目录（`?? dir/`）展开为目录前缀。目录级命中（后两条规则）附
 *  「可能含其他会话改动，勿整目录 add」标注——多会话共享工作区下，
 *  前缀展开会把别会话在同目录的改动一并命中（2026-08-03 审查实测证伪
 *  「只漏报不误报」后的修正：保留召回、标注风险）。 */
export function collectBlockedAttribution(cwd: string, changedFiles: string[]): string[] {
  if (changedFiles.length === 0) return []
  const rows = gitStatusRows(cwd)
  if (!rows) return [] // 非 git 目录 / 超时：降级跳过
  // 命中级别：exact（路径/rename 新路径相等）| dir（目录级归属，需标注）。
  const hitLevel = (line: string): 'exact' | 'dir' | null => {
    // 剥状态码前缀（` M ` / `?? ` 等）与引号（路径含空格时 git 加引号）。
    let p = line.slice(3).trim().replace(/^"|"$/g, '')
    // rename 行格式 `R  a -> b`：取箭头后的新路径（worker 报告的是新文件）。
    const arrow = p.indexOf(' -> ')
    if (arrow >= 0) p = p.slice(arrow + 4).trim().replace(/^"|"$/g, '')
    if (p.length === 0) return null
    for (const f of changedFiles) {
      if (f === p) return 'exact'
      if (p.startsWith(`${f}/`)) return 'dir' // f 是 p 的祖先目录（目录级改动）
      // `?? dir/` 未跟踪目录：p 是 f 的祖先目录（目录前缀展开）。
      const dir = p.endsWith('/') ? p.slice(0, -1) : p
      if (f.startsWith(`${dir}/`)) return 'dir'
    }
    return null
  }
  const out: string[] = []
  for (const l of rows) {
    const level = hitLevel(l)
    if (!level) continue
    out.push(level === 'dir' ? `${l}  ⟵ 目录级归属：可能含其他会话改动，勿整目录 add` : l)
    if (out.length >= 20) break
  }
  return out
}

/** 降级归属：changedFiles 为空（共享 worktree 不产生 diff artifact、失败工厂
 *  置空自报）但有真实未过 worker 时，列出工作树全部 dirty 行——无法逐文件
 *  归属，风险由 formatTeamSummary 的文案层声明。 */
export function collectAllDirtyRows(cwd: string): string[] {
  return (gitStatusRows(cwd) ?? []).slice(0, 20)
}

export function formatTeamSummary(summary: TeamRunSummary, fromWave = 0, attribution?: { hits: string[]; precise: boolean }): string {
  const lines: string[] = [
    `team ${summary.mode}：派发 ${summary.dispatched}，波次 ${summary.waves.length}，阻塞 ${summary.blocked.length}${summary.planCacheHit ? '（计划缓存命中——跳过 planner fanout）' : ''}`,
  ]
  if (summary.waves.length > 0) {
    lines.push('波次：')
    for (const w of summary.waves) lines.push(`  ${w.id} [${w.risk}] ${w.taskIds.join(', ')} — ${w.reason}`)
  }
  if (summary.blocked.length > 0) {
    lines.push('阻塞：')
    for (const b of summary.blocked) lines.push(`  - ${b}`)
  }
  if (summary.skipped && summary.skipped.length > 0) {
    lines.push(`跳过 ${summary.skipped.length}（条件边 onFailure=skip）：`)
    for (const s of summary.skipped) lines.push(`  - ${s}`)
  }
  // 归属段独立于阻塞列表：触发面是「有未过 worker」（run.results 非 passed），
  // 与 blocked 调度占位（waiting for wave/deferred）无关——健康全过波不出段，
  // 有 worker 未过的波即使 blocked 列表为空也出段。
  if (attribution && attribution.hits.length > 0) {
    if (attribution.precise) {
      lines.push('', '工作树本会话已产生改动（git status 命中本波次 worker 的 changedFiles）：')
    } else {
      lines.push('', '工作树 dirty 改动全量列出（worker 未留下文件清单——共享 worktree 无 diff artifact、自报为空，无法逐文件归属；可能多为其他会话改动，提交前逐个核对、勿整目录 add）：')
    }
    for (const h of attribution.hits) lines.push(`  ${h}`)
    lines.push('', '下一步：提交留用 / 回退 / 继续修订后重派——deliver_task 可按归属核验。')
  }
  if (summary.planMerge) {
    const mergeLines = formatPlanMerge(summary.planMerge)
    if (mergeLines.length > 0) lines.push('', ...mergeLines)
  }
  if (summary.advisories && summary.advisories.length > 0) {
    lines.push('', '分片建议（不阻断）：')
    for (const a of summary.advisories.slice(0, 3)) lines.push(`  - ${a}`)
    if (summary.advisories.length > 3) lines.push(`  …（另 ${summary.advisories.length - 3} 条）`)
  }
  const nextWave = fromWave + 1
  if (summary.waves.length > nextWave) {
    // Whole-wave failure: every worker missed its bar. Advancing on top of a
    // failed/stale wave compounds breakage, so replace the next-wave nudge with
    // a stop warning. Only triggers when an actual run is present (post-dispatch),
    // not for the onPlanReady pre-render where summary.run is absent.
    const run = summary.run
    const allFailed = !!run && run.results.length > 0 && run.results.every(r => r.status !== 'passed')
    if (allFailed) {
      lines.push('', `⚠ 波次 ${fromWave}：全部 ${run!.results.length} 个 worker 失败——先集成/重试再前进；修复前不要派发 fromWave ${nextWave}。`)
    } else {
      lines.push('', `集成完本波 diff 后运行下一波：再次调用 team_orchestrate 并传 fromWave: ${nextWave}。`)
    }
  }
  lines.push('', summary.packet)
  return lines.join('\n')
}

export function createTeamOrchestrateTool(
  coordinator: TeamOrchestrateCoordinator,
  options?: {
    defaultMaxParallel?: number
    /** Pro gate: mode:'max'（多视角 planner fanout）仅 Pro 可用。缺省 true
     *  以保持直接构造方（测试等）行为不变；bootstrap 按 pro-license 传真值。 */
    teamMaxEnabled?: boolean
  },
  /** H4-D4：team_orchestrate 派发 worker 完成后标记已完成 orderId */
  getAttackStore?: () => import('../agent/problem-attack-loop.js').ProblemAttackStore | null,
): Tool {
  return {
    definition: {
      name: 'team_orchestrate',
      description:
        '运行确定性 team 编排器：解析计划（standard 模式），按文件冲突与依赖把任务分组成波次（wave），派发第一个就绪波次的 worker。返回波次调度与派发摘要。不自动提交（NOT auto-commit）。\n\n分片（SHARDING）：把工作水平切成正交分片——每个分片是完整自包含的单元（实现 + 跑 tsc/lint/相关测试），由一个有能力的 flash 端到端负责。不要按阶段垂直切分（不拆独立的 lint/type/import/test 角色任务）。让分片落在不相交的文件上以并行执行；两个分片必须改同一文件时，设 dependsOn 排序（校验器会对未排序的重叠发出警告）。worker 直接写入控制器的单一共享工作区——没有逐 worker 的 diff 要合并；用 git diff 审查聚合结果。\n\n传 planJson（plan_task 输出的 UnifiedPlan）可跳过 Markdown 解析与 planner fanout，直接执行。',
      input_schema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['standard', 'max'], description: 'standard: 执行已有计划。max: 先做多视角规划。' },
          objective: { type: 'string', description: '任务目标陈述。' },
          planPath: { type: 'string', description: '项目内 Markdown 计划文件路径（可选，standard 模式）。' },
          planMarkdown: { type: 'string', description: '内联 Markdown 计划（可选）；优先级高于 planPath。' },
          planJson: { type: 'string', description: 'plan_task 输出的 UnifiedPlan JSON。提供时跳过 Markdown 解析与 max planner fanout。' },
          maxParallel: { type: 'number', description: '每波次最大并行 worker 数（1-5，默认 3）。' },
          fromWave: { type: 'number', description: '整合前序波次 diff 后，派发这个从零开始的波次索引。缺省 autoAdvance：只执行该波（人工恢复）。' },
          autoAdvance: { type: 'boolean', description: '多波自动推进：缺省时无 fromWave → 从 wave 0 自动跑到末波/首个阻塞；有 fromWave → 只执行该波。显式 true → 从 fromWave 推进到底；false → 只执行起始波。' },
          confirm: { type: 'boolean', description: '两阶段确认（收编 #7）：显式 false → 只展示波次分派方案不派发；true → 点火。缺省 → 直接执行（兼容）。' },
        },
        required: ['objective'],
      },
    },
    async execute(params: ToolCallParams): Promise<ToolResult> {
      const parsed = inputSchema.safeParse(params.input)
      if (!parsed.success) return { content: `无效输入：${parsed.error.message}`, isError: true, errorKind: 'format_error' }
      const { mode, objective, planPath, planMarkdown, planJson: explicitPlanJson, maxParallel, fromWave, autoAdvance } = parsed.data
      // Bridge: auto-consume the plan stored by plan_task when planJson is omitted.
      const planJson = explicitPlanJson ?? consumePlan(params.sessionId)
      // Stale-plan hygiene: an explicit planJson takes priority, so drop any plan
      // left in the session store — otherwise it would be wrongly auto-consumed by
      // a later bare call.
      if (explicitPlanJson) clearPlan(params.sessionId)

      // Task-size gate: block small tasks from triggering heavy orchestration
      const scale = classifyOrchestrationScale(objective)
      if (scale.blocked) {
        return {
          content: `team_orchestrate 已拦截：${scale.reason}\n\n请改为内联完成此任务——不需要并行编排。\n（若要绕过：在 objective 前加前缀 "force:"）`,
          isError: true,
        }
      }

      // Pre-parsed tasks from plan_task UnifiedPlan JSON
      let tasks: ReturnType<typeof unifiedPlanToTeamTasks> | undefined
      let planAdvisoryNote = ''
      let planFromJson: ReturnType<typeof deserializeUnifiedPlan> = null
      if (planJson) {
        const plan = deserializeUnifiedPlan(planJson)
        if (!plan) return { content: 'team_orchestrate 已拦截：planJson 不是合法的 UnifiedPlan', isError: true }
        planFromJson = plan
        const validation = validateUnifiedPlan(plan)
        if (!validation.valid) {
          const errors = [...validation.errors, ...validation.nodeErrors.map(ne => `[${ne.nodeId}] ${ne.error}`)]
          return { content: `team_orchestrate 已拦截：计划校验失败：\n${errors.map(e => `  - ${e}`).join('\n')}`, isError: true }
        }
        if (validation.warnings.length > 0) {
          planAdvisoryNote = `\n\n分片建议(不阻断):\n${validation.warnings.map(w => `  - ${w}`).join('\n')}`
        }
        // Atropos 密封校验（Phase 3）：议事会密封过的契约被静默改写 → 消费入口
        // 硬拦。未密封计划（plan_task/manual 产出）不受影响；修订走豁免协议
        // （revisePlanSeal 复封后 version+1，此处放行）。
        const sealCheck = verifyPlanSeal(plan as SealedUnifiedPlan)
        if (sealCheck.status === 'broken') {
          return {
            content: `team_orchestrate 已拦截：${formatSealStatus(plan as SealedUnifiedPlan)}`,
            isError: true,
          }
        }
        if (sealCheck.status === 'intact') {
          planAdvisoryNote += `\n\n${formatSealStatus(plan as SealedUnifiedPlan)}`
        }
        tasks = unifiedPlanToTeamTasks(plan)
        // Re-store for multi-wave: consumePlan cleared it, but subsequent
        // waves need it too.  Only re-store when the model didn't pass an
        // explicit planJson (explicit always takes priority).
        if (!explicitPlanJson) storePlan(planJson, params.sessionId)
      }

      let markdown = planMarkdown
      if (!markdown && !tasks && planPath) {
        const safe = validatePathSafe(params.cwd, planPath)
        if (!safe.ok) return { content: `team_orchestrate 已拦截：${safe.error}`, isError: true }
        try {
          markdown = readFileSync(safe.path, 'utf8')
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { content: `team_orchestrate 已拦截：无法读取 planPath「${planPath}」：${msg}`, isError: true }
        }
      }

      // ── Pro gate: team max ──
      // 多视角 planner fanout 是 Pro 功能。有现成计划时降级 standard 继续执行
      // (不浪费已有工作),没有计划时明确拒绝并给出 Basic 可用的替代路径。
      let effectiveMode = mode
      let proGateNote = ''
      if (mode === 'max' && !(options?.teamMaxEnabled ?? true)) {
        if (tasks || markdown) {
          effectiveMode = 'standard'
          proGateNote = '\n\n[Pro] team max（多视角规划）是 Pro 功能——已降级为 standard 模式执行现有计划。升级 Pro 解锁多视角 planner fanout。'
        } else {
          return {
            content: 'team_orchestrate: mode "max"（多视角规划 fanout）是 Pro 功能。Basic 替代路径：先用 plan_task 生成计划，再以 standard 模式执行；或升级 Pro 解锁。',
            isError: true,
          }
        }
      }

      // Standard mode needs a plan to execute; max mode generates one via planner
      // fanout, so only guard the standard path. A clear message beats the
      // "no dispatchable waves" weak result when nothing was provided/stored.
      if (effectiveMode === 'standard' && !tasks && !markdown) {
        return {
          content: 'team_orchestrate 已拦截：未提供计划，也未找到已存储的计划。请先运行 plan_task，或传入 planJson/planPath。',
          isError: true,
        }
      }

      // T9 P3 text stream + T4 structured per-worker updates (subagent panel).
      // objectiveById is filled from live activity events (coordinator attaches
      // order.objective) so terminal callbacks can re-emit the full objective.
      const objectiveById = new Map<string, string>()
      const textStreamer = params.onOutput ? createActivityStreamer(params.onOutput) : undefined
      const activityMapper = params.onWorkerActivity
        ? createDelegationActivityMapper(params.toolUseId, params.onWorkerActivity, {
            objectiveOf: (id) => objectiveById.get(id),
          })
        : undefined
      const onActivity = (textStreamer || activityMapper)
        ? (ev: WorkerActivityEvent) => {
            if (ev.objective) objectiveById.set(ev.workOrderId, ev.objective)
            textStreamer?.(ev)
            activityMapper?.(ev)
          }
        : undefined

      // T4: per-worker terminal status for the subagent panel. Same dual-emission
      // contract as delegate_batch: settle-time via onWorkerSettled (fast worker
      // flips to ✓ immediately), batch-end loop below as an idempotent backstop.
      const emitTerminal = params.onWorkerActivity
        ? (r: CoordinatorRun['results'][number]) => {
            activityMapper?.finish(terminalActivity(r, params.toolUseId, objectiveById.get(r.workOrderId)))
          }
        : undefined

      const effectiveFromWave = fromWave ?? 0
      // 行为矩阵：缺省时无 fromWave → 自动推进；有 fromWave → 人工恢复只跑该波。
      const effectiveAutoAdvance = autoAdvance ?? (fromWave === undefined)

      // ── Phase 1: Proposal (explicit confirm:false) ─────────────────
      // 星河收编 #7：只展示波次分派方案，不派发任何 worker。缺省/true 直接
      // 执行（向后兼容——此前 team_orchestrate 没有 proposal 阶段）。
      if (parsed.data.confirm === false) {
        const lines = ['🚀 team 编排方案', '', `目标：${objective}`, '', `mode：${effectiveMode}${proGateNote ? '（Pro 门降级）' : ''}`]
        if (tasks && tasks.length > 0) {
          lines.push('', `任务（${tasks.length}）：`, ...tasks.map(t => `  ${t.id}`))
          // 静态波次预览：与执行同用 groupTeamTasks 且**同参数**——执行路径
          // （team-orchestrator.ts）三处均不传 options（恒 MAX_WRITE_WORKERS），
          // 预览传参会让 maxTeamParallel≠3 时展示与真实分波不一致。
          const previewWaves = groupTeamTasks(tasks)
          lines.push('', '波次分派（静态预览）：')
          for (const w of previewWaves) lines.push(`  ${w.id} [${w.risk}] ${w.taskIds.join(', ')} — ${w.reason}`)
        } else if (markdown) {
          // proposal 阶段同步解析 markdown 做波次预览（与 executePlan 同一
          // 解析器），展示即真相。
          const parsedTasks = parseTeamTasks(markdown)
          if (parsedTasks.length > 0) {
            lines.push('', `任务（${parsedTasks.length}）：`, ...parsedTasks.map(t => `  ${t.id}`))
            // 同 tasks 分支：参数必须与执行路径一致（不传 options）。
            const previewWaves = groupTeamTasks(parsedTasks)
            lines.push('', '波次分派（静态预览）：')
            for (const w of previewWaves) lines.push(`  ${w.id} [${w.risk}] ${w.taskIds.join(', ')} — ${w.reason}`)
          } else {
            lines.push('', '计划已提供（Markdown），解析未产生任务。')
          }
        } else {
          lines.push('', effectiveMode === 'max'
            ? '将先做多视角规划（planner fanout）再分组执行。'
            : '需要 planJson / planMarkdown / planPath 之一。')
        }
        lines.push('', '调用 team_orchestrate({..., confirm: true}) 点火执行。')
        return { content: lines.join('\n'), uiContent: `🚀 team 方案 · ${tasks?.length ?? '?'} 任务` }
      }

      // D8 L2：从计划解析反目标与待验证假设，自动注入 worker 工单。
      // markdown 路径零额外 IO（已读进内存）；planJson 路径用契约自身的
      // nonGoals/obligations（议事会「拒绝」裁决与暂缓/高危缓解承诺）。
      const planConstraints = markdown
        ? resolvePlanConstraints(params.cwd, { markdown })
        : planFromJson
          ? constraintsFromUnifiedPlan({
              nonGoals: planFromJson.nonGoals,
              obligations: (planFromJson as PlanWithObligations).obligations?.map(o => ({ kind: o.kind, text: o.text })),
            })
          : undefined

      let waves: Awaited<ReturnType<typeof executePlanWaves>>
      try {
        // 多波驱动（W3A）：按 fromWave 逐波推进、判定停止（零通过/门禁/review/
        // abort/末波）、聚合每波结果。review 只在末波运行（executePlan 的
        // isLastWave 由真实 wave 序号判定）。
        waves = await executePlanWaves(
          {
            mode: effectiveMode,
            objective,
            tasks,
            planMarkdown: markdown,
            planConstraints: planConstraints && planConstraints.length > 0 ? planConstraints : undefined,
            startWave: effectiveFromWave,
            autoAdvance: effectiveAutoAdvance,
            maxParallel: maxParallel ?? options?.defaultMaxParallel,
            sessionId: params.sessionId,
            parentTurnId: params.toolUseId,
            reviewDepth: params.reviewDepth ?? 0,
            cwd: params.cwd,
            abortSignal: params.abortSignal,
            // team_orchestrate IS the review-bearing path.
            reviewGate: true,
            // T9 P3: live worker token/tool stream into the team tool card.
            onActivity,
            // Fleet viz: emit the wave/task DAG (all waiting) before dispatch so
            // the TUI shows the plan up front; the engine overlays running state.
            onPlanReady: params.onOutput
              ? (skeleton, wave) => {
                  params.onOutput!(`\n${encodeTeamPanelModel(buildTeamPanelModel(skeleton, wave))}\n`)
                }
              : undefined,
            onProgress: params.onOutput
              ? (completed, total) => {
                  const done = Math.max(0, Math.min(completed, total))
                  params.onOutput!(`✦ team progress: ${done}/${total} workers done\n`)
                }
              : undefined,
            onWorkerSettled: emitTerminal ?? undefined,
          },
          coordinator,
        )
        // Backstop terminal emission happens before disposal so the mapper can
        // flush the final coalesced activity for every worker.
        if (emitTerminal && waves.run.summary.run) {
          for (const result of waves.run.summary.run.results) emitTerminal(result)
        }
      } catch (err) {
        activityMapper?.dispose()
        const msg = err instanceof Error ? err.message : String(err)
        return { content: `team_orchestrate 失败：${msg}`, isError: true }
      } finally {
        activityMapper?.dispose()
      }

      const run = waves.run
      const { summary, reviewVerdict, notes } = run
      // 聚合视图的 wave 参数取「最后实际执行的波」：formatTeamSummary 的
      // nextWave 提示、panel 当前波、outcome 的 completedWaves 都以它为基准。
      const lastExecutedWave = effectiveFromWave + waves.runs.length - 1

      // H4-D4：标记已完成 worker，供 PAL worker: 引用验真。
      if (summary.run) {
        const attackStore = getAttackStore?.() ?? null
        for (const r of summary.run.results) {
          if (r.status === 'passed' && attackStore) {
            attackStore.markWorkerCompleted(r.workOrderId)
          }
        }
      }

      const panelModel = buildTeamPanelModel(summary, lastExecutedWave, reviewVerdict, undefined, run.gate, run.reviewDetail)
      // D: 有未过 worker 时收集工作树归属段——git status 过滤本波次 worker 的
      // changedFiles，无改动/非 git 环境自动跳过该段（不猜归属）。
      // 数据源用 teamReviewChangedFiles（diff artifact ∪ 自报）而非裸自报：
      // blocked/failed worker 的自报 changedFiles 被系统置空（coordinator 失败
      // 结果工厂），真实改动只在 diff artifact 里——裸自报会让归属段静默缺失。
      // 触发面是 run.results 非 passed，而非 summary.blocked——blocked 列表是
      // 调度占位（waiting for wave/deferred），健康全过波不该收到归属段与
      // 「回退」建议（2026-08-03 审查 MEDIUM 3）；未过 worker 即使 blocked
      // 列表为空也应触发（同审查 HIGH：共享 worktree 无 diff artifact 场景）。
      // 降级归属：changedFiles 为空时全量列出 dirty 行并标注无法逐文件归属。
      let attribution: { hits: string[]; precise: boolean } | undefined
      if (summary.run && summary.run.results.some(r => r.status !== 'passed')) {
        const changed = teamReviewChangedFiles(summary.run)
        if (changed.length > 0) {
          const hits = collectBlockedAttribution(params.cwd, changed)
          if (hits.length > 0) attribution = { hits, precise: true }
        }
        if (!attribution) {
          const all = collectAllDirtyRows(params.cwd)
          if (all.length > 0) attribution = { hits: all, precise: false }
        }
      }
      return {
        content: formatTeamSummary(summary, lastExecutedWave, attribution) + notes.reviewNote + notes.scopeHealthNote + notes.impactNote + notes.waveGateNote + notes.deliverySynthesis + planAdvisoryNote + proGateNote,
        uiContent: encodeTeamPanelModel(panelModel),
        isError: false,
        orchestration: buildTeamOutcome(summary, lastExecutedWave, run),
      }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    timeoutMs: (params) => teamOrchestrateTimeoutMs(params),
  }
}

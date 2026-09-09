/**
 * Shared plan execution kernel — the single closed loop behind both
 * `team_orchestrate` and `plan_task(execute:true)`.
 *
 * Wraps `runTeamSkeleton` (dispatch + wave grouping) with the full closed loop:
 *   - cross-wave failure propagation (session-scoped prior results)
 *   - scope-health (advisory leak/missing detection)
 *   - the review gate (force level + planned-gate focus + meridian blast radius
 *     + typecheck backstop), GATED by `reviewGate` so plan_task can skip it
 *     (plan_task's post-execution path is the commit flow, whose post-commit
 *     auto review gate already covers it — a pre-commit review here is redundant)
 *   - telemetry / scheduler-reward / episode reward closure + delivery synthesis
 *
 * The tool layer keeps its own I/O concerns (input parsing, size gate, panel
 * encoding, content/uiContent assembly); this kernel returns a structured result.
 */

import { isAbsolute } from 'node:path'
import type { CoordinatorRun, DelegationRequest } from './coordinator.js'
import { createCoordinatorReviewDeps } from './review-coordinator-deps.js'
import { classifyChangeScale, isCrossModule, isFixContext, type ChangeSet, type ReviewScale } from './review-discipline.js'
import { routeReviewWorkflow } from './review-router.js'
import { extractChangedFiles } from './diff-collector.js'
import { runTeamSkeleton, taskAuthority, type TeamRunInput, type TeamRunSummary } from './team-orchestrator.js'
import type { TeamTask } from './team-plan.js'
import { buildHistoricalTeamSchedulerState, type TeamSchedulerBanditState } from './team-scheduler-bandit.js'
import type { TeamSchedulerShadowEvent } from './team-scheduler-shadow.js'
import { persistGatedInfluenceAudit, type GatedInfluenceAuditEvent } from './gated-influence-audit.js'
import { buildTeamEpisodeFromStore, recordTeamEpisodeClosureFromStore } from './reward-loop.js'
import { formatTeamDelivery } from './team-episode.js'
import type { TeamWaveTelemetry } from './team-wave-telemetry.js'
import { buildTeamWaveScopeHealth, persistTeamScopeHealth } from './team-scope-health.js'
import type { AggregationPolicy } from './work-order.js'
import type { ImpactResult } from '../repo/meridian-impact.js'
import { runChangedFilesTypecheckMemo, typecheckGateEnabled, type TypecheckRunner } from './typecheck-gate.js'
import { getWaveResults, setWaveResults } from './wave-results-store.js'
import { evaluateWaveGate, formatWaveGate, getWaveGate, isWaveGateEnabled, setWaveGate } from './wave-gate.js'
import { evaluateSkillGate, extractRequiredSkills, formatSkillGateBlock, getInvokedSkills, isSkillGateEnabled } from './skill-gate.js'
import { skillRegistry } from '../skills/skill-loader.js'
import { clearCheckpoint, deriveTeamGroupId, loadCheckpoint, saveCheckpoint, type WaveCheckpoint } from './wave-checkpoint.js'
import { buildTeamOutcome, type TeamOrchestrationOutcome } from './orchestration-outcome.js'

/** Narrow surface for meridian structural impact analysis, so tests can mock it
 *  without the full MeridianIndexer. MeridianIndexer satisfies this structurally. */
export interface TeamImpactAnalyzer {
  impact(changedFiles: string[], opts?: { maxHops?: number }): ImpactResult
}

/** Coordinator + telemetry surface the shared executor needs. `delegateBatch`
 *  drives wave dispatch; `delegate` is required only when the review gate runs.
 *  All record/get hooks are optional so a lightly-wired caller still works. */
export interface PlanExecutorDeps {
  delegateBatch(
    requests: DelegationRequest[],
    policy?: AggregationPolicy,
    abortSignal?: AbortSignal,
    onProgress?: (completed: number, total: number) => void,
    onWorkerSettled?: (result: import('./work-order.js').WorkerResult) => void,
  ): Promise<CoordinatorRun>
  delegate?(request: DelegationRequest, abortSignal?: AbortSignal): Promise<CoordinatorRun>
  recordTeamWaveTelemetry?(event: TeamWaveTelemetry): void
  recordTeamWaveRewardClosure?(event: TeamWaveTelemetry): void
  recordTeamSchedulerShadow?(event: TeamSchedulerShadowEvent): void
  recordTeamSchedulerReward?(event: TeamWaveTelemetry): void
  recordGatedInfluenceAudit?(event: GatedInfluenceAuditEvent): void
  getTeamSchedulerState?: () => TeamSchedulerBanditState | undefined
  getTeamSchedulerRewardStore?: () => { saveBanditState?(kind: string, json: string): void; loadBanditStatesByPrefix?(prefix: string, limit?: number): Array<{ kind: string; json: string }> } | undefined
  isTeamSchedulerBanditEnabled?: () => boolean
  getSessionId?: () => string | undefined
  /** Optional meridian indexer for advisory blast-radius hints in the review gate. */
  getMeridianIndexer?: () => TeamImpactAnalyzer | null | undefined
  /** Optional injectable typecheck runner for the review-gate backstop. */
  getTypecheckRunner?: () => TypecheckRunner | undefined
}

export interface PlanExecutorOptions {
  mode: 'standard' | 'max'
  objective: string
  /** Pre-parsed tasks (UnifiedPlan path). */
  tasks?: TeamTask[]
  /** Markdown plan (team_orchestrate standard path). */
  planMarkdown?: string
  /** 计划点名的流程 skill（技能门禁用）。缺省时从 planMarkdown 提取；
   *  plan_task 走 tasks 路径无 markdown，读到计划文件时自行提取传入。 */
  requiredSkills?: string[]
  fromWave: number
  maxParallel?: number
  sessionId?: string
  parentTurnId?: string
  reviewDepth: number
  cwd: string
  abortSignal?: AbortSignal
  /** When false, the review-squadron dispatch is skipped. plan_task sets this
   *  false because its post-commit auto review gate covers it. */
  reviewGate: boolean
  onActivity?: DelegationRequest['onActivity']
  onPlanReady?: (summary: TeamRunSummary, fromWave: number) => void
  /** Per-wave progress passthrough (completed/total), for live tool output. */
  onProgress?: (completed: number, total: number) => void
  /** Per-worker settle passthrough (final result the moment each worker settles),
   *  for the subagent fleet panel terminal glyphs. */
  onWorkerSettled?: (result: import('./work-order.js').WorkerResult) => void
  /** 计划约束（D8 L2）：team-orchestrate 从 planPath 解析出的反目标/待验证假设，
   *  已渲染为 ≤400 字符的约束条目。透传进每波派发的 request.constraints（任务级
   *  约束在前，计划级在后）。缺省不注入——解析不到就是空，不报错不拦截。 */
  planConstraints?: string[]
  /** 上一波 scope-health 检出的计划外改动文件。由 executePlanWaves 在循环内
   *  从上一波 run 传入——单波直调时缺省为空，行为不变。 */
  priorScopeLeaks?: string[]
}

export interface PlanExecutorRun {
  summary: TeamRunSummary
  reviewVerdict?: string
  notes: {
    reviewNote: string
    scopeHealthNote: string
    impactNote: string
    deliverySynthesis: string
    /** 波间硬门禁结果（非末波评估；空串 = 未评估或禁用）。 */
    waveGateNote: string
  }
  /** 本波 scope-health 检出的计划外改动文件——由 executePlanWaves 传给下一波
   *  做跨波回执（见 team-wave-feedback.ts）。空数组 = 无泄漏或未评估。 */
  scopeLeakedFiles?: string[]
  /** 波间硬门禁结构化结果（从 evaluateWaveGate 返回值直接构造），
   *  供桌面端渲染 gate 失败卡。非末波且评估后才有值。 */
  gate?: { wave: number; passed: boolean; failures: string[] }
  /** review gate 审查全文/证据（截 ~1000 字），供桌面端展开阅读。 */
  reviewDetail?: string
}

/** Join a list, truncating to `n` entries with a trailing elision count so a
 *  large blast radius doesn't flood the review focus / returned content. */
function capList(items: string[], n = 8): string {
  return items.length <= n ? items.join(', ') : `${items.slice(0, n).join(', ')} (+${items.length - n} more)`
}

function requireDelegate(deps: PlanExecutorDeps): Required<Pick<PlanExecutorDeps, 'delegate'>>['delegate'] {
  if (!deps.delegate) throw new Error('plan execution review gate requires deps.delegate')
  return deps.delegate
}

/**
 * Authoritative changed-file list for the review gate. Worker `changedFiles` is
 * model self-reported and can be empty even when real edits happened; the diff
 * artifact carries the real list, so we union diff-derived files with the self-report.
 */
export function teamReviewChangedFiles(run: TeamRunSummary['run']): string[] {
  if (!run) return []
  const files = new Set<string>()
  for (const result of run.results) {
    for (const file of result.changedFiles) files.add(file)
    for (const artifact of result.artifacts) {
      if (artifact.kind === 'diff') {
        for (const file of extractChangedFiles(artifact.content)) files.add(file)
      }
    }
  }
  return [...files]
}

/**
 * Force the perspective-layer density that flash execution lacks.
 *  - max mode → always L3 (the full 5-inspector squadron), regardless of size.
 *  - standard mode → raise the floor to ≥L2, upgrade to L3 on structural risk
 *    (cross-module / ≥3 tasks in the wave / any high-risk task).
 */
export function teamReviewForceLevel(
  mode: 'standard' | 'max',
  change: ChangeSet,
  waveTasks: TeamTask[],
): ReviewScale {
  if (mode === 'max') return 'L3'
  const base = classifyChangeScale(change)
  const hasHighRisk = waveTasks.some(task => task.riskTier === 'high')
  if (base === 'L3' || change.crossModule || waveTasks.length >= 3 || hasHighRisk) return 'L3'
  return base === 'L1' ? 'L2' : base
}

/**
 * Turn the merged plan's per-task verification gates into a reviewer focus hint.
 * Empty when no verification was planned.
 */
export function teamReviewFocusHint(waveTasks: TeamTask[]): string | undefined {
  const gates = [...new Set(waveTasks.flatMap(task => task.verification).map(v => v.trim()).filter(Boolean))]
  if (gates.length === 0) return undefined
  return `Planned acceptance gates (verify these, do not just trust green): ${gates.join('; ')}`
}

/**
 * A1: build the wave checkpoint from this wave's summary. Pure — accumulates
 * prior completed results and derives the remaining (not yet dispatched) orders
 * from the wave plan, so /team-resume can rebuild a plan without the original
 * markdown.
 */
export function buildWaveCheckpoint(
  opts: Pick<PlanExecutorOptions, 'objective' | 'fromWave'>,
  summary: TeamRunSummary,
  prior: WaveCheckpoint | null,
): WaveCheckpoint {
  const taskById = new Map(summary.tasks.map(task => [task.id, task]))
  const remainingOrders = summary.waves
    .slice(opts.fromWave + 1)
    .flatMap(wave => wave.taskIds)
    .map(id => taskById.get(id))
    .filter((task): task is TeamTask => Boolean(task))
    .map(task => ({
      id: task.id,
      objective: task.objective,
      profile: task.profile,
      kind: task.kind,
      scope: { files: task.files },
      authority: taskAuthority(task),
      // 依赖随任务存盘——resume 重建计划要靠它恢复剩余任务间的顺序与条件边。
      ...(task.dependsOn.length > 0 ? { dependsOn: task.dependsOn } : {}),
    }))
  return {
    groupId: deriveTeamGroupId(opts.objective),
    timestamp: Date.now(),
    lastCompletedWave: opts.fromWave,
    completedResults: [...(prior?.completedResults ?? []), ...(summary.run?.results ?? [])],
    remainingOrders,
    objective: opts.objective,
    totalWaves: summary.waves.length,
  }
}

/**
 * Run a plan's wave-by-wave execution + closed loop. Throws on dispatch failure
 * (the tool layer wraps and reports). Returns the structured summary + notes the
 * tool stitches into its content/uiContent.
 */
export async function executePlan(opts: PlanExecutorOptions, deps: PlanExecutorDeps): Promise<PlanExecutorRun> {
  let telemetryEvent: TeamWaveTelemetry | undefined

  // ── 技能门禁（入口侧，仅首波）：计划点名的 skill 可加载但未加载 → 硬拦 ──
  // 长庚域事故（2026-07-25）：计划写明「使用 executing-plans」，执行方以纪律
  // 重叠为由跳过加载。点名 skill 是计划专属流程契约，机械拦截而非劝告。
  // 续波（fromWave>0）不再查——skill 正文已在首波前进入消息历史。
  // 点名但运行时不可加载的 skill 不拦（计划可能写于别的技能环境）。
  if (isSkillGateEnabled() && opts.fromWave === 0) {
    const required = opts.requiredSkills ?? (opts.planMarkdown ? extractRequiredSkills(opts.planMarkdown) : [])
    if (required.length > 0) {
      const verdict = evaluateSkillGate(required, {
        availableNames: new Set(skillRegistry.list().map(s => s.name)),
        invokedNames: getInvokedSkills(opts.sessionId),
      })
      if (verdict.missing.length > 0) {
        throw new Error(formatSkillGateBlock(verdict.missing))
      }
    }
  }

  // ── 波间硬门禁（入口侧）：上一波门禁未通过 → 禁止 dispatch 本波 ──
  // 自愈：主控可能已直接修复代码（而非重跑波），拦截前先复评一次；
  // 复评通过则放行并更新记录。RIVET_WAVE_GATE=0 可整体禁用。
  if (isWaveGateEnabled() && opts.fromWave > 0) {
    const prior = getWaveGate(opts.sessionId)
    if (prior && prior.wave === opts.fromWave - 1 && !prior.passed) {
      const recheck = await evaluateWaveGate({
        cwd: opts.cwd,
        wave: prior.wave,
        changedFiles: prior.changedFiles,
        commands: prior.commands,
        typecheckRunner: deps.getTypecheckRunner?.(),
      })
      setWaveGate(recheck, opts.sessionId)
      if (!recheck.passed) {
        throw new Error(
          `波间硬门禁：wave ${prior.wave + 1} 验证未通过，禁止派发 wave ${opts.fromWave + 1}。\n` +
          formatWaveGate(recheck).join('\n') +
          `\n先修复失败项（或重跑该波），门禁复评通过后方可继续。逃生阀：RIVET_WAVE_GATE=0。`,
        )
      }
    }
  }

  // Cross-wave failure propagation: pull the prior wave's results (Phase B —
  // session-scoped so the plan_task → team_orchestrate bridge survives).
  const priorResults = opts.fromWave > 0 ? getWaveResults(opts.sessionId) : undefined

  // 跨波回执数据源（2026-08-05 闭环审计）：上一波门禁未过项。入口硬门禁在上方
  // 已放行（要么通过、要么复评通过、要么被 throw 拦住），走到这里说明本波可以
  // 派发——但上一波「曾经红过什么」对下一波 worker 仍是有用情报，一并下传。
  const priorWaveGateFailures = opts.fromWave > 0
    ? (getWaveGate(opts.sessionId)?.checks ?? [])
        .filter(c => c.status === 'failed' || (c.blocking === true && c.status !== 'passed'))
        .map(c => c.command)
    : []

  const summary = await runTeamSkeleton(
    {
      mode: opts.mode,
      objective: opts.objective,
      planMarkdown: opts.planMarkdown,
      tasks: opts.tasks,
      maxParallel: opts.maxParallel,
      fromWave: opts.fromWave,
      parentTurnId: opts.parentTurnId,
      abortSignal: opts.abortSignal,
      priorResults,
      teamSchedulerBanditEnabled: deps.isTeamSchedulerBanditEnabled?.() === true,
      onActivity: opts.onActivity,
      onWorkerSettled: opts.onWorkerSettled,
      onPlanReady: opts.onPlanReady,
      // D8 L2：计划约束透传（team-orchestrator 分片在 TeamRunInput 消费并并入
      // waveToRequests 的 request.constraints）。条件注入——空则不带，fail-open。
      ...(opts.planConstraints && opts.planConstraints.length > 0 ? { planConstraints: opts.planConstraints } : {}),
      // 跨波回执：条件注入，空则不带字段——wave 0 与一切正常的波次行为不变。
      ...(priorWaveGateFailures.length > 0 ? { priorWaveGateFailures } : {}),
      ...(opts.priorScopeLeaks && opts.priorScopeLeaks.length > 0 ? { priorScopeLeaks: opts.priorScopeLeaks } : {}),
    } as TeamRunInput,
    {
      delegateBatch: (requests, policy, abortSignal, onProgress, onWorkerSettled) =>
        deps.delegateBatch(requests, policy, abortSignal, (completed, total) => {
          onProgress?.(completed, total)
          opts.onProgress?.(completed, total)
        }, onWorkerSettled ?? opts.onWorkerSettled),
      recordTeamWaveTelemetry: event => {
        telemetryEvent = event
        deps.recordTeamWaveTelemetry?.(event)
      },
      recordTeamSchedulerShadow: event => deps.recordTeamSchedulerShadow?.(event),
      recordGatedInfluenceAudit: event => {
        if (deps.recordGatedInfluenceAudit) {
          deps.recordGatedInfluenceAudit(event)
          return
        }
        const store = deps.getTeamSchedulerRewardStore?.()
        if (store?.saveBanditState) persistGatedInfluenceAudit({ saveBanditState: store.saveBanditState.bind(store) }, event)
      },
      teamSchedulerState: deps.getTeamSchedulerState?.() ?? buildHistoricalTeamSchedulerState(deps.getTeamSchedulerRewardStore?.()),
      sessionId: deps.getSessionId?.(),
      // Track 2: 计划骨架缓存与 reward 共用同一 append-only 存储。
      planCacheStore: deps.getTeamSchedulerRewardStore?.(),
    },
  )

  // Cache this wave's results so the next wave (or the other tool) can propagate
  // failures forward.
  if (summary.run?.results) {
    setWaveResults(summary.run.results, opts.sessionId)
  }

  // A1: persist a wave checkpoint so an interrupted/failed run can be resumed
  // via /team-resume. Best-effort — checkpoint I/O never blocks the wave result.
  if (summary.run?.results) {
    try {
      const prior = loadCheckpoint(opts.cwd, deriveTeamGroupId(opts.objective))
      saveCheckpoint(opts.cwd, buildWaveCheckpoint(opts, summary, prior))
    } catch {
      // Checkpoints are a resume convenience; never affect dispatch.
    }
  }

  let reviewNote = ''
  let deliverySynthesis = ''
  let impactNote = ''
  let reviewVerdict: string | undefined
  const effectiveFromWave = opts.fromWave
  const isLastWave = summary.waves.length > 0 && effectiveFromWave >= summary.waves.length - 1

  // Scope-health (advisory): compare the real diff (telemetry's observedChangedFiles)
  // against planned.files to detect leak / missing coverage. Persist for learning,
  // surface medium/high, feed leaked files to the review focus. Never blocks.
  let scopeHealthNote = ''
  let scopeLeakedFiles: string[] = []
  if (telemetryEvent) {
    try {
      const health = buildTeamWaveScopeHealth(telemetryEvent)
      const rewardStore = deps.getTeamSchedulerRewardStore?.()
      persistTeamScopeHealth(
        rewardStore?.saveBanditState ? { saveBanditState: rewardStore.saveBanditState.bind(rewardStore) } : undefined,
        health,
      )
      if (health.severity === 'medium' || health.severity === 'high') {
        scopeLeakedFiles = health.leakedFiles
        const parts: string[] = []
        if (health.leakedFiles.length > 0) parts.push(`leaked (changed, not planned): ${health.leakedFiles.join(', ')}`)
        if (health.missingFiles.length > 0) parts.push(`missing (planned, untouched): ${health.missingFiles.join(', ')}`)
        scopeHealthNote = `\n\nScope health [${health.severity}]: ${parts.join('; ')}`
      }
    } catch {
      // Scope health is advisory; never affect dispatch or review.
    }
  }

  // Review gate — gated by reviewGate (plan_task skips: post-commit auto review
  // covers it). reviewDepth guard prevents review workers from recursively
  // triggering another review pass.
  const changedFiles = teamReviewChangedFiles(summary.run)
  if (opts.reviewGate && isLastWave && changedFiles.length > 0 && opts.reviewDepth === 0) {
    try {
      const delegate = requireDelegate(deps)
      const taskById = new Map(summary.tasks.map(task => [task.id, task]))
      const waveTasks = (summary.waves[effectiveFromWave]?.taskIds ?? [])
        .map(id => taskById.get(id))
        .filter((task): task is TeamTask => Boolean(task))
      const change: ChangeSet = {
        files: changedFiles,
        crossModule: isCrossModule(changedFiles),
        isFix: isFixContext(opts.objective),
      }
      change.forceLevel = teamReviewForceLevel(opts.mode, change, waveTasks)
      const baseFocus = teamReviewFocusHint(waveTasks)
      // Advisory blast radius (meridian): downstream consumers + related tests for
      // the diff-derived observedChangedFiles. Never blocks; failures swallowed.
      let impactFocus: string | undefined
      try {
        const analyzer = deps.getMeridianIndexer?.()
        const observed = (telemetryEvent?.changedFiles.observedChangedFiles ?? []).filter(f => !isAbsolute(f))
        if (analyzer && observed.length > 0) {
          const impact = analyzer.impact(observed)
          const consumers = [...impact.direct, ...impact.transitive]
          const seg: string[] = []
          if (consumers.length > 0) seg.push(`downstream consumers (verify not broken): ${capList(consumers)}`)
          if (impact.tests.length > 0) seg.push(`related tests to run: ${capList(impact.tests)}`)
          if (seg.length > 0) {
            impactFocus = `Blast radius — ${seg.join('; ')}`
            impactNote = `\n\nBlast radius [meridian]: ${seg.join('; ')}`
          }
        }
      } catch {
        // Impact hints are advisory; never affect dispatch or review.
      }
      // Typecheck backstop — scoped tsc on the diff-derived changed files; a real
      // type error escalates the review to L3 and is surfaced FIRST. Advisory.
      let typecheckFocus: string | undefined
      const typecheckRunner = deps.getTypecheckRunner?.()
      if (typecheckGateEnabled() && typecheckRunner) {
        try {
          const observed = (telemetryEvent?.changedFiles.observedChangedFiles ?? []).filter(f => !isAbsolute(f))
          const tc = await runChangedFilesTypecheckMemo(opts.cwd, observed, typecheckRunner)
          if (tc) {
            change.forceLevel = 'L3'
            typecheckFocus = `Typecheck — ${tc.summary}`
            impactNote = `\n\nTypecheck broken [tsc]: ${tc.summary}` + impactNote
          }
        } catch {
          // Typecheck gate is advisory; never affect dispatch or review.
        }
      }
      const focusParts = [
        typecheckFocus,
        baseFocus,
        scopeLeakedFiles.length > 0
          ? `Scope leak — files changed outside the plan, scrutinize these: ${scopeLeakedFiles.join(', ')}`
          : undefined,
        impactFocus,
      ].filter((s): s is string => Boolean(s))
      const focusHint = focusParts.length > 0 ? focusParts.join(' | ') : undefined
      const reviewDeps = createCoordinatorReviewDeps(
        {
          delegate: (request, abortSignal) => delegate(request, abortSignal),
          delegateBatch: (requests, policy, abortSignal, onProgress) =>
            deps.delegateBatch(requests, policy, abortSignal, onProgress),
        },
        { reviewDepth: opts.reviewDepth, abortSignal: opts.abortSignal, parentTurnId: `${opts.parentTurnId}:review` },
      )
      const outcome = await routeReviewWorkflow(change, reviewDeps, { maxRounds: 3, ...(focusHint ? { focusHint } : {}) })
      reviewVerdict = outcome.verdict
      reviewNote = `\n\nReview gate [${outcome.tier}]: ${outcome.verdict}${outcome.evidence ? ` — ${outcome.evidence}` : ''}`
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`review gate failed: ${msg}`)
    }
  }

  // ── 波间硬门禁（出口侧）：非末波完成后立即评估 typecheck + 该波验证命令 ──
  // 结果存会话级 store；失败不在此处抛错（本波成果已产出，留给下一波入口拦），
  // 但 note 必须留痕让主控立刻看到。
  let waveGateNote = ''
  let gate: PlanExecutorRun['gate'] | undefined
  if (isWaveGateEnabled() && !isLastWave && summary.run) {
    try {
      const taskById = new Map(summary.tasks.map(task => [task.id, task]))
      const waveTasks = (summary.waves[effectiveFromWave]?.taskIds ?? [])
        .map(id => taskById.get(id))
        .filter((task): task is TeamTask => Boolean(task))
      const commands = [...new Set(waveTasks.flatMap(task => task.verification).map(v => v.trim()).filter(Boolean))]
      if (changedFiles.length > 0 || commands.length > 0) {
        const record = await evaluateWaveGate({
          cwd: opts.cwd,
          wave: effectiveFromWave,
          changedFiles: changedFiles.filter(f => !isAbsolute(f)),
          commands,
          typecheckRunner: deps.getTypecheckRunner?.(),
        })
        setWaveGate(record, opts.sessionId)
        waveGateNote = `\n\n${formatWaveGate(record).join('\n')}`
        if (!record.passed) {
          waveGateNote += `\n⛔ 下一波派发将被硬拦，先修复失败项。逃生阀：RIVET_WAVE_GATE=0。`
        }
        gate = {
          wave: record.wave,
          passed: record.passed,
          failures: record.checks
            .filter(c => c.status === 'failed' || (c.blocking && c.status !== 'passed'))
            .map(c => `${c.command}${c.detail ? ` — ${c.detail}` : ''}`),
        }
      }
    } catch {
      // 门禁评估自身故障不阻断波结果返回（fail-open 只针对评估器崩溃，
      // 验证命令失败仍是硬拦）。
    }
  }

  if (telemetryEvent) {
    const closedTelemetry = {
      ...telemetryEvent,
      outcome: {
        ...telemetryEvent.outcome,
        ...(reviewVerdict ? { reviewVerdict } : {}),
      },
    }
    try {
      deps.recordTeamWaveRewardClosure?.(closedTelemetry)
    } catch {
      // Reward closure must never affect team dispatch or review reporting.
    }
    try {
      deps.recordTeamSchedulerReward?.(closedTelemetry)
    } catch {
      // Scheduler reward must never affect team dispatch or review reporting.
    }
    if (isLastWave) {
      try {
        recordTeamEpisodeClosureFromStore(deps.getTeamSchedulerRewardStore?.(), closedTelemetry)
      } catch {
        // Episode closure must never affect team dispatch or review reporting.
      }
      try {
        const episode = buildTeamEpisodeFromStore(deps.getTeamSchedulerRewardStore?.(), closedTelemetry)
        deliverySynthesis = `\n\n${formatTeamDelivery(episode)}`
      } catch {
        // Delivery synthesis is presentation-only; never block the wave result.
      }
    }
  }

  // A1: the run is fully delivered — drop the checkpoint. Failed/blocked results
  // on the last wave keep it, because that is exactly the resume scenario.
  if (isLastWave && summary.run?.results && summary.run.results.every(result => result.status === 'passed')) {
    try {
      clearCheckpoint(opts.cwd, deriveTeamGroupId(opts.objective))
    } catch {
      // Checkpoints are a resume convenience; never affect delivery.
    }
  }

  return {
    summary,
    reviewVerdict,
    notes: { reviewNote, scopeHealthNote, impactNote, deliverySynthesis, waveGateNote },
    ...(scopeLeakedFiles.length > 0 ? { scopeLeakedFiles } : {}),
    gate,
    // P4 fix: reviewVerdict is just a single enum word (e.g. "verified") — the
    // real content with evidence is reviewNote. Strip leading newlines for the
    // inline panel display.
    ...(reviewNote ? { reviewDetail: reviewNote.replace(/^\n+/, '').slice(0, 1000) } : {}),
  }
}

// ─────────────────────────────────────────────────────────────────────
// 共享多波驱动（Wave 3A）：team_orchestrate / plan_task 复用的多波闭环。
// executePlan 保持单波语义不变；本驱动按 fromWave 逐波推进、判定停止、
// 聚合每波结果，让调用方不再各自手写波循环。
// ─────────────────────────────────────────────────────────────────────

/** 多波驱动护栏：单次 executePlanWaves 最多推进的波数（防 totalWaves 异常 /
 *  计划循环导致的失控续波）。 */
export const EXECUTE_PLAN_WAVES_GUARDRAIL = 10

export interface WaveStopContext {
  /** 已中止 → 停止推进下一波。 */
  abortSignal?: AbortSignal
}

/**
 * 多波驱动的停止判据（纯函数）。输入单波 outcome，返回是否应停止推进下一波。
 *  - 本波零通过且存在 worker → 整波失败，续波无意义
 *  - wave gate failed（非末波出口评估）→ 下一波入口会被硬拦，直接停
 *  - review rejected / inconclusive → 改动被驳回（inconclusive = review 未
 *    实际执行，不可视为通过），停止
 *  - abort → 调用方取消
 *  isError 不在本函数：executePlan 在 dispatch / 门禁 / review 失败时抛错，
 *  由 executePlanWaves 让异常向上传播即停；「无下一波」「10 波护栏」是循环
 *  级判据（依赖 wave 序号），由 executePlanWaves 的 break 条件承担。
 */
export function classifyWaveStop(outcome: TeamOrchestrationOutcome, ctx: WaveStopContext = {}): boolean {
  if (ctx.abortSignal?.aborted) return true
  if (outcome.workers.total > 0 && outcome.workers.passed === 0) return true
  if (outcome.waveGate && !outcome.waveGate.passed) return true
  if (outcome.reviewVerdict === 'rejected' || outcome.reviewVerdict === 'inconclusive') return true
  return false
}

/**
 * 聚合多波 PlanExecutorRun 为单波形状的结果（与 executePlan 返回值兼容，
 *  team_orchestrate / plan_task 可直接按单波结果消费）。
 *  - summary：run.results 并集（保序）、dispatched 累计，其余取最后一波
 *  - notes：各波对应字段拼接——scope-health / delivery synthesis / review /
 *    wave-gate 任一波的内容都不丢
 *  - gate / reviewDetail：取最近一个有值的（gate 只在非末波出口出现，
 *    reviewDetail 只在末波 review 出现；中途停止时最近 gate 恰是停止原因）
 *  每波完整对象仍保留在 runs（逐波 gate/reviewDetail 差异读 runs[i]）。
 */
export function aggregatePlanExecutorRuns(runs: PlanExecutorRun[]): PlanExecutorRun {
  if (runs.length === 0) throw new Error('aggregatePlanExecutorRuns: no runs to aggregate')
  const summaries = runs.map(run => run.summary)
  const lastRun = runs[runs.length - 1]!
  const last = lastRun.summary
  const results = summaries.flatMap(summary => summary.run?.results ?? [])
  const summary: TeamRunSummary = {
    ...last,
    dispatched: summaries.reduce((n, s) => n + s.dispatched, 0),
    run: last.run ? { ...last.run, results } : undefined,
  }
  const notes: PlanExecutorRun['notes'] = {
    reviewNote: runs.map(run => run.notes.reviewNote).filter(Boolean).join('\n'),
    scopeHealthNote: runs.map(run => run.notes.scopeHealthNote).filter(Boolean).join('\n'),
    impactNote: runs.map(run => run.notes.impactNote).filter(Boolean).join('\n'),
    deliverySynthesis: runs.map(run => run.notes.deliverySynthesis).filter(Boolean).join('\n'),
    waveGateNote: runs.map(run => run.notes.waveGateNote).filter(Boolean).join('\n'),
  }
  const gate = [...runs].reverse().find(run => run.gate)?.gate
  const reviewDetail = [...runs].reverse().find(run => run.reviewDetail)?.reviewDetail
  return {
    summary,
    reviewVerdict: lastRun.reviewVerdict,
    notes,
    ...(gate ? { gate } : {}),
    ...(reviewDetail ? { reviewDetail } : {}),
  }
}

export interface PlanExecutorWavesOptions {
  /** 起始波（缺省 0）。 */
  startWave?: number
  /** false 时只执行 startWave 一波（单波语义的便捷入口）。缺省 true。 */
  autoAdvance?: boolean
  /** 波数硬上限（exclusive：wave < maxWaves）。缺省 startWave + 10（护栏）；
   *  计划真实总波数更小则按 outcome.totalWaves 提前 break。 */
  maxWaves?: number
  /** 每波完成回调（run 已入 runs 后、停止判定前调用）。 */
  onWave?: (run: PlanExecutorRun, wave: number) => void
}

export interface PlanExecutorWavesResult {
  /** 每波完整 run（含各自 gate/reviewDetail/results），逐波差异读这里。 */
  runs: PlanExecutorRun[]
  /** 聚合视图（aggregatePlanExecutorRuns 输出，单波形状）。 */
  run: PlanExecutorRun
}

/**
 * 共享多波驱动：按 fromWave 逐波调用 executePlan，每波独立持久化 checkpoint
 * 与波结果（executePlan 内部职责，此处不重复），停止判定后聚合返回。
 *  - 波序号由 startWave 驱动（不接受 fromWave——循环内逐波覆盖）。
 *  - 中间波不提前执行末波 review：executePlan 的 isLastWave 由 fromWave 判定，
 *    本驱动每波传真实 wave 序号，末波 review / episode closure / checkpoint
 *    清除只在最后一波触发。
 *  - isError 停止：executePlan 在 dispatch / 波间硬门禁入口 / review gate
 *    失败时抛错，本驱动让异常向上传播（调用方 try/catch 包装），不再推进后续波。
 */
export async function executePlanWaves(
  opts: Omit<PlanExecutorOptions, 'fromWave'> & PlanExecutorWavesOptions,
  deps: PlanExecutorDeps,
): Promise<PlanExecutorWavesResult> {
  const startWave = opts.startWave ?? 0
  const autoAdvance = opts.autoAdvance ?? true
  const maxWaves = opts.maxWaves ?? startWave + EXECUTE_PLAN_WAVES_GUARDRAIL
  if (maxWaves <= startWave) {
    throw new Error(`executePlanWaves: maxWaves (${maxWaves}) must be > startWave (${startWave})`)
  }
  // 解构出驱动字段，剩余透传给单波 executePlan（多余键运行时被忽略）。
  const { startWave: _startWave, autoAdvance: _autoAdvance, maxWaves: _maxWaves, onWave, ...planOpts } = opts
  const runs: PlanExecutorRun[] = []
  // 跨波回执：上一波的 scope 泄漏没有会话级 store（门禁与 worker 结果都有），
  // 由本驱动在循环内直接接力。单波直调 executePlan 时该字段缺省为空。
  let priorScopeLeaks: string[] = []
  for (let wave = startWave; wave < maxWaves; wave++) {
    const run = await executePlan(
      { ...planOpts, fromWave: wave, ...(priorScopeLeaks.length > 0 ? { priorScopeLeaks } : {}) },
      deps,
    )
    priorScopeLeaks = run.scopeLeakedFiles ?? []
    runs.push(run)
    onWave?.(run, wave)
    const outcome = buildTeamOutcome(run.summary, wave, run)
    const stop = classifyWaveStop(outcome, { abortSignal: opts.abortSignal })
    // 停止：本波判据（零通过 / waveGate / review / abort）、autoAdvance=false、
    // 或已到计划末波（wave + 1 >= totalWaves；maxWaves 为护栏后备上限）。
    if (stop || !autoAdvance || wave + 1 >= outcome.totalWaves) break
  }
  return { runs, run: aggregatePlanExecutorRuns(runs) }
}

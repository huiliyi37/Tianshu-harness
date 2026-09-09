import type { SrClass } from './context.js'
import type { GoalTracker } from './goal-tracker.js'
import type { GoalJudgeDeps } from './goal-judge.js'
import { runGoalJudge } from './goal-judge.js'
import { rejectOnAbort } from './turn-boundary-abort.js'
import { saveGoalState } from './goal-persist.js'
import { getSessionDir } from './session-persist.js'
import type { CompleteTurnParams } from './turn-orchestrator.js'
import type { AgentCallbacks } from './loop-types.js'
import type { TelemetryRecord } from './telemetry-writer.js'
import { hasActionIntent } from './action-intent-detector.js'
import { DELIVERY_SIGNAL_RE } from './action-intent-detector.js'

// ── Types ──

export interface GoalContinuationDeps {
  getGoalTracker: () => GoalTracker | null
  /** 待批计划探针（2026-07-24 goal 审批感知）：最新计划为 submitted（等用户审批）
   *  时返回 true。读取失败必须 fail-open 返回 false——宁可空转不可假死。 */
  hasPendingPlanApproval?: () => Promise<boolean>
  getGoalJudgeDeps?: () => GoalJudgeDeps | undefined
  getGoalJudgeEvidence?: () => { text: string; modifiedFiles: string[] }
  getStreamedText: () => string
  getEstimatedTokens: () => number
  getSessionId: () => string | undefined
  getCwd: () => string
  appendSystemReminder: (content: string, cls?: SrClass) => void
  /** 同 appendSystemReminder，但返回 boolean 表示是否成功注入（未被 W3 cap 拦截）。
   *  W1 通道分级：functional 类不限流，注入不可能失败。 */
  appendSystemReminderAndReport: (content: string, cls?: SrClass) => boolean
  /** 重置本轮 discipline SR 计数器——W1 通道分级后仅 loop.ts 每用户轮调用。
   *  functional 类调用方不再需要 resetSrCount 前置 hack。 */
  resetSrCount: () => void
  completeTurn: (params: CompleteTurnParams) => Promise<void>
  writeTelemetry: (entry: TelemetryRecord) => void
  flushMeridianTurn: () => void
}

export type GoalCheckResult =
  | { kind: 'continue' }
  | { kind: 'accept' }
  | { kind: 'finalize' }

export interface GoalCheckParams {
  streamedText: string
  estimatedTokens: number
  isAborted: boolean
  turn: number
  callbacks: AgentCallbacks
  signal: AbortSignal
}

// ── Controller ──

export class GoalContinuationController {
  constructor(private deps: GoalContinuationDeps) {}

  /**
   * Run the full goal-continuation check for this turn.
   *
   * Returns:
   * - 'continue' — goal still active, orchestrator should re-enter the loop.
   *   completeTurn(isFinal:false) + appendSystemReminder already called internally.
   * - 'accept' — goal achieved and accepted. appendSystemReminder already called.
   *   Orchestrator should fall through to final completion.
   * - 'finalize' — no active goal tracker, or tracker deactivated. Orchestrator
   *   should fall through to phantom check / final completion.
   */
  async handleGoalCheck(params: GoalCheckParams): Promise<GoalCheckResult> {
    const tracker = this.deps.getGoalTracker()
    if (!tracker?.isActive()) return { kind: 'finalize' }

    // 待批计划闸门（2026-07-24）：计划已提交等用户审批时 goal 循环不空转——
    // 空转既白烧 iteration，又让 session.running 恒 true 把批准 API 409 到死
    //（goal 看起来假死，用户想批都批不了）。保持 goal active 直接 finalize；
    // 批准后 kickoff 轮末自然恢复续跑，驳回（rejected ≠ submitted）同样放行。
    if (this.deps.hasPendingPlanApproval && (await this.deps.hasPendingPlanApproval())) {
      return { kind: 'finalize' }
    }

    const signal = params.signal
    const goalResult = tracker.check(
      params.streamedText,
      params.estimatedTokens,
      params.isAborted,
    )

    if (goalResult.shouldContinue) {
      // ── Proactive delivery gate ──
      // The default shouldContinue=true path skips the LLM judge entirely —
      // the model can finish its work without saying "GOAL ACHIEVED" and
      // still get force-continued, paying 7-8K cacheCreate per useless turn.
      // Check: when the turn text looks like a natural delivery (delivery
      // signals, no new action intent), route to the judge instead of
      // blindly auto-continuing. If the judge agrees it's done, no extra turn.
      const looksDone =
        params.streamedText.length > 0 &&
        !hasActionIntent(params.streamedText) &&
        DELIVERY_SIGNAL_RE.test(params.streamedText)
      if (looksDone) {
        const decision = await this.judgeGoalCompletion(tracker, signal)
        if (decision.action === 'continue') {
          tracker.advanceIteration()
          return this.finishContinuation(tracker, signal, params, decision.reminder)
        }
        this.deps.appendSystemReminder(decision.reminder, 'functional')
        tracker.deactivate('achieved')
        this.persistGoalState(tracker)
        this.deps.flushMeridianTurn()
        return { kind: 'accept' }
      }

      tracker.advanceIteration()
      return this.finishContinuation(tracker, signal, params, null)
    }

    if (goalResult.reason === 'achieved') {
      const decision = await this.judgeGoalCompletion(tracker, signal)
      if (decision.action === 'continue') {
        tracker.advanceIteration()
        return this.finishContinuation(tracker, signal, params, decision.reminder)
      } else {
        this.deps.appendSystemReminder(decision.reminder, 'functional')
        tracker.deactivate('achieved')
        this.persistGoalState(tracker)
        this.deps.flushMeridianTurn()
        return { kind: 'accept' }
      }
    }

    // budget/context/wall-clock/cancelled: deactivate
    const deactivationReason = goalResult.reason === 'budget_exhausted' ? 'budget_exhausted'
      : goalResult.reason === 'context_limit' ? 'context_limit'
      : goalResult.reason === 'wall_clock_exhausted' ? 'budget_exhausted'
      : 'cancelled'
    tracker.deactivate(deactivationReason)
    this.persistGoalState(tracker)
    this.deps.flushMeridianTurn()
    return { kind: 'finalize' }
  }

  private persistGoalState(tracker: GoalTracker): void {
    const sid = this.deps.getSessionId()
    if (sid) {
      try { saveGoalState(getSessionDir(this.deps.getCwd()), sid, tracker) } catch { /* best-effort */ }
    }
  }

  private async finishContinuation(
    tracker: GoalTracker,
    signal: AbortSignal,
    params: GoalCheckParams,
    judgeReminder: string | null,
  ): Promise<GoalCheckResult> {
    this.persistGoalState(tracker)
    this.deps.flushMeridianTurn()

    await rejectOnAbort(
      this.deps.completeTurn({ turn: params.turn, isFinal: false, callbacks: params.callbacks, continuationReason: 'goal-continuation' }),
      signal,
      'goal-continue-complete',
    )

    if (judgeReminder) {
      this.deps.appendSystemReminder(judgeReminder, 'functional')
    } else {
      const iter = tracker.getIteration()
      const maxIter = tracker.getMaxIterations()
      const wallElapsed = Math.round(tracker.getWallClockElapsedMs() / 1000)
      const wallBudget = tracker.getWallClockBudgetMs()
      const wallInfo = wallBudget
        ? ` ⏱${wallElapsed}s/${Math.round(wallBudget / 1000)}s`
        : ` ⏱${wallElapsed}s`
      this.deps.appendSystemReminder(
        `[GOAL CONTINUATION ${iter}/${maxIter}${wallInfo}] 目标尚未达成。继续执行。\n` +
        `目标: ${tracker.getGoal()}\n` +
        `上轮输出摘要: ${this.deps.getStreamedText().slice(-500)}\n` +
        `完成后输出 "GOAL ACHIEVED" 声明完成。遇到无法解决的阻塞时输出 "GOAL BLOCKED"。`,
        'functional'
      )
    }
    return { kind: 'continue' }
  }

  /**
   * Gate a self-declared goal completion through the independent judge.
   * Extracted verbatim from TurnOrchestrator.judgeGoalCompletion.
   */
  async judgeGoalCompletion(
    tracker: GoalTracker,
    signal: AbortSignal | undefined,
  ): Promise<{ action: 'accept' | 'continue'; reminder: string }> {
    const achievedReminder = (suffix = ''): string =>
      `[GOAL] 目标已达成（${tracker.getIteration()} 次迭代）。Goal tracker 已关闭。${suffix}\n` +
      `运行 deliver_task commit=true 提交最终改动，系统将自动触发 L3 审查。`

    const judgeDeps = this.deps.getGoalJudgeDeps?.()
    if (!judgeDeps) {
      return { action: 'accept', reminder: achievedReminder() }
    }

    tracker.recordJudgeRun()
    const evidence = this.deps.getGoalJudgeEvidence?.() ?? { text: '', modifiedFiles: [] }
    const verdict = await rejectOnAbort(
      runGoalJudge(judgeDeps, {
        objective: tracker.getGoal(),
        criteria: tracker.getSuccessCriteria(),
        evidence: evidence.text,
        finalClaim: this.deps.getStreamedText(),
        scopeFiles: evidence.modifiedFiles,
        signal,
      }),
      signal!,
      'goal-judge',
    )

    let action: 'accept' | 'continue'
    let reminder: string
    let acceptedUnverified = false

    if (verdict.overall === 'verified') {
      action = 'accept'
      reminder = achievedReminder(' Judge 已独立核验全部验收项。')
    } else if (verdict.overall === 'rejected') {
      if (tracker.getJudgeRuns() < tracker.getMaxJudgeRuns()) {
        const unmet = verdict.criteria
          .filter(c => c.met === false)
          .map(c => `- ${c.criterion}${c.evidence ? `（证据: ${c.evidence}）` : ''}`)
        const iter = tracker.getIteration()
        const maxIter = tracker.getMaxIterations()
        action = 'continue'
        reminder =
          `[GOAL JUDGE 驳回 ${tracker.getJudgeRuns()}/${tracker.getMaxJudgeRuns()}] 完成声明未通过独立核验，继续执行。\n` +
          `目标: ${tracker.getGoal()}\n` +
          `未达成的验收项:\n${unmet.length > 0 ? unmet.join('\n') : `- ${verdict.summary || '判定未达成'}`}\n` +
          `请修复后再次输出 "GOAL ACHIEVED"。（迭代 ${iter}/${maxIter}）`
      } else {
        action = 'accept'
        reminder = achievedReminder(
          ` ⚠️ Judge 仍判定未完全达成（已达 ${tracker.getMaxJudgeRuns()} 次核验上限，接受为未完全验证）。残留: ${verdict.summary || '见上轮判定'}。`,
        )
        acceptedUnverified = true
      }
    } else {
      action = 'accept'
      reminder = achievedReminder(` ⚠️ Judge 未能独立验证（${verdict.summary || '原因未知'}），接受为未验证完成。`)
      acceptedUnverified = true
    }

    if (action === 'accept') {
      const criteriaMet = verdict.criteria.filter(c => c.met === true).length
      const criteriaUnmet = verdict.criteria.filter(c => c.met === false).length
      tracker.setLastVerdict({
        overall: verdict.overall,
        criteriaMet,
        criteriaUnmet,
        criteriaTotal: verdict.criteria.length,
        summary: verdict.summary,
      })
      this.deps.writeTelemetry({
        kind: 'goal_judge_verdict',
        overall: verdict.overall,
        judgeRuns: tracker.getJudgeRuns(),
        maxJudgeRuns: tracker.getMaxJudgeRuns(),
        criteriaTotal: verdict.criteria.length,
        criteriaMet,
        criteriaUnmet,
        acceptedUnverified,
        iteration: tracker.getIteration(),
      })
    }

    return { action, reminder }
  }
}

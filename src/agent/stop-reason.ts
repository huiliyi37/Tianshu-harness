/**
 * Structured stop-reason — a single, unified record of WHY a turn loop ended.
 *
 * Motivation ("反面找被熔断的原因"): before this, a premature guard-forced stop
 * was indistinguishable from a model voluntarily finishing. maxTurns exhaustion
 * only debug-logged; the convergence hard-abort called onAbort() with NO reason,
 * so it surfaced as a bare "⏹ Interrupted" — the user could not tell "the model
 * wrapped up on its own" from "a guard killed a still-reasoning turn" from "I
 * hit Esc". Without that signal we can't tell whether a long-reasoning model was
 * genuinely stuck or was熔断 (circuit-broken) mid-thought.
 *
 * This module is pure (types + formatters + the onAbort tag mapping). Call sites
 * emit it through the existing channels (onPhaseChange / debugLog / telemetry) —
 * it never rewrites message history, so the prefix cache is untouched.
 */

export type StopReasonSource =
  /** Model produced a final answer with no tool call. Voluntary. */
  | 'natural-finish'
  /** A tool (e.g. ask_user_question) requested turn termination. Voluntary. */
  | 'end-turn'
  /** Score-based convergence hard abort. Guard-forced. */
  | 'convergence-abort'
  /** N consecutive no-tool turns hard abort. Guard-forced. */
  | 'no-tool-abort'
  /** Hard-stall watchdog aborted a wedged turn. Guard-forced. */
  | 'watchdog-stall'
  /** maxTurns budget exhausted before a final turn. Guard-forced. */
  | 'max-turns'
  /** Same fully-errored tool batch re-emitted N× (e.g. denied-approval loop). Guard-forced. */
  | 'wedged-loop'
  /** User Ctrl+C / Esc. User action. */
  | 'user-interrupt'
  /** Provider/stream error. Fault. */
  | 'stream-error'
  /** C3 自治档检查点 — turn budget within a run reached, paused for user confirmation. */
  | 'checkpoint'

export interface StopReason {
  source: StopReasonSource
  /** 0-based turn index the loop was on when it ended. */
  turn: number
  /** True = the model chose to stop; false = a guard/limit/fault forced it. */
  voluntary: boolean
  /** Convergence composite score (convergence/no-tool sources). */
  score?: number
  /** Convergence escalation level 0-3 (convergence/no-tool sources). */
  level?: number
  /** Consecutive no-tool turns at abort time (no-tool source). */
  noToolTurnCount?: number
  /**
   * Whether recent output was still fresh/diverging reasoning when the guard
   * fired. When true, a guard-forced stop is a likely FALSE circuit-break — the
   * model was reasoning, not stuck. Surfaced so such events are diagnosable.
   */
  reasoningActive?: boolean
  /** Free-form extra context for the debug line. */
  detail?: string
}

/** Human-readable Chinese one-liner distinguishing voluntary finish from熔断. */
export function describeStopReason(r: StopReason): string {
  switch (r.source) {
    case 'natural-finish':
      return '✓ 任务完成（模型主动收尾）'
    case 'end-turn':
      return '✓ 回合结束（工具请求交回控制权）'
    case 'convergence-abort':
      return `⏹ 被收敛检测中断（score=${fmtScore(r.score)} L${r.level ?? '?'}${reasoningTag(r)}）`
    case 'no-tool-abort':
      return `⏹ 被"连续无工具"守护中断（noTool=${r.noToolTurnCount ?? '?'}${reasoningTag(r)}）`
    case 'watchdog-stall':
      return '⏹ 被停滞看门狗中断（回合边界疑似卡死）'
    case 'max-turns':
      return `⏹ 达到最大轮次上限（turn=${r.turn}）— 任务可能未完成`
    case 'wedged-loop':
      return `⏹ 检测到工具死循环（同一失败调用重复${r.detail ? `：${r.detail}` : ''}）— 已终止以防上下文膨胀`
    case 'user-interrupt':
      return '⏹ 用户中断'
    case 'stream-error':
      return '⏹ 流式错误中断'
    case 'checkpoint':
      return `⏸ 自治检查点（已连续执行 ${r.turn} 轮）— 等待确认后继续`
  }
}

/** Structured single-line log for debug/telemetry. */
export function formatStopReasonLog(r: StopReason): string {
  const parts = [
    `source=${r.source}`,
    `turn=${r.turn}`,
    `voluntary=${r.voluntary}`,
  ]
  if (r.score !== undefined) parts.push(`score=${fmtScore(r.score)}`)
  if (r.level !== undefined) parts.push(`level=${r.level}`)
  if (r.noToolTurnCount !== undefined) parts.push(`noTool=${r.noToolTurnCount}`)
  if (r.reasoningActive !== undefined) parts.push(`reasoningActive=${r.reasoningActive}`)
  if (r.detail) parts.push(`detail=${r.detail}`)
  return `[stop-reason] ${parts.join(' ')}`
}

/**
 * Map a guard-forced StopReason to the `onAbort(reason)` tag string.
 *
 * The tag must NOT collide with the existing watchdog tags ('watchdog' /
 * 'watchdog:goal') the TUI uses to drive auto-recovery. A convergence/no-tool
 * abort is deliberately NOT auto-continued (the model may be reasoning; nudging
 * it would disrupt), so it gets its own 'convergence' family the TUI renders as
 * a labeled stop rather than a bare "⏹ Interrupted".
 *
 * Returns undefined for voluntary/user/stream sources (they don't flow through
 * onAbort as a guard tag).
 */
export function stopReasonAbortTag(r: StopReason): string | undefined {
  switch (r.source) {
    case 'convergence-abort':
      return 'convergence'
    case 'no-tool-abort':
      return 'convergence:no-tool'
    default:
      return undefined
  }
}

/**
 * Sink for emitting a StopReason through whatever channels a call site has on
 * hand. All fields optional so loop.ts (debug + phase + record) and the
 * orchestrator (debug + telemetry + phase + record) can share one emit path.
 */
export interface StopReasonSink {
  onPhaseChange?: (phase: string, detail?: { reason?: string; voluntary?: boolean; source?: StopReasonSource }) => void
  debug?: (msg: string) => void
  telemetry?: (rec: { kind: string } & Record<string, unknown>) => void
  record?: (r: StopReason) => void
}

/** Fan a StopReason out to the provided channels (all no-ops if absent). */
export function emitStopReason(r: StopReason, sink: StopReasonSink): void {
  sink.record?.(r)
  sink.debug?.(formatStopReasonLog(r))
  sink.telemetry?.({ kind: 'stop-reason', ...r })
  // voluntary/source ride along so UIs can filter: only guard-forced stops need
  // a visible system line (voluntary finishes already render a completion badge).
  sink.onPhaseChange?.('stop-reason', { reason: describeStopReason(r), voluntary: r.voluntary, source: r.source })
}

function fmtScore(score: number | undefined): string {
  return score === undefined ? '?' : score.toFixed(2)
}

function reasoningTag(r: StopReason): string {
  if (r.reasoningActive === undefined) return ''
  return r.reasoningActive ? ' reasoning=fresh⚠' : ' reasoning=stale'
}

import type { AgentLoop } from './loop.js'
import { runThetaCheck, type ThetaCheckResult, type ThetaOutcome } from './theta-check.js'

export const THETA_MAX_SESSION = 40;
export const THETA_MAX_PER_TURN = 2;
/** Theta 内层预算（ms）——meta 摘要与退避语义都锚定这个值。 */
export const THETA_BUDGET_MS = 15_000;

/** controller 可见的 Theta 状态形状（AgentLoop.thetaTelemetry 的结构化镜像）。 */
export interface ThetaTelemetryState {
  lastReason: string | null
  lastDurationMs: number | null
  lastErrorCount: number
  lastTimedOut: boolean
  requestedCount: number
  /** Number of consecutive theta checks that timed out. Reset to 0 on success. */
  consecutiveTimeouts: number
  /** Turn number at which backoff expires. 0 = no backoff active. */
  cooldownUntilTurn: number
  /** busy/backoff 抑制次数——与真实超时分开记账，不推进退避。 */
  suppressedCount: number
  /** 各 outcome 累计（每次真实尝试记一次；含 busy/backoff）。 */
  outcomes: Record<ThetaOutcome, number>
}

/** controller 的最小 host 接口——测试注入 mock host，生产传 AgentLoop。 */
export interface ThetaControllerHost {
  cwd: string
  thetaCheckInFlight: boolean
  thetaRequestsThisTurn: number
  thetaTelemetry: ThetaTelemetryState
  session: { getTurnCount(): number }
  repairHintTracker: { recordFailure(file: string, kind: string): void }
  /** 一次一结果回调——AgentLoop 借此落 meta 摘要（attempts/outcomes/耗时/预算）。 */
  onThetaResult?: (result: ThetaCheckResult, budgetMs: number) => void
}

export type ThetaRunner = (cwd: string, timeoutMs?: number) => Promise<ThetaCheckResult>

/**
 * Theta 检查控制器（主控可靠性闭环 Wave 1）——gating + backoff + outcome 累计。
 *
 * 诚实语义：
 * - 只有 outcome === 'timeout'（真实超时）推进连续超时退避；
 *   busy/backoff 只记 suppressedCount；spawn_error 进 outcomes 但不推进退避。
 * - 每次真实尝试（通过所有 gate）记一次 requestedCount，结果经 onThetaResult
 *   回调一次一结果地落 meta 摘要。
 */
export function createThetaController(
  host: ThetaControllerHost,
  runner: ThetaRunner = runThetaCheck,
): (reason: string) => void {
  return (reason: string): void => {
    if (host.thetaCheckInFlight) return

    // Gate 1: session-level cap
    if (host.thetaTelemetry.requestedCount >= THETA_MAX_SESSION) return

    // Gate 2: per-turn cap
    if (host.thetaRequestsThisTurn >= THETA_MAX_PER_TURN) return

    // Gate 3: consecutive-timeout backoff
    if (host.thetaTelemetry.consecutiveTimeouts > 0) {
      const currentTurn = host.session.getTurnCount()
      if (currentTurn < host.thetaTelemetry.cooldownUntilTurn) return
    }

    host.thetaCheckInFlight = true
    host.thetaRequestsThisTurn++
    host.thetaTelemetry = {
      ...host.thetaTelemetry,
      lastReason: reason,
      requestedCount: host.thetaTelemetry.requestedCount + 1,
    }

    runner(host.cwd, THETA_BUDGET_MS).then(result => {
      for (const errFile of result.errors) {
        host.repairHintTracker.recordFailure(errFile, 'type_error')
      }
      const timedOut = result.outcome === 'timeout'
      // 退避语义：timeout 推进；ok/type_errors 清零（tsc 真实跑完有了答案）；
      // 其余保留原值——抑制或环境失败不推进也不清零，免得「假成功」洗掉真实
      // 超时的记忆。no-fresh-verdict（2026-09-22 新增）属于「没有结论」，不是
      // 「失败」：theta 现在是闸门结论的只读消费者，本工作树没进过验证期就没有
      // 结论可回放，这不该被记成一次失败。
      const consecutiveTimeouts = result.outcome === 'timeout'
        ? host.thetaTelemetry.consecutiveTimeouts + 1
        : (result.outcome === 'ok' || result.outcome === 'type_errors')
          ? 0
          : host.thetaTelemetry.consecutiveTimeouts
      const cooldownTurns = consecutiveTimeouts === 0 ? 0
        : Math.min(4, consecutiveTimeouts)
      const outcomes = { ...host.thetaTelemetry.outcomes }
      outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1
      const suppressed = result.outcome === 'busy'
        || result.outcome === 'backoff'
        || result.outcome === 'no-fresh-verdict'
      host.thetaTelemetry = {
        ...host.thetaTelemetry,
        lastDurationMs: result.durationMs,
        lastErrorCount: result.errors.length,
        lastTimedOut: timedOut,
        consecutiveTimeouts,
        cooldownUntilTurn: cooldownTurns > 0
          ? host.session.getTurnCount() + cooldownTurns
          : 0,
        suppressedCount: host.thetaTelemetry.suppressedCount + (suppressed ? 1 : 0),
        outcomes,
      }
      host.onThetaResult?.(result, THETA_BUDGET_MS)
    }).catch(() => {
      // runner 自身抛错（理论上不该发生——runThetaCheck 全路径 resolve）
      host.thetaTelemetry = {
        ...host.thetaTelemetry,
        lastDurationMs: null,
        lastErrorCount: 0,
        lastTimedOut: false,
        consecutiveTimeouts: 0,
        cooldownUntilTurn: 0,
      }
    }).finally(() => {
      host.thetaCheckInFlight = false
    })
  }
}

/** 兼容包装——loop.ts 沿用 `requestThetaCheck(this, reason)` 签名。 */
export function requestThetaCheck(
  self: AgentLoop,
  reason: string,
): void {
  createThetaController(self)(reason)
}

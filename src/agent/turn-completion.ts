import type { Usage } from '../api/types.js'
import type { AgentConfig } from './loop-types.js'
import type { SessionContext } from './context.js'
import type { TrajectoryRecorder } from './trajectory.js'
import type { RoutingMetricsCollector } from '../model/routing-metrics.js'
import type { EvidenceTracker, EvidenceSummary } from './evidence.js'
import type { RewardInput, EffortShadowRecord } from './p3-integration.js'
import { processTurnEnd } from './turn-end.js'

export interface TurnCompletionCallbacks {
  onTextDelta: (text: string) => void
  onTurnComplete: (usage: Partial<Usage>, turnNumber: number, isFinal?: boolean, evidenceSummary?: EvidenceSummary, continuationReason?: string) => void
}

export interface TurnCompletionDeps {
  config: AgentConfig
  session: SessionContext
  trajectory: TrajectoryRecorder
  routingMetrics: RoutingMetricsCollector
  evidence: EvidenceTracker
  getStreamedText: () => string
  getDecisions: () => string[]
  setDecisions: (decisions: string[]) => void
  refreshLedger: () => void
  refreshCacheDiagnostic: (turn: number) => void
  runPostTurn: () => Promise<void>
  runBeforeComplete?: () => Promise<void>
  getEffortShadow?: () => EffortShadowRecord | null
  clearEffortShadow?: () => void
  completeEffortShadow?: (
    pendingRewardId: string,
    input: RewardInput,
  ) => { reward: number; recommendedArm: string; ruleBaseline: string } | null | void
  getDoomLoopLevel?: () => 'none' | 'warn' | 'blocked'
  /**
   * effort_bandit 晋升链的样本证据落盘（`effort_shadow:*` 行）。
   * evaluateGatedInfluenceHistory 用它统计 totalShadowSamples——不落盘则
   * auto 晋升永远停在 samples 0/30。Append-only，失败静默。
   */
  saveEffortShadowRow?: (kind: string, json: string) => void
}

export interface CompleteTurnInput {
  turn: number
  isFinal: boolean
  callbacks: TurnCompletionCallbacks
  /** 自动续轮原因，透传给 onTurnComplete（wire 事件上的可选字段）。 */
  continuationReason?: string
}

export class TurnCompletionController {
  constructor(private deps: TurnCompletionDeps) {}

  async complete(input: CompleteTurnInput): Promise<void> {
    const result = processTurnEnd({
      config: this.deps.config,
      session: this.deps.session,
      trajectory: this.deps.trajectory,
      streamedText: this.deps.getStreamedText(),
      routingMetrics: this.deps.routingMetrics,
      decisions: this.deps.getDecisions(),
      evidence: this.deps.evidence,
   })
    this.deps.setDecisions(result.decisions)
    // The evidence badge (任务完成总结) is intentionally NOT emitted into the
    // transcript: every no-tool final turn (including a mid-task stall like
    // "跑 typecheck + 测试。" with no tool call) rendered a delivery ceremony
    // with a GREEN gate, reading as a fake completion (session 4df36bcd).
    // Gate data still reaches the UI via evidenceSummary below.
    this.deps.refreshLedger()
    this.deps.refreshCacheDiagnostic(input.turn)
    this.completeEffortReward()
    await this.deps.runPostTurn()
    if (input.isFinal) await this.deps.runBeforeComplete?.()
    const evidenceSummary = input.isFinal ? this.deps.evidence.buildSummary(result.gateV2) : undefined
    input.callbacks.onTurnComplete(
      this.deps.session.getTotalUsage(),
      this.deps.session.getTurnCount(),
      input.isFinal,
      evidenceSummary,
      input.continuationReason,
    )
  }

  private completeEffortReward(): void {
    try {
      const shadow = this.deps.getEffortShadow?.()
      if (!shadow) return

      const summary = this.deps.trajectory.summarize()
      const total = Math.max(summary.totalTools, 1)
      const toolSuccessRate = (total - summary.failures) / total
      const repairRate = summary.retries / total
      const doomDetected = this.deps.getDoomLoopLevel?.() === 'blocked'

      const usage = this.deps.session.getTotalUsage()
      const outputTokens = usage.output_tokens ?? 0
      const PER_TURN_BUDGET = 8192
      const expectedTokens = PER_TURN_BUDGET * this.deps.session.getTurnCount()
      const tokenEfficiency = expectedTokens > 0
        ? 1 - Math.min(outputTokens / expectedTokens, 2)
        : 0

      const outcome = this.deps.completeEffortShadow?.(shadow.pendingRewardId, {
        toolSuccessRate,
        repairRate,
        doomDetected: doomDetected ?? false,
        tokenEfficiency,
        userCorrected: false,
      })
      if (outcome && this.deps.saveEffortShadowRow) {
        this.deps.saveEffortShadowRow(
          `effort_shadow:${shadow.pendingRewardId}`,
          JSON.stringify({
            schemaVersion: 1,
            recommendedArm: outcome.recommendedArm,
            ruleBaseline: outcome.ruleBaseline,
            reward: outcome.reward,
            timestamp: Date.now(),
          }),
        )
      }
      this.deps.clearEffortShadow?.()
    } catch {
      // Effort reward must never disrupt turn completion
    }
  }
}

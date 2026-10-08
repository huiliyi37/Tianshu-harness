import { type ReasoningEffort } from './auto-reasoning.js'
import { type PredictionAccumulator, getErrorRate } from './prediction-error.js'
import { buildEffortContext, computeTurnDepth, type EffortShadowRecord } from './p3-reward.js'
import { resolveEffortDelta } from './effort-delta.js'
import { type P3Integration } from './p3-integration.js'

/**
 * Dependencies for {@link ReasoningEffortController}. All access to AgentLoop
 * state goes through getter/setter closures so the controller never imports
 * AgentLoop (avoids a circular dependency). Wired in loop-factory.ts.
 */
export interface ReasoningEffortDeps {
  getReasoningFloor: () => string | undefined
  getConfigReasoningEffort: () => ReasoningEffort | undefined
  setConfigReasoningEffort: (effort: ReasoningEffort) => void
  setClientReasoningEffort: (effort: ReasoningEffort) => void
  isEffortBanditEnabled: () => boolean
  p3: P3Integration
  hasTaskContract: () => boolean
  getPredictionAccumulator: () => PredictionAccumulator
  getTurnCount: () => number
  getMaxTurns: () => number | undefined
  getFilesModifiedCount: () => number
  setCurrentEffortShadow: (record: EffortShadowRecord) => void
  /**
   * Gated-influence audit sink（effort_bandit 晋升链证据）。每次 effort 决策点
   * 写一条 audit（shadow 模式也写——gateOpen/rewardMargin 证据是 auto 晋升的
   * 输入，没有它晋升闸永远打不开）。Append-only，失败静默。
   */
  persistAudit?: (input: {
    gateOpen: boolean
    applied: boolean
    reason: string
    evidenceWindow: Record<string, number | boolean | string>
  }) => void
}

/**
 * Reasoning-effort cluster extracted verbatim from AgentLoop (W-L5b): the
 * rule + reasoningFloor + bandit-delta resolution and the T2-02 shadow
 * telemetry. Pure logic with no prefix-cache coupling.
 */
export class ReasoningEffortController {
  constructor(private readonly deps: ReasoningEffortDeps) {}

  set(effort: ReasoningEffort, source: 'user' | 'programmatic' = 'programmatic'): void {
    if (source === 'user') {
      this.deps.setConfigReasoningEffort(effort)
      this.deps.setClientReasoningEffort(effort)
      this.recordAudit(effort, effort)
      return
    }
    const floor = this.deps.getReasoningFloor()
    const rank: Record<string, number> = { off: 0, low: 1, medium: 2, high: 3, max: 4 }
    const effective = (floor && (rank[effort] ?? 2) < (rank[floor] ?? 0)) ? floor as ReasoningEffort : effort
    // T2-02 Track A2: apply bandit delta (no-op when flag off or gate closed)
    const banditAdjusted = this.applyDelta(effective) as ReasoningEffort
    this.deps.setConfigReasoningEffort(banditAdjusted)
    this.deps.setClientReasoningEffort(banditAdjusted)
    this.recordAudit(effective, banditAdjusted)
  }

  /**
   * 每个 effort 决策点写一条 gated_influence_audit（shadow 模式也写）。
   * 这是 effort_bandit auto 晋升链此前缺失的一环：resolveBanditPromotion 读
   * audit 行里的 gateOpen/rewardMargin，没有写入 → auto 永不达标。
   */
  private recordAudit(baseEffort: string, finalEffort: string): void {
    if (!this.deps.persistAudit) return
    try {
      const enabled = this.deps.isEffortBanditEnabled()
      const evidence = this.deps.p3.effortGateEvidence()
      const applied = enabled && evidence.gateOpen && finalEffort !== baseEffort
      const reason = !enabled
        ? 'shadow: bandit not enabled'
        : !evidence.gateOpen
          ? 'gate closed: insufficient reward evidence'
          : applied ? 'bandit delta applied' : 'gate open but delta was no-op'
      this.deps.persistAudit({
        gateOpen: evidence.gateOpen,
        applied,
        reason,
        evidenceWindow: {
          totalPulls: evidence.totalPulls,
          ...(evidence.rewardMargin !== null ? { rewardMargin: evidence.rewardMargin } : {}),
          baseEffort,
          finalEffort,
        },
      })
    } catch {
      // Audit is append-only evidence — must never affect the effort decision.
    }
  }

  /**
   * T2-02 P0: Shadow telemetry for effort bandit.
   * Records recommendation without changing behavior.
   * Called at effort decision points (initial selection + intervention adjustments).
   *
   * @param ruleBaseline The effort the rule-based heuristic selected (e.g., 'medium')
   * @param overrides Partial context overrides from the caller
   */
  shadowTelemetry(
    ruleBaseline: string,
    overrides?: { errorRate?: number; isRepeat?: boolean },
  ): void {
    try {
      const ctx = buildEffortContext({
        taskComplexity: this.deps.hasTaskContract() ? 0.5 : 0.3,
        errorRate: overrides?.errorRate ?? getErrorRate(this.deps.getPredictionAccumulator()),
        turnDepth: computeTurnDepth(this.deps.getTurnCount(), this.deps.getMaxTurns()),
        fileCount: this.deps.getFilesModifiedCount(),
        isRepeat: overrides?.isRepeat ?? false,
        timeOfDay: new Date().getHours() / 24,
      })
      const record = this.deps.p3.shadowRecommendEffort(ctx, ruleBaseline)
      if (record) {
        this.deps.setCurrentEffortShadow(record)
      }
    } catch {
      // Shadow telemetry must never affect behavior
    }
  }

  /**
   * T2-02 P3: Get bandit-recommended effort delta.
   *
   * Returns null in three cases:
   * 1. Feature flag effortBanditEnabled is false (zero behavior change).
   * 2. Consistency gate not open (totalPulls < 30 or agreement rate < 0.8).
   * 3. Bandit itself declines the recommendation.
   *
   * Only when all three pass does the bandit get a vote.
   */
  getDelta(): number | null {
    if (!this.deps.isEffortBanditEnabled()) return null
    if (!this.deps.p3.isEffortGateOpen()) return null
    try {
      const ctx = buildEffortContext({
        taskComplexity: this.deps.hasTaskContract() ? 0.5 : 0.3,
        errorRate: getErrorRate(this.deps.getPredictionAccumulator()),
        turnDepth: computeTurnDepth(this.deps.getTurnCount(), this.deps.getMaxTurns()),
        fileCount: this.deps.getFilesModifiedCount(),
        isRepeat: false,
        timeOfDay: new Date().getHours() / 24,
      })
      const rec = this.deps.p3.recommendEffortDelta(ctx)
      return rec?.delta ?? null
    } catch {
      return null
    }
  }

  get(): ReasoningEffort | undefined {
    return this.deps.getConfigReasoningEffort()
  }

  applyDelta(baseEffort: string): string {
    try {
      const delta = this.getDelta()
      return resolveEffortDelta(baseEffort, delta, this.deps.getReasoningFloor())
    } catch {
      return baseEffort
    }
  }
}

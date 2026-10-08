import { estimateOaiTokens } from '../compact/micro.js'
import { compactStaleRoundsOai } from '../compact/stale-round.js'
import { microCompactOai } from '../compact/micro.js'
import { staleRoundThresholds } from '../compact/constants.js'
import {
  collectStaleArchiveCandidates,
  collectMicroArchiveCandidates,
  type ArchiveForRecovery,
} from '../compact/boundary-archive.js'
import type { CompactCircuitBreakerState } from '../context/types.js'
import type { DangerSignal } from './immune-types.js'
import { debugLog } from '../utils/debug.js'
import { deriveCompactionProfile, type CompactionProfile } from '../compact/compaction-profile.js'
import { estimateReclaim, buildReclaimDecision, type ReclaimDecisionRecord } from '../compact/reclaim-estimate.js'

/** T9 quality-compaction trigger ratios. Mirrors compactSchema.qualityCompact
 *  defaults — used when config does not supply overrides. */
export interface QualityCompactThresholds {
  perTokenThreshold: number
  subscriptionThreshold: number
  subscriptionCeiling: number
}

export const DEFAULT_QUALITY_COMPACT_THRESHOLDS: QualityCompactThresholds = {
  perTokenThreshold: 0.55,
  subscriptionThreshold: 0.45,
  subscriptionCeiling: 0.6,
}

/** Heap-usage ratio (heapUsed / real V8 limit) above which an in-turn micro-compact
 *  is forced regardless of the 1M-window turn-0 deferral. Below this, heap pressure
 *  on a 1M window is deferred to the next user boundary (turn 0) to protect the
 *  prefix cache; at/above it, deferring risks OOMing the whole process before the
 *  next turn 0 ever arrives (a long/wedged run never returns to turn 0), so we
 *  accept the cache reprefill as the far lesser evil. */
export const HEAP_EMERGENCY_RATIO = 0.85

/** Token-ratio floor for opportunistic (cold-cache) stale-round compaction.
 *  Below this there is too little stale history for the rewrite to pay off
 *  even when the prefix cache is already expired. */
export const OPPORTUNISTIC_COMPACT_RATIO = 0.3

export interface CompactBoundaryDeps {
  // Field accessors
  getCompactFailures: () => CompactCircuitBreakerState
  setCompactFailures: (f: CompactCircuitBreakerState) => void
  getLastCompactTurn: () => number | null
  setLastCompactTurn: (t: number | null) => void
  getPendingStaleCompact: () => boolean
  setPendingStaleCompact: (v: boolean) => void
  getPendingHeapCompact: () => boolean
  setPendingHeapCompact: (v: boolean) => void
  getPrevPhaseHint: () => string | undefined
  setPrevPhaseHint: (h: string | undefined) => void

  // External deps
  getAbortSignal: () => AbortSignal | undefined
  getContextWindow: () => number
  getPhaseHint: () => string | undefined
  getEstimatedTokens: () => number
  getMessages: () => import('../api/oai-types.js').OaiMessage[]
  replaceMessages: (msgs: import('../api/oai-types.js').OaiMessage[]) => void
  dietMessages: (msgs: import('../api/oai-types.js').OaiMessage[]) => { removedCount: number; messages: import('../api/oai-types.js').OaiMessage[] }
  trySessionSplit: () => Promise<boolean>
  maybeCompact: (opts: { loopTurn: number; failures: CompactCircuitBreakerState }) => Promise<{ compacted: boolean; failures: CompactCircuitBreakerState }>
  tryPartialCompact: (targetTurnAge: number) => Promise<boolean>
  shouldDelayCompact: (turnThreshold: number, ctx?: { estimatedTokens?: number; contextWindow?: number }) => boolean
  /**
   * CacheAdvisor 机会压缩判断：缓存已冷（上次 API 调用超过 provider TTL）时为 true。
   * 冷缓存下「延迟压缩保前缀」失去意义（服务端缓存已过期，重建成本反正要付），
   * 顺势在 turn 0 用更低的 ratio 门槛压缩陈旧轮。缓存热/温时此路径不参与，
   * 现有 shouldDelayCompact 纪律原样保留。
   */
  shouldOpportunisticCompact?: () => boolean
  getStalePreviewChars: () => number
  isCachePreservingProvider: () => boolean
  /** True when the provider is NOT billed per token (flat subscription / coding-plan).
   *  Such providers may compact more eagerly at turn-0 for a leaner context, since
   *  shrinking the prefix cache costs latency but no money. */
  isCostInsensitiveProvider?: () => boolean
  getProviderName?: () => string | undefined
  /** T9 trigger ratios from config; falls back to DEFAULT_QUALITY_COMPACT_THRESHOLDS. */
  getQualityThresholds?: () => QualityCompactThresholds
  injectImmuneSignal: (signal: DangerSignal) => void
  /**
   * W1-A3: archive originals of marker-less tool messages before a lossy
   * rewrite. Returns `message index → artifactId`; failed saves are simply
   * absent and the transforms keep those originals (fail-open). Optional —
   * when absent, transforms behave exactly as before.
   */
  archiveForRecovery?: ArchiveForRecovery
  /**
   * Cost-aware reclaim profile (2026-07-16 plan task 3). Deterministic stale /
   * micro candidates must clear its floors before replacing history; absent,
   * a conservative per-token profile is derived from the cache classification.
   */
  getCompactionProfile?: () => CompactionProfile | undefined
  /** Structured sink for reclaim-gate decisions (committed AND rejected). */
  onReclaimDecision?: (record: ReclaimDecisionRecord) => void
}

export interface RunCompactionResult {
  compacted: boolean
  shouldAbort: boolean
  userMessageConsumed: boolean
}

export class CompactBoundaryCoordinator {
  constructor(private deps: CompactBoundaryDeps) {}

  private reclaimProfile(): CompactionProfile {
    return this.deps.getCompactionProfile?.() ?? deriveCompactionProfile({
      contextWindow: this.deps.getContextWindow(),
      billing: this.deps.isCostInsensitiveProvider?.() ? 'subscription' : 'per-token',
      cache: this.deps.isCachePreservingProvider() ? 'exact-prefix' : 'none',
    })
  }

  /** Phase 2.3: Proactive session split at 86% context — MUST run BEFORE addUserMessage. */
  async preUserMessageSplit(): Promise<void> {
    await this.deps.trySessionSplit()
  }

  async runCompaction(turn: number, snap: { memory: { heapUsedBytes: number; memoryLimitBytes: number } } | null): Promise<RunCompactionResult> {
    let userMessageConsumed = false

    // Phase 2.3: Proactive session split at 86% context.
    if (await this.deps.trySessionSplit()) {
      userMessageConsumed = true
    }
    if (this.deps.getAbortSignal()?.aborted) {
      return { compacted: false, shouldAbort: true, userMessageConsumed }
    }

    const compactResult = await this.deps.maybeCompact({
      loopTurn: turn,
      failures: this.deps.getCompactFailures(),
    })
    if (compactResult.compacted) userMessageConsumed = true
    if (this.deps.getAbortSignal()?.aborted) {
      return { compacted: false, shouldAbort: true, userMessageConsumed }
    }
    this.deps.setCompactFailures(compactResult.failures)

    // Immune signal: surface compaction failures
    if (compactResult.failures.consecutiveFailures > 0) {
      try {
        this.deps.injectImmuneSignal({
          kind: 'compaction_fail',
          severity: Math.min(1.0, compactResult.failures.consecutiveFailures * 0.3),
          turn,
          source: 'compaction-controller',
        })
      } catch { /* non-critical */ }
    }
    if (compactResult.compacted) {
      this.deps.setLastCompactTurn(turn)
      if (typeof globalThis.gc === 'function') globalThis.gc()
    }

    // T9: Proactive Quality Compact — phase transition partial compact.
    // P2-5: only at user boundaries (turn 0) — never mid-turn (timeout guard:
    // a mid-turn rewrite breaks the GLM/MiMo exact-prefix cache and forces a
    // giant re-prefill, the ac191c61 timeout storm).
    //
    // Provider cost asymmetry decides whether to defer at turn-0:
    //   - per-token + cache-preserving (DeepSeek): SKIP — any reshape invalidates
    //     the paid prefix cache; on a 1M window the old 0.3 gate fired at ~300K,
    //     far too aggressive.
    //   - subscription + cache-preserving (GLM/MiMo): RUN — tokens are flat, and
    //     compacting *early* at turn-0 keeps surviving context small, so the
    //     subsequent re-prefill is smaller than deferring until ~600K.
    //   - no cache (Codex/Claude OAuth): RUN — nothing to protect.
    if (!compactResult.compacted && this.deps.getContextWindow() >= 500_000 && turn === 0) {
      const cachePreserving = this.deps.isCachePreservingProvider?.() ?? false
      const costInsensitive = this.deps.isCostInsensitiveProvider?.() ?? false
      // Only per-token cache-preserving providers (DeepSeek) skip to protect paid cache.
      const skip = cachePreserving && !costInsensitive

      const qTokens = this.deps.getEstimatedTokens()
      const qRatio = qTokens / this.deps.getContextWindow()
      const phaseHint = this.deps.getPhaseHint()
      const prevPhaseHint = this.deps.getPrevPhaseHint()
      this.deps.setPrevPhaseHint(phaseHint)
      const phaseTransition = prevPhaseHint !== undefined && phaseHint !== prevPhaseHint
      // Subscription providers compact leaner and get a ceiling fallback so
      // context can't creep up without a phase change. Thresholds are config-tunable.
      const thresholds = this.deps.getQualityThresholds?.() ?? DEFAULT_QUALITY_COMPACT_THRESHOLDS
      const qThreshold = costInsensitive ? thresholds.subscriptionThreshold : thresholds.perTokenThreshold
      const shouldTrigger = !skip && ((qRatio > qThreshold && phaseTransition) || (costInsensitive && qRatio > thresholds.subscriptionCeiling))

      let decision: 'skip-paid-cache' | 'no-trigger' | 'compacted' | 'compact-failed' = skip ? 'skip-paid-cache' : 'no-trigger'
      if (shouldTrigger) {
        const partialOk = await this.deps.tryPartialCompact(30)
        if (partialOk) {
          userMessageConsumed = true
          this.deps.setLastCompactTurn(turn)
          decision = 'compacted'
        } else {
          decision = 'compact-failed'
        }
      }
      debugLog('[T9-quality-compact]', {
        provider: this.deps.getProviderName?.() ?? 'unknown',
        costModel: costInsensitive ? 'subscription' : 'per-token',
        cachePreserving,
        qRatio: Number(qRatio.toFixed(3)),
        threshold: qThreshold,
        phaseTransition,
        decision,
      })
    }

    // Stale round compaction: proactively shrink N-2+ tool_results
    if (!compactResult.compacted) {
      const contextWindow = this.deps.getContextWindow()
      const msgs = this.deps.getMessages()
      const tokenBudget = estimateOaiTokens(msgs)
      const tokenRatio = tokenBudget / contextWindow

      // Opportunistic compact: cold cache lowers the trigger floor (0.5 → 0.3)
      // and bypasses the delay heuristic — its hit-rate memory predates the
      // idle gap, so "cache healthy, delay" would be reasoning from expired state.
      const opportunistic = (this.deps.shouldOpportunisticCompact?.() ?? false) && tokenRatio >= OPPORTUNISTIC_COMPACT_RATIO
      if ((tokenRatio >= 0.5 || this.deps.getPendingStaleCompact() || opportunistic) && contextWindow < 1_000_000) {
        // P2-5: history rewrites only at user boundaries (turn 0).
        if (turn !== 0) {
          if (tokenRatio >= 0.5) this.deps.setPendingStaleCompact(true)
        } else if (!opportunistic && this.deps.shouldDelayCompact(tokenRatio >= 0.7 ? 3 : 2, { estimatedTokens: tokenBudget, contextWindow })) {
          // cache healthy — delay
        } else {
          // Candidate pipeline (2026-07-16 reclaim gate): diet → stale run on a
          // CANDIDATE list; history is only replaced when the combined reclaim
          // clears the profile floors. Session 2c1186f5 showed sub-2k-token
          // stale rewrites shattering a 200k-token hot prefix each boundary.
          // P3-B AgentDiet: remove redundant trajectory segments first.
          const dietResult = this.deps.dietMessages(msgs)
          const dietCandidate = dietResult.removedCount > 0 ? dietResult.messages : msgs

          const advisorPreview = this.deps.getStalePreviewChars()
          const previewChars = Math.max(advisorPreview, staleRoundThresholds(contextWindow).previewChars)
          // W1-A3: archive marker-less originals BEFORE the lossy rewrite so the
          // transform can attach recovery refs; failed saves stay intact. An
          // archive for a candidate the gate later rejects is disk-only and
          // harmless — never bound to any surviving message.
          let staleRefs: ReadonlyMap<number, string> | undefined
          if (this.deps.archiveForRecovery) {
            const candidates = collectStaleArchiveCandidates(dietCandidate, contextWindow, previewChars)
            staleRefs = candidates.length > 0
              ? await this.deps.archiveForRecovery(candidates)
              : new Map()
          }
          const after = compactStaleRoundsOai(dietCandidate, contextWindow, previewChars, staleRefs)
          const decision = buildReclaimDecision('stale-round', estimateReclaim(msgs, after), this.reclaimProfile(), false)
          this.deps.onReclaimDecision?.(decision)
          if (decision.commit) {
            this.deps.setPendingStaleCompact(false)
            this.deps.replaceMessages(after)
            if (typeof globalThis.gc === 'function') globalThis.gc()
          } else if (!decision.changed) {
            // No-op candidate: the debt is unsatisfiable until content changes —
            // clear it instead of retrying the same rewrite every boundary.
            this.deps.setPendingStaleCompact(false)
          } else if (tokenRatio >= 0.5) {
            // Rejected but real pressure remains: keep the debt so the next
            // boundary re-evaluates with fresh content.
            this.deps.setPendingStaleCompact(true)
            debugLog(`[compaction-gate] stale-round candidate rejected (${decision.reason}): reclaimed=${decision.reclaimedTokens}`)
          }
        }
      }
    }

    // Heap-driven forced compaction
    const heapRatio = snap
      ? snap.memory.heapUsedBytes / snap.memory.memoryLimitBytes
      : 0
    const is1M = this.deps.getContextWindow() >= 1_000_000
    const heapCompactThreshold = is1M ? 0.75 : 0.6
    const heapPressure = heapRatio >= heapCompactThreshold
    // Emergency valve: at severe heap pressure the deferral-to-turn-0 rule below
    // becomes a death trap — a long/wedged run (up to DEFAULT_MAX_TURNS=50) never
    // returns to turn 0, so the pending flag is set but the compaction never fires
    // and the process OOMs. Force an in-turn micro-compact regardless of window/turn.
    const heapEmergency = heapRatio >= HEAP_EMERGENCY_RATIO
    const msgCount = this.deps.getMessages().length
    if (!compactResult.compacted && (heapPressure || this.deps.getPendingHeapCompact()) && msgCount >= 10) {
      // P2-5: on 1M windows, heap micro-compact deferred to turn 0 — UNLESS heap is
      // in the emergency band, where deferring risks OOM before the next turn 0.
      if (is1M && turn !== 0 && !heapEmergency) {
        if (heapPressure) this.deps.setPendingHeapCompact(true)
      } else if (is1M && !heapPressure && this.deps.shouldDelayCompact(2)) {
        this.deps.setPendingHeapCompact(false)
      } else {
        const before = this.deps.getMessages()
        const contextWindow = this.deps.getContextWindow()
        // W1-A3: same archive-before-rewrite discipline for the heap micro-compact.
        let microRefs: ReadonlyMap<number, string> = new Map()
        if (this.deps.archiveForRecovery) {
          const candidates = collectMicroArchiveCandidates(before, contextWindow)
          microRefs = candidates.length > 0
            ? await this.deps.archiveForRecovery(candidates)
            : new Map()
        }
        const { messages: trimmed } = microCompactOai(before, contextWindow, this.deps.getEstimatedTokens(), microRefs)
        // Reclaim gate: heap emergency is a force action (the alternative is
        // OOM), everything else must clear the profile floors. The old
        // `trimmed !== before` check committed byte-identical rewrites —
        // microCompactOai always returns a fresh array — churning the appendix
        // baseline for zero reclaim.
        const decision = buildReclaimDecision('micro', estimateReclaim(before, trimmed), this.reclaimProfile(), heapEmergency)
        this.deps.onReclaimDecision?.(decision)
        if (decision.commit) {
          this.deps.setPendingHeapCompact(false)
          this.deps.replaceMessages(trimmed)
          if (typeof globalThis.gc === 'function') globalThis.gc()
          userMessageConsumed = true
        } else if (!decision.changed) {
          // Nothing compactable — drain the debt rather than spin on it.
          this.deps.setPendingHeapCompact(false)
        } else if (heapPressure) {
          this.deps.setPendingHeapCompact(true)
          debugLog(`[compaction-gate] heap micro candidate rejected (${decision.reason}): reclaimed=${decision.reclaimedTokens}`)
        } else {
          this.deps.setPendingHeapCompact(false)
        }
      }
    }

    return { compacted: compactResult.compacted, shouldAbort: false, userMessageConsumed }
  }
}

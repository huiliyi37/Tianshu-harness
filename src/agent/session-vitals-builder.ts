import type { AgentLoop } from './loop.js'
import { buildRuntimeSelfModel } from './runtime-self-model.js'

export function buildSessionVitals(self: AgentLoop): import('../tools/session-vitals.js').SessionVitalsData {
    const estimatedTokens = self.session.getEstimatedTokens()
    const contextWindow = self.config.contextWindow
    const statsMap = self.advisoryReadback.getStats()
    const top = [...statsMap.entries()]
      .map(([key, s]) => ({
        key,
        delivered: s.delivered,
        adopted: s.adopted,
        ignored: s.ignored,
        silenced: self.advisoryBus.isKeySilenced(key),
      }))
      .sort((a, b) => b.delivered - a.delivered)
      .slice(0, 5)
    const s = self.sensorium
    let runtime: import('./runtime-self-model.js').RuntimeSelfModel | null = null
    try {
      const coordinator = self.config.coordinatorRef?.()
      if (coordinator) {
        const verification = self.evidence.getVerificationSummary()
        runtime = buildRuntimeSelfModel({
          phase: self.planModeState,
          turn: self.session.getTurnCount(),
          contextRatio: contextWindow > 0 ? estimatedTokens / contextWindow : 1,
          sensorium: s ? {
            pressure: s.pressure,
            confidence: s.confidence,
            stability: s.stability,
          } : null,
          verificationDebt: verification.total > 0
            ? verification.pending / verification.total
            : (self.evidence.hasVerificationDebt() ? 1 : 0),
          coordinator: coordinator.getRuntimeSnapshot(),
        })
      }
    } catch {
      // session_vitals is diagnostic; a missing coordinator must never break it.
      runtime = null
    }
    return {
      ctx: {
        estimatedTokens,
        contextWindow,
        wire: self.requestContext.snapshot,
        ratio: contextWindow > 0 ? estimatedTokens / contextWindow : 1,
      },
      cache: self.session.getCacheHistory().slice(-5),
      diagnostics: {
        compact: self.session.getCompactEvents().slice(-3),
        mainUsageCoverage: self.session.getTotalUsage().cacheCoverage,
        mainPrefixBaseline: self.config.client.getMainPrefixProof?.() ? 'present' : 'baseline_missing',
      },
      sensorium: s ? {
        momentum: s.momentum, pressure: s.pressure, confidence: s.confidence,
        complexity: s.complexity, freshness: s.freshness, stability: s.stability,
      } : null,
      cvm: {
        overheadRatio: self.pressureMonitor.getCvmOverheadRatio(),
        throttled: self.pressureMonitor.isCvmThrottling(),
        ceiling: self.pressureMonitor.isCvmThrottlingCeiling(),
      },
      advisories: {
        rendered: self.guardianActivity.advisoriesRendered,
        dropped: self.guardianActivity.advisoriesDropped,
        adopted: self.guardianActivity.advisoriesAdopted,
        ignored: self.guardianActivity.advisoriesIgnored,
        top,
      },
      runtime,
      turn: self.session.getTurnCount(),
    }
  }

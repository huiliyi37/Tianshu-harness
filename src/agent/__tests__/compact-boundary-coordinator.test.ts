import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CompactBoundaryCoordinator, type CompactBoundaryDeps } from '../compact-boundary-coordinator.js'
import type { CompactCircuitBreakerState } from '../../context/types.js'
import type { OaiMessage } from '../../api/oai-types.js'
import { deriveCompactionProfile } from '../../compact/compaction-profile.js'
import type { ReclaimDecisionRecord } from '../../compact/reclaim-estimate.js'

/**
 * C-line: CompactBoundaryCoordinator is the extracted compaction-boundary brain
 * of the loop and shipped with no dedicated tests. The riskiest invariant it
 * guards is P2-5: history-rewriting compaction must only happen at user
 * boundaries (turn 0) — off-boundary rewrites shatter the prefix cache. These
 * tests lock that, plus abort short-circuiting and the compaction-failure
 * immune signal.
 */

interface Calls {
  maybeCompact: number
  replaceMessages: number
  immuneSignals: Array<{ kind: string; severity: number; turn: number; source: string }>
  pendingStaleCompact: boolean
  pendingHeapCompact: boolean
  lastCompactTurn: number | null
  setFailures: CompactCircuitBreakerState | null
}

function bigMsgs(n: number, charsEach = 200): OaiMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: 'x'.repeat(charsEach),
  })) as OaiMessage[]
}

function makeCoord(overrides: Partial<CompactBoundaryDeps> & {
  aborted?: boolean
  failures?: CompactCircuitBreakerState
  splitConsumes?: boolean
  compacted?: boolean
} = {}) {
  const calls: Calls = {
    maybeCompact: 0,
    replaceMessages: 0,
    immuneSignals: [],
    pendingStaleCompact: false,
    pendingHeapCompact: false,
    lastCompactTurn: null,
    setFailures: null,
  }
  const { aborted, failures: failuresOverride, splitConsumes, compacted, ...depOverrides } = overrides
  const failures = failuresOverride ?? { consecutiveFailures: 0 }
  const msgs = overrides.getMessages ? overrides.getMessages() : bigMsgs(4)

  const deps: CompactBoundaryDeps = {
    getCompactFailures: () => failures,
    setCompactFailures: (f) => { calls.setFailures = f },
    getLastCompactTurn: () => calls.lastCompactTurn,
    setLastCompactTurn: (t) => { calls.lastCompactTurn = t },
    getPendingStaleCompact: () => calls.pendingStaleCompact,
    setPendingStaleCompact: (v) => { calls.pendingStaleCompact = v },
    getPendingHeapCompact: () => calls.pendingHeapCompact,
    setPendingHeapCompact: (v) => { calls.pendingHeapCompact = v },
    getPrevPhaseHint: () => undefined,
    setPrevPhaseHint: () => {},
    getAbortSignal: () => (aborted ? ({ aborted: true } as AbortSignal) : undefined),
    getContextWindow: () => 200_000,
    getPhaseHint: () => undefined,
    getEstimatedTokens: () => 0,
    getMessages: () => msgs,
    replaceMessages: () => { calls.replaceMessages++ },
    dietMessages: (m) => ({ removedCount: 0, messages: m }),
    trySessionSplit: async () => splitConsumes ?? false,
    maybeCompact: async () => {
      calls.maybeCompact++
      return { compacted: compacted ?? false, failures }
    },
    tryPartialCompact: async () => false,
    shouldDelayCompact: () => false,
    getStalePreviewChars: () => 0,
    isCachePreservingProvider: () => false,
    injectImmuneSignal: (s) => { calls.immuneSignals.push(s) },
    ...depOverrides,
  }
  return { coord: new CompactBoundaryCoordinator(deps), calls }
}

describe('CompactBoundaryCoordinator (C-line: extracted, was untested)', () => {
  it('short-circuits with shouldAbort once the signal aborts after a session split', async () => {
    const { coord, calls } = makeCoord({ splitConsumes: true, aborted: true })
    const r = await coord.runCompaction(5, null)
    assert.deepEqual(r, { compacted: false, shouldAbort: true, userMessageConsumed: true })
    assert.equal(calls.maybeCompact, 0, 'aborts before attempting maybeCompact')
  })

  it('emits a compaction_fail immune signal when failures accumulate', async () => {
    const { coord, calls } = makeCoord({ failures: { consecutiveFailures: 2 } })
    await coord.runCompaction(3, null)
    assert.equal(calls.immuneSignals.length, 1)
    assert.equal(calls.immuneSignals[0]!.kind, 'compaction_fail')
    assert.equal(calls.immuneSignals[0]!.source, 'compaction-controller')
    assert.ok(Math.abs(calls.immuneSignals[0]!.severity - 0.6) < 1e-9, 'severity = min(1, 2*0.3)')
  })

  it('emits no immune signal when there are no failures', async () => {
    const { coord, calls } = makeCoord({ failures: { consecutiveFailures: 0 } })
    await coord.runCompaction(3, null)
    assert.equal(calls.immuneSignals.length, 0)
  })

  it('P2-5: defers stale-round compaction off-boundary (turn ≠ 0) — no history rewrite', async () => {
    // tokenRatio well above 0.5 (huge messages, small window) but turn ≠ 0.
    const { coord, calls } = makeCoord({
      getContextWindow: () => 1_000,
      getMessages: () => bigMsgs(6, 4_000),
    })
    const r = await coord.runCompaction(5, null)
    assert.equal(calls.pendingStaleCompact, true, 'stale compaction is queued, not executed')
    assert.equal(calls.replaceMessages, 0, 'NO message replacement off-boundary (cache-safe)')
    assert.equal(r.shouldAbort, false)
  })

  it('P2-5: defers heap compaction off-boundary on 1M windows — no micro-compact rewrite', async () => {
    const { coord, calls } = makeCoord({
      getContextWindow: () => 1_000_000,
      getMessages: () => bigMsgs(12),
    })
    const r = await coord.runCompaction(5, {
      memory: { heapUsedBytes: 80, memoryLimitBytes: 100 }, // ratio 0.8 ≥ 0.75 (1M threshold)
    })
    assert.equal(calls.pendingHeapCompact, true, 'heap compaction queued for the next boundary')
    assert.equal(calls.replaceMessages, 0, 'NO micro-compact rewrite off-boundary (cache-safe)')
    assert.equal(r.compacted, false)
  })

  it('emergency valve: forces in-turn heap compaction on 1M windows at ratio ≥ 0.85 (turn ≠ 0)', async () => {
    // Above the emergency band the turn-0 deferral is a death trap: a long/wedged
    // run never returns to turn 0, so deferring risks OOM. The valve must compact
    // in-turn instead of queuing — observable as setPendingHeapCompact(false), the
    // opposite of the deferral path which queues with setPendingHeapCompact(true).
    const setCalls: boolean[] = []
    const { coord } = makeCoord({
      getContextWindow: () => 1_000_000,
      getMessages: () => bigMsgs(12),
      setPendingHeapCompact: (v) => { setCalls.push(v) },
    })
    const r = await coord.runCompaction(5, {
      memory: { heapUsedBytes: 90, memoryLimitBytes: 100 }, // ratio 0.9 ≥ 0.85 emergency
    })
    assert.ok(setCalls.includes(false), 'emergency compacts in-turn (does not queue)')
    assert.ok(!setCalls.includes(true), 'emergency must NOT defer to turn 0')
    assert.equal(r.shouldAbort, false)
  })

  it('records lastCompactTurn and consumes the user message when maybeCompact compacts', async () => {
    const { coord, calls } = makeCoord({ compacted: true })
    const r = await coord.runCompaction(7, null)
    assert.equal(r.compacted, true)
    assert.equal(r.userMessageConsumed, true)
    assert.equal(calls.lastCompactTurn, 7)
  })
})

describe('CompactBoundaryCoordinator reclaim gate (2026-07-16 cost-aware reclaim plan task 3)', () => {
  // Small-window (1k) fixture so staleRoundThresholds gives preview=1200 /
  // recentToKeep=4: layout = 2 anchors + 3 stale tool messages + 4 recent.
  function staleFixture(staleToolChars: number): OaiMessage[] {
    const anchor = (role: 'user' | 'assistant'): OaiMessage => ({ role, content: 'a'.repeat(200) }) as OaiMessage
    const tool = (i: number): OaiMessage => ({ role: 'tool', tool_call_id: `read_file_${i}`, content: 't'.repeat(staleToolChars) }) as OaiMessage
    const recent = (i: number): OaiMessage => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'r'.repeat(100) }) as OaiMessage
    return [anchor('user'), anchor('assistant'), tool(0), tool(1), tool(2), recent(0), recent(1), recent(2), recent(3)]
  }

  const perTokenExactPrefix = deriveCompactionProfile({ contextWindow: 1_000, billing: 'per-token', cache: 'exact-prefix' })

  function makeGated(opts: { msgs: OaiMessage[]; pendingStale?: boolean; window?: number; archive?: boolean }) {
    const decisions: ReclaimDecisionRecord[] = []
    const harness = makeCoord({
      getContextWindow: () => opts.window ?? 1_000,
      getMessages: () => opts.msgs,
      getCompactionProfile: () => deriveCompactionProfile({
        contextWindow: opts.window ?? 1_000, billing: 'per-token', cache: 'exact-prefix',
      }),
      onReclaimDecision: d => { decisions.push(d) },
      archiveForRecovery: opts.archive ? async candidates => new Map(candidates.map(candidate => [candidate.index, `fictional_${candidate.index}`])) : undefined,
    })
    if (opts.pendingStale) harness.calls.pendingStaleCompact = true
    return { ...harness, decisions }
  }

  it('rejects a low-reclaim stale candidate at turn 0: no replace, pending debt survives', async () => {
    // Stale tool msgs barely over the 1200-char preview → tiny reclaim per msg,
    // far below the small-window per-token floor (8192 tokens).
    const t = makeGated({ msgs: staleFixture(1_300), pendingStale: true })
    await t.coord.runCompaction(0, null)
    assert.equal(t.calls.replaceMessages, 0, 'sub-floor rewrite must not commit')
    assert.equal(t.calls.pendingStaleCompact, true, 'debt is kept for the next boundary, not falsely cleared')
    const stale = t.decisions.find(d => d.action === 'stale-round')
    assert.ok(stale, 'a stale-round decision is recorded')
    assert.equal(stale!.commit, false)
    assert.equal(stale!.reason, 'below-reclaim-floor')
  })

  it('commits a high-reclaim stale candidate at turn 0 and clears the pending debt', async () => {
    // 40k-char stale tool msgs truncated to 1200 → ~9.7k tokens reclaimed each,
    // well above the 8192 floor.
    const t = makeGated({ msgs: staleFixture(40_000), pendingStale: true })
    await t.coord.runCompaction(0, null)
    assert.equal(t.calls.replaceMessages, 1, 'committed candidate replaces history exactly once')
    assert.equal(t.calls.pendingStaleCompact, false, 'debt cleared on commit')
    const stale = t.decisions.find(d => d.action === 'stale-round')
    assert.equal(stale!.commit, true)
    assert.equal(stale!.reason, 'reclaim-above-floor')
    assert.ok(stale!.reclaimedTokens > 8_192)
  })

  it('heap emergency (force) commits even a sub-floor reclaim on a 1M window', async () => {
    // One tool message just over the 1M micro preview (200k chars) → ~2.5k token
    // reclaim, far below the 50k large-window floor — but heap 0.90 is emergency.
    const msgs: OaiMessage[] = [
      { role: 'user', content: 'anchor' },
      { role: 'assistant', content: 'anchor' },
      ...Array.from({ length: 8 }, (_, i) => (
        { role: 'tool', tool_call_id: `x_${i}`, content: 'small' } as OaiMessage
      )),
      { role: 'tool', tool_call_id: 'read_file_big', content: 'b'.repeat(210_000) } as OaiMessage,
    ]
    const t = makeGated({ msgs, window: 1_000_000, archive: true })
    await t.coord.runCompaction(5, { memory: { heapUsedBytes: 90, memoryLimitBytes: 100 } })
    assert.equal(t.calls.replaceMessages, 1, 'force path is not blocked by the reclaim gate')
    const micro = t.decisions.find(d => d.action === 'micro')
    assert.equal(micro!.force, true)
    assert.equal(micro!.commit, true)
    assert.equal(micro!.reason, 'forced')
  })

  it('non-emergency heap pressure at turn 0 is gated: sub-floor candidate does not rewrite', async () => {
    const msgs: OaiMessage[] = [
      { role: 'user', content: 'anchor' },
      { role: 'assistant', content: 'anchor' },
      ...Array.from({ length: 8 }, (_, i) => (
        { role: 'tool', tool_call_id: `x_${i}`, content: 'small' } as OaiMessage
      )),
      { role: 'tool', tool_call_id: 'read_file_big', content: 'b'.repeat(210_000) } as OaiMessage,
    ]
    const t = makeGated({ msgs, window: 1_000_000, archive: true })
    // 0.80 heap: above the 0.75 1M threshold, below the 0.85 emergency band.
    await t.coord.runCompaction(0, { memory: { heapUsedBytes: 80, memoryLimitBytes: 100 } })
    assert.equal(t.calls.replaceMessages, 0, 'non-force sub-floor micro must not commit')
    const micro = t.decisions.find(d => d.action === 'micro')
    assert.equal(micro!.commit, false)
    assert.equal(micro!.force, false)
  })

  it('unchanged stale candidate clears the pending debt instead of retrying forever', async () => {
    // All stale tool messages under the preview → transform is a no-op. The
    // debt is unsatisfiable until content changes, so it must not spin.
    const t = makeGated({ msgs: staleFixture(1_000), pendingStale: true })
    await t.coord.runCompaction(0, null)
    assert.equal(t.calls.replaceMessages, 0)
    assert.equal(t.calls.pendingStaleCompact, false, 'no-op candidate drains the debt')
  })
})

describe('CompactBoundaryCoordinator opportunistic compact (cold cache)', () => {
  // Track entry into the stale-round compaction body via dietMessages — it is
  // the first thing the body does, and never runs when the branch is gated off.
  function makeOpp(opts: {
    cold: boolean
    ratio: number
    delay?: boolean
  }) {
    let dietCalls = 0
    // window 1000, ascii ≈ chars/4 → 4 messages × (ratio×1000) chars = ratio×1000 tokens
    const charsEach = Math.round((opts.ratio * 1000 * 4) / 4)
    const { coord, calls } = makeCoord({
      getContextWindow: () => 1_000,
      getMessages: () => bigMsgs(4, charsEach),
      shouldOpportunisticCompact: () => opts.cold,
      shouldDelayCompact: () => opts.delay ?? false,
      dietMessages: (m) => { dietCalls++; return { removedCount: 0, messages: m } },
    })
    return { coord, calls, dietCalls: () => dietCalls }
  }

  it('cold cache lowers the trigger floor: ratio 0.4 compacts at turn 0', async () => {
    const t = makeOpp({ cold: true, ratio: 0.4 })
    await t.coord.runCompaction(0, null)
    assert.equal(t.dietCalls(), 1, 'opportunistic path enters the stale-round body')
  })

  it('warm cache keeps the 0.5 floor: ratio 0.4 does nothing', async () => {
    const t = makeOpp({ cold: false, ratio: 0.4 })
    await t.coord.runCompaction(0, null)
    assert.equal(t.dietCalls(), 0, 'without cold-cache signal the 0.5 floor holds')
  })

  it('cold cache still respects the 0.3 floor: ratio 0.2 does nothing', async () => {
    const t = makeOpp({ cold: true, ratio: 0.2 })
    await t.coord.runCompaction(0, null)
    assert.equal(t.dietCalls(), 0, 'too little stale history — rewrite would not pay off')
  })

  it('cold cache bypasses shouldDelayCompact (its hit-rate memory predates the idle gap)', async () => {
    const t = makeOpp({ cold: true, ratio: 0.6, delay: true })
    await t.coord.runCompaction(0, null)
    assert.equal(t.dietCalls(), 1, 'stale "cache healthy" verdict must not block a cold-cache compact')
  })

  it('warm cache with delay verdict still delays (existing discipline untouched)', async () => {
    const t = makeOpp({ cold: false, ratio: 0.6, delay: true })
    await t.coord.runCompaction(0, null)
    assert.equal(t.dietCalls(), 0)
  })

  it('P2-5 unchanged: cold cache never rewrites off-boundary (turn ≠ 0)', async () => {
    const t = makeOpp({ cold: true, ratio: 0.4 })
    await t.coord.runCompaction(5, null)
    assert.equal(t.dietCalls(), 0, 'opportunistic compaction is turn-0 only')
    assert.equal(t.calls.pendingStaleCompact, false, 'sub-0.5 ratio is not queued either')
  })
})

describe('CompactBoundaryCoordinator T9 (provider cost-aware quality compaction)', () => {
  // Build a coord whose T9 gate is reachable (large window) with a tracked
  // tryPartialCompact, configurable cost/cache classification, and an optional
  // phase transition.
  function makeT9(opts: {
    cachePreserving: boolean
    costInsensitive: boolean
    qRatio: number
    phaseTransition: boolean
    partialOk?: boolean
    thresholds?: { perTokenThreshold: number; subscriptionThreshold: number; subscriptionCeiling: number }
  }) {
    const contextWindow = 1_000_000
    let partialCalls = 0
    const { coord, calls } = makeCoord({
      getContextWindow: () => contextWindow,
      getEstimatedTokens: () => Math.round(opts.qRatio * contextWindow),
      getPrevPhaseHint: () => (opts.phaseTransition ? 'explore' : 'build'),
      getPhaseHint: () => 'build',
      isCachePreservingProvider: () => opts.cachePreserving,
      isCostInsensitiveProvider: () => opts.costInsensitive,
      ...(opts.thresholds ? { getQualityThresholds: () => opts.thresholds! } : {}),
      tryPartialCompact: async () => {
        partialCalls++
        return opts.partialOk ?? true
      },
    })
    return { coord, calls, partialCalls: () => partialCalls }
  }

  it('GLM (cache-preserving + subscription): triggers at turn 0 on phase transition above 0.45', async () => {
    const t = makeT9({ cachePreserving: true, costInsensitive: true, qRatio: 0.5, phaseTransition: true })
    await t.coord.runCompaction(0, null)
    assert.equal(t.partialCalls(), 1, 'GLM gets T9 quality compaction')
  })

  it('GLM: ceiling fallback fires above 0.6 even without a phase transition', async () => {
    const t = makeT9({ cachePreserving: true, costInsensitive: true, qRatio: 0.65, phaseTransition: false })
    await t.coord.runCompaction(0, null)
    assert.equal(t.partialCalls(), 1, 'subscription ceiling (>0.6) triggers without phase change')
  })

  it('GLM: stays below the 0.45 threshold → no compaction', async () => {
    const t = makeT9({ cachePreserving: true, costInsensitive: true, qRatio: 0.4, phaseTransition: true })
    await t.coord.runCompaction(0, null)
    assert.equal(t.partialCalls(), 0, 'below lean threshold, nothing fires')
  })

  it('DeepSeek (cache-preserving + per-token): SKIPS to protect the paid prefix cache', async () => {
    const t = makeT9({ cachePreserving: true, costInsensitive: false, qRatio: 0.9, phaseTransition: true })
    await t.coord.runCompaction(0, null)
    assert.equal(t.partialCalls(), 0, 'DeepSeek never gets T9 (paid cache protection)')
  })

  it('codex/claude (no cache + subscription): leaner 0.45 threshold applies', async () => {
    const t = makeT9({ cachePreserving: false, costInsensitive: true, qRatio: 0.5, phaseTransition: true })
    await t.coord.runCompaction(0, null)
    assert.equal(t.partialCalls(), 1, 'subscription leaner threshold triggers at 0.5')
  })

  it('openai (no cache + per-token): keeps the 0.55 threshold — 0.5 does NOT trigger', async () => {
    const t = makeT9({ cachePreserving: false, costInsensitive: false, qRatio: 0.5, phaseTransition: true })
    await t.coord.runCompaction(0, null)
    assert.equal(t.partialCalls(), 0, 'per-token non-cache provider stays at 0.55')
  })

  it('openai: triggers above 0.55 on phase transition', async () => {
    const t = makeT9({ cachePreserving: false, costInsensitive: false, qRatio: 0.6, phaseTransition: true })
    await t.coord.runCompaction(0, null)
    assert.equal(t.partialCalls(), 1)
  })

  it('timeout guard: NO T9 mid-turn (turn ≠ 0) for any provider, even GLM well over the ceiling', async () => {
    const t = makeT9({ cachePreserving: true, costInsensitive: true, qRatio: 0.9, phaseTransition: true })
    await t.coord.runCompaction(5, null)
    assert.equal(t.partialCalls(), 0, 'mid-turn quality compaction is never allowed (cache re-prefill guard)')
  })

  it('config-tunable: GLM with a lowered subscription threshold (0.267) fires earlier', async () => {
    const aggressive = { perTokenThreshold: 0.55, subscriptionThreshold: 0.267, subscriptionCeiling: 0.4 }
    // qRatio 0.3 is below the 0.45 default but above the 0.267 override → triggers.
    const t = makeT9({ cachePreserving: true, costInsensitive: true, qRatio: 0.3, phaseTransition: true, thresholds: aggressive })
    await t.coord.runCompaction(0, null)
    assert.equal(t.partialCalls(), 1, 'lowered config threshold compacts GLM/MiMo earlier')
  })

  it('config-tunable: lowered subscription ceiling fires without a phase transition', async () => {
    const aggressive = { perTokenThreshold: 0.55, subscriptionThreshold: 0.45, subscriptionCeiling: 0.3 }
    const t = makeT9({ cachePreserving: true, costInsensitive: true, qRatio: 0.35, phaseTransition: false, thresholds: aggressive })
    await t.coord.runCompaction(0, null)
    assert.equal(t.partialCalls(), 1, 'ceiling override triggers without phase change')
  })
})

// An absent archive adapter must never enable the legacy lossy transform.
it('heap compaction preserves unarchived semantic observations when no archive callback exists', async () => {
  const content = 'head\n' + 'fictional details\n'.repeat(30) + 'UNIQUE_OBSERVATION\n' + 'tail\n'.repeat(30)
  const messages: OaiMessage[] = [{ role: 'user', content: 'initial task' }, { role: 'assistant', content: 'ack' },
    { role: 'tool', tool_call_id: 'read_file_fixture', content }]
  for (let i = 0; i < 5; i++) messages.push({ role: 'user', content: `next ${i}` }, { role: 'assistant', content: 'ack' })
  let current = messages
  const { coord } = makeCoord({ getContextWindow: () => 64_000, getMessages: () => current, getEstimatedTokens: () => 1000,
    replaceMessages: next => { current = next } })
  await coord.runCompaction(0, { memory: { heapUsedBytes: 90, memoryLimitBytes: 100 } })
  assert.equal(current[2]?.content, content)
})

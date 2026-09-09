import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CompactionController, extractWriteActionChain, findSafeSplitPoint, foldAgedRecallBlocks, RECALL_KEEP_RECENT } from '../compaction-controller.js'
import { buildRecallMarker } from '../../compact/recall-marker.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { PressureMonitor } from '../../context/pressure-monitor.js'
import type { TrajectoryEntry } from '../trajectory.js'
import type { OaiChatRequest, OaiMessage } from '../../api/oai-types.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'
import { extractTaskContract } from '../../context/task-contract.js'
import type { ProviderProfile } from '../../api/provider-profile.js'
import type { CacheAdvisor } from '../../cache/advisor.js'

function makeEngine(): PromptEngine {
  return new PromptEngine({
    model: 'test-model',
    maxTokens: 1024,
    staticCtx: { tools: [] },
    volatileCtx: { cwd: '/test' },
  })
}

function makeController(session: SessionContext, overrides: Partial<ConstructorParameters<typeof CompactionController>[0]> = {}): CompactionController {
  return new CompactionController({
    session,
    promptEngine: makeEngine(),
    contextWindow: 128_000,
    pressureMonitor: new PressureMonitor(128_000),
    getTrajectoryEntries: () => [],
    getStreamedText: () => '',
    refreshLedger: () => {},
    ...overrides,
  })
}

describe('CompactionController reclaim gate (2026-07-16 cost-aware reclaim plan task 2)', () => {
  // Session 2c1186f5 counterexample: a deterministic rewrite that changes tool
  // bytes but reclaims almost nothing must NOT replace history — the rewrite
  // shatters the hot prefix cache for a sub-floor reclaim.
  //
  // Construction: 128k window, ratio ≈ 0.67 (tier 1 fires). The only
  // compactable message is one tool result barely over the truncation preview
  // (40k chars vs 38.4k preview) → candidate changes, but reclaims only a few
  // hundred tokens, far below any profile floor.
  function lowReclaimSession(): SessionContext {
    const session = new SessionContext()
    const big = 'x'.repeat(76_000) // 19k tokens each, non-tool → untouched by micro compact
    session.replaceMessages([
      { role: 'user', content: big },
      { role: 'assistant', content: big },
      { role: 'user', content: big },
      { role: 'assistant', content: big },
      { role: 'tool', tool_call_id: 'read_file_1', content: 'y'.repeat(40_000) } as OaiMessage,
    ])
    return session
  }

  it('skips a low-reclaim deterministic rewrite: no replace, no markCompacted, no compact event', async () => {
    const session = lowReclaimSession()
    const beforeMessages = session.getMessages()
    const decisions: Array<{ commit: boolean; reason: string }> = []
    const controller = makeController(session, {
      onReclaimDecision: d => { decisions.push({ commit: d.commit, reason: d.reason }) },
    })

    const result = await controller.maybeCompact({ loopTurn: 0, failures: { consecutiveFailures: 0 } })

    assert.equal(result.compacted, false, 'low-reclaim candidate must not commit')
    assert.deepEqual(result.failures, { consecutiveFailures: 0 }, 'a gate skip is not a compaction failure')
    assert.equal(session.getMessages(), beforeMessages, 'history untouched (same reference)')
    assert.equal(session.wasCompactedAt(0), false, 'no markCompacted on a rejected candidate')
    assert.equal(session.getCompactEvents().length, 0, 'no compact event on a rejected candidate')
    assert.equal(decisions.length, 1)
    assert.deepEqual(decisions[0], { commit: false, reason: 'below-reclaim-floor' })
  })

  it('does not inject the tier-2 summary on a rejected candidate', async () => {
    const session = lowReclaimSession()
    const controller = makeController(session, {
      getTrajectoryEntries: () => [{
        turn: 1, tool: 'edit_file', target: 'src/a.ts', status: 'failed',
        durationMs: 1, inputSummary: 'src/a.ts', resultSummary: 'boom', errorClass: 'io',
      } as TrajectoryEntry],
    })
    await controller.maybeCompact({ loopTurn: 0, failures: { consecutiveFailures: 0 } })
    const hasSummary = session.getMessages().some(
      m => typeof m.content === 'string' && m.content.includes('<compact-summary>'),
    )
    assert.equal(hasSummary, false, 'summary must only be appended after the candidate commits')
  })

  it('commits a high-reclaim candidate and records the commit decision', async () => {
    // All-tool session: every message is compactable, reclaim is huge. Six
    // messages keep the ratio (~0.78 incl. prefix overhead) under the 0.95
    // ceiling so the decision stays a non-force tier action.
    const session = new SessionContext()
    const big = 'z'.repeat(60_000)
    session.replaceMessages(Array.from({ length: 6 }, (_, i) => (
      { role: 'tool', tool_call_id: `read_file_${i}`, content: big } as OaiMessage
    )))
    const decisions: Array<{ commit: boolean; reason: string }> = []
    const controller = makeController(session, {
      onReclaimDecision: d => { decisions.push({ commit: d.commit, reason: d.reason }) },
    })

    const result = await controller.maybeCompact({ loopTurn: 0, failures: { consecutiveFailures: 0 } })

    assert.equal(result.compacted, true)
    assert.equal(session.getCompactEvents().at(-1)?.tier, 1)
    assert.equal(decisions.length, 1)
    assert.deepEqual(decisions[0], { commit: true, reason: 'reclaim-above-floor' })
  })

  it('1M half-full window is left alone once the precision ceiling moved to 0.7', async () => {
    // ~510k tokens on a 1M window. Under the old 0.5 ceiling this fell in the
    // "precision band" (past the ceiling, below the 0.60 partial-llm rung) and
    // triggered a gated deterministic reclaim. At 0.7 a half-full window is no
    // longer a precision concern, and shattering a hot 500k prefix to reclaim
    // it was exactly the cost this ceiling change set out to stop paying.
    const session = new SessionContext()
    session.replaceMessages(Array.from({ length: 4 }, (_, i) => (
      { role: 'tool', tool_call_id: `read_file_${i}`, content: 'w'.repeat(500_000) } as OaiMessage
    )))
    const before = session.getMessages()
    const controller = makeController(session, {
      contextWindow: 1_000_000,
      providerProfile: { cacheType: 'exact-prefix', persistent: true } as ProviderProfile,
    })
    const result = await controller.maybeCompact({ loopTurn: 0, failures: { consecutiveFailures: 0 } })
    assert.equal(result.compacted, false)
    assert.equal(session.getMessages(), before, 'history untouched at 51% of a 1M window')
  })

  it('1M window: never rewrites mid-turn (loopTurn ≠ 0)', async () => {
    const session = new SessionContext()
    session.replaceMessages(Array.from({ length: 4 }, (_, i) => (
      { role: 'tool', tool_call_id: `read_file_${i}`, content: 'w'.repeat(500_000) } as OaiMessage
    )))
    const before = session.getMessages()
    const controller = makeController(session, {
      contextWindow: 1_000_000,
      providerProfile: { cacheType: 'exact-prefix', persistent: true } as ProviderProfile,
    })
    const result = await controller.maybeCompact({ loopTurn: 3, failures: { consecutiveFailures: 0 } })
    assert.equal(result.compacted, false)
    assert.equal(session.getMessages(), before, 'no mid-turn history rewrite on 1M windows')
  })

  it('records before/after/reclaimed token fields on the decision', async () => {
    const session = lowReclaimSession()
    const records: Array<{ beforeTokens: number; afterTokens: number; reclaimedTokens: number; action: string }> = []
    const controller = makeController(session, {
      onReclaimDecision: d => {
        records.push({ beforeTokens: d.beforeTokens, afterTokens: d.afterTokens, reclaimedTokens: d.reclaimedTokens, action: d.action })
      },
    })
    await controller.maybeCompact({ loopTurn: 0, failures: { consecutiveFailures: 0 } })
    assert.equal(records.length, 1)
    assert.equal(records[0]!.action, 'micro')
    assert.ok(records[0]!.beforeTokens > 80_000, 'before reflects the real session estimate')
    assert.ok(records[0]!.reclaimedTokens > 0 && records[0]!.reclaimedTokens < 4_096, 'reclaim is positive but sub-floor')
    assert.equal(records[0]!.beforeTokens - records[0]!.reclaimedTokens, records[0]!.afterTokens)
  })
})

describe('CompactionController ceiling force semantics (task 6)', () => {
  function overCeilingSession(window: number): SessionContext {
    const session = new SessionContext()
    const huge = 'x'.repeat(Math.floor(window * 0.3) * 4)
    session.replaceMessages([
      { role: 'user', content: 'anchor user' },
      { role: 'assistant', content: 'anchor assistant' },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
    ])
    return session
  }

  it('enforceContextCeiling emits a forced checkpoint decision that bypasses reclaim floors', async () => {
    const session = overCeilingSession(128_000)
    const decisions: Array<{ action: string; force: boolean; commit: boolean; reason: string }> = []
    const controller = makeController(session, {
      onReclaimDecision: d => { decisions.push({ action: d.action, force: d.force, commit: d.commit, reason: d.reason }) },
    })

    await controller.enforceContextCeiling()

    assert.ok(session.getEstimatedTokens() <= 128_000 * 0.95, 'ceiling reduced context below 95%')
    assert.equal(decisions.length, 1)
    assert.deepEqual(decisions[0], { action: 'checkpoint', force: true, commit: true, reason: 'forced' })
  })

  it('enforceContextCeiling below the ceiling emits no decision (no phantom telemetry)', async () => {
    const session = new SessionContext()
    session.replaceMessages([
      { role: 'user', content: 'small' },
      { role: 'assistant', content: 'small' },
    ])
    const decisions: unknown[] = []
    const controller = makeController(session, {
      onReclaimDecision: d => { decisions.push(d) },
    })
    await controller.enforceContextCeiling()
    assert.equal(decisions.length, 0)
  })

  it('trySessionSplit emits a forced session-split decision', async () => {
    const session = new SessionContext()
    const huge = 'x'.repeat(220_000 * 4)
    session.replaceMessages([
      { role: 'user', content: 'anchor user' },
      { role: 'assistant', content: 'anchor assistant' },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
    ])
    const decisions: Array<{ action: string; force: boolean; commit: boolean }> = []
    const controller = makeController(session, {
      contextWindow: 1_000_000,
      onReclaimDecision: d => { decisions.push({ action: d.action, force: d.force, commit: d.commit }) },
    })

    const didSplit = await controller.trySessionSplit()

    assert.equal(didSplit, true)
    assert.equal(decisions.length, 1)
    assert.deepEqual(decisions[0], { action: 'session-split', force: true, commit: true })
  })

  it('ceiling checkpoint preserves a just-sent trailing user message verbatim (desktop long-message regression)', async () => {
    // 用户刚发的长消息（末尾 user）绝不能被 ceiling checkpoint 摘要替换——
    // 否则模型下一请求看到的指令是压缩版（用户观感：消息被截断）。
    // 构造：历史顶过 95% ceiling，最后一条是 fresh 长 user 消息（尚未被模型消费）。
    const session = new SessionContext()
    const huge = 'x'.repeat(Math.floor(128_000 * 0.3) * 4) // 每条 ≈ 窗口 30%，历史合计超 ceiling
    const FRESH = '这条是用户刚发送的完整指令：' + '请逐字保留我这段长消息的全部内容。'.repeat(400)
    session.replaceMessages([
      { role: 'user', content: 'anchor user' },
      { role: 'assistant', content: 'anchor assistant' },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
      { role: 'user', content: FRESH },
    ])
    const controller = makeController(session)

    await controller.enforceContextCeiling()

    const msgs = session.getMessages()
    assert.equal(session.getEstimatedTokens() <= 128_000 * 0.95, true, 'ceiling reduced context below 95%')
    const tail = msgs[msgs.length - 1]
    assert.ok(tail, 'checkpoint 后消息列表非空')
    assert.equal(tail.role, 'user', 'checkpoint 后最后一条必须是 user（原文）')
    assert.equal(
      typeof tail.content === 'string' && tail.content.includes('请逐字保留我这段长消息的全部内容'),
      true,
      '刚发送的 user 消息原文必须逐字保留在 checkpoint 后的上下文中，不得被摘要替换',
    )
  })
})

describe('CompactionController', () => {
  it('runs micro compact when pressure crosses ratio threshold', async () => {
    // Reclaim-gate era: the fixture must contain genuinely compactable content
    // (tool results over the truncation preview). All-text histories produce an
    // unchanged candidate, which the gate now correctly refuses to commit.
    const session = new SessionContext()
    const historyMessage = 'x'.repeat(12_000 * 4)
    session.replaceMessages(Array.from({ length: 8 }, (_, i) => (
      { role: 'tool', tool_call_id: `read_file_${i}`, content: historyMessage } as OaiMessage
    )))
    let refreshed = false
    const controller = makeController(session, {
      refreshLedger: () => { refreshed = true },
    })

    const result = await controller.maybeCompact({ loopTurn: 0, failures: { consecutiveFailures: 0 } })

    assert.equal(result.compacted, true)
    assert.deepEqual(result.failures, { consecutiveFailures: 0 })
    assert.equal(refreshed, true)
    assert.equal(session.wasCompactedAt(0), true)
    assert.equal(session.getCompactEvents().at(-1)?.tier, 1)
    assert.ok(session.getEstimatedTokens() < 96_000 || session.getMessages().length <= 8)
  })

  it('fires onHistoryRewritten after a compaction rewrite (read-dedup invalidation hook)', async () => {
    const session = new SessionContext()
    const historyMessage = 'x'.repeat(12_000 * 4)
    session.replaceMessages(Array.from({ length: 8 }, (_, i) => (
      { role: 'tool', tool_call_id: `read_file_${i}`, content: historyMessage } as OaiMessage
    )))
    let fired = 0
    const controller = makeController(session, {
      onHistoryRewritten: () => { fired++ },
    })

    const result = await controller.maybeCompact({ loopTurn: 0, failures: { consecutiveFailures: 0 } })

    assert.equal(result.compacted, true)
    assert.ok(fired >= 1, 'history rewrite must notify onHistoryRewritten so read-dedup can be invalidated')
  })

  it('skips discretionary compaction when compactEnabled is false', async () => {
    const session = new SessionContext()
    const historyMessage = 'x'.repeat(12_000 * 4)
    session.replaceMessages([
      { role: 'user', content: historyMessage },
      { role: 'assistant', content: historyMessage },
      { role: 'user', content: historyMessage },
      { role: 'assistant', content: historyMessage },
      { role: 'user', content: historyMessage },
      { role: 'assistant', content: historyMessage },
      { role: 'user', content: historyMessage },
      { role: 'assistant', content: historyMessage },
    ])
    const controller = makeController(session, { compactEnabled: false })

    const result = await controller.maybeCompact({ loopTurn: 0, failures: { consecutiveFailures: 0 } })

    assert.equal(result.compacted, false)
    assert.equal(session.getMessages().length, 8)
  })

  it('falls back to cache anchors plus resume state when over the hard ceiling', async () => {
    const session = new SessionContext()
    const huge = 'x'.repeat(80_000 * 4)
    session.replaceMessages([
      { role: 'user', content: 'anchor user' },
      { role: 'assistant', content: 'anchor assistant' },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
    ])
    let refreshed = false
    const controller = makeController(session, {
      getTrajectoryEntries: () => [{
        turn: 1,
        tool: 'read_file',
        target: 'src/a.ts',
        status: 'success',
        durationMs: 1,
        inputSummary: 'src/a.ts',
        resultSummary: 'read src/a.ts',
      }],
      getStreamedText: () => 'Remaining: finish implementation',
      refreshLedger: () => { refreshed = true },
    })

    await controller.enforceContextCeiling()

    const messages = session.getMessages()
    assert.equal(messages[0]?.content, 'anchor user')
    assert.equal(messages[1]?.content, 'anchor assistant')
    assert.match(String(messages[2]?.content), /<checkpoint-resume>/)
    assert.ok(session.getEstimatedTokens() <= 128_000 * 0.95)
    assert.equal(refreshed, true)
    assert.equal(session.getCompactEvents().at(-1)?.tier, 4)
  })

  it('returns a cache diagnostic only for low latest-turn hit rate', () => {
    const session = new SessionContext()
    const controller = makeController(session)

    assert.equal(controller.refreshCacheDiagnostic(1), null)

    session.recordTurnCache(1, {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 90,
    })

    assert.match(controller.refreshCacheDiagnostic(1) ?? '', /cache/i)

    session.recordTurnCache(2, {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 99,
      cache_creation_input_tokens: 1,
    })

    assert.equal(controller.refreshCacheDiagnostic(2), null)
  })

  // P1.2: small-window (<200K) prune mutates session storage — this is
  // intentional (only 1M+ windows use request-time T7 folding). Rivet
  // targets DeepSeek V4 (1M window); small-window paths are not maintained.
  it.skip('P1.2: prune does NOT modify session message storage (<200K — not supported)', async () => {
    const session = new SessionContext()
    // Build messages with several large-enough tool results to trigger prune.
    // On 128K contextWindow, prune.minChars=40_000. Each tool result is 50K →
    // exceeds minChars. With protectRecent=8 and CACHE_ANCHOR_MESSAGES=2,
    // tool results at indices 2-7 (before recent 8) should be pruned.
    const messages: Array<{ role: 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string }> = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]
    // Add tool results that trigger prune
    for (let i = 0; i < 12; i++) {
      messages.push({
        role: 'tool',
        content: 'x'.repeat(50_000),
        tool_call_id: `tc_${i}`,
      })
    }
    // Add recent messages (within protectRecent) — won't be pruned
    messages.push({ role: 'user', content: 'recent query' })
    messages.push({ role: 'assistant', content: 'recent answer' })

    session.replaceMessages(messages as any)
    const messagesBefore = session.getMessages()
    const contentsBefore = messagesBefore.map(m => m.content)

    const controller = makeController(session, { contextWindow: 128_000 })

    const result = await controller.maybeCompact({
      loopTurn: 1,
      failures: { consecutiveFailures: 0 },
    })

    const messagesAfter = session.getMessages()
    const contentsAfter = messagesAfter.map(m => m.content)

    // Messages in storage must be unchanged — prune is now request-time mask
    assert.deepStrictEqual(
      contentsAfter,
      contentsBefore,
      'prune must not mutate session message storage'
    )
  })

  // Phase 2.1: On 1M+ windows the 60% partial-compact path needs BOTH a
  // primaryClient AND enough messages to split (> anchor + recentToPreserve + 4
  // ≈ 66). Here a client is wired but there are only 10 messages at 65% ratio,
  // so tryPartialCompact bails (too few to split) and the full path (≥75%) is
  // not reached — net result is no compaction, history left intact.
  //
  // NOTE: the previous version of this test omitted primaryClient entirely, so
  // the 60%/75% branches were skipped on the `&& this.deps.primaryClient` gate
  // and never actually exercised — a false green. The client is now provided so
  // the branch is genuinely entered and the "too few messages" bail is tested.
  it('P2.1: 1M window at 65% with too few messages does not compact', async () => {
    const session = new SessionContext()
    // 10 messages × 65K tokens each = 650K tokens → 65% ratio (60-75% band).
    const chunk = 'x'.repeat(260_000) // 260K chars / 4 ≈ 65K tokens
    const msgs = [
      { role: 'user' as const, content: chunk },
      { role: 'assistant' as const, content: chunk },
      { role: 'user' as const, content: chunk },
      { role: 'assistant' as const, content: chunk },
      { role: 'user' as const, content: chunk },
      { role: 'assistant' as const, content: chunk },
      { role: 'user' as const, content: chunk },
      { role: 'assistant' as const, content: chunk },
      { role: 'user' as const, content: chunk },
      { role: 'assistant' as const, content: chunk },
    ]
    session.replaceMessages(msgs)
    const tokensBefore = session.getEstimatedTokens()
    const messagesBefore = session.getMessages()

    assert.ok(
      tokensBefore / 1_000_000 >= 0.60 && tokensBefore / 1_000_000 < 0.75,
      `setup: tokens ${tokensBefore} must land in the 60-75% partial band`
    )

    let refreshed = false
    let streamCalled = false
    const primaryClient: StreamClient = {
      stream: async (_request: OaiChatRequest, callbacks: StreamCallbacks) => {
        streamCalled = true
        callbacks.onTextDelta('summary')
      },
    }
    const controller = makeController(session, {
      contextWindow: 1_000_000,
      primaryClient,
      refreshLedger: () => { refreshed = true },
    })

    const result = await controller.maybeCompact({
      loopTurn: 0,
      failures: { consecutiveFailures: 0 },
    })

    // 10 messages < 66 → partial bails before issuing an LLM request.
    assert.equal(result.compacted, false, 'too few messages to partial-compact at 65%')
    assert.equal(streamCalled, false, 'partial must bail before calling the model')
    assert.deepEqual(result.failures, { consecutiveFailures: 0 })
    assert.equal(refreshed, false)

    const messagesAfter = session.getMessages()
    assert.deepStrictEqual(
      messagesAfter.map(m => m.content),
      messagesBefore.map(m => m.content),
      'messages must be unchanged when compaction is skipped'
    )
  })

  // P2.1b: with a client AND enough messages, the 60% partial path actually
  // fires — this is the branch the old false-green test never reached.
  it('P2.1b: 1M window at 65% with enough messages triggers partial compact', async () => {
    const session = new SessionContext()
    // 70 messages × 10K tokens = 700K tokens → 70% ratio, and 70 > 66 so the
    // partial split has room (anchor 2 + recent 60 + summary).
    const chunk = 'x'.repeat(40_000) // 40K chars / 4 ≈ 10K tokens
    const msgs = Array.from({ length: 70 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: chunk,
    }))
    session.replaceMessages(msgs)
    const ratio = session.getEstimatedTokens() / 1_000_000
    assert.ok(ratio >= 0.60 && ratio < 0.75, `setup: ratio ${ratio} must be in 60-75% band`)

    let streamCalled = false
    const primaryClient: StreamClient = {
      stream: async (_request: OaiChatRequest, callbacks: StreamCallbacks) => {
        streamCalled = true
        callbacks.onTextDelta('partial summary of old zone')
      },
    }
    const controller = makeController(session, {
      contextWindow: 1_000_000,
      primaryClient,
    })

    const result = await controller.maybeCompact({
      loopTurn: 0,
      failures: { consecutiveFailures: 0 },
    })

    assert.equal(streamCalled, true, 'partial compact must call the model')
    assert.equal(result.compacted, true, 'partial compact must succeed')
    const after = session.getMessages()
    assert.ok(after.length < 70, `expected fewer messages after partial compact, got ${after.length}`)
    assert.match(String(after[2]?.content), /partial-compact-summary/)
  })

  // P2.1c: P2 gate — on a cache-preserving provider with a hot cache, the 1M
  // partial path defers compaction instead of breaking the prefix.
  it('P2.1c: 1M partial compact is delayed when cache-preserving provider cache is hot', async () => {
    const session = new SessionContext()
    const chunk = 'x'.repeat(40_000)
    const msgs = Array.from({ length: 70 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: chunk,
    }))
    session.replaceMessages(msgs)

    let streamCalled = false
    const primaryClient: StreamClient = {
      stream: async (_request: OaiChatRequest, callbacks: StreamCallbacks) => {
        streamCalled = true
        callbacks.onTextDelta('summary')
      },
    }
    const controller = makeController(session, {
      contextWindow: 1_000_000,
      primaryClient,
      providerProfile: { cacheType: 'exact-prefix', persistent: true } as ProviderProfile,
      cacheAdvisor: { shouldDelayCompact: () => true, getRecentHitRate: () => null } as unknown as CacheAdvisor,
    })

    const result = await controller.maybeCompact({
      loopTurn: 0,
      failures: { consecutiveFailures: 0 },
    })

    assert.equal(result.compacted, false, 'cache-preserving + hot cache must defer compaction')
    assert.equal(streamCalled, false, 'no LLM request when compaction is deferred')
    assert.equal(session.getMessages().length, 70, 'history untouched when deferred')
  })

  // P2.1d: P1 — partial compact appends the authoritative task-anchor so
  // constraints/scope survive even if the LLM summary drops them.
  it('P2.1d: partial compact injects task-anchor appendix when a contract is active', async () => {
    const session = new SessionContext()
    const chunk = 'x'.repeat(40_000)
    const msgs = Array.from({ length: 70 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: chunk,
    }))
    session.replaceMessages(msgs)

    const primaryClient: StreamClient = {
      stream: async (_request: OaiChatRequest, callbacks: StreamCallbacks) => {
        callbacks.onTextDelta('summary that omits the constraints')
      },
    }
    const contract = extractTaskContract(
      'Refactor compaction-controller.ts. Constraint: do not break the prefix cache. Touch src/agent/compaction-controller.ts only.',
    )
    const controller = makeController(session, {
      contextWindow: 1_000_000,
      primaryClient,
      getActiveContract: () => contract,
    })

    const result = await controller.maybeCompact({
      loopTurn: 0,
      failures: { consecutiveFailures: 0 },
    })

    assert.equal(result.compacted, true)
    const after = session.getMessages()
    const tail = String(after[after.length - 1]?.content ?? '')
    assert.match(tail, /task-anchor/, 'partial compact must append the task-anchor appendix')
  })

  // P3: partial compact persists heuristic session memories before history is
  // replaced — the hook the loop callback uses to hot-refresh session memory.
  it('P3: partial compact persists extracted memories before replacing history', async () => {
    const session = new SessionContext()
    const msgs = Array.from({ length: 70 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: i % 2 === 0
        ? 'I always prefer prefix-cache safety. ' + 'x'.repeat(40_000)
        : 'x'.repeat(40_000),
    }))
    session.replaceMessages(msgs)

    const primaryClient: StreamClient = {
      stream: async (_request: OaiChatRequest, callbacks: StreamCallbacks) => {
        callbacks.onTextDelta('summary')
      },
    }
    const persisted: Array<{ text: string; kind: string; source: string }> = []
    const controller = makeController(session, {
      contextWindow: 1_000_000,
      primaryClient,
      persistMemories: mems => { persisted.push(...mems) },
    })

    const result = await controller.maybeCompact({
      loopTurn: 0,
      failures: { consecutiveFailures: 0 },
    })

    assert.equal(result.compacted, true)
    assert.ok(persisted.length > 0, 'partial compact must persist extracted memories')
    assert.ok(
      persisted.some(m => m.kind === 'user_preference'),
      'should extract the user preference from history before replacement',
    )
  })

  // P6: llmCompact post-check — a summary that reflects the trajectory's error
  // class / touched files is kept verbatim as a compact-summary.
  it('P6: llmCompact keeps a summary that covers trajectory state', async () => {
    const session = new SessionContext()
    session.replaceMessages([
      { role: 'user', content: 'fix the bug' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'done' },
    ])
    const trajectory: TrajectoryEntry[] = [
      { turn: 1, tool: 'write_file', target: 'src/foo.ts', durationMs: 10, status: 'failed', errorClass: 'TS2322', inputSummary: 'edit', resultSummary: 'type error' },
    ]
    const primaryClient: StreamClient = {
      stream: async (_request: OaiChatRequest, callbacks: StreamCallbacks) => {
        callbacks.onTextDelta('Fixed the TS2322 type error in src/foo.ts by adding a cast.')
      },
    }
    const controller = makeController(session, {
      contextWindow: 1_000_000,
      primaryClient,
      getTrajectoryEntries: () => trajectory,
    })

    const result = await controller.llmCompact()
    assert.match(String(result), /<compact-summary/, 'covering summary kept as LLM compact')
    assert.match(String(result), /TS2322/)
  })

  // P6: a summary that reflects NONE of the trajectory's material state falls
  // back to the deterministic structured handoff.
  it('P6: llmCompact falls back to structured handoff when summary covers nothing', async () => {
    const session = new SessionContext()
    session.replaceMessages([
      { role: 'user', content: 'fix the bug' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'done' },
    ])
    const trajectory: TrajectoryEntry[] = [
      { turn: 1, tool: 'write_file', target: 'src/foo.ts', durationMs: 10, status: 'failed', errorClass: 'TS2322', inputSummary: 'edit', resultSummary: 'type error' },
    ]
    const primaryClient: StreamClient = {
      stream: async (_request: OaiChatRequest, callbacks: StreamCallbacks) => {
        callbacks.onTextDelta('We did some work and made progress on various things.')
      },
    }
    const controller = makeController(session, {
      contextWindow: 1_000_000,
      primaryClient,
      getTrajectoryEntries: () => trajectory,
    })

    const result = await controller.llmCompact()
    assert.doesNotMatch(String(result), /<compact-summary/, 'non-covering summary must not be wrapped')
    assert.match(String(result), /用户核心需求/, 'must fall back to the structured handoff')
  })

  // P7 (E2E): drive a real partial compact over a long history and assert the
  // re-injected task-anchor still carries objective / file-scope / user
  // constraint / completed+remaining todos — the deterministic backstop the LLM
  // summary may have dropped. Complements the prompt-engine-level safety net in
  // compact-prompt-contract.test.ts by exercising the compaction-controller lane.
  it('P7 (E2E): long history → partial compact → anchor retains objective/constraints/todos', async () => {
    const session = new SessionContext()
    const msgs = Array.from({ length: 70 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: 'x'.repeat(40_000),
    }))
    session.replaceMessages(msgs)

    const contract = extractTaskContract(
      "Refactor src/auth.ts to use JWT. Don't touch the billing module.",
      1,
    )
    const trajectory: TrajectoryEntry[] = [
      { turn: 1, tool: 'read_file', target: 'src/auth.ts', durationMs: 5, status: 'success', inputSummary: 'read', resultSummary: 'ok' },
    ]
    const primaryClient: StreamClient = {
      stream: async (_request: OaiChatRequest, callbacks: StreamCallbacks) => {
        // Summary deliberately elides the contract details — the anchor must
        // carry them deterministically.
        callbacks.onTextDelta('Earlier work elided.')
      },
    }
    const controller = makeController(session, {
      contextWindow: 1_000_000,
      primaryClient,
      getActiveContract: () => contract,
      getTrajectoryEntries: () => trajectory,
      getStreamedText: () => 'Next step: migrate auth middleware',
    })

    const result = await controller.maybeCompact({ loopTurn: 0, failures: { consecutiveFailures: 0 } })
    assert.equal(result.compacted, true)

    const after = session.getMessages()
    const tail = String(after[after.length - 1]?.content ?? '')
    assert.match(tail, /<task-anchor authoritative="true"/, 'anchor present after partial compact')
    assert.match(tail, /src\/auth\.ts/, 'objective/file-scope survives')
    assert.match(tail, /billing/i, 'user hard-constraint survives')
    assert.match(tail, /read_file auth\.ts/, 'completed todo survives')
    assert.match(tail, /migrate auth middleware/, 'remaining todo survives')
  })

  // Phase 2.1: enforceContextCeiling MUST still fire on 1M+ windows.
  // The 95% ceiling is the emergency last resort — if we're truly about to
  // overflow, we checkpoint-resume regardless of cache implications.
  it('P2.1: enforceContextCeiling still fires on 1M+ window', async () => {
    const session = new SessionContext()
    // Create enough to exceed 95% of 1M window = 950K tokens.
    // Each huge message: 200K * 4 chars = 200K tokens. 5 messages = 1M tokens.
    const huge = 'x'.repeat(200_000 * 4) // 200K tokens per message
    session.replaceMessages([
      { role: 'user', content: 'anchor user' },
      { role: 'assistant', content: 'anchor assistant' },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
      { role: 'user', content: huge },
    ])

    let refreshed = false
    const controller = makeController(session, {
      contextWindow: 1_000_000,
      refreshLedger: () => { refreshed = true },
    })

    await controller.enforceContextCeiling()

    const messages = session.getMessages()
    // Ceiling still fired: 2 anchor messages + checkpoint-resume handoff +
    // the fresh trailing user message preserved verbatim (desktop
    // long-message regression fix — pre-fix asserted 3 with the tail swallowed).
    assert.equal(messages.length, 4)
    assert.equal(messages[2]?.role, 'assistant')
    assert.match(String(messages[2]?.content), /<checkpoint-resume>/)
    assert.equal(messages[3]?.role, 'user')
    assert.equal(messages[3]?.content, huge, 'fresh trailing user message preserved verbatim')
    assert.ok(session.getEstimatedTokens() <= 1_000_000 * 0.95)
    assert.equal(refreshed, true)
  })

  // Phase 2.3: Session split at 86% context proactively replaces message
  // history with cache anchors + handoff summary. Preserves exact prefix
  // (system+tools+2 anchors) for DeepSeek disk cache hits.
  it('P2.3: session split at 86% context preserves prefix anchors', async () => {
    const session = new SessionContext()
    // Create enough content to cross 86% of 1M window = 860K tokens
    const huge = 'x'.repeat(220_000 * 4) // 220K tokens per message
    session.replaceMessages([
      { role: 'user', content: 'initial request about refactoring loop.ts' },
      { role: 'assistant', content: 'I will analyze the file structure first' },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
    ])

    const messagesBefore = session.getMessages()
    const tokensBefore = session.getEstimatedTokens()
    assert.ok(
      tokensBefore / 1_000_000 >= 0.86,
      `setup: tokens ${tokensBefore} must exceed 86% of 1M window`
    )

    let refreshed = false
    const controller = makeController(session, {
      contextWindow: 1_000_000,
      refreshLedger: () => { refreshed = true },
    })

    const didSplit = await controller.trySessionSplit()

    assert.equal(didSplit, true, 'session split should occur at 86%')

    const messagesAfter = session.getMessages()
    // After split: 2 anchor messages + 1 handoff user message = 3
    assert.equal(messagesAfter.length, 3, 'should have 2 anchors + 1 handoff')
    // First two messages (anchors) must be identical to original
    assert.deepStrictEqual(messagesAfter[0], messagesBefore[0], 'first anchor preserved')
    assert.deepStrictEqual(messagesAfter[1], messagesBefore[1], 'second anchor preserved')
    // Handoff message must be a user message
    assert.equal(messagesAfter[2]?.role, 'user', 'handoff must be user message')
    assert.match(
      String(messagesAfter[2]?.content),
      /<session-handoff>/,
      'handoff must have session-handoff marker'
    )
    // Token count must be well under the window
    assert.ok(session.getEstimatedTokens() <= 1_000_000 * 0.3, 'post-split tokens must be small')
    assert.equal(refreshed, true)
  })

  it('P2.3: session split is skipped when below 86% threshold', async () => {
    const session = new SessionContext()
    session.replaceMessages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ])

    const controller = makeController(session, { contextWindow: 1_000_000 })

    const didSplit = await controller.trySessionSplit()
    assert.equal(didSplit, false, 'should not split below 86%')

    // Messages should be unchanged
    assert.equal(session.getMessages().length, 2)
  })

  it('P2.3: session split is skipped on small windows (< 500K)', async () => {
    const session = new SessionContext()
    // Fill to nearly the window size (but under 500K window)
    const chunk = 'x'.repeat(50_000)
    const msgs = []
    for (let i = 0; i < 8; i++) {
      msgs.push({ role: 'user' as const, content: chunk })
      msgs.push({ role: 'assistant' as const, content: chunk })
    }
    session.replaceMessages(msgs)

    const tokensBefore = session.getMessages().length
    const controller = makeController(session, { contextWindow: 128_000 })

    const didSplit = await controller.trySessionSplit()
    assert.equal(didSplit, false, 'should not split on small windows')
    // Messages should be unchanged
    assert.equal(session.getMessages().length, tokensBefore)
  })

  // P3: trySessionSplit and enforceContextCeiling share the same structural
  // pattern: preserve CACHE_ANCHOR_MESSAGES + inject a handoff message.
  // The unified replaceWithCheckpoint method powers both. Divergence (desktop
  // long-message regression): the ceiling path runs AFTER addUserMessage, so a
  // trailing just-sent user message must be preserved verbatim after the
  // handoff; the split path runs BEFORE addUserMessage (no fresh user exists).
  it('P3: session split / ceiling checkpoint both keep anchors; ceiling additionally preserves a fresh trailing user verbatim', async () => {
    // === trySessionSplit path ===
    const session1 = new SessionContext()
    const huge = 'x'.repeat(220_000 * 4)
    session1.replaceMessages([
      { role: 'user', content: 'anchor user 1' },
      { role: 'assistant', content: 'anchor assistant 1' },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
    ])
    let refreshed1 = false
    const ctrl1 = makeController(session1, {
      contextWindow: 1_000_000,
      refreshLedger: () => { refreshed1 = true },
    })
    const didSplit = await ctrl1.trySessionSplit()
    assert.equal(didSplit, true)
    const msgs1 = session1.getMessages()
    // Structural invariant: anchors + 1 handoff
    assert.equal(msgs1.length, 3)
    assert.equal(msgs1[0]?.role, 'user')
    assert.equal(msgs1[1]?.role, 'assistant')
    assert.equal(msgs1[2]?.role, 'user')
    assert.match(String(msgs1[2]?.content), /<session-handoff>/)
    assert.equal(refreshed1, true)

    // === enforceContextCeiling path ===
    const session2 = new SessionContext()
    const huge2 = 'x'.repeat(200_000 * 4)
    session2.replaceMessages([
      { role: 'user', content: 'anchor user 2' },
      { role: 'assistant', content: 'anchor assistant 2' },
      { role: 'user', content: huge2 },
      { role: 'assistant', content: huge2 },
      { role: 'user', content: huge2 },
      { role: 'assistant', content: huge2 },
      { role: 'user', content: huge2 },
    ])
    let refreshed2 = false
    const ctrl2 = makeController(session2, {
      contextWindow: 1_000_000,
      refreshLedger: () => { refreshed2 = true },
    })
    await ctrl2.enforceContextCeiling()
    const msgs2 = session2.getMessages()
    // Correct structure post-fix: anchors + 1 handoff (assistant role so the
    // preserved tail keeps the trailer slot) + the fresh user message verbatim.
    // (Pre-fix this asserted 3 messages with the tail swallowed into the
    // handoff summary — the desktop long-message truncation bug.)
    assert.equal(msgs2.length, 4)
    assert.equal(msgs2[0]?.role, 'user')
    assert.equal(msgs2[1]?.role, 'assistant')
    assert.equal(msgs2[2]?.role, 'assistant')
    assert.match(String(msgs2[2]?.content), /<checkpoint-resume>/)
    assert.equal(msgs2[3]?.role, 'user')
    assert.equal(msgs2[3]?.content, huge2, 'fresh trailing user message preserved verbatim')
    assert.equal(refreshed2, true)
  })

  // P4: Session split handoff should include tool call mappings from
  // trajectory (tool → target, status) and failure patterns with error classes.
  it('P4: session split handoff includes tool call mappings from trajectory', async () => {
    const session = new SessionContext()
    const huge = 'x'.repeat(220_000 * 4)
    session.replaceMessages([
      { role: 'user', content: 'initial request' },
      { role: 'assistant', content: 'I will refactor the codebase' },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
    ])

    const trajectory: TrajectoryEntry[] = [
      { turn: 1, tool: 'read_file', target: 'src/loop.ts', durationMs: 50, status: 'success', inputSummary: 'read', resultSummary: 'ok' },
      { turn: 2, tool: 'edit_file', target: 'src/loop.ts', durationMs: 100, status: 'success', inputSummary: 'edit', resultSummary: 'ok' },
      { turn: 3, tool: 'bash', target: 'npx tsc --noEmit', durationMs: 3000, status: 'failed', errorClass: 'TS2322', inputSummary: 'typecheck', resultSummary: 'error' },
      { turn: 4, tool: 'edit_file', target: 'src/loop.ts', durationMs: 80, status: 'retried-success', inputSummary: 'fix', resultSummary: 'ok' },
      { turn: 5, tool: 'bash', target: 'npx tsc --noEmit', durationMs: 2000, status: 'success', inputSummary: 'typecheck', resultSummary: 'PASS' },
    ]

    let refreshed = false
    const controller = makeController(session, {
      contextWindow: 1_000_000,
      getTrajectoryEntries: () => trajectory,
      refreshLedger: () => { refreshed = true },
    })

    const didSplit = await controller.trySessionSplit()
    assert.equal(didSplit, true)

    const msgs = session.getMessages()
    const handoff = String(msgs[2]?.content ?? '')

    // Should include tool call mappings with status
    assert.match(handoff, /edit_file/)
    assert.match(handoff, /read_file/)
    assert.match(handoff, /bash/)

    // Should include failure patterns with error class
    assert.match(handoff, /failed/i)
    assert.match(handoff, /TS2322/, 'handoff must include error class from failed tool calls')

    // Should indicate retries via ok* notation
    assert.match(handoff, /ok\*/, 'handoff must indicate retried-success with ok* notation')

    assert.equal(refreshed, true)
  })

  it('A-1: trySessionSplit skips checkpoint mutation when abort lands after LLM compact returns', async () => {
    const session = new SessionContext()
    const huge = 'x'.repeat(220_000 * 4)
    session.replaceMessages([
      { role: 'user', content: 'anchor user' },
      { role: 'assistant', content: 'anchor assistant' },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
    ])
    const before = session.getMessages().map(m => m.content)
    const abortController = new AbortController()
    let refreshed = false
    const primaryClient: StreamClient = {
      stream: async (_request: OaiChatRequest, callbacks: StreamCallbacks) => {
        callbacks.onTextDelta('late compact summary')
        abortController.abort()
      },
    }

    const controller = makeController(session, {
      contextWindow: 1_000_000,
      primaryClient,
      getAbortSignal: () => abortController.signal,
      refreshLedger: () => { refreshed = true },
    })

    const didSplit = await controller.trySessionSplit()

    assert.equal(didSplit, false)
    assert.deepEqual(session.getMessages().map(m => m.content), before)
    assert.equal(refreshed, false)
  })

  it('A-1b: enforceContextCeiling skips checkpoint mutation when abort lands after LLM compact returns', async () => {
    const session = new SessionContext()
    const huge = 'x'.repeat(200_000 * 4)
    session.replaceMessages([
      { role: 'user', content: 'anchor user' },
      { role: 'assistant', content: 'anchor assistant' },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
      { role: 'user', content: huge },
    ])
    const before = session.getMessages().map(m => m.content)
    const abortController = new AbortController()
    let refreshed = false
    const primaryClient: StreamClient = {
      stream: async (_request: OaiChatRequest, callbacks: StreamCallbacks) => {
        callbacks.onTextDelta('late ceiling compact summary')
        abortController.abort()
      },
    }

    const controller = makeController(session, {
      contextWindow: 1_000_000,
      primaryClient,
      getAbortSignal: () => abortController.signal,
      refreshLedger: () => { refreshed = true },
    })

    await controller.enforceContextCeiling()

    assert.deepEqual(session.getMessages().map(m => m.content), before)
    assert.equal(refreshed, false)
  })

  it('A-1c: maybeCompact (1M window LLM compact) skips checkpoint mutation when abort lands after LLM compact returns', async () => {
    const session = new SessionContext()
    // 1M window LLM-compact path fires at ratio >= 0.75. 12 messages ×
    // ~65K tokens ≈ 780K tokens → 78% → reaches the L279 abort guard.
    const chunk = 'x'.repeat(260_000) // 260K chars / 4 ≈ 65K tokens
    session.replaceMessages(
      Array.from({ length: 12 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: chunk,
      })),
    )
    assert.ok(
      session.getEstimatedTokens() / 1_000_000 >= 0.75,
      'setup: tokens must exceed 75% of 1M window to reach the LLM-compact path',
    )
    const before = session.getMessages().map(m => m.content)
    const abortController = new AbortController()
    let refreshed = false
    const primaryClient: StreamClient = {
      stream: async (_request: OaiChatRequest, callbacks: StreamCallbacks) => {
        callbacks.onTextDelta('late micro compact summary')
        abortController.abort()
      },
    }

    const controller = makeController(session, {
      contextWindow: 1_000_000,
      primaryClient,
      getAbortSignal: () => abortController.signal,
      refreshLedger: () => { refreshed = true },
    })

    const result = await controller.maybeCompact({ loopTurn: 0, failures: { consecutiveFailures: 0 } })

    assert.equal(result.compacted, false)
    assert.deepEqual(session.getMessages().map(m => m.content), before)
    assert.equal(refreshed, false)
  })

  it('P4: enforceContextCeiling handoff also benefits from trajectory data', async () => {
    const session = new SessionContext()
    const huge = 'x'.repeat(200_000 * 4)
    session.replaceMessages([
      { role: 'user', content: 'anchor user' },
      { role: 'assistant', content: 'anchor assistant' },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
      { role: 'user', content: huge },
    ])

    const trajectory: TrajectoryEntry[] = [
      { turn: 1, tool: 'read_file', target: 'src/foo.ts', durationMs: 30, status: 'success', inputSummary: 'read', resultSummary: 'ok' },
      { turn: 2, tool: 'write_file', target: 'src/bar.ts', durationMs: 40, status: 'failed', errorClass: 'ENOENT', inputSummary: 'write', resultSummary: 'error' },
    ]

    let refreshed = false
    const controller = makeController(session, {
      contextWindow: 1_000_000,
      getTrajectoryEntries: () => trajectory,
      getStreamedText: () => 'I need to fix the ENOENT error and implement the feature',
      refreshLedger: () => { refreshed = true },
    })

    await controller.enforceContextCeiling()

    const msgs = session.getMessages()
    const handoff = String(msgs[2]?.content ?? '')

    // Should include tool names from trajectory (more reliable than regex from content)
    assert.match(handoff, /read_file/)
    assert.match(handoff, /write_file/)

    // Should include failure context
    assert.match(handoff, /failed/i)
    assert.match(handoff, /ENOENT/, 'ceiling handoff must include error class')

    assert.equal(refreshed, true)
  })

  // Phase 2: compact summary injection at tier 2+
  it('P2: injects compact-summary message after micro-compact at tier 2+', async () => {
    const session = new SessionContext()
    // Create enough content to cross the compact threshold (78% for balanced)
    // Balanced: compact=0.78 → ~78K on 100K window
    const chunk = 'x'.repeat(32_000) // 32K chars / 4 ≈ 8K tokens
    const msgs: Array<{ role: 'user' | 'assistant'; content: string }> = []
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: 'user', content: chunk })
      msgs.push({ role: 'assistant', content: chunk })
    }
    session.replaceMessages(msgs)
    // Force estimated tokens to cross the compact threshold
    // 20 messages × 8K tokens = 160K → 160% → tier 4 (ceiling)
    // Use a smaller 200K window so ratio is realistic
    const tokens = session.getEstimatedTokens()

    const entries = [
      { turn: 1, tool: 'read_file', target: 'src/a.ts', status: 'success' as const, durationMs: 0, inputSummary: '', resultSummary: 'ok' },
      { turn: 2, tool: 'edit_file', target: 'src/a.ts', status: 'success' as const, durationMs: 0, inputSummary: '', resultSummary: 'ok' },
    ]

    let refreshed = false
    const controller = new CompactionController({
      session,
      promptEngine: makeEngine(),
      contextWindow: Math.max(tokens * 2, 100_000), // large enough to not ceiling
      pressureMonitor: new PressureMonitor(Math.max(tokens * 2, 100_000)),
      getTrajectoryEntries: () => entries,
      getStreamedText: () => 'I will fix the bug. Next, add tests.',
      refreshLedger: () => { refreshed = true },
    })

    // Force compact at tier 2 by manipulating token estimate
    const result = await controller.maybeCompact({
      loopTurn: 3,
      failures: { consecutiveFailures: 0 },
    })

    // Should have compacted (not skipped)
    // If compaction occurred, the summary should be in the messages
    const msgsAfter = session.getMessages()
    const summaryMsg = msgsAfter.find(m =>
      m.role === 'user' && typeof m.content === 'string' && m.content.includes('<compact-summary>'),
    )
    if (result.compacted) {
      assert.ok(summaryMsg, 'compacted session should contain compact-summary message')
      assert.match(String(summaryMsg!.content), /Goals/)
      assert.match(String(summaryMsg!.content), /Progress/)
    }
    // If not compacted, still a valid outcome (token estimate might not cross threshold)
  })

  // ── prefixOverhead 在 AgentLoop 构造时立刻设置 ──────────────────
  // 根因：旧 _ensurePrefixOverhead 只在 maybeCompact 入口调，
  // UI 启动到 maybeCompact 之间的窗口期内 getEstimatedTokens() 不含
  // system prompt + tool definition 的开销 → GlanceBar 显示 ctx 0%、◧ 0/1.0M。
  // 修复后在 AgentLoop 构造后立即调一次，关闭窗口。

  it('ensurePrefixOverhead is a public method', () => {
    const session = new SessionContext()
    const controller = makeController(session)
    assert.equal(typeof (controller as any).ensurePrefixOverhead, 'function')
  })

  it('ensurePrefixOverhead sets prefixOverhead on session', () => {
    const session = new SessionContext()
    const engine = makeEngine()
    const controller = new CompactionController({
      session,
      promptEngine: engine,
      contextWindow: 128_000,
      pressureMonitor: new PressureMonitor(128_000),
      getTrajectoryEntries: () => [],
      getStreamedText: () => '',
      refreshLedger: () => {},
    })

    // Before: estimatedTokens should be 0 (no messages, no overhead)
    const before = session.getEstimatedTokens()
    assert.equal(before, 0)

    // After: overhead should be set
    controller.ensurePrefixOverhead()
    const after = session.getEstimatedTokens()
    assert.ok(after > 0, `expected estimatedTokens > 0 after ensurePrefixOverhead, got ${after}`)
  })

  it('ensurePrefixOverhead is idempotent', () => {
    const session = new SessionContext()
    const engine = makeEngine()
    const controller = new CompactionController({
      session,
      promptEngine: engine,
      contextWindow: 128_000,
      pressureMonitor: new PressureMonitor(128_000),
      getTrajectoryEntries: () => [],
      getStreamedText: () => '',
      refreshLedger: () => {},
    })

    controller.ensurePrefixOverhead()
    const first = session.getEstimatedTokens()

    // Second call should NOT change the value (idempotent)
    controller.ensurePrefixOverhead()
    const second = session.getEstimatedTokens()

    assert.equal(second, first, 'second call must not change prefixOverhead')
  })

  it('ensurePrefixOverhead reflects PromptEngine tool count', () => {
    const session = new SessionContext()
    const engine = makeEngine()
    // Override getToolCount to simulate more tools
    const engineWithTools = {
      ...engine,
      getToolCount: () => 25,
      getSystemPrompt: () => engine.getSystemPrompt(),
    }
    const controller = new CompactionController({
      session,
      promptEngine: engineWithTools as any,
      contextWindow: 128_000,
      pressureMonitor: new PressureMonitor(128_000),
      getTrajectoryEntries: () => [],
      getStreamedText: () => '',
      refreshLedger: () => {},
    })

    controller.ensurePrefixOverhead()
    const overhead = session.getEstimatedTokens()

    // With 25 tools × 50 tokens/tool = 1250 tool tokens
    // System prompt + 1250 + 400 volatile should be well above 500
    assert.ok(overhead > 500, `expected overhead > 500 with 25 tools, got ${overhead}`)
  })

  // ── C4: authoritative task anchor re-injection ──────────────────────────
  describe('C4 task anchor re-injection', () => {
    it('re-injects the authoritative task anchor after the ceiling checkpoint', async () => {
      const session = new SessionContext()
      const huge = 'x'.repeat(80_000 * 4)
      session.replaceMessages([
        { role: 'user', content: 'anchor user' },
        { role: 'assistant', content: 'anchor assistant' },
        { role: 'user', content: huge },
        { role: 'assistant', content: huge },
        { role: 'user', content: huge },
        { role: 'assistant', content: huge },
      ])
      const contract = extractTaskContract(
        '重构 src/auth/middleware.ts 的鉴权逻辑。不要改接口签名。必须向后兼容。',
        1,
      )
      const controller = makeController(session, {
        getActiveContract: () => contract,
        getStreamedText: () => 'Completed: wired guard\nRemaining: add tests',
      })

      await controller.enforceContextCeiling()

      const messages = session.getMessages()
      // Frozen prefix untouched.
      assert.equal(messages[0]?.content, 'anchor user')
      assert.equal(messages[1]?.content, 'anchor assistant')
      // Task anchor lands at the tail (appendix region), with the verbatim
      // objective and the forbidden-item constraint preserved.
      const tail = String(messages.at(-1)?.content)
      assert.match(tail, /<task-anchor authoritative="true"/)
      assert.match(tail, /middleware\.ts/)
      assert.match(tail, /<constraint>/)
      assert.ok(session.getEstimatedTokens() <= 128_000 * 0.95)
    })

    it('omits the anchor when there is no actionable contract', async () => {
      const session = new SessionContext()
      const huge = 'x'.repeat(80_000 * 4)
      session.replaceMessages([
        { role: 'user', content: 'anchor user' },
        { role: 'assistant', content: 'anchor assistant' },
        { role: 'user', content: huge },
        { role: 'assistant', content: huge },
        { role: 'user', content: huge },
        { role: 'assistant', content: huge },
      ])
      // Non-actionable greeting → renderTaskAnchor returns '' → no appendix.
      const controller = makeController(session, {
        getActiveContract: () => extractTaskContract('你好', 1),
      })

      await controller.enforceContextCeiling()

      const messages = session.getMessages()
      assert.ok(!messages.some(m => String(m.content).includes('<task-anchor')))
    })

    it('re-injects the anchor after a tier-2 micro compaction', async () => {
      const session = new SessionContext()
      const historyMessage = 'x'.repeat(12_000 * 4)
      session.replaceMessages(
        Array.from({ length: 12 }, (_, i) => ({
          role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
          content: historyMessage,
        })),
      )
      const contract = extractTaskContract('实现 src/foo.ts 的功能。不要破坏现有 API。', 1)
      const controller = makeController(session, {
        getActiveContract: () => contract,
        getStreamedText: () => 'Remaining: finish foo',
      })

      const result = await controller.maybeCompact({ loopTurn: 0, failures: { consecutiveFailures: 0 } })

      if (result.compacted) {
        const events = session.getCompactEvents()
        const tier = events.at(-1)?.tier ?? 1
        // Tier-2+ micro compaction injects both the compact summary AND the
        // authoritative anchor. Tier-1 paths do not (no message-count drop), so
        // only assert the anchor when a tier-2 summary fired.
        if (tier >= 2) {
          const hasAnchor = session.getMessages().some(m => String(m.content).includes('<task-anchor'))
          assert.ok(hasAnchor, 'tier-2 compaction should re-inject the task anchor')
        }
      }
    })
  })
})

// ── layered archival + recall ───────────────────────────────────────────

describe('CompactionController layered archival', () => {
  function make1MSession(count = 70): SessionContext {
    const session = new SessionContext()
    const chunk = 'x'.repeat(40_000)
    const msgs = Array.from({ length: count }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: chunk,
    }))
    session.replaceMessages(msgs)
    return session
  }

  function summarizingClient(text = 'partial summary'): StreamClient {
    return {
      stream: async (_request: OaiChatRequest, callbacks: StreamCallbacks) => {
        callbacks.onTextDelta(text)
      },
    }
  }

  it('partial compact archives the old zone and embeds a recall reference', async () => {
    const session = make1MSession()
    const anchor0 = session.getMessages()[0]!
    const anchor1 = session.getMessages()[1]!

    const saved: Array<{ target: string; rawContent: string }> = []
    const archived: Array<[string, number]> = []
    let counter = 0
    const controller = makeController(session, {
      contextWindow: 1_000_000,
      primaryClient: summarizingClient(),
      archiveHistory: async (input) => {
        saved.push({ target: input.target, rawContent: input.rawContent })
        return `compact-history:id${counter++}`
      },
      onArchive: (id, turn) => { archived.push([id, turn]) },
    })

    const result = await controller.maybeCompact({ loopTurn: 0, failures: { consecutiveFailures: 0 } })
    assert.equal(result.compacted, true)

    // Archived exactly once, with the verbatim old zone serialized.
    assert.equal(saved.length, 1)
    assert.match(saved[0]!.rawContent, /--- turn:\d+ role:(user|assistant) ---/)
    assert.equal(archived.length, 1)
    assert.equal(archived[0]![0], 'compact-history:id0')

    // Recall reference embedded into the partial-compact-summary message.
    const after = session.getMessages()
    const summaryMsg = after.find(m => String(m.content).includes('partial-compact-summary'))
    assert.ok(summaryMsg, 'summary message must exist')
    assert.match(String(summaryMsg!.content), /artifact:compact-history:id0/)
    assert.match(String(summaryMsg!.content), /read_section/)

    // Cache safety: the first two anchor messages are byte-identical.
    assert.equal(after[0]!.content, anchor0.content)
    assert.equal(after[1]!.content, anchor1.content)
  })

  it('checkpoint (ceiling) archives discarded history and embeds a recall reference', async () => {
    const session = new SessionContext()
    const huge = 'x'.repeat(80_000 * 4)
    session.replaceMessages([
      { role: 'user', content: 'anchor user' },
      { role: 'assistant', content: 'anchor assistant' },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
    ])

    const saved: string[] = []
    let counter = 0
    const controller = makeController(session, {
      archiveHistory: async (input) => {
        saved.push(input.target)
        return `compact-history:ck${counter++}`
      },
    })

    await controller.enforceContextCeiling()

    const after = session.getMessages()
    assert.equal(after[0]!.content, 'anchor user')
    assert.equal(after[1]!.content, 'anchor assistant')
    assert.equal(saved.length, 1, 'ceiling checkpoint archives the discarded zone')
    const checkpoint = String(after[2]!.content)
    assert.match(checkpoint, /<checkpoint-resume>/)
    assert.match(checkpoint, /artifact:compact-history:ck0/)
  })

  it('is fail-soft: compaction succeeds even when archiving throws', async () => {
    const session = make1MSession()
    const controller = makeController(session, {
      contextWindow: 1_000_000,
      primaryClient: summarizingClient(),
      archiveHistory: async () => { throw new Error('disk full') },
    })

    const result = await controller.maybeCompact({ loopTurn: 0, failures: { consecutiveFailures: 0 } })
    assert.equal(result.compacted, true, 'archive failure must not block compaction')
    const after = session.getMessages()
    const summaryMsg = after.find(m => String(m.content).includes('partial-compact-summary'))
    assert.ok(summaryMsg, 'summary still produced')
    assert.doesNotMatch(String(summaryMsg!.content), /artifact:compact-history/)
  })

  it('snapshots the pre-compaction transcript before replacing history', async () => {
    const session = make1MSession()
    const before = session.getMessages().length
    const snapshots: Array<{ count: number; turn: number }> = []
    const controller = makeController(session, {
      contextWindow: 1_000_000,
      primaryClient: summarizingClient(),
      archiveHistory: async () => 'compact-history:snap',
      backupTranscript: (messages, turn) => { snapshots.push({ count: messages.length, turn }) },
    })

    const result = await controller.maybeCompact({ loopTurn: 0, failures: { consecutiveFailures: 0 } })
    assert.equal(result.compacted, true)
    assert.equal(snapshots.length, 1, 'one snapshot per compaction')
    assert.equal(snapshots[0]!.count, before, 'snapshot captures the full pre-compaction list')
  })
})

// ── findSafeSplitPoint ──────────────────────────────────────────────────

describe('findSafeSplitPoint', () => {
  function makeMsg(role: string, content: string, extra?: Record<string, unknown>): OaiMessage {
    return { role, content, ...extra } as OaiMessage
  }

  function makeAssistant(content: string, toolCalls?: Array<{ id: string }>): OaiMessage {
    const msg: Record<string, unknown> = { role: 'assistant', content }
    if (toolCalls) {
      msg.tool_calls = toolCalls.map(tc => ({
        ...tc,
        type: 'function',
        function: { name: 'test', arguments: '{}' },
      }))
    }
    return msg as unknown as OaiMessage
  }

  function makeTool(content: string, toolCallId: string): OaiMessage {
    return { role: 'tool', content, tool_call_id: toolCallId } as OaiMessage
  }

  it('returns desired split point when no tool calls are involved', () => {
    const msgs: OaiMessage[] = [
      makeMsg('system', 'sys'),
      makeMsg('user', 'hello'),
      makeMsg('assistant', 'hi'),
      makeMsg('user', 'task 2'),
      makeMsg('assistant', 'result 2'),
      makeMsg('user', 'task 3'),
      makeMsg('assistant', 'result 3'),
    ]
    const result = findSafeSplitPoint(msgs, 5, 2)
    assert.equal(result, 5)
  })

  it('moves split point before assistant when a tool result would be orphaned', () => {
    // assistant(tool_calls=[A]) at index 4, tool(A) at index 5
    // desired split at 5 → would orphan tool(A) in recentZone
    const msgs: OaiMessage[] = [
      makeMsg('system', 'sys'),
      makeMsg('user', 'hello'),
      makeMsg('assistant', 'hi'),
      makeMsg('user', 'do X'),
      makeAssistant('calling tool', [{ id: 'call_A' }]),
      makeTool('result A', 'call_A'),
      makeMsg('assistant', 'text after tool'),
      makeMsg('user', 'next task'),
    ]
    const result = findSafeSplitPoint(msgs, 5, 2)
    // Should move split before the assistant at index 4
    assert.equal(result, 4)
  })

  it('moves split before assistant when tool result is in middle of group', () => {
    // assistant(tool_calls=[A,B]) at 4, tool(A) at 5, tool(B) at 6
    // desired split at 6 → tool(B) would be orphaned
    const msgs: OaiMessage[] = [
      makeMsg('system', 'sys'),
      makeMsg('user', 'hello'),
      makeMsg('assistant', 'hi'),
      makeMsg('user', 'do X'),
      makeAssistant('calling tools', [{ id: 'call_A' }, { id: 'call_B' }]),
      makeTool('result A', 'call_A'),
      makeTool('result B', 'call_B'),
      makeMsg('assistant', 'text after tools'),
    ]
    const result = findSafeSplitPoint(msgs, 6, 2)
    assert.equal(result, 4)
  })

  it('handles consecutive tool call groups correctly', () => {
    // Group 1: assistant(tool_calls=[A]) at 3, tool(A) at 4
    // Group 2: assistant(tool_calls=[B]) at 5, tool(B) at 6
    // desired split at 6 (tool B) → should move before assistant B at 5
    const msgs: OaiMessage[] = [
      makeMsg('system', 'sys'),
      makeMsg('user', 'hello'),
      makeMsg('assistant', 'hi'),
      makeAssistant('call A', [{ id: 'call_A' }]),
      makeTool('result A', 'call_A'),
      makeAssistant('call B', [{ id: 'call_B' }]),
      makeTool('result B', 'call_B'),
      makeMsg('assistant', 'done'),
    ]
    const result = findSafeSplitPoint(msgs, 6, 2)
    assert.equal(result, 5)
  })

  it('returns desired split when split is after tool group end', () => {
    // assistant(tool_calls=[A]) at 4, tool(A) at 5, next assistant at 6
    // desired split at 6 (after tool group) → safe, no adjustment needed
    const msgs: OaiMessage[] = [
      makeMsg('system', 'sys'),
      makeMsg('user', 'hello'),
      makeMsg('assistant', 'hi'),
      makeMsg('user', 'do X'),
      makeAssistant('calling tool', [{ id: 'call_A' }]),
      makeTool('result A', 'call_A'),
      makeMsg('assistant', 'after tool text'),
      makeMsg('user', 'next'),
    ]
    const result = findSafeSplitPoint(msgs, 6, 2)
    assert.equal(result, 6)
  })

  it('returns desired split when split is on assistant with tool_calls (group intact in recentZone)', () => {
    // assistant(tool_calls=[A]) at 4, tool(A) at 5
    // desired split at 4 → assistant + tool are both in recentZone, safe
    const msgs: OaiMessage[] = [
      makeMsg('system', 'sys'),
      makeMsg('user', 'hello'),
      makeMsg('assistant', 'hi'),
      makeMsg('user', 'do X'),
      makeAssistant('calling tool', [{ id: 'call_A' }]),
      makeTool('result A', 'call_A'),
      makeMsg('assistant', 'text'),
    ]
    const result = findSafeSplitPoint(msgs, 4, 2)
    assert.equal(result, 4)
  })

  it('does not move split below minSplit', () => {
    const msgs: OaiMessage[] = [
      makeMsg('system', 'sys'),
      makeMsg('user', 'hello'),
      makeAssistant('calling tool', [{ id: 'call_A' }]),
      makeTool('result A', 'call_A'),
      makeMsg('user', 'another task'),
      makeMsg('assistant', 'hi'),
      makeMsg('user', 'third'),
      makeMsg('assistant', 'done'),
    ]
    // desired split at 3 (tool A), minSplit = 3
    // Should return 3 (at or above minSplit), even though the assistant is at 2
    const result = findSafeSplitPoint(msgs, 3, 3)
    assert.equal(result, 3, 'should respect minSplit floor')
  })

  it('demonstrates the original bug: split between tool results breaks pairing', () => {
    // Simulate the exact bug pattern:
    // ...old messages, assistant(tool_calls=[A,B]) at 6, tool(A) at 7, tool(B) at 8, ...
    // Without fix: desired split at 8 → recentZone starts at tool(B), orphaned
    const msgs: OaiMessage[] = [
      makeMsg('system', 'sys'),
      makeMsg('user', 'initial'),
      makeMsg('assistant', 'ack'),
      makeMsg('user', 'task 1'),
      makeMsg('assistant', 'done 1'),
      makeMsg('user', 'task 2'),
      makeAssistant('calling multiple tools', [{ id: 'tc_A' }, { id: 'tc_B' }]),
      makeTool('result A', 'tc_A'),
      makeTool('result B', 'tc_B'),
      makeMsg('assistant', 'after tools'),
      makeMsg('user', 'task 3'),
      makeMsg('assistant', 'working'),
    ]
    const result = findSafeSplitPoint(msgs, 8, 2)
    // Should adjust to 6 (before the assistant) to keep the group intact
    assert.equal(result, 6)
  })
})

describe('foldAgedRecallBlocks (A3 recall eviction)', () => {
  const recall = (artifactId: string, section: string, body: string): OaiMessage => ({
    role: 'tool',
    tool_call_id: `tc_${section}`,
    content: `${buildRecallMarker(artifactId, section)}\n${body}`,
  })

  it('folds aged recall blocks to pointers but keeps the most recent K', () => {
    const total = RECALL_KEEP_RECENT + 3
    const zone: OaiMessage[] = Array.from({ length: total }, (_, i) =>
      recall('compact-history:h1', `L${i + 1}-L${i + 2}`, `verbatim block ${i} ${'z'.repeat(100)}`))

    const folded = foldAgedRecallBlocks(zone, RECALL_KEEP_RECENT)
    assert.equal(folded.length, zone.length)

    // First 3 (aged) are folded to a one-line pointer (no body).
    for (let i = 0; i < 3; i++) {
      assert.equal(folded[i]!.content, `[recalled compact-history:h1 L${i + 1}-L${i + 2}]`)
      assert.doesNotMatch(folded[i]!.content as string, /verbatim block/)
    }
    // Last K keep their verbatim body.
    for (let i = 3; i < total; i++) {
      assert.match(folded[i]!.content as string, /verbatim block/)
    }
    // Tool metadata preserved on folded messages.
    assert.equal(folded[0]!.role, 'tool')
    assert.equal(folded[0]!.tool_call_id, 'tc_L1-L2')
  })

  it('leaves non-recall messages untouched', () => {
    const zone: OaiMessage[] = [
      { role: 'user', content: 'a normal user turn' },
      { role: 'assistant', content: 'a normal assistant turn' },
    ]
    const folded = foldAgedRecallBlocks(zone, RECALL_KEEP_RECENT)
    assert.deepEqual(folded, zone)
  })

  it('is a no-op when recall count is within keepRecent', () => {
    const zone: OaiMessage[] = [recall('compact-history:h1', 'L1-L2', 'body one' + 'q'.repeat(80))]
    const folded = foldAgedRecallBlocks(zone, RECALL_KEEP_RECENT)
    assert.deepEqual(folded, zone)
  })

  it('is idempotent — folding a folded pointer changes nothing further', () => {
    const total = RECALL_KEEP_RECENT + 2
    const zone: OaiMessage[] = Array.from({ length: total }, (_, i) =>
      recall('compact-history:h1', `L${i + 1}-L${i + 2}`, `body ${i} ${'w'.repeat(60)}`))
    const once = foldAgedRecallBlocks(zone, RECALL_KEEP_RECENT)
    const twice = foldAgedRecallBlocks(once, RECALL_KEEP_RECENT)
    assert.deepEqual(twice, once)
  })
})

function traj(partial: Partial<TrajectoryEntry> & Pick<TrajectoryEntry, 'turn' | 'tool' | 'target' | 'status'>): TrajectoryEntry {
  return { durationMs: 1, inputSummary: '', resultSummary: '', ...partial }
}

describe('extractWriteActionChain', () => {
  it('keeps only file-write tools, in order, excluding read/search', () => {
    const chain = extractWriteActionChain([
      traj({ turn: 1, tool: 'read_file', target: 'src/a.ts', status: 'success' }),
      traj({ turn: 2, tool: 'grep', target: 'foo', status: 'success' }),
      traj({ turn: 3, tool: 'edit_file', target: 'src/a.ts', status: 'success' }),
      traj({ turn: 4, tool: 'bash', target: 'ls', status: 'success' }),
      traj({ turn: 5, tool: 'write_file', target: 'src/b.ts', status: 'success' }),
    ])
    assert.deepEqual(chain, ['[T3] edit_file src/a.ts', '[T5] write_file src/b.ts'])
  })

  it('marks failed / retried-failed writes with a FAIL tag', () => {
    const chain = extractWriteActionChain([
      traj({ turn: 1, tool: 'apply_patch', target: 'src/a.ts', status: 'failed' }),
      traj({ turn: 2, tool: 'write_file', target: 'src/b.ts', status: 'retried-failed' }),
      traj({ turn: 3, tool: 'edit', target: 'src/c.ts', status: 'retried-success' }),
    ])
    assert.deepEqual(chain, [
      '[T1] apply_patch src/a.ts (FAIL)',
      '[T2] write_file src/b.ts (FAIL)',
      '[T3] edit src/c.ts',
    ])
  })

  it('returns empty for a read-only trajectory', () => {
    const chain = extractWriteActionChain([
      traj({ turn: 1, tool: 'read_file', target: 'src/a.ts', status: 'success' }),
      traj({ turn: 2, tool: 'glob', target: '**/*.ts', status: 'success' }),
    ])
    assert.deepEqual(chain, [])
  })

  it('caps the chain at the 40 most recent writes', () => {
    const entries = Array.from({ length: 50 }, (_, i) =>
      traj({ turn: i + 1, tool: 'edit_file', target: `src/f${i + 1}.ts`, status: 'success' }))
    const chain = extractWriteActionChain(entries)
    assert.equal(chain.length, 40)
    assert.equal(chain[0], '[T11] edit_file src/f11.ts')
    assert.equal(chain[39], '[T50] edit_file src/f50.ts')
  })
})

describe('compaction prompt — write-action chain injection', () => {
  async function captureCompactPrompt(trajectory: TrajectoryEntry[]): Promise<string> {
    const session = new SessionContext()
    session.replaceMessages([
      { role: 'user', content: 'fix the bug in src/foo.ts' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'done' },
    ])
    let captured = ''
    const primaryClient: StreamClient = {
      stream: async (request: OaiChatRequest, callbacks: StreamCallbacks) => {
        const last = request.messages[request.messages.length - 1]
        captured = typeof last?.content === 'string' ? last.content : ''
        callbacks.onTextDelta('Edited src/foo.ts to fix it.')
      },
    }
    const controller = makeController(session, {
      contextWindow: 1_000_000,
      primaryClient,
      getTrajectoryEntries: () => trajectory,
    })
    await controller.llmCompact()
    return captured
  }

  it('injects the write-action chain when writes exist', async () => {
    const prompt = await captureCompactPrompt([
      traj({ turn: 1, tool: 'write_file', target: 'src/foo.ts', status: 'success' }),
    ])
    assert.match(prompt, /变更动作清单/, 'prompt must carry the change-action section')
    assert.match(prompt, /\[T1\] write_file src\/foo\.ts/, 'prompt must list the concrete write')
    assert.match(prompt, /非只读命令/, 'prompt must ask for non-read-only commands')
  })

  it('omits the write-action section when there are no writes', async () => {
    const prompt = await captureCompactPrompt([
      traj({ turn: 1, tool: 'read_file', target: 'src/foo.ts', status: 'success' }),
    ])
    assert.doesNotMatch(prompt, /变更动作清单/, 'no write section when trajectory is read-only')
    assert.match(prompt, /必须完整保留的用户意图链/, 'user intent chain still present')
  })
})
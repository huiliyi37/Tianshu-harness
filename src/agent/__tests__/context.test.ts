import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SessionContext } from '../context.js'
import type { OaiMessage } from '../../api/oai-types.js'
import { isToolMessage } from '../../api/oai-types.js'

describe('SessionContext bounded collections', () => {
  it('evicts oldest filesRead when cap exceeded', () => {
    const ctx = new SessionContext()
    for (let i = 0; i < 502; i++) {
      ctx.trackFileRead(`file-${i}.ts`)
    }
    const files = ctx.getFilesRead()
    assert.ok(files.length <= 500, `expected <= 500, got ${files.length}`)
    assert.ok(files.includes('file-501.ts'), 'should keep newest')
    assert.ok(!files.includes('file-0.ts'), 'should evict oldest')
  })

  it('evicts oldest filesModified when cap exceeded', () => {
    const ctx = new SessionContext()
    for (let i = 0; i < 502; i++) {
      ctx.trackFileModified(`mod-${i}.ts`)
    }
    const files = ctx.getFilesModified()
    assert.ok(files.length <= 500, `expected <= 500, got ${files.length}`)
  })

  it('evicts oldest testResults when cap exceeded', () => {
    const ctx = new SessionContext()
    for (let i = 0; i < 502; i++) {
      ctx.trackTestResult(i, 0)
    }
    const results = ctx.getTestResults()
    assert.ok(results.length <= 500, `expected <= 500, got ${results.length}`)
    assert.equal(results[results.length - 1]!.passed, 501)
  })

  it('evicts oldest turnCacheHistory when cap exceeded', () => {
    const ctx = new SessionContext()
    for (let i = 0; i < 502; i++) {
      ctx.recordTurnCache(i, {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 20,
      })
    }
    const history = ctx.getCacheHistory()
    assert.ok(history.length <= 500, `expected <= 500, got ${history.length}`)
    assert.equal(history[history.length - 1]!.turn, 501)
  })
})

describe('SessionContext OpenAI-native message storage', () => {
  it('stores user messages as OAI messages while exposing legacy view', () => {
    const ctx = new SessionContext()
    ctx.addUserMessage('Hello')

    assert.deepEqual(ctx.getMessages(), [
      { role: 'user', content: 'Hello' },
    ])
  })

  it('converts assistant content blocks to a single OAI assistant message', () => {
    const ctx = new SessionContext()
    ctx.addAssistantBlocks([
      { type: 'thinking', thinking: 'Need to inspect.' },
      { type: 'text', text: 'I will inspect.' },
      { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { file_path: 'src/main.tsx' } },
    ])

    assert.deepEqual(ctx.getMessages(), [
      {
        role: 'assistant',
        content: 'I will inspect.',
        reasoning_content: 'Need to inspect.',
        tool_calls: [
          {
            id: 'tu_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"file_path":"src/main.tsx"}' },
          },
        ],
      },
    ])
  })

  it('converts legacy tool_result blocks to OAI tool messages', () => {
    const ctx = new SessionContext()
    ctx.addToolResults([
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' },
      { type: 'tool_result', tool_use_id: 'tu_2', content: 'failed', is_error: true },
    ])

    assert.deepEqual(ctx.getMessages(), [
      { role: 'tool', tool_call_id: 'tu_1', content: 'ok' },
      { role: 'tool', tool_call_id: 'tu_2', content: 'failed' },
    ])
  })

  it('stores and retrieves OAI messages directly', () => {
    const ctx = new SessionContext()
    const messages: OaiMessage[] = [
      { role: 'user', content: 'Start' },
      {
        role: 'assistant',
        content: 'Reading.',
        tool_calls: [
          {
            id: 'tu_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"file_path":"README.md"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'tu_1', content: 'contents' },
    ]

    ctx.replaceMessages(messages)

    assert.deepEqual(ctx.getMessages(), messages)
  })
})


it('getLatestTurnHitRate returns null with no turn cache snapshots', () => {
  const ctx = new SessionContext()
  assert.equal(ctx.getLatestTurnHitRate(), null)
})

it('getLatestTurnHitRate returns 0 when latest turn has no cache hit (but has input)', () => {
  const ctx = new SessionContext()
  ctx.recordTurnCache(1, {
    input_tokens: 100,
    output_tokens: 10,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  })

  // inputTokens > 0 → 0% hit rate, not "no data"
  assert.equal(ctx.getLatestTurnHitRate(), 0)
})

it('getLatestTurnHitRate returns latest turn cache read ratio', () => {
  const ctx = new SessionContext()
  ctx.recordTurnCache(1, {
    input_tokens: 100,
    output_tokens: 10,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 80,
  })
  ctx.recordTurnCache(2, {
    input_tokens: 100,
    output_tokens: 10,
    cache_read_input_tokens: 75,
    cache_creation_input_tokens: 25,
  })

  // New formula: cacheRead / inputTokens = 75 / 100 = 0.75
  assert.equal(ctx.getLatestTurnHitRate(), 0.75)
})

describe('getRecentTurnHitRate', () => {
  it('returns null with no turn cache snapshots', () => {
    const ctx = new SessionContext()
    assert.equal(ctx.getRecentTurnHitRate(3), null)
  })

  it('returns average over available turns when fewer than requested', () => {
    const ctx = new SessionContext()
    ctx.recordTurnCache(1, {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 20,
    })
    // New formula: cacheRead / inputTokens = 80 / 100 = 0.8
    assert.equal(ctx.getRecentTurnHitRate(3), 0.8)
  })

  it('returns average over last N turns', () => {
    const ctx = new SessionContext()
    ctx.recordTurnCache(1, {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 90,
      cache_creation_input_tokens: 10,
    })
    ctx.recordTurnCache(2, {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 70,
    })
    ctx.recordTurnCache(3, {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 60,
      cache_creation_input_tokens: 40,
    })
    // Last 2 turns aggregated: (30+60) / (100+100) = 90/200 = 0.45
    assert.equal(ctx.getRecentTurnHitRate(2), 0.45)
  })

  it('returns 0 when all turns have zero cache hit but have input tokens', () => {
    const ctx = new SessionContext()
    ctx.recordTurnCache(1, {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })
    // inputTokens > 0 → 0% hit rate, not null
    assert.equal(ctx.getRecentTurnHitRate(3), 0)
  })
})

describe('SessionContext mutation listener', () => {
  it('emits append on addUserMessage', () => {
    const ctx = new SessionContext()
    const events: Array<{ type: string; role?: string; len?: number }> = []
    ctx.setMutationListener(m => {
      if (m.type === 'append') events.push({ type: 'append', role: m.message.role })
      else events.push({ type: 'replace', len: m.messages.length })
    })

    ctx.addUserMessage('hello')
    assert.deepEqual(events, [{ type: 'append', role: 'user' }])
  })

  it('emits append on addAssistantBlocks (text only)', () => {
    const ctx = new SessionContext()
    const seen: OaiMessage[] = []
    ctx.setMutationListener(m => {
      if (m.type === 'append') seen.push(m.message)
    })

    ctx.addAssistantBlocks([{ type: 'text', text: 'hi there' }])
    assert.equal(seen.length, 1)
    assert.equal(seen[0]!.role, 'assistant')
    assert.equal(seen[0]!.content, 'hi there')
  })

  it('emits append on addAssistantBlocks (tool_use)', () => {
    const ctx = new SessionContext()
    const seen: OaiMessage[] = []
    ctx.setMutationListener(m => {
      if (m.type === 'append') seen.push(m.message)
    })

    ctx.addAssistantBlocks([
      { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
    ])
    assert.equal(seen.length, 1)
    assert.equal(seen[0]!.role, 'assistant')
    assert.ok(seen[0]!.tool_calls)
    assert.equal(seen[0]!.tool_calls!.length, 1)
    assert.equal(seen[0]!.tool_calls![0]!.id, 'call_1')
  })

  it('emits one append per tool_result in addToolResults', () => {
    const ctx = new SessionContext()
    const seen: OaiMessage[] = []
    ctx.setMutationListener(m => {
      if (m.type === 'append') seen.push(m.message)
    })

    ctx.addToolResults([
      { type: 'tool_result', tool_use_id: 'call_1', content: 'a-content' },
      { type: 'tool_result', tool_use_id: 'call_2', content: 'b-content' },
    ])
    assert.equal(seen.length, 2)
    const first = seen[0]!
    const second = seen[1]!
    assert.ok(isToolMessage(first), 'first should be tool message')
    assert.ok(isToolMessage(second), 'second should be tool message')
    assert.equal(first.tool_call_id, 'call_1')
    assert.equal(second.tool_call_id, 'call_2')
    assert.equal(first.content, 'a-content')
  })

  it('emits replace on replaceMessages', () => {
    const ctx = new SessionContext()
    const events: Array<{ type: string; len?: number }> = []
    ctx.setMutationListener(m => {
      if (m.type === 'replace') events.push({ type: 'replace', len: m.messages.length })
      else events.push({ type: 'append' })
    })

    const msgs: OaiMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]
    ctx.replaceMessages(msgs)
    assert.deepEqual(events, [{ type: 'replace', len: 2 }])
  })

  it('replace event snapshots the array (no aliasing with future mutations)', () => {
    // Regression guard: a listener that defers work (e.g. async disk write)
    // must see the messages as-they-were when replace fired, not include
    // anything pushed afterward.
    const ctx = new SessionContext()
    let captured: OaiMessage[] | null = null
    ctx.setMutationListener(m => {
      if (m.type === 'replace') captured = m.messages
    })

    ctx.replaceMessages([{ role: 'user', content: 'compacted' }])
    // After replace, push something else; the captured array must not grow.
    ctx.addAssistantBlocks([{ type: 'text', text: 'next' }])

    if (!captured) {
      assert.fail('replace event should have fired')
    }
    const cap: OaiMessage[] = captured
    assert.equal(cap.length, 1)
    const first = cap[0]!
    assert.equal(first.role, 'user')
    assert.equal(first.content, 'compacted')
  })

  it('does not invoke listener before subscription', () => {
    const ctx = new SessionContext()
    ctx.addUserMessage('before-subscribe') // should not throw, no listener yet

    let called = false
    ctx.setMutationListener(() => { called = true })
    assert.equal(called, false)

    ctx.addUserMessage('after-subscribe')
    assert.equal(called, true)
  })

  it('listener exception in one event does not block subsequent events', () => {
    // The listener is sync so a thrown exception will propagate. The contract:
    // once a listener throws, the caller (AgentLoop) is responsible for catching.
    // This test documents the synchronous behavior so callers know to wrap.
    const ctx = new SessionContext()
    let throws = true
    ctx.setMutationListener(() => {
      if (throws) {
        throws = false
        throw new Error('listener error')
      }
    })

    assert.throws(() => ctx.addUserMessage('first'), /listener error/)
    // Second call: listener no longer throws.
    assert.doesNotThrow(() => ctx.addUserMessage('second'))
  })
})

describe('SessionContext removeLastMessage', () => {
  it('removes the last user message and decrements turnCount', () => {
    const ctx = new SessionContext()
    ctx.addUserMessage('hello')
    assert.equal(ctx.getTurnCount(), 1)
    assert.equal(ctx.getMessages().length, 1)

    const removed = ctx.removeLastMessage()
    assert.equal(removed!.role, 'user')
    assert.equal((removed as any).content, 'hello')
    assert.equal(ctx.getMessages().length, 0)
    assert.equal(ctx.getTurnCount(), 0)
  })

  it('throws when top message is assistant (not user)', () => {
    const ctx = new SessionContext()
    ctx.addUserMessage('hello')
    ctx.addAssistantBlocks([{ type: 'text', text: 'world' }])
    assert.equal(ctx.getTurnCount(), 1)
    assert.equal(ctx.getMessages().length, 2)

    assert.throws(
      () => ctx.removeLastMessage(),
      /removeLastMessage: expected user message but top was assistant/,
    )
    // State must be restored — assistant message should still be on the stack
    assert.equal(ctx.getMessages().length, 2)
    assert.equal(ctx.getMessages()[1]!.role, 'assistant')
  })

  it('returns undefined when session is empty', () => {
    const ctx = new SessionContext()
    assert.equal(ctx.removeLastMessage(), undefined)
  })

  it('decrements estimatedTokens', () => {
    const ctx = new SessionContext()
    const before = ctx.getEstimatedTokens()
    ctx.addUserMessage('hello world')
    const after = ctx.getEstimatedTokens()
    assert.ok(after > before, 'tokens should increase after addUserMessage')

    ctx.removeLastMessage()
    assert.equal(ctx.getEstimatedTokens(), before, 'tokens should return to baseline after removeLastMessage')
  })

  it('throws when attempting to rollback tool or assistant messages', () => {
    const ctx = new SessionContext()
    ctx.addUserMessage('do stuff')
    ctx.addAssistantBlocks([
      { type: 'tool_use', id: 'c1', name: 'bash', input: { command: 'ls' } },
    ])
    ctx.addToolResults([{ type: 'tool_result', tool_use_id: 'c1', content: 'file.ts' }])

    assert.equal(ctx.getMessages().length, 3)

    // Tool message is on top — removeLastMessage must throw
    assert.throws(
      () => ctx.removeLastMessage(),
      /removeLastMessage: expected user message but top was tool/,
    )
    // State unchanged after throw
    assert.equal(ctx.getMessages().length, 3)
    assert.equal(ctx.getTurnCount(), 1)
  })

  it('rollbacks a lone user message after failed turn (no assistant response)', () => {
    const ctx = new SessionContext()
    ctx.addUserMessage('do stuff')
    // Simulate: turn was aborted before assistant responded
    // (in production, loop.ts guarantees this via !assistantResponded)
    assert.equal(ctx.getMessages().length, 1)
    assert.equal(ctx.getTurnCount(), 1)

    const removed = ctx.removeLastMessage()
    assert.equal(removed!.role, 'user')
    assert.equal(ctx.getMessages().length, 0)
    assert.equal(ctx.getTurnCount(), 0)
  })

  it('emits replace mutation on user message removal', () => {
    const ctx = new SessionContext()
    const events: Array<{ type: string; messages?: OaiMessage[] }> = []
    ctx.setMutationListener(m => {
      if (m.type === 'replace') events.push({ type: 'replace', messages: m.messages.slice() })
      else events.push({ type: 'append' })
    })

    ctx.addUserMessage('hello')
    assert.deepEqual(events, [
      { type: 'append' },
    ])

    // Remove the user message — should emit replace with empty array
    events.length = 0
    const removed = ctx.removeLastMessage()
    assert.equal(removed!.role, 'user')
    assert.equal(events.length, 1)
    assert.equal(events[0]!.type, 'replace')
    assert.equal(events[0]!.messages!.length, 0)
  })

  it('does not emit mutation when session is empty (nothing to remove)', () => {
    const ctx = new SessionContext()
    let called = false
    ctx.setMutationListener(() => { called = true })

    const result = ctx.removeLastMessage()
    assert.equal(result, undefined)
    assert.equal(called, false, 'should not emit mutation when nothing was removed')
  })

  it('does not emit mutation and restores state when guard throws', () => {
    const ctx = new SessionContext()
    ctx.addUserMessage('hello')
    ctx.addAssistantBlocks([{ type: 'text', text: 'world' }])

    let mutationFired = false
    ctx.setMutationListener(() => { mutationFired = true })

    assert.throws(
      () => ctx.removeLastMessage(),
      /removeLastMessage: expected user message but top was assistant/,
    )
    assert.equal(mutationFired, false, 'no mutation when guard throws')
    assert.equal(ctx.getMessages().length, 2, 'state fully restored')
    assert.equal(ctx.getEstimatedTokens() > 0, true, 'tokens not corrupted')
  })
})

describe('SessionContext lastRealPromptTokens', () => {
  it('initializes lastRealPromptTokens to 0', () => {
    const ctx = new SessionContext()
    assert.equal(ctx.getLastRealPromptTokens(), 0)
  })

  it('addUsage captures input_tokens as lastRealPromptTokens', () => {
    const ctx = new SessionContext()
    ctx.addUsage({ input_tokens: 50_000 })
    assert.equal(ctx.getLastRealPromptTokens(), 50_000)
  })

  it('addUsage overwrites lastRealPromptTokens on each call', () => {
    const ctx = new SessionContext()
    ctx.addUsage({ input_tokens: 50_000 })
    ctx.addUsage({ input_tokens: 80_000 })
    assert.equal(ctx.getLastRealPromptTokens(), 80_000)
  })

  it('addUsage without input_tokens does not overwrite lastRealPromptTokens', () => {
    const ctx = new SessionContext()
    ctx.addUsage({ input_tokens: 50_000 })
    ctx.addUsage({ output_tokens: 1_000 })
    assert.equal(ctx.getLastRealPromptTokens(), 50_000)
  })
})

describe('SessionContext addSidePathUsage (2026-07-06 cost blind spot fix)', () => {
  it('accumulates into session totals like a billed request', () => {
    const ctx = new SessionContext()
    ctx.addUsage({ input_tokens: 50_000, output_tokens: 200, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 100 })
    ctx.addSidePathUsage({ input_tokens: 95_000, output_tokens: 320, cache_read_input_tokens: 94_000, cache_creation_input_tokens: 500 })

    const total = ctx.getTotalUsage()
    assert.equal(total.input_tokens, 145_000)
    assert.equal(total.output_tokens, 520)
    assert.equal(total.cache_read_input_tokens, 134_000)
    assert.equal(total.cache_creation_input_tokens, 600)
  })

  it('does NOT touch occupancy anchors (lastRealPromptTokens / tail / calibration)', () => {
    const ctx = new SessionContext()
    ctx.addUserMessage('hello')
    ctx.addUsage({ input_tokens: 50_000 })
    const occupancyBefore = ctx.getRealOccupancy()

    // A side-path request measures a DIFFERENT message array — booking it
    // through addUsage would clobber the main conversation's anchor.
    ctx.addSidePathUsage({ input_tokens: 95_000, output_tokens: 320 })

    assert.equal(ctx.getLastRealPromptTokens(), 50_000, 'anchor must not move')
    assert.equal(ctx.getRealOccupancy(), occupancyBefore, 'occupancy must not move')
  })
})

describe('SessionContext getRealOccupancy', () => {
  it('falls back to getEstimatedTokens before the first API response', () => {
    const ctx = new SessionContext()
    ctx.addUserMessage('hello world')
    assert.equal(ctx.getLastRealPromptTokens(), 0)
    assert.equal(ctx.getRealOccupancy(), ctx.getEstimatedTokens())
  })

  it('anchors on lastRealPromptTokens once the API has responded (no tail yet)', () => {
    const ctx = new SessionContext()
    ctx.addUserMessage('hello')
    ctx.addUsage({ input_tokens: 50_000 })
    // Right after the response, the tail is empty → occupancy == anchor.
    assert.equal(ctx.getRealOccupancy(), 50_000)
  })

  it('adds the estimated tail (messages appended since the last response)', () => {
    const ctx = new SessionContext()
    ctx.addUserMessage('hello')
    ctx.addUsage({ input_tokens: 50_000 })
    ctx.addAssistantBlocks([{ type: 'text', text: 'a reply that adds some tail tokens' }])
    ctx.addToolResults([{ type: 'tool_result', tool_use_id: 't1', content: 'tool output here' }])
    const occ = ctx.getRealOccupancy()
    assert.ok(occ > 50_000, `expected tail to lift occupancy above the anchor, got ${occ}`)
    // The lift equals exactly the estimate of the appended tail messages.
    assert.equal(occ - 50_000 > 0, true)
  })

  it('resets the tail on the next API response (anchor re-captures everything sent)', () => {
    const ctx = new SessionContext()
    ctx.addUserMessage('hello')
    ctx.addUsage({ input_tokens: 50_000 })
    ctx.addAssistantBlocks([{ type: 'text', text: 'reply' }])
    ctx.addToolResults([{ type: 'tool_result', tool_use_id: 't1', content: 'output' }])
    assert.ok(ctx.getRealOccupancy() > 50_000)
    // Next request sends the grown history; the API reports the true total.
    ctx.addUsage({ input_tokens: 53_000 })
    assert.equal(ctx.getRealOccupancy(), 53_000, 'tail must reset to 0 on the new anchor')
  })

  it('output-only addUsage (abort path) does not reset the tail', () => {
    const ctx = new SessionContext()
    ctx.addUserMessage('hello')
    ctx.addUsage({ input_tokens: 50_000 })
    ctx.addAssistantBlocks([{ type: 'text', text: 'partial reply' }])
    const withTail = ctx.getRealOccupancy()
    ctx.addUsage({ output_tokens: 200 })
    assert.equal(ctx.getRealOccupancy(), withTail, 'abort usage must not collapse the tail')
  })

  it('invalidates the anchor after compaction (replaceMessages) → falls back to local estimate', () => {
    const ctx = new SessionContext()
    ctx.addUserMessage('hello')
    ctx.addUsage({ input_tokens: 500_000 })
    // Compaction rebuilds a much smaller history.
    ctx.replaceMessages([{ role: 'user', content: 'compacted summary' }])
    assert.equal(ctx.getLastRealPromptTokens(), 0, 'anchor invalidated by compaction')
    // Occupancy now reflects the small compacted list, not the stale 500k anchor.
    assert.equal(ctx.getRealOccupancy(), ctx.getEstimatedTokens())
    assert.ok(ctx.getRealOccupancy() < 500_000, 'must not over-report the pre-compaction prompt')
  })

  it('removeLastMessage (abort rollback) decrements the tail', () => {
    const ctx = new SessionContext()
    ctx.addUserMessage('first')
    ctx.addUsage({ input_tokens: 10_000 })
    const anchorOnly = ctx.getRealOccupancy()
    ctx.addUserMessage('a rolled-back user message')
    assert.ok(ctx.getRealOccupancy() > anchorOnly)
    ctx.removeLastMessage()
    assert.equal(ctx.getRealOccupancy(), anchorOnly, 'tail must return to baseline after rollback')
  })
})

describe('SessionContext contextCalibrationRatio', () => {
  it('calibrates getEstimatedTokens after addUsage', () => {
    const ctx = new SessionContext()
    ctx.setPrefixOverhead(10_000)
    ctx.addUserMessage('hello world')
    const before = ctx.getEstimatedTokens()
    assert.ok(before > 0, 'local estimate should be positive')

    // API reports 2.5x local — within clamp, first EMA 0.7*2.5 + 0.3*1 = 2.05
    ctx.addUsage({ input_tokens: Math.round(before * 2.5) })
    const ratio = ctx.getEstimatedTokens() / before
    assert.ok(Math.abs(ratio - 2.05) < 0.01, `first EMA ratio should be ~2.05, got ${ratio}`)
  })

  it('applies EMA smoothing across calibrations', () => {
    const ctx = new SessionContext()
    ctx.setPrefixOverhead(10_000)
    ctx.addUserMessage('hello world')
    const before = ctx.getEstimatedTokens()

    ctx.addUsage({ input_tokens: before * 4 })
    let ratio = ctx.getEstimatedTokens() / before
    assert.ok(Math.abs(ratio - 3.1) < 0.01, `after 4x: ratio should be ~3.1, got ${ratio}`)

    ctx.addUsage({ input_tokens: before * 2 })
    ratio = ctx.getEstimatedTokens() / before
    assert.ok(Math.abs(ratio - 2.33) < 0.01, `after 2x: EMA 0.7*2 + 0.3*3.1 = 2.33, got ${ratio}`)
  })

  it('does not calibrate when local estimate is zero', () => {
    const ctx = new SessionContext()
    ctx.addUsage({ input_tokens: 10_000 })
    assert.equal(ctx.getEstimatedTokens(), 0)
  })

  // P1: defer calibration when local estimate can't explain even 10% of the
  // API report. This happens when prefixOverhead hasn't been set yet (first
  // turn before ensurePrefixOverhead runs in maybeCompact). Without this
  // guard, the ratio gets poisoned by a tiny denominator and GlanceBar explodes.
  it('defers calibration when local estimate is far below API report', () => {
    const ctx = new SessionContext()
    ctx.setPrefixOverhead(0)
    ctx.addUserMessage('hi')
    const before = ctx.getEstimatedTokens()
    // API reports 30K — local estimate is ~1, defer should kick in
    ctx.addUsage({ input_tokens: 30_000 })
    assert.equal(ctx.getEstimatedTokens(), before, 'calibration must defer when local estimate is unreliable')
  })

  // P2: clamp the raw ratio so a single outlier response can't poison EMA.
  // Tokenization differences across providers are typically within 2x; 0.5x–5x
  // is a generous envelope that still rejects pathological inputs.
  it('clamps raw calibration ratio to [0.5, 5] before EMA', () => {
    const ctx = new SessionContext()
    ctx.setPrefixOverhead(10_000)
    ctx.addUserMessage('hello world')
    const before = ctx.getEstimatedTokens()

    // Step 1: 2x within clamp — EMA 0.7*2 + 0.3*1 = 1.7
    ctx.addUsage({ input_tokens: before * 2 })
    let ratio = ctx.getEstimatedTokens() / before
    assert.ok(Math.abs(ratio - 1.7) < 0.01, `step1 2x should pass through to 1.7, got ${ratio}`)

    // Step 2: 10x clamped to 5 — EMA 0.7*5 + 0.3*1.7 = 4.01
    ctx.addUsage({ input_tokens: before * 10 })
    ratio = ctx.getEstimatedTokens() / before
    assert.ok(Math.abs(ratio - 4.01) < 0.01, `step2 10x should clamp to 5, then EMA to 4.01, got ${ratio}`)

    // Step 3: 0.1x clamped to 0.5 — EMA 0.7*0.5 + 0.3*4.01 = 1.553
    ctx.addUsage({ input_tokens: Math.round(before * 0.1) })
    ratio = ctx.getEstimatedTokens() / before
    assert.ok(Math.abs(ratio - 1.553) < 0.01, `step3 0.1x should clamp to 0.5, then EMA to 1.553, got ${ratio}`)
  })
})

describe('assistant transport sanitize (JSON body guard)', () => {
  // 上游按字节截断 body 时，切进一个 `\uXXXX` 转义就是那条
  // "unexpected end of hex escape" 400。assistant 侧的正文/reasoning/工具参数
  // 此前完全没洗过——模型复刻终端输出（ESC）或粘贴二进制即可把 `\u00XX` 送上网。
  it('strips C0 control chars from assistant text and reasoning', () => {
    const ctx = new SessionContext()
    ctx.addAssistantBlocks([
      { type: 'text', text: 'before\u001bafter' },
      { type: 'thinking', thinking: 'think\u0007ing' },
    ])
    const msg = ctx.getMessages()[0]!
    assert.equal(msg.content, 'before after')
    assert.equal((msg as { reasoning_content?: string }).reasoning_content, 'think ing')
  })

  it('tool_call arguments need no sanitize: JSON escaping already defuses them', () => {
    // 这不是"忘了洗"，是有意的：stableStringify 把 ESC 转义成 `\u001b`（6 个字符），
    // 外层 JSON.stringify 再把反斜杠双写。上层字节截断切进去只会得到未闭合字符串，
    // 不会触发 "unexpected end of hex escape"——所以参数保持原样（也少一次全量扫描）。
    const ctx = new SessionContext()
    ctx.addAssistantBlocks([
      { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'ls \u001b[31mred\u001b[0m' } },
    ])
    const msg = ctx.getMessages()[0] as { tool_calls?: { function: { arguments: string } }[] }
    const args = msg.tool_calls?.[0]?.function.arguments ?? ''
    assert.ok(args.includes('ls '), '正常内容保留')
    assert.ok(args.includes('\\u001b'), `控制字符必须以转义形态存在：${args}`)
    // 外层序列化后是双反斜杠（`\\u001b`）——截断它不会产生 hex-escape 错误
    assert.ok(JSON.stringify(args).includes('\\\\u001b'), '外层 stringify 必须双写反斜杠')
  })

  it('leaves clean text byte-identical (prefix cache must not shift)', () => {
    const ctx = new SessionContext()
    ctx.addAssistantBlocks([{ type: 'text', text: 'plain ascii + 中文 + emoji 😀' }])
    assert.equal(ctx.getMessages()[0]!.content, 'plain ascii + 中文 + emoji 😀')
  })
})

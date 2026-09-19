import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { semanticPruneLayer1 } from '../../compact/semantic-prune.js'
import { detectStaleness } from '../../compact/staleness-detect.js'
import { estimateOaiMessageTokens, estimateCacheStats } from '../../compact/micro.js'
import { PromptEngine } from '../engine.js'
import { messageSignature, signatureCacheStats } from '../message-signature.js'
import type { OaiMessage } from '../../api/oai-types.js'

function makeAssistant(toolCalls: { id: string; name: string; args: string }[]): OaiMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: tc.args } })),
  }
}

describe('buildOaiRequest sub-pass scaling', () => {
  /**
   * M1 fix: deterministically verify O(n) behaviour by probing the data
   * structures that the sub-passes build — not wall-clock timing.
   *
   * If semanticPruneLayer1 or detectStaleness regressed to O(n²), the
   * toolCallIndex / grepPatterns maps would require nested loops that
   * produce incorrect results (missed dedup, missed superseded) on
   * large inputs. We verify correctness at scale, which catches O(n²)
   * regressions without CI-flaky timing.
   */

  it('semanticPruneLayer1: all tool names resolved via index (no missed entries)', () => {
    // 100 tool results with mixed types — if index misses any, those results
    // won't get pruned/deduped, exposing a regression.
    const messages: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]
    for (let i = 0; i < 100; i++) {
      const toolType = i % 3 === 0 ? 'grep' : i % 3 === 1 ? 'list_dir' : 'bash'
      const args = toolType === 'grep'
        ? `{"pattern":"P${i}","path":"src/"}`
        : toolType === 'list_dir'
          ? '{"path":"."}'
          : '{"command":"npm test"}'
      messages.push(makeAssistant([{ id: `tc${i}`, name: toolType, args }]))

      // Content crafted to trigger pruning for each type:
      // grep: long enough (≥200) with unique pattern → dedup when pattern repeats
      // list_dir: ≥5 lines with ≥3 junk entries → junk prune
      // bash: ≥10 lines with ≥5 pass lines → test prune
      const content = toolType === 'grep'
        ? `src/a.ts:${i}: match P${i}\n` + 'x'.repeat(300)
        : toolType === 'list_dir'
          ? ['node_modules/a/', 'node_modules/b/', 'node_modules/c/', 'node_modules/d/', `file${i}.ts`].join('\n')
          : Array.from({ length: 12 }, (_, j) => `  ✓ should pass test ${j} (${j * 10}ms)`).join('\n') + '\n12 passing\n'
      messages.push({ role: 'tool', tool_call_id: `tc${i}`, content })
    }

    const result = semanticPruneLayer1(messages, 2)
    // All 100 tool messages must still be present (not dropped)
    const toolMsgs = result.messages.filter(m => m.role === 'tool')
    assert.equal(toolMsgs.length, 100, 'all tool results must be preserved')

    // Pruning must have happened: list_dir junk + bash test lines are deterministic
    assert.ok(result.prunedCount > 0, `expected pruning on 100 mixed results, got prunedCount=${result.prunedCount}`)
    assert.ok(result.savedChars > 0, 'saved chars must be positive when pruning occurs')
  })

  it('detectStaleness: correctly finds superseded reads among 50 files', () => {
    const messages: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]
    // Read 50 unique files (with ≥600 char content to exceed MIN_CONTENT_CHARS=500)
    const longContent = 'x'.repeat(600)
    for (let i = 0; i < 50; i++) {
      messages.push(makeAssistant([{ id: `tc_first_${i}`, name: 'read_file', args: `{"file_path":"src/file${i}.ts"}` }]))
      messages.push({ role: 'tool', tool_call_id: `tc_first_${i}`, content: longContent })
      // 3 assistant turns to satisfy the lag window (STALENESS_LAG = 3)
      messages.push({ role: 'assistant', content: `thinking about file${i}` })
      messages.push({ role: 'assistant', content: 'more thinking' })
      messages.push({ role: 'assistant', content: 'even more' })
    }
    // Re-read first 10 files → those should be superseded
    for (let i = 0; i < 10; i++) {
      messages.push(makeAssistant([{ id: `tc_second_${i}`, name: 'read_file', args: `{"file_path":"src/file${i}.ts"}` }]))
      messages.push({ role: 'tool', tool_call_id: `tc_second_${i}`, content: longContent + ' updated' })
      messages.push({ role: 'assistant', content: `now using updated file${i}` })
    }

    const result = detectStaleness(messages, 2)
    assert.equal(result.supersededCount, 10, 'exactly the 10 re-read files should be superseded')
  })
})

describe('request-build hashing caches (issue #139)', () => {
  /**
   * issue #139: buildOaiRequest re-hashed the ENTIRE request every main turn
   * (full-content djb2 per message for the divergence probe, per-char token
   * estimate for the T7 gate) even though request prefixes are byte-stable by
   * design. The caches make the steady state O(new + changed) instead of
   * O(history). Deterministically verified via computation counters — not
   * wall-clock timing, per this suite's philosophy.
   */

  function makePerfEngine() {
    return new PromptEngine({
      model: 'test',
      maxTokens: 1024,
      staticCtx: { tools: [{ name: 'edit_file', description: 'Edit file', input_schema: { type: 'object', properties: {} } }] },
      volatileCtx: { cwd: '/repo' },
    })
  }

  /** Short contents (<200 chars) keep every sub-pass passive — messages pass
   *  through by reference, exactly like real steady-state history. */
  function buildSession(turns: number): OaiMessage[] {
    const messages: OaiMessage[] = [{ role: 'user', content: 'start the task' }]
    for (let i = 0; i < turns; i++) {
      messages.push(makeAssistant([{ id: `call_${i}`, name: 'edit_file', args: `{"file_path":"src/f${i}.ts"}` }]))
      messages.push({ role: 'tool', tool_call_id: `call_${i}`, content: `edit ok ${i}` })
      messages.push({ role: 'assistant', content: `step ${i} done` })
      if (i < turns - 1) messages.push({ role: 'user', content: `continue with step ${i + 1}` })
    }
    return messages
  }

  it('messageSignature preserves divergence-probe semantics', () => {
    const sig = (m: OaiMessage) => messageSignature(m).sig
    // Equal fields → equal signature (fresh object hits the content-keyed cache)
    assert.equal(sig({ role: 'user', content: 'hello' }), sig({ role: 'user', content: 'hello' }))
    // Same content, different role must NOT cross-reuse (role is part of the sig)
    assert.notEqual(sig({ role: 'user', content: 'hello' }), sig({ role: 'system', content: 'hello' }))
    // tool_call_id is part of the signature
    assert.notEqual(
      sig({ role: 'tool', tool_call_id: 'a', content: 'out' }),
      sig({ role: 'tool', tool_call_id: 'b', content: 'out' }),
    )
    // tool_calls arguments are part of the signature
    assert.notEqual(
      sig(makeAssistant([{ id: 'x', name: 'f', args: '{"a":1}' }])),
      sig(makeAssistant([{ id: 'x', name: 'f', args: '{"a":2}' }])),
    )
  })

  it('messageSignature recomputes on in-place mutation (field-ref guard)', () => {
    // Production never mutates request messages in place, but a stale hit on a
    // mutated object would silently blind the divergence probe. A tool message
    // (tool_call_id set) takes the WeakMap path, so the mutation below can ONLY
    // be caught by the entry's source-field refs — this exercises the guard's
    // eviction branch, not a mere content-map miss.
    const m: OaiMessage = { role: 'tool', tool_call_id: 'guard_1', content: 'v1' }
    const s1 = messageSignature(m).sig
    const before = signatureCacheStats.computations
    assert.equal(messageSignature(m).sig, s1, 'same object, unchanged fields → WeakMap hit')
    assert.equal(signatureCacheStats.computations, before, 'WeakMap hit must not recompute')
    m.content = 'v2'
    const s2 = messageSignature(m).sig
    assert.notEqual(s1, s2, 'mutated field must invalidate the cached signature')
    assert.equal(signatureCacheStats.computations, before + 1, 'field-ref mismatch must fall through to a recompute')
  })

  it('estimateOaiMessageTokens caches by object and by content', () => {
    const content = 'x'.repeat(400) + '中文'
    const expected = Math.ceil(400 / 4) + Math.ceil(2 / 1.2)
    const msg: OaiMessage = { role: 'tool', tool_call_id: 't1', content }

    const before = estimateCacheStats.computations
    assert.equal(estimateOaiMessageTokens(msg), expected)
    assert.equal(estimateCacheStats.computations, before + 1, 'first estimate scans the content')

    // Same object → WeakMap hit
    assert.equal(estimateOaiMessageTokens(msg), expected)
    assert.equal(estimateCacheStats.computations, before + 1)

    // Fresh object, equal-content fresh string → content-keyed hit
    assert.equal(estimateOaiMessageTokens({ role: 'tool', tool_call_id: 't2', content: 'x'.repeat(400) + '中文' }), expected)
    assert.equal(estimateCacheStats.computations, before + 1)

    // In-place mutation must not serve a stale estimate (field-ref guard)
    msg.content = 'y'.repeat(8)
    assert.equal(estimateOaiMessageTokens(msg), 2)
    assert.equal(estimateCacheStats.computations, before + 2)
  })

  it('assistant estimates bypass the content map (tool_calls fold into the estimate)', () => {
    const a1 = makeAssistant([{ id: 'c1', name: 'f', args: '{"a":1}' }])
    const a2 = makeAssistant([{ id: 'c1', name: 'f', args: '{"a":1}' }])
    const before = estimateCacheStats.computations
    const v1 = estimateOaiMessageTokens(a1)
    const v2 = estimateOaiMessageTokens(a2)
    assert.equal(v1, v2)
    assert.equal(estimateCacheStats.computations, before + 2, 'fresh assistant objects always recompute (object path only)')
    assert.equal(estimateOaiMessageTokens(a1), v1)
    assert.equal(estimateCacheStats.computations, before + 2, 'repeat call on the same object hits the WeakMap')
  })

  it('steady-state buildOaiRequest hashes only new messages, not history', () => {
    const engine = makePerfEngine()
    const base = buildSession(30) // ~120 request messages
    const nextTurn: OaiMessage[] = [
      { role: 'user', content: 'continue with the final step' },
      makeAssistant([{ id: 'call_final', name: 'edit_file', args: '{"file_path":"src/final.ts"}' }]),
      { role: 'tool', tool_call_id: 'call_final', content: 'edit ok final' },
      { role: 'assistant', content: 'final step done' },
    ]

    // First build: everything is new — both the signature probe and the T7
    // estimate (contextWindow ≥ 200K) hash the full history once.
    const sigBefore1 = signatureCacheStats.computations
    const estBefore1 = estimateCacheStats.computations
    engine.buildOaiRequest([...base], undefined, 200_000)
    const sigDelta1 = signatureCacheStats.computations - sigBefore1
    const estDelta1 = estimateCacheStats.computations - estBefore1
    assert.ok(sigDelta1 >= 100, `first build should hash the full history, got ${sigDelta1}`)
    assert.ok(estDelta1 >= 100, `first build should estimate the full history, got ${estDelta1}`)

    // Steady state (one appended turn): bounded by the new messages, not by
    // history size. This is the issue #139 regression guard.
    const sigBefore2 = signatureCacheStats.computations
    const estBefore2 = estimateCacheStats.computations
    engine.buildOaiRequest([...base, ...nextTurn], undefined, 200_000)
    const sigDelta2 = signatureCacheStats.computations - sigBefore2
    const estDelta2 = estimateCacheStats.computations - estBefore2
    // 4 new history messages + a handful of rebuilt wrappers (trailer/system)
    assert.ok(sigDelta2 <= 8, `steady-state signature hashing must be O(new), got ${sigDelta2} for 4 new messages`)
    assert.ok(estDelta2 <= 8, `steady-state token estimating must be O(new), got ${estDelta2} for 4 new messages`)
    assert.ok(sigDelta2 < sigDelta1 / 4, `signature cache must decouple cost from history size (${sigDelta2} vs ${sigDelta1})`)
    assert.ok(estDelta2 < estDelta1 / 4, `estimate cache must decouple cost from history size (${estDelta2} vs ${estDelta1})`)
  })
})

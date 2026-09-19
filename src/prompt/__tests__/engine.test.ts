import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PromptEngine } from '../engine.js'
import { createVolatileSnapshot } from '../volatile-snapshot.js'
import { stableStringify } from '../../api/stable-json.js'
import { latestUserTrailer } from './helpers/message-selectors.js'
import type { OaiChatRequest, OaiMessage } from '../../api/oai-types.js'

function makeEngine() {
  return new PromptEngine({
    model: 'test',
    maxTokens: 1024,
    staticCtx: { tools: [{ name: 'edit_file', description: 'Edit file', input_schema: { type: 'object', properties: {} } }] },
    volatileCtx: { cwd: '/repo' },
  })
}

function canonicalOaiBody(request: OaiChatRequest): Record<string, unknown> {
  return {
    model: request.model,
    messages: request.messages,
    max_tokens: request.max_tokens,
    stream: request.stream,
    stream_options: request.stream_options,
    tools: request.tools,
    tool_choice: request.tool_choice,
  }
}

describe('PromptEngine OpenAI-native request building', () => {
  it('message selector parses latest user trailer', () => {
    const parsed = latestUserTrailer([{ role: 'user', content: 'fresh\n---\nhello' }])
    assert.equal(parsed.fresh, 'fresh')
    assert.equal(parsed.user, 'hello')
  })

  it('message selector rejects message lists without user messages', () => {
    assert.throws(() => latestUserTrailer([{ role: 'assistant', content: 'x' }]), /expected at least one user message/)
  })

  it('injects volatile user messages around OAI user messages only', () => {
    const engine = makeEngine()
    const messages: OaiMessage[] = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'edit_file', arguments: '{"file_path":"a.ts"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'done' },
    ]

    const request = engine.buildOaiRequest(messages)

    assert.equal(request.model, 'test')
    assert.equal(request.max_tokens, 1024)
    assert.equal(request.stream, true)
    assert.equal(request.tool_choice, 'auto')
    assert.equal(request.tools?.[0]?.type, 'function')
    assert.equal(request.tools?.[0]?.function.name, 'edit_file')
    assert.equal(request.messages.length, 4)
    assert.equal(request.messages[0]?.role, 'system')
    // Trailer mode: when firstUserIdx===lastUserIdx, cachedFreshBlock (which
    // includes frozenBase) is merged into the user message — no separate frozenBase msg.
    assert.equal(request.messages[1]?.role, 'user')
    assert.match((request.messages[1]?.content as string) ?? '', /<environment/)
    assert.ok(((request.messages[1]?.content as string) ?? '').includes('hello'))
  })

  it('reuses cached fresh volatile across tool-call turns for the same latest user message', () => {
    const engine = makeEngine()
    engine.setSessionState('state v1')

    const first = engine.buildOaiRequest([{ role: 'user', content: 'inspect' }])
    const firstVolatile = first.messages[1]
    assert.equal(firstVolatile?.role, 'user')
    // P1: sessionState is in standalone appendix, not in user message
    const firstAppendix = first.messages[first.messages.length - 1]!
    assert.match(typeof firstAppendix.content === 'string' ? firstAppendix.content : '', /state v1/)

    engine.setSessionState('state v2')
    const second = engine.buildOaiRequest([
      { role: 'user', content: 'inspect' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'edit_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'done' },
    ])

    assert.deepEqual(second.messages[1], firstVolatile)
    // P1: sessionState is in appendix, not user message
    const secondAppendix = second.messages[second.messages.length - 1]!
    assert.doesNotMatch(typeof secondAppendix.content === 'string' ? secondAppendix.content : '', /state v2/)
  })

  it('refreshes cached fresh volatile at a new user message boundary', () => {
    const engine = makeEngine()
    engine.setSessionState('state v1')
    engine.buildOaiRequest([{ role: 'user', content: 'inspect' }])

    engine.setSessionState('state v2')
    const request = engine.buildOaiRequest([
      { role: 'user', content: 'inspect' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'continue' },
    ])

    const { fresh, user } = latestUserTrailer(request.messages)
    assert.ok(user.startsWith('continue'), `user should start with 'continue', got '${user.slice(0, 30)}...'`)
    // P1: sessionState is in standalone appendix, not in FROZEN fresh
    const appendix = request.messages[request.messages.length - 1]!
    assert.match(typeof appendix.content === 'string' ? appendix.content : '', /state v2/)
  })

  it('produces stable canonical OAI body bytes for equivalent construction', () => {
    const messages: OaiMessage[] = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'edit_file', arguments: '{"file_path":"a.ts"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'done' },
    ]

    const requestA = makeEngine().buildOaiRequest(messages)
    const requestB = makeEngine().buildOaiRequest(messages)

    assert.equal(stableStringify(canonicalOaiBody(requestA)), stableStringify(canonicalOaiBody(requestB)))
  })
})

describe('PromptEngine context layer report', () => {
  it('reports context layers with channels and fingerprint policy', () => {
    const engine = new PromptEngine({
      model: 'test',
      maxTokens: 1000,
      staticCtx: { tools: [] },
      volatileCtx: {
        cwd: '/repo',
        rivetMd: 'Use TDD.',
        gitStatus: 'M src/main.tsx',
        sessionMemoryBlock: '<session-memory><entry>decision</entry></session-memory>',
        workingSet: ['src/prompt/engine.ts'],
      },
    })

    const report = engine.getContextLayerReport()
    assert.deepEqual(report.layers.map(l => l.id), [
      'system',
      'tools',
      'project-instructions',
      'git-status',
      'session-memory',
      'working-set',
    ])
    assert.ok(report.fingerprintIncluded.some(l => l.id === 'system'))
    assert.ok(report.fingerprintIncluded.some(l => l.id === 'session-memory'))
    assert.equal(report.dynamicLayers.length, 0)
  })

  it('omits layers with no content', () => {
    const engine = new PromptEngine({
      model: 'test',
      maxTokens: 1000,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/repo' },
    })

    const report = engine.getContextLayerReport()
    assert.deepEqual(report.layers.map(l => l.id), ['system', 'tools'])
  })
})

describe('PromptEngine active claims projection', () => {
  it('updated active claims appear in the latest turn request without entering historical stable context', () => {
    const engine = new PromptEngine({
      model: 'deepseek-test',
      maxTokens: 4096,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/repo' },
    })

    engine.updateActiveClaims([{
      id: 'c1',
      kind: 'user_constraint',
      scope: 'session',
      status: 'active',
      text: 'Run tests before claiming done',
      confidence: 0.9,
      fitness: 5,
      source: { actor: 'user', sessionId: 'session-123', turn: 1, eventId: 'e1' },
      evidence: [{ id: 'e1', kind: 'user_message', summary: 'Run tests before claiming done', createdAt: 1 }],
      counterevidence: [],
      consumers: [],
      createdAt: 1,
      lastUsedAt: 1,
      tags: ['anchor'],
    }])

    const request = engine.buildOaiRequest([
      { role: 'user', content: 'first turn' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'second turn' },
    ])

    const contextMessages = request.messages.filter(
      msg => msg.role === 'user' && typeof msg.content === 'string' && msg.content.includes('<context>')
    )

    assert.equal(contextMessages.length, 2)
    assert.doesNotMatch(contextMessages[0]!.content as string, /active-claims/)
    assert.doesNotMatch(contextMessages[1]!.content as string, /active-claims/)
  })

  it('updated session memory appears in the latest turn request', () => {
    const engine = new PromptEngine({
      model: 'deepseek-test',
      maxTokens: 4096,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/repo' },
    })

    engine.updateSessionMemory('<session-memory session_id="s1">\n<entry id="m1" created_at="1" source="manual">Use JSONL first</entry>\n</session-memory>')

    const request = engine.buildOaiRequest([{ role: 'user', content: 'remember this' }])
    const context = request.messages[1]!.content as string

    assert.match(context, /<session-memory>/)
    assert.match(context, /&lt;session-memory session_id=&quot;s1&quot;&gt;/)
    assert.match(context, /Use JSONL first/)
    assert.doesNotMatch(context, /<session-memory session_id="s1">/)
  })

  it('updated active domain appears only in latest volatile context', () => {
    const engine = new PromptEngine({
      model: 'deepseek-test',
      maxTokens: 4096,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/repo' },
    })

    engine.setActiveDomain({ name: '破军', motto: '好男儿当负三尺剑立不世之功', volatileBlock: '你当前在破军域。' })

    const request = engine.buildOaiRequest([
      { role: 'user', content: 'first turn' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: '探索新的缓存方案' },
    ])

    const contextMessages = request.messages.filter(
      msg => msg.role === 'user' && typeof msg.content === 'string' && msg.content.includes('<context>')
    )

    assert.equal(contextMessages.length, 2)
    // star-domain is folded into the frozen prefix, swapped in at the user-message
    // boundary. In this single multi-message call the boundary swap runs while
    // processing lastUserIdx, AFTER firstUserIdx is emitted via the pre-swap
    // fallback — so the historical message carries no domain, only the latest does.
    assert.doesNotMatch(contextMessages[0]!.content as string, /star-domain/)
    assert.match(contextMessages[1]!.content as string, /<star-domain name="破军"/)
    const appendix = request.messages[request.messages.length - 1]!
    assert.match(typeof appendix.content === 'string' ? appendix.content : '', /<star-domain name="破军"/)
    assert.equal(engine.checkDrift(), null)
  })

  // P1.1: folding the domain into frozenBase keeps volatileBlock in sync at boundaries
  it('P1.1a: volatileBlock stays in sync with frozenBase after domain fold', () => {
    const engine = new PromptEngine({
      model: 'test',
      maxTokens: 8000,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/tmp' },
      habituationThreshold: 1, // tracker enabled
    })

    const frozenBaseStart = (engine as any).frozenBase as string
    assert.equal((engine as any).volatileBlock, frozenBaseStart, 'volatileBlock should equal frozenBase at startup')
    assert.ok(!frozenBaseStart.includes('<star-domain'), 'no domain before setActiveDomain')

    // Feed the same domain 5 times. setActiveDomain folds it into frozenBase;
    // the boundary swap brings volatileBlock in sync and it stays byte-stable
    // across same-domain turns (no per-turn mutation).
    engine.setPhaseHint('execute')
    for (let i = 0; i < 5; i++) {
      engine.setActiveDomain({ name: 'test', volatileBlock: 'block', motto: 'motto' })
      engine.buildOaiRequest([{ role: 'user', content: `turn${i}` }])
    }

    const frozenBaseEnd = (engine as any).frozenBase as string
    assert.ok(frozenBaseEnd.includes('<star-domain name="test"'), 'frozenBase now contains the folded domain')
    assert.equal((engine as any).volatileBlock, frozenBaseEnd,
      'volatileBlock stays in sync with frozenBase after fold + boundary swap')
  })

  it('P1.1b: folded star-domain lives in frozen prefix and merged user message', () => {
    const engine = new PromptEngine({
      model: 'test',
      maxTokens: 8000,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/tmp' },
      habituationThreshold: 1, // tracker enabled
    })

    engine.setPhaseHint('execute')

    // Domain is a session constant — folded into the frozen prefix from the
    // first turn, no habituation warm-up.
    for (let i = 1; i <= 5; i++) {
      engine.setActiveDomain({ name: 'orion', volatileBlock: 'star-data', motto: 'guide' })
      engine.buildOaiRequest([{ role: 'user', content: `turn${i}` }])
    }

    const req = engine.buildOaiRequest([{ role: 'user', content: 'final' }])

    const allUsers = req.messages.filter(m => m.role === 'user')
    // Trailer mode: frozen volatileBlock (with domain) is merged into the LAST user message
    const injectedBlock = (allUsers[allUsers.length - 1]?.content as string) ?? ''

    assert.ok(injectedBlock.includes('star-data'),
      'folded domain content should appear in the merged user message (trailer mode)')

    // domain is now IN the frozen prefix (session constant), unlike the old
    // habituation→consolidated path which kept it out of frozenBase.
    assert.ok((engine as any).frozenBase.includes('star-data'),
      'frozenBase should contain the folded domain')
  })

  it('getPhaseHint round-trips with setPhaseHint (wiring for TDD RED exemption)', () => {
    const engine = new PromptEngine({ model: 'test', maxTokens: 8000, staticCtx: { tools: [] }, volatileCtx: { cwd: '/tmp' } })
    assert.equal(engine.getPhaseHint(), undefined)
    engine.setPhaseHint('verify')
    assert.equal(engine.getPhaseHint(), 'verify')
  })

  // Trailer mode: cachedFreshBlock is merged into the last user message's content
  // instead of being injected as a separate user message. This keeps the message
  // array append-only, preserving DeepSeek exact-prefix cache byte stability.
  it('P2: cachedFreshBlock merged into last user message, not as separate message', () => {
    const engine = new PromptEngine({
      model: 'test',
      maxTokens: 8000,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/tmp' },
      habituationThreshold: 0,
    })

    const req = engine.buildOaiRequest([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
    ])

    const userMsgs = req.messages.filter(m => m.role === 'user')

    // Should be exactly 2 user messages (trailer merge for both first and last):
    // [0] volatileBlock + '\n---\n' + 'first question' (merged at firstUserIdx)
    // [1] cachedFreshBlock + '\n---\n' + 'second question' (merged at lastUserIdx)
    // firstUserIdx fallback no longer pushes 2 separate messages — that was the
    // very bug that caused index shifts and broke suffix prefix cache.
    assert.equal(userMsgs.length, 2,
      'trailer merge at both firstUserIdx and lastUserIdx = 2 messages')

    const lastUserMsg = userMsgs[userMsgs.length - 1]!
    assert.ok((lastUserMsg.content as string).includes('second question'),
      'last user msg must contain original user input')
    assert.ok((lastUserMsg.content as string).includes('<context>'),
      'last user msg must contain cachedFreshBlock (volatile context)')
  })

  // Phase 2.2: On 1M+ context windows, skip observation masking entirely.
  // The 1M window has enough headroom. trySessionSplit (86%) is the primary
  // defense against context overflow. Masking mutates message content which
  // breaks exact prefix cache — skipping it maximizes cache stability.
  it('P2.2: skips observation mask on 1M+ context window regardless of turn count', () => {
    const engine = new PromptEngine({
      model: 'test',
      maxTokens: 8000,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/tmp' },
    })

    // Build 85 turns — well over the 10-turn mask window for small windows.
    // tool 消息必须有配对的 assistant.tool_calls，否则 orphan 修复会把它们
    // 整体丢弃（API safety net），mask 计数永远为 0。
    const messages: OaiMessage[] = []
    for (let i = 0; i < 85; i++) {
      messages.push({ role: 'user', content: `q${i}` })
      messages.push({
        role: 'assistant',
        content: `a${i}`,
        tool_calls: [{ id: `call_${i}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      })
      messages.push({
        role: 'tool' as const,
        tool_call_id: `call_${i}`,
        content: `result content for tool call ${i} `.padEnd(3000, 'x'),
      })
    }

    // Without contextWindow: old tool results should be masked (MASK_WINDOW=10)
    const reqWithoutCW = engine.buildOaiRequest(messages)
    const maskedCountWithoutCW = reqWithoutCW.messages.filter(
      (m: any) => m.role === 'tool' && m.content.startsWith('[observation masked')
    ).length
    assert.ok(maskedCountWithoutCW > 0,
      'old tool results should be masked without contextWindow')

    // With contextWindow >= 1M: NO masking even at 85 turns (>> MASK_WINDOW=10)
    const reqWith1M = engine.buildOaiRequest(messages, undefined, 1_000_000)
    const maskedCountWith1M = reqWith1M.messages.filter(
      (m: any) => m.role === 'tool' && m.content.startsWith('[observation masked')
    ).length
    assert.equal(maskedCountWith1M, 0,
      'no tool results should be masked on 1M window — skip entirely')

    // Byte stability: calling twice with same args should produce identical messages
    const req2 = engine.buildOaiRequest(messages, undefined, 1_000_000)
    assert.deepStrictEqual(
      req2.messages.map(m => m.content),
      reqWith1M.messages.map(m => m.content),
      'repeated calls should produce identical content for cache stability'
    )
  })
})

describe('git-dirty flag and toolHistory cap', () => {
  function lastUserContent(req: OaiChatRequest): string {
    for (let i = req.messages.length - 1; i >= 0; i--) {
      if (req.messages[i]!.role === 'user') return req.messages[i]!.content as string
    }
    return ''
  }

  it('markGitDirty causes gitStatus to refresh from cache on next user message', () => {
    const engine = new PromptEngine({
      model: 'test',
      maxTokens: 1024,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/repo', gitStatus: 'Current branch: main\nStatus:\nM old.ts' },
    })

    const req1 = engine.buildOaiRequest([{ role: 'user', content: 'msg1' }])
    assert.ok(lastUserContent(req1).includes('old.ts'), 'first request uses frozen snapshot')

    engine.markGitDirty()
    const req2 = engine.buildOaiRequest([{ role: 'user', content: 'msg2' }])
    assert.ok(!lastUserContent(req2).includes('old.ts'), 'after markGitDirty, frozen snapshot is bypassed')
  })

  it('periodic refresh every 3 user messages without markGitDirty', () => {
    const engine = new PromptEngine({
      model: 'test',
      maxTokens: 1024,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/repo', gitStatus: 'Current branch: main\nStatus:\nM stale.ts' },
    })

    engine.buildOaiRequest([{ role: 'user', content: 'a' }])
    const req2 = engine.buildOaiRequest([{ role: 'user', content: 'b' }])
    assert.ok(lastUserContent(req2).includes('stale.ts'), 'message 2 still uses frozen snapshot')

    const req3 = engine.buildOaiRequest([{ role: 'user', content: 'c' }])
    assert.ok(!lastUserContent(req3).includes('stale.ts'), 'message 3 triggers periodic git refresh')
  })

  it('toolHistory appendix block is retired — history no longer rendered into volatile context', () => {
    // 2026-07-06 appendix 字节稳定改造删除了 tool-history 块（与消息历史冗余，
    // 见 docs/changelog/2026-07-06-appendix-delta-byte-stability.md）。守住
    // "不再渲染" 这个新契约，防止无意间加回 churner。
    const engine = new PromptEngine({
      model: 'test',
      maxTokens: 1024,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/repo' },
    })

    const history = Array.from({ length: 12 }, (_, i) => ({
      tool: `tool_${i}`,
      target: `target_${i}`,
      status: 'success' as const,
    }))

    const req = engine.buildOaiRequest([{ role: 'user', content: 'x' }], history)
    const vol = lastUserContent(req)
    assert.ok(!vol.includes('<tool-summary'), 'tool-history appendix block must stay deleted')
    assert.ok(!vol.includes('tool_11'), 'tool history entries must not leak into volatile context')
  })
})

describe('frozenUserMerged eviction', () => {
  it('evicts stale entries when map exceeds max size', () => {
    const engine = new PromptEngine({
      model: 'test',
      maxTokens: 1024,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/test' },
    })
    // Feed 70 distinct user messages (each becomes an entry in frozenUserMerged)
    const messages: OaiMessage[] = []
    for (let i = 0; i < 70; i++) {
      messages.push({ role: 'user', content: `user message ${i}` })
      engine.buildOaiRequest([...messages])
    }
    // After 70 messages, the frozen cache should have been trimmed to ≤ 64 entries.
    // Oldest entries are evicted. The most recent 64 should still have frozen content.
    const req = engine.buildOaiRequest(messages)
    const userMsgs = req.messages.filter(m => m.role === 'user')
    // The newest 64 user messages should have merged content (volatile + user content)
    const keptMsgs = userMsgs.slice(-64)
    for (const msg of keptMsgs) {
      assert.ok(typeof msg.content === 'string' && msg.content.includes('---'), `recent user message should have merged content`)
    }
    // The last message (freshly built) always has merged content
    const lastMsg = userMsgs[userMsgs.length - 1]
    assert.ok(typeof lastMsg?.content === 'string' && lastMsg.content.includes('---'), 'latest message always has merged content')
  })

  it('preserves frozen content for messages still in the array', () => {
    const engine = new PromptEngine({
      model: 'test',
      maxTokens: 1024,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/test' },
    })
    // Create messages, build request, then rebuild with same messages
    const msgs1: OaiMessage[] = [{ role: 'user', content: 'first' }]
    const req1 = engine.buildOaiRequest(msgs1)
    // Find the user message content (after system prompt at index 0)
    const userMsg1 = req1.messages.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('first'))
    assert.ok(userMsg1, 'should find first user message')
    const content1 = userMsg1!.content as string

    // Feed 70 more messages to trigger eviction
    const msgs2: OaiMessage[] = [...msgs1]
    for (let i = 0; i < 70; i++) {
      msgs2.push({ role: 'user', content: `msg ${i}` })
    }
    engine.buildOaiRequest(msgs2)

    // Now rebuild with just the original message — frozen content should still match
    // (because the key "first" is still in msgs2 which was used during eviction)
    const req3 = engine.buildOaiRequest(msgs1)
    const userMsg3 = req3.messages.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('first'))
    assert.ok(userMsg3, 'should find first user message after eviction')
    const content3 = userMsg3!.content as string
    assert.equal(content3, content1, 'frozen content for first message must be preserved')
  })

  it('does not duplicate frozen snapshots across tool-call turns within one user message', () => {
    const engine = new PromptEngine({
      model: 'test',
      maxTokens: 1024,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/test' },
    })
    // Simulate 70 tool-call turns within ONE user message. Before dedup this
    // pushed 70 identical snapshots → eviction (cap 64) destroyed snapshots
    // for ALL user messages → 0% cache break on the next boundary.
    const base: OaiMessage[] = [{ role: 'user', content: 'big task' }]
    const req1 = engine.buildOaiRequest([...base])
    const firstContent = req1.messages.find(m => m.role === 'user')!.content as string

    const grow: OaiMessage[] = [...base]
    for (let i = 0; i < 70; i++) {
      grow.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'bash', arguments: '{}' } }] })
      grow.push({ role: 'tool', tool_call_id: `c${i}`, content: `result ${i}` })
      engine.buildOaiRequest([...grow])
    }

    // New user boundary: the historical 'big task' message must still serve
    // its frozen snapshot byte-identically (no eviction destroyed it).
    const next = engine.buildOaiRequest([...grow, { role: 'user', content: 'next task' }])
    const historical = next.messages.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('big task'))
    assert.ok(historical, 'historical user message present')
    assert.equal(historical!.content, firstContent, 'historical snapshot is byte-identical — dedup prevented eviction')
    assert.equal(engine.getCacheEventStats().frozenFallbackRebuilds, 0, 'no fallback rebuild occurred')
  })

  it('never evicts the FIRST user message snapshot under 70 distinct-turn pressure (A-line byte-0 anchor)', () => {
    const engine = new PromptEngine({
      model: 'test',
      maxTokens: 1024,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/test' },
    })
    // The first user message is the byte-0 prefix anchor. With 70 distinct
    // user turns, totalFrozen blows past the 64 cap and eviction runs. Map
    // insertion order makes the first key the FIRST length-1 eviction victim —
    // so without protection this snapshot is the first to die.
    const history: OaiMessage[] = [{ role: 'user', content: 'FIRST anchor task' }]
    const req1 = engine.buildOaiRequest([...history])
    const firstContent = req1.messages.find(m => m.role === 'user')!.content as string

    for (let i = 0; i < 70; i++) {
      history.push({ role: 'assistant', content: `ok ${i}` })
      history.push({ role: 'user', content: `distinct turn ${i}` })
      engine.buildOaiRequest([...history])
    }

    // Swap volatileBlock so a FATAL rebuild (evicted → rebuild with CURRENT
    // block) would differ from the original frozen snapshot. If the anchor is
    // protected, it serves byte-identically regardless.
    engine.updateSessionMemory('<session-memory><entry>swapped after eviction</entry></session-memory>')

    const final = engine.buildOaiRequest([...history])
    const firstNow = final.messages.find(
      m => m.role === 'user' && typeof m.content === 'string' && (m.content as string).includes('FIRST anchor task'),
    )
    assert.ok(firstNow, 'first user message still present')
    assert.equal(firstNow!.content, firstContent, 'first-user snapshot byte-identical after 70-turn eviction pressure')
  })

  it('clamps to surviving snapshot instead of volatileBlock rebuild when fetch index overruns', () => {
    const engine = new PromptEngine({
      model: 'test',
      maxTokens: 1024,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/test' },
    })
    // Two identical "继续" user messages whose merged content is identical →
    // dedup stores ONE snapshot. The second historical fetch (idx 1) overruns
    // the array and must clamp to the surviving snapshot — not rebuild with
    // the current volatileBlock (which may have swapped).
    const m1: OaiMessage[] = [{ role: 'user', content: '继续' }]
    const req1 = engine.buildOaiRequest([...m1])
    const c1 = req1.messages.find(m => m.role === 'user')!.content as string

    const m2: OaiMessage[] = [...m1, { role: 'assistant', content: 'ok' }, { role: 'user', content: '继续' }]
    engine.buildOaiRequest([...m2])

    // Swap volatileBlock between boundaries so a naive fallback would differ.
    engine.updateSessionMemory('<session-memory><entry>new memory</entry></session-memory>')

    const m3: OaiMessage[] = [...m2, { role: 'assistant', content: 'ok2' }, { role: 'user', content: 'final' }]
    const req3 = engine.buildOaiRequest([...m3])
    const historicals = req3.messages.filter(m => m.role === 'user' && typeof m.content === 'string' && (m.content as string).includes('继续'))
    assert.equal(historicals.length, 2)
    assert.equal(historicals[0]!.content, c1, 'first 继续 uses original snapshot')
    assert.equal(historicals[1]!.content, c1, 'second 继续 clamps to surviving snapshot (byte-identical)')
    assert.equal(engine.getCacheEventStats().frozenFallbackRebuilds, 0, 'clamp path avoided volatileBlock rebuild')
  })
})

describe('setActivePlan pointer (dynamic appendix, cache-safe)', () => {
  function pointerEngine() {
    return new PromptEngine({
      model: 'test',
      maxTokens: 1024,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/repo' },
    })
  }

  it('renders the pointer in the dynamic appendix, not the frozen prefix', () => {
    const engine = pointerEngine()
    engine.setActivePlan('<active-plan slug="p1" title="P1" path=".rivet/plans/p1.md">go</active-plan>')
    const req = engine.buildOaiRequest([{ role: 'user', content: 'start' }])
    const merged = req.messages.find(m => m.role === 'user')!.content as string
    assert.match(merged, /<active-plan slug="p1"/)
    // Pointer lives in the appendix (after the user content), not the frozen
    // volatileBlock prefix (before the '\n---\n' separator).
    const frozenPrefix = merged.split('\n---\n')[0]!
    assert.doesNotMatch(frozenPrefix, /active-plan/)
  })

  it('does not break the frozen base / fresh cache (no swap, no rebuild)', () => {
    const engine = pointerEngine()
    engine.buildOaiRequest([{ role: 'user', content: 'start' }])
    const before = engine.getCacheEventStats().volatileSwaps
    engine.setActivePlan('<active-plan slug="p1" title="P1" path=".rivet/plans/p1.md">go</active-plan>')
    // Same user message → cached fresh reused; setActivePlan must not invalidate it.
    engine.buildOaiRequest([{ role: 'user', content: 'start' }])
    assert.equal(engine.getCacheEventStats().volatileSwaps, before, 'setActivePlan must not swap the frozen base')
  })

  it('clears the pointer with null', () => {
    const engine = pointerEngine()
    engine.setActivePlan('<active-plan slug="p1" title="P1" path=".rivet/plans/p1.md">go</active-plan>')
    engine.buildOaiRequest([{ role: 'user', content: 'a' }])
    engine.setActivePlan(null)
    const req = engine.buildOaiRequest([{ role: 'user', content: 'b' }])
    const merged = req.messages.filter(m => m.role === 'user').map(m => m.content as string).join('\n')
    assert.doesNotMatch(merged, /active-plan/)
  })
})

describe('injected system-reminder messages (P1-4)', () => {
  function makeEngine() {
    return new PromptEngine({
      model: 'test',
      maxTokens: 1024,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/repo' },
    })
  }

  it('passes reminder messages through untouched (no volatile merge)', () => {
    const engine = makeEngine()
    const reminder = '<system-reminder>\nconvergence kick\n</system-reminder>'
    const req = engine.buildOaiRequest([
      { role: 'user', content: 'real task' },
      { role: 'assistant', content: 'working' },
      { role: 'user', content: reminder },
    ])
    const reminderMsg = req.messages.find(m => typeof m.content === 'string' && m.content.includes('convergence kick'))
    assert.ok(reminderMsg, 'reminder present in request')
    assert.equal(reminderMsg!.content, reminder, 'reminder is byte-identical — no volatile/appendix merge')
  })

  it('reminder injection does not trigger volatile swap or appendix rebuild', () => {
    const engine = makeEngine()
    engine.setSessionState('state v1')
    const base: OaiMessage[] = [{ role: 'user', content: 'real task' }]
    const req1 = engine.buildOaiRequest([...base])
    const merged1 = req1.messages.find(m => m.role === 'user')!.content as string

    // Change appendix-feeding state mid-task. Before P1-4, the reminder would
    // count as a new user boundary and rebuild the appendix with 'state v2'.
    engine.setSessionState('state v2')

    const withReminder: OaiMessage[] = [
      ...base,
      { role: 'assistant', content: 'thinking' },
      { role: 'user', content: '<system-reminder>\nkick\n</system-reminder>' },
    ]
    const req2 = engine.buildOaiRequest(withReminder)
    const merged2 = req2.messages.find(m => m.role === 'user' && typeof m.content === 'string' && (m.content as string).includes('real task'))!.content as string
    assert.equal(merged2, merged1, 'real user message stays byte-identical across reminder injection')
    assert.equal(engine.getCacheEventStats().volatileSwaps, 0, 'no volatile swap on pseudo boundary')
    assert.doesNotMatch(merged2, /state v2/, 'appendix not rebuilt by pseudo boundary')
  })

  it('reminder as last message keeps previous real user message as trailer target', () => {
    const engine = makeEngine()
    const base: OaiMessage[] = [{ role: 'user', content: 'task' }]
    engine.buildOaiRequest([...base])

    const withReminder: OaiMessage[] = [
      ...base,
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'output' },
      { role: 'user', content: '<system-reminder>\nnudge\n</system-reminder>' },
    ]
    const req = engine.buildOaiRequest(withReminder)
    const userMsgs = req.messages.filter(m => m.role === 'user')
    // Real task message keeps the volatile merge; reminder rides bare at the end.
    assert.ok((userMsgs[0]!.content as string).includes('<environment'), 'real user message has volatile context')
    assert.equal(userMsgs[userMsgs.length - 1]!.content, '<system-reminder>\nnudge\n</system-reminder>')
  })
})

describe('T7 watermark collapse (P0-2)', () => {
  function makeEngine() {
    return new PromptEngine({
      model: 'test',
      maxTokens: 1024,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/repo' },
    })
  }

  function bigHistory(turns: number, charsPerToolResult: number): OaiMessage[] {
    const msgs: OaiMessage[] = []
    for (let t = 0; t < turns; t++) {
      msgs.push({ role: 'user', content: `turn ${t}` })
      msgs.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${t}`, type: 'function', function: { name: 'bash', arguments: '{}' } }] })
      msgs.push({ role: 'tool', tool_call_id: `c${t}`, content: `line one of output\n${'x'.repeat(charsPerToolResult)}` })
    }
    return msgs
  }

  it('does not semantically collapse tool-result bodies below the 50% gate (W3 lightweight pass)', () => {
    // W3 (9514d4fb) extended T7 to 0-50% as a lightweight pass: below the 50%
    // gate it only folds duplicate grep/read_file and strips reasoning — it must
    // NOT run full semantic collapse. The watermark bookkeeping advances per
    // 50K-token step regardless, so the body invariant (not the watermark
    // counter) is the contract worth asserting here.
    const engine = makeEngine()
    // 12 turns × 10K chars ≈ 30K tokens — way below the 500K (50%) gate on 1M.
    const req = engine.buildOaiRequest(bigHistory(12, 10_000), undefined, 1_000_000)
    const toolMsgs = req.messages.filter(m => m.role === 'tool')
    assert.ok(toolMsgs.length > 0, 'tool results present in request')
    // Non-duplicate bash results must survive untouched below the gate.
    for (const m of toolMsgs) {
      const content = m.content as string
      assert.doesNotMatch(content, /^\[collapsed /, 'no semantic collapse below 50% gate')
      assert.ok(content.includes('x'.repeat(100)), 'tool-result body preserved verbatim below gate')
    }
  })

  it('watermark advances only when crossing a 50K token step', () => {
    const engine = makeEngine()
    // 12 turns × 200K chars ≈ 600K tokens — above the 500K gate.
    const history = bigHistory(12, 200_000)
    engine.buildOaiRequest([...history], undefined, 1_000_000)
    const wm1 = engine.getCacheEventStats().collapseWatermark
    assert.ok(wm1 > 0, 'watermark set above gate')

    // Same token step: repeated request — watermark must NOT move.
    engine.buildOaiRequest([...history], undefined, 1_000_000)
    assert.equal(engine.getCacheEventStats().collapseWatermark, wm1, 'watermark frozen within step')

    // Small growth (well under 50K tokens): still frozen.
    const grown = [...history,
      { role: 'assistant' as const, content: null, tool_calls: [{ id: 'cx', type: 'function' as const, function: { name: 'bash', arguments: '{}' } }] },
      { role: 'tool' as const, tool_call_id: 'cx', content: 'small' },
    ]
    engine.buildOaiRequest(grown, undefined, 1_000_000)
    assert.equal(engine.getCacheEventStats().collapseWatermark, wm1, 'small growth does not advance watermark')

    // Cross the next 50K step (+200K chars ≈ +50K tokens): watermark advances.
    const crossed = [...grown,
      { role: 'user' as const, content: 'next turn' },
      { role: 'assistant' as const, content: null, tool_calls: [{ id: 'cy', type: 'function' as const, function: { name: 'bash', arguments: '{}' } }] },
      { role: 'tool' as const, tool_call_id: 'cy', content: 'y'.repeat(250_000) },
    ]
    engine.buildOaiRequest(crossed, undefined, 1_000_000)
    const wm2 = engine.getCacheEventStats().collapseWatermark
    assert.ok(wm2 >= wm1, 'watermark only moves forward')
    assert.notEqual(wm2, wm1, 'crossing a 50K step advances the watermark')
  })
})

describe('prefix evolution integration: multi-round + injection (cache-break repro)', () => {
  it('request prefix stays byte-stable across tool turns and reminder injections within a round', () => {
    const engine = new PromptEngine({
      model: 'test',
      maxTokens: 1024,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/repo' },
    })

    const session: OaiMessage[] = [{ role: 'user', content: 'fix the cache bug' }]
    const requests: OaiMessage[][] = []
    const snapshot = () => { requests.push(engine.buildOaiRequest([...session], undefined, 1_000_000).messages) }

    snapshot()
    // Tool turns within the round
    for (let i = 0; i < 3; i++) {
      session.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'bash', arguments: '{}' } }] })
      session.push({ role: 'tool', tool_call_id: `c${i}`, content: `output ${i}: ${'z'.repeat(300)}` })
      snapshot()
    }
    // Injected reminder mid-round (convergence kick)
    session.push({ role: 'user', content: '<system-reminder>\n收敛提醒\n</system-reminder>' })
    snapshot()
    // More tool turns after injection
    session.push({ role: 'assistant', content: null, tool_calls: [{ id: 'c9', type: 'function', function: { name: 'bash', arguments: '{}' } }] })
    session.push({ role: 'tool', tool_call_id: 'c9', content: 'final output' })
    snapshot()

    // Every earlier request must be a byte-exact prefix of every later request.
    for (let a = 0; a < requests.length - 1; a++) {
      const earlier = requests[a]!
      const later = requests[a + 1]!
      for (let i = 0; i < earlier.length; i++) {
        assert.deepEqual(later[i], earlier[i],
          `request#${a + 1} msg[${i}] must byte-match request#${a} (prefix stability)`)
      }
    }

    // New REAL user boundary: prefix up to (and including) the old history must
    // still match — only the new trailer differs.
    session.push({ role: 'user', content: 'now write the tests' })
    const next = engine.buildOaiRequest([...session], undefined, 1_000_000).messages
    const last = requests[requests.length - 1]!
    for (let i = 0; i < last.length; i++) {
      assert.deepEqual(next[i], last[i], `new round msg[${i}] preserves historical prefix`)
    }
  })
})

describe('PromptEngine advisory deduplication', () => {
  function lastAppendixContent(request: OaiChatRequest): string {
    const last = request.messages[request.messages.length - 1]
    return typeof last?.content === 'string' ? last.content : ''
  }

  it('injects task-depth advisory only when layer changes', () => {
    const engine = makeEngine()

    engine.setTaskDepthLayer('system')
    const req1 = engine.buildOaiRequest([{ role: 'user', content: 'a' }])
    assert.match(lastAppendixContent(req1), /<task-depth layer="system">/)

    // Same layer on a new user message → no advisory
    engine.setTaskDepthLayer('system')
    const req2 = engine.buildOaiRequest([{ role: 'user', content: 'b' }])
    assert.doesNotMatch(lastAppendixContent(req2), /<task-depth/)

    // Layer change → advisory reappears
    engine.setTaskDepthLayer('wiring')
    const req3 = engine.buildOaiRequest([{ role: 'user', content: 'c' }])
    assert.match(lastAppendixContent(req3), /<task-depth layer="wiring">/)
  })

  it('injects plan-methodology advisory only when methodology changes', () => {
    const engine = makeEngine()

    engine.setPlanMethodology('lightweight')
    const req1 = engine.buildOaiRequest([{ role: 'user', content: 'a' }])
    assert.match(lastAppendixContent(req1), /<plan-methodology route="lightweight">/)

    // Same methodology on a new user message → no advisory
    engine.setPlanMethodology('lightweight')
    const req2 = engine.buildOaiRequest([{ role: 'user', content: 'b' }])
    assert.doesNotMatch(lastAppendixContent(req2), /<plan-methodology/)

    // Methodology change → advisory reappears
    engine.setPlanMethodology('full')
    const req3 = engine.buildOaiRequest([{ role: 'user', content: 'c' }])
    assert.match(lastAppendixContent(req3), /<plan-methodology route="full">/)
  })
})

describe('project trust gate for AGENTS.md/.rivet.md injection (#218)', () => {
  const prevTrust = process.env.RIVET_TRUST_PROJECT
  const prevHome = process.env.RIVET_HOME
  const tmpDirs: string[] = []

  function tmpProject(agents: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-trust-gate-'))
    writeFileSync(join(dir, 'AGENTS.md'), agents)
    tmpDirs.push(dir)
    return dir
  }

  function engineAt(cwd: string): PromptEngine {
    return new PromptEngine({
      model: 'test',
      maxTokens: 1024,
      staticCtx: { tools: [] },
      volatileCtx: { cwd },
    })
  }

  function joined(messages: OaiMessage[]): string {
    return messages
      .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n')
  }

  afterEach(() => {
    if (prevTrust === undefined) delete process.env.RIVET_TRUST_PROJECT
    else process.env.RIVET_TRUST_PROJECT = prevTrust
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('engine path does NOT inject AGENTS.md from an untrusted project dir', () => {
    const cwd = tmpProject('UNTRUSTED_AGENTS_SENTINEL_218')
    process.env.RIVET_TRUST_PROJECT = '0'
    const req = engineAt(cwd).buildOaiRequest([{ role: 'user', content: 'hi' }])
    assert.doesNotMatch(joined(req.messages), /UNTRUSTED_AGENTS_SENTINEL_218/)
  })

  it('engine path injects AGENTS.md from a trusted project dir', () => {
    const cwd = tmpProject('TRUSTED_AGENTS_SENTINEL_218')
    process.env.RIVET_TRUST_PROJECT = '1'
    const req = engineAt(cwd).buildOaiRequest([{ role: 'user', content: 'hi' }])
    assert.match(joined(req.messages), /TRUSTED_AGENTS_SENTINEL_218/)
  })

  it('snapshot path does NOT inject AGENTS.md from an untrusted project dir', () => {
    const cwd = tmpProject('UNTRUSTED_SNAPSHOT_SENTINEL_218')
    // 隔离 home，避免触碰真实 ~/.rivet（与 project-trust.test.ts 同纪律）。
    const home = mkdtempSync(join(tmpdir(), 'rivet-trust-gate-home-'))
    tmpDirs.push(home)
    process.env.RIVET_HOME = home
    process.env.RIVET_TRUST_PROJECT = '0'
    const snapshot = createVolatileSnapshot({ cwd, getGitStatus: () => undefined })
    assert.equal(snapshot.rivetMd, undefined)
  })

  it('snapshot path injects AGENTS.md from a trusted project dir', () => {
    const cwd = tmpProject('TRUSTED_SNAPSHOT_SENTINEL_218')
    const home = mkdtempSync(join(tmpdir(), 'rivet-trust-gate-home-'))
    tmpDirs.push(home)
    process.env.RIVET_HOME = home
    process.env.RIVET_TRUST_PROJECT = '1'
    const snapshot = createVolatileSnapshot({ cwd, getGitStatus: () => undefined })
    assert.match(snapshot.rivetMd ?? '', /TRUSTED_SNAPSHOT_SENTINEL_218/)
  })
})

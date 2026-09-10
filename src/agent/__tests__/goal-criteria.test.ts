import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ReadableStream } from 'node:stream/web'

import {
  buildCriteriaExtractionUser,
  extractGoalCriteria,
  GENERIC_SUCCESS_CRITERIA,
  parseCriteria,
  buildCheapClient,
  type CompletionFn,
} from '../goal-criteria.js'
import type { ProviderConfig } from '../../config/schema.js'

describe('parseCriteria', () => {
  it('parses a bare JSON array', () => {
    assert.deepEqual(parseCriteria('["a", "b", "c"]'), ['a', 'b', 'c'])
  })

  it('extracts the array out of surrounding prose and code fences', () => {
    const text = 'Sure! Here are the criteria:\n```json\n["x", "y"]\n```\nDone.'
    assert.deepEqual(parseCriteria(text), ['x', 'y'])
  })

  it('drops non-string and empty entries', () => {
    assert.deepEqual(parseCriteria('["a", 1, "", "  b  ", null]'), ['a', 'b'])
  })

  it('returns null for non-array / unparseable / empty', () => {
    assert.equal(parseCriteria('{"a":1}'), null)
    assert.equal(parseCriteria('not json at all'), null)
    assert.equal(parseCriteria('[]'), null)
    assert.equal(parseCriteria(''), null)
  })
})

describe('buildCriteriaExtractionUser', () => {
  it('embeds the trimmed goal', () => {
    const out = buildCriteriaExtractionUser('  add a feature  ')
    assert.match(out, /Goal:\nadd a feature/)
  })
})

describe('extractGoalCriteria', () => {
  it('returns parsed criteria on a well-formed response', async () => {
    const complete: CompletionFn = async () => '["c1", "c2", "c3"]'
    const out = await extractGoalCriteria('goal', complete)
    assert.deepEqual(out, ['c1', 'c2', 'c3'])
  })

  it('caps criteria at 8', async () => {
    const many = JSON.stringify(Array.from({ length: 12 }, (_, i) => `c${i}`))
    const complete: CompletionFn = async () => many
    const out = await extractGoalCriteria('goal', complete)
    assert.equal(out.length, 8)
  })

  it('falls back to the generic template when the model output is unusable', async () => {
    const complete: CompletionFn = async () => 'no json here'
    const out = await extractGoalCriteria('goal', complete)
    assert.deepEqual(out, [...GENERIC_SUCCESS_CRITERIA])
  })

  it('falls back to the generic template when the call throws', async () => {
    const complete: CompletionFn = async () => { throw new Error('boom') }
    const out = await extractGoalCriteria('goal', complete)
    assert.deepEqual(out, [...GENERIC_SUCCESS_CRITERIA])
  })

  it('forwards the abort signal to the completion fn', async () => {
    const ac = new AbortController()
    let seen: AbortSignal | undefined
    const complete: CompletionFn = async (_s, _u, signal) => {
      seen = signal
      return '["ok"]'
    }
    await extractGoalCriteria('goal', complete, ac.signal)
    assert.equal(seen, ac.signal)
  })
})

describe('buildCheapClient', () => {
  it('returns null when provider is not configured', () => {
    const result = buildCheapClient({ provider: 'nonexistent', model: 'm' }, {})
    assert.equal(result, null)
  })

  it('returns null when provider has no apiKey', () => {
    const providers = {
      test: { name: 'test', type: 'openai', models: [{ id: 'm', maxTokens: 4096, contextWindow: 32000 }] },
    }
    const result = buildCheapClient({ provider: 'test', model: 'm' }, providers as unknown as Record<string, ProviderConfig>)
    assert.equal(result, null)
  })

  it('returns null when resolveApiKey throws', () => {
    // Provider exists but apiKey is explicitly empty — resolveApiKey throws
    const providers = {
      test: { name: 'test', type: 'openai', apiKey: '', models: [{ id: 'm', maxTokens: 4096, contextWindow: 32000 }] },
    }
    const result = buildCheapClient({ provider: 'test', model: 'm' }, providers as unknown as Record<string, ProviderConfig>)
    assert.equal(result, null)
  })
})

// ── buildCheapClient 的会话 ID 透传 ──────────────────────────────────
// 判据抽取是主会话的 side-path。不带会话 ID 时会落到 factory 的进程级兜底，
// 多会话同进程（桌面端多窗口）下上游会把这些请求当成同一段对话；带了才
// 与所在会话同源。这条断言直接钉住新参数的接线。

function goalCheapProvider(): ProviderConfig {
  return {
    name: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    protocol: 'openai',
    capabilities: {
      cacheControl: false,
      stripParams: [],
      toolJsonBug: true,
      prefixCache: 'deepseek-native',
      prefixCompletion: true,
    },
    thinking: 'enabled',
    maxTokens: 8192,
    models: [{ id: 'deepseek-v4-flash', contextWindow: 128_000, maxTokens: 8192 }],
    unsupported: [],
    apiKey: 'sk-test',
  }
}

describe('buildCheapClient 会话 ID', () => {
  it('把调用方的 sessionId 透传给 client 的请求头', async () => {
    const built = buildCheapClient(
      { provider: 'deepseek', model: 'deepseek-v4-flash' },
      { deepseek: goalCheapProvider() },
      'sess-goal-1',
    )
    assert.ok(built, 'provider 配置齐全时应能构建 client')

    const originalFetch = globalThis.fetch
    let captured: Record<string, string> = {}
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      captured = (init?.headers ?? {}) as Record<string, string>
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'))
          controller.close()
        },
      })
      return new Response(stream as unknown as ReadableStream, { status: 200 })
    }) as unknown as typeof fetch

    try {
      await built.client.stream(
        { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 } as never,
        {
          onTextDelta: () => {},
          onThinkingDelta: () => {},
          onContentBlock: () => {},
          onStopReason: () => {},
          onError: () => {},
        } as never,
      )
    } finally {
      globalThis.fetch = originalFetch
    }

    assert.equal(captured['X-Request-Session'], 'sess-goal-1')
  })

  it('未传 sessionId 时不带该头（普通 provider 不被污染）', async () => {
    const built = buildCheapClient(
      { provider: 'deepseek', model: 'deepseek-v4-flash' },
      { deepseek: goalCheapProvider() },
    )
    assert.ok(built)

    const originalFetch = globalThis.fetch
    let captured: Record<string, string> = {}
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      captured = (init?.headers ?? {}) as Record<string, string>
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'))
          controller.close()
        },
      })
      return new Response(stream as unknown as ReadableStream, { status: 200 })
    }) as unknown as typeof fetch

    try {
      await built.client.stream(
        { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 } as never,
        {
          onTextDelta: () => {},
          onThinkingDelta: () => {},
          onContentBlock: () => {},
          onStopReason: () => {},
          onError: () => {},
        } as never,
      )
    } finally {
      globalThis.fetch = originalFetch
    }

    assert.equal(captured['X-Request-Session'], undefined)
  })
})

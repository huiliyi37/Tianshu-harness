import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIClient } from '../openai-client.js'
import { UsageSettlement } from '../usage-settlement.js'
import { summarizeCacheLog } from '../../cache/cache-log-summary.js'
import { classifyApiError } from '../error-classifier.js'

function client() { return new OpenAIClient({ baseUrl: 'https://example.test/v1', apiKey: 'fixture', model: 'step-5-preview', maxTokens: 4096 }) }
const combined = { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10000, completion_tokens: 100 } }
const trailing = { choices: [], usage: { prompt_tokens: 10000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 9000 } } }

test('real SSE parser settles combined and trailing usage once, preserving tool reason', async () => {
  const events: any[] = []
  const reader = new ReadableStream<Uint8Array>({ start(c) {
    c.enqueue(new TextEncoder().encode([combined, trailing, trailing].map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n')); c.close()
  } }).getReader()
  await client().parseStreamFromReader(reader, { onStopReason: (reason, usage) => events.push({ reason, usage }) })
  assert.equal(events.length, 1)
  assert.equal(events[0].reason, 'tool_use')
  assert.equal(events[0].usage.input_tokens, 10000)
  assert.equal(events[0].usage.cache_read_input_tokens, 9000)
  assert.equal(events[0].usage.observation.fields.cache_creation_input_tokens, undefined)
})

test('interrupted attempt reports observed usage without a successful stop', async () => {
  let pulls = 0; const stops: unknown[] = [], aborts: any[] = []
  const reader = new ReadableStream<Uint8Array>({ pull(c) {
    if (pulls++ === 0) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(combined)}\n\n`))
    else c.error(new Error('connection lost'))
  } }).getReader()
  await assert.rejects(client().parseStreamFromReader(reader, { onStopReason: (...x) => stops.push(x), onStreamAttemptAborted: x => aborts.push(x) }))
  assert.equal(stops.length, 0)
  assert.equal(aborts[0].usage.input_tokens, 10000)
  assert.equal(aborts[0].usage.observation.status, 'aborted')
})

test('usage merge distinguishes omitted fields from explicit zero and settles once', () => {
  const s = new UsageSettlement()
  s.observe({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 60 } }, 'tool_calls')
  s.observe({ completion_tokens: 20 })
  s.observe({ prompt_tokens_details: { cached_tokens: 0 } })
  const u = s.finish({ requestId: 'r', attemptId: 'r:1' }, 'complete')!
  assert.equal(u.input_tokens, 100); assert.equal(u.cache_read_input_tokens, 0)
  assert.equal(u.cache_creation_input_tokens, undefined)
  assert.equal(s.finish({ requestId: 'r', attemptId: 'r:1' }, 'complete'), undefined)
})

test('offline cache denominator is inclusive input, with unknown coverage', () => {
  const result = summarizeCacheLog([{ turn: 1, input: 100, cacheRead: 60, cacheCreate: 0 }, { turn: 1, cacheRead: 100, cacheCreate: 0 }])
  assert.equal(result.turn1Plus.hitRate.average, 60)
  assert.equal(result.turn1Plus.hitRate.unknown, 1)
})

test('session totals account one attempt once and expose unknown cache fields separately', async () => {
  const { SessionContext } = await import('../../agent/context.js')
  const session = new SessionContext()
  const usage = { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 60, cache_creation_input_tokens: 0,
    observation: { requestId: 'r', attemptId: 'r:1', status: 'complete' as const, fields: { input_tokens: 'prompt_tokens', cache_read_input_tokens: 'cached_tokens' } } }
  session.addUsage(usage); session.addUsage(usage)
  session.addUsage({ ...usage, observation: { ...usage.observation, attemptId: 'r:2', fields: {} } })
  assert.equal(session.getTotalUsage().input_tokens, 200)
  assert.equal(session.getTotalUsage().cacheCoverage?.creationUnknown, 2)
  assert.equal(session.getCacheHitRate(), .6)
})

test('real dispatch captures final post-guard bytes and stable attempt identity', async () => {
  const { createHash } = await import('node:crypto')
  const original = globalThis.fetch
  const sent: any[] = [], usages: any[] = []
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)))
    return new Response(`data: ${JSON.stringify(trailing)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    const c = new OpenAIClient({ baseUrl: 'https://example.test/v1', apiKey: 'fixture', model: 'fixture', maxTokens: 4096, maxBodyBytes: 20000 })
    const messages: any[] = [{ role: 'system', content: 'system' }, { role: 'user', content: 'task' },
      { role: 'assistant', content: null, tool_calls: [{ id: 't', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't', content: 'Z'.repeat(100000) },
      ...Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message ${i}` }))]
    await c.stream({ model: 'fixture', max_tokens: 4096, messages, prefixProbe: true }, { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onError() {}, onStopReason: (_r, u) => usages.push(u) })
    const prefix = usages[0].observation.prefix
    assert.equal(usages.length, 1)
    assert.ok(usages[0].observation.attemptId.startsWith(usages[0].observation.requestId))
    assert.ok(JSON.stringify(sent[0]).length < 20000, 'fixture must activate body guard')
    assert.equal(prefix.history, createHash('sha256').update(JSON.stringify(sent[0].messages.filter((m: any) => m.role !== 'system'))).digest('hex'))
    assert.equal(prefix.chars, JSON.stringify(sent[0].messages).length)
    assert.ok(!JSON.stringify(prefix).includes('ZZZZ'), 'only digests, never content')
  } finally { globalThis.fetch = original }
})


test('unknown cache fields are excluded from the observed hit-rate denominator', async () => {
  const { SessionContext } = await import('../../agent/context.js')
  const session = new SessionContext()
  session.addUsage({
    input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 60, cache_creation_input_tokens: 0,
    observation: { requestId: 'r', attemptId: 'r:1', status: 'complete' as const, fields: { input_tokens: 'prompt_tokens', cache_read_input_tokens: 'cached_tokens' } },
  })
  session.addUsage({
    input_tokens: 500, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    observation: { requestId: 'r', attemptId: 'r:2', status: 'complete' as const, fields: {} },
  })
  assert.equal(session.getCacheHitRate(), 0.6)
})

test('retry attempt probes the bytes actually sent, not the pre-transform template', async () => {
  const { createHash } = await import('node:crypto')
  const originalFetch = globalThis.fetch
  const calls: Array<{ messages: Array<Record<string, unknown>> }> = []
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)) as { messages: Array<Record<string, unknown>> })
    if (calls.length === 1) {
      return new Response(JSON.stringify({ error: { message: 'Request too large' } }), {
        status: 413, headers: { 'content-type': 'application/json' },
      })
    }
    const body = { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 40 } }
    return new Response(`data: ${JSON.stringify(body)}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  try {
    const client = new OpenAIClient({
      baseUrl: 'https://example.test/v1', apiKey: 'fixture', model: 'fixture', maxTokens: 4096,
      retry: { backoff: { baseDelayMs: 1, jitterRatio: 0 } },
    } as ConstructorParameters<typeof OpenAIClient>[0])
    const aborted: any[] = []
    const stopped: any[] = []
    await client.stream({
      model: 'fixture', max_tokens: 4096, prefixProbe: true,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      ],
    }, {
      onTextDelta: () => {}, onThinkingDelta: () => {}, onContentBlock: () => {},
      onError: (err: Error) => { throw err },
      onStreamAttemptAborted: (info: any) => aborted.push(info),
      onStopReason: (_reason: string, usage: any) => stopped.push(usage),
    })
    assert.equal(calls.length, 2)
    assert.equal(aborted.length, 1)
    assert.equal(stopped.length, 1)
    assert.equal(aborted[0].usage.observation.prefix.history, createHash('sha256').update(JSON.stringify(calls[0]!.messages.filter(m => m.role !== 'system'))).digest('hex'))
    assert.equal(stopped[0].observation.prefix.history, createHash('sha256').update(JSON.stringify(calls[1]!.messages.filter(m => m.role !== 'system'))).digest('hex'))
    assert.notEqual(aborted[0].usage.observation.attemptId, stopped[0].observation.attemptId)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('two clients replaying one logical request mint globally unique attempt ids', async () => {
  const originalFetch = globalThis.fetch
  const usages: any[] = []
  globalThis.fetch = (async () => new Response(
    `data: ${JSON.stringify(trailing)}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )) as typeof fetch
  try {
    const request: any = {
      model: 'fixture', max_tokens: 4096, messages: [{ role: 'user', content: 'hi' }],
      // FallbackStreamClient replays the same request object through another
      // provider client, so both attempts share this requestId on purpose.
      contextBudget: { requestId: 'shared-request', revision: 0 },
    }
    const callbacks: any = {
      onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onError() {},
      onStopReason: (_reason: string, usage: any) => usages.push(usage),
    }
    await new OpenAIClient({ baseUrl: 'https://example.test/v1', apiKey: 'fixture', model: 'fixture', maxTokens: 4096 }).stream(request, callbacks)
    await new OpenAIClient({ baseUrl: 'https://example.test/v1', apiKey: 'fixture', model: 'fixture', maxTokens: 4096 }).stream(request, callbacks)

    assert.equal(usages.length, 2)
    assert.equal(usages[0].observation.requestId, 'shared-request')
    assert.equal(usages[1].observation.requestId, 'shared-request')
    assert.notEqual(usages[0].observation.attemptId, usages[1].observation.attemptId,
      'failover must not collide on requestId:attemptId — the fallback usage would be deduped away')

    const { SessionContext } = await import('../../agent/context.js')
    const session = new SessionContext()
    session.addUsage(usages[0])
    session.addUsage(usages[1])
    assert.equal(session.getTotalUsage().input_tokens, 20000,
      'both actual sends must be accounted; the fallback success cannot be swallowed by a colliding identity')
  } finally { globalThis.fetch = originalFetch }
})

test('abort while a read is pending settles the attempt as aborted, not complete', async () => {
  const openai = client()
  const encoder = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
  const reader = new Response(stream).body!.getReader()
  const abort = new AbortController()
  const stops: unknown[] = [], aborts: any[] = []
  const promise = openai.parseStreamFromReader(reader, {
    onStopReason: (...args) => stops.push(args),
    onStreamAttemptAborted: info => aborts.push(info),
  }, abort.signal).catch(error => error as Error)

  await new Promise<void>(resolve => setImmediate(resolve))
  controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'))
  await new Promise<void>(resolve => setImmediate(resolve))
  abort.abort()
  const error = await promise

  assert.equal(stops.length, 0, 'a cancelled stream must not emit a successful stop reason')
  assert.equal(aborts.length, 1, 'a cancelled stream must record the aborted attempt')
  assert.equal(aborts[0].usage.observation.status, 'aborted')
  assert.equal((error as Error).name, 'AbortError')
})

test('EOF without [DONE] but with a terminal finish_reason settles as a successful completion', async () => {
  const openai = client()
  const encoder = new TextEncoder()
  const reader = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":10}}\n\n'))
      c.close()
    },
  }).getReader()
  const stops: unknown[] = [], aborts: any[] = []
  const error = await openai.parseStreamFromReader(reader, {
    onStopReason: (...args) => stops.push(args),
    onStreamAttemptAborted: info => aborts.push(info),
  }).then(() => null, (err: Error) => err)

  assert.equal(error, null, 'a terminal finish_reason proves the turn completed even without [DONE]')
  assert.equal(stops.length, 1, 'the tolerant settle must emit a successful stop reason')
  assert.equal((stops[0] as any[])[0], 'end_turn')
  assert.equal((stops[0] as any[])[1].input_tokens, 100)
  assert.equal(aborts.length, 0, 'a completed turn carries no abort breadcrumb')
})

test('EOF without [DONE] and without finish_reason is an incomplete/aborted attempt', async () => {
  const openai = client()
  const encoder = new TextEncoder()
  const reader = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}],"usage":{"prompt_tokens":100,"completion_tokens":10}}\n\n'))
      c.close()
    },
  }).getReader()
  const stops: unknown[] = [], aborts: any[] = []
  const error = await openai.parseStreamFromReader(reader, {
    onStopReason: (...args) => stops.push(args),
    onStreamAttemptAborted: info => aborts.push(info),
  }).then(() => null, (err: Error) => err)

  assert.ok(error)
  assert.equal((error as Error).name, 'IncompleteStreamError')
  assert.equal(classifyApiError(error).category, 'stream_parse', 'missing [DONE] must stay retryable/failover-able')
  assert.equal(stops.length, 0, 'a truncated EOF must not emit a successful stop reason')
  assert.equal(aborts.length, 1, 'a truncated EOF must record the aborted attempt')
  assert.equal(aborts[0].usage.observation.status, 'aborted')
  assert.equal(aborts[0].usage.input_tokens, 100, 'already-observed usage stays on the abort breadcrumb')
})

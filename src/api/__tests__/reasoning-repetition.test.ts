import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIClient } from '../openai-client.js'
import { classifyApiError, errorRecoveryGuidance } from '../error-classifier.js'
import type { StreamCallbacks } from '../stream-client.js'

// A custom ID verifies provider-level protection without a model-name allowlist.
const model = 'deepseek-custom-flash'
const config = {
  apiKey: 'test', baseUrl: 'https://api.deepseek.com', model,
  maxTokens: 4096, providerName: 'deepseek', thinking: 'enabled' as const,
}
const frame = (delta: Record<string, unknown>, finish_reason?: string) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`

async function parse(deltas: Record<string, unknown>[], options: { residual?: boolean; provider?: string; prefix?: string; finishAt?: number; onThinking?: (s: string) => void } = {}) {
  const thinking: string[] = []
  const blocks: unknown[] = []
  const aborted: unknown[] = []
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      const wire = (options.prefix ?? '') + deltas.map((delta, i) => frame(delta, i === options.finishAt ? 'tool_calls' : undefined)).join('')
      c.enqueue(new TextEncoder().encode(options.residual ? wire.trimEnd() : wire + 'data: [DONE]\n\n'))
      // Residual parsing runs on EOF; other tests leave the transport open to
      // verify that stopping a degenerate response releases its reader.
      if (options.residual) c.close()
    },
    cancel() { cancelled = true },
  })
  const client = new OpenAIClient({ ...config, providerName: options.provider ?? 'deepseek' })
  let error: unknown
  try {
    await client.parseStreamFromReader(stream.getReader(), {
      onTextDelta() {}, onThinkingDelta(s) { thinking.push(s); options.onThinking?.(s) },
      onContentBlock(b) { blocks.push(b) }, onStopReason() {},
      onStreamAttemptAborted(info) { aborted.push(info) },
    })
  } catch (e) { error = e }
  return { error, thinking: thinking.join(''), blocks, aborted, cancelled }
}

describe('DeepSeek streaming reasoning repetition', () => {
  it('stops hundreds of short repeated reasoning lines before committing a completed turn', async () => {
    const result = await parse(Array.from({ length: 300 }, () => ({ reasoning_content: '好。\n' })))
    assert.ok(result.error instanceof Error)
    assert.equal(result.error.name, 'ReasoningRepetitionError')
    assert.ok(result.thinking.length < 900)
    assert.equal(result.blocks.length, 0)
    assert.equal(result.aborted.length, 1)
    assert.equal(result.cancelled, true)
    assert.equal(classifyApiError(result.error).retryable, false)
    assert.equal(classifyApiError(result.error).shouldReconnect, false)
    assert.match(errorRecoveryGuidance(result.error), /重复/)
  })

  it('recognizes a short-phrase cycle across individual character deltas', async () => {
    const text = '好。\n好，我发送。\n（发送）\n'.repeat(80)
    const result = await parse([...text].map(reasoning_content => ({ reasoning_content })))
    assert.equal((result.error as Error)?.name, 'ReasoningRepetitionError')
  })

  it('also checks the final SSE event without a newline', async () => {
    const result = await parse([{ reasoning_content: '好。\n'.repeat(300) }], { residual: true })
    assert.equal((result.error as Error)?.name, 'ReasoningRepetitionError')
  })

  it('preserves healthy long reasoning and occasional repeated phrases byte-for-byte', async () => {
    const text = Array.from({ length: 300 }, (_, i) => `步骤 ${i}：核对不同证据，继续分析。\n好。\n`).join('')
    const result = await parse([{ reasoning_content: text }, { content: '完成' }])
    assert.equal(result.error, undefined)
    assert.equal(result.thinking, text)
    assert.deepEqual(result.blocks[0], { type: 'thinking', thinking: text })
  })

  it('leaves short acknowledgements, other providers and answer text alone', async () => {
    assert.equal((await parse([{ reasoning_content: '好。\n'.repeat(12) }])).error, undefined)
    assert.equal((await parse([{ reasoning_content: '好。\n'.repeat(300) }], { provider: 'mimo' })).error, undefined)
    assert.equal((await parse([{ content: '好。\n'.repeat(300) }])).error, undefined)
  })

  it('does not classify late reasoning after tool-call progress as a thinking-only loop', async () => {
    const result = await parse([
      { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
      { reasoning_content: '好。\n'.repeat(300) },
    ])
    assert.equal(result.error, undefined)
  })

  it('does not re-arm the guard after finish_reason flushes a completed tool call', async () => {
    const result = await parse([
      { reasoning_content: '好。\n'.repeat(127) },
      { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
      { reasoning_content: '好。\n' },
    ], { finishAt: 1 })
    assert.equal(result.error, undefined)
    assert.ok(result.blocks.some(b => (b as { type: string }).type === 'tool_use'))
    assert.ok(result.blocks.some(b => (b as { type: string }).type === 'thinking'))
  })

  it('skips malformed JSON and structurally empty events', async () => {
    const result = await parse([{ reasoning_content: 'normal' }], {
      prefix: 'data: {bad json\n\ndata: null\n\ndata: {"choices":[{}]}\n\n',
    })
    assert.equal(result.error, undefined)
    assert.equal(result.thinking, 'normal')
  })

  it('preserves reasoning arriving together with the first content delta', async () => {
    const result = await parse([{ reasoning_content: '思考完成', content: '完成' }])
    assert.equal(result.error, undefined)
    assert.deepEqual(result.blocks[0], { type: 'thinking', thinking: '思考完成' })
  })

  it('propagates consumer errors instead of swallowing them', async () => {
    const expected = new Error('consumer failed')
    const result = await parse([{ reasoning_content: 'normal' }], { onThinking() { throw expected } })
    assert.equal(result.error, expected)
  })

  it('does not retry or re-inject a degenerate reasoning prefix', async () => {
    const original = globalThis.fetch
    let attempts = 0
    globalThis.fetch = async () => {
      attempts++
      return new Response(frame({ reasoning_content: '好。\n'.repeat(300) }) + 'data: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    try {
      const noop = () => {}
      const cb: StreamCallbacks = { onTextDelta: noop, onThinkingDelta: noop, onContentBlock: noop, onStopReason: noop, onError: noop }
      await assert.rejects(new OpenAIClient(config).stream({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 4096 }, cb), { name: 'ReasoningRepetitionError' })
      assert.equal(attempts, 1)
    } finally { globalThis.fetch = original }
  })
})

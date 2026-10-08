import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIClient } from '../openai-client.js'
import { classifyApiError } from '../error-classifier.js'

// Issue #390: providers (MiniMax-M3 on large-context sessions) can legally end
// a turn with a terminal finish_reason yet omit the trailing `data: [DONE]`
// marker. The parser must tolerate a proven-complete turn, while still treating
// a bare EOF (no finish_reason) as an incomplete/aborted attempt.

function client() {
  return new OpenAIClient({ baseUrl: 'https://example.test/v1', apiKey: 'fixture', model: 'fixture', maxTokens: 4096 })
}

function mockReader(...frames: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const frame of frames) c.enqueue(encoder.encode(frame))
      c.close()
    },
  }).getReader()
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

test('① [DONE] present → normal completion', async () => {
  const stops: any[] = [], aborts: any[] = []
  const error = await client().parseStreamFromReader(
    mockReader(sse({ choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }), 'data: [DONE]\n\n'),
    { onStopReason: (...args) => stops.push(args), onStreamAttemptAborted: info => aborts.push(info) },
  ).then(() => null, (err: Error) => err)

  assert.equal(error, null)
  assert.equal(stops.length, 1)
  assert.equal(stops[0][0], 'end_turn')
  assert.equal(aborts.length, 0)
})

test('② [DONE] missing but finish_reason=tool_calls → normal completion, no throw', async () => {
  const stops: any[] = [], aborts: any[] = []
  const error = await client().parseStreamFromReader(
    mockReader(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', type: 'function', function: { name: 'read', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })),
    { onStopReason: (...args) => stops.push(args), onStreamAttemptAborted: info => aborts.push(info) },
  ).then(() => null, (err: Error) => err)

  assert.equal(error, null, 'a terminal tool_calls finish_reason proves completion without [DONE]')
  assert.equal(stops.length, 1)
  assert.equal(stops[0][0], 'tool_use')
  assert.equal(stops[0][1].input_tokens, 10)
  assert.equal(aborts.length, 0)
})

test('③ [DONE] missing and finish_reason absent → IncompleteStreamError', async () => {
  const stops: any[] = [], aborts: any[] = []
  const error = await client().parseStreamFromReader(
    mockReader(sse({ choices: [{ delta: { content: 'partial' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } })),
    { onStopReason: (...args) => stops.push(args), onStreamAttemptAborted: info => aborts.push(info) },
  ).then(() => null, (err: Error) => err)

  assert.ok(error)
  assert.equal((error as Error).name, 'IncompleteStreamError')
  assert.equal(classifyApiError(error).category, 'stream_parse', 'must stay retryable/failover-able')
  assert.equal(stops.length, 0)
  assert.equal(aborts.length, 1)
  assert.equal(aborts[0].usage.observation.status, 'aborted')
})

test('④ [DONE] missing but finish_reason=stop with content → normal completion', async () => {
  const stops: any[] = [], aborts: any[] = []
  const error = await client().parseStreamFromReader(
    mockReader(sse({ choices: [{ delta: { content: 'full answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4 } })),
    { onStopReason: (...args) => stops.push(args), onStreamAttemptAborted: info => aborts.push(info) },
  ).then(() => null, (err: Error) => err)

  assert.equal(error, null)
  assert.equal(stops.length, 1)
  assert.equal(stops[0][0], 'end_turn')
  assert.equal(stops[0][1].input_tokens, 10)
  assert.equal(aborts.length, 0)
})

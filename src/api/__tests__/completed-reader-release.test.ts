import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { OpenAIClient } from '../openai-client.js'

const terminal = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"synthetic"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
const client = () => new OpenAIClient({ baseUrl: 'https://synthetic.invalid/v1', apiKey: 'synthetic', model: 'synthetic', maxTokens: 100 })

test('data trailing DONE in the same transport chunk is never emitted', async () => {
  const trailing = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"TRAILING"}}]}')
  const combined = new Uint8Array(terminal.byteLength + trailing.byteLength)
  combined.set(terminal)
  combined.set(trailing, terminal.byteLength)
  const text: string[] = []
  await client().parseStreamFromReader(new Response(combined).body!.getReader(), { onTextDelta(value) { text.push(value) } })
  assert.equal(text.join(''), 'synthetic')
})

test('successful drain retains independent user cancellation until EOF and releases signal listeners', async () => {
  const lifecycle = new AbortController()
  const user = new AbortController()
  let cancelCount = 0
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(terminal) }, cancel() { cancelCount++ } })
  await client().parseStreamFromReader(stream.getReader(), {}, user.signal, undefined, lifecycle)
  assert.equal(lifecycle.signal.aborted, false)
  user.abort()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(cancelCount, 1)
  assert.equal(lifecycle.signal.aborted, true)
  assert.equal(getEventListeners(user.signal, 'abort').length, 0)
  assert.equal(getEventListeners(lifecycle.signal, 'abort').length, 0)
})

test('successful EOF releases the reader and both signals without aborting either', async () => {
  const lifecycle = new AbortController()
  const user = new AbortController()
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(terminal); controller.close() } })
  await client().parseStreamFromReader(stream.getReader(), {}, user.signal, undefined, lifecycle)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(stream.locked, false)
  assert.equal(user.signal.aborted, false)
  assert.equal(lifecycle.signal.aborted, false)
  assert.equal(getEventListeners(user.signal, 'abort').length, 0)
  assert.equal(getEventListeners(lifecycle.signal, 'abort').length, 0)
})

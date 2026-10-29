import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Agent, fetch as undiciFetch } from 'undici'
import { OpenAIClient } from '../openai-client.js'

const encoder = new TextEncoder()
const completed = 'data: {"choices":[{"delta":{"content":"COMPLETE"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
const client = () => new OpenAIClient({ apiKey: 'synthetic', baseUrl: 'http://127.0.0.1', model: 'synthetic-model', maxTokens: 512 })

test('completed SSE returns before EOF and preserves the actual connection for the next request', async () => {
  let connections = 0
  let releaseFirst!: () => void
  const firstMayEnd = new Promise<void>(resolve => { releaseFirst = resolve })
  let received = 0
  const server = createServer(async (_request, response) => {
    const first = ++received === 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(completed)
    if (first) await firstMayEnd
    response.end()
  })
  server.on('connection', () => { connections++ })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const agent = new Agent({ connections: 1, keepAliveTimeout: 10000 })
  try {
    const lifecycle = new AbortController()
    const response = await undiciFetch('http://127.0.0.1:' + port, { dispatcher: agent, signal: lifecycle.signal })
    await client().parseStreamFromReader(response.body!.getReader(), {}, lifecycle.signal, undefined, lifecycle)
    assert.equal(lifecycle.signal.aborted, false, 'successful completion must not destroy a connection before a bounded EOF drain')
    releaseFirst()
    const next = await undiciFetch('http://127.0.0.1:' + port, { dispatcher: agent, signal: AbortSignal.timeout(3000) })
    await next.text()
    assert.equal(connections, 1, 'the second request must reuse the real first socket')
  } finally {
    releaseFirst()
    await agent.destroy()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('the actual public stream caller preserves a completed connection across two model requests', async context => {
  let connections = 0
  let received = 0
  let releaseFirst!: () => void
  const firstMayEnd = new Promise<void>(resolve => { releaseFirst = resolve })
  const server = createServer(async (request, response) => {
    request.resume()
    const first = ++received === 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(completed)
    if (first) await firstMayEnd
    response.end()
  })
  server.on('connection', () => { connections++ })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const agent = new Agent({ connections: 1, keepAliveTimeout: 10000 })
  const transport = context.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    assert.equal(typeof input, 'string')
    return await undiciFetch(String(input), { ...init, dispatcher: agent } as Parameters<typeof undiciFetch>[1]) as unknown as Response
  })
  try {
    const model = new OpenAIClient({ apiKey: 'synthetic', baseUrl: 'http://127.0.0.1:' + port + '/v1', model: 'synthetic-model', maxTokens: 512, maxRetries: 0 })
    const request = { model: 'synthetic-model', messages: [{ role: 'user' as const, content: 'synthetic' }], stream: true as const }
    const callbacks = { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError(error: Error) { throw error } }
    await model.stream(request, callbacks)
    releaseFirst()
    await model.stream(request, callbacks)
    assert.equal(received, 2)
    assert.equal(connections, 1, 'outer stream cleanup must not abort the parser-owned successful EOF drain')
  } finally {
    releaseFirst()
    transport.mock.restore()
    await agent.destroy()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('a terminal marker cannot leave an indefinitely open response alive', async () => {
  let cancelled!: () => void
  const cancellation = new Promise<void>(resolve => { cancelled = resolve })
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode(completed)) },
    cancel() { cancelled() },
  })
  const lifecycle = new AbortController()
  lifecycle.signal.addEventListener('abort', cancelled, { once: true })
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    await client().parseStreamFromReader(stream.getReader(), {}, lifecycle.signal, undefined, lifecycle)
    assert.equal(lifecycle.signal.aborted, false, 'completion must return before waiting for EOF')
    await Promise.race([cancellation, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('completed response cleanup remained unbounded')), 2500) })])
    assert.equal(lifecycle.signal.aborted, true)
  } finally {
    if (deadline) clearTimeout(deadline)
  }
})

test('excess data after a terminal marker is bounded and never emitted as model output', async () => {
  let cancelled!: () => void
  const cancellation = new Promise<void>(resolve => { cancelled = resolve })
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(completed))
      controller.enqueue(new Uint8Array(32769))
    },
    cancel() { cancelled() },
  })
  const lifecycle = new AbortController()
  lifecycle.signal.addEventListener('abort', cancelled, { once: true })
  const text: string[] = []
  await client().parseStreamFromReader(stream.getReader(), { onTextDelta: value => { text.push(value) } }, lifecycle.signal, undefined, lifecycle)
  await cancellation
  assert.equal(lifecycle.signal.aborted, true)
  assert.equal(text.join(''), 'COMPLETE')
})

test('user cancellation still closes a response waiting for EOF immediately', async () => {
  let cancelled!: () => void
  const cancellation = new Promise<void>(resolve => { cancelled = resolve })
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode(completed)) },
    cancel() { cancelled() },
  })
  const lifecycle = new AbortController()
  await client().parseStreamFromReader(stream.getReader(), {}, lifecycle.signal, undefined, lifecycle)
  assert.equal(lifecycle.signal.aborted, false)
  lifecycle.abort()
  await cancellation
})

test('empty chunks after a terminal marker cannot starve the cleanup deadline', async () => {
  let reads = 0
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode(completed)) },
    pull(controller) {
      reads++
      if (reads > 256) controller.error(new Error('bounded test producer ended'))
      else controller.enqueue(new Uint8Array(0))
    },
  })
  const lifecycle = new AbortController()
  let cancelled!: () => void
  const cancellation = new Promise<void>(resolve => { cancelled = resolve })
  lifecycle.signal.addEventListener('abort', cancelled, { once: true })
  await client().parseStreamFromReader(stream.getReader(), {}, lifecycle.signal, undefined, lifecycle)
  await cancellation
  assert.ok(reads <= 66, 'cleanup must cap empty chunks as well as bytes, not rely on timer scheduling')
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GeminiClient } from '../gemini-client.js'
import { ResponsesClient } from '../responses-client.js'
import { TurnStreamController } from '../../agent/turn-stream.js'
import type { StreamAttemptAbortedInfo } from '../stream-client.js'

const config = {
  baseUrl: 'http://127.0.0.1:1', apiKey: 'fictional-fixture', model: 'fictional-model', maxTokens: 100,
  requestTimeoutMs: 25, firstByteTimeoutMs: 1000, maxRetries: 0,
}
const request = { model: 'fictional-model', messages: [{ role: 'user' as const, content: 'fictional task' }] }

for (const Client of [GeminiClient, ResponsesClient]) {
  for (const mode of ['user-abort', 'hard-timeout'] as const) {
    // Dropping the post-read abort check must make this test resolve successfully.
    test(`${Client.name} rejects ${mode} while waiting for the next read`, async () => {
      const originalFetch = globalThis.fetch
      const abort = new AbortController()
      let stopped = false
      let canceled = false
      try {
        globalThis.fetch = (async () => new Response(new ReadableStream({
          pull() { if (mode === 'user-abort') setTimeout(() => abort.abort(), 0) },
          cancel() { canceled = true },
        }))) as typeof fetch
        await assert.rejects(new Client(config).stream(request, {
          onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onError() {},
          onStopReason() { stopped = true },
        }, abort.signal), mode === 'user-abort' ? { name: 'AbortError' } : /hard timeout/)
        assert.equal(stopped, false, 'interruption cannot commit a successful stop')
        assert.equal(canceled, true)
      } finally { globalThis.fetch = originalFetch }
    })
  }
}

// Removing Gemini's attempt-aborted notification leaves the failed call actionable.
test('Gemini retry discards failed attempt tools and text before committing the successful attempt', async () => {
  const originalFetch = globalThis.fetch
  const encoder = new TextEncoder()
  const event = (name: string, text: string) => encoder.encode('data: ' + JSON.stringify({
    candidates: [{ content: { parts: [{ text }, { functionCall: { name, args: {} } }] } }],
    usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 },
  }) + '\n\n')
  let attempts = 0
  let streamed = ''
  const aborted: StreamAttemptAbortedInfo[] = []
  const notifications: string[] = []
  try {
    globalThis.fetch = (async () => {
      attempts++
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(event(attempts === 1 ? 'fictional_failed' : 'fictional_success', attempts === 1 ? 'failed text' : 'successful text')) },
        pull(controller) { if (attempts === 1) controller.error(new Error('fictional read failure')); else controller.close() },
      }))
    }) as typeof fetch
    const controller = new TurnStreamController({
      client: new GeminiClient({ ...config, requestTimeoutMs: 1000, maxRetries: 1,
        retry: { backoff: { baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }, maxTotalDurationMs: 5000 } }),
      abortSignal: new AbortController().signal,
      getStreamedTextLength: () => streamed.length, appendStreamedText: text => { streamed += text },
      truncateStreamedText: length => { streamed = streamed.slice(0, length) }, getLastPrewarmAt: () => 0,
      setLastPrewarmAt() {}, maybePrewarm() {}, addUsage() {}, recordTurnCache() {},
      recordStreamAttemptAborted: info => aborted.push(info),
    })
    const result = await controller.streamTurn({ request, turn: 1, lastTurnTextFingerprint: '', callbacks: {
      onTextDelta() {}, onThinkingDelta() {}, onError() {}, onToolUse(_id, name) { notifications.push(name) },
    } })
    assert.equal(result.streamError, null)
    assert.equal(attempts, 2)
    assert.deepEqual(result.toolUses.map(call => call.name), ['fictional_success'])
    assert.deepEqual(notifications, ['fictional_success'])
    assert.equal(streamed, 'successful text')
    assert.equal(aborted.length, 1)
    assert.equal(aborted[0]?.usage?.input_tokens, 7)
    assert.equal(aborted[0]?.usage?.output_tokens, 3)
  } finally { globalThis.fetch = originalFetch }
})

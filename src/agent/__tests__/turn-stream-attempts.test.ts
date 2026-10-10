import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIClient } from '../../api/openai-client.js'
import type { StreamClient, StreamAttemptAbortedInfo } from '../../api/stream-client.js'
import { SessionContext } from '../context.js'
import { TurnStreamController } from '../turn-stream.js'

async function run(client: StreamClient) {
  const session = new SessionContext()
  const aborted: StreamAttemptAbortedInfo[] = []
  const notifiedTools: string[] = []
  let text = 'previous turn;'
  const controller = new TurnStreamController({
    client, abortSignal: new AbortController().signal,
    getStreamedTextLength: () => text.length,
    appendStreamedText: delta => { text += delta },
    truncateStreamedText: length => { text = text.slice(0, length) },
    getLastPrewarmAt: () => 0, setLastPrewarmAt() {}, maybePrewarm() {},
    addUsage: usage => session.addUsage(usage), recordTurnCache() {},
    recordStreamAttemptAborted: info => {
      aborted.push(info)
      if (info.usage) session.addSidePathUsage(info.usage)
    },
  })
  const result = await controller.streamTurn({
    request: { model: 'fixture', max_tokens: 4096, messages: [{ role: 'user', content: 'fixture' }] },
    turn: 1, lastTurnTextFingerprint: '',
    callbacks: { onTextDelta() {}, onThinkingDelta() {}, onToolUse: id => { notifiedTools.push(id) }, onError() {} },
  })
  return { result, total: session.getTotalUsage(), aborted, text, notifiedTools }
}

test('actual incomplete SSE retry discards failed tools, text, reasoning and fingerprints', async () => {
  const original = globalThis.fetch
  let sends = 0
  globalThis.fetch = async () => {
    const id = `tool-${++sends}`
    const payload = { choices: [{ delta: { content: sends === 1 ? 'failed-text' : 'final-text', reasoning_content: `thinking-${sends}`,
      tool_calls: [{ index: 0, id, type: 'function', function: { name: 'write_file', arguments: '{"file_path":"fixture.txt","content":"fixture"}' } }] },
    finish_reason: sends === 1 ? null : 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 10 } }
    return new Response(`data: ${JSON.stringify(payload)}\n\n${sends === 1 ? '' : 'data: [DONE]\n\n'}`, { headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    const out = await run(new OpenAIClient({ apiKey: 'fixture', baseUrl: 'https://fixture.test/v1', model: 'fixture', maxTokens: 4096,
      retry: { backoff: { baseDelayMs: 1, jitterRatio: 0 }, overrides: { stream_parse: { maxRetries: 1, retryDelayMs: 1 } } } }))
    assert.equal(sends, 2)
    assert.equal(out.result.streamError, null)
    assert.deepEqual(out.result.toolUses.map(tool => tool.id), ['tool-2'])
    assert.deepEqual(out.notifiedTools, ['tool-2'], 'failed tools must never announce actionable work')
    assert.ok(!JSON.stringify(out.result.collectedBlocks).includes('failed-text'))
    assert.equal(out.text, 'previous turn;final-text')
    assert.equal(out.result.thinkingAccum, 'thinking-2')
    assert.equal(out.result.lastTurnTextFingerprint, 'final-text')
    assert.equal(out.total.output_tokens, 20, 'failed attempts still have a cost')
  } finally { globalThis.fetch = original }
})

test('GLM failed reasoning emits no text after its abort notification', async () => {
  const client = new OpenAIClient({ apiKey: 'fixture', model: 'fixture', providerName: 'glm', baseUrl: 'https://fixture.test/v1', maxTokens: 4096 })
  const body = new Response('data: {"choices":[{"delta":{"reasoning_content":"unfinished thought"},"finish_reason":null}]}\n\n')
  let sealed = false
  const late: string[] = []
  await assert.rejects(client.parseStreamFromReader(body.body!.getReader(), {
    onThinkingDelta() {}, onTextDelta: text => { if (sealed) late.push(text) },
    onStreamAttemptAborted: () => { sealed = true },
  }))
  assert.equal(sealed, true)
  assert.deepEqual(late, [])
})

for (const outputs of [[0], [10, undefined], [undefined, undefined]]) {
  test(`aborted attempts settle independently: ${JSON.stringify(outputs)}`, async () => {
    const out = await run({ stream: async (_request, cb) => {
      for (const [index, output] of outputs.entries()) {
        cb.onTextDelta('abcdefghijklmnop')
        const info: StreamAttemptAbortedInfo = {
          requestId: 'r', attemptId: `r:${index}`, provider: 'fixture', receivedChars: 16,
          elapsedMs: 1, errorName: 'Error', errorMessage: 'interrupted',
          usage: { input_tokens: 100, output_tokens: output ?? 0,
            observation: { requestId: 'r', attemptId: `r:${index}`, status: 'aborted',
              fields: { input_tokens: 'prompt_tokens', ...(output === undefined ? {} : { output_tokens: 'completion_tokens' }) } } },
        }
        cb.onStreamAttemptAborted?.(info)
        cb.onStreamAttemptAborted?.(info) // duplicate notification cannot book twice
      }
      throw new Error('interrupted')
    } })
    assert.equal(out.aborted.length, outputs.length)
    assert.equal(out.total.output_tokens, outputs.reduce<number>((sum, n) => sum + (n ?? 4), 0))
    assert.equal(out.total.estimated === true, outputs.includes(undefined))
    assert.equal(out.text, 'previous turn;')
    for (const [index, output] of outputs.entries()) {
      assert.equal(out.aborted[index]?.usage?.output_tokens, output ?? 4)
      assert.equal(!!out.aborted[index]?.usage?.observation?.fields.output_tokens, output !== undefined)
    }
  })
}

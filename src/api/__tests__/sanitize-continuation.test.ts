import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { PromptEngine } from '../../prompt/engine.js'
import { OpenAIClient } from '../openai-client.js'
import { withExecutionContinuity } from '../execution-continuity.js'
import type { OaiMessage } from '../oai-types.js'
import type { StreamCallbacks } from '../stream-client.js'
import { sanitizeMessageContent } from '../../utils/sanitize.js'

const callbacks: StreamCallbacks = {
  onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {},
  onError(error) { throw error },
}

const engineConfig = {
  model: 'fixture', maxTokens: 4096, staticCtx: { tools: [] },
  volatileCtx: { cwd: '/fixture', gitStatus: '' },
}

function makeClient(singleAttempt: boolean) {
  return withExecutionContinuity(new OpenAIClient({
    providerName: 'fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture',
    model: 'fixture', maxTokens: 4096, maxRetries: 0,
  }), { provider: 'fixture', model: 'fixture', credentialScope: 'fixture', singleAttempt })
}

async function checkFrozenContinuation(t: TestContext, options: {
  raw: string
  image?: boolean
  worker?: boolean
  restore?: boolean
  failOnce?: boolean
}): Promise<void> {
  const bodies: Array<{ messages: OaiMessage[] }> = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    if (options.failOnce && bodies.length === 2) {
      return new Response('{"error":{"message":"fixture temporarily unavailable"}}', { status: 503 })
    }
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":1}}\n\ndata: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    })
  })

  let engine = new PromptEngine(engineConfig)
  let client = makeClient(options.worker === true)
  // 模拟后台任务输出进入动态附录；冻结内容保留原始字符，只有发送副本应清洗。
  engine.setHarnessAdvisoryBlock(`<background-jobs>\n${options.raw}\n</background-jobs>`)
  const history: OaiMessage[] = [options.image ? {
    role: 'user', origin: 'hook', content: [
      { type: 'text', text: 'Synthetic browser screenshot' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(1_100_000) } },
    ],
  } : { role: 'user', origin: options.worker ? 'worker_task' : 'human', content: 'Inspect the synthetic task output' }]
  const originalHistory = structuredClone(history)
  const first = engine.buildOaiRequest(history)
  const rawPrefix = structuredClone(first.messages)
  assert.notDeepEqual(sanitizeMessageContent(rawPrefix), rawPrefix, 'fixture must need transport normalization')
  if (options.image) assert.ok(JSON.stringify(rawPrefix).length > 1_000_000, 'large image payload must not hide the small-text regression')
  await client.stream(first, callbacks)
  assert.deepEqual(first.messages, rawPrefix, 'transport must not sanitize the source request in place')
  assert.deepEqual(bodies[0]!.messages, sanitizeMessageContent(rawPrefix))
  const firstProof = structuredClone(client.getMainPrefixProof!()!)
  const frozen = engine.exportFrozenSnapshot()
  const originalAnchor = structuredClone(frozen.anchors![0]!)
  assert.ok(originalAnchor.suffix.includes(options.raw), 'published anchor must retain its original injection bytes')

  if (options.failOnce) {
    // 同长度请求先到达 HTTP 故障，再用同一个 client 追加输入重试。
    await assert.rejects(client.stream(engine.buildOaiRequest(history), callbacks), /fixture temporarily unavailable/)
    assert.equal(bodies.length, 2, 'the injected failure must occur at fetch, not at the continuity guard')
  }

  if (options.restore) {
    // 恢复真实首发生成的干净 wire 基线；后续多轮不能依靠恢复首请求的放宽蒙混过关。
    engine = new PromptEngine({ ...engineConfig, inheritFrozenFrom: structuredClone(frozen) })
    client = makeClient(options.worker === true)
    client.restoreExecutionSnapshot!(firstProof)
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    history.push({ role: 'assistant', content: `Observation ${attempt}` }, { role: 'user', content: 'Retry the synthetic task' })
    const request = engine.buildOaiRequest(history)
    const beforeSend = structuredClone(request.messages)
    assert.deepEqual(request.messages.slice(0, rawPrefix.length), rawPrefix, 'rebuilt historical prompt stays frozen')
    await client.stream(request, callbacks)
    const previousBody = bodies[attempt + (options.failOnce ? 1 : 0)]!
    assert.equal(bodies.length, attempt + 2 + (options.failOnce ? 1 : 0), 'every continuation must reach fetch exactly once')
    assert.deepEqual(bodies.at(-1)!.messages.slice(0, previousBody.messages.length), previousBody.messages,
      'wire history must remain an exact prefix across successive continuations')
    assert.equal(client.getMainPrefixProof!()!.cacheGenerationId, firstProof.cacheGenerationId,
      'a cold start or resume drift must not hide normalization errors')
    assert.deepEqual(request.messages, beforeSend)
    assert.deepEqual(history.slice(0, originalHistory.length), originalHistory)
    assert.deepEqual(engine.exportFrozenSnapshot().anchors!.find(anchor => anchor.key === originalAnchor.key), originalAnchor)
  }

  // 同一段历史直接重发，也必须保持同一代次与相同 wire 字节。
  await client.stream(engine.buildOaiRequest(history), callbacks)
  assert.equal(bodies.length, options.failOnce ? 6 : 5)
  assert.deepEqual(bodies.at(-1)!.messages, bodies.at(-2)!.messages)
  assert.equal(client.getMainPrefixProof!()!.cacheGenerationId, firstProof.cacheGenerationId)
}

const escapedJobOutput = Array.from({ length: 5 }, (_, index) => `\u001b[3${index}mjob-${index}`).join('\n')

test('main-session screenshot continuation keeps five escaped job controls normalized', async t => {
  await checkFrozenContinuation(t, { raw: escapedJobOutput, image: true })
})

test('single-attempt worker continuation keeps frozen text normalized', async t => {
  await checkFrozenContinuation(t, { raw: escapedJobOutput, worker: true })
})

test('NFD appendix remains wire-stable through repeated continuation and replay', async t => {
  await checkFrozenContinuation(t, { raw: 'e\u0301'.repeat(25) })
})

test('restored worker keeps an existing clean baseline beyond the first resumed request', async t => {
  await checkFrozenContinuation(t, { raw: escapedJobOutput, image: true, worker: true, restore: true })
})

test('main session can retry three times on the same client after one HTTP failure', async t => {
  await checkFrozenContinuation(t, { raw: escapedJobOutput, failOnce: true })
})

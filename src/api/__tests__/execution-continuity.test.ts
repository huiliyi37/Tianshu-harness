import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProviderClient } from '../factory.js'
import { resolveCapabilities } from '../provider.js'
import { providerSchema, type ProviderConfig } from '../../config/schema.js'
import type { OaiChatRequest } from '../oai-types.js'
import type { StreamCallbacks } from '../stream-client.js'
import { withExecutionContinuity, credentialPrincipal } from '../execution-continuity.js'
import { withStructuredRetry } from '../retry-engine.js'

process.env.RIVET_HOME = mkdtempSync(join(tmpdir(), 'continuity-api-test-'))
const callbacks: StreamCallbacks = { onTextDelta: () => {}, onThinkingDelta: () => {}, onContentBlock: () => {}, onStopReason: () => {}, onError: () => {} }
function client(singleAttempt = false) {
  const provider = { name: 'deepseek', baseUrl: 'https://api.deepseek.com', protocol: 'openai', thinking: 'enabled', maxTokens: 2048, unsupported: [], capabilities: {}, maxRetries: 8, models: [{ id: 'deepseek-flash', contextWindow: 1_000_000, maxTokens: 2048 }] } as ProviderConfig
  return createProviderClient(provider, resolveCapabilities('deepseek', { effortFormat: 'reasoning_effort' }), {
    apiKey: 'fixture', model: 'deepseek-flash', maxTokens: 2048, reasoningEffort: 'high', singleAttempt,
    sessionId: 'worker-original', credentialScope: 'deepseek:key-a',
  })
}
const request = (): OaiChatRequest => ({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'task' }], max_tokens: 2048, prefixProbe: true })
async function withFetch(run: (bodies: Record<string, unknown>[], headers: Headers[]) => Promise<void>, status = 200) {
  const original = globalThis.fetch, bodies: Record<string, unknown>[] = [], headers: Headers[] = []
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body))); headers.push(new Headers(init?.headers))
    return status === 200 ? new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":1,"prompt_cache_hit_tokens":80}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }) : new Response('server unavailable', { status })
  }
  try { await run(bodies, headers) } finally { globalThis.fetch = original }
}

test('actual factory freezes effort and keeps append-only requests', async () => withFetch(async bodies => {
  const c = client(); await c.stream(request(), callbacks)
  c.setReasoningEffort?.('low'); c.setThinking?.('disabled')
  const next = request(); next.messages.push({ role: 'assistant', content: 'done' }, { role: 'user', content: 'continue' })
  await assert.doesNotReject(c.stream(next, callbacks), 'internal effort suggestions must preserve the actual wire request')
  assert.equal(bodies.length, 2)
  assert.deepEqual(bodies[0]!.thinking, bodies[1]!.thinking)
  assert.equal(bodies[0]!.reasoning_effort, bodies[1]!.reasoning_effort)
  assert.equal(c.getMainPrefixProof?.()?.version, 2)
}))

for (const change of ['options', 'tools', 'history', 'binding'] as const) {
  test(`${change} changes are rejected before the second HTTP send`, async () => withFetch(async bodies => {
    const c = client(); await c.stream(request(), callbacks)
    const next = request()
    if (change === 'options') next.reasoning_effort = 'low'
    if (change === 'tools') next.tools = [{ type: 'function', function: { name: 'new_tool', description: 'new', parameters: { type: 'object' } } }]
    if (change === 'history') next.messages[0] = { role: 'user', content: 'rewritten' }
    if (change === 'binding') next.model = 'unrequested-model'
    await assert.rejects(c.stream(next, callbacks), /prefix diverged/)
    assert.equal(bodies.length, 1)
  }))
}

for (const status of [429, 500, 503, 400]) {
  test(`worker ${status} has one HTTP attempt and terminal client state`, async () => withFetch(async bodies => {
    const c = client(true)
    await assert.rejects(c.stream(request(), callbacks))
    await assert.rejects(c.stream(request(), callbacks))
    assert.equal(bodies.length, 1)
  }, status))
}

test('explicit user change starts a distinct generation', async () => withFetch(async bodies => {
  const c = client(); await c.stream(request(), callbacks)
  const old = c.getMainPrefixProof?.()?.cacheGenerationId
  c.authorizeCacheGeneration?.('explicit_user_effort'); c.setReasoningEffort?.('low')
  await c.stream({ ...request(), model: 'user-selected-model' }, callbacks)
  assert.notEqual(c.getMainPrefixProof?.()?.cacheGenerationId, old)
  assert.equal(bodies[1]!.model, 'user-selected-model')
  assert.equal(bodies[1]!.reasoning_effort, 'low')
}))

test('worker resume restores actual options and dispatch session nonce', async () => withFetch(async (bodies, headers) => {
  const old = client(true); await old.stream(request(), callbacks)
  const snapshot = old.getMainPrefixProof!()!
  const resumed = client(true)
  resumed.setReasoningEffort?.('low')
  resumed.restoreExecutionSnapshot!(snapshot)
  resumed.setRuntimeSessionId!('worker-task-nonce')
  resumed.setReasoningEffort?.('low')
  const next = request(); next.messages.push({ role: 'assistant', content: 'done' }, { role: 'user', content: 'continue' })
  next.diagnostics = { purpose: 'worker_execution', continuationSource: 'explicit_resume', priorPrefix: snapshot }
  await assert.doesNotReject(resumed.stream(next, callbacks), 'explicit continuation must restore the previous actual effort')
  assert.equal(bodies[1]!.reasoning_effort, bodies[0]!.reasoning_effort)
  assert.equal(headers[1]!.get('X-Request-Session'), 'worker-task-nonce')
}))

test('main resume opens a new generation on first-request drift; allowance is consumed after one send', async () => withFetch(async bodies => {
  // 2026-10-16 起主会话与 worker 同一契约：restored 首请求的 baseline 是上一个
  // run 的 wire 快照，重注入/落盘投影差导致漂移属预期，开新代次而非砖死会话
  // （现场：revit-4213e2/2026101609914b2d8192，打断标记改写已发送消息后 resume 也救不回）。
  const first = client()
  await first.stream(request(), callbacks)
  const resumed = client()
  resumed.restoreExecutionSnapshot!(first.getMainPrefixProof!()!)
  const changed = request()
  changed.messages[0] = { role: 'user', content: 'rewritten after resume' }
  await assert.doesNotReject(resumed.stream(changed, callbacks))
  assert.equal(resumed.getMainPrefixProof?.()?.generationReason, 'resume_prefix_drift')
  assert.equal(bodies.length, 2)
  // 放宽一次性：第二请求再漂移仍 fail-closed
  const again = request()
  again.messages[0] = { role: 'user', content: 'rewritten a second time' }
  await assert.rejects(resumed.stream(again, callbacks), /prefix diverged/)
  assert.equal(bodies.length, 2)
}))

test('restored worker rebases a stale wire proof even when source and render projections are unchanged', async () => withFetch(async bodies => {
  const first = client(true)
  await first.stream(request(), callbacks)
  const saved = structuredClone(first.getMainPrefixProof!()!)
  saved.messages[0] = { ...saved.messages[0]!, hash: 'deadbeef'.repeat(8), chars: 1 }

  const resumed = client(true)
  resumed.restoreExecutionSnapshot!(saved)
  const next = request()
  next.messages.push({ role: 'user', content: 'continue' })
  next.continuityEvidence = { sourcePrefix: 'same', renderPrefix: 'same' }
  await assert.doesNotReject(resumed.stream(next, callbacks))
  assert.equal(bodies.length, 2)
  assert.equal(resumed.getMainPrefixProof!()!.generationReason, 'resume_prefix_drift')
  assert.notEqual(resumed.getMainPrefixProof!()!.cacheGenerationId, saved.cacheGenerationId)
}))

test('incomplete legacy proof blocks resume without HTTP', async () => withFetch(async bodies => {
  const c = client(true)
  assert.throws(() => c.restoreExecutionSnapshot!({ version: 1, provider: 'deepseek', model: 'deepseek-flash', requestId: 'legacy', optionsHash: '', toolsHash: '', messages: [] }), /snapshot/)
  assert.equal(bodies.length, 0)
}))

test('retry executor itself runs once, even when transport guard would independently prevent a resend', async () => {
  let operations = 0
  const raw = { stream: async () => withStructuredRetry(async () => {
    operations++
    throw Object.assign(new Error('fixture server failure'), { status: 500 })
  }, undefined, { maxTotalRetries: 3, policy: { backoff: { baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 } } }) }
  const guarded = withExecutionContinuity(raw, { provider: 'fixture', model: 'fixture', singleAttempt: true })
  await assert.rejects(guarded.stream(request(), callbacks))
  assert.equal(operations, 1)
})

test('existing factory client is upgraded to worker policy without losing its binding or retry ceiling', async () => withFetch(async bodies => {
  const c = client(false)
  const worker = withExecutionContinuity(c, { provider: 'unused-alias', model: 'unused-alias', singleAttempt: true })
  assert.equal(worker, c)
  await assert.rejects(worker.stream(request(), callbacks))
  assert.equal(bodies.length, 1)
}, 503))

test('principal identity survives OAuth token refresh and blocks a changed account before HTTP', async () => withFetch(async bodies => {
  let principal = 'account-a', revision = 1
  const auth = { getHeaders: async () => ({ Authorization: `Bearer e30.${Buffer.from(JSON.stringify({ sub: principal, revision })).toString('base64url')}.fixture` }), isAuthenticated: () => true, authenticate: async () => {}, dispose: () => {} }
  const p = { name: 'custom', baseUrl: 'https://fixture.invalid/v1', protocol: 'openai', thinking: 'disabled', unsupported: [], capabilities: {}, maxTokens: 2048, models: [{ id: 'deepseek-flash', contextWindow: 64000, maxTokens: 2048 }] } as ProviderConfig
  const c = createProviderClient(p, resolveCapabilities('custom'), { apiKey: '', model: 'deepseek-flash', maxTokens: 2048, auth, credentialScope: 'custom:oauth' })
  await c.stream(request(), callbacks)
  revision++
  await c.stream(request(), callbacks)
  assert.equal(bodies.length, 2)
  assert.ok(c.getMainPrefixProof?.()?.credentialScope?.includes(':principal:'))
  assert.ok(!JSON.stringify(c.getMainPrefixProof?.()).includes(principal))
  principal = 'account-b'
  await assert.rejects(c.stream(request(), callbacks), /binding/)
  assert.equal(bodies.length, 2)
  assert.match(credentialPrincipal({ Authorization: 'Bearer opaque-fixture' })!, /^[a-f0-9]{64}$/)
}))

test('rotating an opaque credential cannot silently change the published binding', async () => withFetch(async bodies => {
  let revision = 'fixture-a'
  const auth = { getHeaders: async () => ({ Authorization: `Bearer ${revision}` }), isAuthenticated: () => true, authenticate: async () => {}, dispose: () => {} }
  const p = providerSchema.parse({ name: 'custom', baseUrl: 'https://fixture.invalid/v1', protocol: 'openai', models: [{ id: 'deepseek-flash', maxTokens: 2048 }] })
  const c = createProviderClient(p, resolveCapabilities('custom'), { apiKey: '', model: 'deepseek-flash', maxTokens: 2048, auth, credentialScope: 'custom:key-a' })
  await c.stream(request(), callbacks)
  revision = 'fixture-b'
  await assert.rejects(c.stream(request(), callbacks), /binding/)
  assert.equal(bodies.length, 1)
  assert.ok(!JSON.stringify(c.getMainPrefixProof?.()).includes('fixture-a'))
}))

for (const protocol of ['anthropic', 'openai-responses', 'gemini'] as const) {
  const makeNative = (effort = 'high') => {
    const p = providerSchema.parse({ name: `fixture-${protocol}`, baseUrl: 'https://fixture.invalid', protocol, maxRetries: 8, models: [{ id: 'fixture-model', maxTokens: 2048, contextWindow: 64000 }] })
    return createProviderClient(p, resolveCapabilities(p.name), { apiKey: 'fixture', model: 'fixture-model', reasoningEffort: effort, maxTokens: 2048, singleAttempt: true, credentialScope: `${p.name}:default` })
  }
  test(`${protocol}: native HTTP error never retries`, async () => withFetch(async bodies => {
    const c = makeNative()
    await assert.rejects(c.stream({ ...request(), model: 'fixture-model' }, callbacks))
    assert.equal(bodies.length, 1)
  }, 503))
  test(`${protocol}: restore actual wire options after changed initial effort`, async () => {
    const original = globalThis.fetch, bodies: unknown[] = []
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      const events = protocol === 'anthropic' ? [
        { type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 80, cache_creation_input_tokens: 0 } } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' },
      ] : protocol === 'gemini' ? [{ candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 1, cachedContentTokenCount: 80 } }]
        : [{ type: 'response.output_text.delta', delta: 'done' }, { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 100, output_tokens: 1, input_tokens_details: { cached_tokens: 80 } } } }]
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    }
    try {
      const first = makeNative()
      const req = { ...request(), model: 'fixture-model' }
      await first.stream(req, callbacks)
      const snapshot = first.getMainPrefixProof!()!
      const restored = makeNative('low')
      restored.restoreExecutionSnapshot!(snapshot)
      await restored.stream(req, callbacks)
      assert.equal(bodies.length, 2)
      assert.deepEqual(restored.getMainPrefixProof?.()?.options, snapshot.options)
      assert.equal(restored.getMainPrefixProof?.()?.cacheGenerationId, snapshot.cacheGenerationId)
    } finally { globalThis.fetch = original }
  })
}

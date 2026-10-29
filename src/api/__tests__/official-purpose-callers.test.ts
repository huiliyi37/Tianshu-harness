import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOfficialTransportFixture as createOfficialRuntimeFixture } from './official-transport-fixture.js'
import { resolveModelRuntime } from '../../models/model-runtime.js'
import { createReportClientFactory } from '../report-client.js'
import { generateGreetingLlm } from '../greeting.js'
import { probeProvider } from '../provider-probe.js'
import { resolveImageGeneration } from '../image-generation-parameters.js'
import { configSchema } from '../../config/schema.js'
import type { StreamCallbacks } from '../stream-client.js'

const callbacks: StreamCallbacks = { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError(error) { throw error } }

test('BYOK image selection does not capture an official submission', () => {
  const config = configSchema.parse({ provider: { default: 'synthetic', providers: { synthetic: { name: 'synthetic', baseUrl: 'https://synthetic.invalid/v1', apiKey: 'synthetic', models: [{ id: 'image', supportsImageGen: true }] } } } })
  const forbidden = (): never => { throw new Error('BYOK must not capture official authority') }
  const submission: NonNullable<Parameters<typeof resolveImageGeneration>[2]> = {
    prepare: forbidden, forModel: forbidden, capture: forbidden, prepareModel: forbidden, resolve: forbidden,
    standaloneResolve: forbidden, check: forbidden, settle: forbidden, onSettlement: forbidden, afterPrepare: forbidden,
  }
  const resolved = resolveImageGeneration({ provider: 'synthetic', model: 'image' }, config, submission)
  assert.equal(resolved.connection.apiKey, 'synthetic')
  assert.equal(resolved.connection.prepareRequestAuth, undefined)
})

test('official image selection pins identity without quoting until generation actually begins', async () => {
  const fixture = await createOfficialRuntimeFixture('openai', 'image-generation')
  try {
    fixture.input.provider.models[0]!.supportsImageGen = true
    const resolved = resolveImageGeneration({ provider: 'official', model: fixture.input.modelId, prompt: 'synthetic' }, configSchema.parse(fixture.input.config))
    assert.equal(resolved.connection.apiKey, '')
    assert.equal(fixture.quoteCount, 0)
    assert.equal(typeof resolved.connection.prepareRequestAuth, 'function')
    await fixture.replaceAccount()
    await assert.rejects(resolved.connection.prepareRequestAuth!(), error => error instanceof Error && error.name === 'OfficialError')
    assert.equal(fixture.calls.length, 0)
    assert.equal(fixture.quoteCount, 0)
  } finally { await fixture.close() }
})

test('official reports retain prepared provider identity and disable thinking on the actual wire', async () => {
  const fixture = await createOfficialRuntimeFixture()
  try {
    fixture.binding.thinkingPolicy = 'reasoning_effort'
    const runtime = await resolveModelRuntime(fixture.input, fixture.deps)
    const factory = createReportClientFactory(runtime.provider, runtime.capabilities, { model: runtime.modelId, apiKey: 'never-send', requestAuth: runtime.requestAuth })
    await factory().stream({ model: runtime.modelId, messages: [{ role: 'user', content: 'synthetic' }] }, callbacks)
    assert.equal(fixture.calls.length, 1)
    assert.equal(fixture.calls[0]!.body.reasoning_effort, undefined)
    assert.notEqual(fixture.calls[0]!.headers.authorization, 'Bearer never-send')
  } finally { await fixture.close() }
})

test('official greeting goes through prepared authorization instead of a caller-supplied key', async () => {
  const fixture = await createOfficialRuntimeFixture()
  try {
    const result = await generateGreetingLlm('https://gateway.invalid', 'never-send', fixture.input.modelId, 10, 'zh-CN', { official: fixture.input, timeoutMs: 3000 } as Parameters<typeof generateGreetingLlm>[5])
    assert.equal(result, 'ok')
    assert.equal(fixture.calls.length, 1)
    assert.equal(fixture.quoteCount, 1)
    assert.notEqual(fixture.calls[0]!.headers.authorization, 'Bearer never-send')
  } finally { await fixture.close() }
})

test('official provider probe reads its catalog rather than the raw provider models endpoint', async () => {
  const fixture = await createOfficialRuntimeFixture()
  try {
    fixture.writeConfig()
    const report = await probeProvider({ providerName: 'official', baseUrl: fixture.input.provider.baseUrl, apiKey: '', skipCompletion: true })
    assert.equal(report.modelsOk, true)
    assert.deepEqual(report.models, [fixture.input.modelId])
    assert.equal(fixture.calls.length, 0)
    assert.equal(fixture.quoteCount, 0)
    assert.equal(fixture.catalogCount, 1)
  } finally { await fixture.close() }
})

test('official provider probe authorizes an actual completion and refuses endpoint overrides', async () => {
  const fixture = await createOfficialRuntimeFixture()
  try {
    fixture.writeConfig()
    const options = { providerName: 'official', baseUrl: fixture.input.provider.baseUrl, apiKey: '', probeModel: fixture.input.modelId, timeoutMs: 3000 }
    const report = await probeProvider(options)
    assert.equal(report.completionOk, true)
    assert.equal(fixture.calls.length, 1)
    const rejected = await probeProvider({ ...options, baseUrl: 'https://untrusted.invalid' })
    assert.equal(rejected.modelsOk, false)
    assert.deepEqual(rejected.errors, ['model_unavailable'])
    assert.equal(fixture.calls.length, 1)
  } finally { await fixture.close() }
})

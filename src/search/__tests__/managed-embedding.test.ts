import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { createOfficialTransportFixture } from '../../api/__tests__/official-transport-fixture.js'
import { OfficialError } from '../../models/official-contract.js'
import { resolveModelRuntime } from '../../models/model-runtime.js'
import { createEmbeddingProvider, RemoteEmbeddingProvider } from '../embedding-provider.js'
import { SemanticIndex } from '../semantic-index.js'
import { providerSchema } from '../../config/schema.js'

for (const mode of ['configured', 'disabled', 'lean'] as const) test(`managed embedding normal entry honors ${mode} before any official work`, async () => {
  const fixture = await createOfficialTransportFixture('openai', 'embedding')
  const previous = { disabled: process.env.RIVET_NO_EMBEDDINGS, lean: process.env.RIVET_LEAN }
  try {
    delete process.env.RIVET_NO_EMBEDDINGS
    delete process.env.RIVET_LEAN
    if (mode === 'disabled') process.env.RIVET_NO_EMBEDDINGS = '1'
    if (mode === 'lean') process.env.RIVET_LEAN = '1'
    fixture.setResponse(response => response.end(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }] })))
    const provider = createEmbeddingProvider({ managed: { input: fixture.input, deps: fixture.deps }, fetchImpl: fixture.fetchImpl })
    assert.equal(provider.isAvailable(), mode === 'configured')
    assert.deepEqual(await provider.embed(['synthetic']), mode === 'configured' ? [[0.1, 0.2]] : [])
    assert.equal(fixture.calls.length, mode === 'configured' ? 1 : 0)
    assert.equal(fixture.catalogCount, mode === 'configured' ? 2 : 0)
    assert.equal(fixture.quoteCount, mode === 'configured' ? 1 : 0)
    if (mode === 'configured') {
      assert.equal(fixture.calls[0]!.path, '/v1/embeddings')
      assert.equal(fixture.calls[0]!.headers['x-tianshu-binding-id'], fixture.binding.id)
      assert.equal(fixture.calls[0]!.headers['x-tianshu-quote-id'], 'quote-1')
    }
  } finally {
    if (previous.disabled === undefined) delete process.env.RIVET_NO_EMBEDDINGS
    else process.env.RIVET_NO_EMBEDDINGS = previous.disabled
    if (previous.lean === undefined) delete process.env.RIVET_LEAN
    else process.env.RIVET_LEAN = previous.lean
    await fixture.close()
  }
})

test('managed embedding batches share captured authorization and preserve response ordering', async () => {
  const fixture = await createOfficialTransportFixture('openai', 'embedding')
  try {
    fixture.setResponse(response => response.end(JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] })))
    const runtime = await resolveModelRuntime(fixture.input, fixture.deps)
    const provider = new RemoteEmbeddingProvider({ baseUrl: runtime.provider.baseUrl, apiKey: 'never-send', model: runtime.modelId, requestAuth: runtime.requestAuth, fetchImpl: fixture.fetchImpl, batchSize: 2 })
    assert.deepEqual(await provider.embed(['one', 'two', 'three', 'four']), [[1, 0], [0, 1], [1, 0], [0, 1]])
    assert.equal(fixture.calls.length, 2)
    assert.equal(fixture.quoteCount, 1)
    assert.equal(fixture.calls[0]!.headers['x-request-id'], fixture.calls[1]!.headers['x-request-id'])
    assert.ok(fixture.calls.every(call => call.headers.authorization !== 'Bearer never-send'))
  } finally { await fixture.close() }
})

test('managed embedding captures original identity before the first network request', async () => {
  const fixture = await createOfficialTransportFixture('openai', 'embedding')
  try {
    const provider = createEmbeddingProvider({ managed: { input: fixture.input, deps: fixture.deps }, fetchImpl: fixture.fetchImpl })
    await fixture.replaceAccount()
    await assert.rejects(provider.embed(['synthetic']), OfficialError)
    assert.equal(fixture.calls.length, 0)
    assert.equal(fixture.quoteCount, 0)
  } finally { await fixture.close() }
})

test('managed embedding rechecks captured identity before each actual batch network send', async () => {
  const fixture = await createOfficialTransportFixture('openai', 'embedding')
  try {
    const runtime = await resolveModelRuntime(fixture.input, fixture.deps)
    fixture.setResponse(async response => { await fixture.replaceAccount(); response.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })) })
    const provider = new RemoteEmbeddingProvider({ baseUrl: runtime.provider.baseUrl, apiKey: '', model: runtime.modelId, requestAuth: runtime.requestAuth, fetchImpl: fixture.fetchImpl, batchSize: 1 })
    await assert.rejects(provider.embed(['one', 'two']), OfficialError)
    assert.equal(fixture.calls.length, 1)
    assert.equal(fixture.quoteCount, 1)
  } finally { await fixture.close() }
})

test('managed embedding does not follow later caller input replacement with a BYOK provider', async () => {
  const fixture = await createOfficialTransportFixture('openai', 'embedding')
  try {
    fixture.setResponse(response => response.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })))
    const input = { ...fixture.input }
    const provider = createEmbeddingProvider({ managed: { input, deps: fixture.deps }, fetchImpl: fixture.fetchImpl })
    const replacement = providerSchema.parse({ name: 'synthetic-byok', baseUrl: 'https://untrusted.invalid/v1', apiKey: 'never-send', models: [{ id: input.modelId }] })
    input.provider = replacement
    input.config = { ...input.config, provider: { default: replacement.name, providers: { [replacement.name]: replacement } } }
    assert.deepEqual(await provider.embed(['synthetic']), [[1, 0]])
    assert.equal(fixture.calls.length, 1)
    assert.equal(fixture.calls[0]!.headers['x-tianshu-binding-id'], fixture.binding.id)
    assert.notEqual(fixture.calls[0]!.headers.authorization, 'Bearer never-send')
  } finally { await fixture.close() }
})

test('managed embedding projects authoritative failures without retry or raw upstream diagnostics', async () => {
  const fixture = await createOfficialTransportFixture('openai', 'embedding')
  try {
    fixture.setResponse(response => { response.statusCode = 402; response.end(JSON.stringify({ version: 1, requestId: 'synthetic', error: { code: 'insufficient_balance', retryable: true, message: 'private-upstream-value' } })) })
    const provider = createEmbeddingProvider({ managed: { input: fixture.input, deps: fixture.deps }, fetchImpl: fixture.fetchImpl })
    await assert.rejects(provider.embed(['synthetic']), (error: unknown) => error instanceof OfficialError && error.code === 'insufficient_balance' && !error.retryable && !error.message.includes('upstream'))
    assert.equal(fixture.calls.length, 1)
  } finally { await fixture.close() }
})

for (const data of [[], [{ index: 0, embedding: [] }], [{ index: 0, embedding: [null] }], [{ index: 1, embedding: [1] }]]) test('managed embedding refuses malformed or misindexed vectors before consumption: ' + JSON.stringify(data), async () => {
  const fixture = await createOfficialTransportFixture('openai', 'embedding')
  try {
    fixture.setResponse(response => response.end(JSON.stringify({ data })))
    const provider = createEmbeddingProvider({ managed: { input: fixture.input, deps: fixture.deps }, fetchImpl: fixture.fetchImpl })
    await assert.rejects(provider.embed(['synthetic']), (error: unknown) => error instanceof OfficialError && error.code === 'service_error')
    assert.equal(fixture.calls.length, 1)
  } finally { await fixture.close() }
})

test('managed identity guard runs before already-cached vectors and the next query network consumer', async () => {
  const fixture = await createOfficialTransportFixture('openai', 'embedding')
  const cwd = await mkdtemp(join(tmpdir(), 'managed-vector-cache-'))
  try {
    await writeFile(join(cwd, 'synthetic.ts'), 'export function syntheticQuery() { return "synthetic" }')
    fixture.setResponse((response, call) => response.end(JSON.stringify({ data: (call.body.input as string[]).map((_text, index) => ({ index, embedding: [1, 0] })) })))
    const provider = createEmbeddingProvider({ managed: { input: fixture.input, deps: fixture.deps }, fetchImpl: fixture.fetchImpl })
    const index = new SemanticIndex(cwd, provider)
    index.rebuild()
    assert.ok(await index.ensureVectors() > 0)
    assert.equal(await index.ensureVectors(), 0)
    const sends = fixture.calls.length
    const quotes = fixture.quoteCount
    await fixture.replaceAccount()
    await assert.rejects(index.ensureVectors(), OfficialError)
    await assert.rejects(index.searchHybrid('syntheticQuery'), OfficialError)
    assert.equal(fixture.calls.length, sends)
    assert.equal(fixture.quoteCount, quotes)
  } finally { await rm(cwd, { recursive: true, force: true }); await fixture.close() }
})

for (const cached of [false, true]) test(`managed identity is rechecked after network completion before ${cached ? 'cached vector search' : 'vector cache persistence'}`, async () => {
  const fixture = await createOfficialTransportFixture('openai', 'embedding')
  const cwd = await mkdtemp(join(tmpdir(), 'managed-vector-late-'))
  try {
    await writeFile(join(cwd, 'synthetic.ts'), 'export function syntheticQuery() { return "synthetic" }')
    const respond = (response: import('node:http').ServerResponse, call: { body: Record<string, unknown> }) => response.end(JSON.stringify({ data: (call.body.input as string[]).map((_text, index) => ({ index, embedding: [1, 0] })) }))
    fixture.setResponse(respond)
    const provider = createEmbeddingProvider({ managed: { input: fixture.input, deps: fixture.deps }, fetchImpl: fixture.fetchImpl })
    const index = new SemanticIndex(cwd, provider)
    index.rebuild()
    if (cached) assert.ok(await index.ensureVectors() > 0)
    fixture.setResponse(async (response, call) => { await fixture.replaceAccount(); respond(response, call) })
    await assert.rejects(cached ? index.searchHybrid('syntheticQuery') : index.ensureVectors(), OfficialError)
    assert.equal(fixture.calls.length, cached ? 2 : 1)
    assert.equal(existsSync(join(cwd, '.rivet', 'vector-index.json')), cached)
  } finally { await rm(cwd, { recursive: true, force: true }); await fixture.close() }
})

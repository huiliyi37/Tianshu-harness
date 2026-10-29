import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as officialAuth from '../../auth/official-model-auth.js'
import { exactOrigin, type Catalog } from '../../models/official-contract.js'
import { configSchema } from '../../config/schema.js'
import type { ModelRuntimeDeps } from '../../models/model-runtime.js'

test('actual official provider bootstrap uses the shared shipped gateway configuration without preview environment', async () => {
  const source = readFileSync(new URL('../serve.ts', import.meta.url), 'utf8')
  const parsed = ts.createSourceFile('serve.ts', source, ts.ScriptTarget.Latest, true)
  const declaration = parsed.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'withOfficialProviderView')
  assert.ok(declaration)
  const compiled = ts.transpileModule(declaration.getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  let sharedReads = 0
  let catalogs = 0
  const configuredOrigin = 'https://shared-validated.invalid'
  const bootstrap = runInNewContext(`${compiled}\nwithOfficialProviderView`, {
    process: { env: {} }, exactOrigin, officialProviderId: 'tianshu-official',
    isOfficialProvider: () => false,
    getOfficialGatewayOrigin: () => { sharedReads++; return configuredOrigin },
  })
  const snapshot = { config: { provider: { providers: {} } } }
  const result = await bootstrap(snapshot, { subject: 'synthetic-identity' }, undefined, async () => {
    catalogs++
    return { models: [{ id: 'synthetic-model', contextWindow: 32000, maxOutputTokens: 4096, bindings: [{ id: 'synthetic-binding', stream: true }] }] }
  })
  assert.equal(result.config.provider.providers['tianshu-official'].baseUrl, configuredOrigin)
  assert.equal(sharedReads, 1)
  assert.equal(catalogs, 1)
  assert.deepEqual(snapshot.config.provider.providers, {})
})

test('the shared gateway accessor validates the broker shipped default and environment overrides', () => {
  const accessor = (officialAuth as unknown as { getOfficialGatewayOrigin?: () => string }).getOfficialGatewayOrigin
  assert.equal(typeof accessor, 'function', 'auth broker must export its shared validated origin accessor')
  const previousOrigin = process.env.RIVET_OFFICIAL_GATEWAY_ORIGIN
  const previousOrigins = process.env.RIVET_OFFICIAL_GATEWAY_ORIGINS
  try {
    delete process.env.RIVET_OFFICIAL_GATEWAY_ORIGIN
    delete process.env.RIVET_OFFICIAL_GATEWAY_ORIGINS
    assert.equal(accessor!(), 'https://tianshuharness.com')
    process.env.RIVET_OFFICIAL_GATEWAY_ORIGIN = 'https://fixture.invalid'
    assert.equal(accessor!(), 'https://fixture.invalid')
    process.env.RIVET_OFFICIAL_GATEWAY_ORIGIN = 'http://caller.invalid'
    assert.throws(accessor!)
    process.env.RIVET_OFFICIAL_GATEWAY_ORIGIN = 'https://fixture.invalid'
    process.env.RIVET_OFFICIAL_GATEWAY_ORIGINS = JSON.stringify(['https://different.invalid'])
    assert.throws(accessor!)
  } finally {
    if (previousOrigin === undefined) delete process.env.RIVET_OFFICIAL_GATEWAY_ORIGIN
    else process.env.RIVET_OFFICIAL_GATEWAY_ORIGIN = previousOrigin
    if (previousOrigins === undefined) delete process.env.RIVET_OFFICIAL_GATEWAY_ORIGINS
    else process.env.RIVET_OFFICIAL_GATEWAY_ORIGINS = previousOrigins
  }
})

test('real official session preparation shares shipped configuration and one catalog without inference', async () => {
  const { prepareOfficialServeContext } = await import('../serve.js')
  const config = configSchema.parse({ provider: { default: 'synthetic-local', providers: {
    'synthetic-local': { name: 'synthetic-local', baseUrl: 'http://127.0.0.1:1', models: [{ id: 'local-model' }] },
  } } })
  const provider = config.provider.providers['synthetic-local']!
  const context = { config, provider, model: provider.models[0]!, apiKey: '', configured: false }
  const identity = { subject: 'synthetic-subject', accountSessionId: 'synthetic-session', deviceId: 'synthetic-device', generation: 1, incarnation: 'synthetic-incarnation' }
  const catalog: Catalog = { revision: 'synthetic-catalog', models: [{
    id: 'published-agent', displayName: 'Synthetic published agent', provider: 'synthetic-supplier', status: 'available', contextWindow: 32000, maxOutputTokens: 4096,
    capabilities: { tools: true, vision: false, thinking: false }, costStatus: 'unavailable',
    bindings: [{ id: 'synthetic-binding', modelId: 'published-agent', billingMode: 'server', operation: 'chat', protocol: 'openai', origin: 'https://tianshuharness.com', path: '/v1/chat/completions', stream: true, capabilities: { tools: true, vision: false, thinking: false }, requiredHeaders: null, thinkingPolicy: 'none', pricingRevision: 'synthetic-price' }],
  }] }
  let catalogs = 0
  let quotes = 0
  const dependencies: ModelRuntimeDeps = {
    captureIdentity: () => identity,
    getCatalog: async owner => { assert.equal(owner, identity); catalogs++; return catalog },
    getCredential: async () => ({} as never),
    getQuote: async () => { quotes++; throw new Error('preparation must not quote or infer') },
    withIdentity: (owner, action) => { assert.equal(owner, identity); return action(1) },
    now: Date.now,
  }
  const previous = process.env.RIVET_OFFICIAL_GATEWAY_ORIGIN
  const previousOrigins = process.env.RIVET_OFFICIAL_GATEWAY_ORIGINS
  try {
    delete process.env.RIVET_OFFICIAL_GATEWAY_ORIGIN
    delete process.env.RIVET_OFFICIAL_GATEWAY_ORIGINS
    const prepared = await prepareOfficialServeContext(context, 'tianshu-official:published-agent', identity, undefined, dependencies)
    assert.equal(prepared.provider.auth?.type, 'tianshu-account')
    assert.equal(prepared.provider.baseUrl, 'https://tianshuharness.com')
    assert.equal(prepared.model.id, 'published-agent')
    assert.equal(prepared.apiKey, '')
    assert.deepEqual(prepared.autoDefaultModelRefs, ['tianshu-official:published-agent'])
    assert.equal(catalogs, 1)
    assert.equal(quotes, 0)
    assert.equal(context.config.provider.providers['tianshu-official'], undefined)
  } finally {
    if (previous === undefined) delete process.env.RIVET_OFFICIAL_GATEWAY_ORIGIN
    else process.env.RIVET_OFFICIAL_GATEWAY_ORIGIN = previous
    if (previousOrigins === undefined) delete process.env.RIVET_OFFICIAL_GATEWAY_ORIGINS
    else process.env.RIVET_OFFICIAL_GATEWAY_ORIGINS = previousOrigins
  }
})

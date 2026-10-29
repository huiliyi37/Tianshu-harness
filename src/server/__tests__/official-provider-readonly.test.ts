import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { providerSchema } from '../../config/schema.js'
import { loadConfig } from '../../config/manager.js'
import { buildConfigRoutes } from '../config-routes.js'
import { oauthListFields } from '../config-routes-oauth.js'
import { createRouter } from '../index.js'
import { useFixtureHome } from './fixture-home.js'

const official = providerSchema.parse({ name: 'official-alias', auth: { type: 'tianshu-account' }, baseUrl: 'https://official.invalid', models: [{ id: 'managed-model', managed: { bindingId: 'fixture-binding' } }] })
const auth = { authorization: 'Bearer local-fixture' }
const model = { id: 'caller-model', contextWindow: 32000, maxTokens: 4096 }

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'official-readonly-'))
  const restore = useFixtureHome(home)
  const path = join(home, 'config.json')
  writeFileSync(path, JSON.stringify({ provider: { default: 'deepseek', providers: { 'official-alias': official } } }))
  loadConfig()
  const before = readFileSync(path, 'utf8')
  let probes = 0
  let changes = 0
  const router = createRouter(buildConfigRoutes('local-fixture', {
    endpointTransport: { fetchImpl: async () => { probes++; throw new Error('must not probe') } },
    onProviderConfigChanged: () => { changes++ },
  }))
  return { router, path, before, probes: () => probes, changes: () => changes, close: () => { restore(); rmSync(home, { recursive: true, force: true }) } }
}

for (const provider of ['tianshu-official', 'official-alias']) {
  const mutations: Array<[string, string, unknown]> = [
    ['POST', '/config/providers', { providerName: provider, apiKey: 'synthetic', model }],
    ['POST', '/config/providers/custom', { providerName: provider, baseUrl: 'https://caller.invalid/v1', apiKey: 'synthetic', model, force: true }],
    ['POST', '/config/providers/tunables', { providerName: provider, fields: { slowThinking: true } }],
    ['DELETE', `/config/providers/${provider}`, {}],
    ['DELETE', `/config/providers/${provider}/models/managed-model`, {}],
    ['POST', `/config/providers/${provider}/key`, { apiKey: 'synthetic' }],
    ['DELETE', `/config/providers/${provider}/key`, {}],
    ['PUT', `/config/providers/${provider}/allow-pro-fallback`, { allowProFallback: true }],
  ]
  for (const [method, path, body] of mutations) {
    test(`${method} ${path} refuses ${provider} edits before probe or persistence`, async () => {
      const current = fixture()
      try {
        assert.equal((await current.router(method, path, body, {})).status, 401)
        const response = await current.router(method, path, body, auth)
        assert.equal(response.status, 403, JSON.stringify(response.body))
        assert.deepEqual(response.body, { error: 'official_provider_read_only' })
        assert.equal(current.probes(), 0)
        assert.equal(current.changes(), 0)
        assert.equal(readFileSync(current.path, 'utf8'), current.before)
      } finally { current.close() }
    })
  }
}

for (const route of ['/config/providers', '/config/providers/custom']) {
  for (const metadata of [ { auth: { type: 'tianshu-account' } }, { model: { ...model, managed: { bindingId: 'caller-binding' } } }, { models: [{ ...model, managed: { bindingId: 'caller-binding' } }] } ]) {
    test(`${route} rejects caller-supplied managed identity ${JSON.stringify(metadata)}`, async () => {
      const current = fixture()
      try {
        const response = await current.router('POST', route, { providerName: 'caller-byok', baseUrl: 'https://caller.invalid/v1', model, ...metadata }, auth)
        assert.equal(response.status, 403, JSON.stringify(response.body))
        assert.equal(current.probes(), 0)
        assert.equal(current.changes(), 0)
        assert.equal(readFileSync(current.path, 'utf8'), current.before)
      } finally { current.close() }
    })
  }
}

for (const route of ['/config/providers/test-key', '/config/providers/test']) {
  for (const override of [{ apiKey: 'synthetic' }, { apiKeyEnv: 'SYNTHETIC_ONLY' }, { baseUrl: 'https://caller.invalid/v1' }, { protocol: 'anthropic' }, { endpointNetworkPolicy: { origin: 'https://caller.invalid' } }]) {
    test(`${route} rejects official overrides ${JSON.stringify(override)} before probe`, async () => {
      const current = fixture()
      try {
        const response = await current.router('POST', route, { provider: 'official-alias', model: 'managed-model', ...override }, auth)
        assert.equal(response.status, 403, JSON.stringify(response.body))
        assert.equal(current.probes(), 0)
        assert.equal(readFileSync(current.path, 'utf8'), current.before)
      } finally { current.close() }
    })
  }
}

test('official provider listing does not claim keyless, free, or OAuth authority', async () => {
  const current = fixture()
  try {
    assert.deepEqual(oauthListFields(official), { authType: 'tianshu-account', officialAvailable: false })
    const response = await current.router('GET', '/config/providers', {}, auth)
    const provider = (response.body as { providers: Array<Record<string, unknown>> }).providers.find(entry => entry.name === 'official-alias')!
    assert.equal(provider.authType, 'tianshu-account')
    assert.equal(provider.officialAvailable, false)
    assert.equal(provider.keyless, false)
    assert.deepEqual(provider.keyStatus, { source: 'none', ref: '' })
    assert.equal((provider.models as Array<{ free?: boolean }>)[0]?.free, undefined)
  } finally { current.close() }
})

function loadFunction(file: string, name: string, bindings: Record<string, unknown>): (...args: unknown[]) => Promise<Record<string, unknown>> {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const declaration = parsed.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name)
  assert.ok(declaration, `current production function ${name}`)
  const compiled = ts.transpileModule(declaration.getText(parsed).replace(/^export /, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return runInNewContext(`${compiled}\n${name}`, { ...bindings })
}

test('official probe target never resolves stored BYOK credentials', async () => {
  let reads = 0
  const resolveTarget = loadFunction('../config-routes.ts', 'resolveProviderProbeTarget', {
    loadConfig: () => { reads++; return { provider: { providers: { 'official-alias': official } } } },
    isOfficialProvider: () => true,
    resolveApiKey: () => { throw new Error('must not resolve BYOK credentials') },
    resolveCredentialKey: () => { throw new Error('must not resolve key-pool credentials') },
    assertCredentialOrigin: () => { throw new Error('must not route through the BYOK override path') },
  })
  const result = await resolveTarget('official-alias', undefined, undefined)
  assert.equal(result.baseUrl, official.baseUrl)
  assert.equal(result.apiKey, undefined)
  assert.equal(result.error, undefined)
  assert.equal(reads, 1)
})

test('official test-key catalog failure never falls back to completion or keyless authority', async () => {
  const calls: unknown[] = []
  const probe = loadFunction('../provider-probe-adapter.ts', 'probeForTestKey', {
    loadConfig: () => ({ provider: { providers: { 'official-alias': official } } }),
    isOfficialProvider: () => true,
    DEFAULT_PROBE_TIMEOUT_MS: 1000,
    hasModelsListEndpoint: () => true,
    probeProvider: async (options: unknown) => { calls.push(options); return { models: [], modelsOk: false, modelListError: { code: 'http-404' } } },
    mapError: () => ({ ok: false, error: 'http-404' }),
    probeByCompletion: () => { throw new Error('official probes must never send completion') },
  })
  const result = await probe({ providerName: 'official-alias', baseUrl: official.baseUrl, probeModel: 'managed-model' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'http-404')
  assert.equal(result.keyless, undefined)
  assert.equal(calls.length, 1)
  assert.equal((calls[0] as { skipCompletion: boolean }).skipCompletion, true)
})

test('official test-key success returns catalog models without editable inferred descriptors', async () => {
  const probe = loadFunction('../provider-probe-adapter.ts', 'probeForTestKey', {
    loadConfig: () => ({ provider: { providers: { 'official-alias': official } } }),
    isOfficialProvider: () => true,
    DEFAULT_PROBE_TIMEOUT_MS: 1000,
    hasModelsListEndpoint: () => true,
    probeProvider: async () => ({ models: ['managed-model'], modelsOk: true }),
    matchModelIds: () => { throw new Error('official metadata must come from the catalog') },
  })
  const result = await probe({ providerName: 'official-alias', baseUrl: official.baseUrl })
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, models: ['managed-model'] })
})

test('actual model-test route only checks official catalog even with an explicit model', async () => {
  const source = readFileSync(new URL('../config-routes.ts', import.meta.url), 'utf8')
  const parsed = ts.createSourceFile('config-routes.ts', source, ts.ScriptTarget.Latest, true)
  const handlers: ts.Expression[] = []
  function visit(node: ts.Node): void {
    if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && node.name.text === 'POST /config/providers/test') handlers.push(node.initializer)
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.equal(handlers.length, 1)
  const calls: Array<{ skipCompletion: boolean }> = []
  const compiled = ts.transpileModule(`const handler = ${handlers[0]!.getText(parsed)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const route = runInNewContext(`${compiled}\nhandler`, {
    apiToken: 'local-fixture',
    withAuth: (callback: unknown) => callback,
    resolveProviderProbeTarget: () => ({ apiKey: undefined, baseUrl: official.baseUrl }),
    officialProviderProbeError: () => undefined,
    loadConfig: () => ({ provider: { providers: { 'official-alias': official } } }),
    isOfficialProvider: () => true,
    endpointNetworkInput: () => ({}), hooks: {},
    probeProvider: async (options: { skipCompletion: boolean }) => { calls.push(options); return { models: ['managed-model'], modelsOk: true, completionOk: false, errors: [] } },
  })
  const response = await route({ provider: 'official-alias', model: 'managed-model' })
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.equal(response.body.completionSkipped, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.skipCompletion, true)
})

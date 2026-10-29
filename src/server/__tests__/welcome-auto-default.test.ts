import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { configSchema, type Config, type ProviderConfig } from '../../config/schema.js'
import { assertDefaultModelRef, contractModels } from '../../config/contract-models.js'
import { resolveModelRef } from '../../config/provider-keys.js'
import { resolveSessionDefaults } from '../session-defaults.js'
import { providerHasUsableAuth } from '../model-spec-policy.js'
import { isSessionWorkspaceMode } from '../workspace.js'
import { RuntimeSessionManager } from '../session-manager.js'
import { prepareSessionPrompt, SlashPromptError } from '../session-skills-helper.js'
import { validateDocumentsPayload, extractDocumentsToText, validateArchivesPayload } from '../attachment-validation.js'
import { readCreationRequest, creationPrompt } from '../skill-creation-session.js'
import { persistDocumentsForPrompt } from '../attachment-validation.js'
import { attachRetainedSessionReceipt } from '../index.js'
import { OfficialError, type Catalog } from '../../models/official-contract.js'
import { activateRequiredTools } from '../../workflows/required-tools.js'
import { createManagedAccountAuth, getPreparedModel, isOfficialProvider, isPreparedModelEligible, prepareRuntimeContext, resolveProviderForModel } from '../../models/model-runtime.js'

const servePath = new URL('../serve.ts', import.meta.url)
const serveFile = ts.createSourceFile('serve.ts', readFileSync(servePath, 'utf8'), ts.ScriptTarget.Latest, true)
const routeFile = ts.createSourceFile('session-routes.ts', readFileSync(new URL('../session-routes.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
function find(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node {
  if (predicate(root)) return root
  let result: ts.Node | undefined
  root.forEachChild(child => { if (!result) { try { result = find(child, predicate) } catch {} } })
  assert.ok(result, 'production closure must exist')
  return result
}
function evaluate(source: string, bindings: object) {
  return runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, bindings)
}
const effectiveAssignment = find(serveFile, node => ts.isBinaryExpression(node) && node.left.getText(serveFile) === "routes['GET /config/default-model']") as ts.BinaryExpression
const prepareProperty = find(serveFile, node => ts.isPropertyAssignment(node) && node.name.getText(serveFile) === 'prepareOfficialSession') as ts.PropertyAssignment
const postProperty = find(routeFile, node => ts.isPropertyAssignment(node) && node.name.getText(routeFile) === "'POST /sessions'") as ts.PropertyAssignment
assert.ok(ts.isCallExpression(postProperty.initializer))
const postExpression = postProperty.initializer.arguments[0]
assert.ok(postExpression, 'POST session handler must exist')
const postSource = postExpression.getText(routeFile)
let imageValidator: ts.FunctionDeclaration
try { imageValidator = find(routeFile, node => ts.isFunctionDeclaration(node) && node.name?.text === 'validateImagesPayload') as ts.FunctionDeclaration }
catch {
  const file = ts.createSourceFile('attachment-validation.ts', readFileSync(new URL('../attachment-validation.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  imageValidator = find(file, node => ts.isFunctionDeclaration(node) && node.name?.text === 'validateImagesPayload') as ts.FunctionDeclaration
}

async function fixture(run: (page: Awaited<ReturnType<typeof setup>>) => Promise<void>, tools = true) {
  const cwd = mkdtempSync(join(tmpdir(), 'tianshu-welcome-default-'))
  try { await run(await setup(cwd, tools)) } finally { rmSync(cwd, { recursive: true, force: true }) }
}
async function setup(cwd: string, tools: boolean) {
  const ordinary: ProviderConfig = {
    name: 'synthetic-default', baseUrl: 'https://byok.example.invalid', protocol: 'openai',
    apiKeyEnv: 'SYNTHETIC_AUTO_DEFAULT_MISSING_KEY',
    capabilities: { cacheControl: false, stripParams: [], toolJsonBug: false, prefixCache: 'none', prefixCompletion: false },
    models: [{ id: 'synthetic-default-model', maxTokens: 4096, contextWindow: 32000 }],
    thinking: 'disabled', maxTokens: 4096, unsupported: [],
  }
  let config = configSchema.parse({ provider: { default: ordinary.name, providers: { [ordinary.name]: ordinary } } })
  const issued = { subject: 'synthetic-subject', accountSessionId: 'synthetic-session', deviceId: 'synthetic-device', generation: 1, incarnation: 'synthetic-incarnation' }
  let identity: typeof issued | null = issued
  const guard = <Value,>(owner: typeof issued, action: () => Value): Value => {
    if (owner !== identity) throw new OfficialError('account_changed')
    return action()
  }
  const modelId = 'published-agent-from-catalog'
  const official: ProviderConfig = { ...ordinary, name: 'tianshu-official', apiKeyEnv: undefined, auth: { type: 'tianshu-account' }, baseUrl: 'https://gateway.example.invalid', models: [{ id: modelId, maxTokens: 4096, contextWindow: 32000 }] }
  const catalog: Catalog = { revision: 'synthetic-catalog', models: [{
    id: modelId, displayName: 'Published synthetic agent', provider: 'synthetic-supplier', status: 'available', contextWindow: 32000, maxOutputTokens: 4096, capabilities: { tools, vision: false, thinking: false },
    bindings: [{ id: 'synthetic-binding', modelId, billingMode: 'server', operation: 'chat', protocol: 'openai', origin: official.baseUrl, path: '/v1/chat/completions', stream: true, capabilities: { tools, vision: false, thinking: false }, requiredHeaders: null, thinkingPolicy: 'none', pricingRevision: 'synthetic-price' }],
    costStatus: 'unavailable',
  }] }
  const secondModelId = 'published-secondary-from-catalog'
  const primaryModel = official.models[0]
  const catalogModel = catalog.models[0]
  const primaryBinding = catalogModel?.bindings[0]
  assert.ok(primaryModel, 'official fixture must contain a primary model')
  assert.ok(catalogModel, 'catalog fixture must contain a primary model')
  assert.ok(primaryBinding, 'catalog fixture must contain a primary binding')
  official.models.push({ ...primaryModel, id: secondModelId })
  catalog.models.push({ ...catalogModel, id: secondModelId, bindings: [{ ...primaryBinding, id: 'synthetic-secondary-binding', modelId: secondModelId }] })
  let quotes = 0
  const forbidden = async (): Promise<never> => { quotes++; throw new Error('no real quote or inference allowed') }
  const runtimeDeps = {
    captureIdentity: () => issued, getCatalog: async () => catalog,
    getCredential: async () => ({} as never), getQuote: forbidden,
    withIdentity: <Value,>(owner: typeof issued, action: (epoch: number) => Value) => guard(owner, () => action(1)), now: Date.now,
  }
  const preparedModel = await prepareRuntimeContext({
    config: { ...config, provider: { ...config.provider, providers: { ...config.provider.providers, 'tianshu-official': official } } }, provider: official, apiKey: '',
  }, 'tianshu-official:' + modelId, 'probe', runtimeDeps)
  let published: ProviderConfig | undefined = preparedModel.config.provider.providers['tianshu-official']
  let afterPrepare: (() => void) | undefined
  let afterCreate: (() => void) | undefined
  let afterListing: (() => void) | undefined
  const runs: unknown[][] = []
  const officialSessionContexts = new Map<string, unknown>()
  const restoredSessions = new Set<string>()
  const manager = new RuntimeSessionManager({
    createAgent: () => { throw new Error('no model agent allowed') },
    defaultCwd: cwd, readSessionConfig: () => config,
  })
  manager.run = ((...args: unknown[]) => { runs.push(args) }) as typeof manager.run
  const create = manager.createSession.bind(manager)
  manager.createSession = input => { const record = create(input); afterCreate?.(); return record }
  const context = () => ({ config, provider: config.provider.providers[config.provider.default], apiKey: '', model: ordinary.models[0], configured: false })
  const publicContext = () => ({ ...context(), config: { ...config, provider: { ...config.provider, providers: { ...config.provider.providers, ...(published ? { 'tianshu-official': published } : {}) } } } })
  const helperPath = new URL('../session-auto-default.ts', import.meta.url)
  let resolveSessionAutoDefault: unknown
  if (existsSync(helperPath)) {
    const file = ts.createSourceFile('session-auto-default.ts', readFileSync(helperPath, 'utf8'), ts.ScriptTarget.Latest, true)
    const declaration = find(file, node => ts.isFunctionDeclaration(node) && node.name?.text === 'resolveSessionAutoDefault') as ts.FunctionDeclaration
    resolveSessionAutoDefault = evaluate(declaration.getText(file).replace(/^export\s+/, '') + '\nresolveSessionAutoDefault', {
      resolveSessionDefaults, resolveProviderForModel, assertDefaultModelRef, contractModels, resolveModelRef, providerHasUsableAuth,
      isOfficialProvider, getPreparedModel, isPreparedModelEligible, withCurrentOfficialIdentity: guard,
    })
  }
  const modelListingViews = new WeakMap<object, { context: ReturnType<typeof publicContext>; modelRefs: readonly string[] }>()
  const preparation = find(serveFile, node => ts.isFunctionDeclaration(node) && node.name?.text === 'prepareOfficialServeContext') as ts.FunctionDeclaration
  const prepareContext = evaluate(preparation.getText(serveFile).replace(/^export\s+/, '') + '\nprepareOfficialServeContext', {
    OfficialError, structuredClone, resolveProviderForModel, isOfficialProvider, createManagedAccountAuth, prepareRuntimeContext, contractModels,
    withOfficialProviderView: async (context: ReturnType<typeof publicContext>) => ({
      ...context, config: { ...context.config, provider: { ...context.config.provider, providers: {
        ...context.config.provider.providers, 'tianshu-official': { ...official, models: catalog.models.map(model => ({ id: model.id, contextWindow: model.contextWindow, maxTokens: model.maxOutputTokens })) },
      } } },
    }),
  }) as (...args: unknown[]) => Promise<ReturnType<typeof publicContext>>
  const bindings = {
    activateRequiredTools,
    Error, AbortController, process: { env: {} }, performance, randomUUID,
    ctx: context(), specReload: context, sessions: manager,
    executionBackend: { kind: 'in-process' }, timing: { mark() {} },
    officialProviderId: 'tianshu-official', OfficialError, isOfficialProvider, getPreparedModel,
    resolveProviderForModel, resolveSessionDefaults, resolveSessionAutoDefault, providerHasUsableAuth, contractModels,
    captureOfficialIdentity: () => identity, withCurrentOfficialIdentity: guard,
    getOfficialCatalog: runtimeDeps.getCatalog, getOfficialCredential: runtimeDeps.getCredential, getOfficialPriceQuote: forbidden,
    defaultModelRuntimeDeps: runtimeDeps,
    prepareOfficialServeContext: async (...args: unknown[]) => { const value = await prepareContext(...args); afterPrepare?.(); return value },
    officialSessionContexts, restoredSessions, loadConfig: () => config,
    modelListingViews,
    prepareServeModelListing: async (listing: object) => { modelListingViews.set(listing, { context: publicContext(), modelRefs: catalog.models.map(model => 'tianshu-official:' + model.id) }); afterListing?.() },
    configuredDefaultRoute: async () => ({ status: 200, body: { defaultModel: config.agent.defaultModel ?? null } }),
    isSessionWorkspaceMode, resolveSessionWorkspace: () => ({ path: cwd, source: 'scratch', managed: false }),
    existsSync, statSync: () => ({ isDirectory: () => true }), sessionScratchRoot: () => cwd, profileRivetHome: () => cwd,
    modelEffortSupported: () => false,
  }
  const get = evaluate('(' + effectiveAssignment.right.getText(serveFile) + ')', bindings) as (...args: unknown[]) => Promise<{ status: number; body: { defaultModel: string | null; effective: { status: string; modelRef?: string; kind?: string; available?: boolean } } }>
  const prepare = evaluate('(' + prepareProperty.initializer.getText(serveFile) + ')', bindings)
  const postBindings = {
    ...bindings, manager, dependencies: { prepareOfficialSession: prepare },
    validateDocumentsPayload, extractDocumentsToText, validateArchivesPayload, persistDocumentsForPrompt,
    persistArchivesForPrompt: async () => undefined, readCreationRequest, creationPrompt, attachRetainedSessionReceipt,
    prepareSessionPrompt, SlashPromptError,
  }
  const post = evaluate(imageValidator.getText().replace(/^export\s+/, '') + '\n(' + postSource + ')', postBindings) as (body: object) => Promise<{ status: number; body: Record<string, unknown> }>
  const ref = 'tianshu-official:' + modelId
  const payload = () => ({ cwd, model: ref, modelSelection: 'auto', officialAccountAction: 'new-session', prompt: 'synthetic unsent draft' })
  return {
    manager, runs, ref, payload, officialSessionContexts,
    secondRef: 'tianshu-official:' + secondModelId,
    reorderCatalog() { catalog.models.reverse() },
    get config() { return config }, set config(value: Config) { config = value },
    get quotes() { return quotes },
    set identity(value: typeof issued | null) { identity = value },
    set published(value: ProviderConfig | undefined) { published = value },
    get published() { return published },
    onPrepare(callback: () => void) { afterPrepare = callback },
    onCreate(callback: () => void) { afterCreate = callback },
    onListing(callback: () => void) { afterListing = callback },
    metadata: () => get(undefined, { scope: 'welcome', workspaceMode: 'scratch' }),
    post,
  }
}

test('actual GET producer resolves cold keyless default to the published prepared official agent without persisting configuration', async () => fixture(async page => {
  const before = JSON.stringify(page.config)
  const response = await page.metadata()
  assert.equal(response.status, 200)
  assert.equal(response.body.defaultModel, null)
  assert.equal(response.body.effective.status, 'resolved')
  assert.equal(response.body.effective.modelRef, page.ref)
  assert.equal(response.body.effective.kind, 'official')
  assert.equal(response.body.effective.available, true)
  assert.equal(JSON.stringify(page.config), before)
  assert.equal(page.quotes, 0)
}))

test('actual GET and POST auto checks select the same virtual official default and create a fresh captured session', async () => fixture(async page => {
  const metadata = await page.metadata()
  assert.equal(metadata.body.effective.modelRef, page.ref)
  const response = await page.post(page.payload())
  assert.equal(response.status, 201)
  assert.equal(page.manager.listAllSessions().length, 1)
  assert.equal(page.officialSessionContexts.size, 1)
  assert.equal(page.runs.length, 1)
  assert.equal(page.quotes, 0)
}))

for (const usable of [false, true]) {
  test('explicit BYOK default never falls back to official, usable=' + usable, async () => fixture(async page => {
    page.config.agent.defaultModel = 'synthetic-default:synthetic-default-model'
    assert.ok(page.config.provider.providers['synthetic-default'])
    if (usable) page.config.provider.providers['synthetic-default'].apiKey = 'synthetic-key'
    const response = await page.metadata()
    assert.equal(response.body.defaultModel, 'synthetic-default:synthetic-default-model')
    assert.notEqual(response.body.effective.kind, 'official')
    const created = await page.post({ ...page.payload(), model: 'synthetic-default:synthetic-default-model', officialAccountAction: undefined })
    assert.equal(created.status, 201)
    assert.equal(page.officialSessionContexts.size, 0)
    if (usable) assert.equal(response.body.effective.modelRef, 'synthetic-default:synthetic-default-model')
    assert.equal(page.quotes, 0)
  }))
}

test('usable ordinary default remains ordinary when official models are available', async () => fixture(async page => {
  assert.ok(page.config.provider.providers['synthetic-default'])
  page.config.provider.providers['synthetic-default'].apiKey = 'synthetic-key'
  const response = await page.metadata()
  assert.equal(response.body.effective.kind, 'known-byok')
  assert.equal(response.body.effective.modelRef, 'synthetic-default:synthetic-default-model')
  const created = await page.post({ ...page.payload(), model: 'synthetic-default:synthetic-default-model', officialAccountAction: undefined })
  assert.equal(created.status, 201)
  assert.equal(page.officialSessionContexts.size, 0)
}))

test('explicit official default resolves against current virtual listing absent from raw disk config', async () => fixture(async page => {
  page.config.agent.defaultModel = page.ref
  const response = await page.metadata()
  assert.equal(response.body.effective.modelRef, page.ref)
  assert.equal(response.body.effective.available, true)
  assert.equal((await page.post(page.payload())).status, 201)
}))

for (const unavailable of ['missing', 'unprepared', 'no-identity', 'collision', 'owner-changed'] as const) {
  test('official fallback fails closed for ' + unavailable, async () => fixture(async page => {
    if (unavailable === 'missing') page.published = undefined
    if (unavailable === 'unprepared') page.published = { ...page.published! }
    if (unavailable === 'no-identity') page.identity = null
    if (unavailable === 'collision') {
      const ordinaryProvider = page.config.provider.providers['synthetic-default']
      assert.ok(ordinaryProvider)
      page.config.provider.providers['tianshu-official'] = { ...ordinaryProvider, name: 'tianshu-official' }
    }
    if (unavailable === 'owner-changed') page.onListing(() => { page.identity = null })
    const response = await page.metadata()
    assert.equal(response.body.effective.status, 'unknown')
    assert.equal(page.manager.listAllSessions().length, 0)
    assert.equal(page.quotes, 0)
  }))
}

test('probe-prepared listing without agent tool capability cannot become the default', async () => fixture(async page => {
  assert.equal((await page.metadata()).body.effective.status, 'unknown')
}, false))

for (const moment of ['after-preparation', 'after-record-created'] as const) {
  test('fresh default changes ' + moment + ' reject POST and roll back creation without running the preserved draft', async () => fixture(async page => {
    let changed = false
    const change = () => { changed = true; page.config.agent.defaultModel = 'synthetic-default:synthetic-default-model' }
    if (moment === 'after-preparation') page.onPrepare(change)
    else page.onCreate(change)
    const body = page.payload()
    const response = await page.post(body)
    assert.equal(response.status, 409)
    assert.equal(response.body.error, 'default_model_changed')
    assert.equal(changed, true, 'the test must reach the selected race boundary')
    assert.equal(page.manager.listAllSessions().length, 0)
    assert.equal(page.officialSessionContexts.size, 0)
    assert.equal(page.runs.length, 0)
    assert.equal(body.prompt, 'synthetic unsent draft')
    assert.equal(page.quotes, 0)
  }))
}

test('identity changes before commit cannot attach a fresh session to the replacement owner', async () => fixture(async page => {
  page.onCreate(() => { page.identity = null })
  const body = { ...page.payload(), modelSelection: undefined }
  const response = await page.post(body)
  assert.equal(response.status, 409)
  assert.equal(page.manager.listAllSessions().length, 0)
  assert.equal(page.officialSessionContexts.size, 0)
  assert.equal(page.runs.length, 0)
}))

test('AUTO POST cannot choose the requested primary ahead of authoritative published catalog order', async () => fixture(async page => {
  assert.equal((await page.metadata()).body.effective.modelRef, page.ref)
  const response = await page.post({ ...page.payload(), model: page.secondRef })
  assert.equal(response.status, 409)
  assert.equal(response.body.error, 'default_model_changed')
  assert.equal(page.manager.listAllSessions().length, 0)
  assert.equal(page.officialSessionContexts.size, 0)
  assert.equal(page.runs.length, 0)
}))

test('catalog reorder after GET invalidates the former implicit official default at POST', async () => fixture(async page => {
  assert.equal((await page.metadata()).body.effective.modelRef, page.ref)
  page.reorderCatalog()
  const response = await page.post(page.payload())
  assert.equal(response.status, 409)
  assert.equal(response.body.error, 'default_model_changed')
  assert.equal(page.manager.listAllSessions().length, 0)
  assert.equal(page.officialSessionContexts.size, 0)
  assert.equal(page.runs.length, 0)
}))

test('implicit BYOK authentication disappearing after GET rejects stale AUTO POST without running the draft', async () => fixture(async page => {
  const model = 'synthetic-default:synthetic-default-model'
  assert.ok(page.config.provider.providers['synthetic-default'])
  page.config.provider.providers['synthetic-default'].apiKey = 'synthetic-key'
  assert.equal((await page.metadata()).body.effective.modelRef, model)
  delete page.config.provider.providers['synthetic-default'].apiKey
  assert.equal((await page.metadata()).body.effective.modelRef, page.ref)
  const body = { ...page.payload(), model, officialAccountAction: undefined }
  const response = await page.post(body)
  assert.equal(response.status, 409)
  assert.equal(response.body.error, 'default_model_changed')
  assert.equal(page.manager.listAllSessions().length, 0)
  assert.equal(page.runs.length, 0)
  assert.equal(body.prompt, 'synthetic unsent draft')
  assert.equal(page.quotes, 0)
}))

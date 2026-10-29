import { DISABLED_USER_INSTRUCTIONS, createUserInstructionsSnapshot } from '../../prompt/user-instructions.js'
import { DelegationCoordinator } from '../coordinator.js'
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { configSchema, providerSchema, type Config, type ProviderConfig, type ModelTarget } from '../../config/schema.js'
import { buildWorkerRuntime, createWorkerRuntimeFactory, type WorkerRuntimeDeps } from '../worker-runtime.js'
import { workerModelPolicy } from '../worker-model-policy.js'
import { resolveModelBinding, modelBindingAvailability, sessionProviderKey, snapshotSessionBinding } from '../../model/model-binding.js'
import { buildModelCards } from '../../model/capability.js'
import { ToolRegistry } from '../../tools/registry.js'
import { createReadOnlyWorkOrder, deriveWorkerSessionId, type WorkOrder } from '../work-order.js'
import { runWorkerSession } from '../worker-session.js'
import { runWorkerSessionOop } from '../worker-process/parent.js'
import { getSessionDir, SessionPersist } from '../session-persist.js'
import { OAuthAuth } from '../../auth/oauth-auth.js'
import { mock } from 'node:test'
import { cloneResolvedPreset, proRegistry } from '../../api/pro-registry.js'
import { createAgentRuntime, type RuntimeRefs } from '../../bootstrap.js'
import { SessionContext } from '../context.js'
import { FileHistory } from '../file-history.js'
import { DomainKnowledgeStore } from '../domain-knowledge-store.js'
import { TodoStore } from '../../tools/todo-store.js'
import { createHeadlessCoordinator } from '../headless-coordinator.js'
import { loadConfig } from '../../config/manager.js'

const dir = mkdtempSync(join(tmpdir(), 'worker-model-policy-'))
const previousSessionDir = process.env.RIVET_SESSION_DIR
const previousConfigPath = process.env.RIVET_CONFIG_PATH
const calls: { model: string; authorization: string | undefined; apiKey: string | string[] | undefined; path: string | undefined; hasNestedRules: boolean }[] = []
let baseUrl = ''
let currentOrder: WorkOrder
let nestedMode = false
let delegated = false
const server = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  const input = JSON.parse(body)
  calls.push({ model: input.model, authorization: req.headers.authorization, apiKey: req.headers['x-api-key'], path: req.url, hasNestedRules: JSON.stringify(input.messages).includes('PINNED_NESTED_RULE') })
  const prompt = input.messages.map((message: { content?: unknown }) => typeof message.content === 'string' ? message.content : '').join('\n')
  const workOrderId = prompt.match(/\u5de5\u5355 ID[^:\uff1a\n]*[:\uff1a]([^\s\n]+)/)?.[1] ?? currentOrder?.id ?? 'test'
  if (nestedMode && input.model === 'other-flash' && !delegated) {
    delegated = true
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'nested-binding', type: 'function', function: { name: 'delegate_task', arguments: JSON.stringify({ objective: 'Check the exact root model binding', kind: 'code_search', profile: 'code_scout' }) } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`)
    return
  }
  const content = JSON.stringify({ workOrderId, status: 'passed', summary: 'Verified model binding', findings: [], artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'verified' })
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`)
})
before(async () => {
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  process.env.RIVET_SESSION_DIR = join(dir, 'sessions')
  process.env.RIVET_CONFIG_PATH = join(dir, 'fixture.json')
})
after(async () => {
  await new Promise<void>(done => server.close(() => done()))
  if (previousSessionDir === undefined) delete process.env.RIVET_SESSION_DIR; else process.env.RIVET_SESSION_DIR = previousSessionDir
  if (previousConfigPath === undefined) delete process.env.RIVET_CONFIG_PATH; else process.env.RIVET_CONFIG_PATH = previousConfigPath
  rmSync(dir, { recursive: true, force: true })
})

function provider(name = 'third-party', extra: Record<string, unknown> = {}): ProviderConfig {
  return providerSchema.parse({ name, apiKey: 'fixture-main', baseUrl, models: [
    { id: 'other-flash', contextWindow: 64000, maxTokens: 8192 },
    { id: 'exact-main', contextWindow: 200000, maxTokens: 32768 },
  ], ...extra })
}
function deps(configure?: (cfg: Config) => void): WorkerRuntimeDeps {
  const main = provider()
  const cfg = configSchema.parse({ provider: { default: main.name, providers: { [main.name]: main, missing: provider('missing', { apiKey: undefined, apiKeyEnv: 'TIANSHU_FIXTURE_ABSENT' }) } }, workers: { routing: {}, profiles: {} } })
  configure?.(cfg)
  return { getUserInstructions: () => DISABLED_USER_INSTRUCTIONS, config: cfg, cwd: dir, provider: main, apiKey: 'fixture-main', auth: undefined, currentModelId: 'exact-main', listActiveClaims: () => [], sessionMemoryBlock: () => undefined, domainKnowledgeStore: undefined, writeProfiles: ['patcher'] }
}
function order(profile = 'code_scout', target?: ModelTarget): WorkOrder {
  return createReadOnlyWorkOrder({ parentTurnId: `turn-${Math.random()}`, kind: 'doc_research', objective: 'Verify model selection', profile, scope: {}, modelOverride: target })
}
const registry = new ToolRegistry()
function runtime(d: WorkerRuntimeDeps, o = order()) { return buildWorkerRuntime(d, o, buildModelCards(d.provider)[0]!, registry) }

test('worker runtime inherits the configured read concurrency without changing model selection', () => {
  assert.equal(runtime(deps(c => { c.tools.readConcurrency = 1 })).readConcurrency, 1)
  assert.equal(runtime(deps()).readConcurrency, 4)
})
async function send(config: ReturnType<typeof runtime>) {
  currentOrder = config.order
  await config.client.stream({ model: config.promptEngine.getModel(), messages: [{ role: 'user', content: 'fixture' }], tools: [] }, {
    onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError(error) { throw error },
  })
  return calls.at(-1)!
}

test('unconfigured roles follow exact root model despite candidate order and tier', async () => {
  for (const profile of ['reviewer', 'adversarial_verifier', 'verifier', 'patcher', 'code_scout', 'doc_scout', 'council_expert']) {
    const d = deps(); d.provider.models.reverse()
    const cfg = runtime(d, order(profile))
    const request = await send(cfg)
    assert.equal(request.model, 'exact-main')
    assert.equal(request.authorization, 'Bearer fixture-main')
    assert.equal(cfg.runtimeDecision?.strategy, 'session')
    assert.equal(cfg.contextWindow, 200000)
  }
})
test('explicit follow bypasses fixed task routes; deleting the override would be wrong', async () => {
  const d = deps(cfg => { cfg.agent.review.profiles.code_scout = { strategy: 'session' }; cfg.workers.routing.repo_summarization = 'legacy'; cfg.workers.profiles.legacy = { provider: 'third-party', model: 'other-flash' } })
  const cfg = runtime(d)
  assert.equal((await send(cfg)).model, 'exact-main')
  assert.equal(cfg.runtimeDecision?.source, 'role')
})
test('invalid explicit targets block before HTTP and never fall back to main', async () => {
  for (const [target, reason] of [
    [{ provider: 'missing', model: 'other-flash' }, 'missing_credentials'],
    [{ provider: 'deleted', model: 'other-flash' }, 'provider_deleted'],
    [{ provider: 'third-party', model: 'deleted' }, 'model_deleted'],
  ] as const) {
    const d = deps(cfg => { cfg.agent.review.profiles.code_scout = target; cfg.workers.defaultStrategy = 'auto' })
    const before = calls.length
    assert.throws(() => runtime(d), new RegExp(reason))
    assert.equal(calls.length, before)
  }
})
test('precedence is order, role, task, default; automatic is an explicit policy', () => {
  const d = deps(cfg => { cfg.workers.defaultStrategy = 'auto'; cfg.workers.routing.repo_summarization = { strategy: 'session' }; cfg.agent.review.profiles.code_scout = { strategy: 'auto' } })
  assert.equal(workerModelPolicy(d.config, order()).source, 'role')
  assert.equal(workerModelPolicy(d.config, order('code_scout', { strategy: 'session' })).source, 'order')
  delete d.config.agent.review.profiles.code_scout
  assert.equal(workerModelPolicy(d.config, order()).source, 'task')
  delete d.config.workers.routing.repo_summarization
  assert.deepEqual(workerModelPolicy(d.config, order()).target, { strategy: 'auto' })
  assert.equal(runtime(d).runtimeDecision?.model, 'other-flash')
})
test('multi-key same-name models preserve exact root ownership and fixed overrides', async () => {
  const d = deps(cfg => { cfg.provider.providers['third-party'] = provider('third-party', { keys: [
    { id: 'account-a', apiKey: 'fixture-a', models: [{ id: 'exact-main', contextWindow: 32000, maxTokens: 2048 }] },
    { id: 'account-b', apiKey: 'fixture-b', models: [{ id: 'exact-main', contextWindow: 150000, maxTokens: 16384 }] },
  ] }) })
  d.provider = d.config.provider.providers['third-party']!; d.apiKey = 'fixture-b'
  const root = runtime(d)
  assert.equal((await send(root)).authorization, 'Bearer fixture-b')
  assert.equal(root.contextWindow, 150000)
  assert.equal(root.runtimeDecision?.keyId, 'account-b')
  const fixed = runtime(d, order('code_scout', { provider: 'third-party', model: 'exact-main', keyId: 'account-a' }))
  assert.equal((await send(fixed)).authorization, 'Bearer fixture-a')
  assert.equal(fixed.contextWindow, 32000)
})
test('keyless, env credentials, cross-provider names and OAuth readiness use shared resolver', () => {
  const d = deps()
  d.config.provider.providers.local = provider('local', { apiKey: undefined, baseUrl: 'http://localhost:11434/v1' })
  assert.equal(resolveModelBinding(d.config.provider.providers, { provider: 'local', model: 'exact-main' }).apiKey, '')
  process.env.TIANSHU_MODEL_FIXTURE = 'fixture-env'
  try {
    d.config.provider.providers.env = provider('env', { apiKey: undefined, apiKeyEnv: 'TIANSHU_MODEL_FIXTURE' })
    assert.equal(resolveModelBinding(d.config.provider.providers, { provider: 'env', model: 'exact-main' }).apiKey, 'fixture-env')
  } finally { delete process.env.TIANSHU_MODEL_FIXTURE }
  d.config.provider.providers.oauth = provider('oauth', { apiKey: undefined, auth: { type: 'oauth', provider: 'codex' } })
  const oauth = mock.method(OAuthAuth.prototype, 'isAuthenticated', () => false)
  try {
    assert.equal(modelBindingAvailability(d.config.provider.providers, { provider: 'oauth', model: 'exact-main' }).reason, 'oauth_not_authenticated')
    oauth.mock.mockImplementation(() => true)
    assert.ok(resolveModelBinding(d.config.provider.providers, { provider: 'oauth', model: 'exact-main' }).auth)
  } finally { oauth.mock.restore() }
})
test('dispatch snapshot pins retries; later dispatch reads changed model and saved strategy', async () => {
  const d = deps(), factory = createWorkerRuntimeFactory(() => d), first = order()
  assert.equal((await factory.selectModel(first))?.model, 'exact-main')
  d.currentModelId = 'other-flash'; d.config.workers.defaultStrategy = 'auto'
  assert.equal((await factory.runtimeFactory(first, buildModelCards(d.provider)[0]!, registry)).runtimeDecision?.model, 'exact-main')
  const next = order()
  assert.equal(await factory.selectModel(next), undefined)
  d.config.workers.defaultStrategy = 'session'
  assert.equal((await factory.selectModel(order()))?.model, 'other-flash')
})
test('root unavailable fails closed rather than choosing another model', () => {
  const d = deps(); d.currentModelId = 'deleted'
  assert.throws(() => runtime(d), /model_deleted/)
})
test('nested follow uses root snapshot even when parent worker is fixed to another model', async () => {
  const d = deps(), root = snapshotSessionBinding(d.provider, 'exact-main', d.apiKey)
  d.currentModelId = 'other-flash'; d.rootSessionBinding = root
  assert.equal((await send(runtime(d))).model, 'exact-main')
})
test('actual worker request and persisted metadata use final decision', async () => {
  const cfg = runtime(deps(), order('code_scout', { provider: 'third-party', model: 'exact-main' }))
  cfg.maxTurns = 1; cfg.sessionNonce = 'policytest'; currentOrder = cfg.order
  await runWorkerSession(cfg)
  assert.equal(calls.at(-1)?.model, 'exact-main')
  const meta = JSON.parse(readFileSync(join(getSessionDir(dir), `${deriveWorkerSessionId(cfg.order.id, cfg.sessionNonce)}.meta.json`), 'utf8'))
  assert.equal(meta.model, 'exact-main')
  assert.equal(meta.modelSelection.fallbackReason, undefined)
  assert.equal(meta.modelSelection.strategy, 'fixed')
})
test('real isolated worker reconstructs root binding instead of global default', async () => {
  const d = deps(); d.config.provider.default = 'missing'
  writeFileSync(process.env.RIVET_CONFIG_PATH!, JSON.stringify(d.config))
  const cfg = runtime(d); cfg.maxTurns = 1; cfg.sessionNonce = 'isolated'; currentOrder = cfg.order
  const result = await runWorkerSessionOop(cfg, { getMemoryBlock: () => undefined, stallMsOverride: 30000,
    entryOverride: { execArgs: ['--import', 'tsx'], script: resolve('src/agent/worker-process/child.ts') } })
  assert.equal(calls.at(-1)?.model, 'exact-main')
  assert.equal(calls.at(-1)?.authorization, 'Bearer fixture-main')
  assert.notEqual(result.result.failureReason, 'worker_crash')
})

test('coordinator dispatch reports actual model and bypasses tier recommendation for follow', async () => {
  const d = deps(cfg => { cfg.agent.review.profiles.code_scout = { strategy: 'session' }; cfg.workers.escalationCap = 'strong' })
  const factory = createWorkerRuntimeFactory(() => d)
  const coordinator = new DelegationCoordinator({
    modelCards: buildModelCards(d.provider), baseToolRegistry: registry, maxWorkers: 1,
    runtimeFactory: factory.runtimeFactory, selectModel: factory.selectModel,
    runWorker: async cfg => {
      currentOrder = cfg.order
      cfg.maxTurns = 1
      const result = await runWorkerSession(cfg)
      cfg.onActivity?.('lifecycle', 'selected')
      return result
    },
  })
  const activities: { model?: string; provider?: string }[] = []
  try {
    const run = await coordinator.delegate({ parentTurnId: 'routing-coordinator', kind: 'code_search', profile: 'code_scout', objective: 'Verify the exact main model binding through dispatch', scope: {}, tierFloor: 'strong', onActivity: event => activities.push(event) })
    assert.equal(run.selectedModel, 'exact-main')
    assert.equal(run.results[0]?.model, 'exact-main')
    assert.equal(activities[0]?.model, 'exact-main')
    assert.equal(calls.at(-1)?.model, 'exact-main')
  } finally { coordinator.shutdown() }
})
test('real nested delegation from isolated fixed worker still follows root user session', async () => {
  const d = deps(); d.config.provider.default = 'missing'
  const instructions = createUserInstructionsSnapshot('PINNED_NESTED_RULE: preserve archives.')
  d.getUserInstructions = () => instructions
  writeFileSync(process.env.RIVET_CONFIG_PATH!, JSON.stringify(d.config))
  const parentRegistry = new ToolRegistry()
  parentRegistry.register({ definition: { name: 'delegate_task', description: 'Nested binding fixture', input_schema: { type: 'object', properties: {} } }, requiresApproval: () => false, isConcurrencySafe: () => true, isEnabled: () => true, execute: async () => ({ content: '' }) })
  const parentOrder = order('code_scout', { provider: 'third-party', model: 'other-flash' })
  parentOrder.allowedTools = ['delegate_task']
  const cfg = buildWorkerRuntime(d, parentOrder, buildModelCards(d.provider)[0]!, parentRegistry)
  cfg.maxTurns = 2; cfg.sessionNonce = 'nested'; currentOrder = cfg.order
  const start = calls.length; nestedMode = true; delegated = false
  try {
    await runWorkerSessionOop(cfg, { getMemoryBlock: () => undefined, stallMsOverride: 30000, entryOverride: { execArgs: ['--import', 'tsx'], script: resolve('src/agent/worker-process/child.ts') } })
    assert.ok(delegated)
    const requests = calls.slice(start)
    assert.equal(requests[0]?.model, 'other-flash')
    assert.ok(requests.some(request => request.model === 'exact-main'), 'real nested client must call root model')
    assert.ok(requests.filter(request => request.model === 'exact-main').every(request => request.authorization === 'Bearer fixture-main'))
    assert.ok(requests.every(request => request.hasNestedRules), 'parent and real nested HTTP requests must share the user rules')
  } finally { nestedMode = false }
})

test('legacy profile names resembling policy sentinels remain fixed bindings', async () => {
  const d = deps(cfg => {
    cfg.workers.routing.repo_summarization = '__session__'
    cfg.workers.profiles.__session__ = { provider: 'third-party', model: 'other-flash' }
  })
  const cfg = runtime(d)
  assert.equal(cfg.runtimeDecision?.strategy, 'fixed')
  assert.equal((await send(cfg)).model, 'other-flash')
})
test('deleted named task binding blocks without falling back or choosing a candidate', async () => {
  const d = deps(cfg => { cfg.workers.routing.repo_summarization = 'removed'; cfg.workers.defaultStrategy = 'auto' })
  const before = calls.length
  assert.throws(() => runtime(d), /route_deleted/)
  assert.equal(calls.length, before)
})

test('fixed keyless endpoint is an actual client binding, not a missing-key fallback', async () => {
  const d = deps(cfg => { cfg.provider.providers.local = provider('local', { apiKey: undefined }) })
  const cfg = runtime(d, order('code_scout', { provider: 'local', model: 'other-flash' }))
  const request = await send(cfg)
  assert.equal(cfg.runtimeDecision?.providerName, 'local')
  assert.equal(cfg.runtimeDecision?.fallbackReason, undefined)
  assert.equal(request.model, 'other-flash')
  assert.notEqual(request.authorization, 'Bearer fixture-main')
})
test('deleted main key slot fails closed while another same-model key is still available', () => {
  const d = deps(cfg => { cfg.provider.providers['third-party'] = provider('third-party', { keys: [
    { id: 'first', apiKey: 'fixture-first', models: [{ id: 'exact-main' }] },
    { id: 'main', apiKey: 'fixture-main', models: [{ id: 'exact-main' }] },
  ] }) })
  d.provider = d.config.provider.providers['third-party']!
  d.rootSessionBinding = snapshotSessionBinding(d.provider, d.currentModelId, d.apiKey)
  d.config.provider.providers['third-party']!.keys!.pop()
  assert.throws(() => runtime(d), /model_deleted/)
})

test('session binding uses the registry key, not a protocol/display name or the saved default', async () => {
  const d = deps()
  d.provider = provider('anthropic')
  d.config.provider.providers = { 'opencode-go-anthropic': d.provider, anthropic: provider('unrelated', { apiKey: 'fixture-wrong' }) }
  d.config.provider.default = 'anthropic'
  const cfg = runtime(d)
  assert.equal(cfg.runtimeDecision?.rootSessionBinding?.provider, 'opencode-go-anthropic')
  const request = await send(cfg)
  assert.ok(request.authorization === 'Bearer fixture-main' || request.apiKey === 'fixture-main')
  assert.equal(cfg.runtimeDecision?.model, 'exact-main')
})

test('a narrowed session provider is matched uniquely before reload, never by dictionary order', async () => {
  const d = deps()
  const configured = provider('Protocol display', { keys: [
    { id: 'selected', apiKey: 'fixture-main', models: [{ id: 'exact-main' }] },
    { id: 'other', apiKey: 'fixture-other', models: [{ id: 'other-flash' }] },
  ] })
  d.provider = { ...configured, keys: [configured.keys![0]!], models: configured.keys![0]!.models }
  d.config.provider.providers = { canonical: configured }
  const cfg = runtime(d)
  assert.equal(cfg.runtimeDecision?.rootSessionBinding?.provider, 'canonical')
  assert.equal(cfg.runtimeDecision?.keyId, 'selected')
  assert.equal((await send(cfg)).authorization, 'Bearer fixture-main')
  d.config.provider.providers.duplicate = structuredClone(configured)
  assert.throws(() => runtime(d), /provider_deleted/)
})

test('canonical root identity survives reload and display rename, but removal does not resurrect it', async () => {
  const d = deps()
  d.provider = provider('Display name')
  d.config.provider.providers = { canonical: d.provider }
  const factory = createWorkerRuntimeFactory(() => d)
  const first = order()
  assert.equal((await factory.selectModel(first))?.model, 'exact-main')
  const root = (await factory.runtimeFactory(first, buildModelCards(d.provider)[0]!, registry)).runtimeDecision!.rootSessionBinding!
  d.rootSessionBinding = root
  d.config = structuredClone(d.config)
  d.config.provider.providers.canonical!.name = 'Renamed display'
  assert.equal((await send(runtime(d))).authorization, 'Bearer fixture-main')
  delete d.config.provider.providers.canonical
  d.config.provider.providers['Display name'] = provider('Display name', { apiKey: 'fixture-wrong' })
  assert.throws(() => runtime(d), /provider_deleted/)
})

test('an absent session provider cannot adopt another account with the same display name and endpoint', () => {
  const d = deps()
  d.provider = provider('Shared display')
  d.config.provider.providers = { impostor: provider('Shared display', { apiKey: 'fixture-wrong-account' }) }
  assert.throws(() => runtime(d), /provider_deleted/)
})

test('protocol and inherited account mismatches stop at the real HTTP boundary', async () => {
  for (const mismatch of ['protocol', 'inherited account']) {
    const d = deps()
    d.provider = provider('Shared display', { keys: [{ id: 'selected', models: [{ id: 'exact-main' }] }] })
    const configured = structuredClone(d.provider)
    if (mismatch === 'protocol') configured.protocol = configured.protocol === 'anthropic' ? 'openai' : 'anthropic'
    else configured.apiKey = 'fixture-other-account'
    d.config.provider.providers = { canonical: configured }
    const start = calls.length
    await assert.rejects(async () => send(runtime(d)), /provider_deleted/)
    assert.equal(calls.length, start, mismatch)
  }
})

test('provider identity includes the API-key auth source, not an OAuth-only property', () => {
  const d = deps()
  d.provider = provider('Auth display', { auth: { type: 'api-key', keyEnv: 'TIANSHU_FIXTURE_AUTH_A' } })
  d.config.provider.providers = { canonical: structuredClone(d.provider) }
  assert.equal(runtime(d).runtimeDecision?.rootSessionBinding?.provider, 'canonical')
  d.config.provider.providers.canonical!.auth = { type: 'api-key', keyEnv: 'TIANSHU_FIXTURE_AUTH_B' }
  assert.throws(() => runtime(d), /provider_deleted/)
})

test('a credential-less key slot cannot inherit another account through provider matching', () => {
  for (const credential of ['apiKey', 'apiKeyEnv', 'keyRef'] as const) {
    const current = provider('Inherited display', { apiKey: undefined, [credential]: 'fixture-account-a', keys: [
      { id: 'inherited', models: [{ id: 'exact-main' }] },
    ] })
    const configured = provider('Inherited display', { apiKey: undefined, [credential]: 'fixture-account-b', keys: [
      { id: 'inherited', models: [{ id: 'exact-main' }] },
    ] })
    assert.throws(() => sessionProviderKey({ other: configured }, current), /provider_deleted/)
  }
})

test('inherited credentials must match while independently credentialed slots ignore unused provider keys', async () => {
  const d = deps()
  d.provider = provider('Inherited display', { apiKey: 'fixture-inherited', keys: [
    { id: 'inherited', models: [{ id: 'exact-main' }] },
  ] })
  d.apiKey = 'fixture-inherited'
  d.config.provider.providers = { canonical: structuredClone(d.provider) }
  assert.equal((await send(runtime(d))).authorization, 'Bearer fixture-inherited')
  d.provider.keys![0]!.apiKey = 'fixture-slot'
  d.apiKey = 'fixture-slot'
  d.config.provider.providers.canonical = structuredClone(d.provider)
  d.config.provider.providers.canonical!.apiKey = 'fixture-unused-other'
  assert.equal((await send(runtime(d))).authorization, 'Bearer fixture-slot')
})

test('registered dynamic presets are not a fallback for a deleted configured provider or fixed key', () => {
  const d = deps()
  proRegistry.registerPreset({ key: 'dynamic-worker-fixture', label: 'Dynamic fixture', description: 'fixture', apiKeyEnv: 'TIANSHU_FIXTURE_ABSENT', defaultModelId: 'exact-main', provider: provider('dynamic-worker-fixture') })
  const dynamic = cloneResolvedPreset('dynamic-worker-fixture')!
  d.provider = dynamic
  d.rootSessionBinding = { provider: 'dynamic-worker-fixture', model: 'exact-main' }
  d.config.provider.providers['dynamic-worker-fixture'] = dynamic
  assert.equal(runtime(d).runtimeDecision?.model, 'exact-main')
  delete d.config.provider.providers['dynamic-worker-fixture']
  assert.throws(() => runtime(d), /provider_deleted/)
  d.config.provider.providers['dynamic-worker-fixture'] = provider('dynamic-worker-fixture', { keys: [{ id: 'remaining', apiKey: 'fixture-other', models: [{ id: 'exact-main' }] }] })
  assert.throws(() => runtime(d, order('code_scout', { provider: 'dynamic-worker-fixture', model: 'exact-main', keyId: 'deleted' })), /model_deleted/)
})

test('real saved reload retains a configured dynamic preset, but drops a session-only overlay and honors deletion', async () => {
  const d = deps()
  const dynamicKey = 'dynamic-spark-reload-fixture'
  proRegistry.registerPreset({ key: dynamicKey, label: 'Spark-style dynamic preset', description: 'fixture', apiKeyEnv: 'TIANSHU_FIXTURE_ABSENT', defaultModelId: 'exact-main', provider: provider(dynamicKey) })
  const dynamic = cloneResolvedPreset(dynamicKey)!
  d.provider = dynamic
  d.rootSessionBinding = { provider: dynamicKey, model: 'exact-main' }
  writeFileSync(process.env.RIVET_CONFIG_PATH!, JSON.stringify({ provider: { providers: { [dynamicKey]: dynamic } } }))
  const factory = createWorkerRuntimeFactory(() => ({ ...d, config: loadConfig({ cwd: dir }) }))
  assert.equal((await factory.selectModel(order()))?.model, 'exact-main')
  writeFileSync(process.env.RIVET_CONFIG_PATH!, '{}')
  const sessionOnly = loadConfig({ cwd: dir, sessionOverlay: { provider: { providers: { [dynamicKey]: dynamic } } } })
  assert.ok(sessionOnly.provider.providers[dynamicKey])
  assert.equal(loadConfig({ cwd: dir }).provider.providers[dynamicKey], undefined)
  assert.ok(cloneResolvedPreset(dynamicKey))
  assert.throws(() => factory.selectModel(order()), /provider_deleted/)
})

test('real isolated fixed worker keeps registry identity separate from the wire provider name', async () => {
  const d = deps()
  d.config.provider.providers.canonical = provider('Protocol display', { apiKey: 'fixture-fixed' })
  writeFileSync(process.env.RIVET_CONFIG_PATH!, JSON.stringify(d.config))
  const cfg = runtime(d, order('code_scout', { provider: 'canonical', model: 'other-flash' }))
  cfg.maxTurns = 1; cfg.sessionNonce = 'canonical-fixed'; currentOrder = cfg.order
  const start = calls.length
  const result = await runWorkerSessionOop(cfg, { getMemoryBlock: () => undefined, stallMsOverride: 30000,
    entryOverride: { execArgs: ['--import', 'tsx'], script: resolve('src/agent/worker-process/child.ts') } })
  assert.equal(calls.length, start + 1, result.result.summary)
  assert.equal(calls.at(-1)?.authorization, 'Bearer fixture-fixed')
  assert.equal(calls.at(-1)?.model, 'other-flash')
  assert.equal(result.result.status, 'passed', result.result.summary)
  assert.match(result.prefixProof?.credentialScope ?? '', /^canonical:default:principal:/)
})

test('real isolated follow reconstructs a root provider whose registry key differs from its name', async () => {
  const d = deps()
  d.provider = provider('Isolated root display')
  d.config.provider.providers = { 'isolated-root-binding': d.provider }
  writeFileSync(process.env.RIVET_CONFIG_PATH!, JSON.stringify(d.config))
  const cfg = runtime(d)
  cfg.maxTurns = 1; cfg.sessionNonce = 'canonical-root'; currentOrder = cfg.order
  const start = calls.length
  const result = await runWorkerSessionOop(cfg, { getMemoryBlock: () => undefined, stallMsOverride: 30000,
    entryOverride: { execArgs: ['--import', 'tsx'], script: resolve('src/agent/worker-process/child.ts') } })
  assert.equal(calls.length, start + 1, result.result.summary)
  assert.equal(calls.at(-1)?.authorization, 'Bearer fixture-main')
  assert.equal(calls.at(-1)?.model, 'exact-main')
  assert.equal(result.result.status, 'passed', result.result.summary)
  assert.match(result.prefixProof?.credentialScope ?? '', /^isolated-root-binding:default:principal:/)
})

test('real isolated fixed key deleted after dispatch never adopts a remaining same-model key', async () => {
  const d = deps()
  d.config.provider.providers['isolated-fixed-key'] = provider('Isolated key display', { keys: [
    { id: 'remaining', apiKey: 'fixture-wrong-account', models: [{ id: 'exact-main' }] },
    { id: 'selected', apiKey: 'fixture-selected', models: [{ id: 'exact-main' }] },
  ] })
  const cfg = runtime(d, order('code_scout', { provider: 'isolated-fixed-key', model: 'exact-main', keyId: 'selected' }))
  d.config.provider.providers['isolated-fixed-key']!.keys!.pop()
  writeFileSync(process.env.RIVET_CONFIG_PATH!, JSON.stringify(d.config))
  cfg.maxTurns = 1; cfg.sessionNonce = 'deleted-fixed-key'; currentOrder = cfg.order
  const start = calls.length
  const result = await runWorkerSessionOop(cfg, { getMemoryBlock: () => undefined, stallMsOverride: 30000,
    entryOverride: { execArgs: ['--import', 'tsx'], script: resolve('src/agent/worker-process/child.ts') } })
  assert.equal(calls.length, start)
  assert.equal(result.result.failureReason, 'binding')
  assert.equal(result.result.failureStage, 'binding')
  assert.equal(result.result.status, 'blocked')
  assert.equal(result.result.terminalFailure, true)
  assert.match(result.result.summary, /model_deleted/)
})

test('real isolated worker classifies a provider removed after dispatch as a terminal binding failure', async () => {
  const d = deps()
  const cfg = runtime(d)
  const saved = structuredClone(d.config)
  delete saved.provider.providers['third-party']
  writeFileSync(process.env.RIVET_CONFIG_PATH!, JSON.stringify(saved))
  cfg.maxTurns = 1; cfg.sessionNonce = 'deleted-after-dispatch'; currentOrder = cfg.order
  const start = calls.length
  const result = await runWorkerSessionOop(cfg, { getMemoryBlock: () => undefined, stallMsOverride: 30000,
    entryOverride: { execArgs: ['--import', 'tsx'], script: resolve('src/agent/worker-process/child.ts') } })
  assert.equal(calls.length, start)
  assert.equal(result.result.failureReason, 'binding')
  assert.equal(result.result.failureStage, 'binding')
  assert.equal(result.result.status, 'blocked')
  assert.equal(result.result.terminalFailure, true)
})

for (const explicitKey of [false, true]) {
  test(`bootstrap captures canonical identity before saved provider reload (explicit key: ${explicitKey})`, async () => {
    const d = deps()
    const canonical = `bootstrap-binding-${explicitKey}`
    d.provider = provider('Display protocol', { keys: [{ id: 'selected', apiKey: 'fixture-main', models: [{ id: 'exact-main', maxTokens: 4096, contextWindow: 64000 }] }] })
    d.config.provider.providers = { [canonical]: d.provider }
    d.config.provider.default = canonical
    writeFileSync(process.env.RIVET_CONFIG_PATH!, JSON.stringify(d.config))
    const id = `bootstrap-binding-${explicitKey}`
    const persist = new SessionPersist(id, dir)
    const claimStore = persist.createClaimStore()
    const fileHistory = new FileHistory(join(dir, 'backups'), id)
    const domainKnowledgeStore = new DomainKnowledgeStore(join(dir, 'knowledge'))
    const refs: RuntimeRefs = {
      coordinator: null, fileHistory, claimStore, sessionId: id, sessionRegistry: null,
      taskLedger: null, ownershipLedger: null, verificationSnapshotManager: null, deliveryGate: null,
      meridianIndexer: null, mcpManager: null, lspManager: null, banditState: null, promptEngine: null,
      goalTrackerRef: { current: null }, reviewGateRef: { current: 'off' }, pluginHooks: [], pluginCommands: [], todoStore: new TodoStore(),
    }
    createAgentRuntime({ userInstructions: DISABLED_USER_INSTRUCTIONS, provider: d.provider, apiKey: d.apiKey, auth: undefined, config: d.config, sessionId: id, cwd: dir,
      toolRegistry: new ToolRegistry(), persist, claimStore, fileHistory, refs, domainKnowledgeStore, modelId: 'exact-main',
      ...(explicitKey ? { modelKeyId: 'selected' } : {}), session: new SessionContext() })
    const saved = structuredClone(d.config)
    saved.provider.providers[canonical]!.name = 'Renamed display protocol'
    writeFileSync(process.env.RIVET_CONFIG_PATH!, JSON.stringify(saved))
    const start = calls.length
    try {
      const run = await refs.coordinator!.delegate({ parentTurnId: id, objective: 'Inspect the canonical session binding after reloading saved configuration', kind: 'code_search', profile: 'code_scout', scope: {}, budget: { maxTurns: 1 } })
      assert.equal(calls.length, start + 1, run.results[0]?.summary)
      assert.equal(calls.at(-1)?.authorization, 'Bearer fixture-main')
      assert.equal(calls.at(-1)?.model, 'exact-main')
      assert.equal(run.results[0]?.status, 'passed', run.results[0]?.summary)
      delete saved.provider.providers[canonical]
      writeFileSync(process.env.RIVET_CONFIG_PATH!, JSON.stringify(saved))
      const removed = await refs.coordinator!.delegate({ parentTurnId: `${id}-removed`, objective: 'Inspect a different task after the actual canonical provider was removed', kind: 'code_search', profile: 'code_scout', scope: {} })
      assert.equal(calls.length, start + 1)
      assert.equal(removed.results[0]?.failureReason, 'binding')
      assert.match(removed.results[0]!.summary, /provider_deleted/)
    } finally { refs.coordinator?.shutdown() }
  })
}

test('headless root binding keeps its explicit provider registry key without a pinned key slot', async () => {
  const d = deps()
  d.provider = provider('Headless display')
  d.config.provider.providers = { 'headless-canonical': d.provider }
  const coordinator = createHeadlessCoordinator({ getUserInstructions: () => DISABLED_USER_INSTRUCTIONS, toolRegistry: registry, provider: d.provider, providerName: 'headless-canonical', currentModelId: d.currentModelId, config: d.config, apiKey: d.apiKey, cwd: dir })
  const start = calls.length
  try {
    const run = await coordinator.delegate({ parentTurnId: 'headless-canonical', objective: 'Inspect the exact provider identity of the root headless user session', kind: 'code_search', profile: 'code_scout', scope: {}, budget: { maxTurns: 1 } })
    assert.equal(calls.length, start + 1, run.results[0]?.summary)
    assert.equal(calls.at(-1)?.authorization, 'Bearer fixture-main')
    assert.equal(run.results[0]?.status, 'passed', run.results[0]?.summary)
  } finally { coordinator.shutdown() }
})

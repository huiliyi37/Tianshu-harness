import { DISABLED_USER_INSTRUCTIONS } from '../../../prompt/user-instructions.js'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createOfficialRuntimeFixture as fixture } from '../../../__tests__/helpers/official-runtime-fixture.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { accountStore } from '../../../auth/account.js'
import { providerSchema, configSchema } from '../../../config/schema.js'
import { prepareModelRuntime } from '../../../models/model-runtime.js'
import { OfficialError, type Binding } from '../../../models/official-contract.js'
import { createAgentConfig } from '../../../agent/create-agent-config.js'
import type { StreamCallbacks } from '../../../api/stream-client.js'
import { buildWorkerRuntime } from '../../worker-runtime.js'
import { workerModelPolicy } from '../../worker-model-policy.js'
import { ToolRegistry, filterToolRegistry } from '../../../tools/registry.js'
import { createReadOnlyWorkOrder } from '../../work-order.js'
const callbacks: StreamCallbacks = { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError(error) { throw error } }
const request = () => ({ model: 'fixture-model', messages: [{ role: 'user' as const, content: 'hello' }], max_tokens: 100 })


test('worker_cannot_switch_to_new_default_account: actual runtime accepts account without static key', async () => {
 const f = await fixture()
 try {
  const prepared = await prepareModelRuntime(f.input, f.deps)
  const cfg = createAgentConfig({ userInstructions: DISABLED_USER_INSTRUCTIONS, provider: prepared.provider, model: prepared.model, apiKey: '', auth: prepared.auth, cwd: f.home, sessionId: 'r3-worker', compact: f.input.config.compact, toolDefinitions: [] })
  await cfg.prepareModelSubmission!(new AbortController().signal)
  const order = createReadOnlyWorkOrder({ parentTurnId: 'turn-r3', kind: 'code_search', objective: 'inspect fixture', profile: 'code_scout', scope: { files: [], symbols: [] } } as Parameters<typeof createReadOnlyWorkOrder>[0])
  const deps = { getUserInstructions: () => DISABLED_USER_INSTRUCTIONS, config: f.input.config, cwd: f.home, provider: prepared.provider, apiKey: '', auth: prepared.auth, currentModelId: prepared.modelId, listActiveClaims: () => [], sessionMemoryBlock: () => undefined, domainKnowledgeStore: undefined, writeProfiles: [], runtimeSubmission: cfg.runtimeSubmission }
  const runtime = buildWorkerRuntime(deps, order, { model: prepared.modelId, contextWindow: 32000 } as Parameters<typeof buildWorkerRuntime>[2], new ToolRegistry())
  await runtime.client.stream(request(), callbacks)
  assert.equal(f.calls.length, 1)
  const routedConfig = configSchema.parse({ ...f.input.config, workers: { ...f.input.config.workers, profiles: { explicit: { provider: 'official', model: 'fixture-model' } }, routing: { repo_summarization: 'explicit' } } })
  const routedDeps = { ...deps, config: routedConfig }
  assert.equal(workerModelPolicy(routedConfig, order).source, 'task')
  const routed = buildWorkerRuntime(routedDeps, order, { model: prepared.modelId, contextWindow: 32000 } as Parameters<typeof buildWorkerRuntime>[2], new ToolRegistry())
  await routed.client.stream(request(), callbacks)
  const reviewConfig = configSchema.parse({ ...routedConfig, agent: { ...routedConfig.agent, review: { ...routedConfig.agent.review, profiles: { [order.profile]: { provider: 'official', model: 'fixture-model' } } } } })
  assert.equal(workerModelPolicy(reviewConfig, order).source, 'role')
  const override = buildWorkerRuntime({ ...deps, config: reviewConfig }, order, { model: prepared.modelId, contextWindow: 32000 } as Parameters<typeof buildWorkerRuntime>[2], new ToolRegistry())
  await override.client.stream(request(), callbacks)
  assert.equal(f.calls.length, 3); assert.equal(f.quoteCount, 1)
 } finally { await f.close() }
})


import { spawn, execFileSync } from 'node:child_process'
import { runWorkerSessionOop } from '../parent.js'
import { createWorkerCredentialBroker, createLazyWorkerCredentialBroker, createWorkerAuthChannel } from '../credential-broker.js'
import { originalRuntimeIdentity } from '../../../models/model-runtime.js'
import { createProviderClient } from '../../../api/factory.js'

async function workerFixture(short = false, direct = false) {
  const f = await fixture({ directAccess: direct })
  try {
    if (direct) f.binding.billingMode = 'server'
    f.catalog.models[0]!.contextWindow = 64000
    if (short) f.setCredentialLifetime(6500)
    const prepared = await prepareModelRuntime(f.input, f.deps)
    const cfg = createAgentConfig({ userInstructions: DISABLED_USER_INSTRUCTIONS, provider: prepared.provider, model: prepared.model, apiKey: '', auth: prepared.auth, cwd: f.home, sessionId: 'r3-channel', compact: f.input.config.compact, toolDefinitions: [] })
    await cfg.prepareModelSubmission!(new AbortController().signal)
    const runtime = await cfg.runtimeSubmission!.capture().resolve(f.input)
    const broker = createWorkerCredentialBroker(originalRuntimeIdentity(runtime), runtime)
    return { f, cfg, runtime, broker }
  } catch (error) {
    await f.close()
    throw error
  }
}

test('private parent broker rejects forgery and serves 20 concurrent native child requests; original source remains pinned', async () => {
  const { f, cfg, runtime, broker } = await workerFixture()
  const abort = new AbortController()
  const channel = createWorkerAuthChannel(request => { if (request.t === 'model-prepare-cancel') { broker.cancelPrepare(request.requestId); return }; void (request.t === 'model-prepare' ? broker.prepare(request) : broker.handle(request)).then(result => channel.accept(result)) }, abort.signal)
  try {
    assert.throws(() => createWorkerCredentialBroker({ ...originalRuntimeIdentity(runtime) }, runtime), /auth_required/)
    const delegated = channel.connect(broker.snapshots)
    const child = delegated.runtimes[0]!
    const client = createProviderClient(child.provider, child.capabilities, { apiKey: '', model: child.modelId, maxTokens: 100, requestAuth: child.requestAuth })
    await Promise.all(Array.from({ length: 20 }, () => client.stream(request(), callbacks)))
    assert.equal(f.calls.length, 20); assert.equal(f.quoteCount, 1)
    const snapshot = broker.snapshots[0]!
    const base = { t: 'auth-request' as const, requestId: randomUUID(), kind: 'authorize' as const, bindingId: snapshot.binding.id, modelId: snapshot.model.id, operation: snapshot.binding.operation, method: 'POST', path: snapshot.binding.path, catalogRevision: snapshot.catalogRevision }
    for (const patch of [{ path: '/evil' }, { modelId: 'other' }, { bindingId: 'other' }, { method: 'GET' }, { operation: 'embedding' }, { catalogRevision: 'other' }]) assert.ok((await broker.handle({ ...base, requestId: randomUUID(), ...patch })).error)
    const forged = { ...child.provider }
    assert.throws(() => createProviderClient(forged, child.capabilities, { apiKey: '', model: child.modelId, maxTokens: 1, requestAuth: child.requestAuth }), /auth_required/)
    const nestedOrder = createReadOnlyWorkOrder({ parentTurnId: 'nested-turn', kind: 'code_search', objective: 'nested fixture', profile: 'code_scout', scope: { files: [], symbols: [] } })
    const nested = buildWorkerRuntime({ getUserInstructions: () => DISABLED_USER_INSTRUCTIONS, config: f.input.config, cwd: f.home, provider: child.provider, apiKey: '', auth: undefined, currentModelId: child.modelId, listActiveClaims: () => [], sessionMemoryBlock: () => undefined, domainKnowledgeStore: undefined, writeProfiles: [], runtimeSubmission: delegated.submission }, nestedOrder, { model: child.modelId, contextWindow: 32000 } as Parameters<typeof buildWorkerRuntime>[2], new ToolRegistry())
    await nested.client.stream(request(), callbacks)
    assert.equal(f.calls.length, 21, 'actual nested worker factory uses the restricted channel')
    delegated.submission.settle()
    await client.stream(request(), callbacks)
    assert.equal(f.calls.length, 22, 'child settlement must not retire root or sibling')
    const retired = cfg.runtimeSubmission!.capture()
    cfg.runtimeSubmission!.settle()
    await assert.rejects(client.stream(request(), callbacks))
    await cfg.prepareModelSubmission!(new AbortController().signal)
    await assert.rejects(retired.resolve(f.input))
    assert.equal(f.calls.length, 22)
    assert.equal(f.quoteCount, 2, 'only explicit next root opens a quote')
  } finally { channel.dispose(); broker.dispose(); await f.close() }
})

for (const direct of [false, true]) test(`actual parent runner / real child process sends through parent authority without a child account${direct ? ' using direct supplier transport' : ''}`, async () => {
  const { f, cfg, broker } = await workerFixture(false, direct)
  try {
    f.writeConfig()
    const shim = join(f.home, 'wire.mjs')
    writeFileSync(shim, `const original = globalThis.fetch; globalThis.fetch = (url, init) => { const u = new URL(String(url)); if (u.origin !== ${JSON.stringify(direct ? 'https://supplier.invalid' : 'https://gateway.invalid')} || init?.redirect !== 'error') throw new Error('unexpected fixture wire'); return original(${JSON.stringify(f.endpoint)} + u.pathname, init) }`)
    const order = createReadOnlyWorkOrder({ parentTurnId: 'turn-real-child', kind: 'code_search', objective: 'return fixture report', profile: 'code_scout', scope: { files: [], symbols: [] } })
    order.budget.maxRetries = 0
    f.setResponse(res => { res.setHeader('content-type', 'text/event-stream'); const report = JSON.stringify({ workOrderId: order.id, status: 'passed', summary: 'fixture complete', findings: [], artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'skipped' }); res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: report }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n') })
    const config = buildWorkerRuntime({ getUserInstructions: () => DISABLED_USER_INSTRUCTIONS, config: f.input.config, cwd: f.home, provider: (await cfg.runtimeSubmission!.resolve(f.input)).provider, apiKey: '', auth: undefined, currentModelId: 'fixture-model', listActiveClaims: () => [], sessionMemoryBlock: () => undefined, domainKnowledgeStore: undefined, writeProfiles: [], runtimeSubmission: cfg.runtimeSubmission }, order, { model: 'fixture-model', contextWindow: 32000 } as Parameters<typeof buildWorkerRuntime>[2], new ToolRegistry())
    config.finalizeReport = false
    let initFrame = ''
    const run = await runWorkerSessionOop(config, { getMemoryBlock: () => undefined, stallMsOverride: 30000, spawnOverride: (args, script) => {
      const child = spawn(process.execPath, [...args, '--import', pathToFileURL(shim).href, script, '--worker-child'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, RIVET_IDLE_COMPACTION: '0', RIVET_RUNTIME_LEAN: '1', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*', http_proxy: '', https_proxy: '', all_proxy: '', no_proxy: '*' } })
      const write = child.stdin.write.bind(child.stdin)
      child.stdin.write = ((chunk: string, ...rest: unknown[]) => { if (String(chunk).includes('"t":"init"')) initFrame = String(chunk); return (write as (...args: unknown[]) => boolean)(chunk, ...rest) }) as typeof child.stdin.write
      return child
    } })
    assert.equal(run.officialFailure, undefined, JSON.stringify(run.result))
    assert.ok(f.calls.length >= 1, JSON.stringify(run.result))
    assert.equal(f.quoteCount, direct ? 0 : 1)
    if (direct) {
      assert.equal(f.directGrants, 1)
      assert.equal(f.calls[0]?.headers.authorization, 'Bearer sk-synthetic-direct-owned')
      assert.equal(f.calls[0]?.headers['x-tianshu-binding-id'], undefined)
    }
    assert.doesNotMatch(initFrame, /Bearer|sk-synthetic-|accessToken|refreshToken/)
    assert.ok(initFrame.includes('officialModels'))
  } finally { broker.dispose(); await f.close() }
})

test('delegated direct inference keeps supplier keys out of init and preserves supplier refusal classification', async () => {
  const { f, runtime, broker } = await workerFixture(false, true)
  const channel = createWorkerAuthChannel(message => {
    if (message.t === 'model-prepare-cancel') return
    void (message.t === 'model-prepare' ? broker.prepare(message) : broker.handle(message)).then(result => channel.accept(result))
  }, new AbortController().signal)
  try {
    assert.equal(f.directGrants, 1)
    const snapshots = broker.snapshots
    assert.ok(!JSON.stringify(snapshots).includes('sk-synthetic-direct'))
    const delegated = channel.connect(snapshots), child = delegated.runtimes[0]!
    f.setResponse(response => { response.statusCode = 402; response.end(JSON.stringify({ error: { code: 'insufficient_quota', message: 'synthetic-private-supplier-diagnostic' } })) })
    const client = createProviderClient(child.provider, child.capabilities, { apiKey: '', model: child.modelId, maxTokens: 100, requestAuth: child.requestAuth })
    await assert.rejects(client.stream(request(), callbacks), { code: 'insufficient_balance' })
    assert.equal(f.calls[0]?.headers.authorization, 'Bearer sk-synthetic-direct-owned')
    assert.equal(f.calls[0]?.headers['x-tianshu-binding-id'], undefined)
    assert.equal(f.quoteCount, 0)
    assert.equal(originalRuntimeIdentity(runtime).subject, snapshots[0]?.identity.subject)
  } finally { channel.dispose(); broker.dispose(); await f.close() }
})

test('actual parent revokes a streaming real-child direct call when only the local account logs out', { timeout: 90000 }, async () => {
  const { f, cfg, broker } = await workerFixture(false, true)
  let response: import('node:http').ServerResponse | undefined
  let run: ReturnType<typeof runWorkerSessionOop> | undefined
  let started!: () => void
  const sending = new Promise<void>(resolve => { started = resolve })
  try {
    f.writeConfig()
    const shim = join(f.home, 'direct-cancel-wire.mjs')
    writeFileSync(shim, `const original=globalThis.fetch;globalThis.fetch=(url,init)=>{const u=new URL(String(url));if(u.origin!=='https://supplier.invalid'||init?.redirect!=='error')throw Error('unexpected fixture wire');return original(${JSON.stringify(f.endpoint)}+u.pathname,init)}`)
    const order = createReadOnlyWorkOrder({ parentTurnId: 'synthetic-direct-stop', kind: 'code_search', objective: 'return fixture report', profile: 'code_scout', scope: { files: [], symbols: [] } })
    order.budget.maxRetries = 0
    f.setResponse(current => { response = current; current.setHeader('content-type', 'text/event-stream'); current.write('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n'); started() })
    const config = buildWorkerRuntime({ getUserInstructions: () => DISABLED_USER_INSTRUCTIONS, config: f.input.config, cwd: f.home, provider: (await cfg.runtimeSubmission!.resolve(f.input)).provider, apiKey: '', auth: undefined, currentModelId: 'fixture-model', listActiveClaims: () => [], sessionMemoryBlock: () => undefined, domainKnowledgeStore: undefined, writeProfiles: [], runtimeSubmission: cfg.runtimeSubmission }, order, { model: 'fixture-model', contextWindow: 32000 } as Parameters<typeof buildWorkerRuntime>[2], new ToolRegistry())
    config.finalizeReport = false
    run = runWorkerSessionOop(config, { getMemoryBlock: () => undefined, stallMsOverride: 60000, spawnOverride: (args, script) => spawn(process.execPath, [...args, '--import', pathToFileURL(shim).href, script, '--worker-child'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, RIVET_IDLE_COMPACTION: '0', RIVET_RUNTIME_LEAN: '1', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*', http_proxy: '', https_proxy: '', all_proxy: '', no_proxy: '*' } }) })
    void run.catch(() => {})
    await Promise.race([sending, run.then(() => { throw Error('child ended before logout') })])
    accountStore(f.home).clear()
    const finished = await run
    assert.notEqual(finished.result.status, 'passed')
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0]?.headers.authorization, 'Bearer sk-synthetic-direct-owned')
  } finally { response?.end(); await run?.catch(() => {}); broker.dispose(); await f.close() }
})

function byokConfig(f: Awaited<ReturnType<typeof fixture>>) {
  const byok = providerSchema.parse({ name: 'byok', baseUrl: 'https://gateway.invalid/v1', apiKey: 'synthetic-byok', models: [{ id: 'byok-model', contextWindow: 32000, maxTokens: 1000 }] })
  f.input.config.provider.providers.byok = byok
  f.input.config.provider.default = 'byok'
  f.input.config.agent.defaultModel = 'byok:byok-model'
  const cfg = createAgentConfig({ userInstructions: DISABLED_USER_INSTRUCTIONS, provider: byok, model: byok.models[0]!, apiKey: 'synthetic-byok', cwd: f.home, sessionId: 'mixed-worker', compact: f.input.config.compact, toolDefinitions: [], allProviders: f.input.config.provider.providers })
  return { byok, cfg }
}

test('lazy mixed channel has zero startup catalog; concurrent first selection and actual nested native calls share one quote', async () => {
  const f = await fixture(); const { cfg } = byokConfig(f)
  await cfg.prepareModelSubmission!(new AbortController().signal)
  const broker = createLazyWorkerCredentialBroker(cfg.runtimeSubmission!, [f.input, { ...f.input, purpose: 'report' }])
  const channel = createWorkerAuthChannel(request => { if (request.t === 'model-prepare-cancel') { broker.cancelPrepare(request.requestId); return }; void (request.t === 'model-prepare' ? broker.prepare(request) : broker.handle(request)).then(result => channel.accept(result)) }, new AbortController().signal)
  try {
    assert.equal(f.catalogCount, 0); assert.equal(f.grants, 0); assert.equal(f.quoteCount, 0)
    const delegated = channel.connect([], broker.selections)
    await delegated.submission.prepare(new AbortController().signal)
    assert.equal(f.catalogCount, 0)
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => delegated.submission.resolve({ ...f.input, purpose: i % 2 ? 'report' : 'agent' })))
    assert.equal(f.quoteCount, 1)
    const r = results[0]!
    const order = createReadOnlyWorkOrder({ parentTurnId: 'lazy-nested', kind: 'code_search', objective: 'nested', profile: 'code_scout', scope: { files: [], symbols: [] } })
    const nested = buildWorkerRuntime({ getUserInstructions: () => DISABLED_USER_INSTRUCTIONS, config: f.input.config, cwd: f.home, provider: r.provider, apiKey: '', auth: undefined, currentModelId: r.modelId, listActiveClaims: () => [], sessionMemoryBlock: () => undefined, domainKnowledgeStore: undefined, writeProfiles: [], runtimeSubmission: delegated.submission }, order, { model: r.modelId, contextWindow: 32000 } as Parameters<typeof buildWorkerRuntime>[2], new ToolRegistry())
    await nested.client.stream(request(), callbacks)
    assert.equal(f.calls.length, 1)
    const known = { t: 'model-prepare' as const, requestId: 'replay-id', selectionId: broker.selections[0]!.selectionId }
    assert.ok((await broker.prepare(known)).snapshot)
    assert.equal((await broker.prepare(known)).error, 'auth_required')
    assert.equal((await broker.prepare({ ...known, requestId: 'unknown-selection', selectionId: 'invented' })).error, 'auth_required')
    await f.replaceAccount()
    await assert.rejects(nested.client.stream(request(), callbacks))
    assert.equal(f.quoteCount, 1); assert.equal(f.calls.length, 1)
  } finally { channel.dispose(); broker.dispose(); cfg.runtimeSubmission!.settle(); await f.close() }
})

test('lazy broker rejects wrong-owner prepared provider before first quote, and missing original source cannot adopt login', async () => {
  const f = await fixture(); const { cfg } = byokConfig(f)
  try {
    await cfg.prepareModelSubmission!(new AbortController().signal)
    const broker = createLazyWorkerCredentialBroker(cfg.runtimeSubmission!, [f.input])
    await f.replaceAccount()
    const other = await prepareModelRuntime(f.input, f.deps)
    assert.equal(f.quoteCount, 0)
    await assert.rejects(cfg.runtimeSubmission!.resolve({ ...f.input, provider: other.provider, prepared: other }), /auth_required|account_changed/)
    assert.equal(f.quoteCount, 0, 'wrong-owner prepared input is rejected before either source can quote')
    assert.equal(f.calls.length, 0)
    // Runtime has a genuine B authorizer; it still cannot seed the pinned A broker.
    const otherCfg = createAgentConfig({ userInstructions: DISABLED_USER_INSTRUCTIONS, provider: other.provider, model: other.model, apiKey: '', auth: other.auth, cwd: f.home, sessionId: 'other', compact: f.input.config.compact, toolDefinitions: [] })
    await otherCfg.prepareModelSubmission!(new AbortController().signal)
    const b = await otherCfg.runtimeSubmission!.resolve(f.input)
    const quotes = f.quoteCount
    assert.throws(() => broker.add(b), /auth_required/)
    assert.ok((await broker.prepare({ t: 'model-prepare', requestId: 'old-a', selectionId: broker.selections[0]!.selectionId })).error)
    assert.equal(f.quoteCount, quotes)
    broker.dispose(); otherCfg.runtimeSubmission!.settle()
    accountStore(f.home).clearAccount()
    const missing = byokConfig(f).cfg
    await missing.prepareModelSubmission!(new AbortController().signal)
    const noSource = createLazyWorkerCredentialBroker(missing.runtimeSubmission!, [f.input])
    await f.replaceAccount()
    assert.equal((await noSource.prepare({ t: 'model-prepare', requestId: 'missing', selectionId: noSource.selections[0]!.selectionId })).error, 'auth_required')
    assert.equal(f.quoteCount, quotes); noSource.dispose()
  } finally { await f.close() }
})

test('lazy preparation expires and settles with original root; timed out/disconnected/invalid replies never install a child owner', async () => {
  const { f, cfg, broker: oldBroker } = await workerFixture()
  const broker = createLazyWorkerCredentialBroker(cfg.runtimeSubmission!, [f.input])
  try {
    f.advance(30001)
    assert.equal((await broker.prepare({ t: 'model-prepare', requestId: 'expired', selectionId: broker.selections[0]!.selectionId })).error, 'pricing_changed')
    assert.equal(f.quoteCount, 1)
    cfg.runtimeSubmission!.settle()
    assert.equal((await broker.prepare({ t: 'model-prepare', requestId: 'settled', selectionId: broker.selections[0]!.selectionId })).error, 'auth_required')
    const selection = broker.selections[0]!
    for (const variant of ['wrong-kind', 'both', 'neither', 'unknown', 'mismatch', 'disconnect', 'timeout']) {
      let sent: import('../credential-broker.js').WorkerPrepareRequest | undefined
      const channel = createWorkerAuthChannel(message => { if (message.t === 'model-prepare') sent = message }, new AbortController().signal)
      const delegated = channel.connect([], [selection])
      const result = delegated.submission.resolve(f.input)
      assert.ok(sent)
      const snapshot = oldBroker.snapshots[0]!
      if (variant === 'wrong-kind') channel.accept({ t: 'auth-result', requestId: sent.requestId })
      if (variant === 'both') channel.accept({ t: 'model-prepared', requestId: sent.requestId, snapshot, error: 'auth_required' })
      if (variant === 'neither') channel.accept({ t: 'model-prepared', requestId: sent.requestId })
      if (variant === 'unknown') channel.accept({ t: 'model-prepared', requestId: sent.requestId, error: 'fabricated' as 'auth_required' })
      if (variant === 'mismatch') channel.accept({ t: 'model-prepared', requestId: sent.requestId, snapshot: { ...snapshot, model: { ...snapshot.model, id: 'invented' } } })
      if (variant === 'disconnect') channel.dispose()
      await assert.rejects(result)
      channel.accept({ t: 'model-prepared', requestId: sent.requestId, snapshot })
      assert.equal(delegated.runtimes.length, 0, variant)
      channel.dispose()
    }
  } finally { broker.dispose(); oldBroker.dispose(); await f.close() }
})

test('actual BYOK parent/real child starts without managed requests and lazily invokes official native image', async () => {
  // Windows cold child imports can consume the default 30s quote; expiry has its own cases.
  const f = await fixture({ quoteLifetimeMs: 120000 }); const { byok, cfg } = byokConfig(f)
  try {
    const imageBinding: Binding = { ...f.binding, id: 'image-binding', modelId: 'image-model', operation: 'image-generation', stream: false, path: '/v1/images/generations' }
    f.catalog.models.push({ ...f.catalog.models[0]!, id: 'image-model', bindings: [imageBinding] })
    f.input.config.provider.providers['image-official'] = providerSchema.parse({ name: 'image-official', auth: { type: 'tianshu-account' }, models: [{ id: 'image-model', managed: { bindingId: imageBinding.id }, supportsImageGen: true }] })
    f.input.config.agent.imageGenModel = { provider: 'image-official', model: 'image-model' }
    f.input.config.agent.desktopTools = true
    f.writeConfig()
    assert.equal((await import('../../../config/image-gen-model.js')).getImageGenModelConfig()?.model, 'image-model')
    await cfg.prepareModelSubmission!(new AbortController().signal)
    const shim = join(f.home, 'mixed-wire.mjs')
    // Transport mapping only: both native fetch and the image client's undici dispatcher still run.
    writeFileSync(shim, `import dns from 'node:dns/promises'; import { syncBuiltinESMExports } from 'node:module'; import { Agent } from ${JSON.stringify(import.meta.resolve('undici'))}; const lookup = dns.lookup; dns.lookup = async (hostname, options) => hostname === 'gateway.invalid' ? options?.all ? [{ address: '8.8.8.8', family: 4 }] : { address: '8.8.8.8', family: 4 } : lookup(hostname, options); syncBuiltinESMExports(); const dispatch = Agent.prototype.dispatch; Agent.prototype.dispatch = function(options, handler) { return dispatch.call(this, { ...options, origin: ${JSON.stringify(f.endpoint)} }, handler) }; const original = globalThis.fetch; globalThis.fetch = (url, init) => { const u = new URL(String(url)); return original(${JSON.stringify(f.endpoint)} + u.pathname, init) }`)
    const order = createReadOnlyWorkOrder({ parentTurnId: 'mixed-real-child', kind: 'code_search', objective: 'generate fixture image then report', profile: 'code_scout', scope: { files: [], symbols: [] } })
    order.allowedTools = ['generate_image']; order.budget.maxRetries = 0
    let byokCalls = 0
    f.setResponse((res, call) => {
      if (call.path.includes('/images/')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+mcAAAAASUVORK5CYII=' }] })); return }
      byokCalls++
      res.setHeader('content-type', 'text/event-stream')
      if (byokCalls === 1) {
        assert.equal(f.catalogCount, 0); assert.equal(f.quoteCount, 0); assert.equal(f.grants, 0)
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'image-tool', type: 'function', function: { name: 'generate_image', arguments: JSON.stringify({ prompt: 'fixture' }) } }] }, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n'); return
      }
      const report = JSON.stringify({ workOrderId: order.id, status: 'passed', summary: 'image complete', findings: [], artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'skipped' })
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: report }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
    })
    const config = buildWorkerRuntime({ getUserInstructions: () => DISABLED_USER_INSTRUCTIONS, config: f.input.config, cwd: f.home, provider: byok, apiKey: 'synthetic-byok', auth: undefined, currentModelId: 'byok-model', listActiveClaims: () => [], sessionMemoryBlock: () => undefined, domainKnowledgeStore: undefined, writeProfiles: [], runtimeSubmission: cfg.runtimeSubmission }, order, { model: 'byok-model', contextWindow: 32000 } as Parameters<typeof buildWorkerRuntime>[2], new ToolRegistry())
    config.toolRegistry = filterToolRegistry(createDefaultToolRegistry([], { desktopTools: true }), ['generate_image'])
    config.finalizeReport = false; config.parentApprovalMode = 'dangerously-skip-permissions'
    const run = await runWorkerSessionOop(config, { getMemoryBlock: () => undefined, stallMsOverride: 30000, spawnOverride: (args, script) => spawn(process.execPath, [...args, '--import', pathToFileURL(shim).href, script, '--worker-child'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, RIVET_IDLE_COMPACTION: '0', RIVET_RUNTIME_LEAN: '1', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*', http_proxy: '', https_proxy: '', all_proxy: '', no_proxy: '*' } }) })
    assert.equal(run.officialFailure, undefined, JSON.stringify(run.result))
    assert.equal(f.calls.filter(c => c.path.includes('/images/')).length, 1, JSON.stringify({ result: run.result, transcript: run.transcript, quoteCount: f.quoteCount, catalogCount: f.catalogCount, paths: f.calls.map(c => c.path), tools: f.calls.map(call => (call.body.tools as Array<{ function: { name: string } }> | undefined)?.map(tool => tool.function.name)) }))
    assert.equal(f.quoteCount, 1); assert.equal(byokCalls, 2)
  } finally { cfg.runtimeSubmission!.settle(); await f.close() }
})

test('lazy parent timeout/disconnect fences actual delayed catalog preparation and late scope completion', async () => {
  const { f, cfg, broker: initial } = await workerFixture()
  const broker = createLazyWorkerCredentialBroker(cfg.runtimeSubmission!, [f.input])
  const originalCatalog = f.deps.getCatalog
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  f.deps.getCatalog = async (...args) => { await gate; return originalCatalog(...args) }
  try {
    const selectionId = broker.selections[0]!.selectionId
    const result = await broker.prepare({ t: 'model-prepare', requestId: 'actual-timeout', selectionId })
    assert.equal(result.error, 'service_error')
    broker.dispose(); cfg.runtimeSubmission!.settle(); release()
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(broker.snapshots.length, 0); assert.equal(f.quoteCount, 1); assert.equal(f.calls.length, 0)
    assert.equal((await broker.prepare({ t: 'model-prepare', requestId: 'after-disconnect', selectionId })).error, 'auth_required')
  } finally { release(); f.deps.getCatalog = originalCatalog; broker.dispose(); initial.dispose(); await f.close() }
})

test('20 separate worker channels share one production R1 credential refresh and retain the original quote', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const { f, cfg, broker } = await workerFixture(true)
  const channels: ReturnType<typeof createWorkerAuthChannel>[] = []
  try {
    assert.equal(f.grants, 1)
    f.setCredentialLifetime(300000)
    context.mock.timers.tick(1600)
    const clients = Array.from({ length: 20 }, () => {
      const channel = createWorkerAuthChannel(message => { if (message.t === 'model-prepare-cancel') { broker.cancelPrepare(message.requestId); return }; void (message.t === 'model-prepare' ? broker.prepare(message) : broker.handle(message)).then(reply => channel.accept(reply)) }, new AbortController().signal)
      channels.push(channel)
      const runtime = channel.connect(broker.snapshots).runtimes[0]!
      return createProviderClient(runtime.provider, runtime.capabilities, { apiKey: '', model: runtime.modelId, maxTokens: 100, requestAuth: runtime.requestAuth })
    })
    await Promise.all(clients.map(client => client.stream(request(), callbacks)))
    assert.equal(f.grants, 2, 'exactly one new actual HTTP bootstrap grant for 20 worker channels')
    assert.equal(f.quoteCount, 1); assert.equal(f.calls.length, 20)
    assert.deepEqual([...new Set(f.calls.map(call => call.headers.authorization))], ['Bearer sk-synthetic-2'])
  } finally { channels.forEach(channel => channel.dispose()); broker.dispose(); cfg.runtimeSubmission!.settle(); await f.close() }
})

import { runHandsSession } from '../../hands-session.js'
import { WorktreeCoordinator } from '../../worktree-coordinator.js'
import { createWriteWorkOrder } from '../../work-order.js'
import { completionFromClient } from '../../goal-criteria.js'
import { createHeadlessCoordinator } from '../../headless-coordinator.js'
import { createDefaultToolRegistry } from '../../../tools/default-registry.js'

test('actual hands partial report is terminal without another model request', async () => {
  const { f, cfg, broker } = await workerFixture()
  try {
    const order = createWriteWorkOrder({ parentTurnId: 'hands-refusal', kind: 'patch_proposal', profile: 'patcher', objective: 'Complete the fixture change and retain all original progress across the continuation', scope: { files: ['output.ts'] } })
    f.setResponse(res => {
      if (f.calls.length === 1) { res.setHeader('content-type', 'text/event-stream'); const report = { workOrderId: order.id, status: 'blocked', summary: 'partial fixture', findings: [], artifacts: [], changedFiles: ['output.ts'], risks: [], nextActions: [], evidenceStatus: 'unverified', failureReason: 'max_turns' }; res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(report) }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'); return }
      res.statusCode = 409; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version: 1, requestId: 'hands-refusal', error: { code: 'pricing_changed', retryable: false } }))
    })
    const complete = completionFromClient(cfg.client, 'fixture-model')
    const result = await runHandsSession({ order, cwd: f.home, wtCoordinator: new WorktreeCoordinator(f.home), sharedWorkspace: true, compact: f.input.config.compact, maxTurns: 2, contextWindow: 32000, writeGateEnabled: false, runAgent: prompt => complete('fixture report', prompt) })
    assert.equal(result.result.status, 'blocked'); assert.equal(result.result.terminalFailure, true); assert.equal(result.result.failureReason, 'max_turns')
    assert.equal(f.calls.length, 1); assert.equal(f.quoteCount, 1)
  } finally { broker.dispose(); cfg.runtimeSubmission!.settle(); await f.close() }
})

test('actual headless coordinator batch propagates native refusal and does not schedule another worker wave', async () => {
  const { f, cfg, broker, runtime } = await workerFixture()
  const coordinator = createHeadlessCoordinator({ getUserInstructions: () => DISABLED_USER_INSTRUCTIONS, toolRegistry: createDefaultToolRegistry([], { desktopTools: false }), provider: runtime.provider, providerName: runtime.providerName, currentModelId: runtime.modelId, config: f.input.config, apiKey: '', cwd: f.home, sessionId: 'batch-refusal', runtimeSubmission: cfg.runtimeSubmission })
  try {
    f.setResponse(res => { res.statusCode = 409; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version: 1, requestId: 'batch-refusal', error: { code: 'pricing_changed', retryable: false } })) })
    const requests = Array.from({ length: 5 }, (_, i) => ({ parentTurnId: `batch-${i}`, objective: 'Inspect the fixture source and report a complete evidence-based answer', kind: 'code_search' as const, profile: 'code_scout' as const, scope: { files: ['fixture.ts'] }, budget: { maxRetries: 3 } }))
    await assert.rejects(async () => { const result = await coordinator.delegateBatch(requests); assert.fail(JSON.stringify({ result, calls: f.calls.length })) }, error => error instanceof OfficialError && error.code === 'pricing_changed')
    assert.ok(f.calls.length <= 3, `only already in-flight workers may send: ${f.calls.length}`); assert.equal(f.quoteCount, 1)
  } finally { await coordinator.shutdown(); broker.dispose(); cfg.runtimeSubmission!.settle(); await f.close() }
})

import { createDelegateTaskTool } from '../../../tools/delegate-task.js'
import { createDelegateBatchTool } from '../../../tools/delegate-batch.js'
for (const mode of ['single', 'batch'] as const) test(`actual ${mode} delegate tool preserves native official refusal for its parent pipeline`, async () => {
  const { f, cfg, broker, runtime } = await workerFixture()
  const coordinator = createHeadlessCoordinator({ getUserInstructions: () => DISABLED_USER_INSTRUCTIONS, toolRegistry: createDefaultToolRegistry([], { desktopTools: false }), provider: runtime.provider, providerName: runtime.providerName, currentModelId: runtime.modelId, config: f.input.config, apiKey: '', cwd: f.home, sessionId: `tool-${mode}`, runtimeSubmission: cfg.runtimeSubmission })
  try {
    f.setResponse(res => { res.statusCode = 409; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version: 1, requestId: 'delegate-refusal', error: { code: 'pricing_changed', retryable: false } })) })
    const task = { objective: 'Inspect the actual fixture source and retain original account authority in the detailed report', profile: 'code_scout', files: ['fixture.ts'] }
    const tool = mode === 'single' ? createDelegateTaskTool(coordinator) : createDelegateBatchTool(coordinator)
    await assert.rejects(tool.execute({ cwd: f.home, toolUseId: `tool-${mode}`, input: mode === 'single' ? task : { tasks: [task] } }), /pricing_changed/)
    assert.equal(f.calls.length, 1); assert.equal(f.quoteCount, 1)
  } finally { coordinator.shutdown(); broker.dispose(); cfg.runtimeSubmission!.settle(); await f.close() }
})


for (const phase of ['first', 'continuation', 'repair'] as const) test(`actual hands ${phase} keeps native refusal or terminal partial work without retry`, async () => {
  const { f, cfg, broker } = await workerFixture()
  const wt = new WorktreeCoordinator(f.home)
  try {
    const order = createWriteWorkOrder({ parentTurnId: `hands-${phase}`, kind: 'patch_proposal', profile: 'patcher', objective: 'Complete the fixture source change while retaining previous write progress', scope: { files: ['output.ts'] } })
    let received: OfficialError | undefined
    f.setResponse(res => {
      if (phase !== 'first' && f.calls.length === 1) {
        writeFileSync(join(f.home, 'output.ts'), 'export const retained = true\n')
        res.setHeader('content-type', 'text/event-stream')
        const report = { workOrderId: order.id, status: phase === 'repair' ? 'passed' : 'blocked', summary: 'partial fixture', findings: [], artifacts: [], changedFiles: ['output.ts'], risks: [], nextActions: [], evidenceStatus: 'unverified', ...(phase === 'continuation' ? { failureReason: 'max_turns' } : {}) }
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(report) }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'); return
      }
      res.statusCode = 409; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version: 1, requestId: 'hands-callback', error: { code: 'pricing_changed', retryable: false } }))
    })
    const complete = completionFromClient(cfg.client, 'fixture-model')
    const work = runHandsSession({ order, cwd: f.home, wtCoordinator: wt, sharedWorkspace: true, compact: f.input.config.compact, maxTurns: 2, contextWindow: 32000, writeGateEnabled: phase === 'repair', evaluateWriteGate: async () => ({ outcome: 'failed', checks: [], evidence: ['fixture verification failure'], falseGreen: false, declaredFalseGreen: false }), runAgent: async (prompt, cb) => {
      try { return await complete('fixture report', prompt) } catch (error) { assert.ok(error instanceof OfficialError); received = error; cb.onError(error); return '' }
    } })
    if (phase === 'first') await assert.rejects(work, error => error === received && received?.code === 'pricing_changed')
    else {
      const result = await work
      assert.equal(result.result.status, phase === 'repair' ? 'failed' : 'blocked'); assert.equal(result.result.terminalFailure, true); assert.equal(received, undefined)
      if (phase === 'repair') assert.equal(result.writeGate?.repairCount, 0)
    }
    assert.equal(f.calls.length, 1); assert.equal(f.quoteCount, 1); assert.equal(wt.getActiveCount(), 0)
    if (phase !== 'first') assert.equal(readFileSync(join(f.home, 'output.ts'), 'utf8'), 'export const retained = true\n')
  } finally { broker.dispose(); cfg.runtimeSubmission!.settle(); await f.close() }
})


test('lazy concurrent distinct bindings share their originating boundary and the RID ledger retires at its bound', async () => {
  const f = await fixture()
  const secondBinding: Binding = { ...f.binding, id: 'binding-2', modelId: 'second-model' }
  f.catalog.models.push({ ...f.catalog.models[0]!, id: 'second-model', bindings: [secondBinding] })
  f.input.provider.models.push({ ...f.input.provider.models[0]!, id: 'second-model', managed: { bindingId: secondBinding.id } })
  f.input.config.provider.providers.official = f.input.provider
  const { cfg } = byokConfig(f)
  await cfg.prepareModelSubmission!(new AbortController().signal)
  const broker = createLazyWorkerCredentialBroker(cfg.runtimeSubmission!, [f.input, { ...f.input, modelId: 'second-model' }])
  const channel = createWorkerAuthChannel(request => { if (request.t === 'model-prepare-cancel') { broker.cancelPrepare(request.requestId); return }; void (request.t === 'model-prepare' ? broker.prepare(request) : broker.handle(request)).then(result => channel.accept(result)) }, new AbortController().signal)
  try {
    const delegated = channel.connect([], broker.selections)
    const runtimes = await Promise.all(Array.from({ length: 20 }, (_, i) => delegated.submission.resolve({ ...f.input, modelId: i % 2 ? 'second-model' : 'fixture-model' })))
    assert.equal(f.quoteCount, 1, 'first scope quote; the distinct binding quotes only at authorization')
    await Promise.all(runtimes.slice(0, 2).map(r => createProviderClient(r.provider, r.capabilities, { apiKey: '', model: r.modelId, maxTokens: 100, requestAuth: r.requestAuth }).stream({ ...request(), model: r.modelId }, callbacks)))
    assert.equal(f.calls.length, 2); assert.equal(f.quoteCount, 2); assert.deepEqual(new Set(f.calls.map(c => c.headers['x-tianshu-binding-id'])), new Set(['binding-1', 'binding-2']))
    cfg.runtimeSubmission!.settle()
    await assert.rejects(delegated.submission.resolve(f.input)); assert.equal(f.quoteCount, 2); assert.equal(f.calls.length, 2)
  } finally { channel.dispose(); broker.dispose(); cfg.runtimeSubmission!.settle(); await f.close() }
  const next = await workerFixture()
  try {
    const s = next.broker.snapshots[0]!
    const control = { t: 'auth-request' as const, requestId: '', kind: 'check' as const, bindingId: s.binding.id, modelId: s.model.id, operation: s.binding.operation, method: 'POST', path: s.binding.path, catalogRevision: s.catalogRevision }
    for (let i = 0; i < 4096; i++) assert.equal((await next.broker.handle({ ...control, requestId: `bounded-${i}` })).error, undefined)
    assert.equal((await next.broker.handle({ ...control, requestId: 'over-bound' })).error, 'auth_required')
    assert.equal((await next.broker.handle({ ...control, requestId: 'bounded-0' })).error, 'auth_required')
    assert.equal(next.f.quoteCount, 1); assert.equal(next.f.calls.length, 0)
  } finally { next.broker.dispose(); next.cfg.runtimeSubmission!.settle(); await next.f.close() }
})


import { reapOrphanHandsWorktrees } from '../../verification-snapshot-manager.js'
import { removeWorktree, cleanupStaleHandsBranches } from '../../worktree.js'
import { ArtifactStore, cleanupOldArtifactSessions } from '../../../artifact/store.js'
for (const recovery of ['durable', 'write-gate', 'fallback', 'save-failure', 'protected-failure', 'cleanup-failure', 'ignored', 'attributes'] as const) test(`actual isolated native hands refusal preserves binary partial work: ${recovery}`, async () => {
  const { f, cfg, broker } = await workerFixture(); const wt = new WorktreeCoordinator(f.home); const originalRemoveWorktree = wt.remove.bind(wt)
  const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Codex', GIT_AUTHOR_EMAIL: 'codex@local.invalid', GIT_COMMITTER_NAME: 'Codex', GIT_COMMITTER_EMAIL: 'codex@local.invalid' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let restorePath: string | undefined
  try {
    git(f.home, ['init', '-b', 'main'])
    writeFileSync(join(f.home, 'output.ts'), 'export const value = 0\n'); writeFileSync(join(f.home, 'deleted.txt'), 'delete me\n'); writeFileSync(join(f.home, '.gitignore'), 'ignored.bin\n')
    git(f.home, ['add', 'output.ts', 'deleted.txt', '.gitignore']); git(f.home, ['commit', '-m', 'fixture baseline'])
    const base = git(f.home, ['rev-parse', 'HEAD']).trim()
    const order = createWriteWorkOrder({ parentTurnId: 'recover-refusal', kind: 'patch_proposal', profile: 'patcher', objective: 'Complete the fixture change while preserving byte-exact partial work on refusal', scope: { files: ['output.ts', 'deleted.txt', 'new.txt', 'binary.bin'] } })
    const fallbackSession = `worker-recovery-${createHash('sha256').update(order.id).digest('hex').slice(0, 16)}`
    const store = new ArtifactStore(join(f.home, '.rivet', 'artifacts'), recovery === 'fallback' ? fallbackSession : 'fixture-recovery')
    if (recovery === 'protected-failure') { mkdirSync(join(f.home, '.rivet'), { recursive: true }); writeFileSync(join(f.home, '.rivet', 'worker-recovery'), 'fixture storage unavailable') }
    if (recovery === 'save-failure') store.saveDurable = async () => { throw new Error('fixture disk failure') }
    let workerPath = '', received: OfficialError | undefined
    f.setResponse(res => {
      res.statusCode = 409; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version: 1, requestId: 'recovery-refusal', error: { code: 'pricing_changed', retryable: false } }))
    })
    const complete = completionFromClient(cfg.client, 'fixture-model'), binary = Buffer.from([0, 255, 1, 128, 0, 42])
    await assert.rejects(runHandsSession({ order, cwd: f.home, wtCoordinator: wt, compact: f.input.config.compact, maxTurns: 2, contextWindow: 32000, writeGateEnabled: recovery === 'write-gate', evaluateWriteGate: async () => ({ outcome: 'failed', checks: [], evidence: ['fixture verify refusal'], falseGreen: false, declaredFalseGreen: false }), ...(recovery === 'fallback' ? {} : { artifactStore: store }), runAgent: async (prompt, _cb, cwd) => {
      workerPath = cwd
      if (recovery === 'cleanup-failure') wt.remove = async () => { throw new Error('fixture cleanup failure') }
      if (f.calls.length === 0) { writeFileSync(join(cwd, 'output.ts'), 'export const value = 1\n'); git(cwd, ['add', 'output.ts']); git(cwd, ['commit', '-m', 'fixture partial']); writeFileSync(join(cwd, 'output.ts'), 'export const value = 2\n'); unlinkSync(join(cwd, 'deleted.txt')); writeFileSync(join(cwd, 'new.txt'), 'new recovery bytes\n'); writeFileSync(join(cwd, 'binary.bin'), binary); if (recovery === 'ignored') writeFileSync(join(cwd, 'ignored.bin'), binary); if (recovery === 'attributes') writeFileSync(join(cwd, '.gitattributes'), '*.ts text eol=lf\n') }
      try { return await complete('fixture report', prompt) } catch (error) { assert.ok(error instanceof OfficialError); received = error; throw error }
    } }), error => error === received && received?.code === 'pricing_changed')
    assert.equal(f.calls.length, 1); assert.equal(f.quoteCount, 1)
    if (recovery === 'save-failure' || recovery === 'protected-failure' || recovery === 'cleanup-failure' || recovery === 'ignored' || recovery === 'attributes') {
      assert.deepEqual(JSON.parse(readFileSync(join(workerPath, '.vsw-owner.json'), 'utf8')), { sessionId: order.id, retainedForRecovery: true })
      const branch = wt.getWorktree(order.id)!.branch
      const reaped = reapOrphanHandsWorktrees({ baseCwd: f.home, isAlive: pid => pid !== process.pid, removeWorktreeDir: (base, dir) => { if (dir === workerPath) removeWorktree(base, dir) } })
      assert.ok(reaped.kept.includes(basename(workerPath)), 'actual startup reaper keeps explicitly retained work')
      cleanupStaleHandsBranches(f.home); assert.ok(git(f.home, ['rev-parse', '--verify', branch]).trim())
      assert.ok(existsSync(workerPath)); assert.deepEqual(readFileSync(join(workerPath, 'binary.bin')), binary); assert.equal(wt.getActiveCount(), 1); if (recovery === 'ignored') assert.deepEqual(readFileSync(join(workerPath, 'ignored.bin')), binary) }
    else {
      assert.equal(wt.getActiveCount(), 0); assert.equal(existsSync(workerPath), false)
      const artifactRoot = join(f.home, '.rivet', 'artifacts'), uiSession = recovery === 'fallback' ? fallbackSession : 'fixture-recovery'
      const old = new Date(Date.now() - 8 * 24 * 3600_000)
      utimesSync(join(artifactRoot, uiSession), old, old)
      const checkpointRoot = join(f.home, '.rivet', 'worker-recovery', fallbackSession)
      if (existsSync(checkpointRoot)) utimesSync(checkpointRoot, old, old)
      for (let i = 0; i < 53; i++) mkdirSync(join(artifactRoot, `cache-session-${i}`), { recursive: true })
      assert.ok(cleanupOldArtifactSessions(artifactRoot, 'current-session') >= 4)
      assert.equal(existsSync(join(artifactRoot, uiSession)), false, 'actual startup GC removed the aged UI copy')
      const restoredStore = new ArtifactStore(join(f.home, '.rivet', 'worker-recovery'), fallbackSession)
      const item = restoredStore.listByTarget(order.id)[0]; assert.ok(item)
      const snapshot = JSON.parse((await restoredStore.readRaw(item.id))!) as { baseCommit: string; patch: string; retainedWorktree: boolean; restartProtected: boolean }
      assert.equal(snapshot.restartProtected, true); assert.equal(snapshot.baseCommit, base); assert.equal(snapshot.retainedWorktree, false); assert.match(snapshot.patch, /GIT binary patch/)
      restorePath = mkdtempSync(join(tmpdir(), 'r3-recovery-apply-')); git(f.home, ['worktree', 'add', '--detach', restorePath, snapshot.baseCommit])
      const patchPath = join(f.home, 'recovery.patch'); writeFileSync(patchPath, snapshot.patch); git(restorePath, ['apply', '--binary', patchPath])
      assert.equal(readFileSync(join(restorePath, 'output.ts'), 'utf8'), 'export const value = 2\n'); assert.equal(readFileSync(join(restorePath, 'new.txt'), 'utf8'), 'new recovery bytes\n'); assert.equal(existsSync(join(restorePath, 'deleted.txt')), false); assert.deepEqual(readFileSync(join(restorePath, 'binary.bin')), binary)
    }
  } finally { if (restorePath) { git(f.home, ['worktree', 'remove', '--force', restorePath]); rmSync(restorePath, { recursive: true, force: true }) }; wt.remove = originalRemoveWorktree; await wt.cleanupAll(); broker.dispose(); cfg.runtimeSubmission!.settle(); await f.close() }
})


for (const abandoned of ['timeout-live-root', 'settled-opening'] as const) test(`Fix1 no late quote from abandoned ${abandoned}`, async () => {
  const f = await fixture(); const { cfg } = byokConfig(f)
  await cfg.prepareModelSubmission!(new AbortController().signal)
  const broker = createLazyWorkerCredentialBroker(cfg.runtimeSubmission!, [f.input])
  let release!: () => void; let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), blocked = new Promise<void>(resolve => { entered = resolve })
  // BYOK captures the production broker; hold its actual catalog HTTP response.
  f.setCatalogGate(async count => { if (count === (abandoned === 'settled-opening' ? 2 : 1)) { entered(); await gate } })
  try {
    const work = broker.prepare({ t: 'model-prepare', requestId: 'abandoned-first', selectionId: broker.selections[0]!.selectionId })
    await blocked
    if (abandoned === 'timeout-live-root') assert.equal((await work).error, 'service_error')
    else cfg.runtimeSubmission!.settle()
    release(); await work; await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(f.quoteCount, 0); assert.equal(f.calls.length, 0); assert.equal(broker.snapshots.length, 0)
  } finally { release(); broker.dispose(); cfg.runtimeSubmission!.settle(); await f.close() }
})

import { prepareRuntimeContext } from '../../../models/model-runtime.js'
import { deriveCandidateModels } from '../../candidate-models.js'
test('Fix1 probe-prepared secondary official model remains an eligible agent candidate', async () => {
  const f = await fixture()
  try {
    const binding = { ...f.binding, id: 'second-binding', modelId: 'second-model' }
    f.catalog.models.push({ ...f.catalog.models[0]!, id: 'second-model', bindings: [binding] })
    const second = providerSchema.parse({ name: 'secondary', auth: { type: 'tianshu-account' }, models: [{ id: 'second-model', managed: { bindingId: binding.id } }] })
    f.input.config.provider.providers.secondary = second
    const context = await prepareRuntimeContext(f.input, f.input.modelId, 'agent', f.deps)
    assert.deepEqual(deriveCandidateModels(context.config.provider.providers), [{ provider: 'official', model: 'fixture-model' }, { provider: 'secondary', model: 'second-model' }])
    assert.equal(f.quoteCount, 0); assert.equal(f.calls.length, 0)
  } finally { await f.close() }
})

import { resolveCandidateModels } from '../../candidate-models.js'
import { getPreparedModel, isPreparedModelEligible } from '../../../models/model-runtime.js'
for (const cancelAll of [false, true]) test(`Fix1 live preparation consumers preserve sibling=${!cancelAll}`, async () => {
  const f = await fixture(); const { cfg } = byokConfig(f)
  await cfg.prepareModelSubmission!(new AbortController().signal)
  const broker = createLazyWorkerCredentialBroker(cfg.runtimeSubmission!, [f.input])
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(r => { release = r }), blocked = new Promise<void>(r => { entered = r })
  f.setCatalogGate(async count => { if (count === 2) { entered(); await gate } })
  try {
    const selectionId = broker.selections[0]!.selectionId
    const one = broker.prepare({ t: 'model-prepare', requestId: 'consumer-one', selectionId })
    const two = broker.prepare({ t: 'model-prepare', requestId: 'consumer-two', selectionId })
    await blocked; broker.cancelPrepare('consumer-one'); if (cancelAll) broker.cancelPrepare('consumer-two')
    release(); const results = await Promise.all([one, two]); await new Promise(r => setTimeout(r, 30))
    assert.equal(results[0]!.error, 'auth_required'); assert.equal(Boolean(results[1]!.snapshot), !cancelAll)
    assert.equal(f.quoteCount, cancelAll ? 0 : 1); assert.equal(f.calls.length, 0)
    if (cancelAll) { const fresh = await broker.prepare({ t: 'model-prepare', requestId: 'fresh-live', selectionId }); assert.ok(fresh.snapshot); assert.equal(f.quoteCount, 1) }
  } finally { release(); broker.dispose(); cfg.runtimeSubmission!.settle(); await f.close() }
})

test('Fix1 mixed main and child candidate metadata cannot send or promote identical fields without runtime reply', async () => {
  const f = await fixture(); const { cfg } = byokConfig(f)
  await cfg.prepareModelSubmission!(new AbortController().signal)
  const broker = createLazyWorkerCredentialBroker(cfg.runtimeSubmission!, [f.input])
  let wrongMode = false
  const modes: string[] = []
  const channel = createWorkerAuthChannel(message => {
    if (message.t === 'model-prepare-cancel') { broker.cancelPrepare(message.requestId); return }
    if (message.t === 'model-prepare') { modes.push(message.mode ?? 'runtime'); void broker.prepare(message).then(reply => channel.accept(wrongMode ? { ...reply, mode: 'metadata' } : reply)) }
    else void broker.handle(message).then(reply => channel.accept(reply))
  }, new AbortController().signal)
  try {
    assert.deepEqual(f.readCounters(), { catalogRequests: 0, credentialGrants: 0, priceQuotes: 0, nativeRequests: 0 })
    const main = await resolveCandidateModels(f.input.config.provider.providers, cfg.runtimeSubmission)
    assert.ok(main.some(m => m.provider === 'official')); assert.equal(f.quoteCount, 0)
    const child = channel.connect([], broker.selections)
    const candidates = await resolveCandidateModels(f.input.config.provider.providers, child.submission)
    assert.ok(candidates.some(m => m.provider === 'official')); assert.equal(f.quoteCount, 0); assert.equal(broker.snapshots.length, 0)
    const metadata = await child.submission.prepareModel(f.input)
    assert.equal(isPreparedModelEligible(metadata.provider, metadata.modelId, 'agent'), true)
    assert.throws(() => getPreparedModel(metadata.provider, metadata.modelId), /auth_required/)
    assert.throws(() => child.submission.forModel(metadata.provider, metadata.modelId), /model_unavailable/)
    assert.throws(() => createProviderClient(metadata.provider, metadata.capabilities, { apiKey: '', model: metadata.modelId, maxTokens: 100 }), /auth_required/)
    wrongMode = true
    await assert.rejects(child.submission.resolve(f.input), /service_error/)
    assert.equal(child.runtimes.length, 0); assert.equal(f.calls.length, 0)
    wrongMode = false
    const runtime = await child.submission.resolve(f.input)
    await createProviderClient(runtime.provider, runtime.capabilities, { apiKey: '', model: runtime.modelId, maxTokens: 100, requestAuth: runtime.requestAuth }).stream(request(), callbacks)
    assert.equal(f.calls.length, 1); assert.equal(f.quoteCount, 1)
    assert.deepEqual(modes, ['metadata', 'metadata', 'runtime', 'runtime'])
    const pinned = cfg.runtimeSubmission!.capture(); cfg.runtimeSubmission!.settle(); await cfg.prepareModelSubmission!(new AbortController().signal)
    await assert.rejects(resolveCandidateModels(f.input.config.provider.providers, pinned), /auth_required/)
    assert.equal(f.quoteCount, 1)
  } finally { channel.dispose(); broker.dispose(); cfg.runtimeSubmission!.settle(); await f.close() }
})

test('Fix1 child abort emits cancellation and a late prepared reply cannot install authority', async () => {
  const f = await fixture(); const { cfg } = byokConfig(f)
  await cfg.prepareModelSubmission!(new AbortController().signal)
  const broker = createLazyWorkerCredentialBroker(cfg.runtimeSubmission!, [f.input])
  const sent: Array<import('../credential-broker.js').WorkerPrepareRequest | import('../credential-broker.js').WorkerPrepareCancel> = []
  const channel = createWorkerAuthChannel(message => { if (message.t !== 'auth-request') sent.push(message) }, new AbortController().signal)
  try {
    const child = channel.connect([], broker.selections), abort = new AbortController()
    const work = child.submission.resolve({ ...f.input, signal: abort.signal }); const rejected = assert.rejects(work)
    abort.abort(); await rejected
    assert.deepEqual(sent.map(s => s.t), ['model-prepare', 'model-prepare-cancel'])
    const reply = await broker.prepare(sent[0] as import('../credential-broker.js').WorkerPrepareRequest)
    channel.accept(reply); assert.equal(child.runtimes.length, 0); assert.equal(f.calls.length, 0)
  } finally { channel.dispose(); broker.dispose(); cfg.runtimeSubmission!.settle(); await f.close() }
})

for (const event of ['child-abort', 'logout', 'root-retire'] as const) test(`Fix1 actual main and nested native 429 wait fences ${event}`, async () => {
  const { f, cfg, runtime, broker } = await workerFixture()
  let checks = 0, waiting!: () => void
  const bothWaiting = new Promise<void>(r => { waiting = r })
  const channel = createWorkerAuthChannel(message => { if (message.t === 'model-prepare-cancel') { broker.cancelPrepare(message.requestId); return }; if (message.t === 'auth-request' && message.kind === 'check') checks++; void (message.t === 'model-prepare' ? broker.prepare(message) : broker.handle(message)).then(reply => channel.accept(reply)) }, new AbortController().signal)
  const childAbort = new AbortController()
  try {
    f.setResponse(res => {
      if (f.calls.length <= 2) { res.statusCode = 429; res.setHeader('content-type', 'application/json'); res.setHeader('retry-after', '1'); res.end(JSON.stringify({ version: 1, requestId: 'native-wait', error: { code: 'rate_limited', retryable: true, retryAfterSeconds: 1, scope: 'account' } })); if (f.calls.length === 2) waiting() }
      else { res.setHeader('content-type', 'text/event-stream'); res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n') }
    })
    const delegated = channel.connect(broker.snapshots), child = delegated.runtimes[0]!
    const order = createReadOnlyWorkOrder({ parentTurnId: 'retry-nested', kind: 'code_search', objective: 'native wait', profile: 'code_scout', scope: { files: [], symbols: [] } })
    const nested = buildWorkerRuntime({ getUserInstructions: () => DISABLED_USER_INSTRUCTIONS, config: f.input.config, cwd: f.home, provider: child.provider, apiKey: '', auth: undefined, currentModelId: child.modelId, listActiveClaims: () => [], sessionMemoryBlock: () => undefined, domainKnowledgeStore: undefined, writeProfiles: [], runtimeSubmission: delegated.submission }, order, { model: child.modelId, contextWindow: 32000 } as Parameters<typeof buildWorkerRuntime>[2], new ToolRegistry())
    const main = createProviderClient(runtime.provider, runtime.capabilities, { apiKey: '', model: runtime.modelId, maxTokens: 100, requestAuth: runtime.requestAuth })
    const done = Promise.allSettled([main.stream(request(), callbacks), nested.client.stream(request(), callbacks, childAbort.signal)])
    await bothWaiting; await new Promise(r => setTimeout(r, 300)); const before = f.readCounters(); assert.equal(before.nativeRequests, 2); assert.equal(checks, 2, 'single-attempt workers must not enter the retry wait')
    if (event === 'child-abort') childAbort.abort(); else if (event === 'logout') await f.replaceAccount(); else cfg.runtimeSubmission!.settle()
    const outcomes = await done
    assert.equal(outcomes[1]!.status, 'rejected'); assert.equal(outcomes[0]!.status, event === 'child-abort' ? 'fulfilled' : 'rejected')
    assert.equal(f.calls.length, event === 'child-abort' ? 3 : 2); assert.equal(f.quoteCount, 1); assert.equal(f.grants, before.credentialGrants)
  } finally { childAbort.abort(); channel.dispose(); broker.dispose(); cfg.runtimeSubmission!.settle(); await f.close() }
})

import { createGalaxyTool } from '../../../tools/galaxy.js'
import { DelegationCoordinator } from '../../coordinator.js'
test('Fix1 actual Galaxy captures invocation A before coordinator changes to B', async () => {
  const f = await fixture(); const { cfg } = byokConfig(f)
  await cfg.prepareModelSubmission!(new AbortController().signal)
  const coordinator = new DelegationCoordinator({ providers: f.input.config.provider.providers, runtimeSubmission: cfg.runtimeSubmission, baseToolRegistry: new ToolRegistry(), modelCards: [], maxWorkers: 1, runtimeFactory: () => { throw new Error('unexpected dispatch') } })
  let inspected = false, dispatched = false
  const tool = createGalaxyTool({
    getRuntimeSnapshot: () => { inspected = true; cfg.runtimeSubmission!.settle(); void cfg.prepareModelSubmission!(new AbortController().signal); return { activeWorkers: 0, maxWorkers: 1, pendingWorkers: 0, stalledWorkers: 0, inFlightFileScopes: 0, backgroundRunning: 0, activeClaims: 0, providerDegradation: 0, shuttingDown: false } },
    resolveCandidateModels: (signal, pinned) => coordinator.resolveCandidateModels(signal, pinned),
    delegateBatch: async () => { dispatched = true; return { status: 'completed', results: [], packet: '' } },
  })
  try {
    await assert.rejects(tool.execute({ toolUseId: 'galaxy-pinned', cwd: f.home, modelSubmission: cfg.runtimeSubmission, input: { objective: 'Compare evidence', dimensions: [{ name: 'verify', objective: 'Inspect the same evidence', authority: 'yaoguang', parallelism: 'data', replicas: 2 }, { name: 'research', objective: 'Inspect independent evidence', authority: 'tianxuan' }], autoReview: false, confirm: true } }), /auth_required/)
    assert.equal(inspected, true); assert.equal(dispatched, false); assert.equal(f.catalogCount, 0); assert.equal(f.quoteCount, 0); assert.equal(f.calls.length, 0)
  } finally { cfg.runtimeSubmission!.settle(); await f.close() }
})

for (const changed of ['missing', 'logout', 'settled', 'expired'] as const) test(`Fix1 original source rejects lazy candidate metadata after ${changed}`, async () => {
  const f = await fixture()
  let cfg: ReturnType<typeof createAgentConfig> | undefined
  let broker: ReturnType<typeof createLazyWorkerCredentialBroker> | undefined
  let channel: ReturnType<typeof createWorkerAuthChannel> | undefined
  try {
    if (changed === 'missing') accountStore(f.home).clearAccount()
    if (changed === 'expired') {
      const p = await prepareModelRuntime(f.input, f.deps)
      cfg = createAgentConfig({ userInstructions: DISABLED_USER_INSTRUCTIONS, provider: p.provider, model: p.model, apiKey: '', auth: p.auth, cwd: f.home, sessionId: 'metadata-expiry', compact: f.input.config.compact, toolDefinitions: [] })
    } else cfg = byokConfig(f).cfg
    await cfg.prepareModelSubmission!(new AbortController().signal)
    broker = createLazyWorkerCredentialBroker(cfg.runtimeSubmission!, [f.input])
    channel = createWorkerAuthChannel(message => { if (message.t === 'model-prepare-cancel') { broker!.cancelPrepare(message.requestId); return }; void (message.t === 'model-prepare' ? broker!.prepare(message) : broker!.handle(message)).then(reply => channel!.accept(reply)) }, new AbortController().signal)
    const child = channel.connect([], broker.selections)
    const before = f.readCounters()
    if (changed === 'missing' || changed === 'logout') await f.replaceAccount()
    else if (changed === 'settled') { cfg.runtimeSubmission!.settle(); await cfg.prepareModelSubmission!(new AbortController().signal) }
    else f.advance(30001)
    await assert.rejects(resolveCandidateModels(f.input.config.provider.providers, child.submission), /auth_required|account_changed|pricing_changed/)
    assert.equal(f.quoteCount, before.priceQuotes); assert.equal(f.grants, before.credentialGrants); assert.equal(f.calls.length, 0); assert.equal(child.runtimes.length, 0)
  } finally { channel?.dispose(); broker?.dispose(); cfg?.runtimeSubmission!.settle(); await f.close() }
})

test('Fix1 real BYOK child Galaxy discovers metadata then routes official native replica', async () => {
  const f = await fixture({ quoteLifetimeMs: 120000 }); const { byok, cfg } = byokConfig(f)
  try {
    f.input.config.agent.desktopTools = true
    f.input.config.workers.defaultStrategy = 'auto'
    f.writeConfig()
    await cfg.prepareModelSubmission!(new AbortController().signal)
    const shim = join(f.home, 'mixed-wire.mjs')
    // Transport mapping only: both native fetch and the image client's undici dispatcher still run.
    writeFileSync(shim, `import { Agent, setGlobalDispatcher } from ${JSON.stringify(import.meta.resolve('undici'))}; const agent = new Agent(); setGlobalDispatcher({ dispatch(options, handler) { return agent.dispatch({ ...options, origin: ${JSON.stringify(f.endpoint)} }, handler) }, close: (...args) => agent.close(...args), destroy: (...args) => agent.destroy(...args) }); const original = globalThis.fetch; globalThis.fetch = (url, init) => { const u = new URL(String(url)); return original(${JSON.stringify(f.endpoint)} + u.pathname, init) }`)
    const order = createReadOnlyWorkOrder({ parentTurnId: 'mixed-real-child', kind: 'code_search', objective: 'compare independent fixture evidence then report', profile: 'code_scout', scope: { files: [], symbols: [] } })
    order.allowedTools = ['galaxy']; order.budget.maxRetries = 0
    let byokCalls = 0, childFrames = ''
    f.setResponse((res, call) => {
      if (call.body.model === 'fixture-model') { res.setHeader('content-type', 'text/event-stream'); res.end('data: {"choices":[{"delta":{"content":"Independent fixture evidence verified."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); return }
      byokCalls++
      res.setHeader('content-type', 'text/event-stream')
      if (byokCalls === 1) {
        assert.equal(f.catalogCount, 0); assert.equal(f.quoteCount, 0); assert.equal(f.grants, 0)
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'image-tool', type: 'function', function: { name: 'galaxy', arguments: JSON.stringify({ objective: 'Compare independent fixture evidence', dimensions: [{ name: 'verify', objective: 'Inspect fixture', authority: 'yaoguang', parallelism: 'data', replicas: 2 }, { name: 'research', objective: 'Inspect independent evidence', authority: 'tianxuan' }], autoReview: false, confirm: true }) } }] }, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n'); return
      }
      const report = JSON.stringify({ workOrderId: order.id, status: 'passed', summary: 'image complete', findings: [], artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'skipped' })
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: report }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
    })
    const config = buildWorkerRuntime({ getUserInstructions: () => DISABLED_USER_INSTRUCTIONS, config: f.input.config, cwd: f.home, provider: byok, apiKey: 'synthetic-byok', auth: undefined, currentModelId: 'byok-model', listActiveClaims: () => [], sessionMemoryBlock: () => undefined, domainKnowledgeStore: undefined, writeProfiles: [], runtimeSubmission: cfg.runtimeSubmission }, order, { model: 'byok-model', contextWindow: 32000 } as Parameters<typeof buildWorkerRuntime>[2], new ToolRegistry())
    const declared = new ToolRegistry()
    declared.register(createGalaxyTool({ delegateBatch: async () => { throw new Error('Parent fixture registry must not execute nested work') } }))
    config.toolRegistry = filterToolRegistry(declared, ['galaxy'])
    config.finalizeReport = false; config.parentApprovalMode = 'dangerously-skip-permissions'
    const run = await runWorkerSessionOop(config, { entryOverride: { execArgs: ['--import', 'tsx'], script: fileURLToPath(new URL('../child.ts', import.meta.url)) }, getMemoryBlock: () => undefined, stallMsOverride: 30000, spawnOverride: (args, script) => { const child = spawn(process.execPath, [...args, '--import', pathToFileURL(shim).href, script, '--worker-child'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, RIVET_IDLE_COMPACTION: '0', RIVET_RUNTIME_LEAN: '1', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*', http_proxy: '', https_proxy: '', all_proxy: '', no_proxy: '*' } }); child.stdout.on('data', chunk => { childFrames += String(chunk) }); return child } })
    assert.equal(run.officialFailure, undefined, JSON.stringify(run.result))
    assert.ok(f.calls.some(c => c.body.model === 'fixture-model'), JSON.stringify({ result: run.result, transcript: run.transcript, frames: childFrames, paths: f.calls.map(c => c.body.model) }))
    assert.equal(f.quoteCount, 1); assert.ok(byokCalls >= 2)
    assert.match(childFrames, /"mode":"metadata"/); assert.match(childFrames, /"mode":"runtime"/)

  } finally { cfg.runtimeSubmission!.settle(); await f.close() }
})

test('Fix1 metadata and runtime share pending and retired request budgets', async () => {
  const f = await fixture(); const { cfg } = byokConfig(f)
  await cfg.prepareModelSubmission!(new AbortController().signal)
  assert.throws(() => createLazyWorkerCredentialBroker(cfg.runtimeSubmission!, Array.from({ length: 257 }, () => f.input)), /model_unavailable/)
  const broker = createLazyWorkerCredentialBroker(cfg.runtimeSubmission!, [f.input])
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  f.setCatalogGate(() => gate)
  try {
    const selectionId = broker.selections[0]!.selectionId
    const works = Array.from({ length: 64 }, (_, i) => broker.prepare({ t: 'model-prepare', requestId: `budget-${i}`, selectionId, mode: i % 2 ? 'runtime' : 'metadata' }))
    assert.equal((await broker.prepare({ t: 'model-prepare', requestId: 'over-pending', selectionId, mode: 'metadata' })).error, 'auth_required')
    for (let i = 0; i < 64; i++) broker.cancelPrepare(`budget-${i}`)
    release(); assert.ok((await Promise.all(works)).every(result => result.error === 'auth_required'))
    assert.equal((await broker.prepare({ t: 'model-prepare', requestId: 'budget-0', selectionId, mode: 'metadata' })).error, 'auth_required')
    for (let i = 64; i < 4096; i++) {
      // A valid selection whose original root is retired fails before HTTP,
      // while still consuming the shared anti-replay history in either mode.
      cfg.runtimeSubmission!.settle()
      assert.ok((await broker.prepare({ t: 'model-prepare', requestId: `budget-${i}`, selectionId, mode: i % 2 ? 'metadata' : 'runtime' })).error)
    }
    await cfg.prepareModelSubmission!(new AbortController().signal)
    assert.equal((await broker.prepare({ t: 'model-prepare', requestId: 'after-4096', selectionId })).error, 'auth_required')
    assert.equal(f.quoteCount, 0); assert.equal(f.calls.length, 0)
  } finally { release(); broker.dispose(); cfg.runtimeSubmission!.settle(); await f.close() }
})

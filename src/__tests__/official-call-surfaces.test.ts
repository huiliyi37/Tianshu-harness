import { createOfficialRuntimeFixture as fixture } from './helpers/official-runtime-fixture.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountStore } from '../auth/account.js'
import { providerSchema, configSchema } from '../config/schema.js'
import { prepareModelRuntime } from '../models/model-runtime.js'
import { type Binding } from '../models/official-contract.js'
import { createAgentConfig as createRuntimeAgentConfig, type AgentConfigInput } from '../agent/create-agent-config.js'
import { DISABLED_USER_INSTRUCTIONS } from '../prompt/user-instructions.js'
import type { StreamCallbacks } from '../api/stream-client.js'
import { createGenerateImageTool } from '../tools/generate-image.js'
import { generateImage } from '../api/image-gen-client.js'
import { routeEarlyCli } from '../cli/early-routing.js'
const callbacks: StreamCallbacks = { onTextDelta() {}, onThinkingDelta() {}, onContentBlock() {}, onStopReason() {}, onError(error) { throw error } }
const request = () => ({ model: 'fixture-model', messages: [{ role: 'user' as const, content: 'hello' }], max_tokens: 100 })

function createAgentConfig(input: Omit<AgentConfigInput, 'userInstructions'>) {
  return createRuntimeAgentConfig({ ...input, userInstructions: DISABLED_USER_INSTRUCTIONS })
}


test('actual CLI dispatch recognizes account status without starting a browser', async () => {
  const home = mkdtempSync(join(tmpdir(), 'r3-cli-')); const old = process.env.RIVET_HOME; process.env.RIVET_HOME = home
  writeFileSync(join(home, 'config.json'), '{}')
  try {
    let output = '', code = 0
    const handled = await routeEarlyCli(['account', 'status'], { io: { stdout: s => { output += s }, stderr: s => { output += s }, exit: c => { code = c } } })
    assert.equal(handled, true); assert.match(output, /login|登录/); assert.equal(code, 0)
  } finally { if (old === undefined) delete process.env.RIVET_HOME; else process.env.RIVET_HOME = old; rmSync(home, { recursive: true, force: true }) }
})

for (const change of ['logout', 'expiry'] as const) test(`actual image tool retains originating agent scope: ${change}`, async () => {
  const f = await fixture()
  try {
    const imageBinding: Binding = { ...f.binding, id: 'image-binding', modelId: 'image-model', operation: 'image-generation', stream: false, path: '/v1/images/generations' }
    f.catalog.models.push({ ...f.catalog.models[0]!, id: 'image-model', bindings: [imageBinding] })
    const imageProvider = providerSchema.parse({ name: 'image-official', auth: { type: 'tianshu-account' }, models: [{ id: 'image-model', managed: { bindingId: 'image-binding' }, supportsImageGen: true }] })
    f.input.config.provider.providers['image-official'] = imageProvider
    f.input.config.agent.imageGenModel = { provider: 'image-official', model: 'image-model' }
    const prepared = await prepareModelRuntime(f.input, f.deps)
    const cfg = createAgentConfig({ provider: prepared.provider, model: prepared.model, apiKey: '', auth: prepared.auth, cwd: f.home, sessionId: 'r3-image', compact: f.input.config.compact, toolDefinitions: [], allProviders: f.input.config.provider.providers })
    await cfg.prepareModelSubmission!(new AbortController().signal)
    if (change === 'logout') await f.replaceAccount(); else f.advance(30001)
    f.setResponse(res => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+mcAAAAASUVORK5CYII=' }] })) })
    const tool = createGenerateImageTool({ loadConfig: () => f.input.config, getConfig: () => f.input.config.agent.imageGenModel, generateImage: options => generateImage({ ...options, fetchImpl: f.fetchImpl, lookupImpl: async () => ({ address: "93.184.216.34", family: 4 }) }), cwd: f.home })
    await assert.rejects(tool.execute({ input: { prompt: 'fixture' }, toolUseId: 'scope-test', cwd: f.home, modelSubmission: (cfg as typeof cfg & { runtimeSubmission?: unknown }).runtimeSubmission } as Parameters<typeof tool.execute>[0]), /account_changed|auth_required|pricing_changed/)
    assert.equal(f.calls.length, 0, 'retired source or expired original quote must send zero image requests')
    assert.equal(f.quoteCount, 1, 'an auxiliary cannot renew the original submission')
  } finally { await f.close() }
})

import { AgentLoop } from '../agent/loop.js'
import { SessionContext } from '../agent/context.js'
import { ToolRegistry } from '../tools/registry.js'
import { buildCheapClient, completionFromClient } from '../agent/goal-criteria.js'
import { buildTitleCompletion } from '../server/session-title.js'
import { completeSkillDraft } from '../skills/skill-draft-model.js'
import { generateGreetingLlm } from '../api/greeting.js'
import { probeProvider } from '../api/provider-probe.js'
import { RuntimeSessionManager, type ManagedAgent } from '../server/session-manager.js'
import { SessionRuntimePool } from '../server/session-runtime-pool.js'
import { TaskRegistry } from '../server/task-registry.js'
import { JsonTaskStore } from '../server/task-store.js'
import { CronScheduler, createScheduledTask } from '../server/cron-scheduler.js'
import { CronWiring } from '../server/cron-wiring.js'
import type { AgentCallbacks } from '../agent/loop-types.js'
const agentCallbacks = (): AgentCallbacks => ({ onTextDelta() {}, onThinkingDelta() {}, onToolUse() {}, onToolResult() {}, onTurnComplete() {}, onError() {}, onAbort() {}, onApprovalRequired: async () => true })
function endText(res: import('node:http').ServerResponse, text: string) { res.setHeader('content-type', 'text/event-stream'); res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n') }
function endTool(res: import('node:http').ServerResponse, id: string, name: string, args: object) { res.setHeader('content-type', 'text/event-stream'); res.end('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n') }

for (const scenario of ['valid', 'logout', 'expiry'] as const) test(`actual AgentLoop tool pipeline and native image: ${scenario}`, async () => {
  const f = await fixture(); let agent: AgentLoop | undefined
  try {
    const imageBinding: Binding = { ...f.binding, id: 'image-binding', modelId: 'image-model', operation: 'image-generation', stream: false, path: '/v1/images/generations' }
    f.catalog.models.push({ ...f.catalog.models[0]!, id: 'image-model', bindings: [imageBinding] })
    f.input.config.provider.providers['image-official'] = providerSchema.parse({ name: 'image-official', auth: { type: 'tianshu-account' }, models: [{ id: 'image-model', managed: { bindingId: imageBinding.id }, supportsImageGen: true }] })
    f.input.config.agent.imageGenModel = { provider: 'image-official', model: 'image-model' }
    const prepared = await prepareModelRuntime(f.input, f.deps)
    const registry = new ToolRegistry(); registry.register(createGenerateImageTool({ loadConfig: () => f.input.config, getConfig: () => f.input.config.agent.imageGenModel, generateImage: options => generateImage({ ...options, fetchImpl: f.fetchImpl, lookupImpl: async () => ({ address: "93.184.216.34", family: 4 }) }), cwd: f.home }))
    const cfg = createAgentConfig({ provider: prepared.provider, model: prepared.model, apiKey: '', auth: prepared.auth, cwd: f.home, sessionId: `r3-agent-image-${scenario}`, compact: f.input.config.compact, toolDefinitions: registry.getDefinitions(), allProviders: f.input.config.provider.providers, runtimeLean: true })
    agent = new AgentLoop({ ...cfg, toolRegistry: registry, maxTurns: 3, approvalMode: 'dangerously-skip-permissions' }, new SessionContext(), f.home)
    let first = true
    f.setResponse((res, call) => {
      if (call.path.includes('/images/')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+mcAAAAASUVORK5CYII=' }] })); return }
      if (first) { first = false; void (async () => { if (scenario === 'logout') await f.replaceAccount(); if (scenario === 'expiry') f.advance(30001); endTool(res, 'image-call', 'generate_image', { prompt: 'fixture' }) })(); return }
      endText(res, 'done')
    })
    const errors: string[] = []
    await agent.run('Generate the fixture image.', { ...agentCallbacks(), onError: error => { errors.push(error.stack ?? error.message) } })
    const images = f.calls.filter(c => c.path.includes('/images/'))
    assert.equal(images.length, scenario === 'valid' ? 1 : 0, JSON.stringify({ paths: f.calls.map(c => c.path), messages: agent.session.getMessages(), errors }))
    assert.equal(f.quoteCount, scenario === 'valid' ? 2 : 1)
    await assert.rejects(cfg.runtimeSubmission!.capture().resolve(f.input), /auth_required/)
  } finally { await agent?.cancelIdleCompaction(); await agent?.drainPersistWrites(); await f.close() }
})

test('actual headless AgentLoop two tool rounds retain one quote and close at settlement', async () => {
  const f = await fixture(); let agent: AgentLoop | undefined
  try {
    const prepared = await prepareModelRuntime(f.input, f.deps)
    const registry = new ToolRegistry(); let tools = 0
    registry.register({ isEnabled: () => true, isConcurrencySafe: () => true, requiresApproval: () => false, definition: { name: 'fixture_read', description: 'Read fixture', input_schema: { type: 'object', properties: {} } }, execute: async () => { tools++; return { content: 'fixture result' } } })
    const cfg = createAgentConfig({ provider: prepared.provider, model: prepared.model, apiKey: '', auth: prepared.auth, cwd: f.home, sessionId: 'r3-two-rounds', compact: f.input.config.compact, toolDefinitions: registry.getDefinitions(), runtimeLean: true })
    agent = new AgentLoop({ ...cfg, toolRegistry: registry, maxTurns: 4, approvalMode: 'dangerously-skip-permissions' }, new SessionContext(), f.home)
    f.setResponse(res => { if (f.calls.length <= 2) endTool(res, `tool-${f.calls.length}`, 'fixture_read', {}); else endText(res, 'complete') })
    await agent.run('Read fixture twice.', agentCallbacks())
    assert.equal(tools, 2, JSON.stringify(agent.session.getMessages())); assert.equal(f.calls.length, 3); assert.equal(f.quoteCount, 1)
    assert.equal(new Set(f.calls.map(c => c.headers['x-tianshu-quote-id'])).size, 1)
    assert.equal((f.calls[2]!.body.messages as Array<{ role: string }>).filter(m => m.role === 'tool').length, 2)
    await assert.rejects(cfg.client.stream(request(), callbacks))
    assert.equal(f.calls.length, 3)
  } finally { await agent?.cancelIdleCompaction(); await agent?.drainPersistWrites(); await f.close() }
})

test('actual title judge greeting skill and probe constructors reach their trusted native binding', async () => {
  const f = await fixture()
  try {
    f.input.config.agent.defaultModel = 'official:fixture-model'
    f.writeConfig()
    const prepared = await prepareModelRuntime(f.input, f.deps)
    const cfg = createAgentConfig({ provider: prepared.provider, model: prepared.model, apiKey: '', auth: prepared.auth, cwd: f.home, sessionId: 'r3-aux', compact: f.input.config.compact, toolDefinitions: [] })
    await cfg.prepareModelSubmission!(new AbortController().signal)
    const title = buildTitleCompletion('official:fixture-model', f.input.config.provider.providers, 'title', { submission: cfg.runtimeSubmission })!
    assert.equal(await title('title', 'fixture'), 'ok')
    const judge = buildCheapClient({ provider: 'official', model: 'fixture-model' }, f.input.config.provider.providers, 'judge', cfg.runtimeSubmission)!
    assert.equal(await completionFromClient(judge.client, judge.model)('judge', 'fixture'), 'ok')
    assert.equal(f.quoteCount, 1)
    assert.equal(await generateGreetingLlm('', '', 'fixture-model', 10, 'zh-CN', { official: { ...f.input, auth: prepared.auth } }), 'ok')
    assert.equal(await completeSkillDraft('draft', 'fixture'), 'ok')
    const probe = await probeProvider({ providerName: 'official', baseUrl: f.input.provider.baseUrl, probeModel: 'fixture-model' })
    assert.equal(probe.completionOk, true, JSON.stringify(probe))
    const vision = await probeProvider({ providerName: 'official', baseUrl: f.input.provider.baseUrl, probeModel: 'fixture-model', vision: true })
    assert.equal(vision.completionOk, true, JSON.stringify(vision))
    assert.match(JSON.stringify(f.calls.at(-1)!.body), /image_url/)
    assert.equal(f.calls.length, 6)
    assert.ok(f.calls.every(c => c.path === f.binding.path && c.headers['x-tianshu-binding-id'] === f.binding.id))
  } finally { await f.close() }
})

test('actual muted automation manager/pool/registry pauses schedule on typed native refusal and restores paused', async () => {
  const f = await fixture(); let manager: RuntimeSessionManager | undefined; let registry: TaskRegistry | undefined; let wiring: CronWiring | undefined; const agents: AgentLoop[] = []
  try {
    const prepared = await prepareModelRuntime(f.input, f.deps)
    f.setResponse(res => { res.statusCode = 402; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version: 1, requestId: 'fixture-refusal', error: { code: 'insufficient_balance', retryable: false } })) })
    manager = new RuntimeSessionManager({ defaultCwd: f.home, idleAgentTtlMs: 0, createAgent: (_cwd, id) => {
      const cfg = createAgentConfig({ provider: prepared.provider, model: prepared.model, apiKey: '', auth: prepared.auth, cwd: f.home, sessionId: typeof id === 'string' ? id : randomUUID(), compact: f.input.config.compact, toolDefinitions: [], runtimeLean: true })
      const agent = new AgentLoop({ ...cfg, toolRegistry: new ToolRegistry(), maxTurns: 2 }, new SessionContext(), f.home); agents.push(agent)
      return { run: (prompt, cb) => agent.run(prompt, cb).then(() => {}), abort: () => agent.abort(), listArtifacts: () => [], readArtifact: async () => null, getMessages: () => agent.session.getMessages(), replaceMessages() {}, rewindToMessages() {} } as ManagedAgent
    } })
    registry = new TaskRegistry({ taskStore: new JsonTaskStore(join(f.home, 'tasks')), runtimePool: new SessionRuntimePool({ manager, defaultCwd: f.home }), notifyPolicy: 'silent' })
    const path = join(f.home, 'schedule.json'), scheduler = new CronScheduler({ schedulePath: path })
    wiring = new CronWiring({ scheduler, registry })
    const schedule = createScheduledTask('fixture automation', { type: 'interval', spec: '3600000' }); scheduler.add(schedule)
    const task = await registry.createTask({ prompt: 'fixture', source: 'cron', callerId: 'test', scheduledTaskId: schedule.id, retry: { maxAttempts: 3, backoffMs: 1 } })
    let record = await registry.getTask(task.id)
    for (let i = 0; i < 200 && record?.status !== 'failed'; i++) { await new Promise(resolve => setTimeout(resolve, 20)); record = await registry.getTask(task.id) }
    assert.equal(record?.officialFailure, 'insufficient_balance'); assert.ok(record?.sessionId)
    assert.equal(f.calls.length, 1); assert.equal((await registry.listTasks()).length, 1)
    assert.equal(scheduler.get(schedule.id)?.status, 'paused')
    const restored = new CronScheduler({ schedulePath: path }); restored.load(); assert.equal(restored.get(schedule.id)?.status, 'paused'); restored.stop()
  } finally { wiring?.dispose(); registry?.dispose(); await manager?.shutdownAll(); for (const agent of agents) { await agent.cancelIdleCompaction(); await agent.drainPersistWrites() }; await f.close() }
})

test('mixed BYOK root remains operational without login; concurrent first managed consumers share original boundary', async () => {
  const f = await fixture()
  try {
    const byok = providerSchema.parse({ name: 'byok', baseUrl: 'https://byok.invalid/v1', apiKey: 'synthetic-byok', models: [{ id: 'byok-model', contextWindow: 32000, maxTokens: 100 }] })
    const cfg = createAgentConfig({ provider: byok, model: byok.models[0]!, apiKey: 'synthetic-byok', cwd: f.home, sessionId: 'mixed', compact: f.input.config.compact, toolDefinitions: [], allProviders: { ...f.input.config.provider.providers, byok } })
    await cfg.prepareModelSubmission!(new AbortController().signal)
    assert.equal(f.quoteCount, 0)
    const pinned = cfg.runtimeSubmission!.capture()
    const runtimes = await Promise.all(Array.from({ length: 20 }, () => pinned.resolve(f.input)))
    assert.equal(f.quoteCount, 1)
    await Promise.all(runtimes.map(r => createProviderClientForTest(r).stream(request(), callbacks)))
    assert.equal(f.calls.length, 20)
    cfg.runtimeSubmission!.settle()
    await cfg.prepareModelSubmission!(new AbortController().signal)
    await assert.rejects(pinned.resolve(f.input))
    assert.equal(f.quoteCount, 1)
    accountStore(f.home).clearAccount()
    const missing = createAgentConfig({ provider: byok, model: byok.models[0]!, apiKey: 'synthetic-byok', cwd: f.home, sessionId: 'missing', compact: f.input.config.compact, toolDefinitions: [], allProviders: f.input.config.provider.providers })
    await missing.prepareModelSubmission!(new AbortController().signal)
    await f.replaceAccount()
    await assert.rejects(missing.runtimeSubmission!.resolve(f.input), /auth_required/)
    assert.equal(f.quoteCount, 1)
  } finally { await f.close() }
})
import { createProviderClient as nativeClient } from '../api/factory.js'
function createProviderClientForTest(r: import('../models/model-runtime.js').ResolvedModelRuntime) { return nativeClient(r.provider, r.capabilities, { apiKey: r.apiKey, model: r.modelId, maxTokens: 100, requestAuth: r.requestAuth }) }

import { spawn as spawnCli } from 'node:child_process'
import { fileURLToPath } from 'node:url'
test('actual CLI entry unauthenticated headless exits nonzero with login guidance and no browser or model request', async () => {
  const f = await fixture()
  try {
    accountStore(f.home).clearAccount()
    f.input.config.agent.defaultModel = 'official:fixture-model'
    f.writeConfig()
    const child = spawnCli(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../cli/entry.ts', import.meta.url)), '-p', 'fixture'], { cwd: f.home, env: { ...process.env, RIVET_CONFIG_WATCH: '0', RIVET_RUNTIME_LEAN: '1' }, stdio: ['ignore', 'pipe', 'pipe'], signal: AbortSignal.timeout(30000) })
    let output = ''; child.stdout.on('data', chunk => { output += String(chunk) }); child.stderr.on('data', chunk => { output += String(chunk) })
    const exit = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
    assert.notEqual(exit, 0); assert.match(output, /tianshu account login/); assert.doesNotMatch(output, /设备码|等待授权|verifyUrl/)
    assert.equal(f.calls.length, 0); assert.equal(f.quoteCount, 0)
  } finally { await f.close() }
})

test('automatic title starts after its own root preparation and shares that quote', async () => {
  const f = await fixture(); let manager: RuntimeSessionManager | undefined; let agent: AgentLoop | undefined
  try {
    const prepared = await prepareModelRuntime(f.input, f.deps)
    const cfg = createAgentConfig({ provider: prepared.provider, model: prepared.model, apiKey: '', auth: prepared.auth, cwd: f.home, sessionId: 'title-boundary', compact: f.input.config.compact, toolDefinitions: [], runtimeLean: true })
    agent = new AgentLoop({ ...cfg, toolRegistry: new ToolRegistry(), maxTurns: 2 }, new SessionContext(), f.home)
    let titleSends = 0
    let releaseMain: (() => void) | undefined
    f.setResponse((res, call) => {
      if (call.body.max_tokens === 256) { titleSends++; endText(res, 'Fixture title'); releaseMain?.() }
      else if (titleSends) endText(res, 'done')
      else releaseMain = () => endText(res, 'done')
    })
    manager = new RuntimeSessionManager({ defaultCwd: f.home, idleAgentTtlMs: 0, defaultModelId: 'official:fixture-model', createAgent: () => ({ run: (p, cb) => agent!.run(p, cb).then(() => {}), abort: () => agent!.abort(), listArtifacts: () => [], readArtifact: async () => null, getMessages: () => agent!.session.getMessages(), replaceMessages() {}, rewindToMessages() {} }), resolveGoalHandles: () => ({ runtimeSubmission: cfg.runtimeSubmission, currentModelRef: 'official:fixture-model', allProviders: f.input.config.provider.providers, goalTrackerRef: { current: null }, sessionDir: f.home }) })
    const session = manager.createSession({ cwd: f.home })
    await manager.runAndWait(session.id, 'Fixture title please')
    assert.equal(titleSends, 1); assert.equal(f.quoteCount, 1); assert.equal(f.calls.length, 2)
    assert.equal(new Set(f.calls.map(c => c.headers['x-tianshu-quote-id'])).size, 1)
  } finally { await manager?.shutdownAll(); await agent?.cancelIdleCompaction(); await agent?.drainPersistWrites(); await f.close() }
})

test('actual compact and vision bridges keep full native authorization within one original scope', async () => {
  const f = await fixture()
  try {
    const byok = providerSchema.parse({ name: 'byok', baseUrl: 'https://gateway.invalid/v1', apiKey: 'synthetic-byok', models: [{ id: 'byok-text', contextWindow: 32000, maxTokens: 100, supportsVision: false }] })
    f.input.provider.models[0]!.supportsVision = true
    const cfg = createAgentConfig({ provider: byok, model: byok.models[0]!, apiKey: 'synthetic-byok', cwd: f.home, sessionId: 'bridge', compact: { ...f.input.config.compact, enabled: true, provider: 'official', model: 'fixture-model' }, toolDefinitions: [], allProviders: { byok, official: f.input.provider }, visionModel: { provider: 'official', model: 'fixture-model', maxTokens: 100 } })
    await cfg.prepareModelSubmission!(new AbortController().signal)
    assert.ok(cfg.compactClient); assert.ok(cfg.visionClient)
    await cfg.compactClient.stream(request(), callbacks)
    await cfg.visionClient.stream({ ...request(), messages: [{ role: 'user', content: [{ type: 'text', text: 'describe' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] }] }, callbacks)
    assert.equal(f.calls.length, 2); assert.equal(f.quoteCount, 1)
    cfg.runtimeSubmission!.settle()
    await assert.rejects(cfg.compactClient.stream(request(), callbacks))
    assert.equal(f.calls.length, 2); assert.equal(f.quoteCount, 1)
  } finally { await f.close() }
})

test('actual BYOK fallback selects official through originating scope and stops on official refusal', async () => {
  const f = await fixture()
  try {
    const byok = providerSchema.parse({ name: 'byok', baseUrl: 'https://gateway.invalid/v1', apiKey: 'synthetic-byok', maxRetries: 0, fallback: ['official'], models: [{ id: 'byok-model', contextWindow: 32000, maxTokens: 100 }] })
    const cfg = createAgentConfig({ provider: byok, model: byok.models[0]!, apiKey: 'synthetic-byok', cwd: f.home, sessionId: 'fallback', compact: f.input.config.compact, toolDefinitions: [], allProviders: { byok, official: f.input.provider } })
    await cfg.prepareModelSubmission!(new AbortController().signal)
    f.setResponse((res, call) => { if (call.headers.authorization === 'Bearer synthetic-byok') { res.statusCode = 503; res.end('busy'); return }; endText(res, 'ok') })
    // The BYOK fixture wire returns its ordinary 503. The
    // managed fallback must prepare through the captured account, then succeed.
    await cfg.client.stream(request(), callbacks)
    assert.equal(f.calls.filter(c => c.headers['x-tianshu-binding-id']).length, 1); assert.equal(f.quoteCount, 1)
    cfg.runtimeSubmission!.settle()
    await assert.rejects(cfg.client.stream(request(), callbacks))
    assert.equal(f.calls.filter(c => c.headers['x-tianshu-binding-id']).length, 1)
  } finally { await f.close() }
})

for (const code of ['pricing_changed', 'account_changed', 'insufficient_balance', 'supplier_balance_unavailable'] as const) test(`mixed BYOK image ${code} keeps typed refusal through actual muted automation and stops the next tool round`, async () => {
  const f = await fixture(); let manager: RuntimeSessionManager | undefined; let registry: TaskRegistry | undefined; let wiring: CronWiring | undefined; const agents: AgentLoop[] = []
  try {
    const imageBinding: Binding = { ...f.binding, id: 'image-binding', modelId: 'image-model', operation: 'image-generation', stream: false, path: '/v1/images/generations' }
    f.catalog.models.push({ ...f.catalog.models[0]!, id: 'image-model', bindings: [imageBinding] })
    f.input.config.provider.providers['image-official'] = providerSchema.parse({ name: 'image-official', auth: { type: 'tianshu-account' }, models: [{ id: 'image-model', managed: { bindingId: imageBinding.id }, supportsImageGen: true }] })
    f.input.config.agent.imageGenModel = { provider: 'image-official', model: 'image-model' }
    const byok = providerSchema.parse({ name: 'byok', baseUrl: 'https://gateway.invalid/v1', apiKey: 'synthetic-byok', models: [{ id: 'byok-model', contextWindow: 32000, maxTokens: 1000 }] })
    f.setResponse((res, call) => {
      if (call.path.includes('/images/')) { res.statusCode = code === 'insufficient_balance' ? 402 : code === 'supplier_balance_unavailable' ? 503 : 409; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version: 1, requestId: 'image-refusal', error: { code, retryable: false } })); return }
      if (f.calls.filter(c => !c.path.includes('/images/')).length === 1) endTool(res, 'image-refused', 'generate_image', { prompt: 'fixture' }); else endText(res, 'must not continue')
    })
    manager = new RuntimeSessionManager({ defaultCwd: f.home, idleAgentTtlMs: 0, createAgent: (_cwd, id) => {
      const tools = new ToolRegistry(); tools.register(createGenerateImageTool({ loadConfig: () => f.input.config, getConfig: () => f.input.config.agent.imageGenModel, generateImage: options => generateImage({ ...options, fetchImpl: f.fetchImpl, lookupImpl: async () => ({ address: "93.184.216.34", family: 4 }) }), cwd: f.home }))
      const cfg = createAgentConfig({ provider: byok, model: byok.models[0]!, apiKey: 'synthetic-byok', cwd: f.home, sessionId: typeof id === 'string' ? id : randomUUID(), compact: f.input.config.compact, toolDefinitions: tools.getDefinitions(), allProviders: f.input.config.provider.providers, runtimeLean: true })
      const agent = new AgentLoop({ ...cfg, toolRegistry: tools, maxTurns: 3, approvalMode: 'dangerously-skip-permissions' }, new SessionContext(), f.home); agents.push(agent)
      return { run: (prompt, cb) => agent.run(prompt, cb).then(() => {}), abort: () => agent.abort(), listArtifacts: () => [], readArtifact: async () => null, getMessages: () => agent.session.getMessages(), replaceMessages() {}, rewindToMessages() {} } as ManagedAgent
    } })
    registry = new TaskRegistry({ taskStore: new JsonTaskStore(join(f.home, 'tasks')), runtimePool: new SessionRuntimePool({ manager, defaultCwd: f.home }), notifyPolicy: 'silent' })
    const path = join(f.home, 'schedule.json'), scheduler = new CronScheduler({ schedulePath: path })
    wiring = new CronWiring({ scheduler, registry })
    const schedule = createScheduledTask('mixed fixture', { type: 'interval', spec: '3600000' }); scheduler.add(schedule)
    const task = await registry.createTask({ prompt: 'fixture image', source: 'cron', callerId: 'test', scheduledTaskId: schedule.id, retry: { maxAttempts: 3, backoffMs: 1 } })
    let record = await registry.getTask(task.id)
    for (let i = 0; i < 200 && !['failed', 'completed'].includes(record?.status ?? ''); i++) { await new Promise(resolve => setTimeout(resolve, 20)); record = await registry.getTask(task.id) }
    assert.equal(record?.officialFailure, code); assert.ok(record?.sessionId)
    assert.equal(f.calls.length, 2); assert.equal(f.quoteCount, 1); assert.equal((await registry.listTasks()).length, 1)
    assert.ok(agents[0]!.session.getMessages().length >= 2)
    assert.equal(scheduler.get(schedule.id)?.status, 'paused')
    const restored = new CronScheduler({ schedulePath: path }); restored.load(); assert.equal(restored.get(schedule.id)?.status, 'paused'); restored.stop()
  } finally { wiring?.dispose(); registry?.dispose(); await manager?.shutdownAll(); for (const agent of agents) { await agent.cancelIdleCompaction(); await agent.drainPersistWrites() }; await f.close() }
})

test('actual early CLI model list/use validates official catalog without a quote or native send', async () => {
  const f = await fixture()
  try {
    f.writeConfig()
    const run = async (args: string[]) => { let output = '', exitCode = 0; assert.equal(await routeEarlyCli(args, { cwd: f.home, io: { stdout: text => { output += text }, stderr: text => { output += text }, exit: code => { exitCode = code } } }), true); return { output, exitCode } }
    const listed = await run(['model', 'list']); assert.equal(listed.exitCode, 0); assert.match(listed.output, /official:fixture-model/)
    const selected = await run(['model', 'use', 'official:fixture-model']); assert.equal(selected.exitCode, 0, selected.output); assert.match(selected.output, /official:fixture-model/)
    assert.notEqual((await run(['model', 'use', 'official:unknown'])).exitCode, 0)
    assert.equal(f.quoteCount, 0); assert.equal(f.calls.length, 0)
  } finally { await f.close() }
})


import { DelegationCoordinator } from '../agent/coordinator.js'
import { createWorkerRuntimeFactory } from '../agent/worker-runtime.js'
import { buildModelCards } from '../agent/headless-coordinator.js'
import { createDelegateTaskTool, createCoordinatorDelegateAdapter } from '../tools/delegate-task.js'
import { createDelegateBatchTool, createCoordinatorBatchDelegateAdapter } from '../tools/delegate-batch.js'
import { createDefaultToolRegistry } from '../tools/default-registry.js'
for (const mode of ['single', 'batch', 'hands'] as const) test(`actual mixed BYOK ${mode} delegation refusal reaches muted durable automation through the real pipeline`, async () => {
  const f = await fixture(); let manager: RuntimeSessionManager | undefined; let registry: TaskRegistry | undefined; let wiring: CronWiring | undefined
  const agents: AgentLoop[] = [], coordinators: DelegationCoordinator[] = []
  try {
    const byok = providerSchema.parse({ name: 'byok', baseUrl: 'https://gateway.invalid/v1', apiKey: 'synthetic-byok', models: [{ id: 'byok-model', contextWindow: 32000, maxTokens: 1000 }] })
    const taskInput = { objective: 'Inspect the actual fixture source and preserve original account authority and partial progress', profile: mode === 'hands' ? 'patcher' : 'code_scout', files: ['output.ts'] }
    f.input.config.provider.providers.byok = byok
    f.input.config.agent.review.profiles[taskInput.profile] = { provider: 'official', model: 'fixture-model' }
    let officialCalls = 0
    f.setResponse((res, call) => {
      if (call.headers.authorization === 'Bearer synthetic-byok') { assert.equal(f.quoteCount, 0); endTool(res, 'delegation-refused', mode === 'batch' ? 'delegate_batch' : 'delegate_task', mode === 'batch' ? { tasks: [taskInput] } : taskInput); return }
      officialCalls++
      res.statusCode = 409; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version: 1, requestId: 'delegation-refusal', error: { code: 'pricing_changed', retryable: false } }))
    })
    manager = new RuntimeSessionManager({ defaultCwd: f.home, idleAgentTtlMs: 0, createAgent: (_cwd, id) => {
      const tools = new ToolRegistry(); let coordinator: DelegationCoordinator
      tools.register(mode === 'batch' ? createDelegateBatchTool(createCoordinatorBatchDelegateAdapter(() => coordinator)) : createDelegateTaskTool(createCoordinatorDelegateAdapter(() => coordinator)))
      const cfg = createAgentConfig({ provider: byok, model: byok.models[0]!, apiKey: 'synthetic-byok', cwd: f.home, sessionId: typeof id === 'string' ? id : randomUUID(), compact: f.input.config.compact, toolDefinitions: tools.getDefinitions(), allProviders: f.input.config.provider.providers, runtimeLean: true })
      const runtime = createWorkerRuntimeFactory(() => ({ getUserInstructions: () => DISABLED_USER_INSTRUCTIONS, config: f.input.config, cwd: f.home, provider: byok, apiKey: 'synthetic-byok', auth: undefined, domainKnowledgeStore: undefined, currentModelId: 'byok-model', listActiveClaims: () => [], sessionMemoryBlock: () => undefined, writeProfiles: ['patcher'], runtimeSubmission: cfg.runtimeSubmission }))
      coordinator = new DelegationCoordinator({ baseToolRegistry: createDefaultToolRegistry([], { desktopTools: false }), modelCards: buildModelCards(f.input.provider), maxWorkers: 1, sharedWorktree: true, selectModel: runtime.selectModel, runtimeFactory: async (order, card, workerRegistry) => {
        const worker = await runtime.runtimeFactory(order, card, workerRegistry)
        worker.finalizeReport = false; worker.parentApprovalMode = 'dangerously-skip-permissions'; return worker
      } }); coordinators.push(coordinator)
      const agent = new AgentLoop({ ...cfg, toolRegistry: tools, maxTurns: 3, approvalMode: 'dangerously-skip-permissions' }, new SessionContext(), f.home); agents.push(agent)
      return { run: (prompt, cb) => agent.run(prompt, cb).then(() => {}), abort: () => agent.abort(), listArtifacts: () => [], readArtifact: async () => null, getMessages: () => agent.session.getMessages(), replaceMessages() {}, rewindToMessages() {} } as ManagedAgent
    } })
    registry = new TaskRegistry({ taskStore: new JsonTaskStore(join(f.home, 'tasks')), runtimePool: new SessionRuntimePool({ manager, defaultCwd: f.home }), notifyPolicy: 'silent' })
    const path = join(f.home, 'schedule.json'), scheduler = new CronScheduler({ schedulePath: path }); wiring = new CronWiring({ scheduler, registry })
    const schedule = createScheduledTask('delegated fixture', { type: 'interval', spec: '3600000' }); scheduler.add(schedule)
    const task = await registry.createTask({ prompt: 'fixture delegation', source: 'cron', callerId: 'test', scheduledTaskId: schedule.id, retry: { maxAttempts: 3, backoffMs: 1 } })
    let record = await registry.getTask(task.id)
    for (let i = 0; i < 200 && !['failed', 'completed'].includes(record?.status ?? ''); i++) { await new Promise(resolve => setTimeout(resolve, 20)); record = await registry.getTask(task.id) }
    assert.equal(record?.officialFailure, 'pricing_changed', JSON.stringify(record)); assert.ok(record?.sessionId)
    assert.equal(f.calls.filter(c => c.headers.authorization === 'Bearer synthetic-byok').length, 1)
    assert.equal(officialCalls, 1); assert.equal(f.quoteCount, 1); assert.equal((await registry.listTasks()).length, 1)
    assert.ok(agents[0]!.session.getMessages().length >= 2); assert.equal(scheduler.get(schedule.id)?.status, 'paused')
    const restored = new CronScheduler({ schedulePath: path }); restored.load(); assert.equal(restored.get(schedule.id)?.status, 'paused'); restored.stop()
  } finally { wiring?.dispose(); registry?.dispose(); await manager?.shutdownAll(); for (const c of coordinators) await c.shutdown(); for (const agent of agents) { await agent.cancelIdleCompaction(); await agent.drainPersistWrites() }; await f.close() }
})


import { runOfficialModelCLI } from '../cli/official-model-cli.js'
import { handleAccountLogin } from '../tui/account-login.js'
import { loadConfig } from '../config/manager.js'
import { resolveProviderForModel } from '../models/model-runtime.js'
import { SessionTitleCoordinator } from '../server/session-title.js'
import type { SessionRecord } from '../server/protocol.js'

test('Fix1 CLI login exposes usable device approval before its polling finishes', async () => {
  const previousDevice = process.env.RIVET_PRO_DEVICE_ID
  const f = await fixture(); let release!: () => void; let shown!: () => void; let polling!: () => void
  // 设备号固定为夹具已登记的值：本用例测「轮询结束前授权码可见」，不测冷启动时 reg.exe
  // 取原生指纹的耗时（Windows 上首次可达 1.5–2s，会把 1s 可见窗口挤掉）。
  process.env.RIVET_PRO_DEVICE_ID = readFileSync(join(f.home, '.device-id'), 'utf8').trim()
  try {
    const approved = new Promise<void>(resolve => { release = resolve })
    const visible = new Promise<void>(resolve => { shown = resolve })
    const pollStarted = new Promise<void>(resolve => { polling = resolve })
    f.setDeviceApprovalGate({ then(resolve, reject) { polling(); return approved.then(resolve, reject) } })
    let output = '', completed = false
    const run = runOfficialModelCLI(['account', 'login'], { write: line => { output += line; if (output.includes('ABCD-EFGH') && output.includes('https://account.invalid/authorize')) shown() }, login: (app, result) => handleAccountLogin(app, result, { openBrowser: () => {} }) }).then(result => { completed = true; return result })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([visible, pollStarted.then(() => { throw new Error('CLI approval was hidden when polling began') }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('CLI approval startup timed out')), 30000) })])
      assert.equal(completed, false); release()
      assert.equal((await run).exitCode, 0)
      assert.equal(output.split('设备码：').length - 1, 1)
    } finally { if (timer) clearTimeout(timer); release(); await run; await f.close() }
  } finally {
    if (previousDevice === undefined) delete process.env.RIVET_PRO_DEVICE_ID
    else process.env.RIVET_PRO_DEVICE_ID = previousDevice
  }
})

test('Fix1 CLI model use preserves the exact selected Key pool owner', async () => {
  const f = await fixture()
  try {
    const provider = providerSchema.parse({ name: 'keys', baseUrl: 'https://gateway.invalid/v1', models: [{ id: 'same-model' }], keys: [{ id: 'keyA', label: 'A', apiKey: 'synthetic-A', models: [{ id: 'same-model' }] }, { id: 'keyB', label: 'B', apiKey: 'synthetic-B', models: [{ id: 'same-model' }] }] })
    const config = configSchema.parse({ provider: { default: 'keys', providers: { keys: provider } }, agent: { defaultModel: 'keys:keyA:same-model' } })
    f.writeConfig(config)
    const result = await runOfficialModelCLI(['model', 'use', 'keys:keyB:same-model']); assert.equal(result.exitCode, 0, result.output)
    const saved = loadConfig(); assert.equal(saved.agent.defaultModel, 'keys:keyB:same-model')
    const next = resolveProviderForModel({ config: saved, provider: saved.provider.providers.keys!, apiKey: '' }, saved.agent.defaultModel!)
    assert.ok(next && !('error' in next)); assert.equal(next.keyId, 'keyB'); assert.equal(next.apiKey, 'synthetic-B')
  } finally { await f.close() }
})

test('Fix1 delayed automatic BYOK title fallback cannot borrow the next root boundary', async () => {
  const f = await fixture(); let release!: () => void; let received!: () => void
  const started = new Promise<void>(resolve => { received = resolve })
  const byok = providerSchema.parse({ name: 'byok', baseUrl: 'https://gateway.invalid/v1', apiKey: 'synthetic-byok', models: [{ id: 'cheap', contextWindow: 32000, maxTokens: 100 }] })
  const providers = { ...f.input.config.provider.providers, byok }
  const cfg = createAgentConfig({ provider: byok, model: byok.models[0]!, apiKey: 'synthetic-byok', cwd: f.home, sessionId: 'title-fallback', compact: f.input.config.compact, toolDefinitions: [], allProviders: providers })
  const record: SessionRecord = { id: 'title-fallback', cwd: f.home, status: 'idle', createdAt: 1, updatedAt: 1, lastSeq: 0, pendingApprovals: 0 }
  try {
    await cfg.prepareModelSubmission!(new AbortController().signal)
    f.setResponse((res, call) => { if (call.body.model === 'cheap') { release = () => { if (!res.writableEnded) endText(res, '') }; received() } else endText(res, 'Wrong root title') })
    const title = new SessionTitleCoordinator({ get: () => record, save() {}, models: () => ({ providers, cheap: { provider: 'byok', model: 'cheap' }, current: 'official:fixture-model', submission: cfg.runtimeSubmission }) })
    const done = title.generate(record.id, 'Original request')
    await started; cfg.runtimeSubmission!.settle(); await cfg.prepareModelSubmission!(new AbortController().signal); release(); await done
    assert.equal(f.quoteCount, 0); assert.equal(f.calls.length, 1); assert.equal(record.titleGenerationState, 'failed')
  } finally { release?.(); cfg.runtimeSubmission!.settle(); await f.close() }
})

test('Fix1 task timeout cannot dispatch retry while native refusal cleanup drains', async () => {
  const f = await fixture(); let manager: RuntimeSessionManager | undefined; let registry: TaskRegistry | undefined; let wiring: CronWiring | undefined
  const agents: AgentLoop[] = []; let release!: () => void; let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), draining = new Promise<void>(resolve => { entered = resolve })
  try {
    const prepared = await prepareModelRuntime(f.input, f.deps)
    f.setResponse(res => { res.statusCode = 409; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version: 1, requestId: 'drain-refusal', error: { code: 'pricing_changed', retryable: false } })) })
    manager = new RuntimeSessionManager({ defaultCwd: f.home, idleAgentTtlMs: 0, createAgent: (_cwd, id) => {
      const cfg = createAgentConfig({ provider: prepared.provider, model: prepared.model, apiKey: '', auth: prepared.auth, cwd: f.home, sessionId: typeof id === 'string' ? id : randomUUID(), compact: f.input.config.compact, toolDefinitions: [], runtimeLean: true })
      const session = new SessionContext(); session.replaceMessages([{ role: 'user', content: 'prior completed request' }, { role: 'assistant', content: 'prior completed response' }])
      const agent = new AgentLoop({ ...cfg, toolRegistry: new ToolRegistry(), maxTurns: 2 }, session, f.home); agents.push(agent)
      return { run: (prompt, cb) => agent.run(prompt, cb).then(() => {}).finally(async () => { entered(); await gate }), abort: () => agent.abort(), listArtifacts: () => [], readArtifact: async () => null, getMessages: () => agent.session.getMessages(), replaceMessages() {}, rewindToMessages() {} } as ManagedAgent
    } })
    registry = new TaskRegistry({ taskStore: new JsonTaskStore(join(f.home, 'tasks')), runtimePool: new SessionRuntimePool({ manager, defaultCwd: f.home }), notifyPolicy: 'silent' })
    const schedulePath = join(f.home, 'schedule.json'), scheduler = new CronScheduler({ schedulePath }); wiring = new CronWiring({ scheduler, registry })
    const schedule = createScheduledTask('drain fixture', { type: 'interval', spec: '3600000' }); scheduler.add(schedule)
    const task = await registry.createTask({ prompt: 'fixture', source: 'cron', callerId: 'test', scheduledTaskId: schedule.id, timeoutMs: 1000, retry: { maxAttempts: 2, backoffMs: 1 } })
    await draining
    let record = await registry.getTask(task.id)
    for (let i = 0; i < 200 && record?.status !== 'timed_out'; i++) { await new Promise(resolve => setTimeout(resolve, 20)); record = await registry.getTask(task.id) }
    assert.equal(record?.status, 'timed_out'); await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal((await registry.listTasks()).length, 1, 'cleanup must drain before any retry dispatch'); assert.equal(f.calls.length, 1)
    release()
    for (let i = 0; i < 200 && !record?.officialFailure; i++) { await new Promise(resolve => setTimeout(resolve, 20)); record = await registry.getTask(task.id) }
    assert.equal(record?.status, 'timed_out'); assert.equal(record?.officialFailure, 'pricing_changed'); assert.ok(record?.sessionId)
    const history = agents[0]!.session.getMessages()
    assert.deepEqual(history.slice(0, 2), [{ role: 'user', content: 'prior completed request' }, { role: 'assistant', content: 'prior completed response' }])
    assert.equal(history.length, 3)
    assert.equal(history[2]!.role, 'user')
    assert.ok(agents[0]!.session.isUserInputPublished(history[2]))
    assert.match(String(history[2]!.content), /^fixture\b/)
    assert.equal(scheduler.get(schedule.id)?.status, 'paused'); const restored = new CronScheduler({ schedulePath }); restored.load(); assert.equal(restored.get(schedule.id)?.status, 'paused'); restored.stop()
    assert.equal((await registry.listTasks()).length, 1); assert.equal(f.quoteCount, 1)
  } finally { release(); wiring?.dispose(); registry?.dispose(); await manager?.shutdownAll(); for (const agent of agents) { await agent.cancelIdleCompaction(); await agent.drainPersistWrites() }; await f.close() }
})

import { createEmbeddingProvider } from '../search/embedding-provider.js'
for (const mode of ['configured', 'disabled', 'lean'] as const) test(`Fix1 normal embedding entry ${mode}`, async () => {
  const f = await fixture({ operation: 'embedding' }), oldDisabled = process.env.RIVET_NO_EMBEDDINGS, oldLean = process.env.RIVET_LEAN
  try {
    delete process.env.RIVET_NO_EMBEDDINGS; delete process.env.RIVET_LEAN
    if (mode === 'disabled') process.env.RIVET_NO_EMBEDDINGS = '1'
    if (mode === 'lean') process.env.RIVET_LEAN = '1'
    f.setResponse(res => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }] })) })
    const embedding = createEmbeddingProvider({ managed: { input: f.input, deps: f.deps }, fetchImpl: f.fetchImpl })
    assert.equal(embedding.isAvailable(), mode === 'configured')
    assert.deepEqual(await embedding.embed(['fixture document']), mode === 'configured' ? [[0.1, 0.2]] : [])
    if (mode === 'configured') { assert.equal(f.calls[0]!.path, '/v1/embeddings'); assert.equal(f.quoteCount, 1); assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.headers['x-tianshu-binding-id'], f.binding.id) }
    else assert.deepEqual(f.readCounters(), { catalogRequests: 0, credentialGrants: 0, priceQuotes: 0, nativeRequests: 0 })
  } finally { if (oldDisabled === undefined) delete process.env.RIVET_NO_EMBEDDINGS; else process.env.RIVET_NO_EMBEDDINGS = oldDisabled; if (oldLean === undefined) delete process.env.RIVET_LEAN; else process.env.RIVET_LEAN = oldLean; await f.close() }
})

test('Fix1 actual automated native 429 over retry budget pauses without retry loop', async () => {
  const f = await fixture(); let manager: RuntimeSessionManager | undefined; let registry: TaskRegistry | undefined; let wiring: CronWiring | undefined; const agents: AgentLoop[] = []
  try {
    const prepared = await prepareModelRuntime(f.input, f.deps)
    f.setResponse(res => { res.statusCode = 429; res.setHeader('retry-after', '3600'); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version: 1, requestId: 'fixture-refusal', error: { code: 'rate_limited', retryable: true, retryAfterSeconds: 3600, scope: 'account' } })) })
    manager = new RuntimeSessionManager({ defaultCwd: f.home, idleAgentTtlMs: 0, createAgent: (_cwd, id) => {
      const cfg = createAgentConfig({ provider: prepared.provider, model: prepared.model, apiKey: '', auth: prepared.auth, cwd: f.home, sessionId: typeof id === 'string' ? id : randomUUID(), compact: f.input.config.compact, toolDefinitions: [], runtimeLean: true })
      const agent = new AgentLoop({ ...cfg, toolRegistry: new ToolRegistry(), maxTurns: 2 }, new SessionContext(), f.home); agents.push(agent)
      return { run: (prompt, cb) => agent.run(prompt, cb).then(() => {}), abort: () => agent.abort(), listArtifacts: () => [], readArtifact: async () => null, getMessages: () => agent.session.getMessages(), replaceMessages() {}, rewindToMessages() {} } as ManagedAgent
    } })
    registry = new TaskRegistry({ taskStore: new JsonTaskStore(join(f.home, 'tasks')), runtimePool: new SessionRuntimePool({ manager, defaultCwd: f.home }), notifyPolicy: 'silent' })
    const path = join(f.home, 'schedule.json'), scheduler = new CronScheduler({ schedulePath: path })
    wiring = new CronWiring({ scheduler, registry })
    const schedule = createScheduledTask('fixture automation', { type: 'interval', spec: '3600000' }); scheduler.add(schedule)
    const task = await registry.createTask({ prompt: 'fixture', source: 'cron', callerId: 'test', scheduledTaskId: schedule.id, retry: { maxAttempts: 3, backoffMs: 1 } })
    let record = await registry.getTask(task.id)
    for (let i = 0; i < 200 && record?.status !== 'failed'; i++) { await new Promise(resolve => setTimeout(resolve, 20)); record = await registry.getTask(task.id) }
    assert.equal(record?.officialFailure, 'rate_limited'); assert.ok(record?.sessionId)
    assert.equal(f.quoteCount, 1); await new Promise(r => setTimeout(r, 50));
    assert.equal(f.calls.length, 1); assert.equal((await registry.listTasks()).length, 1)
    assert.equal(scheduler.get(schedule.id)?.status, 'paused')
    const restored = new CronScheduler({ schedulePath: path }); restored.load(); assert.equal(restored.get(schedule.id)?.status, 'paused'); restored.stop()
  } finally { wiring?.dispose(); registry?.dispose(); await manager?.shutdownAll(); for (const agent of agents) { await agent.cancelIdleCompaction(); await agent.drainPersistWrites() }; await f.close() }
})

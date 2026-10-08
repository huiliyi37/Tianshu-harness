import { test, after } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { DelegationCoordinator } from '../coordinator.js'
import { runWorkerSessionOop } from '../worker-process/parent.js'
import { encodeFrame } from '../worker-process/protocol.js'
import { ToolRegistry } from '../../tools/registry.js'
import { ContextClaimStore } from '../../context/claim-store.js'
import { extractClaimsFromToolResult } from '../../context/claim-extractor.js'
import { buildWorkerRuntime } from '../worker-runtime.js'

const fixtureDir = mkdtempSync(join(tmpdir(), 'orchestration-regressions-'))
after(() => rmSync(fixtureDir, { recursive: true, force: true }))
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const result = (id: string, status = 'passed', failureReason?: string) => ({ workOrderId: id, status, summary: 'Fictional local worker report; no tool, network or child process was executed.', findings: [], artifacts: [], changedFiles: [], examinedFiles: [], risks: [], nextActions: [], evidenceStatus: 'unverified', ...(failureReason ? { failureReason } : {}) })
const transcript = { text: '', toolUses: [], toolResults: [] }
const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// Fake ChildProcess has no pid and never spawns or signals any actual process.
async function oopSteer() {
  const fakeChild = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
  const frames: any[] = []
  fakeChild.stdin.on('data', chunk => { for (const line of String(chunk).trim().split('\n')) frames.push(JSON.parse(line)) })
  let pending: string | null = null
  let drains = 0
  const config: any = {
    order: { id: 'fake-oop', objective: 'Fictional task', profile: 'code_scout', allowedTools: [], budget: { maxTurns: 3 } },
    client: {}, promptEngine: {}, toolRegistry: {}, cwd: fixtureDir, maxTurns: 3, contextWindow: 64000,
    compact: { enabled: false, model: 'fake' }, activeClaims: [],
    runtimeDecision: { providerName: 'fictional', model: 'fictional-model', maxTokens: 1024, contextWindow: 64000, thinkingBudget: 0, isWrite: false },
    onSteerDrain: () => { drains++; const text = pending; pending = null; return text },
  }
  const running = runWorkerSessionOop(config, { getMemoryBlock: () => undefined, stallMsOverride: 5000, entryOverride: { execArgs: [], script: 'no-real-child' }, spawnOverride: () => fakeChild as any })
  pending = 'Fictional user guidance after dispatch'
  fakeChild.stdout.write(encodeFrame({ t: 'activity', kind: 'tool_result', detail: 'fictional completion' } as any))
  fakeChild.stdout.write(encodeFrame({ t: 'tick', at: Date.now() }))
  await sleep(40)
  const productionObservation = { drains, pending, steerFrames: frames.filter(f => f.t === 'steer').length, frameTypes: frames.map(f => f.t) }
  // Existing unit test manually calls this callback. This proves transport is wired
  // but also isolates the missing automatic caller in the production parent runner.
  config.onSteerDrain()
  assert.equal(frames.filter(f => f.t === 'steer').length, 1)
  fakeChild.stdout.write(encodeFrame({ t: 'result', run: { result: result('fake-oop'), transcript, usage, messages: [], turnCount: 1 } } as any))
  await running
  fakeChild.emit('exit', 0)
  fakeChild.emit('close', 0)
  assert.ok(productionObservation.drains > 0)
  assert.equal(productionObservation.steerFrames, 1)
  assert.equal(productionObservation.pending, null)
  console.log('OOP_STEER', JSON.stringify({ productionObservation, manualCallbackSteerFrames: frames.filter(f => f.t === 'steer').length }))
}

async function continuationCancellation(mode: 'kill' | 'shutdown' | 'stall' = 'kill', retryFirst = false) {
  let resolveContinuation!: (value: any) => void
  let resolveStarted!: () => void
  const started = new Promise<void>(r => { resolveStarted = r })
  let continuedSignal: AbortSignal | undefined
  let calls = 0
  let orderId = ''
  const registry = new ToolRegistry()
  const coordinator = new DelegationCoordinator({
    baseToolRegistry: registry,
    modelCards: [{ model: 'fictional-model', toolUseReliability: .8, jsonStability: .9, editSuccessRate: .7, testRepairRate: .6, contextWindow: 128000, cacheEconomics: 'strong', recommendedTasks: ['code_search'] }],
    maxWorkers: 1, workerStallMs: 70, cwd: fixtureDir, retrySleepFn: async () => {}, escalationCap: 'off',
    runtimeFactory: (order, _card, toolRegistry) => ({ order, client: {} as any, promptEngine: {} as any, toolRegistry, cwd: fixtureDir, maxTurns: 2, contextWindow: 128000, compact: { enabled: false, model: 'fake' } }),
    runWorker: async config => {
      calls++
      orderId = config.order.id
      if (retryFirst && calls === 1) throw new Error('fictional transient transport failure')
      if (calls === (retryFirst ? 2 : 1)) return { result: result(orderId, 'blocked', 'max_turns'), session: { getMessages: () => [{ role: 'user', content: 'Fictional retained history' }] }, transcript, usage } as any
      continuedSignal = config.abortSignal
      resolveStarted()
      return new Promise(r => { resolveContinuation = r }) as any
    },
  })
  const running = coordinator.delegate({ parentTurnId: 'fake-turn', objective: 'Inspect fictional worker cancellation and retain previous findings', kind: 'code_search', profile: 'code_scout', scope: {}, budget: { maxRetries: retryFirst ? 1 : 0 } })
  await started
  const immediate = { isWorkerRunning: coordinator.isWorkerRunning(orderId), steerAccepted: coordinator.steerWorker(orderId, 'fictional advice'), killAccepted: mode === 'kill' ? coordinator.killWorker(orderId) : undefined }
  if (mode === 'shutdown') coordinator.shutdown()
  await sleep(mode === 'stall' ? 1500 : 180)
  const afterStall = { signalAborted: continuedSignal?.aborted, livenessSize: (coordinator as any).liveness.size() }
  coordinator.shutdown()
  const afterShutdown = { signalAborted: continuedSignal?.aborted }
  resolveContinuation({ result: result(orderId), session: { getMessages: () => [] }, transcript, usage })
  await running
  assert.equal(immediate.isWorkerRunning, true)
  if (mode === 'kill') assert.equal(immediate.killAccepted, true)
  assert.equal(afterStall.signalAborted, true)
  assert.equal(immediate.steerAccepted, true)
  assert.equal(afterShutdown.signalAborted, true)
  console.log('CONTINUATION_CANCEL', JSON.stringify({ calls, immediate, afterStall, afterShutdown }))
}

async function claimRefresh() {
  const sessionId = `fake-claims-${Date.now()}`
  const store = new ContextClaimStore(fixtureDir, sessionId)
  const ctx = { toolName: 'read_file', input: { file_path: 'fictional/a.js' }, result: 'export function sameName() { return 1 }\n', isError: false }
  const first = extractClaimsFromToolResult(ctx as any, { sessionId, turn: 1, eventId: 'read-1' })[0]!
  const initial = store.propose(first)
  store.markClaimsStaleForFile('fictional/a.js', 'fictional local edit')
  const rereadCtx = { ...ctx, result: 'export function sameName() { return 2 }\n' }
  const existingPaths = new Set(store.listActiveClaims().filter(c => c.kind === 'file_observation').flatMap(c => c.evidence.filter(e => e.path).map(e => e.path!)))
  const productionProposals = extractClaimsFromToolResult(rereadCtx as any, { sessionId, turn: 2, eventId: 'read-2' }, existingPaths)
  assert.equal(productionProposals.length, 1)
  const second = extractClaimsFromToolResult(rereadCtx as any, { sessionId, turn: 2, eventId: 'read-2' })[0]!
  const reread = store.propose(second)
  await store.flushWrites()
  assert.notEqual(initial.id, reread.id)
  assert.equal(reread.status, 'active')
  assert.equal(store.listActiveClaims().length, 1)
  assert.equal(reread.source.eventId, 'read-2')
  await store.flushWrites()
  console.log('CLAIM_REFRESH', JSON.stringify({ firstText: first.text, secondText: second.text, productionProposals: productionProposals.length, idUnchanged: initial.id === reread.id, rereadStatus: reread.status, activeClaims: store.listActiveClaims().length, retainedEvidenceEvent: reread.source.eventId }))
}

async function routingMetadata() {
  // Literal dummy API key is fictional. Clients are constructed but never streamed.
  const mainProvider: any = { name: 'fake-primary', apiKey: 'fictional-key', baseUrl: 'http://127.0.0.1:1', unsupported: [], capabilities: {}, models: [{ id: 'fake-card-A', maxTokens: 1024, contextWindow: 64000 }] }
  const routedProvider: any = { name: 'fake-routed', apiKey: 'fictional-key', baseUrl: 'http://127.0.0.1:1', unsupported: [], capabilities: {}, models: [{ id: 'fake-routed-B', maxTokens: 1024, contextWindow: 64000 }] }
  const providers = { 'fake-primary': mainProvider, 'fake-routed': routedProvider }
  const routing = { profiles: { scout: { provider: 'fake-routed', model: 'fake-routed-B' } }, routing: { repo_summarization: 'scout' }, providers }
  let actualModel: string | undefined
  const coordinator = new DelegationCoordinator({
    baseToolRegistry: new ToolRegistry(), maxWorkers: 1, cwd: fixtureDir, routing,
    modelCards: [{ model: 'fake-card-A', toolUseReliability: .8, jsonStability: .9, editSuccessRate: .7, testRepairRate: .6, contextWindow: 64000, cacheEconomics: 'strong', recommendedTasks: ['code_search'] }],
    runtimeFactory: (order, card, registry) => buildWorkerRuntime({ config: { provider: { providers } } as any, cwd: fixtureDir, provider: mainProvider, apiKey: 'fictional-key', auth: undefined, currentModelId: 'fake-card-A', listActiveClaims: () => [], sessionMemoryBlock: () => undefined, domainKnowledgeStore: undefined, reviewOverrides: new Map(), reviewOverrideApiKeys: new Map(), workerRouting: routing, writeProfiles: [] }, order, card, registry),
    runWorker: async config => { actualModel = config.runtimeDecision?.model; return { result: result(config.order.id), session: { getMessages: () => [] }, transcript, usage } as any },
  })
  const run = await coordinator.delegate({ parentTurnId: 'fake-routing', objective: 'Inspect fictional routed worker model identity and report its findings', kind: 'code_search', profile: 'code_scout', scope: {} })
  coordinator.shutdown()
  assert.equal(actualModel, 'fake-routed-B')
  assert.equal(run.results[0]?.model, 'fake-routed-B')
  assert.equal(run.selectedModel, 'fake-routed-B')
  assert.equal(run.results[0]?.provider, 'fake-routed')
  console.log('ROUTING_METADATA', JSON.stringify({ actualRuntimeDecisionModel: actualModel, finalResultModel: run.results[0]?.model, finalResultProvider: run.results[0]?.provider, selectedModel: run.selectedModel }))
}

test('OOP guidance reaches child without a manual drain', oopSteer)
test('automatic continuation remains cancellable and steerable', () => continuationCancellation())
test('retry continuation remains cancellable and steerable', () => continuationCancellation('kill', true))
test('retry continuation remains cancellable during shutdown', () => continuationCancellation('shutdown', true))
test('retry continuation remains cancellable by the stall sweep', () => continuationCancellation('stall', true))
test('shutdown cancels an active automatic continuation', () => continuationCancellation('shutdown'))
test('stall sweep cancels an inactive automatic continuation', () => continuationCancellation('stall'))
test('fresh file reads replace stale observation evidence', claimRefresh)
test('result identity matches actual cross-provider runtime', routingMetadata)

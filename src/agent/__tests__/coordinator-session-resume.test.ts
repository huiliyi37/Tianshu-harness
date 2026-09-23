/**
 * Session resume integration tests.
 *
 * Verifies the end-to-end flow:
 * 1. Worker session messages are persisted after a delegate() call
 * 2. A subsequent delegate() with resumeWorkOrderId loads those messages and
 *    injects them as priorMessages into the worker config
 * 3. When the saved session doesn't exist, the worker starts fresh
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DelegationCoordinator } from '../coordinator.js'
import { loadWorkerSession, workerSessionPath } from '../worker-session-persist.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_ONLY_WORKER_TOOLS, type WorkerResult } from '../work-order.js'
import { profileRegistry } from '../profile-registry.js'
import type { StreamClient } from '../../api/stream-client.js'
import type { ModelCapabilityCard } from '../../model/capability.js'
import type { Tool, ToolCallParams } from '../../tools/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

// Use /tmp for mkdtemp — the default TMPDIR may have EPERM
const TMP_BASE = '/tmp'

function fakeTool(name: string): Tool {
  return {
    definition: { name, description: `${name} test tool`, input_schema: { type: 'object', properties: {} } },
    execute: async () => ({ content: `${name} executed` }),
    requiresApproval: (_params: ToolCallParams) => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  for (const name of READ_ONLY_WORKER_TOOLS) registry.register(fakeTool(name))
  for (const pname of profileRegistry.getProfileNames()) {
    for (const tool of profileRegistry.get(pname)!.allowedTools) registry.register(fakeTool(tool))
  }
  return registry
}

const cards: ModelCapabilityCard[] = [{
  model: 'test-model',
  toolUseReliability: 0.8,
  jsonStability: 0.8,
  editSuccessRate: 0.7,
  testRepairRate: 0.6,
  contextWindow: 128_000,
  cacheEconomics: 'medium',
  recommendedTasks: ['code_search'],
}]

const LONG_SUMMARY = 'This is a sufficiently long summary that exceeds the minimum threshold of 200 characters. It describes what the worker found: the authentication flow was traced through coordinator.ts, worker-session.ts, and delegate-task.ts. The key finding is that priorMessages injection works correctly when session resume is requested by the parent agent context.'

function makePassedResult(orderId: string, summary = LONG_SUMMARY): WorkerResult {
  return {
    workOrderId: orderId,
    status: 'passed',
    summary,
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'verified',
  }
}

/** Build a coordinator with a mock runWorker that returns configurable results.
 *  Captures the config passed to runWorker so tests can inspect priorMessages. */
function makeCoordinator(opts: {
  runWorker: (config: { priorMessages?: readonly OaiMessage[]; order: { id: string; objective: string; profile: string } }) => Promise<{
    result: WorkerResult
    session: { getMessages: () => OaiMessage[]; getTurnCount: () => number }
    usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
  }>
  homeDir: string
}): DelegationCoordinator {
  return new DelegationCoordinator({
    baseToolRegistry: makeRegistry(),
    modelCards: cards,
    maxWorkers: 2,
    cwd: '/repo',
    runtimeFactory: (order, card, workerRegistry) => ({
      order,
      client: {} as StreamClient,
      promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
      toolRegistry: workerRegistry,
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: card.contextWindow,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    }),
    runWorker: opts.runWorker as never,
  })
}

describe('coordinator session resume', () => {
  let homeDir: string
  let savedHome: string | undefined
  let savedRivetHome: string | undefined

  beforeEach(() => {
    homeDir = mkdtempSync(join(TMP_BASE, 'rivet-resume-'))
    savedHome = process.env.HOME
    process.env.HOME = homeDir
    // rivetHome() 优先 RIVET_HOME——不显式钉住时，环境里的 RIVET_HOME 会让被测代码
    // 写 $RIVET_HOME/subagents 而断言落在 $HOME/.rivet/subagents（legacy homeDir 形）。
    // 钉成 <tmp>/.rivet 后两条路径汇合，有无外部环境变量都密闭。
    savedRivetHome = process.env.RIVET_HOME
    process.env.RIVET_HOME = join(homeDir, '.rivet')
  })

  afterEach(() => {
    process.env.HOME = savedHome
    if (savedRivetHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = savedRivetHome
  })

  it('persists worker session messages after a successful delegate() call', async () => {
    const mockMessages: OaiMessage[] = [
      { role: 'user', content: 'Find the auth flow.' },
      { role: 'assistant', content: '{"workOrderId":"wo_resume_1","status":"passed","summary":"found it"}' },
    ]
    let capturedOrderId: string | undefined
    const coordinator = makeCoordinator({
      homeDir,
      runWorker: async (config) => {
        capturedOrderId = config.order.id
        return {
          result: makePassedResult(config.order.id),
          session: { getMessages: () => mockMessages, getTurnCount: () => 1 },
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }
      },
    })

    await coordinator.delegate({
      parentTurnId: 'tu_test',
      objective: 'trace the authentication flow across multiple coordinator modules',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: ['a.ts', 'b.ts'] },
    })

    // The order id is auto-generated (wo_<uuid>) — use the captured id
    assert.ok(capturedOrderId, 'should have captured the order id')

    // Verify the session file was created
    const sessionPath = workerSessionPath(capturedOrderId!, homeDir)
    assert.ok(existsSync(sessionPath), `session file should exist at ${sessionPath}`)

    const loaded = loadWorkerSession(capturedOrderId!, homeDir)
    assert.ok(loaded, 'should load the session')
    assert.equal(loaded!.messages.length, 2)
    assert.equal(loaded!.profile, 'code_scout')
  })

  it('loads priorMessages when resumeWorkOrderId is provided', async () => {
    // First, save a session manually
    const priorMessages: OaiMessage[] = [
      { role: 'user', content: 'Previous objective' },
      { role: 'assistant', content: '{"status":"passed","summary":"previous result"}' },
    ]
    const { saveWorkerSession } = await import('../worker-session-persist.js')
    saveWorkerSession('wo_prior', 'code_scout', 'Previous objective', priorMessages, homeDir)

    // Now delegate with resume
    const capturedConfigs: { priorMessages?: readonly OaiMessage[] }[] = []
    const coordinator = makeCoordinator({
      homeDir,
      runWorker: async (config) => {
        capturedConfigs.push({ priorMessages: config.priorMessages })
        return {
          result: makePassedResult('wo_resume_2'),
          session: { getMessages: () => [...(config.priorMessages ?? []), { role: 'user', content: 'new' }], getTurnCount: () => 2 },
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }
      },
    })

    await coordinator.delegate({
      parentTurnId: 'tu_test_resume',
      objective: 'Continue the search with a different angle',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: ['a.ts', 'b.ts'] },
      resumeWorkOrderId: 'wo_prior',
    })

    // Verify priorMessages were injected
    assert.equal(capturedConfigs.length, 1, 'runWorker should have been called')
    assert.ok(capturedConfigs[0]!.priorMessages, 'priorMessages should be set')
    assert.equal(capturedConfigs[0]!.priorMessages!.length, 2, 'should have 2 prior messages')
    assert.equal(capturedConfigs[0]!.priorMessages![0]!.role, 'user')
  })

  it('degrades to fresh worker when resumeWorkOrderId has no saved session', async () => {
    const capturedConfigs: { priorMessages?: readonly OaiMessage[] }[] = []
    const coordinator = makeCoordinator({
      homeDir,
      runWorker: async (config) => {
        capturedConfigs.push({ priorMessages: config.priorMessages })
        return {
          result: makePassedResult('wo_fresh'),
          session: { getMessages: () => [{ role: 'user', content: 'fresh' }], getTurnCount: () => 1 },
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }
      },
    })

    await coordinator.delegate({
      parentTurnId: 'tu_test_fresh',
      objective: 'Search for something entirely new here',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: ['a.ts', 'b.ts'] },
      resumeWorkOrderId: 'wo_nonexistent',
    })

    // priorMessages should NOT be set — degraded to fresh worker
    assert.equal(capturedConfigs.length, 1)
    assert.equal(capturedConfigs[0]!.priorMessages, undefined, 'should start fresh when no saved session')
  })
})

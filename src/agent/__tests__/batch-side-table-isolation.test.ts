/**
 * 回归测试：并发顶层批的批级共享表隔离。
 *
 * 缺陷：两个顶层 delegate_batch（parentTurnId = `${toolUseId}:batch:${i}`）经
 * deriveStableWorkOrderId 只取末两段 → 都派生稳定 order.id 'batch:N'（与
 * toolUseId 无关）。批级共享表 batchPrewarmByOrder / batchStigmergyByOrder
 * 曾以 order.id 为键 → 两批互相覆盖/删除，A 批 worker 拿到 B 批的 prewarm。
 *
 * 修复：批级共享表改以派发唯一的 order.parentTurnId 为键。order.id 的稳定语义
 * （rerun 去重 / fleet 卡片复用）不受影响（见 coordinator-stable-id.test.ts）。
 *
 * 断言：两个并发顶层批的 worker 必须各自拿到本批的 prewarm，不得是同一对象。
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listPersistedResultRounds, loadPersistedResultRound } from '../worker-result-store.js'
import { loadWorkerSession, saveWorkerSession } from '../worker-session-persist.js'
import type { WorkerSessionConfig } from '../worker-session.js'
import { DelegationCoordinator } from '../coordinator.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_ONLY_WORKER_TOOLS, type WorkerResult } from '../work-order.js'
import { profileRegistry } from '../profile-registry.js'
import type { StreamClient } from '../../api/stream-client.js'
import type { ModelCapabilityCard } from '../../model/capability.js'
import type { Tool } from '../../tools/types.js'

function fakeTool(name: string): Tool {
  return {
    definition: { name, description: `${name} tool`, input_schema: { type: 'object', properties: {} } },
    execute: async () => ({ content: `${name} ok` }),
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  for (const name of READ_ONLY_WORKER_TOOLS) registry.register(fakeTool(name))
  for (const pname of profileRegistry.getProfileNames()) {
    for (const tool of profileRegistry.get(pname)!.allowedTools) if (!registry.get(tool)) registry.register(fakeTool(tool))
  }
  return registry
}

const cards: ModelCapabilityCard[] = [{
  model: 'test-model', toolUseReliability: 0.8, jsonStability: 0.8, editSuccessRate: 0.7,
  testRepairRate: 0.6, contextWindow: 128_000, cacheEconomics: 'medium', recommendedTasks: ['code_edit'],
}]

function makeResult(orderId: string): WorkerResult {
  return {
    workOrderId: orderId,
    status: 'passed',
    summary: 'done with enough detail to pass the summary quality gate easily without any expansion round at all, covering findings and changes in one long sentence.',
    findings: [], artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'unverified',
  }
}

function finished(orderId: string) {
  return {
    result: makeResult(orderId),
    transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
    session: { getMessages: () => [], getTurnCount: () => 1 } as never,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }
}

function runtimeFactoryFor(order: import('../work-order.js').WorkOrder, card: ModelCapabilityCard, registry: ToolRegistry) {
  return {
    order, client: {} as StreamClient,
    promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: registry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
    toolRegistry: registry, cwd: '/repo', maxTurns: 2, contextWindow: card.contextWindow,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
  }
}

describe('concurrent top-level batches: batch-scoped side-table isolation', () => {
  let homeDir: string
  let savedHome: string | undefined
  beforeEach(() => { homeDir = mkdtempSync(join(tmpdir(), 'rivet-batchid-')); savedHome = process.env.RIVET_HOME; process.env.RIVET_HOME = homeDir })
  afterEach(() => {
    if (savedHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = savedHome
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('两个并发顶层批的 worker 不得共享同一个 prewarm 对象（跨批污染）', async () => {
    const captures: Array<{ batch: 'AAA' | 'BBB'; parentTurnId: string; prewarm: unknown; stigmergy: unknown }> = []
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })

    const worker = async (config: { order: import('../work-order.js').WorkOrder; prewarm?: unknown; stigmergy?: unknown }) => {
      const ptid = config.order.parentTurnId
      captures.push({ batch: ptid.includes('toolu_AAA') ? 'AAA' : 'BBB', parentTurnId: ptid, prewarm: config.prewarm, stigmergy: config.stigmergy })
      await gate
      return finished(config.order.id)
    }

    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(), modelCards: cards, maxWorkers: 4, maxExploreWorkers: 4, cwd: homeDir,
      runtimeFactory: (order, card, registry) => ({ ...runtimeFactoryFor(order, card, registry), cwd: homeDir }), runWorker: worker,
    })

    // 同批按文件去重：兄弟必须有不同 scope，跨批则保留同一 batch:0/1 id。
    const req = (p: string, o: string) => ({ parentTurnId: p, objective: o, kind: 'code_search' as const, profile: 'code_scout' as const, scope: { files: [p.endsWith(':0') ? 'src/a.ts' : 'src/b.ts'] } })
    const obj = 'search the module implementation details across the whole codebase tree thoroughly'

    // 同步发起两批（各自的 set 在任何 await 前发生）——模拟同一助手回合内并发的
    // 两个 delegate_batch 工具调用。
    const batchA = coordinator.delegateBatch(
      [req('toolu_AAA:batch:0', obj), req('toolu_AAA:batch:1', obj + ' two')], 'primary_decides')
    const batchB = coordinator.delegateBatch(
      [req('toolu_BBB:batch:0', obj + ' three'), req('toolu_BBB:batch:1', obj + ' four')], 'primary_decides')

    const t0 = Date.now()
    while (captures.length < 4 && Date.now() - t0 < 3000) await new Promise(r => setTimeout(r, 10))
    release()
    await Promise.all([batchA, batchB])

    assert.equal(captures.length, 4, `all four workers must run: ${JSON.stringify(captures.map(c => c.parentTurnId))}`)
    for (const key of ['prewarm', 'stigmergy'] as const) {
      const a = captures.filter(c => c.batch === 'AAA').map(c => c[key])
      const b = captures.filter(c => c.batch === 'BBB').map(c => c[key])
      assert.ok(a[0] && b[0], `${key} must actually be injected`)
      assert.equal(a[0], a[1], `${key}: A siblings share`)
      assert.equal(b[0], b[1], `${key}: B siblings share`)
      assert.notEqual(a[0], b[0], `${key}: batches are isolated`)
    }
    const aPrewarms = captures.filter(c => c.batch === 'AAA').map(c => c.prewarm)
    const bPrewarms = captures.filter(c => c.batch === 'BBB').map(c => c.prewarm)
    assert.ok(aPrewarms.length > 0 && bPrewarms.length > 0, `两批都应有 worker 运行：${JSON.stringify(captures.map(c => c.batch))}`)
    const shared = aPrewarms.some(a => a !== undefined && bPrewarms.some(b => a === b))
    assert.equal(shared, false,
      `A 批与 B 批的 worker 拿到了同一个 prewarm 对象（跨批污染）：${JSON.stringify(captures.map(c => ({ batch: c.batch, ptid: c.parentTurnId })))}`)
  })

  it('settling one batch preserves the other batch pending sibling resources', { timeout: 10_000 }, async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const captures = new Map<string, { prewarm?: unknown; stigmergy?: unknown }>()
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(), modelCards: cards, maxWorkers: 4, cwd: homeDir,
      runtimeFactory: (order, card, registry) => ({ ...runtimeFactoryFor(order, card, registry), cwd: homeDir }),
      runWorker: async config => {
        captures.set(config.order.parentTurnId, { prewarm: config.prewarm, stigmergy: config.stigmergy })
        if (config.order.parentTurnId === 'toolu_B:batch:0') await gate
        return finished(config.order.id)
      },
    })
    const req = (batch: string, i: number) => ({
      parentTurnId: `toolu_${batch}:batch:${i}`,
      objective: `Search the implementation and dependencies of module ${i} thoroughly`,
      kind: 'code_search' as const, profile: 'code_scout' as const, scope: { files: [`src/${i}.ts`] },
    })
    const batchA = coordinator.delegateBatch([req('A', 0), req('A', 1)])
    const batchB = coordinator.delegateBatch([req('B', 0), { ...req('B', 1), dependencies: ['batch:0'] }])
    try { await batchA } finally { release() }
    await batchB
    for (const key of ['prewarm', 'stigmergy'] as const) {
      const first = captures.get('toolu_B:batch:0')?.[key]
      assert.ok(first, `${key}: B first worker received its own resource`)
      assert.equal(captures.get('toolu_B:batch:1')?.[key], first, `${key}: A cleanup must preserve pending B sibling`)
    }
  })

  it('dependency-blocked orders release their batch side tables without dispatch', async () => {
    let runs = 0
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(), modelCards: cards, maxWorkers: 2, cwd: homeDir,
      runtimeFactory: runtimeFactoryFor,
      runWorker: async () => { runs++; throw new Error('must not dispatch') },
    })
    const result = await coordinator.delegateBatch([{
      parentTurnId: 'toolu_blocked:batch:0',
      objective: 'Search module dependencies and report implementation entry points thoroughly',
      kind: 'code_search', profile: 'code_scout', scope: { files: ['src/a.ts'] },
      dependencies: ['missing-order'],
    }])
    assert.equal(runs, 0)
    assert.equal(result.results[0]?.status, 'blocked')
    const tables = coordinator as unknown as {
      batchPrewarmByOrder: Map<string, unknown>; batchStigmergyByOrder: Map<string, unknown>
    }
    assert.equal(tables.batchPrewarmByOrder.size, 0)
    assert.equal(tables.batchStigmergyByOrder.size, 0)
  })

  it('dispatch controls, snapshots, callbacks and archives isolate concurrent stable IDs', { timeout: 10_000 }, async () => {
    const captures = new Map<string, WorkerSessionConfig>()
    const releases = new Map<string, () => void>()
    const callbacks: string[] = []
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(), modelCards: cards, maxWorkers: 4, cwd: homeDir,
      runtimeFactory: (order, card, registry) => ({ ...runtimeFactoryFor(order, card, registry), cwd: homeDir }),
      runWorker: async config => {
        const id = config.order.parentTurnId
        captures.set(id, config)
        config.onSessionReady?.(() => [{ role: 'assistant', content: id }])
        await new Promise<void>(resolve => releases.set(id, resolve))
        const run = finished(config.order.id)
        return { ...run, session: { getMessages: () => [{ role: 'assistant' as const, content: id }], getTurnCount: () => 1 } as never }
      },
    })
    const request = (batch: string) => ({ parentTurnId: `toolu_${batch}:batch:0`, kind: 'code_search' as const,
      profile: 'code_scout' as const, objective: `Search implementation dependencies for batch ${batch} thoroughly`,
      scope: { files: ['src/a.ts'] }, onActivity: () => callbacks.push(batch), onNestedActivity: () => callbacks.push(`nested ${batch}`) })
    const a = coordinator.delegateBatch([request('A')])
    const b = coordinator.delegateBatch([request('B')])
    try {
      for (let i = 0; captures.size < 2 && i < 200; i++) await new Promise(r => setTimeout(r, 5))
      assert.equal(captures.size, 2)
      const ca = captures.get('toolu_A:batch:0')!, cb = captures.get('toolu_B:batch:0')!
      assert.notEqual(ca.sessionNonce, cb.sessionNonce)
      assert.equal(coordinator.killWorker('batch:0'), false, 'ambiguous legacy kill must fail closed')
      assert.equal(coordinator.steerWorker('batch:0', 'wrong'), false, 'ambiguous legacy steer must fail closed')
      assert.equal(coordinator.getLiveWorkerMessages('batch:0'), undefined)
      assert.equal(coordinator.isWorkerRunning('batch:0'), true, 'legacy liveness must not report live workers gone')
      assert.equal(coordinator.getLiveWorkerMessages(ca.order.parentTurnId)?.[0]?.content, ca.order.parentTurnId)
      assert.equal(coordinator.getLiveWorkerMessages(cb.order.parentTurnId)?.[0]?.content, cb.order.parentTurnId)
      assert.equal(coordinator.steerWorker(ca.order.parentTurnId, 'only A'), true)
      assert.equal(ca.onSteerDrain?.(), 'only A')
      assert.equal(cb.onSteerDrain?.(), null)
      ca.onActivity?.('text', 'A'); cb.onActivity?.('text', 'B')
      ca.onNestedDelegation?.({ workOrderId: 'childA', parentToolId: 'nestedA', status: 'running' })
      cb.onNestedDelegation?.({ workOrderId: 'childB', parentToolId: 'nestedB', status: 'running' })
      assert.deepEqual(callbacks, ['A', 'B', 'nested A', 'nested B'])
      releases.get(ca.order.parentTurnId)!()
      await a
      assert.equal(coordinator.isWorkerRunning(cb.order.parentTurnId), true, 'A cleanup must preserve B')
      assert.equal(coordinator.steerWorker('batch:0', 'unique B'), true)
      assert.equal(cb.onSteerDrain?.(), 'unique B')
      ca.onSessionReady?.(() => [{ role: 'assistant', content: 'late A' }])
      ca.onActivity?.('text', 'late A')
      assert.deepEqual(callbacks, ['A', 'B', 'nested A', 'nested B'], 'late settled callbacks cannot revive state')
      assert.equal(coordinator.getLiveWorkerMessages(ca.order.parentTurnId), undefined)
      releases.get(cb.order.parentTurnId)!()
      await b
      const rounds = listPersistedResultRounds('batch:0')
      assert.equal(rounds.length, 2)
      for (const config of [ca, cb]) {
        const archived = loadPersistedResultRound('batch:0', config.sessionNonce!) as WorkerResult & { dispatchId?: string }
        assert.equal(archived.dispatchId, config.order.parentTurnId, 'batch aggregate must retain its own nonce')
        assert.equal(loadWorkerSession('batch:0', undefined, config.sessionNonce)?.messages[0]?.content, config.order.parentTurnId)
      }
      const tables = coordinator as unknown as { dispatchOrders: Map<string, unknown>; dispatchNonces: Map<string, unknown> }
      assert.equal(tables.dispatchOrders.size, 0)
      assert.equal(tables.dispatchNonces.size, 0)
    } finally {
      for (const release of releases.values()) release()
      await Promise.allSettled([a, b]); coordinator.shutdown()
    }
  })

  it('exact dispatch kill and heartbeat never affect a concurrent sibling', { timeout: 10_000 }, async () => {
    let clock = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const captures = new Map<string, WorkerSessionConfig>()
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(), modelCards: cards, maxWorkers: 4, cwd: homeDir,
      workerStallMs: 1000, livenessClock: () => clock,
      runtimeFactory: runtimeFactoryFor,
      runWorker: async config => { captures.set(config.order.parentTurnId, config); await gate; return finished(config.order.id) },
    })
    const request = (batch: string) => ({ parentTurnId: `toolu_${batch}:batch:0`, kind: 'code_search' as const,
      profile: 'code_scout' as const, objective: `Search implementation dependencies for batch ${batch} thoroughly`, scope: { files: ['src/a.ts'] } })
    const a = coordinator.delegateBatch([request('A')]), b = coordinator.delegateBatch([request('B')])
    try {
      for (let i = 0; captures.size < 2 && i < 200; i++) await new Promise(r => setTimeout(r, 5))
      assert.equal(captures.size, 2)
      const ca = captures.get('toolu_A:batch:0')!, cb = captures.get('toolu_B:batch:0')!
      clock = 1100
      ca.onActivity?.('text', 'alive')
      const liveness = (coordinator as unknown as { liveness: { stalled(): string[] } }).liveness
      assert.deepEqual(liveness.stalled(), [cb.order.parentTurnId], 'A heartbeat must not keep silent B alive')
      assert.equal(coordinator.killWorker(ca.order.parentTurnId), true)
      assert.equal(ca.abortSignal?.aborted, true)
      assert.equal(cb.abortSignal?.aborted, false, 'kill A must preserve B signal')
      coordinator.shutdown()
      assert.equal(cb.abortSignal?.aborted, true, 'shutdown must reach every concurrent controller')
    } finally { release(); await Promise.allSettled([a, b]); coordinator.shutdown() }
  })


  it('policy cancel-rest aborts its own batch and preserves overlapping siblings', { timeout: 10_000 }, async () => {
    const captures = new Map<string, WorkerSessionConfig>(), releases = new Map<string, () => void>()
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(), modelCards: cards, maxWorkers: 4, maxExploreWorkers: 4, cwd: homeDir,
      runtimeFactory: runtimeFactoryFor,
      runWorker: async config => { captures.set(config.order.parentTurnId, config); await new Promise<void>(resolve => releases.set(config.order.parentTurnId, resolve)); return finished(config.order.id) },
    })
    const req = (batch: string, i: number) => ({ parentTurnId: `toolu_${batch}:batch:${i}`, kind: 'code_search' as const,
      profile: 'code_scout' as const, objective: `Search module ${i} thoroughly for batch ${batch}`, scope: { files: [`src/${i}.ts`] } })
    const a = coordinator.delegateBatch([req('A', 0), req('A', 1)], 'first_success')
    const b = coordinator.delegateBatch([req('B', 0), req('B', 1)], 'primary_decides')
    try {
      for (let i = 0; captures.size < 4 && i < 200; i++) await new Promise(r => setTimeout(r, 5))
      assert.equal(captures.size, 4)
      releases.get('toolu_A:batch:0')!()
      for (let i = 0; !captures.get('toolu_A:batch:1')!.abortSignal?.aborted && i < 200; i++) await new Promise(r => setTimeout(r, 5))
      assert.equal(captures.get('toolu_A:batch:1')!.abortSignal?.aborted, true)
      assert.equal(captures.get('toolu_B:batch:1')!.abortSignal?.aborted, false, 'A policy cannot abort B:batch:1')
      assert.equal(captures.get('toolu_B:batch:0')!.abortSignal?.aborted, false)
    } finally { for (const release of releases.values()) release(); await Promise.allSettled([a, b]); coordinator.shutdown() }
  })


  it('resume state and checkpoints isolate concurrent dispatches of a stable ID', { timeout: 10_000 }, async () => {
    for (const batch of ['A', 'B']) saveWorkerSession(`prior${batch}`, 'code_scout', batch,
      [{ role: 'user', content: batch }], undefined, { partialResult: batch, completedTools: [`read${batch}`], turnIndex: 1 })
    const captures = new Map<string, WorkerSessionConfig>()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(), modelCards: cards, maxWorkers: 4, cwd: homeDir,
      runtimeFactory: runtimeFactoryFor,
      runWorker: async config => { captures.set(config.order.parentTurnId, config); await gate; return finished(config.order.id) },
    })
    const req = (batch: string) => ({ parentTurnId: `toolu_${batch}:batch:0`, kind: 'code_search' as const,
      profile: 'code_scout' as const, objective: `Continue previous module search for ${batch} thoroughly`,
      scope: { files: ['src/a.ts'] }, resumeWorkOrderId: `prior${batch}` })
    const a = coordinator.delegateBatch([req('A')]), b = coordinator.delegateBatch([req('B')])
    try {
      for (let i = 0; captures.size < 2 && i < 200; i++) await new Promise(r => setTimeout(r, 5))
      assert.equal(captures.size, 2)
      for (const batch of ['A', 'B']) {
        const config = captures.get(`toolu_${batch}:batch:0`)!
        assert.equal(config.priorMessages?.[0]?.content, batch)
        assert.equal(config.checkpoint?.partialResult, batch)
      }
    } finally { release(); await Promise.allSettled([a, b]); coordinator.shutdown() }
  })

  it('cross-batch writers sharing a stable ID cannot bypass file reservations', { timeout: 10_000 }, async () => {
    const captures: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(), modelCards: cards, maxWorkers: 4, maxWriteWorkers: 4, cwd: homeDir,
      runtimeFactory: runtimeFactoryFor,
      runHands: async config => { captures.push(config.order.parentTurnId); await gate; return { result: makeResult(config.order.id), usage: {} } },
    })
    const req = (batch: string) => ({ parentTurnId: `toolu_${batch}:batch:0`, kind: 'patch_proposal' as const,
      profile: 'patcher' as const, objective: `Patch shared module implementation for ${batch} thoroughly`, scope: { files: ['src/shared.ts'] } })
    const a = coordinator.delegateBatch([req('A')])
    let b: ReturnType<DelegationCoordinator['delegateBatch']> | undefined
    try {
      for (let i = 0; captures.length < 1 && i < 200; i++) await new Promise(r => setTimeout(r, 5))
      assert.equal(captures.length, 1)
      b = coordinator.delegateBatch([req('B')])
      const result = await Promise.race([b, new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 500))])
      assert.ok(result, 'overlapping writer must be refused before execution')
      assert.equal(result.results[0]?.status, 'blocked')
      assert.match(result.results[0]?.summary ?? '', /Cross-wave file conflict/)
      assert.deepEqual(captures, ['toolu_A:batch:0'])
    } finally { release(); await Promise.allSettled([a, ...(b ? [b] : [])]); coordinator.shutdown() }
  })

})

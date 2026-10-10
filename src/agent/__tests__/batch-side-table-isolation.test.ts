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
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
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
    for (const tool of profileRegistry.get(pname)!.allowedTools) registry.register(fakeTool(tool))
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
  beforeEach(() => { homeDir = mkdtempSync(join('/tmp', 'rivet-batchid-')); savedHome = process.env.HOME; process.env.HOME = homeDir })
  afterEach(() => { process.env.HOME = savedHome })

  it('两个并发顶层批的 worker 不得共享同一个 prewarm 对象（跨批污染）', async () => {
    const captures: Array<{ batch: 'AAA' | 'BBB'; parentTurnId: string; prewarm: unknown }> = []
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })

    const worker = async (config: { order: import('../work-order.js').WorkOrder; prewarm?: unknown }) => {
      const ptid = config.order.parentTurnId
      captures.push({ batch: ptid.includes('toolu_AAA') ? 'AAA' : 'BBB', parentTurnId: ptid, prewarm: config.prewarm })
      await gate
      return {
        result: makeResult(config.order.id),
        transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
        session: { getMessages: () => [], getTurnCount: () => 1 } as never,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }
    }

    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(), modelCards: cards, maxWorkers: 4, cwd: '/repo',
      runtimeFactory: runtimeFactoryFor, runWorker: worker,
    })

    const req = (p: string, o: string) => ({ parentTurnId: p, objective: o, kind: 'code_search' as const, profile: 'code_scout' as const, scope: { files: ['src/a.ts'] } })
    const obj = 'search the module implementation details across the whole codebase tree thoroughly'

    // 同步发起两批（各自的 set 在任何 await 前发生）——模拟同一助手回合内并发的
    // 两个 delegate_batch 工具调用。
    const batchA = coordinator.delegateBatch(
      [req('toolu_AAA:batch:0', obj), req('toolu_AAA:batch:1', obj + ' two')], 'primary_decides')
    const batchB = coordinator.delegateBatch(
      [req('toolu_BBB:batch:0', obj + ' three'), req('toolu_BBB:batch:1', obj + ' four')], 'primary_decides')

    const t0 = Date.now()
    while (captures.length < 2 && Date.now() - t0 < 3000) await new Promise(r => setTimeout(r, 10))
    release()
    await Promise.all([batchA, batchB])

    const aPrewarms = captures.filter(c => c.batch === 'AAA').map(c => c.prewarm)
    const bPrewarms = captures.filter(c => c.batch === 'BBB').map(c => c.prewarm)
    assert.ok(aPrewarms.length > 0 && bPrewarms.length > 0, `两批都应有 worker 运行：${JSON.stringify(captures.map(c => c.batch))}`)
    const shared = aPrewarms.some(a => a !== undefined && bPrewarms.some(b => a === b))
    assert.equal(shared, false,
      `A 批与 B 批的 worker 拿到了同一个 prewarm 对象（跨批污染）：${JSON.stringify(captures.map(c => ({ batch: c.batch, ptid: c.parentTurnId })))}`)
  })
})

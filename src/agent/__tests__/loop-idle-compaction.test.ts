import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_FILE_TOOL } from '../../tools/read-file.js'
import { PromptEngine } from '../../prompt/engine.js'
import type { StreamClient } from '../../api/stream-client.js'

const CWD = mkdtempSync(join(tmpdir(), 'rivet-idle-'))

function makeAgent(compactEnabled: boolean): AgentLoop {
  const session = new SessionContext()
  const registry = new ToolRegistry()
  registry.register(READ_FILE_TOOL)
  const client = { stream: async () => {} } as unknown as StreamClient
  const engine = new PromptEngine({ model: 'deepseek-v4-pro', maxTokens: 1024, staticCtx: { tools: [READ_FILE_TOOL.definition] }, volatileCtx: { cwd: CWD } })
  return new AgentLoop({
    client,
    promptEngine: engine,
    toolRegistry: registry,
    maxTurns: 5,
    contextWindow: 1_000_000,
    compact: { enabled: compactEnabled, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
  }, session, CWD)
}

function mockCoordinator(agent: AgentLoop) {
  const fn = mock.fn(async () => ({ compacted: false, shouldAbort: false, userMessageConsumed: false }))
  agent.compactBoundaryCoordinator.runCompaction = fn as never
  return fn
}

describe('AgentLoop idle compaction', () => {
  it('runs a turn-0 (turn=0, snap=null) pass when there is deferred pending work', async () => {
    const agent = makeAgent(true)
    const fn = mockCoordinator(agent)
    agent.pendingStaleCompact = true

    await agent.runIdleCompaction()

    assert.equal(fn.mock.callCount(), 1, 'coordinator.runCompaction must be called')
    assert.deepEqual(fn.mock.calls[0]!.arguments, [0, null], 'must run at turn=0 with null snapshot')
  })

  it('skips when there is no pending work and pressure is low', async () => {
    const agent = makeAgent(true)
    const fn = mockCoordinator(agent)
    // fresh session → ratio ≈ 0, no pending flags
    await agent.runIdleCompaction()
    assert.equal(fn.mock.callCount(), 0, 'must skip at low fill with no deferred work')
  })

  it('55% fill（旧 0.5 门槛以上、compact 档以下）不再触发闲时压缩——上下文原样保留', async () => {
    const agent = makeAgent(true)
    const fn = mockCoordinator(agent)
    // 无 providerProfile → balanced 策略 → compact 档 0.78
    agent.session.getEstimatedTokens = () => 550_000 // ratio 0.55 / 1M window
    await agent.runIdleCompaction()
    assert.equal(fn.mock.callCount(), 0,
      '50–78% 区间的渐进降压必须留给用户边界，闲时不得主动重写历史')
  })

  it('ratio ≥ compact 档（balanced 0.78）时闲时压缩照跑——重压缩时间挪移', async () => {
    const agent = makeAgent(true)
    const fn = mockCoordinator(agent)
    agent.session.getEstimatedTokens = () => 800_000 // ratio 0.80
    await agent.runIdleCompaction()
    assert.equal(fn.mock.callCount(), 1, '下一轮反正要做的重压缩应在闲时提前完成')
    assert.deepEqual(fn.mock.calls[0]!.arguments, [0, null])
  })

  it('pending 递延债在低 ratio 下照样清算（债清算路径不受门槛提升影响）', async () => {
    const agent = makeAgent(true)
    const fn = mockCoordinator(agent)
    agent.session.getEstimatedTokens = () => 100_000 // ratio 0.10
    agent.pendingHeapCompact = true
    await agent.runIdleCompaction()
    assert.equal(fn.mock.callCount(), 1, 'mid-turn 递延的压缩债必须在闲时清算')
  })

  it('RIVET_IDLE_COMPACTION_RATIO 覆盖生效门槛', async () => {
    const prev = process.env['RIVET_IDLE_COMPACTION_RATIO']
    process.env['RIVET_IDLE_COMPACTION_RATIO'] = '0.4'
    try {
      const agent = makeAgent(true)
      const fn = mockCoordinator(agent)
      agent.session.getEstimatedTokens = () => 550_000 // ratio 0.55 ≥ 覆盖值 0.4
      await agent.runIdleCompaction()
      assert.equal(fn.mock.callCount(), 1, 'env 覆盖后 0.55 应触发')
    } finally {
      if (prev === undefined) delete process.env['RIVET_IDLE_COMPACTION_RATIO']
      else process.env['RIVET_IDLE_COMPACTION_RATIO'] = prev
    }
  })

  it('is a no-op when discretionary compaction is disabled', async () => {
    const agent = makeAgent(false)
    const fn = mockCoordinator(agent)
    agent.pendingStaleCompact = true
    await agent.runIdleCompaction()
    assert.equal(fn.mock.callCount(), 0, 'disabled compaction must not run idle passes')
  })

  it('cancelIdleCompaction aborts an in-flight pass and resolves after it settles', async () => {
    const agent = makeAgent(true)
    agent.pendingHeapCompact = true
    let observedSignal: AbortSignal | undefined
    let release: () => void
    const gate = new Promise<void>((r) => { release = r })
    agent.compactBoundaryCoordinator.runCompaction = (async () => {
      observedSignal = agent.abortController?.signal
      await gate
      return { compacted: false, shouldAbort: false, userMessageConsumed: false }
    }) as never

    const inflight = agent.runIdleCompaction()
    // let the async body start and capture the signal
    await Promise.resolve()
    await Promise.resolve()

    const cancel = agent.cancelIdleCompaction()
    assert.equal(observedSignal?.aborted, true, 'idle abort signal must be aborted by cancel')
    release!()
    await cancel
    await inflight
  })
})

describe('native request budgeting owns compaction', () => {
  it('idle time and legacy stale debt do not rewrite a native hot prefix', async () => {
    const agent = makeAgent(true)
    mock.method(agent.config.promptEngine, 'getRequestBudgetPolicy', () => ({ windowTokens: 1_000_000, maxOutputTokens: 393_216 }))
    const fn = mockCoordinator(agent)
    agent.pendingStaleCompact = true
    agent.session.getEstimatedTokens = () => 950_000
    await agent.runIdleCompaction()
    assert.equal(fn.mock.callCount(), 0)
  })
})


describe('AgentLoop manual context compaction for self-hosted models', () => {
  it('accepts a configured context window without an official-provider policy', async () => {
    const agent = makeAgent(false)
    const compact = mock.method(agent, 'compactContextBudget', async (_force = false) => true)
    const refresh = mock.method(agent.requestContext, 'refreshSnapshot', () => {})
    assert.equal(agent.config.promptEngine.getRequestBudgetPolicy(), undefined)

    assert.equal(await agent.compactContext(), true)

    assert.deepEqual(compact.mock.calls[0]!.arguments, [true])
    assert.equal(refresh.mock.callCount(), 1)
    assert.equal(agent.abortController, null, 'manual compaction must release the running state')
    assert.equal(await agent.compactContext(), true, 'a second manual attempt is not locked out')
  })

  it('rejects an unknown context window with an actionable configuration error', async () => {
    const agent = makeAgent(false)
    agent.config.contextWindow = Number.NaN
    const compact = mock.method(agent, 'compactContextBudget', async () => true)
    await assert.rejects(agent.compactContext(), /contextWindow/)
    assert.equal(compact.mock.callCount(), 0)
  })
})

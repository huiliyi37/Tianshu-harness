import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRouter } from '../index.js'
import { buildSessionRoutes } from '../session-routes.js'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import type { DelegationActivity } from '../../tools/types.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'
import type { Config } from '../../config/schema.js'

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

class FakeAgent implements ManagedAgent {
  callbacks?: AgentCallbacks
  artifacts: Artifact[] = []
  runPrompts: string[] = []
  run(_p: string, cb: AgentCallbacks) { this.callbacks = cb; return Promise.resolve() }
  abort() {}
  setActivePlan(_plan: { slug: string; title: string } | null) {}
  listArtifacts() { return this.artifacts }
  readArtifact(id: string) { return Promise.resolve(this.artifacts.some((a) => a.id === id) ? `raw:${id}` : null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_msgs: OaiMessage[]): void {}
  rewindToMessages(_msgs: OaiMessage[]): void {}
}

const config: Config = {
  provider: {
    default: 'deepseek',
    providers: {
      deepseek: {
        name: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        models: [
          {
            id: 'deepseek-v4-pro',
            alias: 'v4-pro',
            contextWindow: 1_000_000,
            maxTokens: 384_000,
            pricing: { input: 1.0, output: 4.0, cacheRead: 0.1, cacheWrite: 1.0 },
          },
        ],
      },
    },
  },
} as unknown as Config

function setup(now?: () => number) {
  const agents: FakeAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => { const a = new FakeAgent(); agents.push(a); return a },
    defaultCwd: '/tmp/work',
    now,
  })
  const router = createRouter(buildSessionRoutes(manager, TOKEN, undefined, config))
  return { manager, agents, router }
}

test('GET /sessions/:id/insights aggregates delegation usage and cost', async () => {
  const { agents, router } = setup()
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id

  const agent = agents[0]
  assert.ok(agent?.callbacks)

  // Simulate main session turns.
  // ⚠ 形状即契约：wire 上的 usage 是 `session.getTotalUsage()` 的**累计快照**，
  // 第二条必须 ≥ 第一条（真实会话实测 input 单调递增）。旧 fixture 写的是
  // 「500k → 300k」这种累计量不可能出现的递减形状——它把「求和」这一错误口径
  // 固化成了期望值（求和把长会话放大 19×：62,685,972 vs 权威账本 3,325,173）。
  agent.callbacks!.onTurnComplete!({ input_tokens: 500_000, output_tokens: 200_000, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 50_000 }, 1, false)
  agent.callbacks!.onTurnComplete!({ input_tokens: 800_000, output_tokens: 300_000, cache_read_input_tokens: 600_000, cache_creation_input_tokens: 80_000 }, 2, true)

  agent.callbacks!.onDelegationActivity!({
    workOrderId: 'wo-1',
    parentToolId: 'tool-1',
    profile: 'scout',
    status: 'completed',
    model: 'deepseek-v4-pro',
    provider: 'deepseek',
    usage: {
      input_tokens: 1_000_000,
      output_tokens: 500_000,
      cache_read_input_tokens: 800_000,
      cache_creation_input_tokens: 100_000,
      total_tokens: 1_500_000,
    },
  })

  const res = await router('GET', `/sessions/${id}/insights`, {}, AUTH)
  assert.equal(res.status, 200)
  const body = res.body as {
    totals: { workers: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number; cost: number }
    cacheHitRate: number
    mainSession: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number; model?: string; cost: number } | null
    workers: Array<{ workerId: string; cost: number; totalTokens: number }>
    modelBreakdown: Array<{ model: string; cost: number; count: number }>
  }

  // Worker assertions
  assert.equal(body.totals.workers, 1)
  assert.equal(body.workers.length, 1)
  assert.equal(body.workers[0]!.workerId, 'wo-1')
  assert.ok(body.workers[0]!.cost > 0)
  assert.equal(body.modelBreakdown.length, 1)
  assert.equal(body.modelBreakdown[0]!.model, 'deepseek-v4-pro')

  // Main session assertions
  assert.ok(body.mainSession)
  assert.equal(body.mainSession!.inputTokens, 800_000)
  assert.equal(body.mainSession!.outputTokens, 300_000)
  assert.equal(body.mainSession!.cacheReadTokens, 600_000)
  assert.equal(body.mainSession!.cacheWriteTokens, 80_000)
  assert.equal(body.mainSession!.totalTokens, 1_100_000)

  // Totals include main session + worker
  assert.equal(body.totals.inputTokens, 800_000 + 1_000_000)
  assert.equal(body.totals.outputTokens, 300_000 + 500_000)
  assert.equal(body.totals.cacheReadTokens, 600_000 + 800_000)
  assert.equal(body.totals.cacheWriteTokens, 80_000 + 100_000)
  assert.equal(body.totals.totalTokens, 1_100_000 + 1_500_000)
  // 命中率分母是 cache-inclusive input（内核 getCacheHitRate 口径）——
  // 1.4M / 1.8M ≈ 78%，不是 read/(read+write) 的 89%。
  assert.equal(body.cacheHitRate, 78)
})

test('insights 命中率分母是 cache-inclusive input —— cacheCreation 缺报时不退化成 100%', async () => {
  // 2026-10-03：/insights 的 cacheHitRate 曾用 read/(read+write)，在 provider
  // 不上报 cache_creation（Codex/Responses 硬编码 0）时 read/(read+0) 恒等于 100%。
  // 分母改为 cache-inclusive input（与内核 getCacheHitRate、cache 面板 hitRate 同口径）。
  const { agents, router } = setup()
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id
  const agent = agents[0]
  assert.ok(agent?.callbacks)

  // 命中 300k、未命中 700k，但 provider 不报 cache_creation（=0）
  agent.callbacks!.onTurnComplete!({ input_tokens: 1_000_000, output_tokens: 10_000, cache_read_input_tokens: 300_000 }, 1, true)

  const res = await router('GET', `/sessions/${id}/insights`, {}, AUTH)
  assert.equal(res.status, 200)
  const body = res.body as { cacheHitRate: number | null }
  assert.equal(body.cacheHitRate, 30, 'read/(read+write) 会退化成 100%')
})

test('GET /sessions/:id/insights returns 404 for unknown session', async () => {
  const { router } = setup()
  const res = await router('GET', '/sessions/nope/insights', {}, AUTH)
  assert.equal(res.status, 404)
})

test('worker failure with unobserved usage is explicitly unknown, not a free request', async () => {
  const { agents, router } = setup()
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id
  agents[0]!.callbacks!.onDelegationActivity?.({ workOrderId: 'unknown-worker', parentToolId: 'tool', profile: 'code_scout', status: 'failed', terminalFailure: true, usageKnown: false, model: 'deepseek-v4-pro', provider: 'deepseek' })
  const response = await router('GET', `/sessions/${id}/insights`, {}, AUTH)
  const body = response.body as { workers: Array<{ costKnown: boolean }>; totals: { costKnown: boolean } }
  assert.equal(body.workers[0]?.costKnown, false)
  assert.equal(body.totals.costKnown, false)
})

for (const withWorker of [false, true]) test(`unpriced main usage keeps its cash figure but makes the complete total unknown (worker=${withWorker})`, async () => {
  const { agents, router } = setup()
  const created = await router('POST', '/sessions', { prompt: 'go', model: 'unpriced-main' }, AUTH)
  assert.equal(created.status, 201)
  const id = (created.body as { id: string }).id
  const callbacks = agents[0]!.callbacks!
  callbacks.onTurnComplete!({ input_tokens: 1_000_000, output_tokens: 1000 }, 1, true)
  if (withWorker) callbacks.onDelegationActivity!({ workOrderId: 'priced-worker', parentToolId: 'tool', profile: 'scout', status: 'completed', model: 'deepseek-v4-pro', provider: 'deepseek', usage: { input_tokens: 1000, output_tokens: 10 } })
  const body = (await router('GET', `/sessions/${id}/insights`, {}, AUTH)).body as { mainSession: { cost: number; costKnown: boolean }; totals: { cost: number; costKnown: boolean }; workers: Array<{ cost: number; costKnown: boolean }> }
  assert.equal(body.totals.costKnown, false, 'known workers cannot make an unpriced main session fully known')
  assert.equal(body.mainSession.costKnown, false)
  assert.equal(body.mainSession.cost, 0)
  if (withWorker) {
    assert.equal(body.workers[0]!.costKnown, true)
    assert.ok(Number.isFinite(body.workers[0]!.cost) && body.workers[0]!.cost > 0)
    assert.equal(body.totals.cost, body.workers[0]!.cost, 'preserve the known subtotal, do not fabricate extra charges')
  } else assert.equal(body.totals.cost, 0)
})

test('request-ledger certainty follows the preferred rows without changing their numeric subtotal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'insights-certainty-'))
  const previous = process.env.RIVET_SESSION_DIR
  try {
    process.env.RIVET_SESSION_DIR = root
    const { agents, router } = setup()
    const created = await router('POST', '/sessions', { prompt: 'go', model: 'unpriced-main' }, AUTH)
    const id = (created.body as { id: string }).id
    agents[0]!.callbacks!.onTurnComplete!({ input_tokens: 1000, output_tokens: 10 }, 1, true)
    mkdirSync(join(root, id), { recursive: true })
    const ledger = join(root, id, 'cache-log.jsonl')
    const priced = { t: Date.parse('2026-10-01T01:00:00Z'), model: 'deepseek-flash', provider: 'deepseek', input: 1000, output: 10, cacheRead: 0, cacheCreate: 0 }
    const read = async () => (await router('GET', `/sessions/${id}/insights`, {}, AUTH)).body as { mainSession: { cost: number; costKnown: boolean }; totals: { cost: number; costKnown: boolean } }
    writeFileSync(ledger, JSON.stringify(priced))
    const known = await read()
    assert.equal(known.mainSession.costKnown, true, 'the exact priced ledger supersedes an unpriced snapshot estimate')
    assert.equal(known.totals.costKnown, true)
    assert.ok(Number.isFinite(known.mainSession.cost) && known.mainSession.cost > 0)
    writeFileSync(ledger, [priced, { ...priced, model: 'unpriced-ledger', provider: 'account-provider' }].map(row => JSON.stringify(row)).join('\n'))
    const mixed = await read()
    assert.equal(mixed.mainSession.costKnown, false)
    assert.equal(mixed.totals.costKnown, false)
    assert.equal(mixed.mainSession.cost, known.mainSession.cost)
    assert.equal(mixed.totals.cost, known.totals.cost)
  } finally {
    if (previous === undefined) delete process.env.RIVET_SESSION_DIR
    else process.env.RIVET_SESSION_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
})

test('insights: 累计快照口径 — 不求和（同一 worker 重复上报也只记一次）', async () => {
  // 2026-09-23：main session 的 usage 与 worker 的 usage 都是**累计快照**。
  // 求和 = 把同一批 token 按事件数记 N 次；实测真实会话放大 19×
  // （求和 62,685,972 vs 末值 3,327,234，而 meta.tokenUsage.prompt = 3,325,173
  // 与 cache-log 主请求累计逐字节吻合）。本用例把「末值而非和」钉死。
  const { agents, router } = setup()
  const created = await router('POST', '/sessions', { prompt: 'go' }, AUTH)
  const id = (created.body as { id: string }).id
  const agent = agents[0]
  assert.ok(agent?.callbacks)

  // 三次累计快照（单调递增，真实 wire 形状）
  agent.callbacks!.onTurnComplete!({ input_tokens: 100_000, output_tokens: 10_000, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 20_000 }, 1, false)
  agent.callbacks!.onTurnComplete!({ input_tokens: 250_000, output_tokens: 25_000, cache_read_input_tokens: 210_000, cache_creation_input_tokens: 40_000 }, 2, false)
  agent.callbacks!.onTurnComplete!({ input_tokens: 400_000, output_tokens: 40_000, cache_read_input_tokens: 350_000, cache_creation_input_tokens: 50_000 }, 3, true)

  // 同一 worker 上报两次累计快照（中间态 + 终态）
  const workerUsage = (input: number, out: number): DelegationActivity => ({
    workOrderId: 'wo-dup', parentToolId: 'tool-dup', profile: 'scout', status: 'running',
    model: 'deepseek-v4-pro', provider: 'deepseek',
    usage: { input_tokens: input, output_tokens: out, cache_read_input_tokens: input - 10_000, cache_creation_input_tokens: 10_000 },
  })
  agent.callbacks!.onDelegationActivity!(workerUsage(60_000, 6_000))
  agent.callbacks!.onDelegationActivity!({ ...workerUsage(90_000, 9_000), status: 'completed' })

  const res = await router('GET', `/sessions/${id}/insights`, {}, AUTH)
  assert.equal(res.status, 200)
  const body = res.body as {
    mainSession: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
    totals: { inputTokens: number; cacheReadTokens: number }
    workers: Array<{ workerId: string; inputTokens: number; cacheReadTokens: number; status?: string }>
  }

  // 主会话：末值（400k），不是 750k
  assert.equal(body.mainSession.inputTokens, 400_000, '累计快照不得求和')
  assert.equal(body.mainSession.outputTokens, 40_000)
  assert.equal(body.mainSession.cacheReadTokens, 350_000)
  assert.equal(body.mainSession.cacheWriteTokens, 50_000)

  // worker：末值（90k），不是 150k；终态字段不被中间态覆盖
  const w = body.workers.find((x) => x.workerId === 'wo-dup')
  assert.ok(w)
  assert.equal(w!.inputTokens, 90_000, '同一 worker 的重复累计快照只记末值')
  assert.equal(w!.cacheReadTokens, 80_000)
  assert.equal(w!.status, 'completed')

  // 合计 = 主会话末值 + worker 末值
  assert.equal(body.totals.inputTokens, 400_000 + 90_000)
  assert.equal(body.totals.cacheReadTokens, 350_000 + 80_000)
})


test('insights costs cumulative deltas at event time, then prefers the exact request ledger', async () => {
  const root = mkdtempSync(join(tmpdir(), 'insights-pricing-'))
  const previous = process.env.RIVET_SESSION_DIR
  let now = Date.parse('2026-09-28T01:00:00Z')
  try {
    process.env.RIVET_SESSION_DIR = root
    const { agents, router } = setup(() => now)
    const created = await router('POST', '/sessions', { prompt: 'go', model: 'deepseek-v4-pro' }, AUTH)
    const id = (created.body as { id: string }).id
    const cb = agents[0]!.callbacks!
    const usage = (n: number) => ({ input_tokens: n * 1e6, output_tokens: n * .5e6, cache_read_input_tokens: n * .8e6, cache_creation_input_tokens: n * .2e6, reasoning_tokens: n * .4e6 })
    cb.onTurnComplete!(usage(1), 1, false)
    cb.onDelegationActivity!({ workOrderId: 'fixture', parentToolId: 'tool', profile: 'scout', status: 'running', model: 'deepseek-v4-pro', provider: 'deepseek', usage: usage(1) })
    now = Date.parse('2026-09-28T04:00:00Z')
    cb.onTurnComplete!(usage(2), 2, true)
    cb.onDelegationActivity!({ workOrderId: 'fixture', parentToolId: 'tool', profile: 'scout', status: 'completed', usage: usage(2) })
    cb.onDelegationActivity!({ workOrderId: 'fixture', parentToolId: 'tool', profile: 'scout', status: 'completed', usage: usage(2) })
    const read = async () => (await router('GET', `/sessions/${id}/insights`, {}, AUTH)).body as { mainSession: { cost: number }; workers: Array<{ cost: number }>; totals: { cost: number } }
    let body = await read()
    // peak=.24+1.8+13.5=15.54; idle=7.77. Reasoning is a subset of output.
    assert.ok(Math.abs(body.mainSession.cost - 23.31) < 1e-9)
    assert.ok(Math.abs(body.workers[0]!.cost - 23.31) < 1e-9)
    assert.ok(Math.abs(body.totals.cost - 46.62) < 1e-9)
    mkdirSync(join(root, id), { recursive: true })
    writeFileSync(join(root, id, 'cache-log.jsonl'), [
      { t: Date.parse('2026-10-01T01:00:00Z'), model: 'deepseek-flash', provider: 'deepseek', input: 1e6, output: .5e6, cacheRead: .8e6, cacheCreate: .2e6 },
      { event: 'side_path', t: Date.parse('2026-09-28T01:00:00Z'), model: 'deepseek-flash', provider: 'deepseek', input: 1e6, output: 0, cacheRead: 0, cacheCreate: 0 },
    ].map(row => JSON.stringify(row)).join('\n'))
    body = await read()
    assert.ok(Math.abs(body.mainSession.cost - 4.216) < 1e-9, 'actual request model/time overrides session model and completion time')
  } finally {
    if (previous === undefined) delete process.env.RIVET_SESSION_DIR
    else process.env.RIVET_SESSION_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
})

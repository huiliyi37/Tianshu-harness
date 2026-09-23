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

function setup() {
  const agents: FakeAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => { const a = new FakeAgent(); agents.push(a); return a },
    defaultCwd: '/tmp/work',
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
  assert.equal(body.cacheHitRate, 89)
})

test('GET /sessions/:id/insights returns 404 for unknown session', async () => {
  const { router } = setup()
  const res = await router('GET', '/sessions/nope/insights', {}, AUTH)
  assert.equal(res.status, 404)
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

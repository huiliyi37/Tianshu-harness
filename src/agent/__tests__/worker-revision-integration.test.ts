/**
 * 证据打回复核的接线证明。
 *
 * 判据在 `worker-revision.test.ts` 里穷举过；这里证明扳机接上了：只读 worker 报了
 * 一份「宣称 verified 但一次验证工具都没跑」的结果 → coordinator 不再只是默默降级
 * 交回，而是带着上一轮对话打回一轮，要求它要么复现要么撤回。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'
import type { OaiChatRequest } from '../../api/oai-types.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import type { Tool, ToolCallParams } from '../../tools/types.js'
import { DelegationCoordinator } from '../coordinator.js'
import { runWorkerSession } from '../worker-session.js'
import type { ModelCapabilityCard } from '../../model/capability.js'
import { READ_ONLY_WORKER_TOOLS } from '../work-order.js'
import { profileRegistry } from '../profile-registry.js'

const cards: ModelCapabilityCard[] = [{
  model: 'test-model',
  toolUseReliability: 0.8,
  jsonStability: 0.9,
  editSuccessRate: 0.7,
  testRepairRate: 0.6,
  contextWindow: 128_000,
  cacheEconomics: 'strong',
  recommendedTasks: ['repo_summarization'],
}]

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

const FINDING = { claim: '接缝在 overlay.ts', evidence: 'src/tui/format/overlay.ts:733', confidence: 'high' as const }

/** 首轮：宣称跑过验证、全绿，但一次验证工具都没调。 */
const UNPROVEN_REPORT = JSON.stringify({
  workOrderId: 'wo',
  status: 'passed',
  summary: '定位到路由接缝并顺手核了一遍，typecheck 干净、所有测试通过，改动可以直接合入。这段摘要写得足够长，避开 summary 扩写门的追问，好让这条用例只测证据打回这一件事，不被别的补偿逻辑干扰判断。',
  findings: [FINDING],
  artifacts: [],
  changedFiles: [],
  examinedFiles: ['src/tui/format/overlay.ts'],
  risks: [],
  nextActions: [],
  evidenceStatus: 'verified',
})

/** 复核轮：撤回宣称，findings 原样保留。 */
const RETRACTED_REPORT = JSON.stringify({
  workOrderId: 'wo',
  status: 'passed',
  summary: '撤回上一轮的验证宣称：我没有真的跑过测试，只做了静态阅读。findings 里的接缝定位依然成立，但「全绿」这个结论没有证据支撑，按未验证交回，请主控自行决定是否补一轮验证。这段摘要同样写长以避开扩写门。',
  findings: [FINDING],
  artifacts: [],
  changedFiles: [],
  examinedFiles: ['src/tui/format/overlay.ts'],
  risks: [],
  nextActions: [],
  evidenceStatus: 'unverified',
})

interface Trace {
  userMessages: string[]
}

function unprovenThenRetractClient(trace: Trace): StreamClient {
  return {
    stream: async (request: OaiChatRequest, callbacks: StreamCallbacks) => {
      const lastUser = [...request.messages].reverse().find(m => m.role === 'user')
      const text = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '')
      trace.userMessages.push(text)

      const isRevision = request.messages.some(m => {
        const c = typeof m.content === 'string' ? m.content : ''
        return c.includes('没通过证据闸门')
      })
      const report = isRevision ? RETRACTED_REPORT : UNPROVEN_REPORT
      callbacks.onTextDelta(report)
      callbacks.onContentBlock({ type: 'text', text: report })
      callbacks.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
    },
  }
}

describe('证据不达标打回复核（接线）', () => {
  it('宣称 verified 却无执行痕迹 → 打回一轮，撤回后的报告成为最终结果', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'rivet-revision-'))
    const trace: Trace = { userMessages: [] }
    try {
      const coordinator = new DelegationCoordinator({
        baseToolRegistry: makeRegistry(),
        modelCards: cards,
        maxWorkers: 1,
        runtimeFactory: (order, _card, workerRegistry) => ({
          order,
          client: unprovenThenRetractClient(trace),
          promptEngine: new PromptEngine({
            model: 'test-model',
            maxTokens: 1024,
            staticCtx: { tools: workerRegistry.getDefinitions(), audience: 'subagent' },
            volatileCtx: { cwd: tmp },
          }),
          toolRegistry: workerRegistry,
          cwd: tmp,
          maxTurns: 4,
          contextWindow: 128_000,
          compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        }),
        runWorker: runWorkerSession,
      })

      const run = await coordinator.delegate({
        parentTurnId: 'turn-revision',
        objective: 'Locate the fleet row renderer and its width fallback path',
        kind: 'code_search',
        profile: 'code_scout',
        scope: { files: ['src/tui/format/overlay.ts'] },
        authority: 'tianji',
      })

      const result = run.results[0]
      assert.ok(result, '应当有一个 worker 结果')
      assert.ok(
        trace.userMessages.some(m => m.includes('没通过证据闸门')),
        `复核轮应当带着打回的 objective 出场，实际：${JSON.stringify(trace.userMessages.map(m => m.slice(0, 40)))}`,
      )
      assert.ok(
        trace.userMessages.some(m => m.includes('二选一')),
        '打回 objective 应当给出「复现或撤回」的二选一',
      )
      assert.ok(
        result.risks.some(r => r.includes('evidence-revision')),
        `复核应在 risks 上留痕，实际：${JSON.stringify(result.risks)}`,
      )
      assert.ok(
        !result.risks.some(r => r.includes('budget-continuation')),
        '复核不该被记成续跑——主控要能分清是哪一种再跑',
      )
      assert.match(result.summary, /撤回/, '复核轮撤回后的报告应当成为最终结果')
      assert.equal(result.findings.length, 1, '复核不以丢失既有发现为代价')
    } finally {
      // Windows：句柄释放竞态（EPERM）——异步重试等待期间推进事件循环。
      await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
})

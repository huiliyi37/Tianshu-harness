/**
 * 自动续跑的接线证明。
 *
 * 决策判据在 `worker-continuation.test.ts` 里穷举过；这里证明扳机真的接上了：
 * 一个只读 worker 用尽轮次预算 → coordinator 不再把 blocked 报告直接交回主控，
 * 而是带着上一轮完整对话再跑一轮，并在结果上留痕。
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

const FINAL_REPORT = JSON.stringify({
  workOrderId: 'wo',
  status: 'passed',
  // 必须真的 ≥200 字符才能避开 summary 扩写门——此前版本只有 ~60 字，扩写门
  // 会多跑一轮（多一次 finalize），把 lifecycle 计数顶超。
  summary: '续跑轮盘点了上一轮进度后补齐剩余部分，产出终局报告：渲染回落路径定位在 overlay.ts 的 fleet 行渲染器，宽度兜底走 displayWidth 分支；已核对调用点与测试锚点，无文件改动，遗留风险是窄终端下省略号截断与候选行高估算的耦合，建议后续用真实会话回放验证。内容足够长以避开 summary 扩写门的追问，不要在这里再触发一轮扩写。',
  findings: [{ claim: '路由接缝在 overlay.ts', evidence: 'src/tui/format/overlay.ts:733', confidence: 'high' }],
  artifacts: [],
  changedFiles: [],
  examinedFiles: ['src/tui/format/overlay.ts'],
  risks: [],
  nextActions: [],
  evidenceStatus: 'unverified',
})

interface Trace {
  /** 每次 stream 调用看到的最后一条 user 消息。 */
  lastUserMessages: string[]
}

/** 首轮每回合都发工具调用（永远不产出终局 JSON）→ 撞满轮次预算。
 *  续跑轮的 user 消息带「续跑」字样，此时才交出报告。 */
function exhaustThenFinishClient(trace: Trace): StreamClient {
  return {
    stream: async (request: OaiChatRequest, callbacks: StreamCallbacks) => {
      const lastUser = [...request.messages].reverse().find(m => m.role === 'user')
      const text = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '')
      trace.lastUserMessages.push(text)

      const isContinuation = request.messages.some(m => {
        const c = typeof m.content === 'string' ? m.content : ''
        return c.includes('继续未完成的任务')
      })
      if (isContinuation) {
        callbacks.onTextDelta(FINAL_REPORT)
        callbacks.onContentBlock({ type: 'text', text: FINAL_REPORT })
        callbacks.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
        return
      }
      callbacks.onContentBlock({
        type: 'tool_use',
        id: `tu_${trace.lastUserMessages.length}`,
        name: 'grep',
        input: { pattern: 'still searching' },
      })
      callbacks.onStopReason('tool_use', { input_tokens: 10, output_tokens: 5 })
    },
  }
}

describe('预算耗尽自动续跑（接线）', () => {
  it('只读 worker 撞满轮次预算后自动续跑，并在结果上留痕', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'rivet-continuation-'))
    const trace: Trace = { lastUserMessages: [] }
    try {
      const coordinator = new DelegationCoordinator({
        baseToolRegistry: makeRegistry(),
        modelCards: cards,
        maxWorkers: 1,
        runtimeFactory: (order, _card, workerRegistry) => ({
          order,
          client: exhaustThenFinishClient(trace),
          promptEngine: new PromptEngine({
            model: 'test-model',
            maxTokens: 1024,
            staticCtx: { tools: workerRegistry.getDefinitions(), audience: 'subagent' },
            volatileCtx: { cwd: tmp },
          }),
          toolRegistry: workerRegistry,
          cwd: tmp,
          // 2 轮就撞顶——首轮必然 max_turns。
          maxTurns: 2,
          contextWindow: 128_000,
          compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        }),
        runWorker: runWorkerSession,
      })

      const activity: Array<{ kind: string; detail?: string }> = []
      const run = await coordinator.delegate({
        parentTurnId: 'turn-continuation',
        objective: 'Locate the fleet row renderer and its width fallback path',
        kind: 'code_search',
        profile: 'code_scout',
        scope: { files: ['src/tui/format/overlay.ts'] },
        authority: 'tianji',
        onActivity: (e) => activity.push({ kind: e.kind, detail: e.detail }),
      })

      const result = run.results[0]
      assert.ok(result, '应当有一个 worker 结果')
      assert.equal(result.status, 'passed', '续跑轮产出的终局报告应当成为最终结果')
      assert.ok(
        result.risks.some(r => r.includes('budget-continuation')),
        `续跑应在 risks 上留痕，实际：${JSON.stringify(result.risks)}`,
      )
      assert.ok(
        trace.lastUserMessages.some(m => m.includes('继续未完成的任务')),
        '续跑轮应当带着「接着干」的 objective 出场',
      )
      assert.ok(
        trace.lastUserMessages.some(m => m.includes('不要重做')),
        '续跑 objective 应当明确要求不重做已完成的工作',
      )
      // Wave 10：补偿轮要看得见。不发事件的话，面板上只有一个 worker 长时间"还在跑"，
      // 用户无从判断它是卡住了还是已经进了第二次续跑。
      // B 终轮定型后每次收尾轮也会上行 'finalizing report' lifecycle——计数只看续跑事件。
      const continuations = activity.filter(a => a.kind === 'lifecycle' && /续跑/.test(a.detail ?? ''))
      assert.equal(continuations.length, 1, `续跑一轮应当上行一条续跑 lifecycle 事件，实际：${JSON.stringify(activity.filter(a => a.kind === 'lifecycle').map(a => a.detail))}`)
      assert.match(continuations[0]!.detail ?? '', /续跑 1\/\d+ · 轮次预算耗尽/)
    } finally {
      // Windows：句柄释放竞态（EPERM）——异步重试等待期间推进事件循环。
      await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
})

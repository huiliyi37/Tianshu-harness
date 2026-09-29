/**
 * Wave 1 身份接线的到达侧断言。
 *
 * `authority-injection.test.ts` 只断言了删除侧（域身份不再出现在 user 消息里）。
 * 若 `worker-session.ts` 的 `defaultDomain: order.authority` 或 `bindSessionDomain`
 * 的兜底语义被改动，那批断言依然全绿，而 worker 会静默拿到错误星域——且比重构前
 * 更糟，因为 user 消息里的兜底副本已经删了。这里把整条链钉在真实 LLM 请求上：
 * WorkOrder.authority → AgentLoop.defaultDomain → bindSessionDomain →
 * setActiveDomain → 冻结前缀里的 <star-domain>。
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
import { READ_ONLY_WORKER_TOOLS, type WorkerResult } from '../work-order.js'
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

function passedResult(workOrderId: string): WorkerResult {
  return {
    workOrderId,
    status: 'passed',
    summary: 'ok',
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'verified',
  }
}

interface Capture { request?: OaiChatRequest }

function capturingClient(capture: Capture): StreamClient {
  return {
    stream: async (request: OaiChatRequest, callbacks: StreamCallbacks) => {
      // 只取第一个请求——summary 扩展等侧路调用（无 system/无冻结头的单发请求）
      // 会覆盖尾请求，把「冻结前缀含 star-domain」的断言对象偷换掉。
      if (!capture.request) capture.request = request
      const text = JSON.stringify(passedResult('wo'))
      callbacks.onTextDelta(text)
      callbacks.onContentBlock({ type: 'text', text })
      callbacks.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
    },
  }
}

/** 派发一个只读 worker，回传它实际发出的第一个 LLM 请求。 */
async function delegateAndCapture(authority?: string): Promise<OaiChatRequest> {
  const tmp = mkdtempSync(join(tmpdir(), 'rivet-domain-wiring-'))
  const capture: Capture = {}
  try {
    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 1,
      runtimeFactory: (order, _card, workerRegistry) => ({
        order,
        client: capturingClient(capture),
        promptEngine: new PromptEngine({
          model: 'test-model',
          maxTokens: 1024,
          staticCtx: { tools: workerRegistry.getDefinitions(), audience: 'subagent' },
          volatileCtx: { cwd: tmp },
        }),
        toolRegistry: workerRegistry,
        cwd: tmp,
        maxTurns: 2,
        contextWindow: 128_000,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      }),
      runWorker: runWorkerSession,
    })

    await coordinator.delegate({
      parentTurnId: 'turn-domain-wiring',
      objective: 'Trace the star domain wiring into the worker frozen prefix now',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: ['src/agent/a.ts'] },
      ...(authority ? { authority } : {}),
    })

    assert.ok(capture.request, 'worker should have issued an LLM request')
    return capture.request
  } finally {
    // Windows：句柄释放竞态（EPERM）——异步重试等待期间推进事件循环。
    await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const WORKER_PROMPT_HEAD = '你是一个无头'

function firstUserMessage(request: OaiChatRequest): string {
  const first = request.messages.find(m => m.role === 'user')
  return typeof first?.content === 'string' ? first.content : JSON.stringify(first?.content ?? '')
}

/**
 * 冻结前缀 = system 段 + 第一条 user 消息里 worker 任务卡之前的 <context> 头部。
 * PromptEngine 把 volatile 块挂在 user 消息头部而不是 system 里，取位取错会让
 * 断言恒假（本测试第一版就踩了这个）。
 */
function frozenPrefix(request: OaiChatRequest): string {
  const system = request.messages
    .filter(m => m.role === 'system')
    .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n')
  const user = firstUserMessage(request)
  const cut = user.indexOf(WORKER_PROMPT_HEAD)
  assert.ok(cut > 0, 'worker 任务卡应跟在冻结 <context> 头部之后')
  return `${system}\n${user.slice(0, cut)}`
}

/** 第一条 user 消息里属于任务卡的那一半（冻结头部之后）。 */
function taskCard(request: OaiChatRequest): string {
  const user = firstUserMessage(request)
  return user.slice(user.indexOf(WORKER_PROMPT_HEAD))
}

describe('worker star-domain wiring (Wave 1 到达侧)', () => {
  it('order.authority 落到冻结前缀的 <star-domain>，而不是 user 消息', async () => {
    const request = await delegateAndCapture('tianji')
    const prefix = frozenPrefix(request)

    assert.match(prefix, /<star-domain name="天机"/, 'authority=tianji 应钉定天机域进冻结前缀')
    assert.doesNotMatch(prefix, /<star-domain name="启明"/, '不应回落启明')

    const card = taskCard(request)
    assert.doesNotMatch(card, /<star-domain/, '域身份不该在任务卡里再抄一遍')
    assert.doesNotMatch(card, /## 你是谁|## 权域指令/, 'Wave 1 已把人格与方法论移出任务卡')
  })

  it('authority 缺席时钉定启明——不是关键词路由', async () => {
    // bindSessionDomain 的 `this.config.defaultDomain ?? 'qiming'`：缺省值不等于
    // 'auto'，所以永远进不到关键词路由分支。这条断言把该语义钉住，改动会响。
    const prefix = frozenPrefix(await delegateAndCapture())
    assert.match(prefix, /<star-domain name="启明"/, 'authority 缺席应钉定启明兜底')
  })
})

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'
import type { OaiChatRequest } from '../../api/oai-types.js'
import type { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import type { Tool, ToolCallParams } from '../../tools/types.js'
import { DelegationCoordinator } from '../coordinator.js'
import { DomainKnowledgeStore } from '../domain-knowledge-store.js'
import { runWorkerSession, type WorkerSessionConfig, type WorkerSessionRun } from '../worker-session.js'
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
    definition: {
      name,
      description: `${name} test tool`,
      input_schema: { type: 'object', properties: {} },
    },
    execute: async () => ({ content: `${name} executed` }),
    requiresApproval: (_params: ToolCallParams) => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  for (const name of READ_ONLY_WORKER_TOOLS) registry.register(fakeTool(name))
  // Mirror production: register every tool any built-in profile can allowlist so
  // filterToolRegistry never throws "Cannot allowlist unknown tool" on a stale set.
  for (const pname of profileRegistry.getProfileNames()) {
    for (const tool of profileRegistry.get(pname)!.allowedTools) registry.register(fakeTool(tool))
  }
  return registry
}

function makePromptEngine(tools: ToolRegistry): PromptEngine {
  return new PromptEngine({
    model: 'test-model',
    maxTokens: 1024,
    staticCtx: { tools: tools.getDefinitions() },
    volatileCtx: { cwd: '/repo' },
  })
}

function passedResult(workOrderId: string): WorkerResult {
  return {
    workOrderId,
    status: 'passed',
    summary: 'second worker saw recalled domain knowledge',
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'verified',
  }
}

function failedResult(workOrderId: string): WorkerResult {
  return {
    workOrderId,
    status: 'failed',
    summary: 'boundary sentinel missing in parser branch',
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'failed',
  }
}

function fakeWorkerClient(capture: { request?: OaiChatRequest }): StreamClient {
  return {
    stream: async (request: OaiChatRequest, callbacks: StreamCallbacks) => {
      capture.request = request
      const lastUser = [...request.messages].reverse().find(m => m.role === 'user')
      const text = JSON.stringify(passedResult('second-worker'))
      assert.match((lastUser?.content as string) ?? '', /天权的经验/, 'second worker prompt should include domain knowledge block')
      assert.match((lastUser?.content as string) ?? '', /boundary sentinel missing/, 'second worker prompt should include lesson from prior worker')
      callbacks.onTextDelta(text)
      callbacks.onContentBlock({ type: 'text', text })
      callbacks.onStopReason('end_turn', { input_tokens: 10, output_tokens: 5 })
    },
  }
}

function fakeSession(): SessionContext {
  return { getTurnCount: () => 1 } as unknown as SessionContext
}

function makeCoordinator(input: {
  tmp: string
  store: DomainKnowledgeStore
  runWorker: (config: WorkerSessionConfig) => Promise<WorkerSessionRun>
}): DelegationCoordinator {
  return new DelegationCoordinator({
    baseToolRegistry: makeRegistry(),
    modelCards: cards,
    maxWorkers: 1,
    domainKnowledgeStore: input.store,
    runtimeFactory: (order, _card, workerRegistry) => ({
      order,
      client: fakeWorkerClient({}),
      promptEngine: makePromptEngine(workerRegistry),
      toolRegistry: workerRegistry,
      cwd: input.tmp,
      maxTurns: 2,
      contextWindow: 128_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    }),
    runWorker: input.runWorker,
  })
}

describe('V3 domain knowledge integration', () => {
  it('delegate → precipitate → recall → inject closes the same-authority loop', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'rivet-domain-integration-'))
    const store = new DomainKnowledgeStore(tmp)
    const capture: { request?: OaiChatRequest } = {}
    let calls = 0

    try {
      const coordinator = makeCoordinator({
        tmp,
        store,
        runWorker: async (config) => {
          calls++
          if (calls === 1) {
            return {
              result: failedResult(config.order.id),
              transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
              session: fakeSession(),
              usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            }
          }
          return runWorkerSession({
            ...config,
            client: fakeWorkerClient(capture),
            // fakeWorkerClient 对「每个请求」断言末条 user 消息含领域知识块——
            // 收尾轮的末条消息是收尾指令，断言会失败（被终型 catch 吞掉）。
            // 本用例验证的是知识注入 worker 主提示词，钉旧契约保持单变量。
            finalizeReport: false,
          })
        },
      })

      await coordinator.delegate({
        parentTurnId: 'turn-precipitate',
        objective: 'Investigate domain knowledge precipitate evidence flow now',
        kind: 'code_search',
        profile: 'code_scout',
        scope: { files: ['src/agent/a.ts', 'src/agent/b.ts'] },
        authority: 'tianquan',
      })

      const recalled = store.recall('tianquan', 10)
      assert.ok(recalled.some(l => l.text.includes('boundary sentinel missing')), 'first worker result should precipitate a tianquan lesson')

      const run = await coordinator.delegate({
        parentTurnId: 'turn-recall',
        objective: 'Investigate domain knowledge recall prompt injection now',
        kind: 'code_search',
        profile: 'code_scout',
        scope: { files: ['src/agent/a.ts', 'src/agent/b.ts'] },
        authority: 'tianquan',
      })

      assert.equal(run.status, 'completed')
      assert.equal(run.results[0]?.status, 'passed')
      assert.ok(capture.request, 'second worker should have received an LLM request')
    } finally {
      // Windows：句柄释放竞态（EPERM）——异步重试等待期间推进事件循环。
      await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
})

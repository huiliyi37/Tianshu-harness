/**
 * W3 re-dispatch entry (session 2c1186f5): aborted workers produce a
 * WorkerCheckpoint that previously nobody consumed — the primary had no way to
 * know the partial work was resumable. Now the coordinator stashes the
 * checkpoint, annotates the blocked result with an explicit resume hint, and
 * re-injects the checkpoint into the worker config on a resume dispatch.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StreamClient } from '../../api/stream-client.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import type { Tool, ToolCallParams } from '../../tools/types.js'
import type { ModelCapabilityCard } from '../../model/capability.js'
import { DelegationCoordinator } from '../coordinator.js'
import { isValidSessionId } from '../../validation.js'
import { READ_ONLY_WORKER_TOOLS, buildBlockedWorkerResult, deriveWorkerSessionId, type WorkOrder } from '../work-order.js'
import { profileRegistry } from '../profile-registry.js'
import type { WorkerCheckpoint, WorkerSessionConfig } from '../worker-session.js'
import { loadWorkerSession, workerSessionPath } from '../worker-session-persist.js'

function fakeTool(name: string): Tool {
  return {
    definition: { name, description: `${name} test tool`, input_schema: { type: 'object', properties: {} } },
    execute: async () => ({ content: `${name} executed` }),
    requiresApproval: (_params: ToolCallParams) => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}

function makeRegistry() {
  const registry = new ToolRegistry()
  for (const name of READ_ONLY_WORKER_TOOLS) registry.register(fakeTool(name))
  for (const pname of profileRegistry.getProfileNames()) {
    for (const tool of profileRegistry.get(pname)!.allowedTools) {
      if (!registry.has(tool)) registry.register(fakeTool(tool))
    }
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

const CHECKPOINT: WorkerCheckpoint = {
  turnIndex: 2,
  partialResult: 'partial scouting evidence: loop.ts:89 is the entry',
  completedTools: ['grep', 'read_file', 'read_file'],
}

function makeCoordinator(runWorker: (config: WorkerSessionConfig) => ReturnType<NonNullable<ConstructorParameters<typeof DelegationCoordinator>[0]['runWorker']>>) {
  return new DelegationCoordinator({
    baseToolRegistry: makeRegistry(),
    modelCards: cards,
    maxWorkers: 2,
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
    runWorker,
  })
}

function abortedRun(order: WorkOrder) {
  return {
    result: {
      ...buildBlockedWorkerResult(order, 'Worker aborted (budget timeout). Partial output: …', 'timeout'),
    },
    // session.getMessages 是本轮执行历史的唯一出口：coordinator 从它取
    // sessionMessages 交给 persistWorkerDispatch；审计在没有完整执行历史时会
    // 摘掉 Resumable 并记 risk（do not claim resumable）。给一份最小历史，让本
    // 用例落在「历史齐备 → 允许声称可续跑」的正常路径上，否则断言的是拒绝分支。
    transcript: { text: '', thinking: '', toolUses: [...CHECKPOINT.completedTools], toolResults: [], errors: [], repairAttempts: 0 },
    session: { getTurnCount: () => 1, getMessages: () => [{ role: 'user', content: 'Trace the agent loop entry chain' }] } as never,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    checkpoint: CHECKPOINT,
  }
}

describe('W3 abort checkpoint → resume re-dispatch entry', () => {
  it('retains the blocked checkpoint for inspection and rejects explicit resume', async () => {
    const seenCheckpoints: (WorkerCheckpoint | undefined)[] = []
    const coordinator = makeCoordinator(async config => {
      seenCheckpoints.push(config.checkpoint)
      if (seenCheckpoints.length === 1) return abortedRun(config.order)
      return {
        result: {
          workOrderId: config.order.id,
          status: 'passed' as const,
          summary: 'resumed and finished the scouting objective',
          findings: [],
          artifacts: [],
          changedFiles: [],
          risks: [],
          nextActions: [],
          evidenceStatus: 'verified' as const,
        },
        transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
        session: { getTurnCount: () => 1 } as never,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }
    })

    // First dispatch: worker aborts with a checkpoint.
    const first = await coordinator.delegate({
      parentTurnId: 'turn-1',
      objective: 'Trace the agent loop entry chain across coordinator and worker session modules',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: ['src/agent/loop.ts'] },
    })
    const firstResult = first.results[0]!
    assert.equal(firstResult.status, 'blocked')
    assert.equal(firstResult.failureReason, 'timeout')
    const resumeHint = firstResult.nextActions.find(a => a.includes('Resumable'))
    assert.equal(resumeHint, undefined)
    assert.equal(firstResult.terminalFailure, true)
    assert.equal(seenCheckpoints[0], undefined, 'first dispatch starts without a checkpoint')

    // Resume dispatch: checkpoint from the aborted run must ride along.
    const second = await coordinator.delegate({
      parentTurnId: 'turn-2',
      objective: 'Trace the agent loop entry chain across coordinator and worker session modules',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: ['src/agent/loop.ts'] },
      resumeWorkOrderId: firstResult.workOrderId,
    })
    assert.equal(second.results[0]!.status, 'blocked')
    assert.equal(seenCheckpoints.length, 1, 'failed checkpoint cannot start another worker')
  })

  it('repeated resume attempts cannot bypass the terminal task lock', async () => {
    const seenCheckpoints: (WorkerCheckpoint | undefined)[] = []
    const coordinator = makeCoordinator(async config => {
      seenCheckpoints.push(config.checkpoint)
      if (seenCheckpoints.length === 1) return abortedRun(config.order)
      return {
        result: {
          workOrderId: config.order.id,
          status: 'passed' as const,
          summary: 'done after resume for the consumed-once contract test',
          findings: [],
          artifacts: [],
          changedFiles: [],
          risks: [],
          nextActions: [],
          evidenceStatus: 'verified' as const,
        },
        transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
        // 同 abortedRun：本轮也要有可持久化的执行历史，否则 resume 派发不算
        // 「成功落地」，coordinator.ts:1897 的 checkpoint 消费不会发生。
        session: { getTurnCount: () => 1, getMessages: () => [{ role: 'user', content: 'resume the objective' }] } as never,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }
    })

    const first = await coordinator.delegate({
      parentTurnId: 'turn-1',
      objective: 'Trace the boundary compact coordinator flow through the archive collectors',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: ['src/agent/compact-boundary-coordinator.ts'] },
    })
    const orderId = first.results[0]!.workOrderId

    await coordinator.delegate({
      parentTurnId: 'turn-2',
      objective: 'Trace the boundary compact coordinator flow through the archive collectors',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: ['src/agent/compact-boundary-coordinator.ts'] },
      resumeWorkOrderId: orderId,
    })
    assert.equal(seenCheckpoints.length, 1)

    await coordinator.delegate({
      parentTurnId: 'turn-3',
      objective: 'Trace the boundary compact coordinator flow through the archive collectors',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: ['src/agent/compact-boundary-coordinator.ts'] },
      resumeWorkOrderId: orderId,
    })
    assert.equal(seenCheckpoints.length, 1, 'failed checkpoint must never dispatch again')
  })
})

describe('W4 worker session id de-collision', () => {
  it('deriveWorkerSessionId: colon-safe base, nonce appended when present', () => {
    assert.equal(deriveWorkerSessionId('batch:0'), 'worker-batch-0')
    assert.equal(deriveWorkerSessionId('batch:0', 'x7f3a'), 'worker-batch-0-x7f3a')
    assert.equal(deriveWorkerSessionId('wo_abc'), 'worker-wo_abc')
    const task1Session = deriveWorkerSessionId('Task 1', '68a63')
    assert.equal(task1Session, 'worker-Task-1-68a63')
    assert.ok(isValidSessionId(task1Session))
    const cjkSession = deriveWorkerSessionId('任务 1: 算法实现')
    assert.equal(cjkSession, 'worker-1')
    assert.ok(isValidSessionId(cjkSession))
    const pureCjkSession = deriveWorkerSessionId('独立任务')
    assert.match(pureCjkSession, /^worker-task-[a-f0-9]{8}$/)
    assert.ok(isValidSessionId(pureCjkSession))
  })

  it('re-dispatching the same stable batch order id yields a fresh session nonce each time', async () => {
    const seenNonces: (string | undefined)[] = []
    const coordinator = makeCoordinator(async config => {
      seenNonces.push(config.sessionNonce)
      return {
        result: {
          workOrderId: config.order.id,
          status: 'passed' as const,
          summary: 'scouted the target files for the nonce de-collision test',
          findings: [],
          artifacts: [],
          changedFiles: [],
          risks: [],
          nextActions: [],
          evidenceStatus: 'verified' as const,
        },
        transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
        session: { getTurnCount: () => 1 } as never,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }
    })

    // Same `batch:0`-style stable order id across two delegation runs (this is
    // exactly the delegate_batch reuse pattern that collided JSONL files).
    for (const turn of ['tool-1', 'tool-2']) {
      await coordinator.delegate({
        parentTurnId: `${turn}:batch:0`,
        objective: 'Inspect worker session persistence collision behavior in the delegation layer',
        kind: 'code_search',
        profile: 'code_scout',
        scope: { files: ['src/agent/worker-session.ts'] },
      })
    }

    assert.equal(seenNonces.length, 2)
    assert.ok(seenNonces[0] && seenNonces[1], 'every dispatch must mint a nonce')
    assert.notEqual(seenNonces[0], seenNonces[1], 'same stable order id must not share a session file across dispatches')
  })
})

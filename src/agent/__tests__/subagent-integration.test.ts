import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isAbsolute } from 'node:path'
import { filterToolRegistry, ToolRegistry } from '../../tools/registry.js'
import type { Tool, ToolCallParams } from '../../tools/types.js'
import type { StreamCallbacks } from '../../api/stream-client.js'
import type { OaiChatRequest } from '../../api/types.js'
import {
  READ_ONLY_WORKER_TOOLS,
  PHASE1_DISALLOWED_WORKER_TOOLS,
  type WorkOrder,
} from '../work-order.js'
import { profileRegistry } from '../profile-registry.js'
import { runWorkerSession } from '../worker-session.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { DelegationCoordinator } from '../coordinator.js'
import { createDelegateTaskTool } from '../../tools/delegate-task.js'
import { MockStreamClient, mockClientFromTexts, mockClientFromMultiRoundTexts, MockClaimStore } from './mocks.js'

function createMinimalPromptEngine(): PromptEngine {
  return new PromptEngine({
    model: 'deepseek-v4',
    maxTokens: 4096,
    staticCtx: { tools: [] },
    volatileCtx: {
      cwd: '/tmp',
      workingSet: [],
      playbookLessons: [],
      activeClaims: [],
      toolHistory: [],
      sessionMemoryBlock: '',
    },
  })
}

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

/** Register every tool name that a worker might encounter (read + write + delegate). */
function makeFullRegistry(): ToolRegistry {
  const allNames = [
    ...READ_ONLY_WORKER_TOOLS,
    'write_file',
    'bash',
    'edit_file',
    'run_tests',
    'delegate_task',
    'delegate_batch',
  ]
  const registry = new ToolRegistry()
  for (const name of allNames) registry.register(fakeTool(name))
  return registry
}

describe('filterToolRegistry with READ_ONLY_WORKER_TOOLS', () => {
  it('excludes write_file from read-only filtered registry', () => {
    const source = makeFullRegistry()
    const filtered = filterToolRegistry(source, READ_ONLY_WORKER_TOOLS)

    assert.equal(filtered.has('write_file'), false, 'write_file must be excluded')
  })

  it('excludes bash from read-only filtered registry', () => {
    const source = makeFullRegistry()
    const filtered = filterToolRegistry(source, READ_ONLY_WORKER_TOOLS)

    assert.equal(filtered.has('bash'), false, 'bash must be excluded')
  })

  it('includes read_file in read-only filtered registry', () => {
    const source = makeFullRegistry()
    const filtered = filterToolRegistry(source, READ_ONLY_WORKER_TOOLS)

    assert.equal(filtered.has('read_file'), true, 'read_file must be included')
  })

  it('includes grep in read-only filtered registry', () => {
    const source = makeFullRegistry()
    const filtered = filterToolRegistry(source, READ_ONLY_WORKER_TOOLS)

    assert.equal(filtered.has('grep'), true, 'grep must be included')
  })

  it('includes all seven READ_ONLY_WORKER_TOOLS names', () => {
    const source = makeFullRegistry()
    const filtered = filterToolRegistry(source, READ_ONLY_WORKER_TOOLS)

    const filteredNames = filtered.getAll().map(t => t.definition.name).sort()
    const expected = [...READ_ONLY_WORKER_TOOLS].sort()
    assert.deepEqual(filteredNames, expected)
  })

  it('excludes all PHASE1_DISALLOWED_WORKER_TOOLS', () => {
    const source = makeFullRegistry()
    const filtered = filterToolRegistry(source, READ_ONLY_WORKER_TOOLS)

    for (const disallowed of PHASE1_DISALLOWED_WORKER_TOOLS) {
      assert.equal(
        filtered.has(disallowed),
        false,
        `${disallowed} is in PHASE1_DISALLOWED but was found in read-only registry`,
      )
    }
  })

  it('excludes edit_file and run_tests in addition to write_file and bash', () => {
    const source = makeFullRegistry()
    const filtered = filterToolRegistry(source, READ_ONLY_WORKER_TOOLS)

    assert.equal(filtered.has('edit_file'), false, 'edit_file must be excluded')
    assert.equal(filtered.has('run_tests'), false, 'run_tests must be excluded')
    assert.equal(filtered.has('delegate_task'), false, 'delegate_task must be excluded')
    assert.equal(filtered.has('delegate_batch'), false, 'delegate_batch must be excluded')
  })
})

describe('MockStreamClient', () => {
  it('replays a single text response for one stream() call', async () => {
    const client = new MockStreamClient([[{ text: 'hello world' }]])
    let collected = ''
    const cb: StreamCallbacks = {
      onTextDelta: (d) => { collected += d },
      onThinkingDelta: () => {},
      onContentBlock: () => {},
      onStopReason: () => {},
      onError: () => {},
    }
    const req: OaiChatRequest = { model: 'test', messages: [], max_tokens: 1024  }
    await client.stream(req, cb)
    assert.equal(collected, 'hello world')
    assert.equal(client.calls.length, 1)
    assert.equal(client.calls[0]?.text, 'hello world')
  })

  it('replays sequential responses across multiple stream() calls', async () => {
    const client = new MockStreamClient([
      [{ text: 'first call' }],
      [{ text: 'second call' }],
    ])
    const cb: StreamCallbacks = {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onContentBlock: () => {},
      onStopReason: () => {},
      onError: () => {},
    }
    const req: OaiChatRequest = { model: 'test', messages: [], max_tokens: 1024  }

    const texts: string[] = []
    const cb1: StreamCallbacks = {
      onTextDelta: (d) => { texts.push(d) },
      onThinkingDelta: () => {},
      onContentBlock: () => {},
      onStopReason: () => {},
      onError: () => {},
    }
    await client.stream(req, cb1)
    await client.stream(req, cb)
    assert.equal(texts[0], 'first call')
    assert.equal(client.calls.length, 2)
    assert.equal(client.calls[0]?.text, 'first call')
    assert.equal(client.calls[1]?.text, 'second call')
  })

  it('replays multiple rounds within a single call set', async () => {
    const client = new MockStreamClient([[{ text: 'round1' }, { text: 'round2' }]])
    const req: OaiChatRequest = { model: 'test', messages: [], max_tokens: 1024  }
    const cb: StreamCallbacks = {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onContentBlock: () => {},
      onStopReason: () => {},
      onError: () => {},
    }

    await client.stream(req, cb)
    assert.equal(client.calls.length, 1)
    assert.equal(client.calls[0]?.text, 'round1')

    await client.stream(req, cb)
    assert.equal(client.calls.length, 2)
    assert.equal(client.calls[1]?.text, 'round2')
  })
})

describe('mockClientFromTexts', () => {
  it('creates a MockStreamClient that replays given texts', async () => {
    const client = mockClientFromTexts(['alpha', 'beta'])
    const texts: string[] = []
    const cb: StreamCallbacks = {
      onTextDelta: (d) => { texts.push(d) },
      onThinkingDelta: () => {},
      onContentBlock: () => {},
      onStopReason: () => {},
      onError: () => {},
    }
    const req: OaiChatRequest = { model: 'test', messages: [], max_tokens: 1024  }

    await client.stream(req, cb)
    await client.stream(req, cb)
    assert.deepEqual(texts, ['alpha', 'beta'])
  })

  it('tracks call records for assertions', async () => {
    const client = mockClientFromTexts(['result'])
    const cb: StreamCallbacks = {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onContentBlock: () => {},
      onStopReason: () => {},
      onError: () => {},
    }
    const req: OaiChatRequest = { model: 'deepseek', messages: [], max_tokens: 2048  }
    await client.stream(req, cb)

    assert.equal(client.calls.length, 1)
    assert.equal(client.calls[0]?.request.model, 'deepseek')
    assert.equal(client.calls[0]?.request.max_tokens, 2048)
  })
})

describe('MockClaimStore', () => {
  it('creates a store with a temp directory', () => {
    const store = new MockClaimStore('test-session')
    try {
      assert.ok(isAbsolute(store.tempDir), 'tempDir should be an absolute path')
      assert.equal(store.sessionId, 'test-session')
      // Verify it can accept proposals
      const claim = store.propose({
        kind: 'worker_finding',
        scope: 'session',
        text: 'Test claim from mock',
        confidence: 0.9,
        fitness: 0.8,
        source: { actor: 'worker', sessionId: 'test-session', turn: 1, eventId: 'ev:test:1' },
        evidence: [{ id: 'ev:test:1', kind: 'worker', summary: 'test evidence', createdAt: Date.now() }],
        createdAt: Date.now(),
        tags: ['test'],
      })
      assert.ok(claim.id, 'claim should have an id')
      assert.equal(claim.text, 'Test claim from mock')
      assert.equal(claim.status, 'active')
    } finally {
      store.dispose()
    }
  })

  it('generates unique session IDs when none provided', () => {
    const store1 = new MockClaimStore()
    const store2 = new MockClaimStore()
    try {
      assert.notEqual(store1.sessionId, store2.sessionId, 'auto-generated session IDs must be unique')
    } finally {
      store1.dispose()
      store2.dispose()
    }
  })
})

describe('Worker Session Isolation', () => {
  it('should not pollute primary session context', async () => {
    const primarySession = new SessionContext()
    const mockClient = new MockStreamClient([[{
      text: `{
        "workOrderId": "wo-test-1",
        "status": "passed",
        "summary": "Worker completed task",
        "findings": [{ "claim": "Test claim", "evidence": "Evidence", "confidence": "high" }],
        "artifacts": [],
        "changedFiles": [],
        "risks": [],
        "nextActions": []
      }`
    }]])

    const order: WorkOrder = {
      id: 'wo-test-1',
      parentTurnId: 'turn-1',
      delegationDepth: 1,
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Test isolation',
      scope: {},
      constraints: [],
      allowedTools: ['read_file'],
      disallowedTools: ['write_file'],
      dedupeKey: 'test-dedupe',
      dependencies: [],
      aggregationPolicy: 'primary_decides',
      budget: { maxTurns: 1, maxTokens: 1024, timeoutMs: 60000, maxRetries: 0, retryBackoffMs: 10000, maxRetryBackoffMs: 300000 }
    }

    const run = await runWorkerSession({
      order,
      client: mockClient,
      promptEngine: createMinimalPromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/tmp',
      maxTurns: 1,
      contextWindow: 10000,
      compact: { enabled: true, autoThreshold: 8000, autoFloor: 5000, model: 'deepseek-v4' }
    })

    // Worker should have processed the request
    assert.equal(run.result.status, 'passed')
    
    // Primary session should remain untouched
    assert.equal(primarySession.getMessages().length, 0, 'Primary session should have no messages')
  })

  it('should handle invalid schema and attempt repair', async () => {
    const invalidResponse = "I can't provide a valid JSON."
    const validResponse = `{
      "workOrderId": "wo-test-2",
      "status": "passed",
      "summary": "Repaired response",
      "findings": [],
      "artifacts": [],
      "changedFiles": [],
      "risks": [],
      "nextActions": []
    }`

    // First call returns invalid, second returns valid
    const mockClient = new MockStreamClient([
      [{ text: invalidResponse }],
      [{ text: validResponse }]
    ])

    const order: WorkOrder = {
      id: 'wo-test-2',
      parentTurnId: 'turn-2',
      delegationDepth: 1,
      kind: 'review',
      profile: 'reviewer',
      objective: 'Test repair',
      scope: {},
      constraints: [],
      allowedTools: [],
      disallowedTools: [],
      dedupeKey: 'test-dedupe-2',
      dependencies: [],
      aggregationPolicy: 'primary_decides',
      budget: { maxTurns: 1, maxTokens: 1024, timeoutMs: 60000, maxRetries: 1, retryBackoffMs: 10000, maxRetryBackoffMs: 300000 } // Allow 1 retry
    }

    const run = await runWorkerSession({
      order,
      client: mockClient,
      promptEngine: createMinimalPromptEngine(),
      toolRegistry: new ToolRegistry(),
      cwd: '/tmp',
      maxTurns: 1,
      contextWindow: 10000,
      compact: { enabled: true, autoThreshold: 8000, autoFloor: 5000, model: 'deepseek-v4' },
      // 修复梯专用用例——钉旧契约（无收尾轮），否则终型轮先把报告救回、
      // repairAttempts 恒为 0。
      finalizeReport: false,
    })

    assert.equal(run.result.status, 'passed')
    assert.equal(run.result.summary, 'Repaired response')
    assert.equal(run.transcript.repairAttempts, 1)
  })
})

describe('Delegation Flow', () => {
  it('should handle delegate_task execution and claim injection', async () => {
    const claimStore = new MockClaimStore('flow-test-session')

    // The base registry must mirror production: every tool any built-in profile can
    // allowlist, so filterToolRegistry never throws "Cannot allowlist unknown tool".
    const baseRegistry = new ToolRegistry()
    for (const name of READ_ONLY_WORKER_TOOLS) baseRegistry.register(fakeTool(name))
    for (const pname of profileRegistry.getProfileNames()) {
      for (const tool of profileRegistry.get(pname)!.allowedTools) baseRegistry.register(fakeTool(tool))
    }

    const coordinator = new DelegationCoordinator({
      baseToolRegistry: baseRegistry,
      modelCards: [{
        model: 'deepseek-v4',
        toolUseReliability: 0.9,
        jsonStability: 0.9,
        editSuccessRate: 0.8,
        testRepairRate: 0.8,
        contextWindow: 128000,
        cacheEconomics: 'strong' as const,
        recommendedTasks: ['code_search', 'review'],
      }],
      maxWorkers: 1,
      runtimeFactory: (order, _card, registry) => ({
        order,
        client: mockClientFromTexts(['unused']),
        promptEngine: createMinimalPromptEngine(),
        toolRegistry: registry,
        cwd: '/tmp',
        maxTurns: 1,
        contextWindow: 10000,
        compact: { enabled: true, autoThreshold: 8000, autoFloor: 5000, model: 'deepseek-v4' }
      }),
      // Inject a controlled runWorker that bypasses AgentLoop
      runWorker: async (config) => {
        return {
          result: {
            workOrderId: config.order.id,
            status: 'passed' as const,
            summary: 'Found authentication bug',
            findings: [{ claim: 'Missing token refresh', evidence: 'auth.ts:42', confidence: 'high' as const }],
            artifacts: [],
            changedFiles: ['src/auth.ts'],
            risks: [],
            nextActions: ['Fix token refresh'],
            evidenceStatus: 'verified' as const,
            verification: {
              command: 'npx tsc --noEmit',
              status: 'passed' as const,
              scope: 'targeted' as const,
              exitCode: 0,
              passed: 1,
              failed: 0,
              skipped: 0,
              durationMs: 500,
            },
          },
          transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
          session: new SessionContext(),
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }
      },
    })

    const delegateTool = createDelegateTaskTool(coordinator, () => claimStore, () => 'flow-test-session')

    const result = await delegateTool.execute({
      toolUseId: 'tu-flow-1',
      cwd: '/tmp',
      input: {
        objective: 'Find authentication bugs in auth module',
        kind: 'code_search',
        profile: 'code_scout'
      }
    })

    assert.equal(result.isError, false)
    assert.ok(result.content.includes('Found authentication bug'))
    assert.ok(result.uiContent?.includes('delegate_task · 1/1 通过'))

    // Verify claim injection
    const claims = claimStore.listClaims()
    assert.equal(claims.length, 1)
    assert.equal(claims[0]?.text, 'Missing token refresh')
    assert.equal(claims[0]?.kind, 'worker_finding')

    claimStore.dispose()
  })
})

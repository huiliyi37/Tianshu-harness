import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop, formatActivePlanPointer } from '../loop.js'
import { SessionContext } from '../context.js'
import { RuntimeHookPipeline } from '../runtime-hooks.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_FILE_TOOL } from '../../tools/read-file.js'
import { createOwnershipLedger } from '../ownership-ledger.js'
import { createTaskLedger } from '../task-ledger.js'
import { createWorktreeBaseline } from '../worktree-baseline.js'
import { createPersistentTaskState } from '../task-state-persist.js'
import { getEffectiveVerifications } from '../verification-attribution.js'
import { spawnSync } from 'node:child_process'
import { ContextClaimStore } from '../../context/claim-store.js'
import { PlaybookStore } from '../playbook-store.js'
import { PrewarmCache } from '../prewarm.js'
import { ArtifactStore } from '../../artifact/store.js'
import type { StreamCallbacks } from '../../api/stream-client.js'
import type { StreamClient } from '../../api/stream-client.js'
import type { ContentBlock, Message } from '../../api/types.js'
import type { OaiMessage } from '../../api/oai-types.js'
import type { Tool } from '../../tools/types.js'

// Writable cwd for AgentLoop: turn-cache telemetry does a fire-and-forget
// mkdir under ~/.rivet/sessions/<slug>/ (via getSessionDir); an unwritable
// sentinel like TEST_CWD makes that async write reject (ENOENT) after the
// test ends, leaking an unhandledRejection onto the next test.
const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-loop-cwd-'))

function makeTextBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

function makeToolUseBlock(id: string, name: string, input: Record<string, unknown>): ContentBlock {
  return { type: 'tool_use', id, name, input }
}

/** Creates a mock client that delivers content blocks and then stops */
function mockClient(blocks: ContentBlock[], stopReason = 'end_turn', usage = { input_tokens: 100, output_tokens: 50 }): StreamClient {
  let called = false
  return {
    stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
      if (called) {
        for (const b of blocks) {
          if (b.type === 'text' && 'text' in b) cb.onTextDelta(b.text)
          cb.onContentBlock(b)
        }
        cb.onStopReason(stopReason, usage)
        return
      }
      called = true
      for (const b of blocks) {
        if (b.type === 'text' && 'text' in b) cb.onTextDelta(b.text)
        cb.onContentBlock(b)
      }
      cb.onStopReason('tool_use', usage)
    }),
  } as unknown as StreamClient
}


function makeCallbacks() {
  return {
    onTextDelta: () => {},
    onThinkingDelta: () => {},
    onToolUse: () => {},
    onToolResult: () => {},
    onTurnComplete: () => {},
    onError: (error: Error) => { throw error },
    onAbort: () => {},
    onApprovalRequired: async () => false,
  }
}

function makeEngine() {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [READ_FILE_TOOL.definition] },
    volatileCtx: { cwd: TEST_CWD },
  })
}

describe('AgentLoop — multi-turn tool_use', () => {
  it('completes a simple text turn (no tool_use)', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    const client = mockClient([makeTextBlock('Hello! How can I help?')])
    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, TEST_CWD)

    const texts: string[] = []
    let completeCount = 0

    await agent.run('hello', {
      onTextDelta: (t) => texts.push(t),
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => { completeCount++ },
      onError: () => {},
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    assert.equal(texts.join(''), 'Hello! How can I help?')
    assert.equal(completeCount, 1)
    assert.equal(session.getTurnCount(), 1)
    assert.equal(session.getMessages().length, 2) // user + assistant
  })

  it('config.prewarm 构造期注入——toolExecution 消费端拿到共享实例（断裂回归）', () => {
    // 冒烟审查抓到的断裂：toolExecution deps 在构造时按值捕获 self.prewarm，
    // 构造后替换 agent.prewarm 字段到不了 read-file 的 consumePrewarm——
    // 批级共享 cache「有写无读」空转。必须在构造期经 config 注入。
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)
    const shared = new PrewarmCache(60_000, 50)

    const client = mockClient([makeTextBlock('ok')])
    const agent = new AgentLoop({
      client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      prewarm: shared,
    }, session, TEST_CWD)

    assert.equal(agent.prewarm, shared, 'agent.prewarm 必须是注入的共享实例')
    const deps = (agent as unknown as { toolExecution: { deps: { prewarm: unknown } } }).toolExecution.deps
    assert.equal(deps.prewarm, shared, 'toolExecution 消费端必须持有同一个共享实例（构造时值捕获路径）')
  })

  it('ends a wedged run when the same tool batch keeps erroring (denied-approval loop)', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)
    let execCount = 0
    const failTool: Tool = {
      definition: { name: 'always_fail', description: 'always errors', input_schema: { type: 'object', properties: {} } },
      execute: async () => { execCount++; return { content: 'denied: requires user approval', isError: true } },
      requiresApproval: () => false,
      isConcurrencySafe: () => false,
      isEnabled: () => true,
    }
    registry.register(failTool)

    // Client that re-emits the SAME tool_use every turn. Without the wedge guard
    // this spins until maxTurns (20), ballooning context — the sidecar-OOM cause.
    let n = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        cb.onContentBlock(makeToolUseBlock(`call-${n++}`, 'always_fail', { x: 1 }))
        cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 10 })
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 20, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, TEST_CWD)

    let finalCompletions = 0
    const stopReasons: string[] = []
    const errors: Error[] = []
    await agent.run('go', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: (_usage: unknown, _turn: number, isFinal?: boolean) => { if (isFinal) finalCompletions++ },
      onError: (e: Error) => { errors.push(e) },
      onAbort: () => {},
      onApprovalRequired: async () => false,
      onPhaseChange: (phase: string, detail?: { reason?: string }) => {
        if (phase === 'stop-reason' && detail?.reason) stopReasons.push(detail.reason)
      },
    })

    assert.deepEqual(errors, [], 'no unexpected errors')
    // Guard trips at MAX_WEDGE_REPEATS (3) — far below maxTurns (20).
    assert.ok(execCount >= 3 && execCount <= 5, `wedge guard should stop early, ran ${execCount}×`)
    assert.ok(stopReasons.some(r => r.includes('工具死循环')), `expected a wedged-loop stop reason, got: ${JSON.stringify(stopReasons)}`)
    assert.equal(finalCompletions, 1, 'exactly one final turn completion is emitted so the UI resets')
  })

  it('syncs auto reasoning effort to the client without going below the configured floor', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)
    const efforts: string[] = []
    const client: StreamClient = {
      setReasoningEffort: mock.fn((effort: string) => { efforts.push(effort) }),
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        cb.onTextDelta('done')
        cb.onContentBlock(makeTextBlock('done'))
        cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 50 })
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({
      client,
      promptEngine: makeEngine(),
      toolRegistry: registry,
      maxTurns: 5,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      autoReasoning: true,
      reasoningFloor: 'high',
    }, session, TEST_CWD)

    await agent.run('What does this function do?', makeCallbacks())

    assert.ok(efforts.length >= 1)
    assert.ok(efforts.every(effort => effort === 'high'))
    assert.equal(agent.getReasoningEffort(), 'high')
  })

  it('executes tool_use and continues loop', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        if (callCount === 1) {
          cb.onContentBlock(makeToolUseBlock('tu_1', 'read_file', { file_path: '/test/package.json' }))
          cb.onStopReason('tool_use', { input_tokens: 150, output_tokens: 80 })
        } else {
          cb.onTextDelta('Found package.json')
          cb.onContentBlock(makeTextBlock('Found package.json'))
          cb.onStopReason('end_turn', { input_tokens: 200, output_tokens: 40 })
        }
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, TEST_CWD)

    const toolUses: string[] = []
    const toolResults: string[] = []

    await agent.run('read package.json', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: (_id, name) => { toolUses.push(name) },
      onToolResult: (_id, name) => { toolResults.push(name) },
      onTurnComplete: () => {},
      onError: () => {},
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    assert.equal(callCount, 2)
    assert.deepEqual(toolUses, ['read_file'])
    assert.deepEqual(toolResults, ['read_file'])
    assert.ok(session.getMessages().length >= 4, `expected at least 4 messages, got ${session.getMessages().length}`)
  })

  it('binds a matched star domain once per session and injects it into latest volatile context', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)
    const engine = makeEngine()
    const seenContexts: string[] = []

    const client: StreamClient = {
      stream: mock.fn(async (req: { messages: Message[] }, cb: StreamCallbacks, _sig?: AbortSignal) => {
        const contexts = req.messages.filter(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('<star-domain'))
        const context = contexts.at(-1)
        if (context && typeof context.content === 'string') seenContexts.push(context.content)
        cb.onTextDelta('done')
        cb.onContentBlock(makeTextBlock('done'))
        cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 50 })
      }),
    } as unknown as StreamClient

    // 关键词路由是被测特性（默认开，auto 池内匹配，未命中回退天权）；显式传 true 使意图自明。
    // 2026-07-23 auto 池收窄后改用池内域（开阳/天梁）验证"绑定一次、后续消息不换域"。
    const agent = new AgentLoop({ client, promptEngine: engine, toolRegistry: registry, maxTurns: 2, contextWindow: 1_000_000, domainKeywordRouting: true, defaultDomain: 'auto', compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, TEST_CWD)

    await agent.run('对账插桩定位这个偏差', makeCallbacks())
    await agent.run('按计划实现用户注册', makeCallbacks())

    assert.equal(seenContexts.length, 2)
    assert.match(seenContexts[0]!, /<star-domain name="开阳"/)
    assert.match(seenContexts[1]!, /<star-domain name="开阳"/)
    assert.doesNotMatch(seenContexts[1]!, /name="天梁"/)
  })

  it('stores cache diagnostic when latest turn hit rate is low', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        cb.onContentBlock(makeTextBlock('done'))
        cb.onStopReason('end_turn', {
          input_tokens: 100,
          output_tokens: 10,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 90,
        })
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 2, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, TEST_CWD)

    await agent.run('hello', makeCallbacks())

    assert.match(agent.getCacheDiagnostic() ?? '', /cache/i)
  })

  it('clears cache diagnostic when latest turn hit rate is healthy', async () => {
    const session = new SessionContext()
    session.recordTurnCache(1, {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 90,
    })
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        cb.onContentBlock(makeTextBlock('done'))
        cb.onStopReason('end_turn', {
          input_tokens: 100,
          output_tokens: 10,
          cache_read_input_tokens: 90,
          cache_creation_input_tokens: 10,
        })
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 2, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, TEST_CWD)

    await agent.run('hello', makeCallbacks())

    assert.equal(agent.getCacheDiagnostic(), null)
  })

  it('clears cache diagnostic when latest turn has no cache counters', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        cb.onContentBlock(makeTextBlock('done'))
        cb.onStopReason('end_turn', {
          input_tokens: 100,
          output_tokens: 10,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        })
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 2, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, TEST_CWD)

    await agent.run('hello', makeCallbacks())

    assert.equal(agent.getCacheDiagnostic(), null)
  })


  // Prewarm consumer revived (cc2f4f33 "revive prewarm dead store — wire the
  // consumer side"): full-file read_file calls serve from the prewarm cache
  // again. The truncation regression that originally disabled this is fixed in
  // prewarm-file.ts — the cache now stores FULL raw content and read-file.ts
  // applies the active contextWindow's cap at consume time, with mtime
  // re-verification guarding against stale serves.
  it('serves read_file from the prewarm cache on a repeat read of an unchanged file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-loop-prewarm-'))
    const filePath = join(dir, 'cached.txt')
    writeFileSync(filePath, 'cached content', 'utf-8')

    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        if (callCount === 1 || callCount === 3) {
          cb.onContentBlock(makeToolUseBlock(`tu_${callCount}`, 'read_file', { file_path: filePath }))
          cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 50 })
          return
        }
        cb.onContentBlock(makeTextBlock('done'))
        cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 50 })
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 2, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, dir)
    const callbacks = {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: (error: Error) => { throw error },
      onAbort: () => {},
      onApprovalRequired: async () => false,
    }

    await agent.run('read once', callbacks)
    assert.equal(agent.getPrewarmStats().hits, 0)

    await agent.run('read again', callbacks)
    // prewarmRecentReads() seeded cached.txt after run 1; run 2's full-file read
    // (no offset/limit) consumes it — mtime unchanged, so it's a live hit.
    assert.equal(agent.getPrewarmStats().hits, 1)

    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  it('respects maxTurns limit', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        cb.onContentBlock(makeToolUseBlock(`tu_${callCount}`, 'read_file', { file_path: '/test/file.txt' }))
        cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 50 })
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 3, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, TEST_CWD)

    await agent.run('loop test', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: () => {},
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    assert.ok(callCount <= 3, `callCount ${callCount} should be <= 3`)
    assert.equal(callCount, 3)
  })

  it('aborts during multi-turn loop', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        cb.onContentBlock(makeToolUseBlock(`tu_${callCount}`, 'read_file', { file_path: '/test/file.txt' }))
        cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 50 })
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 20, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, TEST_CWD)

    let aborted = false
    const runPromise = agent.run('abort test', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => { agent.abort() },
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: () => {},
      onAbort: () => { aborted = true },
      onApprovalRequired: async () => false,
    })

    await runPromise
    assert.equal(aborted, true)
  })

  it('delivers complete tool input after JSON accumulation', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        if (callCount === 1) {
          cb.onContentBlock(makeToolUseBlock('tu_json', 'read_file', { file_path: '/test/data.json', offset: 10, limit: 50 }))
          cb.onContentBlock(makeTextBlock('Reading...'))
          cb.onStopReason('tool_use', { input_tokens: 120, output_tokens: 60 })
        } else {
          cb.onContentBlock(makeTextBlock('Done.'))
          cb.onStopReason('end_turn', { input_tokens: 80, output_tokens: 20 })
        }
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, TEST_CWD)

    const toolInputs: Record<string, unknown>[] = []

    await agent.run('read with params', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: (_id, _name, input) => { toolInputs.push(input) },
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: () => {},
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    assert.equal(toolInputs.length, 1)
    assert.deepEqual(toolInputs[0], { file_path: '/test/data.json', offset: 10, limit: 50 })
  })

  it('delivers text from all turns including after tool_use and passes isFinal correctly', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        if (callCount === 1) {
          cb.onTextDelta('Reading file...')
          cb.onContentBlock(makeTextBlock('Reading file...'))
          cb.onContentBlock(makeToolUseBlock('tu_1', 'read_file', { file_path: '/test/package.json' }))
          cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 50 })
        } else {
          cb.onTextDelta('File contains hello world.')
          cb.onContentBlock(makeTextBlock('File contains hello world.'))
          cb.onStopReason('end_turn', { input_tokens: 200, output_tokens: 40 })
        }
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, TEST_CWD)

    const texts: string[] = []
    let intermediateCount = 0
    let finalCount = 0

    await agent.run('read package.json', {
      onTextDelta: (t) => texts.push(t),
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: (_u, _t, isFinal) => {
        if (isFinal === false) intermediateCount++
        if (isFinal === true) finalCount++
      },
      onError: (e) => { throw e },
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    const allText = texts.join('')
    assert.ok(allText.includes('Reading file...'), 'Turn 1 text should be delivered')
    assert.ok(allText.includes('File contains hello world.'), 'Turn 2 text should be delivered')
    assert.equal(intermediateCount, 1)
    assert.equal(finalCount, 1)
  })

  it('suppresses repeated pre-tool narration across tool-use turns', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        if (callCount === 1) {
          cb.onTextDelta('审查发现了 4 个中风险问题，全部修复。开始：')
          cb.onContentBlock(makeTextBlock('审查发现了 4 个中风险问题，全部修复。开始：'))
          cb.onContentBlock(makeToolUseBlock('tu_1', 'read_file', { file_path: '/test/a.ts' }))
          cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 50 })
        } else if (callCount === 2) {
          cb.onTextDelta('  审查发现了 4 个中风险问题，全部修复。开始：\n')
          cb.onContentBlock(makeTextBlock('  审查发现了 4 个中风险问题，全部修复。开始：\n'))
          cb.onContentBlock(makeToolUseBlock('tu_2', 'read_file', { file_path: '/test/b.ts' }))
          cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 50 })
        } else {
          cb.onTextDelta('完成。')
          cb.onContentBlock(makeTextBlock('完成。'))
          cb.onStopReason('end_turn', { input_tokens: 200, output_tokens: 40 })
        }
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, TEST_CWD)

    const texts: string[] = []

    await agent.run('fix review issues', {
      ...makeCallbacks(),
      onTextDelta: (t) => texts.push(t),
    })

    const allText = texts.join('')
    assert.equal(allText.match(/审查发现了 4 个中风险问题/g)?.length, 1)
    assert.ok(allText.includes('完成。'))
  })

  it('does not suppress new content after matching the previous turn fingerprint prefix', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    // 注意措辞：全文不能含"我来/让我/接下来 + 工具动词"等行动承诺，否则会
    // 触发 action-intent gate（10ecffa5）合法追加一轮，callCount 断言失真。
    const repeatedPrefix = '这个文件的核对结果如下。'
    const newContent = '第二个问题的分析已经完成。'
    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        if (callCount === 1) {
          cb.onTextDelta(repeatedPrefix)
          cb.onContentBlock(makeTextBlock(repeatedPrefix))
          cb.onContentBlock(makeToolUseBlock('tu_prefix', 'read_file', { file_path: '/test/a.ts' }))
          cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 50 })
          return
        }
        cb.onTextDelta(repeatedPrefix)
        cb.onTextDelta(newContent)
        cb.onContentBlock(makeTextBlock(repeatedPrefix + newContent))
        cb.onStopReason('end_turn', { input_tokens: 200, output_tokens: 40 })
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, TEST_CWD)
    const texts: string[] = []

    await agent.run('continue after prefix', {
      ...makeCallbacks(),
      onTextDelta: (t) => texts.push(t),
    })

    const allText = texts.join('')
    assert.ok(allText.includes(newContent), 'new content after a matching prefix must not be swallowed')
    assert.equal(callCount, 2)
  })
})

describe('AgentLoop — session lifecycle', () => {
  it('runs postSession before final turn completion', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)
    const events: string[] = []
    const runtimeHooks = new RuntimeHookPipeline([{
      phase: 'preTurn',
      name: 'test-perception',
      run: ctx => {
        ctx.effects.setSensorium({ momentum: 0.5, pressure: 0.1, confidence: 0.8, complexity: 0.2, freshness: 0.7, stability: 0.9 })
        ctx.effects.setStrategy({ reasoningEffort: 'medium', explorationBreadth: 0.3, commitThreshold: 0.6, shouldEscalate: false, thetaCycleInterval: 7 })
      },
    }, {
      phase: 'postSession',
      name: 'test-post-session',
      run: () => { events.push('postSession') },
    }])
    const client = mockClient([makeTextBlock('done')], 'end_turn')
    const agent = new AgentLoop({
      client,
      promptEngine: makeEngine(),
      toolRegistry: registry,
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      runtimeHooks,
    }, session, TEST_CWD)

    await agent.run('test prompt', {
      ...makeCallbacks(),
      onTurnComplete: (_usage, _turn, isFinal) => {
        if (isFinal) events.push('final')
      },
    })

    assert.deepEqual(events, ['postSession', 'final'])
  })

  it('abort callback fires before postSession (postSession detached, drained on demand)', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)
    const events: string[] = []
    const runtimeHooks = new RuntimeHookPipeline([{
      phase: 'preTurn',
      name: 'test-perception',
      run: ctx => {
        ctx.effects.setSensorium({ momentum: 0.5, pressure: 0.1, confidence: 0.8, complexity: 0.2, freshness: 0.7, stability: 0.9 })
        ctx.effects.setStrategy({ reasoningEffort: 'medium', explorationBreadth: 0.3, commitThreshold: 0.6, shouldEscalate: false, thetaCycleInterval: 7 })
      },
    }, {
      phase: 'postSession',
      name: 'test-post-session',
      // 慢 hook：detached 链在微任务里跑不完 → run() 返回时 postSession 必须还没跑
      //（回退到 inline await postSession 的实现会让下面第一条断言立刻变红）。
      run: async () => { await new Promise(r => setTimeout(r, 30)); events.push('postSession') },
    }])
    const client: StreamClient = {
      stream: mock.fn(async () => {
        throw new DOMException('Aborted', 'AbortError')
      }),
    } as unknown as StreamClient
    const agent = new AgentLoop({
      client,
      promptEngine: makeEngine(),
      toolRegistry: registry,
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      runtimeHooks,
    }, session, TEST_CWD)

    await agent.run('test prompt', {
      ...makeCallbacks(),
      onAbort: () => { events.push('abort') },
    })

    // 新契约（2026-09-13 Stop→settle 根治）：onAbort 不再阻塞等 postSession——
    // 收尾 hooks 进后台串行链，宿主（TUI notifyRunSettled / 服务端 running）立即翻转。
    assert.deepEqual(events, ['abort'], 'postSession 不得阻塞 onAbort')
    assert.equal(await agent.drainPostSession(5_000), true)
    assert.deepEqual(events, ['abort', 'postSession'], '后台链最终执行了 postSession')
  })
})

describe('AgentLoop — error handling', () => {
  it('persists partial assistant blocks before returning stream error', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        cb.onTextDelta('partial answer')
        cb.onContentBlock(makeTextBlock('partial answer'))
        throw new Error('stream dropped')
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 1, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, TEST_CWD)

    let errorMessage = ''
    await agent.run('hello', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: (err) => { errorMessage = err.message },
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    const messages = session.getMessages()
    assert.equal(errorMessage, 'stream dropped')
    assert.equal(messages.at(-1)?.role, 'assistant')
    assert.equal(messages.at(-1)?.content, 'partial answer')
  })

  it('handles tool execution errors gracefully and continues', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        if (callCount === 1) {
          cb.onContentBlock(makeToolUseBlock('tu_err', 'read_file', { file_path: '/nonexistent/file.txt' }))
          cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 50 })
        } else {
          cb.onContentBlock(makeTextBlock('The file was not found.'))
          cb.onStopReason('end_turn', { input_tokens: 150, output_tokens: 30 })
        }
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, TEST_CWD)

    const errors: string[] = []

    await agent.run('read bad file', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: (_id, _name, _result, isError) => {
        if (isError) errors.push('tool_error')
      },
      onTurnComplete: () => {},
      onError: () => {},
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    assert.equal(errors.length, 1)
    assert.equal(callCount, 2)
  })
})


describe('AgentLoop — compact policy', () => {
  it('compacts on small context windows without legacy absolute-threshold approval', async t => {
    const client = mockClient([makeTextBlock('done')])
    const registry = new ToolRegistry()
    const session = new SessionContext()
    const historyMessage = 'x'.repeat(12_000 * 4)
    // Reclaim-gate era (8582c7df): the fixture must contain genuinely
    // Valid call/result pairs keep the fixture compactable after API preflight.
    session.replaceMessages(Array.from({ length: 8 }, (_, i): OaiMessage[] => [
      { role: 'assistant', content: '', tool_calls: [{ id: `read_file_${i}`, type: 'function',
        function: { name: 'read_file', arguments: '{"path":"fixture.txt"}' } }] },
      { role: 'tool', tool_call_id: `read_file_${i}`, content: historyMessage },
    ]).flat())
    const agent = new AgentLoop({
      client,
      promptEngine: makeEngine(),
      toolRegistry: registry,
      maxTurns: 1,
      contextWindow: 128_000,
      compact: { enabled: true, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    }, session)
    const artifactDir = mkdtempSync(join(tmpdir(), 'rivet-loop-compact-'))
    t.after(() => rmSync(artifactDir, { recursive: true, force: true }))
    agent.artifactStore = new ArtifactStore(artifactDir, 'small-window')

    await agent.run('continue', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: () => {},
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    assert.ok(session.getCompactEvents().length > 0)
    assert.equal(session.getCompactEvents().at(-1)?.tier, 1)
    const archive = agent.artifactStore.list().find(item => item.tool === 'compact-history')
    assert.ok(archive, 'discarded tool bytes have a real recovery archive')
    const reopened = new ArtifactStore(artifactDir, 'small-window')
    const raw = await reopened.readRaw(archive.id)
    assert.ok(raw?.includes(historyMessage), 'original bytes survive reopening the artifact store')
    assert.ok(session.getMessages().some(message => message.role === 'tool'
      && message.content.includes(`[artifact:${archive.id}]`)))
  })


  it('falls back to cache anchors plus resume state when compaction cannot fit the ceiling', async () => {
    const client = mockClient([makeTextBlock('done')])
    const registry = new ToolRegistry()
    const session = new SessionContext()
    const huge = 'x'.repeat(80_000 * 4)
    session.replaceMessages([
      { role: 'user', content: 'anchor user' },
      { role: 'assistant', content: 'anchor assistant' },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
    ])
    const agent = new AgentLoop({
      client,
      promptEngine: makeEngine(),
      toolRegistry: registry,
      maxTurns: 1,
      contextWindow: 128_000,
      compact: { enabled: true, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    }, session)

    await agent.run('continue', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: () => {},
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    const messages = session.getMessages()
    assert.equal(messages[0]?.content, 'anchor user')
    assert.equal(messages[1]?.content, 'anchor assistant')
    assert.match(String(messages[2]?.content), /<checkpoint-resume>/)
    assert.ok(session.getEstimatedTokens() <= 128_000 * 0.95)
  })
})

describe('AgentLoop — active claims projection', () => {
  it('promotes user constraint anchors into active claim prompt context', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    const engine = makeEngine()
    const claimDir = mkdtempSync(join(tmpdir(), 'rivet-loop-claims-'))
    const claimStore = new ContextClaimStore(claimDir, 'session-123')

    let called = false
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        if (!called) {
          called = true
          // Capture the request for inspection
          cb.onContentBlock(makeTextBlock('done'))
          cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 50 })
          return
        }
        cb.onContentBlock(makeTextBlock('done'))
        cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 50 })
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({
      client,
      promptEngine: engine,
      toolRegistry: registry,
      maxTurns: 1,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      sessionId: 'session-123',
      contextClaimStore: claimStore,
    }, session, TEST_CWD)

    await agent.run('CRITICAL: always run tests before saying done', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onError: (error) => { throw error },
      onAbort: () => {},
      onTurnComplete: () => {},
      onApprovalRequired: async () => true,
    })

    // Verify the claim store recorded the claim
    const activeClaims = claimStore.listActiveClaims()
    assert.equal(activeClaims.length, 1)

    // Harness-only: activeClaims are no longer rendered into the LLM prompt (direction A)
    const streamMock = client.stream as unknown as ReturnType<typeof mock.fn>
    const callArgs = streamMock.mock.calls[0]!.arguments[0] as { messages: Array<{ role: string; content: string }> }
    const requestText = callArgs.messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n')

    assert.doesNotMatch(requestText, /<active-claims/)
    // Claim text still appears in the original user message (not the claims XML)
    assert.match(requestText, /always run tests before saying done/)
  })

  it('does not fabricate prompt consumers or auto-promote on repeated projection', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    const engine = makeEngine()
    const claimDir = mkdtempSync(join(tmpdir(), 'rivet-loop-promo-'))
    const claimStore = new ContextClaimStore(claimDir, 'session-123')

    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        cb.onContentBlock(makeTextBlock(`response ${callCount}`))
        cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 50 })
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({
      client,
      promptEngine: engine,
      toolRegistry: registry,
      maxTurns: 1,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      sessionId: 'session-123',
      contextClaimStore: claimStore,
    }, session, TEST_CWD)

    const cb = {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onError: (error: Error) => { throw error },
      onAbort: () => {},
      onTurnComplete: () => {},
      onApprovalRequired: async () => false,
    }

    // Prompt projection alone must NOT fabricate consumers or promote claims
    // (4a2bc7d5 "停止 refreshActiveClaims 虚假 prompt consumer 标记"): a claim merely
    // appearing in the active set each turn is not evidence the model consumed it,
    // so consumers stay empty and the claim never reaches durable_candidate via
    // refresh. Promotion requires real consumers (tool/test/worker channels).
    await agent.run('CRITICAL: always run tests before saying done', cb)
    await agent.run('continue', cb)
    await agent.run('continue again', cb)
    await agent.run('one more for promotion', cb)

    const [claim] = claimStore.listClaims()
    assert.ok(claim, 'user-input claim was proposed')
    assert.equal(claim?.status, 'active', 'stays active — no false prompt-consumer promotion')
    assert.equal(claim?.consumers.length, 0, 'no fabricated prompt consumers on refresh')
  })
})

describe('AgentLoop — antibody generation', () => {
  it('generates failure_pattern claim after tool error with classifiable failure', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    const engine = makeEngine()
    const claimDir = mkdtempSync(join(tmpdir(), 'rivet-loop-antibody-'))
    const claimStore = new ContextClaimStore(claimDir, 'session-ab')

    let toolCalled = false
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        if (!toolCalled) {
          toolCalled = true
          cb.onContentBlock(makeToolUseBlock('tu1', 'bash', { command: 'npx tsc --noEmit' }))
          cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 50 })
          return
        }
        cb.onContentBlock(makeTextBlock('I will fix the type error.'))
        cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 50 })
      }),
    } as unknown as StreamClient

    registry.register({
      definition: { name: 'bash', description: 'run bash', input_schema: { type: 'object', properties: { command: { type: 'string' } } } },
      execute: async () => ({ content: "error TS2345: Type 'string' is not assignable to type 'number'", isError: true }),
      isConcurrencySafe: () => false,
      isEnabled: () => true,
      requiresApproval: () => false,
    })

    const agent = new AgentLoop({
      client,
      promptEngine: engine,
      toolRegistry: registry,
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      sessionId: 'session-ab',
      contextClaimStore: claimStore,
    }, session, TEST_CWD)

    await agent.run('fix types', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onError: (error: Error) => { throw error },
      onAbort: () => {},
      onTurnComplete: () => {},
      onApprovalRequired: async () => true,
    })

    const antibodies = claimStore.listClaims({ kind: ['failure_pattern'] })
    assert.ok(antibodies.length >= 1, 'expected at least one failure_pattern claim')
    assert.ok(antibodies[0]!.tags.includes('antibody'), 'expected antibody tag')
    assert.ok(antibodies[0]!.text.includes('type_error'), 'expected type_error in text')
  })

  it('does not suppress first-turn text when it matches previous run last turn', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
        cb.onTextDelta('Hello! How can I help?')
        cb.onContentBlock(makeTextBlock('Hello! How can I help?'))
        cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 50 })
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop({
      client, promptEngine: makeEngine(), toolRegistry: registry,
      maxTurns: 5, contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    }, session, TEST_CWD)

    const texts1: string[] = []
    await agent.run('hello', {
      onTextDelta: (t) => texts1.push(t),
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: (e) => { throw e },
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    const texts2: string[] = []
    await agent.run('hello again', {
      onTextDelta: (t) => texts2.push(t),
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: (e) => { throw e },
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    assert.equal(texts1.join(''), 'Hello! How can I help?')
    assert.equal(texts2.join(''), 'Hello! How can I help?', 'second run text should not be suppressed by dedup')
  })
})

describe('AgentLoop — playbook telemetry bounds', () => {
  it('caps sensorium snapshots retained for playbook reflection', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register({
      definition: { name: 'noop', description: 'noop', input_schema: { type: 'object', properties: {} } },
      execute: async () => ({ content: 'ok' }),
      isConcurrencySafe: () => true,
      isEnabled: () => true,
      requiresApproval: () => false,
    })
    const dir = mkdtempSync(join(tmpdir(), 'rivet-loop-playbook-'))
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
        cb.onContentBlock(makeToolUseBlock(`tu_${session.getTurnCount()}`, 'noop', {}))
        cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 10 })
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop(
      { client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 120, contextWindow: 1_000_000,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' }, playbookStore: new PlaybookStore(dir) },
      session, TEST_CWD,
    )

    try {
      await agent.run('test prompt', {
        onTextDelta: () => {},
        onThinkingDelta: () => {},
        onToolUse: () => {},
        onToolResult: () => {},
        onTurnComplete: () => {},
        onError: (e) => { throw e },
        onAbort: () => {},
        onApprovalRequired: async () => false,
      })

      // The exact MAX_SNAPSHOTS=100 cap (and oldest-shifted eviction) is unit-
      // tested in turn-perception.test.ts. The loop's anti-loop guards stop the
      // run well before 120 iterations, so here we only assert the integration
      // invariant the loop actually guarantees: snapshots accumulate across
      // iterations and stay bounded by the cap — never growing unbounded.
      const snaps = agent['sensoriumSnapshots']
      assert.ok(snaps.length >= 1, 'at least one sensorium snapshot after a run()')
      assert.ok(snaps.length <= 100, `snapshots bounded by cap, got ${snaps.length}`)
      const firstTurn = snaps[0]!.turn
      const lastTurn = snaps[snaps.length - 1]!.turn
      // First snapshot is turn 0 when the run stops below the cap (no eviction);
      // once the cap evicts, the oldest retained turn climbs (covered in the unit test).
      assert.ok(firstTurn >= 0, 'turn is non-negative after a run()')
      assert.ok(lastTurn >= firstTurn, `last turn ${lastTurn} >= first ${firstTurn}`)
      assert.ok(lastTurn - firstTurn < 100, 'turn range should be bounded by maxTurns')
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
})

describe('AgentLoop — output token escalation', () => {
  it('accepts partial output on max_output_tokens without escalating', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
        callCount++
        cb.onTextDelta('Partial response...')
        cb.onContentBlock(makeTextBlock('Partial response...'))
        cb.onStopReason('max_output_tokens', { input_tokens: 100, output_tokens: 4096 })
      }),
    } as unknown as StreamClient

    const texts: string[] = []
    const agent = new AgentLoop(
      { client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } },
      session, TEST_CWD,
    )

    await agent.run('test prompt', {
      onTextDelta: (t) => texts.push(t),
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: (e) => { throw e },
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    // No escalation: partial output accepted, turn completes immediately
    assert.equal(callCount, 1)
    assert.ok(texts.some(t => t.includes('Partial response')))
  })

  it('completes turn on max_output_tokens without escalation loop', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    let callCount = 0
    let finalCount = 0

    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
        callCount++
        cb.onTextDelta(`chunk ${callCount}.`)
        cb.onContentBlock(makeTextBlock(`chunk ${callCount}.`))
        cb.onStopReason('max_output_tokens', { input_tokens: 100, output_tokens: 4096 })
      }),
    } as unknown as StreamClient

    const texts: string[] = []
    const agent = new AgentLoop(
      { client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 10, contextWindow: 1_000_000,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } },
      session, TEST_CWD,
    )

    await agent.run('test prompt', {
      onTextDelta: (t) => texts.push(t),
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: (_usage, _turn, isFinal) => {
        if (isFinal) finalCount++
      },
      onError: (e) => { throw e },
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    // No escalation: partial output accepted in a single turn
    assert.equal(callCount, 1)
    assert.equal(finalCount, 1)
    assert.ok(texts.some(t => t.includes('chunk 1')))
  })
})

describe('AgentLoop — worktree reality detection', () => {
  it('calls detectWorktreeReality and sets result on promptEngine', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    const engine = makeEngine()
    let worktreeRealitySet = false

    // Mock setWorktreeReality to track calls
    const originalSetWorktreeReality = engine.setWorktreeReality.bind(engine)
    engine.setWorktreeReality = (reality) => {
      worktreeRealitySet = true
      originalSetWorktreeReality(reality)
    }

    const client = mockClient([makeTextBlock('Done.')])
    const agent = new AgentLoop(
      {
        client,
        promptEngine: engine,
        toolRegistry: registry,
        maxTurns: 1,
        contextWindow: 1_000_000,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      },
      session,
      '/nonexistent-worktree-path', // Non-existent path will trigger worktree reality check
    )

    await agent.run('test', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: (e) => { throw e },
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    // setWorktreeReality should have been called during run()
    assert.ok(worktreeRealitySet, 'setWorktreeReality should be called')
  })
})

describe('AgentLoop — task contract 3-way branch', () => {
  it('extracts fresh contract on actionable input', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    const client = mockClient([makeTextBlock('Done.')])
    const agent = new AgentLoop(
      { client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } },
      session, TEST_CWD,
    )

    await agent.run('fix src/api/client.ts retry bug', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: (e) => { throw e },
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    const contract = agent.getTaskContract()
    assert.ok(contract, 'contract should be extracted for actionable input')
    assert.equal(contract!.objective, 'fix src/api/client.ts retry bug')
    assert.equal(contract!.status, 'exploring')
    assert.ok(contract!.isActionable)
  })

  it('clears contract when no active contract and input is non-actionable', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    const client = mockClient([makeTextBlock('Hello!')])
    const agent = new AgentLoop(
      { client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } },
      session, TEST_CWD,
    )

    await agent.run('你好', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: (e) => { throw e },
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    assert.equal(agent.getTaskContract(), undefined)
  })

  it('inherits existing contract on non-actionable follow-up', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
        callCount++
        cb.onTextDelta('Done.')
        cb.onContentBlock(makeTextBlock('Done.'))
        cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 50 })
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop(
      { client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } },
      session, TEST_CWD,
    )

    // First run: actionable → establishes contract
    await agent.run('fix src/api/client.ts retry bug', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: (e) => { throw e },
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    const contractAfterFirst = agent.getTaskContract()
    assert.ok(contractAfterFirst, 'contract should exist after actionable run')
    assert.equal(contractAfterFirst!.objective, 'fix src/api/client.ts retry bug')

    // Second run: non-actionable → inherits existing contract
    await agent.run('thanks', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: (e) => { throw e },
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    const contractAfterSecond = agent.getTaskContract()
    assert.ok(contractAfterSecond, 'contract should be inherited on non-actionable follow-up')
    assert.equal(contractAfterSecond!.objective, 'fix src/api/client.ts retry bug')
    assert.equal(contractAfterSecond!.id, contractAfterFirst!.id, 'contract id should remain the same')
  })

  it('clears contract on non-actionable follow-up when previous contract is ready_to_deliver', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)

    const client = mockClient([makeTextBlock('Done.')])
    const agent = new AgentLoop(
      { client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 5, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } },
      session, TEST_CWD,
    )

    // Seed a contract in ready_to_deliver state
    ;(agent as any).taskContract = {
      id: 'task-1-done',
      objective: 'previous task',
      scope: { mentionedFiles: [] },
      constraints: [],
      successCriteria: [],
      status: 'ready_to_deliver',
      createdAtTurn: 1,
      updatedAtTurn: 2,
      isActionable: true,
    }

    await agent.run('thanks', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
      onError: (e) => { throw e },
      onAbort: () => {},
      onApprovalRequired: async () => false,
    })

    assert.equal(agent.getTaskContract(), undefined, 'contract should be cleared when previous is ready_to_deliver')
  })
})

// ── Convergence + doom loop blocked → auto-complete ──

describe('AgentLoop — convergence recovery', () => {
  it('injects completion signal when convergence fires and doom loop is blocked', async () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()

    // Create a bash tool that returns predictable results
    const bashTool: Tool = {
      definition: {
        name: 'bash',
        description: 'Run shell command',
        input_schema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
      execute: async () => ({ content: 'ok' }),
      requiresApproval: () => false,
      isConcurrencySafe: () => true,
      isEnabled: () => true,
    }
    registry.register(bashTool)

    let callCount = 0
    // Simulate repeated git log calls: 8 tool_use turns all for the same bash command
    // This will:
    //  1. Fill fingerprint buffer with 8 identical entries → doomLoop = blocked
    //  2. Produce no edits, low novelty, low entropy → convergence score drops
    //  3. Combined: inject completion signal, then model finishes
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        if (callCount <= 8) {
          cb.onContentBlock(makeToolUseBlock(`tu_${callCount}`, 'bash', { command: 'git log --oneline' }))
          cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 30 })
        } else {
          cb.onContentBlock(makeTextBlock('All tasks complete. DELIVER_TASK returned GREEN.'))
          cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 30 })
        }
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop(
      {
        client, promptEngine: makeEngine(), toolRegistry: registry,
        maxTurns: 20, contextWindow: 200_000,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      },
      session,
      TEST_CWD,
    )

    let finalTurn = false
    const messages: string[] = []
    await agent.run('verify completed task', {
      onTextDelta: (text) => { messages.push(text) },
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: (_usage, _turn, isFinal) => { if (isFinal) finalTurn = true },
      onError: (e) => { throw e },
      onAbort: () => {},
      onApprovalRequired: async () => true,
    })

    // Should have completed the turn instead of looping indefinitely
    assert.ok(finalTurn, 'should complete turn after convergence + doom loop detection')
  })
})

// ── No-tool forced abort: prevents 10+ wasted LLM calls on repeated text ──
describe('AgentLoop — no-tool forced abort', () => {
  it('aborts after 5 consecutive text-only turns via thinking-retry path', async () => {
    const registry = new ToolRegistry()
    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
        callCount++
        // Produce thinking but no text/blocks → triggers thinking-retry → continue
        // After 1 retry, produce text-only → no tools → break
        // This pattern: think-only → think-only → ... → text → break
        // So consecutiveNoToolTurns won't accumulate here.
        // Instead, test the convergence abort via actual repeated text+tool pattern
        cb.onContentBlock(makeTextBlock(`Repeated analysis output #${callCount}`))
        cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 200 })
      }),
    } as unknown as StreamClient

    const agent = new AgentLoop(
      {
        client, promptEngine: makeEngine(), toolRegistry: registry,
        maxTurns: 30, contextWindow: 200_000,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      },
      new SessionContext(),
      TEST_CWD,
    )

    let turnCompletes = 0
    await agent.run('analyze gemini cli', {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: () => { turnCompletes++ },
      onError: (e) => { throw e },
      onAbort: () => {},
      onApprovalRequired: async () => true,
    })

    // Text-only turns break immediately (1 turn per run)
    assert.equal(turnCompletes, 1, 'text-only run should complete after 1 turn')
  })
})

// ── Fix 1/3: convergence "改道" emission cooldown + user-interaction reset ──
// Regression for the 星域·改道 spam incident: a persistent read-only stuck
// state used to re-emit the same 改道 card / phase-change / advisory every
// single turn. It must now be throttled, and reset when the user intervenes.
describe('AgentLoop — convergence emission cooldown', () => {
  function stuckLoop() {
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)
    const agent = new AgentLoop(
      {
        client: mockClient([makeTextBlock('x')]), promptEngine: makeEngine(), toolRegistry: registry,
        maxTurns: 40, contextWindow: 200_000,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      },
      new SessionContext(),
      TEST_CWD,
    )
    // Read-only history (single tool, distinct targets) → productive stagnation.
    const history = [
      { tool: 'read_file', status: 'success', target: 'a.ts' },
      { tool: 'read_file', status: 'success', target: 'b.ts' },
      { tool: 'read_file', status: 'success', target: 'c.ts' },
      { tool: 'read_file', status: 'success', target: 'd.ts' },
      { tool: 'read_file', status: 'success', target: 'e.ts' },
      { tool: 'read_file', status: 'success', target: 'f.ts' },
    ]
    agent.recentToolHistory = history as unknown as typeof agent.recentToolHistory
    return agent
  }

  it('throttles the 改道 emission instead of firing every turn', async () => {
    const agent = stuckLoop()
    // 墙钟下限（Layer 2）是独立的一道门：本用例断言的是 **cooldown** 节流，
    // 故显式关闭墙钟——否则墙钟恒拦停、shifts 恒为 1，cooldown 回归也测不出
    // （审查 09389b78e 指出）。
    agent.convergenceEmitMinIntervalMs = 0
    let shifts = 0
    const cb = { ...makeCallbacks(), onDecisionShift: () => { shifts++ } }

    // Same persistent stuck state across 6 turns (14..19), all level 2.
    for (let turn = 14; turn <= 19; turn++) {
      await agent.runConvergenceCheck(turn, 'plan', true, false, cb)
    }

    assert.ok(shifts >= 1, 'expected at least one 改道 emission')
    assert.ok(shifts < 6, `expected throttled emissions over 6 turns, got ${shifts}`)
    assert.ok(shifts <= 2, `cooldown=3 should cap emissions at 2 over turns 14..19, got ${shifts}`)
  })

  // ── B1b/M4（2026-07-23 信号互扰治理）：convergence advisory 的 expect 三分支 ──
  // build 变体从 expect: undefined 接上 course_changed——改道建议不再发后不管。

  function captureSubmits(agent: ReturnType<typeof stuckLoop>) {
    const entries: Array<{ key: string; expect?: { kind: string; tools?: string[] } }> = []
    const orig = agent.advisoryBus.submit.bind(agent.advisoryBus)
    agent.advisoryBus.submit = (e: Parameters<typeof orig>[0]) => {
      entries.push(e as (typeof entries)[number])
      return orig(e)
    }
    return entries
  }

  it('build 变体（filesModified>0）携带 course_changed 核销谓词 (B1b/M4)', async () => {
    const agent = stuckLoop()
    // build 态的真实构造（窗口分类语义）：窗口内非只读占比低于 0.8——
    // 8 条里 2 条 bash（productive）把只读率压到 0.75。filesModified 只影响
    // producingReport 豁免，不再单独决定 activityMode（窗口分类，W3）。
    agent.recentToolHistory = [
      { tool: 'read_file', status: 'success', target: 'a.ts' },
      { tool: 'grep', status: 'success', target: 'x' },
      { tool: 'bash', status: 'success', target: 'ls' },
      { tool: 'read_file', status: 'success', target: 'b.ts' },
      { tool: 'grep', status: 'success', target: 'y' },
      { tool: 'bash', status: 'success', target: 'ls dist' },
      { tool: 'read_file', status: 'success', target: 'c.ts' },
      { tool: 'grep', status: 'success', target: 'z' },
    ] as typeof agent.recentToolHistory
    agent.evidence.trackFileModified('src/x.ts')
    const submits = captureSubmits(agent)
    // 无编辑 execute 阶段在窗口内持续 → L2 shouldKick 发射（跨轮扫描以对
    // 未来的 tier/threshold 调整保持韧性，通常第一轮即发射）。
    for (let turn = 14; turn <= 20 && submits.length === 0; turn++) {
      await agent.runConvergenceCheck(turn, 'execute', true, false, makeCallbacks())
    }
    const conv = submits.find(e => e.key === 'convergence')
    assert.ok(conv, 'expected a convergence advisory emission')
    assert.equal(conv.expect?.kind, 'course_changed', 'build 变体必须携带 course_changed 谓词')
  })

  // 轮次 20：诊断态阶梯给了 4 轮额外余量，turn 14 的只读在 W3 分流下不算停滞。
  // 这里要证明的是「diagnostic 变体依然可达」——它是 B1b/M4 刻意保留的一等路径，
  // 若永不触发就成了死代码。
  it('对照:diagnostic 变体仍是认知工具 tool_appears（不受 B1b 影响）', async () => {
    const agent = stuckLoop() // 全只读历史 + filesModified=0 → diagnostic
    const submits = captureSubmits(agent)
    await agent.runConvergenceCheck(20, 'plan', true, false, makeCallbacks())
    const conv = submits.find(e => e.key === 'convergence')
    assert.ok(conv, 'expected a convergence advisory emission')
    assert.equal(conv.expect?.kind, 'tool_appears')
    assert.ok((conv.expect?.tools?.length ?? 0) > 0, 'diagnostic 变体带认知工具清单')
  })

  // ── Layer 2（2026-10-05）：发射门的凭证修正 ──
  // 冷却以 turn 计数，而只读诊断轮的墙钟极短——"3 轮冷却"在用户感知里只有
  // 几秒（实测会话 74f350c9：5 次告警，前 4 次落在 50 秒内）。墙钟下限只约束
  // 面向人的告警节奏；level 升级是真实信号跃迁，必须穿透。
  it('wall-clock floor blocks same-variant re-emission inside the interval (Layer 2)', async () => {
    const agent = stuckLoop()
    agent.convergenceEmitMinIntervalMs = 45_000
    let shifts = 0
    const cb = { ...makeCallbacks(), onDecisionShift: () => { shifts++ } }
    await agent.runConvergenceCheck(14, 'plan', true, false, cb) // 首次：无历史 → 放行
    // 冷却（3 turn）已过，但墙钟未过（同步调用，间隔 ≈0ms）
    await agent.runConvergenceCheck(18, 'plan', true, false, cb)
    assert.equal(shifts, 1, '墙钟下限必须拦住区间内的同变体重复发射')
  })

  it('level escalation pierces the wall-clock floor (Layer 2)', async () => {
    const agent = stuckLoop()
    agent.convergenceEmitMinIntervalMs = 45_000
    let shifts = 0
    const cb = { ...makeCallbacks(), onDecisionShift: () => { shifts++ } }
    await agent.runConvergenceCheck(14, 'plan', true, false, cb) // L2
    await agent.runConvergenceCheck(20, 'plan', true, false, cb) // L3 升级 → 必须放行
    assert.ok(shifts >= 2, `升级必须穿透墙钟下限，got ${shifts}`)
  })

  // ── Layer 2 遥测（后续 A）：让「这几次是被什么放行的」只从落盘数据可答 ──
  // 此前 messageVariant 与「为何未发射」只在 debugLog（需 RIVET_DEBUG=1），
  // 复盘只能靠 ui-history 事后推断。
  it('帧记录携带方向凭证与发射决策（Layer 2 遥测）', async () => {
    const agent = stuckLoop()
    agent.convergenceEmitMinIntervalMs = 45_000
    const captured: Array<Record<string, unknown>> = []
    agent.frameRecorder = {
      enabled: true,
      write: (r) => { captured.push(r as unknown as Record<string, unknown>) },
      flush: async () => {},
    } as typeof agent.frameRecorder

    await agent.runConvergenceCheck(14, 'plan', true, false, makeCallbacks()) // 首次 → 发射
    await agent.runConvergenceCheck(18, 'plan', true, false, makeCallbacks()) // 冷却已过、墙钟未过 → 被拦

    type Conv = { variant?: string | null; gate?: { emitted: boolean; suppressedBy: string | null } | null } | null
    const first = (captured[0]?.convergence ?? null) as Conv
    const second = (captured[1]?.convergence ?? null) as Conv

    assert.ok(first, '第一次应落一条含 convergence 的记录')
    assert.ok(first.variant, '记录必须带方向凭证（messageVariant）')
    assert.equal(first.gate?.emitted, true, '首次发射应记为 emitted')
    assert.equal(second?.gate?.emitted, false, '第二次应记为未发射')
    assert.equal(second?.gate?.suppressedBy, 'wall-clock', '第二次须记下被墙钟拦下')
  })

  it('对照:no-tool 变体仍是 tool_appears tools:[]（不受 B1b 影响）', async () => {
    const agent = stuckLoop()
    agent.consecutiveNoToolTurns = 2
    const submits = captureSubmits(agent)
    await agent.runConvergenceCheck(14, 'plan', true, false, makeCallbacks())
    const conv = submits.find(e => e.key === 'convergence')
    assert.ok(conv, 'expected a convergence advisory emission')
    assert.equal(conv.expect?.kind, 'tool_appears')
    assert.deepEqual(conv.expect?.tools, [], 'no-tool 变体 tools:[] = 任意工具打破僵局')
  })

  it('wording uses phase-relative turns, not the global session turn (W1, 20b9714e)', async () => {
    const agent = stuckLoop()
    let reason = ''
    const cb = {
      ...makeCallbacks(),
      onPhaseChange: (phase: string, detail?: { reason?: string }) => {
        if (phase === 'convergence-warning') reason = detail?.reason ?? ''
      },
    }

    // First check lands at global turn 90 — the phase baseline is set here, so
    // the message must talk about ~1 phase turn, never "90 轮".
    await agent.runConvergenceCheck(90, 'plan', true, false, cb)
    assert.ok(reason, 'expected a convergence warning emission')
    assert.ok(!reason.includes('90'), `wording must not leak the global turn count: ${reason}`)
    assert.ok(reason.includes('近 1 轮'), `expected phase-relative count in wording: ${reason}`)
  })

  // 轮次落在 20+ 而非 14+：`stuckLoop` 全只读无改动 → activityMode='diagnostic'，
  // W3 分流给诊断会话多 4 轮读取余量（起罚 turn≥12，见 convergence-detector 的
  // 诊断阶梯）。本用例考的是冷却重置语义，轮号只是脚手架 —— 取一个诊断态下确实
  // 算停滞的轮次即可，不要靠"14 轮只读就该被催"这个前提。
  it('user intervention resets the cooldown and skips that turn', async () => {
    const agent = stuckLoop()
    let shifts = 0
    const cb = { ...makeCallbacks(), onDecisionShift: () => { shifts++ } }

    await agent.runConvergenceCheck(20, 'plan', true, false, cb) // emit (cooldown start)
    assert.equal(shifts, 1, 'first turn should emit')

    await agent.runConvergenceCheck(21, 'plan', true, false, cb) // within cooldown → skip
    assert.equal(shifts, 1, 'within cooldown should not emit')

    await agent.runConvergenceCheck(21, 'plan', true, true, cb) // user intervened → skip + reset
    assert.equal(shifts, 1, 'user-intervention turn must not emit a nudge')

    await agent.runConvergenceCheck(22, 'plan', true, false, cb) // reset → emit despite <3 turns since last
    assert.equal(shifts, 2, 'cooldown should have been reset by user intervention, allowing an immediate re-emit')
  })
})

// ── P1 心流保护 Wave 3：真实 AgentLoop 接线（sensorium → flowInputs →
// evaluateConvergence）。不 mock computeFlowBeacon——走 runConvergenceCheck
// 完整路径，断言 latestConvergenceResult。
describe('AgentLoop — P1 flow beacon wiring (Wave 3)', () => {
  function flowAgent(sensorium: import('../sensorium.js').Sensorium | null) {
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)
    const agent = new AgentLoop(
      {
        client: mockClient([makeTextBlock('x')]), promptEngine: makeEngine(), toolRegistry: registry,
        maxTurns: 40, contextWindow: 200_000,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      },
      new SessionContext(),
      TEST_CWD,
    )
    // 同目标全 success 读 ×6 → score-based 低分形状（turn 8 = nLow 基线 L1），
    // 且 distanceToLastProductive = Infinity → productive stagnation 不参与。
    agent.recentToolHistory = Array.from({ length: 6 }, () => ({
      tool: 'read_file', status: 'success', target: 'a.ts',
    })) as unknown as typeof agent.recentToolHistory
    agent.sensorium = sensorium
    return agent
  }

  const healthySensorium = {
    momentum: 1, pressure: 0.1, confidence: 0.8, complexity: 0.2, freshness: 0.7, stability: 1,
    quality: { confidence: 'measured', momentum: 'measured', stability: 'measured' },
  } as import('../sensorium.js').Sensorium

  it('健康 sensorium 经真实路径延后 score-based L1（turn 8 L0，turn 10 仍到达）', async () => {
    const baseline = flowAgent(null)
    await baseline.runConvergenceCheck(8, 'explore', true, false, makeCallbacks())
    assert.equal(baseline.latestConvergenceResult?.level, 1, 'sensorium 缺失 → 旧行为基线 L1')

    const flowed = flowAgent(healthySensorium)
    await flowed.runConvergenceCheck(8, 'explore', true, false, makeCallbacks())
    assert.equal(flowed.latestConvergenceResult?.level, 0, '高 flow → turn 8 延后为 L0')

    const delayed = flowAgent(healthySensorium)
    await delayed.runConvergenceCheck(10, 'explore', true, false, makeCallbacks())
    assert.equal(delayed.latestConvergenceResult?.level, 1, '延后有界：turn 10 仍到达 L1')
  })

  it('反例：高 flow + 连续 no-tool 仍保持 no-tool 硬熔断语义', async () => {
    const agent = flowAgent(healthySensorium)
    agent.consecutiveNoToolTurns = 5
    await agent.runConvergenceCheck(12, 'execute', true, false, makeCallbacks())
    assert.equal(agent.latestConvergenceResult?.shouldAbort, true, '高 flow 不能救 no-tool 熔断')
    assert.equal(agent.latestConvergenceResult?.abortCause, 'no-tool')
  })

  it('反例：momentum no-data 的 sensorium 不进入保护态（资格门经真实路径生效）', async () => {
    const noData = {
      ...healthySensorium,
      quality: { confidence: 'measured', momentum: 'no-data', stability: 'measured' },
    } as import('../sensorium.js').Sensorium
    const agent = flowAgent(noData)
    await agent.runConvergenceCheck(8, 'explore', true, false, makeCallbacks())
    assert.equal(agent.latestConvergenceResult?.level, 1, 'no-data → 基线 L1 不变')
  })

  // ── P2 阴阳调度：structure-flow 快照经真实 runConvergenceCheck 接线 ──

  const healthyEfe = { epistemicValue: 0.15, pragmaticValue: 0.9, noveltyBonus: 0.2, precision: 0.9 }

  it('P2：EFE 缺失 → latestStructureFlow=null，P1 路径字节级不变', async () => {
    const agent = flowAgent(healthySensorium)
    assert.equal(agent.latestPolicySignals, undefined, '前置：EFE 未写入')
    await agent.runConvergenceCheck(8, 'explore', true, false, makeCallbacks())
    assert.equal(agent.latestStructureFlow, null, 'EFE 缺失 → 快照为 null')
    assert.equal(agent.latestConvergenceResult?.level, 0, 'P1 flow 路径继续生效（turn 8 延后 L0）')
  })

  it('P2：EFE 就绪 + 健康执行 → 快照 mode=flow，relaxation 经真实路径延后 L1', async () => {
    const agent = flowAgent(healthySensorium)
    agent.latestPolicySignals = { efe: healthyEfe, sensorium: healthySensorium }
    await agent.runConvergenceCheck(8, 'explore', true, false, makeCallbacks())
    assert.equal(agent.latestStructureFlow?.mode, 'flow')
    assert.ok(Math.abs((agent.latestStructureFlow?.relaxation ?? 0) - 0.25) < 1e-9)
    assert.equal(agent.latestConvergenceResult?.level, 0, 'P2 relaxation=0.25 → nLow 8→10 → L0')

    const delayed = flowAgent(healthySensorium)
    delayed.latestPolicySignals = { efe: healthyEfe, sensorium: healthySensorium }
    await delayed.runConvergenceCheck(10, 'explore', true, false, makeCallbacks())
    assert.equal(delayed.latestConvergenceResult?.level, 1, '延后有界：turn 10 仍到达 L1')
  })

  it('P2 hardTighten（连续失败≥2）压过 P1 放宽：同一形状下 P1 放行、P2 收紧', async () => {
    const failTailHistory = [
      ...Array.from({ length: 4 }, () => ({ tool: 'read_file', status: 'success', target: 'a.ts' })),
      { tool: 'read_file', status: 'failed', target: 'a.ts' },
      { tool: 'read_file', status: 'failed', target: 'a.ts' },
    ]
    // 对照组：EFE 缺失 → P1 flow（成功率 4/6 → score≈0.77 → 1.23× → nLow 10）→ L0
    const p1 = flowAgent(healthySensorium)
    p1.recentToolHistory = failTailHistory as unknown as typeof p1.recentToolHistory
    await p1.runConvergenceCheck(8, 'explore', true, false, makeCallbacks())
    assert.equal(p1.latestConvergenceResult?.level, 0, '前置：P1 路径下该形状放行 L0')

    // 实验组：EFE 就绪 → 尾部连续 2 failed → hardTighten → relaxation=0 且屏蔽 P1 → L1
    const p2 = flowAgent(healthySensorium)
    p2.recentToolHistory = failTailHistory as unknown as typeof p2.recentToolHistory
    p2.latestPolicySignals = { efe: healthyEfe, sensorium: healthySensorium }
    await p2.runConvergenceCheck(8, 'explore', true, false, makeCallbacks())
    assert.equal(p2.latestStructureFlow?.mode, 'tighten')
    assert.equal(p2.latestStructureFlow?.relaxation, 0)
    assert.equal(p2.latestConvergenceResult?.level, 1, 'hardTighten → 放松归零 → 基线 L1')
  })

  it('P2 反例：mode=flow 也不能救 no-tool 硬熔断', async () => {
    const agent = flowAgent(healthySensorium)
    agent.latestPolicySignals = { efe: healthyEfe, sensorium: healthySensorium }
    agent.consecutiveNoToolTurns = 5
    await agent.runConvergenceCheck(12, 'execute', true, false, makeCallbacks())
    assert.equal(agent.latestConvergenceResult?.shouldAbort, true)
    assert.equal(agent.latestConvergenceResult?.abortCause, 'no-tool')
  })

  it('P2：用户干预（userMessageConsumed）→ 快照 hardTighten 且 reason=user-intervened', async () => {
    const agent = flowAgent(healthySensorium)
    agent.latestPolicySignals = { efe: healthyEfe, sensorium: healthySensorium }
    await agent.runConvergenceCheck(8, 'explore', true, true, makeCallbacks())
    assert.equal(agent.latestStructureFlow?.mode, 'tighten')
    assert.ok(agent.latestStructureFlow?.reasons.includes('user-intervened'))
  })

  it('P2 plan advisory 去重键：用户干预与 plan 生命周期都清空（允许新语境重新建议）', async () => {
    const agent = flowAgent(healthySensorium)
    agent.structureFlowPlanAdvisoryKeys.add('structure-flow-plan:enter:unknown-domain')

    // 用户干预 → 清空
    await agent.runConvergenceCheck(8, 'explore', true, true, makeCallbacks())
    assert.equal(agent.structureFlowPlanAdvisoryKeys.size, 0, '用户干预清空去重键')

    // enterPlanMode → 清空
    agent.structureFlowPlanAdvisoryKeys.add('structure-flow-plan:exit')
    agent.enterPlanMode()
    assert.equal(agent.structureFlowPlanAdvisoryKeys.size, 0, 'enterPlanMode 清空去重键')

    // exitPlanMode → 清空
    agent.structureFlowPlanAdvisoryKeys.add('structure-flow-plan:enter:mixed-signals')
    agent.exitPlanMode()
    assert.equal(agent.structureFlowPlanAdvisoryKeys.size, 0, 'exitPlanMode 清空去重键')
  })

  // ── P3 认知帧：单一装配点经真实 runConvergenceCheck 接线（Wave 2）──

  it('P3：frame 恒产出且与 latestStructureFlow 同 turn 对应', async () => {
    const agent = flowAgent(healthySensorium)
    agent.latestPolicySignals = { efe: healthyEfe, sensorium: healthySensorium }
    await agent.runConvergenceCheck(8, 'explore', true, false, makeCallbacks())
    assert.ok(agent.latestCognitiveFrame, 'frame 恒产出')
    assert.equal(agent.latestCognitiveFrame.turn, 8)
    assert.equal(agent.latestCognitiveFrame.phaseClass, 'explore')
    assert.equal(agent.latestCognitiveFrame.quality.efe, 'measured')
    assert.equal(agent.latestStructureFlow?.mode, 'flow', '投影→控制器输出与 P2 一致')
  })

  it('P3：EFE 缺失 → frame 仍产出（quality=missing）但 latestStructureFlow=null', async () => {
    const agent = flowAgent(healthySensorium)
    await agent.runConvergenceCheck(8, 'explore', true, false, makeCallbacks())
    assert.ok(agent.latestCognitiveFrame, 'EFE 缺失时 frame 也要产出（可观测性）')
    assert.equal(agent.latestCognitiveFrame.quality.efe, 'missing')
    assert.equal(agent.latestStructureFlow, null, '投影 fail-closed → P2 旧行为路径')
    assert.equal(agent.latestConvergenceResult?.level, 0, 'P1 flow 路径继续生效')
  })

  it('P3：no-data sensorium 的质量标记经真实路径生效（partial，不伪装 measured）', async () => {
    const noData = {
      ...healthySensorium,
      quality: { confidence: 'measured', momentum: 'no-data', stability: 'measured' },
    } as import('../sensorium.js').Sensorium
    const agent = flowAgent(noData)
    agent.latestPolicySignals = { efe: healthyEfe, sensorium: noData }
    await agent.runConvergenceCheck(8, 'explore', true, false, makeCallbacks())
    assert.equal(agent.latestCognitiveFrame?.quality.sensorium, 'partial')
    assert.equal(agent.latestCognitiveFrame?.quality.flow, 'missing', 'no-data → beacon 不算 → flow missing')
  })

  it('P3：真实 runConvergenceCheck 产出的记录经回放零 divergence / 零 violation', async () => {
    const { buildCognitiveFrameRecord, replayCognitiveFrames } = await import('../cognitive-frame-replay.js')
    const agent = flowAgent(healthySensorium)
    agent.latestPolicySignals = { efe: healthyEfe, sensorium: healthySensorium }
    await agent.runConvergenceCheck(8, 'explore', true, false, makeCallbacks())
    const record = JSON.parse(JSON.stringify(buildCognitiveFrameRecord(
      agent.latestCognitiveFrame!,
      agent.latestStructureFlow,
      agent.latestConvergenceResult,
    )))
    const report = replayCognitiveFrames([record])
    assert.equal(report.checkedCount, 1)
    assert.deepEqual(report.divergences, [], '真实路径记录必须自洽可重算')
    assert.deepEqual(report.violations, [], '真实路径不得出现硬线违规')
  })

  it('P3：frame 不含控制结果（防 replay 把输出当输入）', async () => {
    const agent = flowAgent(healthySensorium)
    agent.latestPolicySignals = { efe: healthyEfe, sensorium: healthySensorium }
    await agent.runConvergenceCheck(8, 'explore', true, false, makeCallbacks())
    const serialized = JSON.stringify(agent.latestCognitiveFrame)
    for (const banned of ['relaxation', 'planRecommendation', '"mode"']) {
      assert.ok(!serialized.includes(banned), `frame 不得含控制结果: ${banned}`)
    }
  })

  it('P2：planning 态计入活跃计划上下文——稳定执行快照产出 exit 推荐', async () => {
    const agent = flowAgent(healthySensorium)
    agent.latestPolicySignals = { efe: healthyEfe, sensorium: healthySensorium }
    agent.enterPlanMode()
    // 需要 progress>0 才可能 exit：todo 推进由 getTodos 提供，这里直接用
    // todoCompletedDelta 路径不可注入，改为验证 activePlan 传入生效 ——
    // planning 态 + flow 模式下 planRecommendation 不为 'enter'。
    await agent.runConvergenceCheck(8, 'explore', true, false, makeCallbacks())
    assert.ok(agent.latestStructureFlow, 'EFE 就绪 → 快照存在')
    assert.notEqual(agent.latestStructureFlow?.planRecommendation, 'enter',
      'planning 态被视为活跃计划上下文，绝不推荐 enter')
  })
})

// ── Score-abort grace turn (session 8396ac51): the L3 abort must not fire in
// the same evaluation that emits its own warning — the injected advisory is
// consumed by the NEXT request, which never happens if we abort immediately.
describe('AgentLoop — convergence score-abort grace turn', () => {
  function degenerateAgent() {
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)
    const agent = new AgentLoop(
      {
        client: mockClient([makeTextBlock('x')]), promptEngine: makeEngine(), toolRegistry: registry,
        maxTurns: 40, contextWindow: 200_000,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      },
      new SessionContext(),
      TEST_CWD,
    )
    // Fully degenerate window: same tool, same target, repetitive thin text →
    // score bottoms out (level 3, shouldAbort, abortCause 'score').
    const history = Array.from({ length: 8 }, () => ({ tool: 'read_file', status: 'success', target: 'same.ts' }))
    agent.recentToolHistory = history as unknown as typeof agent.recentToolHistory
    agent.recentTextFingerprints = ['分析中', '分析中', '分析中']
    // Pre-seed a sustained declining score history so the L3 scoreAbort guard
    // (scoreDeclining over the signal window) is satisfied within two turns.
    agent.convergenceScoreHistory = [0.50, 0.40, 0.30, 0.20, 0.10, 0.04]
    return agent
  }

  // 轮次 24+：`degenerateAgent` 是全只读窗口 → activityMode='diagnostic'，W3 分流的
  // 诊断阶梯把最重档推到 turn≥24。这两条考的是 grace-turn 与用户介入重置，轮号只是
  // 脚手架；取一个 L3 确实可达的轮次，否则断言 'proceed' 会因为 L3 根本到不了而空过。
  it('demotes the first score-abort to a kick, then aborts on the next turn', async () => {
    const agent = degenerateAgent()
    let aborts = 0
    let shifts = 0
    const cb = { ...makeCallbacks(), onAbort: () => { aborts++ }, onDecisionShift: () => { shifts++ } }

    const first = await agent.runConvergenceCheck(24, 'execute', true, false, cb)
    assert.equal(first.action, 'proceed', 'first L3 hit must be demoted — no prior-turn warning was delivered')
    assert.equal(aborts, 0)
    assert.equal(shifts, 1, 'the demoted turn must still emit the warning/改道 so the model and user see it')

    const second = await agent.runConvergenceCheck(25, 'execute', true, false, cb)
    assert.equal(second.action, 'abort', 'still stuck one turn after the warning → abort proceeds')
    assert.equal(aborts, 1)
  })

  it('user intervention resets the ladder — the next score-abort demotes again', async () => {
    const agent = degenerateAgent()
    const cb = makeCallbacks()

    await agent.runConvergenceCheck(24, 'execute', true, false, cb) // demoted + warning
    await agent.runConvergenceCheck(25, 'execute', true, true, cb)  // user spoke → reset
    const after = await agent.runConvergenceCheck(26, 'execute', true, false, cb)
    assert.equal(after.action, 'proceed', 'post-intervention L3 hit must get a fresh grace turn, not an instant abort')
  })

  // ── B1c/M4（2026-07-23 信号互扰治理）：持续产出清 priorWarningAtL2Plus 旧账 ──
  // 此前警告台账只有用户干预会清——纯自主长跑中一旦 L2 发射,几十轮产出之后的
  // 任何跌分都能拿这笔陈旧警告直接 L3 熔断,跳过"先警告一轮"的 grace-turn。

  const healthyHistory = () => Array.from({ length: 8 }, (_, i) => (
    { tool: 'edit_file', status: 'success', target: `f${i}.ts` }
  ))
  const degenerateState = (agent: ReturnType<typeof degenerateAgent>) => {
    agent.recentToolHistory = Array.from({ length: 8 }, () => (
      { tool: 'read_file', status: 'success', target: 'same.ts' }
    )) as unknown as typeof agent.recentToolHistory
    agent.recentTextFingerprints = ['分析中', '分析中', '分析中']
    agent.convergenceScoreHistory = [0.50, 0.40, 0.30, 0.20, 0.10, 0.04]
  }

  it('连续 5 轮产出清警告旧账 → 之后的 L3 重新获得 grace turn (B1c/M4, 原缺陷复现)', async () => {
    const agent = degenerateAgent()
    let aborts = 0
    const cb = { ...makeCallbacks(), onAbort: () => { aborts++ } }

    const first = await agent.runConvergenceCheck(22, 'execute', true, false, cb) // L2 警告 + demote
    assert.equal(first.action, 'proceed')

    // 5 轮真实产出（PRODUCTIVE_TOOLS）——改道已被行为证实
    for (let t = 23; t <= 27; t++) {
      agent.recordToolHistory('edit_file', { file_path: `src/f${t}.ts` }, false, 'ok')
      agent.recentToolHistory = healthyHistory() as unknown as typeof agent.recentToolHistory
      await agent.runConvergenceCheck(t, 'execute', true, false, cb)
    }

    // 再次跌分触发 L3——旧账已清,必须先警告一轮而不是拿 6 轮前的警告直接熔断
    degenerateState(agent)
    const later = await agent.runConvergenceCheck(28, 'execute', true, false, cb)
    assert.equal(later.action, 'proceed', '旧账已清 → L3 demote 为 kick,重新给一次 grace turn')
    assert.equal(aborts, 0)
  })

  it('对照:5 轮全为只读（无产出）→ 台账保留,L3 照常熔断（保底检测不死）', async () => {
    const agent = degenerateAgent()
    let aborts = 0
    const cb = { ...makeCallbacks(), onAbort: () => { aborts++ } }

    await agent.runConvergenceCheck(22, 'execute', true, false, cb) // L2 警告 + demote
    for (let t = 23; t <= 27; t++) {
      agent.recordToolHistory('grep', { pattern: 'x' }, false, 'ok') // 非 PRODUCTIVE
      agent.recentToolHistory = healthyHistory() as unknown as typeof agent.recentToolHistory
      await agent.runConvergenceCheck(t, 'execute', true, false, cb)
    }
    degenerateState(agent)
    const later = await agent.runConvergenceCheck(28, 'execute', true, false, cb)
    assert.equal(later.action, 'abort', '无产出 → 陈旧警告仍有效 → 熔断保底')
    assert.equal(aborts, 1)
  })

  it('对照:产出 4 轮后断裂重计 → 台账未清,L3 仍熔断', async () => {
    const agent = degenerateAgent()
    const cb = makeCallbacks()

    await agent.runConvergenceCheck(22, 'execute', true, false, cb) // L2 警告 + demote
    for (let t = 23; t <= 26; t++) { // 只有 4 轮产出
      agent.recordToolHistory('edit_file', { file_path: `src/f${t}.ts` }, false, 'ok')
      agent.recentToolHistory = healthyHistory() as unknown as typeof agent.recentToolHistory
      await agent.runConvergenceCheck(t, 'execute', true, false, cb)
    }
    // 第 5 轮空转 → 计数断裂归零
    await agent.runConvergenceCheck(27, 'execute', true, false, cb)
    // 再产出 1 轮（streak=1,不足 5）
    agent.recordToolHistory('edit_file', { file_path: 'src/g.ts' }, false, 'ok')
    await agent.runConvergenceCheck(28, 'execute', true, false, cb)

    degenerateState(agent)
    const later = await agent.runConvergenceCheck(29, 'execute', true, false, cb)
    assert.equal(later.action, 'abort', '断裂重计后不足 5 轮 → 台账保留 → 熔断')
  })
})

describe('AgentLoop — recordToolHistory metadata threading', () => {
  it('writes errorClass into recentToolHistory entry (loop-factory drop-param guard)', () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)
    const client = mockClient([makeTextBlock('ok')])
    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 2, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, TEST_CWD)

    agent.recordToolHistory('bash', { command: 'sleep 99' }, true, '[timeout]', 'timeout')
    const entry = agent.recentToolHistory.at(-1)
    assert.equal(entry?.errorClass, 'timeout', 'errorClass must survive into the history entry')
    assert.equal(entry?.target, 'sleep 99', 'target should be stripped of cd boilerplate (none here)')
  })

  it('classifies the full bash command before truncating its history target', () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)
    const client = mockClient([makeTextBlock('ok')])
    const agent = new AgentLoop({ client, promptEngine: makeEngine(), toolRegistry: registry, maxTurns: 2, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, TEST_CWD)
    const command = `grep needle ${'a'.repeat(60)} && touch changed.txt`

    agent.recordToolHistory('bash', { command }, false, 'ok')

    const entry = agent.recentToolHistory.at(-1)
    assert.equal(entry?.target.includes('touch'), false, '前置：历史 target 已截断掉写后缀')
    assert.equal(entry?.bashActivity, 'productive', '效果标签必须来自未截断的完整 command')
  })
})

describe('formatActivePlanPointer', () => {
  it('emits a slug/title/path pointer without the plan body', () => {
    const out = formatActivePlanPointer({ slug: 'my-plan', title: 'My Plan' })
    assert.match(out, /^<active-plan /)
    assert.match(out, /slug="my-plan"/)
    assert.match(out, /title="My Plan"/)
    assert.match(out, /path="\.rivet\/plans\/my-plan\.md"/)
    assert.match(out, /todo/)
  })

  it('escapes XML special characters in slug and title', () => {
    const out = formatActivePlanPointer({ slug: 'a&b', title: 'Fix <tag> & "q"' })
    assert.doesNotMatch(out.replace(/path="[^"]*"/, ''), /<tag>/)
    assert.match(out, /&amp;/)
    assert.match(out, /&lt;tag&gt;/)
    assert.match(out, /&quot;q&quot;/)
  })

  it('includes selected approach when provided', () => {
    const out = formatActivePlanPointer({
      slug: 'my-plan',
      title: 'My Plan',
      selectedApproach: 'Redis cache (Recommended)',
    })
    assert.match(out, /已选方案/)
    assert.match(out, /Redis cache/)
  })
})

describe('AgentLoop — plan mode lifecycle (2026-07-03 缺陷复盘)', () => {
  function makeAgent() {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)
    const client = mockClient([makeTextBlock('ok')])
    const engine = makeEngine()
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-planmode-'))
    const agent = new AgentLoop({ client, promptEngine: engine, toolRegistry: registry, maxTurns: 2, contextWindow: 1_000_000, compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' } }, session, cwd)
    return { agent, engine, cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) }
  }

  it('enterPlanMode mounts no skill pin and unmounts the <plan-executing> block on re-entry', () => {
    const { agent, engine, cleanup } = makeAgent()
    try {
      // Approve a plan first to mount the execution advisory…
      agent.enterPlanMode()
      agent.setActivePlan({ slug: 'p', title: 'P' })
      assert.ok(engine.getPlanExecutingBlock(), 'execution advisory mounted on approval')
      // …then re-enter plan mode: no skill pin, and the advisory unmounts
      // (execution completion has no mechanical signal — re-entry is the
      // documented unmount point).
      agent.enterPlanMode()
      assert.ok(
        !engine.getInvokedSkillNames().includes('writing-plans'),
        'no skill pin on enter — native <plan-mode> block replaced the writing-plans skill',
      )
      assert.equal(engine.getPlanExecutingBlock(), null, 're-entering plan mode unmounts the execution advisory')
    } finally {
      cleanup()
    }
  })

  it('setActivePlan (approval) mounts the native execution advisory and leaves plan mode', () => {
    const { agent, engine, cleanup } = makeAgent()
    try {
      agent.enterPlanMode()
      agent.setActivePlan({ slug: 'p', title: 'P' })
      assert.ok(!engine.getInvokedSkillNames().includes('writing-plans'), 'no writing-plans pin remains')
      assert.ok(engine.getPlanExecutingBlock()?.includes('<plan-executing>'), 'native execution advisory mounted')
      assert.equal(agent.getPlanModeState(), 'off')
      assert.equal(agent.getActivePlanFilePath(), null)
    } finally {
      cleanup()
    }
  })

  it('enterPlanMode is idempotent — re-entry keeps the current draft', () => {
    const { agent, cleanup } = makeAgent()
    try {
      agent.enterPlanMode()
      const first = agent.getActivePlanFilePath()
      assert.ok(first, 'draft created on first enter')
      agent.enterPlanMode()
      assert.equal(agent.getActivePlanFilePath(), first, 're-entry must not orphan the draft being written')
    } finally {
      cleanup()
    }
  })

  it('explicit planFilePath (rejection revision) still retargets while planning', () => {
    const { agent, cleanup } = makeAgent()
    try {
      agent.enterPlanMode()
      agent.enterPlanMode({ planFilePath: '.rivet/plans/my-plan.md' })
      assert.equal(agent.getActivePlanFilePath(), '.rivet/plans/my-plan.md')
    } finally {
      cleanup()
    }
  })

  it('exitPlanMode removes an untouched empty draft but keeps written ones', () => {
    const { agent, cwd, cleanup } = makeAgent()
    try {
      agent.enterPlanMode()
      const emptyDraft = join(cwd, agent.getActivePlanFilePath()!)
      agent.exitPlanMode()
      assert.ok(!existsSync(emptyDraft), 'empty draft cleaned up — no .rivet/plans litter from toggling')

      agent.enterPlanMode()
      const writtenDraft = join(cwd, agent.getActivePlanFilePath()!)
      writeFileSync(writtenDraft, '# Draft\n\ncontent\n', 'utf-8')
      agent.exitPlanMode()
      assert.ok(existsSync(writtenDraft), 'non-empty draft preserved')
    } finally {
      cleanup()
    }
  })

  it('exitPlanMode drops the draft from ownership（8784b64b8 审查 P1 W1-2）', () => {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-planmode-own-'))
    const taskLedger = createTaskLedger({ taskId: 'plan-draft-release' })
    const ownershipLedger = createOwnershipLedger({
      baseline: createWorktreeBaseline({
        branch: 'main', head: 'abc123', preExistingDirty: [], preExistingUntracked: [], capturedAt: Date.now(),
      }),
      taskLedger,
    })
    const agent = new AgentLoop({
      client: mockClient([makeTextBlock('ok')]), promptEngine: makeEngine(), toolRegistry: registry,
      taskLedger, ownershipLedger, maxTurns: 2, contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    }, session, cwd)
    try {
      agent.enterPlanMode()
      const draft = agent.getActivePlanFilePath()!
      assert.match(draft, /^\.rivet\/plans\/draft-\d+\.md$/, '前置：活动草稿路径形状')
      // 模拟 tool-pipeline.ts:1726 的写时登记：写草稿 → ledger 事件 + registerOwned。
      taskLedger.record({ type: 'file_write', path: draft })
      ownershipLedger.registerOwned(draft)
      assert.equal(ownershipLedger.isOwned(draft), true, '前置：草稿写入后确实进了归属集合')

      agent.exitPlanMode()

      assert.equal(
        ownershipLedger.isOwned(draft), false,
        '释放草稿必须同时清归属——只删 ledger 事件时草稿仍留在 owned-file 列表与交付范围（无写事件支撑的幽灵归属）',
      )
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('T01：草稿写入→退出→代码验证 全程 fresh，草稿不残留（§10 验收矩阵，真实持久化层）', () => {
    const home = mkdtempSync(join(tmpdir(), 'rivet-loop-home-'))
    const prevHome = process.env.RIVET_HOME
    process.env.RIVET_HOME = home
    const cwd = mkdtempSync(join(home, 'repo-'))
    const git = (...args: string[]) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
      assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
      return r.stdout.trim()
    }
    git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T')
    writeFileSync(join(cwd, 'owned.ts'), 'original')
    git('add', '--', 'owned.ts'); git('commit', '-qm', 'initial')

    const state = createPersistentTaskState(cwd, 'loop-draft-e2e', {
      branch: 'main', head: git('rev-parse', 'HEAD'), preExistingDirty: [], preExistingUntracked: [], capturedAt: Date.now(),
    })
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)
    const agent = new AgentLoop({
      client: mockClient([makeTextBlock('ok')]), promptEngine: makeEngine(), toolRegistry: registry,
      taskLedger: state.taskLedger, ownershipLedger: state.ownership, maxTurns: 2, contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    }, session, cwd)
    try {
      // 既有代码证据：改文件 + 记验证。
      writeFileSync(join(cwd, 'owned.ts'), 'modified')
      state.taskLedger.record({ type: 'file_write', path: 'owned.ts' })
      state.taskLedger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full' } })
      assert.equal(getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 1, '前置：代码验证有效')

      // plan mode：写草稿走 tool-pipeline.ts:1726 的真实路径（file_write + 归属）。
      agent.enterPlanMode()
      const draft = agent.getActivePlanFilePath()!
      state.taskLedger.record({ type: 'file_write', path: draft })
      assert.equal(state.ownership.isOwned(draft), true, '前置：草稿写入后进了归属（autoOwnFromLedger）')
      assert.equal(
        getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 1,
        'plan mode 里写草稿不得作废此前跑过的代码验证',
      )

      agent.exitPlanMode()

      assert.equal(state.ownership.isOwned(draft), false, '退出后草稿不残留归属')
      assert.equal(state.taskLedger.getEvents().some(e => e.path === draft), false, '退出后草稿不残留事件')
      assert.equal(
        getEffectiveVerifications(state.taskLedger.getEvents()).effective.length, 1,
        '退出后既有验证仍 fresh——草稿的写与删都不该动代码证据',
      )
    } finally {
      if (prevHome === undefined) delete process.env.RIVET_HOME
      else process.env.RIVET_HOME = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('AgentLoop — setReasoningEffort 调用来源分流（2026-07-25 advisory-ecology W1）', () => {
  function makeAgent(autoReasoning = false) {
    const session = new SessionContext()
    const registry = new ToolRegistry()
    registry.register(READ_FILE_TOOL)
    const client = mockClient([makeTextBlock('ok')])
    const agent = new AgentLoop({
      client,
      promptEngine: makeEngine(),
      toolRegistry: registry,
      maxTurns: 2,
      contextWindow: 1_000_000,
      autoReasoning,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    }, session, TEST_CWD)
    return agent
  }

  it('user 路径置 override，/effort auto 清除（既有行为不回归）', () => {
    const agent = makeAgent()
    assert.equal(agent.userReasoningOverride, false)
    agent.setReasoningEffort('high')
    assert.equal(agent.userReasoningOverride, true, '/effort high → override 置真')
    agent.setReasoningEffort('auto')
    assert.equal(agent.userReasoningOverride, false, '/effort auto → 交还 autoReasoning')
  })

  it('programmatic 路径不动 override（strategy effort 每轮透传不架空 autoReasoning）', () => {
    const agent = makeAgent()
    agent.setReasoningEffort('medium', 'programmatic')
    assert.equal(agent.userReasoningOverride, false, '程序化设置不得伪装成用户手动')

    // 用户已 override 后，程序化 'auto' 也不得偷偷清除用户选择
    agent.setReasoningEffort('max')
    agent.setReasoningEffort('auto', 'programmatic')
    assert.equal(agent.userReasoningOverride, true, '程序化 auto 不清用户 override')
  })

  it('S4a 回归：跑完一整轮后 override 仍为 false（perception 每轮的 effort 路由不再污染）', async () => {
    const agent = makeAgent(true)
    assert.equal(agent.userReasoningOverride, false)
    await agent.run('hello', makeCallbacks())
    assert.equal(
      agent.userReasoningOverride, false,
      'perception → routeRoutineEffort → setReasoningEffort 是程序化路径；' +
      '此前它每轮把 override 置真，自第 2 轮起永久架空关键词 autoReasoning',
    )
  })
})

import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Writable cwd: AgentLoop turn-cache telemetry fire-and-forgets a mkdir under
// cwd; an unwritable TEST_CWD sentinel makes that async write reject after the
// test ends, leaking an unhandledRejection onto later tests in the same run.
const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-loop-cwd-'))
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import type { StreamCallbacks } from '../../api/stream-client.js'
import type { StreamClient } from '../../api/stream-client.js'
import type { ContentBlock, ToolDefinition } from '../../api/types.js'
import type { Tool, ToolCallParams, ToolResult } from '../../tools/types.js'

function makeToolUseBlock(id: string, name: string, input: Record<string, unknown>): ContentBlock {
  return { type: 'tool_use', id, name, input }
}

function makeEngine(tools: ToolDefinition[]): PromptEngine {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools },
    volatileCtx: { cwd: TEST_CWD },
  })
}

function makeWriteTool(execute: () => Promise<ToolResult>): Tool {
  return {
    definition: {
      name: 'write_file',
      description: 'write a file',
      input_schema: {
        type: 'object',
        properties: { file_path: { type: 'string' }, content: { type: 'string' } },
        required: ['file_path', 'content'],
      },
    },
    execute: async (_params: ToolCallParams) => execute(),
    requiresApproval: () => true,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  }
}

function mockToolUseClient(block: ContentBlock): StreamClient {
  let calls = 0
  return {
    stream: mock.fn(async (_req: unknown, cb: StreamCallbacks, _sig?: AbortSignal) => {
      calls++
      if (calls === 1) {
        cb.onContentBlock(block)
        cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 10 })
        return
      }
      cb.onTextDelta('done')
      cb.onContentBlock({ type: 'text', text: 'done' })
      cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 10 })
    }),
  } as unknown as StreamClient
}

function makeCallbacks(results: string[]) {
  return {
    onTextDelta: () => {},
    onThinkingDelta: () => {},
    onToolUse: () => {},
    onToolResult: (_id: string, _name: string, result: string) => { results.push(result) },
    onTurnComplete: () => {},
    onError: (error: Error) => { throw error },
    onAbort: () => {},
    onApprovalRequired: async () => true,
  }
}

describe('AgentLoop reliability integration', () => {
  it('samples resource pressure and blocks write tools before execution', async () => {
    let executed = false
    const writeTool = makeWriteTool(async () => {
      executed = true
      return { content: 'wrote', isError: false }
    })
    const registry = new ToolRegistry()
    registry.register(writeTool)
    const session = new SessionContext()
    const client = mockToolUseClient(makeToolUseBlock('tu-write', 'write_file', {
      file_path: 'out.txt',
      content: 'hello',
    }))
    const agent = new AgentLoop({
      client,
      promptEngine: makeEngine([writeTool.definition]),
      toolRegistry: registry,
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      resourceSensorOptions: {
        memoryLimitBytes: 1_000,
        memoryUsage: () => ({ rss: 750, heapUsed: 750 }),
        // e1af595e0 后 DEFAULT_MEMORY_COOLDOWN_SAMPLES 非 0——不显式清零会被
        // cooldown 压制 resource pressure，degraded 拦截不触发（既有红修复）。
        initialMemoryCooldownSamples: 0,
      },
    }, session, TEST_CWD)

    const results: string[] = []
    await agent.run('write out.txt', makeCallbacks(results))

    assert.equal(executed, false)
    assert.ok(
      results.some(result => result.includes('Tool execution blocked by reliability mode: degraded')),
      `expected degraded reliability block, got:\n${results.join('\n---\n')}`,
    )
    assert.ok(
      results.some(result => result.includes('Heap used at 75.0% of limit')),
      `expected resource evidence, got:\n${results.join('\n---\n')}`,
    )
    assert.equal(agent.getReliabilityDecision()?.mode, 'degraded')
  })
})

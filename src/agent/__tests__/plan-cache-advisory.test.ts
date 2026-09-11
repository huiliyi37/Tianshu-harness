import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PromptEngine } from '../../prompt/engine.js'
import { buildDynamicAppendix, buildStableVolatileBlock } from '../../prompt/volatile.js'
import { ToolRegistry } from '../../tools/registry.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'
import type { OaiChatRequest } from '../../api/oai-types.js'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { P3Integration } from '../p3-integration.js'
import { PLAN_CACHE_ADVISORY_MAX_CHARS, renderPlanCacheAdvisory } from '../plan-cache-advisory.js'

function makeEngine(cwd: string): PromptEngine {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [] },
    volatileCtx: { cwd },
  })
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

function makeCaptureClient(calls: OaiChatRequest[]): StreamClient {
  return {
    stream: mock.fn(async (request: OaiChatRequest, cb: StreamCallbacks) => {
      calls.push(request)
      cb.onTextDelta('done')
      cb.onContentBlock({ type: 'text', text: 'done' })
      cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 20 })
    }),
  } as unknown as StreamClient
}

function allMessageText(request: OaiChatRequest | undefined): string {
  return request?.messages
    .map(message => typeof message.content === 'string' ? message.content : '')
    .join('\n') ?? ''
}

describe('PlanCache advisory rendering', () => {
  it('returns null on PlanCache miss', () => {
    const p3 = new P3Integration()
    assert.equal(renderPlanCacheAdvisory(p3.planCacheSuggest('unseen task')), null)
  })

  it('renders a short informational-only advisory on hit', () => {
    const p3 = new P3Integration()
    p3.recordPlan('fix bug in src/a.ts', [
      { tool: 'read_file', target: 'src/a.ts' },
      { tool: 'write_file', target: 'src/a.ts' },
      { tool: 'run_tests', target: 'src/agent/__tests__/a.test.ts' },
    ])

    const advisory = renderPlanCacheAdvisory(p3.planCacheSuggest('fix bug in src/a.ts'))

    assert.ok(advisory)
    assert.match(advisory, /<plan-cache-advisory>/)
    assert.match(advisory, /write_file/)
    assert.match(advisory, /Informational only — not auto-executed\./)
    assert.ok(advisory.length <= PLAN_CACHE_ADVISORY_MAX_CHARS)
  })

  it('escapes XML and clamps long suggestions to the advisory budget', () => {
    const raw = `PlanCache hit\n  - read_file → src/<danger-${'x'.repeat(2_000)}>.ts\n(Informational only — not auto-executed.)`
    const advisory = renderPlanCacheAdvisory(raw)

    assert.ok(advisory)
    assert.ok(advisory.length <= PLAN_CACHE_ADVISORY_MAX_CHARS)
    assert.match(advisory, /&lt;danger-/)
    assert.doesNotMatch(advisory, /<danger-/)
    assert.match(advisory, /Informational only — not auto-executed\./)
  })

  it('is dynamic appendix only and never enters stable volatile context', () => {
    const advisory = renderPlanCacheAdvisory('PlanCache hit\n  - read_file → src/a.ts')!
    const stable = buildStableVolatileBlock({ cwd: '/repo', planCacheAdvisory: advisory })
    const dynamic = buildDynamicAppendix({ cwd: '/repo', planCacheAdvisory: advisory })

    assert.doesNotMatch(stable, /plan-cache-advisory/)
    assert.match(dynamic, /<plan-cache-advisory>/)
  })
})

describe('AgentLoop PlanCache advisory wiring', () => {
  it('does not inject advisory on PlanCache miss', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-plan-cache-miss-'))
    const calls: OaiChatRequest[] = []
    try {
      const agent = new AgentLoop({
        client: makeCaptureClient(calls),
        promptEngine: makeEngine(cwd),
        toolRegistry: new ToolRegistry(),
        maxTurns: 1,
        contextWindow: 1_000_000,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        fsWatcherEnabled: false,
      }, new SessionContext(), cwd)

      await agent.run('fix unrelated issue in src/miss.ts', makeCallbacks())

      assert.doesNotMatch(allMessageText(calls[0]), /plan-cache-advisory/)
    } finally {
      rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    }
  })

  it('injects hit advisory without auto-executing cached write-tool steps', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-plan-cache-hit-'))
    const calls: OaiChatRequest[] = []
    let toolExecuted = false
    try {
      const registry = new ToolRegistry()
      const agent = new AgentLoop({
        client: makeCaptureClient(calls),
        promptEngine: makeEngine(cwd),
        toolRegistry: registry,
        maxTurns: 1,
        contextWindow: 1_000_000,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        fsWatcherEnabled: false,
      }, new SessionContext(), cwd)
      agent.p3.recordPlan('fix bug in src/a.ts', [
        { tool: 'read_file', target: 'src/a.ts' },
        { tool: 'write_file', target: 'src/a.ts' },
      ])
      ;(agent.p3 as any).tryJIT = async () => {
        throw new Error('tryJIT must not be called for advisory-only PlanCache hits')
      }
      registry.execute = mock.fn(async () => {
        toolExecuted = true
        return { content: 'unexpected' }
      }) as any

      await agent.run('fix bug in src/a.ts', makeCallbacks())

      const text = allMessageText(calls[0])
      assert.match(text, /<plan-cache-advisory>/)
      assert.match(text, /write_file/)
      assert.match(text, /Informational only — not auto-executed\./)
      assert.equal(toolExecuted, false)
    } finally {
      rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    }
  })
})

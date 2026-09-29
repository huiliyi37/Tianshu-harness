/**
 * U6 integration — PlanExecutionTrace driven through the loop's composition.
 *
 * Two layers:
 *  1. Lifecycle scenarios over the pure functions in the exact order the loop
 *     drives them (capturePlanSteps → appendResult → detectDeviation →
 *     correctPlan → serializeTrace). Mirrors U5 W5d's 5 scenarios + reverse cases.
 *  2. A live AgentLoop wiring test: a scripted model calls `todo`, which seeds
 *     the trace via onPlanSteps → capturePlanSteps; the loop then serializes the
 *     trace onto the engine's plan-trace appendix surface (the cache-safe surface
 *     that survives compaction and refreshes at the next user-message boundary).
 *
 *  Why we assert on setPlanTraceAppendix rather than the model request: the
 *  dynamic appendix is FROZEN within a single user message for prefix-cache
 *  stability, so the serialized trace does not appear in same-turn requests —
 *  it flows to the model only at the next user-message boundary. Mid-task course
 *  correction therefore rides a system-reminder instead (see runReplanCheck).
 *  Spying the persistence surface proves the full callback chain end-to-end
 *  without coupling to cache timing or per-task contract-id resets.
 */
import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createTrace,
  appendResult,
  detectDeviation,
  serializeTrace,
  buildPlanSteps,
  withPlanSteps,
  type PlanExecutionTrace,
  type StepResult,
} from '../plan-execution-trace.js'
import { correctPlan, injectReplanContext } from '../replan-loop.js'

import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { TODO_TOOL } from '../../tools/todo.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'
import type { OaiChatRequest } from '../../api/oai-types.js'
import type { ContentBlock } from '../../api/types.js'

// ─── Layer 1: trace lifecycle (loop composition over pure fns) ────

/** Mirror AgentLoop.buildStepResultFromTurn's step mapping. */
function stepResultFor(trace: PlanExecutionTrace, turn: number, tools: string[], failed = false): StepResult {
  const active = trace.steps.find(s => s.status === 'active' || s.status === 'pending')
  return {
    stepId: active?.id ?? `turn-${turn}`,
    turnNumber: turn,
    toolCalls: tools.map(t => ({ tool: t, result_summary: 'ok' })),
    status: failed ? 'blocked' : 'done',
  }
}

describe('U6 trace lifecycle', () => {
  it('scenario 1: full lifecycle — seed → advance all → replanned → completed', () => {
    let trace = createTrace('c1', 'system')
    trace = withPlanSteps(trace, buildPlanSteps(['读取理解现状', '修改逻辑', '跑测试验证'], 'system'))
    assert.equal(trace.steps.length, 3)

    // three successful tool-turns advance the steps in order
    for (let turn = 1; turn <= 3; turn++) {
      trace = appendResult(trace, stepResultFor(trace, turn, ['read_file']))
    }
    assert.ok(trace.steps.every(s => s.status === 'done'))

    const deviation = detectDeviation(trace, trace.history.at(-1), 0, 0)
    assert.equal(deviation.type, 'replanned')
    const { trace: done } = correctPlan(trace, deviation)
    assert.equal(done.status, 'completed')

    const xml = serializeTrace(done)
    assert.match(xml, /status="completed"/)
    assert.match(xml, /读取理解现状/)
  })

  it('scenario 2: blocked correction — 3 failures + convergence L2 → 诊断 step', () => {
    let trace = createTrace('c1', 'unit')
    trace = withPlanSteps(trace, buildPlanSteps(['尝试构建'], 'unit'))
    for (let turn = 1; turn <= 3; turn++) {
      trace = appendResult(trace, stepResultFor(trace, turn, ['bash'], true))
    }
    const deviation = detectDeviation(trace, trace.history.at(-1), 2, 0)
    assert.equal(deviation.type, 'blocked')
    const { trace: corrected, addedSteps } = correctPlan(trace, deviation)
    assert.ok(addedSteps[0]!.description.includes('诊断'))
    assert.equal(corrected.status, 'replanned')
    assert.ok(injectReplanContext(deviation, addedSteps).text.includes('<replan-context'))
  })

  it('scenario 3: compaction survival — serialized trace carries steps + recent history', () => {
    let trace = createTrace('c1', 'wiring')
    trace = withPlanSteps(trace, buildPlanSteps(['步骤甲', '步骤乙'], 'wiring'))
    trace = appendResult(trace, stepResultFor(trace, 1, ['read_file']))
    const xml = serializeTrace(trace)
    assert.match(xml, /<plan-execution-trace/)
    assert.match(xml, /步骤甲/)
    assert.match(xml, /<recent-history>/)
  })

  it('scenario 4: empty trace — no steps → none + empty serialization', () => {
    const trace = createTrace('c1', 'system')
    assert.equal(detectDeviation(trace, undefined).type, 'none')
    assert.equal(serializeTrace(trace), '')
  })

  it('scenario 5: stalled — no-tool turns >= threshold → 打破停滞', () => {
    let trace = createTrace('c1', 'unit')
    trace = withPlanSteps(trace, buildPlanSteps(['思考'], 'unit'))
    const deviation = detectDeviation(trace, undefined, undefined, 3)
    assert.equal(deviation.type, 'stalled')
    const { addedSteps } = correctPlan(trace, deviation)
    assert.ok(addedSteps[0]!.description.includes('停滞'))
  })

  it('reverse: empty-step trace never triggers deviated/stray (no false positives)', () => {
    const trace = createTrace('c1', 'unit') // no steps
    const result: StepResult = { stepId: 'x', turnNumber: 1, toolCalls: [{ tool: 'web_fetch', result_summary: '' }], status: 'done' }
    // no steps → no expectedTools → deviated/stray guards never fire
    assert.equal(detectDeviation(trace, result).type, 'none')
  })
})

// ─── Layer 2: live AgentLoop wiring (todo → trace appendix) ───────

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

function makeEngine(cwd: string): PromptEngine {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [TODO_TOOL.definition] },
    volatileCtx: { cwd },
  })
}

/** Turn 0: call todo (seeds trace). Subsequent turns: text → end. */
function makeTodoThenDoneClient(): StreamClient {
  let turn = 0
  return {
    stream: mock.fn(async (_request: OaiChatRequest, cb: StreamCallbacks) => {
      if (turn === 0) {
        turn++
        const block: ContentBlock = {
          type: 'tool_use',
          id: 'tu_todo',
          name: 'todo',
          input: {
            action: 'write',
            todos: [
              { id: '1', content: '读取 loop.ts 理解现状', status: 'pending' },
              { id: '2', content: '修改 detectDeviation', status: 'pending' },
              { id: '3', content: '跑测试验证', status: 'pending' },
            ],
          },
        }
        cb.onContentBlock(block)
        cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 30 })
        return
      }
      cb.onTextDelta('done')
      cb.onContentBlock({ type: 'text', text: 'done' })
      cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 10 })
    }),
  } as unknown as StreamClient
}

describe('U6 AgentLoop wiring — todo write seeds + serializes the plan trace', () => {
  it('drives the trace onto the engine plan-trace appendix surface', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-u6-trace-'))
    try {
      const registry = new ToolRegistry()
      registry.register(TODO_TOOL)
      const engine = makeEngine(cwd)
      const setAppendix = mock.method(engine, 'setPlanTraceAppendix')
      const agent = new AgentLoop({
        client: makeTodoThenDoneClient(),
        promptEngine: engine,
        toolRegistry: registry,
        maxTurns: 3,
        contextWindow: 1_000_000,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        fsWatcherEnabled: false,
      }, new SessionContext(), cwd)

      await agent.run('实现 detectDeviation 接入 src/agent/loop.ts 的步骤跟踪', makeCallbacks())

      // todo write → onPlanSteps → capturePlanSteps seeds 3 steps; the post-turn
      // runReplanCheck must then serialize the trace onto the engine.
      const serialized = setAppendix.mock.calls
        .map(c => c.arguments[0])
        .filter((a): a is string => typeof a === 'string' && a.length > 0)
      assert.ok(serialized.length >= 1, 'expected setPlanTraceAppendix to receive a serialized trace')
      const latest = serialized[serialized.length - 1]!
      assert.match(latest, /<plan-execution-trace/)
      assert.match(latest, /理解现状/)
    } finally {
      // Windows：子进程退出处理/日志流关闭挂事件循环回调——同步 rmSync 会
      // 在句柄释放前打击（EPERM，POSIX 不可见）；异步重试等待期间推进事件循环。
      await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
})

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { ToolRegistry } from '../../tools/registry.js'
import { PromptEngine } from '../../prompt/engine.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'
import type { Tool } from '../../tools/types.js'

// 收编 PR #434：用工具执行闸门触发 watchdog，不依赖 stream/50ms 的竞速。
async function runRescue(t: import('node:test').TestContext, options: {
  userAbort?: 'drain' | 'completion' | 'next-boundary'
  endTurn?: boolean
  userOnly?: boolean
  abortAt?: 'execution'
} = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-watchdog-rescue-'))
  let started!: () => void
  let release!: () => void
  const toolStarted = new Promise<void>(resolve => { started = resolve })
  const toolGate = new Promise<void>(resolve => { release = resolve })
  const tool: Tool = {
    definition: { name: 'slow', description: 'controlled tool', input_schema: { type: 'object', properties: {} } },
    execute: async () => {
      started()
      await toolGate
      return { content: 'done', endTurn: options.endTurn }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  }
  let streams = 0
  // 逐次 stream 记录传入信号的 aborted 状态——rescue 换新 controller 后，下一轮流
  // 必须拿到活信号；构造期按值捕获的旧实现会把已中止信号喂给第 2 次 stream。
  const signalStates: boolean[] = []
  const client = {
    stream: async (_request: unknown, callbacks: StreamCallbacks, signal?: AbortSignal) => {
      streams++
      signalStates.push(signal?.aborted ?? true)
      if (streams === 1) {
        callbacks.onContentBlock({ type: 'tool_use', id: 'tool-1', name: 'slow', input: {} })
        callbacks.onStopReason('tool_use', { input_tokens: 5, output_tokens: 5 })
      } else {
        callbacks.onTextDelta('ok')
        callbacks.onContentBlock({ type: 'text', text: 'ok' })
        callbacks.onStopReason('end_turn', { input_tokens: 3, output_tokens: 2 })
      }
    },
  } as unknown as StreamClient
  const registry = new ToolRegistry()
  registry.register(tool)
  const agent = new AgentLoop({
    client, toolRegistry: registry,
    promptEngine: new PromptEngine({ model: 'deepseek-v4-pro', maxTokens: 1024,
      staticCtx: { tools: [tool.definition] }, volatileCtx: { cwd } }),
    maxTurns: 8, contextWindow: 1_000_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    fsWatcherEnabled: false,
  }, new SessionContext(), cwd)
  t.after(() => { agent.stopConfigWatcher(); agent.stopFsWatcher(); rmSync(cwd, { recursive: true, force: true }) })
  const aborts: Array<string | undefined> = []
  const errors: unknown[] = []
  const triggerAbort = () => {
    if (!options.userOnly) agent.abortStalledTurn()
    if (options.userAbort === 'drain') agent.abort()
  }
  if (options.userAbort === 'next-boundary') {
    const sync = agent.syncPlanModeToConfig.bind(agent)
    agent.syncPlanModeToConfig = () => {
      sync()
      if (streams === 1 && !agent.abortController?.signal.aborted) agent.abort()
    }
  }
  const run = agent.run('run the controlled tool', {
    onTextDelta: () => {}, onThinkingDelta: () => {}, onToolUse: () => {},
    // 在工具已返回、批提交前触发误报，实际成功结果必须继续送到模型。
    onToolResult: () => { if (options.abortAt !== 'execution') triggerAbort() },
    onTurnComplete: () => { if (options.userAbort === 'completion') agent.abort() },
    onError: error => { errors.push(error) }, onAbort: reason => { aborts.push(reason) },
    onApprovalRequired: async () => false,
  })
  await toolStarted
  const oldSignal = agent.abortController!.signal
  assert.equal(agent.resetAbortAfterRescue(), false, 'a live signal must never be replaced')
  assert.equal(agent.abortController!.signal, oldSignal)
  if (options.abortAt === 'execution') triggerAbort()
  release()
  await run
  assert.deepEqual(errors, [])
  return { agent, streams, aborts, oldSignal, signalStates }
}

describe('watchdog rescue — actual run-loop wiring', () => {
  it('completed batch continues with a new live signal', { timeout: 10_000 }, async t => {
    const { agent, streams, aborts, oldSignal, signalStates } = await runRescue(t)
    assert.equal(streams, 2)
    assert.deepEqual(aborts, [])
    assert.equal(oldSignal.aborted, true)
    assert.notEqual(agent.abortController!.signal, oldSignal)
    assert.equal(agent.abortController!.signal.aborted, false)
    assert.equal(agent.abortReason(), undefined)
    assert.deepEqual(signalStates, [false, false],
      'rescue 后的第 2 次 stream 必须拿到新信号——按值捕获的旧信号已 aborted')
  })
  for (const userAbort of ['drain', 'completion', 'next-boundary'] as const) {
    it(`user Esc during ${userAbort} is honored`, { timeout: 10_000 }, async t => {
      const { agent, streams, aborts } = await runRescue(t, { userAbort })
      assert.equal(streams, 1, 'Esc must prevent the second stream')
      assert.deepEqual(aborts, [undefined], 'exactly one user interrupt, never watchdog recovery')
      assert.equal(agent._pendingAbort, true)
      assert.equal(agent.abortController!.signal.aborted, true)
    })
  }
  it('pending Esc wins over a completed endTurn tool', { timeout: 10_000 }, async t => {
    const { streams, aborts } = await runRescue(t, { userAbort: 'drain', endTurn: true })
    assert.equal(streams, 1)
    assert.deepEqual(aborts, [undefined])
  })
  it('watchdog endTurn rescue clears the signal and finishes once', { timeout: 10_000 }, async t => {
    const { agent, streams, aborts } = await runRescue(t, { endTurn: true })
    assert.equal(streams, 1)
    assert.deepEqual(aborts, [])
    assert.equal(agent.abortController!.signal.aborted, false)
  })
  it('ordinary user abort never creates a rescue signal', { timeout: 10_000 }, async t => {
    const { agent, streams, aborts, oldSignal } = await runRescue(t, { userAbort: 'drain', userOnly: true })
    assert.equal(streams, 1)
    assert.deepEqual(aborts, [undefined])
    assert.equal(agent.abortController!.signal, oldSignal)
    assert.equal(agent.resetAbortAfterRescue(), false, 'a completed run cannot be rescued')
  })
  it('watchdog while the tool is still executing drains then resumes', { timeout: 10_000 }, async t => {
    const { streams, aborts, signalStates } = await runRescue(t, { abortAt: 'execution' })
    assert.equal(streams, 2)
    assert.deepEqual(aborts, [])
    assert.deepEqual(signalStates, [false, false])
  })
})

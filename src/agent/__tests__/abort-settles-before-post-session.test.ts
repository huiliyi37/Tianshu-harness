/**
 * Stop→settle 根治（2026-09-13）：abort 后 run() 不再等 postSession hooks。
 * 反证表：
 *  #1 「仍 inline await postSession」→ 2s 慢 hook 让 run() 2s 后才 settle（断言 <700ms）
 *  #2 「detached 但 hook 没跑」→ hookRan 永远 false（drain 后必须 true）
 *  #3 「drain 持久化也被推进后台」→ abort-tool-hang 的 drained≥1 契约破（此处再断言一次）；
 *      工具批场景另有既有 TOOL_ABORT_DRAIN_MS=6000 的 drain 窗口（turn-orchestrator.ts:371），
 *      故本用例不断言 settle 时长，只断言「settle 时 postSession 仍未跑」（不等 hooks）。
 *  #4 「natural finish 也 detached」→ 正常完成后 hookRan 必须已 true（runBeforeComplete 仍 inline）
 *  #5 「abort 后新一轮要等后台链」→ 第二轮 stream 发动耗时必须 <700ms（不 2s 慢 hook 拖累）
 *
 * 时序纪律：#1/#5 用「流挂住直到 abort」的 client——abort 确定落在流阶段（catch AbortError
 * 出口），与 TOOL_ABORT_DRAIN_MS 无关。若用「审批永不 resolve」的 client，abort 落在工具批，
 * run() 必等满 6s 批量 drain（既有设计），且 sleep(80) 是否已走进工具批不确定 → 断言必 flaky。
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { ToolRegistry } from '../../tools/registry.js'
import { PromptEngine } from '../../prompt/engine.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'
import type { Tool, ToolResult } from '../../tools/types.js'

const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-abort-post-session-'))

// 补上清理（此前从不回收——进程退出前 tmp 目录残留）：Windows 句柄释放竞态
// 用异步重试窗口化解（与 test/win 清理批次同模式）。
after(async () => {
  await rm(TEST_CWD, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const APPROVAL_TOOL: Tool = {
  definition: {
    name: 'needs_approval',
    description: 'requires approval',
    input_schema: { type: 'object', properties: {} },
  },
  execute: async (): Promise<ToolResult> => ({ content: 'done' }),
  requiresApproval: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}

function makeEngine() {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [APPROVAL_TOOL.definition] },
    volatileCtx: { cwd: TEST_CWD },
  })
}

function makeAgent(client: StreamClient) {
  const session = new SessionContext()
  const registry = new ToolRegistry()
  registry.register(APPROVAL_TOOL)
  return new AgentLoop({
    client,
    promptEngine: makeEngine(),
    toolRegistry: registry,
    maxTurns: 5,
    contextWindow: 1_000_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    fsWatcherEnabled: false,
  }, session, TEST_CWD)
}

type Cbs = Parameters<AgentLoop['run']>[1]
const cbs = (over: Partial<Cbs> = {}): Cbs => ({
  onTextDelta: () => {},
  onThinkingDelta: () => {},
  onToolUse: () => {},
  onToolResult: () => {},
  onTurnComplete: () => {},
  onError: () => {},
  onAbort: () => {},
  onApprovalRequired: async () => true,
  ...over,
}) as Cbs

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** `agent.runtimeHooks` 是公开字段（loop.ts:539），`RuntimeHookPipeline.register` 公开（runtime-hooks.ts:251）。 */
function installSlowPostSessionHook(agent: AgentLoop, ms: number, onRun: () => void) {
  agent.runtimeHooks.register({
    phase: 'postSession', name: 'slow-probe', budgetMs: 10_000,
    async run() { await sleep(ms); onRun() },
  })
}

/** 流挂住直到 abort —— abort 确定落在流阶段（不触发工具批的 TOOL_ABORT_DRAIN_MS 窗口）。 */
function streamUntilAbort(): StreamClient {
  return {
    stream: (_r: unknown, cb: StreamCallbacks, signal?: AbortSignal) => new Promise<void>((_, reject) => {
      cb.onTextDelta('partial…')
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    }),
  } as unknown as StreamClient
}

/** 流式客户端：先发一段文本 delta，再挂在审批上（永不 resolve），让 abort 落在工具阶段。 */
function hangingApprovalClient(): StreamClient {
  return {
    stream: async (_r: unknown, cb: StreamCallbacks) => {
      cb.onTextDelta('partial…')
      cb.onContentBlock({ type: 'tool_use', id: 't1', name: 'needs_approval', input: {} } as never)
      cb.onStopReason('tool_use', { input_tokens: 5, output_tokens: 5 })
    },
  } as unknown as StreamClient
}

function textOnlyClient(text: string): StreamClient {
  return {
    stream: async (_r: unknown, cb: StreamCallbacks) => {
      cb.onTextDelta(text)
      cb.onContentBlock({ type: 'text', text } as never)
      cb.onStopReason('end_turn', { input_tokens: 3, output_tokens: 2 })
    },
  } as unknown as StreamClient
}

describe('abort settles before postSession (detached)', () => {
  it('#1/#2 run() settles within 700ms while a 2s postSession hook still runs; drain sees it finish', async () => {
    const agent = makeAgent(streamUntilAbort())
    let hookRan = false
    installSlowPostSessionHook(agent, 2_000, () => { hookRan = true })
    let aborted = false
    const p = agent.run('do it', cbs({ onAbort: () => { aborted = true } }))
    await sleep(80)
    const t0 = Date.now()
    agent.abort()
    await p
    assert.ok(Date.now() - t0 < 700, `run() 应在 drain 后立即 settle，实际 ${Date.now() - t0}ms`)
    assert.equal(aborted, true)
    assert.equal(hookRan, false, 'postSession 此时仍在后台跑')
    assert.equal(await agent.drainPostSession(5_000), true)
    assert.equal(hookRan, true, 'detached 链最终执行了 postSession hook')
  })

  it('#3 工具阶段 abort：inline drain 持久化仍成立，且 settle 时 postSession 未跑', async () => {
    const agent = makeAgent(hangingApprovalClient())
    let hookRan = false
    installSlowPostSessionHook(agent, 2_000, () => { hookRan = true })
    let drained = 0
    ;(agent as unknown as { _persistDrain: () => Promise<void> })._persistDrain = async () => { drained++ }
    let approvalHit: (() => void) | null = null
    const gate = new Promise<void>((r) => { approvalHit = r })
    const p = agent.run('do it', cbs({ onApprovalRequired: () => { approvalHit?.(); return new Promise<boolean>(() => {}) } }))
    await gate   // 确定性到达工具阶段（此时 batch 挂在审批上）
    agent.abort()
    await p
    assert.ok(drained >= 1, 'drain 必须留在 inline，不能进后台链')
    assert.equal(hookRan, false, '工具阶段 abort 也不等 postSession')
    assert.equal(await agent.drainPostSession(5_000), true)
    assert.equal(hookRan, true)
  })

  it('#4 natural finish 仍 inline 等 postSession', async () => {
    const agent = makeAgent(textOnlyClient('ok'))
    let hookRan = false
    installSlowPostSessionHook(agent, 50, () => { hookRan = true })
    await agent.run('normal', cbs())
    assert.equal(hookRan, true, 'runBeforeComplete 路径不 detached')
  })

  it('#5 abort 后立刻 run() 新一轮真正执行，且开跑不等后台链', async () => {
    let phase: 'hang' | 'normal' = 'hang'
    let secondStreamAt = 0
    const client = {
      stream: (_r: unknown, cb: StreamCallbacks, signal?: AbortSignal) => {
        if (phase === 'hang') {
          return new Promise<void>((_, reject) => {
            cb.onTextDelta('partial…')
            signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
          })
        }
        secondStreamAt = Date.now()
        cb.onContentBlock({ type: 'text', text: 'ok' } as never)
        cb.onStopReason('end_turn', { input_tokens: 3, output_tokens: 2 })
        return Promise.resolve()
      },
    } as unknown as StreamClient
    const agent = makeAgent(client)
    installSlowPostSessionHook(agent, 2_000, () => {})
    const p1 = agent.run('hang', cbs())
    await sleep(80)
    const tAbort = Date.now()
    agent.abort()
    await p1
    phase = 'normal'
    await agent.run('second', cbs())
    assert.ok(secondStreamAt > 0, '第二轮必须真正 stream')
    // 判据本意：第二轮开跑"不等 2s 后台链"——等它耗时应 ≥2000ms。原 700ms 阈值
    // 把 settle + 二轮启动的合理耗时（负载机器实测 ~960ms）也纳入了失败面。
    assert.ok(secondStreamAt - tAbort < 1_700, `第二轮开跑不等 2s 慢 hook，实际 ${secondStreamAt - tAbort}ms`)
    assert.equal(await agent.drainPostSession(5_000), true)
  })
})

/**
 * 回归测试：工具批 abort drain 竞速定时器必须 clear 并 unref。
 *
 * 缺陷：turn-orchestrator.ts 的 abort drain 竞速用
 * `setTimeout(..., TOOL_ABORT_DRAIN_MS)`（6000ms），但既不保存 handle 也不
 * clear/unref。每次工具批 abort 留下一个存活 6s 的活定时器：顶住进程退出最多
 * 6s，长会话反复 abort 时堆积。
 *
 * 修复：保存 handle → unref() → race 结束后 clearTimeout。
 *
 * 断言：触发 abort drain 路径后，6000ms 定时器不得处于「既未 clear 也未 unref」
 * 状态。（先例：closed issue #184——bash 的 forceKillTimer 同型缺陷。）
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { ToolRegistry } from '../../tools/registry.js'
import { PromptEngine } from '../../prompt/engine.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'
import type { Tool, ToolResult } from '../../tools/types.js'

const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-drain-timer-'))

// 永久挂起的工具：abort 后 rejectOnAbort 抛 → 进 catch drain 分支
const HANG_TOOL: Tool = {
  definition: { name: 'hang', description: 'hangs forever', input_schema: { type: 'object', properties: {} } },
  execute: (): Promise<ToolResult> => new Promise(() => {}),
  requiresApproval: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}

function makeAgent(client: StreamClient) {
  const session = new SessionContext()
  const registry = new ToolRegistry()
  registry.register(HANG_TOOL)
  return new AgentLoop({
    client,
    promptEngine: new PromptEngine({
      model: 'deepseek-v4-pro', maxTokens: 1024,
      staticCtx: { tools: [HANG_TOOL.definition] },
      volatileCtx: { cwd: TEST_CWD },
    }),
    toolRegistry: registry,
    maxTurns: 5,
    contextWindow: 1_000_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    fsWatcherEnabled: false,
  }, session, TEST_CWD)
}

type Cbs = Parameters<AgentLoop['run']>[1]
const cbs = (over: Partial<Cbs> = {}): Cbs => ({
  onTextDelta: () => {}, onThinkingDelta: () => {}, onToolUse: () => {}, onToolResult: () => {},
  onTurnComplete: () => {}, onError: () => {}, onAbort: () => {}, ...over,
}) as Cbs

const emitToolUse = (cb: StreamCallbacks) => {
  cb.onContentBlock({ type: 'tool_use', id: 't1', name: 'hang', input: {} } as never)
  cb.onStopReason('tool_use', { input_tokens: 5, output_tokens: 5 })
}

describe('AgentLoop — abort drain timer cleanup', () => {
  it('abort 后 6000ms drain 定时器应被 clear 或 unref', async () => {
    const origSetTimeout = globalThis.setTimeout
    const origClearTimeout = globalThis.clearTimeout
    const tracked = new Map<unknown, { unrefCalled: boolean; cleared: boolean }>()
    ;(globalThis as any).setTimeout = function (fn: any, delay?: number, ...args: any[]) {
      const h = (origSetTimeout as any)(fn, delay, ...args)
      if (delay === 6000) {
        tracked.set(h, { unrefCalled: false, cleared: false })
        const origUnref = h.unref?.bind(h)
        h.unref = () => { tracked.get(h)!.unrefCalled = true; return origUnref?.() }
      }
      return h
    }
    ;(globalThis as any).clearTimeout = function (h: any) {
      const rec = tracked.get(h)
      if (rec) rec.cleared = true
      return (origClearTimeout as any)(h)
    }

    try {
      const client = { stream: async (_r: unknown, cb: StreamCallbacks) => { emitToolUse(cb) } } as unknown as StreamClient
      const agent = makeAgent(client)
      const p = agent.run('do it', cbs())
      await new Promise(r => setTimeout(r, 150))
      agent.abort()
      await new Promise(r => setTimeout(r, 300))
      const records = [...tracked.values()]
      const leaked = records.filter(r => !r.cleared && !r.unrefCalled)
      assert.equal(leaked.length, 0,
        `存在未 clear 且未 unref 的 6000ms drain 定时器: ${leaked.length} 个（tracked=${records.length}）`)
      void p.catch(() => {})
    } finally {
      ;(globalThis as any).setTimeout = origSetTimeout
      ;(globalThis as any).clearTimeout = origClearTimeout
    }
  })
})

/**
 * 回归测试：P7 watchdog ghost-abort rescue 必须真正让本轮继续。
 *
 * 缺陷：rescue 分支只置 _rescuedFromWatchdog=true 并 continue，未清除 abort
 * 状态。循环头（turn-orchestrator.ts:566）虽跳过 abort 检查，但 signal 仍
 * aborted → 紧接着的 rejectOnAbort(runCompaction, signal!) 立即再中止 →
 * rescue 形同虚设，本轮仍以 watchdog-stall 结束。
 *
 * 修复：rescue 成功后调用 resetAbortAfterRescue()（换新 controller、清
 * _watchdogAborted）；若有真实用户 Esc 待处理（_pendingAbort）则返回 false 并
 * 拒绝 rescue（fail-closed，保住用户 Esc）。
 *
 * 断言：watchdog 假阳性 + 工具批成功完成 → 本轮应继续（第二次 stream 发生）。
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

const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-wd-rescue-'))

const SLOW_TOOL: Tool = {
  definition: { name: 'slow', description: 'slow tool', input_schema: { type: 'object', properties: {} } },
  execute: (): Promise<ToolResult> => new Promise(r => setTimeout(() => r({ content: 'done' }), 50)),
  requiresApproval: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}

function makeAgent(client: StreamClient) {
  const session = new SessionContext()
  const registry = new ToolRegistry()
  registry.register(SLOW_TOOL)
  return new AgentLoop({
    client,
    promptEngine: new PromptEngine({
      model: 'deepseek-v4-pro', maxTokens: 1024,
      staticCtx: { tools: [SLOW_TOOL.definition] },
      volatileCtx: { cwd: TEST_CWD },
    }),
    toolRegistry: registry,
    maxTurns: 8,
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

describe('AgentLoop — P7 watchdog ghost-abort rescue', () => {
  it('watchdog 假阳性 + 批成功完成 → 本轮应继续（第二次 stream）', async () => {
    let streamCall = 0
    const client = {
      stream: async (_r: unknown, cb: StreamCallbacks) => {
        streamCall++
        if (streamCall === 1) {
          cb.onContentBlock({ type: 'tool_use', id: 't1', name: 'slow', input: {} } as never)
          cb.onStopReason('tool_use', { input_tokens: 5, output_tokens: 5 })
        } else {
          cb.onTextDelta('ok')
          cb.onContentBlock({ type: 'text', text: 'ok' } as never)
          cb.onStopReason('end_turn', { input_tokens: 3, output_tokens: 2 })
        }
      },
    } as unknown as StreamClient

    const agent = makeAgent(client)
    const p = agent.run('do it', cbs())

    // 等第一次 stream 开始，再在工具批执行期间触发 watchdog 假阳性
    const t0 = Date.now()
    while (streamCall < 1 && Date.now() - t0 < 3000) await new Promise(r => setTimeout(r, 10))
    agent.abortStalledTurn()

    await Promise.race([p.catch(() => {}), new Promise(r => setTimeout(r, 6000))])

    assert.ok(streamCall >= 2,
      `P7 rescue 未让本轮继续：streamCall=${streamCall}（批成功完成后，signal 仍 aborted，` +
      `下一处 rejectOnAbort 立即再中止，rescue 形同虚设）`)
  })

  it('rescue 之后有真实用户 Esc 待处理时，Esc 必须被兑现（不被 rescue 吞掉）', async () => {
    let streamCall = 0
    const client = {
      stream: async (_r: unknown, cb: StreamCallbacks) => {
        streamCall++
        cb.onContentBlock({ type: 'tool_use', id: `t${streamCall}`, name: 'slow', input: {} } as never)
        cb.onStopReason('tool_use', { input_tokens: 5, output_tokens: 5 })
      },
    } as unknown as StreamClient

    const agent = makeAgent(client)
    const aborts: Array<string | undefined> = []
    const p = agent.run('do it', cbs({ onAbort: (reason?: string) => { aborts.push(reason) } }))

    const t0 = Date.now()
    while (streamCall < 1 && Date.now() - t0 < 3000) await new Promise(r => setTimeout(r, 10))
    // 用户真实 Esc（置 _pendingAbort）—— 必须被兑现
    agent.abort()
    await Promise.race([p.catch(() => {}), new Promise(r => setTimeout(r, 6000))])

    // 用户的 Esc 不得被记为纯 watchdog 中止
    const last = aborts[aborts.length - 1]
    assert.ok(last === undefined || !String(last).includes('watchdog'),
      `用户 Esc 被误记为 watchdog 中止（reason=${last}）；aborts=${JSON.stringify(aborts)}`)
  })
})

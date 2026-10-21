import { DEFAULT_FRONTEND_PREFERENCES } from '../../frontend-preferences.js'
/**
 * 派发契约卡在「同一 order id 再派发」时必须重新打卡。
 *
 * batch / team / council 走 `deriveStableWorkOrderId`，order id 是 `batch:0`
 * 这类可预测值而非 `wo_<uuid>`（dependsOn 与 resume 都依赖它们可预测）。同一
 * 会话里多派几次必然撞 id，而去重集按 id 记且从不清空——第二次派发于是静默无卡。
 *
 * 断言落在「屏上真的出现了本轮的目标」而不是「Set 里有没有这个 id」：后者换个
 * 写法就绕过去了，前者才是用户看得见的那件事。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { MockOut, MockIn, stripAnsi } from './_harness.js'
import type { DelegationActivity } from '../../../tools/types.js'

const contract = (objective: string) => ({
  objective,
  profile: 'reviewer',
  scope: {},
  constraints: [],
  budget: { maxTurns: 8, timeoutMs: 60_000 },
  allowedToolsDigest: 'grep,read_file +2',
})

function makeApp() {
  const out = new MockOut(120, 24)
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: new MockIn() as unknown as ReadStream,
    cols: 120, rows: 24, modelName: 'test', contextWindow: 200_000,
  })
  app.setFrontendPreferences({ ...DEFAULT_FRONTEND_PREFERENCES, renderer: 'classic' })
  app.start()
  out.chunks.length = 0
  return { app, out }
}

const send = (app: TuiApp, activity: DelegationActivity) => {
  app.callbacks.onDelegationActivity?.(activity)
}

describe('派发契约卡 — 稳定 id 再派发', () => {
  test('第二次派发同一 order id 仍打卡，且显示的是本轮目标', () => {
    const { app, out } = makeApp()

    send(app, { workOrderId: 'batch:0', parentToolId: 'tool_1', status: 'running', contract: contract('审查缓存边界') })
    send(app, { workOrderId: 'batch:0', parentToolId: 'tool_1', status: 'completed', summary: '第一轮结论' })
    const firstRound = stripAnsi(out.chunks.join(''))
    assert.match(firstRound, /审查缓存边界/, '第一轮本就该打卡')
    const previousContent = app.getScrollbackContent()

    out.chunks.length = 0
    send(app, { workOrderId: 'batch:0', parentToolId: 'tool_2', status: 'running', contract: contract('补 rewind 回归测试') })
    const secondRound = stripAnsi(out.chunks.join(''))

    assert.match(secondRound, /补 rewind 回归测试/, '第二轮派发必须打出本轮的卡')
    const newCards = stripAnsi(app.getScrollbackContent().slice(previousContent.length))
    assert.match(newCards, /补 rewind 回归测试/)
    assert.doesNotMatch(newCards, /审查缓存边界/, '新提交的派发卡不得复读上一轮目标；只读历史预览仍可显示旧卡')
  })

  test('同一轮内重复 running 事件只打一次卡', () => {
    const { app } = makeApp()

    send(app, { workOrderId: 'batch:0', parentToolId: 'tool_1', status: 'running', contract: contract('审查缓存边界') })
    send(app, { workOrderId: 'batch:0', parentToolId: 'tool_1', status: 'running', contract: contract('审查缓存边界'), progressLine: '⚙ grep' })

    const text = stripAnsi(app.getScrollbackContent())
    // 注意：目标现在会出现在两处——派发契约卡（scrollback 沉淀）与舰队面板
    // 主行（0e46b0c6 任务优先布局）。去重的语义是「契约卡只打一次」，
    // 所以数正式历史的卡头标记，不把只读视口重绘当作新派发。
    const cards = text.split('◆ 派发').length - 1
    assert.equal(cards, 1, `同轮内应只打一次派发卡，实际 ${cards} 次`)
  })

  test('终态回放不补打派发卡', () => {
    const { app, out } = makeApp()

    send(app, { workOrderId: 'batch:0', parentToolId: 'tool_1', status: 'completed', contract: contract('审查缓存边界'), summary: '结论' })

    assert.doesNotMatch(stripAnsi(out.chunks.join('')), /审查缓存边界/, '已结束的 worker 不该再打派发卡')
  })
})

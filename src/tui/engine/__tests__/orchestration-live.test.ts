/**
 * 编排 live 交互测试（app 级，经真实 stdin 序列 + mock stdout）：
 *
 *  1. 委派工具终态 → scrollback 出现「完成沉淀卡」（◆ 子代理组 · N/M 通过）。
 *  2. team currentWave 推进 → scrollback 提交 wave 完成时间线行，重复推送去重。
 *  3. ask_user_question Tab 化面板：含选项自动可开；答题后先进提交页，
 *     显式「提交回答」才发出；←→ 可乱序切题；无选项不弹面板。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { encodeTeamPanelModel, type TeamPanelModel } from '../../team-panel-model.js'
import type { DelegationActivity } from '../../../tools/types.js'

class MockOut {
  columns = 100
  rows = 40
  chunks: string[] = []
  write = (s: string): boolean => { this.chunks.push(s); return true }
  on(): this { return this }
  removeListener(): this { return this }
  clear() { this.chunks = [] }
}
class MockIn {
  isTTY = true
  dataHandler: ((d: string) => void) | null = null
  setRawMode(): this { return this }
  resume(): this { return this }
  setEncoding(): this { return this }
  on(ev: string, h: (d: string) => void): this { if (ev === 'data') this.dataHandler = h; return this }
  removeAllListeners(): this { return this }
  pause(): this { return this }
}

function makeApp() {
  const out = new MockOut()
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 100, rows: 40, modelName: 'test',
  })
  app.start()
  return { app, out, stdin }
}

const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, '')

// ask 面板提交经 submitText → commitUserPrompt，overlay 激活时
// 返回完成 Promise（不再同步直写）——onSubmit 在面板关闭、队列回放后才触发，
// 断言前需让出一个 tick。
const tick = (ms = 20) => new Promise<void>(r => setTimeout(r, ms))

const act = (workOrderId: string, status: DelegationActivity['status'], extra: Partial<DelegationActivity> = {}): DelegationActivity => ({
  workOrderId,
  parentToolId: 'tool-1',
  profile: 'reviewer',
  status,
  ...extra,
})

test('委派工具终态：scrollback 提交完成沉淀卡', () => {
  const { app, out } = makeApp()
  const onActivity = app.callbacks.onDelegationActivity!
  app.callbacks.onToolUse('tool-1', 'delegate_batch', { tasks: [{}, {}] })
  onActivity(act('w1', 'running'))
  onActivity(act('w2', 'running'))
  onActivity(act('w1', 'completed', { progressLine: 'found 3 issues', toolUseCount: 20, tokenCount: 253_200 }))
  onActivity(act('w2', 'completed', { progressLine: 'clean', toolUseCount: 17, tokenCount: 220_100 }))

  out.clear()
  app.callbacks.onToolResult('tool-1', 'delegate_batch', 'delegate_batch: 2/2 passed', false)
  const plain = stripAnsi(out.chunks.join(''))
  assert.ok(plain.includes('◆ 子代理组'), `settle card committed: ${plain.slice(-400)}`)
  assert.ok(plain.includes('2/2 通过'), 'aggregate passed count')
  assert.ok(plain.includes('审查 #1') && plain.includes('审查 #2'), 'per-worker rows')
  assert.ok(plain.includes('— found 3 issues'), 'summary tail')
})

const teamModelAt = (currentWave: number): TeamPanelModel => ({
  mode: 'standard',
  currentWave,
  totalWaves: 2,
  dispatched: 3,
  blocked: [],
  waves: [
    { id: 'wave-1', taskIds: ['t1', 't2'], risk: 'low', reason: '' },
    { id: 'wave-2', taskIds: ['t3'], risk: 'low', reason: '' },
  ],
  tasks: [
    { id: 't1', title: 'a', authority: 'pojun', profile: 'explorer', kind: 'explore', dependsOn: [], riskTier: 'low', files: [], status: 'done' },
    { id: 't2', title: 'b', authority: 'pojun', profile: 'explorer', kind: 'explore', dependsOn: [], riskTier: 'low', files: [], status: 'done' },
    { id: 't3', title: 'c', authority: 'pojun', profile: 'patcher', kind: 'patch', dependsOn: ['t1'], riskTier: 'low', files: [], status: currentWave > 0 ? 'running' : 'waiting' },
  ],
})

test('team wave 推进：提交时间线行且重复推送去重', () => {
  const { app, out } = makeApp()
  app.callbacks.onToolUse('tc', 'team_orchestrate', { objective: 'x' })
  // 初始面板（wave 1 在跑）：不提交任何时间线行。
  app.callbacks.onToolResult('tc', 'team_orchestrate', encodeTeamPanelModel(teamModelAt(0)), undefined)
  assert.ok(!stripAnsi(out.chunks.join('')).includes('wave 1/2 完成'), 'wave 进行中不提交')

  // 推进到 wave 2（currentWave 0-based = 1）→ 提交 wave 1 完成行。
  out.clear()
  app.callbacks.onToolResult('tc', 'team_orchestrate', encodeTeamPanelModel(teamModelAt(1)), undefined)
  const plain = stripAnsi(out.chunks.join(''))
  assert.ok(plain.includes('✓ wave 1/2 完成 · 2/2 任务'), `wave line committed: ${plain.slice(-300)}`)

  // 同一 currentWave 重复推送 → 去重，不再提交。
  out.clear()
  app.callbacks.onToolResult('tc', 'team_orchestrate', encodeTeamPanelModel(teamModelAt(1)), undefined)
  assert.ok(!stripAnsi(out.chunks.join('')).includes('wave 1/2 完成'), '重复推送被去重')
})

test('ask 面板：单选数字键快选 → 提交页 → Enter 显式提交', async () => {
  const { app, stdin } = makeApp()
  app.registerOverlays({ choicePanelData: () => ({ title: '', choices: [], selectedIndex: 0 }) })
  let submitted: string | undefined
  app.onSubmit(text => { submitted = text })
  app.openAskUserQuestionPanel({
    questions: [{ id: 'q1', prompt: 'Pick one', options: ['Alpha', 'Beta'], allowMultiple: false }],
  })
  assert.ok(app.pendingAskFlow, '面板流已建立')

  stdin.dataHandler!('2') // 数字键 2 → 选定 Beta，推进到提交页（不直接提交）
  assert.equal(submitted, undefined, '选定后先进提交页，不直接提交')
  assert.ok(app.pendingAskFlow, '面板仍在（等待显式提交）')

  stdin.dataHandler!('\r') // 提交页光标默认在「提交回答」
  await tick() // commitUserPrompt 返回 Promise，回放后才触发 onSubmit
  assert.equal(submitted, 'Beta', '提交页 Enter 发出答案')
  assert.equal(app.pendingAskFlow, undefined, '提交后流清理')
})

test('ask 面板：多选数字键切换 + Enter 确认 + 提交页提交', async () => {
  const { app, stdin } = makeApp()
  app.registerOverlays({ choicePanelData: () => ({ title: '', choices: [], selectedIndex: 0 }) })
  const submitted: string[] = []
  app.onSubmit(text => { submitted.push(text) })
  app.openAskUserQuestionPanel({
    questions: [{ id: 'q1', prompt: 'Pick many', options: ['X', 'Y', 'Z'], allowMultiple: true }],
  })

  stdin.dataHandler!('1') // 切换 X
  assert.equal(submitted.length, 0, '多选切换不提交')
  stdin.dataHandler!('3') // 切换 Z
  assert.equal(submitted.length, 0, '多选切换不提交')
  stdin.dataHandler!('\r') // Enter 确认多选 → 提交页
  assert.equal(submitted.length, 0, '确认多选只进提交页，不直接提交')
  stdin.dataHandler!('\r') // 提交页 Enter → 提交
  await tick() // 等待队列回放后 onSubmit 才触发
  assert.equal(submitted.length, 1, '提交页 Enter 后提交一次')
  assert.ok(submitted[0]!.includes('X') && submitted[0]!.includes('Z'), `多选答案含 X 与 Z: ${submitted[0]}`)
  assert.ok(!submitted[0]!.includes('Y'), '未选 Y')
})

test('ask 面板：←→ 切 Tab 乱序答题，提交页确认后按题组串', async () => {
  const { app, stdin } = makeApp()
  app.registerOverlays({ choicePanelData: () => ({ title: '', choices: [], selectedIndex: 0 }) })
  let submitted: string | undefined
  app.onSubmit(text => { submitted = text })
  app.openAskUserQuestionPanel({
    questions: [
      { id: 'q1', prompt: '第一题', options: ['A1', 'A2'], allowMultiple: false },
      { id: 'q2', prompt: '第二题', options: ['B1', 'B2'], allowMultiple: false },
    ],
  })

  stdin.dataHandler!('\x1B[C') // → 切到第 2 题
  stdin.dataHandler!('1')      // 第 2 题选 B1 → 推进到提交页
  stdin.dataHandler!('\x1B[D') // ← 回第 2 题
  stdin.dataHandler!('\x1B[D') // ← 回第 1 题（可回退补答）
  stdin.dataHandler!('2')      // 第 1 题选 A2 → 提交页
  assert.equal(submitted, undefined, '答完两题仍待显式提交')

  stdin.dataHandler!('\r') // 提交页 Enter
  await tick() // 等待队列回放后 onSubmit 才触发
  assert.equal(submitted, '第一题 → A2\n第二题 → B1', 'composeAnswers 按题组串')
  assert.equal(app.pendingAskFlow, undefined)
})

test('ask 面板：提交页选「取消」不提交、仅关面板', () => {
  const { app, stdin } = makeApp()
  app.registerOverlays({ choicePanelData: () => ({ title: '', choices: [], selectedIndex: 0 }) })
  let submitted: string | undefined
  app.onSubmit(text => { submitted = text })
  app.openAskUserQuestionPanel({
    questions: [{ id: 'q1', prompt: 'Pick one', options: ['Alpha', 'Beta'], allowMultiple: false }],
  })
  stdin.dataHandler!('1')      // 选 Alpha → 提交页
  stdin.dataHandler!('\x1B[B') // ↓ 移到「取消」
  stdin.dataHandler!('\r')     // 确认取消
  assert.equal(submitted, undefined, '取消不提交')
  assert.ok(app.pendingAskFlow, '取消只关面板，不清理流（与 Esc 同语义，可输入框作答）')
})

test('ask 面板：无选项问题不弹面板', () => {
  const { app } = makeApp()
  app.openAskUserQuestionPanel({
    questions: [{ id: 'q1', prompt: 'Free text?', options: [], allowMultiple: false }],
  })
  assert.equal(app.pendingAskFlow, undefined, '无选项 → 不建立面板流（走输入框作答）')
})

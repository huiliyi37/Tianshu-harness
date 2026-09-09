/**
 * 计划审阅卡钉底：卡在输入框上方，会话/输入框仍在；不进 choice-panel overlay。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeApp, stripAnsi } from './_harness.js'
import type { PlanSubmittedInfo } from '../../../tools/types.js'

const PLAN: PlanSubmittedInfo = { slug: 'fix-cache', title: '重构缓存层' }
const BODY = ['# 重构缓存层', '', '第一步读文件', '第二步改实现'].join('\n')

function visible(out: { chunks: string[] }): string {
  return stripAnsi(out.chunks.join(''))
}

test('钉底审阅卡在输入框上方，标日期不标模型', () => {
  const { app, out } = makeApp({ cols: 80, rows: 24 })
  app.openPlanApprovalPanel(PLAN, { body: BODY, date: '2026-08-26' })
  const plain = visible(out)
  assert.ok(plain.includes('计划审批'), `header: ${plain}`)
  assert.ok(plain.includes('「重构缓存层」'))
  assert.ok(plain.includes('2026-08-26'))
  assert.ok(plain.includes('批准并执行'))
  assert.ok(plain.includes('❯'), 'input remains')
  assert.ok(!plain.includes('低阶'))
  assert.ok(!plain.includes('cheap'))
  assert.ok(app.activeOverlayId() === null, 'must not enter overlay')
})

test('Esc 收起审阅卡，不调用结算', () => {
  const { app, out, stdin } = makeApp({ cols: 80, rows: 24 })
  let settled: string | undefined
  app.onPlanReviewSettle = (id) => { settled = id }
  app.openPlanApprovalPanel(PLAN, { body: BODY, date: '2026-08-26' })
  out.clear()
  stdin.dataHandler!('\x1B')
  const plain = visible(out)
  assert.equal(settled, undefined, 'Esc 不结算')
  assert.ok(!plain.includes('批准并执行'), `dismissed: ${plain}`)
  assert.ok(plain.includes('❯'))
})

test('数字键 1 结算批准', () => {
  const { app, stdin } = makeApp({ cols: 80, rows: 24 })
  let settled: string | undefined
  app.onPlanReviewSettle = (id) => { settled = id }
  app.openPlanApprovalPanel(PLAN, { body: BODY, date: '2026-08-26' })
  stdin.dataHandler!('1')
  assert.equal(settled, 'approve')
  assert.equal(app.pendingPlanApproval, undefined)
})

test('f 进入反馈，Enter 驳回并带上输入框文本', () => {
  const { app, out, stdin } = makeApp({ cols: 80, rows: 24 })
  let settled: string | undefined
  let comment = ''
  app.onPlanReviewSettle = (id) => {
    settled = id
    comment = app.choicePanelInputBuffer
  }
  app.openPlanApprovalPanel(PLAN, { body: BODY, date: '2026-08-26' })
  stdin.dataHandler!('f')
  assert.match(visible(out), /反馈输入中/)
  stdin.dataHandler!('改')
  stdin.dataHandler!('一')
  stdin.dataHandler!('下')
  stdin.dataHandler!('\r')
  assert.equal(settled, '__reject_comment__')
  assert.equal(comment, '改一下')
  assert.equal(app.pendingPlanApproval, undefined)
})

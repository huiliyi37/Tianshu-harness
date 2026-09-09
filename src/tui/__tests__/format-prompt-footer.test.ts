/**
 * prompt-footer 测试 — 输入框下方键位提示行。
 *
 * 对齐公开仓 prompt-footer 语义：左 mode 段恒保留，右 hints 段从后往前丢
 * 直到放得下。只列真的能按的键（同 command-palette hotkey 裁决）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatPromptFooter } from '../format/prompt-footer.js'
import { getTheme } from '../theme.js'

const theme = getTheme()
const stripAnsi = (s: string): string => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')

const base = { width: 120 }

describe('formatPromptFooter', () => {
  it('正常模式提示 / 命令、ctrl+j 换行、ctrl+p 面板', () => {
    const [line] = formatPromptFooter(base, theme)
    const plain = stripAnsi(line ?? '')
    assert.ok(plain.includes('normal'), `mode 段: ${plain}`)
    assert.ok(plain.includes('/ 命令'), `hint: ${plain}`)
    assert.ok(plain.includes('ctrl+j 换行'), `hint: ${plain}`)
    assert.ok(plain.includes('ctrl+p 面板'), `hint: ${plain}`)
  })

  it('换行模式提示 换行中/enter 换行；shift+enter 退出仅在 kitty 终端显示', () => {
    const [supported] = formatPromptFooter({ ...base, newlineMode: true, shiftEnterAvailable: true }, theme)
    const plainOk = stripAnsi(supported ?? '')
    assert.ok(plainOk.includes('换行中'), `hint: ${plainOk}`)
    assert.ok(plainOk.includes('enter 换行'), `hint: ${plainOk}`)
    assert.ok(plainOk.includes('shift+enter 退出'), `kitty 终端显示退出键: ${plainOk}`)

    // 非 kitty 终端：Shift+Enter 与 Enter 同码，按了也退不出——提示即谎言，裁掉
    const [unsupported] = formatPromptFooter({ ...base, newlineMode: true }, theme)
    const plainNo = stripAnsi(unsupported ?? '')
    assert.ok(plainNo.includes('换行中'), `hint: ${plainNo}`)
    assert.ok(!plainNo.includes('shift+enter'), `非 kitty 终端不提示不可用键: ${plainNo}`)
  })

  it('agentBusy 时提示输入能力键（换行），不再显示打断键', () => {
    const [line] = formatPromptFooter({ ...base, agentBusy: true, shiftEnterAvailable: true }, theme)
    const plain = stripAnsi(line ?? '')
    assert.ok(plain.includes('ctrl+j 换行'), `hint: ${plain}`)
    assert.ok(plain.includes('shift+enter 换行模式'), `kitty 终端显示: ${plain}`)
    assert.ok(!plain.includes('/ 命令'), `busy 不提示命令: ${plain}`)
    assert.ok(!plain.includes('esc 打断'), '打断键是常识且打断有损，不占提示位')

    // 非 kitty 终端：shift+enter 与 Enter 同码（按了即提交），提示会误导
    const [unsupported] = formatPromptFooter({ ...base, agentBusy: true }, theme)
    const plainNo = stripAnsi(unsupported ?? '')
    assert.ok(plainNo.includes('ctrl+j 换行'), 'ctrl+j 是 C0 码，全终端可用恒提示')
    assert.ok(!plainNo.includes('shift+enter'), `非 kitty 终端裁掉 shift+enter: ${plainNo}`)
  })

  it('agentBusy + 换行模式：提示换行态而非 busy 通用提示', () => {
    const [line] = formatPromptFooter({ ...base, agentBusy: true, newlineMode: true, shiftEnterAvailable: true }, theme)
    const plain = stripAnsi(line ?? '')
    assert.ok(plain.includes('换行中'), `hint: ${plain}`)
    assert.ok(plain.includes('enter 换行'), `hint: ${plain}`)
    assert.ok(plain.includes('shift+enter 退出'), `hint: ${plain}`)
  })

  it('approvalPending 时提示审批动作', () => {
    const [line] = formatPromptFooter({ ...base, approvalPending: true }, theme)
    const plain = stripAnsi(line ?? '')
    assert.ok(plain.includes('y 允许'), `hint: ${plain}`)
    assert.ok(plain.includes('esc 取消'), `hint: ${plain}`)
  })

  it('窄宽度从后往前丢 hints，mode 恒保留', () => {
    const [narrow] = formatPromptFooter({ width: 40 }, theme)
    const plain = stripAnsi(narrow ?? '')
    assert.ok(plain.startsWith('normal'), `mode 保留: ${plain}`)
    assert.ok(plain.includes('/ 命令'), '第一个 hint 是高频项，最先保留')
    assert.ok(!plain.includes('ctrl+p 面板'), '尾部 hint 被丢')
    // 丢到极限：mode 放得下就必须输出
    const [tiny] = formatPromptFooter({ width: 10 }, theme)
    assert.ok(stripAnsi(tiny ?? '').includes('normal'), '再窄 mode 也在')
  })
})

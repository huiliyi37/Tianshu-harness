/**
 * prompt-footer 测试 — 输入框下方键位提示行。
 *
 * 至多三个当前动作，窄屏从后往前收起。审批提示由审批决策区负责。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatPromptFooter } from '../format/prompt-footer.js'
import { getTheme } from '../theme.js'
import { ambiguousWideEnabled, displayWidth } from '../width.js'

const theme = getTheme()
const stripAnsi = (s: string): string => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')

const base = { width: 120 }

describe('formatPromptFooter', () => {
  it('正常模式显示发送、换行、历史三个当前动作', () => {
    const [line] = formatPromptFooter(base, theme)
    const plain = stripAnsi(line ?? '')
    assert.equal(plain, 'Enter 发送 · Ctrl+J 换行 · /pager 历史')
    assert.equal(plain.split(' · ').length, 3)
  })

  it('换行模式显示发送方式；Ctrl+Enter 仅在 kitty 终端显示', () => {
    const [supported] = formatPromptFooter({ ...base, newlineMode: true, shiftEnterAvailable: true }, theme)
    const plainOk = stripAnsi(supported ?? '')
    assert.equal(plainOk, 'Enter 换行 · Ctrl+Enter 发送 · /pager 历史')

    // 非 kitty 终端显示可用的前缀序列，不能承诺增强键盘协议按键。
    const [unsupported] = formatPromptFooter({ ...base, newlineMode: true }, theme)
    const plainNo = stripAnsi(unsupported ?? '')
    assert.equal(plainNo, 'Enter 换行 · Ctrl+X Enter 发送 · /pager 历史')
    assert.ok(!plainNo.includes('Ctrl+Enter'), `非 kitty 终端不提示不可用键: ${plainNo}`)
  })

  it('agentBusy 时显示停止、排队、插队、换行动作', () => {
    const [line] = formatPromptFooter({ ...base, agentBusy: true, shiftEnterAvailable: true }, theme)
    const plain = stripAnsi(line ?? '')
    assert.equal(plain, 'Esc 停止 · Enter 排队 · Alt+Enter 插队 · Ctrl+J 换行')
    assert.ok(!plain.includes('/ 命令'), `busy 不提示命令: ${plain}`)
    assert.equal(plain.split(' · ').length, 4)

    // busy 态使用基础键，kitty 能力不改变这些动作。
    const [unsupported] = formatPromptFooter({ ...base, agentBusy: true }, theme)
    const plainNo = stripAnsi(unsupported ?? '')
    assert.equal(plainNo, plain)
  })

  it('agentBusy + 换行模式：提示换行态而非 busy 通用提示', () => {
    const [line] = formatPromptFooter({ ...base, agentBusy: true, newlineMode: true, shiftEnterAvailable: true }, theme)
    const plain = stripAnsi(line ?? '')
    assert.equal(plain, 'Enter 换行 · Ctrl+Enter 发送 · /pager 历史')
    assert.ok(!plain.includes('Enter 排队'), 'newline mode keeps its own Enter behavior')
  })

  it('approvalPending 时 composer 不重复决策区的审批提示', () => {
    assert.deepEqual(formatPromptFooter({ ...base, approvalPending: true }, theme), [])
  })

  it('窄宽度从后往前收起动作，保留首个可放下的动作', () => {
    const [narrow] = formatPromptFooter({ width: 18 }, theme)
    const plain = stripAnsi(narrow ?? '')
    assert.equal(plain, 'Enter 发送', '首个动作优先保留')
    assert.ok(displayWidth(plain, { ambiguousAsWide: ambiguousWideEnabled() }) <= 17, 'hint must fit terminal width')
    assert.deepEqual(formatPromptFooter({ width: 4 }, theme), [], '首个动作也放不下时不输出越界文字')
  })
})

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatAskUserQuestion } from '../ask-user-question.js'
import { getTheme } from '../../theme.js'
import { displayWidth } from '../../width.js'

const theme = getTheme()
function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

describe('formatAskUserQuestion', () => {
  it('renders an open question with title and content', () => {
    const lines = formatAskUserQuestion({
      content: 'Which provider do you want?\n\n  1. OpenAI\n  2. Anthropic',
      columns: 60,
    }, theme)

    const plain = lines.map(stripAnsi)
    assert.ok(plain[0]!.includes('? 需要你的回答'), 'title')
    assert.doesNotMatch(plain.join('\n'), /[┌┐└┘├│]/)
    assert.ok(plain.some(l => l.includes('Which provider do you want?')), 'question')
    assert.ok(plain.some(l => l.includes('1. OpenAI')), 'option 1')
    assert.ok(plain.some(l => l.includes('2. Anthropic')), 'option 2')
  })

  it('does not truncate many options', () => {
    const content = 'Pick one:\n' + Array.from({ length: 10 }, (_, i) => `  ${i + 1}. Option ${i + 1}`).join('\n')
    const lines = formatAskUserQuestion({ content, columns: 60 }, theme)
    const plain = lines.map(stripAnsi)

    assert.ok(plain.some(l => l.includes('10. Option 10')), 'last option visible')
    assert.ok(!plain.some(l => l.includes('[Ctrl+O]')), 'no truncation marker')
  })

  it('wraps long question text to inner width', () => {
    const longQuestion = 'a'.repeat(120)
    const lines = formatAskUserQuestion({ content: longQuestion, columns: 60 }, theme)
    const plain = lines.map(stripAnsi)

    const contentLines = plain.filter(l => l.includes('aaa'))
    assert.ok(contentLines.length >= 2, 'long question wraps')
    assert.equal(contentLines.map(line => line.trimStart()).join(''), longQuestion)
  })

  it('settles to a status line before the chosen answers', () => {
    const lines = formatAskUserQuestion({ content: 'OK?\n  1. Yes\n  2. No', columns: 60, state: 'answered' }, theme)
    assert.deepEqual(lines.map(line => stripAnsi(line).trimStart()), ['✓ 已提交回答'])
  })

  it('keeps archived questions neutral and does not ask for an answer again', () => {
    for (const [state, title] of [['answered', '已提交回答'], ['discussion', '转入讨论'], ['unanswered', '未作答']] as const) {
      const card = formatAskUserQuestion({ content: '选择范围？', columns: 60, state }, theme).map(stripAnsi).join('\n')
      assert.match(card, new RegExp(title))
      assert.doesNotMatch(card, /需要你的回答/)
    }
  })

  it('fits a narrow terminal without losing Chinese or emoji content', () => {
    const content = '中文选项👨‍👩‍👧‍👦'.repeat(8)
    const plain = formatAskUserQuestion({ content, columns: 35 }, theme).map(stripAnsi)
    assert.ok(plain.every(line => displayWidth(line) <= 35))
    const body = plain.slice(1).map(line => line.slice(2)).join('')
    assert.equal(body, content)
  })
})

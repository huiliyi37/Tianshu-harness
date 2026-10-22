/**
 * T9 输入框文本输入打磨测试（Block D）。
 *
 * D1: CJK/emoji 光标按 grapheme 步进（一次跨一个用户字符）。
 * D2: 多行 Up/Down 行内导航；仅空输入框或未改动的召回历史才翻历史（对齐 codex）。
 * D3: `\`+Enter 续行后光标落在换行符之后。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { InputLine } from '../input-line.js'

describe('D1 · grapheme-aware cursor', () => {
  it('moveLeft steps over a whole emoji cluster', () => {
    const family = '👨‍👩‍👧' // ZWJ 家庭 emoji，多个 code point
    const input = new InputLine({ value: family })
    assert.equal(input.cursor, family.length, 'cursor at end (code units)')
    input.handleKey('left', '', false, false)
    assert.equal(input.cursor, 0, '一次左移跨过整个 emoji 簇')
  })

  it('backspace deletes a whole CJK char (single move)', () => {
    const input = new InputLine({ value: '你好' })
    input.handleKey('backspace', '', false, false)
    assert.equal(input.value, '你', '删掉一个完整汉字')
  })

  it('moveRight/backspace handle emoji from start', () => {
    const input = new InputLine({ value: '🎉ok' })
    input.handleKey('home', '', false, false)
    input.handleKey('right', '', false, false)
    // 光标应越过整个 🎉（surrogate pair），落在 'o' 前
    input.handleKey('backspace', '', false, false)
    assert.equal(input.value, 'ok', '删掉整个 emoji')
  })
})

describe('D2 · multi-line Up/Down', () => {
  it('Up moves cursor to previous line (multi-line)', () => {
    const input = new InputLine({ value: 'abc\ndef' })
    // cursor at end (line 1, col 3)
    input.handleKey('up', '', false, false)
    // 应移到第 0 行同列（col 3 → 行尾 'abc' 长度 3）
    assert.equal(input.cursor, 3)
  })

  it('Down moves cursor to next line', () => {
    const input = new InputLine({ value: 'abc\ndef' })
    input.handleKey('home', '', false, false) // line1 col0
    input.handleKey('up', '', false, false)   // line0 col0
    assert.equal(input.cursor, 0)
    input.handleKey('down', '', false, false) // back to line1 col0
    assert.equal(input.cursor, 4)
  })

  it('single-line Up on a draft moves to the start instead of replacing it with history', () => {
    const input = new InputLine({ value: 'current', history: ['prev1'] })
    input.handleKey('up', '', false, false)
    assert.equal(input.value, 'current', '编辑中的草稿不被历史换走')
    assert.equal(input.cursor, 0)
    input.handleKey('up', '', false, false)
    assert.equal(input.value, 'current', '光标已在开头仍不翻历史（codex 同口径）')
  })

  it('Up preserves a grapheme column without splitting a ZWJ emoji', () => {
    const family = '👨‍👩‍👧'
    const input = new InputLine({ value: `${family}x\nz` })

    input.handleKey('up', '', false, false)
    assert.equal(input.cursor, family.length, 'cursor must land after the complete emoji cluster')

    input.handleKey('unknown', 'Q', false, false)
    assert.equal(input.value, `${family}Qx\nz`)
  })

  it('Down preserves a grapheme column without splitting a surrogate pair', () => {
    const input = new InputLine({ value: 'z\n😀x' })
    input.setValue(input.value, 1)

    input.handleKey('down', '', false, false)
    assert.equal(input.cursor, 4, 'cursor must land after the complete emoji')

    input.handleKey('unknown', 'Q', false, false)
    assert.equal(input.value, 'z\n😀Qx')
  })
})

describe('D4 · Shift+Enter inserts newline without submitting', () => {
  it('Shift+Enter inserts \\n and returns change event', () => {
    const input = new InputLine({ value: 'hello' })
    // 5th arg shift=true: app.ts 补传 key.shift 后此路径可达
    const ev = input.handleKey('return', '', false, false, true)
    assert.equal(ev?.type, 'change', 'Shift+Enter 应插入换行，不是提交')
    assert.equal(input.value, 'hello\n')
    assert.equal(input.cursor, 6)
  })

  it('Shift+Enter mid-line splits the line', () => {
    const input = new InputLine({ value: 'abc' })
    input.handleKey('left', '', false, false) // cursor at 2
    const ev = input.handleKey('return', '', false, false, true)
    assert.equal(ev?.type, 'change')
    assert.equal(input.value, 'ab\nc')
    assert.equal(input.cursor, 3)
  })

  it('Alt+Enter (meta) inserts \\n without submitting', () => {
    const input = new InputLine({ value: 'hello' })
    // Alt/Meta+Enter: Kitty \x1B[13;3u 或 ESC+CR 统一为此路径
    const ev = input.handleKey('return', '', false, true)
    assert.equal(ev?.type, 'change', 'Alt+Enter 应插入换行，不是提交')
    assert.equal(input.value, 'hello\n')
    assert.equal(input.cursor, 6)
  })
})

describe('D3 · backslash + Enter continuation cursor', () => {
  it('cursor lands after the inserted newline (mid-line)', () => {
    // 'ab\' 光标在末尾，续行后应为 'ab\n'，光标在 \n 之后（pos 3）
    const input = new InputLine({ value: 'ab\\' })
    const ev = input.handleKey('return', '', false, false)
    assert.equal(ev?.type, 'change')
    assert.equal(input.value, 'ab\n')
    assert.equal(input.cursor, 3, '光标在换行符之后')
  })

  it('typing after continuation appends to the new line', () => {
    const input = new InputLine({ value: 'ab\\' })
    input.handleKey('return', '', false, false)
    input.handleKey('', 'c', false, false)
    assert.equal(input.value, 'ab\nc')
    assert.equal(input.cursor, 4)
  })
})

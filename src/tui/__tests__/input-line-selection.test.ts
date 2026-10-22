import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { InputLine } from '../engine/input-line.js'

/** 逐键输入可打印字符（走 handleKey 真实路径）。 */
function type(input: InputLine, text: string): void {
  for (const ch of text) input.handleKey(ch, ch, false, false)
}
/** Shift+方向/Home/End。 */
function shiftKey(input: InputLine, name: string): void {
  input.handleKey(name, '', false, false, true)
}

describe('InputLine · 键盘选区（S1）', () => {
  it('shift+left 锚定并扩展选区（selectionRange 暴露范围）', () => {
    const input = new InputLine({ value: 'hello' })
    shiftKey(input, 'left')
    shiftKey(input, 'left')
    assert.deepEqual(input.selectionRange, { start: 3, end: 5 })
  })

  it('shift+right/home/end 覆盖四种扩展方向', () => {
    const input = new InputLine({ value: 'abc' })
    input.setValue('abc', 1)
    shiftKey(input, 'end')
    assert.deepEqual(input.selectionRange, { start: 1, end: 3 })
    shiftKey(input, 'home')
    assert.deepEqual(input.selectionRange, { start: 0, end: 1 })
  })

  it('普通移动折叠选区', () => {
    const input = new InputLine({ value: 'hello' })
    shiftKey(input, 'left')
    input.handleKey('left', '', false, false)
    assert.equal(input.selectionRange, null)
  })

  it('文本输入替换选区（对齐 codex / 常规编辑器）', () => {
    const input = new InputLine({ value: 'hello' })
    shiftKey(input, 'left')
    shiftKey(input, 'left')
    type(input, 'X')
    assert.equal(input.value, 'helX')
    assert.equal(input.selectionRange, null)
  })

  it('backspace 删除选区（独立 undo 单元，可恢复）', () => {
    const input = new InputLine({ value: 'hello' })
    shiftKey(input, 'left')
    shiftKey(input, 'left')
    input.handleKey('backspace', '', false, false)
    assert.equal(input.value, 'hel')
    input.handleKey('ctrl_z', '', true, false)
    assert.equal(input.value, 'hello')
  })

  it('Ctrl+K 剪切选区 → 值删除 + 内部剪贴板 + OSC52 drain', () => {
    const input = new InputLine({ value: 'hello world' })
    input.setValue('hello world', 5)
    shiftKey(input, 'end')
    input.handleKey('ctrl_k', '', true, false)
    assert.equal(input.value, 'hello')
    assert.equal(input.takeClipboardOut(), ' world', 'drain 出剪贴文本')
    assert.equal(input.takeClipboardOut(), null, 'drain 一次后清空')
  })

  it('Ctrl+K 无选区时保持 deleteToEnd 原语义', () => {
    const input = new InputLine({ value: 'hello' })
    input.setValue('hello', 2)
    input.handleKey('ctrl_k', '', true, false)
    assert.equal(input.value, 'he')
    assert.equal(input.takeClipboardOut(), null, '原路径不产生 OSC52 drain')
  })

  it('Alt+W 复制选区不删除（选区折叠）', () => {
    const input = new InputLine({ value: 'hello' })
    shiftKey(input, 'left')
    shiftKey(input, 'left')
    input.handleKey('unknown', 'w', false, true) // Alt+W：ESC+w → meta+char
    assert.equal(input.value, 'hello')
    assert.equal(input.selectionRange, null)
    assert.equal(input.takeClipboardOut(), 'lo')
  })

  it('Alt+Y yank 内部剪贴板（直插不触发粘贴折叠）', () => {
    const input = new InputLine({ value: 'hello' })
    shiftKey(input, 'left')
    shiftKey(input, 'left')
    input.handleKey('unknown', 'w', false, true) // 复制 'lo'
    input.handleKey('end', '', false, false)
    input.handleKey('unknown', 'y', false, true) // Alt+Y
    assert.equal(input.value, 'hellolo')
  })

  it('undo 后选区清空', () => {
    const input = new InputLine({ value: 'hello' })
    shiftKey(input, 'left')
    input.handleKey('backspace', '', false, false)
    input.handleKey('ctrl_z', '', true, false)
    shiftKey(input, 'left')
    input.handleKey('ctrl_z', '', true, false)
    assert.equal(input.selectionRange, null)
  })

  it('submit 后选区清空', () => {
    const input = new InputLine({ value: 'hello' })
    shiftKey(input, 'left')
    input.handleKey('return', '', false, false)
    assert.equal(input.selectionRange, null)
  })

  it('选区高亮渲染：反色 ANSI 包裹且不破坏行宽计量', () => {
    const input = new InputLine({ value: 'hello' })
    shiftKey(input, 'left')
    shiftKey(input, 'left')
    const { lines, caret } = input.displayLinesWithCaret({ maxWidth: 20 })
    assert.ok(lines[0]!.includes('\x1B[7m'), '选区范围应反色')
    assert.ok(lines[0]!.includes('\x1B[0m'), '反色正确复位')
    assert.deepEqual(caret, { line: 0, col: 5 }, 'caretCol 不受 ANSI 影响（❯ 2 + hel 3）')
  })

  it('选区跨折行：两行各自 REVERSE/RESET 封口', () => {
    const input = new InputLine({ value: 'a'.repeat(20) })
    input.setValue('a'.repeat(20), 2)
    for (let i = 0; i < 16; i++) shiftKey(input, 'right')
    const { lines } = input.displayLinesWithCaret({ maxWidth: 10 })
    const reversed = lines.filter(l => l.includes('\x1B[7m'))
    assert.ok(reversed.length >= 2, '跨折行的选区每行独立反色')
    for (const l of reversed) assert.ok(l.includes('\x1B[0m'), '每行反色均复位')
  })
})

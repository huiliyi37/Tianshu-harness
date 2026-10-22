import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { InputLine } from '../engine/input-line.js'

/** 逐键输入可打印字符（走 handleKey 真实路径）。 */
function type(input: InputLine, text: string): void {
  for (const ch of text) input.handleKey(ch, ch, false, false)
}

describe('InputLine · fish 式 undo（P1-1）', () => {
  it('连续 word 字符合并为一单元：一次 undo 全撤', () => {
    const input = new InputLine()
    type(input, 'abc')
    input.handleKey('ctrl_minus', '', true, false)
    assert.equal(input.value, '')
  })

  it('空格/换行各自独立单元（fish 分界）', () => {
    const input = new InputLine()
    type(input, 'ab cd')
    input.handleKey('ctrl_minus', '', true, false)
    assert.equal(input.value, 'ab ', '先撤 cd')
    input.handleKey('ctrl_minus', '', true, false)
    assert.equal(input.value, 'ab', '再撤空格')
    input.handleKey('ctrl_minus', '', true, false)
    assert.equal(input.value, '', '最后撤 ab')
  })

  it('CJK 连续输入按 word 合并（不按 \\w 口径拆碎）', () => {
    const input = new InputLine()
    type(input, '你好世界')
    input.handleKey('ctrl_minus', '', true, false)
    assert.equal(input.value, '')
  })

  it('标点各自独立单元', () => {
    const input = new InputLine()
    type(input, 'a,b')
    input.handleKey('ctrl_minus', '', true, false)
    assert.equal(input.value, 'a,')
    input.handleKey('ctrl_minus', '', true, false)
    assert.equal(input.value, 'a')
    input.handleKey('ctrl_minus', '', true, false)
    assert.equal(input.value, '')
  })

  it('删除是独立单元：undo 恢复被删内容', () => {
    const input = new InputLine()
    type(input, 'abc')
    input.handleKey('backspace', '', false, false)
    assert.equal(input.value, 'ab')
    input.handleKey('ctrl_minus', '', true, false)
    assert.equal(input.value, 'abc')
    assert.equal(input.cursor, 3, '光标恢复删除前位置')
  })

  it('粘贴（insertText 整段）是独立单元', () => {
    const input = new InputLine()
    input.insertText('hello world')
    input.handleKey('ctrl_minus', '', true, false)
    assert.equal(input.value, '')
  })

  it('光标移动封口：中插与尾插是两个单元', () => {
    const input = new InputLine()
    type(input, 'ab')
    input.handleKey('left', '', false, false)
    type(input, 'c') // "acb"
    assert.equal(input.value, 'acb')
    input.handleKey('ctrl_minus', '', true, false)
    assert.equal(input.value, 'ab')
    assert.equal(input.cursor, 1)
    input.handleKey('ctrl_minus', '', true, false)
    assert.equal(input.value, '')
  })

  it('历史导航记为单元：undo 直接在历史条目上回退到翻历史前', () => {
    const input = new InputLine({ history: ['old-cmd'] })
    input.handleKey('up', '', false, false)
    assert.equal(input.value, 'old-cmd')
    input.handleKey('ctrl_minus', '', true, false)
    assert.equal(input.value, '')
  })

  it('外部 setValue（审批填充/补全）是独立单元', () => {
    const input = new InputLine()
    type(input, 'ab')
    input.setValue('xyz')
    input.handleKey('ctrl_minus', '', true, false)
    assert.equal(input.value, 'ab')
    input.handleKey('ctrl_minus', '', true, false)
    assert.equal(input.value, '')
  })

  it('submit 清栈：上一条文本不被下一条的 undo 复活', () => {
    const input = new InputLine()
    type(input, 'first')
    input.handleKey('return', '', false, false) // submit
    type(input, 'x')
    input.handleKey('ctrl_minus', '', true, false)
    assert.equal(input.value, '')
    const ev = input.handleKey('ctrl_minus', '', true, false)
    assert.equal(ev, null, '栈空 undo 无效果')
    assert.equal(input.value, '')
  })

  it('Ctrl+Z 与 Ctrl+- 都是 undo 别名', () => {
    const input = new InputLine()
    type(input, 'ab')
    input.handleKey('ctrl_z', '', true, false)
    assert.equal(input.value, '')
  })

  it('vim normal 的 x/D 可撤销；normal 下 ctrl_z 也可用', () => {
    const input = new InputLine({ value: 'abc', vimEnabled: true })
    input.handleKey('escape', '', false, false) // → normal
    input.handleKey('0', '0', false, false)
    input.handleKey('x', 'x', false, false) // 删 'a'
    assert.equal(input.value, 'bc')
    input.handleKey('ctrl_z', '', true, false)
    assert.equal(input.value, 'abc')
  })

  it('快照滞留总量超限时逐出最旧单元（内存长尾防护）', () => {
    const input = new InputLine({ maxLength: 5_000_000 })
    input.setValue('a'.repeat(1_500_000)) // 单元：''
    input.setValue('b'.repeat(1_500_000))   // 单元：a×1.5M
    input.setValue('c')                     // 单元：b×1.5M → 总量 3M > 2M 上限
    // 逐出 '' 与 a 单元后仅剩 b 单元：只能 undo 一次
    input.handleKey('ctrl_minus', '', true, false)
    assert.equal(input.value, 'b'.repeat(1_500_000))
    const ev = input.handleKey('ctrl_minus', '', true, false)
    assert.equal(ev, null, '最旧单元已被逐出，栈空')
    assert.equal(input.value, 'b'.repeat(1_500_000))
  })
})

describe('InputLine · 历史草稿暂存（P1-2，↑/↓ 闸门对齐 codex）', () => {
  it('有草稿时 ↑/↓ 只移动光标，草稿不被历史换走', () => {
    const input = new InputLine({ history: ['h1', 'h2'] })
    type(input, 'my draft')
    input.handleKey('up', '', false, false)
    assert.equal(input.value, 'my draft')
    assert.equal(input.cursor, 0)
    input.handleKey('down', '', false, false)
    assert.equal(input.value, 'my draft')
    assert.equal(input.cursor, 'my draft'.length)
  })

  it('空输入框多步翻历史后回到空草稿', () => {
    const input = new InputLine({ history: ['h1', 'h2'] })
    input.handleKey('up', '', false, false)
    input.handleKey('up', '', false, false)
    assert.equal(input.value, 'h2')
    input.handleKey('down', '', false, false)
    assert.equal(input.value, 'h1')
    input.handleKey('down', '', false, false)
    assert.equal(input.value, '')
  })

  it('编辑召回的历史条目后，↑/↓ 不再翻历史；Ctrl+N 仍可显式回到草稿', () => {
    const input = new InputLine({ history: ['h1', 'h2'] })
    input.handleKey('up', '', false, false)
    type(input, 'x') // 编辑历史条目 h1 → h1x
    input.handleKey('up', '', false, false)
    assert.equal(input.value, 'h1x')
    assert.equal(input.cursor, 0)
    input.handleKey('ctrl_n', '', true, false)
    assert.equal(input.value, '')
  })

  it('submit 后草稿暂存清空', () => {
    const input = new InputLine({ history: ['h1'] })
    input.handleKey('up', '', false, false)
    input.handleKey('return', '', false, false) // submit h1
    assert.equal(input.value, '')
    const ev = input.handleKey('down', '', false, false)
    assert.equal(ev, null)
    assert.equal(input.value, '')
  })
})

describe('InputLine · redo（P3-A，Ctrl+Y）', () => {
  it('undo → redo 往返恢复', () => {
    const input = new InputLine()
    type(input, 'abc')
    input.handleKey('ctrl_z', '', true, false)
    assert.equal(input.value, '')
    input.handleKey('ctrl_y', '', true, false)
    assert.equal(input.value, 'abc')
    assert.equal(input.cursor, 3)
  })

  it('多步 undo/redo 按单元往返', () => {
    const input = new InputLine()
    type(input, 'ab cd')
    input.handleKey('ctrl_z', '', true, false) // 'ab '
    input.handleKey('ctrl_z', '', true, false) // 'ab'
    input.handleKey('ctrl_y', '', true, false)
    assert.equal(input.value, 'ab ')
    input.handleKey('ctrl_y', '', true, false)
    assert.equal(input.value, 'ab cd')
  })

  it('新编辑清空 redo 栈（分支失效语义）', () => {
    const input = new InputLine()
    type(input, 'ab')
    input.handleKey('ctrl_z', '', true, false)
    type(input, 'x')
    const ev = input.handleKey('ctrl_y', '', true, false)
    assert.equal(ev, null, 'redo 栈已失效')
    assert.equal(input.value, 'x')
  })

  it('submit 清空 undo+redo 双栈', () => {
    const input = new InputLine()
    type(input, 'ab')
    input.handleKey('ctrl_z', '', true, false)
    input.handleKey('return', '', false, false)
    const ev = input.handleKey('ctrl_y', '', true, false)
    assert.equal(ev, null)
  })

  it('vim normal 下 ctrl_y 可用', () => {
    const input = new InputLine({ value: 'abc', vimEnabled: true })
    input.handleKey('escape', '', false, false)
    input.handleKey('0', '0', false, false)
    input.handleKey('x', 'x', false, false) // 'bc'
    input.handleKey('ctrl_z', '', true, false)
    assert.equal(input.value, 'abc')
    input.handleKey('ctrl_y', '', true, false)
    assert.equal(input.value, 'bc')
  })
})

describe('InputLine · @file 节点原子删除（P3-C）', () => {
  it('backspace 在 @file: token 末尾整体删除', () => {
    const input = new InputLine({ value: 'fix @file:src/a.ts ' })
    input.handleKey('backspace', '', false, false)
    assert.equal(input.value, 'fix ')
  })

  it('引用形 @file:"a b.ts" 同样整体删除', () => {
    const input = new InputLine({ value: 'fix @file:"a b.ts" ' })
    input.handleKey('backspace', '', false, false)
    assert.equal(input.value, 'fix ')
  })

  it('token 中间位置不触发原子删除（走 grapheme 单删）', () => {
    const input = new InputLine({ value: 'fix @file:src/a.ts ' })
    input.setValue(input.value, 12) // 光标在 'sr|c' 之间（token 中间）
    input.handleKey('backspace', '', false, false)
    assert.equal(input.value, 'fix @file:sc/a.ts ', '只删一个字符（左侧形似完整 token 不误判）')
  })

  it('原子删除是独立 undo 单元（可恢复）', () => {
    const input = new InputLine({ value: 'fix @file:src/a.ts ' })
    input.handleKey('backspace', '', false, false)
    assert.equal(input.value, 'fix ')
    input.handleKey('ctrl_z', '', true, false)
    assert.equal(input.value, 'fix @file:src/a.ts ')
  })

  it('@folder:/@symbol:/@codebase: 同协议覆盖', () => {
    const input = new InputLine({ value: 'see @folder:src ' })
    input.handleKey('backspace', '', false, false)
    assert.equal(input.value, 'see ')
  })
})

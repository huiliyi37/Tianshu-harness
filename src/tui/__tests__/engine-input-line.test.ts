import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { InputLine } from '../engine/input-line.js'

describe('InputLine multi-line (W4b)', () => {
  it('backslash + Enter continues line instead of submitting', () => {
    const input = new InputLine({ value: 'first line\\' })
    let submitted: string | null = null
    const i2 = new InputLine({ value: 'first line\\', onSubmit: (v) => { submitted = v } })
    const ev = i2.handleKey('return', '', false, false)
    assert.equal(ev?.type, 'change')
    assert.equal(submitted, null)
    assert.equal(i2.value, 'first line\n')
    void input
  })

  it('Enter without trailing backslash submits', () => {
    let submitted: string | null = null
    const input = new InputLine({ value: 'hello\nworld', onSubmit: (v) => { submitted = v } })
    const ev = input.handleKey('return', '', false, false)
    assert.equal(ev?.type, 'submit')
    assert.equal(submitted, 'hello\nworld')
  })

  it('ctrl_j inserts a newline at cursor', () => {
    const input = new InputLine({ value: 'ab' })
    input.handleKey('left', '', false, false)
    const ev = input.handleKey('ctrl_j', '', true, false)
    assert.equal(ev?.type, 'change')
    assert.equal(input.value, 'a\nb')
  })

  it('shift+enter inserts a newline instead of submitting', () => {
    let submitted: string | null = null
    const input = new InputLine({ value: 'ab', onSubmit: (v) => { submitted = v } })
    input.handleKey('left', '', false, false)
    const ev = input.handleKey('return', '', false, false, true)
    assert.equal(ev?.type, 'change')
    assert.equal(input.value, 'a\nb')
    assert.equal(input.cursor, 2)
    assert.equal(submitted, null)
  })

  // ── newlineMode 粘滞换行（对齐公开仓）：开启后 Enter=换行、关闭恢复提交 ──
  it('newlineMode 开启后 Enter 插入换行且不提交', () => {
    let submitted: string | null = null
    const input = new InputLine({ value: 'hello', onSubmit: (v) => { submitted = v } })
    input.setNewlineMode(true)
    assert.equal(input.newlineMode, true)
    const ev = input.handleKey('return', '', false, false)
    assert.equal(ev?.type, 'change')
    assert.equal(input.value, 'hello\n')
    assert.equal(submitted, null, '换行模式下 Enter 不得触发提交')
  })

  it('newlineMode 关闭后 Enter 恢复提交语义', () => {
    let submitted: string | null = null
    const input = new InputLine({ value: 'hello', onSubmit: (v) => { submitted = v } })
    input.setNewlineMode(true)
    input.setNewlineMode(false)
    assert.equal(input.newlineMode, false)
    const ev = input.handleKey('return', '', false, false)
    assert.equal(ev?.type, 'submit')
    assert.equal(submitted, 'hello')
  })

  it('newlineMode 开启时 \\+Enter 续行仍优先（既有语义不变）', () => {
    const input = new InputLine({ value: 'first\\' })
    input.setNewlineMode(true)
    const ev = input.handleKey('return', '', false, false)
    assert.equal(ev?.type, 'change')
    assert.equal(input.value, 'first\n')
  })

  it('insertText inserts at cursor and advances cursor', () => {
    const input = new InputLine({ value: 'AB' })
    input.handleKey('left', '', false, false) // cursor at A|B
    input.insertText('XY')
    assert.equal(input.value, 'AXYB')
    // 续插一个字符应落在 XY 之后
    input.insertText('Z')
    assert.equal(input.value, 'AXYZB')
  })

  it('insertText with multi-line text keeps newlines (no submit)', () => {
    const input = new InputLine({ value: '' })
    input.insertText('line1\nline2')
    assert.equal(input.value, 'line1\nline2')
  })

  it('displayLines renders cursor line with ❯ prefix and █ marker', () => {
    const input = new InputLine({ value: 'one\ntwo' })
    // cursor at end → on second line
    const lines = input.displayLines()
    assert.deepEqual(lines, ['  one', '❯ two█'])
  })

  it('displayLines shows placeholder when empty', () => {
    const input = new InputLine({ placeholder: 'Type here' })
    assert.deepEqual(input.displayLines(), ['❯ █Type here'])
  })

  it('displayLines with maxLines keeps the cursor line visible', () => {
    const value = Array.from({ length: 12 }, (_, i) => `line${i}`).join('\n')
    const cursor = value.split('\n').slice(0, 6).join('\n').length + 1 // start of line6
    const input = new InputLine({ value })
    input.setValue(value, cursor)

    const lines = input.displayLines({ maxLines: 5 })

    assert.equal(lines.length, 5)
    assert.ok(lines.some(line => line.includes('lines above')))
    assert.ok(lines.some(line => line.includes('lines below')))
    assert.ok(lines.some(line => line.includes('❯ █line6')), 'cursor line must stay visible')
    assert.ok(!lines.some(line => line.includes('line11')), 'viewport should not blindly show only the tail')
  })

  it('placeholder accessor exposes option', () => {
    const input = new InputLine({ placeholder: 'p' })
    assert.equal(input.placeholder, 'p')
  })

  it('displayLines with maxWidth soft-wraps long lines instead of hiding the head', () => {
    const value = 'AAAAAAAAAA' + 'BBBBBBBBBB' + 'CCCCCCCCCC' // 30 chars
    const input = new InputLine({ value })
    const lines = input.displayLines({ maxWidth: 15 })

    assert.ok(lines.length > 1, 'long input should expand into multiple visual rows')
    assert.ok(lines[0]!.includes('AAAAAAAAAA'), 'head content should remain visible after soft wrap')
    assert.ok(lines.some(line => line.includes('CCCC')), 'tail content should remain visible')
    assert.ok(lines.some(line => line.includes('█')), 'cursor must remain visible')
  })

  it('displayLines with maxWidth keeps cursor visible when typing in the middle of wrapped text', () => {
    const value = 'a'.repeat(100)
    const input = new InputLine({ value })
    input.setValue(value, 50) // cursor at middle
    const lines = input.displayLines({ maxWidth: 20, maxLines: 5 })

    assert.equal(lines.length, 5)
    assert.ok(lines.some(line => line.includes('█')), 'cursor must remain visible in wrapped viewport')
    assert.ok(lines.some(line => line.includes('lines above')), 'wrapped viewport should report hidden rows above')
    assert.ok(lines.some(line => line.includes('lines below')), 'wrapped viewport should report hidden rows below')
  })

  it('displayLines wraps pasted multiline text by visual width while preserving explicit newlines', () => {
    const input = new InputLine({ value: 'first line\n' + 'x'.repeat(40) })
    const lines = input.displayLines({ maxWidth: 12 })

    assert.ok(lines[0]!.includes('first line'), 'explicit first line remains visible')
    assert.ok(lines.length >= 5, 'second logical line wraps into multiple visual rows')
    assert.ok(lines.some(line => line.includes('█')), 'cursor on wrapped pasted text remains visible')
  })

  it('displayLines wraps CJK 宽字符按双宽折行，光标落在正确行', () => {
    // '❯ ' 占 2 列 → maxContentWidth = 8 - 2 = 6；每个 CJK 占 2 列
    const input = new InputLine({ value: '一二三四' }) // 8 列，光标在末
    const lines = input.displayLines({ maxWidth: 8 })

    assert.ok(lines.length >= 2, 'CJK 文本在一行内放不下时应折到多视觉行')
    assert.ok(lines[0]!.includes('一二三'), '首视觉行应含前三个 CJK 字')
    assert.ok(lines.some(l => l.includes('四')), '最后一个 CJK 字在折行后仍可见')
    assert.ok(lines.some(l => l.includes('█')), '光标在折行后仍可见')
  })

  it('displayLines with maxWidth + empty value 显示占位符不触发软换行', () => {
    const input = new InputLine({ placeholder: '请输入' })
    const lines = input.displayLines({ maxWidth: 10 })
    assert.deepEqual(lines, ['❯ █请输入'], '空值应直接渲染占位符')
  })

  it('displayLines 内容+光标宽度恰好等于可用宽度时不触发软换行', () => {
    // '❯ ' 2 列；maxContentWidth = 15 - 2 = 13；12 个 a + █(1) = 13，恰好不换
    const value = 'a'.repeat(12)
    const input = new InputLine({ value })
    const lines = input.displayLines({ maxWidth: 15 })
    assert.equal(lines.length, 1, '内容+光标恰好填满可用宽度不应折行')
    assert.ok(lines[0]!.startsWith('❯ '), '光标行前缀应存在')
    assert.ok(lines[0]!.includes('a'.repeat(12) + '█'), '全部内容+光标均可见')
  })

  it('shift+return at maxLength 不插入不提交', () => {
    let submitted: string | null = null
    const input = new InputLine({ value: 'abcde', maxLength: 5, onSubmit: (v) => { submitted = v } })
    const ev = input.handleKey('return', '', false, false, true)
    assert.equal(ev, null, '已达 maxLength 时 shift+return 应被忽略')
    assert.equal(input.value, 'abcde', '值不变')
    assert.equal(submitted, null, '不触发提交')
  })

  it('displayLines with maxWidth 在多行值中正确追踪光标所在行', () => {
    const value = 'first\n' + 'x'.repeat(20)
    const input = new InputLine({ value })
    const lines = input.displayLines({ maxWidth: 10 })

    assert.ok(lines.length >= 3, '第二逻辑行应折行为多个视觉行')
    assert.ok(lines[0]!.includes('first'), '第一逻辑行不折行保持原样')
    assert.ok(lines.some(l => l.includes('█')), '光标在折行后的第二逻辑行中可见')
  })

  it('displayLines with maxWidth+maxLines 在软换行视图中按光标裁剪', () => {
    const value = 'x'.repeat(60)
    const input = new InputLine({ value })
    input.setValue(value, 30)
    const lines = input.displayLines({ maxWidth: 10, maxLines: 4 })

    assert.equal(lines.length, 4, '视口裁剪到 maxLines')
    assert.ok(lines.some(l => l.includes('█')), '光标在裁剪后仍可见')
    assert.ok(lines.some(l => l.includes('lines above')), '报告被裁掉的上方行数')
    assert.ok(lines.some(l => l.includes('lines below')), '报告被裁掉的下方行数')
  })

  // ── displayLinesWithCaret：零位移硬件光标定位（对标 Codex CLI）──────────

  it('caret: placeholder 空值时光标在 ❯ 之后（line 0, col 2）', () => {
    const input = new InputLine({ placeholder: 'Type here' })
    const { lines, caret } = input.displayLinesWithCaret()
    assert.deepEqual(lines, ['❯ Type here'])
    assert.deepEqual(caret, { line: 0, col: 2 })
  })

  it('caret: 多行值光标在末行行尾', () => {
    const input = new InputLine({ value: 'one\ntwo' })
    const { caret } = input.displayLinesWithCaret()
    assert.deepEqual(caret, { line: 1, col: 5 }) // '❯ ' 2 + 'two' 3
  })

  it('caret: 光标在行中间时 col 精确指向字符边界且文本零位移', () => {
    const input = new InputLine({ value: 'hello' })
    input.setValue('hello', 2)
    const { lines, caret } = input.displayLinesWithCaret()
    assert.deepEqual(lines, ['❯ hello'], '文本保持原样，不插入 █ 字符导致文字右移')
    assert.deepEqual(caret, { line: 0, col: 4 }) // '❯ ' 2 + 'he' 2
  })

  it('caret: zero-displacement 光标在文本间移动时文本内容保持完全静止', () => {
    const input = new InputLine({ value: 'hello world' })
    input.setValue('hello world', 0)
    const d0 = input.displayLinesWithCaret()
    input.setValue('hello world', 5)
    const d5 = input.displayLinesWithCaret()
    input.setValue('hello world', 11)
    const d11 = input.displayLinesWithCaret()
    assert.deepEqual(d0.lines, ['❯ hello world'])
    assert.deepEqual(d5.lines, ['❯ hello world'])
    assert.deepEqual(d11.lines, ['❯ hello world'])
    assert.deepEqual(d0.caret, { line: 0, col: 2 })
    assert.deepEqual(d5.caret, { line: 0, col: 7 })
    assert.deepEqual(d11.caret, { line: 0, col: 13 })
  })

  it('caret: wrap 路径坐标按软换行后的视觉行/列计算', () => {
    const input = new InputLine({ value: 'a'.repeat(30) })
    const { lines, caret } = input.displayLinesWithCaret({ maxWidth: 15 })
    assert.equal(lines.length, 3)
    assert.deepEqual(caret, { line: 2, col: 6 })
  })

  it('caret: wrap+maxLines 视口裁剪后 line 映射到窗口内下标', () => {
    const value = 'x'.repeat(60)
    const input = new InputLine({ value })
    input.setValue(value, 30)
    const { lines, caret } = input.displayLinesWithCaret({ maxWidth: 10, maxLines: 4 })
    assert.equal(lines.length, 4)
    assert.deepEqual(caret, { line: 2, col: 8 })
  })

  it('caret: CJK 宽字符按 cell 计列（非 code unit）', () => {
    const input = new InputLine({ value: '一二三四' })
    const { lines, caret } = input.displayLinesWithCaret({ maxWidth: 8 })
    assert.ok(lines[1]!.includes('四'))
    assert.deepEqual(caret, { line: 1, col: 4 }) // '❯ ' 2 + '四' 2 列
  })

  it('caret: 行尾光标恰好填满行宽时不折行、col 为满宽', () => {
    const input = new InputLine({ value: 'a'.repeat(12) })
    const { lines, caret } = input.displayLinesWithCaret({ maxWidth: 15 })
    assert.equal(lines.length, 1)
    assert.deepEqual(caret, { line: 0, col: 14 })
  })
})
describe('InputLine', () => {
  describe('basic editing', () => {
    it('inserts characters', () => {
      const input = new InputLine()
      input.handleKey('unknown', 'h', false, false)
      input.handleKey('unknown', 'i', false, false)
      assert.equal(input.value, 'hi')
      assert.equal(input.cursor, 2)
    })

    it('handles backspace', () => {
      const input = new InputLine({ value: 'hello' })
      const result = input.handleKey('backspace', '', false, false)
      assert.equal(input.value, 'hell')
      assert.equal(result?.type, 'change')
    })

    it('handles ctrl_h as backspace (Windows PowerShell sends 0x08)', () => {
      const input = new InputLine({ value: 'hello' })
      const result = input.handleKey('ctrl_h', '', true, false)
      assert.equal(input.value, 'hell')
      assert.equal(result?.type, 'change')
    })

    it('handles delete forward', () => {
      const input = new InputLine({ value: 'hello' })
      input.handleKey('left', '', false, false) // cursor at 4, on 'o'
      input.handleKey('delete', '', false, false) // delete char AT cursor
      assert.equal(input.value, 'hell')
    })

    it('ignores backspace at start', () => {
      const input = new InputLine()
      assert.equal(input.handleKey('backspace', '', false, false), null)
    })

    it('ignores delete at end', () => {
      const input = new InputLine({ value: 'a' })
      assert.equal(input.handleKey('delete', '', false, false), null)
    })

    it('inserts at cursor position', () => {
      const input = new InputLine({ value: 'ac' })
      input.handleKey('left', '', false, false)
      input.handleKey('unknown', 'b', false, false)
      assert.equal(input.value, 'abc')
    })
  })

  describe('cursor movement', () => {
    it('moves left and right', () => {
      const input = new InputLine({ value: 'ab' })
      assert.equal(input.cursor, 2)
      input.handleKey('left', '', false, false)
      assert.equal(input.cursor, 1)
      input.handleKey('right', '', false, false)
      assert.equal(input.cursor, 2)
    })

    it('home moves to start', () => {
      const input = new InputLine({ value: 'hello' })
      input.handleKey('home', '', false, false)
      assert.equal(input.cursor, 0)
    })

    it('end moves to end', () => {
      const input = new InputLine({ value: 'hello' })
      input.handleKey('home', '', false, false)
      input.handleKey('end', '', false, false)
      assert.equal(input.cursor, 5)
    })
  })

  describe('Ctrl key combos', () => {
    it('Ctrl+A moves to home', () => {
      const input = new InputLine({ value: 'hello' })
      input.handleKey('ctrl_a', '', true, false)
      assert.equal(input.cursor, 0)
    })

    it('Ctrl+E moves to end', () => {
      const input = new InputLine({ value: 'hello' })
      input.handleKey('ctrl_a', '', true, false)
      input.handleKey('ctrl_e', '', true, false)
      assert.equal(input.cursor, 5)
    })

    it('Ctrl+U deletes to start', () => {
      const input = new InputLine({ value: 'hello world' })
      input.handleKey('left', '', false, false)
      input.handleKey('ctrl_u', '', true, false)
      assert.equal(input.value, 'd')
    })

    it('Ctrl+K deletes to end', () => {
      const input = new InputLine({ value: 'hello world' })
      input.handleKey('left', '', false, false) // cursor before 'd' (pos 10)
      input.handleKey('ctrl_k', '', true, false)
      assert.equal(input.value, 'hello worl')
    })

    it('Ctrl+W deletes word backward', () => {
      const input = new InputLine({ value: 'hello world' })
      input.handleKey('ctrl_w', '', true, false)
      assert.equal(input.value, 'hello ')
    })
  })

  describe('submit', () => {
    it('calls onSubmit and returns submit event', () => {
      let submitted = ''
      const input = new InputLine({
        value: 'query',
        onSubmit: (v) => { submitted = v },
      })
      const result = input.handleKey('return', '', false, false)
      assert.equal(result?.type, 'submit')
      assert.equal(submitted, 'query')
    })

    it('clears the buffer after submit (no residual text in input box)', () => {
      const input = new InputLine({ value: 'hello world' })
      const result = input.handleKey('return', '', false, false)
      assert.equal(result?.type, 'submit')
      assert.equal(result?.value, 'hello world') // event still carries submitted text
      assert.equal(input.value, '') // but buffer is cleared
      assert.equal(input.cursor, 0)
      // next render shows an empty input line (placeholder), not the sent message
      assert.equal(input.displayLines().length, 1)
      assert.ok(!input.displayLines()[0]?.includes('hello world'))
    })

    it('clears the buffer after vim-normal submit', () => {
      const input = new InputLine({ vimEnabled: true, value: 'sent' })
      input.handleKey('escape', '', false, false) // → normal mode
      const result = input.handleKey('return', '', false, false)
      assert.equal(result?.type, 'submit')
      assert.equal(input.value, '')
      assert.equal(input.cursor, 0)
    })

    it('resets history index after submit so Up starts fresh', () => {
      const input = new InputLine({ history: ['old1', 'old2'] })
      input.handleKey('up', '', false, false) // value = 'old1'
      input.setValue('new query')
      input.handleKey('return', '', false, false)
      assert.equal(input.value, '')
      input.handleKey('up', '', false, false) // should fetch most recent history
      assert.equal(input.value, 'old1')
    })
  })

  describe('history', () => {
    it('navigates history with up/down', () => {
      const input = new InputLine({ history: ['cmd3', 'cmd2', 'cmd1'] })
      input.handleKey('up', '', false, false)
      assert.equal(input.value, 'cmd3')
      input.handleKey('up', '', false, false)
      assert.equal(input.value, 'cmd2')
      input.handleKey('down', '', false, false)
      assert.equal(input.value, 'cmd3')
    })

    it('returns null when no more history', () => {
      assert.equal(new InputLine().handleKey('up', '', false, false), null)
    })

    it('多行内容：首行按上原地停，不翻历史（防误触）', () => {
      const input = new InputLine({ history: ['old1', 'old2'] })
      input.setValue('line1\nline2\nline3', 0) // 光标在首行行首
      const ev = input.handleKey('up', '', false, false)
      // 不翻历史（value 不变），返回 null（原地停）
      assert.equal(ev, null)
      assert.equal(input.value, 'line1\nline2\nline3')
    })

    it('多行内容：末行按下原地停，不翻历史', () => {
      const input = new InputLine({ history: ['old1', 'old2'] })
      input.setValue('line1\nline2\nline3', 'line1\nline2\nline3'.length) // 光标在末行行尾
      const ev = input.handleKey('down', '', false, false)
      assert.equal(ev, null)
      assert.equal(input.value, 'line1\nline2\nline3')
    })

    it('多行内容：方向键仍可在行间移动', () => {
      const input = new InputLine({ history: ['old1'] })
      input.setValue('line1\nline2\nline3', 'line1\nline2\nline3'.length) // 末行行尾
      const ev = input.handleKey('up', '', false, false)
      assert.ok(ev?.type === 'change')
      assert.equal(input.value, 'line1\nline2\nline3') // value 不变，只是光标上移
    })

    it('多行内容：Ctrl+P 不再翻历史（已让位给命令面板，Ctrl+R 兜底）', () => {
      const input = new InputLine({ history: ['old1', 'old2'] })
      input.setValue('line1\nline2', 0)
      const ev = input.handleKey('ctrl_p', '', true, false)
      assert.equal(ev, null) // Ctrl+P 被 TuiApp 全局拦截开命令面板，InputLine 不响应
      assert.equal(input.value, 'line1\nline2')
    })
  })

  describe('vim mode', () => {
    it('switches to normal mode on Escape', () => {
      const input = new InputLine({ vimEnabled: true })
      assert.equal(input.vimMode, 'insert')
      input.handleKey('escape', '', false, false)
      assert.equal(input.vimMode, 'normal')
    })

    it('switches to insert mode with i', () => {
      const input = new InputLine({ vimEnabled: true })
      input.handleKey('escape', '', false, false)
      input.handleKey('unknown', 'i', false, false)
      assert.equal(input.vimMode, 'insert')
    })

    it('a moves cursor forward then enters insert', () => {
      const input = new InputLine({ vimEnabled: true, value: 'hello' })
      input.handleKey('escape', '', false, false)
      input.handleKey('left', '', false, false) // cursor from 5 → 4
      input.handleKey('unknown', 'a', false, false)
      assert.equal(input.vimMode, 'insert')
      assert.equal(input.cursor, 5) // 4+1=5
    })

    it('w + D in normal mode', () => {
      const input = new InputLine({ vimEnabled: true, value: 'hello world' })
      input.handleKey('escape', '', false, false)
      input.handleKey('home', '', false, false)
      // 'w' moves to next word start (position 6, 'w' of 'world')
      input.handleKey('unknown', 'w', false, false)
      input.handleKey('unknown', 'D', false, false)
      assert.equal(input.value, 'hello ')
    })

    it('setVimEnabled toggles vim on/off and resets to insert mode', () => {
      const input = new InputLine({ vimEnabled: false })
      assert.equal(input.vimEnabled, false)
      input.setVimEnabled(true)
      assert.equal(input.vimEnabled, true)
      assert.equal(input.vimMode, 'insert', '启用后从 insert 起步')
      input.handleKey('escape', '', false, false)
      assert.equal(input.vimMode, 'normal')
      // 关闭时复位 insert，避免残留 normal 态吞普通字符
      input.setVimEnabled(false)
      assert.equal(input.vimEnabled, false)
      assert.equal(input.vimMode, 'insert', '停用后复位 insert')
    })
  })

  describe('word navigation', () => {
    it('Option+Left moves to previous word start', () => {
      const input = new InputLine({ value: 'hello world' })
      input.handleKey('left', '', false, true) // meta+left
      assert.equal(input.cursor, 6)
    })

    it('Option+Right moves to next word end', () => {
      const input = new InputLine({ value: 'hello world' })
      input.handleKey('home', '', false, false)
      input.handleKey('right', '', false, true) // meta+right
      assert.equal(input.cursor, 5)
    })

    it('Option+Backspace deletes word backward', () => {
      const input = new InputLine({ value: 'hello world' })
      input.handleKey('backspace', '', false, true) // meta+backspace
      assert.equal(input.value, 'hello ')
    })
  })

  describe('maxLength', () => {
    it('caps input at maxLength', () => {
      const input = new InputLine({ maxLength: 5 })
      for (const ch of 'hello world') {
        input.handleKey('unknown', ch, false, false)
      }
      assert.equal(input.value, 'hello')
    })
  })

  describe('setValue', () => {
    it('updates value and cursor from external source', () => {
      const input = new InputLine()
      input.setValue('new text', 3)
      assert.equal(input.value, 'new text')
      assert.equal(input.cursor, 3)
    })
  })
})

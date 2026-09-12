/**
 * Ghost 渲染复现测试 — 输入框重叠（双边框）根因定位。
 *
 * 现象：两帧连续渲染后，第一帧的顶框（╭──...──╮）未被擦除，
 *       第二帧的顶框叠加在上，形成双边框重叠。
 *
 * 根因假设：
 *   A) rowsForLine 对含 ANSI 码的行宽度计算偏大 → lastDisplayRows 偏小
 *      → cursorUp 量不足 → ERASE_SCREEN_END 擦不到第一帧部分行
 *   B) buildDiff 在行内容变化但结构不变时，对首行（顶框）的 ERASE_LINE 失效
 *      （顶框含 ANSI 色码，lineCache 缓存的是旧帧文本，new text !== cached text
 *       触发 ERASE_LINE，但 ERASE_LINE 只擦当前物理行，无法处理 wrap 行）
 *
 * 本测试用 screen-buffer MockTerminal 逐帧比对，抓到残留即 RED。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { WriteStream } from 'node:tty'
import { LiveEngine, type LiveRegionLine } from '../live-engine.js'
import { displayWidth, truncateToDisplayWidth } from '../../width.js'
import { formatThinking } from '../../format/thinking.js'
import { getTheme } from '../../theme.js'
import stringWidth from 'string-width'

/**
 * screen-buffer 终端模拟器：追踪整屏内容（display rows × columns 网格）。
 * 可打印字符绘制到网格，CSI 序列更新光标/擦除，\n/\r 控制换行。
 * 关键：ERASE_SCREEN_END (CSI 0J) 和 ERASE_LINE (CSI 2K) 准确建模擦除行为。
 */
class ScreenTerminal {
  columns: number
  rows: number
  cursorRow = 0
  cursorCol = 0
  /** 是否把非 box/block 的 ambiguous 符号（— … ↑↓ ·）按 2 列渲染（模拟 CJK 终端）。 */
  ambiguousWide: boolean

  /** displayRows × columns 字符网格 */
  screen: string[][] = []

  writes: string[] = []

  /** 宽字符尾随单元占位符（读屏时剔除），使宽字形只在网格里占 1 个可读字符。 */
  private static readonly WIDE_PAD = '\u0000'

  constructor(columns: number, rows: number, opts: { ambiguousWide?: boolean } = {}) {
    this.columns = columns
    this.rows = rows
    this.ambiguousWide = opts.ambiguousWide ?? false
    this.clearScreen()
  }

  /** 单个字符的终端显示宽度（与生产 displayWidth 同口径，box/block 恒为 1）。 */
  private charWidth(ch: string): number {
    return displayWidth(ch, { ambiguousAsWide: this.ambiguousWide })
  }

  private clearScreen(): void {
    this.screen = Array.from({ length: this.rows }, () => Array(this.columns).fill(' '))
  }

  /** 获取屏幕上某行的纯文本（剔除宽字符占位符，去尾部空格，去 ANSI 转义序列）。 */
  getRow(row: number): string {
    if (row < 0 || row >= this.rows) return ''
    const raw = this.screen[row]!.join('').split(ScreenTerminal.WIDE_PAD).join('').replace(/ +$/, '')
    return this.stripAnsi(raw)
  }

  /** 获取从某行开始的所有非空行文本（已去 ANSI 与宽字符占位符）。 */
  getRowsFrom(startRow: number): string[] {
    const result: string[] = []
    for (let r = startRow; r < this.rows; r++) {
      const text = this.stripAnsi(this.screen[r]!.join('').split(ScreenTerminal.WIDE_PAD).join(''))
      if (text.trim() === '') continue
      result.push(text)
    }
    return result
  }

  /** 去除 ANSI CSI/SGR 转义序列。 */
  private stripAnsi(s: string): string {
    return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
  }

  /** 光标处写一个字符（仿真实终端 pending-wrap：到达最后一列不立即 wrap，下一字符才
   *  wrap，不丢字符）。宽字形（CJK / ambiguousWide 下的 — … ↑↓ ·）占 2 列：
   *  首列写字形、次列写占位符；放不下行尾 1 列时整体折到下一行。 */
  private putChar(ch: string): void {
    const w = Math.max(1, this.charWidth(ch))
    // pending-wrap：光标已在/越过右边界 → 先折行再写。
    if (this.cursorCol >= this.columns) {
      this.cursorRow++
      this.cursorCol = 0
    }
    // 宽字符放不下当前行最后 1 列 → 整体折到下一行（真实终端行为）。
    if (w === 2 && this.cursorCol === this.columns - 1) {
      this.cursorRow++
      this.cursorCol = 0
    }
    if (this.cursorRow >= this.rows) return
    this.screen[this.cursorRow]![this.cursorCol] = ch
    if (w === 2 && this.cursorCol + 1 < this.columns) {
      this.screen[this.cursorRow]![this.cursorCol + 1] = ScreenTerminal.WIDE_PAD
    }
    this.cursorCol += w
  }

  flush(): string {
    const s = this.writes.join('')
    this.writes = []
    return s
  }

  write = (chunk: string): boolean => {
    this.writes.push(chunk)
    let i = 0
    while (i < chunk.length) {
      const ch = chunk[i]!

      // CSI 序列
      if (ch === '\x1B' && chunk[i + 1] === '[') {
        let j = i + 2
        let isPrivate = false
        if (chunk[j] === '?') { isPrivate = true; j++ }
        let params = ''
        while (j < chunk.length && /[0-9;]/.test(chunk[j]!)) { params += chunk[j]; j++ }
        const final = chunk[j]
        const n = params === '' ? 1 : parseInt(params.split(';')[0]!, 10)

        if (!isPrivate) {
          switch (final) {
            case 'A': this.cursorRow = Math.max(0, this.cursorRow - n); break
            case 'B': this.cursorRow = Math.min(this.rows - 1, this.cursorRow + n); break
            case 'G': this.cursorCol = Math.max(0, n - 1); break
            case 'J': {
              // Erase in Display
              if (n === 0 || params === '') {
                // Erase from cursor to end of screen
                this.eraseFromCursor()
              } else if (n === 2) {
                // Erase entire screen
                this.clearScreen()
              }
              break
            }
            case 'K': {
              // Erase in Line
              if (n === 2 || params === '' || params === '0') {
                this.eraseLine()
              }
              break
            }
            case 'm': break // SGR (color) — 不占屏，忽略
            default: break
          }
        }
        i = j + 1
        continue
      }

      if (ch === '\n') {
        this.cursorRow++
        this.cursorCol = 0
        i++
        continue
      }
      if (ch === '\r') {
        this.cursorCol = 0
        i++
        continue
      }

      // 可打印字符
      this.putChar(ch)
      i++
    }
    return true
  }

  /** 从光标处擦到屏末（ERASE_SCREEN_END）。 */
  private eraseFromCursor(): void {
    // 先擦当前行从光标列到行尾
    for (let c = this.cursorCol; c < this.columns; c++) {
      this.screen[this.cursorRow]![c] = ' '
    }
    // 再擦下面所有行
    for (let r = this.cursorRow + 1; r < this.rows; r++) {
      for (let c = 0; c < this.columns; c++) {
        this.screen[r]![c] = ' '
      }
    }
  }

  /** 擦除当前整行（ERASE_LINE）。 */
  private eraseLine(): void {
    for (let c = 0; c < this.columns; c++) {
      this.screen[this.cursorRow]![c] = ' '
    }
  }
}

function asStdout(term: ScreenTerminal): WriteStream {
  return term as unknown as WriteStream
}

function lines(...texts: string[]): LiveRegionLine[] {
  return texts.map(text => ({ text }))
}

// ── 探针：stringWidth 对含 ANSI 码的文本计算是否准确 ──────────
// 这是根因假设 A 的直接验证。

test('探针: stringWidth 对含 ANSI 码的 CJK 混合文本计算正确', () => {
  const term = new ScreenTerminal(120, 40)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  // 模拟真实 topBorder — 含 ╭、天枢(CJK)、ANSI 色码、(main)、┬、v4-pro 等
  const color = (s: string, code: string): string => `\x1B[38;5;${code}m${s}\x1B[39m`
  const topBorder =
    color('╭', '140') +
    color('──', '140') +
    color('天枢', '140') +
    ' ' +
    color('(main)', '100') +
    color('─'.repeat(20), '140') +
    color('┬', '140') +
    color('─'.repeat(20), '140') +
    color('v4-pro', '100') +
    '  ' +
    color('⚡0%', '100') +
    '  ' +
    color('◧6k/1.0M', '100') +
    '  ' +
    color('2s', '100') +
    color('──', '140') +
    color('╮', '140')

  const inputLine = color('│', '140') + ' ' + color('❯', '2') + ' ' + color('█', '4') + color('询问任何事', '100') + '                    ' + color('│', '140')
  const botBorder = color('╰', '140') + color('─'.repeat(118), '140') + color('╯', '140')

  // 首帧渲染
  engine.render(lines(topBorder, inputLine, botBorder))
  const afterFirst = term.getRowsFrom(0).join('\n')
  term.flush()

  // 第二帧：仅 elapsed 变化（2s → 21s）
  const topBorder2 =
    color('╭', '140') +
    color('──', '140') +
    color('天枢', '140') +
    ' ' +
    color('(main)', '100') +
    color('─'.repeat(20), '140') +
    color('┬', '140') +
    color('─'.repeat(20), '140') +
    color('v4-pro', '100') +
    '  ' +
    color('⚡0%', '100') +
    '  ' +
    color('◧6k/1.0M', '100') +
    '  ' +
    color('21s', '100') +  // ← elapsed 变化
    color('──', '140') +
    color('╮', '140')

  // 第二帧渲染 —— 先检查 rowsForLine
  const rowsCount = engine['rowsForLine'](topBorder)

  engine.render(lines(topBorder2, inputLine, botBorder))
  const afterSecond = term.getRowsFrom(0).join('\n')

  // 断言：第二帧不应残留第一帧的 "2s"
  const count2s = (afterSecond.match(/2s/g) || []).length
  const count21s = (afterSecond.match(/21s/g) || []).length

  // 第二帧后屏幕应只有 "21s"，不应有 "2s"
  assert.equal(count2s, 0, `屏幕残留第一帧的 "2s" (count=${count2s}) — 顶框擦除不完整`)
  assert.ok(count21s >= 1, `第二帧的 "21s" 应出现在屏幕上 (count=${count21s})`)

  // 同时断言只有一组边框（只有一个 ╭）
  const tulCornerCount = afterSecond.split('╭').length - 1
  assert.equal(tulCornerCount, 1, `╭ 出现 ${tulCornerCount} 次，预期 1 次 — 多帧边框重叠`)
})

// ── 场景：快速连续渲染（模拟 rapid input/ticker）─────────────

test('连续 10 帧快速渲染不产生 border 残留', () => {
  const term = new ScreenTerminal(120, 40)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  const color = (s: string, code: string): string => `\x1B[38;5;${code}m${s}\x1B[39m`
  for (let tick = 0; tick < 10; tick++) {
    const elapsed = `${tick}s`
    const topBorder =
      color('╭', '140') +
      color('──', '140') +
      color('天枢', '140') +
      ' ' +
      color('(main)', '100') +
      color('─'.repeat(10), '140') +
      color('┬', '140') +
      color('─'.repeat(10), '140') +
      color(`elapsed=${elapsed}`, '100') +
      color('──', '140') +
      color('╮', '140')
    engine.render(lines(topBorder, color('│ ❯ █', '140') + '                    ' + color('│', '140')))
  }

  const screen = term.getRowsFrom(0).join('\n')
  // 只应出现一次边框
  const tulCount = screen.split('╭').length - 1
  assert.equal(tulCount, 1, `10 帧后 ╭ 出现 ${tulCount} 次，预期 1 次 — 帧间擦除失效导致残留`)

  // 应只出现最后一帧的 elapsed 值
  assert.ok(screen.includes('elapsed=9s'), '屏幕应包含最后一帧的 elapsed=9s')
  for (let tick = 0; tick < 9; tick++) {
    assert.ok(!screen.includes(`elapsed=${tick}s`), `屏幕不应残留旧帧的 elapsed=${tick}s`)
  }
})

// ── 场景：空值 placeholder 帧 → 有输入帧切换 ─────────────────

test('placeholder 帧到有输入帧切换，不残留 placeholder 边框', () => {
  const term = new ScreenTerminal(120, 40)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  const color = (s: string, code: string): string => `\x1B[38;5;${code}m${s}\x1B[39m`

  // Frame 1: placeholder (空输入)
  const topBorder1 =
    color('╭──天枢 (main)──┬──v4-pro──╮', '140')
  const placeHolderLine = color('│', '140') + ' ' + color('❯', '2') + ' ' + color('█询问任何事，或 / 唤起命令', '100') + ' ' + color('│', '140')
  engine.render(lines(topBorder1, placeHolderLine))

  // Frame 2: 用户输入了文字
  const topBorder2 =
    color('╭──天枢 (main)──┬──v4-pro──╮', '140')
  const inputLine = color('│', '140') + ' ' + color('❯', '2') + ' ' + 'hello world' + color('█', '4') + ' ' + color('│', '140')
  engine.render(lines(topBorder2, inputLine))

  const screen = term.getRowsFrom(0).join('\n')
  const tulCount = screen.split('╭').length - 1
  assert.equal(tulCount, 1, `╭ 出现 ${tulCount} 次，预期 1 次`)

  // placeholder 文本不应残留
  assert.ok(!screen.includes('询问任何事'), 'placeholder 不应残留在新帧中')
  assert.ok(screen.includes('hello world'), '新帧内容应出现')
})

// ── 场景：slash 命令触发行数变化（走 buildFullRewrite）──────

test('slash 命令输入导致行数变化，不残留旧顶框', () => {
  const term = new ScreenTerminal(120, 40)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  const color = (s: string, code: string): string => `\x1B[38;5;${code}m${s}\x1B[39m`
  const borderNormal = '140'
  const borderSlash = '4'

  const top1 = color('╭', borderNormal) + color('──天枢 (main)──┬──v4-pro──╮', borderNormal)
  const bot1 = color('╰' + '─'.repeat(118) + '╯', borderNormal)
  engine.render(lines(top1, color('│ ❯ █placeholder', borderNormal), bot1))
  term.flush()

  const top2 = color('╭', borderSlash) + color('──天枢 (main)──┬──v4-pro──╮', borderSlash)
  const input2 = color('│', borderSlash) + ' ' + color('❯', '2') + ' ' + '/help' + color('█', '4') + ' ' + color('│', borderSlash)
  const bot2 = color('╰' + '─'.repeat(118) + '╯', borderSlash)
  const hint1 = color('  /help', '100') + '  ' + color('显示帮助信息', '100')
  const hint2 = color('  /clear', '100') + ' ' + color('清屏', '100')
  const hint3 = color('  /model', '100') + ' ' + color('切换模型', '100')

  engine.render(lines(top2, input2, bot2, hint1, hint2, hint3))

  const screen = term.getRowsFrom(0).join('\n')
  const tulCount = screen.split('╭').length - 1
  assert.equal(tulCount, 1, `slash 触发后 ╭ 出现 ${tulCount} 次，预期 1 次 — buildFullRewrite 擦除不完整`)

  // slash hints 应出现
  assert.ok(screen.includes('/help'), 'slash hint /help 应出现')
  assert.ok(screen.includes('/clear'), 'slash hint /clear 应出现')
})

// ── 场景：slash 输入逐字符增长（连续行数变化）─────────────

test('slash 逐字符输入不产生 ghost 累积', () => {
  const term = new ScreenTerminal(120, 40)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  const color = (s: string, code: string): string => `\x1B[38;5;${code}m${s}\x1B[39m`
  const borderSlash = '4'

  // 逐帧模拟：空 → / → /h → /he → /hel → /help
  const steps = ['', '/', '/h', '/he', '/hel', '/help']
  for (const val of steps) {
    const isSlash = val.startsWith('/') && !val.includes(' ')
    const bc = isSlash ? borderSlash : '140'
    const top = color('╭──天枢──┬──v4-pro──╮', bc)
    const input = color('│', bc) + ' ' + color('❯', '2') + ' ' + val + color('█', '4') + ' ' + color('│', bc)
    const bot = color('╰' + '─'.repeat(116) + '╯', bc)

    const allLines = [top, input, bot]
    if (isSlash && !val.includes(' ')) {
      allLines.push(color('  /help  帮助', '100'))
      allLines.push(color('  /clear 清屏', '100'))
    }
    engine.render(lines(...allLines))
  }

  const screen = term.getRowsFrom(0).join('\n')
  const tulCount = screen.split('╭').length - 1
  assert.equal(tulCount, 1, `逐字符 slash 输入后 ╭ 出现 ${tulCount} 次，预期 1 次`)

  // 最后一帧是 /help 的 slash 态
  assert.ok(screen.includes('/help'), '最后一帧应含 /help hint')
})

// ── 场景：CJK/ambiguous-wide 终端 — 含 — … · 的提示行实际换行成 2 行 ──────
// 这是用户报告的「交付后输入框换行重叠」的精确复现：动态行含 East-Asian
// Ambiguous 符号（终端按 2 列渲染），string-width 按 1 列计 → rowsForLine 低估
// → buildFullRewrite 回顶欠擦 → 旧帧顶框泄漏。修复后 rowsForLine 按 wide 度量
// （RIVET_AMBIGUOUS_WIDTH=wide）与终端一致，重影消失。
// 升级后的 ScreenTerminal 按显示宽度推进光标，故能复现该换行错位。

test('ambiguous-wide 终端下含 — … · 的提示行（窄计=列宽/宽计>列宽）换行不残留旧顶框', () => {
  const prev = process.env.RIVET_AMBIGUOUS_WIDTH
  process.env.RIVET_AMBIGUOUS_WIDTH = 'wide'
  try {
    const cols = 40
    const term = new ScreenTerminal(cols, 30, { ambiguousWide: true })
    const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })
    const color = (s: string, c: string): string => `\x1B[38;5;${c}m${s}\x1B[39m`

    // 含 — … · 三个 ambiguous 符号：窄计 = cols（1 行），宽计 > cols（终端换行成 2 行）。
    const filler = 'c'.repeat(cols - 15)
    const widish = '  /x — a … b · ' + filler
    assert.equal(displayWidth(widish), cols, '锚定：窄计应等于列宽')
    assert.ok(displayWidth(widish, { ambiguousAsWide: true }) > cols, '锚定：宽计应超过列宽（终端换行）')

    const top = color('╭──天枢──┬──glm──╮', '140')
    const input = color('│ ❯ █ │', '140')
    const bot = color('╰' + '─'.repeat(cols - 2) + '╯', '140')
    const hint2 = color('  /y hint2', '100')
    const hint3 = color('  /z hint3', '100')

    // Frame A：2 行提示（widish 在终端占 2 显示行）
    engine.render(lines(top, input, bot, widish, hint2))
    term.flush()
    // Frame B：3 行提示 → 行数变化 → buildFullRewrite，回顶量依赖 widish 被算作 2 行
    engine.render(lines(top, input, bot, widish, hint2, hint3))

    const screen = term.getRowsFrom(0).join('\n')
    const tulCount = screen.split('╭').length - 1
    assert.equal(tulCount, 1, `ambiguous 行换行后 ╭ 出现 ${tulCount} 次，预期 1 次 — rowsForLine 低估导致重影`)
    assert.ok(screen.includes('hint3'), 'Frame B 的 hint3 应出现')
  } finally {
    if (prev === undefined) delete process.env.RIVET_AMBIGUOUS_WIDTH
    else process.env.RIVET_AMBIGUOUS_WIDTH = prev
  }
})

// ── 探针: ScreenTerminal 按显示宽度推进光标（CJK 占 2 列、超宽行折行）──────────
test('探针: ScreenTerminal 按显示宽度推进光标（CJK 占 2 列、宽行折行）', () => {
  const term = new ScreenTerminal(10, 5, { ambiguousWide: true })
  // 写 6 个 CJK（每个 2 列）= 12 列 > 10 → 折到第二行
  term.write('天枢天枢天枢')
  assert.equal(term.getRow(0), '天枢天枢天', '首行容纳 5 个 CJK（10 列）')
  assert.equal(term.getRow(1), '枢', '第 6 个 CJK 折到第二行')
})

// ── forceRedraw 反模式回归：clear()+render() 走 append 路径残留旧帧 ──────
// 这是 app.ts forceRedraw 输入框重影的底层根因。forceRedraw 曾用 live.clear()
// 再 render()，clear 置 lastDisplayRows=0 → render 走 append 分支（无擦除）。
// 当 clear 的 erase 因 lastDisplayRows 与屏上实际行数不符（域/主题切换改了
// wrap 宽度）而覆盖不全时，旧输入框帧残留，新帧叠上去 = 重影。
// 正确做法：直接 render()，保留 lastDisplayRows>0 → 走 fullRewrite（真实
// prevDisplayRows 原子擦写）。本测试锁定这个不变量。

test('forceRedraw 反模式: clear()+render() 在行数变化后残留旧帧', () => {
  const term = new ScreenTerminal(120, 40)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })
  const color = (s: string, c: string): string => `\x1B[38;5;${c}m${s}\x1B[39m`

  // Frame 1: 一个域名的顶框（"天枢" 2 字）
  const top1 = color('╭──天枢──┬──v4-pro──╮', '140')
  const input1 = color('│ ❯ █placeholder', '140')
  const bot1 = color('╰' + '─'.repeat(116) + '╯', '140')
  engine.render(lines(top1, input1, bot1))
  term.flush()

  // 模拟域切换：新域名更长，wrap 行数变化 → lastDisplayRows 与新帧不符。
  // forceRedraw 错误路径：clear() + render()。
  engine.clear()
  const top2 = color('╭──天玑域（长域名）──┬──v4-pro──╮', '140')
  const input2 = color('│ ❯ █placeholder', '140')
  const bot2 = color('╰' + '─'.repeat(110) + '╯', '140')
  engine.render(lines(top2, input2, bot2))

  const screenWrong = term.getRowsFrom(0).join('\n')
  const tulWrong = screenWrong.split('╭').length - 1
  // 反模式会残留旧顶框（append 路径无擦除）— 记录现象，不在此断言为错
  // （ScreenTerminal 的 clear 精确建模，故这里可能擦干净；真实终端 reflow 才漏）。
  // 本用例的价值在于与下面的正确路径对比。
  term.flush()
})

test('forceRedraw 正确路径: 无 clear 的 render() 走 fullRewrite，绝不残留旧帧', () => {
  const term = new ScreenTerminal(120, 40)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })
  const color = (s: string, c: string): string => `\x1B[38;5;${c}m${s}\x1B[39m`

  // Frame 1
  const top1 = color('╭──天枢──┬──v4-pro──╮', '140')
  const input1 = color('│ ❯ █placeholder', '140')
  const bot1 = color('╰' + '─'.repeat(116) + '╯', '140')
  engine.render(lines(top1, input1, bot1))
  term.flush()

  // 正确路径：直接 render（保留 lastDisplayRows>0）。域切换致内容变化 →
  // canDiff=false（行文本不同）→ buildFullRewrite（moveToTop+ERASE+重写）。
  const top2 = color('╭──天玑域──┬──v4-pro──╮', '140')
  const input2 = color('│ ❯ █placeholder', '140')
  const bot2 = color('╰' + '─'.repeat(116) + '╯', '140')
  engine.render(lines(top2, input2, bot2))

  const screen = term.getRowsFrom(0).join('\n')
  const tulCount = screen.split('╭').length - 1
  assert.equal(tulCount, 1, `fullRewrite 后 ╭ 出现 ${tulCount} 次，预期 1 — forceRedraw 残留旧帧`)
  assert.ok(!screen.includes('天枢'), '旧域名"天枢"不应残留在新帧中')
  assert.ok(screen.includes('天玑域'), '新域名应出现')
})

// ── 输入框重影：含 ambiguous 符号的输入行折行致 rowsForLine 低估 ──────────────
// 用户报告：复制粘贴 / 方向键读历史时输入框重复渲染。根因 = East-Asian Ambiguous
// 符号（— … · → ↑ ↓ •，CJK 终端按 2 列渲染）在 narrow 默认下被算 1 列：
//   渲染层 padding 按窄补 → 实际行宽在 wide 终端溢出 columns → 折行
//   rowsForLine 按窄算 → 认为 1 行 → lastDisplayRows 低估
//   → 下一帧 fullRewrite 的 cursorUp 量不足 → 旧输入框底部残留 = 重影
// 修复：app.ts renderInputRow 用 wide 上界截断+padding（与 clampLine 同口径），
// 保证行宽 ≤ columns → 不折行 → rowsForLine（窄/宽口径）都算 1 行。
// 本组用 ScreenTerminal(ambiguousWide:true) 模拟 CJK 终端，对比 narrow 旧逻辑与
// wide 新逻辑在 paste / history 两个用户场景下的重影。

/** 复刻 app.ts 旧实现：narrow truncateToWidth + stringWidth padding（重影源） */
function inputRowNarrow(content: string, innerWidth: number, leftBar: string, rightBar: string): string {
  let truncated = content
  if (stringWidth(content) > innerWidth) {
    truncated = ''
    let w = 0
    for (const ch of content) {
      const cw = stringWidth(ch)
      if (w + cw > innerWidth) break
      truncated += ch
      w += cw
    }
  }
  const pad = Math.max(0, innerWidth - stringWidth(truncated))
  return `${leftBar}${truncated}${' '.repeat(pad)}${rightBar}`
}

/** 复刻 app.ts renderInputRow 新实现：wide 截断 + wide padding（修复后） */
function inputRowWide(content: string, innerWidth: number, leftBar: string, rightBar: string): string {
  const opts = { ambiguousAsWide: true }
  const truncated = truncateToDisplayWidth(content, innerWidth, opts)
  const pad = Math.max(0, innerWidth - displayWidth(truncated, opts))
  return `${leftBar}${truncated}${' '.repeat(pad)}${rightBar}`
}

const AMBIG_FILLER = '— … → ·' // 4 个 ambiguous 符号（CJK 终端各按 2 列，比 narrow 多 4 列）

test('反模式确认: narrow padding 下含 ambiguous 的输入行在 wide 终端折行（重影前提）', () => {
  const cols = 40
  const innerWidth = cols - 6 // 34
  const term = new ScreenTerminal(cols, 20, { ambiguousWide: true })
  // 内容窄计恰好填满 innerWidth，但含 ambiguous → wide 终端实际更宽 → 折行
  const ascii = 'x'.repeat(innerWidth - AMBIG_FILLER.length)
  const content = ascii + AMBIG_FILLER
  const leftBar = '│ '
  const rightBar = ' │'
  const row = inputRowNarrow(content, innerWidth, leftBar, rightBar)
  // 写入终端，看占几行（ambiguousWide 模拟器按 2 列推进光标）
  term.write(row)
  // 末行 row 1 是折行后的第二段内容
  assert.ok(term.getRow(1).trim().length > 0, 'narrow padding 下 wide 终端应折到第 2 行（重影前提成立）')
})

test('paste 含 ambiguous 字符: wide padding 不残留旧输入框（用户场景 1）', () => {
  const cols = 40
  const innerWidth = cols - 6
  const term = new ScreenTerminal(cols, 30, { ambiguousWide: true })
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })
  const leftBar = '│ '
  const rightBar = ' │'
  const top = '╭' + '─'.repeat(cols - 2) + '╮'
  const bot = '╰' + '─'.repeat(cols - 2) + '╯'

  // Frame 1: placeholder（空输入，无 ambiguous，单行）
  const ph = inputRowWide(`❯ █placeholder`, innerWidth, leftBar, rightBar)
  engine.render(lines(top, ph, bot))
  term.flush()

  // Frame 2: paste 多行文本，其中一行内容接近列宽且含 — … →（ambiguous）
  // —— 真实 paste 技术文档的典型形态
  const ascii = 'x'.repeat(innerWidth - AMBIG_FILLER.length - 8)
  const line1 = inputRowWide('  行一', innerWidth, leftBar, rightBar)
  const line2 = inputRowWide(`❯ ${ascii}${AMBIG_FILLER}█`, innerWidth, leftBar, rightBar)
  engine.render(lines(top, line1, line2, bot))

  const screen = term.getRowsFrom(0).join('\n')
  const tulCount = screen.split('╭').length - 1
  const botCount = screen.split('╰').length - 1
  assert.equal(tulCount, 1, `paste 后 ╭ 出现 ${tulCount} 次，预期 1 — 旧顶框残留 = 输入框重影`)
  assert.equal(botCount, 1, `paste 后 ╰ 出现 ${botCount} 次，预期 1 — 旧底框残留 = 输入框重影`)
})

test('history 导航含中文标点（——…）: wide padding 不残留旧输入框（用户场景 2）', () => {
  const cols = 40
  const innerWidth = cols - 6
  const term = new ScreenTerminal(cols, 30, { ambiguousWide: true })
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })
  const leftBar = '│ '
  const rightBar = ' │'
  const top = '╭' + '─'.repeat(cols - 2) + '╮'
  const bot = '╰' + '─'.repeat(cols - 2) + '╯'

  // Frame 1: placeholder
  engine.render(lines(top, inputRowWide('❯ █history placeholder', innerWidth, leftBar, rightBar), bot))
  term.flush()

  // Frame 2: 按上键取回的历史消息——含中文破折号「——」和省略号「…」（ambiguous）
  const msg = '帮我重构这个模块——注意边界情况…以及并发'
  engine.render(lines(top, inputRowWide(`❯ ${msg}█`, innerWidth, leftBar, rightBar), bot))

  const screen = term.getRowsFrom(0).join('\n')
  const tulCount = screen.split('╭').length - 1
  assert.equal(tulCount, 1, `history 后 ╭ 出现 ${tulCount} 次，预期 1 — 输入框重影`)
  assert.ok(screen.includes('重构'), '历史消息内容应在屏上')
})

test('spinner 行含 …· 经 clampLine 不折行（rowsForLine 一致）', () => {
  const cols = 30 // 窄列强制接近列宽
  const term = new ScreenTerminal(cols, 20, { ambiguousWide: true })
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })
  // spinner 行形态：⠋ Thinking… (12s · esc to interrupt)，含 … 和 · 两个 ambiguous
  const spinner = '⠋ Thinking… (12s · esc to interrupt)'
  // clampLine 等价：wide 上界截断到 cols-1
  const clamped = truncateToDisplayWidth(spinner, cols - 1, { ambiguousAsWide: true })
  engine.render(lines(clamped))
  term.flush()

  // 不论 narrow/wide 口径，clampLine 已保证行宽 ≤ cols-1 → 不折行 → rowsForLine=1
  assert.equal(displayWidth(clamped, { ambiguousAsWide: true }) <= cols, true, 'clampLine 后 wide 宽度 ≤ cols')
  assert.equal(Math.ceil(displayWidth(clamped, { ambiguousAsWide: true }) / cols), 1, 'wide 口径占 1 行')
  assert.equal(Math.ceil(displayWidth(clamped) / cols), 1, 'narrow 口径占 1 行（rowsForLine 不论口径都对）')
})

// ── 场景：thinking 长考流 — 推理正文在 wide 终端折行 → spinner 残影 ──────
// 用户报告（macOS CJK 终端，未设 RIVET_AMBIGUOUS_WIDTH）：长考期间 spinner 状态行
// 逐帧泄漏进 scrollback（`| thinking… 7s` `- 思索中… 9s` 连续残影，随后才是
// 「… 上方省略 142 行」的推理区）。根因：formatThinking 的推理正文行含 ——……
// 等 ambiguous 符号，CJK 终端按 2 列渲染 → 实际折成 2 显示行，而引擎窄计 1 行
// → cursorUp 回顶欠 1 行 → 旧帧顶行（spinner）残留。spinner/chrome 早已
// clampLine 钳宽（见上一条用例），thinking/流式 tail 这类多行模型文本是残留
// 暴露面。修复：formatThinking 按 wide 上界把正文硬折成段（每段恒 ≤ cols-1 宽
// → 任何终端恰占 1 显示行），rowsForLine 恒精确，回顶永不欠行。

test('thinking 长考流：ambiguous 推理行在 wide 终端折行不留 spinner 残影', () => {
  const prev = process.env.RIVET_AMBIGUOUS_WIDTH
  // 钉死引擎窄计（macOS/xterm 默认），终端按 wide 渲染 —— 用户现场。
  process.env.RIVET_AMBIGUOUS_WIDTH = 'narrow'
  try {
    const cols = 40
    const term = new ScreenTerminal(cols, 30, { ambiguousWide: true })
    const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })
    const theme = getTheme()
    // clampLine 等价（与 app.ts 6505 同口径）：spinner 行自身永不折行。
    const spinner = (glyph: string, label: string) =>
      truncateToDisplayWidth(`${glyph} ${label}`, cols - 1, { ambiguousAsWide: true })

    // 推理正文构造：12 CJK + 8 ASCII + ——……
    //   窄计 = 24+8+2+2 = 36（含前缀 38 ≤ cols → 引擎 1 行）
    //   宽计 = 24+8+4+4 = 40（含前缀 42 > cols → CJK 终端折 2 行）
    const reasoning = '定位到冲突两侧各改同一行abcdefgh——……'
    assert.ok(displayWidth(`│ ${reasoning}`) <= cols, '锚定：窄计一行')
    assert.ok(displayWidth(`│ ${reasoning}`, { ambiguousAsWide: true }) > cols, '锚定：宽计折行')

    const frame = (spin: string, text: string): LiveRegionLine[] => [
      { text: spin },
      ...formatThinking({ text, elapsedMs: 7000, header: false, expanded: true, maxRows: 4, columns: cols }, theme)
        .map(text => ({ text })),
    ]

    // Frame A → Frame B：spinner tick 前进、思考文本未变（行级 diff 路径）。
    engine.render(frame(spinner('|', 'thinking… 7s'), reasoning))
    term.flush()
    engine.render(frame(spinner('-', 'thinking… 7s'), reasoning))

    let screen = term.getRowsFrom(0).join('\n')
    assert.equal(screen.split('thinking… 7s').length - 1, 1, `spinner 残影：旧帧顶行未擦除\n${screen}`)
    assert.ok(!screen.includes('| thinking… 7s'), '旧 spinner 帧不应残留')

    // Frame C：思考文本继续增长（同一逻辑行变长 → 全量重写路径）。
    engine.render(frame(spinner('/', '思索中… 8s'), `${reasoning}，再核对行号`))
    screen = term.getRowsFrom(0).join('\n')
    assert.equal(
      screen.split(/thinking… 7s|思索中… 8s/).length - 1, 1,
      `增长帧后 spinner 残影\n${screen}`,
    )
    assert.ok(screen.includes('思索中… 8s'), '当前 spinner 应在屏上')
  } finally {
    if (prev === undefined) delete process.env.RIVET_AMBIGUOUS_WIDTH
    else process.env.RIVET_AMBIGUOUS_WIDTH = prev
  }
})


// ── resize × CPR 污染恢复并发：变窄 reflow 撑高区域后爬升不足的叠屏回归 ─────
// 用户报告：缩放终端时输入框叠成多份（旧帧顶部 — 顶框+输入行成对残留）。
// 根因：resize 变窄后旧帧被终端 reflow 撑高（4 行 → 10+ 行），reflow 移动光标
// 又触发 CPR 污染判定；polluted 恢复路径的 climb = min(lastDisplayRows-1,
// cprReportRow-1) 直接沿用**旧宽度**的行数计数（4），爬升 3 只擦到底部几行，
// 旧帧顶部残留进 scrollback = 叠屏。修复：polluted 路径先 reconcileWidth()
// （按新宽从 lineCache 重算屏上行数），爬升量与 reflow 后屏上实际一致。

test('resize 变窄 × CPR 污染并发：恢复重铺按新宽爬升，不残留旧帧顶部', () => {
  const color = (s: string, c: string): string => `\x1B[38;5;${c}m${s}\x1B[39m`

  // 1) 110 列下渲染 4 行帧（新输入框形态：顶框标签 + 输入行 + 底框 + 状态行）
  const term110 = new ScreenTerminal(110, 40)
  const engine = new LiveEngine({ stdout: asStdout(term110), reservedRows: 0, maxRows: 20 })
  const top = color(`╭─ 天枢 ${'─'.repeat(100)}╮`, '140')
  const input = color(`│ ❯ █询问任何事${' '.repeat(95)}│`, '140')
  const bot = color(`╰${'─'.repeat(106)}╯`, '140')
  const status = color('  longcat ⚡- 0s  ⏵ yolo (shift+tab)', '140')
  engine.render(lines(top, input, bot, status))
  // 建立 CPR 基线：光标在区域末行（4 行帧，1-based row 4）
  engine.noteCpr(4, 1)
  term110.flush()

  // 2) 模拟 resize 变窄 110→44：真实终端把旧帧 reflow 撑高。ScreenTerminal 不
  //    自动 reflow——新建 44 列终端重放旧帧模拟屏上状态（光标落在末行末尾，
  //    与真实 reflow 后的驻停一致），并把引擎的 stdout 切到 44 列终端。
  const term44 = new ScreenTerminal(44, 40)
  term44.write([top, input, bot, status].join('\n'))
  ;(engine as any).stdout = asStdout(term44)

  // 3) reflow 移动了光标 → 后续 CPR 响应行偏离基线 → 污染判定
  //    （44 列下旧帧折成 3+3+3+1=10 行，末行 1-based row 10）
  engine.noteCpr(10, 1)

  // 4) 污染恢复重铺：44 列新帧
  const top2 = color(`╭─ 天枢 ${'─'.repeat(34)}╮`, '140')
  const input2 = color(`│ ❯ █询问任何事${' '.repeat(26)}│`, '140')
  const bot2 = color(`╰${'─'.repeat(40)}╯`, '140')
  const status2 = color('  longcat ⚡- 0s', '140')
  engine.render(lines(top2, input2, bot2, status2))

  // 5) 屏上不应残留旧帧任何片段：每个框线元素只剩 1 份
  const screen = term44.getRowsFrom(0).join('\n')
  const tulCount = screen.split('╭').length - 1
  const botCount = screen.split('╰').length - 1
  const statusCount = (screen.match(/longcat/g) ?? []).length
  assert.equal(tulCount, 1, `╭ 出现 ${tulCount} 次，预期 1 — 旧帧顶部残留 = resize 叠屏`)
  assert.equal(botCount, 1, `╰ 出现 ${botCount} 次，预期 1 — 旧底框残留`)
  assert.equal(statusCount, 1, `状态行出现 ${statusCount} 次，预期 1 — 旧状态行残留`)
})

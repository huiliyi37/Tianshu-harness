/**
 * T9 LiveEngine 重绘协议测试。
 *
 * 阶段 0（复现 RED）+ 阶段 4（协议断言）合一：
 * - 用最小终端模拟器（MockTerminal）忠实重现"live 区贴底时每帧滚动"的卡顿特征。
 * - 断言修复后的协议：不用 SAVE/RESTORE、尾行不带 \n、行级 diff 跳过未变行、CSI 2026 同步输出包裹。
 *
 * 滚屏类 bug 单测难直接覆盖，这里用确定性的终端模拟器把"滚动次数"变成可断言信号。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { WriteStream } from 'node:tty'
import { LiveEngine, type LiveRegionLine } from '../live-engine.js'

/**
 * 最小终端模拟器：追踪光标行 / 滚动次数 / 全部写入字节。
 * 只建模垂直移动与滚动（R1 关注点），擦除/SGR 对滚动无影响，按需忽略。
 */
class MockTerminal {
  columns: number
  rows: number
  cursorRow = 0
  cursorCol = 0
  scrollCount = 0
  private savedRow = 0
  private savedCol = 0
  writes: string[] = []

  constructor(columns: number, rows: number) {
    this.columns = columns
    this.rows = rows
  }

  /** 取出自上次 flush 以来的全部写入字节并清空缓冲。 */
  flush(): string {
    const s = this.writes.join('')
    this.writes = []
    return s
  }

  private lineFeed(): void {
    if (this.cursorRow >= this.rows - 1) {
      this.scrollCount++ // 在底行换行 → 滚屏，光标留在底行
    } else {
      this.cursorRow++
    }
  }

  write = (chunk: string): boolean => {
    this.writes.push(chunk)
    let i = 0
    while (i < chunk.length) {
      const ch = chunk[i]!
      if (ch === '\x1b' && chunk[i + 1] === '[') {
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
            case 's': this.savedRow = this.cursorRow; this.savedCol = this.cursorCol; break
            case 'u': this.cursorRow = this.savedRow; this.cursorCol = this.savedCol; break
            case 'H': {
              const parts = params.split(';')
              this.cursorRow = Math.min(this.rows - 1, Math.max(0, (parseInt(parts[0] || '1', 10)) - 1))
              this.cursorCol = Math.max(0, (parseInt(parts[1] || '1', 10)) - 1)
              break
            }
            case 'G': this.cursorCol = Math.max(0, n - 1); break
            default: break // J / K (erase) 不影响滚动
          }
        }
        // 私有模式 h/l（CSI ?2026h/l 同步输出）忽略
        i = j + 1
        continue
      }
      if (ch === '\n') { this.lineFeed(); i++; continue }
      if (ch === '\r') { this.cursorCol = 0; i++; continue }
      // 可打印字符
      this.cursorCol++
      if (this.cursorCol >= this.columns) {
        this.cursorCol = 0
        this.lineFeed()
      }
      i++
    }
    return true
  }
}

function asStdout(term: MockTerminal): WriteStream {
  return term as unknown as WriteStream
}

function lines(...texts: string[]): LiveRegionLine[] {
  return texts.map(text => ({ text }))
}

// ── R1：贴底重渲不得持续滚屏 ───────────────────────────────────

test('R1: 相同内容重渲多帧，不产生额外滚屏（贴底卡顿复现/修复）', () => {
  // rows=3，live 区 3 行恰好贴底——原协议尾行 \n 会每帧滚屏一次
  const term = new MockTerminal(80, 3)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  engine.render(lines('L0', 'L1', 'L2'))
  const scrollAfterFirst = term.scrollCount

  // 模拟 ticker：相同内容重渲 10 帧
  for (let i = 0; i < 10; i++) engine.render(lines('L0', 'L1', 'L2'))

  assert.equal(
    term.scrollCount,
    scrollAfterFirst,
    `相同内容重渲不应继续滚屏（first=${scrollAfterFirst} after10=${term.scrollCount}）`,
  )
})

// ── R1：不使用 SAVE/RESTORE 绝对光标 ───────────────────────────

test('R1: 增量重渲不得使用 SAVE_CURSOR/RESTORE_CURSOR（贴底会错位）', () => {
  const term = new MockTerminal(80, 24)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  engine.render(lines('A', 'B', 'C'))
  term.flush()
  engine.render(lines('A', 'B', 'C2'))
  const frame = term.flush()

  assert.ok(!frame.includes('\x1B[s'), '增量帧不应包含 SAVE_CURSOR (\\x1B[s)')
  assert.ok(!frame.includes('\x1B[u'), '增量帧不应包含 RESTORE_CURSOR (\\x1B[u)')
})

// ── R2：行级 diff，未变行不重写 ────────────────────────────────

test('R2: 仅一行变化时，未变行不被重写', () => {
  const term = new MockTerminal(80, 24)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  engine.render(lines('STATUS-0', 'GLANCE', 'INPUT'))
  term.flush()
  // 仅状态行变化（模拟 spinner 帧）
  engine.render(lines('STATUS-1', 'GLANCE', 'INPUT'))
  const frame = term.flush()

  assert.ok(frame.includes('STATUS-1'), '变化行应被重写')
  assert.ok(!frame.includes('GLANCE'), '未变行 GLANCE 不应被重写')
  assert.ok(!frame.includes('INPUT'), '未变行 INPUT 不应被重写')
})

// ── H2：无变化短路（内容相同不产生任何写入） ──────────────────

test('H2: 内容与上帧逐行相同时短路，不产生任何 stdout 写入', () => {
  const term = new MockTerminal(80, 24)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  engine.render(lines('A', 'B', 'C'))
  term.flush()
  // 完全相同内容重渲
  engine.render(lines('A', 'B', 'C'))
  const frame = term.flush()

  assert.equal(frame, '', '内容未变应短路，零写入')
})

test('H2: 内容变化后正常渲染（短路不影响真实更新）', () => {
  const term = new MockTerminal(80, 24)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  engine.render(lines('A', 'B', 'C'))
  term.flush()
  engine.render(lines('A', 'B', 'C')) // 短路
  assert.equal(term.flush(), '')
  engine.render(lines('A', 'B', 'C2')) // 真实变化
  const frame = term.flush()
  assert.ok(frame.includes('C2'), '变化帧应正常渲染')
})

test('H2: clear 后即使内容相同也重新 append（forceRedraw 不被误短路）', () => {
  const term = new MockTerminal(80, 24)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  engine.render(lines('A', 'B', 'C'))
  term.flush()
  engine.clear() // 模拟 forceRedraw 的 live.clear()
  term.flush()
  engine.render(lines('A', 'B', 'C')) // 相同内容，但 clear 后必须重画
  const frame = term.flush()
  assert.ok(frame.includes('A') && frame.includes('C'), 'clear 后相同内容必须重新 append，不可短路')
})

// ── H1：wrap 行参与增量 diff（高度不变时不全量重写） ──────────

test('H1: 多行 wrap 行高度不变时走增量 diff（未变 wrap 行不重写）', () => {
  const term = new MockTerminal(40, 24)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 30 })

  // 第一行 90 字符 → 宽 40 时 ceil(90/40)=3 显示行。STATUS 短行 1 显示行。
  const wide = 'W'.repeat(90)
  engine.render(lines('STATUS-0', wide, 'INPUT'))
  term.flush()
  // 仅 STATUS 变化；wide(3行) 与 INPUT 不变，wrap 高度全部不变 → 应走增量。
  engine.render(lines('STATUS-1', wide, 'INPUT'))
  const frame = term.flush()

  assert.ok(frame.includes('STATUS-1'), '变化行应被重写')
  assert.ok(!frame.includes('W'.repeat(90)), '未变的 wrap 行不应被重写')
  assert.ok(!frame.includes('INPUT'), '未变的 INPUT 不应被重写')
  // 增量路径标志：含 cursorUp 回顶，不含全量 ERASE_SCREEN_END 之外仍是增量
  assert.ok(/\x1B\[\d+A/.test(frame) || frame.includes('\x1B[1A') || frame.startsWith('\x1B[?2026h'),
    '应为增量帧（CSI 2026 包裹）')
})

test('H1: 变化的多行 wrap 行被完整擦除续行后重写（不留 ghost）', () => {
  const term = new MockTerminal(40, 24)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 30 })

  const wideA = 'A'.repeat(90) // 3 显示行
  const wideB = 'B'.repeat(90) // 3 显示行（高度相同 → 仍可增量）
  engine.render(lines('TOP', wideA, 'INPUT'))
  term.flush()
  engine.render(lines('TOP', wideB, 'INPUT'))
  const frame = term.flush()

  // 变化的 wrap 行：应对其 3 个显示行各发一次 ERASE_LINE（首行 + 2 续行）
  const eraseCount = (frame.match(/\x1B\[2K/g) || []).length
  assert.ok(eraseCount >= 3, `变化的 3 显示行 wrap 行应擦除全部续行（≥3 次 ERASE_LINE），实际 ${eraseCount}`)
  assert.ok(frame.includes('B'.repeat(90)), '新内容应被写入')
  assert.ok(!frame.includes('TOP'), '未变的 TOP 不应被重写')
})

test('H1: wrap 高度变化时回退全量重写（不走增量）', () => {
  const term = new MockTerminal(40, 24)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 30 })

  const short = 'S'.repeat(30) // 1 显示行
  const grown = 'S'.repeat(90) // 3 显示行（高度变化 → 级联，回退全量）
  engine.render(lines('TOP', short, 'INPUT'))
  term.flush()
  engine.render(lines('TOP', grown, 'INPUT'))
  const frame = term.flush()

  // 全量重写会用 ERASE_SCREEN_END（\x1B[0J）一次性擦到屏末并重写全部行
  assert.ok(frame.includes('\x1B[0J'), 'wrap 高度变化应回退全量重写（含 ERASE_SCREEN_END）')
  assert.ok(frame.includes('TOP'), '全量重写会重写所有行（含 TOP）')
})

// ── R3 / 阶段3：CSI 2026 同步输出包裹增量帧 ─────────────────────

test('阶段3: 增量帧用 CSI 2026 同步输出包裹（防撕裂）', () => {
  const term = new MockTerminal(80, 24)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  engine.render(lines('A', 'B', 'C'))
  term.flush()
  engine.render(lines('A2', 'B', 'C'))
  const frame = term.flush()

  assert.ok(frame.startsWith('\x1B[?2026h'), '增量帧应以 BEGIN_SYNC (\\x1B[?2026h) 开头')
  assert.ok(frame.endsWith('\x1B[?2026l'), '增量帧应以 END_SYNC (\\x1B[?2026l) 结尾')
})

test('阶段3: 首帧/退出重绘的 append 帧同样用 CSI 2026 包裹', () => {
  const term = new MockTerminal(80, 24)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  // 首次渲染走 append 分支（!hasRendered）
  engine.render(lines('A', 'B', 'C'))
  const frame = term.flush()

  assert.ok(frame.startsWith('\x1B[?2026h'), '首帧应以 BEGIN_SYNC 开头')
  assert.ok(frame.endsWith('\x1B[?2026l'), '首帧应以 END_SYNC 结尾')
  assert.ok(frame.includes('A') && frame.includes('C'), '首帧包含内容')
})

// ── 光标管理：主 TUI 使用软件光标 `█`，每帧隐藏硬件光标，防止其停留在权限模式行等 chrome 尾部闪烁 ──

test('每帧 render 同步隐藏硬件光标（覆盖 overlay 退出后的 SHOW_CURSOR）', () => {
  const term = new MockTerminal(80, 24)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  engine.render(lines('A', 'B', 'C'))
  const first = term.flush()
  assert.ok(first.includes('\x1B[?25l'), '首帧应隐藏硬件光标')

  engine.render(lines('A2', 'B', 'C'))
  const delta = term.flush()
  assert.ok(delta.includes('\x1B[?25l'), '增量帧应隐藏硬件光标')
})

test('clear 后重绘仍隐藏硬件光标', () => {
  const term = new MockTerminal(80, 24)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  engine.render(lines('A', 'B', 'C'))
  term.flush()

  engine.clear()
  const cleared = term.flush()
  assert.ok(cleared.includes('\x1B[?25l'), 'clear 应隐藏硬件光标')

  engine.render(lines('A', 'B', 'C'))
  const afterClear = term.flush()
  assert.ok(afterClear.includes('\x1B[?25l'), 'clear 后重新 append 仍应隐藏硬件光标')
})

// ── 结构变化（行数变化）走全量重写，仍不滚屏/不用 SAVE/RESTORE ──

test('结构变化（行数增减）安全重绘，不滚屏不用 SAVE/RESTORE', () => {
  const term = new MockTerminal(80, 3)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  engine.render(lines('L0', 'L1', 'L2'))
  const baseScroll = term.scrollCount
  term.flush()

  // 行数减少
  engine.render(lines('L0', 'L1'))
  let frame = term.flush()
  assert.ok(!frame.includes('\x1B[s') && !frame.includes('\x1B[u'), '不应使用 SAVE/RESTORE')

  // 行数增加
  engine.render(lines('L0', 'L1', 'L2', 'L3'))
  frame = term.flush()
  assert.ok(!frame.includes('\x1B[s') && !frame.includes('\x1B[u'), '不应使用 SAVE/RESTORE')

  // 多帧稳定后不应无限滚屏
  for (let i = 0; i < 5; i++) engine.render(lines('L0', 'L1', 'L2', 'L3'))
  // rows=3 而内容 4 行 > 视口，首帧会滚一次进入稳态；之后相同内容不应继续滚
  const stableScroll = term.scrollCount
  for (let i = 0; i < 5; i++) engine.render(lines('L0', 'L1', 'L2', 'L3'))
  assert.equal(term.scrollCount, stableScroll, '稳态相同内容不应继续滚屏')

  assert.ok(term.scrollCount >= baseScroll)
})

// ── reservedTail：行数超 maxRows 时尾部 chrome（输入框）必须保留 ──

test('reservedTail: 内容超 maxRows 时尾部 chrome 行始终保留（输入框不被截断）', () => {
  const term = new MockTerminal(80, 50)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 5 })

  // 10 行 dynamic（streaming/tools）+ 3 行尾部 chrome（分隔/glance/输入框）
  const all = lines(
    'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9',
    'GLANCE-SEP', 'GLANCE', '▸ INPUT',
  )
  engine.render(all, { reservedTail: 3 })
  const frame = term.flush()

  assert.ok(frame.includes('▸ INPUT'), '输入框必须出现在首帧')
  assert.ok(frame.includes('GLANCE'), 'glance 必须保留')
  assert.ok(frame.includes('D9'), '最近的 dynamic 行应保留')
  assert.ok(!frame.includes('D0'), '最早的 dynamic 行应被截断（让位给尾部 chrome）')
})

test('reservedTail: 尾部 chrome 超过 maxRows 时仍全部显示（宁可超行也要见输入框）', () => {
  const term = new MockTerminal(80, 50)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 2 })

  const all = lines('D0', 'D1', 'GLANCE-SEP', 'GLANCE', '▸ INPUT')
  engine.render(all, { reservedTail: 3 })
  const frame = term.flush()

  assert.ok(frame.includes('▸ INPUT'), '输入框必须出现')
  assert.ok(frame.includes('GLANCE'), 'glance 必须出现')
  assert.ok(frame.includes('GLANCE-SEP'), 'chrome 全部保留')
})

// ── clear / clearForCommit 后回到 append 路径不滚屏 ─────────────

test('clearForCommit 后再渲染走 append 路径，贴底不持续滚屏', () => {
  const term = new MockTerminal(80, 5)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  engine.render(lines('L0', 'L1', 'L2'))
  engine.clearForCommit()
  // 模拟 commit 写入 scrollback
  asStdout(term).write('committed line\n')
  engine.render(lines('L0', 'L1', 'L2'))
  const scrollBefore = term.scrollCount
  for (let i = 0; i < 10; i++) engine.render(lines('L0', 'L1', 'L2'))
  assert.equal(term.scrollCount, scrollBefore, 'commit 后稳态重渲不应继续滚屏')
})

// ── resize：宽度变化后增量帧的 cursorUp 必须按「新宽度下缓存内容的行数」回顶 ──
// 根因：render() 用当前 columns 算 rowsForLine，但 lastDisplayRows 是上一帧在
// 旧宽度下存的。终端 resize 会把已绘内容按新宽 reflow，行数变了；若 moveToTop
// 仍用旧 lastDisplayRows，cursorUp 量不足 → reflow 后的顶部行擦不掉 → 多份不同
// 宽度的 chrome/面板叠在 scrollback 里（截图实证：任务面板在三种宽度同屏）。
// 修复：render() 检测 columns 变化，按新宽度从 lineCache 重算 lastDisplayRows 再回顶。
test('resize: 宽度变窄后，增量帧按新宽度的 reflow 行数回顶（不残留旧帧）', () => {
  const term = new MockTerminal(100, 40)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 30 })

  // 一行 90 字符：宽 100 时占 1 显示行
  const wide = 'X'.repeat(90)
  engine.render(lines(wide, 'INPUT'))
  term.flush()

  // 终端变窄到 40：那 90 字符行 reflow 成 ceil(90/40)=3 显示行 → 旧帧实际占 3+1=4 行
  term.columns = 40
  engine.render(lines(wide, 'INPUT2'))
  const frame = term.flush()

  // moveToTop 必须按新宽度回顶（覆盖 reflow 后的 4 行），即 cursorUp(3)（4-1）。
  // 修复前用旧 lastDisplayRows=2 → cursorUp(1)，欠回 2 行 → 残留。
  const upMatch = frame.match(/\x1B\[(\d+)A/)
  assert.ok(upMatch, `增量帧应含 cursorUp：${JSON.stringify(frame)}`)
  const upCount = parseInt(upMatch![1]!, 10)
  assert.ok(
    upCount >= 3,
    `宽度变窄后 cursorUp 应 ≥3（新宽下缓存内容 reflow 行数-1），实际 ${upCount} —— 欠回会残留旧帧`,
  )
})

// 宽度刚变过的那一帧必须走全量重写（回顶 + ERASE_SCREEN_END + 重铺），不允许行级
// diff：即使每行 wrap 高度在新旧宽度下相同（短行），屏上旧帧经终端 reflow 后的实际
// 布局也可能与 lineCache 估算不一致（部分终端拉大不 reflow / ambiguous 宽度偏差），
// 相对步进的补丁会打在错位的行上 → 旧帧碎片叠屏（拉大窗口后界面堆叠错乱的实证）。
test('resize: 宽度变化后首帧强制全量重写（禁用行级 diff）', () => {
  const term = new MockTerminal(80, 40)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 30 })

  // 短行：80 列与 120 列下都只占 1 显示行 → 修复前 canDiff=true 走增量补丁
  engine.render(lines('L0', 'L1', 'INPUT'))
  term.flush()

  term.columns = 120
  engine.render(lines('L0', 'L1', 'INPUT2'))
  const frame = term.flush()

  assert.ok(
    frame.includes('\x1B[0J'),
    `宽度变化后的首帧应含 ERASE_SCREEN_END（全量重写）：${JSON.stringify(frame)}`,
  )
})

test('resize: 宽度变化后稳态重渲不持续滚屏且不残留', () => {
  const term = new MockTerminal(100, 10)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 30 })

  const wide = 'Y'.repeat(85)
  engine.render(lines(wide, 'SEP', 'INPUT'))
  term.flush()
  term.columns = 50
  engine.render(lines(wide, 'SEP', 'INPUT'))
  const scrollAfterResize = term.scrollCount
  for (let i = 0; i < 8; i++) engine.render(lines(wide, 'SEP', 'INPUT'))
  assert.equal(term.scrollCount, scrollAfterResize, 'resize 后稳态相同内容不应继续滚屏')
})

// ── 窄窗口折行帧:display-row 预算(小窗口打字正文泄露修复)─────────────

test('窄窗口折行帧不超过终端高度——正文不泄露到 chrome 之下', () => {
  // 20 列 × 12 行;长 CJK 正文行在 20 列下折 ≥3 display rows。maxRows=11(= rows-1)。
  // 行数预算(旧行为)会放过全部 9 行 → 21 display rows → 重写越底滚屏 →
  // 旧帧正文残留在 chrome 之下(小窗口打字泄露根因)。display-row 预算必须钳住。
  const term = new MockTerminal(20, 12)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 11 })

  const prose = '星域切换开阳功名只向马上取真是英雄一丈夫' // 20 CJK + 前缀 ≈ 45 列 → 3 rows @20列
  const dyn = Array.from({ length: 6 }, (_, i) => `正文${i}:${prose}`)
  const frame = [...dyn, '╭─ glance ─╮', '❯ █', '╰─ yolo ─╯']

  engine.render(frame.map(text => ({ text })), { reservedTail: 3 })
  const firstWrite = term.flush()
  const scrollAfterFirst = term.scrollCount

  // chrome 必须保留(尾部 3 行在帧内)
  assert.ok(firstWrite.includes('❯ █'), '输入框行必须保留')
  assert.ok(firstWrite.includes('╰─ yolo ─╯'), '尾部 chrome 必须保留')

  // 模拟打字:输入行内容变化,其余同构
  const frame2 = [...dyn, '╭─ glance ─╮', '❯ a█', '╰─ yolo ─╯']
  engine.render(frame2.map(text => ({ text })), { reservedTail: 3 })
  assert.equal(term.scrollCount, scrollAfterFirst, '重渲不得越底滚屏(display-row 预算)')

  // 再渲一帧:diff 路径也不得越底
  const frame3 = [...dyn, '╭─ glance ─╮', '❯ ab█', '╰─ yolo ─╯']
  engine.render(frame3.map(text => ({ text })), { reservedTail: 3 })
  assert.equal(term.scrollCount, scrollAfterFirst, 'diff 重绘同样不得越底滚屏')
})

test('chrome 本身超屏时仍全量保留输入框(设计的例外)', () => {
  const term = new MockTerminal(20, 6)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 5 })
  const chrome = Array.from({ length: 6 }, (_, i) => `chrome-${i}`)
  const frame = ['dyn-0', 'dyn-1', ...chrome]
  engine.render(frame.map(text => ({ text })), { reservedTail: 6 })
  const out = term.flush()
  for (const c of chrome) assert.ok(out.includes(c), `${c} 必须保留(输入框不消失)`)
  assert.ok(!out.includes('dyn-0'), 'chrome 超屏时 dynamic 全部让位')
})

// ── 嵌入换行归一化（2026-07-21 输入框重影修复）───────────────────
//
// 上游内容（worker 多行 summary → progressLine → 舰队面板活动行）偶发携带
// 嵌入 \n。带 \n 的行在屏上占 2+ 显示行，而 rowsForLine 基于 displayWidth
// （string-width 把 \n 计 0 宽）按 1 行计 → lastDisplayRows 低于屏上实际
// 行数 → 下一帧 cursorUp 回顶不足 → 旧帧顶部（输入框头行+边框）残留进
// scrollback（输入框重影叠屏）。引擎入口必须把 \n 展开为独立行。

test('嵌入 \\n 的行被展开为独立行——行数追踪与屏上一致（重影修复）', () => {
  const term = new MockTerminal(80, 24)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  // 舰队活动行携带嵌入换行（真实泄漏链：review 门 evidence 以 \n 拼接）
  engine.render(lines('HEAD', '⎿ 审查未决\ninfra failure', 'INPUT'))
  term.flush()
  // 屏上实际 4 行（HEAD / ⎿ 审查未决 / infra failure / INPUT），
  // 光标驻停末行 → cursorRow 应为 3（修复前引擎按 3 行计，行为不可断言，
  // 这里以 MockTerminal 光标行为为准）。
  assert.equal(term.cursorRow, 3, '4 个显示行的帧光标应停在第 4 行')

  // 下一帧结构变化 → 全量重写必须回顶 3 行（修复前只回 2 行 → HEAD 残留成重影）
  engine.render(lines('HEAD', 'X', 'Y', 'Z', 'INPUT'))
  const frame = term.flush()
  assert.ok(frame.includes('\x1B[3A'), `全量重写应 cursorUp(3) 回到帧顶，实际帧: ${JSON.stringify(frame)}`)
})

test('嵌入 \\n 展开后 H2 短路仍生效（同帧重渲零写入）', () => {
  const term = new MockTerminal(80, 24)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  const frame = lines('HEAD', 'A\nB', 'INPUT')
  engine.render(frame)
  term.flush()
  engine.render(lines('HEAD', 'A\nB', 'INPUT'))
  assert.equal(term.flush(), '', '归一化后相同内容应命中 H2 短路')
})

test('\\r 与 \\t 被替换为空格（不破坏光标列追踪）', () => {
  const term = new MockTerminal(80, 24)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  engine.render(lines('HEAD', 'col1\tcol2\rtail', 'INPUT'))
  const out = term.flush()
  assert.ok(!out.includes('\t'), '帧内不应残留 \\t')
  assert.ok(!/col2\r/.test(out), '内容中的 \\r 应被替换（行间协议性 \\r 不受影响）')
  assert.ok(out.includes('col1 col2 tail'), '控制字符应替换为空格保留可读内容')
})

test('嵌入 \\n 的行参与 reservedTail 预算时 chrome 仍完整保留', () => {
  const term = new MockTerminal(40, 12)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 6 })

  const dyn = ['d0', 'multi\nline\nactivity', 'd1', 'd2']
  const chrome = ['╭─ glance ─╮', '❯ █', '╰─ yolo ─╯']
  engine.render([...dyn, ...chrome].map(text => ({ text })), { reservedTail: 3 })
  const out = term.flush()
  for (const c of chrome) assert.ok(out.includes(c), `${c} 必须保留`)
  assert.equal(term.cursorRow, 5, '帧恒 ≤ maxRows=6 display rows（光标停在第 6 行内）')
})

// ── IME 硬件光标锚定（caretCol parking，2026-07-23；2026-07-24 默认重开）────
// 终端 IME 候选窗锚定【硬件光标】而非自绘 █：帧末把硬件光标搬到 caretCol
// 标记的坐标，组词串才会出现在输入框内。默认驻停但保持隐藏（单指针视觉）；
// RIVET_TUI_HARDWARE_CURSOR=1 仅控制可见性。
// 2026-07-24 重复行根修：CPR 响应在 rowsUp 漂移（slash 面板开合等合法几何
// 变化）时丢弃判定——dc572683 曾用 env 闸门整体关闭 parking 兜底，此为正修。

test('IME: caret 帧末硬件光标驻停到 caret 行/列（cursorUp + G 序列）', () => {
  const term = new MockTerminal(80, 24)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  engine.render([{ text: 'L0' }, { text: 'IN', caretCol: 5 }, { text: 'L2' }, { text: 'L3' }])
  const frame = term.flush()

  assert.ok(frame.includes('\x1B[2A'), '帧末应上移 2 行（caret 行之下 2 行）')
  assert.ok(frame.includes('\x1B[6G'), '帧末应定位第 6 列（caretCol 5 + 1）')
  assert.equal(term.cursorRow, 1, '光标驻停 caret 行（区域第 2 行）')
  assert.equal(term.cursorCol, 5, '光标驻停 caret 列')
  assert.ok(frame.includes('\x1B[?25l'), '默认保持隐藏（定位但不可见）')
  assert.ok(!frame.includes('\x1B[?25h'), '默认不显示硬件光标')
})

test('IME: caret 驻停后下一帧 diff 爬升扣 parkedRowsUp（回顶不错位、无滚屏）', () => {
  const term = new MockTerminal(80, 24)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  engine.render([{ text: 'L0' }, { text: 'IN', caretCol: 5 }, { text: 'L2' }, { text: 'L3' }])
  term.flush()
  engine.render([{ text: 'L0x' }, { text: 'IN', caretCol: 5 }, { text: 'L2' }, { text: 'L3' }])
  const frame = term.flush()

  assert.ok(frame.includes('\x1B[1A'), '从 caret 行（而非末行）爬升 1 行回区域顶')
  assert.ok(frame.includes('L0x'), '变化行被重写')
  assert.equal(term.cursorRow, 1, '帧末仍驻停 caret 行')
  assert.equal(term.cursorCol, 5)
  assert.equal(term.scrollCount, 0, '全程无滚屏')
})

test('IME: 行未变仅 caret 移动 → 只发重定位序列（零文字重绘）', () => {
  const term = new MockTerminal(80, 24)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  engine.render([{ text: 'L0' }, { text: 'IN', caretCol: 5 }, { text: 'L2' }, { text: 'L3' }])
  term.flush()
  engine.render([{ text: 'L0' }, { text: 'IN', caretCol: 9 }, { text: 'L2' }, { text: 'L3' }])
  const frame = term.flush()

  assert.ok(!frame.includes('L0') && !frame.includes('L2'), '不得重绘任何文字行')
  assert.ok(frame.includes('\x1B[10G'), '重定位到新列（9+1）')
  assert.equal(term.cursorRow, 1, 'caret 行不变（rowsUp 相同无垂直移动）')
  assert.equal(term.cursorCol, 9)
})

test('IME: 行与 caret 均未变 → H2 短路零写入', () => {
  const term = new MockTerminal(80, 24)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  const frame = [{ text: 'L0' }, { text: 'IN', caretCol: 5 }, { text: 'L2' }]
  engine.render(frame)
  term.flush()
  engine.render([{ text: 'L0' }, { text: 'IN', caretCol: 5 }, { text: 'L2' }])
  assert.equal(term.flush(), '', '完全无变化应零写入')
})

for (const hardwareCursorVisible of [true, false]) {
  test(`IME: unchanged text releases and restores the caret (visible=${hardwareCursorVisible})`, () => {
    const term = new MockTerminal(80, 3)
    const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 3, hardwareCursorVisible })
    const focused = [{ text: 'header' }, { text: 'input', caretCol: 3 }, { text: 'footer' }]
    const unfocused = lines('header', 'input', 'footer')
    engine.render(focused)
    term.flush()

    engine.render(unfocused)
    const released = term.flush()
    assert.ok(released.includes('\x1B[?25l'), 'removing the caret must hide the hardware cursor')
    assert.equal(term.cursorRow, 2, 'release must return to the final live row')
    assert.ok(!released.includes('input'), 'unchanged text must not be repainted')
    engine.render(unfocused)
    assert.equal(term.flush(), '', 'an unchanged frame without a caret remains a no-op')

    engine.render(focused)
    const restored = term.flush()
    assert.equal(term.cursorRow, 1, 'restored caret must use the released cursor position')
    assert.equal(term.cursorCol, 3)
    assert.equal(restored.includes('\x1B[?25h'), hardwareCursorVisible)
    assert.ok(!restored.includes('input'), 'restoring focus must not repaint the text')
    engine.clear()
    assert.equal(term.cursorRow, 0, 'clear must still return to the live region origin')
    assert.equal(term.scrollCount, 0, 'focus transitions must not scroll a full-height frame')
  })
}

test('IME: removing a caret on the final row also hides it and settles the frame', () => {
  const term = new MockTerminal(80, 3)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 3, hardwareCursorVisible: true })
  engine.render([{ text: 'header' }, { text: 'input', caretCol: 0 }])
  term.flush()
  const unfocused = lines('header', 'input')
  engine.render(unfocused)
  assert.ok(term.flush().includes('\x1B[?25l'), 'column zero is still an active caret to release')
  assert.equal(term.cursorRow, 1)
  engine.render(unfocused)
  assert.equal(term.flush(), '', 'the released caret must not cause repeated redraws')
})

test('IME: CPR 响应按驻停记账折算区域末行——caret 移动/列变化不误判污染', () => {
  let polluted = 0
  const term = new MockTerminal(80, 24)
  const engine = new LiveEngine({
    stdout: asStdout(term), reservedRows: 0, maxRows: 20,
    onProbeRequest: () => {}, onPolluted: () => { polluted++ },
  })

  engine.render([{ text: 'L0' }, { text: 'IN', caretCol: 5 }, { text: 'L2' }, { text: 'L3' }])
  engine.noteCpr(10, 6) // 首响应建基线：regionEndRow = 10 + rowsUp(2) = 12
  assert.equal(polluted, 0)

  // 打字移动 caret（行内容相同走 H2 重定位），随后响应：行=10（caret 行）、列=10
  engine.render([{ text: 'L0' }, { text: 'IN', caretCol: 9 }, { text: 'L2' }, { text: 'L3' }])
  engine.noteCpr(10, 10)
  assert.equal(polluted, 0, 'caret 驻停期间列随打字合法变化，不得误判污染')

  // 外来写入把光标推到别的行：折算后 regionEndRow 偏离基线 → 应判污染
  engine.noteCpr(14, 1)
  assert.equal(polluted, 1, '区域末行被外来写入移动仍应判污染')
})

test('IME: 无 caret 驻停时 CPR 行列比对维持原语义（列变判污染）', () => {
  let polluted = 0
  const term = new MockTerminal(80, 24)
  const engine = new LiveEngine({
    stdout: asStdout(term), reservedRows: 0, maxRows: 20,
    onProbeRequest: () => {}, onPolluted: () => { polluted++ },
  })

  engine.render(lines('L0', 'L1'))
  engine.noteCpr(10, 3) // 建基线
  engine.noteCpr(10, 8) // 列变化（无 caret → 保持旧语义判污染）
  assert.equal(polluted, 1)
})

test('IME: RIVET_TUI_HARDWARE_CURSOR=1 时帧末 SHOW_CURSOR（可见性后门）', () => {
  process.env.RIVET_TUI_HARDWARE_CURSOR = '1'
  try {
    const term = new MockTerminal(80, 24)
    const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })
    engine.render([{ text: 'IN', caretCol: 2 }])
    const frame = term.flush()
    assert.ok(frame.includes('\x1B[?25h'), '应显示硬件光标')
    assert.ok(frame.indexOf('\x1B[?25h') > frame.indexOf('IN'), 'SHOW_CURSOR 在帧末（内容之后）')
  } finally {
    delete process.env.RIVET_TUI_HARDWARE_CURSOR
  }
})

test('IME: clear() 从 caret 驻停点爬升（不错位）并复位驻停记账', () => {
  const term = new MockTerminal(80, 24)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  engine.render([{ text: 'L0' }, { text: 'IN', caretCol: 5 }, { text: 'L2' }, { text: 'L3' }])
  term.flush()
  engine.clear()
  // 从 caret 行（row 1）爬升 1 行回区域起始（row 0），而非从末行尾爬 3 行
  assert.equal(term.cursorRow, 0, 'clear 后光标应在区域起始行')

  // 驻停复位后首帧 append 不再携带爬升偏差
  engine.render(lines('X'))
  assert.equal(term.scrollCount, 0, 'clear/render 全程无滚屏')
})

test('IME: rowsUp 漂移的 CPR 响应丢弃判定（slash 面板开合不误判污染 = 重复行根修）', () => {
  let polluted = 0
  const term = new MockTerminal(80, 24)
  const engine = new LiveEngine({
    stdout: asStdout(term), reservedRows: 0, maxRows: 20,
    onProbeRequest: () => {}, onPolluted: () => { polluted++ },
  })

  // 帧1：caret 之下 2 行（rowsUp=2）；帧末探针记账 probeParked(rowsUp=2)
  engine.render([{ text: 'L0' }, { text: 'IN', caretCol: 5 }, { text: 'L2' }, { text: 'L3' }])
  engine.noteCpr(10, 6) // rowsUp 稳定：建基线 regionEndRow = 10+2 = 12
  assert.equal(polluted, 0)

  // slash 面板打开：caret 之下多出 3 行（rowsUp 2→5）；探针节流未重发，
  // probeParked 仍是旧值 2 → 与当前 5 漂移
  engine.render([
    { text: 'L0' }, { text: 'IN', caretCol: 5 }, { text: 'L2' },
    { text: '/help — hint' }, { text: '/compact — hint' }, { text: 'footer' }, { text: 'L3' },
  ])
  // 响应 row=7 在新几何下其实一致（7+5=12=基线），但按旧记账会算成 7+2=9 ≠ 12
  // → 无漂移丢弃时将误判污染并触发恢复重铺（输入框重复行的成因）
  engine.noteCpr(7, 6)
  assert.equal(polluted, 0, 'rowsUp 漂移期响应必须丢弃（不误判污染 → 不触发恢复重铺 = 无重复行）')

  // 面板关闭（rowsUp 回到 2）：几何与发针时一致，映射恢复有效——
  // 一致响应（10+2=12=基线）照常判定不报污染
  engine.render([{ text: 'L0' }, { text: 'IN', caretCol: 5 }, { text: 'L2' }, { text: 'L3' }])
  engine.noteCpr(10, 6)
  assert.equal(polluted, 0, '几何回到发针时状态后判定恢复有效')
})

test('IME: rowsUp 稳定时外来写入仍判污染（漂移丢弃不削弱检测）', () => {
  let polluted = 0
  const term = new MockTerminal(80, 24)
  const engine = new LiveEngine({
    stdout: asStdout(term), reservedRows: 0, maxRows: 20,
    onProbeRequest: () => {}, onPolluted: () => { polluted++ },
  })

  engine.render([{ text: 'L0' }, { text: 'IN', caretCol: 5 }, { text: 'L2' }, { text: 'L3' }])
  engine.noteCpr(10, 6) // 建基线 12
  // rowsUp 无漂移（不再渲染），外来写入把 caret 行推低 3 行：9+2=11 ≠ 12
  engine.noteCpr(9, 6)
  assert.equal(polluted, 1, '几何未漂移时外来写入仍应判污染')
})

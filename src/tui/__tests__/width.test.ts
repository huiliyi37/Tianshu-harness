import { test } from 'node:test'
import assert from 'node:assert/strict'
import stringWidth from 'string-width'
import { displayWidth, truncateToDisplayWidth, ambiguousWideEnabled, ambiguousWidthMode, resetWidthModeCache } from '../width.js'

test('narrow 模式与 string-width 完全一致（零回归）', () => {
  const samples = ['hello', '天枢 main', '— … ↑↓ · ◧', '╭──┬──╮', '⚡ 99%', '混合 mixed テスト']
  for (const s of samples) {
    assert.equal(displayWidth(s), stringWidth(s), `narrow(${s}) 应等于 string-width`)
  }
})

test('wide 模式仅对非 box/block 的 ambiguous 符号 +1', () => {
  // — U+2014, … U+2026, · U+00B7 均为 ambiguous → wide 各 +1
  assert.equal(displayWidth('—'), 1)
  assert.equal(displayWidth('—', { ambiguousAsWide: true }), 2)
  assert.equal(displayWidth('…', { ambiguousAsWide: true }), 2)
  assert.equal(displayWidth('·', { ambiguousAsWide: true }), 2)
  // ↑↓ U+2191/2193 ambiguous
  assert.equal(displayWidth('↑↓', { ambiguousAsWide: true }), 4)
})

test('box-drawing / block elements 在 wide 模式下仍按 1 列（关键护栏）', () => {
  const prev = process.env.RIVET_AMBIGUOUS_WIDTH
  try {
    process.env.RIVET_AMBIGUOUS_WIDTH = 'wide'
    resetWidthModeCache()
    // ─ │ ╭ ╰ █ ▓ ░ 都在 U+2500–259F，终端按 1 列渲染，绝不能被算成双宽
    for (const ch of ['─', '│', '╭', '╰', '╯', '╮', '┬', '█', '▓', '░']) {
      assert.equal(displayWidth(ch, { ambiguousAsWide: true }), 1, `${ch} 在 wide 模式应为 1 列`)
    }
  } finally {
    if (prev === undefined) delete process.env.RIVET_AMBIGUOUS_WIDTH
    else process.env.RIVET_AMBIGUOUS_WIDTH = prev
    resetWidthModeCache()
  }
})

test('CJK 与 emoji 在两种模式下都按既有宽度（不受 ambiguous 开关影响）', () => {
  assert.equal(displayWidth('天'), 2)
  assert.equal(displayWidth('天', { ambiguousAsWide: true }), 2)
})

test('displayWidth 忽略 ANSI 转义序列', () => {
  const colored = '\x1B[38;5;140m天枢\x1B[39m'
  assert.equal(displayWidth(colored), 4)
  assert.equal(displayWidth(colored, { ambiguousAsWide: true }), 4)
})

test('truncateToDisplayWidth：在预算内原样返回', () => {
  assert.equal(truncateToDisplayWidth('hello', 10), 'hello')
})

test('truncateToDisplayWidth：按 wide 度量截断含 ambiguous 的行', () => {
  // 5 个 — ：narrow=5，wide=10。预算 6（wide）→ 只能放 3 个
  const line = '—————'
  const out = truncateToDisplayWidth(line, 6, { ambiguousAsWide: true })
  assert.equal(displayWidth(out, { ambiguousAsWide: true }) <= 6, true)
  assert.equal(out, '———')
})

test('truncateToDisplayWidth：保留 ANSI 序列且截断时补 RESET 防颜色泄漏', () => {
  const colored = '\x1B[38;5;140mabcdefghij\x1B[39m'
  const out = truncateToDisplayWidth(colored, 4)
  assert.ok(out.startsWith('\x1B[38;5;140m'), '应保留起始颜色码')
  assert.ok(out.endsWith('\x1B[0m'), '截断后应补 RESET')
  assert.equal(displayWidth(out), 4)
})

test('truncateToDisplayWidth：max<=0 返回空', () => {
  assert.equal(truncateToDisplayWidth('abc', 0), '')
})

test('ambiguousWideEnabled 读取 RIVET_AMBIGUOUS_WIDTH（默认 narrow / legacy CJK conhost 默认 full）', () => {
  const prev = process.env.RIVET_AMBIGUOUS_WIDTH
  try {
    delete process.env.RIVET_AMBIGUOUS_WIDTH
    resetWidthModeCache()
    const expectedDefault = ambiguousWidthMode() !== 'narrow'
    assert.equal(ambiguousWideEnabled(), expectedDefault)
    process.env.RIVET_AMBIGUOUS_WIDTH = 'wide'
    assert.equal(ambiguousWideEnabled(), true)
    process.env.RIVET_AMBIGUOUS_WIDTH = 'WIDE'
    assert.equal(ambiguousWideEnabled(), true, '大小写不敏感')
    process.env.RIVET_AMBIGUOUS_WIDTH = 'narrow'
    assert.equal(ambiguousWideEnabled(), false)
  } finally {
    if (prev === undefined) delete process.env.RIVET_AMBIGUOUS_WIDTH
    else process.env.RIVET_AMBIGUOUS_WIDTH = prev
    resetWidthModeCache()
  }
})

test('full 档：框线/方块字符也 +1（legacy CJK conhost 口径）', () => {
  const prev = process.env.RIVET_AMBIGUOUS_WIDTH
  try {
    process.env.RIVET_AMBIGUOUS_WIDTH = 'full'
    assert.equal(ambiguousWidthMode(), 'full')
    assert.equal(ambiguousWideEnabled(), true, 'full 也视为启用加宽')
    // box-drawing：narrow/wide=1 → full=2
    for (const ch of ['─', '│', '╭', '█']) {
      assert.equal(displayWidth(ch, { ambiguousAsWide: true }), 2, `${ch} 在 full 档应为 2 列`)
    }
    // 非 box ambiguous 与 wide 档一致
    assert.equal(displayWidth('—', { ambiguousAsWide: true }), 2)
    // 截断口径同步：预算 4 只能放 2 个 ─
    assert.equal(truncateToDisplayWidth('────', 4, { ambiguousAsWide: true }), '──')

    // wide 档下 box 仍为 1 列（护栏不被 full 档污染）
    process.env.RIVET_AMBIGUOUS_WIDTH = 'wide'
    assert.equal(ambiguousWidthMode(), 'wide')
    assert.equal(displayWidth('─', { ambiguousAsWide: true }), 1)
  } finally {
    if (prev === undefined) delete process.env.RIVET_AMBIGUOUS_WIDTH
    else process.env.RIVET_AMBIGUOUS_WIDTH = prev
  }
})

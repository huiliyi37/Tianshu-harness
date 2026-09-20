/**
 * issue #222 —— 终端转义注入：live 流式区未净化。
 *
 * scrollback 路径（commit-engine）用 enforceTextContract 剥 OSC / 非 SGR CSI，
 * 但 live 区此前只替换 `\r`/`\t`、按 `\n` 切行，ESC/OSC/CSI 一路裸写 stdout：
 * bash 输出、read_file 内容、web_fetch 正文在流式阶段都能注入——OSC 52 覆写系统
 * 剪贴板、OSC 8 伪造链接、非 SGR CSI 清屏 / 踢出 alt-screen。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { WriteStream } from 'node:tty'
import { LiveEngine } from '../live-engine.js'

/** 只记录写出的字节，供断言反查；LiveEngine 只用到 columns/rows/write。 */
function fakeStdout(columns = 80): WriteStream & { captured(): string } {
  const chunks: string[] = []
  const s = {
    columns,
    rows: 24,
    write(chunk: string): boolean { chunks.push(chunk); return true },
    captured: () => chunks.join(''),
    on() { return s },
    once() { return s },
    removeListener() { return s },
    emit() { return false },
  }
  return s as unknown as WriteStream & { captured(): string }
}

test('live 区剥除 OSC 52 剪贴板序列，保留正文（issue #222）', () => {
  const out = fakeStdout()
  const engine = new LiveEngine({ stdout: out, reservedRows: 0, maxRows: 20 })
  engine.render([{ text: 'before\x1B]52;c;aGFja2Vk\x07after' }])
  const written = out.captured()
  assert.ok(!written.includes('\x1B]52'), 'OSC 52 不得进入 live 输出')
  assert.ok(written.includes('before'), '正文前段必须保留')
  assert.ok(written.includes('after'), '正文后段必须保留')
})

test('live 区剥除非 SGR CSI（清屏），但保留 SGR 颜色（issue #222）', () => {
  const out = fakeStdout()
  const engine = new LiveEngine({ stdout: out, reservedRows: 0, maxRows: 20 })
  engine.render([{ text: '\x1B[2J\x1B[31mred\x1B[0m' }])
  const written = out.captured()
  assert.ok(!written.includes('\x1B[2J'), '清屏序列不得进入 live 输出')
  assert.ok(written.includes('\x1B[31m'), 'SGR 颜色必须保留（全剥会让 live 区褪色）')
})

test('干净的文本行原样通过（不引入额外改动）', () => {
  const out = fakeStdout()
  const engine = new LiveEngine({ stdout: out, reservedRows: 0, maxRows: 20 })
  engine.render([{ text: 'plain text' }])
  assert.ok(out.captured().includes('plain text'))
})

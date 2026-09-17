/**
 * entry.text 契约兜底回归（2026-09-17 审计 UI 族）：不可信文本里的 CSI/OSC
 * 序列必须在唯一汇聚点剥除——OSC 52 可覆写系统剪贴板，CSI 可清屏/踢出
 * alt-screen。自产序列走 entry.ansi，不经过兜底。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CommitEngine } from '../commit-engine.js'

function mockEngine() {
  const writes: string[] = []
  const stdout = { write: (chunk: string) => { writes.push(chunk); return true } } as unknown as import('node:tty').WriteStream
  const engine = new CommitEngine({ stdout })
  return { engine, writes }
}

describe('CommitEngine enforces the no-ANSI contract on entry.text', () => {
  it('strips OSC 52 clipboard overwrite, CSI and title sequences from text', () => {
    const { engine, writes } = mockEngine()
    engine.write({ text: 'a\x1B]52;c;cGduZWQ=\x07b\x1B[2J\x1B[H\x1B]0;evil\x07c' })
    const out = writes.join('')
    assert.ok(!out.includes('\x1B'), 'no ESC byte may reach stdout via entry.text')
    assert.ok(out.includes('abc'), 'plain text content must survive')
  })

  it('keeps newlines and surrounding text intact', () => {
    const { engine, writes } = mockEngine()
    engine.write({ text: 'line1\x1B[?1049l\nline2' })
    assert.ok(writes.join('').includes('line1\nline2'))
  })

  it('does not touch entry.ansi (engine-built sequences stay intact)', () => {
    const { engine, writes } = mockEngine()
    engine.write({ text: 'ignored', ansi: '\x1B[31mred\x1B[0m' })
    assert.ok(writes.join('').includes('\x1B[31m'))
  })
})

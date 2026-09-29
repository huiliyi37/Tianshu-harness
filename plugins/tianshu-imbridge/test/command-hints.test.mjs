/**
 * lib/command-hints.mjs —— 「首次使用某命令」的记忆。
 * 与 session-map 同款约定：惰性读盘、按路径缓存、损坏退回空表、纯内存降级。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeCommandHints } from '../lib/command-hints.mjs'

test('makeCommandHints: 纯内存版（file=null）', () => {
  const h = makeCommandHints(null)
  assert.equal(h.has('history'), false)
  h.mark('history')
  assert.equal(h.has('history'), true)
  assert.equal(h.has('sessions'), false)
  assert.equal(h.size(), 1)
  h.reset()
  assert.equal(h.has('history'), false)
  assert.equal(h.size(), 0)
})

test('makeCommandHints: 落盘内容可被读回（跨重启仍然记得）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hints-'))
  try {
    const file = join(dir, 'command-hints.json')
    const h1 = makeCommandHints(file)
    h1.mark('history')
    h1.mark('sessions')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    assert.ok(raw.history && raw.sessions, '两个命令都应落盘')

    const copy = join(dir, 'copy.json')
    writeFileSync(copy, JSON.stringify(raw))
    const h2 = makeCommandHints(copy)
    assert.equal(h2.has('history'), true)
    assert.equal(h2.has('sessions'), true)
    assert.equal(h2.has('help'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('makeCommandHints: 损坏或非对象内容 → 退回空表，仍然可写', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hints-'))
  try {
    for (const [i, bad] of ['{ 这不是 JSON', 'null', '[]', '123', '"x"'].entries()) {
      const file = join(dir, `bad-${i}.json`)
      writeFileSync(file, bad)
      const h = makeCommandHints(file)
      assert.equal(h.has('history'), false, `内容 ${bad} 应退回空表`)
      h.mark('history')
      assert.equal(h.has('history'), true)
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8'))), ['history'])
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

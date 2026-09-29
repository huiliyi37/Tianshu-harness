import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistoryStore, formatPrompt, pruneHistory } from '../lib/history.mjs'

test('pruneHistory: maxMessages 限制保留最近条目', () => {
  const entries = Array.from({ length: 12 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `m${i}`,
  }))
  const pruned = pruneHistory(entries, { maxMessages: 6, maxChars: 100000 })
  assert.equal(pruned.length, 6)
  assert.equal(pruned[0].content, 'm6')
  assert.equal(pruned.at(-1).content, 'm11')
})

test('pruneHistory: maxChars 字符预算从尾部回溯', () => {
  const entries = [
    { role: 'user', content: 'a'.repeat(100) },
    { role: 'assistant', content: 'b'.repeat(100) },
    { role: 'user', content: 'c'.repeat(100) },
  ]
  const pruned = pruneHistory(entries, { maxMessages: 100, maxChars: 250 })
  assert.deepEqual(pruned.map((e) => e.content[0]), ['b', 'c'])
})

test('formatPrompt: 无历史时原样返回', () => {
  assert.equal(formatPrompt('你好', []), '你好')
  assert.equal(formatPrompt('你好', null), '你好')
})

test('formatPrompt: 有历史时按「历史在前、新消息在后」组织', () => {
  const out = formatPrompt('第二条', [
    { role: 'user', content: '第一条' },
    { role: 'assistant', content: '回复一' },
  ])
  assert.ok(out.includes('第一条'))
  assert.ok(out.includes('回复一'))
  assert.ok(out.includes('第二条'))
  assert.ok(out.indexOf('第一条') < out.indexOf('第二条'))
  assert.ok(out.indexOf('回复一') < out.indexOf('新消息'))
})

test('HistoryStore: 追加与读取（内存模式）', () => {
  const store = new HistoryStore({ file: null })
  store.appendTurn('k1', '你好', '嗨')
  const entries = store.get('k1')
  assert.equal(entries.length, 2)
  assert.equal(entries[0].role, 'user')
  assert.equal(entries[0].content, '你好')
  assert.equal(entries[1].role, 'assistant')
  assert.equal(entries[1].content, '嗨')
  assert.deepEqual(store.get('k2'), [])
})

test('HistoryStore: 持久化往返', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hist-'))
  try {
    const file = join(dir, 'history.json')
    const a = new HistoryStore({ file })
    a.appendTurn('k1', 'q', 'a')
    const b = new HistoryStore({ file })
    assert.equal(b.get('k1').length, 2)
    assert.equal(b.get('k1')[1].content, 'a')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('HistoryStore: 超过 maxMessages 时保留最近', () => {
  const store = new HistoryStore({ file: null, maxMessages: 4 })
  for (let i = 0; i < 5; i += 1) store.appendTurn('k', `u${i}`, `a${i}`)
  const entries = store.get('k')
  assert.ok(entries.length <= 4)
  assert.equal(entries.at(-1).content, 'a4')
})

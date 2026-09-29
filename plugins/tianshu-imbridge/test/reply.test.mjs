import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHUNK_LIMIT, PASSIVE_LIMIT, TRUNCATED_NOTICE, planReply, splitText } from '../lib/reply.mjs'

function utf8RoundTrip(value) {
  return value === Buffer.from(value, 'utf8').toString('utf8')
}

test('splitText: 短文本原样返回', () => {
  assert.deepEqual(splitText('hello'), ['hello'])
})

test('splitText: 空文本返回空数组', () => {
  assert.deepEqual(splitText(''), [])
})

test('splitText: 换行边界优先切分且无损重组', () => {
  const text = Array.from({ length: 5 }, () => 'a'.repeat(10)).join('\n') // 54 chars
  const parts = splitText(text, 30)
  assert.ok(parts.length >= 2)
  assert.ok(parts.every((p) => p.length <= 30))
  assert.equal(parts.join(''), text)
})

test('splitText: 超长单行硬切且不产生孤立代理对', () => {
  const text = '😀'.repeat(10) // 20 UTF-16 code units（10 个代理对）
  const parts = splitText(text, 15)
  assert.ok(parts.every((p) => p.length <= 15))
  assert.equal(parts.join(''), text)
  assert.ok(parts.every(utf8RoundTrip), '每段必须无孤立代理（可 UTF-8 往返）')
})

test('splitText: 恰好等于限长时不切', () => {
  const text = 'x'.repeat(30)
  assert.deepEqual(splitText(text, 30), [text])
})

test('planReply: 单段不截断', () => {
  const r = planReply('hi', { scope: 'c2c' })
  assert.deepEqual(r, { chunks: ['hi'], truncated: false })
})

test('planReply: 空文本返回空 chunks', () => {
  const r = planReply('', { scope: 'c2c' })
  assert.deepEqual(r, { chunks: [], truncated: false })
})

test('planReply: c2c 超出被动条数上限时截断并在末尾附提示', () => {
  const big = Array.from({ length: 10 }, (_, i) => `line${i}:` + 'x'.repeat(2000)).join('\n') // ~20k chars → 5+ 段
  const r = planReply(big, { scope: 'c2c' })
  assert.equal(r.truncated, true)
  assert.equal(r.chunks.length, PASSIVE_LIMIT.c2c)
  assert.equal(r.chunks.at(-1), TRUNCATED_NOTICE)
  assert.ok(r.chunks.slice(0, -1).every((c) => c.length <= CHUNK_LIMIT))
})

test('planReply: group 上限为 5', () => {
  const big = Array.from({ length: 12 }, () => 'y'.repeat(2000)).join('\n')
  const r = planReply(big, { scope: 'group' })
  assert.equal(r.truncated, true)
  assert.equal(r.chunks.length, PASSIVE_LIMIT.group)
})

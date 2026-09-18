import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSafeFileName } from '../safe-path.js'

test('accepts ordinary single-segment names including unicode and dots', () => {
  for (const name of ['pdf-tools', 'foo.bar', 'wo_1737123', '计划-技能', 'a.b.c', 'Group-1_x']) {
    assert.equal(isSafeFileName(name), true, name)
  }
})

test('rejects traversal and separator forms', () => {
  for (const name of ['../x', 'a/b', 'a\\b', '..', '.', './x', '.hidden', 'a..b', 'x/', '', '\0']) {
    assert.equal(isSafeFileName(name), false, name)
  }
})

test('rejects overlong names', () => {
  assert.equal(isSafeFileName('a'.repeat(201)), false)
  assert.equal(isSafeFileName('a'.repeat(200)), true)
})

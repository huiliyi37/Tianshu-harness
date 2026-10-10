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

// Windows 保留设备名：无论大小写、是否带扩展名、尾随点/空格，落到 NTFS 都会
// 打开设备而非创建文件（CON.txt 即控制台），同名写入因此无声挂起或"成功"
// 却无文件——与 orderFileKey 拦冒号（ADS）同一族问题。
test('rejects Windows reserved device names regardless of case or extension', () => {
  for (const name of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'com9', 'LPT1', 'lpt9', 'CON.txt', 'nul.md', 'COM3.log', 'con.', 'CON ', 'CON .txt']) {
    assert.equal(isSafeFileName(name), false, name)
  }
})

test('allows names that merely contain a reserved token', () => {
  for (const name of ['console', 'com10', 'null.md', 'CONTEXT-x', 'lpt0', 'conf', 'auxiliary.md']) {
    assert.equal(isSafeFileName(name), true, name)
  }
})

test('rejects colons, ADS streams, drive-relative prefixes, and Windows forbidden characters', () => {
  for (const name of [
    'test.txt:stream',
    ':stream',
    'C:file.txt',
    'D:',
    'a<b',
    'a>b',
    'a"b',
    'a|b',
    'a?b',
    'a*b',
    'file\x01name',
    'file\x1Fname',
    'trail.',
    'trail ',
    'test.txt.',
    'test.txt ',
  ]) {
    assert.equal(isSafeFileName(name), false, name)
  }
})

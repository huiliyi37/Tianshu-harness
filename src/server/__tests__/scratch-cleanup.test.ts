import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listScratchEntries, removeScratchEntries } from '../scratch-cleanup.js'
import { isFilesystemMetadata } from '../../utils/file-metadata.js'

// 临时会话隔离根（<rivetHome>/workspace）的枚举与清理。
// 真实临时目录而非 mock：删除是破坏性操作，路径判定必须用真实 fs 语义
// （符号链接、realpath、目录/文件区分）验证，mock 只会验证我们的假设。

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'scratch-test-'))
}

function makeEntry(root: string, name: string, fileBytes = 0): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  if (fileBytes > 0) {
    writeFileSync(join(dir, 'payload.bin'), Buffer.alloc(fileBytes))
    // Keep this owned payload-only fixture exact on sidecar-generating filesystems.
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && isFilesystemMetadata(entry.name)) rmSync(join(dir, entry.name))
    }
  }
  return dir
}

test('listScratchEntries: 只列直接子目录，统计字节与 mtime，忽略普通文件', () => {
  const root = makeRoot()
  try {
    makeEntry(root, 'aaaa1111', 128)
    makeEntry(root, 'bbbb2222')
    writeFileSync(join(root, 'loose-file.txt'), 'x')

    const report = listScratchEntries(root)
    assert.deepEqual(report.entries.map((e) => e.name).sort(), ['aaaa1111', 'bbbb2222'])
    assert.equal(report.exists, true)
    assert.equal(report.totalBytes, 128, '只累计目录内容，不含松散文件')
    const a = report.entries.find((e) => e.name === 'aaaa1111')!
    assert.ok(a.mtime > 0, 'mtime 供 UI 显示「多久没用」')
    assert.equal(a.inUse, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('listScratchEntries: root 不存在 → 空报告而非抛错（用户可能从未用过临时会话）', () => {
  const missing = join(tmpdir(), 'scratch-never-exists-xyz')
  const report = listScratchEntries(missing)
  assert.equal(report.exists, false)
  assert.deepEqual(report.entries, [])
  assert.equal(report.totalBytes, 0)
})

test('listScratchEntries: 有会话占用时标记 inUse（供 UI 禁用删除）', () => {
  const root = makeRoot()
  try {
    const busy = makeEntry(root, 'cccc3333')
    makeEntry(root, 'dddd4444')
    const report = listScratchEntries(root, [busy])
    assert.equal(report.entries.find((e) => e.name === 'cccc3333')?.inUse, true)
    assert.equal(report.entries.find((e) => e.name === 'dddd4444')?.inUse, false)
    assert.equal(report.inUseCount, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('removeScratchEntries: 删除指定目录并回报释放字节', () => {
  const root = makeRoot()
  try {
    const target = makeEntry(root, 'eeee5555', 64)
    const keep = makeEntry(root, 'ffff6666')
    const res = removeScratchEntries(root, ['eeee5555'])
    assert.deepEqual(res.deleted, ['eeee5555'])
    assert.equal(res.freedBytes, 64)
    assert.equal(existsSync(target), false)
    assert.equal(existsSync(keep), true, '未点名的目录一律不动')
    assert.deepEqual(res.skipped, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('removeScratchEntries: 非法名（穿越/分隔符/隐藏/空）一律拒绝', () => {
  const root = makeRoot()
  const outside = makeRoot()
  try {
    const victim = makeEntry(outside, 'victim', 32)
    const res = removeScratchEntries(root, ['../' + 'victim', 'a/b', '', '..', '.hidden'])
    assert.equal(res.deleted.length, 0)
    assert.deepEqual(res.skipped.map((s) => s.reason), [
      'invalid-name', 'invalid-name', 'invalid-name', 'invalid-name', 'invalid-name',
    ])
    assert.equal(existsSync(victim), true, '路径穿越绝不能删到 root 之外')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('removeScratchEntries: 有会话占用 → 跳过且目录保留（运行中的临时会话不能被清掉）', () => {
  const root = makeRoot()
  try {
    const busy = makeEntry(root, 'aaaa7777')
    const res = removeScratchEntries(root, ['aaaa7777'], [busy])
    assert.deepEqual(res.deleted, [])
    assert.deepEqual(res.skipped, [{ name: 'aaaa7777', reason: 'in-use' }])
    assert.equal(existsSync(busy), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('removeScratchEntries: 不存在 → skipped not-found（不静默当成功）', () => {
  const root = makeRoot()
  try {
    const res = removeScratchEntries(root, ['ghost0000'])
    assert.deepEqual(res.deleted, [])
    assert.deepEqual(res.skipped, [{ name: 'ghost0000', reason: 'not-found' }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('removeScratchEntries: 符号链接不跟随也不删除（逃逸面的最小区分）', (t) => {
  const root = makeRoot()
  const outside = makeRoot()
  try {
    const target = makeEntry(outside, 'real-dir', 16)
    try {
      symlinkSync(target, join(root, 'escape0000'), 'dir')
    } catch {
      // Windows 无开发者模式/特权时 EPERM——符号链接语义无法在该环境构造，
      // 该逃逸面在 POSIX 侧由本用例与 CI 覆盖。
      t.skip('当前环境不允许创建符号链接（Windows 无特权/开发者模式）')
      return
    }
    const res = removeScratchEntries(root, ['escape0000'])
    assert.deepEqual(res.deleted, [])
    assert.deepEqual(res.skipped, [{ name: 'escape0000', reason: 'symlink' }])
    assert.equal(existsSync(target), true, '链接目标必须完好')
    assert.ok(statSync(join(root, 'escape0000')), '链接本身也不动——留给用户自己判断')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('removeScratchEntries: 普通文件不是临时会话目录，不参与清理', () => {
  const root = makeRoot()
  try {
    writeFileSync(join(root, 'loose-file.txt'), 'x')
    const res = removeScratchEntries(root, ['loose-file.txt'])
    assert.deepEqual(res.deleted, [])
    assert.deepEqual(res.skipped, [{ name: 'loose-file.txt', reason: 'not-a-directory' }])
    assert.equal(existsSync(join(root, 'loose-file.txt')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

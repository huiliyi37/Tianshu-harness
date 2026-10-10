import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { trackFileChange, restoreLatestBackup } from '../recovery-stack.js'

async function waitForBackup(path: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (true) {
    try { await fs.access(path); return } catch {
      assert.ok(Date.now() < deadline, 'background backup must publish')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
}

for (const [name, bytes] of [
  ['legacy single-byte text', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0d, 0x0a])],
  ['non-NUL invalid UTF-8', Buffer.from([0xff, 0xfe, 0x41, 0x42, 0x43])],
  ['valid UTF-8 with CRLF', Buffer.from('工程\r\n')],
] as const) {
  test(`rollback and its disk backup preserve original bytes for ${name}`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'recovery-original-bytes-'))
    const target = join(cwd, 'fixture.txt')
    try {
      await writeFile(target, bytes)
      const record = await trackFileChange(cwd, { filePath: 'fixture.txt', action: 'write', toolCallId: 'byte-edit' })
      await writeFile(target, 'replacement')
      assert.equal(await restoreLatestBackup(cwd, 'fixture.txt'), true)
      assert.deepEqual(await readFile(target), bytes, 'successful rollback must recover every original byte')
      assert.ok(record.backupPath)
      await waitForBackup(record.backupPath)
      assert.deepEqual(await readFile(record.backupPath), bytes, 'disk recovery must preserve the same original bytes')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
}

test('a later binary backup replaces the prior text memory backup for the same path', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'recovery-later-binary-'))
  const target = join(cwd, 'fixture.dat')
  const binary = Buffer.from([0x42, 0x00, 0xff, 0x43])
  try {
    await writeFile(target, 'older text')
    await trackFileChange(cwd, { filePath: 'fixture.dat', action: 'write', toolCallId: 'first-text-edit' })
    assert.equal(await restoreLatestBackup(cwd, 'fixture.dat'), true)
    await writeFile(target, binary)
    const record = await trackFileChange(cwd, { filePath: 'fixture.dat', action: 'write', toolCallId: 'second-binary-edit' })
    assert.ok(record.backupPath)
    assert.deepEqual(await readFile(record.backupPath), binary, 'binary fallback publishes its backup before returning')
    await writeFile(target, 'replacement after binary')
    assert.equal(await restoreLatestBackup(cwd, 'fixture.dat'), true)
    assert.deepEqual(await readFile(target), binary, 'rollback must use the latest capture instead of older text')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('same-millisecond captures keep their own disk bytes when the older write publishes last', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'recovery-same-clock-'))
  const target = join(cwd, 'fixture.txt')
  const originalWrite = fs.writeFile.bind(fs)
  const originalRename = fs.rename.bind(fs)
  const clock = Date.now()
  let release!: () => void
  let entered!: () => void
  let published!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const atOlderPublish = new Promise<void>(resolve => { entered = resolve })
  const olderPublished = new Promise<void>(resolve => { published = resolve })
  let olderTemporary: string | undefined
  t.mock.method(Date, 'now', () => clock)
  t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]).includes(join(cwd, '.rivet', 'backups')) && Buffer.from(args[1] as Buffer).equals(Buffer.from('older text'))) {
      olderTemporary = String(args[0])
    }
    return originalWrite(...args)
  })
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[0]) !== olderTemporary) return originalRename(...args)
    entered()
    await gate
    await originalRename(...args)
    published()
  })
  syncBuiltinESMExports()
  try {
    await originalWrite(target, 'older text')
    const first = await trackFileChange(cwd, { filePath: 'fixture.txt', action: 'edit', toolCallId: 'older-capture' })
    await atOlderPublish
    await originalWrite(target, 'latest text')
    const second = await trackFileChange(cwd, { filePath: 'fixture.txt', action: 'edit', toolCallId: 'latest-capture' })
    assert.equal(first.ts, clock)
    assert.equal(second.ts, clock)
    assert.equal(await restoreLatestBackup(cwd, 'fixture.txt'), true)
    release()
    await olderPublished
    assert.ok(first.backupPath)
    assert.ok(second.backupPath)
    await waitForBackup(second.backupPath)
    assert.equal(await readFile(first.backupPath, 'utf8'), 'older text')
    assert.equal(await readFile(second.backupPath, 'utf8'), 'latest text', 'late publication of an older capture must not corrupt the latest disk backup')
  } finally {
    release()
    await olderPublished
    t.mock.restoreAll()
    syncBuiltinESMExports()
    await rm(cwd, { recursive: true, force: true })
  }
})

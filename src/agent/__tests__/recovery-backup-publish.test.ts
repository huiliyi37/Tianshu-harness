import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { trackFileChange, restoreLatestBackup } from '../recovery-stack.js'

test('a background backup becomes visible only after all captured bytes are written', async (t) => {
  const cwd = await fs.mkdtemp(join(tmpdir(), 'rivet-backup-publish-'))
  const target = join(cwd, 'original.txt')
  const originalWrite = fs.writeFile.bind(fs)
  await originalWrite(target, 'original captured bytes')
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]).includes(join(cwd, '.rivet', 'backups'))) {
      await originalWrite(args[0], '', args[2])
      entered()
      await gate
    }
    return originalWrite(...args)
  })
  syncBuiltinESMExports()
  let backupPath: string | undefined
  try {
    const record = await trackFileChange(cwd, { filePath: 'original.txt', action: 'write', toolCallId: 'qa-publish' })
    backupPath = record.backupPath
    await started
    assert.ok(record.backupPath)
    await originalWrite(target, 'new source bytes')
    assert.equal(existsSync(record.backupPath), false, 'a partial backup must not appear at the canonical recovery path')
  } finally {
    release()
    try {
      if (backupPath) {
        assert.equal(await restoreLatestBackup(cwd, 'original.txt'), true)
        assert.equal(await fs.readFile(target, 'utf8'), 'original captured bytes')
        const deadline = Date.now() + 10_000
        while (!existsSync(backupPath)) {
          assert.ok(Date.now() < deadline, 'background backup must finish publication')
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        assert.equal(await fs.readFile(backupPath, 'utf8'), 'original captured bytes')
      }
    } finally {
      t.mock.restoreAll()
      syncBuiltinESMExports()
      await fs.rm(cwd, { recursive: true, force: true })
    }
  }
})

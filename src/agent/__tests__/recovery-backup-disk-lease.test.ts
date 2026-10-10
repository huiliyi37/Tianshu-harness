import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as recovery from '../recovery-stack.js'

for (const [name, bytes] of [
  ['binary', Buffer.from([0x41, 0, 0x42])],
  ['large', Buffer.alloc(10 * 1024 * 1024 + 1, 0x41)],
] as const) {
  test(`held ${name} disk capture survives cleanup until its lease is explicitly released`, async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), 'backup-disk-lease-'))
    let capture: recovery.FileChangeRecord | undefined
    try {
      await fs.writeFile(join(cwd, 'fixture.dat'), bytes)
      capture = await recovery.trackFileChange(cwd, { filePath: 'fixture.dat', action: 'edit', toolCallId: `held-${name}` })
      if (name === 'binary') {
        for (let i = 1; i <= 101; i++) await fs.mkdir(join(cwd, '.rivet', 'backups', String(capture.ts + i)), { recursive: true })
        await recovery.evictOldBackups(cwd)
      } else await recovery.evictOldBackups(cwd, 0)
      await fs.writeFile(join(cwd, 'fixture.dat'), 'broken edit')
      assert.equal(await recovery.restoreFileChange(cwd, capture), true, 'active disk-only capture must remain available to rollback')
      assert.deepEqual(await fs.readFile(join(cwd, 'fixture.dat')), bytes)
      recovery.releaseFileChange(capture)
      await recovery.evictOldBackups(cwd, 0)
      await assert.rejects(fs.access(capture.backupPath!), { code: 'ENOENT' })
    } finally {
      if (capture) recovery.releaseFileChange?.(capture)
      await fs.rm(cwd, { recursive: true, force: true })
    }
  })
}

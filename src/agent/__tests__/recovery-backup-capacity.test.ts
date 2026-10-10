import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { trackFileChange, restoreFileChange, type FileChangeRecord } from '../recovery-stack.js'

test('unpublished backup capacity rejects a new capture before mutation and preserves held rollback bytes', async (t) => {
  const cwd = await fs.mkdtemp(join(tmpdir(), 'backup-capacity-'))
  const originalRename = fs.rename.bind(fs)
  const captures: FileChangeRecord[] = []
  let rejected = 0
  let unavailable = true
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (unavailable && String(args[1]).includes(join(cwd, '.rivet', 'backups'))) {
      rejected++
      throw Object.assign(new Error('backup volume unavailable'), { code: 'EIO' })
    }
    return originalRename(...args)
  })
  syncBuiltinESMExports()
  try {
    for (let i = 0; i < 20; i++) {
      await fs.writeFile(join(cwd, `fixture-${i}.txt`), `original ${i}`)
      captures.push(await trackFileChange(cwd, { filePath: `fixture-${i}.txt`, action: 'edit', toolCallId: `capture-${i}` }))
      for (let attempt = 0; rejected <= i; attempt++) {
        assert.ok(attempt < 1000, 'background publication must report its failure')
        await new Promise(resolve => setTimeout(resolve, 5))
      }
    }
    await fs.writeFile(join(cwd, 'new-target.txt'), 'untouched new target')
    await assert.rejects(trackFileChange(cwd, { filePath: 'new-target.txt', action: 'edit', toolCallId: 'over-capacity' }), /backup capacity/i)
    assert.equal(await fs.readFile(join(cwd, 'new-target.txt'), 'utf8'), 'untouched new target')
    for (const [i, capture] of captures.entries()) {
      await fs.writeFile(join(cwd, capture.filePath), 'broken edit')
      assert.equal(await restoreFileChange(cwd, capture), true)
      assert.equal(await fs.readFile(join(cwd, capture.filePath), 'utf8'), `original ${i}`)
    }
    unavailable = false
    const resumed = await trackFileChange(cwd, { filePath: 'new-target.txt', action: 'edit', toolCallId: 'storage-recovered' })
    assert.ok(resumed.backupPath, 'one failed publication retry must free capacity after storage recovers')
    await fs.writeFile(join(cwd, 'new-target.txt'), 'broken resumed edit')
    assert.equal(await restoreFileChange(cwd, resumed), true)
    assert.equal(await fs.readFile(join(cwd, 'new-target.txt'), 'utf8'), 'untouched new target')
    for (let attempt = 0; ; attempt++) {
      try { await fs.access(resumed.backupPath); break } catch {
        assert.ok(attempt < 1000, 'resumed backup must publish')
        await new Promise(resolve => setTimeout(resolve, 5))
      }
    }
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    await fs.rm(cwd, { recursive: true, force: true, maxRetries: 5 })
  }
})

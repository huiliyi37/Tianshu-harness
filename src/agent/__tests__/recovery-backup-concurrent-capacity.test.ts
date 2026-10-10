import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { trackFileChange, restoreFileChange, type FileChangeRecord } from '../recovery-stack.js'

test('concurrent captures reserve at most 20 unpublished slots without waiting for their flushes', async (t) => {
  const cwd = await fs.mkdtemp(join(tmpdir(), 'backup-concurrent-capacity-'))
  const originalRename = fs.rename.bind(fs)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const captures: FileChangeRecord[] = []
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]).includes(join(cwd, '.rivet', 'backups'))) await gate
    return originalRename(...args)
  })
  syncBuiltinESMExports()
  try {
    for (let i = 0; i < 21; i++) await fs.writeFile(join(cwd, `fixture-${i}.txt`), `original ${i}`)
    const settled = await Promise.allSettled(Array.from({ length: 21 }, (_, i) =>
      trackFileChange(cwd, { filePath: `fixture-${i}.txt`, action: 'edit', toolCallId: `concurrent-${i}` })))
    const rejected = settled.filter(result => result.status === 'rejected')
    for (const result of settled) if (result.status === 'fulfilled') captures.push(result.value)
    assert.equal(captures.length, 20)
    assert.equal(rejected.length, 1)
    assert.match(String((rejected[0] as PromiseRejectedResult).reason), /backup capacity/i)
    const first = captures[0]!
    const original = await fs.readFile(join(cwd, first.filePath), 'utf8')
    await fs.writeFile(join(cwd, first.filePath), 'broken concurrent edit')
    assert.equal(await restoreFileChange(cwd, first), true, 'rollback uses captured bytes while all publications remain paused')
    assert.equal(await fs.readFile(join(cwd, first.filePath), 'utf8'), original)
  } finally {
    release()
    for (const capture of captures) {
      for (let attempt = 0; ; attempt++) {
        try { await fs.access(capture.backupPath!); break } catch {
          assert.ok(attempt < 1000, 'released backup must publish')
          await new Promise(resolve => setTimeout(resolve, 5))
        }
      }
    }
    t.mock.restoreAll()
    syncBuiltinESMExports()
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { trackFileChange, evictOldBackups, type FileChangeRecord } from '../recovery-stack.js'

test('storage recovery retries publication after an already-started cleanup finishes deleting its directory', async (t) => {
  const cwd = await fs.mkdtemp(join(tmpdir(), 'backup-cleanup-retry-'))
  const originalRename = fs.rename.bind(fs)
  const originalRm = fs.rm.bind(fs)
  const captures: FileChangeRecord[] = []
  let unavailable = true
  let failures = 0
  let targetDir: string | undefined
  let targetBackup: string | undefined
  let releaseDelete!: () => void
  let deleteStarted!: () => void
  let releaseRename!: () => void
  let renameStarted!: () => void
  const deleteGate = new Promise<void>(resolve => { releaseDelete = resolve })
  const deleting = new Promise<void>(resolve => { deleteStarted = resolve })
  const renameGate = new Promise<void>(resolve => { releaseRename = resolve })
  const publishing = new Promise<void>(resolve => { renameStarted = resolve })
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]).includes(join(cwd, '.rivet', 'backups'))) {
      if (unavailable) { failures++; throw Object.assign(new Error('volume unavailable'), { code: 'EIO' }) }
      if (String(args[1]) === targetBackup) { renameStarted(); await renameGate }
    }
    return originalRename(...args)
  })
  t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
    if (String(args[0]) === targetDir) { deleteStarted(); await deleteGate }
    return originalRm(...args)
  })
  syncBuiltinESMExports()
  let cleanup: Promise<void> | undefined
  let admission: Promise<FileChangeRecord> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    for (let i = 0; i < 20; i++) {
      const filePath = `old-${i}.txt`
      await fs.writeFile(join(cwd, filePath), `old bytes ${i}`)
      captures.push(await trackFileChange(cwd, { filePath, action: 'edit', toolCallId: `old-${i}` }))
      while (failures <= i) await new Promise(resolve => setTimeout(resolve, 5))
      await new Promise(resolve => setImmediate(resolve))
    }
    targetBackup = captures[0]!.backupPath!
    targetDir = dirname(dirname(targetBackup))
    cleanup = evictOldBackups(cwd, 0)
    await deleting
    unavailable = false
    await fs.writeFile(join(cwd, 'new.txt'), 'untouched target')
    admission = trackFileChange(cwd, { filePath: 'new.txt', action: 'edit', toolCallId: 'storage-recovered' })
    void admission.catch(() => {})
    // A broken implementation reaches rename while rm is still gated. The
    // correct implementation waits for rm before recreating the directory.
    await Promise.race([publishing, new Promise<void>(resolve => { timer = setTimeout(resolve, 3000) })])
    releaseDelete()
    await cleanup
    releaseRename()
    const capture = await admission
    assert.ok(capture.backupPath, 'the recovered volume must admit the new edit instead of losing the retried backup to cleanup')
    assert.equal(await fs.readFile(join(cwd, 'new.txt'), 'utf8'), 'untouched target')
    for (let attempt = 0; ; attempt++) {
      try { await fs.access(capture.backupPath!); break } catch {
        assert.ok(attempt < 1000, 'new backup must publish')
        await new Promise(resolve => setTimeout(resolve, 5))
      }
    }
  } finally {
    if (timer) clearTimeout(timer)
    releaseDelete()
    releaseRename()
    await cleanup
    await admission?.catch(() => {})
    t.mock.restoreAll()
    syncBuiltinESMExports()
    await originalRm(cwd, { recursive: true, force: true, maxRetries: 5 })
  }
})

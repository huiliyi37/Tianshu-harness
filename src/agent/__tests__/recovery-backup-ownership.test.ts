import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { trackFileChange, restoreLatestBackup, restoreFileChange, estimateLinesLost, evictOldBackups } from '../recovery-stack.js'
import { EDIT_FILE_TOOL } from '../../tools/edit.js'

async function waitForBackup(path: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await fs.access(path); return } catch {
      assert.ok(attempt < 1000, 'background backup must publish')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
}

test('edit rollback restores its capture when another session captures the same path before validation', async () => {
  const cwd = await fs.mkdtemp(join(tmpdir(), 'backup-owner-'))
  const target = join(cwd, 'fixture.json')
  try {
    await fs.writeFile(target, '{"owner":"first"}')
    const result = await EDIT_FILE_TOOL.execute({
      cwd, sessionId: 'first-session', toolUseId: 'first-edit',
      input: { file_path: target, old_string: '"first"', new_string: '[' },
      onClientDelegate: async (_kind, payload) => {
        await fs.writeFile(target, '{"owner":"second"}')
        await trackFileChange(cwd, { filePath: 'fixture.json', action: 'edit', toolCallId: 'second-session-capture' })
        await fs.writeFile(target, payload.newContent as string)
        return { content: 'applied', status: 'ok' }
      },
    })
    assert.equal(result.errorKind, 'syntax_error')
    assert.equal(await fs.readFile(target, 'utf8'), '{"owner":"first"}')
    assert.equal(await restoreLatestBackup(cwd, 'fixture.json', 'second-session'), true)
    assert.equal(await fs.readFile(target, 'utf8'), '{"owner":"second"}', 'legacy latest still selects the latest capture')
  } finally { await fs.rm(cwd, { recursive: true, force: true }) }
})

test('line loss estimates honor the supplied capture path instead of another capture in memory', async () => {
  const cwd = await fs.mkdtemp(join(tmpdir(), 'backup-lines-'))
  try {
    await fs.writeFile(join(cwd, 'fixture.txt'), 'a\nb\nc\nd')
    const first = await trackFileChange(cwd, { filePath: 'fixture.txt', action: 'edit', toolCallId: 'first' })
    await waitForBackup(first.backupPath!)
    await fs.writeFile(join(cwd, 'fixture.txt'), 'x\ny')
    const second = await trackFileChange(cwd, { filePath: 'fixture.txt', action: 'edit', toolCallId: 'second' })
    await waitForBackup(second.backupPath!)
    await fs.writeFile(join(cwd, 'fixture.txt'), 'z')
    assert.equal(await estimateLinesLost(cwd, 'fixture.txt', first.backupPath), 3)
  } finally { await fs.rm(cwd, { recursive: true, force: true }) }
})

for (const pressure of [0, 21, -1]) {
  test(pressure === -1 ? 'disk cleanup preserves an in-flight backup until publication finishes'
    : `memory rollback completes while backup publication is paused with ${pressure} later captures`, async (t) => {
    const cwd = await fs.mkdtemp(join(tmpdir(), 'backup-pending-'))
    const originalRename = fs.rename.bind(fs)
    let release!: () => void
    let entered!: () => void
    let published!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const done = new Promise<void>(resolve => { published = resolve })
    t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
      if (basename(String(args[1])) === 'fixture.txt' && String(args[1]).includes(join(cwd, '.rivet', 'backups'))) {
        entered()
        await gate
        try { await originalRename(...args) } finally { published() }
        return
      }
      return originalRename(...args)
    })
    syncBuiltinESMExports()
    let restore: Promise<boolean> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await fs.writeFile(join(cwd, 'fixture.txt'), 'captured before edit')
      await trackFileChange(cwd, { filePath: 'fixture.txt', action: 'write', toolCallId: 'pending' })
      await started
      if (pressure === -1) {
        await evictOldBackups(cwd, 0)
        assert.ok((await fs.readdir(join(cwd, '.rivet', 'backups'))).length > 0, 'disk cleanup must retain the in-flight capture directory')
      }
      for (let i = 0; i < pressure; i++) {
        await fs.writeFile(join(cwd, `later-${i}.txt`), `later ${i}`)
        const later = await trackFileChange(cwd, { filePath: `later-${i}.txt`, action: 'edit', toolCallId: `later-${i}` })
        await waitForBackup(later.backupPath!)
      }
      await fs.writeFile(join(cwd, 'fixture.txt'), 'broken edit')
      restore = restoreLatestBackup(cwd, 'fixture.txt')
      const result = await Promise.race([restore, new Promise<string>(resolve => { timer = setTimeout(() => resolve('blocked on publication'), 5000) })])
      assert.equal(result, true, 'captured memory must restore before background publication completes')
      assert.equal(await fs.readFile(join(cwd, 'fixture.txt'), 'utf8'), 'captured before edit')
    } finally {
      if (timer) clearTimeout(timer)
      release()
      await done
      await restore
      t.mock.restoreAll()
      syncBuiltinESMExports()
      await fs.rm(cwd, { recursive: true, force: true })
    }
  })
}

test('a held capture restores its bytes after cache pressure and disk cleanup remove its fallback', async () => {
  const cwd = await fs.mkdtemp(join(tmpdir(), 'backup-held-'))
  try {
    await fs.writeFile(join(cwd, 'fixture.txt'), 'original held bytes')
    const capture = await trackFileChange(cwd, { filePath: 'fixture.txt', action: 'edit', toolCallId: 'held' })
    await waitForBackup(capture.backupPath!)
    for (let i = 0; i < 21; i++) {
      await fs.writeFile(join(cwd, `later-${i}.txt`), `later ${i}`)
      const later = await trackFileChange(cwd, { filePath: `later-${i}.txt`, action: 'edit', toolCallId: `later-${i}` })
      await waitForBackup(later.backupPath!)
    }
    await evictOldBackups(cwd, 0)
    await assert.rejects(fs.access(capture.backupPath!), { code: 'ENOENT' })
    await fs.writeFile(join(cwd, 'fixture.txt'), 'broken edit')
    assert.equal(await restoreFileChange(cwd, capture, 'owner-session'), true)
    assert.equal(await fs.readFile(join(cwd, 'fixture.txt'), 'utf8'), 'original held bytes')
  } finally { await fs.rm(cwd, { recursive: true, force: true }) }
})

test('permanently failed backup publication still leaves latest rollback safe after cache pressure', async (t) => {
  const cwd = await fs.mkdtemp(join(tmpdir(), 'backup-failed-'))
  const originalRename = fs.rename.bind(fs)
  let rejected!: () => void
  const failed = new Promise<void>(resolve => { rejected = resolve })
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (basename(String(args[1])) === 'fixture.txt' && String(args[1]).includes(join(cwd, '.rivet', 'backups'))) {
      rejected()
      throw Object.assign(new Error('backup volume denied publication'), { code: 'EIO' })
    }
    return originalRename(...args)
  })
  syncBuiltinESMExports()
  try {
    await fs.writeFile(join(cwd, 'fixture.txt'), 'memory survives publish failure')
    const capture = await trackFileChange(cwd, { filePath: 'fixture.txt', action: 'edit', toolCallId: 'failed' })
    await failed
    for (let i = 0; i < 21; i++) {
      await fs.writeFile(join(cwd, `later-${i}.txt`), `later ${i}`)
      const later = await trackFileChange(cwd, { filePath: `later-${i}.txt`, action: 'edit', toolCallId: `later-${i}` })
      await waitForBackup(later.backupPath!)
    }
    await assert.rejects(fs.access(capture.backupPath!), { code: 'ENOENT' })
    await fs.writeFile(join(cwd, 'fixture.txt'), 'broken edit')
    assert.equal(await restoreLatestBackup(cwd, 'fixture.txt'), true)
    assert.equal(await fs.readFile(join(cwd, 'fixture.txt'), 'utf8'), 'memory survives publish failure')
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WRITE_FILE_TOOL } from '../write-file.js'
import { evictOldBackups, withFileChangeTracking } from '../../agent/recovery-stack.js'

async function numericBackupDirs(cwd: string): Promise<string[]> {
  return (await fs.readdir(join(cwd, '.rivet', 'backups'), { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name)).map(entry => entry.name)
}

for (const exit of ['success', 'rejected', 'throw', 'abort'] as const) {
  test(`write_file releases its disk capture lease after ${exit}`, async (t) => {
    const cwd = await fs.mkdtemp(join(tmpdir(), 'backup-tool-lease-'))
    const target = join(cwd, 'fixture.json')
    const controller = new AbortController()
    const previousGuard = process.env.RIVET_WRITE_OVERWRITE_GUARD
    process.env.RIVET_WRITE_OVERWRITE_GUARD = '0'
    try {
      await fs.writeFile(target, Buffer.from([0x41, 0, 0x42]))
      const execution = WRITE_FILE_TOOL.execute({
        cwd, toolUseId: `lease-${exit}`, abortSignal: controller.signal,
        input: { file_path: target, content: '{"valid":true}\n' },
        onClientDelegate: async (_kind, payload) => {
          await evictOldBackups(cwd, 0)
          const held = await numericBackupDirs(cwd)
          assert.equal(held.length, 1, `capture must be protected while client landing remains active: ${held.join(', ')}`)
          if (exit === 'throw') throw new Error('client disconnected')
          if (exit === 'abort') controller.abort()
          if (exit !== 'success') return { content: 'rejected', status: 'rejected' }
          await fs.writeFile(target, payload.newContent as string)
          return { content: 'applied', status: 'ok' }
        },
      })
      if (exit === 'throw') await assert.rejects(execution, /client disconnected/)
      else await execution
      await evictOldBackups(cwd, 0)
      assert.equal((await numericBackupDirs(cwd)).length, 0, 'completed tool must not leave a permanent cleanup exemption')
    } finally {
      t.mock.restoreAll()
      if (previousGuard === undefined) delete process.env.RIVET_WRITE_OVERWRITE_GUARD
      else process.env.RIVET_WRITE_OVERWRITE_GUARD = previousGuard
      await fs.rm(cwd, { recursive: true, force: true })
    }
  })
}

test('capture scope releases earlier disk captures when a later step fails', async () => {
  const cwd = await fs.mkdtemp(join(tmpdir(), 'backup-partial-scope-'))
  try {
    for (const file of ['a.dat', 'b.dat']) await fs.writeFile(join(cwd, file), Buffer.from([1, 0, 2]))
    const execute = withFileChangeTracking(async (_: undefined, track) => {
      await track(cwd, { filePath: 'a.dat', action: 'edit', toolCallId: 'a' })
      await track(cwd, { filePath: 'b.dat', action: 'edit', toolCallId: 'b' })
      throw new Error('later capture or mutation failed')
    })
    await assert.rejects(execute(undefined), /later capture or mutation failed/)
    await evictOldBackups(cwd, 0)
    assert.equal((await numericBackupDirs(cwd)).length, 0)
  } finally { await fs.rm(cwd, { recursive: true, force: true }) }
})

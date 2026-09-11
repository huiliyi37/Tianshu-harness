import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { FileHistory } from '../file-history.js'

const TMP = join(import.meta.dirname, '.fh-test-tmp')
const BACKUP = join(import.meta.dirname, '.fh-test-backup')

describe('FileHistory', () => {
  let history: FileHistory

  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    rmSync(BACKUP, { recursive: true, force: true })
    mkdirSync(TMP, { recursive: true })
    mkdirSync(BACKUP, { recursive: true })
    history = new FileHistory(BACKUP, 'test-session')
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    rmSync(BACKUP, { recursive: true, force: true })
  })

  it('captures backup before write and tracks file', async () => {
    const file = join(TMP, 'a.txt')
    writeFileSync(file, 'original')
    await history.trackEdit(file, 'msg_1')

    writeFileSync(file, 'modified')
    const stats = await history.getDiffStats('msg_1')
    assert.ok(stats !== undefined)
    assert.ok(stats!.filesChanged.length > 0)
  })

  it('restores file to previous version', async () => {
    const file = join(TMP, 'a.txt')
    writeFileSync(file, 'v1')
    await history.trackEdit(file, 'msg_1')

    writeFileSync(file, 'v2')
    await history.trackEdit(file, 'msg_2')

    writeFileSync(file, 'v3')

    await history.rewind('msg_1')
    assert.equal(readFileSync(file, 'utf-8'), 'v1')
  })

  it('handles file that did not exist at target snapshot', async () => {
    const file = join(TMP, 'new.txt')
    // trackEdit before file exists — captures null backup
    await history.trackEdit(file, 'msg_1')
    // Then create the file
    writeFileSync(file, 'created')

    await history.rewind('msg_1')
    assert.equal(existsSync(file), false)
  })

  it('returns undefined diff stats for unknown message', async () => {
    const stats = await history.getDiffStats('nonexistent')
    assert.equal(stats, undefined)
  })

  it('reports latest snapshot id', async () => {
    const file = join(TMP, 'a.txt')
    writeFileSync(file, 'v1')
    await history.trackEdit(file, 'msg_1')
    assert.equal(history.getLatestSnapshotId(), 'msg_1')
  })

  it('reports hasSnapshot correctly', async () => {
    assert.equal(history.hasSnapshot('msg_1'), false)
    const file = join(TMP, 'a.txt')
    writeFileSync(file, 'v1')
    await history.trackEdit(file, 'msg_1')
    assert.equal(history.hasSnapshot('msg_1'), true)
  })

  it('rewindToBoundary restores multiple files to their pre-boundary content', async () => {
    const a = join(TMP, 'a.txt')
    const b = join(TMP, 'b.txt')
    writeFileSync(a, 'a@boundary')
    writeFileSync(b, 'b@boundary')
    // Post-boundary edits (ids belong to the "after" set).
    await history.trackEdit(a, 'edit_1')
    writeFileSync(a, 'a-new')
    await history.trackEdit(b, 'edit_2')
    writeFileSync(b, 'b-new')
    // A second edit to a — must NOT override the earliest post-boundary backup.
    await history.trackEdit(a, 'edit_3')
    writeFileSync(a, 'a-newest')

    const changed = await history.rewindToBoundary(new Set(['edit_1', 'edit_2', 'edit_3']))
    assert.deepEqual(new Set(changed), new Set([a, b]))
    assert.equal(readFileSync(a, 'utf-8'), 'a@boundary')
    assert.equal(readFileSync(b, 'utf-8'), 'b@boundary')
  })

  it('rewindToBoundary deletes files first created after the boundary', async () => {
    const created = join(TMP, 'created.txt')
    await history.trackEdit(created, 'edit_1') // captured null backup (did not exist)
    writeFileSync(created, 'created after boundary')

    const changed = await history.rewindToBoundary(new Set(['edit_1']))
    assert.deepEqual(changed, [created])
    assert.equal(existsSync(created), false)
  })

  it('rewind skips files whose backup read failed while the path existed (no unlink)', async () => {
    // 跨平台的「存在但读不了」触发：trackEdit 时路径是目录（readFile EISDIR），
    // 与 Windows AV/EDR 锁、EBUSY 同属「备份没拿到 ≠ 文件当时不存在」。
    const file = join(TMP, 'was-busy.txt')
    mkdirSync(file) // 路径存在，但读不了
    await history.trackEdit(file, 'msg_1')
    rmSync(file, { recursive: true })
    writeFileSync(file, 'edited after lock released')

    const changed = await history.rewind('msg_1')
    assert.deepEqual(changed, [])
    assert.equal(existsSync(file), true)
    assert.equal(readFileSync(file, 'utf-8'), 'edited after lock released')
  })

  it('rewindToBoundary skips unreadable-backup files instead of deleting them', async () => {
    const file = join(TMP, 'busy-boundary.txt')
    mkdirSync(file)
    await history.trackEdit(file, 'edit_1')
    rmSync(file, { recursive: true })
    writeFileSync(file, 'edited after boundary')

    const changed = await history.rewindToBoundary(new Set(['edit_1']))
    assert.deepEqual(changed, [])
    assert.equal(readFileSync(file, 'utf-8'), 'edited after boundary')
  })

  it('getBoundaryFiles reports unreadable action instead of delete', async () => {
    const file = join(TMP, 'busy-preview.txt')
    mkdirSync(file)
    await history.trackEdit(file, 'edit_1')
    rmSync(file, { recursive: true })
    writeFileSync(file, 'edited')

    const files = history.getBoundaryFiles(new Set(['edit_1']))
    assert.deepEqual(files, [{ path: file, action: 'unreadable' }])
  })

  it('rewindToBoundary leaves pre-boundary-only files untouched', async () => {
    const kept = join(TMP, 'kept.txt')
    writeFileSync(kept, 'v1')
    await history.trackEdit(kept, 'pre_edit') // this edit is NOT in the post-boundary set
    writeFileSync(kept, 'v2')

    const changed = await history.rewindToBoundary(new Set(['some_other_id']))
    assert.deepEqual(changed, [])
    assert.equal(readFileSync(kept, 'utf-8'), 'v2')
  })

  it('getBoundaryFiles reports restore vs delete actions', async () => {
    const restore = join(TMP, 'restore.txt')
    const del = join(TMP, 'del.txt')
    writeFileSync(restore, 'orig')
    await history.trackEdit(restore, 'edit_1')
    await history.trackEdit(del, 'edit_2') // null backup → delete
    writeFileSync(del, 'created')

    const files = history.getBoundaryFiles(new Set(['edit_1', 'edit_2']))
    const byPath = new Map(files.map(f => [f.path, f.action]))
    assert.equal(byPath.get(restore), 'restore')
    assert.equal(byPath.get(del), 'delete')
  })

  it('cleanupOrphans removes unreferenced backup files', async () => {
    const file = join(TMP, 'a.txt')
    writeFileSync(file, 'v1')
    await history.trackEdit(file, 'msg_1')

    const sessionDir = join(BACKUP, 'test-session')
    writeFileSync(join(sessionDir, 'orphan_file'), 'orphan content')

    const { readdirSync } = await import('node:fs')
    const beforeClean = readdirSync(sessionDir)
    assert.ok(beforeClean.includes('orphan_file'))

    const removed = await history.cleanupOrphans()
    assert.ok(removed >= 1)

    const afterClean = readdirSync(sessionDir)
    assert.ok(!afterClean.includes('orphan_file'))
  })
})

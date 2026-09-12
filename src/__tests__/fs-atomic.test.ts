import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeFileAtomicAsync, writeFileAtomicSync, cleanupOrphanedTmpFiles } from '../fs-atomic.js'

describe('writeFileAtomicAsync (S13)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rivet-atomic-')) })
  afterEach(() => { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }) })

  it('writes data atomically and leaves no tmp file', async () => {
    const fp = join(dir, 'session.jsonl')
    await writeFileAtomicAsync(fp, 'line1\nline2\n')
    assert.equal(readFileSync(fp, 'utf-8'), 'line1\nline2\n')
    assert.equal(readdirSync(dir).filter(f => f.endsWith('.tmp')).length, 0)
  })
  it('overwrites existing file content', async () => {
    const fp = join(dir, 'session.jsonl')
    writeFileSync(fp, 'old')
    await writeFileAtomicAsync(fp, 'new')
    assert.equal(readFileSync(fp, 'utf-8'), 'new')
  })
  it('creates missing parent directory', async () => {
    const fp = join(dir, 'nested', 'deep', 'f.json')
    await writeFileAtomicAsync(fp, '{}')
    assert.equal(readFileSync(fp, 'utf-8'), '{}')
  })

  it('writes binary Buffer payloads without utf-8 corruption (sync)', () => {
    const fp = join(dir, 'session.jsonl')
    const payload = Buffer.from([0x00, 0xff, 0x28, 0xb5, 0x2f, 0xfd, 0x01, 0x02])
    writeFileAtomicSync(fp, payload)
    const readBack = readFileSync(fp)
    assert.ok(readBack.equals(payload), 'buffer bytes must roundtrip unchanged')
    assert.equal(readdirSync(dir).filter(f => f.endsWith('.tmp')).length, 0)
  })

  it('writes binary Buffer payloads without utf-8 corruption (async)', async () => {
    const fp = join(dir, 'session.jsonl')
    const payload = Buffer.from([0x00, 0xff, 0x28, 0xb5, 0x2f, 0xfd, 0x01, 0x02])
    await writeFileAtomicAsync(fp, payload)
    const readBack = readFileSync(fp)
    assert.ok(readBack.equals(payload), 'buffer bytes must roundtrip unchanged')
    assert.equal(readdirSync(dir).filter(f => f.endsWith('.tmp')).length, 0)
  })
})

// issue #125 — 清理正则原为 `<任意名>.<8位hex>.tmp`，与用户自己的临时文件同形，
// 受扫目录里 1h 以上的用户文件会被无条件删除（静默数据丢失）。
describe('cleanupOrphanedTmpFiles', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rivet-orphan-')) })
  afterEach(() => { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }) })

  function age(path: string): void {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000) // 2h，超过 1h TTL
    utimesSync(path, old, old)
  }

  it('reclaims only its own tmp files, never user files matching the old pattern', () => {
    const userA = join(dir, 'notes.deadbeef.tmp')
    const userB = join(dir, 'report.1a2b3c4d.tmp')
    const toolTmp = join(dir, 'session.jsonl.rivet-atomic-a1b2c3d4.tmp')
    writeFileSync(userA, 'user data')
    writeFileSync(userB, 'user data')
    writeFileSync(toolTmp, 'stale')
    age(userA); age(userB); age(toolTmp)

    const cleaned = cleanupOrphanedTmpFiles([dir])

    assert.equal(existsSync(userA), true, 'user file must survive cleanup')
    assert.equal(existsSync(userB), true, 'user file must survive cleanup')
    assert.equal(existsSync(toolTmp), false, 'own orphaned tmp must be reclaimed')
    assert.equal(cleaned, 1)
  })

  it('keeps fresh tmp files, whatever their name', () => {
    const fresh = join(dir, 'session.jsonl.rivet-atomic-b2c3d4e5.tmp')
    writeFileSync(fresh, 'in-flight')
    assert.equal(cleanupOrphanedTmpFiles([dir]), 0)
    assert.equal(existsSync(fresh), true)
  })
})

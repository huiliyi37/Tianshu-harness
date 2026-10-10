import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { evictOldSubagentResults } from '../coordinator.js'
import { isFilesystemMetadata } from '../../utils/file-metadata.js'

describe('evictOldSubagentResults', () => {
  it('LRU-evicts oldest .json files down to the limit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-subagents-'))
    try {
      // 5 files, mtime newest→oldest by index (file0 newest, file4 oldest)
      for (let i = 0; i < 5; i++) {
        const p = join(dir, `wo_${i}.json`)
        writeFileSync(p, '{}')
        const t = Date.now() / 1000 - i * 60
        utimesSync(p, t, t)
      }
      const evicted = evictOldSubagentResults(dir, 2)
      // keeps 2 newest (wo_0, wo_1), evicts the 3 oldest
      assert.deepEqual(evicted.sort(), ['wo_2.json', 'wo_3.json', 'wo_4.json'])
      const remaining = readdirSync(dir).filter(f => !isFilesystemMetadata(f)).sort()
      assert.deepEqual(remaining, ['wo_0.json', 'wo_1.json'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is a no-op when under the limit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-subagents-'))
    try {
      writeFileSync(join(dir, 'a.json'), '{}')
      assert.deepEqual(evictOldSubagentResults(dir, 10), [])
      assert.ok(existsSync(join(dir, 'a.json')))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns empty for a missing directory', () => {
    const base = mkdtempSync(join(tmpdir(), 'rivet-subagents-'))
    try {
      assert.deepEqual(evictOldSubagentResults(join(base, 'does-not-exist')), [])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('ignores non-json files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-subagents-'))
    try {
      mkdirSync(join(dir, 'sub'))
      writeFileSync(join(dir, 'keep.txt'), 'x')
      writeFileSync(join(dir, 'a.json'), '{}')
      writeFileSync(join(dir, 'b.json'), '{}')
      const t = Date.now() / 1000 - 100
      utimesSync(join(dir, 'a.json'), t, t)
      const evicted = evictOldSubagentResults(dir, 1)
      assert.deepEqual(evicted, ['a.json'])
      assert.ok(existsSync(join(dir, 'keep.txt')), 'non-json untouched')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

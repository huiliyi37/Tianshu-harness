import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendMemoryEntry, pruneMemoryStore, readMemoryEntries, supersedeMemoryEntry } from '../unified-memory.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const root = () => { const d = mkdtempSync(join(tmpdir(), 'rivet-prune-')); roots.push(d); return d }

describe('long-term memory prune（阶段6管理）', () => {
  it('keeps current entries, removes long-closed history beyond retention', () => {
    const cwd = root()
    const _old = appendMemoryEntry(cwd, {
      id: 'old-closed', text: '旧的 supersede 掉的规则', kind: 'project_rule',
      confidence: 0.9, source: 'manual', status: 'observed', tags: [],
      validTo: Date.now() - 200 * 86_400_000, // 封口 200 天前
    })!
    const _current = appendMemoryEntry(cwd, {
      id: 'current-rule', text: '当前仍有效的规则', kind: 'project_rule',
      confidence: 0.95, source: 'manual', status: 'observed', tags: [],
    })!
    // old-closed 被视为自建封口 → 直接退役；current 永不删
    const pruned = pruneMemoryStore(cwd, { retentionDays: 90 })
    assert.equal(pruned, 1)
    const entries = readMemoryEntries(cwd)
    assert.ok(entries.some(e => e.id === 'current-rule'))
    assert.ok(!entries.some(e => e.id === 'old-closed'))
  })

  it('respects a narrow retention window for recently-closed entries', () => {
    const cwd = root()
    appendMemoryEntry(cwd, {
      id: 'recent-closed', text: '最近才封口的条目', kind: 'finding',
      confidence: 0.8, source: 'manual', status: 'observed', tags: [],
      validTo: Date.now() - 10 * 86_400_000, // 封口 10 天前
    })
    // retention 90 天 → 10 天前不该退役
    assert.equal(pruneMemoryStore(cwd, { retentionDays: 90 }), 0)
    // 但 retention 3 天 → 10 天前应退役
    assert.equal(pruneMemoryStore(cwd, { retentionDays: 3 }), 1)
  })

  it('never deletes supersede-chain current leaves', () => {
    const cwd = root()
    const oldEntry = appendMemoryEntry(cwd, {
      id: 'superseded', text: '被取代的旧值', kind: 'project_rule',
      confidence: 0.9, source: 'manual', status: 'observed', tags: [],
    })!
    const newEntry = appendMemoryEntry(cwd, {
      id: 'replacement', text: '取代它的新值', kind: 'project_rule',
      confidence: 0.95, source: 'manual', status: 'observed', tags: [],
    })!
    supersedeMemoryEntry(cwd, oldEntry.id, newEntry.id)
    // oldEntry 现在 validTo=now，未超 retention → 不退役
    assert.equal(pruneMemoryStore(cwd, { retentionDays: 90 }), 0)
    // 极端 retention=0 → oldEntry（已封口）退役，replacement 保留
    assert.equal(pruneMemoryStore(cwd, { retentionDays: 0 }), 1)
    const entries = readMemoryEntries(cwd)
    assert.ok(entries.some(e => e.id === 'replacement'))
    assert.ok(!entries.some(e => e.id === 'superseded'))
  })
})

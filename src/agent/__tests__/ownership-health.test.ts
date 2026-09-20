import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeOwnershipHealth } from '../ownership-health.js'

describe('summarizeOwnershipHealth', () => {
  it('classifies dirty owned and dirty external files', () => {
    const report = summarizeOwnershipHealth({
      ownedFiles: ['src/a.ts', 'src/b.ts'],
      coOwnedFiles: [],
      externalFiles: ['.rivet/prefix-diag.jsonl'],
      dirtyFiles: ['src/a.ts', '.rivet/prefix-diag.jsonl'],
    })
    assert.deepEqual(report.untrackedDirtyOwned, ['src/a.ts'])
    assert.deepEqual(report.dirtyExternal, ['.rivet/prefix-diag.jsonl'])
    assert.deepEqual(report.cleanOwned, ['src/b.ts'])
  })

  it('warns for dirty files without ownership classification and lists them in pendingAdopt', () => {
    const report = summarizeOwnershipHealth({ ownedFiles: [], coOwnedFiles: [], externalFiles: [], dirtyFiles: ['src/unknown.ts', 'src/worker-new.ts'] })
    // T4：unclassified 升级为 pending-adopt 显式清单（文案带认领指引语义）
    assert.ok(report.warningLines.includes('Dirty file has no ownership classification (pending adopt): src/unknown.ts'))
    assert.deepEqual(report.pendingAdopt, ['src/unknown.ts', 'src/worker-new.ts'])
    // 已分类的 dirty 不进 pendingAdopt
    const classified = summarizeOwnershipHealth({
      ownedFiles: ['src/owned.ts'],
      coOwnedFiles: [],
      externalFiles: ['src/external.ts'],
      dirtyFiles: ['src/owned.ts', 'src/external.ts', 'src/unknown.ts'],
    })
    assert.deepEqual(classified.pendingAdopt, ['src/unknown.ts'])
  })

  it('reports external-only dirty files as informational caveats, not warnings', () => {
    const report = summarizeOwnershipHealth({ ownedFiles: [], coOwnedFiles: [], externalFiles: ['src/external.ts'], dirtyFiles: ['src/external.ts'] })
    assert.deepEqual(report.warningLines, [])
    assert.ok(report.infoLines.includes('No current owned dirty files. External dirty files are present and excluded from delivery scope.'))
  })

  it('reports co-owned files as informational caveats', () => {
    const report = summarizeOwnershipHealth({
      ownedFiles: ['src/owned.ts'],
      coOwnedFiles: ['src/shared.ts'],
      externalFiles: [],
      dirtyFiles: ['src/owned.ts', 'src/shared.ts'],
    })
    assert.deepEqual(report.untrackedDirtyOwned, ['src/owned.ts'])
    assert.deepEqual(report.dirtyCoOwned, ['src/shared.ts'])
    assert.deepEqual(report.warningLines, [])
    assert.ok(report.infoLines.some(line => line.includes('co-owned file(s) present')))
  })
})

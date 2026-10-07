import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createOwnershipLedger } from '../ownership-ledger.js'
import { createWorktreeBaseline, type BaselineSnapshot } from '../worktree-baseline.js'
import { createTaskLedger } from '../task-ledger.js'

const baselineSnap: BaselineSnapshot = {
  branch: 'feat/b1',
  head: 'abc123',
  preExistingDirty: ['src/external-dirty.ts'],
  preExistingUntracked: ['temp.log'],
  capturedAt: Date.now(),
}

describe('ownership-ledger — file ownership tracking', () => {
  it('registers and queries owned files', () => {
    const baseline = createWorktreeBaseline(baselineSnap)
    const ledger = createTaskLedger({ taskId: 't1' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

    ownership.registerOwned('src/tools/git.ts')
    ownership.registerOwned('src/tools/diff.ts')

    assert.equal(ownership.isOwned('src/tools/git.ts'), true)
    assert.equal(ownership.isOwned('src/tools/diff.ts'), true)
    assert.equal(ownership.isOwned('src/other.ts'), false)
  })

  it('exposes baseline.head as getBaselineHead (VSW commit-ish, not the structural hash)', () => {
    const baseline = createWorktreeBaseline(baselineSnap)
    const ledger = createTaskLedger({ taskId: 't1' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

    assert.equal(ownership.getBaselineHead(), 'abc123')
    // The VSW commit-ish must be the raw head, never the structural identity hash.
    assert.notEqual(ownership.getBaselineHead(), baseline.getBaselineHash())
  })

  it('pre-existing dirty files are NOT owned', () => {
    const baseline = createWorktreeBaseline(baselineSnap)
    const ledger = createTaskLedger({ taskId: 't1' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

    // Even if we try to register an external file, it's still external
    ownership.registerOwned('src/external-dirty.ts')
    assert.equal(ownership.isOwned('src/external-dirty.ts'), false)
  })

  it('pre-existing untracked files are NOT owned', () => {
    const baseline = createWorktreeBaseline(baselineSnap)
    const ledger = createTaskLedger({ taskId: 't1' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

    ownership.registerOwned('temp.log')
    assert.equal(ownership.isOwned('temp.log'), false)
  })

  it('getOwnedFiles returns only truly owned files', () => {
    const baseline = createWorktreeBaseline(baselineSnap)
    const ledger = createTaskLedger({ taskId: 't1' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

    ownership.registerOwned('src/tools/git.ts')
    ownership.registerOwned('src/tools/diff.ts')
    ownership.registerOwned('src/external-dirty.ts') // external, should be excluded

    const owned = ownership.getOwnedFiles()
    assert.deepEqual(owned, ['src/tools/diff.ts', 'src/tools/git.ts'])
  })

  it('getExternalFiles returns baseline external files', () => {
    const baseline = createWorktreeBaseline(baselineSnap)
    const ledger = createTaskLedger({ taskId: 't1' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

    const external = ownership.getExternalFiles()
    assert.deepEqual(external, ['src/external-dirty.ts', 'temp.log'])
  })

  // ── P1 living baseline: getExternalFiles(currentDirtyFiles) dynamic reclassification ──

  it('getExternalFiles(currentDirtyFiles) includes unclassified dirty file as dynamic external', () => {
    // Scenario: another session created src/new-session-file.ts after our baseline.
    // It's dirty but not owned, not co-owned, not in baseline external.
    // P1 lazy reclassification: it should appear in getExternalFiles.
    const baseline = createWorktreeBaseline(baselineSnap)
    const ledger = createTaskLedger({ taskId: 't1' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

    // owned: none registered, so src/new-session-file.ts is unclassified
    const result = ownership.getExternalFiles(['src/new-session-file.ts'])
    // baseline externals + dynamic external
    assert.ok(result.includes('src/external-dirty.ts'))
    assert.ok(result.includes('temp.log'))
    assert.ok(result.includes('src/new-session-file.ts'))
  })

  it('getExternalFiles(currentDirtyFiles) does NOT reclassify owned files as external', () => {
    // Owned files should stay owned, not leak into external set
    const baseline = createWorktreeBaseline(baselineSnap)
    const ledger = createTaskLedger({ taskId: 't1' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

    ownership.registerOwned('src/my-file.ts')
    const result = ownership.getExternalFiles(['src/my-file.ts'])
    // src/my-file.ts is owned → NOT in external
    assert.ok(!result.includes('src/my-file.ts'))
  })

  it('getExternalFiles(currentDirtyFiles) does NOT reclassify co-owned files as dynamic external', () => {
    // Co-owned files (external registered via registerOwned) appear in result from baseline,
    // but NOT from dynamic reclassification — the coOwnedSet guard prevents double-counting.
    const baseline = createWorktreeBaseline(baselineSnap)
    const ledger = createTaskLedger({ taskId: 't1' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

    ownership.registerOwned('src/external-dirty.ts') // baseline external → co-owned
    const result = ownership.getExternalFiles(['src/external-dirty.ts'])
    // Still present via baseline external set, just not duplicated via dynamic path
    assert.ok(result.includes('src/external-dirty.ts'))
    // Verify no duplication
    assert.equal(result.filter(f => f === 'src/external-dirty.ts').length, 1)
  })

  it('getExternalFiles(currentDirtyFiles) with empty array returns baseline only', () => {
    const baseline = createWorktreeBaseline(baselineSnap)
    const ledger = createTaskLedger({ taskId: 't1' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

    const result = ownership.getExternalFiles([])
    assert.deepEqual(result, ['src/external-dirty.ts', 'temp.log'])
  })

  it('getExternalFiles(undefined) backward compatible — returns baseline only', () => {
    const baseline = createWorktreeBaseline(baselineSnap)
    const ledger = createTaskLedger({ taskId: 't1' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

    const result = ownership.getExternalFiles()
    assert.deepEqual(result, ['src/external-dirty.ts', 'temp.log'])
  })

  it('getExternalFiles(currentDirtyFiles) with mix of owned and unowned files', () => {
    const baseline = createWorktreeBaseline({
      branch: 'feat/b1',
      head: 'abc123',
      preExistingDirty: [],
      preExistingUntracked: [],
      capturedAt: Date.now(),
    })
    const ledger = createTaskLedger({ taskId: 't1' })
    ledger.record({ type: 'file_write', path: 'src/owned.ts' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })
    ownership.autoOwnFromLedger()

    // src/owned.ts is owned, src/other-session.ts is unclassified
    const result = ownership.getExternalFiles(['src/owned.ts', 'src/other-session.ts'])
    assert.ok(!result.includes('src/owned.ts'), 'owned file must not leak into external')
    assert.ok(result.includes('src/other-session.ts'), 'unclassified file must be dynamic external')
  })

  it('isExternal delegates to baseline', () => {
    const baseline = createWorktreeBaseline(baselineSnap)
    const ledger = createTaskLedger({ taskId: 't1' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

    assert.equal(ownership.isExternal('src/external-dirty.ts'), true)
    assert.equal(ownership.isExternal('temp.log'), true)
    assert.equal(ownership.isExternal('src/my-file.ts'), false)
  })

  it('getOwnershipReport provides structured report', () => {
    const baseline = createWorktreeBaseline(baselineSnap)
    const ledger = createTaskLedger({ taskId: 't1' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

    ownership.registerOwned('src/tools/git.ts')
    ownership.registerOwned('src/tools/diff.ts')

    const report = ownership.getOwnershipReport()
    assert.equal(report.taskId, 't1')
    assert.deepEqual(report.ownedFiles, ['src/tools/diff.ts', 'src/tools/git.ts'])
    assert.equal(report.ownedFileCount, 2)
    assert.equal(report.externalFileCount, 2) // dirty + untracked
    assert.deepEqual(report.externalFiles, ['src/external-dirty.ts', 'temp.log'])
  })

  it('can scope a file list to only owned files', () => {
    const baseline = createWorktreeBaseline(baselineSnap)
    const ledger = createTaskLedger({ taskId: 't1' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

    ownership.registerOwned('src/tools/git.ts')
    ownership.registerOwned('src/tools/diff.ts')

    const scoped = ownership.scopeToOwned([
      'src/tools/git.ts',
      'src/tools/diff.ts',
      'src/external-dirty.ts',
      'src/unknown.ts',
    ])

    assert.deepEqual(scoped, ['src/tools/diff.ts', 'src/tools/git.ts'])
  })

  it('isOwned returns false for null/empty input', () => {
    const baseline = createWorktreeBaseline(baselineSnap)
    const ledger = createTaskLedger({ taskId: 't1' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

    assert.equal(ownership.isOwned(null), false)
    assert.equal(ownership.isOwned(''), false)
  })

  it('autoOwnFromLedger imports owned files from task ledger write events', () => {
    const baseline = createWorktreeBaseline({
      branch: 'main',
      head: 'abc',
      preExistingDirty: [],
      preExistingUntracked: [],
      capturedAt: Date.now(),
    })
    const ledger = createTaskLedger({ taskId: 't2' })
    ledger.record({ type: 'file_write', path: 'src/a.ts' })
    ledger.record({ type: 'file_write', path: 'src/b.ts' })
    ledger.record({ type: 'file_read', path: 'src/c.ts' }) // read, not write

    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })
    ownership.autoOwnFromLedger()

    assert.equal(ownership.isOwned('src/a.ts'), true)
    assert.equal(ownership.isOwned('src/b.ts'), true)
    assert.equal(ownership.isOwned('src/c.ts'), false) // read only
  })

  it('autoOwnFromLedger excludes external files even if written', () => {
    const baseline = createWorktreeBaseline({
      branch: 'main',
      head: 'abc',
      preExistingDirty: ['src/external.ts'],
      preExistingUntracked: [],
      capturedAt: Date.now(),
    })
    const ledger = createTaskLedger({ taskId: 't3' })
    ledger.record({ type: 'file_write', path: 'src/external.ts' })
    ledger.record({ type: 'file_write', path: 'src/owned.ts' })

    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })
    ownership.autoOwnFromLedger()

    assert.equal(ownership.isOwned('src/external.ts'), false)
    assert.equal(ownership.isOwned('src/owned.ts'), true)
  })

  // ── autoOwnFromBaseline ledger trace guard ──

  it('does not auto-own dirty file without ledger trace', () => {
    const baseline = createWorktreeBaseline({
      branch: 'main',
      head: 'abc',
      preExistingDirty: ['src/old.ts'],
      preExistingUntracked: [],
      capturedAt: Date.now(),
    })
    const ledger = createTaskLedger({ taskId: 'test' })
    // ledger has NO events for 'src/new-from-other.ts'
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })
    ownership.autoOwnFromLedger()
    ownership.autoOwnFromBaseline(['src/new-from-other.ts'])
    assert.equal(ownership.isOwned('src/new-from-other.ts'), false)
  })

  it('auto-owns dirty file that has a ledger file_write trace', () => {
    const baseline = createWorktreeBaseline({
      branch: 'main',
      head: 'abc',
      preExistingDirty: ['src/old.ts'],
      preExistingUntracked: [],
      capturedAt: Date.now(),
    })
    const ledger = createTaskLedger({ taskId: 'test' })
    ledger.record({ type: 'file_write', path: 'src/new-ours.ts' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })
    ownership.autoOwnFromLedger()
    ownership.autoOwnFromBaseline(['src/new-ours.ts'])
    assert.equal(ownership.isOwned('src/new-ours.ts'), true)
  })

  it('auto-owns dirty file that has a ledger git_action trace', () => {
    const baseline = createWorktreeBaseline({
      branch: 'main',
      head: 'abc',
      preExistingDirty: ['src/old.ts'],
      preExistingUntracked: [],
      capturedAt: Date.now(),
    })
    const ledger = createTaskLedger({ taskId: 'test' })
    ledger.record({ type: 'git_action', path: 'src/staged.ts' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })
    ownership.autoOwnFromLedger()
    ownership.autoOwnFromBaseline(['src/staged.ts'])
    assert.equal(ownership.isOwned('src/staged.ts'), true)
  })

  // ── adoptFiles — cross-session takeover ──

  describe('adoptFiles — cross-session takeover', () => {
    it('adopts external files into owned set', () => {
      const baseline = createWorktreeBaseline({
        branch: 'main',
        head: 'abc',
        preExistingDirty: ['src/other-session-a.ts', 'src/other-session-b.ts'],
        preExistingUntracked: [],
        capturedAt: Date.now(),
      })
      const ledger = createTaskLedger({ taskId: 'takeover' })
      const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

      // Before: these are external
      assert.equal(ownership.isOwned('src/other-session-a.ts'), false)
      assert.equal(ownership.isOwned('src/other-session-b.ts'), false)

      const adopted = ownership.adoptFiles(['src/other-session-a.ts', 'src/other-session-b.ts'])

      assert.deepEqual(adopted, ['src/other-session-a.ts', 'src/other-session-b.ts'])
      assert.equal(ownership.isOwned('src/other-session-a.ts'), true)
      assert.equal(ownership.isOwned('src/other-session-b.ts'), true)
      assert.deepEqual(ownership.getOwnedFiles(), ['src/other-session-a.ts', 'src/other-session-b.ts'])
    })

    it('returns only newly adopted files (skips already-owned)', () => {
      const baseline = createWorktreeBaseline({
        branch: 'main',
        head: 'abc',
        preExistingDirty: ['src/external.ts'],
        preExistingUntracked: [],
        capturedAt: Date.now(),
      })
      const ledger = createTaskLedger({ taskId: 'takeover' })
      ledger.record({ type: 'file_write', path: 'src/already-mine.ts' })
      const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })
      ownership.autoOwnFromLedger()

      const adopted = ownership.adoptFiles(['src/external.ts', 'src/already-mine.ts'])

      // Only the external file was newly adopted
      assert.deepEqual(adopted, ['src/external.ts'])
      assert.equal(ownership.isOwned('src/external.ts'), true)
      assert.equal(ownership.isOwned('src/already-mine.ts'), true)
    })

    it('returns empty array when all files are already owned', () => {
      const baseline = createWorktreeBaseline(baselineSnap)
      const ledger = createTaskLedger({ taskId: 'takeover' })
      const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })
      ownership.registerOwned('src/mine.ts')

      const adopted = ownership.adoptFiles(['src/mine.ts'])

      assert.deepEqual(adopted, [])
    })

    it('returns empty array for empty input', () => {
      const baseline = createWorktreeBaseline(baselineSnap)
      const ledger = createTaskLedger({ taskId: 'takeover' })
      const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

      const adopted = ownership.adoptFiles([])

      assert.deepEqual(adopted, [])
    })

    // ── co-owned → adopted migration ──
    // co-owned files (pre-existing baseline files modified by current task)
    // should be adoptable when the other session is done/crashed.

    it('migrates co-owned files to adopted set', () => {
      const baseline = createWorktreeBaseline(baselineSnap)
      const ledger = createTaskLedger({ taskId: 'takeover' })
      const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

      // Register an external file → becomes co-owned
      ownership.registerOwned('src/external-dirty.ts')
      // Verify it's co-owned, not owned
      assert.equal(ownership.isCoOwned('src/external-dirty.ts'), true)
      assert.equal(ownership.isOwned('src/external-dirty.ts'), false)

      // Adopt the co-owned file
      const adopted = ownership.adoptFiles(['src/external-dirty.ts'])
      assert.deepEqual(adopted, ['src/external-dirty.ts'],
        'co-owned file should be adoptable')

      // After adoption: it should be owned, not co-owned
      assert.equal(ownership.isOwned('src/external-dirty.ts'), true,
        'adopted co-owned file must be owned')
      assert.equal(ownership.isCoOwned('src/external-dirty.ts'), false,
        'adopted co-owned file must leave co-owned set')

      // Should appear in getOwnedFiles
      const owned = ownership.getOwnedFiles()
      assert.ok(owned.includes('src/external-dirty.ts'),
        'adopted file must appear in owned files list')
    })

    it('co-owned → adopted is idempotent on second call', () => {
      const baseline = createWorktreeBaseline(baselineSnap)
      const ledger = createTaskLedger({ taskId: 'takeover' })
      const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

      ownership.registerOwned('src/external-dirty.ts')

      // First adoption
      const first = ownership.adoptFiles(['src/external-dirty.ts'])
      assert.deepEqual(first, ['src/external-dirty.ts'])

      // Second adoption — should be no-op (already in adoptedSet)
      const second = ownership.adoptFiles(['src/external-dirty.ts'])
      assert.deepEqual(second, [],
        'second adoption of same file should be empty')

      // Still owned
      assert.equal(ownership.isOwned('src/external-dirty.ts'), true)
      // Still not co-owned
      assert.equal(ownership.isCoOwned('src/external-dirty.ts'), false)
    })

    it('adoptFiles does not duplicate files already in owned set', () => {
      const baseline = createWorktreeBaseline({
        branch: 'main',
        head: 'abc',
        preExistingDirty: [],
        preExistingUntracked: [],
        capturedAt: Date.now(),
      })
      const ledger = createTaskLedger({ taskId: 'takeover' })
      const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

      // Register an owned file (not external → straight to ownedSet)
      ownership.registerOwned('src/my-file.ts')
      assert.equal(ownership.isOwned('src/my-file.ts'), true)

      // Adopt it — should be skipped
      const adopted = ownership.adoptFiles(['src/my-file.ts'])
      assert.deepEqual(adopted, [], 'already-owned file should not be re-adopted')
      assert.equal(ownership.isOwned('src/my-file.ts'), true)
    })

    it('migrates multiple co-owned files in one call', () => {
      const baseline = createWorktreeBaseline({
        branch: 'main',
        head: 'abc',
        preExistingDirty: ['ext-a.ts', 'ext-b.ts', 'ext-c.ts'],
        preExistingUntracked: [],
        capturedAt: Date.now(),
      })
      const ledger = createTaskLedger({ taskId: 'takeover' })
      const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

      ownership.registerOwned('ext-a.ts')
      ownership.registerOwned('ext-b.ts')
      // ext-c.ts is pure external (not co-owned)

      const adopted = ownership.adoptFiles(['ext-a.ts', 'ext-b.ts', 'ext-c.ts'])
      assert.deepEqual(adopted.sort(), ['ext-a.ts', 'ext-b.ts', 'ext-c.ts'].sort())

      // All three should now be owned
      assert.equal(ownership.isOwned('ext-a.ts'), true)
      assert.equal(ownership.isOwned('ext-b.ts'), true)
      assert.equal(ownership.isOwned('ext-c.ts'), true)

      // Co-owned should be empty
      assert.equal(ownership.isCoOwned('ext-a.ts'), false)
      assert.equal(ownership.isCoOwned('ext-b.ts'), false)
    })
  })
})

describe('unregisterOwned — 草稿/瞬态产物的对称清理（8784b64b8 审查 P1）', () => {
  const make = () => {
    const baseline = createWorktreeBaseline(baselineSnap)
    const ledger = createTaskLedger({ taskId: 't1' })
    return createOwnershipLedger({ baseline, taskLedger: ledger })
  }

  it('从 owned 集合删除（plan draft 释放路径的对称操作）', () => {
    const ownership = make()
    ownership.registerOwned('src/owned.ts')
    assert.equal(ownership.isOwned('src/owned.ts'), true)

    ownership.unregisterOwned('src/owned.ts')

    assert.equal(ownership.isOwned('src/owned.ts'), false)
    assert.equal(ownership.getOwnedFiles().includes('src/owned.ts'), false)
  })

  it('覆盖 co-owned 与 adopted 集合（跨会话认领后撤销）', () => {
    const ownership = make()
    // baselineSnap 的 preExistingDirty 成员 → registerOwned 会落进 co-owned 集合
    ownership.registerOwned('src/external-dirty.ts')
    assert.equal(ownership.isCoOwned('src/external-dirty.ts'), true)

    ownership.unregisterOwned('src/external-dirty.ts')
    assert.equal(ownership.isCoOwned('src/external-dirty.ts'), false)
    assert.equal(ownership.isOwned('src/external-dirty.ts'), false)

    // adopted 集合：adoptFiles 迁移后的条目同样要被 unregisterOwned 清掉
    ownership.registerOwned('src/external-dirty.ts')
    ownership.adoptFiles(['src/external-dirty.ts'])
    assert.equal(ownership.isOwned('src/external-dirty.ts'), true, 'adopted 条目按 isOwned 语义可见')

    ownership.unregisterOwned('src/external-dirty.ts')
    assert.equal(ownership.isOwned('src/external-dirty.ts'), false, 'unregisterOwned 必须覆盖 adopted 集合')
  })

  it('对未注册路径幂等（不抛错）', () => {
    const ownership = make()
    ownership.unregisterOwned('never-registered.ts')
    assert.equal(ownership.isOwned('never-registered.ts'), false)
  })
})

describe('incomplete baseline handling (issue #369 — non-git workspace)', () => {
  it('correctly reports isBaselineComplete as false and owns explicitly written files', () => {
    const baseline = createWorktreeBaseline({
      branch: '',
      head: '',
      preExistingDirty: [],
      preExistingUntracked: [],
      capturedAt: Date.now(),
      complete: false,
    })
    const ledger = createTaskLedger({ taskId: 'non-git-task' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

    assert.equal(ownership.isBaselineComplete?.(), false)

    // In an incomplete baseline, baseline.isExternal() returns true for all paths,
    // but registerOwned should NOT treat session writes as co-owned.
    ownership.registerOwned('src/new-work.ts')
    assert.equal(ownership.isOwned('src/new-work.ts'), true)
    assert.equal(ownership.isCoOwned('src/new-work.ts'), false)
    assert.deepEqual(ownership.getOwnedFiles(), ['src/new-work.ts'])
    assert.deepEqual(ownership.getCoOwnedFiles(), [])
  })

  it('autoOwnFromBaseline does not skip ledger-recorded files when baseline is incomplete', () => {
    const baseline = createWorktreeBaseline({
      branch: '',
      head: '',
      preExistingDirty: [],
      preExistingUntracked: [],
      capturedAt: Date.now(),
      complete: false,
    })
    const ledger = createTaskLedger({ taskId: 'non-git-task' })
    ledger.record({ type: 'file_write', path: 'src/written.ts' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

    ownership.autoOwnFromBaseline(['src/written.ts'])
    assert.equal(ownership.isOwned('src/written.ts'), true)
    assert.deepEqual(ownership.getOwnedFiles(), ['src/written.ts'])
  })
})


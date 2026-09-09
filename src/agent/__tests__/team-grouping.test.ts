import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { groupTeamTasks, validateTaskDependencies, MAX_WRITE_WORKERS, MAX_READ_WORKERS } from '../team-grouping.js'
import type { TeamTask } from '../team-plan.js'

function task(
  id: string,
  files: string[],
  opts?: Partial<Pick<TeamTask, 'profile' | 'kind' | 'dependsOn' | 'riskTier'>>,
): TeamTask {
  return {
    id,
    title: id,
    objective: `Implement ${id}`,
    files,
    profile: opts?.profile ?? 'patcher',
    kind: opts?.kind ?? 'patch_proposal',
    verification: [],
    dependsOn: opts?.dependsOn ?? [],
    riskTier: opts?.riskTier ?? 'low',
    touchSet: [...files],
  }
}

describe('groupTeamTasks', () => {
  it('returns empty waves for empty input', () => {
    assert.deepEqual(groupTeamTasks([]), [])
  })

  it('puts disjoint-file write tasks in the same wave', () => {
    const waves = groupTeamTasks([
      task('T1', ['src/a.ts']),
      task('T2', ['src/b.ts']),
    ])

    // Both should be in one wave since files are disjoint
    assert.equal(waves.length, 1)
    assert.deepEqual(waves[0]!.taskIds.sort(), ['T1', 'T2'])
    assert.equal(waves[0]!.parallelLimit, 2)
  })

  it('serializes same-file write tasks into separate waves', () => {
    const waves = groupTeamTasks([
      task('T1', ['src/a.ts']),
      task('T2', ['src/a.ts']),
    ])

    assert.equal(waves.length, 2)
    assert.deepEqual(waves[0]!.taskIds, ['T1'])
    assert.deepEqual(waves[1]!.taskIds, ['T2'])
    assert.equal(waves[0]!.parallelLimit, 1)
  })

  it('respects dependency ordering', () => {
    const waves = groupTeamTasks([
      task('T2', ['src/b.ts'], { dependsOn: ['T1'] }),
      task('T1', ['src/a.ts']),
    ])

    // T1 must be in an earlier wave than T2
    const t1Wave = waves.findIndex(w => w.taskIds.includes('T1'))
    const t2Wave = waves.findIndex(w => w.taskIds.includes('T2'))
    assert.ok(t1Wave < t2Wave, `T1 wave (${t1Wave}) should be before T2 wave (${t2Wave})`)
  })

  it('allows read-only tasks to parallel with write tasks on same files', () => {
    const waves = groupTeamTasks([
      task('T1', ['src/a.ts']),
      task('T2', ['src/a.ts'], { profile: 'code_scout', kind: 'code_search' }),
    ])

    // Reviewer can run in parallel with patcher
    assert.equal(waves.length, 1)
    assert.deepEqual(waves[0]!.taskIds.sort(), ['T1', 'T2'])
  })

  it('caps write workers per wave', () => {
    // Create 4 disjoint write tasks — should be capped
    const waves = groupTeamTasks([
      task('T1', ['src/a.ts']),
      task('T2', ['src/b.ts']),
      task('T3', ['src/c.ts']),
      task('T4', ['src/d.ts']),
    ], { maxWriteWorkers: 2 })

    const writeCount = (wave: typeof waves[0]) =>
      wave.taskIds.filter(id => {
        // All are patchers in this test
        return true
      }).length

    for (const wave of waves) {
      assert.ok(
        writeCount(wave) <= 2,
        `Wave ${wave.id} has ${writeCount(wave)} write tasks, expected ≤ 2`,
      )
    }
  })

  it('binds source+test file pairs into one task', () => {
    const waves = groupTeamTasks([
      task('T1', ['src/agent/foo.ts']),
      task('T2', ['src/agent/__tests__/foo.test.ts']),
    ])

    // T2 should be merged into T1
    assert.equal(waves.length, 1)
    // Either T1 is alone (T2 merged in) or both in one wave
    const wave = waves[0]!
    assert.ok(wave.taskIds.includes('T1'))
  })

  it('classifies wave risk as high if any task is high risk', () => {
    const waves = groupTeamTasks([
      task('T1', ['src/auth.ts'], { riskTier: 'high' }),
      task('T2', ['src/util.ts']),
    ])

    assert.equal(waves[0]!.risk, 'high')
  })

  it('handles three-tier dependency chain', () => {
    const waves = groupTeamTasks([
      task('T3', ['src/c.ts'], { dependsOn: ['T2'] }),
      task('T2', ['src/b.ts'], { dependsOn: ['T1'] }),
      task('T1', ['src/a.ts']),
    ])

    const t1w = waves.findIndex(w => w.taskIds.includes('T1'))
    const t2w = waves.findIndex(w => w.taskIds.includes('T2'))
    const t3w = waves.findIndex(w => w.taskIds.includes('T3'))
    assert.ok(t1w < t2w, 'T1 before T2')
    assert.ok(t2w < t3w, 'T2 before T3')
  })

  it('serializes partial file overlap (T1=[a,b], T2=[b,c])', () => {
    const waves = groupTeamTasks([
      task('T1', ['src/a.ts', 'src/b.ts']),
      task('T2', ['src/b.ts', 'src/c.ts']),
    ])

    // Must be in separate waves due to b.ts overlap
    assert.equal(waves.length, 2)
    assert.ok(!waves[0]!.taskIds.includes('T2') || !waves[1]!.taskIds.includes('T1'))
  })

  it('defaults to MAX_WRITE_WORKERS=3 and MAX_READ_WORKERS=3', () => {
    assert.equal(MAX_WRITE_WORKERS, 3)
    assert.equal(MAX_READ_WORKERS, 3)
  })

  it('names the cycle in the forced wave reason instead of a generic message', () => {
    // Regression: A→B→A used to force through as "circular dependency or
    // unresolvable" with no indication of WHICH tasks formed the loop.
    const waves = groupTeamTasks([
      task('T1', ['src/a.ts'], { dependsOn: ['T2'] }),
      task('T2', ['src/b.ts'], { dependsOn: ['T1'] }),
    ])
    const forced = waves.find(w => w.reason.startsWith('forced:'))
    assert.ok(forced, 'expected a forced wave for the cycle')
    assert.match(forced!.reason, /cycle/)
    assert.ok(/T1/.test(forced!.reason) && /T2/.test(forced!.reason))
    // No task is lost.
    assert.deepEqual(waves.flatMap(w => w.taskIds).sort(), ['T1', 'T2'])
  })

  it('surfaces dangling deps in wave reason and raises risk', () => {
    // Regression: a typo'd dep (T9 does not exist) used to be silently treated
    // as satisfied, dispatching T1 with no signal.
    const waves = groupTeamTasks([task('T1', ['src/a.ts'], { dependsOn: ['T9'] })])
    assert.equal(waves.length, 1)
    assert.match(waves[0]!.reason, /unknown dep/)
    assert.ok(waves[0]!.reason.includes('T9'))
    assert.equal(waves[0]!.risk, 'medium')
  })

  it('does NOT merge tasks with empty scope as source+test pairs (vacuum-truth T5 fix)', () => {
    // Regression: when both tasks have empty files/touchSet, [].every(fn)
    // returns true (vacuum truth), causing bindSourceTestPairs to incorrectly
    // merge unrelated tasks — collapsing 7 independent tasks into ~3-4.
    // T5 fix (2026-07-29): empty scope tasks are never source-test pairs.
    const waves = groupTeamTasks([
      task('T1', []),
      task('T2', []),
      task('T3', []),
      task('T4', []),
      task('T5', []),
      task('T6', []),
      task('T7', []),
    ])

    // All 7 tasks should survive — no vacuum-truth merging.
    // Empty-scope tasks are disjoint by definition, so they can cohabit
    // in waves up to MAX_WRITE_WORKERS=3. 7 tasks → 3 waves (3+3+1).
    const allIds = waves.flatMap(w => w.taskIds).sort()
    assert.deepEqual(allIds, ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'])
    assert.equal(waves.length, 3, '7 empty-scope tasks should span 3 waves (capped at maxWrite=3)')
  })
})

describe('validateTaskDependencies', () => {
  it('reports dangling deps pointing to non-existent tasks', () => {
    const diag = validateTaskDependencies([
      task('T1', ['src/a.ts'], { dependsOn: ['T2', 'T9'] }),
      task('T2', ['src/b.ts']),
    ])
    assert.deepEqual(diag.dangling, [{ taskId: 'T1', missingDep: 'T9' }])
    assert.deepEqual(diag.cycles, [])
  })

  it('detects a dependency cycle and returns the loop members', () => {
    const diag = validateTaskDependencies([
      task('T1', ['src/a.ts'], { dependsOn: ['T2'] }),
      task('T2', ['src/b.ts'], { dependsOn: ['T1'] }),
    ])
    assert.equal(diag.cycles.length, 1)
    assert.deepEqual([...diag.cycles[0]!].sort(), ['T1', 'T2'])
  })

  it('returns clean diagnostics for a valid acyclic graph', () => {
    const diag = validateTaskDependencies([
      task('T1', ['src/a.ts']),
      task('T2', ['src/b.ts'], { dependsOn: ['T1'] }),
    ])
    assert.deepEqual(diag.dangling, [])
    assert.deepEqual(diag.cycles, [])
  })
})

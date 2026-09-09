/**
 * Track 2: team max 计划骨架缓存。
 *
 * 契约：
 * - save → 同 objective load 命中（exact hash）
 * - 关键词高重叠的近似 objective 也命中（≥0.6）
 * - 过期 / mode 不匹配 / 结构损坏 → miss
 * - runTeamSkeleton(max) 命中缓存 → 不再发 planner fanout，planCacheHit=true
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  hashPlanObjective,
  loadTeamPlanSkeleton,
  saveTeamPlanSkeleton,
  teamPlanCacheKind,
  TEAM_PLAN_CACHE_PREFIX,
  type TeamPlanCacheStore,
} from '../team-plan-cache.js'
import { runTeamSkeleton } from '../team-orchestrator.js'
import type { CoordinatorRun, DelegationRequest } from '../coordinator.js'
import type { TeamTask } from '../team-plan.js'
import type { WorkerResult } from '../work-order.js'

function memStore(): TeamPlanCacheStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>()
  return {
    rows,
    saveBanditState: (kind, json) => { rows.set(kind, json) },
    loadBanditStatesByPrefix: (prefix, limit = 100) =>
      [...rows.entries()]
        .filter(([kind]) => kind.startsWith(prefix))
        .slice(0, limit)
        .map(([kind, json]) => ({ kind, json })),
  }
}

function task(id: string, over: Partial<TeamTask> = {}): TeamTask {
  return {
    id,
    title: `Task ${id}`,
    objective: `implement ${id} for the compaction threshold module`,
    files: [`src/${id}.ts`],
    profile: 'patcher',
    kind: 'patch_proposal',
    verification: ['npm test'],
    dependsOn: [],
    riskTier: 'low',
    touchSet: [`src/${id}.ts`],
    ...over,
  }
}

describe('team plan cache (Track 2)', () => {
  it('round-trips a skeleton by exact objective hash', () => {
    const store = memStore()
    const objective = 'refactor the compaction thresholds and unify the ratio gates'
    saveTeamPlanSkeleton(store, { objective, mode: 'max', tasks: [task('t1'), task('t2')] })
    assert.ok(store.rows.has(teamPlanCacheKind(hashPlanObjective(objective))))

    const hit = loadTeamPlanSkeleton(store, objective, 'max')
    assert.ok(hit, 'exact objective should hit')
    assert.equal(hit.tasks.length, 2)
    assert.equal(hit.tasks[0]!.id, 't1')
  })

  it('hits on a similar objective via keyword overlap', () => {
    const store = memStore()
    saveTeamPlanSkeleton(store, {
      objective: 'refactor compaction thresholds unify ratio gates cleanup',
      mode: 'max',
      tasks: [task('t1')],
    })
    const hit = loadTeamPlanSkeleton(store, 'refactor compaction thresholds unify ratio gates now', 'max')
    assert.ok(hit, 'high-overlap objective should hit')
  })

  it('misses on expiry, mode mismatch, and corrupt rows', () => {
    const store = memStore()
    const objective = 'migrate the provider registry to the new preset schema'
    saveTeamPlanSkeleton(store, { objective, mode: 'max', tasks: [task('t1')], timestamp: 1_000 })

    assert.equal(
      loadTeamPlanSkeleton(store, objective, 'max', { now: 1_000 + 25 * 60 * 60 * 1000 }),
      null,
      'expired after 24h',
    )
    assert.equal(loadTeamPlanSkeleton(store, objective, 'standard'), null, 'mode mismatch')

    store.rows.set(`${TEAM_PLAN_CACHE_PREFIX}deadbeef`, '{not json')
    assert.equal(loadTeamPlanSkeleton(store, 'totally unrelated objective text here', 'max'), null)
  })

  it('does not save empty task lists and tolerates a missing store', () => {
    const store = memStore()
    saveTeamPlanSkeleton(store, { objective: 'anything at all here', mode: 'max', tasks: [] })
    assert.equal(store.rows.size, 0)
    assert.equal(loadTeamPlanSkeleton(undefined, 'anything at all here', 'max'), null)
    saveTeamPlanSkeleton(undefined, { objective: 'x y z', mode: 'max', tasks: [task('t1')] })
  })
})

// ── runTeamSkeleton(max) integration: cache hit skips planner fanout ──

function passedResult(id: string): WorkerResult {
  return {
    workOrderId: id, status: 'passed', summary: `completed ${id}`, findings: [],
    artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'verified',
  }
}

function runFor(requests: DelegationRequest[]): CoordinatorRun {
  return {
    status: 'completed',
    results: requests.map(r => passedResult(
      /\bteam:/.test(r.parentTurnId) ? r.parentTurnId.split(':').slice(-2).join(':') : r.parentTurnId,
    )),
    packet: `${requests.length} workers done`,
  }
}

describe('runTeamSkeleton max-mode plan cache integration', () => {
  it('cache hit skips the 3-perspective planner fanout', async () => {
    const store = memStore()
    const objective = 'implement the unified delivery gate across coordinator and loop'
    saveTeamPlanSkeleton(store, { objective, mode: 'max', tasks: [task('t1'), task('t2')] })

    const batches: DelegationRequest[][] = []
    const summary = await runTeamSkeleton(
      { mode: 'max', objective },
      {
        delegateBatch: async (requests) => {
          batches.push(requests)
          return runFor(requests)
        },
        planCacheStore: store,
      },
    )

    assert.equal(summary.planCacheHit, true)
    const plannerBatches = batches.filter(b => b.some(r => r.parentTurnId.includes('planner-')))
    assert.equal(plannerBatches.length, 0, 'no planner fanout on cache hit')
    assert.ok(summary.waves.length > 0, 'cached tasks still produce waves')
  })

  it('cache miss runs the planner fanout and saves the merged skeleton', async () => {
    const store = memStore()
    const objective = 'rebuild the ansi renderer batching pipeline end to end'

    const batches: DelegationRequest[][] = []
    const summary = await runTeamSkeleton(
      { mode: 'max', objective },
      {
        delegateBatch: async (requests) => {
          batches.push(requests)
          if (requests.some(r => r.parentTurnId.includes('planner-'))) {
            // Planner returns a parseable perspective-plan artifact
            const plan = JSON.stringify({
              tasks: [{
                id: 't1', title: 'T1', objective: 'patch the renderer batching pipeline', files: ['src/a.ts'],
                profile: 'patcher', kind: 'patch_proposal', verification: ['npm test'],
                dependsOn: [], riskTier: 'low', touchSet: ['src/a.ts'],
              }],
            })
            const results = requests.map(r => ({
              ...passedResult(r.parentTurnId),
              artifacts: [{ kind: 'note' as const, title: 'perspective-plan', content: plan }],
            }))
            return { status: 'completed', results, packet: 'planners done' }
          }
          return runFor(requests)
        },
        planCacheStore: store,
      },
    )

    assert.notEqual(summary.planCacheHit, true)
    const plannerBatches = batches.filter(b => b.some(r => r.parentTurnId.includes('planner-')))
    assert.equal(plannerBatches.length, 1, 'planner fanout ran exactly once')
    if (summary.tasks.length > 0) {
      assert.ok(
        loadTeamPlanSkeleton(store, objective, 'max'),
        'merged skeleton saved for the next run',
      )
    }
  })
})

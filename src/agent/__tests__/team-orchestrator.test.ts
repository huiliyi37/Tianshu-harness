import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { CoordinatorRun, DelegationRequest } from '../coordinator.js'
import {
  runTeamSkeleton,
  selectDispatchableTeamTasks,
  teamTasksToDelegationRequests,
  extractTaskIdFromWorkOrderId,
} from '../team-orchestrator.js'
import type { TeamRunSummary } from '../team-orchestrator.js'
import type { TeamTaskDraft } from '../team-plan.js'

function task(id: string, files: string[], profile: TeamTaskDraft['profile'] = 'patcher'): TeamTaskDraft {
  return {
    id,
    title: id,
    objective: `Implement ${id}`,
    files,
    profile,
    kind: profile === 'patcher' ? 'patch_proposal' : 'review',
    verification: [],
  }
}

function run(packet = 'packet'): CoordinatorRun {
  return { status: 'completed', results: [], packet }
}

describe('team orchestrator skeleton', () => {
  it('selects scoped patcher tasks and blocks ambiguous or overlapping ones', () => {
    const { selected, blocked } = selectDispatchableTeamTasks([
      task('T1', ['src/a.ts']),
      task('T2', []),
      task('T3', ['src/a.ts']),
      task('T4', ['src/b.ts']),
    ], 3)

    assert.deepEqual(selected.map(t => t.id), ['T1', 'T4'])
    assert.deepEqual(blocked, [
      'T2: patcher task has no file scope',
      'T3: overlapping patcher file scope with T1; serialize later',
    ])
  })

  it('blocks patchers with PARTIAL file overlap, not just identical sets', () => {
    const { selected, blocked } = selectDispatchableTeamTasks([
      task('T1', ['src/a.ts', 'src/b.ts']),
      task('T2', ['src/b.ts', 'src/c.ts']),
      task('T3', ['src/d.ts']),
    ], 3)

    assert.deepEqual(selected.map(t => t.id), ['T1', 'T3'])
    assert.deepEqual(blocked, [
      'T2: overlapping patcher file scope with T1; serialize later',
    ])
  })

  it('does not treat read-only workers as file-conflicting even on shared files', () => {
    const { selected, blocked } = selectDispatchableTeamTasks([
      task('T1', ['src/a.ts']),
      task('T2', ['src/a.ts'], 'reviewer'),
    ], 3)

    assert.deepEqual(selected.map(t => t.id), ['T1', 'T2'])
    assert.deepEqual(blocked, [])
  })

  it('maps patcher tasks to 天梁 execution objectives', () => {
    const [request] = teamTasksToDelegationRequests([task('T1', ['src/a.ts'])], 'parent')

    assert.equal(request!.parentTurnId, 'parent:team:T1')
    assert.equal(request!.kind, 'patch_proposal')
    assert.equal(request!.profile, 'patcher')
    assert.deepEqual(request!.scope.files, ['src/a.ts'])
    assert.ok(request!.objective.includes('你是天梁执行者'))
    assert.ok(request!.objective.includes('只执行本 task'))
  })

  it('onPlanReady 在 dispatch 之前触发，携带 waves/tasks 且无 run', async () => {
    const order: string[] = []
    let planReady: { summary: TeamRunSummary; wave: number } | null = null
    await runTeamSkeleton({
      mode: 'standard',
      objective: 'execute plan',
      parentTurnId: 'turn-1',
      planMarkdown: `
### Task 1: Parser
修改 src/agent/team-plan.ts

### Task 2: Orchestrator
修改 src/agent/team-orchestrator.ts
`,
      onPlanReady: (s, w) => { order.push('plan'); planReady = { summary: s, wave: w } },
    }, {
      delegateBatch: async () => { order.push('dispatch'); return run('delegated') },
    })
    assert.deepEqual(order, ['plan', 'dispatch'], 'onPlanReady 必须先于 delegateBatch')
    assert.ok(planReady, 'onPlanReady 应被调用')
    const pr = planReady as unknown as { summary: TeamRunSummary; wave: number }
    assert.equal(pr.wave, 0)
    assert.ok(pr.summary.waves.length > 0, '计划骨架应含 waves')
    assert.ok(pr.summary.tasks.length > 0, '计划骨架应含 tasks')
    assert.equal(pr.summary.run, undefined, '骨架阶段尚无 run')
  })

  it('dispatches parsed standard plan tasks through delegateBatch', async () => {
    let captured: DelegationRequest[] = []
    const summary = await runTeamSkeleton({
      mode: 'standard',
      objective: 'execute plan',
      parentTurnId: 'turn-1',
      planMarkdown: `
### Task 1: Parser
修改 src/agent/team-plan.ts

### Task 2: Orchestrator
修改 src/agent/team-orchestrator.ts
`,
    }, {
      delegateBatch: async (requests, policy) => {
        captured = requests
        assert.equal(policy, 'all_required')
        return run('delegated')
      },
    })

    assert.equal(summary.dispatched, 2)
    assert.match(summary.packet, /delegated/)
    assert.deepEqual(captured.map(r => r.scope.files), [
      ['src/agent/team-plan.ts'],
      ['src/agent/team-orchestrator.ts'],
    ])
  })

  it('max mode fans out 3 perspective planners then dispatches merged waves', async () => {
    const calls: DelegationRequest[][] = []
    const summary = await runTeamSkeleton({ mode: 'max', objective: 'design the subsystem from scratch' }, {
      delegateBatch: async (requests) => {
        calls.push(requests)
        const isPlannerBatch = requests.some(r => r.parentTurnId.includes('planner-'))
        if (isPlannerBatch) {
          const plan = {
            perspective: 'tianquan',
            tasks: [{
              id: 'T1',
              title: 'impl',
              objective: 'impl',
              files: ['src/x.ts'],
              profile: 'patcher',
              kind: 'patch_proposal',
              verification: [],
              dependsOn: [],
              riskTier: 'low',
              touchSet: ['src/x.ts'],
            }],
          }
          return {
            status: 'completed',
            packet: 'planned',
            results: requests.map(r => ({
              workOrderId: r.parentTurnId.includes('tianquan') ? 'team:planner-tianquan'
                : r.parentTurnId.includes('tianfu') ? 'team:planner-tianfu' : 'team:planner-tianxuan',
              status: 'passed' as const,
              summary: 'p',
              findings: [],
              artifacts: r.parentTurnId.includes('tianquan') ? [{ kind: 'note' as const, title: 'perspective-plan', content: JSON.stringify(plan) }] : [],
              changedFiles: [],
              risks: [],
              nextActions: [],
              evidenceStatus: 'verified' as const,
            })),
          }
        }
        return { status: 'completed', results: [], packet: 'executed' }
      },
    })

    assert.equal(calls.length, 2)
    assert.ok(calls[0]!.some(r => r.parentTurnId.includes('planner-tianquan')))
    assert.ok(summary.dispatched >= 1)
    assert.equal(summary.tasks.length, 1)
  })

  it('max mode settles planner fanout through the per-worker callback', async () => {
    const settled: string[] = []
    const summary = await runTeamSkeleton({
      mode: 'max',
      objective: 'settle every planner activity before execution starts',
      onWorkerSettled: result => settled.push(result.workOrderId),
    }, {
      delegateBatch: async (requests, _policy, _signal, _progress, onWorkerSettled) => {
        const isPlannerBatch = requests.some(r => r.parentTurnId.includes('planner-'))
        const results = requests.map(r => ({
          workOrderId: r.parentTurnId.includes('tianquan')
            ? 'team:planner-tianquan'
            : r.parentTurnId.includes('tianfu')
              ? 'team:planner-tianfu'
              : 'team:planner-tianxuan',
          status: 'passed' as const,
          summary: 'p',
          findings: [],
          artifacts: isPlannerBatch && r.parentTurnId.includes('tianquan')
            ? [{ kind: 'note' as const, title: 'perspective-plan', content: JSON.stringify({
                perspective: 'tianquan',
                tasks: [{
                  id: 'T1', title: 'impl', objective: 'impl', files: ['src/x.ts'],
                  profile: 'patcher', kind: 'patch_proposal', verification: [],
                  dependsOn: [], riskTier: 'low', touchSet: ['src/x.ts'],
                }],
              }) }]
            : [],
          changedFiles: [],
          risks: [],
          nextActions: [],
          evidenceStatus: 'verified' as const,
        }))
        for (const result of results) onWorkerSettled?.(result)
        return { status: 'completed', results, packet: isPlannerBatch ? 'planned' : 'executed' }
      },
    })

    assert.ok(summary.tasks.length > 0)
    assert.deepEqual(
      settled.filter(id => id.startsWith('team:planner-')).sort(),
      ['team:planner-tianfu', 'team:planner-tianquan', 'team:planner-tianxuan'],
    )
  })

  it('max mode routes planners via kind=plan and executors via kind=patch_proposal', async () => {
    const kinds: string[] = []
    await runTeamSkeleton({ mode: 'max', objective: 'design a coherent subsystem now' }, {
      delegateBatch: async (requests) => {
        for (const r of requests) {
          const role = r.parentTurnId.includes('planner-') ? 'planner' : 'exec'
          kinds.push(`${role}:${r.kind}`)
        }
        const isPlanner = requests.some(r => r.parentTurnId.includes('planner-'))
        if (isPlanner) {
          const plan = {
            perspective: 'tianquan', summary: 's',
            tasks: [{ id: 'T1', title: 'x', objective: 'x', files: ['src/x.ts'], profile: 'patcher', kind: 'patch_proposal', verification: [], dependsOn: [], riskTier: 'low', touchSet: ['src/x.ts'] }],
          }
          return {
            status: 'completed', packet: 'p',
            results: requests.map(r => ({
              workOrderId: r.parentTurnId.includes('tianquan') ? 'team:planner-tianquan'
                : r.parentTurnId.includes('tianfu') ? 'team:planner-tianfu' : 'team:planner-tianxuan',
              status: 'passed' as const, summary: 'p', findings: [],
              artifacts: r.parentTurnId.includes('tianquan')
                ? [{ kind: 'note' as const, title: 'perspective-plan', content: JSON.stringify(plan) }] : [],
              changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'verified' as const,
            })),
          }
        }
        return { status: 'completed', results: [], packet: 'e' }
      },
    })

    assert.ok(kinds.some(k => k === 'planner:plan'), `expected planner:plan in ${kinds}`)
    assert.ok(kinds.some(k => k === 'exec:patch_proposal'), `expected exec:patch_proposal in ${kinds}`)
  })

  it('max first wave surfaces the council merge ledger and folds verification gates', async () => {
    const plans: Record<string, unknown> = {
      tianquan: {
        perspective: 'tianquan', summary: 'base',
        tasks: [{ id: 'T1', title: 'impl', objective: 'impl', files: ['src/x.ts'], profile: 'patcher', kind: 'patch_proposal', verification: [], dependsOn: [], riskTier: 'low', touchSet: ['src/x.ts'] }],
        verification: [{ taskId: 'T1', command: 'npx tsc --noEmit', expected: 'exit 0' }],
      },
      tianfu: {
        perspective: 'tianfu', summary: 'constraint',
        risks: [{ taskId: 'T1', severity: 'high', claim: 'race condition', mitigation: 'add a lock' }],
        verification: [{ taskId: 'T1', command: 'npm test', expected: 'pass' }],
      },
      tianxuan: {
        perspective: 'tianxuan', summary: 'challenger',
        // Different dependency set on the same task → dependency conflict.
        tasks: [{ id: 'T1', title: 'impl', objective: 'impl', files: ['src/x.ts'], profile: 'patcher', kind: 'patch_proposal', verification: [], dependsOn: ['T0'], riskTier: 'low', touchSet: ['src/x.ts'] }],
        alternatives: [{ title: 'Alternative approach', tradeoff: 'simpler but slower', recommendation: 'defer' }],
      },
    }
    const summary = await runTeamSkeleton({ mode: 'max', objective: 'design the subsystem from scratch' }, {
      delegateBatch: async (requests) => {
        const isPlanner = requests.some(r => r.parentTurnId.includes('planner-'))
        if (isPlanner) {
          return {
            status: 'completed', packet: 'planned',
            results: requests.map(r => {
              const persp = r.parentTurnId.includes('tianquan') ? 'tianquan'
                : r.parentTurnId.includes('tianfu') ? 'tianfu'
                : r.parentTurnId.includes('tianxuan') ? 'tianxuan' : 'other'
              const plan = plans[persp]
              return {
                workOrderId: `team:planner-${persp}`,
                status: 'passed' as const, summary: 'p', findings: [],
                artifacts: plan ? [{ kind: 'note' as const, title: 'perspective-plan', content: JSON.stringify(plan) }] : [],
                changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'verified' as const,
              }
            }),
          }
        }
        return { status: 'completed', results: [], packet: 'executed' }
      },
    })

    assert.ok(summary.planMerge, 'first wave should carry planMerge')
    assert.ok(summary.planMerge!.conflicts.some(c => c.description.includes('Dependency conflict on T1')), 'dependency conflict surfaced')
    assert.ok(summary.planMerge!.risks.some(r => r.taskId === 'T1'), 'risk ledger surfaced')
    assert.ok(summary.planMerge!.deferred.some(d => d.title === 'Alternative approach'), 'deferred alternative surfaced')
    const t1 = summary.tasks.find(t => t.id === 'T1')!
    assert.deepEqual(t1.verification, ['npx tsc --noEmit', 'npm test'], 'constraint gate folded into task')
  })

  it('max folds a challenger orthogonal shard into the executable graph and dispatches it', async () => {
    const plans: Record<string, unknown> = {
      tianquan: {
        perspective: 'tianquan', summary: 'base',
        tasks: [{ id: 'T1', title: 'impl x', objective: 'impl x', files: ['src/x.ts'], profile: 'patcher', kind: 'patch_proposal', verification: [], dependsOn: [], riskTier: 'low', touchSet: ['src/x.ts'] }],
      },
      tianxuan: {
        perspective: 'tianxuan', summary: 'challenger',
        // Disjoint orthogonal shard (src/y.ts) → should be gap-filled into the graph.
        tasks: [{ id: 'T2', title: 'impl y', objective: 'impl y', files: ['src/y.ts'], profile: 'patcher', kind: 'patch_proposal', verification: [], dependsOn: [], riskTier: 'low', touchSet: ['src/y.ts'] }],
      },
    }
    const dispatchedIds: string[] = []
    const summary = await runTeamSkeleton({ mode: 'max', objective: 'design the subsystem from scratch' }, {
      delegateBatch: async (requests) => {
        const isPlanner = requests.some(r => r.parentTurnId.includes('planner-'))
        if (isPlanner) {
          return {
            status: 'completed', packet: 'planned',
            results: requests.map(r => {
              const persp = r.parentTurnId.includes('tianquan') ? 'tianquan'
                : r.parentTurnId.includes('tianfu') ? 'tianfu'
                : r.parentTurnId.includes('tianxuan') ? 'tianxuan' : 'other'
              const plan = plans[persp]
              return {
                workOrderId: `team:planner-${persp}`,
                status: 'passed' as const, summary: 'p', findings: [],
                artifacts: plan ? [{ kind: 'note' as const, title: 'perspective-plan', content: JSON.stringify(plan) }] : [],
                changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'verified' as const,
              }
            }),
          }
        }
        for (const r of requests) dispatchedIds.push(r.parentTurnId)
        return { status: 'completed', results: [], packet: 'executed' }
      },
    })

    assert.ok(summary.tasks.some(t => t.id === 'T1'), 'base shard kept')
    assert.ok(summary.tasks.some(t => t.id === 'T2'), 'disjoint challenger shard folded in')
    assert.ok(summary.planMerge!.augmented.some(a => a.title.includes('Gap-fill shard: T2')), 'augment ledger records the folded shard')
    // T1 and T2 are disjoint → same wave, both dispatched together.
    assert.ok(dispatchedIds.some(id => id.includes('T2')), 'folded shard reaches dispatch')
  })

  it('max surfaces a non-blocking advisory when merged shards overlap without ordering', async () => {
    const plans: Record<string, unknown> = {
      tianquan: {
        perspective: 'tianquan', summary: 'base',
        // Two shards touch the SAME file with no dependsOn between them.
        tasks: [
          { id: 'T1', title: 'a', objective: 'a', files: ['src/shared.ts'], profile: 'patcher', kind: 'patch_proposal', verification: [], dependsOn: [], riskTier: 'low', touchSet: ['src/shared.ts'] },
          { id: 'T2', title: 'b', objective: 'b', files: ['src/shared.ts'], profile: 'patcher', kind: 'patch_proposal', verification: [], dependsOn: [], riskTier: 'low', touchSet: ['src/shared.ts'] },
        ],
      },
    }
    const summary = await runTeamSkeleton({ mode: 'max', objective: 'design the subsystem from scratch' }, {
      delegateBatch: async (requests) => {
        const isPlanner = requests.some(r => r.parentTurnId.includes('planner-'))
        if (isPlanner) {
          return {
            status: 'completed', packet: 'planned',
            results: requests.map(r => {
              const persp = r.parentTurnId.includes('tianquan') ? 'tianquan'
                : r.parentTurnId.includes('tianfu') ? 'tianfu'
                : r.parentTurnId.includes('tianxuan') ? 'tianxuan' : 'other'
              const plan = plans[persp]
              return {
                workOrderId: `team:planner-${persp}`,
                status: 'passed' as const, summary: 'p', findings: [],
                artifacts: plan ? [{ kind: 'note' as const, title: 'perspective-plan', content: JSON.stringify(plan) }] : [],
                changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'verified' as const,
              }
            }),
          }
        }
        return { status: 'completed', results: [], packet: 'executed' }
      },
    })

    assert.ok(summary.advisories && summary.advisories.length > 0, 'advisory surfaced for overlap without ordering')
    assert.ok(summary.advisories!.some(a => a.includes('T1') && a.includes('T2')), 'advisory names the overlapping shards')
  })
})

describe('team orchestrator wave dispatch', () => {
  it('produces waves for tasks with dependencies', async () => {
    let captured: DelegationRequest[] = []
    const summary = await runTeamSkeleton({
      mode: 'standard',
      objective: 'wave test',
      planMarkdown: `
### T1: Base
修改 src/a.ts

### T2: Depends on T1
修改 src/b.ts
depends: T1
`,
    }, {
      delegateBatch: async (requests, policy) => {
        captured = requests
        return run('wave-done')
      },
    })

    // Should have waves (T1 first, then T2)
    assert.ok(summary.waves.length >= 1, `Expected ≥1 wave, got ${summary.waves.length}`)
    // First wave should contain T1
    assert.ok(summary.waves[0]!.taskIds.includes('T1'), 'First wave should include T1')
    // T2 should be in a later wave or blocked
    const t2WaveIdx = summary.waves.findIndex(w => w.taskIds.includes('T2'))
    if (t2WaveIdx >= 0) {
      const t1WaveIdx = summary.waves.findIndex(w => w.taskIds.includes('T1'))
      assert.ok(t1WaveIdx < t2WaveIdx, 'T1 wave must be before T2 wave')
    }
    // First wave dispatched
    assert.ok(summary.dispatched >= 1)
    assert.match(summary.packet, /wave-done/)
  })

  it('serializes same-file tasks across waves', async () => {
    const summary = await runTeamSkeleton({
      mode: 'standard',
      objective: 'serialize test',
      planMarkdown: `
### T1: First edit
修改 src/a.ts

### T2: Second edit
修改 src/a.ts
`,
    }, {
      delegateBatch: async (requests) => run(`dispatched ${requests.length}`),
    })

    // Same file → should serialize into different waves
    assert.ok(summary.waves.length >= 2, `Expected ≥2 waves for same-file tasks, got ${summary.waves.length}`)
  })

  it('returns empty waves for plan with no tasks', async () => {
    const summary = await runTeamSkeleton({
      mode: 'standard',
      objective: 'empty',
      planMarkdown: '# Just a design\nNo tasks here.',
    }, {
      delegateBatch: async () => run(),
    })

    assert.equal(summary.waves.length, 0)
    assert.equal(summary.dispatched, 0)
    assert.equal(summary.tasks.length, 0)
  })

  it('enriched tasks carry risk and dependency info', async () => {
    const summary = await runTeamSkeleton({
      mode: 'standard',
      objective: 'enrichment test',
      planMarkdown: `
### T1: Security fix
修改 src/auth.ts

### T2: Depends on T1
修改 src/other.ts
depends: T1
`,
    }, {
      delegateBatch: async () => run(),
    })

    assert.equal(summary.tasks.length, 2)
    const t1 = summary.tasks.find(t => t.id === 'T1')
    const t2 = summary.tasks.find(t => t.id === 'T2')
    assert.ok(t1)
    assert.ok(t2)
    assert.equal(t1!.riskTier, 'high')
    assert.deepEqual(t2!.dependsOn, ['T1'])
  })

  it('dispatches a later wave when fromWave is set', async () => {
    let captured: DelegationRequest[] = []
    const md = `
### T1: First edit
修改 src/a.ts

### T2: Second edit
修改 src/a.ts
`
    const summary = await runTeamSkeleton({
      mode: 'standard',
      objective: 'serialize',
      planMarkdown: md,
      fromWave: 1,
    }, {
      delegateBatch: async (requests) => { captured = requests; return run('wave2') },
    })

    assert.ok(summary.waves.length >= 2)
    assert.ok(captured.some(r => r.parentTurnId.includes('T2')))
    assert.ok(!captured.some(r => r.parentTurnId.includes('T1')))
  })

  it('records telemetry, scheduler shadow, and gated influence audit without changing dispatch result', async () => {
    const events: unknown[] = []
    const schedulerEvents: unknown[] = []
    const auditEvents: unknown[] = []
    const summary = await runTeamSkeleton({
      mode: 'standard',
      objective: 'telemetry wave',
      planMarkdown: `
### T1: First edit
修改 src/a.ts

### T2: Second edit
修改 src/a.ts
`,
      fromWave: 1,
    }, {
      sessionId: 'session-1',
      recordTeamWaveTelemetry: event => { events.push(event) },
      recordTeamSchedulerShadow: event => { schedulerEvents.push(event) },
      recordGatedInfluenceAudit: event => { auditEvents.push(event) },
      delegateBatch: async () => run('wave2'),
    })

    assert.equal(summary.dispatched, 1)
    assert.equal(events.length, 1)
    assert.equal(schedulerEvents.length, 1)
    assert.equal((events[0] as any).sessionId, 'session-1')
    assert.equal((events[0] as any).fromWave, 1)
    assert.equal((events[0] as any).waveId, 'W2')
    assert.equal((schedulerEvents[0] as any).applied, false)
    assert.equal(auditEvents.length, 1)
    assert.equal((auditEvents[0] as any).source, 'team_scheduler_bandit')
    assert.equal((auditEvents[0] as any).applied, false)
    assert.ok(Array.isArray((auditEvents[0] as any).vetoSignals))
  })

  it('allows scheduler influence only to reduce dispatch within a safe wave', async () => {
    let captured: DelegationRequest[] = []
    const summary = await runTeamSkeleton({
      mode: 'standard',
      objective: 'scheduler reduce',
      teamSchedulerBanditEnabled: true,
      planMarkdown: `
### T1: one
修改 src/a.ts

### T2: two
修改 src/b.ts

### T3: three
修改 src/c.ts
`,
    }, {
      teamSchedulerState: {
        totalSamples: 35,
        arms: {
          'parallelism:1': { samples: 6, totalReward: 4.8, averageReward: 0.8 },
          'parallelism:2': { samples: 6, totalReward: 2.4, averageReward: 0.4 },
          'parallelism:3': { samples: 6, totalReward: 2.4, averageReward: 0.4 },
          'parallelism:4': { samples: 6, totalReward: 2.4, averageReward: 0.4 },
          'parallelism:5': { samples: 11, totalReward: 4.4, averageReward: 0.4 },
        },
      },
      delegateBatch: async (requests) => { captured = requests; return run('reduced') },
    })

    assert.equal(summary.waves[0]!.taskIds.length, 3, 'grouping hard cap = MAX_WRITE_WORKERS (3)')
    assert.equal(summary.dispatched, 1)
    assert.equal(captured.length, 1)
    assert.ok(summary.blocked.some(item => item.includes('deferred by scheduler')))
  })

  it('reports completion when fromWave is past the last wave', async () => {
    const summary = await runTeamSkeleton({
      mode: 'standard',
      objective: 'done',
      fromWave: 9,
      planMarkdown: '### T1: only\n修改 src/a.ts',
    }, { delegateBatch: async () => run() })

    assert.equal(summary.dispatched, 0)
    assert.match(summary.packet, /all .* waves dispatched/)
  })

  // ── Wave 3: cross-wave failure propagation ──────────────────────

  describe('cross-wave failure propagation', () => {
    it('blocks wave 1 task that depends on failed wave 0 task', async () => {
      let captured: DelegationRequest[] = []
      const summary = await runTeamSkeleton({
        mode: 'standard',
        objective: 'multi-wave with dependency',
        parentTurnId: 'turn-xwave',
        fromWave: 1,
        priorResults: [
          { workOrderId: 'team:T1', status: 'failed', summary: 'worker crashed', findings: [], artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'blocked' },
        ],
        planMarkdown: `### Task 1: Search\nAnalyze the module structure.\n### Task 2: Patch\nDepends on T1 results.\n`,
      }, {
        delegateBatch: async (requests) => { captured = requests; return run('wave1') },
      })

      // Wave 1 should not include T1 (already ran in wave 0) and any task
      // depending on T1 should be blocked
      const dispatchedIds = captured.map(r => r.parentTurnId)
      assert.ok(!dispatchedIds.some(id => id.includes('T1')), 'T1 should not be re-dispatched')
    })

    it('does not block wave 1 task when prior wave task passed', async () => {
      let captured: DelegationRequest[] = []
      await runTeamSkeleton({
        mode: 'standard',
        objective: 'multi-wave with dependency',
        parentTurnId: 'turn-xwave-ok',
        priorResults: [
          { workOrderId: 'team:T1', status: 'passed', summary: 'ok', findings: [], artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'verified' },
        ],
        planMarkdown: `### Task 1: Search\nAnalyze the module structure.\n### Task 2: Patch\nDepends on T1 results.\n`,
      }, {
        delegateBatch: async (requests) => { captured = requests; return run('wave0') },
      })

      // Tasks should be dispatched normally when prior results passed
      assert.ok(captured.length > 0, 'tasks should be dispatched when dependency passed')
    })

    // ── 跨波回执（2026-08-05 闭环审计）──────────────────────────────
    // 此前上一波的验收结论只进 tool 输出给主控看，下一波 worker 一无所知。
    // 这几条钉住「反馈 → 下一波工单」这一环真的接上了。

    it('上一波失败被压成约束下传给本波 worker', async () => {
      let captured: DelegationRequest[] = []
      await runTeamSkeleton({
        mode: 'standard',
        objective: 'multi-wave feedback',
        parentTurnId: 'turn-feedback',
        fromWave: 1,
        priorResults: [
          { workOrderId: 'team:T1', status: 'failed', summary: '', findings: [], artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'unverified', failureReason: 'timeout' },
        ],
        planMarkdown: `### T1: First edit\n修改 src/a.ts\n\n### T2: Second edit\n修改 src/a.ts\n`,
      }, {
        delegateBatch: async (requests) => { captured = requests; return run('wave1') },
      })

      assert.ok(captured.length > 0, 'wave 1 应有任务派发')
      const constraints = captured[0]!.constraints ?? []
      assert.ok(
        constraints.some(c => c.includes('T1') && c.includes('timeout')),
        `回执未注入，实际 constraints: ${JSON.stringify(constraints)}`,
      )
    })

    it('上一波门禁未过项下传', async () => {
      let captured: DelegationRequest[] = []
      await runTeamSkeleton({
        mode: 'standard',
        objective: 'gate feedback',
        parentTurnId: 'turn-gate-fb',
        fromWave: 1,
        priorWaveGateFailures: ['npx tsc --noEmit'],
        planMarkdown: `### T1: First edit\n修改 src/a.ts\n\n### T2: Second edit\n修改 src/a.ts\n`,
      }, {
        delegateBatch: async (requests) => { captured = requests; return run('wave1') },
      })

      const constraints = captured[0]?.constraints ?? []
      assert.ok(constraints.some(c => c.includes('门禁未过') && c.includes('tsc')), JSON.stringify(constraints))
    })

    it('上一波计划外改动下传并提示勿扩大范围', async () => {
      let captured: DelegationRequest[] = []
      await runTeamSkeleton({
        mode: 'standard',
        objective: 'scope feedback',
        parentTurnId: 'turn-scope-fb',
        fromWave: 1,
        priorScopeLeaks: ['src/unplanned.ts'],
        planMarkdown: `### T1: First edit\n修改 src/a.ts\n\n### T2: Second edit\n修改 src/a.ts\n`,
      }, {
        delegateBatch: async (requests) => { captured = requests; return run('wave1') },
      })

      const constraints = captured[0]?.constraints ?? []
      assert.ok(constraints.some(c => c.includes('src/unplanned.ts')), JSON.stringify(constraints))
    })

    it('上一波全通过时不注入回执——不给 worker 增加无谓上下文', async () => {
      let captured: DelegationRequest[] = []
      await runTeamSkeleton({
        mode: 'standard',
        objective: 'clean wave',
        parentTurnId: 'turn-clean',
        fromWave: 1,
        priorResults: [
          { workOrderId: 'team:T1', status: 'passed', summary: 'ok', findings: [], artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'verified' },
        ],
        planMarkdown: `### T1: First edit\n修改 src/a.ts\n\n### T2: Second edit\n修改 src/a.ts\n`,
      }, {
        delegateBatch: async (requests) => { captured = requests; return run('wave1') },
      })

      for (const r of captured) {
        const constraints = r.constraints ?? []
        assert.ok(!constraints.some(c => c.startsWith('上一波')), JSON.stringify(constraints))
      }
    })

    it('回执排在计划级约束之后（计划是长期契约，回执是临时情报）', async () => {
      let captured: DelegationRequest[] = []
      await runTeamSkeleton({
        mode: 'standard',
        objective: 'ordering',
        parentTurnId: 'turn-order',
        fromWave: 1,
        planConstraints: ['不得引入新依赖'],
        priorWaveGateFailures: ['npx tsc --noEmit'],
        planMarkdown: `### T1: First edit\n修改 src/a.ts\n\n### T2: Second edit\n修改 src/a.ts\n`,
      }, {
        delegateBatch: async (requests) => { captured = requests; return run('wave1') },
      })

      const constraints = captured[0]?.constraints ?? []
      const planIdx = constraints.findIndex(c => c.includes('不得引入新依赖'))
      const fbIdx = constraints.findIndex(c => c.includes('门禁未过'))
      assert.ok(planIdx >= 0 && fbIdx >= 0, JSON.stringify(constraints))
      assert.ok(planIdx < fbIdx, '计划约束应排在回执之前')
    })

    it('priorResults undefined — backward compatible, no blocking', async () => {
      let captured: DelegationRequest[] = []
      await runTeamSkeleton({
        mode: 'standard',
        objective: 'single wave test',
        parentTurnId: 'turn-noprior',
        planMarkdown: `### Task 1: Search\nAnalyze something.\n`,
      }, {
        delegateBatch: async (requests) => { captured = requests; return run('wave0') },
      })

      assert.ok(captured.length > 0, 'tasks dispatched without priorResults')
    })
  })

  describe('extractTaskIdFromWorkOrderId', () => {
    it('extracts task ID from standard team: prefix format', () => {
      assert.equal(extractTaskIdFromWorkOrderId('team:T1'), 'T1')
      assert.equal(extractTaskIdFromWorkOrderId('team:planner-tianquan'), 'planner-tianquan')
    })

    it('extracts last segment when multiple colons present', () => {
      assert.equal(extractTaskIdFromWorkOrderId('team:wave2:T1'), 'T1')
      assert.equal(extractTaskIdFromWorkOrderId('team:planner:tianfu'), 'tianfu')
    })

    it('returns the whole string when no colon present', () => {
      assert.equal(extractTaskIdFromWorkOrderId('T1'), 'T1')
      assert.equal(extractTaskIdFromWorkOrderId('bare-id'), 'bare-id')
    })
  })
})

// ── 预算发准（2026-08-18）：写工按 files 形状定价进 request.budget ─────────

describe('teamTasksToDelegationRequests · budget shape', () => {
  it('写工任务按文件数定价：单文件不发声（走默认），多文件放大', () => {
    const [single] = teamTasksToDelegationRequests([task('T1', ['src/a.ts'])], 'parent')
    // 单文件无形状信号——budget 不设，落 work-order 的 48 轮 / patcher 600s 默认
    assert.equal(single!.budget, undefined)
    const [multi] = teamTasksToDelegationRequests([
      task('T2', ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']),
    ], 'parent')
    assert.equal(multi!.budget!.maxTurns, 48 + 6 * 3)
    assert.equal(multi!.budget!.timeoutMs, 600_000 + 45_000 * 3)
  })

  it('读工任务不定价：budget 为 undefined（行为零变化）', () => {
    const [read] = teamTasksToDelegationRequests([task('T3', ['src/a.ts'], 'reviewer')], 'parent')
    assert.equal(read!.budget, undefined)
  })
})

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  aggregatePlanExecutorRuns,
  classifyWaveStop,
  EXECUTE_PLAN_WAVES_GUARDRAIL,
  executePlanWaves,
  type PlanExecutorRun,
} from '../plan-executor.js'
import { buildTeamOutcome } from '../orchestration-outcome.js'
import { deriveTeamGroupId, loadCheckpoint } from '../wave-checkpoint.js'
import { getWaveResults, clearWaveResults } from '../wave-results-store.js'
import type { TeamRunSummary } from '../team-orchestrator.js'
import type { WorkerResult } from '../work-order.js'

// Wave 3A：共享多波驱动 executePlanWaves —— 停止判据 / 聚合 / 中间波无 review。

function mkResult(workOrderId: string, status: WorkerResult['status'] = 'passed', changedFiles: string[] = []): WorkerResult {
  return {
    workOrderId,
    status,
    summary: 'done',
    findings: [],
    artifacts: [],
    changedFiles,
    risks: [],
    nextActions: [],
    evidenceStatus: 'verified',
    delegationDepth: 0,
  } as unknown as WorkerResult
}

function mkSummary(results: WorkerResult[], totalWaves: number, dispatched = results.length): TeamRunSummary {
  return {
    mode: 'standard',
    planned: [],
    tasks: [],
    waves: Array.from({ length: totalWaves }, (_, i) => ({
      id: `w${i}`, taskIds: [], reason: '', parallelLimit: 3, risk: 'low',
    })),
    dispatched,
    blocked: [],
    packet: 'p',
    run: { status: 'completed', results, packet: 'p' },
  }
}

function mkRun(summary: TeamRunSummary, extra?: Partial<PlanExecutorRun>): PlanExecutorRun {
  return {
    summary,
    notes: { reviewNote: '', scopeHealthNote: '', impactNote: '', deliverySynthesis: '', waveGateNote: '' },
    ...extra,
  }
}

describe('classifyWaveStop', () => {
  it('通过波（有 worker 且至少 1 通过）不停止', () => {
    const outcome = buildTeamOutcome(mkSummary([mkResult('a', 'passed')], 3), 0, mkRun(mkSummary([], 3)))
    assert.equal(classifyWaveStop(outcome), false)
  })

  it('本波零通过且存在 worker → 停止', () => {
    const outcome = buildTeamOutcome(mkSummary([mkResult('a', 'failed'), mkResult('b', 'blocked')], 3), 0, mkRun(mkSummary([], 3)))
    assert.equal(classifyWaveStop(outcome), true)
  })

  it('未派发任何 worker（total=0）不触发零通过停止', () => {
    const outcome = buildTeamOutcome(mkSummary([], 3, 0), 0, mkRun(mkSummary([], 3)))
    assert.equal(classifyWaveStop(outcome), false)
  })

  it('wave gate failed → 停止；passed 不停止', () => {
    const failed = buildTeamOutcome(
      mkSummary([mkResult('a')], 3),
      0,
      mkRun(mkSummary([], 3), { gate: { wave: 0, passed: false, failures: ['tsc'] } }),
    )
    assert.equal(classifyWaveStop(failed), true)
    const passed = buildTeamOutcome(
      mkSummary([mkResult('a')], 3),
      0,
      mkRun(mkSummary([], 3), { gate: { wave: 0, passed: true, failures: [] } }),
    )
    assert.equal(classifyWaveStop(passed), false)
  })

  it('review rejected / inconclusive → 停止；verified 不停止', () => {
    assert.equal(classifyWaveStop(buildTeamOutcome(mkSummary([mkResult('a')], 3), 0, mkRun(mkSummary([], 3), { reviewVerdict: 'rejected' }))), true)
    assert.equal(classifyWaveStop(buildTeamOutcome(mkSummary([mkResult('a')], 3), 0, mkRun(mkSummary([], 3), { reviewVerdict: 'inconclusive' }))), true)
    assert.equal(classifyWaveStop(buildTeamOutcome(mkSummary([mkResult('a')], 3), 0, mkRun(mkSummary([], 3), { reviewVerdict: 'verified' }))), false)
  })

  it('abortSignal 已中止 → 停止；未中止不停止', () => {
    const aborted = new AbortController()
    aborted.abort()
    const outcome = buildTeamOutcome(mkSummary([mkResult('a')], 3), 0, mkRun(mkSummary([], 3)))
    assert.equal(classifyWaveStop(outcome, { abortSignal: aborted.signal }), true)
    assert.equal(classifyWaveStop(outcome, { abortSignal: new AbortController().signal }), false)
  })
})

describe('aggregatePlanExecutorRuns', () => {
  it('空 runs 抛错', () => {
    assert.throws(() => aggregatePlanExecutorRuns([]), /no runs to aggregate/)
  })

  it('results 并集保序、dispatched 累计、其余取最后一波', () => {
    const w0 = mkRun(mkSummary([mkResult('team:T0')], 2, 1))
    const w1 = mkRun(mkSummary([mkResult('team:T1')], 2, 1))
    const agg = aggregatePlanExecutorRuns([w0, w1])
    assert.equal(agg.summary.dispatched, 2)
    assert.deepEqual(agg.summary.run!.results.map(r => r.workOrderId), ['team:T0', 'team:T1'])
    assert.equal(agg.summary.waves.length, 2)
    assert.equal(agg.summary.packet, 'p')
  })

  it('notes 各字段拼接——scope-health / delivery / review / wave-gate / impact 不丢', () => {
    const w0 = mkRun(mkSummary([mkResult('a')], 2), {
      notes: {
        reviewNote: '', scopeHealthNote: '\n\nScope health [high]: leaked x', impactNote: '', deliverySynthesis: '', waveGateNote: '\n\nwave gate note',
      },
    })
    const w1 = mkRun(mkSummary([mkResult('b')], 2), {
      notes: {
        reviewNote: '\n\nReview gate: verified', scopeHealthNote: '', impactNote: '\n\nBlast radius: 2', deliverySynthesis: '\n\nDelivery: done', waveGateNote: '',
      },
    })
    const agg = aggregatePlanExecutorRuns([w0, w1])
    assert.match(agg.notes.scopeHealthNote, /leaked x/)
    assert.match(agg.notes.waveGateNote, /wave gate note/)
    assert.match(agg.notes.reviewNote, /verified/)
    assert.match(agg.notes.impactNote, /Blast radius/)
    assert.match(agg.notes.deliverySynthesis, /Delivery: done/)
  })

  it('gate / reviewDetail 取最近一个有值的；reviewVerdict 取最后一波', () => {
    const w0 = mkRun(mkSummary([mkResult('a')], 2), {
      gate: { wave: 0, passed: true, failures: [] },
      reviewDetail: 'w0 review',
    })
    const w1 = mkRun(mkSummary([mkResult('b')], 2), {
      reviewVerdict: 'verified',
      reviewDetail: 'w1 review',
    })
    const agg = aggregatePlanExecutorRuns([w0, w1])
    assert.equal(agg.gate?.wave, 0)
    assert.equal(agg.reviewDetail, 'w1 review', 'reviewDetail 取最近一次（末波 review 覆盖中间波）')
    assert.equal(agg.reviewVerdict, 'verified')

    // 只有中间波有 gate / reviewDetail 时也保留。
    const agg2 = aggregatePlanExecutorRuns([w0])
    assert.equal(agg2.gate?.wave, 0)
    assert.equal(agg2.reviewDetail, 'w0 review')
  })
})

describe('executePlanWaves', () => {
  // 两个同文件任务 → groupTeamTasks 串行分 2 波（与 plan-executor-checkpoint 同款 PLAN）。
  const PLAN = `
### T1: First edit
修改 src/a.ts

### T2: Second edit
修改 src/a.ts
`
  const objective = 'waves driver test'

  function makeDeps(delegateBatch: (requests: Array<{ parentTurnId: string }>) => Promise<{ status: 'completed'; results: WorkerResult[]; packet: string }>) {
    return { delegateBatch }
  }

  it('多波聚合：按 fromWave 逐波推进、每波独立持久化、onWave 每波回调', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-waves-'))
    const sessionId = `waves-${Date.now()}`
    const groupId = deriveTeamGroupId(objective)
    const wavesSeen: Array<[number, number]> = []
    try {
      const { runs, run } = await executePlanWaves(
        {
          mode: 'standard', objective, planMarkdown: PLAN,
          sessionId, reviewDepth: 0, cwd: dir, reviewGate: false,
          onWave: (r, wave) => wavesSeen.push([wave, r.summary.run?.results.length ?? 0]),
        },
        makeDeps(async requests => ({ status: 'completed', results: requests.map(r => mkResult(r.parentTurnId)), packet: 'w' })),
      )
      assert.equal(runs.length, 2, '两波都执行')
      assert.deepEqual(wavesSeen, [[0, 1], [1, 1]], 'onWave 每波回调，携带本波结果数')
      assert.equal(run.summary.dispatched, 2, '聚合 dispatched 累计两波')
      assert.equal(run.summary.run!.results.length, 2, '聚合 results 并集两波 worker')
      // 每波独立持久化：executePlan 每波 setWaveResults 覆盖——末波后 store 是
      // 最后一波的结果；末波全过后 checkpoint 清除（与 checkpoint 套件同款行为）。
      const stored = getWaveResults(sessionId)
      assert.equal(stored?.length, 1, 'wave results store 每波覆盖，保留末波结果')
      assert.equal(stored?.[0]?.status, 'passed')
      assert.equal(loadCheckpoint(dir, groupId), null, '末波全过后 checkpoint 清除')
    } finally {
      clearWaveResults(sessionId)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('autoAdvance=false 只执行起始波（单波语义入口）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-waves-single-'))
    const sessionId = `waves-single-${Date.now()}`
    try {
      const { runs } = await executePlanWaves(
        {
          mode: 'standard', objective, planMarkdown: PLAN,
          sessionId, reviewDepth: 0, cwd: dir, reviewGate: false,
          autoAdvance: false,
        },
        makeDeps(async requests => ({ status: 'completed', results: requests.map(r => mkResult(r.parentTurnId)), packet: 'w' })),
      )
      assert.equal(runs.length, 1, 'autoAdvance=false 只跑起始波')
      assert.equal(runs[0]!.summary.run!.results.length, 1)
    } finally {
      clearWaveResults(sessionId)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('停止判据：本波零通过 → 不推进下一波（即使 autoAdvance=true）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-waves-stop-'))
    const sessionId = `waves-stop-${Date.now()}`
    try {
      const { runs } = await executePlanWaves(
        {
          mode: 'standard', objective, planMarkdown: PLAN,
          sessionId, reviewDepth: 0, cwd: dir, reviewGate: false,
        },
        makeDeps(async requests => ({ status: 'completed', results: requests.map(r => mkResult(r.parentTurnId, 'failed')), packet: 'w' })),
      )
      assert.equal(runs.length, 1, '波0 零通过 → 停止，波1 不派发')
      assert.equal(runs[0]!.summary.run!.results[0]!.status, 'failed')
    } finally {
      clearWaveResults(sessionId)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('中间波不提前执行末波 review（reviewGate 只在末波触发）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-waves-review-'))
    const sessionId = `waves-review-${Date.now()}`
    const prevGate = process.env.RIVET_WAVE_GATE
    process.env.RIVET_WAVE_GATE = '0'
    try {
      let batchCall = 0
      const { runs } = await executePlanWaves(
        {
          mode: 'standard', objective, planMarkdown: PLAN,
          sessionId, reviewDepth: 0, cwd: dir, reviewGate: true,
        },
        {
          // 波0（中间波）携带 changedFiles，具备 review 触发条件但非末波；
          // 波1（末波）changedFiles 为空，不触发 review。
          // 故意不提供 deps.delegate：中间波若误触发 review，requireDelegate 会抛错。
          delegateBatch: async (requests: Array<{ parentTurnId: string }>) => {
            const wave = batchCall++
            const changedFiles = wave === 0 ? ['src/a.ts'] : []
            return { status: 'completed', results: requests.map(r => mkResult(r.parentTurnId, 'passed', changedFiles)), packet: `w${wave}` }
          },
        },
      )
      assert.equal(runs.length, 2, '两波正常执行：中间波未触发 review，末波空 changedFiles 也未触发')
    } finally {
      if (prevGate === undefined) delete process.env.RIVET_WAVE_GATE
      else process.env.RIVET_WAVE_GATE = prevGate
      clearWaveResults(sessionId)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('maxWaves 硬上限截断；maxWaves <= startWave 抛错；护栏常量 = 10', async () => {
    assert.equal(EXECUTE_PLAN_WAVES_GUARDRAIL, 10)
    await assert.rejects(
      executePlanWaves(
        { mode: 'standard', objective, reviewDepth: 0, cwd: '/tmp', reviewGate: false, startWave: 2, maxWaves: 2 },
        { delegateBatch: async () => ({ status: 'completed' as const, results: [], packet: '' }) },
      ),
      /maxWaves \(2\) must be > startWave \(2\)/,
    )
  })

  it('maxWaves 截断多波推进（护栏语义在显式上限生效）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-waves-cap-'))
    const sessionId = `waves-cap-${Date.now()}`
    try {
      const { runs } = await executePlanWaves(
        {
          mode: 'standard', objective, planMarkdown: PLAN,
          sessionId, reviewDepth: 0, cwd: dir, reviewGate: false,
          maxWaves: 1,
        },
        makeDeps(async requests => ({ status: 'completed', results: requests.map(r => mkResult(r.parentTurnId)), packet: 'w' })),
      )
      assert.equal(runs.length, 1, 'maxWaves=1 只跑波0')
    } finally {
      clearWaveResults(sessionId)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

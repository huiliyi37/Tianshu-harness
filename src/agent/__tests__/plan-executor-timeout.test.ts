/**
 * 超时与执行分离（T11-T14）：
 * - T11：withToolTimeout 超时错误文案含恢复指引（TOOL_TIMEOUT_RECOVERY_HINT）
 * - T12：每波完成 checkpoint 落盘可恢复（lastCompletedWave + 1 续跑语义）
 * - T13：覆盖式 checkpoint 保留最后完成波（abort/异常不破坏前波进度）
 * - T13b（回流时新增）：兜底 checkpoint 的波序号口径——startWave>0 的续跑场景
 *   不得把 lastCompletedWave 写小（alpha 原版用 runs.length-1，续跑会重跑已完成波次）
 * checkpoint 部分用真实 wave-checkpoint 存储（不 mock 中间层）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TOOL_TIMEOUT_RECOVERY_HINT } from '../tool-pipeline.js'
import { buildRescueCheckpoint, type PlanExecutorRun } from '../plan-executor.js'
import type { WorkerResult } from '../work-order.js'
import {
  clearCheckpoint,
  deriveTeamGroupId,
  loadCheckpoint,
  saveCheckpoint,
} from '../wave-checkpoint.js'
import { createReadOnlyWorkOrder } from '../work-order.js'

describe('T11 — 超时错误文案含恢复指引', () => {
  it('TOOL_TIMEOUT_RECOVERY_HINT 导出且带恢复语义', () => {
    assert.ok(TOOL_TIMEOUT_RECOVERY_HINT.length > 40, '指引必须可操作')
    assert.ok(TOOL_TIMEOUT_RECOVERY_HINT.includes('fromWave'), '必须提示 fromWave=N 续跑')
    assert.ok(TOOL_TIMEOUT_RECOVERY_HINT.includes('git status'), '必须提示检查 worker 已落盘')
  })
})

describe('T12 — 波完成 checkpoint 可恢复（fromWave 续跑语义）', () => {
  it('saveCheckpoint 后 loadCheckpoint 恢复 lastCompletedWave + 已完成结果', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zen-w12-'))
    try {
      const objective = 'checkpoint 可恢复验证任务'
      const groupId = deriveTeamGroupId(objective)
      const order = createReadOnlyWorkOrder({
        id: 'wo_cp',
        parentTurnId: 't',
        kind: 'code_search',
        profile: 'code_scout',
        objective: '波 1 任务',
        scope: { files: [], symbols: [] },
        constraints: [],
        allowedTools: ['read_file'],
        disallowedTools: [],
        dedupeKey: 'k',
        dependencies: [],
        aggregationPolicy: 'all_required',
        budget: { turns: 4 },
      } as never)

      // 构造波 1 完成的 checkpoint（走真实 buildWaveCheckpoint 的输入形态）
      const cp = {
        groupId,
        timestamp: Date.now(),
        lastCompletedWave: 0,
        completedResults: [],
        remainingOrders: [{ id: order.id, objective: order.objective, profile: order.profile, kind: order.kind, scope: order.scope }],
        objective,
        totalWaves: 2,
      }
      saveCheckpoint(dir, cp)
      const loaded = loadCheckpoint(dir, groupId)
      assert.ok(loaded, 'checkpoint 必须可读回')
      assert.equal(loaded!.lastCompletedWave, 0)
      assert.equal(loaded!.remainingOrders.length, 1)
      // 续跑语义：fromWave = lastCompletedWave + 1 = 1
      assert.equal(loaded!.lastCompletedWave + 1, 1)
      assert.equal(loaded!.totalWaves, 2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('T13 — 覆盖式 checkpoint 保留最后完成波（abort 不破坏前波进度）', () => {
  it('后波覆盖前波后，checkpoint 恒为最后完成波——abort 时续跑不重复', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zen-w13-'))
    try {
      const objective = '覆盖式 checkpoint 验证'
      const groupId = deriveTeamGroupId(objective)
      // 波 0 完成 → checkpoint A；波 1 完成 → checkpoint B（覆盖）
      saveCheckpoint(dir, { groupId, timestamp: 1, lastCompletedWave: 0, completedResults: [], remainingOrders: [], objective, totalWaves: 3 })
      saveCheckpoint(dir, { groupId, timestamp: 2, lastCompletedWave: 1, completedResults: [], remainingOrders: [], objective, totalWaves: 3 })
      const loaded = loadCheckpoint(dir, groupId)
      assert.equal(loaded!.lastCompletedWave, 1, '覆盖式写：checkpoint 是最后完成波')
      assert.equal(loaded!.timestamp, 2)
      // abort 场景：最后一波未落盘（异常不覆盖）→ checkpoint 仍是最后完成波 1
      // → fromWave=2 续跑，不重复波 0/1
      assert.equal(loaded!.lastCompletedWave + 1, 2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('T13b — 兜底 checkpoint 的波序号口径（回流修正点）', () => {
  function mkResult(workOrderId: string): WorkerResult {
    return {
      workOrderId,
      status: 'passed',
      summary: 'done',
      findings: [],
      artifacts: [],
      changedFiles: [],
      risks: [],
      nextActions: [],
    } as unknown as WorkerResult
  }

  /** 造一份够 buildWaveCheckpoint 用的 summary stub（tasks/waves/run.results）。 */
  function summaryStub(resultId: string, waveTaskIds: string[][]): PlanExecutorRun['summary'] {
    return {
      tasks: waveTaskIds.flat().map(id => ({
        id, objective: `task ${id}`, profile: 'code_scout', kind: 'code_search', files: [], dependsOn: [],
      })),
      waves: waveTaskIds.map(taskIds => ({ taskIds })),
      run: { results: [mkResult(resultId)] },
    } as unknown as PlanExecutorRun['summary']
  }

  it('startWave=0：两波完成 → lastCompletedWave=1、totalWaves 取计划真实波数、results 全量合并', () => {
    const runs = [
      { summary: summaryStub('wo_1', [['wo_1'], ['wo_2']]) },
      { summary: summaryStub('wo_2', [['wo_1'], ['wo_2']]) },
    ] as unknown as PlanExecutorRun[]
    const cp = buildRescueCheckpoint('rescue objective', 0, runs)
    assert.equal(cp.lastCompletedWave, 1)
    assert.equal(cp.totalWaves, 2, 'alpha 原版这里写 0，进度文案分母会变 0')
    assert.equal(cp.completedResults.length, 2, '两波结果都要在（原版只并 run 的 results，同为 2）')
    assert.deepEqual(cp.remainingOrders, [], '末波后无剩余任务')
  })

  it('startWave=2（续跑）：lastCompletedWave = startWave + runs-1 = 3，而非 runs-1 = 1', () => {
    const runs = [
      { summary: summaryStub('wo_3', [['wo_1'], ['wo_2'], ['wo_3'], ['wo_4']]) },
      { summary: summaryStub('wo_4', [['wo_1'], ['wo_2'], ['wo_3'], ['wo_4']]) },
    ] as unknown as PlanExecutorRun[]
    const cp = buildRescueCheckpoint('resume objective', 2, runs)
    assert.equal(cp.lastCompletedWave, 3, '写小会让续跑重跑已完成的波次')
    assert.notEqual(cp.lastCompletedWave, runs.length - 1, '这正是 alpha 原版的 off-by-startWave')
    assert.equal(cp.lastCompletedWave + 1, 4, 'fromWave=4 续跑语义')
  })

  it('mid-plan：剩余任务按计划派生，不是空清单（原版写 [] 会让 resume 以为干完了）', () => {
    const runs = [{ summary: summaryStub('wo_1', [['wo_1'], ['wo_2'], ['wo_3']]) }] as unknown as PlanExecutorRun[]
    const cp = buildRescueCheckpoint('mid objective', 0, runs)
    assert.equal(cp.lastCompletedWave, 0)
    assert.deepEqual(cp.remainingOrders.map(o => o.id), ['wo_2', 'wo_3'], '波 1/2 的任务必须留在 remainingOrders')
  })
})

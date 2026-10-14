import { test } from 'node:test'
import assert from 'node:assert/strict'
import { teamOrchestrateTimeoutMs, TEAM_TIMEOUT_CEIL_MS } from '../team-orchestrate.js'
import { consumePlan, getStoredPlan, storePlan } from '../../agent/plan-store.js'
import { WORKER_EXIT_GRACE_MS } from '../../agent/timeout-ladder.js'
import { profileRegistry, tierTimeoutMultiplier } from '../../agent/profile-registry.js'
import { groupTeamTasks } from '../../agent/team-grouping.js'
import { teamTasksToDelegationRequests } from '../../agent/team-orchestrator.js'
import { deserializeUnifiedPlan, unifiedPlanToTeamTasks } from '../../agent/unified-plan.js'
import { createReadOnlyWorkOrder, createWriteWorkOrder, type WorkerResult } from '../../agent/work-order.js'
import {
  HANDS_GATE_REPAIR_RESERVE,
  MAX_BUDGET_CONTINUATIONS,
  MAX_HANDS_EXTRA_RUNS,
  decideContinuation,
  decideHandsContinuation,
} from '../../agent/worker-continuation.js'
import type { TeamTask } from '../../agent/team-plan.js'

const PATCHER_TASK = (id: string, files: string[]): TeamTask => ({
  id,
  title: id,
  objective: `任务 ${id}`,
  profile: 'patcher',
  kind: 'patch_proposal',
  files,
  dependsOn: [],
  riskTier: 'low',
  verification: [],
  touchSet: files,
})

const planJsonOf = (tasks: TeamTask[]): string =>
  JSON.stringify({
    version: 1,
    objective: '测试计划',
    tasks,
    source: 'plan_task',
    createdAt: 0,
  })

const TWO_WAVE_PLAN = planJsonOf([
  PATCHER_TASK('a', ['src/a.ts']),
  PATCHER_TASK('b', ['src/b.ts']),
  PATCHER_TASK('c', ['src/c.ts']),
  PATCHER_TASK('d', ['src/d.ts']),
  PATCHER_TASK('e', ['src/e.ts']),
  PATCHER_TASK('f', ['src/f.ts']),
])

const SINGLE_TASK_PLAN = planJsonOf([PATCHER_TASK('a', ['src/a.ts'])])

const MANY_TASK_PLAN = planJsonOf(
  Array.from({ length: 11 }, (_entry, index) => PATCHER_TASK(`t${index}`, [`src/t${index}.ts`])),
)

const timeoutOf = (params?: Parameters<typeof teamOrchestrateTimeoutMs>[0]): number =>
  teamOrchestrateTimeoutMs(params)

function assertExecutionBudget(
  planJson: string,
  expectedWaves: string[][],
  expectedBaseBudgets: number[],
  expectedTimeoutMs: number,
): number {
  const plan = deserializeUnifiedPlan(planJson)
  assert.ok(plan, '预算证据必须来自有效的完整计划')
  const tasks = unifiedPlanToTeamTasks(plan)
  const waves = groupTeamTasks(tasks)
  assert.deepEqual(waves.map(wave => wave.taskIds), expectedWaves)

  const requests = teamTasksToDelegationRequests(tasks, 'timeout-contract')
  const tier = tierTimeoutMultiplier('strong')
  assert.equal(tier, 1.5)
  const baseBudgets = requests.map(request => {
    const profile = profileRegistry.get(request.profile!)
    assert.ok(profile?.defaultTimeoutMs)
    const extraFiles = Math.max(0, (request.scope.files?.length ?? 0) - 1)
    const completeBudget = profile.role === 'hands'
      ? Math.min(1_800_000, profile.defaultTimeoutMs + extraFiles * 45_000)
      : profile.defaultTimeoutMs
    assert.equal(request.budget?.timeoutMs ?? profile.defaultTimeoutMs, completeBudget)
    return completeBudget
  })
  assert.deepEqual(baseBudgets, expectedBaseBudgets)

  const orders = requests.map(request => {
    const createOrder = profileRegistry.get(request.profile!)?.role === 'hands'
      ? createWriteWorkOrder
      : createReadOnlyWorkOrder
    return createOrder({ ...request, profile: request.profile!, tierFloor: 'strong' })
  })
  for (const [index, order] of orders.entries()) {
    assert.equal(order.budget.timeoutMs, expectedBaseBudgets[index]! * 1.5)
    assert.equal(order.budget.maxRetries, 0)
  }

  const worstWorkerWaveBudget = waves.length * Math.max(...orders.map(order => order.budget.timeoutMs))
  const independentlyPriced = Math.min(3_600_000, expectedWaves.length * Math.max(...baseBudgets) * 1.5 + 30_000)
  assert.equal(independentlyPriced, expectedTimeoutMs)
  assert.equal(WORKER_EXIT_GRACE_MS, 30_000)
  assert.equal(TEAM_TIMEOUT_CEIL_MS, 3_600_000)
  const timeout = timeoutOf({ input: { planJson }, toolUseId: 'timeout-contract', cwd: '/repo', sessionId: 'timeout-contract' })
  assert.equal(timeout, independentlyPriced)
  assert.equal(timeout, Math.min(TEAM_TIMEOUT_CEIL_MS, worstWorkerWaveBudget + WORKER_EXIT_GRACE_MS))
  assert.ok(timeout <= TEAM_TIMEOUT_CEIL_MS)
  if (worstWorkerWaveBudget + WORKER_EXIT_GRACE_MS <= TEAM_TIMEOUT_CEIL_MS) {
    assert.ok(timeout > worstWorkerWaveBudget, '未封顶时外层必须晚于全部 worker 预算并保留收尾宽限')
  }
  return timeout
}

test('team_orchestrate 工具超时：两波完整预算比单波多一个 worker 墙钟，不再固定 600s', () => {
  const single = assertExecutionBudget(SINGLE_TASK_PLAN, [['a']], [600_000], 930_000)
  const multi = assertExecutionBudget(TWO_WAVE_PLAN, [['a', 'b', 'c'], ['d', 'e', 'f']], Array(6).fill(600_000), 1_830_000)
  assert.equal(multi - single, 900_000)
  assert.ok(multi > 600_000)
})

test('team_orchestrate 工具超时：单任务覆盖完整 profile、strong tier 和 30s 收尾宽限', () => {
  assertExecutionBudget(SINGLE_TASK_PLAN, [['a']], [600_000], 930_000)
})

test('team_orchestrate 工具超时：11 任务真实四波预算加宽限超过 1h 时精确封顶', () => {
  assertExecutionBudget(MANY_TASK_PLAN, [
    ['t0', 't1', 't2'], ['t3', 't4', 't5'], ['t6', 't7', 't8'], ['t9', 't10'],
  ], Array(11).fill(600_000), 3_600_000)
})

test('team_orchestrate 工具超时：缺席、坏计划和空任务一律 fail-closed 到 1h 护栏', () => {
  assert.equal(timeoutOf(), 3_600_000)
  for (const input of [{ objective: 'x' }, { planJson: '{' }, { planJson: planJsonOf([]) }]) {
    const timeout = timeoutOf({ input, toolUseId: 'fallback', cwd: '/repo', sessionId: 'no-such-session' })
    assert.equal(timeout, 3_600_000)
    assert.equal(timeout, TEAM_TIMEOUT_CEIL_MS)
  }
})

test('team_orchestrate 工具超时：原两波输入按 single-attempt 完整预算定价，早期 turn 不截短 profile', () => {
  const completeTimeout = assertExecutionBudget(TWO_WAVE_PLAN, [['a', 'b', 'c'], ['d', 'e', 'f']], Array(6).fill(600_000), 1_830_000)
  for (const sessionTurnCount of [0, 4, 10]) {
    assert.equal(timeoutOf({ input: { planJson: TWO_WAVE_PLAN }, toolUseId: 'tu_5', cwd: '/repo', sessionId: 's5', sessionTurnCount }), completeTimeout)
  }
})

test('team_orchestrate 工具超时：peek 使用真实两波预算，重复读取保留完整计划供 execute 消费', () => {
  const sessionId = 'peek-session'
  storePlan(TWO_WAVE_PLAN, sessionId)
  try {
    const completeTimeout = assertExecutionBudget(TWO_WAVE_PLAN, [['a', 'b', 'c'], ['d', 'e', 'f']], Array(6).fill(600_000), 1_830_000)
    for (let peek = 0; peek < 2; peek++) {
      assert.equal(timeoutOf({ input: { objective: 'x' }, toolUseId: 'tu_6', cwd: '/repo', sessionId }), completeTimeout)
      assert.equal(getStoredPlan(sessionId), TWO_WAVE_PLAN)
    }
    assert.equal(consumePlan(sessionId), TWO_WAVE_PLAN)
    assert.equal(getStoredPlan(sessionId), null)
  } finally {
    consumePlan(sessionId)
  }
})

test('team_orchestrate 工具超时：原 shape 输入完整十文件预算比单文件严格增加且不虚假饱和', () => {
  const bigFiles = Array.from({ length: 10 }, (_entry, index) => `src/f${index}.ts`)
  const singleBigTask = planJsonOf([PATCHER_TASK('big', bigFiles)])
  const big = assertExecutionBudget(singleBigTask, [['big']], [1_005_000], 1_537_500)
  const small = assertExecutionBudget(SINGLE_TASK_PLAN, [['a']], [600_000], 930_000)
  assert.equal(big - small, 607_500)
  assert.ok(big > small, '完整 shape 定价必须增加外层预算，不能退化为 flat profile')
  assert.ok(big < TEAM_TIMEOUT_CEIL_MS)
})

test('team_orchestrate 工具超时：不同 shape 单调增长，worker 30min 帽与 tool 1h 帽各自保留', () => {
  let previous = 0
  for (const [fileCount, baseBudget, outerBudget] of [
    [1, 600_000, 930_000], [2, 645_000, 997_500], [10, 1_005_000, 1_537_500],
    [27, 1_770_000, 2_685_000], [28, 1_800_000, 2_730_000], [100, 1_800_000, 2_730_000],
  ] as const) {
    const files = Array.from({ length: fileCount }, (_entry, index) => `src/shape-${index}.ts`)
    const timeout = assertExecutionBudget(planJsonOf([PATCHER_TASK('shape', files)]), [['shape']], [baseBudget], outerBudget)
    assert.ok(timeout >= previous)
    assert.ok(timeout < TEAM_TIMEOUT_CEIL_MS)
    previous = timeout
  }
})

test('team_orchestrate 工具超时：混合 shape 跨波取完整最坏预算，增加波次单调且最终封顶', () => {
  const tasks = [1, 2, 10, 1, 1, 2, 1].map((fileCount, index) =>
    PATCHER_TASK(`mixed${index}`, Array.from({ length: fileCount }, (_entry, file) => `src/mixed${index}-${file}.ts`)))
  const one = assertExecutionBudget(planJsonOf(tasks.slice(0, 3)), [['mixed0', 'mixed1', 'mixed2']], [600_000, 645_000, 1_005_000], 1_537_500)
  const two = assertExecutionBudget(planJsonOf(tasks.slice(0, 6)), [['mixed0', 'mixed1', 'mixed2'], ['mixed3', 'mixed4', 'mixed5']], [600_000, 645_000, 1_005_000, 600_000, 600_000, 645_000], 3_045_000)
  const three = assertExecutionBudget(planJsonOf(tasks), [['mixed0', 'mixed1', 'mixed2'], ['mixed3', 'mixed4', 'mixed5'], ['mixed6']], [600_000, 645_000, 1_005_000, 600_000, 600_000, 645_000, 600_000], 3_600_000)
  assert.ok(one < two && two < three)
  assert.equal(three, TEAM_TIMEOUT_CEIL_MS)
})

test('team_orchestrate 工具超时：依赖链按真实串行三波计价，不按任务数除并发低估', () => {
  const tasks = [PATCHER_TASK('a', ['src/a.ts']), PATCHER_TASK('b', ['src/b.ts']), PATCHER_TASK('c', ['src/c.ts'])]
  tasks[1]!.dependsOn = ['a']
  tasks[2]!.dependsOn = ['b']
  assertExecutionBudget(planJsonOf(tasks), [['a'], ['b'], ['c']], Array(3).fill(600_000), 2_730_000)
})

test('team_orchestrate 工具超时：同文件写冲突按真实串行三波计价', () => {
  const tasks = ['a', 'b', 'c'].map(id => PATCHER_TASK(id, ['src/shared.ts']))
  assertExecutionBudget(planJsonOf(tasks), [['a'], ['b'], ['c']], Array(3).fill(600_000), 2_730_000)
})

test('team_orchestrate 工具超时：读工多文件不套写工 shape，混合波仍覆盖最慢写工', () => {
  const scout: TeamTask = {
    ...PATCHER_TASK('scout', Array.from({ length: 100 }, (_entry, index) => `src/scout-${index}.ts`)),
    profile: 'code_scout',
    kind: 'code_search',
  }
  const patcher = PATCHER_TASK('patcher', Array.from({ length: 10 }, (_entry, index) => `src/write-${index}.ts`))
  assertExecutionBudget(planJsonOf([scout, patcher]), [['patcher', 'scout']], [480_000, 1_005_000], 1_537_500)
})

test('team_orchestrate 工具超时：显式坏计划不能偷用旧 plan-store，且不消费旧计划', () => {
  const sessionId = 'invalid-explicit-plan'
  storePlan(TWO_WAVE_PLAN, sessionId)
  try {
    assert.equal(timeoutOf({ input: { planJson: '{' }, toolUseId: 'invalid-plan', cwd: '/repo', sessionId }), 3_600_000)
    assert.equal(getStoredPlan(sessionId), TWO_WAVE_PLAN)
  } finally {
    consumePlan(sessionId)
  }
})

test('team_orchestrate single-attempt 安全合同：runtime 续跑、hands 总账及修复预留均为零', () => {
  assert.equal(MAX_BUDGET_CONTINUATIONS, 0)
  assert.equal(MAX_HANDS_EXTRA_RUNS, 0)
  assert.equal(HANDS_GATE_REPAIR_RESERVE, 0)
})

for (const failureReason of ['timeout', 'max_turns'] as const) {
  test(`team_orchestrate single-attempt 安全合同：${failureReason} 即使有产出与完整历史也不能自动续跑`, () => {
    const result: WorkerResult = {
      workOrderId: 'single-attempt', status: 'blocked', summary: 'productive budget exhaustion',
      findings: [], artifacts: [], changedFiles: ['src/partial.ts'], risks: [], nextActions: [],
      evidenceStatus: 'unverified', failureReason,
    }
    for (const isWrite of [false, true]) {
      assert.equal(decideContinuation({
        result, attempt: 0, aborted: false, isWrite, sharedWorktree: true,
        hasSessionMessages: true, productivity: { toolCalls: 99 },
      }).proceed, false)
    }
    assert.equal(decideHandsContinuation({ result, attempt: 0, extraRunsUsed: 0, aborted: false }).proceed, false)
  })
}

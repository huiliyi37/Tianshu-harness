/**
 * WorkProgressFacts 单测（P0）：任务边界 / 工作版本 / 进展去重 / 验证执行事实 /
 * 每 modelTurn 快照的单次装配语义。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WorkProgressFacts, computeRepeatedVerificationSignal } from '../work-progress-facts.js'
import { EvidenceTracker } from '../evidence.js'
import type { AgentLoop } from '../loop.js'
import type { VerificationExecutionIntent } from '../verification-intent.js'

function fixture() {
  const todos: Array<{ id: string; status: string }> = []
  const obligations: Array<{ id: string; state: string }> = []
  const evidence = new EvidenceTracker()
  let waiting: { jobId: string; purpose: string; lifetime: string; ownerTaskEpoch: number; waitUntil: number; budgetSource: string } | null = null
  const self = {
    config: { getTodos: () => todos },
    obligations: { getStore: () => ({ obligations }) },
    evidence,
    jobs: { verificationWaitInfo: () => waiting },
  }
  const facts = new WorkProgressFacts(self as unknown as AgentLoop)
  return { facts, todos, obligations, evidence, setWaiting: (w: typeof waiting) => { waiting = w } }
}

const intent = {
  purpose: 'test', lifetime: 'finite', waitingEligible: true, allowsCompletionEvidence: true,
  entry: 'node', cwd: '/tmp', argv: null,
  scope: { scope: 'targeted', kind: 'test', targetFiles: ['a.test.ts'] },
  source: 'node-test',
} as VerificationExecutionIntent

test('任务边界：仅 recordHumanTaskBoundary 递增；存量被吞（不产进展）', () => {
  const { facts, todos } = fixture()
  assert.equal(facts.taskEpoch, 0)
  todos.push({ id: 'pre-existing', status: 'completed' })
  facts.recordHumanTaskBoundary()
  assert.equal(facts.taskEpoch, 1)
  facts.beginModelTurn(1)
  assert.equal(facts.progressRevision, 0, '边界前的完成态是小基线，不算新任务进展')
  facts.recordHumanTaskBoundary()
  assert.equal(facts.taskEpoch, 2)
})

test('工作版本：仅 changed 登记 mutationRevision；unchanged/unknown 不推进也不伪造', () => {
  const { facts } = fixture()
  assert.equal(facts.recordFileProgress({ outcome: 'unchanged' }), false)
  assert.equal(facts.recordFileProgress({ outcome: 'unknown' }), false)
  assert.equal(facts.mutationRevision, 0)
  assert.equal(facts.recordFileProgress({ outcome: 'changed' }), true)
  assert.equal(facts.recordFileProgress({ outcome: 'changed' }), true)
  assert.equal(facts.mutationRevision, 2)
})

test('验证执行启动事实：章为启动时刻的 taskEpoch/mutationRevision，序号单调', () => {
  const { facts, setWaiting } = fixture()
  facts.recordVerificationExecutionStart(intent)
  facts.recordFileProgress({ outcome: 'changed' })
  facts.recordHumanTaskBoundary()
  facts.recordVerificationExecutionStart(intent)
  const execs = facts.recentVerificationExecutions()
  assert.equal(execs.length, 2)
  assert.deepEqual(
    { seq: execs[0]!.sequence, finite: execs[0]!.finite, epoch: execs[0]!.taskEpochAtStart, rev: execs[0]!.mutationRevisionAtStart },
    { seq: 1, finite: true, epoch: 0, rev: 0 },
  )
  assert.deepEqual(
    { seq: execs[1]!.sequence, epoch: execs[1]!.taskEpochAtStart, rev: execs[1]!.mutationRevisionAtStart },
    { seq: 3, epoch: 1, rev: 1 },
    '迟到结果以启动章为准——后续编辑不影响已登记事实',
  )
  setWaiting(null) // no-op：占位确保 fixture API 可用
})

test('每 modelTurn 快照：单次消费（同一进展不重复计）；值在装配时冻结', () => {
  const { facts, todos } = fixture()
  facts.beginModelTurn(1)
  todos.push({ id: 't1', status: 'completed' })
  facts.beginModelTurn(2)
  assert.equal(facts.progressRevision, 1)
  const snap = facts.currentSnapshot()
  assert.equal(snap?.progressRevision, 1)
  assert.equal(snap?.lastMeaningfulProgressModelTurn, 2)
  assert.equal(snap?.lastProgressReason, 'progress:todo-completed')
  facts.beginModelTurn(3)
  assert.equal(facts.progressRevision, 1, '重复装配不重复消费')
  assert.equal(facts.currentSnapshot()?.modelObservationTurn, 3)
})

test('快照携带 waitingVerification 投影；未装配时 currentSnapshot 为 null', () => {
  const { facts, setWaiting } = fixture()
  assert.equal(facts.currentSnapshot(), null, '首装配前无事实——不伪造')
  setWaiting({ jobId: 'j1', purpose: 'test', lifetime: 'finite', ownerTaskEpoch: 0, waitUntil: Date.now() + 1000, budgetSource: 'input-timeout' })
  facts.beginModelTurn(1)
  assert.equal(facts.currentSnapshot()?.waitingVerification?.jobId, 'j1')
  setWaiting(null)
  facts.beginModelTurn(2)
  assert.equal(facts.currentSnapshot()?.waitingVerification, null)
})

// ── P1：重复验证信号（computeRepeatedVerificationSignal）──

function execFact(over: Partial<import('../work-progress-facts.js').VerificationExecutionStart> = {}): import('../work-progress-facts.js').VerificationExecutionStart {
  return {
    sequence: 1, purpose: 'test', life: 'finite', finite: true, waitingEligible: true,
    cwd: '/tmp', settled: true, obligationKey: '[]',
    scope: { scope: 'full', kind: 'test' }, taskEpochAtStart: 0, mutationRevisionAtStart: 0,
    modelTurnAtStart: 29, at: 0, ...over,
  }
}

test('重复验证区分目标、完成状态及当前实际动作，unknown 不冒充已知身份', () => {
  const signal = (executions: any[], extra = {}) => computeRepeatedVerificationSignal({
    executions, taskEpoch: 0, lastMutationSequence: -1, modelObservationTurn: 30,
    lastMeaningfulProgressModelTurn: 1, taskStartModelTurn: 0, lastToolExecutionSequence: 3, ...extra,
  })
  const a = execFact({ sequence: 2, modelTurnAtStart: 29, ...{ cwd: '/tmp', settled: true }, scope: { scope: 'targeted', kind: 'test', ...{ targetFiles: ['a.test.ts'] } } })
  const b = execFact({ ...a, sequence: 3, scope: { scope: 'targeted', kind: 'test', ...{ targetFiles: ['b.test.ts'] } } })
  assert.equal(signal([a, b])?.count, 1, '不同目标不能归并为重复')
  assert.equal(signal([a, { ...a, sequence: 3, settled: false }])?.count, 1, '未结束的执行不能冒充已完成验证')
  assert.equal(signal([a, { ...a, sequence: 3, obligationKey: '["new-obligation"]' }])?.count, 1, '新义务不能与旧义务重复执行归并')
  assert.equal(signal([a, { ...a, sequence: 3 }], { lastToolExecutionSequence: 4 })?.currentRerun, false, '后来读取/汇报已经离开验证动作')
  assert.equal(signal([a, { ...a, sequence: 3 }], { modelObservationTurn: 40 })?.currentRerun, false, '启动事实不能永久占据当前动作')
  assert.equal(signal([{ ...a, scope: { scope: 'unknown' } }]), undefined)
})

test('computeRepeatedVerificationSignal：同身份同版本 ≥2 + 当前重跑 + 进展年龄', () => {
  const sig = computeRepeatedVerificationSignal({
    executions: [execFact({ sequence: 2 }), execFact({ sequence: 4 })],
    taskEpoch: 0, lastMutationSequence: 1, modelObservationTurn: 30,
    lastToolExecutionSequence: 4,
    lastMeaningfulProgressModelTurn: 5, taskStartModelTurn: 3,
  })
  assert.ok(sig, 'identity 可确认')
  assert.equal(sig!.count, 2)
  assert.equal(sig!.currentRerun, true, '验证晚于最后一次写入')
  assert.equal(sig!.turnsSinceProgress, 25)
})

test('identity 不可确认（scope null）→ undefined 不启动；跨工作版本重跑不计入', () => {
  const noscope = computeRepeatedVerificationSignal({
    executions: [execFact({ scope: null })], taskEpoch: 0, lastMutationSequence: -1,
    modelObservationTurn: 10, lastMeaningfulProgressModelTurn: -1, taskStartModelTurn: 0,
  })
  assert.equal(noscope, undefined, 'identity 不可确认时不启动软判据')

  const versioned = computeRepeatedVerificationSignal({
    executions: [execFact({ sequence: 2, mutationRevisionAtStart: 0 }), execFact({ sequence: 4, mutationRevisionAtStart: 1 })],
    taskEpoch: 0, lastMutationSequence: 4, modelObservationTurn: 10,
    lastMeaningfulProgressModelTurn: -1, taskStartModelTurn: 0,
  })
  assert.equal(versioned!.count, 1, '版本变化后的重跑不冒充同版本重复')
  assert.equal(versioned!.currentRerun, false, '最后写入晚于验证 → 非当前重跑')
})

test('无进展记录时 turnsSinceProgress 从任务起点起算；watch（非 finite）不参与', () => {
  const sig = computeRepeatedVerificationSignal({
    executions: [execFact({ sequence: 2 }), execFact({ sequence: 4 })],
    taskEpoch: 0, lastMutationSequence: 1, modelObservationTurn: 25,
    lastToolExecutionSequence: 4,
    lastMeaningfulProgressModelTurn: -1, taskStartModelTurn: 8,
  })
  assert.equal(sig!.turnsSinceProgress, 17)

  const watchOnly = computeRepeatedVerificationSignal({
    executions: [execFact({ finite: false, life: 'persistent' })],
    taskEpoch: 0, lastMutationSequence: -1, modelObservationTurn: 30,
    lastMeaningfulProgressModelTurn: 5, taskStartModelTurn: 3,
  })
  assert.equal(watchOnly, undefined, 'watch 无有限性，不构成重复验证')
})

test('真实文件进展刷新停滞年龄，新任务不会继承旧任务进展时间', () => {
  const { facts, todos } = fixture()
  facts.beginModelTurn(1)
  todos.push({ id: 't', status: 'completed' })
  facts.beginModelTurn(2)
  facts.beginModelTurn(40)
  const revision = facts.progressRevision
  facts.recordFileProgress({ outcome: 'changed' })
  facts.beginModelTurn(41)
  assert.equal(facts.currentSnapshot()?.lastMeaningfulProgressModelTurn, 40)
  assert.equal(facts.progressRevision, revision + 1)
  facts.beginModelTurn(50)
  facts.recordHumanTaskBoundary()
  facts.beginModelTurn(51)
  const snap = facts.currentSnapshot()!
  const signal = computeRepeatedVerificationSignal({ ...snap, executions: [execFact({ taskEpochAtStart: snap.taskEpoch })] })
  assert.equal(signal?.turnsSinceProgress, 1)
  assert.equal(facts.progressRevision, revision + 1, '新任务不倒退 revision，也不虚构进展')
})

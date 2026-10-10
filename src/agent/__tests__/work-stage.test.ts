/**
 * P2 验收矩阵（《收敛阶段补修》§5 转换表 + §2.2 完成条件）：工作相位确认器。
 *
 * 逐行覆盖：execute→verify 即时（含重复启动不重置）、verify 内读/await/失败保持、
 * 验证后新真实写入→execute（版本去重）、同轮写+新版本验证落 verify、迟到旧验证
 * 不绑新版本、新任务重置、plan 结构化事件、弱候选两轮一致（抖动/同轮重复采样
 * 不计）、首次 provisional 仅一次、无强事实退回拒绝、deliver 进入与变更回退、
 * 编辑期待守卫、explicit 约束下写入不切相位、快照缺失不伪造。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { confirmWorkStage, createWorkStageState, WorkStage, STAR_PHASE_FOR_CLASS, type WorkStageState } from '../work-stage.js'
import { PHASE_CLASS_MAP } from '../phase-class.js'
import type { WorkStageConfirmInput } from '../work-stage.js'
import type { WorkFactSnapshot, VerificationExecutionStart } from '../work-progress-facts.js'
import type { EditExpectation } from '../edit-expectation.js'

function snap(over: Partial<WorkFactSnapshot> = {}): WorkFactSnapshot {
  return {
    modelObservationTurn: 1,
    taskEpoch: 0,
    taskStartModelTurn: 0,
    mutationRevision: 0,
    lastMutationSequence: -1,
    progressRevision: 0,
    lastProgressReason: null,
    lastMeaningfulProgressModelTurn: -1,
    waitingVerification: null,
    latestVerificationExecution: null,
    ...over,
  }
}

function exec(over: Partial<VerificationExecutionStart> = {}): VerificationExecutionStart {
  return {
    sequence: 1,
    purpose: 'test',
    life: 'finite',
    finite: true,
    waitingEligible: true,
    scope: { scope: 'full', kind: 'test' },
    taskEpochAtStart: 0,
    mutationRevisionAtStart: 0,
    modelTurnAtStart: 0,
    at: 0,
    ...over,
  }
}

function stage(over: Partial<WorkStageState> = {}): WorkStageState {
  return { ...createWorkStageState(), taskEpoch: 0, ...over }
}

type StepOver = Partial<Omit<WorkStageConfirmInput, 'snapshot' | 'verificationExecutions'>> & {
  snapshot?: WorkFactSnapshot | null
  verificationExecutions?: VerificationExecutionStart[]
}

function step(state: WorkStageState, over: StepOver = {}) {
  return confirmWorkStage(state, {
    modelObservationTurn: 2,
    snapshot: snap(),
    verificationExecutions: [],
    rawCandidate: 'explore',
    candidateSource: 'sensorium',
    deliveryReady: false,
    ...over,
  })
}

const NOT_REQUIRED_TASK: EditExpectation = { kind: 'not-required', source: 'task-kind', reason: '只读/审查类' }
const NOT_REQUIRED_EXPLICIT: EditExpectation = { kind: 'not-required', source: 'explicit-no-mutation', reason: '用户明确只读' }
const UNKNOWN_EXPECTATION: EditExpectation = { kind: 'unknown', source: 'no-classification', reason: '未分类' }

test('映射完整性：5 个 PhaseClass 的代表 StarPhase 与 PHASE_CLASS_MAP 反映射一致', () => {
  for (const [cls, star] of Object.entries(STAR_PHASE_FOR_CLASS)) {
    assert.equal(PHASE_CLASS_MAP[star], cls, `${cls} → ${star}`)
  }
  assert.equal(Object.keys(STAR_PHASE_FOR_CLASS).length, 5)
})

test('转换表①：execute 后启动关联当前版本的有限验证 → verify 即时（验证启动是活动）', () => {
  const s0 = stage({ committedPhase: 'execute', initialized: true, consumedMutationRevision: 0, enteredModelTurn: 1 })
  const r = step(s0, {
    snapshot: snap({ lastMutationSequence: 3 }),
    verificationExecutions: [exec({ sequence: 5 })],
  })
  assert.equal(r.decision.committedPhase, 'verify')
  assert.equal(r.decision.transition, 'switched')
  assert.equal(r.state.enteredModelTurn, 2)
  assert.deepEqual(r.state.verifyStart, { sequence: 5, mutationRevision: 0 })
})

test('转换表①b：已在 verify 的重复验证启动不重置阶段计时', () => {
  const s0 = stage({ committedPhase: 'execute', initialized: true, consumedMutationRevision: 0 })
  const r1 = step(s0, { snapshot: snap({ lastMutationSequence: 3 }), verificationExecutions: [exec({ sequence: 5 })] })
  const r2 = step(r1.state, {
    modelObservationTurn: 3,
    snapshot: snap({ lastMutationSequence: 3 }),
    verificationExecutions: [exec({ sequence: 5 }), exec({ sequence: 6, modelTurnAtStart: 2 })],
  })
  assert.equal(r2.decision.committedPhase, 'verify')
  assert.equal(r2.state.enteredModelTurn, r1.state.enteredModelTurn, '重复启动不重置 enteredModelTurn')
  assert.equal(r2.state.stageEpoch, r1.state.stageEpoch, '重复启动不刷新 stageEpoch')
  assert.equal(r2.state.verifyStart?.sequence, 5, 'verifyStart 仍绑定首次进入版本')
})

test('转换表②：verify 中读取/await（raw 漂 execute 两轮）保持 verify，不刷新宽限', () => {
  const s0 = stage({ committedPhase: 'verify', initialized: true, consumedMutationRevision: 0, enteredModelTurn: 1 })
  const a = step(s0, { modelObservationTurn: 2, rawCandidate: 'execute', snapshot: snap({ lastMutationSequence: 3 }), verificationExecutions: [exec({ sequence: 5 })] })
  assert.equal(a.decision.committedPhase, 'verify')
  const b = step(a.state, { modelObservationTurn: 3, rawCandidate: 'execute', snapshot: snap({ lastMutationSequence: 3 }), verificationExecutions: [exec({ sequence: 5 })] })
  assert.equal(b.decision.committedPhase, 'verify')
  assert.equal(b.state.enteredModelTurn, 1)
  assert.equal(b.state.stageEpoch, s0.stageEpoch)
  assert.equal(b.decision.reason, 'weak-denied-rewind')
})

test('转换表③：verify 中失败（raw 漂 explore 两轮）保持 verify，失败不是编辑也不是进展', () => {
  const s0 = stage({ committedPhase: 'verify', initialized: true, consumedMutationRevision: 0, enteredModelTurn: 1 })
  const a = step(s0, { modelObservationTurn: 2, rawCandidate: 'explore', snapshot: snap({ lastMutationSequence: 3 }) })
  const b = step(a.state, { modelObservationTurn: 3, rawCandidate: 'explore', snapshot: snap({ lastMutationSequence: 3 }) })
  assert.equal(b.decision.committedPhase, 'verify')
  assert.equal(b.state.enteredModelTurn, 1)
})

test('转换表④：验证开始之后的新的真实写入 → execute 即时；同版本不重复切换（版本去重）', () => {
  const s0 = stage({ committedPhase: 'verify', initialized: true, consumedMutationRevision: 0, enteredModelTurn: 1, verifyStart: { sequence: 5, mutationRevision: 0 } })
  const r = step(s0, {
    modelObservationTurn: 3,
    snapshot: snap({ mutationRevision: 1, lastMutationSequence: 6 }),
    verificationExecutions: [exec({ sequence: 5 })],
  })
  assert.equal(r.decision.committedPhase, 'execute')
  assert.equal(r.decision.reason, 'write-after-verify')
  assert.equal(r.state.verifyStart, null)
  // 去重：同版本再次确认不重复切换（stageEpoch/entered 不变）
  const r2 = step(r.state, { modelObservationTurn: 4, snapshot: snap({ mutationRevision: 1, lastMutationSequence: 6 }) })
  assert.equal(r2.decision.committedPhase, 'execute')
  assert.equal(r2.state.stageEpoch, r.state.stageEpoch)
  assert.equal(r2.state.enteredModelTurn, r.state.enteredModelTurn)
})

test('转换表④b：真实"失败→新编辑→新验证"往返即时（execute → 新验证 → verify）', () => {
  const s0 = stage({ committedPhase: 'verify', initialized: true, consumedMutationRevision: 0 })
  const edited = step(s0, { modelObservationTurn: 3, snapshot: snap({ mutationRevision: 1, lastMutationSequence: 6 }), verificationExecutions: [exec({ sequence: 5 })] })
  assert.equal(edited.decision.committedPhase, 'execute')
  const retested = step(edited.state, {
    modelObservationTurn: 4,
    snapshot: snap({ mutationRevision: 1, lastMutationSequence: 6 }),
    verificationExecutions: [exec({ sequence: 5 }), exec({ sequence: 7, mutationRevisionAtStart: 1, modelTurnAtStart: 3 })],
  })
  assert.equal(retested.decision.committedPhase, 'verify')
})

test('转换表④c：同轮"写入+新版本验证"直接落 verify（无中间 execute 闪现）', () => {
  const s0 = stage({ committedPhase: 'verify', initialized: true, consumedMutationRevision: 0, enteredModelTurn: 1 })
  const r = step(s0, {
    modelObservationTurn: 3,
    snapshot: snap({ mutationRevision: 1, lastMutationSequence: 6 }),
    verificationExecutions: [exec({ sequence: 5 }), exec({ sequence: 7, mutationRevisionAtStart: 1, modelTurnAtStart: 3 })],
  })
  assert.equal(r.decision.committedPhase, 'verify')
  assert.equal(r.state.enteredModelTurn, 1, '同轮写+测不重开阶段计时')
})

test('转换表④d：迟到旧版本验证不能把后续编辑版本送回 verify', () => {
  const s0 = stage({ committedPhase: 'execute', initialized: true, consumedMutationRevision: 0 })
  const r = step(s0, {
    modelObservationTurn: 3,
    snapshot: snap({ mutationRevision: 1, lastMutationSequence: 6 }),
    verificationExecutions: [exec({ sequence: 7, mutationRevisionAtStart: 0 })], // 绑定旧版本（rev 0 ≠ 当前 1）
  })
  assert.equal(r.decision.committedPhase, 'execute', '旧验证绑定旧版本，不切 verify')
})

test('转换表⑤：明确的新任务 → 清候选与任务阶段状态，按新任务重新初始化（旧验证不借）', () => {
  const s0 = stage({ committedPhase: 'verify', initialized: true, consumedMutationRevision: 3, verifyStart: { sequence: 5, mutationRevision: 3 } })
  const r = step(s0, {
    modelObservationTurn: 9,
    snapshot: snap({ taskEpoch: 1, mutationRevision: 5 }),
    rawCandidate: 'plan',
    verificationExecutions: [exec({ taskEpochAtStart: 0, sequence: 9 })], // 旧任务的验证
  })
  assert.equal(r.decision.committedPhase, 'plan')
  assert.equal(r.decision.transition, 'initialized')
  assert.equal(r.state.taskEpoch, 1)
  assert.equal(r.state.verifyStart, null)
  assert.equal(r.decision.provisional, true, '新任务首轮按弱候选保守初始化')
})

test('转换表⑤b：新任务首轮有当前任务验证启动 → 直接按强事实初始化 verify', () => {
  const s0 = stage({ committedPhase: 'deliver', initialized: true, taskEpoch: 0 })
  const r = step(s0, {
    modelObservationTurn: 9,
    snapshot: snap({ taskEpoch: 1, lastMutationSequence: 3 }),
    verificationExecutions: [exec({ taskEpochAtStart: 1, sequence: 4, mutationRevisionAtStart: 0 })],
  })
  assert.equal(r.decision.committedPhase, 'verify')
  assert.equal(r.decision.provisional, false)
})

test('转换表⑥：明确进入/重新进入 plan 的结构化事件 → plan 即时（从 execute 可重置）', () => {
  const s0 = stage({ committedPhase: 'execute', initialized: true, consumedMutationRevision: 0, enteredModelTurn: 1 })
  const r = step(s0, { planEntry: true })
  assert.equal(r.decision.committedPhase, 'plan')
  assert.equal(r.decision.reason, 'plan-entered')
  assert.equal(r.state.enteredModelTurn, 2)
})

test('转换表⑦：explore/plan 间弱候选连续两个不同 modelTurn 一致才提交', () => {
  const s0 = stage({ committedPhase: 'explore', initialized: true })
  const a = step(s0, { modelObservationTurn: 2, rawCandidate: 'plan' })
  assert.equal(a.decision.committedPhase, 'explore', '第 1 轮等待')
  assert.equal(a.decision.reason, 'candidate-waiting')
  const b = step(a.state, { modelObservationTurn: 3, rawCandidate: 'plan' })
  assert.equal(b.decision.committedPhase, 'plan', '两轮一致提交')
  assert.equal(b.decision.transition, 'switched')
})

test('转换表⑦b：弱相位 A/B/A/B 抖动不提交、不刷新计时', () => {
  const s0 = stage({ committedPhase: 'explore', initialized: true, enteredModelTurn: 1 })
  let cur = s0
  for (const [t, raw] of [[2, 'plan'], [3, 'execute'], [4, 'plan'], [5, 'execute']] as const) {
    const rr = step(cur, { modelObservationTurn: t, rawCandidate: raw })
    cur = rr.state
    assert.equal(rr.decision.committedPhase, 'explore', `turn=${t} 抖动不提交`)
  }
  assert.equal(cur.stageEpoch, s0.stageEpoch)
  assert.equal(cur.enteredModelTurn, 1)
})

test('转换表⑦c：同轮重复采样不计两轮', () => {
  const s0 = stage({ committedPhase: 'explore', initialized: true })
  const a = step(s0, { modelObservationTurn: 5, rawCandidate: 'plan' })
  const b = step(a.state, { modelObservationTurn: 5, rawCandidate: 'plan' }) // 同一 modelTurn 再采样
  assert.equal(b.decision.committedPhase, 'explore')
  const c = step(b.state, { modelObservationTurn: 6, rawCandidate: 'plan' })
  assert.equal(c.decision.committedPhase, 'plan')
})

test('转换表⑧：新实例/新任务首次弱候选保守初始化一次（provisional），不得每轮初始化', () => {
  const s0 = createWorkStageState()
  const a = step(s0, { modelObservationTurn: 1, rawCandidate: 'plan' })
  assert.equal(a.decision.committedPhase, 'plan')
  assert.equal(a.decision.provisional, true)
  assert.equal(a.decision.transition, 'initialized')
  // 之后 raw 变化走正常两轮，且不再是 provisional
  const b = step(a.state, { modelObservationTurn: 2, rawCandidate: 'execute' })
  const c = step(b.state, { modelObservationTurn: 3, rawCandidate: 'execute' })
  assert.equal(c.decision.committedPhase, 'execute')
  assert.equal(c.decision.provisional, false)
  assert.equal(c.decision.transition, 'switched')
})

test('转换表⑨：execute/verify/deliver 想退回但没有强事实 → 保持原阶段', () => {
  // verify → plan / explore：拒绝
  for (const target of ['plan', 'explore'] as const) {
    const s0 = stage({ committedPhase: 'verify', initialized: true, enteredModelTurn: 1 })
    const a = step(s0, { modelObservationTurn: 2, rawCandidate: target })
    const b = step(a.state, { modelObservationTurn: 3, rawCandidate: target })
    assert.equal(b.decision.committedPhase, 'verify', `verify 退回 ${target} 被拒`)
    assert.equal(b.state.enteredModelTurn, 1)
  }
  // deliver：一切弱候选拒绝（只能被强事实改变）
  for (const target of ['explore', 'plan', 'execute', 'verify'] as const) {
    const s0 = stage({ committedPhase: 'deliver', initialized: true, enteredModelTurn: 1 })
    const a = step(s0, { modelObservationTurn: 2, rawCandidate: target })
    const b = step(a.state, { modelObservationTurn: 3, rawCandidate: target })
    assert.equal(b.decision.committedPhase, 'deliver', `deliver 弱候选 ${target} 被拒`)
  }
  // execute → plan：拒绝
  const s0 = stage({ committedPhase: 'execute', initialized: true, enteredModelTurn: 1 })
  const a = step(s0, { modelObservationTurn: 2, rawCandidate: 'plan' })
  const b = step(a.state, { modelObservationTurn: 3, rawCandidate: 'plan' })
  assert.equal(b.decision.committedPhase, 'execute')
})

test('转换表⑩：deliver 由交付资格进入；随后新变更回 execute、旧绿不锁定', () => {
  const s0 = stage({ committedPhase: 'verify', initialized: true, consumedMutationRevision: 1, enteredModelTurn: 1 })
  const ready = step(s0, { modelObservationTurn: 2, snapshot: snap({ mutationRevision: 1, lastMutationSequence: 6 }), deliveryReady: true })
  assert.equal(ready.decision.committedPhase, 'deliver')
  assert.equal(ready.decision.reason, 'delivery-ready')
  const changed = step(ready.state, { modelObservationTurn: 3, snapshot: snap({ mutationRevision: 2, lastMutationSequence: 7 }) })
  assert.equal(changed.decision.committedPhase, 'execute')
  assert.equal(changed.decision.reason, 'new-change-after-deliver')
  // deliver + 同轮写+新版本验证 → verify（离开 deliver 到验证段）
  const retest = step(ready.state, {
    modelObservationTurn: 3,
    snapshot: snap({ mutationRevision: 2, lastMutationSequence: 7 }),
    verificationExecutions: [exec({ sequence: 8, mutationRevisionAtStart: 2, modelTurnAtStart: 3 })],
  })
  assert.equal(retest.decision.committedPhase, 'verify')
})

test('编辑期待守卫：not-required 时弱候选不把只读/报告任务驱入 execute；unknown/required 允许', () => {
  const s0 = stage({ committedPhase: 'explore', initialized: true })
  const a = step(s0, { modelObservationTurn: 2, rawCandidate: 'execute', editExpectation: NOT_REQUIRED_TASK })
  const b = step(a.state, { modelObservationTurn: 3, rawCandidate: 'execute', editExpectation: NOT_REQUIRED_TASK })
  assert.equal(b.decision.committedPhase, 'explore')
  assert.equal(b.decision.reason, 'weak-denied-edit-expectation')
  // unknown：不锁死（信息不足但不是"确认只读"）
  const c = step(a.state, { modelObservationTurn: 3, rawCandidate: 'execute', editExpectation: UNKNOWN_EXPECTATION })
  assert.equal(c.decision.committedPhase, 'execute')
})

test('explicit-no-mutation：明确只读约束与意外写入冲突 → 留冲突观测，不靠相位切换消掉约束', () => {
  const s0 = stage({ committedPhase: 'verify', initialized: true, consumedMutationRevision: 0 })
  const r = step(s0, {
    modelObservationTurn: 3,
    snapshot: snap({ mutationRevision: 1, lastMutationSequence: 6 }),
    verificationExecutions: [exec({ sequence: 5 })],
    editExpectation: NOT_REQUIRED_EXPLICIT,
  })
  assert.equal(r.decision.committedPhase, 'verify')
  assert.equal(r.state.enteredModelTurn, s0.enteredModelTurn)
})

test('未知不冒充：快照缺失（历史恢复）→ no-fact，不转换也不初始化', () => {
  const s0 = stage({ committedPhase: 'explore', initialized: true })
  const r = step(s0, { snapshot: null, rawCandidate: 'deliver' })
  assert.equal(r.decision.transition, 'no-fact')
  assert.equal(r.decision.committedPhase, 'explore')
  const s1 = createWorkStageState()
  const r2 = step(s1, { snapshot: null, rawCandidate: 'plan' })
  assert.equal(r2.decision.committedPhase, null, '历史恢复不从候选伪造初始状态')
  assert.equal(r2.state.initialized, false)
})

test('类封装：recordPlanEntry 单次消费；实例状态隔离', () => {
  const ws = new WorkStage()
  ws.recordPlanEntry()
  const d1 = ws.confirm({ modelObservationTurn: 1, snapshot: snap(), verificationExecutions: [], rawCandidate: 'explore', candidateSource: 'sensorium', deliveryReady: false })
  assert.equal(d1.committedPhase, 'plan')
  assert.equal(d1.reason, 'plan-entered')
  const d2 = ws.confirm({ modelObservationTurn: 2, snapshot: snap(), verificationExecutions: [], rawCandidate: 'plan', candidateSource: 'sensorium', deliveryReady: false })
  assert.notEqual(d2.reason, 'plan-entered', 'plan 事件单次消费')
  assert.equal(d2.committedPhase, 'plan')
  const ws2 = new WorkStage()
  assert.equal(ws2.getState().committedPhase, null)
  assert.equal(ws2.committedPhase, null)
})

test('P3 类级观测：getLastConfirm 跟随最近决策与来源；未确认前为 null（不伪造）', () => {
  const ws = new WorkStage()
  assert.equal(ws.getLastConfirm(), null)
  const d1 = ws.confirm({ modelObservationTurn: 4, snapshot: snap(), verificationExecutions: [], rawCandidate: 'explore', candidateSource: 'sensorium', deliveryReady: false })
  const obs1 = ws.getLastConfirm()
  assert.ok(obs1)
  assert.equal(obs1.source, 'sensorium')
  assert.equal(obs1.decision.reason, d1.reason)
  assert.equal(obs1.decision.committedPhase, d1.committedPhase)

  const d2 = ws.confirm({ modelObservationTurn: 5, snapshot: snap(), verificationExecutions: [], rawCandidate: 'explore', candidateSource: 'verification-activity', deliveryReady: false })
  const obs2 = ws.getLastConfirm()
  assert.ok(obs2)
  assert.equal(obs2.source, 'verification-activity', '观测跟随最近一次确认的来源')
  assert.equal(obs2.decision.reason, d2.reason)
})

/**
 * EditExpectation 投影单测（P1）。
 *
 * 覆盖矩阵：人类明确约束优先 / 只读与审查类 / 验证步骤（时效与恢复）/
 * 实现类正例 / unknown 边界。投影是评分与文案的共同输入——判错会让
 * "验证/只读步骤"被误催编辑，或让"长期不实施"失去提示。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveEditExpectation, VERIFY_STEP_FRESH_TURNS } from '../edit-expectation.js'
import type { EditExpectationInput } from '../edit-expectation.js'
import type { VerificationExecutionStart } from '../work-progress-facts.js'
import type { IntentTaskKind } from '../intent-retrieval-route.js'

function exec(over: Partial<VerificationExecutionStart> = {}): VerificationExecutionStart {
  return {
    sequence: 5,
    purpose: 'test',
    life: 'finite',
    finite: true,
    waitingEligible: true,
    scope: { scope: 'full', kind: 'test' },
    taskEpochAtStart: 0,
    mutationRevisionAtStart: 0,
    modelTurnAtStart: 10,
    at: 0,
    ...over,
  }
}

function input(over: Partial<EditExpectationInput> = {}): EditExpectationInput {
  return {
    taskKinds: [],
    explicitNoMutation: false,
    executions: [],
    taskEpoch: 0,
    lastMutationSequence: -1,
    modelObservationTurn: 10,
    ...over,
  }
}

test('explicitNoMutation 优先于一切（含实现类 taskKinds）', () => {
  const r = deriveEditExpectation(input({ taskKinds: ['bug_fix'], explicitNoMutation: true }))
  assert.equal(r.kind, 'not-required')
  assert.equal(r.source, 'explicit-no-mutation')
})

test('只读/审查类任务 → not-required（含混合），实现类混入不适用', () => {
  for (const kinds of [
    ['code_explanation'],
    ['usage_question', 'review_audit'],
    ['verification'],
    ['codebase_overview', 'code_explanation'],
  ] as IntentTaskKind[][]) {
    const r = deriveEditExpectation(input({ taskKinds: kinds }))
    assert.equal(r.kind, 'not-required', kinds.join(','))
    assert.equal(r.source, 'task-kind')
  }
  // 实现类 + 只读类混合：不是纯只读/审查 → 不走该分支
  const mixed = deriveEditExpectation(input({ taskKinds: ['code_explanation', 'bug_fix'] }))
  assert.equal(mixed.kind, 'required')
})

test('验证步骤：验证晚于最后写入 → not-required；任何新写入立即恢复 required', () => {
  const inVerify = deriveEditExpectation(input({
    taskKinds: ['bug_fix'],
    executions: [exec({ sequence: 5 })],
    lastMutationSequence: 3,
  }))
  assert.equal(inVerify.kind, 'not-required')
  assert.equal(inVerify.source, 'verifying-step')

  const afterNewEdit = deriveEditExpectation(input({
    taskKinds: ['bug_fix'],
    executions: [exec({ sequence: 5 })],
    lastMutationSequence: 7, // 新写入晚于验证启动
  }))
  assert.equal(afterNewEdit.kind, 'required', '新写入立即离开验证步骤')
})

test('验证步骤时效：超过 VERIFY_STEP_FRESH_TURNS 回到语义默认（不无限期挂起）', () => {
  const stale = deriveEditExpectation(input({
    taskKinds: ['bug_fix'],
    executions: [exec({ sequence: 5, modelTurnAtStart: 10 })],
    lastMutationSequence: 3,
    modelObservationTurn: 10 + VERIFY_STEP_FRESH_TURNS + 1,
  }))
  assert.equal(stale.kind, 'required')
})

test('watch（非 finite）与跨任务验证不构成验证步骤', () => {
  const watchOnly = deriveEditExpectation(input({
    taskKinds: ['bug_fix'],
    executions: [exec({ sequence: 5, finite: false, life: 'persistent' })],
    lastMutationSequence: 3,
  }))
  assert.equal(watchOnly.kind, 'required', 'watch 不获得有限验证步骤语义')

  const otherTask = deriveEditExpectation(input({
    taskKinds: ['bug_fix'],
    executions: [exec({ sequence: 5, taskEpochAtStart: 1 })],
    taskEpoch: 2,
    lastMutationSequence: 3,
  }))
  assert.equal(otherTask.kind, 'required', '上一任务的验证不使当前任务进入验证步骤')
})

test('实现类 → required（bug_fix/refactor/new_feature/performance_diagnosis/architecture_design）', () => {
  for (const kind of ['bug_fix', 'refactor', 'new_feature', 'performance_diagnosis', 'architecture_design'] as IntentTaskKind[]) {
    const r = deriveEditExpectation(input({ taskKinds: [kind] }))
    assert.equal(r.kind, 'required', kind)
    assert.equal(r.source, 'task-kind')
  }
})

test('无分类 / 未覆盖语义组合 → unknown（少催编辑，但不确认只读）', () => {
  const noKind = deriveEditExpectation(input({ taskKinds: [] }))
  assert.equal(noKind.kind, 'unknown')
  assert.equal(noKind.source, 'no-classification')

  const socialOnly = deriveEditExpectation(input({ taskKinds: ['social_idle'] }))
  assert.equal(socialOnly.kind, 'unknown')

  const securityOnly = deriveEditExpectation(input({ taskKinds: ['security_safety'] }))
  assert.equal(securityOnly.kind, 'unknown')
})

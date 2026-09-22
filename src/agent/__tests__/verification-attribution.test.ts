import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createVerificationAttribution, getEffectiveVerifications, isInvocationFailure } from '../verification-attribution.js'
import { createOwnershipLedger } from '../ownership-ledger.js'
import { createWorktreeBaseline, type BaselineSnapshot } from '../worktree-baseline.js'
import { createTaskLedger, type TaskLedgerEvent } from '../task-ledger.js'
import type { VerificationMetadata } from '../../tools/types.js'

function makeOwnership(ownedFiles: string[]) {
  const baseline = createWorktreeBaseline({
    branch: 'main',
    head: 'abc',
    preExistingDirty: [],
    preExistingUntracked: [],
    capturedAt: Date.now(),
  })
  const ledger = createTaskLedger({ taskId: 't1' })
  const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })
  for (const f of ownedFiles) ownership.registerOwned(f)
  return ownership
}

function makeAttribution(ownedFiles: string[]) {
  return createVerificationAttribution({
    ownership: makeOwnership(ownedFiles),
  })
}

describe('verification-attribution — classify verification results by ownership', () => {
  it('classifies passed verification as verified', () => {
    const attr = makeAttribution(['src/tools/git.ts'])
    const result: VerificationMetadata = {
      command: 'npx tsc --noEmit',
      status: 'passed',
      scope: 'full',
      exitCode: 0,
      passed: 1,
      failed: 0,
      skipped: 0,
      durationMs: 100,
    }

    const a = attr.attribute(result)
    assert.equal(a.attribution, 'verified')
    assert.equal(a.isBlocking, false)
  })

  it('classifies failed targeted test on owned files as owned_failure', () => {
    const attr = makeAttribution(['src/tools/git.ts'])
    const result: VerificationMetadata = {
      command: 'npx tsx --test src/tools/__tests__/git.test.ts',
      status: 'failed',
      scope: 'targeted',
      exitCode: 1,
      passed: 5,
      failed: 1,
      skipped: 0,
      durationMs: 200,
    }

    const a = attr.attribute(result)
    assert.equal(a.attribution, 'owned_failure')
    assert.equal(a.isBlocking, true)
  })

  it('classifies failed full test as unattributed non-blocking caveat when ownership is unknown', () => {
    const attr = makeAttribution(['src/tools/git.ts'])
    const result: VerificationMetadata = {
      command: 'npm test',
      status: 'failed',
      scope: 'full',
      exitCode: 1,
      passed: 100,
      failed: 2,
      skipped: 0,
      durationMs: 5000,
    }

    const a = attr.attribute(result)
    assert.equal(a.attribution, 'unattributed_failure')
    assert.equal(a.isBlocking, false)
  })

  it('classifies blocked verification as external_blocked', () => {
    const attr = makeAttribution(['src/tools/git.ts'])
    const result: VerificationMetadata = {
      command: 'npx tsc --noEmit',
      status: 'blocked',
      scope: 'full',
      exitCode: 2,
      passed: 0,
      failed: 0,
      skipped: 0,
      durationMs: 50,
    }

    const a = attr.attribute(result)
    assert.equal(a.attribution, 'external_blocked')
    assert.equal(a.isBlocking, false)
  })

  it('getAggregateAttribution with all passing → verified', () => {
    const attr = makeAttribution(['src/a.ts'])
    const results: VerificationMetadata[] = [
      { command: 'typecheck', status: 'passed', scope: 'full', exitCode: 0, passed: 1, failed: 0, skipped: 0, durationMs: 100 },
      { command: 'tests', status: 'passed', scope: 'full', exitCode: 0, passed: 10, failed: 0, skipped: 0, durationMs: 500 },
    ]

    const agg = attr.getAggregateAttribution(results)
    assert.equal(agg.attribution, 'verified')
    assert.equal(agg.isBlocking, false)
  })

  it('getAggregateAttribution with owned failure → owned_failure', () => {
    const attr = makeAttribution(['src/a.ts'])
    const results: VerificationMetadata[] = [
      { command: 'typecheck', status: 'passed', scope: 'full', exitCode: 0, passed: 1, failed: 0, skipped: 0, durationMs: 100 },
      { command: 'tests', status: 'failed', scope: 'targeted', exitCode: 1, passed: 5, failed: 1, skipped: 0, durationMs: 300 },
    ]

    const agg = attr.getAggregateAttribution(results)
    assert.equal(agg.attribution, 'owned_failure')
    assert.equal(agg.isBlocking, true)
  })

  it('getAggregateAttribution with external blocked → external_blocked', () => {
    const attr = makeAttribution(['src/a.ts'])
    const results: VerificationMetadata[] = [
      { command: 'typecheck', status: 'blocked', scope: 'full', exitCode: 2, passed: 0, failed: 0, skipped: 0, durationMs: 50 },
      { command: 'tests', status: 'passed', scope: 'targeted', exitCode: 0, passed: 3, failed: 0, skipped: 0, durationMs: 200 },
    ]

    const agg = attr.getAggregateAttribution(results)
    assert.equal(agg.attribution, 'external_blocked')
    assert.equal(agg.isBlocking, false)
  })

  it('getAggregateAttribution: failed dominates blocked', () => {
    const attr = makeAttribution(['src/a.ts'])
    const results: VerificationMetadata[] = [
      { command: 'typecheck', status: 'blocked', scope: 'full', exitCode: 2, passed: 0, failed: 0, skipped: 0, durationMs: 50 },
      { command: 'tests', status: 'failed', scope: 'targeted', exitCode: 1, passed: 3, failed: 1, skipped: 0, durationMs: 200 },
    ]

    const agg = attr.getAggregateAttribution(results)
    assert.equal(agg.attribution, 'owned_failure')
    assert.equal(agg.isBlocking, true)
  })

  it('getAggregateAttribution with full-scope failed verification → unattributed_failure caveat', () => {
    const attr = makeAttribution(['src/a.ts'])
    const results: VerificationMetadata[] = [
      { command: 'typecheck', status: 'passed', scope: 'full', exitCode: 0, passed: 1, failed: 0, skipped: 0, durationMs: 100 },
      { command: 'tests', status: 'failed', scope: 'full', exitCode: 1, passed: 3, failed: 1, skipped: 0, durationMs: 200 },
    ]

    const agg = attr.getAggregateAttribution(results)
    assert.equal(agg.attribution, 'unattributed_failure')
    assert.equal(agg.isBlocking, false)
  })

  it('classifies verification invocation failure separately from owned test failure', () => {
    const attr = makeAttribution(['src/tools/git.ts'])
    const result: VerificationMetadata = {
      command: 'run_tests src/tools/__tests__/git.test.ts',
      status: 'failed',
      scope: 'targeted',
      exitCode: 1,
      passed: 0,
      failed: 0,
      skipped: 0,
      durationMs: 100,
      failureKind: 'tool_invocation_failure',
    }

    const a = attr.attribute(result)
    assert.equal(a.attribution, 'tool_invocation_failure')
    assert.equal(a.isBlocking, true)
    assert.match(a.reason, /verification invocation failed/i)
  })

  it('getAggregateAttribution with invocation failure does not report owned_failure', () => {
    const attr = makeAttribution(['src/a.ts'])
    const results: VerificationMetadata[] = [
      { command: 'typecheck', status: 'passed', scope: 'full', exitCode: 0, passed: 1, failed: 0, skipped: 0, durationMs: 100 },
      { command: 'run_tests src/a.test.ts', status: 'failed', scope: 'targeted', exitCode: 1, passed: 0, failed: 0, skipped: 0, durationMs: 100, failureKind: 'tool_invocation_failure' },
    ]

    const agg = attr.getAggregateAttribution(results)
    assert.equal(agg.attribution, 'tool_invocation_failure')
    assert.equal(agg.isBlocking, true)
  })

  it('empty verification list → unverified', () => {
    const attr = makeAttribution(['src/a.ts'])
    const agg = attr.getAggregateAttribution([])
    assert.equal(agg.attribution, 'unverified')
    assert.equal(agg.isBlocking, true)
  })
})

// ─── 2026-09-22: 超时与「无计数验证」不再被误报为 tool_invocation_failure ──────
// 实测来源：docs/analysis/2026-09-22-session-retrospective.md。
// 真实事故形状：`npm run typecheck` 复合命令超时 420s（exit=-1，输出为空），
// 门禁归因为 "Verification invocation failure" 并告诉模型「这不是代码失败」；
// 失败的 typecheck（无测试计数）走同一条路径。两者都逼出 deliver_task 重放。
describe('verification-attribution — timeout / no-count verification fidelity', () => {
  it('isInvocationFailure: timeout is never an invocation failure', () => {
    const result: VerificationMetadata = {
      command: 'npm run typecheck', status: 'failed', scope: 'full',
      exitCode: 1, passed: 0, failed: 0, skipped: 0, durationMs: 420_000,
      failureKind: 'timeout',
    }
    assert.equal(isInvocationFailure(result), false)
  })

  it('isInvocationFailure: explicit producer stamp wins over the shape heuristic', () => {
    const stamped: VerificationMetadata = {
      command: 'run_tests foo.test.ts', status: 'failed', scope: 'targeted',
      exitCode: 1, passed: 0, failed: 0, skipped: 0, durationMs: 10,
      failureKind: 'tool_invocation_failure',
    }
    assert.equal(isInvocationFailure(stamped), true)

    const realFailure: VerificationMetadata = {
      command: 'npm run typecheck', status: 'failed', scope: 'full',
      exitCode: 1, passed: 0, failed: 0, skipped: 0, durationMs: 10,
      failureKind: 'test_failure',
    }
    assert.equal(isInvocationFailure(realFailure), false)
  })

  it('aggregate: timeout surfaces as verification_timeout, not tool_invocation_failure', () => {
    const attr = makeAttribution(['src/a.ts'])
    const agg = attr.getAggregateAttribution([
      { command: 'npm run typecheck', status: 'failed', scope: 'full', exitCode: 1, passed: 0, failed: 0, skipped: 0, durationMs: 420_000, failureKind: 'timeout' },
    ])
    assert.equal(agg.attribution, 'verification_timeout')
    assert.equal(agg.isBlocking, true)
    assert.match(agg.reason, /timed out/)
    assert.match(agg.reason, /may still be running/)
  })

  it('aggregate: a failing no-count verification is not reported as an invocation failure', () => {
    const attr = makeAttribution(['src/a.ts'])
    const agg = attr.getAggregateAttribution([
      { command: 'npm run typecheck', status: 'failed', scope: 'full', exitCode: 1, passed: 0, failed: 0, skipped: 0, durationMs: 900, failureKind: 'test_failure' },
    ])
    assert.notEqual(agg.attribution, 'tool_invocation_failure')
    assert.notEqual(agg.attribution, 'verification_timeout')
  })

  it('ledger path: bash typecheck timeout derives failureKind=timeout from raw facts', () => {
    const events: TaskLedgerEvent[] = [{
      type: 'verification', timestamp: 1,
      command: 'npm run typecheck > /tmp/tc.log 2>&1; echo "EXIT=$?"',
      status: 'failed',
      // 源头记录的原始事实：exitCode + errorClass，passed/failed/skipped 全 0
      // （typecheck 输出不含测试计数，0 是「没有计数」而非「没跑」）
      meta: { scope: 'full', passed: 0, failed: 0, skipped: 0, exitCode: 1, errorClass: 'timeout', timedOut: true },
    }]
    const { effective } = getEffectiveVerifications(events)
    assert.equal(effective[0]?.failureKind, 'timeout')
    assert.equal(isInvocationFailure(effective[0]!), false)
  })

  it('ledger path: affirmative code failure blocks the invocation-failure inference', () => {
    const events: TaskLedgerEvent[] = [{
      type: 'verification', timestamp: 1,
      command: 'npm run typecheck',
      status: 'failed',
      meta: { scope: 'full', passed: 0, failed: 0, skipped: 0, exitCode: 1, errorClass: 'type_error' },
    }]
    const { effective } = getEffectiveVerifications(events)
    assert.equal(effective[0]?.failureKind, 'test_failure')
    assert.equal(isInvocationFailure(effective[0]!), false)
  })

  it('ledger path: a test runner that crashed without a summary is still an invocation failure', () => {
    const events: TaskLedgerEvent[] = [{
      type: 'verification', timestamp: 1,
      command: 'npx tsx --test src/foo.test.ts',
      status: 'failed',
      meta: { scope: 'full', passed: 0, failed: 0, skipped: 0, exitCode: 1 },
    }]
    const { effective } = getEffectiveVerifications(events)
    assert.equal(effective[0]?.failureKind, 'tool_invocation_failure')
    assert.equal(isInvocationFailure(effective[0]!), true)
  })

  it('ledger path: a failing typecheck with no errorClass is not an invocation failure', () => {
    // docs:check 这类命令会打印自己的错误但没有测试计数、也分类不出 errorClass。
    // 旧逻辑把它们一律当 invocation failure；缺失计数不是「没执行」的证据。
    const events: TaskLedgerEvent[] = [{
      type: 'verification', timestamp: 1,
      command: 'npm run docs:check',
      status: 'failed',
      meta: { scope: 'full', passed: 0, failed: 0, skipped: 0, exitCode: 1 },
    }]
    const { effective } = getEffectiveVerifications(events)
    assert.notEqual(effective[0]?.failureKind, 'tool_invocation_failure')
    assert.equal(isInvocationFailure(effective[0]!), false)
  })

  it('ledger path: explicit test_failure stamp is no longer overridden by the heuristic', () => {
    const events: TaskLedgerEvent[] = [{
      type: 'verification', timestamp: 1,
      command: 'npx tsx --test src/foo.test.ts',
      status: 'failed',
      meta: { scope: 'full', passed: 0, failed: 0, skipped: 0, exitCode: 1, failureKind: 'test_failure' },
    }]
    const { effective } = getEffectiveVerifications(events)
    assert.equal(effective[0]?.failureKind, 'test_failure')
  })
})

describe('verification-attribution — run_tests 超时经 ledger 边界仍保持 timeout', () => {
  it('blockedReason=timeout survives the ledger and derives timeout', () => {
    // run_tests 判定 blockedReason: 'timeout'，但 ledger 此前不转发该字段，
    // 下游只看到 status failed + 计数全 0，又退回「像是崩溃」的推断。
    const events: TaskLedgerEvent[] = [{
      type: 'verification', timestamp: 1,
      command: 'run_tests',
      status: 'failed',
      meta: {
        scope: 'full', passed: 0, failed: 0, skipped: 0, exitCode: -1,
        failureKind: 'timeout', blockedReason: 'timeout',
      },
    }]
    const { effective } = getEffectiveVerifications(events)
    assert.equal(effective[0]?.failureKind, 'timeout')
    assert.equal(isInvocationFailure(effective[0]!), false)
  })

  it('derives timeout from blockedReason alone (producer stamped only the reason)', () => {
    const events: TaskLedgerEvent[] = [{
      type: 'verification', timestamp: 1,
      command: 'run_tests foo',
      status: 'failed',
      meta: { scope: 'full', passed: 0, failed: 0, skipped: 0, exitCode: -1, blockedReason: 'timeout' },
    }]
    const { effective } = getEffectiveVerifications(events)
    assert.equal(effective[0]?.failureKind, 'timeout')
  })

  it('a genuine startup failure (blockedReason=invocation_failure) is still an invocation failure', () => {
    const events: TaskLedgerEvent[] = [{
      type: 'verification', timestamp: 1,
      command: 'run_tests foo',
      status: 'failed',
      meta: {
        scope: 'full', passed: 0, failed: 0, skipped: 0, exitCode: -1,
        failureKind: 'tool_invocation_failure', blockedReason: 'invocation_failure',
      },
    }]
    const { effective } = getEffectiveVerifications(events)
    assert.equal(effective[0]?.failureKind, 'tool_invocation_failure')
    assert.equal(isInvocationFailure(effective[0]!), true)
  })
})

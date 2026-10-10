import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assessImpactedTestCoverage, createVerificationAttribution, getEffectiveVerifications, isInvocationFailure } from '../verification-attribution.js'
import { createOwnershipLedger } from '../ownership-ledger.js'
import { createWorktreeBaseline, type BaselineSnapshot } from '../worktree-baseline.js'
import { createTaskLedger, type TaskLedgerEvent } from '../task-ledger.js'
import type { TestCompletionCoverage, VerificationMetadata } from '../../tools/types.js'

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
      scope: 'targeted', targetFiles: ['src/tools/git.ts'],
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
      { command: 'tests', status: 'failed', scope: 'targeted', targetFiles: ['src/a.ts'], exitCode: 1, passed: 5, failed: 1, skipped: 0, durationMs: 300 },
    ]

    const agg = attr.getAggregateAttribution(results)
    assert.equal(agg.attribution, 'owned_failure')
    assert.equal(agg.isBlocking, true)
  })

  it('getAggregateAttribution with external blocked → external_blocked', () => {
    const attr = makeAttribution(['src/a.ts'])
    const results: VerificationMetadata[] = [
      { command: 'typecheck', status: 'blocked', scope: 'full', exitCode: 2, passed: 0, failed: 0, skipped: 0, durationMs: 50 },
      { command: 'tests', status: 'passed', scope: 'targeted', targetFiles: ['src/tools/git.ts'], exitCode: 0, passed: 3, failed: 0, skipped: 0, durationMs: 200 },
    ]

    const agg = attr.getAggregateAttribution(results)
    assert.equal(agg.attribution, 'external_blocked')
    assert.equal(agg.isBlocking, false)
  })

  it('getAggregateAttribution: failed dominates blocked', () => {
    const attr = makeAttribution(['src/a.ts'])
    const results: VerificationMetadata[] = [
      { command: 'typecheck', status: 'blocked', scope: 'full', exitCode: 2, passed: 0, failed: 0, skipped: 0, durationMs: 50 },
      { command: 'tests', status: 'failed', scope: 'targeted', targetFiles: ['src/a.ts'], exitCode: 1, passed: 3, failed: 1, skipped: 0, durationMs: 200 },
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
      scope: 'targeted', targetFiles: ['src/tools/git.ts'],
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
      { command: 'run_tests src/a.test.ts', status: 'failed', scope: 'targeted', targetFiles: ['src/tools/git.ts'], exitCode: 1, passed: 0, failed: 0, skipped: 0, durationMs: 100, failureKind: 'tool_invocation_failure' },
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
      command: 'run_tests foo.test.ts', status: 'failed', scope: 'targeted', targetFiles: ['src/tools/git.ts'],
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

describe('assessImpactedTestCoverage — coverage 缺失的失败不得落进 uncovered', () => {
  // 现场（2026-10-09）：run_tests 的隔离快照里失败（快照只含本会话 owned diff，
  // 未跟踪的依赖不在其中 → 模块缺失）→ 拿不到 per-file coverage。旧逻辑的
  // `if (!c) continue` 把这条失败整条跳过，其文件随后落进 uncovered——那一档的
  // 语义是「从未跑过」，没有外部归因、直接硬拦，于是共享工作区下成为永久缺口。
  const impacted = ['src/server/__tests__/image-gen-model-routes.test.ts']

  it('无 per-file coverage 的失败按命令归因进 failed 档', () => {
    const verifications = [{
      command: "rtk node --import tsx --test 'src/server/__tests__/image-gen-model-routes.test.ts'",
      status: 'failed',
      kind: 'test',
      scope: 'targeted',
      targetFiles: ['src/server/__tests__/image-gen-model-routes.test.ts'],
      exitCode: 1,
      passed: 0,
      failed: 0,
      skipped: 0,
      durationMs: 1000,
      // 故意不带 coverage —— 隔离快照失败时拿不到 per-file 覆盖
    }] as unknown as VerificationMetadata[]

    const out = assessImpactedTestCoverage(impacted, verifications, () => true, process.cwd())
    assert.deepEqual(out.failed, impacted, '失败记录应进 failed 档（那里有外部归因机会）')
    // uncovered 仍会列出它——保持既有的 fail-safe 语义（只看 uncovered 的消费方
    // 不会误以为它被覆盖）；门禁按 failed → uncovered 的顺序检查，先命中可归因的
    // failed 档，因此这条记录不再是没有归因空间的硬拦。
    assert.deepEqual(out.uncovered, impacted)
  })

  it('命令未点名该测试时，仍按「从未跑过」处理', () => {
    const verifications = [{
      command: 'rtk node --import tsx --test src/tools/__tests__/other.test.ts',
      status: 'failed',
      kind: 'test',
      scope: 'full',
      exitCode: 1,
      passed: 0,
      failed: 1,
      skipped: 0,
      durationMs: 100,
    }] as unknown as VerificationMetadata[]

    const out = assessImpactedTestCoverage(impacted, verifications, () => true, process.cwd())
    assert.deepEqual(out.uncovered, impacted, '没被任何失败命令点名 → 仍是 uncovered')
    assert.equal(out.failed, undefined, '不因别处的失败被误判为 failed')
  })

  it('passed 的完整 coverage 仍然照常计入覆盖（兜底不干扰正常路径）', () => {
    const verifications = [{
      command: "rtk node --import tsx --test 'src/server/__tests__/image-gen-model-routes.test.ts'",
      status: 'passed',
      kind: 'test',
      scope: 'targeted',
      exitCode: 0,
      passed: 3,
      failed: 0,
      skipped: 0,
      durationMs: 500,
    }] as unknown as VerificationMetadata[]

    const out = assessImpactedTestCoverage(impacted, verifications, () => true, process.cwd())
    // 没有 coverage 的 passed 不构成覆盖证据（诚实门禁：标签不证明执行）
    assert.deepEqual(out.uncovered, impacted)
    assert.equal(out.failed, undefined)
  })

  it('命令路径形态归一：Windows 反斜杠与 ./ 前缀的命令同样能归因', () => {
    // 405bfc4c1 评审遗留：commandMentionsTest 只归一化测试侧，Windows 的
    // `src\server\...` 反斜杠命令与 `./src/...` 前缀命令会漏配（退回旧行为=硬拦）。
    const base = {
      status: 'failed', kind: 'test', scope: 'targeted', exitCode: 1,
      passed: 0, failed: 0, skipped: 0, durationMs: 1000,
    }
    for (const command of [
      String.raw`node --test src\server\__tests__\image-gen-model-routes.test.ts`,
      "node --test './src/server/__tests__/image-gen-model-routes.test.ts'",
    ]) {
      const out = assessImpactedTestCoverage(
        impacted,
        [{ ...base, command }] as unknown as VerificationMetadata[],
        () => true,
        process.cwd(),
      )
      assert.deepEqual(out.failed, impacted, `命令形态应归因成功: ${command}`)
    }
  })
})

describe('assessImpactedTestCoverage — 覆盖判定逐文件（粒度对齐责任粒度）', () => {
  // 结构规则：验证证据的判定粒度 = 责任的粒度（文件级）。同批中一个文件失败，
  // 不得作废批内其他文件已拿到的通过证据。同构先例：编译器不因一个文件报错就丢掉
  // 其他文件的诊断；CI 矩阵里 job 3 红不作废 job 7 的结果；批量校验一行坏不作废整批。
  const A = 'src/agent/__tests__/a.test.ts'
  const B = 'src/agent/__tests__/b.test.ts'

  function cov(files: TestCompletionCoverage['files']): TestCompletionCoverage {
    return {
      version: 1, runId: 'r', runner: 'node-test', cwd: '/repo', repositoryRoot: '/repo',
      complete: true, filtered: false, files,
    }
  }

  it('同批里一个文件失败，不作废另一个文件的通过证据', () => {
    const verifications = [{
      command: 'rtk node --import tsx --test src/agent/__tests__/*.test.ts',
      status: 'failed',
      kind: 'test',
      scope: 'full',
      exitCode: 1,
      passed: 5,
      failed: 3,
      skipped: 0,
      durationMs: 1000,
      coverage: cov([
        { path: A, outcome: 'passed', tests: 5, skipped: 0, cancelled: 0 },
        { path: B, outcome: 'failed', tests: 3, skipped: 0, cancelled: 0 },
      ]),
    }] as unknown as VerificationMetadata[]

    const out = assessImpactedTestCoverage([A, B], verifications, () => true, '/repo')
    assert.ok(!out.uncovered.includes(A), 'A 确实跑过并通过，不应因同批 B 失败而作废')
    assert.deepEqual(out.failed, [B], 'B 仍如实进 failed 档（失败不因闸门放开而丢失）')
  })

  it('完整性判据不受影响：coverage.complete=false 时整条不作数', () => {
    const incomplete = { ...cov([{ path: A, outcome: 'passed', tests: 5, skipped: 0, cancelled: 0 }]), complete: false }
    const verifications = [{
      command: 'x', status: 'passed', kind: 'test', scope: 'full', exitCode: 0,
      passed: 5, failed: 0, skipped: 0, durationMs: 1, coverage: incomplete,
    }] as unknown as VerificationMetadata[]

    const out = assessImpactedTestCoverage([A], verifications, () => true, '/repo')
    assert.deepEqual(out.uncovered, [A], '证据不完整（executionComplete 未成立）不得充作覆盖')
  })

  it('filtered 的批次同样不作数', () => {
    const filtered = { ...cov([{ path: A, outcome: 'passed', tests: 5, skipped: 0, cancelled: 0 }]), filtered: true }
    const verifications = [{
      command: 'x', status: 'passed', kind: 'test', scope: 'full', exitCode: 0,
      passed: 5, failed: 0, skipped: 0, durationMs: 1, coverage: filtered,
    }] as unknown as VerificationMetadata[]

    const out = assessImpactedTestCoverage([A], verifications, () => true, '/repo')
    assert.deepEqual(out.uncovered, [A], '名称过滤过的运行不证明整文件执行')
  })
})

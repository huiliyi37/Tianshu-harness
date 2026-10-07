import type { TestCompletionCoverage } from '../../tools/types.js'
function completion(files: string[]): TestCompletionCoverage {
  return { version: 1, runId: 'fixture', runner: 'node-test', cwd: '/repo', repositoryRoot: '/repo', complete: true, filtered: false, files: files.map(path => ({ path, outcome: 'passed', tests: 1, skipped: 0, cancelled: 0 })) }
}
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDeliveryGateV2, filterExternalNoise, isJunkExternalPath } from '../delivery-gate-v2.js'
import { createOwnershipLedger } from '../ownership-ledger.js'
import { createWorktreeBaseline, type BaselineSnapshot } from '../worktree-baseline.js'
import { createTaskLedger } from '../task-ledger.js'
import { createVerificationAttribution, assessImpactedTestCoverage } from '../verification-attribution.js'
import type { VerificationMetadata } from '../../tools/types.js'

function makeGate(ownedFiles: string[], externalDirty: string[] = []) {
  const baseline = createWorktreeBaseline({
    branch: 'feat/b1',
    head: 'abc',
    preExistingDirty: externalDirty,
    preExistingUntracked: [],
    capturedAt: Date.now(),
  })
  const ledger = createTaskLedger({ taskId: 't1' })
  for (const f of ownedFiles) ledger.record({ type: 'file_write', path: f })
  const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })
  ownership.autoOwnFromLedger()
  const attr = createVerificationAttribution({ ownership })
  return {
    gate: createDeliveryGateV2({ taskLedger: ledger, ownership, attribution: attr }),
    ledger,
    ownership,
  }
}

describe('delivery-gate-v2 — ownership-aware delivery gate with GREEN/YELLOW/RED', () => {
  it('returns GREEN when owned files are verified', () => {
    const { gate, ledger } = makeGate(['src/tools/git.ts'])
    ledger.record({ type: 'verification', command: 'npx tsx --test', status: 'passed' })

    const result = gate.assess([])
    assert.equal(result.state, 'GREEN')
    assert.equal(result.canDeliver, true)
    assert.equal(result.isBlocked, false)
  })

  it('returns GREEN when no files modified', () => {
    const { gate } = makeGate([])

    const result = gate.assess([])
    assert.equal(result.state, 'GREEN')
    assert.equal(result.canDeliver, true)
  })

  it('returns YELLOW instead of GREEN when baseline is incomplete (issue #369)', () => {
    const baseline = createWorktreeBaseline({
      branch: '',
      head: '',
      preExistingDirty: [],
      preExistingUntracked: [],
      capturedAt: Date.now(),
      complete: false,
    })
    const ledger = createTaskLedger({ taskId: 't-incomplete' })
    ledger.record({ type: 'file_write', path: 'src/tools/git.ts' })
    ledger.record({ type: 'verification', command: 'npx tsx --test', status: 'passed' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })
    ownership.autoOwnFromLedger()
    const attribution = createVerificationAttribution({ ownership })
    const gate = createDeliveryGateV2({ taskLedger: ledger, ownership, attribution })

    const result = gate.assess([])
    assert.equal(result.state, 'YELLOW')
    assert.equal(result.canDeliver, true)
    assert.ok(result.reason!.includes('该工作区不是 git 仓库（或归属基线未能建立）'))
  })

  it('returns RED when owned files are unverified', () => {
    const { gate } = makeGate(['src/tools/git.ts'])

    const result = gate.assess([])
    assert.equal(result.state, 'RED')
    assert.equal(result.canDeliver, false)
    assert.equal(result.isBlocked, true)
  })

  it('returns RED when owned verification fails', () => {
    const { gate, ledger } = makeGate(['src/tools/git.ts'])
    ledger.record({ type: 'verification', command: 'npx tsx --test', status: 'failed', meta: { scope: 'targeted', targetFiles: ['src/tools/git.ts'] } })

    const result = gate.assess([])
    assert.equal(result.state, 'RED')
    assert.equal(result.canDeliver, false)
    assert.ok(result.reason!.includes('failure'))
  })

  it('returns YELLOW when external verification is blocked but owned are verified', () => {
    const { gate, ledger } = makeGate(['src/tools/git.ts'])
    ledger.record({ type: 'verification', command: 'npx tsc --noEmit', status: 'passed' })

    const externalV: VerificationMetadata = {
      command: 'lint',
      status: 'blocked',
      scope: 'full',
      exitCode: 2,
      passed: 0,
      failed: 0,
      skipped: 0,
      durationMs: 50,
    }

    const result = gate.assess([externalV])
    assert.equal(result.state, 'YELLOW')
    assert.equal(result.canDeliver, true)
    assert.equal(result.isBlocked, false)
    assert.ok(result.reason!.includes('external'))
  })

  it('returns YELLOW when no owned files but external files exist', () => {
    const { gate } = makeGate([], ['src/external-dirty.ts'])
    // No owned files, but external files exist → we can deliver our (empty) work
    // but need to note the external dirty files

    const result = gate.assess([])
    // No owned changes → GREEN (nothing to verify)
    assert.equal(result.state, 'GREEN')
    // But external files are noted
    assert.ok(result.externalFileCount! > 0)
  })

  it('getReport returns structured report with all details', () => {
    const { gate, ledger } = makeGate(['src/tools/git.ts', 'src/tools/diff.ts'], ['src/external.ts'])
    ledger.record({ type: 'verification', command: 'npx tsc --noEmit', status: 'passed' })
    ledger.record({ type: 'verification', command: 'npx tsx --test', status: 'passed' })

    const report = gate.getReport([])
    assert.equal(report.state, 'GREEN')
    assert.equal(report.taskId, 't1')
    assert.equal(report.ownedFileCount, 2)
    assert.equal(report.externalFileCount, 1)
    assert.equal(report.verificationCount, 2)
    assert.equal(report.ownedFiles.length, 2)
    assert.deepEqual(report.externalFiles, ['src/external.ts'])
  })

  it('getReport includes RED state with blocking reason', () => {
    const { gate, ledger } = makeGate(['src/tools/git.ts'])
    ledger.record({ type: 'verification', command: 'npx tsx --test', status: 'failed', meta: { scope: 'targeted', targetFiles: ['src/tools/git.ts'] } })

    const report = gate.getReport([])
    assert.equal(report.state, 'RED')
    assert.equal(report.canDeliver, false)
    assert.ok(report.blockingReason)
  })

  it('does not block on historical owned files when no current dirty files are passed', () => {
    const { gate } = makeGate(['src/tools/git.ts'])

    const result = gate.assess([], [])
    assert.equal(result.state, 'GREEN')
    assert.equal(result.canDeliver, true)
    assert.equal(result.isBlocked, false)
    assert.equal(result.ownedFileCount, 0)
  })

  it('blocks on current dirty owned files when unverified', () => {
    const { gate } = makeGate(['src/tools/git.ts'])

    const result = gate.assess([], ['src/tools/git.ts'])
    assert.equal(result.state, 'RED')
    assert.equal(result.canDeliver, false)
    assert.equal(result.isBlocked, true)
    assert.equal(result.ownedFileCount, 1)
  })

  it('excludes external dirty files from current owned gate', () => {
    const { gate } = makeGate(['src/tools/git.ts'], ['src/external-dirty.ts'])

    const result = gate.assess([], ['src/external-dirty.ts'])
    assert.equal(result.state, 'GREEN')
    assert.equal(result.canDeliver, true)
    assert.equal(result.ownedFileCount, 0)
    assert.equal(result.externalFileCount, 1)
  })

  it('returns YELLOW for full-scope failed verification without owned attribution', () => {
    const { gate } = makeGate(['src/tools/git.ts'])
    const fullFailure: VerificationMetadata = {
      command: 'npm test',
      status: 'failed',
      scope: 'full',
      exitCode: 1,
      passed: 100,
      failed: 1,
      skipped: 0,
      durationMs: 1000,
    }

    const result = gate.assess([fullFailure])
    assert.equal(result.state, 'YELLOW')
    assert.equal(result.canDeliver, true)
    assert.equal(result.isBlocked, false)
    assert.match(result.reason!, /unresolved full-suite failure/)
  })

  it('returns YELLOW for full-scope failed ledger verification without owned attribution', () => {
    const { gate, ledger } = makeGate(['src/tools/git.ts'])
    ledger.record({ type: 'verification', command: 'npm test', status: 'failed', meta: { scope: 'full' } })

    const result = gate.assess([])
    assert.equal(result.state, 'YELLOW')
    assert.equal(result.canDeliver, true)
    assert.equal(result.isBlocked, false)
    assert.match(result.reason!, /unresolved full-suite failure/)
  })

  it('does not infer owned failure from missing legacy scope metadata', () => {
    const { gate, ledger } = makeGate(['src/tools/git.ts'])
    ledger.record({ type: 'verification', command: 'run_tests src/tools/__tests__/git.test.ts', status: 'failed' })

    const result = gate.assess([])
    assert.equal(result.state, 'YELLOW')
    assert.equal(result.canDeliver, true)
    assert.equal(result.isBlocked, false)
  })

  it('getReport separates current owned dirty files from historical owned files', () => {
    const { gate } = makeGate(['src/tools/git.ts', 'src/tools/diff.ts'])

    const report = gate.getReport([], ['src/tools/git.ts'])
    assert.equal(report.ownedFileCount, 1)
    assert.deepEqual(report.ownedFiles, ['src/tools/git.ts'])
    assert.deepEqual(report.historicalOwnedFiles, ['src/tools/diff.ts'])
  })

  it('equivalent success supersedes old run_tests invocation failure', () => {
    const { gate, ledger } = makeGate(['src/tools/git.ts'])
    ledger.record({
      type: 'verification',
      command: 'run_tests src/tools/__tests__/git.test.ts',
      status: 'failed',
      meta: { scope: 'targeted', exitCode: 1, passed: 0, failed: 0, skipped: 0 },
    })
    ledger.record({
      type: 'verification',
      command: "tsx --test 'src/tools/__tests__/git.test.ts'",
      status: 'passed',
      meta: { scope: 'targeted', exitCode: 0, passed: 5, failed: 0, skipped: 0 },
    })

    const result = gate.assess([], ['src/tools/git.ts'])
    assert.equal(result.state, 'GREEN')
    assert.equal(result.supersededFailures, 1)
    assert.equal(result.staleFailureCandidates, 1)
  })

  it('returns YELLOW for invocation failure with current owned dirty files', () => {
    const { gate, ledger } = makeGate(['src/tools/git.ts'])
    ledger.record({
      type: 'verification',
      command: 'run_tests src/tools/__tests__/git.test.ts',
      status: 'failed',
      meta: { scope: 'targeted', exitCode: 1, passed: 0, failed: 0, skipped: 0, recommendedCommand: 'tsx --test src/tools/__tests__/git.test.ts' },
    })

    const result = gate.assess([], ['src/tools/git.ts'])
    assert.equal(result.state, 'YELLOW')
    assert.equal(result.isBlocked, false)
    assert.ok(result.reason?.includes('tool invocation'))
    assert.deepEqual(result.toolInvocationFailureCandidates, ['run_tests src/tools/__tests__/git.test.ts'])
    assert.equal(result.shortestNextStep, 'tsx --test src/tools/__tests__/git.test.ts')
  })

  it('keeps invocation failure as low-strength diagnostic when no current owned dirty files', () => {
    const { gate, ledger } = makeGate(['src/tools/git.ts'])
    ledger.record({
      type: 'verification',
      command: 'run_tests src/tools/__tests__/git.test.ts',
      status: 'failed',
      meta: { scope: 'targeted', exitCode: 1, passed: 0, failed: 0, skipped: 0 },
    })

    const result = gate.assess([], [])
    assert.equal(result.state, 'GREEN')
    assert.equal(result.ownedFileCount, 0)
    assert.equal(result.isBlocked, false)
    assert.deepEqual(result.toolInvocationFailureCandidates, ['run_tests src/tools/__tests__/git.test.ts'])
  })
})

describe('external-file noise filtering (C-fix, session 803d897d)', () => {
  it('classifies junk directory paths', () => {
    assert.equal(isJunkExternalPath('.test-tmp/x.json'), true)
    assert.equal(isJunkExternalPath('.rivet/external/y.md'), true)
    assert.equal(isJunkExternalPath('node_modules/pkg/index.js'), true)
    assert.equal(isJunkExternalPath('src/agent/loop.ts'), false)
    assert.equal(isJunkExternalPath('docs/notes.md'), false)
  })

  it('splits signal from noise and counts filtered paths', () => {
    const files = [
      '.test-tmp/a.json',
      '.test-tmp/b.json',
      'src/real.ts',
      '.rivet/external/c.md',
      'docs/keep.md',
    ]
    const split = filterExternalNoise(files)
    assert.deepEqual(split.files, ['src/real.ts', 'docs/keep.md'])
    assert.equal(split.noiseCount, 3)
  })

  it('returns all files when nothing is junk', () => {
    const split = filterExternalNoise(['src/a.ts', 'src/b.ts'])
    assert.deepEqual(split.files, ['src/a.ts', 'src/b.ts'])
    assert.equal(split.noiseCount, 0)
  })

  it('fails open when cwd is not a git repo', () => {
    const split = filterExternalNoise(['src/a.ts'], '/nonexistent-dir-for-test')
    assert.deepEqual(split.files, ['src/a.ts'])
    assert.equal(split.noiseCount, 0)
  })
})

describe('W1 回归防线 — assessImpactedTestCoverage', () => {
  const meta = (over: Partial<VerificationMetadata>): VerificationMetadata => ({
    command: 'npx tsx --test',
    status: 'passed',
    scope: 'targeted',
    kind: 'test',
    exitCode: 0,
    passed: 1,
    failed: 0,
    skipped: 0,
    durationMs: 10,
    coverage: completion(over.targetFiles ?? over.command?.match(/[^ ]+\.test\.ts/g) ?? []),
    ...over,
  })

  it('a full-scope verification covers its explicitly recorded test files', () => {
    const coverage = assessImpactedTestCoverage(
      ['src/a/__tests__/a.test.ts', 'src/b/__tests__/b.test.ts'],
      [meta({ scope: 'full', targetFiles: ['src/a/__tests__/a.test.ts', 'src/b/__tests__/b.test.ts'] })],
      () => true,
    )
    assert.deepEqual(coverage.uncovered, [])
    assert.deepEqual(coverage.uncoverable, [])
  })

  it('targeted verification only covers its target files', () => {
    const coverage = assessImpactedTestCoverage(
      ['src/a/__tests__/a.test.ts', 'src/b/__tests__/b.test.ts'],
      [meta({ command: 'npx tsx --test src/a/__tests__/a.test.ts' })],
      () => true,
    )
    assert.deepEqual(coverage.uncovered, ['src/b/__tests__/b.test.ts'])
    assert.deepEqual(coverage.uncoverable, [])
  })

  it('meta.targetFiles take priority over command extraction', () => {
    const coverage = assessImpactedTestCoverage(
      ['src/a/__tests__/a.test.ts'],
      [meta({ command: 'run_tests filter=a.test', targetFiles: ['src/a/__tests__/a.test.ts'] })],
      () => true,
    )
    assert.deepEqual(coverage.uncovered, [])
  })

  it('deleted/renamed impacted tests go to uncoverable, never uncovered (假阳性防御)', () => {
    const coverage = assessImpactedTestCoverage(
      ['src/gone/__tests__/gone.test.ts', 'src/b/__tests__/b.test.ts'],
      [meta({ command: 'npx tsx --test src/other/__tests__/other.test.ts' })],
      p => !p.includes('gone'),
    )
    assert.deepEqual(coverage.uncovered, ['src/b/__tests__/b.test.ts'])
    assert.deepEqual(coverage.uncoverable, ['src/gone/__tests__/gone.test.ts'])
  })

  it('suffix matching cannot bridge different repository paths', () => {
    const coverage = assessImpactedTestCoverage(
      ['src/a/__tests__/a.test.ts'],
      [meta({ targetFiles: ['a/__tests__/a.test.ts'] })],
      () => true,
    )
    assert.deepEqual(coverage.uncovered, ['src/a/__tests__/a.test.ts'])
  })

  it('failed verifications provide no coverage', () => {
    const coverage = assessImpactedTestCoverage(
      ['src/a/__tests__/a.test.ts'],
      [meta({ status: 'failed', command: 'npx tsx --test src/a/__tests__/a.test.ts', passed: 0, failed: 1, exitCode: 1 })],
      () => true,
    )
    assert.deepEqual(coverage.uncovered, ['src/a/__tests__/a.test.ts'])
  })
})

describe('W1 回归防线 — gate module_unverified', () => {
  it('downgrades GREEN to YELLOW (module_unverified) when impacted tests exist but were never covered', () => {
    const { gate, ledger } = makeGate(['src/tools/git.ts'])
    ledger.record({ type: 'verification', command: 'npx tsx --test src/tools/__tests__/git.test.ts', status: 'passed', meta: { scope: 'targeted', kind: 'test', coverage: completion(['src/tools/__tests__/git.test.ts']), exitCode: 0 } })

    const result = gate.assess([], undefined, undefined, {
      impactedTests: ['src/tools/__tests__/git.test.ts', 'src/agent/__tests__/consumer.test.ts'],
      testExists: () => true,
    })
    assert.equal(result.state, 'YELLOW')
    assert.equal(result.canDeliver, true)
    assert.equal(result.attributionClass, 'module_unverified')
    assert.deepEqual(result.uncoveredImpactedTests, ['src/agent/__tests__/consumer.test.ts'])
    assert.ok(result.reason?.includes('consumer.test.ts'))
  })

  it('stays GREEN when a full-scope verification records coverage for the impacted test', () => {
    const { gate, ledger } = makeGate(['src/tools/git.ts'])
    ledger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full', kind: 'test', coverage: completion(['src/agent/__tests__/consumer.test.ts']), exitCode: 0 } })

    const result = gate.assess([], undefined, undefined, {
      impactedTests: ['src/agent/__tests__/consumer.test.ts'],
      testExists: () => true,
    })
    assert.equal(result.state, 'GREEN')
    assert.equal(result.attributionClass, undefined)
  })

  it('stays GREEN when uncovered tests no longer exist — uncoverable 留痕不阻断', () => {
    const { gate, ledger } = makeGate(['src/tools/git.ts'])
    ledger.record({ type: 'verification', command: 'npx tsx --test src/tools/__tests__/git.test.ts', status: 'passed', meta: { scope: 'targeted', kind: 'test', coverage: completion(['src/tools/__tests__/git.test.ts']), exitCode: 0 } })

    const result = gate.assess([], undefined, undefined, {
      impactedTests: ['src/tools/__tests__/git.test.ts', 'src/deleted/__tests__/old.test.ts'],
      testExists: p => !p.includes('deleted'),
    })
    assert.equal(result.state, 'GREEN')
    assert.deepEqual(result.uncoverableImpactedTests, ['src/deleted/__tests__/old.test.ts'])
  })

  it('does not touch RED/unverified states — coverage check only refines would-be GREEN', () => {
    const { gate } = makeGate(['src/tools/git.ts'])

    const result = gate.assess([], undefined, undefined, {
      impactedTests: ['src/agent/__tests__/consumer.test.ts'],
      testExists: () => true,
    })
    assert.equal(result.state, 'RED')
    assert.equal(result.attributionClass, 'unverified')
  })

  it('no moduleCoverage input → unchanged GREEN behavior', () => {
    const { gate, ledger } = makeGate(['src/tools/git.ts'])
    ledger.record({ type: 'verification', command: 'npx tsx --test src/tools/__tests__/git.test.ts', status: 'passed', meta: { scope: 'targeted', kind: 'test', coverage: completion(['src/tools/__tests__/git.test.ts']), exitCode: 0 } })

    const result = gate.assess([])
    assert.equal(result.state, 'GREEN')
  })
})

// ─── 2026-09-22: 超时不再是「不是代码问题，直接重跑」 ─────────────────────────
describe('delivery gate — verification_timeout', () => {
  it('reports a timed-out verification as verification_timeout with honest guidance', () => {
    const { gate, ledger } = makeGate(['src/tools/git.ts'])
    ledger.record({
      type: 'verification',
      command: 'npm run typecheck',
      status: 'failed',
      meta: {
        scope: 'full', exitCode: 1, passed: 0, failed: 0, skipped: 0,
        errorClass: 'timeout', timedOut: true,
      },
    })

    const result = gate.assess([], ['src/tools/git.ts'])
    assert.equal(result.state, 'YELLOW')
    assert.equal(result.canDeliver, true, 'timeout stays non-blocking for delivery')
    assert.equal(result.attributionClass, 'verification_timeout')
    // 不得再出现旧的误导文案
    assert.ok(!result.reason?.includes('not a code failure'), 'must not claim it is not a code failure')
    assert.match(result.reason ?? '', /timed out/)
    assert.match(result.reason ?? '', /still be running/, 'must warn the process may still be writing')
    // 超时不应被登记为 invocation failure 候选
    assert.deepEqual(result.toolInvocationFailureCandidates, [])
  })

  it('keeps a run_tests startup failure classified as invocation failure', () => {
    const { gate, ledger } = makeGate(['src/tools/git.ts'])
    ledger.record({
      type: 'verification',
      command: 'run_tests src/tools/__tests__/git.test.ts',
      status: 'failed',
      meta: {
        scope: 'targeted', exitCode: -1, passed: 0, failed: 0, skipped: 0,
        failureKind: 'tool_invocation_failure', blockedReason: 'invocation_failure',
        recommendedCommand: 'tsx --test src/tools/__tests__/git.test.ts',
      },
    })

    const result = gate.assess([], ['src/tools/git.ts'])
    assert.equal(result.attributionClass, undefined, 'invocation failure has no explicit attributionClass')
    assert.deepEqual(result.toolInvocationFailureCandidates, ['run_tests src/tools/__tests__/git.test.ts'])
  })
})

describe('8784b64b8 审查 P2 — 覆盖义务不受聚合归因影响', () => {
  const coverageInput = (): Parameters<typeof assessImpactedTestCoverage>[0] =>
    ['src/agent/__tests__/consumer.test.ts']

  it('external_blocked 归因下，未覆盖的 impacted tests 仍被拦为 module_unverified', () => {
    const { gate, ledger } = makeGate(['src/tools/git.ts'])
    ledger.record({ type: 'verification', command: 'npx tsx --test src/tools/__tests__/git.test.ts', status: 'passed', meta: { scope: 'targeted', kind: 'test', coverage: completion(['src/tools/__tests__/git.test.ts']), exitCode: 0 } })
    // 负面证据：一条 blocked 会把聚合抬出 verified（修复前因此整段跳过覆盖检查）
    ledger.record({ type: 'verification', command: 'npm test', status: 'blocked', meta: { scope: 'full' } })

    const result = gate.assess([], undefined, undefined, { impactedTests: coverageInput(), testExists: () => true })

    assert.equal(result.attributionClass, 'module_unverified', '加负面证据不得放宽覆盖义务')
    assert.deepEqual(result.uncoveredImpactedTests, coverageInput())
    assert.equal(result.state, 'YELLOW')
  })

  it('unattributed_failure 归因下同样被拦（审查者对照实验的最小复现）', () => {
    const { gate, ledger } = makeGate(['src/tools/git.ts'])
    ledger.record({ type: 'verification', command: 'npm test', status: 'failed', meta: { scope: 'full', failed: 3 } })

    const result = gate.assess([], undefined, undefined, { impactedTests: coverageInput(), testExists: () => true })

    assert.equal(result.attributionClass, 'module_unverified')
    assert.deepEqual(result.uncoveredImpactedTests, coverageInput())
  })

  it('no_test_infra does not waive coverage for existing impacted tests', () => {
    const { gate, ledger } = makeGate(['src/tools/git.ts'])
    ledger.record({ type: 'verification', command: 'npm test', status: 'blocked', meta: { scope: 'full', blockedReason: 'no_test_framework' } })

    const result = gate.assess([], undefined, undefined, { impactedTests: coverageInput(), testExists: () => true })

    assert.equal(result.attributionClass, 'module_unverified')
    assert.deepEqual(result.uncoveredImpactedTests, coverageInput())
    assert.equal(result.state, 'YELLOW')
  })
})

describe('8784b64b8 审查 P3 — 只有测试类的 full 才算覆盖', () => {
  const meta2 = (over: Partial<VerificationMetadata>): VerificationMetadata => ({
    command: 'npx tsx --test',
    status: 'passed',
    scope: 'targeted',
    kind: 'test',
    exitCode: 0,
    passed: 1,
    failed: 0,
    skipped: 0,
    durationMs: 10,
    coverage: completion(over.targetFiles ?? []),
    ...over,
  })
  const impacted = ['src/agent/__tests__/consumer.test.ts']

  it('passed full typecheck 不清空 uncovered（种类≠范围）', () => {
    const coverage = assessImpactedTestCoverage(impacted, [meta2({ scope: 'full', kind: 'typecheck' })], () => true)
    assert.deepEqual(coverage.uncovered, impacted, 'typecheck 跑遍全仓也不证明任何测试被执行过')
  })

  it('passed full build / lint 同样不清空', () => {
    for (const kind of ['build', 'lint', 'check'] as const) {
      const coverage = assessImpactedTestCoverage(impacted, [meta2({ scope: 'full', kind })], () => true)
      assert.deepEqual(coverage.uncovered, impacted, `${kind} 不构成测试覆盖`)
    }
  })

  it('passed full test with explicit test files can satisfy coverage', () => {
    const coverage = assessImpactedTestCoverage(impacted, [meta2({ scope: 'full', kind: 'test', targetFiles: impacted })], () => true)
    assert.deepEqual(coverage.uncovered, [])
  })

  it('missing kind stays unknown and supplies no test coverage', () => {
    const coverage = assessImpactedTestCoverage(impacted, [meta2({ scope: 'full', kind: undefined, targetFiles: impacted })], () => true)
    assert.deepEqual(coverage.uncovered, impacted)
  })
})

describe('runner boundaries preserve impacted-test obligations', () => {
  it('root full execution does not cover desktop tests without explicit evidence', () => {
    const { gate, ledger } = makeGate(['src/tools/git.ts'])
    ledger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full', kind: 'test' } })
    const path = 'desktop/scripts/__tests__/check-boundary.test.ts'
    const result = gate.assess([], undefined, undefined, { impactedTests: [path], testExists: () => true })
    assert.equal(result.attributionClass, 'module_unverified')
    assert.deepEqual(result.uncoveredImpactedTests, [path])
    assert.equal(result.uncoverableImpactedTests, undefined)
  })

  it('separate targeted test runs can cover multiple suites without one global full run', () => {
    const { gate, ledger } = makeGate(['src/tools/git.ts'])
    const paths = ['src/agent/__tests__/consumer.test.ts', 'desktop/scripts/__tests__/check-boundary.test.ts']
    for (const path of paths) {
      ledger.record({ type: 'verification', command: `node --test ${path}`, status: 'passed', meta: { scope: 'targeted', kind: 'test', targetFiles: [path], coverage: completion([path]), exitCode: 0 } })
    }
    const result = gate.assess([], undefined, undefined, { impactedTests: paths, testExists: () => true })
    assert.equal(result.state, 'GREEN')
    assert.equal(result.uncoveredImpactedTests, undefined)
  })
})

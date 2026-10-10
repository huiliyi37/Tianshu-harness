import type { TestCompletionCoverage } from '../../tools/types.js'
function completion(files: string[]): TestCompletionCoverage {
  return { version: 1, runId: 'fixture', runner: 'node-test', cwd: '/repo', repositoryRoot: '/repo', complete: true, filtered: false, files: files.map(path => ({ path, outcome: 'passed', tests: 1, skipped: 0, cancelled: 0 })) }
}
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDeliveryGateV2, filterExternalNoise, isJunkExternalPath } from '../delivery-gate-v2.js'
import { createOwnershipLedger } from '../ownership-ledger.js'
import { createWorktreeBaseline } from '../worktree-baseline.js'
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
    attr,
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

  it('#369：非 git 工作区（基线不完整）下不报 GREEN——环境结构上无法提交', () => {
    // 非 git 工作区 → 无法建立归属基线、也无法 git commit。此时报 GREEN「就绪可交付」
    // 会让调用方以为可以提交，而 commit=true 必然失败（issue #369 的期望第二条）。
    const baseline = createWorktreeBaseline({
      branch: '',
      head: '',
      preExistingDirty: [],
      preExistingUntracked: [],
      capturedAt: Date.now(),
      complete: false,
    })
    const ledger = createTaskLedger({ taskId: 't369' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })
    const attr = createVerificationAttribution({ ownership })
    const gate = createDeliveryGateV2({ taskLedger: ledger, ownership, attribution: attr })

    const result = gate.assess([])
    assert.notEqual(result.state, 'GREEN', '基线不完整时不能说「就绪可交付」')
    assert.match(String(result.reason), /git/, '原因里要说明是 git/归属基线不可用')
    assert.equal(result.canDeliver, true, '文件已产出，不阻断；只是交付/提交流程不可用')
  })

  it('#共享工作区：无 coverage 的 required 失败不再被当作「从未验证」硬拦', () => {
    // 现场（2026-10-09）：owned 的 config-routes.ts 被并行会话改了，它的下游
    // image-gen-model-routes 测试进我的 required；该测试在隔离快照里因依赖缺失而失败
    //（快照只含本会话 owned diff → 拿不到 per-file coverage）。修复前它整条被
    // `if (!c) continue` 跳过 → 落进 uncovered（语义是「从未跑过」）→ 硬拦，
    // 跑多少次都填不上。修复后归 failed 档，配合外部在途改动证据降级为可交付。
    const { gate, ledger } = makeGate(
      ['src/server/config-routes.ts'],
      ['src/api/image-gen-client.ts'],
    )
    ledger.record({ type: 'verification', command: 'npm run typecheck', status: 'passed', meta: { kind: 'typecheck', scope: 'full', exitCode: 0 } })
    ledger.record({
      type: 'verification',
      command: "rtk node --import tsx --test 'src/server/__tests__/image-gen-model-routes.test.ts'",
      status: 'failed',
      meta: { kind: 'test', scope: 'targeted', exitCode: 1, passed: 0, failed: 0, skipped: 0 },
    })

    const result = gate.assess([], ['src/server/config-routes.ts', 'src/api/image-gen-client.ts'], undefined, {
      impactedTests: ['src/server/__tests__/image-gen-model-routes.test.ts'],
      testExists: () => true,
    })
    // 锁定「归档」这一步（本笔修复的对象）：修复前这条记录落进 uncovered →
    // reason 报 "lack coverage"（那一档没有归因、硬拦）；修复后进 failed 档 →
    // 走可归因路径。最终降级另需 externalFiles 非空（既有的 externallyBlocked
    // 分支，由真实工作区的 dirty 集合构造，本夹具未复现该构造）。
    assert.match(result.reason ?? '', /Required impacted tests failed/, `应走 failed 档（可归因）— state=${result.state} reason=${result.reason}`)
    assert.doesNotMatch(result.reason ?? '', /lack coverage/, '不得被当作「从未跑过」')
  })

  it('returns GREEN when no files modified', () => {
    const { gate } = makeGate([])

    const result = gate.assess([])
    assert.equal(result.state, 'GREEN')
    assert.equal(result.canDeliver, true)
  })

  it('#369：非 git 工作区写入归属文件并验证后仍说明不可提交', () => {
    const baseline = createWorktreeBaseline({ branch: '', head: '', preExistingDirty: [], preExistingUntracked: [], capturedAt: Date.now(), complete: false })
    const ledger = createTaskLedger({ taskId: 'nongit-owned' })
    ledger.record({ type: 'file_write', path: 'feature.ts' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })
    ownership.autoOwnFromLedger()
    const gate = createDeliveryGateV2({ taskLedger: ledger, ownership, attribution: createVerificationAttribution({ ownership }) })

    assert.deepEqual(ownership.getOwnedFiles(), ['feature.ts'])
    const unverified = gate.assess([])
    assert.equal(unverified.state, 'RED', '没有验证仍须阻断，不能提前返回可交付的 YELLOW')
    assert.equal(unverified.canDeliver, false)
    ledger.record({ type: 'verification', command: 'tsc --noEmit', status: 'passed', meta: { kind: 'typecheck', scope: 'full', exitCode: 0 } })
    const verified = gate.assess([])
    assert.equal(verified.state, 'YELLOW')
    assert.equal(verified.canDeliver, true)
    assert.equal(verified.isBlocked, false)
    assert.equal(verified.ownedFileCount, 1)
    assert.match(verified.reason!, /git.*无法提交/)

    const uncovered = gate.assess([], undefined, undefined, { impactedTests: ['feature.test.ts'], testExists: () => true })
    assert.equal(uncovered.state, 'YELLOW')
    assert.deepEqual(uncovered.uncoveredImpactedTests, ['feature.test.ts'], '非 git 说明不能消除 required 测试义务')
    assert.equal(uncovered.attributionClass, 'module_unverified')
    ledger.record({ type: 'verification', command: 'node --test feature.test.ts', status: 'failed', meta: { kind: 'test', scope: 'targeted', targetFiles: ['feature.ts'], exitCode: 1 } })
    const failed = gate.assess([])
    assert.equal(failed.state, 'RED')
    assert.equal(failed.canDeliver, false)
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

  it('整批失败不作废批内逐文件证据（粒度对齐：证据粒度 = 责任粒度）', () => {
    // 语义变更（本笔）：整批状态不再覆盖批内逐文件 outcome。
    // 该 helper 构造的 coverage 声明 a.test.ts 的 outcome 为 passed——它确实跑过并通过，
    // 同批其他文件的失败与它无关。旧行为（整批失败 → 零覆盖）在共享工作区下使 required
    // 全覆盖不可满足：一次全量里 7862 个文件通过，因混入 1 个既有的非本会话失败而
    // 全部作废。同构先例：编译器不因一个文件报错丢掉其他文件的诊断；CI 矩阵里 job 3
    // 红不作废 job 7 的结果。真正的「证据不可信」由 complete / filtered / stale 三条
    // 把关（见同文件另两条用例），与「这批整体成不成功」正交。
    const coverage = assessImpactedTestCoverage(
      ['src/a/__tests__/a.test.ts'],
      [meta({ status: 'failed', command: 'npx tsx --test src/a/__tests__/a.test.ts', passed: 0, failed: 1, exitCode: 1 })],
      () => true,
    )
    assert.deepEqual(coverage.uncovered, [], 'a.test.ts 有逐文件 passed 证据 → 构成覆盖')
  })

  it('无 per-file 证据的失败仍不构成覆盖，且进 failed 档', () => {
    const noCov = meta({ status: 'failed', command: 'npx tsx --test src/a/__tests__/a.test.ts', passed: 0, failed: 1, exitCode: 1 })
    delete (noCov as { coverage?: unknown }).coverage
    const coverage = assessImpactedTestCoverage(['src/a/__tests__/a.test.ts'], [noCov], () => true)
    assert.deepEqual(coverage.uncovered, ['src/a/__tests__/a.test.ts'], '没有执行证据就不构成覆盖')
    assert.deepEqual(coverage.failed, ['src/a/__tests__/a.test.ts'], '但进 failed 档（有外部归因机会）')
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

  it('unattributed_failure + 失败的 impacted test + 确有外部在途改动 → 降级 YELLOW（外部阻塞→scoped 对齐，2026-10-07；判据收紧 2026-10-08）', () => {
    // 与上一条的区别：受影响测试本身在**失败清单**里（有失败证据），而非仅缺证据。
    // 全量失败无法归因到本会话改动（unattributed_failure），且工作区确有其他会话的
    // 在途改动（external dirty）——共享工作区污染理据有正向证据，全量 run_tests
    // 的假红成立。此支降级 YELLOW（可交付 + 仍逐条列出），覆盖义务本身不豁免
    // （守卫 8784b64b8 不变）；本会话回归仍走 owned_failure 硬 RED。
    const { gate, ledger } = makeGate(['src/tools/git.ts'], ['src/other-session.ts'])
    const failedCoverage: TestCompletionCoverage = {
      version: 1, runId: 'fixture', runner: 'node-test', cwd: '/repo', repositoryRoot: '/repo',
      complete: true, filtered: false,
      files: [{ path: coverageInput()[0]!, outcome: 'failed', tests: 1, skipped: 0, cancelled: 0 }],
    }
    ledger.record({ type: 'verification', command: 'npm test', status: 'failed', meta: { scope: 'full', kind: 'test', failed: 1, exitCode: 1, coverage: failedCoverage } })

    const result = gate.assess([], undefined, undefined, { impactedTests: coverageInput(), testExists: () => true })

    assert.equal(result.state, 'YELLOW', '确有外部在途改动时可降级 scoped 交付')
    assert.equal(result.canDeliver, true)
    assert.deepEqual(result.uncoveredImpactedTests, coverageInput(), '失败的受影响测试仍逐条列出供裁决')
    assert.match(result.reason ?? '', /外部在途改动（1 个）/, '降级文案须点名作为证据的外部在途改动')
  })

  it('unattributed_failure + 失败的 impacted test + 无外部在途证据 → 保持 RED（判据收紧，2026-10-08）', () => {
    // 审查发现 4146b08d5 的降级判据宽于理据：任何 full-scope 失败在归因器里恒为
    // unattributed_failure（owned_failure 只来自 targeted owned 失败），单会话干净
    // 工作区「自己改坏 impacted test、只跑了全量」也会命中降级，真失败在报告层
    // 搭便车成 YELLOW（canDeliver=true，而 commit 通路 W1 仍硬拦，语义停在中间态）。
    // 收紧后：无外部在途改动、无隔离单跑配对 → 外部污染理据不成立，保持 RED，
    // 文案指引隔离单跑配对（→ integration_conflict → W1 绕过）的正确出路。
    const { gate, ledger } = makeGate(['src/tools/git.ts'])
    const failedCoverage: TestCompletionCoverage = {
      version: 1, runId: 'fixture', runner: 'node-test', cwd: '/repo', repositoryRoot: '/repo',
      complete: true, filtered: false,
      files: [{ path: coverageInput()[0]!, outcome: 'failed', tests: 1, skipped: 0, cancelled: 0 }],
    }
    ledger.record({ type: 'verification', command: 'npm test', status: 'failed', meta: { scope: 'full', kind: 'test', failed: 1, exitCode: 1, coverage: failedCoverage } })

    const result = gate.assess([], undefined, undefined, { impactedTests: coverageInput(), testExists: () => true })

    assert.equal(result.state, 'RED', '无外部在途证据时全量失败不得降级——真失败不能搭便车成 YELLOW')
    assert.equal(result.canDeliver, false)
    assert.equal(result.isBlocked, true)
    assert.equal(result.attributionClass, 'module_unverified')
    assert.deepEqual(result.uncoveredImpactedTests, coverageInput(), '失败的受影响测试仍逐条列出')
    assert.match(result.reason ?? '', /按真失败处理/)
    assert.match(result.reason ?? '', /隔离单跑配对/, 'RED 文案应指引隔离单跑配对的取证出路')
    assert.ok(result.blockingReason, 'RED 臂须补 blockingReason——commit 路径的 Recovery 段只打印它')
  })

  it('unattributed_failure + 失败的 impacted test + 隔离单跑配对证据 → 降级 YELLOW（判据收紧，2026-10-08）', () => {
    // 无外部在途改动，但存在隔离单跑配对（isolated 通过 + integration 失败、同
    // comparisonId/snapshotRef）——owned diff 隔离可过而集成失败，失败指向外部
    // 集成差异，同样构成「失败非本会话造成」的正向证据。注意配对自己的失败文件
    // 不计入 coverage.failed（assessImpactedTestCoverage 排除）；此处的失败清单
    // 来自另一次无配对的全量失败。
    const { gate, ledger } = makeGate(['src/tools/git.ts'])
    const pairCoverage = (outcome: 'passed' | 'failed'): TestCompletionCoverage => ({
      version: 1, runId: 'fixture', runner: 'node-test', cwd: '/repo', repositoryRoot: '/repo',
      complete: outcome === 'passed', executionComplete: true, filtered: false,
      files: [{ path: 'src/x.test.ts', outcome, tests: 1, skipped: 0, cancelled: 0 }],
    })
    ledger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full', kind: 'test', exitCode: 0, passed: 1, verificationPhase: 'isolated', comparisonId: 'pair-1', snapshotRef: 'snap-1', coverage: pairCoverage('passed') } })
    ledger.record({ type: 'verification', command: 'npm test', status: 'failed', meta: { scope: 'full', kind: 'test', exitCode: 1, failed: 1, verificationPhase: 'integration', comparisonId: 'pair-1', snapshotRef: 'snap-1', coverage: pairCoverage('failed') } })
    const failedCoverage: TestCompletionCoverage = {
      version: 1, runId: 'fixture', runner: 'node-test', cwd: '/repo', repositoryRoot: '/repo',
      complete: true, filtered: false,
      files: [{ path: coverageInput()[0]!, outcome: 'failed', tests: 1, skipped: 0, cancelled: 0 }],
    }
    ledger.record({ type: 'verification', command: 'npm run test:all', status: 'failed', meta: { scope: 'full', kind: 'test', failed: 1, exitCode: 1, coverage: failedCoverage } })

    const result = gate.assess([], undefined, undefined, { impactedTests: coverageInput(), testExists: () => true })

    assert.equal(result.state, 'YELLOW', '隔离单跑配对证明 owned diff 隔离通过，失败指向外部集成差异')
    assert.equal(result.canDeliver, true)
    assert.deepEqual(result.uncoveredImpactedTests, coverageInput())
    assert.match(result.reason ?? '', /隔离单跑配对/)
  })

  it('verification_timeout 聚合压过 unattributed_failure 时保持 RED（RED 臂，即便有外部在途改动）', () => {
    // RED 臂用例（:364-369 此前可达但无用例）：超时与全量失败并存时聚合优先级
    // verification_timeout > unattributed_failure——超时意味着对代码一无所知
    // （底层进程可能仍在写工作区），不享受外部污染降级，即便工作区确有外部在途
    // 改动（证据检查在归因检查之后，归因不匹配时证据不改变结论）。
    const { gate, ledger } = makeGate(['src/tools/git.ts'], ['src/other-session.ts'])
    const failedCoverage: TestCompletionCoverage = {
      version: 1, runId: 'fixture', runner: 'node-test', cwd: '/repo', repositoryRoot: '/repo',
      complete: true, filtered: false,
      files: [{ path: coverageInput()[0]!, outcome: 'failed', tests: 1, skipped: 0, cancelled: 0 }],
    }
    ledger.record({ type: 'verification', command: 'npm test', status: 'failed', meta: { scope: 'full', kind: 'test', failed: 1, exitCode: 1, coverage: failedCoverage } })
    ledger.record({ type: 'verification', command: 'npm run typecheck', status: 'failed', meta: { scope: 'full', exitCode: 1, passed: 0, failed: 0, skipped: 0, errorClass: 'timeout', timedOut: true } })

    const result = gate.assess([], undefined, undefined, { impactedTests: coverageInput(), testExists: () => true })

    assert.equal(result.state, 'RED', '超时压过未归因失败时不降级——超时对代码一无所知')
    assert.equal(result.canDeliver, false)
    assert.equal(result.isBlocked, true)
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

describe('delivery-gate-v2 — L4 越界指纹指引（outOfRootFingerprintPaths，4251eea67 审查 P2）', () => {
  // 词法判定即可：'/fake/repo' 不存在时 canonicalRoot 回落 resolve，classifyFingerprintPath
  // 不碰文件系统——仓内用相对路径、越界用绝对路径，两类的归类都是确定的。
  const ROOT = '/fake/repo'

  function makeRootedGate(ownedFiles: string[], repoRoot?: string) {
    const baseline = createWorktreeBaseline({
      branch: 'feat/b1',
      head: 'abc',
      preExistingDirty: [],
      preExistingUntracked: [],
      capturedAt: Date.now(),
    })
    const ledger = createTaskLedger({ taskId: 'l4-rooted' })
    for (const f of ownedFiles) ledger.record({ type: 'file_write', path: f })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })
    ownership.autoOwnFromLedger()
    return {
      gate: createDeliveryGateV2({
        taskLedger: ledger,
        ownership,
        attribution: createVerificationAttribution({ ownership }),
        ...(repoRoot ? { repoRoot } : {}),
      }),
      ledger,
    }
  }

  it('stale 判废 + 越界 owned 路径并存 → 报告输出越界清单', () => {
    const { gate, ledger } = makeRootedGate(['src/a.ts', '/tmp/l4-out-fixture.ts'], ROOT)
    ledger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full', stale: true } })

    const result = gate.assess([])
    assert.equal(result.staleFingerprintDropped, 1)
    assert.deepEqual(result.outOfRootFingerprintPaths, ['/tmp/l4-out-fixture.ts'], '越界路径要点名，供指引引用')

    const report = gate.getReport([])
    assert.deepEqual(report.outOfRootFingerprintPaths, ['/tmp/l4-out-fixture.ts'], 'DeliveryReport 透传同一字段')
  })

  it('stale 判废但路径全部仓内 → 字段缺席（仓内再编辑是良性多数，不给越界指引）', () => {
    const { gate, ledger } = makeRootedGate(['src/a.ts'], ROOT)
    ledger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full', stale: true } })

    const result = gate.assess([])
    assert.equal(result.staleFingerprintDropped, 1, '计数不受影响——所有 stale 丢弃都计入')
    assert.equal(result.outOfRootFingerprintPaths, undefined)
  })

  it('越界路径但无 stale 判废 → 字段缺席（无判废即无指引）', () => {
    const { gate, ledger } = makeRootedGate(['src/a.ts', '/tmp/l4-out-fixture.ts'], ROOT)
    ledger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full' } })

    const result = gate.assess([])
    assert.equal(result.staleFingerprintDropped, 0)
    assert.equal(result.outOfRootFingerprintPaths, undefined)
  })

  it('未提供 repoRoot → 字段缺席（越界判定需要根；旧装配/测试调用方不受影响）', () => {
    const { gate, ledger } = makeRootedGate(['src/a.ts', '/tmp/l4-out-fixture.ts'])
    ledger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { scope: 'full', stale: true } })

    const result = gate.assess([])
    assert.equal(result.staleFingerprintDropped, 1)
    assert.equal(result.outOfRootFingerprintPaths, undefined)
  })
})

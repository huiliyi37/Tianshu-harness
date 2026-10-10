import test from 'node:test'
import assert from 'node:assert/strict'
import type { WorkerResult } from '../work-order.js'
import type { WorkerTranscript } from '../worker-session.js'
import { reconcileCapturedWorkerFacts, verifyWorkerEvidence } from '../worker-evidence.js'

function result(overrides: Partial<WorkerResult>): WorkerResult {
  return {
    workOrderId: 'wo_1',
    status: 'passed',
    summary: 'ok',
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'unverified',
    ...overrides,
  }
}

function transcript(toolUses: string[], errors: string[] = [], bashCommands?: string[], failedBashCommands?: string[], mutatedFiles?: string[], toolResults: string[] = []): WorkerTranscript {
  return {
    text: '',
    thinking: '',
    toolUses,
    toolResults,
    errors,
    repairAttempts: 0,
    bashCommands,
    failedBashCommands,
    mutatedFiles,
  }
}

test('blocks changed files without verified evidence', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'unverified',
  }))

  assert.equal(checked.status, 'blocked')
  assert.equal(checked.evidenceStatus, 'blocked')
  assert.equal(checked.risks.filter(r => r.includes('unverified')).length, 1)
})

test('blocks self-reported verified result without verification metadata', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'verified',
  }))

  assert.equal(checked.status, 'blocked')
  assert.equal(checked.evidenceStatus, 'blocked')
  assert.ok(checked.risks.some(r => r.includes('missing verification metadata')))
})

test('fails worker result when verification metadata failed', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'verified',
    verification: {
      command: 'npm test',
      status: 'failed',
      scope: 'targeted',
      exitCode: 1,
      passed: 1,
      failed: 1,
      skipped: 0,
      durationMs: 10,
    },
  }))

  assert.equal(checked.status, 'failed')
  assert.equal(checked.evidenceStatus, 'failed')
})

test('does not duplicate an existing risk', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'unverified',
    risks: ['unverified: 1 file(s) changed without verified evidence'],
  }))

  assert.equal(checked.risks.filter(r => r.includes('unverified')).length, 1)
})

test('read-only profile skips verification gate when changedFiles is empty', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    examinedFiles: ['src/auth.ts'],
    evidenceStatus: 'unverified',
  }), 'code_scout')

  assert.equal(checked.status, 'passed')
  assert.equal(checked.evidenceStatus, 'unverified')
  assert.deepEqual(checked.examinedFiles, ['src/auth.ts'])
})

test('read-only profile skips verification gate for reviewer', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    examinedFiles: ['src/config.ts'],
    evidenceStatus: 'unverified',
  }), 'reviewer')

  assert.equal(checked.status, 'passed')
  assert.equal(checked.evidenceStatus, 'unverified')
})

test('passes through read-only worker with examinedFiles and empty changedFiles', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    examinedFiles: ['src/auth.ts', 'src/login.ts'],
    evidenceStatus: 'unverified',
  }))

  assert.equal(checked.status, 'passed')
  assert.equal(checked.evidenceStatus, 'unverified')
  assert.deepEqual(checked.examinedFiles, ['src/auth.ts', 'src/login.ts'])
})

test('downgrades read-only worker self-reported verified to unverified', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    examinedFiles: ['src/config.ts'],
    evidenceStatus: 'verified',
  }))

  assert.equal(checked.status, 'passed')
  assert.equal(checked.evidenceStatus, 'unverified')
  assert.ok(checked.risks.some(r => r.includes('scan-level only')))
})

test('patcher profile gets advisory risk instead of blocked', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'unverified',
  }), 'patcher')

  assert.equal(checked.status, 'passed')
  assert.equal(checked.evidenceStatus, 'unverified')
  assert.ok(checked.risks.some(r => r.includes('advisory')))
})

test('verifier profile (old verifier) now blocked instead of advisory', () => {
  // Old verifier is no longer in WRITE_PROFILES_ADVISORY — treated as regular write worker
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'unverified',
  }), 'verifier')

  assert.equal(checked.status, 'blocked')
  assert.equal(checked.evidenceStatus, 'blocked')
  assert.ok(checked.risks.some(r => r.includes('unverified')))
})

test('adversarial_verifier verified verdict requires run_tests in transcript', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    evidenceStatus: 'verified',
  }), 'adversarial_verifier', transcript(['read_file']))

  assert.equal(checked.status, 'passed')
  assert.equal(checked.evidenceStatus, 'unverified')
  assert.ok(checked.risks.some(r => r.includes('without running run_tests')))
})

test('adversarial_verifier verified verdict without transcript is fail-closed', () => {
  // No transcript provided = cannot prove tests were run = downgrade
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    evidenceStatus: 'verified',
  }), 'adversarial_verifier')

  assert.equal(checked.status, 'passed')
  assert.equal(checked.evidenceStatus, 'unverified')
  assert.ok(checked.risks.some(r => r.includes('without running run_tests')))
})

test('adversarial_verifier keeps verified verdict when run_tests was actually used', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    evidenceStatus: 'verified',
  }), 'adversarial_verifier', transcript(['read_file', 'run_tests']))

  assert.equal(checked.status, 'passed')
  assert.equal(checked.evidenceStatus, 'verified')
  assert.equal(checked.risks.length, 0)
})

test('adversarial_verifier with unchanged evidenceStatus still passes through', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    evidenceStatus: 'unverified',
  }), 'adversarial_verifier')

  assert.equal(checked.status, 'passed')
  assert.equal(checked.evidenceStatus, 'unverified')
})

test('goal_judge keeps verified verdict when verification metadata passed', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    evidenceStatus: 'verified',
    verification: {
      command: 'npm test',
      status: 'passed',
      scope: 'targeted',
      exitCode: 0,
      passed: 5,
      failed: 0,
      skipped: 0,
      durationMs: 100,
    },
  }), 'goal_judge')

  assert.equal(checked.status, 'passed')
  assert.equal(checked.evidenceStatus, 'verified')
})

test('goal_judge downgrades verified verdict without passing verification metadata', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    evidenceStatus: 'verified',
  }), 'goal_judge')

  assert.equal(checked.status, 'passed')
  assert.equal(checked.evidenceStatus, 'unverified')
  assert.ok(checked.risks.some(r => r.includes('without passing verification metadata')))
})

test('adversarial_verifier downgrades verified when run_tests errored', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    evidenceStatus: 'verified',
  }), 'adversarial_verifier', transcript(['read_file', 'run_tests'], ['run_tests: Test run failed']))

  assert.equal(checked.status, 'passed')
  assert.equal(checked.evidenceStatus, 'failed')
  assert.ok(checked.risks.some(r => r.includes('errored')))
})

test('blocks write worker with changedFiles and examinedFiles but no verification', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    examinedFiles: ['src/b.ts'],
    evidenceStatus: 'verified',
  }))

  assert.equal(checked.status, 'blocked')
  assert.ok(checked.risks.some(r => r.includes('missing verification metadata')))
})

// --- 复现即证明泛化（全 profile transcript 取证 + 交付文本宣称扫描）---

test('any profile claiming verified with transcript but no verification run is downgraded', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    evidenceStatus: 'verified',
  }), 'implementer', transcript(['read_file', 'edit_file']))

  assert.equal(checked.evidenceStatus, 'unverified')
  assert.ok(checked.risks.some(r => r.includes('宣称未经复现')))
})

test('verify-shaped bash command in transcript counts as proven verification', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'verified',
    verification: { command: 'npm test', status: 'passed', exitCode: 0, passed: 10, failed: 0, skipped: 0, scope: 'targeted', durationMs: 1200 },
  }), 'implementer', transcript(['read_file', 'bash'], [], ['npm test']))

  assert.equal(checked.evidenceStatus, 'verified')
  assert.equal(checked.risks.length, 0)
})

test('non-verify bash (ls/cat) does not count as verification proof', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    evidenceStatus: 'verified',
  }), 'implementer', transcript(['bash'], [], ['ls -la', 'cat src/a.ts']))

  assert.equal(checked.evidenceStatus, 'unverified')
})

test('failed verify-shaped bash is not verification proof — verified downgraded', () => {
  // npm test 跑挂了照样宣称 verified 是核心拦截场景：唯一验证证据失败 → 降级。
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'verified',
    verification: { command: 'npm test', status: 'passed', exitCode: 0, passed: 10, failed: 0, skipped: 0, scope: 'targeted', durationMs: 1200 },
  }), 'implementer', transcript(['bash'], ['npm test failed: 2 failing'], ['npm test'], ['npm test']))

  assert.equal(checked.evidenceStatus, 'failed')
  assert.ok(checked.risks.some(r => r.includes('errored')))
})

test('verify bash failed then retried successfully — verified kept', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'verified',
    verification: { command: 'npm test', status: 'passed', exitCode: 0, passed: 10, failed: 0, skipped: 0, scope: 'targeted', durationMs: 1200 },
  }), 'implementer', transcript(['bash', 'bash'], ['npm test failed once'], ['npm test', 'npm test'], ['npm test']))

  assert.equal(checked.evidenceStatus, 'verified')
})

test('run_tests errored but a later verify bash succeeded — verified kept', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'verified',
    verification: { command: 'npm test', status: 'passed', exitCode: 0, passed: 10, failed: 0, skipped: 0, scope: 'targeted', durationMs: 1200 },
  }), 'implementer', transcript(['run_tests', 'bash'], ['run_tests: Test run failed'], ['npm test'], []))

  assert.equal(checked.evidenceStatus, 'verified')
})

test('legacy transcript without failedBashCommands treats verify bash as succeeded', () => {
  // 旧序列化固件缺 failedBashCommands——按全部成功处理，不误杀历史数据。
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'verified',
    verification: { command: 'npm test', status: 'passed', exitCode: 0, passed: 10, failed: 0, skipped: 0, scope: 'targeted', durationMs: 1200 },
  }), 'implementer', transcript(['bash'], [], ['npm test']))

  assert.equal(checked.evidenceStatus, 'verified')
})

test('non-verifier profile without transcript is not downgraded here (batch re-gate safety)', () => {
  // coordinator 批量聚合二次过闸不带 transcript——首轮已带证据通过的结果
  // 不能在二次过闸被误杀。metadata 门（verification.status）仍然生效。
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'verified',
    verification: { command: 'npm test', status: 'passed', exitCode: 0, passed: 10, failed: 0, skipped: 0, scope: 'targeted', durationMs: 1200 },
  }), 'implementer')

  assert.equal(checked.evidenceStatus, 'verified')
})

test('claim language in summary without verification evidence adds 宣称未经复现 risk', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    evidenceStatus: 'unverified',
    summary: '修复完成，35/35 全绿，typecheck 干净。',
  }), 'implementer', transcript(['read_file', 'edit_file']))

  assert.ok(checked.risks.some(r => r.includes('宣称未经复现')))
  assert.equal(checked.evidenceStatus, 'unverified')
})

test('claim language backed by real verification passes without extra risk', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    evidenceStatus: 'unverified',
    summary: 'All tests pass — 12/12 通过。',
  }), 'implementer', transcript(['run_tests']))

  assert.ok(!checked.risks.some(r => r.includes('宣称未经复现')))
})


// --- 系统捕获优先（reconcileCapturedWorkerFacts：changedFiles/verification 交叉校验）---

test('reconcile: 自报与捕获一致 → 原样返回（同一引用）', () => {
  const r = result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'verified',
    verification: { command: 'npm test', status: 'passed', scope: 'targeted' },
  })
  const out = reconcileCapturedWorkerFacts(r, transcript(['edit_file', 'bash'], [], ['npm test'], [], ['src/a.ts']))

  assert.equal(out, r)
})

test('reconcile: 自报多出无工具痕迹的文件 → risk + verified 降 unverified', () => {
  const checked = reconcileCapturedWorkerFacts(result({
    changedFiles: ['src/a.ts', 'src/ghost.ts'],
    evidenceStatus: 'verified',
    verification: { command: 'npm test', status: 'passed', scope: 'targeted' },
  }), transcript(['edit_file', 'bash'], [], ['npm test'], [], ['src/a.ts']))

  // 并集保留自报（不误删模型真改了但捕获漏报的文件），但无痕迹文件记 risk。
  assert.deepEqual(checked.changedFiles, ['src/a.ts', 'src/ghost.ts'])
  assert.equal(checked.evidenceStatus, 'unverified')
  assert.ok(checked.risks.some(r => r.includes('自报 changedFiles 无工具调用痕迹') && r.includes('src/ghost.ts')))
})

test('reconcile: 捕获多出未自报的文件 → 并入 changedFiles，无 risk', () => {
  const checked = reconcileCapturedWorkerFacts(result({
    changedFiles: ['src/a.ts'],
  }), transcript(['edit_file', 'write_file'], [], [], [], ['src/a.ts', 'src/b.ts']))

  assert.deepEqual(checked.changedFiles, ['src/a.ts', 'src/b.ts'])
  assert.equal(checked.risks.length, 0)
})

test('reconcile: transcript.mutatedFiles 缺省（捕获未激活）→ 保持自报原样放行', () => {
  const r = result({ changedFiles: ['src/a.ts'] })
  const out = reconcileCapturedWorkerFacts(r, transcript(['read_file']))

  assert.equal(out, r)
})

test('reconcile: 真实跑过验证但漏报 verification → 补 passed 元数据（run_tests）', () => {
  const checked = reconcileCapturedWorkerFacts(result({
    changedFiles: ['src/a.ts'],
  }), transcript(['edit_file', 'run_tests'], [], [], [], ['src/a.ts']))

  assert.deepEqual(checked.verification, { command: 'run_tests', status: 'passed', scope: 'targeted' })
})

test('reconcile: 真实跑过验证但漏报 verification → 补 passed 元数据（验证形状 bash）', () => {
  const checked = reconcileCapturedWorkerFacts(result({
    changedFiles: ['src/a.ts'],
  }), transcript(['edit_file', 'bash'], [], ['npm test'], [], ['src/a.ts']))

  assert.deepEqual(checked.verification, { command: 'npm test', status: 'passed', scope: 'targeted' })
})

test('reconcile: 验证跑挂却自报 passed → 改 failed + risk', () => {
  // 自报元数据不带数值字段（schema 放宽后的合法形状）。
  const checked = reconcileCapturedWorkerFacts(result({
    changedFiles: ['src/a.ts'],
    verification: { command: 'npm test', status: 'passed', scope: 'targeted' },
  }), transcript(['edit_file', 'bash'], ['npm test failed: 2 failing'], ['npm test'], ['npm test'], ['src/a.ts']))

  assert.equal(checked.verification?.status, 'failed')
  assert.ok(checked.risks.some(r => r.includes('自报 passed 不可信')))
})

test('reconcile: 幂等——重复调用结果不变', () => {
  const r = result({
    changedFiles: ['src/a.ts', 'src/ghost.ts'],
    evidenceStatus: 'verified',
  })
  const t = transcript(['edit_file', 'bash'], [], ['npm test'], [], ['src/a.ts'])

  const once = reconcileCapturedWorkerFacts(r, t)
  const twice = reconcileCapturedWorkerFacts(once, t)
  assert.deepEqual(twice, once)
})

// ── 修复③：run_tests 失败证据（ENOENT / 失败计数 / 非零退出码）不得被补记 passed ──
// 背景：dotnet 项目被误判 Python 后 run_tests 直 spawn pytest ENOENT，结果文本
// 进 transcript.errors（worker-session.ts:422-423），但旧判据只认 'run_tests'
// 字样 → 系统给 blocked 工单补 verification.status='passed'，台账自相矛盾。

test('reconcile: run_tests spawn ENOENT（errors 文本）→ 不补 passed', () => {
  const checked = reconcileCapturedWorkerFacts(result({
    status: 'blocked',
    evidenceStatus: 'blocked',
  }), transcript(['run_tests'], ['spawn pytest ENOENT']))

  assert.equal(checked.verification, undefined)
  assert.equal(checked.status, 'blocked')
})

test('reconcile: run_tests spawn ENOENT（toolResults 文本）→ 不补 passed', () => {
  const checked = reconcileCapturedWorkerFacts(result({}), transcript(
    ['run_tests'], [], [], [], [], ['spawn pytest ENOENT'],
  ))

  assert.equal(checked.verification, undefined)
})

test('reconcile: run_tests 失败计数 > 0 → 不补 passed', () => {
  const checked = reconcileCapturedWorkerFacts(result({}), transcript(
    ['run_tests'], ['退出码：1\n3 通过，2 失败，0 跳过'],
  ))

  assert.equal(checked.verification, undefined)
})

test('reconcile: run_tests 非零退出码 → 不补 passed', () => {
  const checked = reconcileCapturedWorkerFacts(result({}), transcript(
    ['run_tests'], ['退出码：1\n[运行器输出尾部]\nError: Cannot find module'],
  ))

  assert.equal(checked.verification, undefined)
})

test('reconcile: run_tests 正常输出（0 失败 / 退出码 0）→ 仍补 passed（不误杀）', () => {
  const checked = reconcileCapturedWorkerFacts(result({}), transcript(
    ['run_tests'], ['退出码：0\n5 通过，0 失败，0 跳过'],
  ))

  assert.deepEqual(checked.verification, { command: 'run_tests', status: 'passed', scope: 'targeted' })
})

test('reconcile: toolResults 只有工具名（真实固件形状）→ 仍补 passed（不误判）', () => {
  const checked = reconcileCapturedWorkerFacts(result({}), transcript(
    ['edit_file', 'run_tests'], [], [], [], [], ['edit_file', 'run_tests'],
  ))

  assert.deepEqual(checked.verification, { command: 'run_tests', status: 'passed', scope: 'targeted' })
})

test('reconcile: run_tests errored 却自报 passed → 改 failed + risk', () => {
  const checked = reconcileCapturedWorkerFacts(result({
    verification: { command: 'run_tests', status: 'passed', scope: 'targeted' },
  }), transcript(['run_tests'], ['spawn pytest ENOENT']))

  assert.equal(checked.verification?.status, 'failed')
  assert.ok(checked.risks.some(r => r.includes('自报 passed 不可信')))
})

test('unsupported verification passed is removed locally and qualification is idempotent', () => {
  const original = result({ status: 'passed', summary: '所有测试通过', evidenceStatus: 'verified', verification: { command: 'npm test', status: 'passed', scope: 'targeted' } })
  const captured = transcript(['read_file'])
  const first = verifyWorkerEvidence(original, 'code_scout', captured)
  assert.equal(first.status, 'passed')
  assert.equal(first.verification?.status, 'blocked')
  assert.equal(first.evidenceStatus, 'unverified')
  assert.match(first.summary, /未经执行验证/)
  assert.deepEqual(verifyWorkerEvidence(first, 'code_scout', captured), first)
})

test('worker reconciliation never invents verification from query filenames or quoted commands', () => {
  for (const command of ['ls scripts/build.sh', 'rg "npm test" src', 'cat a.test.ts', 'pytest --help']) {
    const checked = reconcileCapturedWorkerFacts(result({}), transcript(['bash'], [], [command]))
    assert.equal(checked.verification, undefined, command)
  }
})

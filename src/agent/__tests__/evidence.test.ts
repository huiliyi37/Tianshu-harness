import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EvidenceTracker } from '../evidence.js'

describe('EvidenceTracker delivery status', () => {
  it('keeps targeted npm and run_tests verifications confined to explicit targets', () => {
    for (const command of ['npm test -- src/cache.test.ts', 'run_tests cache']) {
      const tracker = new EvidenceTracker()
      for (const file of ['src/cache.ts', 'src/billing.ts', 'src/permissions.ts']) tracker.trackFileModified(file)
      for (let i = 0; i < 3; i++) tracker.trackVerification({ command, status: 'passed', scope: 'targeted', targetFiles: ['src/cache.ts'], exitCode: 0 })
      assert.equal(tracker.getVerificationSummary().verified, 1, command)
      assert.equal(tracker.getVerificationSummary().pending, 2, command)
      tracker.trackFileModified('src/cache.ts')
      assert.equal(tracker.getVerificationSummary().verified, 0, 'editing invalidates coverage')
    }
  })

  it('maps targeted test files to their source without substring coverage', () => {
    const tracker = new EvidenceTracker()
    for (const file of ['src/cache.ts', 'src/c.ts', 'other/cache.ts']) tracker.trackFileModified(file)
    tracker.trackVerification({ command: 'node --test src/__tests__/cache.test.ts', status: 'passed', scope: 'targeted', exitCode: 0 })
    assert.deepEqual(tracker.getVerificationSummary().files, [
      { path: 'other/cache.ts', level: 'pending' },
      { path: 'src/c.ts', level: 'pending' },
      { path: 'src/cache.ts', level: 'tested' },
    ])
  })

  it('reports failed verification in the summary', () => {
    const tracker = new EvidenceTracker()
    tracker.trackFileModified('src/agent/loop.ts')
    tracker.trackVerification({
      command: 'npm test -- src/agent/__tests__/loop.test.ts',
      status: 'failed',
      scope: 'targeted',
      exitCode: 1,
      passed: 0,
      failed: 1,
      skipped: 0,
      durationMs: 500,
    })

    const summary = tracker.buildSummary()
    assert.equal(summary.verificationStatus, 'failed')
    assert.match(summary.verifications[0]!.command, /loop\.test\.ts/)
    assert.equal(tracker.getState().deliveryStatus, 'failed')
  })

  it('reports unverified edits when files changed without verification', () => {
    const tracker = new EvidenceTracker()
    tracker.trackFileModified('src/tools/web-fetch.ts')

    const summary = tracker.buildSummary()
    assert.equal(summary.verificationStatus, 'unverified')
    assert.deepEqual(summary.filesModified, ['src/tools/web-fetch.ts'])
    assert.equal(tracker.getState().deliveryStatus, 'unverified')
  })

  it('reports verified when tests pass', () => {
    const tracker = new EvidenceTracker()
    tracker.trackFileModified('src/a.ts')
    tracker.trackVerification({
      command: 'npm test',
      status: 'passed',
      scope: 'full',
      exitCode: 0,
      passed: 10,
      failed: 0,
      skipped: 0,
      durationMs: 1000,
    })

    assert.equal(tracker.getState().deliveryStatus, 'verified')
  })

  it('reports blocked when tests are blocked', () => {
    const tracker = new EvidenceTracker()
    tracker.trackFileModified('src/a.ts')
    tracker.trackVerification({
      command: 'npm test',
      status: 'blocked',
      scope: 'full',
      exitCode: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      durationMs: 0,
    })

    assert.equal(tracker.buildSummary().verificationStatus, 'blocked')
    assert.equal(tracker.getState().deliveryStatus, 'blocked')
  })

  it('failed takes priority over passed', () => {
    const tracker = new EvidenceTracker()
    tracker.trackFileModified('src/a.ts')
    tracker.trackVerification({ command: 'npm test -- a', status: 'passed', scope: 'targeted', exitCode: 0, passed: 5, failed: 0, skipped: 0, durationMs: 200 })
    tracker.trackVerification({ command: 'npm test -- b', status: 'failed', scope: 'targeted', exitCode: 1, passed: 0, failed: 1, skipped: 0, durationMs: 300 })

    assert.equal(tracker.getState().deliveryStatus, 'failed')
  })

  // ── deliveryReady：YOLO 证据门判据（2026-07-25）──
  // 与 deliveryStatus 全窗口口径刻意不同：红→绿即就绪（failed 不粘滞），
  // 绿后首次代码编辑即失效（verified 不反向粘滞）。

  it('deliveryReady: 先红后绿 → 就绪（failed 不粘滞）', () => {
    const tracker = new EvidenceTracker()
    tracker.trackFileModified('src/a.ts')
    tracker.trackVerification({ command: 'npm test', status: 'failed', scope: 'full', exitCode: 1, passed: 0, failed: 1, skipped: 0, durationMs: 100 })
    assert.equal(tracker.deliveryReady(), false)
    tracker.trackVerification({ command: 'npm test', status: 'passed', scope: 'full', exitCode: 0, passed: 5, failed: 0, skipped: 0, durationMs: 100 })
    assert.equal(tracker.deliveryReady(), true, '最近一条验证 passed 即就绪——窗口内历史 failed 不挡')
    assert.equal(tracker.getState().deliveryStatus, 'failed', '对照：deliveryStatus 保持粘滞语义不变')
  })

  it('deliveryReady: 绿后编辑代码 → 失效；再验证通过 → 恢复（verified 不反向粘滞）', () => {
    const tracker = new EvidenceTracker()
    tracker.trackFileModified('src/a.ts')
    tracker.trackVerification({ command: 'npm test', status: 'passed', scope: 'full', exitCode: 0, passed: 5, failed: 0, skipped: 0, durationMs: 100 })
    assert.equal(tracker.deliveryReady(), true)
    tracker.trackFileModified('src/b.ts')
    assert.equal(tracker.deliveryReady(), false, '绿后动过代码就不再就绪')
    assert.equal(tracker.getState().deliveryStatus, 'verified', '对照：deliveryStatus 此时仍是 verified（反向粘滞）')
    tracker.trackVerification({ command: 'npm test', status: 'passed', scope: 'full', exitCode: 0, passed: 6, failed: 0, skipped: 0, durationMs: 100 })
    assert.equal(tracker.deliveryReady(), true)
  })

  it('deliveryReady: 绿后编辑非代码文件不失效；无验证 / 最近一条 blocked → 不就绪', () => {
    const tracker = new EvidenceTracker()
    assert.equal(tracker.deliveryReady(), false, '无验证不就绪')
    tracker.trackVerification({ command: 'npm test', status: 'passed', scope: 'full', exitCode: 0, passed: 5, failed: 0, skipped: 0, durationMs: 100 })
    tracker.trackFileModified('docs/notes.md')
    assert.equal(tracker.deliveryReady(), true, '文档编辑不计入 TDD 计数，不掐门')
    tracker.trackVerification({ command: 'npm test', status: 'blocked', scope: 'full', exitCode: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0 })
    assert.equal(tracker.deliveryReady(), false, '最近一条 blocked 不就绪')
  })

  it('reset clears delivery status', () => {
    const tracker = new EvidenceTracker()
    tracker.trackFileModified('src/a.ts')
    tracker.trackVerification({ command: 'npm test', status: 'failed', scope: 'full', exitCode: 1, passed: 0, failed: 1, skipped: 0, durationMs: 100 })
    tracker.reset()
    assert.equal(tracker.getState().deliveryStatus, 'unverified')
    assert.equal(tracker.getState().verifications.length, 0)
  })

  // ── TDD gate: non-code files don't increment the edit counter ──

  it('does not increment editsSinceLastTest for non-code files', () => {
    const tracker = new EvidenceTracker()
    tracker.trackFileModified('docs/design/some-plan.md')
    tracker.trackFileModified('README.md')
    tracker.trackFileModified('.rivet/config.json')

    const gate = tracker.getGateState()
    assert.equal(gate.editsSinceLastTest, 0)
    assert.equal(gate.hasCodeEdits, false)
    assert.equal(gate.filesModified, 3) // filesModified still counts all
  })

  it('does not increment editsSinceLastTest for scratch probe files (.rivet/scratch/)', () => {
    const tracker = new EvidenceTracker()
    tracker.trackFileModified('.rivet/scratch/probe.ts')
    tracker.trackFileModified('/Users/x/proj/.rivet/scratch/check.ts')

    const gate = tracker.getGateState()
    assert.equal(gate.editsSinceLastTest, 0)
    assert.equal(gate.hasCodeEdits, false)
    assert.equal(gate.filesModified, 2) // filesModified still counts them
  })

  it('increments editsSinceLastTest for code files', () => {
    const tracker = new EvidenceTracker()
    tracker.trackFileModified('src/agent/loop.ts')
    tracker.trackFileModified('src/config/paths.ts')

    const gate = tracker.getGateState()
    assert.equal(gate.editsSinceLastTest, 2)
    assert.equal(gate.hasCodeEdits, true)
  })

  it('tracks hasCodeEdits correctly for mixed file types', () => {
    const tracker = new EvidenceTracker()
    tracker.trackFileModified('docs/design/plan.md')
    tracker.trackFileModified('src/agent/tdd-gate.ts')

    const gate = tracker.getGateState()
    assert.equal(gate.hasCodeEdits, true)
    assert.equal(gate.editsSinceLastTest, 1) // only the .ts file counts
  })

  it('resets hasCodeEdits and editsSinceLastTest on reset()', () => {
    const tracker = new EvidenceTracker()
    tracker.trackFileModified('src/a.ts')
    tracker.trackFileModified('src/b.ts')
    tracker.reset()

    const gate = tracker.getGateState()
    assert.equal(gate.editsSinceLastTest, 0)
    assert.equal(gate.hasCodeEdits, false)
  })

  it('buildSummary returns structured evidence snapshot', () => {
    const tracker = new EvidenceTracker()
    tracker.trackFileRead('src/a.ts')
    tracker.trackFileModified('src/b.ts')
    tracker.trackVerification({ command: 'npm test', status: 'passed', scope: 'full', exitCode: 0, passed: 3, failed: 0, skipped: 0, durationMs: 100 })

    const summary = tracker.buildSummary()
    assert.deepEqual(summary.filesRead, ['src/a.ts'])
    assert.deepEqual(summary.filesModified, ['src/b.ts'])
    assert.equal(summary.verificationStatus, 'verified')
    assert.equal(summary.verifications.length, 1)
    assert.equal(summary.gate.state, 'ok')
  })
})

describe('EvidenceTracker — 反斜杠路径归一化（Windows 回归）', () => {
  it('file 为反斜杠、命令为正斜杠时，tested 级 per-file level 仍匹配（修复前 base 退化为整串 → 恒 pending）', () => {
    const tracker = new EvidenceTracker()
    // Windows 工具输入形态：文件路径反斜杠；命令是模型/用户拼的正斜杠。
    // inferVerifiedFiles 的归一化曾误写 `replaceAll('\\\\','/')`（双反斜杠字面量，
    // 对单反斜杠路径零效果）→ normalizedFile 不归一 → split('/') 取不到 basename、
    // base/stem 退化成整条反斜杠路径 → 与正斜杠命令匹配失败 → level 保持 pending。
    tracker.trackFileModified('src\\agent\\foo.test.ts')
    tracker.trackVerification({
      command: 'npx vitest run src/agent/foo.test.ts',
      status: 'passed',
      scope: 'targeted',
      exitCode: 0,
      passed: 1,
      failed: 0,
      skipped: 0,
      durationMs: 100,
    })
    const levels = tracker.getState().fileVerificationLevels
    assert.equal(
      levels?.get('src\\agent\\foo.test.ts'),
      'tested',
      '反斜杠路径经归一化后应匹配命令，level 升到 tested',
    )
  })

  it('双端正斜杠路径行为不变（防回归）', () => {
    const tracker = new EvidenceTracker()
    tracker.trackFileModified('src/agent/bar.test.ts')
    tracker.trackVerification({
      command: 'npx vitest run src/agent/bar.test.ts',
      status: 'passed',
      scope: 'targeted',
      exitCode: 0,
      passed: 1,
      failed: 0,
      skipped: 0,
      durationMs: 100,
    })
    const levels = tracker.getState().fileVerificationLevels
    assert.equal(levels?.get('src/agent/bar.test.ts'), 'tested')
  })
})

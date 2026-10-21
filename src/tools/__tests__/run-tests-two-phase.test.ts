/**
 * VSW: run_tests two-phase (Phase A isolated + Phase B integration) tagging.
 *
 * Both phases run in the same temp dir here — the worktree build itself is
 * covered by verification-snapshot.test.ts; this validates that run_tests
 * produces an isolated primary verification tagged with snapshotRef, plus an
 * integration extra verification, and that Phase A governs isError.
 */

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RUN_TESTS_TOOL } from '../run-tests.js'
import type { ToolCallParams } from '../types.js'

const tempDirs: string[] = []
function makeProject(testBody: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'run-tests-2p-'))
  tempDirs.push(dir)
  symlinkSync(join(import.meta.dirname, '../../../node_modules'), join(dir, 'node_modules'), 'junction')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'fixture',
    scripts: { test: 'tsx --test' },
  }))
  mkdirSync(join(dir, 'src', '__tests__'), { recursive: true })
  writeFileSync(join(dir, 'src', '__tests__', 'sample.test.js'), testBody)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

function params(dir: string, over: Partial<ToolCallParams> = {}): ToolCallParams {
  return {
    input: { filter: 'src/__tests__/sample.test.js' },
    toolUseId: 'tu-1',
    cwd: dir,
    ...over,
  }
}

/**
 * run_tests spawns a child `node --test`. When THIS suite runs under the
 * node:test runner, NODE_TEST_CONTEXT=child-v8 is inherited by that child,
 * making it run in nested-child mode (exits 0, serializer output) instead of
 * actually running + failing. Production never spawns run_tests under a test
 * runner; strip the var around the call so the child behaves normally.
 */
async function runTool(p: ToolCallParams) {
  const saved = process.env.NODE_TEST_CONTEXT
  delete process.env.NODE_TEST_CONTEXT
  try {
    return await RUN_TESTS_TOOL.execute(p)
  } finally {
    if (saved !== undefined) process.env.NODE_TEST_CONTEXT = saved
  }
}

const PASSING = `import { test } from 'node:test'\nimport assert from 'node:assert'\ntest('ok', () => { assert.equal(1, 1) })\n`
// Module-load throw → non-zero exit regardless of nested node:test runner
// context (a passing/failing assertion inside test() is suppressed when this
// suite spawns a child under the parent test runner; a load error is not).
const FAILING = `throw new Error('module load failure')\n`

describe('run_tests VSW two-phase', () => {
  it('both phases share one total budget; phase B cannot receive the original budget again', async () => {
    const dir = makeProject(PASSING)
    const clock = Date.now
    let elapsed = 0
    // Advance only the parent clock after actual phase A output; no timing race
    // with child startup or competing sessions. Phase B must not spawn at all.
    Date.now = () => clock() + elapsed
    try {
      const result = await runTool(params(dir, { input: { filter: 'src/__tests__/sample.test.js', timeout: 5000 }, verificationSnapshot: { path: dir, snapshotRef: 'total-budget' }, onOutput: text => { if (/(?:ℹ|#) pass/.test(text)) elapsed = 5001 } }))
      assert.equal(elapsed, 5001, 'real output must advance the budget clock')
      assert.equal(result.verification?.status, 'passed', result.content)
      assert.equal(result.extraVerifications?.[0]?.failureKind, 'timeout', result.content)
      assert.notEqual(result.extraVerifications?.[0]?.status, 'passed')
      assert.match(result.content, /验证总预算已耗尽（超时），未启动后续阶段/)
    } finally { Date.now = clock }
  })

  it('cancellation stays blocked, never starts phase B or an attribution retry', async () => {
    const dir = makeProject(PASSING)
    const controller = new AbortController()
    controller.abort()
    let retries = 0
    const result = await runTool(params(dir, { abortSignal: controller.signal, verificationSnapshot: { path: dir, snapshotRef: 'cancelled' }, prepareRetrySnapshot: async () => { retries++; return { path: dir, snapshotRef: 'retry' } } }))
    assert.equal(result.isError, true)
    assert.equal(result.verification?.status, 'blocked')
    assert.match(result.content, /测试准备已取消或超时，未启动后续执行/)
    assert.equal(result.extraVerifications, undefined)
    assert.equal(retries, 0)
    const single = await runTool(params(dir, { abortSignal: controller.signal }))
    assert.equal(single.verification?.status, 'blocked')
    assert.equal(single.verification?.failureKind, undefined, 'cancellation is not a test failure or timeout')
  })

  it('timeout does not immediately start another suite for attribution', async () => {
    const dir = makeProject(PASSING)
    let retries = 0
    const result = await runTool(params(dir, { input: { filter: 'src/__tests__/sample.test.js', timeout: 1 }, prepareRetrySnapshot: async () => { retries++; return { path: dir, snapshotRef: 'retry' } } }))
    assert.equal(result.verification?.failureKind, 'timeout')
    assert.equal(retries, 0)
  })

  it('snapshot preparation consumes the C3 budget and an unstarted retry is not called FAILED', async () => {
    const dir = makeProject(FAILING), snapshot = makeProject(PASSING)
    const clock = Date.now
    let elapsed = 0, retries = 0
    Date.now = () => clock() + elapsed
    try {
      const result = await runTool(params(dir, { input: { filter: 'src/__tests__/sample.test.js', timeout: 5000 }, prepareRetrySnapshot: async () => { retries++; elapsed = 5001; return { path: snapshot, snapshotRef: 'budget-retry' } } }))
      assert.equal(retries, 1)
      assert.equal(result.isError, true)
      assert.equal(result.extraVerifications?.[0]?.status, 'blocked')
      assert.equal(result.extraVerifications?.[0]?.failureKind, 'timeout')
      assert.match(result.content, /C3 归因重试.*未完成.*总预算已耗尽/s)
      assert.doesNotMatch(result.content, /隔离快照中也 FAILED/)
    } finally { Date.now = clock }
  })

  it('mid-flight cancellation produces blocked evidence and skips integration', async () => {
    const dir = makeProject("import {test} from 'node:test'; test('pending',async()=>{console.log('Ready');await new Promise(r=>setTimeout(r,10000));});\n")
    const controller = new AbortController()
    const result = await runTool(params(dir, { abortSignal: controller.signal, verificationSnapshot: { path: dir, snapshotRef: 'mid-flight' }, onOutput: text => { if (text.includes('Ready')) controller.abort() } }))
    assert.equal(result.isError, true)
    assert.equal(result.verification?.status, 'blocked')
    assert.equal(result.extraVerifications, undefined)
    assert.match(result.content, /用户中止/)
  })

  it('tags Phase A isolated + Phase B integration with the snapshotRef when both pass', async () => {
    const dir = makeProject(PASSING)
    const result = await runTool(params(dir, {
      verificationSnapshot: { path: dir, snapshotRef: 'head+diff123' },
    }))

    assert.equal(result.isError ?? false, false)
    assert.equal(result.verification?.verificationPhase, 'isolated')
    assert.equal(result.verification?.snapshotRef, 'head+diff123')
    assert.ok(result.extraVerifications && result.extraVerifications.length === 1)
    assert.equal(result.extraVerifications![0]!.verificationPhase, 'integration')
    assert.equal(result.extraVerifications![0]!.snapshotRef, 'head+diff123')
    assert.match(result.content, /阶段 A · 隔离快照/)
    assert.match(result.content, /阶段 B · 当前 HEAD 集成\] 已通过/)
  })

  it('Phase A failure governs isError (blocking gate)', async () => {
    const dir = makeProject(FAILING)
    const result = await runTool(params(dir, {
      verificationSnapshot: { path: dir, snapshotRef: 'r1' },
    }))
    assert.equal(result.isError, true)
    assert.equal(result.verification?.verificationPhase, 'isolated')
    assert.equal(result.verification?.snapshotRef, 'r1')
    assert.notEqual(result.verification?.status, 'passed')
  })

  it('阶段 A 失败后不再跑阶段 B（省一次完整测试运行）', async () => {
    const dir = makeProject(FAILING)
    const result = await runTool(params(dir, {
      verificationSnapshot: { path: dir, snapshotRef: 'skip-b' },
    }))
    // A 失败已足以判定代码有问题：门禁只认 isolated 的结论（isolatedPassed 才
    // 认集成差异），此时再跑一遍实时工作区纯属浪费——2026-10-06 全量实测每次
    // 多付一整轮（约 64s），且失败信息翻倍。
    assert.equal(result.isError, true)
    assert.equal(result.verification?.verificationPhase, 'isolated')
    assert.equal(result.extraVerifications, undefined, '阶段 A 失败时不应产出阶段 B 记录')
    assert.match(result.content, /跳过/)
  })

  it('快照漏掉的 dirty 文件在阶段 A 输出里点名（不静默误导）', async () => {
    const dir = makeProject(PASSING)
    const result = await runTool(params(dir, {
      verificationSnapshot: {
        path: dir,
        snapshotRef: 'omitted-1',
        omittedDirtyFiles: ['src/config/env-registry.ts', 'src/agent/new-file.ts'],
      },
    }))
    // 快照只重放工具写入的文件；bash 脚本改的文件不在其中。不点名的话，
    // 隔离阶段的红看起来像代码缺陷，而真实原因可能只是快照缺改动。
    assert.match(result.content, /快照未包含这些工作树改动的文件/)
    assert.match(result.content, /env-registry\.ts/)
  })

  it('阶段 A 失败并跳过 B 时仍点名遗漏文件，且不放行失败', async () => {
    const dir = makeProject(FAILING)
    const result = await runTool(params(dir, {
      verificationSnapshot: { path: dir, snapshotRef: 'omitted-failure', omittedDirtyFiles: ['generated.ts'] },
    }))
    assert.equal(result.isError, true)
    assert.match(result.content, /generated\.ts/)
    assert.match(result.content, /跳过/)
    assert.equal(result.extraVerifications, undefined)
    assert.notEqual(result.verification?.status, 'passed')
  })

  it('without a verificationSnapshot plan, runs a single in-place phase (no tagging)', async () => {
    const dir = makeProject(PASSING)
    const result = await runTool(params(dir))
    assert.equal(result.isError ?? false, false)
    assert.equal(result.verification?.verificationPhase, undefined)
    assert.equal(result.verification?.snapshotRef, undefined)
    assert.equal(result.extraVerifications, undefined)
  })
})

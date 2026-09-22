import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runThetaCheck } from '../theta-check.js'
import {
  writeCachedTypecheck,
  computeSourceFingerprint,
  defaultCacheDir,
} from '../../lsp/typecheck-cache.js'
import { TSC_GATE_VARIANT } from '../../lsp/client.js'

// 2026-09-22 契约变更：theta 不再是 tsc 的生产者，而是共享 typecheck 闸门结论的
// **只读消费者**。旧测试围绕「临时项目里真跑 tsc / 1ms 预算造超时 / 负缓存退避 /
// 跨进程锁」编写，那些机制已随之删除。见
// docs/analysis/2026-09-22-session-retrospective.md §5 与设计讨论。

const tempDirs: string[] = []

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'theta-consumer-'))
  tempDirs.push(dir)
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true },
    include: ['*.ts'],
  }))
  writeFileSync(join(dir, 'valid.ts'), 'export const x: number = 42\n')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', [
    '-c', 'user.email=t@example.com', '-c', 'user.name=t',
    'commit', '-q', '-m', 'init',
  ], { cwd: dir })
  return dir
}

function seedVerdict(
  dir: string,
  verdict: { status: number; stdout: string },
  variant = TSC_GATE_VARIANT,
): void {
  const fingerprint = computeSourceFingerprint(dir, variant)
  assert.ok(fingerprint, 'fixture repo must yield a fingerprint')
  writeCachedTypecheck(defaultCacheDir(dir), {
    fingerprint,
    status: verdict.status,
    stdout: verdict.stdout,
    stderr: '',
    finishedAt: Date.now(),
    durationMs: 1234,
  })
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

describe('runThetaCheck — 共享闸门结论的只读消费者', () => {
  it('无缓存条目时诚实返回 no-fresh-verdict，且不 spawn tsc', async () => {
    const dir = makeRepo()
    const start = Date.now()
    const result = await runThetaCheck(dir, 15_000)
    const elapsed = Date.now() - start

    assert.equal(result.outcome, 'no-fresh-verdict')
    assert.deepEqual(result.errors, [])
    assert.equal(result.timedOut, false)
    // 旧实现会在临时项目里真跑 tsc（数百 ms 起）。只读路径必须是常数级。
    assert.ok(elapsed < 500, `只读路径不得 spawn tsc（耗时 ${elapsed}ms）`)
  })

  it('回放「无类型错误」的验证期结论 → ok', async () => {
    const dir = makeRepo()
    seedVerdict(dir, { status: 0, stdout: '' })

    const result = await runThetaCheck(dir, 15_000)

    assert.equal(result.outcome, 'ok')
    assert.deepEqual(result.errors, [])
    assert.equal(result.timedOut, false)
  })

  it('回放有类型错误的结论 → type_errors，并抽出出错文件', async () => {
    const dir = makeRepo()
    seedVerdict(dir, {
      status: 1,
      stdout: [
        "broken.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
        '',
        'Found 1 error in the same file.',
      ].join('\n'),
    })

    const result = await runThetaCheck(dir, 15_000)

    assert.equal(result.outcome, 'type_errors')
    assert.deepEqual(result.errors, ['broken.ts'])
    assert.equal(result.timedOut, false)
  })

  it('闸门正持锁时返回 busy——不抢锁、不伪装成绿', async () => {
    const dir = makeRepo()
    mkdirSync(join(defaultCacheDir(dir), 'run.lock'), { recursive: true })

    const result = await runThetaCheck(dir, 15_000)

    assert.equal(result.outcome, 'busy')
    assert.deepEqual(result.errors, [])
  })

  it('variant 不一致的缓存条目不命中（参数漂移会让两边看到不同错误集）', async () => {
    const dir = makeRepo()
    // 用 theta 自己那套旧参数（--skipLibCheck）写条目——它不是门禁的 variant
    seedVerdict(dir, { status: 0, stdout: '' }, '--noEmit --pretty false --skipLibCheck')

    const result = await runThetaCheck(dir, 15_000)

    assert.equal(result.outcome, 'no-fresh-verdict', 'variant 是缓存桶的一部分，不得跨桶命中')
  })

  it('非 git 目录无法定指纹 → no-fresh-verdict（不抛错、不阻断主循环）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'theta-nogit-'))
    tempDirs.push(dir)

    const result = await runThetaCheck(dir, 15_000)

    assert.equal(result.outcome, 'no-fresh-verdict')
    assert.deepEqual(result.errors, [])
  })

  it('durationMs 不谎报成 tsc 耗时（回放不花时间）', async () => {
    const dir = makeRepo()
    seedVerdict(dir, { status: 0, stdout: '' })

    const result = await runThetaCheck(dir, 15_000)

    assert.equal(result.durationMs, 0, '回放路径不得把它人跑出的耗时记成自己的')
  })
})

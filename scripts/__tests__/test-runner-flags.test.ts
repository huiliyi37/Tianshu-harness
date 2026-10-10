/**
 * 测试 runner 的挂死护栏。
 *
 * 事故：4 个测试批次进程被遗弃后跑满一天多（PPID=1，合计约 50% CPU），表现为
 * 「电脑总卡死」。两个成因——① Node 不设 `--test-timeout` 即 Infinity，任一测试卡住
 * 批次进程就永不退出；② runner 当时没装信号处理，被打断时子进程被 reparent 到 init。
 * 这里锁 ①，并顺带锁住非法环境变量不得把参数变成 NaN。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_TEST_TIMEOUT_MS, nodeTestFlags, resolveTestTimeoutMs, resolveTestConcurrency,
} from '../test-runner-flags.js'

test('nodeTestFlags 必须带 --test-timeout —— 缺了它挂死的测试会永久挂着', () => {
  const flags = nodeTestFlags(1234)
  assert.ok(flags.includes('--test-timeout=1234'), `实得 ${flags.join(' ')}`)
  // --test 必须在最后：其后是文件列表
  assert.equal(flags.at(-1), '--test')
})

test('resolveTestTimeoutMs 对非法值退回默认，不产出 NaN', () => {
  assert.equal(resolveTestTimeoutMs(undefined), DEFAULT_TEST_TIMEOUT_MS)
  assert.equal(resolveTestTimeoutMs(''), DEFAULT_TEST_TIMEOUT_MS)
  assert.equal(resolveTestTimeoutMs('   '), DEFAULT_TEST_TIMEOUT_MS)
  assert.equal(resolveTestTimeoutMs('abc'), DEFAULT_TEST_TIMEOUT_MS, '拼错的值不得变成 --test-timeout=NaN')
  assert.equal(resolveTestTimeoutMs('0'), DEFAULT_TEST_TIMEOUT_MS)
  assert.equal(resolveTestTimeoutMs('-5'), DEFAULT_TEST_TIMEOUT_MS)
  assert.equal(resolveTestTimeoutMs('Infinity'), DEFAULT_TEST_TIMEOUT_MS, '无穷等于没有上限')
  assert.equal(resolveTestTimeoutMs('5000'), 5000)
})

test('concurrency defaults stay bounded and invalid overrides cannot remove the bound', () => {
  assert.equal(resolveTestConcurrency(undefined, 1), 1)
  assert.equal(resolveTestConcurrency(undefined, 32), 4)
  for (const raw of ['', '0', '-1', '1.5', 'Infinity', 'NaN', 'no']) {
    assert.equal(resolveTestConcurrency(raw, 32), 4, raw)
  }
  assert.equal(resolveTestConcurrency('1', 32), 1)
  assert.equal(resolveTestConcurrency('8', 32), 8)
  assert.ok(nodeTestFlags(1234, 1).includes('--test-concurrency=1'))
})

test('默认上限须显著高于实测最慢用例，只兜挂死不误杀慢测试', () => {
  // 全量实测（16,140 条）单用例最慢 40s，另有 3 个 30s 档。低于 90s 会开始误杀，
  // 曾以 60s 误杀两个全仓 tsc 用例。
  assert.ok(DEFAULT_TEST_TIMEOUT_MS >= 90_000, `实得 ${DEFAULT_TEST_TIMEOUT_MS}ms，会误杀 40s 档用例`)
})

test('行为契约：--test-timeout 能把持有活跃 handle 的挂起变成失败', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-hang-guard-'))
  try {
    // setInterval 让事件循环非空 —— 否则 Node 会以「event loop resolved」自行收场，
    // 掩盖掉真实挂死（子进程/socket/watcher 未回收）的情形。
    // fixture 自带**寿命上限**（第二道防线）：本用例 spawn 的是 runner 批次的孙进程，
    // 若整棵树被 SIGKILL 端掉（祖父来不及按进程组收场），它会 reparent 到 init ——
    // 2026-09-24 实测机器上攒下 21 个 PPID=1、存活 11h~3天7h 的孤儿，全是这个 fixture。
    // 自毁把泄漏上限从「永久」压到 8s：仍远高于要验证的 2s 超时判定，又远短于任何能被
    // 察觉的时长。进程组收场（scripts/test-child-guard.ts 的 killTree）是第一道，这是兜底。
    // 顺带：原本要等父用例 30s guard 才收场，现在 8s 自己退——用例也快了。
    writeFileSync(join(dir, 'hang.fixture.mts'), [
      "import { test } from 'node:test'",
      "test('hangs forever', async () => {",
      '  const keepAlive = setInterval(() => {}, 1000)',
      '  try { await new Promise(() => {}) } finally { clearInterval(keepAlive) }',
      '})',
      // 刻意不 unref：这道定时器必须能 fire —— 它就是「最长存活」本身
      'setTimeout(() => { process.exit(1) }, 8000)',
      '',
    ].join('\n'))

    // 本用例自己跑在 node 测试 runner 下，环境里带着 NODE_TEST_CONTEXT。若原样继承，
    // 子 runner 会以为自己是子报告器 —— 不判超时、直接退 0，护栏就被静默旁路。
    const { NODE_TEST_CONTEXT: _drop, ...cleanEnv } = process.env

    const started = Date.now()
    const child = spawn(
      process.execPath,
      [...nodeTestFlags(2000), join(dir, 'hang.fixture.mts')],
      { stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv, windowsHide: true },
    )
    let out = ''
    child.stdout.on('data', c => { out += String(c) })
    child.stderr.on('data', c => { out += String(c) })

    // 兜底：真要是没超时，别让这个用例自己也变成僵留进程
    const guard = setTimeout(() => child.kill('SIGKILL'), 30_000)
    // 用 close 而非 exit：exit 在进程结束时立即触发，而 stdio 管道可能仍有未读缓冲——
    // 「✖ hangs forever (2003ms)」摘要行会先到、详情行 'test timed out after 2000ms'
    // 后到，于是断言在 stdout 未读全时执行（全量下偶发通过、单独跑常红）。close 保证
    // 所有 stdio 已关闭后才 resolve。
    const code = await new Promise<number | null>(resolve => {
      child.on('close', c => resolve(c))
    })
    clearTimeout(guard)

    const elapsed = Date.now() - started
    assert.notEqual(code, 0, '挂死的测试必须判失败')
    // 锚定**已 flush 的摘要行**：子进程被判定超时后事件循环仍非空（setInterval 是
    // 本用例刻意保留的），要等 guard SIGKILL 才收场——此刻未 flush 的详情行
    // （'test timed out after 2000ms'）会随进程一起丢失。摘要里的耗时既证明
    // 「被判定失败」，也直接反映申报的超时值（2000ms），比匹配消息措辞更稳。
    const m = /✖\s*hangs forever\s*\((\d+(?:\.\d+)?)ms\)/.exec(out)
    assert.ok(m, `未见超时判定摘要：\n${out.slice(-300)}`)
    const reported = Number(m[1])
    assert.ok(
      reported >= 1_800 && reported < 6_000,
      `子进程应报告 ≈2000ms 的超时判定，实报 ${reported}ms`,
    )
    assert.ok(elapsed < 40_000, `父用例应在 guard 档内收场，实耗 ${elapsed}ms`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * 测试子进程护栏（2026-09-12）。
 *
 * 背景：`--test-force-exit` 在 node 24.1 下与「完整汇总」不兼容。同一批 desktop
 * 197 个文件实测四次：1523 / 1640 / 1661 / **无汇总**，全部 exit 0 且 fail 0，而
 * 去掉该 flag 的 plain 跑稳定给出 1789 条（两次一致，进程正常退出）。也就是说
 * 退出码与 fail 计数都不可信——这正是"假绿"最贵的形状：观察者区分不了跑完与没跑完。
 *
 * 但不能简单删 flag 了事：`--test-force-exit` 原本承担"测试跑完但句柄未释放时也能
 * 收场"的职责（2026-07-29 曾因缺失护栏攒下跑满 2 天 13 小时的僵留进程）。所以本模块
 * 用三层替代它：
 *  1. plain 跑法——不做强制提前退出，让 node 自己打印完整汇总；
 *  2. idle / hard 看门狗——真挂起时有界收场，不留僵留进程；
 *  3. **汇总完整性 fail-closed**——进程退出但没见到汇总行 = 什么都没验证，判非零。
 *     这一条是本模块存在的理由：它把"核对条数"从人的习惯变成机器的闸。
 *
 * 用例用 `node -e` 造假子进程，逐条钉住上述三层。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGuardedChild } from '../test-child-guard.js'

/** 汇总行文本与 node --test 的 spec reporter 逐字一致。 */
const summary = (tests: number, pass: number, fail: number): string =>
  [`ℹ tests ${tests}`, `ℹ pass ${pass}`, `ℹ fail ${fail}`, 'ℹ cancelled 0'].join('\n')

const run = (script: string, opts: { idleMs?: number; hardMs?: number } = {}) =>
  runGuardedChild({
    args: ['-e', script],
    env: process.env,
    // 默认给足启动余量：node -e 在负载下从 spawn 到首字节可到数百 ms，而 idle 计时
    // 从 spawn 起算（必须如此，否则永不输出的挂起就抓不到）。挂起类用例单独传更短的
    // idleMs——它们的子进程本就不输出，余量不是变量。
    idleMs: opts.idleMs ?? 3_000,
    hardMs: opts.hardMs ?? 10_000,
    forwardOutput: false,
  })

test('正常收场：汇总行被解析，退出码沿用', async () => {
  const r = await run(`console.log(${JSON.stringify(summary(3, 3, 0))})`)
  assert.equal(r.summarySeen, true)
  assert.equal(r.tests, 3)
  assert.equal(r.pass, 3)
  assert.equal(r.fail, 0)
  assert.equal(r.code, 0)
  assert.equal(r.killed, null)
})

test('fail>0 的汇总 → 非零退出码', async () => {
  const r = await run(`console.log(${JSON.stringify(summary(2, 1, 1))}); process.exitCode = 1`)
  assert.equal(r.summarySeen, true)
  assert.equal(r.fail, 1)
  assert.equal(r.code, 1)
})

test('a completed summary cannot erase a real nonzero process exit', async () => {
  const r = await run(`console.log(${JSON.stringify(summary(1, 1, 0))}); process.exitCode = 7`)
  assert.equal(r.summarySeen, true)
  assert.equal(r.code, 7)
})

test('a cancelled real Node test is failed verification even with fail zero', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-cancelled-'))
  try {
    const file = join(dir, 'cancelled.fixture.mjs')
    writeFileSync(file, "import { test } from 'node:test'; test('unfinished promise', async () => { await new Promise(() => {}) })\n")
    const r = await runGuardedChild({ args: ['--test-reporter=spec', '--test-timeout=500', '--test', file], env: process.env, idleMs: 3000, hardMs: 10000, forwardOutput: false })
    assert.equal(r.summarySeen, true, r.tailExcerpt)
    assert.equal(r.fail, 0)
    assert.equal(r.cancelled, 1)
    assert.notEqual(r.code, 0, 'cancelled tests did not finish their assertions')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('idle cleanup must not make a cancelled summary pass', async () => {
  const text = summary(1, 0, 0).replace('cancelled 0', 'cancelled 1')
  const r = await run(`console.log(${JSON.stringify(text)}); setInterval(() => {}, 50)`)
  assert.equal(r.killed, 'idle')
  assert.equal(r.cancelled, 1)
  assert.notEqual(r.code, 0)
})

test('an interrupted summary header alone is incomplete verification', async () => {
  const r = await run("console.log('ℹ tests 1')")
  assert.equal(r.summarySeen, false)
  assert.notEqual(r.code, 0)
})

test('a summary interrupted before the cancellation count is incomplete', async () => {
  const r = await run("console.log('ℹ tests 1\\nℹ pass 1\\nℹ fail 0')")
  assert.equal(r.summarySeen, false)
  assert.notEqual(r.code, 0)
})

test('进程退出但没打印汇总 → 判非零（fail-closed：等价于什么都没验证）', async () => {
  // 复刻线上形态：进程正常退出（exit 0）、无任何 fail 计数，但汇总从未打印。
  const r = await run(`console.log('✔ some test that looks fine')`)
  assert.equal(r.summarySeen, false, '没有 ℹ tests 行就不算有汇总')
  assert.notEqual(r.code, 0, '无汇总必须判失败——这是本次修复的那道闸')
})

test('无输出挂起 → idle 看门狗杀掉并判非零', async () => {
  const r = await run(`setInterval(() => {}, 50)`, { idleMs: 1_200 })
  assert.equal(r.killed, 'idle')
  assert.notEqual(r.code, 0)
  assert.equal(r.summarySeen, false)
})

test('汇总已出现但句柄不释放 → 杀掉子进程，结果以汇总为准（不误杀成失败）', async () => {
  // 这正是 --test-force-exit 原本要解决的场景；现在由看门狗接管，
  // 且不能因为"进程没自己退"就否定已经跑完的测试。
  const r = await run(`console.log(${JSON.stringify(summary(3, 3, 0))}); setInterval(() => {}, 50)`, { idleMs: 1_200 })
  assert.equal(r.killed, 'idle', '仍然是看门狗收的尾')
  assert.equal(r.summarySeen, true)
  assert.equal(r.tests, 3)
  assert.equal(r.code, 0, '汇总完整且无失败 → 判成功')
})

test('持续输出但不退出 → hard 上限收场并判非零', async () => {
  const r = await run(`setInterval(() => { console.log('still working') }, 50)`, { hardMs: 300, idleMs: 10_000 })
  assert.equal(r.killed, 'hard')
  assert.notEqual(r.code, 0)
})

test('汇总出现在子进程的 stderr 也认（不依赖输出通道）', async () => {
  const r = await run(`console.error(${JSON.stringify(summary(5, 5, 0))})`)
  assert.equal(r.summarySeen, true)
  assert.equal(r.tests, 5)
  assert.equal(r.code, 0)
})

test('挂起被看门狗收场时：报告已见进度与末帧片段（而非把已跑测试记成 0）', async () => {
  // 线上形态：子进程先跑掉一批用例，随后卡住不再输出。此刻没有汇总行，
  // 但「跑了多少 / 卡在最后哪一行」是可观测的——判据应当把它报出来，
  // 否则跨批合计会把整批已跑的测试记成 0（数字失真，且无从定位挂死点）。
  const script = `
    console.log('✔ alpha (1ms)')
    console.log('  ✔ nested beta (2ms)')
    console.log('✖ gamma (3ms)')
    console.log('▶ delta suite — 卡在这里')
    setInterval(() => {}, 1000)
  `
  const r = await run(script, { idleMs: 1_500, hardMs: 10_000 })
  assert.equal(r.summarySeen, false, '无汇总行')
  assert.equal(r.killed, 'idle', '看门狗收场')
  assert.notEqual(r.code, 0, 'fail-closed 不变：无汇总仍判失败')
  assert.ok(r.seenChecks, '应报告已见进度')
  assert.equal(r.seenChecks?.pass, 2, '已见 2 条通过（含缩进嵌套用例）')
  assert.equal(r.seenChecks?.fail, 1, '已见 1 条失败')
  assert.match(r.tailExcerpt, /delta suite/, '末帧片段应含最后一条输出，用于定位卡在哪')
})

test('看门狗收场必须带走孙进程——祖父被杀时孙进程不能 reparent 到 init 继续跑', async () => {
  // 线上形态（2026-09-24 实测）：scripts/__tests__/test-runner-flags.test.ts 会 spawn
  // 一个「永不退出」的 fixture runner（故意持有 setInterval，模拟真挂死）。它是本
  // runner 批次的**孙进程** —— 批次被看门狗/信号收场时只 kill 直接子进程，孙进程就
  // reparent 到 init 永久存活：机器上实测攒下 21 个 PPID=1、存活 11 小时~3 天 7 小时
  // 的孤儿（同为 `node … hang.fixture.mts`）。所以收场必须按**进程组**杀。
  let grandchildPid = 0
  try {
    const r = await runGuardedChild({
      args: [
        '-e',
        `
          const { spawn } = require('node:child_process')
          const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000); setTimeout(() => process.exit(1), 8000)'], { stdio: 'ignore', windowsHide: true })
          console.log('GRANDCHILD_PID=' + grandchild.pid)
          setInterval(() => {}, 1000)
        `,
      ],
      env: process.env,
      idleMs: 1_500,
      hardMs: 10_000,
      forwardOutput: false,
    })
    assert.equal(r.killed, 'idle', '本用例的前提是看门狗收的尾')

    const m = /GRANDCHILD_PID=(\d+)/.exec(r.tailExcerpt)
    assert.ok(m, `末帧里应能读到孙进程 pid，实得：${r.tailExcerpt}`)
    grandchildPid = Number(m[1])

    // kill 是异步生效的，给一小段窗口再判定
    await new Promise((resolve) => setTimeout(resolve, 400))
    let alive = true
    try {
      process.kill(grandchildPid, 0)
    } catch {
      alive = false
    }
    assert.equal(alive, false, '孙进程必须随批次一起被带走——留下来就是那个跑满一天的孤儿')
  } finally {
    // 兜底：断言失败（RED 阶段）时别让本用例自己制造一个孤儿
    if (grandchildPid > 0) {
      try {
        process.kill(grandchildPid, 'SIGKILL')
      } catch {
        /* 已经不在了 */
      }
    }
  }
})

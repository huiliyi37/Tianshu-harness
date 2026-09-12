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
import { runGuardedChild } from '../test-child-guard.js'

/** 汇总行文本与 node --test 的 spec reporter 逐字一致。 */
const summary = (tests: number, pass: number, fail: number): string =>
  [`ℹ tests ${tests}`, `ℹ pass ${pass}`, `ℹ fail ${fail}`].join('\n')

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

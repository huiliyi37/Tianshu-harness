/**
 * issue #235 期望行为 1 的执行期半边 —— 「主动打断时应立即停止占用输入」。
 *
 * 既有 `maybeYieldForUserActivity` 只在**执行前**判定一次（用户刚在操作 → 跳过）。
 * 但 issue 现象 1 说的是「自动化**运行期间**操作者的鼠标/键盘被反复夺取」——
 * 命令一旦开跑就没有检查点，长时注入脚本跑到一半用户接管也不会停。
 * 本模块补这一段：执行期周期性探测，用户接管即回调（调用方负责终止进程树）。
 *
 * 覆盖范围与执行前判定一致（只对 `AVAILABILITY_HAZARD_PATTERNS` 命中的命令启用），
 * 未命中的普通 shell 命令**连调度都不建**。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  startYieldWatch,
  resolveYieldWatchMs,
  DEFAULT_YIELD_WATCH_MS,
  shouldWatchExecution,
} from '../bash-yield.js'
import type { UserIdleMs } from '../../system/user-idle.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── 是否启用（零开销保证） ──────────────────────────────────────────

test('shouldWatchExecution：命中注入签名 → 启用', () => {
  assert.equal(shouldWatchExecution('powershell -c "[DllImport(\\"user32.dll\\")]"'), true)
  assert.equal(shouldWatchExecution('cmd /c "osascript -e \'keystroke \\"v\\"\'"'), true)
})

test('shouldWatchExecution：普通命令 → 不启用（不建调度，不探测）', () => {
  assert.equal(shouldWatchExecution('npm test'), false)
  assert.equal(shouldWatchExecution('ls -la src/'), false)
})

test('shouldWatchExecution：归一化视图对齐执行前判定（引号拼接不漏）', () => {
  // 与 bash-yield.ts 的 matchesAvailabilityHazard 同源：单视图会漏掉拼接形态。
  assert.equal(shouldWatchExecution(String.raw`echo 'osascript to key'stroke v`), true)
})

// ── 旋钮 ────────────────────────────────────────────────────────────

test('resolveYieldWatchMs：默认值与 0=关闭', () => {
  const saved = process.env['RIVET_CU_YIELD_WATCH_MS']
  try {
    delete process.env['RIVET_CU_YIELD_WATCH_MS']
    assert.equal(resolveYieldWatchMs(), DEFAULT_YIELD_WATCH_MS)
    process.env['RIVET_CU_YIELD_WATCH_MS'] = '0'
    assert.equal(resolveYieldWatchMs(), 0)
    process.env['RIVET_CU_YIELD_WATCH_MS'] = 'abc'
    assert.equal(resolveYieldWatchMs(), DEFAULT_YIELD_WATCH_MS, '非法值回退默认')
  } finally {
    if (saved === undefined) delete process.env['RIVET_CU_YIELD_WATCH_MS']
    else process.env['RIVET_CU_YIELD_WATCH_MS'] = saved
  }
})

// ── 执行期监控 ──────────────────────────────────────────────────────

test('执行期：用户接管（idle < 阈值）→ 触发 onYield 且只触发一次', async () => {
  const seen: UserIdleMs[] = []
  let probes = 0
  const stop = startYieldWatch({
    probe: async () => { probes++; return 50 },
    thresholdMs: 1200,
    intervalMs: 10,
    onYield: (idle) => seen.push(idle),
  })
  await sleep(80)
  stop()
  const probesAtStop = probes
  assert.equal(seen.length, 1, '只回调一次')
  assert.equal(seen[0], 50)
  await sleep(40)
  assert.equal(probes, probesAtStop, '触发后不再探测')
})

test('执行期：用户空闲（idle >= 阈值）→ 不触发，持续探测', async () => {
  const seen: UserIdleMs[] = []
  let probes = 0
  const stop = startYieldWatch({
    probe: async () => { probes++; return 5000 },
    thresholdMs: 1200,
    intervalMs: 10,
    onYield: (idle) => seen.push(idle),
  })
  await sleep(80)
  stop()
  assert.equal(seen.length, 0)
  assert.ok(probes >= 2, `应重复探测，实得 ${probes}`)
})

test('执行期：探测无法进行（null）→ 不触发（护栏失效不该成为新的失败点）', async () => {
  const seen: UserIdleMs[] = []
  const stop = startYieldWatch({
    probe: async () => null,
    thresholdMs: 1200,
    intervalMs: 10,
    onYield: (idle) => seen.push(idle),
  })
  await sleep(60)
  stop()
  assert.equal(seen.length, 0)
})

test('执行期：探测抛错 → 吞掉并按 null 处理，不让护栏成为故障点', async () => {
  const seen: UserIdleMs[] = []
  const stop = startYieldWatch({
    probe: async () => { throw new Error('powershell 起不来') },
    thresholdMs: 1200,
    intervalMs: 10,
    onYield: (idle) => seen.push(idle),
  })
  await sleep(60)
  stop()
  assert.equal(seen.length, 0)
})

test('执行期：stop() 后不再探测（命令已结束，不许残留调度）', async () => {
  let probes = 0
  const stop = startYieldWatch({
    probe: async () => { probes++; return 9999 },
    thresholdMs: 1200,
    intervalMs: 10,
    onYield: () => {},
  })
  await sleep(40)
  stop()
  const atStop = probes
  await sleep(60)
  assert.equal(probes, atStop, 'stop 后不得再探测')
})

test('执行期：intervalMs <= 0 → 不建调度（旋钮关闭路径）', async () => {
  let probes = 0
  const stop = startYieldWatch({
    probe: async () => { probes++; return 10 },
    thresholdMs: 1200,
    intervalMs: 0,
    onYield: () => { throw new Error('不该触发') },
  })
  await sleep(60)
  stop()
  assert.equal(probes, 0)
})

/**
 * bash 超时路径的两处生命周期契约：
 *
 *  - timeout 非正数不得被解释为「立即杀」（issue #187）：`?? default` 只兜
 *    null/undefined，字面 0 / 负数 / NaN 会原样进 setTimeout，下一 tick 就触发
 *    超时分支，返回 exitCode -1 —— 与「命令本身失败」不可区分。
 *  - 超时挂的 3s 兜底 SIGKILL 定时器必须在子进程 close 后被清理（issue #184）：
 *    否则会对可能已被复用的 pid 补一次 kill（Windows 上是一条裸 taskkill /PID），
 *    并把事件循环多留 3s。
 *
 * 观测方式：#184 无法从返回值观察，故在测试内包裹 globalThis.setTimeout，
 * 记录所有 3000ms 定时器的句柄与其 clearTimeout 情况。bash.ts 用的是裸
 * setTimeout（无 import），会在调用时解析到本包裹。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASH_TOOL } from '../bash.js'
import type { ToolCallParams } from '../types.js'

const sleepMs = (ms: number) => new Promise(r => setTimeout(r, ms))

interface BashLike {
  isError?: boolean
  content: string
  exitCode?: number
}

function makeParams(input: Record<string, unknown>, cwd: string): ToolCallParams {
  return {
    input,
    toolUseId: 'bash-lifecycle-' + Math.random().toString(36).slice(2),
    cwd,
  } as unknown as ToolCallParams
}

function mkCwd(): string {
  return mkdtempSync(join(tmpdir(), 'rivet-bash-lifecycle-'))
}

test('timeout 非正数按默认值处理，不再被解释成立即杀（#187）', async () => {
  const cwd = mkCwd()
  try {
    for (const bad of [0, -5, Number.NaN]) {
      const res = (await BASH_TOOL.execute(
        makeParams({ command: 'echo lifecycle-ok', timeout: bad, run_in_background: false }, cwd),
      )) as unknown as BashLike
      assert.equal(res.isError, false, `timeout=${bad} 不应判为超时失败（实际 exitCode=${res.exitCode}）`)
      assert.ok(res.content.includes('lifecycle-ok'), `timeout=${bad} 命令应正常跑完并回传输出`)
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('超时后兜底 SIGKILL 定时器被子进程 close 清理（#184）', async () => {
  const created3s: unknown[] = []
  const cleared = new Set<unknown>()

  const rawSet = globalThis.setTimeout
  const rawClear = globalThis.clearTimeout
  const callSet = rawSet.bind(globalThis) as unknown as (
    fn: (...a: unknown[]) => void,
    ms?: number,
    ...rest: unknown[]
  ) => unknown
  const callClear = rawClear.bind(globalThis) as unknown as (h?: unknown) => void

  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const h = callSet(fn, ms, ...rest)
    if (ms === 3000) created3s.push(h)
    return h
  }) as unknown as typeof globalThis.setTimeout
  globalThis.clearTimeout = ((h?: unknown) => {
    cleared.add(h)
    callClear(h)
  }) as unknown as typeof globalThis.clearTimeout

  const cwd = mkCwd()
  try {
    const res = (await BASH_TOOL.execute(
      makeParams({ command: 'sleep 30', timeout: 400, run_in_background: false }, cwd),
    )) as unknown as BashLike
    assert.equal(res.isError, true, '超时应被判为失败')

    // 修复点在 child 的 close 回调里 —— 给子进程真正退出的时间。
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && !(created3s.length > 0 && created3s.every(h => cleared.has(h)))) {
      await sleepMs(50)
    }
    assert.ok(created3s.length > 0, '超时路径应挂过 3000ms 兜底定时器')
    for (const h of created3s) {
      assert.ok(cleared.has(h), '兜底 SIGKILL 定时器未在子进程 close 后清理')
    }
  } finally {
    globalThis.setTimeout = rawSet
    globalThis.clearTimeout = rawClear
    rmSync(cwd, { recursive: true, force: true })
  }
})

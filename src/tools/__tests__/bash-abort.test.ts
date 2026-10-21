/**
 * 1A：bash 协作式取消。
 *
 * 子代理调查：bash.execute 之前完全不读 params.abortSignal，用户 Esc/Ctrl+C 后
 * detached 子进程会继续在后台运行 —— 既泄漏资源，又在会话"假死"期间持续产生副作用。
 *
 * 契约：
 *  - abort 时立即 settle（不等到命令自然结束 / 超时）。
 *  - 子进程树被杀：被 abort 的 `sleep && touch` 不会写出 marker 文件。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASH_TOOL } from '../bash.js'
import type { ToolCallParams } from '../types.js'

const sleepMs = (ms: number) => new Promise(r => setTimeout(r, ms))

const _savedTmpdir = process.env.TMPDIR
let _testTmp: string

before(() => {
  _testTmp = mkdtempSync(join(process.cwd(), '.tmp-abort-'))
  process.env.TMPDIR = _testTmp
})
after(() => {
  if (_savedTmpdir === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = _savedTmpdir
  rmSync(_testTmp, { recursive: true, force: true })
})

function makeParams(command: string, signal: AbortSignal, cwd: string): ToolCallParams {
  return {
    input: { command },
    toolUseId: 'bash-abort-' + Math.random().toString(36).slice(2),
    cwd,
    abortSignal: signal,
  }
}

test('abort 时 bash 立即 settle（不等命令自然结束）', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-bash-abort-'))
  const ctrl = new AbortController()
  const start = Date.now()
  const p = BASH_TOOL.execute(makeParams('sleep 30', ctrl.signal, cwd))
  await sleepMs(100)
  const abortAt = Date.now()
  ctrl.abort()
  const result = await Promise.race([
    p,
    sleepMs(10_000).then(() => { throw new Error('bash 未在 10s 内 settle —— abort 未生效') }),
  ])
  const settleMs = Date.now() - abortAt
  // 契约是「abort 后立即 settle，不等 30s 自然结束」。settle 本身在码内即时，
  // 但 spawn/调度在并发负载下可达秒级——预算按负载容忍给（D 波遗留 b 曾见 2688ms）。
  assert.ok(settleMs < 5_000, `abort 后应在 5s 内 settle，实际 ${settleMs}ms`)
  assert.ok(Date.now() - start < 15_000, `全程应远小于自然结束 30s，实际 ${Date.now() - start}ms`)
  assert.equal((result as { isError?: boolean }).isError, false, 'abort 是用户行为，非失败')
  rmSync(cwd, { recursive: true, force: true })
})

test('abort 杀掉子进程树：被中止的 sleep&&touch 不写出 marker', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-bash-kill-'))
  const marker = join(cwd, 'marker.txt')
  const ctrl = new AbortController()
  // 子进程：1.5s 后才 touch marker；我们在 100ms 时 abort，应在 touch 之前被杀
  const p = BASH_TOOL.execute(makeParams(`sleep 1.5 && touch "${marker}"`, ctrl.signal, cwd))
  await sleepMs(100)
  ctrl.abort()
  await p
  // 等过原本的 touch 时刻，确认进程确实被杀（marker 不应出现）
  await sleepMs(2200)
  assert.equal(existsSync(marker), false, '子进程应在 touch 之前被杀，marker 不应存在')
  rmSync(cwd, { recursive: true, force: true })
})

/**
 * 上面两条 abort 都落在**准备窗口**（evidence worker fork + 握手，实测 macOS ~200ms）：
 * 修好之后那一段直接 settle 且根本不 spawn，所以覆盖不到「子进程已经跑起来再中止」的
 * kill 路径。这条用 started 标记先把 spawn 钉成事实，再 abort —— 否则 killProcessTree
 * 的回归可以一路躲在「反正没 spawn」后面不被发现。
 */
test('abort 落在子进程已 spawn 之后：进程树被杀，后续 touch 不执行', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-bash-kill-late-'))
  const started = join(cwd, 'started.txt')
  const marker = join(cwd, 'marker.txt')
  const ctrl = new AbortController()
  const p = BASH_TOOL.execute(makeParams(`touch "${started}" && sleep 3 && touch "${marker}"`, ctrl.signal, cwd))
  // 轮询 started 直到出现：它证明子进程真的在跑，而不是还在准备阶段。
  const spawnDeadline = Date.now() + 10_000
  while (!existsSync(started) && Date.now() < spawnDeadline) await sleepMs(50)
  assert.equal(existsSync(started), true, '子进程应已 spawn 并执行到 touch started')
  ctrl.abort()
  const result = await p
  assert.equal((result as { isError?: boolean }).isError, false, 'abort 是用户行为，非失败')
  // 等过原本的 touch 时刻，确认进程树确实被杀
  await sleepMs(3200)
  assert.equal(existsSync(marker), false, '已 spawn 的子进程应被 abort 杀掉，marker 不应存在')
  rmSync(cwd, { recursive: true, force: true })
})

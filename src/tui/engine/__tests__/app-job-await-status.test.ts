/**
 * job(await) 等待区如实化 + 后台任务实时条 + 静默钟小修（app 级接线）。
 *
 * 背景：agent 阻塞在 job(action:'await') 期间零 token 零事件，通用 spinner
 * 按 8s 时间片轮换「琢磨中/思索中」冒充模型活动（「琢磨中 8m11s」撒谎），
 * 分档提示还会升级到「No response — Ctrl+C to interrupt」误导杀会话。
 *
 * 契约：
 * 1. pending job(await) 时 live 帧如实显示「等待后台任务 <cmd> · 已等 / 上限」；
 * 2. 该分支不轮换思考系动词、不出现「No response」误导提示；
 * 3. jobsModel 查不到 jobId 时降级为「等待后台任务 <jobId>」不带 cmd；
 * 4. 已等超过上限转「后台任务运行已久 — Ctrl+C 可中断」档；
 * 5. 有 running 后台任务时 chrome 段渲染「⚙ N 后台任务」实时条，终态后消失；
 * 6. 工具终态结果落地重置静默钟（handleToolResult markActivity）。
 *
 * 断言口径：LiveEngine 是行级 diff 渲染——presence 断言用全量输出历史
 * （不清空）；「消失」断言用 commitStatic 触发的全量重绘帧切片
 * （atomicCommitNow：clearForCommit + 静态行 + 全量重画 live 区）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeApp, stripAnsi } from './_harness.js'
import type { JobEvent } from '../../../tools/job-store.js'

const tick = () => new Promise(r => setTimeout(r, 10))

interface AppInternals {
  renderLive: () => void
  handleToolUse: (id: string, name: string, input: Record<string, unknown>) => void
  handleToolResult: (id: string, name: string, result: string, isError?: boolean) => void
  toolGroupController: {
    getPending: (id: string) => { startMs: number } | undefined
  }
  streamRenderController: { lastActivityMs: number }
}

function started(id: string, cmd: string): JobEvent {
  return { kind: 'started', job: { id, command: cmd, status: 'running', startedAt: Date.now(), lastLine: '' } }
}
function exit(id: string, cmd: string, code: number): JobEvent {
  return { kind: 'exit', job: { id, command: cmd, status: 'exited', exitCode: code, startedAt: Date.now() - 3000, endedAt: Date.now(), lastLine: 'done' } }
}

const history = (out: { chunks: string[] }): string => stripAnsi(out.chunks.join(''))

test('pending job(await) → live 帧如实显示等待对象与已等/上限', async () => {
  const { app, out } = makeApp()
  app.handleJobEvent(started('a1', 'npm run dev'))
  ;(app as unknown as AppInternals).handleToolUse('t1', 'job', { action: 'await', id: 'a1', timeout: 30_000 })
  await tick()

  const frame = history(out)
  assert.ok(frame.includes('等待后台任务 npm run dev'), `应显示等待对象: ${frame}`)
  assert.ok(frame.includes('已等'), `应显示已等时长: ${frame}`)
  assert.ok(frame.includes('上限 30s'), `应显示上限: ${frame}`)
})

test('job(await) 分支 → 不轮换思考系动词、不出现「No response」误导', async () => {
  const { app, out } = makeApp()
  app.handleJobEvent(started('a1', 'npm run dev'))
  ;(app as unknown as AppInternals).handleToolUse('t1', 'job', { action: 'await', id: 'a1' })
  await tick()

  // 模拟长时间无活动（原撒谎场景的触发条件）+ 长等待
  ;(app as unknown as AppInternals).streamRenderController.lastActivityMs = Date.now() - 200_000
  const meta = (app as unknown as AppInternals).toolGroupController.getPending('t1')
  meta!.startMs = Date.now() - 60_000
  out.clear()
  ;(app as unknown as AppInternals).renderLive()
  const frame = history(out)

  assert.ok(frame.includes('等待后台任务'), frame)
  assert.ok(!frame.includes('琢磨中') && !frame.includes('思索中') && !frame.includes('推演中'),
    `不得冒充思考系动词: ${frame}`)
  assert.ok(!frame.includes('No response'), `不得出现 No response 升级提示: ${frame}`)
})

test('jobsModel 查不到 jobId → 降级「等待后台任务 <jobId>」不带 cmd', async () => {
  const { app, out } = makeApp()
  // 不发 started 事件（回放截断场景）
  ;(app as unknown as AppInternals).handleToolUse('t1', 'job', { action: 'await', id: 'zz9' })
  await tick()

  const frame = history(out)
  assert.ok(frame.includes('等待后台任务 zz9'), `降级应显示 jobId: ${frame}`)
})

test('已等超过上限 → 「后台任务运行已久 — Ctrl+C 可中断」档', async () => {
  const { app, out } = makeApp()
  app.handleJobEvent(started('a1', 'npm run dev'))
  ;(app as unknown as AppInternals).handleToolUse('t1', 'job', { action: 'await', id: 'a1', timeout: 120_000 })
  await tick()

  const meta = (app as unknown as AppInternals).toolGroupController.getPending('t1')
  meta!.startMs = Date.now() - 491_000
  out.clear()
  ;(app as unknown as AppInternals).renderLive()
  const frame = history(out)
  assert.ok(frame.includes('后台任务运行已久'), frame)
  assert.ok(frame.includes('Ctrl+C 可中断'), frame)
  assert.ok(!frame.includes('等待后台任务 npm'), `超上限不再报等待口径: ${frame}`)
})

test('有 running 后台任务 → chrome 渲染实时条；终态后消失', async () => {
  const { app, out } = makeApp()
  assert.ok(!history(out).includes('⚙'), '无任务时不渲染实时条')

  app.handleJobEvent(started('a1', 'npm run dev'))
  await tick()
  const frame1 = history(out)
  assert.ok(frame1.includes('⚙ 1 后台任务'), `有 running 应渲染实时条: ${frame1}`)
  assert.ok(frame1.includes('npm run dev'), `实时条应含首个命令: ${frame1}`)

  // 终态：notifyJobTerminal 的 commitStatic 触发全量重绘——之后的输出切片
  // 含完整 live 帧（append 模式全行重写），其中不得再有 ⚙（实时条与 GlanceBar 徽章）。
  const before = out.chunks.length
  app.handleJobEvent(exit('a1', 'npm run dev', 0))
  await tick()
  const tail = stripAnsi(out.chunks.slice(before).join(''))
  assert.ok(tail.includes('后台任务完成'), `切片应含终态行（证明取到了 commit 后全量帧）: ${tail}`)
  assert.ok(!tail.includes('⚙'), `终态后实时条应消失: ${tail}`)
})

test('工具终态结果落地重置静默钟（handleToolResult markActivity）', async () => {
  const { app } = makeApp()
  const ctrl = (app as unknown as AppInternals).streamRenderController
  ctrl.lastActivityMs = Date.now() - 300_000
  ;(app as unknown as AppInternals).handleToolResult('t9', 'some_tool', 'ok', false)
  assert.ok(Date.now() - ctrl.lastActivityMs < 1000, '终态结果应重置静默钟')
})

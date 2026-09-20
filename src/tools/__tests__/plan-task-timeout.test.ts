/**
 * plan_task 超时新语义（2026-09-05 team-76dc14a1 事故修复 A）。
 *
 * 旧语义：execute:true 硬编码 600s，withToolTimeout 到点经 composedSignal 级联
 * abort——编排与 worker 连坐斩杀。新语义：
 * ① 等待上限可配：input.executeTimeoutMs > env RIVET_PLAN_EXECUTE_TIMEOUT_MS >
 *    默认 600s（PLAN_EXECUTE_DEFAULT_TIMEOUT_MS——与旧硬编码同值：本笔只改
 *    「到点做什么」不改「等多久」，见下方落地记录）；
 * ② 到点「脱离等待」：工具立即返回（非 error），底层 executePlanWaves 在后台
 *    继续推进——派发给 worker 的 abortSignal 绝不因超时触发；settle 后
 *    detached-plan hook（preTurn）经 advisory bus 通知主会话。
 * 纯规划路径（execute!==true）120s 语义不变。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createPlanTaskTool,
  resolvePlanExecuteTimeoutMs,
  PLAN_EXECUTE_DEFAULT_TIMEOUT_MS,
  PLAN_EXECUTE_PIPELINE_GRACE_MS,
} from '../plan-task.js'
import type { DelegationCoordinator } from '../../agent/coordinator.js'
import { deriveTeamGroupId } from '../../agent/wave-checkpoint.js'
import { clearWaveResults } from '../../agent/wave-results-store.js'
import {
  clearDetachedPlanRuns,
  drainSettledDetachedPlanRuns,
  listDetachedPlanRuns,
  trackDetachedPlanRun,
} from '../../agent/detached-plan-registry.js'
import { createDetachedPlanHook } from '../../agent/hooks/detached-plan-hook.js'
import type { AdvisoryEntry } from '../../agent/advisory-bus.js'
import type { PlanExecutorWavesResult } from '../../agent/plan-executor.js'

// ── ① 超时解析矩阵 ─────────────────────────────────────────────────────

describe('resolvePlanExecuteTimeoutMs — 参数/env/默认优先序', () => {
  it('默认：无参数无 env → 600s（10 分钟，与旧硬编码同值）', () => {
    assert.equal(resolvePlanExecuteTimeoutMs(undefined, undefined), PLAN_EXECUTE_DEFAULT_TIMEOUT_MS)
    // 回流偏差（2026-09-21）：alpha 把默认抬到 30min；主线保留 600s——本笔修的是
    // 「到点转后台而不是杀」，没有理由同时把等待窗口放大 3 倍（面板长卡代价）。
    assert.equal(PLAN_EXECUTE_DEFAULT_TIMEOUT_MS, 600_000)
  })

  it('input 参数优先于 env', () => {
    assert.equal(resolvePlanExecuteTimeoutMs(45_000, '90000'), 45_000)
  })

  it('env 兜底：无参数时读 RIVET_PLAN_EXECUTE_TIMEOUT_MS', () => {
    assert.equal(resolvePlanExecuteTimeoutMs(undefined, '90000'), 90_000)
  })

  it('非法值逐级下落：参数非法 → env；env 非法 → 默认', () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, '300', null] as unknown[]) {
      assert.equal(resolvePlanExecuteTimeoutMs(bad, '75000'), 75_000, `bad param ${String(bad)} 应落到 env`)
      assert.equal(resolvePlanExecuteTimeoutMs(bad, undefined), PLAN_EXECUTE_DEFAULT_TIMEOUT_MS, `bad param ${String(bad)} 应落到默认`)
    }
    for (const badEnv of ['', 'abc', '-10', '0']) {
      assert.equal(resolvePlanExecuteTimeoutMs(undefined, badEnv), PLAN_EXECUTE_DEFAULT_TIMEOUT_MS, `bad env ${JSON.stringify(badEnv)} 应落到默认`)
    }
  })
})

describe('plan_task.timeoutMs — pipeline 墙钟公式', () => {
  const ENV_KEY = 'RIVET_PLAN_EXECUTE_TIMEOUT_MS'
  let saved: string | undefined
  function withEnv(value: string | undefined, fn: () => void) {
    saved = process.env[ENV_KEY]
    if (value === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = value
    try { fn() } finally {
      if (saved === undefined) delete process.env[ENV_KEY]
      else process.env[ENV_KEY] = saved
    }
  }

  const tool = () => createPlanTaskTool({
    getCoordinator: () => null,
    getExecutorDeps: () => ({} as never),
  })

  it('纯规划路径（execute 缺省/false）保持 120s 不变', () => {
    const t = tool()
    assert.equal(t.timeoutMs?.(undefined), 120_000)
    assert.equal(t.timeoutMs?.({ input: {} } as never), 120_000)
    assert.equal(t.timeoutMs?.({ input: { execute: false, executeTimeoutMs: 5000 } } as never), 120_000)
  })

  it('execute:true 默认 = 600s + pipeline 兜底宽限', () => {
    withEnv(undefined, () => {
      const t = tool()
      assert.equal(
        t.timeoutMs?.({ input: { execute: true } } as never),
        PLAN_EXECUTE_DEFAULT_TIMEOUT_MS + PLAN_EXECUTE_PIPELINE_GRACE_MS,
      )
    })
  })

  it('execute:true 参数/env 生效（均加兜底宽限，内部脱离计时恒先触发）', () => {
    const t = tool()
    withEnv('120000', () => {
      assert.equal(t.timeoutMs?.({ input: { execute: true } } as never), 120_000 + PLAN_EXECUTE_PIPELINE_GRACE_MS)
      assert.equal(t.timeoutMs?.({ input: { execute: true, executeTimeoutMs: 3000 } } as never), 3000 + PLAN_EXECUTE_PIPELINE_GRACE_MS)
    })
  })
})

// ── ② 脱离等待行为：超时不杀 worker，后台继续可跟踪 ─────────────────────

const SINGLE_WAVE_PLAN_MD = [
  '### Wave 1',
  '- [ ] Translate doc into `docs/ja.md`',
].join('\n')

function writePlan(): string {
  mkdirSync('.rivet/plans', { recursive: true })
  const name = `.rivet/plans/detach-${process.pid}-${Date.now()}.md`
  writeFileSync(name, SINGLE_WAVE_PLAN_MD, 'utf-8')
  return name
}

function mkWavesResult(packet: string): PlanExecutorWavesResult {
  const run = {
    summary: {
      tasks: [], waves: [], dispatched: 1,
      run: {
        status: 'completed' as const,
        results: [{
          workOrderId: 'team:P1', status: 'passed' as const, summary: 's', findings: [], artifacts: [],
          changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'verified' as const,
        }],
        packet,
      },
    },
    notes: { reviewNote: '', scopeHealthNote: '', impactNote: '', deliverySynthesis: '', waveGateNote: '' },
  } as unknown as PlanExecutorWavesResult['run']
  return { runs: [run], run }
}

describe('plan_task execute:true 脱离等待（detach）', () => {
  it('到点立即返回（非 error），worker 的 abortSignal 不被触发；后台跑完可 drain 到完成账', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-detach-'))
    const sessionId = `plan-detach-${Date.now()}`
    const planPath = writePlan()
    const objective = `执行 ${planPath} 计划`
    // 模拟 pipeline 注入的 composedSignal——真实管线里超时的级联 abort 就打在它上面。
    const controller = new AbortController()
    let batchCalled = false
    let batchSignal: AbortSignal | undefined
    let releaseBatch: (r: ReturnType<typeof mkWavesResult>['run']['summary']['run']) => void = () => {}
    try {
      const tool = createPlanTaskTool({
        getCoordinator: () => ({}) as unknown as DelegationCoordinator,
        getExecutorDeps: () => ({
          // 挂起的派发：由测试手动放行，模拟「600s 跑不完的多波编排」。
          delegateBatch: (_requests: unknown, _policy: unknown, abortSignal?: AbortSignal) => {
            batchCalled = true
            batchSignal = abortSignal
            return new Promise(resolve => { releaseBatch = resolve })
          },
        }) as never,
      })

      const started = Date.now()
      const result = await tool.execute({
        input: { objective, execute: true, executeTimeoutMs: 50 },
        cwd: dir,
        toolUseId: 'pt-detach',
        sessionId,
        abortSignal: controller.signal,
      } as never)
      const waited = Date.now() - started

      // ① 快速返回（50ms 上限量级，绝非挂死），且不是 error。
      assert.ok(waited < 30_000, `脱离等待应立即返回，实际等了 ${waited}ms`)
      assert.notEqual(result.isError, true, String(result.content))
      const content = String(result.content)
      assert.match(content, /已转入后台继续执行/, '指引文案：转后台')
      assert.match(content, new RegExp(deriveTeamGroupId(objective)), '指引含 checkpoint 组 id')
      assert.match(content, /fromWave=N/, '保留续跑指引')

      // ② 核心断言：派发给 worker 的 abortSignal 没有因超时触发——编排不被斩杀。
      // 后台编排链（executePlan→runTeamSkeleton→dispatchWaveAt）有几个异步跳，
      // 脱离返回点 delegateBatch 可能尚未被调到——轮询等它抵达。
      for (let i = 0; i < 200 && !batchCalled; i++) {
        await new Promise(r => setTimeout(r, 10))
      }
      assert.ok(batchCalled, 'delegateBatch 已被调用')
      assert.equal(batchSignal, controller.signal, '编排收到的正是 pipeline 注入的信号')
      assert.equal(controller.signal.aborted, false, '超时绝不 abort 编排/worker')

      // ③ 后台跟踪：条目登记为运行中。
      const running = listDetachedPlanRuns(sessionId)
      assert.equal(running.length, 1)
      assert.equal(running[0]!.groupId, deriveTeamGroupId(objective))
      assert.equal(running[0]!.settled, undefined)

      // ④ 底层继续推进到完成：放行派发 → settle 入账 → drain 出完成通知。
      releaseBatch(mkWavesResult('wave0-done').run.summary.run)
      // 等后台 promise 链 settle（微观任务拍几下事件循环即可）。
      for (let i = 0; i < 50 && listDetachedPlanRuns(sessionId)[0]?.settled === undefined; i++) {
        await new Promise(r => setTimeout(r, 10))
      }
      const settled = drainSettledDetachedPlanRuns(sessionId)
      assert.equal(settled.length, 1, '完成账必须可 drain')
      assert.equal(settled[0]!.settled!.ok, true)
      assert.match(settled[0]!.settled!.summary, /1\/1 worker 通过/)
      assert.equal(controller.signal.aborted, false, '跑完全程 abortSignal 仍未触发')
      // drain 后不再重复投递。
      assert.equal(drainSettledDetachedPlanRuns(sessionId).length, 0)
    } finally {
      releaseBatch(mkWavesResult('cleanup').run.summary.run) // 防御：未放行时防泄漏
      clearWaveResults(sessionId)
      clearDetachedPlanRuns(sessionId)
      rmSync(planPath, { force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('后台执行失败也如实入账（ok:false + 错误摘要），不成为 unhandledRejection', async () => {
    const sessionId = `plan-detach-fail-${Date.now()}`
    const planPath = writePlan()
    const objective = `执行 ${planPath} 计划`
    let rejectBatch: (err: Error) => void = () => {}
    const dir = mkdtempSync(join(tmpdir(), 'plan-detach-fail-'))
    try {
      const tool = createPlanTaskTool({
        getCoordinator: () => ({}) as unknown as DelegationCoordinator,
        getExecutorDeps: () => ({
          delegateBatch: () => new Promise((_resolve, reject) => { rejectBatch = reject }),
        }) as never,
      })
      const result = await tool.execute({
        input: { objective, execute: true, executeTimeoutMs: 50 },
        cwd: dir,
        toolUseId: 'pt-detach-fail',
        sessionId,
      } as never)
      assert.notEqual(result.isError, true)

      rejectBatch(new Error('dispatch exploded'))
      for (let i = 0; i < 50 && listDetachedPlanRuns(sessionId)[0]?.settled === undefined; i++) {
        await new Promise(r => setTimeout(r, 10))
      }
      const settled = drainSettledDetachedPlanRuns(sessionId)
      assert.equal(settled.length, 1)
      assert.equal(settled[0]!.settled!.ok, false)
      assert.match(settled[0]!.settled!.summary, /dispatch exploded/)
    } finally {
      rejectBatch(new Error('cleanup'))
      clearWaveResults(sessionId)
      clearDetachedPlanRuns(sessionId)
      rmSync(planPath, { force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── ③ detached-plan hook：settle 通知 + 运行中 awareness ───────────────

describe('detached-plan hook（preTurn 通知通道）', () => {
  function fakeWaves(settledPacket: string): Promise<PlanExecutorWavesResult> {
    return Promise.resolve(mkWavesResult(settledPacket))
  }

  it('settle 事件经 advisory bus system-reminder 投递一次；运行中条目给 informational 提醒', async () => {
    const sessionId = `plan-hook-${Date.now()}`
    const submitted: AdvisoryEntry[] = []
    const bus = { submit: (e: AdvisoryEntry) => { submitted.push(e) } }
    const hook = createDetachedPlanHook({ advisoryBus: bus, sessionId })
    try {
      trackDetachedPlanRun(
        { sessionId, objective: '翻译计划', groupId: 'team-deadbeef', startedAt: Date.now(), timeoutMs: 50 },
        fakeWaves('done'),
      )
      // 未 settle 前：只有运行中 awareness。
      hook.run({} as never)
      const runningEntries = submitted.filter(e => e.key === 'detached-plan-running')
      assert.equal(runningEntries.length, 1)
      assert.equal(runningEntries[0]!.tier, 'informational')
      // 回流偏差（2026-09-21）：运行中提醒走独立类别 'detached-plan'，不与
      // background-jobs hook 争 MAX_PER_CATEGORY=2 的每类别预算（alpha 用 'background'）。
      assert.equal(runningEntries[0]!.category, 'detached-plan')
      assert.match(runningEntries[0]!.content, /team-deadbeef/)

      for (let i = 0; i < 50 && listDetachedPlanRuns(sessionId)[0]?.settled === undefined; i++) {
        await new Promise(r => setTimeout(r, 10))
      }
      submitted.length = 0
      hook.run({} as never)
      const settledEntries = submitted.filter(e => e.key.startsWith('detached-plan-detached-'))
      assert.equal(settledEntries.length, 1, 'settle 事件必须投递')
      assert.equal(settledEntries[0]!.channel, 'system-reminder')
      assert.equal(settledEntries[0]!.srClass, 'functional')
      assert.equal(settledEntries[0]!.immediate, true)
      assert.match(settledEntries[0]!.content, /后台计划执行完成/)

      // 遗言只投递一次：下一轮不再出现。
      submitted.length = 0
      hook.run({} as never)
      assert.equal(submitted.length, 0)
    } finally {
      clearDetachedPlanRuns(sessionId)
    }
  })

  it('会话隔离：别的会话的后台执行不出现在本会话提醒里', async () => {
    const submitted: AdvisoryEntry[] = []
    const bus = { submit: (e: AdvisoryEntry) => { submitted.push(e) } }
    const hook = createDetachedPlanHook({ advisoryBus: bus, sessionId: 'session-A' })
    try {
      trackDetachedPlanRun(
        { sessionId: 'session-B', objective: '别的会话的计划', groupId: 'team-bbbbbbbb', startedAt: Date.now(), timeoutMs: 50 },
        fakeWaves('done'),
      )
      for (let i = 0; i < 50 && listDetachedPlanRuns('session-B')[0]?.settled === undefined; i++) {
        await new Promise(r => setTimeout(r, 10))
      }
      hook.run({} as never)
      assert.equal(submitted.length, 0, 'session-A 的 hook 不得投递 session-B 的事件')
    } finally {
      clearDetachedPlanRuns('session-A')
      clearDetachedPlanRuns('session-B')
    }
  })
})

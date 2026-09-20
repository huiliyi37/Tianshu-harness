/**
 * Detached Plan Run Registry — plan_task(execute:true) 超时「脱离等待」后的
 * 后台执行跟踪（2026-09-05 team-76dc14a1 事故修复 A）。
 *
 * 旧语义：工具超时经 withToolTimeout + composedSignal 级联 abort，编排与 worker
 * 连坐斩杀（产物已落盘也被误标 failed）。新语义：到点脱离等待——工具立即返回，
 * 底层 executePlanWaves 继续在后台推进（worker 不被 abort），每波 checkpoint
 * 照常落盘。本 registry 记录这些脱离运行的生命周期：
 *
 * - 进度可见：运行中条目可由 hook 逐轮提醒（勿重复派发）；
 * - 完成通知：settle 时登记结果摘要，detached-plan hook（preTurn）drain 后经
 *   advisory bus system-reminder 注入下个对话轮——与 monitor-hook 同一通道先例。
 *
 * Session-scoped（同 wave-results-store 模式）：多会话并发互不串扰；进程退出
 * 即失效（后台执行本来也随会话进程生死）。
 */

import type { PlanExecutorWavesResult } from './plan-executor.js'

export interface DetachedPlanRun {
  /** 运行 id（detached-<n>，会话内单调）。 */
  id: string
  sessionId?: string
  objective: string
  /** team checkpoint 组 id（deriveTeamGroupId(objective)）——checkpoint 文件名。 */
  groupId: string
  /** 执行开始时刻（executePlanWaves 调用点）。 */
  startedAt: number
  /** 脱离时刻（工具超时返回点）。 */
  detachedAt: number
  /** 触发脱离的等待上限（ms）。 */
  timeoutMs: number
  /** settle 结果；缺席 = 仍在后台运行。 */
  settled?: { ok: boolean; summary: string; settledAt: number }
}

const runsBySession = new Map<string, Map<string, DetachedPlanRun>>()
let seq = 0

function skey(sessionId?: string): string {
  return sessionId ?? '__default__'
}

/** 从聚合结果提炼一行可通知的成败摘要（有界，不进大 packet）。 */
function summarizeWavesResult(result: PlanExecutorWavesResult): string {
  const results = result.run.summary.run?.results ?? []
  const passed = results.filter(r => r.status === 'passed').length
  const head = `${result.runs.length} 波执行完毕：${passed}/${results.length} worker 通过`
  const failed = results.find(r => r.status !== 'passed')
  return failed ? `${head}；首个未通过 ${failed.workOrderId}: ${failed.summary.slice(0, 120)}` : head
}

/**
 * 登记一个脱离等待的后台计划执行，并挂 settle 追踪。
 * execution 的 settle 只会填账（含 rejection——这里消费掉，绝不成为
 * unhandledRejection），不改变其本身的推进。
 */
export function trackDetachedPlanRun(
  entry: Omit<DetachedPlanRun, 'id' | 'detachedAt'>,
  execution: Promise<PlanExecutorWavesResult>,
): DetachedPlanRun {
  const run: DetachedPlanRun = { ...entry, id: `detached-${++seq}`, detachedAt: Date.now() }
  const key = skey(entry.sessionId)
  let bucket = runsBySession.get(key)
  if (!bucket) {
    bucket = new Map()
    runsBySession.set(key, bucket)
  }
  bucket.set(run.id, run)
  execution.then(
    result => {
      run.settled = { ok: true, summary: summarizeWavesResult(result), settledAt: Date.now() }
    },
    err => {
      const msg = err instanceof Error ? err.message : String(err)
      run.settled = { ok: false, summary: msg.slice(0, 300), settledAt: Date.now() }
    },
  )
  return run
}

/** 本会话全部已登记的后台计划执行（运行中 + 已 settle 未 drain）。 */
export function listDetachedPlanRuns(sessionId?: string): DetachedPlanRun[] {
  return [...(runsBySession.get(skey(sessionId))?.values() ?? [])]
}

/** 取走本会话已 settle 的条目（通知后即移除——遗言只投递一次）。 */
export function drainSettledDetachedPlanRuns(sessionId?: string): DetachedPlanRun[] {
  const bucket = runsBySession.get(skey(sessionId))
  if (!bucket) return []
  const settled: DetachedPlanRun[] = []
  for (const run of bucket.values()) {
    if (run.settled) settled.push(run)
  }
  for (const run of settled) bucket.delete(run.id)
  if (bucket.size === 0) runsBySession.delete(skey(sessionId))
  return settled
}

/** 清空本会话登记——测试卫生 / 会话终止清理用。 */
export function clearDetachedPlanRuns(sessionId?: string): void {
  runsBySession.delete(skey(sessionId))
}

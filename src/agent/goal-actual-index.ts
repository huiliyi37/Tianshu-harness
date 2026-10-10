/**
 * goal 实际用量的跨会话索引（2026-10-10）——`worker_actual` 的同族。
 *
 * 目的：预算定价（goal-budget.ts）的历史信号来源。一次 goal run 结束后把
 * "实际用了多少轮、是否耗尽预算"落一行，下次同一 objective 启动前回灌，
 * 让"上次欠预算"变成"这次发准"。
 *
 * 存储与 worker 侧共用 meridian db（`loadBanditStatesByPrefix` 前缀查询），
 * 不新开日志格式——对账口径与 worker_actual 一致（exhausted 比例 = 发准率）。
 *
 * 纪律：读写一律 best-effort——预算回馈绝不能因脏数据/库不可用而影响运行，
 * 更不能阻塞 headless 短进程的收尾。
 */
import { hashObjective } from './model-routing-shadow.js'
import type { GoalActualSample } from './goal-budget.js'

/** meridian db 的最小切面（与 budget-shape.WorkerEpisodeStore 同形）。 */
export interface GoalActualStore {
  saveBanditState(kind: string, json: string): void
  loadBanditStatesByPrefix(prefix: string, limit?: number): Array<{ kind: string; json: string }> | undefined
}

export interface GoalActualIndexRow {
  /** 本次 run 实际消耗的迭代数（GoalTracker.getIteration()）。 */
  iterationsUsed: number
  /** 预算耗尽终止（terminalReason === 'budget_exhausted'）。 */
  exhausted: boolean
  budget: { maxIterations: number }
}

/** 与 worker 的采样上限同量级：只看最近几次，避免陈旧样本把预算顶死。 */
const SAMPLE_LIMIT = 5

export function goalActualKey(objectiveHash: string, timestamp: number): string {
  return `goal_actual:${objectiveHash}:${timestamp}`
}

/**
 * 解析前缀查询结果。坏行静默跳过——回馈绝不因脏数据炸定价。
 *
 * 注意：objective hash 用 `model-routing-shadow.ts` 的实现（全仓还有
 * `anchor-break-shadow.ts` 一份同实现副本）——**不要再添第三份**。
 */
export function parseGoalActualRows(
  rows: ReadonlyArray<{ kind: string; json: string }> | undefined,
  objectiveHash: string,
): GoalActualSample[] {
  const prefix = `goal_actual:${objectiveHash}:`
  const samples: GoalActualSample[] = []
  for (const row of rows ?? []) {
    if (!row?.kind?.startsWith(prefix)) continue
    try {
      const parsed = JSON.parse(row.json) as Partial<GoalActualIndexRow>
      if (typeof parsed?.iterationsUsed !== 'number' || !Number.isFinite(parsed.iterationsUsed)) continue
      samples.push({
        iterationsUsed: parsed.iterationsUsed,
        ...(parsed.exhausted === true ? { exhausted: true } : {}),
        ...(parsed.budget && typeof parsed.budget.maxIterations === 'number'
          ? { budget: { maxIterations: parsed.budget.maxIterations } }
          : {}),
      })
    } catch { /* 坏行跳过 */ }
  }
  return samples.slice(0, SAMPLE_LIMIT)
}

/** 读同 objective 的历史样本（best-effort，任何异常都退化为"没有历史"）。 */
export function readGoalActualSamples(
  store: GoalActualStore | undefined | null,
  objective: string,
): GoalActualSample[] {
  if (!store || !objective) return []
  try {
    const hash = hashObjective(objective)
    return parseGoalActualRows(store.loadBanditStatesByPrefix(`goal_actual:${hash}:`, SAMPLE_LIMIT), hash)
  } catch {
    return []
  }
}

/** 写一行实际用量（best-effort，绝不抛出）。 */
export function persistGoalActual(
  store: GoalActualStore | undefined | null,
  objective: string,
  row: GoalActualIndexRow,
): void {
  if (!store || !objective) return
  try {
    store.saveBanditState(goalActualKey(hashObjective(objective), Date.now()), JSON.stringify(row))
  } catch {
    // best-effort：预算回馈失败不影响 exit code
  }
}

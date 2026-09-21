/**
 * 调度任务的字段模型与状态机（issue #236）——从 cron-scheduler.ts 沿职责切出。
 *
 * 这里放的是**纯逻辑**：任务生命周期状态（active / paused / stopped）的派生与
 * 兼容镜像、原地更新补丁的应用、可选项归一化。调度行为（tick / 事件触发 / 试跑）
 * 不在此模块——那条接缝既让 cron-scheduler.ts 回到 800 行红线内，也让状态机
 * 可以脱离调度器单测。
 *
 * 依赖方向单向：本模块只 `import type`，不 import cron-scheduler 的运行时值，
 * 因此两者之间不构成运行时循环依赖。
 */
import type { CronTrigger, ScheduledTask } from './cron-scheduler.js'

/** Bounded automatic retry for a failed/timed_out run of a scheduled task. */
export interface ScheduledTaskRetry {
  /** Total attempts including the first (>= 1). */
  maxAttempts: number
  /** Base delay before a retry; grows linearly per attempt. */
  backoffMs: number
}

/**
 * 任务级审查策略（付费版 v1 · T2，对标 Antigravity Review Policy）：
 * - always-review：每次运行的敏感动作都走人工审批（默认，与历史行为一致）
 * - first-runs：前 FIRST_RUNS_TRUST_THRESHOLD 次运行人工审批，之后自动转 auto-proceed
 *   （信任是挣来的）
 * - auto-proceed：无人值守——审批请求 fail-closed 中止本次运行，绝不挂起等人
 */
export type ReviewPolicy = 'always-review' | 'first-runs' | 'auto-proceed'

export const REVIEW_POLICIES: readonly ReviewPolicy[] = ['always-review', 'first-runs', 'auto-proceed']

/**
 * 任务生命周期状态（issue #236）：
 * - active：启用中，会触发
 * - paused：暂停（可恢复的运行态），不触发
 * - stopped：停止 / 归档终态——**定义与历史保留**、可查看、可复制重建，但不再触发
 *
 * 与 `enabled` 布尔的关系见 `resolveTaskStatus`：status 是权威字段，enabled 作为
 * 兼容镜像同步写（enabled = status === 'active'），让旧版本 runtime 读同一份
 * 持久化文件时不会误触发 paused/stopped 任务。
 */
export type ScheduledTaskStatus = 'active' | 'paused' | 'stopped'

export const SCHEDULED_TASK_STATUSES: readonly ScheduledTaskStatus[] = ['active', 'paused', 'stopped']

/**
 * 任务生命周期状态的权威解析：`status` 优先，缺省时由旧字段 `enabled` 派生。
 * 旧持久化数据只有 `enabled` 布尔（无 status），派生规则唯一且无损：
 *   enabled === false → 'paused'（历史语义：保留但不触发）
 *   其余（true / 缺省）→ 'active'
 */
export function resolveTaskStatus(task: Pick<ScheduledTask, 'status' | 'enabled'>): ScheduledTaskStatus {
  const status = normalizeTaskStatus(task.status)
  if (status) return status
  return task.enabled === false ? 'paused' : 'active'
}

/** 只有 active 会触发。paused/stopped 一律不触发（见 tick / runNow / fireByEvent）。 */
export function isFiringStatus(status: ScheduledTaskStatus): boolean {
  return status === 'active'
}

/** Sanitize a task status; returns undefined for absent/invalid input. */
export function normalizeTaskStatus(value: unknown): ScheduledTaskStatus | undefined {
  return SCHEDULED_TASK_STATUSES.includes(value as ScheduledTaskStatus) ? (value as ScheduledTaskStatus) : undefined
}

/** 写状态时同步兼容镜像 enabled，保证旧 runtime 读同一份文件不会误触发。 */
export function withTaskStatus(task: ScheduledTask, status: ScheduledTaskStatus): ScheduledTask {
  return { ...task, status, enabled: status === 'active' }
}

/**
 * 原地更新的补丁（issue #236）。字段缺席 = 不动；可选项显式 `null` = 清除。
 * trigger 变更由调用方用创建同口径校验（validateTriggerOrThrow）。
 */
export interface ScheduledTaskPatch {
  prompt?: string
  trigger?: CronTrigger
  allowedTools?: string[]
  reviewPolicy?: ReviewPolicy | null
  retry?: ScheduledTaskRetry | null
  agentId?: string | null
}

/**
 * 纯函数：把补丁应用到任务副本上（不校验 trigger，由 CronScheduler.update 统一校验）。
 * 不变式——id / createdAt / triggerCount / lastTriggeredAt / cwd / status 不受补丁影响，
 * 所以「原地调整」不会重置运行历史或生命周期状态。
 */
export function applyTaskPatch(task: ScheduledTask, patch: ScheduledTaskPatch): ScheduledTask {
  // 补丁管辖的可选项必须**先剥掉再按三态装回**：`...task` 会把原值一并带回，
  // 光靠"不写这个键"永远表达不了「显式 null 清除」。删除发生在新副本上，
  // 入参 task 不被改动。
  const base = omitOptionalKeys(task, ['reviewPolicy', 'retry', 'agentId'])
  const prompt = typeof patch.prompt === 'string' && patch.prompt.trim() ? patch.prompt.trim() : undefined
  const trigger = patch.trigger
    ? { type: patch.trigger.type, spec: patch.trigger.spec }
    : undefined
  const allowedTools = Array.isArray(patch.allowedTools)
    ? patch.allowedTools.filter(t => typeof t === 'string')
    : undefined
  // 可选项三态：undefined=不动（**保留原值**）/ null=清除 / 有效值=覆盖。
  // 非法值由路由层在调用前拦成 400，这里退化为清除。
  const reviewPolicy = patch.reviewPolicy === undefined
    ? task.reviewPolicy
    : (patch.reviewPolicy === null ? undefined : normalizeReviewPolicy(patch.reviewPolicy))
  const retry = patch.retry === undefined
    ? task.retry
    : (patch.retry === null ? undefined : normalizeRetry(patch.retry))
  const agentId = patch.agentId === undefined
    ? task.agentId
    : (typeof patch.agentId === 'string' && patch.agentId ? patch.agentId : undefined)
  return {
    ...base,
    ...(prompt !== undefined ? { prompt } : {}),
    ...(trigger !== undefined ? { trigger } : {}),
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    ...(reviewPolicy ? { reviewPolicy } : {}),
    ...(retry ? { retry } : {}),
    ...(agentId ? { agentId } : {}),
  }
}

/** 返回去掉指定可选项的副本（不修改入参）。 */
function omitOptionalKeys(
  task: ScheduledTask,
  keys: ReadonlyArray<'reviewPolicy' | 'retry' | 'agentId'>,
): ScheduledTask {
  const copy: ScheduledTask = { ...task }
  for (const key of keys) delete copy[key]
  return copy
}

/** Sanitize a review policy; returns undefined for absent/invalid input. */
export function normalizeReviewPolicy(value: unknown): ReviewPolicy | undefined {
  return REVIEW_POLICIES.includes(value as ReviewPolicy) ? (value as ReviewPolicy) : undefined
}

/** Sanitize a retry policy; returns undefined for absent/invalid input. */
export function normalizeRetry(retry: unknown): ScheduledTaskRetry | undefined {
  if (!retry || typeof retry !== 'object') return undefined
  const r = retry as Partial<ScheduledTaskRetry>
  const maxAttempts = Number(r.maxAttempts)
  const backoffMs = Number(r.backoffMs)
  if (!Number.isFinite(maxAttempts) || maxAttempts < 2) return undefined
  const safeBackoff = Number.isFinite(backoffMs) && backoffMs >= 0 ? backoffMs : 0
  // Cap to keep the scheduler bounded.
  return { maxAttempts: Math.min(Math.floor(maxAttempts), 10), backoffMs: Math.min(safeBackoff, 60 * 60 * 1000) }
}

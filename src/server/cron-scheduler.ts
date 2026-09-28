/**
 * Cron Scheduler — server 层持久化定时调度器
 *
 * 功能：
 * 1. 持久化 schedule 表 → .rivet/scheduled_tasks.json（原子写 tmp+rename）
 * 2. 时间触发 tick（间隔检查，到点 → TaskRegistry.createTask(source:'cron')）
 * 3. 启动时从文件恢复 schedule 表
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { errorContext, serverLogger } from './logger.js'
// issue #236：任务字段模型 / 状态机 / 补丁已沿职责切到 scheduled-task-model.ts
// （本文件越过 800 行红线后按结构 gate 要求拆分）。下面 re-export 保持既有
// `from './cron-scheduler.js'` 的消费方（路由 / 工具 / 测试 / TUI）零改动。
import {
  REVIEW_POLICIES,
  SCHEDULED_TASK_APPROVAL_MODES,
  SCHEDULED_TASK_STATUSES,
  applyTaskPatch,
  isFiringStatus,
  normalizeApprovalMode,
  normalizeRetry,
  normalizeReviewPolicy,
  normalizeTaskStatus,
  resolveTaskStatus,
  withTaskStatus,
} from './scheduled-task-model.js'
import type {
  ReviewPolicy,
  ScheduledTaskPatch,
  ScheduledTaskRetry,
  ScheduledTaskStatus,
} from './scheduled-task-model.js'
import type { ApprovalMode } from '../agent/loop-types.js'
// issue #266 W4 之后本文件再次越过 800 行红线，仍按结构 gate 沿接缝拆分：
// cron 表达式解析与「下次触发」计算是纯函数族（不碰调度器状态），切到 cron-tick.ts。
import { computeNextTrigger, nextCronTime } from './cron-tick.js'

export {
  REVIEW_POLICIES,
  SCHEDULED_TASK_APPROVAL_MODES,
  SCHEDULED_TASK_STATUSES,
  applyTaskPatch,
  isFiringStatus,
  normalizeApprovalMode,
  normalizeRetry,
  normalizeReviewPolicy,
  normalizeTaskStatus,
  resolveTaskStatus,
  withTaskStatus,
}
export type { ReviewPolicy, ScheduledTaskPatch, ScheduledTaskRetry, ScheduledTaskStatus }
export { parseCronExpr, computeNextTrigger } from './cron-tick.js'

// ─── Types ────────────────────────────────────────────────────

export type CronTriggerType = 'interval' | 'cron' | 'oneshot' | 'startup' | 'app-open' | 'file-change' | 'git-push' | 'focus-change'

/** 全部合法的 trigger type（normalizeScheduledTask 校验用）。 */
const TRIGGER_TYPE_SET: ReadonlySet<string> = new Set([
  'interval', 'cron', 'oneshot', 'startup', 'app-open', 'file-change', 'git-push', 'focus-change',
])

/** 事件触发类型——由外部事件（非时间轮询）驱动。spec 语义随类型变化：
 *  startup/app-open/focus-change=空；file-change=监听路径（相对 cwd）；git-push=分支名（空=任意分支）。 */
export const EVENT_TRIGGER_TYPES: ReadonlySet<CronTriggerType> = new Set([
  'startup', 'app-open', 'file-change', 'git-push', 'focus-change',
])

export interface CronTrigger {
  type: CronTriggerType
  spec: string
}

/** first-runs 策略下需要人工审批的前 N 次运行。 */
export const FIRST_RUNS_TRUST_THRESHOLD = 3

export interface ScheduledTask {
  id: string
  prompt: string
  allowedTools: string[]
  trigger: CronTrigger
  recurringMaxAgeMs?: number
  agentId?: string
  createdAt: string
  lastTriggeredAt?: string
  triggerCount: number
  /**
   * 生命周期状态（issue #236）。缺省 = 由 `enabled` 派生（旧持久化数据）；
   * 详见 resolveTaskStatus。写入路径始终与 enabled 同步。
   */
  status?: ScheduledTaskStatus
  /** When false, the task is retained but never fired (paused). Default true.
   *  兼容镜像：新写入以 status 为准并同步本字段（enabled = status === 'active'）。 */
  enabled?: boolean
  /** Optional failure retry policy applied to each fired run. */
  retry?: ScheduledTaskRetry
  /** 审查策略。缺省 = 'always-review'。 */
  reviewPolicy?: ReviewPolicy
  /**
   * 该任务显式声明的审批档位（issue #259）。缺省 = 不注入——会话沿用既有默认
   * 档位，`unattended` 的 fail-closed 语义因此一个字节不变；只有任务显式声明
   * 才覆盖。取值受 SCHEDULED_TASK_APPROVAL_MODES 收窄（auto-accept / auto-safe）。
   */
  approval?: ApprovalMode
  /**
   * 创建该任务时会话的工作区（快照）。任务触发后在快照 cwd 里执行——桌面端
   * 一个 sidecar 托管多个项目，缺省时所有任务都会落到 sidecar 的启动目录，
   * 项目 A 创建的「检查依赖更新」就会在错误的项目里跑 npm/git。
   * 缺省（旧持久化数据）= 由执行方回退到 runtime 池的 defaultCwd。
   */
  cwd?: string
}

export type ScheduleTable = ScheduledTask[]
/** Extra context handed to due-task handlers so the created TaskRecord can be
 *  linked back to its ScheduledTask and inherit the retry policy. */
export interface TaskDueMeta {
  scheduledTaskId?: string
  retry?: ScheduledTaskRetry
  /** 本次运行是否无人值守（reviewPolicy 解析后的生效模式）。 */
  unattended?: boolean
  /**
   * 该任务声明的审批档位（issue #259）——缺省不带该键，执行侧保持既有默认档位。
   * 与 `unattended` 正交：前者决定「审批请求等不等人」，后者决定「等人的时候用哪档」。
   */
  approvalMode?: ApprovalMode
  /** 手动触发（试跑/中止后重跑），非定时到点。 */
  manual?: boolean
  /** 任务创建时会话的工作区快照（执行 cwd，见 ScheduledTask.cwd）。 */
  cwd?: string
}

/**
 * 解析某次触发的生效审查模式。first-runs 以触发前的 triggerCount 判定：
 * 前 FIRST_RUNS_TRUST_THRESHOLD 次人工审批，之后自动放行。
 */
export function resolveRunUnattended(task: Pick<ScheduledTask, 'reviewPolicy' | 'triggerCount'>): boolean {
  switch (task.reviewPolicy) {
    case 'auto-proceed':
      return true
    case 'first-runs':
      return task.triggerCount >= FIRST_RUNS_TRUST_THRESHOLD
    default:
      return false
  }
}
export type TaskDueHandler = (prompt: string, allowedTools: string[], agentId?: string, meta?: TaskDueMeta) => Promise<unknown>
export type UnsubscribeTaskDue = () => void

export interface CronSchedulerConfig {
  schedulePath?: string
  tickIntervalMs?: number
  onCreateTask?: TaskDueHandler
}

// ─── Persistence ──────────────────────────────────────────────

const DEFAULT_SCHEDULE_PATH = '.rivet/scheduled_tasks.json'
const SCHEDULE_ID_PATTERN = /^[A-Za-z0-9_-]+$/

function atomicWriteSchedule(path: string, table: ScheduleTable): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmpPath = path + '.tmp'
  writeFileSync(tmpPath, JSON.stringify(table, null, 2), 'utf-8')
  renameSync(tmpPath, path)
}

/** 一次写盘的结局；失败时带原文（不吞）。 */
export interface PersistOutcome {
  ok: boolean
  error?: string
}

/**
 * 调度表的写盘健康（issue #266 / D5）。
 * 语义边界很重要：`ok=false` **不**代表定义没用——内存里的表已经改了，本轮/本会话
 * 的调度照常；它代表的是「重启后会丢」。界面必须照这个语义说话，否则会把一次可恢复
 * 的权限问题说成「保存失败」，用户会去重打一遍。
 */
export interface PersistHealth {
  ok: boolean
  /** 绝对/相对路径原样回显，便于用户直接去查权限。 */
  path: string
  /** 上次写盘尝试时刻（ms）。 */
  lastAttemptAt?: number
  /** 上次**成功**写盘时刻（ms）——判断「磁盘上那份有多旧」看这个。 */
  lastOkAt?: number
  /** 上次失败原文（成功不清空：残留原因有助于诊断）。 */
  lastError?: string
}

function quarantineSchedule(path: string, reason: string, err?: unknown): void {
  if (!existsSync(path)) return
  const quarantinePath = `${path}.corrupt-${Date.now()}`
  try {
    renameSync(path, quarantinePath)
    serverLogger.warn('Quarantined corrupt schedule file', {
      path,
      quarantinePath,
      reason,
      ...(err ? errorContext(err) : {}),
    })
  } catch (renameErr) {
    serverLogger.error('Failed to quarantine corrupt schedule file', {
      path,
      reason,
      ...(err ? errorContext(err) : {}),
      quarantineError: errorContext(renameErr),
    })
  }
}

function loadSchedule(path: string): ScheduleTable {
  if (!existsSync(path)) return []
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      quarantineSchedule(path, 'schedule root is not an array')
      return []
    }
    const valid: ScheduledTask[] = []
    for (const entry of parsed) {
      const task = normalizeScheduledTask(entry)
      if (task) valid.push(task)
      else serverLogger.warn('Skipping invalid persisted schedule entry')
    }
    return valid
  } catch (err) {
    quarantineSchedule(path, 'schedule JSON parse failed', err)
    return []
  }
}

// ─── Cron Scheduler ───────────────────────────────────────────

export class CronScheduler {
  private schedulePath: string
  private tickIntervalMs: number
  private handlers = new Set<TaskDueHandler>()
  private table: ScheduleTable = []
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private running = false
  private ticking = false
  /** 上次写盘结果（issue #266 / D5）——`ok=false` 必须能一路传到 HTTP 回执与界面。 */
  private persistState: Omit<PersistHealth, 'path'> = { ok: true }

  constructor(config: CronSchedulerConfig) {
    this.schedulePath = config.schedulePath ?? DEFAULT_SCHEDULE_PATH
    this.tickIntervalMs = config.tickIntervalMs ?? 30_000
    if (config.onCreateTask) this.handlers.add(config.onCreateTask)
  }

  // ─── Schedule Management ──────────────────────────────────

  add(task: ScheduledTask): void {
    const normalized = normalizeScheduledTask(task)
    if (!normalized) throw new Error(`Invalid scheduled task: ${task.id}`)
    validateTriggerOrThrow(normalized.trigger)
    if (normalized.trigger.type === 'oneshot' && isFiringStatus(resolveTaskStatus(normalized))) {
      const ts = new Date(normalized.trigger.spec).getTime()
      if (!isNaN(ts) && ts < Date.now()) {
        void this.fireTask(normalized, normalized.triggerCount)
        return
      }
    }
    this.table = [...this.table, cloneTask(normalized)]
    this.persist()
  }

  remove(id: string): boolean {
    const before = this.table.length
    this.table = this.table.filter(t => t.id !== id)
    if (this.table.length === before) return false
    this.persist()
    return true
  }

  /**
   * 暂停（enabled=false）/ 恢复（true）。历史入口，语义映射到状态机：
   * false → 'paused'，true → 'active'（含从 'stopped' 归档态重新启用，
   * 见 issue #236 状态迁移 4）。
   */
  setEnabled(id: string, enabled: boolean): boolean {
    return this.setStatus(id, enabled ? 'active' : 'paused')
  }

  /**
   * 状态迁移（issue #236）：active ⇄ paused（暂停/恢复）、active|paused → stopped
   * （停止/归档，定义与运行历史保留）、stopped → active（重新启用）。
   * `stopped` 与删除的区别：`remove()` 物理移除定义，其运行历史入口随之失联；
   * `stopped` 只改状态，定义仍在 `list()` 里、历史仍可按 scheduledTaskId 查。
   */
  setStatus(id: string, status: ScheduledTaskStatus): boolean {
    const normalized = normalizeTaskStatus(status)
    if (!normalized) return false
    let found = false
    this.table = this.table.map(t => {
      if (t.id !== id) return t
      found = true
      return withTaskStatus(cloneTask(t), normalized)
    })
    if (found) this.persist()
    return found
  }

  /**
   * 原地更新（issue #236）——不再需要「删除旧任务 + 新建任务」来调整 prompt /
   * trigger / 审查策略 / 允许工具。缺席字段不动，可选项显式 `null` 清除。
   * 不变式：id / createdAt / triggerCount / lastTriggeredAt / cwd / status 全部保留，
   * 所以调整定义不会丢失运行历史计数与生命周期状态。
   * trigger 非法时抛错（与创建同口径，由路由转 400）；任务不存在返回 null。
   */
  update(id: string, patch: ScheduledTaskPatch): ScheduledTask | null {
    const current = this.table.find(t => t.id === id)
    if (!current) return null
    const next = applyTaskPatch(cloneTask(current), patch)
    validateTriggerOrThrow(next.trigger)
    this.table = this.table.map(t => (t.id === id ? next : t))
    this.persist()
    return cloneTask(next)
  }

  list(): ScheduleTable {
    return this.table.map(cloneTask)
  }

  get(id: string): ScheduledTask | undefined {
    const task = this.table.find(t => t.id === id)
    return task ? cloneTask(task) : undefined
  }

  subscribeTaskDue(handler: TaskDueHandler): UnsubscribeTaskDue {
    this.handlers.add(handler)
    return () => { this.handlers.delete(handler) }
  }

  /**
   * 立即手动触发一次（试跑驱动信任 · Phase 1）。**恒有人值守**——试跑的
   * 目的就是让审批卡片弹出来（顺路完成 app 授权采集），绝不静默放行。
   * 计入 triggerCount / lastTriggeredAt：与 first-runs 晋级计数天然衔接，
   * interval 任务的下次自动触发也随之顺延（刚跑过，无需紧接着再跑）。
   * oneshot 试跑即消耗（本就是一次性任务，提前手动跑等价于执行它）。
   * 返回 false = 任务不存在或已暂停。
   */
  runNow(id: string): boolean {
    const task = this.table.find(t => t.id === id)
    if (!task || !isFiringStatus(resolveTaskStatus(task))) return false
    const updated: ScheduledTask = {
      ...cloneTask(task),
      lastTriggeredAt: new Date().toISOString(),
      triggerCount: task.triggerCount + 1,
    }
    this.table = this.table.map(t => (t.id === id ? updated : t))
    this.persist()
    void this.fireTask(updated, task.triggerCount, { forceAttended: true, manual: true })
    return true
  }

  /** 事件触发器入口：fire 所有匹配指定类型（+ 可选 spec）的启用任务。
   *  供 startup/app-open（wiring 启动时调）、file-change/git-push/focus-change
   *  （wiring 注册的事件监听器命中时调）使用。
   *  - triggerType：事件类型（必须在 EVENT_TRIGGER_TYPES 里）
   *  - specMatch：可选——file-change 按监听路径匹配（task.spec 前缀或全等），
   *    git-push 按分支名匹配（空 spec=任意分支都 fire）。省略=该类型全部 fire。
   *  返回 fire 的任务数。 */
  fireByEvent(
    triggerType: CronTriggerType,
    specMatch?: { spec?: string },
  ): number {
    if (!EVENT_TRIGGER_TYPES.has(triggerType)) return 0
    let fired = 0
    for (const task of [...this.table]) {
      if (task.trigger.type !== triggerType) continue
      if (!isFiringStatus(resolveTaskStatus(task))) continue
      // spec 匹配：省略=全匹配；给 spec 时——事件 spec 空的任务（任意）总是 fire，
      // 非空的需 spec 全等或事件 spec 是给定路径的前缀（监听父目录覆盖子路径）。
      if (specMatch?.spec !== undefined && task.trigger.spec) {
        const eventSpec = task.trigger.spec
        const given = specMatch.spec
        if (eventSpec !== given && !given.startsWith(eventSpec + '/')) continue
      }
      const updated: ScheduledTask = {
        ...cloneTask(task),
        lastTriggeredAt: new Date().toISOString(),
        triggerCount: task.triggerCount + 1,
      }
      this.table = this.table.map(t => (t.id === task.id ? updated : t))
      void this.fireTask(updated, task.triggerCount)
      fired++
    }
    if (fired > 0) this.persist()
    return fired
  }

  // ─── Lifecycle ─────────────────────────────────────────────

  start(): void {
    if (this.running) return
    const persisted = loadSchedule(this.schedulePath)
    const existingIds = new Set(this.table.map(t => t.id))
    for (const task of persisted) {
      if (!existingIds.has(task.id)) {
        this.table = [...this.table, task]
        existingIds.add(task.id)
      }
    }
    this.running = true
    this.tickTimer = setInterval(() => {
      this.tick(Date.now()).catch(err => {
        serverLogger.error('Cron scheduler tick failed', errorContext(err))
      })
    }, this.tickIntervalMs)
    this.tick(Date.now()).catch(err => {
      serverLogger.error('Cron scheduler initial tick failed', errorContext(err))
    })
  }

  stop(): void {
    this.running = false
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
  }

  isRunning(): boolean {
    return this.running
  }

  // ─── Internal ──────────────────────────────────────────────

  private async tick(now: number): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const toFire: Array<{ task: ScheduledTask; preTriggerCount: number }> = []
      const nextTable: ScheduledTask[] = []
      let changed = false

      for (const task of this.table) {
        if (!isFiringStatus(resolveTaskStatus(task))) {
          // paused / stopped — retain but never fire
          nextTable.push(task)
          continue
        }
        if (task.recurringMaxAgeMs && task.createdAt) {
          const age = now - new Date(task.createdAt).getTime()
          if (age > task.recurringMaxAgeMs) {
            changed = true
            continue
          }
        }

        const next = computeNextTrigger(task, now)
        if (next === null) {
          // oneshot 已完成 → 删除；recurring 的 null 是坏数据 → 保留跳过
          if (task.trigger.type === 'oneshot') {
            changed = true
          } else {
            nextTable.push(task)
          }
          continue
        }

        if (next <= now) {
          const updated: ScheduledTask = {
            ...task,
            allowedTools: [...task.allowedTools],
            lastTriggeredAt: new Date(now).toISOString(),
            triggerCount: task.triggerCount + 1,
          }
          toFire.push({ task: updated, preTriggerCount: task.triggerCount })
          changed = true
          if (task.trigger.type !== 'oneshot') {
            nextTable.push(updated)
          }
        } else {
          nextTable.push(task)
        }
      }

      this.table = nextTable

      for (const fire of toFire) {
        await this.fireTask(fire.task, fire.preTriggerCount)
      }

      if (changed) this.persist()
    } finally {
      this.ticking = false
    }
  }

  private async fireTask(
    task: ScheduledTask,
    preTriggerCount: number,
    opts?: { forceAttended?: boolean; manual?: boolean },
  ): Promise<void> {
    const meta: TaskDueMeta = {
      scheduledTaskId: task.id,
      retry: task.retry,
      // first-runs 用触发前的计数判定（第 N+1 次起自动放行）。
      // 试跑（runNow）恒有人值守，无视 reviewPolicy。
      unattended: opts?.forceAttended
        ? false
        : resolveRunUnattended({ reviewPolicy: task.reviewPolicy, triggerCount: preTriggerCount }),
      ...(opts?.manual ? { manual: true } : {}),
      ...(task.cwd ? { cwd: task.cwd } : {}),
      // 任务声明的审批档位（issue #259）：缺省不带该键，执行侧保持既有默认档位。
      ...(task.approval ? { approvalMode: task.approval } : {}),
    }
    for (const handler of this.handlers) {
      try {
        await handler(task.prompt, [...task.allowedTools], task.agentId, meta)
      } catch (err) {
        serverLogger.warn('Scheduled task handler failed', { taskId: task.id, ...errorContext(err) })
      }
    }
  }

  /**
   * 写盘（issue #266 / D5）。**返回值必须被消费**：以前这里吞掉异常只打日志，
   * 于是磁盘写不进去时接口照样 200，用户看到「保存成功」、重启后改动消失——
   * 本仓反复记录的最贵 bug 形状（静默降级）。现在把结果一路带到 HTTP 回执。
   */
  private persist(): PersistOutcome {
    const at = Date.now()
    this.persistState.lastAttemptAt = at
    try {
      atomicWriteSchedule(this.schedulePath, this.table)
      this.persistState.ok = true
      this.persistState.lastOkAt = at
      return { ok: true }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      this.persistState.ok = false
      this.persistState.lastError = error
      serverLogger.error('Failed to persist schedule table', { schedulePath: this.schedulePath, ...errorContext(err) })
      return { ok: false, error }
    }
  }

  /** 写盘健康快照：`ok=false` 表示「内存里已改、磁盘上没有」（重启会丢）。 */
  persistenceHealth(): PersistHealth {
    return { path: this.schedulePath, ...this.persistState }
  }
}

// ─── Helpers ──────────────────────────────────────────────────

export function createScheduledTask(
  prompt: string,
  trigger: CronTrigger,
  allowedTools: string[] = [],
  opts?: { recurringMaxAgeMs?: number; agentId?: string; retry?: ScheduledTaskRetry; reviewPolicy?: ReviewPolicy; approval?: ApprovalMode; cwd?: string },
): ScheduledTask {
  return {
    id: `cron_${randomUUID().slice(0, 8)}`,
    prompt,
    allowedTools,
    trigger,
    recurringMaxAgeMs: opts?.recurringMaxAgeMs,
    agentId: opts?.agentId,
    createdAt: new Date().toISOString(),
    triggerCount: 0,
    ...(normalizeRetry(opts?.retry) ? { retry: normalizeRetry(opts?.retry)! } : {}),
    ...(normalizeReviewPolicy(opts?.reviewPolicy) ? { reviewPolicy: normalizeReviewPolicy(opts?.reviewPolicy)! } : {}),
    // 非法档位静默丢弃（与 reviewPolicy 同口径）：路由层已把它拦成 400，
    // 这里只保证直接调库时不会写入越权档位。
    ...(normalizeApprovalMode(opts?.approval) ? { approval: normalizeApprovalMode(opts?.approval)! } : {}),
    ...(opts?.cwd ? { cwd: opts.cwd } : {}),
  }
}

/** Trigger 校验（cron 表达式 / interval 正整数 / oneshot ISO / startup/app-open 可空）。
 *  导出供 schedule 工具与 scheduler 内部共用同一校验口径。 */
export function validateTriggerOrThrow(trigger: CronTrigger): void {
  if (trigger.type === 'cron') {
    const next = nextCronTime(trigger.spec, Date.now())
    if (next === null) {
      throw new Error(
        `Invalid cron expression "${trigger.spec}". Expected 5 fields "minute hour day-of-month month day-of-week" (supports *, lists, ranges, steps).`
      )
    }
  }
  if (trigger.type === 'interval') {
    const ms = parseInt(trigger.spec, 10)
    if (isNaN(ms) || ms <= 0) {
      throw new Error(
        `Invalid interval "${trigger.spec}". Must be a positive integer (milliseconds).`
      )
    }
  }
  if (trigger.type === 'oneshot') {
    const ts = new Date(trigger.spec).getTime()
    if (isNaN(ts)) throw new Error(`Invalid oneshot time "${trigger.spec}".`)
  }
  // startup / app-open：事件触发，spec 不参与调度（可为空或描述性备注），无需校验。
}

function normalizeScheduledTask(value: unknown): ScheduledTask | null {
  if (!value || typeof value !== 'object') return null
  const task = value as Partial<ScheduledTask>
  if (typeof task.id !== 'string' || !SCHEDULE_ID_PATTERN.test(task.id)) return null
  if (typeof task.prompt !== 'string') return null
  if (!task.trigger || typeof task.trigger !== 'object') return null
  const trigger = task.trigger as Partial<CronTrigger>
  if (!TRIGGER_TYPE_SET.has(trigger.type as CronTriggerType)) return null
  if (typeof trigger.spec !== 'string') return null
  const allowedTools = Array.isArray(task.allowedTools) && task.allowedTools.every(t => typeof t === 'string')
    ? [...task.allowedTools]
    : []
  const createdAt = typeof task.createdAt === 'string' ? task.createdAt : new Date().toISOString()
  const triggerCount = typeof task.triggerCount === 'number' && Number.isFinite(task.triggerCount) ? task.triggerCount : 0
  // 状态归一（issue #236）：显式 status 优先，否则由旧 enabled 派生。两者一旦
  // 有一方存在就同时写出，使 in-memory 模型与落盘文件都保持
  // `status ⇄ enabled` 同步——旧数据在下次写入时无损自愈。
  const status = normalizeTaskStatus(task.status)
    ?? (typeof task.enabled === 'boolean' ? (task.enabled ? 'active' : 'paused') : undefined)
  const normalized: ScheduledTask = {
    id: task.id,
    prompt: task.prompt,
    allowedTools,
    trigger: { type: trigger.type as CronTriggerType, spec: trigger.spec },
    createdAt,
    triggerCount,
    ...(typeof task.recurringMaxAgeMs === 'number' && Number.isFinite(task.recurringMaxAgeMs) ? { recurringMaxAgeMs: task.recurringMaxAgeMs } : {}),
    ...(typeof task.agentId === 'string' ? { agentId: task.agentId } : {}),
    ...(typeof task.cwd === 'string' && task.cwd ? { cwd: task.cwd } : {}),
    ...(typeof task.lastTriggeredAt === 'string' ? { lastTriggeredAt: task.lastTriggeredAt } : {}),
    ...(status ? { status, enabled: status === 'active' } : {}),
    ...(normalizeRetry(task.retry) ? { retry: normalizeRetry(task.retry)! } : {}),
    ...(normalizeReviewPolicy(task.reviewPolicy) ? { reviewPolicy: normalizeReviewPolicy(task.reviewPolicy)! } : {}),
    // 审批档位（issue #259）：白名单同源归一，非法值静默丢弃——否则一条手工
    // 编辑过持久化文件的越权档位会被原样带进运行。
    ...(normalizeApprovalMode(task.approval) ? { approval: normalizeApprovalMode(task.approval)! } : {}),
  }
  try {
    validateTriggerOrThrow(normalized.trigger)
  } catch {
    return null
  }
  return normalized
}

function cloneTask(task: ScheduledTask): ScheduledTask {
  return {
    ...task,
    allowedTools: [...task.allowedTools],
    trigger: { ...task.trigger },
    ...(task.retry ? { retry: { ...task.retry } } : {}),
  }
}

// ─── Active scheduler registration ──────────────────────────
// serve() 实例化 CronScheduler 后调 setActiveScheduler 登记；工具（如
// schedule_create/list/delete）经 getActiveScheduler() 拿到实例，在 agent
// 对话中自助管理定时任务。非 serve 环境（CLI 无调度器）返回 undefined，
// default-registry 据此**不注册**那三个工具（见 tools/schedule/tool.ts）。
let activeScheduler: CronScheduler | undefined

export function setActiveScheduler(scheduler: CronScheduler | undefined): void {
  activeScheduler = scheduler
}

export function getActiveScheduler(): CronScheduler | undefined {
  return activeScheduler
}

/**
 * unattendedAutomation Pro 门的运行时开关（与 schedule-routes 同一口径：非
 * always-review、显式声明审批档、或含 computer_use 白名单的定时任务都算「无人
 * 值守自动化」）。
 *
 * 门只长在 HTTP 路由上是不够的——agent 的 schedule_create 工具直接调
 * CronScheduler.add，绕过了路由的 wantsUnattended 判定（2026-09-24 修复）。
 * 缺省未注入 = 允许：CLI/TUI 没有 Pro 概念，测试也不必每个用例都注入。
 */
let unattendedAutomationGate: (() => boolean) | undefined

export function setUnattendedAutomationGate(gate: (() => boolean) | undefined): void {
  unattendedAutomationGate = gate
}

export function isUnattendedAutomationAllowed(): boolean {
  return unattendedAutomationGate === undefined || unattendedAutomationGate()
}

/**
 * 调度表写权限门（issue #290）——多 sidecar 指向同一 desktop 目录时，只有
 * 抢到 CronLock 的锁主进程才允许写 scheduled_tasks.json。非锁主的内存表恒空
 * （loadSchedule 只在 start() 执行，而 CronWiring.start() 对非锁主早退），
 * 任何 add/remove/update 都会以空表为基底**整表覆写**落盘——一次建任务就
 * 静默抹掉其他进程建的全部任务定义。
 *
 * 守卫长在写入口（schedule-routes 的写路由 + schedule_create/delete 工具），
 * 不动 CronScheduler 本身：CLI/测试直接 new + add 的单进程语义保持不变。
 * serve.ts 注入 `() => lock.isOwner()`（请求时动态判定——锁竞争是异步的，
 * 且锁可被抢占/释放，不能在注册时静态决定）。缺省未注入 = 允许，与
 * unattendedAutomationGate 同口径。
 */
let scheduleWriteGuard: (() => boolean) | undefined

export function setScheduleWriteGuard(guard: (() => boolean) | undefined): void {
  scheduleWriteGuard = guard
}

export function isScheduleWriteAllowed(): boolean {
  return scheduleWriteGuard === undefined || scheduleWriteGuard()
}

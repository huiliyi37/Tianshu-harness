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
  /** When false, the task is retained but never fired (paused). Default true. */
  enabled?: boolean
  /** Optional failure retry policy applied to each fired run. */
  retry?: ScheduledTaskRetry
  /** 审查策略。缺省 = 'always-review'。 */
  reviewPolicy?: ReviewPolicy
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

// ─── Next Tick Calculation ────────────────────────────────────

/**
 * Parse one cron field into the set of matching values.
 * Supports the standard forms: `*`, `n`, `a-b`, `*​/step`, `a-b/step`, and
 * comma lists of any of those. Returns null on any syntax/range error.
 */
function parseCronField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>()
  for (const part of field.split(',')) {
    if (!part) return null
    const [rangeExpr, stepExpr, extra] = part.split('/')
    if (extra !== undefined) return null
    let step = 1
    if (stepExpr !== undefined) {
      step = parseInt(stepExpr, 10)
      if (!/^\d+$/.test(stepExpr) || isNaN(step) || step < 1) return null
    }
    let lo: number
    let hi: number
    if (rangeExpr === '*') {
      lo = min
      hi = max
    } else if (/^\d+$/.test(rangeExpr!)) {
      lo = parseInt(rangeExpr!, 10)
      // A bare number with a step (`5/15`) means "from 5 to max, every 15".
      hi = stepExpr !== undefined ? max : lo
    } else {
      const m = /^(\d+)-(\d+)$/.exec(rangeExpr!)
      if (!m) return null
      lo = parseInt(m[1]!, 10)
      hi = parseInt(m[2]!, 10)
    }
    if (lo < min || hi > max || lo > hi) return null
    for (let v = lo; v <= hi; v += step) values.add(v)
  }
  return values.size > 0 ? values : null
}

interface ParsedCron {
  minutes: Set<number>
  hours: Set<number>
  daysOfMonth: Set<number>
  months: Set<number>
  daysOfWeek: Set<number>
  domRestricted: boolean
  dowRestricted: boolean
}

export function parseCronExpr(expr: string): ParsedCron | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const minutes = parseCronField(parts[0]!, 0, 59)
  const hours = parseCronField(parts[1]!, 0, 23)
  const daysOfMonth = parseCronField(parts[2]!, 1, 31)
  const months = parseCronField(parts[3]!, 1, 12)
  // Day-of-week accepts 0-7 with 7 ≡ Sunday ≡ 0 (both cron dialects in the wild).
  const rawDow = parseCronField(parts[4]!, 0, 7)
  if (!minutes || !hours || !daysOfMonth || !months || !rawDow) return null
  const daysOfWeek = new Set<number>()
  for (const d of rawDow) daysOfWeek.add(d === 7 ? 0 : d)
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    domRestricted: parts[2] !== '*',
    dowRestricted: parts[4] !== '*',
  }
}

/**
 * Next fire time (UTC) strictly after `from` for a standard 5-field cron
 * expression. Standard day-matching rule: when BOTH day-of-month and
 * day-of-week are restricted, a day fires if EITHER matches; otherwise the
 * restricted one (or neither) applies.
 */
function nextCronTime(expr: string, from: number): number | null {
  const cron = parseCronExpr(expr)
  if (!cron) return null

  const dayMatches = (d: Date): boolean => {
    if (!cron.months.has(d.getUTCMonth() + 1)) return false
    const domOk = cron.daysOfMonth.has(d.getUTCDate())
    const dowOk = cron.daysOfWeek.has(d.getUTCDay())
    if (cron.domRestricted && cron.dowRestricted) return domOk || dowOk
    if (cron.domRestricted) return domOk
    if (cron.dowRestricted) return dowOk
    return true
  }

  // Scan day-by-day (bounded to 4 years to cover Feb-29 schedules), then pick
  // the earliest in-set hour/minute — cheap: at most ~1461 iterations.
  const start = new Date(from)
  start.setUTCSeconds(0, 0)
  const startDay = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())
  const sortedHours = [...cron.hours].sort((a, b) => a - b)
  const sortedMinutes = [...cron.minutes].sort((a, b) => a - b)
  for (let dayOffset = 0; dayOffset <= 4 * 366; dayOffset++) {
    const day = new Date(startDay + dayOffset * 24 * 60 * 60 * 1000)
    if (!dayMatches(day)) continue
    for (const h of sortedHours) {
      for (const m of sortedMinutes) {
        const candidate = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m, 0, 0)
        if (candidate > from) return candidate
      }
    }
  }
  return null
}

export function computeNextTrigger(task: ScheduledTask, now: number): number | null {
  switch (task.trigger.type) {
    case 'startup':
    case 'app-open':
    case 'file-change':
    case 'git-push':
    case 'focus-change':
      // 事件触发器——不参与 tick 轮询。由外部事件（OS 开机 / 应用打开 / 文件
      // 变更 / git push / 窗口聚焦）经 CronScheduler.fireByEvent() 显式触发。
      return null
    case 'interval': {
      const ms = parseInt(task.trigger.spec, 10)
      if (isNaN(ms) || ms <= 0) return null
      const base = task.lastTriggeredAt
        ? new Date(task.lastTriggeredAt).getTime()
        : new Date(task.createdAt).getTime()
      return base + ms
    }
    case 'cron': {
      // Compute from the last fire (or creation), NOT from `now`: next is
      // strictly in the future relative to its base, so basing it on `now`
      // meant `next <= now` never held and cron tasks never fired. With the
      // last-fire base, a tick landing any time after the scheduled minute
      // sees next <= now and fires exactly once.
      const base = task.lastTriggeredAt
        ? new Date(task.lastTriggeredAt).getTime()
        : new Date(task.createdAt).getTime()
      if (isNaN(base)) return null
      return nextCronTime(task.trigger.spec, base)
    }
    case 'oneshot': {
      if (task.triggerCount > 0) return null
      const ts = new Date(task.trigger.spec).getTime()
      if (isNaN(ts)) return null
      return ts <= now ? now : ts
    }
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
    if (normalized.trigger.type === 'oneshot') {
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

  /** Pause (enabled=false) or resume (true) a task without removing it. */
  setEnabled(id: string, enabled: boolean): boolean {
    let found = false
    this.table = this.table.map(t => {
      if (t.id !== id) return t
      found = true
      return { ...cloneTask(t), enabled }
    })
    if (found) this.persist()
    return found
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
    if (!task || task.enabled === false) return false
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
      if (task.enabled === false) continue
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
        if (task.enabled === false) {
          // paused — retain but never fire
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
    }
    for (const handler of this.handlers) {
      try {
        await handler(task.prompt, [...task.allowedTools], task.agentId, meta)
      } catch (err) {
        serverLogger.warn('Scheduled task handler failed', { taskId: task.id, ...errorContext(err) })
      }
    }
  }

  private persist(): void {
    try {
      atomicWriteSchedule(this.schedulePath, this.table)
    } catch (err) {
      serverLogger.error('Failed to persist schedule table', { schedulePath: this.schedulePath, ...errorContext(err) })
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────

export function createScheduledTask(
  prompt: string,
  trigger: CronTrigger,
  allowedTools: string[] = [],
  opts?: { recurringMaxAgeMs?: number; agentId?: string; retry?: ScheduledTaskRetry; reviewPolicy?: ReviewPolicy; cwd?: string },
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
    ...(opts?.cwd ? { cwd: opts.cwd } : {}),
  }
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
    ...(typeof task.enabled === 'boolean' ? { enabled: task.enabled } : {}),
    ...(normalizeRetry(task.retry) ? { retry: normalizeRetry(task.retry)! } : {}),
    ...(normalizeReviewPolicy(task.reviewPolicy) ? { reviewPolicy: normalizeReviewPolicy(task.reviewPolicy)! } : {}),
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

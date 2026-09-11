/**
 * TaskStore — 任务持久化抽象接口 + per-task JSON MVP 实现
 *
 * 为 TaskRegistry 提供持久化层，隔离存储细节。
 * MVP 用 per-task JSON（`.rivet/tasks/{id}.json`），
 * 未来换 SQLite 只需换实现，不动 TaskRegistry 逻辑。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { errorContext, serverLogger } from './logger.js'
import type { ScheduledTaskRetry } from './cron-scheduler.js'

// ─── Task 类型 ────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out'

/** 状态转换优先级：cancelled > timed_out > failed > completed */
const STATUS_PRIORITY: Record<TaskStatus, number> = {
  cancelled: 4,
  timed_out: 3,
  failed: 2,
  completed: 1,
  pending: 0,
  running: 0,
}

const TASK_STATUSES: readonly TaskStatus[] = ['pending', 'running', 'completed', 'failed', 'cancelled', 'timed_out']
const TASK_SOURCES: readonly TaskSource[] = ['api', 'cron', 'manual', 'internal']
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]+$/

/** 检查状态转换是否合法（终态不可被低优先级覆盖） */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  // pending/running 可转到任何状态
  if (from === 'pending' || from === 'running') return true
  // 终态仅可被更高优先级覆盖
  return STATUS_PRIORITY[to] > STATUS_PRIORITY[from]
}

export type TaskSource = 'api' | 'cron' | 'manual' | 'internal'

export interface TaskRecord {
  id: string
  prompt: string
  source: TaskSource
  status: TaskStatus
  createdAt: string
  startedAt?: string
  completedAt?: string
  timeoutMs: number
  callerId: string
  idempotencyKey: string
  /** 如果 force=true 跳过去重 */
  force: boolean
  result?: {
    summary: string
    changedFiles: string[]
    exitCode?: number
  }
  error?: string
  /** cron 任务的工具白名单 */
  allowedTools?: string[]
  /** 关联的 ScheduledTask id（cron 触发时回填，用于看板按定义分组）。 */
  scheduledTaskId?: string
  /** 执行该任务的可见 session id（runtime 池创建后回填，用于跳转会话线程）。 */
  sessionId?: string
  /** 任务执行的工作区（cron 任务=创建时快照；缺省=runtime 池 defaultCwd）。 */
  cwd?: string
  /** 第几次尝试（首次=1）。 */
  attempt?: number
  /** 若本记录是重试，指向原始任务 id。 */
  retryOf?: string
  /** 失败重试策略（从 ScheduledTask 继承，随重试传递）。 */
  retry?: ScheduledTaskRetry
  /** 无人值守运行（reviewPolicy 解析结果）：审批请求 fail-closed 中止而非挂起。 */
  unattended?: boolean
  /** 无人值守中止时缺授权的 app 名（结构化，驱动「去授权/重跑」修复动作）。 */
  haltedApp?: string
}

export interface CreateTaskInput {
  prompt: string
  source: TaskSource
  callerId?: string
  timeoutMs?: number
  force?: boolean
  /** 自定义 idempotency key（不传则自动基于 prompt+caller+bucket 生成） */
  idempotencyKey?: string
  /** cron 任务的工具白名单（默认空 = 无工具限制） */
  allowedTools?: string[]
  /** 关联的 ScheduledTask id。 */
  scheduledTaskId?: string
  /** 尝试序号（重试时 > 1）。 */
  attempt?: number
  /** 原始任务 id（重试链）。 */
  retryOf?: string
  /** 失败重试策略。 */
  retry?: ScheduledTaskRetry
  /** 无人值守运行（审批 fail-closed 中止）。 */
  unattended?: boolean
  /** 任务执行的工作区（cron 任务=创建时快照；缺省=runtime 池 defaultCwd）。 */
  cwd?: string
}

// ─── TaskStore 接口 ───────────────────────────────────────────

export interface TaskStore {
  save(task: TaskRecord): Promise<void>
  load(id: string): Promise<TaskRecord | null>
  list(filter?: TaskFilter): Promise<TaskRecord[]>
  delete(id: string): Promise<void>
  /** 按 idempotency key 查找已有的非终态 task（去重用） */
  findActiveByIdempotencyKey(key: string): Promise<TaskRecord | null>
}

export interface TaskFilter {
  status?: TaskStatus | TaskStatus[]
  source?: TaskSource
  /** Filter to runs of a specific ScheduledTask (execution history). */
  scheduledTaskId?: string
  limit?: number
}

// ─── per-task JSON MVP 实现 ───────────────────────────────────

const DEFAULT_TASKS_DIR = '.rivet/tasks'

const ACTIVE_STATUSES: readonly TaskStatus[] = ['pending', 'running']

export class JsonTaskStore implements TaskStore {
  private dir: string
  private cache = new Map<string, TaskRecord>()
  /**
   * idempotencyKey → active task ids. Built lazily with ONE directory scan on
   * first use, then maintained incrementally by save()/delete() — the previous
   * implementation re-read every task JSON from disk on every dedup check,
   * which turned each createTask into an O(all tasks ever) directory walk.
   * Entries are verified against load() at lookup time, so a stale id (e.g. a
   * record quarantined behind our back) self-evicts instead of poisoning dedup.
   */
  private idemIndex: Map<string, Set<string>> | null = null

  constructor(dir?: string) {
    this.dir = resolve(dir ?? DEFAULT_TASKS_DIR)
    mkdirSync(this.dir, { recursive: true })
  }

  async save(task: TaskRecord): Promise<void> {
    assertValidTaskId(task.id)
    const candidate: unknown = task
    if (!isTaskRecord(candidate)) {
      throw new Error(`Invalid task record: ${task.id}`)
    }
    const tmpPath = this.pathFor(`${task.id}.tmp`)
    const finalPath = this.pathFor(`${task.id}.json`)
    writeFileSync(tmpPath, JSON.stringify(task, null, 2), 'utf-8')
    renameSync(tmpPath, finalPath)
    this.cache.set(task.id, cloneTask(task))
    if (this.idemIndex) {
      if (ACTIVE_STATUSES.includes(task.status)) this.indexAdd(task.idempotencyKey, task.id)
      else this.indexRemove(task.idempotencyKey, task.id)
    }
  }

  async load(id: string): Promise<TaskRecord | null> {
    if (!isValidTaskId(id)) return null
    const cached = this.cache.get(id)
    if (cached) return cloneTask(cached)
    const filePath = this.pathFor(`${id}.json`)
    if (!existsSync(filePath)) return null
    return this.loadFromFile(filePath)
  }

  async list(filter?: TaskFilter): Promise<TaskRecord[]> {
    const files = readdirSync(this.dir).filter(f => f.endsWith('.json'))
    const results: TaskRecord[] = []
    for (const f of files) {
      if (!isValidTaskId(f.slice(0, -'.json'.length))) {
        this.quarantineFile(this.pathFor(f), 'invalid task id filename')
        continue
      }
      const record = this.loadFromFile(this.pathFor(f))
      if (record && this.matchesFilter(record, filter)) {
        results.push(record)
      }
    }
    // 按创建时间倒序
    results.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    if (filter?.limit && filter.limit > 0) {
      return results.slice(0, filter.limit)
    }
    return results
  }

  async delete(id: string): Promise<void> {
    if (!isValidTaskId(id)) return
    const cached = this.cache.get(id)
    if (cached && this.idemIndex) this.indexRemove(cached.idempotencyKey, id)
    this.cache.delete(id)
    const filePath = this.pathFor(`${id}.json`)
    try {
      unlinkSync(filePath)
    } catch (err) {
      if (existsSync(filePath)) {
        serverLogger.warn('Failed to delete task record', { id, ...errorContext(err) })
      }
    }
  }

  async findActiveByIdempotencyKey(key: string): Promise<TaskRecord | null> {
    const index = this.ensureIdemIndex()
    const ids = index.get(key)
    if (!ids) return null
    for (const id of [...ids]) {
      const record = await this.load(id)
      if (record && record.idempotencyKey === key && ACTIVE_STATUSES.includes(record.status)) {
        return record
      }
      // Stale entry (record gone / turned terminal outside save()) — self-evict.
      this.indexRemove(key, id)
    }
    return null
  }

  /** Build the idempotency index once (single directory scan). */
  private ensureIdemIndex(): Map<string, Set<string>> {
    if (this.idemIndex) return this.idemIndex
    this.idemIndex = new Map()
    const files = readdirSync(this.dir).filter(f => f.endsWith('.json'))
    for (const f of files) {
      if (!isValidTaskId(f.slice(0, -'.json'.length))) continue
      const record = this.loadFromFile(this.pathFor(f))
      if (record && ACTIVE_STATUSES.includes(record.status)) {
        this.indexAdd(record.idempotencyKey, record.id)
      }
    }
    return this.idemIndex
  }

  private indexAdd(key: string, id: string): void {
    const ids = this.idemIndex!.get(key)
    if (ids) ids.add(id)
    else this.idemIndex!.set(key, new Set([id]))
  }

  private indexRemove(key: string, id: string): void {
    const ids = this.idemIndex?.get(key)
    if (!ids) return
    ids.delete(id)
    if (ids.size === 0) this.idemIndex!.delete(key)
  }

  private loadFromFile(filePath: string): TaskRecord | null {
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const record = JSON.parse(raw) as unknown
      if (!isTaskRecord(record)) {
        this.quarantineFile(filePath, 'invalid task record schema')
        return null
      }
      this.cache.set(record.id, cloneTask(record))
      return cloneTask(record)
    } catch (err) {
      this.quarantineFile(filePath, 'corrupt task record', err)
      return null
    }
  }

  private matchesFilter(record: TaskRecord, filter?: TaskFilter): boolean {
    if (!filter) return true
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]
      if (!statuses.includes(record.status)) return false
    }
    if (filter.source && record.source !== filter.source) return false
    if (filter.scheduledTaskId && record.scheduledTaskId !== filter.scheduledTaskId) return false
    return true
  }

  private pathFor(fileName: string): string {
    const target = resolve(this.dir, fileName)
    const rel = relative(this.dir, target)
    if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`) || resolve(target) === this.dir) {
      throw new Error(`Path escapes task directory: ${fileName}`)
    }
    return target
  }

  private quarantineFile(filePath: string, reason: string, err?: unknown): void {
    if (!existsSync(filePath)) return
    const quarantinePath = `${filePath}.corrupt-${Date.now()}`
    try {
      renameSync(filePath, quarantinePath)
      serverLogger.warn('Quarantined invalid task record', {
        path: filePath,
        quarantinePath,
        reason,
        ...(err ? errorContext(err) : {}),
      })
    } catch (renameErr) {
      serverLogger.error('Failed to quarantine invalid task record', {
        path: filePath,
        reason,
        ...(err ? errorContext(err) : {}),
        quarantineError: errorContext(renameErr),
      })
    }
  }
}

// ─── 工具函数 ─────────────────────────────────────────────────

/**
 * 复合幂等 key：hash(prompt + caller_id + time_bucket_5min)
 * 5 分钟窗口外的重复 prompt 视为新 task。
 */
export function buildIdempotencyKey(prompt: string, callerId: string, timeMs?: number): string {
  const ts = timeMs ?? Date.now()
  const bucket = Math.floor(ts / (5 * 60 * 1000))
  return hashSimple(`${prompt}|${callerId}|${bucket}`)
}

export function isValidTaskId(id: string): boolean {
  return TASK_ID_PATTERN.test(id)
}

export function assertValidTaskId(id: string): void {
  if (!isValidTaskId(id)) throw new Error(`Invalid task id: ${id}`)
}

function isTaskRecord(value: unknown): value is TaskRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<TaskRecord>
  return typeof record.id === 'string' && isValidTaskId(record.id) &&
    typeof record.prompt === 'string' &&
    typeof record.source === 'string' && TASK_SOURCES.includes(record.source as TaskSource) &&
    typeof record.status === 'string' && TASK_STATUSES.includes(record.status as TaskStatus) &&
    typeof record.createdAt === 'string' &&
    typeof record.timeoutMs === 'number' && Number.isFinite(record.timeoutMs) &&
    typeof record.callerId === 'string' &&
    typeof record.idempotencyKey === 'string' &&
    typeof record.force === 'boolean' &&
    (record.allowedTools === undefined || (Array.isArray(record.allowedTools) && record.allowedTools.every(t => typeof t === 'string'))) &&
    (record.scheduledTaskId === undefined || typeof record.scheduledTaskId === 'string') &&
    (record.sessionId === undefined || typeof record.sessionId === 'string') &&
    (record.attempt === undefined || (typeof record.attempt === 'number' && Number.isFinite(record.attempt))) &&
    (record.retryOf === undefined || typeof record.retryOf === 'string') &&
    (record.haltedApp === undefined || typeof record.haltedApp === 'string') &&
    (record.retry === undefined || (typeof record.retry === 'object' && record.retry !== null &&
      typeof (record.retry as ScheduledTaskRetry).maxAttempts === 'number' &&
      typeof (record.retry as ScheduledTaskRetry).backoffMs === 'number'))
}

function cloneTask(task: TaskRecord): TaskRecord {
  return {
    ...task,
    allowedTools: task.allowedTools ? [...task.allowedTools] : undefined,
    result: task.result ? { ...task.result, changedFiles: [...task.result.changedFiles] } : undefined,
    retry: task.retry ? { ...task.retry } : undefined,
  }
}

/** 简单字符串 hash（FNV-1a，无需 crypto 依赖） */
function hashSimple(input: string): string {
  let hash = 2166136261
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function generateTaskId(): string {
  return `task_${randomUUID().slice(0, 8)}`
}

export function nowISO(): string {
  return new Date().toISOString()
}

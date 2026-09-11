/**
 * TaskRegistry — daemon 级任务注册表
 *
 * 拥有任务生命周期：pending → running → (completed | failed | cancelled | timed_out)
 * 状态转换优先级：cancelled > timed_out > failed > completed
 *
 * 特点：
 * - 每任务持有 AbortController，取消 = abort
 * - 超时：running 超时 → AbortController.abort() → timed_out
 * - 去重：复合幂等 key（prompt + caller_id + time_bucket_5min），支持 force 跳过
 * - 单向 reducer 保证状态转换线性
 *
 * 依赖：
 * - TaskStore：持久化抽象（MVP: per-task JSON）
 * - runtime 池接口：分配 runtime 执行任务（来自姊妹 ingress spec）
 */

import {
  type TaskRecord,
  type TaskStatus,
  type CreateTaskInput,
  type TaskStore,
  type TaskFilter,
  canTransition,
  buildIdempotencyKey,
  generateTaskId,
  nowISO,
} from './task-store.js'
import { errorContext, serverLogger } from './logger.js'

// ─── Runtime 池接口（来自姊妹 ingress spec，Phase 2 实施） ────

export interface RuntimeHandle {
  /**
   * 在 runtime 上执行 AgentLoop，返回结果。
   * `onSessionStart` 在底层会话创建后立即回调，供 registry 回填 sessionId
   * （即使随后执行失败也已关联）。执行失败/中止应 throw，由 registry 落 failed。
   */
  execute(
    prompt: string,
    signal: AbortSignal,
    allowedTools?: string[],
    onSessionStart?: (sessionId: string) => void,
    options?: {
      /** 无人值守运行：会话内审批请求 fail-closed 中止（付费版 v1 · T2）。 */
      unattended?: boolean
      /** 任务执行的工作区（cron 任务=创建时会话工作区快照）。缺省=池 defaultCwd。 */
      cwd?: string
    },
  ): Promise<RuntimeResult>
  /** 释放 runtime 回池 */
  release(): void
}

export interface RuntimeResult {
  summary: string
  changedFiles: string[]
  exitCode?: number
}

export interface RuntimePool {
  /** 获取一个可用的 runtime（可能新建或复用） */
  acquire(taskId: string): Promise<RuntimeHandle>
  /** 池中 runtime 数量 */
  size: number
}

// ─── Notify Policy ─────────────────────────────────────────────

export type NotifyPolicy = 'silent' | 'state_changes' | 'errors_only'

const ERROR_EVENTS = new Set(['failed', 'timed_out'])

// ─── TaskRegistry ──────────────────────────────────────────────

/** 任务事件回调 */
export type TaskEventCallback = (event: TaskEvent) => void

export interface TaskEvent {
  taskId: string
  type: 'created' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out'
  timestamp: string
}

export interface TaskRegistryConfig {
  taskStore: TaskStore
  runtimePool?: RuntimePool
  /** 默认任务超时（毫秒），默认 30 分钟 */
  defaultTimeoutMs?: number
  /** cron 任务默认超时，默认 60 分钟 */
  cronTimeoutMs?: number
  /** 事件回调（按 notifyPolicy 过滤后触发） */
  onEvent?: TaskEventCallback
  /** 通知策略：silent | state_changes | errors_only，默认 state_changes */
  notifyPolicy?: NotifyPolicy
}

export class TaskRegistry {
  private store: TaskStore
  private runtimePool?: RuntimePool
  private defaultTimeoutMs: number
  private cronTimeoutMs: number
  private onEvent?: TaskEventCallback
  private notifyPolicy: NotifyPolicy

  /** 活跃任务的 AbortController 映射 */
  private abortControllers = new Map<string, AbortController>()

  /** 活跃任务的超时 timer */
  private timeoutTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /** 待触发的重试 timer（进程关闭时清理，避免泄漏）。 */
  private retryTimers = new Set<ReturnType<typeof setTimeout>>()

  /** 本进程已认领执行的 pending 任务，防止幂等请求重复调度。 */
  private executionClaims = new Set<string>()

  /** 每任务串行化锁：防止 transition/createTask 并发竞态 */
  private idLocks = new Map<string, Promise<void>>()

  constructor(config: TaskRegistryConfig) {
    this.store = config.taskStore
    this.runtimePool = config.runtimePool
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 30 * 60 * 1000
    this.cronTimeoutMs = config.cronTimeoutMs ?? 60 * 60 * 1000
    this.onEvent = config.onEvent
    this.notifyPolicy = config.notifyPolicy ?? 'state_changes'
  }

  // ─── 创建任务 ─────────────────────────────────────────────

  /** 创建任务并立即调度执行（如有 runtime 池） */
  async createTask(input: CreateTaskInput): Promise<TaskRecord> {
    const callerId = input.callerId ?? 'anonymous'
    const idempotencyKey = input.idempotencyKey ?? buildIdempotencyKey(input.prompt, callerId)
    const force = input.force ?? false

    // 整块串行化：find → build → save 在同一个 per-key 锁内完成
    const record = await this.serialized(idempotencyKey, async () => {
      // 去重检查（force 跳过）
      if (!force) {
        const existing = await this.store.findActiveByIdempotencyKey(idempotencyKey)
        if (existing) return existing
      }

      const timeoutMs = input.timeoutMs ??
        (input.source === 'cron' ? this.cronTimeoutMs : this.defaultTimeoutMs)

      const r: TaskRecord = {
        id: generateTaskId(),
        prompt: input.prompt,
        source: input.source,
        status: 'pending',
        createdAt: nowISO(),
        timeoutMs,
        callerId,
        idempotencyKey,
        force,
        allowedTools: input.allowedTools,
        ...(input.scheduledTaskId ? { scheduledTaskId: input.scheduledTaskId } : {}),
        attempt: input.attempt ?? 1,
        ...(input.retryOf ? { retryOf: input.retryOf } : {}),
        ...(input.retry ? { retry: input.retry } : {}),
        ...(input.unattended ? { unattended: true } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
      }

      await this.store.save(r)
      this.emit({ taskId: r.id, type: 'created', timestamp: r.createdAt })
      return r
    })

    // 同一进程内，重复请求共享首次调度；新进程则可重新认领崩溃前尚未启动的
    // pending 记录，避免只按“是否本次创建”判断而让任务永久滞留。
    if (this.claimPendingExecution(record)) this.dispatchExecution(record)

    return record
  }

  // ─── 状态转换（单点 reducer） ──────────────────────────────

  /**
   * 原子状态转换。
   * 终态不可被低优先级覆盖（cancelled > timed_out > failed > completed）。
   */
  async transition(id: string, to: TaskStatus, extra?: { error?: string; result?: TaskRecord['result']; haltedApp?: string }): Promise<TaskRecord | null> {
    return this.serialized(id, async () => {
      const record = await this.store.load(id)
      if (!record) return null

      if (!canTransition(record.status, to)) {
        return record
      }

      const now = nowISO()
      const updated: TaskRecord = {
        ...record,
        status: to,
        ...(to === 'running' ? { startedAt: record.startedAt ?? now } : {}),
        ...(to === 'completed' || to === 'failed' || to === 'cancelled' || to === 'timed_out' ? { completedAt: now } : {}),
        ...(extra?.error ? { error: extra.error } : {}),
        ...(extra?.result ? { result: extra.result } : {}),
        ...(extra?.haltedApp ? { haltedApp: extra.haltedApp } : {}),
      }

      await this.store.save(updated)
      this.emit({ taskId: id, type: to as TaskEvent['type'], timestamp: now })

      if (to === 'completed' || to === 'failed' || to === 'cancelled' || to === 'timed_out') {
        this.cleanup(id)
      }

      // Bounded auto-retry: only genuine failures (not user cancels) re-run.
      if (to === 'failed' || to === 'timed_out') {
        this.maybeScheduleRetry(updated)
      }

      return updated
    })
  }

  /**
   * Backfill the executing session id onto a task (called by the runtime pool
   * as soon as the session exists, so the desktop can jump to the thread even
   * for failed runs). Serialized on the task id to avoid clobbering transitions.
   */
  async attachSessionId(id: string, sessionId: string): Promise<void> {
    await this.serialized(id, async () => {
      const record = await this.store.load(id)
      if (!record || record.sessionId === sessionId) return
      await this.store.save({ ...record, sessionId })
    })
  }

  /**
   * If a failed/timed_out record has a retry policy with attempts left, enqueue
   * a fresh forced task after a linear backoff. The retry inherits the policy so
   * it can retry again, bounded by maxAttempts.
   */
  private maybeScheduleRetry(record: TaskRecord): void {
    const retry = record.retry
    const attempt = record.attempt ?? 1
    if (!retry || attempt >= retry.maxAttempts) return

    const nextAttempt = attempt + 1
    const origin = record.retryOf ?? record.id
    const delay = Math.max(0, retry.backoffMs) * attempt

    const timer = setTimeout(() => {
      this.retryTimers.delete(timer)
      this.createTask({
        prompt: record.prompt,
        source: record.source,
        callerId: record.callerId,
        timeoutMs: record.timeoutMs,
        allowedTools: record.allowedTools,
        scheduledTaskId: record.scheduledTaskId,
        retry,
        unattended: record.unattended,
        attempt: nextAttempt,
        retryOf: origin,
        force: true,
        idempotencyKey: `${origin}:retry:${nextAttempt}`,
      }).catch(err => {
        serverLogger.error('Failed to enqueue task retry', { taskId: record.id, ...errorContext(err) })
      })
    }, delay)
    // Don't keep the event loop alive solely for a pending retry.
    if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref()
    this.retryTimers.add(timer)
  }

  /** Clear pending retry + timeout timers (call on shutdown to avoid leaks). */
  dispose(): void {
    for (const t of this.retryTimers) clearTimeout(t)
    this.retryTimers.clear()
    for (const t of this.timeoutTimers.values()) clearTimeout(t)
    this.timeoutTimers.clear()
  }

  // ─── 取消 ──────────────────────────────────────────────────

  /** 取消任务。cancelled 是终态，不可被覆盖。 */
  async cancel(id: string): Promise<TaskRecord | null> {
    const ac = this.abortControllers.get(id)
    if (ac) {
      try {
        ac.abort()
      } catch (err) {
        serverLogger.warn('AbortController.abort threw while cancelling task', { id, ...errorContext(err) })
      }
    }
    return this.transition(id, 'cancelled')
  }

  // ─── 事件回调 ──────────────────────────────────────────────

  /** 设置事件回调（用于 task-routes 接线 events.jsonl）。 */
  setEventCallback(cb: TaskEventCallback): void {
    this.onEvent = cb
  }

  /** 获取/设置通知策略 */
  getNotifyPolicy(): NotifyPolicy {
    return this.notifyPolicy
  }

  setNotifyPolicy(policy: NotifyPolicy): void {
    this.notifyPolicy = policy
  }

  /** 注入 runtime 池（延后接线，供 ingress spec Phase 2 就绪后使用）。 */
  setRuntimePool(pool: RuntimePool): void {
    this.runtimePool = pool
  }

  // ─── 查询 ──────────────────────────────────────────────────

  async getTask(id: string): Promise<TaskRecord | null> {
    return this.store.load(id)
  }

  async listTasks(filter?: TaskFilter): Promise<TaskRecord[]> {
    return this.store.list(filter)
  }

  /** 获取活跃（pending/running）任务 */
  async getActiveTasks(): Promise<TaskRecord[]> {
    return this.store.list({ status: ['pending', 'running'] })
  }

  /** 恢复中断的任务：running 记为超时，尚未启动的 pending 重新调度。 */
  async recoverStaleTasks(): Promise<TaskRecord[]> {
    // 进程重启后，所有 running 任务应标记为 timed_out。
    const running = await this.store.list({ status: 'running' })
    const results: TaskRecord[] = []
    for (const r of running) {
      const t = await this.transition(r.id, 'timed_out')
      if (t) results.push(t)
    }

    // save 成功但调度前崩溃会留下 pending。恢复只在 CronWiring 获得进程锁后
    // 调用，executionClaims 继续防止同一 registry 内的重复调度。
    const pending = await this.store.list({ status: 'pending' })
    for (const r of pending) {
      if (this.claimPendingExecution(r)) this.dispatchExecution(r)
    }
    return results
  }

  // ─── 内部方法 ──────────────────────────────────────────────

  /** 按 key 串行化异步操作，防止并发竞态。完成后自动清理锁条目。 */
  private async serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.idLocks.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn) // 前一个无论成功失败都继续
    // 存 settled promise 作为新链尾；完成后只删自己的尾巴（不误删后来者）
    const settled = next.then(() => {}, () => {})
    this.idLocks.set(key, settled)
    settled.then(() => {
      if (this.idLocks.get(key) === settled) {
        this.idLocks.delete(key)
      }
    })
    return next
  }

  private emit(event: TaskEvent): void {
    // 按 notify policy 过滤
    switch (this.notifyPolicy) {
      case 'silent':
        return
      case 'errors_only':
        if (!ERROR_EVENTS.has(event.type)) return
        break
      case 'state_changes':
      default:
        break
    }
    try {
      this.onEvent?.(event)
    } catch (err) {
      serverLogger.warn('Task event callback failed', { taskId: event.taskId, type: event.type, ...errorContext(err) })
    }
  }

  private cleanup(id: string): void {
    const timer = this.timeoutTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.timeoutTimers.delete(id)
    }
    this.abortControllers.delete(id)
  }

  /** 仅认领本进程尚未调度的 pending 任务。 */
  private claimPendingExecution(record: TaskRecord): boolean {
    if (!this.runtimePool || record.status !== 'pending' || this.executionClaims.has(record.id)) return false
    this.executionClaims.add(record.id)
    return true
  }

  /** 启动已认领任务，并在整个执行/失败落库结束后释放认领。 */
  private dispatchExecution(record: TaskRecord): void {
    void this.scheduleExecution(record)
      .catch(async err => {
        try {
          await this.transition(record.id, 'failed', { error: String(err) })
        } catch (transitionErr) {
          serverLogger.error('Failed to mark task execution failure', {
            taskId: record.id,
            executionError: errorContext(err),
            transitionError: errorContext(transitionErr),
          })
        }
      })
      .finally(() => {
        this.executionClaims.delete(record.id)
      })
  }

  /**
   * 调度执行：分配 runtime → 启动 AgentLoop → 监控超时/取消 → 回写结果。
   * 仅在 runtimePool 已提供时可用。
   */
  private async scheduleExecution(record: TaskRecord): Promise<void> {
    if (!this.runtimePool) return

    await this.transition(record.id, 'running')

    const ac = new AbortController()
    this.abortControllers.set(record.id, ac)

    // 设置超时
    if (record.timeoutMs > 0) {
      const timer = setTimeout(() => {
        ac.abort()
        this.transition(record.id, 'timed_out', { error: `Task timed out after ${record.timeoutMs}ms` }).catch(err => {
          serverLogger.error('Failed to mark task timeout', { taskId: record.id, ...errorContext(err) })
        })
      }, record.timeoutMs)
      this.timeoutTimers.set(record.id, timer)
    }

    // 取消信号 → abort controller
    // （外部 cancel() 已调 ac.abort()，这里监听 signal 做清理）

    let handle: RuntimeHandle | null = null
    try {
      handle = await this.runtimePool.acquire(record.id)

      // 检查是否已被取消
      if (ac.signal.aborted) {
        handle.release()
        return // cancel() 已处理状态转换
      }

      const result = await handle.execute(
        record.prompt,
        ac.signal,
        record.allowedTools,
        (sessionId) => { void this.attachSessionId(record.id, sessionId) },
        { unattended: record.unattended === true, cwd: record.cwd },
      )

      await this.transition(record.id, 'completed', { result })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // 无人值守中止：缺授权的 app 名结构化落库（修复闭环「补授权 → 重跑」）。
      const haltedApp = err instanceof Error ? (err as Error & { haltedApp?: string }).haltedApp : undefined
      if (ac.signal.aborted) {
        // 如果是被 abort 的，检查是否已经是 timed_out（超时触发）
        // 如果还不是 → cancelled（手动取消）
        const current = await this.getTask(record.id)
        if (current && current.status !== 'timed_out' && current.status !== 'cancelled') {
          await this.transition(record.id, 'cancelled', { error: message, ...(haltedApp ? { haltedApp } : {}) })
        }
      } else {
        await this.transition(record.id, 'failed', { error: message, ...(haltedApp ? { haltedApp } : {}) })
      }
    } finally {
      handle?.release()
    }
  }
}

import { workerDispatchKey } from '../tools/worker-identity.js'
/**
 * FleetRegistry — TUI 侧的并行子代理「舰队读模型」。
 *
 * 订阅工具流水线已有的结构化 `DelegationActivity` 事件流（T4，原本只有桌面
 * session-manager 消费），在 T9 侧聚合成 per-worker / per-group 的实时快照，
 * 供 /tasks overlay、内联 worker 面板与 TeamPanel 运行态读取。
 *
 * 纯读投影：只做归约与查询，不做调度、不发事件。coordinator 的队列与
 * liveness 是 delegateBatch 栈内私有对象，TUI 拿不到；本读模型完全由事件
 * 流驱动，无需触碰 coordinator 内部。
 */

import type { DelegationActivity } from '../tools/types.js'
import type { ContractProjection } from '../agent/contract-projection.js'
import { shortOrderLabel } from '../tools/worker-activity-stream.js'
import type { WorkerPanelStatus } from './worker-panel-model.js'
/** Max activity log entries kept per worker (ring buffer). */
const ACTIVITY_LOG_MAX = 20

/** 终态归档区（terminalRecords）上限：超出时按 Map 插入序淘汰最旧归档。
 *  与 SessionJobs.MAX_TERMINAL_JOBS / JobRegistry.MAX_TERMINAL_ROWS 同一模式
 *  （f2495993）——淘汰只影响内存态，会话 JSONL 磁盘记录保留。 */
export const TERMINAL_RECORDS_CAP = 50


export interface FleetWorkerView {
  /** Work order id（稳定的 per-worker 标识，区别于 spawning tool id）。 */
  workerId: string
  workOrderId?: string
  dispatchId?: string
  attemptId?: string
  /** 人类友好短标签，例如 "wo_team:T1" → "T1"。 */
  shortLabel: string
  /** 派生该 worker 的委派工具调用 id（委派树父节点）。 */
  parentToolId: string
  /** 嵌套委派的父 worker order id（顶层委派缺省）。 */
  parentWorkerId?: string
  profile: string
  /** 星域 id（星名来源），从 DelegationActivity.authority 透传。 */
  authority?: string
  /** Why this authority was chosen (from DelegationActivity.authorityReason). */
  authorityReason?: string
  /** 原始委派状态。 */
  status: DelegationActivity['status']
  /** 终态失败分类（review-findings/review-infra/timeout/...）——TUI 端区分
   *  completed+review-findings 渲染 ⚠️ 警示态（非系统失败）的数据源。 */
  failureReason?: string
  /** WorkerPanel 兼容状态（glyph / auto-collapse 用）。 */
  panelStatus: WorkerPanelStatus
  /** 是否已到达终态。 */
  terminal: boolean
  /** 最新运行活动行（running）或终态摘要。 */
  /** Latest activity line (running) or terminal summary. */
  activity?: string
  /** Recent activity log entries (newest last, capped at ACTIVITY_LOG_MAX). */
  activityLog: string[]
  /** Self-observed ms since first observation (snapshot-time; frozen after terminal). */
  elapsedMs: number
  /** 累计工具调用次数（CC AgentProgress 对标；运行中递增，终态冻结）。 */
  toolUseCount: number
  /** 累计 token 总数（运行中来自 turn 心跳，终态来自 usage 快照）。 */
  tokenCount: number
  /** 实际派发的模型（终态事件携带）。 */
  model?: string
  /** 终态 token usage 明细（终态事件携带，归档后保留）。 */
  usage?: DelegationActivity['usage']
  /** 终态后尚未被用户查看（detail 未打开）——/tasks 列表的 unread 标记。 */
  unread: boolean
  /** 终态 digest 文本（来自 DelegationActivity.summary）。 */
  summary?: string
  /** 用户契约投影（首条 running 事件携带）。 */
  contract?: ContractProjection
}

export interface FleetGroupProgress {
  total: number
  done: number
  failed: number
  running: number
}

interface FleetRecord {
  workerId: string
  workOrderId?: string
  dispatchId?: string
  attemptId?: string
  parentToolId: string
  parentWorkerId?: string
  profile: string
  authority?: string
  authorityReason?: string
  status: DelegationActivity['status']
  terminal: boolean
  failureReason?: string
  activity?: string
  activityLog: string[]
  startedAt: number
  updatedAt: number
  toolUseCount: number
  tokenCount: number
  model?: string
  usage?: DelegationActivity['usage']
  unread: boolean
  summary?: string
  contract?: ContractProjection
}

/** 从 usage 快照推导 token 总数（total_tokens 优先，缺省回退 input+output）。 */
function usageTotal(usage: DelegationActivity['usage']): number {
  if (!usage) return 0
  if (typeof usage.total_tokens === 'number') return usage.total_tokens
  return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
}

const TERMINAL_STATUSES = new Set<DelegationActivity['status']>([
  'completed', // 跑完且通过；审查拦截（rejected）同态——7cf506eb 引入，缺它则永不终态、卡 active 假象
  'failed',
  'blocked',
  'escalated',
])

/** 把委派状态映射为 WorkerPanel 状态（blocked/escalated 归入 failed 显示）。 */
function panelStatusOf(status: DelegationActivity['status']): WorkerPanelStatus {
  if (status === 'running') return 'running'
  if (status === 'completed') return 'done'
  return 'failed'
}

export class FleetRegistry {
  private records = new Map<string, FleetRecord>()
  /** 终态 worker 归档区：clearGroup 后仍可被 detail pager 查询。 */
  private terminalRecords = new Map<string, FleetRecord>()
  /** 状态版本计数：每次真实状态变更 +1。 */
  private stateVersion = 0

  /**
   * 单调递增的状态版本。调用方按 version 缓存 fleet 面板（sort + 视图分配），
   * version 未变即跳过整段重建。只在实际发生状态变更时递增：apply 真实写入/
   * 更新记录（终态重放仅补缺 model/usage 才算）、clearGroup 有归档/淘汰、
   * markSeen 真改了 unread、clear 清空前非空。
   */
  get version(): number {
    return this.stateVersion
  }

  /**
   * 归约一条委派活动事件。
   * - 首见：stamp startedAt（用于 elapsed）。
   * - 复见：合并状态/活动行；profile 缺省时保留既有（终态事件常不带 profile）。
   */
  apply(activity: DelegationActivity, now: number = Date.now()): void {
    const key = workerDispatchKey(activity)
    const terminal = TERMINAL_STATUSES.has(activity.status)

    // 已终态的 id 又收到非终态事件 = **新一轮派发**（或 resume 续跑），不是旧
    // worker 复活。必须丢掉旧记录走下面的新建路径。
    //
    // 这条路会真实走到，因为 order id 并非每次都新生成：`deriveStableWorkOrderId`
    // 让 batch / team / council 用 `batch:0`、`team:T1` 这类稳定 id（dependsOn 与
    // resume 都依赖它们可预测）。此前的做法是把旧记录移回 active 再合并，于是
    // 下面「只在缺失时才写」的 contract / summary（:163-165）永远停在第一轮的值
    // 上——/tasks 的目标行逐次相同、与本轮任务毫无关系，上一轮的结论还会挂到这
    // 一轮的 worker 上。
    const prior = this.records.get(key) ?? this.terminalRecords.get(key)
    if (prior?.terminal && !terminal && activity.dispatchId) return
    if (prior?.terminal && !terminal) {
      this.records.delete(key)
      this.terminalRecords.delete(key)
    }

    const existing = this.records.get(key)

    // Maintain activity log ring buffer
    const log = existing?.activityLog ? [...existing.activityLog] : []
    if (activity.progressLine && activity.progressLine !== existing?.activity) {
      log.push(activity.progressLine)
      if (log.length > ACTIVITY_LOG_MAX) log.shift()
    }

    if (existing) {
      // 终态重放（settle 即时事件 + 批末兜底循环双发是设计使然）：冻结终态
      // 时刻与状态——不重算 elapsed、不重复标 unread，只补缺 model/usage。
      // 例外（审查门 ee4134c5a HIGH）：worker_gone 是 CLI reconcile 的**推断**
      // 终态（isWorkerRunning 弱代理在 controller 清理→终态发布间隙短暂为
      // false，5s 扫描可能误补）。真实终态到达时必须覆盖它，否则成功 worker
      // 被永久误标 failed。非 worker_gone 终态维持冻结语义（迟到事件不覆盖）。
      if (existing.terminal && terminal) {
        if (existing.failureReason === 'worker_gone' && activity.failureReason !== 'worker_gone') {
          existing.status = activity.status
          existing.failureReason = activity.failureReason
          existing.updatedAt = now
          if (activity.progressLine) existing.activity = activity.progressLine
          this.stateVersion++
          return
        }
        let filled = false
        if (activity.model && !existing.model) { existing.model = activity.model; filled = true }
        if (activity.usage && !existing.usage) { existing.usage = activity.usage; filled = true }
        // 无变化的纯重放不算状态变更（版本不变，调用方不必重建面板）。
        if (filled) this.stateVersion++
        return
      }
      // running → terminal 转变时标记 unread（用户尚未查看终态结果）
      if (terminal && !existing.terminal) existing.unread = true
      existing.status = activity.status
      existing.terminal = terminal
      existing.updatedAt = now
      existing.activityLog = log
      if (activity.failureReason) existing.failureReason = activity.failureReason
      if (activity.profile) existing.profile = activity.profile
      if (activity.parentWorkerId && !existing.parentWorkerId) existing.parentWorkerId = activity.parentWorkerId
      if (activity.authority) existing.authority = activity.authority
      if (activity.authorityReason) existing.authorityReason = activity.authorityReason
      if (activity.progressLine) existing.activity = activity.progressLine
      // 终态 summary 与 contract：只在第一次出现时存（不覆盖，避免空值擦除）。
      if (activity.summary && !existing.summary) existing.summary = activity.summary
      if (activity.contract && !existing.contract) existing.contract = activity.contract
      // 计数只增不减（乱序事件防御）；终态 usage/model 保留供归档后查询。
      if (typeof activity.toolUseCount === 'number' && activity.toolUseCount > existing.toolUseCount) {
        existing.toolUseCount = activity.toolUseCount
      }
      const tokens = Math.max(activity.tokenCount ?? 0, usageTotal(activity.usage))
      if (tokens > existing.tokenCount) existing.tokenCount = tokens
      if (activity.model) existing.model = activity.model
      if (activity.usage) existing.usage = activity.usage
      this.stateVersion++
      return
    }

    this.records.set(key, {
      workerId: key,
      workOrderId: activity.workOrderId,
      dispatchId: activity.dispatchId,
      attemptId: activity.attemptId,
      parentToolId: activity.parentToolId,
      parentWorkerId: activity.parentWorkerId,
      profile: activity.profile ?? 'worker',
      authority: activity.authority,
      authorityReason: activity.authorityReason,
      status: activity.status,
      terminal,
      failureReason: activity.failureReason,
      activity: activity.progressLine,
      activityLog: log,
      startedAt: now,
      updatedAt: now,
      toolUseCount: activity.toolUseCount ?? 0,
      tokenCount: Math.max(activity.tokenCount ?? 0, usageTotal(activity.usage)),
      model: activity.model,
      usage: activity.usage,
      unread: terminal,
      summary: activity.summary,
      contract: activity.contract,
    })
    this.stateVersion++
  }

  private toView(r: FleetRecord, now: number): FleetWorkerView {
    return {
      workerId: r.workerId,
      workOrderId: r.workOrderId,
      dispatchId: r.dispatchId,
      attemptId: r.attemptId,
      shortLabel: shortOrderLabel(r.workOrderId ?? r.workerId),
      parentToolId: r.parentToolId,
      parentWorkerId: r.parentWorkerId,
      profile: r.profile,
      authority: r.authority,
      authorityReason: r.authorityReason,
      status: r.status,
      panelStatus: panelStatusOf(r.status),
      terminal: r.terminal,
      failureReason: r.failureReason,
      activity: r.activity,
      activityLog: r.activityLog,
      elapsedMs: Math.max(0, (r.terminal ? r.updatedAt : now) - r.startedAt),
      toolUseCount: r.toolUseCount,
      tokenCount: r.tokenCount,
      model: r.model,
      usage: r.usage,
      unread: r.unread,
      summary: r.summary,
      contract: r.contract,
    }
  }

  /** 标记某 worker 的终态结果已被查看（detail 打开时调用）。 */
  markSeen(workerId: string): void {
    const r = this.records.get(workerId) ?? this.terminalRecords.get(workerId)
    // 仅当真的改了 unread 才算状态变更（重复 markSeen / 未知 id 不计版本）。
    if (r?.unread) {
      r.unread = false
      this.stateVersion++
    }
  }

  /** 终态且未读的 worker 数量（GlanceBar / 通知行用）。 */
  unreadCount(): number {
    let n = 0
    for (const r of this.records.values()) if (r.terminal && r.unread) n++
    for (const r of this.terminalRecords.values()) if (r.unread) n++
    return n
  }

  /** 全部 worker，按首见时间升序。 */
  getWorkers(now: number = Date.now()): FleetWorkerView[] {
    return [...this.records.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map(r => this.toView(r, now))
  }

  /** 仍在跑（未终态）的 worker，按首见时间升序。 */
  getActiveWorkers(now: number = Date.now()): FleetWorkerView[] {
    return [...this.records.values()]
      .filter(r => !r.terminal)
      .sort((a, b) => a.startedAt - b.startedAt)
      .map(r => this.toView(r, now))
  }

  /** 某委派工具组的完成进度（done/total 由组内 worker 计数派生）。 */
  getGroupProgress(parentToolId: string): FleetGroupProgress {
    const group = [...this.records.values()].filter(r => r.parentToolId === parentToolId)
    return {
      total: group.length,
      done: group.filter(r => r.status === 'completed').length,
      failed: group.filter(r => r.terminal && r.status !== 'completed').length,
      running: group.filter(r => !r.terminal).length,
    }
  }

  /** 当前出现过的委派工具 id（保持首见顺序）。 */
  getParentToolIds(): string[] {
    const ids: string[] = []
    for (const r of this.records.values()) {
      if (!ids.includes(r.parentToolId)) ids.push(r.parentToolId)
    }
    return ids
  }

  /**
   * 委派工具终态时把该组 worker 移入归档区，而不是删除。
   * 返回：
   * - settled：本组刚归档的 worker 视图（按首见时间升序）——供完成沉淀卡渲染；
   *   该组无记录时为空数组。
   * - evictedIds：归档区超出 TERMINAL_RECORDS_CAP 时本次被淘汰的最旧终态
   *   workerId（Map 插入序；未超限时为空）——调用方可据此同步清理关联状态
   *   （如 worker 镜像）。
   */
  clearGroup(parentToolId: string, now: number = Date.now()): { settled: FleetWorkerView[]; evictedIds: string[] } {
    const settled: FleetRecord[] = []
    for (const [id, r] of this.records) {
      if (r.parentToolId === parentToolId) {
        this.records.delete(id)
        this.terminalRecords.set(id, r)
        settled.push(r)
      }
    }
    const evictedIds = this.evictTerminalOverflow()
    if (settled.length > 0 || evictedIds.length > 0) this.stateVersion++
    return {
      settled: settled
        .sort((a, b) => a.startedAt - b.startedAt)
        .map(r => this.toView(r, now)),
      evictedIds,
    }
  }

  /**
   * 归档区超出 TERMINAL_RECORDS_CAP 时按 Map 插入序淘汰最旧归档，返回被淘汰的
   * workerId。归档区里本来就只有终态记录，无「running 永不淘汰」问题（对照
   * job-store 的 evictTerminals，f2495993）。
   */
  private evictTerminalOverflow(): string[] {
    const evicted: string[] = []
    while (this.terminalRecords.size > TERMINAL_RECORDS_CAP) {
      const oldest = this.terminalRecords.keys().next()
      if (oldest.done) break
      this.terminalRecords.delete(oldest.value)
      evicted.push(oldest.value)
    }
    return evicted
  }

  /** 按 id 查找 worker（active 优先，其次归档区）。 */
  getWorkerById(workerId: string, now: number = Date.now()): FleetWorkerView | undefined {
    const r = this.records.get(workerId) ?? this.terminalRecords.get(workerId)
    return r ? this.toView(r, now) : undefined
  }

  private allTerminalRecords(): FleetRecord[] {
    return [...this.records.values()].filter(r => r.terminal)
      .concat([...this.terminalRecords.values()])
  }

  /** 已终态 worker 列表（按首见时间升序）。 */
  getCompletedWorkers(now: number = Date.now()): FleetWorkerView[] {
    return this.allTerminalRecords()
      .sort((a, b) => a.startedAt - b.startedAt)
      .map(r => this.toView(r, now))
  }

  /** 全部 worker（active + 归档），可选 filter。 */
  getAllWorkers(now: number = Date.now(), filter: 'active' | 'completed' | 'all' = 'all'): FleetWorkerView[] {
    const source: FleetRecord[] = []
    if (filter === 'active') {
      source.push(...[...this.records.values()].filter(r => !r.terminal))
    } else if (filter === 'completed') {
      source.push(...this.allTerminalRecords())
    } else {
      // all：union active records + terminal archive，按 id 去重
      const seen = new Set<string>()
      for (const r of this.records.values()) {
        seen.add(r.workerId)
        source.push(r)
      }
      for (const r of this.terminalRecords.values()) {
        if (!seen.has(r.workerId)) source.push(r)
      }
    }
    return source.sort((a, b) => a.startedAt - b.startedAt).map(r => this.toView(r, now))
  }

  get size(): number {
    return this.records.size
  }

  /** 已终态 worker 数量。 */
  completedSize(): number {
    return this.terminalRecords.size
  }

  isEmpty(): boolean {
    return this.records.size === 0 && this.terminalRecords.size === 0
  }

  /** 是否已有任一 worker 仍在跑（auto-collapse 判据）。 */
  hasActive(): boolean {
    for (const r of this.records.values()) {
      if (!r.terminal) return true
    }
    return false
  }

  /**
   * CLI reconcile 判定（sweepStaleDelegationNodes 的 TUI 等价物，2026-08）：
   * 返回「fleet 里 running 但实际已不在跑」的 worker——终态事件漏发的兜底
   * （worker 进程死亡/会话丢失但 delegate 工具异常路径未触发补发）。调用方
   * 对返回的每个 worker 补发 failed 终态；补发后记录转 terminal，再次扫描
   * 不再返回（幂等）。isRunning 由调用方注入（CLI 端 = coordinator.isWorkerRunning）。
   */
  findGoneWorkers(
    isRunning: (workerId: string) => boolean,
    now: number = Date.now(),
  ): FleetWorkerView[] {
    const gone: FleetWorkerView[] = []
    for (const r of this.records.values()) {
      if (r.terminal) continue
      if (isRunning(r.workerId)) continue
      gone.push(this.toView(r, now))
    }
    // view 无 startedAt；同一 now 下 elapsedMs 升序 = startedAt 升序。
    return gone.sort((a, b) => a.elapsedMs - b.elapsedMs)
  }

  clear(): void {
    // 空仓 clear 无状态变更，不计版本。
    if (this.records.size === 0 && this.terminalRecords.size === 0) return
    this.records.clear()
    this.terminalRecords.clear()
    this.stateVersion++
  }
}

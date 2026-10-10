import { workerDispatchKey } from '../tools/worker-identity.js'
/**
 * WorkerMirrorStore — worker 消息镜像（CC teammate 视图对标）。
 *
 * 从 DelegationActivity 事件流（携带 eventKind/eventDetail 原始事件）重建
 * per-worker 的消息级时间线，供「切入 worker 视图」实时渲染：
 *  - text delta 聚合为进行中的 assistant 消息（tool_use / 终态时封口）
 *  - tool_use / tool_result 各成一条消息
 *  - thinking / turn 心跳不入镜像（噪音）
 *
 * cap 50 条消息 / worker：镜像只服务实时视图的「最近上下文」，完整历史
 * 走 worker session JSONL（detail pager 已有该通道）。纯读投影，不做调度。
 */

import type { DelegationActivity } from '../tools/types.js'

/** 每个 worker 镜像的最大消息数（环形，旧消息滚出）。 */
export const MIRROR_MESSAGE_CAP = 50
/** 镜像 worker 记录数上限：超出时按 Map 插入序淘汰最旧 worker。wo_<uuid>
 *  每次派发都是新 id，无上限则长会话无界增长；淘汰只影响实时镜像，完整
 *  历史走 worker session JSONL（detail pager 通道）。 */
export const MIRROR_WORKER_CAP = 50
/** 单条聚合 text 消息的最大长度（防失控 worker 撑爆内存）。 */
const TEXT_MESSAGE_MAX_CHARS = 8_000

export interface MirrorMessage {
  kind: 'text' | 'tool_use' | 'tool_result' | 'status'
  /** text 为聚合的正文；tool 为工具名；status 为终态摘要。 */
  content: string
  at: number
}

interface MirrorRecord {
  messages: MirrorMessage[]
  /** 进行中的 text 聚合缓冲（未封口，不计入 messages）。 */
  openText: string
  openTextAt: number
  /** 已收到终态。再来非终态事件即为新一轮派发（见 apply）。 */
  closed?: boolean
}

export class WorkerMirrorStore {
  private records = new Map<string, MirrorRecord>()

  private recordOf(workerId: string): MirrorRecord {
    let r = this.records.get(workerId)
    if (!r) {
      // 新建记录前封顶：按 Map 插入序淘汰最旧 worker（见 MIRROR_WORKER_CAP）。
      if (this.records.size >= MIRROR_WORKER_CAP) {
        const oldest = this.records.keys().next()
        if (!oldest.done) this.records.delete(oldest.value)
      }
      r = { messages: [], openText: '', openTextAt: 0 }
      this.records.set(workerId, r)
    }
    return r
  }

  private push(r: MirrorRecord, msg: MirrorMessage): void {
    r.messages.push(msg)
    if (r.messages.length > MIRROR_MESSAGE_CAP) r.messages.shift()
  }

  /** 封口进行中的 text 聚合（tool_use / 终态到达时调用）。 */
  private sealText(r: MirrorRecord): void {
    const text = r.openText.trim()
    if (text) this.push(r, { kind: 'text', content: text, at: r.openTextAt })
    r.openText = ''
    r.openTextAt = 0
  }

  apply(activity: DelegationActivity, now: number = Date.now()): void {
    const key = workerDispatchKey(activity)
    const terminal = activity.status !== 'running'
    let r = this.recordOf(key)

    // 已终态的 id 又来非终态事件 = 新一轮派发。order id 对 batch / team /
    // council 是 `batch:0` 这类稳定值（deriveStableWorkOrderId），同一会话里
    // 多派几次必然撞 id——不换记录的话，这一轮的转录会续在上一轮后面，worker
    // 视图于是把两个不同目标的执行过程当成一条连续时间线。
    if (r.closed && !terminal && activity.dispatchId) return
    if (r.closed && !terminal) {
      r = { messages: [], openText: '', openTextAt: 0 }
      this.records.set(key, r)
    }

    if (terminal) {
      this.sealText(r)
      const summary = activity.progressLine ? ` — ${activity.progressLine}` : ''
      this.push(r, { kind: 'status', content: `[${activity.status}]${summary}`, at: now })
      r.closed = true
      return
    }

    switch (activity.eventKind) {
      case 'text': {
        if (!r.openText) r.openTextAt = now
        if (r.openText.length < TEXT_MESSAGE_MAX_CHARS) {
          r.openText += activity.eventDetail ?? ''
        }
        break
      }
      case 'tool_use': {
        this.sealText(r)
        this.push(r, { kind: 'tool_use', content: activity.eventDetail ?? 'tool', at: now })
        break
      }
      case 'tool_result': {
        this.push(r, { kind: 'tool_result', content: activity.eventDetail ?? 'done', at: now })
        break
      }
      case 'lifecycle': {
        // 补偿轮的分界线。不入镜像的话，续跑那一轮的输出会直接续在上一轮后面，
        // 读转录的人看不出中间发生过「预算耗尽 → 接着干」。
        this.sealText(r)
        this.push(r, { kind: 'status', content: activity.eventDetail ?? '补偿轮', at: now })
        break
      }
      // thinking / turn / undefined（纯状态事件）不入镜像
      default:
        break
    }
  }

  /** 已封口消息 + 进行中的 text 尾巴（若有）。 */
  getMessages(workerId: string): MirrorMessage[] {
    const r = this.records.get(workerId)
    if (!r) return []
    const out = [...r.messages]
    const tail = r.openText.trim()
    if (tail) out.push({ kind: 'text', content: tail, at: r.openTextAt })
    return out
  }

  has(workerId: string): boolean {
    return this.records.has(workerId)
  }

  /** 移除某 worker 的镜像（终态归档后由调用方决定何时清理）。 */
  delete(workerId: string): void {
    this.records.delete(workerId)
  }

  clear(): void {
    this.records.clear()
  }
}

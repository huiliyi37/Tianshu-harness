/**
 * worker-process 协议 — worker 子进程隔离 v1 的 stdio NDJSON 消息面。
 *
 * 传输形态对齐 ZCode 实证方案（Electron host ↔ agent 进程）：换行分隔
 * JSON，父写 child.stdin / 子写 stdout，双向单工。stderr 留给子进程自身的
 * 诊断输出（parent 侧收进环形缓冲随失败结果上报）。
 *
 * 生命周期：parent spawn → init（完整序列化配置 + 快照）→ 子进程
 * activity/nested/mailbox 流式上行 + tick 心跳 → result（终态 WorkerRun
 * 序列化）→ 子进程自然退出。abort/steer 为父侧异步下行，可在任意时刻到达。
 */

import type { ContextClaim } from '../../context/claims.js'
import type { MailboxSendInput } from '../worker-mailbox.js'
import type { DelegationActivity } from '../../tools/types.js'
import type { OaiMessage } from '../../api/types.js'
import type { Usage } from '../../api/types.js'
import type { FrozenSnapshotData } from '../../prompt/frozen-snapshot.js'
import type { WorkOrder, WorkerResult } from '../work-order.js'
import type { WorkerActivityKind, WorkerTranscript, WorkerRuntimeDecision, WorkerCheckpoint } from '../worker-session.js'

/** ── Parent → Child ───────────────────────────────────────────── */

export interface SerializedWorkerConfig {
  order: WorkOrder
  cwd: string
  maxTurns: number
  contextWindow: number
  compact: { enabled: boolean; model: string }
  /** runtimeFactory 三分支的路由决策投影——子进程据此忠实重建 client/promptEngine。 */
  runtimeDecision: WorkerRuntimeDecision
  providerName?: string
  baseUrl?: string
  slowThinking?: boolean
  forceJsonRepair?: boolean
  finalizeReport?: boolean
  reviewDepth?: number
  parentApprovalMode?: string
  priorMessages?: OaiMessage[]
  priorUsage?: Partial<Usage>
  /** 上一轮（续跑/复核/重试，同 order.id+nonce）导出的冻结前缀快照——child
   *  构造 PromptEngine 时 inheritFrozenFrom 喂回，历史 user 消息恢复原始字节，
   *  前缀缓存只在新 user 边界断尾而非 byte-0 全 miss（2026-09-06 续跑冷启动
   *  全量重建根修；缺省/坏数据经 parseFrozenSnapshotData 降级为冷启动）。 */
  priorFrozenSnapshot?: FrozenSnapshotData
  sessionNonce?: string
  checkpoint?: WorkerCheckpoint
}

export interface WorkerChildInitPayload {
  config: SerializedWorkerConfig
  /** 主会话 persist.buildMemoryBlock() 快照——子进程 promptEngine 的会话记忆块。 */
  memoryBlock?: string
  /** 主会话 active claims 快照（子进程没有 claimStore，静态种入）。 */
  activeClaims: ContextClaim[]
  /** init 之前就到达的 steer 文本（竞态兜底：parent 收到 steer 时 init 可能还在写）。 */
  steerSeed?: string
}

export type ParentMessage =
  | { t: 'init'; payload: WorkerChildInitPayload }
  | { t: 'steer'; text: string }
  | { t: 'abort'; reason: string }

/** ── Child → Parent ───────────────────────────────────────────── */

/** emitActivity(kind, detail) 的线协议形态——worker-session 的活动流原样上行。 */
export type ChildActivityMessage = { t: 'activity'; kind: WorkerActivityKind; detail?: string }

/** 嵌套委派活动上行（子进程内 coordinator 的 sub-worker 活动）。 */
export type ChildNestedMessage = { t: 'nested'; activity: DelegationActivity }

/** mailbox 桥：子进程内 WorkerMailbox.send → 父进程真实 InMemoryMailbox。 */
export type ChildMailboxMessage = { t: 'mailbox'; msg: MailboxSendInput }

/** 心跳（默认 5s 一拍）。parent 侧 watchdog 以 activity/tick 任一重置停摆钟。 */
export type ChildTickMessage = { t: 'tick'; at: number }

/** 子进程诊断行（stderr 汇聚）。 */
export type ChildLogMessage = { t: 'log'; line: string }

/** 终态：WorkerSessionRun 的可序列化投影。 */
export interface SerializedWorkerRun {
  result: WorkerResult
  transcript: WorkerTranscript
  usage: Usage
  checkpoint?: WorkerCheckpoint
  /** 活转录快照——parent 侧包成 duck-type session{getMessages()} 喂 coordinator。 */
  messages: OaiMessage[]
  /** 本轮终态导出的冻结前缀快照——parent 侧随 WorkerSessionRun 带回，下一轮
   *  （续跑/复核/重试）经 priorFrozenSnapshot 回传给新进程继承。 */
  frozenSnapshot?: FrozenSnapshotData
  /** worker 会话侧的最终 turn 数（诊断用）。 */
  turnCount: number
}

export type ChildMessage =
  | ChildActivityMessage
  | ChildNestedMessage
  | ChildMailboxMessage
  | ChildTickMessage
  | ChildLogMessage
  | { t: 'result'; run: SerializedWorkerRun }

/** ── 帧编解码 ─────────────────────────────────────────────────── */

/** 编码为 NDJSON 帧（无尾换行的 JSON 字符串 + '\n'）。 */
export function encodeFrame(msg: ParentMessage | ChildMessage): string {
  return `${JSON.stringify(msg)}\n`
}

/**
 * 增量 NDJSON 解码器——按行切帧，容忍半行（TCP/pipe 边界不保证整行）。
 * feed(chunk) 返回本段完整解出的消息；解析失败的单行丢弃并计入 badLines
 * （协议中毒时 parent 侧据此判定子进程异常，但单行丢弃不致命——子进程
 * stdout 同时还有诊断写出的可能）。
 */
export function createFrameDecoder(): {
  feed(chunk: string): Array<ParentMessage | ChildMessage>
  get badLines(): number
} {
  let buffer = ''
  let badLines = 0
  return {
    feed(chunk: string): Array<ParentMessage | ChildMessage> {
      buffer += chunk
      const out: Array<ParentMessage | ChildMessage> = []
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line.length > 0) {
          try {
            out.push(JSON.parse(line) as ParentMessage | ChildMessage)
          } catch {
            badLines++
          }
        }
        nl = buffer.indexOf('\n')
      }
      return out
    },
    get badLines(): number {
      return badLines
    },
  }
}

/** 心跳间隔。 */
export const CHILD_TICK_INTERVAL_MS = 5_000
/** SIGTERM 后等待子进程自退的窗口；超窗升级 SIGKILL（kill 阶梯，ZCode 同款）。 */
export const CHILD_TERM_GRACE_MS = 300
export const CHILD_KILL_GRACE_MS = 5_000

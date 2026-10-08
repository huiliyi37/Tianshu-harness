/**
 * SSE 事件流 → 可渲染消息模型的 reducer。
 *
 * 事实源是 server 事件（历史与实时同一条流，seq 有序），本层只做展示聚合：
 * 连续 text_delta 并入同一 assistant 气泡、tool_result 按 id 追加到对应
 * tool 卡、审批按 requestId 配对 resolved。未知事件类型一律忽略（向后兼容）。
 */
import type { SessionEvent } from './bridge.js'
import { canLoadEarlier, mergeHistoryFloor } from './history-window.ts'

export interface QuestionSpec {
  id: string
  prompt: string
  options: string[]
  allowMultiple?: boolean
}

export type ChatItem =
  | { kind: 'user'; text: string; seq: number }
  | { kind: 'assistant'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; name: string; input: unknown; result: string; isError: boolean }
  | { kind: 'approval'; requestId: string; toolName: string; input: unknown; decision?: string }
  | { kind: 'question'; toolUseId: string; questions: QuestionSpec[]; answered?: boolean }
  | { kind: 'plan'; slug: string; title: string; status: string }
  | { kind: 'info'; text: string }
  /** turn_complete.usage 落地——本 turn 缓存命中与 token 用量脚注。 */
  | { kind: 'usage'; input: number; output: number; cacheRead: number; cacheCreate: number }
  /** 自动档检查点 / 看门狗暂停。paused=true 出「继续」按钮。 */
  | { kind: 'checkpoint'; variant: 'autonomy' | 'watchdog'; turns?: number; digest?: string; paused: boolean }
  | { kind: 'queue'; text: string; laneId: string; status: 'queued' | 'steered' | 'delivered' | 'merged' | 'cancelled' }

export interface TodoItem {
  id: string
  content: string
  status: string
}

export interface ChatState {
  items: ChatItem[]
  status: string
  /** 有未决审批时 > 0，驱动输入区置顶提示。 */
  pendingApprovals: number
  /** todo 工具最新写入的任务清单（todo_state 全量镜像）。 */
  todos: TodoItem[]
  /** plan mode: 'off' | 'planning' */
  planMode: string
  /** ask mode: 'off' | 'asking'（与 plan 互斥） */
  askMode: string
  /** plan mode 起草中（plan_draft 帧驱动的轻量指示，不渲染正文）。 */
  planDrafting: boolean
  /** 当前模型/星域（事件驱动，选择器懒加载列表）。 */
  model?: string
  domain?: string
  /** 内核发出续跑邀请（或失败/中止后可点续跑）。 */
  resumeOffer: boolean
  /** 当前回放窗口最早 seq；磁盘还有更早事件时可翻页。 */
  historyFloorSeq: number | null
  diskFirstSeq: number | null
  canLoadEarlier: boolean
  /** 最近一条 phase 文案（工具栏轻提示）。 */
  phase?: string
}

export const initialChatState: ChatState = {
  items: [],
  status: 'idle',
  pendingApprovals: 0,
  todos: [],
  planMode: 'off',
  askMode: 'off',
  planDrafting: false,
  resumeOffer: false,
  historyFloorSeq: null,
  diskFirstSeq: null,
  canLoadEarlier: false,
}

function asText(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

export function reduceEvent(state: ChatState, ev: SessionEvent): ChatState {
  const items = state.items
  const last = items[items.length - 1]
  const d = ev.data ?? {}

  switch (ev.type) {
    case 'user':
      return push(state, { kind: 'user', text: asText(d.text), seq: ev.seq })

    case 'text_delta': {
      if (last?.kind === 'assistant') {
        return replaceLast(state, { ...last, text: last.text + asText(d.text) })
      }
      return push(state, { kind: 'assistant', text: asText(d.text) })
    }

    case 'thinking_delta': {
      if (last?.kind === 'thinking') {
        return replaceLast(state, { ...last, text: last.text + asText(d.text) })
      }
      return push(state, { kind: 'thinking', text: asText(d.text) })
    }

    case 'tool_use':
      return push(state, {
        kind: 'tool',
        id: asText(d.id),
        name: asText(d.name),
        input: d.input,
        result: '',
        isError: false,
      })

    case 'tool_result': {
      // result 可能分块多条（server 侧按字节 coalesce），按 id 向后查找追加。
      const id = asText(d.id)
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i]
        if (it?.kind === 'tool' && it.id === id) {
          const next = [...items]
          next[i] = { ...it, result: it.result + asText(d.result), isError: it.isError || d.isError === true }
          return { ...state, items: next }
        }
      }
      return state
    }

    case 'approval_required':
      return {
        ...push(state, {
          kind: 'approval',
          requestId: asText(d.requestId),
          toolName: asText(d.toolName),
          input: d.input,
        }),
        pendingApprovals: state.pendingApprovals + 1,
      }

    case 'approval_resolved': {
      const rid = asText(d.requestId)
      const next = items.map((it) =>
        it.kind === 'approval' && it.requestId === rid && !it.decision
          ? { ...it, decision: asText(d.decision) || 'approve' }
          : it,
      )
      return { ...state, items: next, pendingApprovals: Math.max(0, state.pendingApprovals - 1) }
    }

    case 'user_question': {
      const raw = Array.isArray(d.questions) ? d.questions : []
      const questions: QuestionSpec[] = raw
        .filter((q): q is Record<string, unknown> => !!q && typeof q === 'object')
        .map((q) => ({
          id: asText(q.id),
          prompt: asText(q.prompt),
          options: Array.isArray(q.options) ? q.options.map((o) => asText(o)).filter(Boolean) : [],
          allowMultiple: q.allowMultiple === true,
        }))
        .filter((q) => q.prompt && q.options.length > 0)
      if (questions.length === 0) return state
      return push(state, { kind: 'question', toolUseId: asText(d.toolUseId), questions })
    }

    case 'todo_state': {
      const raw = Array.isArray(d.items) ? d.items : []
      const todos: TodoItem[] = raw
        .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
        .map((t) => ({ id: asText(t.id), content: asText(t.content), status: asText(t.status) }))
        .filter((t) => t.content)
      return { ...state, todos }
    }

    case 'plan_mode': {
      const mode = asText(d.state) || state.planMode
      // 退出 plan mode 时清起草指示（草稿要么已 submit 要么已废弃）
      return {
        ...state,
        planMode: mode,
        planDrafting: mode === 'planning' && state.planDrafting,
        askMode: mode === 'planning' ? 'off' : state.askMode,
      }
    }

    case 'ask_mode': {
      const asking = asText(d.state) === 'asking'
      return {
        ...state,
        askMode: asking ? 'asking' : 'off',
        planMode: asking ? 'off' : state.planMode,
        planDrafting: asking ? false : state.planDrafting,
      }
    }

    case 'plan_draft':
      return { ...state, planDrafting: true }

    case 'model_switched':
      return { ...state, model: asText(d.modelId) || state.model }

    case 'domain_changed':
      return { ...state, domain: asText(d.name) || asText(d.key) || state.domain }

    case 'resume_offer':
      return { ...state, resumeOffer: true }

    case 'replay_window': {
      const floor = typeof d.floorSeq === 'number' && Number.isFinite(d.floorSeq) ? d.floorSeq : 0
      const diskFirst = typeof d.diskFirstSeq === 'number' && Number.isFinite(d.diskFirstSeq) ? d.diskFirstSeq : floor
      const historyFloorSeq = mergeHistoryFloor(state.historyFloorSeq, floor)
      return {
        ...state,
        historyFloorSeq,
        diskFirstSeq: state.diskFirstSeq == null ? diskFirst : Math.min(state.diskFirstSeq, diskFirst),
        canLoadEarlier: canLoadEarlier(historyFloorSeq, state.diskFirstSeq == null ? diskFirst : Math.min(state.diskFirstSeq, diskFirst)),
      }
    }

    case 'phase': {
      const phase = asText(d.phase)
      if (!phase) return state
      if (phase.startsWith('⚠') || d.historyRestore) {
        return { ...push(state, { kind: 'info', text: phase }), phase }
      }
      return { ...state, phase }
    }

    case 'steer_delivered': {
      const n = typeof d.count === 'number' && Number.isFinite(d.count) ? d.count : 0
      const flipped = items.map((it) =>
        it.kind === 'queue' && it.status === 'steered' ? { ...it, status: 'delivered' as const } : it,
      )
      return push({ ...state, items: flipped }, { kind: 'info', text: n > 0 ? `↪ 插话已注入（${n} 条）` : '↪ 插话已注入' })
    }

    case 'queue_pending': {
      const laneId = asText(d.laneId)
      if (!laneId) return state
      return push(state, { kind: 'queue', text: asText(d.text), laneId, status: 'queued' })
    }

    case 'queue_status': {
      const laneId = asText(d.laneId)
      const status = asText(d.status)
      if (!laneId) return state
      const idx = items.findIndex((it) => it.kind === 'queue' && it.laneId === laneId)
      if (idx < 0) return state
      if (status === 'retracted') {
        if (d.reason === 'sidecar-restart') {
          const next = [...items]
          const current = next[idx]
          if (current?.kind === 'queue') next[idx] = { ...current, status: 'cancelled' }
          return { ...state, items: next }
        }
        return { ...state, items: items.filter((_, i) => i !== idx) }
      }
      if (status !== 'steered' && status !== 'merged') return state
      const cur = items[idx]
      if (!cur || cur.kind !== 'queue' || cur.status !== 'queued') return state
      const next = [...items]
      next[idx] = { ...cur, status }
      return { ...state, items: next }
    }

    case 'autonomy_checkpoint': {
      const paused = d.paused !== false
      const turns = typeof d.turns === 'number' && Number.isFinite(d.turns) ? d.turns : 0
      const digest = typeof d.digest === 'string' && d.digest.trim() ? d.digest : undefined
      return push(state, { kind: 'checkpoint', variant: 'autonomy', turns, digest, paused })
    }

    case 'watchdog_recovery': {
      if (d.stopReason === 'suppressed') return state
      if (d.cancelled === true) {
        return push(state, { kind: 'info', text: '看门狗续跑已取消' })
      }
      const autoContinue = d.autoContinue === true
      const pending = d.pendingAutoContinue === true
      const paused = !autoContinue || pending
      if (!paused) {
        return push(state, { kind: 'info', text: '看门狗已自动恢复' })
      }
      return push(state, { kind: 'checkpoint', variant: 'watchdog', paused: true })
    }

    case 'status': {
      const status = asText(d.status) || state.status
      return { ...state, status, resumeOffer: status === 'running' ? false : state.resumeOffer }
    }

    case 'done':
      // Run 收束——落终态（completed/failed/aborted）。缺了这一分支 status 会
      // 永远停在 'running'，下一条消息被误当 steer 发送（server 409）。
      return { ...state, status: asText(d.status) || 'idle', resumeOffer: false }

    case 'error':
      return push(state, { kind: 'info', text: `⚠ ${asText(d.message) || asText(d.error) || '未知错误'}` })

    case 'rewind': {
      const prompt = asText(d.prompt)
      const anchorSeq = typeof d.anchorSeq === 'number' && Number.isFinite(d.anchorSeq) ? d.anchorSeq : undefined
      let cutIdx = -1
      if (anchorSeq !== undefined) {
        cutIdx = items.findIndex((it) => it.kind === 'user' && it.seq === anchorSeq)
      }
      if (cutIdx < 0 && prompt) {
        for (let i = items.length - 1; i >= 0; i--) {
          const it = items[i]
          if (it?.kind === 'user' && it.text === prompt) {
            cutIdx = i
            break
          }
        }
      }
      const nextItems = cutIdx >= 0 ? items.slice(0, cutIdx) : items
      return {
        ...state,
        items: [...nextItems, { kind: 'info', text: '⏪ 已退回，原文回到输入框' }],
        status: 'idle',
        resumeOffer: false,
        pendingApprovals: nextItems.filter((it) => it.kind === 'approval' && !it.decision).length,
      }
    }

    case 'turn_complete': {
      // usage 缺失（旧内核）或全零（合成/中止 turn）不出脚注
      const u = d.usage
      if (!u || typeof u !== 'object') return state
      const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
      const r = u as Record<string, unknown>
      const input = num(r.input_tokens)
      const output = num(r.output_tokens)
      if (input <= 0 && output <= 0) return state
      return push(state, {
        kind: 'usage',
        input,
        output,
        cacheRead: num(r.cache_read_input_tokens),
        cacheCreate: num(r.cache_creation_input_tokens),
      })
    }

    case 'steer_queued':
      return push(state, { kind: 'info', text: '↪ 已排队插话，将在下一个工具边界注入' })

    case 'plan_submitted': {
      const slug = asText(d.slug)
      const title = asText(d.title)
      const status = asText(d.status) || 'submitted'
      if (!slug) return push(state, { kind: 'info', text: '📋 计划已提交审批' })
      // 同一计划的状态更新（reject → 再 submit）原位刷新，不重复出卡
      const idx = items.findIndex((it) => it.kind === 'plan' && it.slug === slug)
      const drafted = { ...state, planDrafting: false }
      if (idx >= 0) {
        const next = [...items]
        next[idx] = { kind: 'plan', slug, title: title || (items[idx] as { title: string }).title, status }
        return { ...drafted, items: next }
      }
      return push(drafted, { kind: 'plan', slug, title, status })
    }

    default:
      return state
  }
}

function push(state: ChatState, item: ChatItem): ChatState {
  return { ...state, items: [...state.items, item] }
}

function replaceLast(state: ChatState, item: ChatItem): ChatState {
  return { ...state, items: [...state.items.slice(0, -1), item] }
}

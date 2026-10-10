/**
 * 会话 SSE 事件 → 聊天轮事件 的纯映射。
 *
 * 对齐 webview model.ts 与 server session-manager 的消费/生产形状：
 *  - text_delta.data.text 为增量文本；空/非字符串不产事件。
 *  - done.data.status 是 run 的终态（completed/failed/aborted）——chat 一轮的
 *    settle 点；turn_complete 是单轮用量脚注（→ usage 事件，供上下文圆环上报），
 *    不结束 chat 轮（run 内多轮工具循环）。
 *  - error.data.message（或 error）给失败文案。
 *  - approval_required → 结构化审批（requestId/toolName/input），由原生对话框接管。
 *  - approval_resolved → 审批闭环信号（轮超时豁免的恢复点，见 turn-timeout.ts）。
 *  - user_question → 结构化提问（toolUseId + questions[]），由原生对话框接管；
 *    答案按「组装普通用户消息」约定回传（server 侧 ask_user_question 只回占位符 + endTurn）。
 *  - tool_use → {id, name, detail(≤160 行摘要), inputText(≤2000 折叠卡参数全文)}；
 *    id 缺失为空串（消费端据此降级为文本行）。
 *  - tool_result → {id, name, isError, partial, output(uiContent 优先)}；
 *    partial 帧为流式进度 chunk（消费端决定忽略或预览，v1 忽略）；id/name 缺失不产事件。
 *  - thinking_delta → 思考增量（连续非空增量由宿主合并为思考块）；空/非字符串不产。
 *
 * 不依赖 vscode（仅 import type），可在扩展宿主外单测。
 * @module
 */
import type { SessionEvent } from '../sidecar/protocol.js'

/** 结构化提问的一条问题（server ask_user_question 载荷的归一化投影）。 */
export interface ChatQuestion {
  id: string
  prompt: string
  options: string[]
  allowMultiple: boolean
}

/** 一次聊天轮内，一条 sidecar 事件对回复流的贡献。 */
export type ChatTurnEvent =
  /** 追加到回复的助手文本增量。 */
  | { kind: 'delta'; text: string }
  /** 本轮收束；`reason` 为 done.status（completed/failed/aborted）。 */
  | { kind: 'end'; reason: string }
  /** 轮内失败。 */
  | { kind: 'error'; message: string }
  /** 工具调用开始——id 与结果更新配对；detail 为行摘要，inputText 为折叠卡参数全文。
   *  id 缺失为空串（老内核），消费端降级为文本行。 */
  | { kind: 'tool'; id: string; name: string; detail: string; inputText: string }
  /** 工具调用结果——partial=true 为流式进度 chunk（消费端 v1 忽略）；output=uiContent 优先。 */
  | { kind: 'tool-result'; id: string; name: string; isError: boolean; partial: boolean; output: string }
  /** 思考增量——连续非空增量由宿主合并为思考块（fork chatModel 合并判据不依赖 id）。 */
  | { kind: 'thinking'; text: string }
  /** 工具调用待审批——由原生对话框接管（不结束轮）。 */
  | { kind: 'approval'; requestId: string; toolName: string; input: unknown }
  /** 审批闭环信号——审批豁免的恢复点（见 turn-timeout.ts）。 */
  | { kind: 'approval-resolved'; requestId: string }
  | { kind: 'approval-snapshot'; approvals: Array<{ requestId: string; toolName: string; input: unknown }> }
  /** 结构化提问——由原生对话框接管（不结束轮）。 */
  | { kind: 'question'; toolUseId: string; questions: ChatQuestion[] }
  /** 用量脚注（turn_complete）——promptTokens=当前上下文（contextTokens 优先），
   *  completionTokens=累计 output（单轮差分由 participant 做）；不结束 chat 轮。 */
  | { kind: 'usage'; promptTokens: number; completionTokens: number }

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 非负有限数的归一化；负数/NaN/非数一律 undefined。 */
function asNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * 归一化 server 的 questions 载荷（未知输入一律容错过滤）。
 * @param raw - user_question.data.questions 原始值。
 * @returns 全部必填字段合法的条目；无合法条目时为空数组。
 */
export function parseQuestions(raw: unknown): ChatQuestion[] {
  if (!Array.isArray(raw)) return []
  const out: ChatQuestion[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const q = item as Record<string, unknown>
    const id = asString(q.id)
    if (id === '') continue
    out.push({
      id,
      prompt: asString(q.prompt),
      options: Array.isArray(q.options) ? q.options.filter((o): o is string => typeof o === 'string') : [],
      allowMultiple: q.allowMultiple === true,
    })
  }
  return out
}

/** 工具参数摘要的截断上限（聊天行不承载长输出）。 */
const TOOL_DETAIL_LIMIT = 160

/** 折叠卡参数全文的截断上限（行摘要 160 给一行，展开卡承载细节）。 */
const TOOL_INPUT_TEXT_LIMIT = 2000

/** 超长截断加省略号。 */
function truncateText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * 工具参数全文（折叠卡 Input 区）：对象 JSON 化（两空格缩进）后截断；
 * 字符串原样截断；不可序列化/无信息回退空串。
 * @param input - `tool_use.data.input` 原始值。
 */
function fullToolInputText(input: unknown): string {
  if (typeof input === 'string') return truncateText(input, TOOL_INPUT_TEXT_LIMIT)
  if (input !== null && typeof input === 'object') {
    try {
      const json = JSON.stringify(input, null, 2)
      return json === undefined ? '' : truncateText(json, TOOL_INPUT_TEXT_LIMIT)
    } catch {
      return ''
    }
  }
  return ''
}

/**
 * 工具参数的一行摘要：优先 `command` / `file_path` / `path`，其次整体 JSON。
 * @param input - `tool_use.data.input` 原始值。
 * @returns 摘要文本（超长截断加省略号）；无可用信息时为空串。
 */
function summarizeToolInput(input: unknown): string {
  const truncate = (text: string): string => truncateText(text, TOOL_DETAIL_LIMIT)
  if (typeof input === 'string') return truncate(input)
  if (input !== null && typeof input === 'object') {
    const rec = input as Record<string, unknown>
    for (const key of ['command', 'file_path', 'path'] as const) {
      const value = rec[key]
      if (typeof value === 'string' && value !== '') return truncate(value)
    }
    try {
      const json = JSON.stringify(rec)
      return json === undefined ? '' : truncate(json)
    } catch {
      return ''
    }
  }
  return ''
}

/**
 * 解释一条会话事件。
 * @param ev - 来自 per-session SSE 订阅的会话事件。
 * @returns 该事件对应的聊天轮事件；与本轮无关时返回 undefined。
 */
export function interpretSessionEvent(ev: SessionEvent): ChatTurnEvent | undefined {
  const d = ev.data ?? {}
  switch (ev.type) {
    case 'text_delta': {
      const text = asString(d.text)
      return text === '' ? undefined : { kind: 'delta', text }
    }
    case 'tool_use': {
      const name = asString(d.name)
      if (name === '') return undefined
      return {
        kind: 'tool',
        id: asString(d.id),
        name,
        detail: summarizeToolInput(d.input),
        inputText: fullToolInputText(d.input),
      }
    }
    case 'tool_result': {
      const id = asString(d.id)
      const name = asString(d.name)
      if (id === '' || name === '') return undefined
      return {
        kind: 'tool-result',
        id,
        name,
        isError: d.isError === true,
        partial: d.partial === true,
        output: asString(d.uiContent) || asString(d.result),
      }
    }
    case 'thinking_delta': {
      const text = asString(d.text)
      return text === '' ? undefined : { kind: 'thinking', text }
    }
    case 'done':
      return { kind: 'end', reason: asString(d.status) || 'completed' }
    case 'error':
      return { kind: 'error', message: asString(d.message) || asString(d.error) || '未知错误' }
    case 'approval_required': {
      const requestId = asString(d.requestId)
      if (requestId === '') return undefined
      return { kind: 'approval', requestId, toolName: asString(d.toolName) || '工具调用', input: d.input }
    }
    case 'approval_resolved':
      return { kind: 'approval-resolved', requestId: asString(d.requestId) }
    case 'approval_snapshot':
      return { kind: 'approval-snapshot', approvals: (Array.isArray(d.approvals) ? d.approvals : []).flatMap((item: unknown) => {
        if (!item || typeof item !== 'object') return []
        const row = item as Record<string, unknown>
        const requestId = asString(row.requestId)
        return requestId ? [{ requestId, toolName: asString(row.toolName) || '工具调用', input: row.input }] : []
      }) }
    case 'user_question': {
      const questions = parseQuestions(d.questions)
      if (questions.length === 0) return undefined
      return { kind: 'question', toolUseId: asString(d.toolUseId), questions }
    }
    case 'turn_complete': {
      // usage 是「会话累计快照」（input/output 均为加总，非单轮）——把它当 Context
      // Window 会把累计流量当占用显示（实测面板 276.0K = 累计 267,722+8,312）。
      // promptTokens 取 contextTokens（内核 getEstimatedTokens 的当轮上下文估算），
      // 仅旧内核缺省时退回累计 input_tokens；output 累计值由调用方差分（participant）。
      // 双无有效值不产事件；仅 output 的中断补发快照也上报。
      const usage = (d.usage ?? {}) as Record<string, unknown>
      const prompt = asNonNegativeNumber(d.contextTokens) ?? asNonNegativeNumber(usage.input_tokens) ?? 0
      const output = asNonNegativeNumber(usage.output_tokens) ?? 0
      if (prompt <= 0 && output <= 0) return undefined
      return { kind: 'usage', promptTokens: prompt, completionTokens: output }
    }
    default:
      return undefined
  }
}

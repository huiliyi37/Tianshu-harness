/**
 * 对话历史管理（上下文注入式多轮对话）。
 *
 * 背景（2026-09-24 实测）：天枢 headless（-p）的会话不写"可回放消息文件"
 * （hasContent=false），`-r/--resume` 会静默降级为新会话——服务端续接在
 * headless 场景不可用。因此多轮对话由本层承载：
 *   bridge 维护每个 QQ 会话的历史（用户消息 + 天枢回复，带裁剪），
 *   每次调用时以 formatPrompt 拼进 prompt。
 *
 * 特点：与天枢内部机制零耦合、行为确定；代价是历史随 prompt 计入输入 token，
 * 由 maxMessages / maxChars 预算控制。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const DEFAULT_MAX_MESSAGES = 8
export const DEFAULT_MAX_CHARS = 6000

/** 裁剪：先生成上限保留最近 N 条，再按字符预算从尾部回溯。 */
export function pruneHistory(entries, {
  maxMessages = DEFAULT_MAX_MESSAGES,
  maxChars = DEFAULT_MAX_CHARS,
} = {}) {
  let list = Array.isArray(entries)
    ? entries.filter((e) => e && typeof e.content === 'string' && e.content.length > 0)
    : []
  if (list.length > maxMessages) list = list.slice(list.length - maxMessages)
  let total = 0
  const kept = []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const len = list[i].content.length
    if (total + len > maxChars && kept.length > 0) break
    total += len
    kept.unshift(list[i])
  }
  return kept
}

/** 把（历史 + 当前消息）组装为一次 headless 调用的 prompt。 */
export function formatPrompt(currentMessage, entries) {
  const history = Array.isArray(entries) ? entries : []
  if (history.length === 0) return currentMessage
  const lines = history.map((e) => `${e.role === 'assistant' ? '助手' : '用户'}：${e.content}`)
  return [
    '【以下是你在与本用户的持续对话中的历史记录，供理解上下文】',
    ...lines,
    '【以上为历史记录】',
    '',
    '【用户的新消息】',
    currentMessage,
  ].join('\n')
}

export class HistoryStore {
  #file
  #maxMessages
  #maxChars
  #data = null

  constructor({ file = null, maxMessages = DEFAULT_MAX_MESSAGES, maxChars = DEFAULT_MAX_CHARS } = {}) {
    this.#file = file
    this.#maxMessages = maxMessages
    this.#maxChars = maxChars
  }

  #ensure() {
    if (this.#data) return this.#data
    this.#data = {}
    if (this.#file) {
      try {
        const parsed = JSON.parse(readFileSync(this.#file, 'utf8'))
        if (parsed && typeof parsed === 'object') this.#data = parsed
      } catch { /* 首次运行等 */ }
    }
    return this.#data
  }

  get(key) {
    const data = this.#ensure()
    return Array.isArray(data[key]) ? [...data[key]] : []
  }

  appendTurn(key, userText, assistantText) {
    const data = this.#ensure()
    const entries = [
      ...(Array.isArray(data[key]) ? data[key] : []),
      { role: 'user', content: String(userText ?? '') },
      { role: 'assistant', content: String(assistantText ?? '') },
    ]
    data[key] = pruneHistory(entries, { maxMessages: this.#maxMessages, maxChars: this.#maxChars })
    this.#persist()
    return this.get(key)
  }

  #persist() {
    if (!this.#file || !this.#data) return
    try {
      mkdirSync(dirname(this.#file), { recursive: true })
      writeFileSync(this.#file, JSON.stringify(this.#data, null, 2))
    } catch { /* 尽力而为 */ }
  }
}

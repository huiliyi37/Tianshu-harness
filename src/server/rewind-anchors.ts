/**
 * Rewind 锚点配对——用户消息 ↔ `user` 事件（rewind / 编辑重发的唯一事实源）。
 *
 * 全等匹配（`消息 content === 事件 text`）在真实会话里必然落空：用户原文进
 * agent 消息列表时被追加了 hook 注入段。配对失败的直接后果是条目缺 seq，桌面
 * 端只能退到「序数降级」；而 hook 直接塞进列表的独立注入消息（磁盘对账 / 取证
 * 提醒 / 图片桥接）同样被当成 rewind 点返回，把序数彻底顶偏 → 编辑重发切到错误
 * 的消息索引。见 2026-09-08 会话现场：
 *   `point.content = 事件文本 + '\n<system-reminder>\n【太一·取证】…'`
 *
 * 从 session-manager 抽出的独立纯函数单元：session-manager 已触顶行数账本，
 * 且这块逻辑无状态、可单独测。
 */
import type { OaiMessage } from '../api/oai-types.js'

/** `user` 事件的最小投影（rewind 锚点只需要 seq / 时间戳 / 原文）。 */
export interface UserEventRef {
  seq: number
  ts: number
  text: string
}

/** 一条消息与它的来源事件配对结果。 */
export interface RewindAnchor {
  seq: number
  /** 事件原文——前端 blocks 里的 user 文本，也是 rewind 事件的 prompt。 */
  text: string
  ts: number
}

/**
 * hook 注入段的后缀形状：用户原文进 agent 消息列表时被追加的
 * `\n<system-reminder>…`（也有 `<hook_result>` 等同类标签）。
 */
const INJECTION_SUFFIX = /\n<[a-z][a-z0-9-]*(?:\s|>)/g

/**
 * 剥掉注入后缀，留下用户原文；正文本身不含注入时原样返回。
 * 取**最后一个**标签起点：用户正文里可能自带 `\n<div>` 这类片段，注入永远
 * 追加在末尾，按首个标签切会把正文腰斩。
 */
export function stripInjectedSuffix(content: string): string {
  let last = -1
  for (const m of content.matchAll(INJECTION_SUFFIX)) {
    if (m.index > 0) last = m.index
  }
  return last > 0 ? content.slice(0, last) : content
}

/**
 * 把 agent 消息列表里的 user 消息与事件日志配对。只产出「能对上事件」的
 * 消息：先全等、再剥离注入后缀全等，注入消息天然落选（它们没有事件）。
 *
 * 返回 Map 的迭代顺序 = 消息顺序；value.text 是事件原文。
 */
export function buildUserAnchors(
  msgs: OaiMessage[],
  userEvents: UserEventRef[],
): Map<number, RewindAnchor> {
  const anchors = new Map<number, RewindAnchor>()
  let cursor = 0
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!
    if (m.role !== 'user' || typeof m.content !== 'string') continue
    const stripped = stripInjectedSuffix(m.content)
    let hit = -1
    for (let k = cursor; k < userEvents.length; k++) {
      const t = userEvents[k]!.text
      if (t === m.content || (stripped !== m.content && t === stripped)) {
        hit = k
        break
      }
    }
    if (hit < 0) continue
    const ue = userEvents[hit]!
    cursor = hit + 1
    anchors.set(i, { seq: ue.seq, text: ue.text, ts: ue.ts })
  }
  return anchors
}

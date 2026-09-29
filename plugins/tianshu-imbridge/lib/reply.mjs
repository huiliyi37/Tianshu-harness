/**
 * QQ 回复分片与发送规划。
 *
 * 依据（2026-09-24，dsh-im markdown-reply.mjs + QQ 平台约束）：
 * - 单条消息上限：4500 字符（保守取 dsh-im 的 DEFAULT_CHUNK_LIMIT）
 * - 被动回复条数上限：c2c 4 条 / group 5 条（同一入站 msg_id 关联的回复数）
 * - 超出被动上限时主动截断并附提示（确定性行为优于平台报错）
 */
export const CHUNK_LIMIT = 4500
export const PASSIVE_LIMIT = Object.freeze({ c2c: 4, group: 5 })
export const TRUNCATED_NOTICE = '（内容较长，QQ 单次发送有限，剩余部分已截断。）'

/** 在 limit 处的安全切分点：避免把代理对（emoji 等）劈成两半。 */
function safeSliceIndex(text, limit) {
  let index = Math.min(limit, text.length)
  if (index <= 0) return 1
  const before = text.charCodeAt(index - 1)
  const after = text.charCodeAt(index)
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
    index -= 1
  }
  return Math.max(1, index)
}

/** 按长度切分文本：换行边界优先，超长行硬切，代理对安全。无损（join 可还原）。 */
export function splitText(text, limit = CHUNK_LIMIT) {
  const value = typeof text === 'string' ? text : ''
  if (value.length === 0) return []
  const bound = Number.isInteger(limit) && limit > 0 ? limit : CHUNK_LIMIT
  if (value.length <= bound) return [value]
  const parts = []
  let remaining = value
  while (remaining.length > bound) {
    let index = safeSliceIndex(remaining, bound)
    const newline = remaining.lastIndexOf('\n', index - 1)
    if (newline >= 0) index = newline + 1
    parts.push(remaining.slice(0, index))
    remaining = remaining.slice(index)
  }
  if (remaining) parts.push(remaining)
  return parts
}

/**
 * 规划一条回复的发送方案。
 * @returns {{ chunks: string[], truncated: boolean }}
 *  - chunks 数量不超过 scope 的被动回复上限；
 *  - 需要截断时，最后一条为 TRUNCATED_NOTICE。
 */
export function planReply(text, { scope = 'c2c', limit = CHUNK_LIMIT, passiveLimit } = {}) {
  const max = Number.isInteger(passiveLimit)
    ? passiveLimit
    : (PASSIVE_LIMIT[scope] ?? PASSIVE_LIMIT.c2c)
  const pieces = splitText(text, limit)
  if (pieces.length === 0) return { chunks: [], truncated: false }
  if (pieces.length <= max) return { chunks: pieces, truncated: false }
  return {
    chunks: [...pieces.slice(0, Math.max(0, max - 1)), TRUNCATED_NOTICE],
    truncated: true,
  }
}

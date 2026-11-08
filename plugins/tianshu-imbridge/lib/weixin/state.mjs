/**
 * 微信通道状态存储：游标、去重集、凭据失效暂停、会话上下文令牌。
 *
 * 为什么单独立一个模块而不是全塞进连接层：
 * - 「重启后从哪儿继续」是可单测的确定性逻辑；混进长轮询里就没法在测试里钉住。
 * - 落盘形状是运维事实（主人出问题时只看这个文件就能明白卡在哪），值得有自己的契约。
 *
 * 三个文件的取舍（都是 imbridge 目录下，与 QQ 侧的命名习惯并列）：
 * - weixin-state.json  —— 游标 / 已见 id / 暂停截止时间：连接层的运行态
 * - weixin-tokens.json —— senderId → 最近 context_token：回信凭据，与运行态分开
 *   （凭据类文件不该和运行态混在一个文件里，便于单独排查与单独清理）
 *
 * 落盘失败一律不抛（静默降级为内存态）：插件不可因为「写不进一个状态文件」就拒绝收发消息。
 */
import { readFileSync, writeFileSync } from 'node:fs'

/** 已见消息 id 的保留上限（超出淘汰最旧）。165 条是 DSH 侧的真实量级，留足余量。 */
export const MAX_SEEN_IDS = 500
/** 会话令牌保留上限（按最近更新淘汰）。 */
export const MAX_CONTEXT_TOKENS = 200

function readJsonFile(file) {
  if (!file) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null   // 文件不存在、坏 JSON、形状不对 → 一律退回空状态
  }
}

function writeJsonFile(file, value) {
  if (!file) return
  try {
    writeFileSync(file, JSON.stringify(value, null, 2))
  } catch {
    // 静默：状态落盘失败不该影响收发
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

/**
 * @param {{file?: string|null, tokenFile?: string|null, maxSeenIds?: number, maxContextTokens?: number}} options
 */
export function makeWeixinStateStore({ file = null, tokenFile = null, maxSeenIds = MAX_SEEN_IDS, maxContextTokens = MAX_CONTEXT_TOKENS } = {}) {
  const seenLimit = Number.isInteger(maxSeenIds) && maxSeenIds > 0 ? maxSeenIds : MAX_SEEN_IDS
  const tokenLimit = Number.isInteger(maxContextTokens) && maxContextTokens > 0 ? maxContextTokens : MAX_CONTEXT_TOKENS

  const persisted = readJsonFile(file) ?? {}
  let cursor = nonEmptyString(persisted.cursor) || ''
  let pausedUntil = Number.isFinite(persisted.pausedUntil) ? persisted.pausedUntil : 0
  // 已见 id：保持插入顺序（数组），淘汰时从头切
  let seenIds = Array.isArray(persisted.seenMessageIds)
    ? persisted.seenMessageIds.filter((id) => typeof id === 'string' && id).slice(-seenLimit)
    : []
  const seenSet = new Set(seenIds)

  const tokenPersisted = readJsonFile(tokenFile) ?? {}
  // Map 保留插入顺序，重新赋值不会前移顺序 → 淘汰时按 updatedAt 排序取最近
  const contexts = new Map()
  const rawContexts = tokenPersisted.users && typeof tokenPersisted.users === 'object' ? tokenPersisted.users : {}
  for (const [userId, entry] of Object.entries(rawContexts)) {
    const token = nonEmptyString(entry?.token)
    if (!userId || !token) continue
    contexts.set(userId, { token, updatedAt: Number.isFinite(entry?.updatedAt) ? entry.updatedAt : 0 })
  }

  function flushState() {
    writeJsonFile(file, { version: 1, cursor, seenMessageIds: seenIds, pausedUntil })
  }

  function flushTokens() {
    writeJsonFile(tokenFile, {
      version: 1,
      users: Object.fromEntries([...contexts].map(([userId, entry]) => [userId, entry])),
    })
  }

  return {
    getCursor() {
      return cursor
    },
    /** 只在拿到非空游标时前进（空串 = 服务端没给新游标，保持不动）。 */
    setCursor(value) {
      const next = nonEmptyString(value)
      if (!next || next === cursor) return
      cursor = next
      flushState()
    },
    hasSeen(messageId) {
      const id = nonEmptyString(messageId)
      return id ? seenSet.has(id) : false
    },
    markSeen(messageId) {
      const id = nonEmptyString(messageId)
      if (!id || seenSet.has(id)) return
      seenSet.add(id)
      seenIds.push(id)
      if (seenIds.length > seenLimit) {
        for (const dropped of seenIds.slice(0, seenIds.length - seenLimit)) seenSet.delete(dropped)
        seenIds = seenIds.slice(-seenLimit)
      }
      flushState()
    },
    /** 凭据失效后的静默窗口（毫秒剩余）；0 = 未暂停。 */
    remainingPauseMs() {
      if (!Number.isFinite(pausedUntil) || pausedUntil <= 0) return 0
      return Math.max(0, pausedUntil - Date.now())
    },
    pauseFor(ms) {
      const duration = Number.isFinite(ms) && ms > 0 ? ms : 0
      if (!duration) return
      pausedUntil = Date.now() + duration
      flushState()
    },
    clearPause() {
      pausedUntil = 0
      flushState()
    },
    getContextToken(senderId) {
      const id = nonEmptyString(senderId)
      return id ? (contexts.get(id)?.token ?? null) : null
    },
    setContextToken(senderId, token) {
      const id = nonEmptyString(senderId)
      const value = nonEmptyString(token)
      if (!id || !value) return
      contexts.set(id, { token: value, updatedAt: Date.now() })
      if (contexts.size > tokenLimit) {
        const ordered = [...contexts.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)
        for (const [dropped] of ordered.slice(0, contexts.size - tokenLimit)) contexts.delete(dropped)
      }
      flushTokens()
    },
    stats() {
      return { seenCount: seenIds.length, cursorLength: cursor.length, contextCount: contexts.size }
    },
  }
}

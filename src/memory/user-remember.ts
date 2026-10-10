/**
 * /remember 用户显式记忆（对齐 dsh command-memory 的 /remember 语义）。
 *
 * 与模型侧 memory 工具 remember 的分工：那是模型自判 claim（project 作用域
 * 过 essence-gate 准入闸）；本模块是**用户本人**一句话直写 LTM——用户显式
 * 输入即信任源，不过闸门（同 dsh /remember source='user' 直写），但保留
 * 阶段5 scrub 纪律（用户粘贴密钥也必须被拦）与统一 schema（source='manual'）。
 */

import {
  appendMemoryEntry, countSimilarMemoryEntries, isCurrentEntry,
  readMemoryEntries, type MemoryEntry,
} from './unified-memory.js'
import { containsSensitive, scrubMemoryText } from './memory-scrub.js'

export interface UserRememberResult {
  ok: boolean
  message: string
  entryId?: string
}

/** 写入一条用户显式记忆。敏感拦截与重复检查都在写前完成。 */
export function rememberUserNote(cwd: string, text: string, sessionId?: string): UserRememberResult {
  const trimmed = text.trim().slice(0, 500)
  if (trimmed.length < 3) return { ok: false, message: '内容太短（至少 3 个字符）——用法：/remember <要记住的事>' }
  // 用户显式输入含敏感片段（key/token/密码）→ 整条拒绝：打码后的「我的密钥是 ***」
  // 对记忆无信息量，静默写入反而制造污染（比巩固摘要的打码保留更严一档）。
  if (containsSensitive(trimmed)) {
    return { ok: false, message: '内容疑似包含 API key / token / 密码——不会写入记忆（删除敏感片段后重试）。' }
  }
  const scrubbed = scrubMemoryText(trimmed)
  if (!scrubbed) {
    return { ok: false, message: '内容被敏感信息过滤器拦截——不会写入记忆。' }
  }
  if (countSimilarMemoryEntries(cwd, scrubbed) > 0) {
    return { ok: false, message: '已有相同内容的记忆，未重复写入。' }
  }
  const entry = appendMemoryEntry(cwd, {
    text: scrubbed,
    kind: 'fact',
    confidence: 0.9,
    source: 'manual',
    status: 'verified',
    tags: ['user', 'remember'],
    sessionId,
    topic: 'user',
  })
  // 上游已过 containsSensitive + scrubMemoryText，此处 null 理论不可达（内层 scrub 幂等）；
  // 仍 fail-closed 防御，避免解引用空值。
  if (!entry) {
    return { ok: false, message: '内容被敏感信息过滤器拦截——不会写入记忆。' }
  }
  return { ok: true, message: `已记住（${entry.id}）：${scrubbed}`, entryId: entry.id }
}

/** 最近用户记忆（source='manual'，当前有效，ts 降序）——/remember 无参时展示。 */
export function listUserNotes(cwd: string, limit = 5): MemoryEntry[] {
  return readMemoryEntries(cwd)
    .filter(e => e.source === 'manual')
    .filter(isCurrentEntry)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit)
}

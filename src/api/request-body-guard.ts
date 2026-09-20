/**
 * 请求体体积护栏（4MB）——`MAX_JSON_BODY_BYTES` 的执行点。
 *
 * 背景：provider 网关对请求体有自己的上限（DeepSeek 等约 4MB）。超限时**服务端
 * 按字节截断**，如果这一刀正好切进一个 `\uXXXX` 转义，用户看到的就是：
 *
 *   OpenAI API error (HTTP 400): Failed to parse the request body as JSON:
 *   messages[1095].content unexpected end of hex escape at line 1 column …
 *
 * 那是一条指向「模型侧什么都没发生」的死路：网关没进模型、用户不知道要做什么。
 * 常量 `MAX_JSON_BODY_BYTES` 早就写在 utils/sanitize.ts 里，但一直没有消费方；
 * 本模块把它接上。
 *
 * 策略（确定性、只动历史、绝不 in-place 改入参）：
 *   ① 量体：JSON.stringify 后的 UTF-8 字节数
 *   ② 超限：从**最大的历史 tool 结果**开始截断（保头 + 保尾 + 显式标注），
 *      最近 `keepRecentMessages` 条消息一律不动——当前任务的上下文不许被削
 *   ③ 截完仍超限：抛 RequestBodyTooLargeError，附「谁最大」的清单。用户拿到的是
 *      可行动的中文（压缩 / 新会话 / 查中转），不是网关的英文 serde 报错
 *
 * 为什么必须确定性：同一份 messages 每次要截出**逐字节相同**的体，否则每轮都碎
 * 前缀缓存。所以截断只依赖内容本身——无时间戳、无随机、无 Map 迭代序。
 *
 * 为什么只动 tool 结果：它是同一个会话里唯一「体积大且可再取回」的内容（原始
 * 输出在会话记录/artifact 里）。user/assistant 文本是任务的语义骨架，削它等于
 * 篡改用户说过的话。
 */

import { MAX_JSON_BODY_BYTES } from '../utils/sanitize.js'

/** 最近 N 条消息不参与截断（当前任务的活动上下文）。 */
export const GUARD_KEEP_RECENT_MESSAGES = 6
/** 小于这个体积的 tool 结果不值得动（截了也省不出多少，徒增缓存扰动）。 */
export const GUARD_MIN_TRUNCATABLE_BYTES = 8 * 1024
/** 截断后保留的头/尾字符数。 */
export const GUARD_HEAD_CHARS = 2000
export const GUARD_TAIL_CHARS = 1000

export interface BodyGuardOptions {
  limitBytes?: number
  /** 超过这个字节数即回报“逼近上限”（默认 = 上限的一半）。 */
  warnBytes?: number
  keepRecentMessages?: number
  minTruncatableBytes?: number
  headChars?: number
  tailChars?: number
}

/** 逼近上限的默认阈值比例：4MB 上限 → 2MB 起提醒。 */
export const GUARD_NEAR_LIMIT_RATIO = 0.5

/**
 * 发给上层（进而发给用户的）体积事件。两种形态：
 * - `degraded`：这一轮的 wire 体已被截断（历史工具输出被削），模型看到的历史不完整；
 * - `near-limit`：还没截，但已逼近上限——**第三方中转常有更小的 body 上限**，
 *   提醒用户先压缩，别等到 400。
 */
export interface BodyGuardNotice {
  kind: 'degraded' | 'near-limit'
  bytes: number
  limitBytes: number
  degradedCount?: number
  removedBytes?: number
}

/** 通知文案（TUI 状态行 / 桌面相位标签共用，纯函数可测）。 */
export function formatBodyGuardNotice(info: BodyGuardNotice): string {
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`
  if (info.kind === 'degraded') {
    return (
      `⚠ 对话体量超传输上限：本轮已截断 ${info.degradedCount ?? 0} 条历史工具输出` +
      `（约 ${((info.removedBytes ?? 0) / 1024).toFixed(0)}KB，现 ${mb(info.bytes)}/${mb(info.limitBytes)}）——` +
      '模型看不到被截断的原文，建议 /compact 或新开会话'
    )
  }
  return (
    `⚠ 对话体量已接近传输上限（${mb(info.bytes)}/${mb(info.limitBytes)}）：` +
    '部分第三方中转的上限更低，建议尽早 /compact 或新开会话'
  )
}

export interface BodyDegrade {
  messageIndex: number
  /** 该条被削掉的字节数（按 UTF-8 计）。 */
  removedBytes: number
}

export interface BodyGuardOutcome {
  /** 可能被截断的**新**体（入参未被修改；未截断时返回原引用）。 */
  body: Record<string, unknown>
  bytes: number
  limitBytes: number
  degraded: BodyDegrade[]
  /** 未降级但已逼近上限时给出（降级时不再重复报这条——降级是更强的信号）。 */
  nearLimit?: { bytes: number; limitBytes: number }
}

/** 超限且已无更多可截断内容——附最大来源清单，供错误文案直接点名。 */
export class RequestBodyTooLargeError extends Error {
  readonly bytes: number
  readonly limitBytes: number
  readonly contributors: { messageIndex: number; role: string; bytes: number }[]

  constructor(bytes: number, limitBytes: number, contributors: { messageIndex: number; role: string; bytes: number }[]) {
    const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`
    const top = contributors
      .slice(0, 5)
      .map((c) => `messages[${c.messageIndex}] ${c.role} ${mb(c.bytes)}`)
      .join('、')
    super(
      `请求体 ${mb(bytes)} 超出传输上限 ${mb(limitBytes)}，已截断历史工具输出仍超限。` +
      `最大来源：${top || '（无法定位）'}。` +
      '处理：用 /compact 压缩本会话，或新开会话继续；若 baseUrl 走第三方中转，中转常有更小的 body 限制。',
    )
    this.name = 'RequestBodyTooLargeError'
    this.bytes = bytes
    this.limitBytes = limitBytes
    this.contributors = contributors
  }
}

/** wire 体字节数（与 fetch 发出的字节一致：JSON.stringify + UTF-8）。 */
export function measureBodyBytes(body: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(body) ?? '')
  } catch {
    // 循环引用等异常体不该让护栏本身成为故障点：量不出来就当 0，
    // 让下游 fetch 的 stringify 去抛真正的原因。
    return 0
  }
}

function truncateToolContent(content: string, head: number, tail: number): string {
  const headPart = content.slice(0, head)
  const tailPart = tail > 0 ? content.slice(Math.max(head, content.length - tail)) : ''
  // 标注里的「省略约 NKB」必须按**实际削掉**的字节算（原文 − 保留的头尾），
  // 不能拿原文总字节冒充——8KB 门槛附近的小体上两者差出一个数量级。
  const removedBytes =
    Buffer.byteLength(content) - Buffer.byteLength(headPart) - Buffer.byteLength(tailPart)
  const marker =
    `\n…[已省略约 ${(Math.max(0, removedBytes) / 1024).toFixed(0)}KB：请求体超出传输上限，完整输出仍在会话记录/artifact 里。` +
    '如需完整内容请重新读取该文件或命令]…\n'
  return `${headPart}${marker}${tailPart}`
}

/** 体积清单（错误文案 + 日志用）：按内容字节降序，同体积按下标升序（稳定）。 */
function topContributors(
  messages: unknown[],
  count = 5,
): { messageIndex: number; role: string; bytes: number }[] {
  const rows: { messageIndex: number; role: string; bytes: number }[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as { role?: unknown; content?: unknown; tool_calls?: unknown } | undefined
    if (!m) continue
    let bytes = 0
    if (typeof m.content === 'string') bytes += Buffer.byteLength(m.content)
    if (Array.isArray(m.tool_calls)) bytes += Buffer.byteLength(JSON.stringify(m.tool_calls) ?? '')
    if (bytes > 0) rows.push({ messageIndex: i, role: String(m.role ?? '?'), bytes })
  }
  return rows.sort((a, b) => b.bytes - a.bytes || a.messageIndex - b.messageIndex).slice(0, count)
}

/**
 * 量体 + 必要时降级。返回的 body 可直接 JSON.stringify 发出。
 * 未超限时返回**原引用**（零拷贝、字节不变，前缀缓存不受影响）。
 */
export function enforceRequestBodyLimit(
  body: Record<string, unknown>,
  opts: BodyGuardOptions = {},
): BodyGuardOutcome {
  const limitBytes = opts.limitBytes ?? MAX_JSON_BODY_BYTES
  const keepRecent = opts.keepRecentMessages ?? GUARD_KEEP_RECENT_MESSAGES
  const minTruncatable = opts.minTruncatableBytes ?? GUARD_MIN_TRUNCATABLE_BYTES
  const headChars = opts.headChars ?? GUARD_HEAD_CHARS
  const tailChars = opts.tailChars ?? GUARD_TAIL_CHARS

  const warnBytes = opts.warnBytes ?? Math.floor(limitBytes * GUARD_NEAR_LIMIT_RATIO)
  const original = measureBodyBytes(body)
  if (original <= limitBytes) {
    return {
      body,
      bytes: original,
      limitBytes,
      degraded: [],
      ...(original >= warnBytes ? { nearLimit: { bytes: original, limitBytes } } : {}),
    }
  }

  const rawMessages = body.messages
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw new RequestBodyTooLargeError(original, limitBytes, topContributors([]))
  }

  const messages = [...rawMessages] as unknown[]
  const lastMutable = Math.max(0, messages.length - keepRecent)
  const candidates: { index: number; bytes: number }[] = []
  for (let i = 0; i < lastMutable; i++) {
    const m = messages[i] as { role?: unknown; content?: unknown } | undefined
    if (!m || m.role !== 'tool' || typeof m.content !== 'string') continue
    const bytes = Buffer.byteLength(m.content)
    if (bytes < minTruncatable) continue
    candidates.push({ index: i, bytes })
  }
  // 最大的先削：同样削 1MB，「削 3 条各 300KB」比「削 20 条各 50KB」保留的信息多。
  candidates.sort((a, b) => b.bytes - a.bytes || a.index - b.index)

  const degraded: BodyDegrade[] = []
  let estimated = original
  for (const c of candidates) {
    if (estimated <= limitBytes) break
    const msg = messages[c.index] as { content: string }
    const truncated = truncateToolContent(msg.content, headChars, tailChars)
    const removed = c.bytes - Buffer.byteLength(truncated)
    if (removed <= 0) continue
    messages[c.index] = { ...(messages[c.index] as Record<string, unknown>), content: truncated }
    estimated -= removed
    degraded.push({ messageIndex: c.index, removedBytes: removed })
  }

  const nextBody = degraded.length > 0 ? { ...body, messages } : body
  // 估算只用于挑选顺序；最终以实测为准（不信任何算术）。
  const bytes = measureBodyBytes(nextBody)
  if (bytes > limitBytes) {
    throw new RequestBodyTooLargeError(bytes, limitBytes, topContributors(messages))
  }
  return { body: nextBody, bytes, limitBytes, degraded }
}

/** 降级日志用的一行摘要（无降级返回空串）。 */
export function formatDegradeNotice(degraded: BodyDegrade[]): string {
  if (degraded.length === 0) return ''
  const totalKb = degraded.reduce((n, d) => n + d.removedBytes, 0) / 1024
  return `请求体超限降级：截断 ${degraded.length} 条历史工具输出（共 ${totalKb.toFixed(0)}KB）`
}

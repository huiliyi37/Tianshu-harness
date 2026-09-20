import type { OaiMessage } from '../api/oai-types.js'
import { KEEP_RECENT_MESSAGES, CACHE_ANCHOR_MESSAGES, compactThresholds } from './constants.js'
import { groupIntoRoundsOai } from '../context/rounds.js'
import { estimateImageTokens } from '../context/image-tokens.js'
import { collapseToolResult } from './context-collapse.js'
import { ARTIFACT_MARKER_REGEX } from './recovery-ref.js'

/**
 * Compact a tool message: first try semantic Context Collapse (for old messages),
 * then fall back to truncation.
 *
 * BUG FIX: The original previewChars formula `toolResultMaxTokens * CHARS_PER_TOKEN`
 * produced 240K chars for a 200K window (60K tokens × 4), making truncation
 * never trigger. Fixed to use `toolResultMaxTokens` directly as the char limit.
 */
function compactToolMessage(
  msg: OaiMessage,
  contextWindow: number,
  turnAge?: number,
  /** W1-A3: artifactId archived for this message at the compact boundary (pure data). */
  recoveryRefId?: string,
  /** True when a boundary archive pass ran (fail-open semantics apply). */
  archiveRan?: boolean,
): { msg: OaiMessage; changed: boolean } {
  if (msg.role !== 'tool') return { msg, changed: false }

  const toolName = msg.tool_call_id ? extractToolNameFromId(msg.tool_call_id) : undefined

  if (turnAge != null && turnAge >= 4 && toolName) {
    const collapsed = collapseToolResult(toolName, msg.content, turnAge, contextWindow)
    if (collapsed) {
      // Boundary-archived original: keep the recovery pointer on the summary
      // (collapseToolResult itself only preserves markers already in content).
      const summary = recoveryRefId && !collapsed.summary.includes(`[artifact:${recoveryRefId}]`)
        ? `${collapsed.summary}\n[artifact:${recoveryRefId}]`
        : collapsed.summary
      return { msg: { ...msg, content: summary }, changed: true }
    }
  }

  const previewChars = Math.max(1_200, compactThresholds(contextWindow).toolResultMaxTokens)
  if (msg.content.length <= previewChars) return { msg, changed: false }
  const markerMatch = msg.content.match(ARTIFACT_MARKER_REGEX)
  // Fail-open: when an archive pass ran but this marker-less message has no
  // ref (save failed), keep the original — never cut unrecoverable content.
  if (archiveRan && !markerMatch && !recoveryRefId) return { msg, changed: false }
  const marker = markerMatch
    ? markerMatch[0].trimEnd()
    : recoveryRefId ? `[artifact:${recoveryRefId}]` : undefined
  const tail = marker ? `\n${marker}` : ''
  const stub = `<microcompacted tool_result original_chars="${msg.content.length}">\n${msg.content.slice(0, previewChars)}\n</microcompacted tool_result>${tail}`
  if (stub.length >= msg.content.length) return { msg, changed: false }
  return { msg: { ...msg, content: stub }, changed: true }
}

function extractToolNameFromId(toolCallId: string): string | undefined {
  const m = toolCallId.match(/^([\w-]+)_/)
  return m?.[1]
}

function compactOaiReasoning(_msg: OaiMessage): { msg: OaiMessage; changed: boolean } {
  // reasoning_content is always passed back intact — truncation savings are
  // negligible once prefix cache kicks in, and incomplete reasoning degrades
  // model quality on providers that require it (MiMo, DeepSeek).
  return { msg: _msg, changed: false }
}

/**
 * issue #139: per-message estimates are a pure function of (role, content,
 * tool_calls, reasoning_content) — and buildOaiRequest re-estimates the whole
 * history every turn even though request prefixes are byte-stable by design.
 * Cache by object identity (pass-through messages keep refs across turns) and
 * by string content (rebuilt user/system wrappers share frozen string
 * instances). Assistant messages always go through the object path: their
 * estimate also folds in tool_calls + reasoning_content. The field refs on the
 * entry are an O(1) belt-and-suspenders guard — production code never mutates
 * messages in place, but a stale estimate after an in-place mutation would
 * skew compaction/T7 gate decisions, so a ref mismatch recomputes.
 */
interface EstimateCacheEntry {
  tokens: number
  content: unknown
  toolCalls: unknown
  /** toolCalls 为数组时的长度与首尾元素 ref——ref 相等不能证明内容未变。 */
  toolCallsLen: number
  toolCallsHead: unknown
  toolCallsTail: unknown
  reasoning: unknown
}

/**
 * 数组原地修改的廉价守卫：长度 + 首尾元素 ref（O(1)）。捕获 push/pop/splice/
 * 首尾替换；等长且中间元素被替换的极端情形不被捕获——深比较会抵消缓存收益。
 * （与 prompt/message-signature.ts 同形，两侧不互相 import：prompt → compact
 * 已存在依赖，反向 import 会成环。）
 */
function arrayUnchanged(arr: unknown, len: number, head: unknown, tail: unknown): boolean {
  if (!Array.isArray(arr)) return true
  return arr.length === len && arr[0] === head && arr[arr.length - 1] === tail
}

const estimateByObject = new WeakMap<OaiMessage, EstimateCacheEntry>()
const estimateByContent = new Map<string, number>()
const ESTIMATE_CONTENT_CACHE_CAP = 2048

/** Test observability: full per-char scans actually performed (issue #139). */
export const estimateCacheStats = { computations: 0 }

export function estimateOaiMessageTokens(msg: OaiMessage): number {
  // OaiMessage is a role-discriminated union; the cache guards read the
  // optional fields through a Record view (mirrors message-signature.ts).
  const rec = msg as unknown as Record<string, unknown>
  const hit = estimateByObject.get(msg)
  if (
    hit && hit.content === rec.content && hit.toolCalls === rec.tool_calls
    && arrayUnchanged(hit.toolCalls, hit.toolCallsLen, hit.toolCallsHead, hit.toolCallsTail)
    && hit.reasoning === rec.reasoning_content
  ) {
    return hit.tokens
  }
  if (msg.role !== 'assistant' && typeof msg.content === 'string') {
    const byContent = estimateByContent.get(msg.content)
    if (byContent !== undefined) return byContent
  }
  const tokens = estimateOaiMessageTokensUncached(msg)
  estimateCacheStats.computations++
  const tc = rec.tool_calls
  estimateByObject.set(msg, {
    tokens,
    content: rec.content,
    toolCalls: tc,
    toolCallsLen: Array.isArray(tc) ? tc.length : 0,
    toolCallsHead: Array.isArray(tc) ? tc[0] : undefined,
    toolCallsTail: Array.isArray(tc) ? tc[tc.length - 1] : undefined,
    reasoning: rec.reasoning_content,
  })
  if (msg.role !== 'assistant' && typeof msg.content === 'string') {
    if (estimateByContent.size >= ESTIMATE_CONTENT_CACHE_CAP) estimateByContent.clear()
    estimateByContent.set(msg.content, tokens)
  }
  return tokens
}

function estimateOaiMessageTokensUncached(msg: OaiMessage): number {
  let content: string
  if (msg.role === 'assistant') {
    // Count content + tool_calls + reasoning together. The old exclusive
    // branches skipped reasoning_content whenever tool_calls were present —
    // but tool-call turns are exactly the ones that retain reasoning for
    // DeepSeek echo, so estimates undercounted the dominant token sink and
    // compaction fired systematically late in tool-dense sessions.
    content = (msg.content ?? '')
      + (msg.tool_calls ? JSON.stringify(msg.tool_calls) : '')
      + (msg.reasoning_content ?? '')
  } else if (msg.role === 'user' && Array.isArray(msg.content)) {
    // Multimodal user message (vision): text parts + per-image tile cost.
    // 按真实尺寸分块（image-tokens.ts），不按张数——一张 1280×800 视口图是 1105
    // token，整页长图到 1785，旧的"每张 765"只对 1024 方图成立。base64 载荷本身
    // 不计入文本 token：供应商单独编码它。
    let textLen = 0
    let imageTokens = 0
    for (const part of msg.content) {
      if (part.type === 'text') textLen += part.text.length
      else imageTokens += estimateImageTokens(part.image_url.url)
    }
    return Math.ceil(textLen / 4) + imageTokens
  } else {
    content = msg.content as string
  }

  let asciiChars = 0
  let cjkChars = 0
  for (const ch of content) {
    const code = ch.codePointAt(0) ?? 0
    if (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0x20000 && code <= 0x2A6DF) ||
      (code >= 0x3040 && code <= 0x309F) ||
      (code >= 0x30A0 && code <= 0x30FF) ||
      (code >= 0xAC00 && code <= 0xD7AF)
    ) {
      cjkChars++
    } else {
      asciiChars++
    }
  }
  return Math.ceil(asciiChars / 4) + Math.ceil(cjkChars / 1.2)
}

export function estimateOaiTokens(messages: OaiMessage[]): number {
  let total = 0
  for (const msg of messages) {
    total += estimateOaiMessageTokens(msg)
  }
  return total
}

export function microCompactOai(
  messages: OaiMessage[],
  contextWindow: number,
  estimatedTokens: number,
  /** W1-A3: boundary-archived `message index → artifactId` (pure data; see
   *  boundary-archive.ts). Absent for legacy callers — behavior unchanged. */
  recoveryRefs?: ReadonlyMap<number, string>,
): { messages: OaiMessage[]; truncated: number } {
  const recentStart = Math.max(0, messages.length - KEEP_RECENT_MESSAGES)

  const turnAgeMap = computeTurnAges(messages)

  let compactedCount = 0
  const shortened = messages.map((msg, msgIdx) => {
    const isRecent = msgIdx >= recentStart
    const turnAge = turnAgeMap.get(msgIdx) ?? 0

    const toolResult = compactToolMessage(msg, contextWindow, turnAge, recoveryRefs?.get(msgIdx), recoveryRefs !== undefined)
    if (toolResult.changed) { compactedCount++; return toolResult.msg }

    if (!isRecent && msgIdx >= CACHE_ANCHOR_MESSAGES) {
      const reasonResult = compactOaiReasoning(msg)
      if (reasonResult.changed) { compactedCount++; return reasonResult.msg }
    }

    return msg
  })

  let currentTokens = compactedCount > 0 ? estimateOaiTokens(shortened) : estimatedTokens

  if (currentTokens <= contextWindow || messages.length <= KEEP_RECENT_MESSAGES + CACHE_ANCHOR_MESSAGES) {
    return { messages: shortened, truncated: compactedCount }
  }

  const anchorEnd = CACHE_ANCHOR_MESSAGES
  const tier2RecentStart = Math.max(0, shortened.length - KEEP_RECENT_MESSAGES)
  const rounds = groupIntoRoundsOai(shortened)
  const removeIndexes = new Set<number>()

  for (const round of rounds) {
    if (round.startMessageIndex >= anchorEnd && round.endMessageIndex <= tier2RecentStart && round.apiInvariant === 'ok') {
      const roundTokens = round.tokenEstimate
      if (currentTokens - roundTokens <= contextWindow * 0.7) continue
      for (let idx = round.startMessageIndex; idx < round.endMessageIndex; idx += 1) {
        removeIndexes.add(idx)
      }
      currentTokens -= roundTokens
      compactedCount += round.endMessageIndex - round.startMessageIndex
      if (currentTokens <= contextWindow) break
    }
  }

  if (removeIndexes.size > 0) {
    const result = shortened.filter((_, idx) => !removeIndexes.has(idx))
    return { messages: result, truncated: compactedCount }
  }

  return { messages: shortened, truncated: compactedCount }
}

/**
 * Compute the "turn age" of each message — how many user turns ago
 * it was created. Current turn = 0, previous turn = 1, etc.
 */
function computeTurnAges(messages: OaiMessage[]): Map<number, number> {
  const ages = new Map<number, number>()
  let currentTurn = 0
  const turnBoundaries: number[] = []

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') {
      turnBoundaries.push(i)
      currentTurn++
    }
  }

  let turn = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') turn++
    ages.set(i, turn)
  }

  return ages
}

/**
 * 深召回（对齐 dsh memory_deep_recall 的蒸馏契约）：跨**历史会话转录**做
 * 关键词检索，把命中的原文片段交给一次侧路 LLM 蒸馏成「答案 + 证据引用」——
 * 原文绝不整段进主上下文（这正是普通 recall 做不到的：memory.jsonl 里只有
 * 巩固后的摘要，问答需要的细节在会话原文里）。
 *
 * dsh 用一次性 reader 子代理实现隔离；天枢侧路 LLM 通道（同 essence-gate /
 * 巩固 hook）已具备同等契约——有界、独立请求、fail-closed——不另起子进程。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readHistoricalTranscript } from '../agent/session-persist.js'
import { tokenizeRecallQuery } from './query-terms.js'

export interface DeepRecallCandidate {
  sessionId: string
  /** 命中词周围的原文窗口（截断引用）。 */
  quote: string
  score: number
}

export interface DeepRecallEvidence {
  sessionId: string
  quote: string
}

export interface DeepRecallResult {
  answer: string
  evidence: DeepRecallEvidence[]
  uncertainties: string[]
  confidence: number
}

export interface CollectCandidatesOptions {
  maxSessions?: number
  maxCandidates?: number
  maxTotalChars?: number
  readTranscript?: (path: string) => Array<{ role: string; content: string }>
}

const QUOTE_CONTEXT_CHARS = 160

/** 跨会话扫描候选片段：query 词项计分，全局取前 N，总字符封顶。 */
export function collectTranscriptCandidates(
  sessionDir: string,
  query: string,
  options: CollectCandidatesOptions = {},
): DeepRecallCandidate[] {
  const terms = tokenizeRecallQuery(query)
  if (terms.length === 0 || !existsSync(sessionDir)) return []
  const maxSessions = options.maxSessions ?? 20
  const maxCandidates = options.maxCandidates ?? 8
  const maxTotalChars = options.maxTotalChars ?? 6_000
  const read = options.readTranscript ?? readHistoricalTranscript

  const files: Array<{ sessionId: string; path: string; mtimeMs: number }> = []
  for (const name of readdirSync(sessionDir)) {
    if (!name.endsWith('.jsonl') || name === 'cache-log.jsonl') continue
    const path = join(sessionDir, name)
    try { files.push({ sessionId: name.slice(0, -6), path, mtimeMs: statSync(path).mtimeMs }) } catch { /* skip */ }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)

  const scored: DeepRecallCandidate[] = []
  for (const file of files.slice(0, maxSessions)) {
    for (const message of read(file.path)) {
      if (typeof message.content !== 'string' || !message.content) continue
      if (message.role !== 'user' && message.role !== 'assistant') continue
      const lower = message.content.toLowerCase()
      let score = 0
      let firstHit = -1
      for (const term of terms) {
        const at = lower.indexOf(term)
        if (at !== -1) {
          score++
          if (firstHit === -1) firstHit = at
        }
      }
      if (score === 0 || firstHit === -1) continue
      const start = Math.max(0, firstHit - QUOTE_CONTEXT_CHARS)
      const quote = message.content.slice(start, start + QUOTE_CONTEXT_CHARS * 2).replace(/\s+/g, ' ').trim()
      scored.push({ sessionId: file.sessionId, quote, score })
    }
  }

  scored.sort((a, b) => b.score - a.score)
  const selected: DeepRecallCandidate[] = []
  let totalChars = 0
  for (const candidate of scored) {
    if (selected.length >= maxCandidates || totalChars + candidate.quote.length > maxTotalChars) break
    selected.push(candidate)
    totalChars += candidate.quote.length
  }
  return selected
}

/** 蒸馏 prompt：把候选片段交给侧路模型，产出答案 + 逐字证据。 */
export function buildDeepRecallPrompt(query: string, candidates: readonly DeepRecallCandidate[]): string {
  const lines: string[] = []
  lines.push('你是编码智能体的记忆检索员。下面是跨历史会话检索到的原文片段。')
  lines.push(`用户问题：${query.slice(0, 300)}`)
  lines.push('')
  lines.push('请基于**只有**这些片段回答（不得编造片段里没有的内容）：')
  lines.push('- answer：直接回答，≤200 字；片段不足以回答就如实说查不到。')
  lines.push('- evidence：≤3 条，每条引用 sessionId + 片段中的**逐字**短句（≤80 字符）。')
  lines.push('- uncertainties：不确定的点（可为空数组）。')
  lines.push('- confidence：0-1 的数字。')
  lines.push('')
  lines.push('片段：')
  candidates.forEach((c, i) => {
    lines.push(`[${i + 1}] sessionId=${c.sessionId}（相关度 ${c.score}）`)
    lines.push(c.quote)
  })
  lines.push('')
  lines.push('只返回一个 JSON 对象（无 markdown 围栏）：')
  lines.push('{"answer":"...","evidence":[{"sessionId":"...","quote":"..."}],"uncertainties":[],"confidence":0.8}')
  return lines.join('\n')
}

/** 解析蒸馏输出。结构性意外返回 null（fail-closed，绝不部分采信）。 */
export function parseDeepRecallOutput(raw: string): DeepRecallResult | null {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced?.[1]?.trim() ?? trimmed
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  let parsed: unknown
  try { parsed = JSON.parse(body.slice(start, end + 1)) } catch { return null }
  if (typeof parsed !== 'object' || parsed === null) return null
  const p = parsed as Record<string, unknown>
  const answer = typeof p.answer === 'string' ? p.answer.trim() : ''
  if (!answer) return null
  const evidence: DeepRecallEvidence[] = []
  if (Array.isArray(p.evidence)) {
    for (const item of p.evidence.slice(0, 3)) {
      if (typeof item !== 'object' || item === null) continue
      const e = item as Record<string, unknown>
      if (typeof e.sessionId !== 'string' || typeof e.quote !== 'string') continue
      evidence.push({ sessionId: e.sessionId, quote: e.quote.slice(0, 240) })
    }
  }
  const uncertainties = Array.isArray(p.uncertainties)
    ? p.uncertainties.filter((u): u is string => typeof u === 'string').slice(0, 3)
    : []
  const confidence = typeof p.confidence === 'number' && p.confidence >= 0 && p.confidence <= 1
    ? p.confidence
    : 0.5
  return { answer, evidence, uncertainties, confidence }
}

/** 蒸馏结果的紧凑渲染（进主上下文的形态——这就是「原文不进上下文」的边界）。 */
export function renderDeepRecallText(result: DeepRecallResult): string {
  const lines = [`答案：${result.answer}`, `置信度：${result.confidence.toFixed(2)}`]
  if (result.evidence.length > 0) {
    lines.push('证据：')
    for (const e of result.evidence) lines.push(`  - [${e.sessionId}] ${e.quote}`)
  }
  if (result.uncertainties.length > 0) lines.push(`不确定：${result.uncertainties.join('；')}`)
  lines.push('（deep_recall 为蒸馏结果；需要原文细节可用 /resume 打开对应会话）')
  return lines.join('\n')
}

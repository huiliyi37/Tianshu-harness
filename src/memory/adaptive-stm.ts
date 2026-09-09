import { createHash } from 'node:crypto'
import { debugLog } from '../utils/debug.js'
import { getKnowledgeIndex, type KnowledgeHit } from './knowledge-index.js'
import { tokenizeRecallQuery } from './query-terms.js'

export type AdaptiveMemoryMode = 'off' | 'shadow' | 'on'
export type AdaptiveMemoryRefreshReason =
  | 'initial'
  | 'intent-change'
  | 'new-entity'
  | 'relevant-memory'
  /** 连续多轮未刷新 → 强制重评估（对齐 dsh pressure-turns：防长会话里记忆漂移失察）。 */
  | 'pressure-turns'

/** 距上次刷新超过该轮数 → pressure 重评估（dsh 缺省 8）。 */
const PRESSURE_TURNS = 8

interface AdaptiveMemoryState {
  intentKey: string
  entities: string[]
  signature: string
  block: string
  touchedAt: number
  /** 上次**刷新**（重渲染）所在轮——pressure 阀门基准；touchedAt 只是命中续用。 */
  refreshedAtTurn?: number
}

export interface AdaptiveMemoryReviewInput {
  cwd: string
  sessionId?: string
  turn: number
  intentText: string
  userInput: string
  mode?: AdaptiveMemoryMode
  index?: { search(query: string, options?: { limit?: number; excludeSessionIds?: readonly string[] }): Promise<KnowledgeHit[]> }
  /** 并行工作区隔离：排除这些会话写入的条目。 */
  excludeSessionIds?: readonly string[]
}

export interface AdaptiveMemoryReviewResult {
  block: string | null
  mode: AdaptiveMemoryMode
  reason?: AdaptiveMemoryRefreshReason
  selectedIds: string[]
}

const MAX_STATES = 256
const MAX_ENTRIES = 6
const MAX_BLOCK_CHARS = 1_400
const states = new Map<string, AdaptiveMemoryState>()

/**
 * 记忆模式解析。默认 `on`：新会话启动即注入长期记忆要点（用户需求——
 * “新会话的时候，他会有的记忆”）。`shadow` 只评估不注入（A/B 观察用），
 * `off` 完全关闭。
 */
export function adaptiveMemoryMode(value = process.env.RIVET_ADAPTIVE_MEMORY): AdaptiveMemoryMode {
  const normalized = value?.trim().toLowerCase()
  if (normalized === '0' || normalized === 'off' || normalized === 'false') return 'off'
  if (normalized === 'shadow') return 'shadow'
  return 'on'
}

function intentKey(text: string): string {
  const terms = tokenizeRecallQuery(text).slice(0, 6)
  if (terms.length > 0) return terms.join('|')
  return text.toLocaleLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80) || 'general'
}

function entities(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(/(?:[A-Za-z]:[\\/]|\.?\.?[\\/])?[\w.@+-]+(?:[\\/][\w.@+-]+)+/g)) {
    found.add(match[0]!)
  }
  for (const match of text.matchAll(/\bE[A-Z0-9_]{3,}\b/g)) found.add(match[0]!)
  return [...found].sort().slice(0, 24)
}

function hitSignature(hits: readonly KnowledgeHit[]): string {
  const hash = createHash('sha256')
  for (const hit of hits) {
    hash.update(hit.id)
    hash.update('\0')
    hash.update(hit.text)
    hash.update('\0')
    if (hit.entry) {
      hash.update(String(hit.entry.ts))
      hash.update('\0')
      hash.update(hit.entry.status)
      hash.update('\0')
      hash.update(hit.entry.supersededBy ?? '')
    }
    hash.update('\n')
  }
  return hash.digest('hex').slice(0, 16)
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function renderBlock(key: string, hits: readonly KnowledgeHit[]): string {
  if (hits.length === 0) return `<cross-session-memory source="adaptive" intent="${escapeXml(key)}" state="empty"/>`
  const lines = [
    `<cross-session-memory source="adaptive" intent="${escapeXml(key)}">`,
    '与当前任务相关的跨会话项目记忆；需要全文或更多证据时调用 memory recall：',
  ]
  let used = lines.join('\n').length + '</cross-session-memory>'.length
  for (const hit of hits) {
    const id = hit.entry?.id ?? hit.id
    const topic = hit.entry?.topic ?? (hit.playbook ? 'playbook' : hit.file ?? 'knowledge')
    const text = hit.text.replace(/\s+/g, ' ').trim().slice(0, 220)
    const line = `- [${escapeXml(id)}] ${escapeXml(topic)} | ${escapeXml(text)}`
    if (used + line.length + 1 > MAX_BLOCK_CHARS) break
    lines.push(line)
    used += line.length + 1
  }
  lines.push('</cross-session-memory>')
  return lines.join('\n')
}

function rememberState(key: string, state: AdaptiveMemoryState): void {
  states.delete(key)
  states.set(key, state)
  while (states.size > MAX_STATES) states.delete(states.keys().next().value!)
}

/**
 * Select a deterministic per-intent working set. Shadow mode performs the same
 * retrieval and gating but returns no model-visible block, allowing cache and
 * selection metrics to be observed before enabling injection.
 */
export async function reviewAdaptiveMemory(input: AdaptiveMemoryReviewInput): Promise<AdaptiveMemoryReviewResult> {
  const mode = input.mode ?? adaptiveMemoryMode()
  if (mode === 'off') return { block: null, mode, selectedIds: [] }

  const stateKey = `${input.cwd}\0${input.sessionId ?? 'standalone'}`
  const previous = states.get(stateKey)
  const key = intentKey(input.intentText)
  const nextEntities = entities(`${input.intentText}\n${input.userInput}`)
  const index = input.index ?? getKnowledgeIndex(input.cwd)
  const hits = (await index.search(input.intentText, { limit: MAX_ENTRIES * 2, excludeSessionIds: input.excludeSessionIds }))
    .slice(0, MAX_ENTRIES)
  const signature = hitSignature(hits)

  let reason: AdaptiveMemoryRefreshReason | undefined
  if (!previous) reason = 'initial'
  else if (previous.intentKey !== key) reason = 'intent-change'
  else if (nextEntities.some(entity => !previous.entities.includes(entity))) reason = 'new-entity'
  else if (previous.signature !== signature) reason = 'relevant-memory'
  else if (input.turn - (previous.refreshedAtTurn ?? previous.touchedAt) >= PRESSURE_TURNS) reason = 'pressure-turns'

  if (!reason && previous) {
    previous.touchedAt = input.turn
    return {
      block: mode === 'on' ? previous.block : null,
      mode,
      selectedIds: hits.map(hit => hit.entry?.id ?? hit.id),
    }
  }

  const block = renderBlock(key, hits)
  rememberState(stateKey, { intentKey: key, entities: nextEntities, signature, block, touchedAt: input.turn, refreshedAtTurn: input.turn })
  debugLog(`[adaptive-memory] mode=${mode} reason=${reason ?? 'none'} hits=${hits.length} intent=${key}`)
  return {
    block: mode === 'on' ? block : null,
    mode,
    reason,
    selectedIds: hits.map(hit => hit.entry?.id ?? hit.id),
  }
}

export function resetAdaptiveMemoryState(): void {
  states.clear()
}

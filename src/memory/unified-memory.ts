/**
 * Unified Memory — single JSONL log for cross-session observations, claims, and rules.
 *
 * Wave 2（知识重构·存储统一）：schema 采 Store B（本模块）的丰富字段，
 * **存储位置迁到项目内** `.rivet/knowledge/memory.jsonl`（原 Store A 位置）。
 * 理由：知识沉淀在开发者项目里——项目内路径随仓库走、可共享；旧的
 * `~/.rivet/memory/<cwd-hash>/` 按 cwd 哈希定位，目录移动/换机即知识孤儿化。
 *
 * Schema v2 增强（mempalace 时间窗 + cognition-mcp 可迁移性）：
 *   - validFrom/validTo：温度有效性窗口——知识失效用封口，不删除
 *   - supersededBy：被新条目取代的链式引用，召回只返回当前叶子
 *   - transferableTo：适用范围（salvage 准入形态，回答不了即不准入）
 *   - topic：作用域元数据（模块/主题，供召回预过滤）
 *
 * 旧机器目录（legacy Store B）保留为只读兼容层：读路径 dual-read 合并，
 * 迁移 B → A 幂等按 id（正则观察产物 source='auto' 默认不迁——那是噪声）。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { memoryDir } from '../config/paths.js'
import { appendKnowledgeJsonl, acquireLock } from '../context/project-memory-writer.js'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { tokenizeRecallQuery } from './query-terms.js'

// ── Schema ─────────────────────────────────────────────────────────────────

export type MemoryKind =
  | 'fact'
  | 'decision'
  | 'constraint'
  | 'preference'
  | 'finding'
  | 'user_constraint'
  | 'user_preference'
  | 'file_observation'
  | 'verification_fact'
  | 'failure_pattern'
  | 'security_finding'
  | 'worker_finding'
  | 'project_rule'
  // Dream curated criteria（Store A 既有 kind，统一后纳入联合类型）
  | 'convergence_insight'
  | 'architectural_invariant'
  | 'selection_rule'
  | 'conceptual_reframe'
  | 'reusable_design_pattern'
  // 虚空仓库 P0：agent 交付时主动标记的已验证模式
  | 'verified_pattern'

export type MemorySource = 'auto' | 'manual' | 'claim' | 'verification' | 'dream' | 'essence-gate'
  // 虚空仓库 P0：agent 主动标记（deliver_task learned 参数 / PAL 自动收割），区分被动提取
  | 'agent-crafted'
  // 记忆形成侧：重要操作后模型自主判断值得、截取摘要写入（auto-capture）
  | 'auto-capture'
  // 会话结束巩固：模型生成会话摘要 + 可复用做法（consolidation）
  | 'consolidation'
  // 历史会话回填：对存量会话转录补跑巩固提取器（backfill pipeline）
  | 'backfill'

export type MemoryStatus = 'observed' | 'claimed' | 'verified' | 'rejected' | 'expired'

export interface MemoryEntry {
  id: string
  text: string
  kind: MemoryKind
  confidence: number
  source: MemorySource
  status: MemoryStatus
  evidence?: string
  sessionId?: string
  tags: string[]
  ts: number
  /** Cross-session repeat count. */
  repeatCount: number
  /** Path to auto-generated rule file, if promoted (legacy — rule autogen 已停用). */
  promotedToRule?: string
  /** Extension: original claim ID if sourced from ClaimStore. */
  claimId?: string
  /** Extension: references to evidence files that still exist. */
  fileRefs?: string[]
  // ── Schema v2 (Wave 2) ──
  /** 生效时间（缺省 = ts）。 */
  validFrom?: number
  /** 失效时间。有值 = 已封口（被取代或过期），召回默认不返回。 */
  validTo?: number
  /** 被哪个条目取代（id 引用）。召回跟随链条找最新叶子。 */
  supersededBy?: string
  /** 适用范围（cognition-mcp salvage）——回答不了"可迁移到哪"的知识不配准入。 */
  transferableTo?: string[]
  /** 作用域元数据（模块/主题），召回结构化预过滤用。 */
  topic?: string
}

// ── Helpers ────────────────────────────────────────────────────────────────

function projectHash(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 12)
}

/** Legacy Store B 机器目录（只读兼容层）。 */
function legacyMemoryPath(cwd: string): string {
  return join(memoryDir(projectHash(cwd)), 'memory.jsonl')
}

/** 统一后的主存储：项目内 `.rivet/knowledge/memory.jsonl`。 */
function memoryPath(cwd: string): string {
  return join(cwd, '.rivet', 'knowledge', 'memory.jsonl')
}

function generateId(): string {
  return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** 归一化：容忍 Store A 旧 schema（createdAt 而非 ts，无 status/repeatCount）。 */
function normalizeEntry(raw: Record<string, unknown>): MemoryEntry | null {
  if (!raw.id || !raw.text) return null
  return {
    id: String(raw.id),
    text: String(raw.text),
    kind: (raw.kind ?? 'fact') as MemoryKind,
    confidence: typeof raw.confidence === 'number' ? raw.confidence : 0.5,
    source: (raw.source ?? 'manual') as MemorySource,
    status: (raw.status ?? 'observed') as MemoryStatus,
    evidence: typeof raw.evidence === 'string' ? raw.evidence : undefined,
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : [],
    ts: typeof raw.ts === 'number' ? raw.ts : (typeof raw.createdAt === 'number' ? raw.createdAt : 0),
    repeatCount: typeof raw.repeatCount === 'number' ? raw.repeatCount : 1,
    promotedToRule: typeof raw.promotedToRule === 'string' ? raw.promotedToRule : undefined,
    claimId: typeof raw.claimId === 'string' ? raw.claimId : undefined,
    fileRefs: Array.isArray(raw.fileRefs) ? raw.fileRefs.filter((f): f is string => typeof f === 'string') : undefined,
    validFrom: typeof raw.validFrom === 'number' ? raw.validFrom : undefined,
    validTo: typeof raw.validTo === 'number' ? raw.validTo : undefined,
    supersededBy: typeof raw.supersededBy === 'string' ? raw.supersededBy : undefined,
    transferableTo: Array.isArray(raw.transferableTo) ? raw.transferableTo.filter((t): t is string => typeof t === 'string') : undefined,
    topic: typeof raw.topic === 'string' ? raw.topic : undefined,
  }
}

function readJsonlEntries(path: string): MemoryEntry[] {
  if (!existsSync(path)) return []
  const results: MemoryEntry[] = []
  try {
    for (const line of readFileSync(path, 'utf-8').split('\n').filter(Boolean)) {
      try {
        const entry = normalizeEntry(JSON.parse(line))
        if (entry) results.push(entry)
      } catch { /* skip malformed */ }
    }
  } catch {
    return []
  }
  return results
}

/** 条目当前是否有效（未封口、未被取代）。 */
export function isCurrentEntry(entry: MemoryEntry): boolean {
  if (entry.validTo !== undefined && entry.validTo <= Date.now()) return false
  if (entry.supersededBy) return false
  if (entry.status === 'expired' || entry.status === 'rejected') return false
  return true
}

// ── Write ──────────────────────────────────────────────────────────────────

/** Append a memory entry to the unified log (project-local since Wave 2). */
export function appendMemoryEntry(
  cwd: string,
  partial: Omit<MemoryEntry, 'id' | 'ts' | 'repeatCount'> & { id?: string; ts?: number },
): MemoryEntry {
  // Count existing similar entries for repeatCount — streaming scan, no full parse.
  const normalized = partial.text.trim().toLowerCase().slice(0, 200)
  let repeatCount = 1
  const path = memoryPath(cwd)
  if (existsSync(path)) {
    try {
      for (const line of readFileSync(path, 'utf-8').split('\n')) {
        if (!line.trim()) continue
        // Fast substring match without full JSON parse
        if (line.toLowerCase().includes(normalized.slice(0, 50))) {
          repeatCount++
        }
      }
    } catch { /* count failure → use 1 */ }
  }

  const entry: MemoryEntry = {
    id: partial.id ?? generateId(),
    text: partial.text.slice(0, 500),
    kind: partial.kind,
    confidence: partial.confidence,
    source: partial.source,
    status: partial.status,
    evidence: partial.evidence,
    sessionId: partial.sessionId,
    tags: partial.tags,
    ts: partial.ts ?? Date.now(),
    repeatCount,
    promotedToRule: partial.promotedToRule,
    claimId: partial.claimId,
    fileRefs: partial.fileRefs,
    validFrom: partial.validFrom,
    validTo: partial.validTo,
    supersededBy: partial.supersededBy,
    transferableTo: partial.transferableTo,
    topic: partial.topic,
  }

  // 共用 project-memory-writer 的锁协议写入项目内知识库
  appendKnowledgeJsonl(cwd, 'memory.jsonl', compactUndefined(entry))
  return entry
}

/** JSONL 落盘前剥离 undefined 字段——保持行字节紧凑且解析回读等价。 */
function compactUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T
}

/**
 * Supersede 封口：旧条目标记 validTo + supersededBy，指向取代它的新条目。
 * 不删除——知识失效是迭代，不是遗忘（mempalace invalidate 语义）。
 * 只重写项目主存储；legacy Store B 只读不动。
 */
export function supersedeMemoryEntry(cwd: string, oldId: string, newId: string): boolean {
  const path = memoryPath(cwd)
  if (!existsSync(path)) return false

  const lockPath = join(cwd, '.rivet', 'knowledge', 'memory.jsonl.lock')
  const release = acquireLock(lockPath)
  try {
    let found = false
    const lines: string[] = []
    try {
      for (const line of readFileSync(path, 'utf-8').split('\n').filter(Boolean)) {
        try {
          const raw = JSON.parse(line)
          if (raw.id === oldId && !raw.supersededBy) {
            raw.validTo = Date.now()
            raw.supersededBy = newId
            raw.status = 'expired'
            found = true
            lines.push(JSON.stringify(raw))
            continue
          }
        } catch { /* keep malformed line as-is */ }
        lines.push(line)
      }
    } catch {
      return false
    }

    if (!found) return false
    writeFileAtomicSync(path, lines.join('\n') + '\n')
    return true
  } finally {
    release()
  }
}

// ── 维护（阶段6 管理）────────────────────────────────────────────────────

export interface PruneOptions {
  /** 已封口条目（isCurrentEntry=false）距 validTo 超过该天数才退役。默认 90。 */
  retentionDays?: number
  /** 物理文件上限字节（超出触发压缩，复用 compact 语义）。默认 16KB。 */
  maxFileBytes?: number
}

/**
 * 长期记忆退役（管理员视角的维护，非运行时路径）。
 *
 * 语义（invalidate-don't-delete 的落地执行）：不删除任何 current 条目；只把
 * 「早已封口（validTo 已过期 + superseded/expired）且距封口超过 retentionDays」
 * 的历史从主存储移除——它们已退出召回（isCurrentEntry 已挡），保留只徒增文件。
 * 同时压缩到 maxFileBytes 上限。current 条目、supersede 链的现存叶子永不删。
 *
 * @returns 移除的历史条目数。
 */
export function pruneMemoryStore(cwd: string, options: PruneOptions = {}): number {
  const path = memoryPath(cwd)
  if (!existsSync(path)) return 0
  const retentionMs = (options.retentionDays ?? 90) * 86_400_000

  const lockPath = join(cwd, '.rivet', 'knowledge', 'memory.jsonl.lock')
  const release = acquireLock(lockPath)
  try {
    const raw = readFileSync(path, 'utf-8')
    const lines = raw.split('\n').filter(Boolean)
    const now = Date.now()
    const kept: string[] = []
    let pruned = 0
    for (const line of lines) {
      let parsed: Record<string, unknown> | null = null
      try { parsed = JSON.parse(line) as Record<string, unknown> } catch { kept.push(line); continue }
      if (!parsed?.id || (!parsed.text && parsed.kind !== 'tombstone')) { kept.push(line); continue }
      const validTo = typeof parsed.validTo === 'number' ? parsed.validTo : undefined
      // 已封口（validTo 停在过去）且距封口超过保留期 → 退役。
      if (validTo !== undefined && validTo <= now - retentionMs) {
        pruned++
        continue
      }
      kept.push(line)
    }
    if (pruned === 0 && raw.length <= (options.maxFileBytes ?? 16_384)) return 0
    writeFileAtomicSync(path, (pruned > 0 ? kept : lines).join('\n') + '\n')
    return pruned
  } catch {
    return 0
  } finally {
    release()
  }
}

// ── Read ───────────────────────────────────────────────────────────────────

/**
 * Read all memory entries. Dual-read（过渡期）：项目主存储优先，
 * legacy Store B 机器目录 fallback 合并（按 id 去重，项目侧胜出）。
 */
export function readMemoryEntries(cwd: string): MemoryEntry[] {
  const primary = readJsonlEntries(memoryPath(cwd))
  // Legacy fallback: 排除正则观察产物（source='auto'）——那是 observation-extractor 的噪声，
  // Wave 1 已停写，迁移政策明确"观察类正则产物不迁"，dual-read 必须执行同一过滤。
  const legacy = readJsonlEntries(legacyMemoryPath(cwd)).filter(e => e.source !== 'auto')
  if (legacy.length === 0) return primary

  const seen = new Set(primary.map(e => e.id))
  const merged = [...primary]
  for (const entry of legacy) {
    if (!seen.has(entry.id)) merged.push(entry)
  }
  return merged
}

// ── Recall ─────────────────────────────────────────────────────────────────

export interface RecallOptions {
  kindFilter?: MemoryKind | MemoryKind[]
  /** 作用域过滤（topic 元数据完全匹配或子串）。 */
  topic?: string
  /** 默认只返回 current 叶子；true 时包含已封口/被取代的历史。 */
  includeHistory?: boolean
  /** 排除某会话写入的条目——当前会话的记忆已在历史里，不应再作为
   *  cross-session 知识重复注入，否则会放大旧任务/旧问题。 */
  excludeSessionId?: string
  /** 排除一组会话（并行工作区隔离：在线的其他会话也不互相注入）。 */
  excludeSessionIds?: readonly string[]
}

/** Keyword recall — score entries by term overlap with query.
 *  默认只返回当前有效条目（validity 窗口 + supersede 链过滤）。 */
export function recallMemoryEntries(
  cwd: string,
  query: string,
  limit = 5,
  kindFilter?: MemoryKind | MemoryKind[],
  options?: Omit<RecallOptions, 'kindFilter'>,
): MemoryEntry[] {
  const terms = tokenizeRecallQuery(query)
  if (terms.length === 0) return []

  const kinds = kindFilter
    ? (Array.isArray(kindFilter) ? kindFilter : [kindFilter])
    : undefined

  const excludedSessionIds = new Set<string>()
  if (options?.excludeSessionId) excludedSessionIds.add(options.excludeSessionId)
  for (const id of options?.excludeSessionIds ?? []) excludedSessionIds.add(id)

  const candidates = readMemoryEntries(cwd)
    .filter(e => !kinds || kinds.includes(e.kind))
    .filter(e => options?.includeHistory || isCurrentEntry(e))
    .filter(e => !options?.topic || (e.topic ?? '').toLowerCase().includes(options.topic.toLowerCase()))
    .filter(e => !excludedSessionIds.has(e.sessionId ?? ''))

  const scored = candidates
    .map(entry => {
      const text = entry.text.toLowerCase()
      const tagText = entry.tags.join(' ').toLowerCase()
      let score = 0
      for (const term of terms) {
        if (text.includes(term)) score += 2
        if (tagText.includes(term)) score += 1
      }
      score *= entry.confidence
      return { entry, score }
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.ts - a.entry.ts)

  return scored.slice(0, limit).map(s => s.entry)
}

export interface RenderMemoryBlockOptions {
  /** sourceFilter 存在时也要求 query 词项命中（默认 false 保持旧的恒定选集）。
   *  true 时旧问题/旧任务的记忆不会因为「最近写入」而无条件注入新问题。 */
  queryGatedSource?: boolean
  /** 排除某会话写入的条目（当前会话记忆不应作为 cross-session 重复注入）。 */
  excludeSessionId?: string
  /** 排除一组会话（并行工作区隔离：在线的其他会话也不互相注入）。 */
  excludeSessionIds?: readonly string[]
}

/** Render memory entries as XML block for prompt injection.
 *  Wave 1 起默认不再每轮推送（见 turn-step-producer.crossSessionMemoryPushEnabled）。
 *
 *  虚空仓库 P0：`sourceFilter` 存在时默认**完全脱离 query 评分**——按 ts 降序取
 *  该 source 的最近 8 条 current 条目。理由（缓存纪律）：评分选集随 userInput
 *  逐用户边界漂移 → 附录字节 churn；恒定选集保证 memory.jsonl 不变 → 输出字节
 *  不变。`queryGatedSource: true` 是为新问题不背旧任务记忆保留的正确性逃生口。 */
export function renderMemoryBlock(
  cwd: string,
  query: string,
  maxChars = 2000,
  sourceFilter?: MemorySource,
  options?: RenderMemoryBlockOptions,
): string | null {
  const excludedSessionIds = new Set<string>()
  if (options?.excludeSessionId) excludedSessionIds.add(options.excludeSessionId)
  for (const id of options?.excludeSessionIds ?? []) excludedSessionIds.add(id)
  const excluded = (e: MemoryEntry) => !excludedSessionIds.has(e.sessionId ?? '')
  const excludeOptions = { excludeSessionIds: [...excludedSessionIds] }
  const recalled = sourceFilter
    ? (options?.queryGatedSource
        ? recallMemoryEntries(cwd, query, 100, undefined, excludeOptions)
            .filter(e => e.source === sourceFilter)
            .sort((a, b) => b.ts - a.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
            .slice(0, 8)
        : readMemoryEntries(cwd)
            .filter(e => e.source === sourceFilter)
            .filter(excluded)
            .filter(isCurrentEntry)
            .sort((a, b) => b.ts - a.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
            .slice(0, 8))
    : recallMemoryEntries(cwd, query, 8, undefined, excludeOptions)
  if (recalled.length === 0) return null

  const lines = ['<cross-session-memory>']
  let budget = maxChars
  for (const entry of recalled) {
    const line = `  <m kind="${escapeXml(entry.kind)}" c="${entry.confidence.toFixed(2)}">${escapeXml(entry.text)}</m>`
    if (line.length > budget) break
    lines.push(line)
    budget -= line.length
  }
  lines.push('</cross-session-memory>')
  return lines.join('\n')
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/** Count how many times text (normalized) has appeared in memory. */
export function countSimilarMemoryEntries(cwd: string, text: string): number {
  const normalized = text.trim().toLowerCase().slice(0, 200)
  return readMemoryEntries(cwd).filter(e =>
    e.text.trim().toLowerCase().slice(0, 200) === normalized,
  ).length
}

// ── Chain Validation（Wave 5: 反馈闭环）───────────────────────────────────

export interface ChainIssue {
  kind: 'cycle' | 'dangling_reference' | 'dead_chain'
  /** 问题涉及的条目 id。 */
  entryIds: string[]
  detail: string
}

/**
 * 检查 supersede 链的结构完整性。只告警不自动修复。
 *
 * 三类问题：
 * ① 环：沿 `supersededBy` 走链遇到重复 id（visited set）
 * ② 悬空引用：`supersededBy` 指向不存在的 id
 * ③ 死链：链上全部条目有 `validTo` 且无 current 叶子（最远端也被封口）
 */
export function validateKnowledgeChains(entries: MemoryEntry[]): ChainIssue[] {
  const issues: ChainIssue[] = []
  const byId = new Map(entries.map(e => [e.id, e] as const))
  // 被任何 supersededBy 指向的条目集合——链根 = 有 supersededBy 且自身不被指向
  const supersedeTargets = new Set(
    entries.map(e => e.supersededBy).filter((id): id is string => !!id),
  )
  // 同一个环只报一次（沿链能到达该环的所有起点共享一份报告）
  const reportedCycleMembers = new Set<string>()

  for (const entry of entries) {
    if (!entry.supersededBy) continue

    // ② 悬空引用
    if (!byId.has(entry.supersededBy)) {
      issues.push({
        kind: 'dangling_reference',
        entryIds: [entry.id],
        detail: `${entry.id} 的 supersededBy 指向不存在的 ${entry.supersededBy}`,
      })
      continue
    }

    // ① 环检测：沿链走，visited set 判重。发现环后继续校验其余条目
    // （不能 break 整个循环——否则环之后的悬空引用/死链全部漏检）。
    if (reportedCycleMembers.has(entry.id)) continue
    const visited = new Set<string>()
    let current: MemoryEntry | undefined = entry
    let cycleStart: string | null = null
    while (current) {
      if (visited.has(current.id)) {
        cycleStart = current.id
        break
      }
      visited.add(current.id)
      if (!current.supersededBy) break
      current = byId.get(current.supersededBy)
    }
    if (cycleStart) {
      for (const id of visited) reportedCycleMembers.add(id)
      issues.push({
        kind: 'cycle',
        entryIds: [...visited],
        detail: `supersede 链在 ${cycleStart} 形成环（${visited.size} 个条目）`,
      })
      continue // 环上没有叶子概念，跳过死链检查（也防走链死循环）
    }

    // ③ 死链：只从链根报一次——链中段成员跳过，避免同一条链按成员数重复告警
    if (supersedeTargets.has(entry.id)) continue
    let leaf: MemoryEntry = entry
    while (leaf.supersededBy && byId.has(leaf.supersededBy)) {
      leaf = byId.get(leaf.supersededBy)!
    }
    if (!isCurrentEntry(leaf)) {
      // 链上所有条目（包括起点）都不是 current：确认整条链已死
      let cursor: MemoryEntry | undefined = entry
      let allDead = true
      while (cursor) {
        if (isCurrentEntry(cursor)) { allDead = false; break }
        if (!cursor.supersededBy) break
        cursor = byId.get(cursor.supersededBy)
      }
      if (allDead) {
        issues.push({
          kind: 'dead_chain',
          entryIds: [entry.id, ...(leaf.id !== entry.id ? [leaf.id] : [])],
          detail: `从 ${entry.id} 起的 supersede 链无 current 叶子（末端 ${leaf.id} 已封口）`,
        })
      }
    }
  }

  return issues
}

// ── Migration ──────────────────────────────────────────────────────────────

/**
 * Wave 2 迁移：legacy Store B（机器目录）→ 项目主存储。
 *
 * - 幂等按 id：已存在的跳过，可重复执行（崩溃恢复安全）
 * - **正则观察产物不迁**（source === 'auto'）——那是 observation-extractor
 *   的噪声，Wave 1 已停写，存量留在 legacy 层只读
 * - 人工/claim/verification 来源的迁入项目存储（v2 schema）
 *
 * Returns number of entries migrated.
 */
export function migrateLegacyMemoryToProject(cwd: string): number {
  const legacy = readJsonlEntries(legacyMemoryPath(cwd))
  if (legacy.length === 0) return 0

  const existingIds = new Set(readJsonlEntries(memoryPath(cwd)).map(e => e.id))

  let migrated = 0
  for (const entry of legacy) {
    if (existingIds.has(entry.id)) continue
    if (entry.source === 'auto') continue // 正则噪声不迁
    appendKnowledgeJsonl(cwd, 'memory.jsonl', compactUndefined(entry))
    existingIds.add(entry.id)
    migrated++
  }
  return migrated
}

/** Migrate old observations.jsonl (legacy机器目录) to the unified project log.
 *  Idempotent — skips entries whose IDs already exist. */
export function migrateObservationsToUnified(cwd: string): number {
  const oldPath = join(memoryDir(projectHash(cwd)), 'observations.jsonl')
  if (!existsSync(oldPath)) return 0

  const existingIds = new Set(readMemoryEntries(cwd).map(e => e.id))

  let migrated = 0
  try {
    const raw = readFileSync(oldPath, 'utf-8')
    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        const obs = JSON.parse(line)
        const id = obs.id ?? ''
        if (id && existingIds.has(id)) continue // already migrated, skip

        const entry: MemoryEntry = {
          id: id || generateId(),
          text: (obs.text ?? '').slice(0, 500),
          kind: obs.kind ?? 'fact',
          confidence: obs.confidence ?? 0.5,
          source: obs.source ?? 'auto',
          status: 'observed',
          tags: obs.tags ?? [],
          ts: obs.ts ?? Date.now(),
          repeatCount: 1,
          sessionId: obs.sessionId,
        }
        appendKnowledgeJsonl(cwd, 'memory.jsonl', compactUndefined(entry))
        existingIds.add(entry.id)
        migrated++
      } catch { /* skip malformed */ }
    }
  } catch {
    return 0
  }

  return migrated
}

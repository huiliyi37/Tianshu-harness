/**
 * Knowledge Index — 知识库专用 hybrid 检索面（Wave 3，知识重构）。
 *
 * 与源码索引（src/search/semantic-index.ts）**namespace 隔离**：知识语料
 * 是短文本条目 + knowledge/*.md 分块，不与代码 chunk 混排竞争。
 *
 * 检索管线（mempalace 配方）：
 *   1. 结构化元数据预过滤：kind / topic / validity（current 叶子）在打分前裁剪
 *   2. BM25 词法层（复用 src/search/text-index.ts）
 *   3. 时间邻近加权：recencyBoost = 1 / (1 + daysSinceCreation / 30)，乘入 BM25 score
 *   4. 向量层（可选）：embedding provider 可用时对知识 chunk 建向量，BM25 + 向量 RRF 融合
 *   5. LLM rerank（可选注入，默认无）
 *
 * 索引按 memory.jsonl mtime 惰性重建——条目量级 ≤ 数百，重建成本可忽略。
 */

import { existsSync, statSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { BM25Index } from '../search/text-index.js'
import { VectorIndex } from '../search/vector-index.js'
import { reciprocalRankFusion } from '../search/hybrid-search.js'
import type { EmbeddingProvider } from '../search/embedding-provider.js'
import { SQLiteKnowledgeIndex, type SQLiteKnowledgeDocument } from './sqlite-knowledge-index.js'
import { readMemoryEntries, isCurrentEntry, validateKnowledgeChains, type MemoryEntry, type MemoryKind, type ChainIssue } from './unified-memory.js'

// ── Types ──────────────────────────────────────────────────────────────────

export interface KnowledgeSearchOptions {
  limit?: number
  kind?: MemoryKind | MemoryKind[]
  /** topic 子串过滤（结构化预过滤层）。 */
  topic?: string
  /** 默认只检索 current 叶子；true 含已封口历史。 */
  includeHistory?: boolean
  /** 来源过滤：'playbook' 只返回 playbook 教训（Wave 4 撤出 appendix 后的 recall 通道）。 */
  source?: 'playbook'
  /** 并行工作区隔离：排除这些会话写入的条目。 */
  excludeSessionIds?: readonly string[]
  /** 可选 LLM rerank（默认无——注入函数即启用）。 */
  rerank?: (query: string, hits: KnowledgeHit[]) => Promise<KnowledgeHit[]>
}

export interface KnowledgeHit {
  id: string
  text: string
  score: number
  /** 结构化条目命中时携带完整条目（含 evidence 指针）。 */
  entry?: MemoryEntry
  /** knowledge/*.md 分块命中时携带来源文件名。 */
  file?: string
  /** playbook 教训命中标记（Wave 4：lessons 撤出 appendix 后 recall-only 通道）。 */
  playbook?: boolean
}

/** mempalace 时间邻近配方。 */
export function recencyBoost(entryTs: number, now = Date.now()): number {
  const days = Math.max(0, (now - entryTs) / 86_400_000)
  return 1 / (1 + days / 30)
}

// ── Index ──────────────────────────────────────────────────────────────────

const ENTRY_PREFIX = 'kentry'
const MD_PREFIX = 'kmd'
const PLAYBOOK_PREFIX = 'kpb'
const MD_CHUNK_LINES = 30

export class KnowledgeIndex {
  private bm25 = new BM25Index()
  private vectors = new VectorIndex()
  private entriesById = new Map<string, MemoryEntry>()
  private mdChunksById = new Map<string, { file: string; text: string }>()
  private playbookById = new Map<string, { text: string; indexText: string }>()
  private readonly persistent: SQLiteKnowledgeIndex
  private lastFingerprint = ''
  /** Wave 5: supersede 链完整性校验结果（rebuild 时刷新，recall 工具返回警告）。 */
  private _chainIssues: ChainIssue[] = []

  constructor(
    private readonly cwd: string,
    private readonly embedder?: EmbeddingProvider,
  ) {
    this.persistent = new SQLiteKnowledgeIndex(cwd)
  }

  /** 源数据指纹：memory.jsonl mtime+size + md 文件列表 mtimes。变化才重建。 */
  private fingerprint(): string {
    const parts: string[] = []
    const dir = join(this.cwd, '.rivet', 'knowledge')
    const memPath = join(dir, 'memory.jsonl')
    try {
      const st = statSync(memPath)
      parts.push(`m:${st.mtimeMs}:${st.size}`)
    } catch { parts.push('m:-') }
    try {
      for (const f of readdirSync(dir).sort()) {
        if (!f.endsWith('.md')) continue
        try {
          // mtime + size 双因子：NAS/SMB 挂载的 mtime 精度不可靠，size 兜底
          const st = statSync(join(dir, f))
          parts.push(`${f}:${st.mtimeMs}:${st.size}`)
        } catch { /* skip */ }
      }
    } catch { /* no dir */ }
    try {
      const st = statSync(join(this.cwd, '.rivet', 'playbook.jsonl'))
      parts.push(`pb:${st.mtimeMs}:${st.size}`)
    } catch { parts.push('pb:-') }
    return parts.join('|')
  }

  ensureBuilt(): void {
    const fp = this.fingerprint()
    if (fp === this.lastFingerprint) return
    this.lastFingerprint = fp
    this.rebuild()
  }

  private rebuild(): void {
    this.bm25.clear()
    this.entriesById.clear()
    this.mdChunksById.clear()
    this.playbookById.clear()
    // 向量不清：id 稳定（entry id / file+chunk），provider 增量补缺

    // ① 结构化条目（含历史——validity 过滤在 search 时做，支持 includeHistory）
    const memoryEntries = readMemoryEntries(this.cwd)
    for (const entry of memoryEntries) {
      const id = `${ENTRY_PREFIX}:${entry.id}`
      this.entriesById.set(id, entry)
      const indexText = [entry.text, entry.topic ?? '', entry.tags.join(' ')].join(' ')
      this.bm25.addChunk(id, 0, 0, indexText)
    }

    // ② knowledge/*.md 分块
    const dir = join(this.cwd, '.rivet', 'knowledge')
    if (existsSync(dir)) {
      let files: string[] = []
      try { files = readdirSync(dir).filter(f => f.endsWith('.md')) } catch { /* skip */ }
      for (const file of files) {
        let content = ''
        try { content = readFileSync(join(dir, file), 'utf-8') } catch { continue }
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i += MD_CHUNK_LINES) {
          const chunk = lines.slice(i, i + MD_CHUNK_LINES).join('\n').trim()
          if (!chunk) continue
          const id = `${MD_PREFIX}:${file}:${i}`
          this.mdChunksById.set(id, { file, text: chunk })
          this.bm25.addChunk(id, i, i + MD_CHUNK_LINES, chunk)
        }
      }
    }

    // ③ playbook 教训（Wave 4：<historical-lessons> 撤出 appendix 后仅经此召回）
    const pbPath = join(this.cwd, '.rivet', 'playbook.jsonl')
    if (existsSync(pbPath)) {
      let lines: string[] = []
      try { lines = readFileSync(pbPath, 'utf-8').split('\n').filter(Boolean) } catch { /* skip */ }
      for (const line of lines) {
        try {
          const b = JSON.parse(line) as { id?: string; lesson?: string; context?: string; details?: string; keywords?: string[] }
          if (!b.id || !b.lesson) continue
          const id = `${PLAYBOOK_PREFIX}:${b.id}`
          const text = [b.lesson, b.details ?? ''].filter(Boolean).join(' — ')
          const indexText = [b.lesson, b.context ?? '', b.details ?? '', (b.keywords ?? []).join(' ')].join(' ')
          this.playbookById.set(id, { text, indexText })
          this.bm25.addChunk(id, 0, 0, indexText)
        } catch { /* malformed line */ }
      }
    }

    // Wave 5（反馈闭环）：supersede 链完整性校验——复用 ① 已读的条目，零额外 IO
    this._chainIssues = validateKnowledgeChains(memoryEntries)
  }

  /** Supersede 链完整性校验结果（rebuild 后可用）。 */
  get chainIssues(): ChainIssue[] { return this._chainIssues }

  private documents(): SQLiteKnowledgeDocument[] {
    const documents: SQLiteKnowledgeDocument[] = []
    for (const [id, entry] of this.entriesById) {
      documents.push({
        id,
        text: entry.text,
        indexText: [entry.text, entry.topic ?? '', entry.tags.join(' ')].join(' '),
        source: 'entry',
        kind: entry.kind,
        topic: entry.topic,
        current: isCurrentEntry(entry),
        ts: entry.ts,
      })
    }
    for (const [id, chunk] of this.mdChunksById) {
      documents.push({ id, text: chunk.text, indexText: chunk.text, source: 'markdown', current: true, ts: 0 })
    }
    for (const [id, playbook] of this.playbookById) {
      documents.push({ id, text: playbook.text, indexText: playbook.indexText, source: 'playbook', current: true, ts: 0 })
    }
    return documents.sort((a, b) => a.id.localeCompare(b.id))
  }

  /** 可选向量层：provider 可用时为缺向量的 chunk 补 embedding。失败静默降级 BM25。 */
  async ensureVectors(): Promise<void> {
    if (!this.embedder?.isAvailable()) return
    const missing: Array<{ id: string; text: string }> = []
    for (const [id, entry] of this.entriesById) {
      if (!this.vectors.has(id)) missing.push({ id, text: entry.text })
    }
    for (const [id, chunk] of this.mdChunksById) {
      if (!this.vectors.has(id)) missing.push({ id, text: chunk.text.slice(0, 1000) })
    }
    for (const [id, pb] of this.playbookById) {
      if (!this.vectors.has(id)) missing.push({ id, text: pb.text.slice(0, 1000) })
    }
    if (missing.length === 0) return
    try {
      const embeddings = await this.embedder.embed(missing.map(m => m.text))
      for (let i = 0; i < missing.length && i < embeddings.length; i++) {
        this.vectors.add(missing[i]!.id, embeddings[i]!)
      }
      this.vectors.providerId = this.embedder.id
    } catch { /* embedding failure → BM25-only */ }
  }

  private passesFilters(id: string, options: KnowledgeSearchOptions): boolean {
    const isPlaybook = this.playbookById.has(id)
    if (options.source === 'playbook') return isPlaybook
    const entry = this.entriesById.get(id)
    const excludedSessions = new Set(options.excludeSessionIds ?? [])
    if (entry && entry.sessionId && excludedSessions.has(entry.sessionId)) return false
    if (!entry) {
      // md chunk / playbook：无结构化元数据——kind 过滤显式指定时只要结构化条目
      return !options.kind
    }
    if (!options.includeHistory && !isCurrentEntry(entry)) return false
    if (options.kind) {
      const kinds = Array.isArray(options.kind) ? options.kind : [options.kind]
      if (!kinds.includes(entry.kind)) return false
    }
    if (options.topic && !(entry.topic ?? '').toLowerCase().includes(options.topic.toLowerCase())) return false
    return true
  }

  async search(query: string, options: KnowledgeSearchOptions = {}): Promise<KnowledgeHit[]> {
    this.ensureBuilt()
    const limit = options.limit ?? 5
    const now = Date.now()

    // 持久化 SQLite/FTS5 是 JSONL/Markdown 的可重建投影；不可用时严格
    // 降级到既有内存 BM25，不让原生能力影响 recall 正确性。
    // 并行工作区隔离在 documents 进入 SQLite 前执行，保证 FTS 与内存 BM25
    // 两条召回路径都不带在线其他会话的在途条目。
    const excludedSessions = new Set(options.excludeSessionIds ?? [])
    const documents = excludedSessions.size > 0
      ? this.documents().filter(doc => {
          const entry = this.entriesById.get(doc.id)
          return !(entry && entry.sessionId && excludedSessions.has(entry.sessionId))
        })
      : this.documents()
    const sqliteHits = await this.persistent.search(
      documents,
      this.lastFingerprint,
      query,
      limit * 4,
      options,
    )
    const bm25Hits = (sqliteHits ?? this.bm25.search(query, limit * 4)
      .filter(h => this.passesFilters(h.file, options))
      .map(h => ({ id: h.file, score: h.score })))
      .map(h => {
        const entry = this.entriesById.get(h.id)
        const boost = entry ? recencyBoost(entry.ts, now) : 1
        return { id: h.id, score: h.score * boost }
      })
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))

    // 向量层（可选）→ RRF 融合
    let rankedIds: Array<{ id: string; score: number }> = bm25Hits
    if (this.embedder?.isAvailable()) {
      await this.ensureVectors()
      try {
        const [queryVec] = await this.embedder.embed([query])
        if (queryVec) {
          const vecHits = this.vectors.search(queryVec, limit * 4)
            .filter(h => this.passesFilters(h.id, options))
          if (vecHits.length > 0) {
            const fused = reciprocalRankFusion([
              bm25Hits.map(h => ({ id: h.id })),
              vecHits.map(h => ({ id: h.id })),
            ])
            rankedIds = fused.map(f => ({ id: f.id, score: f.rrfScore }))
          }
        }
      } catch { /* vector query failure → keep BM25 ranking */ }
    }

    let hits: KnowledgeHit[] = rankedIds.slice(0, limit).map(({ id, score }) => {
      const entry = this.entriesById.get(id)
      if (entry) return { id, text: entry.text, score, entry }
      const pb = this.playbookById.get(id)
      if (pb) return { id, text: pb.text.slice(0, 500), score, playbook: true }
      const chunk = this.mdChunksById.get(id)!
      return { id, text: chunk.text.slice(0, 500), score, file: chunk.file }
    })

    if (options.rerank && hits.length > 1) {
      try { hits = await options.rerank(query, hits) } catch { /* rerank failure → keep order */ }
    }

    return hits
  }
}

// ── Per-cwd cache ──────────────────────────────────────────────────────────

const indexCache = new Map<string, KnowledgeIndex>()

export function getKnowledgeIndex(cwd: string, embedder?: EmbeddingProvider): KnowledgeIndex {
  const key = `${cwd}\0${embedder?.id ?? 'lexical'}`
  let idx = indexCache.get(key)
  if (!idx) {
    idx = new KnowledgeIndex(cwd, embedder)
    indexCache.set(key, idx)
  }
  return idx
}

/** 测试用：清空 per-cwd/provider 缓存。 */
export function resetKnowledgeIndexCache(): void {
  indexCache.clear()
}

/**
 * Semantic index — file-level BM25 index with incremental updates.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { BM25Index, type SearchHit } from './text-index.js'
import { chunkByDefinitions } from './chunker-treesitter.js'
import { VectorIndex, type VectorIndexSnapshot } from './vector-index.js'
import { reciprocalRankFusion } from './hybrid-search.js'
import { type EmbeddingProvider, NullEmbeddingProvider } from './embedding-provider.js'
import { rankSearchCandidates } from './search-salience.js'
import { isFilesystemMetadata } from '../utils/file-metadata.js'
import { toPosixPath } from '../path-format.js'

/** Cap on chunks embedded in one pass to bound first-search latency/cost. */
const MAX_EMBED_CHUNKS = 4000

/** isStale() verdict cache window — in-process workers call semantic_search at
 *  high frequency on the same event loop; avoid a full-repo rescan per call. */
export const STALE_CHECK_TTL_MS = 30_000

const isMetadataPath = (file: string): boolean => toPosixPath(file).split('/').some(isFilesystemMetadata)

const INDEX_VERSION = 1
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.rivet', 'coverage', 'target', 'vendor', '__pycache__', '.venv', 'venv'])
// Polyglot: index a broad set of source languages, not just the TS/JS family.
const SOURCE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyi',
  '.go',
  '.rs',
  '.java', '.kt', '.scala',
  '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh',
  '.cs',
  '.rb', '.php', '.swift',
  '.lua', '.ex', '.exs', '.sh', '.bash',
  '.vue', '.svelte',
  '.md', '.json', '.yaml', '.yml', '.toml', '.sql',
])

export interface SemanticIndexSnapshot {
  version: number
  fileHashes: Record<string, string>
  chunkCount: number
  builtAt: number
  /** Lightweight chunk refs for cold-start restore (excludes terms — regenerated from text). */
  chunks?: Array<{ file: string; startLine: number; endLine: number; text: string }>
}

export class SemanticIndex {
  private index = new BM25Index()
  private fileHashes = new Map<string, string>()
  private cwd: string
  private provider: EmbeddingProvider
  private vectors = new VectorIndex()
  /** Set when chunks change so the next hybrid search re-embeds lazily. */
  private vectorsDirty = false
  /** Last isStale() verdict; reused for staleTtlMs to skip redundant rescans. */
  private staleCache: { at: number; stale: boolean } | null = null
  private readonly staleTtlMs: number

  constructor(cwd: string, provider: EmbeddingProvider = new NullEmbeddingProvider(), opts?: { staleTtlMs?: number }) {
    this.cwd = cwd
    this.provider = provider
    this.staleTtlMs = opts?.staleTtlMs ?? STALE_CHECK_TTL_MS
    this.loadMeta()
    this.loadVectors()
  }

  private indexPath(): string {
    return join(this.cwd, '.rivet', 'semantic-index.json')
  }

  private vectorIndexPath(): string {
    return join(this.cwd, '.rivet', 'vector-index.json')
  }

  private hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16)
  }

  /** Load persisted snapshot on cold start. Restores fileHashes and chunks so
   *  isStale() works immediately and searches succeed without a full rebuild. */
  private loadMeta(): void {
    this.staleCache = null // reloaded state: any cached verdict no longer applies
    const path = this.indexPath()
    if (!existsSync(path)) return
    try {
      const raw = readFileSync(path, 'utf-8')
      const snapshot = JSON.parse(raw) as SemanticIndexSnapshot
      if (snapshot.version === INDEX_VERSION && snapshot.fileHashes) {
        for (const [relPath, hash] of Object.entries(snapshot.fileHashes)) {
          if (!isMetadataPath(relPath)) this.fileHashes.set(relPath, hash)
        }
        // Restore chunks so cold-start searches work without rebuild
        if (snapshot.chunks) {
          for (const c of snapshot.chunks) {
            if (!isMetadataPath(c.file)) this.index.addChunk(c.file, c.startLine, c.endLine, c.text)
          }
        }
      }
    } catch {
      // Corrupt snapshot — rebuild on first ensureSemanticIndex call
    }
  }

  /** Full rebuild of the semantic index from source tree. */
  rebuild(maxFiles = 500): { indexed: number; skipped: number } {
    this.index.clear()
    this.fileHashes.clear()
    this.vectors.clear()
    this.vectorsDirty = true
    let indexed = 0
    let skipped = 0

    const walk = (dir: string, depth = 0): void => {
      if (depth > 8 || indexed >= maxFiles) return
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }

      for (const entry of entries) {
        if (indexed >= maxFiles) break
        if (isFilesystemMetadata(entry) || SKIP_DIRS.has(entry)) continue
        const abs = join(dir, entry)
        let st: ReturnType<typeof statSync>
        try {
          st = statSync(abs)
        } catch {
          continue
        }

        if (st.isDirectory()) {
          walk(abs, depth + 1)
        } else if (st.isFile()) {
          const ext = entry.slice(entry.lastIndexOf('.'))
          if (!SOURCE_EXT.has(ext)) {
            skipped++
            continue
          }
          const rel = relative(this.cwd, abs)
          let content: string
          try {
            content = readFileSync(abs, 'utf-8')
          } catch {
            skipped++
            continue
          }
          if (content.length > 200_000) {
            skipped++
            continue
          }

          const hash = this.hashContent(content)
          this.fileHashes.set(rel, hash)
          for (const c of chunkByDefinitions(content, ext)) {
            this.index.addChunk(rel, c.startLine, c.endLine, c.text)
          }
          indexed++
        }
      }
    }

    walk(this.cwd)
    this.persistMeta()
    // Index just synced with disk — record an accurate fresh verdict.
    this.staleCache = { at: Date.now(), stale: false }
    return { indexed, skipped }
  }

  /** Check if the index is stale by comparing file hashes against the current filesystem.
   *  The verdict is cached for staleTtlMs — workers may call this on every search. */
  isStale(): boolean {
    const now = Date.now()
    if (this.staleCache && now - this.staleCache.at < this.staleTtlMs) return this.staleCache.stale
    const stale = this.scanIsStale()
    this.staleCache = { at: now, stale }
    return stale
  }

  /** Full filesystem scan backing isStale() — synchronous, like its caller. */
  private scanIsStale(): boolean {
    // Quick count check: new files added since last index
    let diskCount = 0
    try {
      const walk = (dir: string, depth = 0): void => {
        if (depth > 8 || diskCount > this.fileHashes.size + 10) return
        let entries: string[]
        try { entries = readdirSync(dir) } catch { return }
        for (const entry of entries) {
          if (isFilesystemMetadata(entry) || SKIP_DIRS.has(entry)) continue
          const abs = join(dir, entry)
          let st: ReturnType<typeof statSync>
          try { st = statSync(abs) } catch { continue }
          if (st.isDirectory()) { walk(abs, depth + 1) }
          else if (st.isFile()) {
            const ext = entry.slice(entry.lastIndexOf('.'))
            if (SOURCE_EXT.has(ext)) diskCount++
          }
        }
      }
      walk(this.cwd)
    } catch { /* count failure → fall through to hash check */ }
    if (diskCount > this.fileHashes.size) return true

    for (const [relPath, storedHash] of this.fileHashes) {
      const absPath = join(this.cwd, relPath)
      if (!existsSync(absPath)) return true // file deleted
      try {
        const content = readFileSync(absPath, 'utf-8')
        if (this.hashContent(content) !== storedHash) return true
      } catch {
        return true // unreadable
      }
    }
    return false
  }

  /** Incrementally update the index: detect changed/new/deleted files and re-index.
   *  Falls back to full rebuild when more than 20% of files have changed. */
  incrementalUpdate(): { reindexed: number; removed: number; fallbackRebuild: boolean } {
    const maxFiles = 500
    let scanned = 0
    const currentFiles = new Set<string>()
    let toReindex: string[] = []
    let toRemove: string[] = []

    // Collect current source files
    const walk = (dir: string, depth = 0): void => {
      if (depth > 8 || scanned >= maxFiles) return
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }
      for (const entry of entries) {
        if (isFilesystemMetadata(entry) || SKIP_DIRS.has(entry)) continue
        const abs = join(dir, entry)
        let st: ReturnType<typeof statSync>
        try { st = statSync(abs) } catch { continue }
        if (st.isDirectory()) { walk(abs, depth + 1) }
        else if (st.isFile()) {
          const ext = entry.slice(entry.lastIndexOf('.'))
          if (!SOURCE_EXT.has(ext)) continue
          const rel = relative(this.cwd, abs)
          currentFiles.add(rel)
          scanned++
        }
      }
    }
    walk(this.cwd)

    // Find deleted files (in index but not on disk)
    for (const relPath of this.fileHashes.keys()) {
      if (!currentFiles.has(relPath)) toRemove.push(relPath)
    }

    // Find new/modified files
    for (const relPath of currentFiles) {
      const absPath = join(this.cwd, relPath)
      try {
        const content = readFileSync(absPath, 'utf-8')
        if (content.length > 200_000) continue
        const hash = this.hashContent(content)
        if (this.fileHashes.get(relPath) !== hash) toReindex.push(relPath)
      } catch {
        toRemove.push(relPath)
      }
    }

    // Fallback: if too many files changed, do a full rebuild
    const totalChanged = toRemove.length + toReindex.length
    const totalIndexed = this.fileHashes.size
    if (totalChanged >= Math.max(2, totalIndexed * 0.2)) {
      return this.rebuildWithResult(0, 0)
    }

    if (toRemove.length > 0 || toReindex.length > 0) this.vectorsDirty = true

    // Remove deleted files from index
    for (const relPath of toRemove) {
      this.index.removeFileChunks(relPath)
      this.vectors.removeFile(relPath)
      this.fileHashes.delete(relPath)
    }

    // Re-index changed files
    let reindexed = 0
    for (const relPath of toReindex) {
      // Remove old chunks first
      this.index.removeFileChunks(relPath)
      this.vectors.removeFile(relPath)
      this.fileHashes.delete(relPath)

      const absPath = join(this.cwd, relPath)
      try {
        const content = readFileSync(absPath, 'utf-8')
        const hash = this.hashContent(content)
        this.fileHashes.set(relPath, hash)
        const ext = relPath.slice(relPath.lastIndexOf('.'))
        for (const c of chunkByDefinitions(content, ext)) {
          this.index.addChunk(relPath, c.startLine, c.endLine, c.text)
        }
        reindexed++
      } catch { /* skip unreadable */ }
    }

    this.persistMeta()
    // Index just synced with disk — record an accurate fresh verdict.
    this.staleCache = { at: Date.now(), stale: false }
    return { reindexed, removed: toRemove.length, fallbackRebuild: false }
  }

  private rebuildWithResult(_indexed: number, _skipped: number): { reindexed: number; removed: number; fallbackRebuild: boolean } {
    const result = this.rebuild()
    return { reindexed: result.indexed, removed: 0, fallbackRebuild: true }
  }

  search(query: string, limit = 10) {
    return rankSearchCandidates(this.index.search(query, Math.max(limit * 3, 20)), query, limit)
  }

  /** True when a usable embedding provider is wired in. */
  get hasEmbeddings(): boolean {
    return this.provider.isAvailable()
  }

  private loadVectors(): void {
    if (!this.provider.isAvailable()) return
    const path = this.vectorIndexPath()
    if (!existsSync(path)) return
    try {
      const snapshot = JSON.parse(readFileSync(path, 'utf-8')) as VectorIndexSnapshot
      // Only adopt vectors produced by the SAME provider/model.
      this.vectors.loadSnapshot(snapshot, this.provider.id)
      const liveIds = new Set(this.index.getChunkRefs().map(c => `${c.file}:${c.startLine}-${c.endLine}`))
      this.vectors.prune(id => liveIds.has(id))
    } catch { /* corrupt → re-embed lazily */ }
  }

  private persistVectors(): void {
    if (this.vectors.size === 0) return
    const dir = join(this.cwd, '.rivet')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    try {
      writeFileSync(this.vectorIndexPath(), JSON.stringify(this.vectors.toSnapshot()), 'utf-8')
    } catch { /* best-effort */ }
  }

  /**
   * Embed any chunks missing a vector (lazy, batched, persisted). A network or
   * provider failure is swallowed — the vector layer simply stays partial and
   * search degrades to BM25. Returns the number of chunks embedded.
   */
  async ensureVectors(): Promise<number> {
    if (!this.provider.isAvailable()) return 0
    this.vectors.providerId = this.provider.id
    const refs = this.index.getChunkRefs()
    const pending = refs
      .map(r => ({ id: `${r.file}:${r.startLine}-${r.endLine}`, text: r.text }))
      .filter(c => !this.vectors.has(c.id))
      .slice(0, MAX_EMBED_CHUNKS)
    if (pending.length === 0) { this.vectorsDirty = false; return 0 }
    try {
      const embeddings = await this.provider.embed(pending.map(p => p.text))
      let n = 0
      for (let i = 0; i < pending.length && i < embeddings.length; i++) {
        const vec = embeddings[i]
        if (vec && vec.length > 0) { this.vectors.add(pending[i]!.id, vec); n++ }
      }
      if (n > 0) this.persistVectors()
      this.vectorsDirty = false
      return n
    } catch {
      return 0
    }
  }

  /**
   * Hybrid semantic search: fuse BM25 and vector rankings via RRF. Falls back
   * to pure BM25 when no embedding provider is available or embedding fails —
   * so this is always at least as good as the lexical path.
   */
  async searchHybrid(query: string, limit = 10): Promise<{ hits: SearchHit[]; backend: 'bm25' | 'hybrid' }> {
    const bm25Hits = this.index.search(query, Math.max(limit, 20))
    if (!this.provider.isAvailable()) return { hits: rankSearchCandidates(bm25Hits, query, limit), backend: 'bm25' }

    try {
      if (this.vectorsDirty || this.vectors.size === 0) await this.ensureVectors()
      const [queryVec] = await this.provider.embed([query])
      if (!queryVec || queryVec.length === 0 || this.vectors.size === 0) {
        return { hits: rankSearchCandidates(bm25Hits, query, limit), backend: 'bm25' }
      }
      const vectorHits = this.vectors.search(queryVec, Math.max(limit, 20))

      // Resolve any fused id back to a SearchHit. BM25 hits carry full metadata;
      // vector-only hits are reconstructed from the chunk ref table.
      const byId = new Map<string, SearchHit>()
      for (const h of bm25Hits) byId.set(h.id, h)
      if (vectorHits.some(v => !byId.has(v.id))) {
        for (const r of this.index.getChunkRefs()) {
          const id = `${r.file}:${r.startLine}-${r.endLine}`
          if (!byId.has(id)) {
            byId.set(id, { id, file: r.file, startLine: r.startLine, endLine: r.endLine, text: r.text.slice(0, 500), score: 0 })
          }
        }
      }

      const fused = reciprocalRankFusion([
        bm25Hits.map(h => ({ id: h.id })),
        vectorHits.map(v => ({ id: v.id })),
      ])
      const hits: SearchHit[] = []
      for (const f of fused) {
        const hit = byId.get(f.id)
        if (hit) hits.push({ ...hit, score: f.rrfScore })
        if (hits.length >= limit) break
      }
      return { hits: rankSearchCandidates(hits, query, limit), backend: 'hybrid' }
    } catch {
      return { hits: rankSearchCandidates(bm25Hits, query, limit), backend: 'bm25' }
    }
  }

  get chunkCount(): number {
    return this.index.size
  }

  persistMeta(): void {
    // Persisted state may differ from a previously cached verdict — invalidate.
    this.staleCache = null
    const dir = join(this.cwd, '.rivet')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const snapshot: SemanticIndexSnapshot = {
      version: INDEX_VERSION,
      fileHashes: Object.fromEntries(this.fileHashes),
      chunkCount: this.index.size,
      builtAt: Date.now(),
      chunks: this.index.getChunkRefs(),
    }
    writeFileSync(this.indexPath(), JSON.stringify(snapshot, null, 2), 'utf-8')
  }
}

/** Module-level cache per cwd */
const indexCache = new Map<string, SemanticIndex>()

export function getSemanticIndex(cwd: string, provider?: EmbeddingProvider): SemanticIndex {
  let idx = indexCache.get(cwd)
  if (!idx) {
    idx = new SemanticIndex(cwd, provider)
    indexCache.set(cwd, idx)
  }
  return idx
}

export function ensureSemanticIndex(cwd: string, provider?: EmbeddingProvider): SemanticIndex {
  const idx = getSemanticIndex(cwd, provider)
  // Cold start with persisted snapshot: chunks loaded from disk → skip rebuild.
  // Only rebuild when index is truly empty (never built) or stale (files changed).
  if (idx.chunkCount === 0) idx.rebuild()
  else if (idx.isStale()) idx.incrementalUpdate()
  return idx
}

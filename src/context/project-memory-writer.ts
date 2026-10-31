import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { randomBytes } from 'node:crypto'
import { projectStateAllowed } from '../config/project-trust.js'

const MAX_ENTRIES = 200
const MAX_FILE_SIZE = 16_384 // 16KB
/** commit_fact 侧车独立配额（FIFO）——不与主存储 200 条竞争。 */
const MAX_COMMIT_FACT_ENTRIES = 300
const LOCK_RETRY_MAX_MS = 500
const LOCK_RETRY_INTERVAL_MS = 20

interface MemoryEntry {
  id: string
  kind: string
  text: string
  confidence: number
  createdAt: number
  source: string
  tags?: string[]
  /** Wave 2 unified entries use `ts` — tolerated for sorting in compact. */
  ts?: number
}

/**
 * Acquire an advisory lock by creating a .lock file with O_CREAT|O_EXCL.
 * Retries with backoff up to LOCK_RETRY_MAX_MS. Returns a cleanup function
 * that removes the lock file.
 *
 * Without this lock, concurrent `remember(project)` calls across sessions
 * sharing the same cwd would interleave reads and writes, losing entries
 * (violating the atomic/monotonic invariant from 891cc1b6).
 */
/** Exported for unified-memory supersedeMemoryEntry — the read-modify-write needs the same lock protocol. */
export function acquireLock(lockPath: string): () => void {
  const start = Date.now()
  while (true) {
    try {
      const fd = openSync(lockPath, 'wx') // O_CREAT|O_EXCL
      // Write PID for diagnostics
      writeFileSync(fd, String(process.pid), 'utf-8')
      closeSync(fd)
      return () => {
        try { unlinkSync(lockPath) } catch { /* lock already released */ }
      }
    } catch {
      if (Date.now() - start > LOCK_RETRY_MAX_MS) {
        // Last attempt: force through without lock (existing behavior fallback)
        return () => {}
      }
      // Busy-wait is acceptable here — lock duration is sub-ms for append
      const waitUntil = Date.now() + LOCK_RETRY_INTERVAL_MS
      while (Date.now() < waitUntil) { /* spin */ }
    }
  }
}

/**
 * 软链写入收容（2026-10-31 审计 Finding 3）：atomicWrite 走「tmp 文件 + rename」，
 * 目标目录或目标文件为软链时，写入会落到项目外（项目记忆写入 → 任意路径写入）。
 *
 * 返回 true 表示目标目录可安全写入：目录真实存在、不是软链、且 realpath 落在项目根内；
 * 目标文件若已存在，也必须是项目内的常规文件（不是软链）。
 */
function isWritableInsideProject(cwd: string, targetPath: string): boolean {
  const dir = join(targetPath, '..')
  let root: string
  let realDir: string
  try {
    root = realpathSync(cwd)
    const dirStat = lstatSync(dir)
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return false
    realDir = realpathSync(dir)
  } catch {
    return false
  }
  const dirRel = relative(root, realDir)
  if (!dirRel || dirRel.startsWith('..') || isAbsolute(dirRel)) return false

  const fileStat = lstatSync(targetPath, { throwIfNoEntry: false })
  if (!fileStat) return true // 新文件：目录已确认可信
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) return false
  const realFile = realpathSync(targetPath)
  const fileRel = relative(root, realFile)
  return !(!fileRel || fileRel.startsWith('..') || isAbsolute(fileRel))
}

/**
 * Write content to a temp file then atomically rename to target path.
 * This guarantees readers never see a partial write.
 *
 * 拒绝静默越界写入：目录/文件为软链或解析后不在 cwd 内时不写，返回 false 由调用方
 * 决定降级（项目记忆是 best-effort，写失败不该炸调用链，但绝不能写到项目外）。
 */
function atomicWrite(cwd: string, targetPath: string, content: string): boolean {
  if (!isWritableInsideProject(cwd, targetPath)) return false
  const dir = join(targetPath, '..')
  const tmpName = `.memory.${randomBytes(4).toString('hex')}.tmp`
  const tmpPath = join(dir, tmpName)
  writeFileSync(tmpPath, content, 'utf-8')
  renameSync(tmpPath, targetPath)
  return true
}

export function appendProjectMemory(
  cwd: string,
  claim: { id: string; kind: string; text: string; confidence: number; createdAt: number; evidence?: Array<{ summary?: string }>; tags?: string[] },
): void {
  const entry: MemoryEntry = {
    id: claim.id,
    kind: claim.kind,
    text: claim.text,
    confidence: claim.confidence,
    createdAt: claim.createdAt,
    source: claim.evidence?.[0]?.summary ?? 'unknown',
    ...(claim.tags && claim.tags.length > 0 ? { tags: claim.tags } : {}),
  }

  // commit_fact 分流侧车：confidence 0.95 的 commit 事实曾在 200 条主配额中
  // 挤掉 0.7 的 dream 蒸馏产物（compact 按 confidence 降序裁剪）。侧车独立
  // 配额 FIFO，保留按 hash 召回能力，不与真知识竞争。
  if (entry.tags?.includes('commit_fact')) {
    appendToJsonl(cwd, 'commit-facts.jsonl', entry, MAX_COMMIT_FACT_ENTRIES)
    return
  }

  appendToJsonl(cwd, 'memory.jsonl', entry)
}

/**
 * Append one record to a knowledge JSONL file under lock; optional FIFO cap.
 * Exported for unified-memory (Wave 2 存储统一)——所有 `.rivet/knowledge/*.jsonl`
 * 写入共用同一把锁协议，避免两套写路径并发互踩。
 */
export function appendKnowledgeJsonl(cwd: string, filename: string, record: object, fifoCap?: number): void {
  appendToJsonl(cwd, filename, record as MemoryEntry, fifoCap)
}

/**
 * 解析 `.rivet/knowledge` 的可信真实路径；目录链上出现软链或解析后越出 cwd 时返回
 * undefined。`create` 为真时按需建目录（建完再复核一次）——必须在写锁文件**之前**
 * 判定：否则 lock/tmp 文件会顺着目录软链落到项目外。
 */
function resolveKnowledgeDir(cwd: string, create: boolean): string | undefined {
  let root: string
  try {
    root = realpathSync(cwd)
  } catch {
    return undefined
  }
  for (const segment of [join(cwd, '.rivet'), join(cwd, '.rivet', 'knowledge')]) {
    const stat = lstatSync(segment, { throwIfNoEntry: false })
    if (stat?.isSymbolicLink()) return undefined
    if (!stat) {
      if (!create) return undefined
      try { mkdirSync(segment, { recursive: true }) } catch { return undefined }
      if (lstatSync(segment, { throwIfNoEntry: false })?.isSymbolicLink()) return undefined
    } else if (!stat.isDirectory()) {
      return undefined
    }
  }
  const dir = join(cwd, '.rivet', 'knowledge')
  let realDir: string
  try {
    realDir = realpathSync(dir)
  } catch {
    return undefined
  }
  const rel = relative(root, realDir)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined
  return realDir
}

/** Append one entry to a knowledge JSONL file under lock; optional FIFO cap. */
function appendToJsonl(cwd: string, filename: string, entry: MemoryEntry, fifoCap?: number): void {
  const dir = resolveKnowledgeDir(cwd, true)
  if (!dir) return // 目录为软链/越界：项目记忆是 best-effort，静默跳过而不是写到项目外
  const path = join(dir, filename)
  const lockPath = join(dir, `${filename}.lock`)

  const release = acquireLock(lockPath)
  try {
    let existing = ''
    if (existsSync(path)) {
      try { existing = readFileSync(path, 'utf-8') } catch { /* treat as empty */ }
    }
    let newContent = existing + JSON.stringify(entry) + '\n'

    if (fifoCap !== undefined) {
      const lines = newContent.split('\n').filter(l => l.trim())
      if (lines.length > fifoCap) {
        newContent = lines.slice(lines.length - fifoCap).join('\n') + '\n'
      }
    }

    atomicWrite(cwd, path, newContent)
  } finally {
    release()
  }
}

/**
 * Read commit-fact sidecar entries (newest last). Used by recall on explicit request.
 * 信任门（2026-10-08 审计补漏）：侧车与 memory.jsonl 同住 .rivet/knowledge/、同样
 * 可随仓库分发，未授信项目一律不读——门下沉到读取函数内部，防新调用点漏门。
 */
export function readCommitFacts(cwd: string): MemoryEntry[] {
  if (!projectStateAllowed(cwd)) return []
  const path = join(cwd, '.rivet', 'knowledge', 'commit-facts.jsonl')
  if (!existsSync(path)) return []
  const entries: MemoryEntry[] = []
  try {
    for (const line of readFileSync(path, 'utf-8').split('\n').filter(l => l.trim())) {
      try {
        const parsed = JSON.parse(line)
        if (parsed.id && parsed.text) entries.push(parsed)
      } catch { /* skip malformed */ }
    }
  } catch {
    return []
  }
  return entries
}

/**
 * Compact project memory: deduplicate by id and trim to MAX_ENTRIES
 * by confidence (desc). Returns number of entries removed.
 */
export function compactProjectMemory(cwd: string): number {
  // 与 append 同一条收容判定：目录为软链/越界时不读不写（否则会读到项目外内容再
  // 拿它算「删除了几条」，语义上是假的）。
  const dir = resolveKnowledgeDir(cwd, false)
  if (!dir) return 0
  const path = join(dir, 'memory.jsonl')
  const lockPath = join(dir, 'memory.jsonl.lock')
  if (!existsSync(path)) return 0

  const release = acquireLock(lockPath)
  try {
    const entries: MemoryEntry[] = []
    let fileSize = 0
    try {
      const raw = readFileSync(path, 'utf-8')
      fileSize = raw.length
      const lines = raw.split('\n').filter(l => l.trim())
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line)
          if (parsed.id && parsed.text) entries.push(parsed)
        } catch { /* skip malformed lines */ }
      }
    } catch {
      return 0
    }

    // Deduplicate by id
    const seen = new Map<string, MemoryEntry>()
    for (const entry of entries) {
      seen.set(entry.id, entry)
    }

    // Sort by confidence desc, then createdAt/ts desc
    const kept = [...seen.values()]
      .sort((a, b) => b.confidence - a.confidence || (b.createdAt ?? b.ts ?? 0) - (a.createdAt ?? a.ts ?? 0))
      .slice(0, MAX_ENTRIES)

    // Write back only if changed
    if (kept.length < entries.length || fileSize > MAX_FILE_SIZE) {
      atomicWrite(cwd, path, kept.map(e => JSON.stringify(e)).join('\n') + '\n')
      return entries.length - kept.length
    }

    return 0
  } finally {
    release()
  }
}

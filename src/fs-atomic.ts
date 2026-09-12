import { writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises'

/** 本工具临时文件的唯一形态（issue #125）：带固定标记 `.rivet-atomic-<8hex>.tmp`，
 *  清理时才能与用户自己的 `<任意名>.<8位hex>.tmp` 区分开。 */
function atomicTmpPath(filePath: string): string {
  return `${filePath}.rivet-atomic-${randomUUID().slice(0, 8)}.tmp`
}

/** 只认本工具产生的临时文件名（旧形态无标记，无法与用户文件区分，不再清理）。 */
const ORPHAN_TMP_RE = /\.rivet-atomic-[0-9a-f]{8}\.tmp$/

/**
 * Atomically write a file: write to a temp file in the same directory,
 * then rename (which is atomic on POSIX and APFS). If the process crashes
 * mid-write, the original file is untouched.
 */
export function writeFileAtomicSync(filePath: string, data: string | Buffer): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const tmpPath = atomicTmpPath(filePath)
  try {
    // 0o600: files written here are user-private (config with API keys,
    // sessions) — align with token-store.ts; rename preserves the mode.
    // Buffer payloads (compressed transcripts) skip the utf-8 encoding.
    writeFileSync(tmpPath, data, data instanceof Buffer ? { mode: 0o600 } : { encoding: 'utf-8', mode: 0o600 })
    renameSync(tmpPath, filePath)
  } catch (err) {
    try { unlinkSync(tmpPath) } catch { /* ignore cleanup failure */ }
    throw err
  }
}

/**
 * Async version of writeFileAtomicSync — avoids blocking the event loop
 * during large session rewrites (compaction/reset).
 */
export async function writeFileAtomicAsync(filePath: string, data: string | Buffer): Promise<void> {
  const dir = dirname(filePath)
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  const tmpPath = atomicTmpPath(filePath)
  try {
    await writeFile(tmpPath, data, data instanceof Buffer ? { mode: 0o600 } : { encoding: 'utf-8', mode: 0o600 })
    await rename(tmpPath, filePath)
  } catch (err) {
    try { await unlink(tmpPath) } catch { /* ignore cleanup failure */ }
    throw err
  }
}

const ORPHAN_TMP_TTL_MS = 3_600_000 // 1 hour

/**
 * Scan directories for orphaned .tmp files left by crashed writeFileAtomicSync
 * calls. Files matching `*.rivet-atomic-XXXXXXXX.tmp` (fixed marker + 8-char UUID
 * suffix) older than ORPHAN_TMP_TTL_MS are deleted. 旧形态（无标记）不再清理——
 * 它无法与用户自己的临时文件区分，误删代价是静默数据丢失（issue #125）。
 *
 * Call once at startup to reclaim disk space from previous crashes.
 */
export function cleanupOrphanedTmpFiles(dirs: string[]): number {
  let cleaned = 0
  const cutoff = Date.now() - ORPHAN_TMP_TTL_MS
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      // 只认本工具产生的临时文件（issue #125）：固定标记 + 8 位 hex 后缀。
      // 旧形态 `<任意名>.<8hex>.tmp` 与用户文件同形，按它清理会静默删用户数据。
      if (!ORPHAN_TMP_RE.test(entry)) continue
      const fullPath = join(dir, entry)
      try {
        const st = statSync(fullPath)
        if (st.mtimeMs < cutoff) {
          unlinkSync(fullPath)
          cleaned++
        }
      } catch {
        // skip inaccessible files
      }
    }
  }
  return cleaned
}

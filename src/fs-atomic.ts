import { writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises'

/**
 * Atomically write a file: write to a temp file in the same directory,
 * then rename (which is atomic on POSIX and APFS). If the process crashes
 * mid-write, the original file is untouched.
 */
export function writeFileAtomicSync(filePath: string, data: string | Buffer): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const suffix = randomUUID().slice(0, 8)
  const tmpPath = filePath + '.rivet-atomic-' + suffix + '.tmp'
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
  const suffix = randomUUID().slice(0, 8)
  const tmpPath = filePath + '.rivet-atomic-' + suffix + '.tmp'
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
 * calls. Files matching the pattern `*.rivet-atomic-XXXXXXXX.tmp` (fixed marker +
 * 8-char UUID suffix) that are older than ORPHAN_TMP_TTL_MS are deleted.
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
      // Match pattern produced by writeFileAtomicSync: <filename>.<8-hex-chars>.tmp
      // The filename itself may contain dots (for example, data.json.a1b2c3d4.tmp).
      if (!/^.+\.[0-9a-f]{8}\.tmp$/.test(entry)) continue
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

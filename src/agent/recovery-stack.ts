/**
 * Recovery stack — list and undo via recovery journal entries.
 *
 * Tracks both mutations (file changes with backups) and restorations (undo events),
 * providing a complete audit trail for file operations.
 *
 * 2026-08-25 全异步化（fs/promises）：备份链（copy/mkdir/淘汰的 readdir+rm）原是
 * 每次编辑跑一遍的同步 IO——Windows+杀毒下 copyFileSync 大文件、rmSync 递归删
 * 目录树都是百毫秒~秒级主线程卡顿（apply_patch 每 target 再 ×N），是编辑热路径
 * 上最后一批同步阻塞点（/scout 卡死事故线的同类项）。纪律不变量：备份必须先于
 * 覆写完成——调用方必须 await trackFileChange，否则备份会拷到新内容。
 *
 * 2026-09-06 关键路径再瘦身（issue #61 族）：不变量收敛为「旧内容必须在覆写前
 * 捕获」——捕获用 await readFile 入内存（既有文件，AV 已扫）；新建备份文件的
 * 磁盘写改后台 fire-and-forget（新建文件是 Windows Defender/EDR 实时扫描的必中
 * 目标，await 它把扫描时延计入每次写工具调用）。回滚内存优先、磁盘兜底。
 */

import { readUnacknowledged, recordRecovery, type RecoveryEntry } from './recovery-journal.js'
import { access, copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { debugLog } from '../utils/debug.js'
import { writeFileAtomicAsync } from '../fs-atomic.js'

/** Lightweight record of a file mutation with a backup for undo. */
export interface FileChangeRecord {
  filePath: string
  action: 'edit' | 'write' | 'delete'
  /** Path to a temporary backup of the original file content. */
  backupPath?: string
  toolCallId: string
  ts: number
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

export function listRecoveryStack(cwd: string, sessionId?: string): RecoveryEntry[] {
  return readUnacknowledged(cwd, sessionId)
}

export function renderRecoveryStack(cwd: string, sessionId?: string): string {
  const entries = listRecoveryStack(cwd, sessionId)
  if (entries.length === 0) return 'Recovery stack empty — no unacknowledged recovery events.'

  const lines = entries.map((e, i) =>
    `${i + 1}. ${e.file} — ${e.action} (${e.linesLost} lines lost, ${e.ts})`,
  )
  return `Recovery stack (${entries.length}):\n${lines.join('\n')}\n\nThese files were restored during the session; verify intent before deliver_task.`
}

/** Record a file restore event (called from undo/edit recovery paths). */
export function trackFileRestore(
  cwd: string,
  file: string,
  action: string,
  linesLost = 0,
  sessionId?: string,
): void {
  recordRecovery(cwd, { file, action, linesLost }, sessionId)
}

/** Legacy latest-capture lookup across sessions. Mutation rollback must use
 *  its returned FileChangeRecord instead of this shared pointer. */
const latestBackups = new Map<string, string>()

/** 内存备份项：旧内容在覆写前已读入（回滚正确性所系）；磁盘落盘在后台进行。 */
interface MemoryBackup {
  content: Buffer
  backupPath: string
  timestampDir: string
  published: boolean
  pending: boolean
}
// Keyed by capture path, never by the mutable latest file pointer.
const memoryBackups = new Map<string, MemoryBackup>()
const capturedBackups = new WeakMap<FileChangeRecord, { cwd: string; memory: MemoryBackup }>()
const pendingBackupDirs = new Map<string, number>()
const leasedBackupDirs = new Map<string, number>()
const diskCaptureLeases = new WeakMap<FileChangeRecord, string>()
const evictingBackupDirs = new Map<string, Promise<void>>()
const MEMORY_BACKUP_CAP = 20
/** 超过该体积或含 NUL（二进制）时保留 await copyFile 旧路径。 */
const MEMORY_BACKUP_MAX_BYTES = 10 * 1024 * 1024

function backupKey(cwd: string, filePath: string): string {
  return join(cwd, filePath)
}

/** End a returned capture's active rollback lifetime. Idempotent; completed
 * tools release their disk leases while ordinary retention still keeps undo. */
export function releaseFileChange(capture: FileChangeRecord): void {
  const dir = diskCaptureLeases.get(capture)
  if (!dir) return
  diskCaptureLeases.delete(capture)
  const remaining = (leasedBackupDirs.get(dir) ?? 1) - 1
  if (remaining === 0) leasedBackupDirs.delete(dir)
  else leasedBackupDirs.set(dir, remaining)
}

/** Scope every capture to one tool execution, including rejected, aborted,
 * exceptional and partially captured multi-file operations. */
export function withFileChangeTracking<A, R>(
  run: (args: A, track: typeof trackFileChange) => Promise<R>,
): (args: A) => Promise<R> {
  return async args => {
    const captures: FileChangeRecord[] = []
    try {
      return await run(args, async (cwd, record) => {
        const capture = await trackFileChange(cwd, record)
        captures.push(capture)
        return capture
      })
    } finally {
      for (const capture of captures) releaseFileChange(capture)
    }
  }
}

function trimMemoryBackups(): void {
  for (const [path, memory] of memoryBackups) {
    if (memoryBackups.size <= MEMORY_BACKUP_CAP) break
    // Pending/failed publication has no disk fallback. Retain those bytes;
    // outstanding returned records also retain their own capture via WeakMap.
    if (memory.published) memoryBackups.delete(path)
  }
}

async function publishMemoryBackup(memory: MemoryBackup): Promise<void> {
  memory.pending = true
  pendingBackupDirs.set(memory.timestampDir, (pendingBackupDirs.get(memory.timestampDir) ?? 0) + 1)
  try {
    await evictingBackupDirs.get(memory.timestampDir)
    await writeFileAtomicAsync(memory.backupPath, memory.content)
    memory.published = true
  } finally {
    memory.pending = false
    const pending = (pendingBackupDirs.get(memory.timestampDir) ?? 1) - 1
    if (pending === 0) pendingBackupDirs.delete(memory.timestampDir)
    else pendingBackupDirs.set(memory.timestampDir, pending)
  }
}

async function captureMemoryBackup(key: string, memory: MemoryBackup): Promise<void> {
  const previousPath = latestBackups.get(key)
  if (previousPath && !memoryBackups.get(previousPath)?.pending) memoryBackups.delete(previousPath)
  for (const [path, prior] of memoryBackups) {
    if (memoryBackups.size < MEMORY_BACKUP_CAP) break
    if (prior.published) memoryBackups.delete(path)
  }
  if (memoryBackups.size >= MEMORY_BACKUP_CAP) {
    // Only a failed, settled publication can be retried. Never wait for an
    // in-flight flush; admission backpressure belongs before the new mutation.
    const failed = [...memoryBackups.values()].find(prior => !prior.pending && !prior.published)
    if (failed) {
      try {
        await publishMemoryBackup(failed)
        memoryBackups.delete(failed.backupPath)
      } catch { /* storage still unavailable: reject without mutating target */ }
    }
    if (memoryBackups.size >= MEMORY_BACKUP_CAP) {
      throw new Error(`Recovery backup capacity reached: ${MEMORY_BACKUP_CAP} captures have no disk fallback. No file was changed; retry after backup storage recovers.`)
    }
  }
  // Reservation is synchronous before returning: concurrent captures cannot
  // all observe the same free slot and overrun the cap.
  memory.pending = true
  memoryBackups.set(memory.backupPath, memory)
}

/** Cap on `.rivet/backups/` timestamp directories kept on disk. */
const MAX_BACKUP_DIRS = 100

/** 淘汰去频窗口：淘汰（readdir 全目录 + 递归 rm）不再逐编辑跑，每 cwd 至多
 *  5 分钟一次。窗口内目录数可短暂超过上限（增量 = 窗口内编辑次数，有界），
 *  下一窗口收敛——磁盘换事件循环，值得。 */
const EVICT_INTERVAL_MS = 5 * 60_000
const lastEvictByCwd = new Map<string, number>()

/**
 * Evict oldest timestamp-named backup dirs beyond the cap. The dirs are
 * `Date.now()`-named (see trackFileChange), so name order = age order; only
 * fully-numeric names are eligible, foreign dirs are never touched. Best-effort
 * — eviction failures degrade silently (backup cleanup is non-critical).
 */
export async function evictOldBackups(cwd: string, maxDirs = MAX_BACKUP_DIRS): Promise<void> {
  try {
    const backupsDir = join(cwd, '.rivet', 'backups')
    const dirs = (await readdir(backupsDir, { withFileTypes: true }))
      .filter(e => e.isDirectory() && /^\d+$/.test(e.name))
      .map(e => e.name)
      .sort()
    const excess = dirs.length - maxDirs
    if (excess <= 0) return
    await Promise.all(
      dirs.slice(0, excess).map(name => {
        const dir = join(backupsDir, name)
        if (pendingBackupDirs.has(dir) || leasedBackupDirs.has(dir)) return
        const existing = evictingBackupDirs.get(dir)
        if (existing) return existing
        // Register before rm starts. A storage-recovery retry may need this
        // same timestamp directory, so it waits for deletion and recreates it.
        const deleting = Promise.resolve().then(() => rm(dir, { recursive: true, force: true })).finally(() => {
          if (evictingBackupDirs.get(dir) === deleting) evictingBackupDirs.delete(dir)
        })
        evictingBackupDirs.set(dir, deleting)
        return deleting
      }),
    )
  } catch {
    // Non-critical — degrade silently
  }
}

/** 去频版淘汰：窗口内至多一次，fire-and-forget（不阻塞编辑路径）。 */
function evictOldBackupsDebounced(cwd: string): void {
  const now = Date.now()
  const last = lastEvictByCwd.get(cwd) ?? 0
  if (now - last < EVICT_INTERVAL_MS) return
  lastEvictByCwd.set(cwd, now)
  void evictOldBackups(cwd)
}

/** 测试钩子：清去频窗口（同 __setToolKeepaliveMs 先例）。 */
export function __resetEvictDebounceForTest(): void {
  lastEvictByCwd.clear()
}

/**
 * Restore a file to its most recent backup recorded by trackFileChange.
 * Returns true if a backup existed and was restored; false otherwise.
 */
export async function restoreLatestBackup(cwd: string, filePath: string, sessionId?: string): Promise<boolean> {
  const key = backupKey(cwd, filePath)
  const backupPath = latestBackups.get(key)
  return restoreBackup(cwd, filePath, backupPath, backupPath ? memoryBackups.get(backupPath) : undefined, sessionId, 'restore latest backup')
}

/** Restore the exact pre-mutation capture, even if another tool captures the
 * same path or the shared memory cache evicts its completed disk backup. */
export async function restoreFileChange(cwd: string, capture: FileChangeRecord, sessionId?: string): Promise<boolean> {
  const held = capturedBackups.get(capture)
  if (held && held.cwd !== cwd) return false
  const memory = held?.memory ?? (capture.backupPath ? memoryBackups.get(capture.backupPath) : undefined)
  return restoreBackup(cwd, capture.filePath, capture.backupPath, memory, sessionId, 'restore file change')
}

async function restoreBackup(
  cwd: string, filePath: string, backupPath: string | undefined,
  memory: MemoryBackup | undefined, sessionId: string | undefined, action: string,
): Promise<boolean> {
  // 内存优先：覆写前捕获的旧内容直接在手里（后台磁盘落盘可能仍在途）。
  try {
    if (memory) {
      await writeFile(join(cwd, filePath), memory.content)
    } else {
      if (!backupPath || !(await pathExists(backupPath))) return false
      await copyFile(backupPath, join(cwd, filePath))
    }
  } catch {
    return false
  }
  // Recovery-journal 记账是 best-effort 审计副作用：journal 写失败（如 cwd 不可写）
  // 不得把已成功的回滚伪装成失败——文件此刻已恢复，向调用方报 false 会诱发重复
  // 编辑，把刚恢复的旧内容又盖掉（与 undo.ts 的既有纪律一致）。
  try {
    recordRecovery(cwd, { file: filePath, action, linesLost: 0 }, sessionId)
  } catch (err) {
    debugLog('[recovery-stack] recovery-journal 写失败（回滚已成功，忽略）：', err)
  }
  return true
}

/**
 * Create a backup of a file before mutation and record the change.
 * The backup lives in .rivet/backups/<timestamp>/<capture>/<relpath> so undo can recover.
 *
 * 调用方纪律：必须 await 后再写文件——旧内容在返回前已捕获入内存（回滚正确性
 * 的前提）；新建备份文件的磁盘写在后台完成，不占用写工具关键路径。
 * Disk-only captures hold a cleanup lease until releaseFileChange. Write tools
 * use withFileChangeTracking so every exit releases all acquired leases.
 */
export async function trackFileChange(
  cwd: string,
  record: Omit<FileChangeRecord, 'backupPath' | 'ts'>,
): Promise<FileChangeRecord> {
  const ts = Date.now()
  let backupPath: string | undefined
  let captured: MemoryBackup | undefined
  let diskLeaseDir: string | undefined

  const absPath = join(cwd, record.filePath)
  if (await pathExists(absPath)) {
    const key = backupKey(cwd, record.filePath)
    const backupDir = join(cwd, '.rivet', 'backups', String(ts), randomUUID())
    const relDir = dirname(record.filePath)
    backupPath = join(backupDir, record.filePath)

    // 捕获前置：await readFile 把旧内容读进内存（既有文件，AV 已扫过——便宜）。
    // 落盘后台：新建文件是 Windows Defender/EDR 实时扫描的必中目标，await 它会
    // 把扫描时延计入每次写工具调用（issue #61 族）。进程崩溃 = 本次备份缺失
    // （与旧「拷贝中崩溃」同语义，不回归）。二进制/超大文件退回 copyFile 旧路径。
    let memoryCaptured = false
    let content: Buffer | undefined
    try { content = await readFile(absPath) } catch { /* read failure falls back to copyFile */ }
    if (content && content.length <= MEMORY_BACKUP_MAX_BYTES && !content.includes(0)) {
      const memory: MemoryBackup = {
        content, backupPath: backupPath!, timestampDir: dirname(backupDir), published: false, pending: false,
      }
      await captureMemoryBackup(key, memory)
      captured = memory
      void publishMemoryBackup(memory).catch(() => { /* rollback retains captured bytes */ }).finally(() => {
        if (latestBackups.get(key) !== backupPath) memoryBackups.delete(backupPath!)
        trimMemoryBackups()
      })
      memoryCaptured = true
    }
    if (!memoryCaptured) {
      const timestampDir = dirname(backupDir)
      pendingBackupDirs.set(timestampDir, (pendingBackupDirs.get(timestampDir) ?? 0) + 1)
      try {
        await evictingBackupDirs.get(timestampDir)
        await mkdir(relDir && relDir !== '.' ? join(backupDir, relDir) : backupDir, { recursive: true })
        await copyFile(absPath, backupPath)
        diskLeaseDir = timestampDir
        leasedBackupDirs.set(timestampDir, (leasedBackupDirs.get(timestampDir) ?? 0) + 1)
      } finally {
        const pending = (pendingBackupDirs.get(timestampDir) ?? 1) - 1
        if (pending === 0) pendingBackupDirs.delete(timestampDir)
        else pendingBackupDirs.set(timestampDir, pending)
      }
    }
    const previousPath = latestBackups.get(key)
    // Superseded failed captures remain available to their returned handles.
    if (previousPath && !memoryBackups.get(previousPath)?.pending) memoryBackups.delete(previousPath)
    latestBackups.set(key, backupPath)
    // Unbounded .rivet/backups growth (observed 6,396 dirs / 238MB) — cap it.
    // 去频后不在每次编辑跑（见 evictOldBackupsDebounced 注释）。
    evictOldBackupsDebounced(cwd)
  }

  const capture = { ...record, backupPath, ts }
  if (captured) capturedBackups.set(capture, { cwd, memory: captured })
  if (diskLeaseDir) diskCaptureLeases.set(capture, diskLeaseDir)
  return capture
}

/** Estimate lines lost by comparing current file to backup if available. */
export async function estimateLinesLost(cwd: string, file: string, backupPath?: string): Promise<number> {
  const path = backupPath ?? latestBackups.get(backupKey(cwd, file))
  const memory = path ? memoryBackups.get(path) : undefined
  if (memory) {
    const backupLines = memory.content.toString('utf-8').split('\n').length
    const currentPath = join(cwd, file)
    if (!(await pathExists(currentPath))) return backupLines
    const currentLines = (await readFile(currentPath, 'utf-8')).split('\n').length
    return Math.max(0, backupLines - currentLines)
  }
  if (!backupPath || !(await pathExists(backupPath))) return 0
  try {
    const backupContent = await readFile(backupPath, 'utf-8')
    const backupLines = backupContent.split('\n').length
    const currentPath = join(cwd, file)
    if (!(await pathExists(currentPath))) return backupLines
    const currentLines = (await readFile(currentPath, 'utf-8')).split('\n').length
    return Math.max(0, backupLines - currentLines)
  } catch {
    return 0
  }
}

/**
 * session-cd.ts — session-file migration for `/cd` (mid-session cwd switch).
 *
 * A session belongs to exactly one project slug dir (~/.rivet/sessions/<slug>,
 * slug derived from cwd). When the session moves to a new working directory,
 * its files move with it so the NEW project's /resume/--continue sees the
 * session and the OLD project stops listing it (move, not copy — no double
 * ownership drift).
 *
 * Deliberately NOT migrated: `<id>.claims.jsonl` / `<id>.claims.snapshot.json`.
 * The live ContextClaimStore instance is captured by long-lived tool closures
 * (memory tool, deliver_task) and keeps writing to the old dir, which still
 * exists — claims on old-project files staying visible to other sessions in
 * the old project is semantically right. They are session-scoped and reap
 * with the session; after a restart from the new cwd they rebuild empty.
 */

import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getSessionDir } from './session-persist.js'
import type { SessionPersist } from './session-persist.js'
import type { FileHistory } from './file-history.js'
import type { ContextClaimStore } from '../context/claim-store.js'

/** Flat files that make up a session's on-disk state (claims excluded, see above). */
const SESSION_FLAT_FILES = ['.jsonl', '.meta.json', '.memory.json', '.handoff.md', '.goal.json', '.frozen.json'] as const

export interface SessionMigrationResult {
  fromDir: string
  toDir: string
  /** Relative names actually moved (only existing ones). */
  moved: string[]
}

/** Same-volume rename with a cross-device copy+remove fallback. */
function movePath(src: string, dest: string): void {
  try {
    renameSync(src, dest)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    cpSync(src, dest, { recursive: true })
    rmSync(src, { recursive: true, force: true })
  }
}

/**
 * Move every existing artifact of `sessionId` from the old cwd's session dir
 * to the new cwd's. No-op (moved=[]) when both resolve to the same directory.
 * Throws on fs failure — callers should treat a failed migration as fatal for
 * the /cd (a half-moved session is worse than a refused one).
 */
export function migrateSessionFiles(sessionId: string, oldCwd: string, newCwd: string): SessionMigrationResult {
  const fromDir = getSessionDir(oldCwd)
  const toDir = getSessionDir(newCwd)
  const result: SessionMigrationResult = { fromDir, toDir, moved: [] }
  if (fromDir === toDir) return result

  mkdirSync(toDir, { recursive: true })
  for (const suffix of SESSION_FLAT_FILES) {
    const name = `${sessionId}${suffix}`
    const src = join(fromDir, name)
    if (!existsSync(src)) continue
    movePath(src, join(toDir, name))
    result.moved.push(name)
  }
  // Per-session subdirectory: backups/, sensorium.jsonl, pheromones.json,
  // cache-log.jsonl. Must move AFTER the old agent flushed stigmergy.
  const subDir = join(fromDir, sessionId)
  if (existsSync(subDir)) {
    movePath(subDir, join(toDir, sessionId))
    result.moved.push(`${sessionId}/`)
  }
  return result
}

/** rebuildStoresAfterCwdMove 的返回值：随会话迁到新 cwd 的两个内存状态容器。 */
export interface RebuiltCwdStores {
  fileHistory: FileHistory
  claimStore: ContextClaimStore
}

/**
 * /cd 换工作区后按新 cwd 重建 cwd 绑定的内存状态容器（switchAgentCwd 专用，
 * 与 migrateSessionFiles 配对——文件搬过去，容器也要跟过去）。
 *
 * - FileHistory：备份根焊死构造期 cwd（persist.getBackupDir()）。复用旧实例的
 *   后果：undo/rewind 读旧路径备份 ENOENT 被当「missing」静默跳过（撤销无声
 *   丢失）、新编辑在旧项目路径 mkdir 复活旧会话目录（跨项目状态脑裂），旧目录
 *   搬不空更让回程 /cd 的目录 rename ENOTEMPTY 确定性砖化。备份文件已随上面
 *   的迁移整体落到新 slug 目录，按新备份根重建即无缝接管（内存快照随迁）。
 * - ContextClaimStore：镜像原始构造点（bootstrap 的 persist.createClaimStore()），
 *   新编辑的 claim 从此记账到新项目目录。claims 文件刻意不迁移（见本模块头部
 *   说明），旧项目的在途 claim 留守旧目录、随会话删除回收——与「从新 cwd 重启
 *   后重建空账本」的既定语义一致。
 */
export function rebuildStoresAfterCwdMove(prevFileHistory: FileHistory, newPersist: SessionPersist): RebuiltCwdStores {
  return {
    fileHistory: prevFileHistory.withBackupRoot(newPersist.getBackupDir()),
    claimStore: newPersist.createClaimStore(),
  }
}

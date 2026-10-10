/**
 * MissionStore — per-mission JSON 持久化（P1 任务身份化）。
 *
 * 存储位置：`~/.rivet/missions/{missionId}.json`（rivetHome 全局目录，
 * 不落项目 cwd）。理由：worktree 会话的 record.cwd 是临时 worktree 路径，
 * 项目内存储会随 worktree 删除连带丢 Mission；全局目录 + projectId 过滤
 * 没有这个坑，且 get/rename/archive 不需要额外携带 cwd。
 *
 * API 全部同步——SessionManager.createSession 是同步方法，Mission 关联
 * 必须在其中完成（与 task-store 的 async 接口不同，这是有意的）。
 *
 * 模式参考 `task-store.ts`：tmp+rename 原子写、schema 校验、坏文件隔离。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { rivetHome } from '../config/paths.js'
import { errorContext, serverLogger } from './logger.js'
import type { Mission, MissionState } from './mission-protocol.js'

const MISSION_STATES: readonly MissionState[] = ['active', 'completed', 'archived']
const MISSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/

// ─── projectId 派生（桌面端 lib/projects.ts 镜像）──────────────────────────
// 必须与桌面端 projectId(cwd) 逐字节一致——桌面用它过滤 listMissions(cwd)，
// 算法漂移 = 任务列表凭空变空。FNV-1a → base36 前 6 位 + basename slug。

function shortHash(s: string): string {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h.toString(36).slice(0, 6)
}

function normalizePath(p: string): string {
  if (!p) return p
  let out = p.replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[a-zA-Z]:/.test(out) || p.includes('\\')) out = out.toLowerCase()
  return out
}

function pathBasename(p: string): string {
  if (!p) return p
  const trimmed = p.replace(/[/\\]+$/, '')
  const parts = trimmed.split(/[/\\]/)
  return parts[parts.length - 1] || trimmed || p
}

/** 与桌面端 `lib/projects.ts::projectId` 同算法的稳定项目标识。 */
export function missionProjectId(cwd: string): string {
  const b = pathBasename(cwd) || cwd
  const normalized = normalizePath(cwd)
  const slug = `${b}-${shortHash(normalized)}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return slug || 'project'
}

// ─── Store ────────────────────────────────────────────────────────────────

export function generateMissionId(): string {
  return `m_${randomUUID().slice(0, 8)}`
}

function isValidMissionId(id: string): boolean {
  return MISSION_ID_PATTERN.test(id)
}

function isMission(value: unknown): value is Mission {
  if (!value || typeof value !== 'object') return false
  const m = value as Partial<Mission>
  return typeof m.id === 'string' && isValidMissionId(m.id) &&
    typeof m.title === 'string' &&
    typeof m.state === 'string' && MISSION_STATES.includes(m.state as MissionState) &&
    typeof m.projectId === 'string' &&
    Array.isArray(m.sessionIds) && m.sessionIds.every(s => typeof s === 'string') &&
    typeof m.createdAt === 'number' && Number.isFinite(m.createdAt) &&
    typeof m.updatedAt === 'number' && Number.isFinite(m.updatedAt)
}

function cloneMission(m: Mission): Mission {
  return { ...m, sessionIds: [...m.sessionIds] }
}

/** 显式路径 getOrCreate 的去重键：title 空白折叠 + 小写。 */
function titleKey(title: string): string {
  return title.trim().toLowerCase()
}

export class MissionStore {
  private readonly dir: string
  private cache = new Map<string, Mission>()
  /** 是否已做过全目录扫描（cache 补全）。list/getOrCreate 首次触发。 */
  private scanned = false
  private readonly now: () => number

  constructor(opts: { dir?: string; now?: () => number } = {}) {
    this.dir = resolve(opts.dir ?? join(rivetHome(), 'missions'))
    this.now = opts.now ?? Date.now
    mkdirSync(this.dir, { recursive: true })
  }

  /**
   * 显式标题路径（NewSessionDialog / API 传 title）：按 (projectId, title)
   * 去重——同一项目下同名视为同一任务续作，返回已有 Mission。
   * 归档的 Mission 不参与去重（重开同名任务是新任务）。
   */
  getOrCreate(cwd: string, title: string): Mission {
    const projectId = missionProjectId(cwd)
    const key = titleKey(title)
    this.ensureScanned()
    for (const m of this.cache.values()) {
      if (m.projectId === projectId && m.state !== 'archived' && titleKey(m.title) === key) {
        return cloneMission(m)
      }
    }
    return this.create(cwd, title)
  }

  /**
   * 恒新建不去重（rev2 — maybeAutoTitle 隐式路径专用）：自动生成的标题
   * 撞名（如两次「修复测试失败」）是不同任务，按 title 合并会错误归属。
   */
  create(cwd: string, title: string): Mission {
    const ts = this.now()
    const mission: Mission = {
      id: generateMissionId(),
      title: title.trim(),
      state: 'active',
      projectId: missionProjectId(cwd),
      sessionIds: [],
      createdAt: ts,
      updatedAt: ts,
    }
    this.save(mission)
    return cloneMission(mission)
  }

  get(id: string): Mission | null {
    if (!isValidMissionId(id)) return null
    const cached = this.cache.get(id)
    if (cached) return cloneMission(cached)
    const filePath = this.pathFor(`${id}.json`)
    if (!existsSync(filePath)) return null
    return this.loadFromFile(filePath)
  }

  /** 列出 Mission（可选按项目 cwd 过滤），更新时间倒序。 */
  list(cwd?: string): Mission[] {
    this.ensureScanned()
    const projectId = cwd ? missionProjectId(cwd) : undefined
    const results = [...this.cache.values()]
      .filter(m => !projectId || m.projectId === projectId)
      .map(cloneMission)
    results.sort((a, b) => b.updatedAt - a.updatedAt)
    return results
  }

  /** 部分更新（title/state）。返回更新后的 Mission；不存在返回 null。 */
  update(id: string, patch: Partial<Pick<Mission, 'title' | 'state'>>): Mission | null {
    const existing = this.get(id)
    if (!existing) return null
    const next: Mission = {
      ...existing,
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
      ...(patch.state !== undefined ? { state: patch.state } : {}),
      updatedAt: this.now(),
    }
    this.save(next)
    return cloneMission(next)
  }

  /** 关联新 session（幂等：已存在的 sessionId 不重复追加）。 */
  addSession(missionId: string, sessionId: string): Mission | null {
    const existing = this.get(missionId)
    if (!existing) return null
    if (existing.sessionIds.includes(sessionId)) return existing
    const next: Mission = {
      ...existing,
      sessionIds: [...existing.sessionIds, sessionId],
      updatedAt: this.now(),
    }
    this.save(next)
    return cloneMission(next)
  }

  /**
   * 摘除一个 session（幂等：不在列表里原样返回，不改 updatedAt）。
   * 不决定归档——摘空后是否 archive 由调用方判断。
   */
  removeSession(missionId: string, sessionId: string): Mission | null {
    const existing = this.get(missionId)
    if (!existing) return null
    if (!existing.sessionIds.includes(sessionId)) return existing
    const next: Mission = {
      ...existing,
      sessionIds: existing.sessionIds.filter(id => id !== sessionId),
      updatedAt: this.now(),
    }
    this.save(next)
    return cloneMission(next)
  }

  archive(id: string): Mission | null {
    return this.update(id, { state: 'archived' })
  }

  // ─── 内部 ──────────────────────────────────────────────────────────────

  private save(mission: Mission): void {
    const tmpPath = this.pathFor(`${mission.id}.tmp`)
    const finalPath = this.pathFor(`${mission.id}.json`)
    writeFileSync(tmpPath, JSON.stringify(mission, null, 2), 'utf-8')
    renameSync(tmpPath, finalPath)
    this.cache.set(mission.id, cloneMission(mission))
  }

  private ensureScanned(): void {
    if (this.scanned) return
    this.scanned = true
    let files: string[]
    try {
      files = readdirSync(this.dir).filter(f => f.endsWith('.json'))
    } catch {
      return
    }
    for (const f of files) {
      const id = f.slice(0, -'.json'.length)
      if (!isValidMissionId(id) || this.cache.has(id)) continue
      this.loadFromFile(this.pathFor(f))
    }
  }

  private loadFromFile(filePath: string): Mission | null {
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const record = JSON.parse(raw) as unknown
      if (!isMission(record)) {
        this.quarantineFile(filePath, 'invalid mission schema')
        return null
      }
      this.cache.set(record.id, cloneMission(record))
      return cloneMission(record)
    } catch (err) {
      this.quarantineFile(filePath, 'corrupt mission record', err)
      return null
    }
  }

  private pathFor(fileName: string): string {
    const target = resolve(this.dir, fileName)
    const rel = relative(this.dir, target)
    if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`) || resolve(target) === this.dir) {
      throw new Error(`Path escapes mission directory: ${fileName}`)
    }
    return target
  }

  private quarantineFile(filePath: string, reason: string, err?: unknown): void {
    if (!existsSync(filePath)) return
    const quarantinePath = `${filePath}.corrupt-${Date.now()}`
    try {
      renameSync(filePath, quarantinePath)
      serverLogger.warn('Quarantined invalid mission record', {
        path: filePath, quarantinePath, reason,
        ...(err ? errorContext(err) : {}),
      })
    } catch (renameErr) {
      serverLogger.error('Failed to quarantine invalid mission record', {
        path: filePath, reason,
        ...(err ? errorContext(err) : {}),
        quarantineError: errorContext(renameErr),
      })
    }
  }
}

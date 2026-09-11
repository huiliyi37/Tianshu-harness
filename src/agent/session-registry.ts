import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { validateTrend } from './retrospect-fingerprint.js'

export function projectHash(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 12)
}

export interface SessionEntry {
  id: string
  pid: number
  role: 'coordinator' | 'worker' | 'standalone'
  taskDescription: string | null
  heartbeatAt: string
}

export interface ClaimEntry {
  sessionId: string
  claimType: 'exclusive' | 'shared_read'
  filePath: string
}

export interface EventInput {
  eventType: string
  filePath?: string
  detail?: string
  priority?: number
}

export interface EventRecord {
  id: number
  sessionId: string
  eventType: string
  filePath: string | null
  detail: string | null
  priority: number
  createdAt: string
}

export interface CycleRelayEntry {
  sessionId: string
  cycleOpen: string
  cycleClose: string | null
  generation: number
  createdAt: string
  closedAt: string | null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  cwd TEXT NOT NULL,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('coordinator','worker','standalone')),
  task_description TEXT
);

CREATE TABLE IF NOT EXISTS claims (
  session_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  claim_type TEXT NOT NULL CHECK(claim_type IN ('exclusive','shared_read')),
  acquired_at TEXT NOT NULL,
  confidence_trend TEXT,
  detail TEXT,
  priority INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_claims_session ON claims(session_id);
CREATE INDEX IF NOT EXISTS idx_claims_file ON claims(file_path);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  file_path TEXT,
  detail TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

CREATE TABLE IF NOT EXISTS cycle_relay (
  session_id TEXT PRIMARY KEY,
  cycle_open TEXT NOT NULL,
  cycle_close TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cycle_relay_closed ON cycle_relay(closed_at);

CREATE TABLE IF NOT EXISTS retrospect_fingerprints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  root_cause_keywords TEXT NOT NULL,
  recommendation_keywords TEXT NOT NULL,
  stability_trend TEXT NOT NULL CHECK(stability_trend IN ('stable','falling','rising')),
  confidence_trend TEXT NOT NULL CHECK(confidence_trend IN ('stable','falling','rising')),
  max_pressure REAL NOT NULL,
  tool_failure_rate REAL NOT NULL,
  bullet_ids TEXT NOT NULL DEFAULT '[]',
  project_hash TEXT,
  UNIQUE(session_id)
);
CREATE INDEX IF NOT EXISTS idx_fingerprints_created ON retrospect_fingerprints(created_at);
CREATE INDEX IF NOT EXISTS idx_fingerprints_project ON retrospect_fingerprints(project_hash);
`

// Test-only seam: force create() onto the nullDb degrade path so the fallback
// contract can be regression-tested without uninstalling the native module
// (same style as _setSandboxBackendForTest). Never set in production code.
let _forceNullDbForTest = false
export function _setBackendForTest(kind: 'null' | 'native'): void {
  _forceNullDbForTest = kind === 'null'
}
export function _resetBackendForTest(): void {
  _forceNullDbForTest = false
}

export class SessionRegistry {
  private db: any

  static async create(stateDir: string): Promise<SessionRegistry> {
    // Test-only degrade-path injection; production never takes this branch.
    if (_forceNullDbForTest) return new SessionRegistry(createNullDb())
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })
    let db: any
    try {
      const { resolveBetterSqlite3 } = await import('../repo/native-resolver.js')
      const Database = resolveBetterSqlite3(import.meta.url)
      if (!Database) throw new Error('better-sqlite3 not installed')
      const dbPath = join(stateDir, 'registry.db')
      db = new Database(dbPath)
      db.pragma('journal_mode = WAL')
      db.pragma('busy_timeout = 3000')
      db.pragma('foreign_keys = ON')
      // Migration: add project_hash column BEFORE exec(SCHEMA), because SCHEMA's
      // CREATE INDEX on project_hash fails if the column doesn't exist yet in
      // databases created before the project_hash column was added.
      try { db.exec('ALTER TABLE retrospect_fingerprints ADD COLUMN project_hash TEXT') } catch { /* already exists */ }
      db.exec(SCHEMA)
    } catch (err) {
      // Packaged sidecar with a broken native bundle: fail loud, never degrade.
      if ((err as { code?: string })?.code === 'ESQLITE_BUNDLE_BROKEN') throw err
      // Distinguish "library missing" from "schema execution failed"
      if (err instanceof Error && err.message?.includes('better-sqlite3')) {
        // 指引修正（2026-08-17）：旧的 windows-build-tools（废弃）+ `npm rebuild
        // better-sqlite3 -g tianshu-tui`（rebuild 不到、语法不通）换成本仓自带的
        // 预编译拉取脚本——npm 安装包含 scripts/fetch-native-sqlite.js，网络恢复后
        // 在安装目录重跑即可，无需编译工具链。
        const hint = process.platform === 'win32'
          ? 'Run: cd "$(npm root -g)\\tianshu-tui" && node scripts\\fetch-native-sqlite.js'
          : 'Run: cd "$(npm root -g)/tianshu-tui" && node scripts/fetch-native-sqlite.js'
        console.warn(`⚠ better-sqlite3 not available. Session history & cross-session memory will NOT persist (in-memory only, lost on exit). Reason: ${(err as Error).message}\n  Fix: ${hint}`)
      } else {
        console.error('Session registry schema failed:', err)
      }
      db = createNullDb()
    }
    return new SessionRegistry(db)
  }

  /**
   * Create and immediately reap crashed sessions' rows/claims (pid-liveness
   * sweep). A hard-killed process (kill -9 / power loss) leaves its exclusive
   * claims behind in the shared db; without the sweep the R2 pre-write guard
   * permanently rejects writes to those files, pointing at a dead session id.
   * Single home for the TUI bootstrap and serve sidecar startup sweep — no
   * auto-resume: crashed sessions stay recoverable via --continue / --resume.
   */
  static async createWithReap(stateDir: string, onReaped?: (crashed: SessionEntry[]) => void): Promise<SessionRegistry> {
    const registry = await SessionRegistry.create(stateDir)
    const crashed = registry.detectCrashedSessions()
    if (crashed.length > 0) onReaped?.(crashed)
    return registry
  }

  private constructor(db: any) {
    this.db = db
  }

  // ── Safe DB helpers ──

  private safeRun(sql: string, ...params: unknown[]): number {
    try {
      return this.db.prepare(sql).run(...params).changes ?? 0
    } catch (err) {
      console.error('SessionRegistry write error:', (err as Error).message)
      return 0
    }
  }

  private safeGet<T>(sql: string, ...params: unknown[]): T | undefined {
    try {
      return this.db.prepare(sql).get(...params) as T | undefined
    } catch (err) {
      console.error('SessionRegistry read error:', (err as Error).message)
      return undefined
    }
  }

  private safeAll<T>(sql: string, ...params: unknown[]): T[] {
    try {
      return this.db.prepare(sql).all(...params) as T[]
    } catch (err) {
      console.error('SessionRegistry read error:', (err as Error).message)
      return []
    }
  }


  register(sessionId: string, cwd: string, role: 'coordinator' | 'worker' | 'standalone' = 'standalone'): void {
    const now = new Date().toISOString()
    this.safeRun(`
      INSERT INTO sessions (id, pid, cwd, started_at, heartbeat_at, role)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        pid = excluded.pid,
        cwd = excluded.cwd,
        heartbeat_at = excluded.heartbeat_at,
        role = excluded.role
    `, sessionId, process.pid, cwd, now, now, role)
  }

  heartbeat(sessionId: string): void {
    const now = new Date().toISOString()
    this.safeRun('UPDATE sessions SET heartbeat_at = ? WHERE id = ?', now, sessionId)
  }

  unregister(sessionId: string): void {
    this.releaseAllClaims(sessionId)
    this.safeRun('DELETE FROM sessions WHERE id = ?', sessionId)
  }

  updatePid(sessionId: string, pid: number): void {
    this.safeRun('UPDATE sessions SET pid = ? WHERE id = ?', pid, sessionId)
  }

  listActive(): SessionEntry[] {
    return this.safeAll<SessionEntry>('SELECT id, pid, role, task_description AS taskDescription, heartbeat_at AS heartbeatAt FROM sessions')
  }

  /**
   * Count other sessions running on the same cwd with a live pid and recent
   * heartbeat. Used by VSW snapshot-policy to decide whether to isolate (C2).
   *
   * @param cwd           project root to match against
   * @param mySessionId   exclude self
   * @param maxHeartbeatAgeMs  sessions with heartbeat older than this are considered stale (default 120s)
   */
  countSameCwdActive(cwd: string, mySessionId: string, maxHeartbeatAgeMs = 120_000): number {
    const cutoff = new Date(Date.now() - maxHeartbeatAgeMs).toISOString()
    const rows = this.safeAll<{ id: string; pid: number }>(
      `SELECT id, pid FROM sessions WHERE cwd = ? AND id != ? AND heartbeat_at > ?`,
      cwd, mySessionId, cutoff,
    )
    return rows.filter(r => this.isProcessRunning(r.pid)).length
  }

  detectCrashedSessions(): SessionEntry[] {
    const sessions = this.listActive()
    const crashed: SessionEntry[] = []
    for (const s of sessions) {
      if (!this.isProcessRunning(s.pid)) {
        crashed.push(s)
      }
    }
    // Reap crashed sessions and their claims (no FK cascade in schema)
    if (crashed.length > 0) {
      const ids = crashed.map(s => s.id)
      const placeholders = ids.map(() => '?').join(',')
      this.safeRun(`DELETE FROM claims WHERE session_id IN (${placeholders})`, ...ids)
      this.safeRun(`DELETE FROM sessions WHERE id IN (${placeholders})`, ...ids)
    }
    return crashed
  }

  acquireClaim(sessionId: string, filePath: string, claimType: 'exclusive' | 'shared_read'): boolean {
    // Check existing claims
    const existing = this.safeAll<{ session_id: string; claim_type: string }>(
      'SELECT session_id, claim_type FROM claims WHERE file_path = ?', filePath
    )

    for (const c of existing) {
      if (c.session_id === sessionId) return true // same session re-acquires
      if (c.claim_type === 'exclusive') return false // file exclusively locked by another
      if (claimType === 'exclusive') return false // want exclusive but shared_read exists
    }
    const now = new Date().toISOString()
    const changes = this.safeRun(
      'INSERT OR REPLACE INTO claims (session_id, file_path, claim_type, acquired_at) VALUES (?, ?, ?, ?)',
      sessionId, filePath, claimType, now
    )
    return changes > 0
  }

  releaseClaim(sessionId: string, filePath: string): void {
    this.safeRun('DELETE FROM claims WHERE session_id = ? AND file_path = ?', sessionId, filePath)
  }

  releaseAllClaims(sessionId: string): void {
    this.safeRun('DELETE FROM claims WHERE session_id = ?', sessionId)
  }

  checkClaim(filePath: string): ClaimEntry | null {
    const row = this.safeGet<ClaimEntry>(
      'SELECT session_id AS sessionId, claim_type AS claimType, file_path AS filePath FROM claims WHERE file_path = ? LIMIT 1',
      filePath
    )
    return row ?? null
  }

  reapStaleClaims(): string[] {
    const sessions = this.listActive()
    const deadIds: string[] = []
    for (const s of sessions) {
      if (!this.isProcessRunning(s.pid)) {
        deadIds.push(s.id)
      }
    }
    if (deadIds.length === 0) return []

    // Collect files held by dead sessions
    const placeholders = deadIds.map(() => '?').join(',')
    const rows = this.safeAll<{ file_path: string }>(
      `SELECT DISTINCT file_path FROM claims WHERE session_id IN (${placeholders})`,
      ...deadIds
    )

    // Delete dead sessions and their claims (no FK cascade in schema)
    this.safeRun(`DELETE FROM claims WHERE session_id IN (${placeholders})`, ...deadIds)
    this.safeRun(`DELETE FROM sessions WHERE id IN (${placeholders})`, ...deadIds)

    return rows.map(r => r.file_path)
  }

  close(): void {
    this.db.close()
  }

  // ── Events (cross-session communication) ──────────────────

  publishEvent(sessionId: string, input: EventInput): void {
    this.safeRun(`
      INSERT INTO events (session_id, event_type, file_path, detail, priority)
      VALUES (?, ?, ?, ?, ?)
    `, sessionId, input.eventType, input.filePath ?? null, input.detail ?? null, input.priority ?? 0)
  }

  consumeEvents(mySessionId: string, lastSeenId: number, limit = 50): EventRecord[] {
    return this.safeAll<EventRecord>(`
      SELECT id, session_id AS sessionId, event_type AS eventType,
             file_path AS filePath, detail, priority, created_at AS createdAt
      FROM events
      WHERE id > ? AND session_id != ?
      ORDER BY id ASC
      LIMIT ?
    `, lastSeenId, mySessionId, limit)
  }

  cleanupOldEvents(maxAgeMs: number): number {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString()
    return this.safeRun('DELETE FROM events WHERE created_at < ?', cutoff)
  }

  // ── Cycle relay (Songline substrate) ─────────────────────

  setCycleOpen(sessionId: string, cycleOpen: string, generation = 0): void {
    this.safeRun(`
      INSERT INTO cycle_relay (session_id, cycle_open, generation)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        cycle_open = excluded.cycle_open,
        generation = excluded.generation
    `, sessionId, cycleOpen, generation)
  }

  setCycleClose(sessionId: string, cycleClose: string): void {
    this.safeRun(`
      INSERT INTO cycle_relay (session_id, cycle_open, cycle_close, generation, closed_at)
      VALUES (?, ?, ?, 0, datetime('now'))
      ON CONFLICT(session_id) DO UPDATE SET
        cycle_close = excluded.cycle_close,
        generation = cycle_relay.generation + 1,
        closed_at = excluded.closed_at
    `, sessionId, cycleClose, cycleClose)
  }

  getCycleOpen(sessionId: string): string | null {
    const row = this.safeGet<{ cycleOpen: string }>(
      'SELECT cycle_open AS cycleOpen FROM cycle_relay WHERE session_id = ?',
      sessionId
    )
    return row?.cycleOpen ?? null
  }

  getCycleClose(sessionId: string): string | null {
    const row = this.safeGet<{ cycleClose: string | null }>(
      'SELECT cycle_close AS cycleClose FROM cycle_relay WHERE session_id = ?',
      sessionId
    )
    return row?.cycleClose ?? null
  }

  getLastCycleClose(): string | null {
    const row = this.safeGet<{ cycleClose: string }>(`
      SELECT cycle_close AS cycleClose
      FROM cycle_relay
      WHERE cycle_close IS NOT NULL
      ORDER BY closed_at DESC, created_at DESC
      LIMIT 1
    `)
    return row?.cycleClose ?? null
  }

  getCycleRelay(sessionId: string): CycleRelayEntry | null {
    const row = this.safeGet<CycleRelayEntry>(`
      SELECT session_id AS sessionId,
             cycle_open AS cycleOpen,
             cycle_close AS cycleClose,
             generation,
             created_at AS createdAt,
             closed_at AS closedAt
      FROM cycle_relay
      WHERE session_id = ?
    `, sessionId)
    return row ?? null
  }

  // ── Cross-session claims snapshot for prompt injection ──

  /**
   * Return all active claims grouped by file, excluding claims held by `mySessionId`.
   * Used for prompt injection so the LLM can see which files other sessions are working on.
   */
  getActiveClaims(excludeSessionId: string): Array<{ sessionId: string; filePath: string; claimType: string }> {
    return this.safeAll<{ sessionId: string; filePath: string; claimType: string }>(`
      SELECT c.session_id AS sessionId, c.file_path AS filePath, c.claim_type AS claimType
      FROM claims c
      JOIN sessions s ON s.id = c.session_id
      WHERE c.session_id != ?
    `, excludeSessionId)
  }

  private isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  // ── Retrospect Fingerprints (REM pattern detection) ──────

  /**
   * 存储 session 的 retrospect 指纹。
   * 如果该 session 已有指纹，会被覆盖（UPSERT）。
   */
  storeFingerprint(fp: {
    sessionId: string
    createdAt: number
    rootCauseKeywords: string[]
    recommendationKeywords: string[]
    stabilityTrend: 'stable' | 'falling' | 'rising'
    confidenceTrend: 'stable' | 'falling' | 'rising'
    maxPressure: number
    toolFailureRate: number
    bulletIds: string[]
    projectHash?: string
  }): void {
    this.safeRun(`
      INSERT INTO retrospect_fingerprints
        (session_id, created_at, root_cause_keywords, recommendation_keywords,
         stability_trend, confidence_trend, max_pressure, tool_failure_rate, bullet_ids, project_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        created_at = excluded.created_at,
        root_cause_keywords = excluded.root_cause_keywords,
        recommendation_keywords = excluded.recommendation_keywords,
        stability_trend = excluded.stability_trend,
        confidence_trend = excluded.confidence_trend,
        max_pressure = excluded.max_pressure,
        tool_failure_rate = excluded.tool_failure_rate,
        bullet_ids = excluded.bullet_ids,
        project_hash = excluded.project_hash
    `,
      fp.sessionId,
      fp.createdAt,
      JSON.stringify(fp.rootCauseKeywords),
      JSON.stringify(fp.recommendationKeywords),
      fp.stabilityTrend,
      fp.confidenceTrend,
      fp.maxPressure,
      fp.toolFailureRate,
      JSON.stringify(fp.bulletIds),
      fp.projectHash ?? null,
    )
  }

  /**
   * 加载历史指纹，按时间倒序。
   * @param limit 最多返回的指纹数量（默认 10）
   * @param excludeSessionId 排除的 session ID（通常是当前 session）
   */
  loadFingerprints(limit = 10, excludeSessionId?: string, projectHash?: string): Array<{
    sessionId: string
    createdAt: number
    rootCauseKeywords: string[]
    recommendationKeywords: string[]
    stabilityTrend: 'stable' | 'falling' | 'rising'
    confidenceTrend: 'stable' | 'falling' | 'rising'
    maxPressure: number
    toolFailureRate: number
    bulletIds: string[]
  }> {
    const conditions: string[] = []
    const params: unknown[] = []
    if (excludeSessionId) { conditions.push('session_id != ?'); params.push(excludeSessionId) }
    if (projectHash) { conditions.push('project_hash = ?'); params.push(projectHash) }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    params.push(limit)
    const query = `SELECT session_id, created_at, root_cause_keywords, recommendation_keywords,
                stability_trend, confidence_trend, max_pressure, tool_failure_rate, bullet_ids
         FROM retrospect_fingerprints
         ${where}
         ORDER BY created_at DESC
         LIMIT ?`

    const rows = this.safeAll<Record<string, unknown>>(query, ...params)

    return rows.map(row => ({
      sessionId: row.session_id as string,
      createdAt: row.created_at as number,
      rootCauseKeywords: JSON.parse(row.root_cause_keywords as string) as string[],
      recommendationKeywords: JSON.parse(row.recommendation_keywords as string) as string[],
      stabilityTrend: validateTrend(row.stability_trend as string, 'stable'),
      confidenceTrend: validateTrend(row.confidence_trend as string, 'stable'),
      maxPressure: row.max_pressure as number,
      toolFailureRate: row.tool_failure_rate as number,
      bulletIds: JSON.parse(row.bullet_ids as string) as string[],
    }))
  }

  /**
   * 清理旧指纹。
   * @param maxAgeMs 最大保留时间（毫秒）
   * @returns 删除的指纹数量
   */
  cleanupOldFingerprints(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs
    return this.safeRun('DELETE FROM retrospect_fingerprints WHERE created_at < ?', cutoff)
  }
}

/**
 * Creates a no-op database proxy when better-sqlite3 is unavailable.
 * All method calls succeed silently — session features degrade gracefully.
 *
 * run() must report changes:1, not 0: acquireClaim() interprets changes>0 as
 * "claim staked". Reporting 0 made the R2 pre-write guard (tool-pipeline) block
 * EVERY write_file/edit_file with a bogus「正被另一个会话独占编辑」error — the
 * opposite of the documented degrade contract (README + comment above).
 * changes:1 = writes/claims succeed with no cross-session protection, which is
 * what degrade-to-in-memory means here. get()/all() still return nothing, so
 * checkClaim() stays null and no phantom owner is ever reported.
 */
function createNullDb(): any {
  const noopStmt = {
    run: () => ({ changes: 1, lastInsertRowid: 0 }),
    all: () => [] as any[],
    get: () => undefined,
  }
  return new Proxy(Object.create(null), {
    get: (_target, prop: string) => {
      if (prop === 'prepare') return () => noopStmt
      if (prop === 'exec') return () => {}
      if (prop === 'pragma') return () => {}
      if (prop === 'close') return () => {}
      return () => {}
    },
  })
}


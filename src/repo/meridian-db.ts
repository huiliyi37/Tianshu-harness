import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'


import { resolveBetterSqlite3 } from './native-resolver.js'
import type { ParseResult, MeridianSymbol, MeridianEdge, EdgeConfidence } from './meridian-types.js'
import type { ModuleSummaryEntry, CliEntry } from './meridian-types.js'
import type { PhysarumEdgeState, PhysarumPredictionObservation } from './physarum-types.js'
import type { ImmuneMemory } from '../agent/immune-types.js'
import type { MistakeEntry } from '../agent/mistake-notebook.js'
import type { ToolPatternMinerSnapshot } from '../agent/tool-pattern-miner.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS symbols (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  file_path TEXT NOT NULL,
  line INTEGER NOT NULL,
  exported INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);

CREATE TABLE IF NOT EXISTS edges (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  confidence TEXT NOT NULL DEFAULT 'extracted',
  PRIMARY KEY(source_id, target_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);

CREATE TABLE IF NOT EXISTS access_log (
  file_path TEXT NOT NULL,
  accessed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_access_file ON access_log(file_path);

CREATE TABLE IF NOT EXISTS co_edits (
  file_a TEXT NOT NULL,
  file_b TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  last_turn INTEGER NOT NULL,
  PRIMARY KEY(file_a, file_b)
);
CREATE INDEX IF NOT EXISTS idx_co_edits_a ON co_edits(file_a);
CREATE INDEX IF NOT EXISTS idx_co_edits_b ON co_edits(file_b);

CREATE TABLE IF NOT EXISTS physarum_edges (
  file_a TEXT NOT NULL,
  file_b TEXT NOT NULL,
  weight REAL NOT NULL,
  flow REAL NOT NULL DEFAULT 0,
  consolidated INTEGER NOT NULL DEFAULT 0,
  activation_count INTEGER NOT NULL DEFAULT 0,
  last_activated_turn INTEGER NOT NULL DEFAULT 0,
  direction REAL NOT NULL DEFAULT 0,
  PRIMARY KEY(file_a, file_b)
);

CREATE TABLE IF NOT EXISTS physarum_prediction_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file TEXT NOT NULL,
  predicted_at_turn INTEGER NOT NULL,
  predictions_json TEXT NOT NULL,
  observed_file TEXT NOT NULL,
  observed_at_turn INTEGER NOT NULL,
  hit_rank INTEGER,
  lead_turns INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_physarum_prediction_source ON physarum_prediction_observations(source_file);
CREATE INDEX IF NOT EXISTS idx_physarum_prediction_observed ON physarum_prediction_observations(observed_file);

CREATE TABLE IF NOT EXISTS immune_memory (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,
  response_json TEXT NOT NULL,
  affinity_score REAL NOT NULL DEFAULT 0.5,
  hit_count INTEGER NOT NULL DEFAULT 0,
  last_hit INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_immune_pattern ON immune_memory(pattern);

CREATE TABLE IF NOT EXISTS mistake_entries (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  error TEXT NOT NULL,
  context TEXT NOT NULL,
  resolution TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_mistake_error ON mistake_entries(error);

CREATE TABLE IF NOT EXISTS p3_state (
  kind TEXT NOT NULL,
  version INTEGER NOT NULL,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(kind, version)
);

CREATE TABLE IF NOT EXISTS sensorimotor_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  context_hash TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  success INTEGER NOT NULL,
  duration_ms INTEGER,
  turn INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sm_context ON sensorimotor_log(context_hash, tool_name);
CREATE INDEX IF NOT EXISTS idx_sm_tool ON sensorimotor_log(tool_name);

CREATE TABLE IF NOT EXISTS module_summaries (
  dir_path TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  key_exports_json TEXT NOT NULL DEFAULT '[]',
  file_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  content_hash TEXT NOT NULL DEFAULT '',
  verified_at_commit TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cli_entries (
  flag TEXT NOT NULL,
  handler TEXT NOT NULL,
  wired INTEGER NOT NULL DEFAULT 0,
  verified_at_commit TEXT,
  source_file TEXT NOT NULL,
  PRIMARY KEY(flag, source_file)
);

CREATE TABLE IF NOT EXISTS meridian_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_access_time ON access_log(accessed_at);
CREATE INDEX IF NOT EXISTS idx_sm_created ON sensorimotor_log(created_at);
CREATE INDEX IF NOT EXISTS idx_p3_updated ON p3_state(updated_at);
`;

/**
 * Minimum interval between retention cleanups (ms). Cleanup runs at most once
 * per 24h per process — the DELETE cost is bounded and amortized.
 */
const CLEANUP_MIN_INTERVAL_MS = 24 * 3600 * 1000
/** Append-only p3_state event rows retention window (days). */
const P3_EVENT_RETENTION_DAYS = 30
/** access_log / sensorimotor_log retention window (days). */
const LOG_RETENTION_DAYS = 90

/**
 * Escape GLOB wildcards so a literal file path can be used with SQLite GLOB.
 * LIKE treats underscore as a single-char wildcard, so path-prefix queries
 * must use GLOB with the literal path escaped (persistence #2; D6 task 1).
 *
 * ⚠ 前缀模式必须在 JS 侧拼好整体绑定（`${globEscape(p)}:*`），绝不要在
 * SQL 里写 `GLOB ? || ':*'`——拼接形态让 SQLite 无法证明模式有固定前缀，
 * 放弃 idx_edges_target 退化为全表扫描（2026-09-12 实测 225K 边全扫
 * ~1s/查询，analyzeImpact 三跳 BFS 累计成 [slow-sync-stage] 4s 警告；
 * 整体绑定后走索引 SEARCH，0.9–4.4ms，结果集逐字节一致）。
 */
function globEscape(filePath: string): string {
  return filePath.replace(/[*?[]/g, '[$&]')
}

export class MeridianDb {
  private conn: any = null
  private readonly stateDir: string
  private _available = true

  constructor(stateDir: string) {
    this.stateDir = stateDir
  }

  private get db(): any {
    if (!this.conn) {
      if (!existsSync(this.stateDir)) mkdirSync(this.stateDir, { recursive: true })
      try {
        const Database = resolveBetterSqlite3(import.meta.url)
        if (!Database) throw new Error('better-sqlite3 not installed')
        const dbPath = join(this.stateDir, 'meridian.db')
        this.conn = new Database(dbPath)
        this.conn.pragma('journal_mode = WAL')
        this.conn.pragma('busy_timeout = 3000')
        this.conn.exec(SCHEMA)
        migrateToV1(this.conn)
        // WAL cap: without journal_size_limit the -wal file grows unbounded
        // (observed 376MB); autocheckpoint alone never truncates it.
        this.conn.pragma('journal_size_limit = 67108864')
        migrateToV2(this.conn)
        this.cleanupExpiredRows()
      } catch (err) {
        // Packaged sidecar with a broken native bundle: fail loud, never degrade.
        if ((err as { code?: string })?.code === 'ESQLITE_BUNDLE_BROKEN') throw err
        const reason = err instanceof Error ? err.message : String(err)
        // 指引修正（2026-08-17，同 session-registry）：废弃的 windows-build-tools
        // 与语法不通的 npm rebuild 换成本仓自带的预编译拉取脚本。
        const hint = process.platform === 'win32'
          ? 'Run: cd "$(npm root -g)\\tianshu-tui" && node scripts\\fetch-native-sqlite.js'
          : 'Run: cd "$(npm root -g)/tianshu-tui" && node scripts/fetch-native-sqlite.js'
        console.warn(`⚠ better-sqlite3 not available. Code index (MeridianDb) disabled — repo symbol search & cross-file analysis will be unavailable. Reason: ${reason}\n  Fix: ${hint}`)
        this._available = false
        this.conn = createNullDb()
      }
    }
    return this.conn
  }

  /**
   * Whether the index is actually backed by sqlite.
   *
   * Callers must consult this BEFORE doing expensive work whose only consumer is
   * the index (reading a file, hashing it, running tree-sitter). Feeding the
   * no-op DB is not merely wasted storage: `needsParse` can never observe a
   * previous write, so every caller re-does the same work forever.
   *
   * Touching `this.db` first is load-bearing — `_available` starts out `true`
   * and only becomes accurate once the lazy connection has been attempted.
   */
  get available(): boolean {
    void this.db
    return this._available
  }

  needsParse(filePath: string, contentHash: string): boolean {
    // No index means nothing to refresh. Returning `true` here (the shape the
    // no-op DB produces on its own, since its `get()` always yields undefined)
    // tells callers to parse and store — into a sink that keeps no record — so
    // the very next call asks again.
    if (!this.available) return false
    const row = this.db.prepare('SELECT content_hash FROM files WHERE path = ?').get(filePath) as { content_hash: string } | undefined
    return !row || row.content_hash !== contentHash
  }

  upsertFile(result: ParseResult): void {
    if (!this.available) return
    const tx = this.db.transaction(() => {
      this.db.prepare('INSERT OR REPLACE INTO files (path, content_hash) VALUES (?, ?)').run(result.filePath, result.contentHash)
      this.db.prepare('DELETE FROM symbols WHERE file_path = ?').run(result.filePath)
      // Use GLOB instead of LIKE — LIKE treats _ as single-char wildcard,
      // causing mis-deletion of edges for similarly-named files (persistence #2).
      const escapedPath = globEscape(result.filePath)
      this.db.prepare('DELETE FROM edges WHERE source_id GLOB ?').run(`${escapedPath}:*`)

      const insertSym = this.db.prepare('INSERT OR REPLACE INTO symbols (id, name, kind, file_path, line, exported, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
      for (const s of result.symbols) {
        insertSym.run(s.id, s.name, s.kind, s.filePath, s.line, s.exported ? 1 : 0, s.contentHash)
      }

      const insertEdge = this.db.prepare('INSERT OR REPLACE INTO edges (source_id, target_id, kind, weight, confidence) VALUES (?, ?, ?, ?, ?)')
      for (const e of result.edges) {
        insertEdge.run(e.sourceId, e.targetId, e.kind, e.weight, e.confidence ?? 'extracted')
      }

      for (const imp of result.imports) {
        const firstSymbol = result.symbols[0]
        if (firstSymbol) {
          insertEdge.run(firstSymbol.id, `${imp}:*:0`, 'imports', 1.0, 'extracted')
        }
      }
    })
    tx()
  }

  getSymbolsForFile(filePath: string): MeridianSymbol[] {
    return (this.db.prepare('SELECT * FROM symbols WHERE file_path = ?').all(filePath) as Array<Record<string, unknown>>).map(row => ({
      id: row.id as string,
      name: row.name as string,
      kind: row.kind as MeridianSymbol['kind'],
      filePath: row.file_path as string,
      line: row.line as number,
      exported: (row.exported as number) === 1,
      contentHash: row.content_hash as string,
    }))
  }

  /** Get every indexed symbol — cross-file callee-name matching reads this. */
  getAllSymbols(): MeridianSymbol[] {
    return (this.db.prepare('SELECT * FROM symbols').all() as Array<Record<string, unknown>>).map(row => ({
      id: row.id as string,
      name: row.name as string,
      kind: row.kind as MeridianSymbol['kind'],
      filePath: row.file_path as string,
      line: row.line as number,
      exported: (row.exported as number) === 1,
      contentHash: row.content_hash as string,
    }))
  }

  /**
   * 按 name 集合一次拉取符号（buildCallEdges 批量路径，2026-09-08）。
   * 参数化 `WHERE name IN (?,...)` 走 idx_symbols_name，替代 getAllSymbols
   * 全表物化 + 内存过滤。名字去重后按 500 个分片（SQLite 变量上限留足余量），
   * 分片结果按 symbol id 去重。空集合/无命中返回 []。
   */
  getSymbolsByNames(names: string[]): MeridianSymbol[] {
    const unique = [...new Set(names)]
    if (unique.length === 0) return []
    const CHUNK_SIZE = 500
    const seen = new Set<string>()
    const out: MeridianSymbol[] = []
    for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
      const chunk = unique.slice(i, i + CHUNK_SIZE)
      const placeholders = chunk.map(() => '?').join(',')
      const rows = this.db.prepare(`SELECT * FROM symbols WHERE name IN (${placeholders})`).all(...chunk) as Array<Record<string, unknown>>
      for (const row of rows) {
        const symbol: MeridianSymbol = {
          id: row.id as string,
          name: row.name as string,
          kind: row.kind as MeridianSymbol['kind'],
          filePath: row.file_path as string,
          line: row.line as number,
          exported: (row.exported as number) === 1,
          contentHash: row.content_hash as string,
        }
        if (seen.has(symbol.id)) continue
        seen.add(symbol.id)
        out.push(symbol)
      }
    }
    return out
  }

  getEdgesFrom(symbolId: string): MeridianEdge[] {
    return (this.db.prepare('SELECT * FROM edges WHERE source_id = ?').all(symbolId) as Array<Record<string, unknown>>).map(row => ({
      sourceId: row.source_id as string,
      targetId: row.target_id as string,
      kind: row.kind as MeridianEdge['kind'],
      weight: row.weight as number,
      confidence: (row.confidence as EdgeConfidence) ?? 'extracted',
    }))
  }

  getEdgesTo(symbolId: string): MeridianEdge[] {
    return (this.db.prepare('SELECT * FROM edges WHERE target_id = ?').all(symbolId) as Array<Record<string, unknown>>).map(row => ({
      sourceId: row.source_id as string,
      targetId: row.target_id as string,
      kind: row.kind as MeridianEdge['kind'],
      weight: row.weight as number,
      confidence: (row.confidence as EdgeConfidence) ?? 'extracted',
    }))
  }

  recordAccess(filePath: string): void {
    if (!this.available) return
    this.db.prepare('INSERT INTO access_log (file_path) VALUES (?)').run(filePath)
  }

  getAccessCount(filePath: string): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM access_log WHERE file_path = ?').get(filePath) as { cnt: number }
    return row.cnt
  }

  getNeighborIds(startId: string, maxHops: number): Set<string> {
    const visited = new Set<string>()
    let frontier = new Set([startId])
    for (let hop = 0; hop < maxHops; hop++) {
      const next = new Set<string>()
      for (const id of frontier) {
        const rows = this.db.prepare(
          'SELECT target_id as nid FROM edges WHERE source_id = ? UNION SELECT source_id as nid FROM edges WHERE target_id = ?',
        ).all(id, id) as Array<{ nid: string }>
        for (const r of rows) {
          if (!visited.has(r.nid) && r.nid !== startId) {
            visited.add(r.nid)
            next.add(r.nid)
          }
        }
      }
      frontier = next
    }
    return visited
  }

  getStats(): { files: number; symbols: number; edges: number } {
    const files = (this.db.prepare('SELECT COUNT(*) as cnt FROM files').get() as { cnt: number }).cnt
    const symbols = (this.db.prepare('SELECT COUNT(*) as cnt FROM symbols').get() as { cnt: number }).cnt
    const edges = (this.db.prepare('SELECT COUNT(*) as cnt FROM edges').get() as { cnt: number }).cnt
    return { files, symbols, edges }
  }

  recordCoEdit(fileA: string, fileB: string, turn: number): void {
    const [a, b] = fileA < fileB ? [fileA, fileB] : [fileB, fileA]
    this.db.prepare(`
      INSERT INTO co_edits (file_a, file_b, weight, last_turn)
      VALUES (?, ?, 1.0, ?)
      ON CONFLICT(file_a, file_b) DO UPDATE SET
        weight = MIN(weight + 0.5, 5.0),
        last_turn = excluded.last_turn
    `).run(a, b, turn)
  }

  getCoEditNeighbors(filePath: string): Array<{ file: string; weight: number }> {
    return this.db.prepare(`
      SELECT file_b as file, weight FROM co_edits WHERE file_a = ?
      UNION ALL
      SELECT file_a as file, weight FROM co_edits WHERE file_b = ?
    `).all(filePath, filePath) as Array<{ file: string; weight: number }>
  }

  getAccessHeat(filePath: string, decayHalfLifeN = 10): number {
    const rows = this.db.prepare(
      'SELECT accessed_at FROM access_log WHERE file_path = ? ORDER BY rowid DESC LIMIT 20'
    ).all(filePath) as Array<{ accessed_at: string }>
    let heat = 0
    for (let i = 0; i < rows.length; i++) {
      heat += Math.pow(0.5, i / decayHalfLifeN)
    }
    return heat
  }

  /** Get files that depend on the given file (reverse edges: who imports/calls into this file) */
  getReverseDependents(filePath: string): Array<{ file: string; kind: string; weight: number }> {
    return this.db.prepare(`
      SELECT DISTINCT
        substr(e.source_id, 1, instr(e.source_id, ':') - 1) as file,
        e.kind,
        e.weight
      FROM edges e
      WHERE e.target_id GLOB ?
        AND substr(e.source_id, 1, instr(e.source_id, ':') - 1) != ?
    `).all(`${globEscape(filePath)}:*`, filePath) as Array<{ file: string; kind: string; weight: number }>
  }

  /** Get files this file depends on via imports edges (P2-2 出边 API，与入边对称）。
   *  导入边写入格式 target_id = <path>:*:0（240 行），source_id = <path>:<symbol>；
   *  source_id GLOB 前缀匹配该文件全部符号，排除 target 为自身的 self-import 边
   *  （方向与入边相反：排除对象是 target_id 一侧），globEscape 沿
   *  getReverseDependents 的既有约定（370 行）。悬边（target 未索引）保留。 */
  getForwardDependencies(filePath: string): Array<{ file: string; kind: string; weight: number }> {
    return this.db.prepare(`
      SELECT DISTINCT
        substr(e.target_id, 1, instr(e.target_id, ':') - 1) as file,
        e.kind,
        e.weight
      FROM edges e
      WHERE e.kind = 'imports'
        AND e.source_id GLOB ?
        AND substr(e.target_id, 1, instr(e.target_id, ':') - 1) != ?
    `).all(`${globEscape(filePath)}:*`, filePath) as Array<{ file: string; kind: string; weight: number }>
  }

  /** Get test files associated with a source file via tested_by edges */
  getTestsFor(filePath: string): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT substr(e.source_id, 1, instr(e.source_id, ':') - 1) as file
      FROM edges e
      WHERE e.target_id GLOB ? AND e.kind = 'tested_by'
    `).all(`${globEscape(filePath)}:*`) as Array<{ file: string }>
    return rows.map(r => r.file)
  }

  /** Get all indexed file paths */
  getAllFiles(): string[] {
    return (this.db.prepare('SELECT path FROM files').all() as Array<{ path: string }>).map(r => r.path)
  }

  /**
   * P1-2: cheap cold-start probe — whether the files table has any rows.
   * LIMIT 1 探测，避免写工具热路径上每次全表扫（getAllFiles 5k 文件 ≈ 5k 行）。
   */
  hasFiles(): boolean {
    const row = this.db.prepare('SELECT 1 AS one FROM files LIMIT 1').get() as { one: number } | undefined
    return row !== undefined
  }

  /** Insert or update a single edge */
  upsertEdge(sourceId: string, targetId: string, kind: string, weight: number, confidence: EdgeConfidence = 'extracted'): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO edges (source_id, target_id, kind, weight, confidence) VALUES (?, ?, ?, ?, ?)'
    ).run(sourceId, targetId, kind, weight, confidence)
  }

  // ─── Codebase index (module summaries + CLI entries) ────────────────

  upsertModuleSummary(entry: ModuleSummaryEntry): void {
    this.db.prepare(`INSERT OR REPLACE INTO module_summaries (dir_path, summary, key_exports_json, file_count, status, content_hash, verified_at_commit, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(
      entry.dirPath, entry.summary, JSON.stringify(entry.keyExports), entry.fileCount, entry.status, entry.contentHash, entry.verifiedAtCommit ?? null,
    )
  }

  getModuleSummaries(): ModuleSummaryEntry[] {
    const rows = this.db.prepare('SELECT * FROM module_summaries ORDER BY dir_path').all() as Array<Record<string, unknown>>
    return rows.map(r => ({
      dirPath: r.dir_path as string,
      summary: r.summary as string,
      keyExports: JSON.parse(r.key_exports_json as string) as string[],
      fileCount: r.file_count as number,
      status: r.status as string,
      contentHash: r.content_hash as string,
      verifiedAtCommit: (r.verified_at_commit as string | null) ?? undefined,
    }))
  }

  upsertCliEntry(entry: CliEntry): void {
    this.db.prepare(`INSERT OR REPLACE INTO cli_entries (flag, handler, wired, verified_at_commit, source_file)
      VALUES (?, ?, ?, ?, ?)`).run(
      entry.flag, entry.handler, entry.wired ? 1 : 0, entry.verifiedAtCommit ?? null, entry.sourceFile,
    )
  }

  getCliEntries(): CliEntry[] {
    const rows = this.db.prepare('SELECT * FROM cli_entries ORDER BY flag').all() as Array<Record<string, unknown>>
    return rows.map(r => ({
      flag: r.flag as string,
      handler: r.handler as string,
      wired: (r.wired as number) === 1,
      verifiedAtCommit: (r.verified_at_commit as string | null) ?? undefined,
      sourceFile: r.source_file as string,
    }))
  }

  // ─── Physarum persistence ───────────────────────────────────────────

  savePhysarumEdges(edges: PhysarumEdgeState[]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM physarum_edges').run()
      const stmt = this.db.prepare(
        'INSERT INTO physarum_edges (file_a, file_b, weight, flow, consolidated, activation_count, last_activated_turn, direction) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      for (const e of edges) {
        stmt.run(e.fileA, e.fileB, e.weight, e.flow, e.consolidated ? 1 : 0, e.activationCount, e.lastActivatedTurn, e.direction)
      }
    })
    tx()
  }

  loadPhysarumEdges(): PhysarumEdgeState[] {
    const rows = this.db.prepare('SELECT * FROM physarum_edges').all() as Array<Record<string, unknown>>
    return rows.map(r => ({
      fileA: r.file_a as string,
      fileB: r.file_b as string,
      weight: r.weight as number,
      flow: r.flow as number,
      consolidated: (r.consolidated as number) === 1,
      activationCount: r.activation_count as number,
      lastActivatedTurn: r.last_activated_turn as number,
      direction: r.direction as number,
    }))
  }

  recordPhysarumPredictionObservation(observation: PhysarumPredictionObservation): void {
    if (!this._available) return
    try {
      this.db.prepare(`
        INSERT INTO physarum_prediction_observations
          (source_file, predicted_at_turn, predictions_json, observed_file, observed_at_turn, hit_rank, lead_turns)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        observation.sourceFile,
        observation.predictedAtTurn,
        JSON.stringify(observation.predictions),
        observation.observedFile,
        observation.observedAtTurn,
        observation.hitRank,
        observation.leadTurns,
      )
    } catch {
      // Shadow telemetry must never affect tool execution.
    }
  }

  getPhysarumPredictionObservations(limit = 100): PhysarumPredictionObservation[] {
    if (!this._available) return []
    try {
      const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)))
      const rows = this.db.prepare(`
        SELECT * FROM physarum_prediction_observations
        ORDER BY id DESC
        LIMIT ${safeLimit}
      `).all() as Array<Record<string, unknown>>
      return rows.map(r => ({
        sourceFile: r.source_file as string,
        predictedAtTurn: r.predicted_at_turn as number,
        predictions: JSON.parse(r.predictions_json as string) as Array<{ file: string; score: number }>,
        observedFile: r.observed_file as string,
        observedAtTurn: r.observed_at_turn as number,
        hitRank: (r.hit_rank as number | null) ?? null,
        leadTurns: r.lead_turns as number,
      }))
    } catch {
      return []
    }
  }

  // ─── Immune memory persistence ───────────────────────────────────────

  saveImmuneMemories(memories: ImmuneMemory[]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM immune_memory').run()
      const stmt = this.db.prepare(
        'INSERT INTO immune_memory (id, pattern, response_json, affinity_score, hit_count, last_hit, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      for (const m of memories) {
        stmt.run(
          m.id,
          m.pattern,
          JSON.stringify(m.response),
          m.affinityScore,
          m.hitCount,
          m.lastHit,
          m.createdAt,
        )
      }
    })
    tx()
  }

  loadImmuneMemories(): ImmuneMemory[] {
    const rows = this.db.prepare('SELECT * FROM immune_memory').all() as Array<Record<string, unknown>>
    const result: ImmuneMemory[] = []
    for (const r of rows) {
      try {
        const response = JSON.parse(r.response_json as string)
        result.push({
          id: r.id as string,
          pattern: r.pattern as string,
          response,
          affinityScore: r.affinity_score as number,
          hitCount: r.hit_count as number,
          lastHit: r.last_hit as number,
          createdAt: r.created_at as number,
        })
      } catch {
        // Corrupt row — skip, don't fail the whole load
      }
    }
    return result
  }

  // ─── Mistake notebook persistence ────────────────────────────────────

  saveMistakeEntries(entries: MistakeEntry[]): void {
    const insert = this.db.prepare(
      'INSERT INTO mistake_entries (id, timestamp, error, context, resolution, tags_json) VALUES (?, ?, ?, ?, ?, ?)'
    )
    const tx = this.db.transaction((items: MistakeEntry[]) => {
      this.db.prepare('DELETE FROM mistake_entries').run()
      for (const e of items) {
        insert.run(e.id, e.timestamp, e.error, e.context, e.resolution, JSON.stringify(e.tags))
      }
    })
    tx(entries)
  }

  /** Memory-epoch reset: drop all persisted mistake entries (see memory-epoch.ts). */
  clearMistakeEntries(): void {
    this.db.prepare('DELETE FROM mistake_entries').run()
  }

  loadMistakeEntries(): MistakeEntry[] {
    const rows = this.db.prepare('SELECT * FROM mistake_entries').all() as Array<{
      id: string
      timestamp: string
      error: string
      context: string
      resolution: string
      tags_json: string
    }>
    const result: MistakeEntry[] = []
    for (const r of rows) {
      try {
        result.push({
          id: r.id,
          timestamp: r.timestamp,
          error: r.error,
          context: r.context,
          resolution: r.resolution,
          tags: JSON.parse(r.tags_json),
        })
      } catch {
        // Corrupt row — skip, don't fail the whole load
      }
    }
    return result
  }

  // ─── P3 state persistence ───────────────────────────────────────────

  saveToolPatternMinerSnapshot(snapshot: ToolPatternMinerSnapshot): void {
    if (!this._available) return
    this.db.prepare(`
      INSERT INTO p3_state (kind, version, json, updated_at)
      VALUES ('tool_pattern_miner', ?, ?, datetime('now'))
      ON CONFLICT(kind, version) DO UPDATE SET
        json = excluded.json,
        updated_at = excluded.updated_at
    `).run(snapshot.version, JSON.stringify(snapshot))
  }

  loadToolPatternMinerSnapshot(): ToolPatternMinerSnapshot | null {
    if (!this._available) return null
    const row = this.db.prepare(`
      SELECT json FROM p3_state
      WHERE kind = 'tool_pattern_miner' AND version = 1
    `).get() as { json: string } | undefined
    if (!row) return null
    const parsed = JSON.parse(row.json) as ToolPatternMinerSnapshot
    return parsed.version === 1 ? parsed : null
  }

  // ─── T2-02: Bandit state persistence ──────────────────────────────────

  /**
   * Periodic retention cleanup (anti-regression): runs at most once per 24h,
   * tracked in meridian_meta. Idempotent; failures degrade silently — telemetry
   * cleanup never blocks any path.
   */
  private cleanupExpiredRows(): void {
    if (!this._available) return
    try {
      const row = this.db.prepare(`SELECT value FROM meridian_meta WHERE key = 'last_cleanup_at'`).get() as { value: string } | undefined
      const last = row ? Number(row.value) : 0
      if (Number.isFinite(last) && Date.now() - last < CLEANUP_MIN_INTERVAL_MS) return
      purgeExpiredRows(this.db)
      this.db.prepare(`INSERT OR REPLACE INTO meridian_meta (key, value) VALUES ('last_cleanup_at', ?)`).run(String(Date.now()))
    } catch {
      // Non-critical — degrade silently
    }
  }

  saveBanditState(kind: string, json: string): void {
    if (!this._available) return
    try {
      this.db.prepare(`
        INSERT INTO p3_state (kind, version, json, updated_at)
        VALUES (?, 1, ?, datetime('now'))
        ON CONFLICT(kind, version) DO UPDATE SET
          json = excluded.json,
          updated_at = excluded.updated_at
      `).run(kind, json)
    } catch {
      // Bandit persistence is non-critical
    }
  }

  loadBanditState(kind: string): string | null {
    if (!this._available) return null
    try {
      const row = this.db.prepare(`
        SELECT json FROM p3_state
        WHERE kind = ? AND version = 1
      `).get(kind) as { json: string } | undefined
      return row?.json ?? null
    } catch {
      return null
    }
  }

  loadBanditStatesByPrefix(prefix: string, limit = 100): Array<{ kind: string; json: string; updatedAt: string }> {
    if (!this._available) return []
    try {
      const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)))
      // LIKE with a leading-literal pattern can use the PRIMARY KEY(kind, version)
      // prefix scan; substr(kind,1,length(?)) = ? cannot (T2-02 audit: full-table
      // scan on 195k rows). Internal kinds never contain LIKE wildcards.
      return this.db.prepare(`
        SELECT kind, json, updated_at as updatedAt FROM p3_state
        WHERE kind LIKE ?
        ORDER BY updated_at DESC
        LIMIT ${safeLimit}
      `).all(`${prefix}%`) as Array<{ kind: string; json: string; updatedAt: string }>
    } catch {
      return []
    }
  }

  // ─── Sensorimotor ─────────────────────────────────────────────────────

  /**
   * Record a sensorimotor experience: (context, tool, outcome).
   * Gracefully degrades when DB is unavailable.
   */
  recordSensorimotorExperience(
    contextHash: string,
    toolName: string,
    success: boolean,
    durationMs: number,
    turn: number,
  ): void {
    if (!this._available) return
    try {
      this.db.prepare(
        `INSERT INTO sensorimotor_log (context_hash, tool_name, success, duration_ms, turn)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(contextHash, toolName, success ? 1 : 0, durationMs, turn)
    } catch {
      // Non-critical logging — degrade silently
    }
  }

  /**
   * Get the success rate of a tool from recent sensorimotor history.
   * Returns null if no data exists.
   */
  getToolSuccessRate(toolName: string, recentWindow?: number): number | null {
    if (!this._available) return null
    try {
      const limit = recentWindow && recentWindow > 0 ? `LIMIT ${recentWindow}` : ''
      const rows = this.db.prepare(
        `SELECT success FROM sensorimotor_log
         WHERE tool_name = ?
         ORDER BY id DESC
         ${limit}`,
      ).all(toolName) as { success: number }[]
      if (rows.length === 0) return null
      const successes = rows.filter(r => r.success === 1).length
      return successes / rows.length
    } catch {
      return null
    }
  }

  /** Current Meridian schema version (PRAGMA user_version), 0 when unavailable. */
  schemaVersion(): number {
    if (!this._available) return 0
    try {
      return (this.db.pragma('user_version', { simple: true }) as number) ?? 0
    } catch {
      return 0
    }
  }

  close(): void {
    if (this.conn) {
      // Truncate the WAL so the file shrinks back to ~0 on close instead of
      // leaving a multi-hundred-MB -wal behind (observed 376MB). Best-effort —
      // TRUNCATE fails harmlessly under concurrent readers.
      try { this.conn.pragma('wal_checkpoint(TRUNCATE)') } catch { /* best-effort */ }
      this.conn.close(); this.conn = null
    }
  }
}

/** No-op database proxy when better-sqlite3 is unavailable */
function createNullDb(): any {
  const noopStmt = { run: () => ({ changes: 0, lastInsertRowid: 0 }), all: () => [] as any[], get: () => undefined }
  return new Proxy(Object.create(null), {
    get: (_target: any, prop: string) => {
      if (prop === 'prepare') return () => noopStmt
      if (prop === 'exec') return () => {}
      if (prop === 'pragma') return () => {}
      if (prop === 'close') return () => {}
      if (prop === 'transaction') return (fn: any) => fn
      return () => {}
    },
  })
}

/** Current Meridian data schema version (mirrored to PRAGMA user_version). */
const MERIDIAN_SCHEMA_VERSION = 2

/**
 * One-shot migration to schema v1: purge historical dirty rows — absolute-path
 * file rows (written before toRepoRelative fail-closed) and dangling imports edges
 * (written before import resolution). Never blocks DB open (errors swallowed).
 *
 * The user_version guard is load-bearing, not an optimization. The dangling-edge
 * predicate ("target not in files") also matches edges pointing at files that
 * exist on disk but have not been indexed yet — this repo has ~2.6k indexable
 * files against a backfill cap of 2000, so those edges are permanent, and the
 * unchanged source file's content hash keeps needsParse from ever rebuilding
 * them. Running this on every open would scrub real reverse-dependency edges
 * out of the graph that analyzeImpact and the delivery gate read.
 */
function migrateToV1(db: any): void {
  try {
    // Literal `1` on purpose — the guard and the write must both target v1.
    // Referencing MERIDIAN_SCHEMA_VERSION here made v1 migration rerun on
    // higher-version DBs AND stamp user_version straight to the latest number,
    // which swallowed every later migration (v2 never ran: its guard saw 2).
    if (((db.pragma('user_version', { simple: true }) as number) ?? 0) >= 1) return
    const tx = db.transaction(() => {
      // Absolute-path file rows: POSIX '/...' and Windows 'C:\...' / 'C:/...'
      db.prepare("DELETE FROM files WHERE substr(path, 1, 1) = '/' OR (substr(path, 2, 1) = ':' AND path GLOB '[A-Za-z]:*')").run()
      // Symbols of those files share the same absolute-path key
      db.prepare("DELETE FROM symbols WHERE substr(file_path, 1, 1) = '/' OR (substr(file_path, 2, 1) = ':' AND file_path GLOB '[A-Za-z]:*')").run()
      // Dangling imports edges: kind='imports' whose target is not a known file
      db.prepare("DELETE FROM edges WHERE kind = 'imports' AND NOT EXISTS (SELECT 1 FROM files f WHERE edges.target_id = f.path || ':*:0')").run()
      db.pragma('user_version = 1')
    })
    tx()
  } catch {
    // Migration must never block DB open — index still functions on dirty data.
  }
}

/**
 * One-shot migration to schema v2: purge expired telemetry rows — append-only
 * p3_state event kinds (unique-per-write kind strings stamp sessionId+timestamp,
 * so the UPSERT never hits and the table grows without bound), access_log and
 * sensorimotor_log. State kinds (fixed keys: bandit:*, p3:*, team_plan_cache:*,
 * tool_pattern_miner) are whitelisted and preserved. The user_version guard
 * runs this exactly once; cleanupExpiredRows then keeps the window enforced
 * afterwards.
 */
function migrateToV2(db: any): void {
  try {
    // Guard must be the literal 2, not MERIDIAN_SCHEMA_VERSION: when this
    // migration was written the shared-constant guard was already consumed by
    // migrateToV1 (it stamped user_version=2 first), making this body dead
    // code — the VACUUM never ran. If a v3 migration is added later, change
    // this guard to 3 (and keep migrateToV1's at 1).
    if (((db.pragma('user_version', { simple: true }) as number) ?? 0) >= 2) return
    const tx = db.transaction(() => {
      purgeExpiredRows(db)
      db.pragma('user_version = 2')
    })
    tx()
    // One-time cost after the purge: reclaim file holes. Best-effort — a busy
    // DB (concurrent session) or permissions must never block open.
    try {
      db.pragma('wal_checkpoint(TRUNCATE)')
      db.exec('VACUUM')
    } catch { /* best-effort */ }
  } catch {
    // Migration must never block DB open — index still functions on dirty data.
  }
}

/** Delete telemetry rows past their retention window. Idempotent. */
function purgeExpiredRows(db: any): void {
  // Append-only p3_state event rows; state kinds (fixed keys) are whitelisted
  // and preserved: bandit:*, p3:*, team_plan_cache:* (cross-session plan
  // cache) and the fixed tool_pattern_miner snapshot. Underscores are LIKE
  // wildcards, hence ESCAPE — and the old camelCase 'teamPlanCache:%' never
  // matched the real 'team_plan_cache:' keys (underscore is a literal in the
  // value), silently putting the plan cache into the 30-day deletion window.
  db.prepare(`DELETE FROM p3_state
    WHERE updated_at < datetime('now', ?)
      AND kind NOT LIKE 'bandit:%' AND kind NOT LIKE 'p3:%'
      AND kind NOT LIKE 'team\\_plan\\_cache:%' ESCAPE '\\'
      AND kind <> 'tool_pattern_miner'`).run(`-${P3_EVENT_RETENTION_DAYS} days`)
  db.prepare(`DELETE FROM access_log WHERE accessed_at < datetime('now', ?)`).run(`-${LOG_RETENTION_DAYS} days`)
  db.prepare(`DELETE FROM sensorimotor_log WHERE created_at < datetime('now', ?)`).run(`-${LOG_RETENTION_DAYS} days`)
}


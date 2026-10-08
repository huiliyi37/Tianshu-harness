import { readFile, mkdir } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { writeFileAtomicAsync, writeFileAtomicSync } from '../fs-atomic.js'

import type { PheromoneSignal } from '../agent/sensorium.js'

// ─── Types ──────────────────────────────────────────────────────────

export interface PheromoneDeposit {
  path: string
  signal: PheromoneSignal
  strength: number
  context?: string
  /** Custom half-life in ms. Default: 604_800_000 (7 days) */
  halfLifeMs?: number
  /** Task contract ID for structured dead-end matching. Undefined for legacy entries. */
  taskId?: string
}

export interface Pheromone {
  path: string
  signal: PheromoneSignal
  strength: number
  depositedAt: number
  halfLife: number
  context?: string
  /** Task contract ID for structured dead-end matching. Undefined for legacy entries. */
  taskId?: string
}

/** A stored pheromone with its decayed current strength computed. */
export interface PheromoneQueryResult extends Pheromone {
  currentStrength: number
}

// ─── Constants ──────────────────────────────────────────────────────

const DEFAULT_HALF_LIFE_MS = 604_800_000 // 7 days
const DECAY_CONSTANT = 0.693 // ln(2)
const DEFAULT_MAX_CAPACITY = 200
const PRUNE_THRESHOLD = 0.05

// ─── Pure decay function ────────────────────────────────────────────

/**
 * Compute the current (decayed) strength of a pheromone.
 *
 * Follows exponential decay: strength * e^(-λ * elapsed / halfLife)
 * where λ = ln(2) ≈ 0.693.
 *
 * @param initialStrength - The original deposition strength (0–1)
 * @param elapsedMs - Time since deposition
 * @param halfLifeMs - The half-life of this signal
 * @returns Current strength (0–1)
 */
export function computeCurrentStrength(
  initialStrength: number,
  elapsedMs: number,
  halfLifeMs: number,
): number {
  if (halfLifeMs <= 0) return 0
  return initialStrength * Math.exp(-DECAY_CONSTANT * elapsedMs / halfLifeMs)
}

// ─── StigmergyStore ─────────────────────────────────────────────────

/**
 * Session-scoped spatial memory via pheromone deposition.
 *
 * Manages `.rivet/pheromones.json` — a persistent file that
 * accumulates signals about files within a session:
 * - fragile (test failures)
 * - well-tested (test coverage)
 * - entry-point (frequently read)
 * - dead-end (failed approaches)
 * - coupling-hub (high import degree)
 * - performance-critical / refactor-candidate
 *
 * Note: despite file persistence, pheromones are effectively session-scoped.
 * The 7-day half-life decay means signals from prior sessions are near-zero
 * by the next session, and no cross-session coordination reads them.
 *
 * Memory caching: avoids repeated disk reads during tool batches.
 * Deposits are debounced (200ms) to batch rapid writes into one
 * disk flush. On a batch of N tool calls, this reduces I/O from
 * N×(read+write) to 1 read + at most 1 write.
 */
export class StigmergyStore {
  private maxCapacity: number
  /** In-memory cache to avoid repeated disk reads during tool batches. */
  private _cache: Pheromone[] | null = null
  /** True when cache has unsaved mutations. */
  private _dirty = false
  private _revision = 0
  private _inFlight: Promise<void> | null = null
  /** Debounce timer for batched writes. */
  private _flushTimer: ReturnType<typeof setTimeout> | null = null
  /** Debounce interval: batch writes within this window. */
  private readonly _flushDelayMs = 200

  constructor(
    /** 持久化文件路径；undefined = 纯内存模式（批级共享 store，不落盘，
     *  与 PrewarmCache 同生命周期——星河收编 #3）。 */
    private filePath: string | undefined,
    maxCapacity = DEFAULT_MAX_CAPACITY,
  ) {
    this.maxCapacity = maxCapacity
  }

  // ── Internal cache management ────────────────────────────────

  /** Load pheromones from cache or disk. Returns [] if file missing or corrupt. */
  private async _loadFromDisk(): Promise<Pheromone[]> {
    if (!this.filePath) return [] // memory-only mode: no disk
    try {
      const raw = await readFile(this.filePath, 'utf-8')
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (e): e is Pheromone =>
          typeof e === 'object' &&
          e !== null &&
          typeof (e as Pheromone).path === 'string' &&
          typeof (e as Pheromone).signal === 'string' &&
          typeof (e as Pheromone).strength === 'number' &&
          typeof (e as Pheromone).depositedAt === 'number' &&
          typeof (e as Pheromone).halfLife === 'number',
      )
    } catch {
      return []
    }
  }

  /** Get entries — from cache if loaded, otherwise from disk. */
  private async _getEntries(): Promise<Pheromone[]> {
    if (this._cache === null) {
      this._cache = await this._loadFromDisk()
    }
    return this._cache
  }

  /** Mark cache dirty and schedule a debounced flush. */
  private _markDirty(entries: Pheromone[]): void {
    this._cache = entries
    this._dirty = true
    this._revision++
    if (this._flushTimer) clearTimeout(this._flushTimer)
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null
      if (this._dirty && this._cache !== null) {
        void this.flush().catch(() => { /* flush reports failure and retains dirty entries */ })
      }
    }, this._flushDelayMs)
  }

  /** Write entries to disk atomically and clear dirty flag. */
  private async _persist(entries: Pheromone[], revision: number): Promise<void> {
    const filePath = this.filePath
    if (!filePath) { this._dirty = false; return } // memory-only mode: nothing to persist
    const snapshot = JSON.stringify(entries, null, 2)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFileAtomicAsync(filePath, snapshot)
    // 写成功才清 dirty——先清再写的话，EPERM 类失败会静默丢弃 pending
    // 信息素，shutdown 的 flushSync 也失去重试依据。
    if (this._revision === revision) this._dirty = false
  }

  // ── Public API ───────────────────────────────────────────────

  /** Load all pheromones from disk (bypasses cache). */
  async load(): Promise<Pheromone[]> {
    return this._getEntries()
  }

  /** Force-flush any pending writes. Call before process exit or compaction. */
  async flush(): Promise<void> {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer)
      this._flushTimer = null
    }
    while (this._inFlight) await this._inFlight
    if (!this._dirty || this._cache === null) return
    const write = this._persist(this._cache, this._revision)
    this._inFlight = write
    try { await write }
    catch (error) {
      console.error(`[stigmergy] persistence failed (${String(error)}); pending pheromones retained for flush retry`)
      throw error
    } finally { this._inFlight = null }
  }

  /**
   * Synchronous force-flush for the process-exit path, where async work is
   * abandoned by process.exit(). Mirrors _persist() with the sync atomic
   * writer so a deposit landing inside the 200ms debounce window is not lost
   * on Ctrl+C / shutdown. No-op when nothing is pending.
   */
  flushSync(): void {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer)
      this._flushTimer = null
    }
    if (this._dirty && this._cache !== null) {
      if (!this.filePath) { this._dirty = false; return } // memory-only mode: nothing to persist
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileAtomicSync(this.filePath, JSON.stringify(this._cache, null, 2))
      // 与 _persist 同纪律：写成功才清 dirty。
      this._dirty = false
    }
  }

  /** Persist pheromones to disk immediately (bypasses debounce). */
  async save(entries: Pheromone[]): Promise<void> {
    this._markDirty(entries)
    await this.flush()
  }

  /** Force-flush pending writes and invalidate cache (e.g. for cross-session sync). */
  invalidateCache(): void {
    this._cache = null
    this._dirty = false
    if (this._flushTimer) {
      clearTimeout(this._flushTimer)
      this._flushTimer = null
    }
  }

  // ── Core operations ──────────────────────────────────────────

  /**
   * Deposit a new pheromone signal for a file.
   *
   * If a matching entry (same path + signal) exists, it is overwritten
   * with the new strength and timestamp. Otherwise a new entry is appended.
   *
   * After deposition, LRU eviction is applied. Write is debounced.
   */
  async deposit(deposit: PheromoneDeposit): Promise<void> {
    const entries = await this._getEntries()

    const now = Date.now()
    const newEntry: Pheromone = {
      path: deposit.path,
      signal: deposit.signal,
      strength: Math.max(0, Math.min(1, deposit.strength)),
      depositedAt: now,
      halfLife: deposit.halfLifeMs ?? DEFAULT_HALF_LIFE_MS,
      ...(deposit.context ? { context: deposit.context.slice(0, 80) } : {}),
      ...(deposit.taskId ? { taskId: deposit.taskId } : {}),
    }

    // Overwrite existing matching entry (same path + signal)
    const idx = entries.findIndex(
      e => e.path === deposit.path && e.signal === deposit.signal,
    )
    if (idx >= 0) {
      entries[idx] = newEntry
    } else {
      entries.push(newEntry)
    }

    // Enforce capacity (LRU: drop oldest)
    const capped = entries.slice(-this.maxCapacity)

    this._markDirty(capped)
  }

  /**
   * Query pheromones with their decayed current strength.
   *
   * @param path - Optional file path filter. If omitted, returns all entries.
   * @returns Entries with `currentStrength` computed (entries below prune
   *          threshold are NOT excluded — use prune() for cleanup).
   */
  async query(path?: string): Promise<PheromoneQueryResult[]> {
    const entries = await this._getEntries()

    const filtered = path ? entries.filter(e => e.path === path) : entries
    const now = Date.now()

    return filtered.map(e => ({
      ...e,
      currentStrength: computeCurrentStrength(
        e.strength,
        now - e.depositedAt,
        e.halfLife,
      ),
    }))
  }

  /**
   * Remove entries whose decayed current strength falls below
   * the prune threshold (0.05). Persists the result via debounced write.
   */
  async prune(): Promise<void> {
    const entries = await this._getEntries()
    const now = Date.now()

    const kept = entries.filter(e => {
      const cs = computeCurrentStrength(e.strength, now - e.depositedAt, e.halfLife)
      return cs >= PRUNE_THRESHOLD
    })

    if (kept.length < entries.length) {
      this._markDirty(kept)
    }
  }
}

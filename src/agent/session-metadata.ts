/**
 * Session metadata store with in-memory caching and batch-flush cadence.
 *
 * The append hot path updates metadata per message; writing the whole
 * meta.json on every append is a read-modify-write amplification hotspot.
 * Updates stay in memory and ride the transcript batch flush cadence
 * (~200ms), while init/write paths stay synchronously durable.
 */

import { existsSync, readFileSync } from 'node:fs'
import { writeFileAtomicSync, writeFileAtomicAsync, writeFileAtomicDurableAsync } from '../fs-atomic.js'
import type { CompactEvent, SessionMetadata } from '../context/types.js'
import type { FrozenSnapshotData } from '../prompt/frozen-snapshot.js'

export class FrozenSnapshotWriter {
  private writes: Promise<void> = Promise.resolve()
  error?: string
  constructor(private readonly path: () => string) {}
  queue(data: FrozenSnapshotData): void {
    this.writes = this.writes.then(async () => {
      await writeFileAtomicAsync(this.path(), JSON.stringify(data))
      this.error = undefined
    }).catch(() => { this.error = 'snapshot_save_failed' })
  }
  async drain(): Promise<void> { await this.writes }
  async commit(data: FrozenSnapshotData): Promise<void> {
    const write = this.writes.then(async () => {
      await writeFileAtomicDurableAsync(this.path(), JSON.stringify(data))
      this.error = undefined
    })
    this.writes = write.catch(() => { this.error = 'snapshot_save_failed' })
    await write
  }
}

/**
 * 持久化压缩台账的容量上限——与内存账本 SessionContext 的 MAX_CACHE_HISTORY
 * 同值（保留既有上限；两处刻意各自持有常量，避免 agent 层与 context 层的
 * 循环依赖）。
 */
export const MAX_PERSISTED_COMPACT_EVENTS = 500

/**
 * 压缩事件的**完整身份**（幂等键）。
 *
 * 只用 turn+tier 会把同一轮的合法多次压缩合并掉（tier 1 微压缩后紧跟 tier 2
 * 自动压缩是正常形态）；createdAt 是每次记录时刻，重复投递同一事件才命中。
 */
export function compactEventKey(event: CompactEvent): string {
  return [
    event.turn,
    event.tier,
    event.createdAt,
    event.beforeTokens,
    event.afterTokens,
    event.reason,
  ].join('\u0000')
}

/**
 * 幂等追加并保留上限：完整身份已存在 → 原样返回（不追加、不更新 updatedAt）。
 */
export function mergeCompactEvent(existing: readonly CompactEvent[], event: CompactEvent): CompactEvent[] {
  const key = compactEventKey(event)
  if (existing.some(e => compactEventKey(e) === key)) return [...existing]
  const next = [...existing, event]
  return next.length > MAX_PERSISTED_COMPACT_EVENTS
    ? next.slice(-MAX_PERSISTED_COMPACT_EVENTS)
    : next
}

export class SessionMetadataStore {
  /** In-memory cache: null = not loaded, undefined = no file on disk. */
  private cached: SessionMetadata | undefined | null = null
  /** Set when in-memory metadata diverges from disk. */
  private dirty = false

  constructor(private readonly metadataPath: string) {}

  load(): SessionMetadata | undefined {
    if (this.cached !== null) return this.cached
    if (!existsSync(this.metadataPath)) {
      this.cached = undefined
      return undefined
    }
    try {
      this.cached = JSON.parse(readFileSync(this.metadataPath, 'utf-8')) as SessionMetadata
    } catch {
      this.cached = undefined
    }
    return this.cached
  }

  /** Synchronously durable write (initMetadata / external writers). */
  write(metadata: SessionMetadata): void {
    this.cached = metadata
    this.dirty = false
    writeFileAtomicSync(this.metadataPath, JSON.stringify(metadata, null, 2) + '\n')
  }

  /**
   * Upsert fields in memory only. Merge semantics: sessionId/createdAt win
   * from explicit arguments, updatedAt always advances, tokenUsage merges
   * nested instead of replacing. Disk write rides the batch flush cadence.
   */
  update(patch: Partial<SessionMetadata>, sessionId: string): void {
    const existing = this.load()
    const merged: SessionMetadata = {
      compactEvents: existing?.compactEvents ?? [],
      ...existing,
      ...patch,
      // These must win over ...existing/...patch — place them last:
      // - sessionId is authoritative from the caller
      // - createdAt is set once at creation and preserved thereafter
      // - updatedAt always advances to now (the whole point of the field;
      //   spreading ...existing after it would freeze it at creation time)
      sessionId,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      // Preserve nested objects by merging, not replacing
      tokenUsage: existing?.tokenUsage || patch.tokenUsage
        ? { prompt: 0, completion: 0, total: 0, ...existing?.tokenUsage, ...patch.tokenUsage }
        : undefined,
    }
    this.cached = merged
    this.dirty = true
  }

  /** Persist in-memory metadata when dirty (batch-flush cadence). */
  flush(): void {
    if (!this.dirty) return
    try {
      writeFileAtomicSync(this.metadataPath, JSON.stringify(this.cached ?? {}, null, 2) + '\n')
    } catch (err) {
      // Keep dirty so the next batch flush retries — clearing it before the
      // write meant one failed write silently dropped every metadata update
      // since the last successful flush.
      this.dirty = true
      throw err
    }
    this.dirty = false
  }
}

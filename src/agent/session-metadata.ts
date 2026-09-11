/**
 * Session metadata store with in-memory caching and batch-flush cadence.
 *
 * The append hot path updates metadata per message; writing the whole
 * meta.json on every append is a read-modify-write amplification hotspot.
 * Updates stay in memory and ride the transcript batch flush cadence
 * (~200ms), while init/write paths stay synchronously durable.
 */

import { existsSync, readFileSync } from 'node:fs'
import { writeFileAtomicSync } from '../fs-atomic.js'
import type { SessionMetadata } from '../context/types.js'

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

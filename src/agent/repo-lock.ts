/**
 * RepoLock — scoped cross-session mutual exclusion for repo-mutating ops (VSW P3)
 *
 * `git worktree add` / `git worktree remove` mutate the shared `.git/worktrees`
 * registry. When multiple Rivet sessions run in the same repository, two
 * concurrent worktree mutations can corrupt that registry or race on the same
 * VSW path. RepoLock serializes the critical section.
 *
 * Unlike CronLock (a long-lived scheduler singleton with health-check timers),
 * RepoLock is *scoped*: acquire → run a short critical section → release, via
 * `withLock(fn)`. It reuses the same hardening — O_EXCL atomic create,
 * PID-lease liveness, and stale-lock recovery — but adds nothing long-lived.
 *
 * Does NOT modify cron-lock; the PID-liveness logic is re-implemented compactly
 * to keep the agent layer free of a dependency on the server layer.
 *
 * @module repo-lock
 */

import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  statSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { hostname as osHostname } from 'node:os'

export interface RepoLockInfo {
  pid: number
  acquiredAt: string
  acquiredAtMs: number
  hostname: string
  ownerToken: string
}

export interface RepoLockConfig {
  /** Lock file path. */
  lockPath: string
  /** A held lock older than this is considered stale and reclaimable, even if
   *  its PID looks alive (guards against a process that died mid-section on a
   *  foreign host where we cannot probe liveness). Default 30s. */
  staleMs?: number
  /** Backoff between acquire attempts. Default 25ms. */
  retryMs?: number
  /** Max total time to wait for the lock before giving up. Default 10s. */
  maxWaitMs?: number
}

const DEFAULT_STALE_MS = 30_000
const DEFAULT_RETRY_MS = 25
const DEFAULT_MAX_WAIT_MS = 10_000

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

/** PID liveness (excludes zombies on Linux). EPERM → alive (foreign owner). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (errorCode(error) === 'EPERM') return true
    return false
  }
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8')
      const afterComm = stat.slice(stat.lastIndexOf(')') + 1).trimStart()
      if (afterComm[0] === 'Z') return false
    } catch {
      // /proc unavailable → fall through alive.
    }
  }
  return true
}

/** Synchronous sleep without a subprocess (worktree ops are sync/spawnSync). */
function sleepSync(ms: number): void {
  if (ms <= 0) return
  const sab = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(sab, 0, 0, ms)
}

function readLock(path: string): RepoLockInfo | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as RepoLockInfo
  } catch {
    return null
  }
}

type CreateResult = { ok: true } | { ok: false; reason: 'exists' } | { ok: false; reason: 'error'; message: string }

/** Exclusive creation also works on volumes without hard links (e.g. ExFAT).
 * Readers leave incomplete owner records alone until their stale lease expires. */
function createExclusive(path: string, info: RepoLockInfo): CreateResult {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(info), { encoding: 'utf-8', flag: 'wx' })
    return { ok: true }
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return { ok: false, reason: 'exists' }
    return { ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error) }
  }
}

export class RepoLock {
  private readonly lockPath: string
  private readonly staleMs: number
  private readonly retryMs: number
  private readonly maxWaitMs: number
  /** Per-instance owner token: each RepoLock is a distinct holder, so two
   *  instances (even in one process) mutually exclude, while re-entry on the
   *  same instance is treated as ownership. */
  private readonly ownerToken = randomUUID()
  private held = false

  constructor(config: RepoLockConfig) {
    this.lockPath = config.lockPath
    this.staleMs = config.staleMs ?? DEFAULT_STALE_MS
    this.retryMs = config.retryMs ?? DEFAULT_RETRY_MS
    this.maxWaitMs = config.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
  }

  private hostname(): string {
    return osHostname() || 'unknown'
  }

  private buildInfo(): RepoLockInfo {
    return {
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      acquiredAtMs: Date.now(),
      hostname: this.hostname(),
      ownerToken: this.ownerToken,
    }
  }

  private isOwn(info: RepoLockInfo): boolean {
    return info.pid === process.pid
      && info.hostname === this.hostname()
      && info.ownerToken === this.ownerToken
  }

  /** True when an existing lock can be reclaimed: dead owner PID (same host) or
   *  age beyond staleMs. Foreign-host live PIDs are never reclaimed on age=0. */
  private isReclaimable(owner: RepoLockInfo): boolean {
    const ageMs = Date.now() - (owner.acquiredAtMs ?? 0)
    if (ageMs >= this.staleMs) return true
    if (owner.hostname === this.hostname() && !isPidAlive(owner.pid)) return true
    return false
  }

  /** Single non-blocking acquisition attempt. */
  private tryAcquireOnce(): boolean {
    const created = createExclusive(this.lockPath, this.buildInfo())
    if (created.ok) {
      this.held = true
      return true
    }
    if (created.reason === 'error') throw new Error(`RepoLock cannot create ${this.lockPath}: ${created.message}`)

    const owner = readLock(this.lockPath)
    if (!owner) {
      // Another process may have created the file but not finished its write.
      // Only reclaim malformed records after the publication lease expires.
      try {
        if (Date.now() - statSync(this.lockPath).mtimeMs >= this.staleMs) unlinkSync(this.lockPath)
      } catch { /* raced or unreadable: fail closed */ }
      return false
    }
    if (this.isOwn(owner)) {
      this.held = true
      return true
    }
    if (this.isReclaimable(owner)) {
      try { unlinkSync(this.lockPath) } catch { /* another reclaimer won */ }
      const retry = createExclusive(this.lockPath, this.buildInfo())
      if (retry.ok) {
        this.held = true
        return true
      }
    }
    return false
  }

  /** Blocking acquire with backoff up to maxWaitMs. Throws on timeout. */
  acquire(): void {
    const deadline = Date.now() + this.maxWaitMs
    for (;;) {
      if (this.tryAcquireOnce()) return
      if (Date.now() >= deadline) {
        const owner = readLock(this.lockPath)
        throw new Error(
          `RepoLock timeout after ${this.maxWaitMs}ms waiting for ${this.lockPath}`
            + (owner ? ` (held by pid ${owner.pid}@${owner.hostname})` : ''),
        )
      }
      sleepSync(this.retryMs)
    }
  }

  release(): void {
    if (!this.held) return
    try {
      const owner = readLock(this.lockPath)
      if (owner && this.isOwn(owner)) unlinkSync(this.lockPath)
    } catch {
      // best-effort
    }
    this.held = false
  }

  isHeld(): boolean {
    return this.held
  }

  /** Run fn while holding the lock, releasing even on throw. */
  withLock<T>(fn: () => T): T {
    this.acquire()
    try {
      return fn()
    } finally {
      this.release()
    }
  }

  /** Async variant: acquire → try await fn → finally release.
   *  The sync withLock cannot be used with async fns — it would release the
   *  lock before the first await inside fn completes. */
  async withLockAsync<T>(fn: () => Promise<T>): Promise<T> {
    this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}

/** Default VSW worktree-registry lock path for a repo. */
export function worktreeRegistryLockPath(baseCwd: string): string {
  return `${baseCwd}/.rivet/worktree-registry.lock`
}

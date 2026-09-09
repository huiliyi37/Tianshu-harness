import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { appendFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { assertValidSessionId } from '../validation.js'
import {
  createClaimFromProposal,
  isPromptEligibleClaim,
  loadClaimSnapshot,
  checkpointClaims,
  type ClaimProposal,
  type ClaimSnapshot,
  type ContextClaim,
  type ContextClaimStatus,
  type EvidenceRef,
} from './claims.js'
import { claimHasFileEvidence, countClaimsByStatus, evaluatePromotion, canRecallClaim, type ClaimStatusCounts } from './promotion.js'

const MAX_CONSUMERS_PER_CLAIM = 50
const MAX_ACTIVE_CLAIMS = 50
const DEFAULT_CHECKPOINT_EVERY_EVENTS = 500

export type ContextClaimEvent =
  | { type: 'claim_proposed'; eventId: string; createdAt: number; seq?: number; claim: ContextClaim }
  | { type: 'claim_status_changed'; eventId: string; createdAt: number; seq?: number; claimId: string; status: ContextClaimStatus; reason: string }
  | { type: 'claim_used'; eventId: string; createdAt: number; seq?: number; claimId: string; consumerId: string; consumerKind: 'prompt' | 'tool' | 'test' | 'worker' }
  | { type: 'claim_boosted'; eventId: string; createdAt: number; seq?: number; claimId: string; fitness: number }

export interface ContextClaimStoreOptions {
  /** Auto-checkpoint after this many incremental JSONL events. Defaults to 500. */
  checkpointEveryEvents?: number
}

export interface ClaimFilter {
  status?: ContextClaimStatus[]
  kind?: ContextClaim['kind'][]
  scope?: ContextClaim['scope'][]
}

export interface ClaimUseInput {
  consumerId: string
  consumerKind: 'prompt' | 'tool' | 'test' | 'worker'
  usedAt: number
}

export interface ClaimStoreCheckpointResult {
  snapshotPath: string
  claimCount: number
  truncatedPath: string
}

export class ContextClaimStore {
  readonly path: string

  readonly sessionId: string

  private cachedEvents: ContextClaimEvent[] | null = null
  private lastFileSize: number = -1
  private cachedClaims: ContextClaim[] | null = null
  private lastProcessedLineCount: number = 0
  private readonly snapshotPath: string
  // ⚠️ Single-writer assumption: seq is per-instance, not coordinated across processes.
  // If multiple processes append to the same .claims.jsonl concurrently, seq may collide.
  // This is acceptable because claim-store is session-scoped and each session has exactly one writer.
  private nextSeq: number = 1
  private checkpointing = false
  private readonly checkpointEveryEvents?: number

  constructor(dir: string, sessionId: string, options: ContextClaimStoreOptions = {}) {
    assertValidSessionId(sessionId)
    this.sessionId = sessionId
    this.checkpointEveryEvents = options.checkpointEveryEvents ?? DEFAULT_CHECKPOINT_EVERY_EVENTS
    mkdirSync(dir, { recursive: true })
    this.path = join(dir, `${this.sessionId}.claims.jsonl`)
    this.snapshotPath = join(dir, `${this.sessionId}.claims.snapshot.json`)
  }

  get eventCount(): number {
    return this.readEvents().length
  }

  appendEvent(event: ContextClaimEvent): void {
    if (!this.cachedEvents) {
      if (existsSync(this.path)) this.readEvents()
      const checkpointSnapshot = this.loadFromCheckpoint()
      if (checkpointSnapshot) this.nextSeq = Math.max(this.nextSeq, checkpointSnapshot.lastEventSeq + 1)
      // 全新会话无盘可读：事件视图初始化为空——不依赖在途行先落盘。
      if (!this.cachedEvents) this.cachedEvents = []
      if (this.lastFileSize < 0) this.lastFileSize = 0
    }
    const withSeq: ContextClaimEvent = { ...event, seq: event.seq ?? this.nextSeq }
    const line = JSON.stringify(withSeq) + '\n'
    const bytes = Buffer.byteLength(line)
    // 内存同步更新（读路径立即一致）；行入异步写链——同步 appendFileSync 在
    // OneDrive/AV/EDR 栈上可卡分钟级并冻结事件循环（issue #61 族写路径同步
    // IO 治理）。崩溃窗口 = 内存队列的毫秒级。pendingBytes 让 readEvents 的
    // 外部修改检测把「磁盘合法滞后于内存」与「真外部修改」区分开。
    this.pendingLines.push(line)
    this.pendingBytes += bytes
    this.kickWriteChain()
    this.nextSeq = Math.max(this.nextSeq, (withSeq.seq ?? 0) + 1)
    this.cachedEvents.push(withSeq)
    this.lastFileSize += bytes
    if (!this.checkpointing && this.checkpointEveryEvents !== undefined && this.checkpointEveryEvents > 0 && this.cachedEvents !== null && this.cachedEvents.length >= this.checkpointEveryEvents) {
      // checkpoint 排入写链按序执行（快照由内存态派生，不依赖在途行先落盘）。
      this.checkpointQueued = true
      this.kickWriteChain()
    }
  }

  // ── 写链（claims.jsonl 唯一写者）─────────────────────────────────────
  private pendingLines: string[] = []
  /** 在途未写字节数：readEvents 外部修改检测的「磁盘合法滞后」基线。 */
  private pendingBytes = 0
  private writeChain: { running: boolean; again: boolean } = { running: false, again: false }
  private checkpointQueued = false

  private kickWriteChain(): void {
    if (this.writeChain.running) {
      this.writeChain.again = true
      return
    }
    queueMicrotask(() => {
      if (this.writeChain.running) return
      this.writeChain.running = true
      void this.runWriteChain()
    })
  }

  private async runWriteChain(): Promise<void> {
    try {
      for (;;) {
        this.writeChain.again = false
        const lines = this.pendingLines
        const wantCheckpoint = this.checkpointQueued
        this.checkpointQueued = false
        if (lines.length === 0 && !wantCheckpoint) break
        if (lines.length > 0) {
          this.pendingLines = []
          const text = lines.join('')
          try {
            await appendFile(this.path, text, 'utf-8')
            this.pendingBytes -= Buffer.byteLength(text)
          } catch {
            this.pendingLines = [...lines, ...this.pendingLines]
            await new Promise((r) => setTimeout(r, 250))
            continue
          }
        }
        if (wantCheckpoint) await this.checkpointOnChain()
        if (!this.writeChain.again && this.pendingLines.length === 0 && !this.checkpointQueued) break
      }
    } finally {
      this.writeChain.running = false
      this.writeChain.again = false
      if (this.pendingLines.length > 0 || this.checkpointQueued) this.kickWriteChain()
    }
  }

  /** checkpoint 的链内异步版：快照由内存态派生（cachedEvents/cachedClaims 在
   *  appendEvent 时同步更新），文件写全部异步，截断与后续 append 由链保序。 */
  private async checkpointOnChain(now = Date.now()): Promise<void> {
    this.checkpointing = true
    try {
      const snapshot = checkpointClaims(this.listClaims(), now, this.maxEventSeq(this.readEvents()))
      const tmpSnapshot = `${this.snapshotPath}.tmp`
      await writeFile(tmpSnapshot, JSON.stringify(snapshot, null, 2) + '\n', 'utf-8')
      await rename(tmpSnapshot, this.snapshotPath)
      const tmpLog = `${this.path}.tmp`
      await writeFile(tmpLog, '', 'utf-8')
      await rename(tmpLog, this.path)
      this.cachedEvents = []
      this.cachedClaims = loadClaimSnapshot(snapshot, now)
      this.lastProcessedLineCount = 0
      this.lastFileSize = 0
      this.pendingBytes = 0 // 截断点在链尾——在途行已落盘，滞后基线归零
    } finally {
      this.checkpointing = false
    }
  }

  /** 等写链排空（测试/收口用）。 */
  async flushWrites(timeoutMs = 10_000): Promise<void> {
    this.kickWriteChain()
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (!this.writeChain.running && this.pendingLines.length === 0 && !this.checkpointQueued) return
      if (Date.now() > deadline) return
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  propose(proposal: ClaimProposal): ContextClaim {
    const claim = createClaimFromProposal(proposal)
    const existing = this.listClaims().find(current => current.id === claim.id)
    if (existing) return existing

    this.appendEvent({
      type: 'claim_proposed',
      eventId: `${proposal.source.eventId}:claim:${claim.id}`,
      createdAt: proposal.createdAt,
      claim,
    })
    // Evict excess active claims after proposing new one
    this.evictExcessActiveClaims()
    return claim
  }

  updateClaimStatus(id: string, status: ContextClaimStatus, reason: string): ContextClaim | null {
    const current = this.listClaims().find(claim => claim.id === id)
    if (!current) return null

    this.appendEvent({
      type: 'claim_status_changed',
      eventId: `${id}:status:${status}:${Date.now()}`,
      createdAt: Date.now(),
      claimId: id,
      status,
      reason,
    })

    return this.listClaims().find(claim => claim.id === id) ?? null
  }

  recordClaimUsed(id: string, input: ClaimUseInput): ContextClaim | null {
    const current = this.listClaims().find(claim => claim.id === id)
    if (!current) return null

    this.appendEvent({
      type: 'claim_used',
      eventId: `${id}:used:${input.consumerId}:${input.usedAt}`,
      createdAt: input.usedAt,
      claimId: id,
      consumerId: input.consumerId,
      consumerKind: input.consumerKind,
    })

    return this.listClaims().find(claim => claim.id === id) ?? null
  }

  boostFitness(id: string, delta: number, cap: number): ContextClaim | null {
    const claim = this.listClaims().find(c => c.id === id)
    if (!claim) return null
    const newFitness = Math.min(claim.fitness + delta, cap)
    this.appendEvent({
      type: 'claim_boosted',
      eventId: `${id}:boost:${Date.now()}`,
      createdAt: Date.now(),
      claimId: id,
      fitness: newFitness,
    })
    return { ...claim, fitness: newFitness }
  }

  listClaims(filter: ClaimFilter = {}): ContextClaim[] {
    return this.projectClaims().filter(claim => {
      if (filter.status && !filter.status.includes(claim.status)) return false
      if (filter.kind && !filter.kind.includes(claim.kind)) return false
      if (filter.scope && !filter.scope.includes(claim.scope)) return false
      return true
    })
  }

  listActiveClaims(now = Date.now()): ContextClaim[] {
    return this.listClaims().filter(claim => isPromptEligibleClaim(claim, now))
  }

  listClaimsByFileEvidence(path: string): ContextClaim[] {
    return this.listClaims().filter(claim => claimHasFileEvidence(claim, path))
  }

  getStatusCounts(): ClaimStatusCounts {
    return countClaimsByStatus(this.listClaims())
  }

  markClaimsStaleForFile(path: string, reason: string): ContextClaim[] {
    const changed: ContextClaim[] = []
    for (const claim of this.listClaimsByFileEvidence(path)) {
      if (claim.status === 'stale' || claim.status === 'quarantined') continue
      const updated = this.updateClaimStatus(claim.id, 'stale', reason)
      if (updated) changed.push(updated)
    }
    return changed
  }

  promoteEligibleClaims(now = Date.now(), cwd?: string): ContextClaim[] {
    const promoted: ContextClaim[] = []
    for (const claim of this.listClaims()) {
      const next = evaluatePromotion(claim, now)
      if (!next) continue

      // Recall-gate (NREM consolidation): verify evidence files still exist
      // before promoting. If evidence is irrecoverable, mark stale and skip.
      if (!canRecallClaim(claim, cwd)) {
        this.updateClaimStatus(claim.id, 'stale', 'recall-gate: evidence files no longer exist')
        continue
      }

      const updated = this.updateClaimStatus(claim.id, next, 'promotion threshold met')
      if (updated) promoted.push(updated)
    }
    // Evict excess active claims (cap at MAX_ACTIVE_CLAIMS)
    this.evictExcessActiveClaims()
    return promoted
  }

  private evictExcessActiveClaims(): void {
    // Only evict active/durable_candidate — durable claims are terminal and must not be evicted
    const evictable = this.listActiveClaims().filter(c => c.status !== 'durable')
    if (evictable.length <= MAX_ACTIVE_CLAIMS) return
    // Evict oldest (lowest createdAt) excess claims
    const toEvict = [...evictable]
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, evictable.length - MAX_ACTIVE_CLAIMS)
    for (const claim of toEvict) {
      this.updateClaimStatus(claim.id, 'stale', 'evicted-overflow')
    }
  }

  exportSession(): string {
    const disk = existsSync(this.path) ? readFileSync(this.path, 'utf-8') : ''
    // 在途未写行同属本会话事件流——导出必须包含（write-behind 后磁盘合法滞后）。
    return disk + this.pendingLines.join('')
  }

  /**
   * Checkpoint: write current claims state as a snapshot, then truncate JSONL.
   * Follows Redis 7.0 Base+Incr pattern:
   * - Snapshot = full projected state (base)
   * - JSONL = incremental events after snapshot (incr)
   * - Load = read snapshot + replay incr events
   */
  checkpoint(now = Date.now()): ClaimStoreCheckpointResult {
    // 写链兼容（2026-09-06 write-behind）：同步调用点（测试/管理路径）上链
    // 尚未经 queueMicrotask 启动——先把滞留行同步排空再快照截断，语义与旧
    // 同步版完全一致。链在跑时（生产异步上下文）改走链内排队，结果按当前
    // 内存态即算（快照内容一致，文件随后由链收尾）。
    if (this.writeChain.running) {
      this.checkpointQueued = true
      this.kickWriteChain()
      const snapshot = checkpointClaims(this.listClaims(), now, this.maxEventSeq(this.readEvents()))
      return { snapshotPath: this.snapshotPath, claimCount: snapshot.claims.length, truncatedPath: this.path }
    }
    if (this.pendingLines.length > 0) {
      try {
        appendFileSync(this.path, this.pendingLines.join(''), 'utf-8')
        this.pendingLines = []
        this.pendingBytes = 0
      } catch { /* 滞留行交给链重试 */ }
    }
    this.checkpointing = true
    try {
      const snapshot = checkpointClaims(this.listClaims(), now, this.maxEventSeq(this.readEvents()))
      writeFileAtomicSync(this.snapshotPath, JSON.stringify(snapshot, null, 2) + '\n')

      // Truncate JSONL — start fresh incremental log.
      writeFileAtomicSync(this.path, '')

      // Keep the projected snapshot in memory so the current store remains usable.
      this.cachedEvents = []
      this.cachedClaims = loadClaimSnapshot(snapshot, now)
      this.lastProcessedLineCount = 0
      this.lastFileSize = 0

      return { snapshotPath: this.snapshotPath, claimCount: snapshot.claims.length, truncatedPath: this.path }
    } finally {
      this.checkpointing = false
    }
  }

  /**
   * Load claims from checkpoint snapshot. Incremental JSONL events are replayed
   * by projectClaims() after this base state is loaded.
   */
  private loadFromCheckpoint(now = Date.now()): { claims: ContextClaim[]; lastEventSeq: number } | null {
    if (!existsSync(this.snapshotPath)) return null

    try {
      const raw = readFileSync(this.snapshotPath, 'utf-8')
      const snapshot = JSON.parse(raw) as ClaimSnapshot
      return {
        claims: loadClaimSnapshot(snapshot, now),
        // Old snapshots predate watermarks and were always paired with a
        // truncated JSONL in production. Treat them as base state only.
        lastEventSeq: snapshot.lastEventSeq ?? 0,
      }
    } catch {
      return null
    }
  }

  /** Delete checkpoint snapshot file (for testing or cleanup). */
  deleteCheckpoint(): void {
    if (existsSync(this.snapshotPath)) {
      unlinkSync(this.snapshotPath)
    }
  }

  static loadDurableClaims(dir: string, sessionId: string): ContextClaim[] {
    if (!existsSync(join(dir, `${sessionId}.claims.jsonl`)) && !existsSync(join(dir, `${sessionId}.claims.snapshot.json`))) return []
    const store = new ContextClaimStore(dir, sessionId)
    return store.listClaims().filter(c => c.status === 'durable')
  }

  private readEvents(): ContextClaimEvent[] {
    if (this.cachedEvents) {
      if (!existsSync(this.path)) {
        // 全新会话（全量在途未写）= 一致，返回内存事件流；曾有落盘却被外部
        // 删除 = 保持旧语义返回空。
        return this.lastFileSize === this.pendingBytes ? this.cachedEvents : []
      }
      // Check if file was externally modified by comparing byte size.
      // write-behind 后磁盘合法滞后于内存——已落盘字节 = lastFileSize − 在途，
      // 只有磁盘 ≠ 已落盘字节才是真外部修改。
      const size = statSync(this.path).size
      if (size === this.lastFileSize - this.pendingBytes) return this.cachedEvents
    } else if (!existsSync(this.path)) {
      return []
    }
    const content = readFileSync(this.path, 'utf-8')
    this.lastFileSize = Buffer.byteLength(content)
    const events = content
      .split('\n')
      .filter(line => line.trim().length > 0)
      .flatMap(line => {
        try {
          return [JSON.parse(line) as ContextClaimEvent]
        } catch {
          return []
        }
      })
    this.cachedEvents = events
    this.nextSeq = Math.max(1, this.maxEventSeq(events) + 1)
    return events
  }

  private maxEventSeq(events: readonly ContextClaimEvent[]): number {
    return events.reduce((max, event, index) => Math.max(max, event.seq ?? index + 1), 0)
  }

  private projectClaims(): ContextClaim[] {
    const events = this.readEvents()

    if (this.cachedClaims && this.lastProcessedLineCount === events.length) {
      return this.cachedClaims
    }

    if (this.cachedClaims && this.lastProcessedLineCount < events.length) {
      const newEvents = events.slice(this.lastProcessedLineCount)
      const map = new Map(this.cachedClaims.map(c => [c.id, c]))
      this.applyEventsToMap(map, newEvents)
      this.cachedClaims = [...map.values()]
      this.lastProcessedLineCount = events.length
      return this.cachedClaims
    }

    // Try loading from checkpoint snapshot first
    const checkpointSnapshot = this.loadFromCheckpoint()
    if (checkpointSnapshot) {
      const claims = new Map(checkpointSnapshot.claims.map(c => [c.id, c]))
      this.nextSeq = Math.max(this.nextSeq, checkpointSnapshot.lastEventSeq + 1, this.maxEventSeq(events) + 1)
      // Replay only events newer than the snapshot watermark. This makes the
      // snapshot-write-before-jsonl-truncate crash window safe.
      const replayEvents = events.filter((event, index) => (event.seq ?? index + 1) > checkpointSnapshot.lastEventSeq)
      this.applyEventsToMap(claims, replayEvents)
      this.cachedClaims = [...claims.values()]
      this.lastProcessedLineCount = events.length
      return this.cachedClaims
    }

    // Full rebuild from events
    const claims = new Map<string, ContextClaim>()
    this.applyEventsToMap(claims, events)
    this.cachedClaims = [...claims.values()]
    this.lastProcessedLineCount = events.length
    return this.cachedClaims
  }

  private applyEventsToMap(claims: Map<string, ContextClaim>, events: ContextClaimEvent[]): void {
    for (const event of events) {
      if (event.type === 'claim_proposed') {
        if (!claims.has(event.claim.id)) {
          claims.set(event.claim.id, event.claim)
        }
        continue
      }

      if (event.type === 'claim_status_changed') {
        const claim = claims.get(event.claimId)
        if (!claim) continue
        const counterevidence: EvidenceRef[] = event.status === 'active'
          ? claim.counterevidence
          : [...claim.counterevidence, {
              id: event.eventId,
              kind: 'tool_result',
              summary: event.reason,
              createdAt: event.createdAt,
            }]
        claims.set(event.claimId, { ...claim, status: event.status, counterevidence })
        continue
      }

      if (event.type === 'claim_used') {
        const claim = claims.get(event.claimId)
        if (!claim) continue
        const newConsumers = [...claim.consumers, {
          id: event.consumerId,
          kind: event.consumerKind,
          usedAt: event.createdAt,
        }]
        // Cap consumers array — keep most recent
        const cappedConsumers = newConsumers.length > MAX_CONSUMERS_PER_CLAIM
          ? newConsumers.slice(-MAX_CONSUMERS_PER_CLAIM)
          : newConsumers
        claims.set(event.claimId, {
          ...claim,
          lastUsedAt: event.createdAt,
          consumers: cappedConsumers,
        })
        continue
      }

      if (event.type === 'claim_boosted') {
        const claim = claims.get(event.claimId)
        if (!claim) continue
        claims.set(event.claimId, { ...claim, fitness: event.fitness })
        continue
      }
    }
  }
}

/**
 * File-backed durable store for desktop sessions (N1).
 *
 * Layout (one dir per session):
 *   <baseDir>/<id>/index.json         — latest SessionRecord snapshot
 *   <baseDir>/<id>/events.jsonl       — append-only event log (one JSON per line)
 *   <baseDir>/<id>/events.index.jsonl — sparse seq→byte-offset index (cold-path
 *                                       pagination; missing/corrupt → rebuilt)
 *
 * Robustness contract (asserted by tests):
 *  - A corrupt/partial trailing line in events.jsonl is dropped, never throws.
 *  - A missing/corrupt index.json is reconstructed from the event tail.
 *  - seq never regresses: events are sorted and the max seq wins.
 *  - The sparse index is advisory only: any validation failure falls back to a
 *    full-log scan that rewrites the index (self-healing, one-time cost).
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { appendFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import { join } from 'node:path'
import { cpuPool } from '../workers/cpu-pool.js'
import { parseEventsJsonlRaw, parseEventsTailRaw } from '../workers/cpu-tasks.js'
import type {
  EventsTail,
  PersistedSession,
  SessionEvent,
  SessionPersistenceAdapter,
  SessionRecord,
} from './session-manager.js'

export class FileSessionPersistence implements SessionPersistenceAdapter {
  constructor(
    private readonly baseDir: string,
    private readonly opts: { maxEventsDiskBytes?: number } = {},
  ) {}

  /** Per-session event write buffer — batches high-frequency appendFileSync
   *  (streaming deltas can fire hundreds per turn) into one disk write per
   *  FLUSH_INTERVAL_MS. Critical events (CRITICAL_TYPES) flush their session's
   *  buffer immediately so a host-process crash can never lose them — closing
   *  the 100ms window that used to swallow the tail (e.g. a tool_result whose
   *  loss later resurfaces as "session interrupted, tool result lost"). The
   *  flush is one batched write() (not fsync); the threat model is process
   *  death, where page-cache contents survive. */
  private eventBuffers = new Map<string, BufferedLine[]>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  /** Per-session deferred-trim in-flight guard: one queued trim per session
   *  (flush 热路径只入队，裁剪在 setImmediate 中执行——见 deferTrim）。 */
  private pendingTrims = new Set<string>()
  private static readonly FLUSH_INTERVAL_MS = 100
  private static readonly FLUSH_MAX_LINES = 50
  /** 稀疏索引间距：每 ≥N 个事件在 events.index.jsonl 记一条 {seq, offset}。
   *  进程重启会丢失"距上一条目多少事件"的计数（归零重数），只会拉大间距——
   *  读路径唯一依赖的不变量是「相邻条目间 ≥ N 个事件」，间距变大不破坏正确性。 */
  private static readonly INDEX_INTERVAL = 500
  /** 单条区间读的 parse 走 cpuPool 的阈值（与 loadEventsAsync 同源策略）。 */
  private static readonly INLINE_PARSE_MAX_BYTES = 256 * 1024
  /** Per-session sparse-index write tracker（进程内状态；重启后 lazily 重建）。 */
  private indexTracks = new Map<string, IndexTrack>()
  /** Hard cap per event JSON line — guard against runaway payloads (plan_draft
   *  content, large tool results) silently bloating events.jsonl. Exceeding
   *  events are replaced with a truncated stub that preserves seq/ts/type for
   *  recovery diagnostics. */
  private static readonly MAX_EVENT_JSON_BYTES = 1_000_000 // 1 MB
  /** Default whole-file disk cap (overridable via constructor / runtime.lean). */
  private static readonly DEFAULT_MAX_EVENTS_DISK_BYTES = 50 * 1024 * 1024
  /** Events that must be on disk the moment they are appended. Delta/phase
   *  chatter stays on the debounce timer. */
  private static readonly CRITICAL_TYPES: ReadonlySet<string> = new Set([
    'user', 'tool_result', 'status', 'error', 'done',
    'approval_required', 'approval_resolved', 'unattended_halt',
    // Domain record snapshots are saved synchronously with these events. Flush
    // both immediately so a crash cannot restore metadata without its timeline.
    'domain_resolved', 'domain_changed',
    // Plan Mode draft invalidation — desktop "起草中" should not wait on the
    // 100ms debounce timer after a successful write_file/edit_file.
    'plan_draft',
  ])

  private maxEventsDiskBytes(): number {
    return this.opts.maxEventsDiskBytes ?? FileSessionPersistence.DEFAULT_MAX_EVENTS_DISK_BYTES
  }

  private dir(id: string): string {
    return join(this.baseDir, sanitize(id))
  }

  private ensureDir(id: string): string {
    const d = this.dir(id)
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
    return d
  }

  /** index.json 的写链状态：latest-wins 合并（中间态无需落盘），单对象状态机。 */
  private recordWrites = new Map<string, { latest: SessionRecord; dirty: boolean; running: boolean }>()

  saveRecord(record: SessionRecord): void {
    // 2026-09-06 write-behind（issue #61 族）：writeFileSync+renameSync 同步写
    // 在 OneDrive/AV 栈上同样冻结事件循环。改 latest-wins 异步链：只保证最新
    // 快照最终落盘（中间态合并），同步读路径由 flushSync 的同步排空兜底。
    let st = this.recordWrites.get(record.id)
    if (!st) {
      st = { latest: record, dirty: true, running: false }
      this.recordWrites.set(record.id, st)
    } else {
      st.latest = record
      st.dirty = true
    }
    if (st.running) return
    queueMicrotask(() => {
      if (st.running) return
      st.running = true
      void (async () => {
        try {
          while (st.dirty) {
            st.dirty = false
            const snapshot = st.latest
            const d = this.dir(record.id)
            try {
              await mkdir(d, { recursive: true })
              const tmp = join(d, 'index.json.tmp')
              const final = join(d, 'index.json')
              await writeFile(tmp, JSON.stringify(snapshot), 'utf8')
              await rename(tmp, final)
            } catch {
              st.dirty = true // 失败重试（退避防热循环）
              await new Promise((r) => setTimeout(r, 250))
            }
          }
        } finally {
          st.running = false
          if (st.dirty) this.saveRecord(st.latest)
          else this.recordWrites.delete(record.id)
        }
      })()
    })
  }

  /** record 写链同步排空（flushSync 用）：链未启动且有脏快照时同步写。 */
  private flushRecordSync(id: string): void {
    const st = this.recordWrites.get(id)
    if (!st || st.running || !st.dirty) {
      if (st && !st.dirty && !st.running) this.recordWrites.delete(id)
      return
    }
    const d = this.ensureDir(id)
    try {
      const tmp = join(d, 'index.json.tmp')
      const final = join(d, 'index.json')
      writeFileSync(tmp, JSON.stringify(st.latest), 'utf8')
      renameSync(tmp, final)
      st.dirty = false
      this.recordWrites.delete(id)
    } catch { /* best-effort：留在队列里下轮重试 */ }
  }

  appendEvent(sessionId: string, event: SessionEvent): void {
    let line = JSON.stringify(event) + '\n'

    // Safety ceiling: truncate oversized events instead of letting a single
    // runaway payload (e.g. 200KB plan_draft content) silently corrupt the
    // session log. The stub preserves seq/ts/type for recovery diagnostics.
    if (line.length > FileSessionPersistence.MAX_EVENT_JSON_BYTES) {
      line = JSON.stringify({
        seq: event.seq,
        ts: event.ts,
        type: event.type,
        data: { _truncated: true, _originalBytes: line.length },
      }) + '\n'
    }

    // Buffer the line — the per-session write chain drains it asynchronously.
    let buf = this.eventBuffers.get(sessionId)
    if (!buf) {
      buf = []
      this.eventBuffers.set(sessionId, buf)
    }
    buf.push({ line, seq: event.seq })
    // 2026-09-06 write-behind（issue #61 族）：CRITICAL 类型的「立即落盘」从
    // 同步 appendFileSync 改为异步写链——同步写在 OneDrive/AV/EDR 存储栈上可
    // 卡分钟级并冻结事件循环（所有 setTimeout 界定随之失效），写工具结果
    // 回传挂起即此机制。写链在 microtask 启动（同步调用方的 flushSync 仍可在
    // 链启动前完成同步排空——确定性兼容语义），崩溃窗口 = 内存队列的毫秒级。
    if (
      FileSessionPersistence.CRITICAL_TYPES.has(event.type) ||
      buf.length >= FileSessionPersistence.FLUSH_MAX_LINES
    ) {
      this.kickWriteChain(sessionId)
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushAll(), FileSessionPersistence.FLUSH_INTERVAL_MS)
      this.flushTimer.unref?.()
    }
  }

  // ── 每会话异步写链（events.jsonl 唯一写者）────────────────────────────
  // 同一时刻同一会话只有一条链在跑；新事件在链运行期间置 again 续跑。链内
  // 依次完成：追加事件批 → 推进稀疏索引 → 执行排队裁剪。读路径的同步
  // flushSession 兼容垫片只在链未启动时同步排空（启动/首开等空闲路径），
  // 与链不存在双写竞态。
  private writeChains = new Map<string, { running: boolean; again: boolean }>()
  private pendingChainTrims = new Set<string>()

  private kickWriteChain(sessionId: string): void {
    const st = this.writeChains.get(sessionId) ?? { running: false, again: false }
    this.writeChains.set(sessionId, st)
    if (st.running) {
      st.again = true
      return
    }
    queueMicrotask(() => {
      const cur = this.writeChains.get(sessionId)
      if (!cur || cur.running) return
      cur.running = true
      void this.runWriteChain(sessionId, cur)
    })
  }

  private async runWriteChain(sessionId: string, st: { running: boolean; again: boolean }): Promise<void> {
    try {
      for (;;) {
        st.again = false
        const buf = this.eventBuffers.get(sessionId) ?? []
        const wantTrim = this.pendingChainTrims.delete(sessionId)
        if (buf.length === 0 && !wantTrim) break
        const d = this.dir(sessionId)
        if (buf.length > 0) {
          this.eventBuffers.set(sessionId, [])
          const text = buf.map((b) => b.line).join('')
          try {
            await mkdir(d, { recursive: true })
            await appendFile(join(d, 'events.jsonl'), text, { encoding: 'utf8', mode: 0o600 })
          } catch {
            // 失败重排队首 + 退避（持续失败不热循环；行不丢）。
            this.eventBuffers.set(sessionId, [...buf, ...(this.eventBuffers.get(sessionId) ?? [])])
            await new Promise((r) => setTimeout(r, 250))
            continue
          }
          try {
            await this.advanceSparseIndexAsync(sessionId, d, buf)
          } catch {
            this.indexTracks.delete(sessionId)
          }
          // 追加后评估磁盘上限：超限则排队链内 trim（下一轮迭代按序执行）。
          this.deferTrim(sessionId, d)
        }
        if (wantTrim) {
          this.pendingTrims.delete(sessionId)
          try { this.trimEventsFileIfNeeded(sessionId, d) } catch { /* best-effort */ }
        }
        if (!st.again && (this.eventBuffers.get(sessionId)?.length ?? 0) === 0 && !this.pendingChainTrims.has(sessionId)) break
      }
    } finally {
      st.running = false
      st.again = false
      // finally 期间到达的新行补一轮。
      if ((this.eventBuffers.get(sessionId)?.length ?? 0) > 0 || this.pendingChainTrims.has(sessionId)) {
        this.kickWriteChain(sessionId)
      }
    }
  }

  /** 等该会话写链排空（async 读路径/关前收口用）。有界轮询。 */
  async flushSessionAsync(sessionId: string, timeoutMs = 30_000): Promise<void> {
    this.kickWriteChain(sessionId)
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const st = this.writeChains.get(sessionId)
      const pending = (this.eventBuffers.get(sessionId)?.length ?? 0) > 0 || this.pendingChainTrims.has(sessionId)
      if ((!st || !st.running) && !pending) return
      if (Date.now() > deadline) return
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  /** 等全部会话写链排空（测试/shutdown 收口用）。 */
  async flushAllAsync(timeoutMs = 30_000): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    for (const id of this.eventBuffers.keys()) this.kickWriteChain(id)
    const deadline = Date.now() + timeoutMs
    for (;;) {
      let anyRunning = false
      for (const [id, st] of this.writeChains) {
        if (st.running || (this.eventBuffers.get(id)?.length ?? 0) > 0) { anyRunning = true; break }
      }
      if (!anyRunning) {
        for (const st of this.recordWrites.values()) {
          if (st.running || st.dirty) { anyRunning = true; break }
        }
      }
      if (!anyRunning && this.pendingChainTrims.size === 0) return
      if (Date.now() > deadline) return
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  /** Flush a single session's buffered events to disk immediately.
   *
   *  兼容垫片（2026-09-06 write-behind 后）：正常路径写入全走异步写链——
   *  本方法只在「链未启动且仍有滞留行」时同步排空（appendEvent 的
   *  queueMicrotask 尚未执行的同步上下文，如 loadAll/测试的即时断言），
   *  或显式被 flushSync 调用。链在跑时双写会乱序，故链激活时直接放行
   *  （同步读路径全是启动/首开等空闲场景，链必然不在跑）。 */
  private flushSession(sessionId: string, immediateTrim = false): void {
    const st = this.writeChains.get(sessionId)
    if (st?.running) return
    const buf = this.eventBuffers.get(sessionId)
    if (!buf || buf.length === 0) {
      if (immediateTrim && this.pendingChainTrims.delete(sessionId)) {
        this.pendingTrims.delete(sessionId)
        try { this.trimEventsFileIfNeeded(sessionId) } catch { /* best-effort */ }
      }
      return
    }
    this.eventBuffers.set(sessionId, [])
    let d: string
    try {
      d = this.ensureDir(sessionId)
      appendFileSync(join(d, 'events.jsonl'), buf.map((b) => b.line).join(''), { encoding: 'utf8', mode: 0o600 })
    } catch {
      // Re-queue on failure — better to retry than lose events.
      const existing = this.eventBuffers.get(sessionId) ?? []
      this.eventBuffers.set(sessionId, [...buf, ...existing])
      return
    }
    // 稀疏索引推进（best-effort，绝不影响事件落盘的成功路径）。
    try {
      this.advanceSparseIndex(sessionId, d, buf)
    } catch {
      // 索引是纯加速层——写失败下次读走全量重建。
      this.indexTracks.delete(sessionId)
    }
    // Bound unbounded append-only growth: keep the tail under the disk cap.
    // 裁剪从 flush 热路径移出：常规 flush 入队到写链按序执行，只有关闭路径
    // （flushSync）同步裁——读前/关前保证磁盘已收敛。
    try {
      if (immediateTrim) {
        this.pendingChainTrims.delete(sessionId)
        this.pendingTrims.delete(sessionId)
        this.trimEventsFileIfNeeded(sessionId, d)
      } else {
        this.deferTrim(sessionId, d)
      }
    } catch {
      /* best-effort */
    }
  }

  /** 写链内的稀疏索引推进：与同步版同逻辑，异步 stat/append。 */
  private async advanceSparseIndexAsync(sessionId: string, dir: string, batch: BufferedLine[]): Promise<void> {
    let track = this.indexTracks.get(sessionId)
    if (!track) {
      let fileBytes = 0
      try { fileBytes = statSync(join(dir, 'events.jsonl')).size } catch { fileBytes = 0 }
      const batchBytes = batch.reduce((n, b) => n + Buffer.byteLength(b.line, 'utf8'), 0)
      const preBytes = Math.max(0, fileBytes - batchBytes)
      track = {
        bytes: preBytes,
        sinceEntry: preBytes === 0 ? FileSessionPersistence.INDEX_INTERVAL : 0,
      }
      this.indexTracks.set(sessionId, track)
    }
    const entryLines: string[] = []
    for (const b of batch) {
      track.sinceEntry++
      if (track.sinceEntry > FileSessionPersistence.INDEX_INTERVAL) {
        entryLines.push(JSON.stringify({ seq: b.seq, offset: track.bytes }))
        track.sinceEntry = 1
      }
      track.bytes += Buffer.byteLength(b.line, 'utf8')
    }
    if (entryLines.length > 0) {
      await appendFile(join(dir, 'events.index.jsonl'), entryLines.join('\n') + '\n', 'utf8')
    }
  }

  /** 裁剪排入写链按序执行（同一时刻写链是唯一写者——setImmediate 直裁会与
   *  链内 append 竞争同一文件）。关前同步裁走 flushSession(immediateTrim)。 */
  private deferTrim(sessionId: string, _dir: string): void {
    if (this.pendingTrims.has(sessionId)) return
    this.pendingTrims.add(sessionId)
    this.pendingChainTrims.add(sessionId)
    this.kickWriteChain(sessionId)
  }

  /**
   * If events.jsonl exceeds maxEventsDiskBytes, rewrite keeping only the
   * trailing bytes (aligned to the next newline). Invalidates the sparse index
   * so the next cold read rebuilds it.
   */
  trimEventsFileIfNeeded(sessionId: string, dir?: string): void {
    const d = dir ?? this.dir(sessionId)
    const file = join(d, 'events.jsonl')
    let size = 0
    try { size = statSync(file).size } catch { return }
    const max = this.maxEventsDiskBytes()
    if (size <= max) return

    let tail: Buffer | null = null
    let keepLen = 0
    const fd = openSync(file, 'r')
    try {
      const keepFrom = size - max
      // Align to next newline so we don't keep a partial leading event.
      const probe = Buffer.alloc(Math.min(64 * 1024, size - keepFrom))
      const n = readSync(fd, probe, 0, probe.length, keepFrom)
      const nl = probe.subarray(0, n).indexOf(0x0a)
      const start = nl >= 0 ? keepFrom + nl + 1 : keepFrom
      keepLen = size - start
      if (keepLen <= 0 || keepLen >= size) return
      tail = Buffer.alloc(keepLen)
      readSync(fd, tail, 0, keepLen, start)
    } finally {
      // Close before rename — Windows cannot replace a file while any handle is open.
      closeSync(fd)
    }
    if (!tail) return

    const tmp = join(d, 'events.jsonl.trim.tmp')
    writeFileSync(tmp, tail)
    renameSync(tmp, file)
    // Drop sparse index — offsets are now wrong.
    try { rmSync(join(d, 'events.index.jsonl'), { force: true }) } catch { /* ok */ }
    this.indexTracks.delete(sessionId)
    // 裁剪审计 marker（无 seq 的纯磁盘标记）：读路径把缺 seq 的行当损坏行丢弃
    // （parseEventsJsonlRaw / scanLogWithOffsets 同语义），所以它只对磁盘审计
    // 可见——桌面端如需在事件流里感知裁剪，应由 SessionManager 层经 appendMarker
    // 写带 seq 的 marker（persistence 层没有 seq 来源，不能安全自造）。
    // 去重：保留区里已有 events_trimmed marker（上轮写入后保尾裁剪会把它留在
    // 窗口内）→ 不再追加。高频超限下每轮 flush 都会触发 trim，重复 marker
    // 会让文件在 max+markerLen 附近持续膨胀。
    try {
      if (tail.indexOf(EVENTS_TRIMMED_MARKER) === -1) {
        appendFileSync(
          file,
          JSON.stringify({
            ts: Date.now(),
            type: 'events_trimmed',
            data: { removedBytes: size - keepLen, keptBytes: keepLen },
          }) + '\n',
          'utf8',
        )
      }
    } catch {
      /* marker is best-effort — never break the trim itself */
    }
  }

  /**
   * 事件批成功落盘后推进稀疏索引：按写入字节数累计偏移，每 ≥INDEX_INTERVAL
   * 个事件追加一条 {seq, offset} 到 events.index.jsonl。offset 指向该事件行
   * 在 events.jsonl 中的起始字节。
   */
  private advanceSparseIndex(sessionId: string, dir: string, batch: BufferedLine[]): void {
    let track = this.indexTracks.get(sessionId)
    if (!track) {
      // 惰性初始化：stat 在 append 之后 → 减去本批字节得到批前偏移。
      let fileBytes = 0
      try { fileBytes = statSync(join(dir, 'events.jsonl')).size } catch { fileBytes = 0 }
      const batchBytes = batch.reduce((n, b) => n + Buffer.byteLength(b.line, 'utf8'), 0)
      const preBytes = Math.max(0, fileBytes - batchBytes)
      // 全新日志（批前为空）→ 首个事件立即记条目（offset 0，锚定磁盘最早 seq）。
      // 已有日志（无论索引是否存在）→ 从 0 重数，只保证间距 ≥ INTERVAL；
      // 头部无覆盖的旧日志由读路径整本重建自愈。
      track = {
        bytes: preBytes,
        sinceEntry: preBytes === 0 ? FileSessionPersistence.INDEX_INTERVAL : 0,
      }
      this.indexTracks.set(sessionId, track)
    }
    const entryLines: string[] = []
    for (const b of batch) {
      track.sinceEntry++
      if (track.sinceEntry > FileSessionPersistence.INDEX_INTERVAL) {
        entryLines.push(JSON.stringify({ seq: b.seq, offset: track.bytes }))
        track.sinceEntry = 1
      }
      track.bytes += Buffer.byteLength(b.line, 'utf8')
    }
    if (entryLines.length > 0) {
      appendFileSync(join(dir, 'events.index.jsonl'), entryLines.join('\n') + '\n', 'utf8')
    }
  }

  /** Flush ALL session buffers — called by the debounce timer + flushSync. */
  private flushAll(immediateTrim = false): void {
    this.flushTimer = null
    for (const id of this.eventBuffers.keys()) {
      this.flushSession(id, immediateTrim)
    }
  }

  /** Synchronous flush — call on graceful shutdown / before critical reads.
   *
   *  write-behind 兼容语义：写链未启动时同步排空滞留行（loadAll/测试的同步
   *  断言路径）；链在跑的会话被跳过——生产上 shutdown 收口请改用
   *  `await flushAllAsync()`（本方法只在同步上下文兜底）。 */
  flushSync(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.flushAll(true)
    // 同步排空 record 写链（链未启动的脏快照）——index.json 与 events.jsonl 同语义。
    for (const id of [...this.recordWrites.keys()]) this.flushRecordSync(id)
    // 排空在途/链内排队裁剪：同步 drain 仅覆盖链未启动的会话（writeChains 在
    // 跑的会话由链尾 trim 自然收尾）。重跑幂等（size ≤ max 直接返回）。
    for (const id of [...this.pendingTrims]) {
      const st = this.writeChains.get(id)
      if (st?.running) continue
      try { this.trimEventsFileIfNeeded(id) } catch { /* best-effort */ }
      this.pendingTrims.delete(id)
      this.pendingChainTrims.delete(id)
    }
  }

  saveImage(sessionId: string, imgId: string, base64: string, mime: string): void {
    const d = join(this.ensureDir(sessionId), 'images')
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
    const ext = extForMime(mime)
    writeFileSync(join(d, `${sanitize(imgId)}.${ext}`), Buffer.from(base64, 'base64'))
  }

  readImage(sessionId: string, imgId: string): { bytes: Buffer; mime: string } | undefined {
    const dir = join(this.dir(sessionId), 'images')
    const safe = sanitize(imgId)
    for (const [ext, mime] of EXT_MIME) {
      const file = join(dir, `${safe}.${ext}`)
      if (existsSync(file)) {
        try {
          return { bytes: readFileSync(file), mime }
        } catch {
          return undefined
        }
      }
    }
    return undefined
  }

  loadAll(): PersistedSession[] {
    this.flushSync()
    if (!existsSync(this.baseDir)) return []
    const out: PersistedSession[] = []
    let entries: string[]
    try {
      entries = readdirSync(this.baseDir)
    } catch {
      return []
    }
    for (const id of entries) {
      const d = join(this.baseDir, id)
      const events = this.readEvents(d)
      const record = this.readRecord(d, id, events)
      if (record) out.push({ record, events })
    }
    return out
  }

  /**
   * Lazy-boot scan: one cheap index.json read per session, NEVER the event log.
   * This keeps sidecar restart cost flat (O(sessions)) instead of growing with
   * total history. Sessions missing/with a corrupt index fall back to an event
   * scan to reconstruct a minimal record (rare — crash before the first flush).
   */
  loadRecords(): SessionRecord[] {
    if (!existsSync(this.baseDir)) return []
    let entries: string[]
    try {
      entries = readdirSync(this.baseDir)
    } catch {
      return []
    }
    const out: SessionRecord[] = []
    for (const id of entries) {
      const d = join(this.baseDir, id)
      const rec = this.readRecordLight(d, id)
      if (rec) out.push(rec)
    }
    return out
  }

  /** On-demand single-session event log read (first open of a lazy session). */
  loadEvents(id: string): SessionEvent[] {
    this.flushSession(id)
    return this.readEvents(this.dir(id))
  }

  /**
   * Return the maximum durable event seq without trusting index.json.lastSeq.
   * The sparse index is only a seek anchor; its line and byte offset are
   * validated before the tail is scanned. Any uncertainty falls back to a
   * complete valid-line scan so callers never receive a stale high-water mark.
   */
  loadEventHighWater(id: string): number {
    this.flushSession(id)
    if ((this.eventBuffers.get(id)?.length ?? 0) > 0) {
      throw new Error(`Unable to establish durable event high-water for ${id}: buffered events remain`)
    }

    const file = join(this.dir(id), 'events.jsonl')
    let size: number
    try {
      size = statSync(file).size
    } catch (error) {
      if (isMissingFile(error)) return 0
      throw error
    }
    if (size === 0) return 0

    const entries = readHighWaterIndexEntries(join(this.dir(id), 'events.index.jsonl'))
    const anchor = entries?.[entries.length - 1]
    if (anchor) {
      const indexed = this.scanFromHighWaterAnchor(file, size, anchor)
      if (indexed !== null) return indexed
    }

    // Missing/corrupt/trimmed/misaligned indexes are an explicit slow path.
    return this.scanEventFileMax(file, size)
  }

  /** Validate the final sparse-index anchor and scan from its byte offset. */
  private scanFromHighWaterAnchor(file: string, expectedSize: number, anchor: IndexEntry): number | null {
    if (
      !Number.isSafeInteger(anchor.seq) ||
      anchor.seq < 0 ||
      !Number.isSafeInteger(anchor.offset) ||
      anchor.offset < 0 ||
      anchor.offset >= expectedSize
    ) return null

    const fd = openSync(file, 'r')
    try {
      if (anchor.offset > 0) {
        const previous = Buffer.allocUnsafe(1)
        if (readSync(fd, previous, 0, 1, anchor.offset - 1) !== 1 || previous[0] !== 0x0a) {
          return null
        }
      }
      const bytes = Buffer.allocUnsafe(expectedSize - anchor.offset)
      let read = 0
      while (read < bytes.length) {
        const n = readSync(fd, bytes, read, bytes.length - read, anchor.offset + read)
        if (n <= 0) return null
        read += n
      }
      if (read !== bytes.length) return null

      const text = bytes.toString('utf8')
      const firstLineEnd = text.indexOf('\n')
      const firstLine = firstLineEnd < 0 ? text : text.slice(0, firstLineEnd)
      const first = parseEventLine(firstLine)
      if (!first || first.seq !== anchor.seq) return null

      const highWater = maxSeqInEventsText(text)
      if (highWater < anchor.seq) return null
      return this.assertStableFileMax(file, expectedSize, highWater)
    } catch {
      return null
    } finally {
      closeSync(fd)
    }
  }

  /** Complete fallback scan; malformed and seq-less marker lines are ignored. */
  private scanEventFileMax(file: string, expectedSize: number): number {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      throw new Error(`Unable to establish durable event high-water: cannot read ${file}`, { cause: error })
    }
    const highWater = maxSeqInEventsText(text)
    return this.assertStableFileMax(file, expectedSize, highWater)
  }

  /** Refuse a result if a concurrent trim/append changed the file while reading. */
  private assertStableFileMax(file: string, expectedSize: number, highWater: number): number {
    let actualSize: number
    try {
      actualSize = statSync(file).size
    } catch (error) {
      throw new Error(`Unable to establish durable event high-water: ${file} changed while reading`, { cause: error })
    }
    if (actualSize !== expectedSize) {
      throw new Error(`Unable to establish durable event high-water: ${file} changed while reading`)
    }
    return highWater
  }

  /**
   * Async variant for the reconnect-replay path: non-blocking file read, then
   * JSON.parse offloaded to the shared cpu-pool worker. A multi-MB events.jsonl
   * parsed inline used to stall the event loop long enough to starve SSE
   * keepalives — turning one reconnect into a reconnect storm. Falls back to a
   * chunked inline parse (yields between batches) when the pool is unavailable.
   */
  async loadEventsAsync(id: string): Promise<SessionEvent[]> {
    await this.flushSessionAsync(id)
    const file = join(this.dir(id), 'events.jsonl')
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      return []
    }
    if (!text) return []
    // Small logs parse faster inline than a worker round-trip costs.
    if (text.length < 256 * 1024) return parseEventsJsonlRaw(text) as SessionEvent[]
    try {
      return (await cpuPool.run('parseEventsJsonlRaw', [text])) as SessionEvent[]
    } catch {
      return chunkedParseEvents(text)
    }
  }

  /**
   * 首开会话的尾部读——只把内存环留得下的部分搬过线程边界。
   *
   * loadEventsAsync 会把整本日志的解析结果回传，调用方随即按 maxEvents 截尾丢掉
   * 其余。parse 在 worker 里不占主线程，但 structured clone 的成本与条数成正比
   * （实测 3.56 MB / 43,717 条：全量回传 139ms，尾部 5,000 条 14ms），那份搬运
   * 是纯浪费。截断挪进 worker 后，代价与日志长度解耦、只与环容量相关。
   *
   * 被截掉的头部仍有两样东西要带出来：磁盘最早 seq（前端据此判断还有没有更早的
   * 历史）和全量 artifact id（去重集不完整会让旧 artifact 重放时被重新公告）。
   */
  async loadEventsTailAsync(id: string, maxEvents: number): Promise<EventsTail> {
    const empty: EventsTail = { events: [], diskFirstSeq: 0, lastSeq: 0, artifactIds: [], total: 0 }
    this.flushSession(id)
    const file = join(this.dir(id), 'events.jsonl')
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      return empty
    }
    if (!text) return empty
    // RawSessionEvent.type 是宽 string（worker 侧不依赖事件类型联合），在此收窄，
    // 与 loadEventsAsync 的边界处理一致。
    if (text.length < 256 * 1024) return parseEventsTailRaw(text, maxEvents) as EventsTail
    try {
      return (await cpuPool.run('parseEventsTailRaw', [text, maxEvents])) as EventsTail
    } catch {
      // pool 不可用：分批 parse（批间让出事件循环），再在主线程截尾。
      return tailOf(await chunkedParseEvents(text), maxEvents)
    }
  }

  /**
   * 稀疏索引区间读（冷通道分页，Phase 2）：返回 seq < before 的尾部窗口，
   * 至少 minCount 条（或到日志开头）。只读取覆盖窗口的字节区间、只 parse
   * 该区间——大日志分页不再整本进内存。
   *
   * 索引缺失/损坏/校验不过（区间首行 seq 与索引条目不符）→ 整本扫描重建
   * 索引并从全量切片（自愈，一次性成本；旧日志首次分页也走这条路补齐头部
   * 条目）。events.jsonl 是 append-only（rewind 也只追加标记事件），索引
   * 无需处理重写失效，只防外部损坏与崩溃截尾。
   */
  async loadEventsBefore(id: string, before: number, minCount: number): Promise<{
    events: SessionEvent[]
    /** true = 窗口起点即日志开头（无更早内容可扩）。 */
    atLogStart: boolean
    /** 磁盘日志最早 seq（空日志为 0）。 */
    firstSeq: number
  }> {
    this.flushSession(id)
    const dir = this.dir(id)
    const entries = readIndexEntries(join(dir, 'events.index.jsonl'))
    // 无可用索引 / 头部无覆盖（旧日志中途才开始记条目）→ 整本重建。
    if (!entries || entries.length === 0 || entries[0]!.offset !== 0) {
      return this.rebuildAndSlice(id, before, minCount)
    }
    // 定位窗口：endIdx = 首个 seq ≥ before 的条目（其 offset 为读取上界；
    // 该条目之后的事件 seq 单调 ≥ before，不可能落入窗口）。
    let endIdx = -1
    for (let i = 0; i < entries.length; i++) {
      if (entries[i]!.seq >= before) { endIdx = i; break }
    }
    const lastBelow = endIdx === -1 ? entries.length - 1 : endIdx - 1
    if (lastBelow < 0) {
      // before ≤ 磁盘最早 seq → 无更早页。
      return { events: [], atLogStart: true, firstSeq: entries[0]!.seq }
    }
    // 相邻条目间 ≥ INDEX_INTERVAL 个事件 → 回看 ceil(minCount/INTERVAL) 个
    // 条目即保证窗口内 seq < before 的事件 ≥ minCount（除非顶到日志开头）。
    const lookback = Math.ceil(Math.max(1, minCount) / FileSessionPersistence.INDEX_INTERVAL)
    const startIdx = Math.max(0, lastBelow - lookback)
    const startOffset = entries[startIdx]!.offset
    const endOffset = endIdx === -1 ? undefined : entries[endIdx]!.offset
    const text = await readByteRange(join(dir, 'events.jsonl'), startOffset, endOffset)
    if (text === null) return { events: [], atLogStart: true, firstSeq: 0 }
    const parsed = await this.parseRegion(text)
    // 校验：区间首个事件必须就是索引条目锚定的那个 seq——否则索引与文件
    // 已漂移（外部改写/崩溃截尾后的偏移错位），整本重建。
    if (parsed.length === 0 || parsed[0]!.seq !== entries[startIdx]!.seq) {
      return this.rebuildAndSlice(id, before, minCount)
    }
    return {
      events: parsed.filter((e) => e.seq < before),
      atLogStart: startIdx === 0,
      firstSeq: entries[0]!.seq,
    }
  }

  /** 区间文本 parse：小区间内联，大区间走 cpuPool（与 loadEventsAsync 同策略）。 */
  private async parseRegion(text: string): Promise<SessionEvent[]> {
    if (!text) return []
    if (text.length < FileSessionPersistence.INLINE_PARSE_MAX_BYTES) {
      return parseEventsJsonlRaw(text) as SessionEvent[]
    }
    try {
      return (await cpuPool.run('parseEventsJsonlRaw', [text])) as SessionEvent[]
    } catch {
      return chunkedParseEvents(text)
    }
  }

  /**
   * 索引不可用时的自愈路径：整本读取 + 逐行扫描重建 events.index.jsonl
   * （tmp+rename 原子替换），并直接从全量结果切片返回。重建后写指针同步
   * 到文件末尾，后续 append 无缝续写条目。
   */
  private async rebuildAndSlice(id: string, before: number, minCount: number): Promise<{
    events: SessionEvent[]
    atLogStart: boolean
    firstSeq: number
  }> {
    const dir = this.dir(id)
    const file = join(dir, 'events.jsonl')
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      return { events: [], atLogStart: true, firstSeq: 0 }
    }
    const { events, entryLines, validCount } = await scanLogWithOffsets(text)
    // 写回重建的索引（best-effort）+ 同步进程内写指针。
    try {
      const idx = join(dir, 'events.index.jsonl')
      if (entryLines.length > 0) {
        const tmp = idx + '.tmp'
        writeFileSync(tmp, entryLines.join('\n') + '\n', 'utf8')
        renameSync(tmp, idx)
      } else {
        rmSync(idx, { force: true })
      }
      this.indexTracks.set(id, {
        bytes: Buffer.byteLength(text, 'utf8'),
        // 上一条目落在 valid 行序号 floor((validCount-1)/N)*N（0 起）——
        // 之后已写入 validCount-1-那个序号 个事件。
        sinceEntry: validCount === 0
          ? FileSessionPersistence.INDEX_INTERVAL
          : validCount - Math.floor((validCount - 1) / FileSessionPersistence.INDEX_INTERVAL)
            * FileSessionPersistence.INDEX_INTERVAL,
      })
    } catch {
      this.indexTracks.delete(id)
    }
    const head = events.filter((e) => e.seq < before)
    const keep = Math.max(1, minCount)
    const start = Math.max(0, head.length - keep)
    return {
      events: head.slice(start),
      atLogStart: start === 0,
      firstSeq: events[0]?.seq ?? 0,
    }
  }

  /**
   * On-disk byte size of every session, keyed by session id. Stat-based only
   * (file metadata, never reads contents) so surfacing storage usage in the UI
   * costs a handful of stat() calls — not a re-read of the (potentially huge)
   * event logs. Keys are the on-disk dir names (== id for the alphanumeric ids
   * we generate).
   */
  sizeReport(): Map<string, number> {
    const out = new Map<string, number>()
    if (!existsSync(this.baseDir)) return out
    let entries: string[]
    try { entries = readdirSync(this.baseDir) } catch { return out }
    for (const id of entries) {
      const d = join(this.baseDir, id)
      try { if (!statSync(d).isDirectory()) continue } catch { continue }
      out.set(id, this.dirSizeBytes(d))
    }
    return out
  }

  /** On-disk byte size of a single session (stat-based, no content reads). */
  sizeOf(id: string): number {
    return this.dirSizeBytes(this.dir(id))
  }

  /** Irreversibly remove a session's on-disk files (events, index, images…). */
  deleteSession(id: string): void {
    this.flushSession(id)
    this.eventBuffers.delete(id)
    this.indexTracks.delete(id)
    // 在途的延迟裁剪任务指向的目录即将消失——清掉防 Set 泄漏，回调里
    // statSync 失败也会自行返回。
    this.pendingTrims.delete(id)
    try { rmSync(this.dir(id), { recursive: true, force: true }) } catch { /* best-effort */ }
  }

  /** Sum file sizes under a dir (shallow recursion for backups/ + images). */
  private dirSizeBytes(dir: string): number {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return 0
    }
    let total = 0
    for (const name of names) {
      const p = join(dir, name)
      try {
        const st = statSync(p)
        total += st.isDirectory() ? this.dirSizeBytes(p) : st.size
      } catch { /* skip unreadable entry */ }
    }
    return total
  }

  /**
   * Cheap record read: prefer the index.json snapshot and DON'T touch the event
   * log on the happy path. Only when the index is missing/corrupt do we scan
   * events to reconstruct a listable record (same logic as readRecord).
   */
  private readRecordLight(dir: string, id: string): SessionRecord | null {
    const file = join(dir, 'index.json')
    if (existsSync(file)) {
      try {
        const rec = JSON.parse(readFileSync(file, 'utf8')) as SessionRecord
        if (rec && typeof rec.id === 'string') return rec
      } catch {
        // fall through to event-scan reconstruction
      }
    }
    return this.readRecord(dir, id, this.readEvents(dir))
  }

  private readEvents(dir: string): SessionEvent[] {
    const file = join(dir, 'events.jsonl')
    if (!existsSync(file)) return []
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return []
    }
    return parseEventsJsonlRaw(text) as SessionEvent[]
  }

  private readRecord(dir: string, id: string, events: SessionEvent[]): SessionRecord | null {
    const file = join(dir, 'index.json')
    if (existsSync(file)) {
      try {
        const rec = JSON.parse(readFileSync(file, 'utf8')) as SessionRecord
        if (rec && typeof rec.id === 'string') return rec
      } catch {
        // fall through to reconstruction
      }
    }
    // No usable index.json — reconstruct a minimal record from the event tail
    // so a partially-written session is still listable rather than lost.
    if (events.length === 0) return null
    const last = events[events.length - 1]!
    const first = events[0]!
    return {
      id,
      status: 'aborted',
      createdAt: first.ts,
      updatedAt: last.ts,
      cwd: process.cwd(),
      lastSeq: last.seq,
      pendingApprovals: 0,
    }
  }
}

function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_')
}

/** events_trimmed marker 行的指纹子串——trim 去重用它判断保留区里是否已有
 *  marker（普通事件行的 type 不可能是这个值）。 */
const EVENTS_TRIMMED_MARKER = Buffer.from('"type":"events_trimmed"')

/** 事件写缓冲行：flush 时既要行文本（落盘）也要 seq（稀疏索引条目）。 */
interface BufferedLine {
  line: string
  seq: number
}

/** 进程内稀疏索引写指针：events.jsonl 当前字节长 + 距上一条目的事件数。 */
interface IndexTrack {
  bytes: number
  sinceEntry: number
}

interface IndexEntry {
  seq: number
  offset: number
}

/** Strict index reader for seq allocation; unlike pagination, no malformed line
 * may be ignored because an omitted anchor could make the result stale. */
function readHighWaterIndexEntries(file: string): IndexEntry[] | null {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const entries: IndexEntry[] = []
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return null
    }
    if (!parsed || typeof parsed !== 'object') return null
    const entry = parsed as Partial<IndexEntry>
    const seq = entry.seq
    const offset = entry.offset
    if (
      typeof seq !== 'number' ||
      !Number.isSafeInteger(seq) ||
      seq < 0 ||
      typeof offset !== 'number' ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    ) return null
    const previous = entries[entries.length - 1]
    if (previous && (seq <= previous.seq || offset <= previous.offset)) return null
    entries.push({ seq, offset })
  }
  // An index created after a partial historical scan does not cover the head;
  // using it as a high-water anchor could miss a larger seq before offset 0.
  if (entries.length === 0 || entries[0]!.offset !== 0) return null
  return entries
}

/** Parse one JSONL line using the same event validity boundary as the worker. */
function parseEventLine(line: string): { seq: number } | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as { seq?: unknown; type?: unknown }
    if (
      parsed &&
      typeof parsed.seq === 'number' &&
      Number.isSafeInteger(parsed.seq) &&
      parsed.seq >= 0 &&
      typeof parsed.type === 'string'
    ) return { seq: parsed.seq }
  } catch {
    // Corrupt/torn lines are deliberately ignored by the full scan.
  }
  return null
}

/** Maximum seq among valid event lines; seq-less disk markers are ignored. */
function maxSeqInEventsText(text: string): number {
  let highWater = 0
  for (const line of text.split('\n')) {
    const parsed = parseEventLine(line)
    if (parsed && parsed.seq > highWater) highWater = parsed.seq
  }
  return highWater
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

/**
 * 读取并校验稀疏索引文件。任何结构异常（非法行、seq/offset 非严格递增）
 * 都返回 null 触发整本重建——索引是纯加速层，宁可重建不可误导。
 */
function readIndexEntries(file: string): IndexEntry[] | null {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const entries: IndexEntry[] = []
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    try {
      const e = JSON.parse(trimmed) as IndexEntry
      if (typeof e.seq !== 'number' || typeof e.offset !== 'number') return null
      const prev = entries[entries.length - 1]
      if (prev && (e.seq <= prev.seq || e.offset <= prev.offset)) return null
      entries.push({ seq: e.seq, offset: e.offset })
    } catch {
      // 尾部截断行（崩溃窗口）可容忍——只有出现在中间才算结构损坏。
      // 无法区分位置时保守处理：忽略并继续；递增校验兜底真正的错位。
    }
  }
  return entries
}

/** 读取文件的 [start, end) 字节区间（end 省略 = 到 EOF）。失败返回 null。 */
async function readByteRange(file: string, start: number, end?: number): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof open>>
  try {
    fh = await open(file, 'r')
  } catch {
    return null
  }
  try {
    const size = (await fh.stat()).size
    const stop = end === undefined ? size : Math.min(end, size)
    const len = stop - start
    if (len <= 0) return ''
    const buf = Buffer.allocUnsafe(len)
    await fh.read(buf, 0, len, start)
    return buf.toString('utf8')
  } catch {
    return null
  } finally {
    await fh.close().catch(() => {})
  }
}

/**
 * 整本扫描：逐行 parse（分批 yield，防大日志饿死事件循环），同时按字节偏移
 * 每 INDEX_INTERVAL 个有效行生成一条索引条目（有效行序号 0, N, 2N, …）。
 * 损坏行跳过（与 parseEventsJsonlRaw 同语义），偏移按原始字节推进。
 */
async function scanLogWithOffsets(text: string): Promise<{
  events: SessionEvent[]
  entryLines: string[]
  validCount: number
}> {
  const INTERVAL = 500
  const BATCH = 2000
  const lines = text.split('\n')
  const events: SessionEvent[] = []
  const entryLines: string[] = []
  let offset = 0
  let validCount = 0
  for (let i = 0; i < lines.length; i += BATCH) {
    if (i > 0) await yieldToLoop()
    const end = Math.min(i + BATCH, lines.length)
    for (let j = i; j < end; j++) {
      const raw = lines[j]!
      const lineBytes = Buffer.byteLength(raw, 'utf8') + (j < lines.length - 1 ? 1 : 0)
      const trimmed = raw.trim()
      if (trimmed) {
        try {
          const parsed = JSON.parse(trimmed) as SessionEvent
          if (parsed && typeof parsed.seq === 'number' && typeof parsed.type === 'string') {
            if (validCount % INTERVAL === 0) {
              // 序号 0 的条目 offset 强制 0：即使日志首行损坏（崩溃残留），
              // 从文件头读到的首个有效事件仍是该 seq——校验成立，且
              // 「offset 0 = 头部有覆盖」的判定不会因损坏前缀反复触发重建。
              entryLines.push(JSON.stringify({ seq: parsed.seq, offset: validCount === 0 ? 0 : offset }))
            }
            validCount++
            events.push(parsed)
          }
        } catch {
          // corrupt/partial line — drop it, keep the rest
        }
      }
      offset += lineBytes
    }
  }
  events.sort((a, b) => a.seq - b.seq)
  return { events, entryLines, validCount }
}

/**
 * Inline fallback when the cpu-pool is unavailable: parse in bounded batches,
 * yielding to the event loop between batches so SSE pings and other requests
 * keep flowing even for very large logs.
 */
async function chunkedParseEvents(text: string): Promise<SessionEvent[]> {
  const lines = text.split('\n')
  const events: SessionEvent[] = []
  const BATCH = 2000
  for (let i = 0; i < lines.length; i += BATCH) {
    if (i > 0) await yieldToLoop()
    const end = Math.min(i + BATCH, lines.length)
    for (let j = i; j < end; j++) {
      const trimmed = lines[j]!.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed) as SessionEvent
        if (parsed && typeof parsed.seq === 'number' && typeof parsed.type === 'string') {
          events.push(parsed)
        }
      } catch {
        // corrupt/partial line — drop it, keep the rest
      }
    }
  }
  events.sort((a, b) => a.seq - b.seq)
  return events
}

/** 把一份全量解析结果收成尾部形状——pool 不可用时的兜底路径复用，
 *  保持与 worker 侧 parseEventsTailRaw 完全一致的语义。 */
function tailOf(all: SessionEvent[], maxEvents: number): EventsTail {
  if (all.length === 0) {
    return { events: [], diskFirstSeq: 0, lastSeq: 0, artifactIds: [], total: 0 }
  }
  const artifactIds: string[] = []
  for (const e of all) {
    if (e.type === 'artifact') artifactIds.push(String(e.data.id))
  }
  return {
    // delegation 豁免截尾（M1，与 worker 侧 tailExemptDelegation 同语义）：
    // 保留尾部 maxEvents 条 + 全部 delegation，stale 对账与回放依赖它们完整。
    events: all.length > maxEvents
      ? (() => {
          const overflow = all.length - maxEvents
          const kept: SessionEvent[] = []
          let dropped = 0
          for (const e of all) {
            if (dropped < overflow && e.type !== 'delegation') {
              dropped++
              continue
            }
            kept.push(e)
          }
          return kept
        })()
      : all,
    diskFirstSeq: all[0]!.seq,
    lastSeq: all[all.length - 1]!.seq,
    artifactIds,
    total: all.length,
  }
}

/** Provider-safe image MIMEs ↔ file extensions (single source of truth). */
const EXT_MIME: ReadonlyArray<readonly [string, string]> = [
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
]

function extForMime(mime: string): string {
  const hit = EXT_MIME.find(([, m]) => m === mime)
  return hit ? hit[0] : 'png'
}

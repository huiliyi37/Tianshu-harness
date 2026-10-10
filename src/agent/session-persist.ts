import { readHandoffWithCoverage, writeHandoffCoverage, writeHandoffTail } from './handoff-coverage.js'
import { readFile } from 'node:fs/promises'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import { existsSync, mkdirSync, readFileSync, unlinkSync, rmSync, readdirSync, statSync } from 'fs'
import { writeFileAtomicSync, writeFileAtomicAsync, writeFileAtomicDurableAsync } from '../fs-atomic.js'
import { isAbsolute, join, relative, resolve } from 'path'
import { sessionsDir } from '../config/paths.js'
import type { Message } from '../api/types.js'
import { normalizeOaiMessage, normalizeOaiMessages } from '../api/oai-types.js'
import type { OaiMessage, OaiToolCall } from '../api/oai-types.js'
import { legacyMessageToOaiMessages } from './session-message-conversion.js'
import { isSafeToRerun } from '../tools/write-tool-helpers.js'
import { JSON_VALUE_KEEP_RATIO, MAX_SESSION_MESSAGE_JSON_CHARS } from '../compact/constants.js'
import { parseFrozenSnapshotData, type FrozenSnapshotData } from '../prompt/frozen-snapshot.js'

import type { SessionMetadata } from '../context/types.js'
import type { CompactEvent } from '../context/types.js'
import type { LedgerSessionMemoryState, SessionMemoryEntry, SessionMemoryState } from '../context/types.js'
import { appendSessionMemory, buildSessionMemoryBlock, loadSessionMemory } from '../context/session-memory.js'
import { ContextClaimStore } from '../context/claim-store.js'
import type { ContextClaim } from '../context/claims.js'
import { assertValidSessionId } from '../validation.js'
import { appendChecksum, verifyLines } from './checksum.js'
import { decodeTranscriptText, encodeBatch } from './session-transcript-codec.js'
import { SessionBatchWriter } from './session-batch-writer.js'
import { SessionMetadataStore, compactEventKey, mergeCompactEvent } from './session-metadata.js'

/** Re-export for backward compatibility — tests still import projectSlug from here. */
export { projectSlug } from '../config/paths.js'

export function getSessionDir(cwd: string): string {
  return sessionsDir(cwd)
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const marker = `\n<session-message-truncated original_chars="${value.length}" kept_chars="${maxChars}" />`
  const keep = Math.max(0, maxChars - marker.length)
  return value.slice(0, keep) + marker
}

function capJsonValue(value: unknown, maxChars: number): unknown {
  if (typeof value === 'string') return truncateString(value, maxChars)
  if (Array.isArray(value)) return value.map(item => capJsonValue(item, maxChars))
  if (value && typeof value === 'object') {
    const capped: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      capped[key] = capJsonValue(child, maxChars)
    }
    return capped
  }
  return value
}

export function serializeSessionMessage(message: Message, maxChars = MAX_SESSION_MESSAGE_JSON_CHARS): string {
  return serializeSessionJsonValue(message, maxChars, () => ({
    role: message.role,
    content: truncateString(JSON.stringify(message), maxChars),
  }))
}

export function serializeOaiSessionMessage(message: OaiMessage, maxChars = MAX_SESSION_MESSAGE_JSON_CHARS): string {
  const normalized = normalizeOaiMessage(message)
  // Attachments are protocol data. Truncating a URL/base64 value corrupts it.
  if (normalized.role === 'user' && Array.isArray(normalized.content)) return JSON.stringify(normalized)
  // A signature and the associated function arguments are opaque protocol data.
  if (normalized.role === 'assistant' && normalized.tool_calls?.some(call => call.providerMetadata?.gemini?.thoughtSignature)) return JSON.stringify(normalized)
  return serializeSessionJsonValue(normalized, maxChars, () => ({
    role: normalized.role,
    content: truncateString(JSON.stringify(normalized), maxChars),
    ...(normalized.role === 'tool' ? { tool_call_id: normalized.tool_call_id } : {}),
  } as OaiMessage))
}

function serializeSessionJsonValue<T>(message: T, maxChars: number, fallback: () => T): string {
  let json = JSON.stringify(message)
  if (json.length <= maxChars) return json

  const capped = capJsonValue(message, Math.max(1_000, Math.floor(maxChars * JSON_VALUE_KEEP_RATIO))) as T
  json = JSON.stringify(capped)
  if (json.length <= maxChars) return json

  return JSON.stringify(fallback())
}

function isOaiMessage(value: unknown): value is OaiMessage {
  if (!value || typeof value !== 'object') return false
  const msg = value as Record<string, unknown>
  if (msg.role === 'system') return typeof msg.content === 'string'
  if (msg.role === 'user') return typeof msg.content === 'string' || (Array.isArray(msg.content) && msg.content.every(part =>
    part && ((part.type === 'text' && typeof part.text === 'string')
      || (part.type === 'image_url' && typeof part.image_url?.url === 'string'))))
  if (msg.role === 'assistant') return typeof msg.content === 'string' || msg.content === null
  if (msg.role === 'tool') return typeof msg.tool_call_id === 'string' && typeof msg.content === 'string'
  return false
}

function parseSessionLine(line: string): unknown | null {
  const parsed = JSON.parse(line) as { type?: string }
  if (parsed.type === 'compact_start' || parsed.type === 'compact_end' || parsed.type === 'model_switch') {
    return null
  }
  return parsed
}

/** 只读历史会话转录（memory backfill / deep-recall 共用）：zstd 解码 + 校验和
 *  过滤，只取 user/assistant 文本行。不写不建目录——与 SessionPersist 写路径解耦。 */
export function readHistoricalTranscript(filePath: string): Array<{ role: string; content: string }> {
  if (!existsSync(filePath)) return []
  let lines: string[]
  try {
    lines = decodeTranscriptText(readFileSync(filePath)).trim().split('\n').filter(Boolean)
  } catch { return [] }
  const messages: Array<{ role: string; content: string }> = []
  for (const line of verifyLines(lines).validLines) {
    try {
      const parsed = parseSessionLine(line) as { role?: unknown; content?: unknown } | null
      if (parsed && (parsed.role === 'user' || parsed.role === 'assistant') && typeof parsed.content === 'string') {
        messages.push({ role: parsed.role, content: parsed.content })
      }
    } catch { /* skip malformed rows */ }
  }
  return messages
}

export class SessionPersist {
  private frozenWrites: Promise<void> = Promise.resolve()
  private frozenSaveError?: string

  queueFrozenSnapshot(data: FrozenSnapshotData): void {
    this.frozenWrites = this.frozenWrites.then(async () => {
      await writeFileAtomicAsync(this.frozenPath, JSON.stringify(data))
      this.frozenSaveError = undefined
    }).catch(() => { this.frozenSaveError = 'snapshot_save_failed' })
  }

  async drainFrozenSnapshots(): Promise<void> { await this.frozenWrites }
  getFrozenSnapshotError(): string | undefined { return this.frozenSaveError }
  private filePath: string
  private metadataPath: string
  private frozenPath: string
  private sessionId: string
  private cwd: string
  /** Write-behind batch writer (zstd frames + 200ms batching + torn recovery). */
  private batchWriter: SessionBatchWriter
  /** Metadata store (in-memory cache + batch-flush cadence). */
  private metaStore: SessionMetadataStore

  /** Public getter for testing file-path-dependent integrations. */
  getFilePath(): string {
    return this.filePath
  }

  constructor(sessionId: string, cwd: string, opts?: { recoveryStructuredTools?: boolean }) {
    assertValidSessionId(sessionId)
    this.recoveryStructuredTools = opts?.recoveryStructuredTools
    this.cwd = cwd
    ensureDir(getSessionDir(cwd))
    this.sessionId = sessionId
    this.filePath = join(getSessionDir(cwd), `${sessionId}.jsonl`)
    this.metadataPath = join(getSessionDir(cwd), `${sessionId}.meta.json`)
    this.frozenPath = join(getSessionDir(cwd), `${sessionId}.frozen.json`)
    this.batchWriter = new SessionBatchWriter(this.filePath, () => this.getBackupDir())
    this.metaStore = new SessionMetadataStore(this.metadataPath)
  }

  getBackupDir(): string {
    const dir = join(getSessionDir(this.cwd), this.sessionId, 'backups')
    ensureDir(dir)
    return dir
  }

  /** Append a single message to the session file (checksummed batch path). */
  async append(message: Message): Promise<void> {
    const line = serializeSessionMessage(message) + '\n'
    this.batchWriter.enqueueLine(line)
  }

  /** Flush barrier: drain the write-behind batch into a zstd frame on disk. */
  async flushSessionBuffer(): Promise<void> {
    await this.batchWriter.flush()
    // Metadata rides the same batch cadence: one atomic write per batch
    // instead of one read-modify-write per message append.
    this.metaStore.flush()
  }

  /** 转录里当前有多少条 OAI 消息（getTranscriptWatermark 的载体）。 */
  private transcriptWatermark = 0
  /** 自构造以来 append 过多少条——加载期间新 append 的要补回水位，否则水位会被读盘快照压低。 */
  private appendedCount = 0

  /** 恢复结构化注入开关（config.agent.recovery.structuredTools；未设则看 env）。 */
  private recoveryStructuredTools?: boolean

  /** 上一次 loadOai 在结构化模式下注入「结果未知」的工具（供恢复路径标待确认）。 */
  private lastInjectedUncertain: Array<{ id: string; name: string }> = []

  /** Read the transcript file as JSONL text (zstd frames or legacy passthrough). */
  private readTranscriptText(): string {
    const snapshot = this.batchWriter.captureReadSnapshot()
    const onDisk = existsSync(this.filePath) ? readFileSync(this.filePath) : Buffer.alloc(0)
    // In-process readers must also see lines still queued in the write-behind
    // batch — append() followed by loadOai()/fork without a flush is valid.
    return decodeTranscriptText(onDisk.subarray(0, snapshot.committedBytes)) + snapshot.tail
  }

  /** Load all messages from the session file (with checksum validation) */
  load(): Message[] {
    return this.loadWithChecksum()
  }

  /** Append an OpenAI-native message with checksum (queued into the batch).
   *
   * `flush: true` drains the batch after enqueue — used for durability-critical
   * records (assistant tool_calls / tool results / user turns) so a hard crash
   * cannot lose a completed tool result while its disk side effect survives.
   */
  async appendOaiWithChecksum(message: OaiMessage, options?: { flush?: boolean }): Promise<void> {
    const json = serializeOaiSessionMessage(message)
    const line = appendChecksum(json) + '\n'
    this.batchWriter.enqueueLine(line)
    this.transcriptWatermark += 1
    this.appendedCount += 1
    if (options?.flush) await this.batchWriter.flush()
  }

  /**
   * 转录水位（PLAN §4 恢复设计第 1 步）。
   *
   * **定义：转录里当前有多少条 OAI 消息**——恢复出的条数与它是同一把尺子，所以
   * 「检查点水位 vs 实际恢复条数」才可比。三处变更都必须喂它，缺一处水位就是错的：
   *   · 加载（loadOai / loadOaiAsync）：对齐到读到的真实条数（含批处理里未落盘的尾巴）；
   *   · 追加（appendOaiWithChecksum）：+1；
   *   · 历史重写（compactOai / compactOaiAsync）：落到重写后的条数（会**变小**）。
   *
   * 此前它只统计「本实例 append 过多少条」：重新加载 2 条历史时是 0、再追加 1 条是 1，
   * 而转录里其实有 3 条——与恢复端的条数根本不是一个口径，观测门因此形同虚设。
   */
  getTranscriptWatermark(): number { return this.transcriptWatermark }

  /**
   * 加载完成后的水位对齐：读盘快照条数 + 加载期间新 append 的条数。
   * 不直接赋值 `messages.length` 的原因：loadOaiAsync 是分片让出事件循环的，
   * 期间可能有 append 落进批处理——那部分不在本次读到的快照里，但确实已经在转录里。
   */
  private alignTranscriptWatermark(loaded: number, appendedBefore: number): void {
    this.transcriptWatermark = loaded + (this.appendedCount - appendedBefore)
  }

  /** 上一次 loadOai 注入的「结果未知」工具（结构化模式）；默认模式恒为空。 */
  getLastInjectedUncertain(): Array<{ id: string; name: string }> { return this.lastInjectedUncertain }

  /**
   * Append a model-switch event to the session transcript.
   *
   * Written as a checksummed `type: 'model_switch'` line so it survives
   * checksum verification, but parseSessionLine skips it on replay (same
   * pattern as compact_start/compact_end) — it's an audit breadcrumb, not
   * part of the conversation history. Lets a session JSONL show exactly
   * when/what the model changed mid-session.
   */
  appendModelSwitch(event: { from?: string; to: string; provider?: string }): void {
    const line = appendChecksum(JSON.stringify({
      type: 'model_switch',
      t: Date.now(),
      from: event.from,
      to: event.to,
      provider: event.provider,
    })) + '\n'
    this.batchWriter.enqueueLine(line)
  }

  /** Load messages in OpenAI-native format, migrating legacy rows on read. */
  loadOai(): OaiMessage[] {
    const appendedBefore = this.appendedCount
    const parser = this.parseOai(this.readTranscriptText())
    let next = parser.next()
    while (!next.done) next = parser.next()
    this.alignTranscriptWatermark(next.value.length, appendedBefore)
    return next.value
  }

  async loadOaiAsync(signal?: AbortSignal): Promise<OaiMessage[]> {
    signal?.throwIfAborted()
    let text = ''
    let appendedBefore: number
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted()
      appendedBefore = this.appendedCount
      const snapshot = this.batchWriter.captureReadSnapshot()
      const before = this.transcriptIdentity()
      let bytes = Buffer.alloc(0)
      try { bytes = await readFile(this.filePath, { signal }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const after = this.transcriptIdentity()
      // Atomic rewrites and legacy transcoding replace the inode. A byte
      // offset captured for the previous file cannot describe the new one.
      const limit = snapshot.committedBytes ?? before?.size ?? 0
      if (before?.dev !== after?.dev || before?.ino !== after?.ino || bytes.length < limit) {
        if (attempt >= 2) throw Object.assign(new Error('Session transcript changed during read; retry loading'), { code: 'EAGAIN' })
        continue
      }
      text = decodeTranscriptText(bytes.subarray(0, limit)) + snapshot.tail
      break
    }
    const parser = this.parseOai(text)
    for (;;) {
      signal?.throwIfAborted()
      const next = parser.next()
      if (next.done) {
        this.alignTranscriptWatermark(next.value.length, appendedBefore)
        return next.value
      }
      await yieldToLoop()
    }
  }

  private transcriptIdentity(): { dev: bigint; ino: bigint; size: number } | undefined {
    try {
      const stat = statSync(this.filePath, { bigint: true })
      return { dev: stat.dev, ino: stat.ino, size: Number(stat.size) }
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }

  private *parseOai(content: string): Generator<void, OaiMessage[]> {
    const lines = content.trim().split('\n').filter(Boolean)
    const messages: OaiMessage[] = []
    for (let offset = 0; offset < lines.length; offset += 100) {
      const { validLines } = verifyLines(lines.slice(offset, offset + 100))
      for (const line of validLines) {
        try {
          const parsed = parseSessionLine(line)
          if (!parsed) continue
          if (isOaiMessage(parsed)) messages.push(parsed)
          else messages.push(...legacyMessageToOaiMessages(parsed as Message).map(message => JSON.parse(JSON.stringify(message)) as OaiMessage))
        } catch { /* skip malformed rows */ }
      }
      yield
    }
    // 压#7: Validate tool_call/tool_result pairing
    // Normalize legacy/partial assistant rows before pairing repair. In
    // particular, an empty `tool_calls` array must not be mistaken for an
    // orphan batch (and must never reach the provider on resume).
    const normalized = normalizeOaiMessages(messages)
    const { messages: repaired, hadOrphans, strippedWriteTool, injectedUncertain } = this.repairOrphanToolCalls(normalized)
    this.lastInjectedUncertain = injectedUncertain
    if (hadOrphans && !(this.recoveryStructuredTools ?? (process.env.RIVET_RECOVERY_STRUCTURED_TOOLS === '1'))) {
      // Orphan tool_use entries were stripped from history: the stream committed
      // a tool_calls block but no matching result durably landed. The interruption
      // can happen at two points, and we cannot tell which from the log alone:
      //   (a) BEFORE the tool ran → any file it would touch is unchanged;
      //   (b) AFTER the tool ran (file already written) but before the result
      //       line was flushed → the file DOES exist with the new content.
      // The old wording asserted "files DO NOT EXIST — re-run", which is false in
      // case (b) and pushes the model into a blind rewrite (→ blind-overwrite
      // guard → stuck). For write/edit tools we must stay non-destructive: verify
      // first, never assume. Read/search tools are safe to just re-run.
      repaired.unshift({
        role: 'system',
        content: strippedWriteTool
          ? '<system-reminder>The previous session was interrupted mid-turn. '
            + 'A write/edit tool call from the last assistant message was stripped '
            + 'because its result was not recorded — but the interruption may have '
            + 'happened either before OR after the file was actually written, so the '
            + 'file may or may not already contain the intended changes. Do NOT blindly '
            + 're-run the write. First verify the file\'s current state with read_file '
            + 'or grep, then only write what is still missing. This is host-process '
            + 'interruption recovery, NOT a tool malfunction — the write tools remain '
            + 'fully functional; keep using them normally instead of bash workarounds.</system-reminder>'
          : '<system-reminder>The previous session was interrupted mid-turn. '
            + 'Some tool calls from the last assistant message were stripped because '
            + 'their results were not recorded. Re-run any read-only/search steps you '
            + 'still need; verify state before assuming any side effects took hold.</system-reminder>',
      })
    }
    return repaired.map(normalizeOaiMessage)
  }

  /**
   * PLAN §4 恢复设计第 3 步：为「已发出但结果未知」的工具生成显式说明。
   * 写工具的措辞必须**非破坏性**——中断可能发生在写盘前或写盘后，文件可能已含
   * 目标改动；先核实再补写，绝不盲目重放。只读工具可安全重跑。
   */
  static orphanToolOutcomeNote(name: string): string {
    // 判据是**白名单**：只有确知无副作用的只读工具允许重跑，其余一律按「可能已产生
    // 副作用」处理。此前只把五种文件编辑工具当有副作用，于是 bash / git / MCP 发送类
    // 工具都拿到了「可用相同参数安全重跑」——那会诱导模型重复执行外部操作（发消息、
    // 推分支、跑迁移），是本类恢复里最贵的一种错。
    return isSafeToRerun(name)
      ? `结果未知：进程中断，未收到 ${name} 的结果。这是只读 / 查询类工具，`
        + '可用相同参数安全重跑；不要假设它已经成功。'
      : `结果未知：进程中断，未收到 ${name} 的结果。该工具**可能已经产生了副作用**`
        + '（写文件 / 执行命令 / 发出外部请求），也可能什么都没做。不要自动重放：'
        + '先用 read_file / grep 等只读手段核实它当前的真实状态（文件内容、git 状态、'
        + '外部系统的记录），再决定是否需要补做；仍不确定就问用户。'
  }

  /** 压#7: Remove orphan tool_use/tool_result pairs left by corrupted/missing lines.
   *
   * Orphan tool_use entries occur when the stream delivered a complete
   * tool_calls block but the process was killed before the tool executed
   * (force-kill, power loss, or stream error after tool_use commit). The tool
   * was NEVER run — any files it would have created/modified do NOT exist.
   * Returns whether any orphans were stripped so the caller can warn the model
   * not to assume side effects from the removed tools, plus whether any stripped
   * orphan was a write/edit tool (so the warning can be non-destructive: the
   * file may already hold the change, verify before re-running). */
  private repairOrphanToolCalls(messages: OaiMessage[]): {
    messages: OaiMessage[]
    hadOrphans: boolean
    strippedWriteTool: boolean
    /** 结构化模式下被注入「结果未知」的工具（供 UI 侧标待确认）。 */
    injectedUncertain: Array<{ id: string; name: string }>
  } {
    const toolCallIds = new Set<string>()
    const toolResultIndices = new Map<string, number>()
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) { if (tc.id) toolCallIds.add(tc.id) }
      }
      if (msg.role === 'tool' && msg.tool_call_id) {
        toolResultIndices.set(msg.tool_call_id, i)
      }
    }
    const orphanResultIdx = new Set<number>()
    for (const [id, idx] of toolResultIndices) {
      if (!toolCallIds.has(id)) orphanResultIdx.add(idx)
    }

    // Pass 1: collect valid messages (strip orphan tool_calls, drop orphan results)
    const result: OaiMessage[] = []
    const injectedUncertain: Array<{ id: string; name: string }> = []
    let hadOrphans = false
    let strippedWriteTool = false
    // fail-closed：只要被剔除的孤儿里有**任何一个**不在只读白名单内，批量提示就走
    // 非破坏性措辞。此前判据是「是不是文件编辑工具」，于是被剔除的 bash / git / MCP
    // 发送类工具会落进「重跑你需要的只读步骤」那一支——同一族漏判。
    const noteStripped = (tc: OaiToolCall): void => {
      if (!isSafeToRerun(tc.function?.name ?? '')) strippedWriteTool = true
    }
    // PLAN §4 第 3 步（默认关，灰度）：开启时不再静默剔除孤儿工具，而是保留
    // tool_call 并紧随注入「结果未知」的合成 tool 消息，让模型与 UI 都看见事实。
    const structured = this.recoveryStructuredTools ?? (process.env.RIVET_RECOVERY_STRUCTURED_TOOLS === '1')
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!
      // Drop orphan tool results
      if (orphanResultIdx.has(i)) { hadOrphans = true; continue }
      // Strip orphan tool_calls from assistant messages
      if (msg.role === 'assistant' && msg.tool_calls) {
        const valid = msg.tool_calls.filter(tc => tc.id && toolResultIndices.has(tc.id))
        const orphaned = msg.tool_calls.filter(tc => !(tc.id && toolResultIndices.has(tc.id)))
        if (structured && orphaned.length > 0) {
          hadOrphans = true
          orphaned.forEach(noteStripped)
          // 无 id 的孤儿无法与 tool 消息配对，只能剔除；有 id 的全部保留并注入结果。
          const kept = msg.tool_calls.filter(tc => tc.id)
          const injectable = orphaned.filter(tc => tc.id)
          if (kept.length === 0 && !msg.content) continue
          result.push({ ...msg, tool_calls: kept })
          for (const tc of injectable) {
            const name = tc.function?.name ?? ''
            const note: OaiMessage = {
              role: 'tool',
              tool_call_id: tc.id,
              content: SessionPersist.orphanToolOutcomeNote(name),
            }
            result.push(note)
            injectedUncertain.push({ id: tc.id, name })
          }
          continue
        }
        // Drop the message entirely if all tool_calls were orphan and content is empty
        if (valid.length === 0 && !msg.content) { hadOrphans = true; orphaned.forEach(noteStripped); continue }
        if (valid.length !== msg.tool_calls.length) {
          hadOrphans = true
          orphaned.forEach(noteStripped)
          result.push({ ...msg, tool_calls: valid })
          continue
        }
      }
      result.push(msg)
    }
    return { messages: result, hadOrphans, strippedWriteTool, injectedUncertain }
  }

  /** Audit breadcrumb types: skipped on replay (parseSessionLine), preserved across rewrites. */
  private static readonly AUDIT_LINE_TYPES = new Set(['compact_start', 'compact_end', 'model_switch'])

  /**
   * Collect audit breadcrumb lines from the current file, re-checksummed for a
   * full rewrite. Rewrites (compact / compactOai / compactOaiAsync) regenerate
   * the file from in-memory messages only, and audit lines never enter memory
   * (parseSessionLine skips them on replay) — without this, the first rewrite
   * after appendModelSwitch silently destroys the audit trail.
   */
  private collectAuditLines(): string[] {
    if (!existsSync(this.filePath)) return []
    try {
      const lines = this.readTranscriptText().trim().split('\n').filter(Boolean)
      const { validLines } = verifyLines(lines)
      const audit: string[] = []
      for (const json of validLines) {
        try {
          const parsed = JSON.parse(json) as { type?: string }
          if (typeof parsed.type === 'string' && SessionPersist.AUDIT_LINE_TYPES.has(parsed.type)) {
            audit.push(appendChecksum(json))
          }
        } catch { /* skip malformed rows */ }
      }
      return audit
    } catch {
      return []
    }
  }

  /** Compact the session file with the given messages (with checksums) */
  compact(messages: Message[]): void {
    this.batchWriter.flushSync()
    const audit = this.collectAuditLines()
    const content = [...audit, ...messages.map(m => appendChecksum(serializeSessionMessage(m)))].join('\n') + '\n'
    writeFileAtomicSync(this.filePath, encodeBatch(content))
    // 重写会**缩短**转录：水位必须跟着落到新条数（旧口径只增不减，重写后必然虚高）。
    this.transcriptWatermark = messages.length
  }

  /** Compact the session file with OAI-format messages */
  compactOai(messages: OaiMessage[]): void {
    this.batchWriter.flushSync()
    const audit = this.collectAuditLines()
    const content = [...audit, ...messages.map(m => appendChecksum(serializeOaiSessionMessage(m)))].join('\n') + '\n'
    writeFileAtomicSync(this.filePath, encodeBatch(content))
    // 重写会**缩短**转录：水位必须跟着落到新条数（旧口径只增不减，重写后必然虚高）。
    this.transcriptWatermark = messages.length
  }

  /** Async atomic compaction — avoids blocking the agent loop on full rewrites (S13). */
  async compactOaiAsync(messages: OaiMessage[], durable = false): Promise<void> {
    await this.flushSessionBuffer()
    const audit = this.collectAuditLines()
    const content = [...audit, ...messages.map(m => appendChecksum(serializeOaiSessionMessage(m)))].join('\n') + '\n'
    await (durable ? writeFileAtomicDurableAsync : writeFileAtomicAsync)(this.filePath, encodeBatch(content))
    this.transcriptWatermark = messages.length
  }

  /** Delete the session file */
  delete(): void {
    try { unlinkSync(this.filePath) } catch { /* ignore */ }
  }

  /**
   * 带校验和的 append（入队批处理）
   */
  async appendWithChecksum(message: Message): Promise<void> {
    const json = serializeSessionMessage(message)
    const line = appendChecksum(json) + '\n'
    this.batchWriter.enqueueLine(line)
  }

  /**
   * 带校验和的 load（向后兼容）
   */
  loadWithChecksum(): Message[] {
    const content = this.readTranscriptText()
    const lines = content.trim().split('\n').filter(Boolean)
    
    const { validLines, invalidCount } = verifyLines(lines)
    
    // 记录校验失败（可选：写入日志或返回统计）
    if (invalidCount > 0) {
      // 可以在这里添加日志记录
    }

    return validLines.map(line => {
      try {
        const parsed = parseSessionLine(line)
        if (!parsed) return null
        return parsed as Message
      } catch { return null }
    }).filter(Boolean) as Message[]
  }

  /**
   * 写入 compact 开始标记
   */

  /**
   * 写入 compact 结束标记
   */

  /**
   * 检测 incomplete compact
   * @returns 是否检测到 incomplete compact
   */




  /** Get the session file path */
  getPath(): string {
    return this.filePath
  }

  writeMetadata(metadata: SessionMetadata): void {
    this.metaStore.write(metadata)
    this.refreshListCacheEntry()
  }

  /** Upsert specific metadata fields without overwriting others */
  updateMetadata(patch: Partial<SessionMetadata>): void {
    this.metaStore.update(patch, this.sessionId)
    this.refreshListCacheEntry()
  }

  /**
   * S3 压缩事件持久化：把一次压缩事件并入 meta 的 compactEvents 台账并**同步落盘**。
   *
   * - 幂等：按完整事件身份（compactEventKey）判重，重复投递（恢复回种/重试）
   *   不产生第二条；同一轮的多次合法压缩（createdAt 不同）全部保留。
   * - 上限：沿用内存账本的容量（MAX_PERSISTED_COMPACT_EVENTS），旧事件滚出。
   * - 落盘：压缩是低频事件（会话内个位数~几十次），走 metaStore.flush 同步写，
   *   沿用项目既有 flush 语义——写失败保留 dirty 并抛出，**不伪报成功**；
   *   flush 前失败的下一次批量 flush 会重试。
   * - 入参未就绪（无 meta 文件）时 updateMetadata 走合并语义，不丢其它字段。
   */
  appendCompactEvent(event: CompactEvent): void {
    const existing = this.loadMetadata()?.compactEvents ?? []
    // 判重看身份是否已存在，**不看长度**——台账满员时新事件会挤出旧事件，
    // 长度不变但内容已变（用长度判重会静默丢掉满员后的每一次压缩）。
    if (existing.some(e => compactEventKey(e) === compactEventKey(event))) return
    const next = mergeCompactEvent(existing, event)
    this.updateMetadata({ compactEvents: next })
    this.metaStore.flush()
  }

  /**
   * 把本会话的最新 metadata 增量并入会话列表缓存（纯内存，无磁盘 I/O），
   * 而不是整表失效。此前每次 append 都 invalidateListCache——append 监听器
   * 每条消息都会走 updateMetadata，而 loadPrevHandoff 在每个 LLM round 都读
   * 列表，活跃会话期间缓存命中率恒为 0，每轮全量 readdirSync + 逐会话重读。
   * 增量 upsert 保持同样的新鲜度语义：新建/更新立即可见、updatedAt 排序即时
   * 重排；TTL 不动，外部进程的文件变化仍按原 60s 窗口被吸收。
   */
  private refreshListCacheEntry(): void {
    const meta = this.metaStore.load()
    if (meta === undefined) return
    SessionPersist.upsertListCacheEntry(this.cwd, SessionPersist.buildListEntry(this.sessionId, meta))
  }

  /** Initialize metadata for a new session if not already present */
  initMetadata(init?: Partial<SessionMetadata>): void {
    if (existsSync(this.metadataPath)) return
    this.writeMetadata({
      sessionId: this.sessionId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      compactEvents: [],
      status: 'active',
      turnCount: 0,
      toolCallCount: 0,
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      ...init,
    })
  }

  loadMetadata(): SessionMetadata | undefined {
    return this.metaStore.load()
  }

  /**
   * 冻结前缀快照落盘（`<id>.frozen.json`）——resume 缓存继承的写侧。
   * 由 PromptEngine 的 onFrozenSnapshotCommit 钩子在每个 user 边界触发（低频）。
   */
  writeFrozenSnapshot(data: FrozenSnapshotData): void {
    writeFileAtomicSync(this.frozenPath, JSON.stringify(data))
  }

  /**
   * 读回冻结前缀快照（resume 缓存继承的读侧）。
   * 不存在 / 坏 JSON / 形状校验失败一律 undefined——调用方降级为全量重建。
   */
  readFrozenSnapshot(): FrozenSnapshotData | undefined {
    if (!existsSync(this.frozenPath)) return undefined
    try {
      const data = parseFrozenSnapshotData(JSON.parse(readFileSync(this.frozenPath, 'utf-8')))
      if (!data) this.frozenSaveError = 'snapshot_corrupt'
      return data
    } catch {
      this.frozenSaveError = 'snapshot_corrupt'
      return undefined
    }
  }

  loadMemory(): SessionMemoryState {
    return loadSessionMemory(getSessionDir(this.cwd), this.sessionId)
  }

  appendMemory(input: { text: string; source: SessionMemoryEntry['source']; createdAt: number }): SessionMemoryState {
    return appendSessionMemory(getSessionDir(this.cwd), this.sessionId, input)
  }

  buildMemoryBlock(): string {
    return buildSessionMemoryBlock(this.loadMemory())
  }

  getSessionMemoryState(): LedgerSessionMemoryState | undefined {
    const memory = this.loadMemory()
    if (memory.entries.length === 0) return undefined
    const block = buildSessionMemoryBlock(memory)
    return {
      path: join(getSessionDir(this.cwd), `${this.sessionId}.memory.json`),
      lastSummarizedRoundIndex: -1,
      lastUpdatedAt: memory.entries[memory.entries.length - 1]?.createdAt ?? Date.now(),
      digest: block.length > 200 ? block.slice(0, 197) + '...' : block,
      stale: false,
      tokenEstimate: block.length,
    }
  }

  /** Create a claim store for the current session. */
  createClaimStore(): ContextClaimStore {
    return new ContextClaimStore(getSessionDir(this.cwd), this.sessionId)
  }

  /** Load durable claims from the most recent previous main session.
   *  listMainSessions 排除 worker-/带点伪 id（`<id>.claims`）并按 updatedAt 降序——
   *  listSessions + sort().pop() 会选中伪条目（恒返回 []）或非最近会话。 */
  loadPreviousDurableClaims(): ContextClaim[] {
    const previous = SessionPersist.listMainSessions(this.cwd).find(s => s.id !== this.sessionId)
    return previous ? ContextClaimStore.loadDurableClaims(getSessionDir(this.cwd), previous.id) : []
  }

  /** Inject durable claims from previous session into a claim store with confidence decay.
   *  A4: cross-session pollution gate — only inject claims that intersect with current
   *  project files AND were created within 7 days. */
  injectDurableClaims(store: ContextClaimStore, cwd?: string): void {
    const now = Date.now()
    const TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
    const durableClaims = this.loadPreviousDurableClaims()
    for (const claim of durableClaims) {
      // A4 TTL gate: skip claims older than 7 days
      if (now - claim.createdAt > TTL_MS) continue
      // A4 file intersection gate: skip claims whose evidence files don't
      // intersect with current project. Normalize relative paths with cwd.
      // Claims with no file evidence (conceptual/verification) always pass.
      if (cwd) {
        const fileEvidence = claim.evidence.filter(e => e.path)
        if (fileEvidence.length > 0) {
          const hasRelevantFile = fileEvidence.some(e => {
            const abs = resolve(cwd, e.path!)
            // P3: exact prefix boundary — /Users/a/proj must not match /Users/a/proj-backup.
            // Use path.relative (cross-platform; handles Windows separators/drive) instead
            // of string prefix: inside iff rel is '' or a non-'..', non-absolute subpath.
            const rel = relative(cwd, abs)
            return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
          })
          if (!hasRelevantFile) continue
        }
      }
      store.propose({
        kind: claim.kind,
        scope: claim.scope,
        text: claim.text,
        confidence: claim.confidence * 0.9,
        fitness: claim.fitness,
        source: { ...claim.source, eventId: `resume:${claim.id}` },
        evidence: claim.evidence,
        createdAt: Date.now(),
        tags: [...claim.tags, 'resumed'],
      })
    }
  }

  /** Write structured handoff text for this session. */
  writeHandoff(text: string): void {
    writeFileAtomicSync(this.getHandoffPath(), text)
    writeHandoffCoverage(this.getHandoffPath(), this.sessionId, text, this.loadMetadata()?.turnCount ?? 0)
  }

  writeHandoffTail(text: string): void { writeHandoffTail(this.getHandoffPath(), this.sessionId, text, this.loadMetadata()?.turnCount ?? 0) }

  /** 会话归档交接文档路径（`<id>.handoff.md`）——loadPrevHandoff 注入管线认的位置。 */
  getHandoffPath(): string {
    return join(getSessionDir(this.cwd), `${this.sessionId}.handoff.md`)
  }

  /**
   * Load the most relevant previous session's handoff text.
   * Routes by domain if both sessions have a domain tag; otherwise falls back
   * to the most recently updated session. Returns null if none found.
   */
  static loadPrevHandoff(cwd: string, currentSessionId: string, currentDomain?: string): string | null {
    const sessions = SessionPersist.listSessionsWithMetadata(cwd)
      .filter(s => s.id !== currentSessionId)
    if (sessions.length === 0) return null

    // Prefer same-domain sessions; fall back to all
    let candidates = sessions
    if (currentDomain) {
      const sameDomain = sessions.filter(s => s.domain === currentDomain)
      if (sameDomain.length > 0) candidates = sameDomain
    }

    // listSessionsWithMetadata already sorts by updatedAt desc
    const prev = candidates[0]
    if (!prev) return null

    const handoffPath = join(getSessionDir(cwd), `${prev.id}.handoff.md`)
    if (!existsSync(handoffPath)) return null
    try {
      return readHandoffWithCoverage(handoffPath, prev.id, prev.turnCount ?? 0)
    } catch {
      return null
    }
  }

  /** List all session files */
  static listSessions(cwd: string): string[] {
    const dir = getSessionDir(cwd)
    ensureDir(dir)
    try {
      return readdirSync(dir)
        .filter((f: string) => f.endsWith('.jsonl'))
        .map((f: string) => f.replace('.jsonl', ''))
    } catch {
      return []
    }
  }

  /**
   * Cache for listSessionsWithMetadata — avoids re-reading hundreds of session
   * meta files on every user boundary when cross-session handoff is requested.
   * TTL: 60s. Writes upsert the session's own entry incrementally
   * (refreshListCacheEntry) so the hot append path never cold-rows the cache.
   * Keyed by cwd since sessions are per-project.
   */
  private static _listCache: Map<string, { ts: number; data: Array<SessionMetadata & { id: string }> }> = new Map()
  private static readonly LIST_CACHE_TTL_MS = 60_000

  static invalidateListCache(): void {
    SessionPersist._listCache.clear()
  }

  /** 移除单会话的缓存条目（硬删链——文件删除后条目不得在重建中复活）。 */
  static removeListCacheEntry(id: string): void {
    for (const cached of SessionPersist._listCache.values()) {
      const idx = cached.data.findIndex((e) => e.id === id)
      if (idx >= 0) cached.data.splice(idx, 1)
    }
  }

  /** 统一的列表条目形状——全量构建与增量 upsert 共用，防两处漂移。 */
  private static buildListEntry(id: string, meta: SessionMetadata | undefined): SessionMetadata & { id: string } {
    return {
      id,
      sessionId: id,
      createdAt: meta?.createdAt ?? 0,
      updatedAt: meta?.updatedAt ?? 0,
      compactEvents: meta?.compactEvents ?? [],
      ...meta,
    }
  }

  /**
   * 缓存命中时把单会话条目原位并入列表。不替换数组、不刷新 ts：
   * 命中路径的契约本来就是"同一 cwd 的多次 list 返回同一数组"，写入原位生效
   * 即是该契约下的新鲜度语义；ts 不动则 TTL 仍按首次构建计时，外部进程的
   * 文件变化照旧在 60s 窗口内被吸收。
   */
  private static upsertListCacheEntry(cwd: string, entry: SessionMetadata & { id: string }): void {
    const cached = SessionPersist._listCache.get(cwd)
    if (!cached) return // 缓存未建——下次 list 全量构建时自然包含本会话
    const idx = cached.data.findIndex((e) => e.id === entry.id)
    if (idx >= 0) cached.data[idx] = { ...cached.data[idx], ...entry }
    else cached.data.push(entry)
    cached.data.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }

  /** List sessions with metadata, sorted by updatedAt descending (most recent first) */
  static listSessionsWithMetadata(cwd: string): Array<SessionMetadata & { id: string }> {
    const now = Date.now()
    const cached = SessionPersist._listCache.get(cwd)
    if (cached && (now - cached.ts) < SessionPersist.LIST_CACHE_TTL_MS) {
      return cached.data
    }

    const ids = SessionPersist.listSessions(cwd)
    const results: Array<SessionMetadata & { id: string }> = []
    for (const id of ids) {
      try {
        const p = new SessionPersist(id, cwd)
        results.push(SessionPersist.buildListEntry(id, p.loadMetadata()))
      } catch {
        // Skip corrupted sessions
      }
    }
    results.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    SessionPersist._listCache.set(cwd, { ts: now, data: results })
    return results
  }

  /**
   * Main user-facing sessions only: excludes worker sub-sessions (`worker-*`)
   * and non-transcript artifacts whose id carries a dotted suffix
   * (`<id>.claims`, `<id>.memory`, `<id>.snapshot`). Sorted by updatedAt desc.
   */
  static listMainSessions(cwd: string): Array<SessionMetadata & { id: string }> {
    return SessionPersist.listSessionsWithMetadata(cwd)
      .filter(s => !s.id.startsWith('worker-') && !s.id.includes('.'))
  }

  /**
   * Resolve a user-supplied session reference (full id or short prefix) to a
   * single full session id. Exact match wins; otherwise prefix-match across
   * main sessions. Returns the resolved id, an ambiguous candidate list, or
   * null when nothing matches. The id = log id = resume id are the same value.
   */
  static resolveSessionId(
    cwd: string,
    ref: string,
  ): { id: string } | { ambiguous: string[] } | null {
    const ref0 = ref.trim()
    if (!ref0) return null
    const sessions = SessionPersist.listMainSessions(cwd)
    const exact = sessions.find(s => s.id === ref0)
    if (exact) return { id: exact.id }
    const matches = sessions.filter(s => s.id.startsWith(ref0))
    if (matches.length === 1) return { id: matches[0]!.id }
    if (matches.length > 1) return { ambiguous: matches.map(s => s.id) }
    return null
  }

  /**
   * Render the session list for CLI `--list` and TUI `/sessions`. One row per
   * main session, numbered to match `listMainSessions` ordering so the index is
   * stable and aligned with prefix-based resume.
   */
  static formatSessionList(cwd: string, currentId?: string): string {
    const sessions = SessionPersist.listMainSessions(cwd)
    if (sessions.length === 0) return '没有历史会话。'
    return sessions.map((s, i) => {
      const marker = s.id === currentId ? '  ← 当前' : ''
      const when = formatRelativeTime(s.updatedAt ?? 0)
      const turns = s.turnCount ?? 0
      const model = s.model ?? '?'
      const domain = s.domain ? ` ${s.domain}` : ''
      const title = (s.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 50)
      return `${String(i + 1).padStart(2)}. ${s.id.slice(0, 8)}  ${when}  ${turns}轮  ${model}${domain}  ${title}${marker}`
    }).join('\n')
  }
}

/**
 * Exit summary printed after TUI teardown — tells the user which session was
 * saved and how to reconnect (Claude Code parity: the id must survive on the
 * scrollback, otherwise resume is undiscoverable). Returns null for sessions
 * with no completed turns — nothing worth resuming, keep the exit quiet.
 */
export function formatExitSummary(
  meta: Pick<SessionMetadata, 'title' | 'turnCount'> | null | undefined,
  sessionId: string,
): string | null {
  const turns = meta?.turnCount ?? 0
  if (turns <= 0) return null
  const short = sessionId.slice(0, 8)
  const title = (meta?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
  const head = `会话已保存: ${short} · ${turns}轮${title ? ` · “${title}”` : ''}`
  // 告别行在前、事实在后：退出时刻也是品牌触点（✦ = 天枢启明星）。
  // 缓存成本备注：回连不是免费的——TTL 内继承冻结锚点 ≈ 只读缓存价，
  // 过期则整段历史全量重建一次前缀（长会话数元级），随手 --continue 前看一眼。
  return `✦ 后会有期 — 星轨已存档\n${head}\n恢复: rivet --continue（最近会话）或 rivet --resume ${short}\n缓存成本：尽快回连 ≈ 继承冻结锚点（只读缓存价）；间隔过久缓存过期 → 全量重建一次前缀（长会话数元级）。`
}

export { shouldAutoWriteHandoff } from './handoff-coverage.js'

/** Compact relative time for session lists, e.g. "刚刚" / "5分钟前" / "3天前". */
function formatRelativeTime(ts: number): string {
  if (!ts) return '未知'
  const diff = Date.now() - ts
  if (diff < 0) return '刚刚'
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return '刚刚'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}天前`
  const mon = Math.floor(day / 30)
  if (mon < 12) return `${mon}个月前`
  return `${Math.floor(mon / 12)}年前`
}

const MAX_SESSIONS = 50

export function evictOldSessions(keepSessionId: string, cwd: string): string[] {
  return evictOldSessionsInternal(getSessionDir(cwd), keepSessionId, MAX_SESSIONS)
}

export function evictOldSessionsInternal(dir: string, keepSessionId: string, limit: number): string[] {
  ensureDir(dir)
  let sessions: string[]
  try {
    sessions = readdirSync(dir)
      .filter((f: string) => f.endsWith('.jsonl'))
      .map((f: string) => f.replace('.jsonl', ''))
      // 只有主会话占 MAX_SESSIONS 额度（与 listMainSessions 同语义）。曾经全量计数：
      // - worker-*.jsonl 每次派发新文件（nonce 不复用），team/galaxy 重度使用即洪水
      //   （实测 46/65 个坑被 worker 占掉），把更老的主会话挤出额度——桌面端会话的
      //   模型上下文被静默驱逐，重开后 UI 有历史、模型失忆、上下文 0%。
      //   worker 文件生命周期归 cleanupStaleWorkerSessionDirs（独立阈值）。
      // - 带点的 id（<id>.claims 等）是主会话附属文件，不是会话；被误计还会被
      //   当作"最老会话"驱逐，损坏在用主会话的 claims。
      .filter((id: string) => !id.startsWith('worker-') && !id.includes('.'))
  } catch {
    return []
  }

  if (sessions.length <= limit) return []

  // Sort by mtime (oldest first) so eviction removes least-recently-used sessions.
  // UUIDs are not time-ordered — lexicographic sort would delete arbitrary sessions.
  const withMtime = sessions.map(id => {
    let mtime = 0
    try { mtime = statSync(join(dir, `${id}.jsonl`)).mtimeMs } catch { /* ignore */ }
    return { id, mtime }
  })
  withMtime.sort((a, b) => a.mtime - b.mtime)

  const toEvict = withMtime
    .filter(({ id }) => id !== keepSessionId)
    .slice(0, sessions.length - limit)
    .map(({ id }) => id)

  for (const id of toEvict) removeSessionFilesIn(dir, id)

  return toEvict
}

/** 删除某会话在 dir 下的全部落盘文件（硬删链与 LRU 驱逐共用同一清理面）。
 *  含同名子目录：getBackupDir() 会创建 <id>/backups/，不随主文件消失。 */
function removeSessionFilesIn(dir: string, id: string): void {
  try { unlinkSync(join(dir, `${id}.jsonl`)) } catch { /* ignore */ }
  try { unlinkSync(join(dir, `${id}.meta.json`)) } catch { /* ignore */ }
  try { unlinkSync(join(dir, `${id}.memory.json`)) } catch { /* ignore */ }
  try { unlinkSync(join(dir, `${id}.claims.jsonl`)) } catch { /* ignore */ }
  try { unlinkSync(join(dir, `${id}.frozen.json`)) } catch { /* ignore */ }
  for (const suffix of ['skills.json', 'skill-modes.json']) {
    try { unlinkSync(join(dir, `${id}.${suffix}`)) } catch { /* ignore */ }
  }
  try { rmSync(join(dir, id), { recursive: true, force: true }) } catch { /* ignore */ }
}

/**
 * 硬删会话的落盘清理（deleteSession/hardDelete 链）：删除 transcript/meta/
 * memory/claims/frozen 与同名子目录，并移除列表缓存条目。此前硬删只清 events
 * 子目录与内存 record——落盘残留让 listSessionsWithMetadata 在全量重建后仍
 * 列出已删会话（2026-09-16 审查修复，探针实测）。
 */
export function deleteSessionFiles(cwd: string, id: string): void {
  removeSessionFilesIn(getSessionDir(cwd), id)
  SessionPersist.removeListCacheEntry(id)
}

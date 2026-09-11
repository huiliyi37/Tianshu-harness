/**
 * Write-behind batch writer for session transcripts.
 *
 * Lines queue in memory and flush as one checksummed zstd frame per batch —
 * either after a 200ms timer window, an explicit flush barrier (LLM request,
 * /cd migration, shutdown drain), or compaction. The first line of a
 * brand-new session flushes synchronously so the session file exists
 * immediately (listSessions resolves sessions by .jsonl presence).
 */

import { appendFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs'
import { appendFile, open } from 'node:fs/promises'
import { join } from 'node:path'
import { encodeBatch, isZstdFrameStream } from './session-transcript-codec.js'
import { writeFileAtomicSync } from '../fs-atomic.js'

export class SessionBatchWriter {
  /** Write-behind batch: JSONL text waiting for the next flush. */
  private pendingBuffer = ''
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private flushPromise: Promise<void> | null = null
  /** Set once the transcript file is known to be zstd-frame format. */
  private codecReady = false

  constructor(
    private readonly filePath: string,
    private readonly backupDirProvider: () => string,
  ) {}

  /**
   * Queue a JSONL line into the batch. The batch is flushed by a 200ms timer,
   * an explicit flush barrier, or compaction — whichever comes first.
   *
   * Exception: the first line of a brand-new session flushes synchronously so
   * the session file exists immediately, and a crash within the first 200ms
   * cannot lose the entire session.
   */
  enqueueLine(line: string): void {
    this.pendingBuffer += line
    if (this.flushTimer === null) {
      if (!this.codecReady && !existsSync(this.filePath)) {
        this.flushSync()
        return
      }
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null
        void this.flush().catch(err => {
          // eslint-disable-next-line no-console
          console.error('[session-persist] batch flush failed:', err)
        })
      }, 200)
      this.flushTimer.unref?.()
    }
  }

  /**
   * Flush barrier: cancel the timer, drain the pending batch into one
   * checksummed zstd frame append + datasync. Concurrent callers share the
   * in-flight drain promise; a drain that arrives while one is already in
   * flight still drains whatever queued in the meantime (the awaited promise
   * only covers the batch it started with).
   *
   * On write failure the batch is put back at the head of the buffer so the
   * next flush / shutdown drain retries it — a failed append must not
   * permanently drop queued lines (ENOSPC etc.).
   */
  async flush(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.flushPromise !== null) return this.flushPromise
    this.flushPromise = this.drainPending().finally(() => { this.flushPromise = null })
    return this.flushPromise
  }

  private async drainPending(): Promise<void> {
    while (this.pendingBuffer.length > 0) {
      const text = this.pendingBuffer
      this.pendingBuffer = ''
      try {
        await this.writeBatch(text)
      } catch (err) {
        this.pendingBuffer = text + this.pendingBuffer
        throw err
      }
    }
  }

  /** Synchronous flush variant for the sync compaction paths. */
  flushSync(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    const text = this.pendingBuffer
    this.pendingBuffer = ''
    if (text.length > 0) {
      this.ensureCodecFormat()
      const frame = encodeBatch(text)
      // mode 仅在文件创建时生效——首次落盘即 0600（转录含未脱敏对话，
      // fs-atomic 的 0600 只覆盖后续重写路径）。
      if (frame.length > 0) appendFileSync(this.filePath, frame, { mode: 0o600 })
    }
  }

  /**
   * Merge the on-disk transcript text with lines still queued in the batch —
   * in-process readers must see un-flushed lines (append followed by load
   * without a flush is valid).
   */
  mergePending(onDiskText: string): string {
    return this.pendingBuffer.length > 0 ? onDiskText + this.pendingBuffer : onDiskText
  }

  private async writeBatch(text: string): Promise<void> {
    this.ensureCodecFormat()
    const frame = encodeBatch(text)
    if (frame.length === 0) return
    await appendFile(this.filePath, frame, { mode: 0o600 })
    await this.fdatasyncQuiet()
  }

  /**
   * One-time migration: on the first write, a legacy plain-text transcript is
   * backed up and transcoded to a single zstd frame so subsequent appends can
   * stay frame-aligned. New files and already-compressed files are untouched.
   */
  private ensureCodecFormat(): void {
    if (this.codecReady) return
    this.codecReady = true
    if (!existsSync(this.filePath)) return
    const head = readFileSync(this.filePath)
    if (isZstdFrameStream(head)) return
    try {
      copyFileSync(this.filePath, join(this.backupDirProvider(), this.filePath.split('/').pop() + '.pre-zstd'))
    } catch { /* best-effort backup; transcode still proceeds */ }
    const frame = encodeBatch(head.toString('utf-8'))
    writeFileAtomicSync(this.filePath, frame.length > 0 ? frame : Buffer.alloc(0))
  }

  /** Force appended data to disk without blocking the event loop. */
  private async fdatasyncQuiet(): Promise<void> {
    try {
      const fh = await open(this.filePath, 'a')
      try {
        await fh.datasync()
      } finally {
        await fh.close()
      }
    } catch { /* non-critical: in-memory state still authoritative */ }
  }
}

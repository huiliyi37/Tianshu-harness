import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionPersist } from '../session-persist.js'
import { SessionBatchWriter } from '../session-batch-writer.js'
import { decodeTranscriptText, encodeBatch, isZstdFrameStream } from '../session-transcript-codec.js'

describe('SessionPersist write-behind codec (P1)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rivet-codec-'))
    process.env.RIVET_SESSION_DIR = tempDir
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    delete process.env.RIVET_SESSION_DIR
    SessionPersist.invalidateListCache()
  })

  it('first line of a new session lands synchronously as a zstd frame', async () => {
    const persist = new SessionPersist('codec-first-line', tempDir)
    await persist.appendOaiWithChecksum({ role: 'user', content: 'hello' })
    assert.ok(existsSync(persist.getFilePath()), 'session file exists immediately after first append')
    const onDisk = readFileSync(persist.getFilePath())
    assert.ok(isZstdFrameStream(onDisk), 'file is a zstd frame stream from the start')
  })

  it('subsequent lines batch into frames flushed by the 200ms timer', async () => {
    const persist = new SessionPersist('codec-batch-timer', tempDir)
    await persist.appendOaiWithChecksum({ role: 'user', content: 'one' })
    await persist.appendOaiWithChecksum({ role: 'assistant', content: 'two' })
    await new Promise(resolve => setTimeout(resolve, 350))
    const loaded = persist.loadOai()
    assert.equal(loaded.length, 2)
    assert.equal(loaded[0]!.content, 'one')
    assert.equal(loaded[1]!.content, 'two')
  })

  it('flush:true makes a critical record durable before append resolves', async () => {
    const persist = new SessionPersist('codec-critical-flush', tempDir)
    await persist.appendOaiWithChecksum({ role: 'user', content: 'one' })
    await persist.appendOaiWithChecksum(
      { role: 'tool', tool_call_id: 't1', content: 'written' },
      { flush: true },
    )
    const raw = decodeTranscriptText(readFileSync(persist.getFilePath()))
    assert.match(raw, /"written"/, 'critical tool result is on disk without waiting for the 200ms timer')
  })

  it('explicit flushSessionBuffer drains the batch immediately', async () => {
    const persist = new SessionPersist('codec-explicit-flush', tempDir)
    await persist.appendOaiWithChecksum({ role: 'user', content: 'one' })
    await persist.appendOaiWithChecksum({ role: 'assistant', content: 'two' })
    await persist.flushSessionBuffer()
    const raw = decodeTranscriptText(readFileSync(persist.getFilePath()))
    assert.match(raw, /"one"/)
    assert.match(raw, /"two"/)
    // 并发 flush 共享同一 in-flight promise，不重复写盘。
    const before = readFileSync(persist.getFilePath()).length
    await Promise.all([persist.flushSessionBuffer(), persist.flushSessionBuffer()])
    assert.equal(readFileSync(persist.getFilePath()).length, before)
  })

  it('legacy plain-text transcript is backed up and transcoded on first write', async () => {
    const persist = new SessionPersist('codec-legacy-migrate', tempDir)
    const legacyLines = [
      '{"role":"user","content":"old one"}|aaaaaaaaaaaaaaaa',
      '{"role":"assistant","content":"old two"}|bbbbbbbbbbbbbbbb',
      '',
    ].join('\n')
    writeFileSync(persist.getFilePath(), legacyLines)
    await persist.appendOaiWithChecksum({ role: 'user', content: 'new one' })
    await persist.flushSessionBuffer()

    const onDisk = readFileSync(persist.getFilePath())
    assert.ok(isZstdFrameStream(onDisk), 'file transcoded to zstd frames')
    const raw = decodeTranscriptText(onDisk)
    assert.match(raw, /"old one"/)
    assert.match(raw, /"old two"/)
    assert.match(raw, /"new one"/)

    const backups = readdirSync(persist.getBackupDir())
    assert.ok(backups.some(f => f.includes('pre-zstd')), 'pre-migration backup exists')
    const backupRaw = decodeTranscriptText(readFileSync(join(persist.getBackupDir(), backups.find(f => f.includes('pre-zstd'))!)))
    assert.match(backupRaw, /"old one"/)
  })

  it('torn final frame from a simulated crash is dropped, earlier frames survive', async () => {
    const persist = new SessionPersist('codec-torn-tail', tempDir)
    await persist.appendOaiWithChecksum({ role: 'user', content: 'survives' })
    await persist.flushSessionBuffer()
    // Simulate a crash mid-frame: append a truncated frame to the file.
    const tornFrame = encodeBatch('{"role":"assistant","content":"torn"}|cccccccccccccccc\n')
    appendFileSync(persist.getFilePath(), tornFrame.subarray(0, Math.max(5, Math.floor(tornFrame.length / 2))))

    const loaded = persist.loadOai()
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0]!.content, 'survives')
  })

  it('compactOaiAsync rewrites as a zstd frame stream preserving content', async () => {
    const persist = new SessionPersist('codec-compact', tempDir)
    await persist.appendOaiWithChecksum({ role: 'user', content: 'one' })
    await persist.appendOaiWithChecksum({ role: 'assistant', content: 'two' })
    await persist.compactOaiAsync(persist.loadOai())

    const onDisk = readFileSync(persist.getFilePath())
    assert.ok(isZstdFrameStream(onDisk), 'compacted file is a zstd frame stream')
    const loaded = persist.loadOai()
    assert.equal(loaded.length, 2)
    assert.equal(loaded[0]!.content, 'one')
    assert.equal(loaded[1]!.content, 'two')
  })

  it('in-process load sees pending lines before any flush (no file yet)', async () => {
    // 首行同步落盘后，第二行仍在批队列——loadOai 必须合并 pending。
    const persist = new SessionPersist('codec-pending-merge', tempDir)
    await persist.appendOaiWithChecksum({ role: 'user', content: 'one' })
    await persist.appendOaiWithChecksum({ role: 'assistant', content: 'two' })
    const loaded = persist.loadOai()
    assert.equal(loaded.length, 2)
    assert.equal(loaded[1]!.content, 'two')
  })

  it('updateMetadata is in-memory until the batch flush (no per-append read-modify-write)', async () => {
    const persist = new SessionPersist('codec-meta-cadence', tempDir)
    persist.initMetadata()
    persist.updateMetadata({ title: 'hot path' })

    // 同实例读：内存缓存立即可见
    assert.equal(persist.loadMetadata()?.title, 'hot path')
    // 磁盘读：flush 前仍是初始值（写入合入批节奏，而非逐次落盘）
    const onDiskBefore = JSON.parse(readFileSync(join(tempDir, 'codec-meta-cadence.meta.json'), 'utf-8'))
    assert.equal(onDiskBefore.title, undefined)

    await persist.flushSessionBuffer()
    const onDiskAfter = JSON.parse(readFileSync(join(tempDir, 'codec-meta-cadence.meta.json'), 'utf-8'))
    assert.equal(onDiskAfter.title, 'hot path')
  })

  it('metadata flush rides every batch flush and shutdown drain', async () => {
    const persist = new SessionPersist('codec-meta-drain', tempDir)
    persist.initMetadata()
    await persist.appendOaiWithChecksum({ role: 'user', content: 'msg' })
    persist.updateMetadata({ turnCount: 3 })
    await persist.flushSessionBuffer()

    // 新实例（模拟重启后进程）从磁盘读回一致
    const fresh = new SessionPersist('codec-meta-drain', tempDir)
    assert.equal(fresh.loadMetadata()?.turnCount, 3)
  })

  it('writeMetadata stays synchronous (initMetadata path unaffected by cadence)', () => {
    const persist = new SessionPersist('codec-meta-sync', tempDir)
    persist.initMetadata({ title: 'sync write' })
    const onDisk = JSON.parse(readFileSync(join(tempDir, 'codec-meta-sync.meta.json'), 'utf-8'))
    assert.equal(onDisk.title, 'sync write')
  })

  it('flush failure requeues the batch instead of dropping it (ENOSPC-class)', async () => {
    // 目标路径是已存在目录 → readFileSync/appendFile 抛 EISDIR：真实 OS 错误，无 mock。
    const dirAsFile = join(tempDir, 'as-a-dir')
    mkdirSync(dirAsFile)
    const writer = new SessionBatchWriter(dirAsFile, () => tempDir)
    writer.enqueueLine('{"v":1,"content":"IMPORTANT_TOOL_RESULT"}\n')
    await assert.rejects(
      () => writer.flush(),
      err => (err as NodeJS.ErrnoException).code === 'EISDIR',
    )
    // 修复前：pendingBuffer 已被清空，这批行永久丢（用户在 UI 里毫无感知）。
    assert.match(writer.mergePending(''), /IMPORTANT_TOOL_RESULT/,
      'failed batch must stay buffered for the next flush/shutdown drain to retry')
  })

  it('flush() during an in-flight drain still flushes lines queued in the meantime', async () => {
    // flush:true 持久化屏障的回归：in-flight 窗口里入队的行不在被 await 的
    // promise 覆盖范围内，也不能只留在内存里没有任何冲刷计划。
    const file = join(tempDir, 'race.jsonl')
    const writer = new SessionBatchWriter(file, () => tempDir)
    writer.enqueueLine('{"n":1}\n')
    writer.flushSync() // 建文件 + 置 codecReady

    writer.enqueueLine('{"n":2}\n')
    const first = writer.flush() // in-flight（真 I/O）

    // 同一 tick：工具结果（flush:true 场景）在 in-flight 窗口里入队，随即被 flush 屏障调用
    writer.enqueueLine('{"n":3,"flushBarrier":true}\n')
    const second = writer.flush()
    await Promise.all([first, second])

    // 屏障返回后批3必须已经在盘上（修复前：悬挂内存且定时器已被清，强杀即丢）
    const onDisk = decodeTranscriptText(readFileSync(file))
    assert.match(onDisk, /"n":2/)
    assert.match(onDisk, /"n":3,"flushBarrier":true/,
      'line queued during an in-flight flush must be durable once the barrier resolves')
    assert.equal(writer.mergePending(''), '', 'nothing left hanging in the buffer')
  })
})

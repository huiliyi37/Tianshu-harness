import './disable-cpu-pool.js' // must precede session-persistence import (worker hangs node:test)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, appendFileSync, readdirSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileSessionPersistence } from '../session-persistence.js'
import type { SessionEvent, SessionRecord } from '../session-manager.js'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'rivet-persist-'))
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function rec(id: string, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    status: 'running',
    createdAt: 1,
    updatedAt: 2,
    cwd: '/work',
    lastSeq: 0,
    pendingApprovals: 0,
    ...over,
  }
}

function ev(seq: number, type: SessionEvent['type'] = 'text_delta'): SessionEvent {
  return { seq, ts: 100 + seq, type, data: { text: `e${seq}` } }
}

test('round-trips record + events', () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    p.saveRecord(rec('s1'))
    p.appendEvent('s1', ev(1))
    p.appendEvent('s1', ev(2))
    const all = p.loadAll()
    assert.equal(all.length, 1)
    assert.equal(all[0]!.record.id, 's1')
    assert.equal(all[0]!.events.length, 2)
    assert.deepEqual(all[0]!.events.map((e) => e.seq), [1, 2])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt trailing line is dropped, not fatal', () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    p.saveRecord(rec('s1'))
    p.appendEvent('s1', ev(1))
    p.appendEvent('s1', ev(2))
    // Events are write-buffered (100ms debounce) — flush so they hit disk
    // BEFORE the corruption is injected, mirroring a crash after a clean batch.
    p.flushSync()
    // Simulate a crash mid-write: a half-written final line.
    appendFileSync(join(dir, 's1', 'events.jsonl'), '{"seq":3,"ts":1,"type":"tex')
    const all = p.loadAll()
    assert.equal(all[0]!.events.length, 2, 'partial line must be skipped')
    assert.equal(all[0]!.events[1]!.seq, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('events are sorted by seq; seq does not regress', () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    p.saveRecord(rec('s1'))
    p.appendEvent('s1', ev(2))
    p.appendEvent('s1', ev(1))
    p.appendEvent('s1', ev(3))
    const evs = p.loadAll()[0]!.events
    assert.deepEqual(evs.map((e) => e.seq), [1, 2, 3])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('missing index.json is reconstructed from event tail', () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    // Write only events (no saveRecord) — simulate a record that never flushed.
    p.appendEvent('s9', ev(1))
    p.appendEvent('s9', ev(2))
    const all = p.loadAll()
    assert.equal(all.length, 1)
    assert.equal(all[0]!.record.id, 's9')
    assert.equal(all[0]!.record.lastSeq, 2)
    assert.equal(all[0]!.record.status, 'aborted')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('saveRecord is atomic (no stray tmp left behind)', async () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    p.saveRecord(rec('s1', { status: 'completed' }))
    await p.flushAllAsync() // write-behind：latest-wins 异步链排空后断言
    const files = readdirSync(join(dir, 's1'))
    assert.ok(files.includes('index.json'))
    assert.ok(!files.includes('index.json.tmp'), 'tmp file must be renamed away')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('critical events hit disk immediately, without waiting for the debounce flush', async () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    p.saveRecord(rec('s1'))
    // A delta buffers (debounced)…
    p.appendEvent('s1', ev(1, 'text_delta'))
    // …but a tool_result must be durable the moment append returns — this is
    // the crash window that used to lose the tail ("tool result lost").
    p.appendEvent('s1', ev(2, 'tool_result'))
    // write-behind：critical 触发异步写链立即排空（毫秒级窗口换事件循环不死）。
    await p.flushSessionAsync('s1')
    const raw = readFileSync(join(dir, 's1', 'events.jsonl'), 'utf8')
    const seqs = raw.trim().split('\n').map((l) => (JSON.parse(l) as SessionEvent).seq)
    // The critical flush drains the whole buffer (one batched write), so the
    // earlier delta rides along — nothing is left in memory to lose.
    assert.deepEqual(seqs, [1, 2])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('non-critical events stay buffered until debounce/flushSync (no per-delta write)', () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    p.saveRecord(rec('s1'))
    p.appendEvent('s1', ev(1, 'text_delta'))
    p.appendEvent('s1', ev(2, 'thinking_delta'))
    assert.equal(
      existsSync(join(dir, 's1', 'events.jsonl')), false,
      'deltas must not trigger an immediate write',
    )
    p.flushSync()
    const raw = readFileSync(join(dir, 's1', 'events.jsonl'), 'utf8')
    assert.equal(raw.trim().split('\n').length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('every critical type flushes immediately', async () => {
  const critical = [
    'user',
    'tool_result',
    'status',
    'error',
    'done',
    'approval_required',
    'approval_resolved',
    'unattended_halt',
    'domain_resolved',
    'domain_changed',
  ] as const
  for (const type of critical) {
    const dir = tmp()
    try {
      const p = new FileSessionPersistence(dir)
      p.appendEvent('s1', ev(1, type as SessionEvent['type']))
      // write-behind：critical 触发异步写链——排空后必须在盘（毫秒级窗口）。
      await p.flushSessionAsync('s1')
      assert.equal(
        existsSync(join(dir, 's1', 'events.jsonl')), true,
        `${type} must be on disk immediately`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('loadEventsAsync round-trips events and tolerates corrupt lines', async () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    p.appendEvent('s1', ev(1))
    p.appendEvent('s1', ev(2, 'tool_result'))
    p.flushSync()
    appendFileSync(join(dir, 's1', 'events.jsonl'), '{"seq":3,"ts":1,"type":"tex') // crash mid-write
    const evs = await p.loadEventsAsync('s1')
    assert.deepEqual(evs.map((e) => e.seq), [1, 2], 'corrupt tail dropped, rest intact')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadEventsAsync handles a large log (off-thread or chunked path) correctly', async () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    // > 256KB so the pool/chunked path is exercised (not the small-log inline path).
    const pad = 'x'.repeat(200)
    for (let i = 1; i <= 2000; i++) {
      p.appendEvent('big', { seq: i, ts: i, type: 'text_delta', data: { text: pad } })
    }
    p.flushSync()
    const evs = await p.loadEventsAsync('big')
    assert.equal(evs.length, 2000)
    assert.equal(evs[0]!.seq, 1)
    assert.equal(evs[1999]!.seq, 2000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadEventsTailAsync 只回传环内尾部，但头部信息不丢', async () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    // 首尾各埋一条 artifact：头部那条会落在被截区间，去重集仍须包含它，
    // 否则重开会话时旧 artifact 会被重新公告。
    p.appendEvent('big', { seq: 1, ts: 1, type: 'artifact', data: { id: 'head-art' } })
    const pad = 'x'.repeat(200)
    for (let i = 2; i <= 2000; i++) {
      p.appendEvent('big', { seq: i, ts: i, type: 'text_delta', data: { text: pad } })
    }
    p.appendEvent('big', { seq: 2001, ts: 2001, type: 'artifact', data: { id: 'tail-art' } })
    p.flushSync()

    const tail = await p.loadEventsTailAsync('big', 50)
    assert.equal(tail.events.length, 50, '只回传环容量那么多')
    assert.equal(tail.events[0]!.seq, 1952, '尾部窗口紧贴日志末尾')
    assert.equal(tail.events[49]!.seq, 2001)
    assert.equal(tail.total, 2001, 'total 反映全量而非窗口')
    assert.equal(tail.diskFirstSeq, 1, '磁盘最早 seq 来自被截掉的头部')
    assert.equal(tail.lastSeq, 2001)
    assert.deepEqual(
      [...tail.artifactIds].sort(),
      ['head-art', 'tail-art'],
      '去重集覆盖全量，含被截头部里的 artifact',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadEventsTailAsync 日志短于环容量时等价于全量读', async () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    p.appendEvent('s1', ev(1))
    p.appendEvent('s1', ev(2, 'tool_result'))
    p.flushSync()
    appendFileSync(join(dir, 's1', 'events.jsonl'), '{"seq":3,"ts":1,"type":"tex') // crash mid-write
    const tail = await p.loadEventsTailAsync('s1', 5000)
    assert.deepEqual(tail.events.map((e) => e.seq), [1, 2], '坏行照样丢弃，其余不动')
    assert.equal(tail.total, 2)
    assert.equal(tail.diskFirstSeq, 1)
    assert.equal(tail.lastSeq, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadEventsTailAsync 空日志返回零值而非抛错', async () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    assert.deepEqual(await p.loadEventsTailAsync('nope', 5000), {
      events: [], diskFirstSeq: 0, lastSeq: 0, artifactIds: [], total: 0,
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadEventsAsync returns [] for a session with no log', async () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    assert.deepEqual(await p.loadEventsAsync('nope'), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadEventHighWater flushes buffered events and ignores a torn tail', () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    p.appendEvent('s1', ev(1))
    p.appendEvent('s1', ev(2))

    // The high-water query must establish a durable view before scanning; both
    // events are still in the debounce buffer at this point.
    assert.equal(p.loadEventHighWater('s1'), 2)

    appendFileSync(join(dir, 's1', 'events.jsonl'), '{"seq":3,"ts":1,"type":"text_delta"')
    assert.equal(p.loadEventHighWater('s1'), 2, 'torn final JSONL line is not a seq')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadEventHighWater takes the maximum across out-of-order events and seq-less markers', () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    p.appendEvent('s1', ev(1))
    p.appendEvent('s1', ev(100))
    p.appendEvent('s1', ev(2))
    p.flushSync()
    appendFileSync(
      join(dir, 's1', 'events.jsonl'),
      JSON.stringify({ ts: 999, type: 'events_trimmed', data: {} }) + '\n',
    )
    assert.equal(p.loadEventHighWater('s1'), 100)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadEventHighWater falls back to a full scan for a missing or misaligned sparse index', () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    for (let seq = 1; seq <= 1200; seq++) p.appendEvent('s1', ev(seq))
    p.flushSync()
    const idxFile = join(dir, 's1', 'events.index.jsonl')
    const entries = readFileSync(idxFile, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as { seq: number; offset: number })
    const last = entries[entries.length - 1]!

    // Offset points into the anchor line; the full scan must still recover 1200.
    writeFileSync(
      idxFile,
      `${JSON.stringify(entries[0])}\n${JSON.stringify({ ...last, offset: last.offset + 1 })}\n`,
      'utf8',
    )
    assert.equal(p.loadEventHighWater('s1'), 1200)

    // A syntactically valid but wrong anchor seq is equally untrusted.
    writeFileSync(
      idxFile,
      `${JSON.stringify(entries[0])}\n${JSON.stringify({ ...last, seq: 9999 })}\n`,
      'utf8',
    )
    assert.equal(p.loadEventHighWater('s1'), 1200)

    // Missing/corrupt index also takes the complete scan path.
    rmSync(idxFile)
    assert.equal(p.loadEventHighWater('s1'), 1200)
    writeFileSync(idxFile, '{"seq":501', 'utf8')
    assert.equal(p.loadEventHighWater('s1'), 1200)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt index.json falls back to event reconstruction', () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    p.appendEvent('s1', ev(5))
    // Flush the write buffer so the session dir exists on disk before the
    // corrupt index.json is planted.
    p.flushSync()
    writeFileSync(join(dir, 's1', 'index.json'), '{ not json', 'utf8')
    const all = p.loadAll()
    assert.equal(all.length, 1)
    assert.equal(all[0]!.record.lastSeq, 5)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('appendEvent truncates oversized events to a safety stub', () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    // Build a payload well over the 1MB cap (MAX_EVENT_JSON_BYTES)
    const huge = 'x'.repeat(1_200_000)
    p.appendEvent('s1', { seq: 1, ts: 1000, type: 'tool_result', data: { text: huge } })
    p.flushSync()
    const log = readFileSync(join(dir, 's1', 'events.jsonl'), 'utf8')
    assert.ok(log.includes('_truncated'), 'truncation marker present')
    assert.ok(!log.includes('xxxx'), 'original payload not stored')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 写链错误分类（agent-16：姊妹链的无限重试会挂住事件循环）────────────
// 病灶：events 链与 record 链的 catch 对所有错误一律「回填 + 250ms 重试」，
// 无上限——永久性错误（目录被删/只读 FS/路径被占）下 250ms 定时器链永不终止，
// 事件循环永不空（node --test 整批挂死的既有形态，claim-store 同款教训）。
// 修复：错误分类 + 梯度——永久码立即停链；EACCES/EPERM/EBUSY（AV/EDR 秒级锁
// 会自愈）与未知码连续 N 次失败才转永久；行/记录保留待新 kick 清位重试。

test('短暂 EACCES：events 链锁释放后自愈（梯度重试不依赖新事件）', async () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    p.appendEvent('s1', ev(1, 'user')) // CRITICAL：立即上链
    await p.flushSessionAsync('s1')
    const file = join(dir, 's1', 'events.jsonl')
    const base = statSync(file).size

    chmodSync(file, 0o444) // 短暂锁（AV/EDR 扫描窗口同构）
    p.appendEvent('s1', ev(2, 'user'))
    await sleep(600)
    assert.equal(statSync(file).size, base, '锁未释放时不该写入')

    chmodSync(file, 0o644) // 锁释放
    await sleep(900)
    assert.ok(statSync(file).size > base, '锁释放后应自愈落盘——梯度重试不依赖新事件')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('永久错误（events.jsonl 被目录占位 → EISDIR）：立即停链，不留永久定时器', async () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    // events.jsonl 的位置被一个目录占住 → appendFile 恒 EISDIR（重试不改变结果）
    mkdirSync(join(dir, 's1', 'events.jsonl'), { recursive: true })
    p.appendEvent('s1', ev(1, 'user'))
    await sleep(600) // 尝试窗口：若无限重试，此刻已有多次 250ms 循环

    const state = p as unknown as {
      eventChainFailures?: Map<string, { permanent: boolean }>
      writeChains?: Map<string, { running: boolean }>
    }
    assert.equal(state.eventChainFailures?.get('s1')?.permanent, true, '永久错误应停链')
    assert.equal(state.writeChains?.get('s1')?.running, false, '写链必须已停止（否则定时器链永不释放）')
  } finally {
    // RED 期（未分类的无限重试）链会持续重建目录——先撤占位让链自然收敛再清理，
    // 否则 rmSync 与链写入竞态（ENOTEMPTY）。停链后这里只是多等一拍。
    try { rmSync(join(dir, 's1', 'events.jsonl'), { recursive: true, force: true }) } catch { /* gone */ }
    await sleep(350)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('停链后 flushSessionAsync 快速返回，不空转到超时', async () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    mkdirSync(join(dir, 's1', 'events.jsonl'), { recursive: true }) // EISDIR → 立即停链
    p.appendEvent('s1', ev(1, 'user'))
    await sleep(400)

    const t0 = Date.now()
    await p.flushSessionAsync('s1', 3_000)
    assert.ok(Date.now() - t0 < 1_500, `停链后 flush 应立即返回（实际 ${Date.now() - t0}ms）`)
  } finally {
    // 同前：撤占位让链收敛后再清理（RED 期竞态防护）
    try { rmSync(join(dir, 's1', 'events.jsonl'), { recursive: true, force: true }) } catch { /* gone */ }
    await sleep(350)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('record 链：EACCES 耗尽梯度停链；锁释放不自愈；新 saveRecord 清位重试', { skip: process.platform === 'win32' ? 'Windows 无 chmod 目录只读语义（NTFS 不产生 EACCES），无法构造写失败注入；该链在 POSIX/CI 覆盖' : false }, async () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir, { maxTransientWriteRetries: 2 })
    p.saveRecord(rec('s1'))
    await sleep(200) // 首写完成
    const sessDir = join(dir, 's1')

    chmodSync(sessDir, 0o555) // 目录只读 → index.json.tmp 写失败 EACCES
    p.saveRecord(rec('s1', { lastSeq: 9 }))
    await sleep(900) // 2 次重试耗尽 → 停链

    const state = p as unknown as { recordChainFailures?: Map<string, { permanent: boolean }> }
    assert.equal(state.recordChainFailures?.get('s1')?.permanent, true, '梯度耗尽应停链')

    chmodSync(sessDir, 0o755)
    await sleep(800)
    const idx = JSON.parse(readFileSync(join(sessDir, 'index.json'), 'utf8')) as { lastSeq: number }
    assert.equal(idx.lastSeq, 0, '停链后锁释放也不自愈（防无限重试复活）')

    p.saveRecord(rec('s1', { lastSeq: 10 })) // 新记录 = 重试许可
    await sleep(400)
    const idx2 = JSON.parse(readFileSync(join(sessDir, 'index.json'), 'utf8')) as { lastSeq: number }
    assert.equal(idx2.lastSeq, 10, '新 saveRecord 应清位重试成功')
  } finally {
    // 恢复写权限让链收敛（RED 期无限重试下 rm 会与重建竞态）再清理
    try { chmodSync(join(dir, 's1'), 0o755) } catch { /* gone */ }
    await sleep(350)
    rmSync(dir, { recursive: true, force: true })
  }
})

// agent-16 审查跟进项：「again 吞一拍」的姊妹链形态。flush 入口 kick 若落在
// 运行中的链上被吞为 again，链随后梯度耗尽停链——修复前 flush 见停链即返回，
// 一行也排不掉（shutdown 恰好撞上锁持续期的典型形态）。修复：清位重踢一次。
test('flushSessionAsync 撞上运行中的写链：链随后耗尽停链时补踢排空', async () => {
  const dir = tmp()
  const file = join(dir, 's1', 'events.jsonl')
  try {
    const p = new FileSessionPersistence(dir, { maxTransientWriteRetries: 2 })
    p.appendEvent('s1', ev(1, 'user'))
    await p.flushSessionAsync('s1')
    const base = statSync(file).size

    chmodSync(file, 0o444)
    p.appendEvent('s1', ev(2, 'user'))
    await sleep(80) // 链第一次失败后的 250ms 退避中（running=true）
    const flushing = p.flushSessionAsync('s1', 1_500) // 入口 kick 撞运行中链 → again（不清位）
    await sleep(400) // 链第二次失败 → 梯度耗尽 → 停链
    chmodSync(file, 0o644) // 锁释放
    await flushing
    assert.ok(statSync(file).size > base, 'flush 应补踢已停链的滞留行——锁释放后即排空')
  } finally {
    try { chmodSync(file, 0o644) } catch { /* gone */ }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('flushAllAsync 同款时序：撞上运行中的链、链耗尽停链后补踢排空', async () => {
  const dir = tmp()
  const file = join(dir, 's1', 'events.jsonl')
  try {
    const p = new FileSessionPersistence(dir, { maxTransientWriteRetries: 2 })
    p.appendEvent('s1', ev(1, 'user'))
    await p.flushAllAsync(1_500)
    const base = statSync(file).size

    chmodSync(file, 0o444)
    p.appendEvent('s1', ev(2, 'user'))
    await sleep(80) // 链第一次失败后的退避中
    const flushing = p.flushAllAsync(1_500) // 入口 kick 撞运行中链 → again（不清位）
    await sleep(400) // 链第二次失败 → 梯度耗尽 → 停链
    chmodSync(file, 0o644) // 锁释放
    await flushing
    assert.ok(statSync(file).size > base, 'flushAllAsync 应补踢已停链的滞留行')
  } finally {
    try { chmodSync(file, 0o644) } catch { /* gone */ }
    rmSync(dir, { recursive: true, force: true })
  }
})

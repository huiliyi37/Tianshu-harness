import './disable-cpu-pool.js' // must precede session-persistence import (worker hangs node:test)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, appendFileSync, readdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileSessionPersistence } from '../session-persistence.js'
import type { SessionEvent, SessionRecord } from '../session-manager.js'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'rivet-persist-'))
}

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

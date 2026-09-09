import './disable-cpu-pool.js' // must precede session-persistence import (worker hangs node:test)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileSessionPersistence } from '../session-persistence.js'
import {
  RuntimeSessionManager,
  type ManagedAgent,
  type SessionEvent,
} from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

/**
 * 冷热双通道（会话历史回放持久化 · Phase 2）：
 *  - 稀疏索引 sidecar（events.index.jsonl）：append 顺手写，每 ≥500 事件一条
 *  - loadEventsBefore：字节区间读——大日志分页不整本进内存
 *  - 索引缺失/损坏/漂移 → 整本扫描重建（自愈）
 *  - getAllEventsAsync + getWorkerLog / listRewindPoints 越过内存环截尾
 * 设计：docs/superpowers/specs/2026-07-25-session-replay-durability-design.md
 */

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'rivet-sparse-'))
}

function ev(seq: number, type: SessionEvent['type'] = 'text_delta', data: Record<string, unknown> = {}): SessionEvent {
  return { seq, ts: 100 + seq, type, data: { text: `e${seq}`, ...data } }
}

/** turn 结构日志：每 12 条一个 turn（user 打头 + 11 条 delta）。 */
function appendTurnLog(p: FileSessionPersistence, id: string, total: number): void {
  for (let seq = 1; seq <= total; seq++) {
    const isUser = (seq - 1) % 12 === 0
    p.appendEvent(id, isUser ? ev(seq, 'user', { text: `q${seq}` }) : ev(seq))
  }
  p.flushSync()
}

/* ── 索引写入 ─────────────────────────────────────────────── */

test('append 顺手写稀疏索引：条目升序、头部 offset=0、锚点与文件字节一致', () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    appendTurnLog(p, 's1', 1200)

    const idxFile = join(dir, 's1', 'events.index.jsonl')
    assert.ok(existsSync(idxFile), '索引 sidecar 必须随 append 生成')
    const entries = readFileSync(idxFile, 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l) as { seq: number; offset: number })
    // 1200 条 → 序号 0/500/1000 三条。
    assert.equal(entries.length, 3)
    assert.equal(entries[0]!.offset, 0)
    assert.deepEqual(entries.map((e) => e.seq), [1, 501, 1001])
    // 每个 offset 必须指向真实行首，且该行 parse 出的 seq 与条目一致。
    const raw = readFileSync(join(dir, 's1', 'events.jsonl'))
    for (const e of entries) {
      const lineEnd = raw.indexOf(0x0a, e.offset)
      const parsed = JSON.parse(raw.subarray(e.offset, lineEnd).toString('utf8')) as SessionEvent
      assert.equal(parsed.seq, e.seq, `offset ${e.offset} 处的行必须是 seq=${e.seq}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ── 区间读 ─────────────────────────────────────────────── */

test('loadEventsBefore：窗口内容与全量读切片完全一致', async () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    appendTurnLog(p, 's1', 1200)

    const all = p.loadEvents('s1')
    const win = await p.loadEventsBefore('s1', 1100, 50)
    assert.ok(win.events.length >= 50, `窗口至少 minCount 条，实际 ${win.events.length}`)
    assert.equal(win.firstSeq, 1)
    assert.equal(win.atLogStart, false)
    for (const e of win.events) assert.ok(e.seq < 1100)
    // 与全量读的同区间切片逐条一致。
    const expected = all.filter((e) => e.seq < 1100).slice(-win.events.length)
    assert.deepEqual(win.events, expected)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadEventsBefore：before ≤ 磁盘最早 seq → 空页 + atLogStart', async () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    appendTurnLog(p, 's1', 1200)
    const win = await p.loadEventsBefore('s1', 1, 50)
    assert.deepEqual(win.events, [])
    assert.equal(win.atLogStart, true)
    assert.equal(win.firstSeq, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadEventsBefore：字节区间读不触碰窗口外的头部（区间读证据）', async () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    appendTurnLog(p, 's1', 1200)
    // 把日志首行原地替换为同长度垃圾：整本 parse 会丢弃该行（firstSeq 变 2），
    // 字节区间读根本不经过它（firstSeq 仍按索引条目报 1）。
    const logFile = join(dir, 's1', 'events.jsonl')
    const raw = readFileSync(logFile)
    const firstLineEnd = raw.indexOf(0x0a)
    const garbage = Buffer.from('x'.repeat(firstLineEnd))
    garbage.copy(raw, 0)
    writeFileSync(logFile, raw)

    const win = await p.loadEventsBefore('s1', 1150, 30)
    assert.equal(win.firstSeq, 1, '窗口在尾部 → 头部损坏不可见 → 走的是索引区间读')
    assert.ok(win.events.length >= 30)
    for (const e of win.events) assert.ok(e.seq < 1150)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ── 自愈重建 ─────────────────────────────────────────────── */

test('旧日志无索引：首次分页整本重建，索引落盘且头部有覆盖', async () => {
  const dir = tmp()
  try {
    // 直接写日志文件（模拟 Phase 2 上线前的存量会话），不经 appendEvent。
    const lines: string[] = []
    for (let seq = 1; seq <= 1200; seq++) {
      const isUser = (seq - 1) % 12 === 0
      lines.push(JSON.stringify(ev(seq, isUser ? 'user' : 'text_delta')))
    }
    const d = join(dir, 's1')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'events.jsonl'), lines.join('\n') + '\n', 'utf8')

    const p = new FileSessionPersistence(dir)
    const win = await p.loadEventsBefore('s1', 600, 40)
    assert.ok(win.events.length >= 40)
    assert.equal(win.firstSeq, 1)
    for (const e of win.events) assert.ok(e.seq < 600)

    const idxFile = join(d, 'events.index.jsonl')
    assert.ok(existsSync(idxFile), '重建后索引必须落盘')
    const entries = readFileSync(idxFile, 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l) as { seq: number; offset: number })
    assert.equal(entries[0]!.offset, 0, '重建索引头部有覆盖')
    assert.deepEqual(entries.map((e) => e.seq), [1, 501, 1001])

    // 第二次分页走重建后的索引。契约是「至少 minCount 条」——索引路径返回
    // 桶对齐窗口（可能更长），只要求尾部切片与首次（重建路径）一致。
    const win2 = await p.loadEventsBefore('s1', 600, 40)
    assert.ok(win2.events.length >= 40)
    assert.deepEqual(win2.events.slice(-win.events.length), win.events)

    // 重建后继续 append：写指针无缝续写（1201..1500 → 下一条目 seq=1501）。
    for (let seq = 1201; seq <= 1501; seq++) p.appendEvent('s1', ev(seq))
    p.flushSync()
    const after = readFileSync(idxFile, 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l) as { seq: number; offset: number })
    assert.deepEqual(after.map((e) => e.seq), [1, 501, 1001, 1501], '重建后 append 续写条目')
    const tail = await p.loadEventsBefore('s1', 1400, 20)
    assert.deepEqual(
      tail.events,
      p.loadEvents('s1').filter((e) => e.seq < 1400).slice(-tail.events.length),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('索引损坏（offset 错位/非递增/垃圾行）→ 整本重建仍正确', async () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    appendTurnLog(p, 's1', 1200)
    const idxFile = join(dir, 's1', 'events.index.jsonl')

    // ① offset 错位（合法 JSON、递增，但指向错误字节）→ 区间首行校验不过 → 重建。
    writeFileSync(idxFile, '{"seq":1,"offset":0}\n{"seq":501,"offset":7}\n{"seq":1001,"offset":9}\n', 'utf8')
    const p2 = new FileSessionPersistence(dir)
    const win = await p2.loadEventsBefore('s1', 1100, 30)
    const all = p2.loadEvents('s1')
    assert.deepEqual(win.events, all.filter((e) => e.seq < 1100).slice(-win.events.length))
    assert.equal(win.firstSeq, 1)

    // ② 非递增 → readIndexEntries 判损 → 重建。
    writeFileSync(idxFile, '{"seq":500,"offset":100}\n{"seq":100,"offset":50}\n', 'utf8')
    const p3 = new FileSessionPersistence(dir)
    const win2 = await p3.loadEventsBefore('s1', 700, 25)
    assert.deepEqual(win2.events, all.filter((e) => e.seq < 700).slice(-win2.events.length))

    // ③ 纯垃圾 → 同上。
    writeFileSync(idxFile, 'not json at all\n', 'utf8')
    const p4 = new FileSessionPersistence(dir)
    const win3 = await p4.loadEventsBefore('s1', 700, 25)
    assert.deepEqual(win3.events, win2.events)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('崩溃截尾（torn tail line）：区间读与重建都不受影响', async () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    appendTurnLog(p, 's1', 1200)
    // 模拟崩溃：日志尾部追加半行。
    appendFileSync(join(dir, 's1', 'events.jsonl'), '{"seq":1201,"ts":1,"type":"tex')
    const win = await p.loadEventsBefore('s1', 1201, 20)
    const clean = win.events.filter((e) => e.seq <= 1200)
    assert.equal(clean.length, win.events.length, '半行不产出事件')
    assert.ok(win.events.length >= 20)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ── getHistoryPage 索引路径 ───────────────────────────────── */

class NoopAgent implements ManagedAgent {
  run(_p: string, _cb: AgentCallbacks): Promise<void> { return Promise.resolve() }
  abort(): void {}
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_msgs: OaiMessage[]): void {}
  rewindToMessages(_msgs: OaiMessage[]): void {}
}

function seedFilePersistence(dir: string, id: string, total: number): FileSessionPersistence {
  const p = new FileSessionPersistence(dir)
  p.saveRecord({
    id, status: 'completed', createdAt: 1, updatedAt: 9,
    cwd: '/work', lastSeq: total, pendingApprovals: 0,
  })
  appendTurnLog(p, id, total)
  return p
}

test('getHistoryPage：索引路径与全量 fallback 路径结果完全一致', async () => {
  const dir = tmp()
  try {
    const p = seedFilePersistence(dir, 'long', 1200)
    const mgrFast = new RuntimeSessionManager({
      createAgent: () => new NoopAgent(),
      persistence: p,
      maxEvents: 100,
    })
    await mgrFast.getEventsAsync('long', 0)

    // 剥掉 loadEventsBefore → 强制走全量 fallback 的对照组。
    const stripped = Object.create(p) as FileSessionPersistence
    Object.defineProperty(stripped, 'loadEventsBefore', { value: undefined })
    const mgrSlow = new RuntimeSessionManager({
      createAgent: () => new NoopAgent(),
      persistence: stripped,
      maxEvents: 100,
    })
    await mgrSlow.getEventsAsync('long', 0)

    for (const [before, limit] of [[1101, 50], [601, 10], [13, 5], [2, 5], [9999, 30]] as const) {
      const fast = await mgrFast.getHistoryPage('long', before, limit)
      const slow = await mgrSlow.getHistoryPage('long', before, limit)
      assert.deepEqual(fast, slow, `before=${before} limit=${limit} 两条路径必须一致`)
      if (fast!.events.length > 0 && fast!.events[0]!.seq > 1) {
        assert.equal(fast!.events[0]!.type, 'user', 'turn 边界对齐')
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('getHistoryPage：连续翻页（索引路径）头部 1..floor-1 全可达', async () => {
  const dir = tmp()
  try {
    const p = seedFilePersistence(dir, 'long', 1200)
    const mgr = new RuntimeSessionManager({
      createAgent: () => new NoopAgent(),
      persistence: p,
      maxEvents: 100,
    })
    const replay = await mgr.getEventsAsync('long', 0)
    const floor = replay!.events[0]!.seq
    assert.equal(floor, 1101, '环容量 100 截到尾部')

    const seen: number[] = []
    let before = floor
    for (let guard = 0; guard < 50 && before > 1; guard++) {
      const page = await mgr.getHistoryPage('long', before, 200)
      assert.ok(page)
      if (page.events.length === 0) break
      seen.unshift(...page.events.map((e) => e.seq))
      before = page.events[0]!.seq
    }
    assert.equal(seen.length, floor - 1, '头部全部可达')
    for (let i = 0; i < seen.length; i++) assert.equal(seen[i], i + 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ── 环外消费者（Phase 2 全历史读取） ─────────────────────── */

test('getAllEventsAsync：越过内存环截尾返回磁盘全量', async () => {
  const dir = tmp()
  try {
    const p = seedFilePersistence(dir, 'long', 1200)
    const mgr = new RuntimeSessionManager({
      createAgent: () => new NoopAgent(),
      persistence: p,
      maxEvents: 100,
    })
    const ring = await mgr.getEventsAsync('long', 0)
    assert.equal(ring!.events.length, 100, '环内只有尾部')

    const full = await mgr.getAllEventsAsync('long')
    assert.equal(full!.events.length, 1200, '全历史读取不受环截尾影响')
    assert.equal(full!.events[0]!.seq, 1)
    assert.equal(full!.lastSeq, 1200)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('getWorkerLog：环底之前的 delegation 活动可见', async () => {
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    p.saveRecord({
      id: 'long', status: 'completed', createdAt: 1, updatedAt: 9,
      cwd: '/work', lastSeq: 1200, pendingApprovals: 0,
    })
    for (let seq = 1; seq <= 1200; seq++) {
      if (seq <= 3) {
        // worker 活动全部落在日志头部（远早于环底 1101）。
        p.appendEvent('long', ev(seq, 'delegation', { workOrderId: 'w1', progressLine: `early-${seq}` }))
      } else {
        p.appendEvent('long', (seq - 1) % 12 === 0 ? ev(seq, 'user', { text: `q${seq}` }) : ev(seq))
      }
    }
    p.flushSync()
    const mgr = new RuntimeSessionManager({
      createAgent: () => new NoopAgent(),
      persistence: p,
      maxEvents: 100,
    })
    const log = await mgr.getWorkerLog('long', 'w1')
    assert.ok(log)
    assert.deepEqual(log.activity, ['early-1', 'early-2', 'early-3'], '环外的 worker 活动必须可见')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listRewindPoints：环底之前的 user 事件仍提供 seq/ts 锚点', async () => {
  // 镜像 run → user+assistant 消息的 agent（与 rewind.test.ts #4b 同构）。
  class TurnMirrorAgent implements ManagedAgent {
    messages: OaiMessage[] = []
    run(prompt: string, _cb: AgentCallbacks): Promise<void> {
      this.messages.push({ role: 'user', content: prompt })
      this.messages.push({ role: 'assistant', content: 'ok' })
      return Promise.resolve()
    }
    abort(): void {}
    listArtifacts(): Artifact[] { return [] }
    readArtifact(): Promise<string | null> { return Promise.resolve(null) }
    getMessages(): OaiMessage[] { return this.messages }
    replaceMessages(m: OaiMessage[]): void { this.messages = m }
    rewindToMessages(m: OaiMessage[]): void { this.messages = m }
  }
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    const mgr = new RuntimeSessionManager({
      createAgent: () => new TurnMirrorAgent(),
      defaultCwd: '/tmp',
      persistence: p,
      maxEvents: 5, // 病态小环：只留尾部 5 条事件
    })
    const s = mgr.createSession({ prompt: 'turn-1' })
    await new Promise((r) => setTimeout(r, 10))
    for (let t = 2; t <= 8; t++) {
      mgr.run(s.id, `turn-${t}`)
      await new Promise((r) => setTimeout(r, 10))
    }
    // 环里只剩尾部 5 条 → 早期 user 事件全被截掉。
    const ring = mgr.getEvents(s.id, 0)!
    assert.ok(ring.events.length <= 5)

    const points = (await mgr.listRewindPoints(s.id))!
    assert.equal(points.length, 8)
    for (const [i, pt] of points.entries()) {
      assert.equal(pt.content, `turn-${i + 1}`)
      assert.ok(pt.seq !== undefined, `环外 user 事件（turn-${i + 1}）也必须有 seq 锚点`)
      assert.ok(pt.timestamp > 0)
    }
    // seq 严格递增（全部来自磁盘完整历史）。
    for (let i = 1; i < points.length; i++) assert.ok(points[i]!.seq! > points[i - 1]!.seq!)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rewind：环底之前的 user 消息仍能解析 anchorSeq（磁盘全量配对）', async () => {
  // rewind() 是同步 API，早前只拿内存环配事件 → 长会话里早期 user 事件不在环
  // 内，anchorSeq 静默缺失、prompt 只剩含注入的原文。桌面端因此既定位不到
  // 截断点（界面不截断）又匹配不上 blocks 文本。环被截尾时必须读磁盘全量。
  class TurnMirrorAgent implements ManagedAgent {
    messages: OaiMessage[] = []
    run(prompt: string, _cb: AgentCallbacks): Promise<void> {
      this.messages.push({ role: 'user', content: prompt })
      this.messages.push({ role: 'assistant', content: 'ok' })
      return Promise.resolve()
    }
    abort(): void {}
    listArtifacts(): Artifact[] { return [] }
    readArtifact(): Promise<string | null> { return Promise.resolve(null) }
    getMessages(): OaiMessage[] { return this.messages }
    replaceMessages(m: OaiMessage[]): void { this.messages = m }
    rewindToMessages(m: OaiMessage[]): void { this.messages = m }
  }
  const dir = tmp()
  try {
    const p = new FileSessionPersistence(dir)
    const mgr = new RuntimeSessionManager({
      createAgent: () => new TurnMirrorAgent(),
      defaultCwd: '/tmp',
      persistence: p,
      maxEvents: 5, // 病态小环：只留尾部 5 条事件
    })
    const s = mgr.createSession({ prompt: 'turn-1' })
    await new Promise((r) => setTimeout(r, 10))
    for (let t = 2; t <= 8; t++) {
      mgr.run(s.id, `turn-${t}`)
      await new Promise((r) => setTimeout(r, 10))
    }
    const ring = mgr.getEvents(s.id, 0)!.events
    assert.ok(ring.length <= 5, 'precondition: 环里只剩尾部')
    assert.ok(!ring.some((e) => e.type === 'user' && e.data.text === 'turn-2'), 'precondition: turn-2 事件已在环外')

    assert.ok(mgr.rewind(s.id, 2), 'rewind 到 turn-2 应成功')

    const all = (await mgr.getAllEventsAsync(s.id))!.events
    const rewindEvent = all.filter((e) => e.type === 'rewind').pop()!
    const turn2 = all.find((e) => e.type === 'user' && e.data.text === 'turn-2')!
    assert.equal(rewindEvent.data.prompt, 'turn-2', 'prompt 取事件原文')
    assert.equal(rewindEvent.data.anchorSeq, turn2.seq, '环外 user 事件也必须能锚定')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

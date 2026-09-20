/**
 * P1-1 fork — RuntimeSessionManager.forkSession + POST /sessions/:id/fork。
 *
 * 回流自 `origin/tianshu-alpha-3.14`（063387d38 服务端底座 / 0bbbc4f9d 桌面交互 /
 * dd613a490 转录读取容错），按 3.15 主线的 persistence + 事件环 API 重接。
 *
 * 语义：rewind 截断**同一个**会话；fork 从切点复制出一个**新会话**，源会话一字
 * 不动。复制三件套 = 事件流前缀（≤ 切点 seq）+ OAI 转录前缀 + 血缘字段。
 *
 * 反证表（每条都对着一个具体的偷懒实现）：
 *   #1「fork 只建了个空会话」    → 断言子会话事件流 / 转录前缀 / 血缘字段
 *   #2「message fork 切成 exclusive」→ 断言切点那条 user 消息被包含
 *   #3「running 也能 fork」      → 复制边界必须是静止的
 *   #4「标题永远 Foo (2)」       → 链式编号沿 forkedFrom 走
 *   #5「坏入参静默兜底成 local」 → 非法 index / 无 worktree 必须 fail-closed
 *   #6「路由吞掉失败原因」       → 404/400 分类映射
 *   #7「fork 顺手改了源会话」    → 源事件流与转录逐字节不变
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import { buildSessionRoutes } from '../session-routes.js'
import { createRouter } from '../index.js'
import { SessionPersist } from '../../agent/session-persist.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

const TOKEN = 'tok'
const AUTH = { authorization: `Bearer ${TOKEN}` }

// 这套测试经 SessionPersist 真写 OAI 转录，必须把会话目录指到临时目录，
// 绝不落到真实 ~/.rivet/sessions 树下；after 里还原，避免污染同批次的其它文件。
let prevSessionDir: string | undefined
before(() => {
  prevSessionDir = process.env.RIVET_SESSION_DIR
  process.env.RIVET_SESSION_DIR = mkdtempSync(join(tmpdir(), 'rivet-fork-sessions-'))
})
after(() => {
  if (prevSessionDir === undefined) delete process.env.RIVET_SESSION_DIR
  else process.env.RIVET_SESSION_DIR = prevSessionDir
})

/**
 * 可控 agent：`hold=false` 时 run 立即 settle（会话回到 idle）；`hold=true` 时
 * run 挂起，直到 finish()/abort()——#3 需要「真在跑」的会话，没有这个开关就只能
 * 靠微任务时序赌，那种测试会随调度变化偶发通过。
 */
class ForkableAgent implements ManagedAgent {
  messages: OaiMessage[] = []
  hold = false
  private settle?: () => void

  run(_prompt: string, _cb: AgentCallbacks): Promise<void> {
    if (!this.hold) return Promise.resolve()
    return new Promise<void>((resolve) => { this.settle = resolve })
  }
  finish(): void {
    this.settle?.()
    this.settle = undefined
  }
  abort(): void { this.finish() }
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return this.messages }
  replaceMessages(msgs: OaiMessage[]): void { this.messages = msgs }
  rewindToMessages(msgs: OaiMessage[]): void { this.messages = msgs }
}

function makeMessages(): OaiMessage[] {
  return [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there' },
    { role: 'user', content: 'Do task A' },
    { role: 'assistant', content: 'Doing A' },
    { role: 'user', content: 'Now do B' },
    { role: 'assistant', content: 'Doing B' },
  ]
}

const PROMPTS = ['Hello', 'Do task A', 'Now do B']

function setup() {
  const agents: ForkableAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => {
      const a = new ForkableAgent()
      agents.push(a)
      return a
    },
    defaultCwd: '/tmp',
  })
  const routes = buildSessionRoutes(manager, TOKEN)
  const router = createRouter(routes)
  return { manager, router, agents }
}

const delay = (ms = 10) => new Promise((r) => setTimeout(r, ms))

/** 建一个带 N 次真实 run（真 user 事件）+ 配套 OAI 转录文件的会话。 */
async function makeSession(
  manager: RuntimeSessionManager,
  opts: { runs?: number; title?: string } = {},
): Promise<{ id: string; cwd: string }> {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-fork-'))
  const id = manager.createSession({ cwd, title: opts.title ?? 'Foo' }).id
  const runs = opts.runs ?? PROMPTS.length
  for (let i = 0; i < runs; i++) {
    manager.run(id, PROMPTS[i]!)
    await delay()
  }
  // 假 agent 不写模型转录；按生产路径补齐，子会话读回才有东西可比。
  const persist = new SessionPersist(id, cwd)
  for (const m of makeMessages().slice(0, runs * 2)) {
    await persist.appendOaiWithChecksum(m)
  }
  await persist.flushSessionBuffer()
  return { id, cwd }
}

test('#1 header fork copies the whole conversation into a new idle session', async () => {
  const { manager } = setup()
  const { id, cwd } = await makeSession(manager, { runs: 2 })
  try {
    const result = await manager.forkSession(id, { source: 'header' })
    assert.ok(result.ok, `fork should succeed: ${JSON.stringify(result)}`)
    if (!result.ok) return
    const child = result.record

    assert.equal(child.status, 'idle')
    assert.equal(child.forkedFromId, id)
    assert.equal(child.forkTitleNumber, 2)
    assert.equal(child.title, 'Foo (2)')
    assert.equal(child.forkSource, 'header')

    const events = manager.getEvents(child.id, 0)!
    const userEvents = events.events.filter((e) => e.type === 'user')
    assert.equal(userEvents.length, 2, 'both user events copied')
    assert.ok(events.events.some((e) => e.type === 'fork'), 'fork marker appended')

    // header fork = 整段事件流复制（含末轮收尾 status/done，以及可能存在的 rewind
    // 标记）——切成「最后一个 user 事件」会把末轮回复与收尾事件裁掉：UI 里最后
    // 一条 prompt 没有回复、而转录里却有，且被回滚过的尾巴会在子会话 UI 复活。
    const srcEvents = manager.getEvents(id, 0)!.events
    assert.equal(child.forkedFromTurnSeq, srcEvents[srcEvents.length - 1]!.seq, 'header 切点 = 源日志末事件')
    assert.equal(
      events.events.filter((e) => e.type !== 'fork').length,
      srcEvents.length,
      '子会话必须含源会话全部事件（一条不少）',
    )

    // 模型转录：子会话恢复同一段对话前缀。
    const childPersist = new SessionPersist(child.id, cwd)
    assert.equal(childPersist.loadOai().length, 4, '2 user + 2 assistant messages')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('#2 message fork cuts at the chosen user message (inclusive)', async () => {
  const { manager } = setup()
  const { id, cwd } = await makeSession(manager)
  try {
    // makeMessages()[4] = "Now do B" —— 保留到这条，丢掉最后一条回复。
    const result = await manager.forkSession(id, { messageIndex: 4, source: 'message' })
    assert.ok(result.ok, `fork should succeed: ${JSON.stringify(result)}`)
    if (!result.ok) return
    const child = result.record

    assert.equal(child.forkSource, 'message')
    const events = manager.getEvents(child.id, 0)!
    assert.equal(events.events.filter((e) => e.type === 'user').length, 3)
    const forkMarker = events.events.find((e) => e.type === 'fork')
    assert.ok(forkMarker, 'fork marker appended')
    assert.ok(
      events.events.every((e) => e === forkMarker || e.seq <= child.forkedFromTurnSeq!),
      'only the fork marker may exceed the anchor seq',
    )

    const transcript = new SessionPersist(child.id, cwd).loadOai()
    assert.equal(transcript.length, 5, 'prefix includes the anchor user message')
    assert.equal(transcript[4]!.role, 'user')
    assert.equal((transcript[4] as { content: string }).content, 'Now do B')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('#2b hook 注入的独立 user 消息不顶偏锚点配对（buildUserAnchors）', async () => {
  const { manager } = setup()
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-fork-'))
  try {
    const id = manager.createSession({ cwd, title: 'Foo' }).id
    manager.run(id, 'Hello')
    await delay()
    manager.run(id, 'Do task A')
    await delay()
    // 转录里插一条 hook 注入的独立 user 消息——事件流里**没有**对应的 user 事件
    //（磁盘对账/取证提醒/图片桥接都走这条通道）。序数法（第 N 条 user 消息 →
    // 第 N 个 user 事件）在这里整体偏一格，会把切点落到错误的消息上。
    const persist = new SessionPersist(id, cwd)
    const withInjection: OaiMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: '<system-reminder>injected</system-reminder>' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'Do task A' },
      { role: 'assistant', content: 'Doing A' },
    ]
    for (const m of withInjection) await persist.appendOaiWithChecksum(m)
    await persist.flushSessionBuffer()

    const srcUserSeqs = manager.getEvents(id, 0)!.events
      .filter((e) => e.type === 'user')
      .map((e) => e.seq)
    assert.equal(srcUserSeqs.length, 2, '两条真实用户消息各有一个事件')

    // 切在注入消息上语义不明（它没有事件锚点）→ 必须拒绝，不能猜一个最近的。
    const injected = await manager.forkSession(id, { messageIndex: 2 })
    assert.deepEqual(injected, { ok: false, reason: 'invalid_message_index' })

    const r = await manager.forkSession(id, { messageIndex: 4, source: 'message' })
    assert.ok(r.ok, `fork should succeed: ${JSON.stringify(r)}`)
    if (!r.ok) return
    assert.equal(r.record.forkedFromTurnSeq, srcUserSeqs[1], '锚点必须配到「Do task A」那条 user 事件')
    assert.equal(new SessionPersist(r.record.id, cwd).loadOai().length, 5, '前缀含注入消息 + 锚点消息')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('#3 fork is rejected while the source session is running', async () => {
  const { manager, agents } = setup()
  const { id, cwd } = await makeSession(manager, { runs: 1 })
  try {
    const agent = agents.at(-1)!
    agent.hold = true
    manager.run(id, 'another prompt')
    try {
      const result = await manager.forkSession(id)
      assert.deepEqual(result, { ok: false, reason: 'running' })
    } finally {
      agent.finish()
      await delay()
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('#4 title numbering walks the fork chain (Foo → Foo (2) → Foo (3))', async () => {
  const { manager } = setup()
  const { id, cwd } = await makeSession(manager, { runs: 1 })
  try {
    const first = await manager.forkSession(id)
    assert.ok(first.ok)
    if (!first.ok) return
    assert.equal(first.record.title, 'Foo (2)')

    // fork-of-fork 必须按同一基名计数，而不是叠成 "Foo (2) (2)"。
    const second = await manager.forkSession(first.record.id)
    assert.ok(second.ok)
    if (!second.ok) return
    assert.equal(second.record.title, 'Foo (3)')
    assert.equal(second.record.forkedFromId, first.record.id)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('#4b sibling forks from the same source never collide on the title number', async () => {
  const { manager } = setup()
  const { id, cwd } = await makeSession(manager, { runs: 1 })
  try {
    // 计数只看祖先链的旧实现会让同源连续两次 fork 都得到 "Foo (2)"——
    // 血缘 UI 无法区分。正确语义：同基名的全部会话（祖先 + 兄弟 + 撞名）计 max+1。
    const first = await manager.forkSession(id)
    const second = await manager.forkSession(id)
    assert.ok(first.ok && second.ok)
    if (!first.ok || !second.ok) return
    assert.equal(first.record.title, 'Foo (2)')
    assert.equal(second.record.title, 'Foo (3)')
    assert.equal(second.record.forkedFromId, id, '兄弟 fork 的血缘都指向同一源')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('#5 invalid messageIndex and missing same-worktree fail closed', async () => {
  const { manager } = setup()
  const { id, cwd } = await makeSession(manager, { runs: 2 })
  try {
    // index 1 是 assistant —— 切在回复中间语义不成立。
    const badIndex = await manager.forkSession(id, { messageIndex: 1 })
    assert.deepEqual(badIndex, { ok: false, reason: 'invalid_message_index' })

    // 源会话不是 worktree 会话 → 不能假装成功。
    const noWorktree = await manager.forkSession(id, { destination: 'same-worktree' })
    assert.deepEqual(noWorktree, { ok: false, reason: 'same_worktree_unavailable' })

    const missing = await manager.forkSession('does-not-exist')
    assert.deepEqual(missing, { ok: false, reason: 'not_found' })
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('#6 POST /sessions/:id/fork returns the new session and maps failures', async () => {
  const { manager, router } = setup()
  const { id, cwd } = await makeSession(manager, { runs: 1 })
  try {
    const res = await router('POST', `/sessions/${id}/fork`, { destination: 'local' }, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { session?: { forkedFromId?: string; title?: string } }
    assert.equal(body.session?.forkedFromId, id)
    assert.equal(body.session?.title, 'Foo (2)')

    const notFound = await router('POST', '/sessions/nope/fork', {}, AUTH)
    assert.equal(notFound.status, 404)

    const badDest = await router('POST', `/sessions/${id}/fork`, { destination: 'moon' }, AUTH)
    assert.equal(badDest.status, 400)

    const badIndex = await router('POST', `/sessions/${id}/fork`, { messageIndex: 1 }, AUTH)
    assert.equal(badIndex.status, 400)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('#7 fork leaves the source session untouched', async () => {
  const { manager } = setup()
  const { id, cwd } = await makeSession(manager, { runs: 2 })
  try {
    const beforeEvents = manager.getEvents(id, 0)!.events
    const beforeTranscript = new SessionPersist(id, cwd).loadOai()

    const result = await manager.forkSession(id, { messageIndex: 2, source: 'message' })
    assert.ok(result.ok)
    if (!result.ok) return

    const afterEvents = manager.getEvents(id, 0)!.events
    assert.equal(afterEvents.length, beforeEvents.length, 'source event log must not grow')
    assert.ok(!afterEvents.some((e) => e.type === 'fork'), 'fork marker belongs to the child only')
    assert.deepEqual(
      new SessionPersist(id, cwd).loadOai(),
      beforeTranscript,
      'source transcript must be byte-identical after fork',
    )
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

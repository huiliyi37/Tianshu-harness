import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionJobs, type JobEvent } from '../job-store.js'

// These tests spawn real short-lived shell commands via the platform shell
// (sh -c on POSIX). They assume a POSIX-ish shell — consistent with the rest of
// the bash tool tests in this suite.

const env = { ...process.env }

function makeStore(): { store: SessionJobs; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-jobs-'))
  return { store: new SessionJobs(join(dir, 'jobs')), dir }
}

describe('SessionJobs', () => {
  let dir = ''
  let store: SessionJobs

  before(() => {
    const m = makeStore()
    store = m.store
    dir = m.dir
  })

  after(() => {
    store.killAll()
    rmSync(dir, { recursive: true, force: true })
  })

  it('spawn returns a running snapshot immediately and lists it', () => {
    const snap = store.spawn({ command: "sh -c 'sleep 1'", rawCommand: 'sleep 1', cwd: dir, env })
    assert.equal(snap.status, 'running')
    assert.ok(snap.id.length > 0)
    const list = store.list()
    assert.ok(list.some((j) => j.id === snap.id))
  })

  it('await resolves when the process exits, with exit code and tail', async () => {
    const snap = store.spawn({ command: "echo done-marker", rawCommand: 'echo done-marker', cwd: dir, env })
    const res = await store.await(snap.id, { timeoutMs: 5000 })
    assert.ok(res)
    assert.equal(res!.job.status, 'exited')
    assert.equal(res!.job.exitCode, 0)
    assert.match(res!.tail, /done-marker/)
  })

  it('await resolves early when output matches the pattern', async () => {
    const snap = store.spawn({
      command: "sh -c 'echo READY; sleep 3'",
      rawCommand: 'server',
      cwd: dir,
      env,
    })
    const res = await store.await(snap.id, { pattern: 'READY', timeoutMs: 5000 })
    assert.ok(res)
    assert.equal(res!.matched, true)
    assert.equal(res!.timedOut, false)
    // Process is still running — pattern matched before exit.
    assert.equal(res!.job.status, 'running')
    store.kill(snap.id)
  })

  it('await times out while the process keeps running', async () => {
    const snap = store.spawn({ command: "sh -c 'sleep 3'", rawCommand: 'sleep 3', cwd: dir, env })
    const res = await store.await(snap.id, { timeoutMs: 120 })
    assert.ok(res)
    assert.equal(res!.timedOut, true)
    assert.equal(res!.matched, false)
    store.kill(snap.id)
  })

  it('kill terminates a running job and marks it killed', async () => {
    const snap = store.spawn({ command: "sh -c 'sleep 10'", rawCommand: 'sleep 10', cwd: dir, env })
    assert.equal(store.kill(snap.id), true)
    // Give the signal a moment to land + close event to fire.
    const res = await store.await(snap.id, { timeoutMs: 5000 })
    assert.ok(res)
    assert.equal(res!.job.status, 'killed')
  })

  it('auto-kills a job that exceeds its max lifetime', async () => {
    const snap = store.spawn({
      command: "sh -c 'sleep 30'",
      rawCommand: 'sleep 30',
      cwd: dir,
      env,
      maxLifetimeMs: 150,
    })
    const res = await store.await(snap.id, { timeoutMs: 5000 })
    assert.ok(res)
    assert.equal(res!.job.status, 'killed')
    assert.match(res!.tail, /exceeded max lifetime/)
  })

  it('does not cap lifetime when maxLifetimeMs is absent', async () => {
    const snap = store.spawn({ command: "sh -c 'sleep 1'", rawCommand: 'sleep 1', cwd: dir, env })
    // No lifetime cap → the job runs to natural completion (exit, not killed).
    const res = await store.await(snap.id, { timeoutMs: 5000 })
    assert.ok(res)
    assert.equal(res!.job.status, 'exited')
  })

  it('await on an unknown job id returns null', async () => {
    const res = await store.await('does-not-exist', { timeoutMs: 10 })
    assert.equal(res, null)
  })

  it('emits started and exit events; writes a log file', async () => {
    const events: JobEvent[] = []
    store.on('event', (ev: JobEvent) => events.push(ev))
    const snap = store.spawn({ command: 'echo hi-there', rawCommand: 'echo hi-there', cwd: dir, env })
    await store.await(snap.id, { timeoutMs: 5000 })
    // exit event may be followed by a final flush; poll briefly for it.
    await new Promise((r) => setTimeout(r, 50))
    const kinds = events.filter((e) => e.job.id === snap.id).map((e) => e.kind)
    assert.ok(kinds.includes('started'), 'expected a started event')
    assert.ok(kinds.includes('exit'), 'expected an exit event')
    assert.ok(existsSync(join(dir, 'jobs', `${snap.id}.log`)), 'expected a log file on disk')
  })

  it('killAll terminates every running job', async () => {
    const a = store.spawn({ command: "sh -c 'sleep 10'", rawCommand: 'sleep 10', cwd: dir, env })
    const b = store.spawn({ command: "sh -c 'sleep 10'", rawCommand: 'sleep 10', cwd: dir, env })
    store.killAll()
    await store.await(a.id, { timeoutMs: 5000 })
    await store.await(b.id, { timeoutMs: 5000 })
    const list = store.list()
    assert.equal(list.filter((j) => j.status === 'running').length, 0)
    assert.equal(store.hasRunning(), false)
  })

  it('kill on an already-exited job returns false and preserves the real exit code', async () => {
    const snap = store.spawn({ command: "sh -c 'exit 3'", rawCommand: 'exit 3', cwd: dir, env })
    const res = await store.await(snap.id, { timeoutMs: 5000 })
    assert.equal(res!.job.status, 'exited')
    assert.equal(res!.job.exitCode, 3)

    // 终态 guard 必须真实存在：kill 不得谎报成功（此前恒 true，
    // TUI 据 true 把 exit 3 覆盖成 killed）。
    assert.equal(store.kill(snap.id), false)
    const after = store.list().find(j => j.id === snap.id)
    assert.equal(after!.status, 'exited')
    assert.equal(after!.exitCode, 3, '终态 job 的真实 exit code 不得被覆盖')
  })

  it('终态条目超出上限时封顶淘汰（内存有界，最新保留）', async () => {
    const total = SessionJobs.MAX_TERMINAL_JOBS + 3
    const ids: string[] = []
    for (let i = 0; i < total; i++) {
      ids.push(store.spawn({ command: "sh -c 'exit 0'", rawCommand: 'exit 0', cwd: dir, env }).id)
    }
    await Promise.all(ids.map(id => store.await(id, { timeoutMs: 10_000 })))
    const list = store.list()
    assert.ok(list.length <= SessionJobs.MAX_TERMINAL_JOBS, `终态应封顶 ${SessionJobs.MAX_TERMINAL_JOBS}，实际 ${list.length}`)
    assert.ok(list.some(j => j.id === ids[total - 1]), '最新 job 必须保留')
  })

  it('await 等待期间按心跳上报（绑真实状态；resolve 后停止）', async () => {
    const beats: string[] = []
    const hbDir = mkdtempSync(join(tmpdir(), 'rivet-jobs-hb-'))
    const hbStore = new SessionJobs(join(hbDir, 'jobs'), (s) => beats.push(s), 40)
    try {
      const snap = hbStore.spawn({ command: "sh -c 'sleep 1'", rawCommand: 'sleep 1', cwd: hbDir, env })
      const res = await hbStore.await(snap.id, { timeoutMs: 700 })
      assert.ok(res)
      assert.ok(beats.length >= 2, `等待期间应至少上报 2 次心跳，实际 ${beats.length}`)
      assert.ok(beats.every((b) => b === `job:await:${snap.id}`), '心跳 source 必须携带 job id')
      const n = beats.length
      await new Promise((r) => setTimeout(r, 150))
      assert.equal(beats.length, n, 'await resolve 后心跳必须停止')
    } finally {
      hbStore.killAll()
      rmSync(hbDir, { recursive: true, force: true })
    }
  })
})

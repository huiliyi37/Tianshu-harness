import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionJobs, type JobEvent, type JobVerificationMeta } from '../job-store.js'

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

  after(async () => {
    await store.killAllAsync()
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
    const local = makeStore()
    const events: JobEvent[] = []
    local.store.on('event', (ev: JobEvent) => events.push(ev))
    try {
      const snap = local.store.spawn({ command: 'echo hi-there', rawCommand: 'echo hi-there', cwd: local.dir, env })
      await local.store.await(snap.id, { timeoutMs: 5000 })
      await local.store.killAllAsync()
      const kinds = events.filter((e) => e.job.id === snap.id).map((e) => e.kind)
      assert.ok(kinds.includes('started'), 'expected a started event')
      assert.ok(kinds.includes('exit'), 'expected an exit event')
      assert.ok(existsSync(join(local.dir, 'jobs', `${snap.id}.log`)), 'expected a log file on disk')
    } finally {
      await local.store.killAllAsync()
      rmSync(local.dir, { recursive: true, force: true })
    }
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

  it('killAllAsync waits for killed jobs to close and flush their logs', async () => {
    const local = makeStore()
    const exits: string[] = []
    local.store.on('event', (event: JobEvent) => {
      if (event.kind === 'exit') exits.push(event.job.id)
    })
    try {
      const a = local.store.spawn({ command: "node -e \"console.log('BEFORE-KILL'); setTimeout(()=>{},30000)\"", rawCommand: 'long job', cwd: local.dir, env })
      const ready = await local.store.await(a.id, { pattern: 'BEFORE-KILL', timeoutMs: 5000 })
      assert.equal(ready?.matched, true, ready?.tail)
      assert.equal(ready?.job.status, 'running')
      local.store.kill(a.id) // Already killed does not mean its handles are closed.
      const b = local.store.spawn({ command: 'node -e "setTimeout(()=>{},30000)"', rawCommand: 'immediate kill', cwd: local.dir, env })
      await local.store.killAllAsync()
      assert.ok(exits.includes(a.id) && exits.includes(b.id), 'both child close events must precede async cleanup return')
      assert.ok(local.store.list().every(job => job.status === 'killed' && job.endedAt !== undefined))
      assert.match(readFileSync(join(local.dir, 'jobs', `${a.id}.log`), 'utf8'), /BEFORE-KILL/)
      rmSync(local.dir, { recursive: true }) // Windows must have no open log handles.
      await local.store.killAllAsync() // Idempotent after successful cleanup.
    } finally {
      await local.store.killAllAsync()
      rmSync(local.dir, { recursive: true, force: true })
    }
  })

  it('honors the configured Windows job launcher instead of bypassing it', async () => {
    const local = makeStore()
    const previous = process.env.RIVET_JOB_LAUNCHER
    // A real Node executable rejects the launcher's --cwd contract. That rejection
    // proves the configured executable was invoked, without faking a native helper.
    process.env.RIVET_JOB_LAUNCHER = process.execPath
    try {
      const job = local.store.spawn({ command: 'node -e "console.log(\'UNWRAPPED-JOB-MARKER\')"', rawCommand: 'launcher contract', cwd: local.dir, env })
      const result = await local.store.await(job.id, { timeoutMs: 5000 })
      assert.equal(result?.timedOut, false)
      if (process.platform === 'win32') {
        assert.notEqual(result?.job.exitCode, 0)
        assert.match(result!.tail, /--cwd/)
        assert.doesNotMatch(result!.tail, /UNWRAPPED-JOB-MARKER/)
      } else {
        assert.equal(result?.job.exitCode, 0)
        assert.match(result!.tail, /UNWRAPPED-JOB-MARKER/)
      }
    } finally {
      if (previous === undefined) delete process.env.RIVET_JOB_LAUNCHER
      else process.env.RIVET_JOB_LAUNCHER = previous
      await local.store.killAllAsync()
      rmSync(local.dir, { recursive: true, force: true })
    }
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
      await hbStore.killAllAsync()
      rmSync(hbDir, { recursive: true, force: true })
    }
  })

  // ── 验证元数据（共同命令事实的私有上下文）：spawn 侧写入、收敛侧读取。
  // 取代「每个 convergence 检查重新猜整条命令」——runner 漏认（batch runner
  // 无 test/tsc 关键词）在新链路上不再是漏报源。

  it('waitingVerificationJob：running 且带等待资格命中；同一 job 终态后不再命中', async () => {
    const local = makeStore()
    try {
      const j = local.store.spawn({ command: "sh -c 'sleep 2'", rawCommand: 'npm run test:unit', cwd: local.dir, env })
      local.store.recordVerificationMeta(j.id, {
        waitingEligible: true, purpose: 'test', lifetime: 'finite', source: 'runner-kind',
      })
      assert.equal(local.store.waitingVerificationJob()?.id, j.id)

      // 终态 → 信标消失（只认 running，不给已结束的证据继续豁免）。
      local.store.kill(j.id)
      await local.store.await(j.id, { timeoutMs: 5000 })
      assert.equal(local.store.waitingVerificationJob(), null)
    } finally {
      await local.store.killAllAsync()
      rmSync(local.dir, { recursive: true, force: true })
    }
  })

  it('waiting protection expires once and never crosses a task boundary or leaks into events', async () => {
    const local = makeStore()
    const events: JobEvent[] = []
    local.store.on('event', (e: JobEvent) => events.push(e))
    try {
      const job = local.store.spawn({ command: "sh -c 'sleep 2'", rawCommand: 'node --test', cwd: local.dir, env })
      local.store.recordVerificationMeta(job.id, { waitingEligible: true, purpose: 'test', lifetime: 'finite', source: 'node-test' }, { timeout: 30000 })
      assert.equal(local.store.waitingVerificationJob(job.startedAt + 29999)?.id, job.id)
      assert.equal(local.store.waitingVerificationJob(job.startedAt + 30000), null)
      local.store.logs(job.id)
      local.store.recordVerificationMeta(job.id, { waitingEligible: true, purpose: 'test', lifetime: 'finite', source: 'node-test' }, { timeout: 900000 })
      assert.equal(local.store.waitingVerificationJob(job.startedAt + 600000), null, 'polling cannot renew protection')
      assert.equal(local.store.waitingVerificationJob(job.startedAt)?.id, job.id)
      local.store.beginTask()
      assert.equal(local.store.waitingVerificationJob(job.startedAt), null, 'new task cannot borrow old job')
      await local.store.killAllAsync()
      for (const snapshot of [...local.store.list(), ...events.map(e => e.job)]) {
        assert.deepEqual(Object.keys(snapshot).sort(), ['id', 'command', 'status', 'exitCode', 'startedAt', 'endedAt', 'lastLine', 'pid'].sort())
      }
    } finally { await local.store.killAllAsync(); rmSync(local.dir, { recursive: true, force: true }) }
  })

  it('旧正则漏认的套件形态经元数据仍可命中（runner 漏认失效）', async () => {
    const local = makeStore()
    try {
      // 门禁钦点的全量套件形态：不含 test/tsc/lint/build 等关键词，
      // 旧实现（收敛侧每次用 VERIFY_BASH_RE 重猜整条命令）会漏认 →
      // 把「正在等验证」读成停滞。新链路只看 spawn 时存下的元数据。
      const cmd = 'node --import tsx scripts/run-node-tests.ts src/tools/'
      const j = local.store.spawn({ command: "sh -c 'sleep 2'", rawCommand: cmd, cwd: local.dir, env })
      local.store.recordVerificationMeta(j.id, {
        waitingEligible: true, purpose: 'test', lifetime: 'finite', source: 'batch-runner',
      })
      const hit = local.store.waitingVerificationJob()
      assert.equal(hit?.id, j.id)
      assert.equal(hit?.meta.source, 'batch-runner')
    } finally {
      await local.store.killAllAsync()
      rmSync(local.dir, { recursive: true, force: true })
    }
  })

  it('waitingVerificationJob：无等待资格（persistent/unknown）与未记录元数据从不命中', async () => {
    const local = makeStore()
    try {
      const persistent = local.store.spawn({ command: "sh -c 'sleep 2'", rawCommand: 'npm run dev', cwd: local.dir, env })
      local.store.recordVerificationMeta(persistent.id, {
        waitingEligible: false, purpose: 'unknown', lifetime: 'persistent', source: 'persistent-shape',
      })
      assert.equal(local.store.waitingVerificationJob(), null)

      // 未记录元数据的 running job 同样不命中——缺数据 ≠ 等待资格。
      local.store.spawn({ command: "sh -c 'sleep 2'", rawCommand: 'sleep 2', cwd: local.dir, env })
      assert.equal(local.store.waitingVerificationJob(), null)
    } finally {
      await local.store.killAllAsync()
      rmSync(local.dir, { recursive: true, force: true })
    }
  })

  it('终态淘汰 job 时同步清理其验证元数据（不泄漏）', async () => {
    const local = makeStore()
    try {
      const total = SessionJobs.MAX_TERMINAL_JOBS + 3
      const ids: string[] = []
      for (let i = 0; i < total; i++) {
        const snap = local.store.spawn({ command: "sh -c 'exit 0'", rawCommand: `echo ${i}`, cwd: local.dir, env })
        local.store.recordVerificationMeta(snap.id, {
          waitingEligible: true, purpose: 'test', lifetime: 'finite', source: 'runner-kind',
        })
        ids.push(snap.id)
      }
      await Promise.all(ids.map(id => local.store.await(id, { timeoutMs: 10_000 })))
      // 淘汰由 exit 事件同步触发，等一拍确保事件链跑完再断言。
      await new Promise((r) => setTimeout(r, 50))
      const meta = (local.store as unknown as { verificationMeta: Map<string, JobVerificationMeta> }).verificationMeta
      assert.ok(meta.size <= SessionJobs.MAX_TERMINAL_JOBS, `淘汰后 meta 应封顶 ${SessionJobs.MAX_TERMINAL_JOBS}，实际 ${meta.size}`)
      assert.equal(meta.size, local.store.list().length, 'meta 必须与保留下来的 jobs 一一对应')
    } finally {
      await local.store.killAllAsync()
      rmSync(local.dir, { recursive: true, force: true })
    }
  })
})

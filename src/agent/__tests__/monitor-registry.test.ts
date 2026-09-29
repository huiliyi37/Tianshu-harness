import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionJobs, type JobEvent, type JobSnapshot } from '../../tools/job-store.js'
import { MonitorRegistry, MAX_DRAIN_TOTAL, MAX_DRAIN_PER_MONITOR } from '../monitor-registry.js'

/**
 * MonitorRegistry 单测。事件驱动两条路：
 *  - 确定性路径：直接 store.emit('event', 合成事件) —— 不等 500ms 节流；
 *  - 端到端路径：真实 spawn 短命令 + 轮询 drainEvents（验证真实事件流）。
 */

const env = { ...process.env }

function fakeSnapshot(id: string, status: JobSnapshot['status'] = 'running'): JobSnapshot {
  return { id, command: 'fake', status, startedAt: Date.now(), lastLine: '' }
}

function out(id: string, chunk: string): JobEvent {
  return { kind: 'output', job: fakeSnapshot(id), chunk }
}

describe('MonitorRegistry', () => {
  let dir: string
  let store: SessionJobs
  let registry: MonitorRegistry

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-mon-'))
    store = new SessionJobs(join(dir, 'jobs'))
    registry = new MonitorRegistry(() => store)
  })

  afterEach(async () => {
    registry.dispose()
    store.killAll()
    // Windows：被 kill 子进程的退出处理与日志流关闭（logStream.end）都挂事件
    // 循环回调上——同步 rmSync 在这些句柄释放前打击会 EPERM（POSIX 删除不受
    // 打开句柄限制，故 Linux CI 不可见）。fs.promises.rm 的异步重试在等待期间
    // 推进事件循环，句柄释放后即删成功。
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  function spawnSleeper(): string {
    const snap = store.spawn({ command: "sh -c 'sleep 5'", rawCommand: 'sleep 5', cwd: dir, env })
    return snap.id
  }

  it('subscribe 校验：未知 jobId / 非法正则 / 上限', () => {
    const bad = registry.subscribe({ jobId: 'nope' })
    assert.equal(bad.ok, false)
    assert.match((bad as { error: string }).error, /未找到/)

    const jobId = spawnSleeper()
    const badRegex = registry.subscribe({ jobId, pattern: '(' })
    assert.equal(badRegex.ok, false)
    assert.match((badRegex as { error: string }).error, /正则/)

    const capped = new MonitorRegistry(() => store, { maxMonitors: 1 })
    assert.equal(capped.subscribe({ jobId }).ok, true)
    const over = capped.subscribe({ jobId })
    assert.equal(over.ok, false)
    assert.match((over as { error: string }).error, /上限/)
    capped.dispose()
  })

  it('无 pattern：每个 output 脉冲产一条事件；drain 后清空；seq 单调', () => {
    const jobId = spawnSleeper()
    const res = registry.subscribe({ jobId })
    assert.ok(res.ok)
    const monId = res.ok ? res.monitor.id : ''

    store.emit('event', out(jobId, 'line1\nline2\n'))
    store.emit('event', out(jobId, 'line3\n'))

    const events = registry.drainEvents()
    assert.equal(events.length, 2)
    assert.equal(events[0]!.kind, 'output')
    assert.match(events[0]!.text, /line2/)
    assert.equal(events[0]!.monitorId, monId)
    assert.ok(events[1]!.seq > events[0]!.seq, 'seq 单调递增')
    assert.deepEqual(registry.drainEvents(), [], 'drain 后队列空')
  })

  it('有 pattern：只有命中行产事件，未命中静默', () => {
    const jobId = spawnSleeper()
    registry.subscribe({ jobId, pattern: 'ERROR|FAIL' })

    store.emit('event', out(jobId, 'all good\nnothing here\n'))
    assert.deepEqual(registry.drainEvents(), [])

    store.emit('event', out(jobId, 'info\nERROR boom\nFAIL hard\ntrace\n'))
    const events = registry.drainEvents()
    assert.equal(events.length, 1)
    assert.equal(events[0]!.kind, 'match')
    assert.match(events[0]!.text, /ERROR boom/)
    assert.match(events[0]!.text, /FAIL hard/)
    assert.ok(!events[0]!.text.includes('all good'))
  })

  it('drain 双上限：单 monitor ≤2、总量 ≤2，余量留队下轮', () => {
    const jobId = spawnSleeper()
    registry.subscribe({ jobId })
    for (let i = 0; i < 5; i++) store.emit('event', out(jobId, `burst ${i}\n`))

    const first = registry.drainEvents()
    assert.equal(first.length, Math.min(MAX_DRAIN_TOTAL, MAX_DRAIN_PER_MONITOR))
    const second = registry.drainEvents()
    assert.ok(second.length > 0)
    assert.ok(second.length <= MAX_DRAIN_PER_MONITOR)
    // 5 条事件，前两轮投 2+2，剩 1
    const third = registry.drainEvents()
    assert.equal(third.length, 1)
    assert.deepEqual(registry.drainEvents(), [])
  })

  it('队列溢出：丢最旧并先发「省略 N 条」合成事件', () => {
    const jobId = spawnSleeper()
    registry.subscribe({ jobId })
    for (let i = 0; i < 25; i++) store.emit('event', out(jobId, `flood ${i}\n`))

    const first = registry.drainEvents()
    assert.equal(first[0]!.kind, 'overflow')
    assert.match(first[0]!.text, /省略了 5 条/)
  })

  it('exit：终态事件投递后 monitor 自动注销', () => {
    const jobId = spawnSleeper()
    registry.subscribe({ jobId })
    assert.equal(registry.hasActive(), true)

    store.emit('event', { kind: 'exit', job: fakeSnapshot(jobId, 'exited') })
    const events = registry.drainEvents()
    assert.equal(events.length, 1)
    assert.equal(events[0]!.kind, 'exit')
    assert.match(events[0]!.text, /已退出/)
    // 遗言已投递 → 自动注销
    assert.equal(registry.hasActive(), false)
    assert.deepEqual(registry.list(), [])
  })

  it('unsubscribe 注销后不再收事件', () => {
    const jobId = spawnSleeper()
    const res = registry.subscribe({ jobId })
    const monId = res.ok ? res.monitor.id : ''
    assert.equal(registry.unsubscribe(monId), true)
    store.emit('event', out(jobId, 'after unsub\n'))
    assert.deepEqual(registry.drainEvents(), [])
    assert.equal(registry.unsubscribe(monId), false)
  })

  it('setJobs 替换实例后监听器自动重绑', () => {
    const jobId = spawnSleeper()
    let current: SessionJobs | undefined = store
    const rebindable = new MonitorRegistry(() => current)
    rebindable.subscribe({ jobId })

    const store2 = new SessionJobs(join(dir, 'jobs2'))
    current = store2
    // 下一次 drain 触发 ensureAttached 重绑到 store2
    rebindable.drainEvents()
    store2.emit('event', out(jobId, 'on new store\n'))
    const events = rebindable.drainEvents()
    assert.equal(events.length, 1)
    assert.match(events[0]!.text, /on new store/)
    rebindable.dispose()
    store2.killAll()
  })

  it('端到端：真实 job 输出经事件流进 drain（含终态自动注销）', async () => {
    const snap = store.spawn({
      command: "sh -c 'echo MON_READY; sleep 0.2'",
      rawCommand: 'probe',
      cwd: dir,
      env,
    })
    registry.subscribe({ jobId: snap.id, pattern: 'MON_READY' })

    const deadline = Date.now() + 4000
    let matched: string | undefined
    let exited = false
    while (Date.now() < deadline && (!matched || !exited)) {
      for (const ev of registry.drainEvents()) {
        if (ev.kind === 'match' && ev.text.includes('MON_READY')) matched = ev.text
        if (ev.kind === 'exit') exited = true
      }
      if (matched && exited) break
      await new Promise(r => setTimeout(r, 100))
    }
    assert.ok(matched, '应收到 MON_READY 命中事件')
    assert.equal(exited, true, '应收到终态事件')
    assert.equal(registry.hasActive(), false, '终态投递后自动注销')
  })
})

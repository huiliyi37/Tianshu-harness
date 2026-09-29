import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionJobs, type JobEvent, type JobSnapshot } from '../../../tools/job-store.js'
import { MonitorRegistry } from '../../monitor-registry.js'
import { createMonitorHook } from '../monitor-hook.js'
import type { AdvisoryEntry } from '../../advisory-bus.js'
import type { RuntimeHookContext } from '../../runtime-hooks.js'

/** monitor-hook：preTurn drain → advisory bus（system-reminder / functional / 含序号 key）。 */

const env = { ...process.env }

describe('monitor-hook（preTurn 事件投递）', () => {
  let dir: string
  let store: SessionJobs
  let registry: MonitorRegistry
  let submitted: AdvisoryEntry[]

  const bus = {
    submit(entry: AdvisoryEntry) {
      submitted.push(entry)
    },
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-monhook-'))
    store = new SessionJobs(join(dir, 'jobs'))
    registry = new MonitorRegistry(() => store)
    submitted = []
  })

  afterEach(async () => {
    registry.dispose()
    store.killAll()
    // Windows：被 kill 子进程的退出处理/流关闭挂事件循环回调——同步 rmSync 在
    // 句柄释放前打击会 EPERM（POSIX 不可见）；异步重试等待期间推进事件循环。
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  function spawnSleeper(): string {
    return store.spawn({ command: "sh -c 'sleep 5'", rawCommand: 'sleep 5', cwd: dir, env }).id
  }

  function emitOut(jobId: string, chunk: string): void {
    const job: JobSnapshot = { id: jobId, command: 'fake', status: 'running', startedAt: Date.now(), lastLine: '' }
    const ev: JobEvent = { kind: 'output', job, chunk }
    store.emit('event', ev)
  }

  const ctx = {} as RuntimeHookContext

  it('无活 monitor 时不投递', () => {
    const hook = createMonitorHook({ advisoryBus: bus, getMonitors: () => registry })
    hook.run(ctx)
    assert.deepEqual(submitted, [])
  })

  it('事件以 functional system-reminder 投递，key 含序号防去重', () => {
    const jobId = spawnSleeper()
    registry.subscribe({ jobId, pattern: 'ERROR' })
    const hook = createMonitorHook({ advisoryBus: bus, getMonitors: () => registry })

    emitOut(jobId, 'ERROR one\n')
    hook.run(ctx)
    assert.equal(submitted.length, 1)
    const e = submitted[0]!
    assert.match(e.key, /^monitor-mon-[0-9a-f]{6}-\d+$/, 'key 含 monitor id + 序号')
    assert.equal(e.channel, 'system-reminder')
    assert.equal(e.srClass, 'functional')
    assert.equal(e.immediate, true)
    assert.equal(e.category, 'monitor')
    assert.match(e.content, /ERROR one/)

    // 再来一条：新序号 → 新 key（不会被同 key 去重吞掉）
    emitOut(jobId, 'ERROR two\n')
    hook.run(ctx)
    assert.equal(submitted.length, 2)
    assert.notEqual(submitted[1]!.key, submitted[0]!.key)

    // 无新事件 → 不投递
    hook.run(ctx)
    assert.equal(submitted.length, 2)
  })

  it('monitors 未接线（undefined）时静默跳过', () => {
    const hook = createMonitorHook({ advisoryBus: bus, getMonitors: () => undefined })
    hook.run(ctx)
    assert.deepEqual(submitted, [])
  })
})

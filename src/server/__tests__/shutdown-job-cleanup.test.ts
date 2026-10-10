/**
 * 生产关闭路径必须等后台 job 句柄释放（PR #364 killAllAsync 的接线回归）。
 *
 * 病灶：killAllAsync（等 child close + 日志流关闭）收编后只有测试消费，
 * 生产关闭路径仍走同步 killAll() 只发信号不等待——进程退出 / 更新替换时
 * Windows 日志句柄未关，修复没真正落地。
 *
 * 反证表（回滚哪条会红）：
 *   - shutdownAll 回退 killAll()      → 用例 1 的 endedAt/日志断言红（返回时 child 未 close）
 *   - prepareUpdateRestart 回退 killAll() → 用例 2 同断言红
 *
 * endedAt 只在 onExit（child 'close'）时写入，是「等没等句柄关闭」的便携判据
 * （rmSync 不借力——Windows 句柄语义 POSIX 上测不出）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { RuntimeSessionManager, type ManagedAgent, type SessionPersistenceAdapter } from '../session-manager.js'
import { SessionJobs } from '../../tools/job-store.js'
import { getShellCommand } from '../../platform.js'

const persistence = (): SessionPersistenceAdapter => ({
  saveRecord() {}, appendEvent() {}, loadAll: () => [],
  flushThrough: async (_, seq) => seq, flushAllAsync: async () => {},
  healthSnapshot: () => ({ failedSessions: 0, pendingEvents: 0 }),
})

/** 真 manager + 捕获 server-owned job 注册表的 stub agent（applySelections 经 setJobs 注入）。 */
function managerCapturingJobs(root: string): { m: RuntimeSessionManager; jobs: () => SessionJobs | undefined } {
  let captured: SessionJobs | undefined
  const m = new RuntimeSessionManager({
    defaultCwd: root,
    createAgent: () => ({
      setJobs: (j: SessionJobs) => { captured = j },
      flushPersistence: async () => {},
      abort: () => {},
    } as unknown as ManagedAgent),
    persistence: persistence(),
  })
  return { m, jobs: () => captured }
}

/** 起一条真长跑 job 并等它产出首行（日志流有未 flush 内容，句柄确实开着）。 */
async function spawnLongJob(jobs: SessionJobs, cwd: string) {
  const script = join(cwd, 'long-job.mjs')
  writeFileSync(script, "console.log('BEFORE-KILL'); setInterval(() => {}, 1000)\n")
  const quotePath = (path: string) => JSON.stringify(path.replace(/\\/g, '/'))
  const command = `${getShellCommand().kind === 'powershell' ? '& ' : ''}${quotePath(process.execPath)} ${quotePath(script)}`
  const snap = jobs.spawn({ command, rawCommand: 'long job', cwd, env: process.env })
  const started = await jobs.await(snap.id, { pattern: 'BEFORE-KILL', timeoutMs: 5000 })
  assert.equal(started?.matched, true, 'the native job must start before cleanup is tested')
  return snap
}

function assertJobCleanedUp(jobs: SessionJobs, jobId: string, root: string, label: string): void {
  const after = jobs.list().find(j => j.id === jobId)
  assert.equal(after?.status, 'killed', `${label}: job 应被杀`)
  assert.ok(after?.endedAt !== undefined, `${label}: 返回前必须等到 child close（endedAt 写入）——只发信号不等关闭即回退`)
  const logPath = join(root, '.rivet', 'artifacts', 'jobs', `${jobId}.log`)
  assert.match(readFileSync(logPath, 'utf8'), /BEFORE-KILL/, `${label}: 返回前日志流必须已 flush 关闭`)
}

test('shutdownAll 等后台 job child close + 日志 flush 才返回（进程退出主路径）', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'sm-shutdown-jobs-'))
  const { m, jobs } = managerCapturingJobs(root)
  try {
    const s = m.createSession({ cwd: root })
    assert.ok(await m.ensureSessionAgent(s.id), 'stub agent 装配必须成功')
    const registry = jobs()
    assert.ok(registry, 'agent 装配必须绑定 server-owned job 注册表（setJobs 未被调用）')
    const snap = await spawnLongJob(registry, root)

    await m.shutdownAll()

    assertJobCleanedUp(registry, snap.id, root, 'shutdownAll')
  } finally {
    await m.shutdownAll()
    rmSync(root, { recursive: true, force: true })
  }
})

test('prepareUpdateRestart(force) 等后台 job 清理完成才放行更新链', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'sm-restart-jobs-'))
  const { m, jobs } = managerCapturingJobs(root)
  try {
    const s = m.createSession({ cwd: root })
    assert.ok(await m.ensureSessionAgent(s.id), 'stub agent 装配必须成功')
    const registry = jobs()
    assert.ok(registry, 'agent 装配必须绑定 server-owned job 注册表（setJobs 未被调用）')
    const snap = await spawnLongJob(registry, root)

    // force 路径：更新随即替换二进制/数据文件（Windows 要求句柄全关），
    // 不能只看 status 翻成 killed 就放行。
    await m.prepareUpdateRestart(true, AbortSignal.timeout(30_000))

    assertJobCleanedUp(registry, snap.id, root, 'prepareUpdateRestart')
  } finally {
    m.cancelUpdateRestart()
    await m.shutdownAll()
    rmSync(root, { recursive: true, force: true })
  }
})

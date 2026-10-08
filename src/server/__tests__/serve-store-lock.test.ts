/**
 * P0-1 接线回归：会话库单写者独占锁接进 serve 生产路径。
 *
 * 病灶（store-lock.ts 头部）：多个 sidecar 共用同一 desktop 会话库时，后来者
 * 启动就会跑 rehydrate()，把别人正在跑的会话标成『已中断』并写入 seq 高出
 * CRASH_RECOVERY_SEQ_GAP 的假标记——前端 `ev.seq <= state.lastSeq` 守卫随后
 * 丢掉之后全部真实输出（『假续跑』）。锁本身（Wave 1）已实现并单测，本文件钉的
 * 是**接线**：serve.ts 是否真的在装配会话库之前拿锁、拿不到时是否真降级、
 * health 是否报出占用者、退出是否释放。
 *
 * 这是真实的跨进程边界测试（真 spawn serve、真锁文件、真 HTTP），不是 mock：
 *   - 回滚『serve.ts 拿锁』→ 第二个实例 readiness 不是 failed（用例 2 红）
 *   - 回滚『health 第 9 参』→ storeLockHolder 缺失（用例 2 红）
 *   - 回滚『退出释放锁』→ 第一个实例退出后锁文件残留、第三个实例仍 contended（用例 3 红）
 *
 * 每个子进程用独立的 RIVET_HOME / RIVET_DESKTOP_DIR 临时目录，绝不触碰真实
 * ~/.rivet/desktop（StoreLock 的 node:test 护栏之外再加一层）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { readLockFile } from '../cron-lock.js'

const SERVE_TS = new URL('../serve.ts', import.meta.url)
const TOKEN = 'store-lock-smoke-token'

type HealthBody = Record<string, unknown>

interface ServeHandle {
  child: ChildProcess
  port: number
  stderr: string[]
}

/** 起一个真 serve 子进程（driver 复刻生产入口 serveCommand）。 */
function spawnServe(root: string, port: number, lockError = false): ServeHandle {
  const home = join(root, 'home')
  const desktop = join(root, 'desktop')
  mkdirSync(home, { recursive: true })
  if (!existsSync(join(home, 'config.json'))) writeFileSync(join(home, 'config.json'), '{}')
  const driverPath = join(root, `driver-${port}.mjs`)
  writeFileSync(
    driverPath,
    (lockError ? `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';\n`
      + `fs.linkSync = () => { throw Object.assign(new Error('permission denied'), {code:'EACCES'}) }; syncBuiltinESMExports();\n` : '')
    + `const { serveCommand } = await import(${JSON.stringify(SERVE_TS.href)})\n`
    + `await serveCommand(['--port', String(${port}), '--host', '127.0.0.1'])\n`,
    'utf8',
  )
  const child = spawn(process.execPath, ['--import', 'tsx', driverPath], {
    env: {
      ...process.env,
      RIVET_HOME: home,
      RIVET_DESKTOP_DIR: desktop,
      RIVET_SERVER_TOKEN: TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stderr: string[] = []
  child.stderr?.on('data', (d) => stderr.push(String(d)))
  child.stdout?.on('data', () => { /* drain：管道写满会卡住子进程 */ })
  return { child, port, stderr }
}

async function readHealth(port: number): Promise<HealthBody> {
  const res = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(res.status, 200, `GET /health 应 200，实际 ${res.status}`)
  return (await res.json()) as HealthBody
}

async function waitForHealth(
  handle: ServeHandle,
  pred: (body: HealthBody) => boolean,
  timeoutMs: number,
  label: string,
): Promise<HealthBody> {
  const deadline = Date.now() + timeoutMs
  let last: HealthBody | undefined
  let lastError = ''
  while (Date.now() < deadline) {
    if (handle.child.exitCode !== null) {
      throw new Error(`${label}：子进程提前退出 code=${handle.child.exitCode}；stderr=${handle.stderr.join('').slice(-600)}`)
    }
    try {
      last = await readHealth(handle.port)
      if (pred(last)) return last
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(
    `${label}：${timeoutMs}ms 内未满足。最后 health=${JSON.stringify(last)}；lastError=${lastError}；`
    + `stderr=${handle.stderr.join('').slice(-600)}`,
  )
}

/** 等子进程退出，返回 exit code（被信号杀死返回 -1）。 */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve(child.exitCode)
    const timer = setTimeout(() => reject(new Error(`${timeoutMs}ms 内子进程未退出（优雅链悬挂？）`)), timeoutMs)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code === null ? -1 : code)
    })
  })
}

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net')
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      const p = typeof addr === 'object' && addr ? addr.port : 0
      s.close(() => resolve(p))
    })
  })
}

test('P0-1 接线：先到者独占会话库，后来者降级为 data-dir-locked 并报出占用者；锁释放后可接管', {
  timeout: 300_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'serve-store-lock-'))
  mkdirSync(join(root, 'home'), { recursive: true })
  mkdirSync(join(root, 'desktop'), { recursive: true })
  const lockPath = join(root, 'desktop', 'sidecar.lock')

  const handles: ServeHandle[] = []
  try {
    // ── 实例 1：先到者，应拿到锁 ─────────────────────────────────────────
    const first = spawnServe(root, await freePort())
    handles.push(first)
    const firstHealth = await waitForHealth(
      first,
      (b) => b.readiness === 'ready',
      90_000,
      '实例 1 未就绪',
    )
    assert.ok(!('storeLockHolder' in firstHealth), '持锁实例不应报占用者（它自己就是属主）')
    assert.ok(existsSync(lockPath), '拿到锁的实例必须在 desktopDir()/sidecar.lock 留下锁文件')
    const lockInfo = readLockFile(lockPath)!
    assert.equal(lockInfo.pid, first.child.pid, '锁文件的 pid 应是实例 1 自身')

    // ── 实例 2：后来者，5s 重试窗口后降级运行 ────────────────────────────
    const second = spawnServe(root, await freePort())
    handles.push(second)
    const secondHealth = await waitForHealth(
      second,
      (b) => b.readiness === 'failed',
      90_000,
      '实例 2 未按预期降级（readiness=failed）',
    )
    assert.equal(secondHealth.initializationError, 'data-dir-locked',
      '拿不到锁必须把 initializationError 置为 data-dir-locked（createAgent 据此拒绝建会话）')
    const holder = secondHealth.storeLockHolder as { pid?: number } | undefined
    assert.ok(holder, '降级实例必须报出占用者（health 第 9 参 storeLockHolder 未接线）')
    assert.equal(holder!.pid, first.child.pid, '占用者 pid 应是实例 1')
    assert.equal(secondHealth.registryOk, false, '降级实例不接注册表（会话库不得被触碰）')
    const rejected = await fetch(`http://127.0.0.1:${second.port}/sessions`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'fictional rejected session' }),
    })
    assert.equal(rejected.status, 503, 'a diagnostic instance must not accept an unpersisted session')
    assert.equal((await rejected.json() as { error: string }).error, 'data-dir-locked')
    const diagnosticSessions = await fetch(`http://127.0.0.1:${second.port}/sessions`, { headers: { authorization: `Bearer ${TOKEN}` } })
    assert.equal(diagnosticSessions.status, 200, 'read-only diagnostics remain reachable')
    assert.deepEqual((await diagnosticSessions.json() as { sessions: unknown[] }).sessions, [])
    // 会话库所有权不得易主
    assert.equal(readLockFile(lockPath)?.pid, first.child.pid,
      '降级实例不得抢走活锁')

    // ── 实例 1 优雅退出 → 必须释放锁 ─────────────────────────────────────
    const shutdown = await fetch(`http://127.0.0.1:${first.port}/shutdown`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}` },
    })
    assert.equal(shutdown.status, 200)
    const firstCode = await waitForExit(first.child, 30_000)
    assert.equal(firstCode, 0, `实例 1 应优雅退出 code=0，实际 ${firstCode}；stderr=${first.stderr.join('').slice(-400)}`)
    assert.ok(!existsSync(lockPath), '正常退出必须释放锁文件——残留会让下一个实例被判 contended')

    // ── 实例 3：锁已释放，应立即可接管 ───────────────────────────────────
    const third = spawnServe(root, await freePort())
    handles.push(third)
    const thirdHealth = await waitForHealth(
      third,
      (b) => b.readiness === 'ready',
      90_000,
      '实例 3 未能在前持有者退出后就绪',
    )
    assert.ok(!('initializationError' in thirdHealth), '实例 3 不该再报初始化失败')
    assert.equal(readLockFile(lockPath)?.pid, third.child.pid,
      '实例 3 必须成为新的锁属主')
  } finally {
    for (const h of handles) {
      if (h.child.exitCode === null && !h.child.killed) h.child.kill('SIGKILL')
    }
    try { rmSync(root, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})


test('锁创建权限失败报告 data-dir-lock-error，不虚构占用进程', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'serve-lock-error-'))
  const handle = spawnServe(root, await freePort(), true)
  try {
    const health = await waitForHealth(handle, b => b.readiness === 'failed', 90_000, 'lock error readiness')
    assert.equal(health.initializationError, 'data-dir-lock-error')
    assert.ok(!health.storeLockHolder)
    assert.equal(health.registryOk, false)
    assert.ok(handle.stderr.join('').includes('会话库锁创建失败'))
    const rejected = await fetch(`http://127.0.0.1:${handle.port}/sessions`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: '{}',
    })
    assert.equal(rejected.status, 503)
    assert.equal((await rejected.json() as { error: string }).error, 'data-dir-lock-error')
    handle.child.kill('SIGTERM')
    await waitForExit(handle.child, 15_000)
  } finally {
    if (handle.child.exitCode === null) handle.child.kill('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
})

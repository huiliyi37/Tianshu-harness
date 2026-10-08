import { readLockFile } from '../cron-lock.js'
/**
 * Store lock — 跨进程端到端黑盒验收（P0-1『假续跑』）
 *
 * 观察对象：两个**真实 serve 进程**（各自独立 node 进程，经 `node --import tsx`
 * 跑 serveCommand）对同一份会话库（同一个 RIVET_HOME / RIVET_DESKTOP_DIR）的竞争。
 * 这是『假续跑』修复的直接验收——黑盒只认三个外部可观察量，不读进程内状态：
 *   ① GET /health（带 token）的 readiness / initializationError / storeLockHolder；
 *   ② `<desktop>/sidecar.lock` 的持有者；
 *   ③ 会话库目录的字节级内容清单（size + mtime + sha256）。
 *
 * 与 Wave 1 单测（store-lock.test.ts）的分工：那边盯进程内的 StoreLock 状态机，
 * 这边盯『接线之后两个真实进程是否按契约各守其位』——14 条单测全绿**不**保证
 * serve 真把锁接上了，也不保证拿不到锁的那个进程真的没碰会话库。
 *
 * 依赖同波 serve-integration 的接线。接线未落地时本文件预期 RED，失败形态是
 * 「B 仍 readiness=ready / 未自报 data-dir-locked / 现场 running 会话被追加崩溃
 * 恢复标记」——这是**预期时序**（见工单），不要为让它变绿而弱化断言或改 serve.ts。
 * 已实测的 RED 证据见文件末尾「RED 形态（实测）」。
 *
 * 隔离（硬约束）：全部用例走 mkdtemp 临时 RIVET_HOME / RIVET_DESKTOP_DIR；子进程
 * 另置位 NODE_TEST_CONTEXT——store-lock.ts 的 testGuardError 会拒绝把锁路径解析到
 * 平台默认真实目录的任何进程。双保险，任何一条断裂都不会碰到真实 ~/.rivet。
 *
 * 还原缺陷即红（接线落地后自检）：撤掉 serve.ts 的锁接线 → 用例 1 在 readiness
 * 断言上红、用例 3 在「events.jsonl 字节不变」上红；恢复接线 → 绿。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

/** serve 的真实入口（子进程内由 tsx 现场转译——契约测试盯源码，e2e 盯真实行为）。 */
const SERVE_TS = new URL('../serve.ts', import.meta.url)

/** RIVET_SERVER_TOKEN：只有带 token 的 /health 才拿全量体（rich fields 是活动侧信道）。 */
const TOKEN = 'store-lock-e2e-token'

/** POSIX 才有真信号语义；Windows 上 child.kill('SIGTERM') 走 TerminateProcess。 */
const POSIX = process.platform !== 'win32'

/** serve 就绪预算：实测冷启 ~3.5s（含 serve-agent/插件预热），45s 是宽裕上界。 */
const STARTUP_TIMEOUT_MS = 45_000

/** 会话库无写入的观察窗：rehydrate 的写链是异步 kickWriteChain，给足落盘时间。 */
const SETTLE_MS = 1_500

// ── 类型 ───────────────────────────────────────────────────────────────────

interface HealthBody {
  readiness?: 'ready' | 'initializing' | 'failed'
  initializationError?: string
  storeLockHolder?: { pid?: number; startedAtMs?: number; hostname?: string }
  sessionCount?: number
  runningCount?: number
  registryOk?: boolean
  ok?: boolean
  version?: string
  [key: string]: unknown
}

interface StoredLockInfo {
  pid?: number
  acquiredAt?: string
  hostname?: string
  ownerToken?: string
  startedAtMs?: number
}

interface ServeProc {
  child: ChildProcess
  port: number
  /** 子进程 stdout+stderr 尾段（失败诊断用）。 */
  log: () => string
}

interface TreeEntry { size: number; mtimeMs: number; sha256: string }

// ── 夹具 ───────────────────────────────────────────────────────────────────

/** 造一个全隔离的根目录：home/ + desktop/（sessions/ 由 serve 自己按需落盘）。 */
function makeRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `store-lock-e2e-${label}-`))
  // 前置校验：任何情况下都不许把根落在真实数据目录里（护栏兜底之外的自检）。
  assert.ok(root.startsWith(tmpdir()), `临时根必须落在 ${tmpdir()}：${root}`)
  mkdirSync(join(root, 'home'), { recursive: true })
  mkdirSync(join(root, 'desktop'), { recursive: true })
  return root
}

function homeDir(root: string): string { return join(root, 'home') }
function desktopDir(root: string): string { return join(root, 'desktop') }
function sessionsDir(root: string): string { return join(root, 'desktop', 'sessions') }

/** 起一个真实 serve 子进程（复刻生产入口 serveCommand）。 */
function spawnServe(root: string, port: number, label: string): ServeProc {
  const driverPath = join(root, `driver-${label}.mjs`)
  writeFileSync(
    driverPath,
    `import { serveCommand } from ${JSON.stringify(SERVE_TS.href)}\n` +
    `await serveCommand(['--port', String(${port})])\n`,
    'utf8',
  )
  const child = spawn(process.execPath, ['--import', 'tsx', driverPath], {
    env: {
      ...process.env,
      RIVET_HOME: homeDir(root),
      RIVET_DESKTOP_DIR: desktopDir(root),
      RIVET_SERVER_TOKEN: TOKEN,
      // 护栏置位：serve 若把锁路径解析到平台默认真实目录，StoreLock 直接拒绝启动。
      NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? 'store-lock-e2e',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true, // Windows 上不弹控制台窗口（guard 只扫 src/ 非测试文件，这里保持一致）
  })
  const chunks: string[] = []
  child.stdout?.on('data', (d) => chunks.push(String(d)))
  child.stderr?.on('data', (d) => chunks.push(String(d)))
  return { child, port, log: () => chunks.join('').slice(-2_000) }
}

/** 带 token 探 /health；任何失败（未监听/超时/非 200）都返回 null，由轮询决定重试。 */
async function fetchHealth(port: number, onFailure?: (reason: string) => void): Promise<HealthBody | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(2_000),
    })
    if (!res.ok) {
      onFailure?.(`HTTP ${res.status}: ${await res.text()}`)
      return null
    }
    return (await res.json()) as HealthBody
  } catch (error) {
    onFailure?.(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    return null
  }
}

/**
 * 轮询直到 /health 满足条件。子进程先退出时立刻失败（并附日志尾），
 * 不要把「进程死了」误报成「等不到就绪」。
 */
async function waitForHealth(
  p: ServeProc,
  pred: (h: HealthBody) => boolean,
  what: string,
  timeoutMs = STARTUP_TIMEOUT_MS,
): Promise<HealthBody> {
  const deadline = Date.now() + timeoutMs
  let last: HealthBody | null = null
  while (Date.now() < deadline) {
    if (p.child.exitCode !== null || p.child.signalCode !== null) {
      throw new Error(
        `${what}：serve(pid=${p.child.pid}) 已退出（code=${p.child.exitCode} signal=${p.child.signalCode}）\n${p.log()}`,
      )
    }
    const body = await fetchHealth(p.port)
    if (body) {
      last = body
      if (pred(body)) return body
    }
    await sleep(50)
  }
  throw new Error(`${what}：${timeoutMs}ms 内未满足；最后一次 /health=${JSON.stringify(last)}\n${p.log()}`)
}

/** 会话库目录的字节级清单（含不存在 = 空清单）。 */
function treeSnapshot(dir: string): Record<string, TreeEntry> {
  const out: Record<string, TreeEntry> = {}
  if (!existsSync(dir)) return out
  const walk = (cur: string): void => {
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      const st = statSync(full)
      out[relative(dir, full)] = {
        size: st.size,
        mtimeMs: st.mtimeMs,
        sha256: createHash('sha256').update(readFileSync(full)).digest('hex'),
      }
    }
  }
  walk(dir)
  return out
}

/** 清单差异的人读形式（断言失败时贴进消息，别只说 deepEqual 不等）。 */
function treeDiff(before: Record<string, TreeEntry>, after: Record<string, TreeEntry>): string {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  const rows = keys
    .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    .map((k) => `  ${k}: ${JSON.stringify(before[k])} → ${JSON.stringify(after[k])}`)
  return rows.length ? rows.join('\n') : '  （无差异）'
}

/** 读锁文件（不存在/半写损坏 → null）。 */
function readStoreLock(root: string): StoredLockInfo | null {
  const path = join(desktopDir(root), 'sidecar.lock')
  if (!existsSync(path)) return null
  try {
    return readLockFile(path) as StoredLockInfo | null
  } catch {
    return null
  }
}

/** 取一个空闲 TCP 端口（先占再放，竞态窗口可接受——测试独占机器时段）。 */
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

/** 等子进程退出，返回 exit code（被信号杀时 code=null → -1，让断言失败可见）。 */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`子进程 ${timeoutMs}ms 内未退出（优雅链悬挂？）`)),
      timeoutMs,
    )
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code === null ? -1 : code)
    })
  })
}

/** 收尾：先 TERM 再（必要时）KILL，保证没有 serve 残留跨用例污染。 */
async function reap(p: ServeProc | undefined, timeoutMs = 15_000): Promise<void> {
  if (!p) return
  if (p.child.exitCode !== null || p.child.signalCode !== null) return
  p.child.kill('SIGTERM')
  try {
    await waitForExit(p.child, timeoutMs)
  } catch {
    p.child.kill('SIGKILL')
  }
}

/** 预置一份『另一个 sidecar 正在跑』的会话现场（页面：index.json + events.jsonl）。 */
function seedRunningSession(root: string, id: string, lastSeq = 2): string {
  const dir = join(sessionsDir(root), id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'index.json'),
    JSON.stringify({
      id, status: 'running', createdAt: 1, updatedAt: 5, cwd: '/work',
      lastSeq, pendingApprovals: 0,
    }),
    'utf8',
  )
  writeFileSync(
    join(dir, 'events.jsonl'),
    JSON.stringify({ seq: 1, ts: 101, type: 'status', data: { status: 'running' } }) + '\n' +
    JSON.stringify({ seq: 2, ts: 102, type: 'text_delta', data: { text: 'hi' } }) + '\n',
    'utf8',
  )
  return dir
}

// ── 用例 1：双进程竞争 ─────────────────────────────────────────────────────

test('e2e：第二个 serve 不得触碰会话库，且自报 data-dir-locked', { timeout: 90_000 }, async () => {
  const root = makeRoot('contend')
  let a: ServeProc | undefined
  let b: ServeProc | undefined
  try {
    a = spawnServe(root, await freePort(), 'a')
    const aReady = await waitForHealth(a, (h) => h.readiness === 'ready', 'A 未达 readiness=ready')
    assert.equal(aReady.initializationError, undefined, `A 是先到者，不该有初始化错误：${JSON.stringify(aReady)}`)

    // 静默窗口：A 的启动写盘落定后，才取会话库基线（否则会把 A 自己的启动写算到 B 头上）
    await sleep(300)
    const before = treeSnapshot(sessionsDir(root))

    b = spawnServe(root, await freePort(), 'b')
    // 等到 B 给出**终态** readiness（ready 或 failed），再逐字段断言——
    // 这样接线缺失时的失败信息是「B 实际 ready」，而不是一句「等超时」。
    const bHealth = await waitForHealth(
      b,
      (h) => h.readiness === 'failed' || h.readiness === 'ready',
      'B 未给出终态 readiness',
    )

    assert.equal(
      bHealth.readiness,
      'failed',
      `B 拿不到会话库锁必须自报 readiness=failed；实际 ${String(bHealth.readiness)}，体=${JSON.stringify(bHealth)}\n${b.log()}`,
    )
    assert.equal(
      bHealth.initializationError,
      'data-dir-locked',
      `B 的 initializationError 必须是 data-dir-locked（桌面壳据它区分「重试必败」，见 desktop/src-tauri/src/lib.rs auto_restart_blocked）；` +
      `实际 ${JSON.stringify(bHealth.initializationError)}，体=${JSON.stringify(bHealth)}\n${b.log()}`,
    )
    assert.equal(
      bHealth.storeLockHolder?.pid,
      a.child.pid,
      `B 必须回报占用者 pid = A(${String(a.child.pid)})；实际 holder=${JSON.stringify(bHealth.storeLockHolder)}`,
    )

    // 锁文件归 A（占用者自报与落盘必须一致，两处任一漂移都是错）
    const lock = readStoreLock(root)
    assert.ok(lock, 'A 持锁期间 sidecar.lock 必须存在')
    assert.equal(lock?.pid, a.child.pid, `sidecar.lock 必须归 A(${String(a.child.pid)})：${JSON.stringify(lock)}`)

    // A 不该被 B 的启动干扰（先到者继续持有写权）
    let aHealthFailure = ''
    const aAfter = await fetchHealth(a.port, reason => { aHealthFailure = reason })
    assert.equal(aAfter?.readiness, 'ready', `B 启动后 A 必须仍是 ready：${JSON.stringify(aAfter)}；` +
      `pid=${a.child.pid} code=${a.child.exitCode} signal=${a.child.signalCode} probe=${aHealthFailure}\n${a.log()}`)
    assert.equal(aAfter?.initializationError, undefined, `A 不得被标记初始化失败：${JSON.stringify(aAfter)}`)

    // 『假续跑不复发』的直接证据：B 启动全程会话库目录零写入。
    // 注意强度：本用例不预置会话，sessions/ 通常为空清单 → 这条是「没有多出任何东西」的
    // 弱形态；on-disk 现场的强形态由用例 3（预置 running 会话 + 字节比对）承担。
    await sleep(SETTLE_MS)
    const after = treeSnapshot(sessionsDir(root))
    assert.deepEqual(
      after,
      before,
      `B 启动期间会话库不得出现任何新写入（size/mtime/sha256 全等）：\n${treeDiff(before, after)}`,
    )
  } finally {
    await reap(b)
    await reap(a)
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 用例 2：释放后接管 ─────────────────────────────────────────────────────

test('e2e：A 优雅退出后 C 拿到锁并就绪', { timeout: 90_000 }, async () => {
  const root = makeRoot('handover')
  let a: ServeProc | undefined
  let c: ServeProc | undefined
  try {
    a = spawnServe(root, await freePort(), 'a')
    await waitForHealth(a, (h) => h.readiness === 'ready', 'A 未达 readiness=ready')

    const lockA = readStoreLock(root)
    assert.ok(lockA, 'A 持锁期间 sidecar.lock 必须存在——没有它就谈不上「释放」')
    assert.equal(lockA?.pid, a.child.pid, `锁文件应归 A(${String(a.child.pid)})：${JSON.stringify(lockA)}`)

    // 优雅停止：走 serve 的 SIGTERM 通路（与 SIGHUP/SIGINT 同一关停链）
    a.child.kill('SIGTERM')
    const code = await waitForExit(a.child, 30_000)
    if (POSIX) {
      assert.equal(code, 0, `A 应优雅退出（process.exit(0)），实际 code=${code}；${a.log()}`)
    }
    // TODO(主控)：Windows 上 SIGTERM ≈ TerminateProcess，退出码不可归因 → 此处不断言 code。

    c = spawnServe(root, await freePort(), 'c')
    const cHealth = await waitForHealth(c, (h) => h.readiness === 'ready', 'C 未达 readiness=ready')
    assert.equal(cHealth.initializationError, undefined, `A 已退出，C 不该有初始化错误：${JSON.stringify(cHealth)}`)
    assert.equal(
      cHealth.storeLockHolder,
      undefined,
      `持锁者不得自报 storeLockHolder；实际 ${JSON.stringify(cHealth.storeLockHolder)}`,
    )

    // 锁归 C：A 释放了（或死 PID 被判定陈旧后回收），两种路径都必须落到 C 名下
    const lockC = readStoreLock(root)
    assert.ok(lockC, 'C 就绪后 sidecar.lock 必须存在')
    assert.equal(lockC?.pid, c.child.pid, `锁必须归 C(${String(c.child.pid)})：${JSON.stringify(lockC)}`)
    // TODO(主控)：补充「C 的锁 acquiredAt 晚于 A 退出」的时间序断言（需要锁文件带 acquiredAt）。
  } finally {
    await reap(c)
    await reap(a)
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 用例 3：现场 running 会话不被 rehydrate（假续跑的本体）──────────────────

test('e2e：B 启动不得 rehydrate 现场的 running 会话（字节不变）', { timeout: 90_000 }, async () => {
  const root = makeRoot('rehydrate')
  let a: ServeProc | undefined
  let b: ServeProc | undefined
  try {
    a = spawnServe(root, await freePort(), 'a')
    await waitForHealth(a, (h) => h.readiness === 'ready', 'A 未达 readiness=ready')

    // A（持锁者）运行期间，往会话库预置一份「另一个 sidecar 正在跑」的会话现场
    const id = 'crash-seed'
    seedRunningSession(root, id)
    const eventsPath = join(sessionsDir(root), id, 'events.jsonl')
    const before = treeSnapshot(sessionsDir(root))
    const beforeEvents = before[join(id, 'events.jsonl')]
    assert.ok(beforeEvents, `前置条件：预置的 events.jsonl 必须可观测：${JSON.stringify(before)}`)

    // 起 B：没有锁的进程必须完全不碰会话库，尤其不得把 running 标成 aborted
    b = spawnServe(root, await freePort(), 'b')
    await waitForHealth(b, (h) => h.readiness === 'failed' || h.readiness === 'ready', 'B 未给出终态 readiness')
    await sleep(SETTLE_MS)

    const after = treeSnapshot(sessionsDir(root))
    assert.deepEqual(
      after[join(id, 'events.jsonl')],
      beforeEvents,
      'B 改写了现场会话的 events.jsonl（size/mtime/sha256 任一变化）——这正是『假续跑』的直接形态：\n' +
      `${treeDiff(before, after)}\n${b.log()}`,
    )
    assert.deepEqual(
      after[join(id, 'index.json')],
      before[join(id, 'index.json')],
      `B 改写了现场会话的 index.json（status 应仍是 running）：\n${treeDiff(before, after)}`,
    )

    // 机制级复核：崩溃恢复标记 = seq 高出 CRASH_RECOVERY_SEQ_GAP(100_000) 的 status 事件。
    // 字节全等已覆盖此断言，这里用可读形态再钉一次，失败时直接指出假标记行。
    const lines = readFileSync(eventsPath, 'utf8').trimEnd().split('\n')
    assert.equal(lines.length, 2, `events.jsonl 必须仍是预置的 2 行：\n${readFileSync(eventsPath, 'utf8')}`)
    for (const line of lines) {
      const seq = (JSON.parse(line) as { seq?: number }).seq
      assert.ok(
        typeof seq === 'number' && seq <= 2,
        `出现崩溃恢复/续跑标记（seq 应为 ≤2）：${line}`,
      )
    }
    // TODO(主控)：接线落地后补「B 的 sessionCount 也应为 0」——被锁挡住的进程不得
    // 把别人的会话读进自己的列表（当前只按字节清单验收，未约束其列表语义）。
  } finally {
    await reap(b)
    await reap(a)
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * ── RED / GREEN 实测（本 worktree，还原缺陷即红的自然对照）──────────────────
 *
 * 接线落地**前**（serve.ts 无任何 store-lock 引用；临时 home 起 A → 预置 running
 * 会话 → 起 B:47893）：
 *   A /health → readiness=ready
 *   B /health → {"readiness":"ready","registryOk":true,"sessionCount":1}   ← 无 initializationError
 *   sessions/crash-1/events.jsonl md5   bf5602de… → 64ed165d…              ← B 追加了崩溃恢复标记
 *   desktop/sidecar.lock                不存在
 *   → 本文件 3/3 RED：
 *       用例 1 → readiness 期望 'failed' 实际 'ready'
 *       用例 2 → sidecar.lock 不存在（A 从未持锁）
 *       用例 3 → events.jsonl 字节被改写（B 执行了 rehydrate）
 *
 * 接线落地**后**（serve.ts 引入 StoreLock + initializationError='data-dir-locked'，
 * 见 serve.ts:90/716-738/1166）：
 *   A /health → readiness=ready；sidecar.lock pid=A
 *   B /health → {"readiness":"failed","registryOk":false,"sessionCount":0,
 *                "initializationError":"data-dir-locked",
 *                "storeLockHolder":{"pid":<A.pid>,"hostname":…}}
 *   sessions/crash-1/events.jsonl md5   bf5602de… → bf5602de…（不变，仍 2 行）
 *   SIGTERM A → exit 0，sidecar.lock 被清除；起 C → readiness=ready，lock pid=C
 *   → 本文件 3/3 GREEN。
 */

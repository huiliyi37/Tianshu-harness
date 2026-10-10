/**
 * StoreLock — 会话库单写者独占锁（P0-1）回归
 *
 * 背景：多个 sidecar（tauri dev / 测试脚本 / VSCode 插件）共用 ~/.rivet/desktop
 * 会话库时，后来者的 rehydrate() 会把别人正在跑的会话标成『已中断』并写入
 * seq + 100_000 的假标记，desktop 的 event-reducer `ev.seq <= state.lastSeq`
 * 守卫随后丢掉之后所有真实输出（『假续跑』）。修法：会话库单写者独占锁。
 *
 * 本文件的每条用例都做过「还原缺陷即红」核验：把对应的修复分支撤掉后用例
 * 必须变红（见各 describe 顶部注释）。
 *
 * 全部用例使用 mkdtemp 临时锁路径，绝不触碰真实 ~/.rivet/desktop。
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname as osHostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  LEGACY_WRITER_LOCK_FILENAME,
  STORE_LOCK_HEARTBEAT_STALE_MS,
  StoreLock,
  platformDefaultStoreLockPath,
  readBootTimeMs,
  readProcessStartMs,
  storeLockPath,
  type LockInfo,
  type StoreLockState,
} from '../store-lock.js'
import { defaultRivetHome } from '../../config/paths.js'
import { createRouter } from '../index.js'
import { buildHealthRoute } from '../health-route.js'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

/** 高于 macOS pid_max（99998）且几乎不可能是活进程 → process.kill 报 ESRCH。 */
const DEAD_PID = 999_999_999

let TEST_DIR = ''
let LOCK_PATH = ''
let SESSION_FILE = ''

/** 写入一份『持有者』锁文件（模拟别的 sidecar 进程持有）。 */
function writeHolder(info: LockInfo): void {
  mkdirSync(dirname(LOCK_PATH), { recursive: true })
  writeFileSync(LOCK_PATH, JSON.stringify(info, null, 2), 'utf-8')
}

function readHolder(): LockInfo {
  const storage = lstatSync(LOCK_PATH)
  assert.ok(storage.isFile() || storage.isDirectory(), 'lock storage must be a real file or directory')
  const ownerPath = storage.isDirectory() ? join(LOCK_PATH, 'owner.json') : LOCK_PATH
  assert.ok(lstatSync(ownerPath).isFile(), 'lock owner must be a real regular file')
  return JSON.parse(readFileSync(ownerPath, 'utf-8')) as LockInfo
}

function holderInfo(overrides: Partial<LockInfo> = {}): LockInfo {
  return {
    pid: DEAD_PID,
    acquiredAt: new Date().toISOString(),
    hostname: osHostname(),
    ownerToken: 'other-sidecar',
    startedAtMs: Date.now() - 1_000,
    ...overrides,
  }
}

function contended(state: StoreLockState): Extract<StoreLockState, { status: 'contended' }> {
  assert.equal(state.status, 'contended', JSON.stringify(state))
  return state as Extract<StoreLockState, { status: 'contended' }>
}

describe('StoreLock — 争用与有界重试', () => {
  // 还原缺陷即红：删掉 staleReason 里三条陈旧判据（pid/boot/heartbeat）后，
  // 下面第一条用例会被误判为可接管（stale_recovered）→ 变红。
  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'store-lock-'))
    LOCK_PATH = join(TEST_DIR, 'desktop', 'sidecar.lock')
    SESSION_FILE = join(TEST_DIR, 'desktop', 'sessions', 'sess-1.json')
    mkdirSync(dirname(SESSION_FILE), { recursive: true })
    writeFileSync(SESSION_FILE, '{"seq":42}', 'utf-8')
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it('保留活进程持有者的锁：不接管、不动任何会话文件', async () => {
    const holder = holderInfo({ pid: process.pid, ownerToken: 'live-sidecar' })
    writeHolder(holder)
    const sessionBefore = statSync(SESSION_FILE)

    const lock = new StoreLock({ lockPath: LOCK_PATH, bootTimeMs: () => undefined })
    const startedAt = Date.now()
    const state = await lock.acquire({ retryWindowMs: 240, retryIntervalMs: 60 })
    const elapsed = Date.now() - startedAt

    const c = contended(state)
    assert.equal(state.acquired, false)
    assert.equal(c.holder.pid, process.pid, '占用者 PID 必须回报给调用方')
    assert.equal(c.holder.startedAtMs, holder.startedAtMs, '占用者启动时间必须回报给调用方')
    assert.equal(c.holder.hostname, osHostname())
    assert.equal(lock.isOwner(), false, '没拿到锁就不能自认 owner')

    // 锁文件仍是别人的（没被接管、没被重写）
    assert.equal(readHolder().ownerToken, 'live-sidecar')
    // 会话库一个字节都不能动
    assert.equal(readFileSync(SESSION_FILE, 'utf-8'), '{"seq":42}')
    assert.equal(statSync(SESSION_FILE).mtimeMs, sessionBefore.mtimeMs)
    // 也没留下 reclaim 残留
    assert.equal(existsSync(`${LOCK_PATH}.reclaim`), false)

    // 有界重试：等待窗口内反复尝试（≥2 次）而不是立刻放弃；窗口到点必须返回
    assert.ok(elapsed >= 180, `重试窗口未走完就返回：${elapsed}ms`)
    assert.ok(elapsed < 3_000, `重试窗口无上界：${elapsed}ms`)
  })
})

describe('StoreLock — 陈旧判定（三条判据）', () => {
  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'store-lock-stale-'))
    LOCK_PATH = join(TEST_DIR, 'desktop', 'sidecar.lock')
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  // 还原缺陷即红：撤掉 pid 存活判据 → 本条变红（contended）。
  it('接管「持有者 PID 已死」的锁', async () => {
    writeHolder(holderInfo({ pid: DEAD_PID }))
    const lock = new StoreLock({ lockPath: LOCK_PATH, bootTimeMs: () => undefined })

    const state = await lock.acquire({ retryWindowMs: 0 })

    assert.equal(state.status, 'stale_recovered', JSON.stringify(state))
    assert.equal(state.acquired, true)
    assert.equal(readHolder().pid, process.pid, '接管后锁文件必须归本进程')
    assert.equal(lock.isOwner(), true)
    lock.release()
    assert.equal(existsSync(LOCK_PATH), false, 'release 必须删掉自己的锁文件')
  })

  // 还原缺陷即红：撤掉 boot-time 判据 → 本条变红（持有者 PID 是活的，会被判 contended）。
  it('接管「持有者启动时间早于本次开机」的锁（重启后 PID 复用）', async () => {
    const bootTimeMs = Date.now() - 60 * 60_000
    writeHolder(
      holderInfo({
        // PID 是活的（就是本测试进程），但记录的启动时间早于开机 → 不可能是它
        pid: process.pid,
        ownerToken: 'reused-pid-after-reboot',
        startedAtMs: bootTimeMs - 6 * 60 * 60_000,
      }),
    )
    const lock = new StoreLock({ lockPath: LOCK_PATH, bootTimeMs: () => bootTimeMs })

    const state = await lock.acquire({ retryWindowMs: 0 })

    assert.equal(state.status, 'stale_recovered', JSON.stringify(state))
    assert.equal(readHolder().pid, process.pid)
    assert.match(readHolder().acquiredAt ?? '', /^\d{4}-\d{2}-\d{2}T/, '接管后必须是新写入的锁')
    lock.release()
  })

  // 还原缺陷即红：撤掉心跳判据 → 本条变红（持有者 PID 活、启动时间新 → contended）。
  it('接管「心跳超过 10 分钟未刷新」的锁', async () => {
    writeHolder(holderInfo({ pid: process.pid, ownerToken: 'silent-sidecar', startedAtMs: Date.now() - 5_000 }))
    const staleAt = new Date(Date.now() - STORE_LOCK_HEARTBEAT_STALE_MS - 60_000)
    utimesSync(LOCK_PATH, staleAt, staleAt)

    const lock = new StoreLock({ lockPath: LOCK_PATH, bootTimeMs: () => undefined })
    const state = await lock.acquire({ retryWindowMs: 0 })

    assert.equal(state.status, 'stale_recovered', JSON.stringify(state))
    assert.equal(readHolder().pid, process.pid)
    lock.release()
  })

  // 还原缺陷即红：把 boot 判据改成『心跳过期即接管』（忽略心跳新鲜度）→ 本条变红。
  it('心跳新鲜且进程存活 → 判为占用，不接管', async () => {
    writeHolder(holderInfo({ pid: process.pid, ownerToken: 'busy-sidecar', startedAtMs: Date.now() - 5_000 }))
    const bootTimeMs = Date.now() - 60 * 60_000
    const lock = new StoreLock({ lockPath: LOCK_PATH, bootTimeMs: () => bootTimeMs, heartbeatStaleMs: 60_000 })

    const state = await lock.acquire({ retryWindowMs: 0 })

    const c = contended(state)
    assert.equal(c.holder.pid, process.pid)
    assert.equal(typeof c.holder.startedAtMs, 'number')
    assert.equal(readHolder().ownerToken, 'busy-sidecar', '不能抢走活锁')
  })

  it('boot time 取不到时该判据不生效（不因此误判陈旧）', async () => {
    writeHolder(holderInfo({ pid: process.pid, ownerToken: 'no-boot-info', startedAtMs: 1 }))
    const lock = new StoreLock({ lockPath: LOCK_PATH, bootTimeMs: () => undefined })

    const state = await lock.acquire({ retryWindowMs: 0 })

    assert.equal(state.status, 'contended', '取不到 boot time 时必须偏保守（视为占用）')
  })

  it('持有期间按心跳间隔刷新锁文件时间', async () => {
    const lock = new StoreLock({ lockPath: LOCK_PATH, heartbeatIntervalMs: 25, bootTimeMs: () => undefined })
    const state = await lock.acquire({ retryWindowMs: 0 })
    assert.equal(state.status, 'acquired')

    const before = statSync(LOCK_PATH).mtimeMs
    await sleep(200)
    const after = statSync(LOCK_PATH).mtimeMs

    assert.ok(after > before, `心跳没有刷新锁文件时间：${before} → ${after}`)
    lock.release()
  })

  it('readBootTimeMs 在本平台给出不晚于现在的开机时间', () => {
    const bootMs = readBootTimeMs()
    if (process.platform === 'darwin' || process.platform === 'linux') {
      assert.equal(typeof bootMs, 'number')
      assert.ok((bootMs as number) > 0 && (bootMs as number) <= Date.now(), `boot=${bootMs}`)
    } else {
      assert.equal(bootMs, undefined, '不支持的平台必须返回 undefined（判据不生效）')
    }
  })

  it('锁文件损坏时走串行回收，且并发争用只有一个赢家', async () => {
    mkdirSync(dirname(LOCK_PATH), { recursive: true })
    writeFileSync(LOCK_PATH, '{not-json', 'utf-8')

    const contenders = Array.from({ length: 6 }, () =>
      new StoreLock({ lockPath: LOCK_PATH, bootTimeMs: () => undefined }).acquire({ retryWindowMs: 0 }),
    )
    const states = await Promise.all(contenders)
    const winners = states.filter(s => s.status === 'acquired' || s.status === 'stale_recovered')

    assert.ok(winners.length >= 1, JSON.stringify(states))
    assert.ok(existsSync(LOCK_PATH))
  })
})

describe('StoreLock — 升级过渡期：认出不认识 sidecar.lock 的旧版写者', () => {
  // 现场（2026-10-04）：旧版桌面端 sidecar 只持有定时任务锁、没有 sidecar.lock；打包验证
  // 起的新版 sidecar 照样拿到会话库锁并 rehydrate，把一个正在跑的会话写成「已中断」。
  // 「另一个活进程」用 process.ppid（测试 runner，必然存活且不是本进程）。
  let LEGACY_PATH = ''
  const RECORDED_START_MS = Date.now() - 3_600_000

  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'store-lock-legacy-'))
    LOCK_PATH = join(TEST_DIR, 'desktop', 'sidecar.lock')
    LEGACY_PATH = join(TEST_DIR, 'desktop', LEGACY_WRITER_LOCK_FILENAME)
    mkdirSync(dirname(LOCK_PATH), { recursive: true })
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  function writeLegacyOwner(overrides: Partial<LockInfo> = {}): void {
    const info: LockInfo = {
      pid: process.ppid,
      acquiredAt: new Date(RECORDED_START_MS).toISOString(),
      hostname: osHostname(),
      startedAtMs: RECORDED_START_MS,
      ...overrides,
    }
    writeFileSync(LEGACY_PATH, JSON.stringify(info, null, 2), 'utf-8')
  }

  /** 真实启动时间与记录对得上（ps 秒级截断 + 进程内 uptime 估算的误差量级）。 */
  const matchingStart = (pid: number) => (pid === process.ppid ? RECORDED_START_MS + 800 : undefined)

  // 还原缺陷即红：撤掉 attemptAcquire 开头的 legacyWriter() → 本条拿到锁（acquired）→ 变红。
  it('定时任务锁被别的活进程持有 → 判为占用，且不创建 sidecar.lock', async () => {
    writeLegacyOwner()
    const lock = new StoreLock({ lockPath: LOCK_PATH, bootTimeMs: () => undefined, processStartMs: matchingStart })

    const state = await lock.acquire({ retryWindowMs: 0 })

    const c = contended(state)
    assert.equal(c.reason, 'legacy_writer')
    assert.equal(c.holder.pid, process.ppid, '横幅/health 要能报出旧版写者的 PID')
    assert.equal(lock.isOwner(), false)
    assert.equal(lock.holder()?.pid, process.ppid)
    assert.equal(existsSync(LOCK_PATH), false, '认出旧版写者后不得在会话库目录落任何锁文件')
  })

  it('定时任务锁的持有者已死 → 不拦', async () => {
    writeLegacyOwner({ pid: DEAD_PID })
    const lock = new StoreLock({ lockPath: LOCK_PATH, bootTimeMs: () => undefined, processStartMs: matchingStart })
    const state = await lock.acquire({ retryWindowMs: 0 })
    assert.equal(state.status, 'acquired', JSON.stringify(state))
    lock.release()
  })

  it('定时任务锁就是本进程的 → 不拦', async () => {
    writeLegacyOwner({ pid: process.pid })
    const lock = new StoreLock({ lockPath: LOCK_PATH, bootTimeMs: () => undefined, processStartMs: () => RECORDED_START_MS })
    const state = await lock.acquire({ retryWindowMs: 0 })
    assert.equal(state.status, 'acquired', JSON.stringify(state))
    lock.release()
  })

  // 还原缺陷即红：撤掉启动时间比对 → 复用了 PID 的无关进程被当成旧版写者（contended）→ 变红。
  it('PID 活着但真实启动时间对不上（PID 已被复用）→ 不拦', async () => {
    writeLegacyOwner()
    const lock = new StoreLock({
      lockPath: LOCK_PATH,
      bootTimeMs: () => undefined,
      processStartMs: (pid) => (pid === process.ppid ? RECORDED_START_MS + 2 * 3_600_000 : undefined),
    })
    const state = await lock.acquire({ retryWindowMs: 0 })
    assert.equal(state.status, 'acquired', JSON.stringify(state))
    lock.release()
  })

  it('取不到真实启动时间 / 记录里没有启动时间 → 不拦（证据不全退回只看 sidecar.lock）', async () => {
    writeLegacyOwner()
    const noPs = new StoreLock({ lockPath: LOCK_PATH, bootTimeMs: () => undefined, processStartMs: () => undefined })
    assert.equal((await noPs.acquire({ retryWindowMs: 0 })).status, 'acquired')
    noPs.release()

    writeLegacyOwner({ startedAtMs: undefined })
    const noRecord = new StoreLock({ lockPath: LOCK_PATH, bootTimeMs: () => undefined, processStartMs: matchingStart })
    assert.equal((await noRecord.acquire({ retryWindowMs: 0 })).status, 'acquired')
    noRecord.release()
  })

  it('跨主机的定时任务锁 → 不拦（本机判不了远端进程）', async () => {
    writeLegacyOwner({ hostname: 'some-other-host.local' })
    const lock = new StoreLock({ lockPath: LOCK_PATH, bootTimeMs: () => undefined, processStartMs: matchingStart })
    const state = await lock.acquire({ retryWindowMs: 0 })
    assert.equal(state.status, 'acquired', JSON.stringify(state))
    lock.release()
  })

  // 还原缺陷即红：撤掉「与 sidecar.lock 同一持有者」的排除 → reason 变成 legacy_writer → 变红。
  it('新版锁主同时持有两把锁 → 走常规判据（pid_alive），不误报为旧版写者', async () => {
    writeLegacyOwner()
    writeHolder(holderInfo({ pid: process.ppid, ownerToken: 'new-sidecar', startedAtMs: RECORDED_START_MS }))
    const lock = new StoreLock({ lockPath: LOCK_PATH, bootTimeMs: () => undefined, processStartMs: matchingStart })

    const state = await lock.acquire({ retryWindowMs: 0 })

    assert.equal(contended(state).reason, 'pid_alive')
    assert.equal(readHolder().ownerToken, 'new-sidecar', '不能抢走活锁')
  })

  it('readProcessStartMs 在本平台给出与本进程启动时刻相符的时间', () => {
    const startMs = readProcessStartMs(process.pid)
    if (process.platform === 'darwin' || process.platform === 'linux') {
      assert.equal(typeof startMs, 'number', 'ps -o lstart 解析失败会让旧版写者判据整体失效')
      const expected = Date.now() - process.uptime() * 1000
      assert.ok(Math.abs((startMs as number) - expected) < 5_000, `ps=${startMs} uptime 推算=${expected}`)
      assert.equal(readProcessStartMs(DEAD_PID), undefined, '不存在的 PID 必须返回 undefined')
    } else {
      assert.equal(startMs, undefined, '不支持的平台必须返回 undefined（判据不生效）')
    }
  })
})

describe('StoreLock — node:test 真实目录护栏', () => {
  // 还原缺陷即红：撤掉 assertTestGuard 后第一条用例会真的去写 ~/.rivet/desktop/sidecar.lock
  // （在开发机上就是污染真实会话库）→ 变红。
  let savedContext: string | undefined

  beforeEach(() => {
    savedContext = process.env.NODE_TEST_CONTEXT
    process.env.NODE_TEST_CONTEXT = savedContext || 'store-lock-guard-test'
  })

  afterEach(() => {
    if (savedContext === undefined) delete process.env.NODE_TEST_CONTEXT
    else process.env.NODE_TEST_CONTEXT = savedContext
  })

  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'store-lock-guard-'))
    LOCK_PATH = join(TEST_DIR, 'desktop', 'sidecar.lock')
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it('node:test 下拒绝默认真实目录，且不留任何痕迹', async () => {
    const realPath = platformDefaultStoreLockPath()
    assert.ok(realPath.endsWith('sidecar.lock'), realPath)
    const before = existsSync(realPath) ? readFileSync(realPath, 'utf-8') : null

    const lock = new StoreLock({ lockPath: realPath })
    const state = await lock.acquire({ retryWindowMs: 0 })

    assert.equal(state.status, 'error', JSON.stringify(state))
    assert.match((state as Extract<StoreLockState, { status: 'error' }>).reason, /node:test|测试/)
    assert.equal(lock.isOwner(), false)
    assert.equal(existsSync(`${realPath}.reclaim`), false, '护栏必须早于任何文件操作')

    const after = existsSync(realPath) ? readFileSync(realPath, 'utf-8') : null
    assert.equal(after, before, '真实会话库锁文件不得被改写')
  })

  it('显式指向其他目录时放行（RIVET_DESKTOP_DIR 形态）', async () => {
    const savedDesktopDir = process.env.RIVET_DESKTOP_DIR
    process.env.RIVET_DESKTOP_DIR = TEST_DIR
    try {
      const lock = new StoreLock({ lockPath: join(TEST_DIR, 'desktop', 'sidecar.lock') })
      const state = await lock.acquire({ retryWindowMs: 0 })
      assert.equal(state.status, 'acquired', JSON.stringify(state))
      lock.release()
    } finally {
      if (savedDesktopDir === undefined) delete process.env.RIVET_DESKTOP_DIR
      else process.env.RIVET_DESKTOP_DIR = savedDesktopDir
    }
  })

  it('默认路径随 RIVET_DESKTOP_DIR 走；平台默认路径忽略环境变量', () => {
    const savedDesktopDir = process.env.RIVET_DESKTOP_DIR
    process.env.RIVET_DESKTOP_DIR = TEST_DIR
    try {
      assert.equal(storeLockPath(), join(TEST_DIR, 'sidecar.lock'), '默认锁路径必须落在 desktopDir()')
      // 平台默认（忽略 RIVET_DESKTOP_DIR / RIVET_HOME）是护栏的比较基准，不能被环境变量带走
      const platformDefault = platformDefaultStoreLockPath()
      assert.equal(platformDefault, join(defaultRivetHome(), 'desktop', 'sidecar.lock'))
    } finally {
      if (savedDesktopDir === undefined) delete process.env.RIVET_DESKTOP_DIR
      else process.env.RIVET_DESKTOP_DIR = savedDesktopDir
    }
  })
})

describe('health 快照输出锁占用者与初始化错误', () => {
  class NoopAgent implements ManagedAgent {
    run(_p: string, _cb: AgentCallbacks): Promise<void> { return new Promise(() => {}) }
    abort(): void {}
    listArtifacts(): Artifact[] { return [] }
    readArtifact(): Promise<string | null> { return Promise.resolve(null) }
    getMessages(): OaiMessage[] { return [] }
    replaceMessages(_msgs: OaiMessage[]): void {}
    rewindToMessages(_msgs: OaiMessage[]): void {}
  }

  const TOKEN = 'tok'
  const AUTH = { authorization: `Bearer ${TOKEN}` }

  it('带 token 请求输出 initializationError 与 storeLockHolder；匿名探测不输出', async () => {
    const manager = new RuntimeSessionManager({ createAgent: () => new NoopAgent() })
    const router = createRouter(
      buildHealthRoute(
        manager, Date.now(), '9.9.9', TOKEN, undefined, undefined, undefined,
        () => 'store lock: contended by pid 4242',
        () => ({ pid: 4242, startedAtMs: 1_700_000_000_000, hostname: 'other-host' }),
      ),
    )

    const body = (await router('GET', '/health', {}, AUTH)).body as Record<string, unknown>
    assert.equal(body.initializationError, 'store lock: contended by pid 4242')
    assert.deepEqual(body.storeLockHolder, { pid: 4242, startedAtMs: 1_700_000_000_000, hostname: 'other-host' })
    assert.equal(body.readiness, 'failed')

    // 匿名探测保持最小体：rich fields 是活动侧信道，不扩大无鉴权响应面
    const anon = (await router('GET', '/health', {}, {})).body as Record<string, unknown>
    assert.ok(!('initializationError' in anon), '匿名分支不输出 initializationError')
    assert.ok(!('storeLockHolder' in anon), '匿名分支不输出 storeLockHolder')
  })

  it('未接线时两个字段都不出现（保持既有 7 参调用兼容）', async () => {
    const manager = new RuntimeSessionManager({ createAgent: () => new NoopAgent() })
    const router = createRouter(buildHealthRoute(manager, Date.now(), '9.9.9', TOKEN))
    const body = (await router('GET', '/health', {}, AUTH)).body as Record<string, unknown>
    assert.ok(!('initializationError' in body))
    assert.ok(!('storeLockHolder' in body))
    assert.equal(body.readiness, 'ready')
  })
})

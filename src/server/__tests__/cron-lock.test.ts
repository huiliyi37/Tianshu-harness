/**
 * CronLock P0 regressions
 *
 * 覆盖 server 锁链路两条最高风险回归：
 * - 陈旧锁回收必须保持单 owner（避免 split-brain）
 * - 锁丢失必须通知 wiring 停止 scheduler（避免 zombie scheduler）
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname as osHostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { CronLock, isPidAlive, isProcStatZombie, type LockInfo, type LockState } from '../cron-lock.js'
import { CronScheduler } from '../cron-scheduler.js'
import { CronWiring } from '../cron-wiring.js'
import { TaskRegistry } from '../task-registry.js'
import { JsonTaskStore } from '../task-store.js'

// Hermetic: a unique temp dir per test avoids cross-run/concurrent-session
// collisions on a shared fixed path (.test-tmp/cron-lock-p0).
let TEST_DIR = ''
let TEST_LOCK_PATH = ''
let TEST_RELEASE_PATH = ''
let TEST_SCHEDULE_PATH = ''
let TEST_TASKS_DIR = ''

const CONTENDER_SCRIPT = `
import { existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { CronLock } from './src/server/cron-lock.ts'

const lockPath = process.env.LOCK_PATH
const releasePath = process.env.RELEASE_PATH
if (!lockPath || !releasePath) throw new Error('LOCK_PATH/RELEASE_PATH missing')

const lock = new CronLock({ lockPath, healthCheckIntervalMs: 1_000_000 })
const state = lock.acquire()
console.log(JSON.stringify({ status: state.status, pid: process.pid }))

if (state.status === 'acquired' || state.status === 'stale_recovered') {
  while (!existsSync(releasePath)) {
    await sleep(10)
  }
  lock.release()
}
`

interface ChildStatus {
  status: LockState['status']
  pid: number
}

interface ChildExit {
  code: number | null
  signal: NodeJS.Signals | null
  stderr: string
}

interface ContenderRun {
  child: ChildProcessWithoutNullStreams
  status: Promise<ChildStatus>
  close: Promise<ChildExit>
}

describe('CronLock P0 regressions', () => {
  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'cron-lock-p0-'))
    TEST_LOCK_PATH = `${TEST_DIR}/scheduled_tasks.lock`
    TEST_RELEASE_PATH = `${TEST_DIR}/release-contenders`
    TEST_SCHEDULE_PATH = `${TEST_DIR}/scheduled_tasks.json`
    TEST_TASKS_DIR = `${TEST_DIR}/tasks`
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it('recovers a stale lock with only one winner under concurrent contenders', async () => {
    writeOwner(TEST_LOCK_PATH, {
      pid: 999_999_999,
      acquiredAt: new Date().toISOString(),
      hostname: osHostname(),
    })

    const contenders = Array.from({ length: 8 }, () => startContender(TEST_LOCK_PATH, TEST_RELEASE_PATH))
    let statuses: ChildStatus[] = []
    let statusError: unknown

    try {
      statuses = await withTimeout(
        Promise.all(contenders.map(contender => contender.status)),
        8_000,
        'contenders did not all report lock state',
      )
    } catch (error) {
      statusError = error
    } finally {
      writeFileSync(TEST_RELEASE_PATH, 'release', 'utf-8')
    }

    const exits = await withTimeout(
      Promise.all(contenders.map(contender => contender.close)),
      4_000,
      'contenders did not exit after release',
    )
    for (const contender of contenders) {
      contender.child.kill()
    }

    if (statusError) throw statusError
    for (const exit of exits) {
      assert.equal(exit.code, 0, exit.stderr)
    }

    const ownerStatuses = statuses.filter(
      status => status.status === 'acquired' || status.status === 'stale_recovered',
    )
    assert.equal(ownerStatuses.length, 1, JSON.stringify(statuses))
    assert.ok(statuses.some(status => status.status === 'contended'), JSON.stringify(statuses))
  })

  it('recovers a corrupted lock with only one winner under concurrent contenders', async () => {
    writeFileSync(TEST_LOCK_PATH, '{not-json', 'utf-8')

    const contenders = Array.from({ length: 8 }, () => startContender(TEST_LOCK_PATH, TEST_RELEASE_PATH))
    let statuses: ChildStatus[] = []
    let statusError: unknown

    try {
      statuses = await withTimeout(
        Promise.all(contenders.map(contender => contender.status)),
        8_000,
        'contenders did not all report lock state',
      )
    } catch (error) {
      statusError = error
    } finally {
      writeFileSync(TEST_RELEASE_PATH, 'release', 'utf-8')
    }

    const exits = await withTimeout(
      Promise.all(contenders.map(contender => contender.close)),
      4_000,
      'contenders did not exit after release',
    )
    for (const contender of contenders) {
      contender.child.kill()
    }

    if (statusError) throw statusError
    for (const exit of exits) {
      assert.equal(exit.code, 0, exit.stderr)
    }

    const ownerStatuses = statuses.filter(
      status => status.status === 'acquired' || status.status === 'stale_recovered',
    )
    assert.equal(ownerStatuses.length, 1, JSON.stringify(statuses))
    assert.ok(statuses.some(status => status.status === 'contended'), JSON.stringify(statuses))
  })

  it('does not recover a dead-looking owner from a different hostname', () => {
    writeOwner(TEST_LOCK_PATH, {
      pid: 999_999_999,
      acquiredAt: new Date().toISOString(),
      hostname: `${osHostname()}-remote`,
    })

    const lock = new CronLock({ lockPath: TEST_LOCK_PATH, healthCheckIntervalMs: 99999 })
    const state = lock.acquire()

    assert.equal(state.status, 'contended')
    assert.equal((state as Extract<LockState, { status: 'contended' }>).owner.hostname, `${osHostname()}-remote`)
    lock.release()
  })

  it('does not treat same-pid lock without matching owner token as own lock', () => {
    writeOwner(TEST_LOCK_PATH, {
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      hostname: osHostname(),
      ownerToken: 'previous-process-token',
      startedAtMs: 1,
    })

    const lock = new CronLock({ lockPath: TEST_LOCK_PATH, healthCheckIntervalMs: 99999 })
    const state = lock.acquire()

    assert.equal(state.status, 'contended')
    assert.equal((state as Extract<LockState, { status: 'contended' }>).owner.ownerToken, 'previous-process-token')
    lock.release()
  })

  it('notifies onLockLost when the lock file is no longer owned by this process', async () => {
    const lock = new CronLock({ lockPath: TEST_LOCK_PATH, healthCheckIntervalMs: 10 })
    const acquired = lock.acquire()
    assert.equal(acquired.status, 'acquired')

    const lost = new Promise<LockState>(resolve => {
      lock.onLockLost(resolve)
    })

    writeOwner(TEST_LOCK_PATH, {
      pid: 1,
      acquiredAt: new Date().toISOString(),
      hostname: 'other-owner',
    })

    const state = await withTimeout(lost, 500, 'lock-loss callback was not fired')
    assert.equal(state.status, 'contended')
    assert.equal((state as Extract<LockState, { status: 'contended' }>).owner.pid, 1)
    assert.equal(lock.isOwner(), false)
  })

  it('stops CronWiring scheduler when CronLock reports lock loss', async () => {
    const scheduler = new CronScheduler({
      schedulePath: TEST_SCHEDULE_PATH,
      tickIntervalMs: 1_000,
    })
    const registry = new TaskRegistry({ taskStore: new JsonTaskStore(TEST_TASKS_DIR) })
    const lock = new CronLock({ lockPath: TEST_LOCK_PATH, healthCheckIntervalMs: 10 })
    const wiring = new CronWiring({ scheduler, registry, lock })

    const status = await wiring.start()
    assert.equal(status.schedulerRunning, true)
    assert.equal(status.lockOwner, true)

    writeOwner(TEST_LOCK_PATH, {
      pid: 1,
      acquiredAt: new Date().toISOString(),
      hostname: 'other-owner',
    })

    await waitFor(() => !scheduler.isRunning(), 500, 'scheduler kept running after lock loss')
    assert.equal(scheduler.isRunning(), false)

    await wiring.stop()
  })
})

function writeOwner(path: string, info: LockInfo): void {
  mkdirSync(dirname(path), { recursive: true })
  const ownerPath = existsSync(path) && lstatSync(path).isDirectory() ? join(path, 'owner.json') : path
  writeFileSync(ownerPath, JSON.stringify(info, null, 2), 'utf-8')
}

function startContender(lockPath: string, releasePath: string): ContenderRun {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', CONTENDER_SCRIPT],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LOCK_PATH: lockPath,
        RELEASE_PATH: releasePath,
      },
    },
  )

  let stdout = ''
  let stderr = ''
  const status = new Promise<ChildStatus>((resolve, reject) => {
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
      const line = stdout.split('\n').find(part => part.trim().length > 0)
      if (!line) return
      try {
        resolve(JSON.parse(line) as ChildStatus)
      } catch (error) {
        reject(error)
      }
    })
    child.on('error', reject)
    child.on('close', code => {
      if (stdout.trim().length === 0) {
        reject(new Error(`contender exited before reporting state: code=${code} stderr=${stderr}`))
      }
    })
  })

  child.stderr.on('data', chunk => {
    stderr += String(chunk)
  })

  const close = new Promise<ChildExit>(resolve => {
    child.on('close', (code, signal) => {
      resolve({ code, signal, stderr })
    })
  })

  return { child, status, close }
}

async function waitFor(predicate: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(10)
  }
  assert.fail(message)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

describe('isPidAlive — liveness without blocking subprocess (S-6)', () => {
  it('reports the current process as alive', () => {
    assert.equal(isPidAlive(process.pid), true)
  })

  it('rejects invalid pids without throwing', () => {
    assert.equal(isPidAlive(0), false)
    assert.equal(isPidAlive(-1), false)
    assert.equal(isPidAlive(1.5), false)
    assert.equal(isPidAlive(Number.NaN), false)
  })

  it('reports an unused high pid as dead', () => {
    // 2^22 is above the default Linux pid_max and is extremely unlikely to be
    // a live process; process.kill(pid, 0) → ESRCH → dead.
    assert.equal(isPidAlive(4_194_303), false)
  })
})

describe('isProcStatZombie — /proc state parsing (S-6 zombie exclusion)', () => {
  it('detects a zombie (state Z)', () => {
    assert.equal(isProcStatZombie('1234 (node) Z 1 1234 1234 0 -1 4194560'), true)
  })

  it('treats running/sleeping states as not-zombie', () => {
    assert.equal(isProcStatZombie('1234 (node) R 1 1234 1234'), false)
    assert.equal(isProcStatZombie('1234 (node) S 1 1234 1234'), false)
  })

  it('parses correctly when comm contains spaces and parentheses', () => {
    // The kernel does not escape ) inside comm — split on the LAST ) so the
    // state field is read correctly even for adversarial process names.
    assert.equal(isProcStatZombie('1234 (weird )( name) Z 1 1234'), true)
    assert.equal(isProcStatZombie('1234 (weird )( name) R 1 1234'), false)
  })
})

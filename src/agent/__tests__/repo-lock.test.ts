import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, hostname } from 'node:os'
import { RepoLock, isPidAlive, worktreeRegistryLockPath } from '../repo-lock.js'

const tempDirs: string[] = []

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'repolock-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

describe('RepoLock', () => {
  it('acquires on filesystems without hard-link support', () => {
    const lockPath = join(makeDir(), 'portable.lock')
    const lock = new RepoLock({ lockPath, maxWaitMs: 100, retryMs: 5 })
    lock.acquire()
    assert.equal(lock.isHeld(), true)
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, process.pid)
    lock.release()
    assert.equal(existsSync(lockPath), false)
  })

  it('does not reclaim an owner record still being published', () => {
    const lockPath = join(makeDir(), 'publishing.lock')
    writeFileSync(lockPath, '')
    const lock = new RepoLock({ lockPath, staleMs: 10_000, maxWaitMs: 30, retryMs: 5 })
    assert.throws(() => lock.acquire(), /timeout/)
    assert.equal(readFileSync(lockPath, 'utf8'), '')
    assert.equal(lock.isHeld(), false)
  })

  it('acquires and releases, leaving no lock file behind', () => {
    const lockPath = join(makeDir(), 'sub', 'r.lock')
    const lock = new RepoLock({ lockPath })
    lock.acquire()
    assert.ok(lock.isHeld())
    assert.ok(existsSync(lockPath))
    lock.release()
    assert.equal(lock.isHeld(), false)
    assert.equal(existsSync(lockPath), false)
  })

  it('withLock runs fn under the lock and releases even on throw', () => {
    const lockPath = join(makeDir(), 'r.lock')
    const lock = new RepoLock({ lockPath })
    assert.throws(() => lock.withLock(() => { throw new Error('boom') }), /boom/)
    assert.equal(existsSync(lockPath), false)
    assert.equal(lock.isHeld(), false)
  })

  it('withLockAsync holds the lock across awaits and releases on throw', async () => {
    const lockPath = join(makeDir(), 'r.lock')
    const lock = new RepoLock({ lockPath })
    let heldDuringAwait = false

    await lock.withLockAsync(async () => {
      assert.ok(existsSync(lockPath), 'lock file must exist while held')
      // Simulate async work — the lock must survive the await.
      await new Promise(resolve => setTimeout(resolve, 10))
      heldDuringAwait = existsSync(lockPath)
    })

    assert.ok(heldDuringAwait, 'lock must be held during await')
    assert.equal(existsSync(lockPath), false, 'lock released after completion')
    assert.equal(lock.isHeld(), false)

    // Throw path: lock released even when fn throws.
    await assert.rejects(
      () => lock.withLockAsync(async () => { throw new Error('async boom') }),
      /async boom/,
    )
    assert.equal(existsSync(lockPath), false, 'lock released after async throw')
    assert.equal(lock.isHeld(), false)
  })

  it('serializes: a second lock cannot acquire while the first holds it', () => {
    const lockPath = join(makeDir(), 'r.lock')
    const a = new RepoLock({ lockPath })
    const b = new RepoLock({ lockPath, maxWaitMs: 100, retryMs: 10 })
    a.acquire()
    assert.throws(() => b.acquire(), /timeout/)
    a.release()
    // Now b can acquire.
    b.acquire()
    assert.ok(b.isHeld())
    b.release()
  })

  it('reclaims a stale lock (age beyond staleMs) held by a foreign-looking owner', () => {
    const lockPath = join(makeDir(), 'r.lock')
    // Plant a stale lock owned by a clearly-not-us pid, with an old timestamp.
    const stale = {
      pid: 999_999,
      acquiredAt: new Date(Date.now() - 60_000).toISOString(),
      acquiredAtMs: Date.now() - 60_000,
      hostname: 'some-other-host',
      ownerToken: 'foreign-token',
    }
    writeFileSync(lockPath, JSON.stringify(stale))
    const lock = new RepoLock({ lockPath, staleMs: 30_000, maxWaitMs: 500 })
    lock.acquire()
    assert.ok(lock.isHeld())
    const owner = JSON.parse(readFileSync(lockPath, 'utf-8'))
    assert.equal(owner.pid, process.pid)
    lock.release()
  })

  it('reclaims a lock whose same-host PID is dead', () => {
    const lockPath = join(makeDir(), 'r.lock')
    const dead = {
      pid: 999_998,
      acquiredAt: new Date().toISOString(),
      acquiredAtMs: Date.now(),
      hostname: hostname() || 'unknown',
      ownerToken: 'dead-token',
    }
    writeFileSync(lockPath, JSON.stringify(dead))
    const lock = new RepoLock({ lockPath, maxWaitMs: 500 })
    lock.acquire()
    assert.ok(lock.isHeld())
    lock.release()
  })

  it('recovers from a corrupt lock file', () => {
    const lockPath = join(makeDir(), 'r.lock')
    writeFileSync(lockPath, '{ not json')
    const staleTime = new Date(Date.now() - 60_000)
    utimesSync(lockPath, staleTime, staleTime)
    const lock = new RepoLock({ lockPath, maxWaitMs: 500, retryMs: 10 })
    lock.acquire()
    assert.ok(lock.isHeld())
    lock.release()
  })
})

describe('isPidAlive', () => {
  it('returns true for the current process and false for an impossible pid', () => {
    assert.equal(isPidAlive(process.pid), true)
    assert.equal(isPidAlive(0), false)
    assert.equal(isPidAlive(-1), false)
    assert.equal(isPidAlive(999_999), false)
  })
})

describe('worktreeRegistryLockPath', () => {
  it('derives a stable path under .rivet', () => {
    assert.equal(worktreeRegistryLockPath('/repo'), '/repo/.rivet/worktree-registry.lock')
  })
})

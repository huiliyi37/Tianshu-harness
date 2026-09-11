import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionRegistry, _setBackendForTest, _resetBackendForTest } from '../session-registry.js'

describe('SessionRegistry', () => {
  let dbDir: string
  let registry: SessionRegistry

  beforeEach(async () => {
    dbDir = mkdtempSync(join(tmpdir(), 'sr-test-'))
    registry = await SessionRegistry.create(dbDir)
  })

  afterEach(() => {
    registry.close()
    rmSync(dbDir, { recursive: true, force: true })
  })

  describe('register', () => {
    it('registers a session with pid and cwd', () => {
      registry.register('sess-1', '/project')
      const sessions = registry.listActive()
      assert.equal(sessions.length, 1)
      assert.equal(sessions[0]!.id, 'sess-1')
      assert.equal(sessions[0]!.pid, process.pid)
      assert.equal(sessions[0]!.role, 'standalone')
    })

    it('registers with custom role', () => {
      registry.register('coordinator-1', '/project', 'coordinator')
      const sessions = registry.listActive()
      assert.equal(sessions[0]!.role, 'coordinator')
    })

    it('allows multiple sessions', () => {
      registry.register('sess-1', '/project')
      registry.register('sess-2', '/project')
      assert.equal(registry.listActive().length, 2)
    })

    it('upserts on duplicate session id', () => {
      registry.register('sess-1', '/project')
      registry.register('sess-1', '/other')
      const sessions = registry.listActive()
      assert.equal(sessions.length, 1)
      assert.equal(sessions[0]!.role, 'standalone')
    })
  })

  describe('heartbeat', () => {
    it('updates heartbeat timestamp', () => {
      registry.register('sess-1', '/project')
      const before = registry.listActive()[0]!.heartbeatAt
      registry.heartbeat('sess-1')
      const after = registry.listActive()[0]!.heartbeatAt
      assert.ok(after >= before)
    })
  })

  describe('unregister', () => {
    it('removes session from registry', () => {
      registry.register('sess-1', '/project')
      registry.unregister('sess-1')
      assert.equal(registry.listActive().length, 0)
    })

    it('is a no-op for unknown session', () => {
      registry.unregister('unknown')
      assert.equal(registry.listActive().length, 0)
    })
  })

  describe('detectCrashedSessions', () => {
    it('returns sessions whose pid is not running', () => {
      // PID 99999 is almost certainly not running
      registry.register('dead-sess', '/project')
      // Manually update to a dead PID
      registry.updatePid('dead-sess', 99999)
      const crashed = registry.detectCrashedSessions()
      assert.equal(crashed.length, 1)
      assert.equal(crashed[0]!.id, 'dead-sess')
    })

    it('does not return sessions whose pid is alive', () => {
      registry.register('alive-sess', '/project')
      const crashed = registry.detectCrashedSessions()
      assert.equal(crashed.length, 0)
    })

    it('reaps crashed sessions', () => {
      registry.register('dead-sess', '/project')
      registry.updatePid('dead-sess', 99999)
      const crashed = registry.detectCrashedSessions()
      assert.equal(crashed.length, 1)
      // After reaping, should be gone
      assert.equal(registry.listActive().length, 0)
    })
  })

  describe('createWithReap（收编公开仓 PR #110：sidecar 启动收割幽灵独占锁）', () => {
    it('reaps crashed sessions on create and releases their exclusive claims', async () => {
      // 播种：一个已死会话（pid 99999 几乎不可能存活）持有 src/index.ts 的独占 claim
      registry.register('sess-dead', '/project')
      registry.updatePid('sess-dead', 99999)
      assert.equal(registry.acquireClaim('sess-dead', 'src/index.ts', 'exclusive'), true)

      let reapedIds: string[] = []
      const fresh = await SessionRegistry.createWithReap(dbDir, (crashed) => { reapedIds = crashed.map((c) => c.id) })
      try {
        assert.deepEqual(reapedIds, ['sess-dead'])
        // 幽灵 claim 已清——新会话可认领同一文件（不收割时恒 false，R2 守卫永久拒写）
        assert.equal(fresh.acquireClaim('sess-new', 'src/index.ts', 'exclusive'), true)
        assert.equal(fresh.checkClaim('src/index.ts')?.sessionId, 'sess-new')
        assert.equal(fresh.listActive().some((s) => s.id === 'sess-dead'), false)
      } finally {
        fresh.close()
      }
    })

    it('keeps live sessions and their claims untouched', async () => {
      // register 记录当前进程 pid——测试进程活着，即活会话
      registry.register('sess-alive', '/project')
      assert.equal(registry.acquireClaim('sess-alive', 'a.ts', 'exclusive'), true)

      let reapedCalled = false
      const fresh = await SessionRegistry.createWithReap(dbDir, () => { reapedCalled = true })
      try {
        assert.equal(reapedCalled, false)
        assert.equal(fresh.acquireClaim('sess-other', 'a.ts', 'exclusive'), false)
        assert.equal(fresh.checkClaim('a.ts')?.sessionId, 'sess-alive')
        assert.equal(fresh.listActive().some((s) => s.id === 'sess-alive'), true)
      } finally {
        fresh.close()
      }
    })
  })

  describe('claim acquire / release / check', () => {
    it('acquires an exclusive claim', () => {
      registry.register('sess-1', '/project')
      const ok = registry.acquireClaim('sess-1', 'src/foo.ts', 'exclusive')
      assert.equal(ok, true)
    })

    it('rejects duplicate exclusive claim from different session', () => {
      registry.register('sess-1', '/project')
      registry.register('sess-2', '/project')
      assert.equal(registry.acquireClaim('sess-1', 'src/foo.ts', 'exclusive'), true)
      assert.equal(registry.acquireClaim('sess-2', 'src/foo.ts', 'exclusive'), false)
    })

    it('allows same session to re-acquire its own claim', () => {
      registry.register('sess-1', '/project')
      registry.acquireClaim('sess-1', 'src/foo.ts', 'exclusive')
      assert.equal(registry.acquireClaim('sess-1', 'src/foo.ts', 'exclusive'), true)
    })

    it('allows multiple shared_read claims on same file', () => {
      registry.register('sess-1', '/project')
      registry.register('sess-2', '/project')
      assert.equal(registry.acquireClaim('sess-1', 'src/foo.ts', 'shared_read'), true)
      assert.equal(registry.acquireClaim('sess-2', 'src/foo.ts', 'shared_read'), true)
    })

    it('rejects exclusive claim when shared_read exists', () => {
      registry.register('sess-1', '/project')
      registry.register('sess-2', '/project')
      registry.acquireClaim('sess-1', 'src/foo.ts', 'shared_read')
      assert.equal(registry.acquireClaim('sess-2', 'src/foo.ts', 'exclusive'), false)
    })

    it('releases a claim', () => {
      registry.register('sess-1', '/project')
      registry.acquireClaim('sess-1', 'src/foo.ts', 'exclusive')
      registry.releaseClaim('sess-1', 'src/foo.ts')
      // Now another session can acquire
      registry.register('sess-2', '/project')
      assert.equal(registry.acquireClaim('sess-2', 'src/foo.ts', 'exclusive'), true)
    })

    it('checkClaim returns claim info', () => {
      registry.register('sess-1', '/project')
      registry.acquireClaim('sess-1', 'src/foo.ts', 'exclusive')
      const claim = registry.checkClaim('src/foo.ts')
      assert.ok(claim)
      assert.equal(claim.sessionId, 'sess-1')
      assert.equal(claim.claimType, 'exclusive')
    })

    it('checkClaim returns null for unclaimed file', () => {
      assert.equal(registry.checkClaim('src/foo.ts'), null)
    })
  })

  describe('reapStaleClaims', () => {
    it('reclaims files held by dead sessions', () => {
      registry.register('dead-sess', '/project')
      registry.updatePid('dead-sess', 99999)
      registry.acquireClaim('dead-sess', 'src/foo.ts', 'exclusive')

      const reclaimed = registry.reapStaleClaims()
      assert.equal(reclaimed.length, 1)
      assert.equal(reclaimed[0]!, 'src/foo.ts')

      // Now it should be free
      registry.register('new-sess', '/project')
      assert.equal(registry.acquireClaim('new-sess', 'src/foo.ts', 'exclusive'), true)
    })

    it('does not reclaim files held by alive sessions', () => {
      registry.register('alive-sess', '/project')
      registry.acquireClaim('alive-sess', 'src/foo.ts', 'exclusive')

      const reclaimed = registry.reapStaleClaims()
      assert.equal(reclaimed.length, 0)
    })
  })

  describe('releaseAllClaims', () => {
    it('releases all claims for a session', () => {
      registry.register('sess-1', '/project')
      registry.acquireClaim('sess-1', 'src/a.ts', 'exclusive')
      registry.acquireClaim('sess-1', 'src/b.ts', 'exclusive')
      registry.releaseAllClaims('sess-1')
      assert.equal(registry.checkClaim('src/a.ts'), null)
      assert.equal(registry.checkClaim('src/b.ts'), null)
    })
  })

  describe('getActiveClaims', () => {
    it('returns claims from other sessions, excluding the given session', () => {
      registry.register('sess-1', '/project')
      registry.register('sess-2', '/project')
      registry.acquireClaim('sess-1', 'src/a.ts', 'exclusive')
      registry.acquireClaim('sess-2', 'src/b.ts', 'shared_read')

      const claims = registry.getActiveClaims('sess-1')
      // Should only include sess-2's claim, not sess-1's
      assert.equal(claims.length, 1)
      assert.equal(claims[0]!.sessionId, 'sess-2')
      assert.equal(claims[0]!.filePath, 'src/b.ts')
      assert.equal(claims[0]!.claimType, 'shared_read')
    })

    it('returns empty array when no other sessions have claims', () => {
      registry.register('sess-1', '/project')
      registry.acquireClaim('sess-1', 'src/a.ts', 'exclusive')

      const claims = registry.getActiveClaims('sess-1')
      assert.equal(claims.length, 0)
    })

    it('includes all claim types from other sessions', () => {
      registry.register('sess-1', '/project')
      registry.register('sess-2', '/project')
      registry.acquireClaim('sess-2', 'src/a.ts', 'exclusive')
      registry.acquireClaim('sess-2', 'src/b.ts', 'shared_read')

      const claims = registry.getActiveClaims('sess-1')
      assert.equal(claims.length, 2)
    })
  })
})

// D-2: better-sqlite3 拿不到时 nullDb 降级桩的契约。README 与源码注释承诺
// 「退化为内存库 / All method calls succeed silently」；曾经 run() 恒报
// changes:0 导致 acquireClaim 恒 false，R2 写前守卫把全部写入拦死并谎报
// 「正被另一个会话独占编辑（会话 undefined）」。降级语义 = 写入照常成功、
// 无跨会话保护，而不是写入全线瘫痪。
describe('SessionRegistry nullDb degrade path (better-sqlite3 unavailable)', () => {
  let degradedDir: string
  let degraded: SessionRegistry

  beforeEach(async () => {
    _setBackendForTest('null')
    degradedDir = mkdtempSync(join(tmpdir(), 'sr-null-test-'))
    degraded = await SessionRegistry.create(degradedDir)
  })

  afterEach(() => {
    degraded.close()
    rmSync(degradedDir, { recursive: true, force: true })
    _resetBackendForTest()
  })

  it('register succeeds on the degrade path', () => {
    assert.doesNotThrow(() => degraded.register('sess-null', '/project'))
  })

  it('first uncontended acquireClaim returns true (was false: R2 guard blocked all writes)', () => {
    degraded.register('sess-null', '/project')
    assert.equal(degraded.acquireClaim('sess-null', 'src/foo.ts', 'exclusive'), true)
  })

  it('checkClaim returns null so no phantom owner is reported', () => {
    degraded.acquireClaim('sess-null', 'src/foo.ts', 'exclusive')
    assert.equal(degraded.checkClaim('src/foo.ts'), null)
  })

  it('releaseAllClaims does not throw', () => {
    degraded.register('sess-null', '/project')
    degraded.acquireClaim('sess-null', 'src/foo.ts', 'exclusive')
    assert.doesNotThrow(() => degraded.releaseAllClaims('sess-null'))
  })
})

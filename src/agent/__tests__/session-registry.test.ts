import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { SessionRegistry, _setBackendForTest, _resetBackendForTest } from '../session-registry.js'

function exitedChildPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true, timeout: 10_000 })
  assert.equal(child.status, 0, child.error?.message)
  assert.ok(child.pid > 0)
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' })
  return child.pid
}

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
      registry.register('dead-sess', '/project')
      registry.updatePid('dead-sess', exitedChildPid())
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
      registry.updatePid('dead-sess', exitedChildPid())
      const crashed = registry.detectCrashedSessions()
      assert.equal(crashed.length, 1)
      // After reaping, should be gone
      assert.equal(registry.listActive().length, 0)
    })
  })

  describe('createWithReap（收编公开仓 PR #110：sidecar 启动收割幽灵独占锁）', () => {
    it('reaps crashed sessions on create and releases their exclusive claims', async () => {
      registry.register('sess-dead', '/project')
      registry.updatePid('sess-dead', exitedChildPid())
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
      registry.updatePid('dead-sess', exitedChildPid())
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

    it('retains a live child claim and releases it only after the child exits', { timeout: 10_000 }, async t => {
      const child = spawn(process.execPath, ['-e', 'process.on("message", () => process.exit(0)); process.send("ready")'], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
      })
      t.after(async () => {
        if (child.exitCode !== null || child.signalCode !== null) return
        const exited = once(child, 'exit')
        child.kill()
        await exited
      })
      await once(child, 'message')
      registry.register('child-sess', '/project')
      registry.updatePid('child-sess', child.pid!)
      registry.acquireClaim('child-sess', 'src/child.ts', 'exclusive')
      assert.deepEqual(registry.detectCrashedSessions(), [])
      assert.deepEqual(registry.reapStaleClaims(), [])
      assert.equal(registry.claimLiveness('src/child.ts')?.ownerAlive, true)
      assert.equal(registry.acquireClaim('other-sess', 'src/child.ts', 'exclusive'), false)

      const exited = once(child, 'exit')
      child.send('exit')
      await exited
      assert.deepEqual(registry.reapStaleClaims(), ['src/child.ts'])
      assert.equal(registry.listActive().some(s => s.id === 'child-sess'), false)
      assert.equal(registry.acquireClaim('other-sess', 'src/child.ts', 'exclusive'), true)
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

  // v2（认领即租约）：文件级租约凭据 —— claimLiveness 用 join 一次取齐判定
  // 所需字段（owner pid / 存活 / claim 类型 / 最后触碰时刻），补上 checkClaim
  // 只返回三列、判定函数拿不到 pid 与文件的接口缺口。
  describe('claimLiveness（v2 文件级租约凭据）', () => {
    it('returns null for an unclaimed file', () => {
      assert.equal(registry.claimLiveness('src/foo.ts'), null)
    })

    it('exposes owner pid, liveness and claim type after acquire', () => {
      registry.register('sess-1', '/project')
      registry.acquireClaim('sess-1', 'src/foo.ts', 'exclusive')
      const live = registry.claimLiveness('src/foo.ts')
      assert.ok(live, 'claimLiveness must return a row for a claimed file')
      assert.equal(live.ownerSessionId, 'sess-1')
      assert.equal(live.claimType, 'exclusive')
      assert.equal(live.ownerPid, process.pid)
      assert.equal(live.ownerAlive, true)
      assert.equal(typeof live.lastTouchedAt, 'string')
    })

    it('refreshes lastTouchedAt when the same session re-acquires (write-touch)', async () => {
      registry.register('sess-1', '/project')
      registry.acquireClaim('sess-1', 'src/foo.ts', 'exclusive')
      const first = registry.claimLiveness('src/foo.ts')!.lastTouchedAt
      await new Promise((r) => setTimeout(r, 5))
      registry.acquireClaim('sess-1', 'src/foo.ts', 'exclusive')
      const second = registry.claimLiveness('src/foo.ts')!.lastTouchedAt
      assert.ok(second > first, `同会话重复认领必须刷新 lastTouchedAt：${first} -> ${second}`)
    })

    it('reports ownerPid=null for a claim whose session row is gone (L0 陈旧行)', () => {
      // claims 行在、sessions 行无 —— 幽灵认领，判定应落 L0（回收而非"问"）
      registry.acquireClaim('ghost-sess', 'src/foo.ts', 'exclusive')
      const live = registry.claimLiveness('src/foo.ts')
      assert.ok(live)
      assert.equal(live.ownerSessionId, 'ghost-sess')
      assert.equal(live.ownerPid, null)
    })

    it('reports ownerAlive=false for a dead owner pid', () => {
      const deadPid = exitedChildPid()
      registry.register('dead-sess', '/project')
      registry.updatePid('dead-sess', deadPid)
      registry.acquireClaim('dead-sess', 'src/foo.ts', 'exclusive')
      const live = registry.claimLiveness('src/foo.ts')
      assert.ok(live)
      assert.equal(live.ownerPid, deadPid)
      assert.equal(live.ownerAlive, false)
    })
  })

  describe('v2 迁移：老库 claims 表无 last_touched_at 列', () => {
    it('backfills last_touched_at from acquired_at on open', async () => {
      const legacyDir = mkdtempSync(join(tmpdir(), 'sr-legacy-'))
      try {
        const { resolveBetterSqlite3 } = await import('../../repo/native-resolver.js')
        const Database = resolveBetterSqlite3(import.meta.url)
        if (!Database) return // 原生模块不可用（降级环境）→ 迁移路径不适用，跳过
        const raw = new Database(join(legacyDir, 'registry.db'))
        raw.exec(`
          CREATE TABLE sessions (id TEXT PRIMARY KEY, pid INTEGER NOT NULL, cwd TEXT NOT NULL, started_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, role TEXT NOT NULL, task_description TEXT);
          CREATE TABLE claims (session_id TEXT NOT NULL, file_path TEXT NOT NULL, claim_type TEXT NOT NULL, acquired_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
        `)
        raw.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?)')
          .run('old-sess', process.pid, '/project', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'standalone', null)
        raw.prepare('INSERT INTO claims (session_id, file_path, claim_type, acquired_at) VALUES (?,?,?,?)')
          .run('old-sess', 'src/legacy.ts', 'exclusive', '2026-01-01T00:00:00.000Z')
        raw.close()

        const legacy = await SessionRegistry.create(legacyDir)
        try {
          const live = legacy.claimLiveness('src/legacy.ts')
          assert.ok(live, '迁移补列后 claimLiveness 必须能读到老库的 claim')
          assert.equal(live.lastTouchedAt, '2026-01-01T00:00:00.000Z', '历史行应回填为 acquired_at（已知活动下界）')
          assert.equal(live.ownerPid, process.pid)
          assert.equal(live.ownerAlive, true)
        } finally {
          legacy.close()
        }
      } finally {
        rmSync(legacyDir, { recursive: true, force: true })
      }
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

/**
 * R1 companion — sidecar 启动收割崩溃会话的 claims。
 *
 * 回归背景：sidecar 被 kill -9/断电后，独占 claims 留在 desktopDir 的
 * registry.db 里，而 serve 启动路径从不调用 detectCrashedSessions（TUI 侧
 * bootstrap.ts 有收割、sidecar 没有＝守卫不对称）——死会话的幽灵 claim 永久
 * 阻断后续会话对同名文件的写入，且 owner 是死会话，用户无法自救。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionRegistry } from '../../agent/session-registry.js'
import { initServeSessionRegistry } from '../serve.js'

test('sidecar 启动收割：崩溃会话的独占 claim 不再锁死新会话写入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'serve-reap-'))
  try {
    // 播种：一个已死会话（不可能存活的 pid）持有 src/index.ts 的独占 claim
    {
      const seed = await SessionRegistry.create(dir)
      seed.register('sess-dead', '/project')
      seed.updatePid('sess-dead', 99999)
      assert.equal(seed.acquireClaim('sess-dead', 'src/index.ts', 'exclusive'), true)
      seed.close()
    }

    const registry = await initServeSessionRegistry(dir)
    try {
      // 修复前：acquireClaim 恒 false——幽灵 claim 永久锁死写入
      assert.equal(registry.acquireClaim('sess-new', 'src/index.ts', 'exclusive'), true)
      assert.equal(registry.checkClaim('src/index.ts')?.sessionId, 'sess-new')
      // 死会话行连同 claims 一起被清掉
      assert.equal(registry.listActive().some((s) => s.id === 'sess-dead'), false)
    } finally {
      registry.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sidecar 启动收割：活会话的 claim 不受影响', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'serve-reap-alive-'))
  try {
    {
      const seed = await SessionRegistry.create(dir)
      // register 记录当前进程 pid——测试进程活着，即活会话
      seed.register('sess-alive', '/project')
      assert.equal(seed.acquireClaim('sess-alive', 'a.ts', 'exclusive'), true)
      seed.close()
    }

    const registry = await initServeSessionRegistry(dir)
    try {
      // 活会话没被误清：claim 仍被持有，其他会话依然要排队
      assert.equal(registry.acquireClaim('sess-other', 'a.ts', 'exclusive'), false)
      assert.equal(registry.checkClaim('a.ts')?.sessionId, 'sess-alive')
      assert.equal(registry.listActive().some((s) => s.id === 'sess-alive'), true)
    } finally {
      registry.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

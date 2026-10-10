/**
 * 回归测试：MCP 连接 close 失败时不得从 connections 摘除（否则孤儿进程）。
 *
 * 缺陷：McpManager 多处先 connections.delete(serverId) 后 best-effort
 * transport.close()。close 抛错时连接已从唯一登记表移除 → 进程退出路径的
 * killChildrenSync()（遍历 connections 取 pid）无法回收 → 孤儿子进程。
 *
 * 修复：_closeAndDeregister — close 成功才 delete；失败则保留登记 +
 * suppressReconnect。connect 后 generation 过期那处改为失败时 connections.set。
 *
 * 断言：connect 期间 generation 过期 + close 抛错 → 连接仍应在 connections 中，
 * 可被 killChildrenSync 回收。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { McpManager } from '../manager.js'

function makeConfig(servers: Record<string, unknown>) {
  return {
    servers,
    cwd: process.cwd(),
    healthCheckIntervalMs: 0,
    reconnectBackoffMs: 0,
  } as never
}

describe('McpManager — close failure must not orphan the child', () => {
  it('connect 期间 generation 过期 + close 抛错 → 连接仍可被 killChildrenSync 回收', async () => {
    const mgr = new McpManager(makeConfig({ srv: { command: 'node', args: ['x.js'] } }))

    const fakePid = 99999
    let closeThrew = false

    // 初始 generation = 1，与传入的 1 匹配（通过入口 isCurrent 检查）
    mgr['connectionGenerations'].set('srv', 1)

    // _connectServer 成功返回带 pid 的 transport；close 抛错。
    // 并在返回前推进 generation（模拟 connect 期间并发 restart）。
    mgr['_connectServer'] = async () => {
      mgr['connectionGenerations'].set('srv', 42) // 使返回后 isCurrent() 为假
      return {
        client: { listTools: async () => ({ tools: [] }) } as never,
        transport: {
          pid: fakePid,
          close: async () => { closeThrew = true; throw new Error('transport close failed (simulated)') },
        },
        transportType: 'stdio',
        serverId: 'srv',
      }
    }
    mgr['_discoverTools'] = async () => []

    await mgr['_connectAndDiscover']('srv', { command: 'node', args: ['x.js'] } as never, 0, 1).catch(() => {})

    const stillRegistered = mgr['connections'].has('srv')
    const registeredPid = stillRegistered
      ? (mgr['connections'].get('srv') as { transport?: { pid?: number } })?.transport?.pid
      : null

    assert.equal(closeThrew, true, '前提：close 必须真的被调用且抛错')
    assert.equal(stillRegistered, true,
      'close 抛错后子进程失去登记 → killChildrenSync() 无法回收（孤儿）')
    assert.equal(registeredPid, fakePid)
  })
})

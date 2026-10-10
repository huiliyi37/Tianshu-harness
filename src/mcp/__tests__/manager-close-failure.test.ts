import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { McpManager } from '../manager.js'

describe('McpManager close failure preserves registration for killChildrenSync (#432)', () => {
  it('shutdownServer keeps connection in map when transport.close() throws', async () => {
    const manager = new McpManager({ enabled: true, servers: {} })
    let closeCalled = false

    const fakeTransport = {
      pid: 99999,
      close: async () => {
        closeCalled = true
        throw new Error('EPIPE: broken pipe or deadlock during close')
      },
    }

    const fakeConn = {
      serverConfig: { command: 'echo', args: [] },
      transport: fakeTransport as any,
      client: {} as any,
    }

    // Register connection
    ;(manager as any).connections.set('srv-err', fakeConn)
    assert.equal((manager as any).connections.has('srv-err'), true)

    // Attempt shutdown
    await manager.shutdownServer('srv-err')

    assert.equal(closeCalled, true, 'close should be called')
    assert.equal(
      (manager as any).connections.has('srv-err'),
      true,
      'failed close must retain registration so killChildrenSync can harvest orphaned child',
    )
    assert.equal(
      (manager as any).suppressReconnect.has('srv-err'),
      true,
      'failed close must be added to suppressReconnect',
    )
  })
})

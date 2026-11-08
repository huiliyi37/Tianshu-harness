import test from 'node:test'
import assert from 'node:assert/strict'

test('runtime 暴露常驻态访问器与共享状态', async () => {
  const rt = await import('../runtime.js')
  assert.equal(typeof rt.startResident, 'function')
  assert.equal(typeof rt.ensureConnected, 'function')
  assert.equal(typeof rt.ensureConnection, 'function')
  assert.equal(typeof rt.buildBridge, 'function')
  assert.equal(typeof rt.pickConnector, 'function')
  assert.equal(typeof rt.getConfig, 'function')
  assert.equal(typeof rt.state, 'object')
  assert.equal(typeof rt.logger, 'object')
  assert.ok(rt.connections instanceof Map)
  assert.equal(rt.PLUGIN_NAME, 'tianshu-imbridge')
})

test('未配置的通道返回 null，不抛错', async () => {
  const rt = await import('../runtime.js')
  assert.equal(await rt.ensureConnected('not-a-channel'), null)
})

test('getConfig 在未加载前返回 null（不触发读取）', async () => {
  const rt = await import('../runtime.js')
  assert.equal(rt.getConfig('qq'), null)
  assert.equal(rt.getConfig('weixin'), null)
})

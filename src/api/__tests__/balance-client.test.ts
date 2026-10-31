import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { once } from 'node:events'
import { ProxyAgent } from 'undici'
import { balanceEndpoint, queryDeepSeekBalance } from '../balance-client.js'

test('balanceEndpoint: 剥掉 OpenAI 兼容层后缀（preset baseUrl 带 /v1）', () => {
  assert.equal(balanceEndpoint('https://api.deepseek.com/v1'), 'https://api.deepseek.com/user/balance')
  assert.equal(balanceEndpoint('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/user/balance')
  assert.equal(balanceEndpoint('https://api.deepseek.com/beta'), 'https://api.deepseek.com/user/balance')
  assert.equal(balanceEndpoint('https://api.deepseek.com/anthropic'), 'https://api.deepseek.com/user/balance')
})

test('balanceEndpoint: 域根 baseUrl 原样拼接', () => {
  assert.equal(balanceEndpoint('https://api.deepseek.com'), 'https://api.deepseek.com/user/balance')
  assert.equal(balanceEndpoint('https://api.deepseek.com/'), 'https://api.deepseek.com/user/balance')
})

test('balanceEndpoint: 只剥末段，路径中间的 v1 不动', () => {
  assert.equal(balanceEndpoint('https://proxy.example.com/v1/deepseek'), 'https://proxy.example.com/v1/deepseek/user/balance')
})

// issue #545：余额查询必须把 dispatcher 透传给 fetch——否则配置了代理也直连。
// https 目标经 ProxyAgent 时先向代理发 CONNECT；本地 stub 只计数 CONNECT 后
// 断开连接（无法完成对 api.deepseek.com 的 TLS 握手），查询按静默语义返回 null，
// 但“代理确实收到了请求”这一事实本身就是路由证据。无 dispatcher 的对照组则
// 必须让同一个 stub 收到 0 次 CONNECT（即回归到旧实现时本用例失败）。
async function withConnectStub() {
  const connects: string[] = []
  const sockets = new Set<Duplex>()
  const proxy = createServer()
  proxy.on('connect', (_req, socket) => {
    connects.push(_req.url ?? '')
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    // 隧道建好即断开：TLS 无法继续，queryDeepSeekBalance 应静默返回 null。
    socket.end()
  })
  proxy.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  const port = (proxy.address() as { port: number }).port
  const close = async () => {
    for (const socket of sockets) socket.destroy()
    proxy.close()
    await once(proxy, 'close').catch(() => {})
  }
  return { port, connects, close }
}

test('queryDeepSeekBalance: 传入 dispatcher 时余额请求经代理发出 CONNECT', async () => {
  const stub = await withConnectStub()
  try {
    const dispatcher = new ProxyAgent({ uri: `http://127.0.0.1:${stub.port}` })
    const result = await queryDeepSeekBalance('test-key', 'https://api.deepseek.com/v1', undefined, dispatcher)
    assert.equal(result, null, 'stub 断开隧道后查询应静默返回 null，不抛异常')
    assert.equal(stub.connects.length, 1, '代理应恰好收到一次 CONNECT')
    assert.equal(stub.connects[0], 'api.deepseek.com:443')
  } finally {
    await stub.close()
  }
})

test('queryDeepSeekBalance: 不传 dispatcher 时余额请求不经过代理（旧实现行为）', async () => {
  const stub = await withConnectStub()
  try {
    const result = await queryDeepSeekBalance('test-key', 'https://api.deepseek.com/v1')
    assert.equal(result, null, '网络错误/401 时查询应静默返回 null，不抛异常')
    assert.equal(stub.connects.length, 0, '无 dispatcher 时代理不应收到任何 CONNECT')
  } finally {
    await stub.close()
  }
})

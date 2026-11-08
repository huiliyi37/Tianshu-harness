/**
 * iLink HTTP 客户端契约测试 —— 用**真 HTTP 的假 iLink 服务器**验收。
 *
 * 为什么不用 mock fetch 糊过去：这里要验的是「报文形状与错误分类」，
 * 真实 socket 才能把 Content-Type、请求头、状态码、坏 JSON 这些东西一并暴露出来。
 * （长轮询循环的验收在 weixin-connection.test.mjs，那边用的是同一个手法的升级版。）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { makeWeixinApi, describeError, isRetryableError, isStaleTokenError } from '../lib/weixin/api.mjs'
import { ILINK_BOT_AGENT, ILINK_CHANNEL_VERSION } from '../lib/weixin/protocol.mjs'

const TOKEN = 'test-bot-token-abcdefghijklmn'

/** 起一个假 iLink 服务器；handler(req, res, body) 自行决定响应。 */
async function startFakeIlink(handler) {
  const requests = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body = null
      try {
        body = raw ? JSON.parse(raw) : null
      } catch { /* 保留 raw，测试里自行断言 */ }
      const record = { method: req.method, url: req.url, headers: req.headers, body, raw }
      requests.push(record)
      handler(record, res)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

test('getUpdates: 请求形状（路径 / 头 / base_info / 游标回传）与响应解析', async () => {
  const fake = await startFakeIlink((req, res) => {
    json(res, 200, {
      ret: 0,
      msgs: [{ message_id: 'm1', seq: 1, from_user_id: 'u1', item_list: [{ type: 1, text_item: { text: 'hi' } }] }],
      get_updates_buf: 'CURSOR-1',
      longpolling_timeout_ms: 12_000,
    })
  })
  try {
    const api = makeWeixinApi({ baseUrl: fake.baseUrl, token: TOKEN })
    const result = await api.getUpdates({ cursor: 'CURSOR-0', timeoutMs: 1_000 })

    assert.equal(fake.requests.length, 1)
    const req = fake.requests[0]
    assert.equal(req.method, 'POST')
    assert.equal(req.url, '/ilink/bot/getupdates')
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`)
    assert.equal(req.headers.authorizationtype, 'ilink_bot_token')
    assert.equal(req.body.get_updates_buf, 'CURSOR-0')
    assert.equal(req.body.base_info.channel_version, ILINK_CHANNEL_VERSION)
    assert.equal(req.body.base_info.bot_agent, ILINK_BOT_AGENT)

    assert.equal(result.msgs.length, 1)
    assert.equal(result.get_updates_buf, 'CURSOR-1')
    assert.equal(result.longpolling_timeout_ms, 12_000)
  } finally {
    await fake.close()
  }
})

test('getUpdates: 空响应（无字段）不炸，游标回空串由上层保住旧值', async () => {
  const fake = await startFakeIlink((req, res) => json(res, 200, { ret: 0 }))
  try {
    const api = makeWeixinApi({ baseUrl: fake.baseUrl, token: TOKEN })
    const result = await api.getUpdates({ cursor: 'C1', timeoutMs: 1_000 })
    assert.deepEqual(result.msgs, [])
    assert.equal(result.get_updates_buf, '')
    assert.equal(result.longpolling_timeout_ms, null)
  } finally {
    await fake.close()
  }
})

test('getUpdates: 服务端挂住到客户端超时 → 当作「本轮无消息」软返回（长轮询的正常形态）', async () => {
  const fake = await startFakeIlink(() => { /* 故意不响应 */ })
  try {
    const api = makeWeixinApi({ baseUrl: fake.baseUrl, token: TOKEN })
    // 客户端超时 = 请求超时 + 10s 余量；给 1 秒即可在 11 秒内跑完这条用例
    const result = await api.getUpdates({ cursor: 'C1', timeoutMs: 1_000 })
    assert.equal(result.softTimeout, true)
    assert.deepEqual(result.msgs, [])
    // 非正超时值不回落默认值（否则调用方以为收紧了，其实在等 35 秒）
    const floored = await api.getUpdates({ cursor: 'C1', timeoutMs: 0 })
    assert.equal(floored.softTimeout, true)
  } finally {
    await fake.close()
  }
})

test('sendText: 信封字段（含 context_token）与 message_id 回传', async () => {
  const fake = await startFakeIlink((req, res) => json(res, 200, { ret: 0, message_id: 'srv-msg-9' }))
  try {
    const api = makeWeixinApi({ baseUrl: fake.baseUrl, token: TOKEN })
    const sent = await api.sendText({
      toUserId: 'u@im.wechat', text: '回你一句', clientId: 'client-1', contextToken: 'CT-1',
    })
    const req = fake.requests[0]
    assert.equal(req.url, '/ilink/bot/sendmessage')
    assert.deepEqual(req.body.msg.item_list, [{ type: 1, text_item: { text: '回你一句' } }])
    assert.equal(req.body.msg.to_user_id, 'u@im.wechat')
    assert.equal(req.body.msg.client_id, 'client-1')
    assert.equal(req.body.msg.context_token, 'CT-1')
    assert.equal(req.body.msg.message_type, 2)
    assert.equal(sent.messageId, 'srv-msg-9')
  } finally {
    await fake.close()
  }
})

test('sendText: 服务端不给 message_id 时回退 clientId（不等于失败）', async () => {
  const fake = await startFakeIlink((req, res) => json(res, 200, { ret: 0 }))
  try {
    const api = makeWeixinApi({ baseUrl: fake.baseUrl, token: TOKEN })
    const sent = await api.sendText({ toUserId: 'u', text: 'x', clientId: 'client-2' })
    assert.equal(sent.messageId, 'client-2')
  } finally {
    await fake.close()
  }
})

test('错误分类: HTTP 500 / 坏 JSON / 业务码 非0 / -14 各归各的类', async () => {
  const cases = [
    { name: 'HTTP 500', respond: (res) => json(res, 500, { ret: 0 }), code: 'http-error', retry: true },
    { name: '坏 JSON', respond: (res) => { res.writeHead(200); res.end('{ 不是 JSON') }, code: 'invalid-response', retry: false },
    { name: '业务码 50001', respond: (res) => json(res, 200, { ret: 0, errcode: 50001 }), code: 'request-rejected', retry: false },
    { name: '业务码 -14', respond: (res) => json(res, 200, { errcode: -14, errmsg: 'session timeout' }), code: 'stale-token', retry: false },
  ]
  for (const item of cases) {
    const fake = await startFakeIlink((req, res) => item.respond(res))
    try {
      const api = makeWeixinApi({ baseUrl: fake.baseUrl, token: TOKEN })
      await assert.rejects(
        () => api.getUpdates({ cursor: 'C', timeoutMs: 1_000 }),
        (error) => {
          assert.equal(error.code, item.code, `${item.name} 应归类为 ${item.code}，实得 ${error.code}`)
          assert.equal(isRetryableError(error), item.retry, `${item.name} 的可重试性不符`)
          assert.equal(isStaleTokenError(error), item.code === 'stale-token')
          return true
        },
      )
    } finally {
      await fake.close()
    }
  }
})

test('错误保真: -14 带上 providerCode，日志里能看出是哪个业务码', async () => {
  const fake = await startFakeIlink((req, res) => json(res, 200, { ret: -14 }))
  try {
    const api = makeWeixinApi({ baseUrl: fake.baseUrl, token: TOKEN })
    await assert.rejects(
      () => api.getUpdates({ timeoutMs: 1_000 }),
      (error) => {
        assert.equal(error.providerCode, '-14')
        assert.equal(error.code, 'stale-token')
        assert.match(error.message, /重新扫码/)
        return true
      },
    )
  } finally {
    await fake.close()
  }
})

test('连不上: 网络错误归类为 network-error（可重试）', async () => {
  // 指向一个必然失败的端口（未监听）
  const api = makeWeixinApi({ baseUrl: 'http://127.0.0.1:1', token: TOKEN })
  await assert.rejects(
    () => api.getUpdates({ timeoutMs: 1_000 }),
    (error) => {
      assert.equal(error.code, 'network-error')
      assert.equal(isRetryableError(error), true)
      assert.equal(isStaleTokenError(error), false)
      return true
    },
  )
})

test('取消: 外部 abort → aborted（不是 network-error，别被退避逻辑当成故障）', async () => {
  const fake = await startFakeIlink(() => { /* 挂住 */ })
  try {
    const api = makeWeixinApi({ baseUrl: fake.baseUrl, token: TOKEN })
    const controller = new AbortController()
    const pending = api.getUpdates({ cursor: 'C', signal: controller.signal, timeoutMs: 5_000 })
    setTimeout(() => controller.abort(), 30)
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, 'aborted')
      return true
    })
  } finally {
    await fake.close()
  }
})

test('getConfig / sendTyping: 取到 typing_ticket 并按契约发送；失败一律静默', async () => {
  const fake = await startFakeIlink((req, res) => {
    if (req.url === '/ilink/bot/getconfig') return json(res, 200, { ret: 0, typing_ticket: 'TICKET-1' })
    if (req.url === '/ilink/bot/sendtyping') return json(res, 200, { ret: 0 })
    return json(res, 500, {})
  })
  try {
    const api = makeWeixinApi({ baseUrl: fake.baseUrl, token: TOKEN })
    const { typingTicket } = await api.getConfig({ toUserId: 'u1', contextToken: 'CT' })
    assert.equal(typingTicket, 'TICKET-1')
    // getconfig 请求体带 ilink_user_id 与 context_token
    const cfgReq = fake.requests.find((r) => r.url === '/ilink/bot/getconfig')
    assert.equal(cfgReq.body.ilink_user_id, 'u1')
    assert.equal(cfgReq.body.context_token, 'CT')

    assert.equal(await api.sendTyping({ typingTicket }), true)
    const typingReq = fake.requests.find((r) => r.url === '/ilink/bot/sendtyping')
    assert.deepEqual({ ticket: typingReq.body.typing_ticket, status: typingReq.body.status }, { ticket: 'TICKET-1', status: 1 })
    assert.equal(await api.sendTyping({ typingTicket, status: 2 }), true)

    // 失败静默：给个坏 baseUrl，方法不抛、返回 false/null
    const broken = makeWeixinApi({ baseUrl: 'http://127.0.0.1:1', token: TOKEN })
    assert.equal(await broken.sendTyping({ typingTicket: 'x' }), false)
    assert.equal((await broken.getConfig({ toUserId: 'u1' })).typingTicket, null)
    assert.equal(await broken.notify('start'), false)
  } finally {
    await fake.close()
  }
})

test('notify: start / stop 命中各自端点，失败只记日志不抛', async () => {
  const fake = await startFakeIlink((req, res) => json(res, 200, { ret: 0 }))
  try {
    const api = makeWeixinApi({ baseUrl: fake.baseUrl, token: TOKEN })
    assert.equal(await api.notify('start'), true)
    assert.equal(await api.notify('stop'), true)
    assert.deepEqual(fake.requests.map((r) => r.url), [
      '/ilink/bot/msg/notifystart',
      '/ilink/bot/msg/notifystop',
    ])
  } finally {
    await fake.close()
  }
})

test('鉴权缺失: 未给 token 时不带 Authorization 头（空串不是凭据）', async () => {
  const fake = await startFakeIlink((req, res) => json(res, 200, { ret: 0 }))
  try {
    const api = makeWeixinApi({ baseUrl: fake.baseUrl, token: '   ' })
    await api.getUpdates({ timeoutMs: 1_000 })
    assert.equal('authorization' in fake.requests[0].headers, false)
    assert.equal(fake.requests[0].headers.authorizationtype, 'ilink_bot_token')
  } finally {
    await fake.close()
  }
})

test('describeError: 给人看的错误描述不留空', () => {
  assert.equal(typeof describeError(new Error('boom')), 'string')
  assert.equal(describeError(new Error('boom')), 'boom')
  assert.ok(describeError(null).length > 0)
  assert.ok(describeError({ name: 'AbortError' }).length > 0)
})

/**
 * 微信连接器契约测试 —— 假 iLink 服务器（真 HTTP），端到端验收长轮询。
 *
 * 这一层是「能跑」与「跑得住」的分界：
 * - 消息不重不漏（去重 + 游标推进）
 * - 安全默认（未配置 owner = 全拒；非 owner 拒收；群聊拒收）
 * - 故障行为（-14 暂停、连接失败退避、停止时干净收尾）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WeixinConnection, normalizeSendTarget } from '../lib/weixin/connection.mjs'
import { makeWeixinStateStore } from '../lib/weixin/state.mjs'
import { ILINK_BOT_AGENT } from '../lib/weixin/protocol.mjs'

const TOKEN = 'conn-test-token-abcdefghij'
const OWNER = 'owner@im.wechat'
const STRANGER = 'stranger@im.wechat'

function textMessage(id, text, over = {}) {
  return {
    seq: Number(id.replace(/\D/g, '')) || 1,
    message_id: id,
    from_user_id: OWNER,
    to_user_id: 'bot@im.bot',
    message_type: 1,
    message_state: 2,
    context_token: `CT-${id}`,
    item_list: [{ type: 1, text_item: { text } }],
    ...over,
  }
}

/**
 * 假 iLink 服务器：
 * - 每次 getupdates 弹出队首的一批消息（空队列时返回空批，模拟长轮询超时返回）
 * - 记录每次请求（便于断言游标与退避）
 * - 可切换 -14 模式 / 强制断连模式
 */
async function startFakeIlink({ batches = [], mode = 'ok', emptyDelayMs = 0 } = {}) {
  const requests = []
  const pending = [...batches]
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      let body = null
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch { /* ignore */ }
      requests.push({ url: req.url, body })
      const reply = (payload) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (req.url === '/ilink/bot/msg/notifystart' || req.url === '/ilink/bot/msg/notifystop') {
        return reply({ ret: 0 })
      }
      if (req.url === '/ilink/bot/getupdates') {
        if (mode === 'stale') return reply({ ret: 0, errcode: -14, errmsg: 'session timeout' })
        const next = pending.shift()
        const payload = next
          ? { ret: 0, msgs: next, get_updates_buf: `CUR-${requests.length}` }
          : { ret: 0, msgs: [], get_updates_buf: '' }
        if (!next && emptyDelayMs > 0) return void setTimeout(() => reply(payload), emptyDelayMs)
        return reply(payload)
      }
      if (req.url === '/ilink/bot/sendmessage') return reply({ ret: 0, message_id: 'srv-1' })
      if (req.url === '/ilink/bot/getconfig') return reply({ ret: 0, typing_ticket: 'TICKET' })
      if (req.url === '/ilink/bot/sendtyping') return reply({ ret: 0 })
      return reply({ ret: 0 })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    sent: () => requests.filter((r) => r.url === '/ilink/bot/sendmessage'),
    polls: () => requests.filter((r) => r.url === '/ilink/bot/getupdates'),
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

function makeConn(over = {}) {
  const received = []
  const dir = mkdtempSync(join(tmpdir(), 'wx-conn-'))
  const state = makeWeixinStateStore({
    file: join(dir, 'state.json'),
    tokenFile: join(dir, 'tokens.json'),
  })
  const connection = new WeixinConnection({
    config: {
      botToken: TOKEN,
      ownerUserId: OWNER,
      baseUrl: over.baseUrl,
      configFile: 'weixin.json',
      longPollTimeoutMs: over.longPollTimeoutMs ?? 1_000,
    },
    logger: over.logger ?? {},
    onMessage: (m) => received.push(m),
    state,
    staleTokenPauseMs: over.staleTokenPauseMs,
  })
  return {
    connection, received, state, dir,
    cleanup() { rmSync(dir, { recursive: true, force: true }) },
  }
}

const tick = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, { timeoutMs = 3_000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await tick(stepMs)
  }
  return false
}

test('normalizeSendTarget: 认字符串与对象两种形态，空值返回 null', () => {
  assert.deepEqual(normalizeSendTarget('u1'), { targetId: 'u1', contextToken: null, messageId: null })
  assert.deepEqual(
    normalizeSendTarget({ scope: 'c2c', targetId: 'u1', contextToken: 'CT', messageId: 'm1' }),
    { targetId: 'u1', contextToken: 'CT', messageId: 'm1' },
  )
  assert.equal(normalizeSendTarget(null), null)
  assert.equal(normalizeSendTarget('   '), null)
  assert.equal(normalizeSendTarget({ scope: 'c2c' }), null)
})

test('构造: 缺 token 或缺回调直接抛错（早失败，别静默装死）', () => {
  assert.throws(() => new WeixinConnection({ config: {}, onMessage: () => {} }), TypeError)
  assert.throws(() => new WeixinConnection({ config: { botToken: 'tk' } }), TypeError)
})

test('入站: owner 的消息交给桥，状态机转为 connected，游标落盘', async () => {
  const fake = await startFakeIlink({ batches: [[textMessage('m1', '你好'), textMessage('m2', '再来一条')]] })
  const app = makeConn({ baseUrl: fake.baseUrl })
  try {
    app.connection.start()
    assert.equal(await waitFor(() => app.received.length === 2), true, '两条消息都该到达')
    assert.equal(app.received[0].content, '你好')
    assert.equal(app.received[0].senderId, OWNER)
    assert.equal(app.received[0].replyTarget.contextToken, 'CT-m1')
    assert.equal(app.connection.status.state, 'connected')
    assert.equal(app.connection.status.inboundCount, 2)
    assert.equal(await waitFor(() => app.state.getCursor() !== ''), true, '游标应落盘')
    // 后续轮询带上落盘游标
    assert.equal(await waitFor(() => fake.polls().some((p) => p.body.get_updates_buf.startsWith('CUR-'))), true)
  } finally {
    await app.connection.stop()
    await fake.close()
    app.cleanup()
  }
})

test('去重: 同一条 message_id 重复推送只进一次（重连重放不重复干活）', async () => {
  const fake = await startFakeIlink({
    batches: [[textMessage('m1', '第一次')], [textMessage('m1', '第一次')]],
  })
  const app = makeConn({ baseUrl: fake.baseUrl })
  try {
    app.connection.start()
    assert.equal(await waitFor(() => app.received.length === 1), true)
    await tick(400)
    assert.equal(app.received.length, 1, '重复的那条不该再交给桥')
    assert.equal(app.connection.status.inboundCount, 1)
  } finally {
    await app.connection.stop()
    await fake.close()
    app.cleanup()
  }
})

test('安全默认: 未配置 owner → 一律拒收（不交给桥），且日志给出修复指引', async () => {
  const fake = await startFakeIlink({ batches: [[textMessage('m1', '陌生人的话')]] })
  const warnings = []
  const app = makeConn({ baseUrl: fake.baseUrl, logger: { warn: (...a) => warnings.push(a.join(' ')) } })
  app.connection = new WeixinConnection({
    config: { botToken: TOKEN, baseUrl: fake.baseUrl, configFile: 'weixin.json', longPollTimeoutMs: 1_000 },
    logger: { warn: (...a) => warnings.push(a.join(' ')) },
    onMessage: (m) => app.received.push(m),
    state: app.state,
  })
  try {
    app.connection.start()
    assert.equal(await waitFor(() => app.connection.status.filteredCount === 1), true)
    assert.equal(app.received.length, 0, '未配置 owner 时任何消息都不该进桥')
    assert.equal(warnings.some((w) => w.includes('ownerUserId')), true, '要给出修复指引')
  } finally {
    await app.connection.stop()
    await fake.close()
    app.cleanup()
  }
})

test('授权: 配了 owner 后，陌生人拒收、群聊拒收（哪怕发信人是 owner）', async () => {
  const fake = await startFakeIlink({
    batches: [[
      textMessage('m1', '主人的话'),
      textMessage('m2', '外人的话', { from_user_id: STRANGER }),
      textMessage('m3', '群里的话', { group_id: 'G-1' }),
    ]],
  })
  const app = makeConn({ baseUrl: fake.baseUrl })
  try {
    app.connection.start()
    assert.equal(await waitFor(() => app.received.length === 1), true)
    assert.equal(app.received[0].content, '主人的话')
    assert.equal(await waitFor(() => app.connection.status.filteredCount === 2), true)
    assert.equal(app.connection.status.inboundCount, 1)
  } finally {
    await app.connection.stop()
    await fake.close()
    app.cleanup()
  }
})

test('重启续接: 已见 id 与游标写盘，新实例不重放旧消息', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wx-restart-'))
  const stateFile = join(stateDir, 'state.json')
  const tokenFile = join(stateDir, 'tokens.json')
  try {
    const first = await startFakeIlink({ batches: [[textMessage('m1', '第一次收到的')]] })
    const receivedA = []
    const connA = new WeixinConnection({
      config: { botToken: TOKEN, ownerUserId: OWNER, baseUrl: first.baseUrl, longPollTimeoutMs: 1_000 },
      onMessage: (m) => receivedA.push(m),
      state: makeWeixinStateStore({ file: stateFile, tokenFile }),
    })
    connA.start()
    assert.equal(await waitFor(() => receivedA.length === 1), true)
    await connA.stop()
    await first.close()

    // 服务端重放同一条（模拟重启后从旧游标附近再推一次）
    const second = await startFakeIlink({ batches: [[textMessage('m1', '第一次收到的')]] })
    const receivedB = []
    const connB = new WeixinConnection({
      config: { botToken: TOKEN, ownerUserId: OWNER, baseUrl: second.baseUrl, longPollTimeoutMs: 1_000 },
      onMessage: (m) => receivedB.push(m),
      state: makeWeixinStateStore({ file: stateFile, tokenFile }),
    })
    try {
      connB.start()
      await tick(500)
      assert.equal(receivedB.length, 0, '重启后不该重复处理已见消息')
      const polls = second.polls()
      assert.ok(polls.length >= 1)
      assert.notEqual(polls[0].body.get_updates_buf, '', '重启后应从落盘游标继续')
    } finally {
      await connB.stop()
      await second.close()
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('游标: 服务端给空游标时保住旧值（否则下轮重放历史）', async () => {
  const fake = await startFakeIlink({ batches: [[textMessage('m1', '有消息')]] })
  const app = makeConn({ baseUrl: fake.baseUrl })
  try {
    app.connection.start()
    assert.equal(await waitFor(() => fake.polls().length >= 2), true)
    await tick(200)
    const later = fake.polls().slice(1)
    assert.ok(later.length >= 1)
    // 第 1 轮之后服务端回空游标：后续请求必须仍带上一次的有效游标
    assert.equal(later.every((p) => typeof p.body.get_updates_buf === 'string' && p.body.get_updates_buf !== ''), true,
      `后续轮询都该带游标，实得：${JSON.stringify(later.map((p) => p.body.get_updates_buf))}`)
  } finally {
    await app.connection.stop()
    await fake.close()
    app.cleanup()
  }
})

test('软超时: 服务端挂住到超时 → 保持 connected，不算故障、不退避', async () => {
  const fake = await startFakeIlink({ batches: [], emptyDelayMs: 1_500 })
  const app = makeConn({ baseUrl: fake.baseUrl, longPollTimeoutMs: 300 })
  try {
    app.connection.start()
    assert.equal(await waitFor(() => app.connection.status.state === 'connected', { timeoutMs: 2_000 }), true)
    assert.equal(app.connection.status.lastError, null)
    // 退避序列一旦启动就会超过 1 秒；软超时下轮询应密集（≥2 次）
    await tick(1_600)
    assert.ok(fake.polls().length >= 2, `软超时不该触发退避，实得轮询 ${fake.polls().length} 次`)
  } finally {
    await app.connection.stop()
    await fake.close()
    app.cleanup()
  }
})

test('凭据失效: -14 → 进入 paused，不再发请求（等主人重新扫码）', async () => {
  const fake = await startFakeIlink({ mode: 'stale' })
  const app = makeConn({ baseUrl: fake.baseUrl, staleTokenPauseMs: 1_200 })
  try {
    app.connection.start()
    assert.equal(await waitFor(() => app.connection.status.state === 'paused'), true)
    assert.match(app.connection.status.lastError, /重新扫码/)
    const pollsAtPause = fake.polls().length
    await tick(600)
    assert.equal(fake.polls().length, pollsAtPause, '暂停期内不该继续打请求')
    // 暂停过期后恢复轮询（仍然失败 → 再次进入 paused）
    assert.equal(await waitFor(() => fake.polls().length > pollsAtPause, { timeoutMs: 3_000 }), true)
  } finally {
    await app.connection.stop()
    await fake.close()
    app.cleanup()
  }
})

test('故障退避: 连不上服务器 → 状态 error、有退避（不是空转猛打）', async () => {
  // 起一个服务器记下端口后立刻关掉，保证该端口当时无人监听
  const tmp = await startFakeIlink({})
  const deadUrl = tmp.baseUrl
  await tmp.close()

  const app = makeConn({ baseUrl: deadUrl })
  try {
    app.connection.start()
    assert.equal(await waitFor(() => app.connection.status.state === 'error'), true)
    assert.ok(app.connection.status.lastError)
    assert.equal(app.connection.status.ready, false)
    await tick(300)
    // 第一次退避是 250ms，300ms 内最多再打一次；绝不该出现几十次
    assert.ok(app.connection.status.state === 'error' || app.connection.status.state === 'connecting')
  } finally {
    await app.connection.stop()
    app.cleanup()
  }
})

test('sendText: 被动回复带上 replyTarget 的 context_token；主动通知用记录里的最近令牌', async () => {
  const fake = await startFakeIlink({ batches: [[textMessage('m1', '帮我查一下')]] })
  const app = makeConn({ baseUrl: fake.baseUrl })
  try {
    app.connection.start()
    assert.equal(await waitFor(() => app.received.length === 1), true)
    // 被动回复：用消息带来的凭据
    await app.connection.sendText(app.received[0].replyTarget, '收到')
    // 主动通知：只给字符串目标，回退到该发信人最近记录的令牌
    await app.connection.sendText(OWNER, '主动提一句')
    const sent = fake.sent()
    assert.equal(sent.length, 2)
    assert.equal(sent[0].body.msg.context_token, 'CT-m1')
    assert.equal(sent[0].body.msg.to_user_id, OWNER)
    assert.match(sent[0].body.msg.client_id, /^tianshu-imbridge-/)
    assert.equal(sent[1].body.msg.context_token, 'CT-m1', '主动通知也要回落到最近令牌')
    assert.equal(app.connection.status.deliveryCount, 2)
  } finally {
    await app.connection.stop()
    await fake.close()
    app.cleanup()
  }
})

test('sendText: 目标或内容非法 → 抛错（不静默吞掉一次没发出去的回复）', async () => {
  const fake = await startFakeIlink({})
  const app = makeConn({ baseUrl: fake.baseUrl })
  try {
    await assert.rejects(() => app.connection.sendText(null, 'x'), (e) => e.code === 'invalid-target')
    await assert.rejects(() => app.connection.sendText('u1', '   '), (e) => e.code === 'empty-text')
    assert.equal(fake.sent().length, 0)
  } finally {
    await app.connection.stop()
    await fake.close()
    app.cleanup()
  }
})

test('sendTyping: 首次取 ticket 一次，之后复用；失败静默返回 false', async () => {
  const fake = await startFakeIlink({})
  const app = makeConn({ baseUrl: fake.baseUrl })
  try {
    app.connection.start()
    assert.equal(await app.connection.sendTyping('u1'), true)
    assert.equal(await app.connection.sendTyping('u1'), true)
    const configCalls = fake.requests.filter((r) => r.url === '/ilink/bot/getconfig')
    const typingCalls = fake.requests.filter((r) => r.url === '/ilink/bot/sendtyping')
    assert.equal(configCalls.length, 1, 'ticket 只取一次')
    assert.equal(typingCalls.length, 2)
  } finally {
    await app.connection.stop()
    await fake.close()
    app.cleanup()
  }
})

test('生命周期: 启动发 notifystart、停止发 notifystop；stop 幂等且收干净', async () => {
  const fake = await startFakeIlink({})
  const app = makeConn({ baseUrl: fake.baseUrl })
  try {
    app.connection.start()
    assert.equal(await waitFor(() => fake.requests.some((r) => r.url === '/ilink/bot/msg/notifystart')), true)
    await app.connection.stop()
    await app.connection.stop()   // 幂等
    assert.equal(fake.requests.filter((r) => r.url === '/ilink/bot/msg/notifystop').length, 1)
    assert.equal(app.connection.status.state, 'stopped')
    const pollsAfterStop = fake.polls().length
    await tick(300)
    assert.equal(fake.polls().length, pollsAfterStop, '停止后不该再轮询')
  } finally {
    await app.connection.stop()
    await fake.close()
    app.cleanup()
  }
})

test('拒收提示: 未配置 owner 时最多打一条带发信人标识的日志', async () => {
  const fake = await startFakeIlink({
    batches: [[
      textMessage('m1', '一', { from_user_id: 'unknown-a' }),
      textMessage('m2', '二', { from_user_id: 'unknown-b' }),
      textMessage('m3', '三', { from_user_id: 'unknown-c' }),
    ]],
  })
  const warnings = []
  const stateDir = mkdtempSync(join(tmpdir(), 'wx-blocked-'))
  try {
    const connection = new WeixinConnection({
      config: { botToken: TOKEN, baseUrl: fake.baseUrl, configFile: 'weixin.json', longPollTimeoutMs: 1_000 },
      logger: { warn: (...a) => warnings.push(a.join(' ')) },
      onMessage: () => { throw new Error('不该被调用') },
      state: makeWeixinStateStore({ file: join(stateDir, 's.json') }),
    })
    connection.start()
    assert.equal(await waitFor(() => connection.status.filteredCount === 3), true)
    const idWarnings = warnings.filter((w) => w.includes('ownerUserId'))
    assert.equal(idWarnings.length, 1, `未配置 owner 时提示最多一条，实得 ${idWarnings.length}`)
    assert.match(idWarnings[0], /unknown-a/)
  } finally {
    await fake.close()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('基座: 请求头带 bot_agent 声明（服务端看得见是我们）', async () => {
  const fake = await startFakeIlink({})
  const app = makeConn({ baseUrl: fake.baseUrl })
  try {
    app.connection.start()
    assert.equal(await waitFor(() => fake.polls().length >= 1), true)
    assert.equal(fake.polls()[0].body.base_info.bot_agent, ILINK_BOT_AGENT)
  } finally {
    await app.connection.stop()
    await fake.close()
    app.cleanup()
  }
})

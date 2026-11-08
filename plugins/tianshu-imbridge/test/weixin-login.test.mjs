/**
 * 扫码绑定流程回归测试（纯函数 + 假 iLink 服务器全流程 + 落盘）。
 *
 * 这一层是主人真机那一格的前置：key 到手那天，跑一条命令就该能绑上。
 * 所以用例要钉住：
 * - 只认 https + *.weixin.qq.com 的扫码地址（服务端被替身时不能把主人引到别处）
 * - 状态机的六种取值各有归宿（wait/scaned 继续，confirmed 保存，expired 刷新，need_verifycode 要验证码，binded_redirect 是「已经绑过」）
 * - 绑定成功后 weixin.json 被写出来，且**不把 token 打进任何输出**
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyLoginStatus,
  isTrustedWeixinHost,
  mergeWeixinAccount,
  normalizeQrUrl,
  saveWeixinAccount,
  waitForQrLogin,
} from '../lib/weixin/login.mjs'

test('可信主机: 只认 weixin.qq.com 及其子域，其余一律不放行', () => {
  assert.equal(isTrustedWeixinHost('weixin.qq.com'), true)
  assert.equal(isTrustedWeixinHost('ilinkai.weixin.qq.com'), true)
  assert.equal(isTrustedWeixinHost('evil.com'), false)
  assert.equal(isTrustedWeixinHost('weixin.qq.com.evil.com'), false)
  assert.equal(isTrustedWeixinHost('notweixin.qq.com'), false)
  assert.equal(isTrustedWeixinHost(''), false)
  assert.equal(isTrustedWeixinHost(null), false)
  assert.equal(isTrustedWeixinHost('WEIXIN.QQ.COM'), true, '大小写归一后仍可信')
})

test('扫码地址: https + 可信主机才放行；http / 别家域名 / 空值一律拒绝并说明原因', () => {
  assert.equal(
    normalizeQrUrl('https://weixin.qq.com/x?y=1').href,
    'https://weixin.qq.com/x?y=1',
  )
  const bad = [
    'http://weixin.qq.com/x',            // 非 https
    'https://evil.com/x',                // 别家域名
    'https://weixin.qq.com.evil.com/x',  // 后缀伪装
    '', null, 'not a url',
  ]
  for (const value of bad) {
    assert.throws(() => normalizeQrUrl(value), (error) => {
      assert.equal(error.code, 'untrusted-qr')
      return true
    }, `应拒绝：${String(value)}`)
  }
})

test('状态归类: 六种服务端状态各有归宿', () => {
  assert.equal(classifyLoginStatus({ status: 'wait' }).kind, 'pending')
  assert.equal(classifyLoginStatus({ status: 'scaned' }).kind, 'pending')
  assert.equal(classifyLoginStatus({ status: 'confirmed', bot_token: 'tk' }).kind, 'confirmed')
  // 说已确认却没给凭据 → 不算完成（否则会写出一个空 token 的配置）
  assert.equal(classifyLoginStatus({ status: 'confirmed' }).kind, 'unknown')
  assert.equal(classifyLoginStatus({ status: 'expired' }).kind, 'expired')
  assert.equal(classifyLoginStatus({ status: 'need_verifycode' }).kind, 'need-verifycode')
  assert.equal(classifyLoginStatus({ status: 'verify_code_blocked' }).kind, 'blocked')
  const binded = classifyLoginStatus({ status: 'binded_redirect' })
  assert.equal(binded.kind, 'already-bound')
  assert.match(binded.message, /已经绑过|已绑/)
  // 未知状态不当成功，也不崩
  assert.equal(classifyLoginStatus({ status: 'wat' }).kind, 'unknown')
  assert.equal(classifyLoginStatus(null).kind, 'unknown')
})

test('状态归类: 换域名（scaned_but_redirect）带出新 baseUrl', () => {
  const result = classifyLoginStatus({ status: 'scaned_but_redirect', redirect_host: 'idc2.weixin.qq.com' })
  assert.equal(result.kind, 'redirect')
  assert.equal(result.redirectHost, 'idc2.weixin.qq.com')
  assert.equal(classifyLoginStatus({ status: 'scaned_but_redirect' }).kind, 'unknown', '缺 redirect_host 时不认')
})

test('状态归类: confirmed 时把凭据取出来（缺 bot_token 视为未完成）', () => {
  const ok = classifyLoginStatus({
    status: 'confirmed', bot_token: 'tk-1', ilink_bot_id: 'wx_abc', baseurl: 'https://ilinkai.weixin.qq.com/', ilink_user_id: 'u@im.wechat',
  })
  assert.equal(ok.kind, 'confirmed')
  assert.equal(ok.token, 'tk-1')
  assert.equal(ok.botId, 'wx_abc')
  assert.equal(ok.userId, 'u@im.wechat')
  assert.equal(classifyLoginStatus({ status: 'confirmed', ilink_bot_id: 'wx_abc' }).kind, 'unknown')
})

test('落盘: 绑定结果写进 weixin.json，保留既有字段，不覆盖 owner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wx-login-'))
  const file = join(dir, 'weixin.json')
  try {
    writeFileSync(file, JSON.stringify({ ownerUserId: 'keep-me@im.wechat', workspace: 'D:/w' }))
    const merged = mergeWeixinAccount({ botToken: 'tk', botId: 'wx_1', userId: 'u@im.wechat' }, { existing: { ownerUserId: 'keep-me@im.wechat', workspace: 'D:/w' } })
    assert.equal(merged.ownerUserId, 'keep-me@im.wechat')
    assert.equal(merged.workspace, 'D:/w')
    assert.equal(merged.botToken, 'tk')
    assert.equal(merged.botId, 'wx_1')
    assert.equal(merged.lastBoundAt.length > 0, true)

    saveWeixinAccount(file, { botToken: 'tk-2', botId: 'wx_2', userId: 'u2@im.wechat' })
    const written = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(written.botToken, 'tk-2')
    assert.equal(written.botId, 'wx_2')
    assert.equal(written.ownerUserId, 'keep-me@im.wechat', '不能抹掉主人的 owner 配置')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('落盘: 首次绑定（没有旧文件）也能写出来', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wx-login-'))
  const file = join(dir, 'weixin.json')
  try {
    assert.equal(existsSync(file), false)
    saveWeixinAccount(file, { botToken: 'tk', botId: 'wx_1', userId: null })
    const written = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(written.botToken, 'tk')
    assert.equal(written.enabled, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 全流程（假 iLink 服务器）──────────────────────────────────

async function startFakeLoginServer({ qrStatusSeq = ['wait', 'scaned', 'confirmed'] } = {}) {
  const requests = []
  let poll = 0
  const server = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      requests.push(req.url)
      const reply = (payload) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (String(req.url).includes('get_bot_qrcode')) {
        return reply({ qrcode: 'QR-1', qrcode_img_content: 'https://weixin.qq.com/q/QR-1' })
      }
      if (String(req.url).includes('get_qrcode_status')) {
        const status = qrStatusSeq[Math.min(poll, qrStatusSeq.length - 1)]
        poll += 1
        if (status === 'confirmed') {
          return reply({
            status, bot_token: 'tk-live-1', ilink_bot_id: 'wx_bot_1',
            baseurl: 'https://ilinkai.weixin.qq.com/', ilink_user_id: 'owner@im.wechat',
          })
        }
        return reply({ status })
      }
      return reply({})
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    async close() { await new Promise((resolve) => server.close(resolve)) },
  }
}

test('全流程: 轮询到 confirmed → 拿到凭据；跳过的状态不误判', async () => {
  const fake = await startFakeLoginServer()
  try {
    const phases = []
    const result = await waitForQrLogin({
      baseUrl: fake.baseUrl,
      onQr: (info) => phases.push(['qr', info.qrUrl]),
      onStatus: (info) => phases.push(['status', info.kind]),
      pollIntervalMs: 10,
      timeoutMs: 3_000,
    })
    assert.equal(result.ok, true)
    assert.equal(result.token, 'tk-live-1')
    assert.equal(result.botId, 'wx_bot_1')
    assert.equal(result.userId, 'owner@im.wechat')
    assert.deepEqual(phases.filter((p) => p[0] === 'status').map((p) => p[1]), ['pending', 'pending', 'confirmed'])
    // 扫码地址给到回调，供主人扫
    assert.equal(phases[0][1], 'https://weixin.qq.com/q/QR-1')
  } finally {
    await fake.close()
  }
})

test('全流程: 已绑过（binded_redirect）如实返回「无需重复连接」，不当失败', async () => {
  const fake = await startFakeLoginServer({ qrStatusSeq: ['binded_redirect'] })
  try {
    const result = await waitForQrLogin({ baseUrl: fake.baseUrl, pollIntervalMs: 10, timeoutMs: 2_000 })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'already-bound')
    assert.match(result.message, /绑/)
  } finally {
    await fake.close()
  }
})

test('全流程: 一直 wait 到超时 → 明确超时，不假装成功', async () => {
  const fake = await startFakeLoginServer({ qrStatusSeq: ['wait'] })
  try {
    const result = await waitForQrLogin({ baseUrl: fake.baseUrl, pollIntervalMs: 10, timeoutMs: 120 })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'timeout')
  } finally {
    await fake.close()
  }
})

test('全流程: 取二维码失败（HTTP 500）→ 明确失败，不抛裸错', async () => {
  const server = createServer((req, res) => { res.writeHead(500); res.end('boom') })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const result = await waitForQrLogin({ baseUrl: `http://127.0.0.1:${port}`, pollIntervalMs: 10, timeoutMs: 500 })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'qr-failed')
    assert.ok(result.message.length > 0)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

// ── 验证码分支（绑定路上唯一可能卡死的一格）─────────────────────

/** 记下每次轮询的完整 URL，便于断言 verify_code 是否真的回传了。 */
async function startVerifyCodeServer({ statuses = ['need_verifycode', 'confirmed'] } = {}) {
  const urls = []
  let poll = 0
  const server = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      urls.push(req.url)
      const reply = (payload) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (String(req.url).includes('get_bot_qrcode')) {
        return reply({ qrcode: 'QR-V', qrcode_img_content: 'https://weixin.qq.com/q/QR-V' })
      }
      if (String(req.url).includes('get_qrcode_status')) {
        const status = statuses[Math.min(poll, statuses.length - 1)]
        poll += 1
        if (status === 'confirmed') {
          return reply({
            status, bot_token: 'tk-after-code', ilink_bot_id: 'wx_after',
            ilink_user_id: 'owner@im.wechat', baseurl: 'https://ilinkai.weixin.qq.com/',
          })
        }
        return reply({ status })
      }
      return reply({})
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    urls,
    statusPolls: () => urls.filter((u) => u.includes('get_qrcode_status')),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('验证码: 拿到主人输入的码 → 带 verify_code 重投 → 最终绑定成功', async () => {
  const fake = await startVerifyCodeServer()
  try {
    const asked = []
    const result = await waitForQrLogin({
      baseUrl: fake.baseUrl,
      pollIntervalMs: 10,
      timeoutMs: 3_000,
      onVerifyCode: async ({ attempt, message }) => {
        asked.push({ attempt, message })
        return '  482913  '   // 主人手输，可能带空格
      },
    })
    assert.equal(result.ok, true)
    assert.equal(result.token, 'tk-after-code')
    assert.equal(asked.length, 1)
    assert.equal(asked[0].attempt, 1)
    // 第二次轮询必须带上验证码（且已裁剪空白）
    const polls = fake.statusPolls()
    assert.equal(polls.length >= 2, true)
    assert.equal(polls[0].includes('verify_code'), false, '第一次不该带码')
    assert.match(polls[1], /verify_code=482913/)
  } finally {
    await fake.close()
  }
})

test('验证码: 没有输入通道（未接线）→ 如实返回 need-verifycode，不当成功', async () => {
  const fake = await startVerifyCodeServer()
  try {
    const result = await waitForQrLogin({ baseUrl: fake.baseUrl, pollIntervalMs: 10, timeoutMs: 1_000 })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'need-verifycode')
    assert.match(result.message, /没有提供输入通道/)
  } finally {
    await fake.close()
  }
})

test('验证码: 主人什么都没输 → 明确收场（不空转到超时）', async () => {
  const fake = await startVerifyCodeServer()
  try {
    const result = await waitForQrLogin({
      baseUrl: fake.baseUrl,
      pollIntervalMs: 10,
      timeoutMs: 1_000,
      onVerifyCode: async () => '   ',
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'need-verifycode')
    assert.match(result.message, /没有输入/)
  } finally {
    await fake.close()
  }
})

test('验证码: 一直要码 → 尝试次数用尽后收场（不无限索要）', async () => {
  const fake = await startVerifyCodeServer({ statuses: ['need_verifycode'] })
  try {
    let asked = 0
    const result = await waitForQrLogin({
      baseUrl: fake.baseUrl,
      pollIntervalMs: 10,
      timeoutMs: 3_000,
      verifyCodeAttempts: 2,
      onVerifyCode: async () => { asked += 1; return '111111' },
    })
    assert.equal(result.ok, false)
    assert.match(result.message, /2 次/)
    assert.equal(asked, 2, `只该问 2 次，实得 ${asked} 次`)
  } finally {
    await fake.close()
  }
})

/**
 * 微信绑定（agent 驱动那条路）回归测试。
 *
 * 这一层的意义：主人只在天枢会话里说一句话，剩下的由 agent 调工具完成。
 * 所以用例要钉住三件事：
 * 1. 二维码图片真的落到桌面（桌面不可用时如实回退并说明，不静默失败）。
 * 2. 绑定成功后配置里**自动**带上 ownerUserId —— 否则通道「连上但静默不响应」，主人会以为坏了。
 * 3. 失败/超时/已绑过都写进状态文件，对话侧读得到原因（不许只有沉默）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderQrPngBytes } from '../lib/weixin/qr.mjs'
import { resolveDesktopDir, writeQrImage } from '../lib/weixin/paths.mjs'
import { emptyBindStatus, readBindStatus, runBind, writeBindStatus } from '../lib/weixin/binder.mjs'

/** 造一个假桌面目录。 */
function makeFakeDesktop() {
  const root = mkdtempSync(join(tmpdir(), 'wx-desk-'))
  const desktop = join(root, 'Desktop')
  mkdirSync(desktop, { recursive: true })
  return { root, desktop, env: { USERPROFILE: root } }
}

test('resolveDesktopDir: 优先 USERPROFILE\\Desktop，其次 OneDrive\\Desktop', () => {
  const a = makeFakeDesktop()
  const b = mkdtempSync(join(tmpdir(), 'wx-one-'))
  const oneDesktop = join(b, 'OneDrive', 'Desktop')
  mkdirSync(oneDesktop, { recursive: true })
  try {
    assert.equal(resolveDesktopDir(a.env), a.desktop)
    // 没有 Desktop 但有 OneDrive\Desktop → 用后者
    assert.equal(resolveDesktopDir({ USERPROFILE: b }), oneDesktop)
    // 两边都没有 → null（不猜、不硬编码）
    assert.equal(resolveDesktopDir({ USERPROFILE: join(b, 'nope') }), null)
    assert.equal(resolveDesktopDir({}), null)
  } finally {
    rmSync(a.root, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  }
})

test('resolveDesktopDir: 认 XDG_DESKTOP_DIR 与 HOME（非 Windows 形态）', () => {
  const root = mkdtempSync(join(tmpdir(), 'wx-xdg-'))
  const xdg = join(root, '桌面')
  mkdirSync(xdg, { recursive: true })
  try {
    assert.equal(resolveDesktopDir({ XDG_DESKTOP_DIR: xdg }), xdg)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('writeQrImage: 桌面可用 → 落桌面并标记 onDesktop', () => {
  const a = makeFakeDesktop()
  const fallback = mkdtempSync(join(tmpdir(), 'wx-fb-'))
  try {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const placed = writeQrImage(bytes, { env: a.env, fileName: '码.png', fallbackDir: fallback })
    assert.equal(placed.onDesktop, true)
    assert.equal(placed.note, null)
    assert.equal(placed.path, join(a.desktop, '码.png'))
    assert.deepEqual([...readFileSync(placed.path).slice(0, 4)], [0x89, 0x50, 0x4e, 0x47])
  } finally {
    rmSync(a.root, { recursive: true, force: true })
    rmSync(fallback, { recursive: true, force: true })
  }
})

test('writeQrImage: 桌面不可用 → 回退到数据目录，并给出说明（不静默）', () => {
  const fallback = mkdtempSync(join(tmpdir(), 'wx-fb-'))
  try {
    const placed = writeQrImage(Buffer.from('x'), {
      env: { USERPROFILE: join(fallback, '没有这个目录') },
      fileName: '码.png',
      fallbackDir: fallback,
    })
    assert.equal(placed.onDesktop, false)
    assert.equal(placed.path, join(fallback, '码.png'))
    assert.match(placed.note, /桌面/)
    assert.equal(existsSync(placed.path), true)
  } finally {
    rmSync(fallback, { recursive: true, force: true })
  }
})

test('renderQrPngBytes: 有库出字节、无库如实报错（不抛）', async () => {
  const ok = await renderQrPngBytes('https://weixin.qq.com/q/X', {
    libs: { qrcode: { toBuffer: async (url, opts) => Buffer.from(`png:${url}:${opts.margin}`) } },
  })
  assert.equal(ok.error, null)
  assert.match(ok.bytes.toString(), /png:https:\/\/weixin\.qq\.com\/q\/X:4/)

  const boom = await renderQrPngBytes('https://weixin.qq.com/q/X', {
    libs: { qrcode: { toBuffer: async () => { throw new Error('编码失败') } } },
  })
  assert.equal(boom.bytes, null)
  assert.match(boom.error, /编码失败/)

  const none = await renderQrPngBytes('https://weixin.qq.com/q/X', { libs: { qrcode: null } })
  assert.equal(none.bytes, null)
  assert.match(none.error, /qrcode/)
})

test('状态文件: 缺失/损坏都退回空状态；写入是增量合并', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wx-st-'))
  const file = join(dir, 'status.json')
  try {
    assert.deepEqual(readBindStatus(file), emptyBindStatus())
    writeFileSync(file, '{ 坏 JSON')
    assert.deepEqual(readBindStatus(file), emptyBindStatus())
    writeBindStatus(file, { state: 'running', step: '等着' })
    writeBindStatus(file, { qrPath: 'D:/x.png' })
    const merged = readBindStatus(file)
    assert.equal(merged.state, 'running', '后写的字段不该抹掉先写的')
    assert.equal(merged.qrPath, 'D:/x.png')
    assert.ok(merged.updatedAt)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── runBind 全流程（假 iLink 服务器 + 替身渲染器，全程不碰真账号）──

async function startFakeQrServer({ status = 'confirmed' } = {}) {
  const server = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      const reply = (payload) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      const url = String(req.url)
      if (url.includes('get_bot_qrcode')) {
        return reply({ qrcode: 'QR-B', qrcode_img_content: 'https://weixin.qq.com/q/QR-B' })
      }
      if (url.includes('get_qrcode_status')) {
        if (status === 'confirmed') {
          return reply({
            status, bot_token: 'tk-bind-abcdef', ilink_bot_id: 'wx_bind_1',
            ilink_user_id: 'owner-bind@im.wechat', baseurl: 'https://ilinkai.weixin.qq.com/',
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
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

const stubLibs = { qrcode: { toBuffer: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]) } }

test('runBind: 成功路径 —— 二维码落桌面、凭据与 ownerUserId 都写进配置、状态为 success', async () => {
  const fake = await startFakeQrServer()
  const desk = makeFakeDesktop()
  const dataDir = mkdtempSync(join(tmpdir(), 'wx-bind-data-'))
  const configFile = join(dataDir, 'weixin.json')
  const statusFile = join(dataDir, 'weixin-bind-status.json')
  try {
    const final = await runBind({
      configFile,
      dataDir,
      baseUrl: fake.baseUrl,
      statusFile,
      env: desk.env,
      timeoutMs: 3_000,
      libs: stubLibs,
    })

    assert.equal(final.state, 'success')
    assert.equal(final.botId, 'wx_bind_1')
    assert.equal(final.ownerFilled, true, 'ownerUserId 必须自动填上')

    // 二维码确实落到了桌面
    assert.equal(final.qrOnDesktop, true)
    assert.equal(existsSync(final.qrPath), true)
    assert.match(final.qrPath, /Desktop/)

    // 配置里 token 与 owner 都在
    const config = JSON.parse(readFileSync(configFile, 'utf8'))
    assert.equal(config.botToken, 'tk-bind-abcdef')
    assert.equal(config.ownerUserId, 'owner-bind@im.wechat')

    // 状态文件落盘且可被对话侧读回
    const status = readBindStatus(statusFile)
    assert.equal(status.state, 'success')
    assert.equal(status.qrPath, final.qrPath)
    assert.ok(status.finishedAt)
  } finally {
    await fake.close()
    rmSync(desk.root, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('runBind: 桌面不可用 → 二维码落回数据目录，状态里说明原因', async () => {
  const fake = await startFakeQrServer()
  const dataDir = mkdtempSync(join(tmpdir(), 'wx-bind-data-'))
  try {
    const final = await runBind({
      configFile: join(dataDir, 'weixin.json'),
      dataDir,
      baseUrl: fake.baseUrl,
      statusFile: join(dataDir, 's.json'),
      env: { USERPROFILE: join(dataDir, '没有桌面') },
      timeoutMs: 3_000,
      libs: stubLibs,
    })
    assert.equal(final.state, 'success')
    assert.equal(final.qrOnDesktop, false)
    assert.equal(final.qrPath, join(dataDir, '天枢-微信扫码.png'))
    assert.match(final.qrNote, /桌面/)
  } finally {
    await fake.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('runBind: 服务端说已绑过 → 状态 already-bound，不写凭据', async () => {
  const fake = await startFakeQrServer({ status: 'binded_redirect' })
  const dataDir = mkdtempSync(join(tmpdir(), 'wx-bind-data-'))
  const configFile = join(dataDir, 'weixin.json')
  try {
    const final = await runBind({
      configFile,
      dataDir,
      baseUrl: fake.baseUrl,
      statusFile: join(dataDir, 's.json'),
      env: {},
      timeoutMs: 2_000,
      libs: stubLibs,
    })
    assert.equal(final.state, 'already-bound')
    assert.equal(existsSync(configFile), false, '没绑成就不该写出配置')
  } finally {
    await fake.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('runBind: 一直等不到扫码 → 状态 timeout，带可读原因', async () => {
  const fake = await startFakeQrServer({ status: 'wait' })
  const dataDir = mkdtempSync(join(tmpdir(), 'wx-bind-data-'))
  try {
    const final = await runBind({
      configFile: join(dataDir, 'weixin.json'),
      dataDir,
      baseUrl: fake.baseUrl,
      statusFile: join(dataDir, 's.json'),
      env: {},
      timeoutMs: 150,
      libs: stubLibs,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20))),
    })
    assert.equal(final.state, 'timeout')
    assert.match(final.message ?? '', /超时/)
  } finally {
    await fake.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('runBind: 服务端不可用 → 状态 failed 且写进状态文件（对话侧不会只看到沉默）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wx-bind-data-'))
  const statusFile = join(dataDir, 's.json')
  try {
    const final = await runBind({
      configFile: join(dataDir, 'weixin.json'),
      dataDir,
      baseUrl: 'http://127.0.0.1:1',
      statusFile,
      env: {},
      timeoutMs: 1_000,
      libs: stubLibs,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20))),
    })
    assert.equal(final.state, 'failed')
    assert.equal(readBindStatus(statusFile).state, 'failed')
    assert.ok(final.message)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('runBind: 不带 statusFile（CLI 收尾契约）——成功与超时都返回状态对象，不许 null', async () => {
  // 真机事故：CLI 场景不带 statusFile，超时收尾时 writeBindStatus 返回 null，
  // CLI 读 final.qrPath 当场崩成「绑定流程异常」——超时/成功这些真实结果被吞掉。
  const desk = makeFakeDesktop()
  const dataDir = mkdtempSync(join(tmpdir(), 'wx-bind-data-'))
  try {
    // 超时路径
    const stuck = await startFakeQrServer({ status: 'wait' })
    try {
      const timedOut = await runBind({
        configFile: join(dataDir, 'weixin.json'),
        dataDir,
        baseUrl: stuck.baseUrl,
        env: desk.env,
        timeoutMs: 150,
        libs: stubLibs,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20))),
      })
      assert.ok(timedOut && typeof timedOut === 'object', '超时收尾必须返回对象')
      assert.equal(timedOut.state, 'timeout')
      assert.match(timedOut.message ?? '', /超时/)
    } finally {
      await stuck.close()
    }

    // 成功路径
    const ok = await startFakeQrServer()
    try {
      const succeeded = await runBind({
        configFile: join(dataDir, 'weixin-ok.json'),
        dataDir,
        baseUrl: ok.baseUrl,
        env: desk.env,
        timeoutMs: 3_000,
        libs: stubLibs,
      })
      assert.ok(succeeded && typeof succeeded === 'object', '成功收尾必须返回对象')
      assert.equal(succeeded.state, 'success')
      assert.equal(succeeded.ownerFilled, true)
    } finally {
      await ok.close()
    }
  } finally {
    rmSync(desk.root, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('入口: 两个绑定工具已注册且可调用（无配置的真机环境也不炸）', async () => {
  const emptyHome = mkdtempSync(join(tmpdir(), 'wx-home-'))
  const prevRivet = process.env.RIVET_HOME
  try {
    process.env.RIVET_HOME = emptyHome
    const mod = await import(`../impl.js?entry=${Date.now()}`)
    const names = mod.tools.map((t) => t.definition.name)
    assert.ok(names.includes('weixin_bind_start'), `工具清单缺 weixin_bind_start：${names.join(',')}`)
    assert.ok(names.includes('weixin_bind_status'), `工具清单缺 weixin_bind_status：${names.join(',')}`)

    const statusTool = mod.tools.find((t) => t.definition.name === 'weixin_bind_status')
    const result = await statusTool.execute({})
    assert.equal(result.isError, undefined)
    const parsed = JSON.parse(result.content)
    assert.equal(parsed.state, 'idle')
    assert.match(parsed.next, /绑定/)
  } finally {
    if (prevRivet === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevRivet
    rmSync(emptyHome, { recursive: true, force: true })
  }
})

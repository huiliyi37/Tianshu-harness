/**
 * 微信绑定：二维码以图片形式回传给对话（宿主渲染工具结果的 `images`）。
 *
 * 背景（2026-11-08）：绑定二维码原本只落成桌面图片文件，用户得自己去桌面翻。
 * 官方 design 插件的 ui_preview 证明工具返回值支持 `images`（data URL 数组），
 * 宿主会把它们渲染在对话里。本文件钉住「有图就带、没图不报错」这条契约。
 *
 * 环境隔离：必须在导入 impl.js 之前设置 RIVET_HOME，并清空微信环境变量
 * （与 plugin-entry.test.mjs 同一手法）。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'imbridge-qrimg-'))
const dataDir = join(home, 'imbridge')
mkdirSync(dataDir, { recursive: true })
process.env.RIVET_HOME = home
delete process.env.TIANSHU_IM_WEIXIN_TOKEN
delete process.env.TIANSHU_IM_WEIXIN_OWNER

// 1x1 透明 PNG —— 只要字节是合法 PNG，渲染函数不关心内容
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const QR_PATH = join(dataDir, 'qr.png')
writeFileSync(QR_PATH, PNG_BYTES)
const STATUS_FILE = join(dataDir, 'weixin-bind-status.json')

// 跑完收摊：临时 HOME 是本次运行的产物，别留在盘上（历史上这类残留攒了十几个）。
after(() => { rmSync(home, { recursive: true, force: true }) })

/** 按 emptyBindStatus 的形状写状态文件（lib/weixin/binder.mjs:23-40）。 */
function writeStatus(patch) {
  writeFileSync(STATUS_FILE, JSON.stringify({
    state: 'idle',
    startedAt: null,
    updatedAt: null,
    qrPath: null,
    qrOnDesktop: null,
    qrNote: null,
    qrUrl: null,
    step: null,
    botId: null,
    userId: null,
    ownerFilled: false,
    reason: null,
    message: null,
    finishedAt: null,
    ...patch,
  }))
}

const { tools } = await import('../impl.js')

function tool(name) {
  const found = tools.find((t) => t.definition.name === name)
  assert.ok(found, `tools 里应有 ${name}`)
  return found
}

const parse = (res) => JSON.parse(res.content)

test('绑定启动（进行中复用）：二维码有图时返回 images', async () => {
  writeStatus({ state: 'running', updatedAt: new Date().toISOString(), qrPath: QR_PATH })
  const res = await tool('weixin_bind_start').execute()

  const payload = parse(res)
  assert.equal(payload.alreadyRunning, true, '应走复用分支，不重新拉起后台进程')
  assert.ok(Array.isArray(res.images), '应带 images 字段')
  assert.equal(res.images.length, 1)
  assert.match(res.images[0], /^data:image\/png;base64,/, '应是 data URL')
  assert.ok(res.images[0].length > 100, '应含真实图片字节')
})

test('绑定状态：running 且二维码还在 → 带图', async () => {
  writeStatus({ state: 'running', updatedAt: new Date().toISOString(), qrPath: QR_PATH })
  const res = await tool('weixin_bind_status').execute()

  assert.ok(Array.isArray(res.images), 'running 时应带回二维码')
  assert.match(res.images[0], /^data:image\/png;base64,/)
})

test('绑定状态：success 不带图（已绑完，二维码无意义）', async () => {
  writeStatus({ state: 'success', qrPath: QR_PATH, botId: 'bot@im.bot' })
  const res = await tool('weixin_bind_status').execute()

  assert.equal(res.images, undefined)
  assert.equal(parse(res).state, 'success', '既有字段不受影响')
})

test('二维码文件不存在：不抛错、不返回 images（降级为现状）', async () => {
  writeStatus({ state: 'running', updatedAt: new Date().toISOString(), qrPath: join(dataDir, 'nope.png') })
  const res = await tool('weixin_bind_status').execute()

  assert.equal(res.images, undefined)
  assert.equal(parse(res).state, 'running')
  assert.equal(res.isError, undefined, '读图失败不能让整个工具报错')
})

test('qrPath 为空：不返回 images', async () => {
  writeStatus({ state: 'running', updatedAt: new Date().toISOString(), qrPath: null })
  const res = await tool('weixin_bind_status').execute()

  assert.equal(res.images, undefined)
})

test('回归：绑定状态既有字段一个不少', async () => {
  writeStatus({ state: 'running', updatedAt: new Date().toISOString(), qrPath: QR_PATH, step: '等待扫码…' })
  const payload = parse(await tool('weixin_bind_status').execute())

  for (const key of [
    'state', 'step', 'qrPath', 'qrOnDesktop', 'qrNote', 'qrUrl',
    'botId', 'userId', 'ownerFilled', 'reason', 'message', 'updatedAt',
    'channelConfigured', 'maskedToken', 'next',
  ]) {
    assert.ok(key in payload, `缺少既有字段 ${key}`)
  }
})

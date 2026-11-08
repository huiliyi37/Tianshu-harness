/**
 * 二维码渲染回归测试。
 *
 * 这一层最容易出的错是「渲染失败把整条绑定流程带崩」——所以用例的重点是
 * **失败降级**：没库、库报错、路径不可写，都必须只反映在返回值里，绝不抛。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultQrLibRoots, loadQrLibs, renderQr } from '../lib/weixin/qr.mjs'

const QR_URL = 'https://weixin.qq.com/q/TEST-QR'

test('defaultQrLibRoots: 探测顺序含 DSH 侧目录与 npm 全局，且不含空值', () => {
  const roots = defaultQrLibRoots({ USERPROFILE: 'C:\\Users\\x', APPDATA: 'C:\\Users\\x\\AppData\\Roaming' })
  assert.ok(roots.length >= 2)
  assert.equal(roots.every((r) => typeof r === 'string' && r.length > 0), true)
  assert.equal(roots.some((r) => r.includes('.dsh')), true)
  assert.equal(roots.includes(''), false)
  // 显式覆盖优先
  assert.equal(defaultQrLibRoots({ TIANSHU_WEIXIN_QR_LIB: 'D:/libs' })[0], 'D:/libs')
})

test('loadQrLibs: 从给定目录里找出两个库；缺失的不报错', () => {
  const fakeRequire = (spec) => {
    if (spec.includes('qrcode-terminal')) return { generate: () => {} }
    if (spec.endsWith('qrcode') || spec.includes('qrcode')) return { toFile: () => {} }
    throw new Error('MODULE_NOT_FOUND')
  }
  const both = loadQrLibs({ roots: ['D:/libs'], requireImpl: fakeRequire })
  assert.ok(both.qrcode)
  assert.ok(both.qrTerminal)

  const none = loadQrLibs({
    roots: ['D:/empty'],
    requireImpl: () => { throw new Error('MODULE_NOT_FOUND') },
  })
  assert.equal(none.qrcode, null)
  assert.equal(none.qrTerminal, null)
})

test('renderQr: 没有库时如实报告原因，且不抛错', async () => {
  const result = await renderQr(QR_URL, { libs: { qrcode: null, qrTerminal: null }, pngPath: null })
  assert.equal(result.pngPath, null)
  assert.match(result.pngError, /图片路径/)          // 没给路径时原因是「没给路径」
  assert.equal(result.terminalRendered, false)
  assert.match(result.terminalError, /qrcode-terminal/)
})

test('renderQr: 没给图片路径但有库时，图片缺失的原因也要说清（不是留空）', async () => {
  const result = await renderQr(QR_URL, {
    pngPath: null,
    libs: { qrcode: { toFile: async () => {} }, qrTerminal: null },
  })
  assert.equal(result.pngPath, null)
  assert.ok(result.pngError, '没落图片就必须给出原因')
})

test('回归: 不传 onTerminalText 时终端渲染照做（可选调用不许短路 await）', async () => {
  // 曾经的写法 `onTerminalText?.(await new Promise(...))` 会在回调缺失时把整段短路掉：
  // 渲染没执行，连渲染抛错都被静默吞掉。这条用例钉死这个行为。
  let generated = 0
  const ok = await renderQr(QR_URL, {
    pngPath: null,
    libs: { qrcode: null, qrTerminal: { generate: (u, o, cb) => { generated += 1; cb('██\n') } } },
  })
  assert.equal(generated, 1, '没传回调也必须真的调用渲染器')
  assert.equal(ok.terminalRendered, true)

  // 反向：渲染器抛错时，即使没传回调也必须记录错误
  const failed = await renderQr(QR_URL, {
    pngPath: null,
    libs: { qrcode: null, qrTerminal: { generate: () => { throw new Error('画不出来') } } },
  })
  assert.equal(failed.terminalRendered, false)
  assert.match(failed.terminalError, /画不出来/)
})

test('renderQr: 库抛错时只记录，不冒泡（绑定流程必须能继续）', async () => {
  const result = await renderQr(QR_URL, {
    pngPath: 'D:/nonexistent-dir/x.png',
    libs: {
      qrcode: { toFile: async () => { throw new Error('EACCES: 没有写权限') } },
      qrTerminal: { generate: () => { throw new Error('终端画不出来') } },
    },
  })
  assert.equal(result.pngPath, null)
  assert.match(result.pngError, /EACCES/)
  assert.equal(result.terminalRendered, false)
  assert.match(result.terminalError, /终端画不出来/)
})

test('renderQr: 正常路径 —— 真写一个 PNG 出来（用替身渲染器，避免测试依赖宿主库）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qr-'))
  const pngPath = join(dir, 'weixin-qr.png')
  const calls = { png: [], terminal: [] }
  try {
    const result = await renderQr(QR_URL, {
      pngPath,
      libs: {
        qrcode: {
          toFile: async (file, text, opts) => {
            calls.png.push({ file, text, opts })
            const { writeFileSync } = await import('node:fs')
            // 写一个最小的合法 PNG 头，供断言「文件确实落地」
            writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
          },
        },
        qrTerminal: {
          generate: (url, opts, cb) => {
            calls.terminal.push({ url, opts })
            cb('█▀▀█\n█  █\n▀▀▀▀\n')
          },
        },
      },
      onTerminalText: (art) => calls.terminal.push({ art }),
    })

    assert.equal(result.pngPath, pngPath)
    assert.equal(result.pngError, null)
    assert.equal(result.terminalRendered, true)
    // 渲染参数：纯黑白、留白 4、纠错 M（手机扫图片的稳妥参数）
    assert.equal(calls.png[0].text, QR_URL)
    assert.equal(calls.png[0].opts.margin, 4)
    assert.equal(calls.png[0].opts.errorCorrectionLevel, 'M')
    assert.equal(calls.png[0].opts.width >= 256, true)
    // 终端图文本被回调取走
    assert.equal(calls.terminal.some((c) => typeof c.art === 'string' && c.art.includes('█')), true)
    // 文件真的落地了（PNG 魔数）
    const bytes = readFileSync(pngPath)
    assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadQrLibs: 插件自带的 node_modules 里的库能被找到（不依赖用户机器碰巧装过 DSH）', () => {
  // 2026-11-08 真机故障：二维码渲染一直报「本机没有可用的 qrcode 库」。
  // 根因不是没装库，而是探测列表只认 DSH 侧目录 / npm 全局，**不含插件自己**。
  // 这条用例钉住：库装在本插件 node_modules 里时，裸解析必须命中。
  const libs = loadQrLibs()
  assert.ok(libs.qrcode, '插件自带 qrcode 时 loadQrLibs() 必须找得到')
  assert.equal(typeof libs.qrcode.toBuffer, 'function', '拿到的必须是真的 qrcode（有 toBuffer）')
})

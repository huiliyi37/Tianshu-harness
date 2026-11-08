/**
 * 二维码渲染（把扫码链接变成主人手机能扫的东西）。
 *
 * 为什么要单独一层：它对「入口顶层保持轻量」那条红线其实是威胁——二维码库是重依赖。
 * 所以这里只做两件事：**尽力而为地加载**（找不到就退化成打印链接）＋**绝不因为渲染失败
 * 而中断绑定流程**。扫码链接本身才是关键数据，图片只是给人看的。
 *
 * 不引入新依赖：库从本机已有位置探测（DSH 侧装了 qrcode 与 qrcode-terminal），
 * 探测失败也不影响绑定成功与否。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'

/** 本机可能装着二维码库的位置（按可能性排序）。 */
export function defaultQrLibRoots(env = process.env) {
  return [
    env.TIANSHU_WEIXIN_QR_LIB,
    join(env.USERPROFILE ?? '', '.dsh', 'profiles', 'web', 'node_modules'),
    join(env.HOME ?? '', '.dsh', 'profiles', 'web', 'node_modules'),
    join(env.APPDATA ?? '', 'npm', 'node_modules'),
    // POSIX 常见 npm 全局位置（Linux / macOS）——本机装过 qrcode 才有用，缺失零成本
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
    '/opt/homebrew/lib/node_modules',
  ].filter((value) => typeof value === 'string' && value.length > 0)
}

function tryRequire(require, root, name) {
  try {
    return require(join(root, name))
  } catch {
    return null
  }
}

/**
 * 探测二维码相关库。
 * @returns {{qrcode: object|null, qrTerminal: object|null, roots: string[]}}
 */
export function loadQrLibs({ roots, requireImpl } = {}) {
  const require = requireImpl ?? createRequire(import.meta.url)
  let qrcode = null
  let qrTerminal = null

  // 先裸解析：库就装在本插件自己的 node_modules 里（package.json 已声明），
  // 走模块解析是最可靠的一条路。历史教训（2026-11-08）：探测列表原先只认
  // DSH 侧目录与 npm 全局，用户卸载 DSH 后二维码直接渲染不出来——插件自带的
  // 依赖不该指望宿主机上碰巧装着别的东西。
  try { qrcode = require('qrcode') } catch { /* 没装就继续按目录探测 */ }
  try { qrTerminal = require('qrcode-terminal') } catch { /* 终端图是可选能力 */ }

  const list = roots ?? defaultQrLibRoots()
  for (const root of list) {
    if (!qrcode) qrcode = tryRequire(require, root, 'qrcode')
    if (!qrTerminal) qrTerminal = tryRequire(require, root, 'qrcode-terminal')
    if (qrcode && qrTerminal) break
  }
  return { qrcode, qrTerminal, roots: list }
}

/**
 * 把扫码链接渲染成 PNG 与终端图。
 * 两个动作各自尽力而为：任何一个失败都只记在返回值里，不抛。
 *
 * @param {string} url 扫码链接（必须已被 login.mjs 校验过是 https + 微信官方域）
 * @param {{pngPath?:string|null, libs?:object, onTerminalText?:Function}} options
 * @returns {Promise<{pngPath:string|null, pngError:string|null, terminalRendered:boolean, terminalError:string|null}>}
 */
export async function renderQr(url, { pngPath = null, libs, onTerminalText } = {}) {
  const { qrcode, qrTerminal } = libs ?? loadQrLibs()
  const result = { pngPath: null, pngError: null, terminalRendered: false, terminalError: null }

  if (!pngPath) {
    result.pngError = '没有指定二维码图片路径'
  } else if (!qrcode?.toFile) {
    result.pngError = '本机没有可用的 qrcode 库'
  } else {
    try {
      // 纯黑白、留白 4 模块、纠错 M：手机扫屏幕/图片的稳妥参数
      await qrcode.toFile(pngPath, url, { width: 512, margin: 4, errorCorrectionLevel: 'M' })
      result.pngPath = pngPath
      result.pngError = null
    } catch (error) {
      result.pngError = error?.message ?? String(error)
    }
  }

  if (qrTerminal?.generate) {
    try {
      // 注意：必须先 await 出结果，再条件调用回调。
      // 写成 `onTerminalText?.(await new Promise(...))` 会踩一个隐蔽的坑——
      // 可选调用 `?.()` 在接收者为空时**连参数里的 await 一起短路**：
      // 于是「没传回调」就等于「跳过了整段终端渲染」，连渲染抛错都被静默吞掉。
      const art = await new Promise((resolve) => {
        qrTerminal.generate(url, { small: true }, (generated) => resolve(String(generated ?? '')))
      })
      if (typeof onTerminalText === 'function') onTerminalText(art)
      result.terminalRendered = true
    } catch (error) {
      result.terminalError = error?.message ?? String(error)
    }
  } else {
    result.terminalError = '本机没有可用的 qrcode-terminal 库'
  }

  return result
}

/**
 * 渲染成 PNG 字节（不落盘）。绑定器用它拿到图之后自行决定放哪儿（桌面 / 回退目录）。
 * 拿不到字节时返回 { bytes:null, error }，绝不抛。
 */
export async function renderQrPngBytes(url, { libs, width = 512, margin = 4, errorCorrectionLevel = 'M' } = {}) {
  const { qrcode } = libs ?? loadQrLibs()
  if (!qrcode?.toBuffer) return { bytes: null, error: '本机没有可用的 qrcode 库' }
  try {
    const bytes = await qrcode.toBuffer(url, { width, margin, errorCorrectionLevel, type: 'png' })
    return { bytes, error: null }
  } catch (error) {
    return { bytes: null, error: error?.message ?? String(error) }
  }
}

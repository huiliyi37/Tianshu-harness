/**
 * clipboard-image.ts RED tests.
 *
 * Wave 1 — 先写失败用例形成契约，再写实现（GREEN）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'

// ── RED #1: 模块尚不存在，import 会失败（测试框架报错 = RED） ──
// 此 import 在 clipboard-image.ts 创建前会抛 MODULE_NOT_FOUND。
// 创建模块后：至少导出 readImageFromClipboard, tryNativeClipboard, tryShellClipboard,
// ClipboardImage, ClipboardReader。

// 1x1 transparent PNG (valid)
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`

// We'll import after the module exists. For now this file documents the contract.

test('RED #1: readImageFromClipboard returns ClipboardImage when native reader succeeds', async () => {
  // 契约：传入 mock reader 返回固定 dataUrl → 函数应返回该 ClipboardImage
  // 此测试在模块不存在时必定失败（import error = RED）。
  // 模块创建后：通过 setClipboardReader 注入 mock → 验证返回结构。
  const mod = await import('../clipboard-image.js')
  const { setClipboardReader, readImageFromClipboard } = mod

  setClipboardReader({
    async readImage() {
      return {
        dataUrl: PNG_DATA_URL,
        mime: 'image/png',
        name: 'clipboard.png',
        source: 'png' as const,
      }
    },
  })

  const result = await readImageFromClipboard()
  assert.ok(result, 'expected non-null result when reader returns image')
  assert.equal(result!.dataUrl, PNG_DATA_URL)
  assert.equal(result!.mime, 'image/png')
  assert.equal(result!.name, 'clipboard.png')
  assert.equal(result!.source, 'png')

  // 清理
  setClipboardReader(null)
})

test('RED #2: readImageFromClipboard returns null when clipboard has no image → caller must fallback to text', async () => {
  const mod = await import('../clipboard-image.js')
  const { setClipboardReader, readImageFromClipboard } = mod

  setClipboardReader({
    async readImage() {
      return null // 剪贴板里是文本，没有图片
    },
  })

  const result = await readImageFromClipboard()
  assert.equal(result, null)

  setClipboardReader(null)
})

test('RED #3: readImageFromClipboard returns null when reader throws → no crash, caller falls back to text', async () => {
  const mod = await import('../clipboard-image.js')
  const { setClipboardReader, readImageFromClipboard } = mod

  setClipboardReader({
    async readImage() {
      throw new Error('osascript missing')
    },
  })

  // 不应 throw；应静默返回 null（调用方走文本 fallback）
  const result = await readImageFromClipboard()
  assert.equal(result, null)

  setClipboardReader(null)
})

test('RED #4: tryShellClipboard returns null when no shell tools available', async () => {
  const mod = await import('../clipboard-image.js')
  const { tryShellClipboard } = mod

  // 覆盖 shell 命令路径使其全部失败 → 应返回 null
  const result = await tryShellClipboard({
    execFile: async (_bin: string, _args: string[]) => {
      throw new Error('command not found')
    },
    platform: 'linux',
    tmpdir: '/tmp',
    randomUUID: () => 'test-uuid',
  } as any)
  assert.equal(result, null)
})

test('RED #5: macOS 单次 osascript 嵌套 coercion（PNGf 命中）→ PNG dataUrl', async () => {
  const mod = await import('../clipboard-image.js')
  const { tryShellClipboard } = mod

  const pngBuf = Buffer.from(PNG_B64, 'base64')
  const osascriptCalls: string[][] = []
  const execFile = async (bin: string, args: string[]) => {
    if (bin === 'osascript') {
      osascriptCalls.push(args)
      // 嵌套 try 脚本：PNGf 命中后回显类名
      return { stdout: 'PNGf' }
    }
    throw new Error(`unexpected exec: ${bin} ${args.join(' ')}`)
  }
  const readFile = async (p: string) => {
    assert.ok(p.endsWith('.png'), `expected .png temp path, got ${p}`)
    return pngBuf
  }

  const result = await tryShellClipboard({
    execFile,
    platform: 'darwin',
    readFile,
    tmpdir: '/tmp',
    randomUUID: () => 'test-uuid',
  } as any)
  assert.ok(result, 'expected non-null on macOS with osascript')
  assert.ok(result!.dataUrl.startsWith('data:image/png;base64,'))
  assert.equal(result!.mime, 'image/png')
  assert.equal(result!.source, 'png')
  // 契约：clipboard info + write 两次 spawn 合并为一次嵌套脚本
  assert.equal(osascriptCalls.length, 1, 'macOS 读图应只 spawn 一次 osascript')
  const script = osascriptCalls[0]?.[1] ?? ''
  assert.ok(script.includes('PNGf'), '脚本应含 PNGf coercion（«class PNG» 是语法错误，不能用）')
})

test('RED #6: JPEG picture 剪贴板（clipboard info 文本判定漏掉的类型）→ JPEG dataUrl', async () => {
  const mod = await import('../clipboard-image.js')
  const { tryShellClipboard } = mod

  // 真实 JPEG 文件头（FF D8 FF E0 ... JFIF）
  const jpegBuf = Buffer.from('ffd8ffe000104a46494600010100004800480000', 'hex')
  const execFile = async (bin: string, args: string[]) => {
    if (bin === 'osascript') {
      // PNGf/TIFF coercion 失败后 JPEG 命中
      return { stdout: 'JPEG' }
    }
    throw new Error(`unexpected exec: ${bin} ${args.join(' ')}`)
  }
  const readFile = async (p: string) => {
    assert.ok(p.endsWith('.jpg'), `expected .jpg temp path, got ${p}`)
    return jpegBuf
  }

  const result = await tryShellClipboard({
    execFile,
    platform: 'darwin',
    readFile,
    tmpdir: '/tmp',
    randomUUID: () => 'test-uuid',
  } as any)
  assert.ok(result, 'expected JPEG read to succeed (browser-copied images advertise JPEG picture)')
  assert.ok(result!.dataUrl.startsWith('data:image/jpeg;base64,'))
  assert.equal(result!.mime, 'image/jpeg')
  assert.equal(result!.source, 'jpeg')
})

test('RED #7: 剪贴板无图 → osascript 回显 none → null 且不读文件', async () => {
  const mod = await import('../clipboard-image.js')
  const { tryShellClipboard } = mod

  const readFileCalls: string[] = []
  const execFile = async (bin: string, _args: string[]) => {
    if (bin === 'osascript') return { stdout: 'none' }
    throw new Error(`unexpected exec: ${bin}`)
  }
  const readFile = async (p: string) => {
    readFileCalls.push(p)
    throw new Error('no temp file should be read when clipboard has no image')
  }

  const result = await tryShellClipboard({
    execFile,
    platform: 'darwin',
    readFile,
    tmpdir: '/tmp',
    randomUUID: () => 'test-uuid',
  } as any)
  assert.equal(result, null)
  assert.equal(readFileCalls.length, 0, 'none 回显时不应读任何临时文件')
})

test('RED #8: TIFF 剪贴板 → 单次读回后经 sips 转 PNG', async () => {
  const mod = await import('../clipboard-image.js')
  const { tryShellClipboard } = mod

  const pngBuf = Buffer.from(PNG_B64, 'base64')
  // TIFF little-endian 头（II*\0），长度 ≥8 让 detectImageMime 识别为 image/tiff
  const tiffBuf = Buffer.from('49492a000800000000000000', 'hex')
  let uuidSeq = 0
  const execFile = async (bin: string, args: string[]) => {
    if (bin === 'osascript') return { stdout: 'TIFF' }
    if (bin === 'sips') {
      assert.ok(args.join(' ').includes('format png'), 'sips 应转 PNG')
      return { stdout: '' }
    }
    throw new Error(`unexpected exec: ${bin} ${args.join(' ')}`)
  }
  const readFile = async (p: string) => {
    if (p.endsWith('.tiff')) return tiffBuf
    if (p.endsWith('.png')) return pngBuf // sips 转换输出
    throw new Error(`unexpected readFile: ${p}`)
  }

  const result = await tryShellClipboard({
    execFile,
    platform: 'darwin',
    readFile,
    tmpdir: '/tmp',
    randomUUID: () => `u${++uuidSeq}`,
  } as any)
  assert.ok(result, 'expected TIFF → sips → PNG pipeline to succeed')
  assert.equal(result!.mime, 'image/png')
  assert.equal(result!.source, 'png')
  assert.ok(uuidSeq >= 2, 'TIFF 转换应再生成独立输出路径')
})

test('TIFF→sips 转换守卫看注入的 platform 而非 process.platform（ubuntu CI 复现回归）', async () => {
  // RED #8 在维护者的 Mac 上永远绿：convertToPng 的守卫曾偷查真实
  // process.platform（linux 上直接 return null，跳过 sips 转换返回原始 TIFF），
  // 违背 ShellClipboardOpts.platform 的注入契约。本测试临时把真实平台改写为
  // linux 复现 CI 条件——任何平台上都能抓住该回归。
  const mod = await import('../clipboard-image.js')
  const { tryShellClipboard } = mod

  const pngBuf = Buffer.from(PNG_B64, 'base64')
  const tiffBuf = Buffer.from('49492a000800000000000000', 'hex')
  let sipsCalls = 0
  const execFile = async (bin: string, args: string[]) => {
    if (bin === 'osascript') return { stdout: 'TIFF' }
    if (bin === 'sips') {
      sipsCalls++
      return { stdout: '' }
    }
    throw new Error(`unexpected exec: ${bin} ${args.join(' ')}`)
  }
  const readFile = async (p: string) => {
    if (p.endsWith('.tiff')) return tiffBuf
    if (p.endsWith('.png')) return pngBuf
    throw new Error(`unexpected readFile: ${p}`)
  }

  const realPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  try {
    const result = await tryShellClipboard({
      execFile,
      platform: 'darwin',
      readFile,
      tmpdir: '/tmp',
      randomUUID: () => 'u',
    } as any)
    assert.ok(result, '注入 darwin 平台时 TIFF 流程应成功')
    assert.equal(sipsCalls, 1, 'TIFF 应调用 sips 转换（守卫须看注入的 platform）')
    assert.equal(result!.mime, 'image/png', '转换后应得到 PNG 而非原始 TIFF')
    assert.equal(result!.source, 'png')
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  }
})

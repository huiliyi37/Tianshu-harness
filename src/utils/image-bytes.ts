/**
 * 视觉图片字节工具——magic 嗅探 + BMP→PNG 纯 JS 转码 + vision data URL 归一化。
 *
 * 背景（2026-10-21 用户实报）：DeepSeek 只收 png/jpeg/gif/webp，而图片进
 * 模型历史的唯一咽喉（context.addUserMessage）对 data URL 零校验——
 * read_file 按扩展名声明 mime（.bmp → image/bmp；声明与字节不符也不核），
 * 一张 bmp/坏图进历史后每次请求都被 provider 400「unsupported image」。
 * 本模块是全部入口共用的判据：以**字节 magic** 为准，不认扩展名与声明。
 */

import { deflateSync } from 'node:zlib'

/** 视觉 provider（DeepSeek/OpenAI 兼容）通吃的格式白名单。 */
export const PROVIDER_SAFE_IMAGE_MIMES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export type SniffedImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/bmp' | 'image/tiff'

/** 按 magic bytes 嗅探图片格式；不认识返回 null（截断/非图/坏图都归这里）。 */
export function sniffImageMime(bytes: Uint8Array): SniffedImageMime | null {
  if (bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
  if (bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp'
  if (bytes.length >= 4 &&
    ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a))) return 'image/tiff'
  return null
}

export interface DecodedImageDataUrl {
  declaredMime: string
  bytes: Buffer
}

/** 解析 data:image/...;base64,... —— 非 data URL / 非 base64 / 空载荷都返回 null。 */
export function decodeImageDataUrl(url: string): DecodedImageDataUrl | null {
  const match = /^data:([^;,]*);base64,([\s\S]+)$/.exec(url)
  if (!match) return null
  try {
    const bytes = Buffer.from(match[2]!, 'base64')
    if (bytes.length === 0) return null
    return { declaredMime: match[1]!.toLowerCase(), bytes }
  } catch {
    return null
  }
}

/* ── BMP → PNG（纯 JS，node:zlib 压缩；覆盖 24/32bpp 未压缩 BMP——
 *  截图/画图/扫描件的全部常见形态。RLE 压缩与 1/4/8bpp 调色板变体不支持，
 *  归一化层对它们 fail-closed 成「剥掉 + 占位」，绝不放原格式出境。） ── */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

/**
 * 24/32bpp 未压缩 BMP → PNG（RGB，忽略 alpha——32bpp BMP 的 alpha 常为全 0，
 * 原样带出会是全透明图）。bottom-up（正高度）与 top-down（负高度）都支持。
 * 不支持的变体返回 null（调用方降级，不得把原 BMP 发给 provider）。
 */
export function transcodeBmpToPng(bmp: Buffer): Buffer | null {
  if (bmp.length < 54 || bmp[0] !== 0x42 || bmp[1] !== 0x4d) return null
  const dataOffset = bmp.readUInt32LE(10)
  const dibSize = bmp.readUInt32LE(14)
  if (dibSize < 40) return null
  const width = bmp.readInt32LE(18)
  const heightRaw = bmp.readInt32LE(22)
  const planes = bmp.readUInt16LE(26)
  const bpp = bmp.readUInt16LE(28)
  const compression = bmp.readUInt32LE(30)
  // BI_RGB(0)：24/32bpp 都可；BI_BITFIELDS(3) 只接 32bpp 且按标准 BGRA 掩码。
  if (planes !== 1 || width <= 0 || heightRaw === 0) return null
  if (!((compression === 0 && (bpp === 24 || bpp === 32)) || (compression === 3 && bpp === 32))) return null
  const height = Math.abs(heightRaw)
  const topDown = heightRaw < 0
  const bytesPerPixel = bpp / 8
  const rowStride = Math.ceil((width * bpp) / 32) * 4
  if (dataOffset + rowStride * height > bmp.length) return null

  const raw = Buffer.alloc(height * (1 + width * 3))
  let out = 0
  for (let y = 0; y < height; y++) {
    const srcRow = topDown ? y : height - 1 - y
    let src = dataOffset + srcRow * rowStride
    raw[out++] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      raw[out++] = bmp[src + 2]! // R（BMP 存 BGR[A]）
      raw[out++] = bmp[src + 1]! // G
      raw[out++] = bmp[src]!     // B
      src += bytesPerPixel
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

export type VisionImageNormalization =
  | { ok: true; dataUrl: string; change?: 'declared-fixed' | 'bmp-transcoded' }
  | { ok: false; reason: string }

/**
 * vision data URL 归一化（以字节为准，不认声明/扩展名）：
 *  - 非 data URL（http/https）：原样放行（provider 自取）；
 *  - 字节 sniff 为白名单格式：声明一致放行；不一致以字节为准改声明（declared-fixed）；
 *  - 字节 sniff 为 BMP：转 PNG（bmp-transcoded），模型仍然看得见；
 *  - 字节 sniff 为 TIFF、或声明不在白名单且字节也认不出：ok:false——剥掉留占位，
 *    绝不放原格式出境（DeepSeek 只收 png/jpeg/gif/webp，一张坏图毒化整段历史）；
 *  - 字节认不出但声明在白名单内：**信声明放行**——只按正面证据行动（误判一张
 *    好图比放一张坏图更糟），损坏但声明合法的图留给 provider 判定 +
 *    image_strip 剥图重试兜底。
 */
export function normalizeVisionImageDataUrl(url: string): VisionImageNormalization {
  if (!url.startsWith('data:')) return { ok: true, dataUrl: url }
  const decoded = decodeImageDataUrl(url)
  if (!decoded) return { ok: false, reason: 'malformed image data URL' }
  const sniffed = sniffImageMime(decoded.bytes)
  if (sniffed && PROVIDER_SAFE_IMAGE_MIMES.has(sniffed)) {
    if (sniffed === decoded.declaredMime) return { ok: true, dataUrl: url }
    return { ok: true, dataUrl: `data:${sniffed};base64,${decoded.bytes.toString('base64')}`, change: 'declared-fixed' }
  }
  if (sniffed === 'image/bmp') {
    const png = transcodeBmpToPng(decoded.bytes)
    if (png) return { ok: true, dataUrl: `data:image/png;base64,${png.toString('base64')}`, change: 'bmp-transcoded' }
    return { ok: false, reason: 'unsupported BMP variant (only 24/32-bit uncompressed is convertible)' }
  }
  if (sniffed === 'image/tiff') {
    return { ok: false, reason: 'image format not supported by vision providers (image/tiff)' }
  }
  if (PROVIDER_SAFE_IMAGE_MIMES.has(decoded.declaredMime)) return { ok: true, dataUrl: url }
  return { ok: false, reason: `image format not supported by vision providers (declared ${decoded.declaredMime || 'unknown'}, bytes unrecognized)` }
}

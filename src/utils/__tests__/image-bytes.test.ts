import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import {
  sniffImageMime,
  decodeImageDataUrl,
  transcodeBmpToPng,
  normalizeVisionImageDataUrl,
  PROVIDER_SAFE_IMAGE_MIMES,
} from '../image-bytes.js'

/** 构造未压缩 BMP（24 或 32bpp）。pixels: [row0..rowH-1][x] = [r,g,b]（视觉行序，从上到下）。 */
function makeBmp(width: number, height: number, bpp: 24 | 32, pixels: [number, number, number][][], topDown = false): Buffer {
  const bytesPerPixel = bpp / 8
  const rowStride = Math.ceil((width * bpp) / 32) * 4
  const dataOffset = 54
  const fileSize = dataOffset + rowStride * height
  const bmp = Buffer.alloc(fileSize)
  bmp.write('BM', 0, 'ascii')
  bmp.writeUInt32LE(fileSize, 2)
  bmp.writeUInt32LE(dataOffset, 10)
  bmp.writeUInt32LE(40, 14) // DIB size
  bmp.writeInt32LE(width, 18)
  bmp.writeInt32LE(topDown ? -height : height, 22)
  bmp.writeUInt16LE(1, 26) // planes
  bmp.writeUInt16LE(bpp, 28)
  bmp.writeUInt32LE(0, 30) // BI_RGB
  for (let y = 0; y < height; y++) {
    const row = topDown ? y : height - 1 - y
    let p = dataOffset + row * rowStride
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixels[y]![x]!
      bmp[p++] = b; bmp[p++] = g; bmp[p++] = r
      if (bpp === 32) bmp[p++] = 0
    }
  }
  return bmp
}

/** 拆 PNG → { width, height, rows: 解码后的 RGB 像素（视觉行序） }。 */
function decodePng(png: Buffer): { width: number; height: number; pixels: [number, number, number][][] } {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  let offset = 8
  let width = 0, height = 0
  const idat: Buffer[] = []
  while (offset < png.length) {
    const len = png.readUInt32BE(offset)
    const type = png.subarray(offset + 4, offset + 8).toString('ascii')
    const data = png.subarray(offset + 8, offset + 8 + len)
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); assert.equal(data[9], 2) }
    if (type === 'IDAT') idat.push(data)
    offset += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const pixels: [number, number, number][][] = []
  let p = 0
  for (let y = 0; y < height; y++) {
    assert.equal(raw[p++], 0, 'filter byte')
    const row: [number, number, number][] = []
    for (let x = 0; x < width; x++) row.push([raw[p++]!, raw[p++]!, raw[p++]!])
    pixels.push(row)
  }
  return { width, height, pixels }
}

const PIXELS: [number, number, number][][] = [
  [[255, 0, 0], [0, 255, 0]],
  [[0, 0, 255], [255, 255, 255]],
]

test('24bpp bottom-up BMP → PNG：尺寸与像素逐点一致', () => {
  const png = transcodeBmpToPng(makeBmp(2, 2, 24, PIXELS))!
  assert.ok(png)
  const decoded = decodePng(png)
  assert.equal(decoded.width, 2)
  assert.equal(decoded.height, 2)
  assert.deepEqual(decoded.pixels, PIXELS)
})

test('32bpp top-down BMP → PNG：行序正确、alpha 被丢弃', () => {
  const png = transcodeBmpToPng(makeBmp(2, 2, 32, PIXELS, true))!
  const decoded = decodePng(png)
  assert.deepEqual(decoded.pixels, PIXELS)
})

test('不支持的 BMP 变体 → null（调用方降级，不放原格式出境）', () => {
  const rle = makeBmp(2, 2, 24, PIXELS)
  rle.writeUInt32LE(1, 30) // BI_RLE8-ish
  assert.equal(transcodeBmpToPng(rle), null)
  assert.equal(transcodeBmpToPng(Buffer.from('BM')), null)
  assert.equal(transcodeBmpToPng(Buffer.alloc(100)), null)
})

test('sniffImageMime 覆盖白名单与 bmp/tiff/未知', () => {
  assert.equal(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png')
  assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
  assert.equal(sniffImageMime(Buffer.from('GIF89a')), 'image/gif')
  assert.equal(sniffImageMime(Buffer.from('RIFF....WEBP')), 'image/webp')
  assert.equal(sniffImageMime(Buffer.from('BM....')), 'image/bmp')
  assert.equal(sniffImageMime(Buffer.from([0x49, 0x49, 0x2a, 0x00])), 'image/tiff')
  assert.equal(sniffImageMime(Buffer.from('hello world')), null)
  assert.equal(sniffImageMime(Buffer.alloc(0)), null)
})

test('decodeImageDataUrl：只接 base64 data URL', () => {
  const hit = decodeImageDataUrl('data:image/png;base64,QUJD')!
  assert.equal(hit.declaredMime, 'image/png')
  assert.deepEqual(hit.bytes, Buffer.from('ABC'))
  assert.equal(decodeImageDataUrl('https://x/y.png'), null)
  assert.equal(decodeImageDataUrl('data:image/png;base64,'), null)
  assert.equal(decodeImageDataUrl('data:text/plain,abc'), null)
})

test('normalize：白名单原样放行；声明与字节不符以字节为准改声明', () => {
  const pngUrl = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')}`
  assert.deepEqual(normalizeVisionImageDataUrl(pngUrl), { ok: true, dataUrl: pngUrl })

  // .png 声明但实为 JPEG 字节（read_file 按扩展名声明的历史 bug 形态）。
  const mislabeled = `data:image/png;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]).toString('base64')}`
  const fixed = normalizeVisionImageDataUrl(mislabeled)
  assert.equal(fixed.ok, true)
  if (fixed.ok) {
    assert.equal(fixed.change, 'declared-fixed')
    assert.ok(fixed.dataUrl.startsWith('data:image/jpeg;base64,'))
  }
})

test('normalize：bmp 转 PNG 后模型仍可见（不剥图）', () => {
  const bmpUrl = `data:image/bmp;base64,${makeBmp(2, 2, 24, PIXELS).toString('base64')}`
  const out = normalizeVisionImageDataUrl(bmpUrl)
  assert.equal(out.ok, true)
  if (out.ok) {
    assert.equal(out.change, 'bmp-transcoded')
    const decoded = decodeImageDataUrl(out.dataUrl)!
    assert.equal(decoded.declaredMime, 'image/png')
    assert.deepEqual(decodePng(decoded.bytes).pixels, PIXELS)
  }
})

test('normalize：tiff / 声明白名单外 / 畸形 URL → ok:false（剥掉占位，不放出境）', () => {
  for (const url of [
    `data:image/tiff;base64,${Buffer.from([0x49, 0x49, 0x2a, 0x00]).toString('base64')}`,
    `data:image/heic;base64,${Buffer.from('ftypheic....').toString('base64')}`,
    'data:image/png;base64,',
  ]) {
    const out = normalizeVisionImageDataUrl(url)
    assert.equal(out.ok, false, url.slice(0, 40))
    if (!out.ok) assert.ok(out.reason.length > 0)
  }
  // http(s) URL 原样放行（provider 自取）。
  const http = normalizeVisionImageDataUrl('https://example.com/x.png')
  assert.deepEqual(http, { ok: true, dataUrl: 'https://example.com/x.png' })
})

test('normalize：字节认不出但声明在白名单内 → 信声明放行（只按正面证据行动）', () => {
  // 保守侧：测试桩/未识别的短载荷只要声明合法就不动——损坏图留给 provider
  // 判定 + image_strip 重试兜底，不能误判好图。
  const stub = 'data:image/png;base64,QUJD'
  assert.deepEqual(normalizeVisionImageDataUrl(stub), { ok: true, dataUrl: stub })
})

test('白名单与 provider 口径一致（DeepSeek: webp/png/jpeg/gif）', () => {
  assert.deepEqual([...PROVIDER_SAFE_IMAGE_MIMES].sort(), ['image/gif', 'image/jpeg', 'image/png', 'image/webp'])
})

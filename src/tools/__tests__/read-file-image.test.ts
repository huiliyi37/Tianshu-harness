import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { READ_FILE_TOOL } from '../read-file.js'
import type { ToolCallParams } from '../types.js'

const TEST_DIR = join(process.cwd(), '.test-tmp', 'read-file-image-test')

// 1x1 透明 PNG（合法最小 PNG 二进制）
const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

function makeParams(input: Record<string, unknown>): ToolCallParams {
  return { input, toolUseId: 'test-id', cwd: TEST_DIR }
}

describe('read_file — 图片文件视觉分流', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  it('png → 经 images 通道返回 data URL，base64 可还原原文件', async () => {
    const file = join(TEST_DIR, 'shot.png')
    writeFileSync(file, PNG_BYTES)
    const result = await READ_FILE_TOOL.execute(makeParams({ file_path: file }))
    assert.ok(!result.isError, `expected success, got: ${result.content}`)
    assert.ok(result.content.includes('视觉附件'))
    assert.ok(Array.isArray(result.images) && result.images.length === 1)
    const url = result.images![0]!
    assert.ok(url.startsWith('data:image/png;base64,'), `wrong MIME prefix: ${url.slice(0, 40)}`)
    const decoded = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64')
    assert.deepEqual(decoded, PNG_BYTES, 'base64 round-trips to the original bytes')
  })

  it('jpg → 声明按字节修正（.jpg 文件装 PNG 字节 → image/png；扩展名不再优先于字节）', async () => {
    const file = join(TEST_DIR, 'photo.jpg')
    writeFileSync(file, PNG_BYTES) // 内容是 PNG：归一化以字节为准，声明被修正
    const result = await READ_FILE_TOOL.execute(makeParams({ file_path: file }))
    assert.ok(!result.isError)
    assert.ok(result.images![0]!.startsWith('data:image/png;base64,'))
    assert.ok(result.content.includes('声明已按实际字节修正'))
  })

  it('超过 10MB 的图片 → 拒绝并指向缩放/OCR 绕行', async () => {
    const file = join(TEST_DIR, 'huge.png')
    writeFileSync(file, Buffer.alloc(11 * 1024 * 1024, 1))
    const result = await READ_FILE_TOOL.execute(makeParams({ file_path: file }))
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('image too large'))
    assert.ok(result.content.includes('tesseract'))
    assert.equal(result.images, undefined)
  })

  it('.pdf 仍走 binary 拒绝（不在图片分流内）', async () => {
    const file = join(TEST_DIR, 'doc.pdf')
    writeFileSync(file, Buffer.from('%PDF-1.4 fake'))
    const result = await READ_FILE_TOOL.execute(makeParams({ file_path: file }))
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('binary'))
  })

  it('.ico 不在图片分流内，维持 binary 拒绝', async () => {
    const file = join(TEST_DIR, 'favicon.ico')
    writeFileSync(file, Buffer.alloc(64, 0))
    const result = await READ_FILE_TOOL.execute(makeParams({ file_path: file }))
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('binary'))
  })
})

// 2026-10-21 — 归一化以字节为准：bmp 转 PNG（模型仍可见），坏图明确报错。
describe('read_file — 图片归一化（bmp/tiff 不毒化历史）', () => {
  it('bmp → 转 PNG 后仍走 images 通道（此前原样挂 image/bmp，DeepSeek 整请求 400）', async () => {
    // 2x2 24bpp bottom-up BMP（全红）
    const bmp = Buffer.alloc(54 + 8 * 2)
    bmp.write('BM', 0, 'ascii')
    bmp.writeUInt32LE(bmp.length, 2)
    bmp.writeUInt32LE(54, 10)
    bmp.writeUInt32LE(40, 14)
    bmp.writeInt32LE(2, 18)
    bmp.writeInt32LE(2, 22)
    bmp.writeUInt16LE(1, 26)
    bmp.writeUInt16LE(24, 28)
    for (let p = 54; p < bmp.length; p += 3) { bmp[p] = 0; bmp[p + 1] = 0; bmp[p + 2] = 255 }
    const file = join(TEST_DIR, 'shot.bmp')
    writeFileSync(file, bmp)
    const result = await READ_FILE_TOOL.execute(makeParams({ file_path: file }))
    assert.ok(!result.isError, `expected success, got: ${result.content}`)
    assert.ok(result.content.includes('bmp 已转 PNG'))
    const url = result.images![0]!
    assert.ok(url.startsWith('data:image/png;base64,'), `bmp must be transcoded: ${url.slice(0, 40)}`)
    // 转出的 PNG 是真 PNG（magic 头）。
    const decoded = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64')
    assert.deepEqual([...decoded.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  })

  it('.png 文件实为 bmp 字节 → 按字节转 PNG（扩展名声明不可信）', async () => {
    const bmp = Buffer.alloc(54 + 8 * 2)
    bmp.write('BM', 0, 'ascii')
    bmp.writeUInt32LE(bmp.length, 2)
    bmp.writeUInt32LE(54, 10)
    bmp.writeUInt32LE(40, 14)
    bmp.writeInt32LE(2, 18)
    bmp.writeInt32LE(2, 22)
    bmp.writeUInt16LE(1, 26)
    bmp.writeUInt16LE(24, 28)
    const file = join(TEST_DIR, 'mislabeled.png')
    writeFileSync(file, bmp)
    const result = await READ_FILE_TOOL.execute(makeParams({ file_path: file }))
    assert.ok(!result.isError)
    assert.ok(result.images![0]!.startsWith('data:image/png;base64,'), '字节是 bmp → 转出的必须是 PNG')
  })
})

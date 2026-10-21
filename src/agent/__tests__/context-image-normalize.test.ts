/**
 * context.addUserMessage 的图片入口归一化（2026-10-21）——进模型历史的唯一
 * 咽喉此前对 data URL 零校验：一张 bmp/tiff 进历史，后续每个请求都被
 * DeepSeek 400「unsupported image」毒化。现一律过 normalizeVisionImageDataUrl：
 * bmp 转 PNG（模型仍可见）、tiff/坏图换占位文本（历史干净、措辞告知图已不在）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SessionContext } from '../context.js'
import type { OaiContentPart } from '../../api/oai-types.js'

function makeBmp2x2(): Buffer {
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
  return bmp
}

function userParts(ctx: SessionContext): OaiContentPart[] {
  const msg = ctx.getMessages().at(-1)!
  assert.equal(msg.role, 'user')
  assert.ok(Array.isArray(msg.content))
  return msg.content as OaiContentPart[]
}

describe('addUserMessage 图片归一化', () => {
  it('bmp 附件转 PNG 进历史（视觉模型仍可见）', () => {
    const ctx = new SessionContext()
    ctx.addUserMessage('看这张图', [`data:image/bmp;base64,${makeBmp2x2().toString('base64')}`])
    const parts = userParts(ctx)
    const img = parts.find((p) => p.type === 'image_url')
    assert.ok(img, 'bmp 必须转码保留为图片 part，而不是剥掉')
    assert.ok(img!.image_url!.url.startsWith('data:image/png;base64,'))
  })

  it('tiff 附件换占位文本（措辞让模型知道图已不在）', () => {
    const ctx = new SessionContext()
    const tiff = `data:image/tiff;base64,${Buffer.from([0x49, 0x49, 0x2a, 0x00, 1, 2, 3, 4]).toString('base64')}`
    ctx.addUserMessage('看这张图', [tiff])
    const parts = userParts(ctx)
    assert.ok(!parts.some((p) => p.type === 'image_url'), 'tiff 不得进历史')
    const note = parts.find((p): p is Extract<OaiContentPart, { type: 'text' }> => p.type === 'text' && p.text.includes('image not sent'))
    assert.ok(note, '必须留下「图未发出」的占位文本')
    assert.ok(note.text.includes('image/tiff'))
  })

  it('合法 png 原样保留，文本消毒行为不变', () => {
    const ctx = new SessionContext()
    const png = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]).toString('base64')}`
    ctx.addUserMessage('describe', [png])
    const parts = userParts(ctx)
    assert.deepEqual(parts[0], { type: 'text', text: 'describe' })
    assert.deepEqual(parts[1], { type: 'image_url', image_url: { url: png } })
  })

  it('声明可信但字节未识别的测试桩原样放行（不误判好图）', () => {
    const ctx = new SessionContext()
    const stub = 'data:image/png;base64,QUJD'
    ctx.addUserMessage('x', [stub])
    assert.deepEqual(userParts(ctx)[1], { type: 'image_url', image_url: { url: stub } })
  })
})

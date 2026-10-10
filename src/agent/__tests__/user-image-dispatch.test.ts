/**
 * user-image-dispatch.ts tests：用户附图的三条出口。
 *
 * 反证表：
 *   #1「无桥照发」    → text-only 且无识图桥必须**丢弃** image part，且留可见提示
 *   #2「丢图不留痕」  → 提示进 userInput（模型与用户都看得到），用户原文不动
 *   #3「多模态也走桥」→ supportsVision 时不得调用识图客户端
 *   #4「桥接失败炸轮」→ 报错/空描述降级为可见提示，绝不抛给调用方
 */

import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { dispatchUserImages, formatNoBridgeNotice } from '../user-image-dispatch.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'
import type { ContentBlock } from '../../api/types.js'
import { OpenAIClient } from '../../api/openai-client.js'
import { FallbackStreamClient } from '../../api/fallback-client.js'

const IMG = 'data:image/png;base64,' + 'A'.repeat(64)
const IMG2 = 'data:image/jpeg;base64,' + 'B'.repeat(64)

function visionClientReturning(description: string) {
  const stream = mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
    cb.onContentBlock({ type: 'text', text: description } as ContentBlock)
    cb.onStopReason('end_turn', { input_tokens: 1, output_tokens: 1 })
  })
  return { client: { stream } as unknown as StreamClient, stream }
}

function visionClientThrowing(message: string) {
  const stream = mock.fn(async () => { throw new Error(message) })
  return { client: { stream } as unknown as StreamClient, stream }
}

describe('dispatchUserImages', () => {
  for (const fixture of [
    { label: 'vprov/v-cap', model: 'v-cap' },
    { label: 'vprov/vendor/v-cap', model: 'vendor/v-cap' },
    { label: 'vprov/v-cap → backup/other-cap', model: 'v-cap', fallback: 'other-cap' },
  ]) {
    it(`keeps the bridge label out of the API model field: ${fixture.label}`, async t => {
      const models: string[] = []
      t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        models.push(body.model)
        if (fixture.fallback && models.length === 1) {
          return new Response(JSON.stringify({ error: { message: 'upstream unavailable' } }), {
            status: 503, headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(
          'data: {"choices":[{"delta":{"content":"visible text"},"index":0,"finish_reason":"stop"}]}\n\n'
          + 'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        )
      })
      const makeClient = (model: string) => new OpenAIClient({
        baseUrl: 'https://vision.example/v1', apiKey: 'test-fixture', model,
        maxTokens: 1024, maxRetries: 0,
      })
      const primary = makeClient(fixture.model)
      const client = fixture.fallback
        ? new FallbackStreamClient(primary, 'primary', [{ name: 'backup', create: () => makeClient(fixture.fallback!) }])
        : primary

      const result = await dispatchUserImages('inspect', [IMG], {
        supportsVision: false, visionClient: client, visionModel: fixture.label,
      })

      assert.deepEqual(models, fixture.fallback ? ['v-cap', 'other-cap'] : [fixture.model])
      assert.match(result.userInput, /\[图片描述\]\nvisible text/)
    })
  }

  it('truncated descriptions stay visible but never enter the complete-description cache', async () => {
    let cached = 0
    const client = { stream: async (_request: unknown, cb: any) => { cb.onTextDelta('partial OCR'); cb.onStopReason('length', { output_tokens: 3 }) } } as StreamClient
    const result = await dispatchUserImages('inspect', [IMG], { supportsVision: false, visionClient: client, registeredIds: ['img_1'], cacheDescription: () => { cached++ } })
    assert.match(result.userInput, /图片描述被截断/); assert.equal(cached, 0)
  })
  it('无图：原样返回（连引用都不换）', async () => {
    const out = await dispatchUserImages('hi', undefined, { supportsVision: false })
    assert.deepEqual(out, { userInput: 'hi', images: undefined })
    const out2 = await dispatchUserImages('hi', [], { supportsVision: true })
    assert.equal(out2.userInput, 'hi')
    assert.deepEqual(out2.images, [])
  })

  it('#3 多模态主控：直通，不调识图客户端', async () => {
    const v = visionClientReturning('不该被调用')
    const out = await dispatchUserImages('看这张', [IMG], { supportsVision: true, visionClient: v.client })
    assert.equal(out.userInput, '看这张', '直通不得改写用户文本')
    assert.deepEqual(out.images, [IMG])
    assert.equal(v.stream.mock.callCount(), 0)
  })

  it('#1/#2 无识图桥：丢弃图片 + 可见提示，用户原文保留在后', async () => {
    const out = await dispatchUserImages('看这张', [IMG, IMG2], { supportsVision: false })
    assert.equal(out.images, undefined, '无桥时图片必须丢弃，不能照进请求')
    assert.ok(out.userInput.startsWith('[图片未发送]'), '提示必须在最前面（模型先看到）')
    assert.ok(out.userInput.includes('2 张图片'), '要说清丢了几张')
    assert.ok(out.userInput.includes('agent.visionModel'), '要给出可行动的下一步')
    assert.ok(out.userInput.endsWith('看这张'), '用户原文一个字都不能丢')
  })

  it('formatNoBridgeNotice：措辞禁止模型凭记忆描述（静默降级最贵的形状）', () => {
    assert.match(formatNoBridgeNotice(1), /不要凭记忆描述/)
  })

  it('有桥：描述注入，图片从请求移除，首图缓存写入', async () => {
    const v = visionClientReturning('截图里写着 hello')
    const cached: Array<{ id: string; key: string; description: string }> = []
    const out = await dispatchUserImages('看这张', [IMG], {
      supportsVision: false,
      visionClient: v.client,
      visionModelPrompt: 'p',
      registeredIds: ['img-1'],
      cacheDescription: (id, key, description) => cached.push({ id, key, description }),
    })
    assert.equal(v.stream.mock.callCount(), 1)
    assert.ok(out.userInput.startsWith('[图片描述]'))
    assert.ok(out.userInput.includes('截图里写着 hello'))
    assert.equal(out.images, undefined)
    assert.deepEqual(cached.map((c) => c.id), ['img-1'])
    assert.equal(cached[0]!.description, '截图里写着 hello')
  })

  it('#4 桥接返回空描述：降级为可见提示，不抛错', async () => {
    const v = visionClientReturning('')
    const out = await dispatchUserImages('看这张', [IMG], { supportsVision: false, visionClient: v.client })
    assert.ok(out.userInput.startsWith('[图片桥接提示]'))
    assert.equal(out.images, undefined)
  })

  it('#4 桥接抛错：降级为可见提示并带上原因，不抛给调用方', async () => {
    const v = visionClientThrowing('connect ETIMEDOUT')
    const out = await dispatchUserImages('看这张', [IMG], { supportsVision: false, visionClient: v.client })
    assert.ok(out.userInput.startsWith('[图片桥接失败]'))
    assert.ok(out.userInput.includes('ETIMEDOUT'), '原因要带上，否则用户无从排查')
    assert.equal(out.images, undefined)
  })
})

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isAssistantWithTools, isToolMessage, isUserMessage,
  oaiMessagesHaveImageParts, stripOaiImageParts, STRIPPED_IMAGE_PLACEHOLDER,
  sanitizeOaiImageParts, UNSUPPORTED_IMAGE_PLACEHOLDER,
  type OaiChatRequest, type OaiMessage,
} from '../oai-types.js'

describe('OpenAI-native API types', () => {
  it('narrows tool messages with tool_call_id', () => {
    const msg: OaiMessage = {
      role: 'tool',
      tool_call_id: 'call_123',
      content: 'done',
    }

    assert.equal(isToolMessage(msg), true)
    if (isToolMessage(msg)) {
      assert.equal(msg.tool_call_id, 'call_123')
    }
  })

  it('narrows assistant messages with tool calls', () => {
    const msg: OaiMessage = {
      role: 'assistant',
      content: null,
      reasoning_content: 'Need to inspect the file.',
      tool_calls: [
        {
          id: 'call_read',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: '{"file_path":"src/main.tsx"}',
          },
        },
      ],
    }

    assert.equal(isAssistantWithTools(msg), true)
    if (isAssistantWithTools(msg)) {
      assert.equal(msg.tool_calls[0]?.function.name, 'read_file')
      assert.equal(msg.reasoning_content, 'Need to inspect the file.')
    }
  })

  it('does not classify empty tool_calls as assistant-with-tools', () => {
    const msg: OaiMessage = {
      role: 'assistant',
      content: 'No tools needed.',
      tool_calls: [],
    }

    assert.equal(isAssistantWithTools(msg), false)
  })

  it('narrows user messages', () => {
    const msg: OaiMessage = {
      role: 'user',
      content: 'Continue.',
    }

    assert.equal(isUserMessage(msg), true)
    assert.equal(isToolMessage(msg), false)
  })

  it('supports OpenAI-compatible request bodies with cache usage fields', () => {
    const request: OaiChatRequest = {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'You are concise.' },
        { role: 'user', content: 'Read the file.' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read a file',
            parameters: {
              type: 'object',
              properties: { file_path: { type: 'string' } },
              required: ['file_path'],
            },
          },
        },
      ],
      tool_choice: 'auto',
      max_tokens: 1024,
      stream: true,
      reasoning_effort: 'low',
    }

    assert.equal(request.messages.length, 2)
    assert.equal(request.tools?.[0]?.function.name, 'read_file')
  })
})

// ---------------------------------------------------------------------------
// image_strip 恢复的纯函数底座（413 / 图片拒绝重试时剥离 image_url）
// ---------------------------------------------------------------------------

describe('oaiMessagesHaveImageParts', () => {
  it('文本消息判 false', () => {
    assert.equal(oaiMessagesHaveImageParts([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]), false)
  })

  it('用户消息带 image_url part 判 true', () => {
    assert.equal(oaiMessagesHaveImageParts([{
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    }]), true)
  })

  it('空数组判 false', () => {
    assert.equal(oaiMessagesHaveImageParts([]), false)
  })

  it('只看用户消息——assistant/tool 的 content 数组不算图片', () => {
    const msgs = [
      { role: 'assistant', content: [{ type: 'text', text: 'no image here' }] },
      { role: 'tool', tool_call_id: 'c1', content: 'done' },
    ] as unknown as OaiMessage[]
    assert.equal(oaiMessagesHaveImageParts(msgs), false)
  })
})

describe('stripOaiImageParts', () => {
  it('无图可剥时原引用返回（零拷贝，调用方可据此判 no-op）', () => {
    const msgs: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'text only' },
    ]
    const result = stripOaiImageParts(msgs)
    assert.equal(result.removedCount, 0)
    assert.equal(result.messages, msgs, '未剥离时不得复制数组')
  })

  it('剥掉全部 image_url part（逐 part 换占位符），保留文本与其他消息', () => {
    const msgs: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'keep me' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB' } },
        ],
      },
      { role: 'assistant', content: 'ok' },
    ]
    const result = stripOaiImageParts(msgs)
    assert.equal(result.removedCount, 2)
    assert.notEqual(result.messages, msgs, '剥离后必须返回新数组')
    assert.deepEqual(result.messages[1]!.content, [
      { type: 'text', text: 'keep me' },
      { type: 'text', text: STRIPPED_IMAGE_PLACEHOLDER },
      { type: 'text', text: STRIPPED_IMAGE_PLACEHOLDER },
    ], '混排消息也必须留占位符——直接删 part 会让模型凭记忆描述')
    assert.deepEqual(result.messages[0], msgs[0], 'system 消息不动')
    assert.deepEqual(result.messages[2], msgs[2], 'assistant 消息不动')
  })

  it('uniqueUrlCount 按不同 URL 计数（决定剥离能否持久化）', () => {
    const msgs: OaiMessage[] = [
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ] },
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } },
      ] },
    ]
    const result = stripOaiImageParts(msgs)
    assert.equal(result.removedCount, 3)
    assert.equal(result.uniqueUrlCount, 2, '同一 URL 的多个副本只算一个')
    const single = stripOaiImageParts([{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
    }])
    assert.equal(single.uniqueUrlCount, 1, '唯一 blame 时允许持久化写回历史')
    assert.equal(stripOaiImageParts([{ role: 'user', content: 'no image' }]).uniqueUrlCount, 0)
  })

  it('纯图片用户消息替换为文本占位（保住角色与消息数）', () => {
    const msgs: OaiMessage[] = [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
    }]
    const result = stripOaiImageParts(msgs)
    assert.equal(result.removedCount, 1)
    assert.deepEqual(result.messages[0]!.content, [
      { type: 'text', text: STRIPPED_IMAGE_PLACEHOLDER },
    ])
  })

  it('不修改输入（content 数组与消息对象都不动）', () => {
    const parts = [
      { type: 'text', text: 't' } as const,
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } } as const,
    ]
    const msgs: OaiMessage[] = [{ role: 'user', content: [...parts] }]
    stripOaiImageParts(msgs)
    assert.equal(parts.length, 2, '输入 parts 数组长度不变')
    assert.equal((msgs[0]!.content as unknown[]).length, 2, '输入消息 content 不变')
  })

  it('跨多条用户消息累计剥离', () => {
    const msgs: OaiMessage[] = [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      { role: 'assistant', content: 'saw it' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'and this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } },
        ],
      },
    ]
    const result = stripOaiImageParts(msgs)
    assert.equal(result.removedCount, 2)
    assert.deepEqual(result.messages[2]!.content, [
      { type: 'text', text: 'and this' },
      { type: 'text', text: STRIPPED_IMAGE_PLACEHOLDER },
    ])
  })

  it('占位文案可覆盖', () => {
    const msgs: OaiMessage[] = [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
    }]
    const result = stripOaiImageParts(msgs, '[图片已省略]')
    assert.deepEqual(result.messages[0]!.content, [{ type: 'text', text: '[图片已省略]' }])
  })
})

// ---------------------------------------------------------------------------
// provider 格式闸（2026-10-21）：字节不识的 image part 定点换占位，
// 白名单/声明可信的原样保留，声字节不符以字节为准修正。
// ---------------------------------------------------------------------------
describe('sanitizeOaiImageParts', () => {
  const BMP_2X2 = (() => {
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
    return `data:image/bmp;base64,${bmp.toString('base64')}`
  })()
  const TIFF = `data:image/tiff;base64,${Buffer.from([0x49, 0x49, 0x2a, 0x00, 1, 2, 3, 4]).toString('base64')}`
  const GOOD_PNG = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]).toString('base64')}`
  const STUB_PNG = 'data:image/png;base64,QUJD' // 测试桩：声明合法、字节未识别——信声明

  it('bmp 转 PNG 保留可见，tiff 换占位，好图与可信声明原样保留', () => {
    const msgs: OaiMessage[] = [
      { role: 'user', content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: BMP_2X2 } },
        { type: 'image_url', image_url: { url: TIFF } },
        { type: 'image_url', image_url: { url: GOOD_PNG } },
        { type: 'image_url', image_url: { url: STUB_PNG } },
      ] },
    ]
    const result = sanitizeOaiImageParts(msgs)
    assert.equal(result.removedCount, 1, '只有 tiff 被剥')
    assert.equal(result.uniqueUrlCount, 1)
    const parts = (result.messages[0] as { content: Array<{ type: string; text?: string; image_url?: { url: string } }> }).content
    assert.ok(parts[1]!.image_url!.url.startsWith('data:image/png;base64,'), 'bmp 转 PNG 后模型仍可见')
    assert.deepEqual(parts[2], { type: 'text', text: UNSUPPORTED_IMAGE_PLACEHOLDER })
    assert.equal(parts[3]!.image_url!.url, GOOD_PNG)
    assert.equal(parts[4]!.image_url!.url, STUB_PNG, '字节未识别但声明合法 → 信声明，不误判好图')
    // 原数组未被修改（纯函数）。
    const originalParts = (msgs[0] as { content: Array<{ image_url: { url: string } }> }).content
    assert.equal(originalParts[1]!.image_url.url, BMP_2X2)
  })

  it('声字节不符以字节为准（declared png 实为 bmp → 转 PNG 而不是信声明）', () => {
    const mislabeled = `data:image/png;base64,${Buffer.from('BM' + '0'.repeat(60)).toString('base64')}`
    // BM 头但体量不足合法 BMP → 转码失败 → 剥掉
    const msgs: OaiMessage[] = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: mislabeled } }] }]
    const result = sanitizeOaiImageParts(msgs)
    assert.equal(result.removedCount, 1)
  })

  it('非 user 角色与无图消息不动；全干净时返回原引用（幂等零成本）', () => {
    const msgs: OaiMessage[] = [
      { role: 'assistant', content: [{ type: 'image_url', image_url: { url: TIFF } }] as never },
      { role: 'user', content: 'plain text' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: GOOD_PNG } }] },
    ]
    const result = sanitizeOaiImageParts(msgs)
    assert.equal(result.removedCount, 0)
    assert.equal(result.messages, msgs)
    // assistant 消息里的坏图不在本闸范围（provider 只在校验 user 图时报该错）。
    assert.equal((result.messages[0] as { content: Array<{ image_url: { url: string } }> }).content[0]!.image_url.url, TIFF)
  })
})

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isAssistantWithTools, isToolMessage, isUserMessage,
  oaiMessagesHaveImageParts, stripOaiImageParts, STRIPPED_IMAGE_PLACEHOLDER,
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

  it('剥掉全部 image_url part，保留文本与其他消息', () => {
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
    assert.deepEqual(result.messages[1]!.content, [{ type: 'text', text: 'keep me' }])
    assert.deepEqual(result.messages[0], msgs[0], 'system 消息不动')
    assert.deepEqual(result.messages[2], msgs[2], 'assistant 消息不动')
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
    assert.deepEqual(result.messages[2]!.content, [{ type: 'text', text: 'and this' }])
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

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PromptEngine } from '../engine.js'
import { SessionContext } from '../../agent/context.js'
import { READ_FILE_TOOL } from '../../tools/read-file.js'

/**
 * 用户附图的请求体保真。
 *
 * loop-vision-attach.test.ts 只断言到 session 层（`state.oaiMessages` 含
 * image_url），不经过 buildOaiRequest——而 volatile trailer 合并会重写
 * 「最后一条 user 消息」的 content。这条缝隙让图片在构造请求时被静默丢弃，
 * 表现为模型无论如何都回答「看不到图片」（2026-09-11 用户报障）。
 */
const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-vision-parts-'))
const IMG = 'data:image/png;base64,' + 'A'.repeat(100)

function makeEngine(): PromptEngine {
  return new PromptEngine({
    model: 'deepseek-flash',
    maxTokens: 1024,
    staticCtx: { tools: [READ_FILE_TOOL.definition] },
    volatileCtx: { cwd: TEST_CWD },
  } as never)
}

describe('buildOaiRequest — 多模态 parts 保真', () => {
  it('最后一条 user 消息带图时，图片必须留在请求体里', () => {
    const engine = makeEngine()
    const session = new SessionContext()
    session.addUserMessage('看这张图', [IMG])

    const req = engine.buildOaiRequest(session.getMessages(), undefined, 1_000_000)
    const wire = JSON.stringify(req.messages)
    assert.ok(
      wire.includes('image_url'),
      `图片必须进入请求体（volatile trailer 不得吞掉 parts），实得：${wire.slice(0, 300)}`,
    )
  })

  it('该消息转为历史后，图片仍留在请求体里', () => {
    const engine = makeEngine()
    const session = new SessionContext()
    session.addUserMessage('看这张图', [IMG])
    engine.buildOaiRequest(session.getMessages(), undefined, 1_000_000)

    // 用户再发一条纯文本 → 带图消息退为历史轮次
    session.addUserMessage('继续')
    const req = engine.buildOaiRequest(session.getMessages(), undefined, 1_000_000)
    assert.ok(
      JSON.stringify(req.messages).includes('image_url'),
      '历史轮次里的图片同样必须保留（否则该轮之后的会话再也看不到它）',
    )
  })

  it('图片以 part 形式保留，而不是被字符串化成 JSON 文本', () => {
    const engine = makeEngine()
    const session = new SessionContext()
    session.addUserMessage('看这张图', [IMG])

    const req = engine.buildOaiRequest(session.getMessages(), undefined, 1_000_000)
    const lastUser = req.messages.filter(m => m.role === 'user').pop()!
    assert.ok(
      Array.isArray(lastUser.content),
      'content 必须仍是 parts 数组——降级成字符串会让模型只看到一串 base64 文本',
    )
    const parts = lastUser.content as Array<{ type: string; image_url?: { url: string } }>
    assert.ok(parts.some(p => p.type === 'image_url'), 'image_url part 必须原样保留')
    assert.ok(parts.some(p => p.type === 'text'), 'volatile 上下文块仍需作为 text part 注入')
  })

  it('纯文本消息的请求字节不受影响（前缀缓存基线）', () => {
    const engine = makeEngine()
    const session = new SessionContext()
    session.addUserMessage('纯文本消息')

    const req = engine.buildOaiRequest(session.getMessages(), undefined, 1_000_000)
    const lastUser = req.messages.filter(m => m.role === 'user').pop()!
    assert.equal(typeof lastUser.content, 'string', '纯文本路径仍产出字符串（字节稳定契约）')
    assert.ok(
      (lastUser.content as string).endsWith('纯文本消息'),
      '用户文本仍收尾（既有布局不变，缓存基线不动）',
    )
  })
})

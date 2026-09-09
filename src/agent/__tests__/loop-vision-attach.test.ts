import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_FILE_TOOL } from '../../tools/read-file.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'
import type { ContentBlock } from '../../api/types.js'

/**
 * 用户附图的识图分派（loop.ts 的 vision bridge 分支）此前无测试覆盖——
 * tool-execution-vision.test.ts 只覆盖「工具截图」路径（tool-pipeline），
 * 而用户自己贴图的路径是独立的一条。这里钉住两条分支的实际行为。
 */
const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-vision-attach-'))
const IMG = 'data:image/png;base64,' + 'A'.repeat(100)

function makeEngine() {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [READ_FILE_TOOL.definition] },
    volatileCtx: { cwd: TEST_CWD },
  })
}

function mainClient(): StreamClient {
  return {
    stream: mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
      cb.onContentBlock({ type: 'text', text: 'ok' } as ContentBlock)
      cb.onStopReason('end_turn', { input_tokens: 1, output_tokens: 1 })
    }),
  } as unknown as StreamClient
}

function makeVisionClient(description: string) {
  const stream = mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
    cb.onContentBlock({ type: 'text', text: description } as ContentBlock)
    cb.onStopReason('end_turn', { input_tokens: 1, output_tokens: 1 })
  })
  return { client: { stream } as unknown as StreamClient, stream }
}

function callbacks() {
  return {
    onTextDelta: () => {},
    onThinkingDelta: () => {},
    onToolUse: () => {},
    onToolResult: () => {},
    onTurnComplete: () => {},
    onError: () => {},
    onAbort: () => {},
    onApprovalRequired: async () => false,
  }
}

function oaiMessages(session: SessionContext): unknown[] {
  return (session as unknown as { state: { oaiMessages: unknown[] } }).state.oaiMessages
}

function makeAgent(opts: { supportsVision: boolean; visionClient?: StreamClient }) {
  const session = new SessionContext()
  const registry = new ToolRegistry()
  registry.register(READ_FILE_TOOL)
  const agent = new AgentLoop({
    client: mainClient(),
    promptEngine: makeEngine(),
    toolRegistry: registry,
    maxTurns: 3,
    contextWindow: 1_000_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    supportsVision: opts.supportsVision,
    ...(opts.visionClient ? { visionClient: opts.visionClient } : {}),
  }, session, TEST_CWD)
  return { agent, session }
}

describe('AgentLoop — 用户附图的识图分派', () => {
  it('主模型声明视觉 → 不走识图桥，原图以 image_url 进主模型请求', async () => {
    const v = makeVisionClient('不该被调用')
    const { agent, session } = makeAgent({ supportsVision: true, visionClient: v.client })

    await agent.run('看这张图', callbacks(), [IMG])

    assert.equal(v.stream.mock.callCount(), 0, '多模态主控不得调用识图桥')
    assert.ok(
      JSON.stringify(oaiMessages(session)).includes('image_url'),
      '原图必须作为 image_url 进入主模型请求',
    )
  })

  it('主模型 text-only + 识图桥 → 图片转文字描述注入，原图从请求移除', async () => {
    const v = makeVisionClient('这是一张截图，上面写着 hello')
    const { agent, session } = makeAgent({ supportsVision: false, visionClient: v.client })

    await agent.run('看这张图', callbacks(), [IMG])

    assert.equal(v.stream.mock.callCount(), 1, 'text-only 主控必须走桥一次')
    const serialized = JSON.stringify(oaiMessages(session))
    assert.ok(serialized.includes('这是一张截图'), '识图描述必须注入主模型请求')
    assert.ok(!serialized.includes('image_url'), '原图必须从主模型请求里移除')
  })

  it('主模型 text-only 且无识图桥 → 图片仍被原样送入请求（当前行为记录）', async () => {
    const { agent, session } = makeAgent({ supportsVision: false })

    await agent.run('看这张图', callbacks(), [IMG])

    const serialized = JSON.stringify(oaiMessages(session))
    assert.ok(
      serialized.includes('image_url'),
      '当前行为：无桥时图片仍进请求——与 tool-pipeline 的「不支持则丢弃」不一致，见交付报告',
    )
  })
})

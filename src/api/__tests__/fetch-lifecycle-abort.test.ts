/**
 * 2C：fetch + reader 共享 lifecycle controller。
 *
 * Bug/缺陷：超时驱动的取消（idle timer / 10min 硬顶）只调用 reader.cancel()。
 * 在 HTTP keep-alive 下，reader.cancel() 可能把底层连接还给连接池而非关闭 socket，
 * 导致 fetch 连接残留。fetch 自身的 abort signal 在这些超时路径下从未被触发。
 *
 * 修复：stream() 创建共享 lifecycle controller，把 lifecycle.signal 传给 fetch；
 * parseStreamFromReader 在 finally（任何退出路径：正常 / idle 或硬顶超时 / 错误 /
 * 用户 abort）中 abort lifecycle → undici 销毁底层连接。
 *
 * 契约（RED→GREEN）：parseStreamFromReader 接收一个 lifecycle controller，无论
 * 正常结束还是 idle 超时退出，退出后该 controller 必须处于 aborted 状态。
 * 旧实现不接收/不 abort lifecycle → controller 仍未 abort → 失败。
 */

import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIClient, type OpenAIClientConfig } from '../openai-client.js'

const CONFIG: OpenAIClientConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o',
  maxTokens: 1024,
}

const flush = () => new Promise<void>(r => setImmediate(r))

type ParseFn = (
  r: ReadableStreamDefaultReader<Uint8Array>,
  cb: unknown,
  signal?: AbortSignal,
  reasoningRef?: { content: string },
  lifecycle?: AbortController,
) => Promise<void>

describe('SSE fetch+reader shared lifecycle (2C)', () => {
  it('正常结束退出路径保留 lifecycle 以复用已完成的连接', async () => {
    const client = new OpenAIClient(CONFIG)
    const enc = new TextEncoder()
    let ctl!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({ start(c) { ctl = c } })
    const reader = new Response(stream).body!.getReader()

    const lifecycle = new AbortController()
    const parse = (client as unknown as { parseStreamFromReader: ParseFn }).parseStreamFromReader
    const p = parse.call(client, reader, { onTextDelta() {}, onStopReason() {} }, undefined, undefined, lifecycle)

    await flush()
    ctl.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"hi"},"index":0}]}\n\n'))
    await flush()
    ctl.enqueue(enc.encode('data: [DONE]\n\n'))
    await flush()
    ctl.close()
    await flush()
    await p

    assert.equal(lifecycle.signal.aborted, false, '正常结束后应保留 lifecycle 以复用连接')
  })

  it('idle 超时退出路径同样 abort lifecycle（reader.cancel 拆不掉时由 fetch abort 兜底）', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const client = new OpenAIClient(CONFIG)
      const enc = new TextEncoder()
      let ctl!: ReadableStreamDefaultController<Uint8Array>
      const stream = new ReadableStream<Uint8Array>({ start(c) { ctl = c } })
      const reader = new Response(stream).body!.getReader()

      const lifecycle = new AbortController()
      let err: Error | null = null
      const parse = (client as unknown as { parseStreamFromReader: ParseFn }).parseStreamFromReader
      const p = parse.call(client, reader, { onTextDelta() {}, onStopReason() {} }, undefined, undefined, lifecycle)
        .catch((e: Error) => { err = e })

      await flush()
      // 只发心跳注释，模型无内容 → idle timer 不被重置
      ctl.enqueue(enc.encode(': keepalive\n\n'))
      await flush()
      // 推进越过 first-byte idle 窗口（45s）
      mock.timers.tick(46_000)
      await flush()
      await flush()
      await p

      assert.ok(err, 'idle 超时应触发')
      assert.match((err as unknown as Error).message, /idle timeout/i)
      assert.equal(lifecycle.signal.aborted, true, 'idle 超时退出后也应 abort lifecycle')
    } finally {
      mock.timers.reset()
    }
  })
})

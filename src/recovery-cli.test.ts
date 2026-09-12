import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runRecoveryCli } from './recovery-cli.js'
import type { BootstrapContext } from './bootstrap.js'
import type { AgentCallbacks } from './agent/loop-types.js'
import type { ApprovalResult } from './agent/approval-edit.js'

interface MockRl {
  question: (prompt: string) => Promise<string>
  on: (event: string, handler: (...args: any[]) => void) => MockRl
  close: () => void
}

function createMockRl(lines: string[]): MockRl {
  let index = 0
  const mock: MockRl = {
    question: async () => {
      const line = lines[index++]
      return line ?? ''
    },
    on: () => mock,
    close: () => {},
  }
  return mock
}

function createMockOutput(): NodeJS.WritableStream {
  const output: { chunks: string[]; write: (chunk: string | Uint8Array) => boolean } = {
    chunks: [],
    write: (chunk) => {
      output.chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
      return true
    },
  }
  return output as unknown as NodeJS.WritableStream
}

function getOutputText(output: NodeJS.WritableStream): string {
  return (output as unknown as { chunks: string[] }).chunks.join('')
}

function createMockCtx(
  run: (prompt: string, callbacks: AgentCallbacks) => Promise<void>,
): BootstrapContext {
  return {
    agent: { run },
  } as unknown as BootstrapContext
}

function asRl(mock: MockRl) {
  return mock as unknown as import('node:readline/promises').Interface
}

describe('runRecoveryCli', () => {
  it('prints user prompt and streams assistant text', async () => {
    const rl = createMockRl(['hello', 'exit'])
    const output = createMockOutput()
    const ctx = createMockCtx(async (_prompt, callbacks) => {
      callbacks.onTextDelta('Hi')
      callbacks.onTextDelta(' there')
      callbacks.onTurnComplete({ input_tokens: 3, output_tokens: 2 }, 1)
    })

    await runRecoveryCli(ctx, { rl: asRl(rl), output })

    const text = getOutputText(output)
    assert.ok(text.includes('[you] hello'))
    assert.ok(text.includes('Hi there'))
    assert.ok(text.includes('[turn 1 complete]'))
  })

  it('prints tool uses and tool results', async () => {
    const rl = createMockRl(['run tool', 'exit'])
    const output = createMockOutput()
    const ctx = createMockCtx(async (_prompt, callbacks) => {
      callbacks.onToolUse('id1', 'bash', { command: 'echo hi' })
      callbacks.onToolResult('id1', 'bash', 'hi\nthere', false)
      callbacks.onTurnComplete({}, 1)
    })

    await runRecoveryCli(ctx, { rl: asRl(rl), output })

    const text = getOutputText(output)
    assert.ok(text.includes('[tool] bash'))
    assert.ok(text.includes('hi'))
    assert.ok(text.includes('there'))
  })

  it('reports errors from the agent', async () => {
    const rl = createMockRl(['fail', 'exit'])
    const output = createMockOutput()
    const ctx = createMockCtx(async (_prompt, callbacks) => {
      callbacks.onError(new Error('boom'))
    })

    await runRecoveryCli(ctx, { rl: asRl(rl), output })

    const text = getOutputText(output)
    assert.ok(text.includes('[error] boom'))
  })

  // issue #120 — 工具可能回传非字符串 result（对象/数字/undefined）；回调内直接
  // .length/.slice/.replace 会抛 TypeError，打断 recovery 循环或污染输出。
  it('renders non-string tool results without throwing', async () => {
    const rl = createMockRl(['run tool', 'exit'])
    const output = createMockOutput()
    const ctx = createMockCtx(async (_prompt, callbacks) => {
      callbacks.onToolResult('id1', 'bash', { stdout: 'hi' } as never, false)
      callbacks.onToolResult('id2', 'bash', 42 as never, false)
      callbacks.onToolResult('id3', 'bash', undefined as never, true)
      callbacks.onTurnComplete({}, 1)
    })

    await runRecoveryCli(ctx, { rl: asRl(rl), output })

    const text = getOutputText(output)
    assert.ok(text.includes('stdout'), 'object result serialized')
    assert.ok(text.includes('42'), 'numeric result printed')
    assert.ok(text.includes('[tool error] bash'), 'undefined result still prints a line')
  })

  it('asks for approval and passes the answer through', async () => {
    const rl = createMockRl(['approve me', 'y', 'exit'])
    const output = createMockOutput()
    let approved: boolean | ApprovalResult | undefined
    const ctx = createMockCtx(async (_prompt, callbacks) => {
      approved = await callbacks.onApprovalRequired('id1', 'bash', { command: 'ls' })
      callbacks.onTurnComplete({}, 1)
    })

    await runRecoveryCli(ctx, { rl: asRl(rl), output })

    assert.equal(approved, true)
  })
})

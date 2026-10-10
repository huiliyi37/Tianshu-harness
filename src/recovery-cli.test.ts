import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runRecoveryCli } from './recovery-cli.js'
import type { BootstrapContext } from './bootstrap.js'
import type { AgentCallbacks } from './agent/loop-types.js'
import type { ApprovalResult } from './agent/approval-edit.js'
import { SessionContext } from './agent/context.js'
import { ASK_USER_QUESTION_TOOL } from './tools/ask-user-question.js'
import { configSchema } from './config/schema.js'

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

it('captured recovery strips split terminal controls and flushes text before tools', async () => {
  const output = createMockOutput()
  const ctx = createMockCtx(async (_prompt, cb) => {
    cb.onTextDelta('safe\x1b[')
    cb.onTextDelta('31mred\x1b]0;title')
    cb.onTextDelta('\x07 end')
    cb.onToolUse('t', 'bash', { command: '\x1b[2Jecho ok' })
    cb.onTurnComplete({}, 1)
  })
  await runRecoveryCli(ctx, { rl: asRl(createMockRl(['hello', '/exit'])), output, terminalProfile: 'captured-pty' } as never)
  const text = getOutputText(output)
  assert.ok(text.includes('safered end'))
  assert.ok(!text.includes('\x1b') && !text.includes('\x07'))
  assert.ok(text.indexOf('safered end') < text.indexOf('[tool]'))
})

it('converts numbered question selections into the next actual user message', async () => {
  const output = createMockOutput()
  const prompts: string[] = []
  const ctx = createMockCtx(async (prompt, cb) => {
    prompts.push(prompt)
    if (prompts.length === 1) {
      cb.onToolUse('q', 'ask_user_question', { question: 'Choose a path', options: ['Plan first', 'Execute'] })
      cb.onToolResult('q', 'ask_user_question', '[waiting]', false, undefined, 'Choose a path\n1. Plan first\n2. Execute')
    }
    cb.onTurnComplete({}, prompts.length)
  })
  await runRecoveryCli(ctx, { rl: asRl(createMockRl(['hello', '1', '/exit'])), output })
  assert.deepEqual(prompts, ['hello', 'Plan first'])
  assert.ok(getOutputText(output).includes('Choose a path'))
})

it('offers help without sending slash commands to the model', async () => {
  const output = createMockOutput()
  const prompts: string[] = []
  await runRecoveryCli(createMockCtx(async (p) => { prompts.push(p) }), { rl: asRl(createMockRl(['/help', '/exit'])), output })
  assert.deepEqual(prompts, [])
  assert.ok(getOutputText(output).includes('/plan-approve'))
})

it('displays tool input and accepts explicit text approval', async () => {
  const output = createMockOutput()
  let approved: unknown
  const ctx = createMockCtx(async (_p, cb) => { approved = await cb.onApprovalRequired('t', 'bash', { command: 'echo review-me' }) })
  await runRecoveryCli(ctx, { rl: asRl(createMockRl(['hello', '/approve', '/exit'])), output })
  assert.equal(approved, true)
  assert.ok(getOutputText(output).includes('echo review-me'))
})

it('preserves multiple piped prompts through EOF without cursor controls', async () => {
  const { PassThrough } = await import('node:stream')
  const input = new PassThrough()
  const output = createMockOutput()
  const prompts: string[] = []
  const running = runRecoveryCli(createMockCtx(async (prompt, cb) => {
    prompts.push(prompt)
    await new Promise(resolve => setTimeout(resolve, 1))
    cb.onTurnComplete({}, prompts.length)
  }), { input, output, terminalProfile: 'captured-pty' })
  input.end('first\nsecond\n/exit\n')
  await running
  assert.deepEqual(prompts, ['first', 'second'])
  assert.ok(!getOutputText(output).includes('\x1b'))
})

it('interrupts an in-flight run with /abort and accepts another prompt', async () => {
  const { PassThrough } = await import('node:stream')
  const input = new PassThrough()
  const output = createMockOutput()
  const prompts: string[] = []
  let release: (() => void) | undefined
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const ctx = createMockCtx(async prompt => {
    prompts.push(prompt)
    if (prompt === 'first') await new Promise<void>(resolve => { release = resolve; started() })
  })
  ;(ctx.agent as unknown as { abort: () => void }).abort = () => release?.()
  const running = runRecoveryCli(ctx, { input, output })
  input.write('first\n')
  await ready
  input.write('/abort\n')
  await new Promise(resolve => setImmediate(resolve))
  input.end('second\n/exit\n')
  await running
  assert.deepEqual(prompts, ['first', 'second'])
  assert.ok(getOutputText(output).includes('Interrupt requested'))
})

it('rejects pretyped approval at EOF and never grants tool authority', async () => {
  const { PassThrough } = await import('node:stream')
  const input = new PassThrough()
  const output = createMockOutput()
  let decision: unknown
  const ctx = createMockCtx(async (_prompt, cb) => {
    decision = await cb.onApprovalRequired('t', 'bash', { command: 'must-not-run' })
  })
  ;(ctx.agent as unknown as { abort: () => void }).abort = () => {}
  const running = runRecoveryCli(ctx, { input, output })
  input.end('hello\n/approve\n')
  await running
  assert.equal(decision, false)
})

it('accepts a fresh interactive approval after showing its requested input', async () => {
  const { PassThrough } = await import('node:stream')
  const input = new PassThrough()
  let ready!: () => void
  const requested = new Promise<void>(resolve => { ready = resolve })
  const chunks: string[] = []
  const output = { write(chunk: string) { chunks.push(chunk); if (chunk.includes('Type /approve')) ready(); return true } } as NodeJS.WritableStream
  let decision: unknown
  const ctx = createMockCtx(async (_prompt, cb) => { decision = await cb.onApprovalRequired('t', 'bash', { command: 'review-this' }) })
  const running = runRecoveryCli(ctx, { input, output })
  input.write('hello\n')
  await requested
  input.write('/approve\n')
  await new Promise(resolve => setImmediate(resolve))
  input.end('/exit\n')
  await running
  assert.equal(decision, true)
  assert.ok(chunks.join('').includes('review-this'))
})

it('coalesces tiny streamed deltas and flushes the final incomplete stream', async () => {
  const output = createMockOutput()
  const ctx = createMockCtx(async (_p, cb) => { for (let i = 0; i < 100; i++) cb.onTextDelta('a') })
  await runRecoveryCli(ctx, { rl: asRl(createMockRl(['hello', '/exit'])), output })
  const chunks = (output as unknown as { chunks: string[] }).chunks
  assert.equal(chunks.filter(chunk => chunk === 'a'.repeat(100)).length, 1)
})

it('lists the actual provider key model pool rather than its stale top-level snapshot', async () => {
  const output = createMockOutput()
  const ctx = createMockCtx(async () => { throw new Error('commands must stay local') })
  ctx.config = configSchema.parse({ provider: { default: 'remote', providers: { remote: { name: 'remote', baseUrl: 'http://127.0.0.1:9/v1', models: [{ id: 'stale' }], keys: [{ id: 'key-a', models: [{ id: 'current', description: 'Current model' }] }] } } } })
  await runRecoveryCli(ctx, { rl: asRl(createMockRl(['/model', '/exit'])), output })
  const text = getOutputText(output)
  assert.ok(text.includes('remote:current — Current model'))
  assert.ok(!text.includes('remote:stale'))
})

it('cancels an active run when an interactive PTY input disconnects', async () => {
  const { PassThrough } = await import('node:stream')
  const input = new PassThrough()
  ;(input as PassThroughWithTty).isTTY = true
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  let release!: () => void
  let aborted = false
  const ctx = createMockCtx(async () => { await new Promise<void>(resolve => { release = resolve; started() }) })
  ;(ctx.agent as unknown as { abort: () => void }).abort = () => { aborted = true; release() }
  const running = runRecoveryCli(ctx, { input, output: createMockOutput(), terminalProfile: 'captured-pty' })
  input.write('hello\n')
  await ready
  input.end()
  const timeout = setTimeout(() => { release() }, 200)
  try { await running; assert.equal(aborted, true) } finally { clearTimeout(timeout) }
})
type PassThroughWithTty = import('node:stream').PassThrough & { isTTY: boolean }

async function persistedQuestion(valid = true): Promise<SessionContext> {
  const session = new SessionContext()
  session.addUserMessage('help me choose')
  const input = { question: 'Which path?', options: [
    { label: 'Plan first', ...(valid ? { recommended: true, recommendation_reason: 'Review before editing' } : {}) },
    { label: 'Execute' },
  ] }
  session.addAssistantBlocks([{ type: 'tool_use', id: 'q', name: 'ask_user_question', input }])
  const result = await ASK_USER_QUESTION_TOOL.execute({ input, toolUseId: 'q', cwd: process.cwd() })
  session.addToolResults([{ type: 'tool_result', tool_use_id: 'q', content: result.content, is_error: result.isError }])
  return session
}

it('restores an unanswered persisted question on resume without repeating its tool', async () => {
  const output = createMockOutput()
  const prompts: string[] = []
  const ctx = createMockCtx(async prompt => { prompts.push(prompt) })
  ctx.session = await persistedQuestion()
  ctx.session.addUserMessage('Runtime reminder', undefined, 'hook')
  ctx.session.addUserMessage('Resume plan execution', undefined, 'runtime_command')
  await runRecoveryCli(ctx, { rl: asRl(createMockRl(['2', '/exit'])), output })
  assert.deepEqual(prompts, ['Execute'])
  assert.ok(getOutputText(output).includes('Which path?'))
})

it('does not restore failed or already answered persisted questions', async () => {
  const prompts: string[] = []
  for (const answered of [false, true]) {
    const ctx = createMockCtx(async prompt => { prompts.push(prompt) })
    ctx.session = await persistedQuestion(answered)
    if (answered) ctx.session.addUserMessage('Plan first')
    await runRecoveryCli(ctx, { rl: asRl(createMockRl(['2', '/exit'])), output: createMockOutput() })
  }
  assert.deepEqual(prompts, ['2', '2'])
})

import { it } from 'node:test'
import assert from 'node:assert/strict'
import { runRecoveryCli } from '../recovery-cli.js'
import { ASK_USER_QUESTION_TOOL } from '../tools/ask-user-question.js'
import type { BootstrapContext } from '../bootstrap.js'
import type { AgentCallbacks } from '../agent/loop-types.js'
import type { Interface } from 'node:readline/promises'
import type { OaiMessage } from '../api/oai-types.js'
import { restoreRecoveryQuestions } from './questions.js'

async function fixture(calls: { id: string; input: Record<string, unknown> }[], answers: string[], reverseResults = false) {
  const prompts: string[] = []
  let transcript = ''
  const lines = ['hello', ...answers, '/exit']
  const ctx = { agent: {
    async run(prompt: string, callbacks: AgentCallbacks) {
      prompts.push(prompt)
      if (prompts.length !== 1) return
      // turn-stream.ts emits the whole batch before execution starts.
      for (const call of calls) callbacks.onToolUse(call.id, 'ask_user_question', call.input)
      for (const call of reverseResults ? [...calls].reverse() : calls) {
        const result = await ASK_USER_QUESTION_TOOL.execute({ input: call.input, toolUseId: call.id, cwd: process.cwd() })
        callbacks.onToolResult(call.id, 'ask_user_question', result.content, result.isError, undefined, result.uiContent)
      }
    },
  } } as unknown as BootstrapContext
  await runRecoveryCli(ctx, {
    rl: { question: async () => lines.shift() ?? '/exit', close() {} } as unknown as Interface,
    output: { write(chunk: string) { transcript += chunk; return true } } as NodeJS.WritableStream,
  })
  return { prompts, transcript }
}

it('preserves a successful question when a different call fails and never displays the wrong call content', async () => {
  const result = await fixture([
    { id: 'valid', input: { question: 'VALID: Which branch?' } },
    { id: 'invalid', input: { question: 'INVALID: Which mode?', options: ['A', 'B'] } },
  ], ['main'])
  assert.ok(result.transcript.includes('[tool result] ask_user_question:\n  VALID: Which branch?'))
  assert.ok(!result.transcript.includes('[tool result] ask_user_question:\n  INVALID: Which mode?'))
  assert.ok(result.transcript.includes('[tool error] ask_user_question:\n  错误：'))
  assert.ok(result.transcript.includes('Answer q1>'), 'The valid call must remain pending after the unrelated error')
  assert.deepEqual(result.prompts, ['hello', 'main'])
})

it('collects both successful calls in order despite their per-call q1 ids', async () => {
  const result = await fixture([
    { id: 'branch', input: { question: 'Which branch?' } },
    { id: 'path', input: { question: 'Which path?' } },
  ], ['main', 'src'])
  assert.ok(result.transcript.includes('[tool result] ask_user_question:\n  Which branch?'))
  assert.ok(result.transcript.includes('[tool result] ask_user_question:\n  Which path?'))
  assert.equal((result.transcript.match(/Answer q1>/g) ?? []).length, 2)
  assert.deepEqual(result.prompts, ['hello', 'Which branch? → main\nWhich path? → src'])
})

it('answers successful calls in original call order when concurrent results arrive in reverse order', async () => {
  const result = await fixture([
    { id: 'branch', input: { question: 'Which branch?' } },
    { id: 'path', input: { question: 'Which path?' } },
  ], ['main', 'src'], true)
  assert.ok(result.transcript.indexOf('[tool result] ask_user_question:\n  Which path?') < result.transcript.indexOf('[tool result] ask_user_question:\n  Which branch?'))
  const firstAnswer = result.transcript.indexOf('Answer q1>')
  assert.ok(result.transcript.lastIndexOf('Which branch?', firstAnswer) > result.transcript.lastIndexOf('Which path?', firstAnswer))
  assert.deepEqual(result.prompts, ['hello', 'Which branch? → main\nWhich path? → src'])
})

async function persistedBatch(calls: { id: string; input: Record<string, unknown> }[]): Promise<OaiMessage[]> {
  const assistant: OaiMessage = { role: 'assistant', content: null, tool_calls: calls.map(call => ({
    id: call.id, type: 'function', function: { name: 'ask_user_question', arguments: JSON.stringify(call.input) },
  })) }
  const tools: OaiMessage[] = []
  for (const call of calls) {
    const result = await ASK_USER_QUESTION_TOOL.execute({ input: call.input, toolUseId: call.id, cwd: process.cwd() })
    tools.push({ role: 'tool', tool_call_id: call.id, content: result.content })
  }
  return [assistant, ...tools]
}

it('restores all successful calls from the latest unanswered batch in original call order', async () => {
  const older = await persistedBatch([{ id: 'old', input: { question: 'Older question' } }])
  const latest = await persistedBatch([
    { id: 'branch', input: { question: 'Which branch?' } },
    { id: 'path', input: { question: 'Which path?' } },
  ])
  assert.deepEqual(restoreRecoveryQuestions([...older, ...latest]).map(q => q.prompt), ['Which branch?', 'Which path?'])
})

it('restores a successful call from a batch even when its last call failed validation', async () => {
  const messages = await persistedBatch([
    { id: 'valid', input: { question: 'Which branch?' } },
    { id: 'invalid', input: { question: 'Which mode?', options: ['A', 'B'] } },
  ])
  assert.deepEqual(restoreRecoveryQuestions(messages).map(q => q.prompt), ['Which branch?'])
})

it('looks past an entirely failed latest batch but never across a human answer', async () => {
  const valid = await persistedBatch([{ id: 'valid', input: { question: 'Which branch?' } }])
  const invalid = await persistedBatch([{ id: 'invalid', input: { question: 'Which mode?', options: ['A', 'B'] } }])
  assert.deepEqual(restoreRecoveryQuestions([...valid, ...invalid]).map(q => q.prompt), ['Which branch?'])
  assert.deepEqual(restoreRecoveryQuestions([
    ...valid,
    { role: 'user', origin: 'human', content: 'main' },
    ...invalid,
  ]), [])
})

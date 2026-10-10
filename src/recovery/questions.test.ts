import { it } from 'node:test'
import assert from 'node:assert/strict'
import { SessionContext } from '../agent/context.js'
import { ASK_USER_QUESTION_TOOL } from '../tools/ask-user-question.js'
import { restoreRecoveryQuestions } from './questions.js'

it('refuses malformed or invalid persisted OAI question arguments even with a waiting result', async () => {
  const input = { question: 'Which path?', options: [
    { label: 'Plan first', recommended: true, recommendation_reason: 'Review before editing' },
    { label: 'Execute' },
  ] }
  const result = await ASK_USER_QUESTION_TOOL.execute({ input, toolUseId: 'q', cwd: process.cwd() })
  assert.equal(result.isError, undefined)
  for (const args of ['{broken', JSON.stringify({ question: 'Which path?', options: [{ label: 'Plan first' }, { label: 'Execute' }] })]) {
    const session = new SessionContext()
    session.replaceMessages([
      { role: 'assistant', content: null, tool_calls: [{ id: 'q', type: 'function', function: { name: 'ask_user_question', arguments: args } }] },
      { role: 'tool', tool_call_id: 'q', content: result.content },
    ])
    assert.deepEqual(restoreRecoveryQuestions(session.getMessages()), [])
  }
})

it('does not treat an orphan question call as a successfully displayed question', () => {
  const session = new SessionContext()
  session.addAssistantBlocks([{ type: 'tool_use', id: 'q', name: 'ask_user_question', input: { question: 'Which path?' } }])
  assert.deepEqual(restoreRecoveryQuestions(session.getMessages()), [])
})

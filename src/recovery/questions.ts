import type { OaiMessage } from '../api/oai-types.js'
import { isHumanInput } from '../agent/input-origin.js'
import { composeAnswers, parseAskUserQuestions, validateAskUserQuestions, type AskAnswerDraft, type AskUserQuestionItem } from '../tools/ask-user-question.js'

/** Normalize the same selected option labels used by the desktop user-message protocol. */
export function answerDraft(question: AskUserQuestionItem, input: string): AskAnswerDraft | null {
  const value = input.trim()
  if (value === '/skip') return { selected: [], otherSelected: false, otherText: '', skipped: true }
  if (/^\d+(?:[ ,，]+\d+)*$/.test(value) && question.options.length) {
    const selected = [...new Set(value.split(/[ ,，]+/).map(n => Number(n) - 1))]
    if (selected.some(n => n < 0 || n >= question.options.length) || (!question.allowMultiple && selected.length > 1)) return null
    return { selected, otherSelected: false, otherText: '', skipped: false }
  }
  if (!value) return null
  return { selected: [], otherSelected: true, otherText: value, skipped: false }
}
export { composeAnswers }

/** Resume the last successful OAI question while no later human reply exists. */
export function restoreRecoveryQuestions(messages: OaiMessage[]): AskUserQuestionItem[] {
  const outcomes = new Map<string, boolean>()
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role === 'user' && isHumanInput(message.origin)) return []
    if (message.role === 'tool' && !outcomes.has(message.tool_call_id)) {
      // OAI tool messages do not retain is_error; the real tool's success
      // response carries this waiting marker, including when options exist.
      outcomes.set(message.tool_call_id, message.content.startsWith('[等待你的回复…]'))
    }
    if (message.role !== 'assistant') continue
    const pending: AskUserQuestionItem[] = []
    for (const call of message.tool_calls ?? []) {
      if (call.function.name !== 'ask_user_question') continue
      if (!outcomes.get(call.id)) continue
      try {
        const input: unknown = JSON.parse(call.function.arguments)
        if (!input || typeof input !== 'object' || Array.isArray(input)) continue
        const questions = parseAskUserQuestions(input as Record<string, unknown>)
        if (!validateAskUserQuestions(questions)) pending.push(...questions)
      } catch { /* Ignore failed calls without discarding successful siblings. */ }
    }
    if (pending.length) return pending
  }
  return []
}

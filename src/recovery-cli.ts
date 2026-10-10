/** Plain, line-oriented frontend for limited terminals and explicit recovery. */
import type { Interface as ReadlineInterface } from 'node:readline/promises'
import type { BootstrapContext } from './bootstrap.js'
import type { AgentCallbacks } from './agent/loop-types.js'
import { parseAskUserQuestions, renderAskUserQuestionText, type AskUserQuestionItem, type AskAnswerDraft } from './tools/ask-user-question.js'
import { restorePlanModeFromMeta } from './plan/restore-plan-mode.js'
import { RecoveryOutput } from './recovery/output.js'
import { RecoveryInput } from './recovery/input.js'
import { RecoveryCommands } from './recovery/commands.js'
import { answerDraft, composeAnswers, restoreRecoveryQuestions } from './recovery/questions.js'

export interface RecoveryCliOptions {
  rl?: ReadlineInterface
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
  terminalProfile?: 'native' | 'captured-pty'
}
const EXIT_COMMANDS = new Set(['/exit', '/quit', 'exit', 'quit'])

export async function runRecoveryCli(ctx: BootstrapContext, options: RecoveryCliOptions = {}): Promise<void> {
  const output = new RecoveryOutput(options.output ?? process.stdout)
  const metadata = ctx.persist?.loadMetadata()
  if (metadata?.planModeState === 'planning') {
    const draft = restorePlanModeFromMeta(ctx.agent, ctx.cwd, metadata)
    if (draft) output.line(`[plan] Restored planning mode: ${draft}. Source writes remain blocked until approval.`)
  }
  let active = false
  let agentRunning = false
  let stopped = false
  let interrupted = false
  let pendingQuestions: AskUserQuestionItem[] = restoreRecoveryQuestions(ctx.session?.getMessages?.() ?? [])
  const questionCalls = new Map<string, { questions: AskUserQuestionItem[]; success: boolean }>()
  let approvalTail: Promise<void> = Promise.resolve()
  const interrupt = (exit: boolean) => {
    if (!active) return false
    interrupted = true
    if (exit) stopped = true
    if (agentRunning) ctx.agent.abort?.()
    output.line(exit ? '[recovery] Exiting.' : '[recovery] Interrupt requested.')
    return true
  }
  const input = new RecoveryInput(options.input ?? process.stdin, output, options.rl, interrupt)
  const onSignal = () => {
    if (!active) stopped = true
    interrupt(false)
    input.cancelWait()
  }
  process.on('SIGINT', onSignal)
  const commands = new RecoveryCommands(ctx, output, () => active && !stopped && !interrupted)
  output.line(`[recovery] RIVET Recovery CLI${options.terminalProfile === 'captured-pty' ? ' (captured-pty: plain text)' : ''}`)
  output.line('[recovery] Type a prompt and press Enter. /help shows commands; /abort interrupts; /exit leaves.\n')

  const callbacks: AgentCallbacks = {
    onTextDelta: text => output.delta(text),
    onThinkingDelta: () => {},
    onToolUse: (id, name, toolInput) => {
      output.line(`\n[tool] ${name}(${JSON.stringify(toolInput)})`)
      if (name === 'ask_user_question') questionCalls.set(id, { questions: parseAskUserQuestions(toolInput), success: false })
    },
    onToolResult: (id, name, result, isError, _rawPath, uiContent) => {
      const text = typeof result === 'string' ? result : JSON.stringify(result ?? '')
      const call = name === 'ask_user_question' ? questionCalls.get(id) : undefined
      if (call) call.success = !isError
      const questions = call?.questions
      const display = questions?.length && !isError ? renderAskUserQuestionText(questions) : (uiContent ?? text)
      // Questions must never be truncated: every displayed option is selectable.
      const snippet = name === 'ask_user_question' ? display : display.length > 2000 ? `${display.slice(0, 2000)}...` : display
      output.line(`${isError ? '[tool error]' : '[tool result]'} ${name}:\n  ${snippet.replace(/\n/g, '\n  ')}`)
    },
    onTurnComplete: (usage, turnNumber) => output.line(`\n[turn ${turnNumber} complete]${usage && Object.keys(usage).length ? ` usage: ${JSON.stringify(usage)}` : ''}`),
    onError: error => output.line(`\n[error] ${error.message}`),
    onAbort: reason => { pendingQuestions = []; questionCalls.clear(); output.line(`\n[abort] ${reason ?? 'interrupted'}`) },
    onApprovalRequired: (id, name, toolInput) => {
      const decision = approvalTail.then(async () => {
        if (interrupted || stopped) return false
        output.line(`\n[approval ${id}] ${name}\n${JSON.stringify(toolInput, null, 2)}`)
        const answer = await input.read('Type /approve (or yes) to allow; /reject to deny: ', true)
        if (answer === null) { interrupt(false); return false }
        if (EXIT_COMMANDS.has(answer.trim().toLowerCase())) { interrupt(true); return false }
        if (answer.trim() === '/abort') { interrupt(false); return false }
        return !interrupted && !stopped && ['/approve', 'y', 'yes'].includes(answer.trim().toLowerCase())
      })
      approvalTail = decision.then(() => {}, () => {})
      return decision
    },
    onSteerDrain: () => null,
    onAutonomyCheckpoint: info => output.line(`[checkpoint] ${info.digest}\nType continue to resume.`),
    onPhaseChange: (_phase, detail) => { if (detail?.reason) output.line(`[status] ${detail.reason}`) },
  }
  try {
    while (!stopped) {
      active = false
      interrupted = false
      let prompt: string | undefined
      let origin: 'human' | 'runtime_command' = 'human'
      if (pendingQuestions.length) {
        const questions = pendingQuestions
        pendingQuestions = []
        const drafts: AskAnswerDraft[] = []
        for (const question of questions) {
          output.line(renderAskUserQuestionText([question]))
          while (!stopped) {
            const answer = await input.read(`Answer ${question.id}> `)
            if (answer === null) { stopped = true; break }
            const text = answer.trim()
            if (EXIT_COMMANDS.has(text.toLowerCase())) { stopped = true; break }
            if (text === '/abort') { interrupted = true; break }
            if (text.startsWith('/') && text !== '/skip') {
              // Inspect/help commands are available while answering; state-changing
              // commands remain explicit fresh prompts after the question is handled.
              if (['/help', '/plan-list', '/plan-view'].includes(text.split(/\s+/)[0]!)) {
                active = true
                try { await commands.handle(text) } finally { active = false }
                if (interrupted) break
              }
              else output.line('[question] Answer with option numbers, text, or /skip; /exit leaves.')
              continue
            }
            const draft = answerDraft(question, text)
            if (!draft) { output.line('[question] Invalid selection. Use listed numbers or your own text.'); continue }
            drafts.push(draft)
            break
          }
          if (stopped || interrupted) break
        }
        if (stopped || interrupted) continue
        prompt = composeAnswers(questions, drafts)
      } else {
        const line = await input.read('> ')
        if (line === null) break
        const trimmed = line.trim()
        if (!trimmed) continue
        if (EXIT_COMMANDS.has(trimmed.toLowerCase())) break
        active = true
        try {
          const command = await commands.handle(trimmed)
          if (command.handled && !command.prompt) continue
          prompt = command.prompt ?? trimmed
          if (command.prompt) origin = 'runtime_command'
        } catch (error) { output.line(`[error] ${(error as Error).message}`); continue }
        finally { active = false }
      }
      if (!prompt || stopped || interrupted) continue
      output.line(`\n[you] ${prompt}`)
      active = true
      agentRunning = true
      try { await ctx.agent.run(prompt, callbacks, undefined, { origin }) }
      catch (error) { output.line(`\n[error] ${(error as Error).message}`) }
      finally {
        active = false
        agentRunning = false
        pendingQuestions = interrupted ? [] : [...questionCalls.values()].filter(call => call.success).flatMap(call => call.questions)
        questionCalls.clear()
        output.line()
      }
    }
  } finally {
    process.off('SIGINT', onSignal)
    input.close()
    output.close()
  }
}

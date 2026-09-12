/**
 * RIVET_FORCE_RECOVERY_CLI readline fallback CLI.
 *
 * A minimal terminal interface used when the T9 ANSI engine cannot start or is
 * explicitly bypassed. It wires AgentLoop callbacks to plain stdout text and
 * reads user input through `node:readline/promises`.
 */

import { createInterface, type Interface as ReadlineInterface } from 'node:readline/promises'
import type { BootstrapContext } from './bootstrap.js'
import type { AgentCallbacks } from './agent/loop-types.js'

export interface RecoveryCliOptions {
  /** Readline interface; defaults to a stdin/stdout interface with prompt "> ". */
  rl?: ReadlineInterface
  /** Input stream when creating the default readline interface. */
  input?: NodeJS.ReadableStream
  /** Output stream when creating the default readline interface. */
  output?: NodeJS.WritableStream
}

const EXIT_COMMANDS = new Set(['/exit', '/quit', 'exit', 'quit'])

export async function runRecoveryCli(ctx: BootstrapContext, options: RecoveryCliOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const rl = options.rl ?? createInterface({ input, output, prompt: '> ' })

  const write = (s: string) => {
    output.write(s)
  }
  const writeln = (s: string) => write(s + '\n')

  writeln('[recovery] RIVET Recovery CLI (readline fallback)')
  writeln('[recovery] Type a prompt and press Enter. Type /exit or /quit to leave.\n')

  let running = true
  const stop = () => {
    running = false
  }

  try {
    while (running) {
      const line = await rl.question('> ')
      const trimmed = line.trim()
      if (!trimmed) continue
      if (EXIT_COMMANDS.has(trimmed)) {
        break
      }

      writeln(`\n[you] ${trimmed}`)

      const callbacks = buildRecoveryCallbacks(rl, output)
      try {
        await ctx.agent.run(trimmed, callbacks)
      } catch (err) {
        writeln(`\n[error] ${(err as Error).message}`)
      }
      writeln('')
    }
  } finally {
    stop()
    rl.close()
  }
}

function buildRecoveryCallbacks(rl: ReadlineInterface, output: NodeJS.WritableStream): AgentCallbacks {
  const write = (s: string) => {
    output.write(s)
  }
  const writeln = (s: string) => write(s + '\n')

  return {
    onTextDelta: (text) => {
      write(text)
    },
    onThinkingDelta: () => {
      // Recovery CLI omits thinking content to keep the transcript readable.
    },
    onToolUse: (_id, name, input) => {
      writeln(`\n[tool] ${name}(${JSON.stringify(input)})`)
    },
    onToolResult: (_id, name, result, isError) => {
      const prefix = isError ? '[tool error]' : '[tool result]'
      // issue #120 — result 不保证是字符串（工具可能回传对象/数字/undefined）：
      // 直接调 .length/.slice/.replace 会在回调内抛 TypeError，打断 recovery 循环。
      const text = typeof result === 'string' ? result : JSON.stringify(result ?? '')
      const snippet = text.length > 500 ? `${text.slice(0, 500)}...` : text
      writeln(`${prefix} ${name}:\n  ${snippet.replace(/\n/g, '\n  ')}`)
    },
    onTurnComplete: (usage, turnNumber) => {
      if (usage && Object.keys(usage).length > 0) {
        writeln(`\n[turn ${turnNumber} complete] usage: ${JSON.stringify(usage)}`)
      } else {
        writeln(`\n[turn ${turnNumber} complete]`)
      }
    },
    onError: (error) => {
      writeln(`\n[error] ${error.message}`)
    },
    onAbort: (reason) => {
      writeln(`\n[abort] ${reason ?? 'interrupted'}`)
    },
    onApprovalRequired: async (_id, name, _input) => {
      const answer = await rl.question(`Approve ${name}? (y/N) `)
      const normalized = answer.trim().toLowerCase()
      return normalized === 'y' || normalized === 'yes'
    },
    onCheckpoint: () => {},
    onPhaseChange: () => {},
    onIntentNote: () => {},
    onSteerDrain: () => null,
    onDelegationActivity: () => {},
  }
}

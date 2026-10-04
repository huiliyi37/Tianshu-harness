import { basename } from 'node:path'
import type { ToolResult, VerificationMetadata } from '../tools/types.js'

/** This parser only classifies an already executed command; it never executes it. */
export function inferBashVerificationScope(command: string): Pick<VerificationMetadata, 'scope' | 'targetFiles'> {
  if (/[;&|<>`\n\r]/.test(command)) return { scope: 'targeted' }
  const tokens = command.match(/"[^"]*"|'[^']*'|[^\s]+/g)?.map(t => t.replace(/^['"]|['"]$/g, '')) ?? []
  const executable = basename((tokens[0] ?? '').replaceAll('\\', '/')).replace(/\.(?:exe|cmd)$/i, '')
  const args = tokens.slice(1)
  const targetFiles = [...new Set(args.filter(arg => !arg.startsWith('-')
    && /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|sh)$/.test(arg)))]
  if (targetFiles.length > 0) return { scope: 'targeted', targetFiles }

  // Only recognizable unfiltered invocations attest to a full run. Unknown
  // scripts, selector flags, alternate projects and shell chains stay targeted.
  const invocation = [executable, ...args].join(' ')
  const full = /^(?:npm|pnpm|yarn) (?:test|run (?:test|typecheck|lint|build))$/.test(invocation)
    || /^(?:node|tsx) --test$/.test(invocation)
    || /^(?:npx )?(?:tsc(?: --noEmit)?|vitest(?: run)?|jest|pytest)$/.test(invocation)
    || /^(?:cargo (?:test|check)|go (?:test|vet|build) \.\/\.\.\.)$/.test(invocation)
  return { scope: full ? 'full' : 'targeted' }
}

function count(output: string, pattern: RegExp): number {
  const match = output.match(pattern)
  return match ? Number.parseInt(match.slice(1).find(value => value !== undefined) ?? '0', 10) : 0
}

export function buildBashVerification(
  command: string,
  result: ToolResult | undefined,
  outcome: { content: string; isError: boolean; errorClass?: string },
): VerificationMetadata {
  const output = outcome.content
  const passed = count(output, /(?:ℹ|#)\s+pass\s+(\d+)|✅\s+(\d+)\s+passed|Tests?\s+(\d+)\s+passed/i)
  const failed = count(output, /(?:ℹ|#)\s+fail\s+(\d+)|❌\s+(\d+)\s+failed|Tests?\s+(\d+)\s+failed/i)
  const skipped = count(output, /(?:ℹ|#)\s+(?:skip|skipped)\s+(\d+)/i)
  const exitCode = typeof result?.exitCode === 'number' && Number.isFinite(result.exitCode) ? result.exitCode : undefined
  const errorClass = result?.errorClass ?? (outcome.isError ? outcome.errorClass : undefined)
  const timedOut = errorClass === 'timeout' || /timed out after \d+s/i.test(output)
  const status = outcome.isError || result?.isError || timedOut || failed > 0 || (exitCode !== undefined && exitCode !== 0)
    ? 'failed' : exitCode === 0 ? 'passed' : 'blocked'
  const failureKind = timedOut ? 'timeout'
    : status === 'failed' && (errorClass === 'environment' || errorClass === 'exec-failure') ? 'tool_invocation_failure'
    : status === 'failed' && exitCode !== undefined && result?.isError === false ? 'test_failure'
    : undefined
  return {
    command, status, ...inferBashVerificationScope(command), passed, failed, skipped,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(failureKind ? { failureKind } : {}),
  }
}

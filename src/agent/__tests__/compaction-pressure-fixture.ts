import assert from 'node:assert/strict'
import type { OaiMessage } from '../../api/oai-types.js'
import type { ContextBudgetSnapshot } from '../../server/protocol.js'
import { estimateOaiTokens } from '../../compact/micro.js'

const DETAIL = 'status detail. '

/** Fit only the synthetic history, never the window, reserve or production gate.
 * A fresh real PromptEngine measures the caller's platform-specific fixed prefix. */
export function createBudgetedCompactionHistory(count: number,
  measure: (messages: OaiMessage[]) => ContextBudgetSnapshot, maxRepeats = 1067): OaiMessage[] {
  const history = (repeats: number): OaiMessage[] => Array.from({ length: count }, (_, index): OaiMessage => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `Archived status exchange ${index}: ${DETAIL.repeat(repeats)}`,
  }))
  const original = history(maxRepeats)
  const baseline = measure(original)
  // Leave one output-reserve worth of slack for turn-start runtime appendices.
  const target = baseline.inputBudget - baseline.outputReserve
  const fits = (messages: OaiMessage[]): boolean => {
    const budget = measure(messages)
    assert.equal(budget.windowTokens, baseline.windowTokens, 'fixture calibration must not resize the window')
    assert.equal(budget.outputReserve, baseline.outputReserve, 'fixture calibration must not reduce output reserve')
    assert.equal(budget.inputBudget, baseline.inputBudget)
    return budget.inputTokens <= target && budget.state !== 'blocked'
  }
  if (baseline.inputTokens <= target && baseline.state !== 'blocked') return original
  let low = 1, high = maxRepeats, best: OaiMessage[] | undefined
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = history(middle)
    if (fits(candidate)) { best = candidate; low = middle + 1 }
    else high = middle - 1
  }
  assert.ok(best, 'the fixed prompt must leave room for a real initial history')
  return best
}

/** Generate genuine pressure from the live occupancy instead of a magic byte count. */
export function createCompactionPressureInput(occupancy: number, window: number, prefix: string, minimumAddedTokens = 0): string {
  const start = `${prefix}\n`
  const prefixTokens = estimateOaiTokens([{ role: 'user', content: start }])
  const unitTokens = estimateOaiTokens([{ role: 'user', content: DETAIL.repeat(1000) }]) / 1000
  const needed = Math.max(Math.floor(window * 0.955) - occupancy, minimumAddedTokens)
  const repeats = Math.max(1, Math.ceil((needed - prefixTokens) / unitTokens))
  const input = start + DETAIL.repeat(repeats)
  const projected = occupancy + estimateOaiTokens([{ role: 'user', content: input }])
  assert.ok(projected > window * 0.95 && projected < window,
    'the new real user input must cross 95% without exceeding the fixed context window')
  return input
}

/** Windows rename-to-directory reports EPERM. Accept it only on Windows and only
 * for the exact snapshot path deliberately replaced by the filesystem fixture. */
export function isSnapshotDirectoryCollision(error: unknown, target: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!(error instanceof Error)) return false
  const failure = error as NodeJS.ErrnoException & { dest?: string }
  const expected = ['EISDIR', 'ENOTDIR', 'EEXIST', ...(platform === 'win32' ? ['EPERM'] : [])]
  return expected.includes(failure.code ?? '') && (failure.path === target || failure.dest === target)
}

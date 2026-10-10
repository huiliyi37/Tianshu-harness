/** Convergence protection is separate from the execution watchdog budget. */
export function verificationWaitBudget(input: Record<string, unknown>, startedAt: number): { ms: number; source: 'default' | 'explicit' | 'invalid' } {
  if (!Object.prototype.hasOwnProperty.call(input, 'timeout')) return { ms: 600_000, source: 'default' }
  const value = input.timeout
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && Number.isSafeInteger(startedAt + value)
    ? { ms: value, source: 'explicit' }
    : { ms: 600_000, source: 'invalid' }
}

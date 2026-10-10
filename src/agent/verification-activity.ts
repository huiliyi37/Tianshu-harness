import { classifyVerificationIntent, type VerificationPurpose } from './verification-intent.js'
import { classifyBashCommandActivity } from './tool-target.js'

/** Consumer policy: readback/radio/production flow count test and typecheck attempts. */
export function verificationAttempted(name: string, input?: Record<string, unknown>, cwd = ''): boolean {
  if (['run_tests', 'typecheck', 'lsp_diagnostics'].includes(name)) return true
  return name === 'bash' && typeof input?.command === 'string'
    && ['test', 'typecheck'].includes(classifyVerificationIntent(input.command, cwd).purpose)
}
/** Broad intent policy for course families, workers and self-verification; never proof of passing. */
export function isVerificationIntent(command: string, cwd = ''): boolean {
  return classifyVerificationIntent(command, cwd).purpose !== 'none'
}
export function verificationToolFacts(name: string, input?: Record<string, unknown>, cwd = ''):
  { verificationAttempted: boolean; verificationPurpose: VerificationPurpose; readonlyShell?: boolean } {
  const command = name === 'bash' && typeof input?.command === 'string' ? input.command : null
  const purpose = command !== null ? classifyVerificationIntent(command, cwd).purpose
    : name === 'run_tests' ? 'test' : ['typecheck', 'lsp_diagnostics'].includes(name) ? 'typecheck' : 'none'
  return { verificationAttempted: ['test', 'typecheck'].includes(purpose), verificationPurpose: purpose,
    ...(command !== null ? { readonlyShell: classifyBashCommandActivity(command) === 'readonly' } : {}) }
}
export function recentVerification(history: ReadonlyArray<{ verificationAttempted?: boolean; modelTurn?: number }>, turn: number) {
  return history.filter(h => h.verificationAttempted && h.modelTurn !== undefined && h.modelTurn <= turn && h.modelTurn >= turn - 1).at(-1)
}

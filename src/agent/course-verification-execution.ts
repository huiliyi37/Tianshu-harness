import { classifyVerificationIntent, nativeVerificationStartIntent, type VerificationExecutionIntent } from './verification-intent.js'
import { createVerificationRecorder } from './verification-recorder.js'
export { createVerificationRecorder } from './verification-recorder.js'
import type { VerificationMetadata } from '../tools/types.js'

export interface CourseExecutionCallbacks {
  onToolExecutionStart?: () => void
  onVerificationExecutionStart?: (intent: VerificationExecutionIntent) => number | void
  onVerificationExecutionSettled?: (sequence: number, result: VerificationMetadata) => void
}

export function courseExecutionCallbacks(deps: CourseExecutionCallbacks): CourseExecutionCallbacks {
  return { onToolExecutionStart: deps.onToolExecutionStart, onVerificationExecutionStart: deps.onVerificationExecutionStart,
    onVerificationExecutionSettled: deps.onVerificationExecutionSettled }
}

/** Only the actual, approved execution boundary may call this. */
export function beginCourseToolExecution(
  deps: CourseExecutionCallbacks & Parameters<typeof createVerificationRecorder>[0] & { cwd: string },
  name: string, input: Record<string, unknown>,
) {
  deps.onToolExecutionStart?.()
  const intent = name === 'bash' ? typeof input.command === 'string' ? classifyVerificationIntent(input.command, deps.cwd) : null
    : nativeVerificationStartIntent(name, deps.cwd)
  const sequence = intent && intent.purpose !== 'none' ? deps.onVerificationExecutionStart?.(intent) : undefined
  // This closure preserves the launch version through background completion.
  return createVerificationRecorder({ ...deps, onRecorded: verification => {
    if (typeof sequence === 'number') deps.onVerificationExecutionSettled?.(sequence, verification)
  } })
}

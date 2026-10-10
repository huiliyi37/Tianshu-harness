import { createHash } from 'node:crypto'
import { evaluateConvergence, convergenceTextObservation, hasDiagnosticProbes, type ConvergenceInput, type ConvergenceResult } from './convergence-detector.js'

/** Internal telemetry only; this does not change session events or sidecar APIs. */
export type RecordedConvergenceInput = Omit<ConvergenceInput, 'evidenceState'> & {
  evidenceState: Omit<ConvergenceInput['evidenceState'], 'filesModified' | 'filesRead'> & {
    filesModified: string[]; filesRead: string[]
  }
}

export function recordConvergenceInput(input: ConvergenceInput): RecordedConvergenceInput {
  const digest = (value: string) => createHash('sha256').update(value).digest('hex')
  // Own every nested value: the live history and evidence continue changing
  // after this boundary, whereas a replay must reproduce this exact decision.
  return JSON.parse(JSON.stringify({ ...input, textFingerprints: undefined, runtimeAdvice: undefined,
    textObservation: input.textObservation ?? convergenceTextObservation(input.textFingerprints ?? []),
    toolFingerprints: input.toolFingerprints?.map(digest),
    recentToolHistory: input.recentToolHistory.map(entry => ({ tool: entry.tool, status: entry.status,
      bashActivity: entry.bashActivity, writeOutcome: entry.writeOutcome,
      argsHash: digest(entry.argsHash ?? entry.target),
      target: `${hasDiagnosticProbes([entry]) ? entry.tool === 'bash' ? 'node -e ' : 'error ' : ''}${digest(entry.target)}`,
    })), evidenceState: { deliveryStatus: input.evidenceState.deliveryStatus,
    filesModified: [...input.evidenceState.filesModified].map(digest), filesRead: [...input.evidenceState.filesRead].map(digest),
  } })) as RecordedConvergenceInput
}

export function replayConvergenceInput(input: RecordedConvergenceInput): ConvergenceResult {
  return evaluateConvergence({ ...input, evidenceState: { ...input.evidenceState,
    filesModified: new Set(input.evidenceState.filesModified), filesRead: new Set(input.evidenceState.filesRead),
  } })
}

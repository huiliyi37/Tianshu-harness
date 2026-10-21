import type { VerificationMetadata } from '../tools/types.js'
import { verificationMeta } from '../tools/verification-facts.js'
import type { TaskLedger } from './task-ledger.js'
import type { EvidenceTracker } from './evidence.js'
import { candidateSnapshotRef } from './candidate-snapshot-ref.js'

export function createVerificationRecorder(deps: {
  taskLedger?: TaskLedger; evidence: Pick<EvidenceTracker, 'trackVerification'>
  cwd?: string
  destructiveGate?: { noteVerification(status: VerificationMetadata['status']): void }
  onRecorded?: (verification: VerificationMetadata) => void
}): (verification: VerificationMetadata, event?: { command?: string; meta?: Record<string, unknown> }) => void {
  const fingerprint = deps.taskLedger?.captureVerificationFingerprint?.()
  const snapshotFingerprint = deps.taskLedger?.captureVerificationFingerprint?.(true)
  const seen = new Set<string>()
  return (verification, event) => {
    if (verification.executionId && seen.has(verification.executionId)) return
    if (verification.executionId) seen.add(verification.executionId)
    const isolated = verification.verificationPhase === 'isolated' && !!verification.snapshotRef
    const captured = isolated ? snapshotFingerprint : fingerprint
    const actualSnapshot = isolated && verification.coverage?.executionRoot
      ? deps.taskLedger?.captureVerificationFingerprint?.(true, verification.coverage.executionRoot) : undefined
    const candidateRef = verification.candidateFiles?.length && deps.cwd
      ? candidateSnapshotRef(deps.cwd, verification.candidateFiles) : undefined
    const v = verification.candidateFiles?.length
      ? { ...verification, workspaceFingerprint: verification.snapshotRef,
          stale: verification.stale || !verification.snapshotRef || candidateRef !== verification.snapshotRef }
      : { ...verification,
          ...(captured !== undefined ? { workspaceFingerprint: captured,
            stale: verification.stale || !captured || captured !== deps.taskLedger?.captureVerificationFingerprint?.(isolated)
              || actualSnapshot !== undefined && actualSnapshot !== captured } : {}),
        }
    deps.taskLedger?.record({ type: 'verification', command: event?.command ?? v.command, status: v.status, meta: { ...verificationMeta(v, !!event?.command), ...event?.meta } })
    deps.evidence.trackVerification(v)
    deps.onRecorded?.(v)
    if (!v.stale) deps.destructiveGate?.noteVerification(v.status)
  }
}

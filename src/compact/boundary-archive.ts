import type { OaiMessage } from '../api/oai-types.js'
import { CACHE_ANCHOR_MESSAGES, staleRoundThresholds } from './constants.js'
import { ARTIFACT_MARKER_REGEX } from './recovery-ref.js'
import { microToolRewriteIndices } from './micro.js'

/**
 * W1-A3: compact-boundary archive adapter (data side).
 *
 * micro/stale are pure transforms and must NOT depend on ArtifactStore. The
 * boundary coordinator instead:
 *   1. collects the tool messages this rewrite would lossily truncate WITHOUT
 *      an existing recovery reference (these collectors),
 *   2. archives their originals via an injected callback,
 *   3. hands the resulting `message index → artifactId` map to the pure
 *      transform as plain data.
 *
 * Messages whose archive failed are absent from the map; the transforms keep
 * those originals intact (fail-open to context occupancy — never fail-closed
 * into unrecoverable loss).
 */
export interface RecoveryArchiveCandidate {
  /** Message index within the messages array handed to the transform. */
  index: number
  content: string
  toolCallId?: string
}

/** Callback signature the boundary coordinator uses to archive originals. */
export type ArchiveForRecovery = (
  candidates: RecoveryArchiveCandidate[],
) => Promise<ReadonlyMap<number, string>>

function hasTrailingMarker(content: string): boolean {
  return ARTIFACT_MARKER_REGEX.test(content)
}

/** Candidates the stale-round transform would truncate without a recovery ref. */
export function collectStaleArchiveCandidates(
  messages: OaiMessage[],
  contextWindow: number,
  previewCharsOverride?: number,
): RecoveryArchiveCandidate[] {
  const thresholds = staleRoundThresholds(contextWindow)
  const previewChars = previewCharsOverride ?? thresholds.previewChars
  if (messages.length <= CACHE_ANCHOR_MESSAGES + thresholds.recentToKeep) return []
  const recentStart = Math.max(CACHE_ANCHOR_MESSAGES, messages.length - thresholds.recentToKeep)

  const out: RecoveryArchiveCandidate[] = []
  for (let idx = CACHE_ANCHOR_MESSAGES; idx < recentStart; idx++) {
    const msg = messages[idx]!
    if (msg.role !== 'tool') continue
    if (typeof msg.content !== 'string') continue
    if (msg.content.length <= previewChars) continue
    if (hasTrailingMarker(msg.content)) continue
    out.push({ index: idx, content: msg.content, toolCallId: msg.tool_call_id })
  }
  return out
}

/** Candidates either micro-compact lossy branch would cut without a recovery ref. */
export function collectMicroArchiveCandidates(
  messages: OaiMessage[],
  contextWindow: number,
): RecoveryArchiveCandidate[] {
  const out: RecoveryArchiveCandidate[] = []
  for (const idx of microToolRewriteIndices(messages, contextWindow)) {
    const msg = messages[idx]!
    if (msg.role !== 'tool') continue
    if (typeof msg.content !== 'string') continue
    if (hasTrailingMarker(msg.content)) continue
    out.push({ index: idx, content: msg.content, toolCallId: msg.tool_call_id })
  }
  return out
}

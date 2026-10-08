import { createHash } from 'node:crypto'
import type { ContextAnchor } from './types.js'

export type ContextClaimKind =
  | 'user_constraint'
  | 'user_preference'
  | 'decision'
  | 'file_observation'
  | 'verification_fact'
  | 'failure_pattern'
  | 'security_finding'
  | 'worker_finding'
  | 'project_rule'

export type ContextClaimScope = 'turn' | 'session' | 'project' | 'repo' | 'global'

export type ContextClaimStatus =
  | 'ephemeral'
  | 'active'
  | 'durable_candidate'
  | 'durable'
  | 'stale'
  | 'conflicted'
  | 'quarantined'

export type EvidenceKind = 'user_message' | 'assistant_message' | 'tool_result' | 'file' | 'test' | 'worker' | 'hook' | 'compact' | 'resume'
export type ContextActor = 'user' | 'assistant' | 'tool' | 'worker' | 'hook' | 'compact' | 'resume'

export interface EvidenceRef {
  id: string
  kind: EvidenceKind
  summary: string
  path?: string
  createdAt: number
}

export interface ConsumerRef {
  id: string
  kind: 'prompt' | 'tool' | 'test' | 'worker'
  usedAt: number
}

export interface ClaimSource {
  actor: ContextActor
  sessionId: string
  turn: number
  eventId: string
}

export interface ContextClaim {
  id: string
  kind: ContextClaimKind
  scope: ContextClaimScope
  status: ContextClaimStatus
  text: string
  confidence: number
  fitness: number
  source: ClaimSource
  evidence: EvidenceRef[]
  consumers: ConsumerRef[]
  counterevidence: EvidenceRef[]
  createdAt: number
  lastUsedAt: number
  expiresAt?: number
  tags: string[]
}

export interface ClaimProposal {
  kind: ContextClaimKind
  scope: ContextClaimScope
  text: string
  confidence: number
  fitness: number
  source: ClaimSource
  evidence: EvidenceRef[]
  createdAt: number
  expiresAt?: number
  tags: string[]
}

export interface ClaimProposalMeta extends ClaimSource {
  createdAt: number
}

function normalizeClaimText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

function claimIdFor(proposal: ClaimProposal): string {
  return createHash('sha256')
    .update(JSON.stringify({
      kind: proposal.kind,
      scope: proposal.scope,
      text: normalizeClaimText(proposal.text),
      sessionId: proposal.source.sessionId,
      observationEventId: proposal.kind === 'file_observation' ? proposal.source.eventId : undefined,
    }))
    .digest('hex')
    .slice(0, 12)
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function kindFromAnchor(anchor: ContextAnchor): ContextClaimKind {
  if (anchor.kind === 'user_constraint') return 'user_constraint'
  if (anchor.kind === 'user_preference') return 'user_preference'
  if (anchor.kind === 'decision') return 'decision'
  if (anchor.kind === 'verification') return 'verification_fact'
  if (anchor.kind === 'error') return 'failure_pattern'
  return 'file_observation'
}

function confidenceFromAnchor(anchor: ContextAnchor): number {
  if (anchor.kind === 'user_constraint') return 0.9
  if (anchor.kind === 'decision') return 0.82
  if (anchor.kind === 'verification') return 0.88
  return 0.7
}

export function claimProposalFromAnchor(anchor: ContextAnchor, meta: ClaimProposalMeta): ClaimProposal {
  return {
    kind: kindFromAnchor(anchor),
    scope: 'session',
    text: anchor.text,
    confidence: confidenceFromAnchor(anchor),
    fitness: anchor.salience,
    source: {
      actor: meta.actor,
      sessionId: meta.sessionId,
      turn: meta.turn,
      eventId: meta.eventId,
    },
    evidence: [{
      id: `${meta.eventId}:anchor`,
      kind: meta.actor === 'user' ? 'user_message' : 'assistant_message',
      summary: anchor.text,
      createdAt: meta.createdAt,
    }],
    createdAt: meta.createdAt,
    tags: ['anchor', anchor.kind],
  }
}

export function createClaimFromProposal(proposal: ClaimProposal): ContextClaim {
  return {
    id: claimIdFor(proposal),
    kind: proposal.kind,
    scope: proposal.scope,
    status: 'active',
    text: proposal.text,
    confidence: proposal.confidence,
    fitness: proposal.fitness,
    source: proposal.source,
    evidence: [...proposal.evidence],
    consumers: [],
    counterevidence: [],
    createdAt: proposal.createdAt,
    lastUsedAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
    tags: [...proposal.tags],
  }
}

export function isPromptEligibleClaim(claim: ContextClaim, now = Date.now()): boolean {
  if (claim.expiresAt !== undefined && claim.expiresAt <= now) return false
  return claim.status === 'active' || claim.status === 'durable_candidate' || claim.status === 'durable'
}

export const MAX_PROMPT_CLAIMS = 20

export function renderActiveClaimsBlock(claims: ContextClaim[]): string {
  const active = claims
    .filter(isPromptEligibleClaim)
    .sort((a, b) => b.fitness - a.fitness || b.confidence - a.confidence || a.createdAt - b.createdAt)
    .slice(0, MAX_PROMPT_CLAIMS)

  if (active.length === 0) return ''

  const entries = active.map(claim => {
    const evidence = claim.evidence[0]?.id ?? ''
    return `  <claim id="${escapeXml(claim.id)}" kind="${claim.kind}" scope="${claim.scope}" confidence="${claim.confidence.toFixed(2)}" evidence="${escapeXml(evidence)}">${escapeXml(claim.text)}</claim>`
  })

  return `<active-claims count="${active.length}">\n${entries.join('\n')}\n</active-claims>`
}

// ── Checkpoint: 溶解即新生 ────────────────────────────────────────

export interface ClaimSnapshot {
  version: 1
  createdAt: number
  /** Highest event sequence included in this snapshot. Older snapshots omit it. */
  lastEventSeq?: number
  claims: ContextClaim[]
}

/**
 * 导出当前活跃 claims 的快照。
 * 只包含 non-stale, non-expired claims — 溶解时丢弃已失效的信息。
 */
export function checkpointClaims(claims: ContextClaim[], now = Date.now(), lastEventSeq?: number): ClaimSnapshot {
  const alive = claims.filter(c => {
    if (c.status === 'stale' || c.status === 'quarantined') return false
    if (c.expiresAt !== undefined && c.expiresAt <= now) return false
    return true
  })
  return {
    version: 1,
    createdAt: now,
    ...(lastEventSeq !== undefined ? { lastEventSeq } : {}),
    claims: alive,
  }
}

/**
 * 从快照恢复 claims。
 * 恢复后所有 claims 的 lastUsedAt 更新为 now，标记为「刚刚被唤醒」。
 */
export function loadClaimSnapshot(snapshot: ClaimSnapshot, now = Date.now()): ContextClaim[] {
  if (snapshot.version !== 1) return []
  return snapshot.claims.map(claim => ({
    ...claim,
    lastUsedAt: now,
  }))
}

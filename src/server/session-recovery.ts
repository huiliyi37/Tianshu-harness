import type { SessionEvent, SessionRecord } from './protocol.js'

/** Lifecycle scans use the full log or its independent tail metadata. */
export function findOrphanedApprovals(events: readonly SessionEvent[]): Array<{ requestId: string; toolName: string }> {
  const open = new Map<string, string>()
  for (const event of events) {
    const id = typeof event.data?.requestId === 'string' ? event.data.requestId : ''
    if (!id) continue
    if (event.type === 'approval_required') open.set(id, typeof event.data.toolName === 'string' ? event.data.toolName : '')
    else if (event.type === 'approval_resolved') open.delete(id)
  }
  return [...open].map(([requestId, toolName]) => ({ requestId, toolName }))
}

export function findOrphanedQueueEntries(events: readonly SessionEvent[]): string[] {
  const pending = new Set<string>()
  for (const event of events) {
    const id = event.data?.laneId
    if (typeof id !== 'string') continue
    if (event.type === 'queue_pending') pending.add(id)
    else if (event.type === 'queue_status') pending.delete(id)
  }
  return [...pending]
}

export function updateQueueLedger(record: SessionRecord, type: string, data: Record<string, unknown>): void {
  if ((type !== 'queue_pending' && type !== 'queue_status') || typeof data.laneId !== 'string') return
  const pending = new Set(record.pendingQueueLaneIds ?? [])
  if (type === 'queue_pending') pending.add(data.laneId)
  else pending.delete(data.laneId)
  record.pendingQueueLaneIds = [...pending]
}

interface QueueRecoverySession {
  record: SessionRecord
  running: boolean
  queueLane: readonly unknown[]
}

/** Reading an external producer never grants ownership to write restart terminals. */
export class SessionQueueRecovery {
  private readonly bootSessions = new WeakSet<QueueRecoverySession>()

  markBootSession(session: QueueRecoverySession): void {
    this.bootSessions.add(session)
  }

  terminalizeBootQueue(session: QueueRecoverySession, append: (data: Record<string, unknown>) => void, pendingIds: readonly string[]): void {
    if (!this.bootSessions.has(session)) return
    for (const laneId of pendingIds) append({ laneId, status: 'retracted', reason: 'sidecar-restart' })
    session.record.pendingQueueLaneIds = []
  }

  reconcile(
    session: QueueRecoverySession,
    canWrite: boolean,
    append: (data: Record<string, unknown>) => void,
    persist: () => void,
    pendingIds = session.record.pendingQueueLaneIds ?? [],
  ): void {
    if (!this.bootSessions.has(session) || !canWrite || session.running || session.queueLane.length) return
    this.terminalizeBootQueue(session, append, pendingIds)
    this.bootSessions.delete(session)
    if (pendingIds.length) persist()
  }
}

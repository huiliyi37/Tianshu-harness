import type { SessionRecord } from './protocol.js'

interface CreationRollbackSession {
  record: Pick<SessionRecord, 'runId' | 'attemptId' | 'status' | 'archived'>
  running: boolean
  activeRunSettlement?: unknown
  backgroundAborts?: ReadonlyMap<string, unknown>
  creationRollbackWorkSeen?: boolean
  creationRollbackClosing?: boolean
  tombstoned?: boolean
}

export function captureSessionCreationRollback<Session extends CreationRollbackSession>(
  id: string, sessions: ReadonlyMap<string, Session>, archive: () => boolean, remove: () => { ok: boolean },
): (() => 'deleted' | 'missing' | 'replaced' | 'retained-active' | 'retained-idle') | undefined {
    const captured = sessions.get(id)
    const noWork = (s: CreationRollbackSession) => s.creationRollbackWorkSeen === false && !s.record.runId && !s.record.attemptId && !s.running && !s.activeRunSettlement && !s.backgroundAborts?.size
    if (!captured || !noWork(captured) || captured.record.status !== 'idle' || captured.record.archived || captured.tombstoned) return undefined
    return () => {
      if (!sessions.has(id)) return 'missing'
      if (sessions.get(id) !== captured) return 'replaced'
      if (!noWork(captured)) return 'retained-active'
      captured.creationRollbackClosing = true
      try {
        const archived = archive()
        if (!sessions.has(id)) return 'missing'
        if (sessions.get(id) !== captured) return 'replaced'
        if (!noWork(captured)) { captured.creationRollbackClosing = false; return 'retained-active' }
        if (!archived || !captured.record.archived) return 'retained-idle'
        const deleted = remove()
        const afterDelete = sessions.get(id)
        if (afterDelete && afterDelete !== captured) return 'replaced'
        return deleted.ok && !afterDelete ? 'deleted' : 'retained-idle'
      } catch {
        if (!sessions.has(id)) return 'missing'
        if (sessions.get(id) !== captured) return 'replaced'
        if (!noWork(captured)) { captured.creationRollbackClosing = false; return 'retained-active' }
        return 'retained-idle'
      }
    }
  }

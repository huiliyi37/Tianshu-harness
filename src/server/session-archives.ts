import type { RuntimeSessionManager, SessionArchiveRef, SessionArchiveEventRef } from './session-manager.js'
import { buildArchiveHandleText, type SessionArchivePayload } from './attachment-validation.js'

export async function persistArchivesForPrompt(
  manager: RuntimeSessionManager,
  sessionId: string,
  archives: SessionArchivePayload[] | undefined,
): Promise<{ refs: SessionArchiveRef[]; eventRefs: SessionArchiveEventRef[]; handleText: string } | { error: string } | undefined> {
  if (!archives?.length) return undefined
  const persisted = await manager.persistArchives(sessionId, archives)
  if ('error' in persisted) return { error: persisted.error }
  return {
    refs: persisted.refs,
    eventRefs: persisted.refs.map(({ id, name, bytes }) => ({ id, name, bytes })),
    handleText: persisted.refs.map((ref) => buildArchiveHandleText(ref)).join('\n\n---\n\n'),
  }
}

import type { OaiMessage } from '../api/oai-types.js'
import { findRecentUnrecordedWrites, formatDiskReconciliationNote, shouldReconcileDisk } from '../context/write-evidence-probe.js'
import type { SessionPersist } from '../agent/session-persist.js'
import type { SessionContext } from '../agent/context.js'

export interface HistoryRestoreInfo {
  restored: number
  error?: string
  transcriptAligned?: boolean
  expectedTranscriptWatermark?: number
  uncertainTools?: Array<{ id: string; name: string }>
}

export function restoreHistoryMessages(
  persist: SessionPersist,
  session: SessionContext,
  cwd?: string,
  expectedTranscriptWatermark?: number,
): HistoryRestoreInfo {
  let messages: OaiMessage[]
  try {
    messages = persist.loadOai()
  } catch (err) {
    return { restored: 0, error: (err as Error)?.message ?? String(err) }
  }
  const meta = cwd ? persist.loadMetadata() : undefined
  if (cwd && messages.length > 0 && shouldReconcileDisk(meta)) {
    const sinceMs = meta.updatedAt ? meta.updatedAt - 10 * 60 * 1000 : undefined
    const recent = findRecentUnrecordedWrites(cwd, messages, { sinceMs })
    const note = formatDiskReconciliationNote(recent)
    if (note) messages = [...messages, { role: 'user', content: note }]
  }
  if (messages.length > 0) {
    session.replaceMessages(messages)
  }
  return describeRestore(persist, messages.length, expectedTranscriptWatermark)
}

export function describeRestore(
  persist: SessionPersist,
  restored: number,
  expectedTranscriptWatermark?: number,
): HistoryRestoreInfo {
  const uncertain = persist.getLastInjectedUncertain()
  if (expectedTranscriptWatermark !== undefined && restored < expectedTranscriptWatermark) {
    console.warn(
      `[recovery] 转录水位不对齐：检查点=${expectedTranscriptWatermark} 实际=${restored}`
      + `（仅观测，不影响恢复）`,
    )
    return {
      restored,
      transcriptAligned: false,
      expectedTranscriptWatermark,
      ...(uncertain.length > 0 ? { uncertainTools: uncertain } : {}),
    }
  }
  return {
    restored,
    ...(expectedTranscriptWatermark !== undefined
      ? { transcriptAligned: true, expectedTranscriptWatermark }
      : {}),
    ...(uncertain.length > 0 ? { uncertainTools: uncertain } : {}),
  }
}

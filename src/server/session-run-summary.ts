import type { SessionEvent, SessionRecord } from './protocol.js'

interface RunSummarySession {
  record: Pick<SessionRecord, 'status'>
  events: readonly SessionEvent[]
  unattendedHaltReason?: string
}

export function buildRunSummary(session: RunSummarySession): string {
    // 无人值守 fail-closed 中止：原因优先于末段 assistant 文本（可行动性更高）。
    if (session.unattendedHaltReason) {
      return `[unattended halt] ${session.unattendedHaltReason}`
    }
    // Last assistant text run is the closest thing to a result summary.
    for (let i = session.events.length - 1; i >= 0; i--) {
      const e = session.events[i]!
      if (e.type === 'text_delta') {
        const text = String(e.data.text ?? '').trim()
        if (text) return text.slice(0, 500)
      }
    }
    return `status=${session.record.status}`
  }

export function collectChangedFiles(session: RunSummarySession): string[] {
    const files = new Set<string>()
    for (const e of session.events) {
      if (e.type !== 'tool_use') continue
      const name = String(e.data.name ?? '')
      if (name !== 'edit_file' && name !== 'write_file' && name !== 'apply_patch') continue
      const input = e.data.input as Record<string, unknown> | undefined
      const path = input && typeof input.path === 'string' ? input.path : null
      if (path) files.add(path)
    }
    return [...files]
  }


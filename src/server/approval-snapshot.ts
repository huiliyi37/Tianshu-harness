import { dirname } from 'node:path'
import type { ApprovalSnapshot } from './protocol.js'
import { redactValue } from './redact.js'
import { outOfWorkspaceFilePaths } from '../agent/tool-path-access.js'

interface PendingApprovalView {
  requestId: string
  kind: string
  toolName?: string
  toolInput?: Record<string, unknown>
}

export function buildApprovalSnapshot(cwd: string, lastSeq: number, pending: Iterable<PendingApprovalView>): ApprovalSnapshot {
  const approvals: ApprovalSnapshot['approvals'] = []
  for (const p of pending) {
    if (p.kind !== 'approval' || !p.toolName) continue
    const input = p.toolInput ?? {}
    const pathGrant = approvalPathGrant(cwd, p.toolName, input)
    approvals.push({ requestId: p.requestId, toolName: p.toolName,
      input: redactValue(input) as Record<string, unknown>, ...(pathGrant ? { pathGrant } : {}),
    })
  }
  return { approvals, lastSeq }
}

/**
 * Label an approval that would widen the write/read boundary to a directory
 * outside the workspace, so the UI can offer "remember this directory". Absent
 * for every other approval — the checkbox must not appear where remembering
 * has no meaning.
 */
export function approvalPathGrant(
  cwd: string,
  name: string,
  input: Record<string, unknown>,
): { dir: string; mode: 'read' | 'write' } | undefined {
  if (name === 'request_path_access') {
    const p = typeof input.path === 'string' ? input.path.trim() : ''
    return p ? { dir: p, mode: input.mode === 'write' ? 'write' : 'read' } : undefined
  }
  const need = outOfWorkspaceFilePaths(cwd, name, input)
  const first = need?.paths[0]
  return need && first ? { dir: dirname(first), mode: need.mode } : undefined
}

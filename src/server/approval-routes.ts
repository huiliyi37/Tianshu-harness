import type { RuntimeSessionManager } from './session-manager.js'
import type { RouteHandler } from './index.js'
import type { SseStream } from './sse-stream.js'
import { withAuth } from './route-auth.js'

type ApprovalManager = Pick<RuntimeSessionManager, 'getApprovalSnapshot' | 'answerIntervention'>

export function buildApprovalRoutes(manager: ApprovalManager, apiToken?: string): Record<string, RouteHandler> {
  return {
    'GET /sessions/:id/interventions': withAuth((_body, params) => {
      const snapshot = manager.getApprovalSnapshot(params!.id!)
      if (!snapshot) return { status: 404, body: { error: 'Session not found' } }
      return { status: 200, body: snapshot }
    }, apiToken),

    'POST /sessions/:id/interventions/:requestId/answer': withAuth((body, params) => {
      const data = (body ?? {}) as { decision?: string; editedInput?: Record<string, unknown>; remember?: boolean }
      // Fail-closed: the decision field is the authorization itself, so a missing
      // or unrecognized value must NOT default to approval. Only 'approve' and
      // 'deny' are legal (vscode ApprovalAnswer contract; serve.ts sends 'deny').
      // Previously `data.decision ?? 'approve'` let an empty body silently approve
      // a high-risk pending intervention.
      const decision = data.decision
      if (decision !== 'approve' && decision !== 'deny') {
        return { status: 400, body: { error: 'Invalid or missing "decision" (expected "approve" or "deny")' } }
      }
      const ok = manager.answerIntervention(
        params!.id!, params!.requestId!, decision, data.editedInput, data.remember === true,
      )
      if (!ok) return { status: 404, body: { error: 'Pending intervention not found' } }
      return { status: 200, body: { ok: true } }
    }, apiToken),

  }
}

/** Send even an empty list: live pending state survives event-ring eviction. */
export function sendApprovalSnapshot(manager: ApprovalManager, id: string, sse: SseStream): void {
  const snapshot = manager.getApprovalSnapshot(id)
  if (snapshot) sse.send('approval_snapshot', { seq: 0, ts: Date.now(), type: 'approval_snapshot', data: snapshot })
}

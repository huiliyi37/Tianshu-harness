import type { RouteHandler } from './index.js'
import { withAuth } from './routes.js'
export interface UpdateRestartManager {
  updateRestartActivity(): { sessions: number; tasks: number; failedSessions?: number; pendingEvents?: number }
  prepareUpdateRestart(force: boolean, signal: AbortSignal, opts?: { allowUnsaved?: boolean }): Promise<void>
  cancelUpdateRestart(): void
}
export function buildUpdateRestartRoutes(manager: UpdateRestartManager, apiToken?: string): Record<string, RouteHandler> {
  let preparing = false
  let cancellation: AbortController | undefined
  let expiry: ReturnType<typeof setTimeout> | undefined
  const cancel = () => { cancellation?.abort(); cancellation = undefined; clearTimeout(expiry); manager.cancelUpdateRestart(); preparing = false }
  return {
    'GET /runtime/update-activity': withAuth(() => ({ status: 200, body: manager.updateRestartActivity() }), apiToken),
    'POST /runtime/update-prepare': withAuth(async body => {
      if (preparing) return { status: 409, body: { error: 'UPDATE_PREPARING' } }
      preparing = true
      const controller = new AbortController(); cancellation = controller
      const deadline = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)])
      try {
        const payload = (body as { force?: unknown; allowUnsaved?: unknown } | undefined)
        await manager.prepareUpdateRestart(payload?.force === true, deadline, payload?.allowUnsaved === true ? { allowUnsaved: true } : undefined)
        // An abandoned client must not leave the runtime permanently frozen.
        expiry = setTimeout(cancel, 120000); expiry.unref()
        return { status: 200, body: { prepared: true } }
      } catch (error) {
        cancel()
        const code = error instanceof Error && error.message === 'UPDATE_BUSY' ? 'UPDATE_BUSY'
          : error instanceof Error && error.message === 'UPDATE_BUSY_TIMEOUT' ? 'UPDATE_BUSY_TIMEOUT'
          : 'UPDATE_SAVE_FAILED'
        const unavailable = error instanceof Error && error.message === 'UPDATE_PERSISTENCE_UNAVAILABLE'
        return { status: code === 'UPDATE_SAVE_FAILED' ? 503 : 409, body: { error: code, stage: unavailable ? 'runtime_capability' : code === 'UPDATE_SAVE_FAILED' ? 'runtime_save' : 'activity', retryable: !unavailable, ...manager.updateRestartActivity() } }
      }
    }, apiToken),
    'POST /runtime/update-cancel': withAuth(() => { cancel(); return { status: 200, body: { cancelled: true } } }, apiToken),
  }
}

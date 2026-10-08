import type { RouteHandler } from './index.js'

interface RuntimeMutationState {
  ownsSessionStore: boolean
  initializationError?: string
  updatePreparing: boolean
}

/** Keep diagnostics reachable while unavailable runtimes reject business writes. */
export function guardRuntimeRoutes(routes: Record<string, RouteHandler>, getState: () => RuntimeMutationState): Record<string, RouteHandler> {
  return new Proxy(routes, {
    get(target, key: string) {
      const handler = target[key]
      if (typeof handler !== 'function') return handler
      return (...args: Parameters<RouteHandler>) => {
        const state = getState()
        if (!state.ownsSessionStore && !key.startsWith('GET ') && !key.startsWith('HEAD ') && key !== 'POST /shutdown') {
          return { status: 503, body: { error: state.initializationError ?? 'data-dir-locked' } }
        }
        if (state.updatePreparing && !key.startsWith('GET ') && !['POST /shutdown', 'POST /runtime/update-cancel', 'POST /runtime/update-prepare'].includes(key)) {
          return { status: 409, body: { error: 'UPDATE_PREPARING' } }
        }
        return handler(...args)
      }
    },
  })
}

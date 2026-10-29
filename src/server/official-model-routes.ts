import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { RouteHandler } from './index.js'
import { withAuth } from './routes.js'
import { createAccountFetch } from './account-network.js'
import { getNetworkConfig } from '../config/manager.js'
import { rivetHome } from '../config/paths.js'
import { createOfficialModelBroker, sharedOfficialModelBroker, type OfficialBrokerOptions, type OfficialModelBroker } from '../auth/official-model-auth.js'
import { OfficialError, parseAccountRequest, publicFailure, purposeSchema } from '../models/official-contract.js'

export function buildOfficialModelRoutes(options: OfficialBrokerOptions & { apiToken?: string }, broker: OfficialModelBroker = createOfficialModelBroker(options)): Record<string, RouteHandler> {
  const wrap = (kind: 'status' | 'catalog' | 'sync' | 'customer' | 'legacy' | 'quote'): RouteHandler => withAuth(async (body, params, _headers, res) => {
    const controller = new AbortController()
    const disconnect = () => { if (!res?.writableEnded) controller.abort() }
    res?.once('close', disconnect)
    let requestId = randomUUID() as string
    const headers: Record<string, string> = { 'Cache-Control': 'no-store' }
    try {
      if (kind === 'legacy') throw new OfficialError('customer_upgrade_required',426,false)
      const query = kind === 'catalog' ? z.object({ purpose: purposeSchema.optional() }).strict().safeParse(params ?? {}) : z.object({}).strict().safeParse(params ?? {})
      if (!query.success || (kind === 'status' || kind === 'catalog') && !z.object({}).strict().safeParse(body ?? {}).success) throw new OfficialError('invalid_request')
      if (kind === 'sync' && !z.object({}).strict().safeParse(body ?? {}).success) throw new OfficialError('invalid_request')
      const quote = kind === 'quote' ? z.object({ bindingId: z.string().min(1).max(256), catalogRevision: z.string().min(1).max(256), pricingRevision: z.string().min(1).max(256) }).strict().safeParse(body) : undefined
      if (quote && !quote.success) throw new OfficialError('invalid_request')
      const account = kind === 'customer' ? parseAccountRequest(body) : undefined
      if (account) requestId = account.requestId
      let data: unknown
      if (kind === 'status') data = broker.getOfficialStatus()
      else {
        const identity = broker.captureOfficialIdentity()
        if (!identity) throw new OfficialError('auth_required')
        data = kind === 'sync' ? await broker.syncOfficialAccess(identity, controller.signal)
          : kind === 'catalog' ? await broker.getOfficialCatalog(identity, (query.data as { purpose?: z.infer<typeof purposeSchema> }).purpose ?? 'agent', controller.signal)
          : quote?.success ? await broker.getOfficialPriceQuote(identity, quote.data, controller.signal)
          : await broker.account(identity, account, controller.signal)
        controller.signal.throwIfAborted()
        broker.withCurrentOfficialIdentity(identity, () => undefined)
      }
      return { status: 200, headers, body: { version: 2, requestId, data } }
    } catch (error) {
      const failure = publicFailure(error)
      if (failure.retryAfterSeconds) headers['Retry-After'] = String(failure.retryAfterSeconds)
      return { status: failure.status, headers, body: { version: 2, requestId, error: failure.publicError() } }
    } finally { res?.off('close', disconnect) }
  }, options.apiToken)
  return { 'POST /official-model/quote': wrap('quote'), 'GET /official-model/status': wrap('status'), 'GET /official-model/catalog': wrap('catalog'), 'POST /official-model/sync': wrap('sync'), 'POST /official-model/customer':wrap('customer'), 'POST /official-model/account': wrap('legacy') }
}
export function buildOfficialModelRoutesFor(apiToken: string | undefined, config: { network?: { proxy?: string; noProxy?: string } }): Record<string, RouteHandler> {
  const options = { apiToken, home: rivetHome(), fetchImpl: createAccountFetch(() => {
    const network = getNetworkConfig() ?? config.network
    return { proxyUrl: network?.proxy || undefined, noProxy: network?.noProxy || undefined }
  }) }
  return buildOfficialModelRoutes(options, sharedOfficialModelBroker(options))
}

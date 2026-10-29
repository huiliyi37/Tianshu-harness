import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { fetch as undiciFetch } from 'undici'
import { accountStore, accountApiBase, accountHeaders, HTTP_TIMEOUT_MS } from './account.js'
import { readAccountDeviceFingerprint } from './account-device.js'
import { atomicCredentialWrite, type AccountState } from './token-store.js'
import { createSecretCipher, decodeSecret, encodeSecret, resolveSecretBackend } from './secure-store.js'
import { refreshAccountSession } from './refresh.js'
import { createOfficialDirectAccess } from './official-direct-access.js'
import { observeAccountAuthority } from './account-authority.js'
import { createAccountFetch } from '../server/account-network.js'
import { rivetHome } from '../config/paths.js'
import { getNetworkConfig } from '../config/manager.js'
import { providerDispatcher } from '../api/provider-network.js'
import { catalogForPurpose, parseOfficialCatalog } from '../models/official-catalog.js'
import { OfficialError, exactOrigin, parseAccountRequest, parseEnvelope, priceQuoteSchema, projectAccount, publicFailure, utcSchema, type AccountSummary, type Catalog, type OfficialCredential, type OfficialIdentityRef, type OfficialStatus, type OfficialProducer, type PriceQuote, type Purpose } from '../models/official-contract.js'
export type { OfficialCredential, OfficialIdentityRef, OfficialStatus } from '../models/official-contract.js'

const DEFAULT_OFFICIAL_ORIGIN = 'https://tianshuharness.com'
export interface OfficialConfiguration { gatewayOrigin: string; gatewayOrigins?: readonly string[]; checkoutOrigins?: readonly string[]; portalOrigin?: string | null; directAccess?: boolean; supplierOrigins?: readonly string[] }
export interface OfficialBrokerOptions { home: string; configuration?: OfficialConfiguration; fetchImpl?: typeof fetch }
interface Cache {
  version: 2
  identity: OfficialIdentityRef
  epoch: number
  configuration: string
  grant?: OfficialCredential
  receipt?: string
  lease?: { id: string; requestId: string; deadline: number }
  discarded?: string[]
  catalog?: Catalog
  syncedAt?: string
}
const identitySchema = z.object({ subject: z.string().uuid(), accountSessionId: z.string().uuid(), deviceId: z.string().min(8).max(128), generation: z.number().int().nonnegative(), incarnation: z.string().min(1).max(128) })
const grantSchema = z.object({ credential: z.string().regex(/^sk-[^\s]+$/).max(8192), subject: z.string().uuid(), accountSessionId: z.string().uuid(), generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), expiresAt: utcSchema, catalogRevision: z.string().min(1).max(256), directAvailable: z.boolean().optional() })
const cacheSchema = z.object({ version: z.literal(2), identity: identitySchema, epoch: z.number().int().nonnegative(), configuration: z.string(), grant: grantSchema.optional(), receipt: z.string().uuid().optional(), lease: z.object({ id: z.string().uuid(), requestId: z.string().uuid(), deadline: z.number().finite() }).optional(), discarded: z.array(z.string().uuid()).max(256).optional(), catalog: z.unknown().optional(), syncedAt: utcSchema.optional() }).strict()
function equalIdentity(a: OfficialIdentityRef, b: OfficialIdentityRef): boolean {
  return a.incarnation === b.incarnation && a.generation === b.generation && a.subject === b.subject && a.accountSessionId === b.accountSessionId && a.deviceId === b.deviceId
}
function originList(raw: unknown, fallback: readonly string[] = []): string[] {
  if (raw === undefined) return [...fallback]
  if (!Array.isArray(raw) || !raw.length || raw.length > 32 || raw.some(v => typeof v !== 'string')) throw new OfficialError('service_error')
  const values = raw.map(exactOrigin)
  if (new Set(values).size !== values.length) throw new OfficialError('service_error')
  return values
}
function configuration(input?: OfficialConfiguration) {
  const origin = exactOrigin(input === undefined ? process.env.RIVET_OFFICIAL_GATEWAY_ORIGIN ?? DEFAULT_OFFICIAL_ORIGIN : input.gatewayOrigin)
  const origins = originList(input?.gatewayOrigins !== undefined ? input.gatewayOrigins : (process.env.RIVET_OFFICIAL_GATEWAY_ORIGINS === undefined ? undefined : JSON.parse(process.env.RIVET_OFFICIAL_GATEWAY_ORIGINS)), [origin])
  if (!origins.includes(origin)) throw new OfficialError('service_error')
  // Invalid checkout configuration closes checkout projection only.
  let checkout: string[] = []
  try { checkout = originList(input?.checkoutOrigins ?? (process.env.RIVET_OFFICIAL_CHECKOUT_ORIGINS === undefined ? undefined : JSON.parse(process.env.RIVET_OFFICIAL_CHECKOUT_ORIGINS))) } catch { /* unavailable checkout */ }
  return { origin, origins, checkout, fingerprint: createHash('sha256').update(JSON.stringify([origin, origins])).digest('hex') }
}
export function getOfficialGatewayOrigin(input?: OfficialConfiguration): string {
  try { return configuration(input).origin } catch (error) { throw publicFailure(error) }
}
function cancelled(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError') }
async function awaitSignal<T>(job: Promise<T>, signal?: AbortSignal): Promise<T> {
  cancelled(signal)
  if (!signal) return job
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    job.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export function createOfficialModelBroker(options: OfficialBrokerOptions) {
  const store = accountStore(options.home), path = join(options.home, 'official-access.json')
  const refs = new WeakMap<OfficialIdentityRef, number>(), jobs = new Map<string, Promise<OfficialCredential>>()
  const catalogJobs = new Map<string, Promise<Catalog>>()
  let catalogRequest = 0
  let catalogObservation: { identity: OfficialIdentityRef; epoch: number; configuration: string; catalog: Catalog; syncedAt: string } | null = null
  let observation: { identity: OfficialIdentityRef; epoch: number; view: AccountSummary; observedAt: number } | null = null
  let observationRequest = 0
  let directOffer: string | undefined
  let checkedOfferOwner: string | undefined
  function observedCatalog(identity: OfficialIdentityRef, epoch: number) {
    return catalogObservation && equalIdentity(catalogObservation.identity, identity) && catalogObservation.epoch === epoch && catalogObservation.configuration === configuration(options.configuration).fingerprint ? catalogObservation : null
  }
  const doFetch: typeof fetch = options.fetchImpl ?? ((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const dispatcher = providerDispatcher(url, getNetworkConfig())
    const fetchImpl = dispatcher ? undiciFetch as unknown as typeof fetch : fetch
    return fetchImpl(input, { ...init, ...(dispatcher ? { dispatcher } : {}) } as RequestInit)
  })
  const renewalFetch = options.fetchImpl ?? createAccountFetch(() => {
    const network = getNetworkConfig()
    return { proxyUrl: network.proxy, noProxy: network.noProxy }
  })
  const direct = createOfficialDirectAccess({
    enabled: identity => options.configuration?.directAccess ?? (process.env.RIVET_OFFICIAL_DIRECT_ACCESS !== undefined ? process.env.RIVET_OFFICIAL_DIRECT_ACCESS === '1' : directOffer === directOfferOwner(identity)),
    origins: () => originList(options.configuration?.supplierOrigins, ['https://tianshu.ry.live']),
    epoch: identity => current(identity).officialEpoch,
    exchange: async identity => {
      const token = await accountToken(identity), requestId = randomUUID()
      current(identity)
      try {
        const result = await request('bootstrap', `${exactOrigin(accountApiBase())}/functions/v1/tui-model-bootstrap`, token, { requestId, deviceId: identity.deviceId, transport: 'direct' }, requestId)
        current(identity)
        return result
      } catch (error) {
        current(identity)
        throw error
      }
    }, now: Date.now,
  })
  observeAccountAuthority(options.home, direct)
  function directOfferOwner(identity: OfficialIdentityRef): string {
    return JSON.stringify([identity.subject, identity.accountSessionId, identity.deviceId, identity.generation, identity.incarnation, current(identity).officialEpoch, configuration(options.configuration).fingerprint])
  }
  function acceptCredential(identity: OfficialIdentityRef, value: OfficialCredential): OfficialCredential {
    const owner = directOfferOwner(identity)
    directOffer = value.directAvailable === true ? owner : undefined
    if (value.directAvailable !== undefined) checkedOfferOwner = owner
    return { ...value }
  }
  async function getOfficialDirectAccess(identity: OfficialIdentityRef) {
    const owner = directOfferOwner(identity)
    if (options.configuration?.directAccess === undefined && process.env.RIVET_OFFICIAL_DIRECT_ACCESS === undefined && checkedOfferOwner !== owner) {
      const cache = readCache(identity), grant = validGrant(cache)
      await credential(identity, 5000, grant?.directAvailable === undefined ? { receipt: cache?.receipt } : undefined)
      current(identity)
      checkedOfferOwner = owner
    }
    return direct.get(identity)
  }
  function source(state: AccountState | null): OfficialIdentityRef | null {
    if (!state?.token || !state.source || readAccountDeviceFingerprint(options.home) !== state.source.deviceId) return null
    const parsed = identitySchema.safeParse({ ...state.source, generation: state.generation, incarnation: state.incarnation })
    return parsed.success ? Object.freeze(parsed.data) : null
  }
  function captureOfficialIdentity(): OfficialIdentityRef | null {
    const state = store.readAccountState(), identity = source(state)
    if (identity) refs.set(identity, state!.officialEpoch)
    return identity
  }
  function current(identity: OfficialIdentityRef): AccountState {
    const state = store.readAccountState(), actual = source(state)
    if (!actual || !refs.has(identity) || !equalIdentity(identity, actual) || state!.officialEpoch !== refs.get(identity)) throw new OfficialError('account_changed')
    return state!
  }
  function withCurrentOfficialIdentity<T>(identity: OfficialIdentityRef, action: (epoch: number) => T): T {
    current(identity)
    return store.withAccountLock(() => {
      const state = current(identity), result = action(state.officialEpoch)
      if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') throw new OfficialError('service_error')
      current(identity)
      return result
    })
  }
  async function requestOfficialMembershipGrant(identity: OfficialIdentityRef, requestId: string, signal?: AbortSignal): Promise<{ grant: string; expiresAt: string }> {
    if (!z.string().uuid().safeParse(requestId).success) throw new OfficialError('service_error')
    const token = await accountToken(identity)
    current(identity); cancelled(signal)
    const raw = await request('account', `${exactOrigin(accountApiBase())}/functions/v1/tui-model-membership-grant`, token, { requestId }, requestId, signal, true)
    current(identity); cancelled(signal)
    return z.object({ grant: z.string().min(1).max(12000), expiresAt: utcSchema }).strict().parse(raw)
  }
  function readCache(identity: OfficialIdentityRef): Cache | null {
    try {
      const state = current(identity), cfg = configuration(options.configuration), raw = readFileSync(path, 'utf8'), envelope = JSON.parse(raw)
      const backend = resolveSecretBackend()
      if (backend === 'plaintext' || envelope.v !== 1 || envelope.s !== 'aes-256-gcm' || envelope.b !== backend || typeof envelope.d !== 'string' || Object.keys(envelope).sort().join() !== 'b,d,s,v') return null
      const plain = decodeSecret(createSecretCipher(options.home, backend), raw)
      if (plain === null) return null
      const parsed = cacheSchema.parse(JSON.parse(plain))
      if (!equalIdentity(identity, parsed.identity) || parsed.epoch !== state.officialEpoch || parsed.configuration !== cfg.fingerprint) return null
      const cache: Cache = { ...parsed, catalog: undefined }
      if (parsed.catalog !== undefined) cache.catalog = parseOfficialCatalog(parsed.catalog, cfg.origins)
      return cache
    } catch (error) { if (error instanceof OfficialError && error.code === 'account_changed') throw error; return null }
  }
  function writeCache(cache: Cache): void {
    const backend = resolveSecretBackend()
    if (backend === 'plaintext') throw new OfficialError('service_error')
    const cipher = createSecretCipher(options.home, backend)
    if (cipher.backend !== backend) throw new OfficialError('service_error')
    const encoded = encodeSecret(cipher, JSON.stringify(cache)), envelope = JSON.parse(encoded)
    if (cipher.backend !== backend || envelope.v !== 1 || envelope.s !== 'aes-256-gcm' || envelope.b !== backend) throw new OfficialError('service_error')
    atomicCredentialWrite(path, encoded)
  }
  function emptyCache(identity: OfficialIdentityRef): Cache { return { version: 2, identity: { ...identity }, epoch: refs.get(identity)!, configuration: configuration(options.configuration).fingerprint } }
  function validGrant(cache: Cache | null, minimumValidityMs = 5000, previous?: { receipt?: string }): OfficialCredential | null {
    if (previous && cache?.receipt === previous.receipt) return null
    return cache?.grant && Date.parse(cache.grant.expiresAt) > Date.now() + minimumValidityMs ? { ...cache.grant } : null
  }
  async function request(producer: OfficialProducer, url: string, bearer: string, body?: unknown, requestId?: string, signal?: AbortSignal, membership = false, wireVersion: 1 | 2 = 1): Promise<unknown> {
    cancelled(signal)
    let response: Response
    try {
      const timeout = AbortSignal.timeout(HTTP_TIMEOUT_MS)
      response = await doFetch(url, { method: body === undefined ? 'GET' : 'POST', headers: { ...(url.startsWith(`${exactOrigin(accountApiBase())}/`) ? accountHeaders() : { 'Content-Type': 'application/json' }), ...(producer === 'gateway' && url.endsWith('/api/official/v2/customer/catalog') ? { 'X-Tianshu-Billing-Mode': 'server' } : {}), Authorization: `Bearer ${bearer}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
      if (!response.body) throw new OfficialError('service_error')
      const reader = response.body.getReader(), parts: Uint8Array[] = []
      let length = 0
      try { while (true) { const result = await reader.read(); if (result.done) break; length += result.value.length; if (length > 1024 * 1024) { await reader.cancel(); throw new OfficialError('service_error') }; parts.push(result.value) } } finally { reader.releaseLock() }
      const raw = JSON.parse(Buffer.concat(parts).toString('utf8'))
      if (membership && response.status !== 200) {
        const failure = z.object({ version: z.literal(1), requestId: z.literal(requestId!), error: z.object({ code: z.enum(['auth_required', 'entitlement_unavailable', 'service_error', 'invalid_request']), message: z.string(), retryable: z.boolean() }).strict() }).strict().parse(raw)
        const { code, retryable } = failure.error
        if (!((code === 'auth_required' && response.status === 401 && !retryable) || (code === 'entitlement_unavailable' && response.status === 403 && !retryable) || (code === 'service_error' && ((response.status === 409 && !retryable) || (response.status === 503 && retryable))) || (code === 'invalid_request' && response.status === 400 && !retryable))) throw new OfficialError('service_error')
        throw new OfficialError(code, response.status, retryable)
      }
      const value = parseEnvelope(raw, producer, response.status, requestId, wireVersion)
      return value
    } catch (error) { cancelled(signal); throw publicFailure(error) }
  }
  async function accountToken(identity: OfficialIdentityRef): Promise<string> {
    let state = current(identity)
    if (state.token!.expiresAt <= Date.now() + 60000) {
      const result = await refreshAccountSession(store, state.token!, { fetchImpl: renewalFetch })
      state = current(identity)
      if (result.retryAfterSeconds !== undefined) throw new OfficialError('service_error')
      if (result.code !== 'ok' || state.token!.expiresAt <= Date.now()) throw new OfficialError('auth_required')
    }
    return state.token!.accessToken
  }
  async function cancelReceipt(identity: OfficialIdentityRef, requestId: string, originalToken: string): Promise<void> {
    let token = originalToken
    try {
      const state = store.readAccountState(), actual = source(state)
      if (actual && equalIdentity(identity, actual)) token = state!.token!.accessToken
      let installed = false
      store.withAccountLock(() => {
        try {
          const cache = readCache(identity)
          if (cache?.receipt === requestId) { installed = true; return }
          if (cache) { cache.discarded = [...new Set([...(cache.discarded ?? []), requestId])].slice(-256); if (cache.lease?.requestId === requestId) delete cache.lease; writeCache(cache) }
        } catch { /* A changed identity is already a durable install fence. */ }
      })
      if (!installed) await request('account', `${exactOrigin(accountApiBase())}/functions/v1/tui-model-bootstrap-cancel`, token, { requestId }, requestId)
    } catch { /* Best effort; remote source revocation and grant expiry remain authoritative. */ }
  }
  async function bootstrap(identity: OfficialIdentityRef, minimumValidityMs: number, previous?: { receipt?: string }): Promise<OfficialCredential> {
    configuration(options.configuration)
    const deadline = Date.now() + 25000
    while (true) {
      current(identity)
      const cached = validGrant(readCache(identity), minimumValidityMs, previous)
      if (cached) return cached
      const token = await accountToken(identity)
      // Resolve OS key sealing outside the short filesystem transaction.
      const backend = resolveSecretBackend(), cipher = createSecretCipher(options.home, backend)
      if (backend === 'plaintext' || cipher.backend !== backend) throw new OfficialError('service_error')
      const prepared = JSON.parse(encodeSecret(cipher, '{}'))
      if (cipher.backend !== backend || prepared.b !== backend || prepared.v !== 1 || prepared.s !== 'aes-256-gcm') throw new OfficialError('service_error')
      const claim = store.withAccountLock(() => {
        current(identity)
        const cache = readCache(identity) ?? emptyCache(identity), grant = validGrant(cache, minimumValidityMs, previous)
        if (grant) return { grant }
        if (cache.lease && cache.lease.deadline > Date.now()) return {}
        const lease = { id: randomUUID(), requestId: randomUUID(), deadline: Date.now() + 15000 }
        cache.lease = lease; writeCache(cache)
        return { lease }
      })
      if (claim.grant) return claim.grant
      if (!claim.lease) {
        if (Date.now() >= deadline) throw new OfficialError('service_error')
        await new Promise(resolve => setTimeout(resolve, 25)); continue
      }
      const lease = claim.lease
      try {
        const grant = grantSchema.parse(await request('bootstrap', `${exactOrigin(accountApiBase())}/functions/v1/tui-model-bootstrap`, token, { requestId: lease.requestId, deviceId: identity.deviceId }, lease.requestId))
        if (grant.subject !== identity.subject || grant.accountSessionId !== identity.accountSessionId || Date.parse(grant.expiresAt) <= Date.now() || Date.parse(grant.expiresAt) > Date.now() + 600000) throw new OfficialError('account_changed')
        store.withAccountLock(() => {
          current(identity)
          const cache = readCache(identity)
          if (!cache || cache.lease?.id !== lease.id || cache.lease.deadline <= Date.now() || cache.discarded?.includes(lease.requestId) || Date.parse(grant.expiresAt) <= Date.now()) throw new OfficialError('account_changed')
          cache.grant = grant; cache.receipt = lease.requestId; cache.syncedAt = new Date().toISOString(); delete cache.lease
          writeCache(cache)
        })
        return { ...grant }
      } catch (error) {
        await cancelReceipt(identity, lease.requestId, token)
        throw publicFailure(error)
      }
    }
  }
  function getOfficialCredential(identity: OfficialIdentityRef): Promise<OfficialCredential> {
    return credential(identity, 5000)
  }
  function credential(identity: OfficialIdentityRef, minimumValidityMs: number, previous?: { receipt?: string }): Promise<OfficialCredential> {
    try {
      current(identity)
      const cached = validGrant(readCache(identity), minimumValidityMs, previous)
      if (cached) return Promise.resolve(cached).then(value => acceptCredential(identity, value))
    } catch (error) { return Promise.reject(error) }
    const key = JSON.stringify([identity, refs.get(identity)])
    let job = jobs.get(key)
    if (!job) { job = bootstrap(identity, minimumValidityMs, previous).then(value => { checkedOfferOwner = directOfferOwner(identity); return value }).finally(() => { if (jobs.get(key) === job) jobs.delete(key) }); jobs.set(key, job) }
    return job.then(value => acceptCredential(identity, value))
  }
  async function getCatalog(identity: OfficialIdentityRef, signal?: AbortSignal, fresh = false): Promise<Catalog> {
    cancelled(signal)
    const cfg = configuration(options.configuration)
    const state = current(identity)
    const startupCatalog = observedCatalog(identity, state.officialEpoch)?.catalog
    const cachedStartup = !fresh && startupCatalog?.models.some(model => model.status === 'available' && model.bindings.length > 0) && startupCatalog.models.every(model => model.bindings.every(binding => binding.billingMode === 'server'))
    if (cachedStartup && direct.peek(identity)) return structuredClone(startupCatalog!)
    const grant = await awaitSignal(getOfficialCredential(identity), signal)
    current(identity)
    if (cachedStartup) return structuredClone(startupCatalog!)
    const key = JSON.stringify([identity, state.officialEpoch, cfg.fingerprint, grant.generation, grant.expiresAt])
    try {
      cancelled(signal)
      let job = fresh ? undefined : catalogJobs.get(key)
      if (!job) {
        const sequence = ++catalogRequest
        job = (async () => {
          const catalog = parseOfficialCatalog(await request('gateway', `${cfg.origin}/api/official/v2/customer/catalog`, grant.credential, undefined, undefined, undefined, false, 2), cfg.origins)
          current(identity)
          if (sequence === catalogRequest) {
            withCurrentOfficialIdentity(identity, epoch => { catalogObservation = { identity: { ...identity }, epoch, configuration: cfg.fingerprint, catalog: structuredClone(catalog), syncedAt: new Date().toISOString() } })
          }
          return catalog
        })().finally(() => { if (catalogJobs.get(key) === job) catalogJobs.delete(key) })
        catalogJobs.set(key, job)
      }
      const catalog = await awaitSignal(job, signal)
      current(identity); cancelled(signal)
      return structuredClone(catalog)
    } catch (error) {
      cancelled(signal); current(identity)
      throw publicFailure(error)
    }
  }
  async function getOfficialCatalog(identity: OfficialIdentityRef, purpose: Purpose, signal?: AbortSignal): Promise<Catalog> { return catalogForPurpose(await getCatalog(identity, signal), purpose) }
  async function getOfficialPriceQuote(identity: OfficialIdentityRef, input: { bindingId: string; catalogRevision: string; pricingRevision: string }, signal?: AbortSignal): Promise<PriceQuote> {
    cancelled(signal); current(identity)
    const data = z.object({ bindingId: z.string().min(1).max(256), catalogRevision: z.string().min(1).max(256), pricingRevision: z.string().min(1).max(256) }).strict().parse(input)
    const catalog = observedCatalog(identity, current(identity).officialEpoch)?.catalog ?? readCache(identity)?.catalog ?? await getCatalog(identity, signal)
    if (catalog.revision !== data.catalogRevision) throw new OfficialError('pricing_changed')
    const binding = catalog.models.flatMap(model => model.bindings).find(b => b.id === data.bindingId && b.pricingRevision === data.pricingRevision)
    if (!binding) throw new OfficialError('model_unavailable')
    for (let attempt = 0; attempt < 2; attempt++) {
      const grant = await awaitSignal(getOfficialCredential(identity), signal), requestId = randomUUID()
      const quote = priceQuoteSchema.parse(await request('gateway', `${configuration(options.configuration).origin}/api/official/v2/customer/model-quote`, grant.credential, { requestId, ...data }, requestId, signal, false, 2))
      current(identity); cancelled(signal)
      if (quote.bindingId !== binding.id || quote.modelId !== binding.modelId || quote.pricingRevision !== binding.pricingRevision || Date.parse(quote.asOf) > Date.now() || Date.parse(quote.validUntil) <= Date.parse(quote.asOf)) throw new OfficialError('pricing_changed')
      if (Date.parse(quote.validUntil) > Date.now() + 5000) return quote
    }
    throw new OfficialError('pricing_changed')
  }
  async function account(identity: OfficialIdentityRef, raw: unknown, signal?: AbortSignal): Promise<unknown> {
    const input = parseAccountRequest(raw), cfg = configuration(options.configuration), token = await accountToken(identity)
    cancelled(signal); current(identity)
    if (input.op === 'view.get') {
      void getOfficialDirectAccess(identity).catch(() => {})
      try { await awaitSignal(credential(identity, 30000), signal); current(identity); cancelled(signal) }
      catch (error) {
        try { withCurrentOfficialIdentity(identity, () => { observationRequest++; observation = null }) } catch {}
        const failure = publicFailure(error)
        if (failure.status === 401 || ['credential_revoked', 'reauth_required'].includes(failure.code)) await clearOfficialAccess(identity).catch(() => {})
        throw failure
      }
    }
    const viewRequest = input.op === 'view.get' ? ++observationRequest : null
    try {
      const result = await request('account', `${exactOrigin(accountApiBase())}/functions/v1/tui-model-account`, token, input, input.requestId, signal, false, 2)
      current(identity); cancelled(signal)
      const projected = input.op === 'catalog.list' ? parseOfficialCatalog(result, cfg.origins) : projectAccount(input.op, result, identity.subject, cfg.checkout, cfg.origins)
      if (viewRequest !== null && viewRequest === observationRequest) withCurrentOfficialIdentity(identity, epoch => {
        observation = { identity: { ...identity }, epoch, view: structuredClone(projected as AccountSummary), observedAt: performance.now() }
      })
      return projected
    } catch (error) {
      if (viewRequest !== null && viewRequest === observationRequest) observation = null
      throw error
    }
  }
  function getOfficialStatus(): OfficialStatus {
    // One locked observation includes logout tombstones. An unreadable source is
    // unknown, never evidence that the previous account remains current.
    return store.withAccountLock(() => {
      const state = store.readAccountState(), identity = source(state)
      if (identity) refs.set(identity, state!.officialEpoch)
      const sourceEpoch = state ? createHash('sha256').update(JSON.stringify([state.incarnation, state.generation, state.officialEpoch, identity?.subject ?? null, identity?.accountSessionId ?? null, identity?.deviceId ?? null])).digest('hex') : null
      let portalLinks: OfficialStatus['portalLinks'] = { wallet: null, usage: null }
      try {
        const configuredPortal = options.configuration?.portalOrigin
        const portal = configuredPortal === undefined ? process.env.RIVET_OFFICIAL_PORTAL_ORIGIN ?? DEFAULT_OFFICIAL_ORIGIN : configuredPortal
        if (portal !== null) {
          const origin = exactOrigin(portal)
          portalLinks = { wallet: `${origin}/space/models?tab=wallet`, usage: `${origin}/space/models?tab=usage` }
        }
      } catch {}
      const empty: OfficialStatus = { sourceEpoch, portalLinks, identity, status: identity ? 'unavailable' : state ? 'unauthenticated' : 'unavailable', expiresAt: null, catalogRevision: null, syncedAt: null, customerView: null }
      if (!identity) { observation = null; return empty }
      try {
        configuration(options.configuration)
        const cache = readCache(identity)
        const directGrant = direct.peek(identity)
        if (!cache && !directGrant) { observation = null; return empty }
        const age = observation ? performance.now() - observation.observedAt : Infinity
        const fresh = observation && equalIdentity(observation.identity,identity) && observation.epoch === state!.officialEpoch && age >= 0 && age < 60000 && (validGrant(cache) || directGrant) && state!.token!.expiresAt > Date.now()
        const customerView = fresh && observation ? structuredClone(observation.view) : null
        if (!fresh) observation = null
        const catalog = observedCatalog(identity, state!.officialEpoch)
        return { ...empty, status: directGrant || validGrant(cache) ? 'ready' : cache?.lease ? 'syncing' : cache?.grant ? 'expired' : 'unavailable', expiresAt: directGrant?.expiresAt ?? cache?.grant?.expiresAt ?? null, catalogRevision: catalog?.catalog.revision ?? cache?.catalog?.revision ?? directGrant?.catalogRevision ?? cache?.grant?.catalogRevision ?? null, syncedAt: catalog?.syncedAt ?? cache?.syncedAt ?? null, customerView }
      } catch { return empty }
    })
  }

  async function syncOfficialAccess(identity: OfficialIdentityRef, signal?: AbortSignal): Promise<OfficialStatus> {
    current(identity)
    void getOfficialDirectAccess(identity).catch(() => {})
    observationRequest++
    observation = null
    await awaitSignal(getOfficialCredential(identity), signal)
    await getCatalog(identity, signal, true)
    try {
      await account(identity, { version: 2, op: 'view.get', input: {}, requestId: randomUUID() }, signal)
    } catch (error) { cancelled(signal); current(identity); if (error instanceof OfficialError && error.code === 'account_changed') throw error }
    const status = getOfficialStatus()
    current(identity)
    if (!status.identity || !equalIdentity(status.identity, identity)) throw new OfficialError('account_changed')
    return status
  }
  async function clearOfficialAccess(identity: OfficialIdentityRef): Promise<void> {
    const before = current(identity), cache = readCache(identity)
    direct.clear()
    catalogObservation = null
    store.transaction(state => { current(identity); state.officialEpoch++; return { value: undefined, write: true } })
    store.withAccountLock(() => {
      try { const raw = readFileSync(path, 'utf8'); const plain = decodeSecret(createSecretCipher(options.home), raw); const value = plain ? cacheSchema.parse(JSON.parse(plain)) : null; if (value && equalIdentity(value.identity, identity) && value.epoch === before.officialEpoch) unlinkSync(path) } catch { /* epoch already fences inaccessible cache */ }
    })
    if (cache?.receipt) await cancelReceipt(identity, cache.receipt, before.token!.accessToken)
  }
  // Public Node callers receive the same fixed errors as sidecar callers.
  const safe = <A extends unknown[], T>(fn: (...args: A) => Promise<T>) => async (...args: A): Promise<T> => { try { return await fn(...args) } catch (error) { throw publicFailure(error) } }
  return { captureOfficialIdentity, withCurrentOfficialIdentity, getOfficialDirectAccess: safe(getOfficialDirectAccess), peekOfficialDirectAccess: direct.peek, getOfficialDirectSignal: direct.signal, invalidateOfficialDirectAccess: direct.invalidate, requestOfficialMembershipGrant: safe(requestOfficialMembershipGrant), getOfficialCredential: safe(getOfficialCredential), syncOfficialAccess: safe(syncOfficialAccess), clearOfficialAccess: safe(clearOfficialAccess), getOfficialCatalog: safe(getOfficialCatalog), getOfficialPriceQuote: safe(getOfficialPriceQuote), getOfficialStatus, account: safe(account) }
}
export type OfficialModelBroker = ReturnType<typeof createOfficialModelBroker>
let defaultBroker: { home: string; broker: OfficialModelBroker } | undefined
export function sharedOfficialModelBroker(options: OfficialBrokerOptions): OfficialModelBroker {
  if (defaultBroker?.home !== options.home) defaultBroker = { home: options.home, broker: createOfficialModelBroker(options) }
  return defaultBroker!.broker
}
function normalBroker(): OfficialModelBroker { return sharedOfficialModelBroker({ home: rivetHome() }) }
export const captureOfficialIdentity = (): OfficialIdentityRef | null => normalBroker().captureOfficialIdentity()
export const getOfficialStatus = (): OfficialStatus => normalBroker().getOfficialStatus()
export const getOfficialCustomerView = async (identity: OfficialIdentityRef): Promise<AccountSummary> => normalBroker().account(identity, { version: 2, op: 'view.get', input: {}, requestId: randomUUID() }) as Promise<AccountSummary>
export const withCurrentOfficialIdentity = <T>(identity: OfficialIdentityRef, action: (epoch: number) => T): T => normalBroker().withCurrentOfficialIdentity(identity, action)
export const requestOfficialMembershipGrant = (identity: OfficialIdentityRef, requestId: string, signal?: AbortSignal): Promise<{ grant: string; expiresAt: string }> => normalBroker().requestOfficialMembershipGrant(identity, requestId, signal)
export const syncOfficialAccess = (identity: OfficialIdentityRef, signal?: AbortSignal): Promise<OfficialStatus> => normalBroker().syncOfficialAccess(identity, signal)
export const getOfficialCredential = (identity: OfficialIdentityRef): Promise<OfficialCredential> => normalBroker().getOfficialCredential(identity)
export const getOfficialDirectAccess = (identity: OfficialIdentityRef) => normalBroker().getOfficialDirectAccess(identity)
export const peekOfficialDirectAccess = (identity: OfficialIdentityRef) => normalBroker().peekOfficialDirectAccess(identity)
export const getOfficialDirectSignal = (identity: OfficialIdentityRef) => normalBroker().getOfficialDirectSignal(identity)
export const invalidateOfficialDirectAccess = (identity: OfficialIdentityRef) => normalBroker().invalidateOfficialDirectAccess(identity)
export const clearOfficialAccess = (identity: OfficialIdentityRef): Promise<void> => normalBroker().clearOfficialAccess(identity)
export const getOfficialCatalog = (identity: OfficialIdentityRef, purpose: Purpose): Promise<Catalog> => normalBroker().getOfficialCatalog(identity, purpose)
export const getOfficialPriceQuote = (identity: OfficialIdentityRef, input: { bindingId: string; catalogRevision: string; pricingRevision: string }, signal?: AbortSignal): Promise<PriceQuote> => normalBroker().getOfficialPriceQuote(identity, input, signal)

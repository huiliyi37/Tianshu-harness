import { randomUUID, timingSafeEqual, createHash } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { accountStore } from './account.js'
import { atomicCredentialWrite } from './token-store.js'
import { createSecretCipher, decodeSecret, encodeSecret, resolveSecretBackend } from './secure-store.js'
import { createOfficialModelBroker, type OfficialModelBroker, type OfficialIdentityRef } from './official-model-auth.js'
import { OfficialError } from '../models/official-contract.js'
import { verifyGrantSignature, validateOfficialMembershipClaims } from '../config/pro-grant.js'
import { rivetHome } from '../config/paths.js'

type Broker = Pick<OfficialModelBroker, 'captureOfficialIdentity' | 'withCurrentOfficialIdentity' | 'requestOfficialMembershipGrant'>
type Operation = { id: string; requestId: string; deadline: number; state: 'pending' | 'uncertain' | 'installed' | 'denied'; denialCode?: 'auth_required' | 'credential_revoked' | 'entitlement_unavailable'; retryAt?: number }
type RecordValue = { version: 1; owner: OfficialIdentityRef; epoch: number; operation: Operation; grant?: string; expiresAt?: string }
export interface MembershipObservation { grant: string; expiresAt: string; owner: OfficialIdentityRef & { epoch: number } }
export interface MembershipOptions { home: string; broker?: Broker; publicKeyB64?: string; now?: () => number; ownsEnvironment?: () => boolean }
const sameOwner = (a: OfficialIdentityRef, b: OfficialIdentityRef) => a.subject === b.subject && a.accountSessionId === b.accountSessionId && a.deviceId === b.deviceId && a.generation === b.generation && a.incarnation === b.incarnation
const cancelled = (signal?: AbortSignal) => { if (signal?.aborted) throw new OfficialError('account_changed') }

/** All account authority is the broker's original ref/current transaction. */
export function createOfficialMembershipService(options: MembershipOptions) {
  const broker = options.broker ?? createOfficialModelBroker({ home: options.home })
  const path = join(options.home, 'membership-license.json'), now = options.now ?? Date.now
  const store = accountStore(options.home)
  let timer: ReturnType<typeof setTimeout> | undefined, stopped = true
  const controllers = new Set<AbortController>()
  let cipher: ReturnType<typeof createSecretCipher> | undefined
  function owned() { if (options.ownsEnvironment && !options.ownsEnvironment()) { dispose(); throw new OfficialError('account_changed') } }
  function prepare() {
    owned()
    const backend = resolveSecretBackend()
    if (backend === 'plaintext') throw new OfficialError('service_error')
    cipher ??= createSecretCipher(options.home, backend)
    if (cipher.backend !== backend) throw new OfficialError('service_error')
    return cipher
  }
  function readRecord(): RecordValue | null {
    try {
      const raw = readFileSync(path, 'utf8'), envelope = JSON.parse(raw), c = prepare()
      if (envelope.v !== 1 || envelope.s !== 'aes-256-gcm' || envelope.b !== c.backend || Object.keys(envelope).sort().join() !== 'b,d,s,v') return null
      const plain = decodeSecret(c, raw)
      if (!plain) return null
      const value = JSON.parse(plain) as RecordValue
      if (value.version !== 1 || !value.owner || !Number.isSafeInteger(value.epoch) || !value.operation || typeof value.operation.id !== 'string' || typeof value.operation.requestId !== 'string' || !Number.isFinite(value.operation.deadline) || !['pending', 'uncertain', 'installed', 'denied'].includes(value.operation.state)) return null
      if (value.operation.denialCode !== undefined && !['auth_required', 'credential_revoked', 'entitlement_unavailable'].includes(value.operation.denialCode)) return null
      if (value.operation.retryAt !== undefined && (!Number.isFinite(value.operation.retryAt) || value.operation.retryAt < 0)) return null
      return value
    } catch { return null }
  }
  function write(value: RecordValue) {
    const c = prepare(), raw = encodeSecret(c, JSON.stringify(value)), envelope = JSON.parse(raw)
    if (envelope.s !== 'aes-256-gcm' || envelope.b !== c.backend) throw new OfficialError('service_error')
    atomicCredentialWrite(path, raw)
  }
  function verified(value: RecordValue, identity: OfficialIdentityRef, epoch: number): MembershipObservation | null {
    if (!sameOwner(value.owner, identity) || value.epoch !== epoch || !value.grant || !value.expiresAt) return null
    const sig = verifyGrantSignature(value.grant, options.publicKeyB64)
    if (!sig.ok || !validateOfficialMembershipClaims(sig.claims, { now: now() }, identity).ok || Date.parse(value.expiresAt) !== sig.claims.exp) return null
    return { grant: value.grant, expiresAt: value.expiresAt, owner: { ...identity, epoch } }
  }
  function readCurrent(): MembershipObservation | null {
    if (!existsSync(path)) return null
    prepare()
    const identity = broker.captureOfficialIdentity()
    if (!identity) {
      store.withAccountLock(() => { if (!broker.captureOfficialIdentity()) { try { unlinkSync(path) } catch { /* already absent */ } } })
      return null
    }
    try {
      return broker.withCurrentOfficialIdentity(identity, epoch => {
        const value = readRecord()
        if (!value) return null
        if (!sameOwner(value.owner, identity) || value.epoch !== epoch) { unlinkSync(path); return null }
        const result = verified(value, identity, epoch)
        if (!result && value.grant) { delete value.grant; delete value.expiresAt; write(value) }
        return result
      })
    } catch { return null }
  }
  async function activate(identity: OfficialIdentityRef, requestId: string, signal?: AbortSignal): Promise<{ grant: string; expiresAt: string }> {
    owned(); cancelled(signal)
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new OfficialError('service_error')
    prepare()
    const operation: Operation = { id: randomUUID(), requestId, deadline: now() + 25000, state: 'pending' }
    const claim = broker.withCurrentOfficialIdentity(identity, epoch => {
      const prior = readRecord(), same = prior && sameOwner(prior.owner, identity) && prior.epoch === epoch
      if (same && ['pending', 'uncertain'].includes(prior.operation.state) && prior.operation.deadline > now()) throw new OfficialError('service_error')
      const value: RecordValue = { version: 1, owner: { ...identity }, epoch, operation, ...(same && verified(prior, identity, epoch) ? { grant: prior.grant, expiresAt: prior.expiresAt } : {}) }
      write(value); return epoch
    })
    const controller = new AbortController(); controllers.add(controller)
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    try {
      let result: { grant: string; expiresAt: string } | undefined
      for (let attempt = 0; attempt < 2; attempt++) {
        try { result = await broker.requestOfficialMembershipGrant(identity, requestId, combined); break } catch (error) {
          cancelled(combined)
          if (attempt || !(error instanceof OfficialError) || error.code !== 'service_error' || !error.retryable) throw error
          broker.withCurrentOfficialIdentity(identity, epoch => {
            const value = readRecord()
            if (!value || epoch !== claim || value.operation.id !== operation.id || value.operation.deadline <= now()) throw new OfficialError('account_changed')
            value.operation.state = 'uncertain'; write(value)
          })
        }
      }
      owned(); cancelled(combined)
      return broker.withCurrentOfficialIdentity(identity, epoch => {
        const value = readRecord()
        if (!result || !value || epoch !== claim || !sameOwner(value.owner, identity) || value.operation.id !== operation.id || value.operation.deadline <= now()) throw new OfficialError('account_changed')
        const candidate = { ...value, ...result }
        if (!verified(candidate, identity, epoch)) throw new OfficialError('service_error')
        candidate.operation.state = 'installed'; write(candidate)
        return { grant: result.grant, expiresAt: result.expiresAt }
      })
    } catch (error) {
      try {
        owned()
        broker.withCurrentOfficialIdentity(identity, epoch => {
          const value = readRecord()
          if (!value || epoch !== claim || !sameOwner(value.owner, identity) || value.operation.id !== operation.id) return
          const definitive = error instanceof OfficialError && ['auth_required', 'credential_revoked', 'entitlement_unavailable'].includes(error.code)
          value.operation.state = definitive ? 'denied' : 'uncertain'
          if (definitive && error instanceof OfficialError) {
            value.operation.denialCode = error.code as NonNullable<Operation['denialCode']>
            if (error.code === 'entitlement_unavailable') value.operation.retryAt = now() + 30000
          }
          if (definitive || !verified(value, identity, epoch)) { delete value.grant; delete value.expiresAt }
          write(value)
        })
      } catch { /* Original owner/operation has lost authority; never touch its successor. */ }
      throw error
    } finally { controllers.delete(controller) }
  }
  function clear() {
    store.withAccountLock(() => {
      // Owner replacement is checked inside the common transaction, including CLI logout.
      const identity = broker.captureOfficialIdentity(), value = readRecord()
      if (!identity || (value && !sameOwner(value.owner, identity))) { try { unlinkSync(path) } catch { /* absent */ } }
    })
  }
  async function tick() {
    if (stopped) return
    try { owned() } catch { return }
    const began = now(), identity = broker.captureOfficialIdentity()
    if (identity) {
      try {
        const denied = broker.withCurrentOfficialIdentity(identity, epoch => {
          const value = readRecord()
          if (!value || !sameOwner(value.owner, identity) || value.epoch !== epoch || value.operation.state !== 'denied') return false
          // Missing membership can change after purchase/renewal under this SID.
          // Old denied records have no reason: probe after their original lease,
          // then retain any definitive source denial learned by that probe.
          if (value.operation.denialCode === 'auth_required' || value.operation.denialCode === 'credential_revoked') return true
          return now() < (value.operation.retryAt ?? value.operation.deadline)
        })
        if (!denied) await activate(identity, randomUUID())
      } catch { /* Status remains pending; signed expiry is checked per use. */ }
    } else { try { clear() } catch { /* fail closed on read */ } }
    if (!stopped) {
      let delay = Math.max(1000, 30000 - (now() - began))
      try { const current = readCurrent(); if (current) delay = Math.max(1000, Math.min(delay, Date.parse(current.expiresAt) - now() - 5000)) } catch { /* bounded retry */ }
      timer = setTimeout(() => { void tick() }, delay); timer.unref()
    }
  }
  function start() {
    if (!stopped) return
    let current: MembershipObservation | null
    try { current = readCurrent() } catch { return } // Unavailable storage must not break sidecar startup.
    stopped = false
    if (current) { timer = setTimeout(() => { void tick() }, Math.max(1000, Math.min(30000, Date.parse(current.expiresAt) - now() - 5000))); timer.unref() }
    else void tick()
  }
  function dispose() { stopped = true; if (timer) clearTimeout(timer); timer = undefined; for (const controller of controllers) controller.abort() }
  return { activate, readCurrent, clear, start, dispose, captureIdentity: broker.captureOfficialIdentity }
}
export type OfficialMembershipService = ReturnType<typeof createOfficialMembershipService>
const environmentFingerprint = () => createHash('sha256').update(JSON.stringify(process.env)).digest('hex')
let normal: { home: string; environment: string; publicKeyB64?: string; service: OfficialMembershipService } | undefined
function normalService(publicKeyB64?: string) {
  const home = rivetHome(), environment = environmentFingerprint()
  if (normal?.home !== home || normal?.publicKeyB64 !== publicKeyB64 || normal?.environment !== environment) {
    normal?.service.dispose()
    // Capture the environment without resolving any credential source. A delayed tick must
    // never follow process-global settings into another profile or restored user defaults.
    normal = { home, environment, publicKeyB64, service: createOfficialMembershipService({ home, publicKeyB64, ownsEnvironment: () => environmentFingerprint() === environment }) }
  }
  return normal!.service
}
/** Synchronous real feature gate; no positive membership status is cached. */
export function readOfficialMembership(home: string, publicKeyB64?: string): MembershipObservation | null {
  if (home === rivetHome() && process.env.RIVET_DESKTOP !== '1') {
    try { const service = normalService(publicKeyB64); if (service.captureIdentity()) service.start() } catch { /* unavailable current account */ }
  }
  if (!existsSync(join(home, 'membership-license.json'))) return null
  try { return createOfficialMembershipService({ home, publicKeyB64 }).readCurrent() } catch { return null }
}

// The owned child receives this capability once; descendants/renderer never inherit it.
process.once('beforeExit', () => normal?.service.dispose())
const bridgeToken = process.env.RIVET_MEMBERSHIP_BRIDGE_TOKEN
delete process.env.RIVET_MEMBERSHIP_BRIDGE_TOKEN
export function membershipBridgeAuthorized(headers?: Record<string, string>, expected = bridgeToken): boolean {
  const candidate = headers?.['x-tianshu-membership-bridge']
  if ((headers && Object.hasOwn(headers, 'origin')) || !expected || expected.length < 32 || !candidate) return false
  const a = Buffer.from(candidate), b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
export const isMembershipPrivatePath = (path: string) => path === '/account/activate-model-membership' || path === '/account/model-membership-current'
const cleanups = new WeakMap<Function, { start: () => void; dispose: () => void }>()
export function ownMembershipLifecycle(handler: Function, service: OfficialMembershipService) { cleanups.set(handler, { start: service.start, dispose: service.dispose }) }
export function membershipCleanupFor(routes: Record<string, unknown>): { start: () => void; dispose: () => void } | undefined {
  const handler = routes['POST /account/activate-model-membership']
  return typeof handler === 'function' ? cleanups.get(handler) : undefined
}

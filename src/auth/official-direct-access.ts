import { z } from 'zod'
import { OfficialError, exactOrigin, publicFailure, utcSchema, type OfficialDirectGrant, type OfficialIdentityRef } from '../models/official-contract.js'

const grantSchema = z.object({
  credential: z.string().regex(/^sk-[^\s]+$/).max(8192), subject: z.string().uuid(), accountSessionId: z.string().uuid(),
  expiresAt: utcSchema, catalogRevision: z.string().min(1).max(256), bindingId: z.string().min(1).max(256),
  modelId: z.string().min(1).max(256), protocol: z.literal('openai'), origin: z.string().max(2048), path: z.literal('/v1/chat/completions'),
}).strict()

export interface DirectAccessOptions {
  enabled(identity: OfficialIdentityRef): boolean
  origins(): readonly string[]
  epoch(identity: OfficialIdentityRef): number
  exchange(identity: OfficialIdentityRef): Promise<unknown>
  now(): number
}

export function createOfficialDirectAccess(options: DirectAccessOptions) {
  let cached: { owner: string; identity: OfficialIdentityRef; grant: OfficialDirectGrant } | undefined
  const jobs = new Map<string, Promise<OfficialDirectGrant>>()
  let revision = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller = new AbortController()
  let retryDelay = 5000
  const owner = (identity: OfficialIdentityRef) => JSON.stringify([identity.subject, identity.accountSessionId, identity.deviceId, identity.generation, identity.incarnation, options.epoch(identity), revision])
  function schedule(identity: OfficialIdentityRef, expected: string, delay: number): void {
    clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        if (!options.enabled(identity) || owner(identity) !== expected) { scrub(); return }
        void obtain(identity, expected).catch(error => {
          try {
            if (publicFailure(error).retryable && options.enabled(identity) && owner(identity) === expected) { schedule(identity, expected, retryDelay); retryDelay = Math.min(60000, retryDelay * 2) }
          } catch { scrub() }
        })
      } catch { scrub() }
    }, Math.max(1000, delay))
    timer.unref?.()
  }
  function scrub(): void {
    try { if (cached && (!options.enabled(cached.identity) || owner(cached.identity) !== cached.owner)) clear() } catch { clear() }
  }
  function obtain(identity: OfficialIdentityRef, expected: string): Promise<OfficialDirectGrant> {
    let job = jobs.get(expected)
    if (!job) {
      job = (async () => {
        try {
          const grant = grantSchema.parse(await options.exchange(identity))
          if (owner(identity) !== expected) throw new OfficialError('account_changed')
          const expiry = Date.parse(grant.expiresAt)
          if (grant.subject !== identity.subject || grant.accountSessionId !== identity.accountSessionId) throw new OfficialError('account_changed')
          if (expiry <= options.now() || expiry > options.now() + 600000 || !options.origins().includes(exactOrigin(grant.origin))) throw new OfficialError('service_error')
          cached = { owner: expected, identity, grant: Object.freeze(grant) }
          if (controller.signal.aborted) controller = new AbortController()
          retryDelay = 5000
          schedule(identity, expected, expiry - options.now() - 30000)
          return cached.grant
        } catch (error) {
          const failure = publicFailure(error)
          if (cached?.owner === expected && ['auth_required', 'account_changed', 'credential_revoked', 'reauth_required'].includes(failure.code)) clear()
          throw failure
        }
      })().finally(() => { if (jobs.get(expected) === job) jobs.delete(expected) })
      jobs.set(expected, job)
    }
    return job.then(grant => { if (owner(identity) !== expected) throw new OfficialError('account_changed'); return grant })
  }
  async function get(identity: OfficialIdentityRef): Promise<OfficialDirectGrant | null> {
    scrub()
    const expected = owner(identity)
    if (!options.enabled(identity)) { clear(); return null }
    if (cached?.owner !== expected) cached = undefined
    const grant = cached?.grant
    if (grant && Date.parse(grant.expiresAt) > options.now() + 5000) {
      if (Date.parse(grant.expiresAt) <= options.now() + 30000) void obtain(identity, expected).catch(() => {})
      return grant
    }
    return obtain(identity, expected)
  }
  function peek(identity: OfficialIdentityRef): OfficialDirectGrant | null {
    scrub()
    const expected = owner(identity)
    if (!options.enabled(identity) || cached?.owner !== expected || Date.parse(cached.grant.expiresAt) <= options.now()) return null
    return cached.grant
  }
  function signal(identity: OfficialIdentityRef): AbortSignal {
    if (!peek(identity)) throw new OfficialError('service_error', 503, false)
    return controller.signal
  }
  function clear(): void {
    revision++; cached = undefined; clearTimeout(timer); timer = undefined
    controller.abort(new OfficialError('account_changed'))
  }
  function invalidate(identity: OfficialIdentityRef): void {
    const expected = owner(identity)
    if (cached?.owner !== expected) return
    clear()
    schedule(identity, owner(identity), 1000)
  }
  return { get, peek, signal, clear, invalidate }
}

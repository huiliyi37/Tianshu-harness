import type { TokenData } from './token-store.js'

export type { TokenData }

const EXPIRY_MARGIN_MS = 5 * 60_000

export function shouldRefresh(token: TokenData): boolean {
  return token.expiresAt - Date.now() < EXPIRY_MARGIN_MS
}


import { createHash, randomUUID } from 'node:crypto'
import { accountStamp, processAlive, sameAccount, sameSource, accountInstallationAllowed, type TokenStore } from './token-store.js'
import { refreshAccountTokenWithStatus, trustedAccountSource, revokeAccountSession, type DevicePollResult, type FetchInjection } from './account.js'
import { readAccountDeviceFingerprint } from './account-device.js'
import type { AccountSyncResult } from './account-sync.js'

type Renewal = { poll: DevicePollResult | null; code: AccountSyncResult['code']; requestNotSent?: true }
export interface AccountRenewalOptions extends FetchInjection { renew?: (credential: string) => Promise<Renewal>; revoke?: (credential: string) => Promise<boolean> }
export interface AccountRenewalResult { token: TokenData | null; code: AccountSyncResult['code'] | 'account_changed'; retryAfterSeconds?: number }
const renewals = new Map<string, Promise<AccountRenewalResult>>()

/** At most one unresolved rotation of a given installed credential, across processes. */
export function refreshAccountSession(store: TokenStore, original: TokenData, opts: AccountRenewalOptions = {}): Promise<AccountRenewalResult> {
  const stamp = accountStamp(original)
  const key = `${store.filePath}/${stamp?.incarnation}/${stamp?.generation}/${createHash('sha256').update(original.accessToken).digest('hex')}`
  const existing = renewals.get(key)
  if (existing) return existing
  const job = rotate().finally(() => { if (renewals.get(key) === job) renewals.delete(key) })
  renewals.set(key, job)
  return job

  async function rotate(): Promise<AccountRenewalResult> {
    const id = randomUUID(), deadline = Date.now() + 12000
    while (true) {
      const claim = store.transaction<{ kind: 'changed' | 'done' | 'uncertain' | 'deferred' | 'wait' | 'claimed'; token: TokenData | null; retryAfterSeconds?: number }>(state => {
        if (!sameAccount(stamp, state) || !state.token) return { value: { kind: 'changed', token: state.token } as const, write: false }
        if (state.token.accessToken !== original.accessToken) return { value: { kind: 'done', token: state.token } as const, write: false }
        if (!state.token.refreshToken) return { value: { kind: 'uncertain', token: state.token } as const, write: false }
        if (state.refresh && !state.refresh.uncertain && state.refresh.retryAfter !== undefined) {
          if (!Number.isSafeInteger(state.refresh.retryAfter) || state.refresh.retryAfter < 0 || state.refresh.retryAfter > Date.now() + 30000 || state.refresh.fingerprint !== createHash('sha256').update(state.token.refreshToken).digest('hex')) {
            state.refresh.uncertain = true
          } else if (state.refresh.retryAfter > Date.now()) {
            return { value: { kind: 'deferred', token: state.token, retryAfterSeconds: Math.ceil((state.refresh.retryAfter - Date.now()) / 1000) } as const, write: false }
          } else delete state.refresh
        }
        if (state.refresh) {
          if (state.refresh.uncertain || state.refresh.deadline <= Date.now() || !processAlive(state.refresh.pid)) {
            state.refresh.uncertain = true
            return { value: { kind: 'uncertain', token: state.token } as const, write: true }
          }
          return { value: { kind: 'wait', token: state.token } as const, write: false }
        }
        state.refresh = { id, deviceId: state.source?.deviceId ?? readAccountDeviceFingerprint(store.baseDir) ?? undefined, pid: process.pid, deadline, fingerprint: createHash('sha256').update(state.token.refreshToken).digest('hex') }
        return { value: { kind: 'claimed', token: state.token } as const, write: true }
      })
      if (claim.kind === 'changed') return { token: claim.token, code: 'account_changed' }
      if (claim.kind === 'done') return { token: claim.token, code: 'ok' }
      if (claim.kind === 'uncertain') return { token: claim.token, code: 'auth_required' }
      if (claim.kind === 'deferred') return { token: claim.token, code: 'network_error', retryAfterSeconds: claim.retryAfterSeconds }
      if (claim.kind === 'claimed') break
      if (Date.now() >= deadline) return { token: store.load(), code: 'auth_required' }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    let result: Renewal
    try { result = await (opts.renew ? opts.renew(original.refreshToken!) : refreshAccountTokenWithStatus(original.refreshToken!, opts)) }
    catch { result = { poll: null, code: 'network_error' } }
    const installed = store.transaction(state => {
      if (!sameAccount(stamp, state) || !state.token) return { value: { token: state.token, code: 'account_changed' } as AccountRenewalResult, write: false }
      if (state.refresh?.id !== id || state.token.accessToken !== original.accessToken) return { value: { token: state.token, code: 'ok' } as AccountRenewalResult, write: false }
      const poll = result.poll
      if (!poll && result.requestNotSent === true && result.code === 'network_error') {
        state.refresh.retryAfter = Date.now() + 30000
        return { value: { token: state.token, code: 'network_error', retryAfterSeconds: 30 } as AccountRenewalResult, write: true }
      }
      const deviceId = state.source?.deviceId ?? readAccountDeviceFingerprint(store.baseDir)
      const source = deviceId && poll ? trustedAccountSource(poll, deviceId) : undefined
      if (!poll?.accessToken || !poll.refreshToken || (state.source && (!source || source.subject !== state.source.subject || source.accountSessionId !== state.source.accountSessionId))) {
        state.refresh.uncertain = true
        return { value: { token: state.token, code: result.code === 'ok' ? 'protocol_error' : result.code } as AccountRenewalResult, write: true }
      }
      const next = { ...state.token, accessToken: poll.accessToken, refreshToken: poll.refreshToken, expiresAt: Date.now() + (poll.expiresIn ?? 3600) * 1000 }
      if (!accountInstallationAllowed(state, next, source)) { state.refresh.uncertain = true; return { value: { token: state.token, code: 'auth_required' } as AccountRenewalResult, write: true } }
      state.token = next
      if (source) state.source = source
      delete state.refresh
      return { value: { token: state.token, code: 'ok' } as AccountRenewalResult, write: true }
    })
    if (installed.code === 'account_changed' && result.poll?.accessToken) await compensateLogout(result.poll)
    return installed.code === 'account_changed' ? { ...installed, token: store.load() } : installed

    async function compensateLogout(poll: DevicePollResult): Promise<void> {
      let nonce: string | undefined
      try {
        nonce = store.transaction<string | undefined>(state => {
          const intent = state.logoutIntents?.find(value => sameAccount(stamp, value) && value.attemptId === id)
          if (!intent || intent.status !== 'awaiting') return { value: undefined, write: false }
          const received = intent.deviceId ? trustedAccountSource(poll, intent.deviceId) : undefined
          if (intent.source && (!sameSource(intent.source, received) || intent.source.deviceId !== received?.deviceId)) return { value: undefined, write: false }
          if (intent.source ? sameSource(state.source, intent.source) : !!state.token) return { value: undefined, write: false }
          if (state.logoutIntents?.some(other => other.status === 'revoking' && (!other.source || !intent.source))) return { value: undefined, write: false }
          // Trusted renewal can identify the original legacy source, but is never fresh-login recovery.
          if (!intent.source && received) { intent.source = received; state.retiredSources = [...(state.retiredSources ?? []), received] }
          intent.status = 'revoking'; intent.nonce = randomUUID(); intent.deadline = Date.now() + 10000
          return { value: intent.nonce, write: true }
        })
        if (!nonce) return
        let timer: ReturnType<typeof setTimeout> | undefined
        let success = false
        try {
          const request = opts.revoke ? opts.revoke(poll.accessToken!) : revokeAccountSession(poll.accessToken!, opts)
          success = await Promise.race([request, new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 10000) })])
        } catch { /* Failed or timed-out original-source revocation remains uncertain. */ } finally { if (timer) clearTimeout(timer) }
        store.transaction(state => {
          const intent = state.logoutIntents?.find(value => value.nonce === nonce && value.status === 'revoking')
          if (!intent) return { value: undefined, write: false }
          intent.status = success ? 'complete' : 'uncertain'
          return { value: undefined, write: true }
        })
      } catch { /* Preserve tombstone/fence; a local storage failure never restores login. */ }
    }
  }
}

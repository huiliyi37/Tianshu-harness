import type { AccountProfile, AccountProfileSnapshot, FetchInjection, StellarIdentity } from './account.js'
import { currentInstallVersion } from '../cli/version.js'
import type { TokenData } from './token-store.js'

export type AccountSyncCode = 'ok' | 'empty' | 'network_error' | 'timeout' | 'auth_required' | 'forbidden' | 'service_error' | 'protocol_error' | 'endpoint_unavailable'
export interface AccountPart<T> { status: AccountSyncCode; data?: T; fetchedAt?: number }
export interface AccountEntitlement {
  id: string; plan: 'basic' | 'pro'; name: string; expiresAt: number | null
  status: 'active' | 'expired' | 'revoked' | 'unconfirmed'
  restorable: boolean; reason: string; deviceLimit: number | null; devicesUsed: number | null
}
export interface AccountSnapshot {
  version: 1; userId: string
  deviceBinding?: { state: 'bound' | 'unbound' | 'unconfirmed'; licenseId: string | null }
  profile: AccountPart<AccountProfileSnapshot & { account: AccountProfile }>
  identity: AccountPart<StellarIdentity | null>
  entitlements: AccountPart<AccountEntitlement[]>
}
export interface AccountSyncResult { code: AccountSyncCode; snapshot?: AccountSnapshot; httpStatus?: number; elapsedMs: number }
export interface AccountSyncCache { code: AccountSyncCode; snapshot?: AccountSnapshot; checkedAt: number; httpStatus?: number }

const CODES: readonly string[] = ['ok', 'empty', 'network_error', 'timeout', 'auth_required', 'forbidden', 'service_error', 'protocol_error', 'endpoint_unavailable']
export const confirmedAccountPart = (part: AccountPart<unknown>): boolean => part.status === 'ok' || part.status === 'empty'
export function cachedAccountSync(value: TokenData | null): AccountSyncCache | undefined {
  return (value as (TokenData & { accountSync?: AccountSyncCache }) | null)?.accountSync
}

export function parseAccountSnapshot(raw: unknown, expectedUserId: string | null): AccountSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as AccountSnapshot
  if (value.version !== 1 || typeof value.userId !== 'string' || !value.userId || (expectedUserId && value.userId !== expectedUserId)) return null
  if (value.deviceBinding && (!['bound','unbound','unconfirmed'].includes(value.deviceBinding.state) || !(value.deviceBinding.licenseId === null || typeof value.deviceBinding.licenseId === 'string') || (value.deviceBinding.state === 'bound' && !value.deviceBinding.licenseId))) return null
  for (const key of ['profile', 'identity', 'entitlements'] as const) {
    const part = value[key]
    if (!part || !CODES.includes(part.status)) return null
    if (confirmedAccountPart(part) && (!Number.isFinite(part.fetchedAt) || (part.fetchedAt ?? 0) <= 0 || !('data' in part))) return null
  }
  const profile = confirmedAccountPart(value.profile) ? value.profile.data : undefined
  if (confirmedAccountPart(value.profile) && (!profile?.account || profile.account.userId !== value.userId || !(profile.avatarUrl === null || typeof profile.avatarUrl === 'string'))) return null
  const nullableString = (s: unknown) => s === null || s === undefined || typeof s === 'string'
  if (profile && (!['email','username','displayName','joinedAt'].every(k => nullableString((profile.account as unknown as Record<string,unknown>)[k])) || (profile.founding && (!nullableString(profile.founding.badgeCode) || !(profile.founding.rank === null || Number.isFinite(profile.founding.rank)) || ![null,1,2,3].includes(profile.founding.tier) || !Number.isFinite(profile.founding.total) || !Number.isFinite(profile.founding.limit))))) return null
  const identity = confirmedAccountPart(value.identity) ? value.identity.data : undefined
  if (confirmedAccountPart(value.identity) && identity !== null && (!identity || typeof identity.stellarId !== 'string' || !identity.stellarId || typeof identity.primaryDomain !== 'string' || !identity.primaryDomain || !nullableString(identity.title))) return null
  const licenses = confirmedAccountPart(value.entitlements) ? value.entitlements.data : undefined
  if (confirmedAccountPart(value.entitlements) && (!Array.isArray(licenses) || licenses.some(l => !l || typeof l.id !== 'string' || !['basic', 'pro'].includes(l.plan) || !['active', 'expired', 'revoked', 'unconfirmed'].includes(l.status) || typeof l.restorable !== 'boolean' || typeof l.reason !== 'string' || typeof l.name !== 'string' || ![l.deviceLimit,l.devicesUsed].every(n => n === null || (Number.isSafeInteger(n) && n >= 0)) || !(l.expiresAt === null || Number.isFinite(l.expiresAt)) || (l.restorable && (l.plan !== 'pro' || l.status !== 'active'))))) return null
  // Whitelist fields: unexpected server fields must never enter the desktop cache.
  return {
    version: 1, userId: value.userId,
    ...(value.deviceBinding ? { deviceBinding: { state: value.deviceBinding.state, licenseId: value.deviceBinding.licenseId } } : {}),
    profile: { status: value.profile.status, fetchedAt: value.profile.fetchedAt, ...(profile ? { data: {
      avatarUrl: profile.avatarUrl, founding: profile.founding ? { badgeCode: profile.founding.badgeCode, rank: profile.founding.rank, tier: profile.founding.tier, total: profile.founding.total, limit: profile.founding.limit } : null, fetchedAt: value.profile.fetchedAt!,
      account: { userId: value.userId, email: profile.account.email, username: profile.account.username, displayName: profile.account.displayName, joinedAt: profile.account.joinedAt },
    } } : {}) },
    identity: { status: value.identity.status, fetchedAt: value.identity.fetchedAt, ...(identity === null ? { data: null } : identity ? { data: { stellarId: identity.stellarId, primaryDomain: identity.primaryDomain, title: identity.title } } : {}) },
    entitlements: { status: value.entitlements.status, fetchedAt: value.entitlements.fetchedAt, ...(Array.isArray(licenses) ? { data: licenses.map(l => ({ id: l.id, plan: l.plan, name: l.name, expiresAt: l.expiresAt, status: l.status, restorable: l.restorable, reason: l.reason, deviceLimit: l.deviceLimit, devicesUsed: l.devicesUsed })) } : {}) },
  }
}

export async function fetchAccountSnapshot(accessToken: string, base: string, headers: Record<string, string>, subject: string | null, opts: FetchInjection = {}): Promise<AccountSyncResult> {
  const started = Date.now()
  let code: AccountSyncCode = 'protocol_error'
  let httpStatus: number | undefined
  let snapshot: AccountSnapshot | undefined
  try {
    const response = await (opts.fetchImpl ?? fetch)(`${base}/functions/v1/tui-account-snapshot`, {
      method: 'POST', headers: { ...headers, Authorization: `Bearer ${accessToken}` }, body: '{}', signal: AbortSignal.timeout(12_000),
    })
    httpStatus = response.status
    if (response.ok) {
      snapshot = parseAccountSnapshot(await response.json(), subject) ?? undefined
      code = snapshot ? 'ok' : 'protocol_error'
    } else code = response.status === 401 ? 'auth_required' : response.status === 403 ? 'forbidden' : response.status === 404 ? 'endpoint_unavailable' : 'service_error'
  } catch (error) {
    code = error instanceof SyntaxError ? 'protocol_error' : error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : 'network_error'
  }
  const result = { code, snapshot, httpStatus, elapsedMs: Date.now() - started }
  if (code !== 'ok') console.warn('[account-sync]', JSON.stringify({ stage: 'snapshot', endpoint: 'tui-account-snapshot', code, httpStatus, elapsedMs: result.elapsedMs, runtime: process.version, sidecarVersion: currentInstallVersion(), desktopVersion: /^[0-9a-zA-Z.+-]{1,40}$/.test(process.env.RIVET_DESKTOP_VERSION ?? '') ? process.env.RIVET_DESKTOP_VERSION : 'unknown' }))
  return result
}

/**
 * 权益分区的合并。
 *
 * 分区可信（`ok`/`empty`）**不等于**每一条都可信：授权服务不可用时，官网快照仍会把
 * 分区标成成功，只把该条降级成 `status: 'unconfirmed'`，并把**官网镜像**的期限
 * （可能早已过期）与空配额（`deviceLimit/devicesUsed: null`）放进载荷。整段替换
 * 会让上一次确认为真的到期时间与设备配额消失，用户看到的还是镜像日期——比未知更糟。
 *
 * 所以未确认的条目按 `id` 从缓存里回填上一次**确认为已知**的期限与配额（含确认为
 * `null` 的永久授权：`null` 是值，不是缺失）；`status`/`reason`/`restorable` 一律用
 * 本次响应的——未知永远不得复活成可恢复。缓存里本身还是 `unconfirmed` 的条目不参与
 * 回填，否则一次降级会被后续每次降级继承成「确认值」。
 */
function mergeEntitlements(part: AccountPart<AccountEntitlement[]>, cached?: AccountPart<AccountEntitlement[]>): AccountPart<AccountEntitlement[]> {
  if (!confirmedAccountPart(part)) return { ...part, data: cached?.data, fetchedAt: cached?.fetchedAt }
  if (!Array.isArray(part.data)) return part
  const known = new Map((cached?.data ?? []).filter(entry => entry.status !== 'unconfirmed').map(entry => [entry.id, entry]))
  return { ...part, data: part.data.map(entry => {
    if (entry.status !== 'unconfirmed') return entry
    const confirmedEntry = known.get(entry.id)
    if (!confirmedEntry) return entry
    return { ...entry, expiresAt: confirmedEntry.expiresAt, deviceLimit: confirmedEntry.deviceLimit, devicesUsed: confirmedEntry.devicesUsed }
  }) }
}

export function mergeAccountSnapshot(previous: AccountSyncCache | undefined, result: AccountSyncResult): AccountSyncCache {
  const incoming = result.snapshot
  if (!incoming) return { ...previous, code: result.code, checkedAt: Date.now(), httpStatus: result.httpStatus }
  const old = previous?.snapshot?.userId === incoming.userId ? previous.snapshot : undefined
  const merge = <T>(part: AccountPart<T>, cached?: AccountPart<T>): AccountPart<T> => confirmedAccountPart(part) ? part : { ...part, data: cached?.data, fetchedAt: cached?.fetchedAt }
  return { code: result.code, checkedAt: Date.now(), httpStatus: result.httpStatus, snapshot: {
    version: 1, userId: incoming.userId, profile: merge(incoming.profile, old?.profile), identity: merge(incoming.identity, old?.identity), entitlements: mergeEntitlements(incoming.entitlements, old?.entitlements),
    deviceBinding: incoming.deviceBinding,
  } }
}

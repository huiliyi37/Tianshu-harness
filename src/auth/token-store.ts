import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync, readdirSync, rmdirSync, existsSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { join } from 'node:path'

import { createSecretCipher, decodeSecret, encodeSecret, type SecretCipher } from './secure-store.js'
import { invalidateAccountAuthority } from './account-authority.js'

/**
 * 创始徽章快照（服务端只给原始值：`user_badges.badge_code` 与位次）。
 * 档位名 / 罗马数字 / 主题色 / 冠饰**不在这里**——它们经 `agent/founding-tiers.ts`
 * 从 badge_code 或位次查出来，两处各存一份文案是老的坏味道。
 */
export interface FoundingBadgeSnapshot {
  /** `user_badges.badge_code`；可能是历史命名（展示时经 founding-tiers 归一） */
  badgeCode: string | null
  /** 注册位次（1 = 第一个注册的人）；取不到为 null */
  rank: number | null
  /** 位次所在档位（1|2|3）；取不到为 null */
  tier: number | null
  /** 当前创始用户总数 */
  total: number
  /** 一档名额（「创世 No.001 / 300」这类展示要用） */
  limit: number
}

/**
 * 账号资料快照：头像与创始身份。
 *
 * 与 `identity` 同生命周期（登出 `clear()` 一并消失）——头像和铭牌都是账号的
 * 属性，账号没了它们没有意义。
 */
export interface AccountProfileSnapshot {
  /** 官网 `profiles.avatar_url`；无头像为 null（客户端回退首字母，不造默认图） */
  avatarUrl: string | null
  /** 非创始用户为 null（此时不渲染铭牌，也不显示空壳） */
  founding: FoundingBadgeSnapshot | null
  /** 取到时刻（ms）。 */
  fetchedAt: number
}

export interface TokenData {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  accountId?: string
  /**
   * 账号星籍缓存（仅 `account` store 使用；provider store 恒缺席）。
   *
   * 放在凭据文件里而不是单独文件，是因为它与登录态**同生命周期**：登出
   * `clear()` 一并消失，不会留下孤儿身份（星籍是账号的属性，账号没了它没有意义）。
   * 可选字段 —— `load()` 是 `JSON.parse` 无形状校验，旧文件天然读得进来。
   *
   * ⚠️ `save()` 是全量写：任何"只写 identity"的调用都会把 accessToken 抹掉。
   * 写入一律走 `saveAccountIdentity()`，不要手搓。
   */
  identity?: {
    stellarId: string
    primaryDomain: string
    title: string
    /** 取到时刻（ms）。超过 TTL 视为陈旧，由调用方决定是否后台刷新。 */
    fetchedAt: number
  }
  /**
   * 账号资料快照（头像 + 创始铭牌）。同样可选、同样与登录态同生命周期。
   *
   * ⚠️ 同 `identity`：写入一律走 `saveAccountProfile()`，手搓会抹掉 accessToken。
   */
  profile?: AccountProfileSnapshot
}

/**
 * 凭据落盘存储：`<baseDir>/<provider>.json`。
 *
 * 自 v3.21.1 起内容为 **AES-256-GCM 信封**（数据密钥托管在 OS 密钥库或本机
 * 密钥文件，见 `secure-store.ts`），不再是明文 JSON —— 旧明文文件仍可读取，
 * 下次 `save()` 自动升级。`mode: 0o600` 保留作纵深防御（POSIX 生效；Windows
 * 上不生效，由加密信封兜底）。
 *
 * 为什么加密：refresh token 是长期凭据，而 `~/.rivet` 常落在会被云同步/备份/
 * 其它进程读到的地方；拿到文件 ≈ 拿到账号。详见
 * docs/security/pro-hardening.md 向量⑥。
 */

export interface AccountSource {
  subject: string
  accountSessionId: string
  /** Local consistency hint; the website verifies the device against its DB. */
  deviceId: string
}
export interface AccountStamp { incarnation: string; generation: number; revision: number }
export interface AccountAttempt { id: string; pid: number; deadline: number; fingerprint: string; deviceId?: string; uncertain?: boolean; retryAfter?: number }
export interface AccountLogoutIntent {
  incarnation: string; generation: number; attemptId: string; deviceId?: string; source?: AccountSource
  status: 'awaiting' | 'revoking' | 'complete' | 'uncertain' | 'abandoned'
  nonce?: string; deadline?: number
}
export interface AccountState extends AccountStamp {
  version: 1
  token: TokenData | null
  source?: AccountSource
  login?: { id: string; deviceId: string }
  refresh?: AccountAttempt
  officialEpoch: number
  retiredSources?: AccountSource[]
  logoutIntents?: AccountLogoutIntent[]
}
const stamps = new WeakMap<object, AccountStamp>()
const pendingLogouts = new WeakSet<object>()
export function logoutRefreshPending(token: TokenData | null, store?: TokenStore): boolean {
  return !!token && pendingLogouts.has(token) || !!store?.readAccountState()?.logoutIntents?.some(intent => ['awaiting', 'revoking', 'uncertain'].includes(intent.status))
}
export function sameSource(a: AccountSource | undefined, b: AccountSource | undefined): boolean { return !!a && !!b && a.subject === b.subject && a.accountSessionId === b.accountSessionId }
/** Unverified JWT claims can only deny an installation, never establish official source facts. */
export function accountInstallationAllowed(state: AccountState, data: TokenData, source?: AccountSource, freshDevicePoll = false): boolean {
  let candidate = source
  if (!candidate) { try { const claims = JSON.parse(Buffer.from(data.accessToken.split('.')[1]!, 'base64url').toString()); candidate = { subject: claims.sub, accountSessionId: claims.session_id, deviceId: '' } } catch {} }
  if (state.retiredSources?.some(retired => sameSource(retired, candidate))) return false
  for (const intent of state.logoutIntents ?? []) {
    if (intent.status === 'revoking') {
      if (intent.source) { if (!source || sameSource(intent.source, source)) return false }
      else if ((intent.deadline ?? Infinity) > Date.now() || !freshDevicePoll || !source) return false
    }
    if (!intent.source && (intent.status === 'uncertain' || intent.status === 'revoking')) {
      if (!freshDevicePoll || !source) return false
    }
  }
  if (freshDevicePoll && source) for (const intent of state.logoutIntents ?? []) {
    if (!intent.source && (intent.status === 'uncertain' || intent.status === 'revoking')) intent.status = 'abandoned'
  }
  return true
}
function attach(token: TokenData, state: AccountStamp): TokenData {
  stamps.set(token, { incarnation: state.incarnation, generation: state.generation, revision: state.revision })
  return token
}
export function sameAccount(a: Pick<AccountStamp, 'incarnation' | 'generation'> | undefined, b: Pick<AccountStamp, 'incarnation' | 'generation'> | undefined): boolean {
  return !!a && !!b && a.incarnation === b.incarnation && a.generation === b.generation
}
export function accountStamp(token: TokenData | null | undefined): AccountStamp | undefined { return token ? stamps.get(token) : undefined }
function freshState(): AccountState { return { version: 1, incarnation: randomUUID(), generation: 0, revision: 0, token: null, officialEpoch: 0 } }
function validToken(value: unknown): value is TokenData {
  const v = value as TokenData | null
  return !!v && typeof v === 'object' && typeof v.accessToken === 'string' && !!v.accessToken && Number.isFinite(v.expiresAt)
    && (v.refreshToken === undefined || typeof v.refreshToken === 'string')
}
function envelopeValid(raw: string): boolean {
  const v = JSON.parse(raw) as Record<string, unknown>
  if (!v || typeof v !== 'object') return false
  if (!('v' in v || 's' in v || 'd' in v || 'b' in v)) return true
  return v.v === 1 && v.s === 'aes-256-gcm' && typeof v.d === 'string' && ['keychain', 'dpapi', 'local-key'].includes(String(v.b))
}
/** Write only our uniquely named temporary file; fsync before publishing the rename. */
export function atomicCredentialWrite(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, content); fsyncSync(fd); closeSync(fd); fd = undefined
    renameSync(temporary, path)
    try { const dir = openSync(join(path, '..'), 'r'); try { fsyncSync(dir) } finally { closeSync(dir) } } catch { /* Some platforms do not support directory fsync. */ }
  } finally {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temporary) } catch { /* published or no temporary file */ }
  }
}
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

export class TokenStore {
  readonly filePath: string
  private cipher: SecretCipher
  constructor(readonly baseDir: string, private provider: string, cipher?: SecretCipher) {
    this.filePath = join(baseDir, `${provider}.json`)
    this.cipher = cipher ?? createSecretCipher(baseDir)
  }

  /** Same short transaction lock coordinates account and official cache commits. */
  withAccountLock<T>(action: () => T): T {
    if (this.provider !== 'account') throw Error('account_store_required')
    mkdirSync(this.baseDir, { recursive: true })
    const directory = `${this.filePath}.lock`, nonce = randomUUID()
    const prepared = `${directory}.${nonce}`, owner = `${nonce}.json`
    mkdirSync(prepared, { mode: 0o700 })
    writeFileSync(join(prepared, owner), JSON.stringify({ pid: process.pid, host: hostname(), deadline: Date.now() + 5000 }), { mode: 0o600, flag: 'wx' })
    const end = Date.now() + 2000
    let acquired = false
    try {
      while (!acquired) {
        try { renameSync(prepared, directory); acquired = true } catch (error) {
          if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw Error('account_store_unavailable')
          try {
            const names = readdirSync(directory)
            if (names.length === 1 && /^[0-9a-f-]+\.json$/.test(names[0]!)) {
              const observed = names[0]!, data = JSON.parse(readFileSync(join(directory, observed), 'utf8'))
              if (data.host === hostname() && Number.isSafeInteger(data.pid) && data.pid > 0 && Number.isFinite(data.deadline) && data.deadline < Date.now() && !processAlive(data.pid)) {
                try { unlinkSync(join(directory, observed)); rmdirSync(directory) } catch { /* Another contender removed this exact dead owner. */ }
              }
            }
          } catch { /* Unknown ownership is never forcibly broken. */ }
          if (Date.now() >= end) throw Error('account_store_unavailable')
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
        }
      }
      if (!existsSync(join(directory, owner))) throw Error('account_store_unavailable')
      return action()
    } finally {
      const path = acquired ? directory : prepared
      try { unlinkSync(join(path, owner)); rmdirSync(path) } catch { /* Only this owner's file may be removed. */ }
    }
  }

  private readPlain(): unknown {
    const raw = readFileSync(this.filePath, 'utf8')
    if (!envelopeValid(raw)) throw Error('account_store_unavailable')
    const decoded = decodeSecret(this.cipher, raw)
    if (decoded === null) throw Error('account_store_unavailable')
    return JSON.parse(decoded)
  }
  readAccountState(): AccountState | null {
    try {
      const value = this.readPlain() as AccountState
      if (value.version === 1 && typeof value.incarnation === 'string' && value.incarnation.length > 0
        && Number.isSafeInteger(value.generation) && value.generation >= 0 && Number.isSafeInteger(value.revision) && value.revision >= 0
        && Number.isSafeInteger(value.officialEpoch) && value.officialEpoch >= 0 && (value.token === null || validToken(value.token))) {
        if (value.token) attach(value.token, value)
        return value
      }
      if (validToken(value)) {
        const state = { ...freshState(), incarnation: createHash('sha256').update(JSON.stringify(value)).digest('hex'), token: value }
        attach(value, state); return state
      }
      return null
    } catch { return null }
  }
  private writeState(state: AccountState): void {
    if (![state.revision + 1, state.generation, state.officialEpoch].every(value => Number.isSafeInteger(value) && value >= 0)) throw Error('account_store_unavailable')
    state.revision++
    atomicCredentialWrite(this.filePath, encodeSecret(this.cipher, JSON.stringify(state)))
    if (state.token) attach(state.token, state)
  }
  /** Caller must not await inside this local transaction. Returning false leaves disk unchanged. */
  transaction<T>(action: (state: AccountState) => { value: T; write: boolean }, recover = false): T {
    // Warm vault access before entering the short filesystem transaction.
    if (!this.readAccountState()) encodeSecret(this.cipher, '{}')
    let authorityChanged = false
    const value = this.withAccountLock(() => {
      let state = this.readAccountState()
      if (!state) {
        if (existsSync(this.filePath) && !recover) throw Error('account_store_unavailable')
        state = freshState()
      }
      const original = `${state.incarnation}/${state.generation}/${state.officialEpoch}`
      const result = action(state)
      if (result.write) {
        this.writeState(state)
        authorityChanged = original !== `${state.incarnation}/${state.generation}/${state.officialEpoch}`
      }
      return result.value
    })
    if (authorityChanged) invalidateAccountAuthority(this.baseDir)
    return value
  }
  load(): TokenData | null {
    if (this.provider === 'account') return this.readAccountState()?.token ?? null
    try { const value = this.readPlain(); return validToken(value) ? value : null } catch { return null }
  }
  save(data: TokenData): void {
    if (!validToken(data)) throw Error('invalid_token')
    if (this.provider === 'account') {
      const installed = this.transaction(state => {
        if (!accountInstallationAllowed(state, data)) throw Error('account_changed')
        state.generation++; state.officialEpoch++; state.token = { ...data }; delete state.source; delete state.refresh; delete state.login
        return { value: state, write: true }
      }, true)
      attach(data, installed)
      return
    }
    mkdirSync(this.baseDir, { recursive: true })
    atomicCredentialWrite(this.filePath, encodeSecret(this.cipher, JSON.stringify(data, null, 2)))
  }
  patchAccount(expected: TokenData, patch: (current: TokenData) => TokenData): TokenData | null {
    const stamp = accountStamp(expected)
    return this.transaction<TokenData | null>(state => {
      if (!state.token || !sameAccount(stamp, state)) return { value: state.token, write: false }
      const token = patch(state.token)
      // Category writes cannot rotate credential material or lose account identity.
      state.token = { ...token, accessToken: state.token.accessToken, refreshToken: state.token.refreshToken, expiresAt: state.token.expiresAt }
      attach(state.token, state)
      return { value: state.token, write: true }
    })
  }
  beginLogin(deviceId: string): string {
    return this.transaction(state => { state.login = { id: randomUUID(), deviceId }; return { value: state.login.id, write: true } }, true)
  }
  cancelLogin(intent?: string): void {
    this.transaction(state => {
      if (intent && state.login?.id !== intent) return { value: undefined, write: false }
      delete state.login; return { value: undefined, write: true }
    })
  }
  installLogin(data: TokenData, intent: string, source?: AccountSource, freshDevicePoll = false): TokenData | null {
    return this.transaction<TokenData | null>(state => {
      if (state.login?.id !== intent || (source && source.deviceId !== state.login.deviceId)) return { value: null, write: false }
      if (!accountInstallationAllowed(state, data, source, freshDevicePoll)) return { value: null, write: false }
      state.generation++; state.officialEpoch++; state.token = { ...data }; state.source = source
      delete state.refresh; delete state.login
      attach(state.token, state); return { value: state.token, write: true }
    })
  }
  clearAccount(): TokenData | null {
    const cleared = this.transaction(state => {
      const previous = state.token
      if (state.source && !state.retiredSources?.some(retired => sameSource(retired, state.source))) state.retiredSources = [...(state.retiredSources ?? []), state.source]
      if (state.refresh && previous) {
        pendingLogouts.add(previous)
        state.logoutIntents = [...(state.logoutIntents ?? []), { incarnation: state.incarnation, generation: state.generation, attemptId: state.refresh.id, deviceId: state.refresh.deviceId, source: state.source, status: 'awaiting' }]
      }
      state.generation++; state.officialEpoch++; state.token = null
      delete state.source; delete state.refresh; delete state.login
      // Tombstone is authoritative even if deletion of an obsolete cache fails.
      return { value: { previous, incarnation: state.incarnation, generation: state.generation }, write: true }
    }, true)
    this.withAccountLock(() => {
      const current = this.readAccountState()
      if (current && current.incarnation === cleared.incarnation && current.generation === cleared.generation && !current.token) {
        try { unlinkSync(join(this.baseDir, 'official-access.json')) } catch { /* The durable tombstone already invalidates it. */ }
      }
    })
    return cleared.previous
  }
  clear(): void {
    if (this.provider === 'account') { this.clearAccount(); return }
    try { unlinkSync(this.filePath) } catch { /* absent */ }
  }
}

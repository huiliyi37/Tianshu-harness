/**
 * 天枢账号登录（RFC 8628 device flow，服务端为官网 Supabase Edge Functions）。
 *
 * ## 为什么走 device flow 而不是内嵌登录窗
 * 桌面端 WebView 内嵌窗口的回调写不进 sidecar（见
 * `desktop/src/surfaces/InsightsSurface.tsx` 的历史问题与
 * `insights-login-failure-contract.test.ts` 的守卫）。浏览器授权 + 轮询是唯一在
 * CLI / TUI / 桌面三种客户端都成立的形状。
 *
 * ## 与 src/auth/device-flow.ts 的关系
 * 那个模块是 RFC 8628 的**通用**解析（snake_case：device_code / user_code /
 * verification_uri），而官网 EF 返回**驼峰**。两者不兼容——照搬会静默拿到
 * undefined（用户看到「登录中」永远转圈）。本模块按官网 EF 的真实契约解析。
 * 目前 device-flow.ts 仍是零调用方，留作将来对接标准 RFC 8628 服务端时用。
 *
 * ## 账号 token 与 license token 是两回事
 * 本模块只处理**账号**身份（Supabase session）；Pro 解锁仍由授权服的 Ed25519
 * token + Rust 验签负责（`desktop/src-tauri/src/activation.rs`）。两者分开存储：
 * `<RIVET_HOME>/account.json` vs `<RIVET_HOME>/license.json`。
 */
import { TokenStore, type AccountProfileSnapshot as StoredAccountProfile, type FoundingBadgeSnapshot, type TokenData } from './token-store.js'
import { fetchAccountSnapshot as fetchSnapshot, type AccountSyncResult } from './account-sync.js'
import { AccountDeviceRequestError, classifyDeviceError, deviceHttpError } from './account-device-errors.js'
import { FOUNDING_USER_LIMIT, isFoundingBadge, tierOfBadgeCode, tierOfRank } from '../agent/founding-tiers.js'

// 快照类型是消费方（sidecar 路由、桌面端镜像）要用的形状——从本模块再导出一次，
// 免得每个调用方都绕到 token-store 去拿。
export type { FoundingBadgeSnapshot }
export type AccountProfileSnapshot = StoredAccountProfile & { account?: AccountProfile | null; unconfirmed?: Array<'avatar' | 'founding'> }

/** 官网 Supabase 项目（Edge Functions 基址）。 */
const DEFAULT_ACCOUNT_API = 'https://grcedmhghzroqnirizcy.supabase.co'

/** 官网站点基址（Supabase 项目之外的另一个地址：账号页/星籍页在这里）。 */
const DEFAULT_ACCOUNT_SITE = 'https://tianshuharness.com'

/**
 * Supabase publishable key —— **公开密钥**。
 *
 * 需要它是因为官网 Edge Functions 开着 `verify_jwt`：不带认证头的请求直接
 * 401（2026-09-14 探针实测，当时 CLI 侧漏了这一步，单测全绿但真实调用打不通）。
 * DEPLOYMENT.md 写明这个 key「设计上随 JS 产物分发」，任何浏览器请求里都可见，
 * 因此内置于 CLI 不构成泄露。
 *
 * 指向自托管 / 测试项目时用 `RIVET_ACCOUNT_ANON_KEY` 覆盖。
 */
const DEFAULT_PUBLISHABLE_KEY = 'sb_publishable_9fLEHwAUNOLZpayKfPW1-g_bbcNNoCR'

/** 单次 HTTP 调用的超时。轮询本身靠 deadline 控制，这里防的是单请求挂死。导出供 account-license 复用。 */
export const HTTP_TIMEOUT_MS = 10_000

/**
 * `fetch` 注入点。
 *
 * 默认用全局 fetch。侧车（`rivet serve`）**必须**显式注入一个挂了代理
 * dispatcher 的 fetch：`setupHttpProxy()` 只被交互式会话的
 * `bootstrapInteractiveSession` 调用（`src/bootstrap.ts`），`src/server/serve.ts`
 * 有自己的入口，不经过它 —— 于是 serve 进程既不看 `HTTPS_PROXY` 也不看系统
 * 代理，配了代理的用户会卡在「等待授权」转圈。TUI 侧无需注入（那条路径已装
 * 全局 dispatcher）。
 */
export type FetchLike = typeof fetch

export interface FetchInjection {
  fetchImpl?: FetchLike
}

/** Edge Function 调用所需的头（apikey 是 verify_jwt 的凭据）。导出供 account-license 复用。 */
export function accountHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    apikey: process.env.RIVET_ACCOUNT_ANON_KEY ?? DEFAULT_PUBLISHABLE_KEY,
  }
}

/**
 * 账号 API 基址。可用 `RIVET_ACCOUNT_API` 覆盖（自托管 / 指向测试项目）。
 */
export function accountApiBase(): string {
  return (process.env.RIVET_ACCOUNT_API ?? DEFAULT_ACCOUNT_API).replace(/\/+$/, '')
}

/**
 * 官网站点基址（账号页 / 星籍页所在）。
 *
 * 与 `accountApiBase()` 分开：那个是 Supabase 项目地址，这个是产品站点。
 * 客户端只在「去官网看星籍」这类跳转里用它。
 *
 * **刻意不开 env 覆盖**（与上两个覆盖点不同）：`RIVET_*` 每加一个都要上
 * `src/config/env-registry.ts` 的账（assembly-audit 会拦），而这里只是一个
 * 跳转链接——自托管部署拿不到自定义站点时，最坏结果是打开官网首页，不是功能失效。
 * 真有了自托管需求再加覆盖点并同步生成器。
 */
function accountSiteBase(): string {
  return DEFAULT_ACCOUNT_SITE
}

/** 星籍页 URL（桌面端「在官网查看」按钮的目标；官网路由见其 router 的 `/space/identity`）。 */
export function accountIdentityUrl(): string {
  return `${accountSiteBase()}/space/identity`
}

/**
 * 账号与授权页 URL——个人中心权益面板「在官网查看账号与授权」的目标。
 *
 * 与 `accountIdentityUrl()` 同源同基址，只是路径不同；域名单一来源因此仍只有
 * `accountSiteBase()` 一处。**文案刻意不写「管理设备」**：该页上的远程解绑入口
 * 是账号授权体系的 Task 4.1，至今未实现（Wave 4 未开始）——不给用户指向不存在的
 * 功能。等官网侧就绪后，改这里一行即可。
 */
export function accountManageUrl(): string {
  return `${accountSiteBase()}/space/account`
}

// ── 授权请求 ─────────────────────────────────────────────────────────────

export interface DeviceCreateResult {
  deviceCode: string
  userCode: string
  expiresIn: number
  pollInterval: number
  verifyUrl: string
}

/**
 * 解析 `tui-auth-create` 的响应。
 *
 * 三个字段缺一不可：deviceCode 用于轮询，userCode 要展示给用户，
 * verifyUrl 是让用户去浏览器打开的地方——缺任何一个流程都走不下去，
 * 返回半成品只会让故障点后移（表现为「转圈」而不是报错）。
 */
export function parseDeviceCreate(raw: Record<string, unknown>): DeviceCreateResult {
  const deviceCode = raw.deviceCode
  const userCode = raw.userCode
  const verifyUrl = raw.verifyUrl

  if (typeof deviceCode !== 'string' || !deviceCode) {
    throw new Error('device create: missing deviceCode')
  }
  if (typeof userCode !== 'string' || !userCode) {
    throw new Error('device create: missing userCode')
  }
  if (typeof verifyUrl !== 'string' || !verifyUrl) {
    throw new Error('device create: missing verifyUrl')
  }

  return {
    deviceCode,
    userCode,
    verifyUrl,
    expiresIn: typeof raw.expiresIn === 'number' ? raw.expiresIn : 300,
    pollInterval: typeof raw.pollInterval === 'number' ? raw.pollInterval : 5,
  }
}

export interface RequestDeviceCodeOpts extends FetchInjection {
  tuiVersion?: string
  deviceName?: string
  /** 客户端持久硬件指纹——授权页用它作为设备标识（迁移 047 起） */
  deviceFingerprint?: string
}

/** 发起一次授权请求。调用方负责把 userCode / verifyUrl 展示给用户。 */
export async function requestDeviceCode(opts: RequestDeviceCodeOpts = {}): Promise<DeviceCreateResult> {
  try {
    const doFetch = opts.fetchImpl ?? fetch
    const res = await doFetch(`${accountApiBase()}/functions/v1/tui-auth-create`, {
      method: 'POST',
      headers: accountHeaders(),
      body: JSON.stringify({
        tuiVersion: opts.tuiVersion ?? null,
        deviceName: opts.deviceName ?? null,
        deviceFingerprint: opts.deviceFingerprint ?? null,
        purpose: 'account-login',
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    if (!res.ok) {
      throw deviceHttpError(res.status)
    }
    let created: DeviceCreateResult
    try { created = parseDeviceCreate((await res.json()) as Record<string, unknown>) }
    catch { throw new AccountDeviceRequestError('account-device-protocol') }
    // 补上 code：返回的链接必须是「拿去就能打开」的。EF 给的是页面基址，
    // 直接打开会停在授权页的「缺少授权码」态 —— 见 deviceAuthorizeUrl。
    return { ...created, verifyUrl: deviceAuthorizeUrl(created.verifyUrl, created.userCode) }
  } catch (error) { throw classifyDeviceError(error) }
}

/**
 * 把 userCode 拼进授权页链接。
 *
 * 官网 `/auth/device` 从 `route.query.code` 取设备码，取不到就停在「缺少授权码」
 * 态（文案还写着「请从终端或桌面端的提示里复制完整链接，或在地址后补上
 * ?code= 参数」）；而 `tui-auth-create` 的 `verifyUrl` 是可配置的页面基址、
 * **不带 code**（2026-09-14 实测线上响应）。所以「拿到链接就能打开」这件事
 * 必须由客户端补齐——三端都从 `requestDeviceCode` 取链接，补一次就够。
 */
export function deviceAuthorizeUrl(verifyUrl: string, userCode: string): string {
  const url = new URL(verifyUrl)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('device create: invalid authorization URL')
  }
  url.searchParams.set('code', userCode)
  return url.toString()
}

// ── 轮询 ─────────────────────────────────────────────────────────────────

export type PollStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'already_consumed'
  | 'error'

export interface DevicePollResult {
  status: PollStatus
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
}

/**
 * 解析 `tui-auth-check` 的响应。
 *
 * `approved` 却没有 accessToken 视为异常而非「成功但空」——否则会把空凭据写盘，
 * 用户下次启动发现自己「已登录」但什么都做不了。
 */
export function parseDevicePoll(raw: Record<string, unknown>): DevicePollResult {
  const known: readonly string[] = ['pending', 'approved', 'denied', 'expired', 'already_consumed', 'error']
  const status: PollStatus = typeof raw.status === 'string' && known.includes(raw.status) ? raw.status as PollStatus : 'error'

  if (status === 'approved') {
    const accessToken = raw.accessToken
    if (typeof accessToken !== 'string' || !accessToken) {
      throw new Error('device poll: approved without accessToken')
    }
    return {
      status,
      accessToken,
      refreshToken: typeof raw.refreshToken === 'string' ? raw.refreshToken : undefined,
      expiresIn: typeof raw.expiresIn === 'number' ? raw.expiresIn : 3600,
    }
  }

  return { status }
}

/** 该状态是否意味着「不用再轮询了」。 */
export function isTerminalPollStatus(s: PollStatus): boolean {
  return s === 'denied' || s === 'expired' || s === 'already_consumed' || s === 'error'
}

export interface PollOpts extends FetchInjection {
  intervalSeconds?: number
  timeoutMs?: number
  /** 每次 tick 回调（用于在同一行刷新进度，避免刷屏） */
  onTick?: (elapsedMs: number) => void
}

/**
 * 单次检查里的「可重试」失败：网络抖动、非 404 的 HTTP 错误。
 *
 * 与协议错误分开——响应结构不对（`approved` 却缺 accessToken）重试一万次也是
 * 同一个结果，只是把真正的原因（服务端契约变了）埋进 5 分钟后的「已过期」里。
 */
class TransientCheckError extends Error {}

/**
 * 问一次授权结果。
 *
 * `pollForAccountToken` 是「一直问到有结果」的完整流程（TUI 用）；本函数是
 * 「问一次」的原语，给桌面端 sidecar 路由用 —— 那条路上由前端按 pollInterval
 * 重发，因为 `rivetFetch` 有 15s 默认超时，长循环会被切断。
 *
 * 404 按 `expired` 返回：码被清理说明它已过期或不存在，继续问只是白等。
 *
 * @throws TransientCheckError（重试有意义）、parseDevicePoll 的协议错误（无意义）
 */
export async function checkDeviceOnce(
  deviceCode: string,
  opts: FetchInjection = {},
): Promise<DevicePollResult> {
  const doFetch = opts.fetchImpl ?? fetch
  let res: Response
  try {
    res = await doFetch(`${accountApiBase()}/functions/v1/tui-auth-check`, {
      method: 'POST',
      headers: accountHeaders(),
      body: JSON.stringify({ deviceCode }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
  } catch (e) {
    throw new TransientCheckError((e as Error).message)
  }

  if (res.status === 404) return { status: 'expired' }
  if (!res.ok) throw new TransientCheckError(`device check failed: ${res.status}`)

  // 协议错误原样冒泡（parseDevicePoll 对「approved 无 token」抛错）
  return parseDevicePoll((await res.json()) as Record<string, unknown>)
}

/**
 * 轮询直到拿到 token 或进入终态。
 *
 * 单次网络抖动不终止整轮登录（等下一个 tick 再试）；协议错误立即冒泡 —— 见
 * `TransientCheckError`。
 */
export async function pollForAccountToken(
  deviceCode: string,
  opts: PollOpts = {},
): Promise<DevicePollResult> {
  const intervalMs = (opts.intervalSeconds ?? 5) * 1000
  const totalMs = opts.timeoutMs ?? 300_000
  const deadline = Date.now() + totalMs

  while (Date.now() < deadline) {
    try {
      const parsed = await checkDeviceOnce(deviceCode, { fetchImpl: opts.fetchImpl })
      if (parsed.status !== 'pending') return parsed
    } catch (e) {
      if (!(e instanceof TransientCheckError)) throw e
    }

    opts.onTick?.(Date.now() - (deadline - totalMs))
    await sleep(intervalMs)
  }

  return { status: 'expired' }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── 落盘 ─────────────────────────────────────────────────────────────────

/**
 * 账号凭据存储：`<RIVET_HOME>/account.json`（权限 0600，复用 TokenStore）。
 *
 * provider 名用 'account' 而非某个模型 provider 名——避免与 provider 的
 * `<provider>.json` 撞名互相覆盖。
 */
export function accountStore(rivetHome: string): TokenStore {
  return new TokenStore(rivetHome, 'account')
}

/** 把轮询结果写盘。没有 accessToken 时抛错（不写空凭据）。 */
export function saveAccountToken(store: TokenStore, poll: DevicePollResult): TokenData {
  if (!poll.accessToken) {
    throw new Error('saveAccountToken: missing accessToken')
  }
  const data: TokenData = {
    accessToken: poll.accessToken,
    refreshToken: poll.refreshToken,
    expiresAt: Date.now() + (poll.expiresIn ?? 3600) * 1000,
  }
  store.save(data)
  return data
}

// ── 账号资料 ─────────────────────────────────────────────────────────────

export interface AccountProfile {
  email: string | null
  userId: string | null
  displayName?: string | null
  username?: string | null
  joinedAt?: string | null
}

/**
 * 拉账号资料（邮箱 / 用户 id）。Supabase Auth 的 `/auth/v1/user` 要用户 JWT。
 *
 * 设备凭据的 session_id 属于 tui_sessions，GoTrue 可能拒绝它；本人资料以
 * PostgREST 验证过 JWT/RLS 的 profiles 行为准，Auth 用户资料只补充邮箱。
 * 失败返回 null 而不是抛：离线不该让「已登录」这个事实消失 —— 本地 token 还在，
 * 拉不到资料只说明网络不通，把状态报成「未登录」会误导用户重新登录一遍。
 */
export async function fetchAccountProfile(
  accessToken: string,
  opts: FetchInjection = {},
): Promise<AccountProfile | null> {
  const doFetch = opts.fetchImpl ?? fetch
  try {
    // 官网编辑昵称写 profiles.display_name，Auth metadata 可能仍是注册时的旧值。
    const subject = jwtSubject(accessToken)
    const websiteProfile = doFetch(`${accountApiBase()}/rest/v1/profiles?select=id,display_name,username,created_at&limit=1${subject ? `&id=eq.${encodeURIComponent(subject)}` : ''}`, {
      method: 'GET',
      headers: { ...accountHeaders(), Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    }).then(async res => res.ok ? await res.json() as unknown : null).catch(() => null)
    const res = await doFetch(`${accountApiBase()}/auth/v1/user`, {
      method: 'GET',
      headers: { ...accountHeaders(), Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    }).catch(() => null)
    const raw = res?.ok ? (await res.json().catch(() => null)) as Record<string, unknown> | null : null
    const rows = await websiteProfile
    const row = (Array.isArray(rows) ? rows[0] : null) as Record<string, unknown> | null
    const userId = subject ?? (typeof raw?.id === 'string' ? raw.id : null)
    const ownProfile = row && userId && row.id === userId ? row : null
    if (!ownProfile && !raw) return null
    const metadata = raw?.user_metadata as Record<string, unknown> | undefined
    const name = [ownProfile?.display_name, ownProfile?.username, metadata?.username, metadata?.full_name, metadata?.name].find(value => typeof value === 'string' && value.trim())
    return {
      username: typeof ownProfile?.username === 'string' ? ownProfile.username : typeof metadata?.username === 'string' ? metadata.username : null,
      displayName: typeof name === 'string' ? name.trim() : null,
      joinedAt: typeof ownProfile?.created_at === 'string' ? ownProfile.created_at : typeof raw?.created_at === 'string' && Number.isFinite(Date.parse(raw.created_at)) ? raw.created_at : null,
      email: typeof raw?.email === 'string' ? raw.email : null,
      userId,
    }
  } catch {
    return null
  }
}

/** Device grants rotate through the website EF, not GoTrue's browser-session endpoint. */
export async function refreshAccountToken(refreshToken: string, opts: FetchInjection = {}): Promise<DevicePollResult | null> {
  try {
    const response = await (opts.fetchImpl ?? fetch)(`${accountApiBase()}/functions/v1/tui-auth-refresh`, {
      method: 'POST', headers: { ...accountHeaders(), Authorization: `Bearer ${refreshToken}` },
      body: '{}', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const result = parseDevicePoll({ ...await response.json() as Record<string, unknown>, status: 'approved' })
    return result.refreshToken ? result : null
  } catch { return null }
}


// ── 星籍（stellar identity）─────────────────────────────────────────────

/**
 * 账号的星籍：官网选的星域 + 星籍号 + 称号。
 *
 * 只读展示用。换星籍（reroll）是官网的事，客户端不提供入口——一生只变一次，
 * 为它做一个客户端写路径不值当。
 */
export interface StellarIdentity {
  /** `TS-<2 位域码>-<6 位>`，如 `TS-FU-AKKV7C`。系统标识，展示时另做本地化。 */
  stellarId: string
  /** 域码（`FU` 等）。展示层经 `src/agent/stellar-domain-codes.ts` 换中文名。 */
  primaryDomain: string
  /** 进度称号（`observer` 等）。未知值由展示层原样透出。 */
  title: string
}

/** 星籍缓存的新鲜期。星籍一生只变一次（reroll 上限 1），24h 足够且几乎不产生请求。 */
export const ACCOUNT_IDENTITY_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 从 access token 的载荷里取 `sub`（user_id）。
 *
 * **不验签**——它不是信任边界的判据，只用于把服务端返回的行与本人对一次账；
 * 解不出来就返回 null（跳过一次对账，不影响主路径）。token 是官网 EF 用项目
 * JWT secret 签的 Supabase 兼容 JWT（`_shared/crypto.ts` 的 `generateAccessToken`）。
 */
export function jwtSubject(token: string): string | null {
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const sub = (JSON.parse(json) as { sub?: unknown }).sub
    return typeof sub === 'string' && sub ? sub : null
  } catch {
    return null
  }
}

/** 解析 PostgREST 返回的一行星籍。字段缺失回 null（不造半成品）。 */
export function parseStellarIdentity(raw: unknown): StellarIdentity | null {
  const row = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined
  if (!row || typeof row !== 'object') return null
  const stellarId = row.stellar_id
  const primaryDomain = row.primary_domain
  if (typeof stellarId !== 'string' || !stellarId) return null
  if (typeof primaryDomain !== 'string' || !primaryDomain) return null
  const title = typeof row.title === 'string' && row.title ? row.title : 'observer'
  return { stellarId, primaryDomain, title }
}

/**
 * 读本人的星籍（`stellar_identities`，PostgREST + 用户 JWT）。
 *
 * 三条设计取舍：
 * 1. **不按 user_id 过滤**。RLS 策略是 `USING (auth.uid() = user_id)`，本就只回
 *    本人那一行（2026-09-18 线上探针实测：不带过滤返回 1 行本人记录，只带 apikey
 *    的反向对照返回 0 行）。加过滤要求先拿到 user_id，多一个来源、多一次网络。
 * 2. **仍然对一次账**：返回行的 `user_id` 与 token 的 `sub` 不一致就回 null——
 *    宁可少显示，也不显示别人的星籍（策略被改宽也不至于漏出去）。
 * 3. **失败一律回 null 不抛**：星籍是装饰性信息，不该让账号状态查询失败；
 *    与 `fetchAccountProfile` 同口径（离线不等于未登录）。
 */
export async function fetchStellarIdentity(
  accessToken: string,
  opts: FetchInjection = {},
): Promise<StellarIdentity | null> {
  const doFetch = opts.fetchImpl ?? fetch
  try {
    const res = await doFetch(
      `${accountApiBase()}/rest/v1/stellar_identities?select=user_id,stellar_id,primary_domain,title&limit=1`,
      {
        method: 'GET',
        headers: { ...accountHeaders(), Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      },
    )
    if (!res.ok) return null
    const rows = (await res.json()) as unknown
    const row = (Array.isArray(rows) ? rows[0] : undefined) as Record<string, unknown> | undefined
    if (!row) return null
    const sub = jwtSubject(accessToken)
    if (sub && typeof row.user_id === 'string' && row.user_id !== sub) return null
    return parseStellarIdentity(row)
  } catch {
    return null
  }
}

/**
 * 把星籍写进账号凭据文件。
 *
 * **必须以 token 为底展开**：`TokenStore.save()` 是全量 `JSON.stringify` 且不校验，
 * 只写 identity 会把 accessToken 当场抹掉（下次启动表现为「文件在但登录没了」）。
 * 所以写入口只有这一个函数，调用方不许手搓。
 */
export function saveAccountIdentity(
  store: TokenStore,
  token: TokenData,
  identity: StellarIdentity,
  now: number = Date.now(),
): TokenData {
  const next: TokenData = { ...token, identity: { ...identity, fetchedAt: now } }
  store.save(next)
  return next
}

/** 读缓存副本；字段不全（老文件/坏数据）时回 null。 */
export function cachedAccountIdentity(
  token: TokenData | null,
): { identity: StellarIdentity; fetchedAt: number } | null {
  const c = token?.identity
  if (!c || typeof c.stellarId !== 'string' || !c.stellarId) return null
  if (typeof c.primaryDomain !== 'string' || !c.primaryDomain) return null
  return {
    identity: { stellarId: c.stellarId, primaryDomain: c.primaryDomain, title: c.title || 'observer' },
    fetchedAt: typeof c.fetchedAt === 'number' ? c.fetchedAt : 0,
  }
}

/** 缓存是否已过期（fetchedAt 缺失视为过期 → 触发一次刷新）。 */
export function isAccountIdentityStale(fetchedAt: number, now: number = Date.now()): boolean {
  return !Number.isFinite(fetchedAt) || fetchedAt <= 0 || now - fetchedAt > ACCOUNT_IDENTITY_TTL_MS
}

// ── 账号资料快照（头像 + 创始铭牌）───────────────────────────────────────
//
// 与星籍同一套通道与口径：PostgREST 直读 + 用户 JWT（RLS 收口本人），
// 失败一律回 null 不抛——头像与铭牌是装饰性信息，不该让账号状态查询失败。

/**
 * 头像 URL（`profiles.avatar_url`）。
 *
 * 与星籍同理**不按 id 过滤**：003 迁移后 profiles 的策略是 `auth.uid() = id`，
 * 查询天然只回本人那一行。无头像（列为 null）与取数失败都回 null——两者的
 * 客户端表现相同（回退首字母），区分它们只会多一个没人消费的状态。
 */
export async function fetchAccountAvatar(
  accessToken: string,
  opts: FetchInjection = {},
): Promise<string | null> {
  const doFetch = opts.fetchImpl ?? fetch
  try {
    const res = await doFetch(`${accountApiBase()}/rest/v1/profiles?select=id,avatar_url&limit=1`, {
      method: 'GET',
      headers: { ...accountHeaders(), Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const rows = (await res.json()) as unknown
    const row = (Array.isArray(rows) ? rows[0] : undefined) as Record<string, unknown> | undefined
    if (!row) return null
    // 同一笔对账：行不属于本 token 就丢弃（策略被改宽也不至于显示别人的头像）
    const sub = jwtSubject(accessToken)
    if (sub && typeof row.id === 'string' && row.id !== sub) return null
    const url = row.avatar_url
    return typeof url === 'string' && url ? url : null
  } catch {
    return null
  }
}

/**
 * 最高档创始徽章 + 位次。
 *
 * 两个原始来源：`user_badges.badge_code`（可能多行，取最高档）与
 * `rpc/get_my_founder_rank`（JSONB，形状见官网 `020`/`032` 迁移）。
 * **RPC 的形状未在本仓实测过**，所以解析刻意宽容：类型不符就当取不到，
 * 绝不让一个陌生形状把整个账号状态查询打挂。
 *
 * 非创始用户（无徽章且 `is_founder` 非真）回 null——调用方据此不渲染铭牌。
 */
export async function fetchFoundingBadge(
  accessToken: string,
  opts: FetchInjection = {},
): Promise<FoundingBadgeSnapshot | null> {
  const doFetch = opts.fetchImpl ?? fetch
  const headers = { ...accountHeaders(), Authorization: `Bearer ${accessToken}` }

  const [badgeCode, rankInfo] = await Promise.all([(async (): Promise<string | null> => {
    try {
      const res = await doFetch(`${accountApiBase()}/rest/v1/user_badges?select=badge_code`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      })
      if (!res.ok) return null
      const rows = (await res.json()) as unknown
      if (!Array.isArray(rows)) return null
      // 多行时取档位最高的（tier 数值最小 = 最早 = 最高）
      const codes = rows
        .map((r) => (r as Record<string, unknown> | null)?.badge_code)
        .filter((c): c is string => typeof c === 'string' && c.length > 0 && isFoundingBadge(c))
        .sort((a, b) => (tierOfBadgeCode(a)?.tier ?? 9) - (tierOfBadgeCode(b)?.tier ?? 9))
      return codes[0] ?? null
    } catch {
      return null
    }
  })(), (async (): Promise<{ rank: number | null; total: number } | null> => {
    try {
      const res = await doFetch(`${accountApiBase()}/rest/v1/rpc/get_my_founder_rank`, {
        method: 'POST',
        headers,
        body: '{}',
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      })
      if (!res.ok) return null
      const body = (await res.json()) as unknown
      const obj = (Array.isArray(body) ? body[0] : body) as Record<string, unknown> | undefined
      if (!obj || typeof obj !== 'object') return null
      const isFounder = obj.is_founder === true
      const rank = typeof obj.rank === 'number' && obj.rank > 0 ? obj.rank : null
      const total = typeof obj.total === 'number' && obj.total >= 0 ? obj.total : 0
      if (!isFounder && rank === null) return null
      return { rank, total }
    } catch {
      return null
    }
  })()])

  if (!badgeCode && !rankInfo) return null

  const tier = badgeCode
    ? (tierOfBadgeCode(badgeCode)?.tier ?? tierOfRank(rankInfo?.rank ?? 0)?.tier ?? null)
    : (tierOfRank(rankInfo?.rank ?? 0)?.tier ?? null)

  return {
    badgeCode,
    rank: rankInfo?.rank ?? null,
    tier,
    total: rankInfo?.total ?? 0,
    limit: FOUNDING_USER_LIMIT,
  }
}

/**
 * 账号资料快照：头像 + 创始身份，一次并发取齐。
 *
 * 取数失败时回 null；已确认没有头像或创始铭牌时仍返回确认状态。
 * 任一部分失败时保留 unconfirmed，避免联系人缓存把失败掩盖一整天。
 */
export async function fetchAccountProfileSnapshot(
  accessToken: string,
  opts: FetchInjection = {},
): Promise<AccountProfileSnapshot | null> {
  const successes = new Set<string>()
  const doFetch = opts.fetchImpl ?? fetch
  const tracked: FetchInjection = { ...opts, fetchImpl: async (input, init) => {
    const response = await doFetch(input, init)
    if (response.ok) {
      const valid = await response.clone().json().catch(() => null)
      const url = String(input)
      const subject = jwtSubject(accessToken)
      if (url.includes('select=id,avatar_url') && Array.isArray(valid) && typeof valid[0]?.id === 'string' && (!subject || valid[0].id === subject)) successes.add('avatar')
      if (url.includes('user_badges') && Array.isArray(valid)) successes.add('badges')
      const rank = Array.isArray(valid) ? valid[0] : valid
      if (url.includes('get_my_founder_rank') && rank && (typeof rank.is_founder === 'boolean' || Number.isInteger(rank.rank))) successes.add('rank')
    }
    return response
  } }
  const [avatarUrl, founding] = await Promise.all([fetchAccountAvatar(accessToken, tracked), fetchFoundingBadge(accessToken, tracked)])
  if (avatarUrl === null && founding === null && (!successes.has('avatar') || !successes.has('badges') || !successes.has('rank'))) return null
  const unconfirmed: Array<'avatar' | 'founding'> = []
  if (!successes.has('avatar')) unconfirmed.push('avatar')
  if (!successes.has('badges') || !successes.has('rank')) unconfirmed.push('founding')
  return { avatarUrl, founding, unconfirmed, fetchedAt: Date.now() }
}

/**
 * 把账号资料快照写进凭据文件。
 *
 * **必须以 token 为底展开**：`TokenStore.save()` 是全量写且不校验，只写 profile
 * 会把 accessToken 当场抹掉（下次启动表现为「文件在但登录没了」）。
 */
export function saveAccountProfile(
  store: TokenStore,
  token: TokenData,
  profile: AccountProfileSnapshot,
  now: number = Date.now(),
): TokenData {
  const next: TokenData = { ...token, profile: { ...profile, fetchedAt: now } }
  store.save(next)
  return next
}

/** 读缓存副本；形状不全（老文件 / 坏数据）时回 null。 */
export function cachedAccountProfile(token: TokenData | null): AccountProfileSnapshot | null {
  const p = token?.profile as AccountProfileSnapshot | undefined
  if (!p) return null
  const avatarUrl = typeof p.avatarUrl === 'string' && p.avatarUrl ? p.avatarUrl : null
  const founding =
    p.founding && typeof p.founding === 'object'
      ? {
          badgeCode: typeof p.founding.badgeCode === 'string' ? p.founding.badgeCode : null,
          rank: typeof p.founding.rank === 'number' ? p.founding.rank : null,
          tier: typeof p.founding.tier === 'number' ? p.founding.tier : null,
          total: typeof p.founding.total === 'number' ? p.founding.total : 0,
          limit: typeof p.founding.limit === 'number' ? p.founding.limit : FOUNDING_USER_LIMIT,
        }
      : null
  const account = p.account && typeof p.account === 'object' ? {
    email: typeof p.account.email === 'string' ? p.account.email : null,
    userId: typeof p.account.userId === 'string' ? p.account.userId : null,
    username: typeof p.account.username === 'string' ? p.account.username : null,
    displayName: typeof p.account.displayName === 'string' ? p.account.displayName : null,
    joinedAt: typeof p.account.joinedAt === 'string' ? p.account.joinedAt : null,
  } : null
  if (avatarUrl === null && founding === null && account === null && !Array.isArray(p.unconfirmed)) return null
  return { avatarUrl, founding, account, unconfirmed: p.unconfirmed, fetchedAt: typeof p.fetchedAt === 'number' ? p.fetchedAt : 0 }
}

/** Cancellation and logout are capabilities scoped to this request/session. */
async function endAccountRequest(body: {deviceCode?: string; accessToken?: string}, opts: FetchInjection): Promise<boolean> {
  const response = await (opts.fetchImpl ?? fetch)(`${accountApiBase()}/functions/v1/tui-auth-end`, {
    method: 'POST', headers: accountHeaders(), body: JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })
  return response.ok
}
export function cancelDeviceCode(deviceCode: string, opts: FetchInjection = {}): Promise<boolean> {
  return endAccountRequest({deviceCode}, opts)
}
export function revokeAccountSession(accessToken: string, opts: FetchInjection = {}): Promise<boolean> {
  return endAccountRequest({accessToken}, opts)
}

export function fetchAccountSnapshot(accessToken: string, opts: FetchInjection = {}): Promise<AccountSyncResult> {
  return fetchSnapshot(accessToken, accountApiBase(), accountHeaders(), jwtSubject(accessToken), opts)
}

export async function refreshAccountTokenWithStatus(credential: string, opts: FetchInjection = {}): Promise<{ poll: DevicePollResult | null; code: AccountSyncResult['code'] }> {
  const outcome: {code: AccountSyncResult['code']} = {code:'protocol_error'}
  const started = Date.now()
  let httpStatus: number | undefined
  const poll = await refreshAccountToken(credential, { fetchImpl: async (input, init) => {
    try {
      const response = await (opts.fetchImpl ?? fetch)(input, init)
      httpStatus = response.status
      outcome.code = response.ok ? 'ok' : response.status === 401 ? 'auth_required' : response.status === 403 ? 'forbidden' : response.status === 404 ? 'endpoint_unavailable' : 'service_error'
      return response
    } catch (error) {
      outcome.code = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : 'network_error'
      throw error
    }
  } })
  if (!poll && outcome.code === 'ok') outcome.code = 'protocol_error'
  if (!poll) console.warn('[account-sync]', JSON.stringify({ stage: 'renewal', endpoint: 'tui-auth-refresh', code:outcome.code, httpStatus, elapsedMs:Date.now()-started, runtime: process.version, desktopVersion: /^[0-9a-zA-Z.+-]{1,40}$/.test(process.env.RIVET_DESKTOP_VERSION ?? '') ? process.env.RIVET_DESKTOP_VERSION : 'unknown' }))
  return { poll, code:outcome.code }
}

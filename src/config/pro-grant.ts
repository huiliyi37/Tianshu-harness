/**
 * Pro 会话凭证（grant）验签 —— 桌面端硬 gate 的信任锚。
 *
 * ## 为什么需要它
 *
 * 旧实现的桌面硬 gate 是「`RIVET_DESKTOP=1` 时只认 `RIVET_PRO==='1'`」：
 * 一个**裸环境变量**就是全部凭据。任何能设环境变量的手段（命令行直启
 * sidecar、Frida hook CreateProcessW 注入 env block、父进程继承）都能白嫖
 * Pro，且不需要改动任何一个字节的磁盘文件。
 *
 * 现在改为：shell（Rust，编译进机器码）在 `is_pro()` 通过后，把**服务端
 * Ed25519 签名的许可证 token** 作为凭证注入 `RIVET_PRO_GRANT`。凭证不可
 * 伪造：攻击者能设环境变量、能改 config、能塞文件，但造不出有效签名。
 *
 * ## 契约（与 `license-server/src/token.ts` / `activation.rs` 完全一致）
 *
 * ```
 * token = base64url(JSON(payload)) + "." + base64url(ed25519_sig)
 * 签名消息 = 第一段 base64url 字符串的 ASCII 字节（不是原始 JSON）
 * ```
 *
 * payload 字段：`product` / `deviceId` / `tier` / `iat` / `exp` / `lic`。
 * 额外字段（`features` / `bundleHash` / `ver`）为前向兼容保留，验签时忽略
 * 未知字段，但一旦出现且本机无法证实，则不因此放行也不因此拒绝（见下）。
 *
 * ## 这里**不做**什么（以及为什么）
 *
 * - **不做设备指纹强绑定**：指纹由 Rust `machine_uid` 计算，node 侧复刻
 *   会有误判风险（Linux 容器 / macOS 硬件变更 → 付费用户被锁死）。设备
 *   绑定在 shell 侧 `read_status()` 已强制（`device_mismatch`），凭证能
 *   被注入本身就意味着 shell 已确认过设备匹配。这里再比对
 *   `RIVET_PRO_DEVICE_ID`（shell 注入）与 payload.deviceId 作为**纵深
 *   防御**，不一致直接拒绝。
 * - **不查在线吊销**：node 侧没有网络信任链，吊销由 shell 心跳
 *   （`/verify`）负责，这里只吃 shell 的结论 + token 自身的时间窗。
 *
 * 时间窗规则（与 `activation.rs::evaluate_decoded` **必须逐字一致**，
 * 两侧各有同一张表驱动测试；常量由 license-keys-drift 测试守）：
 *
 * ```text
 * 1. 产品 / 设备 / lic 硬过期 → 拒绝
 * 2. iat 在未来超过时钟容差   → not_yet_valid
 * 3. 预算 = 服务端下发的 maxOfflineMs（有限且 >= 0）
 *      有预算 → deadline = iat + 预算 + 时钟容差   ← 服务端说了算（可收紧到 0 = 必须在线）
 *      无预算 → deadline = max(exp, iat + 10 天)   ← 老 token 兜底（= v3.21.1 行为）
 * 4. now <= deadline → 放行（now > exp 时标记 grace）
 *    否则 → 拒绝：有预算 = offline_budget_exhausted，无预算 = expired
 * ```
 *
 * 窗口的每一根锚点（`iat`/`exp`/`maxOfflineMs`）都在 Ed25519 签名之下：攻击者
 * 改本地时间、改明文 `license.json` 都只能缩小窗口，不能放大。
 */
import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto'

import { LICENSE_PRODUCT, LICENSE_PUBLIC_KEY_B64 } from './license-keys.js'

/** Ed25519 SubjectPublicKeyInfo 的固定 DER 前缀，用于把 raw 32 字节公钥包装成 KeyObject。 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/**
 * 离线预算的**本地兜底**（天）：只在 token 没有服务端下发的 `maxOfflineMs` 时
 * 使用（服务端未升级 / 老 token），此时按 `max(exp, iat + 10 天)` 放行，与
 * v3.21.1 的客户端行为一致，避免滚动升级把在用的付费用户突然锁死。
 *
 * 正常路径是**服务端下发**：签名的 `maxOfflineMs` 说多久就多久，服务端可按
 * 许可证收紧到 0（必须在线），无需发客户端版本。
 *
 * 必须与 `activation.rs::DEFAULT_OFFLINE_DAYS` 一致（漂移守卫测试）。
 */
export const DEFAULT_OFFLINE_DAYS = 10
export const DEFAULT_OFFLINE_MS = DEFAULT_OFFLINE_DAYS * 24 * 60 * 60 * 1000

/**
 * 时钟偏移容差：既用于拒绝「未来签发」的时间戳，也是离线预算的额外余量。
 *
 * 后者不可省：`maxOfflineMs = 0`（必须在线）时若不留容差，本机时钟比服务器快
 * 几秒就会在**刚联网成功之后**立刻判离线，把正常付费用户锁死。必须与
 * `activation.rs::CLOCK_SKEW_MS` 一致。
 */
export const DEFAULT_CLOCK_SKEW_MS = 10 * 60 * 1000

export const PRO_GRANT_TIERS = ['pro', 'max', 'lifetime'] as const

export interface ProGrantClaims {
  source?: string
  subject?: string
  accountSessionId?: string
  membershipRevision?: string
  product: string
  deviceId?: string
  tier?: string
  iat?: number
  exp: number
  lic?: number | null
  /**
   * 服务端下发的离线预算（ms，从 `iat` 起算）；0 = 必须在线。
   * 缺省 = 老 token → 回退到 `max(exp, iat + DEFAULT_OFFLINE_MS)`。
   */
  maxOfflineMs?: number
  /** 前向兼容扩展位，当前忽略。 */
  features?: string[]
  bundleHash?: string
  ver?: number
}

export type ProGrantReason =
  | 'membership_owner_required'
  | 'source_mismatch'
  | 'account_mismatch'
  | 'ok'
  | 'grace'
  | 'missing'
  | 'malformed'
  | 'bad_signature'
  | 'bad_payload'
  | 'product_mismatch'
  | 'tier_not_allowed'
  | 'device_mismatch'
  | 'not_yet_valid'
  /** 老 token（无离线预算字段）超出 `max(exp, iat+10天)`。 */
  | 'expired'
  /** 服务端下发的离线预算用尽（`maxOfflineMs` 生效时的锁因）。 */
  | 'offline_budget_exhausted'
  | 'license_expired'

export interface ProGrantResult {
  ok: boolean
  reason: ProGrantReason
  claims?: ProGrantClaims
  /** 放行截止时刻（unix ms）；仅 reason==='grace' 时有值（= 离线预算用尽时刻）。 */
  graceUntil?: number
}

export interface VerifyProGrantOptions {
  /** 覆盖公钥（测试用；生产走编译进来的默认常量）。 */
  publicKeyB64?: string
  /** 注入时钟（测试用）。 */
  now?: number
  /** shell 注入的设备指纹；提供时与 payload.deviceId 强比对。 */
  deviceId?: string
  clockSkewMs?: number
}

function publicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new Error(`bad_public_key_len:${raw.length}`)
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  })
}

/** 只验签+解析，不做时间/产品判断（`verifyProGrant` 的组合件）。 */
export function verifyGrantSignature(
  token: string,
  publicKeyB64: string = LICENSE_PUBLIC_KEY_B64
): { ok: true; claims: ProGrantClaims } | { ok: false; reason: ProGrantReason } {
  if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: 'missing' }
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'malformed' }
  // base64url 字符集不含 '.'，所以第二段里再出现 '.' 一定是坏 token。
  if (token.indexOf('.', dot + 1) !== -1) return { ok: false, reason: 'malformed' }

  const payloadB64 = token.slice(0, dot)
  const sigB64 = token.slice(dot + 1)

  let sig: Buffer
  try {
    sig = Buffer.from(sigB64, 'base64url')
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (sig.length !== 64) return { ok: false, reason: 'bad_signature' }

  let key: KeyObject
  try {
    key = publicKeyFromRaw(Buffer.from(publicKeyB64, 'base64'))
  } catch {
    return { ok: false, reason: 'bad_signature' }
  }

  let verified = false
  try {
    verified = cryptoVerify(null, Buffer.from(payloadB64, 'ascii'), key, sig)
  } catch {
    verified = false
  }
  if (!verified) return { ok: false, reason: 'bad_signature' }

  let claims: ProGrantClaims
  try {
    const json = Buffer.from(payloadB64, 'base64url').toString('utf8')
    const parsed = JSON.parse(json) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'bad_payload' }
    }
    claims = parsed as ProGrantClaims
  } catch {
    return { ok: false, reason: 'bad_payload' }
  }
  return { ok: true, claims }
}

/**
 * 全量校验：验签 → 产品 → 设备（可选）→ 时间窗（硬过期 / 有效期 / 宽限）。
 * 任何一步失败都 fail closed（`ok:false`）。
 */
export function verifyProGrant(
  token: string | undefined,
  opts: VerifyProGrantOptions = {}
): ProGrantResult {
  if (!token) return { ok: false, reason: 'missing' }

  const sig = verifyGrantSignature(token, opts.publicKeyB64)
  if (!sig.ok) return sig
  const claims = sig.claims

  if (claims.source === 'official-membership') {
    const checked = validateOfficialMembershipClaims(claims, opts)
    return checked.ok ? { ok: false, reason: 'membership_owner_required' } : checked
  }
  if (claims.source !== undefined || claims.subject !== undefined || claims.accountSessionId !== undefined || claims.membershipRevision !== undefined) return { ok: false, reason: 'source_mismatch' }

  if (claims.product !== LICENSE_PRODUCT) return { ok: false, reason: 'product_mismatch' }
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
    return { ok: false, reason: 'bad_payload' }
  }
  if (claims.iat !== undefined && (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat))) {
    return { ok: false, reason: 'bad_payload' }
  }
  const legacy = claims.tier == null && (claims.iat ?? 0) === 0 && claims.maxOfflineMs == null
  if (!(PRO_GRANT_TIERS as readonly unknown[]).includes(claims.tier) && !legacy) {
    return { ok: false, reason: 'tier_not_allowed' }
  }

  const now = opts.now ?? Date.now()
  const skew = opts.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS
  // 注入的设备指纹与 payload 不一致 → 拒绝（纵深防御，主判定在 Rust）。
  if (opts.deviceId !== undefined && claims.deviceId !== undefined && opts.deviceId !== claims.deviceId) {
    return { ok: false, reason: 'device_mismatch' }
  }
  // iat 在未来超过允许偏移 → 时钟被回拨或 token 是伪造的时间戳。
  const iat = claims.iat ?? 0
  if (iat > now + skew) return { ok: false, reason: 'not_yet_valid' }

  if (claims.lic !== undefined && claims.lic !== null) {
    if (typeof claims.lic !== 'number' || !Number.isFinite(claims.lic)) {
      return { ok: false, reason: 'bad_payload' }
    }
    if (now > claims.lic) return { ok: false, reason: 'license_expired' }
  }

  // 离线预算：服务端下发优先（严格按它算，0 = 必须在线），缺省才走老 token 兜底。
  // 非法值（负数/NaN/字符串）按「没有预算」处理——字段本身在签名保护下，脏值只可能
  // 来自服务端 bug，此时沿用老行为比把人锁死更安全。
  const budget =
    typeof claims.maxOfflineMs === 'number' && Number.isFinite(claims.maxOfflineMs) && claims.maxOfflineMs >= 0
      ? claims.maxOfflineMs
      : null
  const deadline =
    budget === null ? Math.max(claims.exp, iat + DEFAULT_OFFLINE_MS) : iat + budget + skew

  if (now > deadline) {
    return { ok: false, reason: budget === null ? 'expired' : 'offline_budget_exhausted' }
  }

  // 没超预算：token 本身过期了就是「宽限」态（离线预算比 TTL 宽时才会出现）。
  const grace = now > claims.exp
  return grace
    ? { ok: true, reason: 'grace', claims, graceUntil: deadline }
    : { ok: true, reason: 'ok', claims }
}

export function validateOfficialMembershipClaims(claims: ProGrantClaims, opts: VerifyProGrantOptions = {}, owner?: { subject: string; accountSessionId: string; deviceId: string }): ProGrantResult {
  if (claims.source !== 'official-membership') return { ok: false, reason: 'source_mismatch' }
  if (claims.product !== LICENSE_PRODUCT) return { ok: false, reason: 'product_mismatch' }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (claims.tier !== 'pro' || claims.maxOfflineMs !== 0 || typeof claims.subject !== 'string' || !uuid.test(claims.subject)
    || typeof claims.accountSessionId !== 'string' || !uuid.test(claims.accountSessionId)
    || typeof claims.deviceId !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(claims.deviceId)
    || typeof claims.membershipRevision !== 'string' || !/^\d{1,256}$/.test(claims.membershipRevision)
    || ![claims.iat, claims.exp, claims.lic].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
    || claims.exp <= claims.iat! || claims.exp - claims.iat! > 60000 || claims.exp > claims.lic!) return { ok: false, reason: 'bad_payload' }
  if ((opts.deviceId !== undefined && claims.deviceId !== opts.deviceId) || (owner && claims.deviceId !== owner.deviceId)) return { ok: false, reason: 'device_mismatch' }
  if (owner && (claims.subject !== owner.subject || claims.accountSessionId !== owner.accountSessionId)) return { ok: false, reason: 'account_mismatch' }
  const now = opts.now ?? Date.now()
  if (now < claims.iat!) return { ok: false, reason: 'not_yet_valid' }
  if (now >= claims.lic!) return { ok: false, reason: 'license_expired' }
  if (now >= claims.exp) return { ok: false, reason: 'expired' }
  return { ok: true, reason: 'ok', claims }
}

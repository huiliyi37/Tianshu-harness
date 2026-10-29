import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Config } from './schema.js'
import { verifyProGrant, type ProGrantReason } from './pro-grant.js'
import { LICENSE_PRODUCT } from './license-keys.js'
import { rivetHome } from './paths.js'
import { readOfficialMembership } from '../auth/official-membership-license.js'

export type ProFeature = 'computerUse' | 'chatGateway' | 'teamMax' | 'councilMultiRound' | 'unattendedAutomation' | 'spark'

export type ProLicenseSource = 'grant' | 'official-membership' | 'config' | 'env' | 'license-file' | 'none'

export interface ProLicenseInfo {
  enabled: boolean
  source: ProLicenseSource
  licenseKey?: string
  /** 许可证层级（grant 路径才有；Basic 为 undefined）。 */
  tier?: string
  /**
   * 判定说明（诊断/遥测用，`enabled` 的补充而非替代）：
   * - `grant_ok` / `grant_grace` —— 桌面端验签通过
   * - `no_grant`                —— 桌面端缺凭证（未激活，或绕过尝试）
   * - `grant_<reason>`          —— 凭证被拒的具体原因
   * - `cli_soft_gate`           —— CLI/开源版三路径放行
   * - `basic`                   —— 全路径未命中
   */
  reason?: string
}

/**
 * 许可证落盘路径 —— 与桌面端 `activation.rs::license_path(rivet_home)` **同一份**
 * （`<rivet_home>/license.json`，结构 `{ token, lastVerifiedAt }`）。
 *
 * 两个入口共用它：桌面端由 shell 读写（激活/心跳），CLI 侧只读。付费用户在桌面端
 * 激活一次，CLI 即复用同一凭证，无需二次激活。若桌面端配置了自定义存储位置，
 * CLI 需把 `RIVET_HOME` 指向同一目录。
 */
function defaultLicensePath(): string {
  return join(rivetHome(), 'license.json')
}

/**
 * Pro 判定：**两个入口共用同一套签名凭证**，区别只在凭证从哪来。
 *
 * - 桌面端（`RIVET_DESKTOP=1`）：shell 注入 `RIVET_PRO_GRANT`，不信任何文件
 * - CLI（无该变量）：读 `<rivet_home>/license.json` —— 与桌面端**同一份**，
 *   付费用户在桌面端激活一次即可在 CLI 复用，无需二次激活
 *
 * 两边的共同不变量：**凭证必须通过 Ed25519 验签**。裸 `RIVET_PRO=1`、
 * `config.pro.enabled`、任意内容的许可证文件都不是凭据（v3.21.1 的三条软 gate
 * 路径已全部关闭，见 docs/security/pro-hardening.md）。
 */
/**
 * 测试专用的验签公钥覆盖点。
 *
 * 生产路径**只认**编译进包的 `LICENSE_PUBLIC_KEY_B64`：不接受环境变量、配置项、
 * 文件或命令行开关（那些都会变成新的绕过面）。但测试需要一个能签发有效凭证的
 * 私钥，因此留这个进程内函数缝隙——它无法从外部进程触发，也不读任何外部输入。
 * 攻击者 patch JS 能调到它，但 patch JS 本来就是「改客户端」这条路的起点，
 * 本缝隙不改变威胁模型（那条路要靠 Rust 侧完整性校验 + 原生签名兜）。
 */
let testPublicKeyOverride: string | null = null
const invalidatedDesktopGrants = new Map<string, string>()
let runtimeProDenied = false
const managedProDenials = new Set<() => Promise<void>>()

export function runtimeProAuthorizationDenied(): boolean { return runtimeProDenied }

export function registerManagedProDenial(deny: () => Promise<void>): () => void {
  managedProDenials.add(deny)
  return () => { managedProDenials.delete(deny) }
}

export async function denyRuntimeProAuthorization(): Promise<void> {
  runtimeProDenied = true
  const completed = new Set<() => Promise<void>>()
  for (;;) {
    const pending = [...managedProDenials].filter(deny => !completed.has(deny))
    if (!pending.length) return
    await Promise.all(pending.map(deny => deny()))
    for (const deny of pending) completed.add(deny)
  }
}

/** 仅测试用：注入验签公钥；传 null 恢复生产公钥。 */
export function __setProGrantPublicKeyForTests(publicKeyB64: string | null): void {
  testPublicKeyOverride = publicKeyB64
}

/**
 * 验签一份 grant 并映射为判定结果（桌面端与 CLI 共用）。任何失败 fail closed，
 * 拒绝原因落进 `reason`（`grant_<pro-grant 的 reason>`）供诊断。
 */
function resolveGrant(token: string | undefined, deviceId?: string): ProLicenseInfo {
  const res = verifyProGrant(token, {
    deviceId,
    ...(testPublicKeyOverride ? { publicKeyB64: testPublicKeyOverride } : {}),
  })
  if (!res.ok) {
    warnOnce(`pro-grant-rejected:${res.reason}`, `[pro-license] Pro 凭证被拒（${res.reason}）→ Basic`)
    return { enabled: false, source: 'none', reason: `grant_${res.reason}` }
  }
  return {
    enabled: true,
    source: 'grant',
    tier: res.claims?.tier,
    reason: res.reason === 'grace' ? 'grant_grace' : 'grant_ok',
  }
}

/** `<license.json 同目录>/.device-id`（与 `activation.rs::device_id_path` 同构）。读不到返回 undefined → 不比对。 */
function readDeviceIdFor(licensePath: string): string | undefined {
  try {
    const raw = readFileSync(join(dirname(licensePath), '.device-id'), 'utf8').trim()
    return raw.length > 0 ? raw : undefined
  } catch {
    return undefined
  }
}

/** 读 `<rivet_home>/license.json` 里的 token（桌面端 `StoredLicense` 结构）；任何异常返回 undefined（fail closed）。 */
function readStoredToken(licensePath: string, onMissing?: () => void): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(licensePath, 'utf8')) as { token?: unknown }
    return typeof parsed.token === 'string' && parsed.token.length > 0 ? parsed.token : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') onMissing?.()
    return undefined
  }
}

function resolveDesktopGrant(config: Config, licensePath: string): ProLicenseInfo {
  const grant = process.env.RIVET_PRO_GRANT
  if (!grant) {
    // 正常未付费用户每次启动都会走到这里 —— 不能无脑打告警，否则日志被刷屏、
    // 真信号被淹没。只在**存在明确绕过信号**时才留痕（这是本地唯一的检测手段）：
    //   1. 有人在桌面端进程里塞了裸 RIVET_PRO=1 / 改了 config.pro.enabled
    //   2. 存在许可证文件（CLI/桌面端都不再把它当凭据）
    if (process.env.RIVET_PRO === '1' || config.pro?.enabled) {
      warnOnce(
        'pro-grant-missing:attempt',
        '[pro-license] 检测到绕过信号（裸 RIVET_PRO / config.pro.enabled），但只认签名凭证 → Basic'
      )
    } else if (existsSync(licensePath)) {
      warnOnce(
        'pro-grant-missing:legacy-file',
        `[pro-license] 检测到 ${licensePath}，但缺可验签的凭证 → Basic。如需 Pro 请在「设置 → 关于与授权」激活。`
      )
    }
    return { enabled: false, source: 'none', reason: 'no_grant' }
  }
  const native = resolveGrant(grant, process.env.RIVET_PRO_DEVICE_ID)
  if (!native.enabled) return native
  const invalidated = invalidatedDesktopGrants.get(grant)
  if (invalidated) return { enabled: false, source: 'none', reason: invalidated }
  let missing = false
  const current = readStoredToken(licensePath, () => { missing = true })
  const stored = current ? resolveGrant(current, process.env.RIVET_PRO_DEVICE_ID) : undefined
  if (!stored?.enabled) {
    const reason = stored?.reason ?? (missing ? 'grant_removed' : 'grant_unavailable')
    if (current || missing) invalidatedDesktopGrants.set(grant, reason)
    return { enabled: false, source: 'none', reason }
  }
  return native
}

/**
 * CLI 入口：读与桌面端**同一份** `license.json` 并验签。
 *
 * 这里刻意不再有任何「软 gate」：v3.21.1 的 `config.pro.enabled` / 裸
 * `RIVET_PRO=1` / 任意内容的许可证文件三条路径全部关闭——否则「没开 Pro 的人
 * 也能在 CLI 直接用 Pro」，而那正是付费用户买的东西。付费用户在桌面端激活过，
 * 这份文件就已存在，零操作可用。
 */
function resolveCliGrant(config: Config, licensePath: string): ProLicenseInfo {
  const token = readStoredToken(licensePath)
  if (!token) {
    // 与桌面端同款：只在存在明确绕过信号时留痕（旧软 gate 的三个入口）。
    if (process.env.RIVET_PRO === '1' || config.pro?.enabled) {
      warnOnce(
        'cli-soft-gate-ignored',
        '[pro-license] 检测到裸 RIVET_PRO / config.pro.enabled —— 两者都已不再是凭据 → Basic'
      )
    }
    return { enabled: false, source: 'none', reason: 'no_grant' }
  }
  return resolveGrant(token, readDeviceIdFor(licensePath))
}

/**
 * Resolve whether the current installation is running as Pro.
 *
 * 两个入口，**同一套凭证、同一套验签**：
 *
 * **桌面端（`RIVET_DESKTOP=1`）**：只认 shell 注入的 `RIVET_PRO_GRANT`——
 * 服务端 Ed25519 签名、设备绑定、带有效期的许可证 token；shell 在 `is_pro()` 与
 * 运行时完整性校验都通过后才注入（见 `desktop/src-tauri/src/lib.rs`）。
 *
 * **CLI（无该变量）**：读 `<rivet_home>/license.json` —— 与桌面端同一份文件，
 * 付费用户激活一次即可跨端使用。**同样要验签**：裸 env / config 标志 / 任意文件
 * 内容都不再是凭据（v3.21.1 的三条软 gate 已关闭，否则未付费用户能直接在 CLI
 * 用上 Pro 权益）。
 *
 */
export function resolveProLicense(
  config: Config,
  licensePath = defaultLicensePath()
): ProLicenseInfo {
  if (runtimeProDenied) return { enabled: false, source: 'none', reason: 'grant_native_denied' }
  const legacy = process.env.RIVET_DESKTOP === '1'
    ? resolveDesktopGrant(config, licensePath)
    : resolveCliGrant(config, licensePath)
  if (legacy.enabled) return legacy
  const membership = readOfficialMembership(dirname(licensePath), testPublicKeyOverride ?? undefined)
  return membership ? { enabled: true, source: 'official-membership', tier: 'pro', reason: 'membership_ok' } : legacy
}

export function isProEnabled(config: Config): boolean {
  return resolveProLicense(config).enabled
}

/**
 * Check whether a specific Pro feature is enabled.
 *
 * A feature is enabled when:
 * - Pro is active, AND
 * - config.pro.features.<feature> is not explicitly set to false.
 *
 * Default for any feature under an active Pro license is true.
 */
export function isProFeatureEnabled(config: Config, feature: ProFeature): boolean {
  if (!isProEnabled(config)) return false
  return config.pro?.features?.[feature] !== false
}

export class ProAuthorizationError extends Error {
  readonly code = 'PRO_AUTHORIZATION_REQUIRED'
  constructor(readonly feature: ProFeature, readonly reason: string) {
    super(`Pro authorization required for ${feature}: ${reason}; operation not executed`)
    this.name = 'ProAuthorizationError'
  }
}

export function assertProFeatureEnabled(config: Config, feature: ProFeature): void {
  const license = resolveProLicense(config)
  if (!license.enabled) throw new ProAuthorizationError(feature, license.reason ?? 'not_licensed')
  if (config.pro?.features?.[feature] === false) throw new ProAuthorizationError(feature, 'feature_disabled')
}

/** 诊断信息：把判定结果摊平成可上报/可打日志的一行（不含凭证本体）。 */
export function describeProLicense(config: Config): {
  enabled: boolean
  source: ProLicenseSource
  reason: string
  product: string
} {
  const info = resolveProLicense(config)
  return {
    enabled: info.enabled,
    source: info.source,
    reason: info.reason ?? 'unknown',
    product: LICENSE_PRODUCT,
  }
}

/**
 * 同一进程内同一条告警只打一次（`isProFeatureEnabled` 在启动路径被调用多次，
 * 否则日志会被刷屏）。按 key 去重，不同拒绝原因各自保留一条——这既是日志
 * 卫生，也是**本地可观测的绕过信号**：Basic 用户日志里出现 `no_grant` 而
 * 环境是桌面端，说明有人在手工直启 sidecar。
 */
const warned = new Set<string>()
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return
  warned.add(key)
  try {
    console.warn(message)
  } catch {
    /* stdout 不可写时忽略（守护进程 / 无 TTY） */
  }
}

/** 测试用：清空告警去重表，让同一场景可重复断言日志。 */
export function __resetProWarningState(): void {
  warned.clear()
}

export type { ProGrantReason }

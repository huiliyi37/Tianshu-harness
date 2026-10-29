/**
 * 凭据落盘加密（账号 token / provider OAuth token / MCP OAuth token）。
 *
 * ## 解决的问题
 *
 * v3.21.1 里 `~/.rivet/<provider>.json` 是**明文 JSON**：`{accessToken,
 * refreshToken, expiresAt}`。`writeFileSync(..., { mode: 0o600 })` 在 Windows
 * 上不生效（NTFS ACL 不看 POSIX mode），而 `~/.rivet` 又常在用户目录里、可能
 * 被 OneDrive/iCloud/网盘同步、被备份工具收走、被同机其它进程读走。refresh
 * token 是长期凭据——一旦泄露，攻击者不需要动目标机器就能拿到该账号的一切。
 *
 * ## 方案：数据密钥放 OS 密钥库，文件里只放 AES-256-GCM 密文
 *
 * ```
 * <provider>.json  = {"v":1,"s":"aes-256-gcm","b":"<backend>","d":"<base64: iv|tag|ct>"}
 * ```
 *
 * 数据密钥（32 字节随机）按平台托管，**不落明文**：
 * - `keychain`（macOS）：`security add-generic-password` 放进用户钥匙串
 * - `dpapi`（Windows）：`CryptProtectData(CurrentUser)` 加密后落 `.token-key.dpapi`
 * - `local-key`（兜底）：`.token-key`（0600）——**只是混淆，不是安全边界**：
 *   同机同用户进程能读到密钥。Linux 无内置密钥库 API，先落这一档
 * - `plaintext`：显式关闭（`RIVET_TOKEN_STORE=plaintext`），仅供排障
 *
 * ## 边界与诚实的说明
 *
 * 这一层防的是「**拿走文件**」（跨机复制、云同步、备份、换用户账户读别人
 * home），不防「同机同用户的活体进程」——那种攻击者能直接读进程内存，任何
 * 客户端加密都挡不住。真正的兜底在服务端：refresh token 轮换 + 复用检测 +
 * 吊销（见 docs/security/pro-hardening.md 的向量⑥）。
 *
 * 兼容性：旧明文文件按原样读取，**下次写入自动升级**为密文信封；无需迁移脚本。
 */
import { execFileSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'

export type SecretBackend = 'keychain' | 'dpapi' | 'local-key' | 'plaintext'

/** 信封版本 / 算法标识（写进文件，便于未来轮换）。 */
const ENVELOPE_VERSION = 1
const ENVELOPE_ALG = 'aes-256-gcm'

const KEYCHAIN_SERVICE = 'rivet-token-store'
const DPAPI_KEY_FILE = '.token-key.dpapi'
const LOCAL_KEY_FILE = '.token-key'

export interface SecretCipher {
  readonly backend: SecretBackend
  encrypt(plain: Buffer): Buffer
  /** 解密失败返回 null（密文被篡改 / 换了机器 / 密钥丢失），调用方按「无凭据」处理。 */
  decrypt(blob: Buffer): Buffer | null
  decryptForBackend?(blob: Buffer, backend: SecretBackend): Buffer | null
}

const warned = new Set<string>()
function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return
  warned.add(key)
  try {
    console.warn(msg)
  } catch {
    /* 无 TTY / stdout 关闭时忽略 */
  }
}

/** 解析后端：显式 `RIVET_TOKEN_STORE` 优先，其次按平台默认。 */
export function resolveSecretBackend(platform: NodeJS.Platform = process.platform): SecretBackend {
  const override = process.env.RIVET_TOKEN_STORE?.trim().toLowerCase()
  if (override === 'plaintext' || override === 'keychain' || override === 'dpapi' || override === 'local-key') {
    return override
  }
  if (platform === 'darwin') return 'keychain'
  if (platform === 'win32') return 'dpapi'
  return 'local-key'
}

function aesGcmCipher(key: Buffer, backend: SecretBackend): SecretCipher {
  if (key.length !== 32) throw new Error(`secret key must be 32 bytes, got ${key.length}`)
  return {
    backend,
    encrypt(plain: Buffer): Buffer {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const ct = Buffer.concat([cipher.update(plain), cipher.final()])
      const tag = cipher.getAuthTag()
      // 布局：iv(12) | tag(16) | ciphertext
      return Buffer.concat([iv, tag, ct])
    },
    decrypt(blob: Buffer): Buffer | null {
      try {
        if (blob.length < 12 + 16) return null
        const iv = blob.subarray(0, 12)
        const tag = blob.subarray(12, 28)
        const ct = blob.subarray(28)
        const decipher = createDecipheriv('aes-256-gcm', key, iv)
        decipher.setAuthTag(tag)
        return Buffer.concat([decipher.update(ct), decipher.final()])
      } catch {
        return null
      }
    },
  }
}

function plaintextCipher(): SecretCipher {
  return {
    backend: 'plaintext',
    encrypt: (plain) => plain,
    decrypt: (blob) => blob,
  }
}

// ── 平台密钥库 ────────────────────────────────────────────────────────

function keychainKey(create: boolean): Buffer | null {
  const accountHome = userInfo().homedir
  const keychainEnv = { ...process.env, HOME: accountHome, CFFIXED_USER_HOME: accountHome }
  const account = process.env.USER || process.env.USERNAME || userInfo().username || 'rivet'
  const args = ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w']
  try {
    const out = execFileSync('security', args, { encoding: 'utf8', timeout: 10_000, windowsHide: true, env: keychainEnv }).trim()
    const key = Buffer.from(out, 'hex')
    if (key.length === 32) return key
  } catch {
    /* 未找到 → 下面创建 */
  }
  if (!create) return null
  let defaultPath: string
  try {
    const value = execFileSync('security', ['default-keychain', '-d', 'user'], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true, env: keychainEnv,
    }).trim()
    defaultPath = value.startsWith('"') ? JSON.parse(value) : value
    if (!defaultPath || !statSync(defaultPath).isFile()) throw new Error('default keychain missing')
  } catch {
    throw new Error('Default keychain unavailable; credential creation blocked')
  }
  const fresh = randomBytes(32)
  try {
    execFileSync(
      'security',
      ['add-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w', fresh.toString('hex')],
      { encoding: 'utf8', timeout: 10_000, windowsHide: true, env: keychainEnv }
    )
    return fresh
  } catch {
    // Another process may have created the item. Never replace an existing key.
    try {
      const key = Buffer.from(execFileSync('security', args, { encoding: 'utf8', timeout: 10_000, windowsHide: true, env: keychainEnv }).trim(), 'hex')
      if (key.length === 32) return key
    } catch {}
    warnOnce(
      'keychain-unavailable',
      '[secure-store] 钥匙串不可用，保留已有密钥；新凭据回退到本机密钥文件（仅混淆，不是安全边界）'
    )
    return null
  }
}

function dpapiCall(data: Buffer, mode: 'Protect' | 'Unprotect'): Buffer {
  const scope = 'CurrentUser'
  const arg = `[Convert]::FromBase64String('${data.toString('base64')}')`
  const script = [
    'Add-Type -AssemblyName System.Security | Out-Null;',
    `$b=${arg};`,
    `$r=[System.Security.Cryptography.ProtectedData]::${mode}($b,$null,'${scope}');`,
    '[Convert]::ToBase64String($r)',
  ].join(' ')
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  })
  return Buffer.from(out.trim(), 'base64')
}

function dpapiKey(dir: string, create: boolean): Buffer | null {
  const path = join(dir, DPAPI_KEY_FILE)
  try {
    if (existsSync(path)) {
      const key = dpapiCall(Buffer.from(readFileSync(path, 'utf8').trim(), 'base64'), 'Unprotect')
      if (key.length === 32) return key
      return null
    }
    if (!create) return null
    const fresh = randomBytes(32)
    const sealed = dpapiCall(fresh, 'Protect')
    mkdirSync(dir, { recursive: true })
    try {
      writeFileSync(path, sealed.toString('base64'), { mode: 0o600, flag: 'wx' })
    } catch (error) {
      // 并发首建的败者：胜者已创建密钥文件。重读胜者的密钥，而不是把 EEXIST
      // 误判为「DPAPI 不可用」降级到 local-key（明文密钥）——与 localKey 的
      // EEXIST 分支（见下）及 keychainKey 的 add 失败重读对称。
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return dpapiKey(dir, false)
      throw error
    }
    return fresh
  } catch {
    warnOnce(
      'dpapi-unavailable',
      '[secure-store] DPAPI 不可用，保留已有密钥；新凭据回退到本机密钥文件（仅混淆，不是安全边界）'
    )
    return null
  }
}

function localKey(dir: string, create: boolean): Buffer | null {
  const path = join(dir, LOCAL_KEY_FILE)
  try {
    const raw = readFileSync(path, 'utf8').trim()
    // 老格式兜底：也接受 base64
    const key = Buffer.from(raw, 'hex')
    if (key.length === 32) return key
    const b64 = Buffer.from(raw, 'base64')
    if (b64.length === 32) return b64
    if (create) throw new Error('Existing credential key is invalid; refusing to overwrite it')
    return null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (create) throw new Error('Existing credential key is unreadable; refusing to overwrite it')
      return null
    }
  }
  if (!create) return null
  const fresh = randomBytes(32)
  mkdirSync(dir, { recursive: true })
  try {
    writeFileSync(path, fresh.toString('hex'), { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return localKey(dir, false)
    throw error
  }
  try {
    chmodSync(path, 0o600)
  } catch {
    /* Windows 上无意义，忽略 */
  }
  return fresh
}

// ── 对外 API ──────────────────────────────────────────────────────────

const cipherCache = new Map<string, SecretCipher>()

/**
 * 取（必要时创建）指定目录下的数据密钥并返回可用 cipher。
 * 同一进程内按目录缓存：避免每次读写 token 都 spawn 一次 security/powershell。
 * 新凭据写入可降级；解密只读取既有密钥，不创建或替换。后端随信封解析，
 * 既有密钥不可读时保留文件，等待密钥库恢复，不把暂时不可用变成永久丢失。
 */
export function createSecretCipher(baseDir: string, backend: SecretBackend = resolveSecretBackend()): SecretCipher {
  const cacheKey = `${backend}\u0000${baseDir}`
  const cached = cipherCache.get(cacheKey)
  if (cached) return cached

  let cipher: SecretCipher
  if (backend === 'plaintext') {
    warnOnce(
      'plaintext-backend',
      '[secure-store] RIVET_TOKEN_STORE=plaintext：凭据以明文落盘（仅排障用，安全等级最低）'
    )
    cipher = plaintextCipher()
  } else {
    // ⚠️ 密钥**懒加载**：构造 TokenStore / cipher 本身不碰磁盘、不 spawn
    // security/powershell。原因：TokenStore 在启动路径上会被多次构造，其中
    // 有些目录（如只读的安装目录、别人的 home）连读都不该碰；早期版本在构造
    // 时就写密钥文件，直接让「只是查询凭据是否存在」的调用产生了副作用。
    let inner: SecretCipher | null = null
    let retryReadAfter = 0
    const ensure = (create: boolean): SecretCipher | null => {
      if (inner && (create || inner.backend === backend)) return inner
      if (!create && Date.now() < retryReadAfter) return null
      let key: Buffer | null = null
      // 实际生效的后端：密钥库失败降级到本机密钥文件时必须如实反映，否则信封
      // 里的 `b` 字段会撒谎，排障时会误判安全等级。
      let actual: SecretBackend = backend
      if (backend === 'keychain') key = keychainKey(create)
      else if (backend === 'dpapi') key = dpapiKey(baseDir, create)
      if (!key) {
        if (!create && backend !== 'local-key') {
          // One locked vault must not spawn once for every configured model.
          retryReadAfter = Date.now() + 5000
          return null
        }
        actual = 'local-key'
        key = localKey(baseDir, create)
      }
      if (!key) return null
      inner = aesGcmCipher(key, actual)
      return inner
    }
    cipher = {
      get backend(): SecretBackend {
        return inner ? inner.backend : backend
      },
      encrypt: (plain) => {
        const resolved = ensure(true)
        if (!resolved) throw new Error('Credential key is unavailable')
        return resolved.encrypt(plain)
      },
      decrypt: (blob) => ensure(false)?.decrypt(blob) ?? null,
    }
  }
  cipher.decryptForBackend = (blob, storedBackend) => createSecretCipher(baseDir, storedBackend).decrypt(blob)
  cipherCache.set(cacheKey, cipher)
  return cipher
}

/** 测试用：清空 cipher 缓存（改 env / 换目录后可重新解析后端）。 */
export function __resetSecretCipherCache(): void {
  cipherCache.clear()
}

/**
 * 把明文编码成落盘字符串：加密后端写信封，plaintext 后端原样写。
 */
export function encodeSecret(cipher: SecretCipher, plaintext: string): string {
  // 先加密再读 backend：懒加载 cipher 的 backend 在密钥解析前是「预期值」，
  // 加密之后才是实际生效值（如钥匙串失败 → local-key）。
  const blob = cipher.encrypt(Buffer.from(plaintext, 'utf8'))
  const backend = cipher.backend
  if (backend === 'plaintext') return blob.toString('utf8')
  return `${JSON.stringify({
    v: ENVELOPE_VERSION,
    s: ENVELOPE_ALG,
    b: backend,
    d: blob.toString('base64'),
  })}\n`
}

/**
 * 解码落盘内容：识别密文信封 → 解密；否则按旧明文处理（向后兼容，下次写入
 * 自动升级）。解密失败返回 null —— 调用方按「读不到凭据」处理（要求重新登录），
 * 而不是抛异常把整个鉴权链路打断。
 */
export function decodeSecret(cipher: SecretCipher, raw: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const env = parsed as { v?: unknown; s?: unknown; d?: unknown; b?: unknown }
  const isEnvelope =
    env && typeof env === 'object' && typeof env.d === 'string' && typeof env.v === 'number' && env.s === ENVELOPE_ALG
  if (!isEnvelope) {
    // 旧格式：明文 JSON 凭据。原样返回，下次 save 自动升级成密文。
    return raw
  }
  const blob = Buffer.from(env.d as string, 'base64')
  const storedBackend = env.b
  const knownBackend = storedBackend === 'keychain' || storedBackend === 'dpapi' || storedBackend === 'local-key'
  const decrypted = knownBackend && cipher.decryptForBackend
    ? cipher.decryptForBackend(blob, storedBackend)
    : cipher.decrypt(blob)
  if (!decrypted) {
    warnOnce(
      `decrypt-failed:${cipher.backend}`,
      '[secure-store] 凭据解密失败（密文被改 / 换了机器 / 密钥丢失）→ 视为未登录，请重新登录'
    )
    return null
  }
  return decrypted.toString('utf8')
}

/** 凭据目录里由本模块托管的辅助文件（测试/运维排查用）。 */
export const SECRET_SIDECAR_FILES = { localKey: LOCAL_KEY_FILE, dpapiKey: DPAPI_KEY_FILE } as const

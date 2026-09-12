/**
 * 统一 proxy 解析组件。
 *
 * 优先级（高 → 低）：config.network.proxy > HTTPS_PROXY/HTTP_PROXY 环境变量 > 直连。
 * NO_PROXY 匹配的域名始终直连，无论 proxy 来自 config 还是环境变量。
 *
 * 抽取自 `src/tui/updater.ts` 的 `proxyForUrl` + `shouldBypassProxy`，扩展支持
 * config 注入，供 http-fetch / updater / 未来统一网络层复用。
 */

export interface ProxyResolverOptions {
  /** config.network.proxy 显式配置（优先于环境变量）。 */
  proxyUrl?: string
  /** config.network.noProxy（逗号分隔，支持 * / . 前缀 / 精确匹配）。 */
  noProxy?: string
}

import { execSync } from 'node:child_process'

function envCaseInsensitive(key: string): string | undefined {
  return process.env[key] ?? process.env[key.toLowerCase()]
}

/** Read Windows system proxy from registry (HKCU Internet Settings).
 *  Returns undefined on non-Windows or when no proxy is configured.
 *  Normalized to a full URL (http://host:port) for ProxyAgent compatibility. */
function readWindowsSystemProxy(): string | undefined {
  if (process.platform !== 'win32') return undefined
  try {
    // 先查 ProxyEnable —— 代理已禁用（0x0 或不存在）直接返回 undefined。
    // 必须在 ProxyServer 之前：注册表里 ProxyServer 键即使代理禁用也常残留
    // （Windows 关代理时只翻 ProxyEnable，不清 ProxyServer），先读 ProxyServer
    // 会让禁用代理的用户被强制走残留的代理地址。
    const enable = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable 2>nul',
      { encoding: 'utf8', timeout: 3000, windowsHide: true },
    )
    if (!/0x1/.test(enable)) return undefined

    // 代理已启用 —— 读 ProxyServer 拿地址
    const stdout = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer 2>nul',
      { encoding: 'utf8', timeout: 3000, windowsHide: true },
    )
    return parseWindowsProxyOutput(enable, stdout)
  } catch {
    // reg query fails when the key doesn't exist — no proxy configured
  }
  return undefined
}

/**
 * Read macOS system proxy via `scutil --proxy`.
 * Returns undefined on non-macOS or when no HTTP/HTTPS proxy is enabled.
 * HTTPS 优先（与 normalizeProxyUrl 语义一致——出站多为 https）。
 *
 * scutil 输出形如（非 JSON，嵌套字典文本）：
 *   HTTPEnable : 1
 *   HTTPPort : 7890
 *   HTTPProxy : 127.0.0.1
 *   HTTPSEnable : 1
 *   HTTPSPort : 7890
 *   HTTPSProxy : 127.0.0.1
 *   ProxyAutoConfigEnable : 0   ← PAC，启用时我们不处理（需取 PAC URL 解析 JS）
 *   ExceptionsList : <array> { 0 : *.local ... }   ← 等价 NO_PROXY，这里不读（环境变量/config 已覆盖）
 */
function readMacosSystemProxy(): string | undefined {
  if (process.platform !== 'darwin') return undefined
  try {
    const stdout = execSync('scutil --proxy', {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    })
    return parseScutilProxy(stdout)
  } catch {
    // scutil 缺失或超时 —— 视为无系统代理，回退到环境变量/直连
  }
  return undefined
}

/**
 * 从 scutil --proxy 输出解析代理 URL。抽成纯函数便于单测（避免 mock child_process）。
 *
 * 优先级：HTTPS（启用且配置了 host+port）> HTTP。SOCKS 不处理（undici ProxyAgent
 * 仅支持 HTTP CONNECT 隧道，SOCKS 需另引 socks-proxy-agent，不在本层范围）。
 * PAC（ProxyAutoConfigEnable=1）不处理 —— 需取 PAC URL 并执行其中 JS，复杂度高，
 * 配 PAC 的用户应自行设 HTTPS_PROXY 环境变量。
 */
export function parseScutilProxy(stdout: string): string | undefined {
  const get = (key: string): string | undefined => {
    const m = stdout.match(new RegExp(`^\\s*${key}\\s*:\\s*(\\S+)`, 'm'))
    return m?.[1]
  }
  // HTTPS 优先
  const httpsHost = get('HTTPSProxy')
  const httpsPort = get('HTTPSPort')
  const httpsEnable = get('HTTPSEnable')
  if (httpsEnable === '1' && httpsHost && httpsPort) {
    return `http://${httpsHost}:${httpsPort}`
  }
  // 回退 HTTP
  const httpHost = get('HTTPProxy')
  const httpPort = get('HTTPPort')
  const httpEnable = get('HTTPEnable')
  if (httpEnable === '1' && httpHost && httpPort) {
    return `http://${httpHost}:${httpPort}`
  }
  return undefined
}

/**
 * 从 reg query 的 ProxyEnable / ProxyServer 两段输出解析代理 URL。
 * 抽成纯函数便于单测——避免 mock child_process（Node 24 内置模块属性
 * 不可配置，mock.method 会抛 Cannot redefine property）。
 *
 * ProxyEnable 输出形如 "    ProxyEnable    REG_DWORD    0x1"，
 * ProxyServer 输出形如 "    ProxyServer    REG_SZ    host:port"。
 */
export function parseWindowsProxyOutput(enableStdout: string, serverStdout: string): string | undefined {
  // 代理未启用（0x0 或非 0x1）—— 即使 ProxyServer 残留也不返回
  if (!/0x1/.test(enableStdout)) return undefined
  const match = serverStdout.match(/REG_SZ\s+(.+)/)
  if (match?.[1]) return normalizeProxyUrl(match[1].trim())
  return undefined
}

/** Ensure a proxy URL has a protocol prefix. Windows registry stores proxy as
 *  "host:port" (no scheme), but undici ProxyAgent requires "http://host:port".
 *  Also handles the "http=host;https=host" multi-protocol format——优先取 https，
 *  因为绝大多数出站流量（API 调用、更新检查）走 https，http 代理端口常不监听 TLS。 */
function normalizeProxyUrl(raw: string): string | undefined {
  // Format: "http=host:port;https=host:port" — 两轮扫描，优先 https
  if (raw.includes('=')) {
    const parts = raw.split(';')
    for (const want of ['https', 'http']) {
      for (const part of parts) {
        const m = part.match(/^(https?)=(.+)/i)
        if (m && m[1]!.toLowerCase() === want) return normalizeProxyUrl(m[2]!.trim())
      }
    }
    return undefined
  }
  // Bare "host:port" → add http:// prefix
  if (/^https?:\/\//i.test(raw)) return raw
  return `http://${raw}`
}

/**
 * hostname 是否命中 NO_PROXY 绕过列表。
 *
 * 匹配规则（与 curl/wget 语义对齐）：
 *  - `*` 绕过所有
 *  - 精确域名匹配（大小写不敏感）
 *  - `.example.com` 后缀匹配：`api.example.com` 和 `example.com` 都命中
 */
export function shouldBypassProxy(hostname: string, noProxy?: string): boolean {
  const raw = noProxy ?? envCaseInsensitive('NO_PROXY')
  if (!raw) return false
  const h = hostname.toLowerCase()
  for (const entry of raw.split(',')) {
    const p = entry.trim().toLowerCase()
    if (!p) continue
    if (p === '*') return true
    if (h === p) return true
    if (p.startsWith('.') && (h.endsWith(p) || h === p.slice(1))) return true
  }
  return false
}

/**
 * 解析某个 URL 应该走哪个代理。
 *
 * @returns proxy URL 字符串，或 `undefined`（直连）。
 *
 * 优先级：
 *   1. `opts.proxyUrl`（config.network.proxy）—— 设了就用，不再读环境变量
 *   2. 环境变量 HTTPS_PROXY / HTTP_PROXY（按 URL 协议选择，大小写不敏感）
 *   3. undefined（直连）
 *
 * NO_PROXY 命中时一律返回 undefined，无论 proxy 来源。
 */
export function resolveProxyForUrl(url: string, opts?: ProxyResolverOptions): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (shouldBypassProxy(parsed.hostname, opts?.noProxy)) return undefined

  // config 显式配置优先
  if (opts?.proxyUrl) return opts.proxyUrl

  // RIVET_NO_SYSTEM_PROXY=1：禁用 OS 级系统代理回退（Windows 注册表 / macOS
  // scutil）——CI/沙箱/测试需要确定性直连，或用户显式绕过系统代理时使用。
  const systemProxy = (): string | undefined =>
    process.env.RIVET_NO_SYSTEM_PROXY === '1' ? undefined : readWindowsSystemProxy() ?? readMacosSystemProxy()

  // 回退到环境变量
  if (parsed.protocol === 'https:') {
    return envCaseInsensitive('HTTPS_PROXY') ?? envCaseInsensitive('HTTP_PROXY') ?? systemProxy()
  }
  if (parsed.protocol === 'http:') {
    return envCaseInsensitive('HTTP_PROXY') ?? envCaseInsensitive('HTTPS_PROXY') ?? systemProxy()
  }
  // Non-HTTP protocols: try generic proxy env vars then OS fallbacks
  return systemProxy()
}

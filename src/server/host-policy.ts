/**
 * 监听地址 / Host 头的回环判定——单一真源。
 *
 * 抽取动机（2026-09 审查）：此前 `index.ts` 与 `remote-info-routes.ts` 各持一份
 * 判定，两份都把 `'::'` 归入回环。`'::'` 是 IPv6 通配地址（双栈下等效 0.0.0.0），
 * 与只监听本机的 `'::1'` 性质相反——index.ts 里紧邻的注释自己写着「LAN 模式：
 * 0.0.0.0 / LAN IP / ::」，代码与注释矛盾。判错的双重后果：① `--host ::` 下
 * `lanMode=false`，非回环 Host 全被 403，手机根本到不了 `/mobile`；②
 * `/remote/info` 误报 `mode:'loopback'`，桌面设置页 QR 门控短路不画码，还反向
 * 引导用户去「启用 LAN」。
 *
 * 收敛到本模块后两端共用同一实现，避免再次漂移。
 */

import { networkInterfaces } from 'node:os'
import { isIP } from 'node:net'

/** 去掉 IPv6 字面量的方括号包裹，并归一大小写/空白（`[::1]` → `::1`）。 */
function unbracket(addr: string): string {
  const a = addr.trim().toLowerCase()
  return a.startsWith('[') && a.endsWith(']') ? a.slice(1, -1) : a
}

/** IPv4 回环整段 `127.0.0.0/8`，以及 IPv4-mapped 的回环形态 `::ffff:127.x`。 */
function isLoopbackAddress(addr: string): boolean {
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr)
    || /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr)
}

/**
 * 绑定地址是否为回环形态（决定 startServer 是否进入 LAN 模式）。
 *
 * 通配绑定（`0.0.0.0` / `::`）不是回环——它们监听全部接口。`::` 尤其不能漏：
 * 双栈系统上只写 `::` 就等于同时绑 IPv4 与 IPv6 的全部接口。
 */
export function isLoopbackBind(addr: string): boolean {
  const a = unbracket(addr)
  return a === 'localhost' || a === '::1' || (isIP(a) !== 0 && isLoopbackAddress(a))
}

/** Default to this machine's literal addresses; unknown hosts remain denied. */
export function defaultLanHosts(bindHost: string, opts?: DefaultLanHostsOptions): string[] {
  const hosts = new Set<string>()
  if (!['0.0.0.0', '::'].includes(bindHost)) hosts.add(bindHost.toLowerCase())
  for (const addresses of Object.values(networkInterfaces())) for (const address of addresses ?? []) {
    hosts.add(address.family === 'IPv6' ? `[${address.address.toLowerCase()}]` : address.address)
  }
  const list = [...hosts]
  return opts?.lanDirect === true ? filterLanDirectHosts(list) : list
}

/** `defaultLanHosts` 选项——普通模式（不传/`lanDirect` 非 true）行为与历史完全一致。 */
export interface DefaultLanHostsOptions {
  /** LAN Direct 模式：剔除公网地址，allowlist 只留私网/link-local/回环/本机名。 */
  lanDirect?: boolean
}

/** IPv4：回环 127/8、RFC1918（10/8、172.16/12、192.168/16）、link-local 169.254/16。 */
function isPrivateOrLocalIpv4(addr: string): boolean {
  const parts = addr.split('.')
  if (parts.length !== 4) return false
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN))
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = octets as [number, number, number, number]
  return a === 10 || a === 127
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
}

/** IPv6：回环、IPv4-mapped（按映射后的 IPv4 判）、link-local `fe80::/10`、ULA `fc00::/7`。 */
function isPrivateOrLocalIpv6(addr: string): boolean {
  const a = addr.split('%')[0]! // 去 zone id（fe80::1%en0）
  if (a === '::1' || a === '::') return true
  const mapped = /^::ffff:(.+)$/.exec(a)
  if (mapped) return isPrivateOrLocalIpv4(mapped[1]!)
  if (/^fe[89ab]/.test(a)) return true // fe80::/10 link-local
  if (/^f[cd]/.test(a)) return true // fc00::/7 unique-local（IPv6 侧的 RFC1918 对应物）
  return false
}

/**
 * LAN Direct 模式下的 Host allowlist 收窄（设计 §5.3 Wave 1 第 3 条）：只保留
 * 局域网可达的条目——RFC1918 私网、link-local、回环，以及非 IP 字面量的主机名。
 *
 * 防线语义：即使机器处于公网 IP 直连场景（`--host <公网IP>` + opt-in），公网
 * Host 也被拒绝（双保险）；结果是 allowlist 可能为空，此时 `isHostAllowed`
 * 对任何非回环 Host 一律 403（fail-closed，不是「空 allowlist 放行」）。
 *
 * 有意不含 CGNAT（100.64/10）：它不是本地局域网可达集合。需要放行时用显式
 * `RIVET_SERVE_HOSTS_ALLOW` / `allowedHosts`——该路径优先于本过滤。
 */
export function filterLanDirectHosts(hosts: string[]): string[] {
  return hosts.filter((h) => {
    const addr = unbracket(h)
    const family = isIP(addr)
    if (family === 4) return isPrivateOrLocalIpv4(addr)
    if (family === 6) return isPrivateOrLocalIpv6(addr)
    return true // 非 IP 字面量 → 主机名，保留
  })
}

/** 拆 Host 头为 host / port 两部分（port 缺省为 undefined）。 */
function splitHostPort(h: string): { host: string; port?: number } {
  const raw = h.trim().toLowerCase()
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    if (end < 0) return { host: raw }
    const host = raw.slice(0, end + 1)
    const rest = raw.slice(end + 1)
    if (rest.startsWith(':')) {
      const port = Number(rest.slice(1))
      if (Number.isInteger(port)) return { host, port }
    }
    return { host }
  }
  const colon = raw.lastIndexOf(':')
  if (colon > 0) {
    const port = Number(raw.slice(colon + 1))
    if (Number.isInteger(port)) return { host: raw.slice(0, colon), port }
  }
  return { host: raw }
}

/**
 * Host 头是否为回环形态：host 属回环集合，且端口缺省（HTTP/1.0 风格）或与本
 * 服务端口一致。端口一致是防 DNS-rebinding 的关键——`127.0.0.1:其他端口` 不
 * 是本站。
 */
export function isLoopbackHostHeader(h: string, p: number): boolean {
  const { host, port } = splitHostPort(h)
  if (port !== undefined && port !== p) return false
  return isLoopbackBind(host)
}

/** 去 Host 端口（allowlist 精确比较用）：`[::1]:8080` → `[::1]`；`127.0.0.1:9` → `127.0.0.1`。 */
export function stripHostPort(h: string): string {
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    return end >= 0 ? h.slice(0, end + 1) : h
  }
  const colon = h.lastIndexOf(':')
  return colon > 0 ? h.slice(0, colon) : h
}

/**
 * 解析 RIVET_SERVE_HOSTS_ALLOW：逗号分隔、去空、拒绝含 / 或 : 的形态（无端口/无路径）。
 * 全条目非法时返回 undefined 并 console.warn——保留「忽略」语义但不再静默：否则 LAN
 * bind + 全非法 allowlist 会无声退化为「任意 Host 放行」（P1 fail-open 缺陷修复）。
 *
 * 2026-09 从 serve.ts 迁入：allowlist 是 host 判定的一部分，本文件是 host 策略的
 * 单一真源（见文件头），此前住在 serve.ts 是位置错误——serve.ts 已触及结构预算
 * ceiling，沿此接缝拆分。
 */
export function parseHostsAllow(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined
  const out: string[] = []
  for (const part of raw.split(',')) {
    const h = part.trim().toLowerCase()
    if (!h || h.includes('/') || h.includes(':')) continue
    out.push(h)
  }
  if (out.length === 0) {
    console.warn(
      `[serve] RIVET_SERVE_HOSTS_ALLOW="${raw}" had no valid host entries ` +
        '(each must be a bare hostname/IP without "/" or ":"); allowlist uses ' +
        'the default local-address list; unknown hosts remain denied.',
    )
  }
  return out.length > 0 ? out : undefined
}

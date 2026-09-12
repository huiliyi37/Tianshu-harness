import { BlockList, isIP } from 'node:net'

/** IPv4 ranges that must never be reachable through the network tools. */
const RESERVED_IPV4 = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const

/** IPv6 reserved ranges that are not an embedding of one of the IPv4 ranges. */
const RESERVED_IPV6 = [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
] as const

const RESERVED_IPS = new BlockList()

for (const [network, prefix] of RESERVED_IPV4) {
  RESERVED_IPS.addSubnet(network, prefix, 'ipv4')
}

for (const [network, prefix] of RESERVED_IPV6) {
  RESERVED_IPS.addSubnet(network, prefix, 'ipv6')
}

/**
 * IPv4-mapped (`::ffff:0:0/96`) and IPv4-translated (`::ffff:0:0:0/96`) IPv6
 * literals carry an IPv4 host in their low 32 bits and reach that same host on
 * the wire, so every reserved IPv4 range is mirrored into both prefixes.
 * Without the mirroring `::ffff:0:169.254.169.254` reaches the cloud metadata
 * service unchecked (issue #116).
 *
 * Mirroring each range instead of blocking the prefixes wholesale: a single
 * `::ffff:0:0/96` subnet would also reject genuinely public literals such as
 * `::ffff:8.8.8.8`. The same rule applies to the NAT64 (`64:ff9b::/96`) and 6to4
 * (`2002::/16`) transition prefixes: blocking those wholesale made
 * `64:ff9b::808:808` (NAT64-mapped 8.8.8.8) look private, which fails every
 * fetch on an IPv6-only/NAT64 network.
 *
 * Node's BlockList happens to fold the *mapped* spelling into its IPv4 table
 * (so that half is belt-and-braces), but the translated spelling is not folded
 * and that is what these subnets actually fix. Neither behaviour is documented
 * API, hence registering both explicitly.
 */

/** IPv4 点分十进制 → 两个 hextet（把 v4 保留段镜像进「内嵌 IPv4」的过渡前缀）。 */
function v4Tail(v4: string): string {
  const [a = 0, b = 0, c = 0, d = 0] = v4.split('.').map(n => Number.parseInt(n, 10) || 0)
  return `${(((a << 8) | b) >>> 0).toString(16)}:${(((c << 8) | d) >>> 0).toString(16)}`
}

for (const [network, prefix] of RESERVED_IPV4) {
  RESERVED_IPS.addSubnet(`::ffff:${network}`, prefix + 96, 'ipv6')
  RESERVED_IPS.addSubnet(`::ffff:0:${network}`, prefix + 96, 'ipv6')
  // NAT64 `64:ff9b::/96`——低 32 位即 IPv4
  RESERVED_IPS.addSubnet(`64:ff9b::${v4Tail(network)}`, prefix + 96, 'ipv6')
  // 6to4 `2002:WWXX:YYZZ::/48`——前 32 位即 IPv4
  RESERVED_IPS.addSubnet(`2002:${v4Tail(network)}::`, prefix + 16, 'ipv6')
}

export function isPrivateIP(ip: string): boolean {
  const family = isIP(ip)
  if (family === 4) return RESERVED_IPS.check(ip, 'ipv4')
  if (family === 6) return RESERVED_IPS.check(ip, 'ipv6')
  return false
}

export class SSRFError extends Error {
  constructor(
    readonly hostname: string,
    readonly address: string,
  ) {
    super(`Access denied: ${hostname} resolves to a private/reserved IP (${address})`)
    this.name = 'SSRFError'
  }
}

export interface ResolvedAddress {
  address: string
  /** 4 or 6; may be absent for injected lookups that only return an address. */
  family?: number
}

export type LookupFn = (hostname: string) => Promise<ResolvedAddress>

export async function resolveAndAssertPublic(
  hostname: string,
  lookup: LookupFn,
): Promise<ResolvedAddress> {
  // URL.hostname 对 IPv6 literal 返回带方括号的形式（"[::1]"）：isIP 返回 0，dns.lookup
  // 也解析不了它，校验会形同失效。四个消费点（http-fetch 1 处、render-fetch 3 处）都传
  // URL.hostname，故在最靠内的一层统一剥括号。
  const host = hostname.replace(/^\[|\]$/g, '')
  const { address, family } = await lookup(host)
  if (isPrivateIP(address)) {
    throw new SSRFError(hostname, address)
  }
  const ipFamily = isIP(address)
  return { address, family: family ?? (ipFamily === 0 ? undefined : ipFamily) }
}

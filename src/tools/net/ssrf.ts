import { BlockList, isIP } from 'node:net'

const RESERVED_IPS = new BlockList()

for (const [network, prefix] of [
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
] as const) {
  RESERVED_IPS.addSubnet(network, prefix, 'ipv4')
}

for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
  // NAT64/6to4 过渡段——内嵌 IPv4 的形态可绕过 v4 黑名单直连其映射的
  // 私有/链路本地地址（如 64:ff9b::a9fe:a9fe → 169.254.169.254）。
  ['64:ff9b::', 96],
  ['2002::', 16],
  // IPv4-mapped IPv6：内嵌 IPv4 的表示形式（如 ::ffff:169.254.169.254 直连云元数据）。
  // 若不登记，isIP() 返回 6 时 BlockList 查不到 → 被当作公网放行（SSRF 防护击穿）。
  ['::ffff:0:0', 96],
] as const) {
  RESERVED_IPS.addSubnet(network, prefix, 'ipv6')
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
  const { address, family } = await lookup(hostname)
  if (isPrivateIP(address)) {
    throw new SSRFError(hostname, address)
  }
  const ipFamily = isIP(address)
  return { address, family: family ?? (ipFamily === 0 ? undefined : ipFamily) }
}

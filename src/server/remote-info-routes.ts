/**
 * GET /remote/info — 远程访问信息（P1 Mobile Remote）。
 *
 * 桌面「远程访问」设置区块的数据源 + 手机连通自检端点。返回监听模式
 * （loopback/lan）、监听地址、本机局域网 IPv4 列表。Bearer 门控。
 *
 * 设计取舍：不返回端口——调用方必知自身请求端口（桌面端另有
 * RuntimeInfo.port），测试注入 port 0 时回显 0 反而误导。
 */
import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import { isLoopbackBind } from './host-policy.js'
import { networkInterfaces } from 'node:os'
import type { createRemoteAccessEndpoint } from './remote-access-endpoint.js'

export interface RemoteInfoOptions {
  protocol?: 'http' | 'https'
  /** 实际绑定地址（startServer opts.host 同源）。 */
  host: string
  /** Host allowlist（有配置时随响应返回，供 UI 显示收紧状态）。 */
  allowedHosts?: string[]
  /**
   * LAN Direct opt-in 是否生效（设计 §5.3 Wave 1 第 4 条）——UI 据此显示
   * 「局域网明文直连」状态徽章。缺省 false，与未 opt-in 的默认形态一致。
   */
  lanDirect?: boolean
  endpoint?: ReturnType<typeof createRemoteAccessEndpoint>
}

export interface LanUrl {
  name: string
  address: string
}

/**
 * 局域网接口排序（审查 F2：QR 取 lanUrls[0]，而 os.networkInterfaces 为原始
 * 迭代序——多网卡/虚拟接口机器上首个不保证是手机可达的物理接口）。
 * 排序：物理接口（en/eth/wlan/wl/ap 开头）优先，虚拟/隧道（utun/tun/tap/llw/
 * awdl/bridge/docker/veth/ppp/wg 等）垫底，其余中间；组内保持枚举序（稳定排序）。
 */
const PHYSICAL_RE = /^(en|eth|wlan|wl|ap)[0-9]|^(en|eth|wlan|wl|ap)-/i
const VIRTUAL_RE = /^(utun|tun|tap|llw|awdl|bridge|br-|docker|veth|ppp|wg|ipsec|gif|stf)/i

export function sortLanUrls(urls: LanUrl[]): LanUrl[] {
  const rankOf = (u: LanUrl): number =>
    PHYSICAL_RE.test(u.name) ? 0 : VIRTUAL_RE.test(u.name) ? 2 : 1
  return [...urls].sort((a, b) => rankOf(a) - rankOf(b))
}

export function buildRemoteInfoRoutes(apiToken?: string, opts?: RemoteInfoOptions): Record<string, RouteHandler> {
  const host = opts?.host.trim().toLowerCase() ?? '127.0.0.1'
  // 判定与 startServer 的 lanMode 同源（host-policy.ts）：此前这里内联复刻了一份
  // 判定并把 '::' 当回环，--host :: 时报 mode:'loopback'——桌面设置页 QR 门控
  // 短路不画码（且 listenHost 显示 '::'，与 mode 自相矛盾）。
  const lanMode = !isLoopbackBind(host)
  return {
    'PUT /remote/endpoint': async (body, _params, headers) => {
      if (!isAuthorizedRequest({ body, headers }, apiToken)) return { status: 401, body: { error: 'Unauthorized' } }
      if (!opts?.endpoint) return { status: 503, body: { error: 'remote_endpoint_unavailable' } }
      const { baseUrl } = (body ?? {}) as { baseUrl?: unknown }
      if (typeof baseUrl !== 'string') return { status: 400, body: { error: 'invalid_remote_https_address' } }
      try { return { status: 200, body: { baseUrl: opts.endpoint.set(baseUrl) } } }
      catch { return { status: 400, body: { error: 'invalid_remote_https_address' } } }
    },
    'GET /remote/info': async (body, _params, headers) => {
      if (!isAuthorizedRequest({ body, headers }, apiToken)) {
        return { status: 401, body: { error: 'Unauthorized' } }
      }
      const rawUrls: LanUrl[] = []
      for (const [name, addrs] of Object.entries(networkInterfaces())) {
        for (const a of addrs ?? []) {
          if (a.family === 'IPv4' && !a.internal) {
            rawUrls.push({ name, address: a.address })
          }
        }
      }
      const allowedHosts = [...new Set([...(opts?.allowedHosts ?? []), ...(opts?.endpoint?.hosts() ?? [])])]
      return {
        status: 200,
        body: {
          mode: lanMode ? 'lan' : 'loopback',
          protocol: opts?.protocol ?? 'http',
          lanDirect: opts?.lanDirect === true,
          listenHost: opts?.host ?? '127.0.0.1',
          lanUrls: sortLanUrls(rawUrls),
          remoteBaseUrl: opts?.endpoint?.get() ?? '',
          ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
        },
      }
    },
  }
}

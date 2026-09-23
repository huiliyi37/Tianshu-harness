/**
 * 加密连接扫描（HTTPS 中间人）探测 —— 纯读，不发任何网络请求。
 *
 * 背景：杀毒软件 / 企业代理（卡巴斯基、ESET、Zscaler…）会把自签根证书装进
 * **系统**证书存储，再对 TLS 连接做中间人。天枢的 sidecar 走 Node 的 undici/
 * fetch，默认只信任**内置** Mozilla CA 列表、不读系统存储 —— 于是接口报
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE / SELF_SIGNED_CERT_IN_CHAIN，用户完全看不出
 * 是杀毒软件干的（详见 docs/WINDOWS-INSTALL.md 的杀毒软件 FAQ）。
 *
 * 这里只做两件可离线完成的事：
 *   ① 看生效信任链里是否已含系统 CA（等价于 `--use-system-ca` 是否生效）；
 *   ② 在系统存储里找已知中间人厂商的根证书 subject。
 *
 * 判定口径用 Node 自己的 `tls.getCACertificates`：`'bundled'` 是内置列表、
 * `'system'` 是系统存储、`'default'` 是**当前生效**的信任链。带
 * `--use-system-ca` 时 default = bundled ∪ system（本机实测 120 → 123），
 * 不带时 default === bundled —— 比扫 process.execArgv / NODE_OPTIONS 可靠
 * （env 可以被 node 参数解析吞掉、也可能来自 NODE_OPTIONS）。
 */

import { getCACertificates } from 'node:tls'

/** 命中即认定为中间人根证书的厂商名（大小写不敏感，出现在证书 subject 里）。 */
const INTERCEPTION_VENDORS: ReadonlyArray<readonly [RegExp, string]> = [
  [/kaspersky/i, 'Kaspersky'],
  [/eset/i, 'ESET'],
  [/avast|avg technologies/i, 'Avast/AVG'],
  [/bitdefender/i, 'BitDefender'],
  [/dr\.?\s*web/i, 'Dr.Web'],
  [/huorong|火绒/i, '火绒'],
  [/qihoo|360\.?cn|360 safe/i, '360'],
  [/sangfor|深信服/i, '深信服'],
  [/tencent/i, '腾讯'],
  [/zscaler/i, 'Zscaler'],
  [/netskope/i, 'Netskope'],
  [/fortinet|fortigate/i, 'Fortinet'],
  [/palo alto/i, 'Palo Alto'],
  [/cisco umbrella|opendns/i, 'Cisco Umbrella'],
  [/charles (proxy|web debug)/i, 'Charles Proxy'],
  [/fiddler/i, 'Fiddler'],
  [/mitmproxy/i, 'mitmproxy'],
  [/proxyman/i, 'Proxyman'],
]

/** 检出的根证书 subject 最多展示这么多条（再多的对排障没有增量信息）。 */
const MAX_SUSPECTS = 5

export interface TlsTrustReport {
  /** 系统证书存储是否可读（不可读平台/版本为 false，此时 suspects 必为空）。 */
  systemStoreReadable: boolean
  /** 系统存储里的证书条数。 */
  systemCaCount: number
  /** 生效信任链是否已包含系统 CA（即中间人的根证书会被接受）。 */
  trustsSystemCa: boolean
  /** 内置 CA 条数（对照用）。 */
  bundledCaCount: number
  /** 命中的中间人根证书 subject（已截断）。 */
  suspects: string[]
  /** 命中总数（未被 MAX_SUSPECTS 截断）。 */
  suspectCount: number
  /** 与 suspects 对应的厂商名（去重）。 */
  vendors: string[]
}

/** 可注入的证书源——测试用它喂合成的证书链，生产用 Node 的 tls API。 */
export interface TlsTrustProbe {
  bundled(): string[]
  system(): string[]
  effective(): string[]
}

/** 排障建议（三条，按信任降级程度从低到高）。CLI/桌面共用同一份措辞。 */
export const TLS_MITM_ADVICE: readonly string[] = [
  '① 在杀毒软件/代理里为天枢排除接口域名（首选，零信任降级）：卡巴斯基 → 设置 → 安全 → 网络设置 → 加密连接扫描 → 管理排除项；并给 tianshu-desktop.exe 与 node-runtime\\node.exe 加受信任应用程序规则。',
  '② 只多信一张证书：NODE_EXTRA_CA_CERTS=<导出的扫描根证书路径> 后重启天枢。',
  '③ 信任整个系统 CA 存储：NODE_OPTIONS=--use-system-ca 后重启天枢（等于信任系统存储里的全部 CA，收敛性最差）。',
]

const defaultProbe: TlsTrustProbe = {
  bundled: () => safeGet('bundled'),
  system: () => safeGet('system'),
  effective: () => safeGet('default'),
}

function safeGet(kind: 'bundled' | 'system' | 'default'): string[] {
  try {
    return getCACertificates(kind)
  } catch {
    // 'system' 在部分平台/Node 版本上不可用（抛 ERR_INVALID_ARG_VALUE 或空实现）。
    return []
  }
}

/** 从证书列表里挑出已知中间人厂商的 subject。导出供测试直接断言。 */
export function findInterceptionCerts(certs: readonly string[]): {
  suspects: string[]
  vendors: string[]
  count: number
} {
  const suspects: string[] = []
  const vendors: string[] = []
  let count = 0
  for (const cert of certs) {
    const vendor = INTERCEPTION_VENDORS.find(([re]) => re.test(cert))?.[1]
    if (!vendor) continue
    count++
    if (suspects.length < MAX_SUSPECTS) {
      suspects.push(firstLine(cert))
      if (!vendors.includes(vendor)) vendors.push(vendor)
    }
  }
  return { suspects, vendors, count }
}

/** 证书是一段 PEM，展示时只取 subject 那一行（第一行非 BEGIN 的内容）。 */
function firstLine(cert: string): string {
  const line = cert
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('-----'))
  return line ?? '(unparsable certificate)'
}

/**
 * 探测本进程的 HTTPS 信任链状况。任何一步失败都退化为「未检出」，
 * 绝不抛错——它是诊断输出的一部分，不是门禁。
 */
export function detectTlsInterception(probe: TlsTrustProbe = defaultProbe): TlsTrustReport {
  const bundled = call(probe.bundled)
  const system = call(probe.system)
  const effective = call(probe.effective)
  const { suspects, vendors, count } = findInterceptionCerts(system)
  return {
    systemStoreReadable: system.length > 0,
    systemCaCount: system.length,
    // 生效链比内置链长 ⇒ 系统 CA 已并入（--use-system-ca 生效）。
    trustsSystemCa: effective.length > bundled.length,
    bundledCaCount: bundled.length,
    suspects,
    suspectCount: count,
    vendors,
  }
}

/** 诊断代码里的探针调用一律吞错：探测失败只能是「没探到」，不能是崩溃。 */
function call(fn: () => string[]): string[] {
  try {
    const out = fn()
    return Array.isArray(out) ? out : []
  } catch {
    return []
  }
}

/** 人类可读的诊断行（/doctor 与桌面端环境页共用）。 */
export function formatTlsTrustLines(report: TlsTrustReport): string[] {
  const lines: string[] = []
  if (!report.systemStoreReadable) {
    lines.push('系统证书存储不可读（本平台/Node 版本不支持），跳过加密连接扫描探测。')
    return lines
  }
  if (report.suspectCount === 0) {
    lines.push(`系统 CA 存储 ${report.systemCaCount} 条，未检出已知的加密连接扫描根证书。`)
    return lines
  }
  lines.push(`检出加密连接扫描根证书 ${report.suspectCount} 条（${report.vendors.join('、')}）：`)
  for (const s of report.suspects) lines.push(`  · ${s}`)
  if (report.trustsSystemCa) {
    lines.push('本进程已信任系统 CA 存储（--use-system-ca 生效）——扫描证书被接受；代价是系统存储里的全部 CA 都被信任。')
  } else {
    lines.push('本进程未信任系统 CA 存储：该软件对 HTTPS 做中间人时，接口会以证书错误失败。')
    for (const a of TLS_MITM_ADVICE) lines.push(a)
  }
  return lines
}

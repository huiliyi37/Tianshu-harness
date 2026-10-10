import { readFileSync } from 'node:fs'
import type { ServerOptions } from 'node:https'
import { isLoopbackBind } from './host-policy.js'

/**
 * LAN Direct 显式 opt-in 选项（设计 docs/design/2026-10-08-issue402-lan-direct-connect.md §5.3 Wave 1）。
 *
 * 语义边界：这是把「是否接受局域网明文」的决定权显式交给用户的一次降级，
 * 不改变任何既有默认值——缺省（undefined / false）时 `assertSecureBind` 行为
 * 与历史完全一致（独立 CLI `--host 0.0.0.0` 无 TLS 仍抛错）。
 */
export interface SecureBindOptions {
  /** 仅 `=== true` 放行；`undefined` / `false` 与未 opt-in 等价。 */
  lanDirect?: boolean
}

/**
 * LAN Direct opt-in 解析——单一真源，serve.ts / index.ts 共用。
 * 优先级：显式 opts > env `RIVET_SERVE_LAN_DIRECT`；env 仅字面 `'1'` 视为开启
 * （不扩张 `'true'` / `'yes'` 变体：布尔型环境变量只认一个正样本，避免语义漂移）。
 */
export function resolveLanDirect(explicit?: boolean, env: string | undefined = process.env.RIVET_SERVE_LAN_DIRECT): boolean {
  return explicit ?? (env === '1')
}

export function assertSecureBind(host: string, tls?: ServerOptions, opts?: SecureBindOptions): void {
  if (isLoopbackBind(host) || (tls?.cert && tls?.key)) return
  if (opts?.lanDirect === true) {
    // 可审计：明文放行必须留下痕迹（设计 §5.3 Wave 1 第 1 条）。
    console.warn(
      `[serve] LAN direct plaintext enabled for bind host "${host}" — traffic on the local network is unencrypted. ` +
        'Host allowlist is restricted to private/link-local addresses; disable the opt-in to return to the default.',
    )
    return
  }
  throw new Error('Non-loopback access requires TLS. Use --tls-cert and --tls-key, or keep the server on loopback behind an HTTPS tunnel.')
}

export function readServeTlsArgs(args: string[]): ServerOptions | undefined {
  const value = (flag: string) => {
    const index = args.indexOf(flag)
    if (index < 0) return undefined
    const path = args[index + 1]
    if (!path || path.startsWith('--')) throw new Error(`Missing value for ${flag}`)
    return path
  }
  const cert = value('--tls-cert'), key = value('--tls-key')
  if (!cert && !key) return undefined
  if (!cert || !key) throw new Error('--tls-cert and --tls-key must be supplied together')
  return { cert: readFileSync(cert), key: readFileSync(key), minVersion: 'TLSv1.2' }
}

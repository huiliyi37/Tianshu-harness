/**
 * P1-4 —— 只读会话快照的脱敏层（回流自 `origin/tianshu-alpha-3.14`，按 3.15 口径重接）。
 *
 * 与 `redact.ts` 的分工：
 * - `redact.ts` 是**通用口径**（事件落盘 / wire 用）：敏感键名 + Bearer /
 *   api_key / token / secret / password + `sk-`/`ghp_`/AKIA 裸钥形态；
 * - 这里是**分享加严层**：快照会离开本机（发同事、贴 issue、附到 bug 报告），
 *   所以额外遮 JWT、PEM 私钥块、OpenSSH 私钥、`~/.ssh` 路径。
 *
 * 两道串联执行（先通用后加严），findings 累计——UI 会显示"脱敏发现 N 处"，
 * 让用户知道这份文件不是原文。
 *
 * **仍是 best-effort 启发式**：正则挡不住变形密钥（拼接、base64 包一层、截图里的
 * 密钥）。导出后仍应人工过一眼——函数把 findings 交出来，正是为了让"有没有东西
 * 被遮"这件事可见，而不是让用户以为已经安全。
 */

import { isSensitiveKey, redactTextWithCount } from './redact.js'

export interface RedactionResult {
  text: string
  findings: number
}

interface Pattern {
  kind: string
  re: RegExp
}

/** 快照专属加严模式（通用口径之外的形态）。 */
const EXTRA_PATTERNS: Pattern[] = [
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\b/g },
  { kind: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  // SSH 材料一律遮：`ssh-<algo>AAAA…` 是**公钥**（本身不敏感，但常与私钥同处一屏、
  // 且可能被当作凭据误传）；真正的私钥块（`-----BEGIN OPENSSH PRIVATE KEY-----`）由
  // 上面的 private_key 覆盖。命名如实——别叫 openssh_private，它匹配的不是私钥。
  { kind: 'openssh_public', re: /\bssh-(?:rsa|ed25519|ecdsa)[A-Za-z0-9+/=]{16,}\b/g },
  { kind: 'ssh_path', re: /(?:~|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/\.ssh\/[^\s"']+/g },
]

/** 脱敏一段文本。返回脱敏结果与命中处数（通用口径的命中由 redact.ts 如实回报）。 */
export function redactSnapshotText(raw: string): RedactionResult {
  const base = redactTextWithCount(raw)
  let findings = base.findings
  let text = base.text
  for (const p of EXTRA_PATTERNS) {
    text = text.replace(p.re, () => {
      findings++
      return `<redacted:${p.kind}>`
    })
  }
  return { text, findings }
}

/**
 * 脱敏任意标量/对象树（返回深拷贝，不改入参）。
 * 敏感**键名**整值遮掉（与通用口径同源判定），字符串值逐个过文本脱敏。
 */
export function redactSnapshotValue<T>(value: T): { value: T; findings: number } {
  let findings = 0
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const r = redactSnapshotText(node)
      findings += r.findings
      return r.text
    }
    if (Array.isArray(node)) return node.map((child) => walk(child))
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (isSensitiveKey(key)) {
          findings++
          out[key] = '[REDACTED]'
          continue
        }
        out[key] = walk(child)
      }
      return out
    }
    return node
  }
  return { value: walk(value) as T, findings }
}

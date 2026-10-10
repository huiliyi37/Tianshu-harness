/**
 * 运行时完整性清单（runtime integrity manifest）—— 给「记事本改一行 JS 就白嫖
 * Pro」这条 2 分钟攻击路径上锁。
 *
 * ## 解决的问题
 *
 * 桌面端 sidecar 是**明文落盘的 JS**（`rivet-runtime/*.js`），壳启动前不做任何
 * 完整性校验。攻击者删掉 `pro-license.js` 里的桌面短路（或干脆改成
 * `return {enabled:true}`）就拿到 Pro——不需要密码学，只要记事本。
 *
 * 现在的信任链：
 *   发布机（离线私钥）签 `integrity.json`
 *     → 壳（Rust，编译进机器码）spawn 前重算 bundle 摘要 + 验签
 *     → 不一致则**不注入 Pro 凭证**（`basic` 模式）或**拒绝拉起 sidecar**
 *       （`block` 模式，见 `desktop/src-tauri/src/integrity.rs`）
 *     → sidecar 侧 `resolveProLicense` 缺凭证即 fail closed
 *
 * 于是「改 JS」要拿到 Pro，必须先改原生 shell 并绕过 Authenticode/公证签名
 * 检查。**注意**：完整性校验不能阻止「patch JS 后直启 CLI」——那条路落到开源
 * 版软 gate，是产品有意放开的行为；被堵死的是**桌面端**授权路径。
 *
 * ## 跨语言一致性（最关键的工程约束）
 *
 * Rust 侧 `integrity.rs` 必须算出与本文件**逐字节相同**的摘要。为此：
 * 1. 文件枚举规则（`shouldIncludePath`）两处各一份，配套表驱动测试；
 * 2. 摘要消息是纯 ASCII 显式拼接（不依赖 JSON 序列化的空白/转义差异），
 *    且路径强制校验为可打印 ASCII（非 ASCII 路径在生成清单时直接报错）；
 * 3. 仓库内有同一份 fixture 目录，JS 与 Rust 两侧都断言同一个期望摘要
 *    （`desktop/integrity-conformance/` 是只依赖 sha2/ed25519 的迷你 crate，
 *    跑 `cargo test` 验证 Rust 实现，不必编译整个 Tauri）。
 */
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { INTEGRITY_SIGNING_DOMAIN, LICENSE_PRODUCT } from './license-keys.js'

export type IntegrityMode = 'code' | 'full'

/** 清单文件名（位于 bundle 根目录，自身不参与摘要）。 */
export const INTEGRITY_MANIFEST_FILENAME = 'integrity.json'

/** 清单格式版本。 */
export const INTEGRITY_MANIFEST_VERSION = 1

/** 目录深度上限，防御异常深目录（生成/校验行为必须一致）。 */
const MAX_DEPTH = 24

export interface IntegrityManifest {
  v: number
  product: string
  mode: IntegrityMode
  createdAt: number
  /** 文件清单摘要（= 规范化 `path\0hash\n` 列表的 sha256 hex）。 */
  bundleHash: string
  fileCount: number
  /** relPath → sha256 hex；诊断用（能指出到底是哪个文件被改）。 */
  files: Record<string, string>
  /** Ed25519 签名（base64url），消息见 integritySigningMessage()。 */
  sig: string
}

export interface IntegrityCheckResult {
  ok: boolean
  reason:
    | 'ok'
    | 'manifest_missing'
    | 'manifest_malformed'
    | 'bad_signature'
    | 'mode_mismatch'
    | 'product_mismatch'
    | 'digest_mismatch'
    | 'file_count_mismatch'
  /** 清单里签名保护的摘要（验签通过后才有意义）。 */
  expectedHash?: string
  /** 本机重算的摘要。 */
  actualHash?: string
  /** 摘要不一致时的差异文件（最多 20 条，诊断用）。 */
  changed?: string[]
  manifest?: IntegrityManifest
}

function toPosix(rel: string): string {
  return rel.split('\\').join('/')
}

/**
 * 文件枚举规则（Rust 侧同名函数必须一致，表驱动测试见
 * `__tests__/runtime-integrity.test.ts` 与 `integrity.rs` 的 mod tests）。
 *
 * 排除项分两类：
 * - **永远排除**：清单自身、运行时会自愈改写的 `package.json`（由
 *   `ensure_sidecar_esm_declaration` 写入）、缓存/日志/临时文件、编辑器垃圾。
 * - **`code` 模式排除**：`node_modules/**`（3005 个文件 / 139MB 里的绝大部分，
 *   hashing 会拖慢启动 0.5~1s；授权判定代码经 tsup 落在顶层 chunk，第三方
 *   依赖不是授权边界）。`full` 模式把它们算进来，用于高安全场景。
 *
 * 符号链接一律不参与（`lstat` 判定），避免跳出 bundle 树与环路。
 */
export function shouldIncludePath(relPath: string, mode: IntegrityMode): boolean {
  const p = toPosix(relPath).replace(/^\.\//, '')
  if (p.length === 0) return false

  const segments = p.split('/')
  if (segments.length > MAX_DEPTH) return false
  if (segments.some((s) => s.startsWith('._'))) return false

  // 永远排除：清单自身 / 运行时自愈文件
  if (p === INTEGRITY_MANIFEST_FILENAME) return false
  if (p === 'package.json') return false

  // 永远排除：目录段（缓存 / 临时 / 日志）
  if (segments.some((s) => s === '.cache' || s === 'compile-cache' || s === 'tmp' || s === '.tmp' || s === 'logs')) {
    return false
  }

  const lower = p.toLowerCase()
  if (lower.endsWith('.log') || lower.endsWith('.tmp') || lower.endsWith('.ds_store')) return false

  if (mode === 'code' && segments[0] === 'node_modules') return false
  return true
}

function collectFiles(root: string, mode: IntegrityMode): string[] {
  const out: string[] = []
  const walk = (dir: string, relDir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const abs = join(dir, name)
      const rel = relDir ? `${relDir}/${name}` : name
      let st: ReturnType<typeof lstatSync>
      try {
        st = lstatSync(abs)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        // 提前剪枝：整棵被排除的目录不必递归
        if (!shouldIncludePath(`${rel}/__dir__`, mode)) continue
        walk(abs, rel, depth + 1)
      } else if (st.isFile()) {
        if (shouldIncludePath(rel, mode)) out.push(rel)
      }
    }
  }
  walk(root, '', 0)
  // ASCII 路径下 JS 默认排序与 Rust `sort()` 的字节序一致；非 ASCII 由
  // assertAsciiPaths 在生成清单时挡掉，校验时不会遇到。
  out.sort()
  return out
}

export function sha256Hex(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * 规范化文件列表 → 摘要。格式（两语言逐字节一致）：
 *
 * ```
 * 对每个文件（路径 ASCII 升序）追加： path + NUL + sha256hex + LF
 * bundleHash = sha256hex(上述拼接结果)
 * ```
 *
 * 用 NUL/LF 显式分隔，不依赖任何 JSON 序列化行为，消除跨语言差异。
 */
export function computeBundleHashFromMap(files: Record<string, string>): string {
  const paths = Object.keys(files).sort()
  const hash = createHash('sha256')
  for (const p of paths) {
    const digest = files[p]
    if (digest === undefined) continue // 调用方保证 key 存在；这里防御 noUncheckedIndexedAccess
    hash.update(p, 'utf8')
    hash.update('\0', 'utf8')
    hash.update(digest, 'utf8')
    hash.update('\n', 'utf8')
  }
  return hash.digest('hex')
}

/** 扫描目录并算出 { files, bundleHash }。 */
export function computeBundle(
  root: string,
  mode: IntegrityMode = 'code'
): { files: Record<string, string>; bundleHash: string; fileCount: number } {
  const paths = collectFiles(root, mode)
  const files: Record<string, string> = {}
  for (const rel of paths) {
    files[rel] = sha256Hex(readFileSync(join(root, rel)))
  }
  const bundleHash = computeBundleHashFromMap(files)
  return { files, bundleHash, fileCount: paths.length }
}

/** 非 ASCII 路径会让 JS/Rust 的排序与编码语义分叉 —— 生成清单时直接拒绝。 */
export function assertAsciiPaths(files: Record<string, string>): void {
  for (const p of Object.keys(files)) {
    // eslint-disable-next-line no-control-regex
    if (!/^[\x20-\x7e]+$/.test(p)) {
      throw new Error(`integrity: 非 ASCII 路径不受支持（跨语言摘要会分叉）：${JSON.stringify(p)}`)
    }
  }
}

/** 签名消息（两语言逐字节一致，带域分隔前缀防跨协议签名混淆）。 */
export function integritySigningMessage(m: {
  v: number
  product: string
  mode: IntegrityMode
  createdAt: number
  bundleHash: string
  fileCount: number
}): string {
  return `${INTEGRITY_SIGNING_DOMAIN}v${m.v}|${m.product}|${m.mode}|${m.createdAt}|${m.fileCount}|${m.bundleHash}`
}

/** 从清单里剔除签名字段后重算用于验签的消息。 */
export function manifestSigningMessage(manifest: Omit<IntegrityManifest, 'sig'>): string {
  return integritySigningMessage({
    v: manifest.v,
    product: manifest.product,
    mode: manifest.mode,
    createdAt: manifest.createdAt,
    bundleHash: manifest.bundleHash,
    fileCount: manifest.fileCount,
  })
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export function publicKeyFromRawB64(publicKeyB64: string) {
  const raw = Buffer.from(publicKeyB64, 'base64')
  if (raw.length !== 32) throw new Error(`bad_public_key_len:${raw.length}`)
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  })
}

export function verifyManifestSignature(manifest: IntegrityManifest, publicKeyB64: string): boolean {
  try {
    const sig = Buffer.from(manifest.sig, 'base64url')
    if (sig.length !== 64) return false
    const msg = Buffer.from(manifestSigningMessage(manifest), 'utf8')
    return cryptoVerify(null, msg, publicKeyFromRawB64(publicKeyB64), sig)
  } catch {
    return false
  }
}

/**
 * 校验顺序刻意设计为「先验签、后比摘要」：
 * 清单是攻击者可写的文件，摘要字段必须来自可信签名才能当判据；反过来先比
 * 摘要会把「伪造一份自洽的清单」当成通过。
 */
export function verifyIntegrityManifest(
  root: string,
  opts: { mode?: IntegrityMode; publicKeyB64: string; manifest?: IntegrityManifest }
): IntegrityCheckResult {
  const mode = opts.mode ?? 'code'
  let manifest = opts.manifest
  if (!manifest) {
    let raw: string
    try {
      raw = readFileSync(join(root, INTEGRITY_MANIFEST_FILENAME), 'utf8')
    } catch {
      return { ok: false, reason: 'manifest_missing' }
    }
    try {
      manifest = JSON.parse(raw) as IntegrityManifest
    } catch {
      return { ok: false, reason: 'manifest_malformed' }
    }
  }

  if (
    !manifest ||
    typeof manifest !== 'object' ||
    manifest.v !== INTEGRITY_MANIFEST_VERSION ||
    typeof manifest.bundleHash !== 'string' ||
    typeof manifest.sig !== 'string' ||
    typeof manifest.mode !== 'string' ||
    typeof manifest.createdAt !== 'number' ||
    typeof manifest.fileCount !== 'number' ||
    !manifest.files ||
    typeof manifest.files !== 'object'
  ) {
    return { ok: false, reason: 'manifest_malformed' }
  }
  if (manifest.product !== LICENSE_PRODUCT) {
    return { ok: false, reason: 'product_mismatch' }
  }
  if (manifest.mode !== mode) {
    return { ok: false, reason: 'mode_mismatch' }
  }
  if (!verifyManifestSignature(manifest, opts.publicKeyB64)) {
    return { ok: false, reason: 'bad_signature' }
  }

  const actual = computeBundle(root, mode)
  if (actual.fileCount !== manifest.fileCount) {
    return {
      ok: false,
      reason: 'file_count_mismatch',
      expectedHash: manifest.bundleHash,
      actualHash: actual.bundleHash,
      changed: diffFiles(manifest.files, actual.files).slice(0, 20),
      manifest,
    }
  }
  if (actual.bundleHash !== manifest.bundleHash) {
    return {
      ok: false,
      reason: 'digest_mismatch',
      expectedHash: manifest.bundleHash,
      actualHash: actual.bundleHash,
      changed: diffFiles(manifest.files, actual.files).slice(0, 20),
      manifest,
    }
  }
  return { ok: true, reason: 'ok', expectedHash: manifest.bundleHash, actualHash: actual.bundleHash, manifest }
}

/** 差异文件（新增/删除/内容不同），诊断用。 */
export function diffFiles(expected: Record<string, string>, actual: Record<string, string>): string[] {
  const out: string[] = []
  const names = new Set([...Object.keys(expected), ...Object.keys(actual)])
  for (const n of [...names].sort()) {
    const e = expected[n]
    const a = actual[n]
    if (e === undefined) out.push(`+${n}`)
    else if (a === undefined) out.push(`-${n}`)
    else if (e !== a) out.push(`~${n}`)
  }
  return out
}

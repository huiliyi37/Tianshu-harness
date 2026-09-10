import { existsSync, readdirSync, lstatSync } from 'node:fs'
import { resolve, extname, join } from 'node:path'
import type { Dirent } from 'node:fs'
// @ts-ignore — 显式 .ts 扩展名：本模块经 cpu-tasks 进入 worker 线程，而 worker
// 用 Node 原生 type stripping 加载（不做 .js→.ts 映射）。
import { isRestrictedPath } from '../platform/restricted-paths.ts'
// @ts-ignore — 同上
import { SCAN_EXCLUDE_DIRS } from './scan-excludes.ts'

// ── language inference ────────────────────────────────────────────

export const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'Tsx',
  '.js': 'JavaScript',
  '.jsx': 'Tsx',
  '.html': 'Html',
  '.css': 'Css',
  // Dynamic languages — registered via registerDynamicLanguage, parsed by name
  // (lowercase), NOT via napi.Lang.X. See DYNAMIC_LANGS + ensureDynamicLangsRegistered.
  '.py': 'python',
  '.pyi': 'python',
  '.json': 'json',
  '.jsonc': 'json',
}

/**
 * Languages loaded from @ast-grep/lang-* packages via registerDynamicLanguage.
 * These are parsed by their registered NAME string (e.g. parse('python', src)),
 * not via napi.Lang.X — they have no enumerable Lang enum member.
 */
export const DYNAMIC_LANGS = new Set(['python', 'json'])

export function isDynamicLang(langName: string): boolean {
  return DYNAMIC_LANGS.has(langName)
}

/**
 * Register all dynamic languages EXACTLY ONCE. ast-grep/napi's
 * registerDynamicLanguage honors only the FIRST call — subsequent calls are
 * silently ignored (issue ast-grep/ast-grep#2669). So we batch every dynamic
 * language into one registration guarded by a module-level flag.
 *
 * Lazy: the lang-* packages ship native prebuilds, importing them has a small
 * cost, so we defer until an ast tool actually runs and only when a dynamic
 * language file is present. Missing packages degrade gracefully (the language
 * is dropped from registration, parse later reports "unsupported").
 */
let dynamicLangsRegistered = false
export async function ensureDynamicLangsRegistered(napi: typeof import('@ast-grep/napi')): Promise<void> {
  if (dynamicLangsRegistered) return
  dynamicLangsRegistered = true
  // registration values are LangRegistration-shaped objects from the lang-* packages
  const registration: Record<string, { libraryPath: string; extensions: string[]; languageSymbol?: string }> = {}
  try {
    const pythonMod = await import('@ast-grep/lang-python')
    registration.python = (pythonMod.default ?? pythonMod) as { libraryPath: string; extensions: string[]; languageSymbol?: string }
  } catch { /* package not installed — python unavailable */ }
  try {
    const jsonMod = await import('@ast-grep/lang-json')
    registration.json = (jsonMod.default ?? jsonMod) as { libraryPath: string; extensions: string[]; languageSymbol?: string }
  } catch { /* package not installed — json unavailable */ }
  if (Object.keys(registration).length > 0) {
    try {
      napi.registerDynamicLanguage(registration)
    } catch { /* already registered by another caller or API change — ignore */ }
  }
}

export function inferLang(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase()
  return LANG_BY_EXT[ext] ?? null
}

export function resolveLang(explicit: string | undefined, filePath: string): string | null {
  if (explicit) return explicit
  return inferLang(filePath)
}

/**
 * 单文件解析体积上限。源码文件极少超过 1MB，超出即视为非解析目标。
 *
 * 2026-09-10 卡死事故：`resolveLang` 在显式 `lang` 存在时直接返回该语言、
 * 完全不看文件扩展名，而调用方传 `path`（单数，schema 只认 `paths`）被静默
 * 忽略后 `paths` 退化为 `['.']`——于是整个仓库被扫，`release/` 下 248MB 的
 * AppImage 被当 TypeScript 交给 tree-sitter。同步解析阻塞事件循环，进程
 * 88% CPU / 5.8GB 内存假死 4 小时，SIGTERM 都进不去（需 SIGKILL）。
 * 实测同一 parser：2MB 需 34.6 秒、6MB 需 9 秒单次——量级超线性。
 */
export const MAX_PARSE_FILE_BYTES = 1024 * 1024

/** 二进制内容判定：前 8KB 出现 NUL 字节即视为二进制。
 *  tree-sitter 解析二进制只会产出 ERROR 节点并烧掉巨量 CPU，零信息价值。 */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

/** 准入检查结果：null = 可解析；字符串 = 跳过原因（供调用方汇总给模型）。
 *  `maxBytes` 可覆盖（worker 通道由 AstScanArgs 传入同一阈值），默认取常量。 */
export function parseSkipReason(filePath: string, buf: Buffer, maxBytes = MAX_PARSE_FILE_BYTES): string | null {
  if (buf.length > maxBytes) {
    const mb = (buf.length / 1024 / 1024).toFixed(1)
    return `${filePath}: 跳过（${mb}MB 超过 ${maxBytes / 1024 / 1024}MB 解析上限）`
  }
  if (looksBinary(buf)) return `${filePath}: 跳过（二进制内容）`
  return null
}

/**
 * Build the language-name → napi.Lang-value map. ast-grep/napi's `Lang` uses
 * non-enumerable getters, so this must be constructed AFTER the dynamic import
 * resolves. Shared by ast-grep and ast-edit to keep the supported-language list
 * in one place — the runtime assertion (typeof string) guards against napi API
 * changes that would silently turn these into undefined.
 */
export function buildLangMap(napi: typeof import('@ast-grep/napi')): Record<string, string> {
  return {
    TypeScript: napi.Lang.TypeScript as unknown as string,
    Tsx: napi.Lang.Tsx as unknown as string,
    JavaScript: napi.Lang.JavaScript as unknown as string,
    Html: napi.Lang.Html as unknown as string,
    Css: napi.Lang.Css as unknown as string,
  }
}

// ── file collection ───────────────────────────────────────────────

/** Directories to skip during recursive file collection.
 *  Build artifacts (dist/build/out/.next/coverage) are excluded so ast_grep
 *  doesn't parse compiled output — it produces noise matches and wastes parse
 *  budget on files that aren't the source of truth.
 *
 *  Extendable via RIVET_AST_EXCLUDE (comma-separated dir names) for project-
 *  specific output dirs (lib, target, .output, vendor, etc.). */
// Shared baseline plus this tool's own extras (`.rivet` included here: AST
// search over stored plans and knowledge is noise). The hand-kept copy this
// replaces had lost `target`.
const BASE_EXCLUDE_DIRS = [
  ...SCAN_EXCLUDE_DIRS,
  '.rivet', 'out', '.turbo', 'coverage', '.nyc_output',
]
function resolveExcludeDirs(): Set<string> {
  const env = process.env.RIVET_AST_EXCLUDE
  if (!env) return new Set(BASE_EXCLUDE_DIRS)
  const extra = env.split(',').map(s => s.trim()).filter(Boolean)
  return new Set([...BASE_EXCLUDE_DIRS, ...extra])
}
/** Hard cap on files collected per ast_grep/ast_edit invocation. Without it,
 *  a bare `ast_grep pattern` (paths defaults to '.') parses every source file
 *  in the repo — readFileSync + tree-sitter parse on thousands of files stalls
 *  the tool and can OOM. 5000 covers any realistic targeted search; a search
 *  hitting the cap almost certainly forgot to scope `paths`. */
const MAX_FILES = 5000
/** Recursion depth cap — defends against pathological symlink loops even
 *  though Dirent.isDirectory() is already symlink-safe (lstatSync on the root
 *  only); nested real dirs this deep indicate a generated/ vendored tree. */
const MAX_DEPTH = 25
/** Yield cadence during the recursive walk: a full-repo sync readdir traversal
 *  is a long synchronous slice, and in an in-process worker that freezes TUI
 *  input — yield to the event loop every ~500 directory entries. */
const YIELD_EVERY_ENTRIES = 500

export async function collectFiles(searchPath: string): Promise<string[]> {
  const excludeDirs = resolveExcludeDirs()
  const abs = resolve(searchPath)
  if (!existsSync(abs)) return []
  const stat = lstatSync(abs)
  if (stat.isFile()) return [abs]
  if (!stat.isDirectory()) return []
  const files: string[] = []
  let entriesSinceYield = 0
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (files.length >= MAX_FILES || depth > MAX_DEPTH) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      // Non-root + known restricted system path + permission error → silent skip.
      // depth === 0 is the agent-specified search root — must propagate errors.
      if (depth > 0 && isRestrictedPath(String(e.path ?? e.message ?? ''), e.code ?? '')) return
      throw err
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name)) continue
        await walk(full, depth + 1)
      } else if (entry.isFile()) {
        files.push(full)
      }
      if (++entriesSinceYield >= YIELD_EVERY_ENTRIES) {
        entriesSinceYield = 0
        await new Promise<void>(r => setImmediate(r))
      }
    }
  }
  await walk(abs, 0)
  return files
}

// ── meta-variable parsing ─────────────────────────────────────────

/**
 * Extract meta-variable names from an ast-grep pattern string.
 * Returns pairs of (name, isMulti) where isMulti means $$$NAME (multi-node).
 */
export function collectMetaVarNames(pattern: string): Array<{ name: string; multi: boolean }> {
  const seen = new Set<string>()
  const vars: Array<{ name: string; multi: boolean }> = []
  // group 1: $$ (optional, present → multi), group 2: name
  // Source: pattern like "function $NAME($$$ARGS) { $$$BODY }"
  const re = /\$(\$\$)?([A-Za-z_][A-Za-z0-9_]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(pattern)) !== null) {
    const name = m[2]!
    if (!seen.has(name)) {
      seen.add(name)
      vars.push({ name, multi: m[1] === '$$' })
    }
  }
  return vars
}

// ── pattern 形态判定 ──────────────────────────────────────────────

/**
 * 判定 pattern 是裸串还是 `{ rule: … }` JSON 对象——两种形态 ast-grep 都接受。
 *
 * 工具侧（regex 误用护栏需要 isRuleObject 跳过对象内部字段）与 worker 通道
 * （真正执行匹配）共用同一判定，避免两处实现漂移出「工具认对象、worker 认串」
 * 这类只在特定输入下暴露的分裂。
 */
export function resolveRuleOrPattern(pattern: string): {
  ruleOrPattern: string | Record<string, unknown>
  isRuleObject: boolean
} {
  try {
    const parsed: unknown = JSON.parse(pattern)
    if (parsed && typeof parsed === 'object' && 'rule' in parsed) {
      return { ruleOrPattern: parsed as Record<string, unknown>, isRuleObject: true }
    }
  } catch { /* not JSON — use as bare pattern string */ }
  return { ruleOrPattern: pattern, isRuleObject: false }
}

// ── worker 通道共享（ast_grep / ast_edit 的解析隔离）───────────────────

/** AST worker 通道的软超时（默认 30s）：cpu-pool 默认的 5s 对全仓扫描偏紧，
 *  会把正常的大扫描误判为超时。`RIVET_AST_SCAN_TIMEOUT_MS` 可覆盖（测试注入）。 */
const AST_SCAN_SOFT_MS_DEFAULT = 30_000

export function astScanSoftMs(): number {
  const parsed = Number(process.env.RIVET_AST_SCAN_TIMEOUT_MS)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : AST_SCAN_SOFT_MS_DEFAULT
}

/** 解析不可用时的降级文案。**刻意不回退主线程解析**——回退等于把 2026-09-10 的
 *  冻结风险请回来（native parse 占满事件循环，连信号处理都进不去，只能 SIGKILL）。
 *  宁可让模型改用 grep。 */
export function astScanUnavailable(reason: string): string {
  return `错误：AST 解析不可用（${reason}）。\n`
    + '解析在 worker 线程执行以避免冻结主线程；不可用时不会回退主线程解析。\n'
    + '本次请改用 grep 完成搜索，或缩小 paths 后重试。'
}

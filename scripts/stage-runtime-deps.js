#!/usr/bin/env node
/**
 * stage-runtime-deps.js — copy the unbundlable runtime packages into
 * `dist/node_modules/` so the packaged sidecar can resolve them.
 *
 * Why this exists:
 *   tsup inlines pure-JS deps, but a handful of packages can't be inlined —
 *   native addons (.node), wasm loaders/grammars, and esbuild's Go binary —
 *   so the sidecar loads them at runtime via `import()` / `createRequire()`.
 *   Without a shipped `node_modules` those lookups fail once the .app is
 *   installed outside the repo. We stage the dependency *closure* of each
 *   root package (flat layout) next to the bundle.
 *
 * Platform note: esbuild / @ast-grep list every platform binary as an
 *   optionalDependency. We copy only packages matching the *target* arch
 *   (`TAURI_ENV_TARGET_TRIPLE` / host fallback) so each packaged .app stays
 *   single-arch. Foreign-arch optional deps present in node_modules (from a
 *   previous cross-build ensure step) are skipped.
 *
 * better-sqlite3: we stage ONLY the pure-JS wrapper (lib/ + package.json), NOT
 * the full ~27MB package. The native binary is shipped separately by
 * pack-native.js into dist/native/, and native-resolver loads the wrapper with
 * `{ nativeBinding: <dist/native/better_sqlite3.node> }` — so `bindings`,
 * `prebuild-install` and build/Release are unnecessary. This is the zero-degrade
 * path: the bundled sidecar gets the REAL Database API (prepare/pragma/
 * transaction), never a NullDatabase no-op. A load assertion at the end fails
 * the build if the wrapper + packed .node don't round-trip.
 *
 * Idempotent. Run after `npm run build` (tsup `clean` wipes dist) and after
 * pack-native.js.
 */
import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { isForeignPlatformPackage } from './runtime-platform-filter.js'
import { pruneTreeSitterWasms } from './tree-sitter-wasm-keep.js'
import { pruneTypescriptStaging } from './typescript-stage-trim.js'
import { writeStagingMarker, clearStagingMarker } from './staged-runtime-verify.js'
import { RUNTIME_BUNDLED, verifyConsistency } from './external-deps.js'

// 单一数据源自检：清单漂移（重复 / RUNTIME_BUNDLED 漏列进 SCAN_ALLOWED）在
// 分发前 fail loud，而不是打包后缺包。tsup.config.ts 构建期也跑同一校验。
verifyConsistency()

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')
const srcModules = join(repoRoot, 'node_modules')
const destModules = join(repoRoot, 'dist', 'node_modules')

// Root packages that must be resolvable at runtime in the packaged sidecar.
// 单一数据源：scripts/external-deps.js RUNTIME_BUNDLED（含每包注释）。
const ROOTS = [...RUNTIME_BUNDLED]

function pkgDir(name) {
  // Flat (hoisted) layout: node_modules/<name>. Scoped names keep the slash.
  const dir = join(srcModules, name)
  return existsSync(join(dir, 'package.json')) ? dir : null
}

// ── 跨架构支持（与 pack-native.js 同口径）─────────────────────────────────
// 目标架构 ≠ 宿主时，dist/native/better_sqlite3.node 是目标架构的，无法在宿主
// 进程 require 探测（会抛 arch mismatch）。此时跳过 round-trip 断言，改为读
// Mach-O 头校验架构（fail-closed），ABI 正确性由 pack-native 的 --target 保证。
/** 从 Tauri 目标三元组解析目标架构；无则退回宿主 process.arch。 */
function resolveTargetArch() {
  const triple = (process.env.TAURI_ENV_TARGET_TRIPLE || '').trim()
  if (triple) {
    const tok = triple.split('-')[0]
    if (tok === 'aarch64' || tok === 'arm64') return 'arm64'
    if (tok === 'x86_64') return 'x64'
    if (tok === 'i686') return 'x86'
  }
  return process.arch
}

const CPU_TYPE_X86_64 = 0x01000007
const CPU_TYPE_ARM64 = 0x0100000c

/** 读 thin Mach-O 64 的 cputype → 'x64' | 'arm64' | null。 */
function machoArch(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(8)
    if (readSync(fd, buf, 0, 8, 0) < 8) return null
    if (buf.readUInt32LE(0) !== 0xfeedfacf) return null
    const cpu = buf.readUInt32LE(4)
    if (cpu === CPU_TYPE_X86_64) return 'x64'
    if (cpu === CPU_TYPE_ARM64) return 'arm64'
    return null
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function readDeps(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return [
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.optionalDependencies || {}),
    ]
  } catch {
    return []
  }
}

if (existsSync(destModules)) rmSync(destModules, { recursive: true, force: true })
mkdirSync(destModules, { recursive: true })
// dist/ 脱离仓库独立分发时（桌面端 Resources/rivet-runtime）没有上级 package.json，
// Node 会按 CommonJS 解析 .js —— ESM bundle 启动即 SyntaxError: Cannot use import
// statement outside a module（2026-09-11 Windows 现场）。随 dist 落一份最小
// package.json 声明 ESM，与仓库根 package.json 的 "type":"module" 同语义。
writeFileSync(join(repoRoot, 'dist', 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n')
// Every exit path below except the final success leaves this marker behind, so
// an interrupted run can never be mistaken for a complete one (2026-08-03: a
// dead run left 65 dirs / 0 files and shipped silently for two days).
writeStagingMarker(join(repoRoot, 'dist'), 'copying root package closure')

const visited = new Set()
const queue = [...ROOTS]
const missing = []
let copied = 0
let skippedForeign = 0
let skippedTypes = 0
const keepArchRaw = resolveTargetArch()
/** @type {'arm64'|'x64'} */
const keepArch = keepArchRaw === 'arm64' ? 'arm64' : 'x64'

while (queue.length > 0) {
  const name = queue.shift()
  if (visited.has(name)) continue
  visited.add(name)

  if (isForeignPlatformPackage(name, keepArch)) {
    skippedForeign++
    continue
  }
  // 类型包（@types/*）是编译期产物，运行时闭包不需要——经 exceljs→fast-csv
  // 路径会混入 @types/node（~2.5MB），随包分发纯属浪费。
  if (name.startsWith('@types/')) {
    skippedTypes++
    continue
  }

  const src = pkgDir(name)
  if (!src) {
    // Optional/platform packages for other hosts are not installed — skip quietly
    // unless it's a declared root (then surface it).
    if (ROOTS.includes(name)) missing.push(name)
    continue
  }

  const dest = join(destModules, name)
  mkdirSync(dirname(dest), { recursive: true })
  // dereference symlinks so the staged tree is self-contained.
  cpSync(src, dest, { recursive: true, dereference: true })
  copied++

  for (const dep of readDeps(src)) queue.push(dep)
}

// sourcemap 是调试产物，运行时闭包不需要——exceljs 单包就带 14MB .map。
let removedMaps = 0
const sweepSourceMaps = (d) => {
  for (const e of readdirSync(d)) {
    const p = join(d, e)
    const st = statSync(p)
    if (st.isDirectory()) sweepSourceMaps(p)
    else if (e.endsWith('.map')) {
      rmSync(p, { force: true })
      removedMaps += 1
    }
  }
}
sweepSourceMaps(destModules)
if (removedMaps > 0) {
  console.log(`✅ Removed ${removedMaps} sourcemap(s) from staged node_modules`)
}

function dirSizeMb(dir) {
  let bytes = 0
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else bytes += st.size
    }
  }
  if (existsSync(dir)) walk(dir)
  return Math.round(bytes / 1024 / 1024)
}

if (missing.length > 0) {
  console.error('⚠ stage-runtime-deps: missing root packages (features will degrade): %s', missing.join(', '))
}

// Wave B: ship only grammars meridian-parser actually loads (TS/Python/Go).
const wasmOut = join(destModules, 'tree-sitter-wasms', 'out')
const wasmPrune = pruneTreeSitterWasms(wasmOut)
if (wasmPrune.removed.length > 0) {
  console.log(
    '✅ Pruned tree-sitter-wasms: kept %d, removed %d → %dMB',
    wasmPrune.kept.length,
    wasmPrune.removed.length,
    dirSizeMb(join(destModules, 'tree-sitter-wasms')),
  )
}

// Keep typescript for lsp/client in-process createProgram fallback, but drop
// locale packs + tsc/tsserver CLIs (~9MB) that the API path never loads.
const tsRoot = join(destModules, 'typescript')
const tsPrune = pruneTypescriptStaging(tsRoot)
if (tsPrune.removed.length > 0) {
  console.log(
    '✅ Trimmed staged typescript: removed %d paths → %dMB (kept for typecheck fallback)',
    tsPrune.removed.length,
    dirSizeMb(tsRoot),
  )
}

console.log(
  '✅ Staged %d runtime packages (%dMB, keep=%s, skippedForeign=%d) → dist/node_modules',
  copied,
  dirSizeMb(destModules),
  keepArch,
  skippedForeign,
)

// ── @ast-grep/lang-* 多架构 prebuilds 裁剪 ─────────────────────────────────
// lang-python/json 等包自带 5 份 prebuild（Linux/macOS/Windows × arch），目标平台
// 只加载其中一份。残留的异架构 .so 在 macOS/Windows 包里是纯体积浪费，在 Linux
// AppImage 打包时更会让 linuxdeploy 对 ARM64 二进制跑 ldd 直接崩（Failed to run
// ldd: exited with code 1，2026-09-03 CI 三轮实证）。
const AST_GREP_PREBUILD_KEEP = {
  'linux:x64': 'prebuild-Linux-X64',
  'linux:arm64': 'prebuild-Linux-ARM64',
  'darwin:arm64': 'prebuild-macOS-ARM64',
  'darwin:x64': 'prebuild-macOS-X64',
  'win32:x64': 'prebuild-Windows-X64',
}

function resolveTargetOS() {
  const triple = (process.env.TAURI_ENV_TARGET_TRIPLE || '').trim()
  if (triple) {
    if (triple.includes('linux')) return 'linux'
    if (triple.includes('darwin')) return 'darwin'
    if (triple.includes('windows')) return 'win32'
  }
  return process.platform
}

function pruneAstGrepLangPrebuilds() {
  const keep = AST_GREP_PREBUILD_KEEP[`${resolveTargetOS()}:${keepArch}`]
  const removed = []
  const langRoot = join(destModules, '@ast-grep')
  if (!existsSync(langRoot)) return { removed }
  for (const dir of readdirSync(langRoot)) {
    if (!dir.startsWith('lang-')) continue
    const prebuilds = join(langRoot, dir, 'prebuilds')
    if (!existsSync(prebuilds)) continue
    for (const variant of readdirSync(prebuilds)) {
      if (variant === keep) continue
      rmSync(join(prebuilds, variant), { recursive: true, force: true })
      removed.push(`${dir}/${variant}`)
    }
  }
  return { removed }
}

const prebuildPrune = pruneAstGrepLangPrebuilds()
if (prebuildPrune.removed.length > 0) {
  console.log(
    '✅ Pruned ast-grep lang prebuilds (keep=%s): removed %d variant(s) → %dMB',
    AST_GREP_PREBUILD_KEEP[`${resolveTargetOS()}:${keepArch}`],
    prebuildPrune.removed.length,
    dirSizeMb(join(destModules, '@ast-grep')),
  )
}

// ── better-sqlite3: lean JS wrapper + zero-degrade load assertion ──
writeStagingMarker(join(repoRoot, 'dist'), 'better-sqlite3 wrapper + native load assertion')
stageBetterSqlite3Wrapper()

// Reached only when every stage above succeeded — each failure path exits(1)
// with the marker still on disk.
clearStagingMarker(join(repoRoot, 'dist'))

function stageBetterSqlite3Wrapper() {
  const src = pkgDir('better-sqlite3')
  if (!src) {
    console.error('✗ stage-runtime-deps: better-sqlite3 not found in node_modules — cannot stage wrapper')
    process.exit(1)
  }
  const dest = join(destModules, 'better-sqlite3')
  mkdirSync(dest, { recursive: true })
  // Only the pure-JS wrapper: lib/ + package.json (main → lib/index.js).
  // Deliberately NOT copying build/Release, bindings, prebuild-install — the
  // native binary is loaded via nativeBinding from dist/native/.
  cpSync(join(src, 'lib'), join(dest, 'lib'), { recursive: true, dereference: true })
  cpSync(join(src, 'package.json'), join(dest, 'package.json'))
  console.log('✅ Staged better-sqlite3 JS wrapper (lib + package.json, %dKB) → dist/node_modules/better-sqlite3', Math.round(dirSizeMb(dest) * 1024) || 1)

  if (process.env.STAGE_SKIP_SQLITE_CHECK === '1') {
    console.warn('⚠ STAGE_SKIP_SQLITE_CHECK=1 — skipping better-sqlite3 zero-degrade assertion')
    return
  }
  const nodeBin = join(repoRoot, 'dist', 'native', 'better_sqlite3.node')
  if (!existsSync(nodeBin)) {
    console.error('✗ stage-runtime-deps: %s missing — run pack-native.js before stage-runtime-deps', nodeBin)
    process.exit(1)
  }
  // 跨架构构建：宿主进程无法 require 目标架构 .node。改为 Mach-O 架构校验
  // （fail-closed），round-trip 断言留给同架构宿主。
  const targetArch = resolveTargetArch()
  if (targetArch !== process.arch) {
    const a = machoArch(nodeBin)
    if (a && a !== targetArch) {
      console.error(
        `✗ stage-runtime-deps: 跨架构 better_sqlite3.node 架构不符 — 期望 ${targetArch}，实际 ${a}。`,
      )
      process.exit(1)
    }
    console.log(
      `✅ stage-runtime-deps: 跨架构 better_sqlite3.node 架构=${a || '?'} 匹配目标 ${targetArch} ` +
        '（无法宿主 require，ABI 信任 pack-native 的 --target）',
    )
    return
  }
  // The staged wrapper + packed .node MUST load and round-trip. A failure means
  // the bundle would silently fall back to NullDatabase at runtime — refuse to
  // ship a silently-degrading product (escape hatch: STAGE_SKIP_SQLITE_CHECK=1).
  try {
    const require = createRequire(import.meta.url)
    const Database = require(dest)
    const db = new Database(':memory:', { nativeBinding: nodeBin })
    db.exec('CREATE TABLE __probe (x)')
    db.prepare('INSERT INTO __probe VALUES (?)').run(1)
    const n = db.prepare('SELECT COUNT(*) AS c FROM __probe').get().c
    db.close()
    if (n !== 1) throw new Error(`roundtrip mismatch: expected 1, got ${n}`)
    console.log('✅ stage-runtime-deps: better-sqlite3 wrapper + native load assertion passed (zero-degrade)')
  } catch (e) {
    console.error('✗ stage-runtime-deps: better-sqlite3 wrapper failed to load with packed .node — refusing to ship a silently-degrading bundle.')
    console.error('  Reason:', e && e.message ? e.message : e)
    console.error('  Escape hatch (NOT for release): STAGE_SKIP_SQLITE_CHECK=1')
    process.exit(1)
  }
}

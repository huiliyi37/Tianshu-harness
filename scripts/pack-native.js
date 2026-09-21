#!/usr/bin/env node
/**
 * Pack better-sqlite3 native binary into dist/native/.
 * Called after `npm run build` and before `tauri:build`.
 *
 * 跨平台版（替代 pack-native.sh）：纯 Node 实现，不依赖 bash，Windows 原生
 * CMD/PowerShell 也能跑。与 desktop/scripts/fetch-node-runtime.js 同口径。
 *
 * Idempotent: safe to run multiple times. Skips silently (exit 0) if
 * better-sqlite3 is not installed — the nullDb fallback handles it.
 *
 * ── 构建期 ABI 断言（防「静默丢持久化」）────────────────────────────────
 * dist/native/ 的二进制 **只被桌面 sidecar 加载**（npm 发布的 CLI 把 dist/native
 * 排除在 files 外，靠用户安装时 npm rebuild 自己的 better-sqlite3）。桌面 sidecar
 * 跑的是 fetch-node-runtime.js 打包进去的固定 Node（默认 24.18.0 → ABI 137），
 * **不是**构建机的 Node。若构建机在 Node 24（ABI 137）下打包，二进制 ABI 与运行时
 * 不匹配 → 加载失败 → 退化成 nullDb → 跨会话知识/claims/registry 全部静默失能。
 *
 * 这里在打包后强制校验「二进制 ABI == 目标运行时 ABI」，不匹配 fail-closed，
 * 把「发到用户手里才发现」提前到构建期硬失败。目标 Node 版本与 fetch-node-runtime
 * 同源：优先 env NODE_VERSION，否则默认 DEFAULT_TARGET_NODE_VERSION。
 * 逃生舱：PACK_NATIVE_SKIP_ABI_CHECK=1 跳过（仅限明确知道自己在干什么的场景）。
 */

import { existsSync, mkdirSync, copyFileSync, statSync, openSync, readSync, closeSync, rmSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
// 脚本在 scripts/，仓库根在上一级
const repoRoot = join(__dirname, '..')

const SOURCE = join(repoRoot, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
const TARGET_DIR = join(repoRoot, 'dist', 'native')
const TARGET = join(TARGET_DIR, 'better_sqlite3.node')

// 目标运行时版本与 desktop/scripts/fetch-node-runtime.js 单一同源：直接 import 其
// DEFAULT_NODE_VERSION，杜绝两处常量漂移（漂移会让本断言失去意义）。import 失败
// （脚本被移动/单独取用）时退回硬编码兜底，并打一行提示。
let DEFAULT_TARGET_NODE_VERSION = '24.18.0'
try {
  const mod = await import('../desktop/scripts/fetch-node-runtime.js')
  if (mod && typeof mod.DEFAULT_NODE_VERSION === 'string') {
    DEFAULT_TARGET_NODE_VERSION = mod.DEFAULT_NODE_VERSION
  }
} catch {
  console.warn('⚠ pack-native: 无法从 fetch-node-runtime.js 读取 DEFAULT_NODE_VERSION，使用兜底 %s', DEFAULT_TARGET_NODE_VERSION)
}

// NODE_MODULE_VERSION（ABI）↔ Node 主版本映射。仅在「打包机 Node 主版本 ≠ 目标
// 主版本」时才需要查表；同主版本直接用 process.versions.modules，免维护。
const ABI_BY_MAJOR = {
  18: 108,
  19: 111,
  20: 115,
  21: 120,
  22: 127,
  23: 131,
  24: 137,
  // 新增主版本请在此补 NODE_MODULE_VERSION（来源 https://nodejs.org/api/process.html
  // #processversionsmodules 或目标 Node 的 `node -p process.versions.modules`）。
  // 未登记的主版本会被 resolveTargetAbi 判为 null → fail-closed 报错提示补表，
  // 绝不臆测放行。
}

const currentMajor = Number(process.versions.node.split('.')[0])
const currentAbi = Number(process.versions.modules)

/** 目标运行时（桌面 sidecar 的 bundled Node）的主版本。 */
function resolveTargetNodeVersion() {
  return process.env.NODE_VERSION || DEFAULT_TARGET_NODE_VERSION
}

/** 目标运行时 ABI；同主版本走精确值（process.versions.modules），跨版本查表。 */
function resolveTargetAbi(targetMajor) {
  if (targetMajor === currentMajor) return currentAbi
  return ABI_BY_MAJOR[targetMajor] ?? null
}

/**
 * 探测一个 .node 原生模块的 ABI。
 * - require 成功 → 二进制 ABI 与当前进程一致，返回 currentAbi。
 * - require 失败且是 NODE_MODULE_VERSION 不匹配 → 错误串里第一个数字就是二进制 ABI。
 * - 其他加载失败（缺依赖/架构不符等）→ 返回 { abi: null, error }，原样上报。
 */
function detectBinaryAbi(binaryPath) {
  try {
    createRequire(import.meta.url)(binaryPath)
    return { abi: currentAbi, loaded: true }
  } catch (err) {
    const msg = String((err && err.message) || err)
    // "...was compiled against a different Node.js version using
    //  NODE_MODULE_VERSION 127. This version of Node.js requires
    //  NODE_MODULE_VERSION 137."
    // 第一个数字 = 二进制编译时的 ABI；第二个 = 当前进程要求的 ABI。
    const m = /NODE_MODULE_VERSION (\d+)/.exec(msg)
    if (m) return { abi: Number(m[1]), loaded: false }
    return { abi: null, loaded: false, error: msg }
  }
}

function assertAbi() {
  if (process.env.PACK_NATIVE_SKIP_ABI_CHECK === '1') {
    console.warn('⚠ pack-native: PACK_NATIVE_SKIP_ABI_CHECK=1 — 跳过 ABI 断言（自担风险）')
    return
  }

  const targetVersion = resolveTargetNodeVersion()
  const targetMajor = Number(targetVersion.split('.')[0])
  const targetAbi = resolveTargetAbi(targetMajor)

  const { abi: binaryAbi, error } = detectBinaryAbi(TARGET)

  if (binaryAbi === null) {
    console.error(
      '❌ pack-native: 无法探测 better_sqlite3.node 的 ABI（非 NODE_MODULE_VERSION 类错误）。\n' +
      `   加载错误: ${error}\n` +
      '   多半是架构不符或依赖缺失。请重新安装/重编 better-sqlite3 后再打包。',
    )
    process.exit(1)
  }

  if (targetAbi === null) {
    console.error(
      `❌ pack-native: 未知的目标 Node 主版本 v${targetMajor}（NODE_VERSION=${targetVersion}）。\n` +
      `   无法核对 ABI。请在 scripts/pack-native.js 的 ABI_BY_MAJOR 中补上 v${targetMajor} 的 NODE_MODULE_VERSION，\n` +
      '   或用 PACK_NATIVE_SKIP_ABI_CHECK=1 显式跳过。',
    )
    process.exit(1)
  }

  if (binaryAbi !== targetAbi) {
    console.error(
      '❌ pack-native: ABI 不匹配 —— 打包的 better_sqlite3.node 会在桌面 sidecar 里加载失败，\n' +
      '   静默退化成 nullDb（跨会话知识/claims/registry 全部失能，且只打一行 warning）。\n' +
      `     二进制 ABI (NODE_MODULE_VERSION): ${binaryAbi}\n` +
      `     目标运行时 ABI: ${targetAbi}  (Node v${targetVersion}, 来自 ${process.env.NODE_VERSION ? 'env NODE_VERSION' : 'DEFAULT_TARGET_NODE_VERSION'})\n` +
      `     当前打包机 Node: v${process.versions.node} (ABI ${currentAbi})\n` +
      '   修复方式（任选其一）：\n' +
      `     · 用目标 Node v${targetVersion} 运行 \`npm rebuild better-sqlite3\` 后重新打包；\n` +
      '     · 若要把桌面运行时一并升到新版本，改 fetch-node-runtime.js 的\n' +
      '       DEFAULT_NODE_VERSION 即可（本脚本 import 同源），并核对 ABI_BY_MAJOR 有该版本；\n' +
      '     · 临时绕过：PACK_NATIVE_SKIP_ABI_CHECK=1（不推荐，会把风险带进产物）。',
    )
    process.exit(1)
  }

  console.log(
    `✅ pack-native: ABI 校验通过 — 二进制/目标运行时同为 NODE_MODULE_VERSION ${binaryAbi} (Node v${targetVersion})`,
  )
}

// ── 跨架构打包（Apple Silicon 上打 Intel 包，反之亦然）────────────────────
// 宿主机 npm install 出来的 better-sqlite3 只有宿主架构（M1 上是 arm64）。直接
// 把它塞进 x86_64 包 → Intel 机器上 sidecar(x64 node) 加载 arm64 .node 失败 →
// 退化 nullDb（跨会话知识/claims/registry 静默失能）。这正是「前面打的 Intel 包
// 有问题」的根因。修法：目标架构 ≠ 宿主架构时，用 prebuild-install 拉目标架构对应
// 目标 Node 版本(ABI)的预编译 .node，直接落到 dist/native。
const HOST_ARCH = process.arch // 'arm64' | 'x64' | …

/** 从 Tauri 目标三元组解析目标架构；无则退回宿主。 */
function resolveTargetArch() {
  const triple = (process.env.TAURI_ENV_TARGET_TRIPLE || '').trim()
  if (triple) {
    const tok = triple.split('-')[0]
    if (tok === 'aarch64' || tok === 'arm64') return 'arm64'
    if (tok === 'x86_64') return 'x64'
    if (tok === 'i686') return 'x86'
  }
  return HOST_ARCH
}

/** 目标平台的 Node process.platform token（prebuild-install --platform 用）。 */
function resolveTargetPlatform() {
  const triple = process.env.TAURI_ENV_TARGET_TRIPLE || ''
  if (triple.includes('windows')) return 'win32'
  if (triple.includes('darwin')) return 'darwin'
  if (triple.includes('linux')) return 'linux'
  return process.platform
}

// Mach-O CPU 类型常量。用于跨架构打包后校验产物确实是目标架构，
// 而不是（跨架构无法 require 探测 ABI 时）盲信 prebuild-install。
const CPU_TYPE_X86_64 = 0x01000007
const CPU_TYPE_ARM64 = 0x0100000c

/** 读一个 thin Mach-O 64 的 cputype → 'x64' | 'arm64' | null（无法判定）。 */
function machoArch(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(8)
    if (readSync(fd, buf, 0, 8, 0) < 8) return null
    // 磁盘上 mac thin .node 是小端：magic MH_MAGIC_64 = 0xFEEDFACF。
    const magicLE = buf.readUInt32LE(0)
    if (magicLE !== 0xfeedfacf) return null // fat/universal 或非 macho64 → 不判定
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

/**
 * 跨架构：用 prebuild-install 拉目标架构的 better-sqlite3 预编译二进制。
 * prebuild-install 装到 <pkg>/build/Release，会覆盖宿主架构二进制，所以先备份、
 * 拷贝到 dist/native 后再还原，保证宿主的 node_modules 不被污染（dev/CLI/后续
 * 宿主构建仍用宿主架构）。
 */
function crossPackNative(targetArch, targetPlatform) {
  const targetNodeVersion = resolveTargetNodeVersion()
  const pkgDir = join(repoRoot, 'node_modules', 'better-sqlite3')
  const buildRel = join(pkgDir, 'build', 'Release', 'better_sqlite3.node')
  // ⚠ 不能在 Windows 上无 shell 地 spawn .cmd：Node 修 CVE-2024-27980 之后，
  // execFileSync('...\.bin\prebuild-install.cmd', ...) 直接抛 EINVAL（2026-09-18 实测
  // 复现；同源缺陷亦见于 desktop/scripts/sign-runtime-integrity.js 的 tsx.cmd）。
  // 本机因原生二进制已缓存、未走到本分支而潜伏——干净构建机必踩。
  // 改为「当前 node 解释器 + 包的 JS 入口」，跨平台一致。
  const piPkgDir = join(repoRoot, 'node_modules', 'prebuild-install')
  let piBin = join(piPkgDir, 'bin.js')
  try {
    const piPkg = JSON.parse(readFileSync(join(piPkgDir, 'package.json'), 'utf8'))
    const rel = typeof piPkg.bin === 'string' ? piPkg.bin : piPkg.bin?.['prebuild-install']
    if (rel) piBin = join(piPkgDir, rel)
  } catch {
    // 读不到 package.json 时退回默认入口（prebuild-install 的 bin 为 bin.js）
  }

  if (!existsSync(piBin)) {
    console.error(
      `❌ pack-native: 跨架构打包需要 prebuild-install，但未找到 ${piBin}。\n` +
        '   请确认 better-sqlite3 依赖已完整安装（它带 prebuild-install）。',
    )
    process.exit(1)
  }

  const backup = existsSync(buildRel) ? `${buildRel}.hostbak` : null
  if (backup) copyFileSync(buildRel, backup)
  try {
    console.log(
      `[pack-native] 跨架构：prebuild-install --arch ${targetArch} --platform ${targetPlatform} --target ${targetNodeVersion}`,
    )
    execFileSync(
      process.execPath,
      [piBin, '--arch', targetArch, '--platform', targetPlatform, '--target', targetNodeVersion, '--runtime', 'node'],
      { cwd: pkgDir, stdio: 'inherit' },
    )
    if (!existsSync(buildRel)) {
      throw new Error('prebuild-install 未产出 better_sqlite3.node（可能该架构/版本无预编译包）')
    }
    copyFileSync(buildRel, TARGET)
  } finally {
    // 还原宿主架构二进制，绝不把跨架构产物留在 node_modules。
    if (backup) {
      copyFileSync(backup, buildRel)
      rmSync(backup, { force: true })
    }
  }

  // 架构校验（fail-closed）：磁盘产物必须确实是目标架构。ABI 正确性由
  // prebuild-install --target <目标 Node 版本> 保证（跨架构无法 require 探测）。
  const producedArch = machoArch(TARGET)
  if (producedArch && producedArch !== targetArch) {
    console.error(
      `❌ pack-native: 跨架构产物架构不符 —— 期望 ${targetArch}，实际 ${producedArch}。拒绝打入包中。`,
    )
    process.exit(1)
  }
  const sizeKb = Math.round(statSync(TARGET).size / 1024)
  console.log(
    `✅ pack-native: 跨架构打包完成 — better_sqlite3.node (${sizeKb}KB, ${producedArch || 'arch?'}) ` +
      `for Node v${targetNodeVersion} → ${TARGET}`,
  )
}

if (!existsSync(SOURCE)) {
  console.error('⚠ pack-native: better-sqlite3 native binary not found at %s — skipping', SOURCE)
  process.exit(0)
}

mkdirSync(TARGET_DIR, { recursive: true })

const TARGET_ARCH = resolveTargetArch()
if (TARGET_ARCH === HOST_ARCH) {
  // 同架构：直接拷宿主 node_modules 的二进制，走 require 探测式 ABI 断言。
  copyFileSync(SOURCE, TARGET)
  const sizeKb = Math.round(statSync(TARGET).size / 1024)
  console.log('✅ Packed better_sqlite3.node (%dKB) → %s', sizeKb, TARGET)
  assertAbi()
} else {
  console.log(`[pack-native] 目标架构 ${TARGET_ARCH} ≠ 宿主架构 ${HOST_ARCH} — 走跨架构拉取路径`)
  crossPackNative(TARGET_ARCH, resolveTargetPlatform())
}

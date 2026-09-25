#!/usr/bin/env node
/**
 * 从国内镜像下载 better-sqlite3 预编译原生二进制（postinstall 调用）。
 *
 * 背景：better-sqlite3 是 optionalDependency，其 prebuild-install 从 GitHub
 * Releases 拉取预编译 .node 文件。中国大陆用户常因 GitHub 不可达导致下载失败，
 * 又缺少编译工具链做 fallback 源码编译 → 静默跳过 → 运行时退化为纯内存模式。
 *
 * 本脚本在 postinstall 时运行，穷尽安装链后才降级（不能随便降级到内存模式）：
 *   1. better-sqlite3 已通过 npm 正常编译安装 → 拷贝到 dist/native/（零开销）
 *   2. 四路预编译镜像（npmmirror registry / npmmirror CDN 直连 / kkgithub /
 *      GitHub 直连）逐个尝试拉取预编译 .tar.gz
 *   3. 镜像全败 → npm install better-sqlite3 --no-save 源码编译兜底（走用户
 *      自己的 registry 配置；有编译工具链的机器此时仍能装上；启动自愈以
 *      RIVET_FETCH_SKIP_COMPILE=1 调用时跳过本段——编译数分钟，留给
 *      postinstall/手动重跑，启动路径只做分钟内下载自愈）
 *   4. 全部失败 → 落 .fetch-failed 标记 + 可操作提示，不阻断安装（optional 语义保留）
 *
 * 与 pack-native.js 的分工：
 *   pack-native.js — 桌面 sidecar 打包期，走 prebuild-install 确保 ABI 匹配
 *   fetch-native-sqlite.js — CLI 用户 postinstall，从镜像快速拉取
 */

import { createWriteStream, existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { mkdir, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { get } from 'node:https'
import { createGunzip } from 'node:zlib'
import { execSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')

// ── 平台/架构/ABI ──────────────────────────────────────────────────
const PLATFORM = process.platform
const ARCH = process.arch
const ABI = process.versions.modules

const PLATFORM_TOKEN = { win32: 'win32', darwin: 'darwin', linux: 'linux' }[PLATFORM]
const ARCH_TOKEN = { x64: 'x64', arm64: 'arm64', ia32: 'ia32' }[ARCH] ?? ARCH

if (!PLATFORM_TOKEN) {
  console.warn(`[fetch-native-sqlite] unsupported platform: ${PLATFORM}, skipping`)
  process.exit(0)
}

// ── better-sqlite3 版本 ────────────────────────────────────────────
// 兼容 optionalDependencies 与 dependencies 两种声明位置——避免将来挪动
// 依赖段时兜底链静默失效（原本只读 optionalDependencies）。
const req = createRequire(import.meta.url)
let version
try {
  const pkg = req('../package.json')
  const raw = pkg.optionalDependencies?.['better-sqlite3'] ?? pkg.dependencies?.['better-sqlite3']
  if (!raw) {
    console.log('[fetch-native-sqlite] better-sqlite3 not found in dependencies/optionalDependencies, skipping')
    process.exit(0)
  }
  version = raw.replace(/^[\^~]/, '')
} catch {
  console.log('[fetch-native-sqlite] cannot read package.json, skipping')
  process.exit(0)
}

// ── 目标路径 ────────────────────────────────────────────────────────
const TARGET_DIR = join(repoRoot, 'dist', 'native')
const TARGET = join(TARGET_DIR, 'better_sqlite3.node')
const FAILED_MARKER = join(TARGET_DIR, '.fetch-failed')
const NODE_MODULES_NATIVE = join(
  repoRoot, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node',
)

/**
 * 失败标记（native-resolver 启动自愈消费）：
 *   写入——下载链全部失败时落 dist/native/.fetch-failed（{ ts, error }），
 *         启动自愈见 5 分钟内的新鲜标记即跳过重试，不再每次启动白等下载超时；
 *   清除——所有成功路径（已有产物/复用 node_modules/下载成功）都清掉陈旧标记。
 * 静默失败从此有痕迹：用户与自愈逻辑都能看到「上次什么时候、败在哪一步」。
 */
function clearFailedMarker() {
  try {
    if (existsSync(FAILED_MARKER)) rmSync(FAILED_MARKER, { force: true })
  } catch { /* 标记清理失败不影响主流程 */ }
}

function writeFailedMarker(lastError) {
  try {
    mkdirSync(TARGET_DIR, { recursive: true })
    writeFileSync(FAILED_MARKER, JSON.stringify({ ts: Date.now(), error: String(lastError).slice(0, 500) }, null, 2) + '\n')
  } catch { /* 写不了标记也不阻断——提示文案已在 stdout/stderr */ }
}

const TARBALL = `better-sqlite3-v${version}-node-v${ABI}-${PLATFORM_TOKEN}-${ARCH_TOKEN}.tar.gz`

// ── 完整性钉扎（供应链防线）────────────────────────────────────────────
// 官方 release tarball 的 SHA-256（v12.10.0；ABI 127=node22、137=node24）。
// 来源：github.com 直连下载计算，npmmirror 双源交叉验证一致。
// 升级 better-sqlite3 版本时须重新生成本表（sha256sum 各平台 tarball），
// 否则新版本走「无钉扎」策略（见 verifyTarball）——kkgithub 镜像将拒绝服务。
const SHA256_PINNED = {
  'better-sqlite3-v12.10.0-node-v127-darwin-arm64.tar.gz': '35533f9ada82cb3f33760c1dc2f128f77c2b34ec2b2ede722824cb64cd50a46a',
  'better-sqlite3-v12.10.0-node-v127-darwin-x64.tar.gz': '8d2ef0eb7f880f88882f0a7a7362a15e2d210a077681f0672d0dfc8b919bd91b',
  'better-sqlite3-v12.10.0-node-v127-linux-arm64.tar.gz': 'efb625877ea517be6003c14dbabdb748d0ac172ab50bc4e5af08c2cb272b70c6',
  'better-sqlite3-v12.10.0-node-v127-linux-x64.tar.gz': '899dcec7d0e4e2ec35db783a9155b878ae15754512585de7352bbd33cb1d6c48',
  'better-sqlite3-v12.10.0-node-v127-win32-arm64.tar.gz': '81ab2327e76e8cc6290a08528d41f19b913d4c5146bfd12c159970fa59559d48',
  'better-sqlite3-v12.10.0-node-v127-win32-x64.tar.gz': '86a12ba6f19ecf1e4db4effaf5918e716d4d4fb60b0316e18d95d569ba62d6bc',
  'better-sqlite3-v12.10.0-node-v137-darwin-arm64.tar.gz': 'b140983c8befcef30532ea615aa106c770f2f95cd20994d31ca593c0b4e85423',
  'better-sqlite3-v12.10.0-node-v137-darwin-x64.tar.gz': 'a02f8e9c2024f2bd4386e58671524fcf722c5187b549f46a955d8e9c3b22f733',
  'better-sqlite3-v12.10.0-node-v137-linux-arm64.tar.gz': '7648f3a8295cf03a036eb392b66fbef75347662d654f6ab558f5f33c9e47d69a',
  'better-sqlite3-v12.10.0-node-v137-linux-x64.tar.gz': 'c2f7503e6cc3a2b1dc9fd03e7194934438f42e0724ecac6696da0582585362f2',
  'better-sqlite3-v12.10.0-node-v137-win32-arm64.tar.gz': '406e45058184a8f2d2f541fa8deb06933e29bf4dc384fa069c0930dde6e75681',
  'better-sqlite3-v12.10.0-node-v137-win32-x64.tar.gz': '0f6d948e6438f64c983d08a2048ef10d6f467f36a8c08f20d31f585c019eb83c',
}

/**
 * 校验策略：
 *   有钉扎    → 所有镜像一律校验，不匹配即硬失败换下一路（被替换的镜像无法
 *               投毒——产物是加载进 agent 进程的原生代码）；
 *   无钉扎    → 仅允许既有基础设施源（npmmirror registry/CDN、github 官方），
 *               第三方代理 kkgithub 拒绝——版本升级漏更新哈希表时收窄暴露面，
 *               而不是放行全部镜像。
 */
async function verifyTarball(tmpTar, mirrorName) {
  const expected = SHA256_PINNED[TARBALL]
  if (!expected) {
    if (mirrorName === 'kkgithub') {
      throw new Error(`no SHA-256 pin for ${TARBALL} — third-party proxy rejected without pin (regenerate SHA256_PINNED on version bump)`)
    }
    console.warn(`[fetch-native-sqlite] ⚠ no SHA-256 pin for ${TARBALL} — allowing infra mirror (${mirrorName}) unverified`)
    return
  }
  const hash = createHash('sha256').update(readFileSync(tmpTar)).digest('hex')
  if (hash !== expected) {
    throw new Error(`SHA-256 mismatch for ${TARBALL} from ${mirrorName}: got ${hash}`)
  }
  console.log(`[fetch-native-sqlite] SHA-256 verified (${hash.slice(0, 12)}…)`)
}

// ── 镜像源（按优先级）────────────────────────────────────────────────
// 四路预编译 + 一路源码编译（stage 4），穷尽后才降级——不能随便降级到内存模式。
const MIRRORS = [
  {
    name: 'npmmirror',
    url: `https://registry.npmmirror.com/-/binary/better-sqlite3/v${version}/${TARBALL}`,
  },
  {
    // registry 域名故障/被墙但 CDN 可达时的直连兜底（registry 302 的最终目标）
    name: 'npmmirror-cdn',
    url: `https://cdn.npmmirror.com/binaries/better-sqlite3/v${version}/${TARBALL}`,
  },
  {
    name: 'kkgithub',
    url: `https://kkgithub.com/WiseLibs/better-sqlite3/releases/download/v${version}/${TARBALL}`,
  },
  {
    name: 'github (direct)',
    url: `https://github.com/WiseLibs/better-sqlite3/releases/download/v${version}/${TARBALL}`,
  },
]

// ── main ────────────────────────────────────────────────────────────

async function main() {
  // 1. 已有 dist/native 产物 → 跳过（顺带清陈旧失败标记——产物在，标记必过期）
  if (existsSync(TARGET)) {
    clearFailedMarker()
    console.log('[fetch-native-sqlite] native binary already present, skipping')
    process.exit(0)
  }

  // 2. node_modules 中已有编译产物 → 直接复用（npm 正常安装了）
  if (existsSync(NODE_MODULES_NATIVE)) {
    mkdirSync(TARGET_DIR, { recursive: true })
    copyFileSync(NODE_MODULES_NATIVE, TARGET)
    clearFailedMarker()
    console.log('[fetch-native-sqlite] ✓ native binary found in node_modules, copied to dist/native/')
    process.exit(0)
  }

  // 3. 从镜像下载
  mkdirSync(TARGET_DIR, { recursive: true })

  let lastError = 'unknown'
  for (const mirror of MIRRORS) {
    try {
      console.log(`[fetch-native-sqlite] trying ${mirror.name}: ${mirror.url}`)
      await downloadAndExtract(mirror.url, TARGET_DIR, mirror.name)
      clearFailedMarker()
      console.log(`[fetch-native-sqlite] ✓ downloaded from ${mirror.name}`)
      process.exit(0)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      lastError = `${mirror.name}: ${msg}`
      console.warn(`[fetch-native-sqlite] ${mirror.name} failed: ${msg}`)
    }
  }

  // 4. 预编译全败 → 源码编译兜底（本地 npm install：走用户自己的 registry 配置，
  //    prebuild-install 再试一轮 GitHub，失败则 node-gyp 编译——有编译工具链的
  //    机器此时能装上；npm 整体不可达则快速失败）。启动自愈（native-resolver）
  //    以 RIVET_FETCH_SKIP_COMPILE=1 调本脚本时跳过——编译动辄数分钟，启动路径
  //    只做分钟内的下载自愈，编译兜底留给 postinstall/手动重跑。
  if (!process.env.RIVET_FETCH_SKIP_COMPILE) {
    try {
      console.log('[fetch-native-sqlite] mirrors exhausted, trying source build via npm install …')
      execSync(`npm install better-sqlite3@${version} --no-save --no-audit --no-fund`, {
        cwd: repoRoot,
        stdio: 'pipe',
        timeout: 10 * 60_000, // 源码编译 2-5 分钟常见，给足
        windowsHide: true,
      })
      if (existsSync(NODE_MODULES_NATIVE)) {
        mkdirSync(TARGET_DIR, { recursive: true })
        copyFileSync(NODE_MODULES_NATIVE, TARGET)
        clearFailedMarker()
        console.log('[fetch-native-sqlite] ✓ source build succeeded, copied to dist/native/')
        process.exit(0)
      }
      lastError = 'npm install: no binary produced'
    } catch (err) {
      lastError = `npm install: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400)
      console.warn(`[fetch-native-sqlite] source build failed: ${lastError}`)
    }
  }

  // 5. 全部失败 → 落失败标记（启动自愈 5 分钟内不再重试）+ 可操作提示
  writeFailedMarker(lastError)
  console.warn('')
  console.warn('⚠ [fetch-native-sqlite] All mirrors failed. better-sqlite3 not available.')
  console.warn('  Session history & cross-session memory will run in memory-only mode.')
  console.warn('')
  // Fix 指引修正（2026-08-17）：旧的 windows-build-tools（npm 包已废弃多年）+
  // `npm rebuild better-sqlite3 -g tianshu-harness`（rebuild 不到全局安装包里的
  // optional dep，语法本身也不通）全部换成本仓库自带的预编译拉取脚本——
  // 无需任何编译工具链，网络恢复后在安装目录重跑一次即可。
  console.warn('  Fix: 网络恢复后在安装目录重跑本脚本（含预编译四镜像 + 源码编译兜底）:')
  console.warn('    npm root -g                 # 找到全局 node_modules 路径')
  if (PLATFORM === 'win32') {
    console.warn('    cd <该路径>\\tianshu-harness && node scripts\\fetch-native-sqlite.js')
  } else {
    console.warn('    cd <该路径>/tianshu-harness && node scripts/fetch-native-sqlite.js')
  }
  process.exit(0)
}

// ── downloadAndExtract ──────────────────────────────────────────────

/**
 * 下载 better-sqlite3 .tar.gz 预编译包，解压出 .node 文件到 destDir。
 * 实测镜像 tarball 内部结构（npm 镜像源的 prebuild）：
 *   build/
 *     Release/
 *       better_sqlite3.node   ← 我们需要的（仅 2 层目录，strip-components=2）
 * 注意：原代码假设是 package/build/Release/...（3 层）用了 strip=3，实际镜像
 * tarball 是 2 层，strip 3 会剥光路径报 "Not found in archive"。
 */
async function downloadAndExtract(url, destDir, mirrorName) {
  const tmpTar = join(tmpdir(), `better-sqlite3-${mirrorName}-${Date.now()}.tar.gz`)

  try {
    await downloadFile(url, tmpTar)
    await verifyTarball(tmpTar, mirrorName)
    await extractNodeBinary(tmpTar, destDir)
  } finally {
    try { await unlink(tmpTar) } catch { /* ignore */ }
  }
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const timeout = 30_000
    // 延迟创建文件流：只在确认是最终 200 响应时才 open 目标文件。
    // 否则重定向链（npmmirror registry → cdn.npmmirror.com 实测 302）会反复
    // close()/createWriteStream() 同一路径，Windows 文件锁语义下偶发 EBUSY。
    let file = null

    const req = get(url, { timeout }, (res) => {
      // 处理重定向：未写任何字节，直接递归跟新 URL
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // 释放本次响应体，避免 socket 泄漏
        res.resume()
        downloadFile(res.headers.location, dest).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      // 最终响应——此时才创建目标文件流
      file = createWriteStream(dest)
      pipeline(res, file).then(resolve, reject)
    })

    req.on('error', (err) => {
      if (file) file.close()
      reject(err)
    })
    req.on('timeout', () => {
      req.destroy()
      if (file) file.close()
      reject(new Error('download timeout'))
    })
  })
}

async function extractNodeBinary(tarPath, destDir) {
  // 用系统 tar 命令解压。镜像 tarball 结构为 build/Release/better_sqlite3.node
  // （2 层目录），strip-components=2 剥到文件名本身。Windows 上 bsdtar（Win10+ 自带）
  // 同样支持该标志；旧版不支持时进 catch 走纯 Node 解压 fallback。
  const cmd = process.platform === 'win32'
    ? `tar -xzf "${tarPath}" -C "${destDir}" --strip-components=2 --wildcards "*/better_sqlite3.node"`
    : `tar -xzf "${tarPath}" -C "${destDir}" --strip-components=2 "*/better_sqlite3.node"`

  try {
    execSync(cmd, { stdio: 'pipe', timeout: 30_000, windowsHide: true })
  } catch {
    // tar 可能不支持 --strip-components（Windows 旧版），用 Node 手动解压
    await extractWithNode(tarPath, destDir)
  }

  if (!existsSync(join(destDir, 'better_sqlite3.node'))) {
    throw new Error('better_sqlite3.node not found in tarball after extraction')
  }
}

async function extractWithNode(tarPath, destDir) {
  // 纯 Node 解压：读取 .tar.gz，在 tar 流中找 better_sqlite3.node
  const zlib = await import('node:zlib')
  const { createReadStream } = await import('node:fs')
  const { Transform } = await import('node:stream')

  return new Promise((resolve, reject) => {
    const gunzip = zlib.createGunzip()
    let buffer = Buffer.alloc(0)
    let found = false

    const parser = new Transform({
      transform(chunk, _encoding, callback) {
        buffer = Buffer.concat([buffer, chunk])
        // Tar 格式：512 字节 header + 数据块
        while (buffer.length >= 512 && !found) {
          const name = buffer.toString('utf8', 0, 100).replace(/\0/g, '')
          const sizeStr = buffer.toString('utf8', 124, 136).replace(/\0/g, '').trim()
          const size = parseInt(sizeStr, 8) || 0

          if (name.endsWith('better_sqlite3.node')) {
            const dataStart = Math.ceil(512 / 512) * 512 // next 512-aligned
            const dataEnd = dataStart + size
            if (buffer.length >= dataEnd) {
              const fileData = buffer.subarray(dataStart, dataEnd)
              const dest = join(destDir, 'better_sqlite3.node')
              // 原 require('node:fs') 在 ESM 模块下会抛 "require is not defined"
              // ——Windows 上 tar 不支持 --strip-components 进此分支必崩。改用顶部 import。
              writeFileSync(dest, fileData)
              found = true
              resolve()
              return
            }
            // Need more data
            break
          }

          // Skip this entry
          const totalLen = 512 + Math.ceil(size / 512) * 512
          if (buffer.length >= totalLen) {
            buffer = buffer.subarray(totalLen)
          } else {
            break // need more data
          }
        }
        callback()
      },
      flush(callback) {
        if (!found) reject(new Error('better_sqlite3.node not found in tar stream'))
        callback()
      },
    })

    createReadStream(tarPath)
      .pipe(gunzip)
      .pipe(parser)
      .on('error', reject)
  })
}

main()

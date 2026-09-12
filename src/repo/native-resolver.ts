import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

/**
 * How far up to look for the packed `native/` dir.
 *
 * Deepest real caller is `dist/<area>/<sub>/*.js` (3 hops to `dist`); 5 leaves
 * room without wandering far enough to hit an unrelated `native/` outside the
 * install root.
 */
const MAX_NATIVE_LOOKUP_DEPTH = 5

/** 失败标记的新鲜窗口：窗口内启动自愈跳过重试，不白等下载超时。 */
const FETCH_FAILURE_FRESH_MS = 5 * 60 * 1000

/** 自愈脚本单次下载的最长等待（3 镜像 × 30s 下载 + 解压余量）。 */
const FETCH_SCRIPT_TIMEOUT_MS = 150_000

/** 每个安装根只自愈一次/进程——多调用方（registry/meridian/claims…）共享一次尝试。 */
const healAttemptedRoots = new Set<string>()

/** First `native/better_sqlite3.node` at or above `startDir`, else null. */
function findPackedNative(startDir: string): string | null {
  let dir = startDir
  for (let depth = 0; depth <= MAX_NATIVE_LOOKUP_DEPTH; depth++) {
    const candidate = join(dir, 'native', 'better_sqlite3.node')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break // filesystem root
    dir = parent
  }
  return null
}

/** First dir at or above `startDir` containing `scripts/fetch-native-sqlite.js`, else null. */
function findFetchScriptRoot(startDir: string): string | null {
  let dir = startDir
  for (let depth = 0; depth <= MAX_NATIVE_LOOKUP_DEPTH; depth++) {
    if (existsSync(join(dir, 'scripts', 'fetch-native-sqlite.js'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * `.fetch-failed` 标记（fetch-native-sqlite.js 全链失败时写入，成功路径清除）
 * 是否在新鲜窗口内。损坏/缺失/过期都返回 false（= 可以重试自愈）。
 */
export function isFetchFailureMarkerFresh(markerPath: string): boolean {
  let ts = 0
  try {
    ts = JSON.parse(readFileSync(markerPath, 'utf8')).ts ?? 0
  } catch {
    return false
  }
  if (typeof ts !== 'number' || ts <= 0) return false
  return Date.now() - ts < FETCH_FAILURE_FRESH_MS
}

/**
 * 启动自愈：原生二进制缺失时，同步跑一次 fetch-native-sqlite.js 补下载。
 *
 * 触发条件（全部满足）：
 *   - 找得到安装根（scripts/fetch-native-sqlite.js——npm 包 files 白名单内，
 *     桌面 sidecar bundle 不带 scripts/，天然不触发）；
 *   - 该安装根本进程还没试过（Set 去重）；
 *   - 失败标记不新鲜（5 分钟内刚失败过就不再白等最长 150s 的下载超时）。
 *
 * 失败不抛错：仍走调用方的降级路径（NullDatabase / 内存模式），进程不崩。
 *
 * @param moduleUrl 调用方 `import.meta.url`，用于定位安装根。
 * @returns 自愈成功时返回 `dist/native/better_sqlite3.node` 路径，否则 null。
 */
export function tryFetchNativeBinary(moduleUrl: string): string | null {
  let selfPath: string
  try {
    selfPath = fileURLToPath(moduleUrl)
  } catch {
    return null // 非 file URL（测试桩路径等）无从定位，不尝试
  }
  const root = findFetchScriptRoot(dirname(selfPath))
  if (!root || healAttemptedRoots.has(root)) return null
  healAttemptedRoots.add(root)

  const markerPath = join(root, 'dist', 'native', '.fetch-failed')
  if (isFetchFailureMarkerFresh(markerPath)) {
    process.stderr.write('[native-resolver] 上次下载失败还在 5 分钟窗口内，跳过自愈重试（网络恢复后可手动跑 scripts/fetch-native-sqlite.js）\n')
    return null
  }

  process.stderr.write('[native-resolver] 原生二进制缺失，自动补下载（最长约 150s）…\n')
  try {
    execFileSync(process.execPath, [join(root, 'scripts', 'fetch-native-sqlite.js')], {
      timeout: FETCH_SCRIPT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      // 启动自愈只走下载链（分钟内）；源码编译兜底（数分钟）留给
      // postinstall / 手动重跑，不能让每次启动卡在编译上。
      env: { ...process.env, RIVET_FETCH_SKIP_COMPILE: '1' },
      windowsHide: true,
    })
  } catch {
    // 脚本自身已落失败标记并打印指引；这里保持降级语义不崩
  }
  const healed = join(root, 'dist', 'native', 'better_sqlite3.node')
  if (existsSync(healed)) return healed
  process.stderr.write('[native-resolver] 自愈下载未成功，本次运行降级（不影响下次启动重试）\n')
  return null
}

/**
 * Resolve a usable better-sqlite3 `Database` constructor.
 *
 * Two distinct runtimes:
 *
 *   1. Packaged sidecar (Tauri bundle): there is no full `node_modules`. We ship
 *      the pure-JS wrapper at `dist/node_modules/better-sqlite3` (staged by
 *      stage-runtime-deps.js) and the native binary at `dist/native/
 *      better_sqlite3.node` (packed by pack-native.js). The wrapper is loaded
 *      and bound to that binary via better-sqlite3's `nativeBinding` option.
 *
 *      The probe walks UP from the caller's directory. `dist` is a tsc tree, not
 *      a single-file bundle, so callers live in `dist/repo/`, `dist/agent/` etc.
 *      while `native/` sits at the `dist` root — a same-directory probe only ever
 *      matched `dist/main.js` and silently missed every real caller.
 *
 *      ⚠ Loading the raw `.node` directly does NOT work: it exports the internal
 *      addon object ({ Database, Statement, ... } with C++ signatures), not the
 *      JS `Database` class whose `prepare()/pragma()/transaction()` the app uses.
 *      The wrapper is mandatory.
 *
 *      In this runtime sqlite is REQUIRED. If `native/better_sqlite3.node` is
 *      present but the wrapper can't load, that's a packaging bug — we throw
 *      (code `ESQLITE_BUNDLE_BROKEN`) rather than silently degrade to a no-op DB.
 *
 *   2. Dev / CLI (`node_modules` available): resolve the full package normally.
 *
 *   3. npm 全局安装且原生件缺失（postinstall 下载链全败的机器）：启动自愈
 *      同步补下载一次（tryFetchNativeBinary），成功则按 Path 1 语义返回带
 *      nativeBinding 的绑定；失败维持 null 降级。
 *
 * @param moduleUrl — `import.meta.url` of the calling module.
 * @returns a `Database` constructor, or `null` only when better-sqlite3 is
 *          genuinely absent (dev without the dependency installed).
 */
export function resolveBetterSqlite3(moduleUrl: string): any | null {
  // Detect the packaged-sidecar layout: native/ dir adjacent to the bundle.
  let nativePath: string | null = null
  let selfPath: string | null = null
  try {
    selfPath = fileURLToPath(moduleUrl)
    nativePath = findPackedNative(dirname(selfPath))
  } catch {
    // moduleUrl is not a file URL — treat as non-bundled.
  }

  // ── Path 1: packaged sidecar — wrapper bound to the packed .node ──
  if (nativePath && selfPath) return bindPackedWrapper(selfPath, nativePath)

  // ── Path 2: dev / CLI — full package from node_modules ──
  try {
    const req = createRequire(moduleUrl)
    const RealDatabase = req('better-sqlite3')
    // ⚠ require 成功 ≠ 可用：better-sqlite3 的原生库在构造时才加载（lib/database.js
    // 惰性 require('bindings')）。npm 降级布局（optional dep 装了 wrapper、编译/
    // prebuild 全败）下这里返回的是一个 `new Database()` 才炸的构造器——不自愈的
    // 话启动静默、首个 registry 打开即降级。校验 wrapper 自带二进制，缺失则转
    // 自愈 + nativeBinding 绑定。
    const pkgRoot = dirname(dirname(req.resolve('better-sqlite3')))
    if (existsSync(join(pkgRoot, 'build', 'Release', 'better_sqlite3.node'))) return RealDatabase
    const healed = tryFetchNativeBinary(moduleUrl)
    if (healed && selfPath) return bindPackedWrapper(selfPath, healed)
    return RealDatabase // 自愈失败维持原语义：调用方构造抛错 → 各自降级路径
  } catch {
    // not installed
  }

  // ── Path 3: self-heal once, then genuinely unavailable ──
  const healed = tryFetchNativeBinary(moduleUrl)
  if (healed && selfPath) return bindPackedWrapper(selfPath, healed)

  return null
}

/** Path 1 / 自愈共用的「wrapper + nativeBinding」绑定（含打包破损 fail-loud）。 */
function bindPackedWrapper(selfPath: string, nativePath: string): any {
  let RealDatabase: any
  try {
    const req = createRequire(selfPath)
    RealDatabase = req('better-sqlite3')
  } catch (err) {
    // native binary shipped but JS wrapper unresolvable → broken build.
    throw Object.assign(
      new Error(
        `[better-sqlite3] native binary present at ${nativePath} but the JS ` +
          `wrapper failed to resolve (${(err as Error)?.message ?? err}). This ` +
          `is a packaging bug — refusing to silently degrade to NullDatabase. ` +
          `Ensure stage-runtime-deps.js staged dist/node_modules/better-sqlite3.`,
      ),
      { code: 'ESQLITE_BUNDLE_BROKEN' },
    )
  }
  return bindNativeBinding(RealDatabase, nativePath)
}

/**
 * Wrap the real `Database` constructor so callers can keep doing
 * `new Database(path)` while we transparently inject the packed native binary.
 * Instances are produced by the real constructor, so prototype methods and
 * `instanceof` behave normally.
 */
function bindNativeBinding(RealDatabase: any, nativePath: string): any {
  function BoundDatabase(this: unknown, filename?: unknown, options?: Record<string, unknown>) {
    return new RealDatabase(filename, { nativeBinding: nativePath, ...options })
  }
  BoundDatabase.prototype = RealDatabase.prototype
  return BoundDatabase
}

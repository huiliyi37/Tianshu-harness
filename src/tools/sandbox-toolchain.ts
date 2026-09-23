/**
 * Toolchain-aware writable roots.
 *
 * The sandbox's static root list (cwd + tmp + generic caches) covers plain
 * npm/cargo/go work but not the per-ecosystem state directories a real
 * build/package run touches — Xcode DerivedData, provisioning profiles,
 * CocoaPods, the Android SDK, the pnpm store. Enumerating "every path" is
 * impossible; enumerating "the toolchains this repo actually uses" is not.
 *
 * Detection is marker-file based, cwd-scoped, and cached: defaultWritableRoots
 * runs on every command wrap.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

export interface ToolchainProbeCtx {
  cwd: string
  home: string
  platform: NodeJS.Platform
  /** Injected for tests. Defaults to fs.existsSync. */
  exists?: (p: string) => boolean
}

interface ToolchainRule {
  id: string
  /** Marker paths, relative to cwd. Any hit activates the rule. */
  markers: readonly string[]
  /** Roots relative to HOME, per platform. '*' applies everywhere. */
  roots: Readonly<Partial<Record<NodeJS.Platform | '*', readonly string[]>>>
}

export const TOOLCHAIN_RULES: readonly ToolchainRule[] = [
  {
    id: 'rust',
    markers: ['Cargo.toml', 'src-tauri/Cargo.toml'],
    roots: { '*': ['.cargo', '.rustup'] },
  },
  {
    id: 'xcode',
    // Tauri's macOS bundling, any native iOS/macOS target, and codesign all
    // route through Xcode state that lives outside ~/Library/Caches.
    markers: ['src-tauri/tauri.conf.json', 'tauri.conf.json', 'Package.swift'],
    roots: {
      darwin: [
        'Library/Developer/Xcode/DerivedData',
        'Library/Developer/CoreSimulator',
        'Library/MobileDevice/Provisioning Profiles',
      ],
    },
  },
  {
    id: 'pnpm',
    markers: ['pnpm-lock.yaml', 'pnpm-workspace.yaml'],
    roots: { darwin: ['Library/pnpm'], '*': ['.local/share/pnpm'] },
  },
  {
    id: 'cocoapods',
    markers: ['Podfile', 'ios/Podfile'],
    roots: { darwin: ['.cocoapods'] },
  },
  {
    id: 'android',
    markers: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'android/build.gradle'],
    roots: { '*': ['.android'], darwin: ['Library/Android/sdk'] },
  },
  {
    id: 'flutter',
    markers: ['pubspec.yaml'],
    roots: { '*': ['.pub-cache'] },
  },
  {
    id: 'ruby',
    markers: ['Gemfile'],
    roots: { '*': ['.gem', '.bundle'] },
  },
  {
    id: 'php',
    markers: ['composer.json'],
    roots: { '*': ['.composer', '.config/composer'] },
  },
  {
    id: 'python',
    markers: ['pyproject.toml', 'requirements.txt', 'setup.py'],
    roots: { '*': ['.local/lib', '.local/bin'] },
  },
]

const _cache = new Map<string, string[]>()

/**
 * Writable roots implied by the toolchains this workspace uses.
 * Non-existent roots are dropped — bwrap aborts the whole sandbox on a
 * --bind to a missing directory (see sandbox-profile.ts validRoots).
 *
 * 缓存限制：按 (platform, home, cwd) 做 key，进程生命周期内不失效。
 * 若会话中安装了新工具链（如 brew install cocoapods 创建 ~/.cocoapods），
 * 缓存不会感知，最多漏掉而非误加（existsSync 过滤）。必要时可在
 * request_path_access 批准后调 _resetToolchainCache() 强制刷新。
 */
export function toolchainWritableRoots(ctx: ToolchainProbeCtx): string[] {
  const key = `${ctx.platform}\u0000${ctx.home}\u0000${ctx.cwd}`
  const cached = _cache.get(key)
  if (cached) return cached

  const exists = ctx.exists ?? existsSync
  const out: string[] = []
  const seen = new Set<string>()

  // marker / root 的拼接按 ctx.platform 选 path 实现，不用宿主 join()：否则在
  // Windows 上跑 linux/darwin 用例时 '/w' + 'Cargo.toml' 会拼成 '\w\Cargo.toml'，
  // 与注入的 POSIX 夹具不匹配，规则恒不激活。真实运行时 ctx.platform 即宿主平台、
  // home/cwd 也是宿主原生路径，两条路径一致，行为不变。
  const p = ctx.platform === 'win32' ? win32 : posix

  for (const rule of TOOLCHAIN_RULES) {
    if (!rule.markers.some(m => exists(p.join(ctx.cwd, m)))) continue
    const groups = [rule.roots['*'], rule.roots[ctx.platform]]
    for (const group of groups) {
      for (const rel of group ?? []) {
        const abs = p.join(ctx.home, rel)
        if (seen.has(abs) || !exists(abs)) continue
        seen.add(abs)
        out.push(abs)
      }
    }
  }

  _cache.set(key, out)
  return out
}

/** Test-only: clear the per-cwd probe cache. */
export function _resetToolchainCache(): void {
  _cache.clear()
}

/** Diagnostics: which toolchains were detected (for /doctor and learn logs). */
export function detectedToolchains(ctx: ToolchainProbeCtx): string[] {
  const exists = ctx.exists ?? existsSync
  // 与 toolchainWritableRoots 同一处置：marker 路径按声明平台拼。
  const p = ctx.platform === 'win32' ? win32 : posix
  return TOOLCHAIN_RULES
    .filter(r => r.markers.some(m => exists(p.join(ctx.cwd, m))))
    .map(r => r.id)
}

/** Default ctx from the live process. */
export function currentToolchainCtx(cwd: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): ToolchainProbeCtx {
  return { cwd, home: env.HOME || homedir(), platform }
}

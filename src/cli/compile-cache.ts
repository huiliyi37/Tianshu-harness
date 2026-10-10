/**
 * CLI 编译缓存的版本化目录与清理（与桌面壳同款策略，见
 * desktop/src-tauri/src/lib.rs 的 sanitize_build_tag / prune_stale_compile_caches）。
 *
 * Node 的 compile cache 文件名随 bundle 内容哈希变化、旧条目自己永不淘汰；
 * CLI 用户通过 npm 升级频繁，不按版本隔离会让 `~/.rivet/cli/compile-cache`
 * 无界增长（本机实测 504 文件 / 12MB 的平铺目录）。这里按安装版本分子目录，
 * 升级后首次运行清掉「当前 + 最近 N 个」以外的旧目录；旧平铺布局遗留的 `v*`
 * Node 缓存目录（新布局不会再读取）无条件删除，早期无版本号的平铺文件按 mtime
 * 参与排序。
 *
 * 纪律：目录字符过滤到单层安全集（版本号异常带 `/` 时不会变成两层），清理是
 * best-effort，绝不影响缓存启用/CLI 启动。
 */
import { readdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { isFilesystemMetadata } from '../utils/file-metadata.js'

/** 保留当前版本 + 最近修改的 N 个其他条目（与桌面端 KEEP_RECENT_COMPILE_CACHES 同值）。 */
export const CLI_COMPILE_CACHE_KEEP_RECENT = 3

/** 目录名过滤到 [A-Za-z0-9._-]，其余替换为 `_`；空串回退 unknown。 */
export function sanitizeCacheTag(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_')
  return cleaned.length > 0 ? cleaned : 'unknown'
}

export function cliCompileCacheRoot(rivetHome: string): string {
  return join(rivetHome, 'cli', 'compile-cache')
}

export function cliCompileCacheDir(rivetHome: string, version: string): string {
  return join(cliCompileCacheRoot(rivetHome), sanitizeCacheTag(version))
}

/**
 * 刷新版本目录 mtime，标记「最近使用」。
 *
 * Node 把缓存条目写在版本目录的内层子目录里，父目录自身的 mtime 不会随使用变化；
 * 不刷新的话，`pruneStaleCliCompileCaches` 会退化成按「最近创建」排序，dev/正式版
 * 或相邻版本交替使用时仍会互删。entry.ts 每次启动都会调用（best-effort）。
 */
export function markCliCompileCacheUsed(dir: string): void {
  const now = new Date()
  try {
    utimesSync(dir, now, now)
  } catch {
    // best-effort：目录不可写/不存在时不影响缓存启用。
  }
}

/**
 * 旧平铺布局下 Node 自己的缓存子目录名（如 `v24.18.0-arm64-<hash>-501`）。
 *
 * 新布局只读 `<版本目录>/v24…`，缓存根目录下这种条目再也不会被读取；但它们一直
 * 写到升级前一刻，mtime 最新，按 mtime 排序反而会占掉「最近 N 份」名额（本机
 * 实测两个旧目录 134MB 因此幸存，而真正的旧版本目录被删）。故无条件清理。
 * 新版本目录名以数字开头（`3.27.0`），与 `^v\d+\.\d+\.\d+-` 不会撞。
 */
export function isLegacyNodeCacheEntry(name: string): boolean {
  return /^v\d+\.\d+\.\d+-/.test(name)
}

/**
 * 保留 `keep`（当前版本）与最近修改的 `keepRecent` 个其他条目，其余删除；
 * mtime 由 `markCliCompileCacheUsed` 在每次启动时刷新，代表**最近使用**而非创建
 * 时间；旧布局的 `v*` 目录无条件删除，早期无版本号的平铺文件按 mtime 参与排序。
 * best-effort：并发 CLI 仍在写的目录可能删不掉，留给下次。
 */
export function pruneStaleCliCompileCaches(root: string, keep: string, keepRecent = CLI_COMPILE_CACHE_KEEP_RECENT): void {
  const entries = readdirSync(root, { withFileTypes: true })
  const candidates: Array<{ path: string; mtimeMs: number }> = []
  for (const entry of entries) {
    if (isFilesystemMetadata(entry.name)) continue
    const path = join(root, entry.name)
    if (path === keep) continue
    if (isLegacyNodeCacheEntry(entry.name)) {
      try {
        rmSync(path, { recursive: true, force: true })
      } catch {
        // best-effort：删不掉留给下次。
      }
      continue
    }
    let mtimeMs = 0
    try {
      mtimeMs = statSync(path).mtimeMs
    } catch {
      // 读不到元数据按最旧处理，优先清掉。
    }
    candidates.push({ path, mtimeMs })
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const { path } of candidates.slice(keepRecent)) {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      // best-effort：正在使用的目录删不掉不影响本次启动。
    }
  }
}

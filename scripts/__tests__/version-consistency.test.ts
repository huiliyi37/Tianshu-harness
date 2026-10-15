import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { checkWorkspaceMetadata } from '../releases/check-workspace-metadata.mjs'

/**
 * issue #278 — 发布流程多版本源一致性守卫。
 *
 * 历史教训：发版时曾只更新 latest.json 而漏 bump package.json（例如 tag v3.26.0 里
 * package.json 写的是 3.25.1），导致：
 *  1. node entry.js --version 自报旧版本；
 *  2. checkForUpdate() 拿 package.json 与 npm latest 比较，源码安装用户永久卡在
 *     「Update available」横幅的死循环中；
 *  3. 打包出的桌面端内嵌运行时自称旧版本。
 *
 * 本用例锁住三条耦合：
 *  - latest.json / catalog / control 的稳定版本、固定哈希和签名一致；
 *    package.json 可领先稳定通道，不得落后（候选版本不能提前覆盖稳定入口）；
 *  - package-lock.json ↔ package.json 版本严格相等；
 *  - 桌面源码存在时，桌面 npm、Tauri 与 Rust 版本同运行时严格对齐；
 *  - latest.json 各平台下载资产链接与版本号对应。
 */
describe('版本一致性守卫（issue #278）', () => {
  const repoRoot = join(import.meta.dirname, '..', '..')
  const pkgPath = join(repoRoot, 'package.json')
  const lockPath = join(repoRoot, 'package-lock.json')
  const latestPath = join(repoRoot, 'latest.json')

  it('稳定清单与通道固定哈希、签名一致，开发版本不落后于稳定版本', () => {
    assert.ok(existsSync(pkgPath), 'package.json 必须存在')
    assert.ok(existsSync(latestPath), 'latest.json 必须存在')

    assert.doesNotThrow(() => checkWorkspaceMetadata(repoRoot))
  })

  it('package-lock.json 顶层版本与 package.json 严格对齐', () => {
    if (!existsSync(lockPath)) return // 某些打包环境可能剥离 lockfile

    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      version?: string
      packages?: Record<string, { version?: string }>
    }

    if (lock.version) {
      assert.equal(
        lock.version,
        pkg.version,
        `package-lock.json 顶层 version (${lock.version}) 必须与 package.json (${pkg.version}) 一致`,
      )
    }
    if (lock.packages?.['']?.version) {
      assert.equal(
        lock.packages[''].version,
        pkg.version,
        `package-lock.json packages[""].version (${lock.packages[''].version}) 必须与 package.json (${pkg.version}) 一致`,
      )
    }
  })

  it('latest.json 各平台下载链接包含当前版本 tag 与文件名版本', () => {
    const latest = JSON.parse(readFileSync(latestPath, 'utf8')) as {
      version: string
      platforms?: Record<string, { url?: string }>
    }

    const version = latest.version
    assert.ok(latest.platforms, 'latest.json 必须包含 platforms 映射')

    for (const [platform, asset] of Object.entries(latest.platforms)) {
      assert.ok(asset.url, `平台 ${platform} 必须有 url`)
      assert.ok(
        asset.url.includes(`/download/v${version}/`),
        `平台 ${platform} 的下载链接 ${asset.url} 必须包含 release tag v${version}`,
      )
      assert.ok(
        asset.url.includes(`_${version}_`),
        `平台 ${platform} 的下载文件名必须包含版本号 _${version}_`,
      )
    }
  })

  it('桌面 npm、Tauri 和 Rust 版本与运行时严格对齐', t => {
    const desktopRoot = join(repoRoot, 'desktop')
    if (!existsSync(desktopRoot)) {
      t.skip('公开 CLI 仓库不包含桌面源码')
      return
    }
    const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version as string
    const json = (file: string) => JSON.parse(readFileSync(join(desktopRoot, file), 'utf8'))
    const lock = json('package-lock.json')
    const versions = {
      'desktop/package.json': json('package.json').version,
      'desktop/package-lock.json': lock.version,
      'desktop/package-lock.json packages[""]': lock.packages?.['']?.version,
      'desktop/src-tauri/tauri.conf.json': json('src-tauri/tauri.conf.json').version,
      'desktop/src-tauri/Cargo.toml': readFileSync(join(desktopRoot, 'src-tauri/Cargo.toml'), 'utf8')
        .split(/^\[/m).find(block => block.startsWith('package]'))?.match(/^version\s*=\s*"([^"]+)"/m)?.[1],
      'desktop/src-tauri/Cargo.lock': readFileSync(join(desktopRoot, 'src-tauri/Cargo.lock'), 'utf8')
        .split('[[package]]').find(block => /^name = "tianshu-desktop"$/m.test(block))
        ?.match(/^version = "([^"]+)"$/m)?.[1],
    }
    for (const [file, actual] of Object.entries(versions)) {
      assert.equal(actual, version, `${file} 必须与运行时 ${version} 一致`)
    }
  })
})

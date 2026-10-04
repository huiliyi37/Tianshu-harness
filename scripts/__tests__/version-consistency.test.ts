import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

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
 *  - package.json ↔ latest.json 版本严格相等；
 *  - package-lock.json ↔ package.json 版本严格相等；
 *  - latest.json 各平台下载资产链接与版本号对应。
 */
describe('版本一致性守卫（issue #278）', () => {
  const repoRoot = join(import.meta.dirname, '..', '..')
  const pkgPath = join(repoRoot, 'package.json')
  const lockPath = join(repoRoot, 'package-lock.json')
  const latestPath = join(repoRoot, 'latest.json')

  it('package.json 与 latest.json 声明版本必须严格一致', () => {
    assert.ok(existsSync(pkgPath), 'package.json 必须存在')
    assert.ok(existsSync(latestPath), 'latest.json 必须存在')

    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }
    const latest = JSON.parse(readFileSync(latestPath, 'utf8')) as { version: string }

    assert.ok(pkg.version, 'package.json 必须有 version')
    assert.ok(latest.version, 'latest.json 必须有 version')
    assert.equal(
      pkg.version,
      latest.version,
      `package.json 版本 (${pkg.version}) 与 latest.json 版本 (${latest.version}) 不一致——发版必须同步更新`,
    )
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
})

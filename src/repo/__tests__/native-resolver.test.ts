import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveBetterSqlite3, tryFetchNativeBinary, isFetchFailureMarkerFresh } from '../native-resolver.js'
import { existsSync, mkdirSync, writeFileSync, rmSync, copyFileSync, cpSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

describe('native-resolver', () => {
  it('returns Database constructor when node_modules has better-sqlite3 (dev mode)', () => {
    // In dev mode, import.meta.url points to source — node_modules is on the
    // resolution path.
    const db = resolveBetterSqlite3(import.meta.url)
    assert.ok(db, 'should return a truthy constructor')
    // Verify it is a real Database by creating an in-memory DB
    const instance = new db(':memory:')
    instance.exec('CREATE TABLE t (x INTEGER)')
    instance.prepare('INSERT INTO t VALUES (?)').run(42)
    const row = instance.prepare('SELECT x FROM t').get() as { x: number }
    assert.equal(row.x, 42)
    instance.close()
  })

  it('returns null when neither native/ nor node_modules has better-sqlite3', () => {
    // A URL that resolves to a nonexistent location — no native/ dir, no node_modules
    const fakeUrl = 'file:///nonexistent/path/to/module.js'
    const result = resolveBetterSqlite3(fakeUrl)
    assert.equal(result, null, 'should return null when not found')
  })

  it('loads from dist/native/ when present (production bundle simulation)', (t) => {
    // Simulate running from dist/ — native/ dir is packed alongside main.js
    const distMainUrl = pathToFileURL(process.cwd() + '/dist/main.js').href
    if (!existsSync(process.cwd() + '/dist/native/better_sqlite3.node')) {
      // pack-native.js not run yet — skip, not fail
      t.skip('dist/native/better_sqlite3.node not found — run: node scripts/pack-native.js')
      return
    }
    const db = resolveBetterSqlite3(distMainUrl)
    assert.ok(db, 'should load via wrapper + nativeBinding')
    // Bound constructor must behave like the real Database (prepare/exec round-trip).
    const instance = new db(':memory:')
    instance.exec('CREATE TABLE t (x INTEGER)')
    instance.prepare('INSERT INTO t VALUES (?)').run(7)
    assert.equal((instance.prepare('SELECT x FROM t').get() as { x: number }).x, 7)
    instance.close()
  })

  it('finds the packed native/ from a nested caller (dist is a tsc tree, not a bundle)', async () => {
    // Real callers live at dist/repo/meridian-db.js, dist/agent/*.js … while
    // native/ sits at the dist root. A same-directory probe only ever matched
    // dist/main.js, so every real caller fell through to Path 2 and picked up
    // the binary-less staged wrapper — sqlite off everywhere, no error.
    const root = join(tmpdir(), `native-resolver-nested-${process.pid}-${Date.now()}`)
    mkdirSync(join(root, 'native'), { recursive: true })
    mkdirSync(join(root, 'repo'), { recursive: true })
    writeFileSync(join(root, 'native', 'better_sqlite3.node'), 'not a real addon')
    try {
      // The throw IS the assertion that Path 1 matched: tmpdir has no resolvable
      // wrapper, and only Path 1 reports that as a packaging bug. Before the fix
      // this same input returned null.
      assert.throws(
        () => resolveBetterSqlite3(pathToFileURL(join(root, 'repo', 'meridian-db.js')).href),
        (err: unknown) => (err as { code?: string })?.code === 'ESQLITE_BUNDLE_BROKEN',
        'a caller one level down must still see the packed native/',
      )
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 50 })
    }
  })

  it('resolves from a real dist/<area>/ caller when the bundle is packed', (t) => {
    if (!existsSync(join(process.cwd(), 'dist', 'native', 'better_sqlite3.node'))) {
      t.skip('dist/native/better_sqlite3.node not found — run: node scripts/pack-native.js')
      return
    }
    // Byte-for-byte what meridian-db.js passes as import.meta.url at runtime.
    const url = pathToFileURL(join(process.cwd(), 'dist', 'repo', 'meridian-db.js')).href
    const db = resolveBetterSqlite3(url)
    assert.ok(db, 'nested dist caller must resolve a constructor')
    const instance = new db(':memory:')
    instance.exec('CREATE TABLE t (x INTEGER)')
    instance.prepare('INSERT INTO t VALUES (?)').run(11)
    assert.equal((instance.prepare('SELECT x FROM t').get() as { x: number }).x, 11)
    instance.close()
  })

  it('stops walking up before it can bind an unrelated native/ binary', async () => {
    // Walking up is bounded: an ancestor far above the install root is somebody
    // else's, and binding a stranger's .node is worse than not finding one.
    const root = join(tmpdir(), `native-resolver-deep-${process.pid}-${Date.now()}`)
    const deep = join(root, 'a', 'b', 'c', 'd', 'e', 'f', 'g')
    mkdirSync(join(root, 'native'), { recursive: true })
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(root, 'native', 'better_sqlite3.node'), 'not a real addon')
    try {
      assert.equal(
        resolveBetterSqlite3(pathToFileURL(join(deep, 'mod.js')).href),
        null,
        'seven levels up is out of range',
      )
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 50 })
    }
  })

  it('throws (no silent degrade) when native binary is present but wrapper is unresolvable', async () => {
    // A location OUTSIDE the repo so node module resolution finds no
    // better-sqlite3 — but with a native/ binary present, which is exactly the
    // "broken packaging" signal that must fail loud instead of degrading.
    const dir = join(tmpdir(), `native-resolver-broken-${process.pid}-${Date.now()}`)
    mkdirSync(join(dir, 'native'), { recursive: true })
    writeFileSync(join(dir, 'native', 'better_sqlite3.node'), 'not a real addon')
    const moduleUrl = pathToFileURL(join(dir, 'main.js')).href
    try {
      assert.throws(
        () => resolveBetterSqlite3(moduleUrl),
        (err: unknown) => (err as { code?: string })?.code === 'ESQLITE_BUNDLE_BROKEN',
        'must throw ESQLITE_BUNDLE_BROKEN rather than return a NullDatabase',
      )
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 50 })
    }
  })
})

describe('native-resolver 自愈（fetch-native-sqlite 失败标记 + 启动补下载）', () => {
  const realBinary =
    existsSync(join(process.cwd(), 'dist', 'native', 'better_sqlite3.node'))
      ? join(process.cwd(), 'dist', 'native', 'better_sqlite3.node')
      : join(process.cwd(), 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')

  function makeRoot(): string {
    return join(tmpdir(), `native-heal-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  }

  /** 伪造安装根：scripts/fetch-native-sqlite.js 为可控桩（成功拷真二进制或落哨兵）。 */
  function writeStubScript(root: string, mode: 'heal' | 'sentinel' | 'fail') {
    mkdirSync(join(root, 'scripts'), { recursive: true })
    const body = mode === 'heal'
      ? `const {mkdirSync, copyFileSync, writeFileSync} = require('fs')\nmkdirSync(${JSON.stringify(join(root, 'dist', 'native'))}, {recursive: true})\ncopyFileSync(${JSON.stringify(realBinary)}, ${JSON.stringify(join(root, 'dist', 'native', 'better_sqlite3.node'))})\nwriteFileSync(${JSON.stringify(join(root, 'sentinel-ran'))}, process.env.RIVET_FETCH_SKIP_COMPILE ?? 'unset')\n`
      : mode === 'sentinel'
        ? `require('fs').writeFileSync(${JSON.stringify(join(root, 'sentinel-ran'))}, process.env.RIVET_FETCH_SKIP_COMPILE ?? 'unset')\n`
        : `process.exit(1)\n`
    writeFileSync(join(root, 'scripts', 'fetch-native-sqlite.js'), body)
  }

  it('isFetchFailureMarkerFresh：新鲜 true / 过期与损坏与缺失 false', async () => {
    const root = makeRoot()
    mkdirSync(join(root, 'dist', 'native'), { recursive: true })
    const marker = join(root, 'dist', 'native', '.fetch-failed')
    try {
      writeFileSync(marker, JSON.stringify({ ts: Date.now() - 60_000, error: 'x' }))
      assert.equal(isFetchFailureMarkerFresh(marker), true, '1 分钟前的标记应视为新鲜')
      writeFileSync(marker, JSON.stringify({ ts: Date.now() - 6 * 60_000, error: 'x' }))
      assert.equal(isFetchFailureMarkerFresh(marker), false, '6 分钟前的标记应已过期')
      writeFileSync(marker, '{corrupt json')
      assert.equal(isFetchFailureMarkerFresh(marker), false, '损坏标记按可重试处理')
      rmSync(marker, { force: true })
      assert.equal(isFetchFailureMarkerFresh(marker), false, '缺失标记按可重试处理')
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 50 })
    }
  })

  it('tryFetchNativeBinary：缺失时自动跑补下载，成功返回二进制路径', async () => {
    const root = makeRoot()
    writeStubScript(root, 'heal')
    try {
      const healed = tryFetchNativeBinary(pathToFileURL(join(root, 'dist', 'chunk.js')).href)
      assert.ok(healed && healed.endsWith('better_sqlite3.node'), `应返回补下的二进制路径，实得 ${healed}`)
      assert.equal(existsSync(healed!), true)
      assert.equal(readFileSync(join(root, 'sentinel-ran'), 'utf8'), '1', '启动自愈必须以 RIVET_FETCH_SKIP_COMPILE=1 调用（只下载不编译，启动不被数分钟编译卡住）')
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 50 })
    }
  })

  it('tryFetchNativeBinary：5 分钟内新鲜失败标记 → 跳过（脚本不执行）', async () => {
    const root = makeRoot()
    writeStubScript(root, 'sentinel')
    mkdirSync(join(root, 'dist', 'native'), { recursive: true })
    writeFileSync(join(root, 'dist', 'native', '.fetch-failed'), JSON.stringify({ ts: Date.now(), error: 'just failed' }))
    try {
      const healed = tryFetchNativeBinary(pathToFileURL(join(root, 'dist', 'chunk.js')).href)
      assert.equal(healed, null, '新鲜标记应跳过自愈')
      assert.equal(existsSync(join(root, 'sentinel-ran')), false, '跳过时桩脚本不应被执行')
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 50 })
    }
  })

  it('tryFetchNativeBinary：过期标记不跳过；脚本失败返回 null 不抛错', async () => {
    const root = makeRoot()
    writeStubScript(root, 'fail')
    mkdirSync(join(root, 'dist', 'native'), { recursive: true })
    writeFileSync(join(root, 'dist', 'native', '.fetch-failed'), JSON.stringify({ ts: Date.now() - 6 * 60_000, error: 'old' }))
    try {
      const healed = tryFetchNativeBinary(pathToFileURL(join(root, 'dist', 'chunk.js')).href)
      assert.equal(healed, null, '桩脚本 exit 1 且无二进制产出 → null（降级语义，不崩）')
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 50 })
    }
  })

  it('resolveBetterSqlite3 Path 3 端到端：npm 降级布局（wrapper 无二进制）自愈后返回可用绑定', async (t) => {
    if (!existsSync(realBinary)) { t.skip('本机无 better-sqlite3 二进制（真实依赖未装）'); return }
    const root = makeRoot()
    writeStubScript(root, 'heal')
    // 整包复制 wrapper 但剥离其自带二进制——即「npm 装了 wrapper、原生件缺失」的降级布局
    const wrapperSrc = join(process.cwd(), 'node_modules', 'better-sqlite3')
    const wrapperDst = join(root, 'node_modules', 'better-sqlite3')
    cpSync(wrapperSrc, wrapperDst, { recursive: true, filter: (src) => !src.includes(`${join(wrapperSrc, 'build')}`) })
    // wrapper require 期无条件加载 bindings（真实 npm 布局平铺在顶层 node_modules）
    for (const dep of ['bindings', 'file-uri-to-path']) {
      cpSync(join(process.cwd(), 'node_modules', dep), join(root, 'node_modules', dep), { recursive: true })
    }
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'dist', 'chunk.js'), '')
    try {
      const db = resolveBetterSqlite3(pathToFileURL(join(root, 'dist', 'chunk.js')).href)
      assert.ok(db, '自愈成功后应返回绑定构造器')
      const instance = new db(':memory:')
      instance.exec('CREATE TABLE t (x INTEGER)')
      instance.prepare('INSERT INTO t VALUES (?)').run(11)
      assert.equal((instance.prepare('SELECT x FROM t').get() as { x: number }).x, 11)
      instance.close()
    } finally {
      // 本用例加载了副本的 better_sqlite3.node——Windows 上 dlopen 的模块文件
      // 在进程存活期间无法 unlink（探针实测 unlink 恒 EPERM）。清理尽力而为：
      // 可删的删掉，被锁的 .node 链属预期残留（temp 目录，由 OS/后续轮次回收）。
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
        .catch(() => { /* expected: dlopen lock on the loaded binding */ })
    }
  })
})


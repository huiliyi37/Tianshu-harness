import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { rivetHome } from '../../config/paths.js'
import {
  grantPath,
  isReadGranted,
  isWriteGranted,
  writeGrantedRoots,
  listGrants,
  loadPersistedGrants,
  revokeGrant,
  listPersistedGrants,
  applyConfiguredPathGrants,
  applyDefaultDependencyReadGrants,
  applyRivetRuntimeReadGrants,
  isPathUnder,
  _resetGrantsForTest,
} from '../path-grants.js'
import { rawOutputDir } from '../output-store.js'
import { validatePathSafe } from '../path-validate.js'

// macOS sandbox may deny mkdtemp in /var/folders; use project-local scratch.
const SCRATCH = resolve('.rivet', 'scratch')
mkdirSync(SCRATCH, { recursive: true })

function tmp(): string {
  return mkdtempSync(join(SCRATCH, 'rivet-grants-'))
}

/** Per-workspace grants store file for a cwd（与 path-grants.grantsFile 同规则）。 */
function grantsStoreFile(cwd: string): string {
  const slug = resolve(cwd).replace(/[^a-zA-Z0-9]/g, '_').slice(-64)
  return join(rivetHome(), `path-grants-${slug}.json`)
}

describe('path-grants', () => {
  beforeEach(() => _resetGrantsForTest())

  it('grants a directory subtree (read)', () => {
    const dir = tmp()
    try {
      grantPath(dir, 'read')
      assert.equal(isReadGranted(join(dir, 'a/b/c.txt')), true)
      assert.equal(isReadGranted(dir), true)
      // read grant does not satisfy a write check
      assert.equal(isWriteGranted(join(dir, 'a.txt')), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('write grant satisfies both read and write', () => {
    const dir = tmp()
    try {
      grantPath(dir, 'write')
      assert.equal(isWriteGranted(join(dir, 'out.zip')), true)
      assert.equal(isReadGranted(join(dir, 'out.zip')), true)
      assert.deepEqual(writeGrantedRoots().length, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('upgrades read → write but never downgrades', () => {
    const dir = tmp()
    try {
      grantPath(dir, 'read')
      grantPath(dir, 'write')
      assert.equal(isWriteGranted(join(dir, 'x')), true)
      assert.equal(listGrants().length, 1, 'same root deduped')
      grantPath(dir, 'read') // must not downgrade
      assert.equal(isWriteGranted(join(dir, 'x')), true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('respects path-separator boundary (no prefix bleed)', () => {
    const base = tmp()
    try {
      const granted = join(base, 'proj')
      mkdirSync(granted)
      mkdirSync(join(base, 'proj-backup'))
      grantPath(granted, 'write')
      assert.equal(isWriteGranted(join(granted, 'f.txt')), true)
      assert.equal(isWriteGranted(join(base, 'proj-backup', 'secret')), false, 'sibling with common prefix must not match')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('canonicalizes symlinks so a grant cannot be escaped or missed', () => {
    const base = tmp()
    try {
      const realDir = join(base, 'real')
      mkdirSync(realDir)
      const link = join(base, 'link')
      symlinkSync(realDir, link)
      // Grant via the symlink; a check on the real path must still match.
      grantPath(link, 'write')
      assert.equal(isWriteGranted(join(realDir, 'a.txt')), true)
      assert.equal(isWriteGranted(join(link, 'a.txt')), true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('persist round-trips per-workspace and isolates between workspaces', () => {
    const cwdA = tmp()
    const cwdB = tmp()
    const target = tmp()
    try {
      grantPath(target, 'write', { persist: true, cwd: cwdA })
      const file = rivetHome()
      assert.ok(existsSync(file), '.rivet dir exists')

      // Fresh process simulation: reset memory, hydrate from B → nothing.
      _resetGrantsForTest()
      loadPersistedGrants(cwdB)
      assert.equal(isWriteGranted(join(target, 'x')), false, 'grant for A must not leak into B')

      // Hydrate from A → grant restored.
      _resetGrantsForTest()
      loadPersistedGrants(cwdA)
      assert.equal(isWriteGranted(join(target, 'x')), true, 'A grant restored from disk')
    } finally {
      for (const d of [cwdA, cwdB, target]) rmSync(d, { recursive: true, force: true })
    }
  })

  it('session-only grants do not persist', () => {
    const cwd = tmp()
    const target = tmp()
    try {
      grantPath(target, 'write') // no persist
      _resetGrantsForTest()
      loadPersistedGrants(cwd)
      assert.equal(isWriteGranted(join(target, 'x')), false)
    } finally {
      for (const d of [cwd, target]) rmSync(d, { recursive: true, force: true })
    }
  })

  it('revokeGrant removes the grant from memory AND disk at once (no session zombie)', () => {
    const cwd = tmp()
    const target = tmp()
    try {
      grantPath(target, 'write', { persist: true, cwd })
      assert.equal(isWriteGranted(join(target, 'x')), true)

      const removed = revokeGrant(target, { cwd })
      assert.equal(removed, true)

      // 内存即时失效：撤销后本会话剩余部分立刻不可写
      assert.equal(isWriteGranted(join(target, 'x')), false, 'in-memory grant must vanish immediately')
      // 磁盘同步失效：模拟下次启动，重载也不会复活
      _resetGrantsForTest()
      loadPersistedGrants(cwd)
      assert.equal(isWriteGranted(join(target, 'x')), false, 'revoked grant must not resurrect from disk')
      assert.deepEqual(listPersistedGrants(cwd), [], 'store file must no longer list the grant')
    } finally {
      _resetGrantsForTest()
      rmSync(grantsStoreFile(cwd), { force: true })
      for (const d of [cwd, target]) rmSync(d, { recursive: true, force: true })
    }
  })

  it('revokeGrant leaves sibling grants (same prefix) untouched', () => {
    const cwd = tmp()
    const base = tmp()
    try {
      const granted = join(base, 'proj')
      const sibling = join(base, 'proj-backup')
      mkdirSync(granted)
      mkdirSync(sibling)
      grantPath(granted, 'write', { persist: true, cwd })
      grantPath(sibling, 'write', { persist: true, cwd })

      const removed = revokeGrant(granted, { cwd })
      assert.equal(removed, true)
      // 同前缀兄弟目录不受影响（isPathUnder 的分隔符边界）
      assert.equal(isWriteGranted(join(sibling, 'f.txt')), true, 'sibling with common prefix must survive')
      assert.equal(isWriteGranted(join(granted, 'f.txt')), false)

      _resetGrantsForTest()
      loadPersistedGrants(cwd)
      assert.equal(isWriteGranted(join(sibling, 'f.txt')), true, 'sibling survives on disk too')
      assert.equal(isWriteGranted(join(granted, 'f.txt')), false)
    } finally {
      _resetGrantsForTest()
      rmSync(grantsStoreFile(cwd), { force: true })
      for (const d of [cwd, base]) rmSync(d, { recursive: true, force: true })
    }
  })

  it('revokeGrant is exact-root: revoking /a/b does not remove a separately-granted /a/b/c', () => {
    const cwd = tmp()
    const a = tmp()
    const nested = join(a, 'b', 'c')
    mkdirSync(nested, { recursive: true })
    try {
      grantPath(join(a, 'b'), 'write', { persist: true, cwd })
      grantPath(nested, 'write', { persist: true, cwd })

      revokeGrant(join(a, 'b'), { cwd })
      // 独立授权的子目录必须保留——撤销 /a/b 不是撤销 /a/b/c
      assert.equal(isWriteGranted(join(nested, 'x')), true)
      _resetGrantsForTest()
      loadPersistedGrants(cwd)
      assert.equal(isWriteGranted(join(nested, 'x')), true)
    } finally {
      _resetGrantsForTest()
      rmSync(grantsStoreFile(cwd), { force: true })
      for (const d of [cwd, a]) rmSync(d, { recursive: true, force: true })
    }
  })

  it('revokeGrant returns false for a path that was never granted', () => {
    const cwd = tmp()
    const target = tmp()
    try {
      assert.equal(revokeGrant(target, { cwd }), false)
      // 也不该产生任何副作用
      assert.deepEqual(listPersistedGrants(cwd), [])
    } finally {
      _resetGrantsForTest()
      for (const d of [cwd, target]) rmSync(d, { recursive: true, force: true })
    }
  })

  it('revokeGrant rewrites the store from disk contents, preserving peer-session grants', () => {
    // 场景：本进程 hydrate 后，另一会话持久化了新授权 B；本进程撤销 A。
    // 若从内存重写会把 B 一起丢掉——revokeGrant 必须基于磁盘内容重写。
    const cwd = tmp()
    const targetA = tmp()
    const targetB = tmp()
    try {
      grantPath(targetA, 'write', { persist: true, cwd })
      // 模拟 peer 会话：直接往 store 文件追加 B（不经过本进程内存）。
      // slug 规则与 path-grants.grantsFile 一致：canonicalize(cwd) → 非字母数字替换 → 尾部 64 字符。
      const slug = resolve(cwd).replace(/[^a-zA-Z0-9]/g, '_').slice(-64)
      const file = join(rivetHome(), `path-grants-${slug}.json`)
      const onDisk = JSON.parse(readFileSync(file, 'utf-8')) as Array<{ root: string; mode: string; grantedAt: number; persisted: boolean }>
      onDisk.push({ root: resolve(targetB), mode: 'write', grantedAt: Date.now(), persisted: true })
      writeFileSync(file, JSON.stringify(onDisk, null, 2))

      revokeGrant(targetA, { cwd })

      _resetGrantsForTest()
      loadPersistedGrants(cwd)
      assert.equal(isWriteGranted(join(targetA, 'x')), false, 'A revoked')
      assert.equal(listPersistedGrants(cwd).length, 1, 'B must survive the rewrite')
    } finally {
      _resetGrantsForTest()
      rmSync(grantsStoreFile(cwd), { force: true })
      for (const d of [cwd, targetA, targetB]) rmSync(d, { recursive: true, force: true })
    }
  })

  it('applyConfiguredPathGrants: read and write dirs from config, skipping missing paths', () => {
    const readDir = tmp()
    const writeDir = tmp()
    try {
      applyConfiguredPathGrants({
        additionalReadDirs: [readDir, join(readDir, 'does-not-exist')],
        additionalWriteDirs: [writeDir, '   '],
      })
      assert.equal(isReadGranted(join(readDir, 'a.txt')), true)
      assert.equal(isWriteGranted(join(readDir, 'a.txt')), false, 'read dir must not grant write')
      assert.equal(isWriteGranted(join(writeDir, 'b.txt')), true)
      assert.equal(listGrants().length, 2, 'non-existent and blank entries skipped')
      assert.ok(listGrants().every(g => !g.persisted), 'config grants are session-scoped, never persisted')
    } finally {
      for (const d of [readDir, writeDir]) rmSync(d, { recursive: true, force: true })
    }
  })

  it('applyConfiguredPathGrants tolerates undefined/empty config', () => {
    applyConfiguredPathGrants(undefined)
    applyConfiguredPathGrants({})
    assert.equal(listGrants().length, 0)
  })

  it('applyDefaultDependencyReadGrants: grants read (not write) for existing HOME caches, skips missing', () => {
    applyDefaultDependencyReadGrants()
    const grants = listGrants()
    // Every auto-granted root is read-only and session-scoped.
    assert.ok(grants.every(g => g.mode === 'read'), 'default dep grants must be read-only')
    assert.ok(grants.every(g => !g.persisted), 'default dep grants must not persist')
    // At least the HOME directory itself is readable through any granted cache
    // root that actually exists on this machine; verify each granted root is
    // both readable and NOT writable, and that a non-existent cache was skipped.
    for (const g of grants) {
      assert.equal(isReadGranted(join(g.root, 'nested', 'file.dart')), true)
      assert.equal(isWriteGranted(join(g.root, 'x')), false, 'read grant must not confer write')
      assert.ok(existsSync(g.root), 'missing dirs must be skipped, not granted')
    }
    // Sanity: the function granted something on any realistic dev machine (one
    // of .cache / .npm / .cargo / .gradle / .pub-cache … exists). CI containers
    // may have a bare HOME, so only assert when at least one candidate exists.
    const candidates = ['.cache', '.npm', '.cargo', '.gradle', '.pub-cache', '.m2', '.nuget', '.nvm', '.pyenv', 'go']
    const anyExists = candidates.some(c => existsSync(join(homedir(), c)))
    if (anyExists) assert.ok(grants.length >= 1, 'expected at least one HOME cache to be granted')
  })

  it('applyDefaultDependencyReadGrants: uses env var override when set and directory exists', () => {
    const customDir = tmp()
    try {
      const saved = process.env.CARGO_HOME
      process.env.CARGO_HOME = customDir
      try {
        applyDefaultDependencyReadGrants()
        const grants = listGrants()
        assert.ok(grants.some(g => isReadGranted(join(customDir, 'x'))),
          'CARGO_HOME override should grant the custom directory')
        const cargoGrant = grants.find(g => g.mode === 'read' && isReadGranted(join(customDir, 'x')))
        assert.ok(cargoGrant, 'custom CARGO_HOME should appear in grants')
        assert.equal(cargoGrant.mode, 'read')
        assert.equal(cargoGrant.persisted, undefined) // never persisted
      } finally {
        if (saved !== undefined) process.env.CARGO_HOME = saved
        else delete process.env.CARGO_HOME
      }
    } finally {
      rmSync(customDir, { recursive: true, force: true })
    }
  })

  it('applyDefaultDependencyReadGrants: skips env var path when directory does not exist', () => {
    const missingDir = join(SCRATCH, 'does-not-exist-' + Date.now())
    const saved = process.env.GRADLE_USER_HOME
    process.env.GRADLE_USER_HOME = missingDir
    try {
      assert.equal(existsSync(missingDir), false, 'test dir must not exist')
      applyDefaultDependencyReadGrants()
      const grants = listGrants()
      for (const g of grants) {
        assert.notEqual(g.root, missingDir, 'non-existent env var dir must not be granted')
      }
    } finally {
      if (saved !== undefined) process.env.GRADLE_USER_HOME = saved
      else delete process.env.GRADLE_USER_HOME
    }
  })

  it('applyDefaultDependencyReadGrants: empty env var falls through to default', () => {
    // Save CARGO_HOME, set to empty string, verify the default ~/.cargo is
    // still checked (existence-dependent — on a machine without .cargo, this
    // just verifies it does not crash and does not grant anything based on
    // the empty string).
    const saved = process.env.CARGO_HOME
    process.env.CARGO_HOME = ''
    try {
      _resetGrantsForTest()
      assert.doesNotThrow(() => applyDefaultDependencyReadGrants())
      // Empty env var must never produce a grant — it either falls through to
      // the default (which may or may not exist) or is skipped.
      const grants = listGrants()
      assert.ok(grants.every(g => g.root !== ''), 'empty env var must not produce empty-string grant')
    } finally {
      if (saved !== undefined) process.env.CARGO_HOME = saved
      else delete process.env.CARGO_HOME
    }
  })

  it('applyRivetRuntimeReadGrants: raw 输出目录可读——截断 footer 指示模型读它，不授权就是死胡同', () => {
    // bash 输出被截断时，footer 明确写着 `full output: read_file <rawPath> — 不要重跑命令`。
    // rawPath 在 $TMPDIR 下，落在工作区外；没有 read 授权时 read_file 直接拒绝，
    // 模型既读不到全量输出、又被告知别重跑，只能空转。
    const rawPath = join(rawOutputDir(), 'deadbeef0123456789abcdef.raw')

    assert.equal(isReadGranted(rawPath), false, '前置：默认无授权')

    applyRivetRuntimeReadGrants()

    assert.ok(isReadGranted(rawPath), 'rawOutputDir 必须默认拿到 read 授权')
    // 真门禁而非仅授权表：validatePathSafe 是 read_file 实际走的那一关。
    const gate = validatePathSafe(process.cwd(), rawPath)
    assert.ok(gate.ok, `validatePathSafe 必须放行 rawPath，实得：${gate.ok ? '' : gate.error}`)

    const grants = listGrants()
    assert.ok(grants.every(g => g.mode === 'read'), 'runtime 授权只能是 read，写仍走审批')
    assert.ok(grants.every(g => !g.persisted), 'runtime 授权不得持久化')
  })

  it('applyRivetRuntimeReadGrants: 目录不存在也要授权——raw 目录是首次大输出时才懒创建的', () => {
    // 依赖缓存目录用 existsSync fail-closed 是对的（防配错开洞），但 rawOutputDir
    // 是 Rivet 自己的目录、会话开始时通常还不存在。若照搬 existsSync 跳过，
    // 授权永远不会生效——这条正是修复要防的回归。
    const dir = rawOutputDir()
    rmSync(dir, { recursive: true, force: true })
    assert.equal(existsSync(dir), false, '前置：raw 目录不存在')

    applyRivetRuntimeReadGrants()

    assert.ok(isReadGranted(join(dir, 'later-created.raw')),
      '会话启动时 raw 目录尚不存在，授权也必须生效')
  })
})

describe('isPathUnder (win32 case semantics)', () => {
  it('case-insensitive mode matches mixed-case drive letters and segments', () => {
    assert.equal(isPathUnder('F:\\智慧项目', 'f:\\智慧项目', true), true)
    // Note: separator boundary uses the host separator; use posix-style for portability.
    assert.equal(isPathUnder('/proj/Sub', '/proj/sub/file.ts', true), true)
    assert.equal(isPathUnder('/PROJ', '/proj', true), true)
  })

  it('case-sensitive mode (posix) does not fold case', () => {
    assert.equal(isPathUnder('/proj/Sub', '/proj/sub/file.ts', false), false)
    assert.equal(isPathUnder('/proj/sub', '/proj/sub/file.ts', false), true)
  })

  it('separator boundary holds in both modes', () => {
    assert.equal(isPathUnder('/a/b', '/a/bc/x', true), false)
    assert.equal(isPathUnder('/a/b', '/a/bc/x', false), false)
  })
})

describe('授权表会话作用域（2026-09-11 F1：sidecar 多会话跨工作区泄漏修复）', () => {
  beforeEach(() => _resetGrantsForTest())

  it('A 工作区批准的授权对 B 工作区的会话不可见', () => {
    const workspaceA = tmp()
    const workspaceB = tmp()
    const outside = tmp()
    // request-path-access 的真实姿势：A 会话批准工作区外目录可写
    grantPath(outside, 'write', { persist: false, cwd: workspaceA })

    assert.equal(isWriteGranted(outside, workspaceA), true, '批准方工作区照常可见')
    assert.equal(isWriteGranted(outside, workspaceB), false, '未批准的工作区 B 不得继承 A 的授权')
    assert.equal(isWriteGranted(outside), true, '无 cwd 的旧调用方保持全量视图（向后兼容）')
  })

  it('validatePathSafe 端到端：A 的批准不放行 B 的工作区外写入', () => {
    const workspaceA = tmp()
    const workspaceB = tmp()
    const target = join(tmp(), 'report.txt')
    grantPath(dirname(target), 'write', { persist: false, cwd: workspaceA })

    assert.equal(validatePathSafe(workspaceA, target, 'write').ok, true)
    assert.equal(validatePathSafe(workspaceB, target, 'write').ok, false,
      'B 工作区写工作区外路径必须仍走审批——修复前会静默放行（泄漏）')
  })

  it('loadPersistedGrants 只为本工作区注水，不灌进其他工作区的视图', () => {
    const workspaceA = tmp()
    const workspaceB = tmp()
    const outside = tmp()
    grantPath(outside, 'write', { persist: true, cwd: workspaceA })
    _resetGrantsForTest()

    loadPersistedGrants(workspaceA)
    assert.equal(isWriteGranted(outside, workspaceA), true, '本工作区的持久授权注水后可见')
    assert.equal(isWriteGranted(outside, workspaceB), false,
      '另一工作区（或其后续会话）不得看见 A 的持久授权')
  })

  it('config 级授权（无 cwd）保持进程级语义不变', () => {
    const workspaceA = tmp()
    const workspaceB = tmp()
    const outside = tmp()
    applyConfiguredPathGrants({ additionalWriteDirs: [outside] })

    assert.equal(isWriteGranted(outside, workspaceA), true)
    assert.equal(isWriteGranted(outside, workspaceB), true, '用户显式配置的目录授权对所有会话生效（行为不变）')
  })

  it('writeGrantedRoots(cwd) 只列出对该会话可见的可写根（沙箱喂食点）', () => {
    const workspaceA = tmp()
    const workspaceB = tmp()
    const outsideA = tmp()
    const outsideB = tmp()
    grantPath(outsideA, 'write', { persist: false, cwd: workspaceA })
    grantPath(outsideB, 'write', { persist: false, cwd: workspaceB })

    const rootsA = writeGrantedRoots(workspaceA)
    const rootsB = writeGrantedRoots(workspaceB)
    assert.ok(rootsA.some(r => isPathUnder(r, outsideA)), 'A 看得见自己批准的根')
    assert.ok(!rootsB.some(r => isPathUnder(r, outsideA)), 'B 的沙箱不得被 A 的授权撑宽')
    assert.ok(rootsB.some(r => isPathUnder(r, outsideB)), 'B 看得见自己批准的根')
  })

  it('同一根目录可被不同工作区各自授权，互不串扰', () => {
    const workspaceA = tmp()
    const workspaceB = tmp()
    const outside = tmp()
    grantPath(outside, 'read', { persist: false, cwd: workspaceA })
    grantPath(outside, 'write', { persist: false, cwd: workspaceB })

    assert.equal(isReadGranted(outside, workspaceA), true)
    assert.equal(isWriteGranted(outside, workspaceA), false, 'A 只批了读，B 的写授权不回流 A')
    assert.equal(isWriteGranted(outside, workspaceB), true, 'B 的写授权只在 B 生效')
  })
})

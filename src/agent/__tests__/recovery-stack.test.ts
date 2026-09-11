import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  trackFileRestore, renderRecoveryStack, evictOldBackups, trackFileChange,
  restoreLatestBackup,
  __resetEvictDebounceForTest,
} from '../recovery-stack.js'
import { readUnacknowledged } from '../recovery-journal.js'
/** 造 N 个数字命名的备份目录（名字 = Date.now() 格式的时间戳，越早越旧）。 */
function seedBackupDirs(backupsDir: string, count: number, startTs: number): void {
  for (let i = 0; i < count; i++) {
    mkdirSync(join(backupsDir, String(startTs + i)), { recursive: true })
  }
}

function numericBackupCount(backupsDir: string): number {
  try {
    return readdirSync(backupsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && /^\d+$/.test(e.name))
      .length
  } catch {
    return 0
  }
}

/** 轮询等待去频淘汰（fire-and-forget）收敛到期望目录数——有界等待。 */
async function waitForDirCount(backupsDir: string, expected: number, timeoutMs = 2_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const n = numericBackupCount(backupsDir)
    if (n === expected || Date.now() > deadline) return n
    await new Promise(r => setTimeout(r, 25))
  }
}

describe('recovery-stack', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-recovery-'))

  it('tracks file restore events in journal', () => {
    trackFileRestore(cwd, 'src/a.ts', 'undo tool restore', 5)
    const entries = readUnacknowledged(cwd)
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.file, 'src/a.ts')
    assert.match(renderRecoveryStack(cwd), /src\/a.ts/)
  })

  it('evictOldBackups keeps the newest 100 numeric dirs and leaves foreign dirs alone', async () => {
    const backupsDir = join(cwd, '.rivet', 'backups')
    seedBackupDirs(backupsDir, 105, 1_700_000_000_000)
    mkdirSync(join(backupsDir, 'not-a-timestamp'), { recursive: true })

    await evictOldBackups(cwd)

    const remaining = readdirSync(backupsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort()
    // 105 数字目录 → 保留最新 100（时间戳 1_700_000_000_005 … 1_700_000_000_104）
    const numeric = remaining.filter(n => /^\d+$/.test(n))
    assert.equal(numeric.length, 100, `expected 100 numeric dirs, got ${numeric.length}: ${numeric.join(',')}`)
    assert.equal(numeric[0], '1700000000005', 'oldest numeric dirs must be evicted')
    assert.ok(remaining.includes('not-a-timestamp'), 'non-numeric dir must never be touched')
  })

  it('trackFileChange 触发去频淘汰并最终收敛到上限（fire-and-forget）', async () => {
    const backupsDir = join(cwd, '.rivet', 'backups')
    rmSync(backupsDir, { recursive: true, force: true })
    seedBackupDirs(backupsDir, 101, 1_700_000_000_000)
    const target = join(cwd, 'src', 'x.ts')
    mkdirSync(join(cwd, 'src'), { recursive: true })
    writeFileSync(target, 'v1', 'utf-8')

    __resetEvictDebounceForTest()
    const rec = await trackFileChange(cwd, { filePath: 'src/x.ts', action: 'write', toolCallId: 't1' })
    assert.ok(rec.backupPath, '备份路径应返回（写前备份）')

    // 2026-09-06 落盘后台化：新备份目录的 mkdir 在后台进行，与去频淘汰的
    // readdir 存在竞态——先等新备份落盘，再评估淘汰结果（允许 100 或 100+1）。
    const deadline = Date.now() + 2000
    for (;;) {
      if (existsSync(rec.backupPath!) || Date.now() > deadline) break
      await new Promise(r => setTimeout(r, 25))
    }
    assert.ok(existsSync(rec.backupPath!), '后台落盘应最终落盘')
    const n = numericBackupCount(backupsDir)
    assert.ok(n === 100 || n === 101, `淘汰后应为 100（淘汰见新目录）或 101（淘汰先于落盘），实际 ${n}`)
    // 直接淘汰一次验证上限语义：无论竞态落点如何，最终收敛 100。
    await evictOldBackups(cwd)
    assert.equal(numericBackupCount(backupsDir), 100, '显式淘汰后必须收敛到上限 100')
  })

  it('去频窗口内的后续编辑不再触发淘汰（每 cwd 5 分钟至多一次）', async () => {
    const backupsDir = join(cwd, '.rivet', 'backups')
    // 上一用例收敛在 100；再造超限并在窗口内编辑——目录应只增不减
    seedBackupDirs(backupsDir, 6, 1_800_000_000_000) // 100 + 6 = 106 > cap
    const target = join(cwd, 'src', 'y.ts')
    writeFileSync(target, 'v1', 'utf-8')

    const before = numericBackupCount(backupsDir)
    await trackFileChange(cwd, { filePath: 'src/y.ts', action: 'write', toolCallId: 't2' })
    await new Promise(r => setTimeout(r, 150))
    const after = numericBackupCount(backupsDir)
    assert.equal(after, before + 1, '窗口内不淘汰：新备份目录入列，旧目录保留')
  })

  // ── 2026-09-06 备份后台化（issue #61 族）：捕获前置 + 落盘后台 + 回滚内存优先 ──
  it('内存捕获在覆写前完成：覆写坏内容后可经 restoreLatestBackup 回滚', async () => {
    const target = join(cwd, 'src', 'rollback.ts')
    mkdirSync(join(cwd, 'src'), { recursive: true })
    writeFileSync(target, 'v1-good-content', 'utf-8')

    const rec = await trackFileChange(cwd, { filePath: 'src/rollback.ts', action: 'write', toolCallId: 't3' })
    assert.ok(rec.backupPath)
    // 覆写（模拟写工具落地坏内容）——内存里必须已是 v1。
    writeFileSync(target, 'v2-broken', 'utf-8')

    const restored = await restoreLatestBackup(cwd, 'src/rollback.ts')
    assert.equal(restored, true, '回滚必须成功（内存优先，不等后台落盘）')
    assert.equal(readFileSync(target, 'utf-8'), 'v1-good-content', '回滚恢复的是覆写前的旧内容')
  })

  it('后台落盘最终一致：备份文件随后出现在磁盘且内容为旧版本', async () => {
    const target = join(cwd, 'src', 'flush.ts')
    mkdirSync(join(cwd, 'src'), { recursive: true })
    writeFileSync(target, 'old-bytes-for-flush', 'utf-8')

    const rec = await trackFileChange(cwd, { filePath: 'src/flush.ts', action: 'write', toolCallId: 't4' })
    assert.ok(rec.backupPath)
    writeFileSync(target, 'new-bytes', 'utf-8')

    // flush 是 fire-and-forget——轮询等它落盘并验证内容没被新写入污染。
    const deadline = Date.now() + 2000
    for (;;) {
      if (existsSync(rec.backupPath!) || Date.now() > deadline) break
      await new Promise(r => setTimeout(r, 25))
    }
    assert.ok(existsSync(rec.backupPath!), '后台落盘应最终落盘')
    assert.equal(readFileSync(rec.backupPath!, 'utf-8'), 'old-bytes-for-flush', '备份内容是覆写前的旧版本（不是新内容）')
  })

  it('二进制文件退回 copyFile 旧路径：备份字节一致且当场在盘', async () => {
    const target = join(cwd, 'src', 'bin.dat')
    mkdirSync(join(cwd, 'src'), { recursive: true })
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x10])
    writeFileSync(target, bytes)

    const rec = await trackFileChange(cwd, { filePath: 'src/bin.dat', action: 'write', toolCallId: 't5' })
    assert.ok(rec.backupPath, '二进制走 copyFile——backupPath 应返回')
    assert.ok(existsSync(rec.backupPath!), 'copyFile 路径是 await 的——返回即已在盘')
    assert.deepEqual(readFileSync(rec.backupPath!), bytes, '二进制备份字节一致')
  })

  after(() => {
    rmSync(cwd, { recursive: true, force: true })
  })
})

// ── E5：journal 写失败不得把已成功的回滚报成失败（undo.ts 同纪律）──
describe('restoreLatestBackup journal 容错（fail-open）', () => {
  // 每用例独立临时 cwd：本组用例要把 journal 路径造成同名目录（EISDIR），
  // 共享 cwd 会把损坏状态泄漏给后续用例。
  const cwds: string[] = []
  function makeCwd(): string {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-recovery-journal-'))
    cwds.push(dir)
    return dir
  }

  /** 把 journal 文件路径变成同名目录——appendFileSync 必抛 EISDIR（跨平台：Windows chmod 不可靠勿用）。 */
  function breakJournal(cwd: string): void {
    mkdirSync(join(cwd, '.rivet', 'recovery-journal.jsonl'), { recursive: true })
  }

  it('journal 写失败（EISDIR）：内存分支回滚仍返回 true 且内容已恢复', async () => {
    const cwd = makeCwd()
    const target = join(cwd, 'src', 'mem.ts')
    mkdirSync(join(cwd, 'src'), { recursive: true })
    writeFileSync(target, 'v1-good', 'utf-8')
    await trackFileChange(cwd, { filePath: 'src/mem.ts', action: 'write', toolCallId: 'j1' })
    writeFileSync(target, 'v2-broken', 'utf-8')

    breakJournal(cwd)
    const restored = await restoreLatestBackup(cwd, 'src/mem.ts')

    assert.equal(restored, true, '文件已恢复成功，journal 写失败不得翻转返回值')
    assert.equal(readFileSync(target, 'utf-8'), 'v1-good', '目标文件内容确实已恢复为旧版本')
  })

  it('journal 写失败（EISDIR）：磁盘分支（copyFile 兜底）同样返回 true 且内容已恢复', async () => {
    const cwd = makeCwd()
    const target = join(cwd, 'src', 'disk.dat')
    mkdirSync(join(cwd, 'src'), { recursive: true })
    const bytes = Buffer.from([0x00, 0xde, 0xad, 0xbe, 0xef, 0x00])
    writeFileSync(target, bytes)
    // 二进制内容退回 copyFile 旧路径（不进内存备份）→ restoreLatestBackup 走磁盘分支。
    const rec = await trackFileChange(cwd, { filePath: 'src/disk.dat', action: 'write', toolCallId: 'j2' })
    assert.ok(rec.backupPath)
    writeFileSync(target, Buffer.from([0x00, 0x0b, 0xad, 0x00]))

    breakJournal(cwd)
    const restored = await restoreLatestBackup(cwd, 'src/disk.dat')

    assert.equal(restored, true, '磁盘分支语义必须与内存分支一致：回滚已成功即返回 true')
    assert.deepEqual(readFileSync(target), bytes, '目标文件字节确实已恢复为旧版本')
  })

  it('正常路径：journal 可写时行为不变——返回 true 且 recordRecovery 确实落账', async () => {
    const cwd = makeCwd()
    const target = join(cwd, 'src', 'normal.ts')
    mkdirSync(join(cwd, 'src'), { recursive: true })
    writeFileSync(target, 'normal-v1', 'utf-8')
    await trackFileChange(cwd, { filePath: 'src/normal.ts', action: 'write', toolCallId: 'j3' })
    writeFileSync(target, 'normal-v2-broken', 'utf-8')

    const restored = await restoreLatestBackup(cwd, 'src/normal.ts')

    assert.equal(restored, true)
    assert.equal(readFileSync(target, 'utf-8'), 'normal-v1')
    const entries = readUnacknowledged(cwd).filter(e => e.file === 'src/normal.ts')
    assert.equal(entries.length, 1, '恢复事件必须记录进 journal')
    assert.equal(entries[0]!.action, 'restore latest backup')
    assert.ok(entries[0]!.ts, 'journal 条目应带时间戳')
  })

  after(() => {
    for (const dir of cwds) rmSync(dir, { recursive: true, force: true })
  })
})

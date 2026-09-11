import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrateSessionFiles, rebuildStoresAfterCwdMove } from '../session-cd.js'
import { getSessionDir, SessionPersist } from '../session-persist.js'
import { FileHistory } from '../file-history.js'

/**
 * D-1 回归：/cd 换工作区后必须按新 cwd 重建 FileHistory/ContextClaimStore
 * （bootstrap 的 switchAgentCwd 经 rebuildStoresAfterCwdMove 重建并同步 ctx）。
 *
 * 病灶链（repro-d-1-cd-filehistory-brick.ts 5/5 红，语义搬进 node:test）：
 *  ① 复用旧 FileHistory（备份根焊死旧 cwd）→ 迁移后 rewind 读旧路径备份
 *     ENOENT 被当「missing」静默 skip → 撤销无声丢失；
 *  ② 新编辑 trackEdit 在旧路径 mkdir(recursive) → 旧项目会话目录原地复活
 *     （跨项目状态脑裂）；
 *  ③ 旧目录复活后切回旧项目，会话目录 rename 落在非空目录上 = ENOTEMPTY
 *     → 迁移抛错 → /cd 被拒（往返 /cd 确定性砖化）。
 */

describe('rebuildStoresAfterCwdMove (/cd 后重建 fileHistory/claimStore)', () => {
  let home: string
  let oldCwd: string
  let newCwd: string
  let prevHome: string | undefined
  let prevSessionDir: string | undefined

  const sid = 'd1rebuild-sess'

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-cd-rebuild-'))
    oldCwd = mkdtempSync(join(tmpdir(), 'rivet-cd-projA-'))
    newCwd = mkdtempSync(join(tmpdir(), 'rivet-cd-projB-'))
    prevHome = process.env.RIVET_HOME
    prevSessionDir = process.env.RIVET_SESSION_DIR
    process.env.RIVET_HOME = home
    // RIVET_SESSION_DIR 会压过 slug 派生（所有 cwd 共用一个目录）——本测试
    // 验证的正是跨 slug 迁移，必须确保它未设置。
    delete process.env.RIVET_SESSION_DIR
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    if (prevSessionDir === undefined) delete process.env.RIVET_SESSION_DIR
    else process.env.RIVET_SESSION_DIR = prevSessionDir
    rmSync(home, { recursive: true, force: true })
    rmSync(oldCwd, { recursive: true, force: true })
    rmSync(newCwd, { recursive: true, force: true })
  })

  /**
   * 复刻 bootstrap 的构造与 /cd 时序：旧项目编辑（留备份）→ 会话文件整体迁移
   * （bootstrap 第 4 步）→ 新 persist + 容器重建（第 5 步，被测函数）。
   */
  async function setupSwitch(): Promise<{ fhOld: FileHistory; rebuilt: ReturnType<typeof rebuildStoresAfterCwdMove>; f1: string }> {
    const persistOld = new SessionPersist(sid, oldCwd)
    const fhOld = new FileHistory(persistOld.getBackupDir(), sid)
    // /cd 前在旧项目的一次编辑（备份落在旧 slug 目录，随迁移搬走）
    const f1 = join(oldCwd, 'src.txt')
    writeFileSync(f1, 'v0-original\n')
    await fhOld.trackEdit(f1, 'msg-1')
    writeFileSync(f1, 'v1-edited-by-agent\n')
    // /cd（bootstrap 第 4 步）：会话文件整体迁到新 slug 目录
    migrateSessionFiles(sid, oldCwd, newCwd)
    // /cd（bootstrap 第 5 步）：新 persist + 容器重建
    const persistNew = new SessionPersist(sid, newCwd)
    const rebuilt = rebuildStoresAfterCwdMove(fhOld, persistNew)
    return { fhOld, rebuilt, f1 }
  }

  /** FileHistory 备份文件的真实落盘层：<slug>/<sid>/backups/<sid>/<hash>@vN>。 */
  function backupFilesDir(projectCwd: string): string {
    return join(getSessionDir(projectCwd), sid, 'backups', sid)
  }

  it('① /cd 后 rewind 恢复迁移前快照（备份随目录迁移可读，不再静默空转）', async () => {
    const persistOld = new SessionPersist(sid, oldCwd)
    const fhOld = new FileHistory(persistOld.getBackupDir(), sid)
    const f = join(oldCwd, 'src.txt')
    writeFileSync(f, 'v0-original\n')
    await fhOld.trackEdit(f, 'msg-1')
    writeFileSync(f, 'v1-edited-by-agent\n')

    migrateSessionFiles(sid, oldCwd, newCwd)
    const persistNew = new SessionPersist(sid, newCwd)
    const rebuilt = rebuildStoresAfterCwdMove(fhOld, persistNew)

    // 重建实例接管内存快照（tracked 名单与快照随迁）
    assert.notEqual(rebuilt.fileHistory, fhOld)
    assert.equal(rebuilt.fileHistory.getAllSnapshots().length, 1)
    assert.ok(rebuilt.fileHistory.hasSnapshot('msg-1'))

    // 修复语义：undo 实际恢复 v0（旧实例在此静默 skip——备份按旧路径读 ENOENT）
    const changed = await rebuilt.fileHistory.rewind('msg-1')
    assert.deepEqual(changed, [f])
    assert.equal(readFileSync(f, 'utf-8'), 'v0-original\n')
  })

  it('② /cd 后新编辑的备份落在新 slug 目录，旧项目会话目录不复活', async () => {
    const { rebuilt, f1 } = await setupSwitch()

    const f2 = join(newCwd, 'new.txt')
    writeFileSync(f2, 'brand-new-file\n')
    await rebuilt.fileHistory.trackEdit(f2, 'msg-2')

    const newBackups = backupFilesDir(newCwd)
    assert.ok(existsSync(newBackups), '新项目会话目录应有备份落盘')
    const backupContents = readdirSync(newBackups).map(name => readFileSync(join(newBackups, name), 'utf-8'))
    assert.ok(backupContents.includes('v0-original\n'), '/cd 前的旧备份应随迁移落在新 slug 目录')
    assert.ok(backupContents.includes('brand-new-file\n'), '/cd 后的新备份应落在新 slug 目录')

    // 脑裂断言：旧项目会话目录不再被新编辑原地复活
    assert.equal(existsSync(join(getSessionDir(oldCwd), sid)), false)
    assert.equal(existsSync(f1), true, '旧项目用户文件本体不受影响')
  })

  it('③ 切回旧项目不再 ENOTEMPTY（旧目录未复活，会话目录可整体迁回）', async () => {
    const { rebuilt } = await setupSwitch()
    const f2 = join(newCwd, 'new.txt')
    writeFileSync(f2, 'brand-new-file\n')
    await rebuilt.fileHistory.trackEdit(f2, 'msg-2')

    // 回程 /cd（旧病灶：幽灵目录让 rename ENOTEMPTY → 迁移抛错 → 拒绝切换）
    const back = migrateSessionFiles(sid, newCwd, oldCwd)
    assert.ok(back.moved.includes(`${sid}/`), '会话子目录（含 backups/）应整体迁回旧 slug')
    const oldBackups = backupFilesDir(oldCwd)
    const backupContents = readdirSync(oldBackups).map(name => readFileSync(join(oldBackups, name), 'utf-8'))
    assert.ok(backupContents.includes('v0-original\n') && backupContents.includes('brand-new-file\n'),
      '两代备份随会话完整迁回')
  })

  it('claimStore 重建：新编辑记账指向新项目目录，旧 claims 文件留守旧项目（设计语义）', async () => {
    const persistOld = new SessionPersist(sid, oldCwd)
    const fhOld = new FileHistory(persistOld.getBackupDir(), sid)
    const oldStore = persistOld.createClaimStore()
    migrateSessionFiles(sid, oldCwd, newCwd)
    const persistNew = new SessionPersist(sid, newCwd)
    const rebuilt = rebuildStoresAfterCwdMove(fhOld, persistNew)

    assert.notEqual(rebuilt.claimStore.path, oldStore.path)
    assert.ok(rebuilt.claimStore.path.startsWith(getSessionDir(newCwd)), '新 claimStore 记账到新 slug 目录')
    assert.ok(oldStore.path.startsWith(getSessionDir(oldCwd)), '旧 claims 文件刻意不迁移，留守旧项目')
  })
})

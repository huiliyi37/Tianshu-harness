import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, loadPersistableConfig, setCheckpointConfig, setHookDisabled } from '../manager.js'
import { userConfigPath } from '../paths.js'
import { profilePath } from '../profile.js'

/**
 * C1 回归：profile 层是临时活层（profile.ts「回滚语义：删 profile 文件或换
 * profile 即回滚（文件即配置，无状态）」），任何 setter 写盘都不得把 profile
 * 覆盖值烘焙进全局 config.json——此前 saveConfig 把 loadConfig() 的完整合并
 * 结果落盘，RIVET_PROFILE（--profile 注入 env）活跃期间一次无关设置保存就让
 * profile 覆盖永久化，删/换 profile 无法回滚。读路径不受影响：getter 仍能看到
 * profile 覆盖（saveConfig 剥层只作用于写盘内容）。
 */

/** 隔离环境：RIVET_HOME=临时目录（config.json 与 profiles/ 都落在里面），
 *  可选写入 profile 文件；结束恢复全部环境变量并清理临时目录。 */
function withProfileHome(
  profileName: string | undefined,
  profileOverlay: Record<string, unknown> | undefined,
  fn: () => void,
): void {
  const home = mkdtempSync(join(tmpdir(), 'rivet-c1-profile-'))
  const saved: Array<[string, string | undefined]> = [
    ['RIVET_HOME', process.env.RIVET_HOME],
    ['RIVET_PROFILE', process.env.RIVET_PROFILE],
    ['RIVET_CONFIG_PATH', process.env.RIVET_CONFIG_PATH],
  ]
  process.env.RIVET_HOME = home
  delete process.env.RIVET_CONFIG_PATH
  if (profileName === undefined) delete process.env.RIVET_PROFILE
  else process.env.RIVET_PROFILE = profileName
  if (profileOverlay !== undefined) {
    mkdirSync(join(home, 'profiles'), { recursive: true })
    writeFileSync(profilePath(profileName!), JSON.stringify(profileOverlay))
  }
  try {
    fn()
  } finally {
    for (const [key, val] of saved) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
    rmSync(home, { recursive: true, force: true })
  }
}

/** 用户自定义 profile：覆盖两个与 checkpoint 无关的键（数组键 + 标量键）。 */
const AUDIT_PROFILE = 'audit-profile'
const AUDIT_OVERLAY = {
  hooks: { disabled: ['audit-hook-a', 'audit-hook-b'] },
  network: { proxy: 'http://audit-proxy:7890' },
}

test('C1: 无关 setter 写盘不得带入 profile 覆盖键；删 profile 后 setter 改动仍在且 profile 值不残留', () => {
  withProfileHome(AUDIT_PROFILE, AUDIT_OVERLAY, () => {
    // 前置：profile 活跃时磁盘上还没有 config.json（profile 应是「无状态」活层）
    assert.equal(existsSync(userConfigPath()), false)

    // 保存一个与 profile 覆盖键（hooks/network）毫无相关的设置
    setCheckpointConfig({ checkpointEveryTurns: 5 })

    // ① 盘上含 setter 的改动
    const disk = JSON.parse(readFileSync(userConfigPath(), 'utf-8'))
    assert.equal(disk.agent?.checkpointEveryTurns, 5, 'setter 的改动必须落盘')
    // ② 盘上不含 profile 的覆盖键
    assert.equal(disk.hooks?.disabled, undefined, 'profile 的 hooks.disabled 不得被烘焙进 config.json')
    assert.equal(disk.network?.proxy, undefined, 'profile 的 network.proxy 不得被烘焙进 config.json')

    // ③a 删 profile：setter 改动保留，profile 覆盖值不残留
    delete process.env.RIVET_PROFILE
    const afterRemove = loadConfig()
    assert.equal(afterRemove.agent.checkpointEveryTurns, 5)
    assert.equal(afterRemove.hooks.disabled, undefined)
    assert.equal(afterRemove.network.proxy, undefined)

    // ③b 换 profile（另一个无文件的 profile）：同样只留 setter 的改动
    process.env.RIVET_PROFILE = 'another-profile'
    const afterSwitch = loadConfig()
    assert.equal(afterSwitch.agent.checkpointEveryTurns, 5)
    assert.equal(afterSwitch.hooks.disabled, undefined)
    assert.equal(afterSwitch.network.proxy, undefined)
  })
})

test('C1: 读路径仍含 profile 层（loadConfig 可见覆盖，loadPersistableConfig 不含）', () => {
  withProfileHome(AUDIT_PROFILE, AUDIT_OVERLAY, () => {
    // 内存读：profile 覆盖生效
    const effective = loadConfig()
    assert.deepEqual(effective.hooks.disabled, ['audit-hook-a', 'audit-hook-b'])
    assert.equal(effective.network.proxy, 'http://audit-proxy:7890')
    // 可持久视图：defaults ⊕ user，profile 层不在其中
    const persistable = loadPersistableConfig()
    assert.equal(persistable.hooks.disabled, undefined)
    assert.equal(persistable.network.proxy, undefined)
  })
})

test('C1: 内置 lean profile 同样不被无关 setter 烘焙（审计复现脚本同款场景）', () => {
  withProfileHome('lean', undefined, () => {
    assert.equal(existsSync(userConfigPath()), false)
    setCheckpointConfig({ checkpointEveryTurns: 7 })
    const disk = JSON.parse(readFileSync(userConfigPath(), 'utf-8'))
    assert.equal(disk.agent?.checkpointEveryTurns, 7)
    assert.equal(disk.hooks?.disabled, undefined, 'lean 的 hooks.disabled 不得落盘')

    // 摘掉 RIVET_PROFILE = 回滚（profile.ts:17 承诺的路径）：checkpoint 保留、hook 全回来
    delete process.env.RIVET_PROFILE
    const after = loadConfig()
    assert.equal(after.agent.checkpointEveryTurns, 7)
    assert.deepEqual(after.hooks.disabled, undefined)
  })
})

test('C1 边界：setter 显式编辑 profile 拥有的键时，按写入值落盘（编辑不被还原吞掉）', () => {
  withProfileHome('lean', undefined, () => {
    // 生效视图含 lean 的三个 hook；显式追加禁用 kick → 写入值 ≠ overlay 贡献值 → 保留
    const { disabled } = setHookDisabled('kick', false)
    assert.deepEqual(disabled, ['dream-distill', 'skill-distill', 'anchor-break-scout', 'kick'])
    const disk = JSON.parse(readFileSync(userConfigPath(), 'utf-8'))
    assert.deepEqual(disk.hooks?.disabled, disabled, '显式编辑按生效视图持久化（守卫只还原 setter 未触碰的路径）')
  })
})

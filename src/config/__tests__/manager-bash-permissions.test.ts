import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, setPermissionDirs } from '../manager.js'
import { getBashPermissions, setBashPermissions, appendBashAllowPrefix } from '../bash-permissions.js'

/**
 * 命令白名单（bash 前缀）的持久化配置。
 *
 * 存在理由：会话内的 learnBashPrefix（src/agent/permissions.ts）学到的前缀
 * 只活在当次会话——自动化任务每次触发都是新会话，于是"放行了也白放行"。
 * 这里的 config 层是它的持久对应物，供桌面设置页读写（/config/bash-permissions）。
 */
describe('bash command allow/deny prefixes config', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-bashperm-config-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns empty lists when unset', () => {
    assert.deepEqual(getBashPermissions(), { allowlist: [], denylist: [] })
  })

  it('persists both lists and round-trips through loadConfig', () => {
    const r = setBashPermissions({
      allowlist: ['python', 'python3', 'git status'],
      denylist: ['taskkill'],
    })
    assert.deepEqual(r, {
      allowlist: ['python', 'python3', 'git status'],
      denylist: ['taskkill'],
    })
    const cfg = loadConfig()
    assert.deepEqual(cfg.agent.permissions.bash.allowlist, ['python', 'python3', 'git status'])
    assert.deepEqual(cfg.agent.permissions.bash.denylist, ['taskkill'])
    assert.deepEqual(getBashPermissions(), r)
  })

  it('updating only one list leaves the other untouched', () => {
    setBashPermissions({ allowlist: ['python'], denylist: ['taskkill'] })
    const r = setBashPermissions({ allowlist: ['python', 'node'] })
    assert.deepEqual(r.allowlist, ['python', 'node'])
    assert.deepEqual(r.denylist, ['taskkill'])
  })

  it('trims, drops empties, and deduplicates entries', () => {
    const r = setBashPermissions({ allowlist: ['  python  ', '', '   ', 'python', 'node'] })
    assert.deepEqual(r.allowlist, ['python', 'node'])
  })

  it('rejects non-array / non-string input', () => {
    assert.throws(() => setBashPermissions({ allowlist: 'python' }), /must be an array of strings/)
    assert.throws(() => setBashPermissions({ denylist: [42] }), /must be an array of strings/)
  })

  it('an empty array clears the list', () => {
    setBashPermissions({ allowlist: ['python'] })
    const r = setBashPermissions({ allowlist: [] })
    assert.deepEqual(r.allowlist, [])
    assert.deepEqual(loadConfig().agent.permissions.bash.allowlist, [])
  })

  // 反例保护：写 bash 白名单不得顺手清掉同一 permissions 对象里的目录授权
  // （persistence 路径是整体 `agent.permissions` 覆盖写）。
  it('does not clobber sibling permission fields (dir grants stay intact)', () => {
    setPermissionDirs({ additionalWriteDirs: ['/tmp/w'] })
    setBashPermissions({ allowlist: ['python'] })
    const cfg = loadConfig()
    assert.deepEqual(cfg.agent.permissions.additionalWriteDirs, ['/tmp/w'])
    assert.deepEqual(cfg.agent.permissions.bash.allowlist, ['python'])
  })

  // 审批卡「永久记住」的写入路径：会话级 learnBashPrefix 只活当次会话，勾了
  // 永久才走这里落 config（自动化任务每次触发都是新会话）。
  describe('appendBashAllowPrefix（读-改-写，不覆盖）', () => {
    it('追加到既有列表而不是替换它，且不动 denylist', () => {
      setBashPermissions({ allowlist: ['git status'], denylist: ['taskkill'] })
      appendBashAllowPrefix('python')
      const after = getBashPermissions()
      assert.deepEqual(after.allowlist, ['git status', 'python'])
      assert.deepEqual(after.denylist, ['taskkill'], 'denylist 不受影响')
    })

    it('已存在的项不重复追加', () => {
      setBashPermissions({ allowlist: ['python'] })
      appendBashAllowPrefix('python')
      assert.deepEqual(getBashPermissions().allowlist, ['python'])
    })

    it('空串与含 = 的环境赋值前缀不写入（后者匹配时会被剥离，是死条目）', () => {
      setBashPermissions({ allowlist: ['python'] })
      appendBashAllowPrefix('   ')
      appendBashAllowPrefix('CI=true')
      assert.deepEqual(getBashPermissions().allowlist, ['python'])
    })

    it('写入前 trim', () => {
      appendBashAllowPrefix('  npm  ')
      assert.deepEqual(getBashPermissions().allowlist, ['npm'])
    })
  })
})

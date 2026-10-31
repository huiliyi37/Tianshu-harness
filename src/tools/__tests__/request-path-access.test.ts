import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { REQUEST_PATH_ACCESS_TOOL, isForbiddenGrantRoot } from '../request-path-access.js'
import { isWriteGranted, isReadGranted, loadPersistedGrants, _resetGrantsForTest } from '../path-grants.js'

function params(input: Record<string, unknown>, cwd: string) {
  return { input, toolUseId: 't1', cwd }
}

describe('request_path_access tool', () => {
  beforeEach(() => _resetGrantsForTest())

  it('always requires approval', () => {
    assert.equal(REQUEST_PATH_ACCESS_TOOL.requiresApproval({} as never), true)
  })

  it('grants write access to a directory subtree on execute', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-cwd-'))
    const ext = mkdtempSync(join(tmpdir(), 'rivet-ext-'))
    try {
      const res = await REQUEST_PATH_ACCESS_TOOL.execute(params({ path: ext, mode: 'write' }, cwd) as never)
      assert.ok(!res.isError)
      assert.match(res.content, /已授予 write 访问/)
      assert.equal(isWriteGranted(join(ext, 'out.zip')), true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(ext, { recursive: true, force: true })
    }
  })

  it('grants the parent dir when target is a file path', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-cwd-'))
    const ext = mkdtempSync(join(tmpdir(), 'rivet-ext-'))
    try {
      const filePath = join(ext, 'report.pdf') // does not exist
      await REQUEST_PATH_ACCESS_TOOL.execute(params({ path: filePath, mode: 'write' }, cwd) as never)
      assert.equal(isWriteGranted(join(ext, 'sibling.txt')), true, 'parent dir granted')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(ext, { recursive: true, force: true })
    }
  })

  it('read mode does not grant write', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-cwd-'))
    const ext = mkdtempSync(join(tmpdir(), 'rivet-ext-'))
    try {
      await REQUEST_PATH_ACCESS_TOOL.execute(params({ path: ext, mode: 'read' }, cwd) as never)
      assert.equal(isReadGranted(join(ext, 'x')), true)
      assert.equal(isWriteGranted(join(ext, 'x')), false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(ext, { recursive: true, force: true })
    }
  })

  // issue #117 — 缺省 write 是权限放大 footgun：一次调用即可把写权限盖到全盘。
  it('defaults to read when mode is omitted', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-cwd-'))
    const ext = mkdtempSync(join(tmpdir(), 'rivet-ext-'))
    try {
      const res = await REQUEST_PATH_ACCESS_TOOL.execute(params({ path: ext }, cwd) as never)
      assert.ok(!res.isError)
      assert.match(res.content, /已授予 read 访问/)
      assert.equal(isReadGranted(join(ext, 'x')), true)
      assert.equal(isWriteGranted(join(ext, 'x')), false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(ext, { recursive: true, force: true })
    }
  })

  // issue #117 — 授权根无上界：path='/' 获批后本会话可写全磁盘。
  it('refuses filesystem roots and system directories', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-cwd-'))
    try {
      // 平台分流（issue #189 核对表标注）：POSIX 路径在 Windows 上不是文件系统根
      // （`/etc/passwd` 落到当前盘 \etc\passwd），所以这组 execute 断言只能按宿主
      // 真实系统根写。win32 分支在开发机上是死覆盖——它的守卫点是下面那条
      // isForbiddenGrantRoot 用例（纯函数，跨平台可跑）。
      const roots = process.platform === 'win32'
        ? ['C:\\', 'C:\\Windows', 'C:\\Program Files', 'C:\\Users']
        : ['/', '/etc', '/usr', '/Users', '/etc/passwd', '/System']
      for (const p of roots) {
        const res = await REQUEST_PATH_ACCESS_TOOL.execute(params({ path: p, mode: 'write' }, cwd) as never)
        assert.equal(res.isError, true, `should refuse ${p}`)
      }
      // isWriteGranted 只回答「有没有覆盖该路径的 write 授权」，不查
      // FORBIDDEN_GRANT_ROOTS——所以这两句与宿主平台无关（未授权即 false），
      // 不该藏进 win32 分支冒充平台覆盖。
      assert.equal(isWriteGranted('/etc/hosts'), false)
      assert.equal(isWriteGranted('/usr/local/bin/x'), false)
    } finally {
      rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })

  // Windows 清单的守卫点在这里，不在上面那条的平台分支里：isForbiddenGrantRoot 是
  // 纯函数（去尾分隔符 + 盘根正则 + 小写查表），没有任何 process.platform 分支，
  // 所以在 macOS/Linux 上跑得到真结果——execute 的 win32 分支在开发机上永不执行，
  // 只靠它覆盖等于零覆盖。
  it('forbidden grant roots cover POSIX and Windows system dirs on every platform', () => {
    for (const p of [
      '/', '/etc', '/usr', '/bin', '/var', '/opt', '/private', '/System',
      'C:\\', 'D:\\', 'C:\\Windows', 'C:\\Program Files', 'C:\\Users',
    ]) {
      assert.equal(isForbiddenGrantRoot(p), true, `${p} must be a forbidden grant root`)
    }
    // 反例：用户自己的工作目录树仍可授权（issue #117 只封根与系统目录）。
    for (const p of ['/tmp/work', '/Users/me/proj', 'C:\\Users\\me\\proj', 'C:\\dev\\x']) {
      assert.equal(isForbiddenGrantRoot(p), false, `${p} must stay grantable`)
    }
  })

  // issue #117 — 敏感文件不得通过本工具拿到批量授权（纵深防御：path-validate 亦拦）。
  it('refuses sensitive files', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-cwd-'))
    try {
      const res = await REQUEST_PATH_ACCESS_TOOL.execute(params({ path: '/srv/app/.env', mode: 'read' }, cwd) as never)
      assert.equal(res.isError, true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('remember=true persists the grant across a fresh load', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-cwd-'))
    const ext = mkdtempSync(join(tmpdir(), 'rivet-ext-'))
    try {
      await REQUEST_PATH_ACCESS_TOOL.execute(params({ path: ext, mode: 'write', remember: true }, cwd) as never)
      _resetGrantsForTest()
      assert.equal(isWriteGranted(join(ext, 'x')), false, 'cleared from memory')
      loadPersistedGrants(cwd)
      assert.equal(isWriteGranted(join(ext, 'x')), true, 'restored from per-workspace store')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(ext, { recursive: true, force: true })
    }
  })

  it('errors on missing path', async () => {
    const res = await REQUEST_PATH_ACCESS_TOOL.execute(params({}, '/tmp') as never)
    assert.equal(res.isError, true)
  })

  // 审计发现：守卫此前只查词法路径，而 grantPath 随后规范化（解析符号链接）——
  // 工作区内的链接指向 /etc 时，审批看到的路径与实际授权的路径不一致。
  it('refuses a symlink alias pointing at a forbidden root', async () => {
    if (process.platform === 'win32') return
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-cwd-'))
    const dir = mkdtempSync(join(tmpdir(), 'rivet-alias-'))
    const link = join(dir, 'build-out')
    try {
      symlinkSync('/etc', link)
    } catch {
      return // symlink creation not permitted in this environment: skip
    }
    try {
      const res = await REQUEST_PATH_ACCESS_TOOL.execute(params({ path: link, mode: 'write' }, cwd) as never)
      assert.equal(res.isError, true, 'symlink to /etc must be refused')
      assert.match(res.content, /\/etc/)
      assert.equal(isWriteGranted('/etc/hosts'), false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a symlink alias pointing at a sensitive-named directory', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-cwd-'))
    const base = mkdtempSync(join(tmpdir(), 'rivet-alias-'))
    const real = join(base, '.env')
    const link = join(base, 'data')
    try {
      mkdirSync(real)
      symlinkSync(real, link)
    } catch {
      return // symlink creation not permitted in this environment: skip
    }
    try {
      const res = await REQUEST_PATH_ACCESS_TOOL.execute(params({ path: link, mode: 'read' }, cwd) as never)
      assert.equal(res.isError, true, 'symlink to a .env directory must be refused')
      assert.equal(isReadGranted(join(real, 'x')), false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('still grants a symlink alias pointing at an ordinary directory', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-cwd-'))
    const ext = mkdtempSync(join(tmpdir(), 'rivet-ext-'))
    const link = join(cwd, 'out')
    try {
      symlinkSync(ext, link)
    } catch {
      return // symlink creation not permitted in this environment: skip
    }
    try {
      const res = await REQUEST_PATH_ACCESS_TOOL.execute(params({ path: link, mode: 'read' }, cwd) as never)
      assert.ok(!res.isError)
      assert.equal(isReadGranted(join(ext, 'x')), true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(ext, { recursive: true, force: true })
    }
  })
})

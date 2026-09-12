import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { REQUEST_PATH_ACCESS_TOOL } from '../request-path-access.js'
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
      for (const p of ['/', '/etc', '/usr', '/Users', '/etc/passwd', '/System']) {
        const res = await REQUEST_PATH_ACCESS_TOOL.execute(params({ path: p, mode: 'write' }, cwd) as never)
        assert.equal(res.isError, true, `should refuse ${p}`)
      }
      assert.equal(isWriteGranted('/etc/hosts'), false)
      assert.equal(isWriteGranted('/usr/local/bin/x'), false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
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
})

/**
 * hook 脚本的解释器解析（issue #198）。
 *
 * 锁死的是这件事：Windows 上**绝不**把脚本路径直接交给 shell（`shell: true` 即
 * `cmd /d /s /c "<script>"`）——`.sh` 没有关联处理程序时会弹「选取应用」并阻塞。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveHookCommand } from '../user-hooks-runner.js'

const win = 'win32' as NodeJS.Platform
const noExists = () => false
const envWith = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ PATH: '', ...extra })

describe('resolveHookCommand —— Windows 按扩展名选解释器', () => {
  it('.sh：命中 Git 已知安装位置（不依赖 PATH）', () => {
    const exists = (p: string) => p.toLowerCase().endsWith('git\\bin\\bash.exe')
    const r = resolveHookCommand('C:\\proj\\post-tool.sh', {
      platform: win,
      env: envWith({ ProgramFiles: 'C:\\Program Files' }),
      exists,
    })
    assert.equal(r.ok, true)
    assert.match(r.ok ? r.cmd : '', /Git\\bin\\bash\.exe$/i)
    assert.deepEqual(r.ok ? r.args : [], ['C:\\proj\\post-tool.sh'])
    assert.equal(r.ok ? r.shell : true, false, '绝不能走 shell')
  })

  it('.sh：已知位置没有时退回 PATH 上的 bash.exe', () => {
    const exists = (p: string) => p.toLowerCase() === 'c:\\tools\\bash.exe'
    const r = resolveHookCommand('C:\\proj\\x.sh', {
      platform: win,
      env: envWith({ PATH: 'C:\\tools' }),
      exists,
    })
    assert.equal(r.ok, true)
    assert.equal(r.ok ? r.cmd : '', 'C:\\tools\\bash.exe')
    assert.equal(r.ok ? r.shell : true, false)
  })

  it('.sh：找不到 bash → fail-closed 报错，不 spawn、不交给 shell', () => {
    const r = resolveHookCommand('C:\\proj\\x.sh', { platform: win, env: envWith(), exists: noExists })
    assert.equal(r.ok, false)
    assert.match(r.ok ? '' : r.error, /找不到 bash/)
  })

  it('.bat/.cmd：显式 cmd.exe，且 shell=false（不再靠 shell 二次解析）', () => {
    const r = resolveHookCommand('C:\\proj\\x.bat', { platform: win, env: envWith(), exists: noExists })
    assert.equal(r.ok, true)
    assert.equal(r.ok ? r.cmd : '', 'cmd.exe')
    assert.deepEqual(r.ok ? r.args : [], ['/d', '/s', '/c', 'C:\\proj\\x.bat'])
    assert.equal(r.ok ? r.shell : true, false)
  })

  it('.js/.mjs/.cjs/.ts：用运行中的 node，必然存在', () => {
    for (const name of ['a.js', 'a.mjs', 'a.cjs', 'a.ts']) {
      const r = resolveHookCommand(`C:\\proj\\${name}`, {
        platform: win,
        env: envWith(),
        exists: noExists,
        execPath: 'C:\\node\\node.exe',
      })
      assert.equal(r.ok, true, name)
      assert.equal(r.ok ? r.cmd : '', 'C:\\node\\node.exe', name)
      assert.equal(r.ok ? r.shell : true, false, name)
    }
  })

  it('.py：PATH 上有 python 就用，没有则 fail-closed', () => {
    const r1 = resolveHookCommand('C:\\proj\\x.py', {
      platform: win,
      env: envWith({ PATH: 'C:\\py' }),
      exists: (p) => p.toLowerCase() === 'c:\\py\\python.exe',
    })
    assert.equal(r1.ok, true)
    assert.equal(r1.ok ? r1.shell : true, false)

    const r2 = resolveHookCommand('C:\\proj\\x.py', { platform: win, env: envWith(), exists: noExists })
    assert.equal(r2.ok, false)
    assert.match(r2.ok ? '' : r2.error, /找不到 python/)
  })

  it('未知扩展名 → fail-closed，且错误里点明原因（不再弹选取应用）', () => {
    const r = resolveHookCommand('C:\\proj\\x.zzq', { platform: win, env: envWith(), exists: noExists })
    assert.equal(r.ok, false)
    assert.match(r.ok ? '' : r.error, /没有为 ".zzq" 注册解释器/)
    assert.match(r.ok ? '' : r.error, /#198/)
  })

  it('无扩展名 → 同样 fail-closed', () => {
    const r = resolveHookCommand('C:\\proj\\noext', { platform: win, env: envWith(), exists: noExists })
    assert.equal(r.ok, false)
    assert.match(r.ok ? '' : r.error, /无扩展名/)
  })

  it('POSIX：保持原行为（脚本自身 + shell:true，#! 仍生效）', () => {
    for (const platform of ['darwin', 'linux'] as NodeJS.Platform[]) {
      const r = resolveHookCommand('/proj/x.sh', { platform, env: envWith(), exists: noExists })
      assert.equal(r.ok, true, platform)
      assert.equal(r.ok ? r.cmd : '', '/proj/x.sh', platform)
      assert.deepEqual(r.ok ? r.args : [], [], platform)
      assert.equal(r.ok ? r.shell : false, true, platform)
    }
  })
})

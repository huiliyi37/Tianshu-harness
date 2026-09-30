import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join, posix } from 'node:path'
import {
  resolveNpmCliCommand,
  buildStdioEnvWithNodePath,
} from '../resolve-node-cli.js'

describe('resolveNpmCliCommand', () => {
  it('rewrites bare npx to node + npx-cli.js on win32 layout', () => {
    const execPath = 'C:\\app\\node-runtime\\win-x64\\node.exe'
    const cli = 'C:\\app\\node-runtime\\win-x64\\node_modules\\npm\\bin\\npx-cli.js'
    const r = resolveNpmCliCommand('npx', ['-y', '@pkg/mcp'], {
      execPath,
      platform: 'win32',
      existsSync: (p) => p === cli,
    })
    assert.equal(r.command, execPath)
    assert.deepEqual(r.args, [cli, '-y', '@pkg/mcp'])
  })

  it('rewrites npx.cmd the same way', () => {
    const execPath = 'C:\\app\\node.exe'
    const cli = 'C:\\app\\node_modules\\npm\\bin\\npx-cli.js'
    const r = resolveNpmCliCommand('npx.cmd', ['-y', 'x'], {
      execPath,
      platform: 'win32',
      existsSync: (p) => p === cli,
    })
    assert.equal(r.command, execPath)
    assert.equal(r.args[0], cli)
  })

  it('rewrites npm on unix lib/ layout', () => {
    const execPath = '/opt/node/bin/node'
    const cli = '/opt/node/lib/node_modules/npm/bin/npm-cli.js'
    const r = resolveNpmCliCommand('npm', ['install'], {
      execPath,
      platform: 'darwin',
      existsSync: (p) => p === cli,
    })
    assert.equal(r.command, execPath)
    assert.deepEqual(r.args, [cli, 'install'])
  })

  it('passes through unknown commands', () => {
    const r = resolveNpmCliCommand('python', ['-m', 'server'], {
      existsSync: () => true,
    })
    assert.equal(r.command, 'python')
    assert.deepEqual(r.args, ['-m', 'server'])
  })

  it('passes through npx when cli.js is missing', () => {
    const r = resolveNpmCliCommand('npx', ['-y', 'x'], {
      execPath: '/usr/bin/node',
      platform: 'linux',
      existsSync: () => false,
    })
    assert.equal(r.command, 'npx')
    assert.deepEqual(r.args, ['-y', 'x'])
  })
})

describe('buildStdioEnvWithNodePath', () => {
  it('always prepends nodeDir and keeps user PATH after it', () => {
    const env = buildStdioEnvWithNodePath(
      { PATH: '/usr/bin', TOKEN: 'secret' },
      {
        execPath: '/opt/node/bin/node',
        platform: 'linux',
        getDefaultEnvironment: () => ({ PATH: '/default', HOME: '/home/u' }),
      },
    )
    assert.equal(env.TOKEN, 'secret')
    assert.equal(env.HOME, '/home/u')
    assert.equal(env.PATH, '/opt/node/bin:/usr/bin')
  })

  it('user PATH cannot displace nodeDir (written last)', () => {
    const env = buildStdioEnvWithNodePath(
      { PATH: 'C:\\Users\\me' },
      {
        execPath: 'C:\\app\\node.exe',
        platform: 'win32',
        getDefaultEnvironment: () => ({ PATH: 'C:\\Windows' }),
      },
    )
    assert.ok(env.PATH?.startsWith(`C:\\app;`))
    assert.ok(env.PATH?.includes('C:\\Users\\me'))
  })

  it('works when cfg.env is omitted', () => {
    // darwin 场景的输入必须用 posix.join 构造——宿主 join() 在 Windows 上产
    // '\opt\node\bin\node'，被平台语义解释成相对路径（探针实测 PATH 变 ".:/usr/bin"）。
    const env = buildStdioEnvWithNodePath(undefined, {
      execPath: posix.join('/opt', 'node', 'bin', 'node'),
      platform: 'darwin',
      getDefaultEnvironment: () => ({ PATH: '/usr/bin' }),
    })
    assert.ok(env.PATH?.startsWith(posix.join('/opt', 'node', 'bin') + ':'))
  })

  // ── issue #149：基座 PATH 缺失时的静默退化 ──────────────────────────
  // 旧实现 `PATH: pathRest ? nodeDir+sep+pathRest : nodeDir` 在基座给不出 PATH 时
  // 只留 node 目录。npx 解析包要 spawn cmd.exe，它不在 node 目录里——子进程秒退，
  // 报出来只是 -32000，看不出根因。

  it('基座 PATH 缺失时补系统目录，而不是只剩 nodeDir', () => {
    const env = buildStdioEnvWithNodePath(undefined, {
      execPath: 'C:\\app\\node.exe',
      platform: 'win32',
      // MCP SDK 1.29.0 之前的 win32 白名单就是这样：有 SYSTEMROOT 没有 PATH。
      getDefaultEnvironment: () => ({ SYSTEMROOT: 'C:\\Windows' }),
    })
    assert.equal(
      env.PATH,
      'C:\\app;C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem',
      'PATH 只剩 node 目录时 npx 找不到 cmd.exe',
    )
  })

  it('兜底读 SystemRoot，不硬写 C:\\Windows（系统装在非 C 盘时硬写等于没兜底）', () => {
    const env = buildStdioEnvWithNodePath(undefined, {
      execPath: 'D:\\app\\node.exe',
      platform: 'win32',
      getDefaultEnvironment: () => ({ SYSTEMROOT: 'D:\\Win' }),
    })
    assert.ok(env.PATH?.includes('D:\\Win\\System32'))
    assert.ok(!env.PATH?.includes('C:\\Windows'))
  })

  it('基座 PATH 正常时不追加兜底目录（行为与改动前逐字一致）', () => {
    const env = buildStdioEnvWithNodePath(undefined, {
      execPath: 'C:\\app\\node.exe',
      platform: 'win32',
      getDefaultEnvironment: () => ({ PATH: 'C:\\Windows\\System32', SYSTEMROOT: 'C:\\Windows' }),
    })
    assert.equal(env.PATH, 'C:\\app;C:\\Windows\\System32')
  })

  it('POSIX 不猜系统目录——基座缺 PATH 时宁可只给 nodeDir', () => {
    const env = buildStdioEnvWithNodePath(undefined, {
      execPath: '/opt/node/bin/node',
      platform: 'linux',
      getDefaultEnvironment: () => ({}),
    })
    assert.equal(env.PATH, '/opt/node/bin')
  })
})

// ── issue #149 根因 B：CWD 命中同名 .js（cmd 按 PATHEXT 打开而非执行）──
// cmd /d /s /c <bin名> 的搜索顺序是「CWD 优先、再 PATH」——CWD 里存在与 bin 同名的
// .js 时，cmd 用文件关联打开它（记事本），PATH 里的 .cmd shim 永远到不了 → 秒退
// -32000。剔除脚本宿主扩展后，cmd 只认真正可执行的扩展，npx 的 .cmd shim 正常命中。

describe('buildStdioEnvWithNodePath — PATHEXT 净化（issue #149 根因 B）', () => {
  it('win32: 剔除脚本宿主扩展，保留真正可执行扩展', () => {
    const env = buildStdioEnvWithNodePath(undefined, {
      execPath: 'C:\\app\\node.exe',
      platform: 'win32',
      getDefaultEnvironment: () => ({ PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC' }),
    })
    assert.equal(env.PATHEXT, '.COM;.EXE;.BAT;.CMD')
  })

  it('win32: 基座未给 PATHEXT 时显式补安全默认（留空会让 cmd 回落系统默认——又含 .JS）', () => {
    const env = buildStdioEnvWithNodePath(undefined, {
      execPath: 'C:\\app\\node.exe',
      platform: 'win32',
      getDefaultEnvironment: () => ({ SYSTEMROOT: 'C:\\Windows' }),
    })
    assert.equal(env.PATHEXT, '.COM;.EXE;.BAT;.CMD')
  })

  it('win32: Pathext 大小写变体同样净化并归一为单键（不留重复键）', () => {
    const env = buildStdioEnvWithNodePath(undefined, {
      execPath: 'C:\\app\\node.exe',
      platform: 'win32',
      getDefaultEnvironment: () => ({ Pathext: '.JS;.CMD' }),
    })
    assert.equal(env.PATHEXT, '.CMD')
    assert.equal((env as Record<string, unknown>).Pathext, undefined)
  })

  it('POSIX 不注入 PATHEXT（cmd 语义不存在，逐字保持现状）', () => {
    const env = buildStdioEnvWithNodePath(undefined, {
      execPath: '/opt/node/bin/node',
      platform: 'linux',
      getDefaultEnvironment: () => ({ PATH: '/usr/bin' }),
    })
    assert.equal((env as Record<string, unknown>).PATHEXT, undefined)
  })
})

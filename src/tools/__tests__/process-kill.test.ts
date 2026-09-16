import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { killProcessTree, taskkillArgs, jobLaunchArgv, spawnShell } from '../process-kill.js'

// 注：这里显式传 platform，让两个分支在任意 CI 主机上都能被测到。
// （此前该文件隐式依赖宿主平台：Windows 上注入的 kill spy 永远走不到，两个用例静默变红。）
describe('killProcessTree (unix)', () => {
  it('kills the process group by negative pid', () => {
    const calls: Array<[number, NodeJS.Signals]> = []
    const child = { pid: 1234, kill: () => assert.fail('single process fallback should not be used') }

    killProcessTree(child, 'SIGTERM', (pid, signal) => { calls.push([pid, signal]) }, 'linux')

    assert.deepEqual(calls, [[-1234, 'SIGTERM']])
  })

  it('falls back to single process kill when process group kill fails', () => {
    const signals: NodeJS.Signals[] = []
    const child = { pid: 1234, kill: (signal: NodeJS.Signals) => { signals.push(signal); return true } }

    killProcessTree(child, 'SIGKILL', () => { throw new Error('missing process group') }, 'linux')

    assert.deepEqual(signals, ['SIGKILL'])
  })
})

describe('killProcessTree (win32)', () => {
  it('always passes /F — the non-/F "graceful" pass is a no-op for console children (issue #144)', () => {
    const seen: string[][] = []
    const child = { pid: 1234, kill: () => assert.fail('POSIX signals do not apply on Windows') }

    killProcessTree(child, 'SIGTERM', () => assert.fail('kill() must not be used on Windows'), 'win32', (args) => { seen.push(args) })

    assert.deepEqual(seen, [['/F', '/T', '/PID', '1234']])
  })

  it('uses the same force args for SIGKILL', () => {
    const seen: string[][] = []
    const child = { pid: 4321, kill: () => assert.fail('POSIX signals do not apply on Windows') }

    killProcessTree(child, 'SIGKILL', () => assert.fail('kill() must not be used on Windows'), 'win32', (args) => { seen.push(args) })

    assert.deepEqual(seen, [['/F', '/T', '/PID', '4321']])
  })

  it('does nothing when the child has no pid', () => {
    const seen: string[][] = []
    const child = { pid: undefined, kill: () => assert.fail('no pid, nothing to kill') }

    killProcessTree(child, 'SIGTERM', () => assert.fail('kill() must not be used on Windows'), 'win32', (args) => { seen.push(args) })

    assert.deepEqual(seen, [])
  })
})

describe('taskkillArgs', () => {
  it('returns force-terminate args (regression guard: do not reintroduce a non-/F graceful pass)', () => {
    assert.deepEqual(taskkillArgs(7), ['/F', '/T', '/PID', '7'])
  })
})

// 作业持有者接线（issue #144 本体）。注入 launcher/spawnFn，让两条分支在任意 CI 主机上都能断言。
describe('spawnShell (job launcher wiring)', () => {
  const shell = { cmd: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['-c'] }
  const record = () => {
    const calls: Array<{ file: string; args: string[]; options: unknown }> = []
    const spawnFn = ((file: string, args: string[], options: unknown) => {
      calls.push({ file, args: args ?? [], options })
      return { pid: 1, kill: () => true } as unknown as ReturnType<typeof spawnShell>
    }) as unknown as Parameters<typeof spawnShell>[4]
    return { calls, spawnFn }
  }

  it('falls back to spawning the shell directly when no launcher is available (fail-open)', () => {
    const { calls, spawnFn } = record()
    spawnShell(shell, 'echo hi', { cwd: '/tmp' }, null, spawnFn)

    assert.equal(calls.length, 1)
    const call = calls[0]
    assert.ok(call)
    assert.equal(call.file, shell.cmd)
    assert.deepEqual(call.args, ['-c', 'echo hi'])
    assert.deepEqual(call.options, { cwd: '/tmp' })
  })

  it('routes through the launcher, passing cwd and parent pid before the real command', () => {
    const { calls, spawnFn } = record()
    spawnShell(shell, 'echo hi', { cwd: '/tmp/work' }, 'C:\\tools\\job-launch.exe', spawnFn)

    assert.equal(calls.length, 1)
    const call = calls[0]
    assert.ok(call)
    assert.equal(call.file, 'C:\\tools\\job-launch.exe')
    assert.deepEqual(call.args, [
      '--cwd', '/tmp/work',
      '--parent-pid', String(process.pid),
      shell.cmd, '-c', 'echo hi',
    ])
    // 选项原样透传：stdio / detached / windowsHide 语义不变（bash 直接继承这些句柄）
    assert.deepEqual(call.options, { cwd: '/tmp/work' })
  })

  it('uses process.cwd() for --cwd when the spawn options carry no cwd', () => {
    const { calls, spawnFn } = record()
    spawnShell(shell, 'echo hi', {}, 'launcher.exe', spawnFn)

    const call = calls[0]
    assert.ok(call)
    assert.equal(call.args[1], process.cwd())
  })
})

describe('jobLaunchArgv', () => {
  it('keeps the command as one argv element (no shell re-quoting on our side)', () => {
    const argv = jobLaunchArgv({ cmd: 'bash', args: ['-c'] }, 'echo "a b" | wc -l', '/tmp', 4242)
    assert.deepEqual(argv, ['--cwd', '/tmp', '--parent-pid', '4242', 'bash', '-c', 'echo "a b" | wc -l'])
  })
})

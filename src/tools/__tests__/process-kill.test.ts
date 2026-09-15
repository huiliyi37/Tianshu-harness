import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { killProcessTree, taskkillArgs } from '../process-kill.js'

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

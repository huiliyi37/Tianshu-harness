import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { track, killAllSync, getActiveCount } from '../process-tracker.js'

function fakeChild(pid: number) {
  const signals: string[] = []
  return {
    proc: { pid, kill: (s: string) => { signals.push(s) }, on: () => {} } as any,
    signals,
  }
}

// 注：这里显式传 platform，让两个分支在任意 CI 宿主上都能被测到。
// （此前本文件隐式依赖宿主平台：Windows 上 killProcessTree 走 taskkill 分支，
//  注入的 child.kill 永不触发，用例静默恒红——与 process-kill.test.ts 同款修法。）
describe('killAllSync', () => {
  it('SIGKILLs tracked children inline and clears the set (unix)', () => {
    const a = fakeChild(2_000_000_001) // no such pgid → process.kill throws → falls back to child.kill
    const b = fakeChild(2_000_000_002)
    track(a.proc)
    track(b.proc)
    assert.equal(getActiveCount(), 2)
    killAllSync('linux')
    assert.equal(getActiveCount(), 0)
    assert.ok(a.signals.includes('SIGKILL'))
    assert.ok(b.signals.includes('SIGKILL'))
  })

  // 回归守卫（issue #185）：win32 上 killProcessTree 忽略 signal（process-kill.ts:64-65），
  // 同步路径没有等待窗口，第二发与第一发参数逐字相同——只剩 spawnSync 空转。
  // 每个子进程必须恰好一次 taskkill；多一次就是回归。
  it('win32: 每个子进程恰好发一次 taskkill（不得回归成两遍）', () => {
    const seen: string[][] = []
    // 不可能的 PID：RED 阶段（老代码）会真的 spawnSync taskkill，用真实区间 PID 有误杀风险
    const a = fakeChild(2_000_000_001)
    const b = fakeChild(2_000_000_002)
    track(a.proc)
    track(b.proc)

    killAllSync('win32', (args) => { seen.push(args) })

    assert.equal(getActiveCount(), 0)
    assert.deepEqual(seen, [
      ['/F', '/T', '/PID', '2000000001'],
      ['/F', '/T', '/PID', '2000000002'],
    ])
  })
})

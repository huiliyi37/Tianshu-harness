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

  // issue #398：Windows 注销/关机阶段会话拆除中，新进程 DLL 初始化大量失败
  // （0xC0000142），退出路径 spawnSync('taskkill') 的加载器弹系统硬错误框
  // （NtRaiseHardError，windowsHide 压不住）阻塞关机。退出路径必须零 spawn、
  // 进程内直杀（child.kill = TerminateProcess）。树杀兜底：经 job-launch.exe
  // 的壳由 Job Object KILL_ON_JOB_CLOSE 收树（#144），注销场景由会话拆除收余。
  it('win32: 退出路径零 spawn——不发 taskkill，进程内直杀（issue #398）', () => {
    const seen: string[][] = []
    // 不可能的 PID：不误杀真实进程
    const a = fakeChild(2_000_000_001)
    const b = fakeChild(2_000_000_002)
    track(a.proc)
    track(b.proc)

    killAllSync('win32', (args) => { seen.push(args) })

    assert.equal(getActiveCount(), 0)
    assert.deepEqual(seen, [], '退出路径不得 spawn taskkill（issue #398）')
    assert.ok(a.signals.includes('SIGKILL'), '必须进程内直杀')
    assert.ok(b.signals.includes('SIGKILL'), '必须进程内直杀')
  })
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('failed Git context reads drain sibling children before returning', { timeout: 10_000 }, async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'volatile-git-drain-'))
  const probes: Array<{ closed: boolean; done: Promise<void> }> = []
  const execFile = childProcess.execFile
  childProcess.execFile = ((command: string, args: string[], options: object, callback: (...args: unknown[]) => void) => {
    if (command !== 'git') return execFile(command, args, options, callback as never)
    const script = args[0] === 'branch'
      ? 'process.exitCode = 1'
      : 'setTimeout(() => process.stdout.write("context"), 250)'
    const child = execFile(process.execPath, ['-e', script], { ...options, windowsHide: true }, callback as never)
    const probe = { closed: false, done: Promise.resolve() }
    probe.done = new Promise<void>(resolve => child.once('close', () => { probe.closed = true; resolve() }))
    probes.push(probe)
    return child
  }) as typeof execFile
  syncBuiltinESMExports()
  t.after(async () => {
    await Promise.all(probes.map(probe => probe.done))
    childProcess.execFile = execFile
    syncBuiltinESMExports()
    rmSync(cwd, { recursive: true, force: true })
  })
  const { gitStatusCache, getGitInjectedContext } = await import('../volatile-git.js')
  await t.test('status refresh', async () => {
    await gitStatusCache.refresh(cwd)
    assert.equal(gitStatusCache.get(cwd), undefined)
    assert.ok(probes.every(probe => probe.closed), 'failed status must not return with sibling Git processes still holding cwd')
  })
  await t.test('injected worktree context', async () => {
    assert.equal(await getGitInjectedContext(cwd), undefined)
    assert.ok(probes.every(probe => probe.closed), 'failed context must not return with sibling Git processes still holding cwd')
  })
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { captureGitBaselineAsync } from '../git-baseline-async.js'

for (const abort of [false, true]) {
  test(`baseline waits for all Git process close events after ${abort ? 'caller abort' : 'probe failure'}`, async (t) => {
    const callbacks: Array<(error: Error | null, stdout: string, stderr: string) => void> = []
    const children: EventEmitter[] = []
    t.mock.method(childProcess, 'execFile', (_command: string, _args: string[], _options: unknown, callback: typeof callbacks[number]) => {
      callbacks.push(callback)
      const child = new EventEmitter()
      children.push(child)
      return child as ReturnType<typeof childProcess.execFile>
    })
    syncBuiltinESMExports()
    const controller = new AbortController()
    let settled = false
    const result = captureGitBaselineAsync(process.cwd(), controller.signal)
    const observed = result.then(value => ({ value }), error => ({ error })).finally(() => { settled = true })
    try {
      assert.equal(callbacks.length, 4)
      if (abort) controller.abort(new Error('QA caller cancelled'))
      callbacks[0]!(new Error('QA Git failed'), '', '')
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(settled, false, 'remaining Git processes must finish before the caller can clean up its workspace')
      callbacks.slice(1).forEach(callback => callback(null, '', ''))
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(settled, false, 'execFile error callbacks may arrive before process close; callbacks alone cannot permit workspace cleanup')
      children.slice(0, 3).forEach(child => child.emit('close', 1, null))
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(settled, false, 'every probe must close before workspace cleanup, including the final child')
      children[3]!.emit('close', 0, null)
    } finally {
      callbacks.slice(1).forEach(callback => callback(null, '', ''))
      children.forEach(child => child.emit('close', 0, null))
      t.mock.restoreAll()
      syncBuiltinESMExports()
    }
    const outcome = await observed
    if (abort) assert.equal('error' in outcome && outcome.error, controller.signal.reason)
    else assert.equal('value' in outcome && outcome.value.complete, false)
  })
}

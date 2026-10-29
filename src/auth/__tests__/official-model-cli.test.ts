import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runOfficialModelCLI } from '../../cli/official-model-cli.js'

test('CLI streams device approval progress while awaiting the explicit successful result', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let progress = '', finished = false
  const run = runOfficialModelCLI(['account', 'login'], {
    write: line => { progress += line },
    login: async (app, onResult) => {
      onResult?.(false)
      app.commitStatic('synthetic-device-approval')
      await gate
      onResult?.(true)
      return true
    },
  }).then(result => { finished = true; return result })
  try {
    await Promise.resolve()
    assert.equal(progress, 'synthetic-device-approval')
    assert.equal(finished, false)
    release()
    assert.equal((await run).exitCode, 0)
    assert.equal(progress, 'synthetic-device-approval')
  } finally { release(); await run }
})

test('CLI handled-login return values cannot promote failed or cancelled device authorization', async () => {
  for (const signal of ['failed', 'cancelled', 'no-result']) {
    const result = await runOfficialModelCLI(['account', 'login'], {
      login: async (app, onResult) => {
        if (signal !== 'no-result') onResult?.(false)
        app.commitStatic(signal)
        return true
      },
    })
    assert.equal(result.exitCode, 1, signal)
    assert.equal(result.output, signal)
  }
})

test('CLI uses the persisted-approval callback rather than the TUI handled boolean', async () => {
  const result = await runOfficialModelCLI(['account', 'login'], {
    login: async (_app, onResult) => { onResult?.(true); return false },
  })
  assert.equal(result.exitCode, 0)
})

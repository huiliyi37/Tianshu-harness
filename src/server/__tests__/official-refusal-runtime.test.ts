import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { OfficialError } from '../../models/official-contract.js'
import { SessionRuntimePool } from '../session-runtime-pool.js'
import type { RuntimeSessionManager } from '../session-manager.js'
import { TaskRegistry } from '../task-registry.js'
import { JsonTaskStore } from '../task-store.js'

test('runtime pool propagates the native refusal even when a competing terminal status is already recorded', async () => {
  const refusal = new OfficialError('account_changed')
  let runs = 0
  const manager = {
    createSession: () => ({ id: 'synthetic-session' }),
    abort() {},
    runAndWait: async () => {
      runs++
      return { status: 'completed', summary: 'synthetic terminal race', changedFiles: [], officialFailure: refusal }
    },
  } as unknown as RuntimeSessionManager
  const pool = new SessionRuntimePool({ manager, defaultCwd: '/synthetic-workspace' })
  const handle = await pool.acquire('synthetic-task')
  try {
    await assert.rejects(handle.execute('synthetic unsent draft', new AbortController().signal), error => error === refusal)
    assert.equal(runs, 1)
  } finally { handle.release() }
})

test('account_changed stops automatic task retries and publishes the refusal without resending the draft', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tianshu-official-task-'))
  const store = new JsonTaskStore(home)
  let executions = 0
  const observed: string[] = []
  const registry = new TaskRegistry({ taskStore: store, runtimePool: {
    size: 0,
    acquire: async () => ({
      execute: async () => { executions++; throw new OfficialError('account_changed') },
      release() {},
    }),
  } })
  const unsubscribe = registry.subscribeOfficialRefusal(record => { observed.push(record.officialFailure!) })
  try {
    const created = await registry.createTask({ prompt: 'synthetic unsent draft', source: 'cron', scheduledTaskId: 'synthetic-schedule', retry: { maxAttempts: 3, backoffMs: 1 } })
    const deadline = Date.now() + 5000
    let records = await registry.listTasks()
    while (records[0]?.status !== 'failed' && Date.now() < deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, 5))
      records = await registry.listTasks()
    }
    assert.equal(records[0]?.status, 'failed')
    await new Promise<void>(resolve => setTimeout(resolve, 60))
    records = await registry.listTasks()
    assert.equal(records.length, 1)
    assert.equal(records[0]?.id, created.id)
    assert.equal(records[0]?.officialFailure, 'account_changed')
    assert.equal(executions, 1)
    assert.deepEqual(observed, ['account_changed'])
  } finally {
    unsubscribe()
    registry.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

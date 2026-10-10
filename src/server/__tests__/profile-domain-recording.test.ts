import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import { FileSessionPersistence } from '../session-persistence.js'
import { aggregateDomainUsage } from '../profile-routes.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'

test('manager persists actual usage once, suppresses recovery and survives restart', { timeout: 120_000 }, async (t) => {
  const baseDir = mkdtempSync(join(tmpdir(), 'profile-domain-'))
  const persistence = new FileSessionPersistence(baseDir)
  const agent: ManagedAgent = {
    run: async (_prompt, callbacks: AgentCallbacks) => { callbacks.onDomainUsed?.('kaiyang'); callbacks.onDomainUsed?.('kaiyang') },
    abort: () => {}, listArtifacts: () => [], readArtifact: async () => null, getMessages: () => [],
    replaceMessages: () => {}, rewindToMessages: () => {},
  }
  const manager = new RuntimeSessionManager({ createAgent: () => agent, defaultCwd: baseDir, persistence })
  let restarted: RuntimeSessionManager | undefined
  let reopened: FileSessionPersistence | undefined
  t.after(async () => {
    await manager.shutdownAll()
    await persistence.flushAllAsync()
    await restarted?.shutdownAll()
    await reopened?.flushAllAsync()
    rmSync(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })
  const record = manager.createSession({ domain: 'auto' })
  const waitForSettled = async () => {
    while (manager.getSession(record.id)?.status === 'running') {
      t.signal.throwIfAborted()
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal(await manager.waitForRunSettled(record.id), true)
  }
  assert.equal(manager.run(record.id, 'measure'), true)
  await waitForSettled()
  assert.equal(manager.run(record.id, 'recover', undefined, true), true)
  await waitForSettled()
  const measuredRun = manager.getEvents(record.id)!.events.find(e => e.type === 'user')!.runId
  assert.ok(measuredRun)
  await manager.shutdownAll()
  await persistence.flushAllAsync()
  reopened = new FileSessionPersistence(baseDir)
  restarted = new RuntimeSessionManager({ createAgent: () => agent, defaultCwd: baseDir, persistence: reopened })
  assert.equal(restarted.getSession(record.id)?.model, record.model)
  const restored = restarted.getEvents(record.id)!.events
  assert.equal(restored.filter(e => e.type === 'domain_usage').length, 1)
  const usage = restored.find(e => e.type === 'domain_usage')!
  assert.equal(usage.runId, measuredRun)
  assert.equal(usage.data.sourceSessionId, record.id)
  assert.equal(aggregateDomainUsage([{ id: record.id, events: restored }], 30).domains[0]?.key, 'kaiyang')
})

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { configSchema } from '../../config/schema.js'
import { RuntimeSessionManager } from '../session-manager.js'

function listingFixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'tianshu-model-listing-'))
  const config = configSchema.parse({ provider: { default: 'synthetic-byok', providers: {} } })
  let modelReads = 0
  let contextWindow = 128000
  let fail = false
  const manager = new RuntimeSessionManager({
    createAgent: () => { throw new Error('record enrichment must not construct agents') },
    defaultCwd: cwd,
    defaultModelId: 'synthetic-byok:synthetic-model',
    readSessionConfig: () => config,
    idleAgentTtlMs: 0,
    listModels: () => {
      modelReads++
      if (fail) throw new Error('synthetic unavailable catalog')
      return [{ id: 'synthetic-model', alias: 'Synthetic model', provider: 'synthetic-byok', contextWindow }]
    },
  })
  const first = manager.createSession({ cwd })
  const second = manager.createSession({ cwd })
  const archived = manager.createSession({ cwd })
  assert.equal(manager.archiveSession(archived.id), true)
  modelReads = 0
  return {
    manager, first, second, archived,
    get modelReads() { return modelReads },
    set contextWindow(value: number) { contextWindow = value },
    set fail(value: boolean) { fail = value },
    close: () => rmSync(cwd, { recursive: true, force: true }),
  }
}

test('getSession reads one fresh catalog per operation instead of retaining an authorization-adjacent cache', () => {
  const fixture = listingFixture()
  try {
    assert.equal(fixture.manager.getSession(fixture.first.id)?.contextWindow, 128000)
    assert.equal(fixture.modelReads, 1)
    fixture.contextWindow = 256000
    assert.equal(fixture.manager.getSession(fixture.first.id)?.contextWindow, 256000)
    assert.equal(fixture.modelReads, 2)
    assert.equal(fixture.manager.getSession('missing'), undefined)
    assert.equal(fixture.modelReads, 2)
  } finally { fixture.close() }
})

test('listAllSessions shares one catalog view for live and archived records and refreshes the next operation', () => {
  const fixture = listingFixture()
  try {
    const first = fixture.manager.listAllSessions()
    assert.equal(fixture.modelReads, 1)
    assert.deepEqual(first.map(record => record.id), [fixture.first.id, fixture.second.id, fixture.archived.id])
    assert.deepEqual(first.map(record => record.contextWindow), [128000, 128000, 128000])
    fixture.contextWindow = 256000
    const second = fixture.manager.listAllSessions()
    assert.equal(fixture.modelReads, 2)
    assert.deepEqual(second.map(record => record.contextWindow), [256000, 256000, 256000])
  } finally { fixture.close() }
})

test('listSessions shares one catalog view without exposing archived sessions', () => {
  const fixture = listingFixture()
  try {
    const records = fixture.manager.listSessions()
    assert.equal(fixture.modelReads, 1)
    assert.deepEqual(records.map(record => record.id), [fixture.first.id, fixture.second.id])
    assert.deepEqual(records.map(record => record.contextWindow), [128000, 128000])
  } finally { fixture.close() }
})

test('one failed catalog read stays local to its list operation and does not trigger per-session retries', () => {
  const fixture = listingFixture()
  try {
    fixture.fail = true
    assert.deepEqual(fixture.manager.listAllSessions().map(record => record.contextWindow), [undefined, undefined, undefined])
    assert.equal(fixture.modelReads, 1)
    fixture.fail = false
    assert.deepEqual(fixture.manager.listAllSessions().map(record => record.contextWindow), [128000, 128000, 128000])
    assert.equal(fixture.modelReads, 2)
  } finally { fixture.close() }
})

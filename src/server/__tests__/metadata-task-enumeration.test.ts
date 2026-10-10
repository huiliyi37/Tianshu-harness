import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonTaskStore, type TaskRecord } from '../task-store.js'
import { setServerLogger, resetServerLogger } from '../logger.js'

const metadata = Buffer.from([0, 5, 22, 7, 0, 2, 0, 0, ...Array(24).fill(0)])

test('Task listing leaves binary metadata untouched without false corruption warnings; real invalid tasks remain quarantined', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-metadata-enumeration-'))
  const warnings: Array<{ message: string; context?: Record<string, unknown> }> = []
  setServerLogger({ info() {}, warn(message, context) { warnings.push({ message, context }) }, error(message) { assert.fail(message) } })
  try {
    const task: TaskRecord = { id: 'real-task', prompt: 'synthetic task', source: 'manual', status: 'pending', createdAt: '2026-10-10T00:00:00.000Z', timeoutMs: 10_000, callerId: 'synthetic', idempotencyKey: 'synthetic-task', force: false }
    const store = new JsonTaskStore(dir)
    await store.save(task)
    const sidecar = join(dir, '._real-task.json')
    writeFileSync(sidecar, metadata)
    writeFileSync(join(dir, 'broken.json'), '{invalid JSON')
    writeFileSync(join(dir, '.notes.md'), 'ordinary hidden notes')
    assert.deepEqual((await store.list({ limit: 1 })).map(record => record.id), ['real-task'])
    console.log(JSON.stringify({ subject: 'task-quarantine', files: readdirSync(dir), warnings }))
    assert.ok(existsSync(sidecar), 'listing must not quarantine a filesystem sidecar')
    assert.deepEqual(readFileSync(sidecar), metadata)
    assert.equal(warnings.length, 1, 'only the genuinely broken task should emit a corruption warning')
    assert.equal(warnings[0]!.context?.path, join(dir, 'broken.json'))
    assert.ok(readdirSync(dir).some(name => name.startsWith('broken.json.corrupt-')))
    assert.equal(readFileSync(join(dir, '.notes.md'), 'utf8'), 'ordinary hidden notes')
    assert.equal((await store.findActiveByIdempotencyKey('synthetic-task'))?.id, 'real-task')
  } finally { resetServerLogger(); rmSync(dir, { recursive: true, force: true }) }
})

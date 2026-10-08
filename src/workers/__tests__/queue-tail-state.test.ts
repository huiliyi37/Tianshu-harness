import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readEventsTailRaw } from '../events-tail.js'
import { readEventsTailIndexed } from '../events-summary.js'
import { clearEventsSummaryCache } from '../events-summary-store.js'

test('raw and cached tails retain every pending queue ID outside the replay window', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-tail-state-'))
  const file = join(dir, 'events.jsonl')
  t.after(() => { clearEventsSummaryCache(file); rmSync(dir, { recursive: true, force: true }) })
  const events = Array.from({ length: 1600 }, (_, i) => ({ seq: i + 1, ts: 1, type: 'text_delta', data: { text: 'fictional' } } as { seq: number; ts: number; type: string; data: Record<string, unknown> }))
  events[0] = { seq: 1, ts: 1, type: 'queue_pending', data: { laneId: 'closed', text: 'fictional closed' } }
  events[1] = { seq: 2, ts: 1, type: 'queue_pending', data: { laneId: 'open-a', text: 'fictional accepted a' } }
  events[600] = { seq: 601, ts: 1, type: 'queue_status', data: { laneId: 'closed', status: 'merged' } }
  events[1100] = { seq: 1101, ts: 1, type: 'queue_pending', data: { laneId: 'open-b', text: 'fictional accepted b' } }
  writeFileSync(file, events.map(event => JSON.stringify(event)).join('\n') + '\n')
  const raw = await readEventsTailRaw(file, 1)
  assert.deepEqual((raw as unknown as { pendingQueueLaneIds: string[] }).pendingQueueLaneIds, ['open-a', 'open-b'])
  assert.deepEqual(raw.events.map(event => event.seq), [1600])
  for (let pass = 0; pass < 3; pass++) {
    if (pass === 1) clearEventsSummaryCache(file)
    const { tail } = await readEventsTailIndexed(file, 1)
    assert.deepEqual(tail, raw, 'scan, cold and warm index reads preserve the queue ledger')
  }
})

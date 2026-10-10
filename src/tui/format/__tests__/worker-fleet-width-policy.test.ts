import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildWorkerFleetLines } from '../worker-fleet.js'
import { displayWidth } from '../../width.js'
import type { FleetWorkerView } from '../../fleet-registry.js'

for (const mode of ['narrow', 'wide', 'full']) {
  test(`worker objective truncation reserves the ellipsis cells in ${mode} terminals`, () => {
    const previous = process.env.RIVET_AMBIGUOUS_WIDTH
    process.env.RIVET_AMBIGUOUS_WIDTH = mode
    try {
      const worker = {
        workerId: 'width-fixture', profile: 'code_scout', status: 'running',
        elapsedMs: 2000, toolUseCount: 0, tokenCount: 0,
        contract: { objective: 'a'.repeat(100) },
      } as FleetWorkerView
      const row = buildWorkerFleetLines([worker], undefined, 40)[1]!
      assert.ok(row.includes('…'), 'the long objective must be visibly truncated')
      assert.ok(displayWidth(row, { ambiguousAsWide: true }) <= 40, `${mode}: ${displayWidth(row, { ambiguousAsWide: true })} cells: ${row}`)
      assert.ok(row.endsWith('  2s'), 'the elapsed tail must remain intact')
    } finally {
      if (previous === undefined) delete process.env.RIVET_AMBIGUOUS_WIDTH
      else process.env.RIVET_AMBIGUOUS_WIDTH = previous
    }
  })
}

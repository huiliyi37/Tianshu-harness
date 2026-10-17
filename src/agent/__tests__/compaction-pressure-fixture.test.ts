import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildContextBudget } from '../../context/request-budget.js'
import { estimateOaiTokens } from '../../compact/micro.js'
import { writeFileAtomicDurableAsync } from '../../fs-atomic.js'
import { createBudgetedCompactionHistory, createCompactionPressureInput, isSnapshotDirectoryCollision } from './compaction-pressure-fixture.js'
import type { OaiMessage } from '../../api/oai-types.js'

for (const systemChars of [400, 2800]) {
  test(`history calibration preserves the fixed budget with a ${systemChars}-character prefix`, () => {
    const policy = { windowTokens: 4096, maxOutputTokens: 256, transportLimits: 'none' as const }
    const measure = (messages: OaiMessage[]) => buildContextBudget({
      model: 'fixture', max_tokens: 256, messages: [{ role: 'system', content: 's'.repeat(systemChars) }, ...messages],
    }, policy, { requestId: 'fixture-calibration', revision: 0 })
    const history = createBudgetedCompactionHistory(8, measure, 200)
    const budget = measure(history)
    assert.equal(history.length, 8)
    assert.equal(budget.windowTokens, 4096)
    assert.equal(budget.outputReserve, 256)
    assert.ok(budget.inputTokens <= budget.inputBudget - 256)
    assert.ok(history.every((message, index) => message.role === (index % 2 === 0 ? 'user' : 'assistant')))
  })
}

test('pressure input crosses the real 95% threshold without resizing capacity', () => {
  for (const occupancy of [640_000, 910_000, 938_000]) {
    const input = createCompactionPressureInput(occupancy, 1_000_000, 'UNSENT_USER: retain this exact input')
    const projected = occupancy + estimateOaiTokens([{ role: 'user', content: input }])
    assert.ok(projected > 950_000 && projected < 1_000_000)
    assert.ok(input.startsWith('UNSENT_USER: retain this exact input\n'))
  }
})

test('fixture calibration refuses to hide an invalid output budget', () => {
  assert.throws(() => createBudgetedCompactionHistory(2, messages => buildContextBudget({
    model: 'fixture', max_tokens: 512, messages,
  }, { windowTokens: 4096, maxOutputTokens: 128, transportLimits: 'none' }, {
    requestId: 'invalid-output', revision: 0,
  }), 2), /fixed prompt must leave room/)
})

test('directory collision matching never accepts unrelated permission failures', () => {
  const target = join(tmpdir(), 'owned-snapshot.json')
  const error = Object.assign(new Error('controlled rename collision'), { code: 'EPERM', path: `${target}.tmp`, dest: target })
  assert.equal(isSnapshotDirectoryCollision(error, target, 'win32'), true)
  assert.equal(isSnapshotDirectoryCollision(error, target, 'linux'), false)
  assert.equal(isSnapshotDirectoryCollision(error, `${target}.other`, 'win32'), false)
  assert.equal(isSnapshotDirectoryCollision(Object.assign(new Error('unrelated'), { code: 'EACCES', path: target }), target, 'win32'), false)
})

test('a real directory collision remains a rejected durable write', async () => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'snapshot-directory-collision-'))
  const target = join(root, 'frozen.json')
  try {
    mkdirSync(target)
    await assert.rejects(writeFileAtomicDurableAsync(target, '{}'), error => isSnapshotDirectoryCollision(error, target))
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})

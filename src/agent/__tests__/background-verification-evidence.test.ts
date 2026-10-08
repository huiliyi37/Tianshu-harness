import { it } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { runVerification } from './helpers/verification-pipeline-fixture.js'
import { getEffectiveVerifications } from '../verification-attribution.js'
import { unwrapVerification } from '../../tools/verification-invocation.js'
import { createTaskLedger } from '../task-ledger.js'

it('background queries with test/build words do not become blocked verification records', async () => {
  for (const command of ['ls good.test.mjs', 'node -e "console.log(1 /* build */)"', 'npm --version']) {
    const result = await runVerification(command, false, false, { background: true, expectedVerificationCount: 0 })
    assert.equal(result.ledger.getVerifications().length, 0, command)
    assert.doesNotMatch(result.actual.content, /无法自动获取完整证明|完成后自动记录/)
  }
})

it('background compound-shell launch returns the suggested command to the model', async () => {
  const result = await runVerification('node --test good.test.mjs | tail -5', false, false, { background: true })
  assert.equal(result.pipelineResult.toolResult.type, 'tool_result')
  if (result.pipelineResult.toolResult.type !== 'tool_result') assert.fail('expected tool result')
  assert.match(result.pipelineResult.toolResult.content, /可复制的单条命令：node --test good\.test\.mjs/)
  assert.equal(result.verification.status, 'blocked')
  assert.equal(result.verification.coverage?.complete ?? false, false)
})

it('background success/failure reaches evidence and ledger once without a tool wait', async () => {
  for (const fail of [false, true]) {
    const run = await runVerification('npm test', fail, false, { background: true })
    assert.match(run.actual.content, /完成后自动记录/)
    assert.equal(run.initialVerificationCount, 0)
    assert.equal(run.verification.status, fail ? 'failed' : 'passed')
    assert.equal(run.verification.coverage?.executionComplete, true)
    assert.equal(run.verification.countsReliable, true)
    assert.equal(run.verification.passed, fail ? 1 : 2)
    assert.equal(run.verification.failed, fail ? 1 : 0)
    const effective = getEffectiveVerifications(run.ledger.getVerifications()).effective
    assert.equal(effective.length, 1)
    assert.equal(effective[0]!.countsReliable, true)
    assert.equal(effective[0]!.executionId, run.verification.executionId)
    const latest = run.deliveryGate.getReport([]).latestVerificationTotals!
    assert.equal(latest.executionId, run.verification.executionId)
    assert.equal(latest.timestamp, run.verification.timestamp)
    assert.equal(latest.executionComplete, true)
    assert.equal(latest.countsReliable, true)
  }
})

it('legacy missing counts stay unknown and latest follows completion order after supersession', () => {
  const ledger = createTaskLedger({ taskId: 'legacy-counts' })
  ledger.record({ type: 'verification', command: 'npm test', status: 'failed', meta: { kind: 'test', scope: 'full' } })
  let records = getEffectiveVerifications(ledger.getVerifications()).effective
  assert.equal(records[0]?.passed, undefined)
  assert.equal(records[0]?.failed, undefined)
  assert.equal(records[0]?.countsReliable, undefined)
  ledger.record({ type: 'verification', command: 'node --test a.test.ts', status: 'passed', meta: { kind: 'test', scope: 'targeted' } })
  ledger.record({ type: 'verification', command: 'npm test', status: 'passed', meta: { kind: 'test', scope: 'full', executionId: 'last', countsReliable: true, passed: 10, failed: 0 } })
  records = getEffectiveVerifications(ledger.getVerifications()).effective
  assert.equal(records.at(-1)?.executionId, 'last')
})

it('literal wrappers and output redirects preserve execution; compound scripts get no proof', () => {
  const parsed = unwrapVerification("rtk proxy bash -c 'cd /tmp/project && npm test'", '/repo')
  assert.equal(parsed?.cwd, resolve('/tmp/project'))
  assert.equal(parsed?.command, 'npm test')
  const redirected = unwrapVerification('npm test > out 2>&1', '/repo')
  assert.equal(redirected?.command, 'npm test')
  assert.equal(redirected?.wrap('validator'), 'validator > out 2>&1')
  for (const command of ['npm test | tail', 'cd /tmp && npm test && echo done', "bash -c 'npm test; echo done'", 'node --test $(echo x)']) {
    assert.equal(unwrapVerification(command, '/repo'), undefined, command)
  }
})

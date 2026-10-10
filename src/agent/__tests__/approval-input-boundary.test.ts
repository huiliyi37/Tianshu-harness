import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approvedInputBlock } from '../approval-input-boundary.js'
import type { ToolPipelineDeps } from '../tool-pipeline.js'

const deps = (config = {}, reliability?: string) => ({
  cwd: '/fixture', config,
  getReliabilityDecision: () => reliability ? { mode: reliability, reason: 'fixture', blockedTools: ['bash', 'write_file', 'edit_file'] } : undefined,
}) as unknown as ToolPipelineDeps

test('approved inputs keep self-kill and bash denylist boundaries', () => {
  assert.equal(approvedInputBlock('bash', { command: 'pkill node' }, deps())?.gate, 'self-kill')
  assert.equal(approvedInputBlock('bash', { command: 'echo okay; blocked-fixture' }, deps({ permissions: { deny: [], bash: { denylist: ['blocked-fixture'] } } }))?.gate, 'deny')
  assert.equal(approvedInputBlock('bash', { command: 'echo okay' }, deps()), undefined)
})

test('approval waiting cannot waive a newly activated ask or reliability boundary', () => {
  assert.equal(approvedInputBlock('bash', { command: 'echo okay' }, deps({ askModeState: 'asking' }))?.gate, 'ask-mode')
  assert.equal(approvedInputBlock('bash', { command: 'echo okay' }, deps({}, 'minimal'))?.gate, 'reliability')
  assert.equal(approvedInputBlock('read_file', { file_path: 'fixture.txt' }, deps({}, 'minimal')), undefined)
})

test('final delegation profiles determine plan-mode safety', () => {
  assert.equal(approvedInputBlock('delegate_task', { profile: 'patcher' }, deps({ planModeState: 'planning' }))?.gate, 'plan-mode')
})

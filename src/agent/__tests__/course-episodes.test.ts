import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CourseEpisodes, drainSteerGuidance } from '../course-episodes.js'
import { WorkProgressFacts } from '../work-progress-facts.js'
import { captureCourseFileProgress } from '../course-file-progress.js'
import { AdvisoryReadback } from '../advisory-readback.js'
import { AdvisoryBus } from '../advisory-bus.js'
import { EvidenceTracker } from '../evidence.js'
import { ObligationTracker } from '../obligation-tracker.js'
import type { AgentLoop } from '../loop.js'
import type { AgentCallbacks } from '../loop-types.js'
import { SteerBuffer } from '../../tui/steer-buffer.js'

function fixture() {
  const todos: Array<{ id: string; status: string }> = []
  const self = {
    advisoryReadback: new AdvisoryReadback(),
    advisoryBus: new AdvisoryBus(),
    config: { getTodos: () => todos },
    obligations: new ObligationTracker(),
    evidence: new EvidenceTracker(),
    telemetryWriter: { write() {} },
    decisionShifts: { discard() {}, clearWarning() {} },
    workFacts: undefined as unknown as WorkProgressFacts,
  }
  self.workFacts = new WorkProgressFacts(self as unknown as AgentLoop)
  const controller = new CourseEpisodes(self as unknown as AgentLoop)
  // 真实链顺序：感知前 beginModelTurn（单次消费去重事实）→ 采样（读事实差值）。
  const tick = (modelTurn: number) => { self.workFacts.beginModelTurn(modelTurn); controller.sample() }
  return { self, controller, todos, tick }
}

test('only accepted human envelopes advance guidance once; worker/legacy text never does', async () => {
  const { self, controller } = fixture()
  const buffer = new SteerBuffer()
  buffer.pushNow('改为先审查测试')
  const callbacks = controller.callbacks({ onHumanGuidanceDrain: () => buffer.drainHuman() } as AgentCallbacks)
  const guidance = await drainSteerGuidance(callbacks)
  assert.equal(self.advisoryReadback.courseEpisode, 0, 'drain without acceptance is not delivery')
  guidance!.accepted(); guidance!.accepted()
  assert.equal(self.advisoryReadback.courseEpisode, 1)
  assert.equal(self.workFacts.taskEpoch, 0, 'guidance retains task ownership')
  await drainSteerGuidance(controller.callbacks({ onSteerDrain: () => '[User guidance] runtime convergence reminder' } as AgentCallbacks))
  assert.equal(self.advisoryReadback.courseEpisode, 1)
  controller.start('human-task')
  assert.equal(self.workFacts.taskEpoch, 1, 'accepted human-task is the only task boundary increment')
})

test('progress is deduplicated; failures, polling and repeated completed Todo never renew a course', () => {
  const { self, controller, todos, tick } = fixture()
  todos.push({ id: 'old', status: 'completed' })
  controller.start('human-task')
  tick(1); assert.equal(self.advisoryReadback.courseEpisode, 1)
  todos.push({ id: 'new', status: 'completed' })
  tick(2); assert.equal(self.advisoryReadback.courseEpisode, 2)
  tick(3); assert.equal(self.advisoryReadback.courseEpisode, 2)
  const failed = { command: 'node --test', status: 'failed' as const, scope: 'full' as const, kind: 'test' as const, exitCode: 1 }
  self.evidence.trackVerification(failed)
  tick(4); assert.equal(self.advisoryReadback.courseEpisode, 2)
  self.evidence.trackVerification({ ...failed, status: 'passed', exitCode: 0, countsReliable: true })
  tick(5); assert.equal(self.advisoryReadback.courseEpisode, 3)
  self.evidence.trackVerification({ ...failed, status: 'passed', exitCode: 0, countsReliable: true })
  tick(6); assert.equal(self.advisoryReadback.courseEpisode, 3)
})

test('progress never grants the human probation escape', () => {
  const { self, controller } = fixture()
  self.advisoryReadback.track([{ key: 'convergence', category: 'discipline', expect: { kind: 'course_changed' } }], 1)
  let grants = 0
  self.advisoryBus.grantEpisodeProbation = () => { grants++ }
  self.workFacts.beginModelTurn(1)
  self.workFacts.recordFileProgress({ outcome: 'changed', targets: [] })
  controller.sample()
  assert.equal(grants, 0)
  self.advisoryReadback.track([{ key: 'convergence', category: 'discipline', expect: { kind: 'course_changed' } }], 2)
  controller.start('human-guidance'); assert.equal(grants, 1)
})

test('file progress requires actual changed bytes; noop writes and dry-run AST edits do not count', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-course-files-'))
  try {
    const path = join(dir, 'a.ts')
    writeFileSync(path, 'one')
    const noop = await captureCourseFileProgress('write_file', { file_path: path }, dir)
    writeFileSync(path, 'one')
    assert.equal((await noop.finish({ isError: false })).outcome, 'unchanged')
    const changed = await captureCourseFileProgress('edit_file', { file_path: path }, dir)
    writeFileSync(path, 'two')
    assert.equal((await changed.finish({ isError: false })).outcome, 'changed')
    const dry = await captureCourseFileProgress('ast_edit', { paths: [path], dryRun: true }, dir)
    writeFileSync(path, 'three')
    assert.equal((await dry.finish({ isError: false })).outcome, 'unchanged')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a new task cannot claim a previous task failure or an unreliable passing test as progress', () => {
  const { self, controller, tick } = fixture()
  const failed = { command: 'node --test', kind: 'test' as const, scope: 'full' as const, status: 'failed' as const, exitCode: 1 }
  self.evidence.trackVerification(failed)
  controller.start('human-task')
  self.evidence.trackVerification({ ...failed, status: 'passed', exitCode: 0, countsReliable: true })
  tick(1); assert.equal(self.advisoryReadback.courseEpisode, 1)
  self.evidence.trackVerification({ ...failed })
  tick(2)
  self.evidence.trackVerification({ ...failed, status: 'passed', exitCode: 0 })
  tick(3); assert.equal(self.advisoryReadback.courseEpisode, 1)
})

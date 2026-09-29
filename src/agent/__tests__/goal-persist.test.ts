import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { GoalTracker } from '../goal-tracker.js'
import {
  goalStatePath,
  saveGoalState,
  loadGoalState,
  deleteGoalState,
  restoreGoalTracker,
} from '../goal-persist.js'

let tempDir: string
const sessionId = 'test-session-123'

beforeEach(() => {
  const base = join(process.cwd(), '.goal-persist-test-tmp')
  if (!existsSync(base)) mkdirSync(base, { recursive: true })
  tempDir = mkdtempSync(join(base, 'run-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('goalStatePath', () => {
  it('joins sessionDir and sessionId with .goal.json suffix', () => {
    const p = goalStatePath('/tmp/sessions', 'abc-123')
    // 期望值用 join 构造（平台无关）——Windows 上 join 产出反斜杠
    assert.equal(p, join('/tmp/sessions', 'abc-123.goal.json'))
  })
})

describe('saveGoalState / loadGoalState', () => {
  it('round-trips an active tracker', () => {
    const tracker = new GoalTracker({
      goal: 'Fix all bugs',
      maxIterations: 10,
      contextWindow: 128000,
    })
    tracker.advanceIteration()
    tracker.advanceIteration()

    saveGoalState(tempDir, sessionId, tracker)
    const record = loadGoalState(tempDir, sessionId)

    assert.ok(record !== null)
    assert.equal(record!.objective, 'Fix all bugs')
    assert.equal(record!.iterationsUsed, 2)
    assert.equal(record!.budgetLimits.maxIterations, 10)
  })

  it('returns null when no goal file exists', () => {
    const record = loadGoalState(tempDir, sessionId)
    assert.equal(record, null)
  })

  it('preserves wallClockMs in budgetLimits when set', () => {
    const tracker = new GoalTracker({
      goal: 'Timed goal',
      maxIterations: 5,
      contextWindow: 64000,
      wallClockMs: 60000,
    })
    saveGoalState(tempDir, sessionId, tracker)
    const record = loadGoalState(tempDir, sessionId)
    assert.ok(record !== null)
    assert.equal(record!.budgetLimits.wallClockMs, 60000)
  })
})

describe('deleteGoalState', () => {
  it('removes an existing goal file', () => {
    const tracker = new GoalTracker({
      goal: 'To delete',
      maxIterations: 3,
      contextWindow: 64000,
    })
    saveGoalState(tempDir, sessionId, tracker)
    assert.ok(loadGoalState(tempDir, sessionId) !== null)
    deleteGoalState(tempDir, sessionId)
    assert.equal(loadGoalState(tempDir, sessionId), null)
  })

  it('is a no-op when no file exists', () => {
    deleteGoalState(tempDir, sessionId) // should not throw
  })
})

describe('restoreGoalTracker', () => {
  it('returns null when no goal file exists', () => {
    const tracker = restoreGoalTracker(tempDir, sessionId, {})
    assert.equal(tracker, null)
  })

  it('returns null when goal status is complete', () => {
    const tracker = new GoalTracker({
      goal: 'Done goal',
      maxIterations: 5,
      contextWindow: 64000,
    })
    tracker.markComplete('model')
    saveGoalState(tempDir, sessionId, tracker)
    const restored = restoreGoalTracker(tempDir, sessionId, {})
    assert.equal(restored, null)
  })

  it('normalizes active→paused on restore (normalizeAfterResume)', () => {
    const tracker = new GoalTracker({
      goal: 'Resumed goal',
      maxIterations: 5,
      contextWindow: 64000,
    })
    // tracker is active — save it
    saveGoalState(tempDir, sessionId, tracker)
    // restore should downgrade active→paused
    const restored = restoreGoalTracker(tempDir, sessionId, {})
    assert.ok(restored !== null)
    assert.equal(restored!.getStatus(), 'paused')
    assert.equal(restored!.getGoal(), 'Resumed goal')
  })

  it('preserves paused status on restore', () => {
    const tracker = new GoalTracker({
      goal: 'Paused goal',
      maxIterations: 5,
      contextWindow: 64000,
    })
    tracker.pause('user requested', 'user')
    saveGoalState(tempDir, sessionId, tracker)
    const restored = restoreGoalTracker(tempDir, sessionId, {})
    assert.ok(restored !== null)
    assert.equal(restored!.getStatus(), 'paused')
  })
})

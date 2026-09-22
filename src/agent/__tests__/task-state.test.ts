import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractTaskState, taskStateFromTodos, extractUserGoal } from '../task-state.js'
import type { TrajectoryEntry } from '../trajectory.js'

describe('extractTaskState', () => {
  it('extracts completed steps from trajectory', () => {
    const entries: TrajectoryEntry[] = [
      { turn: 1, tool: 'read_file', target: 'src/auth.ts', durationMs: 30, status: 'success', inputSummary: '', resultSummary: '' },
      { turn: 1, tool: 'edit_file', target: 'src/auth.ts', durationMs: 50, status: 'success', inputSummary: '', resultSummary: '' },
      { turn: 2, tool: 'bash', target: 'npm test', durationMs: 200, status: 'failed', errorClass: 'assertion', inputSummary: '', resultSummary: '' },
    ]
    const state = extractTaskState(entries, '')
    assert.equal(state.completed.length, 2)
    assert.ok(state.completed[0]!.includes('read_file'))
    assert.ok(state.completed[1]!.includes('edit_file'))
    assert.ok(state.current.includes('fixing'))
  })

  it('extracts remaining from model text', () => {
    const entries: TrajectoryEntry[] = [
      { turn: 1, tool: 'read_file', target: 'a.ts', durationMs: 10, status: 'success', inputSummary: '', resultSummary: '' },
    ]
    const text = 'Next I need to edit the middleware and then run the tests.'
    const state = extractTaskState(entries, text)
    assert.ok(state.remaining.length > 0)
  })

  it('limits completed to last 5 entries', () => {
    const entries: TrajectoryEntry[] = Array.from({ length: 8 }, (_, i) => ({
      turn: 1, tool: 'read_file', target: `file${i}.ts`, durationMs: 10, status: 'success' as const, inputSummary: '', resultSummary: '',
    }))
    const state = extractTaskState(entries, '')
    assert.equal(state.completed.length, 5)
  })

  it('returns empty state for no entries', () => {
    const state = extractTaskState([], '')
    assert.equal(state.completed.length, 0)
    assert.equal(state.current, 'starting')
  })
})

describe('taskStateFromTodos', () => {
  it('maps the authoritative todo list to completed/current/remaining', () => {
    const state = taskStateFromTodos([
      { id: '1', content: 'Parse input', status: 'completed' },
      { id: '2', content: 'Validate', status: 'completed' },
      { id: '3', content: 'Emit output', status: 'in_progress' },
      { id: '4', content: 'Document', status: 'pending' },
    ], ['chose streaming parser'])
    assert.deepEqual(state.completed, ['Parse input', 'Validate'])
    assert.equal(state.current, 'Emit output')
    assert.deepEqual(state.remaining, ['Document'])
    assert.deepEqual(state.decisions, ['chose streaming parser'])
  })

  it('falls to first pending as current when nothing is in_progress', () => {
    const state = taskStateFromTodos([
      { id: '1', content: 'A', status: 'completed' },
      { id: '2', content: 'B', status: 'pending' },
    ], [])
    assert.equal(state.current, 'B')
  })

  it('uses "working" when no in_progress or pending items remain', () => {
    const state = taskStateFromTodos([
      { id: '1', content: 'A', status: 'completed' },
    ], [])
    assert.equal(state.current, 'working')
  })
})

describe('extractUserGoal — 从首条用户消息取真实需求', () => {
  it('returns the first user turn text', () => {
    const goal = extractUserGoal([
      { role: 'system', content: 'sys' } as any,
      { role: 'user', content: '通过 gh 看一下这个 issue 怎么设计落地' } as any,
      { role: 'assistant', content: 'ok' } as any,
    ])
    assert.equal(goal, '通过 gh 看一下这个 issue 怎么设计落地')
  })

  it('strips runtime-injected system-reminder blocks (they are not user intent)', () => {
    const goal = extractUserGoal([
      {
        role: 'user',
        content: '修一下语音识别\n<system-reminder>\n【太一·取证】已连续 5 轮只读…\n</system-reminder>',
      } as any,
    ])
    assert.equal(goal, '修一下语音识别')
  })

  it('skips turns that are nothing but a system reminder', () => {
    const goal = extractUserGoal([
      { role: 'user', content: '<system-reminder>上一轮你以"我将做…"结尾</system-reminder>' } as any,
      { role: 'user', content: '真正的需求在这里' } as any,
    ])
    assert.equal(goal, '真正的需求在这里')
  })

  it('handles multimodal content parts', () => {
    const goal = extractUserGoal([
      {
        role: 'user',
        content: [
          { type: 'text', text: '这是手机端截图，配色不自然' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      } as any,
    ])
    assert.equal(goal, '这是手机端截图，配色不自然')
  })

  it('truncates long goals and returns undefined when nothing is usable', () => {
    const goal = extractUserGoal([{ role: 'user', content: 'x'.repeat(400) } as any])
    assert.ok(goal && goal.length <= 161, 'long goal must be truncated')
    assert.ok(goal!.endsWith('…'))
    assert.equal(extractUserGoal([{ role: 'assistant', content: 'hi' } as any]), undefined)
    assert.equal(extractUserGoal([]), undefined)
  })
})

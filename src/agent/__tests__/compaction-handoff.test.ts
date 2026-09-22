import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildStructuredHandoff, buildCompactSummary, STRUCTURED_HANDOFF_SECTIONS } from '../compaction-controller.js'

describe('buildStructuredHandoff', () => {
  it('includes all 9 required sections', () => {
    const handoff = buildStructuredHandoff({
      taskState: {
        current: 'testing compaction',
        completed: ['added tests'],
        remaining: ['fix bugs'],
        decisions: ['use regex for extraction'],
      },
      turnCount: 42,
      filesSeen: ['src/agent/context.ts', 'src/compact/prune.ts'],
      reasoningSnippet: 'We should trim at append time',
      errorCount: 0,
      errors: [],
      toolHistory: [
        { tool: 'read_file', target: 'src/agent/context.ts', status: 'success' },
        { tool: 'edit_file', target: 'src/agent/context.ts', status: 'success' },
      ],
    })

    assert.equal(STRUCTURED_HANDOFF_SECTIONS.length, 9, 'handoff section contract must have 9 sections')
    for (const section of STRUCTURED_HANDOFF_SECTIONS) {
      assert.ok(
        handoff.includes(section),
        `handoff should contain section: "${section}"`,
      )
    }
  })

  it('includes file paths with tool accessories', () => {
    const handoff = buildStructuredHandoff({
      taskState: {
        current: 'test',
        completed: [],
        remaining: [],
        decisions: [],
      },
      turnCount: 1,
      filesSeen: ['src/agent/context.ts'],
      reasoningSnippet: '',
      errorCount: 0,
      errors: [],
      toolHistory: [
        { tool: 'read_file', target: 'src/agent/context.ts', status: 'success' },
      ],
    })

    assert.ok(handoff.includes('src/agent/context.ts'), 'should mention file path')
    assert.ok(handoff.includes('[read_file]'), 'should annotate file path with tool accessory')
  })

  it('includes error and fix sections when errors exist', () => {
    const handoff = buildStructuredHandoff({
      taskState: {
        current: 'fixing bugs',
        completed: [],
        remaining: [],
        decisions: [],
      },
      turnCount: 10,
      filesSeen: [],
      reasoningSnippet: '',
      errorCount: 2,
      errors: [
        { turn: 5, tool: 'bash', target: 'npm test', errorClass: 'exit_code', summary: 'tests failed' },
        { turn: 8, tool: 'edit_file', target: 'src/foo.ts', errorClass: 'not_found', summary: 'file missing' },
      ],
      toolHistory: [],
    })

    assert.ok(handoff.includes('4. 错误与修复'), 'should have error section')
    assert.ok(handoff.includes('npm test'), 'should mention first error')
    assert.ok(handoff.includes('src/foo.ts'), 'should mention second error')
  })

  it('preserves retry success marker in tool history', () => {
    const handoff = buildStructuredHandoff({
      taskState: {
        current: 'test retry status',
        completed: [],
        remaining: [],
        decisions: [],
      },
      turnCount: 2,
      filesSeen: [],
      reasoningSnippet: '',
      errorCount: 0,
      errors: [],
      toolHistory: [
        { tool: 'edit_file', target: 'src/agent/context.ts', status: 'retried-success' },
      ],
    })

    assert.match(handoff, /ok\*/, 'should preserve retried-success as ok*')
  })

  it('handles empty state gracefully', () => {
    const handoff = buildStructuredHandoff({
      taskState: {
        current: '',
        completed: [],
        remaining: [],
        decisions: [],
      },
      turnCount: 0,
      filesSeen: [],
      reasoningSnippet: '',
      errorCount: 0,
      errors: [],
      toolHistory: [],
    })

    for (const section of STRUCTURED_HANDOFF_SECTIONS) {
      assert.ok(handoff.includes(section), `handoff should contain section: "${section}"`)
    }
    assert.ok(handoff.startsWith('<session-handoff>'), 'should start with session-handoff tag')
  })

  it('renders the collaboration-stance section when stanceSummary is present', () => {
    const handoff = buildStructuredHandoff({
      taskState: { current: 't', completed: [], remaining: [], decisions: [] },
      turnCount: 1, filesSeen: [], reasoningSnippet: '', errorCount: 0, errors: [], toolHistory: [],
      stanceSummary: '本会话姿态轨迹：仁(质疑而非附和)×2',
    })
    assert.match(handoff, /协作姿态（从行为轨迹涌现/)
    assert.match(handoff, /仁\(质疑而非附和\)×2/)
  })

  it('omits the stance section when stanceSummary is null', () => {
    const handoff = buildStructuredHandoff({
      taskState: { current: 't', completed: [], remaining: [], decisions: [] },
      turnCount: 1, filesSeen: [], reasoningSnippet: '', errorCount: 0, errors: [], toolHistory: [],
      stanceSummary: null,
    })
    assert.doesNotMatch(handoff, /协作姿态/)
  })
})

// --- buildCompactSummary (Phase 2: structured compaction summary) ---

describe('buildCompactSummary', () => {
  const baseInput = {
    taskState: {
      current: 'fix timeout inversion bug',
      completed: ['added wireAbortToReaderCancel', 'increased worker budget to 180s'],
      remaining: ['apply fix to anthropic-client', 'apply fix to codex-client'],
      decisions: ['use Promise.race for abort detection'],
    },
    turnCount: 5,
    filesSeen: ['src/api/openai-client.ts', 'src/agent/work-order.ts'],
    reasoningSnippet: '',
    errorCount: 1,
    errors: [
      { turn: 3, tool: 'bash', target: 'npm test', errorClass: 'exit_code', summary: 'tests failed' },
    ],
    toolHistory: [],
  }

  it('includes all four required fields', () => {
    const summary = buildCompactSummary(baseInput)
    assert.ok(summary.includes('Goals'), 'should have Goals')
    assert.ok(summary.includes('Progress'), 'should have Progress')
    assert.ok(summary.includes('Active Files'), 'should have Active Files')
    assert.ok(summary.includes('Errors'), 'should have Errors')
  })

  it('wraps in compact-summary tag', () => {
    const summary = buildCompactSummary(baseInput)
    assert.ok(summary.startsWith('<compact-summary>'), 'should start with tag')
    assert.ok(summary.endsWith('</compact-summary>'), 'should end with tag')
  })

  it('includes current goal and remaining items', () => {
    const summary = buildCompactSummary(baseInput)
    assert.ok(summary.includes('fix timeout inversion bug'), 'should show current goal')
    assert.ok(summary.includes('[ ]'), 'should have remaining checkboxes')
  })

  it('includes completed progress items', () => {
    const summary = buildCompactSummary(baseInput)
    assert.ok(summary.includes('[x]'), 'should have completed checkmarks')
    assert.ok(summary.includes('wireAbortToReaderCancel'), 'should list completed item')
  })

  it('includes active files', () => {
    const summary = buildCompactSummary(baseInput)
    assert.ok(summary.includes('src/api/openai-client.ts'), 'should list active file')
    assert.ok(summary.includes('src/agent/work-order.ts'), 'should list second file')
  })

  it('includes errors when present', () => {
    const summary = buildCompactSummary(baseInput)
    assert.ok(summary.includes('tests failed'), 'should show error summary')
    assert.ok(summary.includes('Turn 3'), 'should show error turn')
  })

  it('handles empty state gracefully', () => {
    const summary = buildCompactSummary({
      taskState: { current: '', completed: [], remaining: [], decisions: [] },
      turnCount: 0, filesSeen: [], reasoningSnippet: '', errorCount: 0, errors: [], toolHistory: [],
    })
    assert.ok(summary.includes('Goals'))
    assert.ok(summary.includes('Progress'))
    assert.ok(summary.includes('Active Files'))
    assert.ok(summary.includes('Errors'))
    assert.ok(summary.includes('(none)'), 'should show (none) for empty sections')
  })
})

// ─── 2026-09-22: 第 1 节必须是用户需求，不是轨迹末项标签 ──────────────────────
// 实测事故：153/153 个 *.handoff.md 的第 1 节写的是 "ask_user_question
// ask_user_question" / "grep README.md" / "starting" 这类机器标签——它来自
// TaskState.current（"最后工具 + 目标 basename"），与用户需求无因果关系。
// 见 docs/analysis/2026-09-22-session-retrospective.md §3。
describe('buildStructuredHandoff — 用户核心需求来源', () => {
  const base = {
    taskState: { current: 'ask_user_question ask_user_question', completed: [], remaining: [], decisions: [] },
    turnCount: 3, filesSeen: [], reasoningSnippet: '', errorCount: 0, errors: [], toolHistory: [],
  }

  it('renders the user goal, never the trajectory label', () => {
    const handoff = buildStructuredHandoff({ ...base, userGoal: '通过 gh 看一下这个 pr 并移植到 dev' })
    assert.match(handoff, /## 1\. 用户核心需求\n通过 gh 看一下这个 pr 并移植到 dev/)
    assert.ok(
      !/## 1\. 用户核心需求\nask_user_question/.test(handoff),
      'mechanical TaskState.current must not leak into section 1',
    )
  })

  it('falls back to a placeholder instead of the trajectory label when no goal is known', () => {
    const handoff = buildStructuredHandoff(base)
    assert.match(handoff, /## 1\. 用户核心需求\n（无明确记录）/)
    // 只约束第 1 节：第 5 节显示轨迹标签是正确的用法（见下一条用例）
    const section1 = handoff.split('## 2.')[0] ?? ''
    assert.ok(!section1.includes('ask_user_question'), 'no label leak into section 1 even without a goal')
  })

  it('keeps the trajectory label in section 5 (current work) — that usage is correct', () => {
    const handoff = buildStructuredHandoff({ ...base, userGoal: '修一下登录' })
    assert.match(handoff, /## 5\. 当前工作\nask_user_question ask_user_question/)
  })
})

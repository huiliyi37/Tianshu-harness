import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../../config/default.js'
import { GoalTracker } from '../../agent/goal-tracker.js'
import { loadGoalState, restoreGoalTracker, saveGoalState } from '../../agent/goal-persist.js'
import { getSessionDir } from '../../agent/session-persist.js'
import { handleSlashCommand, type SlashHandlerContext } from '../slash-commands.js'

function makeCtx(parts: string[], options: { tracker?: GoalTracker | null } = {}) {
  const entries: string[] = []
  const submitted: string[] = []
  const trackerRef = { current: options.tracker ?? null }
  const agent = {
    cwd: process.cwd(),
    config: { goalJudge: { enabled: false, maxRuns: 0 } },
    setGoalTracker: (tracker: GoalTracker | null) => { trackerRef.current = tracker },
  }
  const ctx = {
    parts,
    config: DEFAULT_CONFIG,
    agent,
    session: null,
    persist: null,
    model: 'test',
    maxTokens: 128_000,
    availableModels: [],
    onModelSwitch: () => ({ ok: true }),
    allProviders: {},
    currentProvider: 'test',
    currentSessionId: '',
    cost: 0,
    cacheHitRate: 0,
    autoSafeRef: { current: false },
    verboseRef: { current: false },
    setVerbose: () => {},
    setAutoSafe: () => {},
    rollbackTokenRef: { current: null },
    setCockpitPanel: () => {},
    pushStatic: (entry: { content: string }) => entries.push(entry.content),
    setIsStreaming: () => {},
    setCacheHitRate: () => {},
    setSummaryState: () => {},
    mcpManagerRef: { current: null },
    claimStoreRef: { current: null },
    submitToAgent: (prompt: string) => submitted.push(prompt),
    goalTrackerRef: trackerRef,
  } as unknown as SlashHandlerContext
  return { ctx, entries, submitted, trackerRef, agent }
}

function tracker(goal = 'ship feature') {
  return new GoalTracker({ goal, maxIterations: 17, contextWindow: 128_000, wallClockMs: 900_000 })
}

describe('/goal unified entry', () => {
  it('bare /goal shows current goal status without submitting work', async () => {
    const state = makeCtx(['/goal'], { tracker: tracker() })
    assert.equal(await handleSlashCommand(state.ctx), true)
    assert.match(state.entries.join('\n'), /ship feature/)
    assert.equal(state.submitted.length, 0)
  })

  it('bare /goal with no active goal gives status guidance', async () => {
    const state = makeCtx(['/goal'])
    await handleSlashCommand(state.ctx)
    assert.match(state.entries.join('\n'), /No active goal/)
    assert.equal(state.submitted.length, 0)
  })

  it('starts a goal and submits its execution prompt', async () => {
    const state = makeCtx(['/goal', 'ship', 'feature'])
    await handleSlashCommand(state.ctx)
    assert.equal(state.trackerRef.current?.getGoal(), 'ship feature')
    assert.match(state.submitted.join('\n'), /ship feature/)
  })

  it('pause keeps tracker identity and iteration while changing status', async () => {
    const active = tracker()
    active.advanceIteration()
    active.advanceIteration()
    const state = makeCtx(['/goal', 'pause'], { tracker: active })
    await handleSlashCommand(state.ctx)
    assert.equal(state.trackerRef.current, active)
    assert.equal(active.getStatus(), 'paused')
    assert.equal(active.getIteration(), 2)
  })

  it('resume keeps budget and iteration and submits a continuation', async () => {
    const paused = tracker()
    paused.advanceIteration()
    paused.advanceIteration()
    paused.pause('test pause', 'user')
    const budget = paused.getWallClockBudgetMs()
    const state = makeCtx(['/goal', 'resume'], { tracker: paused })
    await handleSlashCommand(state.ctx)
    assert.equal(state.trackerRef.current, paused)
    assert.equal(paused.getStatus(), 'active')
    assert.equal(paused.getIteration(), 2)
    assert.equal(paused.getWallClockBudgetMs(), budget)
    assert.match(state.submitted.join('\n'), /ship feature/)
  })

  it('clear removes the tracker', async () => {
    const state = makeCtx(['/goal', 'clear'], { tracker: tracker() })
    await handleSlashCommand(state.ctx)
    assert.equal(state.trackerRef.current, null)
    assert.match(state.entries.join('\n'), /cancelled/i)
  })

  it('criteria displays and sets criteria on the existing tracker', async () => {
    const active = tracker()
    const show = makeCtx(['/goal', 'criteria'], { tracker: active })
    await handleSlashCommand(show.ctx)
    assert.match(show.entries.join('\n'), /当前无验收项/)
    const set = makeCtx(['/goal', 'criteria', 'set', `'["tests`, 'pass",', '"docs', `updated"]'`], { tracker: active })
    await handleSlashCommand(set.ctx)
    assert.deepEqual(active.getSuccessCriteria(), ['tests pass', 'docs updated'])
  })

  it('literal escape keeps control words as the objective', async () => {
    const state = makeCtx(['/goal', '--', 'pause', '--max', '4'])
    await handleSlashCommand(state.ctx)
    assert.equal(state.trackerRef.current?.getGoal(), 'pause --max 4')
    assert.match(state.submitted.join('\n'), /pause --max 4/)
    assert.equal(state.trackerRef.current?.getMaxIterations(), Math.max(50, Math.floor(128_000 / 4000)))
  })

  it('natural language containing a control word remains a goal', async () => {
    for (const objective of ['pause the deployment', 'criteria for a successful release']) {
      const state = makeCtx(['/goal', ...objective.split(' ')])
      await handleSlashCommand(state.ctx)
      assert.equal(state.trackerRef.current?.getGoal(), objective)
      assert.equal(state.submitted.length, 1)
    }
  })

  it('ordinary objective names cannot be mistaken for inherited object properties', async () => {
    for (const objective of ['constructor', '__proto__']) {
      const state = makeCtx(['/goal', objective])
      await handleSlashCommand(state.ctx)
      assert.equal(state.trackerRef.current?.getGoal(), objective)
      assert.equal(state.submitted.length, 1)
    }
  })

  it('an empty literal objective preserves the existing goal', async () => {
    const existing = tracker()
    const state = makeCtx(['/goal', '--'], { tracker: existing })
    await handleSlashCommand(state.ctx)
    assert.equal(state.trackerRef.current, existing)
    assert.equal(state.submitted.length, 0)
    assert.match(state.entries.join('\n'), /目标描述/)
  })

  it('manual criteria and resumed state are saved before continuing work', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'rivet-goal-command-'))
    const previousDataRoot = process.env.RIVET_HOME
    process.env.RIVET_HOME = dataRoot
    try {
      const paused = tracker()
      paused.advanceIteration()
      paused.pause('user pause', 'user')
      const state = makeCtx(['/goal-criteria', 'set', `'["tests`, `pass"]'`], { tracker: paused })
      state.agent.cwd = join(dataRoot, 'project')
      state.ctx.currentSessionId = 'goal-command-persistence'
      const dir = getSessionDir(state.agent.cwd)
      mkdirSync(dir, { recursive: true })
      saveGoalState(dir, state.ctx.currentSessionId, paused)
      await handleSlashCommand(state.ctx)
      const restored = restoreGoalTracker(dir, state.ctx.currentSessionId, {})
      assert.deepEqual(restored?.getSuccessCriteria(), ['tests pass'])
      assert.equal(restored?.getIteration(), 1)
      state.ctx.parts = ['/goal', 'resume']
      await handleSlashCommand(state.ctx)
      assert.equal(loadGoalState(dir, state.ctx.currentSessionId)?.status, 'active')
      assert.equal(state.submitted.length, 1)
    } finally {
      if (previousDataRoot === undefined) delete process.env.RIVET_HOME
      else process.env.RIVET_HOME = previousDataRoot
      rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  it('ordinary goal flags continue to configure the goal', async () => {
    const state = makeCtx(['/goal', 'ship', 'feature', '--max', '3', '--budget', '2'])
    await handleSlashCommand(state.ctx)
    assert.equal(state.trackerRef.current?.getGoal(), 'ship feature')
    assert.equal(state.trackerRef.current?.getMaxIterations(), 3)
    assert.equal(state.trackerRef.current?.getWallClockBudgetMs(), 120_000)
  })

  it('parses criteria JSON with spaces and surrounding quotes', async () => {
    const state = makeCtx(['/goal', 'ship', 'feature', '--criteria', `'["tests pass",`, `"docs updated"]'`])
    await handleSlashCommand(state.ctx)
    assert.deepEqual(state.trackerRef.current?.getSuccessCriteria(), ['tests pass', 'docs updated'])
    assert.equal(state.trackerRef.current?.getGoal(), 'ship feature')
  })

  it('rejects invalid options without replacing an existing goal or submitting', async () => {
    for (const args of [
      ['/goal', 'new', 'objective', '--max', 'zero'],
      ['/goal', 'new', 'objective', '--criteria', `'["broken"'`],
    ]) {
      const existing = tracker()
      const state = makeCtx(args, { tracker: existing })
      await handleSlashCommand(state.ctx)
      assert.equal(state.trackerRef.current, existing)
      assert.equal(state.submitted.length, 0)
      assert.match(state.entries.join('\n'), /用法|解析失败|无效|必须/)
    }
  })

  it('legacy goal command names and /cancel-goal remain available', async () => {
    const active = tracker()
    const pause = makeCtx(['/goal-pause'], { tracker: active })
    await handleSlashCommand(pause.ctx)
    assert.equal(active.getStatus(), 'paused')
    const cancel = makeCtx(['/cancel-goal'], { tracker: active })
    await handleSlashCommand(cancel.ctx)
    assert.equal(cancel.trackerRef.current, null)
  })

  it('help prints complete usage without submitting work', async () => {
    const state = makeCtx(['/goal', '--help'])
    await handleSlashCommand(state.ctx)
    const output = state.entries.join('\n')
    assert.match(output, /criteria/)
    assert.match(output, /\/goal -- <目标文字>/)
    assert.match(output, /\/goal-pause/)
    assert.equal(state.submitted.length, 0)
  })
})

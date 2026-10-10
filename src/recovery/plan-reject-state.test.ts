import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Writable } from 'node:stream'
import { AgentLoop } from '../agent/loop.js'
import { SessionContext } from '../agent/context.js'
import { checkPlanMode } from '../agent/plan-mode.js'
import { PromptEngine } from '../prompt/engine.js'
import { ToolRegistry } from '../tools/registry.js'
import { readPlan, readPlanSync, writePlan } from '../plan/plan-store.js'
import { RecoveryCommands } from './commands.js'
import { RecoveryOutput } from './output.js'
import type { BootstrapContext } from '../bootstrap.js'

function makeAgent(cwd: string): AgentLoop {
  return new AgentLoop({
    client: { async stream() { throw new Error('This local command must not call the model') } },
    promptEngine: new PromptEngine({ model: 'qa-fake', maxTokens: 1024, staticCtx: { tools: [] }, volatileCtx: { cwd } }),
    toolRegistry: new ToolRegistry(), maxTurns: 1, contextWindow: 1_000_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'qa-fake' },
    fsWatcherEnabled: false,
  }, new SessionContext(), cwd)
}

function canWrite(agent: AgentLoop, cwd: string, path: string): boolean {
  return checkPlanMode(agent.getPlanModeState(), 'write_file', {
    cwd, targetFilePath: path, activePlanFilePath: agent.getActivePlanFilePath(),
  }).allowed
}

async function fixture(run: (cwd: string, agent: AgentLoop, output: RecoveryOutput) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), 'recovery-reject-state-'))
  const output = new RecoveryOutput(new Writable({ write(_chunk, _encoding, done) { done() } }))
  try {
    await writePlan(cwd, 'review', '# Review\n\nImplement and validate a reversible parser change.\n')
    await run(cwd, makeAgent(cwd), output)
  } finally {
    output.close()
    await rm(cwd, { recursive: true, force: true })
  }
}

for (const initial of ['off', 'planning'] as const) {
  it(`reopens the rejected plan for revision with source writes blocked from ${initial}`, async () => {
    await fixture(async (cwd, agent, output) => {
      if (initial === 'planning') agent.enterPlanMode()
      const commands = new RecoveryCommands({ cwd, agent } as BootstrapContext, output, () => true)
      await commands.handle('/plan-reject review')
      assert.equal((await readPlan(cwd, 'review'))?.status, 'rejected')
      assert.equal(canWrite(agent, cwd, 'src/change.ts'), false)
      assert.equal(canWrite(agent, cwd, '.rivet/plans/review.md'), true)
      assert.equal(agent.getActivePlanFilePath(), '.rivet/plans/review.md')
    })
  })
}

it('keeps the current draft when rejection fails to resolve a plan', async () => {
  await fixture(async (cwd, agent, output) => {
    agent.enterPlanMode()
    const draft = agent.getActivePlanFilePath()
    const commands = new RecoveryCommands({ cwd, agent } as BootstrapContext, output, () => true)
    await commands.handle('/plan-reject nonexistent')
    assert.equal((await readPlan(cwd, 'review'))?.status, 'submitted')
    assert.equal(agent.getActivePlanFilePath(), draft)
    assert.equal(canWrite(agent, cwd, 'src/change.ts'), false)
    assert.equal(canWrite(agent, cwd, '.rivet/plans/review.md'), false)
  })
})

it('does not change the active draft when cancellation arrives after rejection was written', async () => {
  await fixture(async (cwd, agent, output) => {
    agent.enterPlanMode()
    const draft = agent.getActivePlanFilePath()
    const commands = new RecoveryCommands({ cwd, agent } as BootstrapContext, output,
      () => readPlanSync(cwd, 'review')?.status !== 'rejected')
    await commands.handle('/plan-reject review')
    assert.equal((await readPlan(cwd, 'review'))?.status, 'rejected')
    assert.equal(agent.getActivePlanFilePath(), draft)
    assert.equal(canWrite(agent, cwd, 'src/change.ts'), false)
    assert.equal(canWrite(agent, cwd, '.rivet/plans/review.md'), false)
  })
})

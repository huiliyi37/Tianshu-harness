import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { AdvisoryReadback } from '../advisory-readback.js'
import { createAdvisoryReadbackHooks } from '../hooks/advisory-readback-hook.js'
import type { RuntimeHookContext } from '../runtime-hooks.js'
import { drainSteerGuidance, type HumanGuidance } from '../course-episodes.js'
import type { AgentCallbacks } from '../loop-types.js'
import { DEFAULT_CONFIG } from '../../config/default.js'
import { RuntimeSessionManager, type ManagedAgent } from '../../server/session-manager.js'
import { wrapCallbacksWithTuiApp } from '../../tui/engine/bridge.js'
import { makeApp } from '../../tui/engine/__tests__/_harness.js'

const context = (turn: number): RuntimeHookContext => ({ snapshot: { turn, modelTurn: turn, cwd: '/tmp', recentToolHistory: [], sensorium: null, strategy: null, vigor: null, gitChangeRate: 0, season: null }, effects: {} as never })
test('top-level optional human guidance survives sidecar and TUI wrapper forwarding', async testContext => {
  let callbacks!: AgentCallbacks
  let finishRun!: () => void
  const agent: ManagedAgent = {
    run: (_prompt, nextCallbacks) => {
      callbacks = nextCallbacks
      return new Promise<void>(resolve => { finishRun = resolve })
    },
    abort: () => { callbacks.onAbort(); finishRun() },
    listArtifacts: () => [],
    readArtifact: async () => null,
    getMessages: () => [],
    replaceMessages: () => {},
    rewindToMessages: () => {},
  }
  const manager = new RuntimeSessionManager({
    createAgent: () => agent,
    defaultCwd: '/tmp',
    readSessionConfig: () => structuredClone(DEFAULT_CONFIG),
  })
  const { app } = makeApp({ autoStart: false })
  testContext.after(async () => { manager.abortAll(); app.dispose(); await manager.shutdownAll() })
  const session = manager.createSession({ prompt: 'initial task' })
  assert.equal(manager.steer(session.id, 'sidecar guidance one'), 'queued')
  assert.equal(manager.steer(session.id, 'sidecar guidance two'), 'queued')
  app.steerBuffer.push('next-run message', 'later')
  const accepted: HumanGuidance[] = []
  const forwarded = {
    ...wrapCallbacksWithTuiApp(app, { onHumanGuidanceDrain: callbacks.onHumanGuidanceDrain }),
    onHumanGuidanceAccepted: (item: HumanGuidance) => { accepted.push(item) },
  }
  const sidecar = await drainSteerGuidance(forwarded)
  assert.ok(sidecar)
  assert.match(sidecar.text, /sidecar guidance one[\s\S]*sidecar guidance two/)
  assert.equal(accepted.length, 0)
  sidecar.accepted()
  assert.equal(accepted[0]?.origin, 'human')
  assert.equal(accepted[0]?.inputSequence, 1)
  assert.equal(accepted[0]?.text, sidecar.text)
  assert.deepEqual(manager.getEvents(session.id, 0)!.events.filter(event => event.type === 'steer_delivered').map(event => event.data.count), [2])

  app.steerBuffer.pushNow('urgent TUI guidance')
  assert.equal(manager.steer(session.id, 'remaining sidecar guidance'), 'queued')
  const tui = await drainSteerGuidance(forwarded)
  assert.ok(tui)
  assert.match(tui.text, /urgent TUI guidance/)
  assert.doesNotMatch(tui.text, /next-run message|remaining sidecar guidance/)
  tui.accepted()
  assert.equal(accepted[1]?.origin, 'human')
  assert.equal(accepted[1]?.inputSequence, 1)

  const remaining = await drainSteerGuidance(forwarded)
  assert.ok(remaining)
  assert.match(remaining.text, /remaining sidecar guidance/)
  remaining.accepted()
  assert.equal(accepted[2]?.origin, 'human')
  assert.equal(accepted[2]?.inputSequence, 2)
  assert.equal(await drainSteerGuidance(forwarded), null)
  assert.deepEqual(app.steerBuffer.getPending(), ['next-run message'])
  assert.deepEqual(manager.getEvents(session.id, 0)!.events.filter(event => event.type === 'steer_delivered').map(event => event.data.count), [2, 1])
})
test('pro engine treats the human guidance drain as an async callback', () => {
  // src/pro 是闭源资产（公开仓不随 sync）：整族缺席时跳过整条断言，路径漂移不静默吞。
  let protocol: string
  let engine: string
  try {
    protocol = readFileSync(new URL('../../pro/runtime/protocol.ts', import.meta.url), 'utf8')
    engine = readFileSync(new URL('../../pro/runtime/engine.ts', import.meta.url), 'utf8')
  } catch { return }
  // engine 只对白名单里的回调等回值（其余 fire-and-forget，同步返回 undefined）。
  // drain 漏登记 = 子进程恒收 undefined，而 session-manager 侧已无 onSteerDrain 兜底
  // → isolated 执行后端的中途人工引导静默丢失。
  assert.match(engine, /ASYNC_CALLBACKS\.has\(method\)/, '前置：是否等值仍由该白名单决定——变了要重审本断言')
  assert.match(protocol, /ASYNC_CALLBACKS[^\n]*'onHumanGuidanceDrain'/, '人类引导 drain 必须登记为异步回调')
})
test('real postTool maps readonly shell and read_file to one family', () => {
  const rb = new AdvisoryReadback()
  const [observe] = createAdvisoryReadbackHooks({ readback: rb })
  observe.run(context(1), { name: 'bash', input: { command: "sed -n '1,20p' x.ts" }, success: true })
  rb.track([{ key: 'convergence', category: 'discipline', expect: { kind: 'course_changed', withinTurns: 1 } }], 1)
  observe.run(context(2), { name: 'read_file', input: { file_path: 'y.ts' }, success: true })
  rb.evaluate(2)
  assert.equal(rb.drainOutcomes()[0]?.outcome, 'ignored')
})
test('real postTool recognizes compound batch verification, lint family and rejects grep prose', () => {
  for (const command of ['cd /tmp && node --import tsx scripts/run-node-tests.ts a.test.ts 2>&1 | tail -14', 'npx eslint .']) {
    const rb = new AdvisoryReadback()
    const [observe] = createAdvisoryReadbackHooks({ readback: rb })
    observe.run(context(1), { name: 'run_tests', input: {}, success: true })
    rb.track([{ key: 'convergence', category: 'discipline', expect: { kind: 'course_changed', withinTurns: 1 } }], 1)
    observe.run(context(2), { name: 'bash', input: { command }, success: false, isError: true })
    rb.evaluate(2)
    assert.equal(rb.drainOutcomes()[0]?.outcome, 'ignored', command)
  }
  const rb = new AdvisoryReadback()
  const [observe] = createAdvisoryReadbackHooks({ readback: rb })
  rb.track([{ key: 'verify', category: 'discipline', expect: { kind: 'verify_attempted', withinTurns: 1 } }], 1)
  observe.run(context(2), { name: 'bash', input: { command: 'rg "npm test" src' }, success: true })
  rb.evaluate(2)
  assert.equal(rb.drainOutcomes()[0]?.outcome, 'ignored')
})

test('real postTool credits a batch verification attempt despite a filtered display', () => {
  const rb = new AdvisoryReadback()
  const [observe] = createAdvisoryReadbackHooks({ readback: rb })
  rb.track([{ key: 'verify', category: 'discipline', expect: { kind: 'verify_attempted', withinTurns: 1 } }], 1)
  observe.run(context(2), { name: 'bash', input: { command: 'cd /tmp && node --import tsx scripts/run-node-tests.ts a.test.ts 2>&1 | tail -14' }, success: false })
  rb.evaluate(2)
  assert.equal(rb.drainOutcomes()[0]?.outcome, 'adopted')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { AdvisoryReadback } from '../advisory-readback.js'
import { createAdvisoryReadbackHooks } from '../hooks/advisory-readback-hook.js'
import type { RuntimeHookContext } from '../runtime-hooks.js'

const context = (turn: number): RuntimeHookContext => ({ snapshot: { turn, modelTurn: turn, cwd: '/tmp', recentToolHistory: [], sensorium: null, strategy: null, vigor: null, gitChangeRate: 0, season: null }, effects: {} as never })
test('top-level optional human guidance survives sidecar and TUI wrapper forwarding', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  assert.match(source('../../server/session-manager.ts'), /onHumanGuidanceDrain:\s*\(\) => \{[\s\S]*?session\.steer\.drainHuman\(\)/)
  assert.match(source('../../tui/engine/app.ts'), /onHumanGuidanceDrain:\s*\(\) => this\.steerBuffer\.drainHuman\('next'\)/)
  assert.match(source('../../tui/engine/bridge.ts'), /onHumanGuidanceDrain:\s*\(\) => \{[\s\S]*?app\.callbacks\.onHumanGuidanceDrain\?\.\(\) \?\? original\.onHumanGuidanceDrain\?\.\(\)/)
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

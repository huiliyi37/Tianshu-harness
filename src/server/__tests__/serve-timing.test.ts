/**
 * 桌面性能阶段 3（2026-09-13）——sidecar 首秒：listen 后延迟预热 + 启动阶段计时。
 *
 * 纯函数/调度器直接求值（注入假计时器）；runServe 的接线走源码契约——仓库里没有
 * 端到端 runServe 用例（它会读用户级 config 拉起 MCP），阶段时间线的真机验证在
 * sidecar-*.log 里做（见 changelog）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_SERVE_WARM_DELAY_MS,
  PLUGIN_WARM_WAIT_CAP_MS,
  SERVE_TIMING_PREFIX,
  createServeTimingLogger,
  formatServeStartExtra,
  formatServeTimingPhase,
  isServeTimingEnabled,
  resolveServeWarmDelayMs,
  scheduleDeferredWarmup,
  type DeferredWarmupTimers,
} from '../serve-timing.js'

// ── 开关语义 ────────────────────────────────────────────────────────

test('isServeTimingEnabled：生产默认开、ephemeral 默认关、0 全关、1 强开', () => {
  assert.equal(isServeTimingEnabled({}, undefined), true)
  assert.equal(isServeTimingEnabled({ ephemeral: false }, undefined), true)
  assert.equal(isServeTimingEnabled({ ephemeral: true }, undefined), false)
  assert.equal(isServeTimingEnabled({}, '0'), false)
  assert.equal(isServeTimingEnabled({ ephemeral: true }, '1'), true)
  // 其他值按未设处理
  assert.equal(isServeTimingEnabled({ ephemeral: true }, 'yes'), false)
  assert.equal(isServeTimingEnabled({}, 'yes'), true)
})

// ── 行格式 ──────────────────────────────────────────────────────────

test('formatServeTimingPhase：固定形态 `[serve-timing] phase=<name> +<ms>[ extra]`，毫秒取整', () => {
  assert.equal(formatServeTimingPhase('listen', 1234.6), '[serve-timing] phase=listen +1235ms')
  assert.equal(formatServeTimingPhase('rehydrate', 12, 'sessions=146'), '[serve-timing] phase=rehydrate +12ms sessions=146')
  assert.match(formatServeTimingPhase('x', 0), new RegExp(`^${SERVE_TIMING_PREFIX.replace(/[[\]]/g, '\\$&')} phase=x \\+0ms$`))
})

test('formatServeStartExtra：uptime 为进程启动到 runServe，bootstrap 取不到时省略', () => {
  assert.equal(formatServeStartExtra(42, 370.4, 35.6), 'pid=42 uptime=370ms bootstrap=36ms')
  assert.equal(formatServeStartExtra(42, 370.4, undefined), 'pid=42 uptime=370ms')
  assert.equal(formatServeStartExtra(42, 370.4, Number.NaN), 'pid=42 uptime=370ms')
})

test('createServeTimingLogger：相对创建时刻计时；关闭时不写 sink', () => {
  let now = 1000
  const lines: string[] = []
  const log = createServeTimingLogger(true, () => now, (l) => lines.push(l))
  now = 1042
  log.mark('pro-module')
  now = 1300.4
  log.mark('listen', 'bind=3ms')
  assert.deepEqual(lines, ['[serve-timing] phase=pro-module +42ms', '[serve-timing] phase=listen +300ms bind=3ms'])
  assert.equal(Math.round(log.elapsedMs()), 300)

  const silent: string[] = []
  const off = createServeTimingLogger(false, () => now, (l) => silent.push(l))
  off.mark('start')
  assert.deepEqual(silent, [])
  assert.equal(off.enabled, false)
})

// ── 延迟参数 ────────────────────────────────────────────────────────

test('resolveServeWarmDelayMs：默认 2000；数字覆盖；0 合法；非法/负数回默认', () => {
  assert.equal(DEFAULT_SERVE_WARM_DELAY_MS, 2000)
  assert.equal(resolveServeWarmDelayMs(undefined), 2000)
  assert.equal(resolveServeWarmDelayMs(''), 2000)
  assert.equal(resolveServeWarmDelayMs('500'), 500)
  assert.equal(resolveServeWarmDelayMs('0'), 0)
  assert.equal(resolveServeWarmDelayMs('750.9'), 750)
  assert.equal(resolveServeWarmDelayMs('-1'), 2000)
  assert.equal(resolveServeWarmDelayMs('abc'), 2000)
  assert.ok(PLUGIN_WARM_WAIT_CAP_MS > 0 && PLUGIN_WARM_WAIT_CAP_MS <= DEFAULT_SERVE_WARM_DELAY_MS)
})

// ── 延迟预热调度（假计时器）─────────────────────────────────────────

function fakeTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>()
  let nextId = 1
  const timers: DeferredWarmupTimers = {
    setTimeout: (fn, ms) => { const id = nextId++; pending.set(id, { fn, ms }); return id },
    clearTimeout: (h) => { pending.delete(h as number) },
  }
  return {
    timers,
    pending,
    /** 触发所有到期定时器（单次预热只有一个）。 */
    tick() {
      for (const [id, { fn }] of [...pending]) { pending.delete(id); fn() }
    },
  }
}

test('scheduleDeferredWarmup：到点前不跑，到点跑且只跑一次', () => {
  const ft = fakeTimers()
  let runs = 0
  const w = scheduleDeferredWarmup(() => { runs++ }, 2000, ft.timers)
  assert.equal(runs, 0, 'listen 后立刻不该点火——这正是本阶段要的首秒让路')
  assert.equal(w.fired(), false)
  assert.equal([...ft.pending.values()][0]?.ms, 2000)
  ft.tick()
  assert.equal(runs, 1)
  assert.equal(w.fired(), true)
  ft.tick()
  w.fireNow()
  assert.equal(runs, 1, '幂等：到点后再 tick / fireNow 都不重复')
})

test('scheduleDeferredWarmup：fireNow 提前点火并清掉定时器（首个会话 createAgent 路径）', () => {
  const ft = fakeTimers()
  let runs = 0
  const w = scheduleDeferredWarmup(() => { runs++ }, 2000, ft.timers)
  w.fireNow()
  assert.equal(runs, 1)
  assert.equal(w.fired(), true)
  assert.equal(ft.pending.size, 0, '定时器应被清除')
  ft.tick()
  assert.equal(runs, 1)
})

test('scheduleDeferredWarmup：cancel 阻止点火（server close）；已点火后 cancel 为 no-op', () => {
  const ft = fakeTimers()
  let runs = 0
  const w = scheduleDeferredWarmup(() => { runs++ }, 2000, ft.timers)
  w.cancel()
  assert.equal(ft.pending.size, 0)
  ft.tick()
  assert.equal(runs, 0)
  assert.equal(w.fired(), false)
  w.fireNow()
  assert.equal(runs, 1, 'cancel 后显式 fireNow 仍可点火（createAgent 需要它）')
  w.cancel()
  assert.equal(runs, 1)
})

test('scheduleDeferredWarmup：run 抛错被吞并记日志，不影响 fired 状态', () => {
  const ft = fakeTimers()
  const origErr = console.error
  const errs: unknown[] = []
  console.error = (...a: unknown[]) => { errs.push(a) }
  try {
    const w = scheduleDeferredWarmup(() => { throw new Error('boom') }, 0, ft.timers)
    ft.tick()
    assert.equal(w.fired(), true)
    assert.equal(errs.length, 1)
    assert.match(String((errs[0] as unknown[])[0]), /deferred warmup failed/)
  } finally {
    console.error = origErr
  }
})

test('scheduleDeferredWarmup：真实计时器 unref（不拖住进程退出）且 0ms 能点火', async () => {
  let runs = 0
  const w = scheduleDeferredWarmup(() => { runs++ }, 0)
  await new Promise((r) => setTimeout(r, 15))
  assert.equal(runs, 1)
  assert.equal(w.fired(), true)
})

// ── runServe 接线契约 ───────────────────────────────────────────────

const serveSrc = readFileSync(join(process.cwd(), 'src', 'server', 'serve.ts'), 'utf8')

test('serve.ts：listen 后不再裸 `void loadServeAgent()`，预热走 scheduleDeferredWarmup 且 close 取消', () => {
  const listenAt = serveSrc.indexOf('await startServer(port, routes, apiToken')
  assert.ok(listenAt > -1)
  const warmAt = serveSrc.indexOf('warmup = scheduleDeferredWarmup(')
  assert.ok(warmAt > listenAt, '延迟预热应在 listen 之后调度')
  const warmEnd = serveSrc.indexOf('resolveServeWarmDelayMs()', warmAt)
  const returnAt = serveSrc.indexOf('\n  return {', warmEnd)
  assert.ok(warmEnd > warmAt && returnAt > warmEnd)
  // listen → 调度 之间、调度 → return 之间都不得直接 import agent chunk
  assert.doesNotMatch(serveSrc.slice(listenAt, warmAt), /loadServeAgent\(/, 'listen 后不得立刻 import agent chunk')
  assert.doesNotMatch(serveSrc.slice(warmEnd, returnAt), /loadServeAgent\(/, '调度之外不得再 import agent chunk')
  const warmBlock = serveSrc.slice(warmAt, warmEnd)
  assert.match(warmBlock, /warmPluginToolsCache\(ctx\.config\.plugins, process\.cwd\(\)\)/)
  assert.match(warmBlock, /void loadServeAgent\(\)/)
  assert.match(warmBlock, /timing\.mark\('serve-agent-loaded'\)/)
  // close 里必须取消预热（允许先做外部 hooks 关停等其他排空动作，不强钉首行）。
  assert.match(serveSrc, /close: \(cb\) => \{[\s\S]{0,300}?warmup\?\.cancel\(\)/)
  // runServe 入口不再点火暖场
  const runServeAt = serveSrc.indexOf('export async function runServe(')
  assert.doesNotMatch(serveSrc.slice(runServeAt, listenAt), /^\s*warmPluginToolsCache\(/m)
})

test('serve.ts：listen 后立即异步预热宿主探针（reg query / where），不在 /environment 请求路径上 spawnSync', () => {
  const listenAt = serveSrc.indexOf('await startServer(port, routes, apiToken')
  const warmAt = serveSrc.indexOf('warmup = scheduleDeferredWarmup(')
  const between = serveSrc.slice(listenAt, warmAt)
  assert.match(between, /void Promise\.all\(\[prewarmResolvedEnv\(\), prewarmShellProbes\(\)\]\)\s*\.then\(\(\) => timing\.mark\('host-probes'\)\)/)
})

test('official-account startup prewarms the agent without a personal provider key', async () => {
  const readinessStart = serveSrc.indexOf('const serveConfigured = () => {')
  const readinessEnd = serveSrc.indexOf('\n  const loopLagForHealth', readinessStart)
  const warmStart = serveSrc.indexOf('warmup = scheduleDeferredWarmup(')
  const warmEnd = serveSrc.indexOf('\n  return {', warmStart)
  assert.ok(readinessStart >= 0 && readinessEnd > readinessStart && warmStart >= 0 && warmEnd > warmStart)
  const initialize = new Function('ctx', 'ownsSessionStore', 'captureOfficialIdentity', 'scheduleDeferredWarmup', 'timing', 'warmPluginToolsCache', 'pluginToolsWarmup', 'loadServeAgent', 'resolveServeWarmDelayMs', `let warmup; ${serveSrc.slice(readinessStart, readinessEnd)}; ${serveSrc.slice(warmStart, warmEnd)}; return { warmup, configured: serveConfigured() };`)
  for (const scenario of [
    { name: 'official-only', configured: false, owned: true, account: true, locked: false, shouldWarm: true },
    { name: 'personal-provider', configured: true, owned: true, account: false, locked: false, shouldWarm: true },
    { name: 'setup-only', configured: false, owned: true, account: false, locked: false, shouldWarm: false },
    { name: 'locked-account', configured: false, owned: true, account: false, locked: true, shouldWarm: false },
    { name: 'non-owner', configured: false, owned: false, account: true, locked: false, shouldWarm: false },
  ]) {
    let active = true
    let fired = false
    let assemblyLoads = 0
    let scheduled: (() => void) | undefined
    const result = initialize(
      { configured: scenario.configured, config: { plugins: {} } },
      scenario.owned,
      () => { if (scenario.locked) throw Error('locked'); return scenario.account ? {} : null },
      (callback: () => void) => {
        scheduled = callback
        return { cancel() { active = false }, fireNow() { if (active && !fired) { fired = true; scheduled?.() } } }
      },
      { mark() {} },
      () => {},
      async () => {},
      async () => { assemblyLoads++ },
      () => 2000,
    )
    assert.equal(assemblyLoads, 0, `${scenario.name}: do not block listen on the agent graph`)
    result.warmup.fireNow()
    result.warmup.fireNow()
    await Promise.resolve()
    assert.equal(assemblyLoads, scenario.shouldWarm ? 1 : 0, scenario.name)
  }
})

test('serve.ts：阶段时间线覆盖 start / pro-module / rehydrate / routes / listen / host-probes / warm-start / plugins-warm / serve-agent-loaded / mcp', () => {
  for (const phase of ['start', 'pro-module', 'rehydrate', 'routes', 'listen', 'host-probes', 'warm-start', 'plugins-warm', 'serve-agent-loaded', 'mcp']) {
    assert.match(serveSrc, new RegExp(`timing\\.mark\\('${phase}'`), `缺阶段 ${phase}`)
  }
  assert.match(serveSrc, /const timing = createServeTimingLogger\(isServeTimingEnabled\(opts\)\)/)
  assert.match(
    serveSrc,
    /timing\.mark\('start', formatServeStartExtra\(process\.pid, performance\.now\(\), performance\.nodeTiming\?\.bootstrapComplete\)\)/,
    'start 行要带进程启动到 runServe 的耗时',
  )
  assert.match(serveSrc, /timing\.mark\('rehydrate', `sessions=\$\{rehydratedSessions\.length\}`\)/)
  // 旧的 RIVET_SERVE_TIMING === '1' 门控 listen 行已并入阶段标记
  assert.doesNotMatch(serveSrc, /\[serve-timing\] listen ready/)
})

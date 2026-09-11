import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// 静态命名导入（Node 官方文档姿势）。动态 import 解构会在 @types/node 22.19.x
// 下报 TS2339：该版本把 node:events 声明为 `export = EventEmitter`，getEventListeners
// 只挂在类 static 上、不在模块类型面里，CI typecheck 因此全红。
import { getEventListeners } from 'node:events'
import { createFrameDecoder, encodeFrame } from '../protocol.js'
import {
  runWorkerSessionOop, resolveChildEntry, WorkerOopUnavailable,
  workerIsolationMode, workerIsolationEnabled, isReviewWorkerProfile, createModeAwareRunner,
  type WorkerOopOptions,
} from '../parent.js'
import type { WorkerSessionConfig, WorkerSessionRun } from '../../worker-session.js'
import type { WorkOrder } from '../../work-order.js'

// ── 协议单测 ─────────────────────────────────────────────────────

describe('NDJSON 帧解码', () => {
  test('跨 chunk 半行拼接 + 多帧单 chunk + 坏行计数', () => {
    const dec = createFrameDecoder()
    const a = dec.feed(encodeFrame({ t: 'tick', at: 1 }).slice(0, 10))
    assert.equal(a.length, 0, '半行不应解出消息')
    const b = dec.feed(encodeFrame({ t: 'tick', at: 1 }).slice(10) + encodeFrame({ t: 'log', line: 'x' }) + 'not-json\n')
    assert.equal(b.length, 2, '补齐半行 + 完整帧各一条')
    assert.equal(dec.badLines, 1, '坏行计数')
    assert.equal((b[0] as { t: string }).t, 'tick')
  })

  test('空行静默跳过', () => {
    const dec = createFrameDecoder()
    assert.equal(dec.feed('\n\n').length, 0)
  })
})

// ── 集成（假子进程说协议）────────────────────────────────────────

/** 生成假子进程 fixture：说协议但不动真 agent。mode:
 *  - ok：activity×2 + mailbox + result 后退出 0
 *  - hang：init 后一声不吭（watchdog 击杀用）
 *  - crash：init 后 exit(1)
 *  - echo-steer：收到 steer 帧后把它放进 result.summary 证明下行通路 */
function writeFixture(dir: string, mode: 'ok' | 'hang' | 'crash' | 'echo-steer' | 'big-frame' | 'grandchild-hang'): string {
  const src = `
const { createInterface } = require('node:readline')
const dec = (${createFrameDecoder.toString()})()
let mode = ${JSON.stringify(mode)}
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  for (const msg of dec.feed(line + '\\n')) {
    if (msg.t === 'init') {
      if (mode === 'grandchild-hang') {
        // 孙进程：不设 detached（继承本进程组），pid 落盘供父侧断言。
        // 模拟 worker 里的 stdio MCP/LSP 服务器等非 detached 后代。
        const g = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
        require('node:fs').writeFileSync(__filename + '.grandchild-pid', String(g.pid))
        return // 一声不吭 → watchdog → 击杀梯应组杀连带孙进程
      }
      if (mode === 'hang') return // 一声不吭
      if (mode === 'crash') { process.exit(1) }
      if (mode === 'big-frame') {
        // 大 result 帧（200KB > pipe 写缓冲 64KB）：发完立刻 process.exit(0) 会
        // 截断未 flush 的 stdout，父侧只能合成 worker_crash——真实 session 的
        // result 帧（transcript + messages）正是这个量级（2026-09-10 烧机实测）。
        const pad = 'x'.repeat(200000)
        send({ t: 'result', run: {
          result: { workOrderId: 'wo_big', status: 'passed', summary: 'big:' + pad.length, findings: [], artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'verified' },
          transcript: { text: pad, thinking: '', toolUses: [], toolResults: [], repairAttempts: 0, errors: [] },
          usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          messages: [{ role: 'user', content: pad }],
          turnCount: 1,
        } })
        // 与 child.ts 的退出契约一致：等 stdout flush 再退，否则大帧被截断。
        process.stdout.end(() => process.exit(0))
        return
      }
      send({ t: 'activity', kind: 'text', detail: 'hello' })
      send({ t: 'mailbox', msg: { to: 'coordinator', type: 'finding', severity: 'info', body: 'm1' } })
    } else if (msg.t === 'steer') {
      send({ t: 'activity', kind: 'text', detail: 'steered:' + msg.text })
      send({ t: 'result', run: {
        result: { workOrderId: msg.text, status: 'passed', summary: 'steer-echo:' + msg.text, findings: [], artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'verified' },
        transcript: { text: '', thinking: '', toolUses: [], toolResults: [], repairAttempts: 0, errors: [] },
        usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        messages: [{ role: 'user', content: msg.text }],
        turnCount: 1,
      } })
      process.exit(0)
    } else if (msg.t === 'abort') {
      send({ t: 'result', run: {
        result: { workOrderId: 'w', status: 'blocked', summary: 'aborted', findings: [], artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'skipped', failureReason: 'caller_aborted' },
        transcript: { text: '', thinking: '', toolUses: [], toolResults: [], repairAttempts: 0, errors: [] },
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        messages: [],
        turnCount: 0,
      } })
      process.exit(0)
    }
  }
})
`
  const path = join(dir, `fixture-${mode}.cjs`)
  writeFileSync(path, src)
  return path
}

function makeConfig(over: Partial<WorkerSessionConfig> = {}): WorkerSessionConfig {
  return {
    order: { id: 'wo_test', objective: 'test', profile: 'code_scout', allowedTools: ['read_file'], budget: { maxTurns: 3, maxTokens: 1000, wallClockMs: 60_000, inputTokens: 10_000, outputTokens: 2_000 } } as unknown as WorkOrder,
    client: {} as WorkerSessionConfig['client'],
    promptEngine: {} as WorkerSessionConfig['promptEngine'],
    toolRegistry: {} as WorkerSessionConfig['toolRegistry'],
    cwd: process.cwd(),
    maxTurns: 3,
    contextWindow: 64000,
    compact: { enabled: false, model: 'flash' },
    runtimeDecision: { providerName: 'deepseek', model: 'deepseek-v4-flash', maxTokens: 4096, contextWindow: 64000, thinkingBudget: 4096, isWrite: false },
    activeClaims: [],
    ...over,
  } as WorkerSessionConfig
}

const baseOpts = (fixture: string): WorkerOopOptions => ({
  getMemoryBlock: () => 'memory-block-snapshot',
  stallMsOverride: 8_000,
  entryOverride: { execArgs: [], script: fixture },
})

describe('OOP 运行器（真子进程假 agent）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-oop-test-'))

  test('活动流 + mailbox 桥 + steer 下行 + result 映射', async () => {
    const activities: Array<[string, string | undefined]> = []
    const mailboxMsgs: string[] = []
    let steerText: string | null = null
    // ok 模式 fixture 等第一帧 steer 才 result——用 spawn 真进程跑 fixture
    const fixture = writeFixture(dir, 'echo-steer')
    const opts: WorkerOopOptions = {
      getMemoryBlock: () => 'mb',
      stallMsOverride: 15_000,
      entryOverride: { execArgs: [], script: fixture },
      spawnOverride: (execArgs, script) =>
        spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] }),
    }
    const cfg = makeConfig({
      onActivity: (kind, detail) => activities.push([kind, detail]),
      mailbox: { send: (m) => mailboxMsgs.push((m as { body?: string }).body ?? ''), receive: () => [], broadcast: () => {}, all: () => [], byType: () => [], clear: () => {}, size: () => 0 },
      onSteerDrain: () => { const t = steerText; steerText = null; return t },
    })
    const p = runWorkerSessionOop(cfg, opts)
    // 模拟 coordinator 在结算点 drain steer
    steerText = 'GO-FAST'
    setTimeout(() => { cfg.onSteerDrain?.() }, 150)
    const run = await p
    assert.equal(run.result.status, 'passed')
    assert.equal(run.result.summary, 'steer-echo:GO-FAST', 'steer 经父进程转发到子进程并回到 result')
    assert.ok(activities.some(([k, d]) => k === 'text' && d === 'steered:GO-FAST'), '子进程 activity 上行到 onActivity')
    assert.deepEqual(mailboxMsgs, ['m1'], 'mailbox 帧桥到父侧 mailbox.send')
    assert.equal(run.session.getMessages()[0]?.content, 'GO-FAST', 'result.messages 投影成 duck-type session')
    assert.equal(run.usage.input_tokens, 1)
  })

  test('子进程崩溃（无 result 退出）→ 合成 failed/worker_crash', async () => {
    const fixture = writeFixture(dir, 'crash')
    const run = await runWorkerSessionOop(makeConfig(), { ...baseOpts(fixture), spawnOverride: (_e, script) => spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] }) })
    assert.equal(run.result.status, 'failed')
    assert.equal(run.result.failureReason, 'worker_crash')
    assert.equal(run.result.evidenceStatus, 'skipped')
  })

  test('watchdog 组杀连带孙进程——kill(-pid) 须真正作用到 worker 进程组（Unix，2026-09-10 修复）', async () => {
    if (process.platform === 'win32') return // Windows 走 taskkill /T 父子关系语义
    const fixture = writeFixture(dir, 'grandchild-hang')
    // 不用 spawnOverride：直接走生产 doSpawn（含 detached）——修复前 kill(-pid)
    // ESRCH 回退 child.kill()，孙进程（stdio MCP/LSP 服务器等非 detached 后代）
    // 成孤儿继续烧 CPU、继续写正被 worktree remove 的目录。
    const run = await runWorkerSessionOop(makeConfig(), {
      getMemoryBlock: () => 'mb',
      stallMsOverride: 900,
      entryOverride: { execArgs: [], script: fixture },
    })
    assert.equal(run.result.failureReason, 'stalled')
    const grandchildPid = Number(readFileSync(fixture + '.grandchild-pid', 'utf-8'))
    const dead = await new Promise<boolean>(resolve => {
      const started = Date.now()
      const poll = (): void => {
        try {
          process.kill(grandchildPid, 0)
          if (Date.now() - started > 5000) resolve(false)
          else setTimeout(poll, 100)
        } catch { resolve(true) }
      }
      poll()
    })
    assert.ok(dead, '孙进程应随 worker 进程组被击杀')
  })

  test('watchdog：子进程 hang → SIGTERM/SIGKILL 阶梯 → 合成 stalled', async () => {
    const fixture = writeFixture(dir, 'hang')
    const run = await runWorkerSessionOop(makeConfig(), {
      getMemoryBlock: () => 'mb',
      stallMsOverride: 900, // 压过心跳下限（测试专用）
      entryOverride: { execArgs: [], script: fixture },
      spawnOverride: (_e, script) => spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] }),
    })
    assert.equal(run.result.status, 'failed')
    assert.equal(run.result.failureReason, 'stalled', '击杀梯收尾后合成 stalled 而非 worker_crash')
  })

  test('settle 后摘除 abort 监听——同一会话级信号多次委派不累积监听（2026-09-10 泄漏修复）', async () => {
    const fixture = writeFixture(dir, 'crash') // 最快 settle：init 后 exit(1)
    const controller = new AbortController()
    const spawnFx = (_e: string[], script: string) => spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] })
    const opts = (): WorkerOopOptions => ({ ...baseOpts(fixture), spawnOverride: spawnFx })

    // abortSignal 是会话级合成信号（AbortSignal.any([session, order])）时，order 级
    // 不触发 abort 则 once 永不消耗——修复前监听钉在会话信号上每次委派 +1，
    // 长会话单调泄漏并最终触发 MaxListenersExceededWarning。
    const run1 = await runWorkerSessionOop(makeConfig({ abortSignal: controller.signal }), opts())
    assert.equal(run1.result.status, 'failed')
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0, '第一次委派 settle 后监听已摘除')

    const run2 = await runWorkerSessionOop(makeConfig({ abortSignal: controller.signal }), opts())
    assert.equal(run2.result.status, 'failed')
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0, '第二次委派后同样不残留')
  })

  test('abort 下行 → 子进程返回 blocked/caller_aborted', async () => {
    const fixture = writeFixture(dir, 'ok')
    const cfg = makeConfig()
    const controller = new AbortController()
    cfg.abortSignal = controller.signal
    const p = runWorkerSessionOop(cfg, { ...baseOpts(fixture), spawnOverride: (_e, script) => spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] }) })
    setTimeout(() => controller.abort('caller_aborted'), 150)
    const run = await p
    assert.equal(run.result.status, 'blocked')
    assert.equal(run.result.failureReason, 'caller_aborted')
  })

  test('entry 缺失 → WorkerOopUnavailable（接线处回退进程内）', async () => {
    await assert.rejects(
      runWorkerSessionOop(makeConfig(), { getMemoryBlock: () => 'mb', entryOverride: null }),
      WorkerOopUnavailable,
    )
  })

  test('runtimeDecision 缺席 → WorkerOopUnavailable（防两端漂移）', async () => {
    const cfg = makeConfig()
    delete (cfg as Partial<WorkerSessionConfig>).runtimeDecision
    await assert.rejects(
      runWorkerSessionOop(cfg, { getMemoryBlock: () => 'mb', entryOverride: { execArgs: [], script: join(dir, 'fixture-ok.cjs') } }),
      WorkerOopUnavailable,
    )
  })

  test('entry 解析：dist/tsx 至少其一可解析（本仓 dev 必命中 .ts）', () => {
    const entry = resolveChildEntry()
    assert.ok(entry, 'dev 仓必有 src/agent/worker-process/child.ts')
    assert.match(entry.script, /child\.(ts|js)$/)
  })

  after(() => rmSync(dir, { recursive: true, force: true }))
})

// ── 隔离模式（RIVET_WORKER_ISOLATION 取值）与分场景派发 ────────────────
// `review` 模式只隔离审查类 worker（提交后审查门 + squadron 检查员）——解决
// 2026-09-10 暴露的场景：审查 worker 卡死连累主 TUI，而非审查 worker 保持
// 进程内的成熟路径。

describe('worker 隔离模式与分场景派发', () => {
  const original = process.env.RIVET_WORKER_ISOLATION
  const restore = (): void => {
    if (original === undefined) delete process.env.RIVET_WORKER_ISOLATION
    else process.env.RIVET_WORKER_ISOLATION = original
  }

  test('未设置 / 非法值 → off（默认进程内，不误开）', () => {
    try {
      delete process.env.RIVET_WORKER_ISOLATION
      assert.equal(workerIsolationMode(), 'off')
      assert.equal(workerIsolationEnabled(), false)
      process.env.RIVET_WORKER_ISOLATION = 'yes'
      assert.equal(workerIsolationMode(), 'off', '非法值不得误开隔离')
    } finally { restore() }
  })

  test('=1 / =true / =all → all', () => {
    try {
      for (const v of ['1', 'true', 'all']) {
        process.env.RIVET_WORKER_ISOLATION = v
        assert.equal(workerIsolationMode(), 'all', `=${v}`)
        assert.equal(workerIsolationEnabled(), true)
      }
    } finally { restore() }
  })

  test('=review → 只把 reviewer profile 判为审查 worker', () => {
    try {
      process.env.RIVET_WORKER_ISOLATION = 'review'
      assert.equal(workerIsolationMode(), 'review')
      assert.equal(workerIsolationEnabled(), true)
      assert.equal(isReviewWorkerProfile('reviewer'), true)
      assert.equal(isReviewWorkerProfile('code_scout'), false)
      assert.equal(isReviewWorkerProfile(undefined), false)
    } finally { restore() }
  })

  test('review 模式：reviewer 走 OOP，其他 profile 走进程内', async () => {
    const modeDir = mkdtempSync(join(tmpdir(), 'worker-mode-'))
    const fixture = writeFixture(modeDir, 'ok')
    const spawned: string[] = []
    const inProcessCalls: string[] = []
    const runner = createModeAwareRunner('review', {
      getMemoryBlock: () => 'mb',
      stallMsOverride: 8_000,
      entryOverride: { execArgs: [], script: fixture },
      spawnOverride: (_e, script) => {
        spawned.push(script)
        return spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] })
      },
    }, async () => {
      inProcessCalls.push('called')
      return {
        result: {
          workOrderId: 'wo_test', status: 'passed', summary: 'in-process',
          findings: [], artifacts: [], changedFiles: [], risks: [], nextActions: [],
          evidenceStatus: 'skipped', objective: 'test', profile: 'code_scout',
        },
        transcript: { text: '', thinking: '', toolUses: [], toolResults: [], repairAttempts: 0, errors: [] },
        session: { getMessages: () => [] } as unknown as WorkerSessionRun['session'],
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }
    })

    const order = makeConfig().order
    const scoutRun = await runner(makeConfig({ order: { ...order, profile: 'code_scout' } as unknown as WorkOrder }))
    assert.equal(scoutRun.result.summary, 'in-process', '非审查 worker 应走注入的进程内 runner')
    assert.deepEqual(spawned, [], '非审查 worker 不得 spawn 子进程')
    assert.deepEqual(inProcessCalls, ['called'])

    await runner(makeConfig({ order: { ...order, profile: 'reviewer' } as unknown as WorkOrder }))
    assert.equal(spawned.length, 1, '审查 worker 应走 OOP（spawn 子进程）')
  })
})

// ── result 帧完整性（2026-09-10 真实烧机暴露）────────────────────────
// 真实 session 的 result 帧含 transcript + messages，可达数十 KB；child 发完帧
// 立刻 process.exit(0) 会丢弃未 flush 的 pipe 写缓冲，父侧只能合成 worker_crash。

describe('OOP result 帧完整性', () => {
  test('大 result 帧（200KB）不被 process.exit 截断', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'worker-oop-big-'))
    const fixture = writeFixture(dir, 'big-frame')
    const run = await runWorkerSessionOop(makeConfig(), {
      getMemoryBlock: () => 'mb',
      stallMsOverride: 15_000,
      entryOverride: { execArgs: [], script: fixture },
      spawnOverride: (_e, script) => spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] }),
    })
    assert.equal(run.result.status, 'passed',
      `大帧不应被截断（实际 ${run.result.status}：${run.result.summary.slice(0, 120)}）`)
    assert.ok(run.result.summary.startsWith('big:'), `应收到完整 summary：${run.result.summary.slice(0, 80)}`)
  })
})

#!/usr/bin/env npx tsx
/**
 * worker 进程隔离烧机脚本 —— docs/known-issues/2026-08-24-worker-process-isolation-v1.md 待办 1。
 *
 * 用法:
 *   npx tsx scripts/verify-worker-isolation.ts --dry-run      # 环境体检 + 派发计划（不 spawn）
 *   npx tsx scripts/verify-worker-isolation.ts --live -n 3    # 真派发 N 个 worker 子进程，采集对账表
 *
 * 判据（对齐 2026-08-24 事故）：主线程 loop-lag 无 2s+ 尖峰；子进程随派发起落。
 *
 * 分层纪律：live 模式的 worker session 用**最小 config**（不跑 buildWorkerRuntime 的
 * 完整装配），能验「spawn → 协议握手 → 收尾」这条机制链，但**任务层通常 failed**
 * ——那是 config 不全，不是隔离回归。判据只看机制层。要跑通完整 session，请用真实
 * delegate（RIVET_WORKER_ISOLATION=1 + /scout）观察。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  resolveChildEntry,
  runWorkerSessionOop,
  workerIsolationEnabled,
  type WorkerOopOptions,
} from '../src/agent/worker-process/parent.js'
import type { WorkerSessionConfig } from '../src/agent/worker-session.js'
import type { WorkOrder } from '../src/agent/work-order.js'

// ── CLI ───────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const live = argv.includes('--live')
const nIdx = argv.indexOf('-n')
const count = nIdx >= 0 ? Math.max(1, Number(argv[nIdx + 1]) || 3) : 3

/** loop-lag 尖峰判据：2s（2026-08-24 sidecar 卡顿实测区间 2-13s）。 */
const LAG_SPIKE_MS = 2000
/** watchdog 覆盖：烧机不需要 deriveWorkerStallMs 的长窗口，卡住即早停。 */
const STALL_MS = 30_000

// ── 环境体检 ──────────────────────────────────────────────────────

/** 凭据可用性提示。配置里 deepseek 段通常用 `apiKeyEnv`（环境变量名）或
 *  `keyRef` 间接引用，不是内联 apiKey——真正的解析在子进程内由 api/factory
 *  完成，这里只给提示，烧机结论以对账表为准。 */
function providerHint(): { ok: boolean; label: string } {
  if (process.env.DEEPSEEK_API_KEY) return { ok: true, label: '可用（DEEPSEEK_API_KEY）' }
  try {
    const cfg = JSON.parse(readFileSync(`${homedir()}/.rivet/config.json`, 'utf8')) as {
      provider?: { providers?: Record<string, { apiKey?: string; apiKeyEnv?: string; keyRef?: string }> }
    }
    const ds = cfg.provider?.providers?.deepseek
    if (!ds) return { ok: false, label: '缺失（配置里没有 deepseek 段）' }
    if (ds.apiKey) return { ok: true, label: '可用（配置内联 apiKey）' }
    if (ds.apiKeyEnv && process.env[ds.apiKeyEnv]) return { ok: true, label: `可用（env ${ds.apiKeyEnv}）` }
    if (ds.keyRef) return { ok: true, label: '已配置（keyRef，运行时解析）' }
    return { ok: false, label: '缺失' }
  } catch { return { ok: false, label: '缺失（读不到 config.json）' } }
}

const entry = resolveChildEntry()
const provider = providerHint()

console.log('── 环境体检 ──')
console.log(`  RIVET_WORKER_ISOLATION: ${process.env.RIVET_WORKER_ISOLATION ?? '(未设置 → 默认关)'}`)
console.log(`  开关生效: ${workerIsolationEnabled()}（脚本直接调 OOP runner，不依赖该开关——开关只控制 bootstrap 接线）`)
console.log(`  child 入口: ${entry ? entry.script : '缺失（会回退进程内 → 烧机无意义）'}`)
console.log(`  provider 凭据: ${provider.label}${provider.ok ? '' : '（--live 的任务层预计失败，机制层仍可验）'}`)

if (!live) {
  console.log('\n── 派发计划（--dry-run，不 spawn）──')
  console.log(`  计划派发 worker 数: ${count}`)
  console.log('  采集指标: 子进程起落(pid/退出码/存活时长) · 主线程 loop-lag(最大漂移 + >2s 尖峰数) · 分层失败率')
  console.log(`  判据: loop-lag 无 ${LAG_SPIKE_MS}ms+ 尖峰 + 子进程随派发起落`)
  console.log(`\n  真跑: npx tsx scripts/verify-worker-isolation.ts --live -n ${count}`)
  process.exit(0)
}

if (!entry) {
  console.error('\n✗ child 入口缺失——隔离会回退进程内，烧机没有意义。先跑 npm run build（产出 dist/agent/worker-process/child.js）。')
  process.exit(1)
}

// ── 真派发 ────────────────────────────────────────────────────────

function makeConfig(): WorkerSessionConfig {
  return {
    order: {
      id: 'wo_isolation_probe',
      objective: '进程隔离烧机探针',
      profile: 'code_scout',
      allowedTools: ['read_file'],
      disallowedTools: [],
      constraints: [],
      files: [],
      scope: { files: [] },
      // timeoutMs 是硬超时（worker-session.ts:940 setTimeout(config.order.budget.timeoutMs)）——
      // 缺它会退化成 setTimeout(fn, undefined) 立即 abort，worker 连一次 LLM 都调不到。
      budget: { maxTurns: 3, maxTokens: 800, timeoutMs: 60_000, wallClockMs: 45_000, inputTokens: 4000, outputTokens: 800 },
    } as unknown as WorkOrder,
    client: {} as WorkerSessionConfig['client'],
    promptEngine: {} as WorkerSessionConfig['promptEngine'],
    toolRegistry: {} as WorkerSessionConfig['toolRegistry'],
    cwd: process.cwd(),
    maxTurns: 1,
    contextWindow: 64000,
    compact: { enabled: false, model: 'flash' },
    runtimeDecision: {
      providerName: 'deepseek', model: 'deepseek-v4-flash', maxTokens: 512,
      contextWindow: 64000, thinkingBudget: 512, isWrite: false,
    },
    activeClaims: [],
  } as WorkerSessionConfig
}

interface ChildRecord {
  pid: number | undefined
  startedAt: number
  exitedAt?: number
  code?: number | null
  taskStatus?: string
  /** 子进程 stderr 尾部——父侧只在 result 里带最后 3 行，诊断不够。 */
  stderr?: string
  /** 子进程 stdout 尾部（NDJSON 帧）——child 的崩溃原因常以 log 帧上行，
   *  父侧合成进 result.summary 时会被截断，这里留全量尾部供诊断。 */
  stdout?: string
}

const children: ChildRecord[] = []

const opts: WorkerOopOptions = {
  getMemoryBlock: () => undefined,
  stallMsOverride: STALL_MS,
  entryOverride: entry,
  // 自己 spawn 才能拿到 pid——runWorkerSessionOop 的默认 spawn 不暴露句柄。
  spawnOverride: (execArgs, script) => {
    const child: ChildProcess = spawn(process.execPath, [...execArgs, script, '--worker-child'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
      windowsHide: true,
    })
    const rec: ChildRecord = { pid: child.pid, startedAt: Date.now() }
    children.push(rec)
    child.stderr?.on('data', (c: Buffer) => {
      rec.stderr = `${rec.stderr ?? ''}${String(c)}`.slice(-3000)
    })
    child.stdout?.on('data', (c: Buffer) => {
      rec.stdout = `${rec.stdout ?? ''}${String(c)}`.slice(-4000)
    })
    child.on('exit', (code) => { rec.exitedAt = Date.now(); rec.code = code })
    return child
  },
}

// loop-lag 采样：10ms 心跳的实际漂移，报告最大漂移与 >2s 尖峰数。
const lagSamples: number[] = []
let lastTick = Date.now()
const sampler = setInterval(() => {
  const now = Date.now()
  lagSamples.push(Math.max(0, now - lastTick - 10))
  lastTick = now
}, 10)
sampler.unref?.()

console.log(`\n── 真派发 ${count} 个 worker 子进程 ──`)
const taskStatuses: string[] = []
for (let i = 0; i < count; i++) {
  const startIdx = children.length
  try {
    const run = await runWorkerSessionOop(makeConfig(), opts)
    taskStatuses.push(run.result.status)
    // 用本轮起点索引精确关联 rec——`children[length-1]` 在本轮未 spawn（entry
    // 缺失/提前抛错）时会指到上一轮的记录，把任务状态误标过去。
    const rec = children[startIdx]
    if (rec) rec.taskStatus = run.result.status
    console.log(`  #${i + 1} 任务层=${run.result.status} 原因=${run.result.failureReason ?? '-'}`)
    // 失败时把 summary 带出来（父侧已把子进程 stderr 尾部合成在里面）——
    // 只报 failed 而不报原因，烧机等于白跑。
    if (run.result.status !== 'passed' && run.result.summary) {
      console.log(`      ↳ ${run.result.summary.slice(0, 240)}`)
    }
    if (run.result.status !== 'passed' && rec && rec.stderr) {
      const tail = rec.stderr.trim().split('\n').slice(-6).join('\n        ')
      console.log(`      stderr 尾部:\n        ${tail}`)
    }
    // child 的崩溃原因常以 log 帧走 stdout（父侧合成 summary 时会截断）——
    // 失败时把帧尾部带出来，否则「任务层 failed」没有可诊断的因果。
    if (run.result.status !== 'passed' && rec?.stdout) {
      const frames = rec.stdout.trim().split('\n').slice(-4).join('\n        ')
      console.log(`      stdout 帧尾部:\n        ${frames.slice(0, 1200)}`)
    }
  } catch (err) {
    taskStatuses.push('throw')
    // spawn 成功但接线失败（如 stdio 不可用）：子进程可能仍在跑——如实标注，
    // 不留给对账表一条无状态的幽灵记录。
    const rec = children[startIdx]
    if (rec && rec.exitedAt === undefined) rec.taskStatus = 'unwired'
    console.log(`  #${i + 1} 抛出: ${err instanceof Error ? err.message : String(err)}`)
  }
}

clearInterval(sampler)
// 给子进程一点自然收尾时间（终态后的击杀梯有 300ms 宽限）。
await new Promise((r) => setTimeout(r, 800))

// ── 对账表 ────────────────────────────────────────────────────────

const maxLag = lagSamples.length > 0 ? Math.max(...lagSamples) : 0
const spikes = lagSamples.filter((d) => d > LAG_SPIKE_MS).length
const exited = children.filter((c) => c.exitedAt !== undefined).length
const alive = children.length - exited
const taskFailed = taskStatuses.filter((s) => s !== 'passed').length

console.log('\n── 对账表 ──')
console.log(`  子进程: 派发 ${children.length} / 已收尾 ${exited} / 仍存活 ${alive}`)
for (const [i, c] of children.entries()) {
  const life = c.exitedAt ? `${c.exitedAt - c.startedAt}ms` : '存活中'
  console.log(`    #${i + 1} pid=${c.pid ?? '-'} 退出码=${c.code ?? '-'} 存活=${life} 任务层=${c.taskStatus ?? '-'}`)
}
console.log(`  主线程 loop-lag: 样本 ${lagSamples.length} / 最大漂移 ${maxLag}ms / >${LAG_SPIKE_MS}ms 尖峰 ${spikes}`)
console.log(`  失败率: 进程层 ${alive === 0 ? '0' : `${alive}/${children.length} 未收尾`} · 任务层 ${taskFailed}/${taskStatuses.length}（最小 config，非隔离判据${provider.ok ? '' : '；provider 凭据也缺'}）`)
// 判据失败即非零退出——脚本要能接自动化门禁，不能只靠人眼看对账表。
const judgeOk = spikes === 0 && alive === 0
console.log(`\n  判据: ${spikes === 0 ? '✅' : '❌'} loop-lag 无 ${LAG_SPIKE_MS}ms+ 尖峰 · ${alive === 0 ? '✅' : '⚠️'} 子进程随派发全部收尾`)

process.exit(judgeOk ? 0 : 1)

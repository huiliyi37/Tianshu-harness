/**
 * worker-process parent — OOP（out-of-process）运行器，worker 子进程隔离 v1。
 *
 * 以 coordinator 的 runWorker 缝（同 runWorkerSession 签名）接入：序列化
 * 配置 → spawn 子进程（stdio NDJSON）→ 桥接四回调（activity/nested/mailbox/
 * steer）+ abort 下行 → watchdog（activity/tick 任一重置）→ 终态映射回
 * WorkerSessionRun。子进程崩溃/停摆合成 failed WorkerResult（failureReason
 * worker_crash/stalled），coordinator 既有重派与断路器接管恢复。
 *
 * 击杀梯度对齐 ZCode 实证方案：SIGTERM → 300ms 宽限 → SIGKILL（经
 * killProcessTree 整树击杀，Windows taskkill /T /F）。
 *
 * 入口缺失 / spawn 失败 → 抛 WorkerOopUnavailable，bootstrap 接线处捕获并
 * 回退进程内 runWorkerSession（灰度期零破坏）。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { killProcessTree } from '../../tools/process-kill.js'
import { deriveWorkerStallMs } from '../worker-liveness.js'
import type { WorkerSessionConfig, WorkerSessionRun } from '../worker-session.js'
import type { SessionContext } from '../context.js'
import type { OaiMessage, Usage } from '../../api/types.js'
import type { WorkerResult } from '../work-order.js'
import { debugLog } from '../../utils/debug.js'
import {
  encodeFrame, createFrameDecoder,
  CHILD_TICK_INTERVAL_MS, CHILD_TERM_GRACE_MS, CHILD_KILL_GRACE_MS,
  type SerializedWorkerRun, type WorkerChildInitPayload, type ChildMessage,
} from './protocol.js'
import { runWorkerSession } from '../worker-session.js'

export type WorkerIsolationMode = 'off' | 'all' | 'review'

/** 子进程隔离模式：
 *  - `RIVET_WORKER_ISOLATION=1|true|all` → 全部 worker 走子进程
 *  - `=review` → 只隔离审查类 worker（提交后审查门 + squadron 检查员）
 *  - 未设置 / 其他值 → 关闭（进程内）
 *
 *  v1 默认关——实机烧机一个版本后翻默认，见 known-issues 计划篇。`review` 是针对
 *  「审查 worker 卡死连累主 TUI」的窄口径开关：不动其余 worker 的成熟进程内路径。 */
export function workerIsolationMode(): WorkerIsolationMode {
  const v = process.env.RIVET_WORKER_ISOLATION
  if (v === '1' || v === 'true' || v === 'all') return 'all'
  if (v === 'review') return 'review'
  return 'off'
}

export function workerIsolationEnabled(): boolean {
  return workerIsolationMode() !== 'off'
}

/** 审查类 worker profile——`review` 模式只隔离这些。`reviewer` 覆盖提交后审查门
 *  与 squadron 全部检查员（review-coordinator-deps 构造的 work order 统一用它）。
 *  新增审查 profile 时在这里登记，别散落到派发点。 */
const REVIEW_WORKER_PROFILES = new Set(['reviewer'])

export function isReviewWorkerProfile(profile: string | undefined): boolean {
  return profile !== undefined && REVIEW_WORKER_PROFILES.has(profile)
}

/** OOP runner 工厂（含回退）：WorkerOopUnavailable（entry 缺失/spawn 失败/
 *  决策未盖戳）时回退进程内 runWorkerSession——灰度期零破坏。 */
export function createOopRunnerWithFallback(
  opts: WorkerOopOptions,
): (config: WorkerSessionConfig) => Promise<WorkerSessionRun> {
  return async (config) => {
    try {
      return await runWorkerSessionOop(config, opts)
    } catch (err) {
      if (err instanceof WorkerOopUnavailable) {
        debugLog(`[worker-oop] unavailable: ${err.message} — falling back to in-process runWorkerSession`)
        return runWorkerSession(config)
      }
      throw err
    }
  }
}

/** 子进程不可用（entry 缺失/spawn 失败）——接线处据此回退进程内。 */
export class WorkerOopUnavailable extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'WorkerOopUnavailable'
  }
}

/** 按隔离模式组合 runner：`all` 全部走 OOP；`review` 仅审查 worker 走 OOP，其余
 *  保持进程内 `runWorkerSession`（成熟路径零变化）；`off` 全部进程内。`inProcess`
 *  可注入（测试断言分派路径，不真跑 session）。 */
export function createModeAwareRunner(
  mode: WorkerIsolationMode,
  opts: WorkerOopOptions,
  inProcess: (config: WorkerSessionConfig) => Promise<WorkerSessionRun> = runWorkerSession,
): (config: WorkerSessionConfig) => Promise<WorkerSessionRun> {
  const oop = createOopRunnerWithFallback(opts)
  if (mode === 'all') return oop
  return async (config) => {
    if (mode === 'review' && isReviewWorkerProfile(config.order.profile)) return oop(config)
    return inProcess(config)
  }
}

/** 子进程 entry 解析：dist 形态（tsup 镜像源码树）优先，dev 回退 tsx 直跑 .ts。
 *  两者都不存在 → null（公开仓裁剪/tsx 不可用等）。 */
export function resolveChildEntry(): { execArgs: string[]; script: string } | null {
  const distUrl = new URL('./child.js', import.meta.url)
  try {
    const distPath = fileURLToPath(distUrl)
    if (existsSync(distPath)) return { execArgs: [], script: distPath }
  } catch { /* fall through */ }
  const devUrl = new URL('./child.ts', import.meta.url)
  try {
    const devPath = fileURLToPath(devUrl)
    if (existsSync(devPath)) return { execArgs: ['--import', 'tsx'], script: devPath }
  } catch { /* fall through */ }
  return null
}

/** 诊断环形缓冲（子进程 stderr + log 帧汇入，失败时随结果带出）。 */
const STDERR_RING_CAP = 40

export interface WorkerOopOptions {
  /** 主会话会话记忆块快照来源（bootstrap 的 persist.buildMemoryBlock）。 */
  getMemoryBlock: () => string | undefined
  /** watchdog 覆盖注入（测试用）；缺省 deriveWorkerStallMs。 */
  stallMsOverride?: number
  /** entry 覆盖注入（测试用）。 */
  entryOverride?: { execArgs: string[]; script: string } | null
  /** spawn 覆盖注入（测试用假子进程）。 */
  spawnOverride?: (execArgs: string[], script: string) => ChildProcess
}

export async function runWorkerSessionOop(
  config: WorkerSessionConfig,
  opts: WorkerOopOptions,
): Promise<WorkerSessionRun> {
  const entry = opts.entryOverride !== undefined ? opts.entryOverride : resolveChildEntry()
  if (!entry) throw new WorkerOopUnavailable('worker child entry not found (dist/tsx)')
  if (!config.runtimeDecision) throw new WorkerOopUnavailable('config.runtimeDecision absent — buildWorkerRuntime 未盖戳')

  const decision = config.runtimeDecision
  const initPayload: WorkerChildInitPayload = {
    config: {
      order: config.order,
      cwd: config.cwd,
      maxTurns: config.maxTurns,
      contextWindow: config.contextWindow,
      compact: config.compact,
      runtimeDecision: decision,
      providerName: config.providerName,
      baseUrl: config.baseUrl,
      slowThinking: config.slowThinking,
      forceJsonRepair: config.forceJsonRepair,
      finalizeReport: config.finalizeReport,
      reviewDepth: config.reviewDepth,
      parentApprovalMode: config.parentApprovalMode,
      priorMessages: config.priorMessages ? [...config.priorMessages] : undefined,
      priorUsage: config.priorUsage,
      priorFrozenSnapshot: config.priorFrozenSnapshot,
      sessionNonce: config.sessionNonce,
      checkpoint: config.checkpoint,
    },
    memoryBlock: opts.getMemoryBlock(),
    activeClaims: [...(config.activeClaims ?? [])],
  }

  const stallMs = opts.stallMsOverride ?? deriveWorkerStallMs({
    providerName: config.providerName,
    baseUrl: config.baseUrl,
    slowThinking: config.slowThinking,
    isWrite: decision.isWrite,
  })
  // watchdog 必须长于心跳间隔——tick 是活性的下限证明。显式覆盖（测试注入）
  // 时精确尊重：测试自己保证覆盖 > 心跳；推导值才做 4×tick 地板。
  const watchdogMs = opts.stallMsOverride ?? Math.max(stallMs, CHILD_TICK_INTERVAL_MS * 4)

  const doSpawn = opts.spawnOverride ?? ((execArgs: string[], script: string) =>
    spawn(process.execPath, [...execArgs, script, '--worker-child'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
      windowsHide: true,
    }))
  const child = doSpawn(entry.execArgs, entry.script)
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new WorkerOopUnavailable('child stdio unavailable')
  }
  // 闭包内 narrowing 会丢——先钉住非空句柄。
  const stdin = child.stdin
  const stdout = child.stdout
  const stderr = child.stderr
  stdout.setEncoding('utf8')
  stderr.setEncoding('utf8')

  const stderrRing: string[] = []
  const pushRing = (line: string): void => {
    stderrRing.push(line)
    if (stderrRing.length > STDERR_RING_CAP) stderrRing.shift()
  }

  let settled = false
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let killStage: 'none' | 'term' | 'kill' = 'none'

  const cleanup = (): void => {
    if (watchdogTimer) clearTimeout(watchdogTimer)
    if (killTimer) clearTimeout(killTimer)
  }

  const killLadder = (reason: string): void => {
    if (killStage === 'none' && child.pid) {
      killStage = 'term'
      killProcessTree(child, 'SIGTERM')
      killTimer = setTimeout(() => {
        killStage = 'kill'
        if (child.pid) killProcessTree(child, 'SIGKILL')
      }, CHILD_TERM_GRACE_MS)
      killTimer.unref?.()
      debugLog(`[worker-oop] ${config.order.id}: kill ladder armed (${reason})`)
    }
  }

  return new Promise<WorkerSessionRun>((resolve) => {
    const armWatchdog = (): void => {
      if (watchdogTimer) clearTimeout(watchdogTimer)
      watchdogTimer = setTimeout(() => {
        if (!settled) killLadder(`stall >${watchdogMs}ms`)
      }, watchdogMs)
      watchdogTimer.unref?.()
    }

    const settleWith = (run: WorkerSessionRun): void => {
      if (settled) return
      settled = true
      cleanup()
      // 终态后给子进程一点自然退出时间；仍挂着就走击杀梯（防僵尸）。
      setTimeout(() => {
        if (child.exitCode === null && child.pid) killLadder('post-result cleanup')
      }, CHILD_KILL_GRACE_MS).unref?.()
      resolve(run)
    }

    /** 子进程死亡且无 result——崩溃/被击杀，合成 failed 结果交 coordinator 重派。 */
    const synthesizeFailure = (failureReason: WorkerResult['failureReason'], summary: string): void => {
      const tail = stderrRing.slice(-3).join(' | ')
      settleWith({
        result: {
          workOrderId: config.order.id,
          status: 'failed',
          summary: tail.length > 0 ? `${summary}（子进程日志尾：${tail.slice(0, 200)}）` : summary,
          findings: [],
          artifacts: [],
          changedFiles: [],
          risks: [],
          nextActions: [],
          evidenceStatus: 'skipped',
          failureReason,
          objective: config.order.objective,
          profile: config.order.profile,
        },
        transcript: { text: '', thinking: '', toolUses: [], toolResults: [], repairAttempts: 0, errors: [summary] },
        // SessionContext 是宽接口，消费方（coordinator.ts:2643/2617）只 duck-type
        // getMessages——OOP 场景没有活 context，投影成最小面。
        session: { getMessages: () => [] as OaiMessage[] } as unknown as SessionContext,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      })
    }

    const mapResult = (run: SerializedWorkerRun): WorkerSessionRun => ({
      result: run.result,
      transcript: run.transcript,
      session: { getMessages: () => run.messages } as unknown as SessionContext,
      usage: run.usage,
      checkpoint: run.checkpoint,
      frozenSnapshot: run.frozenSnapshot,
    })

    const decoder = createFrameDecoder()
    stdout.on('data', (chunk: string) => {
      for (const msg of decoder.feed(chunk) as ChildMessage[]) {
        if (settled) continue
        switch (msg.t) {
          case 'activity':
            armWatchdog()
            config.onActivity?.(msg.kind, msg.detail)
            break
          case 'nested':
            armWatchdog()
            config.onNestedDelegation?.(msg.activity)
            break
          case 'mailbox':
            config.mailbox?.send(msg.msg)
            break
          case 'tick':
            armWatchdog()
            break
          case 'log':
            pushRing(msg.line)
            break
          case 'result':
            settleWith(mapResult(msg.run))
            break
        }
      }
    })
    stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) if (line.trim()) pushRing(line.trim())
    })
    child.on('error', (err) => {
      if (!settled) synthesizeFailure('worker_crash', `child spawn/pipe error: ${err.message}`)
    })
    child.on('close', (code) => {
      if (!settled) {
        synthesizeFailure(
          killStage === 'none' ? 'worker_crash' : 'stalled',
          killStage === 'none'
            ? `worker child exited unexpectedly (code=${code ?? 'null'})`
            : `worker child killed by watchdog (stage=${killStage})`,
        )
      }
    })

    // abort 下行：转发给子进程（其内部有 salvage 宽限）；本侧 watchdog 兜底
    // 击杀不退出的僵死子进程。abort 后不停表——等 result 或 watchdog。
    if (config.abortSignal) {
      const onAbort = (): void => {
        try { stdin.write(encodeFrame({ t: 'abort', reason: String(config.abortSignal?.reason ?? 'caller_aborted') })) } catch { /* stdin 已关——close 事件兜底 */ }
      }
      if (config.abortSignal.aborted) onAbort()
      else config.abortSignal.addEventListener('abort', onAbort, { once: true })
    }

    // steer 桥：coordinator 的 onSteerDrain 在父侧排空队列 → 转发子进程。
    if (config.onSteerDrain) {
      const parentDrain = config.onSteerDrain
      config.onSteerDrain = () => {
        const text = parentDrain()
        if (text) {
          try { stdin.write(encodeFrame({ t: 'steer', text })) } catch { /* best-effort */ }
        }
        return text
      }
    }

    armWatchdog()
    try {
      stdin.write(encodeFrame({ t: 'init', payload: initPayload }))
    } catch (err) {
      synthesizeFailure('worker_crash', `failed to write init frame: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
}

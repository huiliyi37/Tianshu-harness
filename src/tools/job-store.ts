import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, createWriteStream, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { track } from './process-tracker.js'
import { killProcessTree, spawnShell } from './process-kill.js'
import {
  getShellCommand,
  WinStreamDecoder,
  rewriteWindowsNullRedirect,
  rewritePowershellNullRedirect,
} from '../platform.js'
import { debugLog } from '../utils/debug.js'
import { verificationWaitBudget } from './verification-wait.js'

/** Cap for the in-memory ring buffer kept per job (bytes of decoded text). */
const RING_CAP = 64_000
/** Minimum interval between throttled `output` events (ms). */
const OUTPUT_THROTTLE_MS = 500
/** await 长等待的心跳间隔（ms）——由会话层注入上报器时生效。绑真实状态：
 *  每 tick 复查 job.status，终态即停；不是空转 timer（见 SessionJobs.await）。 */
const DEFAULT_AWAIT_HEARTBEAT_MS = 30_000

/** Absolute wall-clock cap on a background job's lifetime (ms). 0/unset = unlimited.
 *  Off by default: background jobs are intentionally long-lived (dev servers,
 *  watchers), so a blanket timeout would kill legitimate work. Eval/CI harnesses
 *  set RIVET_JOB_MAX_MS to reap runaway/orphaned jobs that never exit and would
 *  otherwise hold ports/resources until session close. */
export function jobMaxLifetimeMs(): number {
  const v = Number.parseInt(process.env.RIVET_JOB_MAX_MS ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : 0
}

export type JobStatus = 'running' | 'exited' | 'killed'

/** Serializable snapshot of a background job — safe to send over SSE / REST. */
export interface JobSnapshot {
  id: string
  command: string
  status: JobStatus
  exitCode?: number
  startedAt: number
  endedAt?: number
  /** Last non-empty line of output (dashboard preview). */
  lastLine: string
  pid?: number
}

/** 后台 job 的验证元数据（tools 层自持的**私有**上下文）。
 *  刻意不进 JobSnapshot 的公开字段白名单：`SessionJobs.list()`/`snapshot()`
 *  会被服务端直接返回给客户端，私有判据绝不能外泄到 snapshot。
 *  由 spawn 侧在启动后台 job 时一次性写入（命令事实的唯一解析点，见
 *  agent/verification-intent.ts），消费方按此判定「是否在等门禁钦定证据」，
 *  取代每个检查点重新猜整条命令的旧实现。 */
export interface JobVerificationMeta {
  waitingEligible: boolean
  purpose: string
  lifetime: string
  source: string
}

export interface JobEvent {
  kind: 'started' | 'output' | 'exit'
  job: JobSnapshot
  /** Present only for `output` events — the newly appended text since last emit. */
  chunk?: string
}

export interface JobSpawnOptions {
  onCompleted?: (result: { job: JobSnapshot; output: string; error?: string; timedOut: boolean }) => void
  /** The command actually executed (post rtk/mirror/sandbox rewrite). */
  command: string
  /** Original command for display (pre-rewrite). */
  rawCommand: string
  cwd: string
  /** Fully-prepared child environment (sanitized + mirror overlay by caller). */
  env: Record<string, string | undefined>
  /** Absolute wall-clock cap before the job is auto-killed (SIGTERM→SIGKILL).
   *  Omitted → falls back to RIVET_JOB_MAX_MS (0 = unlimited). */
  maxLifetimeMs?: number
}

export interface JobAwaitOptions {
  /** Regex source matched against accumulated output; resolves early on a hit. */
  pattern?: string
  timeoutMs?: number
}

export interface JobAwaitResult {
  job: JobSnapshot
  /** True when `pattern` matched the output before exit/timeout. */
  matched: boolean
  timedOut: boolean
  /** Tail of the output ring at resolution time. */
  tail: string
}

interface Waiter {
  resolve: (r: JobAwaitResult) => void
  regex?: RegExp
  timer: ReturnType<typeof setTimeout> | null
}

class BackgroundJob {
  readonly id: string
  readonly command: string
  readonly startedAt = Date.now()
  status: JobStatus = 'running'
  exitCode?: number
  endedAt?: number

  private ring = ''
  private child: ChildProcess | null = null
  private pid?: number
  private logStream: WriteStream | null = null
  private logClosed: Promise<void> = Promise.resolve()
  private resolveFinished!: () => void
  private readonly finished = new Promise<void>(resolve => { this.resolveFinished = resolve })
  private killTimer: ReturnType<typeof setTimeout> | null = null
  private lifetimeTimer: ReturnType<typeof setTimeout> | null = null
  private waiters: Waiter[] = []
  private completed = false
  private spawnError?: string
  private timedOut = false
  private readonly decoderOut = new WinStreamDecoder()
  private readonly decoderErr = new WinStreamDecoder()

  // Output throttling — coalesce bursts into ≤1 event / OUTPUT_THROTTLE_MS.
  private pendingChunk = ''
  private throttleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly opts: JobSpawnOptions,
    private readonly emit: (ev: JobEvent) => void,
  ) {
    this.id = randomUUID().slice(0, 8)
    this.command = opts.rawCommand
  }

  start(logPath: string): void {
    try {
      this.logStream = createWriteStream(logPath, { flags: 'a' })
      this.logClosed = new Promise(resolve => { this.logStream!.once('close', resolve) })
      // Disk logging is best-effort — a write/open failure (e.g. dir removed)
      // must never throw asynchronously and crash the process.
      this.logStream.on('error', () => { this.logStream = null })
    } catch {
      this.logStream = null
    }

    const shell = getShellCommand()
    let commandToRun = this.opts.command
    if (shell.kind === 'bash') {
      commandToRun = rewriteWindowsNullRedirect(this.opts.command)
    } else if (shell.kind === 'powershell') {
      commandToRun = `$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${rewritePowershellNullRedirect(this.opts.command)}`
    } else if (shell.kind === 'cmd') {
      // See bash.ts: `chcp 65001 > nul &&` prefix removed — the `nul` redirect
      // fails in sandboxed/WSL Windows (exit=1, empty stdout). WinStreamDecoder
      // auto-detects GBK vs UTF-8 on the first chunk, so chcp is unnecessary.
      commandToRun = this.opts.command
    }

    debugLog(`[job-spawn] id=${this.id} kind=${shell.kind} cwd=${this.opts.cwd}`)
    const child = track(spawnShell(shell, commandToRun, {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Match bash.ts: detached process group on POSIX so kill(-pid) reaps the
      // whole tree; NOT detached on Windows (breaks stdio pipes on cmd.exe).
      detached: process.platform !== 'win32',
      windowsHide: true,
    }))
    this.child = child
    this.pid = child.pid

    // Absolute lifetime cap (opt-in): reap a job that never exits on its own.
    const maxMs = this.opts.maxLifetimeMs ?? jobMaxLifetimeMs()
    if (maxMs > 0) {
      this.lifetimeTimer = setTimeout(() => this.onLifetimeExceeded(maxMs), maxMs)
      if (typeof this.lifetimeTimer.unref === 'function') this.lifetimeTimer.unref()
    }

    child.stdout?.on('data', (d: Buffer) => this.onData(this.decoderOut.write(d)))
    child.stderr?.on('data', (d: Buffer) => this.onData(this.decoderErr.write(d)))
    child.on('close', (code) => this.onExit(code ?? 1))
    child.on('error', (err) => {
      this.spawnError = err.message
      this.onData(`\n[job error] ${err.message}\n`)
      this.onExit(1)
    })

    this.emit({ kind: 'started', job: this.snapshot() })
  }

  private onData(text: string): void {
    if (!text) return
    this.ring += text
    if (this.ring.length > RING_CAP) this.ring = this.ring.slice(-RING_CAP)
    try { this.logStream?.write(text) } catch { /* best-effort */ }

    // Resolve any pattern waiters whose regex now matches the accumulated ring.
    if (this.waiters.length > 0) {
      const remaining: Waiter[] = []
      for (const w of this.waiters) {
        if (w.regex && w.regex.test(this.ring)) {
          if (w.timer) clearTimeout(w.timer)
          w.resolve({ job: this.snapshot(), matched: true, timedOut: false, tail: this.tail() })
        } else {
          remaining.push(w)
        }
      }
      this.waiters = remaining
    }

    this.pendingChunk += text
    if (!this.throttleTimer) {
      this.throttleTimer = setTimeout(() => this.flushOutput(), OUTPUT_THROTTLE_MS)
    }
  }

  private flushOutput(): void {
    if (this.throttleTimer) { clearTimeout(this.throttleTimer); this.throttleTimer = null }
    if (!this.pendingChunk) return
    const chunk = this.pendingChunk
    this.pendingChunk = ''
    this.emit({ kind: 'output', job: this.snapshot(), chunk })
  }

  /** Fired when the job outlives its configured wall-clock cap: note the reason
   *  (so logs/await surface it) then terminate via the normal SIGTERM→SIGKILL path. */
  private onLifetimeExceeded(maxMs: number): void {
    this.lifetimeTimer = null
    if (this.status !== 'running') return
    this.timedOut = true
    const secs = Math.round(maxMs / 1000)
    this.onData(`\n[job killed] exceeded max lifetime (${secs}s) — auto-terminated\n`)
    this.kill()
  }

  private onExit(code: number): void {
    if (this.completed) return
    this.completed = true
    if (this.killTimer) { clearTimeout(this.killTimer); this.killTimer = null }
    if (this.lifetimeTimer) { clearTimeout(this.lifetimeTimer); this.lifetimeTimer = null }
    if (this.status !== 'running') {
      // Already killed — keep the killed status but record the code/time.
      this.exitCode = code
      this.endedAt = Date.now()
    } else {
      this.status = 'exited'
      this.exitCode = code
      this.endedAt = Date.now()
    }
    this.ring += this.decoderOut.end() + this.decoderErr.end()
    if (this.ring.length > RING_CAP) this.ring = this.ring.slice(-RING_CAP)
    this.flushOutput()
    try { this.logStream?.end() } catch { /* best-effort */ }
    this.logStream = null

    for (const w of this.waiters) {
      if (w.timer) clearTimeout(w.timer)
      w.resolve({ job: this.snapshot(), matched: false, timedOut: false, tail: this.tail() })
    }
    this.waiters = []
    try { this.opts.onCompleted?.({ job: this.snapshot(), output: this.ring, error: this.spawnError, timedOut: this.timedOut }) }
    catch (error) { debugLog(`[job-completion-error] ${error instanceof Error ? error.message : String(error)}`) }
    this.emit({ kind: 'exit', job: this.snapshot() })
    void this.logClosed.then(() => this.resolveFinished())
  }

  await(opts: JobAwaitOptions): Promise<JobAwaitResult> {
    if (this.status !== 'running') {
      return Promise.resolve({ job: this.snapshot(), matched: false, timedOut: false, tail: this.tail() })
    }
    let regex: RegExp | undefined
    if (opts.pattern) {
      try { regex = new RegExp(opts.pattern) } catch { regex = undefined }
    }
    // Fast path: pattern already satisfied by buffered output.
    if (regex && regex.test(this.ring)) {
      return Promise.resolve({ job: this.snapshot(), matched: true, timedOut: false, tail: this.tail() })
    }
    return new Promise<JobAwaitResult>((resolve) => {
      const waiter: Waiter = { resolve, regex, timer: null }
      const timeoutMs = opts.timeoutMs ?? 120_000
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter)
        resolve({ job: this.snapshot(), matched: false, timedOut: true, tail: this.tail() })
      }, timeoutMs)
      this.waiters.push(waiter)
    })
  }

  /** 返回是否真发了信号——终态 job 返回 false，调用方不得据 true 覆盖其真实结局。 */
  kill(): boolean {
    if (this.status !== 'running' || !this.child) return false
    if (this.lifetimeTimer) { clearTimeout(this.lifetimeTimer); this.lifetimeTimer = null }
    this.status = 'killed'
    killProcessTree(this.child, 'SIGTERM')
    const child = this.child
    this.killTimer = setTimeout(() => {
      this.killTimer = null
      killProcessTree(child, 'SIGKILL')
    }, 3000)
    if (typeof this.killTimer.unref === 'function') this.killTimer.unref()
    return true
  }

  logs(): string {
    return this.ring
  }

  /** Wait for child close and log close, including jobs already marked killed. */
  async killAsync(): Promise<boolean> {
    const signalled = this.kill()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.finished,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Job ${this.id} cleanup timed out`)), 5000)
        }),
      ])
      return signalled
    } finally { clearTimeout(timer) }
  }

  private tail(limit = 4000): string {
    return this.ring.length > limit ? this.ring.slice(-limit) : this.ring
  }

  snapshot(): JobSnapshot {
    return {
      id: this.id,
      command: this.command,
      status: this.status,
      exitCode: this.exitCode,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      lastLine: lastNonEmptyLine(this.ring),
      pid: this.pid,
    }
  }
}

/** Public handle injected into tools (bash / job) — hides the class internals. */
export interface JobRegistry {
  spawn(opts: JobSpawnOptions): JobSnapshot
  await(id: string, opts: JobAwaitOptions): Promise<JobAwaitResult | null>
  list(): JobSnapshot[]
  logs(id: string): string | null
  kill(id: string): boolean
  /** 记录 spawn 时解析出的验证元数据（见 JobVerificationMeta）——由 spawn
   *  调用方（bash 后台分支）写入，供收敛检测读取「是否在等门禁钦定证据」。 */
  recordVerificationMeta(id: string, meta: JobVerificationMeta, input?: Record<string, unknown>): void
}

/** Per-session collection of background jobs; also an event source for the server. */
export class SessionJobs extends EventEmitter implements JobRegistry {
  /** 终态条目内存上限：超出时淘汰最旧的终态 job（ring buffer/child 引用随之
   *  释放；磁盘日志保留，淘汰只影响内存态）。running 永不淘汰。 */
  static readonly MAX_TERMINAL_JOBS = 50
  private jobs = new Map<string, BackgroundJob>()
  /** 各 job 的验证元数据（见 JobVerificationMeta）——与 jobs 同生命周期，
   *  终态淘汰时一并清理（evictTerminals），避免无人回收的泄漏。 */
  private verificationMeta = new Map<string, JobVerificationMeta & { ownerTaskEpoch: number; waitUntil: number; budgetSource: string }>()
  private taskEpoch = 0
  /** P0：任务边界号的权威 provider（WorkProgressFacts.taskEpoch）。注入后
   *  ownerTaskEpoch 盖章与等待资格比对读同一边界；null = 退回内部计数器
   *  （beginTask 推进，仅测试/无 agent 装配路径使用）。 */
  private taskEpochProvider: (() => number) | null = null

  constructor(
    private readonly logDir: string,
    /** 长时等待上报（可选）：await 期间按心跳回调 `job:await:<id>`，由会话层
     *  注入 touchActivity(sessionId, source)——stall-observer 据此把"合法长等待"
     *  与"卡死"区分开（2026-09-10 纵深修复）。缺省 = 不上报。 */
    private readonly onAwaitHeartbeat?: (source: string) => void,
    private readonly heartbeatMs: number = DEFAULT_AWAIT_HEARTBEAT_MS,
  ) {
    super()
  }

  spawn(opts: JobSpawnOptions): JobSnapshot {
    const job = new BackgroundJob(opts, (ev) => {
      this.emit('event', ev)
      if (ev.kind === 'exit') this.evictTerminals()
    })
    this.jobs.set(job.id, job)
    let logPath = ''
    try {
      mkdirSync(this.logDir, { recursive: true })
      logPath = join(this.logDir, `${job.id}.log`)
    } catch { /* best-effort — job still runs, just no on-disk log */ }
    job.start(logPath)
    return job.snapshot()
  }

  async await(id: string, opts: JobAwaitOptions): Promise<JobAwaitResult | null> {
    const job = this.jobs.get(id)
    if (!job) return null
    // 长等待心跳：等待期间按间隔上报"job 仍 running"（绑真实状态——每 tick 复查
    // snapshot().status，一进终态就停表，由 exit/timeout 的 resolve 路径接手）。
    let heartbeat: ReturnType<typeof setInterval> | undefined
    if (this.onAwaitHeartbeat && this.heartbeatMs > 0) {
      const report = this.onAwaitHeartbeat
      heartbeat = setInterval(() => {
        if (job.snapshot().status === 'running') report(`job:await:${id}`)
        else if (heartbeat) { clearInterval(heartbeat); heartbeat = undefined }
      }, this.heartbeatMs)
      heartbeat.unref?.()
    }
    try {
      return await job.await(opts)
    } finally {
      if (heartbeat) clearInterval(heartbeat)
    }
  }

  list(): JobSnapshot[] {
    return [...this.jobs.values()].map((j) => j.snapshot()).sort((a, b) => b.startedAt - a.startedAt)
  }

  logs(id: string): string | null {
    return this.jobs.get(id)?.logs() ?? null
  }

  kill(id: string): boolean {
    const job = this.jobs.get(id)
    if (!job) return false
    // 透传真实语义：终态 job 返回 false（kill() 不会发信号）。
    return job.kill()
  }

  /** Terminate every running job — call on session close to avoid orphans. */
  killAll(): void {
    for (const job of this.jobs.values()) job.kill()
  }

  async killAllAsync(): Promise<void> {
    await Promise.all([...this.jobs.values()].map(job => job.killAsync()))
  }

  /** 淘汰最旧的终态条目，把终态保有量压回上限（见 MAX_TERMINAL_JOBS）。 */
  private evictTerminals(): void {
    const terminals = [...this.jobs.values()]
      .filter(j => j.status !== 'running')
      .sort((a, b) => a.startedAt - b.startedAt)
    const excess = terminals.length - SessionJobs.MAX_TERMINAL_JOBS
    for (let i = 0; i < excess; i++) {
      const id = terminals[i]!.id
      this.jobs.delete(id)
      this.verificationMeta.delete(id)
    }
  }

  hasRunning(): boolean {
    for (const job of this.jobs.values()) {
      if (job.status === 'running') return true
    }
    return false
  }

  /** 推进内部任务边界号（无 provider 路径）。agent 装配经 setTaskEpochProvider
   *  读共享边界后，beginTask 不得再被调用（避免双递增源）。 */
  beginTask(): void { this.taskEpoch++ }

  /** P0：任务边界号提升为共享事实（WorkProgressFacts.taskEpoch）。注入后
   *  盖章与等待资格比对读同一边界；null = 退回内部计数器。 */
  setTaskEpochProvider(provider: (() => number) | null): void { this.taskEpochProvider = provider }
  private currentTaskEpoch(): number { return this.taskEpochProvider ? this.taskEpochProvider() : this.taskEpoch }

  /** 记录 spawn 时解析出的验证元数据（命令事实的唯一解析点）。
   *  job 已不存在时丢弃——否则会留下无人淘汰的孤儿 meta。 */
  recordVerificationMeta(id: string, meta: JobVerificationMeta, input: Record<string, unknown> = {}): void {
    const job = this.jobs.get(id)
    if (!job || this.verificationMeta.has(id)) return
    const startedAt = job.snapshot().startedAt
    const budget = verificationWaitBudget(input, startedAt)
    this.verificationMeta.set(id, { ...meta, ownerTaskEpoch: this.currentTaskEpoch(), waitUntil: startedAt + budget.ms, budgetSource: budget.source })
  }

  /** 「正在等门禁钦定证据」的后台 job：running 且带等待资格的元数据。
   *  判据取自 spawn 时存下的元数据（不再每条命令重新猜）；job 一进终态即
   *  不再命中，服务型长驻 job（persistent/unknown）从不命中。 */
  /** Internal observation projection: never part of list()/snapshot()/JobEvent. */
  verificationWaitInfo(): { jobId: string; purpose: string; lifetime: string; ownerTaskEpoch: number; waitUntil: number; budgetSource: string } | null {
    const waiting = this.waitingVerificationJob()
    const meta = waiting && this.verificationMeta.get(waiting.id)
    return waiting && meta ? { jobId: waiting.id, purpose: meta.purpose, lifetime: meta.lifetime, ownerTaskEpoch: meta.ownerTaskEpoch, waitUntil: meta.waitUntil, budgetSource: meta.budgetSource } : null
  }

  waitingVerificationJob(now = Date.now()): { id: string; meta: JobVerificationMeta } | null {
    for (const job of this.jobs.values()) {
      if (job.status !== 'running') continue
      const meta = this.verificationMeta.get(job.id)
      if (meta?.waitingEligible && meta.ownerTaskEpoch === this.currentTaskEpoch() && now < meta.waitUntil) return { id: job.id, meta }
    }
    return null
  }
}

function lastNonEmptyLine(text: string): string {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (line) return line.length > 200 ? line.slice(0, 200) : line
  }
  return ''
}

import type { ToolHistoryEntry } from '../prompt/volatile.js'
import type { CognitiveSeason } from './cognitive-season.js'
import type { FailureClass } from './failure-classifier.js'
import type { Sensorium, SensoriumInput, StrategyProfile } from './sensorium.js'
import type { VigorState } from './vigor.js'
import type { DecisionShift } from './loop-types.js'

export type RuntimeHookPhase = 'preTurn' | 'afterPerception' | 'postTool' | 'postTurn' | 'postSession'

export interface RuntimeToolEvent {
  name: string
  success: boolean
  target?: string
  /** Original structured ToolUse input. Hooks that need file semantics must
   *  prefer this over target because target is a display/history fallback. */
  input?: Record<string, unknown>
  isError?: boolean
  /** Failure classification from failure-classifier.ts — enables vigor to distinguish
   *  semantic failures (type_error, assertion) from environment issues (timeout, api_error). */
  failureClass?: FailureClass
  /** Tool result content string — enables hooks to inspect output for lossy markers
   *  and other content-level signals without duplicating tool-pipeline logic. */
  resultContent?: string
  /** Mode-level approximation: true when approvalMode requires interactive
   *  approval for writes (i.e. not dangerously-skip-permissions). This is NOT
   *  a per-call audit — allowlist auto-approves and "always allow" also count
   *  as true. Used by virtue detection (礼) as a v1 heuristic. */
  approvalRequired?: boolean
}

export interface RuntimeHookSnapshot {
  modelTurn?: number
  cwd: string
  turn: number
  recentToolHistory: Array<Pick<ToolHistoryEntry, 'tool' | 'status' | 'target' | 'argsHash' | 'errorClass' | 'bashActivity' | 'verificationAttempted' | 'modelTurn'>>
  sensorium: Sensorium | null
  sensoriumInput?: SensoriumInput
  providerDegradationRatio?: number
  strategy: StrategyProfile | null
  vigor: VigorState | null
  gitChangeRate: number
  season: CognitiveSeason | null
  /** Theta telemetry for elm-micro-release timeout suppression. */
  thetaTelemetry?: {
    lastTimedOut: boolean
    consecutiveTimeouts: number
  }
  /** Component C (typecheck-reminder): a .ts/.tsx file was written this session.
   *  Task-level, not windowed — survives a long turn where the edit scrolled out
   *  of recentToolHistory. */
  touchedTsFiles?: boolean
  /** Component C: a real typecheck has run since the last TS edit. */
  sawTypecheckThisTask?: boolean
  /** W5 (render-verify): a UI file (.tsx/.jsx/.vue/.svelte/.css/.html) was
   *  written this session. Task-level, like touchedTsFiles. */
  touchedUiFiles?: boolean
  /** W5 (render-verify): a visual verification tool (browser / computer_use /
   *  browser_debug) was used this session. */
  sawVisualVerify?: boolean
  /** Reasoning spiral guard: length of last turn's thinking content.
   *  Populated from AgentLoop.lastThinkingContent.length in buildRuntimeSnapshot. */
  lastThinkingLength?: number
  /** Reasoning spiral guard: whether last turn had any tool calls.
   *  Derived from recentToolHistory in buildRuntimeSnapshot. */
  lastTurnHadTools?: boolean
  /**
   * S2 CCR 可达性：队尾连续只读工具调用数，**独立累计计数**（不受
   * recentToolHistory 的 5 条容量限制）。
   *
   * 为什么不能从 recentToolHistory 反算：CCR 的 P6 阈值是 6（build）/
   * 10（diagnostic），而 5 条窗口能反算出的 streak 上限就是 5 —— 规则在生产
   * 容量下永不可达（缺陷本体）。判据与 classifyActivityMode 同源
   * （convergence-detector.isReadOnlyToolCall），由 recordToolHistory 维护。
   *
   * 消费方：cognitive-capsule-router 的 extractRouteState 取
   * `snapshot.readOnlyStreak ?? computeReadOnlyStreak(recentToolHistory)`
   * （字段缺席 = 老装配，回落旧行为；不得默认成"停滞"）。
   */
  readOnlyStreak?: number
}

export interface RuntimePhaseChangeDetail {
  tool?: string
  reason?: string
  suggestion?: string
}

export interface RuntimeHookEffects {
  setSensorium(sensorium: Sensorium): void
  setStrategy(strategy: StrategyProfile): void
  setVigor(vigor: VigorState): void
  setGitChangeRate(rate: number): void
  injectUserMessage(message: string): void
  requestThetaCheck(reason: string): void
  emitPhaseChange(phase: string, detail?: RuntimePhaseChangeDetail): void
  /** R4 — surface a structured course-correction to the desktop conversation. */
  emitDecisionShift(shift: DecisionShift): void
  markClaimStale(claimId: string): void
  /** 控制面事实上报（Wave 2）：hook 报告结构化事实，由控制面统一路由
   *  silent/status/appendix/decision-gate。默认 no-op；shadow 模式只记账不改
   *  prompt。任务数据（MCTS seed / scout packet）不得走此通道。
   *  Optional（兼容既有手工构造的 effects 字面量）；createRuntimeHookContext
   *  恒填充，hook 侧可直接调用。 */
  emitControlSignal?(signal: import('./control-plane.js').ControlSignal): void
}

export interface RuntimeHookContext {
  snapshot: RuntimeHookSnapshot
  effects: RuntimeHookEffects
  /** Lifetime of this invocation. Hooks must pass it to cancellable I/O. */
  signal?: AbortSignal
}

export interface PreTurnRuntimeHook {
  phase: 'preTurn'
  name: string
  /** 单 hook 预算覆盖（ms）。缺省用全局 hookTimeoutMs（默认 10s）。
   *  essence-gate 等内外层超时层级 hook 必须声明——外层预算要 > 内层 fail-closed。 */
  budgetMs?: number
  run(ctx: RuntimeHookContext): Promise<void> | void
}

export interface AfterPerceptionRuntimeHook {
  phase: 'afterPerception'
  name: string
  budgetMs?: number
  run(ctx: RuntimeHookContext): Promise<void> | void
}

export interface PostToolRuntimeHook {
  phase: 'postTool'
  name: string
  budgetMs?: number
  run(ctx: RuntimeHookContext, tool: RuntimeToolEvent): Promise<void> | void
}

export interface PostTurnRuntimeHook {
  phase: 'postTurn'
  name: string
  budgetMs?: number
  run(ctx: RuntimeHookContext): Promise<void> | void
}

export interface PostSessionRuntimeHook {
  phase: 'postSession'
  name: string
  budgetMs?: number
  run(ctx: RuntimeHookContext): Promise<void> | void
}

export type RuntimeHook =
  | PreTurnRuntimeHook
  | AfterPerceptionRuntimeHook
  | PostToolRuntimeHook
  | PostTurnRuntimeHook
  | PostSessionRuntimeHook

export interface RuntimeHookError {
  phase: RuntimeHookPhase
  hookName: string
  message: string
  error: unknown
}

export type RuntimeHookRunOutcome = 'completed' | 'failed' | 'timed_out' | 'skipped'

export interface RuntimeHookManifestEntry {
  id: string
  phase: RuntimeHookPhase
  enabled: boolean
}

export interface RuntimeHookRunEvent {
  id: string
  phase: RuntimeHookPhase
  outcome: RuntimeHookRunOutcome
  durationMs: number
  /** 本次执行生效的预算（单 hook budgetMs 或全局 hookTimeoutMs）——遥测可归因。 */
  budgetMs?: number
  slow: boolean
  message?: string
}

export interface RuntimeHookStats {
  id: string
  phase: RuntimeHookPhase
  runs: number
  skipped: number
  failures: number
  timeouts: number
  slowRuns: number
  totalDurationMs: number
  maxDurationMs: number
}

export interface RuntimeHookPipelineOptions {
  onError?: (error: RuntimeHookError) => void
  /** Receives one event per registered hook invocation, including skipped hooks. */
  onRun?: (event: RuntimeHookRunEvent) => void
  /** Hook ids to retain in the manifest but exclude from execution. */
  disabledHookIds?: Iterable<string>
  /** Per-hook wall-clock budget. Set to 0 to disable timeout handling. */
  hookTimeoutMs?: number
  /** Report completed hooks at or above this duration as slow. */
  hookSlowMs?: number
}

const DEFAULT_HOOK_TIMEOUT_MS = 10_000
const DEFAULT_HOOK_SLOW_MS = 2_000

function noop(): void {}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createRuntimeHookContext(
  snapshot: RuntimeHookSnapshot,
  effects: Partial<RuntimeHookEffects> = {},
): RuntimeHookContext {
  return {
    snapshot,
    effects: {
      setSensorium: sensorium => {
        snapshot.sensorium = sensorium
        effects.setSensorium?.(sensorium)
      },
      setStrategy: strategy => {
        snapshot.strategy = strategy
        effects.setStrategy?.(strategy)
      },
      setVigor: vigor => {
        snapshot.vigor = vigor
        effects.setVigor?.(vigor)
      },
      setGitChangeRate: rate => {
        snapshot.gitChangeRate = rate
        effects.setGitChangeRate?.(rate)
      },
      injectUserMessage: effects.injectUserMessage ?? noop,
      requestThetaCheck: effects.requestThetaCheck ?? noop,
      emitPhaseChange: effects.emitPhaseChange ?? noop,
      emitDecisionShift: effects.emitDecisionShift ?? noop,
      markClaimStale: effects.markClaimStale ?? noop,
      emitControlSignal: effects.emitControlSignal ?? noop,
    },
  }
}

export class RuntimeHookPipeline {
  private preTurnHooks: PreTurnRuntimeHook[] = []
  private afterPerceptionHooks: AfterPerceptionRuntimeHook[] = []
  private postToolHooks: PostToolRuntimeHook[] = []
  private postTurnHooks: PostTurnRuntimeHook[] = []
  private postSessionHooks: PostSessionRuntimeHook[] = []
  private registeredHooks: RuntimeHook[] = []
  private stats = new Map<string, RuntimeHookStats>()
  private disabledHookIds: ReadonlySet<string>

  constructor(
    hooks: RuntimeHook[] = [],
    private options: RuntimeHookPipelineOptions = {},
  ) {
    this.disabledHookIds = new Set(options.disabledHookIds ?? [])
    for (const hook of hooks) this.register(hook)
  }

  register(hook: RuntimeHook): void {
    this.registeredHooks.push(hook)
    switch (hook.phase) {
      case 'preTurn':
        this.preTurnHooks.push(hook)
        break
      case 'afterPerception':
        this.afterPerceptionHooks.push(hook)
        break
      case 'postTool':
        this.postToolHooks.push(hook)
        break
      case 'postTurn':
        this.postTurnHooks.push(hook)
        break
      case 'postSession':
        this.postSessionHooks.push(hook)
        break
    }
  }

  /** 运行时替换禁用集（config HMR 热更入口）。runPhase 每次检查
   *  disabledHookIds.has，set 后下一轮立即生效；getManifest 自动反映新状态。
   *  只影响运行时行为（跳过/执行），不改变注册集——装配仍由
   *  createDefaultRuntimeHooks 编译期决定。 */
  setDisabledHookIds(ids: Iterable<string>): void {
    this.disabledHookIds = new Set(ids)
  }

  /** 查询单个 hook 当前是否启用（热更后与 getManifest 同源）。 */
  isEnabled(name: string): boolean {
    return !this.disabledHookIds.has(name)
  }

  getManifest(): RuntimeHookManifestEntry[] {
    return this.registeredHooks.map(hook => ({
      id: hook.name,
      phase: hook.phase,
      enabled: !this.disabledHookIds.has(hook.name),
    }))
  }

  getStats(): RuntimeHookStats[] {
    return [...this.stats.values()].map(stat => ({ ...stat }))
  }

  async runPreTurn(ctx: RuntimeHookContext): Promise<void> {
    await this.runPhase('preTurn', this.preTurnHooks, ctx, (hook, scoped) => hook.run(scoped))
  }

  async runAfterPerception(ctx: RuntimeHookContext): Promise<void> {
    await this.runPhase('afterPerception', this.afterPerceptionHooks, ctx, (hook, scoped) => hook.run(scoped))
  }

  async runPostTool(ctx: RuntimeHookContext, tool: RuntimeToolEvent): Promise<void> {
    await this.runPhase('postTool', this.postToolHooks, ctx, (hook, scoped) => hook.run(scoped, tool))
  }

  async runPostTurn(ctx: RuntimeHookContext): Promise<void> {
    await this.runPhase('postTurn', this.postTurnHooks, ctx, (hook, scoped) => hook.run(scoped))
  }

  async runPostSession(ctx: RuntimeHookContext): Promise<void> {
    await this.runPhase('postSession', this.postSessionHooks, ctx, (hook, scoped) => hook.run(scoped))
  }

  private async runPhase<T extends RuntimeHook>(
    phase: RuntimeHookPhase,
    hooks: T[],
    ctx: RuntimeHookContext,
    invoke: (hook: T, scoped: RuntimeHookContext) => Promise<void> | void,
  ): Promise<void> {
    for (const hook of hooks) {
      if (this.disabledHookIds.has(hook.name)) {
        this.publishRun({
          id: hook.name,
          phase,
          outcome: 'skipped',
          durationMs: 0,
          slow: false,
          message: 'disabled',
        })
        continue
      }

      const startedAt = Date.now()
      const timeoutMs = hook.budgetMs ?? this.options.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
      const slowMs = this.options.hookSlowMs ?? DEFAULT_HOOK_SLOW_MS
      let timeout: ReturnType<typeof setTimeout> | undefined
      let timedOut = false
      let outcome: RuntimeHookRunOutcome = 'completed'
      let message: string | undefined
      let pending: Promise<void> | undefined
      const controller = new AbortController()
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal
      let active = true
      // Guard the shared effect channel, including functions captured before the
      // deadline. The next hook gets a fresh scope and can still update state.
      const scoped: RuntimeHookContext = {
        ...ctx,
        signal,
        effects: new Proxy(ctx.effects, {
          get(target, key, receiver) {
            const effect = Reflect.get(target, key, receiver)
            return typeof effect === 'function' ? (...args: unknown[]) => {
              if (active && !signal.aborted) return Reflect.apply(effect, target, args)
            } : effect
          },
        }),
      }

      try {
        pending = Promise.resolve().then(() => {
          signal.throwIfAborted()
          return invoke(hook, scoped)
        })
        if (timeoutMs > 0) {
          await Promise.race([
            pending,
            new Promise<never>((_, reject) => {
              timeout = setTimeout(() => {
                timedOut = true
                active = false
                const error = new Error(`Runtime hook '${hook.name}' timed out after ${timeoutMs}ms`)
                controller.abort(error)
                reject(error)
              }, timeoutMs)
            }),
          ])
        } else {
          await pending
        }
      } catch (error) {
        outcome = timedOut ? 'timed_out' : 'failed'
        message = toMessage(error)
        this.options.onError?.({
          phase,
          hookName: hook.name,
          message,
          error,
        })
      } finally {
        active = false
        controller.abort()
        if (timeout) clearTimeout(timeout)
        const durationMs = Date.now() - startedAt
        this.publishRun({
          id: hook.name,
          phase,
          outcome,
          durationMs,
          budgetMs: timeoutMs,
          slow: outcome === 'completed' && durationMs >= slowMs,
          message,
        })
      }

      if (timedOut && pending) {
        // Observe non-cooperative late failures without counting the run twice.
        // Cancellation with our deadline reason was already reported above.
        pending.catch(lateError => {
          if (lateError === signal.reason) return
          this.options.onError?.({
            phase,
            hookName: hook.name,
            message: `late failure after timeout: ${toMessage(lateError)}`,
            error: lateError,
          })
        })
      }
    }
  }

  private publishRun(event: RuntimeHookRunEvent): void {
    const key = `${event.phase}:${event.id}`
    const stat = this.stats.get(key) ?? {
      id: event.id,
      phase: event.phase,
      runs: 0,
      skipped: 0,
      failures: 0,
      timeouts: 0,
      slowRuns: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
    }

    if (event.outcome === 'skipped') {
      stat.skipped += 1
    } else {
      stat.runs += 1
      stat.totalDurationMs += event.durationMs
      stat.maxDurationMs = Math.max(stat.maxDurationMs, event.durationMs)
      if (event.outcome === 'failed') stat.failures += 1
      if (event.outcome === 'timed_out') stat.timeouts += 1
      if (event.slow) stat.slowRuns += 1
    }

    this.stats.set(key, stat)
    try {
      this.options.onRun?.(event)
    } catch {
      // Instrumentation must never interrupt agent execution.
    }
  }
}

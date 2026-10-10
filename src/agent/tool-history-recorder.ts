import { verificationToolFacts } from './verification-activity.js'
import type { AgentLoop } from './loop.js'
import type { HealthSignal } from './trajectory-health.js'
import type { ToolErrorClass } from '../tools/types.js'
import type { FailureClass } from './failure-classifier.js'
import { createHash } from 'node:crypto'
import { TYPECHECK_CMD_RE } from './typecheck-gate.js'
import { classifyBashCommandActivity, toolTargetFromInput } from './tool-target.js'
import { isUiFilePath, isVisualVerifyTool } from './hooks/render-verify-hook.js'
import { POINTER_GUARD_ERROR_MARKER } from '../tools/pointer-guard.js'
import { WRITE_TOOL_NAMES } from '../tools/write-tool-helpers.js'
import { isReadOnlyToolCall } from './convergence-detector.js'

/**
 * 共享工具历史容量。S1 的窗口输出观测器（OutputWindowTracker）必须用同一容量
 * 构造——两者按位对齐才能做同窗口做差；改这个数字要同时看 loop.ts 的观测器装配。
 */
export const RECENT_TOOL_HISTORY_CAP = 5

/**
 * 预期失败的双豁免判据（抽成纯函数以便测试，也避免 recordToolHistory 里
 * 两处条件各自漂移）：
 * - 免疫豁免：环境缺失 / 设计性拒绝不该被放大成"agent 生病了"；
 * - 收敛豁免：syntax_error（格式瞬错，下轮可修）与 refused（确定性拒绝，
 *   换目标即可）不该计入 errorPenalty。
 */
export function isImmunityNeutralized(errorClass?: ToolErrorClass, errorKind?: FailureClass): boolean {
  return errorClass === 'environment' || errorKind === 'refused'
}

export function isConvergenceTransient(errorKind?: FailureClass, result?: string): boolean {
  return (result?.includes(POINTER_GUARD_ERROR_MARKER) ?? false) || errorKind === 'syntax_error' || errorKind === 'refused'
}

/**
 * P1：把文件进展三态结果回填到最近一条未标注的写工具历史条目——收敛的
 * editRatio 依据"执行效果"（真实变化）而非"工具名 + 成功"计编辑。
 * 从末尾向前找第一条写工具条目；已被标注则不再回溯（并行批下每次回调
 * 对应其自己的执行，最新的未标注条目即本次）。
 */
export function tagLatestWriteOutcome(
  self: AgentLoop,
  outcome: 'changed' | 'unchanged' | 'unknown',
): void {
  for (let i = self.recentToolHistory.length - 1; i >= 0; i--) {
    const entry = self.recentToolHistory[i]!
    if (!WRITE_TOOL_NAMES.has(entry.tool)) continue
    if (entry.writeOutcome !== undefined) return
    entry.writeOutcome = outcome
    return
  }
}

/**
 * Record tool execution history and trigger deferred post-tool processing.
 * Extracted from AgentLoop.recordToolHistory.
 */
export function recordToolHistory(
  self: AgentLoop,
  name: string,
  input: Record<string, unknown>,
  isError: boolean,
  result: string,
  errorClass?: ToolErrorClass,
  errorKind?: FailureClass,
): void {
    // Environment-class failures (host lacks the command — common on Windows) are
    // not competence failures. The immune system must not amplify them into
    // quarantine/doom, otherwise benign command-name differences make the agent
    // recoil. Visible status stays honest; only the immune amplifier is neutralised.
    // refused（设计性拒绝：fail-closed 允许名单/协议白名单）同理——工具按设计
    // 拒绝执行，不该被免疫系统当成"agent 生病了"放大。
    const immuneError = isImmunityNeutralized(errorClass, errorKind) ? false : isError
    const target = toolTargetFromInput(name, input ?? {})
    const bashActivity = name === 'bash' && typeof input.command === 'string'
      ? classifyBashCommandActivity(input.command)
      : undefined
    // Deterministic argsHash: tool name + sorted input keys → SHA-256 first 8 hex chars.
    const argsHash = createHash('sha256')
      .update(`${name}:${JSON.stringify(input, Object.keys(input).sort())}`)
      .digest('hex')
      .slice(0, 8)
    // Transient guard failures (pointer-guard, syntax-check false-positive, etc.)
    // are format-level mistakes the model fixes next turn — not competence failures.
    // Tag them so the convergence detector excludes them from errorPenalty.
    // syntax_error 走结构化 errorKind 管道（edit/apply-patch/hash-edit/write-file
    // 的结果对象自带）——不再按「已自动回滚」子串匹配：agent 在本仓库跑失败的
    // 测试套件时，断言文本里的同一子串会把真实失败误标为 transient。
    // refused 同列：拒绝是确定性结论，模型换目标即可，不是收敛意义上反复失败。
    const isTransientGuard = isError && isConvergenceTransient(errorKind, result)
    self.recentToolHistory.push({
      tool: name,
      ...verificationToolFacts(name, input, self.cwd),
      modelTurn: self.modelObservationTurn,
      target,
      status: isError ? 'failed' : 'success',
      ...(bashActivity ? { bashActivity } : {}),
      // Turn the call belongs to: addUserMessage() bumps turnCount, so calls
      // between two user messages share the same turn number. Consumers can
      // then ask "did the previous turn issue any tool call" instead of
      // scanning a sliding window (reasoning-spiral-hook wiring).
      turn: self.session.getTurnCount(),
      argsHash,
      error: isError ? result.slice(0, 50) : undefined,
      ...(isError && errorClass ? { errorClass } : {}),
      ...(isTransientGuard ? { transient: true } : {}),
    })
    if (self.recentToolHistory.length > RECENT_TOOL_HISTORY_CAP) self.recentToolHistory.shift()

    // ── S1 效率时间尺度 + S2 CCR 可达性：两个**独立于共享窗口**的信号 ──
    // 都在这个唯一记录点维护，与 recentToolHistory 同触发时序：
    // - outputWindow：窗口内的主轮输出增量（分母 = 窗口条数，同时间尺度）；
    // - readOnlyStreak：连续只读累计计数——**刻意不受 RECENT_TOOL_HISTORY_CAP
    //   限制**。CCR 的 P6 阈值是 6（build）/10（diagnostic），从 5 条窗口反算
    //   的 streak 上限为 5，规则在生产容量下永不可达（S2 缺陷本体）。
    //   判据复用 convergence-detector 的 isReadOnlyToolCall（单一事实源，
    //   与 classifyActivityMode 同源），不在此处再写一份分类。
    self.outputWindow.record(self.session.getMainPathOutputTokens())
    self.readOnlyStreak = isReadOnlyToolCall(name, bashActivity) ? self.readOnlyStreak + 1 : 0

    // P3-E/H: invalidate plan cache + JIT on file mutations (sync — needed before next API call)
    if (!isError && (name === 'edit_file' || name === 'write_file')) {
      self.p3.invalidatePlanCache(target)
      self.p3.invalidateJIT(target)
    }

    // Component C (typecheck-reminder) signals — robust task-level flags, NOT the
    // 5-entry window. A TS write marks edits as unverified-by-typecheck; a real
    // typecheck bash clears it. esbuild/tsx (run_tests) does NOT type-check.
    if (!isError) {
      if ((name === 'edit_file' || name === 'write_file' || name === 'hash_edit' || name === 'apply_patch')
        && /\.(ts|tsx)$/.test(target)) {
        self.touchedTsFiles = true
        self.sawTypecheckThisTask = false
      } else if (name === 'bash' && typeof input?.command === 'string' && TYPECHECK_CMD_RE.test(input.command)) {
        self.sawTypecheckThisTask = true
      }
    }

    // W5 (render-verify): track UI file edits and visual verification tool usage.
    if (!isError) {
      if ((name === 'edit_file' || name === 'write_file' || name === 'hash_edit' || name === 'apply_patch')
        && isUiFilePath(target)) {
        self.touchedUiFiles = true
      } else if (isVisualVerifyTool(name)) {
        self.sawVisualVerify = true
      }
    }

    // T2-02 P2: Record successful tool sequences to PlanCache on task delivery.
    // Key = the task's user input — the SAME distribution the lookup side uses
    // (turn-step-producer feeds userInput into planCacheSuggest). The old key
    // was the tool-chain string ("edit_file:src/a.ts → …"), whose keywords
    // almost never overlap a natural-language task description, so cache hit
    // rate was structurally near zero. Tool-chain string kept only as fallback
    // when no user message exists (e.g. programmatic runs).
    if (!isError && name === 'deliver_task') {
      try {
        const steps = self.p3.extractPlanSteps(self.recentToolHistory)
        if (steps.length >= 2) {
          const taskDesc = self.initialUserMessage?.trim()
            || self.recentToolHistory.map(e => `${e.tool}:${e.target}`).join(' → ')
          self.p3.recordPlan(taskDesc, steps)
        }
      } catch { /* PlanCache recording is non-critical */ }
    }

    // P3-D Atropos: assess trajectory health → auto-escalate Flash→Pro on repeated failures (sync)
    let trajectoryHealth: HealthSignal = 'healthy'
    if (self.config.onModelSwitch && self.config.getCurrentModel) {
      const currentModelId = self.config.getCurrentModel()
      const tier: 'flash' | 'pro' = currentModelId.includes('pro') ? 'pro' : 'flash'
      if (tier === 'flash') {
        const recentEvents = self.traceStore.events.slice(-10).map(e => ({
          status: (e.status === 'passed' ? 'passed' : 'failed') as 'passed' | 'failed',
          turn: e.turn,
        }))
        trajectoryHealth = self.p3.assessHealth(recentEvents, self.session.getTurnCount(), tier)
        if (trajectoryHealth === 'escalate') {
          const proModel = currentModelId.replace('flash', 'pro')
          try { self.config.onModelSwitch(proModel) } catch { /* non-fatal */ }
        }
      }
    }

    // ── Deferred post-tool processing ──
    // Immune/Physarum analysis and P3 pattern mining are deferred to
    // setImmediate so they never block tool result delivery.
    const fp = self.traceStore.toolFingerprints[self.traceStore.toolFingerprints.length - 1] ?? name
    const capturedTurn = self.session.getTurnCount()
    const capturedDoom = self.getDoomLoopLevel()
    const capturedTokens = self.session.getEstimatedTokens()
    setImmediate(() => {
      // P3 pattern mining (deferred)
      try { self.p3.onToolComplete(name, target, isError, isError ? result.slice(0, 200) : undefined) } catch { /* non-critical */ }

      // Physarum + Immune (deferred)
      try {
        const immuneResult = self.immuneHook.run({
          toolName: name,
          fingerprint: fp,
          turn: capturedTurn,
          doomLevel: capturedDoom,
          targetFile: target,
          tokenUsage: capturedTokens,
          trajectoryHealth,
          isError: immuneError,
        })
        if (immuneResult.contextHint) {
          self._lastImmuneHint = immuneResult.contextHint
        }
      } catch { /* immune failure is non-critical */ }
    })

    // Record timestamp for event-loop gap detection
    self.lastToolCompleteTime = Date.now()

    // ── Sensorimotor learning: deferred (SHA-256 + DB INSERT is non-critical) ──
    setImmediate(() => {
      try {
        const db = self.config.meridianIndexer?.getDb()
        if (db) {
          const sensorium = self.sensorium
          const contextSig = createHash('sha256')
            .update(JSON.stringify({
              confidence: sensorium?.confidence ?? 0.5,
              complexity: sensorium?.complexity ?? 0.5,
              season: self.currentSeason ?? 'genesis',
              vigor: self.vigorState?.vigor ?? 0.5,
            }))
            .digest('hex').slice(0, 16)
          db.recordSensorimotorExperience(
            contextSig,
            name,
            !isError,
            0, // duration not tracked at this level
            self.session.getTurnCount(),
          )
        }
      } catch { /* sensorimotor recording is non-critical */ }
    })
}

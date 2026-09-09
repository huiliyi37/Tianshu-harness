import type { AgentLoop } from './loop.js'
import type { AgentCallbacks } from './loop-types.js'
import type { OaiChatRequest } from '../api/oai-types.js'
import type { Sensorium, StrategyProfile } from './sensorium.js'
import { TurnHeartbeat } from './turn-heartbeat.js'
import { wrapCallbacksWithHeartbeat } from './turn-orchestrator.js'
import { debugLog } from '../utils/debug.js'
import { recordAppendixTrace } from './appendix-trace.js'
import { createTraceStore } from './trace-store.js'
import { createPredictionAccumulator, computeEFE } from './prediction-error.js'
import { RepairHintTracker } from './repair-hint.js'
import { createThetaState, getThetaPhase } from './star-event.js'
import { mapQueriedPheromones } from './pheromone-map.js'
import { getGitInjectedContext } from '../prompt/volatile-git.js'
import { detectWorktreeReality, type InjectedWorktreeContext } from './worktree-reality.js'
import { advanceContractStatus, classifyPlanMethodology, classifyTaskDepth, classifyTurnMode, contractStatusFromPhaseClass, extractTaskContract, mergeFollowUpIntoContract, type TurnMode } from '../context/task-contract.js'
import { shouldSuggestPlanMode, buildPlanModeSuggestAdvisory, buildPlanModeAutoEnterAdvisory, buildStructureFlowPlanAdvisory, planModeSuggestMode } from './plan-mode-advisor.js'
import { skillRegistry } from '../skills/skill-loader.js'
import { detectQuizLike } from './intent-retrieval-route.js'
import { renderMemoryBlock } from '../memory/unified-memory.js'
import { reviewAdaptiveMemory } from '../memory/adaptive-stm.js'
import { combineMemoryBlocks, crossSessionDisabled, crossSessionMemoryPushEnabled } from './cross-session-memory-config.js'
export { combineMemoryBlocks, crossSessionDisabled, crossSessionMemoryPushEnabled } from './cross-session-memory-config.js'
import { parseMentions, renderMentionContext, normalizeMentionRefs } from '../tui/mention-parser.js'
import { renderPlanCacheAdvisory } from './plan-cache-advisory.js'
import { selectReasoningEffort } from './auto-reasoning.js'
import { SessionPersist } from './session-persist.js'
import { formatEventsForAppendix, invalidateReadCachesForEvents, renderCrossSessionClaims } from './hooks/cross-session-hook.js'
import { loadPresence, formatPresenceForAppendix } from './companion-presence.js'
import { createWriteEvidenceProbe } from '../context/write-evidence-probe.js'
// staleness/vigor-low advisory entries migrated to CCR hook (cognitive-capsule-router.ts)
import { classifySeason } from './cognitive-season.js'
import { isInProductionFlow } from './production-flow.js'
import { renderToolContext, type AffordanceState, adaptAffordanceFromHistory, computeAffordanceScores } from './affordance.js'
import { selectPolicy } from './policy-selection.js'
import { checkTddGate, buildTddGateHint } from './tdd-gate.js'
import { deriveDisciplineEligibility, detectExplicitNoMutation, detectProblemSignal } from './discipline-eligibility.js'
import { EXPLORATION_SIGNAL_RE } from './collab-branches.js'
import { selectCollabAdvisories } from './collab-branch-advisories.js'
import { buildCognitiveProjectionParts, createCognitiveLedger, getCognitivePhaseSnapshot } from '../context/cognitive-ledger.js'
import { formatImmuneContext } from './immune-context.js'
import { VITALS_LITE_KIND } from './telemetry-writer.js'
import { getCapsuleByStar } from './seed-capsule-store.js'
import { signalFromLedgerDelta, signalsFromDelivered, signalsFromObligations } from './control-plane-adapters.js'
import { renderControlPlaneAppendix } from './control-plane.js'
import { palMode } from './hooks/problem-attack-hook.js'
import { collectCaseOpenSignals } from './case-open-signals.js'
import { getWaveGate } from './wave-gate.js'

/**
 * Resolve the turn-level hard-stall watchdog ceiling (ms) from provider +
 * reasoning config. Reverse-cause fix for reasoning models being falsely熔断:
 *
 * - GLM independent-reasoning → 0 (disabled): stream-level timeouts (read 720s /
 *   hard-cap 20min) are authoritative; a per-turn hardStall abort mid-reasoning
 *   causes "restart from scratch".
 * - Deep-reasoning sessions (effort high/max) → raised ceiling: legitimate deep
 *   thinking spans minutes; keep the watchdog as a safety net for genuine
 *   boundary wedges but give reasoning-heavy turns slack so a busy-but-healthy
 *   boundary isn't mistaken for a wedge.
 * - Everything else → tight default (240s).
 *
 * Note: the watchdog is already disarmed during streaming (so in-stream
 * reasoning never trips it); this ceiling only guards the non-streaming
 * turn-boundary blind spot.
 */
export function resolveHardStallMs(config: { providerName?: string; reasoningEffort?: string }): number {
  if (config.providerName === 'glm') return 0
  const effort = config.reasoningEffort
  const deepReasoning = effort === 'high' || effort === 'max'
  return deepReasoning ? 480_000 : 240_000
}

/**
 * B4（将星点亮·贪狼触发面）：勘探/盘点类任务关键词。
 * 贪狼是任务型触发（objective 语义），不是状态型触发（CCR 的 P 规则管状态）——
 * 勘探停滞已有 P6 覆盖，这里只在任务意图分类处点一盏 informational 灯。
 * W3 起正则由 collab-branches 单一持有（E 分支与触发器共用同一实现）。
 */

/**
 * 勘探型任务 → 指向 recall_capsule("贪狼") 的 informational advisory 文案。
 * 命中关键词才返回；informational tier 填空位，不占 operational Top-N。
 */
export function buildTanlangExplorationAdvisory(userInput: string, gist?: string): string | null {
  if (!EXPLORATION_SIGNAL_RE.test(userInput)) return null
  return `【贪狼·胶囊】检测到勘探/盘点型任务。${gist ?? '能力勘探/系统联合方法论已封存'}——动手前调用 recall_capsule("贪狼") 取完整方法（能力非成本框架、陈旧度判据、半接诊断到行号）。`
}


/**
 * 判断 scope 文件列表是否全部为文档/配置/非代码文件。
 * bugfix 义务的 RED 复现不适用于此类变更——纯注释、文档、配置修改无需复现测试。
 */
export function isDocOrConfigOnly(targets: string[]): boolean {
  return targets.length > 0 && targets.every(t =>
    /\.(md|json|ya?ml|toml|css|html)$/.test(t) ||
    t.startsWith('docs/') ||
    t.startsWith('.rivet/'))
}

/** Map StarPhase values to PromptEngine phaseClass strings. */
export const PHASE_CLASS_MAP: Record<string, string> = {
  'tianshu-planning': 'plan',
  'tianxuan-locating': 'explore',
  'tianji-decomposing': 'plan',
  'tianquan-contracting': 'plan',
  'yuheng-implementing': 'execute',
  'kaiyang-testing': 'verify',
  'yaoguang-delivering': 'deliver',
  'tianshu-encore': 'plan',
}

/**
 * Turn-step producer (loop.ts terminal-wave extraction): the prompt-assembly
 * production path lifted verbatim from AgentLoop — per-run initialization,
 * per-turn perception + cognitive prep, and the OAI request build.
 *
 * Self-passing controller (import type only — no runtime cycle): every field
 * access stays `this.self.X` so the dense prefix-cache setter call sites move
 * byte-for-byte. The setter ordering relative to `buildOaiRequest` and the
 * user-message boundary is a hard constraint (DeepSeek exact-prefix cache):
 * do NOT reorder the setter / refreshGitContextIfNeeded / buildOaiRequest calls.
 */
export class TurnStepProducer {
  constructor(private readonly self: AgentLoop) {}

  /** 本轮 TurnMode（initializeRun 写入，runPerception 消费） */
  private lastTurnMode: TurnMode = 'chat'

  /**
   * Step 6a: Per-run initialization — warmup, heartbeat, state resets,
   * worktree detection, session split, user message, task contract.
   *
   * Returns the heartbeat (for cleanup) and the wrapped callbacks (which
   * the caller must use for the rest of the run).
   */
  async initializeRun(userInput: string, callbacks: AgentCallbacks, images?: string[]): Promise<{ heartbeat: TurnHeartbeat, wrappedCallbacks: AgentCallbacks, turnMode: TurnMode }> {
    await this.self.warmupMemories()
    // The controller is created eagerly in run() before any await, so an abort
    // fired during warmup is honored (not discarded). Only create one here if a
    // caller invoked the loop outside run().
    this.self.abortController ??= new AbortController()
    if (this.self._pendingAbort) {
      // Interrupt arrived during the warmup window — keep the count and ensure
      // the (already-aborted) controller stays aborted so the turn loop bails.
      this.self.abortController.abort()
    } else {
      this.self._turnInterruptCount = 0
    }
    await this.self.startFsWatcher()
    // P7: heartbeat watchdog — surfaces "still working" signal during long
    // silent operations so the UI doesn't appear frozen and users don't
    // interrupt the agent mid-task. ALSO acts as a watchdog with teeth: if
    // silence exceeds hardStallMs (turn-boundary blind spot — postTurn hooks /
    // compaction / prewarm hang with no abort cooperation), it aborts the turn
    // so the loop's rejectOnAbort races break out instead of freezing forever.
    const heartbeat = new TurnHeartbeat({
      silentMs: 20_000,
      repeatMs: 15_000,
      // Hard-stall ceiling is reasoning-aware (see resolveHardStallMs). GLM's
      // independent deep reasoning disables it entirely (stream-level timeouts are
      // authoritative; a per-turn abort causes "restart from scratch"). Other
      // deep-reasoning sessions (high/max effort) get a raised ceiling so a model
      // that legitimately spans minutes at a boundary isn't falsely熔断, while the
      // watchdog is kept as a safety net for genuine boundary wedges. Non-reasoning
      // sessions keep the tight default.
      hardStallMs: resolveHardStallMs(this.self.config),
      onHeartbeat: (elapsed, lastActivity) => {
        const seconds = Math.round(elapsed / 1000)
        callbacks.onPhaseChange?.('heartbeat', {
          reason: `still working — last activity: ${lastActivity} (${seconds}s ago)`,
        })
      },
      onHardStall: (elapsed, lastActivity) => {
        const seconds = Math.round(elapsed / 1000)
        debugLog(`[watchdog] hard stall after ${seconds}s (last activity: ${lastActivity}) — aborting wedged turn`)
        callbacks.onPhaseChange?.('heartbeat', {
          reason: `recovering — turn stalled ${seconds}s at "${lastActivity}", aborting`,
        })
        this.self.abortStalledTurn()
      },
    })
    callbacks = wrapCallbacksWithHeartbeat(callbacks, heartbeat, () => this.self.config.sessionId)
    heartbeat.start()
    this.self._turnHeartbeat = heartbeat
    this.self.turnStream = this.self.createTurnStreamController()
    this.self.turnCompletion = this.self.createTurnCompletionController(callbacks)
    this.self.trajectory.reset()
    this.self.decisions = []
    this.self.traceStore = createTraceStore()
    this.self.predictionAccumulator = createPredictionAccumulator()
    this.self.initialUserMessage = userInput
    this.self.runLoopTurn = 0
    this.self.lastUserInputRunTurn = 0
    // Reset accumulations from previous run
    this.self.thinkingOnlyRetries = 0
    this.self.lastThinkingContent = ''
    this.self.consecutiveNoToolTurns = 0
    this.self.wedgeToolFingerprint = ''
    this.self.wedgeRepeatCount = 0
    this.self.lastTurnTextFingerprint = ''
    this.self.evidence.reset()
    this.self.repairHintTracker = new RepairHintTracker()
    this.self.contextInjection.reset()
    this.self.recentTextFingerprints = []
    this.self.sensorium = null
    this.self.strategy = null
    this.self.latestResourceSnapshot = null
    this.self.latestReliabilityDecision = null
    this.self.thetaState = createThetaState(7)
    this.self.loadedPheromones = []
    this.self.intent.reset()
    this.self.perception.reset()
    this.self.sensoriumSnapshots = this.self.perception.getSnapshots()
    this.self.latestCognitiveSnapshot = undefined
    // Capture baseline canonical prefix fingerprint for drift detection
    this.self.baselineFingerprint = this.self.config.promptEngine.getFingerprint()
    // Load cross-session pheromones for Sensorium.freshness computation.
    // Use query() so Sensorium sees decayed currentStrength, and prune stale entries opportunistically.
    this.self.stigmergyStore.prune().catch(() => {})
    this.self.stigmergyStore.query().then(p => { this.self.loadedPheromones = mapQueriedPheromones(p) }).catch(() => {})

    // Detect worktree reality: compare injected git context with actual worktree state
    try {
      const ctx = await getGitInjectedContext(this.self.cwd)
      const injected: InjectedWorktreeContext | undefined = ctx
        ? { branch: ctx.branch, head: ctx.head }
        : undefined
      const reality = await detectWorktreeReality(this.self.cwd, injected)
      this.self.config.promptEngine.setWorktreeReality(reality)
    } catch {
      // Detection failure must not crash AgentLoop — clear stale warning
      this.self.config.promptEngine.setWorktreeReality(null)
    }

    this.self.bindSessionDomain(userInput, callbacks)
    if (
      this.self.domainWasAutoResolved &&
      this.self.getSessionTurnCount() > 0 &&
      this.self.driftDetector
    ) {
      const drift = this.self.driftDetector.evaluate(userInput)
      if (drift) callbacks.onDomainDrift?.(drift)
    }
    this.self.contextInjection.recordUserInputClaims(userInput)
    this.self.contextInjection.refreshPlaybookLessons(userInput)

    // Phase 2.3: Proactive session split — MUST run BEFORE addUserMessage.
    await this.self.compactBoundaryCoordinator.preUserMessageSplit()

    // History invariant probe: a new run must start with the previous turn
    // answered. A trailing user message (or a thinking-only assistant with
    // empty content and no tool_calls) means the previous reply was never
    // persisted — the exact precondition for the "re-answers the previous
    // turn" bug. Log loudly so recurrences are diagnosable from debug logs.
    {
      const tailMsgs = this.self.session.getMessages()
      const tail = tailMsgs[tailMsgs.length - 1]
      if (tail && (
        tail.role === 'user' ||
        (tail.role === 'assistant' && !tail.content && !tail.tool_calls)
      )) {
        debugLog(`[history-invariant] run starts with unanswered tail: role=${tail.role} msgCount=${tailMsgs.length} — previous assistant reply was not persisted; model may re-answer the previous turn`)
      }
    }

    this.self.session.addUserMessage(userInput, images)
    const turnMode = classifyTurnMode(userInput, this.self.taskContract)
    this.lastTurnMode = turnMode
    const actionable = turnMode !== 'chat'
    this.self.config.promptEngine.setActionableTurn(actionable)

    if (turnMode === 'task') {
      this.self.taskContract = extractTaskContract(userInput, this.self.session.getTurnCount())
      // 证据义务任务边界：上一个用户任务的未决义务全部作废（satisfied 历史
      // 保留），latch 清空——新任务从干净的义务面开始。
      this.self.obligations.supersedeOpen()
    } else if (turnMode === 'followUp') {
      // P5: inherit the active contract, but fold in any new constraints/files
      // from this follow-up (multi-line corrections whose constraint sits past
      // the first line are classified followUp yet must reach the task-anchor).
      if (this.self.taskContract) {
        this.self.taskContract = mergeFollowUpIntoContract(
          this.self.taskContract,
          userInput,
          this.self.session.getTurnCount(),
        )
      }
    } else if (!this.self.taskContract || this.self.taskContract.status === 'ready_to_deliver') {
      this.self.taskContract = undefined
    }

    await this.self.intentRoute.buildForTurn(userInput, actionable, turnMode)

    // 协作分支 advisory（W3）：分支事实来自同一 turn route；social_idle 已在
    // route 层 fail-closed。A/D/CV3 仲裁全部在纯函数 selectCollabAdvisories
    // 内完成（可测的 yielded/selected）：A 与低置信对齐提示渠道去重、按契约
    // 一次性；D 在非 plan mode 且无活跃 PAL 案件时投递；convergence 相邻轮
    // 已发射则 A/D 一律让位（wasConvergenceEmittedRecently，与 CCR/kick 同判据）。
    if (turnMode === 'task') {
      const route = this.self._lastRetrievalRoute
      const branches = route?.collabBranches ?? []
      const decision = selectCollabAdvisories({
        branches,
        contractId: this.self.taskContract?.id,
        lowConfidenceRendered: route !== null && route.confidence < 0.6,
        planMode: this.self.planModeState === 'planning',
        palActiveCases: this.self.problemAttack.snapshotForCvm()?.activeCases ?? 0,
        convergenceEmitted: this.self.wasConvergenceEmittedRecently(),
        alignFiredContracts: this.self.collabAlignFiredContracts,
      })
      for (const spec of decision.selected) {
        this.self.advisoryBus.submit(spec)
        if (spec.branch === 'A') this.self.collabAlignFiredContracts.add(spec.key)
      }

      // E 复用既有贪狼触发器（单一实现：EXPLORATION_SIGNAL_RE 由 collab-branches
      // 持有）；分支只是 route 事实，不新增第二套触发逻辑或 advisory key。
      let gist: string | undefined
      try {
        gist = getCapsuleByStar(this.self.cwd, '贪狼')?.gist
      } catch { /* capsule discovery is optional */ }
      const tanlang = buildTanlangExplorationAdvisory(userInput, gist)
      if (tanlang) {
        this.self.advisoryBus.submit({
          key: 'capsule-recall-tanlang',
          priority: 0.45,
          category: 'star_domain',
          tier: 'informational',
          content: tanlang,
          ttl: 1,
        })
      }
    }

    // Classify task dependency depth for TDD strategy / verifier selection
    if (this.self.taskContract && actionable) {
      const routeKinds = this.self._lastRetrievalRoute?.taskKinds
      // 初始证据义务（evidence-driven reasoning loop Wave 3）：由结构化来源
      // （task kind + contract）创建，不做自由文本 claim 抽取（计划「待验证假设」
      // 明确第一版不上正则 claim detector）。只在新任务边界创建一次——upsert
      // 幂等（稳定 ID），followUp 轮重复调用不改变状态。
      if (turnMode === 'task') {
        const targets = this.self.taskContract.scope.mentionedFiles
        // 无代码目标（问答/审查被误分类为 bug_fix/refactor 的常见形状——文件
        // 提取失败时 mentionedFiles 为空）不创建代码类义务：RED 复现与
        // baseline 回归对纯文本/报告类任务无意义，只会把义务提醒循环
        // 顶到会话超时（2026-08-31 benchmark 实测）。题型形状再兜底一层。
        const noCodeTargets = targets.length === 0 || isDocOrConfigOnly(targets)
        const quizLike = detectQuizLike(userInput)
        if (routeKinds?.includes('bug_fix')) {
          // 跳过纯文档/注释/配置变更——RED 复现不适用于非代码任务。
          if (!noCodeTargets && !quizLike) {
            // bugfix → RED 复现优先（动作矩阵第一列）。high：final gate 参与方。
            this.self.obligations.upsert({
              family: 'bugfix',
              claim: `缺陷已被 RED 复现并修复：${this.self.taskContract.objective}`,
              targets,
              risk: 'high',
            })
          }
        }
        if (routeKinds?.includes('refactor') && !noCodeTargets && !quizLike) {
          // 重构的风险形态是回归。medium：提供 baseline_diff 升级阶梯与
          // 状态可见性，但不拦 natural-finish（回归权威仍是 B1 delivery gate
          // + regressionInventory 核验）。
          this.self.obligations.upsert({
            family: 'regression',
            claim: `重构未破坏既有行为：${this.self.taskContract.objective}`,
            targets,
            risk: 'medium',
          })
        }
        if (routeKinds?.includes('review_audit') || routeKinds?.includes('performance_diagnosis')) {
          // 审查/诊断结论需要交叉验证（计划：review/diagnosis→交叉验证）。
          // medium：诊断是排查不是交付，不制造 final gate 仪式。
          this.self.obligations.upsert({
            family: 'behavior',
            claim: `诊断/审查结论有独立证据支撑：${this.self.taskContract.objective}`,
            targets,
            risk: 'medium',
            requiredAction: 'cross_check',
          })
        }
      }
      this.self._taskDepthLayer = classifyTaskDepth(this.self.taskContract, undefined, routeKinds)
      this.self.config.promptEngine.setTaskDepthLayer(this.self._taskDepthLayer)
      // Plan mode always uses design-doc advisory (not executable Superpowers bash template);
      // execution-mode tasks still route between lightweight and full based on depth + safety.
      this.self._planMethodology = this.self.planModeState === 'planning'
        ? 'full'
        : classifyPlanMethodology(this.self.taskContract, this.self._taskDepthLayer, undefined, undefined, this.self._lastRetrievalRoute?.collabBranches)
      this.self.config.promptEngine.setPlanMethodology(
        this.self._planMethodology,
        undefined,
        { planMode: this.self.planModeState === 'planning' },
      )
      // U6: open a fresh execution trace for a new task (or a changed contract).
      if (this.self._taskDepthLayer) {
        this.self.planTraceCoordinator.openTrace(this.self.taskContract.id, this.self._taskDepthLayer)
      }
      // 主动 plan mode 建议：多模块任务（full 方法论）默认指令主控直接 enter_mode
      // 自主进入（每 contract one-shot；RIVET_PLAN_MODE_SUGGEST=ask 回到先问用户，
      // =0/off 禁用）。
      const planSuggestMode = planModeSuggestMode()
      if (planSuggestMode !== 'off') {
        const suggestion = shouldSuggestPlanMode({
          turnMode,
          contract: this.self.taskContract,
          methodology: this.self._planMethodology,
          depthLayer: this.self._taskDepthLayer,
          planModeState: this.self.planModeState,
          suggestedContractIds: this.self.planModeSuggestedContracts,
        })
        if (suggestion.suggest) {
          this.self.planModeSuggestedContracts.add(this.self.taskContract.id)
          this.self.advisoryBus.submit({
            key: 'plan-mode-suggest',
            priority: 0.9,
            category: 'discipline',
            tier: 'constitutional',
            content: planSuggestMode === 'ask'
              ? buildPlanModeSuggestAdvisory(suggestion.reason)
              : buildPlanModeAutoEnterAdvisory(suggestion.reason),
            ttl: 1,
            expect: planSuggestMode === 'ask'
              ? { kind: 'tool_appears', tools: ['ask_user_question'], withinTurns: 1 }
              // 模型可合法选择先建 todo 再 enter（回执指引的顺序），给 2 轮窗口。
              : { kind: 'tool_appears', tools: ['plan'], withinTurns: 2 },
            channel: 'system-reminder',
          })
        }
      }
    } else {
      this.self._taskDepthLayer = undefined
      this.self._planMethodology = undefined
      this.self.config.promptEngine.setTaskDepthLayer(undefined)
      this.self.config.promptEngine.setPlanMethodology(undefined)
      // U6: no active task — drop any prior trace + clear its prompt surfaces.
      this.self.planTraceCoordinator.closeTrace()
    }

    this.self.config.promptEngine.setSkillAdvisoryBlock(
      skillRegistry.renderDiscoveryBlock(userInput, { exclude: this.self.getDisabledSkills() }),
    )
    // 三路都走 appendixDelta，永不改 frozen prefix：精选常驻、意图门控 STM、
    // 显式 A/B 全量注入。adaptive-memory 默认 shadow，RIVET_ADAPTIVE_MEMORY=on 开启。
    const crossSessionOff = crossSessionDisabled(this.self.config.crossSessionEnabled)
    // 2026-09 记忆幻觉治理：agent-crafted 不再无条件按「最近写入」注入。
    // 新任务用新问题做 query；followUp 沿用当前契约目标。排除当前会话与
    // 所有在线并行会话的条目——前者避免旧任务回声，后者避免并行工作区
    // 在途记忆互相污染（presence TTL 内视为在线）。
    const memoryIntentText = turnMode === 'task' ? userInput : (this.self.taskContract?.objective ?? userInput)
    const liveSessionIds = crossSessionOff
      ? []
      : loadPresence(this.self.cwd, this.self.config.sessionId).map(e => e.sessionId)
    const excludedSessionIds = [this.self.config.sessionId, ...liveSessionIds].filter((id): id is string => Boolean(id))
    const craftedMemory = crossSessionOff
      ? null
      : renderMemoryBlock(this.self.cwd, memoryIntentText, 1000, 'agent-crafted', {
          queryGatedSource: true,
          excludeSessionIds: excludedSessionIds,
        })
    const adaptiveMemory = crossSessionOff ? null : (await reviewAdaptiveMemory({
      cwd: this.self.cwd, sessionId: this.self.config.sessionId,
      turn: this.self.session.getTurnCount(), intentText: memoryIntentText, userInput,
      excludeSessionIds: excludedSessionIds,
    })).block
    this.self.config.promptEngine.setCrossSessionMemoryBlock(combineMemoryBlocks(
      craftedMemory,
      adaptiveMemory,
      crossSessionMemoryPushEnabled() && !crossSessionOff ? renderMemoryBlock(this.self.cwd, userInput, 2000, undefined, { excludeSessionIds: excludedSessionIds }) : null,
    ))
    this.self.config.promptEngine.setMentionContextBlock(
      renderMentionContext(normalizeMentionRefs(parseMentions(userInput), this.self.cwd)),
    )

    this.self.config.promptEngine.setPlanCacheAdvisory(
      turnMode === 'task' ? renderPlanCacheAdvisory(this.self.p3.planCacheSuggest(userInput)) : null,
    )

    // Plan mode 强制使用 max reasoning effort，不受 autoReasoning 动态选择影响。
    if (this.self.planModeState === 'planning') {
      this.self.config.reasoningEffort = 'max'
      this.self.config.client.setReasoningEffort?.('max')
    }

    if (this.self.config.autoReasoning && turnMode === 'task' && !this.self.userReasoningOverride && this.self.planModeState !== 'planning') {
      // autoReasoning 自动按输入复杂度选 effort——但用户显式 /effort <档位> 后
      // （userReasoningOverride=true）不再覆盖，尊重用户选择直到 /effort auto 交还。
      // Plan mode 已在上方强制 max，此处跳过避免覆盖。
      const ruleEffort = selectReasoningEffort(userInput, this.self.config.reasoningFloor)
      const banditAdjusted = this.self.applyEffortDelta(ruleEffort) as import('./auto-reasoning.js').ReasoningEffort
      this.self.config.reasoningEffort = banditAdjusted
      this.self.config.client.setReasoningEffort?.(banditAdjusted)
      this.self.shadowEffortTelemetry(ruleEffort)
    }
    return { heartbeat, wrappedCallbacks: callbacks, turnMode }
  }

  /**
   * Step 6f: Build turn request — intent evaluation, repair hint injection,
   * reliability decision, context ceiling enforcement, cross-session event
   * sync, and OAI request building. Returns the action and request.
   */
  async buildTurnRequest(
    turn: number,
    currentStrategy: StrategyProfile,
    currentSensorium: Sensorium,
    pressureResult: import('../context/pressure-monitor.js').PressureResult,
    assistantResponded: boolean,
    userMessageConsumed: boolean,
    callbacks: AgentCallbacks,
  ): Promise<{
    action: 'proceed' | 'abort'
    request?: OaiChatRequest
  }> {
    let _tb = Date.now()
    // Non-blocking direction note: fire-and-forget. The agent always continues;
    // the user steers by typing if they want to change direction.
    this.self.intent.evaluate({
      strategy: currentStrategy,
      vigor: this.self.vigorState,
      sensorium: currentSensorium,
      pheromones: this.self.loadedPheromones,
      pressureResult,
      recentToolHistory: this.self.recentToolHistory,
      onIntentNote: callbacks.onIntentNote,
      taskContractId: this.self.taskContract?.id,
    })
    debugLog(`[turn-boundary] turn=${turn} intent: ${Date.now() - _tb}ms`)

    // Pass 5: adaptive repair hint injection
    this.self.contextInjection.refreshRepairHint()

    // Anti-habituation: staleness / vigor-low advisories are now routed by
    // CognitiveCapsuleRouter (preTurn hook) via advisory bus. Manual injection removed.

    // CVM-vector 干预路由（v3.1 计划）：render 前的唯一评估点——此时本轮
    // convergence/pressure/obligation 事实与各 preTurn hook 的 pending advisory
    // 全部就绪。纪律：off 不评估；shadow 只落 telemetry，绝不 submit（“名义
    // shadow、实际影响模型”是计划的反证测试项）；active 至多 submit 一条。
    // evaluator 抛错吞掉——干预路由永不阻断主 turn。
    if (this.self.cvmVector.mode !== 'off') {
      try {
        const conv = this.self.latestConvergenceResult
        const evidenceState = this.self.evidence.getState()
        const decision = this.self.cvmVector.evaluator.evaluate({
          turn,
          phaseClass: this.self.getConvergencePhaseClass(),
          convergence: conv
            ? {
                score: conv.score,
                level: conv.level,
                textRepetitionPenalty: conv.signals.textRepetitionPenalty,
                oscillationPenalty: conv.signals.oscillationPenalty,
              }
            : null,
          pressure: {
            ratio: pressureResult.ratio,
            cvmOverheadRatio: pressureResult.cvmOverheadRatio,
            thrashing: pressureResult.thrashing,
            shouldThrottleCvm: pressureResult.shouldThrottleCvm,
            hardCeiling: this.self.pressureMonitor.isCvmThrottlingCeiling(),
          },
          obligations: this.self.obligations.getStore(),
          evidence: {
            filesModified: evidenceState.filesModified.size,
            deliveryStatus: evidenceState.deliveryStatus,
          },
          pendingAdvisoryKeys: this.self.advisoryBus.peekPendingKeys(),
          convergenceEmittedRecently: this.self.wasConvergenceEmittedRecently(),
          scoutOwned: this.self.anchorScoutOwned,
          hasDecisionGates: this.self.controlPlane.getFrame().decisionGates.length > 0,
          // PAL 攻坚层（计划 v2 CV3）：存活案件只读快照 + 层开关。
          attack: palMode() === 'off' ? null : this.self.problemAttack.snapshotForCvm(),
          attackLayerEnabled: palMode() !== 'off',
          // W1 开案信号聚合（第四波）：带稳定锚的"卡住形状"事实——纯函数，
          // trace 无 steps / 无 wave-gate 记录时对应源自然缺席。
          caseOpenSignals: palMode() === 'off' ? [] : collectCaseOpenSignals({
            pendingAdvisoryKeys: this.self.advisoryBus.peekPendingKeys(),
            obligations: this.self.obligations.getStore(),
            planTrace: this.self.planTrace,
            waveGate: getWaveGate(this.self.config.sessionId),
            // 遗产回收 W-A2：convergence 硬熔断事实（本轮无结果 → 源缺席）。
            convergenceAbort: conv ? { shouldAbort: conv.shouldAbort, abortCause: conv.abortCause } : null,
          }),
        })
        if (decision.classification || decision.candidate || decision.yielded) {
          this.self.telemetryWriter.write({
            kind: 'cvm-vector-decision',
            turn,
            mode: this.self.cvmVector.mode,
            classification: decision.classification?.kind ?? null,
            ruleId: decision.classification?.ruleId ?? decision.candidate?.ruleId ?? null,
            facts: decision.classification?.facts ?? null,
            candidateKey: decision.candidate?.entry.key ?? null,
            yielded: decision.yielded,
          })
        }
        if (this.self.cvmVector.mode === 'active' && decision.candidate) {
          // attack_case 已是 CORE 常驻（2026-07-17，26→27）——绝不在会话中途
          // enableTool：改 tool fingerprint = 200K 前缀全量重建（V4 创建 ¥3/M、
          // 高峰 ¥6/M，一次一两块）。CV3-open 直接发声即可，工具恒可见。
          this.self.advisoryBus.submit(decision.candidate.entry)
        }
      } catch {
        // CVM-vector 评估失败不影响 turn 主路径
      }
    }

    // P2 阴阳调度 plan advisory：structure-flow 快照驱动的进/退 plan 建议。
    // advisory-only（不改 plan mode）、session 级去重（用户干预/生命周期清空）、
    // 纯函数判定——失败吞掉，不阻断主 turn。
    if (this.self.latestStructureFlow) {
      try {
        const planAdvisory = buildStructureFlowPlanAdvisory({
          snapshot: this.self.latestStructureFlow,
          planModeState: this.self.planModeState,
          activePlanFile: this.self.activePlanFilePath !== null,
          firedKeys: this.self.structureFlowPlanAdvisoryKeys,
        })
        if (planAdvisory) {
          this.self.structureFlowPlanAdvisoryKeys.add(planAdvisory.key)
          this.self.advisoryBus.submit({
            key: planAdvisory.key,
            priority: 0.55,
            category: 'discipline',
            tier: 'operational',
            content: planAdvisory.content,
            ttl: 2,
          })
        }
      } catch { /* advisory 通道失败不影响 turn 主路径 */ }
    }

    // A1: flush advisory bus into prompt engine (unified corrective guidance)
    // Pass active star domain name for dedup — suppress entries whose 【星名】 tag
    // matches the domain already rendered in the frozen base.
    const activeStarName = this.self.sessionDomain?.name
    const advisoryBlock = this.self.advisoryBus.render(activeStarName, turn)
    this.self.config.promptEngine.setHarnessAdvisoryBlock(advisoryBlock)

    // Phase 2 通道分级：system-reminder 通道条目走消息流细断点（必读通道,
    // 缓存安全:只追加尾部）。目前仅 git-clear 等 immediate 守护使用。
    // W2-B1: K1 append-only — each drained SR charges its bytes exactly once
    // at the moment it is committed to the session tail.
    // Wave 1 SR 账本修正：回调确认送达/丢弃，避免 SessionContext cap
    // 拦截的条目仍被计入 rendered/delivered（采纳率分母污染）。
    // W2：失败条目 requeue 回 bus 参与下轮 drain（有界携带），替代永久丢弃。
    // P2 修复：discipline 条目在额度耗尽时留在 bus 不取出（不消耗 carry）——
    // 等下一用户轮额度恢复后自然送达。carry 上限只约束"有额度但仍失败"的异常路径。
    // functional/user 照常排空。
    for (const { key, content, srClass } of this.self.advisoryBus.drainSystemReminders()) {
      // P2: discipline 额度耗尽时不尝试注入——条目留在 bus（skipCarry，不消耗配额）
      if (srClass === 'discipline' && !this.self.session.hasDisciplineSrQuota()) {
        this.self.advisoryBus.requeueSr(key, content, srClass, true)
        continue
      }
      const ok = this.self.session.appendSystemReminderAndReport(content, srClass)
      if (ok) {
        this.self.advisoryBus.confirmSrDelivered(key)
      } else {
        this.self.advisoryBus.requeueSr(key, content, srClass)
      }
      this.self.pressureMonitor.recordCvmInjection(Math.ceil(content.length / 4), 'system-reminder')
    }

    // P1a 核销闭环：把本轮实际送达的条目（含 expect 谓词）交给 readback 跟踪。
    // 必须与 runtime hook snapshot 使用同一 session turn 时钟；这里的 `turn` 是
    // TurnOrchestrator.run 局部序号，而 postTool/postTurn 观察事件使用 session
    // turn。混用会让 B2 在局部 turn=13 送达、事件却落在 session turn=2，
    // course_changed 永远无法核销。
    // 控制面 tee（Wave 2）：单次 drain → 不可变快照 → 多路分发。readback 与
    // control adapter 消费同一快照；adapter 绝不自行 drain（一次性消费边界）。
    const deliveredSnapshot = this.self.advisoryBus.drainDelivered()
    this.self.advisoryReadback.track(deliveredSnapshot, this.self.session.getTurnCount())
    this.self.controlPlane.submitAll(signalsFromDelivered(deliveredSnapshot))

    // Phase 0 观测：advisory 投递账本落盘（仅有活动时写，避免遥测噪音），
    // 并把 guardian 活动摘要（CCR/改道/丢弃计数）同步进 session meta。
    const advisoryLedger = this.self.advisoryBus.drainLedger()
    if (advisoryLedger.submitted > 0 || advisoryLedger.dropped > 0) {
      this.self.telemetryWriter.write({ kind: 'advisory-ledger', turn, ...advisoryLedger })
    }
    this.self.recordAdvisoryLedger(advisoryLedger)
    this.self.flushGuardianMeta()
    const ledgerSignal = signalFromLedgerDelta(advisoryLedger)
    if (ledgerSignal) this.self.controlPlane.submit(ledgerSignal)

    // 证据义务 → 控制面（Wave 3）：high open/attempted → decision-gate
    // （kind='obligation'，focus 分流到 inspect/verify 而非 await-user）；
    // medium/blocked → appendix。信号键/摘要由稳定义务 ID 和归一化 claim
    // 派生——状态不变则字节不变，revision 静默。
    this.self.controlPlane.submitAll(signalsFromObligations(this.self.obligations.getStore()))

    // 控制面归并：一轮一次（统一 TTL tick 点）。shadow/active 都在此归并；
    // shadow 只落 K0 遥测（有活动信号才写行，避免噪音），不触碰 prompt。
    {
      const prevRevision = this.self.controlPlane.getFrame().revision
      const frame = this.self.controlPlane.reduceTurn()
      if (frame.signals.length > 0 || frame.revision !== prevRevision) {
        this.self.telemetryWriter.write({
          kind: 'control-plane-frame',
          turn,
          focus: frame.focus,
          revision: frame.revision,
          signals: frame.signals.length,
          gates: frame.decisionGates.map(s => s.key),
          appendix: frame.appendix.map(s => s.key),
          status: frame.status.length,
        })
      }
      // Wave 4：仅 active 模式把 appendix lane 交给 dynamic appendix setter。
      // 渲染是 frame 的纯函数（无时间戳/随机值/计数）——revision 不变则字节
      // 不变，appendixDelta 稳态零重发。off/shadow 下绝不调用 setter，
      // PromptEngine 输出与无控制面时逐字节一致（cache-prefix-replay 锁定）。
      if (this.self.controlPlane.mode === 'active') {
        const controlBlock = renderControlPlaneAppendix(frame)
        this.self.config.promptEngine.setControlPlaneAppendix(controlBlock)
      }
    }

    // W5 轻量生命体征快照（通道 C，默认落盘）：单行 <200B，百轮 <20KB。
    // 事后复盘的最小数据面——节流何时触发、镜面是否存活、advisory 台账走势。
    {
      const s = this.self.sensorium
      const r2 = (v: number) => Math.round(v * 100) / 100
      this.self.telemetryWriter.write({
        kind: VITALS_LITE_KIND,
        ts: Date.now(),
        turn,
        sensorium: s ? {
          momentum: r2(s.momentum), pressure: r2(s.pressure), confidence: r2(s.confidence),
          verificationCoverage: r2(s.verificationCoverage ?? s.confidence),
          complexity: r2(s.complexity), freshness: r2(s.freshness), stability: r2(s.stability ?? 0),
        } : null,
        confidenceMeasured: s?.quality?.confidence === 'measured',
        decisivenessMeasured: s?.decisiveness != null,
        // doom 档位（2026-07-29 补）：stability 的地板由 doomBase 的 0.40 权重决定，
        // 不带这一档就无法判断 `stability < 0.3` 类判据该改写成什么——那条判据的
        // 定性至今卡在缺这个分布上。注意 doomLevel 只在 SensoriumInput 上，
        // Sensorium 快照本身不携带，所以这里从 loop 侧现取。
        doomLevel: this.self.getDoomLoopLevel(),
        ctxRatio: r2(pressureResult.ratio),
        cvmOverheadRatio: Math.round(pressureResult.cvmOverheadRatio * 10_000) / 10_000,
        throttled: pressureResult.shouldThrottleCvm,
        // W2-B1 出口计量拆分（量纲：会话累计 token 估算，compact 时随
        // resetCvmOverhead 清零）。恒等式：各 source 之和 == cvmTokenAccumulator。
        cvmBySource: this.self.pressureMonitor.getCvmInjectionBySource(),
        advisories: {
          rendered: this.self.guardianActivity.advisoriesRendered,
          dropped: this.self.guardianActivity.advisoriesDropped,
          adopted: this.self.guardianActivity.advisoriesAdopted,
          srSubmitted: this.self.guardianActivity.advisoriesSrSubmitted,
          srDropped: this.self.guardianActivity.advisoriesSrDropped,
        },
      })
    }

    // B 跨会话效能信息素:每 20 轮增量写回(崩溃不丢账;postSession 兜底全量)
    if (turn > 0 && turn % 20 === 0) {
      this.self.flushAdvisoryEfficacy()
    }

    this.self.refreshReliabilityDecision()

    _tb = Date.now()
    await this.self.compaction.enforceContextCeiling()
    debugLog(`[turn-boundary] turn=${turn} enforceContextCeiling: ${Date.now() - _tb}ms`)
    // A2: enforceContextCeiling can trigger LLM compact (30s timeout).
    if (this.self.abortController!.signal.aborted) {
      if (!assistantResponded && !userMessageConsumed) this.self.session.removeLastMessage()
      callbacks.onAbort(this.self.abortReason())
      return { action: 'abort' }
    }
    this.self.contextInjection.refreshActiveClaims()

    // Read events from other sessions (cache-safe: injected into dynamic appendix only)
    if (!crossSessionDisabled(this.self.config.crossSessionEnabled) && this.self.config.sessionRegistry && this.self.config.sessionId) {
      const events = this.self.config.sessionRegistry.consumeEvents(this.self.config.sessionId, this.self.lastSeenEventId)
      let appendix = ''
      if (events.length > 0) {
        this.self.lastSeenEventId = Math.max(...events.map(e => e.id))
        appendix = formatEventsForAppendix(events)
        // Peer sessions edited these files — drop our read-dedup records so
        // the next read_file returns real content instead of a [read-ref].
        invalidateReadCachesForEvents(events, this.self.cwd)
      }
      // P2b: inject active cross-session claims so the LLM can proactively avoid conflicts
      const claims = this.self.config.sessionRegistry.getActiveClaims(this.self.config.sessionId)
      const claimsBlock = renderCrossSessionClaims(claims)
      if (claimsBlock) {
        appendix = (appendix ? appendix + '\n' : '') + claimsBlock
      }
      if (this.self.persist) {
        const prevHandoff = SessionPersist.loadPrevHandoff(
          this.self.cwd,
          this.self.config.sessionId,
          this.self.sessionDomain?.id,
        )
        if (prevHandoff) {
          appendix = (appendix ? appendix + '\n' : '') +
            '<prev-session-handoff>\n' + prevHandoff + '\n</prev-session-handoff>'
        }
      }
      this.self.config.promptEngine.setCrossSessionEvents(appendix || null)
    }
    // Companion presence: load other live sessions for awareness
    {
      const companions = crossSessionDisabled(this.self.config.crossSessionEnabled) ? [] : loadPresence(this.self.cwd, this.self.config.sessionId)
      this.self.config.promptEngine.setCompanionPresence(
        companions.length > 0 ? formatPresenceForAppendix(companions) : null,
      )
    }
    // Inject session state snapshot into volatile block before building request
    if (this.self.sessionStateManager) {
      this.self.config.promptEngine.setSessionState(this.self.sessionStateManager.renderForVolatile())
    }
    // Doom-loop / storm → escalate terseness in dynamic appendix (cost + anti-ramble).
    // Opt out with RIVET_TERSE=0. Does not touch frozenBase.
    this.self.config.promptEngine.setTersenessEscalate(this.self.getDoomLoopLevel() !== 'none')
    // Pre-refresh git status so buildOaiRequest doesn't return stale cached data
    _tb = Date.now()
    await this.self.config.promptEngine.refreshGitContextIfNeeded(this.self.cwd)
    debugLog(`[turn-boundary] turn=${turn} refreshGitContext: ${Date.now() - _tb}ms`)
    const request = this.self.config.promptEngine.buildOaiRequest(
      this.self.session.getMessages(),
      this.self.recentToolHistory,
      this.self.config.contextWindow,
      {
        onOrphanRepair: (repaired, count) => {
          debugLog(`[orphan-repair] buildOaiRequest repaired ${count} orphan(s) — writing back to session`)
          this.self.session.replaceMessages(repaired)
        },
        writeProbe: createWriteEvidenceProbe(this.self.cwd),
      },
    )

    // ── CVM egress metering ──
    // 盘古呼吸：CVM 保护的资源（context）也是它消耗的资源。账记在字节真正写进
    // <context-update> 的地方——buildOaiRequest 内部。工具轮复用 cachedAppendix、
    // 稳态 delta 静默、Top-K 淘汰的块都不进账本，这里自然拿到空数组。
    // chars / 4 ≈ tokens（够用的粗估，只用于 overhead 比例）
    for (const { source, chars } of this.self.config.promptEngine.drainAppendixLedger()) {
      this.self.pressureMonitor.recordCvmInjection(Math.ceil(chars / 4), source)
    }

    // Appendix audit trail (gated). Placed after the request is built so it records
    // what was actually sent, not what the setters intended.
    recordAppendixTrace(this.self.config.promptEngine.getCachedAppendix(), {
      cwd: this.self.cwd,
      sessionId: this.self.config.sessionId,
      turn,
      model: this.self.config.promptEngine.getModel(),
    })

    return { action: 'proceed', request }
  }

  /**
   * Build and inject the cognitive projection (cognitive-mirror + task-contract
   * + verification-gap + uncertainty + immune hint) into the prompt engine.
   * Reconnected after the loop-split refactor silently orphaned it.
   *
   */
  private runCognitivePrep(
    turn: number,
    eligibility: import('./discipline-eligibility.js').DisciplineEligibility,
    pressureResult: import('../context/pressure-monitor.js').PressureResult,
  ): void {
    // Delivery 义务（动态）：任务型会话里代码文件被改且尚未验证 → 登记
    // high 义务（self-verify 从 postTurn 软文升格为 final 前门禁的状态载体）。
    // targets=[] → 任意 passed 验证即关闭（B1 delivery gate 仍是交付权威，
    // 义务只负责 natural-finish 前的注意力）。doc/config-only 编辑不创建
    // （low_risk_small_edit_never_gates_final）。upsert 幂等，每轮调用安全。
    {
      const ev = this.self.evidence.getState()
      const gate = this.self.evidence.getGateState()
      if (eligibility.requiresEngineeringDiscipline && this.self.taskContract && gate.hasCodeEdits && ev.deliveryStatus === 'unverified') {
        this.self.obligations.upsert({
          family: 'delivery',
          claim: '本任务修改的代码已通过相关验证',
          targets: [],
          risk: 'high',
        })
      }

      // Acceptance 义务（用户级行为验收）：同样的资格门，但**刻意不看
      // deliveryStatus**——delivery 那条一旦跑过任意 passed 验证就不再创建，
      // 而"验在哪个层级"恰恰是在那之后才失守的（跑个单测就自认交付）。
      // claim/targets 固定 → ID 稳定，每个用户任务一条，边界 supersede 回收。
      if (eligibility.requiresEngineeringDiscipline && this.self.taskContract && gate.hasCodeEdits) {
        const acceptanceId = this.self.obligations.upsert({
          family: 'acceptance',
          claim: '本任务已通过用户级行为验收（声明的可观察完成标志已实际执行）',
          targets: [],
          risk: 'high',
        })

        // 「请声明验收面」：每契约只响一次（义务块每轮渲染 next=user_acceptance
        // 已是被动通道，advisory 不该逐轮加码），且只在还没有任何回写时催
        // （open + 零 attempt；captureAcceptance 收到声明后会记一次 attempt）。
        // 位置刻意放在首次代码编辑后的短轮而非收尾长轮——采纳率与轮长强负相关，
        // 而且验证之前声明才有 pre-commitment 意义，交付时补写等于给已做的事编理由。
        const acceptanceOb = this.self.obligations.getStore().obligations
          .find(o => o.id === acceptanceId)
        const contractId = this.self.taskContract.id
        if (
          acceptanceOb?.state === 'open' && acceptanceOb.attempts === 0
          && !this.self.acceptanceAdvisedContracts.has(contractId)
        ) {
          this.self.acceptanceAdvisedContracts.add(contractId)
          this.self.advisoryBus.submit({
            key: 'acceptance-declare',
            priority: 0.6,
            category: 'discipline',
            tier: 'operational',
            content: '代码已改动，但本任务还没有用户级验收面。现在用 todo 的 acceptance 字段声明「用户做什么动作 → 看到什么可观察结果」。'
              + '跑单测通过属于 delivery，不是验收——验收要落在用户能观察到的行为上（按某个键、访问某个地址、看到某个具体状态）。'
              + '做完把该项回写 met + evidence；确实执行不了标 blocked 并写明障碍。',
            ttl: 1,
            expect: { kind: 'tool_appears', tools: ['todo'], withinTurns: 2 },
          })
        }
      }
    }
    const cognitiveLedger = createCognitiveLedger({
      contract: this.self.taskContract,
      evidence: this.self.evidence.getState(),
      trace: this.self.traceStore,
      turn,
      // W6 节流次序反转（incident 20b9714e）：镜面任何节流档位不熄。它是
      // 通道 A（appendixDelta 字节稳定，稳态近零成本），也是模型唯一的自我
      // 感知窗口——旧行为在长会话后段熄灭镜面、同时 advisory 照发，模型恰在
      // 最需要自察时失去镜子。节流现在降级通道 B（advisory-bus 隔周期送达）。
      sensorium: this.self.sensorium,
      strategy: this.self.strategy,
      vigor: this.self.vigorState,
      season: this.self.currentSeason,
      seasonIntensity: this.self.currentSeasonIntensity ?? undefined,
      riskLevel: this.self.latestRisk.level,
      convergencePrecision: this.self.latestConvergenceResult?.score,
      outputEfficiency: this.self.latestConvergenceResult?.signals.tokenEfficiency,
      // W4：ctx 占用硬数据不随 CVM 节流关闭——它是最便宜的字段（10% 桶字节
      // 稳定），也是防"窗口紧张"脑补的关键锚点。
      ctxRatio: pressureResult.ratio,
      ctxWindow: this.self.config.contextWindow,
      // T5: 美德 mirror — Fibonacci 桶字节稳定，无条件传入
      virtue: this.self.stanceTally.renderMirror(),
      // 证据义务结构化摘要：非空时替代 verification-gap（同一事实单一声音）。
      obligationBlock: this.self.obligations.renderBlock(),
      eligibility,
    })
    this.self.latestCognitiveSnapshot = getCognitivePhaseSnapshot(cognitiveLedger)

    // Sycophancy trap: record previous turn's behavior
    let yaoguangHint: string | null = null
    if (turn > 1 && this.self.recentToolHistory.length > 0) {
      const EPISTEMIC_TOOLS = new Set(['read_file', 'grep', 'list_dir', 'glob', 'search', 'recall', 'read_image'])
      const hadEpistemic = this.self.recentToolHistory.some(t => EPISTEMIC_TOOLS.has(t.tool))
      const confidence = this.self.sensorium?.confidence ?? 0.5
      this.self.sycophancyTrap.recordTurn({ agreedWithUser: !hadEpistemic, confidence })

      // ── 瑶光 afterPerception 门禁：复现即证 ──
      // 蒸馏自瑶光胶囊 #1「绿非证明，复现即证」。
      // 模型引用了文件名但本轮未调用任何验证工具 → 断言大概率是猜测。
      const streamedText = this.self.streamedText
      const fileRefPattern = /\b[\w./-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|rb|vue|svelte|css|scss|html|json|yaml|yml|md|sql)\b/
      if (!hadEpistemic && streamedText.length > 200 && fileRefPattern.test(streamedText)) {
        yaoguangHint = '【瑶光·复现即证】上轮回复引用了文件名但未读取其中任何文件。在下一轮开始前，你必须用实际 read_file 或 grep 输出证明你的断言——不可凭文件名推断内容。绿非证明，复现即证。'
      }
    }
    const sycophancyHint = this.self.sycophancyTrap.getHint()
    const immuneHint = this.self._lastImmuneHint ? formatImmuneContext(this.self._lastImmuneHint) : undefined
    this.self._lastImmuneHint = undefined // consume once
    const { stable: projectionStable, ephemeral: projectionEphemeral } = eligibility.projectionMode !== 'none'
      ? buildCognitiveProjectionParts(cognitiveLedger, { sycophancyHint, immuneHint, yaoguangHint })
      : { stable: '', ephemeral: '' }
    this.self.config.promptEngine.setCognitiveProjection(projectionStable, projectionEphemeral)
    // CVM 计量不在这里发生：setter 只是备好内容，字节是否真的上线由
    // buildAppendixBody 的 delta 判定说了算。计费点见 buildRequest 的
    // drainAppendixLedger（设计：docs/design/2026-07-26-cvm-overhead-metering-fix.md）。
  }

  async runPerception(
    turn: number,
    estTokens: number,
    callbacks: AgentCallbacks,
  ): Promise<{
    sensorium: Sensorium
    strategy: StrategyProfile
    phaseClass: string
    pressureResult: import('../context/pressure-monitor.js').PressureResult
  }> {
    // ── StarFlow v2: Sensorium computation ──
    const pressureResult = this.self.pressureMonitor.check(estTokens, this.self.session.getTurnCount())
    if (this.lastTurnMode === 'chat') {
      this.self.config.promptEngine.setCognitiveProjection(null)
      this.self.config.promptEngine.setTaskProgress({ completed: [], current: 'chat-mode', remaining: [], decisions: [] })
    }
    callbacks.onPhaseChange?.('preparing', { reason: 'preparing next turn' })

    // ── Event-loop gap detection ──
    // If >30s elapsed since last tool completion, the event loop may have
    // been blocked. Log a warning to help diagnose session freeze bugs.
    if (this.self.lastToolCompleteTime > 0) {
      const gapMs = Date.now() - this.self.lastToolCompleteTime
      if (gapMs > 30_000) {
        debugLog(`[event-loop] WARNING: ${(gapMs / 1000).toFixed(1)}s gap since last tool completion (turn ${this.self.session.getTurnCount()})`)
      }
    }

    const _tb = Date.now()
    const perceptionResult = await this.self.perception.perceive({
      turn,
      estimatedTokens: estTokens,
      pressureResult,
      evidenceState: this.self.evidence.getState(),
      deliveryReady: this.self.evidence.deliveryReady(),
      predictionAccumulator: this.self.predictionAccumulator,
      recentToolHistory: this.self.recentToolHistory,
      loadedPheromones: this.self.loadedPheromones,
      traceStore: this.self.traceStore,
      gitChangeRate: this.self.gitChangeRate,
      fsEventRate: this.self.latestFsWatcherState.eventRate,
      sensorium: this.self.sensorium,
      strategy: this.self.strategy,
      vigor: this.self.vigorState,
      thetaState: this.self.thetaState,
      thetaTelemetry: this.self.thetaTelemetry,
      thetaCheckInFlight: this.self.thetaCheckInFlight,
      baselineFingerprint: this.self.baselineFingerprint,
      convergenceScore: this.self.latestConvergenceResult?.score ?? null,
    }, {
      emitPhaseChange: (phase, detail) => { callbacks.onPhaseChange?.(phase, detail) },
      emitDecisionShift: (shift) => {
        this.self.recordDecisionShift(shift.source)
        callbacks.onDecisionShift?.(shift)
      },
    })
    this.self.sensorium = perceptionResult.sensorium
    debugLog(`[turn-boundary] turn=${turn} perceive: ${Date.now() - _tb}ms`)
    this.self.strategy = perceptionResult.strategy
    this.self.vigorState = perceptionResult.vigor
    this.self.thetaState = perceptionResult.thetaState
    this.self.sensoriumSnapshots = this.self.perception.getSnapshots()
    const currentSensorium: Sensorium = perceptionResult.sensorium

    // ── 认知季节 — 道德经四章螺旋 ──
    const seasonResult = classifySeason({
      turn,
      doomLevel: this.self.getDoomLoopLevel(),
      recentCompactTurn: this.self.lastCompactTurn,
      sensoriumStability: currentSensorium.stability,
    })
    this.self.currentSeason = seasonResult.season
    this.self.currentSeasonIntensity = seasonResult.intensity

    // ── Embodied Cognition: affordance-gated tool selection hint ──
    // 产出流与 advisory-bus 阶段抑制共用同一判据（production-flow.ts）——
    // 那里用它决定「别打扰」，这里用它解除 wuwei 的「抑执行」。
    const inProductionFlow = isInProductionFlow(this.self.recentToolHistory)
    const affordanceState: AffordanceState = {
      sensorium: currentSensorium,
      vigor: this.self.vigorState,
      thetaPhase: getThetaPhase(this.self.thetaState),
      season: this.self.currentSeason,
      workingSetSize: this.self.evidence.getState().filesModified.size,
      recentToolNames: this.self.recentToolHistory.map(t => t.tool),
      contractStatus: this.self.taskContract?.status,
      inProductionFlow,
    }
    // ── Free Energy Engine: EFE-driven policy guidance ──
    let structuralEpistemic: number | undefined
    try { structuralEpistemic = this.self.immuneHook.getPhysarum().structuralEpistemic() } catch { /* graph signal is optional */ }
    const efe = computeEFE(this.self.predictionAccumulator, this.self.currentSeason, this.self.vigorState, currentSensorium, structuralEpistemic, inProductionFlow)
    this.self.latestPolicySignals = { efe, sensorium: currentSensorium }
    const affordances = computeAffordanceScores(affordanceState, this.self.sessionAffordanceAdaptations)
    const policies = selectPolicy(efe, affordances, { topK: 5 })
    // W6 节流次序反转：toolContext（通道 A 中较贵的块）只在 8% 硬顶才熄，
    // 5% 阈值改为降级通道 B（advisory-bus 隔渲染周期送达，见下）。
    if (this.self.pressureMonitor.isCvmThrottlingCeiling()) {
      this.self.config.promptEngine.setToolContext(null)
    } else {
      this.self.config.promptEngine.setToolContext(renderToolContext(affordanceState, policies, efe) || null)
    }
    this.self.advisoryBus.setOverheadThrottled(pressureResult.shouldThrottleCvm)
    this.self.recordModelRoutingShadow(currentSensorium, efe)

    // ── Adaptive Affordance: periodically recalibrate base affordances from sensorimotor history ──
    if (this.self.session.getTurnCount() % 10 === 0) {
      try {
        const db = this.self.config.meridianIndexer?.getDb()
        if (db) {
          this.self.sessionAffordanceAdaptations = adaptAffordanceFromHistory(toolName => db.getToolSuccessRate(toolName, 20))
        }
      } catch { /* affordance adaptation is non-critical */ }
    }

    // Wire StarPhase → phaseClass for field habituation modulation
    const mapped = PHASE_CLASS_MAP[perceptionResult.event.phase]
    const phaseClass = mapped ?? (() => {
      debugLog(`[convergence] unmapped StarPhase "${perceptionResult.event.phase}" — falling back to explore`)
      return 'explore'
    })()
    this.self.config.promptEngine.setPhaseHint(phaseClass)
    const contractStatus = contractStatusFromPhaseClass(phaseClass)
    // 构造统一资格对象，供 TDD gate 和 cognitive prep 共用
    const taskKinds = this.self._lastRetrievalRoute?.taskKinds ?? []
    const explicitNoMutation = detectExplicitNoMutation(this.self.initialUserMessage ?? '')
    const eligibility = deriveDisciplineEligibility({
      turnMode: this.lastTurnMode, taskKinds, explicitNoMutation,
      mentionedCodeFileCount: this.self.taskContract?.scope.mentionedFiles.length,
      problemSignal: detectProblemSignal(this.self.initialUserMessage ?? ''),
    })
    this.self._lastEligibility = eligibility

    if (this.self.taskContract && contractStatus) {
      const prevStatus = this.self.taskContract.status
      this.self.taskContract = advanceContractStatus(this.self.taskContract, contractStatus, this.self.session.getTurnCount())

      // TDD Gate: check on every executing turn — keeps reminding until
      // the agent touches a test file. Not one-shot: skipping TDD once
      // should not silence the gate for the rest of the task.
      if (this.self.taskContract.status === 'executing') {
        const es = this.self.evidence.getState()
        const tddHint = checkTddGate({
          filesRead: es.filesRead,
          filesModified: es.filesModified,
          requiresCodeVerification: eligibility.requiresCodeVerification,
        })
        if (tddHint) this.self._lastImmuneHint = tddHint

        // L1 suggest: edit streak without verification — produce a hint
        // even when test files were read (checkTddGate only checks that).
        // Only sets _lastImmuneHint when checkTddGate didn't already produce one,
        // since "no test file touched" is the more critical message.
        const tddConfig = this.self.config.tddGate ?? { enabled: true, mode: 'suggest' as const, threshold: 3, skipIfNoTests: true }
        // P2 阴阳调度：flow 态只降低提示频率（advisory projection），
        // evaluateTddGate 的 allow/block 硬门不经此路径、不受影响。
        const gateHint = buildTddGateHint(this.self.evidence.getGateState(), tddConfig, this.self.latestStructureFlow)
        if (gateHint && !this.self._lastImmuneHint) {
          this.self._lastImmuneHint = gateHint
        }
      }
    }

    // ── Cognitive projection — build & inject cognitive-mirror + contract +
    // verification-gap + uncertainty + immune hint. Runs last so it sees the
    // freshly-advanced contract status and consumes the TDD-gate immune hint
    // produced above (reproduces the original _runInner step-6e ordering).
    // eligibility 已在上方 contract 块之前构造（供 TDD gate 与 cognitive prep 共用）。
    this.runCognitivePrep(turn, eligibility, pressureResult)

    return { sensorium: perceptionResult.sensorium, strategy: perceptionResult.strategy, phaseClass, pressureResult }
  }
}

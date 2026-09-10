/**
 * worker-process child — worker 子进程隔离 v1 的子进程入口（tsup 独立 entry）。
 *
 * 生命周期：spawn → stdin 收 init（完整序列化配置 + 决策投影 + 快照）→
 * 重建运行时（config 落盘重读、registry 最小 refs 重建、client/promptEngine
 * 按 runtimeDecision 忠实重建）→ runWorkerSession → activity/nested/mailbox
 * 流式上行 + tick 心跳 → result 帧 → 自然退出。
 *
 * 关键纪律：
 * - client/promptEngine 按 init.runtimeDecision 重建，不重跑路由——父进程
 *   buildWorkerRuntime 的三分支决策是唯一事实源，子进程重算必漂移。
 * - 嵌套委派在子进程内走进程内 coordinator（runWorkerSession 默认），防
 *   进程爆炸；其活动经 onNestedDelegation 帧上行（父侧盖 parentWorkerId）。
 * - v1 降级（与父侧协议一致）：prewarm/stigmergy 不注入（no-op）；
 *   mailbox 经帧桥回父进程真实 InMemoryMailbox。
 * - 任何启动异常：向 stdout 写一条 log 帧 + result 失败帧后退出——父侧
 *   拿到结构化失败而不是干等 watchdog。
 */

import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { loadConfig } from '../../config/manager.js'
import { createProviderClient, resolveApiKey } from '../../api/factory.js'
import { createAuthProvider } from '../../auth/registry.js'
import { resolveCapabilities } from '../../api/provider.js'
import { PromptEngine } from '../../prompt/engine.js'
import { subagentPromptBlocks } from '../../prompt/block-policy.js'
import { applyDescriptionMode } from '../../tools/description-compact.js'
import { createInteractiveToolRegistry, type RuntimeRefs } from '../../bootstrap.js'
import { filterToolRegistry } from '../../tools/registry.js'
import { TodoStore } from '../../tools/todo-store.js'
import { DelegationCoordinator } from '../coordinator.js'
import { buildModelCards } from '../headless-coordinator.js'
import { buildReviewOverrideState, type ResolvedReviewOverride } from '../review-model-override.js'
import { buildWorkerRuntime } from '../worker-runtime.js'
import { deriveWorkerSessionId } from '../work-order.js'
import { DomainKnowledgeStore } from '../domain-knowledge-store.js'
import { profileRegistry } from '../profile-registry.js'
import { runWorkerSession, type WorkerSessionConfig, type WorkerSessionRun } from '../worker-session.js'
import type { ApprovalMode } from '../loop-types.js'
import type { ModelCapabilityCard } from '../../model/capability.js'
import type { WorkerMailbox } from '../worker-mailbox.js'
import {
  encodeFrame, createFrameDecoder, CHILD_TICK_INTERVAL_MS,
  type ParentMessage, type WorkerChildInitPayload,
} from './protocol.js'

function writeFrame(msg: Parameters<typeof encodeFrame>[0]): void {
  process.stdout.write(encodeFrame(msg))
}

function childLog(line: string): void {
  writeFrame({ t: 'log', line })
}

/** mailbox 桥——send 走帧到父进程真实 InMemoryMailbox；receive/broadcast 等
 *  端在子进程语义为空（收件方在父侧，子进程 worker 间通信 v1 不支持）。 */
function createBridgedMailbox(): WorkerMailbox {
  return {
    send: msg => writeFrame({ t: 'mailbox', msg }),
    receive: () => [],
    broadcast: () => {},
    all: () => [],
    byType: () => [],
    clear: () => {},
    size: () => 0,
  }
}

/** 嵌套委派用的子进程内 coordinator——形态对齐 headless-coordinator 的极简剪裁：
 *  不接 bandit/sessionRegistry/artifactStore/控制面（子进程一层嵌套够用），
 *  runtimeFactory 用子进程 deps（父进程决策只约束顶层 worker，嵌套层正常路由）。 */
function buildChildCoordinator(
  deps: Parameters<typeof buildWorkerRuntime>[0],
  registry: ReturnType<typeof createInteractiveToolRegistry>['registry'],
  config: Parameters<typeof buildWorkerRuntime>[0]['config'],
  parentApprovalMode: ApprovalMode | undefined,
): DelegationCoordinator {
  return new DelegationCoordinator({
    baseToolRegistry: registry,
    modelCards: buildModelCards(deps.provider),
    maxWorkers: resolveMaxWorkers(config),
    providers: config.provider.providers,
    runtimeFactory: (order, card, workerRegistry) => buildWorkerRuntime(deps, order, card, workerRegistry),
    routing: deps.workerRouting,
    sharedWorktree: true,
    patcherTier: config.workers.patcherTier,
    escalationCap: config.workers.escalationCap,
    parentApprovalMode,
    maxDelegationDepth: config.agent.maxDelegationDepth,
  })
}

function resolveMaxWorkers(config: Parameters<typeof buildWorkerRuntime>[0]['config']): number {
  const raw = (config.agent as { maxWorkers?: unknown }).maxWorkers
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1) return raw
  const envN = Number(process.env['RIVET_MAX_WORKERS'])
  if (Number.isInteger(envN) && envN >= 1) return envN
  return 3
}

async function runChild(): Promise<void> {
  // 1) stdin NDJSON → ParentMessage。首帧必须是 init。
  const decoder = createFrameDecoder()
  let initPayload: WorkerChildInitPayload | undefined
  const steerQueue: string[] = []
  const abortController = new AbortController()

  const stdin = createInterface({ input: process.stdin })
  stdin.on('line', (line: string) => {
    for (const msg of decoder.feed(`${line}\n`)) {
      if (msg.t === 'init') {
        initPayload = msg.payload
        if (msg.payload.steerSeed) steerQueue.push(msg.payload.steerSeed)
        void bootAndRun(msg.payload, steerQueue, abortController)
      } else if (msg.t === 'steer') {
        steerQueue.push(msg.text)
      } else if (msg.t === 'abort') {
        abortController.abort(msg.reason)
      }
    }
  })
  // stdin 关闭（父进程死了）而 init 未到——无事可做，退出。
  stdin.on('close', () => {
    if (!initPayload) process.exit(0)
  })

  // 心跳：watchdog 在父侧以 activity/tick 任一重置——boot 期间也得跳。
  const ticker = setInterval(() => writeFrame({ t: 'tick', at: Date.now() }), CHILD_TICK_INTERVAL_MS)
  ticker.unref?.()
}

async function bootAndRun(
  init: WorkerChildInitPayload,
  steerQueue: string[],
  abortController: AbortController,
): Promise<void> {
  try {
    const cfg = init.config
    const cwd = cfg.cwd

    // 2) 运行时重建（全部从落盘 config + init 快照来，无父进程内存态）。
    const config = loadConfig({ cwd })
    const providerName = cfg.providerName ?? config.provider.default
    const provider = config.provider.providers[providerName] ?? config.provider.providers[config.provider.default]!
    let apiKey = ''
    try { apiKey = resolveApiKey(provider) } catch { apiKey = '' }
    const auth = provider.auth ? createAuthProvider(provider.auth, process.env) : undefined

    const overrideState = config.agent.review?.profiles
      ? buildReviewOverrideState(config.agent.review.profiles, config.provider.providers)
      : { cards: new Map<string, ModelCapabilityCard>(), overrides: new Map<string, ResolvedReviewOverride>() }
    const reviewOverrides = overrideState.overrides
    const reviewOverrideApiKeys = new Map<string, string>()
    for (const [profileName, resolved] of reviewOverrides) {
      try { reviewOverrideApiKeys.set(profileName, resolveApiKey(resolved.providerConfig)) } catch {
        reviewOverrides.delete(profileName)
      }
    }

    const workerRouting = config.workers?.profiles && Object.keys(config.workers.profiles).length > 0
      ? { profiles: config.workers.profiles, routing: config.workers.routing, providers: config.provider.providers }
      : undefined

    const domainKnowledgeStore = new DomainKnowledgeStore(join(cwd, '.rivet', 'knowledge'))

    const deps = {
      config,
      cwd,
      provider,
      apiKey,
      auth,
      currentModelId: config.provider.default,
      listActiveClaims: () => init.activeClaims,
      sessionMemoryBlock: () => init.memoryBlock,
      domainKnowledgeStore,
      reviewOverrides,
      reviewOverrideApiKeys,
      workerRouting,
      writeProfiles: profileRegistry.listWriteProfiles(),
    }

    // 3) 工具注册表：最小 refs + createInteractiveToolRegistry（与主进程同一
    //    装配函数）。profile allowedTools 过滤同 coordinator 语义：缺的工具
    //    优雅丢弃（fail-open），子进程注册表面与父进程可能微差——刻意的。
    const refs: RuntimeRefs = {
      coordinator: null,
      fileHistory: null,
      claimStore: null,
      sessionId: null,
      sessionRegistry: null,
      taskLedger: null,
      ownershipLedger: null,
      verificationSnapshotManager: null,
      deliveryGate: null,
      meridianIndexer: null,
      mcpManager: null,
      lspManager: null,
      banditState: null,
      promptEngine: null,
      goalTrackerRef: { current: null },
      reviewGateRef: { current: 'auto' },
      pluginHooks: [],
      pluginCommands: [],
      todoStore: new TodoStore(),
    }
    const { registry } = createInteractiveToolRegistry(refs, config, cwd)
    refs.coordinator = buildChildCoordinator(deps, registry, config, cfg.parentApprovalMode as ApprovalMode | undefined)

    const decision = cfg.runtimeDecision
    if (!decision) throw new Error('init 缺 runtimeDecision——父进程 buildWorkerRuntime 未盖戳（版本不匹配？）')
    const presentTools = cfg.order.allowedTools.filter(name => registry.has(name))
    const missing = cfg.order.allowedTools.filter(name => !registry.has(name))
    if (missing.length > 0) childLog(`[worker-child] dropping ${missing.length} unregistered tool(s): ${missing.join(',')}`)
    const workerRegistry = filterToolRegistry(registry, presentTools)

    // 4) client/promptEngine 按 runtimeDecision 忠实重建（不重跑路由）。
    const providerForDecision = config.provider.providers[decision.providerName] ?? provider
    const modelSpec = providerForDecision.models.find(m => m.id === decision.model || m.alias === decision.model)
    const capabilities = resolveCapabilities(decision.providerName, providerForDecision.capabilities, modelSpec?.capabilities)
    const blocks = subagentPromptBlocks()
    const client = createProviderClient(providerForDecision, capabilities, {
      apiKey,
      model: decision.model,
      reasoningEffort: undefined,
      maxTokens: decision.maxTokens,
      thinkingBudget: decision.thinkingBudget,
      auth,
      // 与父进程 buildWorkerRuntime 用同一公式（只取 order.id，不带 nonce）：
      // 子进程重建 client 时若落回 factory 的进程兜底，同一 work order 会在父子
      // 进程各拿一个 ID，上游会当成两段对话。
      sessionId: deriveWorkerSessionId(cfg.order.id),
    })
    const promptEngine = new PromptEngine({
      model: decision.model,
      maxTokens: decision.maxTokens,
      staticCtx: { tools: applyDescriptionMode(workerRegistry.getDefinitions(), blocks.toolDescriptions), audience: 'subagent' as const },
      volatileCtx: { cwd, sessionMemoryBlock: init.memoryBlock, blockCaps: blocks.caps },
      // 续跑/复核/重试继承上一轮冻结快照——历史 user 消息恢复原始字节，
      // 前缀缓存只在新 user 边界断尾（缺省/坏数据引擎内降级为冷启动）。
      inheritFrozenFrom: cfg.priorFrozenSnapshot,
    })

    // 5) 组装 WorkerSessionConfig（v1 降级项不注入）并执行。
    const workerConfig: WorkerSessionConfig = {
      order: cfg.order,
      client,
      promptEngine,
      toolRegistry: workerRegistry,
      cwd,
      maxTurns: cfg.maxTurns,
      contextWindow: cfg.contextWindow,
      compact: cfg.compact,
      runtimeDecision: decision,
      providerName: cfg.providerName,
      baseUrl: cfg.baseUrl,
      slowThinking: cfg.slowThinking,
      forceJsonRepair: cfg.forceJsonRepair,
      finalizeReport: cfg.finalizeReport,
      reviewDepth: cfg.reviewDepth,
      parentApprovalMode: cfg.parentApprovalMode as ApprovalMode | undefined,
      activeClaims: init.activeClaims,
      domainKnowledgeStore,
      onActivity: (kind, detail) => writeFrame({ t: 'activity', kind, detail }),
      onSteerDrain: () => steerQueue.shift() ?? null,
      onSessionReady: undefined,
      onNestedDelegation: activity => writeFrame({ t: 'nested', activity }),
      checkpoint: cfg.checkpoint,
      priorMessages: cfg.priorMessages,
      priorUsage: cfg.priorUsage,
      sessionNonce: cfg.sessionNonce,
      mailbox: createBridgedMailbox(),
      abortSignal: abortController.signal,
    }

    const run: WorkerSessionRun = await runWorkerSession(workerConfig)
    const messages = (() => {
      try { return run.session?.getMessages() ?? [] } catch { return [] }
    })()
    writeFrame({
      t: 'result',
      run: {
        result: run.result,
        transcript: run.transcript,
        usage: run.usage,
        checkpoint: run.checkpoint,
        messages,
        // 冻结快照随结果上行——导出失败不毁结果（下一轮退化为冷启动，与旧行为一致）。
        frozenSnapshot: (() => { try { return promptEngine.exportFrozenSnapshot() } catch { return undefined } })(),
        turnCount: messages.length,
      },
    })
    // 等 stdout flush 再退（end 的 callback 在冲刷完成后触发）：process.exit()
    // 不等待 pipe 写缓冲，真实 session 的 result 帧（transcript + messages 可达
    // 数十 KB）会被截断，父侧只能合成 worker_crash（2026-09-10 烧机实测）。
    process.stdout.end(() => process.exit(0))
  } catch (err) {
    childLog(`[worker-child] boot/run failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
    writeFrame({
      t: 'result',
      run: {
        result: {
          workOrderId: init.config.order.id,
          status: 'failed',
          summary: `worker child crashed: ${err instanceof Error ? err.message : String(err)}`,
          findings: [],
          artifacts: [],
          changedFiles: [],
          risks: [],
          nextActions: [],
          evidenceStatus: 'skipped',
          failureReason: 'worker_crash',
        },
        transcript: { text: '', thinking: '', toolUses: [], toolResults: [], repairAttempts: 0, errors: [String(err)] },
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        messages: [],
        turnCount: 0,
      },
    })
    process.exit(1)
  }
}

// 入口守卫：父进程以 `--worker-child` 标志参 spawn，命中才跑（防被 import 误启）。
if (process.argv.includes('--worker-child')) {
  void runChild()
}

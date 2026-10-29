import { createWorkerAuthChannel } from './credential-broker.js'
import { OfficialError } from '../../models/official-contract.js'
import { HookRpcClient } from '../../hooks/hook-host-rpc.js'
import { clampReadConcurrency } from '../../config/read-concurrency.js'
import { ModelBindingUnavailable, resolveModelBinding } from '../../model/model-binding.js'
import { isLocalWorkerPolicyError } from '../../api/continuation-prefix.js'
import { withWorkspaceRoots } from '../../tools/workspace-context.js'
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
import { acknowledgeManagedProDenial, withManagedProAuthorization } from '../../api/managed-pro-authorization.js'
import { join } from 'node:path'
import { loadConfig } from '../../config/manager.js'
import { createProviderClient } from '../../api/factory.js'
import { resolveCapabilities } from '../../api/provider.js'
import { PromptEngine } from '../../prompt/engine.js'
import { subagentPromptBlocks } from '../../prompt/block-policy.js'
import { applyDescriptionMode } from '../../tools/description-compact.js'
import { createInteractiveToolRegistry, type RuntimeRefs } from '../../bootstrap.js'
import { filterToolRegistry } from '../../tools/registry.js'
import { TodoStore } from '../../tools/todo-store.js'
import { DelegationCoordinator, workerFailureResult } from '../coordinator.js'
import { buildModelCards } from '../headless-coordinator.js'
import { buildWorkerRuntime, createWorkerRuntimeFactory } from '../worker-runtime.js'
import { parseUserInstructionsSnapshot } from '../../prompt/user-instructions.js'
import { deriveWorkerSessionId } from '../work-order.js'
import { DomainKnowledgeStore } from '../domain-knowledge-store.js'
import { profileRegistry } from '../profile-registry.js'
import { runWorkerSession, type WorkerSessionConfig, type WorkerSessionRun } from '../worker-session.js'
import type { ApprovalMode } from '../loop-types.js'
import type { WorkerMailbox } from '../worker-mailbox.js'
import {
  encodeFrame, createFrameDecoder, CHILD_TICK_INTERVAL_MS,
  type WorkerChildInitPayload,
} from './protocol.js'

function writeFrame(msg: Parameters<typeof encodeFrame>[0]): void {
  process.stdout.write(encodeFrame(msg))
}

const hookClient = new HookRpcClient(request => writeFrame(request))

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
  const runtime = createWorkerRuntimeFactory(() => ({ ...deps, config: loadConfig({ cwd: deps.cwd }) }))
  return new DelegationCoordinator({
    runtimeSubmission: deps.runtimeSubmission,
    baseToolRegistry: registry,
    sessionId: deps.rootSessionId,
    modelCards: buildModelCards(deps.provider),
    maxWorkers: resolveMaxWorkers(config),
    providers: config.provider.providers,
    runtimeFactory: runtime.runtimeFactory,
    selectModel: runtime.selectModel,
    allowAutomaticModelRotation: () => loadConfig({ cwd: deps.cwd }).workers.defaultStrategy === 'auto',
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

  const authChannel = createWorkerAuthChannel(writeFrame, abortController.signal)
  const stdin = createInterface({ input: process.stdin })
  stdin.on('line', (line: string) => {
    for (const msg of decoder.feed(`${line}\n`)) {
      if (msg.t === 'hook-response' || msg.t === 'hook-reaped') { hookClient.receive(msg); continue }
      if (msg.t === 'auth-result' || msg.t === 'model-prepared') { authChannel.accept(msg); continue }
      if (msg.t === 'pro-deny') {
        void acknowledgeManagedProDenial(() => writeFrame({ t: 'pro-denied', id: msg.id })).catch(error => childLog(String(error)))
      } else if (msg.t === 'init') {
        if (initPayload) { abortController.abort('duplicate init'); continue }
        initPayload = msg.payload
        if (msg.payload.steerSeed) steerQueue.push(msg.payload.steerSeed)
        void bootAndRun(msg.payload, steerQueue, abortController, authChannel)
      } else if (msg.t === 'steer') {
        steerQueue.push(msg.text)
      } else if (msg.t === 'abort') {
        abortController.abort(msg.reason)
      }
    }
  })
  // stdin 关闭（父进程死了）而 init 未到——无事可做，退出。
  stdin.on('close', () => {
    abortController.abort('parent disconnected')
    authChannel.dispose()
    hookClient.disconnect()
    void acknowledgeManagedProDenial(() => {}).finally(() => process.exit(initPayload ? 1 : 0))
  })

  // 心跳：watchdog 在父侧以 activity/tick 任一重置——boot 期间也得跳。
  const ticker = setInterval(() => writeFrame({ t: 'tick', at: Date.now() }), CHILD_TICK_INTERVAL_MS)
  ticker.unref?.()
}

function bootAndRun(init: WorkerChildInitPayload, steerQueue: string[], abortController: AbortController, authChannel: ReturnType<typeof createWorkerAuthChannel>): Promise<void> {
  return withManagedProAuthorization(init.proAuthorization, () => withWorkspaceRoots(init.config.workspaceRoots ?? [init.config.cwd], () => bootAndRunInWorkspace(init, steerQueue, abortController, authChannel)))
}

async function bootAndRunInWorkspace(
  init: WorkerChildInitPayload,
  steerQueue: string[],
  abortController: AbortController,
  authChannel: ReturnType<typeof createWorkerAuthChannel>,
): Promise<void> {
  try {
    const cfg = init.config
    const userInstructions = parseUserInstructionsSnapshot(init.userInstructions)
    const cwd = cfg.cwd

    // 2) 运行时重建（全部从落盘 config + init 快照来，无父进程内存态）。
    const config = loadConfig({ cwd })
    const delegated = cfg.officialModels ? authChannel.connect(cfg.officialModels, cfg.officialSelections) : undefined
    const decision = cfg.runtimeDecision
    if (!decision?.rootSessionBinding) throw new Error('Missing root session binding')
    const rootSessionBinding = decision.rootSessionBinding
    const rootRuntime = delegated?.runtimes.find(runtime => runtime.providerName === rootSessionBinding.provider && runtime.modelId === rootSessionBinding.model)
    const root = resolveModelBinding(config.provider.providers, rootSessionBinding, config.network, rootRuntime?.provider)
    const { provider, apiKey, auth } = root

    const domainKnowledgeStore = new DomainKnowledgeStore(join(cwd, '.rivet', 'knowledge'))

    const deps = {
      runtimeSubmission: delegated?.submission,
      externalHookHost: cfg.hookRpc ? hookClient : undefined,
      getUserInstructions: () => workerConfig.promptEngine.getUserInstructionsForDispatch(),
      config,
      cwd,
      provider,
      apiKey,
      auth,
      currentModelId: rootSessionBinding.model,
      rootSessionBinding, rootSessionId: decision.rootSessionId,
      listActiveClaims: () => init.activeClaims,
      sessionMemoryBlock: () => init.memoryBlock,
      domainKnowledgeStore,
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

    const presentTools = cfg.order.allowedTools.filter(name => registry.has(name))
    const missing = cfg.order.allowedTools.filter(name => !registry.has(name))
    if (missing.length > 0) throw new Error(`Isolated worker tool catalog unavailable: ${missing.join(',')}`)
    const workerRegistry = filterToolRegistry(registry, presentTools)

    // 4) client/promptEngine 按 runtimeDecision 忠实重建（不重跑路由）。
    const providerKey = decision.providerKey ?? decision.providerName
    const officialRuntime = delegated?.runtimes.find(runtime => runtime.providerName === decision.providerName && runtime.modelId === decision.model)
    const actual = resolveModelBinding(config.provider.providers, { provider: providerKey, model: decision.model, keyId: decision.keyId, baseUrl: decision.baseUrl }, config.network, officialRuntime?.provider)
    const providerForDecision = actual.provider
    const modelSpec = actual.spec
    const capabilities = officialRuntime?.capabilities ?? resolveCapabilities(decision.providerName, providerForDecision.capabilities, modelSpec?.capabilities)
    const blocks = subagentPromptBlocks()
    const client = createProviderClient(providerForDecision, capabilities, {
      requestAuth: officialRuntime?.requestAuth,
      network: config.network,
      singleAttempt: true,
      credentialScope: `${providerKey}:${decision.keyId ?? 'default'}`,
      expectedPrincipal: decision.expectedPrincipal,
      apiKey: actual.apiKey,
      model: decision.model,
      reasoningEffort: undefined,
      maxTokens: decision.maxTokens,
      thinkingBudget: decision.thinkingBudget,
      auth: actual.auth,
      // 与父进程 buildWorkerRuntime 用同一公式（只取 order.id，不带 nonce）：
      // 子进程重建 client 时若落回 factory 的进程兜底，同一 work order 会在父子
      // 进程各拿一个 ID，上游会当成两段对话。
      sessionId: deriveWorkerSessionId(cfg.order.id, cfg.sessionNonce),
    })
    const promptEngine = new PromptEngine({
      model: decision.model,
      maxTokens: decision.maxTokens,
      staticCtx: { tools: applyDescriptionMode(workerRegistry.getDefinitions(), blocks.toolDescriptions), audience: 'subagent' as const },
      volatileCtx: { cwd, userInstructions, sessionMemoryBlock: init.memoryBlock, blockCaps: blocks.caps },
      // 续跑/复核/重试继承上一轮冻结快照——历史 user 消息恢复原始字节，
      // 前缀缓存只在新 user 边界断尾（缺省/坏数据引擎内降级为冷启动）。
    })

    // 5) 组装 WorkerSessionConfig（v1 降级项不注入）并执行。
    const workerConfig: WorkerSessionConfig = {
      automaticMemoryReview: providerForDecision.auth?.type !== 'tianshu-account',
      runtimeSubmission: delegated?.submission,
      workspaceRoots: cfg.workspaceRoots,
      order: cfg.order,
      client,
      promptEngine,
      toolRegistry: workerRegistry,
      cwd,
      maxTurns: cfg.maxTurns,
      contextWindow: cfg.contextWindow,
      readConcurrency: clampReadConcurrency(cfg.readConcurrency),
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
      priorFrozenSnapshot: cfg.priorFrozenSnapshot,
      priorPrefixProof: cfg.priorPrefixProof,
      continuationSource: cfg.continuationSource,
      routeReason: cfg.routeReason,
      priorUsage: cfg.priorUsage,
      sessionNonce: cfg.sessionNonce,
      policyLeaseId: cfg.policyLeaseId,
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
        officialFailure: run.officialFailure?.code,
        result: run.result,
        transcript: run.transcript,
        usage: run.usage,
        checkpoint: run.checkpoint,
        messages,
        // 冻结快照随结果上行——导出失败不毁结果（下一轮退化为冷启动，与旧行为一致）。
        prefixProof: run.prefixProof,
        frozenSnapshot: run.frozenSnapshot,
        turnCount: messages.length,
      },
    })
    // 等 stdout flush 再退（end 的 callback 在冲刷完成后触发）：process.exit()
    // 不等待 pipe 写缓冲，真实 session 的 result 帧（transcript + messages 可达
    // 数十 KB）会被截断，父侧只能合成 worker_crash（2026-09-10 烧机实测）。
    await acknowledgeManagedProDenial(() => writeFrame({ t: 'pro-drained' }))
    process.stdout.end(() => process.exit(0))
  } catch (err) {
    childLog(`[worker-child] boot/run failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
    writeFrame({
      t: 'result',
      run: {
        officialFailure: err instanceof OfficialError ? err.code : undefined,
        result: err instanceof ModelBindingUnavailable ? workerFailureResult(init.config.order, err) : {
          workOrderId: init.config.order.id,
          status: isLocalWorkerPolicyError(err) ? 'blocked' : 'failed',
          summary: `worker child crashed: ${err instanceof Error ? err.message : String(err)}`,
          findings: [],
          artifacts: [],
          changedFiles: [],
          risks: [],
          nextActions: [],
          evidenceStatus: 'skipped',
          failureReason: isLocalWorkerPolicyError(err) ? 'policy_short_circuit' : 'worker_crash',
        },
        transcript: { text: '', thinking: '', toolUses: [], toolResults: [], repairAttempts: 0, errors: [String(err)] },
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        messages: [],
        turnCount: 0,
      },
    })
    try { await acknowledgeManagedProDenial(() => writeFrame({ t: 'pro-drained' })) } catch {}
    process.stdout.end(() => process.exit(1))
  }
}

// 入口守卫：父进程以 `--worker-child` 标志参 spawn，命中才跑（防被 import 误启）。
if (process.argv.includes('--worker-child')) {
  void runChild()
}

export { restoreHistoryMessages, describeRestore } from './history-restore.js'
export type { HistoryRestoreInfo } from './history-restore.js'
export { buildDelegateSummary } from './delegate-summary.js'
import { providerHasUsableAuth, isModelSpecUsable } from './model-spec-policy.js'
export { providerHasUsableAuth, isModelSpecUsable, unconfiguredSpecMessage } from './model-spec-policy.js'
import { resolveSessionAutoDefault } from './session-auto-default.js'
import { isSessionWorkspaceMode, resolveSessionWorkspace, sessionScratchRoot } from './workspace.js'
import { captureOfficialIdentity, withCurrentOfficialIdentity, getOfficialCatalog, getOfficialGatewayOrigin } from '../auth/official-model-auth.js'
import { OfficialError, type OfficialIdentityRef } from '../models/official-contract.js'
import { createManagedAccountAuth, defaultModelRuntimeDeps, getPreparedModel, isOfficialProvider, prepareRuntimeContext, resolveProviderForModel, type ModelRuntimeDeps } from '../models/model-runtime.js'
import { buildOfficialModelRoutesFor } from './official-model-routes.js'
import { ExternalHookHost } from '../hooks/external-hook-host.js'
import { buildUpdateRestartRoutes } from './update-restart-routes.js'
import { disposeAllBrowserContexts } from './browser-contexts.js'
import { disposeSessionFilePreviews } from './file-open-routes.js'
/**
 * `rivet serve` — HTTP+SSE Runtime API entry, extracted from the legacy Ink
 * entry so it ships from the release build (`dist/main.js`). Used directly as a
 * localhost sidecar by 天枢桌面版 (desktop/).
 *
 * Guardrails: binds 127.0.0.1 only; Bearer token fail-closed; reuses the
 * existing AgentLoop / ArtifactStore — no runtime rewrite, only an API surface.
 */
import { randomUUID } from 'node:crypto'
import { join, dirname } from 'node:path'
import { existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { assertSecureBind, readServeTlsArgs, resolveLanDirect } from './serve-transport.js'
import type { ServerOptions as TlsServerOptions } from 'node:https'
import { startServer } from './index.js'
import { guardRuntimeRoutes } from './runtime-route-guard.js'
import { loadProModule, resolvePresetLabel } from '../api/pro-registry.js'
import { resolveEffortSupported } from '../api/provider.js'
import { desktopDir, desktopSessionsDir } from '../config/paths.js'
import { serverLogger } from './logger.js'
import { createRoutes, type ServerState } from './routes.js'
import { RuntimeSessionManager, type AgentFactory } from './session-manager.js'
import { resolveExecutionBackend } from './execution-backend.js'
import { buildSessionRoutes } from './session-routes.js'
import { buildMissionRoutes } from './mission-routes.js'
import { buildRemoteInfoRoutes } from './remote-info-routes.js'
import { createRemoteAccessEndpoint } from './remote-access-endpoint.js'
import { installParentWatchdog } from './parent-watchdog.js'
import { MissionStore } from './mission-store.js'
import { buildHealthRoute, createHealthSnapshot, RUNTIME_INSTANCE_ID } from './health-route.js'
import { buildAccountRoutesFor } from './account-routes.js'
import { buildProfileRoutes } from './profile-routes.js'
import { buildProfileLibraryRoutes } from './profile-library-routes.js'
import { rivetHome as profileRivetHome } from '../config/paths.js'
import { ServerEventBus } from './server-event-bus.js'
import { SseConnectionRegistry } from './sse-registry.js'
import { buildServerEventsRoute } from './server-events-route.js'
import { buildGreetingRoute } from './greeting-route.js'
import { buildSettingsIntentRoutes } from './settings-intent-route.js'
import { isAuthorizedRequest } from './auth.js'
import { recordRuntimeDiagnostic } from '../utils/runtime-diagnostics.js'
import { LoopHealthMonitor, LoopStallDetector } from './loop-health.js'
import { buildScheduleRoutes } from './schedule-routes.js'
import { buildTaskRoutes } from './task-routes.js'
import { buildConfigRoutes } from './config-routes.js'
import { buildEnvRoute } from './env-route.js'
import { buildSessionBrowserRoutes } from './session-browser.js'
import { buildBrowserRoutes, buildFileOpenRoutes } from './browser-routes.js'
import { buildClipboardRoutes } from './clipboard-routes.js'
import { buildProjectTemplatesRoutes } from './project-templates-routes.js'
import { registeredWorkspaces } from './workspace-guard.js'
import { buildProjectDocsRoutes } from './project-docs-routes.js'
import { buildTrustRoutes } from './trust-api.js'
import { buildCacheRoutes } from './cache-routes.js'
import { buildStorageAuditRoutes } from './storage-audit-routes.js'
import { buildTokenLedgerRoutes } from './token-ledger-routes.js'
import { createAccountLedgerService } from '../token-ledger/account-service.js'
import { buildSpeechRoutes, createSpeechEngineFromEnv, type SpeechEngine } from './speech-routes.js'
import { CronScheduler, setActiveScheduler, setScheduleWriteGuard, setUnattendedAutomationGate } from './cron-scheduler.js'
export { installParentWatchdog, probeParentAlive, maxMissesFromGraceEnv, type ParentWatchdogOptions } from './parent-watchdog.js'
import { writeServerInfo, clearServerInfo, enableJsonModeStdoutPurity, attachOrExit, printSpawnedHandshake, type ServerInfo } from './server-info.js'
import { defaultLanHosts, isLoopbackBind, parseHostsAllow } from './host-policy.js'
import { ensurePrivateDirectoryForStartup } from '../platform/private-path.js'
import { setShutdownHandler } from './shutdown-registry.js'
import { CronWiring } from './cron-wiring.js'
import { buildMcpRoutes } from './mcp-api.js'
import { buildPluginRoutes } from './plugin-api.js'
import { pluginHooksSnapshot, pluginToolsWarmup, warmPluginToolsCache } from './plugin-session-cache.js'
import {
  PLUGIN_WARM_WAIT_CAP_MS,
  createServeTimingLogger,
  formatServeStartExtra,
  isServeTimingEnabled,
  resolveServeWarmDelayMs,
  scheduleDeferredWarmup,
  type DeferredWarmup,
} from './serve-timing.js'
import { CronLock } from './cron-lock.js'
import { TaskRegistry } from './task-registry.js'
import { JsonTaskStore } from './task-store.js'
import { SessionRuntimePool } from './session-runtime-pool.js'
import { loadConfig, getGreetingConfig } from '../config/manager.js'
import { isRuntimeLeanAspect, resolveSessionPoolOptions } from '../config/runtime-lean.js'
import { isProFeatureEnabled } from '../config/pro-license.js'
import { setTargetConventions, applyConfiguredGitBashPath, prewarmShellProbes } from '../platform.js'
import { prewarmResolvedEnv } from '../tools/resolved-env.js'
import { resolveApiKey } from '../api/factory.js'
import { findModelInKey, findModelOwner, resolveModelRef } from '../config/provider-keys.js'
import { contractModels } from '../config/contract-models.js'
import { createAuthProvider } from '../auth/registry.js'
import type { AuthProvider } from '../auth/types.js'
import { buildOpenFileRoute } from './open-file-route.js'
import { installStallObserver } from '../agent/stall-observer.js'
import { SessionRegistry } from '../agent/session-registry.js'
import { StoreLock, isStoreLockAcquired, type StoreLockState } from './store-lock.js'
import { runPhantomResumeMigration, PHANTOM_RESUME_MIGRATION_VERSION } from './phantom-resume-migration.js'
import { ProviderHealthTracker } from '../agent/provider-health.js'
import type { Config, ProviderConfig, ModelConfig } from '../config/schema.js'
import { FileSessionPersistence } from './session-persistence.js'
import { RunLedger } from './run-ledger.js'
import { RecoveryJournal } from './recovery-journal.js'
import type { SharedRuntime } from './serve-agent.js'
import { getLoadedServeAgentModule, loadServeAgent } from './serve-agent-loader.js'
export { _resetServeAgentForTests, isServeAgentLoadStarted, loadServeAgent } from './serve-agent-loader.js'
export interface ServeContext {
  config: Config
  provider: ProviderConfig
  model: ModelConfig
  apiKey: string
  auth?: AuthProvider
  /** true when the default provider has a usable API key (inline or env). */
  configured: boolean
}
/**
 * Resolve provider/model/auth/apiKey once at server start (refreshed in place by refreshServeContext when Settings routes persist provider/key changes). On first launch
 * the user may have no API key configured yet — instead of crashing (which
 * blocks the desktop settings UI from ever being reached), we return a
 * degraded context with apiKey='' and configured=false. The server starts,
 * /config routes accept setup requests, and session creation re-resolves
 * the key from disk at runtime.
 */
export function resolveServeContext(loader: () => Config = loadConfig): ServeContext {
  const config = loader()
  setTargetConventions(config.editor.platform, config.editor.eol)
  applyConfiguredGitBashPath(config.env.gitBashPath)
  const provider = config.provider.providers[config.provider.default]
  if (!provider) {
    throw new Error(`Provider "${config.provider.default}" not configured. Run 'rivet config setup' first.`)
  }
  let auth: AuthProvider | undefined
  let apiKey = ''
  let configured = true
  if (provider.auth?.type === 'oauth' || provider.auth?.type === 'tianshu-account') {
    try {
      auth = createAuthProvider(provider.auth, process.env, provider.apiKey, { ...config.network, proxy: provider.proxy ?? config.network.proxy })
      if (!auth.isAuthenticated()) configured = false
    } catch {
      configured = false
    }
  } else {
    try {
      apiKey = resolveApiKey(provider)
    } catch {
      // First launch / no env var set — degrade gracefully so the server
      // stays alive and /config routes can receive the key setup.
      // NOTE (crash-restart resilience): a respawned sidecar re-reads config
      // from disk, so an INLINE `apiKey` survives a restart, but an `apiKeyEnv`
      // key only survives if the shell re-injects that env var into the new
      // process. When it doesn't, we land here with configured=false and every
      // session run would 401 — isModelSpecUsable()/unconfiguredSpecMessage()
      // turn that into a legible error instead of an opaque upstream 401.
      configured = false
      console.error(`[serve] No API key configured for provider "${provider.name}". Server started in setup mode — configure via desktop Settings or 'rivet config setup'.`)
    }
  }
  // When the default provider has no models, fall back to the first
  // available model across all providers (or a minimal placeholder) so
  // the UI can still enumerate models in the setup flow.
  // 多 key：模型取自 keys 池派生（contractModels）——顶层 models 是迁移时的快照，
  // 直接读它可能取到已删除的模型或漏掉 key 池里的模型。
  const model = contractModels(provider)[0]
    ?? Object.values(config.provider.providers)
      .flatMap(p => contractModels(p))[0]
    ?? { id: 'unknown', maxTokens: 4096, contextWindow: 128_000 }
  return { config, provider, model, apiKey, auth, configured }
}
/**
 * Settings 变更后的启动快照原地刷新（「替换 key 不生效」与「env 压新 inline key」
 * 的根治）：重新 resolveServeContext() 并**原地替换** ctx 各字段——createAgent /
 * listModels / specReload / resolveModelSpecWithReload 等闭包持有的是同一个 ctx
 * 引用，原地替换对全部读取方即刻可见（快照命中路径从此拿到新物化 key——
 * loadConfig 把 keyRef 物化为 provider.apiKey，resolveModelSpec 最先检查它，
 * inline 由此重新压过 env）。
 *
 * fail-open：变更已落盘，刷新失败（如默认 provider 半配置态）只记 warn——
 * miss 路径的 reload（resolveModelSpecWithReload）与新会话 resolveInitialSpec
 * 仍会读到新盘。已知边界：已烘焙 client 的存活 agent 不换 key（重建才拿新值）。
 */
export function refreshServeContext(ctx: ServeContext): void {
  try {
    const fresh = resolveServeContext()
    ctx.config = fresh.config
    ctx.provider = fresh.provider
    ctx.model = fresh.model
    ctx.apiKey = fresh.apiKey
    ctx.auth = fresh.auth
    ctx.configured = fresh.configured
  } catch (err) {
    serverLogger.warn(`[serve] refreshServeContext: keeping previous snapshot (miss-path reload still reads disk): ${err instanceof Error ? err.message : String(err)}`)
  }
}
export interface ResolvedModelSpec {
  provider: ProviderConfig
  providerName?: string
  apiKey: string
  auth?: AuthProvider
  model: { id: string; maxTokens: number; contextWindow: number; reasoningEffort?: ModelConfig['reasoningEffort']; capabilities?: ModelConfig['capabilities'] }
  /** 命中模型所属的 key（多 key provider）；未迁移 provider 无此字段。 */
  keyId?: string
}
/**
 * Resolve a model id (or alias) to its provider/apiKey/auth/model spec, scanning
 * every configured provider. Returns null when the id is unknown or the target
 * provider has no usable API key (kept fail-closed, like switchAgentRuntime).
 *
 * `provider:modelId`（或 `provider:alias`）显式消歧——deepseek 与 deepseek-spark
 * 共享同一 wire 型号名时，裸 id 仍优先扫到的第一个节点（兼容旧会话），带前缀
 * 则只查该 provider。`provider:keyId:modelId` 钉到具体 key。
 */
export function resolveModelSpec(ctx: ServeContext, modelId: string): ResolvedModelSpec | null {
  const { provider: pinned } = resolveModelRef(ctx.config.provider.providers, modelId)
  for (const name of Object.keys(ctx.config.provider.providers)) {
    if (pinned && name !== pinned) continue
    const selected = resolveProviderForModel(ctx, modelId, name)
    if (!selected || 'error' in selected || (selected.auth && !selected.auth.isAuthenticated())) continue
    return { provider: selected.provider, providerName: selected.providerName, apiKey: selected.apiKey, auth: selected.auth, model: selected.model, keyId: selected.keyId }
  }
  return null
}
/**
 * Classify why a model spec resolution missed — for actionable error messages
 * (2026-09-06 自定义模型「切不了」排查配套）。只看模型存在性（不碰 keychain/env，
 * resolveModelSpec 已失败的事实说明 key 侧不通）：模型在任何 provider 上都找不到
 * → 'unknown-model'；找得到但解析仍失败 → 'key-missing'（该 provider 无可用 key）。
 */
export function classifyModelSpecMiss(config: Config, modelId: string): 'unknown-model' | 'key-missing' {
  // 与 resolveModelSpec 同一套消歧义 —— 否则 `provider:keyId:modelId` 与
  // 「模型 id 自带冒号」两种形态的未命中会被误判成 unknown-model。
  const { provider: pinnedProvider, keyId: pinnedKeyId, modelRef } =
    resolveModelRef(config.provider.providers, modelId)
  if (!modelRef) return 'unknown-model'
  const entries = pinnedProvider
    ? (config.provider.providers[pinnedProvider] ? [[pinnedProvider, config.provider.providers[pinnedProvider]] as const] : [])
    : Object.entries(config.provider.providers)
  for (const [, prov] of entries) {
    // 与 resolveModelSpec 同一套归属查找（含 keyId 前缀），否则
    // `provider:keyId:modelId` 的未命中会被误判成 unknown-model。
    const owner = pinnedKeyId ? findModelInKey(prov, pinnedKeyId, modelRef) : findModelOwner(prov, modelRef)
    if (owner) return 'key-missing'
  }
  return 'unknown-model'
}
/**
 * Resolve a model id against the startup `ctx`, falling back to a fresh on-disk
 * read when the snapshot can't resolve it. On first install the server starts in
 * setup mode (configured=false, no API key) and the user configures the key via
 * /config afterwards — the startup snapshot then can't find a key for the target
 * model, which would make switchModel 409 until restart. Re-reading config on the
 * miss path (mirrors resolveInitialSpec) also covers providers added/edited via
 * Settings after startup. Cheap: the fresh read only happens on the rare miss.
 */
export function resolveModelSpecWithReload(
  ctx: ServeContext,
  modelId: string,
  reload: () => ServeContext = resolveServeContext,
): ResolvedModelSpec | null {
  const fromSnapshot = resolveModelSpec(ctx, modelId)
  if (fromSnapshot) return fromSnapshot
  try {
    return resolveModelSpec(reload(), modelId)
  } catch {
    return null
  }
}

/**
 * Picker 可用性判定（2026-09-08 ChatGPT 对齐）：模型下拉只列「切得了」的模型。
 * 口径与欢迎页 buildWelcomeModelOptions（keyStatus 非 none 或 keyless）及
 * resolveModelSpec 的可用分支（oauth isAuthenticated / key 解析链）同源：
 * - keyless 本地端点（ollama / 未配密钥材料的 loopback 自定义）恒可用；
 * - oauth 凭据以 isAuthenticated() 判（与 resolveModelSpec B5 分支对称）；
 * - 其余按 resolveApiKey 全链（keyRef/inline/apiKeyEnv/默认 `<NAME>_API_KEY`）。
 * resolveModelSpec 本身不动——其 fail-closed 解析细节已测试覆盖，此 helper 只
 * 供枚举过滤，语义与其可用分支一致。
 */


/** Enumerate every selectable model across all usable providers. */
export function listAllModels(ctx: ServeContext): {
  id: string
  alias: string
  provider: string
  providerLabel: string
  contextWindow?: number
  description?: string
  keyId?: string
  keyLabel?: string

  effortSupported: boolean
  authType?: 'oauth' | 'tianshu-account'
}[] {
  const out: {
    id: string
    alias: string
    provider: string
    providerLabel: string
    contextWindow?: number
    description?: string
    keyId?: string
    keyLabel?: string
    effortSupported: boolean
    authType?: 'oauth' | 'tianshu-account'
  }[] = []
  for (const [provName, prov] of Object.entries(ctx.config.provider.providers)) {
    if (!providerHasUsableAuth(provName, prov)) continue
    const providerLabel = resolvePresetLabel(provName) ?? provName
    if (prov.keys && prov.keys.length > 0) {
      for (const key of prov.keys) {
        for (const m of key.models) {
          out.push({
            id: m.id,
            alias: m.id,
            provider: provName,
            providerLabel,
            contextWindow: m.contextWindow,
            description: m.description,
            keyId: key.id,
            ...(key.label ? { keyLabel: key.label } : {}),
            effortSupported: modelEffortSupported(provName, prov, m),
            ...(prov.auth?.type === 'oauth' || prov.auth?.type === 'tianshu-account' ? { authType: prov.auth.type } : {}),
          })
        }
      }
      continue
    }
    for (const m of contractModels(prov)) {
      out.push({
        id: m.id,
        alias: m.id,
        provider: provName,
        providerLabel,
        contextWindow: m.contextWindow,
        description: m.description,
        effortSupported: modelEffortSupported(provName, prov, m),
            ...(prov.auth?.type === 'oauth' || prov.auth?.type === 'tianshu-account' ? { authType: prov.auth.type } : {}),
      })
    }
  }
  return out
}

/**
 * Enumerate selectable models for the picker, preferring a fresh on-disk read
 * so providers added/edited via Settings *after* startup show up without a
 * restart — the companion to resolveModelSpecWithReload (which makes the actual
 * switch resolve the freshly-configured key). The startup snapshot is only a
 * fallback for the degraded case where the fresh read throws (e.g. a missing
 * default provider mid-edit). Called on picker open — low frequency, so the
 * extra config read is negligible.
 */
export function listAllModelsWithReload(
  ctx: ServeContext,
  reload: () => ServeContext = resolveServeContext,
): ReturnType<typeof listAllModels> {
  const listing = modelListingViews.get(ctx)
  if (listing) return listAllModels(listing.context)
  if (isOfficialProvider(ctx.provider)) return listAllModels(ctx)
  try {
    return listAllModels(reload())
  } catch {
    return listAllModels(ctx)
  }
}



export function resolveManagedTargetSelection(ctx: ServeContext, modelId: string | undefined, reload: (() => ServeContext) | undefined, fallbackToDefault: boolean): { context: ServeContext; spec: ResolvedModelSpec } | null {
  let effective = ctx
  let spec = modelId ? resolveModelSpec(effective, modelId) : null
  if (reload) {
    try {
      const fresh = reload()
      if (!spec && (modelId || fresh.configured)) effective = fresh
      else effective = { ...effective, config: fresh.config }
    } catch {  }
    if (!spec && modelId) spec = resolveModelSpec(effective, modelId)
  }
  if (!spec) {
    if (modelId && !fallbackToDefault) return null
    spec = { provider: effective.provider, apiKey: effective.apiKey, auth: effective.auth, model: { id: effective.model.id, maxTokens: effective.model.maxTokens, contextWindow: effective.model.contextWindow, reasoningEffort: effective.model.reasoningEffort, capabilities: effective.model.capabilities } }
  }
  const selected = { ...effective, provider: spec.provider, model: spec.model, apiKey: spec.apiKey, auth: spec.auth, configured: isModelSpecUsable(spec) }
  return { context: selected, spec }
}

function modelEffortSupported(name: string, provider: ProviderConfig, model: import('../config/schema.js').ModelConfig): boolean {
  if (!isOfficialProvider(provider)) return resolveEffortSupported(name, provider, model.capabilities)
  try {
    const prepared = getPreparedModel(provider, model.id)
    if (!prepared.capabilities.supportsThinking) return false
    return resolveEffortSupported(name, prepared.provider, prepared.model.capabilities)
  } catch { return false }
}

const officialProviderId = 'tianshu-official'

async function withOfficialProviderView(snapshot: ServeContext, identity = captureOfficialIdentity(), signal?: AbortSignal, readCatalog: ModelRuntimeDeps['getCatalog'] = getOfficialCatalog): Promise<ServeContext> {
  const existing = snapshot.config.provider.providers[officialProviderId]
  if (!identity || existing && !isOfficialProvider(existing)) return snapshot
  const origin = getOfficialGatewayOrigin()
  const catalog = await readCatalog(identity, 'agent', signal)
  signal?.throwIfAborted()
  const models = catalog.models.flatMap(model => {
    const bindings = model.bindings.length === 1 ? model.bindings : model.bindings.filter(binding => binding.stream)
    if (bindings.length !== 1) return []
    return [{ id: model.id, description: model.displayName, contextWindow: model.contextWindow!, maxTokens: model.maxOutputTokens!, managed: { bindingId: bindings[0]!.id }, supportsVision: model.capabilities?.vision === true }]
  })
  const provider: ProviderConfig = { name: officialProviderId, auth: { type: 'tianshu-account' }, baseUrl: origin, protocol: 'openai', capabilities: { cacheControl: false, stripParams: [], toolJsonBug: false, prefixCache: 'none', prefixCompletion: false }, models, thinking: 'enabled', maxTokens: 4096, unsupported: [] }
  return { ...snapshot, config: { ...snapshot.config, provider: { ...snapshot.config.provider, providers: { ...snapshot.config.provider.providers, [officialProviderId]: provider } } } }
}

const modelListingViews = new WeakMap<ServeContext, { generation: number; context: ServeContext; modelRefs: readonly string[] }>()

export async function prepareOfficialServeContext(context: ServeContext, modelRef: string, identity: OfficialIdentityRef, signal: AbortSignal | undefined, deps: ModelRuntimeDeps): Promise<ServeContext & { autoDefaultModelRefs: readonly string[] }> {
  let preparing = true
  let catalogJob: ReturnType<ModelRuntimeDeps['getCatalog']> | undefined
  const ownedDeps: ModelRuntimeDeps = { ...deps, captureIdentity: () => identity, async getCatalog(requestedIdentity, purpose, requestSignal) {
    requestSignal?.throwIfAborted()
    if (!preparing || requestedIdentity !== identity || purpose !== 'agent') return deps.getCatalog(requestedIdentity, purpose, requestSignal)
    catalogJob ??= deps.getCatalog(identity, purpose, requestSignal)
    const catalog = await catalogJob
    requestSignal?.throwIfAborted()
    return structuredClone(catalog)
  } }
  try {
    const snapshot = await withOfficialProviderView(context, identity, signal, ownedDeps.getCatalog)
    const target = resolveProviderForModel(snapshot, modelRef)
    if (!target || 'error' in target || !isOfficialProvider(target.provider)) throw new OfficialError('invalid_request')
    const autoDefaultModelRefs = Object.entries(snapshot.config.provider.providers).flatMap(([name, provider]) => isOfficialProvider(provider) ? contractModels(provider).map(model => `${name}:${model.id}`) : [])
    const prepared = await prepareRuntimeContext({ ...snapshot, auth: createManagedAccountAuth(ownedDeps) }, modelRef, 'agent', ownedDeps, { signal })
    return { ...prepared, autoDefaultModelRefs }
  } finally { preparing = false; catalogJob = undefined }
}

export async function prepareServeModelListing(ctx: ServeContext, reload: () => ServeContext = resolveServeContext): Promise<void> {
  let snapshot = ctx
  try { snapshot = reload() } catch {  }
  let providers = { ...snapshot.config.provider.providers }
  for (const [name, provider] of Object.entries(providers)) {
    if (isOfficialProvider(provider)) providers[name] = { ...provider, models: [...contractModels(provider)], keys: undefined }
  }
  snapshot = { ...snapshot, config: { ...snapshot.config, provider: { ...snapshot.config.provider, providers } } }
  if (isOfficialProvider(snapshot.provider)) snapshot.provider = providers[snapshot.provider.name] ?? snapshot.provider
  const state = { generation: (modelListingViews.get(ctx)?.generation ?? 0) + 1, context: snapshot, modelRefs: [] as readonly string[] }
  modelListingViews.set(ctx, state)
  const identity = captureOfficialIdentity()
  try { snapshot = await withOfficialProviderView(snapshot, identity) } catch {  }
  if (modelListingViews.get(ctx) !== state) return
  providers = snapshot.config.provider.providers
  state.context = snapshot
  state.modelRefs = Object.entries(providers).flatMap(([name, provider]) => isOfficialProvider(provider) ? contractModels(provider).map(model => `${name}:${model.id}`) : [])
  if (!Object.values(providers).some(isOfficialProvider)) return
  const auth = createManagedAccountAuth()
  if (!auth.isAuthenticated()) return
  for (const [name, provider] of Object.entries(providers)) {
    if (!isOfficialProvider(provider)) continue
    for (const model of contractModels(provider)) {
      try {
        const prepared = await prepareRuntimeContext({ ...snapshot, auth }, `${name}:${model.id}`, 'probe')
        if (modelListingViews.get(ctx) === state && identity) withCurrentOfficialIdentity(identity, () => { state.context = { ...snapshot, config: prepared.config } })
        return
      } catch (error) {
        if (modelListingViews.get(ctx) !== state) return
        if (error instanceof OfficialError && error.code === 'account_changed') throw error
        if (!(error instanceof OfficialError) || !['model_unavailable', 'capability_unknown'].includes(error.code)) return
      }
    }
  }
}

export interface RunServeOptions {
  tls?: TlsServerOptions
  port?: number
  /** 监听地址。默认 127.0.0.1（RIVET_SERVE_HOST / --host 覆盖）。 */
  host?: string
  /** Host header allowlist（不带端口）。默认读 RIVET_SERVE_HOSTS_ALLOW。 */
  allowedHosts?: string[]
  /** LAN Direct 显式 opt-in（设计 §5.3 Wave 1）：非回环无 TLS 的局域网明文监听；
   *  缺省读 env `RIVET_SERVE_LAN_DIRECT`（仅 `'1'`），未 opt-in 时行为与历史一致。 */
  lanDirect?: boolean
  /** P2 — /mobile 静态挂载目录。默认读 RIVET_MOBILE_DIR。未配则不暴露 /mobile。 */
  mobileDir?: string
  token?: string
  /** Override the serve context (tests inject a fake). */
  context?: ServeContext
  /** Directory for durable desktop session storage. Defaults to ~/.rivet/desktop/sessions. */
  sessionDir?: string
  /** Disable persistence (tests / ephemeral). */
  ephemeral?: boolean
  /**
   * 运行期丢锁回调（会话库锁被接管/删除）。runServe 内部已先完成收口——撤销写资格
   * （ownsSessionStore 翻 false → 写请求 503、readiness failed=data-dir-lock-lost）、
   * 停调度、abort 活动会话——随后调本回调交宿主处置。CLI 入口（serveCommand）借此
   * 立即非零退出；程序化宿主自定收口，runServe 绝不擅自 process.exit。
   */
  onLockLost?: (state: StoreLockState) => void
  /**
   * R1 — shared cross-session registry (file claims / OwnershipGuard / conflict
   * blocking). Tests inject a pre-built one; production creates it async at boot.
   * When absent, concurrency features stay dormant and behavior is unchanged.
   */
  sessionRegistry?: SessionRegistry
}

export interface RunningServer {
  port: number
  /** 本实例坐标（内存真源，ephemeral 模式下也始终存在）——--json 握手输出用。 */
  serverInfo: ServerInfo
  close: (callback?: () => void) => void
  sessions: RuntimeSessionManager
  scheduler?: CronScheduler
  /** Shared runtime for the exit handler to access mcpManager. */
  shared: SharedRuntime
}

/** Default HTTP port for `rivet serve` (--port overrides). */
const DEFAULT_PORT = 3100

/**
 * 本进程是否为「拿不到会话库独占锁而降级运行」的实例（runServe 每次启动设置）。
 * 降级实例不写 sidecar-exit.json：面包屑是给**会话库属主**的退出做归因用的
 * （见 writeExitBreadcrumb），次级实例的退出写进去会把属主的「崩溃 vs 主动退出」
 * 判据污染成别人的时间线（写入侧是『最后写的赢』，pid/buildId 会张冠李戴）。
 */
let storeLockDegraded = false

/**
 * Start the runtime API server. Returns the bound port, a close() that aborts
 * all in-flight work, and the RuntimeSessionManager backing the multi-session
 * API. Throws if no token is available (fail-closed).
 */
export async function runServe(opts: RunServeOptions = {}): Promise<RunningServer> {
  // 启动阶段时间线（默认进 sidecar 日志；RIVET_SERVE_TIMING=0 关，见 serve-timing.ts）。
  const timing = createServeTimingLogger(isServeTimingEnabled(opts))
  timing.mark('start', formatServeStartExtra(process.pid, performance.now(), performance.nodeTiming?.bootstrapComplete))
  // Pro 扩展点加载（spec 3b）：桌面 sidecar 生产路径。必须在 config-routes
  // 首次查询之前完成——否则 spark 节点不可见（合并视图查不到注册项）。
  await loadProModule()
  timing.mark('pro-module')

  const apiToken = (opts.token ?? process.env.RIVET_SERVER_TOKEN)?.trim()
  if (!apiToken) {
    throw new Error('RIVET_SERVER_TOKEN is required for rivet serve')
  }
  // #450: 启动期加固失败不再一票否决 serve——win32 上 PowerShell DACL 超时/失败
  // 降级为 warn 并继续 listen（POSIX chmod 失败仍致命；symlink 拒绝全平台致命）。
  if (!opts.ephemeral) ensurePrivateDirectoryForStartup(profileRivetHome(), process.platform, (message) => {
    serverLogger.warn(`[serve] ${message}`)
  })
  const port = opts.port ?? DEFAULT_PORT
  // 监听地址：显式 opts（serveCommand --host / 测试注入）> env（桌面壳经父 env 继承
  // RIVET_SERVE_HOST 可达，零 Rust 改动）> 默认 127.0.0.1（行为不变）。
  const host = (opts.host ?? process.env.RIVET_SERVE_HOST)?.trim() || '127.0.0.1'
  // LAN Direct opt-in：显式 opts > env；只解析一次——assertSecureBind 与
  // allowlist 收紧必须同一判定，否则「放行明文但未收紧」错配。
  const lanDirect = resolveLanDirect(opts.lanDirect)
  const allowedHosts = opts.allowedHosts ?? parseHostsAllow(process.env.RIVET_SERVE_HOSTS_ALLOW) ?? (!isLoopbackBind(host) ? defaultLanHosts(host, { lanDirect }) : undefined)
  assertSecureBind(host, opts.tls, { lanDirect })
  // /mobile 静态目录：显式 opts（--mobile-dir / 测试注入）> env（桌面壳注入）> 未配置。
  const mobileDir = (opts.mobileDir ?? process.env.RIVET_MOBILE_DIR)?.trim() || undefined
  const ctx = opts.context ?? resolveServeContext()
  // Hot credential pickup: sessions created after a Settings edit must resolve
  // the CURRENT on-disk key, not the startup snapshot's. Only wired when the
  // context came from disk — an injected context (tests) stays deterministic.
  const specReload = opts.context ? undefined : resolveServeContext
  // 插件暖场（2026-09-12 sidecar 插件装配补齐）：跑一次 initializePlugins 进暖场
  // 缓存——buildSessionStores 同步合入快照（serve-agent.ts），Node 模块缓存随后使
  // 命中，每会话零等待。桌面性能阶段 3（2026-09-13）：点火挪到 listen 之后延迟
  // （见下方 scheduleDeferredWarmup），首个会话的 createAgent 会提前拉响并做有界等待。
  let warmup: DeferredWarmup | null = null
  const startedAt = Date.now()
  // 阶段 4 全局推送通道：会话 / 任务变化的失效提示总线，经 GET /events 推给桌面端
  // （替代 /sessions 2s、/tasks 5s 的固定轮询；客户端保留慢速兜底）。
  const serverEvents = new ServerEventBus()

  // agent-13：SSE 活动连接注册表。三条长连（/events、/sessions/:id/stream、
  // /prompt）只挂 res.on('close') 清理——服务端关停时不会触达，必须由 close
  // 链 closeAll() 主动清场（见 finish）。没有它时桌面客户端连着 → SIGINT 后
  // server.close(cb) 永不回调，进程只能 kill -9。
  const sseRegistry = new SseConnectionRegistry()

  // R1 — one shared SessionRegistry for the whole sidecar. Created async (the
  // SQLite backend dynamic-imports better-sqlite3); sessions are created
  // seconds later by user interaction, by which time it's resolved. Tests pass a
  // pre-built registry. Ephemeral mode (tests) skips it → behavior unchanged.
  let initializationError: string | undefined

  // P0-1 — 会话库单写者独占锁（store-lock.ts）。必须早于下面一切会写 desktopDir()
  // 的装配：注册表、持久化、恢复台账、run 台账、定时任务、退出面包屑。
  // 为什么：一旦构造 FileSessionPersistence，RuntimeSessionManager 的构造就会
  // rehydrate()，把别的 sidecar 正在跑的会话标成『已中断』并写入 seq 高出
  // CRASH_RECOVERY_SEQ_GAP 的假标记——前端 `ev.seq <= state.lastSeq` 守卫随后丢掉
  // 这之后全部真实输出（『假续跑』）。拿不到锁的进程**一个字节都不许碰会话库**。
  // acquire 默认 5s 重试窗口，覆盖监管器『杀掉旧进程 → 拉起新进程』的交接窗。
  // opts.ephemeral（测试）跳过：与注册表/持久化同哲学，不得创建/触碰真实锁文件。
  //
  // 运行期丢锁（P0-1b）：锁被接管/删除 → onLockLost 同步收口——撤销写资格
  // （ownsSessionStore 翻 false，route guard 对所有写请求立即 503；initializationError
  // 置 data-dir-lock-lost，readiness 翻 failed 供桌面壳归因）、abort 活动会话、
  // 停调度（CronLock 丢锁停 scheduler 的同范式），最后交宿主回调（CLI 据此 exit 2）。
  /** 本进程是否有资格写会话库；ephemeral（无锁）视为有资格——行为不变。
   *  丢锁后由下面的 onLockLost 翻回 false（route guard / persistence 闸门实时读它）。 */
  let ownsSessionStore = true
  const storeLock = opts.ephemeral ? undefined : new StoreLock({
    onLockLost: (lost) => {
      if (!ownsSessionStore) return
      ownsSessionStore = false
      storeLockDegraded = true
      initializationError = 'data-dir-lock-lost'
      serverLogger.error('[serve] 会话库锁已丢失（被接管或删除）——撤销会话库写资格、停调度、停活动会话', {
        holder: lost.status === 'contended' ? lost.holder : undefined,
      })
      // 丢锁后再产生的会话事件本就会被 persistence 闸门丢弃；abort 止住产出源。
      try { sessions.abortAll() } catch { /* best-effort */ }
      try { void wiring?.stop() } catch { /* best-effort */ }
      storeLock?.release()
      try { opts.onLockLost?.(lost) } catch { /* 宿主回调异常不得阻断内部收口 */ }
    },
  })
  if (storeLock) {
    const lockState = await storeLock.acquire()
    ownsSessionStore = isStoreLockAcquired(lockState)
    storeLockDegraded = !ownsSessionStore
    if (!ownsSessionStore) {
      // 降级运行：createAgent 见 initializationError 即拒绝建会话（下文 gateway 工厂）。
      initializationError = lockState.status === 'error' ? 'data-dir-lock-error' : 'data-dir-locked'
      const holder = lockState.status === 'contended' ? lockState.holder : undefined
      serverLogger.error(
        `[serve] ${lockState.status === 'error' ? '会话库锁创建失败' : '会话库已被别的进程独占'}（${lockState.status}`
        + `${lockState.status === 'contended' ? `: ${lockState.reason}` : ''}）——降级运行，不触碰会话库`,
        { holder, reason: lockState.status === 'error' ? lockState.reason : undefined },
      )
    } else if (lockState.status === 'stale_recovered') {
      serverLogger.warn('[serve] 接管陈旧会话库锁（前持有者已退出 / 心跳过期）', { previousOwner: lockState.previousOwner })
    }
  } else {
    storeLockDegraded = false
  }

  let sessionRegistry: SessionRegistry | undefined = opts.sessionRegistry
  if (!sessionRegistry && !opts.ephemeral && ownsSessionStore) {
    // 启动收割崩溃会话的幽灵独占锁（收编公开仓 PR #110）：硬杀 sidecar 留下的死行会让 R2 写前守卫永久拒写。
    void SessionRegistry.createWithReap(desktopDir(), (c) => console.error(`[serve] ↺ 已清理 ${c.length} 个异常退出会话的锁定`))
      .then((r) => { sessionRegistry = r })
      .catch((err) => {
        // Registry init failed (e.g. better-sqlite3 native build missing).
        // Concurrency features stay dormant; surface the cause instead of
        // silently swallowing it so the failure is diagnosable in logs.
        initializationError = 'session-registry-unavailable'
        console.error('[serve] SessionRegistry unavailable:', (err as Error)?.message ?? err)
      })
  }

  // N1: durable session storage so sessions survive sidecar restarts.
  const lean = isRuntimeLeanAspect('pool', ctx.config.runtime?.lean)
  const sessionPool = resolveSessionPoolOptions(ctx.config.runtime, lean)
  const persistence = opts.ephemeral || !ownsSessionStore
    ? undefined
    : new FileSessionPersistence(
        opts.sessionDir ?? desktopSessionsDir(),
        {
          maxEventsDiskBytes: sessionPool.maxEventsDiskBytes,
          // 丢锁即撤销写资格：所有写路径（延迟刷新/flush/修复性重建/删除）提交前
          // 实时检查这个谓词，丢锁后 fail-closed 丢弃或抛错。
          canWrite: () => ownsSessionStore,
        },
      )

  // Wave J: sidecar 级 SharedRuntime——providerHealth 跨 session 共享让
  // health 统计累积；domainStores 按 cwd 缓存避免重复磁盘 load + 跨 session
  // lessons 可见。runServe 进程级单例，传给每个 buildManagedAgent。
  // Wave F: sameCwdRunningCount 是 late-bound——sessions 创建后才能引用，
  // 先置 null，sessions 就绪后回写。getSameCwdRunningSessions getter 对
  // sessions 未就绪的窗口期会回退 0（安全）。
  const externalHookHost = new ExternalHookHost()
  const sharedRuntime: SharedRuntime = {
    externalHookHost,
    providerHealth: new ProviderHealthTracker(),
    domainStores: new Map(),
    meridianIndexers: new Map(),
    lspManagers: new Map(),
    sameCwdRunningCount: null,
    mcpManager: null,
    sessions: null,
  }

  // Initialize MCP manager asynchronously — dynamic import keeps the MCP SDK
  // out of the cold /health import graph. Fire-and-forget so listen isn't blocked.
  // Use live loadConfig().mcp (not the startup ctx snapshot) so servers added
  // while this IIFE is still loading are not lost; reconcileFromConfig after
  // initialize() picks up anything POSTed before mgr was assigned.
  void (async () => {
    try {
      const { McpManager } = await import('../mcp/manager.js')
      const liveMcp = loadConfig().mcp
      // onToolsChanged：自动重连恢复后把工具面推回会话。宿主侧是主动推送语义
      // （injectMcpTools 只覆盖已有 live agent 的会话，新建 agent 才会自己拉），
      // 不接这条线，重连就只剩「状态变绿、工具仍不可用」（issue #148）。
      const mgr = new McpManager(liveMcp, {
        onToolsChanged: (tools) => sharedRuntime.sessions?.injectMcpTools(tools),
      })
      await mgr.initialize()
      // Assign mgr FIRST so POST /mcp/servers can route to connectAndDiscover
      // immediately. Otherwise a POST between reconcile arg-eval and assignment
      // sees mgr===null → persist-only → never auto-connects.
      sharedRuntime.mcpManager = mgr
      // Reconcile: pick up any servers persisted while this IIFE was loading
      // (POST before mgr was assigned). Since mgr is now live, future POSTs
      // will call connectAndDiscover directly — no second reconcile needed.
      const reconciled = await mgr.reconcileFromConfig(loadConfig().mcp)
      if (reconciled.length > 0) {
        sharedRuntime.sessions?.injectMcpTools(reconciled)
      } else if (mgr.getAllTools().length > 0) {
        // Sessions created during init may have missed the first tool snapshot.
        sharedRuntime.sessions?.injectMcpTools(mgr.getAllTools())
      }
      const mcpStates = mgr.getStates()
      const connected = mcpStates.filter(s => s.status === 'connected').length
      const failed = mcpStates.filter(s => s.status === 'error' || s.status === 'degraded')
      timing.mark('mcp', `connected=${connected} failed=${failed.length} tools=${mgr.getAllTools().length}`)
      if (failed.length > 0) {
        // Fail loud: silently missing MCP tools is worse than a noisy boot.
        serverLogger.error(`MCP: ${connected} connected, ${mgr.getAllTools().length} tools, ${failed.length} failed:`, {
          failedServers: failed.map(s => `${s.serverId}${s.error ? ` — ${s.error}` : ''}${s.errorHint ? ` (${s.errorHint})` : ''}`),
        })
      } else {
        serverLogger.warn(`MCP: ${connected} servers connected, ${mgr.getAllTools().length} tools`)
      }
    } catch (err) {
      timing.mark('mcp', 'failed=init')
      serverLogger.error('MCP initialization failed:', { error: (err as Error)?.message ?? String(err) })
    }
  })()

  // Multi-session manager (M0.5): each session is an independent AgentLoop,
  // adapted to the manager's ManagedAgent surface (run/abort + artifacts). The
  // manager's session id is threaded into buildAgentLoop so the agent's stores
  // align with the session. Agent assembly is dynamically imported (Wave C) so
  // ... (goal handles resolver captured on first load — see createAgent below).
  let goalHandlesResolve: typeof import('./serve-agent.js').resolveGoalHandles | null = null
  let reviewGateResolve: typeof import('./serve-agent.js').resolveReviewGateRef | null = null
  let storesForgetter: typeof import('./serve-agent.js').forgetSessionStores | null = null
  // P1 任务身份化 — Mission 存储：session-manager（创建/隐式关联）与
  // /missions 路由共享同一实例（内存 cache 一致）。
  const missionStore = new MissionStore()
  // 恢复台账先建出来：网关工厂恢复时要用它取检查点的转录水位做对齐观测（PLAN §4
  // 第 2 步，只观测），随后同一个实例交给 RuntimeSessionManager——不能建两份，
  // 否则工厂读到的检查点与 manager 写入的不是同一个目录。
  // 降级实例（拿不到会话库锁）不建台账——desktopDir() 下一个字节都不许写。
  const recoveryJournal = ownsSessionStore
    ? new RecoveryJournal(join(desktopDir(), 'recovery-journal'))
    : undefined
  // 执行后端选择：默认进程内执行；RIVET_EXECUTION_BACKEND=isolated 时走闭源
  // 进程隔离适配器（缺产物时回退进程内，绝不因闭源目录缺席而启动失败）。
  const officialSessionContexts = new Map<string, ServeContext>()
  const restoredSessions = new Set<string>()
  const knownSessions = new Set<string>()
  const buildGatewayAgent: AgentFactory = async (cwd, sessionId, approvalMode, modelId, allowedTools, signal) => {
    const assemblyStartedAt = performance.now()
    const markAssemblyPhase = (phase: string) => {
      if (process.env.RIVET_SERVE_TIMING === '1') timing.mark(phase, `elapsedMs=${Math.round(performance.now() - assemblyStartedAt)} wallMs=${Date.now()}`)
    }
    timing.mark('model-agent-start')
    const capturedContext = sessionId ? officialSessionContexts.get(sessionId) : undefined
    if (sessionId && restoredSessions.has(sessionId) && !capturedContext && modelId?.startsWith(`${officialProviderId}:`)) throw new OfficialError('account_changed')
    const initialSelection = resolveManagedTargetSelection(capturedContext ?? ctx, modelId, specReload, true)!
    if (sessionId && restoredSessions.has(sessionId) && !capturedContext && isOfficialProvider(initialSelection.spec.provider)) throw new OfficialError('account_changed')
    // 首个会话可能早于延迟预热到点——立刻拉响（幂等），并给插件快照一个有界
    // 等待窗：agent chunk import 本身就要几百 ms，插件扫描通常在其内落定；
    // 超窗则按既有语义无插件装配，绝不让一个卡住的插件 import 拖死会话创建。
    warmup?.fireNow()
    const [agentMod] = await Promise.all([
      loadServeAgent(),
      Promise.race([
        pluginToolsWarmup(),
        new Promise<void>((resolve) => { setTimeout(resolve, PLUGIN_WARM_WAIT_CAP_MS).unref() }),
      ]),
    ])
    timing.mark('model-agent-graph-ready', `duration=${Math.round(performance.now() - assemblyStartedAt)}ms`)
    // Capture the goal-handles resolver on first load (dynamic import is
    // cached, so this runs once). Used by resolveGoalHandles below.
    if (!goalHandlesResolve && typeof agentMod.resolveGoalHandles === 'function') {
      goalHandlesResolve = agentMod.resolveGoalHandles
    }
    if (!reviewGateResolve && typeof agentMod.resolveReviewGateRef === 'function') {
      reviewGateResolve = agentMod.resolveReviewGateRef
    }
    if (!storesForgetter && typeof agentMod.forgetSessionStores === 'function') {
      storesForgetter = agentMod.forgetSessionStores
    }
    if (initializationError) throw new Error(initializationError)
    signal?.throwIfAborted()
    // PLAN §4 恢复设计第 2 步（只观测）：把检查点的转录水位带进恢复路径，
    // 由 restoreHistoryMessages 记录「检查点水位 vs 实际恢复条数」的对齐情况。
    markAssemblyPhase('model-recovery-load-start')
    const expectedTranscriptWatermark = sessionId
      ? (await recoveryJournal?.load(sessionId))?.transcriptWatermark
      : undefined
    markAssemblyPhase('model-recovery-load-ready')
    markAssemblyPhase('model-managed-build-start')
    const managed = await agentMod.buildManagedAgentAsync([
      capturedContext ?? ctx, cwd ?? process.cwd(),
      sessionId ?? randomUUID(),
      sessionRegistry,
      approvalMode,
      sharedRuntime,
      specReload,
      modelId,
      allowedTools,
    ], signal, expectedTranscriptWatermark, initialSelection)
    markAssemblyPhase('model-managed-build-ready')
    timing.mark('model-agent-ready', `duration=${Math.round(performance.now() - assemblyStartedAt)}ms`)
    return managed
  }
  const executionBackend = await resolveExecutionBackend(buildGatewayAgent, { externalHookHost,
    hookBinding: (cwd, sessionId) => ({ cwd, sessionId, getPluginHooks: pluginHooksSnapshot,
      emitResult: (results, meta) => sharedRuntime.sessions?.emitHookResult(sessionId, results, meta),
      emitCleanup: meta => sharedRuntime.sessions?.emitHookCleanup(sessionId, meta) }),
  })
  // cold /health does not pay for tools/Meridian/council.
  const sessions = new RuntimeSessionManager({
    runLedger: ownsSessionStore ? new RunLedger(join(desktopDir(), 'run-ledgers')) : undefined,
    recoveryJournal,
    globalApprovalMode: ctx.config.agent.approval as import('../agent/loop-types.js').ApprovalMode,
    createAgent: (...args) => {
      const [, id, , requested] = args
      if (executionBackend.kind !== 'in-process' && id && restoredSessions.has(id) && !officialSessionContexts.has(id)) {
        if (requested?.startsWith(`${officialProviderId}:`)) throw new OfficialError('account_changed')
        const target = resolveManagedTargetSelection(ctx, requested, specReload, true)
        if (target && isOfficialProvider(target.spec.provider)) throw new OfficialError('account_changed')
      }
      return executionBackend.createAgent(...args)
    },
    defaultCwd: process.cwd(),
    persistence,
    maxLoadedSessions: sessionPool.maxLoadedSessions,
    idleAgentTtlMs: sessionPool.idleAgentTtlMs,
    // R1 — late-bound getter: registry resolves async after server start.
    getSessionRegistry: () => sessionRegistry,
    // Goal mode — late-bound per-session goal handles (refs + sessionDir +
    // cheap-client profile). Delegates to serve-agent's stores registry.
    // The resolver reference is captured on the first createAgent call (when
    // serve-agent is dynamically imported); before that, returns undefined
    // (a session with no agent built yet has no goal state anyway).
    resolveGoalHandles: (sessionId) => {
      if (!goalHandlesResolve) return undefined
      const liveCtx = specReload ? specReload() : ctx
      return goalHandlesResolve(sessionId, liveCtx.config)
    },
    // 审查门会话开关 — 与 goal handles 同模式（refs 迟绑定）。
    resolveReviewGateRef: (sessionId) => reviewGateResolve?.(sessionId),
    defaultReviewGate: ctx.config.agent.review.skipAuto ? 'off' : 'auto',
    // PlusMenu — provider model source + default for the model picker.
    // Reload-aware: picks up providers configured after startup (no restart).
    listModels: () => listAllModelsWithReload(ctx),
    defaultModelId: ctx.model.id,
    defaultDomain: ctx.config.agent?.defaultDomain,
    // 一键续跑兜底模型（可选，用户显式配置）。未配置时原模型不可用的续跑
    // fail-closed —— 绝不静默回退默认模型（跨模型续跑会重建整条前缀缓存）。
    resumeFallbackModel: ctx.config.agent?.resumeFallbackModel,
    // Goal 计划倒计时自动批准窗口（ms）。默认 150s（manager 内建）；
    // RIVET_GOAL_PLAN_AUTO_APPROVE_MS 覆盖，0 = 关闭（纯手动审批）。
    goalPlanAutoApproveMs: (() => {
      const raw = process.env.RIVET_GOAL_PLAN_AUTO_APPROVE_MS
      if (raw == null || raw.trim() === '') return undefined
      const n = Number(raw)
      return Number.isFinite(n) && n >= 0 ? n : undefined
    })(),
    missionStore,
    onSessionsChanged: (reason) => {
      if (typeof sessions !== 'undefined') {
        const currentSessionIds = new Set<string>()
        for (const record of sessions.listAllSessions()) {
          currentSessionIds.add(record.id)
          if (reason === 'external' && !knownSessions.has(record.id)) { restoredSessions.add(record.id) }
          knownSessions.add(record.id)
        }
        for (const id of knownSessions) if (!currentSessionIds.has(id)) { knownSessions.delete(id); restoredSessions.delete(id); officialSessionContexts.delete(id) }
      }
      serverEvents.publish('sessions_changed', reason)
    },
  })

  // 构造函数内已完成 rehydrate（persistence 存在时）——此处的会话数即盘上恢复量。
  const rehydratedSessions = sessions.listAllSessions()
  for (const record of rehydratedSessions) { restoredSessions.add(record.id); knownSessions.add(record.id) }
  timing.mark('rehydrate', `sessions=${rehydratedSessions.length}`)

  // Wave 3 (内存回收): idle release / archive / hardDelete 都经 manager 释放
  // stores——晚绑定到 serve-agent 的 forgetSessionStores（动态 import 后捕获）。
  sessions.setStoresForgetter((sessionId) => {
    if (!sessions.getSession(sessionId)) { officialSessionContexts.delete(sessionId); restoredSessions.delete(sessionId); knownSessions.delete(sessionId) }
    try { storesForgetter?.(sessionId) } catch { /* best-effort */ }
  })

  // Wave F: sessions 现已就绪——把真实 sameCwdRunningCount 回写到 SharedRuntime。
  // 之后任何 buildManagedAgent → buildSessionStores 创建的 refs.getSameCwdRunningSessions
  // 都会读到这条真实值；verificationSnapshotManager 的多 session 冲突检测真正生效。
  sharedRuntime.sameCwdRunningCount = (cwd, excludeSessionId) =>
    sessions.sameCwdRunningCount(cwd, excludeSessionId)
  // I4: sessions 就绪后回写，让 user hooks 能把结果推送到桌面事件流。
  sharedRuntime.sessions = sessions

  // Legacy single-prompt path (M0): one-shot POST /prompt SSE.
  //
  // Rebased onto RuntimeSessionManager so BOTH prompt paths share one execution
  // model and one disconnect semantic (a dropped connection never aborts; abort
  // is always explicit). Each POST /prompt materializes a real session — its
  // events persist, show up in /sessions, and survive a client disconnect. The
  // dedicated per-run AgentLoop set this path used to maintain is gone with it.
  const activeLegacyRuns = new Set<string>()
  const state: ServerState = {
    running: false,
    apiToken,
    abort: () => {
      sessions.abortAll()
    },
  }

  const routes = guardRuntimeRoutes(createRoutes(state, {
    startPrompt: (prompt) => {
      const rec = sessions.createSession({
        title: prompt.trim().slice(0, 80),
      })
      activeLegacyRuns.add(rec.id)
      state.running = true
      state.sessionId = rec.id
      // Adapter-owned subscription, independent of the streaming one (which
      // dies with the client connection): keeps /status bookkeeping honest and
      // preserves the legacy auto-deny approval semantics — a one-shot client
      // speaks no intervention protocol, so a dangling approval would hang the
      // run until timeout (or forever when no timeout is configured).
      const adminUnsub = sessions.subscribe(rec.id, (ev) => {
        if (ev.type === 'approval_required' && typeof ev.data.requestId === 'string') {
          sessions.answerIntervention(rec.id, ev.data.requestId, 'deny')
        } else if (ev.type === 'done') {
          adminUnsub?.()
          activeLegacyRuns.delete(rec.id)
          state.running = activeLegacyRuns.size > 0
          state.sessionId = activeLegacyRuns.values().next().value
        }
      })
      return {
        sessionId: rec.id,
        subscribe: (listener) => sessions.subscribe(rec.id, listener),
        start: () => sessions.run(rec.id, prompt),
      }
    },
    sseRegistry,
  }), () => ({ ownsSessionStore, initializationError, updatePreparing: sessions.isUpdateRestartPreparing() }))

  // Multi-session routes (M0.5 → M3): /sessions/*. R3 rollback routes consult
  // the live registry to build an OwnershipGuard, so thread it in via getter.
  // B4：reloadConfig 注入——模型切换 409 附因与解析侧同源（resolveServeContext
  // 重读磁盘最新 config；409 低频失败路径，reload 成本可接受）。
  Object.assign(routes, buildSessionRoutes(sessions, apiToken, () => sessionRegistry, ctx.config, {
    prepareOfficialSession: async (modelRef, signal) => {
      const preparationStartedAt = performance.now()
      timing.mark('model-prepare-start')
      if (executionBackend.kind !== 'in-process') throw new OfficialError('service_error')
      const fresh = specReload ? specReload() : ctx
      const requested = resolveProviderForModel(fresh, modelRef)
      if (!modelRef.startsWith(`${officialProviderId}:`) && (!requested || 'error' in requested || !isOfficialProvider(requested.provider))) throw new OfficialError('invalid_request')
      const identity = captureOfficialIdentity()
      if (!identity) throw new OfficialError('auth_required')
      const deps: ModelRuntimeDeps = { ...defaultModelRuntimeDeps, captureIdentity: () => identity }
      const prepared = await prepareOfficialServeContext(fresh, modelRef, identity, signal, deps)
      timing.mark('model-prepare-ready', `duration=${Math.round(performance.now() - preparationStartedAt)}ms`)
      signal?.throwIfAborted()
      const id = randomUUID()
      let disposed = false, committed = false
      const captured = { ...prepared, configured: true }
      return { id, resolveAutoDefault(cwd: string) {
        if (disposed) throw new OfficialError('service_error')
        signal?.throwIfAborted()
        return resolveSessionAutoDefault(cwd, { ...captured, config: loadConfig({ cwd }) }, { identity, providers: captured.config.provider.providers, modelRefs: prepared.autoDefaultModelRefs })
      }, commit() {
        if (committed) return
        if (disposed || officialSessionContexts.has(id)) throw new OfficialError('service_error')
        signal?.throwIfAborted()
        withCurrentOfficialIdentity(identity, () => { officialSessionContexts.set(id, captured); committed = true })
      }, dispose() { disposed = true; if (officialSessionContexts.get(id) === captured) { officialSessionContexts.delete(id); if (sessions.getSession(id)) restoredSessions.add(id) } } }
    },
    reloadConfig: () => resolveServeContext().config,
    prepareModelListing: async () => {
      const listingContext = { ...ctx }
      await prepareServeModelListing(listingContext, specReload ?? (() => ctx))
      return listAllModelsWithReload(listingContext)
    },
    sseRegistry,
  }))

  Object.assign(routes, buildUpdateRestartRoutes(sessions, apiToken))

  // Mission routes (P1 任务身份化): /missions/* — 与 session-manager 共享同一 store。
  Object.assign(routes, buildMissionRoutes(missionStore, apiToken))

  // Remote access: desktop info, authenticated HTTPS endpoint registration and phone self-check.
  const remoteEndpoint = createRemoteAccessEndpoint()
  Object.assign(routes, buildRemoteInfoRoutes(apiToken, { host, allowedHosts, lanDirect, protocol: opts.tls ? 'https' : 'http', endpoint: remoteEndpoint }))

  // Config routes: provider + API key management for the desktop settings UI.
  Object.assign(routes, buildConfigRoutes(apiToken, {
    // 全局审批档位落盘后的实时生效（2026-09-05 跨盘审批链修复）：启动快照
    // 就地更新（覆盖之后构建的 agent）+ 对无 per-session override 的存活
    // agent 广播新档——否则 UI 显示「完全读写」而 agent 按启动旧档询问。
    onApprovalConfigChanged: (approval) => {
      try {
        ;(ctx.config.agent as { approval: string }).approval = approval
      } catch { /* 快照形态异常时跳过，广播兜底仍生效 */ }
      try { sessions.applyGlobalApprovalMode(approval as Parameters<typeof sessions.applyGlobalApprovalMode>[0]) } catch { /* non-fatal */ }
    },
    // provider/密钥/默认模型写盘 → 启动快照原地刷新：「替换 key」与「env 压新
    // inline key」对新解析（switchModel / 新会话 / reload 兜底）即刻生效。
    // 已烘焙 client 的存活 agent 不换 key（已知边界）。注入式 ctx（测试）不接线，
    // 与 specReload 同判定，保持注入上下文确定性。
    onProviderConfigChanged: opts.context ? undefined : () => refreshServeContext(ctx),
    // 生图槽配置落盘 → 存活 agent 重算工具表（issue #8）：`generate_image` 的
    // isEnabled 随槽配置翻转，而工具定义是 agent 构建时快照给 promptEngine 的——
    // 不刷新的话当前会话看不到它（用户表现为「配置成功但工具不出现」）。与上面两个
    // hook 同属「落盘后对存活 agent 广播」；注入式 ctx（测试）不接线，保持确定性。
    onImageGenConfigChanged: opts.context ? undefined : () => { sessions.refreshAgentTools() },
    // file-context 路由的 cwd 工作区守卫（与 #221 同族）：只接受已注册工作区。
    knownWorkspaces: () => registeredWorkspaces(sharedRuntime.sessions ?? undefined),
  }))

  const configuredDefaultRoute = routes['GET /config/default-model']!
  routes['GET /config/default-model'] = async (...args) => {
    const params = args[1] ?? {}
    const result = await configuredDefaultRoute(...args)
    if (result.status !== 200 || Object.keys(params).length === 0) return result
    if (params.scope !== 'welcome' || Object.keys(params).some(key => !['scope', 'cwd', 'workspaceMode'].includes(key)) || params.cwd !== undefined && !params.cwd.trim() || params.workspaceMode !== undefined && !isSessionWorkspaceMode(params.workspaceMode)) return { status: 400, body: { error: 'invalid_request' } }
    const unknown = { ...result, body: { ...(result.body as object), effective: { status: 'unknown' } } }
    try {
      const workspaceConfig = loadConfig().workspace
      let workspace
      do {
        workspace = resolveSessionWorkspace({ requested: params.cwd, mode: params.workspaceMode as 'explicit' | 'default' | 'scratch' | undefined, processCwd: sessions.getDefaultCwd(), configDefaultDir: workspaceConfig.defaultDir, scratchRoot: workspaceConfig.scratchDir ?? sessionScratchRoot(profileRivetHome()), sessionId: randomUUID() })
      } while (workspace.managed && existsSync(workspace.path))
      let cwd = workspace.path
      if (workspace.source === 'config-default') {
        try { if (!statSync(cwd).isDirectory()) cwd = sessions.getDefaultCwd() } catch { cwd = sessions.getDefaultCwd() }
      }
      const config = loadConfig({ cwd })
      const snapshot = { ...ctx, config }
      let selected = resolveSessionAutoDefault(cwd, snapshot)
      const explicit = config.agent.defaultModel
      const explicitProvider = explicit ? config.provider.providers[explicit.split(':')[0]!] : undefined
      const officialDefault = explicit && (explicitProvider ? isOfficialProvider(explicitProvider) : explicit.startsWith(`${officialProviderId}:`))
      if (!selected?.available && (!explicit || officialDefault)) {
        const identity = captureOfficialIdentity()
        if (identity) {
          const listing = { ...snapshot }
          await prepareServeModelListing(listing, () => snapshot)
          const view = modelListingViews.get(listing)
          const providers = view?.context.config.provider.providers ?? {}
          selected = resolveSessionAutoDefault(cwd, { ...snapshot, config: loadConfig({ cwd }) }, { identity, providers, modelRefs: view?.modelRefs ?? [] })
        }
      }
      if (!selected) return unknown
      const { modelRef, kind, available, provider, model } = selected
      return { ...result, body: { ...(result.body as object), effective: { status: 'resolved', modelRef, kind, available, model: { id: model.id, description: model.description, supportsVision: model.supportsVision, supportsVideo: model.supportsVideo, effortSupported: modelEffortSupported(provider.name, provider, model) } } } }
    } catch { return unknown }
  }

  const configuredProvidersRoute = routes['GET /config/providers']!
  routes['GET /config/providers'] = async (...args) => {
    const result = await configuredProvidersRoute(...args)
    if (result.status !== 200) return result
    const listingContext = { ...ctx }
    await prepareServeModelListing(listingContext, specReload ?? (() => ctx))
    const view = modelListingViews.get(listingContext)?.context
    const body = result.body as { providers: Array<{ name: string; [key: string]: unknown }>; [key: string]: unknown }
    const providers = body.providers.map(entry => {
      const provider = view?.config.provider.providers[entry.name]
      if (!provider || !isOfficialProvider(provider)) return entry
      return { ...entry, authType: 'tianshu-account', officialAvailable: providerHasUsableAuth(entry.name, provider), models: contractModels(provider).map(model => ({ ...model, effortSupported: modelEffortSupported(entry.name, provider, model) })), effortSupported: contractModels(provider).some(model => modelEffortSupported(entry.name, provider, model)) }
    })
    const provider = view?.config.provider.providers[officialProviderId]
    if (provider && isOfficialProvider(provider) && !providers.some(p => p.name === officialProviderId) && providerHasUsableAuth(officialProviderId, provider)) {
      providers.unshift({ name: officialProviderId, label: '天枢官方', baseUrl: provider.baseUrl, protocol: provider.protocol, isDefault: false, userSaved: false, keyStatus: { source: 'none' }, authType: 'tianshu-account', officialAvailable: true, keyless: false, effortSupported: contractModels(provider).some(model => modelEffortSupported(officialProviderId, provider, model)), models: contractModels(provider).map(model => ({ ...model, effortSupported: modelEffortSupported(officialProviderId, provider, model) })), keys: [], isPreset: false, allowProFallback: false })
    }
    return { ...result, body: { ...body, providers } }
  }

  // Environment route: host toolchain availability (python, uv, git, node) for setup UI.
  Object.assign(routes, buildEnvRoute(apiToken))

  // Browser routes: chromium 就绪探测 + 一键安装。只装桌面端的用户没有 CLI 可敲
  // `rivet browser install`，缺了这两条路由截图能力对他们就是不可用。
  Object.assign(routes, buildBrowserRoutes(apiToken), buildSessionBrowserRoutes(sessions, apiToken), buildFileOpenRoutes(sessions, apiToken))

  // Clipboard image route: WebKitGTK 的 paste 事件对纯图片剪贴板透出空数据，
  // 桌面端 Ctrl+V 取图靠它兜底（复用 TUI 取图链，见 #302）。
  Object.assign(routes, buildClipboardRoutes(apiToken))

  // Project templates route: first-run AGENTS.md / .rivet.md bootstrap for desktop UI.
  // issue #221：project-docs / project-templates / project/trust 的 cwd 只接受已注册工作区。
  Object.assign(routes, buildProjectTemplatesRoutes(apiToken, () => registeredWorkspaces(sharedRuntime.sessions ?? undefined)))

  // Project docs route: read/write AGENTS.md / .rivet.md for the desktop settings UI.
  Object.assign(routes, buildProjectDocsRoutes(apiToken, () => registeredWorkspaces(sharedRuntime.sessions ?? undefined)))

  // Cache usage route: 跨会话 cache-log 聚合 — 桌面端读不到 ~/.rivet 下的日志文件。
  Object.assign(routes, buildCacheRoutes({ apiToken, defaultCwd: () => process.cwd() }))
  Object.assign(routes, buildStorageAuditRoutes({ apiToken }))

  // Token 台账路由：本地消耗查询 + 手动触发论坛同步。sidecar 是长驻进程，
  // 桌面用户的会话不经过 CLI bootstrap——autoSync+endpoint 齐全时在进程内
  // 启动间隔推送，否则桌面端产生的消耗永远等不到一趟自动同步。
  // 台账是旁路观测面：构造失败只意味着本次无自动推送，路由仍懒建兜底。
  let tokenLedgerService: ReturnType<typeof createAccountLedgerService> | undefined
  try {
    const tlConfig = loadConfig()
    tokenLedgerService = createAccountLedgerService(tlConfig)
    tokenLedgerService.startAutoSync()
  } catch { /* best-effort */ }
  Object.assign(routes, buildTokenLedgerRoutes({ apiToken, service: tokenLedgerService }))

  // 桌面端的项目授信入口（此前只有 CLI 能授信，配置被剥离后无处恢复）。
  Object.assign(routes, buildTrustRoutes(apiToken, () => registeredWorkspaces(sharedRuntime.sessions ?? undefined)))

  // MCP routes: server management + live status for the desktop MCP settings UI.
  Object.assign(routes, buildMcpRoutes({
    getMcpManager: () => sharedRuntime.mcpManager,
    onToolsReady: (tools) => sharedRuntime.sessions?.injectMcpTools(tools),
    apiToken,
  }))

  // Plugin routes: presets + install/enable/remove for desktop plugin market UI.
  Object.assign(routes, buildPluginRoutes(apiToken))

  // Speech routes：whisper.cpp 本地转写；模型经 models/.active 下载即切换。
  let whisperEngine: SpeechEngine | null = createSpeechEngineFromEnv()
  Object.assign(routes, buildSpeechRoutes(() => whisperEngine, apiToken, { onModelInstalled: () => { whisperEngine = createSpeechEngineFromEnv(); return whisperEngine !== null } }))

  Object.assign(routes, buildOpenFileRoute(apiToken))

  // N1: GET /health — sidecar liveness for the desktop crash-reconnect banner.
  // RIVET_VERSION is injected at build time via tsup define (tsup.config.ts) so
  // the packaged sidecar reports the real version. Falls back to
  // npm_package_version (CLI `npm start` dev) then a placeholder.
  const version = process.env.RIVET_VERSION ?? process.env.npm_package_version ?? '0.0.0-dev'
  // Event-loop lag telemetry: lets the desktop label a starved loop as
  // "service busy" instead of a phantom "connection interrupted".
  const loopHealth = new LoopHealthMonitor()
  loopHealth.start()
  // P1 卡顿归因（漂移检测）：250ms 量**实际间隔**，卡顿恢复后的第一个晚到 tick 就
  // 报一条（含内存快照 + 卡顿开始前 1s 内碰过的活动）。替代此前按 30s 窗口 max
  // 打印的 [loop-lag]——同一尖峰会在窗口内多个采样里重复打印，且尖峰只在卡顿
  // **结束后**才可见，恢复后只留一行无归属的 max。LoopHealthMonitor 保留：/health
  // 的 p99/max 字段仍由它回答「服务忙不忙」。
  const loopStall = new LoopStallDetector({ warn: (line) => serverLogger.warn(line), onStall: event => recordRuntimeDiagnostic({ kind: 'loop_stall', durationMs: event.stalledMs }) })
  loopStall.start()
  // registryOk lets the desktop tell "sidecar up but concurrency dormant" apart
  // from a healthy sidecar. In ephemeral/test mode (no registry wired) it reads
  // true so existing single-session behavior is unchanged.
  const registryReady = () => (opts.ephemeral ? true : sessionRegistry !== undefined)
  const serveConfigured = () => {
    if (ctx.configured) return true
    try { return captureOfficialIdentity() !== null } catch { return false }
  }
  const loopLagForHealth = () => loopHealth.snapshot()
  // 账号路由（桌面端 device flow）；主体、代理注入与测试在 account-routes.ts。
  Object.assign(routes, buildAccountRoutesFor(apiToken, ctx.config, () => tokenLedgerService?.accountChanged()), buildOfficialModelRoutesFor(apiToken, ctx.config))
  Object.assign(routes, buildProfileRoutes(sessions, apiToken))
  Object.assign(routes, buildProfileLibraryRoutes({ rivetHome: profileRivetHome(), apiToken }))

  Object.assign(
    routes,
    buildHealthRoute(sessions, startedAt, version, apiToken, registryReady, serveConfigured, loopLagForHealth, () => initializationError, () => storeLock?.holder(), () => externalHookHost.snapshot()),
  )
  // 阶段 4：GET /events 全局推送通道——sessions/tasks 失效提示 + 5s health 心跳
  // （心跳体与带 token 的 GET /health 同一构造点，前端直接 setQueryData）。
  Object.assign(
    routes,
    buildServerEventsRoute(serverEvents, apiToken, {
      healthSnapshot: createHealthSnapshot(sessions, startedAt, version, registryReady, serveConfigured, loopLagForHealth, () => initializationError, () => storeLock?.holder(), () => externalHookHost.snapshot()),
    }, sseRegistry),
  )

  // Greeting route: algorithm templates + flash LLM for the desktop welcome page.
  // Prefers the deepseek provider for flash model support; degrades to default provider + templates.
  // Reads greeting config (enabled/model) from user settings at request time.
  const deepseekProvider = ctx.config.provider.providers.deepseek
  const greetingBaseUrl = deepseekProvider?.baseUrl ?? ctx.provider.baseUrl
  const greetingApiKey = deepseekProvider?.apiKey ?? ctx.apiKey
  Object.assign(
    routes,
    buildGreetingRoute(greetingBaseUrl, greetingApiKey, () => getGreetingConfig(), apiToken, { config: ctx.config, provider: ctx.provider, apiKey: ctx.apiKey, auth: ctx.auth, modelId: ctx.model.id, purpose: 'greeting' }),
  )

  // Settings intent (Wave 3，回流自 3.14alpha)：自然语言 → 设置动作的 LLM 兜底。
  // 桌面端设置窗搜索框的规则引擎未命中时才调用；默认 provider 单次 chat，
  // 模型/baseUrl/apiKey 均按请求求值（ctx 在配置重载时会被整体替换，闭包不能
  // 捕获旧值——首启无 key 后配好 key、或切换 provider 时，按值捕获会让兜底失效）。
  Object.assign(
    routes,
    buildSettingsIntentRoutes({
      getBaseUrl: () => ctx.provider.baseUrl,
      getApiKey: () => ctx.apiKey,
      getModel: () => ctx.model.id,
      apiToken,
    }),
  )

  // N3: async orchestration — cron scheduler → task registry → runtime pool that
  // spins up *visible* sessions. Disabled in ephemeral mode (tests) to avoid
  // leaking timers.
  let scheduler: CronScheduler | undefined
  let wiring: CronWiring | undefined
  let taskRegistry: TaskRegistry | undefined
  if (!opts.ephemeral && ownsSessionStore) {
    const rivetDir = desktopDir()
    scheduler = new CronScheduler({ schedulePath: join(rivetDir, 'scheduled_tasks.json') })
    setActiveScheduler(scheduler)
    setUnattendedAutomationGate(() => isProFeatureEnabled(ctx.config, 'unattendedAutomation'))
    const registry = new TaskRegistry({
      taskStore: new JsonTaskStore(join(rivetDir, 'tasks')),
      // 阶段 4：任务创建 / 状态转换 → 推送通道失效提示（替代 /tasks 5s 轮询）。
      onEvent: (ev) => serverEvents.publish('tasks_changed', ev.type),
    })
    taskRegistry = registry
    const runtimePool = new SessionRuntimePool({ manager: sessions, defaultCwd: process.cwd() })
    // CronLock: with multiple sidecars pointed at the same desktop dir, exactly
    // one wins the lock and runs the scheduler — the rest stay idle instead of
    // double-firing every scheduled task.
    const lock = new CronLock({ lockPath: join(rivetDir, 'scheduled_tasks.lock') })
    // issue #290（公开仓 PR #295 口径）——锁主唯一写者：工具侧全局门与路由侧
    // isWriteAllowed 都按 lock.isOwner() 动态判定（锁竞争异步、锁可易主）。
    setScheduleWriteGuard(() => lock.isOwner())
    wiring = new CronWiring({ scheduler, registry, runtimePool, lock, cwd: process.cwd() })
    void wiring.start().catch(() => { /* non-fatal: scheduler stays idle */ })
    Object.assign(routes, buildScheduleRoutes(scheduler, apiToken, {
      getStatus: () => wiring?.getStatus(),
      isWriteAllowed: () => lock.isOwner(),
      // 付费版 v1 · T5 — 非 always-review / 含 computer_use 的定时任务归 Pro。
      // 用启动时的 ctx.config：桌面端 Pro 状态经签名凭证注入（激活/吊销后要求
      // 重启 sidecar），CLI 走配置软 gate。
      isUnattendedAutomationEnabled: () => isProFeatureEnabled(ctx.config, 'unattendedAutomation'),
    }))
    // Task audit/history API (execution records for the automations dashboard).
    // The scheduler + task-registry share this desktop dir, so events land in
    // .rivet/tasks/events alongside the task records.
    Object.assign(routes, buildTaskRoutes({
      registry,
      apiToken,
      notifyPolicy: 'state_changes',
      eventsDir: join(rivetDir, 'tasks', 'events'),
    }))
  }

  // 无进展哨兵（stall-observer）：回合死锁（loop 健康、异步挂起）时事件落盘
  // 停止——观察器 150s 后 console.warn 指认会话与最后活动点，不依赖用户现场
  // 抓栈（2026-09-08 write_file 挂起两次复现均无日志的教训）。懒安装兜底
  // 已覆盖未显式接线入口；此处显式安装保证 serve 启动即观测。
  installStallObserver()
  timing.mark('routes')
  const listenT0 = performance.now()
  // lanDirect 必须原样下传：startServer 会用 opts.lanDirect 再解析一次，缺它就回落到 env
  // 二次判定——显式 opt-in 会被判成未开启并抛 requires TLS（契约：serve-tls.test.ts）。
  const server = await startServer(port, routes, apiToken, { host, allowedHosts, lanDirect, mobileDir, tls: opts.tls, additionalAllowedHosts: remoteEndpoint.hosts })
  timing.mark('listen', `bind=${Math.round(performance.now() - listenT0)}ms wall=${Date.now() - startedAt}ms`)
  const serverInfo: ServerInfo = { port, host, ...(opts.tls ? { protocol: 'https' as const } : {}), token: apiToken, pid: process.pid, startedAt: new Date(startedAt).toISOString() }
  // 首批 UI 请求里的 GET /environment 此前是这些探针的首个调用方，同步 spawnSync
  // 卡主线程几百 ms，并发的 /config/* 与 /git/branches 全排在它后面——实测就是
  // 「就绪后首秒所有路由 300–600ms」的主因（agent chunk 预热只是次因）。
  void Promise.all([prewarmResolvedEnv(), prewarmShellProbes()])
    .then(() => timing.mark('host-probes'))
  // P0-4 — 假中断标记一次性迁移：只有拿到会话库独占锁的 sidecar 有资格跑（迁移要读
  // 并原子重写 events.jsonl）。挂在 listen 之后、后台异步：大日志扫描不能阻塞首批
  // UI 请求。逐会话之间让出事件循环，done marker 只在全部成功时才落（幂等，失败
  // 下次启动重试）；失败只记日志，绝不影响服务。opts.ephemeral 无锁 → 不跑。
  if (storeLock && ownsSessionStore) {
    void runPhantomResumeMigration({
      sessionsDir: desktopSessionsDir(),
      removedBackupPath: join(desktopDir(), '.migrations', `${PHANTOM_RESUME_MIGRATION_VERSION}.removed.jsonl`),
      // 运行中的会话磁盘可能正被追加——跳过（判据取 sessions 的公开 API）。
      isSessionRunning: (id) => sessions.getSession(id)?.status === 'running',
      log: (line) => serverLogger.warn(line),
    }).catch((err) => {
      serverLogger.error('[phantom-resume] migration crashed (non-fatal)', {
        error: (err as Error)?.message ?? String(err),
      })
    })
  }
  // 预热（agent 装配 chunk import + 插件快照）延后到 listen 之后：首批 UI 请求
  // （/health、/sessions、/config/*）先过，再让预热吃 CPU。首个会话经 createAgent
  // 的 fireNow 即时触发，不等定时器；close 时取消未点火的定时器。
  warmup = scheduleDeferredWarmup(() => {
    timing.mark('warm-start')
    warmPluginToolsCache(ctx.config.plugins, process.cwd())
    void pluginToolsWarmup().then(() => timing.mark('plugins-warm'))
    void loadServeAgent()
      .then(() => timing.mark('serve-agent-loaded'))
      .catch(() => { /* createAgent 路径会带着真实错误重试 */ })
  }, resolveServeWarmDelayMs())
  if (!serveConfigured() || !ownsSessionStore) warmup.cancel()
  return {
    port,
    /** 本实例坐标（内存真源）——--json 握手输出用，不回读发现文件（双实例竞态）。 */
    serverInfo,
    sessions,
    scheduler,
    shared: sharedRuntime,
    close: (cb) => {
      officialSessionContexts.clear(); restoredSessions.clear(); knownSessions.clear()
      const hookDrain = externalHookHost.shutdown()
      warmup?.cancel()
      // 发现文件先清（pid 校验在 clearServerInfo 内）——优雅排空可能持续数秒，
      // 期间新来的 attach 不该继续发现垂死实例。
      clearServerInfo()
      // Legacy /prompt runs live on manager sessions too — abortAll covers both.
      sessions.abortAll()
      // Wave L: 与 TUI createShutdownHandler 对称——abort 中止 turn 后，对所有
      // session 显式 shutdown 释放 coordinator stallSweep + 在途 worker 句柄。
      // 共享资源要等 claims/worker finally 完成后再拆，避免 handoff 紧接着
      // 进入同一工作区时撞上上一会话的文件归属。
      const finish = async () => {
        await tokenLedgerService?.shutdownFlush()
        await disposeAllBrowserContexts()
        disposeSessionFilePreviews()
        // 先收执行后端：隔离模式下这是 kill 每个会话执行进程的第一道口。
        await executionBackend.close().catch(() => {})
        void wiring?.stop()
        wiring?.dispose()
        taskRegistry?.dispose()
        scheduler?.stop()
        // Kill MCP child processes synchronously — async shutdown() may not
        // complete before the process exits, leaving orphaned subprocesses.
        sharedRuntime.mcpManager?.killChildrenSync()
        // Wave G: 释放 per-cwd 共享 Meridian/LSP 资源（module may still be loading).
        const agentMod = getLoadedServeAgentModule()
        if (agentMod) {
          agentMod.disposeSharedCwdResources(sharedRuntime)
        } else {
          sharedRuntime.meridianIndexers.clear()
          sharedRuntime.lspManagers.clear()
          sharedRuntime.domainStores.clear()
        }
        loopHealth.stop()
        loopStall.stop()
        // agent-16：会话事件写链（100ms debounce 批次）有界排空——CRITICAL 之外的
        // 滞留行否则随进程退出丢失（flushAllAsync 此前只有测试调用，生产关闭链
        // 缺这一环）。有界超时，best-effort。丢锁后 canWrite 闸门把它兜成
        // 「丢弃滞留行立即返回」，不会向别人的会话库回写。
        try { await persistence?.flushAllAsync(3_000) } catch { /* best-effort */ }
        // P0-1 — 释放会话库独占锁。此刻所有会话库写入方（persistence / 台账 /
        // 定时任务）都已停在上面的关闭链里，释放不会与残留写交错。release 只在锁
        // 仍属于本进程时才删文件——拿不到锁的降级实例是 no-op。
        storeLock?.release()
        // agent-13：先主动清场 SSE 长连（/events、/sessions/:id/stream、/prompt）。
        // 它们只挂 res.on('close') 清理，服务端不主动关则 server.close(cb) 永远
        // 等不到回调——桌面客户端连着时 SIGINT 只能 kill -9 的根因。
        // closeAll 发 done 帧 + end → 客户端读到 EOF 走退避重连。
        sseRegistry.closeAll()
        serverEvents.close()
        server.close(cb)
        // closeAll 的 res.end 让 socket 转入 keep-alive 空闲态、仍阻塞 close
        // 回调（实测要等 5s keepAliveTimeout）——立即回收让退出即时完成。
        server.closeIdleConnections()
      }
      void Promise.allSettled([sessions.shutdownAll(), hookDrain]).then(finish, finish)
    },
  }
}

/**
 * Best-effort exit-reason breadcrumb. OOM / hard kills can't write anything, so
 * the PRESENCE of this file distinguishes a deliberate self-shutdown (watchdog,
 * signal) from a silent death — the exact ambiguity that made the "sidecar died
 * overnight" incidents unattributable. Written to the desktop dir next to the
 * scheduler artifacts; failures are swallowed.
 */
function writeExitBreadcrumb(reason: string, extra: Record<string, unknown> = {}): void {
  // 降级实例（拿不到会话库锁）不写面包屑——见 storeLockDegraded 注释。
  if (storeLockDegraded) return
  try {
    const path = join(desktopDir(), 'sidecar-exit.json')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({
      reason,
      instanceId: RUNTIME_INSTANCE_ID,
      buildId: process.env.RIVET_BUILD_ID ?? 'unknown',
      pid: process.pid,
      at: new Date().toISOString(),
      ...extra,
    }, null, 2))
  } catch {
    // best-effort — never block shutdown on breadcrumb IO
  }
}

/**
 * CLI command handler for `rivet serve [--port N] [--host ADDR]`. Wires signal
 * handlers and prints the listening banner. Exits non-zero on misconfiguration.
 */
export async function serveCommand(args: string[]): Promise<void> {
  const portIdx = args.indexOf('--port')
  const rawPort = portIdx >= 0 ? args[portIdx + 1] : String(DEFAULT_PORT)
  if (rawPort == null || rawPort === '') {
    console.error('Missing value for --port (e.g. --port 3100)')
    process.exit(1)
  }
  const port = parseInt(rawPort, 10)
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${rawPort} (must be 1–65535)`)
    process.exit(1)
  }

  // --host <addr>：监听地址（默认 127.0.0.1，行为不变）。RIVET_SERVE_HOST
  // env 在 runServe 内兜底——CLI 显式参数优先。
  const hostIdx = args.indexOf('--host')
  const rawHost = hostIdx >= 0 ? args[hostIdx + 1] : undefined
  if (hostIdx >= 0 && (rawHost == null || rawHost === '')) {
    console.error('Missing value for --host (e.g. --host 0.0.0.0)')
    process.exit(1)
  }
  const host = rawHost?.trim()
  if (host && (host.includes('://') || host.includes('/'))) {
    console.error(`Invalid host: ${host} (expected IP or hostname, no scheme or path)`)
    process.exit(1)
  }

  // --mobile-dir <path>：/mobile 静态挂载目录（P2）。缺失值报错同 --host。
  const mobileDirIdx = args.indexOf('--mobile-dir')
  const rawMobileDir = mobileDirIdx >= 0 ? args[mobileDirIdx + 1] : undefined
  const mobileDir = rawMobileDir?.trim()
  if (mobileDirIdx >= 0 && !mobileDir) {
    console.error('Missing value for --mobile-dir (e.g. --mobile-dir ./desktop/dist)')
    process.exit(1)
  }

  // --attach/--json 的握手与 stdout 纯度在 server-info.ts（发现模块的 CLI 面）。
  const jsonMode = args.includes('--json')
  if (jsonMode) enableJsonModeStdoutPurity()
  if (args.includes('--attach')) await attachOrExit(jsonMode)

  let server: RunningServer
  try {
    server = await runServe({
      tls: readServeTlsArgs(args),
      port,
      ...(host ? { host } : {}),
      ...(mobileDir ? { mobileDir } : {}),
      // CLI 入口丢锁 = 写者身份失效：立即非零退出，**跳过优雅收尾**——close 链里的
      // flushAllAsync/面包屑都会向会话库回写，而会话库此刻已不属于本进程
      // （persistence 的 canWrite 闸门是兜底，这里第一道就不跑）。信号驱动的正常
      // 退出不受影响（丢锁后的 release 已是 no-op）。
      onLockLost: () => {
        console.error('[serve] 会话库锁已丢失（data-dir-lock-lost）——本进程不再是会话库写者，立即退出')
        process.exit(2)
      },
    })
  } catch (err) {
    console.error((err as Error).message)
    process.exit(1)
  }

  let shuttingDown = false
  const shutdownServer = () => {
    if (shuttingDown) {
      // 二次信号 = 用户明确等不了——跳过优雅链立即强退（CLI 惯例；此前被幂等
      // 守卫静默吞掉，用户只能干等保险丝）。
      console.error('[serve] second signal — forcing immediate exit')
      process.exit(1)
    }
    shuttingDown = true
    // 保险丝：优雅关停链会主动清场长连并退出；任何未预料的悬挂（未来新增的
    // 长连、半死 socket、finish 某步卡住）都不该让退出无限推迟——超时强制退出，
    // 绝不再回到「只能 kill -9」。预算对齐设计内慢收尾的最坏值（drainPostSession 5s
    // + flushWrites 2s 与 shutdownAndWait 8s 并行、flushAllAsync 3s、closeAll）加余量
    // ——3s 会把设计内慢收尾误判为悬挂并切掉 best-effort 尾写。强退非 0 退出码，
    // 与干净退出可区分。unref 不影响正常路径的即时 exit。
    setTimeout(() => {
      console.error('[serve] graceful shutdown did not finish in 15s — forcing exit')
      process.exit(1)
    }, 15_000).unref()
    server.close(() => process.exit(0))
  }
  // 主动关停入口（2026-09-21）：把 shutdownServer 登记给路由层（POST /shutdown）。
  // 桌面壳在杀 relay 前调它——那时 relay 还活着、REST 走 localhost 转发，是唯一
  // 能在发行版被 WSL 回收（~17s）之前拿到完整清理链的窗口。breadcrumb 标
  // shutdown-request 以区别于信号触发的退出（可归因性是 writeExitBreadcrumb 的
  // 原始动机）。注意幂等：shutdownServer 二次进入 = exit(1) 强退，故路由层
  // 「恰好一次」的契约（shutdown-route.test.ts）是有意义的约束。
  setShutdownHandler(() => {
    writeExitBreadcrumb('shutdown-request')
    shutdownServer()
  })
  process.on('SIGINT', () => {
    writeExitBreadcrumb('signal', { signal: 'SIGINT' })
    shutdownServer()
  })
  process.on('SIGTERM', () => {
    writeExitBreadcrumb('signal', { signal: 'SIGTERM' })
    shutdownServer()
  })
  // SIGHUP 必须显式处理：WSL attach 形态下 serve 是 wsl.exe relay 在 Linux 侧的
  // 同 session 子进程，桌面壳 disconnect 时 taskkill /T /F 杀掉 relay，内核给同
  // session 前台进程组发 SIGHUP。Node 对 SIGHUP 默认 terminate——实测（2026-09-20
  // 真机对照）连 process.on('exit') 都不触发，即 close 链一行不跑：发现文件残留
  // （下次 attach 读到陈旧 pid）、无 breadcrumb（死亡不可归因，正是
  // writeExitBreadcrumb 注释里那个"sidecar died overnight"的洞）、
  // flushAllAsync 未执行（会话事件写链滞留行丢失）。映射到既有 shutdownServer
  // 即复用整条优雅链；终端关闭、用户 kill session 同样受益。
  process.on('SIGHUP', () => {
    writeExitBreadcrumb('signal', { signal: 'SIGHUP' })
    shutdownServer()
  })
  installParentWatchdog(({ ppid, misses }) => {
    console.error(`[serve] parent process gone (pid ${ppid}, ${misses} consecutive probe misses) — shutting down sidecar`)
    writeExitBreadcrumb('parent-gone', { ppid, misses })
    shutdownServer()
  })

  // Last-resort: SIGKILL MCP children even if shutdownServer threw.
  process.on('exit', () => {
    try { server.shared.externalHookHost?.forceExit() } catch { /* best-effort */ }
    try { server.shared.mcpManager?.killChildrenSync?.() } catch { /* best-effort */ }
  })

  // 发现文件是对外的就绪信号，只能在上面的退出通路全部接好之后发布：否则发布后、
  // 处理器注册前的空档里收到 SIGHUP/SIGTERM，Node 默认直接终止进程，文件残留。
  writeServerInfo(server.serverInfo)
  const displayHost = host === '0.0.0.0' ? '0.0.0.0 (all interfaces)' : (host ?? '127.0.0.1')
  if (jsonMode) {
    // 握手模式：banner 走 stderr；坐标来自 RunningServer.serverInfo（内存真源，
    // 不回读磁盘——双实例竞态下回读会输出成别人的坐标）。
    console.error(`Rivet Runtime API listening on ${server.serverInfo.protocol ?? 'http'}://${displayHost}:${port}`)
    printSpawnedHandshake(server.serverInfo, (l) => console.log(l))
  } else {
    console.log(`Rivet Runtime API listening on ${server.serverInfo.protocol ?? 'http'}://${displayHost}:${port}`)
    console.log('Endpoints: GET /status, POST /abort, POST /prompt, /sessions/*')
  }
}

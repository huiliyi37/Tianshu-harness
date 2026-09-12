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
import { mkdirSync, writeFileSync } from 'node:fs'
import { startServer } from './index.js'
import { loadProModule, resolvePresetLabel } from '../api/pro-registry.js'
import { desktopDir, desktopSessionsDir } from '../config/paths.js'
import { serverLogger } from './logger.js'
import { createRoutes, type ServerState } from './routes.js'
import { RuntimeSessionManager } from './session-manager.js'
import { buildSessionRoutes } from './session-routes.js'
import { buildMissionRoutes } from './mission-routes.js'
import { buildRemoteInfoRoutes } from './remote-info-routes.js'
import { MissionStore } from './mission-store.js'
import { buildHealthRoute } from './health-route.js'
import { buildGreetingRoute } from './greeting-route.js'
import { isAuthorizedRequest } from './auth.js'
import { LoopHealthMonitor } from './loop-health.js'
import { buildScheduleRoutes } from './schedule-routes.js'
import { buildTaskRoutes } from './task-routes.js'
import { buildConfigRoutes } from './config-routes.js'
import { buildEnvRoute } from './env-route.js'
import { buildBrowserRoutes } from './browser-routes.js'
import { buildProjectTemplatesRoutes } from './project-templates-routes.js'
import { buildProjectDocsRoutes } from './project-docs-routes.js'
import { buildTrustRoutes } from './trust-api.js'
import { buildCacheRoutes } from './cache-routes.js'
import { buildSpeechRoutes, createSpeechEngineFromEnv, type SpeechEngine } from './speech-routes.js'
import { existsSync } from 'node:fs'
import { CronScheduler, setActiveScheduler } from './cron-scheduler.js'
import { CronWiring } from './cron-wiring.js'
import { buildMcpRoutes } from './mcp-api.js'
import { buildPluginRoutes } from './plugin-api.js'
import { warmPluginToolsCache } from './plugin-session-cache.js'
import { CronLock } from './cron-lock.js'
import { TaskRegistry } from './task-registry.js'
import { JsonTaskStore } from './task-store.js'
import { SessionRuntimePool } from './session-runtime-pool.js'
import { loadConfig, getGreetingConfig } from '../config/manager.js'
import { isRuntimeLeanAspect, resolveSessionPoolOptions } from '../config/runtime-lean.js'
import { isProFeatureEnabled } from '../config/pro-license.js'
import { setTargetConventions, applyConfiguredGitBashPath } from '../platform.js'
import { isKeylessProviderEntry } from '../config/provider-presets.js'
import { resolveApiKey } from '../api/factory.js'
import type { OaiMessage } from '../api/oai-types.js'
import { findRecentUnrecordedWrites, formatDiskReconciliationNote, shouldReconcileDisk } from '../context/write-evidence-probe.js'
import { createAuthProvider } from '../auth/registry.js'
import type { AuthProvider } from '../auth/types.js'
import { SessionPersist } from '../agent/session-persist.js'
import { SessionContext } from '../agent/context.js'
import { buildOpenPathCommand, buildRevealCommand } from '../tools/open-path.js'
import { installStallObserver, listStallActivities } from '../agent/stall-observer.js'
import { SessionRegistry } from '../agent/session-registry.js'
import { ProviderHealthTracker } from '../agent/provider-health.js'
import type { Config, ProviderConfig, ModelConfig } from '../config/schema.js'
import { FileSessionPersistence } from './session-persistence.js'
import type { SharedRuntime } from './serve-agent.js'

type ServeAgentModule = typeof import('./serve-agent.js')
let serveAgentMod: ServeAgentModule | null = null
let serveAgentPromise: Promise<ServeAgentModule> | null = null

/** Load heavy agent assembly (deferred from cold /health path). */
export function loadServeAgent(): Promise<ServeAgentModule> {
  if (!serveAgentPromise) {
    const t0 = performance.now()
    serveAgentPromise = import('./serve-agent.js').then((m) => {
      serveAgentMod = m
      if (process.env.RIVET_SERVE_TIMING === '1') {
        console.error(`[serve-timing] serve-agent import ${Math.round(performance.now() - t0)}ms`)
      }
      return m
    }).catch((err) => {
      // Don't cache a rejected promise — transient build/load failures would
      // permanently break session creation otherwise.
      serveAgentPromise = null
      throw err
    })
  }
  return serveAgentPromise
}

export function _resetServeAgentForTests(): void {
  serveAgentMod = null
  serveAgentPromise = null
}

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
  if (provider.auth?.type === 'oauth') {
    try {
      auth = createAuthProvider(provider.auth, process.env, provider.apiKey)
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
  const model = provider.models[0]
    ?? Object.values(config.provider.providers)
      .flatMap(p => p.models)[0]
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
  apiKey: string
  auth?: AuthProvider
  model: { id: string; maxTokens: number; contextWindow: number; reasoningEffort?: ModelConfig['reasoningEffort']; capabilities?: ModelConfig['capabilities'] }
}

/**
 * Resolve a model id (or alias) to its provider/apiKey/auth/model spec, scanning
 * every configured provider. Returns null when the id is unknown or the target
 * provider has no usable API key (kept fail-closed, like switchAgentRuntime).
 *
 * `provider:modelId`（或 `provider:alias`）显式消歧——deepseek 与 deepseek-spark
 * 共享同一 wire 型号名时，裸 id 仍优先扫到的第一个节点（兼容旧会话），带前缀
 * 则只查该 provider。
 */
export function resolveModelSpec(ctx: ServeContext, modelId: string): ResolvedModelSpec | null {
  const colon = modelId.indexOf(':')
  const pinnedProvider = colon > 0 ? modelId.slice(0, colon) : undefined
  const modelRef = pinnedProvider ? modelId.slice(colon + 1) : modelId
  if (!modelRef) return null

  const entries = pinnedProvider
    ? (() => {
        const prov = ctx.config.provider.providers[pinnedProvider]
        return prov ? [[pinnedProvider, prov] as const] : []
      })()
    : Object.entries(ctx.config.provider.providers)

  for (const [provName, prov] of entries) {
    const found = prov.models.find((m) => m.id === modelRef || m.alias === modelRef)
    if (!found) continue

    let provider = ctx.provider
    let apiKey = ctx.apiKey
    let auth = ctx.auth

    if (prov.auth?.type === 'oauth') {
      if (provName !== ctx.provider.name) {
        // B5（2026-09-07 审查）：oauth 分支此前命中即 return，不查可用凭据——
        // 未认证 oauth provider 排在前面会截胡裸别名（返回不可用 spec，下游
        // 请求时才 401），与下方「无 key provider 跳过继续扫」的穿透修复意图
        // 不对称。用 isAuthenticated() 判凭据，未认证同样 continue。
        const oauth = createAuthProvider(prov.auth, process.env, prov.apiKey)
        if (!oauth.isAuthenticated()) continue
        provider = prov
        apiKey = ''
        auth = oauth
      }
    } else {
      const provKey =
        prov.apiKey ??
        process.env[prov.apiKeyEnv ?? ''] ??
        (() => { try { return resolveApiKey(prov) } catch { return undefined } })()
      // 无 key 的 provider 跳过继续扫（2026-09-06 修复）：裸模型名/别名在多
      // provider 间撞名是常态（opus/sonnet/glm 在内置与自定义间大量重复），
      // 此前这里直接 return null 放弃整个扫描——撞上排在前面的无 key provider
      // 就永远到不了真正带 key 的目标（自定义模型「切不了」的实锤根因之一，
      // 探针四场景验证）。带 provider: 前缀的精确查找不受影响（只查一个）。
      if (!provKey) continue
      // Always adopt the freshly-resolved key — also for the snapshot's own
      // provider. Keeping `ctx.apiKey` there returned an EMPTY key whenever the
      // server started unconfigured and the key arrived later (env/config),
      // making the resolved spec unusable even though provKey was right here.
      provider = prov
      apiKey = provKey
      auth = undefined
    }

    return {
      provider,
      apiKey,
      auth,
      model: {
        id: found.id,
        maxTokens: found.maxTokens,
        contextWindow: found.contextWindow,
        reasoningEffort: found.reasoningEffort,
      },
    }
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
  const colon = modelId.indexOf(':')
  const pinnedProvider = colon > 0 ? modelId.slice(0, colon) : undefined
  const modelRef = pinnedProvider ? modelId.slice(colon + 1) : modelId
  if (!modelRef) return 'unknown-model'
  const entries = pinnedProvider
    ? (config.provider.providers[pinnedProvider] ? [[pinnedProvider, config.provider.providers[pinnedProvider]] as const] : [])
    : Object.entries(config.provider.providers)
  for (const [, prov] of entries) {
    if (prov.models.some((m) => m.id === modelRef || m.alias === modelRef)) return 'key-missing'
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
export function providerHasUsableAuth(provName: string, prov: ProviderConfig): boolean {
  if (isKeylessProviderEntry(provName, prov)) return true
  if (prov.auth?.type === 'oauth') {
    try {
      return createAuthProvider(prov.auth, process.env, prov.apiKey).isAuthenticated()
    } catch {
      return false
    }
  }
  try {
    return resolveApiKey(prov).length > 0
  } catch {
    return false
  }
}

/** Enumerate every selectable model across all usable providers. */
export function listAllModels(ctx: ServeContext): { id: string; alias: string; provider: string; providerLabel: string; contextWindow?: number; description?: string }[] {
  const out: { id: string; alias: string; provider: string; providerLabel: string; contextWindow?: number; description?: string }[] = []
  for (const [provName, prov] of Object.entries(ctx.config.provider.providers)) {
    // 只列可用 provider——无 key 云端 / 未认证 oauth 的预设模型不进 picker。
    if (!providerHasUsableAuth(provName, prov)) continue
    const providerLabel = resolvePresetLabel(provName) ?? provName
    for (const m of prov.models) {
      out.push({ id: m.id, alias: m.alias ?? m.id, provider: provName, providerLabel, contextWindow: m.contextWindow, description: m.description })
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
): { id: string; alias: string; provider: string; providerLabel: string; contextWindow?: number; description?: string }[] {
  try {
    return listAllModels(reload())
  } catch {
    return listAllModels(ctx)
  }
}

/**
 * Restore prior OAI conversation messages from disk into a SessionContext.
 *
 * Mirrors the TUI bootstrap path (`persist.loadOai()` + `replaceMessages()`):
 * when the Rust shell spawns a fresh sidecar, RuntimeSessionManager rehydrates
 * session records + event logs from disk, but the agent's LLM message stack
 * lives in a separate file (`~/.rivet/sessions/<slug>/<id>.jsonl`). Without
 * this call, a user continuing a prior session after restart sees full UI
 * history (from the event log) but the model receives an empty context.
 *
 * For brand-new sessions the file doesn't exist yet → loadOai() returns [] →
 * no-op. Called once per session in buildSessionStores, before the mutation
 * listener is wired (so replaceMessages doesn't trigger a redundant disk write).
 */
export interface HistoryRestoreInfo {
  /** Number of prior OAI messages loaded into the context (0 = none/new session). */
  restored: number
  /** Set when the session file existed but could not be read at all (IO error). */
  error?: string
}

export function restoreHistoryMessages(
  persist: SessionPersist,
  session: SessionContext,
  cwd?: string,
): HistoryRestoreInfo {
  // loadOai already skips corrupt lines; the catch covers hard IO failures
  // (unreadable file, permissions) so a broken history file degrades to an
  // empty-context session instead of making the session unbuildable. The
  // caller surfaces the mismatch (UI has history / model has none) to the user.
  let messages: OaiMessage[]
  try {
    messages = persist.loadOai()
  } catch (err) {
    return { restored: 0, error: (err as Error)?.message ?? String(err) }
  }
  // 2026-09-08 disk reconciliation: after a crash the workspace may be ahead of
  // the transcript. Disclose recently modified files the history never mentions
  // so the resumed model verifies instead of blindly rewriting finished work.
  const meta = cwd ? persist.loadMetadata() : undefined
  if (cwd && messages.length > 0 && shouldReconcileDisk(meta)) {
    const sinceMs = meta.updatedAt ? meta.updatedAt - 10 * 60 * 1000 : undefined
    const recent = findRecentUnrecordedWrites(cwd, messages, { sinceMs })
    const note = formatDiskReconciliationNote(recent)
    if (note) messages = [...messages, { role: 'user', content: note }]
  }
  if (messages.length > 0) {
    session.replaceMessages(messages)
  }
  return { restored: messages.length }
}

/** Type histogram of live event-loop handles — the loop-lag attribution field
 *  the 2026-09-08 report asked for (unref'd timers stay invisible, but sockets /
 *  servers / watchers / child processes are the meaningful in-flight set). */
function activeHandleSummary(): string {
  try {
    const handles = (process as unknown as {
      _getActiveHandles?: () => Array<{ constructor?: { name?: string } }>
    })._getActiveHandles?.() ?? []
    const counts = new Map<string, number>()
    for (const h of handles) {
      const name = h?.constructor?.name ?? 'unknown'
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, n]) => `${name}x${n}`)
      .join(',') || 'none'
  } catch {
    return 'unavailable'
  }
}

/** Last per-session activity markers — correlates a loop stall with the turn
 *  that was in flight when it happened. */
function stallActivitySummary(): string {
  const rows = listStallActivities().slice(0, 5)
  if (rows.length === 0) return 'none'
  return rows.map(r => `${r.key}:${r.activity.source}@${new Date(r.activity.ts).toISOString()}`).join(' | ')
}

export function isModelSpecUsable(spec: ResolvedModelSpec): boolean {
  return spec.apiKey !== '' || !!spec.auth
}

/** Actionable message when a session is asked to run without a usable key —
 *  shown instead of letting the request hit the provider and 401. */
export function unconfiguredSpecMessage(spec: ResolvedModelSpec): string {
  const provider = spec.provider.name
  const envHint = spec.provider.apiKeyEnv
    ? ` The provider is configured to read its key from the \`${spec.provider.apiKeyEnv}\` environment variable, which is not set in this process (a common cause after a sidecar restart). Set it and relaunch, or store the key inline via Settings.`
    : ' Configure it in Settings (or run `rivet config setup`).'
  return `No usable API key for provider "${provider}" — the request was not sent.${envHint}`
}


export function buildDelegateSummary(
  input: { objective: string },
  run: import('../agent/coordinator.js').CoordinatorRun,
): string {
  const result = run.results[0]
  const statusLabel = result?.status === 'passed' ? '完成'
    : result?.status === 'blocked' ? '受阻'
    : result?.status === 'escalated' ? '已升级'
    : result?.status === 'failed' ? '失败'
    : run.status === 'skipped' ? '已跳过' : '完成'
  const lines: string[] = []
  lines.push(`子代理任务「${input.objective}」${statusLabel}。`)
  const changed = result?.changedFiles ?? []
  if (changed.length > 0) {
    lines.push('', '变更文件：')
    for (const f of changed.slice(0, 20)) lines.push(`- ${f}`)
    if (changed.length > 20) lines.push(`- …其余 ${changed.length - 20} 个`)
  }
  if (result?.summary) {
    lines.push('', '子代理总结：', result.summary.slice(0, 1200))
  }
  lines.push('', '请审查以上结果，确认无误后继续。')
  return lines.join('\n')
}


export interface RunServeOptions {
  port?: number
  /** 监听地址。默认 127.0.0.1（RIVET_SERVE_HOST / --host 覆盖）。 */
  host?: string
  /** Host header allowlist（不带端口）。默认读 RIVET_SERVE_HOSTS_ALLOW。 */
  allowedHosts?: string[]
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
   * R1 — shared cross-session registry (file claims / OwnershipGuard / conflict
   * blocking). Tests inject a pre-built one; production creates it async at boot.
   * When absent, concurrency features stay dormant and behavior is unchanged.
   */
  sessionRegistry?: SessionRegistry
}

export interface RunningServer {
  port: number
  close: (callback?: () => void) => void
  sessions: RuntimeSessionManager
  scheduler?: CronScheduler
  /** Shared runtime for the exit handler to access mcpManager. */
  shared: SharedRuntime
}

/** Default HTTP port for `rivet serve` (--port overrides). */
const DEFAULT_PORT = 3100

/**
 * Start the runtime API server. Returns the bound port, a close() that aborts
 * all in-flight work, and the RuntimeSessionManager backing the multi-session
 * API. Throws if no token is available (fail-closed).
 */
export async function runServe(opts: RunServeOptions = {}): Promise<RunningServer> {
  // Pro 扩展点加载（spec 3b）：桌面 sidecar 生产路径。必须在 config-routes
  // 首次查询之前完成——否则 spark 节点不可见（合并视图查不到注册项）。
  await loadProModule()

  const apiToken = (opts.token ?? process.env.RIVET_SERVER_TOKEN)?.trim()
  if (!apiToken) {
    throw new Error('RIVET_SERVER_TOKEN is required for rivet serve')
  }
  const port = opts.port ?? DEFAULT_PORT
  // 监听地址：显式 opts（serveCommand --host / 测试注入）> env（桌面壳经父 env 继承
  // RIVET_SERVE_HOST 可达，零 Rust 改动）> 默认 127.0.0.1（行为不变）。
  const host = (opts.host ?? process.env.RIVET_SERVE_HOST)?.trim() || '127.0.0.1'
  const allowedHosts = opts.allowedHosts ?? parseHostsAllow(process.env.RIVET_SERVE_HOSTS_ALLOW)
  // /mobile 静态目录：显式 opts（--mobile-dir / 测试注入）> env（桌面壳注入）> 未配置。
  const mobileDir = (opts.mobileDir ?? process.env.RIVET_MOBILE_DIR)?.trim() || undefined
  const ctx = opts.context ?? resolveServeContext()
  // Hot credential pickup: sessions created after a Settings edit must resolve
  // the CURRENT on-disk key, not the startup snapshot's. Only wired when the
  // context came from disk — an injected context (tests) stays deterministic.
  const specReload = opts.context ? undefined : resolveServeContext
  // 插件暖场（2026-09-12 sidecar 插件装配补齐）：启动期先跑一次
  // initializePlugins 进暖场缓存——buildSessionStores 同步合入快照
  // （serve-agent.ts），Node 模块缓存随后使命中，每会话零等待。
  warmPluginToolsCache(ctx.config.plugins, process.cwd())
  const startedAt = Date.now()

  // R1 — one shared SessionRegistry for the whole sidecar. Created async (the
  // SQLite backend dynamic-imports better-sqlite3); sessions are created
  // seconds later by user interaction, by which time it's resolved. Tests pass a
  // pre-built registry. Ephemeral mode (tests) skips it → behavior unchanged.
  let sessionRegistry: SessionRegistry | undefined = opts.sessionRegistry
  if (!sessionRegistry && !opts.ephemeral) {
    // 启动收割崩溃会话的幽灵独占锁（收编公开仓 PR #110）：硬杀 sidecar 留下的死行会让 R2 写前守卫永久拒写。
    void SessionRegistry.createWithReap(desktopDir(), (c) => console.error(`[serve] ↺ 已清理 ${c.length} 个异常退出会话的锁定`))
      .then((r) => { sessionRegistry = r })
      .catch((err) => {
        // Registry init failed (e.g. better-sqlite3 native build missing).
        // Concurrency features stay dormant; surface the cause instead of
        // silently swallowing it so the failure is diagnosable in logs.
        console.error('[serve] SessionRegistry unavailable:', (err as Error)?.message ?? err)
      })
  }

  // N1: durable session storage so sessions survive sidecar restarts.
  const lean = isRuntimeLeanAspect('pool', ctx.config.runtime?.lean)
  const sessionPool = resolveSessionPoolOptions(ctx.config.runtime, lean)
  const persistence = opts.ephemeral
    ? undefined
    : new FileSessionPersistence(
        opts.sessionDir ?? desktopSessionsDir(),
        { maxEventsDiskBytes: sessionPool.maxEventsDiskBytes },
      )

  // Wave J: sidecar 级 SharedRuntime——providerHealth 跨 session 共享让
  // health 统计累积；domainStores 按 cwd 缓存避免重复磁盘 load + 跨 session
  // lessons 可见。runServe 进程级单例，传给每个 buildManagedAgent。
  // Wave F: sameCwdRunningCount 是 late-bound——sessions 创建后才能引用，
  // 先置 null，sessions 就绪后回写。getSameCwdRunningSessions getter 对
  // sessions 未就绪的窗口期会回退 0（安全）。
  const sharedRuntime: SharedRuntime = {
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
      const mgr = new McpManager(liveMcp)
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
      if (failed.length > 0) {
        // Fail loud: silently missing MCP tools is worse than a noisy boot.
        serverLogger.error(`MCP: ${connected} connected, ${mgr.getAllTools().length} tools, ${failed.length} failed:`, {
          failedServers: failed.map(s => `${s.serverId}${s.error ? ` — ${s.error}` : ''}${s.errorHint ? ` (${s.errorHint})` : ''}`),
        })
      } else {
        serverLogger.warn(`MCP: ${connected} servers connected, ${mgr.getAllTools().length} tools`)
      }
    } catch (err) {
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
  // cold /health does not pay for tools/Meridian/council.
  const sessions = new RuntimeSessionManager({
    // config schema 的 approval 联合比 agent 的 ApprovalMode 宽（多一个
    // 'suggest'）——与 create-agent-config 的透传同口径，窄化强转。
    globalApprovalMode: ctx.config.agent.approval as import('../agent/loop-types.js').ApprovalMode,
    createAgent: async (cwd, sessionId, approvalMode, modelId, allowedTools) => {
      const agentMod = await loadServeAgent()
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
      return agentMod.buildManagedAgent(
        ctx,        cwd ?? process.cwd(),
        sessionId ?? randomUUID(),
        sessionRegistry,
        approvalMode,
        sharedRuntime,
        specReload,
        modelId,
        allowedTools,
      )
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
  })

  // Wave 3 (内存回收): idle release / archive / hardDelete 都经 manager 释放
  // stores——晚绑定到 serve-agent 的 forgetSessionStores（动态 import 后捕获）。
  sessions.setStoresForgetter((sessionId) => {
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

  const routes = createRoutes(state, {
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
  })

  // Multi-session routes (M0.5 → M3): /sessions/*. R3 rollback routes consult
  // the live registry to build an OwnershipGuard, so thread it in via getter.
  // B4：reloadConfig 注入——模型切换 409 附因与解析侧同源（resolveServeContext
  // 重读磁盘最新 config；409 低频失败路径，reload 成本可接受）。
  Object.assign(routes, buildSessionRoutes(sessions, apiToken, () => sessionRegistry, ctx.config, {
    reloadConfig: () => resolveServeContext().config,
  }))

  // Mission routes (P1 任务身份化): /missions/* — 与 session-manager 共享同一 store。
  Object.assign(routes, buildMissionRoutes(missionStore, apiToken))

  // Remote-info route (P1 Mobile Remote): GET /remote/info — 桌面远程访问区块
  // 数据源 + 手机连通自检。mode 由实际绑定地址决定（127.0.0.1 → loopback）。
  Object.assign(routes, buildRemoteInfoRoutes(apiToken, { host, allowedHosts }))

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
  }))

  // Environment route: host toolchain availability (python, uv, git, node) for setup UI.
  Object.assign(routes, buildEnvRoute(apiToken))

  // Browser routes: chromium 就绪探测 + 一键安装。只装桌面端的用户没有 CLI 可敲
  // `rivet browser install`，缺了这两条路由截图能力对他们就是不可用。
  Object.assign(routes, buildBrowserRoutes(apiToken))

  // Project templates route: first-run AGENTS.md / .rivet.md bootstrap for desktop UI.
  Object.assign(routes, buildProjectTemplatesRoutes(apiToken))

  // Project docs route: read/write AGENTS.md / .rivet.md for the desktop settings UI.
  Object.assign(routes, buildProjectDocsRoutes(apiToken))

  // Cache usage route: 跨会话 cache-log 聚合 — 桌面端读不到 ~/.rivet 下的日志文件。
  Object.assign(routes, buildCacheRoutes({ apiToken, defaultCwd: () => process.cwd() }))

  // 桌面端的项目授信入口（此前只有 CLI 能授信，配置被剥离后无处恢复）。
  Object.assign(routes, buildTrustRoutes(apiToken))

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

  // Open file in system editor / reveal in file manager — thin wrapper so the
  // Desktop webview can request the sidecar to open a local path without
  // needing a Tauri plugin.
  routes['POST /open-file'] = async (body, _params, headers) => {
    // 路由级鉴权（防御纵深）：open-file 会以用户身份启动 explorer/编辑器，
    // 不能只靠 index.ts 全局门。
    if (!isAuthorizedRequest({ body, headers }, apiToken)) {
      return { status: 401, body: { error: 'Unauthorized' } }
    }
    const filePath = (body as Record<string, unknown>)?.path
    if (typeof filePath !== 'string' || !filePath) {
      return { status: 400, body: { error: 'Missing path' } }
    }
    const reveal = (body as Record<string, unknown>)?.reveal === true
    const bodyCwd = (body as Record<string, unknown>)?.cwd
    const { existsSync } = require('node:fs') as typeof import('node:fs')
    const { resolve: resolvePath } = require('node:path') as typeof import('node:path')
    // 用请求体里的 cwd（=项目目录）解析相对路径，而非 sidecar 的 process.cwd()
    // （=home 目录）——否则 Windows 下相对路径解析到错误位置 → existsSync 404。
    const resolved = typeof bodyCwd === 'string' && bodyCwd
      ? resolvePath(bodyCwd, filePath)
      : resolvePath(filePath)
    if (!existsSync(resolved)) {
      return { status: 404, body: { error: `Path not found: ${resolved}` } }
    }
    const command = reveal ? buildRevealCommand(resolved) : buildOpenPathCommand(resolved)
    // Windows 上 reveal=false (打开文件/文件夹) 时绕过 buildOpenPathCommand 的
    // PowerShell Start-Process——实测 spawned ok 但实际窗口/编辑器不弹 (尤其
    // 中文/特殊字符路径)。直接 spawn explorer.exe [路径]: explorer 对文件夹
    // 打开资源管理器, 对文件用关联程序打开 (跟双击一样), 不经 PowerShell 引号
    // 二次解析, 最可靠。reveal=true 仍走 buildRevealCommand (explorer /select,)。
    let effectiveCommand = command
    if (!reveal && process.platform === 'win32') {
      effectiveCommand = { cmd: 'explorer.exe', args: [resolved.replace(/\//g, '\\')] }
    }
    try {
      const { spawn } = await import('node:child_process')
      await new Promise<void>((resolve, reject) => {
        const child = spawn(effectiveCommand.cmd, effectiveCommand.args, { detached: true, stdio: 'ignore' })
        child.on('error', reject)
        child.on('spawn', () => { child.unref(); resolve() })
      })
      return { status: 200, body: { opened: resolved } }
    } catch (err) {
      console.error(`[open-file] spawn failed: ${effectiveCommand.cmd} ${effectiveCommand.args.join(' ')} → ${(err as Error).message}`)
      return { status: 500, body: { error: `启动失败: ${(err as Error).message}` } }
    }
  }

  // N1: GET /health — sidecar liveness for the desktop crash-reconnect banner.
  // RIVET_VERSION is injected at build time via tsup define (tsup.config.ts) so
  // the packaged sidecar reports the real version. Falls back to
  // npm_package_version (CLI `npm start` dev) then a placeholder.
  const version = process.env.RIVET_VERSION ?? process.env.npm_package_version ?? '0.0.0-dev'
  // Event-loop lag telemetry: lets the desktop label a starved loop as
  // "service busy" instead of a phantom "connection interrupted".
  const loopHealth = new LoopHealthMonitor()
  loopHealth.start()
  // registryOk lets the desktop tell "sidecar up but concurrency dormant" apart
  // from a healthy sidecar. In ephemeral/test mode (no registry wired) it reads
  // true so existing single-session behavior is unchanged.
  Object.assign(
    routes,
    buildHealthRoute(sessions, startedAt, version, apiToken, () =>
      opts.ephemeral ? true : sessionRegistry !== undefined,
    () => resolveServeContext().configured,
    () => {
      const snap = loopHealth.snapshot()
      // 2026-08-09 卡顿归因遥测：>2s 的事件循环尖峰落 sidecar 日志（带堆/RSS），
      // 让桌面端 degraded 横幅事后可区分 GC / swap / 同步阻塞（此前横幅亮了
      // 却无任何数据可查，2026-08-09 首轮响应排查的观测缺口）。仅尖峰时写，
      // 健康路径零开销。完全卡死时 /health 当窗答不出——尖峰记在恢复后首个
      // 响应的 maxMs 里（loop-health.ts 注释的窗口语义），正好够归因。
      if (snap.maxMs > 2000) {
        const mem = process.memoryUsage()
        console.warn(
          `[loop-lag] t=${new Date().toISOString()} event-loop stall: ` +
          `max=${Math.round(snap.maxMs)}ms p99=${Math.round(snap.p99Ms)}ms ` +
          `heapUsed=${Math.round(mem.heapUsed / 1048576)}MB rss=${Math.round(mem.rss / 1048576)}MB ` +
          `handles=${activeHandleSummary()} activities=${stallActivitySummary()}`,
        )
      }
      return snap
    }),
  )

  // Greeting route: algorithm templates + flash LLM for the desktop welcome page.
  // Prefers the deepseek provider for flash model support; degrades to default provider + templates.
  // Reads greeting config (enabled/model) from user settings at request time.
  const deepseekProvider = ctx.config.provider.providers.deepseek
  const greetingBaseUrl = deepseekProvider?.baseUrl ?? ctx.provider.baseUrl
  const greetingApiKey = deepseekProvider?.apiKey ?? ctx.apiKey
  Object.assign(
    routes,
    buildGreetingRoute(greetingBaseUrl, greetingApiKey, () => getGreetingConfig(), apiToken),
  )

  // N3: async orchestration — cron scheduler → task registry → runtime pool that
  // spins up *visible* sessions. Disabled in ephemeral mode (tests) to avoid
  // leaking timers.
  let scheduler: CronScheduler | undefined
  let wiring: CronWiring | undefined
  let taskRegistry: TaskRegistry | undefined
  if (!opts.ephemeral) {
    const rivetDir = desktopDir()
    scheduler = new CronScheduler({ schedulePath: join(rivetDir, 'scheduled_tasks.json') })
    setActiveScheduler(scheduler)
    const registry = new TaskRegistry({ taskStore: new JsonTaskStore(join(rivetDir, 'tasks')) })
    taskRegistry = registry
    const runtimePool = new SessionRuntimePool({ manager: sessions, defaultCwd: process.cwd() })
    // CronLock: with multiple sidecars pointed at the same desktop dir, exactly
    // one wins the lock and runs the scheduler — the rest stay idle instead of
    // double-firing every scheduled task.
    const lock = new CronLock({ lockPath: join(rivetDir, 'scheduled_tasks.lock') })
    wiring = new CronWiring({ scheduler, registry, runtimePool, lock, cwd: process.cwd() })
    void wiring.start().catch(() => { /* non-fatal: scheduler stays idle */ })
    Object.assign(routes, buildScheduleRoutes(scheduler, apiToken, {
      getStatus: () => wiring?.getStatus(),
      // 付费版 v1 · T5 — 非 always-review / 含 computer_use 的定时任务归 Pro。
      // 用启动时的 ctx.config：Pro 状态经 RIVET_PRO 注入，激活后本就要求重启 sidecar。
      isUnattendedAutomationEnabled: () =>
        isProFeatureEnabled(ctx.config, 'unattendedAutomation'),
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
  const listenT0 = performance.now()
  const server = await startServer(port, routes, apiToken, { host, allowedHosts, mobileDir })
  if (process.env.RIVET_SERVE_TIMING === '1') {
    console.error(`[serve-timing] listen ready ${Math.round(performance.now() - listenT0)}ms (since runServe start ${Date.now() - startedAt}ms)`)
  }
  // Warm the agent-assembly chunk in the background so the first session
  // doesn't pay the full dynamic-import tax on the critical path.
  void loadServeAgent()
  return {
    port,
    sessions,
    scheduler,
    shared: sharedRuntime,
    close: (cb) => {
      // Legacy /prompt runs live on manager sessions too — abortAll covers both.
      sessions.abortAll()
      // Wave L: 与 TUI createShutdownHandler 对称——abort 中止 turn 后，对所有
      // session 显式 shutdown 释放 coordinator stallSweep + 在途 worker 句柄。
      // 共享资源要等 claims/worker finally 完成后再拆，避免 handoff 紧接着
      // 进入同一工作区时撞上上一会话的文件归属。
      const finish = () => {
        void wiring?.stop()
        wiring?.dispose()
        taskRegistry?.dispose()
        scheduler?.stop()
        // Kill MCP child processes synchronously — async shutdown() may not
        // complete before the process exits, leaving orphaned subprocesses.
        sharedRuntime.mcpManager?.killChildrenSync()
        // Wave G: 释放 per-cwd 共享 Meridian/LSP 资源（module may still be loading).
        if (serveAgentMod) {
          serveAgentMod.disposeSharedCwdResources(sharedRuntime)
        } else {
          sharedRuntime.meridianIndexers.clear()
          sharedRuntime.lspManagers.clear()
          sharedRuntime.domainStores.clear()
        }
        loopHealth.stop()
        server.close(cb)
      }
      void sessions.shutdownAll().then(finish, finish)
    },
  }
}

export interface ParentWatchdogOptions {
  /** Probe interval. Default 3000ms. */
  intervalMs?: number
  /** Consecutive failed probes required before onParentGone fires. Default 3. */
  maxMisses?: number
  /** Injectable liveness probe (tests). Returns true when the parent is alive. */
  probe?: (ppid: number) => boolean
}

/** True when `ppid` still exists (signal-0 probe; EPERM = alive but not ours). */
export function probeParentAlive(ppid: number): boolean {
  try {
    // signal 0 probes existence/permission without actually signalling.
    process.kill(ppid, 0)
    return true
  } catch (err) {
    // ESRCH = parent gone. EPERM = alive but not ours → still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Parent-death watchdog. The desktop shell spawns the sidecar with
 * `RIVET_PARENT_PID` set to its own pid; we poll whether that process still
 * exists and self-terminate when it's gone. This is the cross-platform backstop
 * for the case the shell's `Child::kill()` can't cover — a crash, a SIGKILL, or
 * Windows "End task" — which would otherwise leave an orphaned `node.exe`
 * holding the port. No-op when the env var is absent (manual `rivet serve`).
 *
 * 宽限：单次探测失败可能是瞬时误报（父进程短暂无响应、电源状态切换等），
 * 立即自杀会造成「sidecar 半夜无故死亡」。改为连续 maxMisses 次（默认 3 次
 * ≈ 9s）失败才触发退出，期间任一次成功即清零；每次 miss 记日志留现场。
 */
export function installParentWatchdog(
  onParentGone: (info: { ppid: number; misses: number }) => void,
  options: ParentWatchdogOptions = {},
): void {
  const raw = process.env.RIVET_PARENT_PID
  const ppid = raw ? Number(raw) : NaN
  if (!Number.isInteger(ppid) || ppid <= 0) return
  const intervalMs = options.intervalMs ?? 3000
  const maxMisses = options.maxMisses ?? 3
  const probe = options.probe ?? probeParentAlive
  let misses = 0
  let fired = false
  const timer = setInterval(() => {
    if (fired) return
    if (probe(ppid)) {
      misses = 0
      return
    }
    misses++
    if (misses < maxMisses) {
      console.error(`[serve] parent pid ${ppid} probe miss ${misses}/${maxMisses} — exiting after ${maxMisses} consecutive misses`)
      return
    }
    // fired guard: shutdown (process.exit) may take a beat; the interval must
    // not re-enter onParentGone in the meantime.
    fired = true
    clearInterval(timer)
    onParentGone({ ppid, misses })
  }, intervalMs)
  // Don't let the watchdog itself keep the event loop alive — the HTTP server
  // already does, and an unref'd timer won't block a clean exit.
  timer.unref()
}

/**
 * Best-effort exit-reason breadcrumb. OOM / hard kills can't write anything, so
 * the PRESENCE of this file distinguishes a deliberate self-shutdown (watchdog,
 * signal) from a silent death — the exact ambiguity that made the "sidecar died
 * overnight" incidents unattributable. Written to the desktop dir next to the
 * scheduler artifacts; failures are swallowed.
 */
function writeExitBreadcrumb(reason: string, extra: Record<string, unknown> = {}): void {
  try {
    const path = join(desktopDir(), 'sidecar-exit.json')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({
      reason,
      pid: process.pid,
      at: new Date().toISOString(),
      ...extra,
    }, null, 2))
  } catch {
    // best-effort — never block shutdown on breadcrumb IO
  }
}

/**
 * 解析 RIVET_SERVE_HOSTS_ALLOW：逗号分隔、去空、拒绝含 / 或 : 的形态（无端口/无路径）。
 * 全条目非法时返回 undefined 并 console.warn——保留「忽略」语义但不再静默：否则 LAN
 * bind + 全非法 allowlist 会无声退化为「任意 Host 放行」（P1 fail-open 缺陷修复）。
 */
export function parseHostsAllow(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined
  const out: string[] = []
  for (const part of raw.split(',')) {
    const h = part.trim().toLowerCase()
    if (!h || h.includes('/') || h.includes(':')) continue
    out.push(h)
  }
  if (out.length === 0) {
    console.warn(
      `[serve] RIVET_SERVE_HOSTS_ALLOW="${raw}" had no valid host entries ` +
        '(each must be a bare hostname/IP without "/" or ":"); allowlist stays ' +
        'unconfigured — on a LAN bind any Host passes (Bearer remains the only gate).',
    )
  }
  return out.length > 0 ? out : undefined
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
  if (mobileDirIdx >= 0 && (rawMobileDir == null || rawMobileDir === '')) {
    console.error('Missing value for --mobile-dir (e.g. --mobile-dir ./desktop/dist)')
    process.exit(1)
  }
  const mobileDir = rawMobileDir?.trim()

  let server: RunningServer
  try {
    server = await runServe({ port, ...(host ? { host } : {}), ...(mobileDir ? { mobileDir } : {}) })
  } catch (err) {
    console.error((err as Error).message)
    process.exit(1)
  }

  const shutdownServer = () => {
    server.close(() => process.exit(0))
  }
  process.on('SIGINT', () => {
    writeExitBreadcrumb('signal', { signal: 'SIGINT' })
    shutdownServer()
  })
  process.on('SIGTERM', () => {
    writeExitBreadcrumb('signal', { signal: 'SIGTERM' })
    shutdownServer()
  })
  installParentWatchdog(({ ppid, misses }) => {
    console.error(`[serve] parent process gone (pid ${ppid}, ${misses} consecutive probe misses) — shutting down sidecar`)
    writeExitBreadcrumb('parent-gone', { ppid, misses })
    shutdownServer()
  })

  // Last-resort: SIGKILL MCP children even if shutdownServer threw.
  process.on('exit', () => {
    try { server.shared.mcpManager?.killChildrenSync?.() } catch { /* best-effort */ }
  })

  const displayHost = host === '0.0.0.0' ? '0.0.0.0 (all interfaces)' : (host ?? '127.0.0.1')
  console.log(`Rivet Runtime API listening on http://${displayHost}:${port}`)
  console.log('Endpoints: GET /status, POST /abort, POST /prompt, /sessions/*')
}

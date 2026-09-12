/**
 * /config/* routes — provider + API key management for the desktop settings UI.
 * All routes are Bearer-gated (fail-closed).
 *
 *   GET    /config/providers                list providers with key status
 *   POST   /config/providers                add/update a provider (setup flow)
 *   POST   /config/providers/custom         create a new OpenAI-compatible provider from scratch
 *   DELETE /config/providers/:name          remove a provider
 *   DELETE /config/providers/:name/models/:modelId  remove a model from a provider
 *   POST   /config/providers/:name/key      set API key (inline or env)
 *   DELETE /config/providers/:name/key      clear the stored key, keep the provider (default provider allowed)
 *   POST   /config/providers/test-key       probe a key against a provider's /models (setup-time validation; apiKey optional → falls back to the provider's stored key; ok responses carry the fetched model id list)
 *   POST   /config/providers/:name/default  set as default provider
 *   GET    /config/balance                  query DeepSeek account balance (official API)
 *   GET    /config/autonomy                 autonomy brake mode + checkpoint interval (C3)
 *   PUT    /config/autonomy                 set autonomy brake mode / checkpoint interval (C3)
 *   GET    /config/computer-use             Computer Use status: platform, system permissions, app grants
 *   POST   /config/computer-use/revoke      revoke an app's "always allow" grant ({ app })
 *   GET    /config/permission-dirs          Codex-style standing directory grants (read/write, exists probe)
 *   PUT    /config/permission-dirs          set standing directory grants; additions apply immediately
 *   GET    /config/path-grants              approval-time remembered dirs for a workspace (?cwd=)
 *   DELETE /config/path-grants              revoke one remembered dir (?cwd=&path=); effective immediately
 *   GET    /config/vision-model             vision bridge model (provider/model/prompt/maxTokens/fallback)
 *   PUT    /config/vision-model             set/clear the vision bridge
 *   GET    /config/vision-auto-bridge       auto-pick a vision bridge when unconfigured (opt-in)
 *   PUT    /config/vision-auto-bridge       toggle the auto-bridge opt-in
 */
import { decodeRouteParam, type RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import {
  loadConfig,
  getApiKeyStatus,
  setupProvider,
  registerProvider,
  updateProviderTunables,
  removeProvider,
  removeModel,
  clearApiKey,
  setDefaultProvider,
  setApiKey,
  setApiKeyEnv,
  setProviderAllowProFallback,
  getRoutingConfig,
  setRoutingConfig,
  getEditorConfig,
  setEditorConfig,
  getShellConfig,
  setShellConfig,
  getCheckpointConfig,
  setCheckpointConfig,
  getApprovalConfig,
  setApprovalConfig,
  getToolPresetConfig,
  setToolPresetConfig,
  getRuntimeLeanConfig,
  setRuntimeLeanConfig,
  getNetworkConfig,
  setNetworkConfig,
  getMirrorConfig,
  setMirrorConfig,
  getPrDefaultsConfig,
  setPrDefaultsConfig,
  getPermissionDirs,
  setPermissionDirs,
  getVisionAutoBridge,
  getVisionModelConfig,
  registerVisionModelConfig,
  setVisionAutoBridge,
  setVisionModelConfig,
  getGreetingConfig,
  setGreetingConfig,
  getDefaultDomainConfig,
  setDefaultDomainConfig,
  getFetchConfig,
  setFetchConfig,
  getSearchConfig,
  setSearchApiKey,
  setSearchConfig,
  getDefaultModelConfig,
  setDefaultModelConfig,
  getDeliveryConfig,
  setDeliveryConfig,
} from '../config/manager.js'
import { applyConfiguredPathGrants, listPersistedGrants, revokeGrant } from '../tools/path-grants.js'
import { expandHome } from '../platform.js'
import { resolve, isAbsolute } from 'node:path'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { join } from 'node:path'
import { rivetHome } from '../config/paths.js'
import { isKeylessProviderEntry } from '../config/provider-presets.js'
import type { ProviderRetryConfig } from '../config/retry-schema.js'
import { allPresetKeys, resolvePreset, resolvePresetBaseUrl, resolvePresetLabel } from '../api/pro-registry.js'
import { modelConfigSchema, type ModelConfig } from '../config/schema.js'
import { queryDeepSeekBalance, type BalanceResult } from '../api/balance-client.js'
import { discoverVisionModels, validateVisionModel } from '../api/vision-model-onboarding.js'
import { probeProviderKey } from '../api/key-probe.js'
import { probeProvider } from '../api/provider-probe.js'
import { resolveApiKey } from '../api/factory.js'
import { getDeepSeekUserSummary, getDeepSeekCostReport } from '../api/deepseek-platform-client.js'
import { listGrantedApps, revokeApp } from '../tools/computer-use/app-grants.js'
import { computerUseModulePresent, isComputerUseSupportedPlatform, loadComputerUseImpl } from '../tools/computer-use/bridge.js'
import { isProFeatureEnabled } from '../config/pro-license.js'
import { starDomainRegistry } from '../agent/star-domain-registry.js'

function withAuth(handler: RouteHandler, apiToken?: string): RouteHandler {
  return async (body, params, headers, res) => {
    if (!isAuthorizedRequest({ body, headers }, apiToken)) {
      return { status: 401, body: { error: 'Unauthorized' } }
    }
    return handler(body, params, headers, res)
  }
}

/** /config/providers/test-key 与 /config/providers/test 共用的 key+baseUrl
 *  解析链（2026-09-09 审查 P2 收口：两端点曾逐字重复，独立演化会静默分叉——
 *  将来任一端点加能力改这里即可）。优先级：显式 body 覆盖 → 存量 provider
 *  配置（resolveApiKey 物化 keyRef/apiKeyEnv）→ preset baseUrl（preset 带
 *  每 provider 正确端点，如 zhipu-vision 用 PaaS 而非 coding 端点）。 */
function resolveProviderProbeTarget(
  provider: string,
  apiKey: string | undefined,
  baseUrlOverride: string | undefined,
): { apiKey: string; baseUrl: string } | { error: string } {
  // apiKey 可选：缺省时用该 provider 的存储 Key（keyRef 物化 / apiKeyEnv）——
  // 已配置 provider 上的「拉取模型列表/测试调用」不应要求用户重输 Key。
  let resolvedKey = apiKey
  if (!resolvedKey) {
    const stored = loadConfig().provider.providers[provider]
    if (stored) {
      try { resolvedKey = resolveApiKey(stored) } catch { resolvedKey = undefined }
    }
  }
  if (!resolvedKey) return { error: 'apiKey is required (or set a key on the provider first)' }
  let baseUrl = baseUrlOverride
  if (!baseUrl) {
    const cfg = loadConfig()
    baseUrl = cfg.provider.providers[provider]?.baseUrl ?? resolvePresetBaseUrl(provider)
  }
  if (!baseUrl) return { error: `cannot resolve baseUrl for provider "${provider}"` }
  return { apiKey: resolvedKey, baseUrl }
}

interface ParsedVisionCredentials {
  baseUrl?: string
  providerName?: string
  apiKey?: string
  apiKeyEnv?: string
  error?: string
}

/** Resolve only nonblank credential input; env values never leave this boundary. */
function parseVisionCredentials(body: unknown): ParsedVisionCredentials {
  const { baseUrl, providerName, apiKey, apiKeyEnv } = (body ?? {}) as Record<string, unknown>
  if (baseUrl !== undefined && typeof baseUrl !== 'string') return { error: 'baseUrl must be a string' }
  if (providerName !== undefined && typeof providerName !== 'string') return { error: 'providerName must be a string' }
  if (apiKey !== undefined && typeof apiKey !== 'string') return { error: 'apiKey must be a string' }
  if (apiKeyEnv !== undefined && typeof apiKeyEnv !== 'string') return { error: 'apiKeyEnv must be a string' }

  const normalizedKey = typeof apiKey === 'string' ? apiKey.trim() : undefined
  const normalizedEnv = typeof apiKeyEnv === 'string' ? apiKeyEnv.trim() : undefined
  if (apiKey !== undefined && !normalizedKey) return { error: 'apiKey must not be blank' }
  if (apiKeyEnv !== undefined && !normalizedEnv) return { error: 'apiKeyEnv must not be blank' }
  if (normalizedKey && normalizedEnv) return { error: 'apiKey and apiKeyEnv cannot both be set' }
  if (normalizedEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalizedEnv)) {
    return { error: 'apiKeyEnv must be a valid environment variable name' }
  }
  const resolvedKey = normalizedKey ?? (normalizedEnv ? process.env[normalizedEnv]?.trim() : undefined)
  if (normalizedEnv && !resolvedKey) return { error: `Environment variable "${normalizedEnv}" is not set or is blank in the server process` }
  return {
    ...(typeof baseUrl === 'string' && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
    ...(typeof providerName === 'string' && providerName.trim() ? { providerName: providerName.trim() } : {}),
    ...(resolvedKey ? { apiKey: resolvedKey } : {}),
    ...(normalizedEnv ? { apiKeyEnv: normalizedEnv } : {}),
  }
}

export interface ProviderListItem {
  name: string
  label: string
  baseUrl: string
  isDefault: boolean
  keyStatus: { source: 'inline' | 'env' | 'none'; ref: string }
  /** 无需 API key 的端点：keyless 预设（ollama），或未配任何密钥材料的自定义
   *  provider（桌面表单 API Key 可选，用户有意空着 = keyless 端点）。
   *  模型选择器据此区分「keyless」与「该配 key 而没配」——前者照常列出。 */
  keyless: boolean
  models: { id: string; alias?: string; supportsVision?: boolean }[]
  isPreset: boolean
  allowProFallback: boolean
  /** 三态：undefined = 按名称/baseUrl 启发式；true/false 压过启发式。 */
  slowThinking?: boolean
  /** 显式重试上限（0–20）；undefined = 按错误类别默认（issue #75）。 */
  maxRetries?: number
  /** 重试策略块（退避/类别覆盖/客户端限速）；undefined = 未配置（历史行为）。 */
  retry?: ProviderRetryConfig
}

export interface ConfigRouteHooks {
  onApprovalConfigChanged?: (approval: string) => void
  /** provider/模型/密钥写盘成功后的快照刷新通知（serve 侧据此原地重建启动快照，
   *  「替换 key」「inline 压 env」对新解析即刻生效）。实现必须 fail-open。 */
  onProviderConfigChanged?: () => void
}

export function buildConfigRoutes(apiToken?: string, hooks?: ConfigRouteHooks): Record<string, RouteHandler> {
  // 变更落盘成功后的通知；hook 异常绝不让已落盘的变更端点失败（双保险，
  //  serve 侧 refreshServeContext 自身也 fail-open）。
  const notifyProviderConfigChanged = (): void => {
    try { hooks?.onProviderConfigChanged?.() } catch { /* best-effort */ }
  }
  return {
    'GET /config/providers': withAuth(() => {
      const cfg = loadConfig()
      const defaultName = cfg.provider.default
      // 推荐序：官方 deepseek 第一、pro 注册的 spark 紧随其后，其余保持 allPresetKeys 原序。
      // 已配置列表也按此排序，避免 Object.entries 插入序把 spark 甩到末尾。
      const presetRank = new Map(allPresetKeys().map((k, i) => [k, i]))
      const providers: ProviderListItem[] = []

      for (const [name, p] of Object.entries(cfg.provider.providers)) {
        const preset = resolvePreset(name)
        providers.push({
          name,
          label: resolvePresetLabel(name) ?? name,
          baseUrl: p.baseUrl,
          isDefault: name === defaultName,
          keyStatus: getApiKeyStatus(name),
          // keyless 判定走 provider-presets 单一事实源（预设 keyless 或自定义无密钥材料）——
          // keyStatus 恒 none 的 keyless 端点靠本标记与「该配没配」区分。
          keyless: isKeylessProviderEntry(name, p),
          models: p.models.map(m => ({ id: m.id, alias: m.alias, description: m.description, contextWindow: m.contextWindow, maxTokens: m.maxTokens, supportsVision: m.supportsVision })),
          isPreset: preset !== undefined,
          // 预设模型全集——UI 标注「预设含 N 个模型」（配置快照经
          // migratePresetModelBackfill 已对齐预设，此清单用于来源标注）。
          ...(preset && 'static' in preset
            ? { presetModelIds: preset.static.provider.models.map(m => m.id) }
            : {}),
          allowProFallback: p.allowProFallback ?? false,
          ...(p.slowThinking !== undefined ? { slowThinking: p.slowThinking } : {}),
          ...(p.maxRetries !== undefined ? { maxRetries: p.maxRetries } : {}),
          ...(p.retry !== undefined ? { retry: p.retry } : {}),
        })
      }
      providers.sort((a, b) => {
        const ra = presetRank.get(a.name) ?? Number.MAX_SAFE_INTEGER
        const rb = presetRank.get(b.name) ?? Number.MAX_SAFE_INTEGER
        if (ra !== rb) return ra - rb
        return a.name.localeCompare(b.name)
      })

      // 合并视图：静态 + pro-registry 运行时注册（开源版注册表恒空 = 现状）
      const unconfigured = allPresetKeys()
        .filter(k => !cfg.provider.providers[k])
        .map(k => {
          const r = resolvePreset(k)
          const label = r && 'static' in r ? r.static.label : (r as { label?: string } | undefined)?.label
          const description = r && 'static' in r ? r.static.description : (r as { description?: string } | undefined)?.description
          const defaultModelId = r && 'static' in r ? r.static.defaultModelId : (r as { defaultModelId?: string } | undefined)?.defaultModelId
          const keyUrl = r && 'static' in r ? r.static.keyUrl : (r as { keyUrl?: string } | undefined)?.keyUrl
          // 预设模型预览——配置前就能看到「配了会得到什么」（ZCode 对标）
          const modelIds = r && 'static' in r ? r.static.provider.models.map(m => m.id) : undefined
          return { key: k, label: label ?? k, description, defaultModelId, keyUrl, modelIds }
        })

      return { status: 200, body: { providers, unconfigured, presetKeys: allPresetKeys() } }
    }, apiToken),

    'POST /config/providers': withAuth((body) => {
      const { providerName, apiKey, apiKeyEnv, baseUrl, makeDefault, model, models, allowProFallback } = body as {
        providerName?: string
        apiKey?: string
        apiKeyEnv?: string
        baseUrl?: string
        makeDefault?: boolean
        model?: ModelConfig
        /** 批量模型回填（桌面端「每行一个」批量粘贴 / 拉取勾选导入）——
         *  每项走与 model 相同的 modelConfigSchema 校验与合并语义。 */
        models?: Array<Partial<ModelConfig> & { id: string }>
        allowProFallback?: boolean
      }
      if (!providerName) return { status: 400, body: { error: 'providerName is required' } }

      let parsedModel: ModelConfig | undefined
      if (model) {
        const result = modelConfigSchema.safeParse(model)
        if (!result.success) {
          return { status: 400, body: { error: `Invalid model: ${result.error.message}` } }
        }
        parsedModel = result.data
      }

      // 与 /custom 的 models 校验同构：逐项 safeParse，任何一项不合法整单 400——
      // 批量路径不做部分落盘（半批入库的「哪些成功了」对 UI 是坏状态）。
      let parsedModels: Array<Partial<ModelConfig> & { id: string }> | undefined
      if (models !== undefined) {
        if (!Array.isArray(models) || models.length === 0) {
          return { status: 400, body: { error: 'models must be a non-empty array when provided' } }
        }
        for (const m of models) {
          const result = modelConfigSchema.safeParse(m)
          if (!result.success) {
            return { status: 400, body: { error: `Invalid model in models[]: ${result.error.message}` } }
          }
        }
        parsedModels = models
      }

      try {
        setupProvider({ providerName, apiKey, apiKeyEnv, baseUrl, model: parsedModel, models: parsedModels, makeDefault, allowProFallback })
        notifyProviderConfigChanged()
        return { status: 200, body: { ok: true, providerName } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    'POST /config/providers/custom': withAuth((body) => {
      // Materialize a custom provider through the unified registration core.
      const { providerName, apiKey, apiKeyEnv, baseUrl, makeDefault, model, models, allowProFallback, protocol, force, slowThinking } = body as {
        providerName?: string
        apiKey?: string
        apiKeyEnv?: string
        baseUrl?: string
        makeDefault?: boolean
        model?: unknown
        models?: unknown[]
        allowProFallback?: boolean
        protocol?: 'openai' | 'anthropic'
        force?: boolean
        slowThinking?: boolean
      }
      if (!providerName) return { status: 400, body: { error: 'providerName is required' } }
      if (!baseUrl) return { status: 400, body: { error: 'baseUrl is required' } }
      if (models !== undefined && !Array.isArray(models)) {
        return { status: 400, body: { error: 'models must be an array' } }
      }
      if (!model && (!models || models.length === 0)) {
        return { status: 400, body: { error: 'model or models is required' } }
      }
      if (protocol !== undefined && protocol !== 'openai' && protocol !== 'anthropic') {
        return { status: 400, body: { error: `Invalid protocol: ${String(protocol)} (expected 'openai' or 'anthropic')` } }
      }

      const rawModels = models ?? [model]
      const parsedModels = []
      for (const raw of rawModels) {
        const result = modelConfigSchema.safeParse(raw)
        if (!result.success) {
          return { status: 400, body: { error: `Invalid model: ${result.error.message}` } }
        }
        parsedModels.push(result.data)
      }

      try {
        registerProvider({
          providerName,
          baseUrl,
          ...(apiKey ? { apiKey } : {}),
          ...(apiKeyEnv ? { apiKeyEnv } : {}),
          ...(protocol ? { protocol } : {}),
          models: parsedModels,
          makeDefault,
          allowProFallback,
          force,
          ...(slowThinking !== undefined ? { slowThinking } : {}),
        })
        notifyProviderConfigChanged()
        return { status: 200, body: { ok: true, providerName } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    // 字段级更新已存在 provider 的 tunable 参数（slowThinking / firstByteTimeoutMs /
    // thinkingStallTimeoutMs）。fields 中值为 null 的键 = 删除恢复启发式——
    // undefined 属性会被 JSON.stringify 丢弃（传输层静默失效），null 才是
    // 可传输的删键编码（manager 层 null 与 undefined 同视为删键）。
    'POST /config/providers/tunables': withAuth((body) => {
      const { providerName, fields } = (body ?? {}) as {
        providerName?: string
        fields?: Record<string, unknown>
      }
      if (!providerName) return { status: 400, body: { error: 'providerName is required' } }
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
        return { status: 400, body: { error: 'fields object is required' } }
      }
      try {
        const provider = updateProviderTunables(providerName, fields)
        notifyProviderConfigChanged()
        return {
          status: 200,
          body: {
            ok: true,
            providerName,
            tunables: {
              slowThinking: provider.slowThinking,
              firstByteTimeoutMs: provider.firstByteTimeoutMs,
              thinkingStallTimeoutMs: provider.thinkingStallTimeoutMs,
            },
          },
        }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    'DELETE /config/providers/:name': withAuth((_body, params) => {
      const name = decodeRouteParam(params?.name)
      if (!name) return { status: 400, body: { error: 'provider name is required' } }
      try {
        removeProvider(name)
        notifyProviderConfigChanged()
        return { status: 200, body: { ok: true, removed: name } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    'DELETE /config/providers/:name/models/:modelId': withAuth((_body, params) => {
      const name = decodeRouteParam(params?.name)
      // decodeURIComponent 配合客户端的 encodeURIComponent——modelId 可能含空格、
      // 斜杠等特殊字符，URL 路径中为 percent-encoded 形式，需解码后才能与配置中的
      // 原始 ID 匹配。
      const modelId = params?.modelId ? decodeURIComponent(params.modelId) : undefined
      if (!name || !modelId) return { status: 400, body: { error: 'provider name and modelId are required' } }
      try {
        removeModel(name, modelId)
        notifyProviderConfigChanged()
        return { status: 200, body: { ok: true, removed: modelId } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    'POST /config/providers/:name/key': withAuth((body, params) => {
      const name = decodeRouteParam(params?.name)
      if (!name) return { status: 400, body: { error: 'provider name is required' } }
      const { apiKey, apiKeyEnv: envVar } = body as { apiKey?: string; apiKeyEnv?: string }
      try {
        if (apiKey) setApiKey(name, apiKey)
        else if (envVar) setApiKeyEnv(name, envVar)
        else return { status: 400, body: { error: 'apiKey or apiKeyEnv required' } }
        notifyProviderConfigChanged()
        return { status: 200, body: { ok: true, keyStatus: getApiKeyStatus(name) } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    // 清除已保存的 key 但保留 provider（默认 provider 允许）——「首次安装删不掉
    // key」的修复点。env 注入的 key 清不掉时 keyStatus 如实报回 source:'env'。
    'DELETE /config/providers/:name/key': withAuth((_body, params) => {
      const name = decodeRouteParam(params?.name)
      if (!name) return { status: 400, body: { error: 'provider name is required' } }
      try {
        const result = clearApiKey(name)
        notifyProviderConfigChanged()
        return { status: 200, body: { ok: true, keyStatus: result.keyStatus, secretDeleted: result.secretDeleted } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    // Probe a key against a provider's /models before saving it. Avoids writing
    // an invalid key that only surfaces as a 401 when the user later sends a msg.
    // Body: { provider: string, apiKey: string }. Provider resolved to baseUrl
    // from preset (zhipu-vision uses PaaS endpoint, not coding) or stored config.
    'POST /config/providers/test-key': withAuth(async (body) => {
      const { provider, apiKey, baseUrl: override, protocol } = body as {
        provider?: string
        apiKey?: string
        baseUrl?: string
        protocol?: 'openai' | 'anthropic'
      }
      if (!provider) return { status: 400, body: { error: 'provider is required' } }
      const target = resolveProviderProbeTarget(provider, apiKey, override)
      if ('error' in target) return { status: 400, body: { error: target.error } }
      const result = await probeProviderKey(target.apiKey, target.baseUrl, protocol ?? 'openai')
      return { status: 200, body: result }
    }, apiToken),

    // Completion 级「测试模型调用」真测（2026-09-09 用户需求）：与 test-key 的
    // /models 零 token 探测区分——本端点发最小 chat completion，验证模型真的能
    // 完成一次对话（模型名错/配额/网关 404 只在 completion 层暴露）。探测消耗
    // 约几 token（probeProvider 最小 prompt）。key/baseUrl 解析链与 test-key
    // 同源（resolveProviderProbeTarget 共享 helper，防两端点漂移）。
    //
    // 语义分层（2026-09-09 用户反馈「能对话但测试没用」）：UI 的「测试连接」
    // 按钮在模型 id 输入框之前，用户只填 URL+key 就点测试是高频路径。规则：
    //  - model 有值 → completion 真测，ok=completionOk（含 vision 三态，显式
    //    false 压制「模型名含视觉词 → 图片探测」启发式）；
    //  - model 未填 → skipCompletion 只验 /models（URL+key 连通性）——不再
    //    盲测 models[0]（撞 embedding/未开通型号会误报，且用户此时要测的是
    //    「URL 连接」）：/models 200 → ok=true + completionSkipped（UI 提示
    //    「未测模型对话」）；/models 失败 → ok=false 带原因。
    'POST /config/providers/test': withAuth(async (body) => {
      const { provider, apiKey, baseUrl: override, protocol, model, vision } = body as {
        provider?: string
        apiKey?: string
        baseUrl?: string
        protocol?: 'openai' | 'anthropic'
        model?: string
        vision?: boolean
      }
      if (!provider) return { status: 400, body: { error: 'provider is required' } }
      const target = resolveProviderProbeTarget(provider, apiKey, override)
      if ('error' in target) return { status: 400, body: { error: target.error } }
      const report = await probeProvider({
        baseUrl: target.baseUrl, apiKey: target.apiKey, protocol: protocol ?? 'openai',
        providerName: provider, probeModel: model || undefined, vision,
        skipCompletion: !model,
      })
      const completionSkipped = !report.probedModel
      const ok = report.completionOk || (completionSkipped && report.modelsOk)
      return {
        status: 200,
        body: {
          ok,
          completionOk: report.completionOk,
          completionSkipped,
          modelsOk: report.modelsOk,
          latencyMs: report.latencyMs,
          probedModel: report.probedModel,
          models: report.models,
          // 成功且未测 completion 时不带 error（UI 走「未测」提示而非报错）；
          // 失败路径首个错误优先（/models 失败详情或 completion 失败原因）。
          ...(ok ? {} : (report.errors[0] ? { error: report.errors[0] } : {})),
        },
      }
    }, apiToken),

    'POST /config/providers/:name/default': withAuth((_body, params) => {
      const name = decodeRouteParam(params?.name)
      if (!name) return { status: 400, body: { error: 'provider name is required' } }
      try {
        setDefaultProvider(name)
        notifyProviderConfigChanged()
        return { status: 200, body: { ok: true, default: name } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    'PUT /config/providers/:name/allow-pro-fallback': withAuth((body, params) => {
      const name = decodeRouteParam(params?.name)
      if (!name) return { status: 400, body: { error: 'provider name is required' } }
      const { allowProFallback } = (body ?? {}) as { allowProFallback?: unknown }
      if (typeof allowProFallback !== 'boolean') {
        return { status: 400, body: { error: 'allowProFallback boolean is required' } }
      }
      try {
        setProviderAllowProFallback(name, allowProFallback)
        notifyProviderConfigChanged()
        return { status: 200, body: { ok: true, allowProFallback } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    // Sub-agent / review model routing (agent.review + workers blocks).
    'GET /config/routing': withAuth(() => {
      return { status: 200, body: getRoutingConfig() }
    }, apiToken),

    'PUT /config/routing': withAuth((body) => {
      const { review, workers, council } = (body ?? {}) as { review?: unknown; workers?: unknown; council?: unknown }
      if (review === undefined && workers === undefined && council === undefined) {
        return { status: 400, body: { error: 'review, workers or council is required' } }
      }
      try {
        const result = setRoutingConfig({ review, workers, council })
        return { status: 200, body: { ok: true, ...result } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    'GET /config/editor': withAuth(() => {
      return { status: 200, body: getEditorConfig() }
    }, apiToken),

    'PUT /config/editor': withAuth((body) => {
      const { platform, eol } = (body ?? {}) as { platform?: unknown; eol?: unknown }
      if (platform === undefined && eol === undefined) {
        return { status: 400, body: { error: 'platform or eol is required' } }
      }
      try {
        return { status: 200, body: { ok: true, ...setEditorConfig({ platform, eol }) } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    // Windows Git Bash override + cross-platform git executable override for the
    // desktop settings UI. `exists` lets the UI warn about a stale/typo'd path
    // without blocking the save. Takes effect on the next sidecar restart.
    'GET /config/shell': withAuth(() => {
      const cfg = getShellConfig()
      return {
        status: 200,
        body: {
          ...cfg,
          exists: cfg.gitBashPath ? existsSync(cfg.gitBashPath) : null,
          gitExists: cfg.gitPath ? existsSync(cfg.gitPath) : null,
        },
      }
    }, apiToken),

    'PUT /config/shell': withAuth((body) => {
      const { gitBashPath, gitPath } = (body ?? {}) as { gitBashPath?: unknown; gitPath?: unknown }
      if (gitBashPath === undefined && gitPath === undefined) {
        return { status: 400, body: { error: 'gitBashPath or gitPath is required' } }
      }
      try {
        const next = setShellConfig({ gitBashPath, gitPath })
        return {
          status: 200,
          body: {
            ok: true,
            ...next,
            exists: next.gitBashPath ? existsSync(next.gitBashPath) : null,
            gitExists: next.gitPath ? existsSync(next.gitPath) : null,
          },
        }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    // 工具档位 preset（minimal/frontend/full）——下个会话生效。
    'GET /config/tool-preset': withAuth(() => {
      return { status: 200, body: getToolPresetConfig() }
    }, apiToken),

    'PUT /config/tool-preset': withAuth((body) => {
      const { preset } = (body ?? {}) as { preset?: unknown }
      if (preset === undefined) {
        return { status: 400, body: { error: 'preset is required' } }
      }
      try {
        return { status: 200, body: { ok: true, ...setToolPresetConfig({ preset }) } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    // Runtime lean profile — expands into minimal tools / lean prompt / no
    // embeddings / tighter session pool. Takes effect next session (pool caps
    // on next sidecar start).
    'GET /config/runtime-lean': withAuth(() => {
      return { status: 200, body: getRuntimeLeanConfig() }
    }, apiToken),

    'PUT /config/runtime-lean': withAuth((body) => {
      const { lean, maxLoadedSessions, idleAgentTtlMs, maxEventsDiskBytes, domains } = (body ?? {}) as {
        lean?: unknown
        maxLoadedSessions?: unknown
        idleAgentTtlMs?: unknown
        maxEventsDiskBytes?: unknown
        domains?: Record<string, unknown> | null
      }
      if (
        lean === undefined
        && maxLoadedSessions === undefined
        && idleAgentTtlMs === undefined
        && maxEventsDiskBytes === undefined
        && domains === undefined
      ) {
        return { status: 400, body: { error: 'lean or a pool/disk cap or domains is required' } }
      }
      try {
        return {
          status: 200,
          body: {
            ok: true,
            ...setRuntimeLeanConfig({ lean, maxLoadedSessions, idleAgentTtlMs, maxEventsDiskBytes, domains }),
          },
        }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    // 默认星域（auto | tianshu | …）+ Auto 关键词路由——下个会话生效。
    'GET /config/default-domain': withAuth(() => {
      const domains = starDomainRegistry.list().map(d => ({ id: d.id, name: d.name, motto: d.motto }))
      return { status: 200, body: { ...getDefaultDomainConfig(), domains } }
    }, apiToken),

    'PUT /config/default-domain': withAuth((body) => {
      const { defaultDomain, domainKeywordRouting } = (body ?? {}) as {
        defaultDomain?: unknown
        domainKeywordRouting?: unknown
      }
      if (defaultDomain === undefined && domainKeywordRouting === undefined) {
        return { status: 400, body: { error: 'defaultDomain or domainKeywordRouting is required' } }
      }
      // 域 id 有效性在这一层校验（registry 属 agent 层，config manager 不反向依赖）。
      if (defaultDomain !== undefined && defaultDomain !== 'auto') {
        if (typeof defaultDomain !== 'string' || !starDomainRegistry.has(defaultDomain)) {
          return { status: 400, body: { error: `unknown domain: ${String(defaultDomain)}. Use "auto" or one of: ${starDomainRegistry.getDomainIds().join(', ')}` } }
        }
      }
      try {
        return { status: 200, body: { ok: true, ...setDefaultDomainConfig({ defaultDomain, domainKeywordRouting }) } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    // 默认模型（provider:modelId）——下个会话生效。TUI model picker 按 s 键写入。
    'GET /config/default-model': withAuth(() => {
      return { status: 200, body: getDefaultModelConfig() }
    }, apiToken),

    'PUT /config/default-model': withAuth((body) => {
      const { defaultModel } = (body ?? {}) as { defaultModel?: unknown }
      if (defaultModel === undefined) {
        return { status: 400, body: { error: 'defaultModel is required ("provider:modelId" format)' } }
      }
      try {
        const result = setDefaultModelConfig({ defaultModel })
        notifyProviderConfigChanged()
        return { status: 200, body: { ok: true, ...result } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    // C3 — Auto mode checkpoint interval for the desktop/TUI settings UI.
    'GET /config/checkpoint': withAuth(() => {
      return { status: 200, body: getCheckpointConfig() }
    }, apiToken),

    'PUT /config/checkpoint': withAuth((body) => {
      const { checkpointEveryTurns } = (body ?? {}) as {
        checkpointEveryTurns?: unknown
      }
      if (checkpointEveryTurns === undefined) {
        return { status: 400, body: { error: 'checkpointEveryTurns is required' } }
      }
      try {
        return { status: 200, body: { ok: true, ...setCheckpointConfig({ checkpointEveryTurns }) } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    // Approval mode (授权档位) — 桌面端设置页：监督/默认/自治/完全访问。
    'GET /config/approval': withAuth(() => {
      return { status: 200, body: getApprovalConfig() }
    }, apiToken),

    'PUT /config/approval': withAuth((body) => {
      const { approval, unsandboxed } = (body ?? {}) as { approval?: unknown; unsandboxed?: unknown }
      if (approval === undefined) {
        return { status: 400, body: { error: 'approval is required' } }
      }
      try {
        const result = setApprovalConfig({ approval, unsandboxed })
        // 实时广播给启动快照与存活 agent（无 hook 的调用方——测试/CLI——行为不变）
        if (hooks?.onApprovalConfigChanged && typeof approval === 'string') {
          try { hooks.onApprovalConfigChanged(approval) } catch { /* 广播失败不影响落盘结果 */ }
        }
        return { status: 200, body: { ok: true, ...result } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    // HTTP proxy for web_fetch / import_resource (Clash etc.). Empty = follow env.
    'GET /config/network': withAuth(() => {
      return { status: 200, body: getNetworkConfig() }
    }, apiToken),

    'PUT /config/network': withAuth((body) => {
      const { proxy, noProxy } = (body ?? {}) as { proxy?: unknown; noProxy?: unknown }
      if (proxy === undefined && noProxy === undefined) {
        return { status: 400, body: { error: 'proxy or noProxy is required' } }
      }
      try {
        return { status: 200, body: { ok: true, ...setNetworkConfig({ proxy, noProxy }) } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    // web_fetch timeout / UA / maxResponseBytes / extractMainContent.
    // Takes effect on the next sidecar start (bootstrap.ts → buildFetchOptions).
    'GET /config/fetch': withAuth(() => {
      return { status: 200, body: getFetchConfig() }
    }, apiToken),

    'PUT /config/fetch': withAuth((body) => {
      const input = (body ?? {}) as Record<string, unknown>
      if (Object.keys(input).length === 0) {
        return { status: 400, body: { error: 'at least one field is required' } }
      }
      try {
        return { status: 200, body: { ok: true, ...setFetchConfig(input) } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    // web_search backends / timeout / region.
    // Takes effect on the next sidecar start (bootstrap.ts → buildSearchBackends).
    'GET /config/search': withAuth(() => {
      return { status: 200, body: getSearchConfig() }
    }, apiToken),

    'PUT /config/search': withAuth((body) => {
      const input = (body ?? {}) as Record<string, unknown>
      if (Object.keys(input).length === 0) {
        return { status: 400, body: { error: 'at least one field is required' } }
      }
      try {
        return { status: 200, body: { ok: true, ...setSearchConfig(input) } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    // Set/clear a search backend's inline API key (mirrors POST /config/providers/:name/key).
    // GET /config/search never returns the plaintext — only the masked keyStatus.
    'POST /config/search/key': withAuth((body) => {
      const { backend, apiKey } = body as { backend?: string; apiKey?: string }
      if (!backend) return { status: 400, body: { error: 'backend is required' } }
      try {
        const keyStatus = setSearchApiKey(backend, apiKey ?? '')
        return { status: 200, body: { ok: true, backend, keyStatus } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    // Mirror acceleration (GitHub/npm/pip/go/rust) for users behind the GFW.
    // Takes effect on the next bash execution (bash.ts reloads mirrors each
    // call) — no restart needed. CLI equivalent: /mirror on|off|china|default.
    'GET /config/mirrors': withAuth(() => {
      return { status: 200, body: getMirrorConfig() }
    }, apiToken),

    'PUT /config/mirrors': withAuth((body) => {
      try {
        return { status: 200, body: { ok: true, mirrors: setMirrorConfig(body ?? {}) } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    // GitHub PR panel defaults (merge method / auto-fix / auto-merge / CI poll
    // cadence). Read by the desktop PR detail as the per-PR toggle initials.
    'GET /config/pr-defaults': withAuth(() => {
      return { status: 200, body: getPrDefaultsConfig() }
    }, apiToken),

    'PUT /config/pr-defaults': withAuth((body) => {
      try {
        return { status: 200, body: { ok: true, prDefaults: setPrDefaultsConfig(body ?? {}) } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    // Computer Use (desktop GUI automation) status for the desktop settings UI:
    // platform availability, Pro gating, system permission probe, and per-app grants.
    'GET /config/computer-use': withAuth(async () => {
      const cfg = loadConfig()
      // pro 实现缺席（公开构建无 src/pro/）时一律报不可用——不暴露半个功能。
      const moduleOk = computerUseModulePresent()
      const platformOk = isComputerUseSupportedPlatform(process.platform) && process.env.RIVET_COMPUTER_USE !== '0' && moduleOk
      const proEnabled = isProFeatureEnabled(cfg, 'computerUse')
      const proRequired = platformOk && !proEnabled
      const available = platformOk && proEnabled
      const grants = listGrantedApps().map(g => ({ app: g.app, grantedAt: g.grantedAt }))
      if (!available) {
        return { status: 200, body: { available: false, proRequired, platform: process.platform, permissions: null, grants } }
      }
      let permissions: { accessibility: boolean; screenRecording: boolean; detail: string } | null = null
      try {
        const impl = await loadComputerUseImpl()
        if (impl) permissions = await impl.createPlatformDriver().checkPermissions()
      } catch { /* probe failure → permissions unknown, UI shows a hint */ }
      return { status: 200, body: { available: true, proRequired: false, platform: process.platform, permissions, grants } }
    }, apiToken),

    // Codex-style standing directory grants for the desktop settings UI.
    // `exists` lets the UI warn about missing/typo'd paths without blocking the
    // save — applyConfiguredPathGrants skips non-existent entries fail-closed.
    'GET /config/permission-dirs': withAuth(() => {
      const dirs = getPermissionDirs()
      const probe = (p: string) => ({ path: p, exists: existsSync(resolve(expandHome(p))) })
      return {
        status: 200,
        body: {
          readDirs: dirs.additionalReadDirs.map(probe),
          writeDirs: dirs.additionalWriteDirs.map(probe),
        },
      }
    }, apiToken),

    'PUT /config/permission-dirs': withAuth((body) => {
      const { additionalReadDirs, additionalWriteDirs } = (body ?? {}) as {
        additionalReadDirs?: unknown
        additionalWriteDirs?: unknown
      }
      if (additionalReadDirs === undefined && additionalWriteDirs === undefined) {
        return { status: 400, body: { error: 'additionalReadDirs or additionalWriteDirs is required' } }
      }
      try {
        const before = getPermissionDirs()
        const next = setPermissionDirs({ additionalReadDirs, additionalWriteDirs })
        // Additions take effect immediately in this running sidecar (in-memory
        // grants for every live session). Removals cannot be revoked from the
        // in-memory store — the same root may also hold an approval-time grant —
        // so a removed entry stays effective until the next sidecar start.
        // force：用户刚保存的路径必须当场实测（新挂载的盘不能被 TTL 记忆挡住）。
        applyConfiguredPathGrants(next, { force: true })
        const removed = [
          ...before.additionalReadDirs.filter(d => !next.additionalReadDirs.includes(d)),
          ...before.additionalWriteDirs.filter(d => !next.additionalWriteDirs.includes(d)),
        ]
        const probe = (p: string) => ({ path: p, exists: existsSync(resolve(expandHome(p))) })
        return {
          status: 200,
          body: {
            ok: true,
            readDirs: next.additionalReadDirs.map(probe),
            writeDirs: next.additionalWriteDirs.map(probe),
            restartRequired: removed.length > 0,
          },
        }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    // Approval-time directory grants the user chose to remember. Keyed by
    // workspace (a grant for project A must never surface under project B), so
    // `cwd` is required rather than defaulting to the sidecar's own directory.
    'GET /config/path-grants': withAuth((_body, params) => {
      const cwd = params?.cwd
      if (!cwd || !isAbsolute(cwd)) {
        return { status: 400, body: { error: 'cwd (absolute path) is required' } }
      }
      return {
        status: 200,
        body: {
          grants: listPersistedGrants(cwd).map(g => ({
            path: g.root,
            mode: g.mode,
            grantedAt: g.grantedAt,
            exists: existsSync(g.root),
          })),
        },
      }
    }, apiToken),

    // Revoke is fail-safe (it only ever narrows access), and takes effect in
    // this running sidecar rather than at the next start — see revokeGrant.
    'DELETE /config/path-grants': withAuth((_body, params) => {
      const cwd = params?.cwd
      const path = params?.path
      if (!cwd || !isAbsolute(cwd)) {
        return { status: 400, body: { error: 'cwd (absolute path) is required' } }
      }
      if (!path) return { status: 400, body: { error: 'path is required' } }
      const removed = revokeGrant(path, { cwd })
      return { status: 200, body: { ok: true, removed } }
    }, apiToken),

    // Revoke an app's "always allow" grant. App name in body (may contain
    // spaces/unicode — avoids URL-encoding pitfalls in path params).
    'POST /config/computer-use/revoke': withAuth((body) => {
      const { app } = (body ?? {}) as { app?: unknown }
      if (typeof app !== 'string' || !app.trim()) {
        return { status: 400, body: { error: 'app is required' } }
      }
      const removed = revokeApp(app.trim())
      if (!removed) return { status: 404, body: { error: `No grant found for "${app.trim()}"` } }
      return { status: 200, body: { ok: true, grants: listGrantedApps().map(g => ({ app: g.app, grantedAt: g.grantedAt })) } }
    }, apiToken),

    // Vision bridge model: optional multimodal model used to describe images
    // when the primary model is not vision-capable.
    'GET /config/vision-model': withAuth(() => {
      return { status: 200, body: { config: getVisionModelConfig() } }
    }, apiToken),

    'PUT /config/vision-model': withAuth((body) => {
      const { config } = (body ?? {}) as { config?: unknown }
      try {
        const saved = setVisionModelConfig(config as Record<string, unknown> | null)
        return { status: 200, body: { ok: true, config: saved } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    'POST /config/vision-model/discover': withAuth(async (body) => {
      const { baseUrl, providerName, apiKey, apiKeyEnv, error } = parseVisionCredentials(body)
      if (error) return { status: 400, body: { error } }
      if (!baseUrl) return { status: 400, body: { error: 'baseUrl is required' } }
      try {
        const result = await discoverVisionModels({
          baseUrl,
          ...(apiKey ? { apiKey } : {}),
          ...(providerName ? { providerName } : {}),
        })
        return { status: 200, body: result }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    'POST /config/vision-model/onboard': withAuth(async (body) => {
      const { baseUrl, providerName, apiKey, apiKeyEnv, error } = parseVisionCredentials(body)
      const { modelId } = (body ?? {}) as { modelId?: unknown }
      if (error) return { status: 400, body: { error } }
      if (!providerName) return { status: 400, body: { error: 'providerName is required' } }
      if (!baseUrl) return { status: 400, body: { error: 'baseUrl is required' } }
      if (typeof modelId !== 'string' || !modelId.trim()) {
        return { status: 400, body: { error: 'modelId is required' } }
      }
      try {
        await validateVisionModel({
          baseUrl,
          ...(apiKey ? { apiKey } : {}),
          providerName,
          modelId: modelId.trim(),
        })
        const config = registerVisionModelConfig({
          providerName,
          baseUrl,
          // apiKeyEnv resolves only for the upstream validation request; config persists its name.
          ...(apiKey && !apiKeyEnv ? { apiKey } : {}),
          ...(apiKeyEnv ? { apiKeyEnv } : {}),
          modelId: modelId.trim(),
        })
        return { status: 200, body: { ok: true, config } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    // 未配 visionModel 时是否自动挑一个可用视觉模型做桥。默认关，因为开了就会把
    // 用户的图片发给一个用户从未为此选择过的 provider——桌面端得能自己开关它，
    // 否则单独部署桌面的用户只能去手改 config.json。
    'GET /config/vision-auto-bridge': withAuth(() => {
      return { status: 200, body: { enabled: getVisionAutoBridge() } }
    }, apiToken),

    'PUT /config/vision-auto-bridge': withAuth((body) => {
      const { enabled } = (body ?? {}) as { enabled?: unknown }
      if (typeof enabled !== 'boolean') {
        return { status: 400, body: { error: 'enabled must be a boolean' } }
      }
      return { status: 200, body: { ok: true, enabled: setVisionAutoBridge(enabled) } }
    }, apiToken),

    // Greeting LLM: welcome page dynamic greeting toggle + model selection.
    'GET /config/greeting': withAuth(() => {
      return { status: 200, body: { config: getGreetingConfig() } }
    }, apiToken),

    'PUT /config/greeting': withAuth((body) => {
      const { config } = (body ?? {}) as { config?: unknown }
      try {
        const saved = setGreetingConfig(config as Record<string, unknown> | null)
        return { status: 200, body: { ok: true, config: saved } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    // 交付不自动提交开关 — takes effect immediately (no restart needed;
    // deliver_task reads config fresh each call via B1Context injection).
    'GET /config/delivery': withAuth(() => {
      return { status: 200, body: getDeliveryConfig() }
    }, apiToken),

    'PUT /config/delivery': withAuth((body) => {
      const { autoCommit } = (body ?? {}) as { autoCommit?: unknown }
      if (autoCommit === undefined) {
        return { status: 400, body: { error: 'autoCommit is required (boolean)' } }
      }
      try {
        return { status: 200, body: { ok: true, ...setDeliveryConfig({ autoCommit }) } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    'GET /config/balance': withAuth(async () => {
      // 查 DeepSeek 官方账户余额。仅 DeepSeek 官方端点支持（其他 provider 返回 null）。
      const cfg = loadConfig()
      const provider = cfg.provider.providers[cfg.provider.default]
      if (!provider) return { status: 200, body: { balance: null as BalanceResult | null } }
      const apiKey = provider.apiKey ?? (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined)
      const balance = await queryDeepSeekBalance(apiKey, provider.baseUrl)
      return { status: 200, body: { balance } }
    }, apiToken),

    // DeepSeek 平台账户摘要：当天/当月花费、余额、Flash/Pro 用量。
    'GET /config/deepseek/summary': withAuth(async () => {
      const cfg = loadConfig()
      const provider = cfg.provider.providers[cfg.provider.default]
      if (!provider) return { status: 200, body: { summary: null } }
      const apiKey = provider.apiKey ?? (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined)
      // failure/message 透出，桌面端才能区分「未登录」与「网络错」。
      const result = await getDeepSeekUserSummary(apiKey, provider.baseUrl)
      return { status: 200, body: { summary: result.data, failure: result.failure, message: result.message } }
    }, apiToken),

    // DeepSeek 平台成本明细：按模型按天的 token/cost。month=1-12, year=YYYY。
    'GET /config/deepseek/cost': withAuth(async (_body, params) => {
      const cfg = loadConfig()
      const provider = cfg.provider.providers[cfg.provider.default]
      if (!provider) return { status: 200, body: { cost: null } }
      const apiKey = provider.apiKey ?? (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined)
      const now = new Date()
      const month = Number(params?.month ?? now.getMonth() + 1)
      const year = Number(params?.year ?? now.getFullYear())
      const result = await getDeepSeekCostReport(apiKey, provider.baseUrl, month, year)
      return { status: 200, body: { cost: result.data, failure: result.failure, message: result.message } }
    }, apiToken),

    // ── DeepSeek 平台网页登录（token + cookie 持久化） ────────────

    'GET /config/deepseek/auth': withAuth(() => {
      const filePath = join(rivetHome(), 'deepseek-platform-auth.json')
      if (!existsSync(filePath)) return { status: 200, body: { loggedIn: false } }
      try {
        const data = JSON.parse(readFileSync(filePath, 'utf-8')) as { token?: string }
        return { status: 200, body: { loggedIn: !!data.token } }
      } catch {
        return { status: 200, body: { loggedIn: false } }
      }
    }, apiToken),

    'POST /config/deepseek/auth': withAuth((body) => {
      const { token, cookies } = (body ?? {}) as { token?: string; cookies?: string }
      if (!token) return { status: 400, body: { error: 'token is required' } }
      try {
        const filePath = join(rivetHome(), 'deepseek-platform-auth.json')
        mkdirSync(join(rivetHome()), { recursive: true })
        // 原子写（0600）——平台会话 token 与 Cookie 属账号级凭证，与 secrets.json
        // 同级保护；此前的裸 writeFileSync 以默认 0644 落盘。
        writeFileAtomicSync(filePath, JSON.stringify({ token, cookies: cookies ?? '', savedAt: Date.now() }) + '\n')
        return { status: 200, body: { ok: true, loggedIn: true } }
      } catch (err) {
        return { status: 500, body: { error: (err as Error).message } }
      }
    }, apiToken),

    'DELETE /config/deepseek/auth': withAuth(() => {
      const filePath = join(rivetHome(), 'deepseek-platform-auth.json')
      if (existsSync(filePath)) {
        try { writeFileAtomicSync(filePath, '{}\n') } catch { /* best-effort */ }
      }
      return { status: 200, body: { ok: true, loggedIn: false } }
    }, apiToken),
  }
}

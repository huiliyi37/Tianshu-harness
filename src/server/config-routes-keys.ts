/**
 * /config/providers/:name/keys/* — provider 多 key（keys 池）的增删改与 key 级模型管理。
 * All routes are Bearer-gated (fail-closed), mirroring buildConfigRoutes.
 *
 *   POST   /config/providers/:name/keys                     新增 key（探测通过后落库）
 *   DELETE /config/providers/:name/keys/:keyId              删除 key 及其模型（保留至少一个）
 *   PUT    /config/providers/:name/keys/:keyId/key          更新该 key 的凭证（探测通过后落库）
 *   POST   /config/providers/:name/keys/:keyId/models       该 key 名下新增模型
 *   PUT    /config/providers/:name/keys/:keyId/models/:id   覆盖该 key 名下的同 id 模型
 *   DELETE /config/providers/:name/keys/:keyId/models/:id   该 key 名下删除模型
 *
 * 与旧路由（POST/DELETE /config/providers/:name/key）的分工：旧路由维持「provider 级
 * 遗留槽」语义（未迁移 provider、旧版 UI/CLI 调用），本模块只管 keys[i] 自身。
 * 探测复用统一核心 probeProvider（经 provider-probe-adapter），不新写探测逻辑。
 * 子模块化原因：config-routes.ts 是点名巨石（source-budgets ceiling），按接缝外提。
 * 每个变更路由都回带 `keys`（全量池）——客户端据此重渲染，不必再发一次 GET。
 */
import { decodeRouteParam, type RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import { loadConfig } from '../config/manager.js'
import { modelConfigSchema, type ModelConfig } from '../config/schema.js'
import {
  addProviderKey,
  addProviderKeyModels,
  listProviderKeys,
  removeProviderKey,
  removeProviderKeyModel,
  updateProviderKeyCredential,
  upsertProviderKeyModel,
} from '../config/provider-key-store.js'
import { probeForTestKey } from './provider-probe-adapter.js'

function withAuth(handler: RouteHandler, apiToken?: string): RouteHandler {
  return async (body, params, headers, res) => {
    if (!isAuthorizedRequest({ body, headers }, apiToken)) {
      return { status: 401, body: { error: 'Unauthorized' } }
    }
    return handler(body, params, headers, res)
  }
}

/** keyId/modelId 可能含特殊字符（路径中为 percent-encoded 形式）。
 *  name 走 decodeRouteParam（index.ts 的 fail-open 版）——与 provider 级路由一致。 */
function decodeParam(value: string | undefined): string | undefined {
  return value ? decodeURIComponent(value) : undefined
}

/** 落库前的模型校验：raw 为前端确认后的完整模型，缺省回落到探测 descriptors
 *  （modelConfigSchema 的 transform 补 contextWindow/maxTokens 默认值）。 */
function parseModels(raw: unknown[]): { models: ModelConfig[] } | { error: string } {
  const models: ModelConfig[] = []
  for (const entry of raw) {
    const parsed = modelConfigSchema.safeParse(entry)
    if (!parsed.success) return { error: `Invalid model: ${parsed.error.message}` }
    models.push(parsed.data)
  }
  return { models }
}

export function buildProviderKeyRoutes(apiToken?: string, onChanged?: () => void): Record<string, RouteHandler> {
  // provider/模型/密钥写盘成功后的快照刷新通知（serve 侧据此原地重建启动快照）。
  // 与 provider 级路由同一约定：通知必须 fail-open，绝不让已落盘的写失败。
  const notify = (): void => {
    try { onChanged?.() } catch { /* best-effort */ }
  }
  return {
    // 新增 key：先用新 key + provider 的 baseUrl/protocol 探测 /models（零 token，
    // 与桌面「测试连接」同核心），探测不通过不落库——避免把无效凭据写进配置后
    // 请求端才以 401 暴露。models 必须由前端勾选后显式传入；缺省空列表，
    // 不把探测到的全部 descriptors 直接落盘。
    'POST /config/providers/:name/keys': withAuth(async (body, params) => {
      const name = decodeRouteParam(params?.name)
      if (!name) return { status: 400, body: { error: 'provider name is required' } }
      const { apiKey, label, models } = (body ?? {}) as { apiKey?: unknown; label?: unknown; models?: unknown }
      if (typeof apiKey !== 'string' || apiKey.trim() === '') {
        return { status: 400, body: { error: 'apiKey is required' } }
      }
      if (label !== undefined && typeof label !== 'string') {
        return { status: 400, body: { error: 'label must be a string' } }
      }
      if (models !== undefined && !Array.isArray(models)) {
        return { status: 400, body: { error: 'models must be an array' } }
      }
      const cfg = loadConfig()
      const provider = cfg.provider.providers[name]
      if (!provider) return { status: 404, body: { error: `Provider "${name}" not found` } }

      const probe = await probeForTestKey({
        baseUrl: provider.baseUrl,
        apiKey: apiKey.trim(),
        ...(provider.protocol ? { protocol: provider.protocol } : {}),
        providerName: name,
      })
      if (!probe.ok) {
        return { status: 400, body: { error: probe.error ?? 'probe-failed', ...(probe.status !== undefined ? { status: probe.status } : {}) } }
      }

      const parsed = parseModels(Array.isArray(models) ? models : [])
      if ('error' in parsed) return { status: 400, body: { error: parsed.error } }

      try {
        const result = addProviderKey(name, {
          apiKey: apiKey.trim(),
          ...(typeof label === 'string' && label.trim() ? { label: label.trim() } : {}),
          models: parsed.models,
        })
        notify()
        return { status: 200, body: { ok: true, key: result, keys: listProviderKeys(name, loadConfig().provider.providers[name]!) } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    'DELETE /config/providers/:name/keys/:keyId': withAuth((_body, params) => {
      const name = decodeRouteParam(params?.name)
      const keyId = decodeParam(params?.keyId)
      if (!name || !keyId) return { status: 400, body: { error: 'provider name and keyId are required' } }
      try {
        const result = removeProviderKey(name, keyId)
        notify()
        return { status: 200, body: { ok: true, ...result, keys: listProviderKeys(name, loadConfig().provider.providers[name]!) } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    // 更新指定 key 的凭证：给 apiKey 时先探测（同新增语义），apiKeyEnv 只改引用
    // （env 值在服务端进程里，无法探测有效性）。
    'PUT /config/providers/:name/keys/:keyId/key': withAuth(async (body, params) => {
      const name = decodeRouteParam(params?.name)
      const keyId = decodeParam(params?.keyId)
      if (!name || !keyId) return { status: 400, body: { error: 'provider name and keyId are required' } }
      const { apiKey, apiKeyEnv, label } = (body ?? {}) as { apiKey?: unknown; apiKeyEnv?: unknown; label?: unknown }
      if (apiKey !== undefined && typeof apiKey !== 'string') return { status: 400, body: { error: 'apiKey must be a string' } }
      if (apiKeyEnv !== undefined && typeof apiKeyEnv !== 'string') return { status: 400, body: { error: 'apiKeyEnv must be a string' } }
      if (label !== undefined && typeof label !== 'string') return { status: 400, body: { error: 'label must be a string' } }
      if (typeof apiKey === 'string' && typeof apiKeyEnv === 'string') {
        return { status: 400, body: { error: 'apiKey and apiKeyEnv are mutually exclusive' } }
      }
      if (apiKey === undefined && apiKeyEnv === undefined && label === undefined) {
        return { status: 400, body: { error: 'apiKey, apiKeyEnv or label is required' } }
      }

      const cfg = loadConfig()
      const provider = cfg.provider.providers[name]
      if (!provider) return { status: 404, body: { error: `Provider "${name}" not found` } }

      if (typeof apiKey === 'string') {
        if (apiKey.trim() === '') return { status: 400, body: { error: 'apiKey must not be blank' } }
        const probe = await probeForTestKey({
          baseUrl: provider.baseUrl,
          apiKey: apiKey.trim(),
          ...(provider.protocol ? { protocol: provider.protocol } : {}),
          providerName: name,
        })
        if (!probe.ok) {
          return { status: 400, body: { error: probe.error ?? 'probe-failed', ...(probe.status !== undefined ? { status: probe.status } : {}) } }
        }
      }

      try {
        const key = updateProviderKeyCredential(name, keyId, {
          ...(typeof apiKey === 'string' ? { apiKey: apiKey.trim() } : {}),
          ...(typeof apiKeyEnv === 'string' ? { apiKeyEnv: apiKeyEnv.trim() } : {}),
          ...(typeof label === 'string' ? (label.trim() ? { label: label.trim() } : { labelClear: true }) : {}),
        })
        notify()
        return { status: 200, body: { ok: true, key, keys: listProviderKeys(name, loadConfig().provider.providers[name]!) } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    'POST /config/providers/:name/keys/:keyId/models': withAuth((body, params) => {
      const name = decodeRouteParam(params?.name)
      const keyId = decodeParam(params?.keyId)
      if (!name || !keyId) return { status: 400, body: { error: 'provider name and keyId are required' } }
      const { model, models } = (body ?? {}) as { model?: unknown; models?: unknown }
      const raw = Array.isArray(models) ? models : model === undefined ? [] : [model]
      if (raw.length === 0) return { status: 400, body: { error: 'model is required' } }
      const parsed = parseModels(raw)
      if ('error' in parsed) return { status: 400, body: { error: parsed.error } }
      try {
        // 整单校验 + 一次落盘：中途冲突不得留下半批（见 provider-key-store 注释）。
        addProviderKeyModels(name, keyId, parsed.models)
        notify()
        return { status: 200, body: { ok: true, added: parsed.models.map(m => m.id), keys: listProviderKeys(name, loadConfig().provider.providers[name]!) } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    // 覆盖该 key 名下的同 id 模型（编辑 ctx/max/视觉标记）。与 POST 的分工：
    // POST = 新增（重复报错），PUT = upsert（存在则替换）。
    'PUT /config/providers/:name/keys/:keyId/models/:modelId': withAuth((body, params) => {
      const name = decodeRouteParam(params?.name)
      const keyId = decodeParam(params?.keyId)
      const modelId = decodeParam(params?.modelId)
      if (!name || !keyId || !modelId) {
        return { status: 400, body: { error: 'provider name, keyId and modelId are required' } }
      }
      const { model } = (body ?? {}) as { model?: unknown }
      // 缺 model 键：parseModels([]) 返回空数组，下方 models[0]! 断言会抛
      // TypeError 变成未捕获 rejection（请求挂死）——显式 400 才是契约。
      if (model === undefined || model === null) {
        return { status: 400, body: { error: 'model is required' } }
      }
      const parsed = parseModels([model])
      if ('error' in parsed) return { status: 400, body: { error: parsed.error } }
      const entry = parsed.models[0]!
      if (entry.id !== modelId) {
        return { status: 400, body: { error: `model.id "${entry.id}" does not match path "${modelId}"` } }
      }
      try {
        upsertProviderKeyModel(name, keyId, entry)
        notify()
        return { status: 200, body: { ok: true, keys: listProviderKeys(name, loadConfig().provider.providers[name]!) } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    'DELETE /config/providers/:name/keys/:keyId/models/:modelId': withAuth((_body, params) => {
      const name = decodeRouteParam(params?.name)
      const keyId = decodeParam(params?.keyId)
      const modelId = decodeParam(params?.modelId)
      if (!name || !keyId || !modelId) {
        return { status: 400, body: { error: 'provider name, keyId and modelId are required' } }
      }
      try {
        removeProviderKeyModel(name, keyId, modelId)
        notify()
        return { status: 200, body: { ok: true, removed: modelId, keys: listProviderKeys(name, loadConfig().provider.providers[name]!) } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),
  }
}

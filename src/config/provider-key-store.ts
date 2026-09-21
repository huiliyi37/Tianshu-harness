/**
 * provider-key-store — keys 池的唯一写入口（PR-3 多 key 的持久化层）。
 *
 * manager.ts 只做存量迁移合成；config-routes-keys / CLI 经此增删改 key。与
 * provider-keys.ts 的分工：那边是纯函数（迁移判据、归属查找、引用解析），这边
 * 触碰磁盘与 secrets。
 *
 * 凭据落盘约定：key 的密钥进 secrets.json，keyRef 命名 `providerName:keyId`
 * （与顶层遗留 keyRef 的 `providerName` 隔离，互不覆盖）。
 */
import { loadConfig, saveConfig } from './manager.js'
import { deleteSecret, readSecret, writeSecret } from './secrets-store.js'
import { keyRefFor, keyRefReferrers } from './provider-keys.js'
import type { Config, ModelConfig, ProviderConfig, ProviderKeyConfig } from './schema.js'

export interface KeyStatus {
  source: 'inline' | 'env' | 'none'
  ref: string
}

/** 契约层下发的模型视图（与 ProviderListItem.models 同形）。 */
export interface KeyModelView {
  id: string
  description?: string
  contextWindow?: number
  maxTokens?: number
  supportsVision?: boolean
  /** 生图能力旗标（M5 三层之②）：桌面 chat 选择器据此排除生图模型——投影丢它
   *  会让 keys 路径的过滤永远不触发（字段根本没下发）。 */
  supportsImageGen?: boolean
}

export interface ProviderKeyListItem {
  id: string
  label?: string
  keyStatus: KeyStatus
  models: KeyModelView[]
}

/** key 级 keyStatus——与 manager.getApiKeyStatus（provider 级）同构，凭据槽换成
 *  该 key 的三槽。env 回退名仍取 provider 名：key 级解析链对 keyRef/apiKeyEnv 都
 *  落空时也会走 `<PROVIDER>_API_KEY`，状态展示必须与解析链同源，否则 UI 说
 *  「未配」而请求实际拿得到 key。
 *
 *  与原件的一处差异（有意）：keyRef 的 secret 在此实时读取，而不是在 loadConfig
 *  把明文物化进 keys[].apiKey —— 少一份常驻内存的明文，状态与请求端解析链同源。 */
export function getProviderKeyStatus(
  providerName: string,
  key: Pick<ProviderKeyConfig, 'apiKey' | 'apiKeyEnv' | 'keyRef'>,
): KeyStatus {
  const stored = key.keyRef ? readSecret(key.keyRef) : undefined
  const inline = key.apiKey ?? stored
  if (inline) return { source: 'inline', ref: '***' + inline.slice(-4) }
  if (key.apiKeyEnv && process.env[key.apiKeyEnv]) return { source: 'env', ref: key.apiKeyEnv }
  const fallback = `${providerName.toUpperCase()}_API_KEY`
  if (process.env[fallback]) return { source: 'env', ref: fallback }
  return { source: 'none', ref: '' }
}

function toKeyModelView(model: ModelConfig): KeyModelView {
  return {
    id: model.id,
    ...(model.description ? { description: model.description } : {}),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
    ...(model.supportsVision !== undefined ? { supportsVision: model.supportsVision } : {}),
    ...(model.supportsImageGen !== undefined ? { supportsImageGen: model.supportsImageGen } : {}),
  }
}

/** keys 池视图（GET /config/providers 下发）。未迁移 provider（无 keys）返回 []——
 *  消费端据此回退顶层 models/keyStatus：只有用户显式配过凭证的 provider 才有 key
 *  池，UI 不为「从未配置」的 provider 造伪条目。 */
export function listProviderKeys(providerName: string, provider: ProviderConfig): ProviderKeyListItem[] {
  return (provider.keys ?? []).map(key => ({
    id: key.id,
    ...(key.label ? { label: key.label } : {}),
    keyStatus: getProviderKeyStatus(providerName, key),
    models: key.models.map(toKeyModelView),
  }))
}

function requireProvider(cfg: Config, providerName: string): ProviderConfig {
  const provider = cfg.provider.providers[providerName]
  if (!provider) throw new Error(`Provider "${providerName}" not found`)
  return provider
}

function requireKey(provider: ProviderConfig, keyId: string): ProviderKeyConfig {
  const key = (provider.keys ?? []).find(k => k.id === keyId)
  if (!key) throw new Error(`Key "${keyId}" not found on provider "${provider.name}"`)
  return key
}

function generateKeyId(provider: ProviderConfig): string {
  const taken = new Set((provider.keys ?? []).map(k => k.id))
  for (let i = 0; i < 10; i++) {
    const id = `k_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    if (!taken.has(id)) return id
  }
  throw new Error('Failed to allocate a unique key id')
}

/** keyRef 的共享引用（顶层遗留槽 + 其他 key）——删除/改写 key 前判定密钥能否回收。
 *  实现在 provider-keys.ts（单一事实源，manager 侧的回收守卫共用同一份）。 */
function keyRefReferencedBy(
  cfg: Config,
  keyRef: string,
  exclude: { provider: string; keyId?: string },
): string[] {
  return keyRefReferrers(cfg, keyRef, exclude)
}

export interface AddProviderKeyInput {
  apiKey: string
  label?: string
  models?: ModelConfig[]
}

export interface AddProviderKeyResult {
  id: string
  keyStatus: KeyStatus
  models: KeyModelView[]
}

/**
 * 新增一个 key（第二个及以后的 key 走这里；首个 key 通常来自 ConnectWizard /
 * 存量迁移）。密钥立即落 secrets.json（keyRef=`providerName:keyId`），内存与磁盘
 * 的 apiKey 由 saveConfig 剥离。
 */
export function addProviderKey(providerName: string, input: AddProviderKeyInput): AddProviderKeyResult {
  const cfg = loadConfig()
  const provider = requireProvider(cfg, providerName)
  const id = generateKeyId(provider)
  const keyRef = keyRefFor(providerName, id)
  writeSecret(keyRef, input.apiKey)
  const key: ProviderKeyConfig = {
    id,
    ...(input.label ? { label: input.label } : {}),
    keyRef,
    models: input.models ?? [],
  }
  provider.keys = [...(provider.keys ?? []), key]
  provider.userSaved = true
  saveConfig(cfg)
  return {
    id,
    keyStatus: getProviderKeyStatus(providerName, { ...key, apiKey: input.apiKey }),
    models: key.models.map(toKeyModelView),
  }
}

export interface RemoveProviderKeyResult {
  id: string
  secretDeleted: boolean
  /** 同 keyRef 仍被其他 provider/key 引用时列出——密钥因此保留。 */
  keyRefSharedWith: string[]
}

/**
 * 删除一个 key 及其模型。守卫：provider 至少保留一个 key——「清掉凭据但保留
 * provider」的语义由 updateProviderKeyCredential / clearApiKey 承担，删到空会让
 * 请求端无池可用（keys 为空数组等价于未迁移回退，语义反转）。
 */
export function removeProviderKey(providerName: string, keyId: string): RemoveProviderKeyResult {
  const cfg = loadConfig()
  const provider = requireProvider(cfg, providerName)
  const keys = provider.keys ?? []
  const index = keys.findIndex(k => k.id === keyId)
  if (index < 0) throw new Error(`Key "${keyId}" not found on provider "${providerName}"`)
  if (keys.length <= 1) {
    throw new Error(
      `Cannot remove the last key of "${providerName}". ` +
      `Clear its credential instead, or add another key first.`,
    )
  }
  const [removed] = keys.splice(index, 1)
  provider.keys = keys
  saveConfig(cfg)

  const keyRef = removed?.keyRef
  let secretDeleted = false
  const keyRefSharedWith = keyRef ? keyRefReferencedBy(cfg, keyRef, { provider: providerName, keyId }) : []
  if (keyRef && keyRefSharedWith.length === 0 && readSecret(keyRef) !== undefined) {
    deleteSecret(keyRef)
    secretDeleted = true
  }
  return { id: keyId, secretDeleted, keyRefSharedWith }
}

export interface UpdateProviderKeyCredentialInput {
  /** 设置内联密钥（落 secrets.json）。与 apiKeyEnv 互斥，二者同给报错。 */
  apiKey?: string
  /** 改走环境变量名。 */
  apiKeyEnv?: string
  label?: string
  /** null 显式清除 label；undefined = 不动。 */
  labelClear?: boolean
}

/**
 * 更新指定 key 的凭据（探测通过后由路由层调用）。与顶层遗留槽的 setApiKey 分开：
 * 这里只碰 keys[i]，顶层遗留槽由 manager 的同步逻辑维护，避免两处各写一份。
 */
export function updateProviderKeyCredential(
  providerName: string,
  keyId: string,
  input: UpdateProviderKeyCredentialInput,
): ProviderKeyListItem {
  if (input.apiKey !== undefined && input.apiKeyEnv !== undefined) {
    throw new Error('apiKey and apiKeyEnv are mutually exclusive')
  }
  const cfg = loadConfig()
  const provider = requireProvider(cfg, providerName)
  const key = requireKey(provider, keyId)

  if (input.apiKey !== undefined) {
    const keyRef = key.keyRef ?? keyRefFor(providerName, keyId)
    writeSecret(keyRef, input.apiKey)
    key.keyRef = keyRef
    key.apiKey = undefined
    key.apiKeyEnv = undefined
  } else if (input.apiKeyEnv !== undefined) {
    const previousRef = key.keyRef
    key.apiKeyEnv = input.apiKeyEnv
    key.keyRef = undefined
    key.apiKey = undefined
    // 旧 keyRef 只属于这个 key 时回收密钥——共享引用（顶层遗留槽/其他 key）保留。
    if (previousRef && keyRefReferencedBy(cfg, previousRef, { provider: providerName, keyId }).length === 0) {
      deleteSecret(previousRef)
    }
  }
  if (input.labelClear) delete key.label
  else if (input.label) key.label = input.label

  provider.userSaved = true
  saveConfig(cfg)
  return {
    id: key.id,
    ...(key.label ? { label: key.label } : {}),
    keyStatus: getProviderKeyStatus(providerName, key),
    models: key.models.map(toKeyModelView),
  }
}

/** key 级模型新增：同 id 已存在即报错（与 provider 级 addModel 的去重语义一致）。 */
export function addProviderKeyModel(providerName: string, keyId: string, model: ModelConfig): void {
  const cfg = loadConfig()
  const provider = requireProvider(cfg, providerName)
  const key = requireKey(provider, keyId)
  if (key.models.some(m => m.id === model.id)) {
    throw new Error(`Model "${model.id}" already exists under key "${keyId}"`)
  }
  key.models = [...key.models, model]
  provider.userSaved = true
  saveConfig(cfg)
}

/**
 * key 级批量新增：先整单校验、再一次落盘。任一项冲突（与既有池重复 / 批内重复）
 * 整批不写——逐项 saveConfig 会在中途冲突时留下半批落盘：UI 收到 400 以为没保存，
 * 重试又永远卡在第一项冲突上，后面的新模型再也进不去（连续保存存不上）。
 */
export function addProviderKeyModels(providerName: string, keyId: string, models: ModelConfig[]): void {
  const cfg = loadConfig()
  const provider = requireProvider(cfg, providerName)
  const key = requireKey(provider, keyId)
  const existing = new Set(key.models.map(m => m.id))
  const conflicts = new Set<string>()
  const seen = new Set<string>()
  for (const model of models) {
    if (existing.has(model.id) || seen.has(model.id)) conflicts.add(model.id)
    seen.add(model.id)
  }
  if (conflicts.size > 0) {
    const ids = [...conflicts].map(id => `"${id}"`).join(', ')
    throw new Error(`Model ${ids} already exists under key "${keyId}"`)
  }
  key.models = [...key.models, ...models]
  provider.userSaved = true
  saveConfig(cfg)
}

/** 覆盖该 key 名下的同 id 模型（UI 编辑 ctx/max/视觉标记用）；不存在则新增。 */
export function upsertProviderKeyModel(providerName: string, keyId: string, model: ModelConfig): void {
  const cfg = loadConfig()
  const provider = requireProvider(cfg, providerName)
  const key = requireKey(provider, keyId)
  key.models = key.models.some(m => m.id === model.id)
    ? key.models.map(m => (m.id === model.id ? model : m))
    : [...key.models, model]
  provider.userSaved = true
  saveConfig(cfg)
}

/** key 级模型删除。允许删到空——key 的模型池没有 provider 级的预设回流问题
 *  （回流只作用于顶层 provider.models），空池由 UI 提示「拉取/手动添加」。 */
export function removeProviderKeyModel(providerName: string, keyId: string, modelId: string): void {
  const cfg = loadConfig()
  const provider = requireProvider(cfg, providerName)
  const key = requireKey(provider, keyId)
  if (!key.models.some(m => m.id === modelId)) {
    throw new Error(`Model "${modelId}" not found under key "${keyId}"`)
  }
  key.models = key.models.filter(m => m.id !== modelId)
  provider.userSaved = true
  saveConfig(cfg)
}

/**
 * provider-keys — 多 key（provider.keys[] 池）的纯函数层：迁移判据、归属查找、
 * 模型引用解析、secret 命名空间。
 *
 * 数据模型见 schema.ts providerKeySchema：一个 provider 挂多个 key，各 key 有独立
 * 凭证与 models（请求端按「模型属于哪个 key」解析凭证，见 serve.ts resolveModelSpec）。
 *
 * 契约层模型列表的单一事实源是 contract-models.ts 的 contractModels（本模块重导出
 * 以便消费方就近取用）；那种拆分是必需的——本模块依赖 manager（loadConfig），而
 * CLI 展示层 cli-format.ts 与 manager 同层，直接 import 本模块会成环。
 *
 * 顶层 models 是**迁移时的快照**：key 级增删只写 keys[i].models，不回写顶层。读顶层
 * 会看到已删除的模型、漏掉只在 key 池里的模型——消费方一律走 contractModels。
 */
import type { ModelConfig, ProviderConfig, ProviderKeyConfig } from './schema.js'

export { contractModels } from './contract-models.js'

/** 迁移合成的首个 key 的固定 id——旧 secret（keyRef = provider 名）继续被它引用。 */
export const DEFAULT_KEY_ID = 'default'

export interface LegacyKeyMigrationPolicy {
  /** 用户是否显式为该 provider 配过凭证。判据含预设知识（deepMerge 让每个预设
   *  provider 都继承预设的 apiKeyEnv/models，那不算用户配置过），故由 manager
   *  注入——与 userSaved 打标共用同一实现，避免「哪些 provider 算用户配置过」
   *  出现两个答案。 */
  hasUserCredential: (provider: ProviderConfig) => boolean
  /** 该 apiKeyEnv 是否只是从预设继承来的值。 */
  isInheritedEnv: (apiKeyEnv: string) => boolean
}

/**
 * 幂等迁移：**用户显式配过凭证**的 provider 若尚无 keys，把旧三槽 + 顶层 models
 * 合成 keys[0]。返回是否发生了变更。原地修改 provider。
 *
 * 判据为什么必须是「用户显式凭证」而不是「合并后存在凭证」：deepMerge 让每个预设
 * provider 都继承 DEEPSEEK_API_KEY 等预设值，若把它当存量凭证，用户尚未配 key 时
 * 就合成 keys[0]；此后 setApiKey 写的是**顶层** keyRef，而迁移因 keys 已存在被跳过
 * → keys[0] 与顶层脱钩，请求端读 keys[0] 的 apiKeyEnv（走 env）→ 用户刚设的 key
 * 被静默忽略，模型切不了。同理，继承来的 apiKeyEnv 不进 keys[0]——它不是用户为
 * 该 key 选的凭据来源，留在顶层给旧路径消费即可。
 *
 * keys[0].models 与 provider.models 共享同一数组引用（迁移那一刻的快照）。
 */
export function migrateProviderToKeys(provider: ProviderConfig, policy: LegacyKeyMigrationPolicy): boolean {
  if (provider.keys && provider.keys.length > 0) return false
  if (!policy.hasUserCredential(provider)) return false
  const key: ProviderKeyConfig = {
    id: DEFAULT_KEY_ID,
    // 合成 key 显式带名：设置页的 Key 面板对无 label 的 key 显示「未命名 Key」，
    // 老用户升级后会以为迁移丢了东西。用 'default' 而非 provider 名——卡片上已写着
    // provider 名，重复一遍是冗余；'default' 才传达「自动创建的主 key」。
    label: DEFAULT_KEY_ID,
    ...(provider.keyRef ? { keyRef: provider.keyRef } : {}),
    ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
    ...(provider.apiKeyEnv && !policy.isInheritedEnv(provider.apiKeyEnv) ? { apiKeyEnv: provider.apiKeyEnv } : {}),
    models: provider.models,
  }
  provider.keys = [key]
  return true
}

export interface ProviderKeyPool {
  /** null = 未迁移 provider 的顶层回退池（凭据与模型都在 provider 上）。 */
  owner: ProviderKeyConfig | null
  models: ModelConfig[]
}

/**
 * key 池视图：已迁移 provider → 每个 key 一个池；未迁移 → 单一回退池
 * （owner=null，沿用 provider 级凭据链，行为与迁移前一致）。
 */
export function providerKeyPools(provider: ProviderConfig): ProviderKeyPool[] {
  if (provider.keys && provider.keys.length > 0) {
    return provider.keys.map(key => ({ owner: key, models: key.models }))
  }
  return [{ owner: null, models: provider.models }]
}

export interface ModelOwner {
  owner: ProviderKeyConfig | null
  model: ModelConfig
}

/** 模型归属：按 modelRef（模型 id 或 alias）找所属 key。撞名取第一个命中的 key。 */
export function findModelOwner(provider: ProviderConfig, modelRef: string): ModelOwner | undefined {
  if (!modelRef) return undefined
  for (const pool of providerKeyPools(provider)) {
    const model = pool.models.find(m => m.id === modelRef)
    if (model) return { owner: pool.owner, model }
  }
  return undefined
}

/** 限定 key 的模型查找——`provider:keyId:modelId` 的精确选择路径。 */
export function findModelInKey(
  provider: ProviderConfig,
  keyId: string,
  modelRef: string,
): ModelOwner | undefined {
  if (!modelRef) return undefined
  for (const pool of providerKeyPools(provider)) {
    if ((pool.owner?.id ?? DEFAULT_KEY_ID) !== keyId) continue
    const model = pool.models.find(m => m.id === modelRef)
    if (model) return { owner: pool.owner, model }
  }
  return undefined
}

export interface ParsedModelRef {
  /** 显式 provider 前缀（`provider:...`）。 */
  provider?: string
  /** 显式 key 前缀（`provider:keyId:modelId`）。 */
  keyId?: string
  /** 模型 id 或 alias。 */
  modelRef: string
}

/**
 * 解析模型引用。三种形态：
 *   modelId                  裸 id——全 provider 扫描，撞名取第一个
 *   provider:modelId         限定 provider
 *   provider:keyId:modelId   限定 provider 且限定 key
 *
 * 注意 `ollama:qwen3:32b` 这类「provider : 含冒号的 model id」会被切成
 * keyId=qwen3——是否是 keyId 由调用方拿配置核对（见 serve.resolveModelSpec）。
 * 解析层不持有配置，故只做机械切分。
 */
export function parseModelRef(ref: string): ParsedModelRef {
  const first = ref.indexOf(':')
  if (first <= 0) return { modelRef: ref }
  const provider = ref.slice(0, first)
  const rest = ref.slice(first + 1)
  const second = rest.indexOf(':')
  if (second <= 0) return { provider, modelRef: rest }
  return { provider, keyId: rest.slice(0, second), modelRef: rest.slice(second + 1) }
}

/**
 * 消解「中间段是 keyId 还是模型 id 自身的一部分」的歧义——`parseModelRef` 的
 * 配套步骤，**每个解析调用方都必须过这一步**。
 *
 * `parseModelRef` 是机械切分、不持有配置，所以 `ollama:qwen3:32b` 会切成
 * keyId=qwen3/modelRef=32b。仅当中间段真是该 provider 现存的 key id 时才认作钉 key；
 * 否则把整段还原进 modelRef。漏掉这一步的后果不是「解析不出」，而是**静默取错**：
 * findModelInKey 落空 → owner=undefined → 模型回落到 models[0]、凭据回落到 provider
 * 级槽；A′ 已把 provider 级凭据剥进 provider-keys.json，于是拿到空串并以
 * 「API key not set」退出。headless 曾因此在这类 provider 上完全不可用（真进程
 * E2E 见 __tests__/provider-key-ownership-headless-e2e.test.ts）。
 *
 * 抽成公共函数的理由与 buildBatchModelPayload 同：serve.resolveModelSpec 与
 * main.ts 的 headless 解析各写一份必然漂移——事实上已经漂了，main.ts 那侧
 * 长期缺这段守卫，而两侧注释都写着「与对方同语义」。
 */
export function disambiguateKeyPrefix(
  providers: Record<string, ProviderConfig>,
  parsed: ParsedModelRef,
): ParsedModelRef {
  if (!parsed.provider || !parsed.keyId) return parsed
  const known = providers[parsed.provider]?.keys?.some(k => k.id === parsed.keyId)
  if (known) return parsed
  return { provider: parsed.provider, modelRef: `${parsed.keyId}:${parsed.modelRef}` }
}

/**
 * key 的 secrets keyRef 命名空间：默认 key 沿用 provider 名（存量 secret 继续
 * 被引用，迁移零改动），其余 key 用 `<provider>:<keyId>`，与 provider 名互不撞键。
 */
export function keyRefFor(providerName: string, keyId: string): string {
  return keyId === DEFAULT_KEY_ID ? providerName : `${providerName}:${keyId}`
}

/** 凭据操作的落点：keys 池里的默认 key（迁移合成的 default，或池内第一个）。
 *  未迁移 provider（无 keys）返回 undefined——调用方走顶层遗留槽即可。
 *
 *  存在的理由：请求端读的始终是 keys 池，provider 级的 set/clear 若不把改动同步
 *  过来，就会出现「UI 显示已设 key，模型却切不了」的静默失配。 */
export function defaultKeyOf(provider: ProviderConfig): ProviderKeyConfig | undefined {
  if (!provider.keys || provider.keys.length === 0) return undefined
  return provider.keys.find(k => k.id === DEFAULT_KEY_ID) ?? provider.keys[0]
}

/**
 * 全仓扫描 keyRef 的引用方（provider 顶层槽 + 所有 key 槽）——删除/改写凭据前
 * 判定密钥能否回收。exclude 用于排除「正在被改写的那个 key 自己」。
 *
 * 单一事实源：manager（setApiKeyEnv 的旧 ref 回收、clearApiKey 的共享守卫）与
 * provider-key-store（removeProviderKey / updateProviderKeyCredential）共用，
 * 各写一份会让「这个 secret 还有没有人用」出现两个答案。
 */
export function keyRefReferrers(
  cfg: { provider: { providers: Record<string, ProviderConfig> } },
  keyRef: string,
  exclude?: { provider: string; keyId?: string },
): string[] {
  const refs: string[] = []
  for (const [name, provider] of Object.entries(cfg.provider.providers)) {
    if (provider.keyRef === keyRef) refs.push(name)
    for (const key of provider.keys ?? []) {
      if (key.keyRef !== keyRef) continue
      if (exclude && name === exclude.provider && key.id === exclude.keyId) continue
      refs.push(`${name}:${key.id}`)
    }
  }
  return refs
}

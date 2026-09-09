import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { resolveModelSpecWithReload, listAllModelsWithReload, type ServeContext } from '../serve.js'
import type { ProviderConfig } from '../../config/schema.js'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Regression shield: these tests assert behavior when a provider has no
// configured key. The standard DEEPSEEK_API_KEY env var must not leak into
// the test provider, otherwise resolveApiKey() finds a key and the snapshot
// is wrongly treated as resolvable, masking the reload path.
const ORIGINAL_DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY
delete process.env.DEEPSEEK_API_KEY
after(() => {
  if (ORIGINAL_DEEPSEEK_API_KEY !== undefined) {
    process.env.DEEPSEEK_API_KEY = ORIGINAL_DEEPSEEK_API_KEY
  }
})

/**
 * Regression: first-install model switch. The server starts in setup mode
 * (configured=false, no API key) and the user configures the key via /config
 * afterwards. switchModel must resolve the target model against the *live*
 * config (fresh on-disk read), not just the keyless startup snapshot —
 * otherwise pro→flash 409s until the app restarts.
 */

function deepseekProvider(apiKey: string | undefined): ProviderConfig {
  return {
    name: 'deepseek',
    apiKey,
    baseUrl: 'https://api.deepseek.com',
    protocol: 'openai',
    capabilities: { cacheControl: false, stripParams: [], toolJsonBug: false, prefixCache: 'none', prefixCompletion: false },
    models: [
      { id: 'deepseek-pro', alias: 'pro', contextWindow: 128_000, maxTokens: 8192 },
      { id: 'deepseek-flash', alias: 'flash', contextWindow: 128_000, maxTokens: 8192 },
    ],
    thinking: 'enabled',
    maxTokens: 64_000,
    unsupported: [],
  } as ProviderConfig
}

function makeCtx(apiKey: string, providerApiKey: string | undefined): ServeContext {
  const provider = deepseekProvider(providerApiKey)
  return {
    config: { provider: { default: 'deepseek', providers: { deepseek: provider } } } as unknown as ServeContext['config'],
    provider,
    model: provider.models[0]!,
    apiKey,
    configured: apiKey !== '',
  }
}

test('B5: 未认证 oauth provider 不截胡裸别名——continue 扫到带 key provider', () => {
  // 2026-09-07 审查：resolveModelSpec 的 oauth 分支命中即 return，不查可用凭据
  // （无 key provider 的 else 分支是 `!provKey → continue`）——未认证 oauth
  // provider 排在前面会截胡裸别名，返回不可用 spec（下游请求时才 401）。
  // 修复：oauth 分支用 isAuthenticated() 判凭据，未认证同样 continue。
  // 隔离：OAuthAuth TokenStore 落 rivetHome()/auth——临时 RIVET_HOME 保证空 token
  // store（开发机真实 codex.json 会让 isAuthenticated=true 导致 flaky）。
  const origHome = process.env.RIVET_HOME
  process.env.RIVET_HOME = join(tmpdir(), `rivet-b5-${Date.now()}`)
  try {
    const ctx = makeCtx('', undefined)
    ctx.config = {
      provider: {
        default: 'keyedp',
        providers: {
          oauthp: {
            name: 'oauthp',
            auth: { type: 'oauth', provider: 'codex' },
            baseUrl: 'https://api.example.com',
            models: [{ id: 'shared', alias: 'shared', contextWindow: 128_000, maxTokens: 8192 }],
          } as unknown as ProviderConfig,
          keyedp: {
            name: 'keyedp',
            apiKey: 'real-key',
            baseUrl: 'https://api.example.com',
            models: [{ id: 'shared', alias: 'shared', contextWindow: 128_000, maxTokens: 8192 }],
          } as unknown as ProviderConfig,
        },
      },
    } as unknown as ServeContext['config']

    const spec = resolveModelSpecWithReload(ctx, 'shared', () => ctx)
    assert.ok(spec, '裸别名应解析到带 key 的 provider')
    assert.equal(spec!.provider.name, 'keyedp', '未认证 oauth 不得截胡（旧实现返回 oauthp 的不可用 spec）')
    assert.equal(spec!.apiKey, 'real-key')
  } finally {
    if (origHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = origHome
  }
})

test('resolveModelSpecWithReload: keyless startup snapshot falls back to fresh config', () => {
  // Startup snapshot — setup mode, no key anywhere on the deepseek provider.
  const snapshot = makeCtx('', undefined)
  // Fresh on-disk read after the user configured the key.
  let reloadCalls = 0
  const reload = (): ServeContext => {
    reloadCalls++
    return makeCtx('sk-configured', 'sk-configured')
  }

  const spec = resolveModelSpecWithReload(snapshot, 'flash', reload)
  assert.ok(spec, 'expected the target model to resolve via the fresh reload')
  assert.equal(spec!.model.id, 'deepseek-flash')
  assert.equal(spec!.apiKey, 'sk-configured', 'must carry the freshly configured key, not the empty snapshot key')
  assert.equal(reloadCalls, 1, 'reload should be consulted exactly once on the snapshot miss')
})

test('resolveModelSpecWithReload: configured snapshot resolves without reloading', () => {
  const snapshot = makeCtx('sk-live', 'sk-live')
  let reloadCalls = 0
  const reload = (): ServeContext => { reloadCalls++; return snapshot }

  const spec = resolveModelSpecWithReload(snapshot, 'flash', reload)
  assert.ok(spec)
  assert.equal(spec!.model.id, 'deepseek-flash')
  assert.equal(reloadCalls, 0, 'no fresh read when the startup snapshot already resolves')
})

test('resolveModelSpecWithReload: unknown model returns null even after reload', () => {
  const snapshot = makeCtx('sk-live', 'sk-live')
  const spec = resolveModelSpecWithReload(snapshot, 'nonexistent-model', () => snapshot)
  assert.equal(spec, null)
})

test('resolveModelSpecWithReload: reload throwing degrades to null (no crash)', () => {
  const snapshot = makeCtx('', undefined)
  const spec = resolveModelSpecWithReload(snapshot, 'flash', () => {
    throw new Error('default provider not configured')
  })
  assert.equal(spec, null)
})

function extraProvider(name: string, modelId: string): ProviderConfig {
  return {
    name,
    apiKey: 'sk-extra',
    baseUrl: 'https://api.example.com',
    protocol: 'openai',
    capabilities: { cacheControl: false, stripParams: [], toolJsonBug: false, prefixCache: 'none', prefixCompletion: false },
    models: [{ id: modelId, alias: modelId, contextWindow: 128_000, maxTokens: 8192 }],
    thinking: 'enabled',
    maxTokens: 64_000,
    unsupported: [],
  } as ProviderConfig
}

function ctxWith(providers: Record<string, ProviderConfig>): ServeContext {
  const [firstName, firstProvider] = Object.entries(providers)[0]!
  return {
    config: { provider: { default: firstName, providers } } as unknown as ServeContext['config'],
    provider: firstProvider,
    model: firstProvider.models[0]!,
    apiKey: firstProvider.apiKey ?? '',
    configured: true,
  }
}

test('listAllModelsWithReload: surfaces a provider added after startup (no restart)', () => {
  // Startup snapshot only knew about deepseek...
  const snapshot = ctxWith({ deepseek: deepseekProvider('sk-live') })
  // ...the user later configured a brand-new provider via Settings.
  const fresh = ctxWith({
    deepseek: deepseekProvider('sk-live'),
    glm: extraProvider('glm', 'glm-4-plus'),
  })

  const models = listAllModelsWithReload(snapshot, () => fresh)
  const ids = models.map((m) => m.id)
  assert.ok(ids.includes('deepseek-flash'))
  assert.ok(ids.includes('glm-4-plus'), 'newly-configured provider must appear without a restart')
})

test('listAllModelsWithReload: falls back to the snapshot when the fresh read throws', () => {
  const snapshot = ctxWith({ deepseek: deepseekProvider('sk-live') })
  const models = listAllModelsWithReload(snapshot, () => { throw new Error('mid-edit config') })
  assert.deepEqual(models.map((m) => m.id).sort(), ['deepseek-flash', 'deepseek-pro'])
})

function twinProviders(): Record<string, ProviderConfig> {
  // deepseek + deepseek-spark 共享同一 wire model id（API 型号名不能改）
  const models = [
    { id: 'deepseek-v4-flash', alias: 'v4-flash', contextWindow: 1_000_000, maxTokens: 384_000 },
    { id: 'deepseek-v4-pro', alias: 'v4-pro', contextWindow: 1_000_000, maxTokens: 384_000 },
  ]
  const mk = (name: string, aliasFlash: string, aliasPro: string): ProviderConfig => ({
    name,
    apiKey: `sk-${name}`,
    baseUrl: 'https://api.deepseek.com/v1',
    protocol: 'openai',
    capabilities: { cacheControl: false, stripParams: [], toolJsonBug: true, prefixCache: 'deepseek-native', prefixCompletion: true },
    models: [
      { ...models[0]!, alias: aliasFlash },
      { ...models[1]!, alias: aliasPro },
    ],
    thinking: 'enabled',
    maxTokens: 384_000,
    unsupported: [],
  } as ProviderConfig)
  return {
    deepseek: mk('deepseek', 'v4-flash', 'v4-pro'),
    'deepseek-spark': mk('deepseek-spark', 'spark-flash', 'spark-pro'),
  }
}

test('resolveModelSpec: provider:modelId 消歧到 spark，不撞官方 deepseek', () => {
  const ctx = ctxWith(twinProviders())
  const stay = () => ctx // 禁止回落到本机真实 config
  const bare = resolveModelSpecWithReload(ctx, 'deepseek-v4-flash', stay)
  assert.ok(bare)
  assert.equal(bare!.provider.name, 'deepseek', '裸 id 仍优先官方节点（兼容旧会话）')

  const spark = resolveModelSpecWithReload(ctx, 'deepseek-spark:deepseek-v4-flash', stay)
  assert.ok(spark, 'provider 前缀必须能解析 spark')
  assert.equal(spark!.provider.name, 'deepseek-spark')
  assert.equal(spark!.model.id, 'deepseek-v4-flash', 'wire model id 不变')
  assert.equal(spark!.apiKey, 'sk-deepseek-spark')

  const byAlias = resolveModelSpecWithReload(ctx, 'deepseek-spark:spark-flash', stay)
  assert.ok(byAlias)
  assert.equal(byAlias!.provider.name, 'deepseek-spark')
  assert.equal(byAlias!.model.id, 'deepseek-v4-flash')
})

test('resolveModelSpec: 未知 provider 前缀或该节点无此模型 → null', () => {
  const ctx = ctxWith(twinProviders())
  const stay = () => ctx
  assert.equal(resolveModelSpecWithReload(ctx, 'nope:deepseek-v4-flash', stay), null)
  assert.equal(resolveModelSpecWithReload(ctx, 'deepseek-spark:ghost-model', stay), null)
})

test('listAllModels: 同 wire id 在两节点各出一条（欢迎页/选择器不丢 spark）', () => {
  const ctx = ctxWith(twinProviders())
  const models = listAllModelsWithReload(ctx, () => ctx)
  const flash = models.filter((m) => m.id === 'deepseek-v4-flash')
  assert.equal(flash.length, 2, '两节点同 id 必须都列出')
  assert.deepEqual(flash.map((m) => m.provider).sort(), ['deepseek', 'deepseek-spark'])
  assert.ok(models.some((m) => m.provider === 'deepseek-spark' && m.alias === 'spark-flash'))
})

// ── 2026-09-06 修复：无 key provider 早退 + 失败分类 ────────────────────

test('resolveModelSpec: 裸别名撞上排在前面的无 key provider 时继续扫描（早退修复）', () => {
  // nokey 排在前面且持有同别名模型但无 key；keyed 排在后面且带 key——
  // 修复前整个扫描在 nokey 处 return null，永远到不了 keyed。
  const nokey: ProviderConfig = {
    name: 'nokey', apiKeyEnv: 'NOKEY_UNSET_ENV_X', baseUrl: 'https://a.example.com', protocol: 'openai',
    capabilities: {}, models: [{ id: 'shared-model', contextWindow: 128_000, maxTokens: 4096 }],
    thinking: 'enabled', maxTokens: 64_000, unsupported: [],
  } as ProviderConfig
  const keyed: ProviderConfig = {
    name: 'keyed', apiKey: 'sk-keyed', baseUrl: 'https://b.example.com', protocol: 'openai',
    capabilities: {}, models: [{ id: 'my-model', alias: 'shared-model', contextWindow: 128_000, maxTokens: 4096 }],
    thinking: 'enabled', maxTokens: 64_000, unsupported: [],
  } as ProviderConfig
  const ctx = {
    config: { provider: { default: 'keyed', providers: { nokey, keyed } } },
    provider: keyed, model: keyed.models[0]!, apiKey: 'sk-ctx', configured: true,
  } as unknown as ServeContext
  const spec = resolveModelSpecWithReload(ctx, 'shared-model')
  assert.ok(spec, '裸别名应穿透无 key 的 nokey 落到 keyed')
  assert.equal(spec!.provider.name, 'keyed')
  assert.equal(spec!.model.id, 'my-model')
})

test('resolveModelSpec: 带 provider: 前缀查无 key 的目标仍 fail-closed', () => {
  const nokey: ProviderConfig = {
    name: 'nokey', apiKeyEnv: 'NOKEY_UNSET_ENV_Y', baseUrl: 'https://a.example.com', protocol: 'openai',
    capabilities: {}, models: [{ id: 'm1', contextWindow: 128_000, maxTokens: 4096 }],
    thinking: 'enabled', maxTokens: 64_000, unsupported: [],
  } as ProviderConfig
  const ctx = {
    config: { provider: { default: 'nokey', providers: { nokey } } },
    provider: nokey, model: nokey.models[0]!, apiKey: '', configured: false,
  } as unknown as ServeContext
  assert.equal(resolveModelSpecWithReload(ctx, 'nokey:m1'), null, '显式指向无 key provider 仍拒绝')
})

test('classifyModelSpecMiss: 模型存在但 key 缺失 → key-missing；不存在 → unknown-model', async () => {
  const { classifyModelSpecMiss } = await import('../serve.js')
  const prov: ProviderConfig = {
    name: 'p', apiKeyEnv: 'UNSET_ENV_Z', baseUrl: 'https://a.example.com', protocol: 'openai',
    capabilities: {}, models: [{ id: 'exists-model', alias: 'em', contextWindow: 128_000, maxTokens: 4096 }],
    thinking: 'enabled', maxTokens: 64_000, unsupported: [],
  } as ProviderConfig
  const config = { provider: { default: 'p', providers: { p: prov } } } as never
  assert.equal(classifyModelSpecMiss(config, 'exists-model'), 'key-missing')
  assert.equal(classifyModelSpecMiss(config, 'p:em'), 'key-missing')
  assert.equal(classifyModelSpecMiss(config, 'no-such-model'), 'unknown-model')
  assert.equal(classifyModelSpecMiss(config, 'ghost:whatever'), 'unknown-model')
})

// ── 会话内模型列表 key 过滤（2026-09-08 ChatGPT 对齐：picker 只列可用 provider）──
// RED 基座：listAllModels 原实现无差别枚举所有 provider（serve.ts:284）；无 key /
// 未认证 oauth 不出现、providerLabel 携带这三组断言先在旧实现上红，实现
// providerHasUsableAuth 过滤后转绿。keyless/env 两条为防回归的正向钉。
function noKeyProvider(name = 'nokey'): ProviderConfig {
  return {
    name, apiKeyEnv: 'NOKEY_UNSET_ENV_X', baseUrl: 'https://a.example.com', protocol: 'openai',
    capabilities: {}, models: [{ id: 'm-nokey', alias: 'nk', contextWindow: 128_000, maxTokens: 4096 }],
    thinking: 'enabled', maxTokens: 64_000, unsupported: [],
  } as ProviderConfig
}

function keylessLoopbackProvider(name = 'ollama'): ProviderConfig {
  return {
    name, baseUrl: 'http://127.0.0.1:11434', protocol: 'openai',
    capabilities: {}, models: [{ id: 'm-local', alias: 'local', contextWindow: 128_000, maxTokens: 4096 }],
    thinking: 'enabled', maxTokens: 64_000, unsupported: [],
  } as ProviderConfig
}

test('listAllModels: 无 key provider 的模型不出现（picker 只列可用）', () => {
  const ctx = ctxWith({ deepseek: deepseekProvider('sk-live'), nokey: noKeyProvider() })
  const models = listAllModelsWithReload(ctx, () => ctx)
  assert.ok(models.some(m => m.provider === 'deepseek'), '带 key provider 正常列出')
  assert.ok(!models.some(m => m.provider === 'nokey'), '该配 key 而没配的 provider 不得入列表')
})

test('listAllModels: keyless loopback provider 保留（ollama 形态）', () => {
  const ctx = ctxWith({ deepseek: deepseekProvider('sk-live'), ollama: keylessLoopbackProvider() })
  const models = listAllModelsWithReload(ctx, () => ctx)
  assert.ok(models.some(m => m.provider === 'ollama' && m.id === 'm-local'), '本地无密钥端点照常列出')
})

test('listAllModels: env key 注入后 provider 出现', () => {
  process.env.RIVET_TEST_ENV_KEY_PROV = 'sk-env'
  try {
    const prov = {
      name: 'envkey', apiKeyEnv: 'RIVET_TEST_ENV_KEY_PROV', baseUrl: 'https://b.example.com', protocol: 'openai',
      capabilities: {}, models: [{ id: 'm-env', alias: 'ev', contextWindow: 128_000, maxTokens: 4096 }],
      thinking: 'enabled', maxTokens: 64_000, unsupported: [],
    } as ProviderConfig
    const ctx = ctxWith({ envkey: prov })
    const models = listAllModelsWithReload(ctx, () => ctx)
    assert.ok(models.some(m => m.id === 'm-env'), 'apiKeyEnv 有实值即可列')
  } finally {
    delete process.env.RIVET_TEST_ENV_KEY_PROV
  }
})

test('listAllModels: 未认证 oauth provider 过滤（与 B5 同 isAuthenticated 语义）', () => {
  // RIVET_HOME 隔离：OAuthAuth TokenStore 读 rivetHome()/auth——开发机真实 codex.json
  // 会让 isAuthenticated 语义不可控（B5 测试同款隔离）。已认证分支需真实 token，
  // 此层不写假 store，由 providerHasUsableAuth 分支与 resolveModelSpec B5 对称覆盖。
  const origHome = process.env.RIVET_HOME
  process.env.RIVET_HOME = join(tmpdir(), `rivet-picker-oauth-${Date.now()}`)
  try {
    const oauthProv = {
      name: 'oauthp', auth: { type: 'oauth', provider: 'codex' }, baseUrl: 'https://api.example.com',
      models: [{ id: 'm-oauth', alias: 'oa', contextWindow: 128_000, maxTokens: 4096 }],
    } as unknown as ProviderConfig
    const ctx = ctxWith({ oauthp: oauthProv })
    const models = listAllModelsWithReload(ctx, () => ctx)
    assert.ok(!models.some(m => m.id === 'm-oauth'), '未认证 oauth provider 不列')
  } finally {
    if (origHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = origHome
  }
})

test('listAllModels: 模型行携带 providerLabel（UI 分组标题源）', () => {
  const ctx = ctxWith({ deepseek: deepseekProvider('sk-live'), glm: extraProvider('glm', 'glm-4-plus') })
  const models = listAllModelsWithReload(ctx, () => ctx)
  const ds = models.find(m => m.provider === 'deepseek')
  assert.ok(ds, 'deepseek provider 在列')
  assert.equal(ds!.providerLabel, 'DeepSeek', '官方 preset → 展示 label')
  const glm = models.find(m => m.provider === 'glm')
  assert.ok(glm && glm.providerLabel, '每个模型行都要有分组标题')
})

/**
 * PR-3 多 key 数据层：迁移合成、key 池归属、模型并集、keyRef 命名空间。
 *
 * 迁移是「幂等合成」——loadConfig 每次读都在内存里补 keys[0]。A′ 之后落盘格式
 * 有两个面：config.json 只留顶层兼容槽，keys 池落 provider-keys.json（旧版 rivet
 * 的 z.object 不认该文件，因而无法抹掉它——见 provider-keys-cross-version-compat.md）。
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { providerKeysPath, readProviderKeysFile } from '../provider-keys-store.js'
import {
  DEFAULT_KEY_ID,
  defaultKeyOf,
  findModelInKey,
  findModelOwner,
  keyRefFor,
  migrateProviderToKeys,
  parseModelRef,
  providerKeyPools,
  disambiguateKeyPrefix,
} from '../provider-keys.js'
import { contractModels } from '../contract-models.js'
import { loadConfig, saveConfig } from '../manager.js'
import { readSecret } from '../secrets-store.js'
import { resolveCredentialKey } from '../../api/factory.js'
import type { ProviderConfig, ProviderKeyConfig } from '../schema.js'

/** 最小 ProviderConfig 形状——只填被测字段，其余用断言无关的占位。 */
function provider(overrides: Record<string, unknown>): ProviderConfig {
  return {
    name: 'relay',
    baseUrl: 'https://relay.example.com/v1',
    protocol: 'openai',
    capabilities: {},
    thinking: 'enabled',
    maxTokens: 64_000,
    models: [],
    unsupported: [],
    ...overrides,
  } as unknown as ProviderConfig
}

const model = (id: string) => ({ id }) as unknown as ProviderConfig['models'][number]

/** keys[0] 的非空取用——测试里省掉每个下标都写 `!`（noUncheckedIndexedAccess）。 */
function key0(prov: ProviderConfig): ProviderKeyConfig {
  const first = prov.keys?.[0]
  assert.ok(first, 'provider has no keys pool')
  return first
}

/** 迁移判据的测试替身：与 manager 的 hasUserCredential / isInheritedPresetEnv 同形
 *  （真实现需要预设表，纯函数模块不引入那份耦合，故由调用方注入）。 */
const PRESET_INHERITED_ENVS = new Set(['DEEPSEEK_API_KEY'])
const policy = {
  hasUserCredential: (p: ProviderConfig): boolean => {
    if (p.keyRef || p.apiKey) return true
    return typeof p.apiKeyEnv === 'string' && !PRESET_INHERITED_ENVS.has(p.apiKeyEnv)
  },
  isInheritedEnv: (env: string): boolean => PRESET_INHERITED_ENVS.has(env),
}

describe('migrateProviderToKeys', () => {
  it('synthesizes keys[0] from the legacy slots and shares the models array', () => {
    const models = [model('relay-a'), model('relay-b')]
    const prov = provider({ keyRef: 'relay', models })
    assert.equal(migrateProviderToKeys(prov, policy), true)
    assert.equal(prov.keys!.length, 1)
    assert.equal(key0(prov).id, DEFAULT_KEY_ID)
    assert.equal(key0(prov).keyRef, 'relay')
    // 单一事实源：顶层 models 是 keys[0].models 的兼容视图，不是第二份数据。
    assert.equal(key0(prov).models, models)
    assert.equal(prov.models, models)
  })

  it('合成的 keys[0] 带 default 标签——设置页不再显示「未命名 Key」', () => {
    // 痛点：老用户升级后 Key 面板显示「未命名 Key」，看起来像自己没配过或迁移丢了东西。
    // 填 'default' 而非 provider 名：卡片上已写着 provider 名，重复一遍是冗余；'default'
    // 才传达「这是自动创建的主 key」。该值与 id（DEFAULT_KEY_ID）天然一致。
    const prov = provider({ keyRef: 'relay', models: [model('relay-a')] })
    assert.equal(migrateProviderToKeys(prov, policy), true)
    assert.equal(key0(prov).id, DEFAULT_KEY_ID)
    assert.equal(key0(prov).label, 'default')
  })

  it('合成时刻已存在 keys 时不覆盖（幂等，不重写 label）', () => {
    const existing = provider({
      keyRef: 'relay',
      keys: [{ id: DEFAULT_KEY_ID, keyRef: 'relay', label: '我自己起的名', models: [] }],
    })
    assert.equal(migrateProviderToKeys(existing, policy), false)
    assert.equal(existing.keys![0]!.label, '我自己起的名', '已有 keys 池时不得被动过')
  })

  it('carries each legacy credential slot it finds', () => {
    const env = provider({ apiKeyEnv: 'RELAY_API_KEY', models: [model('m')] })
    migrateProviderToKeys(env, policy)
    assert.equal(key0(env).apiKeyEnv, 'RELAY_API_KEY')
    assert.equal(key0(env).apiKey, undefined)
    assert.equal(key0(env).keyRef, undefined)

    const inline = provider({ apiKey: 'sk-inline', models: [model('m')] })
    migrateProviderToKeys(inline, policy)
    assert.equal(key0(inline).apiKey, 'sk-inline')
  })

  it('does NOT migrate a credential-less provider that merely declares models', () => {
    // 反向用例（原实现的 hasUserCredential 判据）：deepMerge 让每个预设 provider
    // 都带着预设的 apiKeyEnv 和 models，若把这些当存量凭证就会给「用户从未配置」
    // 的 provider 合成 keys[0]；此后 setApiKey 写的是顶层 keyRef，而请求端读
    // keys[0] 的 apiKeyEnv —— 用户刚设的 key 被静默忽略，模型切不了。
    const prov = provider({ models: [model('local-a')] })
    assert.equal(migrateProviderToKeys(prov, policy), false)
    assert.equal(prov.keys, undefined)
  })

  it('never lets a preset-inherited apiKeyEnv become a key credential', () => {
    // apiKeyEnv 与预设同名 = 继承值，不是用户为该 key 选的来源，不进 keys[0]。
    const inherited = provider({ apiKeyEnv: 'DEEPSEEK_API_KEY', models: [model('m')] })
    assert.equal(migrateProviderToKeys(inherited, policy), false)

    // 与预设不同名 = 用户显式指定 → 迁移，且该槽位随 key 走。
    const explicit = provider({ apiKeyEnv: 'MY_OWN_ENV', models: [model('m')] })
    assert.equal(migrateProviderToKeys(explicit, policy), true)
    assert.equal(key0(explicit).apiKeyEnv, 'MY_OWN_ENV')
  })

  it('leaves a provider with neither credential nor models alone', () => {
    const prov = provider({})
    assert.equal(migrateProviderToKeys(prov, policy), false)
    assert.equal(prov.keys, undefined)
  })

  it('is idempotent and never overwrites an existing key pool', () => {
    const prov = provider({ keyRef: 'relay', models: [model('relay-a')] })
    migrateProviderToKeys(prov, policy)
    const first = prov.keys
    assert.equal(migrateProviderToKeys(prov, policy), false)
    assert.equal(prov.keys, first)
    prov.keys = [{ id: 'k_1', models: [] } as never]
    // 已有 keys 时，即便顶层还留着旧槽位也不合成——幂等的硬条件。
    assert.equal(migrateProviderToKeys(prov, policy), false)
    assert.equal(prov.keys!.length, 1)
    assert.equal(key0(prov).id, 'k_1')
  })
})

describe('key pool views', () => {
  it('maps a migrated provider to one pool per key, and legacy to a single ownerless pool', () => {
    const migrated = provider({
      keys: [
        { id: 'k1', models: [model('a')] },
        { id: 'k2', models: [] },
      ],
    })
    const pools = providerKeyPools(migrated)
    assert.equal(pools.length, 2)
    assert.equal(pools[0]!.owner?.id, 'k1')
    assert.equal(pools[1]!.owner?.id, 'k2')
    assert.equal(pools[1]!.models.length, 0)

    const legacy = provider({ models: [model('a')] })
    const legacyPools = providerKeyPools(legacy)
    assert.equal(legacyPools.length, 1)
    assert.equal(legacyPools[0]!.owner, null)
    assert.equal(legacyPools[0]!.models.length, 1)

    // 未迁移 provider 恒有一个 owner=null 的回退池（模型可能为空）——与
    // resolveModelSpec 的 `prov.keys?.length ? keys.map(..) : [{owner:null,...}]` 同形。
    const empty = providerKeyPools(provider({}))
    assert.equal(empty.length, 1)
    assert.equal(empty[0]!.owner, null)
    assert.deepEqual(empty[0]!.models, [])
  })

  it('contractModels unions models across keys, keeping first-seen order and dropping duplicates', () => {
    const prov = provider({
      keys: [
        { id: 'k1', models: [model('shared'), model('a')] },
        { id: 'k2', models: [model('b'), model('shared')] },
      ],
    })
    assert.deepEqual(contractModels(prov).map(m => m.id), ['shared', 'a', 'b'])
    // 未迁移 provider → 顶层快照（语义与迁移前一致）
    const legacy = provider({ models: [model('legacy-a')] })
    assert.deepEqual(contractModels(legacy).map(m => m.id), ['legacy-a'])
  })

  it('defaultKeyOf picks the migrated default key, falling back to the first key', () => {
    assert.equal(defaultKeyOf(provider({ models: [model('a')] })), undefined)
    const withDefault = provider({ keys: [{ id: 'kx', models: [] }, { id: DEFAULT_KEY_ID, models: [] }] })
    assert.equal(defaultKeyOf(withDefault)?.id, DEFAULT_KEY_ID)
    const noDefault = provider({ keys: [{ id: 'kx', models: [] }] })
    assert.equal(defaultKeyOf(noDefault)?.id, 'kx')
  })

  it('resolves a model to its owning key by id（alias 已废弃）, first key wins on collision', () => {
    const prov = provider({
      keys: [
        { id: 'k1', models: [model('dup')] },
        { id: 'k2', models: [model('dup'), model('solo')] },
      ],
    })
    assert.equal(findModelOwner(prov, 'solo')!.owner?.id, 'k2')
    assert.equal(findModelOwner(prov, 'dup')!.owner?.id, 'k1')
    assert.equal(findModelOwner(prov, 'dup-alias'), undefined)
    assert.equal(findModelOwner(prov, 'nope'), undefined)
    assert.equal(findModelOwner(prov, ''), undefined)

    // 精确选择：provider:keyId:modelId 能绕过撞名拿到第二个 key 的同 id 模型。
    assert.equal(findModelInKey(prov, 'k2', 'dup')!.owner?.id, 'k2')
    assert.equal(findModelInKey(prov, 'k1', 'solo'), undefined)
  })

  it('treats an unmigrated provider as its own default key for exact selection', () => {
    const legacy = provider({ models: [model('a')] })
    assert.equal(findModelInKey(legacy, DEFAULT_KEY_ID, 'a')!.owner, null)
  })
})

describe('parseModelRef', () => {
  it('parses bare, provider-scoped and key-scoped references', () => {
    assert.deepEqual(parseModelRef('gpt-x'), { modelRef: 'gpt-x' })
    assert.deepEqual(parseModelRef('relay:gpt-x'), { provider: 'relay', modelRef: 'gpt-x' })
    assert.deepEqual(parseModelRef('relay:k2:gpt-x'), { provider: 'relay', keyId: 'k2', modelRef: 'gpt-x' })
  })

  it('keeps the legacy provider:modelId behaviour for degenerate inputs', () => {
    assert.deepEqual(parseModelRef(''), { modelRef: '' })
    assert.deepEqual(parseModelRef(':gpt-x'), { modelRef: ':gpt-x' })
    assert.deepEqual(parseModelRef('relay:'), { provider: 'relay', modelRef: '' })
  })

  it('leaves the colon-model-id disambiguation to the caller (needs config)', () => {
    // ollama:qwen3:32b 机械切成 keyId=qwen3 —— 是否是 keyId 由 disambiguateKeyPrefix
    // 拿配置核对（本层不持有配置）。下一步见下面那个 describe。
    assert.deepEqual(parseModelRef('ollama:qwen3:32b'), { provider: 'ollama', keyId: 'qwen3', modelRef: '32b' })
  })
})

/**
 * 消歧义是 parseModelRef 的必需配套步骤，不是可选项。
 *
 * 这条不变量曾经只靠调用方自觉：parseModelRef 的注释写「见 serve.resolveModelSpec」，
 * serve 那侧实现了守卫，main.ts 那侧没有 —— 于是 `--model ollama:qwen3:32b` 在
 * headless 下被判成 keyId=qwen3 → findModelInKey 落空 → 模型回落 models[0]、凭据
 * 拿空 → "API key not set" 退出。真进程回归见
 * ./provider-key-ownership-headless-e2e.test.ts。
 */
describe('disambiguateKeyPrefix', () => {
  const withKeys = (name: string, keyIds: string[], models: string[]) => ({
    [name]: provider({
      name,
      keys: keyIds.map(id => ({ id, models: models.map(m => model(m)) })),
    }),
  })

  it('中间段是现存 key id 时保留为 keyId（三段式生效）', () => {
    const providers = withKeys('olm', ['default', 'second'], ['m'])
    assert.deepEqual(
      disambiguateKeyPrefix(providers, parseModelRef('olm:second:m')),
      { provider: 'olm', keyId: 'second', modelRef: 'm' },
    )
  })

  it('中间段不是 key id 时还原进 modelRef（模型 id 自带冒号）', () => {
    const providers = withKeys('olm', ['default', 'second'], ['qwen3:32b'])
    assert.deepEqual(
      disambiguateKeyPrefix(providers, parseModelRef('olm:qwen3:32b')),
      { provider: 'olm', modelRef: 'qwen3:32b' },
    )
  })

  it('provider 不存在或缺 keys 池时同样还原——不得凭猜测当成 keyId', () => {
    assert.deepEqual(
      disambiguateKeyPrefix({}, parseModelRef('nope:k:m')),
      { provider: 'nope', modelRef: 'k:m' },
    )
    const noPool = { relay: provider({ name: 'relay', models: [model('m')] }) }
    assert.deepEqual(
      disambiguateKeyPrefix(noPool, parseModelRef('relay:k:m')),
      { provider: 'relay', modelRef: 'k:m' },
    )
  })

  it('两段式与裸 id 原样透传（无 keyId 可歧义）', () => {
    const providers = withKeys('olm', ['second'], ['m'])
    assert.deepEqual(disambiguateKeyPrefix(providers, parseModelRef('olm:m')), { provider: 'olm', modelRef: 'm' })
    assert.deepEqual(disambiguateKeyPrefix(providers, parseModelRef('m')), { modelRef: 'm' })
  })
})

describe('keyRef namespace', () => {
  it('keeps the provider name as the reference for the migrated default key', () => {
    assert.equal(keyRefFor('relay', DEFAULT_KEY_ID), 'relay')
    assert.equal(keyRefFor('relay', 'k_abc'), 'relay:k_abc')
  })
})

describe('resolveCredentialKey', () => {
  it('walks keyRef → apiKey → apiKeyEnv → <NAME>_API_KEY and throws when every slot is empty', () => {
    process.env.KEYSLOT_PROBE_ENV = 'sk-env'
    process.env.KEYSLOT_PROBE_NAME_API_KEY = 'sk-standard'
    try {
      assert.equal(resolveCredentialKey({ apiKey: 'sk-inline', name: 'rivot' }), 'sk-inline')
      assert.equal(resolveCredentialKey({ apiKeyEnv: 'KEYSLOT_PROBE_ENV', name: 'rivot' }), 'sk-env')
      assert.equal(resolveCredentialKey({ name: 'keyslot_probe_name' }), 'sk-standard')
      assert.throws(
        () => resolveCredentialKey({ name: 'nothing_configured_here' }),
        /No API key configured/,
      )
    } finally {
      delete process.env.KEYSLOT_PROBE_ENV
      delete process.env.KEYSLOT_PROBE_NAME_API_KEY
    }
  })
})

describe('loadConfig key migration', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-multikey-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  /** 存量形态：keyRef + 顶层 models，没有 keys 字段（旧版 rivet 写出来的样子）。 */
  function seedLegacyProvider(): string {
    const cfg = loadConfig()
    const raw = JSON.parse(JSON.stringify(cfg)) as {
      provider: { providers: Record<string, unknown> }
    }
    raw.provider.providers['legacy-relay'] = {
      name: 'legacy-relay',
      baseUrl: 'https://relay.example.com/v1',
      protocol: 'openai',
      keyRef: 'legacy-relay',
      models: [{ id: 'relay-a' }, { id: 'relay-b' }],
    }
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify(raw, null, 2))
    return path
  }

  it('synthesizes keys[0] in memory while leaving the layer-3 compatibility slots intact', () => {
    seedLegacyProvider()
    const cfg = loadConfig()
    const prov = cfg.provider.providers['legacy-relay']!
    assert.equal(prov.keys?.length, 1)
    assert.equal(key0(prov).id, DEFAULT_KEY_ID)
    assert.equal(key0(prov).keyRef, 'legacy-relay')
    assert.deepEqual(key0(prov).models.map(m => m.id), ['relay-a', 'relay-b'])
    // 旧槽位与顶层 models 未被动过——未迁移消费方（CLI/TUI 旧路径）行为不变。
    assert.equal(prov.keyRef, 'legacy-relay')
    assert.deepEqual(prov.models.map(m => m.id), ['relay-a', 'relay-b'])
    assert.equal(key0(prov).models, prov.models)
  })

  it('is idempotent across loads and never writes keys back into config.json', () => {
    const path = seedLegacyProvider()
    const first = loadConfig().provider.providers['legacy-relay']!
    const firstKeys = JSON.stringify(first.keys)
    const onDisk = readFileSync(path, 'utf8')
    const second = loadConfig().provider.providers['legacy-relay']!
    assert.equal(JSON.stringify(second.keys), firstKeys)
    assert.equal(second.keys!.length, 1)
    assert.equal(readFileSync(path, 'utf8'), onDisk, 'loadConfig must not rewrite config.json for the keys synthesis')
    const persisted = JSON.parse(onDisk) as { provider: { providers: Record<string, { keys?: unknown }> } }
    assert.equal(persisted.provider.providers['legacy-relay']!.keys, undefined, 'keys is an in-memory synthesis — disk keeps the legacy shape')
  })

  it('promotes an inline key inside keys[] into secrets.json instead of losing it', () => {
    const cfg = loadConfig()
    const raw = JSON.parse(JSON.stringify(cfg)) as {
      provider: { providers: Record<string, unknown> }
    }
    raw.provider.providers['inline-relay'] = {
      name: 'inline-relay',
      baseUrl: 'https://relay.example.com/v1',
      protocol: 'openai',
      keys: [{ id: 'k_inline', apiKey: 'sk-inline-key2', models: [{ id: 'relay-c' }] }],
    }
    writeFileSync(join(dir, 'config.json'), JSON.stringify(raw, null, 2))

    const loaded = loadConfig().provider.providers['inline-relay']!
    assert.equal(key0(loaded).keyRef, 'inline-relay:k_inline')
    assert.equal(key0(loaded).apiKey, undefined)
    assert.equal(readSecret('inline-relay:k_inline'), 'sk-inline-key2')
  })

  it('never writes a plaintext key from keys[] to disk', () => {
    const path = seedLegacyProvider()
    const cfg = loadConfig()
    cfg.provider.providers['legacy-relay']!.keys!.push({
      id: 'k_plain',
      apiKey: 'sk-should-not-persist',
      models: [],
    } as never)
    saveConfig(cfg)
    // 明文不落盘——config.json 与 keys 文件都不得含明文（A′ 后 keys 池迁到
    // provider-keys.json，剥离纪律必须在两个落盘面上同时成立）。
    const onDisk = readFileSync(path, 'utf8')
    assert.ok(!onDisk.includes('sk-should-not-persist'), 'config.json 不得含明文')
    const keysFileRaw = existsSync(providerKeysPath()) ? readFileSync(providerKeysPath(), 'utf8') : ''
    assert.ok(!keysFileRaw.includes('sk-should-not-persist'), 'provider-keys.json 不得含明文')
    // 池本身（连同新增的 k_plain 条目）完整落在 keys 文件里
    const persisted = readProviderKeysFile()
    assert.deepEqual(
      persisted?.providers['legacy-relay']?.map(k => k.id),
      [DEFAULT_KEY_ID, 'k_plain'],
    )
  })
})

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  providerKeysPath,
  readProviderKeysFile,
  writeProviderKeysFile,
  providerKeysFileMode,
  PROVIDER_KEYS_FILE_VERSION,
} from '../provider-keys-store.js'
import { registerProvider, loadConfig } from '../manager.js'
import { addProviderKey, removeProviderKey } from '../provider-key-store.js'
import { readSecret } from '../secrets-store.js'

describe('provider-keys-store — 磁盘边界', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'probe-pkstore-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })
  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('路径与 config.json 同目录，名称为 provider-keys.json', () => {
    const p = providerKeysPath()
    assert.equal(p, join(dir, 'provider-keys.json'))
    assert.equal(p.startsWith(dir), true)
  })

  it('写入后读回完整 key 池，且权限为 0600', () => {
    writeProviderKeysFile({
      version: PROVIDER_KEYS_FILE_VERSION,
      providers: {
        relay: [
          { id: 'default', keyRef: 'relay', models: [{ id: 'm1', contextWindow: 128000, maxTokens: 8192 }] },
          { id: 'second', label: '二号', keyRef: 'relay:second', models: [{ id: 'm2', contextWindow: 128000, maxTokens: 8192 }] },
        ],
      },
    })
    const back = readProviderKeysFile()
    assert.ok(back, '读回存在')
    assert.deepEqual(Object.keys(back.providers), ['relay'])
    assert.equal(back.providers.relay?.length, 2)
    assert.equal(back.providers.relay?.[1]?.label, '二号')
    assert.equal(statSync(providerKeysPath()).mode & 0o777, 0o600)
  })

  it('文件缺失时返回 undefined（fail-open，不抛）', () => {
    assert.equal(readProviderKeysFile(), undefined)
    assert.equal(providerKeysFileMode(), undefined)
  })

  it('删除默认 key 时把存活 key 的凭据提升到顶层槽（防顶层 keyRef 悬空）', () => {
    // 2026-09-23：默认 key 的 keyRef = provider 名 = 顶层槽位凭据。直接删会让顶层
    // 悬空——状态面板显示未配置、供应商从设置列表消失、默认供应商场景下一次快照
    // 重建 resolveApiKey 抛错把整机打进 setup 模式。提升后顶层与池共享存活 key 的 ref。
    registerProvider({
      providerName: 'relay-promote',
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-main',
      models: [{ id: 'm1', contextWindow: 128000, maxTokens: 8192 }],
    })
    const spare = addProviderKey('relay-promote', {
      apiKey: 'sk-spare',
      models: [{ id: 'm2', contextWindow: 128000, maxTokens: 8192 }],
    })
    const spareRef = `relay-promote:${spare.id}`

    const result = removeProviderKey('relay-promote', 'default')
    assert.equal(result.secretDeleted, true, '旧默认 key 的 secret（provider 名 ref）应回收')

    const cfg = loadConfig()
    const provider = cfg.provider.providers['relay-promote']!
    assert.equal(provider.keyRef, spareRef, '顶层槽位提升到存活 key 的 ref')
    assert.equal(readSecret(spareRef), 'sk-spare', '存活 key 的 secret 不动')
    assert.equal(readSecret('relay-promote'), undefined, '旧顶层 secret 已回收')
    assert.deepEqual(provider.keys!.map(k => k.id), [spare.id])
  })

  it('提升过的 key 再被删时顶层槽随之一并改指，不钉住已删 ref（僵尸凭据）', () => {
    // 2026-09-23 复审：旧提升条件写死 keyId === DEFAULT_KEY_ID。默认 key 被删时
    // 顶层 keyRef 提升到 keys[0] 的 ref；那个 key 日后再被删时 id 并非 default，
    // 不触发提升——顶层槽继续钉着已删 key 的 ref，其 secret 因「仍被顶层引用」
    // 永远不可回收（僵尸凭据）。不变量应是「被删 key 的 keyRef 正是顶层槽当前
    // 所指」而非「被删 key 的 id 是 default」。
    registerProvider({
      providerName: 'relay-zombie',
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-main',
      models: [{ id: 'm1', contextWindow: 128000, maxTokens: 8192 }],
    })
    const first = addProviderKey('relay-zombie', {
      apiKey: 'sk-first',
      models: [{ id: 'm2', contextWindow: 128000, maxTokens: 8192 }],
    })
    const second = addProviderKey('relay-zombie', {
      apiKey: 'sk-second',
      models: [{ id: 'm3', contextWindow: 128000, maxTokens: 8192 }],
    })
    const firstRef = `relay-zombie:${first.id}`
    const secondRef = `relay-zombie:${second.id}`

    // 先删默认 key：顶层槽提升到 first（既有行为，见上一用例）。
    removeProviderKey('relay-zombie', 'default')
    assert.equal(loadConfig().provider.providers['relay-zombie']!.keyRef, firstRef)

    // 再删被提升的 first——它 id 不是 default，但顶层槽正钉着它的 ref。
    const result = removeProviderKey('relay-zombie', first.id)
    assert.equal(result.secretDeleted, true, '顶层不再引用后，被删 key 的 secret 应回收')

    const cfg = loadConfig()
    const provider = cfg.provider.providers['relay-zombie']!
    assert.equal(provider.keyRef, secondRef, '顶层槽位提升到新的 keys[0]，不再钉住已删 key 的 ref')
    assert.equal(readSecret(firstRef), undefined, '已删 key 的 secret 已回收（无僵尸凭据）')
    assert.equal(readSecret(secondRef), 'sk-second', '存活 key 的 secret 不动')
    assert.deepEqual(provider.keys!.map(k => k.id), [second.id])
  })

  it('删未被顶层引用的 key 时顶层槽原样保留（不误提升）', () => {
    // 配套护栏：不变量只在「顶层钉着被删 ref」时触发。顶层指向别的存活 key 时，
    // 删一个无关 key 不应改写顶层槽。
    registerProvider({
      providerName: 'relay-untouched',
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-main',
      models: [{ id: 'm1', contextWindow: 128000, maxTokens: 8192 }],
    })
    const spare = addProviderKey('relay-untouched', {
      apiKey: 'sk-spare',
      models: [{ id: 'm2', contextWindow: 128000, maxTokens: 8192 }],
    })

    const result = removeProviderKey('relay-untouched', spare.id)
    assert.equal(result.secretDeleted, true)

    const provider = loadConfig().provider.providers['relay-untouched']!
    assert.equal(provider.keyRef, 'relay-untouched', '顶层槽仍指向默认 key 的 ref，未被改动')
    assert.equal(readSecret('relay-untouched'), 'sk-main', '默认 key 的 secret 不动')
    assert.deepEqual(provider.keys!.map(k => k.id), ['default'])
  })

  it('env 型默认 key 被删时同样提升（apiKeyEnv 对称面）', () => {
    // 顶层槽钉的不一定是 keyRef——env 型 provider 钉的是 apiKeyEnv 名。被删 key
    // 的 apiKeyEnv 与顶层同名时同样触发提升，与旧「按 default id 提升」行为一致。
    process.env.RELAY_ENV_KEY = 'sk-from-env'
    try {
      registerProvider({
        providerName: 'relay-env',
        baseUrl: 'https://relay.example.com/v1',
        apiKeyEnv: 'RELAY_ENV_KEY',
        models: [{ id: 'm1', contextWindow: 128000, maxTokens: 8192 }],
      })
      const spare = addProviderKey('relay-env', {
        apiKey: 'sk-spare',
        models: [{ id: 'm2', contextWindow: 128000, maxTokens: 8192 }],
      })
      const spareRef = `relay-env:${spare.id}`

      // 默认 key（apiKeyEnv=RELAY_ENV_KEY，与顶层槽同名）被删 → 提升到 spare。
      removeProviderKey('relay-env', 'default')

      const provider = loadConfig().provider.providers['relay-env']!
      assert.equal(provider.keyRef, spareRef, '顶层槽提升到存活 key 的 ref')
      assert.equal(provider.apiKeyEnv, undefined, '顶层 env 槽随之改指，不再钉已删 key 的 env 名')
      assert.equal(readSecret(spareRef), 'sk-spare', '存活 key 的 secret 不动')
      assert.deepEqual(provider.keys!.map(k => k.id), [spare.id])
    } finally {
      delete process.env.RELAY_ENV_KEY
    }
  })

  it('JSON 损坏时返回 undefined，不抛异常', () => {
    writeFileSync(providerKeysPath(), '{ this is not json')
    assert.equal(readProviderKeysFile(), undefined)
  })

  it('version 不匹配时返回 undefined（拒绝误读他版形状）', () => {
    writeFileSync(providerKeysPath(), JSON.stringify({ version: 99, providers: { a: [] } }))
    assert.equal(readProviderKeysFile(), undefined)
  })

  it('单条坏 key 被丢弃，其余有效条目保留', () => {
    writeFileSync(providerKeysPath(), JSON.stringify({
      version: PROVIDER_KEYS_FILE_VERSION,
      providers: {
        relay: [
          { id: 'ok-one', models: [] },
          { noIdHere: true },
        ],
      },
    }))
    const back = readProviderKeysFile()
    assert.ok(back)
    assert.equal(back.providers.relay?.length, 1)
    assert.equal(back.providers.relay?.[0]?.id, 'ok-one')
  })

  it('写入是原子的：目录里不残留 .tmp', () => {
    writeProviderKeysFile({ version: PROVIDER_KEYS_FILE_VERSION, providers: { a: [{ id: 'k', models: [] }] } })
    const leftovers = readdirSafe(dir).filter(f => f.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])
    assert.equal(existsSync(providerKeysPath()), true)
    // 文件内容是合法 JSON（可被再次解析）
    assert.doesNotThrow(() => JSON.parse(readFileSync(providerKeysPath(), 'utf-8')))
  })
})

function readdirSafe(d: string): string[] {
  try {
    return readdirSync(d)
  } catch {
    return []
  }
}

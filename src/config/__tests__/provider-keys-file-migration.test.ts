/**
 * A′：keys 池迁出 config.json —— 落盘纪律 + 一次幂等迁移。
 *
 * 背景（复现见 docs/plans/provider-keys-cross-version-compat.md §1）：keys 存在
 * config.json 里时，旧版 rivet（不认该字段）的 saveConfig 会不可逆抹掉整个池。
 * 迁到 provider-keys.json 后旧版碰不到它。
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, saveConfig } from '../manager.js'
import { providerKeysPath, readProviderKeysFile } from '../provider-keys-store.js'

const TWO_KEY_CONFIG = {
  provider: {
    default: 'relay',
    providers: {
      relay: {
        name: 'relay',
        baseUrl: 'https://example.invalid/v1',
        keyRef: 'relay',
        keys: [
          { id: 'default', keyRef: 'relay', models: [{ id: 'm1' }] },
          { id: 'second', label: '二号', keyRef: 'relay:second', models: [{ id: 'm2' }] },
        ],
        models: [{ id: 'm1' }],
        userSaved: true,
      },
    },
  },
}

describe('A′ — keys 池从 config.json 迁出', () => {
  let dir: string
  const cfgPath = () => join(dir, 'config.json')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'probe-pkfile-'))
    process.env.RIVET_CONFIG_PATH = cfgPath()
  })
  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  const writeCfg = (obj: unknown) => writeFileSync(cfgPath(), JSON.stringify(obj, null, 2))

  it('saveConfig 后 config.json 不再带 provider.keys，池落在 provider-keys.json（0600）', () => {
    writeCfg(TWO_KEY_CONFIG)
    const cfg = loadConfig()
    saveConfig(cfg)

    const onDisk = JSON.parse(readFileSync(cfgPath(), 'utf-8'))
    const relay = onDisk.provider.providers.relay
    assert.equal('keys' in relay, false, 'config.json 里不得再有 keys 字段')

    const file = readProviderKeysFile()
    assert.ok(file, 'provider-keys.json 应已生成')
    assert.equal(file.providers.relay?.length, 2)
    assert.equal(file.providers.relay?.[1]?.label, '二号')
    // 0600 纵深防御仅 POSIX 适用（Windows/NTFS 由 ACL 决定访问控制）。
    if (process.platform !== 'win32') {
      assert.equal(statSync(providerKeysPath()).mode & 0o777, 0o600)
    }
  })

  it('迁移是一次性且幂等的：文件已存在时 load 不再重写', () => {
    writeCfg(TWO_KEY_CONFIG)
    loadConfig()
    const first = readFileSync(providerKeysPath(), 'utf-8')
    const firstMtime = statSync(providerKeysPath()).mtimeMs

    // 再 load 两次——文件内容与 mtime 都不应变化
    loadConfig()
    loadConfig()
    assert.equal(readFileSync(providerKeysPath(), 'utf-8'), first, '内容稳定')
    assert.equal(statSync(providerKeysPath()).mtimeMs, firstMtime, '未被重写')
  })

  it('文件权威：文件里的池覆盖 config.json 里的旧值', () => {
    writeCfg(TWO_KEY_CONFIG)
    // 先迁一次拿到文件
    saveConfig(loadConfig())
    // 人为把 config.json 里的 keys 改成只有一条（模拟旧版 strip 后残留 / 手工编辑）
    const crippled = JSON.parse(JSON.stringify(TWO_KEY_CONFIG))
    crippled.provider.providers.relay.keys = [{ id: 'default', keyRef: 'relay', models: [] }]
    writeCfg(crippled)

    const cfg = loadConfig()
    assert.equal(cfg.provider.providers.relay?.keys?.length, 2, '文件是权威源，2 条完整存活')
    assert.equal(cfg.provider.providers.relay?.keys?.[1]?.id, 'second')
  })

  it('文件损坏时回退 config.json 的历史 keys（fail-open，不丢配置）', () => {
    writeCfg(TWO_KEY_CONFIG)
    writeFileSync(providerKeysPath(), '{ 坏掉的 json')

    const cfg = loadConfig()
    assert.equal(cfg.provider.providers.relay?.keys?.length, 2, '回退到 config.json 的 keys')
  })

  it('已配凭证的单 key provider 迁成 keys[0] 落文件；config.json 只留顶层指针', () => {
    // 注意语义：带 keyRef 的 provider 会被 migrateProviderToKeys 合成 keys[0]（幂等
    // 迁移，PR-3 既有行为），所以「单 key 也会生成文件」是预期，不是多余产物。
    writeCfg({
      provider: {
        default: 'solo',
        providers: {
          solo: { name: 'solo', baseUrl: 'https://example.invalid/v1', keyRef: 'solo', models: [{ id: 'm' }], userSaved: true },
        },
      },
    })
    saveConfig(loadConfig())
    const file = readProviderKeysFile()
    assert.ok(file, '已配凭证的 provider 应迁成 keys[0] 落文件')
    assert.equal(file.providers.solo?.length, 1)
    assert.equal(file.providers.solo?.[0]?.keyRef, 'solo')
    const relay = JSON.parse(readFileSync(cfgPath(), 'utf-8')).provider.providers.solo
    assert.equal('keys' in relay, false, 'config.json 里不留 keys')
    assert.equal(relay.keyRef, 'solo', '顶层兼容槽保留，旧版照常读到凭据')
  })

  it('未配任何凭证的 provider 不产生文件条目（零影响）', () => {
    writeCfg({
      provider: {
        default: 'bare',
        providers: {
          bare: { name: 'bare', baseUrl: 'https://example.invalid/v1', models: [{ id: 'm' }] },
        },
      },
    })
    saveConfig(loadConfig())
    const file = readProviderKeysFile()
    const providersWithPool = Object.keys(file?.providers ?? {})
    assert.deepEqual(providersWithPool, [], '没有凭证就没有池')
  })

  it('版本号与 secrets.json 同规（version: 1）', () => {
    writeCfg(TWO_KEY_CONFIG)
    saveConfig(loadConfig())
    const raw = JSON.parse(readFileSync(providerKeysPath(), 'utf-8'))
    assert.equal(raw.version, 1)
    assert.ok(raw.providers && typeof raw.providers === 'object')
  })
})

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../manager.js'

// config.example.json 原来带一个 `cache` 块（enabled / minSystemTokens / showHitRate），
// 而它在 schema 里从来不存在：configSchema 的顶层键是 provider / agent / compact /
// search / fetch / network / editor / mcp / workers / skills / mirrors / … ——没有 cache；
// `minSystemTokens` 与 `showHitRate` 在全仓 src/ 里 0 处引用（连 desktop/scripts 也算上）。
//
// zod 的 z.object 默认 strip 未知键，所以 loadConfig 把这三个键**静默吃掉**：不报错、
// 不告警、不回落。而 README 中/英/日/韩四版与 docs/user-guide.md 都照抄了这个块，于是
// 用户照着文档设 `"showHitRate": false`、重启、什么都没发生——一个文档承诺了却压根不
// 存在的旋钮，比没有这个旋钮更糟，因为它把用户引到错误的查找方向上。
//
// 真正管这两件事的是别的键：命中率显示 = ui.glanceDensity（'compact' | 'full'，'full'
// 才含 cache 段，运行时由 /glance 切换，见 schema.ts 的 uiSchema）；前缀缓存开关 =
// 模型级 prefixCache / cacheControl。本用例不锁这些键的值，只锁一条不变量——
//
//   示例配置里出现的每一个叶子键，都必须能在真实加载结果里找到。
//
// 这类漂移靠 review 拦不住（键名看着完全合理），只能靠断言。
const EXAMPLE_PATH = new URL('../../../config.example.json', import.meta.url)

/** 收集对象的全部叶子路径（`a.b.c`）；空对象与数组都算叶子。 */
function leafPaths(node: unknown, prefix = ''): string[] {
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    const entries = Object.entries(node as Record<string, unknown>)
    if (entries.length === 0) return prefix ? [prefix] : []
    return entries.flatMap(([key, value]) => leafPaths(value, prefix ? `${prefix}.${key}` : key))
  }
  return [prefix]
}

describe('config.example.json 的每个键都必须是真实存在的旋钮', () => {
  let isolatedDir = ''

  before(() => {
    // loadConfig 对真实用户配置有迁移回写副作用（见 config-schema-integration.test.ts
    // 的记录：migrateAnthropicProtocol 曾把 protocol 写进真实 config.json）。把用户层
    // 指到一个不存在的路径，让它退化成 defaults ⊕ overlay 的纯合并，既不碰真实配置，
    // 也不需要网络。
    isolatedDir = mkdtempSync(join(tmpdir(), 'rivet-example-config-'))
    process.env.RIVET_CONFIG_PATH = join(isolatedDir, 'config.json')
  })

  after(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(isolatedDir, { recursive: true, force: true })
  })

  it('示例配置没有任何被 schema 静默剥掉的叶子键', () => {
    const example = JSON.parse(readFileSync(EXAMPLE_PATH, 'utf-8')) as Record<string, unknown>
    const loaded = loadConfig({ sessionOverlay: example }) as unknown as Record<string, unknown>

    const present = new Set(leafPaths(loaded))
    const phantom = [...new Set(leafPaths(example))].filter(path => !present.has(path))

    assert.deepEqual(
      phantom,
      [],
      `config.example.json 里有 ${phantom.length} 个 schema 不认的键，`
      + `会被 loadConfig 静默剥掉——用户照示例改了不生效、也不报错：\n  ${phantom.join('\n  ')}\n`
      + '要么把键补进 src/config/schema.ts 并接上实现，要么从示例（及 README 四语版本、'
      + 'docs/user-guide.md 的同一份配置样例）里删掉。',
    )
  })

  // 上例只覆盖"示例写了、schema 没有"。反向（示例该写却没写）危害小得多，不锁。
  // 但样例必须保持合法 JSON——删块时留个尾逗号就是全仓最难查的那种坏。
  it('config.example.json 是合法 JSON 且顶层块非空', () => {
    const example = JSON.parse(readFileSync(EXAMPLE_PATH, 'utf-8')) as Record<string, unknown>
    const top = Object.keys(example)
    assert.ok(top.length > 0, 'config.example.json 顶层为空')
    assert.ok(top.every(key => key !== 'cache'), '`cache` 顶层块不该回来：schema 里没有这个键')
  })

  it('documents both MiniMax regions with the current model fleet', () => {
    const example = JSON.parse(readFileSync(EXAMPLE_PATH, 'utf-8')) as {
      provider: { providers: Record<string, { baseUrl?: string; models?: Array<{ id: string }> }> }
    }
    const providers = example.provider.providers
    assert.equal(providers.minimax?.baseUrl, 'https://api.minimax.io/v1')
    assert.equal(providers['minimax-cn']?.baseUrl, 'https://api.minimaxi.com/v1')
    const expected = ['MiniMax-M3.1-Flash', 'MiniMax-M3']
    assert.deepEqual(providers.minimax?.models?.map(model => model.id), expected)
    assert.deepEqual(providers['minimax-cn']?.models?.map(model => model.id), expected)
  })
})

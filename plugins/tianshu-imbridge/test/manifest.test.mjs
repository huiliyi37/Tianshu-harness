/**
 * 插件清单（tianshu.plugin.json）与 package.json 的契约测试。
 *
 * 为什么要有它：4.0.4 起宿主不再读 package.json 里的 `tianshu` 字段，
 * 改读独立的 TPI 清单。清单里的工具名一旦与实现脱节，宿主会注册不到工具，
 * 而单元测试全绿（2026-11-08 实测：五个插件全部因旧字段被判 invalid）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const readJson = (name) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'))

test('清单符合 TPI 1.0 必填字段', () => {
  const manifest = readJson('tianshu.plugin.json')
  assert.equal(manifest.$tpi, '1.0')
  assert.equal(manifest.kind, 'tianshu.plugin')
  assert.equal(manifest.id, 'tianshu-imbridge')
  assert.equal(manifest.runtime, 'agent')
  assert.equal(manifest.entry, 'index.js')
  assert.deepEqual(manifest.capabilities, ['tools'])
  assert.equal(typeof manifest.displayName, 'string')
  assert.ok(manifest.displayName.length > 0)
})

test('清单声明的工具名与 impl.js 完全一致（不多不少）', async () => {
  const manifest = readJson('tianshu.plugin.json')
  const { tools } = await import('../impl.js')
  const declared = manifest.contributes.tools.map((t) => t.name).sort()
  const actual = tools.map((t) => t.definition.name).sort()
  assert.deepEqual(declared, actual)
})

test('清单里每个工具都有非空 description（宿主据此给模型看）', () => {
  const manifest = readJson('tianshu.plugin.json')
  for (const t of manifest.contributes.tools) {
    assert.equal(typeof t.name, 'string')
    assert.ok(t.name.length > 0)
    assert.equal(typeof t.description, 'string')
    assert.ok(t.description.length > 0, `${t.name} 的 description 为空`)
  }
})

test('版本三方一致：清单 / package.json / 运行时上报', async () => {
  const manifest = readJson('tianshu.plugin.json')
  const pkg = readJson('package.json')
  const { VERSION } = await import('../runtime.js')
  assert.equal(manifest.version, pkg.version)
  assert.equal(manifest.version, VERSION)
})

test('package.json 不再包含被宿主拒绝的 tianshu 字段', () => {
  const pkg = readJson('package.json')
  assert.equal('tianshu' in pkg, false,
    '4.0.4 起 package.json.tianshu 会被判 invalid，必须只在 tianshu.plugin.json 里描述')
})

test('package.json 声明 Node 版本门槛（4.0.4 要求 >=24.22.1）', () => {
  const pkg = readJson('package.json')
  assert.equal(typeof pkg.engines?.node, 'string')
  assert.match(pkg.engines.node, /24\.22\.1/)
})

/**
 * plugin-session-cache（2026-09-12 sidecar 插件装配补齐）——暖场/快照/失效
 * 循环 + 三个接线点的源码契约（与 serve-agent-gate-wiring 同风格，防摘除）。
 *
 * 背景：buildSessionStores 同步装配，initializePlugins 异步——启动暖场一次
 * 进缓存，每会话同步合入快照；暖场未完成按无插件装配（无回归）。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  warmPluginToolsCache,
  pluginToolsSnapshot,
  invalidatePluginToolsCache,
  partitionPluginTools,
  __resetPluginToolsCacheForTests,
} from '../plugin-session-cache.js'

const activeDirs: string[] = []
const origHome = process.env.RIVET_HOME

after(() => {
  process.env.RIVET_HOME = origHome ?? ''
  if (origHome === undefined) delete process.env.RIVET_HOME
  for (const dir of activeDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
  __resetPluginToolsCacheForTests()
})

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'rivet-plugin-cache-'))
  activeDirs.push(home)
  process.env.RIVET_HOME = home
  return home
}

function writeFixturePlugin(home: string, name: string, toolName: string): void {
  const dir = join(home, 'plugins', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name,
    version: '1.0.0',
    tianshu: {
      name,
      version: '1.0.0',
      description: 'fixture plugin',
      entry: 'index.js',
      tools: [{ name: toolName, description: 'fixture tool' }],
      permissions: { fs: true },
    },
  }))
  writeFileSync(join(dir, 'index.js'), `
export const tools = [{
  definition: { name: '${toolName}', description: 'fixture', input_schema: { type: 'object', properties: {} } },
  execute: async () => ({ content: 'ok' }),
  requiresApproval: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}];
`)
}

/** 等待暖场 Promise 落定（fire-and-forget 的确定性收口——比 sleep 稳）。 */
async function waitForSnapshot(): Promise<void> {
  for (let i = 0; i < 200 && pluginToolsSnapshot() === null; i++) {
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('plugin-session-cache 暖场/快照/失效', () => {
  it('暖场完成 → 快照含插件工具；无插件目录 → scanned 0', async () => {
    __resetPluginToolsCacheForTests()
    const home = makeHome()
    writeFixturePlugin(home, 'alpha-plugin', 'alpha_tool')

    assert.equal(pluginToolsSnapshot(), null, '暖场前快照为 null（早期会话按无插件装配）')
    warmPluginToolsCache(undefined, process.cwd())
    await waitForSnapshot()
    const snap = pluginToolsSnapshot()
    assert.ok(snap, '暖场后快照应非空')
    assert.equal(snap!.loaded, 1)
    assert.deepEqual(snap!.tools.map((t) => t.definition.name), ['alpha_tool'])
    assert.deepEqual(snap!.suppressTools, [])
  })

  it('invalidate 清缓存并重建——新安装/启停下一个会话生效', async () => {
    __resetPluginToolsCacheForTests()
    const home = makeHome()
    writeFixturePlugin(home, 'alpha-plugin', 'alpha_tool')
    warmPluginToolsCache(undefined, process.cwd())
    await waitForSnapshot()
    assert.equal(pluginToolsSnapshot()!.loaded, 1)

    writeFixturePlugin(home, 'beta-plugin', 'beta_tool')
    invalidatePluginToolsCache(undefined, process.cwd())
    await waitForSnapshot()
    const snap = pluginToolsSnapshot()
    assert.equal(snap!.loaded, 2, '重建后新插件进快照')
    assert.deepEqual(snap!.tools.map((t) => t.definition.name).sort(), ['alpha_tool', 'beta_tool'])
  })

  it('invalidate 不传 config/cwd 只清不重建（快照回 null，等下次暖场）', async () => {
    __resetPluginToolsCacheForTests()
    const home = makeHome()
    writeFixturePlugin(home, 'alpha-plugin', 'alpha_tool')
    warmPluginToolsCache(undefined, process.cwd())
    await waitForSnapshot()
    invalidatePluginToolsCache()
    assert.equal(pluginToolsSnapshot(), null)
  })

  it('插件工具与内置工具同名 → 冲突检测拒绝（基座必须是内置工具全集，不能是空表）', async () => {
    // read_file 是内置工具（src/tools/read-file.ts）。基座若为空表，
    // plugin-loader 的 existingNames 恒为空集 → "reject entire plugin" 永不触发，
    // 同名插件工具经快照合入真实注册表后 register(Map.set) 会静默覆盖内置工具。
    // TUI 侧同类回归的 sidecar 版（main.ts:494 "empty PluginRegistry let every plugin pass"）。
    __resetPluginToolsCacheForTests()
    const home = makeHome()
    writeFixturePlugin(home, 'collide-plugin', 'read_file')

    warmPluginToolsCache(undefined, process.cwd())
    await waitForSnapshot()
    const snap = pluginToolsSnapshot()
    assert.ok(snap, '暖场应完成')
    assert.equal(
      snap!.tools.some((t) => t.definition.name === 'read_file'),
      false,
      '与内置工具同名的插件工具不得进入快照——否则装配时会静默覆盖内置工具',
    )
  })

  it('在飞暖场期间 invalidate → 最新请求排队重建（不被旧目录快照覆盖）', async () => {
    // 场景：启动暖场尚未落定（loading 非空）时用户装了新插件 → invalidate 触发重建。
    // 旧实现 `if (cache || loading) return` 让这次重建被整条丢弃，而飞行中的构建
    // 用的是「点火那一刻」的目录快照——新插件要等下一次 invalidate 才可能出现。
    __resetPluginToolsCacheForTests()
    const home = makeHome()
    writeFixturePlugin(home, 'alpha-plugin', 'alpha_tool')

    warmPluginToolsCache(undefined, process.cwd()) // 点火：此刻目录里只有 alpha
    writeFixturePlugin(home, 'beta-plugin', 'beta_tool') // 构建在飞期间新增
    invalidatePluginToolsCache(undefined, process.cwd()) // 应被排队，而非丢弃

    let snap: ReturnType<typeof pluginToolsSnapshot> = null
    for (let i = 0; i < 300; i++) {
      snap = pluginToolsSnapshot()
      if (snap && snap.tools.some((t) => t.definition.name === 'beta_tool')) break
      await new Promise((r) => setTimeout(r, 10))
    }
    assert.ok(snap, '快照应落定')
    assert.deepEqual(
      snap!.tools.map((t) => t.definition.name).sort(),
      ['alpha_tool', 'beta_tool'],
      '排队的重建必须生效——新插件要可见（旧实现被 loading 守卫静默丢弃）',
    )
  })
})

describe('合入前二次冲突过滤（暖场基座缺口的兜底）', () => {
  const mkTool = (name: string) => ({
    definition: { name, description: '', input_schema: { type: 'object', properties: {} } },
    execute: async () => ({ content: '' }),
    requiresApproval: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  })

  it('与真实装配工具同名者被拦下，其余放行', () => {
    // 暖场冲突检测的基座是 createDefaultToolRegistry（21 个基础工具），
    // 而 sidecar 真实装配走 createInteractiveToolRegistry——它额外注册 galaxy /
    // deliver_task / 域工具等（bootstrap.ts）。那些名字不在基座里，插件取用即可
    // 绕过检测、经 register(Map.set) 静默覆盖。合入点在真实注册表在手时兜底。
    const tools = [mkTool('deliver_task'), mkTool('my_plugin_tool'), mkTool('galaxy')]
    const existing = new Set(['deliver_task', 'galaxy', 'read_file'])
    const { accepted, blocked } = partitionPluginTools(tools as never, existing)
    assert.deepEqual(blocked, ['deliver_task', 'galaxy'], '与真实工具同名者必须被拦下')
    assert.deepEqual(
      accepted.map((t) => t.definition.name),
      ['my_plugin_tool'],
      '无冲突的插件工具应照常放行',
    )
  })

  it('无冲突时全量放行（不误伤）', () => {
    const tools = [mkTool('alpha_tool'), mkTool('beta_tool')]
    const { accepted, blocked } = partitionPluginTools(tools as never, new Set(['read_file']))
    assert.equal(blocked.length, 0)
    assert.equal(accepted.length, 2)
  })
})

describe('sidecar 插件装配接线（源码契约，防摘除）', () => {
  const serveAgentSrc = readFileSync(join(process.cwd(), 'src', 'server', 'serve-agent.ts'), 'utf8')
  const serveSrc = readFileSync(join(process.cwd(), 'src', 'server', 'serve.ts'), 'utf8')
  const pluginApiSrc = readFileSync(join(process.cwd(), 'src', 'server', 'plugin-api.ts'), 'utf8')

  it('serve-agent buildSessionStores 合入暖场快照（工具 + suppress + hooks/commands）', () => {
    assert.match(serveAgentSrc, /pluginToolsSnapshot\(\)/, '应读暖场快照')
    // 合入前必须过二次冲突过滤：暖场基座是 createDefaultToolRegistry，不含
    // createInteractiveToolRegistry 额外装配的 galaxy/deliver_task/域工具，
    // 裸注册会让同名插件工具静默覆盖它们。
    assert.match(serveAgentSrc, /partitionPluginTools\(pluginSnap\.tools/, '合入前应做二次冲突过滤')
    assert.match(serveAgentSrc, /for \(const tool of accepted\) toolRegistry\.register/, '应注册过滤后的快照工具')
    assert.match(serveAgentSrc, /pluginSnap\.suppressTools/, '应处理 suppressTools')
    assert.match(serveAgentSrc, /refs\.pluginHooks = pluginSnap\.hooks/, 'pluginHooks 应换真装配（不再是空数组）')
    assert.match(serveAgentSrc, /refs\.pluginCommands = pluginSnap\.commands/, 'pluginCommands 应换真装配')
  })

  it('runServe 启动暖场（initializePlugins 先于会话进入缓存）', () => {
    assert.match(serveSrc, /warmPluginToolsCache\(ctx\.config\.plugins, process\.cwd\(\)\)/, 'runServe 应启动暖场')
  })

  it('plugin-api 安装/启停/卸载三处失效重建', () => {
    const hits = pluginApiSrc.match(/invalidatePluginToolsCache\(/g) ?? []
    assert.ok(hits.length >= 3, `invalidate 应覆盖安装/启停/卸载三处（实际 ${hits.length}）`)
  })
})

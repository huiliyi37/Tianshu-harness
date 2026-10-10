import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { presetIncludes, resolveToolPreset, __resetToolPresetForTest, type ToolPreset } from '../tool-preset.js'
import { createDefaultToolRegistry } from '../default-registry.js'
import { setActiveScheduler, type CronScheduler } from '../../server/cron-scheduler.js'

const SCHEDULE_TOOLS = ['schedule_create', 'schedule_list', 'schedule_delete'] as const

/**
 * bootstrap.ts 里装配的、不经过 createDefaultToolRegistry 的工具。
 *
 * 2026-10-09 补齐：旧清单只列了 19 个手抄名，漏掉 bootstrap 侧三个真实注册点
 * （galaxy / starflow 有 presetIncludes 门控却没进清单，memory 干脆没门控），
 * 于是 totalCount 断言（30/31/51）比实装少 3 件。清单完整性现由
 * 「bootstrap.ts 漂移闸门」用例把守——源码新增门控工具而不改这里会红。
 */
const BOOTSTRAP_TOOLS = [
  'delegate_task', 'undo', 'delegate_batch', 'galaxy', 'team_orchestrate', 'council_convene',
  'starflow', 'recall_capsule', 'recall_general', 'record_general_finding', 'ask_user_question',
  'browser_debug', 'repo_graph', 'related_tests', 'semantic_search', 'apply_patch',
  'session_vitals', 'attack_case', 'plan_task', 'update_goal', 'memory',
  // 唯一无门控的一个：bootstrap.ts 里 createDeliverTaskTool 无条件注册。
  'deliver_task',
] as const

/** 文档口径的 taiyi 最小集（tool-preset.ts 文件头注释逐字列出）。 */
const TAIYI_TOOLSET = [
  'bash', 'read_file', 'write_file', 'edit_file', 'hash_edit', 'grep', 'glob',
  'git', 'todo', 'deliver_task', 'run_tests', 'job', 'plan', 'diff',
] as const

/**
 * 完整装配口径的名字集：kernel(default-registry) ∪ bootstrap 侧注册。
 *
 * 计数与「装配集精确断言」共用这一份计算——两边分开写会出现「计数说 15、
 * 集合断言说 14，而两边都绿」的盲区（首版就是这样漏掉了 memory）。
 */
function assembledNames(preset: ToolPreset): string[] {
  const kernel = createDefaultToolRegistry([], { preset }).getAllNames()
  const bootstrap = BOOTSTRAP_TOOLS.filter(n => n !== 'related_tests' && presetIncludes(preset, n))
  return [...new Set([...kernel, ...bootstrap])].sort()
}

function totalCount(preset: ToolPreset): number {
  return assembledNames(preset).length
}

describe('presetIncludes', () => {
  it('minimal keeps daily-dev tools and drops heavy/cold ones', () => {
    for (const keep of ['read_file', 'bash', 'grep', 'web_search', 'web_fetch', 'deliver_task', 'delegate_task', 'delegate_batch', 'apply_patch', 'plan_task', 'recall_capsule', 'ask_user_question']) {
      assert.ok(presetIncludes('minimal', keep), `minimal must keep ${keep}`)
    }
    for (const drop of ['council_convene', 'browser_debug', 'attack_case', 'semantic_search', 'repo_graph', 'undo', 'recall_general', 'record_general_finding', 'ast_edit', 'related_tests', 'inspect_project', 'import_resource', 'leave_mark', 'file_info', 'session_vitals', 'update_goal']) {
      assert.ok(!presetIncludes('minimal', drop), `minimal must drop ${drop}`)
    }
  })

  it('frontend = minimal + browser_debug', () => {
    assert.ok(presetIncludes('frontend', 'browser_debug'))
    assert.ok(!presetIncludes('frontend', 'attack_case'))
    assert.ok(!presetIncludes('frontend', 'council_convene'))
  })

  it('full includes everything', () => {
    for (const n of BOOTSTRAP_TOOLS) assert.ok(presetIncludes('full', n), n)
  })

  it('taiyi 白名单档：门控工具全 false，核心工具不受门控影响', () => {
    for (const drop of ['web_crawl', 'web_map', 'monitor', 'ast_edit', 'related_tests', 'inspect_project', 'import_resource', 'file_info', 'leave_mark', 'browser_debug']) {
      assert.ok(!presetIncludes('taiyi', drop), `taiyi must drop ${drop}`)
    }
    // 非门控工具（无条件注册）不受 presetIncludes 影响——由 registry 侧条件排除
    for (const keep of ['bash', 'read_file', 'edit_file', 'git']) {
      assert.ok(presetIncludes('taiyi', keep), `taiyi keeps ${keep}`)
    }
  })

  it('taiyi 专属排除：bootstrap 侧编排/辅助工具全 false（2026-08-07 闭环修复）', () => {
    // 此前 bootstrap 无条件注册这批工具，taiyi 实装远多于文档所载——
    // TAIYI_EXCLUDES + bootstrap 的 presetIncludes 门控补上闭环。
    const bootstrapOrchestration = [
      'delegate_task', 'delegate_batch', 'galaxy', 'starflow', 'team_orchestrate',
      'plan_task', 'apply_patch', 'recall_capsule', 'ask_user_question',
    ]
    for (const drop of bootstrapOrchestration) {
      assert.ok(!presetIncludes('taiyi', drop), `taiyi must drop ${drop}`)
    }
    // 其余三档语义与改动前逐字一致：这批名字不在 MINIMAL_EXCLUDES
    for (const preset of ['minimal', 'frontend', 'full'] as const) {
      for (const name of bootstrapOrchestration) {
        assert.ok(presetIncludes(preset, name), `${preset} keeps ${name}（taiyi 排除不外溢）`)
      }
    }
    // 14 核心集里的交付/计划闭环不受专属排除误伤。本断言测的是 TAIYI_EXCLUDES
    // 语义，故只列真实存在于 taiyi 档的名字——原先列 plan_submit/plan_close/memory
    // 是空断言：前两名已不是工具名（并作 plan），后者的排除走 default-registry 的
    // kernel 守卫（另一套机制），presetIncludes 对三者恒真、测不出任何东西。
    for (const keep of ['deliver_task', 'plan', 'todo', 'job', 'bash', 'diff']) {
      assert.ok(presetIncludes('taiyi', keep), `taiyi keeps ${keep}`)
    }
  })
})

describe('assembly counts per preset', () => {
  // 口径 = 无调度器的 CLI 交互模式。schedule 三工具按 isSchedulerAvailable()
  // 条件注册，有调度器的 serve/桌面端各档 +3（见下一条用例）。
  it('minimal=33 / frontend=34 / full=54 / taiyi=14（完整装配口径）', () => {
    // 2026-10-09 口径修正：旧断言 30/31/51 建立在一份手抄的 BOOTSTRAP_TOOLS 上，
    // 该清单漏了 bootstrap 侧三个真实注册点（galaxy / starflow / memory），每档
    // 都少记 3 件。清单已补齐，完整性由本文件末尾的源码漂移闸门把守。
    // git_scout 只读 git 侦察（3.14alpha 回流）：**taiyi 以外各档无条件注册**（+1）——
    // 它必须对 readonly worker 可见，而 worker 与主控共用同一张注册表，按档位
    // 排除会连带把 worker 也排掉（readonly profile 无 bash/git，正是要补这条缝）。
    // taiyi 仍按评测档纪律排除（冻结基线，见 tool-preset 的 drop 断言）。
    assert.equal(totalCount('minimal'), 33)
    assert.equal(totalCount('frontend'), 34)
    assert.equal(totalCount('full'), 54)
    // taiyi = 13（kernel 侧，即 tool-preset.ts 文件头 14 名清单除去 deliver_task）
    // + deliver_task（bootstrap 唯一无条件注册件）。
    assert.equal(totalCount('taiyi'), 14)
  })

  it('schedule 三工具按调度器存在与否条件注册', () => {
    for (const n of SCHEDULE_TOOLS) {
      assert.ok(!createDefaultToolRegistry([], { preset: 'full' }).has(n), `无调度器不注册 ${n}`)
    }
    // serve/桌面端：调度器在 serve 启动期登记，而 agent 工具表是 ensureAgent
    // 懒建的，必然晚于登记——所以这些运行时照常拿到三个工具，各档 +3。
    setActiveScheduler({} as unknown as CronScheduler)
    try {
      for (const n of SCHEDULE_TOOLS) {
        assert.ok(createDefaultToolRegistry([], { preset: 'full' }).has(n), `有调度器要注册 ${n}`)
      }
      assert.equal(totalCount('minimal'), 36)
      assert.equal(totalCount('full'), 57)
    } finally {
      setActiveScheduler(undefined)
    }
  })

  it('kernel(default-registry) minimal 排除 ast_edit/inspect_project/related_tests/import_resource/leave_mark', () => {
    const reg = createDefaultToolRegistry([], { preset: 'minimal' })
    for (const drop of ['ast_edit', 'inspect_project', 'related_tests', 'import_resource', 'leave_mark']) {
      assert.ok(!reg.has(drop), drop)
    }
    for (const keep of ['web_search', 'web_fetch', 'repo_map', 'ast_grep']) {
      assert.ok(reg.has(keep), keep)
    }
  })

  it('env force-on：RIVET_IMPORT_RESOURCE=1 在 minimal 下补入', () => {
    process.env.RIVET_IMPORT_RESOURCE = '1'
    try {
      const reg = createDefaultToolRegistry([], { preset: 'minimal' })
      assert.ok(reg.has('import_resource'))
    } finally {
      delete process.env.RIVET_IMPORT_RESOURCE
    }
  })

  it('capability 注册后可见性：full 档注册，minimal/frontend 不含', () => {
    for (const preset of ['minimal', 'frontend'] as const) {
      assert.ok(!createDefaultToolRegistry([], { preset }).has('capability'), `${preset} 不含 capability`)
    }
    assert.ok(createDefaultToolRegistry([], { preset: 'full' }).has('capability'), 'full 含 capability')
  })

  it('env force-on：RIVET_CAPABILITY=1 在 minimal 下补入 capability', () => {
    process.env.RIVET_CAPABILITY = '1'
    try {
      const reg = createDefaultToolRegistry([], { preset: 'minimal' })
      assert.ok(reg.has('capability'))
    } finally {
      delete process.env.RIVET_CAPABILITY
    }
  })

  it('taiyi 装配：白名单工具保留，无条件工具被排除', () => {
    const reg = createDefaultToolRegistry([], { preset: 'taiyi' })
    for (const keep of ['read_file', 'write_file', 'edit_file', 'hash_edit', 'grep', 'glob', 'bash', 'job', 'git', 'diff', 'run_tests', 'todo', 'plan']) {
      assert.ok(reg.has(keep), `taiyi must keep ${keep}`)
    }
    for (const drop of ['web_fetch', 'web_search', 'ask_image', 'repo_map', 'read_section', 'ast_grep', 'skill', 'git_scout']) {
      assert.ok(!reg.has(drop), `taiyi must drop ${drop}`)
    }
  })
})

// ── 档位口径的机读闸门（2026-10-09） ────────────────────────────────
// 这组用例防的是「注册点加了、口径没跟」——本仓库已经栽过两次：tool-preset.ts
// 文件头注释曾写 17 并误含 request_path_access，totalCount 清单又漏了 galaxy /
// starflow / memory 三件。手抄清单会漂移，所以闸门直接扫 bootstrap.ts 源码。

describe('档位口径闸门', () => {
  it('memory 不进 taiyi 评测档（其余三档保留）', () => {
    assert.equal(
      presetIncludes('taiyi', 'memory'),
      false,
      'taiyi 的 14 名清单里没有 memory；缺门控时它会跟着 bootstrap 的无条件注册混进来',
    )
    for (const preset of ['minimal', 'frontend', 'full'] as const) {
      assert.equal(presetIncludes(preset, 'memory'), true, `${preset} 应保留 memory`)
    }
  })

  it('taiyi 装配集恰为文档的 14 件（多一件少一件都红）', () => {
    assert.deepEqual(
      assembledNames('taiyi'),
      [...TAIYI_TOOLSET].sort(),
      'taiyi 装配集与 tool-preset.ts 文件头列出的 14 名不一致——文档/实现二选一必须改',
    )
  })

  it('BOOTSTRAP_TOOLS 不漂移：bootstrap.ts 的每个 presetIncludes 门控名都在清单里', () => {
    // 源码形态闸门，与 static-subagent 的 assertAnchorsResolve / injection-surfaces
    // 同一路数：解析不出东西就判失效，不放行。
    const src = readFileSync(new URL('../../bootstrap.ts', import.meta.url), 'utf8')
    const gated = new Set(
      [...src.matchAll(/presetIncludes\(toolPreset,\s*'([^']+)'\)/g)].map(m => m[1]!),
    )
    assert.ok(
      gated.size >= 15,
      `只从 bootstrap.ts 扫到 ${gated.size} 个门控点——正则或源码形态变了，闸门已失效`,
    )
    const known = new Set<string>(BOOTSTRAP_TOOLS)
    const missing = [...gated].filter(n => !known.has(n)).sort()
    assert.deepEqual(
      missing,
      [],
      `bootstrap.ts 新增了门控工具但没进 BOOTSTRAP_TOOLS，totalCount 会漏记：${missing.join(', ')}`,
    )
  })
})

describe('resolveToolPreset precedence', () => {
  let dir: string
  let home: string
  let prevHome: string | undefined
  let prevConfigPath: string | undefined
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tool-preset-'))
    // 隔离真实用户配置（本机 ~/.rivet/config.json 有 tools.preset）——默认档
    // 断言必须在空配置环境跑，否则读到的是宿主机配置而非默认（2026-09-23
    // 默认档 frontend→minimal 后此问题显性化）。
    home = mkdtempSync(join(tmpdir(), 'tool-preset-precedence-home-'))
    prevHome = process.env.RIVET_HOME
    prevConfigPath = process.env.RIVET_CONFIG_PATH
    process.env.RIVET_HOME = home
    delete process.env.RIVET_CONFIG_PATH
    __resetToolPresetForTest()
    delete process.env.RIVET_TOOL_PRESET
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    if (prevConfigPath === undefined) delete process.env.RIVET_CONFIG_PATH
    else process.env.RIVET_CONFIG_PATH = prevConfigPath
    delete process.env.RIVET_TOOL_PRESET
    __resetToolPresetForTest()
  })

  it('defaults to minimal with no env and no config', () => {
    // 2026-09-23 起发版默认档 minimal（原 frontend；对齐 3.14 线）
    assert.equal(resolveToolPreset(dir), 'minimal')
  })

  it('project .rivet-config.json tools.preset wins over default', () => {
    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({ tools: { preset: 'full' } }))
    __resetToolPresetForTest()
    assert.equal(resolveToolPreset(dir), 'full')
  })

  it('nested cwd walks up to the project config', () => {
    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({ tools: { preset: 'frontend' } }))
    mkdirSync(join(dir, 'src', 'x'), { recursive: true })
    __resetToolPresetForTest()
    assert.equal(resolveToolPreset(join(dir, 'src', 'x')), 'frontend')
  })

  it('RIVET_TOOL_PRESET env wins over project config', () => {
    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({ tools: { preset: 'full' } }))
    process.env.RIVET_TOOL_PRESET = 'frontend'
    __resetToolPresetForTest()
    assert.equal(resolveToolPreset(dir), 'frontend')
  })

  it('invalid values fall back to minimal', () => {
    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({ tools: { preset: 'huge' } }))
    __resetToolPresetForTest()
    assert.equal(resolveToolPreset(dir), 'minimal')
  })

  it('RIVET_TOOL_PRESET=taiyi 解析为 taiyi 档', () => {
    process.env.RIVET_TOOL_PRESET = 'taiyi'
    __resetToolPresetForTest()
    assert.equal(resolveToolPreset(dir), 'taiyi')
  })

  it('域 toolPreset：defaultDomain 钉定域且配置了域档位时按域装配', () => {
    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({
      runtime: { domains: { taiyi: { toolPreset: 'taiyi' } } },
    }))
    __resetToolPresetForTest()
    assert.equal(resolveToolPreset(dir, 'taiyi'), 'taiyi')
    // 其他域/无域回退全局（无 tools.preset → 默认 minimal）
    assert.equal(resolveToolPreset(dir, 'qiming'), 'minimal')
    assert.equal(resolveToolPreset(dir), 'minimal')
  })

  it('域 toolPreset：changgeng 参考 taiyi 同样生效（动态域集合）', () => {
    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({
      runtime: { domains: { changgeng: { toolPreset: 'taiyi' } } },
    }))
    __resetToolPresetForTest()
    assert.equal(resolveToolPreset(dir, 'changgeng'), 'taiyi')
    assert.equal(resolveToolPreset(dir, 'pojun'), 'minimal', '未配置的域不受影响')
  })

  it('域内置默认：defaultDomain=taiyi 无任何配置落到 taiyi 档', () => {
    __resetToolPresetForTest()
    assert.equal(resolveToolPreset(dir, 'taiyi'), 'taiyi')
    // 无内置档的域不受波及
    assert.equal(resolveToolPreset(dir, 'qiming'), 'minimal')
    assert.equal(resolveToolPreset(dir), 'minimal')
  })

  it('域内置默认：RIVET_TOOL_PRESET env 覆盖 taiyi 域内置档', () => {
    process.env.RIVET_TOOL_PRESET = 'full'
    __resetToolPresetForTest()
    assert.equal(resolveToolPreset(dir, 'taiyi'), 'full')
  })

  it('域内置默认：项目 tools.preset 覆盖 taiyi 域内置档', () => {
    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({ tools: { preset: 'minimal' } }))
    __resetToolPresetForTest()
    assert.equal(resolveToolPreset(dir, 'taiyi'), 'minimal')
  })

  it('域内置默认：runtime.domains.taiyi.toolPreset 配置覆盖 taiyi 域内置档', () => {
    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({
      runtime: { domains: { taiyi: { toolPreset: 'full' } } },
    }))
    __resetToolPresetForTest()
    assert.equal(resolveToolPreset(dir, 'taiyi'), 'full')
  })
})

// 读侧必须与写侧（saveToolPresetConfig → userConfigPath）同源。曾经读的是
// defaultRivetHome()，桌面端便携模式 / 自定义存储路径下设置页改档位静默无效。
describe('resolveToolPreset honors the active data root', () => {
  let dir: string
  let home: string
  let prevHome: string | undefined
  let prevConfigPath: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tool-preset-cwd-'))
    home = mkdtempSync(join(tmpdir(), 'tool-preset-home-'))
    prevHome = process.env.RIVET_HOME
    prevConfigPath = process.env.RIVET_CONFIG_PATH
    delete process.env.RIVET_TOOL_PRESET
    delete process.env.RIVET_CONFIG_PATH
    __resetToolPresetForTest()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    if (prevConfigPath === undefined) delete process.env.RIVET_CONFIG_PATH
    else process.env.RIVET_CONFIG_PATH = prevConfigPath
    delete process.env.RIVET_TOOL_PRESET
    __resetToolPresetForTest()
  })

  it('RIVET_HOME 下的 config.json tools.preset 生效', () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ tools: { preset: 'frontend' } }))
    process.env.RIVET_HOME = home
    __resetToolPresetForTest()
    assert.equal(resolveToolPreset(dir), 'frontend')
  })

  it('RIVET_CONFIG_PATH 直指某个文件时也生效', () => {
    const explicit = join(home, 'elsewhere.json')
    writeFileSync(explicit, JSON.stringify({ tools: { preset: 'full' } }))
    process.env.RIVET_CONFIG_PATH = explicit
    __resetToolPresetForTest()
    assert.equal(resolveToolPreset(dir), 'full')
  })

  it('项目配置仍然压过用户配置', () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ tools: { preset: 'full' } }))
    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({ tools: { preset: 'frontend' } }))
    process.env.RIVET_HOME = home
    __resetToolPresetForTest()
    assert.equal(resolveToolPreset(dir), 'frontend')
  })

  it('数据根下没有 config.json 时回落 minimal（默认档）', () => {
    process.env.RIVET_HOME = home
    __resetToolPresetForTest()
    assert.equal(resolveToolPreset(dir), 'minimal')
  })
})

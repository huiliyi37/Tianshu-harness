import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { presetIncludes, resolveToolPreset, __resetToolPresetForTest, type ToolPreset } from '../tool-preset.js'
import { createDefaultToolRegistry } from '../default-registry.js'
import { setActiveScheduler, type CronScheduler } from '../../server/cron-scheduler.js'

const SCHEDULE_TOOLS = ['schedule_create', 'schedule_list', 'schedule_delete'] as const

const BOOTSTRAP_TOOLS = [
  'delegate_task', 'undo', 'delegate_batch', 'team_orchestrate', 'council_convene',
  'recall_capsule', 'recall_general', 'record_general_finding', 'ask_user_question',
  'browser_debug', 'repo_graph', 'related_tests', 'semantic_search', 'apply_patch',
  'session_vitals', 'attack_case', 'plan_task', 'deliver_task', 'update_goal',
] as const

function bootstrapCount(preset: ToolPreset): number {
  // related_tests 与 kernel 重名（覆盖注册），不计入新增
  return BOOTSTRAP_TOOLS.filter(n => n !== 'related_tests' && presetIncludes(preset, n)).length
}

function totalCount(preset: ToolPreset): number {
  return createDefaultToolRegistry([], { preset }).getAll().length + bootstrapCount(preset)
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

  it('taiyi 专属排除：bootstrap 侧编排/辅助工具全 false（16 工具闭环修复 2026-08-07）', () => {
    // 此前 bootstrap 无条件注册这批工具，taiyi 实装远多于文档 16——
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
    // 16 核心集里的交付/计划闭环不受专属排除误伤
    for (const keep of ['deliver_task', 'plan_submit', 'plan_close', 'memory', 'todo', 'job']) {
      assert.ok(presetIncludes('taiyi', keep), `taiyi keeps ${keep}`)
    }
  })
})

describe('assembly counts per preset', () => {
  // 口径 = 无调度器的 CLI 交互模式。schedule 三工具按 isSchedulerAvailable()
  // 条件注册，有调度器的 serve/桌面端各档 +3（见下一条用例）。
  it('minimal=29 / frontend=30 / full=49（完整装配口径）', () => {
    assert.equal(totalCount('minimal'), 29)
    assert.equal(totalCount('frontend'), 30)
    // 118d0505：monitor 工具（full 档专属）入注册表，full 44 → 45
    // B3：web_crawl/web_map（full 档专属）入注册表，full 45 → 47
    // 视觉副驾：ask_image 无条件注册（各档 +1），28/29/47 → 29/30/48
    // capability 能力索引（full 档专属，查询面低频，同 repo_graph/semantic_search），48 → 49
    // cli_discover CLI 能力发现与安装（full 档专属，安装审批硬闸门），49 → 50
    assert.equal(totalCount('full'), 50)
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
      assert.equal(totalCount('minimal'), 32)
      // cli_discover full 档 +1：49→50（无调度器）/ 52→53（有调度器）
      assert.equal(totalCount('full'), 53)
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
    for (const drop of ['web_fetch', 'web_search', 'ask_image', 'repo_map', 'read_section', 'ast_grep', 'skill']) {
      assert.ok(!reg.has(drop), `taiyi must drop ${drop}`)
    }
  })
})

describe('resolveToolPreset precedence', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tool-preset-'))
    __resetToolPresetForTest()
    delete process.env.RIVET_TOOL_PRESET
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.RIVET_TOOL_PRESET
    __resetToolPresetForTest()
  })

  it('defaults to frontend with no env and no config', () => {
    assert.equal(resolveToolPreset(dir), 'frontend')
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

  it('invalid values fall back to frontend', () => {
    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({ tools: { preset: 'huge' } }))
    __resetToolPresetForTest()
    assert.equal(resolveToolPreset(dir), 'frontend')
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
    // 其他域/无域回退全局（无 tools.preset → frontend）
    assert.equal(resolveToolPreset(dir, 'qiming'), 'frontend')
    assert.equal(resolveToolPreset(dir), 'frontend')
  })

  it('域 toolPreset：changgeng 参考 taiyi 同样生效（动态域集合）', () => {
    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({
      runtime: { domains: { changgeng: { toolPreset: 'taiyi' } } },
    }))
    __resetToolPresetForTest()
    assert.equal(resolveToolPreset(dir, 'changgeng'), 'taiyi')
    assert.equal(resolveToolPreset(dir, 'pojun'), 'frontend', '未配置的域不受影响')
  })

  it('域内置默认：defaultDomain=taiyi 无任何配置落到 taiyi 档', () => {
    // 隔离真实用户配置（本机 ~/.rivet/config.json 有 tools.preset，会先于域内置生效）
    const home = mkdtempSync(join(tmpdir(), 'tool-preset-home-'))
    const prevHome = process.env.RIVET_HOME
    process.env.RIVET_HOME = home
    try {
      __resetToolPresetForTest()
      assert.equal(resolveToolPreset(dir, 'taiyi'), 'taiyi')
      // 无内置档的域不受波及
      assert.equal(resolveToolPreset(dir, 'qiming'), 'frontend')
      assert.equal(resolveToolPreset(dir), 'frontend')
    } finally {
      if (prevHome === undefined) delete process.env.RIVET_HOME
      else process.env.RIVET_HOME = prevHome
      rmSync(home, { recursive: true, force: true })
      __resetToolPresetForTest()
    }
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

  it('数据根下没有 config.json 时回落 frontend', () => {
    process.env.RIVET_HOME = home
    __resetToolPresetForTest()
    assert.equal(resolveToolPreset(dir), 'frontend')
  })
})

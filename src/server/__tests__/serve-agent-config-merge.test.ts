import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mergeProjectAgentConfig, resolveSessionBaseConfig } from '../serve-agent.js'
import type { Config } from '../../config/schema.js'

function startupConfig(overrides?: Partial<Config['agent']>): Config {
  return {
    provider: { default: 'deepseek', providers: {} },
    agent: {
      songlineEnabled: true,
      crossSessionEnabled: true,
      desktopTools: false,
      toolGating: {
        enabled: true,
        extraCore: [],
      },
      hearthObserveEnabled: false,
      verificationSnapshot: 'auto',
      ...overrides,
    },
  } as Config
}

describe('mergeProjectAgentConfig', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'config-merge-'))
    // 信任门（project-trust.ts）：未授信项目的 agent 块不并入。本套件按
    // 「已授信」语义测试合并行为——env 覆盖，不写真实信任库。
    process.env.RIVET_TRUST_PROJECT = '1'
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.RIVET_TRUST_PROJECT
  })

  it('no project config → returns startup config unmodified', () => {
    const startup = startupConfig()
    const merged = mergeProjectAgentConfig(startup, dir)
    assert.deepEqual(merged, startup)
  })

  it('project extraCore merged without clobbering enabled', () => {
    writeFileSync(
      join(dir, '.rivet-config.json'),
      JSON.stringify({ agent: { toolGating: { extraCore: ['team_orchestrate'] } } }),
    )
    const startup = startupConfig()
    const merged = mergeProjectAgentConfig(startup, dir)

    // Deep-merge: extraCore from project, enabled from startup preserved
    assert.equal(merged.agent.toolGating?.enabled, true)
    assert.deepEqual(merged.agent.toolGating?.extraCore, ['team_orchestrate'])
  })

  it('project disabledTools merged without clobbering extraCore', () => {
    writeFileSync(
      join(dir, '.rivet-config.json'),
      JSON.stringify({ agent: { toolGating: { disabledTools: ['browser'] } } }),
    )
    const startup = startupConfig({
      toolGating: {
        enabled: true,
        extraCore: ['team_orchestrate'],
      },
    })
    const merged = mergeProjectAgentConfig(startup, dir)

    assert.equal(merged.agent.toolGating?.enabled, true)
    assert.deepEqual(merged.agent.toolGating?.extraCore, ['team_orchestrate'])
    assert.deepEqual(merged.agent.toolGating?.disabledTools, ['browser'])
  })

  it('non-agent fields (provider, tools) are NOT overwritten by project config', () => {
    writeFileSync(
      join(dir, '.rivet-config.json'),
      JSON.stringify({
        agent: { toolGating: { extraCore: ['team_orchestrate'] } },
        tools: { preset: 'full' },
      }),
    )
    const startup = startupConfig()
    // Simulate tools preset being something else
    ;(startup as any).tools = { preset: 'minimal' }

    const merged = mergeProjectAgentConfig(startup, dir)

    // Agent merged
    assert.deepEqual(merged.agent.toolGating?.extraCore, ['team_orchestrate'])
    // Tools NOT overwritten — only agent block is merged
    assert.equal((merged as any).tools?.preset, 'minimal')
  })

  it('malformed project config → returns startup unmodified (graceful degradation)', () => {
    writeFileSync(join(dir, '.rivet-config.json'), 'not json')
    const startup = startupConfig()
    const merged = mergeProjectAgentConfig(startup, dir)
    assert.deepEqual(merged, startup)
  })

  it('agent fields outside toolGating are shallow-merged from project', () => {
    writeFileSync(
      join(dir, '.rivet-config.json'),
      JSON.stringify({ agent: { desktopTools: true } }),
    )
    const startup = startupConfig()
    const merged = mergeProjectAgentConfig(startup, dir)

    assert.equal(merged.agent.desktopTools, true)
    // Other fields preserved
    assert.equal(merged.agent.crossSessionEnabled, true)
  })
})

describe('resolveSessionBaseConfig — 视觉桥 P0：运行中改配置对新会话生效', () => {
  it('有 reload（生产 sidecar）时用磁盘新值——运行中配的识图桥不再落空', () => {
    const base = startupConfig()
    const ctx = { config: base } as unknown as import('../serve.js').ServeContext
    const fresh = startupConfig()
    fresh.agent.visionModel = { provider: 'zhipu-vision', model: 'glm-4v-flash', maxTokens: 1024 }
    const reload = () => ({ config: fresh }) as unknown as import('../serve.js').ServeContext
    const resolved = resolveSessionBaseConfig(ctx, reload)
    assert.equal(resolved, fresh, '必须取 reload 的新值而非启动快照')
    assert.equal(resolved.agent.visionModel?.model, 'glm-4v-flash')
  })

  it('无 reload（注入 ctx 的测试/CLI 路径）回落启动快照——确定性不变', () => {
    const base = startupConfig()
    const ctx = { config: base } as unknown as import('../serve.js').ServeContext
    assert.equal(resolveSessionBaseConfig(ctx), base)
    assert.equal(resolveSessionBaseConfig(ctx).agent.visionModel, undefined)
  })
})

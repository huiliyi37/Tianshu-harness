import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ToolRegistry } from '../../tools/registry.js'
import { initializePlugins } from '../plugin-loader.js'
import { PLUGIN_PERMISSIONS_NOTICE } from '../manifest.js'
import { buildPluginRoutes } from '../../server/plugin-api.js'
import { skillRegistry } from '../../skills/skill-loader.js'
import type { Tool } from '../../tools/types.js'

function dummyTool(name: string): Tool {
  return {
    definition: {
      name,
      description: `Dummy tool ${name}`,
      input_schema: { type: 'object', properties: {} },
    },
    execute: async () => ({ content: 'ok' }),
    requiresApproval: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  }
}

/** Create a fresh isolated plugins dir for a single test. */
function freshEnv(): { pluginsDir: string; pluginsSubdir: string } {
  const pluginsDir = join(process.cwd(), '.rivet', `plugin-test-${randomUUID()}`)
  const pluginsSubdir = join(pluginsDir, 'plugins')
  mkdirSync(pluginsSubdir, { recursive: true })
  return { pluginsDir, pluginsSubdir }
}

/** Set up a fake plugin directory structure. */
function setupPlugin(baseDir: string, dirName: string, opts: {
  pkgJson?: Record<string, unknown>
  entryContent?: string
} = {}): string {
  const pluginDir = join(baseDir, dirName)
  mkdirSync(pluginDir, { recursive: true })

  const pkgJson = opts.pkgJson ?? {
    name: dirName,
    version: '1.0.0',
    tianshu: {
      name: dirName,
      version: '1.0.0',
      description: 'Test plugin',
      entry: 'index.js',
      tools: [{ name: `${dirName}_tool`, description: 'A test tool' }],
      permissions: { fs: true },
    },
  }
  writeFileSync(join(pluginDir, 'package.json'), JSON.stringify(pkgJson))

  if (opts.entryContent !== undefined) {
    writeFileSync(join(pluginDir, 'index.js'), opts.entryContent)
  }

  return pluginDir
}

describe('initializePlugins', () => {
  const origHome = process.env.RIVET_HOME
  const activeDirs: string[] = []

  after(() => {
    process.env.RIVET_HOME = origHome ?? ''
    if (origHome === undefined) delete process.env.RIVET_HOME
    for (const dir of activeDirs) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    }
  })

  function setHome(dir: string) {
    activeDirs.push(dir)
    process.env.RIVET_HOME = dir
  }

  it('returns empty result when plugins dir is empty', async () => {
    const { pluginsDir } = freshEnv()
    setHome(pluginsDir)

    const registry = new ToolRegistry()
    const result = await initializePlugins(undefined, registry, process.cwd())
    assert.equal(result.scanned, 0)
    assert.equal(result.loaded, 0)
    assert.equal(result.totalTools, 0)
    assert.deepEqual(result.suppressTools, [])
  })

  it('loads a valid plugin and registers its tools', async () => {
    const { pluginsDir, pluginsSubdir } = freshEnv()
    setHome(pluginsDir)

    setupPlugin(pluginsSubdir, 'hello-plugin', {
      entryContent: `
export const tools = [{
  definition: { name: 'hello_tool', description: 'Hello', input_schema: { type: 'object', properties: {} } },
  execute: async () => ({ content: 'hello' }),
  requiresApproval: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}];
`
    })

    const registry = new ToolRegistry()
    const result = await initializePlugins(undefined, registry, process.cwd())
    assert.equal(result.scanned, 1)
    assert.equal(result.loaded, 1)
    assert.equal(result.totalTools, 1)
    assert.ok(registry.has('hello_tool'))
  })

  it('skips plugin with invalid manifest', async () => {
    const { pluginsDir, pluginsSubdir } = freshEnv()
    setHome(pluginsDir)

    setupPlugin(pluginsSubdir, 'bad-plugin', {
      pkgJson: {
        name: 'bad-plugin',
        version: '1.0.0',
        tianshu: { name: 'bad-plugin' }, // missing required fields
      },
    })

    const registry = new ToolRegistry()
    const result = await initializePlugins(undefined, registry, process.cwd())
    const bad = result.results.find(r => r.pluginName === 'bad-plugin')
    assert.ok(bad)
    assert.equal(bad!.status, 'skipped_invalid_manifest')
    assert.equal(result.loaded, 0)
  })

  it('skips plugin with no tianshu field', async () => {
    const { pluginsDir, pluginsSubdir } = freshEnv()
    setHome(pluginsDir)

    setupPlugin(pluginsSubdir, 'no-tianshu', {
      pkgJson: { name: 'no-tianshu', version: '1.0.0' },
    })

    const registry = new ToolRegistry()
    const result = await initializePlugins(undefined, registry, process.cwd())
    const item = result.results.find(r => r.pluginName === 'no-tianshu')
    assert.ok(item)
    assert.equal(item!.status, 'skipped_no_manifest')
    assert.equal(result.loaded, 0)
  })

  it('skips disabled plugin', async () => {
    const { pluginsDir, pluginsSubdir } = freshEnv()
    setHome(pluginsDir)

    setupPlugin(pluginsSubdir, 'disabled-plugin', {
      entryContent: `
export const tools = [{
  definition: { name: 'disabled_tool', description: 'x', input_schema: { type: 'object', properties: {} } },
  execute: async () => ({ content: 'x' }),
  requiresApproval: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}];
`
    })

    const registry = new ToolRegistry()
    const result = await initializePlugins(
      { enabled: { 'disabled-plugin': false } },
      registry,
      process.cwd(),
    )
    const item = result.results.find(r => r.pluginName === 'disabled-plugin')
    assert.ok(item)
    assert.equal(item!.status, 'skipped_disabled')
    assert.equal(result.loaded, 0)
  })

  it('rejects plugin with conflicting tool names', async () => {
    const { pluginsDir, pluginsSubdir } = freshEnv()
    setHome(pluginsDir)

    setupPlugin(pluginsSubdir, 'conflict-plugin', {
      entryContent: `
export const tools = [{
  definition: { name: 'read_file', description: 'Conflicting read', input_schema: { type: 'object', properties: {} } },
  execute: async () => ({ content: 'x' }),
  requiresApproval: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}];
`
    })

    const registry = new ToolRegistry()
    registry.register(dummyTool('read_file')) // pre-existing built-in

    const result = await initializePlugins(undefined, registry, process.cwd())
    const item = result.results.find(r => r.pluginName === 'conflict-plugin')
    assert.ok(item)
    assert.equal(item!.status, 'skipped_conflict')
    assert.ok(item!.error?.includes('read_file'))
  })

  it('returns suppressTools based on loaded plugins', async () => {
    const { pluginsDir, pluginsSubdir } = freshEnv()
    setHome(pluginsDir)

    setupPlugin(pluginsSubdir, 'office-pdf', {
      entryContent: `
export const tools = [{
  definition: { name: 'pdf_create', description: 'Create PDF', input_schema: { type: 'object', properties: {} } },
  execute: async () => ({ content: 'pdf' }),
  requiresApproval: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}];
`
    })

    const registry = new ToolRegistry()
    registry.register(dummyTool('create_pdf')) // built-in HTML tool

    const result = await initializePlugins(undefined, registry, process.cwd())
    assert.ok(result.suppressTools.includes('create_pdf'))
    assert.equal(result.loaded, 1)
  })

  it('isolation: skips plugin with import error, does not block startup', async () => {
    const { pluginsDir, pluginsSubdir } = freshEnv()
    setHome(pluginsDir)

    setupPlugin(pluginsSubdir, 'crash-plugin', {
      entryContent: `throw new Error('Boom!')`,
    })

    const registry = new ToolRegistry()
    const result = await initializePlugins(undefined, registry, process.cwd())
    const item = result.results.find(r => r.pluginName === 'crash-plugin')
    assert.ok(item)
    assert.equal(item!.status, 'skipped_import_error')
  })

  it('rejects plugin with entry path escaping plugin dir', async () => {
    const { pluginsDir, pluginsSubdir } = freshEnv()
    setHome(pluginsDir)

    setupPlugin(pluginsSubdir, 'escape-plugin', {
      pkgJson: {
        name: 'escape-plugin',
        version: '1.0.0',
        tianshu: {
          name: 'escape-plugin',
          version: '1.0.0',
          description: 'Evil plugin',
          entry: '../../etc/passwd',
          tools: [{ name: 'evil_tool', description: 'x' }],
          permissions: {},
        },
      },
    })

    const registry = new ToolRegistry()
    const result = await initializePlugins(undefined, registry, process.cwd())
    const item = result.results.find(r => r.pluginName === 'escape-plugin')
    assert.ok(item)
    assert.equal(item!.status, 'skipped_import_error')
    assert.ok(item!.error?.includes('escapes'))
  })

  // ── ABI adapter + path safety ──────────────────────────────────────
  // These tests call plugin tools the way the REAL pipeline does:
  // tool.execute({ input: {...}, toolUseId, cwd }) — args nested in input.
  // The previous suite passed flat args, mirroring the plugin-side (wrong)
  // convention instead of the pipeline contract, so it stayed green while
  // every plugin tool received undefined arguments in production.

  function pipelineCall(input: Record<string, unknown>, cwd = process.cwd()) {
    return { input, toolUseId: 'test-call', cwd } as any
  }

  it('ABI adapter: plugin receives flat args extracted from params.input', async () => {
    const { pluginsDir, pluginsSubdir } = freshEnv()
    setHome(pluginsDir)

    setupPlugin(pluginsSubdir, 'flat-plugin', {
      entryContent: `
export const tools = [{
  definition: {
    name: 'flat_tool',
    description: 'Echo a name',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' } },
    },
  },
  execute: async (params) => ({ content: 'hello ' + params.name }),
  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}];
`
    })

    const registry = new ToolRegistry()
    await initializePlugins(undefined, registry, process.cwd())
    const tool = registry.get('flat_tool')!

    const result = await tool.execute(pipelineCall({ name: 'tianshu' }))
    assert.ok(!result.isError)
    assert.equal(result.content, 'hello tianshu', 'plugin must see args flat even though the pipeline nests them in input')
  })

  it('path safety: blocks sensitive file reads via plugin tool', async () => {
    const { pluginsDir, pluginsSubdir } = freshEnv()
    setHome(pluginsDir)

    setupPlugin(pluginsSubdir, 'reader-plugin', {
      entryContent: `
export const tools = [{
  definition: {
    name: 'reader_tool',
    description: 'Read a file',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to read' },
      },
      required: ['file_path'],
    },
  },
  execute: async (params) => ({ content: 'read ' + params.file_path }),
  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}];
`
    })

    const registry = new ToolRegistry()
    await initializePlugins(undefined, registry, process.cwd())
    assert.ok(registry.has('reader_tool'))

    const tool = registry.get('reader_tool')!
    // Should block .env read
    const result = await tool.execute(pipelineCall({ file_path: '.env' }))
    assert.ok(result.isError)
    assert.ok(result.content.includes('Sensitive file blocked') || result.content.includes('sensitive'))
  })

  it('path safety: blocks path escape via plugin tool', async () => {
    const { pluginsDir, pluginsSubdir } = freshEnv()
    setHome(pluginsDir)

    setupPlugin(pluginsSubdir, 'writer-plugin', {
      entryContent: `
export const tools = [{
  definition: {
    name: 'writer_tool',
    description: 'Write a file',
    input_schema: {
      type: 'object',
      properties: {
        destination_path: { type: 'string', description: 'Output path' },
      },
      required: ['destination_path'],
    },
  },
  execute: async (params) => ({ content: 'wrote ' + params.destination_path }),
  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}];
`
    })

    const registry = new ToolRegistry()
    await initializePlugins(undefined, registry, process.cwd())
    assert.ok(registry.has('writer_tool'))

    const tool = registry.get('writer_tool')!
    // Should block escape to /etc/passwd
    const result = await tool.execute(pipelineCall({ destination_path: '/etc/passwd' }))
    assert.ok(result.isError)
    assert.ok(result.content.includes('outside') || result.content.includes('escapes') || result.content.includes('not allowed'))
  })

  it('path safety: validated paths are substituted with canonicalized absolute paths', async () => {
    const { pluginsDir, pluginsSubdir } = freshEnv()
    setHome(pluginsDir)

    setupPlugin(pluginsSubdir, 'safe-plugin', {
      entryContent: `
export const tools = [{
  definition: {
    name: 'safe_tool',
    description: 'Process a file safely',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Input file' },
        destination_path: { type: 'string', description: 'Output file' },
      },
    },
  },
  execute: async (params) => ({ content: 'processed ' + (params.file_path || '') }),
  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}];
`
    })

    const registry = new ToolRegistry()
    await initializePlugins(undefined, registry, process.cwd())
    const tool = registry.get('safe_tool')!

    // In-workspace relative paths pass AND arrive at the plugin as absolute
    // session-cwd-anchored paths — plugins resolving relative paths against
    // process.cwd() was a cross-session hazard in server mode.
    const result = await tool.execute(pipelineCall({ file_path: 'package.json', destination_path: 'output.txt' }))
    assert.ok(!result.isError)
    assert.equal(result.content, `processed ${join(process.cwd(), 'package.json')}`)
  })

  it('path safety: per-call cwd wins over load-time cwd', async () => {
    const { pluginsDir, pluginsSubdir } = freshEnv()
    setHome(pluginsDir)

    setupPlugin(pluginsSubdir, 'cwd-plugin', {
      entryContent: `
export const tools = [{
  definition: {
    name: 'cwd_tool',
    description: 'Echo resolved path',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' } },
    },
  },
  execute: async (params) => ({ content: params.file_path }),
  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}];
`
    })

    // Load with a DIFFERENT cwd than the per-call one.
    const registry = new ToolRegistry()
    await initializePlugins(undefined, registry, join(process.cwd(), 'src'))
    const tool = registry.get('cwd_tool')!

    const result = await tool.execute(pipelineCall({ file_path: 'package.json' }, process.cwd()))
    assert.ok(!result.isError)
    assert.equal(result.content, join(process.cwd(), 'package.json'), 'relative path must resolve against the per-call session cwd')
  })

  it('loads bundled skills from manifest skills field', async () => {
    const { pluginsDir, pluginsSubdir } = freshEnv()
    setHome(pluginsDir)
    const skillName = `probe-skill-${randomUUID().slice(0, 8)}`

    const pluginDir = setupPlugin(pluginsSubdir, 'skill-plugin', {
      pkgJson: {
        name: 'skill-plugin',
        version: '1.0.0',
        tianshu: {
          name: 'skill-plugin',
          version: '1.0.0',
          description: 'Plugin with bundled skill',
          entry: 'index.js',
          tools: [{ name: 'skill_plugin_tool', description: 'Probe' }],
          permissions: {},
          skills: ['skills/bundled-skill'],
        },
      },
      entryContent: `
export const tools = [{
  definition: { name: 'skill_plugin_tool', description: 'x', input_schema: { type: 'object', properties: {} } },
  execute: async () => ({ content: 'ok' }),
  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}];
`,
    })
    const skillDir = join(pluginDir, 'skills', 'bundled-skill')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), `---
name: ${skillName}
description: Bundled plugin skill for testing
triggers: [plugin-skill-probe]
---

Follow the bundled workflow.`)

    const registry = new ToolRegistry()
    const result = await initializePlugins(undefined, registry, process.cwd())
    const item = result.results.find(r => r.pluginName === 'skill-plugin')
    assert.ok(item)
    assert.equal(item!.status, 'loaded')
    assert.equal(item!.skillCount, 1)
    assert.ok(skillRegistry.get(skillName), 'bundled skill must register in skillRegistry')
    assert.equal(skillRegistry.get(skillName)!.source, 'plugin')
  })

  it('skips conflicting bundled skill without rejecting plugin', async () => {
    const { pluginsDir, pluginsSubdir } = freshEnv()
    setHome(pluginsDir)
    const conflictName = `conflict-skill-${randomUUID().slice(0, 8)}`

    skillRegistry.register({
      name: conflictName,
      description: 'Pre-existing skill',
      triggers: [],
      body: 'existing',
      source: 'rivet',
    })

    const pluginDir = setupPlugin(pluginsSubdir, 'skill-conflict-plugin', {
      pkgJson: {
        name: 'skill-conflict-plugin',
        version: '1.0.0',
        tianshu: {
          name: 'skill-conflict-plugin',
          version: '1.0.0',
          description: 'Skill conflict probe',
          entry: 'index.js',
          tools: [{ name: 'skill_conflict_tool', description: 'Probe' }],
          permissions: {},
          skills: ['skills/my-skill'],
        },
      },
      entryContent: `
export const tools = [{
  definition: { name: 'skill_conflict_tool', description: 'x', input_schema: { type: 'object', properties: {} } },
  execute: async () => ({ content: 'ok' }),
  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}];
`,
    })
    mkdirSync(join(pluginDir, 'skills', 'my-skill'), { recursive: true })
    writeFileSync(join(pluginDir, 'skills', 'my-skill', 'SKILL.md'), `---
name: ${conflictName}
description: Would conflict
---

Body.`)

    const registry = new ToolRegistry()
    const result = await initializePlugins(undefined, registry, process.cwd())
    const item = result.results.find(r => r.pluginName === 'skill-conflict-plugin')
    assert.ok(item)
    assert.equal(item!.status, 'loaded')
    assert.equal(item!.skillCount, 0)
    assert.ok(result.warnings.some(w => w.includes('conflicts with existing skill')))
    assert.ok(registry.has('skill_conflict_tool'))
  })

  it('warns when bundled skill path escapes plugin directory', async () => {
    const { pluginsDir, pluginsSubdir } = freshEnv()
    setHome(pluginsDir)

    setupPlugin(pluginsSubdir, 'skill-escape-plugin', {
      pkgJson: {
        name: 'skill-escape-plugin',
        version: '1.0.0',
        tianshu: {
          name: 'skill-escape-plugin',
          version: '1.0.0',
          description: 'Skill escape probe',
          entry: 'index.js',
          tools: [{ name: 'skill_escape_tool', description: 'Probe' }],
          permissions: {},
          skills: ['../outside-skill'],
        },
      },
      entryContent: `
export const tools = [{
  definition: { name: 'skill_escape_tool', description: 'x', input_schema: { type: 'object', properties: {} } },
  execute: async () => ({ content: 'ok' }),
  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}];
`,
    })

    const registry = new ToolRegistry()
    const result = await initializePlugins(undefined, registry, process.cwd())
    assert.ok(result.warnings.some(w => w.includes('escapes plugin directory')))
  })

  // ── Permissions are advisory, not enforced (issue #216) ──────────

  it('loads a plugin that declares zero permissions — declaration is not enforced', async () => {
    const { pluginsDir, pluginsSubdir } = freshEnv()
    setHome(pluginsDir)

    // A plugin declaring NO capabilities (fs/net/shell all false) is still
    // loaded and its tool registered in full — mechanical proof that the
    // declaration never gates the load path.
    setupPlugin(pluginsSubdir, 'noperm-plugin', {
      pkgJson: {
        name: 'noperm-plugin',
        version: '1.0.0',
        tianshu: {
          name: 'noperm-plugin',
          version: '1.0.0',
          description: 'Declares no capabilities',
          entry: 'index.js',
          tools: [{ name: 'noperm_tool', description: 'x' }],
          permissions: { fs: false, net: false, shell: false },
        },
      },
      entryContent: `
export const tools = [{
  definition: { name: 'noperm_tool', description: 'x', input_schema: { type: 'object', properties: {} } },
  execute: async () => ({ content: 'ok' }),
  requiresApproval: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}];
`,
    })

    const registry = new ToolRegistry()
    const result = await initializePlugins(undefined, registry, process.cwd())
    const item = result.results.find(r => r.pluginName === 'noperm-plugin')
    assert.ok(item)
    assert.equal(item!.status, 'loaded')
    assert.ok(registry.has('noperm_tool'), 'a zero-permission plugin still gets its tool registered')
  })

  it('exposes an advisory notice stating permissions are NOT enforced', () => {
    // Pins the exact user-facing wording that accompanies the declaration.
    assert.match(PLUGIN_PERMISSIONS_NOTICE, /not enforced/i)
    assert.match(PLUGIN_PERMISSIONS_NOTICE, /full Node/i)
  })

  it('install preflight response marks declared permissions as not enforced', async () => {
    const { pluginsDir, pluginsSubdir } = freshEnv()
    setHome(pluginsDir)
    const pluginDir = setupPlugin(pluginsSubdir, 'preflight-plugin', {
      pkgJson: {
        name: 'preflight-plugin',
        version: '1.0.0',
        tianshu: {
          name: 'preflight-plugin',
          version: '1.0.0',
          description: 'Needs review',
          entry: 'index.js',
          tools: [{ name: 'preflight_tool', description: 'x' }],
          permissions: { fs: true },
        },
      },
    })

    const routes = buildPluginRoutes('test-token')
    const res = await routes['POST /plugins/install']!(
      { path: pluginDir },
      undefined,
      { authorization: 'Bearer test-token' },
      undefined,
    )
    assert.equal(res.status, 400)
    const body = res.body as { ok: boolean; permissionsEnforced?: boolean; permissionsNotice?: string }
    assert.equal(body.ok, false)
    assert.equal(body.permissionsEnforced, false, 'install review must state that permissions are not enforced')
    assert.ok(body.permissionsNotice && /not enforced/i.test(body.permissionsNotice))
  })
})

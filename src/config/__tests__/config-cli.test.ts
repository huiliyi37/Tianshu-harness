import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, runConfigCLI, type ConfigCliIO } from '../manager.js'
import { resolveTransportType } from '../../mcp/transport-factory.js'

function makeIo() {
  const stdout: string[] = []
  const stderr: string[] = []
  const exits: number[] = []
  const io: ConfigCliIO = {
    isTTY: false,
    stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line),
    exit: (code: number) => exits.push(code),
  }
  return { stdout, stderr, exits, io }
}

describe('runConfigCLI provider commands', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-config-cli-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('prints help instead of prompting when config has no args in non-TTY', async () => {
    const { stdout, exits, io } = makeIo()
    await runConfigCLI([], io)
    assert.equal(exits.length, 0)
    assert.match(stdout.join('\n'), /Usage: rivet config <command>/)
    assert.match(stdout.join('\n'), /setup <provider>/)
  })

  it('prints help and /connect guidance when config has no args in TTY', async () => {
    const { stdout, exits, io } = makeIo()
    await runConfigCLI([], { ...io, isTTY: true })
    assert.equal(exits.length, 0)
    assert.match(stdout.join('\n'), /Usage: rivet config <command>/)
    assert.match(stdout.join('\n'), /\/connect/)
  })

  it('setup updates provider url, env key, model, and default', async () => {
    const { io } = makeIo()
    await runConfigCLI(['setup', 'minimax', '--key-env', 'MY_MINIMAX_KEY', '--url', 'https://proxy.example.com/v1', '--model', 'MiniMax-M2.8', '--alias', 'm28', '--context-window', '300000', '--max-tokens', '64000', '--default'], io)
    const config = loadConfig()
    const provider = config.provider.providers.minimax!
    assert.equal(config.provider.default, 'minimax')
    assert.equal(provider.apiKeyEnv, 'MY_MINIMAX_KEY')
    assert.equal(provider.baseUrl, 'https://proxy.example.com/v1')
    assert.equal(provider.models[0]?.id, 'MiniMax-M2.8')
    assert.equal(provider.models[0]?.alias, 'm28')
  })

  it('set-url and set-model update existing provider', async () => {
    const { io } = makeIo()
    await runConfigCLI(['set-url', 'deepseek', 'https://deepseek-proxy.example.com/v1'], io)
    await runConfigCLI(['set-model', 'deepseek', 'deepseek-custom', '500000', '32000', 'custom'], io)
    const provider = loadConfig().provider.providers.deepseek!
    assert.equal(provider.baseUrl, 'https://deepseek-proxy.example.com/v1')
    assert.equal(provider.models[0]?.id, 'deepseek-custom')
    assert.equal(provider.models[0]?.alias, 'custom')
  })

  it('set-approval updates global approval mode', async () => {
    const { stdout, io } = makeIo()
    await runConfigCLI(['set-approval', 'dangerously-skip-permissions'], io)

    assert.equal(loadConfig().agent.approval, 'dangerously-skip-permissions')
    assert.match(stdout.join('\n'), /Approval mode set to dangerously-skip-permissions/)
  })

  it('rejects invalid approval modes', async () => {
    const { stderr, exits, io } = makeIo()
    await runConfigCLI(['set-approval', 'unsafe'], io)

    assert.deepEqual(exits, [1])
    assert.match(stderr.join('\n'), /Invalid approval mode/)
  })

  it('set-approval --unsandboxed enables full-permission mode (yolo + no write sandbox)', async () => {
    const { stdout, io } = makeIo()
    await runConfigCLI(['set-approval', 'dangerously-skip-permissions', '--unsandboxed'], io)

    const cfg = loadConfig()
    assert.equal(cfg.agent.approval, 'dangerously-skip-permissions')
    assert.equal(cfg.agent.unsandboxed, true)
    assert.match(stdout.join('\n'), /unsandboxed/)
  })

  it('set-approval --sandboxed clears unsandboxed (yolo 语义下沙箱仍需 RIVET_SANDBOX=1 显式开)', async () => {
    const { stdout, io } = makeIo()
    await runConfigCLI(['set-approval', 'dangerously-skip-permissions', '--unsandboxed'], io)
    assert.equal(loadConfig().agent.unsandboxed, true)
    await runConfigCLI(['set-approval', 'dangerously-skip-permissions', '--sandboxed'], io)
    // --sandboxed = 关闭 unsandboxed 标记（此前死巷：无法把 unsandboxed 设回 false）
    assert.equal(loadConfig().agent.unsandboxed, false)
    assert.match(stdout.join('\n'), /RIVET_SANDBOX=1/)
  })

  it('rejects invalid numeric model parameters', async () => {
    const { stderr, exits, io } = makeIo()
    await runConfigCLI(['set-model', 'deepseek', 'bad-model', 'not-a-number', '32000'], io)
    assert.deepEqual(exits, [1])
    assert.match(stderr.join('\n'), /context-window must be a positive integer/)
  })

  it('rejects setup flags that are missing values', async () => {
    const { stderr, exits, io } = makeIo()
    await runConfigCLI(['setup', 'deepseek', '--key-env', '--default'], io)
    assert.deepEqual(exits, [1])
    assert.match(stderr.join('\n'), /--key-env requires a value/)
  })

  it('configures add-sse servers to use the legacy SSE transport', async () => {
    const { io } = makeIo()
    await runConfigCLI(['mcp', 'add-sse', 'legacy', 'http://localhost:3001/sse'], io)

    const server = loadConfig().mcp.servers['legacy']
    assert.ok(server)
    assert.equal(server.transportHint, 'sse')
    assert.equal(resolveTransportType(server), 'sse-legacy')
  })
})

describe('runConfigCLI web tool commands', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-config-cli-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('set-proxy persists proxy URL', async () => {
    const { stdout, io } = makeIo()
    await runConfigCLI(['set-proxy', 'http://127.0.0.1:7890'], io)
    assert.equal(loadConfig().network.proxy, 'http://127.0.0.1:7890')
    assert.match(stdout.join('\n'), /Proxy set to http:\/\/127\.0\.0\.1:7890/)
  })

  it('set-proxy --clear removes proxy (falls back to env)', async () => {
    const { io } = makeIo()
    await runConfigCLI(['set-proxy', 'http://127.0.0.1:7890'], io)
    await runConfigCLI(['set-proxy', '--clear'], io)
    assert.equal(loadConfig().network.proxy, undefined)
  })

  it('set-proxy without args shows usage and exits 1', async () => {
    const { stderr, exits, io } = makeIo()
    await runConfigCLI(['set-proxy'], io)
    assert.deepEqual(exits, [1])
    assert.match(stderr.join('\n'), /Usage: rivet config set-proxy/)
  })

  it('set-no-proxy persists bypass list', async () => {
    const { io } = makeIo()
    await runConfigCLI(['set-no-proxy', 'localhost,.internal.example.com'], io)
    assert.equal(loadConfig().network.noProxy, 'localhost,.internal.example.com')
  })

  it('set-search-backends splits comma-separated list into array', async () => {
    const { stdout, io } = makeIo()
    await runConfigCLI(['set-search-backends', 'bocha,bing,duckduckgo'], io)
    assert.deepEqual(loadConfig().search.backends, ['bocha', 'bing', 'duckduckgo'])
    assert.match(stdout.join('\n'), /Search backends set to \[bocha, bing, duckduckgo\]/)
  })

  it('set-search-backends trims whitespace in entries', async () => {
    const { io } = makeIo()
    await runConfigCLI(['set-search-backends', ' bocha , bing , duckduckgo '], io)
    assert.deepEqual(loadConfig().search.backends, ['bocha', 'bing', 'duckduckgo'])
  })

  it('set-search-backends without args shows usage and exits 1', async () => {
    const { stderr, exits, io } = makeIo()
    await runConfigCLI(['set-search-backends'], io)
    assert.deepEqual(exits, [1])
    assert.match(stderr.join('\n'), /Usage: rivet config set-search-backends/)
  })

  it('set-jina-url persists Jina Reader base URL', async () => {
    const { stdout, io } = makeIo()
    await runConfigCLI(['set-jina-url', 'https://my-jina-mirror.example'], io)
    assert.equal(loadConfig().fetch.jinaBaseUrl, 'https://my-jina-mirror.example')
    assert.match(stdout.join('\n'), /Jina Reader base URL set to/)
  })
})

describe('runConfigCLI model capability commands', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-config-cli-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('set-default-model persists agent.defaultModel with provider:modelId', async () => {
    const { stdout, io } = makeIo()
    await runConfigCLI(['set-default-model', 'glm:glm-5.2'], io)
    assert.equal(loadConfig().agent.defaultModel, 'glm:glm-5.2')
    assert.match(stdout.join('\n'), /Default model set to glm:glm-5\.2/)
  })

  it('set-default-model without args shows usage and exits 1', async () => {
    const { stderr, exits, io } = makeIo()
    await runConfigCLI(['set-default-model'], io)
    assert.deepEqual(exits, [1])
    assert.match(stderr.join('\n'), /Usage: rivet config set-default-model/)
  })

  it('set-default-model rejects a malformed value (missing colon)', async () => {
    const { stderr, exits, io } = makeIo()
    await runConfigCLI(['set-default-model', 'glm-5.2'], io)
    assert.deepEqual(exits, [1])
    assert.match(stderr.join('\n'), /provider:modelId/)
  })

  it('set-default-model rejects an unknown provider', async () => {
    const { stderr, exits, io } = makeIo()
    await runConfigCLI(['set-default-model', 'ghost:x'], io)
    assert.deepEqual(exits, [1])
    assert.match(stderr.join('\n'), /Provider "ghost" not found/)
    assert.equal(loadConfig().agent.defaultModel, undefined, '校验失败不应写盘')
  })

  it('add-model --vision marks the model vision-capable', async () => {
    const { io } = makeIo()
    await runConfigCLI(['add-model', 'deepseek', 'vision-test', '128000', '32000', '--vision'], io)
    const model = loadConfig().provider.providers.deepseek!.models.find(m => m.id === 'vision-test')!
    assert.equal(model.supportsVision, true)
  })

  it('add-model without --vision leaves supportsVision absent', async () => {
    const { io } = makeIo()
    await runConfigCLI(['add-model', 'deepseek', 'plain-test', '128000', '32000'], io)
    const model = loadConfig().provider.providers.deepseek!.models.find(m => m.id === 'plain-test')!
    assert.equal(model.supportsVision, undefined)
  })

  it('set-model-vision on/off toggles the flag', async () => {
    const { stdout, io } = makeIo()
    await runConfigCLI(['set-model-vision', 'deepseek', 'deepseek-v4-flash', 'on'], io)
    assert.equal(loadConfig().provider.providers.deepseek!.models.find(m => m.id === 'deepseek-v4-flash')!.supportsVision, true)
    assert.match(stdout.join('\n'), /Vision enabled for deepseek-v4-flash/)
    await runConfigCLI(['set-model-vision', 'deepseek', 'deepseek-v4-flash', 'off'], io)
    assert.equal(loadConfig().provider.providers.deepseek!.models.find(m => m.id === 'deepseek-v4-flash')!.supportsVision, false)
  })

  it('set-model-vision rejects an invalid flag or missing args', async () => {
    const { stderr, exits, io } = makeIo()
    await runConfigCLI(['set-model-vision', 'deepseek', 'deepseek-v4-flash', 'maybe'], io)
    assert.deepEqual(exits, [1])
    assert.match(stderr.join('\n'), /Usage: rivet config set-model-vision/)
    await runConfigCLI(['set-model-vision', 'deepseek'], io)
    assert.deepEqual(exits, [1, 1])
    assert.match(stderr.join('\n'), /Usage: rivet config set-model-vision/)
  })

  it('set-model-vision rejects an unknown model', async () => {
    const { stderr, exits, io } = makeIo()
    await runConfigCLI(['set-model-vision', 'deepseek', 'ghost-model', 'on'], io)
    assert.deepEqual(exits, [1])
    assert.match(stderr.join('\n'), /Model "ghost-model" not found/)
  })
})

describe('runConfigCLI vision commands', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-config-cli-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('set-vision persists provider/model with slash separator', async () => {
    const { stdout, io } = makeIo()
    await runConfigCLI(['set-vision', 'glm/glm-5.2'], io)
    const vm = loadConfig().agent.visionModel
    assert.equal(vm?.provider, 'glm')
    assert.equal(vm?.model, 'glm-5.2')
    assert.match(stdout.join('\n'), /Vision model set to glm\/glm-5\.2/)
  })

  it('set-vision accepts optional maxTokens and --prompt', async () => {
    const { io } = makeIo()
    await runConfigCLI(['set-vision', 'glm/glm-5.2', '2048', '--prompt', '描述这张图'], io)
    const vm = loadConfig().agent.visionModel
    assert.equal(vm?.maxTokens, 2048)
    assert.equal(vm?.prompt, '描述这张图')
  })

  it('set-vision rejects a nonexistent provider (校验拦截)', async () => {
    const { stderr, exits, io } = makeIo()
    await runConfigCLI(['set-vision', 'ghost-prov/some-model'], io)
    assert.deepEqual(exits, [1])
    assert.match(stderr.join('\n'), /不在已配置的 provider 列表里/)
    assert.equal(loadConfig().agent.visionModel, undefined, '校验失败不应写盘')
  })

  it('set-vision rejects a nonexistent model', async () => {
    const { stderr, exits, io } = makeIo()
    await runConfigCLI(['set-vision', 'glm/glm-typo'], io)
    assert.deepEqual(exits, [1])
    assert.match(stderr.join('\n'), /没有模型 "glm-typo"/)
  })

  it('set-vision without args shows usage', async () => {
    const { stderr, exits, io } = makeIo()
    await runConfigCLI(['set-vision'], io)
    assert.deepEqual(exits, [1])
    assert.match(stderr.join('\n'), /Usage: rivet config set-vision/)
  })

  it('clear-vision removes the vision model', async () => {
    const { io } = makeIo()
    await runConfigCLI(['set-vision', 'glm/glm-5.2'], io)
    assert.ok(loadConfig().agent.visionModel)
    await runConfigCLI(['clear-vision'], io)
    assert.equal(loadConfig().agent.visionModel, undefined)
  })

  it('set-vision-auto-bridge toggles the flag', async () => {
    const { io } = makeIo()
    await runConfigCLI(['set-vision-auto-bridge', 'on'], io)
    assert.equal(loadConfig().agent.visionAutoBridge, true)
    await runConfigCLI(['set-vision-auto-bridge', 'off'], io)
    assert.equal(loadConfig().agent.visionAutoBridge, false)
  })

  it('set-vision-auto-bridge rejects invalid flag', async () => {
    const { stderr, exits, io } = makeIo()
    await runConfigCLI(['set-vision-auto-bridge', 'maybe'], io)
    assert.deepEqual(exits, [1])
    assert.match(stderr.join('\n'), /Usage: rivet config set-vision-auto-bridge/)
  })
})

describe('runConfigCLI directory grants', () => {
  const prevHome = process.env.RIVET_HOME
  let dir = ''
  let home = ''

  // path-grants 的 RIVET_DIR 是模块首次加载时的快照——home 必须在整个 describe
  // 生命周期内固定（若每个测试换 home，grantPath 会重建旧 home 造成错位写入）。
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-cli-grants-'))
    home = mkdtempSync(join(tmpdir(), 'rivet-cli-home-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
    process.env.RIVET_HOME = home
  })

  after(() => {
    delete process.env.RIVET_CONFIG_PATH
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  afterEach(async () => {
    // 清掉 path-grants 进程内状态，避免跨测试串扰
    const { _resetGrantsForTest } = await import('../../tools/path-grants.js')
    _resetGrantsForTest()
    // 磁盘 store 文件也要清（slug 基于仓库根 cwd，跨测试固定；grantPath 的
    // canonicalize 对已存在路径即 realpathSync）
    const slug = realpathSync(process.cwd()).replace(/[^a-zA-Z0-9]/g, '_').slice(-64)
    rmSync(join(home, `path-grants-${slug}.json`), { force: true })
  })

  it('allow-dir persists per-workspace by default and takes effect immediately', async () => {
    const target = mkdtempSync(join(tmpdir(), 'rivet-cli-target-'))
    try {
      const { stdout, io } = makeIo()
      await runConfigCLI(['allow-dir', target, '--write'], io)
      assert.match(stdout.join('\n'), /Granted write access to/)

      const { isWriteGranted, loadPersistedGrants, _resetGrantsForTest } = await import('../../tools/path-grants.js')
      // 内存即时生效（无需重启）
      assert.equal(isWriteGranted(join(target, 'x')), true)
      // 落盘：模拟重启回灌后仍在
      _resetGrantsForTest()
      loadPersistedGrants(process.cwd())
      assert.equal(isWriteGranted(join(target, 'x')), true, 'per-workspace grant must hydrate from disk')
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('allow-dir defaults to read mode without --write', async () => {
    const target = mkdtempSync(join(tmpdir(), 'rivet-cli-target-'))
    try {
      const { stdout, io } = makeIo()
      await runConfigCLI(['allow-dir', target], io)
      assert.match(stdout.join('\n'), /Granted read access to/)

      const { isReadGranted, isWriteGranted } = await import('../../tools/path-grants.js')
      assert.equal(isReadGranted(join(target, 'x')), true)
      assert.equal(isWriteGranted(join(target, 'x')), false, 'read grant must not confer write')
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('allow-dir --all-projects writes the global config instead of the workspace store', async () => {
    const target = mkdtempSync(join(tmpdir(), 'rivet-cli-target-'))
    try {
      const { stdout, io } = makeIo()
      await runConfigCLI(['allow-dir', target, '--write', '--all-projects'], io)
      assert.match(stdout.join('\n'), /additionalWriteDirs/)

      const config = loadConfig()
      assert.ok(config.agent?.permissions?.additionalWriteDirs?.includes(target), 'global config must list the dir')
      assert.ok(!config.agent?.permissions?.additionalReadDirs?.includes(target))
      // 全局配置不写 per-workspace store（内存也不该有 persist 条目）
      const { listPersistedGrants } = await import('../../tools/path-grants.js')
      assert.deepEqual(listPersistedGrants(process.cwd()), [], 'all-projects must not touch the workspace store')
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('revoke-dir removes a remembered grant from memory and disk', async () => {
    const target = mkdtempSync(join(tmpdir(), 'rivet-cli-target-'))
    try {
      const io0 = makeIo().io
      await runConfigCLI(['allow-dir', target, '--write'], io0)
      const { isWriteGranted } = await import('../../tools/path-grants.js')
      assert.equal(isWriteGranted(join(target, 'x')), true, '前置：授权已生效')

      const { stdout, io } = makeIo()
      await runConfigCLI(['revoke-dir', target], io)
      assert.match(stdout.join('\n'), /Revoked access to/)

      assert.equal(isWriteGranted(join(target, 'x')), false, 'revoke must take effect in-process')
      const { listPersistedGrants, _resetGrantsForTest, loadPersistedGrants } = await import('../../tools/path-grants.js')
      _resetGrantsForTest()
      loadPersistedGrants(process.cwd())
      assert.deepEqual(listPersistedGrants(process.cwd()), [], 'revoked grant must not hydrate from disk')
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('revoke-dir reports when no grant exists', async () => {
    const target = join(tmpdir(), 'rivet-cli-never-granted-' + Date.now())
    const { stdout, io } = makeIo()
    await runConfigCLI(['revoke-dir', target], io)
    assert.match(stdout.join('\n'), /No grant found for/)
  })

  it('list-dirs prints an empty-state message when nothing is remembered', async () => {
    const { stdout, io } = makeIo()
    await runConfigCLI(['list-dirs'], io)
    assert.match(stdout.join('\n'), /No per-workspace directory grants\./)
  })

  it('list-dirs lists remembered grants with their mode', async () => {
    const target = mkdtempSync(join(tmpdir(), 'rivet-cli-target-'))
    try {
      const io0 = makeIo().io
      await runConfigCLI(['allow-dir', target, '--write'], io0)
      const { stdout, io } = makeIo()
      await runConfigCLI(['list-dirs'], io)
      const out = stdout.join('\n')
      assert.match(out, /Per-workspace grants:/)
      assert.ok(out.includes(target), 'listed output must contain the granted root')
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('allow-dir rejects a missing path argument', async () => {
    const { stderr, exits, io } = makeIo()
    await runConfigCLI(['allow-dir'], io)
    assert.deepEqual(exits, [1])
    assert.match(stderr.join('\n'), /Usage: rivet config allow-dir/)
  })
})

describe('runConfigCLI hook 装配命令（P2 Wave 3，L2 审查修复）', () => {
  let dir: string
  let cfgPath: string
  let prevConfigPath: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-cli-hooks-'))
    cfgPath = join(dir, 'config.json')
    prevConfigPath = process.env.RIVET_CONFIG_PATH
    process.env.RIVET_CONFIG_PATH = cfgPath
    const base = loadConfig() as unknown as Record<string, unknown>
    delete (base as { hooks?: unknown }).hooks
    writeFileSync(cfgPath, JSON.stringify(base))
  })

  afterEach(() => {
    if (prevConfigPath === undefined) delete process.env.RIVET_CONFIG_PATH
    else process.env.RIVET_CONFIG_PATH = prevConfigPath
    rmSync(dir, { recursive: true, force: true })
  })

  it('list-hooks 输出配置面（config/env/effective 三行）', async () => {
    const { stdout, io } = makeIo()
    await runConfigCLI(['list-hooks'], io)
    const out = stdout.join('\n')
    assert.match(out, /hooks\.disabled \(config\): \[\]/)
    assert.match(out, /effective disabled: \[\]/)
  })

  it('set-hook-disabled 写入 config 且可被 --enable 移除', async () => {
    const { io } = makeIo()
    await runConfigCLI(['set-hook-disabled', 'dream-distill'], io)
    assert.deepEqual(loadConfig().hooks.disabled, ['dream-distill'])

    // 追加第二个
    await runConfigCLI(['set-hook-disabled', 'kick'], io)
    assert.deepEqual(loadConfig().hooks.disabled, ['dream-distill', 'kick'])

    // --enable 移除
    await runConfigCLI(['set-hook-disabled', 'dream-distill', '--enable'], io)
    assert.deepEqual(loadConfig().hooks.disabled, ['kick'])
  })

  it('set-hook-disabled 缺参时 cliExit(1) 且输出 Usage', async () => {
    const { stderr, exits, io } = makeIo()
    await runConfigCLI(['set-hook-disabled'], io)
    assert.deepEqual(exits, [1])
    assert.match(stderr.join('\n'), /Usage: rivet config set-hook-disabled/)
  })
})

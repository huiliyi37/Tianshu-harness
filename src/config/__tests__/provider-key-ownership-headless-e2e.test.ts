/**
 * headless 凭据归属的**真进程**端到端——与 serve.resolveModelSpec 同语义。
 *
 * 为什么要 spawn 真进程：`provider-keys.test.ts` 里有一份 `resolveLikeHeadless`
 * 复刻体，它只证明「复刻的解析逻辑对」，对 `main.ts` 的真实行为没有约束力。实测
 * 两者已经分叉——复刻体没有 keyId 歧义守卫，`main.ts` 同样漏了它，于是
 * `--model olm:qwen3:32b`（模型 id 自带冒号的 ollama 形态）在 headless 下被判成
 * keyId=qwen3 → findModelInKey 落空 → owner=undefined → 凭据回退到顶层槽，而 A′
 * 已把顶层槽剥进 provider-keys.json，最终 `key=''` 直接 exit 1。TUI/sidecar 走
 * resolveModelSpec（有守卫）不受影响，所以这个洞只在 headless 面上。
 *
 * 本文件跑真实 CLI（优先构建入口，未构建时用绝对源码 loader），断言 mock 端点实际收到的 Authorization / model，
 * 是覆盖那段代码的唯一通道。
 *
 * ⚠ 凭据形态必须是 keyRef + secrets.json：内联 apiKey 会被 A′ 的 stripProviderKeys
 * 剥成 undefined（明文只落 secrets.json），直接用内联槽会造出「配了 key 却读不到」
 * 的假现场。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { cliFixtureEnv, cliProcessArgs } from '../../__tests__/cli-process-fixture.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

interface SeenRequest {
  auth: string
  model: string
}

interface Fixture {
  home: string
  baseUrl: string
  seen: SeenRequest[]
  close: () => Promise<void>
}

/** mock OpenAI 兼容端点 + 隔离 home。keyRef 指向 home/secrets.json。 */
async function makeFixture(providerName: string, keys: Array<{ id: string; models: string[] }>): Promise<Fixture> {
  const home = mkdtempSync(join(tmpdir(), 'rivet-hl-e2e-'))
  mkdirSync(home, { recursive: true })
  const seen: SeenRequest[] = []

  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      let model = '?'
      try { model = (JSON.parse(body) as { model?: string }).model ?? '?' } catch { /* 非 JSON 也照记 auth */ }
      seen.push({ auth: req.headers.authorization ?? '', model })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        'data: ' + JSON.stringify({ choices: [{ delta: { content: 'pong' } }] }) + '\n\n'
        + 'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }) + '\n\n'
        + 'data: [DONE]\n\n',
      )
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const baseUrl = `http://127.0.0.1:${port}/v1`

  // keyRef 命名空间与 keyRefFor 同规：default key 用 provider 名，其余用 provider:keyId。
  const secrets: Record<string, string> = {}
  const keyEntries = keys.map(k => {
    const keyRef = k.id === 'default' ? providerName : `${providerName}:${k.id}`
    secrets[keyRef] = `sk-KEY-${k.id.toUpperCase()}`
    return { id: k.id, label: k.id, keyRef, models: k.models.map(id => ({ id })) }
  })

  writeFileSync(join(home, 'config.json'), JSON.stringify({
    provider: {
      default: providerName,
      providers: {
        [providerName]: {
          name: providerName,
          baseUrl,
          protocol: 'openai',
          capabilities: {},
          thinking: 'disabled',
          maxTokens: 4096,
          unsupported: [],
          models: [{ id: keys[0]!.models[0]! }],
          keys: keyEntries,
        },
      },
    },
    agent: { defaultModel: `${providerName}:${keys[0]!.models[0]!}` },
  }, null, 2))
  writeFileSync(join(home, 'secrets.json'), JSON.stringify({ version: 1, keys: secrets }, null, 2))

  return {
    home,
    baseUrl,
    seen,
    close: async () => {
      await new Promise<void>(r => server.close(() => r()))
      rmSync(home, { recursive: true, force: true })
    },
  }
}

/** 跑一次真 headless。必须异步 spawn——spawnSync 会阻塞本进程事件循环，mock 端点收不到请求。 */
async function runHeadless(fx: Fixture, modelArg: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(
    process.execPath,
    cliProcessArgs(repoRoot, ['-p', 'say hi', '--model', modelArg]),
    {
      cwd: fx.home,
      env: cliFixtureEnv(fx.home),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', d => { stdout += String(d) })
  child.stderr.on('data', d => { stderr += String(d) })
  const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
  const code = await new Promise<number | null>(r => child.on('exit', c => r(c)))
  clearTimeout(timer)
  return { code, stdout, stderr }
}

describe('headless 凭据归属（真进程 E2E）', () => {
  let fx: Fixture

  before(async () => {
    // 两把 key，各挂一个模型；第二把上再挂一个「id 自带冒号」的模型。
    fx = await makeFixture('olm', [
      { id: 'default', models: ['first-model'] },
      { id: 'second', models: ['second-model', 'qwen3:32b'] },
    ])
  })

  after(async () => { await fx.close() })

  it('三段式 provider:keyId:modelId —— 用该 key 的凭据', async () => {
    fx.seen.length = 0
    const r = await runHeadless(fx, 'olm:second:second-model')
    assert.equal(r.code, 0, `进程应成功退出，stderr: ${r.stderr.slice(0, 200)}`)
    assert.equal(fx.seen.length, 1)
    assert.equal(fx.seen[0]!.auth, 'Bearer sk-KEY-SECOND')
    assert.equal(fx.seen[0]!.model, 'second-model')
  })

  it('两段式 provider:modelId —— 按模型归属取凭据（不是第一把 key）', async () => {
    fx.seen.length = 0
    const r = await runHeadless(fx, 'olm:second-model')
    assert.equal(r.code, 0, `进程应成功退出，stderr: ${r.stderr.slice(0, 200)}`)
    assert.equal(fx.seen[0]!.auth, 'Bearer sk-KEY-SECOND', 'second-model 属第二把 key')
    assert.equal(fx.seen[0]!.model, 'second-model')
  })

  it('裸 modelId —— 全 provider 扫描同样按归属', async () => {
    fx.seen.length = 0
    const r = await runHeadless(fx, 'second-model')
    assert.equal(r.code, 0, `进程应成功退出，stderr: ${r.stderr.slice(0, 200)}`)
    assert.equal(fx.seen[0]!.auth, 'Bearer sk-KEY-SECOND')
    assert.equal(fx.seen[0]!.model, 'second-model')
  })

  it('模型 id 自身含冒号（ollama 形态）—— 中间段不是 key id 时不得当 keyId', async () => {
    // 与 serve.resolveModelSpec 的守卫同语义：拆出的 keyId 若不是该 provider 真有的
    // key id，整段还原进 modelRef。缺了这一步就会：判成 keyId=qwen3 → 归属查找落空 →
    // 回落到 models[0] 且凭据拿空 → exit 1（实测 `API key not set`）。
    fx.seen.length = 0
    const r = await runHeadless(fx, 'olm:qwen3:32b')
    assert.equal(r.code, 0, `进程应成功退出，stderr: ${r.stderr.slice(0, 200)}`)
    assert.equal(fx.seen.length, 1, `应发出 1 个请求，stderr: ${r.stderr.slice(0, 200)}`)
    assert.equal(fx.seen[0]!.model, 'qwen3:32b', '不得被切成 model="32b"')
    assert.equal(fx.seen[0]!.auth, 'Bearer sk-KEY-SECOND', 'qwen3:32b 属第二把 key')
  })

  it('四段式 provider:keyId:qwen3:32b —— 显式钉 key 时冒号 id 仍整体保留', async () => {
    fx.seen.length = 0
    const r = await runHeadless(fx, 'olm:second:qwen3:32b')
    assert.equal(r.code, 0, `进程应成功退出，stderr: ${r.stderr.slice(0, 200)}`)
    assert.equal(fx.seen[0]!.model, 'qwen3:32b')
    assert.equal(fx.seen[0]!.auth, 'Bearer sk-KEY-SECOND')
  })

  it('反证：未迁移 provider（无 keys 池）仍走 provider 级凭据', async () => {
    // 不变量：消解歧义不得把「本来就用顶层槽」的存量 provider 弄坏。
    const legacy = await makeFixture('legacyprov', [{ id: 'default', models: ['legacy-model'] }])
    try {
      const { writeFileSync: wf } = await import('node:fs')
      wf(join(legacy.home, 'config.json'), JSON.stringify({
        provider: {
          default: 'legacyprov',
          providers: {
            legacyprov: { name: 'legacyprov', baseUrl: legacy.baseUrl, protocol: 'openai', capabilities: {}, thinking: 'disabled', maxTokens: 4096, unsupported: [], models: [{ id: 'legacy-model' }], keyRef: 'legacyprov' },
          },
        },
        agent: { defaultModel: 'legacyprov:legacy-model' },
      }, null, 2))
      const r = await runHeadless(legacy, 'legacyprov:legacy-model')
      assert.equal(r.code, 0, `进程应成功退出，stderr: ${r.stderr.slice(0, 200)}`)
      assert.equal(legacy.seen[0]!.auth, 'Bearer sk-KEY-DEFAULT', '未迁移 provider 走顶层 keyRef')
      assert.equal(legacy.seen[0]!.model, 'legacy-model')
    } finally {
      await legacy.close()
    }
  })
})

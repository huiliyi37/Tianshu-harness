/**
 * `--stream-events` 无头端到端——真进程 + mock OpenAI 兼容端点（issue #208 的回归闸）。
 *
 * ## 为什么必须 spawn 真进程
 *
 * 缺陷的形状是**接线可达性**，不是逻辑错误：旗标被解析、sink 被创建、`close()`
 * 挂在退出钩子上，唯独 `sinks.push(eventStream.sink)` 落在交互式 TUI 的装配路径里，
 * 无头分支在到达那行之前就 `process.exit` 了。`runHeadless` 自身的单元测试不可能
 * 发现它（它那时根本没有 sink 参数也完全正常），类型检查也不会（`eventStream`
 * 确实被用到）——只有真跑 CLI 入口（已构建的 dist/main.js，否则 src/main.ts）才能覆盖。
 *
 * 断言的核心是**文件非空**：回归态下该文件是 0 字节（调用方预建时）或压根不出现，
 * 而退出码 0、stderr 干净——与"本次运行没有事件"不可区分，正是这条 issue 的痛点。
 *
 * ⚠ 凭据形态必须是 keyRef + secrets.json：内联 apiKey 会被 stripProviderKeys 剥成
 * undefined（明文只落 secrets.json），直接用内联槽会造出"配了 key 却读不到"的假现场
 * （同 provider-key-ownership-headless-e2e.test.ts 的告诫）。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { SessionEvent } from '../server/protocol.js'
import { cliFixtureEnv, cliProcessArgs } from './cli-process-fixture.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

interface Fixture {
  home: string
  close: () => Promise<void>
}

/** mock OpenAI 兼容端点 + 隔离 home（agent 只发一轮文本，不调工具）。 */
async function makeFixture(): Promise<Fixture> {
  const home = mkdtempSync(join(tmpdir(), 'rivet-hl-events-'))
  mkdirSync(home, { recursive: true })

  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
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

  const providerName = 'mockprov'
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    provider: {
      default: providerName,
      providers: {
        [providerName]: {
          name: providerName,
          baseUrl: `http://127.0.0.1:${port}/v1`,
          protocol: 'openai',
          capabilities: {},
          thinking: 'disabled',
          maxTokens: 4096,
          unsupported: [],
          models: [{ id: 'mock-model' }],
          keys: [{ id: 'default', label: 'default', keyRef: providerName, models: [{ id: 'mock-model' }] }],
        },
      },
    },
    agent: { defaultModel: `${providerName}:mock-model` },
  }, null, 2))
  writeFileSync(join(home, 'secrets.json'), JSON.stringify({ version: 1, keys: { [providerName]: 'sk-KEY-DEFAULT' } }, null, 2))

  return {
    home,
    close: async () => {
      await new Promise<void>(r => server.close(() => r()))
      rmSync(home, { recursive: true, force: true })
    },
  }
}

/** 跑一次真 headless。必须异步 spawn——spawnSync 阻塞事件循环会让 mock 端点收不到请求。 */
async function runCli(home: string, extraArgs: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(
    process.execPath,
    cliProcessArgs(repoRoot, ['-p', 'say hi', ...extraArgs]),
    {
      cwd: home,
      env: cliFixtureEnv(home),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', d => { stdout += String(d) })
  child.stderr.on('data', d => { stderr += String(d) })
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
  const code = await new Promise<number | null>(r => child.on('exit', c => r(c)))
  clearTimeout(timer)
  return { code, stdout, stderr }
}

function readEvents(path: string): SessionEvent[] {
  assert.ok(existsSync(path), `--stream-events 目标文件不存在：${path}（回归态：无头下 sink 从未被接线）`)
  const raw = readFileSync(path, 'utf8')
  assert.ok(raw.trim().length > 0, '--stream-events 文件为 0 字节——无头路径又没把 sink 接上事件源')
  return raw.trim().split('\n').map(l => JSON.parse(l) as SessionEvent)
}

describe('--stream-events 无头端到端', () => {
  let fx: Fixture
  before(async () => { fx = await makeFixture() })
  after(async () => { await fx.close() })

  it('写真实事件流（非空 NDJSON，schema 为 SessionEvent）', async () => {
    const eventsPath = join(fx.home, 'events.jsonl')
    const r = await runCli(fx.home, ['--stream-events', eventsPath])
    assert.equal(r.code, 0, `进程应成功退出，stderr: ${r.stderr.slice(0, 300)}`)

    const events = readEvents(eventsPath)
    assert.ok(events.some(e => e.type === 'text_delta'), '文本增量必须进事件流')
    assert.ok(events.some(e => e.type === 'turn_complete'), '回合收尾必须进事件流')
    // SessionEvent schema：seq/ts/type/data —— 不是 stream-json 的 type 信封。
    assert.ok(events.every(e => typeof e.seq === 'number' && typeof e.ts === 'number' && typeof e.data === 'object'))
    assert.deepEqual(events.map(e => e.seq), events.map((_, i) => i + 1), 'seq 必须单调递增无空洞')
  })

  it('与 --stream-json 同时开：两条通道各自完整，互不污染', async () => {
    const eventsPath = join(fx.home, 'events-dual.jsonl')
    const r = await runCli(fx.home, ['--stream-events', eventsPath, '--stream-json'])
    assert.equal(r.code, 0, `进程应成功退出，stderr: ${r.stderr.slice(0, 300)}`)

    // stdout：stream-json 信封（最后一行是 result），不带 SessionEvent 的 seq。
    const stdoutLines = r.stdout.trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    const last = stdoutLines[stdoutLines.length - 1]!
    assert.equal(last.type, 'result')
    assert.equal(last.is_error, false)
    assert.equal(last.seq, undefined, 'stdout 不得混入 SessionEvent 记录')

    // 文件：同一批语义事件的 SessionEvent 投影。
    const events = readEvents(eventsPath)
    assert.ok(events.some(e => e.type === 'text_delta'))
    assert.equal((events[0] as unknown as Record<string, unknown>).subtype, undefined, '文件不得混入 stream-json 信封')
  })
})

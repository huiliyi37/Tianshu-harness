/**
 * 无头续聊接线——`-p` 分支必须消费 `--continue` / `-r <id>`（接线可达性回归闸）。
 *
 * ## 为什么必须 spawn 真进程
 *
 * 缺陷的形状是**接线可达性**，不是逻辑错误：`main()` 在 headless 分支之前就把
 * `RIVET_RESUME` / `RIVET_RESUME_ID` 设好了（`--continue` / `--resume` 的唯一信号），
 * 但无头分支用 `crypto.randomUUID()` 自造会话 id，再 `new SessionContext()` 起一个空
 * 上下文——两个 env 一个都没读。结果：`rivet -r <id> -p ...` 静默开新会话、历史全丢，
 * 退出码 0、stderr 干净，与"本来就没有可恢复的历史"不可区分。
 *
 * `runHeadless` 自身的单元测试发现不了：那时 sessionId 是调用方传进来的既有事实。
 * 只有真跑 CLI 入口（已构建的 dist/main.js，否则 src/main.ts）才能覆盖。
 *
 * 断言分两层，缺一不可：
 *   1. 第二次运行的 `system/init.session_id` 必须**等于**目标 id（不是新 uuid）；
 *   2. home 下**只有一个**会话转录，且其中同时含两轮的 prompt——回归态下第二次 `-p`
 *      会另落一份转录（会话被复制而非续接）。
 *
 * ⚠ 凭据形态必须是 keyRef + secrets.json：内联 apiKey 会被 stripProviderKeys 剥成
 * undefined（明文只落 secrets.json），直接用内联槽会造出"配了 key 却读不到"的假现场
 * （同 provider-key-ownership-headless-e2e.test.ts 的告诫）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { cliFixtureEnv, cliProcessArgs } from './cli-process-fixture.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

interface Fixture {
  home: string
  close: () => Promise<void>
}

/** mock OpenAI 兼容端点 + 隔离 home（agent 只发文本，不调工具）。 */
async function makeFixture(): Promise<Fixture> {
  const home = mkdtempSync(join(tmpdir(), 'rivet-hl-resume-'))
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
      await rm(home, { recursive: true, force: true, maxRetries: 15, retryDelay: 50 })
    },
  }
}

/** 跑一次真 headless。必须异步 spawn——spawnSync 阻塞事件循环会让 mock 端点收不到请求。 */
function runCli(home: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(
    process.execPath,
    cliProcessArgs(repoRoot, args),
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
  return new Promise(resolve => {
    child.on('exit', c => { clearTimeout(timer); resolve({ code: c, stdout, stderr }) })
  })
}

/** 会话转录落点：<home>/sessions/<slug>/<id>.jsonl（每会话子目录内的遥测不算）。 */
function transcriptPaths(home: string): string[] {
  const sessionsRoot = join(home, 'sessions')
  const out: string[] = []
  let slugs: string[]
  try { slugs = readdirSync(sessionsRoot) } catch { return [] }
  for (const slug of slugs) {
    let entries: string[]
    try { entries = readdirSync(join(sessionsRoot, slug)) } catch { continue }
    for (const entry of entries) {
      if (entry.endsWith('.jsonl') && !entry.startsWith('._')) out.push(join(sessionsRoot, slug, entry))
    }
  }
  return out.sort()
}

/** stream-json 首条 system/init 里的 session_id —— 本次运行实际用的会话。 */
function initSessionId(stdout: string): string {
  const events = stdout.trim().split('\n').map(line => {
    try { return JSON.parse(line) as Record<string, unknown> } catch { return null }
  })
  const init = events.find(o => o !== null && o['type'] === 'system' && o['subtype'] === 'init')
  assert.ok(init, `stream-json 必须含 system/init 事件，实得 stdout 尾部：${stdout.slice(-200)}`)
  return String(init['session_id'])
}

describe('无头续聊：-p 必须消费 --continue / -r <id>', () => {
  // 每个用例独占一个 home：会话转录计数是绝对断言（1 份），共用 home 会让前序用例
  // 留下的会话把计数顶上去，把"没新开会话"误报成失败。
  it('首轮：恰好落一份会话转录', async () => {
    const fx = await makeFixture()
    try {
      const r = await runCli(fx.home, ['-p', 'first turn', '--stream-json'])
      assert.equal(r.code, 0, `进程应成功退出，stderr: ${r.stderr.slice(0, 400)}`)
      assert.equal(transcriptPaths(fx.home).length, 1, '首轮应恰好落一份会话转录')
    } finally {
      await fx.close()
    }
  })

  it('-r <id>：续接同一会话，不新开、历史已载入', async () => {
    const fx = await makeFixture()
    try {
      const first = await runCli(fx.home, ['-p', 'first turn', '--stream-json'])
      assert.equal(first.code, 0, `首轮失败，stderr: ${first.stderr.slice(0, 400)}`)
      const targetId = initSessionId(first.stdout)
      const afterFirst = transcriptPaths(fx.home)
      assert.equal(afterFirst.length, 1, '首轮应恰好落一份会话转录')

      const second = await runCli(fx.home, ['-r', targetId, '-p', 'second turn', '--stream-json'])
      assert.equal(second.code, 0, `续聊失败，stderr: ${second.stderr.slice(0, 400)}`)

      assert.equal(
        initSessionId(second.stdout),
        targetId,
        '回归态：headless 分支自造 crypto.randomUUID()，-r 被忽略，第二次运行发出新 id',
      )
      assert.equal(transcriptPaths(fx.home).length, 1, '回归态：第二次 -p 另落一份转录（会话被复制而非续接）')

      const transcript = readFileSync(afterFirst[0]!, 'utf8')
      assert.ok(transcript.includes('first turn'), '转录必须含第一轮 prompt')
      assert.ok(transcript.includes('second turn'), '转录必须含第二轮 prompt（写回同一会话）')
    } finally {
      await fx.close()
    }
  })

  it('-c：续接最近一次会话', async () => {
    const fx = await makeFixture()
    try {
      const first = await runCli(fx.home, ['-p', 'first turn', '--stream-json'])
      assert.equal(first.code, 0, `首轮失败，stderr: ${first.stderr.slice(0, 400)}`)
      const targetId = initSessionId(first.stdout)

      const second = await runCli(fx.home, ['-c', '-p', 'second turn', '--stream-json'])
      assert.equal(second.code, 0, `-c 续聊失败，stderr: ${second.stderr.slice(0, 400)}`)
      assert.equal(initSessionId(second.stdout), targetId, '回归态：-c 被忽略，第二次运行发出新 id')
      assert.equal(transcriptPaths(fx.home).length, 1, '回归态：-c 另落一份转录')
    } finally {
      await fx.close()
    }
  })
})

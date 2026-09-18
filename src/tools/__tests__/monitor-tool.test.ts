import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionJobs } from '../job-store.js'
import { MonitorRegistry } from '../../agent/monitor-registry.js'
import { MONITOR_TOOL } from '../monitor-tool.js'
import type { ToolCallParams } from '../types.js'

/** monitor 工具：参数校验 + subscribe/list/unsubscribe 路径（含 command 起新 job）。 */

const env = { ...process.env }

describe('monitor 工具', () => {
  let dir: string
  let store: SessionJobs
  let registry: MonitorRegistry

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-montool-'))
    store = new SessionJobs(join(dir, 'jobs'))
    registry = new MonitorRegistry(() => store)
  })

  afterEach(() => {
    registry.dispose()
    store.killAll()
    rmSync(dir, { recursive: true, force: true })
  })

  function params(input: Record<string, unknown>): ToolCallParams {
    return { input, cwd: dir, jobs: store, monitors: registry } as unknown as ToolCallParams
  }

  it('subscribe 参数校验：jobId/command 缺一或并存都报错', async () => {
    const neither = await MONITOR_TOOL.execute(params({ action: 'subscribe' }))
    assert.equal(neither.isError, true)
    assert.match(neither.content, /需要 jobId 或 command/)

    const both = await MONITOR_TOOL.execute(params({ action: 'subscribe', jobId: 'a', command: 'b' }))
    assert.equal(both.isError, true)
    assert.match(both.content, /只能给一个/)
  })

  it('subscribe(jobId) 注册成功并出现在 list', async () => {
    const snap = store.spawn({ command: "sh -c 'sleep 5'", rawCommand: 'sleep 5', cwd: dir, env })
    const res = await MONITOR_TOOL.execute(params({ action: 'subscribe', jobId: snap.id, pattern: 'ERROR' }))
    assert.equal(res.isError, false)
    assert.match(res.content, /已注册 monitor mon-/)
    assert.match(res.uiContent ?? '', /◉ 监视/)

    const list = await MONITOR_TOOL.execute(params({ action: 'list' }))
    assert.match(list.content, /\/ERROR\//)
    store.kill(snap.id)
  })

  it('subscribe(command) 新起后台 job 并订阅', async () => {
    const res = await MONITOR_TOOL.execute(params({ action: 'subscribe', command: "sh -c 'sleep 5'" }))
    assert.equal(res.isError, false)
    assert.match(res.content, /已注册 monitor/)
    assert.equal(store.list().length, 1, 'command 应 spawn 成 job')
  })

  it('unsubscribe 需要 id；注销后 list 为空', async () => {
    const noId = await MONITOR_TOOL.execute(params({ action: 'unsubscribe' }))
    assert.equal(noId.isError, true)

    const snap = store.spawn({ command: "sh -c 'sleep 5'", rawCommand: 'sleep 5', cwd: dir, env })
    const sub = await MONITOR_TOOL.execute(params({ action: 'subscribe', jobId: snap.id }))
    const monId = /monitor (mon-[0-9a-f]{6})/.exec(sub.content)?.[1]!
    const unsub = await MONITOR_TOOL.execute(params({ action: 'unsubscribe', id: monId }))
    assert.equal(unsub.isError, false)
    const list = await MONITOR_TOOL.execute(params({ action: 'list' }))
    assert.match(list.content, /没有 monitor/)
    store.kill(snap.id)
  })

  it('monitors 未注入时优雅降级（不报错）', async () => {
    const res = await MONITOR_TOOL.execute({ input: { action: 'list' }, cwd: dir } as unknown as ToolCallParams)
    assert.equal(res.isError, false)
    assert.match(res.content, /不可用/)
  })

  it('subscribe(command) 订阅失败时回收刚 spawn 的 job（不泄漏）', async () => {
    // 独立 registry 且上限为 1：先占满，让下一次 subscribe 必然失败。
    const limit1 = new MonitorRegistry(() => store, { maxMonitors: 1 })
    const first = store.spawn({ command: "sh -c 'sleep 5'", rawCommand: 'sleep 5', cwd: dir, env })
    assert.equal(limit1.subscribe({ jobId: first.id }).ok, true)

    const killed: string[] = []
    const origKill = store.kill.bind(store)
    store.kill = ((id: string) => { killed.push(id); return origKill(id) }) as typeof store.kill

    const idsBefore = new Set(store.list().map(j => j.id))
    try {
      const res = await MONITOR_TOOL.execute({
        input: { action: 'subscribe', command: "sh -c 'sleep 5'" },
        cwd: dir,
        jobs: store,
        monitors: limit1,
      } as unknown as ToolCallParams)

      assert.equal(res.isError, true)
      assert.match(res.content, /已达 monitor 上限/)

      const spawned = store.list().map(j => j.id).filter(id => !idsBefore.has(id))
      assert.equal(spawned.length, 1, 'command 模式应先 spawn 出一个 job')
      assert.deepEqual(killed, spawned, '订阅失败后必须回收刚 spawn 的 job，不能留孤儿')
    } finally {
      store.kill = origKill
      store.kill(first.id)
      limit1.dispose()
    }
  })

  it('requiresApproval：command 命中危险命令闸门才需审批，其余免审批', () => {
    const approval = (input: Record<string, unknown>): boolean =>
      MONITOR_TOOL.requiresApproval!({ input, cwd: dir } as unknown as ToolCallParams)
    // command 模式：危险命令与 bash 同一闸门（DANGEROUS_BASH_PATTERNS）
    assert.equal(approval({ action: 'subscribe', command: 'rm -rf /tmp/x' }), true)
    assert.equal(approval({ action: 'subscribe', command: 'tail -f app.log' }), false)
    // jobId 订阅不执行新命令——永不审批
    assert.equal(approval({ action: 'subscribe', jobId: 'abc123', pattern: 'rm -rf' }), false)
    // 非 subscribe action 不审批
    assert.equal(approval({ action: 'list' }), false)
    assert.equal(approval({ action: 'unsubscribe', id: 'mon-x' }), false)
  })

  it('command 模式的 spawn env 含 mirrorEnv（与 bash 同款）', async () => {
    // 信任门：项目级 mirrors 对未授信 cwd 被剥离（fail-closed），本用例须显式授信。
    const PREV_TRUST = process.env.RIVET_TRUST_PROJECT
    process.env.RIVET_TRUST_PROJECT = '1'
    try {
    // 项目级配置启用镜像（loadConfig 走 .rivet-config.json 分层）。
    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({ mirrors: { enabled: true, preset: 'china' } }))
    let capturedEnv: Record<string, string | undefined> | undefined
    const fakeJob = { id: 'jobfake', command: 'x', status: 'running', startedAt: 0, lastLine: '' }
    const stubJobs = {
      spawn: (opts: { env: Record<string, string | undefined> }) => { capturedEnv = opts.env; return fakeJob },
      list: () => [fakeJob],
      await: async () => null,
      logs: () => null,
      kill: () => false,
      on: () => stubJobs,
      off: () => stubJobs,
    }
    const stubRegistry = new MonitorRegistry(() => stubJobs as never)
    const res = await MONITOR_TOOL.execute({
      input: { action: 'subscribe', command: 'tail -f x.log' },
      cwd: dir,
      jobs: stubJobs,
      monitors: stubRegistry,
    } as unknown as ToolCallParams)
    assert.equal(res.isError, false)
    assert.ok(capturedEnv, 'spawn env should be captured')
    assert.equal(capturedEnv!.PIP_INDEX_URL, 'https://pypi.tuna.tsinghua.edu.cn/simple', 'mirrorEnv 应注入 PIP_INDEX_URL')
    assert.ok(capturedEnv!.npm_config_registry, 'mirrorEnv 应注入 npm registry')
    stubRegistry.dispose()
    } finally {
      if (PREV_TRUST === undefined) delete process.env.RIVET_TRUST_PROJECT
      else process.env.RIVET_TRUST_PROJECT = PREV_TRUST
    }
  })
})

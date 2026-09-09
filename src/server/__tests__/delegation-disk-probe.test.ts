// E4a — apply_edit 磁盘证据自愈（issue #61）：客户端已落盘但结果 POST 丢失时，
// 内核应经磁盘探针立即结算委托，而不是等满 300s 人审窗口。
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { OaiMessage } from '../../api/oai-types.js'

class FakeAgent implements ManagedAgent {
  callbacks?: AgentCallbacks
  messages: OaiMessage[] = []
  private resolveRun?: () => void
  run(_prompt: string, cb: AgentCallbacks): Promise<void> {
    this.callbacks = cb
    return new Promise<void>((res) => { this.resolveRun = res })
  }
  abort(): void { this.resolveRun?.() }
  listArtifacts() { return [] }
  async readArtifact() { return null }
  getMessages() { return this.messages }
  replaceMessages(msgs: OaiMessage[]) { this.messages = msgs }
  rewindToMessages(msgs: OaiMessage[]) { this.messages = msgs }
}

/** 竞速等待：settle 前返回 'pending'，否则返回结果/null。 */
function racePending<T>(p: Promise<T>, ms: number): Promise<T | 'pending'> {
  return Promise.race([
    p.then((v) => v),
    new Promise<'pending'>((res) => setTimeout(() => res('pending'), ms)),
  ])
}

/** 断言已结算并收窄类型（assert.notEqual 无法让 TS 收窄联合）。 */
async function expectSettled<T>(p: Promise<T | 'pending'>, label: string): Promise<T> {
  const v = await p
  assert.notEqual(v, 'pending', label)
  return v as T
}

describe('E4a delegation disk probe', () => {
  let cwd: string
  let manager: RuntimeSessionManager
  let agents: FakeAgent[]

  before(() => {
    // 测试用短轮询间隔，避免真实等待
    process.env.RIVET_DELEGATE_PROBE_MS = '30'
    cwd = mkdtempSync(join(tmpdir(), 'delegate-probe-'))
    writeFileSync(join(cwd, 'a.txt'), 'old\n')
    agents = []
    manager = new RuntimeSessionManager({
      createAgent: () => {
        const a = new FakeAgent()
        agents.push(a)
        return a
      },
      defaultCwd: cwd,
      approvalTimeoutMs: 0,
      watchdogContinueDelayMs: 0,
    })
  })

  after(() => {
    delete process.env.RIVET_DELEGATE_PROBE_MS
    manager.shutdownAll()
    rmSync(cwd, { recursive: true, force: true })
  })

  it('客户端已落盘（内容精确匹配）→ 无需应答即自愈结算', async () => {
    const rec = manager.createSession({ cwd, title: 'p1', prompt: 'go' })
    const cb = agents.at(-1)!.callbacks!
    manager.registerDelegateCapabilities(rec.id, 'c1', ['apply_edit'])
    // 模拟客户端比应答先落盘：文件已经是 newContent
    writeFileSync(join(cwd, 'a.txt'), 'new\n')
    const result = cb.onToolDelegate!('apply_edit', {
      path: 'a.txt', oldContent: 'old\n', newContent: 'new\n',
    })
    const settled = await expectSettled(racePending(result, 2_000), '磁盘证据存在时应自愈，不应等满窗口')
    assert.ok(settled, '自愈结果不应为 null')
    assert.equal(settled.status, 'ok')
    assert.match(settled.content ?? '', /自愈|落盘/)
  })

  it('客户端未落盘 → 保持 pending，不提前 ack', async () => {
    const rec = manager.createSession({ cwd, title: 'p2', prompt: 'go' })
    const cb = agents.at(-1)!.callbacks!
    manager.registerDelegateCapabilities(rec.id, 'c2', ['apply_edit'])
    writeFileSync(join(cwd, 'a.txt'), 'old\n') // 仍是旧内容
    const result = cb.onToolDelegate!('apply_edit', {
      path: 'a.txt', oldContent: 'old\n', newContent: 'new\n',
    })
    const probeDelay = Number.parseInt(process.env.RIVET_DELEGATE_PROBE_MS ?? '30', 10)
    const still = await racePending(result, probeDelay * 6)
    assert.equal(still, 'pending', '内容不匹配时不得提前结算')
    // 随后客户端真正落盘 → 探针自愈
    writeFileSync(join(cwd, 'a.txt'), 'new\n')
    const settled = await expectSettled(racePending(result, 2_000), '落盘后应自愈')
    assert.ok(settled, '自愈结果不应为 null')
    assert.equal(settled.status, 'ok')
  })

  it('部分写入/尺寸不符 → 不误判为已落盘', async () => {
    const rec = manager.createSession({ cwd, title: 'p3', prompt: 'go' })
    const cb = agents.at(-1)!.callbacks!
    manager.registerDelegateCapabilities(rec.id, 'c3', ['apply_edit'])
    writeFileSync(join(cwd, 'a.txt'), 'old\n')
    const result = cb.onToolDelegate!('apply_edit', {
      path: 'a.txt', oldContent: 'old\n', newContent: 'new\n',
    })
    // 半截写入（尺寸不同）
    writeFileSync(join(cwd, 'a.txt'), 'n')
    const probeDelay = Number.parseInt(process.env.RIVET_DELEGATE_PROBE_MS ?? '30', 10)
    const still = await racePending(result, probeDelay * 6)
    assert.equal(still, 'pending', '半截写入不得触发自愈')
    // 客户端显式应答照常生效
    const events = manager.getEvents(rec.id, 0)
    const rid = String(events?.events.find((e) => e.type === 'tool_delegate')?.data.requestId)
    assert.ok(manager.answerDelegation(rec.id, rid, { content: 'user accepted', status: 'ok' }))
    const settled = await result
    assert.equal(settled?.content, 'user accepted')
  })

  it('显式应答后探针停止（重复结算不生效）', async () => {
    const rec = manager.createSession({ cwd, title: 'p4', prompt: 'go' })
    const cb = agents.at(-1)!.callbacks!
    manager.registerDelegateCapabilities(rec.id, 'c4', ['apply_edit'])
    writeFileSync(join(cwd, 'a.txt'), 'old\n')
    const result = cb.onToolDelegate!('apply_edit', {
      path: 'a.txt', oldContent: 'old\n', newContent: 'new\n',
    })
    const events = manager.getEvents(rec.id, 0)
    const rid = String(events?.events.find((e) => e.type === 'tool_delegate')?.data.requestId)
    assert.ok(manager.answerDelegation(rec.id, rid, { content: 'ok', status: 'ok' }))
    const settled = await result
    assert.equal(settled?.content, 'ok')
    // 应答后再写盘：pending 已移除，探针必须已停（不会有第二次结算/异常）
    writeFileSync(join(cwd, 'a.txt'), 'new\n')
    await new Promise((r) => setTimeout(r, Number.parseInt(process.env.RIVET_DELEGATE_PROBE_MS ?? '30', 10) * 4))
    assert.equal(manager.answerDelegation(rec.id, rid, { content: 'x', status: 'ok' }), false)
  })

  it('能力清除（SSE 断开）→ 立即失败回退并停探针', async () => {
    const rec = manager.createSession({ cwd, title: 'p5', prompt: 'go' })
    const cb = agents.at(-1)!.callbacks!
    manager.registerDelegateCapabilities(rec.id, 'c5', ['apply_edit'])
    writeFileSync(join(cwd, 'a.txt'), 'old\n')
    const result = cb.onToolDelegate!('apply_edit', {
      path: 'a.txt', oldContent: 'old\n', newContent: 'new\n',
    })
    assert.ok(manager.clearDelegateCapabilities(rec.id, 'c5'))
    const settled = await racePending(result, 2_000)
    assert.equal(settled, null, '客户端失联 → fail-back null（本地写）')
  })

  it('RIVET_DELEGATE_DISK_PROBE=0 可关闭探针（回退旧行为）', async () => {
    process.env.RIVET_DELEGATE_DISK_PROBE = '0'
    try {
      const rec = manager.createSession({ cwd, title: 'p6', prompt: 'go' })
      const cb = agents.at(-1)!.callbacks!
      manager.registerDelegateCapabilities(rec.id, 'c6', ['apply_edit'])
      writeFileSync(join(cwd, 'a.txt'), 'new\n') // 文件已匹配，但探针被关
      const result = cb.onToolDelegate!('apply_edit', {
        path: 'a.txt', oldContent: 'old\n', newContent: 'new\n',
      })
      const probeDelay = Number.parseInt(process.env.RIVET_DELEGATE_PROBE_MS ?? '30', 10)
      const still = await racePending(result, probeDelay * 6)
      assert.equal(still, 'pending', '探针关闭时不得自愈')
    } finally {
      delete process.env.RIVET_DELEGATE_DISK_PROBE
    }
  })
})

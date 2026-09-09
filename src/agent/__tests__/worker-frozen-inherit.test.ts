/**
 * worker 续跑冻结快照继承（e29ff6171 回流：OOP/进程内续跑冷启动全量重建根修）。
 *
 * 背景：worker 续跑/复核/重试每次经 runtimeFactory / child 新建 PromptEngine，
 * 历史经 priorMessages 重放但冻结快照不回传 → volatile 字节跨实例漂移 → 前缀
 * 在第一条 user 消息附近全断、上下文全量重建（现场实测：tianshu-official
 * 3.15.0 发布版 worker 面加权命中 77.7%，单段一次重建 22.8k tokens）。
 *
 * 三层验证（镜像 main e29ff6171）：
 * 1. 行为级——FrozenSnapshotData（协议线形态，非活引擎）inherit 后历史 user
 *    消息字节一致，活跃边界按新 volatile 渲染（只在新边界断尾）。
 * 2. coordinator——续跑把上一轮 WorkerSessionRun.frozenSnapshot 回传为
 *    priorFrozenSnapshot，且逐轮新快照覆盖旧快照。
 * 3. OOP 协议面——priorFrozenSnapshot 经 init 帧到子进程、frozenSnapshot 经
 *    result 帧回父进程（真子进程假 agent）。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DelegationCoordinator } from '../coordinator.js'
import { PromptEngine } from '../../prompt/engine.js'
import { parseFrozenSnapshotData, type FrozenSnapshotData } from '../../prompt/frozen-snapshot.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_ONLY_WORKER_TOOLS, type WorkerResult } from '../work-order.js'
import { profileRegistry } from '../profile-registry.js'
import type { StreamClient } from '../../api/stream-client.js'
import type { ModelCapabilityCard } from '../../model/capability.js'
import type { Tool, ToolCallParams } from '../../tools/types.js'
import type { OaiMessage } from '../../api/oai-types.js'
import type { WorkerSessionConfig } from '../worker-session.js'
import { createFrameDecoder } from '../worker-process/protocol.js'
import { runWorkerSessionOop, type WorkerOopOptions } from '../worker-process/parent.js'
import type { WorkOrder } from '../work-order.js'

// ── 行为级：FrozenSnapshotData inherit（OOP 线协议形态） ─────────

function mkWorkerEngine(marker: string, inheritFrozenFrom?: FrozenSnapshotData): PromptEngine {
  return new PromptEngine({
    model: 'deepseek-v4-flash',
    maxTokens: 4096,
    staticCtx: { tools: [], audience: 'subagent' },
    volatileCtx: { cwd: '/repo', rivetMd: `# ${marker}` },
    habituationThreshold: 0,
    inheritFrozenFrom,
  })
}

function renderedUser(messages: readonly OaiMessage[], userText: string): string {
  const msg = messages.find(
    m => m.role === 'user' && typeof m.content === 'string' && m.content.includes(`\n---\n${userText}`),
  )
  assert.ok(msg && typeof msg.content === 'string', `expected rendered user message for "${userText}"`)
  return msg.content
}

const CONVERSATION: OaiMessage[] = [
  { role: 'user', content: 'm1' },
  { role: 'assistant', content: 'r1' },
  { role: 'user', content: 'm2' },
]

describe('worker frozen inherit（FrozenSnapshotData 经协议继承）', () => {
  it('导出 → 序列化 → inherit：历史 user 字节一致，活跃边界按新 volatile 渲染', () => {
    const a = mkWorkerEngine('PROC_A')
    a.buildOaiRequest([{ role: 'user', content: 'm1' }])
    const aReq2 = a.buildOaiRequest(CONVERSATION)
    const aHistoricalM1 = renderedUser(aReq2.messages, 'm1')
    assert.ok(aHistoricalM1.includes('PROC_A'))

    // 模拟线协议：export → JSON 序列化 → parse（坏数据降级为 undefined 的同一入口）。
    const wire = parseFrozenSnapshotData(JSON.parse(JSON.stringify(a.exportFrozenSnapshot())))
    assert.ok(wire, 'snapshot must survive the wire roundtrip')

    const b = mkWorkerEngine('PROC_B', wire)
    const bReq = b.buildOaiRequest(CONVERSATION)
    // 历史消息：继承快照 → 与上一进程逐字节一致（前缀缓存命中）。
    assert.equal(renderedUser(bReq.messages, 'm1'), aHistoricalM1)
    // 活跃边界：按本进程 volatile 渲染（新 user 边界断尾，诚实上下文）。
    assert.ok(renderedUser(bReq.messages, 'm2').includes('PROC_B'))
  })

  it('对照：无 inherit 时历史按新 volatile 重建（续跑冷启动的旧形态）', () => {
    const a = mkWorkerEngine('PROC_A')
    a.buildOaiRequest([{ role: 'user', content: 'm1' }])
    const b = mkWorkerEngine('PROC_B') // 裸构造——修复前 child.ts / runtimeFactory 的形态
    const bReq = b.buildOaiRequest(CONVERSATION)
    assert.ok(renderedUser(bReq.messages, 'm1').includes('PROC_B'), '历史被新字节重建 = byte-0 全 miss')
  })

  it('坏快照数据降级为冷启动（不炸构造）', () => {
    const b = new PromptEngine({
      model: 'm',
      maxTokens: 1024,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/repo' },
      habituationThreshold: 0,
      inheritFrozenFrom: { v: 1, frozenUserMerged: 'bad' as unknown as [string, string[]][], frozenPendingMerged: [], firstUserKey: 'x', collapseWatermark: 0, collapseTokenStep: -1 },
    })
    const req = b.buildOaiRequest(CONVERSATION)
    assert.ok(req.messages.length > 0, '坏快照不得炸构造——降级冷启动照常出请求')
  })
})

// ── coordinator 级：续跑/复核把上一轮 frozenSnapshot 回传 ─────────

function fakeTool(name: string): Tool {
  return {
    definition: { name, description: `${name} test tool`, input_schema: { type: 'object', properties: {} } },
    execute: async () => ({ content: `${name} executed` }),
    requiresApproval: (_params: ToolCallParams) => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  for (const name of READ_ONLY_WORKER_TOOLS) registry.register(fakeTool(name))
  for (const pname of profileRegistry.getProfileNames()) {
    for (const tool of profileRegistry.get(pname)!.allowedTools) registry.register(fakeTool(tool))
  }
  return registry
}

const cards: ModelCapabilityCard[] = [{
  model: 'test-model',
  toolUseReliability: 0.8,
  jsonStability: 0.8,
  editSuccessRate: 0.7,
  testRepairRate: 0.6,
  contextWindow: 128_000,
  cacheEconomics: 'medium',
  recommendedTasks: ['code_search'],
}]

const LONG_SUMMARY =
  'This is a sufficiently long summary that exceeds the minimum threshold of 200 characters. It describes what the worker found: the continuation flow was traced through coordinator.ts and worker-session.ts. The key finding is that priorFrozenSnapshot is carried across continuation rounds correctly by the coordinator delegation state machine.'

function makeSnapshot(marker: string): FrozenSnapshotData {
  return {
    v: 1,
    frozenUserMerged: [['m1', [`frozen-bytes-${marker}`]]],
    frozenPendingMerged: [],
    firstUserKey: 'm1',
    collapseWatermark: 0,
    collapseTokenStep: -1,
  }
}

function blockedResult(orderId: string): WorkerResult {
  return {
    workOrderId: orderId,
    status: 'blocked',
    summary: 'budget exhausted mid-work',
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'skipped',
    failureReason: 'max_turns',
  }
}

function passedResult(orderId: string): WorkerResult {
  return {
    workOrderId: orderId,
    status: 'passed',
    summary: LONG_SUMMARY,
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'verified',
  }
}

const MOCK_MESSAGES: OaiMessage[] = [
  { role: 'user', content: 'do the work' },
  { role: 'assistant', content: 'partial' },
]

describe('coordinator 续跑冻结快照回传', () => {
  it('续跑拿到上一轮快照，且逐轮覆盖（snap1 → snap2）', async () => {
    const captured: Array<{ priorFrozenSnapshot?: FrozenSnapshotData; objective: string }> = []
    let call = 0

    const coordinator = new DelegationCoordinator({
      baseToolRegistry: makeRegistry(),
      modelCards: cards,
      maxWorkers: 2,
      cwd: '/repo',
      runtimeFactory: (order, card, workerRegistry) => ({
        order,
        client: {} as StreamClient,
        promptEngine: new PromptEngine({
          model: card.model,
          maxTokens: 1024,
          staticCtx: { tools: workerRegistry.getDefinitions() },
          volatileCtx: { cwd: '/repo' },
        }),
        toolRegistry: workerRegistry,
        cwd: '/repo',
        maxTurns: 2,
        contextWindow: card.contextWindow,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      }),
      runWorker: async (config: WorkerSessionConfig) => {
        call++
        captured.push({
          priorFrozenSnapshot: config.priorFrozenSnapshot,
          objective: config.order.objective,
        })
        const round = call
        return {
          result: round < 3 ? blockedResult(config.order.id) : passedResult(config.order.id),
          transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
          session: { getMessages: () => MOCK_MESSAGES },
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          frozenSnapshot: makeSnapshot(`round${round}`),
        } as never
      },
    })

    await coordinator.delegate({
      parentTurnId: 'tu_frozen',
      objective: 'trace the continuation flow across multiple coordinator modules',
      kind: 'code_search',
      profile: 'code_scout',
      scope: { files: ['a.ts'] },
    })

    assert.equal(captured.length, 4, '首轮 + 两次续跑 + 一次证据复核（findings 为空触发）')
    assert.equal(captured[0]!.priorFrozenSnapshot, undefined, '首轮无快照可继承')
    assert.deepEqual(captured[1]!.priorFrozenSnapshot, makeSnapshot('round1'), '第一次续跑继承首轮快照')
    assert.deepEqual(captured[2]!.priorFrozenSnapshot, makeSnapshot('round2'), '第二次续跑拿到覆盖后的新快照')
    assert.deepEqual(captured[3]!.priorFrozenSnapshot, makeSnapshot('round3'), '证据复核继承第三轮快照')
    assert.notEqual(captured[3]!.objective, captured[0]!.objective, '复核轮走 revision objective')
  })
})

// ── OOP 协议面：init 帧带快照下行、result 帧带快照上行 ─────────────

/** 假子进程：把 init 里的 priorFrozenSnapshot 原样装进 result.frozenSnapshot 返回。 */
function writeEchoFixture(dir: string): string {
  const src = `
const { createInterface } = require('node:readline')
const dec = (${createFrameDecoder.toString()})()
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  for (const msg of dec.feed(line + '\\n')) {
    if (msg.t === 'init') {
      send({ t: 'result', run: {
        result: { workOrderId: 'wo_echo', status: 'passed', summary: 'echo', findings: [], artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'verified' },
        transcript: { text: '', thinking: '', toolUses: [], toolResults: [], repairAttempts: 0, errors: [] },
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        messages: [{ role: 'user', content: 'echo' }],
        frozenSnapshot: msg.payload.config.priorFrozenSnapshot,
        turnCount: 1,
      } })
      process.exit(0)
    }
  }
})
`
  const path = join(dir, 'fixture-echo-snapshot.cjs')
  writeFileSync(path, src)
  return path
}

describe('OOP 协议面冻结快照往返', () => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-frozen-oop-'))

  it('priorFrozenSnapshot → init 帧；frozenSnapshot → result 帧 → WorkerSessionRun', async () => {
    const fixture = writeEchoFixture(dir)
    const opts: WorkerOopOptions = {
      getMemoryBlock: () => 'mb',
      stallMsOverride: 10_000,
      entryOverride: { execArgs: [], script: fixture },
      spawnOverride: (_e, script) => spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] }),
    }
    const snapshot = makeSnapshot('wire')
    const cfg = {
      order: { id: 'wo_echo', objective: 'echo', profile: 'code_scout', allowedTools: ['read_file'], budget: { maxTurns: 3, maxTokens: 1000, wallClockMs: 60_000, inputTokens: 10_000, outputTokens: 2_000 } } as unknown as WorkOrder,
      client: {} as WorkerSessionConfig['client'],
      promptEngine: {} as WorkerSessionConfig['promptEngine'],
      toolRegistry: {} as WorkerSessionConfig['toolRegistry'],
      cwd: process.cwd(),
      maxTurns: 3,
      contextWindow: 64000,
      compact: { enabled: false, model: 'flash' },
      runtimeDecision: { providerName: 'deepseek', model: 'deepseek-v4-flash', maxTokens: 4096, contextWindow: 64000, thinkingBudget: 4096, isWrite: false },
      activeClaims: [],
      priorFrozenSnapshot: snapshot,
    } as WorkerSessionConfig
    const run = await runWorkerSessionOop(cfg, opts)
    assert.equal(run.result.status, 'passed')
    assert.deepEqual(run.frozenSnapshot, snapshot, '快照经 init 帧到子进程、result 帧完整带回父进程')
  })

  after(() => rmSync(dir, { recursive: true, force: true }))
})

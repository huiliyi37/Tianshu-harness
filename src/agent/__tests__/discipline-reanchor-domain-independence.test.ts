import { describe, it, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { READ_FILE_TOOL } from '../../tools/read-file.js'
import { starDomainRegistry } from '../star-domain-registry.js'
import {
  DISCIPLINE_REANCHOR_INTERVAL,
  type AdvisoryEntry,
} from '../advisory-bus.js'
import type { ActiveStarDomain, StarDomainId } from '../star-domain.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'

/**
 * issue #173 的端到端表征（characterization）测试。
 *
 * 该 issue 指出一个不对称：hook 的纠偏只随**星域**一个坐标变化，而
 * `loop.ts` 的纪律重锚每 DISCIPLINE_REANCHOR_INTERVAL(=15) 次工具调用提交一次，
 * 提交的 6 个变体（`advisory-bus.ts` 的 DISCIPLINE_VARIANTS）**全部**是【天梁】
 * 交付纪律——于是破军会话（域记忆写的是「失败是探索的代价」）同样每 15 次收到
 * 一次交付纪律。
 *
 * ⚠ 本文件钉的是**当时的行为**，不是对它的背书：如果 #173 被接受（纪律文本按
 * （星域, 任务类型）二元组取材），这些断言应当随之**重写**，而不是被当成回归。
 * 它的用途是给那次讨论一个可执行的锚点——改之前先让它红，改的时候知道自己在
 * 改什么。
 *
 * 装配与 `courage-lifecycle-wiring.test.ts` 同款（真 AgentLoop + mock stream client，
 * 不联网、不需要 API key）；域从 `starDomainRegistry` 取，与 `loop.ts:1217` 同源。
 */

const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-reanchor-domain-'))

function textOnlyClient(text = 'done'): StreamClient {
  return {
    stream: mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
      cb.onTextDelta(text)
      cb.onContentBlock({ type: 'text', text })
      cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 50 })
    }),
  } as unknown as StreamClient
}

function makeAgent(): AgentLoop {
  const engine = new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [READ_FILE_TOOL.definition] },
    volatileCtx: { cwd: TEST_CWD },
  })
  const registry = new ToolRegistry()
  registry.register(READ_FILE_TOOL)
  return new AgentLoop({
    client: textOnlyClient(),
    promptEngine: engine,
    toolRegistry: registry,
    maxTurns: 3,
    contextWindow: 1_000_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
  }, new SessionContext(), TEST_CWD)
}

/** 按 loop.ts:1219 的同款构造把会话钉到某个星域上。 */
function pinDomain(agent: AgentLoop, id: StarDomainId): void {
  const pinned = starDomainRegistry.get(id)
  assert.ok(pinned, `星域 ${id} 应在 registry 里`)
  agent.sessionDomain = {
    id: pinned.id as StarDomainId,
    name: pinned.name,
    volatileBlock: pinned.volatileBlock,
    motto: pinned.motto,
    courageThreshold: pinned.courageThreshold,
  } satisfies ActiveStarDomain
}

/** 走真实工具历史路径 n 次，返回期间调用了 submit 的条目。 */
function driveToolCalls(agent: AgentLoop, submitSpy: ReturnType<typeof mock.method>, n: number): AdvisoryEntry[] {
  for (let i = 0; i < n; i++) {
    // read_file 不在 PRODUCTIVE_TOOLS 里，避免顺手改动收敛冷却；只关心重锚计数。
    agent.recordToolHistory('read_file', { path: 'a.ts' }, false, 'ok')
  }
  return submitSpy.mock.calls.map(c => c.arguments[0] as AdvisoryEntry)
}

const reanchors = (entries: AdvisoryEntry[]): AdvisoryEntry[] =>
  entries.filter(e => e.key === 'discipline-reanchor')

describe('纪律重锚与星域解耦（issue #173 表征）', () => {
  afterEach(() => { mock.restoreAll() })

  it('第 14 次不提交、第 15 次提交一次——钉住 DISCIPLINE_REANCHOR_INTERVAL 边界', () => {
    const agent = makeAgent()
    const spy = mock.method(agent.advisoryBus, 'submit')

    const at14 = reanchors(driveToolCalls(agent, spy, DISCIPLINE_REANCHOR_INTERVAL - 1))
    assert.equal(at14.length, 0, `第 ${DISCIPLINE_REANCHOR_INTERVAL - 1} 次工具调用不应重锚`)

    const at15 = reanchors(driveToolCalls(agent, spy, 1))
    assert.equal(at15.length, 1, `第 ${DISCIPLINE_REANCHOR_INTERVAL} 次工具调用应重锚一次`)
  })

  it('破军会话（低勇气阈值域）收到的仍是【天梁】交付纪律', () => {
    const agent = makeAgent()
    pinDomain(agent, 'pojun')
    assert.equal(agent.sessionDomain?.courageThreshold, 0.25, '破军阈值为全域最低，是本条对照的意义所在')

    const spy = mock.method(agent.advisoryBus, 'submit')
    const got = reanchors(driveToolCalls(agent, spy, DISCIPLINE_REANCHOR_INTERVAL))

    assert.equal(got.length, 1, '破军会话同样每 15 次收到一次纪律重锚')
    assert.match(got[0]!.content, /【天梁】/, '文本仍是【天梁】交付纪律——#173 指出的不对称')
  })

  it('两端星域（破军 0.25 / 太一 0.95）拿到的是同一套纪律文本', () => {
    const texts: string[] = []
    for (const id of ['pojun', 'taiyi'] as const) {
      const agent = makeAgent()
      pinDomain(agent, id)
      const spy = mock.method(agent.advisoryBus, 'submit')
      texts.push(reanchors(driveToolCalls(agent, spy, DISCIPLINE_REANCHOR_INTERVAL))[0]!.content)
      mock.restoreAll()
    }
    // 变体是随机选取的，故不断言两串相等；断言两边都落在同一套【天梁】文本里。
    for (const t of texts) assert.match(t, /【天梁】/)
    assert.equal(new Set(texts.map(t => t.includes('【天梁】'))).size, 1)
  })
})

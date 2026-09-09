import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildCockpitSnapshot } from '../state.js'
import type { AgentLoop } from '../../../agent/loop.js'
import { SessionContext } from '../../../agent/context.js'
import type { McpManager } from '../../../mcp/manager.js'
import { createTraceStore } from '../../../agent/trace-store.js'

function makeAgent(overrides: Partial<AgentLoop> = {}): AgentLoop {
  return {
    getTraceStore: () => createTraceStore(),
    getReasoningEffort: () => undefined,
    getEvidenceState: () => ({ filesRead: new Set(), filesModified: new Set(), verifications: [], deliveryStatus: 'unverified' as const, impactedFiles: new Set(), impactedTests: new Set() }),
    getDoomLoopLevel: () => 'none' as const,
    getLatestRisk: () => ({ level: 'none' as const, reasons: [], suggestedAction: '' }),
    getContextLayerReport: () => ({ layers: [] }),
    getSessionDomain: () => null,
    ...overrides,
  } as unknown as AgentLoop
}

function makeSession(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    getTotalUsage: () => ({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 }),
    getCacheHitRate: () => 0.8,
    getLatestTurnHitRate: () => null,
    getRecentTurnHitRate: () => null,
    getContextLedger: () => null,
    getCompactEvents: () => [],
    ...overrides,
  } as unknown as SessionContext
}

function makeMcpManager(overrides: Partial<McpManager> = {}): McpManager {
  return {
    getStates: () => [],
    getAllTools: () => [],
    ...overrides,
  } as unknown as McpManager
}

describe('buildCockpitSnapshot', () => {
  it('returns idle panel statuses with no data', () => {
    const snap = buildCockpitSnapshot({
      agent: makeAgent(),
      session: makeSession(),
      model: 'test-model',
      cacheHitRate: 0,
      cost: 0,
      mcpManager: null,
    })
    assert.equal(snap.safety.doomLoopLevel, 'none')
    assert.equal(snap.safety.riskLevel, 'none')
    assert.equal(snap.verification.deliveryStatus, 'unverified')
    assert.equal(snap.model.name, 'test-model')
    assert.equal(snap.mcp.totalTools, 0)
    assert.equal(snap.mcp.connectedServers, 0)
    assert.equal(snap.panelStatuses.safety, 'ok')
    assert.equal(snap.panelStatuses.model, 'ok')
    assert.equal(snap.panelStatuses.context, 'idle')
  })

  it('sets safety panel to error when doom-loop blocked', () => {
    const snap = buildCockpitSnapshot({
      agent: makeAgent({
        getDoomLoopLevel: () => 'blocked',
        getLatestRisk: () => ({ level: 'high', reasons: ['doom loop'], suggestedAction: 'stop' }),
      }),
      session: makeSession(),
      model: 'test',
      cacheHitRate: 0,
      cost: 0,
      mcpManager: null,
    })
    assert.equal(snap.panelStatuses.safety, 'error')
    assert.equal(snap.panelStatuses.summary, 'error')
  })

  it('sets verify panel to warn when files modified without verification', () => {
    const snap = buildCockpitSnapshot({
      agent: makeAgent({
        getEvidenceState: () => ({
          filesRead: new Set(['a.ts']),
          filesModified: new Set(['b.ts', 'c.ts']),
          verifications: [],
          deliveryStatus: 'unverified' as const,
          impactedFiles: new Set(),
          impactedTests: new Set(),
        }),
      }),
      session: makeSession(),
      model: 'test',
      cacheHitRate: 0,
      cost: 0,
      mcpManager: null,
    })
    assert.equal(snap.panelStatuses.verify, 'warn')
    assert.equal(snap.verification.filesModified, 2)
  })

  it('includes MCP server states', () => {
    const snap = buildCockpitSnapshot({
      agent: makeAgent(),
      session: makeSession(),
      model: 'test',
      cacheHitRate: 0,
      cost: 0,
      mcpManager: makeMcpManager({
        getStates: () => [
          { serverId: 'ctx7', status: 'connected' as const, toolCount: 3 },
          { serverId: 'broken', status: 'error' as const, toolCount: 0, error: 'refused' },
        ],
        getAllTools: () => [{ definition: { name: 't1' } }] as any[],
      }),
    })

    assert.equal(snap.mcp.servers.length, 2)
    assert.equal(snap.mcp.connectedServers, 1)
    assert.equal(snap.mcp.totalTools, 1)
    assert.equal(snap.panelStatuses.mcp, 'error')
  })

  it('advisory 面板:从 guardianActivity/readback/bus 组装,静音 key 触发 warn', () => {
    const stats = new Map([
      ['adv-a', { delivered: 5, adopted: 3, ignored: 2, ignoredStreak: 1, shadowHeld: 2, shadowSatisfied: 1 }],
      ['adv-cold', { delivered: 0, adopted: 0, ignored: 0, ignoredStreak: 0, shadowHeld: 0, shadowSatisfied: 0 }],
    ])
    const snap = buildCockpitSnapshot({
      agent: makeAgent({
        guardianActivity: {
          ccr: 0, shifts: {},
          advisoriesRendered: 7, advisoriesDropped: 2,
          advisoriesAdopted: 3, advisoriesIgnored: 2, advisoriesHeldOut: 1,
        },
        advisoryReadback: {
          getStats: () => stats,
          getAdoptionRate: () => 0.6,
          getMatureLift: () => 0.2,
        },
        advisoryBus: {
          getSilencedKeys: () => [{ key: 'noisy', remaining: 3, reason: 'lift' as const }],
          getPendingWatchCount: () => 2,
        },
      } as unknown as Partial<AgentLoop>),
      session: makeSession(),
      model: 'test',
      cacheHitRate: 0,
      cost: 0,
      mcpManager: null,
      advisoryStatusNotices: ['status 通道条目 1'],
    })

    assert.equal(snap.advisory.rendered, 7)
    assert.equal(snap.advisory.heldOut, 1)
    assert.equal(snap.advisory.pendingWatch, 2)
    assert.equal(snap.advisory.silenced.length, 1)
    assert.equal(snap.advisory.silenced[0]!.reason, 'lift')
    // delivered=0 且无 shadow 的冷 key 不进 Top 行
    assert.equal(snap.advisory.keys.length, 1)
    assert.equal(snap.advisory.keys[0]!.key, 'adv-a')
    assert.equal(snap.advisory.keys[0]!.adoptionRate, 0.6)
    assert.equal(snap.advisory.keys[0]!.lift, 0.2)
    assert.deepEqual(snap.advisory.statusNotices, ['status 通道条目 1'])
    assert.equal(snap.panelStatuses.advisory, 'warn')
  })

  it('advisory 面板:agent 未接 advisory 组件时降级为零值(ok)', () => {
    const snap = buildCockpitSnapshot({
      agent: makeAgent(),
      session: makeSession(),
      model: 'test',
      cacheHitRate: 0,
      cost: 0,
      mcpManager: null,
    })
    assert.equal(snap.advisory.rendered, 0)
    assert.deepEqual(snap.advisory.keys, [])
    assert.equal(snap.panelStatuses.advisory, 'ok')
  })

  it('snapshot exposes blocking reason and next action for unverified modified files', () => {
    const snap = buildCockpitSnapshot({
      agent: makeAgent({
        getEvidenceState: () => ({
          filesRead: new Set(),
          filesModified: new Set(['src/a.ts']),
          verifications: [],
          deliveryStatus: 'unverified' as const,
          impactedFiles: new Set(),
          impactedTests: new Set(),
        }),
      }),
      session: makeSession(),
      model: 'deepseek-chat',
      cacheHitRate: 0.8,
      cost: 0,
      mcpManager: null,
    })

    assert.equal(snap.blockingReason, 'Files were modified without passing verification evidence.')
    assert.match(snap.nextAction ?? '', /Run relevant targeted tests/)
  })
})


it('buildCockpitSnapshot includes cache diagnostics, prewarm stats, and shadow next-step hit rates', () => {
  const session = new SessionContext()
  session.recordTurnCache(1, {
    input_tokens: 100,
    output_tokens: 10,
    cache_read_input_tokens: 80,
    cache_creation_input_tokens: 20,
  })
  const snapshot = buildCockpitSnapshot({
    session,
    agent: makeAgent({
      getPrewarmStats: () => ({ hits: 3, misses: 1, hitRate: 0.75 }),
      getPhysarumShadowStats: () => ({ semantic: 'next-step', total: 3, hit1: 1, hit3: 2, miss: 1, hitAt1: 1 / 3, hitAt3: 2 / 3 }),
      getCacheDiagnostic: () => 'Cache drift detected',
    } as Partial<AgentLoop>),
  })

  assert.equal(snapshot.model.perTurnHitRate, 0.8)
  assert.equal(snapshot.model.prewarmHits, 3)
  assert.equal(snapshot.model.prewarmMisses, 1)
  assert.equal(snapshot.model.prewarmHitRate, 0.75)
  assert.equal(snapshot.model.physarumShadow.total, 3)
  assert.equal(snapshot.model.physarumShadow.semantic, 'next-step')
  assert.equal(snapshot.model.physarumShadow.hitAt1, 1 / 3)
  assert.equal(snapshot.model.physarumShadow.hitAt3, 2 / 3)
  assert.equal(snapshot.model.physarumShadow.miss, 1)
  assert.equal(snapshot.model.cacheDiagnostic, 'Cache drift detected')
})

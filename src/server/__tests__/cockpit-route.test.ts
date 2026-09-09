/**
 * GET /sessions/:id/cockpit smoke test — covers the desktop cockpit backend.
 *
 * Verifies the route delegates to ManagedAgent.getCockpitSnapshot and returns
 * the assembled snapshot (safety/verify/context/model + panelStatuses). The
 * agent is a fake returning a fixed fixture, so this tests the route wiring +
 * auth + 404/503 paths, not buildCockpitSnapshot itself (that has its own
 * coverage via the TUI tests in src/tui/cockpit/__tests__/).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRouter } from '../index.js'
import { buildSessionRoutes } from '../session-routes.js'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'
import type { CockpitSnapshot } from '../../tui/cockpit/types.js'

const TOKEN = 'cockpit-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

/** Fixed snapshot fixture — minimal but covers all 5 tabs the desktop renders. */
const FIXTURE_SNAPSHOT: CockpitSnapshot = {
  intent: null,
  blockingReason: null,
  nextAction: null,
  safety: {
    doomLoopLevel: 'none',
    riskLevel: 'low',
    riskReasons: ['tool diversity low'],
    suggestedAction: 'continue',
    recentFingerprints: 3,
  },
  verification: {
    filesRead: 5,
    filesModified: 2,
    runs: [{ tool: 'run_tests', status: 'passed', summary: '3 passed' }],
    deliveryStatus: 'unverified',
    impactedFiles: 2,
    impactedTests: 3,
  },
  trace: { events: [], totalEvents: 0 },
  context: {
    estimatedTokens: 12000,
    maxTokens: 128000,
    rounds: 4,
    compactionState: 'stable',
    brokenRounds: 0,
    layers: [],
    claimCounts: { active: 0, stale: 0, conflicted: 0, durable: 0, durableCandidate: 0, quarantined: 0, recallBlocked: 0 },
  },
  model: {
    name: 'test-model',
    cacheHitRate: 0.92,
    inputTokens: 100000,
    outputTokens: 5000,
    cacheReadTokens: 90000,
    cacheWriteTokens: 5000,
    cost: 0.42,
    perTurnHitRate: 0.95,
    recentTurnHitRate: 0.93,
    prewarmHits: 10,
    prewarmMisses: 2,
    prewarmHitRate: 0.83,
    physarumShadow: { hits: 0, misses: 0, hitRate: 0 } as never,
    speculation: null,
    cacheDiagnostic: null,
    reasoningEffort: 'medium',
    starDomain: 'Auto(天枢)',
  },
  mcp: { servers: [], totalTools: 0, connectedServers: 0 },
  advisory: {
    rendered: 0, dropped: 0, adopted: 0, ignored: 0, heldOut: 0,
    silenced: [], pendingWatch: 0, keys: [], statusNotices: [],
  },
  panelStatuses: { summary: 'ok', safety: 'ok', verify: 'ok', context: 'ok', model: 'ok', trace: 'idle', mcp: 'idle', advisory: 'idle' },
}

class CockpitFakeAgent implements ManagedAgent {
  snapshot: CockpitSnapshot | null = FIXTURE_SNAPSHOT
  run(_p: string, _cb: AgentCallbacks): Promise<void> { return Promise.resolve() }
  abort(): void {}
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(): void {}
  rewindToMessages(): void {}
  getCockpitSnapshot(): CockpitSnapshot | null { return this.snapshot }
}

function setup(snapshot: CockpitSnapshot | null = FIXTURE_SNAPSHOT) {
  const manager = new RuntimeSessionManager({
    createAgent: () => {
      const a = new CockpitFakeAgent()
      a.snapshot = snapshot
      return a
    },
    defaultCwd: '/tmp',
  })
  const router = createRouter(buildSessionRoutes(manager, TOKEN))
  return { manager, router }
}

describe('GET /sessions/:id/cockpit', () => {
  it('returns the assembled snapshot when the agent is built', async () => {
    const { manager, router } = setup()
    const s = manager.createSession({})
    void manager.run(s.id, 'go') // trigger agent build
    await new Promise((r) => setImmediate(r)) // let the build resolve

    const res = await router('GET', `/sessions/${s.id}/cockpit`, {}, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as CockpitSnapshot
    // 5 tabs the desktop renders each have their key fields.
    assert.equal(body.safety.riskLevel, 'low')
    assert.equal(body.verification.filesModified, 2)
    assert.equal(body.model.cacheHitRate, 0.92)
    assert.equal(body.context?.estimatedTokens, 12000)
    assert.equal(body.panelStatuses.summary, 'ok')
  })

  it('returns 503 when getCockpitSnapshot returns null (agent mid-rebuild)', async () => {
    const { manager, router } = setup(null)
    const s = manager.createSession({})
    void manager.run(s.id, 'go')
    await new Promise((r) => setImmediate(r))

    const res = await router('GET', `/sessions/${s.id}/cockpit`, {}, AUTH)
    assert.equal(res.status, 503)
  })

  it('returns 404 when the session has no agent built yet', async () => {
    const { manager, router } = setup()
    const s = manager.createSession({})
    // No run() → agent not built → getAgentForSession returns undefined.
    const res = await router('GET', `/sessions/${s.id}/cockpit`, {}, AUTH)
    assert.equal(res.status, 404)
  })

  it('returns 404 for an unknown session id', async () => {
    const { router } = setup()
    const res = await router('GET', '/sessions/nonexistent/cockpit', {}, AUTH)
    assert.equal(res.status, 404)
  })

  it('rejects unauthorized requests', async () => {
    const { router } = setup()
    const res = await router('GET', '/sessions/whatever/cockpit', {}, {})
    assert.equal(res.status, 401)
  })
})

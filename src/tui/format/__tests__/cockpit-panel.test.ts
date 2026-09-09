import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderCockpit } from '../cockpit.js'
import type { CockpitSnapshot, Panel } from '../../cockpit/types.js'
import { PANEL_LABELS } from '../../cockpit/types.js'
import { getTheme } from '../../theme.js'

const theme = getTheme()

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

function fixture(): CockpitSnapshot {
  return {
    intent: 'do thing',
    blockingReason: null,
    nextAction: null,
    safety: { doomLoopLevel: 'none', riskLevel: 'low', riskReasons: [], suggestedAction: 'SAFE-ACTION', recentFingerprints: 0 },
    verification: { filesRead: 1, filesModified: 2, runs: [], deliveryStatus: 'verified', impactedFiles: 0, impactedTests: 0 },
    trace: { events: [{ id: 'e1', turn: 1, kind: 'tool', name: 'read', status: 'completed', durationMs: 5 }], totalEvents: 1 },
    context: { estimatedTokens: 100, maxTokens: 1000, rounds: 2, compactionState: 'ok', brokenRounds: 0, layers: [], claimCounts: {} as never },
    model: {
      name: 'MODEL-X', cacheHitRate: 0.5, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
      cost: 0.01, perTurnHitRate: null, recentTurnHitRate: null, prewarmHits: 0, prewarmMisses: 0, prewarmHitRate: 0,
      physarumShadow: {} as never, speculation: null, cacheDiagnostic: null, reasoningEffort: 'medium', starDomain: 'Auto(天枢)',
    },
    mcp: { servers: [{ serverId: 'SRV-A', status: 'connected', toolCount: 3 }], totalTools: 3, connectedServers: 1 },
    advisory: {
      rendered: 4, dropped: 1, adopted: 2, ignored: 1, heldOut: 1,
      silenced: [{ key: 'NOISY-KEY', remaining: 3, reason: 'lift' }],
      pendingWatch: 1,
      keys: [{ key: 'ADV-KEY', delivered: 3, adopted: 2, ignored: 1, ignoredStreak: 0, adoptionRate: 0.66, lift: 0.25 }],
      statusNotices: ['STATUS-NOTICE-1'],
    },
    panelStatuses: { summary: 'ok', trace: 'ok', verify: 'ok', context: 'ok', safety: 'ok', model: 'ok', mcp: 'ok', advisory: 'warn' },
  }
}

describe('renderCockpit panel focus (G4)', () => {
  it('summary 显示全部面板节', () => {
    const lines = renderCockpit(fixture(), 80, 30, theme, 'summary')
    const text = lines.map(stripAnsi).join('\n')
    assert.ok(text.includes('Safety'))
    assert.ok(text.includes('Verify'))
    assert.ok(text.includes('Model'))
    assert.ok(text.includes('MODEL-X'))
  })

  it('指定单面板仅显示该节（聚焦视图）', () => {
    const lines = renderCockpit(fixture(), 80, 30, theme, 'safety')
    const text = lines.map(stripAnsi).join('\n')
    assert.ok(text.includes('SAFE-ACTION'), 'safety 节存在')
    assert.ok(!text.includes('MODEL-X'), 'model 节被隐藏')
  })

  it('panel rail 高亮当前面板', () => {
    const panel: Panel = 'model'
    const lines = renderCockpit(fixture(), 80, 30, theme, panel)
    const text = lines.map(stripAnsi).join('\n')
    // 当前面板用 [Label] 方括号包裹
    assert.ok(text.includes(`[${PANEL_LABELS[panel]}]`), 'rail 高亮当前面板')
  })

  it('advisory 聚焦视图展开 per-key 效能与 status 通道', () => {
    const lines = renderCockpit(fixture(), 80, 30, theme, 'advisory')
    const text = lines.map(stripAnsi).join('\n')
    assert.ok(text.includes('Advisory'), 'advisory 节存在')
    assert.ok(text.includes('heldOut:1'), '账本累计含 heldOut')
    assert.ok(text.includes('NOISY-KEY(lift:3)'), '静音 key 带原因与剩余周期')
    assert.ok(text.includes('ADV-KEY'), 'per-key Top 行')
    assert.ok(text.includes('lift:+0.25'), 'per-key lift')
    assert.ok(text.includes('STATUS-NOTICE-1'), 'status 通道最近条目')
    assert.ok(!text.includes('MODEL-X'), '其他节被隐藏')
  })

  it('summary 视图只给 advisory 一行概览,不展开 per-key', () => {
    const lines = renderCockpit(fixture(), 80, 30, theme, 'summary')
    const text = lines.map(stripAnsi).join('\n')
    assert.ok(text.includes('Advisory'), 'advisory 概览行存在')
    assert.ok(!text.includes('ADV-KEY'), 'per-key 不在 summary 展开')
  })

  it('footer 在单面板模式提示回到 summary', () => {
    const lines = renderCockpit(fixture(), 80, 30, theme, 'trace')
    const text = lines.map(stripAnsi).join('\n')
    assert.ok(text.includes('summary'), 'footer 引导 /cockpit summary')
  })
})

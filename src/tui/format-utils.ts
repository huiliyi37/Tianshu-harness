import type { SummaryState } from './summary-state.js'
import { basenamePortable } from '../utils/safe-path.js'

export function truncate(s: string, max: number): string {
  if (max <= 0) return ''
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

export function formatElapsed(ms: number): string {
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}m${s > 0 ? `${s}s` : ''}`
}

// Braille sparkline: renders values 0-1 as braille dot columns
// Each braille char encodes a 2-wide x 4-tall dot grid
export function brailleSparkline(values: number[]): string {
  if (values.length === 0) return ''

  const BRAILLE_BASE = 0x2800
  // Standard braille encoding: bits 0-3 = left column (dot 1-4, bottom→top), bits 4-7 = right column (dot 5-8, bottom→top)
  const leftDots = [0, 1, 2, 3]
  const rightDots = [4, 5, 6, 7]

  const chars: string[] = []
  for (let i = 0; i < values.length; i += 2) {
    let pattern = 0
    const lv = Math.max(0, Math.min(1, values[i] ?? 0))
    const lLevel = Math.round(lv * 3)
    for (let d = 0; d <= lLevel; d++) {
      pattern |= 1 << leftDots[d]!
    }
    const rv = Math.max(0, Math.min(1, values[i + 1] ?? values[i] ?? 0))
    const rLevel = Math.round(rv * 3)
    for (let d = 0; d <= rLevel; d++) {
      pattern |= 1 << rightDots[d]!
    }
    chars.push(String.fromCodePoint(BRAILLE_BASE + pattern))
  }
  return chars.join('')
}

export function contextBar(pct: number, width = 5): string {
  const clamped = Math.max(0, Math.min(1, pct))
  const filled = Math.round(clamped * width)
  return '▓'.repeat(filled) + '░'.repeat(width - filled)
}

const HEARTBEAT_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function formatSummaryLine1(state: SummaryState, heartbeatFrame: number): string {
  const elapsed = formatElapsed(state.elapsedMs)
  const spinner = HEARTBEAT_FRAMES[heartbeatFrame % HEARTBEAT_FRAMES.length]!
  const turn = state.turnCount && state.maxTurns ? `T${state.turnCount}/${state.maxTurns}` : ''
  const steps = state.totalSteps > 0 ? `${state.stepCount}/${state.totalSteps}` : ''

  if (state.starPhaseGlyph || state.starPhaseLabel) {
    const glyph = state.starPhaseGlyph ?? ''
    const label = state.starPhaseLabel ?? ''
    const phaseDisplay = [glyph, label].filter(Boolean).join(' ')

    const segments: string[] = [phaseDisplay]
    if (steps) segments.push(steps)
    if (turn) segments.push(turn)

    if (state.alchemyConfidence !== undefined) {
      segments.push('')
    } else {
      segments.push(`${contextBar(state.contextPct)} ${Math.round(state.contextPct * 100)}%`)
    }

    if (state.recentToolSummary && state.recentToolSummary.length > 0) {
      segments.push(state.recentToolSummary.join(' → '))
    }

    segments.push(elapsed)
    return `${spinner} ${segments.join(' │ ')}`
  }

  const task = truncate(state.task || 'working', 30)
  const phase = state.phase
  const pct = Math.round(state.contextPct * 100)
  return `${spinner} ${task} → ${phase}${steps ? ` (${steps})` : ''}${turn ? ` ${turn}` : ''} │ ${contextBar(state.contextPct)} ${pct}% │ ${elapsed}`
}

export function formatSummaryLine2(state: SummaryState): string {
  if (state.phaseDurationMs !== undefined && state.phaseDurationMs > 0) {
    return `├ ${state.phase}… ${formatElapsed(state.phaseDurationMs)}`
  }
  if (!state.lastAction) return '├ waiting for first action...'
  const icon = state.lastAction.success ? '✓' : '✗'
  const target = truncate(basenamePortable(state.lastAction.target), 30)
  return `├ last: ${state.lastAction.tool} ${target} → ${icon}`
}

export function formatSummaryLine3(state: SummaryState): string {
  if (state.approvalNeeded) return `└ ⚠ APPROVAL: ${state.approvalNeeded.tool} ${truncate(state.approvalNeeded.target, 25)}`
  if (state.compactEvent) {
    const before = Math.round(state.compactEvent.beforeTokens / 1000)
    const after = Math.round(state.compactEvent.afterTokens / 1000)
    return `└ ⚡ compact: ${before}k→${after}k`
  }
  return `└ step ${state.stepCount} │ risk: ${state.risk}`
}

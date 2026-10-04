import type { VerificationMetadata } from '../tools/types.js'
import { buildDeliveryGate } from './delivery-gate.js'
import { inferBashVerificationScope } from './bash-verification.js'

// wire 侧类型已抽至 evidence-types.ts（叶子，桌面端经 server/ui-shared 共享）；
// 此处 re-export 保持内核调用方不变。
export type { DeliveryVerificationStatus, EvidenceSummary } from './evidence-types.js'
import type { DeliveryVerificationStatus, EvidenceSummary } from './evidence-types.js'

export type VerificationLevel = 'tested' | 'typed' | 'linted' | 'pending'

/**
 * Gate state for the TDD gate. Consumed by evaluateTddGate to decide whether
 * an edit should be allowed, suggested-against, or blocked.
 */
export interface TddGateState {
  /** Count of distinct files modified by edit/write tools since last reset. */
  filesModified: number
  /** Number of test-command verifications recorded since last reset. */
  verifications: number
  /** Edits since the most recent test run (resets to 0 on any trackVerification). */
  editsSinceLastTest: number
  /** Whether any verification ended in failure. */
  hasFailedTests: boolean
  /** Whether any of the modified files is a code file (vs. docs/config only).
   *  When false, the TDD gate skips entirely — no constraint on doc-only edits. */
  hasCodeEdits: boolean
  /** Whether the agent has read any test files (.test./.spec./__tests__).
   *  Used by skipIfNoTests: if no test files exist in the project, don't block. */
  hasReadTestFiles: boolean
}

export interface EvidenceState {
  filesRead: Set<string>
  filesModified: Set<string>
  verifications: VerificationMetadata[]
  deliveryStatus: DeliveryVerificationStatus
  impactedFiles: Set<string>
  impactedTests: Set<string>
  fileVerificationLevels?: Map<string, VerificationLevel>
}

export interface VerificationSummary {
  total: number
  verified: number
  pending: number
  files: Array<{ path: string; level: VerificationLevel }>
}

const MAX_VERIFICATIONS = 50

/** Code file extensions whose edits should count toward the TDD gate.
 *  Config files (.yml/.yaml/.toml/.json/.ini/.env) are excluded — they don't
 *  need test coverage and counting them caused false gate triggers. */
const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rs', '.go', '.java', '.kt', '.scala',
  '.c', '.cpp', '.cc', '.h', '.hpp',
  '.rb', '.swift', '.vue', '.svelte',
  '.sh', '.bash', '.zsh',
  '.sql', '.graphql',
  '.css', '.scss', '.less',
])

function isCodeFile(path: string): boolean {
  const ext = path.slice(path.lastIndexOf('.'))
  return CODE_EXTENSIONS.has(ext)
}

/** `.rivet/scratch/` 下的文件是一次性行为探针（微探针纪律），不计入 TDD gate。
 *  与 reliability-mode.ts 的 scratch self-rescue 白名单同一路径约定。 */
export function isScratchPath(path: string): boolean {
  return /(?:^|[/\\])\.rivet[/\\]scratch(?:[/\\]|$)/.test(path)
}

export interface EvidenceTrackerPublic {
  trackFileRead(path: string): void
  trackFileModified(path: string): void
  trackImpact(files: string[], tests: string[]): void
  trackVerification(result: VerificationMetadata): void
  getState(): EvidenceState
  getVerificationSummary(): VerificationSummary
  getGateState(): TddGateState
  buildSummary(gateV2?: AuthoritativeGateView): EvidenceSummary
  reset(): void
}

/** Track 3: 权威门禁视图（delivery-gate-v2 的最小投影）。注入时 summary 的
 *  门禁字段以 v2 GREEN/YELLOW/RED 为准，替代 v1 的 EvidenceState 推导。 */
export interface AuthoritativeGateView {
  state: 'GREEN' | 'YELLOW' | 'RED'
  reason?: string
  blockingReason?: string
  shortestNextStep?: string
}

export class EvidenceTracker implements EvidenceTrackerPublic {
  private state: EvidenceState
  /**
   * Consecutive edits since the most recent test run. Incremented on every
   * trackFileModified of a code file; skipped for docs/config/etc.
   * Reset to 0 on trackVerification. Drives the TDD gate (evaluateTddGate) —
   * after 3 unverified edits, the gate hard-blocks.
   */
  #editsSinceLastTest = 0
  /** Whether any modified file is a code file (vs. docs/config only). */
  #hasCodeEdits = false
  /** Obligation reducer 的验证事件出口：每次 trackVerification 后收到同一份
   *  VerificationMetadata。义务状态独立于 TDD 编辑计数——计数清零（任意状态
   *  的验证都会清）不会清除义务；blocked 验证在 reducer 侧只记 attempted。 */
  #verificationListener: ((result: VerificationMetadata) => void) | null = null

  constructor() {
    this.state = {
      filesRead: new Set(),
      filesModified: new Set(),
      verifications: [],
      deliveryStatus: 'unverified',
      impactedFiles: new Set(),
      impactedTests: new Set(),
      fileVerificationLevels: new Map(),
    }
  }

  trackFileRead(path: string): void {
    this.state.filesRead.add(path)
  }

  trackFileModified(path: string): void {
    this.state.filesModified.add(path)
    this.state.fileVerificationLevels?.set(path, 'pending')
    // Only code-file edits drive the TDD gate counter. Docs, configs, plans,
    // and other non-code files are excluded so the gate doesn't block pure
    // documentation work (which has no tests to run).
    // Scratch probes (.rivet/scratch/) are also excluded: they are throwaway
    // behavior-verification scripts, not deliverable edits — counting them
    // would let the RED gate punish the probe discipline it should encourage.
    if (isCodeFile(path) && !isScratchPath(path)) {
      this.#editsSinceLastTest++
      this.#hasCodeEdits = true
    }
    this.refreshDeliveryStatus()
  }

  trackVerification(result: VerificationMetadata): void {
    this.state.verifications.push(result)
    if (this.state.verifications.length > MAX_VERIFICATIONS) {
      this.state.verifications = this.state.verifications.slice(-MAX_VERIFICATIONS)
    }
    // TDD gate: any test run (pass, fail, or blocked) resets the consecutive-edit counter.
    // The gate targets zero-verification editing, not test-pass enforcement.
    this.#editsSinceLastTest = 0
    this.applyVerificationLevels(result)
    this.refreshDeliveryStatus()
    try {
      this.#verificationListener?.(result)
    } catch { /* obligation accounting must never break evidence tracking */ }
  }

  /** 注册验证事件监听（obligation reducer 接线点）。单监听即可——义务 store
   *  与 tracker 同寿命，由 loop 持有。 */
  setVerificationListener(listener: ((result: VerificationMetadata) => void) | null): void {
    this.#verificationListener = listener
  }

  trackImpact(files: string[], tests: string[]): void {
    for (const f of files) this.state.impactedFiles.add(f)
    for (const t of tests) this.state.impactedTests.add(t)
  }

  getVerificationSummary(): VerificationSummary {
    const files = [...this.state.filesModified]
      .sort((a, b) => a.localeCompare(b))
      .map(path => ({ path, level: this.state.fileVerificationLevels?.get(path) ?? 'pending' }))
    const verified = files.filter(f => f.level !== 'pending').length
    return { total: files.length, verified, pending: files.length - verified, files }
  }

  /**
   * 验证债判据（单一口径，2026-07-25 advisory-ecology W3）：验证实际失败过，
   * 或未验证编辑积累到 TDD gate 硬闸阈值（3）。不用「存在任何未验证编辑」——
   * 正常的编辑→验证节奏会瞬时经过该状态。cognitive frame 与 self-verify
   * 债龄计数共用本方法，避免两处判据漂移。
   */
  hasVerificationDebt(): boolean {
    return this.state.deliveryStatus === 'failed' || this.#editsSinceLastTest >= 3
  }

  /**
   * 交付就绪判据（2026-07-25，YOLO 证据门专用）：最近一条验证 passed 且绿后
   * 没再动过代码。与 deliveryStatus 的全窗口口径刻意不同——那个口径对「先红
   * 后绿」的正常 TDD 节奏是粘滞的（近两天 12 会话回放：80 个绿灯时刻 91% 被
   * 窗口内历史 failed 挡住），反向又在绿后编辑期（均值 6.2 次编辑）虚开。
   * 本判据两个粘滞都治：红→绿即就绪；绿后首次代码编辑即失效。
   * deliveryStatus 语义不动——它还有 hasVerificationDebt / delivery gate
   * 等消费者，粘滞 failed 在那些场景是刻意的保守。
   */
  deliveryReady(): boolean {
    return this.state.verifications.at(-1)?.status === 'passed' && this.#editsSinceLastTest === 0
  }

  /** Gate state for the TDD gate — pure-values snapshot, no Set refs. */
  getGateState(): TddGateState {
    return {
      filesModified: this.state.filesModified.size,
      verifications: this.state.verifications.length,
      editsSinceLastTest: this.#editsSinceLastTest,
      hasFailedTests: this.state.verifications.some(v => v.status === 'failed'),
      hasCodeEdits: this.#hasCodeEdits,
      hasReadTestFiles: [...this.state.filesRead].some(p => /\.test\.|\.spec\.|__tests__|_test\.|test_/.test(p)),
    }
  }

  private applyVerificationLevels(result: VerificationMetadata): void {
    if (result.status !== 'passed') return
    const level = this.inferVerificationLevel(result.command)
    const targets = this.inferVerifiedFiles(result, level)
    for (const file of targets) {
      if (this.state.filesModified.has(file)) {
        this.state.fileVerificationLevels?.set(file, level)
      }
    }
  }

  private inferVerificationLevel(command: string): VerificationLevel {
    if (/\btsc\b|typecheck|--noEmit/.test(command)) return 'typed'
    if (/\blint\b|eslint/.test(command)) return 'linted'
    return 'tested'
  }

  private inferVerifiedFiles(result: VerificationMetadata, level: VerificationLevel): string[] {
    const modified = [...this.state.filesModified]
    if (result.scope === 'full') return level === 'typed' ? modified.filter(f => /\.tsx?$/.test(f)) : modified
    const targets = result.targetFiles ?? inferBashVerificationScope(result.command).targetFiles ?? []
    const normalize = (path: string) => path.replaceAll('\\', '/').replace(/^\.\//, '')
    const normalizedTargets = targets.flatMap(target => {
      const normalized = normalize(target)
      const source = normalized.replace(/\/(?:__tests__|tests)\//g, '/').replace(/\.(?:test|spec)(?=\.[^/]+$)/, '')
      return [normalized, source]
    })
    return modified.filter(file => {
      const normalizedFile = normalize(file)
      return normalizedTargets.some(target => target === normalizedFile || target.endsWith('/' + normalizedFile))
    })
  }

  private refreshDeliveryStatus(): void {
    if (this.state.verifications.some(r => r.status === 'failed')) {
      this.state.deliveryStatus = 'failed'
    } else if (this.state.verifications.some(r => r.status === 'blocked')) {
      this.state.deliveryStatus = 'blocked'
    } else if (this.state.filesModified.size > 0 && this.state.verifications.length === 0) {
      this.state.deliveryStatus = 'unverified'
    } else if (this.state.verifications.some(r => r.status === 'passed')) {
      this.state.deliveryStatus = 'verified'
    } else {
      this.state.deliveryStatus = 'unverified'
    }
  }

  buildSummary(gateV2?: AuthoritativeGateView): EvidenceSummary {
    const read = [...this.state.filesRead].sort()
    const modified = [...this.state.filesModified].sort()

    let gateState: EvidenceSummary['gate']['state']
    let gateLabel: string
    let gateReason: string | undefined
    let gateBlockingReason: string | undefined
    let gateNextAction: string | undefined

    if (gateV2) {
      gateState = gateV2.state
      gateLabel = gateV2.state
      gateReason = gateV2.reason
      gateBlockingReason = gateV2.blockingReason
      gateNextAction = gateV2.shortestNextStep
    } else {
      const gate = buildDeliveryGate(this.state)
      gateState = gate.severity
      gateLabel = gate.message
      gateBlockingReason = gate.blockingReason
      gateNextAction = gate.nextAction
    }

    return {
      filesRead: read,
      filesModified: modified,
      verificationStatus: this.state.deliveryStatus,
      verifications: [...this.state.verifications],
      gate: {
        state: gateState,
        label: gateLabel,
        reason: gateReason,
        blockingReason: gateBlockingReason,
        nextAction: gateNextAction,
      },
      impactedFiles: [...this.state.impactedFiles].sort(),
      impactedTests: [...this.state.impactedTests].sort(),
    }
  }

  reset(): void {
    this.state.filesRead.clear()
    this.state.filesModified.clear()
    this.state.verifications = []
    this.state.deliveryStatus = 'unverified'
    this.state.impactedFiles.clear()
    this.state.impactedTests.clear()
    this.state.fileVerificationLevels?.clear()
    this.#editsSinceLastTest = 0
    this.#hasCodeEdits = false
  }

  getState(): EvidenceState { return this.state }
}

/**
 * Physarum Topology Engine
 *
 * Manages adaptive edge evolution using Physarum conductance equations.
 * Integrates with MeridianDb for persistence.
 */

import type { MeridianDb } from './meridian-db.js'
import type {
  PhysarumEdgeState, PhysarumConfig, PhysarumStats,
  Criticality, AvalancheStats, PhysarumPredictionObservation,
} from './physarum-types.js'
import { DEFAULT_PHYSARUM_CONFIG } from './physarum-types.js'
import { aggregatePhysarumPredictionObservations } from './physarum-shadow-stats.js'
import type { PhysarumShadowStats } from './physarum-shadow-stats.js'

export interface PhysarumLoadStats {
  loaded: number
  discarded: number
  discardedSamples: Array<{ fileA: string; fileB: string }>
}

const PHYSARUM_INDEXABLE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go'] as const
const PHYSARUM_IGNORED_SEGMENTS = new Set(['node_modules', 'dist', '.git', '.rivet'])

export function isIndexablePhysarumFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/')) return false

  const segments = normalized.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return false
  if (segments.some(segment => PHYSARUM_IGNORED_SEGMENTS.has(segment))) return false

  return PHYSARUM_INDEXABLE_EXTENSIONS.some(ext => normalized.endsWith(ext))
}

function isLoadablePhysarumEdge(edge: Pick<PhysarumEdgeState, 'fileA' | 'fileB'>): boolean {
  return edge.fileA !== edge.fileB
    && isIndexablePhysarumFile(edge.fileA)
    && isIndexablePhysarumFile(edge.fileB)
}

export class PhysarumEngine {
  private edges = new Map<string, PhysarumEdgeState>()
  private frozen = new Set<string>() // quarantined nodes
  private avalanches: AvalancheStats = { sizes: [], lastCheckedTurn: 0 }
  private turnPruneHistory: number[] = []
  private turnGrowthHistory: number[] = []
  private currentTurn = 0
  private lastFileAccess: { filePath: string; turn: number } | null = null
  /** Recent distinct file accesses (most recent last) — working set for structural epistemic. */
  private recentAccess: string[] = []
  private pendingPrediction: {
    sourceFile: string
    predictedAtTurn: number
    predictions: Array<{ file: string; score: number }>
  } | null = null
  private predictionObservations: PhysarumPredictionObservation[] = []
  private lastLoadStats: PhysarumLoadStats = { loaded: 0, discarded: 0, discardedSamples: [] }

  constructor(
    private db: MeridianDb | undefined,
    private config: PhysarumConfig = DEFAULT_PHYSARUM_CONFIG,
  ) {}

  private edgeKey(a: string, b: string): string {
    return a < b ? `${a}|${b}` : `${b}|${a}`
  }

  /** Record a canonical file access and learn the previous→current sequence. */
  recordFileAccess(filePath: string, turn: number): void {
    if (!isIndexablePhysarumFile(filePath)) return

    this.currentTurn = turn
    this.observePrediction(filePath, turn)

    const existing = this.recentAccess.indexOf(filePath)
    if (existing >= 0) this.recentAccess.splice(existing, 1)
    this.recentAccess.push(filePath)
    if (this.recentAccess.length > 8) this.recentAccess.shift()

    const previous = this.lastFileAccess
    this.lastFileAccess = { filePath, turn }

    if (!previous || previous.filePath === filePath) {
      this.startShadowPrediction(filePath, turn)
      return
    }

    const dtTurns = Math.max(1, turn - previous.turn)
    if (dtTurns > this.config.stdpWindow) {
      this.startShadowPrediction(filePath, turn)
      return
    }

    this.recordFlow(previous.filePath, filePath, turn)
    this.recordSequentialEdit(previous.filePath, filePath, dtTurns)
    this.startShadowPrediction(filePath, turn)
  }

  private startShadowPrediction(filePath: string, turn: number): void {
    const predictions = this.predictNext(filePath, 3)
    if (predictions.length === 0) {
      this.pendingPrediction = null
      return
    }
    this.pendingPrediction = { sourceFile: filePath, predictedAtTurn: turn, predictions }
  }

  private observePrediction(observedFile: string, observedAtTurn: number): void {
    const pending = this.pendingPrediction
    if (!pending || pending.sourceFile === observedFile) return

    const hitIndex = pending.predictions.findIndex(p => p.file === observedFile)
    const observation: PhysarumPredictionObservation = {
      sourceFile: pending.sourceFile,
      predictedAtTurn: pending.predictedAtTurn,
      predictions: pending.predictions,
      observedFile,
      observedAtTurn,
      hitRank: hitIndex >= 0 ? hitIndex + 1 : null,
      leadTurns: Math.max(1, observedAtTurn - pending.predictedAtTurn),
    }
    this.predictionObservations.push(observation)
    if (this.predictionObservations.length > 100) this.predictionObservations.shift()
    if (this.db?.recordPhysarumPredictionObservation) {
      try { this.db.recordPhysarumPredictionObservation(observation) } catch { /* shadow telemetry only */ }
    }
  }

  getPredictionObservations(): PhysarumPredictionObservation[] {
    return [...this.predictionObservations]
  }

  getShadowStats(): PhysarumShadowStats {
    return aggregatePhysarumPredictionObservations(this.predictionObservations)
  }

  /** Record flow on an edge (called on file access/co-edit) */
  recordFlow(fileA: string, fileB: string, turn: number): void {
    this.currentTurn = turn
    const key = this.edgeKey(fileA, fileB)
    let edge = this.edges.get(key)
    if (!edge) {
      edge = {
        fileA: fileA < fileB ? fileA : fileB,
        fileB: fileA < fileB ? fileB : fileA,
        weight: 1.0, flow: 0, consolidated: false,
        activationCount: 0, lastActivatedTurn: turn, direction: 0,
      }
      this.edges.set(key, edge)
    }
    edge.flow++
    edge.activationCount++
    edge.lastActivatedTurn = turn

    // Hot path: immediate weight evolution
    this.evolveEdge(edge, turn)
  }

  /** STDP directional update */
  recordSequentialEdit(first: string, second: string, dtTurns: number): void {
    if (dtTurns <= 0 || dtTurns > this.config.stdpWindow) return
    const key = this.edgeKey(first, second)
    const edge = this.edges.get(key)
    if (!edge) return

    const delta = this.config.stdpPlus * Math.exp(-dtTurns / this.config.stdpWindow)
    // Direction: positive means first→second is the natural flow
    if (first < second) {
      edge.direction = Math.min(1, edge.direction + delta)
    } else {
      edge.direction = Math.max(-1, edge.direction - delta)
    }
  }

  /** Evolve a single edge (Physarum conductance equation) */
  private evolveEdge(edge: PhysarumEdgeState, turn: number): void {
    if (this.frozen.has(edge.fileA) || this.frozen.has(edge.fileB)) return

    // Growth: f(flow) = growthRate * flow^gamma
    const growth = this.config.growthRate * Math.pow(Math.max(edge.flow, 0), this.config.gamma)

    // Decay: exponential based on time since last activation
    const dt = turn - edge.lastActivatedTurn
    const tau = edge.consolidated ? this.config.tauLong : this.config.tauShort
    const decay = dt > 0 ? edge.weight * (1 - Math.exp(-dt / tau)) : 0

    edge.weight = Math.max(0, edge.weight + growth - decay)

    // Consolidation check (LTP → L-LTP)
    if (!edge.consolidated && edge.activationCount >= this.config.consolidationThreshold) {
      edge.consolidated = true
    }
  }

  /** Cold path: batch decay + prune all edges (call every N turns) */
  batchEvolve(turn: number): number {
    this.currentTurn = turn
    let pruned = 0

    for (const [key, edge] of this.edges) {
      this.evolveEdge(edge, turn)

      // Prune unconsolidated edges below threshold
      if (edge.weight < this.config.pruneThreshold && !edge.consolidated) {
        this.edges.delete(key)
        pruned++
      }

      // Reset flow counter for next window
      edge.flow = 0
    }

    // Homeostatic scaling per node
    this.applyHomeostaticScaling()

    this.turnPruneHistory.push(pruned)
    if (this.turnPruneHistory.length > 20) this.turnPruneHistory.shift()

    return pruned
  }

  /** Homeostatic scaling: cap total outgoing weight per node */
  private applyHomeostaticScaling(): void {
    const nodeWeights = new Map<string, number>()

    for (const edge of this.edges.values()) {
      nodeWeights.set(edge.fileA, (nodeWeights.get(edge.fileA) ?? 0) + edge.weight)
      nodeWeights.set(edge.fileB, (nodeWeights.get(edge.fileB) ?? 0) + edge.weight)
    }

    const scales = new Map<string, { scale: number; order: number }>()
    for (const [node, total] of nodeWeights) {
      if (total <= this.config.synapticBudget) continue
      scales.set(node, { scale: this.config.synapticBudget / total, order: scales.size })
    }
    if (scales.size === 0) return

    // Each edge has at most two factors. Preserve the previous node order,
    // including floating-point rounding and scaling a self-edge only once.
    for (const edge of this.edges.values()) {
      const a = scales.get(edge.fileA)
      const b = scales.get(edge.fileB)
      if (a && b && b.order < a.order) {
        edge.weight *= b.scale
        edge.weight *= a.scale
      } else {
        if (a) edge.weight *= a.scale
        if (b && b !== a) edge.weight *= b.scale
      }
    }
  }

  /** Ubiquity penalty: penalize nodes connected to too many others */
  applyUbiquityPenalty(): void {
    const totalNodes = new Set<string>()
    const nodeConnections = new Map<string, number>()

    for (const edge of this.edges.values()) {
      totalNodes.add(edge.fileA)
      totalNodes.add(edge.fileB)
      nodeConnections.set(edge.fileA, (nodeConnections.get(edge.fileA) ?? 0) + 1)
      nodeConnections.set(edge.fileB, (nodeConnections.get(edge.fileB) ?? 0) + 1)
    }

    const n = totalNodes.size
    if (n === 0) return

    for (const [node, connections] of nodeConnections) {
      const ratio = connections / n
      if (ratio <= this.config.ubiquityThreshold) continue
      const penalty = 1 / (1 + Math.log(ratio / this.config.ubiquityThreshold))
      for (const edge of this.edges.values()) {
        if (edge.fileA === node || edge.fileB === node) {
          edge.weight *= penalty
        }
      }
    }
  }

  /** Record spreading activation avalanche size for SOC monitoring */
  recordAvalanche(size: number, turn: number): void {
    this.avalanches.sizes.push(size)
    if (this.avalanches.sizes.length > 100) this.avalanches.sizes.shift()
    this.avalanches.lastCheckedTurn = turn
  }

  /** Check SOC criticality from avalanche distribution */
  getCriticality(): Criticality {
    if (this.avalanches.sizes.length < 10) return 'critical' // not enough data
    const sorted = [...this.avalanches.sizes].sort((a, b) => b - a)
    const median = sorted[Math.floor(sorted.length / 2)]!
    const max = sorted[0]!
    // Simple heuristic: if max >> median, supercritical; if max ≈ median, subcritical
    const ratio = max / Math.max(median, 1)
    if (ratio > 10) return 'supercritical'
    if (ratio < 2) return 'subcritical'
    return 'critical'
  }

  /** Get current stats for anomaly detection */
  getStats(): PhysarumStats {
    const avgPrune = this.turnPruneHistory.length > 0
      ? this.turnPruneHistory.reduce((a, b) => a + b, 0) / this.turnPruneHistory.length
      : 0
    const lastPrune = this.turnPruneHistory[this.turnPruneHistory.length - 1] ?? 0

    let maxGrowth = 0
    let totalGrowth = 0
    let count = 0
    for (const edge of this.edges.values()) {
      const growth = edge.flow * this.config.growthRate
      totalGrowth += growth
      count++
      if (growth > maxGrowth) maxGrowth = growth
    }

    return {
      prunedThisTurn: lastPrune,
      avgPruneRate: avgPrune,
      maxNodeGrowth: maxGrowth,
      avgGrowth: count > 0 ? totalGrowth / count : 0,
      criticality: this.getCriticality(),
    }
  }

  /** Detect graph anomaly (produces danger signal for immune system) */
  detectAnomaly(): { severity: number; source: string } | null {
    const stats = this.getStats()

    // Anomaly 1: sudden mass pruning
    if (stats.avgPruneRate > 0 && stats.prunedThisTurn > stats.avgPruneRate * 3) {
      return { severity: 0.7, source: 'mass_prune' }
    }

    // Anomaly 2: single node growth spike
    if (stats.avgGrowth > 0 && stats.maxNodeGrowth > stats.avgGrowth * 5) {
      return { severity: 0.8, source: 'growth_spike' }
    }

    // Anomaly 3: supercritical state
    if (stats.criticality === 'supercritical') {
      return { severity: 0.5, source: 'supercritical' }
    }

    return null
  }

  /** Freeze a node (quarantine — immune response) */
  freezeNode(file: string, _durationTurns: number): void {
    this.frozen.add(file)
  }

  unfreezeNode(file: string): void {
    this.frozen.delete(file)
  }

  /** Force prune specific edges (immune toxic response) */
  forcePrune(edges: Array<{ fileA: string; fileB: string }>): void {
    for (const { fileA, fileB } of edges) {
      this.edges.delete(this.edgeKey(fileA, fileB))
    }
  }

  /** Boost edges (immune healthy response) */
  boostEdges(files: string[], bonus: number): void {
    for (const edge of this.edges.values()) {
      if (files.includes(edge.fileA) || files.includes(edge.fileB)) {
        edge.weight += bonus
      }
    }
  }

  /** Get edge state (for testing/inspection) */
  getEdge(fileA: string, fileB: string): PhysarumEdgeState | undefined {
    return this.edges.get(this.edgeKey(fileA, fileB))
  }

  /** Get all edges for a file (for spreading activation integration) */
  getEdgesFor(file: string): PhysarumEdgeState[] {
    const result: PhysarumEdgeState[] = []
    for (const edge of this.edges.values()) {
      if (edge.fileA === file || edge.fileB === file) result.push(edge)
    }
    return result
  }

  /** Get top-K predicted next files based on STDP direction */
  predictNext(currentFile: string, k = 3): Array<{ file: string; score: number }> {
    const candidates: Array<{ file: string; score: number }> = []
    for (const edge of this.edges.values()) {
      if (edge.fileA === currentFile) {
        candidates.push({ file: edge.fileB, score: edge.weight * (1 + edge.direction) })
      } else if (edge.fileB === currentFile) {
        candidates.push({ file: edge.fileA, score: edge.weight * (1 - edge.direction) })
      }
    }
    candidates.sort((a, b) => b.score - a.score)
    return candidates.slice(0, k)
  }

  edgeCount(): number { return this.edges.size }

  /**
   * Track 1 (经络图×自由能): structural epistemic value for EFE.
   *
   * Estimates the information gain of exploring around the current working
   * set from graph structure: a file with no (or weak) meridian edges sits on
   * the frontier — exploring it yields high information gain. A file embedded
   * in heavy, consolidated edges is well-trodden — little left to learn.
   *
   * Returns 0 (fully familiar) to 1 (pure frontier), or undefined when there
   * is no recent file access to anchor the estimate.
   */
  structuralEpistemic(): number | undefined {
    if (this.recentAccess.length === 0) return undefined

    // Edge-weight mass at which a file counts as fully familiar. Calibrated
    // against synapticBudget so a node at homeostatic capacity scores ~0.
    const familiarityCap = Math.max(1, this.config.synapticBudget * 0.8)

    let total = 0
    for (const file of this.recentAccess) {
      const edges = this.getEdgesFor(file)
      if (edges.length === 0) {
        total += 1
        continue
      }
      const weightSum = edges.reduce((sum, e) => sum + e.weight * (e.consolidated ? 1.25 : 1), 0)
      total += 1 - Math.min(1, weightSum / familiarityCap)
    }
    return total / this.recentAccess.length
  }

  /** Persist all edges to MeridianDb */
  save(): void {
    if (!this.db?.savePhysarumEdges) return
    this.db.savePhysarumEdges([...this.edges.values()].filter(isLoadablePhysarumEdge))
  }

  /** Remove polluted persisted edges in-place after a filtered load. */
  cleanupPersistedEdges(): PhysarumLoadStats {
    this.save()
    return this.getLastLoadStats()
  }

  getLastLoadStats(): PhysarumLoadStats {
    return {
      loaded: this.lastLoadStats.loaded,
      discarded: this.lastLoadStats.discarded,
      discardedSamples: [...this.lastLoadStats.discardedSamples],
    }
  }

  /** Load edges from MeridianDb (call once at startup) */
  loadFromDb(): void {
    if (!this.db?.loadPhysarumEdges) return
    const edges = this.db.loadPhysarumEdges()
    let loaded = 0
    let discarded = 0
    const discardedSamples: Array<{ fileA: string; fileB: string }> = []
    for (const e of edges) {
      if (!isLoadablePhysarumEdge(e)) {
        discarded++
        if (discardedSamples.length < 5) {
          discardedSamples.push({ fileA: e.fileA, fileB: e.fileB })
        }
        continue
      }
      this.edges.set(this.edgeKey(e.fileA, e.fileB), e)
      loaded++
    }
    this.lastLoadStats = { loaded, discarded, discardedSamples }
  }
}

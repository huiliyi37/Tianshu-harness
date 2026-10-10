import type { ToolPipelineDeps } from './tool-pipeline.js'
import { isBashCommandDenied, isToolDenied } from './permissions.js'
import { isSelfDestructiveKill, selfProcessTree } from './self-preservation.js'
import { checkPlanMode } from './plan-mode.js'
import { checkAskMode } from './ask-mode.js'
import { profileIsPlanModeSafe } from './profile-registry.js'
import { isToolAllowedInReliabilityMode, reliabilityBlockMessage } from './reliability-mode.js'
import { assessToolRisk, type RiskAssessment } from './approval-risk.js'
import type { ToolCallParams } from '../tools/types.js'

export class ApprovedInputBoundaryError extends Error {
  constructor(message: string, readonly risk: RiskAssessment) {
    super(message)
    this.name = 'ApprovedInputBoundaryError'
  }
}

export function assessCurrentToolRisk(name: string, input: Record<string, unknown>, deps: ToolPipelineDeps, sensorium: Parameters<typeof assessToolRisk>[4]): RiskAssessment {
  const antibodies = deps.config.contextClaimStore?.listClaims({ kind: ['failure_pattern'], status: ['active', 'durable_candidate', 'durable'] }) ?? []
  return assessToolRisk(name, input, deps.getDoomLoopLevel(), antibodies, sensorium, deps.config.toolRegistry.get(name)?.definition?.capability as import('../mcp/policy.js').McpCapability | undefined)
}

/** Refresh dispatch context and enforce current policy after any approval wait. */
export function assertApprovedInputBoundary(name: string, input: Record<string, unknown>, deps: ToolPipelineDeps, params: ToolCallParams): RiskAssessment {
  const risk = assessCurrentToolRisk(name, input, deps, deps.getSensorium?.() ?? undefined)
  params.activePlanFilePath = deps.config.activePlanFilePath
  const block = approvedInputBlock(name, input, deps)
  if (block) {
    deps.onGateBlocked?.(block.gate)
    throw new ApprovedInputBoundaryError(block.message, risk)
  }
  return risk
}

/** Holds provisional claims until dispatch, including owners displaced by approval. */
export class ToolClaimBoundary {
  private readonly staked: string[] = []
  private readonly displaced: Array<{ claimPath: string; owner: string }> = []
  private readonly autoTakeovers: Array<{ claimPath: string; owner: string | null; level: string; reason: string }> = []
  executionStarted = false

  constructor(private readonly deps: Pick<ToolPipelineDeps, 'sessionRegistry' | 'sessionId'>) {}

  stake(claimPath: string, owner: string | null = null, takeover?: { level: string; reason: string }): void {
    this.staked.push(claimPath)
    if (owner) this.displaced.push({ claimPath, owner })
    if (takeover) this.autoTakeovers.push({ claimPath, owner, ...takeover })
  }

  rollback(): void {
    const { sessionRegistry, sessionId } = this.deps
    if (this.executionStarted || !sessionRegistry || !sessionId) return
    for (const path of this.staked) sessionRegistry.releaseClaim(sessionId, path)
    for (const claim of this.displaced) sessionRegistry.acquireClaim(claim.owner, claim.claimPath, 'exclusive')
    this.staked.length = 0
    this.displaced.length = 0
  }

  appendTakeoverNotes(content: string): string {
    if (this.autoTakeovers.length === 0) return content
    const notes = this.autoTakeovers
      .map(t => `[claim-takeover] 已接管会话 ${t.owner ? t.owner.slice(0, 8) : '(无主)'} 对「${t.claimPath}」的独占认领（判据 ${t.level}：${t.reason}）。`)
      .join('\n')
    for (const t of this.autoTakeovers) {
      console.warn(`[claim-takeover] ${t.claimPath} ← ${t.owner ?? '(无主)'} via ${t.level}：${t.reason}`)
    }
    return `${content}\n\n${notes}`
  }
}

/** An approval authorizes the final input but cannot waive runtime boundaries. */
export function approvedInputBlock(name: string, input: Record<string, unknown>, deps: ToolPipelineDeps): { gate: string; message: string } | undefined {
  const permissions = deps.config.permissions
  const overlay = deps.config.permissionsOverlay
  if (isToolDenied(name, input, [...(permissions?.deny ?? []), ...(overlay?.deny ?? [])])
    || (name === 'bash' && typeof input.command === 'string' && isBashCommandDenied(input.command, [...(permissions?.bash?.denylist ?? []), ...(overlay?.bashDeny ?? [])]))) {
    return { gate: 'deny', message: `Tool execution denied: ${name} matches an active deny rule after approval.` }
  }
  if (name === 'bash' && typeof input.command === 'string' && isSelfDestructiveKill(input.command, selfProcessTree())) {
    return { gate: 'self-kill', message: 'Tool execution blocked: the approved command would terminate the agent runtime.' }
  }
  const profiles = [input.profile, ...(Array.isArray(input.tasks) ? input.tasks.map(t => (t as { profile?: unknown } | null)?.profile) : [])]
  const plan = checkPlanMode(deps.config.planModeState ?? 'off', name, {
    cwd: deps.cwd,
    targetFilePath: typeof input.file_path === 'string' ? input.file_path : undefined,
    activePlanFilePath: deps.config.activePlanFilePath,
    delegatesWriteCapableProfile: (name === 'delegate_task' || name === 'delegate_batch') && profiles.some(p => typeof p === 'string' && !profileIsPlanModeSafe(p)),
  })
  if (!plan.allowed) return { gate: 'plan-mode', message: plan.reason ?? 'Plan Mode: write operations blocked' }
  const ask = checkAskMode(deps.config.askModeState ?? 'off', name)
  if (!ask.allowed) return { gate: 'ask-mode', message: ask.reason ?? 'Ask Mode: write operations blocked' }
  const reliability = deps.getReliabilityDecision?.()
  if (reliability && !isToolAllowedInReliabilityMode(reliability.mode, name, input)) return { gate: 'reliability', message: reliabilityBlockMessage(reliability, name) }
}

/**
 * Map an agent phase to a human-readable status label for the heartbeat line.
 * Returns null for phases that should not override the current status.
 *
 * IMPORTANT: every phase emitted by loop.ts via onPhaseChange must be handled
 * here or explicitly documented as intentionally ignored. Currently handled:
 * - heartbeat (loop.ts heartbeat timer)
 * - intent-veto (loop.ts intent evaluation)
 * - preparing (loop.ts pre-stream chain)
 * - working (loop.ts stream start)
 * - tool-hint (loop.ts tool call hint)
 * - stop-reason (loop.ts / turn-orchestrator — why the turn loop ended)
 * - convergence-warning (loop.ts L2 kick — the escalation rung BEFORE the
 *   convergence abort; must be user-visible or the eventual熔断 looks like it
 *   came out of nowhere: session 8396ac51 got 10 silent nudges then a hard stop)
 * - image-stripped (turn-orchestrator — a 413 / image rejection made the client
 *   drop image_url parts from the request. The model answering that turn never
 *   saw the images; without a visible line the user reads it as "the model
 *   ignored my screenshot". See issue #94.)
 */
export function phaseStatusLabel(
  phase: string,
  detail?: { tool?: string; reason?: string; suggestion?: string },
): string | null {
  switch (phase) {
    case 'heartbeat': return detail?.reason ?? 'still working'
    case 'intent-veto': return detail?.reason ?? 'intent vetoed'
    case 'preparing': return 'preparing…'
    case 'working': return detail?.reason ?? 'working…'
    case 'tool-hint': return detail?.tool ? `preparing ${detail.tool}…` : 'preparing…'
    case 'stop-reason': return detail?.reason ?? null
    case 'image-stripped': return detail?.reason ?? null
    case 'convergence-warning':
      return detail?.reason
        ? `⚠ AI 近几轮无明显进展，已建议切换策略；若再无改善将自动中断`
        : null
    default: return null
  }
}

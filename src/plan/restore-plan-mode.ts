import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentLoop } from '../agent/loop.js'
import type { SessionMetadata } from '../context/types.js'

/**
 * Re-enter plan mode from persisted session metadata after a resume or an
 * in-app session switch. The runtime plan-mode state lives in AgentLoop memory
 * and dies with the process; the meta mirror (written by syncPlanModeToConfig)
 * lets us restore it. Returns the restored draft path, or null when the session
 * was not planning / the draft file no longer exists (silent downgrade to off).
 */
export function restorePlanModeFromMeta(
  agent: AgentLoop,
  cwd: string,
  meta: Pick<SessionMetadata, 'planModeState' | 'activePlanFilePath'> | null | undefined,
): string | null {
  if (meta?.planModeState !== 'planning' || !meta.activePlanFilePath) return null
  const rel = meta.activePlanFilePath.replace(/\\/g, '/')
  if (!existsSync(join(cwd, rel))) return null
  agent.enterPlanMode({ planFilePath: rel })
  return rel
}

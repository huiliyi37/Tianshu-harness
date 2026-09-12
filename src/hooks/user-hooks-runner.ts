/**
 * User hooks — .rivet/hooks.json event→script mapping.
 *
 * Runs external shell scripts on agent lifecycle events. Scripts receive
 * event context via environment variables and stdin JSON.
 */

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ANTI_INTERACTIVE_ENV } from '../tools/resolved-env.js'
import { isProjectTrusted, notifyUntrustedOnce } from '../config/project-trust.js'

export type HookEvent =
  | 'preTurn'
  | 'postTurn'
  | 'postTool'
  | 'postSession'
  | 'onError'

export interface HookEntry {
  event: HookEvent
  /** Script path relative to project root or absolute. */
  script: string
  /** Optional timeout in ms. Default 5000. */
  timeoutMs?: number
}

export interface HooksConfig {
  hooks: HookEntry[]
}

export interface HookContext {
  event: HookEvent
  cwd: string
  sessionId?: string
  turn?: number
  toolName?: string
  toolResult?: string
  error?: string
}

export interface HookResult {
  script: string
  ok: boolean
  output: string
}

export const VALID_EVENTS = new Set<HookEvent>(['preTurn', 'postTurn', 'postTool', 'postSession', 'onError'])

export function loadHooksConfig(cwd: string): HooksConfig {
  const path = join(cwd, '.rivet', 'hooks.json')
  if (!existsSync(path)) return { hooks: [] }

  // 信任门：hooks.json 属仓库内容，未授信项目一律不执行（脚本经 shell 跑、
  // 拿完整用户权限——SECURITY.md 信任边界要求它不能自我授权）。
  if (!isProjectTrusted(cwd)) {
    notifyUntrustedOnce('hooks', cwd)
    return { hooks: [] }
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { hooks?: HookEntry[] }
    const hooks = (parsed.hooks ?? []).filter(h => VALID_EVENTS.has(h.event) && typeof h.script === 'string')
    return { hooks }
  } catch {
    return { hooks: [] }
  }
}

/** A hook contributed by a plugin (absolute script path + source plugin name).
 *  Mirrors PluginHookEntry from plugin-loader but kept structural to avoid the
 *  hooks layer importing the plugins layer. */
export interface PluginHook {
  pluginName: string
  event: HookEvent
  /** Absolute path to the script (plugin-loader resolved it). */
  script: string
  timeoutMs?: number
}

export function runHooksForEvent(cwd: string, ctx: HookContext, pluginHooks?: PluginHook[]): HookResult[] {
  const config = loadHooksConfig(cwd)
  // Merge plugin-contributed hooks (absolute script paths) with project hooks.
  const projectHooks: HookEntry[] = config.hooks.filter(h => h.event === ctx.event)
  const pluginEntries: HookEntry[] = (pluginHooks ?? [])
    .filter(h => h.event === ctx.event)
    .map(h => ({ event: h.event, script: h.script, timeoutMs: h.timeoutMs }))
  const entries = [...projectHooks, ...pluginEntries]
  const results: HookResult[] = []

  for (const entry of entries) {
    // Plugin hooks arrive with absolute paths; project hooks may be relative.
    const scriptPath = isAbsolute(entry.script)
      ? entry.script
      : join(cwd, entry.script)

    if (!existsSync(scriptPath)) {
      results.push({ script: entry.script, ok: false, output: `Script not found: ${scriptPath}` })
      continue
    }

    const timeoutMs = entry.timeoutMs ?? 5000
    const env = {
      ...process.env,
      ...ANTI_INTERACTIVE_ENV,
      RIVET_HOOK_EVENT: ctx.event,
      RIVET_SESSION_ID: ctx.sessionId ?? '',
      RIVET_TURN: String(ctx.turn ?? ''),
      RIVET_TOOL_NAME: ctx.toolName ?? '',
    }

    try {
      const result = spawnSync(scriptPath, [], {
        cwd,
        env,
        input: JSON.stringify(ctx),
        encoding: 'utf-8',
        timeout: timeoutMs,
        shell: true,
        windowsHide: true,
      })
      const output = (result.stdout ?? '') + (result.stderr ?? '')
      results.push({ script: entry.script, ok: result.status === 0, output: output.trim() })
    } catch (e) {
      results.push({
        script: entry.script,
        ok: false,
        output: e instanceof Error ? e.message : String(e),
      })
    }
  }

  return results
}

import { watch, existsSync, readFileSync, type FSWatcher } from 'node:fs'
import { loadConfig, findProjectConfig } from './manager.js'
import { userConfigPath } from './paths.js'
import { resolveProfileName, profilePath } from './profile.js'
import { debugLog } from '../utils/debug.js'

/**
 * P2 Wave 2: config HMR for the CVM hook assembly.
 *
 * Watches the user global config (RIVET_HOME/config.json or RIVET_CONFIG_PATH)
 * and the project config (.rivet-config.json, nearest ancestor of cwd) for
 * changes to the `hooks.disabled` block. On change, re-loads the config and
 * invokes `onHooksChange` with the new hooks block — the caller applies it via
 * RuntimeHookPipeline.setDisabledHookIds (next turn takes effect).
 *
 * Semantics (honest labels):
 * - Only `hooks.disabled` is hot-reloaded. timeoutMs/slowMs stay startup
 *   snapshots (they affect per-hook budgets at registration scope only).
 * - Fail-closed: read/parse errors keep the last good value and never invoke
 *   the callback with garbage.
 * - Debounced (default 500ms) so editor save-then-rename sequences collapse.
 * - Only files that exist at watch time are watched; a config created later is
 *   not picked up (documented limitation).
 * - Cache impact: hook switches do not touch tool fingerprints or system
 *   prompt bytes; advisory content produced by hooks may change the appendix
 *   of the NEXT request, causing one prefix rebuild before stability returns.
 */

export interface ConfigWatcherOptions {
  cwd: string
  /** Invoked only when hooks.disabled actually changed (array diff). */
  onHooksChange: (hooks: { disabled?: string[] }) => void
  /** Debounce window in ms. Injectable for tests (default 500). */
  debounceMs?: number
}

export interface ConfigWatcherHandle {
  close(): void
}

function envWatchDisabled(): boolean {
  const raw = process.env.RIVET_CONFIG_WATCH
  if (raw === undefined) return false
  const lower = raw.trim().toLowerCase()
  return lower === '0' || lower === 'false' || lower === 'off'
}

function sameDisabled(a: string[] | undefined, b: string[] | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? [])
}

export function watchConfigForHooks(options: ConfigWatcherOptions): ConfigWatcherHandle {
  if (envWatchDisabled()) {
    debugLog('[config-watcher] disabled via RIVET_CONFIG_WATCH')
    return { close() {} }
  }

  const projectPath = findProjectConfig(options.cwd)
  // 生效中的 profile 文件（RIVET_PROFILE/--profile）也在监听范围——profile 变更
  // 经同一热更通道生效（M1 审查修复：此前注释声明支持但 watch 列表遗漏）。
  const profilePathResolved = resolveProfileName()
    ? profilePath(resolveProfileName()!)
    : undefined
  const paths = [userConfigPath(), projectPath, profilePathResolved]
    .filter((p): p is string => p !== undefined && existsSync(p))

  let lastDisabled: string[] | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const watchers: FSWatcher[] = []

  // Baseline: capture the current value so the first change triggers a diff.
  try {
    lastDisabled = loadConfig({ cwd: options.cwd }).hooks?.disabled
  } catch {
    lastDisabled = undefined
  }

  const apply = (): void => {
    timer = undefined
    try {
      // File-level JSON gate: loadConfig silently falls back to defaults on
      // malformed JSON (parse catch → defaults), which would read as
      // "hooks removed" and clear the disabled set. Fail-closed here: a
      // half-written config (editor mid-save) must keep the last good value.
      for (const p of paths) {
        try {
          JSON.parse(readFileSync(p, 'utf-8'))
        } catch {
          debugLog(`[config-watcher] unparseable config ${p}, keeping last value`)
          return
        }
      }
      const cfg = loadConfig({ cwd: options.cwd })
      const next = cfg.hooks?.disabled
      if (sameDisabled(next, lastDisabled)) return
      lastDisabled = next
      options.onHooksChange({ disabled: next })
    } catch (e) {
      // Fail-closed: keep the last good value; never push garbage downstream.
      debugLog(`[config-watcher] reload failed, keeping last value: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(apply, options.debounceMs ?? 500)
  }

  for (const p of paths) {
    try {
      watchers.push(watch(p, { persistent: false }, schedule))
    } catch (e) {
      debugLog(`[config-watcher] watch ${p} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return {
    close() {
      if (timer) clearTimeout(timer)
      for (const w of watchers) w.close()
      watchers.length = 0
    },
  }
}

import { watch, existsSync, readFileSync, type FSWatcher } from 'node:fs'
import { dirname, basename } from 'node:path'
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
      // Watch 父目录而非文件本身：全仓 config 写盘走 fs-atomic 的 tmp+rename
      // 原子替换（writeFileAtomicSync/Async），rename 会把被 watch 路径下的
      // inode 整个换掉——kqueue/inotify 的 vnode watch 钉在旧 inode 上，第一
      // 次（往往就是 TUI 自己的 setHookDisabled→saveConfig）原子保存后 watcher
      // 永久失聪（nodejs/node#3428 同类问题）。目录 inode 稳定，文件被整体替
      // 换后依然能收到事件。回调按文件名过滤：只有目标文件本身（或平台拿不到
      // 文件名时的 null——宽松放行，宁可多跑一次有 diff 门兜底的 reload）才
      // schedule，同目录的 *.tmp 原子写中间产物与其他无关文件不触发。
      const dir = dirname(p)
      const base = basename(p)
      const w = watch(dir, { persistent: false }, (_event, filename) => {
        if (filename === null || filename === base) schedule()
      })
      // 目录被删（如会话内 rm -rf 项目目录/RIVET_HOME）时部分平台会 emit
      // 'error'；无监听器会变成 uncaughtException 打崩会话，降级为日志。
      w.on('error', e => {
        debugLog(`[config-watcher] watch ${dir} error: ${e instanceof Error ? e.message : String(e)}`)
      })
      watchers.push(w)
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

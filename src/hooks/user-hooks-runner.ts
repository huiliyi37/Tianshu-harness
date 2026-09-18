/**
 * User hooks — .rivet/hooks.json event→script mapping.
 *
 * Runs external shell scripts on agent lifecycle events. Scripts receive
 * event context via environment variables and stdin JSON.
 */

import { existsSync, readFileSync } from 'node:fs'
import { extname, isAbsolute, join } from 'node:path'
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

export type HookCommandResolution =
  | { ok: true; cmd: string; args: string[]; shell: boolean }
  | { ok: false; error: string }

export interface HookCommandDeps {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  exists?: (p: string) => boolean
  /** 运行中的 node 可执行文件——`.js`/`.mjs`/`.cjs`/`.ts` 用它，保证一定存在。 */
  execPath?: string
}

function findOnPath(names: string[], env: NodeJS.ProcessEnv, exists: (p: string) => boolean, platform: NodeJS.Platform): string | undefined {
  const dirs = (env.PATH ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean)
  for (const name of names) {
    for (const dir of dirs) {
      const p = join(dir, name)
      if (exists(p)) return p
    }
  }
  return undefined
}

/** Git for Windows 的 bash：先查已知安装位置，再查 PATH。 */
function resolveBash(env: NodeJS.ProcessEnv, exists: (p: string) => boolean, platform: NodeJS.Platform): string | undefined {
  const localPrograms = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs') : undefined
  for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], localPrograms]) {
    if (!root) continue
    for (const rel of ['Git\\bin\\bash.exe', 'Git\\usr\\bin\\bash.exe']) {
      const p = join(root, rel)
      if (exists(p)) return p
    }
  }
  return findOnPath(['bash.exe'], env, exists, platform)
}

/**
 * 给 hook 脚本解析「命令 + 参数」。
 *
 * 为什么不能继续用 `shell: true`（issue #198）：Windows 上那等价于
 * `cmd /d /s /c "<scriptPath>"`。`.sh` 没有注册关联处理程序时，cmd 找不到解释器会走
 * shell 的「打开」语义——弹出「选取应用」对话框并且**阻塞**：hook 永远不执行，桌面上
 * 还留下一个由 shell 持有、调用方回收不了的窗口。（PR #195 修的是同族的另一处落点。）
 *
 * Windows 上按扩展名选解释器；解释器缺失时 **fail-closed 报错**，绝不把脚本路径交给
 * shell 去「打开」。POSIX 保持原行为（`shell: true` + 脚本自身，`#!` 照常生效）。
 */
export function resolveHookCommand(scriptPath: string, deps: HookCommandDeps = {}): HookCommandResolution {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const exists = deps.exists ?? existsSync

  if (platform !== 'win32') return { ok: true, cmd: scriptPath, args: [], shell: true }

  const ext = extname(scriptPath).toLowerCase()
  switch (ext) {
    case '.bat':
    case '.cmd':
      return { ok: true, cmd: 'cmd.exe', args: ['/d', '/s', '/c', scriptPath], shell: false }
    case '.js':
    case '.mjs':
    case '.cjs':
    case '.ts':
      return { ok: true, cmd: deps.execPath ?? process.execPath, args: [scriptPath], shell: false }
    case '.py': {
      const python = findOnPath(['python.exe', 'py.exe'], env, exists, platform)
      return python
        ? { ok: true, cmd: python, args: [scriptPath], shell: false }
        : { ok: false, error: `hook 未执行：Windows 上找不到 python（脚本 ${scriptPath}）` }
    }
    case '.sh':
    case '.bash':
    case '.zsh': {
      const bash = resolveBash(env, exists, platform)
      return bash
        ? { ok: true, cmd: bash, args: [scriptPath], shell: false }
        : { ok: false, error: `hook 未执行：Windows 上找不到 bash（需 Git for Windows；脚本 ${scriptPath}）` }
    }
    default:
      return {
        ok: false,
        error: `hook 未执行：Windows 上没有为 "${ext || '(无扩展名)'}" 注册解释器（脚本 ${scriptPath}）。`
          + '直接交给 shell 会弹出「选取应用」并阻塞（issue #198），故此处 fail-closed。',
      }
  }
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

    // 解释器解析失败就不 spawn：宁可报错，也不把脚本路径交给 shell 去「打开」（#198）。
    const resolved = resolveHookCommand(scriptPath)
    if (!resolved.ok) {
      results.push({ script: entry.script, ok: false, output: resolved.error })
      continue
    }

    try {
      const result = spawnSync(resolved.cmd, resolved.args, {
        cwd,
        env,
        input: JSON.stringify(ctx),
        encoding: 'utf-8',
        timeout: timeoutMs,
        shell: resolved.shell,
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

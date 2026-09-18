import { execFileSync, spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import type { Tool } from './types.js'
import { expandHome } from '../platform.js'

export interface OpenPathCommand {
  cmd: string
  args: string[]
}

function normalizeOpenTarget(path: string, platform: NodeJS.Platform): string {
  const expanded = expandHome(path)
  if (platform === 'win32' && /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(expanded)) {
    return expanded
  }
  return resolve(expanded)
}

export function buildOpenPathCommand(path: string, platform: NodeJS.Platform = process.platform): OpenPathCommand {
  const target = normalizeOpenTarget(path, platform)
  if (platform === 'win32') {
    // 不用 `cmd.exe /c start`：cmd 对参数做二次解析，路径中的 & | % ^ 等元字符
    // 会被重新解释（注入面）。改用 PowerShell Start-Process，路径作为 -FilePath
    // 单引号字面串传入（单引号内 & | % ^ $ 全不解释，'' 转义内嵌单引号）。
    //
    // 注意: Start-Process 没有 -LiteralPath 参数 (那是 Get-Item 等 Item cmdlet
    // 的参数)。之前版本误用 -LiteralPath 导致 Windows 下"打开文件/文件夹"
    // 永远失败报 "找不到与参数名称 LiteralPath 匹配的参数"。
    //
    // explorer/Start-Process 对正斜杠路径不友好（前端 toAbsolute 在 cwd 含 '/'
    // 时会拼出 'C:/Users/...'，explorer 会静默失败），统一转反斜杠。
    const winTarget = target.replace(/\//g, '\\')
    const literal = `'${winTarget.replace(/'/g, "''")}'`
    return {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath ${literal}`],
    }
  }
  if (platform === 'darwin') {
    return { cmd: 'open', args: [target] }
  }
  return { cmd: 'xdg-open', args: [target] }
}

/** Build a command that reveals a file in the platform file manager. */
export function buildRevealCommand(path: string, platform: NodeJS.Platform = process.platform): OpenPathCommand {
  const target = normalizeOpenTarget(path, platform)
  if (platform === 'win32') {
    // explorer /select,"C:\path\to\file" — invoke through PowerShell so spaces
    // and shell metacharacters are not re-interpreted. Single-quote escaping
    // handles the rare embedded single quote.
    //
    // explorer 对正斜杠路径静默失败（前端可能传 'C:/Users/...'），统一转反斜杠。
    const winTarget = target.replace(/\//g, '\\')
    const literal = `'${winTarget.replace(/'/g, "''")}'`
    return {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', `explorer /select,${literal}`],
    }
  }
  if (platform === 'darwin') {
    return { cmd: 'open', args: ['-R', target] }
  }
  // Linux: no universal "select file" API; open the containing directory.
  return { cmd: 'xdg-open', args: [dirname(target)] }
}

/** 注册表查询执行器（可注入，便于测试）。返回值是 stdout；查询失败抛错。 */
export type RegQueryExec = (key: string, value: string) => string

function defaultRegQuery(key: string, value: string): string {
  // SystemRoot 下取绝对路径，避免依赖 PATH 里 reg.exe 的顺序。
  const reg = process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\reg.exe` : 'reg.exe'
  return execFileSync(reg, ['query', key, value === '' ? '/ve' : '/v', ...(value === '' ? [] : [value])], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }).toString()
}

/**
 * Windows：一个**文件**被 shell「打开」时，是否注册了可用的处理程序。
 *
 * 为什么需要：`.zzq` 这类没有关联的扩展名交给 shell 打开时没有可用处理程序，Windows
 * 会弹出「选取应用」对话框（`OpenWith.exe`）。对话框宿主是 shell，与调用方生命周期无关
 * ——它既不会被调用方回收，也无法被察觉，只会堆在用户桌面上。见 issue #193。
 *
 * 判定顺序（best-effort，只查注册表最常用的两处）：
 *   1. 用户级默认程序：`HKCU\...\FileExts\<ext>\UserChoice` 的 ProgId
 *   2. 机器级关联：`HKCR\<ext>` 的默认值 →ProgId→ `HKCR\<ProgId>\shell\open\command`
 *
 * 返回 `undefined` = 判断不了（非 Windows、无扩展名、查询本身出错）——调用方按 fail-open
 * 处理，保持既有行为，避免把「本来能打开」的机器误降级成「只定位」。
 */
export function windowsFileHasHandler(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
  query: RegQueryExec = defaultRegQuery,
): boolean | undefined {
  if (platform !== 'win32') return undefined
  const ext = extname(filePath)
  if (!ext || !/^\.[A-Za-z0-9_+-]+$/.test(ext)) return undefined

  try {
    if (/ProgId\s+REG_SZ\s+\S+/.test(query(
      `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${ext}\\UserChoice`, 'ProgId',
    ))) {
      return true
    }
  } catch { /* 该扩展名没有用户级覆盖——正常情况，继续查机器级 */ }

  let progId: string | undefined
  try {
    const out = query(`HKEY_CLASSES_ROOT\\${ext}`, '')
    progId = out.match(/REG_SZ\s+(\S+)/)?.[1]
  } catch {
    // HKCR 里根本没有该扩展名——这是「确认无处理程序」的强信号。
    return false
  }
  if (!progId) return undefined

  try {
    query(`HKEY_CLASSES_ROOT\\${progId}\\shell\\open\\command`, '')
    return true
  } catch {
    return false
  }
}

export interface OpenDecision {
  platform: NodeJS.Platform
  isDirectory: boolean
  /** true=有处理程序；false=确认没有；undefined=判断不了。 */
  hasHandler?: boolean
}

/**
 * 纯判定：该「打开」还是退化为「定位」。
 *
 * Windows 上对**文件**且确认没有关联处理程序时退化为定位（`explorer /select,`）——定位
 * 必定成功且绝不弹框；其余情况（非 Windows、目录、判断不了）一律维持「打开」。
 */
export function decideOpenAction(input: OpenDecision): 'open' | 'reveal' {
  if (input.platform !== 'win32') return 'open'
  if (input.isDirectory) return 'open'
  return input.hasHandler === false ? 'reveal' : 'open'
}

/** stat 失败（竞态删除等）按「不是目录」处理，不抛。 */
export function isDirectoryPath(path: string): boolean {
  try { return statSync(path).isDirectory() } catch { return false }
}

export const OPEN_PATH_TOOL: Tool = {
  definition: {
    name: 'open_path',
    description: `在用户操作系统中打开文件或目录。

用于用户可见文件，如生成的图片、SVG、PDF 或文件夹。接受外部路径（桌面、下载、挂载盘、Windows 路径），通过直接启动 OS 打开器避免 shell 引用问题。

示例：
Good: open_path(path="~/Desktop/tianshu-logo.svg")
Good: open_path(path="H:\\zhuomian\\白嫖gpt")
Bad: 用 bash explorer/open/start 命令加手写 shell 引号`,
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '绝对路径或 ~ 相对路径，要打开的文件/目录。可在项目之外。' },
      },
      required: ['path'],
    },
  },

  async execute(params) {
    const raw = params.input.path
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      return { content: '错误：path 为必填项', isError: true }
    }
    const target = resolve(expandHome(raw.trim()))
    if (!existsSync(target)) {
      return { content: `错误：路径不存在：${target}`, isError: true }
    }
    // Windows 上「打开」一个没有关联处理程序的文件，会弹「选取应用」对话框（issue #193）：
    // 对话框宿主是 shell 而 spawn 是 detached——调用方既回收不了也察觉不到。退化为定位。
    const isDir = isDirectoryPath(target)
    const action = decideOpenAction({
      platform: process.platform,
      isDirectory: isDir,
      hasHandler: isDir ? undefined : windowsFileHasHandler(target),
    })
    const command = action === 'reveal' ? buildRevealCommand(target) : buildOpenPathCommand(target)
    const verb = action === 'reveal' ? '已在资源管理器中定位' : '已打开'

    return new Promise((resolveResult) => {
      const child = spawn(command.cmd, command.args, { detached: true, stdio: 'ignore', windowsHide: true })
      child.on('error', (err) => {
        resolveResult({ content: `${action === 'reveal' ? '定位' : '打开'} ${target} 时出错：${err.message}`, isError: true })
      })
      child.on('spawn', () => {
        child.unref()
        resolveResult({ content: `${verb}：${target}` })
      })
    })
  },

  requiresApproval: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}

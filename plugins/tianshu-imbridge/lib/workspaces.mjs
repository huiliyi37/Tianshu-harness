/**
 * 工作区清单口径（命令 /workspacelist 的取数层）。
 *
 * 依据 docs/command-mapping.md §二：
 * - 枚举根 = 插件配置项 `workspace` 的**父目录**（不硬编码任何个人路径）；
 *   未配置 workspace 时不猜、不扫，直接回一句可读的提示。
 * - 排除规则：**点开头的隐藏项**与非目录。数据目录 `.rivet` 本身就是隐藏项，已被覆盖。
 *   ⚠️ 实盘踩过的坑（2026-09-24）：一度还按「含 `.rivet/` 或 `meridian.db` 就排除」来做，
 *   结果把 3/3 个真工作区全部误杀——因为**每个工作区内部都有自己的 `.rivet/`**（各自一份
 *   knowledge/ 与 meridian.db）。那条规则已废弃，回归用例见 test/workspaces.test.mjs。
 * - 排序用码点序（`.sort()`），跨环境确定；编号 1 起且与切换命令共用同一份清单。
 *
 * IO 通过 fsImpl 注入，便于单测；生产用 node:fs。
 */
import { readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** 由配置里的 workspace 绝对路径推出枚举根；未配置返回 null。 */
export function resolveWorkspaceRoot(workspacePath) {
  const raw = typeof workspacePath === 'string' ? workspacePath.trim() : ''
  if (!raw) return null
  const parent = dirname(raw)
  // dirname('D:/x') === 'D:/'，再往上就没了；此时视为不可用
  return parent && parent !== raw ? parent : null
}

/** 点开头的算隐藏项。 */
export function isHiddenName(name) {
  return typeof name === 'string' && name.startsWith('.')
}

/**
 * 从候选条目里挑出工作区名（只排除隐藏项与非目录；**不看目录内容**，见文件头注的实盘教训）。
 * @param {{name:string,isDirectory:boolean}[]} entries
 */
export function pickWorkspaces(entries) {
  const list = Array.isArray(entries) ? entries : []
  return list
    .filter((e) => e && typeof e.name === 'string' && e.name)
    .filter((e) => e.isDirectory !== false)
    .filter((e) => !isHiddenName(e.name))
    .map((e) => e.name)
    .sort()
}

/** 默认每屏条数（QQ 侧长度约束的第一道闸；超出则截断并提示）。 */
export const DEFAULT_LIST_LIMIT = 20

/**
 * 把工作区名格式化成可读清单。编号即后续 `/workspace <编号>` 的取值。
 * @returns {{ lines: string[], text: string, shown: number, total: number, truncated: boolean }}
 */
export function formatWorkspaceList(names, {
  root = '',
  limit = DEFAULT_LIST_LIMIT,
  header = '可用工作区',
} = {}) {
  const all = Array.isArray(names) ? names : []
  const max = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIST_LIMIT
  const shown = all.slice(0, max)
  const lines = [`${header}（${all.length} 个）`, `根目录：${root || '（未配置）'}`]
  if (all.length === 0) {
    lines.push('（这个目录下没有可用工作区）')
  } else {
    shown.forEach((name, i) => lines.push(`${i + 1}. ${name}`))
  }
  const truncated = all.length > shown.length
  if (truncated) lines.push(`…还有 ${all.length - shown.length} 个未列出（回复 /workspace <编号> 使用前 20 个）`)
  return { lines, text: lines.join('\n'), shown: shown.length, total: all.length, truncated }
}

/**
 * 读磁盘取清单。
 * @returns {{ root:string|null, names:string[], entries:number, excluded:number, error:string|null }}
 */
/** 绝对路径判定：盘符式（D:\ 或 D:/）或 UNC（\\server\share）。自带一份，避免依赖平台差异。 */
export function isAbsolutePath(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  return /^[A-Za-z]:[\\/]/.test(raw) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(raw)
}

/**
 * 解析 /workspace 的目标：编号（与 /workspacelist 同一份清单同一排序）或绝对路径。
 * 路径必须真实存在且是目录 —— 宿主的 POST /sessions 不校验 cwd（实测 A:15），
 * 这个校验只能由插件自己做，否则会给用户一个永远不会出错的假成功。
 * @returns {{ok:true, path:string, name:string} | {ok:false, error:string}}
 */
export function resolveWorkspaceTarget(arg, { workspace, fsImpl } = {}) {
  const io = fsImpl ?? { readdirSync, statSync }
  const raw = typeof arg === 'string' ? arg.trim() : ''
  if (!raw) {
    return { ok: false, error: '用法：/workspace <编号或绝对路径>（编号先看 /workspacelist）' }
  }
  if (/^\d+$/.test(raw)) {
    const list = listWorkspaces({ workspace, fsImpl: io })
    if (list.error) return { ok: false, error: list.error }
    const n = Number.parseInt(raw, 10)
    if (n < 1 || n > list.names.length) {
      return {
        ok: false,
        error: `没有第 ${n} 个工作区（当前共 ${list.names.length} 个，先发 /workspacelist 看看）`,
      }
    }
    const name = list.names[n - 1]
    return { ok: true, path: join(list.root, name), name }
  }
  if (!isAbsolutePath(raw)) {
    return { ok: false, error: `只接受编号或绝对路径，收到的是：${raw}` }
  }
  let st
  try {
    st = io.statSync(raw)
  } catch {
    return { ok: false, error: `目录不存在或读不到：${raw}` }
  }
  if (typeof st?.isDirectory === 'function' && !st.isDirectory()) {
    return { ok: false, error: `那不是目录：${raw}` }
  }
  return { ok: true, path: raw, name: basename(raw) || raw }
}

export function listWorkspaces({ workspace, fsImpl } = {}) {
  const io = fsImpl ?? { readdirSync }
  const root = resolveWorkspaceRoot(workspace)
  if (!root) {
    return {
      root: null,
      names: [],
      entries: 0,
      excluded: 0,
      error: '未配置工作区根目录：请在插件配置里设置 workspace（指向某个工作区目录），'
        + '我会用它所在的那层目录作为可选清单。',
    }
  }
  let dirents
  try {
    dirents = io.readdirSync(root, { withFileTypes: true })
  } catch (error) {
    return {
      root,
      names: [],
      entries: 0,
      excluded: 0,
      error: `读取工作区根目录失败（${root}）：${error?.message ?? error}`,
    }
  }
  const entries = dirents.map((d) => ({
    name: typeof d.name === 'string' ? d.name : String(d.name ?? ''),
    isDirectory: typeof d.isDirectory === 'function' ? d.isDirectory() : Boolean(d.isDirectory),
  }))
  const names = pickWorkspaces(entries)
  return { root, names, entries: entries.length, excluded: entries.length - names.length, error: null }
}

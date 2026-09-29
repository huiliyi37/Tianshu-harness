/**
 * 会话清单的取数与格式化（命令 /sessions 的取数层）。
 *
 * 依据 docs/command-mapping.md §一.3：
 * - 端点 GET /sessions → { sessions: [...] }，会话对象字段并集 17 个，其中
 *   `missionId` / `contextTokens` / `contextWindow` / `error` 是**可选**字段，取值前必须判空。
 * - 排序取 `updatedAt` 降序（最近动过的在最前），并列时按 id 兜底 -> 确定可复现。
 * - 序号 1 起，且与 /session <编号> 共用同一份列表与排序（同源，不各排各的）。
 * - 输出条数有上限（QQ 侧长度约束的第一道闸），超出截断并说明。
 */
import { basename } from 'node:path'

export const DEFAULT_LIMIT = 10
export const MAX_LIMIT = 30

/** 统一分隔符与大小写，用于比较 cwd（宿主会原样存你给的写法，正反斜杠都可能出现）。 */
export function normalizePath(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  return raw.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** 工作区名（用于清单里标注会话属于哪个工作区）。 */
export function workspaceNameOf(cwd) {
  const raw = typeof cwd === 'string' ? cwd.replace(/\\/g, '/').replace(/\/+$/, '') : ''
  return basename(raw) || raw || '（未知工作区）'
}

/** 收敛成规整条目：判空可选字段、截断过长标题。 */
export function normalizeSessions(raw) {
  const list = Array.isArray(raw) ? raw : []
  return list
    .filter((s) => s && typeof s.id === 'string' && s.id)
    .map((s) => ({
      id: s.id,
      title: typeof s.title === 'string' && s.title.trim() ? s.title.trim() : '（无标题）',
      cwd: typeof s.cwd === 'string' ? s.cwd : '',
      workspace: workspaceNameOf(s.cwd),
      updatedAt: Number.isFinite(s.updatedAt) ? s.updatedAt : 0,
      status: typeof s.status === 'string' ? s.status : '',
      failed: Boolean(s.error),
    }))
    .sort((a, b) => (b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id))
}

/**
 * 解析 /sessions 的参数：可选的工作区序号 + --limit N。
 * @returns {{workspaceIndex:number|null, limit:number|null, error:string|null}}
 */
export function parseSessionArgs(args) {
  const list = Array.isArray(args) ? args : []
  let workspaceIndex = null
  let limit = null
  for (let i = 0; i < list.length; i += 1) {
    const tok = list[i]
    if (tok === '--limit') {
      const raw = list[i + 1]
      const n = Number.parseInt(raw ?? '', 10)
      if (!Number.isInteger(n) || n < 1) {
        return { workspaceIndex, limit: null, error: '--limit 需要一个正整数，例如 /sessions --limit 5' }
      }
      limit = Math.min(n, MAX_LIMIT)
      i += 1
      continue
    }
    if (/^\d+$/.test(tok)) {
      if (workspaceIndex !== null) {
        return { workspaceIndex, limit, error: '只能给一个工作区序号，例如 /sessions 2 --limit 5' }
      }
      workspaceIndex = Number.parseInt(tok, 10)
      continue
    }
    return { workspaceIndex, limit, error: `不认识的参数：${tok}（用法：/sessions [工作区序号] [--limit N]）` }
  }
  return { workspaceIndex, limit, error: null }
}

/**
 * 格式化清单。
 * @returns {{lines:string[], text:string, shown:number, total:number, truncated:boolean}}
 */
export function formatSessionList(items, {
  limit = DEFAULT_LIMIT,
  boundId = null,
  scopeNote = '',
} = {}) {
  const all = Array.isArray(items) ? items : []
  const max = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT
  const shown = all.slice(0, max)
  // 条目自带 index（全量编号）优先；没有则按显示行序
  const numberOf = (s, i) => (Number.isInteger(s?.index) && s.index > 0 ? s.index : i + 1)
  const lines = [`会话（${all.length} 个${scopeNote}）`]
  if (all.length === 0) {
    lines.push('（这个范围里还没有会话）')
  } else {
    if (shown.some((s, i) => numberOf(s, i) !== i + 1)) {
      lines.push('（编号为完整清单中的位置，可直接用于 /session）')
    }
    shown.forEach((s, i) => {
      const marks = [s.workspace]
      if (s.failed) marks.push('上次失败')
      if (boundId && s.id === boundId) marks.push('← 本条对话线当前绑定')
      const title = s.title.length > 40 ? `${s.title.slice(0, 40)}…` : s.title
      lines.push(`${numberOf(s, i)}. ${title}（${marks.join('，')}）`)
    })
  }
  const truncated = all.length > shown.length
  if (truncated) lines.push(`…还有 ${all.length - shown.length} 个未列出（用 /sessions --limit N 或指定工作区收窄）`)
  return { lines, text: lines.join('\n'), shown: shown.length, total: all.length, truncated }
}

/**
 * 解析 /session 的目标：编号（与 /sessions 同源同序）或会话 id。
 * 编号按 MAX_LIMIT 截断后的清单解析 —— 用户在 /sessions 看到的编号一定落在该范围内，
 * 所以无论他当时用的默认 10 条还是 --limit N（≤30），编号都对得上。
 * id 则必须真实存在：getSession 返回 null（404）即「找不到」；抛错（5xx）是「无法确认」，两者分开说。
 * @returns {Promise<{ok:true, session:object} | {ok:false, error:string}>}
 */
export async function resolveSessionTarget(arg, { serveClient, workspace, fsImpl } = {}) {
  const raw = typeof arg === 'string' ? arg.trim() : ''
  if (!raw) {
    return { ok: false, error: '用法：/session <编号或会话 ID>（编号先看 /sessions）' }
  }
  if (/^\d+$/.test(raw)) {
    const list = await listSessions({ serveClient, workspace, workspaceIndex: null, fsImpl })
    if (list.error) return { ok: false, error: list.error }
    const capped = list.items.slice(0, MAX_LIMIT)
    const n = Number.parseInt(raw, 10)
    if (n < 1 || n > capped.length) {
      return {
        ok: false,
        error: `没有第 ${n} 个会话（当前可编号的有 ${capped.length} 个，先发 /sessions 看看）`,
      }
    }
    return { ok: true, session: capped[n - 1] }
  }
  if (!serveClient?.available || typeof serveClient.getSession !== 'function') {
    return { ok: false, error: '当前是降级模式（没有 serve 通道），无法按 ID 绑定。' }
  }
  try {
    const snap = await serveClient.getSession(raw)
    if (!snap) return { ok: false, error: `找不到这个会话：${raw}` }
    const normalized = normalizeSessions([snap])[0]
    return { ok: true, session: normalized ?? { id: raw, title: '（无标题）', workspace: '（未知工作区）' } }
  } catch (error) {
    return { ok: false, error: `无法确认会话（${raw}）：${error?.message ?? error}` }
  }
}

/**
 * 取清单并按工作区过滤。
 * @returns {Promise<{items:Array, error:string|null, scopeNote:string}>}
 */
export async function listSessions({ serveClient, workspace, workspaceIndex = null, fsImpl } = {}) {
  if (!serveClient?.available || typeof serveClient.listSessions !== 'function') {
    return { items: [], error: '当前是降级模式（没有 serve 通道），看不到会话清单。', scopeNote: '' }
  }
  let raw
  try {
    raw = await serveClient.listSessions()
  } catch (error) {
    return { items: [], error: `取会话清单失败：${error?.message ?? error}`, scopeNote: '' }
  }
  const items = normalizeSessions(raw)
  // 全量编号：编号 = 「完整清单中的位置」。过滤视图沿用同一编号（filter 保留 index），
  // 保证「/sessions 显示的编号」恒等于「/session 接受的编号」——否则会绑错会话。
  items.forEach((s, i) => { s.index = i + 1 })
  if (workspaceIndex === null) return { items, error: null, scopeNote: '' }

  // 序号复用 /workspacelist 的清单（同一份清单、同一排序）
  const { listWorkspaces } = await import('./workspaces.mjs')
  const ws = listWorkspaces({ workspace, fsImpl })
  if (ws.error) return { items: [], error: ws.error, scopeNote: '' }
  if (workspaceIndex < 1 || workspaceIndex > ws.names.length) {
    return {
      items: [],
      error: `没有第 ${workspaceIndex} 个工作区（当前共 ${ws.names.length} 个，先发 /workspacelist 看看）`,
      scopeNote: '',
    }
  }
  const name = ws.names[workspaceIndex - 1]
  const target = normalizePath(`${ws.root}/${name}`)
  return {
    items: items.filter((s) => normalizePath(s.cwd) === target),
    error: null,
    scopeNote: `，限于工作区「${name}」`,
  }
}

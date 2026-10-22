/**
 * 会话引用解析器 (resolveSessionRef)
 *
 * 为 /resume 提供可控的统一会话引用解析：
 * 1. 显式 --id <id|prefix> 或 -i <id|prefix>：绕过纯数字序号歧义，只做 ID/前缀匹配；
 * 2. 纯数字（如 1、2）：保持历史习惯，解析为 listMainSessions 的 1-based 序号；
 * 3. 字符串（支持多词与引号）：
 *    - 去除外层引号后为空（如 "" 或 ''）视为 empty；
 *    - 优先精确 ID 匹配（复用 resolveSessionId，可覆盖 listMainSessions 之外的有效会话）；
 *    - 精确名称/标题匹配（忽略大小写，保留多词；非空标题才匹配）；
 *      * 若存在多个同名会话，拒绝切换并输出候选清单供歧义消解；
 *    - ID 前缀模糊匹配；
 * 4. 候选/错误文案格式化收口在叶子 helper，保护 slash-commands.ts 行数预算；
 * 5. 只读 SessionMetadata，禁止构建任何全局常驻索引。
 */
import { SessionPersist } from './session-persist.js'

export interface SessionRefCandidate {
  id: string
  title?: string
  updatedAt?: number
  turnCount?: number
  model?: string
}

export type ResolveSessionRefResult =
  | { kind: 'index'; id: string }
  | { kind: 'id'; id: string }
  | { kind: 'title'; id: string }
  | { kind: 'empty' }
  | { kind: 'out_of_range'; total: number; index: number }
  | { kind: 'ambiguous_title'; title: string; candidates: SessionRefCandidate[] }
  | { kind: 'ambiguous_id'; prefix: string; candidates: string[] }
  | { kind: 'not_found'; ref: string }

export function resolveSessionRef(cwd: string, inputRef: string): ResolveSessionRefResult {
  const trimmed = inputRef.trim()
  if (!trimmed) return { kind: 'empty' }

  // 1. 显式 --id 或 -i 标志：绕过纯数字序号歧义，定向做 ID / 前缀解析
  const idFlagMatch = /^(--id|-i)(?:[=\s]+(.+))?$/i.exec(trimmed)
  if (idFlagMatch) {
    const rawVal = (idFlagMatch[2] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2').trim()
    if (!rawVal) return { kind: 'not_found', ref: '' }
    const resolved = SessionPersist.resolveSessionId(cwd, rawVal)
    if (!resolved) return { kind: 'not_found', ref: rawVal }
    if ('ambiguous' in resolved) return { kind: 'ambiguous_id', prefix: rawVal, candidates: resolved.ambiguous }
    return { kind: 'id', id: resolved.id }
  }

  // 2. 纯数字：保留历史习惯，解析为 1-based 序号
  if (/^\d+$/.test(trimmed)) {
    const ordered = SessionPersist.listMainSessions(cwd)
    const idx = parseInt(trimmed, 10) - 1
    if (idx < 0 || idx >= ordered.length) {
      return { kind: 'out_of_range', total: ordered.length, index: idx + 1 }
    }
    return { kind: 'index', id: ordered[idx]!.id }
  }

  // 3. 去掉最外层包裹引号（如 /resume "my project" 或 /resume 'my project'）
  const unquoted = trimmed.replace(/^(['"])(.*)\1$/, '$2').trim()
  if (!unquoted) return { kind: 'empty' }

  // 4. 精确 ID 优先：先查一次 resolveSessionId，若正好精确命中 ID 则立即生效
  //（同时覆盖 resolveSessionId 能看到但 listMainSessions 过滤掉的特定会话）
  const resolved = SessionPersist.resolveSessionId(cwd, unquoted)
  if (resolved && 'id' in resolved && resolved.id === unquoted) {
    return { kind: 'id', id: resolved.id }
  }

  // 5. 精确名称/标题匹配（忽略外层空白，不区分大小写；仅非空标题参与匹配）
  const ordered = SessionPersist.listMainSessions(cwd)
  const queryLower = unquoted.toLowerCase()
  const titleMatches = ordered.filter(s => (s.title ?? '').trim() && (s.title ?? '').trim().toLowerCase() === queryLower)
  if (titleMatches.length === 1) {
    return { kind: 'title', id: titleMatches[0]!.id }
  }
  if (titleMatches.length > 1) {
    return {
      kind: 'ambiguous_title',
      title: unquoted,
      candidates: titleMatches.map(s => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        turnCount: s.turnCount,
        model: s.model,
      })),
    }
  }

  // 6. ID 前缀匹配（复用前面 resolveSessionId 结果）
  if (resolved && 'id' in resolved) return { kind: 'id', id: resolved.id }
  if (resolved && 'ambiguous' in resolved) return { kind: 'ambiguous_id', prefix: unquoted, candidates: resolved.ambiguous }
  return { kind: 'not_found', ref: unquoted }
}

/**
 * 格式化会话引用解析的错误或消歧提示文案（收拢在叶子模块，防巨石行数溢出）。
 * 返回 string 则表示该状态需展示提示并中止切换；返回 null 表示解析成功无需报错。
 */
export function formatSessionRefMessage(res: ResolveSessionRefResult): string | null {
  switch (res.kind) {
    case 'empty':
      return '用法: /resume [id前缀 或 序号 或 名称] [--id <id>]。用 /sessions 查看会话列表。'
    case 'out_of_range':
      return `序号超出范围(共 ${res.total} 个会话)。用 /sessions 查看。`
    case 'ambiguous_id': {
      const cands = res.candidates.map(id => `  ${id.slice(0, 12)}`).join('\n')
      return `前缀 "${res.prefix}" 匹配多个会话,请用更长前缀:\n${cands}`
    }
    case 'ambiguous_title': {
      const cands = res.candidates.map(c => {
        const short = c.id.slice(0, 12)
        const when = c.updatedAt ? new Date(c.updatedAt).toLocaleDateString() : ''
        const turns = c.turnCount !== undefined ? ` ${c.turnCount}轮` : ''
        const model = c.model ? ` ${c.model}` : ''
        return `  ${short}  ${when}${turns}${model}  ${c.title ?? ''}`.trimEnd()
      }).join('\n')
      return `名称/标题 "${res.title}" 匹配多个会话,请使用 --id 指定具体会话:\n${cands}`
    }
    case 'not_found':
      return res.ref ? `未找到匹配会话: "${res.ref}"。用 /sessions 查看会话列表。` : '用法: /resume --id <会话ID或前缀>'
    default:
      return null
  }
}

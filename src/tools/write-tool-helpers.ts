/**
 * Write Tool Helpers — 所有写工具的共享常量和内容提取函数。
 *
 * 单一事实来源：四个编辑工具（edit_file / write_file / hash_edit / ast_edit）
 * 各有不同的输入 schema，但三个检测器（dead-end-detector、probe-detector、
 * external-claim-tracking-hook）都需要"文件路径 + 写入内容"。
 * 与其各处各自维护写工具列表和提取逻辑，不如集中到这里。
 *
 * ast_edit 的输入与另外三个不同：
 *   - 不是单 file_path，而是 paths: string[]
 *   - 不是单 new_string/content，而是 ops: [{ find, replace }, ...]
 *   - dryRun 非 false 时不实际写盘（缺省即预览），返回空数组
 *
 * apply_patch 的 input 是 unified diff 文本本身（`{ diff, check_only }`），目标
 * 文件与新增内容都藏在 diff 里，需要先解析——见 extractPatchContents /
 * extractPatchTargetPathsFromDiff。基于 input 字段直取的 extractWriteContents
 * 不覆盖它。
 */

/**
 * 布尔开关归一。
 *
 * 模型会把布尔参数写成字符串——2026-07-27 会话里实测传过 dry_run="true"、
 * timeout="60000"。裸 `input.x as boolean` 对字符串 "false" 求值为真，
 * 于是 dry_run="false" 会让编辑静默降级为预览（模型以为改完了），
 * replace_all="false" 会把单处替换扩成全量替换。两种都是无声的错误结果，
 * 比报错更难发现，所以在读取点归一。
 */
export function asBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true' || v === '1' || v === 'yes') return true
    if (v === 'false' || v === '0' || v === 'no' || v === '') return false
  }
  if (typeof value === 'number') return value !== 0
  if (value === null || value === undefined) return fallback
  return Boolean(value)
}

/** 所有写工具名（供各检测器引用，替代各自的 EDIT_TOOLS / WRITE_TOOLS） */
export const WRITE_TOOL_NAMES = new Set([
  'edit_file',
  'write_file',
  'hash_edit',
  'ast_edit',
  'apply_patch',
])

/** 四编辑工具（不含 apply_patch，其语义不同） */
const EDIT_TOOLS_WITH_CONTENT = new Set([
  'edit_file',
  'write_file',
  'hash_edit',
  'ast_edit',
])

export interface WriteFileContent {
  filePath: string
  content: string
}

/**
 * 归一 unified diff 的 `+++ ` 路径：去引号、截 tab 后的时间戳、剥 `a/`|`b/` 前缀。
 * 与 apply-patch.ts 的 extractPatchTargetPaths 同规则（测试锁定两者一致）。
 * `/dev/null`（纯删除）返回 null——没有落盘内容可检测。
 */
function normalizePatchPath(raw: string): string | null {
  let p = raw.trim()
  const tabIdx = p.indexOf('\t')
  if (tabIdx !== -1) p = p.slice(0, tabIdx)
  if (p === '/dev/null') return null
  p = p.replace(/^"(.*)"$/, '$1')
  p = p.replace(/^[ab]\//, '')
  return p.length > 0 ? p : null
}

/**
 * 从 unified diff 提取每个目标文件的新增内容（`+` 行，去掉前导 `+`）。
 *
 * 为什么需要：apply_patch 是写工具，但它的 input 里没有 file_path/content 字段，
 * 所以基于字段直取的 extractWriteContents 对它返回空。内容型检测器（安全模式
 * 扫描等）若只接 extractWriteContents，换用 apply_patch 写入的代码就完全绕过
 * 检测——工具选择不该决定检测是否生效。
 *
 * 只取新增行：context 行是文件原有内容，不是本次写入的产物（与 edit_file 只扫
 * new_string 同口径）。同一文件的多个 hunk 合并成一条，按 `\n` 拼接。
 *
 * 纯函数、无 I/O：diff 文本已在 input 里，不需要读盘。
 */
export function extractPatchContents(diff: string): WriteFileContent[] {
  if (typeof diff !== 'string' || diff.length === 0) return []

  const byFile = new Map<string, string[]>()
  let current: string | null = null

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      current = normalizePatchPath(line.slice(4))
      if (current !== null && !byFile.has(current)) byFile.set(current, [])
      continue
    }
    // `---` 头 / `diff --git` 之间的元数据行不含新增内容；`+++` 已在上面消费。
    if (line.startsWith('--- ') || line.startsWith('diff --git')) continue
    if (current === null) continue
    if (line.startsWith('+')) byFile.get(current)!.push(line.slice(1))
  }

  const results: WriteFileContent[] = []
  for (const [filePath, lines] of byFile) {
    if (lines.length === 0) continue
    results.push({ filePath, content: lines.join('\n') })
  }
  return results
}

/** diff 的目标文件路径（`+++ ` 头，跳过纯删除）。 */
export function extractPatchTargetPathsFromDiff(diff: string): string[] {
  if (typeof diff !== 'string' || diff.length === 0) return []
  const paths = new Set<string>()
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+++ ')) continue
    const p = normalizePatchPath(line.slice(4))
    if (p !== null) paths.add(p)
  }
  return [...paths]
}

/**
 * 从 ast_edit 的 input 中提取 (filePath, content) 列表。
 * 非真写（dryRun 缺省或 true，即预览）返回空数组（不实际写盘）。
 */
function extractAstEditContents(input: Record<string, unknown>): WriteFileContent[] {
  // 工具真值（ast-edit.ts:105）：`const dryRun = input.dryRun !== false`——缺省即
  // 预览、不落盘。用 `=== true` 判会让"缺省预览"漏过：未落盘的内容被喂进安全/
  // 探针扫描，假命中还会占掉 tracker 的跨轮去重位，让随后真写入的提醒被吞。
  if (input.dryRun !== false) return []
  const ops = input.ops
  const paths = input.paths
  if (!Array.isArray(ops) || !Array.isArray(paths) || paths.length === 0 || ops.length === 0) {
    return []
  }

  const results: WriteFileContent[] = []
  for (const filePath of paths) {
    if (typeof filePath !== 'string') continue
    for (const op of ops) {
      if (typeof op?.replace !== 'string') continue
      results.push({ filePath, content: op.replace })
    }
  }
  return results
}

/**
 * 从任意写工具的 input 中提取 (文件路径, 写入内容) 列表。
 *
 * - ast_edit: 返回多个条目（paths × ops），dryRun 返回空
 * - edit_file / hash_edit: 从 new_string + file_path 提取
 * - write_file: 从 content + file_path 提取
 * - apply_patch: 返回空（语义不同，不做内容提取）
 * - 非写工具或无法提取时返回空数组
 */
export function extractWriteContents(
  toolName: string,
  input: Record<string, unknown> | undefined,
): WriteFileContent[] {
  if (!input || !EDIT_TOOLS_WITH_CONTENT.has(toolName)) return []

  if (toolName === 'ast_edit') {
    return extractAstEditContents(input)
  }

  const filePath = typeof input.file_path === 'string' ? input.file_path : null
  if (!filePath) return []

  let content: string | null = null
  if (toolName === 'write_file' && typeof input.content === 'string') {
    content = input.content
  } else if ((toolName === 'edit_file' || toolName === 'hash_edit') && typeof input.new_string === 'string') {
    content = input.new_string
  }

  if (content === null) return []
  return [{ filePath, content }]
}

/**
 * 从任意写工具的 input 中提取文件路径列表（不需要内容时用）。
 * 如 dead-end-detector 只需知道哪些文件被编辑过，不需要内容。
 *
 * - ast_edit: 返回 input.paths（dryRun 也返回——预览也需要标记 editPending）
 * - apply_patch: 解析 diff 的 `+++ ` 头
 * - 其余: 返回 [input.file_path]
 */
export function extractWriteFilePaths(
  toolName: string,
  input: Record<string, unknown> | undefined,
): string[] {
  if (!input || !WRITE_TOOL_NAMES.has(toolName)) return []

  if (toolName === 'ast_edit') {
    if (input.dryRun === true) return []
    const paths = input.paths
    if (!Array.isArray(paths)) return []
    return paths.filter((p): p is string => typeof p === 'string')
  }

  // apply_patch: 目标文件只在 diff 的 `+++ ` 头里（input 没有 file_path/path
  // 字段——曾按 input.path ?? input.file 取，对真实 schema 恒为空，文件级追踪
  // 对 apply_patch 静默失效）。
  if (toolName === 'apply_patch') {
    return typeof input.diff === 'string' ? extractPatchTargetPathsFromDiff(input.diff) : []
  }

  const fp = input.file_path
  return typeof fp === 'string' ? [fp] : []
}

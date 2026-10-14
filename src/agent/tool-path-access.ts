import { validatePathSafe } from '../tools/path-validate.js'
import { expandHome } from '../platform.js'
import { resolve as resolvePath } from 'node:path'

/**
 * File tools whose path operand may target a path outside the workspace, with
 * the access mode they need. Used to gate out-of-workspace file ops behind an
 * approval-driven path grant (rather than a hard "Path outside workspace" error).
 * `read_section` is artifact-id based and `apply_patch` embeds paths in a patch
 * body — neither has a single extractable path, so they rely on request_path_access.
 * `ast_edit` (paths 数组) 走同一门禁；export_file / create_document / open_path 的
 * 参数形态不同（destination/source/path + execute 侧 trim），在下方专门分支提取。
 */
const FILE_TOOL_MODES: Record<string, 'read' | 'write'> = {
  read_file: 'read',
  write_file: 'write',
  edit_file: 'write',
  hash_edit: 'write',
  ast_edit: 'write',
}

/**
 * Resolve the absolute paths a file tool would touch that currently fall OUTSIDE
 * the workspace and are not yet covered by a grant. Empty when in-workspace or
 * already granted (validatePathSafe consults the grant store).
 *
 * Exported so the desktop sidecar can label an approval as a path grant without
 * duplicating the path comparison — symlink/case handling lives in one place.
 */
export function outOfWorkspaceFilePaths(cwd: string, toolName: string, input: Record<string, unknown>): { mode: 'read' | 'write'; paths: string[] } | null {
  // 外部导出面（export_file/create_document）：destination 写侧优先于 source 读侧
  // ——更强的授权面决定整组 mode（返回结构保持单 mode 形态，桌面端 pathGrantHint
  // 依赖）。execute 侧对路径做 trim + expandHome（~ 展开到家目录），这里必须做
  // 同样的归一——否则 `~/Desktop/x.svg` 会词法 resolve 进 cwd 而绕过门禁。
  if (toolName === 'export_file' || toolName === 'create_document') {
    const dest = typeof input.destination_path === 'string' ? expandHome(input.destination_path.trim()) : ''
    const src = toolName === 'export_file' && typeof input.source_path === 'string' ? expandHome(input.source_path.trim()) : ''
    if (dest && !validatePathSafe(cwd, dest, 'write').ok) return { mode: 'write', paths: [resolvePath(cwd, dest)] }
    if (src && !validatePathSafe(cwd, src, 'read').ok) return { mode: 'read', paths: [resolvePath(cwd, src)] }
    return null
  }
  // open_path：只读打开（OS opener，不回读内容）；execute 侧同样 trim + expandHome
  if (toolName === 'open_path') {
    const path = typeof input.path === 'string' ? expandHome(input.path.trim()) : ''
    if (path && !validatePathSafe(cwd, path, 'read').ok) return { mode: 'read', paths: [resolvePath(cwd, path)] }
    return null
  }
  const mode = FILE_TOOL_MODES[toolName]
  if (!mode) return null
  const candidates: string[] = []
  if (typeof input.file_path === 'string') candidates.push(input.file_path)
  if (Array.isArray(input.file_paths)) {
    for (const candidate of input.file_paths) if (typeof candidate === 'string') candidates.push(candidate)
  }
  // ast_edit 的 paths 数组（文件或目录）；缺省 ['.'] 不在此展开——默认值即 cwd 本身
  if (Array.isArray(input.paths)) {
    for (const candidate of input.paths) if (typeof candidate === 'string') candidates.push(candidate)
  }
  const paths: string[] = []
  for (const candidate of candidates) {
    if (!validatePathSafe(cwd, candidate, mode).ok) paths.push(resolvePath(cwd, candidate))
  }
  return paths.length > 0 ? { mode, paths } : null
}

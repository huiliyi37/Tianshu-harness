import { existsSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Tool } from './types.js'
import { expandHome } from '../platform.js'
import { grantPath, type GrantMode } from './path-grants.js'
import { detectSensitiveFile } from './sensitive-file-detector.js'

/** 不得作为授权根的系统级目录（issue #117）：一次批准即把本会话的读写面放大到
 *  整个系统区。用户自己的目录树不受影响。 */
const FORBIDDEN_GRANT_ROOTS = new Set([
  '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/var', '/opt', '/root', '/home',
  '/users', '/system', '/library', '/private', '/dev', '/proc', '/sys', '/boot',
  'c:\\windows', 'c:\\program files', 'c:\\program files (x86)', 'c:\\users',
])

/** 该路径是否不得作为授权根：POSIX 根 `/`、Windows 盘根 `C:\`、系统目录。 */
export function isForbiddenGrantRoot(target: string): boolean {
  const norm = target.replace(/[\\/]+$/, '')
  if (norm === '') return true
  if (/^[A-Za-z]:$/.test(norm)) return true
  return FORBIDDEN_GRANT_ROOTS.has(norm.toLowerCase())
}

/**
 * Explicitly request access to a path OUTSIDE the workspace. Requires user
 * approval (the normal approval round-trip). On approval, a directory-subtree
 * grant is recorded so subsequent file tools AND bash commands can read/write
 * there — without dropping the whole sandbox.
 *
 * This is the uniform mechanism for bash / multi-path / proactive grants where
 * the inline pipeline gate (which only inspects single-path file tools) cannot
 * statically see the target. For ordinary single-file out-of-workspace reads or
 * writes, just calling read_file/write_file triggers the inline grant prompt.
 */
export const REQUEST_PATH_ACCESS_TOOL: Tool = {
  definition: {
    name: 'request_path_access',
    description: `请求用户授权访问当前工作区之外的路径。

用于批量/目录级授权，或基于 bash 的工作区外操作。审批通过后，该目录子树
在本会话内可读/可写（用 remember=true 持久化）。对单个工作区外文件的
读写，直接调用 read_file/write_file 会触发同样的内联提示。`,
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要授权访问的工作区外路径（文件或目录），绝对路径或 ~ 相对路径。' },
        mode: { type: 'string', enum: ['read', 'write'], description: "访问级别。'write' 隐含读取权限。默认 'read'（最小权限；确需写请显式传 'write'）。" },
        remember: { type: 'boolean', description: '为当前工作区跨会话持久化此授权。默认 false（仅本会话）。' },
      },
      required: ['path'],
    },
  },

  async execute(params) {
    const raw = params.input.path
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      return { content: '错误：path 必填', isError: true }
    }
    // issue #117 — 缺省 read（最小权限）：缺省 write 叠加无上界授权根时，
    // 一次 request_path_access(path='/') 就能把本会话写权限放大到全磁盘。
    const mode: GrantMode = params.input.mode === 'write' ? 'write' : 'read'
    const remember = params.input.remember === true

    const target = resolve(expandHome(raw.trim()))
    // Grant the directory subtree: the path itself if it is (or will be) a
    // directory, otherwise its parent so the file + siblings are reachable.
    let root = target
    try {
      if (!(existsSync(target) && statSync(target).isDirectory())) root = dirname(target)
    } catch {
      root = dirname(target)
    }

    // issue #117 — 授权必须有上界：target 与其授权根都要查（`/etc/passwd` 的授权根
    // 是 `/etc`），根/系统目录与敏感文件一律拒绝。
    if (isForbiddenGrantRoot(target) || isForbiddenGrantRoot(root)) {
      return {
        content: `错误：拒绝授权文件系统根/系统目录（${target}）——请指定具体的工作子目录。`,
        isError: true,
      }
    }
    const sensitive = detectSensitiveFile(target)
    if (sensitive.sensitive) {
      return {
        content: `错误：拒绝授权敏感文件（${sensitive.patternName ?? '敏感路径'}）：${target}`,
        isError: true,
      }
    }

    // An interactive approval is ALWAYS scoped to this session's workspace —
    // a missing cwd must fall back to the process cwd, never to an unscoped
    // (process-wide) grant.
    const grant = grantPath(root, mode, { persist: remember, cwd: params.cwd ?? process.cwd() })
    const lifetime = remember ? '已为本工作区持久化（重启后仍有效）' : '仅本会话'
    return {
      content: `已授予 ${grant.mode} 访问：${grant.root}\n范围：该目录及其下全部路径 — ${lifetime}。\n文件工具与 bash 现在可以在此${grant.mode === 'write' ? '读写' : '读取'}路径。`,
    }
  },

  requiresApproval: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}

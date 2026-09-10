import { existsSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Tool } from './types.js'
import { expandHome } from '../platform.js'
import { grantPath, type GrantMode } from './path-grants.js'

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
        mode: { type: 'string', enum: ['read', 'write'], description: "访问级别。'write' 隐含读取权限。默认 'write'。" },
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
    const mode: GrantMode = params.input.mode === 'read' ? 'read' : 'write'
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

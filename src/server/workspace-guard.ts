/**
 * 已注册工作区守卫（issue #221）。
 *
 * `/project-docs`、`/project-templates/*`、`/project/trust` 都接受调用方给的 `cwd`。
 * project-docs 只有 `assertProjectPath`——它校验的是「固定文件名（AGENTS.md /
 * .rivet.md）不逃逸 cwd」，但 `cwd` 本身可以是任意目录。于是：
 *
 *   - `GET /project-docs?cwd=/etc` 读任意目录的 AGENTS.md
 *   - `PUT /project-docs {cwd:"/任意"}` 往任意目录写 AGENTS.md / .rivet.md
 *   - `POST /project/trust {cwd:"/任意"}` 给任意目录自我授信
 *   - `POST /project-templates/apply {cwd:"/任意"}` 往任意目录铺模板
 *
 * 影响是跨项目的提示注入投毒 + 任意读两个固定文件名（需 Bearer，属 API 鉴权而非
 * 用户同意）。现在这些路由的 `cwd` 必须精确命中一个已注册工作区——存活会话的 cwd
 * 加配置里的默认工作区。
 *
 * 精确匹配（而非前缀匹配）是有意的：工作区是会话注册过的那些目录，子目录不在其中
 * 就不该被这两个固定文件的路由触达。
 */
import { resolve } from 'node:path'
import { getWorkspaceConfig } from '../config/workspace-config.js'

/** 大小写不敏感文件系统的规范形（Windows / macOS）——同一目录的两种写法必须同判。 */
function canonical(p: string): string {
  const abs = resolve(p)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

/** `cwd` 是否命中 `known` 里的某个已注册工作区。 */
export function isKnownWorkspace(cwd: string, known: Iterable<string>): boolean {
  const target = canonical(cwd)
  for (const k of known) {
    if (k && canonical(k) === target) return true
  }
  return false
}

/**
 * 已注册工作区的来源：存活会话的 cwd + 配置里的默认工作区。
 *
 * 放在这里而不是 serve.ts——装配文件已顶到源码行数 ceiling（scripts/source-budgets.manifest.json），
 * 按该文件的惯例，逻辑外提、装配层只留一行调用。
 */
export function registeredWorkspaces(
  sessions: { listSessions(): Array<{ cwd: string }> } | undefined,
): string[] {
  const fromSessions = (sessions?.listSessions() ?? []).map((s) => s.cwd)
  const def = getWorkspaceConfig().defaultDir
  return def ? [...fromSessions, def] : fromSessions
}

export const UNKNOWN_WORKSPACE_ERROR = 'Unknown workspace: cwd is not a registered project'

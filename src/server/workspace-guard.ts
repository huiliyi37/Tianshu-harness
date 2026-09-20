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
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { getWorkspaceConfig } from '../config/workspace-config.js'
import { listTrustedProjects } from '../config/project-trust.js'

/** 规范形：realpath 优先（与 project-trust 的 canonicalProjectDir 同一口径——
 *  trust store 里存的就是 realpath 形；macOS 的 /var vs /private/var、符号链接路径
 *  若只做 resolve 会与它不匹配，导致「明明已授信却被 403」）。目录已不存在时退回
 *  resolve 形（在册目录可能被删/被移）；Windows 再叠一层小写同判。 */
function canonical(p: string): string {
  const abs = resolve(p)
  let real = abs
  try {
    real = realpathSync(abs)
  } catch {
    /* 路径不存在或不 canonicalizable——退回 resolve 形 */
  }
  return process.platform === 'win32' ? real.toLowerCase() : real
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
 * 已注册工作区的来源：存活会话的 cwd + 配置里的默认工作区 + **已授信目录**。
 *
 * 第三项是收编时的适配（2026-09-21，与 B6 授权总览联动）：总览页的立身之本是「能撤」，
 * 而撤销走 `POST /project/trust { trusted:false }` 带显式 cwd——若在册集合只看会话，
 * 用户对一个「以前信过、现在没开着会话」的目录就再也撤不掉（403）。把 trust store 里的
 * 目录并入**不削弱本门**：目录要么已在 store 里（只能重申或撤销，不产生新授权）， либо
 * 不在（仍然 403）；它挡的是「对任意新目录自我授信」这条提权路径。
 *
 * 放在这里而不是 serve.ts——装配文件已顶到源码行数 ceiling（scripts/source-budgets.manifest.json），
 * 按该文件的惯例，逻辑外提、装配层只留一行调用。
 */
export function registeredWorkspaces(
  sessions: { listSessions(): Array<{ cwd: string }> } | undefined,
): string[] {
  const fromSessions = (sessions?.listSessions() ?? []).map((s) => s.cwd)
  const def = getWorkspaceConfig().defaultDir
  return [...fromSessions, ...(def ? [def] : []), ...listTrustedProjects()]
}

export const UNKNOWN_WORKSPACE_ERROR = 'Unknown workspace: cwd is not a registered project'

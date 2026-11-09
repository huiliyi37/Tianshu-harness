/**
 * slash 命令 → agent prompt 的解析叶子模块。
 *
 * 从 `src/tui/slash-commands.ts` 迁出（serve 启动图瘦身）：sidecar 的
 * `session-routes` 只需要 `resolveAppPromptInput`，而 slash-commands 还静态
 * import `../bootstrap.js`（switchAgentRuntime，经它进 AgentLoop）与 TUI 主图——
 * 那一跳会把 agent 内核整张图带进 listen 之前的 serve 静态闭包。这里的依赖
 * 刻意保持为叶子：ecosystem-workflows / commands-loader / skill-loader / path-like。
 *
 * `slash-commands.ts` 保留同名再导出，main.ts 与既有测试 import 面不变。
 */
import { isAbsolute, join, relative } from 'node:path'
import { resolveCustomCommand } from '../commands/loader.js'
import { projectSurfaceAllowed } from '../config/project-trust.js'
import { skillRegistry, listSkillFiles, type SkillDefinition, type SkillRegistry, type SkillSource } from '../skills/skill-loader.js'
import { resolveEcosystemWorkflowInput } from '../workflows/ecosystem-workflows.js'
import { workspaceSkillSnapshot } from '../skills/workspace-skill-snapshot.js'
import { looksLikeFilePath } from './engine/path-like.js'

export interface ResolvedPromptInput {
  prompt: string
  skillInvoked?: string
  /** 见 WorkflowResolveResult.requiredTools。仅 ecosystem workflow 路径可能非空。 */
  requiredTools?: readonly string[]
}

/** /review 的审查对象参数（issue #563）：files/commit_ref/range 三选一，其余 token 作 focus。 */
export interface ReviewTargetArgs {
  files?: string[]
  commit_ref?: string
  range?: string
  focus?: string
}

export type ReviewTargetParse =
  | { ok: true; args: ReviewTargetArgs }
  | { ok: false; error: string }

export const REVIEW_TARGET_USAGE = '用法：/review [max] [files=[...] | commit_ref=<sha> | range=A..B] [focus]'

function parseFilesValue(raw: string): string[] | null {
  const inner = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw
  const files = inner.split(',').map(s => s.trim()).filter(Boolean)
  return files.length > 0 ? files : null
}

/**
 * 解析 /review 剩余 token 中的对象参数（issue #563；slash handler 与
 * resolveAppPromptInput 双门共用，避免两处解析漂移）。
 * files/commit_ref/range 互斥——冲突或非法值时报错，不静默丢弃（工具层是
 * files 优先的宽容语义，入口层显式报错更利于用户纠正）。
 */
export function parseReviewTargetArgs(tokens: readonly string[]): ReviewTargetParse {
  const args: ReviewTargetArgs = {}
  const focusParts: string[] = []
  let seen: 'files' | 'commit_ref' | 'range' | undefined
  for (const token of tokens) {
    const m = token.match(/^(files|commit_ref|range)=(.*)$/)
    if (!m) {
      focusParts.push(token)
      continue
    }
    const key = m[1] as 'files' | 'commit_ref' | 'range'
    const raw = m[2]!
    if (seen && seen !== key) {
      return { ok: false, error: `files/commit_ref/range 互斥，只能指定一个（已指定 ${seen}，又给了 ${key}）。${REVIEW_TARGET_USAGE}` }
    }
    seen = key
    if (key === 'files') {
      const files = parseFilesValue(raw)
      if (!files) return { ok: false, error: `files 参数无效：${raw}（应为 files=[a.ts,b.ts] 或 files=a.ts,b.ts）。${REVIEW_TARGET_USAGE}` }
      args.files = files
    } else if (key === 'commit_ref') {
      if (!raw.trim()) return { ok: false, error: `commit_ref 参数无效：不能为空。${REVIEW_TARGET_USAGE}` }
      args.commit_ref = raw.trim()
    } else {
      const [base, head] = raw.split('..')
      if (!raw.includes('..') || !base?.trim() || !head?.trim()) {
        return { ok: false, error: `range 参数无效：${raw} 不是合法区间（应为 A..B，例如 range=main..feature）。${REVIEW_TARGET_USAGE}` }
      }
      args.range = raw.trim()
    }
  }
  const focus = focusParts.join(' ').trim()
  if (focus) args.focus = focus
  return { ok: true, args }
}

export function resolveAppPromptInput(
  input: string,
  cwd: string,
  isKnownCommand?: (name: string) => boolean,
  pluginCommands?: { name: string; file: string }[],
  sessionRegistry?: SkillRegistry,
): ResolvedPromptInput | null {
  if (/^\/test\s+all\s*$/i.test(input)) return { prompt: '用户明确要求全量测试：调用 run_tests(full=true)，单环境执行；不要自动重跑或启动代码审查。' }
  if (!input.startsWith('/')) return { prompt: input, ...(/^(?:请|帮我|请帮我)?\s*(?:审查|做(?:一次|个)代码审查|review\b)/i.test(input.trim()) ? { requiredTools: ['review_changes'] } : {}) }
  const workflow = resolveEcosystemWorkflowInput(input)
  if (workflow) return { prompt: workflow.prompt, requiredTools: workflow.requiredTools }
  const custom = resolveCustomCommand(cwd, input, pluginCommands)
  if (custom) return { prompt: custom }
  const skillPrompt = resolveSkillPrompt(input, cwd, sessionRegistry)
  if (skillPrompt !== null) return { prompt: skillPrompt, skillInvoked: skillPrompt.match(/^\[Skill loaded: ([^\]]+)\]/)?.[1] }
  // /review off|on|status 是 TUI 本地会话开关——本路径（server/headless 映射层）没有
  // refs 可写。明确告知，而不是把 "off" 误当 focus 触发一次审查（白烧 worker token）。
  if (/^\/review\s+(?:off|on|status)\s*$/i.test(input)) {
    return { prompt: `User typed "${input}". This legacy review toggle is a compatibility no-op: commits do not run reviews. Manual /review [max] starts an independent read-only review.` }
  }
  // /review [max|l1|l2|l3] [focus description] — map to review_changes (契约分离：
  // 审查独立于提交，旧 deliver_task(review_level=...) 映射已移除)
  const reviewMatch = input.match(/^\/review(?:\s+(max|l1|l2|l3))?(?:\s+(.*))?$/i)
  if (reviewMatch) {
    const kw = reviewMatch[1]?.toLowerCase()
    if (kw === 'l1') return { prompt: '用户选择 L1 静态建议：仅核对范围与证据，不启动 worker。本次未执行独立代码审查或测试。' }
    const tokens = reviewMatch[2]?.trim() ? reviewMatch[2]!.trim().split(/\s+/) : []
    const parsed = parseReviewTargetArgs(tokens)
    if (!parsed.ok) {
      return { prompt: `User typed "${input}" which is not a valid /review target: ${parsed.error} Usage: /review [max] [files=[...] | commit_ref=<sha> | range=A..B] [focus].`, requiredTools: ['review_changes'] }
    }
    const { files, commit_ref, range, focus } = parsed.args
    const depth = kw === 'max' || kw === 'l3' ? 'max' : 'default'
    const levelLabel = depth === 'max'
      ? 'L3 read-only review formation (multiple inspectors)'
      : 'L2 single read-only reviewer'
    const targetParts: string[] = []
    if (files) targetParts.push(`files=${JSON.stringify(files)}`)
    if (commit_ref) targetParts.push(`commit_ref="${commit_ref}"`)
    if (range) targetParts.push(`range="${range}"`)
    const targetInstruction = targetParts.length > 0 ? ` with ${targetParts.join(' and ')}` : ''
    const focusInstruction = focus ? ` Focus specifically on: ${focus}.` : ''
    return { prompt: `Run an independent read-only code review: call review_changes with action="start" and depth="${depth}"${targetInstruction}. This launches ${levelLabel}.${focusInstruction} Review only; do not commit, test, or apply fixes.`, requiredTools: ['review_changes'] }
  }
  // /review typos — don't silently drop user input
  if (/^\/review/i.test(input)) {
    return { prompt: `User typed "${input}" which looks like a /review command but didn't match the expected format. Usage: /review [max] [focus description]. /review runs an independent read-only review via review_changes.` }
  }
  // 裸技能名直调（issue #100 建议②）：/name [task]——内置/workflow/自定义/网关
  // 均未命中后的兜底。必须放在 looksLikeFilePath 之前：单段 /name 在
  // isKnownCommand 谓词下会被判成「路径」原样透传，技能解析永远轮不到
  // （多段路径天然不匹配技能名，/etc 类单段路径无同名技能时仍落回路径分支）。
  const bareSkill = resolveBareSkillPrompt(input, cwd, sessionRegistry)
  if (bareSkill !== null) return { prompt: bareSkill, skillInvoked: bareSkill.match(/^\[Skill loaded: ([^\]]+)\]/)?.[1] }
  // Linux/WSL path like /etc, /mnt, /usr — not a recognized command, pass through
  // as plain text so the agent can handle it (e.g. "look at /etc/hosts").
  if (looksLikeFilePath(input, isKnownCommand)) return { prompt: input }
  // Unrecognized slash command — return null to signal "blocked"
  return null
}

const SKILL_RESERVED_SUBCOMMANDS = new Set(['inspect', 'add', 'mode', 'update', 'remove', 'doctor', 'generate', 'list', 'ls', 'install', 'import', 'review', 'drafts', 'approve', 'reject', 'off', 'complete'])

/**
 * 项目槽位技能来源：backing 文件随仓库分发（.rivet/skills / .agents/skills），未授信
 * 等同仓库内容指令。'project-claude' 当前不进任何 registry（仅 listInstallableSkills
 * 的扫描标记），列入是 fail-closed——未来若新增其装载路径，忘了同步此集合也不会
 * 静默放行。失效方向：宁可多门一个来源值，不漏项目槽位（漏判 = 仓库内容进用户消息）。
 */
const PROJECT_SLOT_SKILL_SOURCES: ReadonlySet<SkillSource> = new Set(['rivet', 'project-agents', 'project-claude'])

/**
 * 技能是否项目槽位（随仓库分发）。主判据是 loader 写入的 source；source 缺失时回落
 * backing 文件物理位置（早期会话快照可能没冻 source）——只判路径归属不判文件存在，
 * 全局技能（home 目录）与内置技能（无 backing 文件）永不落在 cwd 这两个子目录下，
 * 误判只可能往「不展开」侧倒，不误伤全局技能。
 */
export function isProjectSlotSkill(skill: SkillDefinition, cwd: string): boolean {
  if (skill.source && PROJECT_SLOT_SKILL_SOURCES.has(skill.source)) return true
  for (const p of [skill.bodyPath, skill.skillDir]) {
    if (!p) continue
    for (const root of [join(cwd, '.rivet', 'skills'), join(cwd, '.agents', 'skills')]) {
      const rel = relative(root, p)
      if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return true
    }
  }
  return false
}

/** 技能查找 + prompt 展开（/skill 网关与裸名直调共用）。未命中返回 null。 */
function buildSkillPrompt(name: string, userTask: string, cwd?: string, sessionRegistry?: SkillRegistry): string | null {
  const registry = sessionRegistry ?? (cwd ? workspaceSkillSnapshot(cwd).registry : skillRegistry)
  const skill = registry.get(name) ?? registry.list().find(s => s.name.toLowerCase() === name.toLowerCase())
  if (!skill) return null
  // 未授信项目按 origin 门项目槽位技能（2026-10-07 审计 Finding 1 第二入口；
  // 2026-10-08 由一刀切细化为按 origin 判门——一刀切把用户全局 ~/.rivet/skills 与
  // 内置技能也封死，属可用性误伤：它们是用户自有/随发行版内容，不受项目信任门管辖）。
  // workspaceSkillSnapshot/sessionSkillSnapshot 装载侧已排项目目录，此门兜底的窄例是
  // 「授信期冻结的 session 快照在撤信后仍含项目技能」——快照按 pinned 语义原样读回，
  // 必须在展开前判 origin。cwd 缺席时 registry 回落全局 skillRegistry（已受
  // loadProjectSkills 门保护）；生产调用点（main.ts onSubmit、session-skills-helper、
  // session-manager.createSession）均传 cwd。
  if (cwd && isProjectSlotSkill(skill, cwd) && !projectSurfaceAllowed(cwd, 'skills')) return null
  if (skill.mode === 'off') return `Skill「${skill.name}」已停用，请先启用。`
  registry.ensureResources(skill.name)
  let prompt = `[Skill loaded: ${skill.name}]\n<skill name="${skill.name}">\n${skill.body}\n</skill>`
  if (skill.skillDir) {
    const files = skill.files ?? listSkillFiles(skill.skillDir)
    if (files.length > 0) {
      prompt += `\n<skill-files dir="${skill.skillDir}" note="Read on demand with read_file/grep/glob; page large sub-files completely with offset/limit.">\n${files.map(f => '  ' + f.path).join('\n')}\n</skill-files>`
    }
  }
  if (userTask) {
    prompt += `\n\nUser task: ${userTask}`
  }
  return prompt
}

/**
 * Resolve `/skill <name> [user task...]` into the skill's full body prompt.
 * Reserved subcommands (list/install/etc.) and unknown skills return null so
 * they fall back to the slash handler's local behavior or error message.
 */
function resolveSkillPrompt(input: string, cwd: string, sessionRegistry?: SkillRegistry): string | null {
  const match = input.trim().match(/^\/skill\s+(\S+)(?:\s+(.*))?$/s)
  if (!match) return null
  const name = match[1]!
  if (SKILL_RESERVED_SUBCOMMANDS.has(name.toLowerCase())) return null
  return buildSkillPrompt(name, match[2]?.trim() ?? '', cwd, sessionRegistry)
}

/**
 * 裸技能名直调（issue #100 建议②，Claude Code「技能即斜杠命令」形态）：
 * `/name [task...]` 命中技能注册表则展开为 skill prompt。只在内置/workflow/
 * 自定义/网关全部未命中后兜底——同名技能被内置遮蔽但仍可经 /skill <name>
 * 显式唤起。多段路径天然不匹配（技能名不含 /）；单段路径（/etc）只有用户
 * 真建了同名技能才会被接管——那正是用户意图。
 */
export function resolveBareSkillPrompt(input: string, cwd?: string, sessionRegistry?: SkillRegistry): string | null {
  const match = input.trim().match(/^\/([^\s/]+)(?:\s+(.*))?$/s)
  if (!match) return null
  const name = match[1]!
  if (SKILL_RESERVED_SUBCOMMANDS.has(name.toLowerCase())) return null
  return buildSkillPrompt(name, match[2]?.trim() ?? '', cwd, sessionRegistry)
}

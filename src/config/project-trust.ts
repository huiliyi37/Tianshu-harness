/**
 * Project trust —— 项目级配置/hooks 信任门。
 *
 * SECURITY.md 信任边界：仓库内容（含项目内 .rivet/hooks.json 与 .rivet-config.json）
 * 不能单独构成执行动作的授权。项目在用户显式授信（TUI /trust、CLI --trust 或
 * RIVET_TRUST_PROJECT=1）之前，项目级 hooks 不执行、项目级配置中的安全敏感键
 * 被 loadConfig 剥离——fail-closed。授信决策持久化在
 * `<rivetHome>/project-trust.json`（按 realpath 键控，永不写进仓库目录）。
 *
 * RIVET_TRUST_PROJECT 优先级高于信任文件：'1' 视为已授信（CI/无头场景），
 * '0' 强制未授信（审计）。其他值忽略，回落文件判定。
 */

import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { rivetHome } from './paths.js'
import { writeFileAtomicSync } from '../fs-atomic.js'

interface TrustStore {
  /** realpath(项目目录) → 授信时间（ISO 字符串）。 */
  trusted: Record<string, string>
  /** realpath(项目目录) → 关闭启动授信提示的时间（ISO 字符串）。 */
  dismissed: Record<string, string>
}

const ENV_OVERRIDE = 'RIVET_TRUST_PROJECT'

function trustStorePath(): string {
  return join(rivetHome(), 'project-trust.json')
}

function canonicalProjectDir(cwd: string): string {
  try {
    return realpathSync(resolve(cwd))
  } catch {
    return resolve(cwd)
  }
}

function readTrustStore(): TrustStore {
  try {
    const raw = JSON.parse(readFileSync(trustStorePath(), 'utf-8')) as Partial<TrustStore>
    if (raw && typeof raw === 'object') {
      return {
        trusted: raw.trusted && typeof raw.trusted === 'object' ? raw.trusted : {},
        dismissed: raw.dismissed && typeof raw.dismissed === 'object' ? raw.dismissed : {},
      }
    }
  } catch {
    // 缺失/坏文件按未授信处理——fail-closed
  }
  return { trusted: {}, dismissed: {} }
}

function writeTrustStore(store: TrustStore): void {
  const dir = rivetHome()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileAtomicSync(trustStorePath(), JSON.stringify(store, null, 2) + '\n')
}

/** 项目目录是否已被用户授信。env 覆盖优先，其次信任文件。 */
export function isProjectTrusted(cwd: string): boolean {
  const env = process.env[ENV_OVERRIDE]
  if (env === '1') return true
  if (env === '0') return false
  return Object.prototype.hasOwnProperty.call(readTrustStore().trusted, canonicalProjectDir(cwd))
}

/** 授信当前项目（幂等；同时清除"不再提示"标记——重新授信即重新参与启动提示语义）。 */
export function trustProject(cwd: string): void {
  const key = canonicalProjectDir(cwd)
  const store = readTrustStore()
  const hadDismissed = Object.prototype.hasOwnProperty.call(store.dismissed, key)
  if (hadDismissed) delete store.dismissed[key]
  if (Object.prototype.hasOwnProperty.call(store.trusted, key)) {
    if (hadDismissed) writeTrustStore(store)
    return
  }
  store.trusted[key] = new Date().toISOString()
  writeTrustStore(store)
}

/** 撤销授信（幂等；未授信时为 no-op）。 */
export function untrustProject(cwd: string): void {
  const key = canonicalProjectDir(cwd)
  const store = readTrustStore()
  if (!Object.prototype.hasOwnProperty.call(store.trusted, key)) return
  delete store.trusted[key]
  writeTrustStore(store)
}

/** 关闭当前项目的启动授信提示（幂等）。不授信——安全键仍被剥离。 */
export function dismissProjectTrustPrompt(cwd: string): void {
  const key = canonicalProjectDir(cwd)
  const store = readTrustStore()
  if (Object.prototype.hasOwnProperty.call(store.dismissed, key)) return
  store.dismissed[key] = new Date().toISOString()
  writeTrustStore(store)
}

/** 当前项目是否已关闭启动授信提示。 */
export function isTrustPromptDismissed(cwd: string): boolean {
  return Object.prototype.hasOwnProperty.call(readTrustStore().dismissed, canonicalProjectDir(cwd))
}

/** 列出已授信项目（realpath 数组，调试/命令面板用）。 */
export function listTrustedProjects(): string[] {
  return Object.keys(readTrustStore().trusted)
}

/**
 * 列出已授信项目**带授信时间**（桌面端「授权总览」页用）。
 * 时间倒序（最近授信在前）——用户来这页多半是"我最近信过谁"或"我要撤掉谁"。
 * 缺失/坏时间戳不丢条目：排到最后（`''`），列表宁多不少。
 */
export function listTrustedProjectEntries(): { path: string; trustedAt: string }[] {
  const trusted = readTrustStore().trusted
  return Object.entries(trusted)
    .map(([path, trustedAt]) => ({ path, trustedAt: typeof trustedAt === 'string' ? trustedAt : '' }))
    .sort((a, b) => (a.trustedAt < b.trustedAt ? 1 : a.trustedAt > b.trustedAt ? -1 : a.path.localeCompare(b.path)))
}

/** 单次进程内提示去重——hooks 每事件读取、config 可能 HMR 重载、prompt 每次用户
 *  边界重建，避免刷屏。 */
const noticed = new Set<string>()

/** 信任门族：未授信即拒绝的项目表面（2026-10-07 安全审计补齐；2026-10-09 补 capsules）。 */
export type UntrustedProjectSurface = 'skills' | 'rules' | 'commands' | 'playbook' | 'presence' | 'agents' | 'plans' | 'capsules'

/** 各表面未授信跳过时的一次性提示文案。 */
const SURFACE_NOTICE: Record<UntrustedProjectSurface, string> = {
  skills: '项目技能目录（.rivet/skills / .agents/skills）',
  rules: '项目规则目录（.rivet/rules）',
  commands: '项目命令目录（.rivet/commands）',
  playbook: '项目教训库（.rivet/playbook.jsonl）',
  presence: '项目在线状态文件（.rivet/presence.json）',
  agents: '项目装配目录（.rivet/agents / .rivet/domains）',
  plans: '项目计划目录（.rivet/plans）',
  capsules: '项目胶囊目录（docs/seed-capsule-*.md）',
}

export function notifyUntrustedOnce(
  kind: 'hooks' | 'config' | 'project-instructions' | 'project-state' | UntrustedProjectSurface,
  projectDir: string,
  strippedKeys?: string[],
): void {
  const key = `${kind}:${projectDir}`
  if (noticed.has(key)) return
  noticed.add(key)
  const how = `TUI 执行 /trust 授信（或启动加 --trust / 设 RIVET_TRUST_PROJECT=1）`
  const keyList = strippedKeys && strippedKeys.length > 0
    ? strippedKeys.join('/')
    : 'permissions/mcp/hooks/providers/env/plugins/mirrors/network/fetch/ui.statusLine/agent.approval 等'
  const what = kind === 'hooks'
    ? `检测到项目 hooks（${join(projectDir, '.rivet', 'hooks.json')}），项目未授信，已跳过执行`
    : kind === 'project-instructions'
      ? `检测到项目指令（${join(projectDir, 'AGENTS.md')} / ${join(projectDir, '.rivet.md')}），项目未授信，已跳过注入——未进入模型上下文`
      : kind === 'project-state'
        ? `检测到项目状态文件（${join(projectDir, '.rivet', 'knowledge', 'memory.jsonl')} / ${join(projectDir, '.rivet', 'knowledge', 'manifest.md')}），项目未授信，已跳过注入——未进入模型上下文`
        : kind === 'config'
          ? `检测到项目配置（${join(projectDir, '.rivet-config.json')}），项目未授信，其中安全敏感键（${keyList}）已忽略`
          : `检测到${SURFACE_NOTICE[kind]}，项目未授信，已跳过——未进入模型上下文`
  console.error(`[rivet] ${what}——${how}。信任决策存于 ${trustStorePath()}，绝不写回仓库。`)
}

/**
 * 项目配置里的安全档位被永久门忽略时的一次性提示。**授信与否都提示**——
 * 静默失效正是本修复要杜绝的（用户以为项目设的档生效了，实际没有）。
 */
export function notifyProjectSafetyKeysIgnored(projectDir: string, keys: string[]): void {
  const noticeKey = `safety:${projectDir}`
  if (noticed.has(noticeKey)) return
  noticed.add(noticeKey)
  console.error(
    `[rivet] 项目配置 ${join(projectDir, PROJECT_CONFIG_FILE_NAME)} 里的安全档位`
    + `（${keys.join('/')}）已忽略——审批档 / 沙箱豁免 / 授权规则不来自项目配置`
    + `（安全设计，授信与否一致）。请在全局配置（~/.rivet/config.json）或 CLI`
    + `（--approval-mode）设置。`,
  )
}

/** 目录内是否存在项目指令文件（AGENTS.md / .rivet.md）——供未受信时的跳过提示判定。 */
export function hasProjectInstructionFiles(cwd: string): boolean {
  return existsSync(join(cwd, 'AGENTS.md')) || existsSync(join(cwd, '.rivet.md'))
}

/**
 * 项目指令（AGENTS.md / .rivet.md）是否允许进入模型上下文 —— issue #218。
 *
 * 未受信目录一律不读：这二者是**仓库内容**，等同于让陌生人在你的会话里下指令
 * （SECURITY.md 的信任边界声明）。受信（/trust、--trust、RIVET_TRUST_PROJECT）
 * 后照旧。存在指令文件时发一次性提示，免得用户莫名发现自己的 AGENTS.md 没生效。
 *
 * 封装在这里而不是两个 prompt 调用点各写一遍：volatile.ts 已顶到源码行数
 * ceiling，且 volatile.ts 与 volatile-snapshot.ts 必须保持同一契约。
 */
export function projectInstructionsAllowed(cwd: string): boolean {
  if (isProjectTrusted(cwd)) return true
  if (hasProjectInstructionFiles(cwd)) notifyUntrustedOnce('project-instructions', cwd)
  return false
}

/** 目录内是否存在项目状态注入文件（.rivet/knowledge 的记忆、索引与 commit 事实侧车）——供未受信时的跳过提示判定。 */
export function hasProjectStateInjectionFiles(cwd: string): boolean {
  const knowledgeDir = join(cwd, '.rivet', 'knowledge')
  return existsSync(join(knowledgeDir, 'memory.jsonl'))
    || existsSync(join(knowledgeDir, 'manifest.md'))
    || existsSync(join(knowledgeDir, 'commit-facts.jsonl'))
}

/**
 * 项目状态（.rivet/knowledge/ 下的 memory.jsonl 项目记忆、manifest.md 知识索引、
 * commit-facts.jsonl 事实侧车）是否允许进入模型上下文 —— #218 信任门的 .rivet
 * 状态面扩展（2026-10-03 安全报告，链 A/B）。
 *
 * 这些文件物理上位于仓库内、可随仓库分发，却以权威化框架（<project-memory> 的
 * user_constraint / manifest 路由索引 / recall 事实结果）注入上下文——与 AGENTS.md
 * 同属「随仓库分发的指令」注入面。未受信目录一律不读不注入，与
 * projectInstructionsAllowed 同契约。门同时下沉到各读取函数内部（含
 * project-memory-writer.readCommitFacts）。
 */
export function projectStateAllowed(cwd: string): boolean {
  if (isProjectTrusted(cwd)) return true
  if (hasProjectStateInjectionFiles(cwd)) notifyUntrustedOnce('project-state', cwd)
  return false
}

/** 各表面在项目目录下的存在性探测路径（未授信时用于决定是否发一次性提示）。 */
const UNTRUSTED_SURFACE_PATHS: Readonly<Record<UntrustedProjectSurface, readonly string[]>> = {
  skills: ['.rivet/skills', '.agents/skills'],
  rules: ['.rivet/rules'],
  commands: ['.rivet/commands'],
  playbook: ['.rivet/playbook.jsonl'],
  presence: ['.rivet/presence.json'],
  agents: ['.rivet/agents', '.rivet/domains'],
  plans: ['.rivet/plans'],
  // capsules 的存在性探测是文件名模式匹配（docs/seed-capsule-*.md），由
  // seed-capsule-store 的 loadAllCapsules 侧完成后直报 notifyUntrustedOnce；
  // 此表对 capsules 不参与通知判定（空数组兜底，projectSurfaceAllowed('capsules')
  // 仅剩「未授信即拒绝」语义）。
  capsules: [],
}

/**
 * 项目表面（skills/rules/commands/playbook/presence/agents/plans）是否允许读取/注入。
 * 与 projectStateAllowed / projectInstructionsAllowed 同契约：未授信一律不读不注入
 * （2026-10-07 安全审计：信任门族补齐——门必须下沉到读取函数内部，防新调用点漏）。
 * 不缓存跳过结论——/trust 授信后当次会话内即时生效（与 verify-config 同约定）。
 */
export function projectSurfaceAllowed(cwd: string, surface: UntrustedProjectSurface): boolean {
  if (isProjectTrusted(cwd)) return true
  if (UNTRUSTED_SURFACE_PATHS[surface].some(p => existsSync(join(cwd, p)))) {
    notifyUntrustedOnce(surface, cwd)
  }
  return false
}

export const PROJECT_CONFIG_FILE_NAME = '.rivet-config.json'

/** 未授信时从项目层配置剥离的顶层键——任一键都能把 SECURITY.md 声明的
 *  审批/边界/出口控制整体旁路（写盘授权、bash 预授权、静默 YOLO、假 shell、
 *  MCP 拉进程、baseUrl+key 重定向、statusline 命令执行、verify 声明命令执行、
 *  搜索 key 外发、镜像路由安装源、启停已装插件、**MCP 子进程出口改向**、
 *  **web_fetch 正文抽取改向**）。
 *  network 键经 readNetworkConfigSafe → buildStdioChildEnv 把 proxy 注入每个
 *  MCP stdio 子进程的 HTTPS_PROXY/HTTP_PROXY（2026-09 核验补漏）。fetch 键的
 *  jinaBaseUrl 把 web_fetch 每次正文抽取改道 `${base}/${目标URL}`——目标 URL
 *  外发 + 攻击者控制的 markdown 回流 agent 上下文（与 network 同类的出口改向，
 *  2026-09-11 发版审查补漏）。注意 schema
 *  的 permissions 实际嵌在 agent 下（agent.permissions），顶层 permissions 是
 *  不存在的键——保留在集合里仅作纵深。 */
const UNTRUSTED_TOP_LEVEL_KEYS = new Set([
  'permissions', 'mcp', 'hooks', 'env', 'provider', 'providers', 'search', 'verify',
  'plugins', 'mirrors', 'network', 'fetch',
])

/** 未授信时剥离的嵌套键（点路径相对项目层配置根）。 */
const UNTRUSTED_NESTED_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['agent', 'approval'],
  ['agent', 'unsandboxed'],
  // schema 的真实位置：allow/deny 规则、bash 预授权白名单、additionalRead/WriteDirs
  // 常驻目录授权（bootstrap/serve-agent 启动即生效、零审批）都在 agent.permissions 下。
  ['agent', 'permissions'],
  ['ui', 'statusLine'],
  ['skills', 'importFromClaude'],
]

/** 返回剥离后的浅拷贝；原对象不被修改。仅外观/工具选择等非授权键保留。 */
export function stripUntrustedProjectKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (UNTRUSTED_TOP_LEVEL_KEYS.has(key)) continue
    out[key] = value
  }
  for (const [parent, child] of UNTRUSTED_NESTED_KEYS) {
    const node = out[parent]
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      const clone = { ...(node as Record<string, unknown>) }
      delete clone[child]
      out[parent] = clone
    }
  }
  return out
}

/**
 * 项目配置层**永久**不得设置的安全档位（与信任无关）——点路径相对项目层配置根。
 *
 * 与 `UNTRUSTED_NESTED_KEYS`（信任门：未授信才剥离）不同，这组键是**用户本人的
 * 安全决定**（审批档 / 沙箱豁免 / 授权规则），不是「项目内容配置」。因此仓库内容
 * （含**已授信**项目）都不得设置它们——授信只应信任项目的编码内容，不应顺带授权
 * 「是否禁用审批」。参照 deepseek-harness：approval policy 无外部 config store，
 * 工作目录文件对它零路径；天枢等价 = 这三个键不进 project config 层。
 *
 * 合法来源保留：内置默认 / 用户全局 config / profile / CLI flag / 运行时切换。
 */
const PROJECT_FORBIDDEN_SAFETY_NESTED_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['agent', 'approval'],
  ['agent', 'unsandboxed'],
  ['agent', 'permissions'],
]

/**
 * 剥离项目层**永久**禁止设置的安全档位（agent.approval / agent.unsandboxed /
 * agent.permissions）。与 `stripUntrustedProjectKeys` 同形：返回浅拷贝，原对象
 * 不被修改，非安全键保留。**授信与否都调用**——这是「永久门」，独立于信任门。
 */
export function stripProjectSafetyKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw }
  for (const [parent, child] of PROJECT_FORBIDDEN_SAFETY_NESTED_KEYS) {
    const node = out[parent]
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      const clone = { ...(node as Record<string, unknown>) }
      delete clone[child]
      out[parent] = clone
    }
  }
  return out
}

/** 列出项目层实际存在、会被永久剥离的安全档位（点路径），供提示。 */
export function findForbiddenProjectSafetyKeys(raw: Record<string, unknown>): string[] {
  const found: string[] = []
  for (const [parent, child] of PROJECT_FORBIDDEN_SAFETY_NESTED_KEYS) {
    const node = raw[parent]
    if (node && typeof node === 'object' && !Array.isArray(node)
      && Object.prototype.hasOwnProperty.call(node, child)) {
      found.push(`${parent}.${child}`)
    }
  }
  return found
}

/** 列出项目层配置中实际存在、未授信时会被剥离的敏感键（嵌套键报点路径）。 */
export function findSensitiveProjectKeys(raw: Record<string, unknown>): string[] {
  const found: string[] = []
  for (const key of Object.keys(raw)) {
    if (UNTRUSTED_TOP_LEVEL_KEYS.has(key)) found.push(key)
  }
  for (const [parent, child] of UNTRUSTED_NESTED_KEYS) {
    const node = raw[parent]
    if (node && typeof node === 'object' && !Array.isArray(node)
      && Object.prototype.hasOwnProperty.call(node, child)) {
      found.push(`${parent}.${child}`)
    }
  }
  return found
}

export interface ProjectTrustStakes {
  /** 项目配置中**授信后会生效**的敏感键（点路径）——即「信任的赌注」。
   *  不含永久门剥离的安全档位（那些授信与否都不生效）。 */
  sensitiveKeys: string[]
  /** 项目配置中的安全档位（approval / unsandboxed / permissions）——无论是否授信
   *  都被忽略，**不构成信任赌注**，但需如实告知用户（杜绝静默失效）。 */
  ignoredSafetyKeys: string[]
  /** 是否存在项目级 hooks（.rivet/hooks.json）。 */
  hasHooks: boolean
  /** 是否存在项目级技能目录（.rivet/skills 或 .agents/skills）——授信后装载，
   *  未授信不装载（2026-10-07 审计 Finding 2：纯技能仓库也要触发授信提示）。 */
  hasSkills: boolean
  /** 是否存在项目级规则目录（.rivet/rules）——授信后载入 claimStore，未授信不载入。 */
  hasRules: boolean
}

/** 某敏感键是否为永久门剥离的安全档位（授信与否都不生效）。 */
function isForbiddenSafetyKey(dotted: string): boolean {
  return PROJECT_FORBIDDEN_SAFETY_NESTED_KEYS.some(([parent, child]) => `${parent}.${child}` === dotted)
}

/**
 * 启动授信提示的赌注检测：项目里有没有"未授信就会失效"的东西。
 * 配置文件读失败/无敏感键且无 hooks → 无赌注，不该打扰用户。
 *
 * 安全档位（approval / unsandboxed / permissions）单独归入 `ignoredSafetyKeys`：
 * 它们不随授信生效（永久门），所以**不算赌注**——把它们列进「信任以启用」会误导。
 */
export function detectProjectTrustStakes(cwd: string): ProjectTrustStakes {
  let all: string[] = []
  try {
    const raw: unknown = JSON.parse(readFileSync(join(cwd, PROJECT_CONFIG_FILE_NAME), 'utf-8'))
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      all = findSensitiveProjectKeys(raw as Record<string, unknown>)
    }
  } catch {
    // 配置文件缺失/坏 JSON → 无配置侧赌注
  }
  return {
    sensitiveKeys: all.filter(key => !isForbiddenSafetyKey(key)),
    ignoredSafetyKeys: all.filter(key => isForbiddenSafetyKey(key)),
    hasHooks: existsSync(join(cwd, '.rivet', 'hooks.json')),
    hasSkills: existsSync(join(cwd, '.rivet', 'skills')) || existsSync(join(cwd, '.agents', 'skills')),
    hasRules: existsSync(join(cwd, '.rivet', 'rules')),
  }
}

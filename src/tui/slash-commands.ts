import type { AgentLoop } from '../agent/loop.js'
import type { SessionContext } from '../agent/context.js'
import { looksLikeFilePath } from './engine/app.js'
import { SessionPersist, getSessionDir } from '../agent/session-persist.js'
import { forkSession, listBranches, countMessageLines } from '../agent/session-fork.js'
import { type StarDomainId } from '../agent/star-domain.js'
import { starDomainRegistry } from '../agent/star-domain-registry.js'
import { DOMAIN_SWITCH_CACHE_WARNING } from '../agent/domain-picker-entries.js'
import { getCapsuleByStar, listCapsuleStars } from '../agent/seed-capsule-store.js'
import { microCompactOai, estimateOaiTokens } from '../compact/micro.js'
import { rollbackToCheckpoint, getRollbackPreview } from '../agent/checkpoint.js'
import { runResumePreflightOai } from '../context/resume-preflight.js'
import { resolveCustomCommand } from '../commands/loader.js'
import { trustProject, untrustProject, isProjectTrusted, listTrustedProjects, isTrustPromptDismissed } from '../config/project-trust.js'
import { getTheme, setTheme, getActiveThemeName, THEMES, listCustomThemes } from './theme.js'
import {
  checkForUpdate,
  detectInstallRoot,
  formatUpdateBanner,
  restartProcess,
  runUpdate,
  spawnWindowsSelfUpdate,
} from './updater.js'
import { PhaseTracker } from './phase-tracker.js'
import { createLogEntry, type LogEntry } from './log-state.js'
import { getPaletteCommands } from './command-palette.js'
import { handleYoloToggle } from './yolo-toggle.js'
import { openInEditor } from './external-editor.js'
import { formatMissionStrip } from './mission.js'
import { PANEL_LABELS, PANELS, type Panel } from './cockpit/types.js'
import type { SummaryState } from './summary-state.js'
import type { ContextClaimStore } from '../context/claim-store.js'
import type { ContextClaimStatus } from '../context/claims.js'
import { loadProjectRules } from '../context/rules-loader.js'
import { exportDurableClaims, importClaims } from '../context/claim-export.js'
import { resolveEcosystemWorkflowInput } from '../workflows/ecosystem-workflows.js'
import { formatVolatilePayloadReport } from '../context/payload-diagnostic.js'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { buildHandoffPrompt } from './handoff.js'
import { ensureVerifyDeclaration, renderRivetMdStack, upsertStackSection } from '../bootstrap/verify-declaration.js'
import { exportsDir } from '../config/paths.js'
import { listPlans, rejectPlan, resolvePlanOptionLabel, resolvePlanRef, stripCopiedTitleSuffix } from '../plan/plan-store.js'
import { approvePlanWithGuards } from '../plan/plan-approval.js'
import { fullRebuild, generateCodebaseIndexBlock, getHeadSha } from '../repo/codebase-index.js'
import { isDiagramType, buildDiagramDoc, renderDiagramBlock, formatDiagramList } from './diagram-templates.js'
import { renderRecoveryStack } from '../agent/recovery-stack.js'
import { skillRegistry, listSkillFiles, importSkillsIntoRivet, countInstalledSkills, RECOMMENDED_MAX_SKILLS, SKILL_RESTRAINT_NOTICE } from '../skills/skill-loader.js'
import { listSkillDrafts, approveSkillDraft, rejectSkillDraft } from '../agent/skill-distill.js'
import { formatReviewHealthLine } from '../agent/review-health.js'
import {
  loadConstellation,
  initConstellation,
  surveySkeleton,
  appendMilestone,
} from '../constellation/store.js'
import { formatConstellationView, formatConstellationHistory } from '../constellation/format.js'
import { extractMilestone, buildDepartureMilestone } from '../constellation/milestone.js'
import { shortHash } from '../constellation/schema.js'
import { buildAgentMark, VOID_SYMBOL } from '../agent/void-identity.js'

import type { TuiApp } from './engine/app.js'
import type { SlashCommand } from './slash-command-registry.js'
import type { BootstrapContext } from '../bootstrap.js'
import type { Config } from '../config/schema.js'
import { isProFeatureEnabled } from '../config/pro-license.js'
import { loadConfig, saveConfig, registerVisionModelConfig } from '../config/manager.js'
import { discoverVisionModels, validateVisionModel } from '../api/vision-model-onboarding.js'
import { PROVIDER_PRESETS, isProviderPresetKey } from '../config/provider-presets.js'
import { installPlugin, removePlugin, getInstalledPlugins, isPluginInstalled } from '../plugins/plugin-installer.js'
import { parseManifest } from '../plugins/manifest.js'
import { PLUGIN_PRESETS } from '../plugins/plugin-presets.js'
import { switchAgentRuntime, switchAgentSession, switchAgentCwd, restorePlanModeFromMeta } from '../bootstrap.js'
import { loadTodos, setTodoSession } from '../tools/todo.js'
import { rememberUserNote, listUserNotes } from '../memory/user-remember.js'
import { restoreGoalTracker } from '../agent/goal-persist.js'
import { setPlanSession } from '../agent/plan-store.js'
import { formatPermissionLabel, parsePermissionAlias, tierToMode } from '../agent/approval-vocabulary.js'
import { isToolAllowed, isToolDenied, isBashCommandAllowlisted, isBashCommandDenied } from '../agent/permissions.js'
import { getMirrorConfig, setMirrorConfig, setCheckpointConfig, setApprovalMode as persistApprovalDefault } from '../config/manager.js'
import { grantPath, listPersistedGrants } from '../tools/path-grants.js'
import { SettingsFlow } from './settings-flow.js'
import { loadSettingsDraft, loadSettingsEnv, saveSettings } from './settings-persist.js'
import { formatMirrorStatus } from '../tools/mirror-env.js'
import { detectEnv, formatEnvGuidance, recommendUvSetup, isPythonProject } from '../tools/env-check.js'
import { getResolvedEnv, getResolvedPathDiff } from '../tools/resolved-env.js'
import { getShellCommand } from '../platform.js'
import { createCoordinatorReviewDeps } from '../agent/review-coordinator-deps.js'
import { consumePendingReview, peekPendingReview } from '../agent/post-commit-review-pending.js'
import { routeReviewWorkflow, type ReviewMode, type ReviewOutcome } from '../agent/review-router.js'
import type { ChangeSet } from '../agent/review-discipline.js'
import { HELP_TEXT } from './format/help-text.js'

/**
 * Framework-agnostic mutable ref. Structurally compatible with React's
 * `MutableRefObject<T>` (`{ current: T }`) AND the T9 engine's plain
 * `MutableRef` adapter, so the non-React SlashRouter no longer needs to fake a
 * React type with `as unknown as React.MutableRefObject<...>` / `as any`.
 */
export interface MutableRefLike<T> {
  current: T
}

export interface SlashHandlerContext {
  parts: string[]
  config: Config
  agent: AgentLoop
  session: SessionContext
  persist: SessionPersist
  model: string
  maxTokens: number
  availableModels: Array<{ id: string; alias: string; supportsVision?: boolean }>
  onModelSwitch: (modelId: string) => { ok: boolean; error?: string }
  allProviders: Record<string, { models: Array<{ id: string; alias: string; supportsVision?: boolean }>; userSaved?: boolean }>
  currentProvider: string
  currentSessionId: string
  /**
   * Runtime session identity switch for /resume <id>. Rebuilds the agent runtime
   * against the target session so subsequent messages/logs write to the SAME id.
   * Returns the loaded message count or an error. Undefined → /resume falls back
   * to the legacy in-memory-only restore (no identity switch).
   */
  onSessionSwitch?: (targetId: string) => { ok: boolean; error?: string; messageCount?: number; repaired?: boolean; safe?: boolean }
  /** Open the interactive session picker overlay (Chronicle). Wired by the TUI;
   *  /resume with no argument opens it instead of printing usage (Claude Code
   *  parity). Undefined → fall back to the usage hint (tests / headless). */
  openSessionPicker?: () => void
  /** Open the interactive /init scaffolding wizard (verify / skills / hooks).
   *  Wired by the TUI; undefined → /init prints a hint to use /init verify. */
  openInitFlow?: () => void
  /** Runtime cwd switch for /cd <path>. Rebuilds the agent runtime against the
   *  new working directory with frozen-snapshot inheritance (prefix cache only
   *  tail-cuts at the next user boundary). Async: drains pending persist writes
   *  before migrating session files. Undefined → /cd prints current cwd
   *  and a hint that switching is unavailable (tests / headless). */
  onCwdSwitch?: (target: string) => Promise<{ ok: boolean; error?: string; from?: string; to?: string; movedFiles?: string[] }>
  cost: number
  cacheHitRate: number
  autoSafeRef: MutableRefLike<boolean>
  verboseRef: MutableRefLike<boolean>
  setVerbose: (v: boolean) => void
  setAutoSafe: (v: boolean) => void
  /** 持久化审批模式为默认（写 ~/.rivet/config.json），重启后仍生效。
   *  注入而非直接调用 config manager，便于测试隔离（默认 no-op，不落盘）。 */
  persistApprovalMode?: (mode: string) => void
  rollbackTokenRef: MutableRefLike<string | null>
  setCockpitPanel: (v: Panel | ((prev: Panel) => Panel)) => void
  activeOverlay?: string | null
  surfacePush?: (id: string) => void
  /** `/btw` 侧问：开浮层并流式作答。问答只活在浮层里，不进对话历史。
   *  未注入（headless / 测试）时 `/btw` 打印提示而非静默失败。 */
  askSideQuestion?: (question: string) => void
  /** `/plan-view` 计划全文预览（全屏 pager，q 返回）：slug 指正式计划，
   *  draftPath 指撰写中的活动草稿（相对 cwd）。未注入时打印提示。 */
  openPlanPreview?: (opts: { slug?: string; draftPath?: string }) => void
  /** 设置 choice-panel 类型（effort / permission），供选择面板渲染器读取。 */
  setChoicePanelKind?: (kind: 'effort' | 'permission' | 'permission-yolo-confirm') => void
  surfacePop?: () => void
  pushStatic: (entry: LogEntry) => void
  setIsStreaming: (v: boolean) => void
  setCacheHitRate: (v: number) => void
  setSummaryState: (v: SummaryState | ((prev: SummaryState) => SummaryState)) => void
  mcpManagerRef: MutableRefLike<import('../mcp/manager.js').McpManager | null>
  claimStoreRef: MutableRefLike<ContextClaimStore | null>
  setReasoningEffort?: (effort: import('../agent/auto-reasoning.js').ReasoningEffort | 'auto') => void
  reasoningEffort?: string
  onDomainChange?: (domainName: string | undefined) => void
  /** T5: bandit promotion state for /status observability. */
  banditState?: import('../server/routes.js').BanditStatusEntry[]
  /** 独立审查回调——/review 不经过 deliver_task 直接调 routeReviewWorkflow。
   *  未注入时 /review fallback 到 resolveAppPromptInput → deliver_task 旧路径。 */
  runReview?: (change: import('../agent/review-discipline.js').ChangeSet, mode: import('../agent/review-router.js').ReviewMode, focus?: string) => Promise<import('../agent/review-router.js').ReviewOutcome>
  /** Submit a prompt directly to the agent pipeline, bypassing slash routing.
   *  Used by commands that need to transform the input before sending (e.g. /goal). */
  submitToAgent?: (prompt: string) => void
  /** /handoff 发起时登记归档任务（src=项目内 .rivet/HANDOFF.md，dest=会话目录 <id>.handoff.md）——
   *  TUI 在交接 turn 完成后把 src 拷贝归档到 dest（loadPrevHandoff 注入管线认 dest）。 */
  onHandoffStart?: (src: string, dest: string) => void
  /** Mutable ref to the current GoalTracker. Set when /goal creates a tracker;
   *  read by deliver_task's B1Context for auto-review gating. */
  goalTrackerRef?: { current: import('../agent/goal-tracker.js').GoalTracker | null }
  /** 会话级审查门开关：/review off|on 写入；deliver_task 经 isAutoReviewOff 读取。 */
  reviewGateRef?: { current: 'auto' | 'off' }
}

/** 收集当前工作区未提交的改动文件（unstaged + staged + untracked）。 */
async function collectDirtyFiles(cwd: string): Promise<string[]> {
  const { spawnGitSync } = await import('../tools/spawn-git.js')
  const run = (gitArgs: string[]): string[] => {
    const r = spawnGitSync(['-c', 'core.quotePath=false', ...gitArgs], { cwd, encoding: 'utf-8', timeout: 5000 })
    return r.status === 0 ? r.stdout.split('\0').filter(Boolean) : []
  }
  try {
    const unstaged = run(['diff', '--name-only', '-z'])
    const staged = run(['diff', '--cached', '--name-only', '-z'])
    const untracked = run(['ls-files', '--others', '--exclude-standard', '-z'])
    return [...new Set([...unstaged, ...staged, ...untracked])].sort()
  } catch {
    return []
  }
}

interface ParsedGoalArgs {
  goalText: string
  maxIterations?: number
  wallClockMs?: number
  criteria?: string[]
}

/** 解析 /goal 命令行参数，支持 --max N / --budget M / --criteria '["..."]'
 *  其余部分合并为目标描述。 */
function parseGoalArgs(parts: string[]): ParsedGoalArgs {
  const out: ParsedGoalArgs = { goalText: '' }
  const textParts: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!
    if (p === '--max' && parts[i + 1]) {
      const n = Number(parts[i + 1])
      if (Number.isInteger(n) && n > 0) out.maxIterations = n
      i++
      continue
    }
    if (p === '--budget' && parts[i + 1]) {
      const n = Number(parts[i + 1])
      if (!Number.isNaN(n) && n > 0) out.wallClockMs = Math.round(n * 60000)
      i++
      continue
    }
    if (p === '--criteria' && parts[i + 1]) {
      try {
        const parsed = JSON.parse(parts[i + 1]!)
        if (Array.isArray(parsed) && parsed.every((c: unknown) => typeof c === 'string')) {
          out.criteria = parsed as string[]
        }
      } catch { /* ignore invalid JSON */ }
      i++
      continue
    }
    textParts.push(p)
  }
  out.goalText = textParts.join(' ').trim()
  return out
}

/** 把 GoalTracker 状态持久化到会话目录（best-effort）。 */
async function persistGoalState(ctx: SlashHandlerContext, tracker: import('../agent/goal-tracker.js').GoalTracker): Promise<void> {
  if (!ctx.currentSessionId) return
  try {
    const { saveGoalState } = await import('../agent/goal-persist.js')
    const { getSessionDir } = await import('../agent/session-persist.js')
    saveGoalState(getSessionDir(ctx.agent.cwd), ctx.currentSessionId, tracker)
  } catch { /* best-effort */ }
}

/** 格式化当前 goal 状态供 /goal-status 使用。 */
function formatGoalStatus(tracker: import('../agent/goal-tracker.js').GoalTracker): string {
  const status = tracker.getStatus()
  const statusLabels: Record<string, string> = { active: '进行中', paused: '已暂停', blocked: '已阻塞', complete: '已完成' }
  const lines = [
    `🎯 ${tracker.getGoal()}`,
    `状态: ${statusLabels[status] ?? status}`,
    `迭代: ${tracker.getIteration()}/${tracker.getMaxIterations()}`,
    `已用时间: ${Math.round(tracker.getWallClockElapsedMs() / 1000)}s`,
  ]
  const budget = tracker.getWallClockBudgetMs()
  if (budget !== undefined) lines.push(`时间预算: ${Math.round(budget / 60000)}m`)
  const criteria = tracker.getSuccessCriteria()
  if (criteria.length > 0) {
    lines.push('验收项:')
    criteria.forEach((c, i) => lines.push(`  ${i + 1}. ${c}`))
  }
  const verdict = tracker.getLastVerdict()
  if (verdict) {
    lines.push(`最近核验: ${verdict.overall} · ${verdict.criteriaMet}/${verdict.criteriaTotal} 项通过`)
  }
  return lines.join('\n')
}

function formatClaimLine(claim: import('../context/claims.js').ContextClaim): string {
  return `- [${claim.status}] ${claim.kind}: ${claim.text}`
}

export function formatContextClaimsCommand(store: ContextClaimStore, status?: ContextClaimStatus): string {
  const claims = status
    ? store.listClaims({ status: [status] })
    : store.listClaims()
  if (claims.length === 0) return 'No context claims.'
  return claims.map(formatClaimLine).join('\n')
}

export function formatVerificationStatus(agent: AgentLoop): string {
  const summary = agent.getVerificationSummary()
  if (summary.total === 0) return 'Verification Status\n\nNo modified files tracked in this turn.'
  const lines = summary.files.map(file => {
    const icon = file.level === 'pending' ? '✗' : '✓'
    return `  ${icon} ${file.path} (${file.level})`
  })
  const percent = Math.round((summary.verified / summary.total) * 100)
  const state = agent.getEvidenceState()
  const last = state.verifications.at(-1)
  const lastLine = last ? `\nLast verification: ${last.status} — ${last.command}` : '\nLast verification: none'
  return `Verification Status\n\nModified files:\n${lines.join('\n')}\n\nVerification: ${summary.verified}/${summary.total} (${percent}%)${lastLine}`
}

/** MCP 状态文本——/mcp（裸）与 /debug mcp 共用。
 *  修复前 /mcp 的 subcmd 取 parts[0]（恒为 '/mcp' 本身）：auth/logs 分支不可达、
 *  裸 /mcp 只打用法不打状态（排障页审计发现）。 */
export function mcpStatusText(mgr: import('../mcp/manager.js').McpManager | null | undefined): string {
  if (!mgr) return 'MCP not initialized (no servers configured or MCP disabled).'
  const states = mgr.getStates()
  const tools = mgr.getAllTools()
  const lines = [`MCP Status (${states.length} server(s), ${tools.length} tool(s)):`]
  for (const s of states) {
    const detail = s.status === 'connected'
      ? `connected — ${s.toolCount} tools`
      : s.status === 'error'
        ? `error: ${s.error}`
        : s.status
    lines.push(`  ${s.serverId}: ${detail}`)
  }
  if (tools.length > 0) {
    lines.push('Tools: ' + tools.map(t => t.definition.name).join(', '))
  }
  return lines.join('\n')
}

function knowledgeDir(): string {
  return join(process.cwd(), '.rivet', 'knowledge')
}

function appendProjectKnowledge(text: string): string {
  const dir = knowledgeDir()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'memory.md')
  const line = `- ${new Date().toISOString()} ${text}\n`
  writeFileSync(file, line, { flag: 'a' })
  return file
}

export function formatMemoryOverview(ctx: SlashHandlerContext): string {
  const memory = ctx.persist.loadMemory()
  const sessionLines = memory.entries.length === 0
    ? ['  (empty)']
    : memory.entries.slice(-8).map(e => `  • [${e.id}] ${e.text}`)

  const pheromones = ctx.agent.getLatestPheromones?.() ?? []
  const pheromoneLines = pheromones.length === 0
    ? ['  (none loaded yet)']
    : pheromones.slice(0, 8).map(p => `  • ${p.path} — ${p.signal} (${p.strength.toFixed(2)})`)

  const dir = knowledgeDir()
  const knowledgeFiles = existsSync(dir)
    ? readdirSync(dir).filter(f => f.endsWith('.md')).slice(0, 8)
    : []
  const knowledgeLines = knowledgeFiles.length === 0
    ? ['  (none)']
    : knowledgeFiles.map(f => `  • ${f}`)

  return `天枢记忆\n\n📝 当前 session (${memory.entries.length} 条)\n${sessionLines.join('\n')}\n\n🧠 项目直觉 (${pheromones.length} 条)\n${pheromoneLines.join('\n')}\n\n📚 项目知识 (${knowledgeFiles.length} 篇)\n${knowledgeLines.join('\n')}\n\n命令: /memory add <内容> | /memory search <query> | /memory forget <id>`
}

export function searchMemory(ctx: SlashHandlerContext, query: string): string {
  const needle = query.toLowerCase()
  const sessionHits = ctx.persist.loadMemory().entries
    .filter(e => e.text.toLowerCase().includes(needle))
    .map(e => `session:${e.id} ${e.text}`)
  const pheromoneHits = (ctx.agent.getLatestPheromones?.() ?? [])
    .filter(p => `${p.path} ${p.signal} ${p.context ?? ''}`.toLowerCase().includes(needle))
    .map(p => `pheromone:${p.path} ${p.signal} ${p.context ?? ''}`)
  const dir = knowledgeDir()
  const knowledgeHits = existsSync(dir)
    ? readdirSync(dir).filter(f => f.endsWith('.md')).flatMap(file => {
      const content = readFileSync(join(dir, file), 'utf-8')
      return content.toLowerCase().includes(needle) ? [`knowledge:${file} ${content.slice(0, 160).replaceAll('\n', ' ')}`] : []
    })
    : []
  const hits = [...sessionHits, ...pheromoneHits, ...knowledgeHits].slice(0, 20)
  return hits.length === 0 ? `No memory found for "${query}".` : `Memory search: ${query}\n${hits.map(h => `- ${h}`).join('\n')}`
}

export interface ResolvedPromptInput {
  prompt: string
  /** 见 WorkflowResolveResult.requiredTools。仅 ecosystem workflow 路径可能非空。 */
  requiredTools?: readonly string[]
}

export function resolveAppPromptInput(
  input: string,
  cwd: string,
  isKnownCommand?: (name: string) => boolean,
  pluginCommands?: { name: string; file: string }[],
): ResolvedPromptInput | null {
  if (!input.startsWith('/')) return { prompt: input }
  const workflow = resolveEcosystemWorkflowInput(input)
  if (workflow) return { prompt: workflow.prompt, requiredTools: workflow.requiredTools }
  const custom = resolveCustomCommand(cwd, input, pluginCommands)
  if (custom) return { prompt: custom }
  const skillPrompt = resolveSkillPrompt(input, cwd)
  if (skillPrompt !== null) return { prompt: skillPrompt }
  // /review off|on|status 是 TUI 本地会话开关——本路径（server/headless 映射层）没有
  // refs 可写。明确告知，而不是把 "off" 误当 focus 触发一次审查（白烧 worker token）。
  if (/^\/review\s+(?:off|on|status)\s*$/i.test(input)) {
    return { prompt: `User typed "${input}". /review off|on|status is a TUI-local session toggle (auto-review gate) that this surface cannot flip. To disable auto review here, set review.skipAuto in config (desktop: Settings → Routing); manual /review [max] keeps working either way.` }
  }
  // /review [max|l1|l2|l3] [focus description] — map to deliver_task instruction for the agent
  const reviewMatch = input.match(/^\/review(?:\s+(max|l1|l2|l3))?(?:\s+(.*))?$/i)
  if (reviewMatch) {
    const kw = reviewMatch[1]?.toLowerCase()
    const focusText = reviewMatch[2]?.trim()
    const level: 'L1' | 'L2' | 'L3' = kw === 'max' || kw === 'l3' ? 'L3' : kw === 'l1' ? 'L1' : 'L2'
    const levelLabel = level === 'L3'
      ? 'L3 Review Squadron (5 inspectors)'
      : level === 'L1'
        ? 'L1 nudge (review-discipline reminder, zero review workers)'
        : 'L2 adversarial verifier'
    const focusInstruction = focusText ? ` Focus specifically on: ${focusText}.` : ''
    return { prompt: `Run code review on the current uncommitted changes: call deliver_task with commit=true and review_level="${level}". This triggers ${levelLabel}.${focusInstruction}` }
  }
  // /review typos — don't silently drop user input
  if (/^\/review/i.test(input)) {
    return { prompt: `User typed "${input}" which looks like a /review command but didn't match the expected format. Usage: /review [max] [focus description]. Run /review max to trigger L3 Review Squadron.` }
  }
  // 裸技能名直调（issue #100 建议②）：/name [task]——内置/workflow/自定义/网关
  // 均未命中后的兜底。必须放在 looksLikeFilePath 之前：单段 /name 在
  // isKnownCommand 谓词下会被判成「路径」原样透传，技能解析永远轮不到
  // （多段路径天然不匹配技能名，/etc 类单段路径无同名技能时仍落回路径分支）。
  const bareSkill = resolveBareSkillPrompt(input)
  if (bareSkill !== null) return { prompt: bareSkill }
  // Linux/WSL path like /etc, /mnt, /usr — not a recognized command, pass through
  // as plain text so the agent can handle it (e.g. "look at /etc/hosts").
  if (looksLikeFilePath(input, isKnownCommand)) return { prompt: input }
  // Unrecognized slash command — return null to signal "blocked"
  return null
}

const SKILL_RESERVED_SUBCOMMANDS = new Set(['list', 'ls', 'install', 'import', 'review', 'drafts', 'approve', 'reject', 'off', 'complete'])

/** 技能查找 + prompt 展开（/skill 网关与裸名直调共用）。未命中返回 null。 */
function buildSkillPrompt(name: string, userTask: string): string | null {
  const skill = skillRegistry.get(name) ?? skillRegistry.list().find(s => s.name.toLowerCase() === name.toLowerCase())
  if (!skill) return null
  let prompt = `[Skill loaded: ${skill.name}]\n<skill name="${skill.name}">\n${skill.body}\n</skill>`
  if (skill.skillDir) {
    const files = listSkillFiles(skill.skillDir)
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
function resolveSkillPrompt(input: string, cwd: string): string | null {
  const match = input.trim().match(/^\/skill\s+(\S+)(?:\s+(.*))?$/s)
  if (!match) return null
  const name = match[1]!
  if (SKILL_RESERVED_SUBCOMMANDS.has(name.toLowerCase())) return null
  return buildSkillPrompt(name, match[2]?.trim() ?? '')
}

/**
 * 裸技能名直调（issue #100 建议②，Claude Code「技能即斜杠命令」形态）：
 * `/name [task...]` 命中技能注册表则展开为 skill prompt。只在内置/workflow/
 * 自定义/网关全部未命中后兜底——同名技能被内置遮蔽但仍可经 /skill <name>
 * 显式唤起。多段路径天然不匹配（技能名不含 /）；单段路径（/etc）只有用户
 * 真建了同名技能才会被接管——那正是用户意图。
 */
export function resolveBareSkillPrompt(input: string): string | null {
  const match = input.trim().match(/^\/([^\s/]+)(?:\s+(.*))?$/s)
  if (!match) return null
  const name = match[1]!
  if (SKILL_RESERVED_SUBCOMMANDS.has(name.toLowerCase())) return null
  return buildSkillPrompt(name, match[2]?.trim() ?? '')
}

/**
 * Resolve `/enter <worker-id-or-label> [message]` into a prompt that resumes
 * the worker via delegate_task, or return a usage/error message.
 */
export function resolveEnterWorkerInput(
  app: TuiApp,
  input: string,
): { prompt: string } | { error: string } | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/enter')) return null
  const parts = trimmed.split(/\s+/)
  if (parts.length < 2) {
    return { error: 'Usage: /enter <worker-id-or-label> [continuation message]' }
  }
  const target = parts[1]!
  const message = parts.slice(2).join(' ').trim()
  const resolved = app.resolveWorkerId(target)
  if (!resolved) {
    return { error: `Worker not found: "${target}". Use /tasks to see available workers.` }
  }
  const objective = message || 'Continue from where you left off.'
  const prior = resolved.objective ? ` Previous objective: ${resolved.objective}.` : ''
  const prompt = `Resume worker ${resolved.workerId} (profile: ${resolved.profile}).${prior} Continue with: ${objective} Call delegate_task with resume="${resolved.workerId}" and objective="${objective}".`
  return { prompt }
}


// 批准闭环内核（校验+漂移复查+分波 kickoff）已下沉到共享模块，
// server 桌面路由与 TUI 共用同一实现。此处保留 re-export 兼容既有导入。
export { buildPlanKickoff } from '../plan/plan-approval.js'

/**
 * 批准计划并自动 kickoff 分波执行的共享闭环。slash `/plan-approve` 与 plan-picker
 * overlay 回车共用:approve → setActivePlan(注入指针 + 退出 plan mode)→ 提交 kickoff。
 * 返回 false 表示计划不存在(调用方据此报错)。
 */
export async function approvePlanAndKickoff(
  deps: {
    cwd: string
    agent: Pick<AgentLoop, 'setActivePlan'>
    submitToAgent?: (prompt: string) => void
    notify: (content: string, isError?: boolean) => void
  },
  slug: string,
  resolvedApproach?: string,
): Promise<boolean> {
  const result = await approvePlanWithGuards(deps.cwd, slug, resolvedApproach)
  if (!result.ok) {
    if (result.code === 'invalid-content') {
      deps.notify(`无法批准 **${result.title}** (\`${slug}\`)：${result.reason} 未写入 APPROVED 标记，也未启动执行。`, true)
    } else {
      deps.notify(`Plan not found: "${slug}". Use /plan-list to see available plans.`, true)
    }
    return false
  }
  const { approved, driftNote, kickoff } = result
  deps.agent.setActivePlan({ slug, title: approved.title, selectedApproach: resolvedApproach })
  const approachLine = resolvedApproach ? `\nSelected approach: **${resolvedApproach}**` : ''
  const driftLine = driftNote
    ? `\n\n⚠ 锚点漂移复查:计划中有引用与当前工作区不符(已注入执行提示,执行方将以现实为准):\n${driftNote}`
    : ''
  deps.notify(
    `✅ Plan approved: **${approved.title}** (\`${slug}\`)${approachLine}\n\n方案指针已加载,正文在 \`.rivet/plans/${slug}.md\`。Plan Mode 已退出 — 开始自动分波执行。${driftLine}`,
  )
  deps.submitToAgent?.(kickoff)
  return true
}

interface TuiSlashCommandDef {
  readonly name: string
  readonly description?: string
  readonly immediate?: true
  readonly handler: (ctx: SlashHandlerContext) => boolean | Promise<boolean>
}

/** /plan-mode 退出时的二次确认时间戳（未批准计划放弃护栏）。 */
let planModeExitArmedAt = 0
const PLAN_MODE_EXIT_CONFIRM_MS = 3000

const TUI_SLASH_COMMANDS: readonly TuiSlashCommandDef[] = [
  {
    name: '/tools',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const sub = parts[1]?.toLowerCase()
      if (sub === 'enable') {
        const toolName = parts[2]
        if (!toolName) {
          pushStatic(createLogEntry({ type: 'system', content: 'Usage: /tools enable <tool_name>\nMounts an EXTENDED-layer tool onto the primary agent at this turn boundary.\nAlternatively, use delegate_task to dispatch a worker with that tool (zero cache cost).' }))
        } else if (toolName.toLowerCase() === 'computer_use' && !isProFeatureEnabled(ctx.config, 'computerUse')) {
          pushStatic(createLogEntry({ type: 'system', content: 'computer_use is a Pro feature. Enable Pro (desktop: upgrade in Settings → About & License; CLI: config.pro.enabled / RIVET_PRO=1 / ~/.rivet/pro.license) to mount this tool.' }))
        } else {
          const result = ctx.agent.enableTool(toolName)
          switch (result.status) {
            case 'mounted': {
              const costLine = result.cacheImpact === 'prefix-invalidated'
                ? `⚠ Cache impact: provider "${result.prefixCacheStrategy}" uses exact-prefix caching — the NEXT request will be a full prefix-cache MISS (one-time cost; subsequent turns re-cache against the new tool set).`
                : `✓ Cache impact: provider "${result.prefixCacheStrategy}" has no prefix cache — no cache penalty.`
              pushStatic(createLogEntry({ type: 'system', content: `Mounted EXTENDED tool "${toolName}" onto the primary agent.\n${costLine}` }))
              break
            }
            case 'already-active':
              pushStatic(createLogEntry({ type: 'system', content: `"${toolName}" is already mounted on the primary agent. No change.` }))
              break
            case 'not-extended':
              pushStatic(createLogEntry({ type: 'system', content: `"${toolName}" is a CORE or already-visible tool — it's available without mounting. No change.` }))
              break
            case 'unknown':
              pushStatic(createLogEntry({ type: 'system', content: `Unknown tool "${toolName}". Run /tools to list available tiers.` }))
              break
            case 'gating-off':
              pushStatic(createLogEntry({ type: 'system', content: `Tool gating is disabled — all tools are already visible to the primary agent. No change.` }))
              break
          }
        }
      } else {
        // List current tool tiers
        const { CORE_TOOLS, EXTENDED_TOOLS, isExtendedTool } = await import('../agent/tool-tiers.js')
        const active = new Set(ctx.agent.getActiveToolNames())
        const mountedExtras = [...active].filter(isExtendedTool)
        const disabled = new Set(ctx.config.agent?.toolGating?.disabledTools ?? [])
        const lines: string[] = ['Tool Gating Tiers', '═════════════════════', '', `CORE (${CORE_TOOLS.length}):`, ...CORE_TOOLS.map(t => `  ${disabled.has(t) ? '✗' : '✓'} ${t}`), '', `EXTENDED (${EXTENDED_TOOLS.length}):`, ...EXTENDED_TOOLS.map(t => `  ${disabled.has(t) ? '✗' : active.has(t) ? '✓ (mounted)' : '·'} ${t}`), '']
        if (mountedExtras.length > 0) {
          lines.push(`Runtime-mounted EXTENDED: ${mountedExtras.join(', ')}`, '')
        }
        if (disabled.size > 0) {
          lines.push(`Disabled tools (config-level, restart to apply): ${[...disabled].join(', ')}`, '')
        }
        lines.push('EXTENDED tools are available to workers via delegate_task.', 'Use /tools enable <name> to mount one onto the primary agent.')
        pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/help',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      pushStatic(createLogEntry({ type: 'system', content: HELP_TEXT }))
      setIsStreaming(false)
      return true

    },
  },
  {
    name: '/status',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const lines: string[] = ['Bandit Promotion State', '═══════════════════════']
      if (ctx.banditState && ctx.banditState.length > 0) {
        for (const b of ctx.banditState) {
          lines.push(`${b.source}: ${b.mode} (enabled=${b.enabled})`)
          lines.push(`  reason: ${b.reason}`)
          lines.push(`  samples: ${b.totalShadowSamples}`)
        }
      } else {
        lines.push('(no bandit state available — run bootstrap first)')
      }
      lines.push('', 'Review Infra Health', '═══════════════════════')
      lines.push(formatReviewHealthLine())
      pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/exit',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      ctx.persist.compactOai(ctx.session.getMessages())
      pushStatic(createLogEntry({ type: 'system', content: 'Session saved. Goodbye!' }))
      process.emit('SIGINT')
      return true

    },
  },
  {
    name: '/quit',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      ctx.persist.compactOai(ctx.session.getMessages())
      pushStatic(createLogEntry({ type: 'system', content: 'Session saved. Goodbye!' }))
      process.emit('SIGINT')
      return true

    },
  },
  {
    // 侧问：subagent 的逆命题——看得见完整对话但没有工具。问答只活在浮层里，
    // 一个字节都不进历史，所以主对话的前缀缓存分毫未动。
    name: '/btw',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const question = parts.slice(1).join(' ').trim()
      if (!question) {
        pushStatic(createLogEntry({
          type: 'system',
          content: '用法：/btw <问题>\n就当前会话上下文问一个侧问。回答显示在浮层里，不进入对话历史，也不打断正在进行的工作。',
        }))
      } else if (!ctx.askSideQuestion) {
        pushStatic(createLogEntry({ type: 'system', content: '侧问在当前环境不可用。' }))
      } else {
        ctx.askSideQuestion(question)
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/compact',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const sub = parts[1]?.toLowerCase()
      const msgs = ctx.session.getMessages()
      const beforeTokens = estimateOaiTokens(msgs)

      if (sub === 'status') {
        const compacts = ctx.session.getCompactEvents()
        const ledger = ctx.session.getContextLedger()
        const pct = ledger ? Math.round(ledger.tokenBudget.estimatedTokens / ledger.tokenBudget.maxTokens * 100) : 0
        const compactStr = compacts.length === 0
          ? 'No compact events yet.'
          : compacts.slice(-5).map(e => `  turn ${e.turn}: tier ${e.tier}, ${e.beforeTokens.toLocaleString()}→${e.afterTokens.toLocaleString()}`).join('\n')
        pushStatic(createLogEntry({ type: 'system', content: `Compact status: ${beforeTokens.toLocaleString()}/${ctx.maxTokens.toLocaleString()} tokens (${pct}%)\n\nRecent events:\n${compactStr}\n\nUse /compact to micro-compact, /compact llm to resume LLM compact.` }))
        setIsStreaming(false)
        return true
      }

      if (sub === 'llm' || sub === 'deep') {
        // LLM compact — deferred to next turn (triggers automatically at thresholds)
        pushStatic(createLogEntry({ type: 'system', content: `LLM compact will trigger automatically at context thresholds (currently ${beforeTokens.toLocaleString()} tokens). Use /compact for immediate micro-compact.` }))
        setIsStreaming(false)
        return true
      }

      // micro compact (default)
      pushStatic(createLogEntry({ type: 'system', content: 'Micro-compacting conversation...' }))
      const { messages: compacted, truncated } = microCompactOai(msgs, ctx.maxTokens, beforeTokens)
      ctx.session.replaceMessages(compacted)
      ctx.agent.config.promptEngine.resetAppendixBaseline()
      const afterTokens = estimateOaiTokens(compacted)
      ctx.session.recordCompactEvent({
        turn: ctx.session.getTurnCount(),
        tier: 1,
        reason: 'manual /compact command',
        beforeTokens,
        afterTokens,
        createdAt: Date.now(),
      })
      const pctRemoved = beforeTokens > 0 ? Math.round((1 - afterTokens / beforeTokens) * 100) : 0
      pushStatic(createLogEntry({ type: 'system', content: `Compacted: ${beforeTokens.toLocaleString()} → ${afterTokens.toLocaleString()} tokens (-${pctRemoved}%, ${truncated} msgs removed, ${compacted.length} remaining).` }))
      ctx.setSummaryState(prev => ({ ...prev, compactEvent: { beforeTokens, afterTokens } }))
      setTimeout(() => ctx.setSummaryState(prev => ({ ...prev, compactEvent: null })), 8000)
      ctx.setCacheHitRate(ctx.session.getCacheHitRate())
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/team',
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      if (!parts.slice(1).join(' ').trim()) {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /team <task|docs/superpowers/plans/file.md>\n       /team max <task>' }))
        setIsStreaming(false)
        return true
      }
      // Pro gate（双层模式）：team max 的多视角规划 fanout 仅 Pro 可用。
      // 入口早拦免得白跑一个模型轮次；标准 /team 不受影响。
      if (parts[1]?.toLowerCase() === 'max' && !isProFeatureEnabled(ctx.config, 'teamMax')) {
        pushStatic(createLogEntry({ type: 'system', content: 'team max（多视角规划）是 Pro 功能。Basic 可用：/team <task> 标准模式，或先 plan_task 出计划再执行。升级 Pro 解锁。' }))
        setIsStreaming(false)
        return true
      }
      return false
    },
  },
  {
    name: '/galaxy',
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      if (!parts.slice(1).join(' ').trim()) {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /galaxy <任务描述>\n       启动星河集群——拆解为多个维度由不同星域并行执行。' }))
        setIsStreaming(false)
        return true
      }
      return false
    },
  },
  {
    name: '/council',
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      if (!parts.slice(1).join(' ').trim()) {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /council <要会诊的计划/问题> [--seats id1,id2,...] [--rounds 1-2]' }))
        setIsStreaming(false)
        return true
      }
      // Pro gate（双层模式）：rounds≥2（反驳轮）仅 Pro 可用。提示后放行——
      // council_convene 工具侧会把 rounds 钳制回单轮，单轮议事会是 Basic 能力。
      const roundsMatch = /--rounds[\s=]+(\d+)/.exec(parts.slice(1).join(' '))
      if (roundsMatch && Number(roundsMatch[1]) >= 2 && !isProFeatureEnabled(ctx.config, 'councilMultiRound')) {
        pushStatic(createLogEntry({ type: 'system', content: '提示：议事会第 2 轮（反驳轮）是 Pro 功能，本次将按单轮执行。升级 Pro 解锁多轮辩论。' }))
      }
      return false
    },
  },
  {
    name: '/scout',
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      if (!parts.slice(1).join(' ').trim()) {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /scout <诊断目标> [--dims 前端,后端,集成]\n并行只读诊断蜂群：先摸底 → 按维度派 code_scout → 实测核对清单 + runbook。' }))
        setIsStreaming(false)
        return true
      }
      return false
    },
  },
  {
    name: '/starflow',
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming, submitToAgent } = ctx
      const task = parts.slice(1).join(' ').trim()
      if (!task) {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /starflow <任务描述>\n       星流（Starflow）——需求澄清+环境基线 → council 评审 → team 波次 → galaxy 攻坚 → 交付门禁，从大白话到工业级可交付代码。' }))
        setIsStreaming(false)
        return true
      }
      if (submitToAgent) {
        // 代码级星流：阶段流转由 starflow 工具的状态机硬门禁兜底（council→team→galaxy），
        // 不再内嵌五阶段协议长 prompt——模型只负责需求澄清与交付叙述。
        submitToAgent(`进入星流（Starflow）模式。任务：${task}

先用大白话与我确认需求（目标/非目标/验收标准，至多一轮；任务已清楚就直接进入下一步）。需求不清时先对话澄清，不要急着调工具。
需求清楚后调用 starflow 工具执行，阶段流转与门禁由工具状态机强制执行（council 评审 → team 波次 → galaxy 攻坚），不要手工模拟这些阶段：
- 先 starflow({ objective, draftItems, rounds, confirm: false }) 展示执行方案；我确认后再调 confirm: true 点火。
- draftItems 从澄清产出映射（id/title/detail/files），供 council 评审与 galaxy 维度派生；高风险任务 rounds: 2。
- 返回 blocked 时按报告里的人话解释与下一步建议处理（修订草稿重跑 / resume: true 续跑），不要绕过门禁。
- 工具全过后会输出交付检查清单——逐项自查后调用 deliver_task 完成交付门禁；未运行的验证就说"未验证"。
全程用大白话同步"完成了什么/接下来什么"。`)
        return true
      }
      return false
    },
  },
  {
    name: '/review',
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      // /review off|on|status — 会话级自动审查门开关（即时生效，不写配置）。
      // off 只抑制 deliver_task 提交后的系统自动审查：主控照常测试/验证/提交，
      // 不再自动 spawn 审查 worker（省 token）；手动 /review [max] 不受影响。
      const sub = parts[1]?.toLowerCase()
      if (sub === 'off' || sub === 'on' || sub === 'status') {
        const gateRef = ctx.reviewGateRef
        if (!gateRef) {
          pushStatic(createLogEntry({ type: 'system', content: '当前环境不支持会话级审查门开关；请用配置 review.skipAuto（持久，新会话生效）。' }))
          setIsStreaming(false)
          return true
        }
        if (sub === 'status') {
          const state = gateRef.current === 'off' ? '已关闭（off）' : '开启（auto）'
          // 待终审累积：defer/final 模式下 commit 范围攒在 pending 里，此前只在
          // 交付那一刻的文案里提一次，用户随后无处可查——/review status 是
          // 「现在攒了多少、要不要提前审」的自然落点。
          const pend = peekPendingReview(ctx.currentSessionId)
          const pendLine = pend
            ? `\n待终审：${pend.commits} 个提交、${pend.files.size} 个文件已累积 — 敲 /review 立即审查，或等收尾自动终审。`
            : '\n待终审：无（本次会话没有累积的延迟审查）。'
          pushStatic(createLogEntry({ type: 'system', content: `审查门状态：${state}。/review off 关闭自动审查，/review on 恢复；手动 /review [max] 始终可用。${pendLine}` }))
        } else {
          gateRef.current = sub === 'off' ? 'off' : 'auto'
          pushStatic(createLogEntry({ type: 'system', content: sub === 'off'
            ? '⏸ 自动审查门已关闭（本会话）：主控照常测试/验证/提交，不再自动 spawn 审查 worker。手动 /review [max] 仍可用；/review on 恢复。'
            : '▶ 自动审查门已恢复（本会话）：交付后将按既有规则自动路由审查。' }))
        }
        setIsStreaming(false)
        return true
      }
      // /review [max|l1|l2|l3] [focus] — 独立审查入口（不经过 deliver_task）。
      // 当 ctx.runReview 可用时直接调 routeReviewWorkflow；否则 fallback 到旧路径。
      const levelKw = parts[1]?.toLowerCase()
      const forceLevel = levelKw === 'max' || levelKw === 'l3' ? 'L3' as const
        : levelKw === 'l1' ? 'L1' as const
        : levelKw === 'l2' ? 'L2' as const
        : undefined
      const isMax = forceLevel === 'L3'
      const focus = parts.slice(forceLevel ? 2 : 1).join(' ').trim()

      if (!ctx.runReview) {
        // Fallback: 让 resolveAppPromptInput 映射为 deliver_task 指令
        return false
      }

      // 动态导入避免循环依赖 + 避免顶层 import 增加初始 bundle
      const { isCrossModule, isFixContext } = await import('../agent/review-discipline.js')
      const { reviewWorkflowBudgetMs } = await import('../agent/review-router.js')
      type ChangeSet = import('../agent/review-discipline.js').ChangeSet
      type ReviewMode = import('../agent/review-router.js').ReviewMode

      // 从 git diff 构造 ChangeSet。defer/冷却/在飞攒下的待终审范围一并非入——
      // formatDeferredReviewNotice 与 /review status 都承诺「敲 /review 立即审查」，
      // 此前 /review 只看未提交改动：干净工作树下该承诺是死胡同，且 pending 不被
      // 消费会让收尾终审对同批文件二审。pending 文件已 commit，审的是其当前内容
      // （与 deliver_task 补审/final 消费同一语义）。
      const dirtyFiles = await collectDirtyFiles(ctx.agent.cwd)
      const pend = peekPendingReview(ctx.currentSessionId)
      const files = pend ? [...new Set([...pend.files, ...dirtyFiles])].sort() : dirtyFiles
      if (files.length === 0) {
        pushStatic(createLogEntry({ type: 'system', content: '没有未提交的改动可以审查。' }))
        setIsStreaming(false)
        return true
      }
      // 确认有内容可审才消费——早退路径不白丢累积范围。
      if (pend) consumePendingReview(ctx.currentSessionId)
      const effectiveForce = forceLevel ?? (pend?.escalate ? 'L3' as const : undefined)

      const change: ChangeSet = {
        files,
        crossModule: isCrossModule(files),
        isFix: isFixContext(focus || ''),
        ...(effectiveForce ? { forceLevel: effectiveForce } : {}),
      }

      const mode: ReviewMode = 'manual'
      const budgetSec = effectiveForce === 'L1'
        ? 0
        : Math.round(reviewWorkflowBudgetMs(mode, effectiveForce === 'L3' ? 'L3' : effectiveForce === 'L2' ? 'L2' : undefined) / 1000)
      const levelLabel = effectiveForce === 'L3' ? 'L3 Squadron (5 inspectors)' : effectiveForce ?? 'auto-classify'
      const pendNote = pend ? `\n   已并入待终审累积：${pend.commits} 个提交、${pend.files.size} 个文件（收尾不再重复终审）。` : ''
      pushStatic(createLogEntry({ type: 'system', content: `⏳ 审查启动中 (${levelLabel}, ≤${budgetSec}s)...${pendNote}\n` }))

      try {
        const outcome = await ctx.runReview(change, mode, focus || undefined)
        const icon = outcome.verdict === 'verified' ? '🟢'
                   : outcome.verdict === 'rejected' ? '🔴' : '🟡'
        const lines = [`${icon} 审查结果 [${outcome.tier}]: ${outcome.verdict}`]
        if (typeof outcome.rounds === 'number') lines.push(`   轮次：${outcome.rounds}`)
        if (outcome.evidence) lines.push(`   证据：${outcome.evidence}`)
        if (outcome.verdict === 'rejected' || outcome.escalated) {
          lines.push('   → 请在后续提交中处理审查发现。')
        }
        pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') }))
      } catch (err) {
        pushStatic(createLogEntry({ type: 'system', content: `审查失败：${(err as Error).message}` }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/model',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const targetModel = parts[1]
      if (!targetModel || targetModel === 'list') {
        // 只列用户已保存的 provider——内置预设舰队不刷屏。
        const lines: string[] = []
        for (const [provName, prov] of Object.entries(ctx.allProviders)) {
          if (!prov.userSaved) continue
          const marker = provName === ctx.currentProvider ? ' ← current' : ''
          lines.push(`[${provName}]${marker}`)
          for (const m of prov.models) {
            const isCurrent = m.alias === ctx.model || m.id === ctx.model
            // 视觉标记：v4-flash（纯文本）与 v4.1-flash（原生多模态）这类只差前缀/
            // 一个点的档位并排时，没有标记用户根本分不出哪个能看图。
            lines.push(`  ${m.alias} (${m.id})${m.supportsVision ? ' 👁 视觉' : ''}${isCurrent ? ' ←' : ''}`)
          }
        }
        if (lines.length === 0) lines.push('(尚无已保存的 provider——运行 /connect 接入后模型会出现在这里)')
        pushStatic(createLogEntry({ type: 'system', content: `Models:\n${lines.join('\n')}\n\nCurrent: ${ctx.model} [${ctx.currentProvider}]\nContext: ${ctx.maxTokens.toLocaleString()} tokens\nCost: ¥${ctx.cost.toFixed(4)}` }))
      } else {
        const result = ctx.onModelSwitch(targetModel)
        if (result.ok) {
          pushStatic(createLogEntry({ type: 'system', content: `Switched to ${targetModel}` }))
        } else {
          pushStatic(createLogEntry({ type: 'system', content: result.error ?? `Model "${targetModel}" not found.` }))
        }
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/mirror',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const sub = parts[1]?.toLowerCase()
      const current = getMirrorConfig()

      if (sub === 'on') {
        const next = setMirrorConfig({ enabled: true, preset: current.preset === 'default' ? 'china' : current.preset })
        pushStatic(createLogEntry({ type: 'system', content: `✅ Mirrors enabled.\n${formatMirrorStatus(next)}` }))
      } else if (sub === 'off') {
        const next = setMirrorConfig({ enabled: false })
        pushStatic(createLogEntry({ type: 'system', content: `✅ Mirrors disabled.\n${formatMirrorStatus(next)}` }))
      } else if (sub === 'china') {
        const next = setMirrorConfig({ enabled: true, preset: 'china' })
        pushStatic(createLogEntry({ type: 'system', content: `✅ Switched to China mirror preset.\n${formatMirrorStatus(next)}` }))
      } else if (sub === 'default') {
        const next = setMirrorConfig({ enabled: false, preset: 'default', github: 'default', npm: 'default', pypi: 'default', go: 'default', rust: 'default' })
        pushStatic(createLogEntry({ type: 'system', content: `✅ Reset mirrors to default (off).\n${formatMirrorStatus(next)}` }))
      } else {
        pushStatic(createLogEntry({ type: 'system', content: `${formatMirrorStatus(current)}\n\nUsage: /mirror [on|off|china|default]` }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/python',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming, agent } = ctx
      const sub = parts[1]?.toLowerCase()
      const env = await detectEnv(agent.cwd)

      if (sub === 'status') {
        const lines = [
          `Python: ${env.python.available ? `${env.python.command} (${env.python.version ?? 'unknown'})` : '未安装'}`,
          `uv: ${env.uv.available ? `已安装 (${env.uv.version ?? 'unknown'})` : '未安装'}`,
          `Git: ${env.git.available ? `已安装 (${env.git.version ?? 'unknown'})` : '未安装'}`,
          `Node: ${env.node.available ? `已安装 (${env.node.version ?? 'unknown'})` : '未安装'}`,
          `平台: ${env.platform}`,
        ]
        const guidance = formatEnvGuidance(env)
        pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') + (guidance ? '\n\n' + guidance : '') }))
      } else if (sub === 'setup') {
        if (!env.python.available) {
          pushStatic(createLogEntry({ type: 'system', content: '未检测到 Python，无法自动配置项目。\n\n' + formatEnvGuidance(env) }))
        } else if (!env.uv.available) {
          pushStatic(createLogEntry({ type: 'system', content: '已检测到 Python。推荐安装 uv 来自动管理依赖：\n\n' + formatEnvGuidance(env) }))
        } else {
          const recommendation = recommendUvSetup(agent.cwd)
          if (recommendation.ok && recommendation.command) {
            pushStatic(createLogEntry({ type: 'system', content: `${recommendation.message}\n即将执行：${recommendation.command}\n\n你可以直接粘贴该命令，或者说"执行 Python 项目初始化"。` }))
          } else {
            pushStatic(createLogEntry({ type: 'system', content: recommendation.message }))
          }
        }
      } else {
        const hasProject = isPythonProject(agent.cwd)
        pushStatic(createLogEntry({ type: 'system', content: `当前目录 ${hasProject ? '是' : '不像'} Python 项目。\n\nUsage: /python [status|setup]` }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/init',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming, agent } = ctx
      const sub = parts[1]?.toLowerCase()
      // 无参 → 交互式初始化向导（verify / skills / hooks 脚手架，分步确认）。
      if (!sub) {
        if (ctx.openInitFlow) {
          ctx.openInitFlow()
        } else {
          pushStatic(createLogEntry({ type: 'system', content: '交互式初始化在当前界面不可用。脚本/无头场景请用 /init verify（直执行 verify 声明补缺）。' }))
        }
        setIsStreaming(false)
        return true
      }
      if (sub !== 'verify') {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /init [verify] — 无参打开交互式初始化向导；verify 直执行 verify 声明补缺。', isError: true }))
        setIsStreaming(false)
        return true
      }
      // /init verify — 直执行路径（脚本/无头可用，向后兼容）。
      // A4: (re)generate the project verify declaration from the fingerprint.
      // config → md single direction: .rivet-config.json is authoritative,
      // the .rivet.md Stack section is rendered from it.
      try {
        const decl = ensureVerifyDeclaration(agent.cwd)
        const lines: string[] = []
        if (decl.fingerprint.language === 'unknown') {
          lines.push('未识别的项目类型（无 package.json / Cargo.toml / go.mod / pyproject.toml / gradle 标记）。')
          lines.push('可手动在 .rivet-config.json 中声明：{"verify": {"test": "<命令>", "build": "<命令>"}}')
        } else {
          lines.push(`项目指纹: ${decl.fingerprint.language}${decl.fingerprint.hasTestInfra ? '' : '（未检测到测试基础设施）'}`)
          const v = decl.verify
          for (const [k, val] of Object.entries({ test: v.test, build: v.build, typecheck: v.typecheck, lint: v.lint })) {
            if (val) lines.push(`  verify.${k}: ${val}${decl.filledKeys.includes(k) ? '（新填入）' : '（已声明，保留）'}`)
          }
          lines.push(decl.wrote ? '已写入 .rivet-config.json 的 verify 声明。' : 'verify 声明已是最新，未改动。')
          // Render the Stack section into .rivet.md (create when missing).
          try {
            const rivetMdPath = join(agent.cwd, '.rivet.md')
            const stack = renderRivetMdStack(decl.fingerprint, decl.verify)
            const body = existsSync(rivetMdPath) ? readFileSync(rivetMdPath, 'utf-8') : '# Project\n'
            const next = upsertStackSection(body, stack)
            if (next !== body) {
              writeFileSync(rivetMdPath, next, 'utf-8')
              lines.push('已同步 .rivet.md 的 Stack 段（由声明单向生成）。')
            }
          } catch { lines.push('（.rivet.md 同步失败——声明本身已生效）') }
          if (!decl.fingerprint.hasTestInfra) {
            lines.push('提示：未检测到测试。deliver_task 门禁将因缺验证证据降级为 YELLOW。可以让天枢帮你搭最小测试骨架。')
          }
        }
        pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') }))
      } catch (err) {
        pushStatic(createLogEntry({ type: 'system', content: `/init 失败: ${err instanceof Error ? err.message : String(err)}` }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/cd',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming, agent } = ctx
      const target = parts.slice(1).join(' ').trim()
      // 无参 → 显示当前工作目录。
      if (!target) {
        pushStatic(createLogEntry({ type: 'system', content: `当前工作目录: ${agent.cwd}\n\nUsage: /cd <path> — 会话中途切换工作目录（历史前缀缓存保留，下一边界起按新项目计费）。` }))
        setIsStreaming(false)
        return true
      }
      if (!ctx.onCwdSwitch) {
        pushStatic(createLogEntry({ type: 'system', content: '当前界面不支持 /cd 切换（测试/无头环境）。', isError: true }))
        setIsStreaming(false)
        return true
      }
      const res = await ctx.onCwdSwitch(target)
      if (!res.ok) {
        pushStatic(createLogEntry({ type: 'system', content: `/cd 失败: ${res.error ?? '未知错误'}`, isError: true }))
        setIsStreaming(false)
        return true
      }
      const lines = [
        `工作目录已切换: ${res.from} → ${res.to}`,
        `会话归属已迁移（${res.movedFiles?.length ?? 0} 个文件）——新项目的 /resume 与 --continue 可见本会话。`,
        '历史前缀缓存保留；下一条消息起按新项目重建边界（同 /domain 切换代价）。',
      ]
      pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/handoff',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming, agent } = ctx
      const note = parts.slice(1).join(' ').trim() || undefined
      if (!ctx.submitToAgent) {
        pushStatic(createLogEntry({ type: 'system', content: '当前界面不支持 /handoff（测试/无头环境）。', isError: true }))
        setIsStreaming(false)
        return true
      }
      // 项目内 .rivet/ 在工作区内（auto-safe 免审批）；会话目录在工作区外会触发路径审批。
      const projectPath = join(agent.cwd, '.rivet', 'HANDOFF.md')
      const archivePath = join(getSessionDir(agent.cwd), `${ctx.currentSessionId}.handoff.md`)
      // 归档登记：交接 turn 完成后 TUI 把项目内文档拷贝归档到会话目录
      // （loadPrevHandoff 注入管线认 <id>.handoff.md）。
      ctx.onHandoffStart?.(projectPath, archivePath)
      ctx.submitToAgent(buildHandoffPrompt(projectPath, note))
      return true
    },
  },
  {
    name: '/remember',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming, agent } = ctx
      const text = parts.slice(1).join(' ').trim()
      const lines: string[] = []
      if (!text) {
        const notes = listUserNotes(agent.cwd, 5)
        lines.push('用法：/remember <要记住的事>（直写项目长期记忆，跨会话生效）')
        if (notes.length > 0) {
          lines.push('', `最近的用户记忆（${notes.length} 条，全量用 memory recall query=... topic=user）：`)
          for (const note of notes) lines.push(`- [${note.id}] ${note.text}`)
        }
      } else {
        const result = rememberUserNote(agent.cwd, text, ctx.currentSessionId)
        lines.push(result.ok ? `✅ ${result.message}` : `⚠️ ${result.message}`)
        if (result.ok) lines.push('（source=user 直写，不过质量闸门；新会话经跨会话记忆块自动携带）')
      }
      pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/trust',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming, agent } = ctx
      const action = parts[1]?.toLowerCase()
      const lines: string[] = []
      if (action === 'off') {
        untrustProject(agent.cwd)
        lines.push(
          '已撤销当前项目的信任（/trust off）。',
          '项目级 hooks 即刻停用；项目配置中的安全敏感键自下次会话起恢复忽略。',
        )
      } else if (action === 'status') {
        lines.push(
          `项目信任状态：${isProjectTrusted(agent.cwd) ? '已授信' : '未授信'}`,
          `启动授信提示：${isTrustPromptDismissed(agent.cwd) ? '已关闭（/trust 授信即恢复）' : '开启'}`,
          `已授信项目数：${listTrustedProjects().length}（清单存于 ~/.rivet/project-trust.json）`,
          '未授信时：项目 hooks 不执行；项目配置的 permissions/mcp/hooks/providers/env/network/fetch/ui.statusLine/agent.approval 等安全键被忽略。',
        )
      } else if (action === undefined) {
        trustProject(agent.cwd)
        lines.push(
          '已授信当前项目（/trust）。',
          '项目级 hooks 即刻生效；项目配置安全键自下次会话（重启）起参与合并。',
          '仅对你本机生效，绝不写回仓库；/trust off 可随时撤销。',
        )
      } else {
        lines.push('用法：/trust（授信）· /trust status（查询）· /trust off（撤销）')
      }
      pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/doctor',
    immediate: true,
    async handler(ctx) {
      const { pushStatic, setIsStreaming, agent } = ctx
      // Probe against the RESOLVED env (not raw process env) so results reflect
      // what the agent can actually run after GUI-launch PATH recovery.
      const resolved = getResolvedEnv(agent.cwd)
      const env = await detectEnv(agent.cwd, resolved)
      const shell = getShellCommand()
      const toolLine = (label: string, t: { available: boolean; command?: string; version?: string }): string =>
        `${label} ${t.available ? `已安装 (${t.version ?? t.command ?? 'unknown'})` : '未安装 / 未在 PATH'}`
      const lines = [
        '环境体检 (/doctor)',
        '═══════════════════════',
        `平台: ${env.platform}`,
        toolLine('Node:  ', env.node),
        toolLine('Git:   ', env.git),
        toolLine('Python:', env.python),
        toolLine('uv:    ', env.uv),
        toolLine('Java:  ', env.java),
        toolLine('Maven: ', env.maven),
        toolLine('Gradle:', env.gradle),
        '',
        'Shell (bash 工具实际使用)',
        '───────────────────────',
        `kind: ${shell.kind}   cmd: ${shell.cmd}`,
      ]
      if (env.platform === 'win32' && shell.kind !== 'bash') {
        lines.push('', '⚠ Windows 未使用 Git Bash — 命令执行已退回 ' + shell.kind + '。')
        lines.push('  安装 Git for Windows 可获得更可靠的 POSIX 命令执行。')
      }

      // PATH recovery diff: show what the resolver added on top of the raw
      // process PATH, so the user knows whether GUI-launch recovery kicked in and
      // what to add to `env.extraPath` if a tool is still missing.
      const diff = getResolvedPathDiff(agent.cwd)
      lines.push('', 'PATH 解析 (GUI 启动兜底)', '───────────────────────')
      lines.push(`process PATH 条目: ${diff.processPath.length}   resolved PATH 条目: ${diff.resolvedPath.length}`)
      if (diff.added.length > 0) {
        lines.push('已补全以下目录（进程 PATH 缺失）:')
        for (const d of diff.added.slice(0, 20)) lines.push(`  + ${d}`)
        if (diff.added.length > 20) lines.push(`  … 及另外 ${diff.added.length - 20} 项`)
      } else {
        lines.push('resolved PATH 与 process PATH 一致（无需补全）。')
      }
      const stillMissing = [
        !env.git.available ? 'git' : null,
        !env.java.available ? 'java' : null,
        !env.maven.available ? 'mvn' : null,
        !env.gradle.available ? 'gradle' : null,
      ].filter(Boolean)
      if (stillMissing.length > 0) {
        lines.push('', `仍未找到: ${stillMissing.join(', ')}`)
        lines.push('若已安装，请把其可执行目录加入配置 env.extraPath（数组），或设置对应的 *_HOME 变量后重启天枢。')
      }

      const guidance = formatEnvGuidance(env)
      const footer = '更多排障：/logs（本会话日志落点）· 排障手册 github.com/huiliyi37/Tianshu-Tui/blob/main/docs/guides/troubleshooting.md'
      pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') + (guidance ? '\n\n' + guidance : '') + '\n\n' + footer }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/logs',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming, agent, currentSessionId } = ctx
      // 直接复用 `rivet logs` 的实现，不在这里重写一遍路径推导与 open 逻辑——
      // 两处措辞一旦分叉，用户在 TUI 和终端里会看到互相矛盾的落点说明。
      // 会话 id 显式透传：CLI 缺省是「最近写入的会话」，而 TUI 要的是当前这个。
      const { runLogsCLI } = await import('../diagnostics/logs-cli.js')
      const { output } = runLogsCLI(
        ['--session', currentSessionId, ...parts.slice(1)],
        { cwd: agent.cwd },
      )
      const isOpen = parts[1]?.toLowerCase() === 'open'
      const hint = isOpen ? '' : '\n\n用 /logs open 打开会话目录，/logs open desktop 打开 sidecar 日志目录。'
      pushStatic(createLogEntry({ type: 'system', content: output + hint }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/chat',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      pushStatic(createLogEntry({ type: 'system', content: '模式已由消息内容自动检测，无需手动切换。任务脚手架在有明确意图时自动开启。' }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/task',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      pushStatic(createLogEntry({ type: 'system', content: '模式已由消息内容自动检测，无需手动切换。任务脚手架在有明确意图时自动开启。子代理任务面板（查看/管理 worker）请用 /tasks。' }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/mode',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      pushStatic(createLogEntry({ type: 'system', content: '模式已由消息内容自动检测，无需手动切换。' }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/goal',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const parsed = parseGoalArgs(parts.slice(1))
      if (!parsed.goalText) {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /goal <task description> [--max N] [--budget M] [--criteria \'["..."]\']\nSets a persistent goal. The agent will auto-continue until the goal is achieved or the budget is exhausted.\nCancel with /goal-cancel.' }))
        setIsStreaming(false)
        return true
      }
      const { GoalTracker, buildGoalModePrompt } = await import('../agent/goal-tracker.js')
      const maxIterations = parsed.maxIterations ?? Math.max(50, Math.floor(ctx.maxTokens / 4000))
      const tracker = new GoalTracker({
        goal: parsed.goalText,
        maxIterations,
        contextWindow: ctx.maxTokens,
        wallClockMs: parsed.wallClockMs,
        maxJudgeRuns: ctx.agent.config.goalJudge?.maxRuns,
      })
      if (parsed.criteria) {
        tracker.setSuccessCriteria(parsed.criteria)
      }
      ctx.agent.setGoalTracker(tracker)
      if (ctx.goalTrackerRef) ctx.goalTrackerRef.current = tracker
      await persistGoalState(ctx, tracker)
      const budgetHint = parsed.wallClockMs !== undefined
        ? `Wall-clock budget: ${Math.round(parsed.wallClockMs / 60000)}m. `
        : ''
      pushStatic(createLogEntry({ type: 'system', content: `🎯 Goal activated: ${parsed.goalText}\nMax iterations: ${maxIterations}. ${budgetHint}Output "GOAL ACHIEVED" to complete, "GOAL BLOCKED" for blockers, or /goal-cancel to abort.\nUse /goal-pause to pause, /goal-resume to resume.` }))
      if (ctx.agent.config.goalJudge?.enabled !== false && !parsed.criteria) {
        void (async () => {
          try {
            const { extractGoalCriteria, completionFromClient, buildCheapClient } = await import('../agent/goal-criteria.js')
            const { loadConfig } = await import('../config/manager.js')
            const cfg = await loadConfig()
            const cheapProfile = cfg.workers?.profiles?.cheap
            const allProviders = ctx.agent.config.allProviders ?? {}
            let completion
            if (cheapProfile && allProviders[cheapProfile.provider]) {
              const cheap = buildCheapClient(cheapProfile, allProviders, ctx.agent.config.sessionId)
              completion = cheap
                ? completionFromClient(cheap.client, cheap.model)
                : completionFromClient(ctx.agent.config.client, ctx.agent.config.promptEngine.getModel())
            } else {
              completion = completionFromClient(ctx.agent.config.client, ctx.agent.config.promptEngine.getModel())
            }
            const criteria = await extractGoalCriteria(parsed.goalText, completion)
            tracker.setSuccessCriteria(criteria)
            await persistGoalState(ctx, tracker)
            pushStatic(createLogEntry({ type: 'system', content: `🔍 Judge 验收项（完成时独立核验）：\n${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}` }))
          } catch {
            pushStatic(createLogEntry({ type: 'system', content: '🔍 验收项提取已降级为宽判模式（extraction failed）。' }))
          }
        })()
      }
      setIsStreaming(false)
      ctx.submitToAgent?.(buildGoalModePrompt(parsed.goalText))
      return true
    },
  },
  {
    name: '/cancel-goal',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      ctx.agent.setGoalTracker(null)
      if (ctx.goalTrackerRef) ctx.goalTrackerRef.current = null
      // Clean up persisted goal state if session info is available
      if (ctx.currentSessionId) {
        try {
          const { deleteGoalState } = await import('../agent/goal-persist.js')
          const { getSessionDir } = await import('../agent/session-persist.js')
          deleteGoalState(getSessionDir(ctx.agent.cwd), ctx.currentSessionId)
        } catch { /* best-effort */ }
      }
      pushStatic(createLogEntry({ type: 'system', content: '🚫 Goal cancelled.' }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/goal-resume',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const tracker = ctx.goalTrackerRef?.current
      if (!tracker) {
        pushStatic(createLogEntry({ type: 'system', content: 'No paused or blocked goal to resume. Use /goal <task> to start one.' }))
        setIsStreaming(false)
        return true
      }
      const status = tracker.getStatus()
      if (status !== 'paused' && status !== 'blocked') {
        pushStatic(createLogEntry({ type: 'system', content: `Goal is ${status}, cannot resume.` }))
        setIsStreaming(false)
        return true
      }
      tracker.resume('user')
      const wallElapsed = Math.round(tracker.getWallClockElapsedMs() / 1000)
      pushStatic(createLogEntry({ type: 'system', content: `▶️ Goal resumed: ${tracker.getGoal()}\nIteration: ${tracker.getIteration()}/${tracker.getMaxIterations()} | ⏱ ${wallElapsed}s elapsed.` }))
      ctx.submitToAgent?.(`[GOAL RESUME] 继续执行目标: ${tracker.getGoal()}`)
      return true
    },
  },
  {
    name: '/goal-criteria',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const tracker = ctx.goalTrackerRef?.current
      if (!tracker) {
        pushStatic(createLogEntry({ type: 'system', content: 'No active goal. Use /goal <task> first.' }))
        setIsStreaming(false)
        return true
      }
      const subCmd = parts[1]?.toLowerCase()
      if (subCmd === 'set') {
        // /goal-criteria set <json array>
        const jsonText = parts.slice(2).join(' ').trim()
        if (!jsonText) {
          pushStatic(createLogEntry({ type: 'system', content: 'Usage: /goal-criteria set \'["criterion 1", "criterion 2"]\'' }))
          setIsStreaming(false)
          return true
        }
        try {
          const criteria = JSON.parse(jsonText)
          if (!Array.isArray(criteria) || !criteria.every((c: unknown) => typeof c === 'string')) {
            throw new Error('Expected a JSON array of strings')
          }
          tracker.setSuccessCriteria(criteria as string[])
          pushStatic(createLogEntry({ type: 'system', content: `✅ 验收项已更新（${(criteria as string[]).length} 项）:\n${(criteria as string[]).map((c, i) => `${i + 1}. ${c}`).join('\n')}` }))
        } catch (e) {
          pushStatic(createLogEntry({ type: 'system', content: `❌ 解析失败: ${(e as Error).message}` }))
        }
      } else {
        // Show current criteria
        const criteria = tracker.getSuccessCriteria()
        if (criteria.length === 0) {
          pushStatic(createLogEntry({ type: 'system', content: '当前无验收项（提取未完成或失败）。\n用 /goal-criteria set \'["..."]\' 手动设置。' }))
        } else {
          pushStatic(createLogEntry({ type: 'system', content: `📋 Judge 验收项（${criteria.length} 项）:\n${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\n用 /goal-criteria set '["..."]' 覆盖。` }))
        }
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/goal-status',
    immediate: true,
    handler(ctx) {
      const { pushStatic, setIsStreaming } = ctx
      const tracker = ctx.goalTrackerRef?.current
      if (!tracker) {
        pushStatic(createLogEntry({ type: 'system', content: 'No active goal. Use /goal <task> to start one.' }))
      } else {
        pushStatic(createLogEntry({ type: 'system', content: formatGoalStatus(tracker) }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/goal-pause',
    immediate: true,
    async handler(ctx) {
      const { pushStatic, setIsStreaming } = ctx
      const tracker = ctx.goalTrackerRef?.current
      if (!tracker) {
        pushStatic(createLogEntry({ type: 'system', content: 'No active goal to pause. Use /goal <task> to start one.' }))
        setIsStreaming(false)
        return true
      }
      const status = tracker.getStatus()
      if (status !== 'active') {
        pushStatic(createLogEntry({ type: 'system', content: `Goal is ${status}, cannot pause.` }))
        setIsStreaming(false)
        return true
      }
      tracker.pause('Paused by user', 'user')
      await persistGoalState(ctx, tracker)
      pushStatic(createLogEntry({ type: 'system', content: `⏸ Goal paused: ${tracker.getGoal()}\nIteration: ${tracker.getIteration()}/${tracker.getMaxIterations()} | Use /goal-resume to continue.` }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/capsule',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const sub = parts[1]?.toLowerCase()
      const off = sub === 'off' || sub === 'rm' || sub === 'remove'
      const target = (off ? parts[2] : parts[1])
      if (!sub || sub === 'list' || sub === 'status') {
        const current = ctx.agent.getSessionDomain()
        const active = ctx.agent.listCapsules()
        const activeLines = active.length > 0 ? active.map(n => `  ◉ ${n}`).join('\n') : '  （无）'
        pushStatic(createLogEntry({ type: 'system', content: `星域胶囊（消息级注入——正文进对话不进前缀，零缓存代价）\n\n主域: ${current ? `${current.name} (${current.id})` : '未绑定'}\n生效中 (${active.length}/2):\n${activeLines}\n\n/capsule <星名> 注入 · /capsule off <星名> 摘除 — 最多 2 枚。` }))
      } else if (!target) {
        pushStatic(createLogEntry({ type: 'system', content: '用法: /capsule <星名> 注入 · /capsule off <星名> 摘除 · /capsule 查看。星名同 recall_capsule（如 天权 / 瑶光 / 天璇）。', isError: true }))
      } else if (off) {
        const result = ctx.agent.clearCapsule(target)
        if (result.ok) {
          pushStatic(createLogEntry({ type: 'system', content: `已摘除胶囊记账: ${target}\n生效中: ${ctx.agent.listCapsules().join(' + ') || '无'}\n（已注入的正文仍在会话历史中对模型生效，摘除只释放槽位。）` }))
        } else {
          pushStatic(createLogEntry({ type: 'system', content: result.error, isError: true }))
        }
      } else {
        const cwd = ctx.agent.cwd
        const capsule = getCapsuleByStar(cwd, target)
        if (!capsule) {
          const known = listCapsuleStars(cwd)
          pushStatic(createLogEntry({ type: 'system', content: `没有「${target}」的胶囊。已知星域: ${known.join(', ') || '（无）'}\n（胶囊正文来自 seed-capsule，与 recall_capsule 同源。）`, isError: true }))
        } else {
          const note = ctx.agent.noteCapsuleInjection(capsule.star)
          if (!note.ok) {
            pushStatic(createLogEntry({ type: 'system', content: note.error, isError: true }))
          } else if (ctx.submitToAgent) {
            ctx.submitToAgent(`[星域胶囊注入] 用户经 /capsule 请求在当前主域（身份不变、不切换星域）的前提下，按下列${capsule.star}方法论处理接下来的任务：\n\n${capsule.block}`)
            pushStatic(createLogEntry({ type: 'system', content: `已注入 ${capsule.star} 胶囊（封存于 ${capsule.sealedAt}）——正文随下一条消息进入对话，前缀缓存零影响。\n生效中: ${ctx.agent.listCapsules().join(' + ')}` }))
          } else {
            // 记账已占用槽位——注入通道缺失时回滚，避免白占
            ctx.agent.clearCapsule(capsule.star)
            pushStatic(createLogEntry({ type: 'system', content: '当前环境无消息注入通道（headless/测试）。可让模型自行调用 recall_capsule 工具——同样的胶囊正文，同样零缓存代价。', isError: true }))
          }
        }
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/domain',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const sub = parts[1]?.toLowerCase()
      if (!sub || sub === 'status') {
        // Show current domain
        const current = ctx.agent.getSessionDomain()
        if (current === undefined) {
          pushStatic(createLogEntry({ type: 'system', content: '星域\n\n尚未激活。发送第一条消息后将根据内容自动匹配。\n使用 /domain list 查看所有星域，/domain <名称> 手动指定。' }))
        } else if (current === null) {
          pushStatic(createLogEntry({ type: 'system', content: '星域\n\n当前无星域（自动匹配未命中）。\n使用 /domain <名称> 手动指定，或 /domain auto 重置为自动检测。' }))
        } else {
          pushStatic(createLogEntry({ type: 'system', content: `星域\n\n当前: ${current.name} (${current.id})\n座右铭: ${current.motto}\n\n${current.volatileBlock}` }))
        }
      } else if (sub === 'list' || sub === 'ls') {
        const current = ctx.agent.getSessionDomain()
        const currentId = current?.id
        const lines = (starDomainRegistry.list() as Array<{ id: StarDomainId; name: string; keywords: string[]; decisionStyle: string; motto: string }>).map(d => {
          const marker = d.id === currentId ? ' ← current' : ''
          return `  ${d.name} (${d.id}) [${d.decisionStyle}]${marker}\n    ${d.motto}\n    keywords: ${d.keywords.join(', ')}`
        })
        pushStatic(createLogEntry({ type: 'system', content: `星域一览\n\n${lines.join('\n\n')}\n\n使用 /domain <id|名称> 切换，/domain auto 恢复自动检测。` }))
      } else if (sub === 'auto') {
        const midSession = ctx.agent.getSessionTurnCount() > 0
        ctx.agent.resetSessionDomain()
        ctx.onDomainChange?.(undefined)
        pushStatic(createLogEntry({ type: 'system', content: '星域已重置为自动检测模式。下一次对话将根据输入内容自动匹配星域。' }))
        if (midSession) pushStatic(createLogEntry({ type: 'system', content: DOMAIN_SWITCH_CACHE_WARNING }))
      } else {
        // Try to match by id or Chinese name
        const allDomains = starDomainRegistry.list()
        const matched = allDomains.find(d => d.id === sub || d.name === parts[1] || d.id === parts[1]?.toLowerCase())
        if (matched) {
          const midSession = ctx.agent.getSessionTurnCount() > 0
          const domain = { id: matched.id, name: matched.name, volatileBlock: matched.volatileBlock, motto: matched.motto, courageThreshold: matched.courageThreshold }
          ctx.agent.setSessionDomain(domain)
          ctx.onDomainChange?.(domain.name)
          pushStatic(createLogEntry({ type: 'system', content: `星域切换: ${domain.name} (${domain.id})\n${domain.motto}\n\n${domain.volatileBlock}` }))
          if (midSession) pushStatic(createLogEntry({ type: 'system', content: DOMAIN_SWITCH_CACHE_WARNING }))
        } else {
          const validNames = allDomains.map(d => `${d.name}|${d.id}`).join(', ')
          pushStatic(createLogEntry({ type: 'system', content: `未知星域: "${parts[1]}"\n\n可用星域: ${validNames}\n\n使用 /domain list 查看所有星域。`, isError: true }))
        }
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/verbose',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const nextVerbose = !ctx.verboseRef.current
      ctx.setVerbose(nextVerbose)
      pushStatic(createLogEntry({ type: 'system', content: nextVerbose ? 'Verbose mode: on (show 200 lines)' : 'Verbose mode: off (show 20 lines)' }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/evidence',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const state = ctx.agent.getEvidenceState()
      if (state.verifications.length === 0) {
        pushStatic(createLogEntry({ type: 'system', content: 'No evidence recorded yet this session.' }))
      } else {
        const recent = state.verifications.slice(-10)
        const lines = ['Evidence Summary (last 10 verifications):', '']
        for (const v of recent) {
          const glyph = v.status === 'passed' ? '✓' : v.status === 'failed' ? '✗' : '◐'
          const time = v.timestamp ? new Date(v.timestamp).toLocaleTimeString() : ''
          lines.push(`  ${glyph} ${v.command}  (${v.status})  ${time}`)
        }
        const passRate = Math.round((recent.filter(v => v.status === 'passed').length / recent.length) * 100)
        lines.push('', `Pass rate: ${passRate}% (${recent.filter(v => v.status === 'passed').length}/${recent.length})`)
        pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/permission',
    immediate: true,
    handler(ctx) {
      const { parts, agent, pushStatic, setIsStreaming } = ctx
      const sub = parts[1]?.toLowerCase()

      const VALID_MODES = ['auto-accept', 'auto-safe', 'manual', 'dangerously-skip-permissions'] as const
      type RuntimeMode = typeof VALID_MODES[number]
      function isRuntimeMode(m: string): m is RuntimeMode {
        return (VALID_MODES as readonly string[]).includes(m)
      }
      const MODE_LABELS: Record<RuntimeMode, string> = {
        'auto-accept': 'auto-accept — 自动接受低风险工具调用',
        'auto-safe': 'auto-safe — 低/无风险自动过，高风险仍弹确认',
        'manual': 'manual — 所有需 approval 的工具都弹确认',
        'dangerously-skip-permissions': 'yolo (dangerously-skip-permissions) — 跳过所有权限确认',
      }

      function parseKvPairs(tokens: string[]): Record<string, string> {
        const out: Record<string, string> = {}
        for (const t of tokens) {
          const idx = t.indexOf('=')
          if (idx > 0) {
            let value = t.slice(idx + 1)
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
              value = value.slice(1, -1)
            }
            out[t.slice(0, idx)] = value
          }
        }
        return out
      }

      function ruleSource(rules: unknown[], overlay: unknown[], index: number): string {
        if (index < rules.length) return '[config]'
        return '[session]'
      }

      function formatRules() {
        const cfg = agent.config.permissions
        const overlay = agent.config.permissionsOverlay
        const allow = [...(cfg?.allow ?? []), ...(overlay?.allow ?? [])]
        const deny = [...(cfg?.deny ?? []), ...(overlay?.deny ?? [])]
        const bashAllow = [...(cfg?.bash?.allowlist ?? []), ...(overlay?.bashAllow ?? [])]
        const bashDeny = [...(cfg?.bash?.denylist ?? []), ...(overlay?.bashDeny ?? [])]

        const lines: string[] = []
        const currentMode = agent.config.approvalMode ?? 'manual'
        const currentLabel = formatPermissionLabel(currentMode)
        lines.push(`当前权限: ${currentLabel} (${currentMode})`)
        lines.push('')
        lines.push('快速切换: /permission supervise | /permission auto [轮次] | /permission unattended [confirm]')
        lines.push('别名: manual → 监督 · yolo → 全自动 · /yes → 全自动')
        lines.push('')

        if (allow.length > 0) {
          lines.push('\nAllow 规则：')
          allow.forEach((r, i) => {
            const params = r.params ? Object.entries(r.params).map(([k, v]) => `${k}="${v}"`).join(' ') : ''
            lines.push(`  ${i}. ${ruleSource(cfg?.allow ?? [], overlay?.allow ?? [], i)} ${r.tool}${params ? ' ' + params : ''}`)
          })
        }
        if (deny.length > 0) {
          lines.push('\nDeny 规则：')
          deny.forEach((r, i) => {
            const params = r.params ? Object.entries(r.params).map(([k, v]) => `${k}="${v}"`).join(' ') : ''
            lines.push(`  ${i}. ${ruleSource(cfg?.deny ?? [], overlay?.deny ?? [], i)} ${r.tool}${params ? ' ' + params : ''}`)
          })
        }
        if (bashAllow.length > 0) {
          lines.push(`\nBash 前缀白名单：${bashAllow.join(', ')}`)
        }
        if (bashDeny.length > 0) {
          lines.push(`\nBash 前缀黑名单：${bashDeny.join(', ')}`)
        }
        if (allow.length === 0 && deny.length === 0 && bashAllow.length === 0 && bashDeny.length === 0) {
          lines.push('\n当前没有任何 allow/deny 规则。')
        }
        lines.push('\n说明：deny 规则优先于 allow 和 approval mode；session 规则仅本次会话有效。')
        return lines.join('\n')
      }

      if (!sub) {
        // 无参数 → 弹出交互式权限选择面板（上下选 + 回车确认，同 /effort 风格，kimi-code 对标）
        ctx.setChoicePanelKind?.('permission')
        ctx.surfacePush?.('choice-panel')
        setIsStreaming(false)
        return true
      }

      if (sub === 'status') {
        // /permission status → 显示当前模式 + 所有规则（文字视图）
        pushStatic(createLogEntry({ type: 'system', content: formatRules() }))
        setIsStreaming(false)
        return true
      }

      // ── 三档快速切换（主词 + 旧别名） ──

      const aliased = parsePermissionAlias(sub)
      if (aliased === 'supervise') {
        agent.setApprovalMode(tierToMode('supervise'))
        ctx.setAutoSafe(false)
        ctx.persistApprovalMode?.(tierToMode('supervise'))
        pushStatic(createLogEntry({ type: 'system', content: '✓ 已切换至 监督 — 所有高风险操作都需人工确认（已设为默认，重启后仍生效）' }))
        setIsStreaming(false)
        return true
      }

      if (aliased === 'auto' && sub !== 'auto-accept') {
        const intervalRaw = parts[2]
        if (intervalRaw !== undefined) {
          const v = Number(intervalRaw)
          if (!Number.isInteger(v) || v < 0) {
            pushStatic(createLogEntry({ type: 'system', content: '轮数必须是非负整数。用法: /permission auto [轮次]', isError: true }))
            setIsStreaming(false)
            return true
          }
          setCheckpointConfig({ checkpointEveryTurns: v })
        }
        agent.setApprovalMode(tierToMode('auto'))
        ctx.setAutoSafe(true)
        ctx.persistApprovalMode?.(tierToMode('auto'))
        const interval = intervalRaw !== undefined ? Number(intervalRaw) : undefined
        const cpNote = interval !== undefined ? (interval > 0 ? `，检查点每 ${interval} 轮暂停` : '，检查点已关闭') : ''
        pushStatic(createLogEntry({ type: 'system', content: `✓ 已切换至 自动 — 低/无风险工具自动执行，高风险仍需确认${cpNote}（已设为默认，重启后仍生效）\n\n  调整检查点: /permission auto <轮数>（0 = 关）` }))
        setIsStreaming(false)
        return true
      }

      if (aliased === 'unattended') {
        const confirmed = parts[2]?.toLowerCase() === 'confirm'
        if (!confirmed) {
          pushStatic(createLogEntry({ type: 'system', content: [
            '⚠ 全自动风险说明',
            '',
            '  · 无轮次刹车 — run 一直执行到完成或 maxTurns 上限',
            '  · 无进度播报 — 完全静默运行',
            '  · 所有工具调用直接执行，不再弹确认',
            '  · 沙箱仍拦截项目外写入',
            '  · 回滚兜底：/rollback + git 检查点',
            '  · Windows 注意：沙箱能力降级',
            '',
            '确认进入: /permission unattended confirm  或  /permission yolo confirm  或  /yes',
          ].join('\n') }))
          setIsStreaming(false)
          return true
        }
        agent.setApprovalMode(tierToMode('unattended'))
        agent.config.maxTurns = 0
        ctx.setAutoSafe(false)
        ctx.persistApprovalMode?.(tierToMode('unattended'))
        pushStatic(createLogEntry({ type: 'system', content: '✓ 已切换至 全自动 — 全自动执行，无刹车无打扰（已设为默认，重启后仍生效）。/rollback 可随时回滚。关闭: /yes off' }))
        setIsStreaming(false)
        return true
      }

      // ── 高级 mode 命令（保留兼容） ──

      if (sub === 'mode') {
        const mode = parts[2]
        if (!mode || !isRuntimeMode(mode)) {
          pushStatic(createLogEntry({ type: 'system', content: `用法: /permission mode <${VALID_MODES.join('|')}>`, isError: true }))
          setIsStreaming(false)
          return true
        }
        agent.setApprovalMode(mode)
        ctx.setAutoSafe(mode === 'auto-safe')
        pushStatic(createLogEntry({ type: 'system', content: `Approval mode → ${mode}` }))
        setIsStreaming(false)
        return true
      }

      if (sub === 'allow' || sub === 'deny') {
        const tool = parts[2]
        if (!tool) {
          pushStatic(createLogEntry({ type: 'system', content: `用法: /permission ${sub} <tool> [param=value]...`, isError: true }))
          setIsStreaming(false)
          return true
        }
        const rule = { tool, params: parseKvPairs(parts.slice(3)) }
        if (Object.keys(rule.params).length === 0) delete (rule as { params?: Record<string, string> }).params
        if (sub === 'allow') agent.addAllowRule(rule)
        else agent.addDenyRule(rule)
        const paramsStr = rule.params ? Object.entries(rule.params).map(([k, v]) => `${k}="${v}"`).join(' ') : ''
        pushStatic(createLogEntry({ type: 'system', content: `已添加 ${sub} 规则: ${tool}${paramsStr ? ' ' + paramsStr : ''}` }))
        setIsStreaming(false)
        return true
      }

      if (sub === 'bash') {
        const action = parts[2]?.toLowerCase()
        if (action !== 'allow' && action !== 'deny') {
          pushStatic(createLogEntry({ type: 'system', content: '用法: /permission bash allow|deny <prefix>', isError: true }))
          setIsStreaming(false)
          return true
        }
        const prefix = parts.slice(3).join(' ')
        if (!prefix) {
          pushStatic(createLogEntry({ type: 'system', content: '用法: /permission bash allow|deny <prefix>', isError: true }))
          setIsStreaming(false)
          return true
        }
        if (action === 'allow') agent.addBashAllowPrefix(prefix)
        else agent.addBashDenyPrefix(prefix)
        pushStatic(createLogEntry({ type: 'system', content: `已添加 bash ${action === 'allow' ? '白名单' : '黑名单'}前缀: ${prefix}` }))
        setIsStreaming(false)
        return true
      }

      if (sub === 'remove') {
        const kindRaw = parts[2]?.toLowerCase()
        const target = parts[3]
        if (!kindRaw || !target || !['allow', 'deny', 'bashallow', 'bashdeny'].includes(kindRaw)) {
          pushStatic(createLogEntry({ type: 'system', content: '用法: /permission remove allow|deny|bashAllow|bashDeny <index|pattern>', isError: true }))
          setIsStreaming(false)
          return true
        }
        const kind = kindRaw as 'allow' | 'deny' | 'bashAllow' | 'bashDeny'
        const idx = parseInt(target, 10)
        const key = Number.isNaN(idx) ? target : idx
        const ok = agent.removePermissionRule(kind, key)
        pushStatic(createLogEntry({ type: 'system', content: ok ? `已移除 ${kind} 规则: ${target}` : `未找到 ${kind} 规则: ${target}`, isError: !ok }))
        setIsStreaming(false)
        return true
      }

      if (sub === 'reset') {
        agent.resetPermissionOverlay()
        pushStatic(createLogEntry({ type: 'system', content: '已清空本次会话所有运行时权限覆盖。' }))
        setIsStreaming(false)
        return true
      }

      if (sub === 'test') {
        const tool = parts[2]
        const json = parts.slice(3).join(' ')
        if (!tool || !json) {
          pushStatic(createLogEntry({ type: 'system', content: '用法: /permission test <tool> <json input>', isError: true }))
          setIsStreaming(false)
          return true
        }
        let input: Record<string, unknown>
        try {
          input = JSON.parse(json) as Record<string, unknown>
        } catch {
          pushStatic(createLogEntry({ type: 'system', content: 'JSON 解析失败', isError: true }))
          setIsStreaming(false)
          return true
        }
        const allDeny = [...(agent.config.permissions?.deny ?? []), ...(agent.config.permissionsOverlay?.deny ?? [])]
        const allAllow = [...(agent.config.permissions?.allow ?? []), ...(agent.config.permissionsOverlay?.allow ?? [])]
        const bashDeny = [...(agent.config.permissions?.bash?.denylist ?? []), ...(agent.config.permissionsOverlay?.bashDeny ?? [])]
        const bashAllow = [...(agent.config.permissions?.bash?.allowlist ?? []), ...(agent.config.permissionsOverlay?.bashAllow ?? [])]

        const denied = tool === 'bash' && typeof input.command === 'string'
          ? isBashCommandDenied(input.command, bashDeny)
          : isToolDenied(tool, input, allDeny)
        if (denied) {
          pushStatic(createLogEntry({ type: 'system', content: `结果: deny（命中 deny 规则）` }))
          setIsStreaming(false)
          return true
        }
        const allowlisted = tool === 'bash' && typeof input.command === 'string'
          ? isBashCommandAllowlisted(input.command, bashAllow)
          : isToolAllowed(tool, input, allAllow)
        if (allowlisted) {
          pushStatic(createLogEntry({ type: 'system', content: '结果: allow（命中 allow 规则）' }))
          setIsStreaming(false)
          return true
        }
        const needsApproval = agent.config.toolRegistry.needsApproval(tool, { input, toolUseId: 'test', cwd: ctx.agent.cwd })
        pushStatic(createLogEntry({ type: 'system', content: `结果: ask（需要 approval：${needsApproval ? '是' : '否'}）` }))
        setIsStreaming(false)
        return true
      }

      pushStatic(createLogEntry({ type: 'system', content: '未知子命令。用法: /permission [status|mode|allow|deny|bash|remove|reset|test]', isError: true }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/grant',
    immediate: true,
    async handler(ctx) {
      const { parts, agent, pushStatic, setIsStreaming } = ctx
      const cwd = agent.cwd
      const target = parts[1]

      if (!target) {
        // 无参 → 列出本工作区已记住的目录授权。只列 listPersistedGrants：
        // 内存 store 还含依赖缓存/raw 输出目录等系统级会话授权，用户从未主动
        // 授权过，混进列表只会让人误以为可以/需要撤销。
        const persisted = listPersistedGrants(cwd)
        const lines: string[] = ['本工作区已记住的目录授权', '══════════════════════']
        if (persisted.length === 0) {
          lines.push('（无。用 /grant <路径> [read|write] 授权并记住，或在工作区外路径审批时选「批准并记住此目录」。）')
        } else {
          for (const g of persisted) {
            lines.push(`  ${g.mode === 'write' ? '✎' : '👁'} ${g.root}${g.mode === 'write' ? ' (读写)' : ' (只读)'}`)
          }
          lines.push('', '撤销：rivet config revoke-dir <路径>，或桌面端 设置 → 目录授权。')
        }
        pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') }))
        setIsStreaming(false)
        return true
      }

      const mode = parts[2]?.toLowerCase() === 'write' ? 'write' : 'read'
      grantPath(target, mode, { persist: true, cwd })
      pushStatic(createLogEntry({
        type: 'system',
        content: `✓ 已授权并记住 ${mode === 'write' ? '读写' : '只读'}访问 "${target}"（本工作区，重启后仍生效）`,
      }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/plan-mode',
    immediate: true,
    handler(ctx) {
      const { pushStatic, setIsStreaming } = ctx
      if (ctx.agent.getPlanModeState() === 'planning') {
        const now = Date.now()
        if (planModeExitArmedAt !== 0 && now - planModeExitArmedAt <= PLAN_MODE_EXIT_CONFIRM_MS) {
          planModeExitArmedAt = 0
          ctx.agent.exitPlanMode()
          pushStatic(createLogEntry({ type: 'system', content: 'Plan Mode 已关闭 — 写入操作已解锁。' }))
        } else {
          planModeExitArmedAt = now
          const activePath = ctx.agent.getActivePlanFilePath()
          pushStatic(createLogEntry({
            type: 'system',
            content: `🔍 Plan Mode 仍在运行。${activePath ? `\n活动计划文件: \`${activePath}\`` : ''}\n\n⚠ 计划尚未批准。再执行一次 /plan-mode 放弃当前计划并退出，或用 /plan-approve <slug> 批准后执行。`,
          }))
        }
        setIsStreaming(false)
        return true
      }
      planModeExitArmedAt = 0
      ctx.agent.enterPlanMode()
      pushStatic(createLogEntry({ type: 'system', content: '🔍 Plan Mode activated. Write operations are blocked except the active plan file.\n\nWorkflow: identify key questions → delegate_task (code_scout) / web_search → write plan incrementally → ask_user_question or plan submit.\n\nWhen ready:\n  plan action=submit — submit for approval\n  /plan-list — list submitted plans\n  /plan-approve <slug> [option] — approve and start execution\n  /plan-reject <slug> <feedback> — reject with feedback (plan mode stays active)\n\n/plan-mode — exit plan mode (double-confirm if unapproved)' }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/ask',
    immediate: true,
    handler(ctx) {
      const { pushStatic, setIsStreaming } = ctx
      if (ctx.agent.getAskModeState?.() === 'asking' || ctx.agent.askModeState === 'asking') {
        ctx.agent.exitAskMode()
        pushStatic(createLogEntry({ type: 'system', content: 'Ask Mode 已关闭 — 写入与执行操作已解锁。' }))
        setIsStreaming(false)
        return true
      }
      ctx.agent.enterAskMode()
      pushStatic(createLogEntry({
        type: 'system',
        content:
          '? Ask Mode activated. Only read / search / ask_user_question are allowed.\n\n' +
          'Ask Mode 适合：代码问答、对照阅读、澄清需求。需要写改或跑命令时执行 /ask 退出。',
      }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/plan-list',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const cwd = ctx.agent.cwd
      const plans = await listPlans(cwd)
      if (plans.length === 0) {
        pushStatic(createLogEntry({ type: 'system', content: 'No plans found. Use /plan-mode to enter plan mode and create a plan.' }))
      } else {
        const lines = plans.map(p => {
          const statusIcon = p.status === 'approved' ? '✅' : p.status === 'rejected' ? '❌' : p.status === 'executed' ? '🏁' : '📋'
          return `  ${statusIcon} \`${p.slug}\` — ${p.title} (${p.status}, ${p.createdAt.toLocaleString()})`
        })
        pushStatic(createLogEntry({ type: 'system', content: `Plans (.rivet/plans/):\n\n${lines.join('\n')}\n\nUse /plan-approve <slug> to approve, /plan-reject <slug> to reject.` }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/plan-view',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cwd = ctx.agent.cwd
      const notify = (content: string, isError?: boolean) =>
        pushStatic(createLogEntry({ type: 'system', content, isError }))
      const rawArg = parts.slice(1).join(' ').trim()
      const plans = await listPlans(cwd)

      // ── Explicit arg: resolve tolerantly (same ref parsing as /plan-approve) ──
      if (rawArg) {
        const resolution = resolvePlanRef(plans, stripCopiedTitleSuffix(rawArg))
        if (resolution.kind !== 'match') {
          const hint = resolution.kind === 'ambiguous'
            ? `\n\nAmbiguous prefix, matches: ${resolution.slugs.join(', ')}`
            : ''
          notify(`Plan not found: "${rawArg}".${hint}\n\nUse /plan-list to see available plans.`, true)
          setIsStreaming(false)
          return true
        }
        if (ctx.openPlanPreview) ctx.openPlanPreview({ slug: resolution.plan.slug })
        else notify('Plan preview is only available in the TUI.', true)
        setIsStreaming(false)
        return true
      }

      // ── No arg: single pending plan first, else the active draft while writing ──
      const submitted = plans.filter(p => p.status === 'submitted')
      if (submitted.length === 1) {
        if (ctx.openPlanPreview) ctx.openPlanPreview({ slug: submitted[0]!.slug })
        else notify('Plan preview is only available in the TUI.', true)
        setIsStreaming(false)
        return true
      }
      const draftPath = ctx.agent.activePlanFilePath
      if (submitted.length === 0 && draftPath) {
        if (ctx.openPlanPreview) ctx.openPlanPreview({ draftPath })
        else notify('Plan preview is only available in the TUI.', true)
        setIsStreaming(false)
        return true
      }
      notify(submitted.length > 1
        ? `Multiple submitted plans:\n\n${submitted.map(p => `  /plan-view ${p.slug}`).join('\n')}`
        : 'Nothing to preview yet. Use /plan-mode to enter plan mode, or /plan-view <slug> after submitting.')
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/plan-approve',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cwd = ctx.agent.cwd
      const notify = (content: string, isError?: boolean) =>
        pushStatic(createLogEntry({ type: 'system', content, isError }))
      const kickoffDeps = { cwd, agent: ctx.agent, submitToAgent: ctx.submitToAgent, notify }
      const rawArg = parts.slice(1).join(' ').trim()
      const plans = await listPlans(cwd)

      // ── No arg: approve the single pending plan, else open the picker ──
      if (!rawArg) {
        const submitted = plans.filter(p => p.status === 'submitted')
        if (submitted.length === 0) {
          notify(plans.length > 0
            ? 'No submitted plans awaiting approval.\n\nUse /plan-list to see all plans.'
            : 'No plans to approve. Use /plan-mode to create one.')
          setIsStreaming(false)
          return true
        }
        if (submitted.length === 1) {
          // Sole pending plan → approve + kickoff directly (no slug typing needed).
          await approvePlanAndKickoff(kickoffDeps, submitted[0]!.slug)
          setIsStreaming(false)
          return true
        }
        // Multiple pending → interactive picker (arrow-select + Enter approves).
        if (ctx.surfacePush) {
          ctx.surfacePush('plan-picker')
        } else {
          const hint = submitted.map(p => `  /plan-approve ${p.slug}`).join('\n')
          notify(`Submitted plans awaiting approval:\n\n${hint}`)
        }
        setIsStreaming(false)
        return true
      }

      // ── Explicit arg: resolve tolerantly (handles copied "slug — title") ──
      // A copied hint contains " — "; a real approach is space-separated. Split so
      // the em-dash title junk never gets mistaken for an approach.
      let slugCandidate: string
      let approachRaw = ''
      if (rawArg.includes(' — ')) {
        slugCandidate = stripCopiedTitleSuffix(rawArg)
      } else {
        slugCandidate = parts[1]!
        approachRaw = parts.slice(2).join(' ').trim()
      }

      let resolution = resolvePlanRef(plans, slugCandidate)
      // Fallback: the whole arg may be a multi-word title, not slug + approach.
      if (resolution.kind === 'none' && approachRaw) {
        const full = resolvePlanRef(plans, rawArg)
        if (full.kind === 'match') { resolution = full; approachRaw = '' }
      }
      if (resolution.kind === 'none') {
        notify(`Plan not found: "${stripCopiedTitleSuffix(rawArg)}". Use /plan-list to see available plans.`, true)
        setIsStreaming(false)
        return true
      }
      if (resolution.kind === 'ambiguous') {
        notify(`Ambiguous plan ref "${stripCopiedTitleSuffix(rawArg)}". Matches:\n${resolution.slugs.map(s => `  \`${s}\``).join('\n')}\n\nUse the full slug, or /plan-approve (no arg) to pick interactively.`, true)
        setIsStreaming(false)
        return true
      }

      const plan = resolution.plan
      const slug = plan.slug

      // Validate the selected approach BEFORE mutating the plan file — approving
      // first would leave the file marked APPROVED even when the option is bogus.
      let resolvedApproach: string | undefined
      if (approachRaw) {
        if (plan.options && plan.options.length > 0) {
          resolvedApproach = resolvePlanOptionLabel(plan.options, approachRaw)
          if (!resolvedApproach) {
            const available = plan.options.map(o => `  \`${o.label}\``).join('\n')
            notify(`Unknown option "${approachRaw}". Available options:\n${available}`, true)
            setIsStreaming(false)
            return true
          }
        } else {
          resolvedApproach = approachRaw
        }
      }

      await approvePlanAndKickoff(kickoffDeps, slug, resolvedApproach)
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/plan-reject',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const slug = parts[1]?.toLowerCase()
      const feedback = parts.slice(2).join(' ').trim()
      if (!slug) {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /plan-reject <slug> [feedback]\n\nUse /plan-list to see available plans.', isError: true }))
        setIsStreaming(false)
        return true
      }

      const cwd = ctx.agent.cwd
      const rejected = await rejectPlan(cwd, slug)
      if (!rejected) {
        pushStatic(createLogEntry({ type: 'system', content: `Plan not found: "${slug}". Use /plan-list to see available plans.`, isError: true }))
        setIsStreaming(false)
        return true
      }

      ctx.agent.enterPlanMode({ planFilePath: `.rivet/plans/${slug}.md` })
      pushStatic(createLogEntry({
        type: 'system',
        content: `❌ Plan rejected: **${rejected.title}** (\`${slug}\`)\n\nPlan mode remains active. Revise \`.rivet/plans/${slug}.md\` in place, then resubmit with \`plan action=submit\`.${feedback ? '' : '\n\nTip: /plan-reject <slug> <feedback> injects revision guidance.'}`,
      }))
      if (feedback && ctx.submitToAgent) {
        ctx.submitToAgent(`User rejected the plan. Feedback:\n\n${feedback}`)
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/theme',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const raw = parts[1]?.toLowerCase()
      // validThemes derives from THEMES + custom registry so theme.ts remains the single source of truth.
      const validThemes: string[] = [
        ...Object.keys(THEMES),
        ...listCustomThemes().map(n => `custom:${n}`),
      ]
      if (!raw || raw === 'list') {
        const current = getActiveThemeName()
        const list = validThemes.map(t => `  ${t}${t === current ? ' ← current' : ''}`).join('\n')
        pushStatic(createLogEntry({ type: 'system', content: `Available themes:\n${list}\n\nUsage: /theme <name>` }))
      } else if (validThemes.includes(raw)) {
        setTheme(raw)
        pushStatic(createLogEntry({ type: 'system', content: `Theme switched to: ${raw}` }))
      } else {
        pushStatic(createLogEntry({ type: 'system', content: `Theme "${raw}" not found. Available: ${validThemes.join(', ')}` }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/prefix-budget',
    immediate: true,
    async handler(ctx) {
      const { pushStatic, setIsStreaming } = ctx
      const { formatBudgetReport } = await import('../prompt/prefix-budget.js')
      const { profile, toolDescriptions, report } = ctx.agent.getPrefixBudget()
      const lines = [
        formatBudgetReport(report),
        '',
        `档位 ${profile}（工具描述 ${toolDescriptions}）。切档在下个会话生效——改前缀等于全量重建缓存。`,
        '配置：prompt.profile = standard | lean | full，或 RIVET_PROMPT_PROFILE 环境变量。',
        'token 为 chars/4 粗估，中文内容实际偏高；用于跨块对比，勿与 API usage 直接比对。',
      ]
      pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/debug',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const subcmd = parts[1]
      const info = ctx.agent.getDebugInfo()
      if (subcmd === 'prompt') {
        pushStatic(createLogEntry({ type: 'system', content: `System prompt (${info.systemPromptLength} chars):\n${info.systemPromptPreview}\n\nTools (${info.toolCount}): ${info.toolNames.join(', ')}` }))
      } else if (subcmd === 'fingerprint') {
        const fp = info.fingerprint
        const drift = info.drift
        pushStatic(createLogEntry({ type: 'system', content: `Fingerprint:\n  system:  ${fp.systemSha256.slice(0, 16)}...\n  tools:   ${fp.toolsSha256.slice(0, 16)}...\n  combined: ${fp.combinedSha256.slice(0, 16)}...\n\nDrift: ${drift ? drift.message : 'none (cache stable)'}` }))
      } else if (subcmd === 'cache') {
        const usage = ctx.session.getTotalUsage()
        const hitRate = ctx.cacheHitRate
        const totalCached = usage.cache_read_input_tokens + usage.cache_creation_input_tokens
        pushStatic(createLogEntry({ type: 'system', content: `Cache:\n  hit rate: ${(hitRate * 100).toFixed(1)}%\n  read tokens: ${usage.cache_read_input_tokens.toLocaleString()}\n  write tokens: ${usage.cache_creation_input_tokens.toLocaleString()}\n  total cached: ${totalCached.toLocaleString()}\n  input tokens: ${usage.input_tokens.toLocaleString()}\n  output tokens: ${usage.output_tokens.toLocaleString()}\n  estimated: ${ctx.session.getEstimatedTokens().toLocaleString()}\n  cost: ¥${ctx.cost.toFixed(4)}\n  saved: ¥${((usage.cache_read_input_tokens * 0.9) / 1_000_000).toFixed(4)} (cache discount)` }))
      } else if (subcmd === 'context-payload') {
        pushStatic(createLogEntry({ type: 'system', content: formatVolatilePayloadReport(info.volatilePayloadReport) }))
      } else if (subcmd === 'mcp') {
        pushStatic(createLogEntry({ type: 'system', content: mcpStatusText(ctx.mcpManagerRef.current) }))
      } else {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /debug [prompt|fingerprint|cache|context-payload|mcp]' }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/rollback',
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      return false

    },
  },
  {
    name: '/clear',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      // Clear visual state — reset streaming text and thinking buffers
      setIsStreaming(false)
      pushStatic(createLogEntry({ type: 'system', content: 'Screen cleared.' }))
      return true

    },
  },
  {
    name: '/fork',
    description: 'Fork current session (optionally from a message line)',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      // /fork [name]       — fork current session, auto-switch to the copy
      // /fork at <N>       — fork from message line N (truncate after)
      // /fork at <N> <name>— fork from line N with a branch name
      const sessionDir = getSessionDir(ctx.agent.cwd)
      const sourceJsonl = join(sessionDir, `${ctx.currentSessionId}.jsonl`)
      const arg1 = parts[1]?.toLowerCase()

      let upToLine: number | undefined
      let branchName: string | undefined

      if (arg1 === 'at') {
        const n = parseInt(parts[2] ?? '', 10)
        if (!Number.isFinite(n) || n < 1) {
          pushStatic(createLogEntry({ type: 'system', content: '用法: /fork at <行号> [分支名]。行号必须 ≥ 1。' }))
          setIsStreaming(false)
          return true
        }
        upToLine = n
        branchName = parts.slice(3).join(' ').trim() || undefined
      } else if (arg1) {
        branchName = parts.slice(1).join(' ').trim() || undefined
      }

      if (!existsSync(sourceJsonl)) {
        pushStatic(createLogEntry({ type: 'system', content: `找不到当前会话日志: ${sourceJsonl}` }))
        setIsStreaming(false)
        return true
      }
      await ctx.persist.flushSessionBuffer().catch(() => {})
      // Validate upToLine against actual message count
      if (upToLine !== undefined) {
        const total = countMessageLines(sourceJsonl)
        if (upToLine > total) {
          pushStatic(createLogEntry({ type: 'system', content: `行号 ${upToLine} 超出当前消息总数 (${total})。` }))
          setIsStreaming(false)
          return true
        }
      }

      const result = forkSession({
        sourceJsonlPath: sourceJsonl,
        targetDir: sessionDir,
        upToLine,
        parentSessionId: ctx.currentSessionId,
        branchName,
      })

      const lineInfo = upToLine ? ` (截取前 ${upToLine} 行)` : ' (完整历史)'
      const nameInfo = branchName ? ` 分支名: ${branchName}` : ''
      pushStatic(createLogEntry({
        type: 'system',
        content: `🌿 Fork 已创建\n  新会话 ID: ${result.newSessionId}${lineInfo}${nameInfo}\n  (短码: ${result.newSessionId.slice(0, 8)})\n正在切换到新会话...`,
      }))

      // Auto-switch to the new session
      if (ctx.onSessionSwitch) {
        const res = ctx.onSessionSwitch(result.newSessionId)
        if (!res.ok) {
          pushStatic(createLogEntry({ type: 'system', content: `⚠ Fork 文件已创建但切换失败: ${res.error ?? '未知错误'}\n用 /resume ${result.newSessionId.slice(0, 8)} 手动切换。\n完整 ID: ${result.newSessionId}` }))
        } else {
          pushStatic(createLogEntry({
            type: 'system',
            content: `✅ 已切换到 fork 会话 (${result.newSessionId.slice(0, 8)})。\n完整 ID: ${result.newSessionId}\n原会话保持不变，用 /branch back 回去。`,
          }))
        }
      } else {
        pushStatic(createLogEntry({ type: 'system', content: `✅ Fork 已创建。\n用 /resume ${result.newSessionId.slice(0, 8)} 切换过去。\n完整 ID: ${result.newSessionId}` }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/branch',
    description: 'Show or switch session branches',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      // /branch            — show branch tree for current session
      // /branch list       — same
      // /branch back       — switch back to parent session
      const sub = parts[1]?.toLowerCase()
      const sessionDir = getSessionDir(ctx.agent.cwd)

      if (sub === 'back') {
        // Read current session's parentSessionId from meta.json
        const metaPath = join(sessionDir, `${ctx.currentSessionId}.meta.json`)
        if (!existsSync(metaPath)) {
          pushStatic(createLogEntry({ type: 'system', content: '当前会话没有父会话（这是一个根会话）。' }))
          setIsStreaming(false)
          return true
        }
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
          if (!meta.parentSessionId) {
            pushStatic(createLogEntry({ type: 'system', content: '当前会话没有父会话。' }))
            setIsStreaming(false)
            return true
          }
          if (ctx.onSessionSwitch) {
            const res = ctx.onSessionSwitch(meta.parentSessionId)
            if (!res.ok) {
              pushStatic(createLogEntry({ type: 'system', content: `切换回父会话失败: ${res.error ?? '未知错误'}` }))
            } else {
              pushStatic(createLogEntry({ type: 'system', content: `↩️ 已切换回父会话 (${meta.parentSessionId.slice(0, 8)})。\n完整 ID: ${meta.parentSessionId}` }))
            }
          } else {
            pushStatic(createLogEntry({ type: 'system', content: `父会话: ${meta.parentSessionId}\n用 /resume ${meta.parentSessionId.slice(0, 8)} 切换。` }))
          }
        } catch {
          pushStatic(createLogEntry({ type: 'system', content: '无法读取当前会话的元数据。' }))
        }
        setIsStreaming(false)
        return true
      }

      // Default: /branch or /branch list — show branch tree
      const lines: string[] = ['分支树', '════════']

      // Check if current session has a parent
      const currentMetaPath = join(sessionDir, `${ctx.currentSessionId}.meta.json`)
      if (existsSync(currentMetaPath)) {
        try {
          const meta = JSON.parse(readFileSync(currentMetaPath, 'utf-8'))
          if (meta.parentSessionId) {
            const parentMetaPath = join(sessionDir, `${meta.parentSessionId}.meta.json`)
            let parentLabel = meta.parentSessionId
            if (existsSync(parentMetaPath)) {
              const parentMeta = JSON.parse(readFileSync(parentMetaPath, 'utf-8'))
              if (parentMeta.title) parentLabel += ` "${parentMeta.title}"`
              if (parentMeta.branchName) parentLabel += ` (${parentMeta.branchName})`
            }
            lines.push(`⬆️ 父会话: ${parentLabel}`)
          } else {
            lines.push('⬆️ 父会话: 无 (根会话)')
          }
          if (meta.branchName) {
            lines.push(`🏷️ 当前分支名: ${meta.branchName}`)
          }
        } catch { /* meta corrupted */ }
      } else {
        lines.push('⬆️ 父会话: 无 (根会话)')
      }

      // List child branches
      const children = listBranches(sessionDir, ctx.currentSessionId)
      if (children.length > 0) {
        lines.push('', `⬇️ 子分支 (${children.length}):`)
        for (const child of children) {
          const name = child.branchName ?? '(unnamed)'
          const time = existsSync(join(sessionDir, `${child.sessionId}.meta.json`))
            ? (() => {
                try {
                  const m = JSON.parse(readFileSync(join(sessionDir, `${child.sessionId}.meta.json`), 'utf-8'))
                  return m.createdAt ? new Date(m.createdAt).toLocaleString() : ''
                } catch { return '' }
              })()
            : ''
          lines.push(`  ├️ ${child.sessionId} "${name}" ${time}`)
        }
      } else {
        lines.push('', '⬇️ 子分支: 无')
      }

      lines.push('', '提示: /fork [名称] 创建新分支, /branch back 回到父会话')
      pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/sessions',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const list = SessionPersist.formatSessionList(ctx.agent.cwd, ctx.currentSessionId)
      // Enhance with fork annotations: mark sessions that have a parentSessionId
      const sessionDir = getSessionDir(ctx.agent.cwd)
      const mainSessions = SessionPersist.listMainSessions(ctx.agent.cwd)
      const forkAnnotations: string[] = []
      for (const s of mainSessions) {
        const metaPath = join(sessionDir, `${s.id}.meta.json`)
        if (!existsSync(metaPath)) continue
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
          if (meta.parentSessionId) {
            const shortId = s.id.slice(0, 8)
            const shortParent = String(meta.parentSessionId).slice(0, 8)
            const name = meta.branchName ? ` "${meta.branchName}"` : ''
            forkAnnotations.push(`  ${shortId} ← fork from ${shortParent}${name}`)
          }
        } catch { /* skip */ }
      }
      const forkSection = forkAnnotations.length > 0
        ? `\n\n Fork 关系:\n${forkAnnotations.join('\n')}`
        : ''
      pushStatic(createLogEntry({
        type: 'system',
        content: `会话列表(按最近更新排序):\n${list}${forkSection}`,
      }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/resume',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const arg = parts[1]
      if (!arg) {
        // 无参 = 打开会话选择器（对齐 Claude Code /resume）；无选择器注入时退化为用法提示。
        if (ctx.openSessionPicker) {
          ctx.openSessionPicker()
        } else {
          pushStatic(createLogEntry({ type: 'system', content: '用法: /resume <id前缀 或 序号>。用 /sessions 查看会话列表。' }))
        }
        setIsStreaming(false)
        return true
      }

      // 序号(兼容旧习惯)或 id 前缀 → 解析为完整 id。
      const ordered = SessionPersist.listMainSessions(ctx.agent.cwd)
      let targetId: string | null = null
      if (/^\d+$/.test(arg)) {
        const idx = parseInt(arg, 10) - 1
        if (idx < 0 || idx >= ordered.length) {
          pushStatic(createLogEntry({ type: 'system', content: `序号超出范围(共 ${ordered.length} 个会话)。用 /sessions 查看。` }))
          setIsStreaming(false)
          return true
        }
        targetId = ordered[idx]!.id
      } else {
        const resolved = SessionPersist.resolveSessionId(ctx.agent.cwd, arg)
        if (!resolved) {
          pushStatic(createLogEntry({ type: 'system', content: `未找到匹配会话: "${arg}"。用 /sessions 查看会话列表。` }))
          setIsStreaming(false)
          return true
        }
        if ('ambiguous' in resolved) {
          const cands = resolved.ambiguous.map(id => `  ${id.slice(0, 12)}`).join('\n')
          pushStatic(createLogEntry({ type: 'system', content: `前缀 "${arg}" 匹配多个会话,请用更长前缀:\n${cands}` }))
          setIsStreaming(false)
          return true
        }
        targetId = resolved.id
      }

      if (targetId === ctx.currentSessionId) {
        pushStatic(createLogEntry({ type: 'system', content: `已经在会话 ${targetId.slice(0, 8)} 中。` }))
        setIsStreaming(false)
        return true
      }

      // 真正的身份切换(Phase 4):会话id = 日志id = pointer id 一致。
      if (ctx.onSessionSwitch) {
        const res = ctx.onSessionSwitch(targetId)
        if (!res.ok) {
          pushStatic(createLogEntry({ type: 'system', content: `切换失败: ${res.error ?? '未知错误'}` }))
        } else {
          pushStatic(createLogEntry({
            type: 'system',
            content: `🔄 已切换到会话 ${targetId.slice(0, 8)}: 载入 ${res.messageCount ?? 0} 条消息(将重建前缀缓存)${res.repaired ? ' · 已修复孤儿工具调用' : ''}。`,
          }))
        }
        setIsStreaming(false)
        return true
      }

      // Fallback:无切换回调时退化为仅内存恢复(身份不切,旧行为)。
      const p = new SessionPersist(targetId, ctx.agent.cwd)
      const preflight = runResumePreflightOai(p.loadOai())
      ctx.session.replaceMessages(preflight.messages)
      ctx.agent.config.promptEngine.resetAppendixBaseline()
      if (preflight.repaired) p.compactOai(preflight.messages)
      pushStatic(createLogEntry({ type: 'system', content: `已恢复会话 ${targetId.slice(0, 8)} (${preflight.messages.length} 条消息, apiSafe=${preflight.safe})` }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/context',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const args = parts.slice(1).join(' ').trim()
      if (args.startsWith('pin ')) {
        const text = args.slice(4).trim()
        if (text) {
          ctx.agent.addAnchor('user_preference', text)
          pushStatic(createLogEntry({ type: 'system', content: `Pinned: "${text}"` }))
        } else {
          pushStatic(createLogEntry({ type: 'system', content: 'Usage: /context pin <text>' }))
        }
        setIsStreaming(false)
        return true
      }

      if (args.startsWith('claims')) {
        const store = ctx.claimStoreRef.current
        if (!store) {
          pushStatic(createLogEntry({ type: 'system', content: 'Claim store not available.' }))
          setIsStreaming(false)
          return true
        }
        const statusArg = args.slice(7).trim()
        const validStatuses = ['active', 'stale', 'conflicted', 'durable']
        if (statusArg && !validStatuses.includes(statusArg)) {
          pushStatic(createLogEntry({ type: 'system', content: `Usage: /context claims [${validStatuses.join('|')}]` }))
          setIsStreaming(false)
          return true
        }
        const output = formatContextClaimsCommand(store, statusArg as ContextClaimStatus | undefined)
        pushStatic(createLogEntry({ type: 'system', content: output }))
        setIsStreaming(false)
        return true
      }

      if (args === 'antibodies') {
        const store = ctx.claimStoreRef.current
        if (!store) {
          pushStatic(createLogEntry({ type: 'system', content: 'Claim store not available.' }))
          setIsStreaming(false)
          return true
        }
        const antibodies = store.listClaims({ kind: ['failure_pattern'], status: ['active', 'durable_candidate', 'durable'] })
        if (antibodies.length === 0) {
          pushStatic(createLogEntry({ type: 'system', content: 'No active antibodies.' }))
          setIsStreaming(false)
          return true
        }
        const lines = antibodies.map(c => {
          const tag = c.tags.filter(t => t !== 'antibody')[0] ?? c.kind
          return `  [${tag}] ${c.text.slice(0, 80)}`
        })
        pushStatic(createLogEntry({ type: 'system', content: `Antibodies (${antibodies.length}):\n${lines.join('\n')}` }))
        setIsStreaming(false)
        return true
      }

      if (args === 'conflicts') {
        const store = ctx.claimStoreRef.current
        if (!store) {
          pushStatic(createLogEntry({ type: 'system', content: 'Claim store not available.' }))
          setIsStreaming(false)
          return true
        }
        const conflicted = store.listClaims({ status: ['conflicted'] })
        if (conflicted.length === 0) {
          pushStatic(createLogEntry({ type: 'system', content: 'No conflicted claims.' }))
          setIsStreaming(false)
          return true
        }
        const lines = conflicted.map(c => `  [${c.id.slice(0, 8)}] ${c.text.slice(0, 80)}`)
        pushStatic(createLogEntry({ type: 'system', content: `Conflicts (${conflicted.length}):\n${lines.join('\n')}` }))
        setIsStreaming(false)
        return true
      }

      if (args === 'reload') {
        const store = ctx.claimStoreRef.current
        if (!store) {
          pushStatic(createLogEntry({ type: 'system', content: 'Claim store not available.' }))
          setIsStreaming(false)
          return true
        }
        // Stale existing project_rule claims so deleted rule files are cleaned up
        const existing = store.listClaims({ kind: ['project_rule'] })
        for (const c of existing) {
          store.updateClaimStatus(c.id, 'stale', 'reload: rules directory refreshed')
        }
        const proposals = loadProjectRules(process.cwd())
        let loaded = 0
        for (const p of proposals) {
          store.propose(p)
          loaded++
        }
        pushStatic(createLogEntry({ type: 'system', content: `Reloaded ${loaded} project rules from .rivet/rules/ (${existing.length} previous rules cleared)` }))
        setIsStreaming(false)
        return true
      }

      if (args === 'export') {
        const store = ctx.claimStoreRef.current
        if (!store) {
          pushStatic(createLogEntry({ type: 'system', content: 'Claim store not available.' }))
          setIsStreaming(false)
          return true
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        const outPath = join(exportsDir(), `${timestamp}.json`)
        const count = exportDurableClaims(store, outPath)
        pushStatic(createLogEntry({ type: 'system', content: `Exported ${count} durable claims to ${outPath}` }))
        setIsStreaming(false)
        return true
      }

      if (args.startsWith('import ')) {
        const store = ctx.claimStoreRef.current
        if (!store) {
          pushStatic(createLogEntry({ type: 'system', content: 'Claim store not available.' }))
          setIsStreaming(false)
          return true
        }
        const filePath = args.slice('import '.length).trim()
        const count = importClaims(store, filePath)
        pushStatic(createLogEntry({ type: 'system', content: count > 0 ? `Imported ${count} claims (confidence ×0.8)` : `No claims imported. Check file path: ${filePath}` }))
        setIsStreaming(false)
        return true
      }

      const ledger = ctx.session.getContextLedger()
      if (!ledger) {
        pushStatic(createLogEntry({ type: 'system', content: 'Context ledger not available yet. Send a message to build the first ledger snapshot.' }))
        setIsStreaming(false)
        return true
      }

      const sections = ledger.tokenBudget
      const diagnostics = ledger.apiInvariantStatus.brokenRounds === 0
        ? 'API rounds: safe'
        : `⚠ ${ledger.apiInvariantStatus.brokenRounds} broken rounds`
      const compacts = ctx.session.getCompactEvents()
      const compactStr = compacts.length === 0
        ? 'No compact events.'
        : compacts.slice(-5).map(e => `- turn ${e.turn}: tier ${e.tier}, ${e.beforeTokens}→${e.afterTokens}`).join('\n')

      const anchorLines = ledger.anchors.length > 0
        ? `\n\nPinned Anchors:\n${ledger.anchors.map(a => `  [${a.kind}] ${a.text.slice(0, 60)}`).join('\n')}`
        : ''

      // 占用明细头：cache 命中率 + 本轮 cost（与 GlanceBar 同源），对齐 Claude Code /context。
      const usagePct = sections.maxTokens > 0 ? Math.round(sections.estimatedTokens / sections.maxTokens * 100) : 0
      const cacheStr = ctx.cacheHitRate !== undefined ? `${Math.round(ctx.cacheHitRate * 100)}%` : 'n/a'
      const costStr = `¥${(ctx.cost ?? 0).toFixed(2)}`
      const realTokens = ctx.session.getLastRealPromptTokens()
      const realStr = realTokens > 0 ? `\nAPI (last): ${realTokens.toLocaleString()} tokens` : ''

      // Recall visibility: compacted history can be pulled back verbatim via
      // read_section. Surface how often that happened this session (observe-only).
      const recall = ctx.agent.getRecallSummary?.()
      const recallStr = recall && recall.totalRecalls > 0
        ? `\nRecall: ${recall.totalRecalls} recalls / ${recall.uniqueArtifacts} archives${recall.avgTurnDistance !== null ? `, avg ${Math.round(recall.avgTurnDistance)} turns back` : ''}`
        : ''

      pushStatic(createLogEntry({
        type: 'system',
        content: `Context: ${sections.compactionState}\nTokens (est): ${sections.estimatedTokens.toLocaleString()}/${sections.maxTokens.toLocaleString()} (${usagePct}%)${realStr}${recallStr}\nCache hit: ${cacheStr}    Cost: ${costStr}\nRounds: ${ledger.rounds.length}\n${diagnostics}\n\nCompaction:\n${compactStr}${anchorLines}`,
      }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/verify',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const verify = formatVerificationStatus(ctx.agent)
      const recovery = renderRecoveryStack(process.cwd())
      pushStatic(createLogEntry({ type: 'system', content: `${verify}\n\n${recovery}` }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/memory',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const subcmd = parts[1]
      const text = parts.slice(2).join(' ').trim()
      if (!subcmd) {
        pushStatic(createLogEntry({ type: 'system', content: formatMemoryOverview(ctx) }))
      } else if (subcmd === 'add') {
        if (!text) {
          pushStatic(createLogEntry({ type: 'system', content: 'Usage: /memory add <content>', isError: true }))
        } else {
          const file = appendProjectKnowledge(text)
          pushStatic(createLogEntry({ type: 'system', content: `Saved to project knowledge: ${file}` }))
        }
      } else if (subcmd === 'search') {
        if (!text) {
          pushStatic(createLogEntry({ type: 'system', content: 'Usage: /memory search <query>', isError: true }))
        } else {
          pushStatic(createLogEntry({ type: 'system', content: searchMemory(ctx, text) }))
        }
      } else if (subcmd === 'forget') {
        pushStatic(createLogEntry({ type: 'system', content: 'Forget is not yet destructive in Wave 1. Use the displayed memory id/file to remove manually for now.' }))
      } else {
        const legacyText = parts.slice(1).join(' ').trim()
        ctx.persist.appendMemory({ text: legacyText, source: 'manual', createdAt: Date.now() })
        ctx.agent.updateSessionMemory(ctx.persist.buildMemoryBlock())
        pushStatic(createLogEntry({ type: 'system', content: 'Saved to session memory.' }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/mcp',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const subcmd = parts[1]?.toLowerCase() ?? 'status'
      const serverId = parts[2]

      if (subcmd === 'auth' && serverId) {
        try {
          const { startMcpOAuth } = await import('../mcp/oauth/connector.js')
          const { findMcpOAuthProvider } = await import('../mcp/oauth/providers.js')
          const { loadConfig } = await import('../config/manager.js')
          const cfg = loadConfig().mcp?.servers[serverId]
          if (!cfg) {
            pushStatic(createLogEntry({ type: 'system', content: `MCP server "${serverId}" not found in config.`, isError: true }))
            setIsStreaming(false)
            return true
          }
          const auth = cfg.auth
          if (!auth || auth.type !== 'oauth') {
            pushStatic(createLogEntry({ type: 'system', content: `Server "${serverId}" does not support OAuth.`, isError: true }))
            setIsStreaming(false)
            return true
          }
          const provider = findMcpOAuthProvider(auth.provider)
          if (!provider) {
            pushStatic(createLogEntry({ type: 'system', content: `Unknown OAuth provider: ${auth.provider}`, isError: true }))
            setIsStreaming(false)
            return true
          }
          const clientId = process.env.RIVET_MCP_OAUTH_CLIENT_ID ?? ''
          if (!clientId) {
            pushStatic(createLogEntry({ type: 'system', content: 'Set RIVET_MCP_OAUTH_CLIENT_ID env var with your OAuth app client ID, then retry.', isError: true }))
            setIsStreaming(false)
            return true
          }
          pushStatic(createLogEntry({ type: 'system', content: `Starting OAuth for ${serverId} (${provider.name})...\nA browser window should open shortly.` }))
          try {
            const scopes = [...provider.defaultScopes, ...(auth.scopes ?? [])]
            await startMcpOAuth(serverId, provider, clientId, scopes)
            pushStatic(createLogEntry({ type: 'system', content: `✓ OAuth connected for ${serverId} (${provider.name})` }))
          } catch (err) {
            pushStatic(createLogEntry({ type: 'system', content: `OAuth failed: ${(err as Error).message}`, isError: true }))
          }
        } catch (err) {
          pushStatic(createLogEntry({ type: 'system', content: `OAuth failed: ${(err as Error).message}`, isError: true }))
        }
        setIsStreaming(false)
        return true
      }

      if (subcmd === 'logs' && serverId) {
        try {
          const mgr = ctx.mcpManagerRef?.current
          if (!mgr) {
            pushStatic(createLogEntry({ type: 'system', content: 'MCP manager not initialized.', isError: true }))
            setIsStreaming(false)
            return true
          }
          const tail = Number.parseInt(parts[3] ?? '100', 10) || 100
          const entries = mgr.getLogs(serverId, tail)
          if (entries.length === 0) {
            pushStatic(createLogEntry({ type: 'system', content: `No log entries for server "${serverId}".` }))
          } else {
            const lines = entries.map((entry) => `[${new Date(entry.ts).toISOString()}] ${entry.stream === 'stderr' ? 'stderr' : 'event'}: ${entry.text.trimEnd()}`)
            pushStatic(createLogEntry({ type: 'system', content: `Logs for ${serverId} (last ${entries.length} entries):\n${lines.join('\n')}` }))
          }
        } catch (err) {
          pushStatic(createLogEntry({ type: 'system', content: `Logs failed: ${(err as Error).message}`, isError: true }))
        }
        setIsStreaming(false)
        return true
      }

      // Default：裸 /mcp（status）出真实状态（与 /debug mcp 同源）；未知子命令打用法
      pushStatic(createLogEntry({
        type: 'system',
        content: subcmd === 'status'
          ? mcpStatusText(ctx.mcpManagerRef?.current)
          : 'Usage:\n  /mcp — show status\n  /mcp auth <serverId> — start OAuth flow\n  /mcp logs <serverId> [tail] — view stderr log buffer',
      }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/todo',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const { getTodos, setTodos } = await import('../tools/todo.js')
      const { TodoStore } = await import('../tools/todo-store.js')
      const subcmd = parts[1]
      const arg = parts.slice(2).join(' ').trim()
      const todos = getTodos()

      if (!subcmd || subcmd === 'list') {
        // List current todos
        const text = todos.length === 0
          ? 'No todos. The agent will create tasks via the todo tool.'
          : TodoStore.formatList(todos)
        pushStatic(createLogEntry({ type: 'system', content: text }))
      } else if (subcmd === 'add') {
        if (!arg) {
          pushStatic(createLogEntry({ type: 'system', content: 'Usage: /todo add <content>', isError: true }))
        } else {
          const id = `user-${Date.now().toString(36)}`
          setTodos([...todos, { id, content: arg, status: 'pending' as const }])
          pushStatic(createLogEntry({ type: 'system', content: `Added: ○ [${id}] ${arg}` }))
        }
      } else if (subcmd === 'done') {
        const item = todos.find(t => t.id === arg || t.id.startsWith(arg))
        if (!item) {
          pushStatic(createLogEntry({ type: 'system', content: `No todo matching "${arg}". Use /todo list to see ids.`, isError: true }))
        } else {
          setTodos(todos.map(t => t.id === item.id ? { ...t, status: 'completed' as const } : t))
          pushStatic(createLogEntry({ type: 'system', content: `✓ Done: ${item.content}` }))
        }
      } else if (subcmd === 'skip') {
        const item = todos.find(t => t.id === arg || t.id.startsWith(arg))
        if (!item) {
          pushStatic(createLogEntry({ type: 'system', content: `No todo matching "${arg}". Use /todo list to see ids.`, isError: true }))
        } else {
          // Remove the item entirely (skip = don't do it)
          setTodos(todos.filter(t => t.id !== item.id))
          pushStatic(createLogEntry({ type: 'system', content: `⊘ Skipped: ${item.content}` }))
        }
      } else if (subcmd === 'move') {
        const id = parts[2]
        const dir = parts[3] // 'up' or 'down'
        if (!id || (dir !== 'up' && dir !== 'down')) {
          pushStatic(createLogEntry({ type: 'system', content: 'Usage: /todo move <id> <up|down>', isError: true }))
        } else {
          const idx = todos.findIndex(t => t.id === id || t.id.startsWith(id))
          if (idx === -1) {
            pushStatic(createLogEntry({ type: 'system', content: `No todo matching "${id}".`, isError: true }))
          } else {
            const swapWith = dir === 'up' ? idx - 1 : idx + 1
            if (swapWith < 0 || swapWith >= todos.length) {
              pushStatic(createLogEntry({ type: 'system', content: 'Already at edge.' }))
            } else {
              const next = [...todos]
              ;[next[idx], next[swapWith]] = [next[swapWith]!, next[idx]!]
              setTodos(next)
              pushStatic(createLogEntry({ type: 'system', content: `Moved ${dir}: ${todos[idx]!.content}` }))
            }
          }
        }
      } else {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /todo [list|add <content>|done <id>|skip <id>|move <id> <up|down>]' }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/mission',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const snapshot = ctx.agent.getCognitiveSnapshot?.()
      const strip = formatMissionStrip(snapshot)
      pushStatic(createLogEntry({ type: 'system', content: strip ? `Mission\n\n${strip}` : 'Mission\n\nNo actionable task contract is active.' }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/plan-template',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const cwd = ctx.agent.cwd ?? process.cwd()
      const sub = parts[1]
      const { loadPlanTemplates, getPlanTemplate, savePlanTemplate, formatTemplateList } = await import('../agent/plan-templates.js')

      if (!sub || sub === 'list') {
        const templates = loadPlanTemplates(cwd)
        pushStatic(createLogEntry({ type: 'system', content: formatTemplateList(templates) }))
      } else if (sub === 'save') {
        const name = parts[2]
        const description = parts.slice(3).join(' ').trim()
        if (!name) {
          pushStatic(createLogEntry({ type: 'system', content: 'Usage: /plan-template save <name> [description]', isError: true }))
        } else {
          // Save current plan (if any) as template
          const { getStoredPlan } = await import('../agent/plan-store.js')
          const currentPlan = getStoredPlan(ctx.currentSessionId)
          if (!currentPlan) {
            pushStatic(createLogEntry({ type: 'system', content: 'No active plan to save. Run /plan first.', isError: true }))
          } else {
            savePlanTemplate(cwd, name, `\`\`\`json\n${currentPlan}\n\`\`\`\n`, description)
            pushStatic(createLogEntry({ type: 'system', content: `✓ Saved template "${name}" to .rivet/plan-templates/${name}.md` }))
          }
        }
      } else {
        // Treat as template name to load
        const tpl = getPlanTemplate(cwd, sub)
        if (!tpl) {
          pushStatic(createLogEntry({ type: 'system', content: `Template "${sub}" not found. Use /plan-template list to see available templates.`, isError: true }))
        } else {
          pushStatic(createLogEntry({
            type: 'system',
            content: `Loaded template: ${tpl.name}\n${tpl.description ? tpl.description + '\n' : ''}${tpl.estimatedWaves ? `Estimated waves: ${tpl.estimatedWaves}\n` : ''}\n${tpl.content}\n\n→ Use /plan to refine, or /team to execute.`,
          }))
        }
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/workflow',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const cwd = ctx.agent.cwd ?? process.cwd()
      const sub = parts[1]
      const { listWorkflows, loadWorkflow, listTraces, loadTrace, formatTrace, parseWorkflow } = await import('../agent/workflow-runner.js')

      if (!sub || sub === 'list') {
        const names = listWorkflows(cwd)
        const text = names.length === 0
          ? 'No workflows. Create one in .rivet/workflows/*.yaml'
          : `Available workflows:\n\n${names.map(n => `  ${n}`).join('\n')}\n\nUse: /workflow <name> to execute.`
        pushStatic(createLogEntry({ type: 'system', content: text }))
      } else if (sub === 'replay') {
        const traceId = parts[2]
        if (!traceId) {
          const traces = listTraces(cwd, 10)
          const text = traces.length === 0
            ? 'No traces available.'
            : `Recent traces:\n\n${traces.map(t => `  ${t.traceId} — ${t.workflowName} (${t.finalStatus})`).join('\n')}\n\nUse: /workflow replay <id> to view.`
          pushStatic(createLogEntry({ type: 'system', content: text }))
        } else {
          const trace = loadTrace(cwd, traceId)
          if (!trace) {
            pushStatic(createLogEntry({ type: 'system', content: `Trace "${traceId}" not found.`, isError: true }))
          } else {
            pushStatic(createLogEntry({ type: 'system', content: formatTrace(trace) }))
          }
        }
      } else {
        // Execute workflow by name
        const wf = loadWorkflow(cwd, sub)
        if (!wf) {
          pushStatic(createLogEntry({ type: 'system', content: `Workflow "${sub}" not found. Use /workflow list to see available workflows.`, isError: true }))
        } else {
          pushStatic(createLogEntry({
            type: 'system',
            content: `▶ Workflow "${wf.name}" loaded (${wf.steps.length} steps).\n${wf.description ?? ''}\n\n→ Type your objective to execute, or /cancel to abort.`,
          }))
        }
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/constellation',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const cwd = ctx.agent.cwd ?? process.cwd()
      const sub = (parts[1] ?? 'view').toLowerCase()
      const now = Date.now()

      if (sub === 'init') {
        const skeleton = surveySkeleton(cwd)
        const c = initConstellation(cwd, { skeleton, sessionId: ctx.currentSessionId }, now)
        pushStatic(createLogEntry({
          type: 'system',
          content: `Constellation initialized for ${c.name}\n\n${formatConstellationView(c, { now })}`,
        }))
        setIsStreaming(false)
        return true
      }

      if (sub === 'shift') {
        const summary = parts.slice(2).join(' ').trim() || 'skeleton re-surveyed'
        const skeleton = surveySkeleton(cwd)
        const c = initConstellation(cwd, { skeleton, sessionId: ctx.currentSessionId, shiftSummary: summary }, now)
        pushStatic(createLogEntry({
          type: 'system',
          content: `Architecture shift recorded (${c.architectureShifts.length} total): ${summary}`,
        }))
        setIsStreaming(false)
        return true
      }

      if (sub === 'update') {
        const summary = parts.slice(2).join(' ').trim()
        if (!summary) {
          pushStatic(createLogEntry({ type: 'system', content: 'Usage: /constellation update <summary> — records a milestone for current changes.' }))
          setIsStreaming(false)
          return true
        }
        const dirty = await collectDirtyFiles(cwd)
        const domain = ctx.agent.getSessionDomain()?.id ?? ''
        const milestone = extractMilestone({
          sessionId: ctx.currentSessionId,
          agentMark: buildAgentMark({ symbol: VOID_SYMBOL, domain }),
          domain,
          chronicleEntries: [{ type: 'milestone', turn: 0, timestamp: now, summary, files: dirty }],
          cycleClose: shortHash(`${ctx.currentSessionId}:${now}`),
          now,
          force: true,
        })
        if (!milestone) {
          pushStatic(createLogEntry({ type: 'system', content: 'Nothing to record.' }))
          setIsStreaming(false)
          return true
        }
        appendMilestone(cwd, milestone, now)
        pushStatic(createLogEntry({ type: 'system', content: `Milestone recorded: ${milestone.summary} (${milestone.filesChanged.length} files)` }))
        setIsStreaming(false)
        return true
      }

      const c = loadConstellation(cwd)
      if (!c) {
        pushStatic(createLogEntry({ type: 'system', content: 'No constellation yet. Use /constellation init to survey this project.' }))
        setIsStreaming(false)
        return true
      }

      if (sub === 'history') {
        pushStatic(createLogEntry({ type: 'system', content: formatConstellationHistory(c, { now }) }))
        setIsStreaming(false)
        return true
      }

      // default: view
      pushStatic(createLogEntry({ type: 'system', content: formatConstellationView(c, { now }) }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/leave',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      // User-triggered departure ritual: seal a mark into the starmap now.
      // First token may be a single-glyph symbol; the rest is the summary.
      const cwd = ctx.agent.cwd ?? process.cwd()
      const now = Date.now()
      const rest = parts.slice(1)
      let symbol = VOID_SYMBOL
      let summaryParts = rest
      if (rest.length > 0 && [...rest[0]!].length <= 2) {
        symbol = rest[0]!
        summaryParts = rest.slice(1)
      }
      const summary = summaryParts.join(' ').trim()
      if (!summary) {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /leave [symbol] <summary> — leave your mark in the starmap as you depart.' }))
        setIsStreaming(false)
        return true
      }
      const domain = ctx.agent.getSessionDomain()?.id ?? ''
      const dirty = await collectDirtyFiles(cwd)
      const milestone = buildDepartureMilestone({
        sessionId: ctx.currentSessionId,
        agentMark: buildAgentMark({ symbol, domain }),
        domain,
        summary,
        filesChanged: dirty,
        now,
      })
      appendMilestone(cwd, milestone, now)
      pushStatic(createLogEntry({
        type: 'system',
        content: `✶ Mark ${milestone.agentMark.symbol} sealed into the starmap.\n${milestone.summary}`,
      }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/undo',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const fh = ctx.agent.getFileHistory()
      if (!fh) {
        pushStatic(createLogEntry({ type: 'system', content: 'Undo not available (no file history).' }))
        setIsStreaming(false)
        return true
      }
      const snapshots = fh.getAllSnapshots()
      if (snapshots.length === 0) {
        pushStatic(createLogEntry({ type: 'system', content: 'No undo history yet.' }))
        setIsStreaming(false)
        return true
      }
      const arg = parts[1]
      if (arg && /^\d+$/.test(arg)) {
        const idx = parseInt(arg, 10) - 1
        if (idx < 0 || idx >= snapshots.length) {
          pushStatic(createLogEntry({ type: 'system', content: `Invalid index. History has ${snapshots.length} entries (1-${snapshots.length}).` }))
          setIsStreaming(false)
          return true
        }
        const target = snapshots[idx]!
        const pinnedPush = pushStatic
        fh.rewind(target.messageId).then(
          restored => pinnedPush(createLogEntry({ type: 'system', content: `Undo complete. Restored files: ${restored.join(', ') || '(none)'}` })),
          err => pinnedPush(createLogEntry({ type: 'system', content: `Undo failed: ${(err as Error).message}` })),
        )
        pushStatic(createLogEntry({ type: 'system', content: `Undoing snapshot #${idx + 1}...` }))
      } else if (arg === 'preview' || arg === 'p') {
        const previewIdx = parts[2] ? parseInt(parts[2], 10) - 1 : snapshots.length - 1
        if (previewIdx < 0 || previewIdx >= snapshots.length) {
          pushStatic(createLogEntry({ type: 'system', content: `Invalid index. History has ${snapshots.length} entries.` }))
          setIsStreaming(false)
          return true
        }
        const target = snapshots[previewIdx]!
        const files = Object.keys(target.trackedFileBackups)
        const detail = files.map(f => `  ${f}`).join('\n')
        pushStatic(createLogEntry({ type: 'system', content: `Undo preview #${previewIdx + 1} [${target.messageId.slice(0, 8)}]:\n${detail || '(no files)'}\n\nUse /undo ${previewIdx + 1} to revert.` }))
      } else {
        const recent = snapshots.slice(-10).reverse()
        const lines = recent.map((s, i) => {
          const n = snapshots.length - i
          const files = Object.keys(s.trackedFileBackups).join(', ')
          return `  ${n}. [${s.messageId.slice(0, 8)}] ${files || '(no files)'}`
        })
        pushStatic(createLogEntry({ type: 'system', content: `Undo history (${snapshots.length} total):\n${lines.join('\n')}\n\nUse /undo <number> to revert, /undo preview <number> to inspect.` }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/team-resume',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cwd = ctx.agent.cwd ?? process.cwd()
      const { listCheckpoints, formatCheckpointList, loadCheckpoint, buildResumeFromCheckpoint } = await import('../agent/wave-checkpoint.js')
      const groupId = parts[1]

      if (!groupId) {
        const checkpoints = listCheckpoints(cwd)
        pushStatic(createLogEntry({ type: 'system', content: formatCheckpointList(checkpoints) }))
        setIsStreaming(false)
        return true
      }
      const cp = loadCheckpoint(cwd, groupId)
      if (!cp) {
        pushStatic(createLogEntry({ type: 'system', content: `No checkpoint found for "${groupId}".`, isError: true }))
        setIsStreaming(false)
        return true
      }
      // A2: real resume — rebuild the remaining tasks into a stored plan and
      // kick the master so it re-dispatches via team_orchestrate.
      const resume = buildResumeFromCheckpoint(cp)
      if (!resume) {
        pushStatic(createLogEntry({
          type: 'system',
          content: `Checkpoint ${cp.groupId} has no remaining tasks (wave ${cp.lastCompletedWave + 1}/${cp.totalWaves} was the last).\n最后一波若有失败，请直接让主控重跑该波或修复遗留，checkpoint 仅保留剩余任务。`,
        }))
        setIsStreaming(false)
        return true
      }
      if (!ctx.submitToAgent) {
        pushStatic(createLogEntry({ type: 'system', content: 'Resume unavailable: agent submission channel missing.', isError: true }))
        setIsStreaming(false)
        return true
      }
      const { storePlan } = await import('../agent/plan-store.js')
      storePlan(resume.planJson)
      pushStatic(createLogEntry({
        type: 'system',
        content: `▶️ Resuming ${cp.groupId}: ${cp.remainingOrders.length} tasks re-planned (objective: ${cp.objective.slice(0, 80)}). Dispatching to master…`,
      }))
      setIsStreaming(false)
      ctx.submitToAgent(resume.prompt)
      return true
    },
  },
  {
    name: '/cockpit',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const subcmd = parts[1] as Panel | 'off' | undefined
      if (subcmd === 'off') {
        ctx.surfacePop?.()
        pushStatic(createLogEntry({ type: 'system', content: 'Cockpit panel collapsed.' }))
      } else if (subcmd && subcmd in PANEL_LABELS) {
        ctx.setCockpitPanel(subcmd as Panel)
        ctx.surfacePush?.('cockpit')
        pushStatic(createLogEntry({ type: 'system', content: `Cockpit: ${PANEL_LABELS[subcmd as Panel]} panel. /cockpit off to collapse.` }))
      } else {
        const wasOpen = ctx.activeOverlay === 'cockpit'
        if (wasOpen) {
          ctx.surfacePop?.()
        } else {
          ctx.setCockpitPanel('summary')
          ctx.surfacePush?.('cockpit')
        }
        pushStatic(createLogEntry({ type: 'system', content: wasOpen ? 'Cockpit panel collapsed.' : `Cockpit: ${PANEL_LABELS['summary']} panel. /cockpit off to collapse.` }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/scroll',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      ctx.surfacePush?.('pager')
      pushStatic(createLogEntry({ type: 'system', content: 'Scrollback pager opened. Press q or Esc to close.' }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/effort',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming, surfacePush } = ctx
      const cmd = parts[0]!.toLowerCase()
      const level = parts[1]?.toLowerCase() as 'off' | 'low' | 'medium' | 'high' | 'max' | 'auto' | undefined
      const valid: Array<'off' | 'low' | 'medium' | 'high' | 'max' | 'auto'> = ['off', 'low', 'medium', 'high', 'max', 'auto']
      if (!level) {
        // 无参数 → 重置面板类型后打开交互式选择面板（上下选、回车确认）。
        // 不重置的话，先开过 /permission 等面板后 choicePanelKind 残留，
        // 选择面板会按旧类型渲染（PR #29 移植）。
        pushStatic(createLogEntry({ type: 'system', content: '也可在 /model 面板用 </> 随模型一起调整推理等级（Enter 可随默认持久化）。' }))
        ctx.setChoicePanelKind?.('effort')
        surfacePush?.('choice-panel')
        setIsStreaming(false)
        return true
      }
      if ((valid as string[]).includes(level)) {
        ctx.setReasoningEffort?.(level)
        pushStatic(createLogEntry({ type: 'system', content: level === 'auto'
          ? 'Reasoning effort: auto (autoReasoning picks per task)'
          : `Reasoning effort set to: ${level}` }))
      } else {
        pushStatic(createLogEntry({ type: 'system', content: `Usage: /effort [off|low|medium|high|max|auto]\n\nSet max for full reasoning on every turn. auto lets autoReasoning pick per-task complexity.` }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/yes',
    immediate: true,
    handler(ctx) {
      // 一键全自动（/permission 的捷径，与 /yolo 同链覆盖版接管运行语义）。
      // 显式输入命令即视为确认。/yes → 全自动；/yes off → 回到自动。均持久化为默认。
      const { parts, agent, pushStatic, setIsStreaming } = ctx
      const arg = parts[1]?.toLowerCase()
      if (arg === 'off') {
        agent.setApprovalMode('auto-safe')
        agent.config.maxTurns = 200
        ctx.setAutoSafe(true)
        ctx.persistApprovalMode?.('auto-safe')
        pushStatic(createLogEntry({ type: 'system', content: '✓ 已退出全自动，切回 自动 — 低/无风险自动，高风险仍确认（已设为默认，重启后仍生效）。' }))
        setIsStreaming(false)
        return true
      }
      agent.setApprovalMode('dangerously-skip-permissions')
      agent.config.maxTurns = 0
      ctx.setAutoSafe(false)
      ctx.persistApprovalMode?.('dangerously-skip-permissions')
      pushStatic(createLogEntry({ type: 'system', content: '✓ 全自动已开启 — 无限轮次，无刹车无打扰（已设为默认，重启后仍生效）。关闭: /yes off · 回滚: /rollback' }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/interview',
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const topic = parts.slice(1).join(' ').trim()
      if (!topic) {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /interview <topic>\nExample: /interview add a notification system' }))
        setIsStreaming(false)
        return true
      }
      return false
    },
  },
  {
    name: '/plan',
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const feature = parts.slice(1).join(' ').trim()
      if (!feature) {
        pushStatic(createLogEntry({ type: 'system', content: `Usage: ${cmd} <feature>\n       /plan close <docs/superpowers/plans/file.md> --tasks <1-7|all> [--preview]\nExample: ${cmd} add Context7 MCP preset` }))
        setIsStreaming(false)
        return true
      }
      return false
    },
  },
  {
    name: '/write-plan',
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const feature = parts.slice(1).join(' ').trim()
      if (!feature) {
        pushStatic(createLogEntry({ type: 'system', content: `Usage: ${cmd} <feature>\n       /plan close <docs/superpowers/plans/file.md> --tasks <1-7|all> [--preview]\nExample: ${cmd} add Context7 MCP preset` }))
        setIsStreaming(false)
        return true
      }
      return false
    },
  },
  {
    name: '/skill',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const sub = parts[1]?.toLowerCase()

      // Single source of truth: the shared skillRegistry (loaded at bootstrap
      // from .rivet/skills only — external .claude dirs are never scanned in
      // place; designated skills are copied in via importFromClaude). No
      // re-scan, no truncation — same Tier-1/Tier-2 model the model uses.
      const sourceTag = (source?: string): string =>
        source === 'global-claude' ? '🌐' : '📁'
      const allSkills = skillRegistry.list()

      // ── Auto-distilled draft review (human-in-loop) ──
      if (sub === 'review' || sub === 'drafts') {
        const drafts = listSkillDrafts(ctx.agent.cwd)
        if (drafts.length === 0) {
          pushStatic(createLogEntry({ type: 'system', content: '没有待审核的 skill 草稿。\n会话结束时,验证通过的可复用流程会自动蒸馏到 .rivet/skills/_drafts/。' }))
        } else {
          const lines = drafts.map(d => `  📝 ${d.name} — ${(d.description || '(no description)').slice(0, 120)}`)
          pushStatic(createLogEntry({ type: 'system', content: `待审核 skill 草稿 (${drafts.length}):\n${lines.join('\n')}\n\n/skill approve <name> 入库  ·  /skill reject <name> 丢弃` }))
        }
        setIsStreaming(false)
        return true
      }

      if (sub === 'approve') {
        const name = parts[2]
        if (!name) {
          pushStatic(createLogEntry({ type: 'system', content: '用法: /skill approve <name>(用 /skill review 查看草稿)' }))
          setIsStreaming(false)
          return true
        }
        const res = approveSkillDraft(ctx.agent.cwd, name)
        if (res.ok && res.skill) {
          // Do NOT hot-load into the live registry: changing the available-skill
          // set mid-session shatters the prefix cache (cost can be tens of times
          // higher). The draft is persisted to disk; it takes effect on next session.
          pushStatic(createLogEntry({ type: 'system', content: `✅ 已入库 skill: ${res.skill.name} → .rivet/skills/\n⚠ 需重开会话才生效:会话内热加载新技能会打碎前缀缓存,成本可达几十倍。` }))
        } else {
          pushStatic(createLogEntry({ type: 'system', content: `❌ 入库失败: ${res.error ?? 'unknown error'}` }))
        }
        setIsStreaming(false)
        return true
      }

      if (sub === 'reject') {
        const name = parts[2]
        if (!name) {
          pushStatic(createLogEntry({ type: 'system', content: '用法: /skill reject <name>(用 /skill review 查看草稿)' }))
          setIsStreaming(false)
          return true
        }
        const ok = rejectSkillDraft(ctx.agent.cwd, name)
        pushStatic(createLogEntry({ type: 'system', content: ok ? `🗑 已丢弃草稿: ${name}` : `草稿 "${name}" 不存在` }))
        setIsStreaming(false)
        return true
      }

      // /skill off <name> — manually release an invoked skill so its instructions
      // are no longer re-injected into the dynamic appendix.
      if (sub === 'off' || sub === 'complete') {
        const name = parts[2]
        if (!name) {
          pushStatic(createLogEntry({ type: 'system', content: `用法: /skill ${sub} <name>\n停止持续注入该技能的完整指令。` }))
          setIsStreaming(false)
          return true
        }
        ctx.agent.markSkillCompleted?.(name)
        pushStatic(createLogEntry({ type: 'system', content: `🛑 已停止技能: ${name}` }))
        setIsStreaming(false)
        return true
      }

      // /skill install <name> [...] — copy from .claude/skills/ into .rivet/skills/
      if (sub === 'install' || sub === 'import') {
        const names = parts.slice(2).filter(Boolean)
        if (names.length === 0) {
          pushStatic(createLogEntry({ type: 'system', content: `用法: /skill ${sub} <name> [name2 ...]\n从 .claude/skills/<name> 复制到 .rivet/skills/<name>。` }))
          setIsStreaming(false)
          return true
        }
        const { copied, skipped, errors } = importSkillsIntoRivet(ctx.agent.cwd, names)
        // Do NOT hot-load into the live registry: changing the available-skill set
        // mid-session shatters the prefix cache (cost can be tens of times higher).
        // Files are copied to disk; they take effect on next session.
        const lines: string[] = []
        if (copied.length > 0) lines.push(`✅ 已安装: ${copied.join(', ')}`)
        if (skipped.length > 0) lines.push(`⏭ 已存在/跳过: ${skipped.join(', ')}`)
        if (errors.length > 0) lines.push(`❌ 失败:\n${errors.map(e => `  • ${e}`).join('\n')}`)
        if (copied.length > 0) {
          lines.push('⚠ 需重开会话才生效:会话内热加载新技能会打碎前缀缓存,成本可达几十倍。')
          const installed = countInstalledSkills(ctx.agent.cwd)
          if (installed >= RECOMMENDED_MAX_SKILLS) {
            lines.push(`⚠ 已安装 ${installed} 个,超过建议上限 ${RECOMMENDED_MAX_SKILLS}。${SKILL_RESTRAINT_NOTICE}`)
          }
        }
        pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') || '无变更。' }))
        setIsStreaming(false)
        return true
      }

      if (!sub || sub === 'list' || sub === 'ls') {
        if (allSkills.length === 0) {
          pushStatic(createLogEntry({ type: 'system', content: 'No skills found (.agents/skills 与 .rivet/skills 均为空)。\n.agents/skills/<name>/SKILL.md 会自动装载（跨 agent 标准目录）；\n或安装：\n  /skill install <name>\n或复制：\n  cp -r ~/.claude/skills/<name> .rivet/skills/<name>\n或在配置里列 skills.importFromClaude。' }))
        } else {
          const lines = [...allSkills]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(s => {
              const size = s.body.length > 1024 ? `${(s.body.length / 1024).toFixed(1)}KB` : `${s.body.length}B`
              const desc = (s.description || '(no description)').replace(/\s+/g, ' ').slice(0, 120)
              return `  ${sourceTag(s.source)} ${s.name} (${size}) — ${desc}`
            })
          const draftCount = listSkillDrafts(ctx.agent.cwd).length
          const draftHint = draftCount > 0 ? `\n📝 ${draftCount} 个自动蒸馏草稿待审核 — /skill review` : ''
          pushStatic(createLogEntry({ type: 'system', content: `Skills (${allSkills.length}):\n${lines.join('\n')}\n\nUse /skill <name> to load a skill's full instructions into the conversation.${draftHint}` }))
        }
        setIsStreaming(false)
        return true
      }

      // /skill <name> — load the FULL body into the conversation and immediately
      // invoke it as the current prompt. The slash handler just acknowledges the
      // load; the actual body is expanded by resolveAppPromptInput so the agent
      // sees the skill instructions as the user message and responds in this turn.
      const skill = skillRegistry.get(parts[1]!) ?? allSkills.find(s => s.name.toLowerCase() === sub)
      if (!skill) {
        pushStatic(createLogEntry({ type: 'system', content: `Skill "${parts[1]}" not found.\nUse /skill list to see available skills.` }))
        setIsStreaming(false)
        return true
      }

      const sizeKb = (skill.body.length / 1024).toFixed(1)
      const taskHint = parts.slice(2).join(' ').trim()
      pushStatic(createLogEntry({ type: 'system', content: `✅ Loaded skill: ${skill.name} (${sizeKb}KB from ${skill.source ?? 'rivet'})\nThe full skill instructions are now in the conversation.${taskHint ? `\nUser task: ${taskHint}` : ''}` }))

      // Remember that this skill was invoked so the prompt engine can re-inject
      // its instructions into the dynamic appendix after context compaction.
      ctx.agent.markSkillInvoked?.(skill.name)

      // Fall through to the agent pipeline. resolveAppPromptInput will expand
      // `/skill <name> [...]` into the skill body so the agent responds now.
      return false
    },
  },
  {
    name: '/sensorium',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const snapshot = ctx.agent.getCognitiveSnapshot?.()
      if (!snapshot) {
        pushStatic(createLogEntry({ type: 'system', content: 'Sensorium not available yet. Send a message first to build cognitive state.' }))
        setIsStreaming(false)
        return true
      }
      const s = snapshot
      const sensoriumLines = [
        '🧠 Sensorium — 天枢 3D 自感知',
        '',
        `  任务状态: ${s.contractStatus ?? 'idle'}`,
        `  目标: ${s.objective ?? '(none)'}`,
        `  涉及文件: ${s.scopeFileCount}`,
        `  可执行任务: ${s.isActionableTask ? 'yes' : 'no'}`,
        `  验证缺口: ${s.hasVerificationGap ? 'WARNING: yes' : 'OK: no'}`,
        `  交付状态: ${s.deliveryStatus}`,
        '',
        '这些信号驱动 Immune 系统、Sycophancy Trap、Doom Loop 防护等自适应行为。',
        '详细诊断: /debug [prompt|fingerprint|cache|context-payload]',
      ]
      pushStatic(createLogEntry({ type: 'system', content: sensoriumLines.join('\n') }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/index',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      // Rebuild codebase index from MeridianDB
      const indexer = ctx.agent.getIndexer?.()
      if (!indexer) {
        pushStatic(createLogEntry({ type: 'system', content: '⚠ MeridianIndexer not available. Index requires better-sqlite3.' }))
        setIsStreaming(false)
        return true
      }
      const db = indexer.getDb()
      const cwd = ctx.agent.cwd ?? process.cwd()

      // Read main.ts and headless.ts for CLI extraction
      let mainTsSource = ''
      let headlessSource: string | null = null
      const mainTsPath = 'src/main.ts'
      const headlessPath = 'src/headless.ts'
      try {
        mainTsSource = readFileSync(join(cwd, mainTsPath), 'utf-8')
      } catch { /* not found */ }
      try {
        headlessSource = readFileSync(join(cwd, headlessPath), 'utf-8')
      } catch { /* not found */ }

      const result = fullRebuild(db, mainTsSource, headlessSource, mainTsPath, headlessPath, cwd)
      const indexBlock = generateCodebaseIndexBlock(db, getHeadSha())

      pushStatic(createLogEntry({ type: 'system', content: `📚 Codebase Index Rebuilt\n\n${result}\n\nIndex will be injected into agent context on next turn.` }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/dream',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      // Show dream status — memory distillation runs automatically at session end
      const dir = knowledgeDir()
      const memPath = join(dir, 'project-memory.md')
      const hasMemory = existsSync(memPath)
      const size = hasMemory ? readFileSync(memPath, 'utf-8').length : 0
      const entries = hasMemory
        ? (readFileSync(memPath, 'utf-8').match(/^### /gm) ?? []).length
        : 0

      pushStatic(createLogEntry({ type: 'system', content:
        `🌙 Dream — 记忆蒸馏\n\n` +
        `  状态: ${hasMemory ? 'active' : 'empty'}\n` +
        `  条目: ${entries} curated memories\n` +
        `  大小: ${(size / 1024).toFixed(1)} KB\n` +
        `  路径: .rivet/knowledge/project-memory.md\n\n` +
        `Dream 在会话结束时自动运行，从决策中提取：\n` +
        `  • convergence_insight — 收敛洞察\n` +
        `  • architectural_invariant — 架构不变量\n` +
        `  • selection_rule — 选择规则\n` +
        `  • conceptual_reframe — 概念重构\n` +
        `  • reusable_design_pattern — 可复用设计模式\n\n` +
        `记忆不注入提示词，通过 recall 工具按需检索。`
      }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/diagram',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const arg = (parts[1] ?? '').toLowerCase()
      if (!arg || arg === 'list') {
        pushStatic(createLogEntry({ type: 'system', content:
          `${formatDiagramList()}\n\n用法：/diagram <type> — 生成骨架并写入 docs/diagrams/<type>.md\n形状语义已内建（{{六边形}}=LLM·[[子程序]]=Agent·[(圆柱)]=存储·{菱形}=决策·(圆角)=输入）。`
        }))
        setIsStreaming(false)
        return true
      }
      if (!isDiagramType(arg)) {
        pushStatic(createLogEntry({ type: 'system', content:
          `未知图型 "${arg}"。\n${formatDiagramList()}`
        }))
        setIsStreaming(false)
        return true
      }
      const cwd = ctx.agent.cwd
      const outDir = join(cwd, 'docs', 'diagrams')
      const outPath = join(outDir, `${arg}.md`)
      let writeNote: string
      try {
        mkdirSync(outDir, { recursive: true })
        writeFileSync(outPath, buildDiagramDoc(arg), 'utf-8')
        writeNote = `已写入 docs/diagrams/${arg}.md — 在 VSCode/GitHub/Obsidian 打开查看渲染。`
      } catch (e) {
        writeNote = `（写入失败：${e instanceof Error ? e.message : String(e)}；骨架见下方，可手动保存）`
      }
      pushStatic(createLogEntry({ type: 'system', content:
        `📐 ${arg} 骨架已生成\n\n${writeNote}\n\n${renderDiagramBlock(arg)}\n\n替换节点文字即可。终端里显示为源码，渲染在外部查看器。`
      }))
      setIsStreaming(false)
      return true
    },
  },
]

export async function handleSlashCommand(ctx: SlashHandlerContext): Promise<boolean> {
  const cmd = ctx.parts[0]!.toLowerCase()
  const command = TUI_SLASH_COMMANDS.find(c => c.name === cmd)
  if (!command) return false
  return await command.handler(ctx)
}

/**
 * /queue <text>：显式排队一条消息到下轮（简单 FIFO lane，不走 steer 的
 * 优先级/意图分类，也不参与 turn 边界 drain）。busy/idle 都可用——busy 时
 * 攒着不打断当前 run，idle 时等价「随下条一起发」。lane 唯一出口是下一次
 * idle 提交的归并（见 app.ts handleInputSubmit 的 steer 收口段）。
 * 独立导出：单测没有完整 BootstrapContext，需要能单独注册这一条命令。
 */
export function registerQueueCommand(app: TuiApp): void {
  app.registerSlashCommand({
    name: '/queue',
    description: 'Queue a message to merge into the next prompt',
    immediate: true,
    handler: ({ trimmed }) => {
      const arg = trimmed.slice('/queue'.length).trim()
      if (!arg) {
        // 无参：预览当前 lane（只看不清）。
        if (app.queueLane.length === 0) {
          app.commitStatic('⏸ 排队队列为空——/queue <text> 把一条消息攒到下轮，回车随下条一并发送')
        } else {
          const preview = app.queueLane
            .map((t, i) => `${i + 1}. ${t.length > 60 ? `${t.slice(0, 60)}…` : t}`)
            .join('\n')
          app.commitStatic(`⏸ 排队队列（${app.queueLane.length} 条）——回车随下条一并发送：\n${preview}`)
        }
        return true
      }
      app.queueLane.push(arg)
      app.commitStatic(`⏸ 已排队到下轮（${app.queueLane.length} 条）——回车随下条一并发送`)
      return true
    },
  })
}

/**
 * /yolo 与 /yes 覆盖版共享 handler——见 yolo-toggle.ts（R25 提取为独立模块，
 * 避免本文件巨石继续膨胀；R24 两份复制是分叉根因）。
 */

export function registerTuiSlashCommands(app: TuiApp, ctx: BootstrapContext): void {
  const autoSafeRef: MutableRefLike<boolean> = { current: true }
  const verboseRef: MutableRefLike<boolean> = { current: false }
  const rollbackTokenRef: MutableRefLike<string | null> = { current: null }
  let cacheHitRate = 0

  const allProviders: Record<string, { models: Array<{ id: string; alias: string }>; userSaved?: boolean }> = {}
  for (const [name, prov] of Object.entries(ctx.config.provider.providers)) {
    allProviders[name] = { models: prov.models.map(m => ({ id: m.id, alias: m.alias ?? m.id, supportsVision: m.supportsVision })), ...(prov.userSaved ? { userSaved: true } : {}) }
  }

  function buildHandlerContext(input: string): SlashHandlerContext {
    const trimmed = input.trim()
    const parts = trimmed.split(/\s+/)
    const metrics = app.getMetrics()
    const maxTokens = metrics?.maxTokens && metrics.maxTokens > 0
      ? metrics.maxTokens
      : (ctx.provider.models[0]?.contextWindow ?? 128000)
    const cost = metrics?.cost ?? 0

    return {
      parts,
      config: ctx.config,
      agent: ctx.agent,
      session: ctx.session,
      persist: ctx.persist,
      model: app.getModelInfo().modelName,
      maxTokens,
      availableModels: ctx.provider.models.map(m => ({ id: m.id, alias: m.alias ?? m.id, supportsVision: m.supportsVision })),
      onModelSwitch: (modelId: string) => {
        try { ctx.agent.abort() } catch {}
        const res = switchAgentRuntime(ctx, modelId)
        if (res.ok && res.modelName) {
          app.setModelInfo(res.modelName, res.contextWindow)
        }
        return { ok: res.ok, error: res.error }
      },
      onSessionSwitch: (targetId: string) => {
        try { ctx.agent.abort() } catch {}
        const res = switchAgentSession(ctx, targetId)
        if (res.ok) {
          app.setStreamingState(false)
          // 切换后恢复目标、todo 列表与 side panel 状态，保持会话连续性。
          try {
            const restoredGoal = restoreGoalTracker(getSessionDir(ctx.cwd), targetId, {
              maxJudgeRuns: ctx.config.agent.goal?.judge?.maxRuns,
            })
            if (restoredGoal) {
              ctx.agent.setGoalTracker(restoredGoal)
              ctx.refs.goalTrackerRef.current = restoredGoal
            } else {
              ctx.refs.goalTrackerRef.current = null
            }
          } catch { /* goal restore best-effort */ }
          try {
            loadTodos(targetId, ctx.cwd)
            setTodoSession(targetId, ctx.cwd)
            setPlanSession(targetId)
          } catch { /* todo/plan restore best-effort */ }
          try {
            const meta = ctx.persist.loadMetadata()
            if (meta?.sidePanelOpen) app.setSidePanelOpen(true)
            else app.setSidePanelOpen(false)
            // 计划模式恢复：目标会话退出时在 planning 且 draft 仍在 → 重进。
            const restoredPlan = restorePlanModeFromMeta(ctx.agent, ctx.cwd, meta)
            if (restoredPlan) {
              app.commitStatic(`🔍 已恢复计划模式（draft: ${restoredPlan}）— /plan-mode 退出或批准计划后执行。`)
            }
          } catch { /* panel/plan restore best-effort */ }
        }
        return res
      },
      openSessionPicker: () => { app.activateOverlay('chronicle') },
      openInitFlow: () => { app.openInitFlow(ctx.agent.cwd) },
      onCwdSwitch: async (target: string) => {
        const res = await switchAgentCwd(ctx, target)
        if (res.ok) {
          // 刷新顶框 cwd + git 分支——新 cwd 可能是不同 git 仓库，必须重读分支
          const newCwd = ctx.agent.cwd
          app.setCwd(newCwd)
          try {
            const { spawnGitSync } = await import('../tools/spawn-git.js')
            const r = spawnGitSync(['-c', 'core.quotePath=false', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: newCwd, encoding: 'utf-8', timeout: 5000 })
            app.setGitBranch(r.status === 0 ? r.stdout.trim() || undefined : undefined)
          } catch {
            app.setGitBranch(undefined)
          }
        }
        return res
      },
      allProviders,
      currentProvider: ctx.provider.name,
      currentSessionId: ctx.sessionId,
      cost,
      cacheHitRate: metrics?.cacheHitRate ?? cacheHitRate,
      autoSafeRef,
      verboseRef,
      setVerbose: (v: boolean) => { verboseRef.current = v },
      setAutoSafe: (v: boolean) => { autoSafeRef.current = v },
      persistApprovalMode: (mode: string) => { try { persistApprovalDefault(mode) } catch { /* best-effort persist */ } },
      rollbackTokenRef,
      setCockpitPanel: () => {},
      pushStatic: (entry) => { app.commitStatic(entry.content, { isError: entry.isError }) },
      setIsStreaming: (v: boolean) => { app.setStreamingState(v) },
      setCacheHitRate: (v: number) => { cacheHitRate = v },
      setSummaryState: () => {},
      mcpManagerRef: { current: ctx.refs.mcpManager },
      claimStoreRef: { current: ctx.claimStore },
      banditState: ctx.refs.banditState ?? undefined,
      onDomainChange: (domainName: string | undefined) => {
        app.setSessionStarDomain(domainName)
      },
      runReview: ctx.refs.coordinator
        ? (() => {
            const reviewDeps = createCoordinatorReviewDeps(ctx.refs.coordinator!, {
              parentTurnId: 'slash-review',
              reviewDepth: 0,
            })
            return (change: ChangeSet, mode: ReviewMode, focus?: string) =>
              routeReviewWorkflow(change, reviewDeps, { mode, focusHint: focus })
          })()
        : undefined,
      submitToAgent: (prompt: string) => { app.submitText(prompt) },
      onHandoffStart: (src: string, dest: string) => { app.pendingHandoffCopy = { src, dest, sinceMs: Date.now() } },
      goalTrackerRef: ctx.refs.goalTrackerRef,
      reviewGateRef: ctx.refs.reviewGateRef,
      surfacePush: (id: string) => { app.activateOverlay(id) },
      askSideQuestion: (question: string) => { app.askSideQuestion(question) },
      openPlanPreview: (opts) => {
        if (opts.draftPath) app.openPlanPreview('', undefined, opts.draftPath)
        else if (opts.slug) app.openPlanPreview(opts.slug)
      },
      setChoicePanelKind: (kind) => { app.choicePanelKind = kind },
      surfacePop: () => { app.deactivateOverlay() },
      setReasoningEffort: (effort) => { ctx.agent.setReasoningEffort(effort) },
      reasoningEffort: ctx.agent.getReasoningEffort() ?? ctx.agent.config.reasoningEffort,
    }
  }

  function getHandler(name: string) {
    return TUI_SLASH_COMMANDS.find(c => c.name === name)?.handler
  }

  function register(name: string, command: Omit<SlashCommand, "name">) {
    app.registerSlashCommand({ name, ...command })
  }

  // Register all switch-case commands using the shared handler context adapter.
  for (const cmd of TUI_SLASH_COMMANDS) {
    app.registerSlashCommand({
      name: cmd.name,
      description: cmd.description,
      immediate: cmd.immediate,
      handler: async ({ app, input, trimmed }) => cmd.handler(buildHandlerContext(trimmed)),
    })
  }

  // TUI-specific overrides that need the app handle or resolve ecosystem workflows.
  register("/clear", {
    description: "Clear screen",
    immediate: true,
    handler: () => {
      // 先退出流式态再清屏重绘，最终帧反映非流式状态；清屏走 app.clearScreen()
      // 单一实现（含 live.reset()+renderLive()，此前手写 stdout 漏了 reset）。
      app.setStreamingState(false)
      app.clearScreen()
      return true
    },
  })

  // GlanceBar 信息密度切换（Wave 2 减密分档）。
  register("/glance", {
    description: "Toggle GlanceBar density (compact/full)",
    immediate: true,
    handler: ({ trimmed }) => {
      const arg = trimmed.split(/\s+/)[1]?.toLowerCase()
      const next = arg === 'full' ? 'full'
        : arg === 'compact' ? 'compact'
        : (app.glanceDensity === 'compact' ? 'full' : 'compact')
      app.glanceDensity = next
      app.forceRedraw()
      app.commitStatic(`GlanceBar density → ${next}${next === 'compact' ? '（模式/模型/上下文%/耗时）' : '（全量指标）'}`)
      return true
    },
  })

  // /queue：显式排队 lane（handler 在 registerQueueCommand，独立导出供单测注册）。
  registerQueueCommand(app)

  // 经 SIGINT 走 main.ts 的统一 shutdown（app.dispose → ctx.shutdown →
  // 退出摘要 + resume 指引 → process.exit）。直接调 ctx.shutdown() 不会退出
  // 进程，也绕过退出摘要。
  register("/exit", {
    description: "Exit Rivet",
    immediate: true,
    handler: () => {
      process.emit('SIGINT')
      return true
    },
  })

  register("/quit", {
    description: "Exit Rivet",
    immediate: true,
    handler: () => {
      process.emit('SIGINT')
      return true
    },
  })

  register("/update", {
    description: "Check and install the latest Rivet release",
    immediate: true,
    handler: async () => {
      if (app.busy) {
        app.commitStatic('⚠️  Cannot update while the agent is running.')
        return true
      }

      const root = detectInstallRoot()
      if (!root) {
        app.commitStatic('⚠️  Cannot detect Rivet install root.')
        return true
      }

      app.commitStatic('Checking for updates...')
      const check = await checkForUpdate(root, { bypassCache: true })
      if (!check) {
        app.commitStatic('⚠️  Could not check for updates right now.')
        return true
      }

      if (!check.hasUpdate) {
        app.commitStatic(`Rivet is up to date (${check.current}).`)
        return true
      }

      app.commitStatic(formatUpdateBanner(check.current, check.latest))
      app.commitStatic(`Install source: ${check.installType}`)

      // Windows 全局安装：进程存活时 npm 无法覆盖被占用的原生模块
      // （better_sqlite3.node）→ "另一个程序正在使用此文件"。改为分离式更新器：
      // 等本进程退出释放文件锁后再装、再拉起。
      if (process.platform === 'win32' && check.installType === 'global') {
        // 用 check.latest（与上方横幅一致）作为安装版本，而非写死的 dist-tag 'latest'。
        const schedule = spawnWindowsSelfUpdate(root, check.latest.replace(/^v/, ''), true, ctx.sessionId)
        if (!schedule.ok) {
          app.commitStatic(`❌ 无法启动后台更新器：${schedule.error ?? 'unknown'}`)
          app.commitStatic(`   请手动执行：npm install -g tianshu-tui@${check.latest.replace(/^v/, '')}`)
          return true
        }
        app.commitStatic('✅ 更新已安排：天枢将退出以释放文件占用，安装完成后会自动重新打开。')
        app.commitStatic('   （若未自动打开，请重新运行 rivet；安装约需数十秒）')
        app.commitStatic('   ⚠️ 若有其他天枢/rivet 会话在运行，请一并退出——否则 npm 覆盖全局包时仍会命中文件占用而失败。')
        app.commitStatic(`   日志：${schedule.logPath}`)
        setTimeout(() => {
          void (async () => {
            await ctx.shutdown()
            app.dispose()
            process.exit(0)
          })()
        }, 400)
        return true
      }

      // 用 check.latest（与上方横幅一致）作为安装版本，而非写死的 dist-tag 'latest'。
      const result = await runUpdate(root, check.latest.replace(/^v/, ''), (line) => app.commitStatic(line))
      if (result.skipped) {
        app.commitStatic(`ℹ️  ${result.message}`)
        return true
      }
      if (!result.ok) {
        app.commitStatic(`❌ ${result.message}`)
        // Windows 源码安装：npm install 重建原生模块（better_sqlite3.node）时
        // 当前进程已加载该文件 → "另一个程序正在使用此文件"。给出定向指引。
        if (process.platform === 'win32') {
          app.commitStatic('   Windows 提示：若因文件被占用（EBUSY/EPERM）失败，请退出所有天枢会话后在安装目录手动执行上述更新命令。')
        }
        return true
      }

      app.commitStatic('✅ Update complete. Restarting...')
      setTimeout(() => {
        void (async () => {
          await ctx.shutdown()
          app.dispose()
          restartProcess(ctx.sessionId)
        })()
      }, 250)
      return true
    },
  })

  register("/starmap", {
    description: "Open starmap overlay",
    immediate: true,
    overlay: "starmap",
    handler: () => true,
  })

  register("/chronicle", {
    description: "Open chronicle overlay",
    immediate: true,
    overlay: "chronicle",
    handler: () => true,
  })

  register("/scroll", {
    description: "Open scrollback pager",
    immediate: true,
    overlay: "pager",
    handler: () => true,
  })

  register("/pager", {
    description: "Open scrollback pager",
    immediate: true,
    overlay: "pager",
    handler: () => true,
  })

  register("/rewind", {
    description: "Open rewind overlay",
    immediate: true,
    overlay: "rewind",
    handler: () => true,
  })

  register("/tasks", {
    description: "Open tasks overlay",
    immediate: true,
    overlay: "tasks",
    handler: () => true,
  })

  register("/jobs", {
    description: "后台任务列表",
    immediate: true,
    overlay: "jobs",
    handler: () => true,
  })

  register("/cache", {
    description: "缓存面板（token 消耗 / 命中率 / 缓存省钱 · DeepSeek 官方账单）",
    immediate: true,
    overlay: "cache",
    handler: () => true,
  })

  register("/enter", {
    description: "Resume a worker session (e.g. /enter wo_team:T1 continue fixing bug)",
    immediate: true,
    handler: ({ app, input, trimmed }) => {
      const result = resolveEnterWorkerInput(app, trimmed)
      if (!result) return false
      if ('error' in result) {
        app.commitStatic(`⚠️  ${result.error}`)
        return true
      }
      app.submitText(result.prompt)
      return true
    },
  })

  register("/palette", {
    description: "Open command palette",
    immediate: true,
    overlay: "command-palette",
    handler: () => true,
  })

  register("/domain", {
    description: "Show or switch star domain",
    immediate: true,
    handler: ({ app, input, trimmed }) => {
      const parts = trimmed.split(/\s+/)
      if (parts.length === 1) {
        app.activateOverlay("domain-picker")
        return true
      }
      const handler = getHandler("/domain")
      return handler ? handler(buildHandlerContext(trimmed)) : false
    },
  })

  register("/model", {
    description: "Show or switch model",
    immediate: true,
    handler: ({ app, input, trimmed }) => {
      const parts = trimmed.split(/\s+/)
      if (parts.length === 1) {
        app.activateOverlay("model-picker")
        return true
      }
      const handler = getHandler("/model")
      return handler ? handler(buildHandlerContext(trimmed)) : false
    },
  })

  register("/connect", {
    description: "连接模型服务商（选内置或自定义，填写 API 密钥）",
    immediate: true,
    handler: ({ app }) => {
      // 配置读写就在这一层做（同 /config 的先例）——把已配置 provider 列表注入
      // 向导，让它能提供「为已有服务商添加模型」分支。
      const cfg = loadConfig()
      const existing = Object.entries(cfg.provider.providers).map(([name, p]) => ({
        name,
        label: isProviderPresetKey(name) ? PROVIDER_PRESETS[name].label : name,
        modelCount: p.models.length,
      }))
      app.startConnect(existing, cfg.provider.default)
      return true
    },
  })

  register("/vision", {
    description: "配置识图桥（发现模型、图片验证后保存；不改变主服务商）",
    immediate: true,
    handler: ({ app }) => {
      app.startVisionOnboarding(async request => {
        const apiKeyEnv = request.body.apiKeyEnv
        if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
          throw new Error('apiKeyEnv must be a valid environment variable name')
        }
        const resolvedEnvKey = apiKeyEnv ? process.env[apiKeyEnv]?.trim() : undefined
        if (apiKeyEnv && !resolvedEnvKey) {
          throw new Error(`Environment variable "${apiKeyEnv}" is not set or is blank in this process`)
        }
        const requestWithResolvedKey = {
          ...request.body,
          ...(resolvedEnvKey ? { apiKey: resolvedEnvKey } : {}),
        }
        if (request.kind === 'discover') {
          return await discoverVisionModels(requestWithResolvedKey)
        }
        await validateVisionModel({
          baseUrl: request.body.baseUrl,
          providerName: request.body.providerName,
          modelId: request.body.modelId,
          ...(requestWithResolvedKey.apiKey ? { apiKey: requestWithResolvedKey.apiKey } : {}),
        })
        registerVisionModelConfig({
          providerName: request.body.providerName,
          baseUrl: request.body.baseUrl,
          ...(request.body.apiKey && !apiKeyEnv ? { apiKey: request.body.apiKey } : {}),
          ...(apiKeyEnv ? { apiKeyEnv } : {}),
          modelId: request.body.modelId,
        })
        return {}
      })
      return true
    },
  })

  register("/disconnect", {
    description: "断开服务商（整组删除该 key 注册的模型列表并清除密钥）",
    immediate: true,
    handler: ({ app }) => {
      const cfg = loadConfig()
      const saved = Object.entries(cfg.provider.providers).filter(([, p]) => p.userSaved)
      if (saved.length === 0) {
        app.commitStatic('尚无已保存的服务商——先用 /connect 接入。')
        return true
      }
      app.choicePanelKind = 'disconnect'
      app.activateOverlay('choice-panel')
      return true
    },
  })

  // /config —— 设置面板。配置读写就在这一层做（同 /mirror 的先例），app.ts 只拿
  // 一个纯状态机和一个落盘闭包，不引 config manager。
  const openSettingsPanel = (): boolean => {
    const flow = new SettingsFlow(loadSettingsDraft(), loadSettingsEnv())
    app.startSettings(flow, request => saveSettings(request, {
      // 审批模式是唯一要同步到「正在跑的会话」的字段：落盘之外还得改 agent
      // 与 badge，否则用户看着面板改了、当前会话仍按旧模式放行。
      onApprovalChange: (mode: string) => {
        try {
          ctx.agent.setApprovalMode(mode as Parameters<typeof ctx.agent.setApprovalMode>[0])
          app.setApprovalMode(mode as Parameters<typeof app.setApprovalMode>[0])
          persistApprovalDefault(mode)
          return true
        } catch {
          return false
        }
      },
    }))
    return true
  }

  register("/config", {
    description: "设置面板（子代理路由 / 审查子代理 / 识图模型 / 基础项）",
    immediate: true,
    handler: openSettingsPanel,
  })
  register("/settings", {
    description: "设置面板（同 /config）",
    immediate: true,
    handler: openSettingsPanel,
  })
  register("/setup", {
    description: "设置面板（同 /config）",
    immediate: true,
    handler: openSettingsPanel,
  })

  register("/theme", {
    description: "Show or switch color theme",
    immediate: true,
    handler: ({ app, input, trimmed }) => {
      const parts = trimmed.split(/\s+/)
      if (parts.length === 1) {
        app.activateOverlay("theme-picker")
        return true
      }
      const handler = getHandler("/theme")
      return handler ? handler(buildHandlerContext(trimmed)) : false
    },
  })

  register("/cockpit", {
    description: "Toggle cockpit panel",
    immediate: true,
    handler: ({ app, input, trimmed }) => {
      const parts = trimmed.split(/\s+/)
      const arg = parts[1]?.toLowerCase() as Panel | "off" | undefined
      if (arg === "off") {
        app.deactivateOverlay()
        app.commitStatic('Cockpit panel collapsed.')
        app.setStreamingState(false)
        return true
      }
      if (arg && (PANELS as string[]).includes(arg)) {
        app.setCockpitPanel(arg as Panel)
        app.activateOverlay("cockpit")
        app.commitStatic(`Cockpit: ${PANEL_LABELS[arg as Panel]} panel. /cockpit off to collapse.`)
        app.setStreamingState(false)
        return true
      }
      const wasOpen = app.activeOverlayId() === "cockpit"
      if (wasOpen) {
        app.deactivateOverlay()
      } else {
        app.setCockpitPanel('summary')
        app.activateOverlay("cockpit")
      }
      app.commitStatic(wasOpen ? 'Cockpit panel collapsed.' : `Cockpit: ${PANEL_LABELS['summary']} panel. /cockpit off to collapse.`)
      app.setStreamingState(false)
      return true
    },
  })

  register("/vim", {
    description: "Toggle vim keybindings",
    immediate: true,
    handler: () => {
      const next = app.toggleVim()
      app.commitStatic(next
        ? 'Vim keybindings: on (Esc → normal mode, i/a → insert)'
        : 'Vim keybindings: off')
      app.setStreamingState(false)
      return true
    },
  })

  register("/permission", {
    description: "权限模式：监督 / 自动 / 全自动",
    immediate: true,
    handler: () => {
      // Delegate to the main permission handler — it reads approvalMode live.
      app.setApprovalMode(ctx.agent.config.approvalMode ?? 'manual')
      app.commitStatic(`当前权限: ${formatPermissionLabel(ctx.agent.config.approvalMode)} (${ctx.agent.config.approvalMode ?? 'manual'}) — /permission supervise|auto|unattended 快速切换 · /yes 一键全自动`)
      app.setStreamingState(false)
      return true
    },
  })

  // /yolo 与 /yes：同语义入口，共享 handleYoloToggle（R25 提取，杜绝复制分叉）。
  // 显式输入即确认；off 退出；均持久化为默认（重启后仍生效）。
  register("/yolo", {
    description: "⚠ yolo 模式（跳过所有权限确认并持久化为默认）。与 /yes 同义；off 退出。高风险动作",
    immediate: true,
    handler: ({ trimmed }) => handleYoloToggle(trimmed, {
      agent: ctx.agent,
      app,
      persistDefault: persistApprovalDefault,
    }, {
      on: '⚠ yolo 已开启 — 无限轮次，无刹车无打扰（已设为默认，重启后仍生效）。关闭: /yolo off · 回滚: /rollback',
      off: '✓ 已退出 yolo，切回 自动 — 低/无风险自动，高风险仍确认（已设为默认，重启后仍生效）。',
    }),
  })

  register("/yes", {
    description: "一键全自动（/yes off 回到自动）— 持久化为默认",
    immediate: true,
    handler: ({ trimmed }) => handleYoloToggle(trimmed, {
      agent: ctx.agent,
      app,
      persistDefault: persistApprovalDefault,
    }, {
      on: '✓ 全自动已开启 — 无限轮次，无刹车无打扰（已设为默认，重启后仍生效）。关闭: /yes off · 回滚: /rollback',
      off: '✓ 已退出全自动，切回 自动 — 低/无风险自动，高风险仍确认（已设为默认，重启后仍生效）。',
    }),
  })

  register("/login", {
    description: "OAuth 登录（codex 等订阅型服务商，浏览器完成授权；无参默认 codex）",
    immediate: true,
    handler: async ({ app, trimmed }) => {
      // /connect 选 codex 后引导用户来此（此前引导的 /login 是幽灵命令——本注册即闭环）。
      const provider = trimmed.split(/\s+/)[1]?.trim() || 'codex'
      app.commitStatic(`正在为 ${provider} 发起 OAuth 登录——浏览器将打开授权页（5 分钟有效）…`)
      // 动态 import：登录链路（auth/*）不进主装配，用到才加载
      const { runOAuthLogin, openInBrowser } = await import('../auth/login-flow.js')
      const res = await runOAuthLogin(provider, (url) => {
        openInBrowser(url)
        app.commitStatic(`若浏览器未自动打开，请手动访问：\n${url}`)
      })
      app.commitStatic(res.ok ? `✅ ${res.message}` : `⚠️ ${res.message}`)
      return true
    },
  })

  // Ecosystem workflow commands: resolve to agent prompt and submit directly.
  // When the resolver has no mapping (e.g. empty /team or /plan), fall back to
  // the shared handler so usage hints are shown instead of being rejected.
  function registerWorkflow(name: string) {
    register(name, {
      handler: ({ app, input, trimmed }) => {
        const resolved = resolveAppPromptInput(trimmed, ctx.cwd)
        if (resolved !== null) {
          app.submitText(resolved.prompt)
          return true
        }
        const fallback = getHandler(name)
        return fallback ? fallback(buildHandlerContext(trimmed)) : false
      },
    })
  }
  registerWorkflow("/team")
  registerWorkflow("/council")
  registerWorkflow("/scout")
  registerWorkflow("/galaxy")
  registerWorkflow("/starflow")
  registerWorkflow("/plan")
  registerWorkflow("/write-plan")
  registerWorkflow("/plan-close")

  // ── Plugin management ────────────────────────────────────────────

  register("/plugin", {
    description: "Manage plugins — list, install, remove, enable, disable, info",
    immediate: true,
    handler: ({ app, trimmed }) => {
      const parts = trimmed.split(/\s+/)
      const sub = parts[1]?.toLowerCase()
      const arg = parts[2]

      if (!sub || sub === 'list') {
        const plugins = getInstalledPlugins()
        const cfg = loadConfig()
        if (plugins.length === 0) {
          app.commitStatic('No plugins installed. Use /plugin install <path> to add one.')
          return true
        }
        const lines = ['Installed plugins:']
        for (const p of plugins) {
          const enabled = cfg.plugins.enabled[p.name] !== false ? 'enabled' : 'disabled'
          lines.push(`  ${p.name} (${p.version}) — ${enabled} — ${p.description}`)
        }
        lines.push('')
        lines.push('Use /plugin info <name> for details.')
        app.commitStatic(lines.join('\n'))
        return true
      }

      if (sub === 'info') {
        if (!arg) { app.commitStatic('Usage: /plugin info <name>'); return true }
        const plugins = getInstalledPlugins()
        const p = plugins.find(x => x.name === arg)
        if (!p) { app.commitStatic(`Plugin "${arg}" not installed.`); return true }
        const lines = [
          `Plugin: ${p.name}`,
          `Version: ${p.version}`,
          `Description: ${p.description}`,
          `Entry: ${p.entry}`,
          `Tools: ${p.tools}`,
          `Path: ${p.installPath}`,
        ]
        app.commitStatic(lines.join('\n'))
        return true
      }

      if (sub === 'install') {
        if (!arg) {
          app.commitStatic('Usage: /plugin install <local-path> [--confirm]')
          app.commitStatic('Install a plugin from a local directory.\n')
          return true
        }
        // 安装前预检（与桌面端 plugin-api 同语义）：先读 manifest 展示工具与
        // 权限声明，用户复核后加 --confirm 才真正落盘——权限展示不再发生在
        // 安装完成之后。
        const confirmFlag = arg.endsWith(' --confirm')
        const srcPath = confirmFlag ? arg.slice(0, -' --confirm'.length).trim() : arg
        if (!confirmFlag) {
          try {
            const pkgJsonPath = resolve(srcPath, 'package.json')
            const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as { tianshu?: unknown }
            const parsed = parseManifest(pkg.tianshu)
            if (parsed.ok) {
              const m = parsed.manifest
              const perms = m.permissions
              const permStr = Object.entries(perms).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'
              app.commitStatic(
                `Plugin preflight — review before install:\n` +
                `  Name: ${m.name} v${m.version}\n` +
                `  Tools: ${m.tools.map(t => t.name).join(', ') || 'none'}\n` +
                `  Declared permissions: ${permStr}\n` +
                `  Source: ${resolve(srcPath)}\n` +
                `插件代码在下次会话启动时以完整权限加载（声明权限为提示性）。\n` +
                `确认安装请执行: /plugin install ${srcPath} --confirm`
              )
            } else {
              app.commitStatic(`✗ Manifest invalid: ${parsed.errors.join('; ')}`, { isError: true })
            }
          } catch (err) {
            app.commitStatic(`✗ Preflight failed: ${(err as Error).message}`, { isError: true })
          }
          return true
        }
        app.commitStatic(`Installing plugin from ${srcPath}...`)
        installPlugin({ kind: 'local', path: srcPath }).then((result) => {
          if (result.ok) {
            const perms = result.manifest.permissions
            const permStr = Object.entries(perms).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'
            app.commitStatic(
              `✓ Installed "${result.manifest.name}" v${result.manifest.version}\n` +
              `  Tools: ${result.manifest.tools.map(t => t.name).join(', ')}\n` +
              `  Permissions: ${permStr}\n` +
              `  This plugin will be available on next session start.`
            )
          } else {
            app.commitStatic(`✗ Install failed: ${result.error}`, { isError: true })
          }
        }).catch((err) => {
          app.commitStatic(`✗ Install error: ${(err as Error).message}`, { isError: true })
        })
        return true
      }

      if (sub === 'remove') {
        if (!arg) { app.commitStatic('Usage: /plugin remove <name>'); return true }
        const result = removePlugin(arg)
        if (result.ok) {
          app.commitStatic(`✓ Removed plugin "${arg}".`)
        } else {
          app.commitStatic(`✗ ${result.error}`, { isError: true })
        }
        return true
      }

      if (sub === 'enable' || sub === 'disable') {
        if (!arg) { app.commitStatic(`Usage: /plugin ${sub} <name>`); return true }
        if (!isPluginInstalled(arg)) {
          app.commitStatic(`✗ Plugin "${arg}" is not installed.`, { isError: true })
          return true
        }
        const cfg = loadConfig()
        cfg.plugins.enabled[arg] = sub === 'enable'
        saveConfig(cfg)
        app.commitStatic(
          `✓ Plugin "${arg}" ${sub === 'enable' ? 'enabled' : 'disabled'}. ` +
          `Changes take effect on next session start.`
        )
        return true
      }

      app.commitStatic(
        'Usage: /plugin [list|install <path>|remove <name>|enable <name>|disable <name>|info <name>]'
      )
      return true
    },
  })
}

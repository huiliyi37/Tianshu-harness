/**
 * starflow 星流编排器 —— council → team → galaxy 三段代码级状态机。
 *
 * 此前的 /starflow 是纯 prompt 注入：五阶段协议写进 user message 靠模型自觉遵守，
 * 阶段守卫只有文字没有代码兜底。本模块把中间三段做成硬门禁状态机——模型负责想
 * （需求澄清 + 交付叙述），机器负责管阶段流转：
 *   council 评审（产出密封契约 planJson）→ team 波次（契约执行）→ galaxy 攻坚（维度并行）
 * 任一阶段门禁不过即 phase=blocked 停止并给出人话解释；每阶段完成后状态落盘
 * `.rivet/starflow/<sha1(objective)前12位>.json`，resume:true 时已过阶段不重复执行。
 *
 * 三个子工具（council_convene / team_orchestrate / galaxy）只消费不修改——
 * 门禁判据双通道：优先读 ToolResult.orchestration 结构化 outcome（D4），
 * 缺席（假工具/未迁移产出）回退各 formatter 的稳定文本行判据。
 *
 * 交付门禁（阶段 4）不在此实现——deliver_task 已有自己的硬门禁（证据义务 +
 * DP 冗余），星流只在最终报告里输出交付检查清单并提示调用。
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { buildPrewarmValue, type PrewarmValue } from './prewarm-file.js'
import { deserializeUnifiedPlan } from './unified-plan.js'
import { constraintsFromUnifiedPlan } from './plan-constraints.js'
import type { PlanWithObligations } from './council/council-obligations.js'
import type { TeamWorkerRow } from './orchestration-outcome.js'
import { probeEnvFacts, formatEnvPrecheckBlock, formatEnvFooter } from './env-precheck.js'
import type { Tool, ToolCallParams, ToolResult } from '../tools/types.js'

// ── 类型 ─────────────────────────────────────────────────────────────────

/** 状态机阶段。phase 记录「下一个要执行的阶段」；done 是唯一终态——
 *  受阻时 phase 停留在受阻阶段（配合 blockedReason，resume 从该阶段重跑）。 */
export type StarflowPhase = 'council' | 'team' | 'galaxy' | 'deliver' | 'done'

export interface StarflowPhaseRecord {
  status: 'passed' | 'blocked' | 'skipped'
  /** 阶段摘要（工具输出的首行/关键行截断）。 */
  summary: string
  at: number
  /** Wall-clock duration of the phase, when it reached a checkpoint. */
  elapsedMs?: number
  /** Full phase output in the session artifact store, when available. */
  rawArtifactId?: string
  /** Fallback raw report path when no artifact store was injected. */
  rawPath?: string
}

export interface StarflowState {
  objective: string
  /** Stable logical run identity carried across a cross-session resume. */
  runId: string
  /** Monotonic checkpoint revision; used to make state inspection auditable. */
  revision: number
  /** Session namespace used for new writes; resume can still discover older sessions. */
  sessionId?: string
  /** 下一个要执行的阶段；blocked 时停留在受阻阶段（resume 从该阶段重跑）。 */
  phase: StarflowPhase
  phases: Partial<Record<'council' | 'team' | 'galaxy' | 'deliver', StarflowPhaseRecord>>
  /** council 产出的密封契约——resume 续跑 team 阶段的必需品（会话 plan-store
   *  桥在跨 session resume 时不可靠，契约必须随状态落盘）。 */
  planJson?: string
  /** team 阶段已消耗的复议次数（回 council 复议上限 1 次，跨 resume 记账）。 */
  teamRetries: number
  /** M1：team 阶段已通过的最大波号——blocked/resume 时从此续跑，不重跑
   *  已完成波次（工作树改动与契约已落地）。 */
  completedTeamWaves?: number
  /** 波次战报（接口层，2026-08-18）：每波逐 worker 终态行，按 task 去重（同任务
   *  后波覆盖前波——战报展示当前真相，历史在 phase artifact 里）。落盘随状态走，
   *  resume/blocked 后编排器直接从最终报告读到每块状态，不再翻 state/artifact 取证。 */
  teamBlocks?: Array<TeamWorkerRow & { wave: number }>
  blockedReason?: string
  updatedAt: number
}

/** 与 galaxy 工具 dimensionSchema 对齐的宽松结构——值原样透传，由 galaxy 复验。 */
export interface StarflowGalaxyDimension {
  name: string
  objective: string
  authority?: string
  authorities?: string[]
  /** 维度级约束（计划反目标/待验证假设等）。D8：council 契约 planJson 的
   *  nonGoals/obligations 由编排器合并进每个维度。 */
  constraints?: string[]
  parallelism?: 'expert' | 'data'
  replicas?: number
  profile?: string
  tierFloor?: 'cheap' | 'balanced' | 'strong'
  files?: string[]
  symbols?: string[]
  maxTurns?: number
  timeoutMs?: number
  modelOverride?: { provider: string; model: string }
}

export interface StarflowDraftItem {
  id: string
  title: string
  detail: string
  files?: string[]
  /** 修订记账（调用方自管）：修订重提时 bump；未变条目保持原值。 */
  revision?: number
  /** 增量评审标记：上一轮评审已通过且本轮未变。starflow 据此在 councilInput
   *  渲染中标注「沿用前轮通过结论」，council 无需改 schema——渲染文案即契约。 */
  previousVerdict?: 'passed'
}

/** 与 council-convene 的 seatSchema 同构——席位覆盖透传，由 council 复验。 */
export interface StarflowSeat {
  authority: string
  charter?: string
  tierHint?: 'cheap' | 'balanced' | 'strong'
  noDowngrade?: boolean
  provider?: string
  model?: string
}

export interface StarflowInput {
  objective: string
  /** 阶段 0 澄清产出的计划草稿——喂给 council 评审，也是 galaxyDims 缺省时
   *  维度派生的来源。 */
  draftItems?: StarflowDraftItem[]
  /** 显式 galaxy 维度（2-5 个）。缺省时从 draftItems 派生，派生不出则跳过
   *  galaxy 阶段。 */
  galaxyDims?: StarflowGalaxyDimension[]
  /** council 辩论轮数（1-2，默认 1）。 */
  rounds?: 1 | 2
  /** 席位覆盖（与 council_convene 的 seats 同构）——透传到首轮与复议轮。
   *  修订轮推荐只召回「上轮否决的席位 + 与修订点相关的域席」，而非默认全量。 */
  seats?: StarflowSeat[]
  /** 从 `.rivet/starflow/` 状态文件续跑——已过门禁的阶段不重复执行。 */
  /** Optional Galaxy post-review wave; defaults to enabled. */
  autoReview?: boolean
  resume?: boolean
}

export interface StarflowDeps {
  councilTool: Tool
  teamTool: Tool
  galaxyTool: Tool
  cwd: string
  /** 子工具调用参数的载体——sessionId / onOutput / onWorkerActivity /
   *  abortSignal 等原样透传，toolUseId 按阶段加后缀保持活动树归属。 */
  params: ToolCallParams
}

export interface StarflowRun {
  state: StarflowState
  /** True when this invocation resumed a persisted run. */
  resumed?: boolean
  /** 阶段报告（每阶段：状态/摘要/门禁判定；blocked 时给出停在哪、为什么、下一步）。 */
  report: string
}

// ── 常量与文本判据 ────────────────────────────────────────────────────────

const GLYPH = '🌠'
/** team 波次上限护栏——防假工具/异常输出让续波循环失控（真实计划波次 << 10）。 */
const MAX_TEAM_WAVES = 10
/** 摘要截断长度。 */
const SUMMARY_CAP = 160
/** Starflow phase heartbeat cadence. Kept below the TUI stale-info threshold so
 * long council/team/galaxy calls remain visibly active even while the provider
 * is waiting for its first byte. */
let STARFLOW_HEARTBEAT_MS = 10_000

/** Test-only: shrink the phase heartbeat cadence without waiting in real time. */
export function __setStarflowHeartbeatMs(ms: number): void {
  STARFLOW_HEARTBEAT_MS = Math.max(1, Math.trunc(ms))
}

/** council 否决标志（council-convene.ts 编译门文案）：blocking challenge 未化解。 */
const COUNCIL_VETO_RE = /^## ⛔ 议事会否决/m
/** council 产出密封契约的嵌入块（council-convene.ts parts.push 格式）。 */
const COUNCIL_PLAN_JSON_RE = /```council-plan-json\n([\s\S]*?)\n```/
/** team 续波提示（team-orchestrate.ts formatTeamSummary 文案）。 */
const TEAM_NEXT_WAVE_RE = /再次调用 team_orchestrate 并传 fromWave: (\d+)/
/** team 整波失败提示（formatTeamSummary 文案）。 */
const TEAM_ALL_FAILED_RE = /全部 \d+ 个 worker 失败/
/** team 波间硬门禁失败提示（plan-executor.ts waveGateNote 文案）。 */
const TEAM_WAVE_GATE_RE = /下一波派发将被硬拦/
/** team review gate 驳回（plan-executor.ts reviewNote 文案）。 */
const TEAM_REVIEW_REJECTED_RE = /Review gate \[[^\]]*\]: rejected/
/** team 派发计数行（formatTeamSummary 首行）。 */
const TEAM_DISPATCHED_RE = /^team \w+：派发 (\d+)/m
/** galaxy 聚合结论（galaxy.ts formatGalaxyResult 文案）。 */
const GALAXY_ALL_PASSED = '聚合结论: 所有维度通过'
const GALAXY_FAILED_RE = /聚合结论: (\d+)\/(\d+) 个维度未通过/
/** galaxy 单维度报告行：`  <label>: <glyph> …`，glyph 非 ✓ 即未通过。 */
const GALAXY_DIM_LINE_RE = /^ {2}([^\n:]+): ([✗⊗↑])/gm

function firstLine(text: string, cap = SUMMARY_CAP): string {
  const line = text.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? ''
  return line.length > cap ? `${line.slice(0, cap)}…` : line
}

// ── 状态持久化 ────────────────────────────────────────────────────────────

function starflowDir(cwd: string): string {
  return join(cwd, '.rivet', 'starflow')
}

export function starflowStatePath(cwd: string, objective: string, sessionId?: string): string {
  const hash = createHash('sha1')
    .update(objective)
    .update('\0')
    .update(sessionId ?? '')
    .digest('hex')
    .slice(0, 12)
  return join(starflowDir(cwd), `${hash}.json`)
}

const STARFLOW_LEASE_TTL_MS = 60_000

function starflowRunId(objective: string, sessionId?: string, toolUseId?: string): string {
  return createHash('sha1')
    .update('starflow-run\0')
    .update(objective)
    .update('\0')
    .update(sessionId ?? '')
    .update('\0')
    .update(toolUseId ?? '')
    .digest('hex')
    .slice(0, 16)
}

function starflowLeasePath(cwd: string, objective: string): string {
  const hash = createHash('sha1').update('starflow-lease\0').update(objective).digest('hex').slice(0, 16)
  return join(starflowDir(cwd), `${hash}.lease`)
}

interface StarflowLease {
  release: () => void
}

function leaseOwnerIsAlive(path: string, now: number): boolean {
  try {
    const ageMs = now - statSync(path).mtimeMs
    if (ageMs > STARFLOW_LEASE_TTL_MS) return false
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { pid?: number }
    if (!Number.isInteger(raw.pid) || raw.pid! <= 0) return false
    if (!isProcessAlive(raw.pid!)) return false
    return true
  } catch {
    // A competing process can be between open(O_EXCL) and its small owner
    // payload write. Treat a fresh, unreadable lease as occupied; only an old
    // or missing file is eligible for stale cleanup.
    try { return now - statSync(path).mtimeMs <= STARFLOW_LEASE_TTL_MS } catch { return false }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Acquire one logical lease per objective, independent of session namespace. */
function acquireStarflowLease(cwd: string, objective: string, runId: string): StarflowLease | undefined {
  const path = starflowLeasePath(cwd, objective)
  mkdirSync(starflowDir(cwd), { recursive: true })
  const owner = JSON.stringify({ pid: process.pid, runId, acquiredAt: Date.now() })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx')
      try { writeFileSync(fd, owner, 'utf8') } finally { closeSync(fd) }
      const refresh = setInterval(() => {
        try { utimesSync(path, new Date(), new Date()) } catch { /* owner already released */ }
      }, Math.floor(STARFLOW_LEASE_TTL_MS / 3))
      refresh.unref?.()
      return {
        release: () => {
          clearInterval(refresh)
          try {
            const current = JSON.parse(readFileSync(path, 'utf8')) as { runId?: string }
            if (current.runId === runId) unlinkSync(path)
          } catch { /* stale cleanup is best-effort */ }
        },
      }
    } catch {
      if (leaseOwnerIsAlive(path, Date.now())) return undefined
      try { unlinkSync(path) } catch { /* another owner may have won the race */ }
    }
  }
  return undefined
}

function freshState(objective: string, now: number, sessionId?: string, toolUseId?: string): StarflowState {
  return {
    objective,
    runId: starflowRunId(objective, sessionId, toolUseId),
    revision: 0,
    ...(sessionId ? { sessionId } : {}),
    phase: 'council',
    phases: {},
    teamRetries: 0,
    updatedAt: now,
  }
}

function readStateFile(path: string, objective: string): StarflowState | undefined {
  try {
    if (!existsSync(path)) return undefined
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as StarflowState
    if (parsed.objective !== objective || typeof parsed.phase !== 'string') return undefined
    return {
      ...parsed,
      runId: typeof parsed.runId === 'string' && parsed.runId.length > 0
        ? parsed.runId
        : starflowRunId(objective, parsed.sessionId),
      revision: Number.isSafeInteger(parsed.revision) && parsed.revision! >= 0 ? parsed.revision! : 0,
    }
  } catch {
    return undefined
  }
}

/**
 * Resume first prefers this session's namespace, then discovers the newest
 * matching state from another session. This prevents concurrent sessions from
 * overwriting one another while preserving handoff/resume across sessions.
 */
function loadState(cwd: string, objective: string, sessionId?: string): StarflowState | undefined {
  const preferred = readStateFile(starflowStatePath(cwd, objective, sessionId), objective)
  if (preferred) return preferred

  const candidates: StarflowState[] = []
  try {
    for (const entry of readdirSync(starflowDir(cwd))) {
      if (!entry.endsWith('.json')) continue
      const state = readStateFile(join(starflowDir(cwd), entry), objective)
      if (state) candidates.push(state)
    }
  } catch {
    return undefined
  }
  const newest = candidates.sort((a, b) => b.updatedAt - a.updatedAt)[0]
  return newest
}

/** State writes use the shared temp+rename primitive so a killed session cannot
 * leave half a JSON document that silently resets a later resume. */
function saveState(cwd: string, state: StarflowState): boolean {
  try {
    mkdirSync(starflowDir(cwd), { recursive: true })
    const nextState: StarflowState = {
      ...state,
      revision: state.revision + 1,
      updatedAt: Math.max(state.updatedAt, Date.now()),
    }
    writeFileAtomicSync(starflowStatePath(cwd, state.objective, state.sessionId), JSON.stringify(nextState, null, 2))
    state.revision = nextState.revision
    state.updatedAt = nextState.updatedAt
    return true
  } catch {
    return false
  }
}

async function persistPhaseOutput(
  deps: StarflowDeps,
  state: StarflowState,
  phase: 'council' | 'team' | 'galaxy' | 'deliver',
  content: string,
): Promise<Pick<StarflowPhaseRecord, 'rawArtifactId' | 'rawPath'>> {
  if (!content.trim()) return {}
  try {
    const artifactId = deps.params.artifactStore
      ? await deps.params.artifactStore.save({
          tool: 'starflow',
          target: `${state.objective}:${phase}`,
          rawContent: content,
          summary: firstLine(content),
          sections: [],
        })
      : undefined
    if (artifactId) return { rawArtifactId: artifactId }
  } catch {
    // Fall through to the project-local raw report so a store failure never
    // turns into information loss.
  }

  try {
    const rawPath = `${starflowStatePath(deps.cwd, state.objective, state.sessionId)}.${phase}.raw`
    writeFileAtomicSync(rawPath, content)
    return { rawPath }
  } catch {
    return {}
  }
}

// ── galaxy 维度派生 ───────────────────────────────────────────────────────

/** draftItem → authority 映射：审查/验证类 → 瑶光，文档/调研类 → 天璇，其余 → 天梁。 */
function authorityForDraftItem(item: StarflowDraftItem): string {
  const probe = `${item.id} ${item.title}`.toLowerCase()
  if (/(review|verify)/.test(probe)) return 'yaoguang'
  if (/(docs|research)/.test(probe)) return 'tianxuan'
  return 'tianliang'
}

/** galaxyDims 缺省时的派生：按 draftItem 的 id/title 分类定 authority（kind 映射），
 *  files 作维度 scope，detail 作维度 objective。galaxy schema 要求 2-5 个维度——
 *  超出 5 个截断（报告注明），不足 2 个由调用方跳过 galaxy 阶段。 */
export function deriveGalaxyDims(items: StarflowDraftItem[] | undefined): StarflowGalaxyDimension[] {
  const seen = new Set<string>()
  const dims: StarflowGalaxyDimension[] = []
  for (const item of items ?? []) {
    const name = item.id.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    dims.push({
      name,
      objective: item.detail,
      authority: authorityForDraftItem(item),
      ...(item.files && item.files.length > 0 ? { files: item.files } : {}),
    })
  }
  return dims.slice(0, 5)
}

/** M3：预取事实摘要块——`<path>：首行/前 200 字符`，总量 ≤1500 字符。
 *  注入派生 galaxy 维度的 objective 前部，让 worker 省掉首轮文件探索。 */
const PREWARM_FACT_CAP = 1500
const PREWARM_LINE_CAP = 200

export function buildPrewarmFactBlock(values: PrewarmValue[]): string | undefined {
  const lines: string[] = ['── 目标文件预取摘要（评审期间已读取，供直接引用）──']
  let budget = PREWARM_FACT_CAP
  for (const v of values) {
    if (budget <= 0) { lines.push('…（摘要截断）'); break }
    const head = (v.uiContent ?? v.content ?? '').split('\n').map(l => l.trim()).find(l => l.length > 0) ?? ''
    const snippet = head.length > PREWARM_LINE_CAP ? `${head.slice(0, PREWARM_LINE_CAP)}…` : head
    if (!snippet) continue
    const line = `  ${v.canonicalPath}：${snippet}`
    if (line.length > budget) { lines.push('…（摘要截断）'); break }
    lines.push(line)
    budget -= line.length
  }
  if (lines.length <= 1) return undefined
  return lines.join('\n')
}

// ── council 输入增强（复盘 A-D：基线预检 C + 增量评审 B） ─────────────────

/** C: 基线预检块——git status 命中 draftItems 目标文件的行 + 目标文件最近 5 条
 *  提交 + 一句必答要求。注入 councilInput.objective 尾部，把第 2-3 轮才会暴露的
 *  「已在工作树/已合入」类否决提前到第 1 轮。非 git 目录/超时返回 ''（降级为空块，
 *  不阻塞点火）；块截断 ~2KB（路径多时防撑爆上下文）。 */
function baselinePrecheckBlock(cwd: string, files: string[]): string {
  if (files.length === 0) return ''
  const run = (args: string[]): string | null => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    } catch {
      return null // 非 git 目录 / 超时
    }
  }
  const status = run(['-c', 'core.quotePath=false', 'status', '--short']) // quotePath=false：中文/非 ASCII 路径不转八进制，否则目标文件匹配漏报
  if (status === null) return '' // 非 git 目录：降级空块，不阻塞点火
  const statusLines = status.length > 0 ? status.split('\n').filter(l => l.trim().length > 0) : []
  const hits = statusLines.filter(l => {
    // 剥状态码前缀（` M ` / `?? ` 等）与引号（路径含空格时 git 加引号）。
    const p = l.slice(3).trim().replace(/^"|"$/g, '')
    return files.some(f => p === f || p.startsWith(`${f}/`))
  })
  const log = run(['log', '--oneline', '-5', '--', ...files])
  const logLines = (log ?? '').split('\n').filter(l => l.trim().length > 0).slice(0, 5)
  const lines: string[] = ['', '── 基线预检（工作树/提交现状，评审前必核）──']
  if (hits.length > 0) {
    lines.push('工作树命中草稿目标文件：')
    for (const h of hits.slice(0, 20)) lines.push(`  ${h}`)
  } else {
    lines.push('工作树无草稿目标文件的改动。')
  }
  if (logLines.length > 0) {
    lines.push('目标文件最近提交：')
    for (const l of logLines) lines.push(`  ${l}`)
  }
  lines.push('第一轮评审必须先核对草稿断言与上述工作树/提交现状的差异。')
  const block = lines.join('\n')
  return block.length > 2048 ? `${block.slice(0, 2048)}\n…（预检块截断）` : block
}

/** B: 增量评审说明——previousVerdict=passed 且 revision 未 bump 的条目（修订
 *  重提时未变）渲染「沿用前轮通过结论」。渲染层标注（追加进 objective 尾部，
 *  席位可见），不删条目——席位仍看到全图但知道评审焦点；council 侧无需改
 *  schema，渲染文案即契约。
 *  守卫（2026-08-03 审查，fail-dangerous 修正）：revision 与 previousVerdict
 *  同现的条目视为已修订——不沿用、重新评审。无状态实现无法区分「bump 后
 *  忘清 previousVerdict」与「未变」，存在即按修订处理（宁可重审不放过）。 */
function incrementalReviewNote(items: StarflowDraftItem[]): string {
  const carried = items.filter(i => i.previousVerdict === 'passed' && i.revision === undefined)
  if (carried.length === 0) return ''
  return [
    '',
    '── 增量评审说明 ──',
    `以下条目已在前轮评审通过且本轮未变（previousVerdict=passed）：${carried.map(i => i.id).join('、')}。`,
    '沿用前轮通过结论，除非与其他条目冲突否则不重审；其余条目为重点评审对象。',
  ].join('\n')
}

/** councilInput.objective 增强：原始 objective + 基线预检（C，仅首轮）+
 *  环境预检（磁盘硬约束，与 C 同门）+ 增量评审说明（B）。目标文件为空或
 *  不适用时对应块自动省略。 */
function augmentCouncilObjective(
  objective: string,
  items: StarflowDraftItem[],
  cwd: string,
  opts?: { precheck?: boolean },
): string {
  const parts: string[] = [objective]
  if (opts?.precheck !== false) {
    const precheck = baselinePrecheckBlock(cwd, items.flatMap(i => i.files ?? []))
    if (precheck) parts.push(precheck)
    // 环境预检（2026-08-18）：磁盘余量等硬约束前移到评审——席位把草稿块的
    // 构建诉求与余量对勘，降级决策发生在确认前而非波次中途。
    const env = formatEnvPrecheckBlock(probeEnvFacts(cwd))
    if (env) parts.push(env)
  }
  const note = incrementalReviewNote(items)
  if (note) parts.push(note)
  return parts.join('\n\n')
}

// ── 门禁判定 ─────────────────────────────────────────────────────────────

type GateResult = { ok: true } | { ok: false; reason: string }

/** council 门禁：未执行（禁用/流会）与否决（blocking 冲突未化解）都是硬拦。
 *  优先读结构化 outcome（disabled 布尔）；缺席（假工具/未迁移产出）回退
 *  content.includes 散文匹配。否决走 COUNCIL_VETO_RE（稳定结构，非散文）。 */
function councilGate(result: ToolResult): GateResult {
  if (result.isError) return { ok: false, reason: `评审执行失败：${firstLine(result.content)}` }
  const outcome = result.orchestration?.kind === 'council' ? result.orchestration : undefined
  if (outcome?.disabled) {
    return { ok: false, reason: '评审未执行（council 已禁用或未派发任何席位，COUNCIL=0？）' }
  }
  if (!outcome && (result.content.includes('已禁用') || result.content.includes('未派发任何席位'))) {
    return { ok: false, reason: '评审未执行（council 已禁用或未派发任何席位，COUNCIL=0？）' }
  }
  // 席位全部失败：与 teamGate 的 workers.passed===0 同构的防御分支。当前流会路径
  // 先 throw → isError 拦截，这里通常不可达；但法定人数逻辑变化后（如失败不再
  // throw 时）gate 不能静默放行大面积失败。
  if (outcome?.seats && outcome.seats.total > 0 && outcome.seats.passed === 0) {
    return { ok: false, reason: `议事会席位全部失败（${outcome.seats.total} 席均未产出贡献）` }
  }
  const veto = COUNCIL_VETO_RE.exec(result.content)
  if (veto) {
    // 否决理由行（`- <description>: <left>`）抽出来附在 blockedReason 里。
    const reasons = result.content.slice(veto.index).split('\n')
      .filter(l => l.startsWith('- ')).slice(0, 5).map(l => l.slice(2))
    return { ok: false, reason: `议事会否决（blocking challenge 未化解）${reasons.length > 0 ? `：${reasons.join('；')}` : ''}` }
  }
  return { ok: true }
}

/** team 门禁：优先读结构化 outcome；缺席（假工具/未迁移产出）回退文案正则。
 *  文案改动不应让门禁静默失效——见 2026-08-01 TEAM_DISPATCHED_RE 事故。 */
function teamGate(result: ToolResult): GateResult {
  if (result.isError) return { ok: false, reason: `执行失败：${firstLine(result.content)}` }
  const outcome = result.orchestration?.kind === 'team' ? result.orchestration : undefined
  if (outcome) {
    if (outcome.workers.total > 0 && outcome.workers.passed === 0) {
      return { ok: false, reason: '波次 worker 全部失败' }
    }
    if (outcome.waveGate && !outcome.waveGate.passed) {
      const detail = outcome.waveGate.failures.slice(0, 2).join('；')
      return { ok: false, reason: `波间硬门禁未通过（${detail || 'typecheck/验证命令失败'}）` }
    }
    if (outcome.reviewVerdict === 'rejected') return { ok: false, reason: 'review gate 驳回了本波改动' }
    if (outcome.dispatched === 0) return { ok: false, reason: '未派发任何 worker（计划无可执行波次）' }
    return { ok: true }
  }
  if (TEAM_ALL_FAILED_RE.test(result.content)) return { ok: false, reason: '波次 worker 全部失败' }
  if (TEAM_WAVE_GATE_RE.test(result.content)) return { ok: false, reason: '波间硬门禁未通过（typecheck/验证命令失败）' }
  if (TEAM_REVIEW_REJECTED_RE.test(result.content)) return { ok: false, reason: 'review gate 驳回了本波改动' }
  const dispatched = TEAM_DISPATCHED_RE.exec(result.content)
  if (dispatched && Number(dispatched[1]) === 0) return { ok: false, reason: '未派发任何 worker（计划无可执行波次）' }
  return { ok: true }
}

/** 下一波序号：优先读结构化 outcome，缺席回退续波提示正则。返回 undefined = 已是末波。
 *
 *  整波失败也返回 undefined：被替代的正则路径里，formatTeamSummary（team-orchestrate.ts:114）
 *  在整波失败时**用停止警告替换掉续波提示**，所以正则匹配不到、不推波。结构化路径必须
 *  自带这个条件才等价——不能指望调用点先跑 teamGate 拦下（那是外部顺序，改一次调用序
 *  就会踩着失败的波次往前推，而散文路径不会）。 */
export function nextWaveOf(result: ToolResult): number | undefined {
  const outcome = result.orchestration?.kind === 'team' ? result.orchestration : undefined
  if (outcome) {
    if (outcome.workers.total > 0 && outcome.workers.passed === 0) return undefined
    return outcome.wave + 1 < outcome.totalWaves ? outcome.wave + 1 : undefined
  }
  const m = TEAM_NEXT_WAVE_RE.exec(result.content)
  return m ? Number(m[1]) : undefined
}

/** galaxy 门禁：isError（含 DP quorum 未达成）或维度未通过即硬拦，附失败维度。
 *  优先读结构化 outcome（dimensions total/passed/failed）；缺席（假工具/未迁移
 *  产出）回退 GALAXY_FAILED_RE + GALAXY_DIM_LINE_RE 逐行解析。 */
function galaxyGate(result: ToolResult): GateResult {
  if (result.isError) return { ok: false, reason: `攻坚执行失败：${firstLine(result.content)}` }
  const outcome = result.orchestration?.kind === 'galaxy' ? result.orchestration : undefined
  if (outcome) {
    const { total, passed, failed } = outcome.dimensions
    // 两个判据数据源不同：passed/total 数 run.results，failed 数 targets（派发请求
    // 无对应结果时也计入）。正常一一对应，分叉时取大者——否则会输出「0/3 个维度未
    // 通过（frontend 文曲）」这种自相矛盾的 reason。
    const failedCount = Math.max(total - passed, failed.length)
    if (failedCount > 0) {
      return {
        ok: false,
        reason: `${failedCount}/${total} 个维度未通过${failed.length > 0 ? `（${failed.slice(0, 5).join('、')}）` : ''}`,
      }
    }
    return { ok: true }
  }
  const failed = GALAXY_FAILED_RE.exec(result.content)
  if (failed) {
    const failedDims: string[] = []
    for (const m of result.content.matchAll(GALAXY_DIM_LINE_RE)) failedDims.push(m[1]!.trim())
    return {
      ok: false,
      reason: `${failed[1]}/${failed[2]} 个维度未通过${failedDims.length > 0 ? `（${failedDims.slice(0, 5).join('、')}）` : ''}`,
    }
  }
  return { ok: true }
}

/** council 产出里抽取密封契约 planJson；无契约（零任务计划）返回 undefined。 */
function extractPlanJson(content: string): string | undefined {
  return COUNCIL_PLAN_JSON_RE.exec(content)?.[1]?.trim() || undefined
}

/** 从 team 工具结果的结构化 outcome 里吸收逐 worker 战报行（接口层，2026-08-18）。
 *  按 task 去重后波覆盖前波（战报=当前真相；逐波历史在 phase artifact）。
 *  outcome 缺席或无行（假工具/预览）时不动 state——旧行为零变化。 */
function absorbTeamBlocks(state: StarflowState, result: ToolResult, wave: number): void {
  const outcome = result.orchestration
  if (!outcome || typeof outcome !== 'object' || (outcome as { kind?: string }).kind !== 'team') return
  const rows = (outcome as { workerRows?: TeamWorkerRow[] }).workerRows
  if (!rows || rows.length === 0) return
  const merged = new Map((state.teamBlocks ?? []).map(b => [b.task, b]))
  for (const row of rows) merged.set(row.task, { ...row, wave })
  state.teamBlocks = [...merged.values()]
}

// ── 报告 ─────────────────────────────────────────────────────────────────

const PHASE_LABELS: Record<'council' | 'team' | 'galaxy' | 'deliver', string> = {
  council: '阶段 1 council 评审',
  team: '阶段 2 team 波次',
  galaxy: '阶段 3 galaxy 攻坚',
  deliver: '阶段 4 交付门禁',
}

function phaseStatusLine(key: 'council' | 'team' | 'galaxy' | 'deliver', record: StarflowPhaseRecord | undefined, note?: string): string {
  const label = PHASE_LABELS[key]
  if (!record) return `${label}：… 未执行`
  const icon = record.status === 'passed' ? '✅' : record.status === 'skipped' ? '⏭ 跳过' : '⛔ 受阻'
  return `${label}：${icon}${note ?? ''} — ${record.summary}`
}

/** 战报行内联上限——超出时只保留未过块（正常 12 块计划的 2 倍余量；
 *  全量逐波历史在 phase artifact，报告只承担「先看哪块」。 */
const TEAM_REPORT_ROW_CAP = 24

const WORKER_STATUS_ICON: Record<TeamWorkerRow['status'], string> = {
  passed: '✅',
  failed: '⛔',
  blocked: '⏸',
  escalated: '⚠',
}

function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function fmtDur(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 1000)}s`
}

/** 波次战报段（接口层，2026-08-18）：team 逐块终态进最终报告——编排器不再
 *  翻 state/artifact 取证。失败在前；小计行给全貌。 */
function renderTeamBlocks(blocks: ReadonlyArray<TeamWorkerRow & { wave: number }>): string[] {
  const sorted = [...blocks].sort((a, b) => {
    const na = a.status === 'passed' ? 1 : 0
    const nb = b.status === 'passed' ? 1 : 0
    return na - nb || a.wave - b.wave || a.task.localeCompare(b.task)
  })
  const over = sorted.length > TEAM_REPORT_ROW_CAP
  const shown = over ? sorted.filter(b => b.status !== 'passed').slice(0, TEAM_REPORT_ROW_CAP) : sorted
  const lines = ['', `波次战报（${blocks.length} 块 · 失败在前；逐波全量在 team phase artifact）：`]
  for (const b of shown) {
    const icon = WORKER_STATUS_ICON[b.status] ?? '·'
    const bits: string[] = []
    bits.push(`${b.changedCount} 改动${b.changedFiles && b.changedFiles.length > 0 ? `(${b.changedFiles.join(',')})` : ''}`)
    if (b.diffArtifactId) bits.push(`diff:${b.diffArtifactId}`)
    if (b.usage) bits.push(`${fmtTok(b.usage.input)}/${fmtTok(b.usage.output)} tok`)
    if (typeof b.durationMs === 'number') bits.push(fmtDur(b.durationMs))
    const reason = b.failureReason ? ` ${b.failureReason} —` : b.summary ? '' : ''
    const summary = b.summary ? ` ${b.summary}` : ''
    lines.push(`  w${b.wave} ${b.task} ${icon}${reason}${summary}（${bits.join(' · ')}）`)
  }
  if (over) {
    const hidden = sorted.length - shown.length
    lines.push(`  …另有 ${hidden} 块未内联（已过或超出上限），见 team phase artifact`)
  }
  const tally = (s: string): number => blocks.filter(b => b.status === s).length
  lines.push(`  小计：${blocks.length} 块 · ✅${tally('passed')} ⛔${tally('failed')} ⏸${tally('blocked')} ⚠${tally('escalated')}`)
  return lines
}

/** 按受阻阶段给出人话的下一步建议。 */
function nextStepHint(state: StarflowState): string {
  const reason = state.blockedReason ?? ''
  switch (state.phase) {
    case 'council':
      if (reason.includes('已禁用') || reason.includes('未派发任何席位')) {
        return '议事会被禁用（COUNCIL=0）。开启 COUNCIL 后重试，或放弃星流改用 team_orchestrate 直接执行。'
      }
      if (reason.includes('否决')) {
        return '按否决理由修订计划草稿（draftItems）后重新调用 starflow；或传 rounds:2 让席位复议收敛。'
      }
      return '查看上方失败原因修复后重试。'
    case 'team':
      return '修复失败项后用 starflow({ objective, resume: true }) 续跑——council 已过门禁不会重跑。'
    case 'galaxy':
      return '检查失败维度修复后用 starflow({ objective, resume: true }) 续跑；或在 galaxyDims 里调整维度划分。'
    default:
      return '查看上方原因修复后重试。'
  }
}

function buildReport(state: StarflowState, teamRetried: boolean, cwd?: string): string {
  const lines: string[] = [
    `${GLYPH} 星流执行报告 · ${firstLine(state.objective, 80)}`,
    '',
    phaseStatusLine('council', state.phases.council),
    phaseStatusLine('team', state.phases.team, teamRetried && state.phases.team?.status === 'passed' ? '（复议 1 次后通过）' : undefined),
    phaseStatusLine('galaxy', state.phases.galaxy),
    phaseStatusLine('deliver', state.phases.deliver),
  ]
  if (state.teamBlocks && state.teamBlocks.length > 0) {
    lines.push(...renderTeamBlocks(state.teamBlocks))
  }
  if (state.phase === 'done') {
    lines.push('', '交付检查清单（deliver_task 硬门禁前置自查）：',
      '  - typecheck / 测试已运行并通过（未运行 = 未验证）',
      '  - 消费方路径核对（改动语义通达）',
      '  - RED-GREEN 证据齐备（先写失败测试再实现）',
      '', '下一步：调用 deliver_task 完成交付门禁。')
  } else {
    lines.push('', `⛔ 星流停止于 ${state.phase} 阶段：${state.blockedReason ?? '未知原因'}`,
      '', `下一步建议：${nextStepHint(state)}`)
  }
  // 环境预检页脚（2026-08-18）：每次调用（含 resume）带新鲜磁盘余量，压在
  // 报告最尾——被环境约束降级过的块，续跑时自动复检，不靠用户口述状态变化。
  if (cwd) {
    const footer = formatEnvFooter(probeEnvFacts(cwd))
    if (footer) lines.push('', footer)
  }
  return lines.join('\n')
}

// ── 状态机主体 ────────────────────────────────────────────────────────────

/** 子工具调用参数：透传会话载体，toolUseId 按阶段加后缀（worker 活动树归属），
 *  cwd 以 deps.cwd 为准（状态落盘与子工具执行同一项目根）。 */
function subParams(deps: StarflowDeps, tag: string): ToolCallParams {
  return { ...deps.params, input: {}, toolUseId: `${deps.params.toolUseId}-starflow-${tag}`, cwd: deps.cwd }
}

/** Keep the primary TUI alive while a nested phase is waiting on a provider or
 * a worker wave. The heartbeat is text-streamed through the normal tool output
 * path, so existing renderers update `lastActivityMs` without a new transport. */
async function runWithPhaseHeartbeat<T>(
  deps: StarflowDeps,
  phase: 'council' | 'team' | 'galaxy',
  task: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now()
  const heartbeat = setInterval(() => {
    const elapsedS = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
    deps.params.onOutput?.(`${GLYPH} 星流 · ${phase} 阶段执行中（已 ${elapsedS}s；子代理活动见任务面板）\n`)
  }, STARFLOW_HEARTBEAT_MS)
  heartbeat.unref?.()
  try {
    return await task()
  } finally {
    clearInterval(heartbeat)
  }
}

export async function runStarflow(deps: StarflowDeps, input: StarflowInput): Promise<StarflowRun> {
  const now = () => Date.now()
  const loadedState = input.resume ? loadState(deps.cwd, input.objective, deps.params.sessionId) : undefined
  const state = loadedState
    ? { ...loadedState, ...(deps.params.sessionId ? { sessionId: deps.params.sessionId } : {}) }
    : freshState(input.objective, now(), deps.params.sessionId, deps.params.toolUseId)
  const lease = acquireStarflowLease(deps.cwd, input.objective, state.runId)
  if (!lease) {
    state.blockedReason = 'another Starflow run for this objective is still active; wait for its checkpoint or resume it later'
    return { state, report: buildReport(state, false, deps.cwd), resumed: Boolean(loadedState) }
  }

  try {
  // Promote a cross-session resume into the new session namespace immediately,
  // including when the loaded state is already `done` and no phase re-runs.
  if (loadedState && deps.params.sessionId && loadedState.sessionId !== deps.params.sessionId) {
    saveState(deps.cwd, state)
  }
  // 非 resume 的显式重跑：丢弃旧状态从头来（freshState 已覆盖）。
  const result = await runStarflowUnlocked(deps, input, state)
  return { ...result, resumed: Boolean(loadedState) }
  } finally {
    lease.release()
  }
}

async function runStarflowUnlocked(deps: StarflowDeps, input: StarflowInput, state: StarflowState): Promise<StarflowRun> {
  const now = () => Date.now()
  let teamRetried = false
  /** M3：council 等待期预取的目标文件摘要（galaxy 派生维度注入用）。 */
  let prewarmFactBlock: string | undefined
  const phaseStartedAt = new Map<'council' | 'team' | 'galaxy' | 'deliver', number>()
  const phaseOutputs = new Map<'council' | 'team' | 'galaxy' | 'deliver', string[]>()
  const beginPhase = (phase: 'council' | 'team' | 'galaxy' | 'deliver'): void => {
    if (!phaseStartedAt.has(phase)) phaseStartedAt.set(phase, now())
  }
  const rememberPhaseOutput = (phase: 'council' | 'team' | 'galaxy' | 'deliver', content: string): void => {
    if (!content.trim()) return
    const outputs = phaseOutputs.get(phase) ?? []
    outputs.push(content)
    phaseOutputs.set(phase, outputs)
  }
  const phaseRawContent = (phase: 'council' | 'team' | 'galaxy' | 'deliver', fallback: string): string => {
    const outputs = phaseOutputs.get(phase)
    return outputs && outputs.length > 0 ? outputs.join('\n\n--- phase output ---\n\n') : fallback
  }
  const phaseElapsed = (phase: 'council' | 'team' | 'galaxy' | 'deliver'): number | undefined => {
    const started = phaseStartedAt.get(phase)
    return started === undefined ? undefined : Math.max(0, now() - started)
  }

  const checkpoint = async (
    phase: 'council' | 'team' | 'galaxy' | 'deliver',
    record: StarflowPhaseRecord,
    rawContent: string,
  ): Promise<void> => {
    const persisted = await persistPhaseOutput(deps, state, phase, rawContent)
    state.phases[phase] = { ...record, ...persisted }
    state.updatedAt = now()
    saveState(deps.cwd, state)
  }
  const block = async (phase: 'council' | 'team' | 'galaxy', reason: string, summary: string, rawContent = summary): Promise<StarflowRun> => {
    state.phase = phase
    state.blockedReason = reason
    const elapsedMs = phaseElapsed(phase)
    await checkpoint(phase, { status: 'blocked', summary, at: now(), ...(elapsedMs === undefined ? {} : { elapsedMs }) }, phaseRawContent(phase, rawContent))
    deps.params.onOutput?.(`${GLYPH} 星流 · ${phase} 阶段已保存中断检查点，可用 resume: true 续跑\n`)
    return { state, report: buildReport(state, teamRetried, deps.cwd) }
  }
  const pass = async (
    phase: 'council' | 'team' | 'galaxy' | 'deliver',
    next: StarflowPhase,
    summary: string,
    status: 'passed' | 'skipped' = 'passed',
    rawContent = summary,
  ): Promise<void> => {
    const elapsedMs = phaseElapsed(phase)
    state.phase = next
    state.blockedReason = undefined
    // Persist the completed phase and the next phase in one atomic snapshot.
    // The previous order wrote a checkpoint and then immediately wrote the
    // phase transition again, doubling filesystem work on every successful
    // stage without adding recovery information.
    await checkpoint(phase, { status, summary, at: now(), ...(elapsedMs === undefined ? {} : { elapsedMs }) }, phaseRawContent(phase, rawContent))
  }

  // ── 阶段 1：council 评审 ─────────────────────────────────────────────
  if (state.phase === 'council') {
    beginPhase('council')
    deps.params.onOutput?.(`${GLYPH} 星流 · 阶段 1/4 council 评审\n`)
    const councilInput: Record<string, unknown> = { objective: input.objective, confirm: true }
    if (input.draftItems && input.draftItems.length > 0) {
      councilInput.draftItems = input.draftItems
      // C: 基线预检（首轮）——工作树/提交现状注入 objective 尾部。
      // B: 增量评审——previousVerdict=passed 的未变条目渲染「沿用前轮通过结论」。
      councilInput.objective = augmentCouncilObjective(input.objective, input.draftItems, deps.cwd)
    }
    if (input.rounds) councilInput.rounds = input.rounds
    if (input.seats && input.seats.length > 0) councilInput.seats = input.seats
    // M3：council 等待期预热——与评审并行预取草稿目标文件（OS 缓存 + 事实
    // 摘要），galaxy 派生维度据此省掉首轮探索。best-effort：预取失败绝不影响
    // 评审；显式 galaxyDims 不注入（用户已给精确定义）。
    const prewarmFiles = input.draftItems?.flatMap(i => i.files ?? []) ?? []
    const prewarmPromise = prewarmFiles.length > 0
      ? Promise.all(prewarmFiles.slice(0, 20).map(f => buildPrewarmValue(deps.cwd, f))).then(vals => vals.filter((v): v is PrewarmValue => v !== undefined))
      : Promise.resolve([] as PrewarmValue[])
    let result: ToolResult
    try {
      result = await runWithPhaseHeartbeat(deps, 'council', () =>
        deps.councilTool.execute({ ...subParams(deps, 'council'), input: councilInput }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      rememberPhaseOutput('council', message)
      return block('council', `council 执行中断：${message}`, message)
    }
    const prewarmed = await prewarmPromise
    // M3：跨阶段共享（galaxy 段消费）——函数顶部声明，council 块内赋值。
    prewarmFactBlock = prewarmed.length > 0 ? buildPrewarmFactBlock(prewarmed) : undefined
    rememberPhaseOutput('council', result.content)
    const gate = councilGate(result)
    if (!gate.ok) return block('council', gate.reason, firstLine(result.content), result.content)
    const planJson = extractPlanJson(result.content)
    if (planJson) state.planJson = planJson
    await pass('council', 'team', firstLine(result.content), 'passed', result.content)
  }

  // ── 阶段 2：team 波次（失败可回 council 复议一次） ─────────────────────
  if (state.phase === 'team') {
    beginPhase('team')
    deps.params.onOutput?.(`${GLYPH} 星流 · 阶段 2/4 team 波次\n`)
    for (;;) {
      // 多波计划：team_orchestrate 每次只派一个就绪波次，按续波提示逐波推进。
      // M1：复议/恢复时从已通过的最大波号续跑（completedTeamWaves 是已通过
      // 波号，下一波 = +1），不重跑已完成波次。
      let fromWave = (state.completedTeamWaves ?? -1) + 1
      let lastResult: ToolResult | undefined
      const waveTag = state.teamRetries > 0 ? `team-r${state.teamRetries}` : 'team'
      for (let wave = 0; wave < MAX_TEAM_WAVES; wave++) {
        const teamInput: Record<string, unknown> = { objective: input.objective, confirm: true, fromWave, autoAdvance: false }
        // autoAdvance 显式钉死 false：波次推进由星流外层状态机逐波驱动（每波后保留回
        // council 复议的控制权），不能交给 team 内部自动推进——缺省时该值依赖
        // fromWave 是否传入隐式联动，显式声明才不随调用形态漂移。
        if (state.planJson) teamInput.planJson = state.planJson
        try {
          lastResult = await runWithPhaseHeartbeat(deps, 'team', () =>
            deps.teamTool.execute({ ...subParams(deps, `${waveTag}-w${fromWave}`), input: teamInput }))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          rememberPhaseOutput('team', message)
          return block('team', `team 执行中断：${message}`, message)
        }
        rememberPhaseOutput('team', lastResult.content)
        // 战报行随波吸收；落盘搭 completedTeamWaves 的顺车 saveState（下方），
        // 门禁未过的波也吸收——失败块正是战报要置顶的东西。
        absorbTeamBlocks(state, lastResult, fromWave)
        const gate = teamGate(lastResult)
        if (!gate.ok) {
          // 复议上限 1 次：回 council（rounds:2 复议轮）重审契约后再跑 team。
          if (state.teamRetries >= 1) return block('team', gate.reason, firstLine(lastResult.content), lastResult.content)
          state.teamRetries++
          teamRetried = true
          state.updatedAt = now()
          saveState(deps.cwd, state)
          deps.params.onOutput?.(`${GLYPH} 星流 · team 门禁未过（${gate.reason}）→ 回 council 复议（上限 1 次）\n`)
          const reInput: Record<string, unknown> = { objective: input.objective, confirm: true, rounds: 2 }
          if (input.draftItems && input.draftItems.length > 0) {
            reInput.draftItems = input.draftItems
            // 复议轮带增量评审说明（B），不带基线预检（C 仅首轮——复议聚焦修订点）。
            reInput.objective = augmentCouncilObjective(input.objective, input.draftItems, deps.cwd, { precheck: false })
          }
          if (input.seats && input.seats.length > 0) reInput.seats = input.seats
          phaseStartedAt.set('council', now())
          let reResult: ToolResult
          try {
            reResult = await runWithPhaseHeartbeat(deps, 'council', () =>
              deps.councilTool.execute({ ...subParams(deps, 'council-retry'), input: reInput }))
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            rememberPhaseOutput('council', message)
            return block('team', `复议执行中断：${message}`, message)
          }
          rememberPhaseOutput('council', reResult.content)
          const reGate = councilGate(reResult)
          if (!reGate.ok) return block('team', `复议未过：${reGate.reason}`, firstLine(reResult.content), reResult.content)
          state.planJson = extractPlanJson(reResult.content) ?? state.planJson
          const reElapsedMs = phaseElapsed('council')
          await checkpoint('council', {
            status: reGate.ok ? 'passed' : 'blocked',
            summary: firstLine(reResult.content),
            at: now(),
            ...(reElapsedMs === undefined ? {} : { elapsedMs: reElapsedMs }),
          }, phaseRawContent('council', reResult.content))
          break // 跳出波次循环，外层 for(;;) 重跑 team
        }
        // M1：波次通过即记账（含末波）——后续 blocked/resume 从 completedTeamWaves 续跑。
        if (state.completedTeamWaves === undefined || fromWave > state.completedTeamWaves) {
          state.completedTeamWaves = fromWave
          state.updatedAt = now()
          saveState(deps.cwd, state)
        }
        const next = nextWaveOf(lastResult)
        if (next === undefined) break // 无下一波 = 已跑到末波
        fromWave = next
        if (wave === MAX_TEAM_WAVES - 1) {
          return block('team', `波次推进超过上限（${MAX_TEAM_WAVES}）——异常续波循环`, firstLine(lastResult.content), lastResult.content)
        }
      }
      if (lastResult && !teamGate(lastResult).ok) continue // 已决定复议：回外层循环
      await pass('team', 'galaxy', firstLine(lastResult?.content ?? ''), 'passed', lastResult?.content ?? '')
      break
    }
  }

  // ── 阶段 3：galaxy 攻坚 ──────────────────────────────────────────────
  if (state.phase === 'galaxy') {
    beginPhase('galaxy')
    const derived = input.galaxyDims ?? deriveGalaxyDims(input.draftItems)
    // D8：council 契约（planJson）的 nonGoals/obligations → 计划约束，合并进
    // 每个维度（派生与显式 galaxyDims 都收）。galaxy 工具的 planPath 通道在
    // starflow 场景是空的（契约在 state.planJson 而非磁盘文件），这里显式注入。
    const rawPlanJson = state.planJson
    const planJsonConstraints = rawPlanJson
      ? (() => {
          const plan = deserializeUnifiedPlan(rawPlanJson)
          if (!plan) return undefined
          const rendered = constraintsFromUnifiedPlan({
            nonGoals: plan.nonGoals,
            obligations: (plan as PlanWithObligations).obligations?.map(o => ({ kind: o.kind, text: o.text })),
          })
          return rendered.length > 0 ? rendered : undefined
        })()
      : undefined
    const withPlanConstraints = (d: StarflowGalaxyDimension): StarflowGalaxyDimension =>
      planJsonConstraints ? { ...d, constraints: [...(d.constraints ?? []), ...planJsonConstraints] } : d
    // M3：只对派生维度注入预取摘要（显式 galaxyDims 是用户精确定义，不稀释）。
    const dimsWithFacts = !input.galaxyDims && prewarmFactBlock
      ? derived.map(d => ({ ...d, objective: `${prewarmFactBlock}\n\n${d.objective}` }))
      : derived
    if (dimsWithFacts.length < 2) {
      // 无显式维度也无可派生草稿——galaxy schema 要求 min 2，不足即跳过。
      const why = input.galaxyDims
        ? `显式 galaxyDims 仅 ${dimsWithFacts.length} 个（min 2），跳过攻坚`
        : '无 draftItems 可派生维度，跳过攻坚'
      await pass('galaxy', 'deliver', why, 'skipped')
    } else {
      deps.params.onOutput?.(`${GLYPH} 星流 · 阶段 3/4 galaxy 攻坚（${dimsWithFacts.length} 维度）\n`)
      const dims = dimsWithFacts.slice(0, 5).map(withPlanConstraints)
      let result: ToolResult
      try {
        result = await runWithPhaseHeartbeat(deps, 'galaxy', () => deps.galaxyTool.execute({
          ...subParams(deps, 'galaxy'),
          input: { objective: input.objective, dimensions: dims, autoReview: input.autoReview ?? true, confirm: true },
        }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        rememberPhaseOutput('galaxy', message)
        return block('galaxy', `galaxy 执行中断：${message}`, message)
      }
      rememberPhaseOutput('galaxy', result.content)
      const gate = galaxyGate(result)
      if (!gate.ok) return block('galaxy', gate.reason, firstLine(result.content), result.content)
      const truncated = derived.length > 5 ? `（草稿 ${derived.length} 项截断为 5 维）` : ''
      await pass('galaxy', 'deliver', `${firstLine(result.content)}${truncated}`, 'passed', result.content)
    }
  }

  // ── 阶段 4：交付清单（硬门禁归 deliver_task，此处只输出清单） ────────────
  if (state.phase === 'deliver') {
    beginPhase('deliver')
    await pass('deliver', 'done', '交付清单已输出，待调用 deliver_task')
  }

  return { state, report: buildReport(state, teamRetried, deps.cwd) }
}

/**
 * /sessions/* routes — the desktop-facing multi-session API surface over
 * RuntimeSessionManager. Every route is Bearer-gated (fail-closed).
 *
 *   POST   /sessions                                   create (+optional prompt)
 *   GET    /sessions                                   list
 *   DELETE /sessions/:id                               archive (soft-close)
 *   POST   /sessions/:id/unarchive                     restore an archived session
 *   PATCH  /sessions/:id                               rename session title
 *   DELETE /sessions/:id/permanent                     permanently delete archived session
 *   GET    /sessions/:id                               one record
 *   POST   /sessions/:id/prompt                        start a run
 *   POST   /sessions/:id/steer                         queue mid-run guidance (T3)
 *   POST   /sessions/:id/abort                         abort
 *   GET    /sessions/:id/events?since=N                replay tail (B3)
 *   GET    /sessions/:id/files?q=&limit=                @file mention picker (D2)
 *   GET    /sessions/:id/stream?since=N                live SSE (B3)
 *   POST   /sessions/:id/interventions/:rid/answer     resolve approval (B2)
 *   POST   /sessions/:id/delegate-capabilities         E4 register/heartbeat client landing kinds
 *   POST   /sessions/:id/delegate/:rid/result          E4 resolve client landing
 *   GET    /sessions/:id/artifacts                     list (B4)
 *   GET    /sessions/:id/artifacts/:artifactId         read raw (B4)
 *   GET    /sessions/:id/jobs                           list background jobs
 *   GET    /sessions/:id/jobs/:jobId/logs              background job output
 *   POST   /sessions/:id/jobs/:jobId/kill              terminate a background job
 *   GET    /worktrees                                  list git worktrees
 *   GET    /github/prs                                 list open PRs (via gh CLI)
 *   GET    /github/prs/:number                         PR detail with comments/files
 *   GET    /github/prs/:number/checks                  CI checks overview (gh pr checks)
 *   GET    /github/prs/:number/checks/:checkIndex/log  single check failure log
 *   POST   /github/prs/:number/merge                   merge a PR (confirm-gated)
 *   POST   /github/prs/:number/push-fix                push auto-fix diff to PR head (confirm-gated)
 */
import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import { allowedCorsOrigin } from './cors.js'
import { SseStream } from './sse-stream.js'
import type { RuntimeSessionManager } from './session-manager.js'
import type { Artifact } from '../artifact/types.js'
import type { SessionRegistry } from '../agent/session-registry.js'
import type { ApprovalMode } from '../agent/loop-types.js'
import type { ReasoningEffort } from '../agent/auto-reasoning.js'
import type { PlanDocument } from '../plan/plan-store.js'
import type { Config } from '../config/schema.js'
import type { SessionRecord } from './protocol.js'
import { computeUsageCost, findModelPricing } from '../utils/pricing.js'
import { getRollbackPreview, rollbackToCheckpoint, makeOwnershipGuard } from '../agent/checkpoint.js'
import { listProjectFiles, rankFiles, listDirEntries } from './file-list.js'
import { listPrs, getPrDetail, isGhAvailable, getPrDiff, submitPrReview, listPrChecks, getCheckRunLog, mergePr, type PrReviewInput } from './gh-cli.js'
import { pushFixToPrBranch } from './pr-fix-push.js'
import { resolveAppPromptInput } from '../tui/slash-commands.js'
import { getPaletteCommands } from '../tui/command-palette.js'
import { RECOMMENDED_MAX_SKILLS } from '../skills/skill-loader.js'
import { validatePath } from '../tools/path-validate.js'
import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { extname, relative, join, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { extractDocumentText, EXTRACTION_CAVEAT } from '../tools/doc-extract.js'
import type { HookEntry, HookEvent, HooksConfig } from '../hooks/user-hooks-runner.js'
import { loadHooksConfig, VALID_EVENTS } from '../hooks/user-hooks-runner.js'
import { buildDistillPrompt } from '../prompt/rpa-distill.js'
import { isProFeatureEnabled } from '../config/pro-license.js'
import { searchSessionTranscripts } from './session-search.js'
import { listCheckpoints, loadCheckpoint, buildResumeFromCheckpoint } from '../agent/wave-checkpoint.js'
import { storePlan } from '../agent/plan-store.js'
import {
  TIANSHU_PROTOCOL_HEADER,
  TIANSHU_PROTOCOL_VERSION,
  parseDelegateKinds,
} from './delegation-protocol.js'
import { classifyModelSpecMiss } from './serve.js'

const PROTOCOL_HEADERS: Record<string, string> = {
  [TIANSHU_PROTOCOL_HEADER]: String(TIANSHU_PROTOCOL_VERSION),
}

export type ArtifactKind = 'plan' | 'task-list' | 'walkthrough' | 'diff' | 'screenshot' | 'test-result' | 'markdown' | 'html'

type SessionRouteDependencies = {
  searchSessionTranscripts?: typeof searchSessionTranscripts
  /**
   * B4（2026-09-07 审查）：模型切换失败附因的 config 刷新源。解析走
   * resolveModelSpecWithReload（磁盘 reload），附因若用启动快照 config 会在
   * Settings 新加 provider 后至 server 重启窗口内报错类——serve 注入
   * `() => resolveServeContext().config`；缺省时退回快照（向后兼容）。
   */
  reloadConfig?: () => Config
}

/** Vision upload guards — provider-safe formats and a per-image byte ceiling. */
const MAX_IMAGES = 4
/** Document attachment guards (word/excel/pdf — extracted server-side). */
const MAX_DOCUMENTS = 4
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024

/** Cap on a single CI check log payload returned to the desktop (tail-kept). */
const MAX_CHECK_LOG_CHARS = 200_000
/** Per-image decoded byte cap — 与 TUI（image-attach.ts）、桌面端压缩出口
 *  （image-compress.ts MAX_OUTPUT_BYTES）、read_file 工具统一 10MB；
 *  DeepSeek 官方 base64 内联上限 32MiB，10MB 在安全区内。 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const ACCEPTED_IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,.+$/i

/** Decoded byte size of a `data:...;base64,<payload>` URL (without decoding it). */
function decodedBase64Bytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return 0
  const b64 = dataUrl.slice(comma + 1)
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.floor((b64.length * 3) / 4) - padding
}

/** Validate an images payload: array of provider-safe base64 data URLs. Defense in
 *  depth — the desktop already compresses + transcodes, but the server is the
 *  trust boundary (formats the model can't consume, oversized payloads).
 *  Shared by POST /sessions (create-with-images) and POST /sessions/:id/prompt. */
function validateImagesPayload(value: unknown): { images?: string[]; error?: string } {
  if (value === undefined) return {}
  if (!Array.isArray(value) || value.length === 0) {
    return { error: '"images" must be a non-empty array' }
  }
  if (value.length > MAX_IMAGES) {
    return { error: `Max ${MAX_IMAGES} images allowed` }
  }
  for (const img of value) {
    if (typeof img !== 'string' || !ACCEPTED_IMAGE_DATA_URL.test(img)) {
      return { error: 'Each image must be a data:image/(png|jpeg|webp|gif);base64 URL' }
    }
    if (decodedBase64Bytes(img) > MAX_IMAGE_BYTES) {
      return { error: `Each image must be <= ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB` }
    }
  }
  return { images: value as string[] }
}

/** S — accepted autonomy levels for per-session approval-mode overrides. */
const APPROVAL_MODES: ReadonlySet<ApprovalMode> = new Set<ApprovalMode>([
  'auto-accept', 'auto-safe', 'manual', 'dangerously-skip-permissions',
])
const isApprovalMode = (v: unknown): v is ApprovalMode =>
  typeof v === 'string' && APPROVAL_MODES.has(v as ApprovalMode)

/** Reasoning-effort levels accepted at session creation (same set as POST /sessions/:id/effort). */
const REASONING_EFFORTS: ReadonlySet<string> = new Set(['off', 'low', 'medium', 'high', 'max', 'auto'])
const isReasoningEffort = (v: unknown): v is string =>
  typeof v === 'string' && REASONING_EFFORTS.has(v)
const isPlanModeState = (v: unknown): v is 'off' | 'planning' =>
  v === 'off' || v === 'planning'
const isAskModeState = (v: unknown): v is 'off' | 'asking' =>
  v === 'off' || v === 'asking'

/**
 * A1（2026-09-07 审查）：POST /sessions/:id/model 失败的分流文案。
 * manager.switchModel 在 session missing/running 时直接 return false（早退，
 * 不触碰模型解析）——若无条件 classifyModelSpecMiss 附因，running 会话切模型
 * 会被误附「provider 无 key / 模型未配置」，把用户引向查 key 而实际原因是
 * 会话状态。分流：missing/running 给状态文案（不带 hint），仅「会话存在且
 * 空闲 + switchModel 失败（= 解析失败）」才附分类提示。
 */
export function describeModelSwitchFailure(
  rec: SessionRecord | undefined,
  config: Config | undefined,
  modelId: string,
  reloadConfig?: () => Config,
): string {
  if (!rec) return 'Session not found'
  if (rec.status === 'running') return 'Session is running — stop it before switching the model'
  // B4：附因优先用 reload 的最新 config（409 是低频失败路径，reload 成本可接受），
  // reload 失败回退快照——与解析侧 resolveModelSpecWithReload 的 reload 同源对齐。
  let cfg = config
  if (reloadConfig) {
    try { cfg = reloadConfig() ?? config } catch { /* reload 失败保持快照 */ }
  }
  let hint = ''
  if (cfg) {
    try {
      const miss = classifyModelSpecMiss(cfg, modelId)
      hint = miss === 'key-missing'
        ? ' — model found but its provider has no usable API key (check Settings → provider key)'
        : ' — no configured provider lists this model id/alias'
    } catch { /* 分类失败保持原文案 */ }
  }
  return `Model not found${hint}`
}

export function classifyArtifact(a: Artifact): ArtifactKind {
  const tool = a.tool.toLowerCase()
  const target = a.target.toLowerCase()
  if (tool.includes('plan') || target.includes('plan')) return 'plan'
  if (tool.includes('todo') || tool.includes('task')) return 'task-list'
  if (/\.(png|jpe?g|gif|webp)$/.test(target) || tool.includes('screenshot')) return 'screenshot'
  if (/\.(md|markdown|mdx)$/.test(target) || tool === 'render_markdown') return 'markdown'
  if (/\.(html?)$/.test(target) || tool === 'render_html') return 'html'
  if (
    tool === 'edit_file' ||
    tool === 'write_file' ||
    tool.includes('diff') ||
    /\.(diff|patch)$/.test(target)
  ) {
    return 'diff'
  }
  if (tool.includes('test') || target.includes('test') || tool === 'run_tests') return 'test-result'
  return 'walkthrough'
}

function artifactSummary(a: Artifact) {
  return {
    id: a.id,
    tool: a.tool,
    target: a.target,
    kind: classifyArtifact(a),
    summary: a.summary,
    charCount: a.charCount,
    lineCount: a.lineCount,
    createdAt: a.createdAt,
  }
}

/** Plan slugs may contain CJK (slugify allows \u4e00-\u9fff); URLs encode them. */
function decodeSlug(raw: string): string {
  try { return decodeURIComponent(raw) } catch { return raw }
}

/** Plan list entry — summary only (no markdown body), createdAt as epoch ms. */
function planSummary(p: PlanDocument) {
  return {
    slug: p.slug,
    title: p.title,
    status: p.status,
    path: p.path,
    createdAt: p.createdAt instanceof Date ? p.createdAt.getTime() : p.createdAt,
    approvedAt: p.approvedAt instanceof Date ? p.approvedAt.getTime() : p.approvedAt,
    options: p.options,
    model: p.model,
    modelTier: p.modelTier,
  }
}

function withAuth(handler: RouteHandler, apiToken?: string): RouteHandler {
  return async (body, params, headers, res) => {
    if (!isAuthorizedRequest({ body, headers }, apiToken)) {
      return { status: 401, body: { error: 'Unauthorized' }, headers: PROTOCOL_HEADERS }
    }
    const result = await handler(body, params, headers, res)
    // handled:true (SSE) sets its own headers; still stamp protocol on REST.
    if (result.handled) return result
    return { ...result, headers: { ...PROTOCOL_HEADERS, ...result.headers } }
  }
}

const REPLAY_SLICE_EVENTS = 200
const REPLAY_SLICE_MS = 4

async function sendReplayTimeSliced(
  res: import('node:http').ServerResponse,
  sse: SseStream,
  events: ReadonlyArray<{ type: string }>,
): Promise<void> {
  const canCork = typeof res.cork === 'function'
  let index = 0
  while (index < events.length && !sse.isClosed()) {
    const startedAt = performance.now()
    let sent = 0
    if (canCork) res.cork()
    try {
      while (
        index < events.length &&
        sent < REPLAY_SLICE_EVENTS &&
        (sent === 0 || performance.now() - startedAt < REPLAY_SLICE_MS)
      ) {
        const event = events[index]!
        sse.send(event.type, event)
        index++
        sent++
        if (sse.isClosed()) break
      }
    } finally {
      if (canCork) res.uncork()
    }
    if (index < events.length && !sse.isClosed()) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
}

export function buildSessionRoutes(
  manager: RuntimeSessionManager,
  apiToken?: string,
  getRegistry?: () => SessionRegistry | undefined,
  config?: Config,
  dependencies: SessionRouteDependencies = {},
): Record<string, RouteHandler> {
  const searchTranscripts = dependencies.searchSessionTranscripts ?? searchSessionTranscripts
  // R3 — build an OwnershipGuard scoped to one session so rollback never
  // restores files a *different* live session exclusively owns. Returns
  // undefined when no registry is wired (single-session / CLI path).
  const guardFor = (sessionId: string, cwd: string) => {
    const registry = getRegistry?.()
    return registry ? makeOwnershipGuard(registry, sessionId, cwd) : undefined
  }

  const routes: Record<string, RouteHandler> = {
    'POST /sessions': withAuth((body) => {
      // DEBUG instrumentation (RIVET_DEBUG_RENDER=1): logs createSession latency
      // so we can tell session-creation bottlenecks (loadConfig, worktree setup)
      // from SSE/stream issues. See docs/dev/render-debug-playbook.md.
      const __dbg = process.env.RIVET_DEBUG_RENDER === '1'
      const __t0 = __dbg ? Date.now() : 0
      const data = (body ?? {}) as { cwd?: string; title?: string; prompt?: string; missionId?: string; approvalMode?: unknown; isolatedWorktree?: unknown; model?: string; domain?: string; reasoningEffort?: unknown; planMode?: unknown; askMode?: unknown; planAutoApproveUi?: unknown; images?: unknown }
      if (data.approvalMode !== undefined && !isApprovalMode(data.approvalMode)) {
        return { status: 400, body: { error: 'Invalid "approvalMode"' } }
      }
      if (data.reasoningEffort !== undefined && !isReasoningEffort(data.reasoningEffort)) {
        return { status: 400, body: { error: 'Invalid "reasoningEffort" (off|low|medium|high|max|auto)' } }
      }
      if (data.planMode !== undefined && !isPlanModeState(data.planMode)) {
        return { status: 400, body: { error: 'Invalid "planMode" (off|planning)' } }
      }
      if (data.askMode !== undefined && !isAskModeState(data.askMode)) {
        return { status: 400, body: { error: 'Invalid "askMode" (off|asking)' } }
      }
      if (data.planMode === 'planning' && data.askMode === 'asking') {
        return { status: 400, body: { error: 'planMode and askMode are mutually exclusive' } }
      }
      // 新建即携带图片（欢迎页/新建对话框粘图）——与 /prompt 同一份校验。
      const imagesCheck = validateImagesPayload(data.images)
      if (imagesCheck.error) {
        return { status: 400, body: { error: imagesCheck.error } }
      }
      const rec = manager.createSession({
        cwd: data.cwd,
        title: data.title,
        prompt: data.prompt,
        images: imagesCheck.images,
        // P1 — 显式关联已有 Mission（桌面端「同任务再开一个会话」）。
        missionId: typeof data.missionId === 'string' && data.missionId.trim() ? data.missionId : undefined,
        approvalMode: data.approvalMode as ApprovalMode | undefined,
        isolatedWorktree: data.isolatedWorktree === true,
        model: typeof data.model === 'string' && data.model.trim() ? data.model.trim() : undefined,
        domain: typeof data.domain === 'string' && data.domain.trim() ? data.domain.trim() : undefined,
        reasoningEffort: data.reasoningEffort as ReasoningEffort | 'auto' | undefined,
        planMode: data.planMode as 'off' | 'planning' | undefined,
        askMode: data.askMode as 'off' | 'asking' | undefined,
        // P1b：客户端自报「我有自动批准倒计时 UI」。缺省即 fail-closed，
        // 不武装定时器——宿主看不见倒计时就不该被静默自动批准。
        planAutoApproveUi: data.planAutoApproveUi === true,
      })
      if (__dbg) console.log(`[createSession] +${Date.now() - __t0}ms id=${rec.id} cwd=${data.cwd}`)
      return { status: 201, body: rec }
    }, apiToken),

    // RPA 录制蒸馏 — 桌面端把录制 JSONL 交来，组装蒸馏 prompt 并开一次性
    // agent 会话，产出语义工作流文档（写到 session cwd 下的 workflowPath）。
    // Pro 门禁归入 computerUse（录制回放本质依赖 computer_use）。
    'POST /recordings/distill': withAuth((body) => {
      const data = (body ?? {}) as { recordingId?: string; jsonl?: string; cwd?: string }
      if (!data.recordingId || typeof data.recordingId !== 'string') {
        return { status: 400, body: { error: 'Missing "recordingId"' } }
      }
      if (!data.jsonl || typeof data.jsonl !== 'string') {
        return { status: 400, body: { error: 'Missing "jsonl"' } }
      }
      if (config && !isProFeatureEnabled(config, 'computerUse')) {
        return { status: 403, body: { error: 'pro_required', feature: 'computerUse' } }
      }
      // recordingId 进入文件路径，先约束成安全 slug（防路径注入）。
      const safeId = data.recordingId.replace(/[^a-zA-Z0-9_-]/g, '')
      if (!safeId) return { status: 400, body: { error: 'Invalid "recordingId"' } }
      const workflowPath = `.rivet/recordings/${safeId}.workflow.md`
      const built = buildDistillPrompt({ recordingId: safeId, jsonl: data.jsonl, workflowPath })
      if (!built.ok) {
        return { status: 400, body: { error: built.error } }
      }
      const rec = manager.createSession({
        cwd: data.cwd,
        title: `蒸馏录制 · ${built.apps.join('/') || safeId}`,
        prompt: built.prompt,
      })
      return { status: 201, body: { session: rec, workflowPath, eventCount: built.eventCount, apps: built.apps } }
    }, apiToken),

    // S — switch a session's autonomy level (监督 / 默认 / 自治). Live-mutates a
    // running agent's approval mode and persists onto the record. Bearer-gated.
    'POST /sessions/:id/approval-mode': withAuth((body, params) => {
      const id = params!.id!
      const data = (body ?? {}) as { approvalMode?: unknown }
      if (!isApprovalMode(data.approvalMode)) {
        return { status: 400, body: { error: 'Invalid or missing "approvalMode"' } }
      }
      if (!manager.setApprovalMode(id, data.approvalMode)) {
        return { status: 404, body: { error: 'Session not found' } }
      }
      return { status: 200, body: { id, approvalMode: data.approvalMode } }
    }, apiToken),

    // Reasoning effort — live-switch the session's reasoning effort level. Mirrors
    // the TUI /effort command; takes effect on the next turn without a rebuild.
    'POST /sessions/:id/effort': withAuth((body, params) => {
      const id = params!.id!
      const data = (body ?? {}) as { effort?: unknown }
      const valid = new Set<string>(['off', 'low', 'medium', 'high', 'max', 'auto'])
      if (typeof data.effort !== 'string' || !valid.has(data.effort)) {
        return { status: 400, body: { error: 'Invalid or missing "effort" (off|low|medium|high|max|auto)' } }
      }
      if (!manager.setReasoningEffort(id, data.effort as ReasoningEffort | 'auto')) {
        return { status: 404, body: { error: 'Session not found' } }
      }
      return { status: 200, body: { id, effort: data.effort } }
    }, apiToken),

    // Plan mode — toggle the session into read-only planning ('planning') or back
    // to normal execution ('off'). Emits a plan_mode event for live viewers.
    'POST /sessions/:id/plan-mode': withAuth(async (body, params) => {
      const id = params!.id!
      const data = (body ?? {}) as { state?: unknown }
      if (data.state !== 'off' && data.state !== 'planning') {
        return { status: 400, body: { error: 'Invalid or missing "state" (off|planning)' } }
      }
      if (!(await manager.setPlanMode(id, data.state))) {
        return { status: 404, body: { error: 'Session not found' } }
      }
      return { status: 200, body: { id, planMode: data.state } }
    }, apiToken),

    // Ask mode — toggle the session into pure read-only Q&A ('asking') or back
    // to normal execution ('off'). Mutually exclusive with plan-mode.
    'POST /sessions/:id/ask-mode': withAuth(async (body, params) => {
      const id = params!.id!
      const data = (body ?? {}) as { state?: unknown }
      if (data.state !== 'off' && data.state !== 'asking') {
        return { status: 400, body: { error: 'Invalid or missing "state" (off|asking)' } }
      }
      if (!(await manager.setAskMode(id, data.state))) {
        return { status: 404, body: { error: 'Session not found' } }
      }
      return { status: 200, body: { id, askMode: data.state } }
    }, apiToken),

    // ── Goal mode (autonomous cross-turn goal pursuit) ───────────────
    // Desktop equivalent of the CLI `/goal` command. The tracker drives
    // continuation via GoalContinuationController (assembled in loop-factory);
    // update_goal / deliver_task tools read refs.goalTrackerRef, kept in sync
    // by the manager. State changes emit `goal_state` events (SSE).
    'POST /sessions/:id/goal': withAuth(async (body, params) => {
      const id = params!.id!
      const data = (body ?? {}) as { goal?: unknown; maxIterations?: unknown; wallClockMs?: unknown; successCriteria?: unknown; contextWindow?: unknown }
      if (typeof data.goal !== 'string' || data.goal.trim().length === 0) {
        return { status: 400, body: { error: 'Missing or empty "goal"' } }
      }
      const maxIter = typeof data.maxIterations === 'number' && data.maxIterations > 0 ? Math.floor(data.maxIterations) : 100
      const ctxWindow = typeof data.contextWindow === 'number' && data.contextWindow > 0 ? data.contextWindow : 64000
      const opts = {
        goal: data.goal,
        maxIterations: maxIter,
        contextWindow: ctxWindow,
        ...(typeof data.wallClockMs === 'number' && data.wallClockMs > 0 ? { wallClockMs: data.wallClockMs } : {}),
        ...(Array.isArray(data.successCriteria) ? { successCriteria: data.successCriteria.filter((c): c is string => typeof c === 'string') } : {}),
      }
      const snap = await manager.setGoal(id, opts)
      if (!snap) return { status: 503, body: { error: 'Goal mode unavailable (session not found or sidecar not goal-capable)' } }
      return { status: 200, body: snap }
    }, apiToken),

    'GET /sessions/:id/goal': withAuth((_body, params) => {
      const snap = manager.getGoalState(params!.id!)
      if (!snap) return { status: 404, body: { error: 'No active goal for this session' } }
      return { status: 200, body: snap }
    }, apiToken),

    'POST /sessions/:id/goal/pause': withAuth((body, params) => {
      const data = (body ?? {}) as { reason?: unknown }
      const snap = manager.pauseGoal(params!.id!, typeof data.reason === 'string' ? data.reason : undefined)
      if (!snap) return { status: 404, body: { error: 'No active goal for this session' } }
      return { status: 200, body: snap }
    }, apiToken),

    'POST /sessions/:id/goal/resume': withAuth((_body, params) => {
      const snap = manager.resumeGoal(params!.id!)
      if (!snap) return { status: 404, body: { error: 'No paused goal to resume' } }
      return { status: 200, body: snap }
    }, apiToken),

    'POST /sessions/:id/goal/cancel': withAuth(async (_body, params) => {
      const snap = await manager.cancelGoal(params!.id!)
      if (!snap) return { status: 404, body: { error: 'No active goal for this session' } }
      return { status: 200, body: snap }
    }, apiToken),

    // Plan list — this session's plans (newest first), summary only (no content).
    'GET /sessions/:id/plans': withAuth(async (_body, params) => {
      const plans = await manager.listPlans(params!.id!)
      if (!plans) return { status: 404, body: { error: 'Session not found' } }
      // Active plan-mode draft rides along so the desktop can render a live
      // "起草中" view — it is deliberately NOT part of `plans` (drafts are
      // working files, not submitted plans).
      const draft = (await manager.readPlanDraft(params!.id!)) ?? null
      return { status: 200, body: { plans: plans.map(planSummary), draft } }
    }, apiToken),

    // Plan read — full markdown content for one plan.
    'GET /sessions/:id/plans/:slug': withAuth(async (_body, params) => {
      const plan = await manager.readPlan(params!.id!, decodeSlug(params!.slug!))
      if (plan === undefined) return { status: 404, body: { error: 'Session not found' } }
      if (!plan) return { status: 404, body: { error: 'Plan not found' } }
      return { status: 200, body: { plan } }
    }, apiToken),

    // Plan edit — replace a submitted plan's markdown before approval
    // (desktop review → tweak → Build loop; Cursor 3.0 parity).
    'PUT /sessions/:id/plans/:slug': withAuth(async (body, params) => {
      const data = (body ?? {}) as { content?: string }
      if (typeof data.content !== 'string') {
        return { status: 400, body: { error: 'Missing "content" string' } }
      }
      const outcome = await manager.updatePlan(params!.id!, decodeSlug(params!.slug!), data.content)
      if (!outcome.ok) {
        const status =
          outcome.code === 'session-missing' || outcome.code === 'plan-not-found' ? 404
          : outcome.code === 'empty-content' ? 400
          : 409
        return { status, body: { error: outcome.reason, code: outcome.code } }
      }
      return { status: 200, body: { ok: true } }
    }, apiToken),

    // Build — approve a plan (shared guard kernel: content validation + anchor
    // drift recheck) and inject the wave-execution kickoff as the next turn.
    'POST /sessions/:id/plans/:slug/approve': withAuth(async (body, params) => {
      const data = (body ?? {}) as { selectedApproach?: string }
      const selectedApproach = typeof data.selectedApproach === 'string' && data.selectedApproach.trim()
        ? data.selectedApproach.trim()
        : undefined
      const outcome = await manager.approvePlan(params!.id!, decodeSlug(params!.slug!), selectedApproach)
      if (!outcome.ok) {
        const status =
          outcome.code === 'session-missing' || outcome.code === 'plan-not-found' ? 404
          : outcome.code === 'invalid-content' ? 422
          : 409
        return { status, body: { error: outcome.reason, code: outcome.code } }
      }
      return { status: 200, body: { ok: true } }
    }, apiToken),

    // Reject — mark a plan rejected (kept on disk) with optional revision feedback.
    'POST /sessions/:id/plans/:slug/reject': withAuth(async (body, params) => {
      const data = (body ?? {}) as { comment?: string }
      const ok = await manager.rejectPlan(params!.id!, decodeSlug(params!.slug!), data.comment)
      if (!ok) return { status: 404, body: { error: 'Session or plan not found' } }
      return { status: 200, body: { ok: true } }
    }, apiToken),

    // Goal 倒计时自动批准 — 显式取消（桌面「查看计划」= 用户参与，停止自动批准）。
    'POST /sessions/:id/plans/:slug/auto-approve/cancel': withAuth((_body, params) => {
      if (!manager.cancelPlanAutoApproveForUser(params!.id!)) {
        return { status: 404, body: { error: 'Session not found' } }
      }
      return { status: 200, body: { ok: true } }
    }, apiToken),

    // ── PlusMenu: model picker ──
    // Read — selectable models across all providers, current one flagged.
    'GET /sessions/:id/models': withAuth((_body, params) => {
      const models = manager.listModels(params!.id!)
      if (!models) return { status: 404, body: { error: 'Session not found' } }
      return { status: 200, body: { models } }
    }, apiToken),

    // Write — hot-switch the session's model (preserves history). Non-running only.
    'POST /sessions/:id/model': withAuth(async (body, params) => {
      const data = (body ?? {}) as { modelId?: unknown }
      if (typeof data.modelId !== 'string' || !data.modelId.trim()) {
        return { status: 400, body: { error: 'Missing or invalid "modelId"' } }
      }
      const modelId = data.modelId.trim()
      if (!(await manager.switchModel(params!.id!, modelId))) {
        // A1（2026-09-07 审查）：switchModel 在 session missing/running 时直接
        // return false（session-manager 早退，不触碰模型解析）——此前无条件
        // classify 附因会把用户引向查 key/模型配置，而实际原因是会话状态
        // （86f50cd21 接线缺陷）。分流见 describeModelSwitchFailure。
        const rec = manager.getSession(params!.id!)
        return { status: 409, body: { error: describeModelSwitchFailure(rec, config, modelId, dependencies.reloadConfig) } }
      }
      return { status: 200, body: manager.getSession(params!.id!) }
    }, apiToken),

    // ── PlusMenu: star-domain picker ──
    // Read — Auto / domains, current selection flagged (shared builder).
    'GET /sessions/:id/domains': withAuth((_body, params) => {
      const entries = manager.listDomains(params!.id!)
      if (!entries) return { status: 404, body: { error: 'Session not found' } }
      return { status: 200, body: { entries } }
    }, apiToken),

    // Write — set the session's star domain by key (auto | off | <domainId>).
    'POST /sessions/:id/domain': withAuth((body, params) => {
      const data = (body ?? {}) as { key?: unknown }
      if (typeof data.key !== 'string' || !data.key.trim()) {
        return { status: 400, body: { error: 'Missing or invalid "key"' } }
      }
      const session = manager.getSession(params!.id!)
      if (!session) {
        return { status: 404, body: { error: 'Session not found' } }
      }
      if (session.status === 'running') {
        return { status: 409, body: { error: 'Cannot switch domain while session is running' } }
      }
      if (!manager.setDomain(params!.id!, data.key.trim())) {
        return { status: 404, body: { error: 'Unknown domain key' } }
      }
      return { status: 200, body: { id: params!.id!, domain: data.key.trim() } }
    }, apiToken),

    // ── PlusMenu: skills toggle ──
    // Read — every loaded skill with its per-session enablement status.
    'GET /sessions/:id/skills': withAuth((_body, params) => {
      const skills = manager.listSkills(params!.id!)
      if (!skills) return { status: 404, body: { error: 'Session not found' } }
      // loadErrors: skills that failed to parse from .rivet/skills at session
      // create (e.g. a malformed installed Claude skill) — so the UI can show
      // them instead of leaving the user wondering why an "installed" skill
      // never appears in the list.
      const loadErrors = manager.getSkillLoadErrors(params!.id!) ?? []
      return { status: 200, body: { skills, loadErrors } }
    }, apiToken),

    // Write — enable/disable a skill for this session (affects discovery block).
    'POST /sessions/:id/skills': withAuth((body, params) => {
      const data = (body ?? {}) as { name?: unknown; enabled?: unknown }
      if (typeof data.name !== 'string' || !data.name.trim()) {
        return { status: 400, body: { error: 'Missing or invalid "name"' } }
      }
      if (typeof data.enabled !== 'boolean') {
        return { status: 400, body: { error: 'Missing or invalid "enabled" (boolean)' } }
      }
      if (!manager.setSkillEnabled(params!.id!, data.name.trim(), data.enabled)) {
        return { status: 404, body: { error: 'Session not found' } }
      }
      return { status: 200, body: { id: params!.id!, name: data.name.trim(), enabled: data.enabled } }
    }, apiToken),

    // ── PlusMenu: review gate（会话级自动审查门开关）──
    // Read — 当前模式（override > live refs > 配置默认）。
    'GET /sessions/:id/review-gate': withAuth((_body, params) => {
      const mode = manager.getReviewGate(params!.id!)
      if (mode === undefined) return { status: 404, body: { error: 'Session not found' } }
      return { status: 200, body: { id: params!.id!, mode } }
    }, apiToken),

    // Write — auto=恢复系统自动审查；off=抑制自动审查省 token（手动 /review 不受影响，
    // 交付门的测试/验证/提交环节不受影响）。
    'POST /sessions/:id/review-gate': withAuth((body, params) => {
      const data = (body ?? {}) as { mode?: unknown }
      if (data.mode !== 'auto' && data.mode !== 'off') {
        return { status: 400, body: { error: 'Missing or invalid "mode" ("auto" | "off")' } }
      }
      if (!manager.setReviewGate(params!.id!, data.mode)) {
        return { status: 404, body: { error: 'Session not found' } }
      }
      return { status: 200, body: { id: params!.id!, mode: data.mode } }
    }, apiToken),

    // ── Skills install (from .claude/skills) ──
    // Read — candidates installable from project/global .claude/skills.
    'GET /sessions/:id/skills/installable': withAuth((_body, params) => {
      const skills = manager.listInstallableSkills(params!.id!)
      if (!skills) return { status: 404, body: { error: 'Session not found' } }
      const installedCount = manager.installedSkillCount(params!.id!) ?? 0
      return { status: 200, body: { skills, installedCount, recommendedMax: RECOMMENDED_MAX_SKILLS } }
    }, apiToken),

    // Write — copy the named skills into .rivet/skills (no hot-load; takes effect
    // on next session). Returns { copied, skipped, errors }.
    'POST /sessions/:id/skills/install': withAuth((body, params) => {
      const data = (body ?? {}) as { names?: unknown }
      if (!Array.isArray(data.names) || data.names.some((n) => typeof n !== 'string' || !n.trim())) {
        return { status: 400, body: { error: 'Missing or invalid "names" (non-empty string array)' } }
      }
      const names = (data.names as string[]).map((n) => n.trim())
      if (names.length === 0) {
        return { status: 400, body: { error: 'Missing or invalid "names" (non-empty string array)' } }
      }
      const result = manager.installSkills(params!.id!, names)
      if (!result) return { status: 404, body: { error: 'Session not found' } }
      return { status: 200, body: result }
    }, apiToken),

    // ── Skills CRUD (desktop editor) ──
    // Read the full SKILL.md text for the editor. { content: null } for
    // built-in / plugin skills (no editable backing file) so the UI shows a
    // read-only notice instead of an empty editor.
    'GET /sessions/:id/skills/:name/content': withAuth((_body, params) => {
      const content = manager.readSkillContent(params!.id!, params!.name!)
      if (content === undefined) return { status: 404, body: { error: 'Session not found' } }
      return { status: 200, body: { content } }
    }, apiToken),

    // Write (create or overwrite) a skill. body: { content, scope? }. Throws →
    // 400 on malformed frontmatter. Same no-hot-load contract as install.
    'PUT /sessions/:id/skills/:name': withAuth((body, params) => {
      const data = (body ?? {}) as { content?: unknown; scope?: unknown }
      if (typeof data.content !== 'string' || !data.content.trim()) {
        return { status: 400, body: { error: 'Missing "content" (non-empty SKILL.md text)' } }
      }
      const scope = data.scope === 'global' ? 'global' : 'project'
      try {
        const result = manager.writeSkill(params!.id!, params!.name!, data.content, scope)
        if (!result) return { status: 404, body: { error: 'Session not found' } }
        return { status: 200, body: { name: params!.name!, path: result.path, scope } }
      } catch (e) {
        return { status: 400, body: { error: e instanceof Error ? e.message : String(e) } }
      }
    }, apiToken),

    // Uninstall a project-scoped skill (delete from .rivet/skills). 409 for
    // built-in / plugin / global skills the project panel can't remove.
    'DELETE /sessions/:id/skills/:name': withAuth((_body, params) => {
      const result = manager.uninstallSkill(params!.id!, params!.name!)
      if (result === undefined) return { status: 404, body: { error: 'Session not found' } }
      if (!result.removed) return { status: 409, body: { error: 'Cannot remove built-in/plugin/global skill from the project panel' } }
      return { status: 200, body: { name: params!.name!, removed: true } }
    }, apiToken),

    'GET /sessions': withAuth((_body, params) => {
      const includeArchived = params?.includeArchived === 'true'
      const sessions = includeArchived
        ? manager.listAllSessions()
        : manager.listSessions()
      return { status: 200, body: { sessions } }
    }, apiToken),

    // Cross-session content search — scans active sessions' agent transcripts
    // for user/assistant text. Exact route, so it is matched before the
    // parameterized GET /sessions/:id. Read-only, Bearer-gated.
    'GET /sessions/search': withAuth(async (_body, params, _headers, res) => {
      const q = typeof params?.q === 'string' ? params.q.trim() : ''
      if (q.length < 2) {
        return { status: 400, body: { error: 'Query "q" must be at least 2 characters' } }
      }
      const abortController = new AbortController()
      const abortSearch = () => abortController.abort()
      if (res?.destroyed) abortSearch()
      else res?.once('close', abortSearch)
      try {
        const { results, metadata } = await searchTranscripts(
          manager.listSessions(),
          q,
          { signal: abortController.signal },
        )
        return { status: 200, body: { results, meta: metadata } }
      } finally {
        res?.removeListener('close', abortSearch)
      }
    }, apiToken),

    // Archive (soft-close) a session. Aborts if running, marks archived, hides
    // from listSessions. Data survives on disk for potential recovery.
    'DELETE /sessions/:id': withAuth((_body, params) => {
      if (!manager.archiveSession(params!.id!)) {
        return { status: 404, body: { error: 'Session not found or already archived' } }
      }
      return { status: 200, body: { archived: true } }
    }, apiToken),

    // Restore a previously archived session back to the active list.
    'POST /sessions/:id/unarchive': withAuth((_body, params) => {
      if (!manager.unarchiveSession(params!.id!)) {
        return { status: 404, body: { error: 'Session not found or not archived' } }
      }
      return { status: 200, body: { archived: false } }
    }, apiToken),

    // Rename a session (title only). Empty title clears it.
    'PATCH /sessions/:id': withAuth((body, params) => {
      const data = (body ?? {}) as { title?: unknown }
      if (typeof data.title !== 'string') {
        return { status: 400, body: { error: 'Missing or invalid "title"' } }
      }
      if (!manager.setTitle(params!.id!, data.title)) {
        return { status: 404, body: { error: 'Session not found' } }
      }
      return { status: 200, body: { id: params!.id!, title: data.title } }
    }, apiToken),

    // Permanently delete an archived session. Active/running sessions are refused.
    'DELETE /sessions/:id/permanent': withAuth((_body, params) => {
      const result = manager.deleteSession(params!.id!)
      if (!result.ok) {
        return { status: 409, body: { error: 'Session not found, not archived, or still running' } }
      }
      return { status: 200, body: { deleted: true, freedBytes: result.freedBytes } }
    }, apiToken),

    // Storage usage report — total/archived bytes + per-archived-session sizes.
    // Stat-based (no event-log reads), safe to poll from the settings UI.
    'GET /storage': withAuth(() => {
      return { status: 200, body: manager.storageReport() }
    }, apiToken),

    // Manual cleanup — irreversibly delete archived sessions' files. Body:
    //   { ids?: string[] }          → delete exactly these (must be archived)
    //   { olderThanDays?: number }  → keep only archived idle for ≥ N days
    //   {}                          → delete ALL archived
    // Active/running sessions are never affected (manager enforces this).
    'POST /storage/cleanup': withAuth((body) => {
      const data = (body ?? {}) as { ids?: unknown; olderThanDays?: unknown }
      const opts: { ids?: string[]; olderThanMs?: number } = {}
      if (Array.isArray(data.ids)) {
        opts.ids = data.ids.filter((x): x is string => typeof x === 'string')
      }
      if (typeof data.olderThanDays === 'number' && data.olderThanDays >= 0) {
        opts.olderThanMs = data.olderThanDays * 86_400_000
      }
      return { status: 200, body: manager.purgeArchived(opts) }
    }, apiToken),

    'GET /sessions/:id': withAuth((_body, params) => {
      const rec = manager.getSession(params!.id!)
      if (!rec) return { status: 404, body: { error: 'Session not found' } }
      return { status: 200, body: rec }
    }, apiToken),

    // /handoff（桌面 plus 面板入口）——登记归档任务后发起交接 run：
    // agent 写项目内 .rivet/HANDOFF.md，run 收尾自动归档 <id>.handoff.md
    // （loadPrevHandoff 注入管线认的位置，与 TUI /handoff 同语义）。
    'POST /sessions/:id/handoff': withAuth((body, params) => {
      const data = (body ?? {}) as { note?: unknown }
      const note = typeof data.note === 'string' && data.note.trim() ? data.note.trim() : undefined
      const res = manager.requestHandoff(params!.id!, note)
      if (!res.ok) {
        const status = res.error === 'Session not found' ? 404 : 409
        return { status, body: { error: res.error } }
      }
      return { status: 200, body: manager.getSession(params!.id!) }
    }, apiToken),

    'POST /sessions/:id/prompt': withAuth(async (body, params) => {
      const data = (body ?? {}) as { prompt?: string; images?: unknown; documents?: unknown }
      if (!data.prompt || typeof data.prompt !== 'string' || !data.prompt.trim()) {
        return { status: 400, body: { error: 'Missing or empty "prompt" field' } }
      }
      // Validate images: array of provider-safe base64 data URLs (shared helper,
      // same rules as POST /sessions create-with-images).
      const imagesCheck = validateImagesPayload(data.images)
      if (imagesCheck.error) {
        return { status: 400, body: { error: imagesCheck.error } }
      }
      const images = imagesCheck.images

      // Validate documents: array of { name, dataUrl } for office/pdf files.
      // Server extracts text via doc-extract (pdftotext/textutil/soffice/exceljs)
      // and prepends to prompt — same injection pattern as the vision bridge.
      let documents: Array<{ name: string; dataUrl: string }> | undefined
      if (data.documents !== undefined) {
        if (!Array.isArray(data.documents) || data.documents.length === 0) {
          return { status: 400, body: { error: '"documents" must be a non-empty array' } }
        }
        if (data.documents.length > MAX_DOCUMENTS) {
          return { status: 400, body: { error: `Max ${MAX_DOCUMENTS} documents allowed` } }
        }
        for (const doc of data.documents) {
          if (typeof doc !== 'object' || doc === null || typeof (doc as { name?: unknown }).name !== 'string' || typeof (doc as { dataUrl?: unknown }).dataUrl !== 'string') {
            return { status: 400, body: { error: 'Each document must be { name: string, dataUrl: string }' } }
          }
          const dataUrl = (doc as { dataUrl: string }).dataUrl
          if (decodedBase64Bytes(dataUrl) > MAX_DOCUMENT_BYTES) {
            return { status: 400, body: { error: `Each document must be <= ${Math.round(MAX_DOCUMENT_BYTES / 1024 / 1024)}MB` } }
          }
        }
        documents = data.documents as Array<{ name: string; dataUrl: string }>
      }

      // Slash 翻译层（对齐 TUI 端 resolveAppPromptInput 行为）。
      // 桌面 PlusMenu 命令是写死人话经 onSend 发送；自由文本输入若以 "/" 起头，
      // 这里负责把 /plan /team /council /review /write-plan /plan-close 等
      // ecosystem 命令翻译成结构化 prompt，自定义命令也走 .rivet/commands/。
      // 未识别 slash → 4xx 友好提示（与 TUI rejectSubmit 行为对齐，避免凭空丢失消息）。
      let prompt = data.prompt
      const trimmed = prompt.trim()
      if (trimmed.startsWith('/')) {
        const record = manager.getSession(params!.id!)
        if (record) {
          const knownCmds = new Set(getPaletteCommands()
            .filter(c => c.name.startsWith('/'))
            .map(c => c.name.slice(1).split(/\s/)[0]!))
          const resolved = resolveAppPromptInput(trimmed, record.cwd, (name) => knownCmds.has(name))
          if (resolved === null) {
            const first = trimmed.split(/\s+/)[0]
            return {
              status: 400,
              body: { error: `Unknown slash command: "${first}". Type a normal message or use the command menu (+).` },
            }
          }
          prompt = resolved.prompt
          // 桌面端也需挂载 workflow 声明的 EXTENDED 工具（与 TUI main.ts 对齐）。
          for (const toolName of resolved.requiredTools ?? []) {
            await manager.enableTool(params!.id!, toolName)
          }
        }
      }

      // @Computer 提及 → run 前挂载 computer_use（EXTENDED 层，默认不进主控视野）。
      // 缓存纪律：走既有 enableTool 边界挂载机制，边界一次性 miss 已有提示；
      // 非 darwin 平台工具未注册，enableTool 静默 no-op。
      if (/@computer\b/i.test(prompt)) {
        await manager.enableTool(params!.id!, 'computer_use')
      }

      // 文档附件：落盘 → extractDocumentText 抽取文本 → 前置进 prompt。
      // session-manager.run 是同步入口，抽取是异步——故在 route 层（async handler）
      // 完成抽取，拼进 prompt 后调 run（签名不变）。和 vision bridge 同模式：
      // 把非文本附件转成文本注入 prompt。
      if (documents && documents.length > 0) {
        const docTexts = await extractDocumentsToText(documents)
        if (docTexts) {
          prompt = `${docTexts}\n\n${prompt}`
        }
      }

      const ok = manager.run(params!.id!, prompt, images)
      // 区分两种拒绝：session 缺失（404，前端可提示重新打开）与执行中（409 busy，
      // 前端显示"正在执行中"而非错误 toast——用户连续发消息时这是正常排队语义）。
      if (!ok) {
        if (!manager.getSession(params!.id!)) {
          return { status: 404, body: { error: 'Session not found' } }
        }
        return { status: 409, body: { error: 'Session is already running', code: 'busy' } }
      }
      return { status: 200, body: manager.getSession(params!.id!) }
    }, apiToken),

    // Phase 3 可靠性 — 一键续跑（resume_offer 卡片的服务端入口）。
    // 缓存亲和：原模型不可用 → 兜底模型；兜底也不可用 → 默认模型显式降级
    // （body 带 degraded/warning，UI 给出「前缀缓存重建」提示而非死路）。
    'POST /sessions/:id/resume': withAuth(async (_body, params) => {
      const result = await manager.resumeRun(params!.id!)
      if (!result.ok) {
        const status = result.code === 'not_found' ? 404 : 409
        return { status, body: { error: result.error, code: result.code } }
      }
      return {
        status: 200,
        body: {
          resumed: true,
          model: result.model,
          switched: result.switched,
          degraded: result.degraded ?? false,
          warning: result.warning,
        },
      }
    }, apiToken),

    // T3 — mid-run steering. Queues user guidance into a RUNNING session's steer
    // buffer; injected at the next tool boundary (no new turn). Idle → 409 so the
    // desktop knows to use /prompt instead. Bearer-gated.
    // Phase 2 — body 也可为 { laneId }：把 queue lane 里仍 queued 的条目升级为
    // steer（立即参与本轮 mid-turn 注入）。
    'POST /sessions/:id/steer': withAuth((body, params) => {
      const data = (body ?? {}) as { text?: string; laneId?: string }
      const laneId = typeof data.laneId === 'string' && data.laneId.trim() ? data.laneId.trim() : undefined
      const text = typeof data.text === 'string' && data.text.trim() ? data.text.trim() : undefined
      if (!laneId && !text) {
        return { status: 400, body: { error: 'Missing or empty "text" field (or provide "laneId" to upgrade a queued entry)' } }
      }
      const result = laneId
        ? manager.steer(params!.id!, { laneId })
        : manager.steer(params!.id!, text!)
      if (result === 'not_found') return { status: 404, body: { error: 'Session not found' } }
      if (result === 'lane_not_found') return { status: 404, body: { error: 'Queue lane entry not found' } }
      if (result === 'idle') {
        return { status: 409, body: { error: 'Session is not running; use /prompt to start a turn' } }
      }
      if (result === 'lane_not_queued') {
        return { status: 409, body: { error: 'Queue lane entry is no longer queued (steered/retracted/merged)' } }
      }
      return { status: 200, body: { queued: true } }
    }, apiToken),

    // Phase 2 queue lane — busy 期间排队跟进消息（不注入本轮）：下次 prompt 时
    // 归并进消息前部，或经 /steer { laneId } 升级、/queue/retract 撤回。
    // 与 /steer 同门槛：idle → 409。Bearer-gated。
    'POST /sessions/:id/queue': withAuth((body, params) => {
      const data = (body ?? {}) as { text?: string }
      if (!data.text || typeof data.text !== 'string' || !data.text.trim()) {
        return { status: 400, body: { error: 'Missing or empty "text" field' } }
      }
      const result = manager.queue(params!.id!, data.text.trim())
      if (result === 'not_found') return { status: 404, body: { error: 'Session not found' } }
      if (result === 'idle') {
        return { status: 409, body: { error: 'Session is not running; use /prompt to start a turn' } }
      }
      return { status: 200, body: { queued: true, laneId: result.laneId } }
    }, apiToken),

    // Phase 2 — 撤回一条仍 queued 的 queue lane 条目。
    'POST /sessions/:id/queue/retract': withAuth((body, params) => {
      const data = (body ?? {}) as { laneId?: string }
      if (!data.laneId || typeof data.laneId !== 'string' || !data.laneId.trim()) {
        return { status: 400, body: { error: 'Missing or empty "laneId" field' } }
      }
      const result = manager.retractQueued(params!.id!, data.laneId.trim())
      if (result === 'not_found') return { status: 404, body: { error: 'Session not found' } }
      if (result === 'lane_not_found') return { status: 404, body: { error: 'Queue lane entry not found' } }
      if (result === 'lane_not_queued') {
        return { status: 409, body: { error: 'Queue lane entry is no longer queued (steered/retracted/merged)' } }
      }
      return { status: 200, body: { ok: true } }
    }, apiToken),

    'POST /sessions/:id/abort': withAuth((_body, params) => {
      const ok = manager.abort(params!.id!)
      if (!ok) return { status: 404, body: { error: 'Session not found' } }
      return { status: 200, body: { aborted: true } }
    }, apiToken),

    'GET /sessions/:id/events': withAuth(async (_body, params) => {
      // 冷通道分支（?before=N&limit=M）：绕过内存环直读磁盘，分页回填被
      // 环截掉的头部历史。turn 边界对齐由 getHistoryPage 保证。
      const before = Number(params?.before ?? 0) || 0
      if (before > 0) {
        const limit = Math.min(Math.max(Number(params?.limit ?? 200) || 200, 1), 2000)
        const page = await manager.getHistoryPage(params!.id!, before, limit)
        if (!page) return { status: 404, body: { error: 'Session not found' } }
        return { status: 200, body: page }
      }
      const since = Number(params?.since ?? 0) || 0
      // Async replay: first open of a lazily-rehydrated session reads the log
      // off the main thread instead of stalling every other request on it.
      const result = await manager.getEventsAsync(params!.id!, since)
      if (!result) return { status: 404, body: { error: 'Session not found' } }
      return { status: 200, body: result }
    }, apiToken),

    // Worker log — 失败钻取(W2):活动流 + 终态结果 + 转录尾部。
    // ?full=1 拉完整转录(不截 50 条尾部,正文上限放宽,工具帧带参数摘要)。
    'GET /sessions/:id/workers/:workerId/log': withAuth(async (_body, params) => {
      const log = await manager.getWorkerLog(params!.id!, decodeURIComponent(params!.workerId!), {
        full: params?.full === '1',
      })
      if (!log) return { status: 404, body: { error: 'Session not found' } }
      return { status: 200, body: log }
    }, apiToken),

    // Insights — aggregated token usage, cost, and per-worker/model/provider
    // breakdowns derived from delegation events. Bearer-gated.
    // Cockpit snapshot — aggregated runtime state (safety/verify/context/model)
    // for the desktop cockpit panel. Reads agent in-memory state via the pure
    // buildCockpitSnapshot function (same source as the TUI /cockpit command).
    'GET /sessions/:id/cockpit': withAuth((_body, params) => {
      const agent = manager.getAgentForSession(params!.id!)
      if (!agent) return { status: 404, body: { error: 'Session agent not built yet' } }
      const snap = agent.getCockpitSnapshot?.()
      if (!snap) return { status: 503, body: { error: 'Cockpit unavailable (agent mid-rebuild?)' } }
      return { status: 200, body: snap }
    }, apiToken),

    // 识图桥真实状态：active/source/detail。桌面端据此显示准确提示，而非只凭
    // config 有没有 visionModel 键去猜（"配了却报图片未发送"的显示层根因）。
    // 依赖当前会话模型，故必须走活 agent。
    'GET /sessions/:id/vision-bridge': withAuth((_body, params) => {
      const agent = manager.getAgentForSession(params!.id!)
      if (!agent) return { status: 404, body: { error: 'Session agent not built yet' } }
      const status = agent.getVisionBridge?.() ?? { active: false, source: 'none' as const, detail: '状态不可用' }
      return { status: 200, body: status }
    }, apiToken),

    'GET /sessions/:id/insights': withAuth(async (_body, params) => {
      const id = params!.id!
      const rec = manager.getSession(id)
      if (!rec) return { status: 404, body: { error: 'Session not found' } }
      // 全历史读取（Phase 2）：磁盘直读越过内存环截尾，统计覆盖完整会话。
      const events = await manager.getAllEventsAsync(id)
      if (!events) return { status: 404, body: { error: 'Session not found' } }

      const providers = config?.provider.providers ?? {}
      const workers = new Map<string, {
        workerId: string
        parentId?: string
        profile?: string
        status?: string
        model?: string
        provider?: string
        objective?: string
        elapsedMs?: number
        inputTokens: number
        outputTokens: number
        cacheReadTokens: number
        cacheWriteTokens: number
        reasoningTokens: number
        totalTokens: number
        cost: number
      }>()
      const modelTotals = new Map<string, { model: string; provider?: string; inputTokens: number; outputTokens: number; totalTokens: number; cost: number; count: number }>()
      const providerTotals = new Map<string, { provider: string; inputTokens: number; outputTokens: number; totalTokens: number; cost: number; count: number }>()

      // Main session turn-level usage (turn_complete events).
      let mainInput = 0
      let mainOutput = 0
      let mainCacheRead = 0
      let mainCacheWrite = 0
      let mainReasoning = 0
      const mainModel = rec.model

      for (const ev of events.events) {
        if (ev.type === 'turn_complete') {
          const data = ev.data as { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; reasoning_tokens?: number } }
          if (data.usage) {
            mainInput += data.usage.input_tokens ?? 0
            mainOutput += data.usage.output_tokens ?? 0
            mainCacheRead += data.usage.cache_read_input_tokens ?? 0
            mainCacheWrite += data.usage.cache_creation_input_tokens ?? 0
            mainReasoning += data.usage.reasoning_tokens ?? 0
          }
          continue
        }
        if (ev.type !== 'delegation') continue
        const data = ev.data as {
          workerId?: string
          parentId?: string
          profile?: string
          status?: string
          objective?: string
          elapsedMs?: number
          model?: string
          provider?: string
          usage?: {
            input_tokens?: number
            output_tokens?: number
            cache_read_input_tokens?: number
            cache_creation_input_tokens?: number
            reasoning_tokens?: number
            total_tokens?: number
          }
        }
        const workerId = data.workerId
        if (!workerId) continue

        const usage = data.usage
        const model = data.model
        const provider = data.provider
        const pricing = findModelPricing(providers, provider, model)
        const costBreakdown = computeUsageCost(
          usage
            ? {
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                cache_read_input_tokens: usage.cache_read_input_tokens,
                cache_creation_input_tokens: usage.cache_creation_input_tokens,
                reasoning_tokens: usage.reasoning_tokens,
              }
            : undefined,
          pricing,
        )

        const inputTokens = usage?.input_tokens ?? 0
        const outputTokens = usage?.output_tokens ?? 0
        const cacheReadTokens = usage?.cache_read_input_tokens ?? 0
        const cacheWriteTokens = usage?.cache_creation_input_tokens ?? 0
        const reasoningTokens = usage?.reasoning_tokens ?? 0
        const totalTokens = usage?.total_tokens ?? inputTokens + outputTokens

        const existing = workers.get(workerId)
        const worker = {
          workerId,
          parentId: data.parentId ?? existing?.parentId,
          profile: data.profile ?? existing?.profile,
          status: data.status ?? existing?.status,
          model: model ?? existing?.model,
          provider: provider ?? existing?.provider,
          objective: data.objective ?? existing?.objective,
          elapsedMs: data.elapsedMs ?? existing?.elapsedMs,
          inputTokens: (existing?.inputTokens ?? 0) + inputTokens,
          outputTokens: (existing?.outputTokens ?? 0) + outputTokens,
          cacheReadTokens: (existing?.cacheReadTokens ?? 0) + cacheReadTokens,
          cacheWriteTokens: (existing?.cacheWriteTokens ?? 0) + cacheWriteTokens,
          reasoningTokens: (existing?.reasoningTokens ?? 0) + reasoningTokens,
          totalTokens: (existing?.totalTokens ?? 0) + totalTokens,
          cost: (existing?.cost ?? 0) + costBreakdown.total,
        }
        workers.set(workerId, worker)

        if (model) {
          const mt = modelTotals.get(model) ?? { model, provider, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, count: 0 }
          mt.inputTokens += inputTokens
          mt.outputTokens += outputTokens
          mt.totalTokens += totalTokens
          mt.cost += costBreakdown.total
          mt.count += 1
          if (provider && !mt.provider) mt.provider = provider
          modelTotals.set(model, mt)
        }
        if (provider) {
          const pt = providerTotals.get(provider) ?? { provider, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, count: 0 }
          pt.inputTokens += inputTokens
          pt.outputTokens += outputTokens
          pt.totalTokens += totalTokens
          pt.cost += costBreakdown.total
          pt.count += 1
          providerTotals.set(provider, pt)
        }
      }

      const workerList = [...workers.values()]
      const workerInput = workerList.reduce((sum, w) => sum + w.inputTokens, 0)
      const workerOutput = workerList.reduce((sum, w) => sum + w.outputTokens, 0)
      const workerCacheRead = workerList.reduce((sum, w) => sum + w.cacheReadTokens, 0)
      const workerCacheWrite = workerList.reduce((sum, w) => sum + w.cacheWriteTokens, 0)
      const workerReasoning = workerList.reduce((sum, w) => sum + w.reasoningTokens, 0)
      const workerTotalTokens = workerList.reduce((sum, w) => sum + w.totalTokens, 0)
      const workerCost = workerList.reduce((sum, w) => sum + w.cost, 0)

      // Main session cost — resolve provider from model id, compute USD cost.
      const mainTotalTokens = mainInput + mainOutput
      const mainProvider = mainModel
        ? Object.entries(providers).find(([, p]) =>
            p.models?.some(m => m.id === mainModel || m.alias === mainModel),
          )?.[0]
        : undefined
      const mainPricing = findModelPricing(providers, mainProvider, mainModel)
      const mainCostBreakdown = computeUsageCost(
        mainTotalTokens > 0
          ? {
              input_tokens: mainInput,
              output_tokens: mainOutput,
              cache_read_input_tokens: mainCacheRead,
              cache_creation_input_tokens: mainCacheWrite,
              reasoning_tokens: mainReasoning,
            }
          : undefined,
        mainPricing,
      )

      const mainSession = mainTotalTokens > 0 ? {
        inputTokens: mainInput,
        outputTokens: mainOutput,
        cacheReadTokens: mainCacheRead,
        cacheWriteTokens: mainCacheWrite,
        reasoningTokens: mainReasoning,
        totalTokens: mainTotalTokens,
        model: mainModel,
        provider: mainProvider,
        cost: mainCostBreakdown.total,
      } : null

      const totalCacheRead = workerCacheRead + (mainSession?.cacheReadTokens ?? 0)
      const totalCacheWrite = workerCacheWrite + (mainSession?.cacheWriteTokens ?? 0)
      const cacheHitRate = totalCacheRead + totalCacheWrite > 0
        ? Math.round((totalCacheRead / (totalCacheRead + totalCacheWrite)) * 100)
        : null

      return {
        status: 200,
        body: {
          totals: {
            workers: workers.size,
            inputTokens: workerInput + (mainSession?.inputTokens ?? 0),
            outputTokens: workerOutput + (mainSession?.outputTokens ?? 0),
            cacheReadTokens: totalCacheRead,
            cacheWriteTokens: totalCacheWrite,
            reasoningTokens: workerReasoning + (mainSession?.reasoningTokens ?? 0),
            totalTokens: workerTotalTokens + (mainSession?.totalTokens ?? 0),
            cost: workerCost + (mainSession?.cost ?? 0),
          },
          cacheHitRate,
          mainSession,
          workers: workerList,
          modelBreakdown: [...modelTotals.values()],
          providerBreakdown: [...providerTotals.values()],
        },
      }
    }, apiToken),

    // @file mention picker (D2) — enumerate project files under the session's
    // cwd, ranked by an optional ?q substring/fuzzy query. Scoped to cwd, never
    // follows symlinks, honors gitignore + silent-layer filters. Bearer-gated.
    'GET /sessions/:id/files': withAuth(async (_body, params) => {
      const rec = manager.getSession(params!.id!)
      if (!rec) return { status: 404, body: { error: 'Session not found' } }
      const q = typeof params?.q === 'string' ? params.q : ''
      const limit = Math.min(Math.max(Number(params?.limit ?? 50) || 50, 1), 200)
      const all = await listProjectFiles(rec.cwd)
      return { status: 200, body: { files: rankFiles(all, q, limit) } }
    }, apiToken),

    // P2-2 — file content viewer. Reads a file within the session cwd, returns
    // content + language hint. Path is sandboxed via validatePath. Optional
    // ?start=1&end=50 line range to avoid transferring huge files. Bearer-gated.
    'GET /sessions/:id/file-content': withAuth(async (_body, params) => {
      const rec = manager.getSession(params!.id!)
      if (!rec) return { status: 404, body: { error: 'Session not found' } }
      const relPath = typeof params?.path === 'string' ? params.path : ''
      if (!relPath) return { status: 400, body: { error: 'Missing "path" query param' } }

      let absPath: string
      try {
        absPath = validatePath(rec.cwd, relPath, 'read')
      } catch {
        return { status: 403, body: { error: 'Path outside session cwd' } }
      }

      let stat
      try {
        stat = statSync(absPath)
      } catch {
        return { status: 404, body: { error: 'File not found' } }
      }
      if (!stat.isFile()) return { status: 400, body: { error: 'Not a file' } }
      // Cap at 512KB to avoid sending huge files over IPC
      if (stat.size > 512 * 1024) return { status: 413, body: { error: 'File too large (>512KB)' } }

      const content = readFileSync(absPath, 'utf-8')
      const lines = content.split('\n')
      const start = Math.max(1, Number(params?.start) || 1)
      const end = Math.min(lines.length, Number(params?.end) || lines.length)
      const sliced = lines.slice(start - 1, end).join('\n')

      const ext = extname(absPath).slice(1).toLowerCase()
      const LANGUAGE_MAP: Record<string, string> = {
        ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
        py: 'python', rs: 'rust', go: 'go', rb: 'ruby', java: 'java',
        css: 'css', scss: 'scss', json: 'json', md: 'markdown', yml: 'yaml',
        yaml: 'yaml', sh: 'bash', bash: 'bash', sql: 'sql', html: 'html', xml: 'xml',
      }

      return {
        status: 200,
        body: {
          path: relative(rec.cwd, absPath),
          content: sliced,
          language: LANGUAGE_MAP[ext] ?? 'plaintext',
          totalLines: lines.length,
          startLine: start,
          endLine: end,
        },
      }
    }, apiToken),

    // Gap 1 — directory listing for the read-only file browser. Returns direct
    // children of a sub-directory within cwd (one level, not recursive).
    // ?path=src/components (empty/omitted = cwd root). Bearer-gated.
    'GET /sessions/:id/list-dir': withAuth(async (_body, params) => {
      const rec = manager.getSession(params!.id!)
      if (!rec) return { status: 404, body: { error: 'Session not found' } }
      const relPath = typeof params?.path === 'string' ? params.path : ''
      let absDir: string
      try {
        absDir = relPath ? validatePath(rec.cwd, relPath, 'read') : rec.cwd
      } catch {
        return { status: 403, body: { error: 'Path outside session cwd' } }
      }
      const entries = await listDirEntries(absDir)
      return { status: 200, body: { path: relPath, entries } }
    }, apiToken),

    'GET /sessions/:id/stream': withAuth(async (_body, params, headers, res) => {
      if (!res) return { status: 500, body: { error: 'SSE response stream is unavailable' } }
      const id = params!.id!
      const since = Number(params?.since ?? 0) || 0
      // E4 — optional clientId ties this SSE socket to delegate capabilities so
      // teardown (onDead / 'close') clears the slot and fail-backs in-flight landings.
      const clientId = typeof params?.clientId === 'string' ? params.clientId.trim() : ''
      // DEBUG instrumentation (RIVET_DEBUG_RENDER=1): splits /stream latency into
      // "history load" vs "headers flushed vs first event". See
      // docs/dev/render-debug-playbook.md §"骨架屏不消失/会话打开慢".
      const __dbg = process.env.RIVET_DEBUG_RENDER === '1'
      const __t0 = __dbg ? Date.now() : 0
      // Reconnect replay is the hot path for large logs — load it without
      // blocking the loop (async read + off-thread parse), so concurrent
      // streams keep their keepalives during someone else's big replay.
      const existing = await manager.getEventsAsync(id, since)
      if (__dbg) console.log(`[stream] getEventsAsync +${Date.now() - __t0}ms events=${existing?.events.length ?? 0} id=${id}`)
      if (!existing) return { status: 404, body: { error: 'Session not found' } }

      // Tear down BOTH on peer death (write throws → onDead) and on the normal
      // response 'close'. Without the onDead path a half-dead socket kept the
      // subscription + keepalive alive: every append still fanned out to a
      // stream that silently dropped it (viewer showed "live" with no events).
      let unsubscribe: (() => void) | undefined
      let keepalive: ReturnType<typeof setInterval> | undefined
      const cleanup = () => {
        if (keepalive) clearInterval(keepalive)
        keepalive = undefined
        unsubscribe?.()
        unsubscribe = undefined
      }
      const sse = new SseStream(res, cleanup, allowedCorsOrigin(headers ?? {}))
      // 冷热双通道：回放最前发 replay_window 合成元事件（不落盘、seq=0），
      // 告知前端本次回放窗口与磁盘完整范围——diskFirstSeq < floorSeq 时
      // 前端显示「加载更早的历史」，经 GET /events?before= 分页回填。
      const win = manager.getReplayWindow(id)
      if (win) {
        sse.send('replay_window', { seq: 0, ts: Date.now(), type: 'replay_window', data: win })
      }
      // 后台任务建连快照（seq=0 合成事件，同 replay_window 语义）：服务端权威
      // running 集。内存环截尾会丢掉长寿 job 的 started 事件（回放不到）、
      // sidecar 重启后注册表全空（本地仍挂着 running）——前端据此 upsert +
      // 摘除对账。空集也必须发：那正是「全部悬挂」的清场信号。时序竞争
      // （快照后 job 起/止）由其真实 seq 的生命周期事件在 gap/live 通道收敛。
      const runningJobs = manager.listJobs(id)?.filter((j) => j.status === 'running')
      if (runningJobs) {
        sse.send('job_snapshot', { seq: 0, ts: Date.now(), type: 'job_snapshot', data: { jobs: runningJobs } })
      }
      // Bound replay slices by both work count and elapsed time so slow
      // serialization/socket writes cannot monopolize the event loop.
      await sendReplayTimeSliced(res, sse, existing.events)
      let catchingUp = true
      let lastCatchupSeq = existing.lastSeq
      const deferredLive: Array<{ type: string; seq: number }> = []
      const sendCatchup = async (events: ReadonlyArray<{ type: string; seq: number }>) => {
        const unique: Array<{ type: string; seq: number }> = []
        for (const event of events) {
          if (event.seq <= lastCatchupSeq) continue
          unique.push(event)
          lastCatchupSeq = event.seq
        }
        await sendReplayTimeSliced(res, sse, unique)
      }
      unsubscribe = manager.subscribe(
        id,
        (ev) => {
          if (catchingUp) deferredLive.push(ev)
          else sse.send(ev.type, ev)
        },
        clientId ? { clientId } : undefined,
      )
      // The async replay above yields the loop, so events may have been
      // appended between the snapshot and the subscribe — back-fill them now.
      // Subscribe first, then defer listener fan-out while the gap is sent with
      // the same bounded sender. This preserves seq order even though gap replay
      // now yields: events arriving meanwhile drain immediately afterward.
      const gap = manager.getEvents(id, existing.lastSeq)
      if (gap) await sendCatchup(gap.events)
      while (deferredLive.length > 0 && !sse.isClosed()) {
        const batch = deferredLive.splice(0)
        await sendCatchup(batch)
      }
      catchingUp = false
      // A dead peer during the replay above means the subscription was created
      // after onDead already fired — close it out now instead of leaking it.
      if (sse.isClosed()) {
        cleanup()
        return { status: 200, handled: true }
      }
      // Keepalive: a 30s comment heartbeat stops idle proxies from reaping the
      // connection and detects a half-dead socket (write throws → sse closes).
      // unref so the timer never keeps the process (or a test) alive on its own.
      keepalive = setInterval(() => sse.ping(), 30_000)
      if (typeof keepalive.unref === 'function') keepalive.unref()
      res.on('close', () => {
        cleanup()
        sse.close()
      })
      return { status: 200, handled: true }
    }, apiToken),

    // E4 — register / heartbeat client landing capabilities (apply_edit, terminal_exec).
    'POST /sessions/:id/delegate-capabilities': withAuth((body, params) => {
      const data = (body ?? {}) as { clientId?: unknown; kinds?: unknown }
      if (typeof data.clientId !== 'string' || !data.clientId.trim()) {
        return { status: 400, body: { error: 'Missing or invalid "clientId"' } }
      }
      const kinds = parseDelegateKinds(data.kinds)
      if (!manager.registerDelegateCapabilities(params!.id!, data.clientId.trim(), kinds)) {
        return { status: 404, body: { error: 'Session not found' } }
      }
      return { status: 200, body: { ok: true, kinds, ttlMs: 60_000 } }
    }, apiToken),

    // E4 — client posts landing result (or reject with isError:false).
    'POST /sessions/:id/delegate/:requestId/result': withAuth((body, params) => {
      const data = (body ?? {}) as { content?: unknown; isError?: unknown; uiContent?: unknown; status?: unknown }
      if (typeof data.content !== 'string') {
        return { status: 400, body: { error: 'Missing or invalid "content" (string)' } }
      }
      const ok = manager.answerDelegation(params!.id!, params!.requestId!, {
        content: data.content,
        isError: data.isError === true,
        uiContent: typeof data.uiContent === 'string' ? data.uiContent : undefined,
        status: data.status === 'rejected' ? 'rejected' : data.status === 'ok' ? 'ok' : undefined,
      })
      if (!ok) {
        const rec = manager.getSession(params!.id!)
        if (!rec) return { status: 404, body: { error: 'Session not found' } }
        return { status: 409, body: { error: 'Delegation request gone (timed out or already resolved)' } }
      }
      return { status: 200, body: { ok: true } }
    }, apiToken),

    'POST /sessions/:id/interventions/:requestId/answer': withAuth((body, params) => {
      const data = (body ?? {}) as { decision?: string; editedInput?: Record<string, unknown>; remember?: boolean }
      const decision = data.decision ?? 'approve'
      const ok = manager.answerIntervention(
        params!.id!, params!.requestId!, decision, data.editedInput, data.remember === true,
      )
      if (!ok) return { status: 404, body: { error: 'Pending intervention not found' } }
      return { status: 200, body: { ok: true } }
    }, apiToken),

    'POST /sessions/:id/feedback': withAuth((body, params) => {
      const data = (body ?? {}) as {
        artifactId?: string
        comment?: string
        lines?: Array<{ file: string; oldLine?: number; newLine?: number; comment: string }>
      }
      const hasComment = data.comment && data.comment.trim()
      const hasLines = data.lines && data.lines.some((l) => l.comment && l.comment.trim())
      if (!data.artifactId || (!hasComment && !hasLines)) {
        return { status: 400, body: { error: 'Missing "artifactId", or both "comment" and "lines" are empty' } }
      }
      const ok = manager.feedback(
        params!.id!,
        data.artifactId,
        (data.comment ?? '').trim(),
        data.lines,
      )
      if (!ok) return { status: 409, body: { error: 'Session is missing or already running' } }
      return { status: 200, body: manager.getSession(params!.id!) }
    }, apiToken),

    'GET /sessions/:id/artifacts': withAuth((_body, params) => {
      const list = manager.listArtifacts(params!.id!)
      if (!list) return { status: 404, body: { error: 'Session not found' } }
      return { status: 200, body: { artifacts: list.map(artifactSummary) } }
    }, apiToken),

    'GET /sessions/:id/artifacts/:artifactId': withAuth(async (_body, params) => {
      const id = params!.id!
      const artifactId = params!.artifactId!
      const list = manager.listArtifacts(id)
      if (!list) return { status: 404, body: { error: 'Session not found' } }
      const found = list.find((a) => a.id === artifactId)
      if (!found) return { status: 404, body: { error: 'Artifact not found' } }
      const raw = await manager.readArtifact(id, artifactId)
      return { status: 200, body: { artifact: artifactSummary(found), raw: raw ?? '' } }
    }, apiToken),

    // Background jobs (bash run_in_background) — list / logs / kill.
    'GET /sessions/:id/jobs': withAuth((_body, params) => {
      const jobs = manager.listJobs(params!.id!)
      if (!jobs) return { status: 404, body: { error: 'Session not found' } }
      return { status: 200, body: { jobs } }
    }, apiToken),

    'GET /sessions/:id/jobs/:jobId/logs': withAuth((_body, params) => {
      const logs = manager.getJobLogs(params!.id!, params!.jobId!)
      if (logs === undefined) return { status: 404, body: { error: 'Session or job not found' } }
      return { status: 200, body: { logs } }
    }, apiToken),

    'POST /sessions/:id/jobs/:jobId/kill': withAuth((_body, params) => {
      const ok = manager.killJob(params!.id!, params!.jobId!)
      if (!ok) return { status: 404, body: { error: 'Session or job not found' } }
      return { status: 200, body: { ok: true } }
    }, apiToken),

    // I1 — convene a star-domain council on a plan artifact.
    // Body: { artifactId: string, objective?: string, seats?: [...], rounds?: 1|2 }
    'POST /sessions/:id/council': withAuth(async (body, params) => {
      const data = (body ?? {}) as { artifactId?: unknown; objective?: unknown; seats?: unknown; rounds?: unknown }
      if (typeof data.artifactId !== 'string' || !data.artifactId.trim()) {
        return { status: 400, body: { error: 'Missing or invalid "artifactId"' } }
      }
      if (data.objective !== undefined && typeof data.objective !== 'string') {
        return { status: 400, body: { error: 'Invalid "objective"' } }
      }
      if (data.seats !== undefined && (!Array.isArray(data.seats) || data.seats.some((s: unknown) => !s || typeof (s as { authority?: unknown }).authority !== 'string'))) {
        return { status: 400, body: { error: 'Invalid "seats"' } }
      }
      if (data.rounds !== undefined && (typeof data.rounds !== 'number' || data.rounds < 1 || data.rounds > 2)) {
        return { status: 400, body: { error: 'Invalid "rounds" (must be 1 or 2)' } }
      }
      const session = manager.getSession(params!.id!)
      if (!session) return { status: 404, body: { error: 'Session not found' } }
      // I1: ensure the session has a live agent. The agent is lazily built on
      // first run; council must operate on a ready agent (idle is OK as long as
      // the agent exists and is not currently running a turn).
      const agent = manager.getAgentForSession?.(params!.id!)
      if (!agent || typeof agent.conveneCouncil !== 'function') {
        return { status: 503, body: { error: 'Agent not ready' } }
      }
      try {
        const result = await agent.conveneCouncil({
          artifactId: data.artifactId.trim(),
          ...(data.objective ? { objective: data.objective } : {}),
          ...(data.seats ? { seats: data.seats as { authority: string; charter?: string }[] } : {}),
          ...(typeof data.rounds === 'number' ? { rounds: data.rounds } : {}),
        })
        return { status: 200, body: result }
      } catch (err: unknown) {
        if (err instanceof Error && 'statusCode' in err && typeof (err as { statusCode: unknown }).statusCode === 'number') {
          return { status: (err as { statusCode: number }).statusCode, body: { error: err.message } }
        }
        return { status: 500, body: { error: (err as Error)?.message ?? 'Council failed' } }
      }
    }, apiToken),

    // 用户主动派后台子代理：在已有会话上、独立于主 turn 启动一个 worker。
    // 不置 session.running，子代理跑在隔离子会话，进度走 delegation SSE。
    'POST /sessions/:id/delegate': withAuth(async (body, params) => {
      const data = (body ?? {}) as { objective?: unknown; profile?: unknown; authority?: unknown; files?: unknown; resume?: unknown }
      if (typeof data.objective !== 'string' || !data.objective.trim()) {
        return { status: 400, body: { error: 'Missing or empty "objective" field' } }
      }
      if (data.profile !== undefined && typeof data.profile !== 'string') {
        return { status: 400, body: { error: 'Invalid "profile"' } }
      }
      if (data.authority !== undefined && typeof data.authority !== 'string') {
        return { status: 400, body: { error: 'Invalid "authority"' } }
      }
      if (data.files !== undefined && (!Array.isArray(data.files) || data.files.some((f: unknown) => typeof f !== 'string'))) {
        return { status: 400, body: { error: 'Invalid "files"' } }
      }
      if (data.resume !== undefined && typeof data.resume !== 'string') {
        return { status: 400, body: { error: 'Invalid "resume"' } }
      }
      const result = await manager.delegate(params!.id!, {
        objective: data.objective.trim(),
        ...(data.profile ? { profile: data.profile } : {}),
        ...(data.authority ? { authority: data.authority } : {}),
        ...(data.files ? { files: data.files as string[] } : {}),
        ...(data.resume ? { resume: data.resume } : {}),
      })
      if (result.ok) return { status: 200, body: { workerId: result.workerId } }
      switch (result.reason) {
        case 'not_found': return { status: 404, body: { error: 'Session not found' } }
        case 'invalid': return { status: 400, body: { error: 'Missing or empty "objective" field' } }
        case 'unsupported': return { status: 503, body: { error: 'Agent not ready' } }
        case 'limit': return { status: 429, body: { error: 'Too many concurrent background workers' } }
      }
    }, apiToken),

    // 取消一个用户派的后台子代理。
    'POST /sessions/:id/delegate/:workerId/abort': withAuth((_body, params) => {
      const ok = manager.cancelDelegate(params!.id!, params!.workerId!)
      if (!ok) return { status: 404, body: { error: 'Background worker not found' } }
      return { status: 200, body: { ok: true } }
    }, apiToken),

    // Phase 2 — per-worker steer: 向在跑 worker 的 steer 队列投递用户消息。
    'POST /sessions/:id/workers/:workerId/steer': withAuth((body, params) => {
      const data = (body ?? {}) as { text?: string }
      if (!data.text || typeof data.text !== 'string' || !data.text.trim()) {
        return { status: 400, body: { error: 'Missing or empty "text" field' } }
      }
      const workerId = decodeURIComponent(params!.workerId!)
      const result = manager.steerWorker(params!.id!, workerId, data.text.trim())
      if (result === null) return { status: 503, body: { error: 'Agent not running' } }
      if (!result) return { status: 409, body: { error: 'Worker not running' } }
      return { status: 200, body: { ok: true } }
    }, apiToken),

    // Phase 2 — per-worker kill: 终止指定 worker（双轨：backgroundAborts + orderControllers）。
    'POST /sessions/:id/workers/:workerId/kill': withAuth((_body, params) => {
      const workerId = decodeURIComponent(params!.workerId!)
      const result = manager.killWorker(params!.id!, workerId)
      if (result === null) return { status: 404, body: { error: 'Session not found' } }
      if (!result) return { status: 409, body: { error: 'Worker not running or not found' } }
      return { status: 200, body: { ok: true } }
    }, apiToken),

    // I4 — read user-defined .rivet/hooks.json for this session.
    'GET /sessions/:id/hooks': withAuth((_body, params) => {
      const rec = manager.getSession(params!.id!)
      if (!rec) return { status: 404, body: { error: 'Session not found' } }
      const config = loadHooksConfig(rec.cwd)
      return { status: 200, body: config }
    }, apiToken),

    // I4 — write user-defined .rivet/hooks.json for this session.
    'PUT /sessions/:id/hooks': withAuth((body, params) => {
      const rec = manager.getSession(params!.id!)
      if (!rec) return { status: 404, body: { error: 'Session not found' } }
      const data = (body ?? {}) as { hooks?: unknown }
      if (!Array.isArray(data.hooks)) {
        return { status: 400, body: { error: 'Missing or invalid "hooks" array' } }
      }
      const hooks: HookEntry[] = []
      for (const entry of data.hooks) {
        if (!entry || typeof entry !== 'object') {
          return { status: 400, body: { error: 'Each hook must be an object' } }
        }
        const e = entry as Record<string, unknown>
        if (!VALID_EVENTS.has(e.event as HookEvent)) {
          return { status: 400, body: { error: `Invalid hook event "${e.event}"` } }
        }
        if (typeof e.script !== 'string' || !e.script.trim()) {
          return { status: 400, body: { error: 'Each hook must have a non-empty "script"' } }
        }
        const timeoutMs = typeof e.timeoutMs === 'number' ? e.timeoutMs : undefined
        hooks.push({ event: e.event as HookEvent, script: e.script.trim(), ...(timeoutMs !== undefined ? { timeoutMs } : {}) })
      }
      const dir = join(rec.cwd, '.rivet')
      const path = join(dir, 'hooks.json')
      try {
        validatePath(rec.cwd, path, 'write')
      } catch {
        return { status: 400, body: { error: 'Invalid hooks path' } }
      }
      mkdirSync(dir, { recursive: true })
      writeFileSync(path, JSON.stringify({ hooks }, null, 2), 'utf-8')
      return { status: 200, body: { hooks } }
    }, apiToken),

    // Vision — serve a persisted user-attached image by id. The desktop fetches
    // this with the Bearer header (img src cannot carry headers, so the client
    // turns the bytes into a blob object URL). Binary response: take over `res`.
    'GET /sessions/:id/images/:imgId': withAuth((_body, params, headers, res) => {
      if (!res) return { status: 500, body: { error: 'Response stream is unavailable' } }
      const img = manager.readImage(params!.id!, params!.imgId!)
      if (!img) return { status: 404, body: { error: 'Image not found' } }
      const origin = allowedCorsOrigin(headers ?? {})
      res.writeHead(200, {
        'Content-Type': img.mime,
        'Content-Length': img.bytes.length,
        'Cache-Control': 'private, max-age=31536000, immutable',
        ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
      })
      res.end(img.bytes)
      return { status: 200, handled: true }
    }, apiToken),

    // R3 — rollback preview. Returns the agent-owned files that would be
    // restored, files skipped because a peer session owns them, AND any
    // irreversible bash side effects file rollback CANNOT undo. The returned
    // confirmationToken must be echoed back to POST /rollback.
    'GET /sessions/:id/rollback/preview': withAuth(async (_body, params) => {
      const id = params!.id!
      const rec = manager.getSession(id)
      if (!rec) return { status: 404, body: { error: 'Session not found' } }
      const preview = await getRollbackPreview(rec.cwd, id, guardFor(id, rec.cwd))
      if (!preview) return { status: 200, body: { available: false } }
      return { status: 200, body: { available: true, ...preview } }
    }, apiToken),

    // R3 — execute rollback. Requires the confirmationToken from preview. Only
    // this session's own touched files are restored; contested files are skipped
    // and surfaced, and irreversible effects are reported (never silently undone).
    'POST /sessions/:id/rollback': withAuth(async (body, params) => {
      const id = params!.id!
      const rec = manager.getSession(id)
      if (!rec) return { status: 404, body: { error: 'Session not found' } }
      const data = (body ?? {}) as { confirmationToken?: string }
      if (!data.confirmationToken) {
        return { status: 400, body: { error: 'Missing "confirmationToken" (get one from rollback/preview)' } }
      }
      const result = await rollbackToCheckpoint(rec.cwd, data.confirmationToken, id, guardFor(id, rec.cwd))
      if (!result.success) {
        return { status: 409, body: { error: 'Rollback failed or nothing to restore', ...result } }
      }
      return { status: 200, body: result }
    }, apiToken),

    // ── Rewind: list user messages that can be rewound to ──
    'GET /sessions/:id/rewind-points': withAuth(async (_body, params) => {
      const points = await manager.listRewindPoints(params!.id!)
      if (!points) return { status: 404, body: { error: 'Session not found' } }
      return { status: 200, body: { points } }
    }, apiToken),

    // ── Rewind: truncate conversation to a prior message index ──
    'POST /sessions/:id/rewind': withAuth(async (body, params) => {
      const data = (body ?? {}) as { messageIndex?: number; rollbackFiles?: boolean }
      if (typeof data.messageIndex !== 'number' || data.messageIndex < 0) {
        return { status: 400, body: { error: 'Missing or invalid "messageIndex"' } }
      }
      const rec = manager.getSession(params!.id!)
      if (!rec) return { status: 404, body: { error: 'Session not found' } }
      // Issue #63: rehydrated sessions (sidecar restart) have no live agent —
      // build one (restores disk history) so rewind works on history sessions.
      // Build failure (cwd removed / config invalid) is explicit, not folded
      // into the generic 409 below.
      const ensured = await manager.ensureSessionAgent(params!.id!)
      if (!ensured) {
        return { status: 409, body: { error: 'Session agent unavailable (cwd missing or config invalid)' } }
      }
      const ok = manager.rewind(params!.id!, data.messageIndex, { rollbackFiles: data.rollbackFiles === true })
      if (!ok) {
        return { status: 409, body: { error: 'Session is running or index out of range' } }
      }
      return { status: 200, body: { ok: true, ...manager.getSession(params!.id!) } }
    }, apiToken),

    // ── Precise rewind: preview the agent-edited files a per-message code
    // rewind would restore/delete (from FileHistory). available=false lets the
    // caller fall back to the coarse checkpoint rollback. ──
    'POST /sessions/:id/rewind/file-preview': withAuth((body, params) => {
      const data = (body ?? {}) as { messageIndex?: number }
      if (typeof data.messageIndex !== 'number' || data.messageIndex < 0) {
        return { status: 400, body: { error: 'Missing or invalid "messageIndex"' } }
      }
      const r = manager.previewFilesPrecise(params!.id!, data.messageIndex)
      if (!r) return { status: 404, body: { error: 'Session not found' } }
      return { status: 200, body: r }
    }, apiToken),

    // ── Precise rewind: restore agent-edited files to their state at the
    // selected message (does NOT truncate the conversation). ──
    'POST /sessions/:id/rewind/files': withAuth(async (body, params) => {
      const data = (body ?? {}) as { messageIndex?: number }
      if (typeof data.messageIndex !== 'number' || data.messageIndex < 0) {
        return { status: 400, body: { error: 'Missing or invalid "messageIndex"' } }
      }
      const r = await manager.rewindFilesPrecise(params!.id!, data.messageIndex)
      if (!r) return { status: 404, body: { error: 'Session not found' } }
      if (!r.success) {
        return { status: 409, body: { error: 'Session is running, has no file history, or index out of range', ...r } }
      }
      return { status: 200, body: r }
    }, apiToken),

    // Git worktrees — list all worktrees for the repo root (used by the desktop
    // sidebar to show worktree branch status for sessions).
    'GET /worktrees': withAuth(() => ({
      status: 200,
      body: { worktrees: manager.getWorktrees() },
    }), apiToken),

    // P4 补线 — real local branches for the project picker / welcome composer.
    'GET /git/branches': withAuth(async (_body, params) => {
      const cwd = typeof params?.cwd === 'string' ? params.cwd.trim() : ''
      if (!cwd) return { status: 400, body: { error: 'Missing "cwd" query param' } }
      // cwd 必须解析到已存在目录——否则 spawnGit 以坏 cwd 启动失败被 listGitBranches
      // 的 catch 吞成 notARepo 200，调用者可借任意路径探测「是否为 git 仓库」
      // （2026-09-07 审查发现）。绝对路径 + statSync 目录确认后放行。
      if (!isAbsolute(cwd)) return { status: 400, body: { error: 'cwd must be an absolute path' } }
      try {
        if (!statSync(cwd).isDirectory()) {
          return { status: 400, body: { error: 'cwd is not a directory' } }
        }
      } catch {
        return { status: 400, body: { error: 'cwd does not exist' } }
      }
      const result = await manager.getGitBranches(cwd)
      return { status: 200, body: result }
    }, apiToken),

    // Git branch graph — ASCII graph for the repo root.
    'GET /git/graph': withAuth(async (_body, params) => {
      const maxCount = params?.maxCount ? Number(params.maxCount) : undefined
      const graph = await manager.getGitGraph(undefined, maxCount)
      return { status: 200, body: { graph: graph.split('\n') } }
    }, apiToken),

    // Working-tree changes relative to HEAD (file list only; per-file diff fetched on demand).
    // Used by the desktop "changes" tab — lightweight file list, no diff body.
    'GET /git/working-tree': withAuth(async (_body, params) => {
      const includeIgnored = params?.includeIgnored === 'true'
      const result = await manager.getWorkingTreeFiles(undefined, includeIgnored)
      return { status: 200, body: result }
    }, apiToken),

    // Unified diff of a single file relative to HEAD (on-demand, for the changes tab).
    'GET /git/diff': withAuth(async (_body, params) => {
      const path = params?.path
      if (!path || typeof path !== 'string') return { status: 400, body: { error: 'Missing path param' } }
      const diff = await manager.getFileDiff(path)
      return { status: 200, body: { diff } }
    }, apiToken),

    // Session-scoped working-tree changes — resolves the session's worktree cwd
    // and diffs against the recorded task baseline (baselineHead) so committed
    // work stays visible in the Changes tab.
    'GET /sessions/:id/git/working-tree': withAuth(async (_body, params) => {
      const includeIgnored = params?.includeIgnored === 'true'
      const result = await manager.getSessionWorkingTree(String(params?.id ?? ''), includeIgnored)
      if (!result) return { status: 404, body: { error: 'Session not found' } }
      return { status: 200, body: result }
    }, apiToken),

    // Session-scoped single-file diff (worktree cwd + task baseline).
    'GET /sessions/:id/git/diff': withAuth(async (_body, params) => {
      const path = params?.path
      if (!path || typeof path !== 'string') return { status: 400, body: { error: 'Missing path param' } }
      const diff = await manager.getSessionFileDiff(String(params?.id ?? ''), path)
      if (diff === null) return { status: 404, body: { error: 'Session not found' } }
      return { status: 200, body: { diff } }
    }, apiToken),

    // Full file content at the session's task baseline — lets editor clients
    // (VS Code extension) render a native two-pane diff without shipping git
    // plumbing to the client. exists=false → file was added after the baseline.
    'GET /sessions/:id/git/file-base': withAuth(async (_body, params) => {
      const path = params?.path
      if (!path || typeof path !== 'string') return { status: 400, body: { error: 'Missing path param' } }
      const result = await manager.getSessionFileAtBase(String(params?.id ?? ''), path)
      if (result === null) return { status: 404, body: { error: 'Session not found' } }
      return { status: 200, body: result }
    }, apiToken),

    // Change landing — commit everything in the session cwd (server-direct).
    'POST /sessions/:id/git/commit': withAuth(async (body, params) => {
      const message = typeof (body as { message?: unknown })?.message === 'string'
        ? (body as { message: string }).message
        : undefined
      const result = manager.commitSessionChanges(String(params?.id ?? ''), message)
      if (result === null) return { status: 404, body: { error: 'Session not found' } }
      return { status: result.ok ? 200 : 409, body: result }
    }, apiToken),

    // Change landing — squash-merge the session worktree branch into the main workspace.
    'POST /sessions/:id/git/merge-back': withAuth(async (_body, params) => {
      const result = manager.mergeSessionBack(String(params?.id ?? ''))
      if (result === null) return { status: 404, body: { error: 'Session not found' } }
      return { status: result.ok ? 200 : 409, body: result }
    }, apiToken),

    // Change landing — push the worktree branch and open a PR via gh.
    'POST /sessions/:id/git/pr': withAuth(async (body, params) => {
      const b = body as { title?: unknown; body?: unknown } | undefined
      const result = await manager.createSessionPr(
        String(params?.id ?? ''),
        typeof b?.title === 'string' ? b.title : undefined,
        typeof b?.body === 'string' ? b.body : undefined,
      )
      if (result === null) return { status: 404, body: { error: 'Session not found' } }
      return { status: result.ok ? 200 : 409, body: result }
    }, apiToken),

    // GitHub PR integration — list open PRs for the repo. Requires `gh` CLI.
    'GET /github/prs': withAuth(async () => {
      const cwd = manager.getDefaultCwd()
      const available = await isGhAvailable(cwd)
      if (!available) return { status: 200, body: { prs: [], ghAvailable: false } }
      const prs = await listPrs(cwd)
      return { status: 200, body: { prs: prs ?? [], ghAvailable: true } }
    }, apiToken),

    // GitHub PR detail — get a single PR with comments and changed files.
    'GET /github/prs/:number': withAuth(async (_body, params) => {
      const cwd = manager.getDefaultCwd()
      const num = Number(params?.number)
      if (!num || num <= 0) return { status: 400, body: { error: 'Invalid PR number' } }
      const pr = await getPrDetail(cwd, num)
      if (!pr) return { status: 404, body: { error: 'PR not found or gh not available' } }
      return { status: 200, body: pr }
    }, apiToken),

    // GitHub PR full unified diff — for per-file rendering in DiffView.
    'GET /github/prs/:number/diff': withAuth(async (_body, params) => {
      const cwd = manager.getDefaultCwd()
      const num = Number(params?.number)
      if (!num || num <= 0) return { status: 400, body: { error: 'Invalid PR number' } }
      const diff = await getPrDiff(cwd, num)
      if (diff == null) return { status: 404, body: { error: 'PR diff not available or gh not available' } }
      return { status: 200, body: { diff } }
    }, apiToken),

    // Submit a PR review (verdict + summary + inline comments) as one GitHub
    // review. Surfaces gh's stderr on failure so the UI can explain what broke.
    'POST /github/prs/:number/review': withAuth(async (body, params) => {
      const cwd = manager.getDefaultCwd()
      const num = Number(params?.number)
      if (!num || num <= 0) return { status: 400, body: { error: 'Invalid PR number' } }
      const data = (body ?? {}) as Partial<PrReviewInput>
      const event = data.event
      if (event !== 'APPROVE' && event !== 'REQUEST_CHANGES' && event !== 'COMMENT') {
        return { status: 400, body: { error: 'Invalid review event' } }
      }
      // GitHub rejects a COMMENT review with neither a body nor inline comments.
      const comments = Array.isArray(data.comments) ? data.comments : []
      if (event === 'COMMENT' && !data.body?.trim() && comments.length === 0) {
        return { status: 400, body: { error: 'Comment review requires a summary or at least one inline comment' } }
      }
      const result = await submitPrReview(cwd, num, { event, body: data.body ?? '', comments })
      if (!result.ok) {
        return { status: 502, body: { ok: false, error: result.stderr.trim() || 'gh review submission failed' } }
      }
      return { status: 200, body: { ok: true } }
    }, apiToken),

    // CI checks overview for one PR (detail view; list rows read the rollup
    // embedded in listPrs results instead of calling this per row).
    'GET /github/prs/:number/checks': withAuth(async (_body, params) => {
      const cwd = manager.getDefaultCwd()
      const num = Number(params?.number)
      if (!num || num <= 0) return { status: 400, body: { error: 'Invalid PR number' } }
      const checks = await listPrChecks(cwd, num)
      if (checks == null) return { status: 502, body: { error: 'gh pr checks failed or gh not available' } }
      return { status: 200, body: { checks } }
    }, apiToken),

    // Single check's failure log (auto-fix context). checkIndex is the index
    // into the checks list — checks expose no stable numeric id to the client.
    'GET /github/prs/:number/checks/:checkIndex/log': withAuth(async (_body, params) => {
      const cwd = manager.getDefaultCwd()
      const num = Number(params?.number)
      const idx = Number(params?.checkIndex)
      if (!num || num <= 0) return { status: 400, body: { error: 'Invalid PR number' } }
      if (!Number.isInteger(idx) || idx < 0) return { status: 400, body: { error: 'Invalid check index' } }
      const checks = await listPrChecks(cwd, num)
      if (checks == null) return { status: 502, body: { error: 'gh pr checks failed or gh not available' } }
      const check = checks[idx]
      if (!check) return { status: 404, body: { error: 'Check not found' } }
      const result = await getCheckRunLog(cwd, check)
      if (result == null) return { status: 502, body: { error: 'Failed to fetch check log' } }
      if ('externalUrl' in result) return { status: 200, body: { name: check.name, externalUrl: result.externalUrl } }
      // Cap the payload — raw logs can be megabytes; the panel only uses an excerpt.
      const truncated = result.log.length > MAX_CHECK_LOG_CHARS
      const log = truncated ? result.log.slice(-MAX_CHECK_LOG_CHARS) : result.log
      return { status: 200, body: { name: check.name, log, truncated } }
    }, apiToken),

    // Merge a PR. Irreversible — requires { confirm: true }; without it the
    // route returns needsConfirm so the UI can show the confirm bar first.
    'POST /github/prs/:number/merge': withAuth(async (body, params) => {
      const cwd = manager.getDefaultCwd()
      const num = Number(params?.number)
      if (!num || num <= 0) return { status: 400, body: { error: 'Invalid PR number' } }
      const data = (body ?? {}) as { method?: unknown; auto?: unknown; deleteBranch?: unknown; confirm?: unknown }
      if (data.method !== 'squash' && data.method !== 'merge' && data.method !== 'rebase') {
        return { status: 400, body: { error: 'Invalid merge method (squash|merge|rebase)' } }
      }
      if (data.confirm !== true) return { status: 200, body: { needsConfirm: true } }
      const result = await mergePr(cwd, num, data.method, {
        auto: data.auto === true,
        deleteBranch: data.deleteBranch === true,
      })
      if (!result.ok) {
        const stderr = result.stderr.trim().slice(0, 2048)
        // Map the common auto-merge-not-enabled failure to an actionable hint.
        const autoMergeDisabled = data.auto === true && /auto.?merge/i.test(stderr)
        return {
          status: 502,
          body: {
            ok: false,
            error: stderr || 'gh pr merge failed',
            ...(autoMergeDisabled
              ? { hint: 'Repository does not allow auto-merge — enable it in repo settings, or merge without auto.' }
              : {}),
          },
        }
      }
      return { status: 200, body: { ok: true } }
    }, apiToken),

    // Push an auto-fix worker's diff artifact back to the PR head branch so CI
    // re-runs. Fast-forward only (no force-push); requires { confirm: true }.
    'POST /github/prs/:number/push-fix': withAuth(async (body, params) => {
      const cwd = manager.getDefaultCwd()
      const num = Number(params?.number)
      if (!num || num <= 0) return { status: 400, body: { error: 'Invalid PR number' } }
      const data = (body ?? {}) as { sessionId?: unknown; artifactId?: unknown; confirm?: unknown }
      if (typeof data.sessionId !== 'string' || !data.sessionId) return { status: 400, body: { error: 'Missing "sessionId"' } }
      if (typeof data.artifactId !== 'string' || !data.artifactId) return { status: 400, body: { error: 'Missing "artifactId"' } }
      if (data.confirm !== true) return { status: 200, body: { needsConfirm: true } }
      const list = manager.listArtifacts(data.sessionId)
      if (!list) return { status: 404, body: { error: 'Session not found' } }
      if (!list.some((a) => a.id === (data.artifactId as string))) return { status: 404, body: { error: 'Artifact not found' } }
      const diff = await manager.readArtifact(data.sessionId, data.artifactId)
      if (!diff?.trim()) return { status: 422, body: { ok: false, error: 'Artifact is empty or unreadable' } }
      const pr = await getPrDetail(cwd, num)
      if (!pr) return { status: 404, body: { error: 'PR not found or gh not available' } }
      const result = await pushFixToPrBranch(cwd, pr.headRefName, diff)
      if (!result.ok) {
        return { status: 502, body: { ok: false, stage: result.stage, error: (result.error ?? '').slice(0, 2048) } }
      }
      return { status: 200, body: { ok: true, sha: result.sha, nothingToCommit: result.nothingToCommit === true } }
    }, apiToken),

    // ── W3: Team checkpoint / resume ──
    // GET: list checkpoints for a session's cwd so the desktop can show
    // available checkpoints in the "Resume" card.
    'GET /sessions/:id/team-checkpoints': withAuth((_body, params) => {
      const rec = manager.getSession(params!.id!)
      if (!rec) return { status: 404, body: { error: 'Session not found' } }
      const checkpoints = listCheckpoints(rec.cwd)
      return { status: 200, body: { checkpoints } }
    }, apiToken),

    // POST: resume a team from a checkpoint. Loads the checkpoint, rebuilds
    // a plan, stores it via plan-store, and injects a resume kickoff prompt
    // so the next bare team_orchestrate call auto-consumes it.
    'POST /sessions/:id/team-resume': withAuth(async (body, params) => {
      const rec = manager.getSession(params!.id!)
      if (!rec) return { status: 404, body: { error: 'Session not found' } }
      const data = (body ?? {}) as { groupId?: string }
      if (!data.groupId || typeof data.groupId !== 'string') {
        return { status: 400, body: { error: 'Missing or invalid groupId' } }
      }
      const cp = loadCheckpoint(rec.cwd, data.groupId)
      if (!cp) return { status: 404, body: { error: `Checkpoint ${data.groupId} not found` } }
      const resume = buildResumeFromCheckpoint(cp)
      if (!resume) return { status: 200, body: { resumed: false, message: 'All tasks completed — nothing to resume.' } }
      storePlan(resume.planJson, params!.id!)
      const ok = manager.run(params!.id!, resume.prompt)
      if (!ok) return { status: 409, body: { error: 'Session is missing or already running' } }
      return { status: 200, body: { resumed: true, message: resume.prompt } }
    }, apiToken),
  }

  return routes
}

/** 把文档附件（base64 dataUrl）落盘到临时目录，调 extractDocumentText 抽取文本，
 *  返回拼好的前置块（含 EXTRACTION_CAVEAT）。失败的单个文档降级为错误提示，
 *  不阻断整体发送。 */
async function extractDocumentsToText(
  documents: Array<{ name: string; dataUrl: string }>,
): Promise<string | null> {
  const parts: string[] = []
  const tmpBase = mkdtempSync(join(tmpdir(), 'rivet-doc-'))
  try {
    for (const doc of documents) {
      const ext = extname(doc.name).toLowerCase() || '.bin'
      const tmpPath = join(tmpBase, `${doc.name.replace(/[^A-Za-z0-9._-]/g, '_')}`)
      try {
        const base64 = doc.dataUrl.split(',')[1] ?? ''
        writeFileSync(tmpPath, Buffer.from(base64, 'base64'))
        const result = await extractDocumentText(tmpPath)
        if (result.ok) {
          parts.push(`[document: ${doc.name}]\n${EXTRACTION_CAVEAT}\n\n${result.text}`)
        } else {
          parts.push(`[document: ${doc.name}]\n(extraction failed: ${result.suggestion})`)
        }
      } catch (err) {
        parts.push(`[document: ${doc.name}]\n(extraction error: ${(err as Error).message})`)
      }
    }
  } finally {
    rmSync(tmpBase, { recursive: true, force: true })
  }
  return parts.length > 0 ? parts.join('\n\n---\n\n') : null
}

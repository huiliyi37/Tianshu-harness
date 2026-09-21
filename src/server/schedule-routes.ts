/**
 * /schedule routes (N3) — CRUD over the CronScheduler for the desktop's
 * "定时任务" surface. Bearer-gated (fail-closed). A due task fires through
 * CronWiring → TaskRegistry → SessionRuntimePool → a visible session.
 *
 *   POST   /schedule                create (prompt + trigger)
 *   GET    /schedule                list (optional ?status=active|paused|stopped)
 *   PATCH  /schedule/:id            in-place update (prompt/trigger/tools/policy/retry)
 *   POST   /schedule/:id/pause      pause/resume ({ enabled })
 *   POST   /schedule/:id/stop       stop / archive (terminal — keeps definition + history)
 *   DELETE /schedule/:id            remove (physical — history entry point is lost)
 */
import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import {
  CronScheduler,
  createScheduledTask,
  normalizeRetry,
  normalizeReviewPolicy,
  normalizeTaskStatus,
  resolveTaskStatus,
  type CronTrigger,
  type CronTriggerType,
  type ScheduledTaskPatch,
  type ScheduledTaskStatus,
} from './cron-scheduler.js'

function withAuth(handler: RouteHandler, apiToken?: string): RouteHandler {
  return async (body, params, headers, res) => {
    if (!isAuthorizedRequest({ body, headers }, apiToken)) {
      return { status: 401, body: { error: 'Unauthorized' } }
    }
    return handler(body, params, headers, res)
  }
}

const TRIGGER_TYPES: CronTriggerType[] = ['interval', 'cron', 'oneshot', 'startup', 'app-open', 'file-change', 'git-push', 'focus-change']
/** 事件触发类型——spec 可空（触发时机由事件决定，非时间表达式）。
 *  file-change 的 spec 是监听路径（相对 cwd）；git-push 的 spec 是分支名（空=任意）；其余 spec 空。 */
const EVENT_TRIGGER_TYPES: ReadonlySet<string> = new Set(['startup', 'app-open', 'file-change', 'git-push', 'focus-change'])

/**
 * `?status=` 过滤解析（issue #236）：接受单值或逗号列表，非法值一律忽略
 * （返回 undefined = 不过滤）。宁可不筛也不筛成空——列表空掉会被误读成
 * 「任务都没了」。
 */
function parseStatusFilter(raw: unknown): ReadonlySet<ScheduledTaskStatus> | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  const values = raw.split(',').map(s => normalizeTaskStatus(s.trim())).filter((s): s is ScheduledTaskStatus => !!s)
  return values.length > 0 ? new Set(values) : undefined
}

export interface ScheduleRouteOptions {
  getStatus?: () => Promise<unknown> | undefined
  /** 付费版 v1 · T5 — unattendedAutomation Pro gate。缺省 = 允许（测试/TUI 软门禁）。 */
  isUnattendedAutomationEnabled?: () => boolean
}

export function buildScheduleRoutes(
  scheduler: CronScheduler,
  apiToken?: string,
  options: ScheduleRouteOptions = {},
): Record<string, RouteHandler> {
  const { getStatus, isUnattendedAutomationEnabled } = options
  return {
    'POST /schedule': withAuth((body) => {
      const data = (body ?? {}) as {
        prompt?: string
        trigger?: { type?: string; spec?: string }
        allowedTools?: string[]
        agentId?: string
        retry?: unknown
        reviewPolicy?: unknown
      }
      if (!data.prompt || !data.prompt.trim()) {
        return { status: 400, body: { error: 'Missing "prompt"' } }
      }
      const t = data.trigger
      // 事件触发类型（startup/app-open）spec 可空；时间触发类型必须给 spec。
      const isEventTrigger = t?.type && EVENT_TRIGGER_TYPES.has(t.type)
      if (!t || !t.type || !TRIGGER_TYPES.includes(t.type as CronTriggerType)
        || (!isEventTrigger && !t.spec)) {
        return { status: 400, body: { error: 'Invalid "trigger" (need {type, spec})' } }
      }
      if (data.reviewPolicy !== undefined && !normalizeReviewPolicy(data.reviewPolicy)) {
        return { status: 400, body: { error: 'Invalid "reviewPolicy" (always-review | first-runs | auto-proceed)' } }
      }
      const reviewPolicy = normalizeReviewPolicy(data.reviewPolicy)
      const allowedTools = Array.isArray(data.allowedTools) ? data.allowedTools : []
      // Pro gate（fail-closed）：非 always-review 策略、或显式给了 computer_use
      // 白名单的定时任务都属于「无人值守自动化」，需要 Pro。
      const wantsUnattended = (reviewPolicy !== undefined && reviewPolicy !== 'always-review')
        || allowedTools.includes('computer_use')
      if (wantsUnattended && isUnattendedAutomationEnabled && !isUnattendedAutomationEnabled()) {
        return { status: 403, body: { error: 'pro_required', feature: 'unattendedAutomation' } }
      }
      const trigger: CronTrigger = { type: t.type as CronTriggerType, spec: String(t.spec) }
      try {
        const retry = normalizeRetry(data.retry)
        const task = createScheduledTask(
          data.prompt.trim(),
          trigger,
          allowedTools,
          {
            ...(data.agentId ? { agentId: data.agentId } : {}),
            ...(retry ? { retry } : {}),
            ...(reviewPolicy ? { reviewPolicy } : {}),
          },
        )
        scheduler.add(task)
        return { status: 201, body: task }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    'GET /schedule': withAuth((_body, params) => {
      const tasks = scheduler.list()
      // issue #236 — 可选状态过滤（UI 左列按状态分组时可用）。未给或不合法
      // 一律返回全量：过滤是视图便利，不该让列表因拼错参数而变空。
      const wanted = parseStatusFilter(params?.status)
      return {
        status: 200,
        body: { tasks: wanted ? tasks.filter(t => wanted.has(resolveTaskStatus(t))) : tasks },
      }
    }, apiToken),

    // Scheduler health (running? next-tick count) for the automations dashboard.
    'GET /schedule/status': withAuth(async () => {
      const status = getStatus ? await getStatus() : undefined
      return { status: 200, body: { status: status ?? null } }
    }, apiToken),

    // 试跑驱动信任 · Phase 1 — 立即手动触发一次（恒有人值守）。审批卡片
    // 在试跑中弹出即授权采集；试跑计入 triggerCount，与 first-runs 晋级衔接。
    'POST /schedule/:id/run-now': withAuth((_body, params) => {
      const ok = scheduler.runNow(params!.id!)
      if (!ok) return { status: 404, body: { error: 'Scheduled task not found or not active' } }
      return { status: 200, body: { id: params!.id!, triggered: true } }
    }, apiToken),

    'POST /schedule/:id/pause': withAuth((body, params) => {
      const data = (body ?? {}) as { enabled?: boolean }
      const enabled = data.enabled === true
      const ok = scheduler.setEnabled(params!.id!, enabled)
      if (!ok) return { status: 404, body: { error: 'Scheduled task not found' } }
      return { status: 200, body: { id: params!.id!, enabled, status: enabled ? 'active' : 'paused' } }
    }, apiToken),

    // issue #236 — 停止（归档终态）：定义保留、可查看、可复制重建，但不再触发；
    // 与 DELETE 的区别是**不动定义**，因此其运行历史入口仍然可达。
    // 与 pause 的区别是语义：paused 是可恢复的运行态，stopped 是使命终结。
    'POST /schedule/:id/stop': withAuth((_body, params) => {
      const ok = scheduler.setStatus(params!.id!, 'stopped')
      if (!ok) return { status: 404, body: { error: 'Scheduled task not found' } }
      return { status: 200, body: { id: params!.id!, status: 'stopped' } }
    }, apiToken),

    // issue #236 — 原地更新：不再需要「删除旧任务 + 新建任务」来调整定义。
    // 覆盖 prompt / trigger / reviewPolicy / allowedTools / retry / agentId；
    // 缺席字段不动，可选项显式 null 清除。id / 运行历史 / 生命周期状态不受影响。
    // 状态迁移不走这里（用 pause / stop），避免同一语义两个入口。
    'PATCH /schedule/:id': withAuth((body, params) => {
      const id = params!.id!
      const current = scheduler.get(id)
      if (!current) return { status: 404, body: { error: 'Scheduled task not found' } }
      const data = (body ?? {}) as {
        prompt?: unknown
        trigger?: { type?: string; spec?: string }
        allowedTools?: unknown
        reviewPolicy?: unknown
        retry?: unknown
        agentId?: unknown
      }
      const patch: ScheduledTaskPatch = {}

      if (data.prompt !== undefined) {
        if (typeof data.prompt !== 'string' || !data.prompt.trim()) {
          return { status: 400, body: { error: 'Invalid "prompt" (non-empty string)' } }
        }
        patch.prompt = data.prompt
      }
      if (data.trigger !== undefined) {
        const t = data.trigger
        const isEventTrigger = t?.type && EVENT_TRIGGER_TYPES.has(t.type)
        if (!t || !t.type || !TRIGGER_TYPES.includes(t.type as CronTriggerType)
          || (!isEventTrigger && !t.spec)) {
          return { status: 400, body: { error: 'Invalid "trigger" (need {type, spec})' } }
        }
        patch.trigger = { type: t.type as CronTriggerType, spec: String(t.spec) }
      }
      if (data.allowedTools !== undefined) {
        if (!Array.isArray(data.allowedTools) || !data.allowedTools.every(t => typeof t === 'string')) {
          return { status: 400, body: { error: 'Invalid "allowedTools" (string[])' } }
        }
        patch.allowedTools = data.allowedTools as string[]
      }
      // reviewPolicy / retry / agentId 三态：缺席=不动、显式 null=清除、值=覆盖。
      // 非 null 但不合法 → 400（不静默清空，否则"改错了"与"改成了空"分不清）。
      if (data.reviewPolicy !== undefined) {
        if (data.reviewPolicy === null) patch.reviewPolicy = null
        else {
          const p = normalizeReviewPolicy(data.reviewPolicy)
          if (!p) return { status: 400, body: { error: 'Invalid "reviewPolicy" (always-review | first-runs | auto-proceed)' } }
          patch.reviewPolicy = p
        }
      }
      if (data.retry !== undefined) {
        if (data.retry === null) patch.retry = null
        else {
          const r = normalizeRetry(data.retry)
          if (!r) return { status: 400, body: { error: 'Invalid "retry" (need {maxAttempts>=2, backoffMs})' } }
          patch.retry = r
        }
      }
      if (data.agentId !== undefined) {
        if (data.agentId === null || data.agentId === '') patch.agentId = null
        else if (typeof data.agentId !== 'string') return { status: 400, body: { error: 'Invalid "agentId" (string | null)' } }
        else patch.agentId = data.agentId
      }

      if (Object.keys(patch).length === 0) {
        return { status: 400, body: { error: 'Empty patch (no updatable field provided)' } }
      }

      // Pro gate（与创建同口径）：更新**后**的生效策略若属无人值守，需 Pro。
      // 用更新后的值判定——否则可以把任务先建成 always-review，再 PATCH 成
      // auto-proceed 绕过门禁。
      const nextReview = patch.reviewPolicy === undefined
        ? current.reviewPolicy
        : (patch.reviewPolicy === null ? undefined : patch.reviewPolicy)
      const nextTools = patch.allowedTools ?? current.allowedTools
      const wantsUnattended = (nextReview !== undefined && nextReview !== 'always-review')
        || nextTools.includes('computer_use')
      if (wantsUnattended && isUnattendedAutomationEnabled && !isUnattendedAutomationEnabled()) {
        return { status: 403, body: { error: 'pro_required', feature: 'unattendedAutomation' } }
      }

      try {
        const updated = scheduler.update(id, patch)
        if (!updated) return { status: 404, body: { error: 'Scheduled task not found' } }
        return { status: 200, body: updated }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    'DELETE /schedule/:id': withAuth((_body, params) => {
      const ok = scheduler.remove(params!.id!)
      if (!ok) return { status: 404, body: { error: 'Scheduled task not found' } }
      return { status: 200, body: { removed: true } }
    }, apiToken),

    // focus-change：前端 Tauri window focus/blur event 命中时调入，fire 所有
    // focus-change 类型任务。不经轮询——纯由前端事件驱动。
    'POST /schedule/trigger-focus': withAuth(() => {
      const fired = scheduler.fireByEvent('focus-change')
      return { status: 200, body: { fired } }
    }, apiToken),
  }
}

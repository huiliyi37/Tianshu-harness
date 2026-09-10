/**
 * SessionRuntimePool (N3) — the missing RuntimePool implementation.
 *
 * TaskRegistry.scheduleExecution() acquires a runtime per task; here each
 * acquisition spins up a *visible* RuntimeSessionManager session, so a cron job
 * firing shows up in the desktop Agent Manager exactly like a human-started
 * agent. The handle's execute() awaits terminal state and reports the run's
 * summary + changed files back to the registry.
 */
import type { RuntimeHandle, RuntimePool, RuntimeResult } from './task-registry.js'
import type { RuntimeSessionManager } from './session-manager.js'

export interface SessionRuntimePoolOptions {
  manager: RuntimeSessionManager
  defaultCwd: string
  /** Title prefix for spawned sessions (defaults to "scheduled"). */
  titlePrefix?: string
}

export class SessionRuntimePool implements RuntimePool {
  size = 0
  private readonly manager: RuntimeSessionManager
  private readonly defaultCwd: string
  private readonly titlePrefix: string

  constructor(opts: SessionRuntimePoolOptions) {
    this.manager = opts.manager
    this.defaultCwd = opts.defaultCwd
    this.titlePrefix = opts.titlePrefix ?? 'scheduled'
  }

  acquire(taskId: string): Promise<RuntimeHandle> {
    this.size++
    const handle: RuntimeHandle = {
      execute: async (prompt, signal, allowedTools, onSessionStart, options): Promise<RuntimeResult> => {
        const session = this.manager.createSession({
          // 任务自带 cwd（cron=创建时会话的工作区快照）优先；缺省回退池 defaultCwd。
          cwd: options?.cwd ?? this.defaultCwd,
          title: `${this.titlePrefix}:${taskId.slice(0, 8)}`,
          // 无人值守（auto-proceed）：审批请求 fail-closed 中止本次运行。
          unattended: options?.unattended === true,
          // Per-session 工具白名单（蒸馏回放等自动化场景）——经 ensureAgent →
          // createAgent → gateToolDefinitions coreOverride 通路收窄 LLM 可见工具。
          // undefined = 默认全量（行为不变）；[] = 空白名单；['computer_use'] = 只用 GUI。
          ...(allowedTools !== undefined ? { allowedTools } : {}),
        })
        // Link the visible session to the task immediately, so the desktop can
        // jump to the thread even if the run subsequently fails.
        onSessionStart?.(session.id)
        const onAbort = () => this.manager.abort(session.id)
        // Start first: runAndWait installs the exact active-run settlement token
        // synchronously. A pre-aborted signal must cancel that run, not perform
        // a no-op abort against the idle session immediately before it starts.
        const execution = this.manager.runAndWait(session.id, prompt)
        let listening = false
        if (signal.aborted) onAbort()
        else {
          signal.addEventListener('abort', onAbort)
          listening = true
        }
        try {
          const { status, summary, changedFiles, haltedApp } = await execution
          // Propagate real terminal state: a failed/aborted run must NOT be
          // recorded as completed. Throwing lets TaskRegistry mark failed (or,
          // when the abort came from cancel/timeout, keep that terminal state).
          if (status === 'failed' || status === 'aborted') {
            const err = new Error(summary || `session ${status}`)
            // 无人值守中止：缺授权的 app 名挂在 error 上，registry 结构化落
            // TaskRecord（修复闭环「补授权 → 重跑」不用解析错误文本）。
            if (haltedApp) (err as Error & { haltedApp?: string }).haltedApp = haltedApp
            throw err
          }
          return { summary, changedFiles }
        } finally {
          if (listening) signal.removeEventListener('abort', onAbort)
        }
      },
      release: () => {
        this.size = Math.max(0, this.size - 1)
      },
    }
    return Promise.resolve(handle)
  }
}

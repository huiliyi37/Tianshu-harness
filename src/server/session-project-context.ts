/**
 * session-project-context.ts — 会话层的两件「项目上下文」小事，从 session-manager 拆出（2026-10-21）。
 *
 *  1. 全自动档即授信：会话生效档为免审批时，在构建 agent 前给项目授信——项目配置、hooks、
 *     技能与项目说明按授信态加载，不再逐项目追问。
 *  2. 新对话开场的项目概况：全新对话（非续接、非恢复、非闲聊、非子代理）第一次运行前扫描项目、
 *     写好 .rivet.md 的自动维护段；每次运行收尾后台按签名增量刷新。
 */
import { dirname } from 'node:path'
import { findProjectConfig } from '../config/manager.js'
import { trustProjectForAutonomy } from '../config/project-trust.js'
import { refreshProjectOverview, overviewNeedsRefresh } from '../bootstrap/project-overview.js'
import type { ApprovalMode } from '../agent/loop-types.js'
import { debugLog } from '../utils/debug.js'

/** 开场最多等扫描这么久；超时照常开跑，扫描在后台继续完成。 */
const OVERVIEW_WAIT_MS = 100

/** 生效档为免审批时给项目授信（项目目录 = 项目配置所在目录，无配置时为 cwd）。失败不抛。 */
export function trustProjectIfAutonomous(cwd: string, effectiveMode: ApprovalMode | undefined, sessionId: string): void {
  if (effectiveMode !== 'dangerously-skip-permissions') return
  try {
    const projectPath = findProjectConfig(cwd)
    if (trustProjectForAutonomy(projectPath ? dirname(projectPath) : cwd)) {
      debugLog(`[trust] autonomous session ${sessionId} trusted ${cwd}`)
    }
  } catch { /* 授信失败不阻断会话：退回未授信行为 */ }
}

export interface OverviewRunInfo {
  sessionId: string
  cwd: string
  mode?: string
  forkedFromId?: string
  recovery: boolean
  autoResubmit: boolean
  hasUserEvents: boolean
}

/** 这次运行是否参与项目概况维护（闲聊与子代理不参与）。 */
export function overviewEligible(info: Pick<OverviewRunInfo, 'sessionId' | 'mode'>): boolean {
  return !info.sessionId.startsWith('worker-') && info.mode !== 'chat'
}

/**
 * 在开场扫描之后再启动 agent。不是全新对话、或概况已是最新时同步调用 start（不引入异步间隙）；
 * 否则最多等 OVERVIEW_WAIT_MS 再启动。等待期间 signal 中止（用户点了停止）就不再等扫描，
 * 立即交给 start 收尾——扫描本身在后台照常写完，下次开场直接用上。
 */
export function startAfterProjectOverview(info: OverviewRunInfo, start: () => void, signal?: AbortSignal): void {
  const fresh = overviewEligible(info) && !info.recovery && !info.autoResubmit && !info.forkedFromId && !info.hasUserEvents
  if (!fresh || !overviewNeedsRefresh(info.cwd)) { start(); return }
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const wait = new Promise<void>(resolve => { timer = setTimeout(resolve, OVERVIEW_WAIT_MS); timer.unref?.() })
  const aborted = new Promise<void>(resolve => {
    if (!signal) return
    if (signal.aborted) { resolve(); return }
    onAbort = resolve
    signal.addEventListener('abort', onAbort, { once: true })
  })
  void Promise.race([refreshProjectOverview(info.cwd), wait, aborted]).then(() => {
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
    start()
  })
}

/** 运行收尾：按签名增量刷新（不变时零成本跳过），后台进行。 */
export function refreshOverviewAfterRun(info: Pick<OverviewRunInfo, 'sessionId' | 'mode' | 'cwd'>): void {
  if (overviewEligible(info)) void refreshProjectOverview(info.cwd)
}

/**
 * T9 Bridge — 将 TuiApp 接入现有 AgentLoop。
 *
 * 将 TuiApp 的 AgentCallbacks 接口桥接到 AgentLoop.run() 的 callback 参数。
 * 所有回调先经过 TuiApp 处理（渲染），再转发给原始回调（如果有）。
 *
 * 使用方式：
 *   const t9Callbacks = wrapCallbacksWithTuiApp(app);
 *   await agent.run(prompt, { ...t9Callbacks, ...extraCallbacks });
 */

import { TuiApp, type AgentCallbacks } from './app.js'
import { debugLog } from '../../utils/debug.js'

/**
 * 将 TuiApp 回调绑定到 AgentLoop.run() 的参数。
 *
 * 返回的对象满足 loop-types.ts 的 AgentCallbacks 接口。
 */
export function wrapCallbacksWithTuiApp(
  app: TuiApp,
  original: Partial<AgentCallbacks> = {},
): AgentCallbacks {
  // 捕获本 run 的世代。abort 会让 app.runGen 自增；此后本 run 的迟到回调
  // (gen !== app.runGen) 一律丢弃，杜绝旧 run 的 onAbort 清掉新 run 的 busy，
  // 或旧 run 的 onTextDelta/onToolResult 污染新 run 的渲染（反向竞态）。
  const gen = app.runGen
  const live = () => app.runGen === gen

  return {
    onTextDelta: (text) => {
      if (!live()) return
      app.callbacks.onTextDelta(text)
      original.onTextDelta?.(text)
    },
    onThinkingDelta: (thinking) => {
      if (!live()) return
      app.callbacks.onThinkingDelta(thinking)
      original.onThinkingDelta?.(thinking)
    },
    onToolUse: (id, name, input) => {
      if (!live()) return
      app.callbacks.onToolUse(id, name, input)
      original.onToolUse?.(id, name, input)
    },
    onToolResult: (id, name, result, isError, rawPath, uiContent) => {
      if (!live()) {
        debugLog(`[tool-result-trace] DROP (stale run) id=${id} name=${name} isError=${isError}`)
        return
      }
      debugLog(`[tool-result-trace] bridge id=${id} name=${name} isError=${isError} len=${result?.length ?? 0}`)
      app.callbacks.onToolResult(id, name, result, isError, rawPath, uiContent)
      original.onToolResult?.(id, name, result, isError, rawPath, uiContent)
    },
    onTurnComplete: (usage, turnNumber, isFinal) => {
      if (!live()) return
      app.callbacks.onTurnComplete(usage, turnNumber, isFinal)
      original.onTurnComplete?.(usage, turnNumber, isFinal)
    },
    onError: (error) => {
      if (!live()) return
      app.callbacks.onError(error)
      original.onError?.(error)
    },
    onAbort: (reason) => {
      // 迟到的旧 run onAbort：新 run 已开始（gen 不符）→ 丢弃，否则会清掉新 run 的 busy
      if (!live()) return
      // 透传 reason（'watchdog' / 'watchdog:goal' / undefined）：handleAbort 据此
      // 区分看门狗自动恢复 vs 用户中断，goal 模式下还要据此自动续跑。丢了 reason
      // 整条 watchdog 自动恢复链就退化成普通 ⏹ Interrupted。
      app.callbacks.onAbort(reason)
      original.onAbort?.(reason)
    },
    onApprovalRequired: async (id, name, input) => {
      // 旧 run 的审批请求 → 自动拒绝，不为已死的 run 弹审批 UI
      if (!live()) return false
      if (original.onApprovalRequired) {
        return original.onApprovalRequired(id, name, input)
      }
      return app.callbacks.onApprovalRequired(id, name, input)
    },
    onCheckpoint: (hash) => {
      if (!live()) return
      app.callbacks.onCheckpoint?.(hash)
      original.onCheckpoint?.(hash)
    },
    onPhaseChange: (phase, detail) => {
      if (!live()) return
      app.callbacks.onPhaseChange?.(phase, detail)
      original.onPhaseChange?.(phase, detail)
    },
    onDomainDrift: (drift) => {
      if (!live()) return
      original.onDomainDrift?.(drift)
    },
    onIntentNote: (intent) => {
      // 迟到的旧 run 方向提示 → 丢弃，不为已死的 run 追加时间线卡片。
      if (!live()) return
      app.callbacks.onIntentNote?.(intent)
      original.onIntentNote?.(intent)
    },
    onSteerDrain: () => {
      if (!live()) return null
      const drained = app.callbacks.onSteerDrain?.() ?? null
      const originalDrained = original.onSteerDrain?.() ?? null
      return drained ?? originalDrained
    },
    onDelegationActivity: (activity) => {
      // 迟到的旧 run 委派活动 → 丢弃，避免污染新 run 的舰队读模型。
      if (!live()) return
      app.callbacks.onDelegationActivity?.(activity)
      original.onDelegationActivity?.(activity)
    },
    onCvmInterception: (notice) => {
      // 迟到的旧 run CVM 通知 → 丢弃，避免为已死 run 追加提示行。
      // 与上面每个回调同一纪律：世代不符一律静默丢弃。
      if (!live()) return
      app.callbacks.onCvmInterception?.(notice)
      original.onCvmInterception?.(notice)
    },
  }
}

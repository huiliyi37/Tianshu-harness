/**
 * permissionLevel 桥：chat UI 的 per-session 权限档位（default / assisted /
 * autoApprove / autopilot）下行到 sidecar 会话的 `ApprovalMode`。
 *
 * 缺口：用户在 chat UI 显式选择「绕过审批」（/yolo、/autopilot…）后，天枢
 * 内核仍按其自身档位弹审批——UI 档位此前对 sidecar 完全无效（半接）。
 *
 * 语义（v1，单向）：
 *  - `autoApprove` → `auto-accept`；`autopilot` → `dangerously-skip-permissions`
 *  - `default` → 还原进入覆盖前的原档（首次覆盖时经 readCurrentMode 捕获）
 *  - `assisted` / undefined / 未知值 → 完全 no-op（不记忆、不影响覆盖状态）
 *  - 显式档位未变化 → no-op（幂等；座舱侧的手动调档不被无谓覆盖）
 *  - 还原目标缺失（捕获失败）→ default 不调用
 * 纯逻辑、零运行时依赖（import type only），可在扩展宿主外单测。
 * @module
 */
import type { ApprovalMode } from '../sidecar/protocol.js'

/** UI 档位映射意图：目标档 / 还原 / 不干预。 */
export type BridgeMode = ApprovalMode | 'restore' | 'none'

/**
 * chat UI 档位 → 桥接意图。
 * @param level - `ChatRequest.permissionLevel` 原始值。
 * @returns 目标 ApprovalMode、`'restore'`（还原原档）或 `'none'`（不干预）。
 */
export function levelToMode(level: string | undefined): BridgeMode {
  switch (level) {
    case 'autoApprove':
      return 'auto-accept'
    case 'autopilot':
      return 'dangerously-skip-permissions'
    case 'default':
      return 'restore'
    default:
      return 'none'
  }
}

/** 一次同步应执行的动作。 */
export type PermissionBridgeAction = { kind: 'none' } | { kind: 'set'; mode: ApprovalMode }

interface SessionState {
  /** 上次处理的显式档位（弱信号不更新它——幂等与覆盖状态的锚）。 */
  lastSynced?: string
  /** 首次覆盖前捕获的原档（还原目标；缺失表示未覆盖或捕获失败）。 */
  original?: ApprovalMode
}

/**
 * 按 sidecar 会话维护「覆盖层」的状态机。
 *
 * 生命周期：会话首次出现覆盖档时捕获原档；期间换覆盖档沿用同一 original；
 * `default` 还原并清除覆盖；`forget` 丢弃会话状态（会话结束/重载）。
 */
export class PermissionBridge {
  private readonly states = new Map<string, SessionState>()

  /**
   * 同步一次 UI 档位，调用方提供的写入成功后才提交覆盖状态。
   * @param sessionId - sidecar 会话 id。
   * @param level - 本次请求携带的 permissionLevel（可能缺省）。
   * @param readCurrentMode - 读取 sidecar 当前档位（仅首次覆盖时调用一次）。
   * @param setMode - 等待 sidecar 确认写入；失败抛出以保留重试依据。
   * @returns 已确认的档位变更；`{kind:'none'}` 无需动作。
   */
  async sync(
    sessionId: string,
    level: string | undefined,
    readCurrentMode: () => Promise<ApprovalMode | undefined>,
    setMode: (mode: ApprovalMode) => Promise<void>,
  ): Promise<PermissionBridgeAction> {
    const mode = levelToMode(level)
    if (mode === 'none') return { kind: 'none' }
    const state = this.states.get(sessionId) ?? {}
    if (level === state.lastSynced) return { kind: 'none' }
    if (mode === 'restore') {
      const original = state.original
      if (original !== undefined) await setMode(original)
      state.lastSynced = level
      delete state.original
      this.states.set(sessionId, state)
      return original === undefined ? { kind: 'none' } : { kind: 'set', mode: original }
    }
    if (state.original === undefined) {
      try {
        state.original = await readCurrentMode()
      } catch {
        state.original = undefined
      }
    }
    this.states.set(sessionId, state)
    await setMode(mode)
    state.lastSynced = level
    return { kind: 'set', mode }
  }

  /** 丢弃会话状态（会话结束/扩展重载时清）。 */
  forget(sessionId: string): void {
    this.states.delete(sessionId)
  }

  /** 清空全部会话状态（扩展重载 / participant 注销）。 */
  clearAll(): void {
    this.states.clear()
  }
}

/**
 * CouncilPanelModel — 议事会面板帧（P2 Wave 2）
 *
 * 镜像 team-panel-model.ts 的成熟模式：PREFIX + JSON 帧经 uiContent 通道
 * 从服务端发射到桌面端，不进模型消息历史、不进 prompt——零前缀缓存影响。
 *
 * 编码：encodeCouncilPanel(model) → `rivet:council-panel:v1:{json}`
 * 解码：decodeCouncilPanel(line) → CouncilPanelModel | null（lastIndexOf + 撕裂回退）
 */

import { encodeFrame, decodeFrameLastWins, registerFramePrefix } from './frame-codec.js'

export const COUNCIL_PANEL_UI_PREFIX = 'rivet:council-panel:v1:'

// P2-B Wave 2: register for 8K truncate whitelist
registerFramePrefix(COUNCIL_PANEL_UI_PREFIX)

export interface CouncilPanelSeat {
  authority: string
  status: string        // running / passed / failed / escalated
  round: number         // 1 | 2（-r2 席）
  modelUsed?: string
  /** 实际命中的模型已弃用（如下线）——桌面端/终端应显式告警。 */
  deprecated?: boolean
}

export interface CouncilPanelModel {
  schemaVersion: 1
  objective: string
  seats: CouncilPanelSeat[]
  verdict: {
    accepted: number
    rejected: number
    deferred: number
    conflicts: number
  }
  /** sealPlan 后的版本号；无编译产物则缺省 */
  sealVersion?: number
  pillarsMode: boolean
  failedSeats?: string[]
  /** 柱级退化检测计数 */
  qliphothCount?: number
}

/** 帧编码 —— 单行 JSON，PREFIX 前缀。 */
export function encodeCouncilPanel(m: CouncilPanelModel): string {
  return encodeFrame(m, COUNCIL_PANEL_UI_PREFIX)
}

/**
 * 帧解码 —— lastIndexOf 定位 + JSON.parse + 撕裂回退。
 * 镜像 decodeTeamPanelModel 的模式：帧跨 SSE chunk 碎裂时 JSON.parse 失败，
 * 回退到前一帧已解码结果，撕裂尾帧不毁已解码面板。
 */
export function decodeCouncilPanel(value: string): CouncilPanelModel | null {
  return decodeFrameLastWins(value, COUNCIL_PANEL_UI_PREFIX, (p): p is CouncilPanelModel =>
    p != null && typeof p === 'object' && (p as CouncilPanelModel).schemaVersion === 1 && Array.isArray((p as CouncilPanelModel).seats),
  )
}

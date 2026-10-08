/** webview ↔ 扩展宿主 postMessage 桥（webview 侧）。 */

export interface SessionEvent {
  seq: number
  ts: number
  type: string
  data: Record<string, unknown>
}

export interface SessionRecord {
  id: string
  status: string
  createdAt: number
  updatedAt: number
  cwd: string
  title?: string
  lastSeq: number
  pendingApprovals: number
  approvalMode?: string
  archived?: boolean
  contextTokens?: number
  contextWindow?: number
  reasoningEffort?: string
}

/** 座舱快照子集（宿主桥转发 GET /sessions/:id/cockpit；null = 旧内核无路由）。 */
export interface CockpitSnapshot {
  context: {
    estimatedTokens: number
    maxTokens: number
    rounds: number
    compactionState: string
  } | null
  model: {
    name: string
    cacheHitRate: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    cost: number
    recentTurnHitRate: number | null
    cacheDiagnostic: string | null
  }
}

export interface ModelEntry {
  id: string
  alias: string
  provider: string
  current: boolean
}

export interface DomainEntry {
  key: string
  name: string
  motto: string
  current: boolean
}

/** GET /config/providers 镜像（宿主桥转发）。 */
export interface ProviderListItem {
  name: string
  label: string
  isDefault: boolean
  keyStatus: { source: 'inline' | 'env' | 'none'; ref: string }
  isPreset: boolean
}

export interface ProviderConfigList {
  providers: ProviderListItem[]
  unconfigured: { key: string; label: string; defaultModelId: string }[]
}

/** Plan 审批卡数据（GET /sessions/:id/plans/:slug 镜像子集）。 */
export interface PlanDocument {
  slug: string
  title: string
  content: string
  status: string
  /** 多方案候选（≥2 时审批需选其一，对齐桌面端 PlanPanel）。 */
  options?: { id: string; label: string }[]
}

export type HostMsg =
  | { type: 'sessions'; sessions: SessionRecord[]; activeSessionId?: string }
  | { type: 'sessionCreated'; session: SessionRecord }
  | { type: 'sessionAttached'; sessionId: string }
  | { type: 'event'; sessionId: string; event: SessionEvent }
  | { type: 'streamState'; sessionId: string; live: boolean }
  | { type: 'sidecarState'; state: 'starting' | 'ready' | 'dead'; detail?: string }
  | { type: 'pickers'; sessionId: string; models: ModelEntry[]; domains: DomainEntry[] }
  | { type: 'files'; reqId: number; files: string[] }
  | { type: 'insertText'; text: string }
  | { type: 'error'; message: string }
  | { type: 'providers'; config: ProviderConfigList | null }
  | { type: 'providerSetupResult'; ok: boolean; message?: string }
  | { type: 'plan'; sessionId: string; plan: PlanDocument; revision?: number }
  | { type: 'planDecisionResult'; sessionId: string; slug: string; decision: 'approve' | 'reject'; ok: boolean; message?: string; revision?: number }
  | { type: 'planEditResult'; sessionId: string; slug: string; ok: boolean; message?: string; revision?: number }
  | { type: 'cockpit'; sessionId: string; snapshot: CockpitSnapshot | null }
  | { type: 'sessionClosed' }
  | {
      type: 'settings'
      approval: string
      checkpointEveryTurns: number
      defaultModel?: string | null
      defaultDomain?: string
      models?: ModelEntry[]
      domains?: DomainEntry[]
    }
  | { type: 'settingsSaveResult'; ok: boolean; message?: string }
  | { type: 'searchHits'; reqId: number; results: { sessionId: string; title: string; snippet: string }[] }
  | { type: 'catalog'; models: ModelEntry[]; domains: DomainEntry[] }
  | { type: 'earlierEvents'; sessionId: string; events: SessionEvent[]; firstSeq: number; error?: string }
  | { type: 'rewindPoints'; sessionId: string; points: RewindPoint[] }
  | { type: 'retractResult'; sessionId: string; laneId: string; ok: boolean; text: string }

export interface RewindPoint {
  index: number
  content: string
  timestamp: number
  seq?: number
}

interface VsCodeApi {
  postMessage(msg: unknown): void
}

declare function acquireVsCodeApi(): VsCodeApi

const vscode = acquireVsCodeApi()

export function send(msg: Record<string, unknown>): void {
  vscode.postMessage(msg)
}

export function onHostMessage(cb: (msg: HostMsg) => void): () => void {
  const handler = (e: MessageEvent) => cb(e.data as HostMsg)
  window.addEventListener('message', handler)
  return () => window.removeEventListener('message', handler)
}

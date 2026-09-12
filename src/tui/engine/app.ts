/**
 * T9 TuiApp — 主事件循环（替代 app.tsx 的 React 组件）。
 *
 * 事件驱动架构：
 *   AgentLoop → (callbacks) → TuiApp → CommitEngine / LiveEngine / OverlayEngine
 *
 * 状态管理：普通 class properties 替代 React useState。
 * 渲染节奏：事件触发 → 更新状态 → 调用 engine 渲染。
 *
 * 阶段 5 定义架构骨架和渲染管线。
 * 阶段 6 会完成与 main.ts 和 AgentLoop 的实际接线。
 */

import type { WriteStream, ReadStream } from 'node:tty'
import { CommitEngine } from './commit-engine.js'
import { LiveEngine, padDynamicRegion, thinkingRowBudgetFor, type LiveRegionLine } from './live-engine.js'
import { installOutputGuard, type OutputGuard } from './output-guard.js'
import { OverlayEngine } from './overlay-engine.js'
import { InputHandler, type KeyPress } from './input-handler.js'
import { ResizeHandler } from './resize-handler.js'
import { InputLine } from './input-line.js'
import { loadImageAttachment, looksLikeImagePath, MAX_IMAGES } from './image-attach.js'
import { readImageFromClipboard, readTextFromClipboard, FOCUS_DEBOUNCE_MS } from './clipboard-image.js'
import { WriteBatcher } from './write-batcher.js'
import { StreamRenderer } from './stream-renderer.js'
import type { TuiPerfMonitor, TuiPerfSummary } from './perf-monitor.js'
import { ToolGroupController, type PendingToolMeta } from './tool-group-controller.js'
import { OverlayController } from './overlay-controller.js'
import { ApprovalIntentController } from './approval-intent-controller.js'
import { MetricsGlanceController } from './metrics-glance-controller.js'
import { StreamRenderController } from './stream-render-controller.js'
import { InputController } from './input-controller.js'
import { ANSI, color, fg, bg, QUERY_CURSOR_POS, osc52Clipboard, imageProtocol } from './ansi.js'
import {
  encodeTermImage,
  parseImageDataUrl,
  prepareTermImageForCommit,
  type PreparedTermImage,
} from './term-image.js'

import type { CacheStatus } from '../status-types.js'
import { debugLog } from '../../utils/debug.js'
import { BlockStreamWriter } from '../block-stream-writer.js'
import { SteerBuffer } from '../steer-buffer.js'
import { getPhaseStaleMessage } from '../fluency-policy.js'
import type { RiskExplanation } from '../../agent/risk-explain.js'
import { renderSideQuestion, sideQuestionBodyLines, type SideQuestionData } from '../format/side-question.js'

/** 为一次待批准的工具调用生成风险解释；返回 null 表示不可用（静默降级）。 */
export type RiskExplainer = (toolName: string, input: Record<string, unknown>) => Promise<RiskExplanation | null>

/** `/btw` 侧问执行器：流式回调 onDelta，resolve 完整回答（null = 不可用）。 */
export type SideQuestionAsker = (
  question: string,
  onDelta: (chunk: string) => void,
) => Promise<string | null>
import { SlashCommandRegistry, type SlashCommandContext } from '../slash-command-registry.js'
import { getTheme, getActiveThemeName, type RivetTheme } from '../theme.js'
import { formatUserMessage } from '../format/user-message.js'
import { formatAskUserQuestion } from '../format/ask-user-question.js'
import { formatToolCard, formatToolCardLive, isToolCardTruncated } from '../format/tool-card.js'
import { formatCollapsedGroup, formatCollapsedGroupLive, CollapsedReadSearchBuffer, isCollapsibleTool, type CollapsedReadSearchGroup } from '../format/collapsed-read-search.js'
import { formatCollapsedBashGroup, formatCollapsedBashGroupLive, isCollapsibleBashCommand, type CollapsedBashGroup } from '../format/collapsed-bash.js'
import { formatPermissionDiff } from '../format/permission-diff.js'
import { formatApprovalPrompt } from '../format/approval-renderers.js'
import { formatThinking } from '../format/thinking.js'
import { formatPromptFooter } from '../format/prompt-footer.js'
import { formatGlanceBar, resolveStarDomainDisplay, formatGlanceLeft, formatGlanceRight, formatPermissionModeLine } from '../format/glance-bar.js'
import { remainingSec, shouldFire } from '../plan-auto-approve.js'
import { STAR_DOMAINS } from '../../agent/star-domain.js'
import { starDomainRegistry } from '../../agent/star-domain-registry.js'
import { formatTaskList, shouldShowTaskPanel } from '../format/task-list.js'
import {
  buildPlanReviewActions,
  clampPlanReviewScroll,
  formatPlanReview,
  planReviewBodyRows,
  recommendedPlanReviewAction,
} from '../format/plan-review.js'
import { formatContextHints } from '../format/context-hints.js'
import type { TodoItem } from '../../tools/todo-store.js'
import { formatTeamPanel } from '../format/team-panel.js'
import { formatWorkerFleet, formatWorkerFleetSettled } from '../format/worker-fleet.js'
import { formatWorkerDispatchCard } from '../format/worker-dispatch-card.js'
import { decodeTeamPanelModel, overlayFleetStatus, TEAM_PANEL_UI_PREFIX, type TeamPanelModel } from '../team-panel-model.js'
import { decodeCouncilPanel, COUNCIL_PANEL_UI_PREFIX, type CouncilPanelModel } from '../council-panel-model.js'
import { formatCouncilPanel } from '../format/council-panel.js'
import { ActivityStore, formatActivityBand, formatJobsBar } from '../activity-store.js'
import { buildWorkerDetailContent } from '../worker-detail.js'
import { renderSidePanel, resolveSidePanelWidth, SIDE_PANEL_MIN_COLUMNS, type SidePanelInput } from '../side-panel.js'
import { loadWorkerSession } from '../../agent/worker-session-persist.js'
import type { TasksFilter } from '../format/overlay.js'
import type { PlanSubmittedInfo, AskUserQuestionInfo } from '../../tools/types.js'
import {
  composeAnswers,
  draftToAnswer,
  type AskAnswerDraft,
  type AskUserQuestionItem,
} from '../../tools/ask-user-question.js'
import { renderAskQuestionPanel, type AskQuestionPanelData } from '../format/ask-question-panel.js'
import { HANDOFF_NUDGE_RATIO, formatHandoffNudge } from '../handoff.js'
import { STAR_GENESIS } from '../../agent/star-genesis-data.js'
import {
  delegationObjectiveFromInput,
  delegationProfileFromInput,
  domainBadge,
  isDelegationTool,
} from '../format/tool-domain.js'
import { formatSpinnerStatus, formatTurnWorkSummary, formatJobAwaitWait, type JobAwaitCall } from '../format/spinner-status.js'
import { formatSlashHint, formatSlashMenu, slashCompletionTarget, slashArgsHint, SLASH_HINT_MAX_VISIBLE, computeSlashMenuBudget, type SlashHintEntry } from '../format/slash-hint.js'
import { OrchestrationHint, formatOrchestrationHint } from './orchestration-hint.js'
import { extractAtToken, getCompletions, applyCompletion } from '../file-completer.js'
import stringWidth from 'string-width'
import { resolve } from 'node:path'
import { existsSync, copyFileSync, statSync } from 'node:fs'
import { isPathUnder } from '../../tools/path-grants.js'
import { parseMentions } from '../mention-parser.js'
import { parseMissionDraft, shouldPreviewContract, formatContractPreview, type MissionDraft } from '../mission-draft.js'
import { truncateToDisplayWidth, displayWidth, ambiguousWideEnabled } from '../width.js'
import { boxCharsFor, boxInnerWidth } from '../box-chars.js'
import { useAsciiGlyphs } from '../term-caps.js'
import { appendHistoryAsync, nextHistoryAfterSubmit } from '../history.js'
import { renderPager, renderStarmap, renderCommandPalette, followListWindow, renderChronicle, renderTasks, renderDomainPicker, renderDomainGenesisCard, genesisCardMaxScroll, renderModelPicker, renderThemePicker, renderChoicePanel, renderPlanPicker, renderConnect, renderInitFlow, MODEL_PICKER_EFFORT_LEVELS, stepModelPickerEffort, type ModelPickerEffort } from '../format/overlay.js'
import type { PagerData, StarmapData, PaletteData, ChronicleData, TasksData, TasksGroup, TasksWorkerRow, DomainPickerData, ModelPickerData, ThemePickerData, ChoicePanelData, PlanPickerData, ChoiceEntry, ConnectOverlayData, InitOverlayData } from '../format/overlay.js'
import { ConnectFlow, DIY_PENDING_KEY_REF, type ConnectCommit, type ConnectProviderRef, type ConnectStepResult } from '../connect-flow.js'
import { VisionOnboardingFlow, type VisionCandidate, type VisionOnboardingRequest, type VisionOnboardingResult } from '../vision-onboarding-flow.js'
import { dismissOnboarding } from '../../onboarding.js'
import { readConnectDraft, saveConnectDraft, clearConnectDraft } from '../connect-draft.js'
import { readSecret, writeSecret, deleteSecret } from '../../config/secrets-store.js'
import { probeProvider } from '../../api/provider-probe.js'
import { errorRecoveryGuidance } from '../../api/error-classifier.js'
import { InitFlow, probeInitFlowInput, type InitCommit, type InitStepResult } from '../init-flow.js'
import { renderSettings } from '../format/settings.js'
import type { SettingsFlow, SettingsSaveRequest, SettingsSaveResult, SettingsView } from '../settings-flow.js'
import { parseScrollbackTranscript, searchTranscript, findNextMatch, findPrevMatch } from '../scrollback-transcript.js'
import { renderCockpit } from '../format/cockpit.js'
import type { CockpitSnapshot, Panel } from '../cockpit/types.js'
import { PANELS } from '../cockpit/types.js'
import { renderRewind, ACTIONS as REWIND_ACTIONS, type RewindData, type RewindFile, type RewindMode } from '../format/rewind.js'
import { renderHistorySearch, type HistorySearchData } from '../format/history-search.js'
import { searchHistory, loadHistory } from '../history.js'

// NOTE: exported for the mid-tui decomposition safety net. These are pure leaf
// helpers slated to move into a TUI format/util module when TuiApp is split;
// `app-core.test.ts` pins their behavior so the extraction stays observably
// identical. (The full class still needs a TTY harness — deferred to that work.)
export function formatElapsedShort(ms: number): string {
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`
  const mins = Math.floor(ms / 60000)
  const secs = Math.floor((ms % 60000) / 1000)
  return `${mins}m${secs}s`
}

/**
 * live region 行上限：终端高度感知（`min(28, rows - 1)`）。
 * 固定 28 在小终端上会让全量重写的 cursorUp 回顶量超出屏幕 → 错位/残影，
 * 故上限随终端高度收缩；下限 4 保输入框 chrome 最低可用。
 */
export function liveMaxRowsFor(rows: number): number {
  return Math.max(4, Math.min(28, (rows || 24) - 1))
}

/**
 * live 区同时展示的进行中工具卡数量上限，超出折叠成 `…(+N)` 一行。
 * 只有最新一张展开输出末尾，其余仅标题行——见 renderLive 的 2d 段。
 */
export const LIVE_TOOL_CARD_MAX = 3

/** live 区推理正文的显示行上限（高终端封顶值，矮终端按高度再收）。 */
export const THINKING_ROWS_MAX = 6

/**
 * chrome 段子代理带同时列出的 worker 数上限，超出折叠成 `…(+N)`。
 * 对标 CC 的「运行中每 agent 一行、整体一个面板」，详情走 /tasks。
 */
export const LIVE_FLEET_MAX = 4


/** Truncate a string (possibly containing ANSI) to fit within maxWidth display columns. */
export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (stringWidth(text) <= maxWidth) return text
  let out = ''
  let w = 0
  for (const ch of text) {
    const cw = stringWidth(ch)
    if (w + cw > maxWidth) break
    out += ch
    w += cw
  }
  return out
}

/** 判断输入是否更像文件路径而非 slash 命令。
 *  例如 `/src/main.ts` 或 `/tmp/foo bar` 应走普通文本流程，
 *  避免被当作未知 slash 命令报失败。
 *
 *  单段绝对路径（`/etc`、`/mnt`、`/usr`）在没有 isKnownCommand 谓词时
 *  回退到旧行为（视为命令）；传入谓词后，非已知命令的单段路径被
 *  正确识别为 Linux/WSL 文件路径。
 *
 *  若提供 isCommandPrefix，则第一 token 是某个已知命令前缀时视为 slash 命令，
 *  保证 `/h` 这类模糊输入仍能触发 slash 提示与补全。 */
export function looksLikeFilePath(
  input: string,
  isKnownCommand?: (name: string) => boolean,
  isCommandPrefix?: (name: string) => boolean,
): boolean {
  if (input.startsWith('~/')) return true
  // Windows 盘符路径 C:\... 或 C:/...（不是 slash 命令）
  if (/^[a-zA-Z]:[\\/]/.test(input)) return true
  if (!input.startsWith('/')) return false
  const rest = input.slice(1)
  const slashIdx = rest.indexOf('/')
  if (slashIdx !== -1) {
    const spaceIdx = rest.indexOf(' ')
    return spaceIdx === -1 || slashIdx < spaceIdx
  }
  // 单段 /xxx：可能是命令（/exit）也可能是路径（/etc, /mnt）
  if (isKnownCommand) {
    const firstToken = rest.split(/\s/)[0] ?? ''
    if (firstToken === '') return false
    if (isCommandPrefix?.(firstToken)) return false
    return !isKnownCommand(firstToken)
  }
  return false
}

/**
 * 入口图片规范化：过滤非法 data URL 并按 MAX_IMAGES 截断。
 * 气泡提示、终端渲染、onSubmitCallback 三处必须看到同一个数组。
 */
function normalizeSubmitImages(images?: string[]): string[] | undefined {
  if (!images || images.length === 0) return images
  return images.filter(u => parseImageDataUrl(u) !== null).slice(0, MAX_IMAGES)
}

/** 从 slashCommands 提示列表构建命令名谓词。
 *  slashCommands 的 name 含 `/` 前缀（如 `/exit`），谓词接收不带前缀的名字。 */
function buildCommandPredicate(commands: ReadonlyArray<{ name: string }>): (name: string) => boolean {
  const names = new Set(commands.map(c => {
    const n = c.name.trim()
    return n.startsWith('/') ? n.slice(1).split(/\s/)[0]! : n.split(/\s/)[0]!
  }))
  return (name: string) => names.has(name)
}

/** 构建命令前缀谓词，用于 looksLikeFilePath 区分 `/h` 这类模糊输入与真实路径。 */
function buildCommandPrefixPredicate(commands: ReadonlyArray<{ name: string }>): (name: string) => boolean {
  const prefixes = new Set<string>()
  for (const c of commands) {
    const n = c.name.trim()
    const base = n.startsWith('/') ? n.slice(1) : n
    const firstToken = base.split(/\s/)[0] ?? ''
    for (let i = 1; i <= firstToken.length; i++) {
      prefixes.add(firstToken.slice(0, i).toLowerCase())
    }
  }
  return (name: string) => prefixes.has(name.toLowerCase())
}

/** 草稿密钥的 secrets.json 引用名：preset 流程用草稿专用名（draft-<presetKey>），
 *  DIY 流程用占位名 diy-pending。绝不返回正式 provider 名——Esc 取消/草稿恢复
 *  路径不得覆盖在用凭证（PR#38 审查阻断 5）。 */
function draftSecretRef(presetKey?: string): string {
  return presetKey ? `draft-${presetKey}` : DIY_PENDING_KEY_REF
}

// 线框字符集与框体宽度公式已下沉到 src/tui/box-chars.ts —— 首屏欢迎框要与
// 输入框逐列等宽，公式必须只有一份。此处再导出保持既有引用路径不变。
export { boxCharsFor }

// ── State types ────────────────────────────────────────────────

export type ActivityPhase = 'idle' | 'thinking' | 'streaming' | 'waiting' | 'analyzing'

export interface TuiState {
  /** thinking 文本缓冲区 */
  thinkingText: string
  /** 是否正在流式输出 */
  isStreaming: boolean
  /** 是否正在 thinking */
  isThinking: boolean
  /** thinking 是否已展开 */
  thinkingExpanded: boolean
  /** 当前活动阶段 */
  phase: ActivityPhase
  /** 本轮耗时起始时间戳 */
  turnStartMs: number
  /** thinking 起始时间戳 */
  thinkStartMs: number
  /** 当前 turn 序号 */
  turnNumber: number
  /** 模型名称 */
  modelName: string
  /** 当前星域 glyph */
  domainGlyph?: string
  /** 当前星域名称 */
  domainName?: string
  /** 已提交的日志行数（用于 GlanceBar） */
  committedCount: number
  /** 常驻任务面板（todo 列表，canonical 源为 TodoStore） */
  todos: TodoItem[]
  /** GlanceBar todo 徽章变化高亮截止时间戳（0 = 无高亮；done 增加/total 变化时点亮 ~1s） */
  todoFlashUntil: number
  /** todo 面板展开态：全量渲染（含 completed 逐条回看）；ctrl+x t 切换 */
  todoExpanded: boolean
  /** 右侧面板是否展开（默认折叠） */
  sidePanelOpen: boolean
}

// ── Agent callbacks interface ──────────────────────────────────

// ── Agent callbacks interface (aligned to loop-types.ts AgentCallbacks) ──

import type { Usage } from '../../api/types.js'
import type { IntentPreview } from '../../agent/intent-preview.js'
import { describeIntentNote } from '../../agent/intent-preview.js'
import type { ApprovalResult } from '../../agent/approval-edit.js'
import type { DelegationActivity } from '../../tools/types.js'
import type { AutonomyCheckpointInfo } from '../../agent/loop-types.js'
import type { DomainDriftResult } from '../../agent/domain-drift-detector.js'
import { FleetRegistry } from '../fleet-registry.js'
import { JobRegistry, type JobRow } from '../job-registry.js'
import { renderJobsOverlay } from '../format/jobs-panel.js'
import { renderCachePanel, CACHE_PERIODS, type CachePanelData } from '../format/cache-panel.js'
import type { JobEvent } from '../../tools/job-store.js'
import { WorkerMirrorStore } from '../worker-mirror.js'
import { formatWorkerView } from '../format/worker-view.js'
import { shortOrderLabel } from '../../tools/worker-activity-stream.js'
import { profileLabel, authorityStarName } from '../format/profile-labels.js'
import { formatTokenCount, isReducedMotion } from '../format/spinner-status.js'
import { formatElapsed } from '../tool-elapsed.js'
import { WatchdogRecoveryPolicy } from '../../agent/watchdog-recovery-policy.js'
import { phaseStatusLabel } from '../phase-status.js'

export interface AgentCallbacks {
  onTextDelta: (text: string) => void
  onThinkingDelta: (thinking: string) => void
  onToolUse: (id: string, name: string, input: Record<string, unknown>) => void
  onToolResult: (id: string, name: string, result: string, isError?: boolean, rawPath?: string, uiContent?: string) => void
  onTurnComplete: (usage: Partial<Usage>, turnNumber: number, isFinal?: boolean) => void
  onError: (error: Error) => void
  onAbort: (reason?: string) => void
  onApprovalRequired: (id: string, name: string, input: Record<string, unknown>) => Promise<ApprovalResult | boolean>
  onCheckpoint?: (hash: string) => void
  onPhaseChange?: (phase: string, detail?: { tool?: string; reason?: string; voluntary?: boolean; source?: string }) => void
  onIntentNote?: (intent: IntentPreview) => void
  onDomainDrift?: (drift: DomainDriftResult) => void
  onSteerDrain?: () => string | null
  /** C3 — autonomy checkpoint pause (cruise) / progress ping (unleashed). */
  onAutonomyCheckpoint?: (info: AutonomyCheckpointInfo) => void
  /** T4 — structured per-worker delegation status/progress feeding the fleet read model. */
  onDelegationActivity?: (activity: DelegationActivity) => void
}

/**
 * GlanceBar 真实指标快照（由 main-ansi 闭包从 ctx.session 读取）。
 * 全部为「当前会话累计 / 估算」的真实值，避免 TUI 端自行 += 累加导致膨胀。
 */
export interface TuiMetrics {
  /** 当前估算 prompt token（含 prefix overhead，API 实际占用） */
  estimatedTokens: number
  /** 仅可见对话消息的本地 token 估算（不含系统提示/工具 schema/prefix overhead） */
  conversationTokens: number
  /** 模型上下文窗口 token 上限 */
  maxTokens: number
  /** 缓存命中率 0-1（近 N 回合优先，回退会话累计）；无数据为 null */
  cacheHitRate: number | null
  /** 缓存健康度状态（来自 projectCacheTelemetry 三态判定） */
  cacheStatus?: CacheStatus
  /** DeepSeek 计价时段（仅 provider 为 deepseek 官方时给出；其他 provider 缺省不显示） */
  pricingPhase?: 'peak' | 'offpeak'
  /** 会话累计费用（美元，单次从 getTotalUsage 计算，不累加） */
  cost: number
  /** 会话累计 input / output token（仅用于展示，不参与 += 累加） */
  inputTokens: number
  outputTokens: number
  /** API 最近一轮返回的真实 prompt_tokens（校准基准）；0 表示尚无数据 */
  lastRealPromptTokens: number
}

/** 指标提供者：返回 null 表示暂无（回退 TUI 内部估算）。 */
export type TuiMetricsProvider = () => TuiMetrics | null

/**
 * 单个工具流式输出累加器的字节上限。超限时保留尾部（live 卡片只展示末尾），
 * 防止超大输出工具（如 cat 100MB 文件逐 chunk 上行）撑爆内存。终态结果
 * 提交到 scrollback 时用完整 result 字符串，不受此 cap 影响。
 */
export { TOOL_ACCUMULATOR_MAX_BYTES, capToolAccumulator } from './tool-accumulator.js'

// ── /connect 输入光标闪烁参数 ──────────────────────────────────
// 静止常亮；移动/增删激活后按 500ms 间隔持续闪烁，直到换步/关闭复位。
const CONNECT_BLINK_PERIOD_MS = 500
const CONNECT_BLINK_TICK_MS = 250

// ── TuiApp ─────────────────────────────────────────────────────

export class TuiApp {
  // Engines
  private commit: CommitEngine
  private live: LiveEngine
  private overlay: OverlayEngine
  private input: InputHandler
  private resize: ResizeHandler
  private inputLine: InputLine
  /** 空闲期 CPR 探针定时器（2s，unref'd）——idle 无 ticker，靠它检出外来写入污染。 */
  private cprProbeTimer: ReturnType<typeof setInterval> | null = null
  /** TUI 存活期 stderr 护栏（游离 stderr 文本走 commit 通道，防污染 live region）。 */
  private outputGuard: OutputGuard | null = null
  /**
   * 输出冻结（Ctrl+S 切换，Ctrl+Q 解冻别名）——触摸终端（Termux 等）上滚动
   * 回看读的是终端自身 scrollback，任何光标寻址输出（spinner tick、空闲 CPR
   * 探针、流式帧）都会把视口拽回底部。冻结期间 stdout **零写入**：ticker 停、
   * live 不重绘、主屏 commit 进 mainCommitQueue 排队、探针静默——数据照常
   * 缓冲，解冻后 requestPump + flushNow 按序补放，零丢失。
   */
  private outputFrozen = false

  /**
   * 读屏档：停掉 120ms ticker 并丢弃 live region 的动态段。
   *
   * 动态段（spinner / 流式尾巴 / 进行中的工具卡）每 120ms 重画一次，读屏软件会
   * 把它反复念出来——`reducedMotion` 只冻结字形，救不了这个，重绘照旧。丢掉动态段
   * 后 live region 在整个 run 期间逐行不变，LiveEngine 的无变化短路就让它一个字节
   * 都不写，读屏软件自然无从复读。正文不受影响：blockWriter 分块提交静态回滚区，
   * 收尾在 handleTurnComplete 里 flush。
   */
  private screenReader = false


  // State
  private state: TuiState
  private get theme(): RivetTheme { return getTheme() }
  private columns: number
  private rows: number
  /** W-B1: tool lifecycle state manager */
  private toolGroupController = new ToolGroupController()
  /** W-B2: overlay navigation + data providers + exec callbacks */
  private overlayController = new OverlayController()
  /** /connect provider-setup wizard: state machine + live input buffer + error. */
  private connectFlow?: ConnectFlow
  private connectInput = ''
  private connectError?: string
  /** 输入光标在缓冲中的位置（支持 ←→ 移动与中间插入/删除）。 */
  private connectCursor = 0
  /** form 步当前选中字段下标。 */
  private connectFormFieldIndex = 0
  /** 渲染方回填的硬件光标落点（每帧更新，供 overlay engine 定位终端光标）。 */
  private connectCaret: { row: number; col: number } | null = null
  /** 最近一次移动/增删的时间戳（0 = 未激活）——激活后光标按 500ms 间隔闪烁。 */
  private connectEditActiveAt = 0
  /** 闪烁驱动定时器（仅闪烁期间存活）。 */
  private connectBlinkTimer: ReturnType<typeof setInterval> | null = null
  /** /vision 独立识图桥向导：只发 discover/onboard 请求，不复用通用 provider onboarding。 */
  private visionOnboardingFlow?: VisionOnboardingFlow
  private visionInput = ''
  private visionError?: string
  private visionExec?: (request: VisionOnboardingRequest) => Promise<{ candidates?: VisionCandidate[] }>
  /** /init 交互式初始化向导：无头状态机 + 当前步校验错误。 */
  private initFlow?: InitFlow
  private initError?: string
  /**
   * /config 设置面板：无头状态机 + 落盘通道。
   *
   * 落盘函数由 slash-commands 注入（同 /mirror 的先例——TUI 层直接调 config
   * setter），app.ts 因此不依赖 config manager，也不占用 registerOverlays
   * 那 14 个位置参数的第 15 位。
   */
  private settingsFlow?: SettingsFlow
  private settingsSave?: (request: SettingsSaveRequest) => SettingsSaveResult
  /** 面板关闭时回放到 scrollback 的保存结果（面板内的 status 行会随 alt-screen 消失）。 */
  private settingsNotice?: string
  /** W-B4: approval + intent pending state manager */
  private approvalIntentController = new ApprovalIntentController()
  /** 并行子代理舰队读模型（由 onDelegationActivity 事件流驱动） */
  private fleet = new FleetRegistry()
  /** 后台 job 读模型（由 main.ts 订阅 agent.jobs 的 'event' 驱动） */
  private jobsModel = new JobRegistry()
  /** 停止某个后台 job 的注入回调（main.ts 接线 agent.jobs.kill） */
  private jobKill: ((jobId: string) => boolean) | null = null
  /** 获取后台 job 日志文本的回调（main.ts 接线 agent.jobs.logs） */
  private jobLogs: ((jobId: string) => string | null) | null = null
  /** 已提交过「启动」行的 job id——防重复起跑提示（幂等） */
  private jobsSeenStart = new Set<string>()
  /** team_orchestrate 运行中的实时 TeamPanel（计划 DAG，运行态由 fleet 叠加）。
   *  从流式块中拦截的初始编码面板解码而来；终态委派到 scrollback 后清空。 */
  private liveTeamModel: TeamPanelModel | null = null
  /** council_convene 运行中的实时 CouncilPanel（从流式块拦截的帧解码而来；
   *  终态委派到 scrollback 后清空）。 */
  private liveCouncilModel: CouncilPanelModel | null = null
  /** 活动源归一容器。复用同一实例——renderLive 是 120ms tick 的热路径，
   *  每帧新建会连带丢掉投影结果的可缓存性。 */
  private readonly activityStore = new ActivityStore()
  /**
   * 中断收尾窗口：ESC 已把 TUI 置回 idle，但上一 run 的 promise 还没 settle，
   * AgentLoop 的 re-entry guard 期间仍会拒绝新 run。
   * 由 `handleAbort` 置位，`notifyRunSettled()` 清除。
   */
  private abortSettling = false
  /** 中断收尾窗口内提交的消息，等 run settle 后自动发出（见 notifyRunSettled）。 */
  private pendingSubmitAfterAbort: { text: string; images?: string[] } | null = null
  /**
   * ESC 回填资格：仅用户主动中断（ESC/Ctrl+C，非 watchdog/convergence 守护）
   * 开启的收尾窗口才置位。settle 时若 steer 队列仍有排队指引且输入框为空，
   * 把排队内容拉回输入框交还用户（仅用户主动 ESC；自然结束走自动发出）。
   */
  private abortSteerBackfill = false
  /** 守护中断 pending 标志：settle 时消费，用于区分「run 自然结束」与
   *  「守护中断」——后者不回填排队队列（watchdog 自动续跑 / convergence
   *   引导键入 continue，队列留待提交归并，见 queue-lane.test.ts）。 */
  private guardianAbortPending = false
  /**
   * handleTurnComplete 在飞计数。isFinal 先 await flush，agent.run() 的 finally
   * 会抢先 notifyRunSettled；此时不能立刻开新 run，否则会冲掉尚未 finalize 的
   * writer。settle 只置 pendingQueueDispatch，等 complete 收尾后再发出。
   */
  private turnCompleteInFlight = 0
  /** 最近一次真实提交的用户文本——run 报错时回填输入框（错误时刻的「未送达」兜底）。
   *  成功 settle（handleTurnComplete isFinal）或中断（handleAbort 已有回填路径）时清空。 */
  private lastSubmittedText: string | null = null
  private pendingQueueDispatch = false
  /**
   * 查询 agent 是否仍有未 settle 的 run（main.ts 注入 → `ctx.agent.isRunning()`）。
   *
   * `abortSettling` 不能只靠 `notifyRunSettled()` 单点清除：那条信号一旦有哪条
   * 路径漏掉，挂起的消息就永久发不出去——比它要修的 bug 更糟。有了探针，收尾
   * 窗口随时能对着真相校验，陈旧的标记会被就地清掉。未注入时（测试/非 TUI
   * 宿主）视为「没有在跑」，行为退回改动前。
   */
  private agentRunningProbe: (() => boolean) | null = null
  /** 已提交时间线的 team 波次序号（防止 wave 完成行重复 commit）。 */
  private lastCommittedTeamWave = 0
  /** 当前 wave 的首次观测时间（wave 完成行的耗时来源）。 */
  private teamWaveStartedAt = 0
  /** 当前在 pager overlay 中查看的 worker detail workerId；null 表示查看主 scrollback。 */
  private workerDetailWorkerId: string | null = null
  /** /jobs overlay → pager 跳转时暂存的 job id。 */
  private jobDetailId: string | null = null
  /** kill 指定 worker 的回调（main.ts 接线到 per-worker AbortController）。
   *  返回 true 表示 kill 信号已发出；null 表示当前会话不支持（键位静默无效）。 */
  private workerKill: ((workerId: string) => boolean) | null = null
  /** CLI reconcile：worker 存活查询（main.ts 接 coordinator.isWorkerRunning）。 */
  private workerRunningQuery: ((workerId: string) => boolean) | null = null
  /** CLI reconcile 周期定时器（5s；接线后启动，dispose 清理）。 */
  private fleetReconcileTimer: ReturnType<typeof setInterval> | null = null
  /** worker 消息镜像（切入视图的实时消息 tail 数据源，cap 50/worker）。 */
  private mirror = new WorkerMirrorStore()
  /** 进行中工具卡的 tail 切行缓存：key=toolId，value.ref 为累加器字符串引用。
   *  累加器 ≤64KB，renderLiveImpl 每帧对全串 split 在 60fps 下是 MB/s 级 GC churn——
   *  accumulate 每次 chunk 都会换字符串引用，故引用不变即可安全复用切分结果。 */
  private toolTailCache = new Map<string, { ref: string; lines: string[] }>()
  /** fleet 帧快照缓存：key = (fleet.version, 秒桶, cols, theme)。version 在 fleet
   *  任何真实状态变更时递增；秒桶让 elapsed 文案以 1s 粒度跳动（视觉不变）。
   *  子代理流式期间 60fps 重复帧不再重复付 sort/视图分配/O(W·R) 进度查询。 */
  private fleetFrameCache: {
    version: number
    second: number
    cols: number
    theme: RivetTheme
    activeWorkers: import('../fleet-registry.js').FleetWorkerView[]
    /** 主视图舰队面板行（仅 !showSidePanel 时按需构建；side panel 用 activeWorkers） */
    lines: string[] | null
    running: number
    unread: number
  } | null = null
  /** 已打过派发契约卡的 worker。不能用 `prev === undefined` 代替——contract
   *  理论上可能晚于该 worker 的首条事件到达，那样就永远补不上卡。 */
  private dispatchCardShown = new Set<string>()
  /** 当前切入查看的 worker（CC teammate 视图对标）；null 表示主视图。 */
  private viewingWorkerId: string | null = null
  /** 输入直达 worker 的回调（main.ts 接线到 coordinator.steerWorker）。
   *  返回 false 表示 worker 已不在跑（消息未送达）。 */
  private workerSteer: ((workerId: string, text: string) => boolean) | null = null

  // ── W3: 渲染 ticker + 指标 ───────────────────────────────────
  /** W-B3: stream render state manager (ticker/tick/lastActivity/header) */
  private streamRenderController = new StreamRenderController()
  /** W-B6: metrics + glance + domain state manager */
  private metricsGlanceController = new MetricsGlanceController()
  /** todo 列表访问器（main-ansi 读 TodoStore 单例） */
  private todosProvider?: () => TodoItem[]
  /** 当前已批准计划指针访问器（main-ansi 读 PromptEngine） */
  private activePlanProvider?: () => string | undefined
  /** Plan Mode 活动草稿路径（侧栏「起草中」） */
  private planDraftProvider?: () => { path: string; bytes?: number } | null | undefined
  /** 当前 GoalTracker 快照访问器 */
  private goalTrackerProvider?: () => import('../../agent/goal-tracker.js').GoalTracker | null
  /** 当前 PlanExecutionTrace 访问器 */
  private planTraceProvider?: () => import('../../agent/plan-execution-trace.js').PlanExecutionTrace | null
  /** 当前 plan-mode 状态访问器（返回是否处于 planning） */
  private planModeProvider?: () => boolean
  private askModeProvider?: () => boolean
  /** Shift+Tab 循环权限模式（由 main 注入）。plan-picker 打开时先关闭再循环。 */
  private planModeToggleHandler?: () => void
  /** Side panel 状态变化回调（用于持久化到 session metadata） */
  private onSidePanelChange?: (open: boolean) => void
  /** Block stream writer: chunks streaming text into display-sized blocks */
  private blockWriter: BlockStreamWriter
  /** Write batcher: coalesces render calls into a single LiveEngine.render() */
  private writeBatcher: WriteBatcher
  /** Stream renderer: incremental markdown commit + live tail (W1) */
  private streamRenderer: StreamRenderer
  /** Increments when StreamRenderer synchronously commits and renders a stable block. */
  private stableStreamCommitGeneration = 0

  // Agent callbacks (aligned to loop-types.ts AgentCallbacks)
  readonly callbacks: AgentCallbacks

  // External hooks
  private onSubmitCallback?: (text: string, images?: string[]) => void
  private onAbortCallback?: () => void
  private onExitCallback?: () => void
  /** External slash command handler. If set, it is tried before the registry. */
  private slashHandler?: (input: string) => boolean | Promise<boolean>
  /** Metadata-driven slash command registry (unified command framework). */
  private slashRegistry = new SlashCommandRegistry()
  /** 消息队列（W4a：streaming 时 Enter 入队，turn 边界 drain 注入） */
  readonly steerBuffer = new SteerBuffer()
  /**
   * /queue 显式排队 lane：简单 FIFO（不走 steer 的优先级/意图分类）。
   * busy/idle 都可入队；不进 steer 队列（不参与 turn 边界 drain），
   * 只在下一次 idle 提交时随 steer 残留一并归并进新 prompt 前部（见 handleInputSubmit）。
   */
  readonly queueLane: string[] = []
  /** agent 是否正在执行（submit → final turn complete 之间） */
  private agentBusy = false
  /** 终端支持 kitty keyboard protocol（start() 发 \x1B[?u 查询、收到回包才置
   *  true）——Shift+Enter 可区分，footer 换行提示据此裁剪。不支持者恒 false。 */
  private kittyKeyboard = false
  /** 主控模型是否原生支持 vision（用于图片附件提示）。 */
  private supportsVision = false
  /** 是否配置了独立的 vision bridge 模型（用于图片附件提示）。 */
  private visionBridgeEnabled = false
  private visionBridgeSource?: 'native' | 'configured' | 'auto' | 'same-provider' | 'none'
  /** 当前会话审批模式（继承自 agent config），供 worker pills badge */
  private _approvalMode: string = 'auto-safe'
  /**
   * Shift+Tab Plan Mode 叠层：进入 planning 前记住的审批模式。
   * 退出 plan 时原样恢复；`/yes` 等在 planning 期间改审批时同步更新此 stash。
   */
  approvalModeBeforePlan: string | null = null
  /** choice-panel 当前模式：'effort' (推理强度) / 'permission' (权限选择) / 'permission-yolo-confirm' (YOLO 二次确认) / 'plan-approval' (计划审批) / 'ask-user-question' (问题选项选择) / 'disconnect' (断开服务商选择) / 'disconnect-confirm' (断开二次确认) / 'disconnect-retarget' (默认 provider 改设新默认) */
  choicePanelKind: 'effort' | 'permission' | 'permission-yolo-confirm' | 'plan-approval' | 'ask-user-question' | 'disconnect' | 'disconnect-confirm' | 'disconnect-retarget' = 'effort'
  /** 当前待审批计划信息（plan-approval 面板使用）。 */
  pendingPlanApproval: PlanSubmittedInfo | undefined = undefined
  /** 待审批计划正文预览摘要（开面板时一次性提取；随面板关闭/重开更新）。 */
  planApprovalExcerpt: string | undefined = undefined
  /** 钉底审阅卡正文（剥 chrome 后的全文；缺席则只画标题）。 */
  planApprovalBody: string | undefined = undefined
  /** 提交日期 YYYY-MM-DD。不标模型档。 */
  planApprovalDate: string | undefined = undefined
  /** 审阅卡正文滚动偏移（行）。 */
  private planReviewScroll = 0
  /** f 键反馈输入态：字打进输入框，Enter 驳回并提交。 */
  private planReviewFeedbackMode = false
  /**
   * 计划全文预览（复用 pager overlay，仿 jobDetail 指针）：
   * slug 指正式计划（pager provider 用 readPlanSync 读盘）；draftPath 指
   * 撰写中的活动草稿（/plan-view 无参时进入，每帧现读、随 agent 写入刷新）。
   * returnTo 记录退出 pager 后回哪个面板（审批卡 / plan-picker）。
   */
  private planPreview: { slug: string; draftPath?: string; returnTo?: 'approval' | 'plan-picker' } | null = null
  /** /handoff 登记的归档任务：交接 turn 完成（isFinal）后把项目内 .rivet/HANDOFF.md
   *  拷贝归档到会话目录 <id>.handoff.md（loadPrevHandoff 注入管线认的位置）。 */
  pendingHandoffCopy: { src: string; dest: string; sinceMs: number } | undefined = undefined
  /** 60% 交接提醒每会话至多一次。 */
  private handoffNudgeShown = false
  /** Goal 计划倒计时自动批准（2026-07-24，与 sidecar 同语义）：
   *  goal 激活 + 计划提交 → 武装；到期守卫复核通过 → onPlanAutoApproveFire；
   *  用户任何参与（批准/驳回/写反馈/新提交/主动 abort）即取消；
   *  Esc 收起面板不取消——倒计时退到 GlanceBar 徽章继续走。 */
  private planAutoApproveTimer: ReturnType<typeof setTimeout> | null = null
  private planAutoApproveTick: ReturnType<typeof setInterval> | null = null
  planAutoApproveSlug: string | undefined = undefined
  planAutoApproveDeadlineMs: number | undefined = undefined
  /** 到期触发回调（main.ts 装配：approvePlanAndKickoff + 通知）。 */
  onPlanAutoApproveFire?: (slug: string) => void
  /** 审阅卡结算（与 choicePanelExec 同 id）。测试可直接挂；生产走 overlay 装配。 */
  onPlanReviewSettle?: (id: string) => void
  /** 触发守卫探针（main.ts 装配：idle/goalActive/planStillSubmitted）。 */
  planAutoApproveGuardsProvider?: () => { idle: boolean; goalActive: boolean; planStillSubmitted: boolean }

  /** 武装倒计时（重复武装 = supersede 旧定时器）。 */
  armPlanAutoApprove(slug: string, delayMs: number): void {
    this.cancelPlanAutoApprove()
    this.planAutoApproveSlug = slug
    this.planAutoApproveDeadlineMs = Date.now() + delayMs
    // 1s tick 驱动 overlay caption 与 GlanceBar 徽章的倒计时重绘
    this.planAutoApproveTick = setInterval(() => this.renderLive(), 1000)
    this.planAutoApproveTick.unref?.()
    this.planAutoApproveTimer = setTimeout(() => this.firePlanAutoApprove(), delayMs)
    this.planAutoApproveTimer.unref?.()
    this.renderLive()
  }

  /** 取消倒计时（用户参与 / 触发后 / dispose 共用）。 */
  cancelPlanAutoApprove(): void {
    if (this.planAutoApproveTimer) { clearTimeout(this.planAutoApproveTimer); this.planAutoApproveTimer = null }
    if (this.planAutoApproveTick) { clearInterval(this.planAutoApproveTick); this.planAutoApproveTick = null }
    this.planAutoApproveSlug = undefined
    this.planAutoApproveDeadlineMs = undefined
  }

  /** 徽章剩余秒（GlanceBar 快照与 overlay caption 共用；未武装 = undefined）。 */
  get planAutoApproveRemainSec(): number | undefined {
    if (this.planAutoApproveDeadlineMs === undefined) return undefined
    return remainingSec({ slug: this.planAutoApproveSlug ?? '', deadlineMs: this.planAutoApproveDeadlineMs }, Date.now())
  }

  /** 空闲判定（main.ts 的倒计时守卫探针使用；state/agentBusy 均为私有）。 */
  get isAgentBusy(): boolean {
    return this.agentBusy
  }

  private firePlanAutoApprove(): void {
    const slug = this.planAutoApproveSlug
    const deadlineMs = this.planAutoApproveDeadlineMs
    if (slug === undefined || deadlineMs === undefined) return
    // 守卫复核：busy/goal 退场/计划已被处理 → 不触发（退化为纯手动审批）。
    const guards = this.planAutoApproveGuardsProvider?.()
    const fire = !!guards && shouldFire({ slug, deadlineMs }, Date.now(), guards)
    this.cancelPlanAutoApprove()
    if (fire) {
      this.clearPlanReviewState()
      this.onPlanAutoApproveFire?.(slug)
      this.renderLive()
    }
  }
  /**
   * ask_user_question 多题流：当前题索引 + drafts。
   * `pendingAskUserQuestion` 仍暴露当前题，兼容旧回调路径。
   */
  pendingAskFlow: {
    questions: AskUserQuestionItem[]
    index: number
    drafts: AskAnswerDraft[]
  } | undefined = undefined
  /** 当前待回答的可选择问题（ask-user-question 面板使用）。 */
  get pendingAskUserQuestion(): AskUserQuestionItem | undefined {
    const flow = this.pendingAskFlow
    if (!flow) return undefined
    return flow.questions[flow.index]
  }
  set pendingAskUserQuestion(q: AskUserQuestionItem | undefined) {
    // Legacy single-question assign — only used by cleanup resets to undefined.
    if (!q) this.pendingAskFlow = undefined
  }
  /** choice-panel 子模式：select（选选项）/ input（在 overlay 内输入文字）。 */
  choicePanelSubMode: 'select' | 'input' = 'select'
  /** choice-panel 输入子模式下的实时缓冲。 */
  choicePanelInputBuffer: string = ''
  /** 输入子模式光标位（buffer 内 UTF-16 偏移）——左右移动 / 插入 / 粘贴的落点。 */
  choicePanelInputCursor = 0
  /** choice-panel 输入子模式的硬件光标落点（渲染方回填，caret() 供引擎定位）。 */
  private choicePanelCaret: { row: number; col: number } | null = null
  /** model-picker effort draft（CC 对标）：面板打开时初始化为当前生效档，
   *  </> 循环步进；提交时与 initial 比对——有显式改动才随模型一起生效。 */
  modelPickerEffortDraft?: import('../format/overlay.js').ModelPickerEffort
  modelPickerEffortInitial?: import('../format/overlay.js').ModelPickerEffort
  /** domain-picker 的创世碑文视图（g 键进入）。 */
  domainGenesisMode = false
  /** 碑文正文滚动偏移（行）。 */
  domainGenesisScroll = 0
  /** 输入子模式提交时的语义目标。 */
  choicePanelInputFor?: 'plan-reject-comment' | 'ask-other'
  /** GlanceBar 信息密度（Wave 2 减密）：compact 默认四项，`/glance full` 切全量。 */
  glanceDensity: 'compact' | 'full' = 'compact'
  /** 可脚本化 statusline 文本（ui.statusLine.command stdout 首行），渲染在输入框上方。 */
  private statusLineText: string | null = null
  /**
   * 会话工作区根目录（agent.cwd）。审批时据此判定「工作区外路径」以决定是否
   * 显示「批准并记住此目录」选项；未注入（测试/无头环境）时不显示该选项。
   * /cd 切目录后经 setCwd() 刷新——顶框 cwd 显示与审批判定都跟新值一致。
   */
  private sessionCwd?: string
  /**
   * Run 世代计数 —— 唯一权威的「当前 run」标识。
   * 每次 abort 自增；被中断的旧 run 的迟到回调（经 bridge 包裹时捕获的旧 gen）
   * 与当前 gen 不符即被丢弃，杜绝旧 run 的 onAbort/onTextDelta 污染新 run 状态。
   */
  private _runGen = 0
  /** Watchdog stall 自动恢复状态机（consecutive/session-total/进度感知配额），
   *  与桌面 sidecar 共享同一实现 — 见 src/agent/watchdog-recovery-policy.ts。 */
  private readonly watchdogPolicy = new WatchdogRecoveryPolicy()
  /** Timestamp of the last approval denial. A watchdog abort that happens while
   *  (or just after) a tool is blocked on approval must NOT auto-continue: the
   *  resubmitted 'continue' just re-emits the same approval-blocked call, giving
   *  the deny→continue→deny self-driving loop. Suppress auto-continue in that
   *  window and let the user intervene instead. */
  private _lastApprovalDeniedAt = 0
  private static readonly APPROVAL_STALL_GRACE_MS = 5_000
  /** 是否已经执行过 start()。构造后到 start() 之间的 setter 不应触发渲染，
   *  否则会在 main.ts 清屏前画出一版输入框；若清屏/flush 出现偏差，旧帧会
   *  残留在欢迎屏上方形成重影。 */
  private started = false
  /** Ctrl+X leader key 待处理状态（用于 ctrl+x r 打开右侧面板） */
  private sidePanelLeaderPending = false
  private sidePanelLeaderTimer: ReturnType<typeof setTimeout> | null = null
  /** todo 徽章高亮熄灭定时器（活动期外 ticker 停转，靠它在 1s 后重绘恢复正常色） */
  private todoFlashTimer: ReturnType<typeof setTimeout> | null = null
  /** 本 run 是否写入过 todo（用户提交重置，updateTodos 检测到清单签名变化置位）。
   *  用于跨 run 陈旧显示 gate：新 run 未写 todo 前，上一轮**全部完成**的清单
   *  不再占用任务面板与 GlanceBar 徽章（观感即「≡ 任务 · 5/5 不更新」——旧值
   *  复活挂在新 run 头上，直到 AI 首次 todo write）。部分完成清单不受影响
   *  （AI 大概率续写）；守护中断的自动续跑视为同一任务的延续，不重置。 */
  private todosWrittenThisRun = false
  /** 监控型 overlay（激活期间随数据/tick 实时重绘，而非打开瞬间的快照） */
  private static readonly LIVE_OVERLAY_IDS: ReadonlySet<string> = new Set(['tasks', 'cockpit', 'jobs'])
  /** live overlay 上次重绘时间戳（节流 ≥400ms） */
  private liveOverlayLastRender = 0
  /** 清理 Ctrl+X leader 状态（overlay/模式切换时调用，防止后续按键误触 side panel）。 */
  private clearSidePanelLeader(): void {
    this.sidePanelLeaderPending = false
    if (this.sidePanelLeaderTimer) { clearTimeout(this.sidePanelLeaderTimer); this.sidePanelLeaderTimer = null }
  }

  // ── W4b: 输入辅助（W-B5: fields moved to InputController） ───
  /** W-B5: input state manager (slash/file-completion/history/ctrl+c/esc) */
  private inputController = new InputController()
  /** 协同建议（/team /scout /council 输入时情境提示）——见 engine/orchestration-hint.ts。 */
  private readonly orchHint: OrchestrationHint
  /** 输入框最近一次获得焦点的时间戳，用于 Ctrl+V 剪贴板图片防抖 */
  private lastInputFocusAt = 0
  /** overlay 退出回放排队的主屏 commit 时抑制每个条目的 renderLive，最后统一画一帧。 */
  private suppressCommitRender = false
  /** renderLive requests deferred while an async overlay-commit pump is active. */
  private deferredCommitRender = false
  /** 原始 stdout（用于直接写 DEC 私有模式如 bracketed paste 开关） */
  private stdout: WriteStream
  private terminalRestored = false
  private riskExplainer?: RiskExplainer
  private sideQuestionAsker?: SideQuestionAsker
  /** `/btw` 浮层状态。**只活在这里**——一个字节都不进 session.messages。 */
  private sideQuestion: SideQuestionData | null = null
  private sideQuestionScroll = 0
  private readonly perfMonitor?: TuiPerfMonitor
  private readonly onPerfSummary?: (summary: TuiPerfSummary) => void
  private perfSummaryFlushed = false

  constructor(options: {
    stdout: WriteStream
    stdin: ReadStream
    /** 初始终端尺寸 */
    cols: number
    rows: number
    /** 模型名称 */
    modelName?: string
    /** 历史记录 */
    history?: string[]
    /** 模型上下文窗口（tokens） */
    contextWindow?: number
    /** git 分支名 */
    gitBranch?: string
    /** 会话工作区根目录（agent.cwd）。用于审批时判定工作区外路径。 */
    cwd?: string
    perfMonitor?: TuiPerfMonitor
    onPerfSummary?: (summary: TuiPerfSummary) => void
    /** 协同建议开关（ui.orchestrationHint / RIVET_ORCHESTRATION_HINT 关闭时传 false；默认开）。 */
    orchestrationHint?: boolean
  }) {
    // theme is now a dynamic getter — always reads current activeTheme
    this.stdout = options.stdout
    this.columns = options.cols
    this.rows = options.rows
    this.metricsGlanceController.contextWindow = options.contextWindow
    this.metricsGlanceController.gitBranch = options.gitBranch
    this.sessionCwd = options.cwd
    this.perfMonitor = options.perfMonitor
    this.onPerfSummary = options.onPerfSummary
    this.orchHint = new OrchestrationHint(options.orchestrationHint !== false)

    // Initialize engines
    this.commit = new CommitEngine({ stdout: options.stdout })
    this.live = new LiveEngine({
      stdout: options.stdout,
      reservedRows: 3,
      maxRows: liveMaxRowsFor(options.rows),
      // CPR 自愈：帧后/空闲探针经 stdout 发出，响应由 InputHandler 的 onCpr 喂回；
      // 检出污染（外来写入移动光标）→ 重渲染走恢复路径重锚帧。
      onProbeRequest: () => { options.stdout.write(QUERY_CURSOR_POS) },
      onPolluted: () => { this.renderLive() },
    })
    this.overlay = new OverlayEngine({
      stdout: options.stdout,
      getSize: () => ({ cols: this.columns, rows: this.rows }),
      // alt screen 切换统一驱动 CPR 污染检测的暂停/恢复，覆盖所有 overlay
      // 入口（含直接调 this.overlay.activate 的快捷键路径）。
      onEnterAltScreen: () => this.live.suppressProbe(),
      // 退出 alt screen 时恢复探针，并驱动 pump 回放 overlay 期间排队的主屏
      // commit（deactivateInternal 先置 active=null 再退 alt screen，同步条目
      // 在 pump 同步段内排空，不会递归入队；异步条目后续微任务续跑）。
      onExitAltScreen: () => {
        this.live.resumeProbe()
        this.requestPump()
      },
    })
    this.input = new InputHandler({ stdin: options.stdin, mode: 'input' })
    this.input.onCpr((row, col) => this.live.noteCpr(row, col))
    this.resize = new ResizeHandler({ stdout: options.stdout })
    this.inputController.inputHistory = options.history ?? []
    this.inputLine = new InputLine({
      history: options.history,
      placeholder: '询问任何事，或 / 唤起命令',
      // 输入变化（含 setValue 程序化写入）实时刷新 slash 菜单状态；
      // 渲染仍由 handleKey 返回事件 / 显式 renderLive 驱动。
      onChange: (value) => {
        this.inputController.refreshSlash(value)
        // 协同建议：本地启发式（微秒级纯函数），翻转时下一帧渲染自然带出。
        this.orchHint.evaluate(value, {
          planMode: (() => { try { return this.planModeProvider?.() ?? false } catch { return false } })(),
          askMode: (() => { try { return this.askModeProvider?.() ?? false } catch { return false } })(),
          streaming: this.isAgentActive(),
          routingConfigured: (() => { try { return this.routingConfiguredProvider?.() ?? true } catch { return true } })(),
        })
      },
      onTabComplete: () => this.handleTabComplete(),
      // handleInputSubmit 是 async：回调内任何异常都会成为 rejected Promise，
      // 必须显式 catch 收口为一条警告行，否则 void 掉的是 unhandled rejection。
      onSubmit: (text, images) => {
        void this.handleInputSubmit(text, images).catch((err: unknown) => {
          this.commitStatic(color(`⚠ 提交处理出错：${err instanceof Error ? err.message : String(err)}`, this.theme.warning))
        })
      },
    })

    // Write batcher: coalesce render calls
    this.writeBatcher = new WriteBatcher(() => {
      if (this.perfMonitor?.enabled) {
        this.perfMonitor.measure('flush', () => this.renderLive())
      } else {
        this.renderLive()
      }
    })

    // Stream renderer: stable markdown prefix → scrollback, tail → live region
    this.streamRenderer = new StreamRenderer({
      commit: (ansi) => {
        this.commitAbove(() => {
          if (!this.streamRenderController.assistantHeaderDone) {
            this.commitAssistantHeader()
          }
          this.commit.write({ text: ansi, trailingNewline: true })
          this.state.committedCount++
        })
      },
      getColumns: () => this.columns,
      getTheme: () => this.theme,
      getThemeKey: () => getActiveThemeName(),
      perfMonitor: this.perfMonitor,
    })

    // Block stream writer: buffers streaming text into display blocks
    this.blockWriter = new BlockStreamWriter(
      { minChars: 60, maxChars: 200, idleMs: 180 },
      (block: string) => {
        // Stable commits synchronously render through commitAbove/flushNow. Only
        // schedule when the block remains an unstable live tail.
        if (this.streamRenderer.push(block)) {
          this.stableStreamCommitGeneration++
        } else {
          this.writeBatcher.schedule()
        }
      },
    )

    // Initialize state
    this.state = {
      thinkingText: '',
      isStreaming: false,
      isThinking: false,
      thinkingExpanded: true,
      phase: 'idle',
      turnStartMs: Date.now(),
      thinkStartMs: 0,
      turnNumber: 0,
      modelName: options.modelName ?? 'unknown',
      committedCount: 0,
      todos: [],
      todoFlashUntil: 0,
      todoExpanded: false,
      sidePanelOpen: false,
    }

    // Wire resize
    this.resize.onResize((cols, rows) => {
      this.columns = cols
      this.rows = rows
      this.live.setMaxRows(liveMaxRowsFor(rows))
      this.rerender()
    })

    // Wire bracketed paste: 整段插入光标处，批渲染（避免逐 chunk 全量重写）
    // 审批/意图/overlay 模式下不处理粘贴——粘贴文本会"穿透"到输入框，
    // 退出模式后出现幽灵文本。
    this.input.onPaste(async (text) => {
      const mode = this.input.getMode()
      if (mode !== 'input') return
      // Connect overlay active → route paste into connectInput, not the main input box
      if (this.overlay.activeId() === 'connect' && this.connectFlow) {
        const view = this.connectFlow.view()
        if (view.kind === 'input') {
          const before = this.connectInput.slice(0, this.connectCursor)
          const after = this.connectInput.slice(this.connectCursor)
          this.connectInput = before + text + after
          this.connectCursor += text.length
          this.connectEditActiveAt = Date.now()
          this.connectError = undefined
          this.overlay.rerender()
        }
        return
      }
      if (this.overlay.activeId() === 'vision-onboarding' && this.visionOnboardingFlow?.view().kind === 'input') {
        const before = this.visionInput.slice(0, this.connectCursor)
        const after = this.visionInput.slice(this.connectCursor)
        this.visionInput = before + text + after
        this.connectCursor += text.length
        this.visionError = undefined
        this.overlay.rerender()
        return
      }
      // Settings panel editing a text field → paste into its buffer (proxy URL,
      // vision prompt), not the main input box.
      if (this.overlay.activeId() === 'settings' && this.settingsFlow?.isTextEditing()) {
        this.settingsFlow.typeChar(text.replaceAll('\n', ' '))
        this.overlay.rerender()
        return
      }
      // choice-panel 输入子模式（自定义回答 / 驳回反馈）→ 粘贴进 overlay 缓冲光标处。
      // 此前落到下方「其他 overlay 丢弃」分支被静默吞掉——用户粘贴无任何反馈。
      if (this.overlay.activeId() === 'choice-panel' && this.choicePanelSubMode === 'input') {
        const pasted = text.replaceAll('\r', '').replaceAll('\n', ' ')
        if (pasted) {
          const cur = Math.min(Math.max(this.choicePanelInputCursor, 0), this.choicePanelInputBuffer.length)
          this.choicePanelInputBuffer = this.choicePanelInputBuffer.slice(0, cur) + pasted + this.choicePanelInputBuffer.slice(cur)
          this.choicePanelInputCursor = cur + pasted.length
          this.overlay.rerender()
        }
        return
      }
      // Other overlays active → don't paste into main input
      if (this.overlay.isActive()) return
      // 确认窗口内粘贴 = 继续对话：取消 pending-exit 再插入文本
      // （与打字路径的取消同一状态位，见 handleKey 的 Normal input processing）。
      if (this.inputController.ctrlCPendingSince > 0) {
        this.inputController.clearExitConfirm()
        this.renderLive()
      }

      // 右键粘贴/终端菜单粘贴走 bracketed paste 文本通道，不触发 ctrl_v 按键，
      // 因此不会调 handleCtrlV → readImageFromClipboard。若剪贴板当前是图片，
      // 粘贴进来的文本是图片字节的乱码——在文本处理前先尝试读剪贴板图片，
      // 命中则附图并吞掉这段 paste，避免乱码文本污染输入框。
      // （与 Ctrl+V 互斥：右键粘贴产生 paste 事件，Ctrl+V 产生 ctrl_v 按键，不会同时触发）
      if (this.inputLine.images.length < MAX_IMAGES) {
        try {
          const imgResult = await readImageFromClipboard()
          if (imgResult) {
            this.inputLine.addImage(imgResult.dataUrl)
            this.writeBatcher.schedule()
            return // 吞掉 paste——不插入乱码文本
          }
        } catch {
          // 剪贴板读图失败（无图/不支持）→ 落入正常文本粘贴
        }
      }

      const trimmed = text.trim()
      // 粘贴内容看起来像图片路径 → 尝试加载为附件；失败则回退为普通文本。
      if (trimmed && looksLikeImagePath(trimmed) && !trimmed.includes('\n')) {
        if (this.inputLine.images.length >= MAX_IMAGES) {
          this.commitStatic(color(`⚠ 最多附加 ${MAX_IMAGES} 张图片`, this.theme.warning))
          this.renderLive()
          return
        }
        try {
          const attachment = await loadImageAttachment(resolve(trimmed))
          this.inputLine.addImage(attachment.dataUrl)
          this.writeBatcher.schedule()
          return
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          this.commitStatic(color(`⚠ 图片加载失败: ${message}`, this.theme.warning))
          this.renderLive()
          // fallthrough to normal text paste
        }
      }

      this.inputLine.insertText(text)
      this.inputController.fileCompletion = null
      this.writeBatcher.schedule()
    })

    // F 键增强路径：f1-f8 映射高频命令，经 slash 管线分发（与打字输入等价）。
    // overlay 激活时不路由——面板内按键归 overlay 导航，避免面板叠加/误触关闭。
    // f9-f12 留空扩展位。键位提示回填在 command-palette.ts 的 PaletteCommand.hotkey。
    const FKEY_SLASH: Record<string, string> = {
      f1: '/help', f2: '/tasks', f3: '/cache', f4: '/cockpit',
      f5: '/theme', f6: '/model', f7: '/permission', f8: '/sessions',
    }

    // Wire input: character input → inputLine → live region update
    this.input.onAnyKey((key) => {
      // ── Approval mode short-circuit (顶部，先于一切普通输入) ──
      // 审批态只解析审批动作，绝不落入 slash / inputLine —— 杜绝 Enter 双触发
      if (this.input.getMode() === 'approval' && this.approvalIntentController.approvalPending) {
        const c = key.char.toLowerCase()
        if (key.name === 'ctrl_c') {
          this.resolveApproval(false)
          // 继续走下方全局 ctrl_c（abort / exit）
        } else {
          const ctrl = this.approvalIntentController
          // 选项数与 formatApprovalPrompt 的渲染口径一致：已给过解释就没有「解释风险」行；
          // 工作区外路径审批多一个「批准并记住此目录」。
          const hasRisk = !!(ctrl.riskExplanation || ctrl.riskExplainPending)
          const optionCount = (hasRisk ? 3 : 4) + (ctrl.showRememberOption ? 1 : 0)
          if (key.name === 'up' || key.name === 'down') {
            const delta = key.name === 'up' ? -1 : 1
            ctrl.approvalOptionIndex = (ctrl.approvalOptionIndex + delta + optionCount) % optionCount
            this.renderLive()
          } else if (key.name === 'return') {
            // Enter 按光标行分发；y/n/e/r/^E 直达键与光标确认等价。
            if (ctrl.approvalOptionIndex === 0) this.resolveApproval({ approved: true })
            else if (ctrl.approvalOptionIndex === 1) this.resolveApproval(false)
            else if (ctrl.approvalOptionIndex === 2) this.enterApprovalEditMode()
            else if (ctrl.showRememberOption && ctrl.approvalOptionIndex === 3) this.resolveApproval({ approved: true, remember: true })
            else if (ctrl.showRememberOption && ctrl.approvalOptionIndex === 4) this.requestRiskExplanation()
            else this.requestRiskExplanation()
          } else if (c === 'y') this.resolveApproval({ approved: true })
          else if (key.name === 'escape' || c === 'n') this.resolveApproval(false)
          else if (key.name === 'ctrl_e') this.requestRiskExplanation()
          else if (c === 'e') this.enterApprovalEditMode()
          else if (c === 'r' && ctrl.showRememberOption) this.resolveApproval({ approved: true, remember: true })
          // 其余按键在审批态一律吞掉，不污染输入框。
          return
        }
      }

      // ── Approval edit mode short-circuit ──
      // 编辑工具入参模式：Enter 解析 JSON → approve with editedInput，
      // Esc 回到审批 y/n 提示。其余键落入 InputLine 正常编辑。
      if (this.approvalIntentController.approvalEditMode && this.approvalIntentController.approvalPending) {
        if (key.name === 'ctrl_c') {
          this.resolveApproval(false)
          this.approvalIntentController.approvalEditMode = false
          this.approvalIntentController.approvalEditError = ''
          // 继续走下方全局 ctrl_c（abort / exit）
        } else if (key.name === 'escape') {
          // Back to approval mode
          this.approvalIntentController.approvalEditMode = false
          this.approvalIntentController.approvalEditError = ''
          this.inputLine.setValue('')
          this.input.setMode('approval')
          this.renderLive()
          return
        } else if (key.name === 'return') {
          // Try to parse edited JSON
          try {
            const edited = JSON.parse(this.inputLine.value)
            this.approvalIntentController.approvalEditMode = false
            this.approvalIntentController.approvalEditError = ''
            this.inputLine.setValue('')
            this.resolveApproval({ approved: true, editedInput: edited })
          } catch (err) {
            this.approvalIntentController.approvalEditError = `Invalid JSON: ${(err as Error).message}`
            this.renderLive()
          }
          return
        }
        // All other keys (chars, arrows, backspace, etc.) fall through to InputLine
      }

      // ── Overlay 交互导航（pager 翻页 / palette 选择执行）──
      // overlay 激活时按键先路由进 overlay：原实现仅 Esc 关闭，pager 不能翻页、
      // palette 不能选 → overlay 形同只读弹窗。这里补全导航与执行。
      if (this.overlay.isActive()) {
        if (this.handleOverlayKey(key)) return
        // 非搜索型 overlay 未消费的输入键吞掉：overlay 全屏遮挡时，可打印字符 /
        // backspace / Enter 落到被遮住的 composer 就是幽灵输入（Enter 甚至会
        // 提交隐藏文本）。搜索型（palette/history-search）的输入框即搜索框，
        // 字符必须照常下落；Esc/Ctrl+C 等功能键继续走下方全局兜底。
        const isSearchOverlay = this.overlay.activeId() === 'command-palette' || this.overlay.activeId() === 'history-search'
        if (!isSearchOverlay && (this.isPrintableKey(key) || key.name === 'backspace' || key.name === 'return')) return
      }

      // 计划审阅卡钉在 chrome：overlay 未开时先吃按键，避免漏进 slash / 输入框。
      if (this.pendingPlanApproval && !this.overlay.isActive() && this.handlePlanReviewKey(key)) return

      // ── Global shortcuts (before input line processing) ──────
      if (key.name === 'shift_tab') {
        // plan-picker 打开时先关闭，再循环权限模式（不再从 Shift+Tab 打开 picker）。
        const pickerOpen = this.overlay.isActive() && this.overlay.activeId() === 'plan-picker'
        if (pickerOpen) this.deactivateOverlay()
        this.planModeToggleHandler?.()
        this.renderLive()
        return
      }
      if (key.name === 'ctrl_c') {
        if (this.inputController.ctrlCPendingSince > 0) {
          // 窗口内二次 Ctrl+C → 退出。优先于 agent-active 判定：agent 卡住
          // （不 settle）时这是唯一逃生通道——否则二次 Ctrl+C 又被 abort 吃掉。
          this.inputController.clearExitConfirm()
          this.dispose()
          if (this.onExitCallback) {
            this.onExitCallback()
          } else {
            process.exit(0)
          }
        } else if (!this.isAgentActive() && this.inputLine.value.length > 0) {
          this.inputLine.setValue('') // 空闲 + 有输入：清空草稿；空输入才进退出确认
          this.renderLive()
        } else {
          // 活跃首按 = interrupt 并并行开窗（卡死逃生，app-exit-escape 不变量）；空输入首按只进窗。
          if (this.isAgentActive()) this.handleAbort()
          const ic = this.inputController
          if (ic.ctrlCExitTimer !== null) clearTimeout(ic.ctrlCExitTimer)
          ic.ctrlCPendingSince = Date.now()
          ic.ctrlCExitTimer = setTimeout(() => { ic.ctrlCPendingSince = 0; ic.ctrlCExitTimer = null }, 2000)
          this.renderLive()
        }
        return
      }
      const fkeyCmd = FKEY_SLASH[key.name]
      if (fkeyCmd && !this.overlay.isActive()) {
        void this.tryDispatchSlash(fkeyCmd)
        return
      }
      if (key.name === 'ctrl_p') {
        // Ctrl+P → 命令面板开关。原 Ctrl+Esc 三条送达路径全断：Windows 宿主
        // 被「开始菜单」抢占（事件到不了终端）、传统转义序列下与单独 Esc 同码
        // （0x1B）、kitty 增强键盘的 \x1B[27;5u 未被解析器映射。Ctrl+P（0x10）
        // 在所有终端可靠送达。翻历史入口不受影响：单行 ↑/↓、Ctrl+N、Ctrl+R。
        if (this.overlay.isActive() && this.overlay.activeId() === 'command-palette') {
          this.deactivateOverlay()
        } else {
          this.activateOverlay('command-palette')
        }
        return
      }
      if (key.name === 'escape' && key.ctrl) {
        // Ctrl+Esc → 激活命令面板（见上方 Ctrl+P 注释：此路径当前解析器
        // 不可达，保留给未来增强键盘协议映射，主键位为 Ctrl+P）
        this.overlayController.resetNav()
        this.overlay.activate('command-palette')
        return
      }
      if (key.name === 'escape') {
        // slash 菜单打开时：Esc 优先关闭菜单——不触发 vim 切换/双击 rewind/
        // 清空输入。再按一次 Esc 才走下方原语义（清空/确认窗口取消等）。
        if (this.inputController.slashMenu.open) {
          this.inputController.closeSlash()
          this.renderLive()
          return
        }
        // 协同建议行在场时：Esc 关闭建议并本会话不再提示。与 slash 菜单同级的
        // 优先消费；不计入双击 rewind 计时（避免「关建议后立刻双击 Esc」误开 rewind）。
        if (this.orchHint.active) {
          this.orchHint.dismiss()
          this.inputController.lastEscAt = 0
          this.renderLive()
          return
        }
        // Ctrl+C pending-exit 确认窗口内：Esc = 取消退出、恢复输入框。优先于
        // vim 切换 / 双击 rewind / overlay 关闭——屏幕处于退出提示态（输入框
        // 被隐藏），用户此刻按 Esc 的意图是「回到对话」。overlay 激活时的 Esc
        // 已在上方 handleOverlayKey 消费（先关 overlay），不会走到这里。
        if (this.inputController.ctrlCPendingSince > 0) {
          this.inputController.clearExitConfirm()
          // 取消用的 Esc 不计入双击 rewind 计时，避免「取消后立刻双击 Esc」
          // 误开 rewind overlay。
          this.inputController.lastEscAt = 0
          this.renderLive()
          return
        }
        // Vim 模式下：overlay/agent 激活时 ESC 关闭 overlay 或中断 agent，
        // 空闲时 ESC 落入输入框的 vim normal/insert 切换（保持原行为）。
        if (this.inputLine.vimEnabled) {
          if (this.overlay.isActive()) {
            // 键盘直连退出也走统一收口：suppress 窗口包住回放，避免叠影；
            // detail 指针必清——否则看过一次的 job/worker 日志把后续 pager
            // 内容永久劫持（pagerContent 把 detail 排在最前）。
            this.exitOverlayCore()
            this.workerDetailWorkerId = null
            this.jobDetailId = null
            // 计划预览返回时 core 已重开面板，renderLive 会写坏 alt screen。
            if (!this.overlay.isActive()) this.renderLive()
            return
          }
          // worker 视图优先于中断：Esc 先退出视图，不 abort 主 agent
          if (this.viewingWorkerId) {
            this.exitWorkerView()
            return
          }
          if (this.isAgentActive()) {
            this.handleAbort()
            return
          }
          // 空闲 + vim：ESC 落入输入框处理 vim 模式切换
        } else {
          if (this.overlay.isActive()) {
            // 键盘直连退出走统一收口，理由同上（vim 分支注释）。
            this.exitOverlayCore()
            this.workerDetailWorkerId = null
            this.jobDetailId = null
            if (!this.overlay.isActive()) this.renderLive()
          } else if (this.viewingWorkerId) {
            // worker 视图优先于中断：Esc 先退出视图，不 abort 主 agent
            this.exitWorkerView()
          } else if (this.isAgentActive()) {
            this.handleAbort()
          } else {
            // Idle: double-ESC within 400ms on empty input → rewind overlay
            const now = Date.now()
            if (this.inputLine.value.trim()) {
              // Has text: ESC clears input (like Claude Code)
              this.inputLine.setValue('')
              this.renderLive()
            } else if (now - this.inputController.lastEscAt < 400) {
              // Double-ESC → rewind. Default-select the most recent message
              // (the common rewind target), like Claude Code.
              this.inputController.lastEscAt = 0
              this.overlayController.resetNav()
              const n = this.overlayController.getData()?.rewindEntries?.().entries.length ?? 0
              this.overlayController.nav().rewindIndex = n > 0 ? n - 1 : 0
              this.overlay.activate('rewind')
              this.renderLive()
            } else {
              // First ESC — record timestamp
              this.inputController.lastEscAt = now
            }
          }
          return
        }
      }
      if (key.name === 'ctrl_o') {
        this.expandLastTruncatedTool()
        return
      }
      // 输出冻结（Ctrl+S）/ 解冻（Ctrl+Q 别名）——触摸终端滚动回看的根治：
      // 冻结期 stdout 零写入，终端视口停在用户翻到的位置，解冻后按序补放。
      if (key.name === 'ctrl_s') {
        this.setOutputFrozen(!this.outputFrozen)
        return
      }
      if (key.name === 'ctrl_q') {
        if (this.outputFrozen) this.setOutputFrozen(false)
        return
      }
      if (key.name === 'ctrl_t') {
        if (this.state.isThinking) {
          this.state.thinkingExpanded = !this.state.thinkingExpanded
          this.renderLive()
        }
        return
      }
      if (key.name === 'ctrl_r') {
        if (!this.isAgentActive()) {
          this.overlayController.resetNav()
          this.overlay.activate('history-search')
        }
        return
      }
      // ── Side panel shortcuts ────────────────────────────────
      // Ctrl+X leader key: wait for 'r' to open the right panel (OpenCode-style).
      if (key.name === 'ctrl_x') {
        this.sidePanelLeaderPending = true
        if (this.sidePanelLeaderTimer) clearTimeout(this.sidePanelLeaderTimer)
        this.sidePanelLeaderTimer = setTimeout(() => { this.sidePanelLeaderPending = false }, 800)
        return
      }
      if (this.sidePanelLeaderPending) {
        this.sidePanelLeaderPending = false
        if (this.sidePanelLeaderTimer) { clearTimeout(this.sidePanelLeaderTimer); this.sidePanelLeaderTimer = null }
        if (key.char.toLowerCase() === 'r') {
          this.setSidePanelOpen(true)
          return
        }
        if (key.char.toLowerCase() === 't') {
          // todo 面板展开态：completed 逐条回看（窄屏主区/宽屏 side panel 同键）
          this.state.todoExpanded = !this.state.todoExpanded
          this.renderLive()
          return
        }
        // Leader not followed by 'r'/'t': fall through to normal input handling.
      }
      if (key.name === 'ctrl_]') {
        this.toggleSidePanel()
        return
      }
      // ── Slash command handling ──────────────────────────────
      if (this.handleContractPreviewKey(key)) return
      const inputVal = this.inputLine.value
      const inputIsPath = looksLikeFilePath(inputVal, this.getCommandPredicate(), this.getCommandPrefixPredicate())
      if (inputVal.startsWith('/') && !inputIsPath) {
        const menu = this.inputController.slashMenu
        // PageUp/Down 翻页（菜单打开时；clamp 不环绕，滚动窗口跟随选中）
        if (key.name === 'pageup' || key.name === 'pagedown') {
          if (menu.open) {
            this.inputController.scrollSlashSelection(key.name === 'pageup' ? -SLASH_HINT_MAX_VISIBLE : SLASH_HINT_MAX_VISIBLE)
            this.renderLive()
            return
          }
        }
        if (key.name === 'up' || key.name === 'down') {
          if (menu.open) {
            this.inputController.moveSlashSelection(key.name === 'up' ? -1 : 1)
            this.renderLive()
            return
          }
        }
        // Tab 在 inputLine.handleKey 里走 'tab' 事件 → handleTabComplete，无需在此处理
        if (key.name === 'return' && !key.shift) {
          // 先清空输入框，再异步处理（await handler 结果决定是否透传 agent）
          // 若 ↑↓ 选中了命令，且选中命令名比当前输入长，则提交选中命令名。
          // 长度比较避免用户已输入完整命令+参数（如 /team max plan.md）时被截断。
          const selected = menu.open
            ? menu.matches[Math.min(menu.selected, menu.matches.length - 1)]
            : undefined
          const submitVal = selected && selected.name.length > inputVal.length
            ? selected.name
            : inputVal
          this.inputLine.setValue('')
          this.inputController.closeSlash()
          void this.submitSlashCommand(submitVal)
          return
        }
      } else {
        this.inputController.closeSlash()
      }
      // Shift+Enter 翻转粘滞换行模式（对齐公开仓 newlineMode）：开启后 Enter=换行，
      // 再按 Shift+Enter 退出。任何状态下生效（slash 块之外，同公开仓 app.ts:4582）。
      if (key.name === 'return' && key.shift) {
        this.inputLine.setNewlineMode(!this.inputLine.newlineMode)
        this.renderLive()
        return
      }
      // ── W4a: Up 箭头取回最近 queued 消息到输入框编辑 ─────────
      if (key.name === 'up' && !this.inputLine.value && this.steerBuffer.hasPending()) {
        const msg = this.steerBuffer.popLast()
        if (msg) {
          this.inputLine.setValue(msg)
          this.renderLive()
        }
        return
      }
      // ── Ctrl+V: clipboard image paste (before normal input processing) ──
      if (key.name === 'ctrl_v') {
        void this.handleCtrlV()
        return
      }
      // ── Normal input processing ─────────────────────────────
      // 确认窗口内的任何编辑键 = 用户继续对话：取消 pending-exit，恢复输入框。
      // 否则字符进 value 但输入框仍被隐藏（幽灵输入），Enter 还会提交不可见内容。
      if (this.inputController.ctrlCPendingSince > 0) {
        this.inputController.clearExitConfirm()
        this.renderLive()
      }
      const event = this.inputLine.handleKey(key.name, key.char, key.ctrl, key.meta, key.shift)
      // 选区剪切/复制的 OSC52 drain（终端支持时写系统剪贴板，不支持者无害忽略）
      const clip = this.inputLine.takeClipboardOut()
      if (clip != null) this.stdout.write(osc52Clipboard(clip))
      if (event?.type === 'change') {
        // 输入变化使 @ 补全循环失效
        this.inputController.fileCompletion = null
        // slash 菜单状态已由 onChange 回调 refreshSlash 维护（含 carry 保持选中）
        // 批渲染：快速输入/分 chunk 到达时合并为单次 LiveEngine.render，
        // 避免逐 chunk 全量重写造成的闪烁/残影。
        this.writeBatcher.schedule()
      } else if (event?.type === 'submit' || event?.type === 'tab') {
        // 提交/补全需即时反馈，不进批
        this.renderLive()
      }
    })

    // Build AgentCallbacks (aligned to loop-types.ts AgentCallbacks)
    this.callbacks = {
      onTextDelta: (text) => {
        if (this.perfMonitor?.enabled) this.perfMonitor.measure('delta', () => this.handleTextDelta(text))
        else this.handleTextDelta(text)
      },
      onThinkingDelta: (thinking) => {
        if (this.perfMonitor?.enabled) this.perfMonitor.measure('delta', () => this.handleThinkingDelta(thinking))
        else this.handleThinkingDelta(thinking)
      },
      onToolUse: (id, name, input) => this.handleToolUse(id, name, input),
      onToolResult: (id, name, result, isError, rawPath, uiContent) =>
        this.handleToolResult(id, name, result, isError, rawPath, uiContent),
      onTurnComplete: (usage, turnNumber, isFinal) => { void this.handleTurnComplete(usage, turnNumber, isFinal ?? true) },
      onError: (error) => this.handleError(error),
      onAbort: (reason) => this.handleAbort(reason),
      onApprovalRequired: async (id, name, input) => this.handleApprovalRequired(id, name, input),
      onCheckpoint: (hash) => this.handleCheckpoint(hash),
      onPhaseChange: (phase, detail) => {
        // stop-reason: surface guard-forced stops (max-turns / wedged-loop /
        // convergence …) as a visible system line — previously this phase was
        // silently dropped, leaving the user to guess why the run halted.
        // Voluntary finishes already render a completion badge; the checkpoint
        // source is skipped here because onAutonomyCheckpoint renders the
        // richer digest card for it.
        if (phase === 'stop-reason') {
          if (detail?.voluntary === false && detail.source !== 'checkpoint') {
            const label = phaseStatusLabel(phase, detail)
            if (label) this.commitStatic(color(label, this.theme.warning))
          }
          return
        }
        // convergence-warning: the L2 escalation rung BEFORE a convergence
        // abort. Must be visible in the CLI — session 8396ac51 received 10
        // silent nudges then a hard熔断 that looked like it came from nowhere.
        // The desktop renders this ladder via the decision-shift card; this
        // static warning line is the CLI counterpart.
        // image-stripped 同走此行：剥图后模型看不到图，静默处理会被读成「模型没理我的截图」。
        if (phase === 'convergence-warning' || phase === 'image-stripped') {
          const label = phaseStatusLabel(phase, detail)
          if (label) this.commitStatic(color(label, this.theme.warning))
          return
        }
        // Only map recognized phases to ActivityPhase; ignore unknown strings
        const knownPhases: Record<string, ActivityPhase> = {
          idle: 'idle',
          thinking: 'thinking',
          streaming: 'streaming',
          waiting: 'waiting',
          analyzing: 'analyzing',
          working: 'streaming',
          preparing: 'thinking',
          blocked: 'waiting',
        }
        const mapped = knownPhases[phase]
        if (mapped) {
          this.setPhase(mapped)
          this.writeBatcher.flushNow()
        }
        // Unknown phases (heartbeat, convergence-warning, etc.) are ignored
        // for the status bar display
      },
      onIntentNote: (intent) => this.handleIntentNote(intent),
      onAutonomyCheckpoint: (info) => this.handleAutonomyCheckpoint(info),
      // 工具边界只注入紧急意图（halt=now / redirect=next）：普通消息（later）
      // 留在队列，等本轮结束后自动作为下一轮发出——不混进当前轮 [User guidance]。
      onSteerDrain: () => this.steerBuffer.drain('next'),
      onDelegationActivity: (activity) => this.handleDelegationActivity(activity),
    }

    this.registerBuiltinSlashCommands()

    // 审批按键统一在 onAnyKey 顶部短路处理（见上），不再注册 mode-bound 处理器，
    // 避免与 onAnyKey 双触发。
  }

  // ── Approval resolution ─────────────────────────────────────

  private resolveApproval(result: ApprovalResult | boolean): void {
    if (!this.approvalIntentController.approvalPending) return
    const approved = typeof result === 'boolean' ? result : result.approved
    if (!approved) this._lastApprovalDeniedAt = Date.now()
    this.approvalIntentController.approvalPending.resolve(result)
    this.approvalIntentController.approvalPending = null
    this.input.setMode('input')
    this.renderLive()
  }

  /** 进入审批编辑模式：把工具入参 JSON 放进输入行（e 键 / 光标第 3 项共用）。 */
  private enterApprovalEditMode(): void {
    if (!this.approvalIntentController.approvalPending) return
    this.approvalIntentController.approvalEditMode = true
    this.approvalIntentController.approvalEditError = ''
    this.inputLine.setValue(JSON.stringify(this.approvalIntentController.approvalPending.input, null, 2))
    this.input.setMode('input')
    this.renderLive()
  }

  // ── Public API ───────────────────────────────────────────────

  /**
   * 首屏渲染：启动后立即绘制底部 chrome（GlanceBar + 输入框），
   * 无需等待第一次按键。main-ansi 在欢迎块写完后调用。
   */
  start(): void {
    // 标记已启动：构造后到 start() 之间的 setter 不再触发渲染，
    // 避免在 main.ts 清屏前画出一版输入框，清屏/flush 偏差时形成顶部重影。
    this.started = true
    this.lastInputFocusAt = Date.now()
    // 启用 bracketed paste（DEC 2004）：粘贴被 200~/201~ 包裹，
    // 避免含 \r 的多行粘贴被逐行当作 Enter 提交、控制字符污染显示。
    this.stdout.write('\x1B[?2004h')
    // Kitty keyboard protocol flag 1（disambiguate）：请求终端把带修饰键
    // （Shift+Enter 等）以 CSI-u 编码送达，否则 Shift+Enter 与 Enter 同码
    // （裸 \r）无法区分，会被当普通提交。不支持的终端静默忽略该序列。
    this.stdout.write(ANSI.KITTY_KEYBOARD_DISAMBIGUATE_ON)
    // 能力探测：`\x1B[?u` 查询当前 flags，支持协议的终端回 `\x1B[?<flags>u`。
    // 收到回包才置 kittyKeyboard——footer 的 shift+enter 提示只在真能区分
    // 修饰键的终端上显示（不支持者 Shift+Enter 与 Enter 同码，提示即谎言）。
    // flag 1 开启后 Esc/Ctrl+letter 也走 CSI-u 编码，input-handler 已全量解码。
    this.stdout.write(ANSI.KITTY_KEYBOARD_QUERY)
    this.input.onKittyFlags(() => {
      if (this.kittyKeyboard) return
      this.kittyKeyboard = true
      this.renderLive()
    })
    // 首帧前重置 LiveEngine 的屏上状态。构造后到 start() 之间的一批 setter
    // （setApprovalMode / setSessionStarDomain / setSidePanelOpen …）可能已触发过
    // renderLive 画出一版输入框；而 main.ts 随后 `\x1B[2J\x1B[H` 清屏 + 写欢迎屏，
    // 把那版擦掉了，但 LiveEngine 仍记着 hasRendered/lastDisplayRows → 首次真正渲染
    // 会 moveToTop 到错误位置、把输入框顶进欢迎屏中段并丢掉输入行/底边框。reset() 令
    // 本帧当作全新首帧，在当前光标（欢迎屏正下方）干净 append。
    this.live.reset()
    // stderr 护栏：TUI 存活期把游离 stderr 文本（LSP/typecheck 告警、unhandled
    // rejection、第三方库）导入 commit 通道，防止直写 TTY 污染 live region。
    this.outputGuard = installOutputGuard((text) => {
      this.commitStatic(color(`⚠ ${text}`, this.theme.warning))
    })
    // 空闲期 CPR 探针：idle 无 ticker，2s 轮询光标驻停位置，检出外来写入后自愈。
    this.cprProbeTimer = setInterval(() => this.live.requestProbe(), 2000)
    this.cprProbeTimer.unref?.()
    this.renderLive()
  }

  /** 设置提交回调（用户按 Enter 后触发）。images 为当前输入框携带的图片附件 data URL 列表。 */
  onSubmit(callback: (text: string, images?: string[]) => void): void {
    this.onSubmitCallback = callback
  }

  // ── Mission Contract 预览（§13）─────────────────────────────────────
  /** 预览卡待决提交：Enter 确认 / e 返回编辑 / Esc 取消。 */
  private contractPreview: { text: string; images?: string[]; draft: MissionDraft } | null = null
  /** 确认后绕过预览门禁一次性直提。 */
  private contractBypass = false

  /** 输入提交主流程（InputLine onSubmit 回调；原构造器闭包提取，逻辑零改动）。 */
  private async handleInputSubmit(text: string, images?: string[]): Promise<void> {
    // 提交 = 继续对话：取消 Ctrl+C 退出确认（同 Esc/编辑键/粘贴，防残留误退）。
    if (this.inputController.ctrlCPendingSince > 0) this.inputController.clearExitConfirm()
    // 入口先规范化图片数组，后续气泡/渲染/回调看到的是同一份。
    images = normalizeSubmitImages(images)
    let trimmed = text.trim()
    const hasImages = images && images.length > 0
    // 允许只发图片：空文本时补一个占位 prompt，让后端能触发 run。
    if (!trimmed && hasImages) {
      text = '📎 图片消息'
      trimmed = text
    }

    // Mission Contract 预览门禁（早于历史/worker/steer——取消不留痕迹）：
    // 结构化信号（@引用/#标签/长任务）命中才弹卡；斜杠命令、worker 视图、
    // agent busy（steer 归并路径）一律豁免直通。
    if (
      trimmed &&
      !this.contractBypass &&
      !this.agentBusy &&
      !this.viewingWorkerId &&
      !trimmed.startsWith('/')
    ) {
      const draft = parseMissionDraft(text)
      if (shouldPreviewContract(draft, text)) {
        this.contractPreview = { text, images, draft }
        // 读屏档：预览卡是纯本地 UI、不产生 SessionEvent，事件播报覆盖不到——
        // 卡一开就静态播报一次按键，否则用户面对 ⏎/e/Esc 门禁零感知。
        if (this.screenReader) {
          this.commitStatic('任务预览已打开：按 Enter 创建任务，e 返回编辑，Esc 取消')
        }
        this.renderLive()
        return
      }
    }
    this.contractBypass = false

    // User-initiated submit is real progress: clear the goal-mode watchdog
    // auto-continue counter so a later legitimate stall gets the full
    // recovery budget again. (The auto-continue path resubmits via
    // onSubmitCallback directly and does NOT pass through here.)
    if (trimmed) this.watchdogPolicy.recordUserSubmit()
    // 新提交 = 用户参与——取消 goal 计划倒计时自动批准
    if (trimmed) this.cancelPlanAutoApprove()

    // 输入历史：会话内更新 + 持久化（queued 与直接 submit 都记录）
    if (trimmed) {
      this.inputController.inputHistory = nextHistoryAfterSubmit(this.inputController.inputHistory, trimmed)
      this.inputLine.setHistory(this.inputController.inputHistory)
      appendHistoryAsync(trimmed).catch(() => { /* 持久化失败静默 */ })
      // 记录最近真实提交——run 报错时 handleError 回填输入框用（slash 命令不算）。
      if (!trimmed.startsWith('/')) this.lastSubmittedText = trimmed
    }

    // Worker 视图：输入直达该 worker 的 steer 队列，不进主 agent。
    // slash 命令（/ 开头）仍归主会话——用户在视图内还需要 /tasks 等导航。
    if (this.viewingWorkerId && trimmed && !trimmed.startsWith('/')) {
      const target = this.viewingWorkerId
      // 先等气泡+图片落 scrollback 再 steer：worker 输出不得先于用户气泡。
      await this.awaitUserCommit(`[→ ${shortOrderLabel(target)}] ${trimmed}`, images)
      const delivered = this.workerSteer?.(target, trimmed) ?? false
      if (!delivered) {
        this.commitStatic(color('⚠ 该子代理已结束或不支持直达，消息未送达', this.theme.warning))
      }
      this.renderLive()
      return
    }

    // 中断收尾窗口：ESC 已把 TUI 置回 idle，但上一 run 的 promise 还没 settle，
    // 此刻发起 run() 会撞 AgentLoop 的 re-entry guard。不能走 steer 队列——那条
    // 队列要靠活跃 run 的工具边界才 drain，而这里恰恰没有活跃 run，消息会永远
    // 卡住而界面还显示「已排队」。改为本地挂起，notifyRunSettled 时自动发出。
    //
    // 对着探针校验而不是只信标记：run 已 settle 的话这标记就是陈旧的，就地清掉，
    // 照常提交。
    if (this.abortSettling && !this.isAgentRunSettling()) { this.abortSettling = false; this.abortSteerBackfill = false }
    if (this.abortSettling && trimmed) {
      this.commitUserPrompt(trimmed, images)
      this.pendingSubmitAfterAbort = { text: trimmed, ...(images ? { images } : {}) }
      this.renderLive()
      return
    }

    // W4a: agent 执行中 → 入队（turn 边界 drain 注入）。
    // 同时立即 commit 用户气泡到 scrollback，确保用户始终能看到自己说了什么。
    if (this.agentBusy && trimmed) {
      await this.awaitUserCommit(trimmed, images)
      this.steerBuffer.push(trimmed)
      this.renderLive()
      return
    }

    // 跨 run steer 收口：上一 run 结束（text-only 收尾从不 drain）或
    // busy 闩残留时排队的 guidance 会滞留到这里。若放任不管，它会在
    // 下一次工具回合作为 [User guidance] 注入 —— 旧指令混进新任务上下文。
    // 归并进本次 prompt（排队内容本就是用户意图，按优先级/时间序拼在新消息前）。
    // /queue lane 与 steer 残留同口径归并：steer 在前、lane 在后，各自内部保序，
    // lane 拼完清空（它只认这一条出口，没有别的 drain 点）。
    // 注意：steer 路径已为每条 queued 消息单独 commit 了用户气泡，
    // 此处不再重复 commit，仅输出合并提示并归并文本。
    let submitText = text
    let steerMerged = false
    if (trimmed && (this.steerBuffer.hasPending() || this.queueLane.length > 0)) {
      const pendingEntries = [...this.steerBuffer.getPendingEntries()]
      this.steerBuffer.clear()
      const pending = pendingEntries.map(entry => entry.text)
      const lane = this.queueLane.splice(0)
      const mergedCount = pending.length + lane.length
      submitText = [...pending, ...lane, trimmed].join('\n\n')
      steerMerged = true
      this.commitAbove(() => {
        this.commit.write({
          text: color(`↳ ${mergedCount} queued message${mergedCount > 1 ? 's' : ''} merged into this prompt`, this.theme.muted),
          trailingNewline: true,
        })
        this.state.committedCount++
      })
    }

    // Commit user message to scrollback（steer 已单独 commit 时跳过）
    if (trimmed) {
      if (!steerMerged) {
        await this.awaitUserCommit(submitText.trim(), images)
      }
      // 新 run 启动前丢弃上一 run 未 finalize 的流式残留：blockWriter 缓冲
      // 与 streamRenderer pending 若不清，会把上一轮文字追加进新轮输出。
      this.blockWriter.discard()
      this.streamRenderer.reset()
      this.streamRenderController.assistantHeaderDone = false
      this.agentBusy = true
      this.todosWrittenThisRun = false
    }
    // Reset turn timer for the new turn
    this.state.turnStartMs = Date.now()
    this.streamRenderController.lastActivityMs = Date.now()
    this.onSubmitCallback?.(submitText, images)
  }

  /** Contract 预览按键：Enter 确认 / e 返回编辑 / Esc 取消。返回是否已消费。 */
  private handleContractPreviewKey(key: KeyPress): boolean {
    if (!this.contractPreview) return false
    const pending = this.contractPreview
    if (key.name === 'return') {
      this.contractPreview = null
      this.contractBypass = true
      // 与 InputLine onSubmit 注册处同款收口：async 调用必须显式 catch。
      void this.handleInputSubmit(pending.text, pending.images).catch((err: unknown) => {
        this.commitStatic(color(`⚠ 提交处理出错：${err instanceof Error ? err.message : String(err)}`, this.theme.warning))
      })
      return true
    }
    if (key.char === 'e') {
      this.contractPreview = null
      this.inputLine.setValue(pending.text)
      this.renderLive()
      return true
    }
    if (key.name === 'escape') {
      this.contractPreview = null
      this.renderLive()
      return true
    }
    return true // 预览期间吞掉其他键（防误编辑）
  }

  /** @file 引用缺失路径全集（按文本缓存，同值不重复 existsSync）。 */
  private missingPathsCache: { value: string; missing: string[] } = { value: '', missing: [] }
  private computeMissingMentionPaths(text: string): string[] {
    if (this.missingPathsCache.value === text) return this.missingPathsCache.missing
    let missing: string[] = []
    if (text.includes('@file:') || text.includes('@folder:')) {
      for (const ref of parseMentions(text)) {
        if (ref.type !== 'file' && ref.type !== 'folder') continue
        if (!existsSync(resolve(process.cwd(), ref.value))) missing.push(ref.value)
      }
    }
    this.missingPathsCache = { value: text, missing }
    return missing
  }

  /** 设置中止回调 */
  onAbort(callback: () => void): void {
    this.onAbortCallback = callback
  }

  /** 当前 run 世代（唯一权威；bridge 用它丢弃被中断旧 run 的迟到回调） */
  get runGen(): number {
    return this._runGen
  }

  /** agent 是否正在执行（streaming 状态的唯一权威，供外层入口判定是否可发起新 run） */
  get busy(): boolean {
    return this.agentBusy
  }

  /** 当前激活的 overlay id（无则 null）。 */
  activeOverlayId(): string | null {
    return this.overlay.activeId()
  }

  /**
   * 拒绝当前提交：撤销 submitSlashCommand 已设置的 agentBusy。
   * main.ts 在 resolveAppPromptInput 返回 null 时调用，避免 agentBusy 卡死。
   */
  rejectSubmit(): void {
    this.agentBusy = false
    this.setPhase('idle')
    this.renderLive()
  }

  /**
   * 上一个 run 的 promise 已 settle（正常结束 / 出错 / 被中断收尾完毕）。
   *
   * 由 main.ts 在 `agent.run()` 的 finally 里调用——promise settle 是唯一一定会
   * 到达的终结信号，回调会被 bridge 的世代守卫按 gen 丢弃，指望不上。
   * 收尾窗口结束后，把期间挂起的那条消息补发出去。
   */
  /** 收尾窗口是否仍成立：标记与 agent 真实状态都为真才算。 */
  private isAgentRunSettling(): boolean {
    return this.abortSettling && this.agentRunningProbe?.() === true
  }

  /** 注入 agent 运行态探针（main.ts 接线到 `ctx.agent.isRunning()`）。 */
  setAgentRunningProbe(probe: () => boolean): void {
    this.agentRunningProbe = probe
  }

  notifyRunSettled(): void {
    this.abortSettling = false
    const backfill = this.abortSteerBackfill
    this.abortSteerBackfill = false
    const guardian = this.guardianAbortPending
    this.guardianAbortPending = false
    const pending = this.pendingSubmitAfterAbort
    if (!pending) {
      // 无补发消息的 settle：
      //  - 用户主动 ESC：回填输入框交还编辑（不自动发出）；
      //  - run 自然结束：排队内容自动作为下一轮发出（Claude Code 队列）；
      //  - 守护中断（watchdog/convergence）自动续跑：不消费队列——续跑在同一个
      //    agent.run 内完成（notifyRunSettled 只在 finally 调一次），队列留待
      //    下次提交归并（onSubmit 前 drain）。
      // 有补发消息时新 run 即将发起，队列随它在工具边界 drain，不动。
      if (backfill) {
        this.backfillSteerToInput()
      } else if (!guardian) {
        this.pendingQueueDispatch = true
        this.flushPendingQueueDispatch()
      }
      return
    }
    this.pendingSubmitAfterAbort = null
    // 用户气泡在挂起时已 commit，这里只发起 run，不重复 commit。
    this.blockWriter.discard()
    this.streamRenderer.reset()
    this.streamRenderController.assistantHeaderDone = false
    this.agentBusy = true
    this.todosWrittenThisRun = false
    this.state.turnStartMs = Date.now()
    this.streamRenderController.lastActivityMs = Date.now()
    this.onSubmitCallback?.(pending.text, pending.images)
    this.renderLive()
  }

  /**
   * ESC settle：run 已终结，把排队指引按序拼回输入框，交还用户改发/重发。
   * 输入框已有草稿则不动（不抢用户正在敲的内容），队列留待下次提交归并。
   * 消费用 getPendingEntries()+clear() 而非 drain()：drain 会把文本包进
   * [User guidance] 注入格式，这里要的是原文（契约见 esc-abort-steer-preserve 测试）。
   */
  private backfillSteerToInput(): void {
    if (!this.steerBuffer.hasPending()) return
    if (this.inputLine.value.trim().length > 0) return
    const entries = [...this.steerBuffer.getPendingEntries()]
    this.steerBuffer.clear()
    this.inputLine.setValue(entries.map(entry => entry.text).join('\n\n'))
    this.commitAbove(() => {
      this.commit.write({
        text: color(`⏮ 已把 ${entries.length} 条排队消息拉回输入框`, this.theme.muted),
        trailingNewline: true,
      })
      this.state.committedCount++
    })
    this.renderLive()
  }

  /**
   * 自然结束 settle：把队列头部一条作为新 run 发出（气泡在入队时已 commit）。
   * 多条 FIFO 留在 buffer，等这一轮再 settle。输入框有草稿则不动，避免抢输入。
   *
   * 必须等 handleTurnComplete 收尾且 TUI 已 idle：isFinal 的 await flush
   * 与 agent.run() finally 存在竞态，中途开新 run 会冲掉 writer/renderer。
   */
  private flushPendingQueueDispatch(): void {
    if (!this.pendingQueueDispatch) return
    if (this.turnCompleteInFlight > 0) return
    if (this.agentBusy) return
    this.pendingQueueDispatch = false
    this.dispatchQueuedAfterSettle()
  }

  private dispatchQueuedAfterSettle(): void {
    if (this.inputLine.value.trim().length > 0) return
    const text = this.steerBuffer.shift()
    if (!text) return
    this.blockWriter.discard()
    this.streamRenderer.reset()
    this.streamRenderController.assistantHeaderDone = false
    this.agentBusy = true
    this.todosWrittenThisRun = false
    this.state.turnStartMs = Date.now()
    this.streamRenderController.lastActivityMs = Date.now()
    this.onSubmitCallback?.(text)
    this.renderLive()
  }

  /**
   * `agent.run()` 撞上 re-entry guard、本次提交没能发起任何轮次。
   *
   * 兜底路径：正常情况下 `abortSettling` 会先把提交拦成本地挂起，走不到这里。
   * 一旦走到，busy 闩必须就地复位——否则它会一直挂着，后续消息全进 steer 队列
   * 等一个永远不会到来的注入边界（界面却显示「已排队」）。
   */
  notifyRunRejected(): void {
    this.agentBusy = false
    this.setPhase('idle')
    this.commitAbove(() => {
      this.commit.write({
        text: color('⏸ 上一轮尚未收尾，这条没有发出 — 请重新发送', this.theme.warning),
        trailingNewline: true,
      })
      this.state.committedCount++
    })
    this.renderLive()
  }

  /** 设置退出回调（/exit、/quit 时触发，由外部执行 graceful shutdown） */
  onExit(callback: () => void): void {
    this.onExitCallback = callback
  }

  /** 设置输入文本（外部更新，如 slash command） */
  setInput(text: string): void {
    this.inputLine.setValue(text, text.length)
    this.renderLive()
  }

  /** 设置当前主控模型的 vision 能力与桥接状态（用于图片附件提示）。 */
  setVisionInfo(supportsVision: boolean, bridgeEnabled: boolean, bridgeSource?: 'native' | 'configured' | 'auto' | 'same-provider' | 'none'): void {
    this.supportsVision = supportsVision
    this.visionBridgeEnabled = bridgeEnabled
    this.visionBridgeSource = bridgeSource
  }

  /**
   * /cd 切目录后刷新会话 cwd——顶框 cwd 显示与审批路径判定都跟新值一致。
   * 调用方（slash-commands 的 onCwdSwitch 包装）负责先用新 cwd 重读 git 分支，
   * 再调 setGitBranch()。
   */
  setCwd(cwd: string): void {
    this.sessionCwd = cwd
  }

  /** 更新顶框显示的 git 分支（/cd 到不同仓库后重读）。undefined = 非 git 目录。 */
  setGitBranch(branch?: string): void {
    this.metricsGlanceController.gitBranch = branch
  }

  /** 构建命令名谓词，供 resolveAppPromptInput 区分路径与命令。
   *  必须并集两个来源：inputController.slashCommands（palette + skill 提示列表）
   *  和 slashRegistry（内置 /panel、/starmap 及 registerSlashCommand 动态注册的
   *  命令）。只看提示列表会把未进提示的已注册命令误判为 Linux 单段路径，
   *  静默绕过 slash 分发（4175e5b9 引入的回归）。 */
  getCommandPredicate(): (name: string) => boolean {
    const fromHints = buildCommandPredicate(this.inputController.slashCommands)
    const fromRegistry = buildCommandPredicate(this.slashRegistry.list())
    return (name: string) => fromHints(name) || fromRegistry(name)
  }

  /** 构建命令前缀谓词，供 looksLikeFilePath 把 `/h` 这类模糊输入识别为 slash 命令。 */
  private getCommandPrefixPredicate(): (name: string) => boolean {
    const fromHints = buildCommandPrefixPredicate(this.inputController.slashCommands)
    const fromRegistry = buildCommandPrefixPredicate(this.slashRegistry.list())
    return (name: string) => fromHints(name) || fromRegistry(name)
  }

  /** 读取当前输入框文本（测试/外部检视用） */
  getInputValue(): string {
    return this.inputLine.value
  }

  /** 读取输入状态控制器（测试检视 slash 菜单/MRU 状态用） */
  getInputController(): InputController {
    return this.inputController
  }

  /** 读取当前输入框携带的图片附件数量（测试/外部检视用；plan 9e126c7c 漏的公共 getter） */
  getInputImagesCount(): number {
    return this.inputLine.images.length
  }

  /** 切换 vim 键位，返回切换后的状态（供 /vim 命令）。 */
  toggleVim(): boolean {
    const next = !this.inputLine.vimEnabled
    this.inputLine.setVimEnabled(next)
    this.renderLive()
    return next
  }

  /** 当前是否启用 vim 键位。 */
  isVimEnabled(): boolean {
    return this.inputLine.vimEnabled
  }

  /** 设置 cockpit 聚焦面板（供 /cockpit <panel>）。激活时即时重渲染。 */
  setCockpitPanel(panel: Panel): void {
    this.overlayController.setCockpitPanel(panel)
    if (this.overlay.activeId() === 'cockpit') this.overlay.rerender()
  }

  /** 当前 cockpit 聚焦面板。 */
  getCockpitPanel(): Panel {
    return this.overlayController.getCockpitPanel()
  }

  /**
   * 异步数据到位后重画指定 overlay（仅当它仍是当前活动层）。
   * `/cache` 的聚合扫描与官方账单都是 await 之后才有值，provider 是同步的，
   * 需要一个「数据来了再画一次」的入口；overlay 已被关掉时不做任何事。
   */
  refreshOverlay(id: string): void {
    if (this.overlay.activeId() === id) this.overlay.rerender()
  }

  /** 激活 overlay */
  activateOverlay(id: string): boolean {
    // overlay 内 ESC 应即时响应，关闭输入处理器的 lone-ESC 超时。
    this.input.setEscapeImmediate(true)
    // 在激活任何全屏覆盖层之前，必须先干净地清除主屏幕底部的 live region（输入框和 GlanceBar），
    // 避免退出覆盖层后主屏幕残留旧的 live region 导致重影和重复行。
    this.live.clear()
    // 清理 Ctrl+X leader 状态，防止 overlay 内的按键误触 side panel toggle
    this.clearSidePanelLeader()
    // 激活非 pager 的 overlay 即结束计划预览态：preview pager 被直接切走
    //（如 Ctrl+P 开面板）时指针必须失效，否则后续 pager 打开仍被
    // pagerContent 的 plan 分支劫持。
    if (id !== 'pager') this.planPreview = null

    switch (id) {
      case 'pager':
      case 'starmap':
      case 'command-palette':
      case 'cockpit':
      case 'rewind':
      case 'history-search':
      case 'chronicle':
      case 'connect':
      case 'vision-onboarding':
      case 'init':
      case 'settings':
      case 'jobs':
      case 'cache': {
        // 复位导航状态，避免上次的翻页/选中残留到新 overlay
        this.overlayController.resetNav()
        return this.overlay.activate(id)
      }
      case 'tasks': {
        this.overlayController.resetNav()
        // 单任务直进 detail（CC 对标）：只有一个 worker 时列表页没有信息增量
        const data = this.getTasksData('running')
        const only = data.groups.length === 1 && data.groups[0]!.workers.length === 1
          ? data.groups[0]!.workers[0]
          : undefined
        if (only) {
          this.openWorkerDetail(only.workerId)
          return true
        }
        return this.overlay.activate(id)
      }
      case 'domain-picker': {
        this.overlayController.resetNav()
        // 光标初始定位到当前生效星域，便于确认/切换。
        const entries = this.overlayController.getData()?.domainPickerData?.().entries ?? []
        const curIdx = entries.findIndex(e => e.current)
        if (curIdx >= 0) this.overlayController.nav().domainPickerIndex = curIdx
        // 创世碑文视图状态复位（g 键进入，Esc/g 返回）。
        this.domainGenesisMode = false
        this.domainGenesisScroll = 0
        return this.overlay.activate(id)
      }
      case 'model-picker': {
        this.overlayController.resetNav()
        const entries = this.overlayController.getData()?.modelPickerData?.().entries ?? []
        const curIdx = entries.findIndex(e => e.current)
        if (curIdx >= 0) this.overlayController.nav().modelPickerIndex = curIdx
        // effort draft 初始化为当前生效档（CC 对标：面板内 </> 调整，提交才生效）
        const cur = this.metricsGlanceController.reasoningEffortProvider?.()
        const init = (MODEL_PICKER_EFFORT_LEVELS as readonly string[]).includes(cur ?? '') ? cur as ModelPickerEffort : 'auto'
        this.modelPickerEffortDraft = init
        this.modelPickerEffortInitial = init
        return this.overlay.activate(id)
      }
      case 'theme-picker': {
        this.overlayController.resetNav()
        const entries = this.overlayController.getData()?.themePickerData?.().entries ?? []
        const curIdx = entries.findIndex(e => e.current)
        if (curIdx >= 0) this.overlayController.nav().themePickerIndex = curIdx
        return this.overlay.activate(id)
      }
      case 'choice-panel': {
        this.overlayController.resetNav()
        // 光标初始定位到当前 effort 档位（data 里标记了 current/recommended）。
        const choices = this.overlayController.getData()?.choicePanelData?.().choices ?? []
        const curIdx = choices.findIndex(c => c.recommended || (c as ChoiceEntry & { current?: boolean }).current)
        if (curIdx >= 0) this.overlayController.nav().choicePanelIndex = curIdx
        return this.overlay.activate(id)
      }
      case 'plan-picker': {
        this.overlayController.resetNav()
        // 光标初始定位到第一个待批（submitted）计划。
        const entries = this.overlayController.getData()?.planPickerData?.().entries ?? []
        const curIdx = entries.findIndex(e => e.status === 'submitted')
        if (curIdx >= 0) this.overlayController.nav().planPickerIndex = curIdx
        return this.overlay.activate(id)
      }
      default:
        return false
    }
  }

  /**
   * overlay 退出的统一收口：所有「退出 overlay」路径必须经此，
   * 不得裸调 this.overlay.deactivate()。
   * 收口点保证：suppressCommitRender 包住 deactivate——deactivate 触发
   * onExitAltScreen → requestPump，排队的主屏 commit 在 suppress 窗口内
   * 回放时只写 scrollback 不重绘 live，最后由调用方 renderLive 画唯一帧，
   * 避免「回放帧 + 退出帧」两层框体叠影/残帧。
   */
  private exitOverlayCore(): void {
    // Every overlay exit path (including direct keyboard Esc) must restore the
    // normal lone-Esc input behavior. Keep this reset at the shared core so
    // callers cannot accidentally leave escapeImmediate enabled.
    this.input.setEscapeImmediate(false)
    const wasActive = this.overlay.isActive()
    if (!wasActive) return
    const closingId = this.overlay.activeId()
    const preview = this.planPreview
    this.suppressCommitRender = true
    try {
      this.overlay.deactivate()
    } finally {
      const pump = this.mainCommitPump
      if (!pump) {
        this.suppressCommitRender = false
      } else {
        const finish = () => {
          this.suppressCommitRender = false
          if (this.deferredCommitRender && !this.overlay.isActive()) {
            this.deferredCommitRender = false
            this.renderLive()
          }
        }
        void pump.then(finish, finish)
      }
    }
    // 计划预览返回：从 plan preview pager 退出不是「关闭面板」而是「暂离查看
    // 全文」——按 returnTo 回原面板（审批卡 / plan-picker）而非落回主屏。
    // pendingPlanApproval 已被消费（如 Goal 倒计时自动批准）则正常退出。
    // 此处消费指针防泄漏（后续 pager 打开不再劫持 pagerContent）。
    if (closingId === 'pager' && preview) {
      this.planPreview = null
      if (preview.returnTo === 'approval' && this.pendingPlanApproval) {
        this.openPlanApprovalPanel(this.pendingPlanApproval)
        return
      }
      if (preview.returnTo === 'plan-picker') {
        this.activateOverlay('plan-picker')
        return
      }
    }
  }

  /** 停用 overlay */
  deactivateOverlay(): void {
    // 统一收口：suppress 窗口让回放只写 scrollback，最后由本方法
    // 统一 renderLive 画唯一帧，避免两层框体叠影。
    this.exitOverlayCore()
    // 计划预览返回路径：exitOverlayCore 已按 returnTo 重开面板（choice-panel /
    // plan-picker），此处不得再做主屏恢复——写主屏会污染 alt screen。
    if (this.overlay.isActive()) return
    // 记录焦点回归时间：Ctrl+V 剪贴板图片防抖窗口起点
    this.lastInputFocusAt = Date.now()
    this.workerDetailWorkerId = null
    this.jobDetailId = null
    this.stdout.write('\r\x1B[0J')
    this.live.reset()
    this.renderLive()
  }

  /** 打开 /connect 服务商配置向导（选内置服务商或自定义，填写密钥）。 */
  startConnect(existing?: ConnectProviderRef[], currentDefault?: string): void {
    const draft = readConnectDraft()
    // 草稿只存 secrets.json 引用——恢复时物化密钥交给 flow；引用失效（secrets
    // 被清）时传 undefined，normalizeDraft 的降级链会滑回密钥输入步。
    const restoredKey = draft?.collected.keyRef ? readSecret(draft.collected.keyRef) : undefined
    const flow = new ConnectFlow(existing, draft, restoredKey, currentDefault)
    // 结构合法但语义不可恢复的草稿（preset 已删等）——顺手清掉，免得反复弹提示。
    if (flow.draftRejected) clearConnectDraft()
    this.connectFlow = flow
    this.setConnectInput('', true)
    this.connectError = undefined
    this.input.setMode('input')
    this.activateOverlay('connect')
  }

  /** Open the dedicated image-recognition bridge wizard. */
  startVisionOnboarding(execute: (request: VisionOnboardingRequest) => Promise<{ candidates?: VisionCandidate[] }>): void {
    this.visionOnboardingFlow = new VisionOnboardingFlow()
    this.visionExec = execute
    this.visionInput = ''
    this.connectCursor = 0
    this.visionError = undefined
    this.overlayController.nav().connectIndex = 0
    this.input.setMode('input')
    this.activateOverlay('vision-onboarding')
  }

  /**
   * 打开 /config 设置面板。
   *
   * flow 每次开面板都新建（由调用方读盘构造），所以光标和 draft 天然是新的——
   * 不需要把光标塞进 overlayNav 再靠 resetNav 清理。
   */
  startSettings(flow: SettingsFlow, save: (request: SettingsSaveRequest) => SettingsSaveResult): void {
    this.settingsFlow = flow
    this.settingsSave = save
    this.settingsNotice = undefined
    this.input.setMode('input')
    this.activateOverlay('settings')
  }

  /** 打开 /init 交互式项目初始化向导（verify 声明 / skills / hooks 脚手架）。 */
  openInitFlow(cwd: string): void {
    this.initFlow = new InitFlow(probeInitFlowInput(cwd))
    this.initError = undefined
    this.activateOverlay('init')
  }

  /** 打开计划审阅卡（钉在输入框上方 chrome，不进 overlay）。 */
  openPlanApprovalPanel(info: PlanSubmittedInfo, view?: string | { body?: string; date?: string }): void {
    this.choicePanelKind = 'plan-approval'
    this.pendingPlanApproval = info
    this.choicePanelSubMode = 'select'
    this.choicePanelInputBuffer = ''
    this.choicePanelInputFor = undefined
    this.planReviewFeedbackMode = false
    this.planReviewScroll = 0
    if (typeof view === 'string') {
      this.planApprovalBody = view
      this.planApprovalExcerpt = view
    } else if (view) {
      if (view.body !== undefined) {
        this.planApprovalBody = view.body
        this.planApprovalExcerpt = view.body
      }
      if (view.date !== undefined) this.planApprovalDate = view.date
    }
    this.input.setEscapeImmediate(true)
    this.renderLive()
  }

  /** 收起钉底审阅卡（Esc 收起不改计划状态；结算后清场）。 */
  clearPlanReviewState(): void {
    this.pendingPlanApproval = undefined
    this.planApprovalExcerpt = undefined
    this.planApprovalBody = undefined
    this.planApprovalDate = undefined
    this.planReviewScroll = 0
    this.planReviewFeedbackMode = false
    this.choicePanelInputBuffer = ''
    this.choicePanelInputFor = undefined
    if (this.choicePanelKind === 'plan-approval') this.choicePanelKind = 'effort'
    if (!this.overlay.isActive()) this.input.setEscapeImmediate(false)
  }

  private settlePlanReview(id: string): void {
    this.cancelPlanAutoApprove()
    if (id === '__reject_comment__') {
      this.choicePanelInputBuffer = this.inputLine.value.trim()
      this.choicePanelInputFor = 'plan-reject-comment'
      this.inputLine.setValue('')
    }
    const exec = this.onPlanReviewSettle ?? this.overlayController.getChoicePanelExec()
    exec?.(id)
    this.clearPlanReviewState()
    this.renderLive()
  }

  private handlePlanReviewKey(key: KeyPress): boolean {
    if (!this.pendingPlanApproval || this.overlay.isActive()) return false
    const c = key.char
    const actions = buildPlanReviewActions(this.pendingPlanApproval)
    const bodyRows = planReviewBodyRows(this.rows || 24)

    if (this.planReviewFeedbackMode) {
      if (key.name === 'return') {
        this.settlePlanReview('__reject_comment__')
        return true
      }
      if (key.name === 'escape') {
        this.planReviewFeedbackMode = false
        this.inputLine.setValue('')
        this.renderLive()
        return true
      }
      this.inputLine.handleKey(key.name, key.char, key.ctrl, key.meta, key.shift)
      this.renderLive()
      return true
    }

    if (key.name === 'escape') {
      this.clearPlanReviewState()
      this.renderLive()
      return true
    }
    if (c === 'f' || c === 'F') {
      this.cancelPlanAutoApprove()
      this.planReviewFeedbackMode = true
      this.inputLine.setValue('')
      this.renderLive()
      return true
    }
    if (c === 'v' || c === 'V') {
      this.openPlanPreview(this.pendingPlanApproval.slug, 'approval')
      return true
    }
    if (key.name === 'return') {
      const rec = recommendedPlanReviewAction(actions)
      if (rec) this.settlePlanReview(rec.id)
      return true
    }
    if (key.name === 'up' || c === 'k') {
      this.planReviewScroll = clampPlanReviewScroll(this.planReviewScroll - 1, Number.MAX_SAFE_INTEGER, bodyRows)
      this.renderLive()
      return true
    }
    if (key.name === 'down' || c === 'j') {
      this.planReviewScroll += 1
      this.renderLive()
      return true
    }
    if (key.name === 'pageup') {
      this.planReviewScroll = clampPlanReviewScroll(this.planReviewScroll - bodyRows, Number.MAX_SAFE_INTEGER, bodyRows)
      this.renderLive()
      return true
    }
    if (key.name === 'pagedown') {
      this.planReviewScroll += bodyRows
      this.renderLive()
      return true
    }
    if (/^[1-9]$/.test(c)) {
      const action = actions[Number(c) - 1]
      if (action) this.settlePlanReview(action.id)
      return true
    }
    // 可打印键吞掉，避免漏进输入框；Ctrl+C / Ctrl+P 等功能键继续走全局。
    if (this.isPrintableKey(key) || key.name === 'backspace') return true
    return false
  }

  /** 当前 pager 是否在预览某个计划文档（pagerContent provider 分支用；
   *  returnTo 供 provider 选择 footer 文案——q 是「返回」还是「关闭」）。 */
  getPlanPreview(): { slug: string; draftPath?: string; returnTo?: 'approval' | 'plan-picker' } | null {
    return this.planPreview
  }

  /** 打开计划全文预览——复用 pager overlay（固定每页 height-4 行、PgUp/PgDn 翻页）。 */
  openPlanPreview(slug: string, returnTo?: 'approval' | 'plan-picker', draftPath?: string): void {
    this.planPreview = { slug, ...(draftPath ? { draftPath } : {}), ...(returnTo ? { returnTo } : {}) }
    // pagerContent 的 detail 指针互斥：plan 分支排最前，但清掉旧指针防歧义。
    this.workerDetailWorkerId = null
    this.jobDetailId = null
    const nav = this.overlayController.nav()
    nav.pagerPage = 0
    nav.pagerMode = 'page'
    nav.pagerSearchQuery = ''
    nav.pagerSearchCurrent = 0
    nav.pagerSelectedMessage = 0
    this.activateOverlay('pager')
  }

  /** 打开用户问题选项选择面板（ask_user_question）— 支持多题分页 + 多选。 */
  openAskUserQuestionPanel(info: AskUserQuestionInfo): void {
    const questions = info.questions.filter(q => q.options.length > 0)
    if (questions.length === 0) return
    this.choicePanelKind = 'ask-user-question'
    this.pendingAskFlow = {
      questions,
      index: 0,
      drafts: questions.map(() => ({
        selected: [],
        otherSelected: false,
        otherText: '',
        skipped: false,
      })),
    }
    this.choicePanelSubMode = 'select'
    this.choicePanelInputBuffer = ''
    this.choicePanelInputFor = undefined
    this.overlayController.nav().choicePanelIndex = 0
    this.activateOverlay('choice-panel')
  }

  /** 该题是否已有有效答案（选中项或自定义文本）——Tab ✓ 与「下一未答题」判定共用。 */
  private askDraftHasAnswer(d: AskAnswerDraft | undefined): boolean {
    return !!d && (d.selected.length > 0 || (d.otherSelected && d.otherText.trim().length > 0))
  }

  /** Build AskQuestionPanelData for the ask panel（Tab 条 + 题页/提交页两支）。 */
  buildAskPanelData(): AskQuestionPanelData {
    const flow = this.pendingAskFlow
    if (!flow) {
      return { tabs: [], activeTab: 0, prompt: '', allowMultiple: false, options: [], selected: [], cursor: 0, review: [] }
    }
    const q = flow.questions[flow.index]
    const draft = q ? flow.drafts[flow.index] : undefined
    return {
      tabs: flow.questions.map((qq, i) => ({
        label: truncateToDisplayWidth(qq.prompt.replace(/\s+/g, ' ').trim(), 14),
        answered: this.askDraftHasAnswer(flow.drafts[i]),
      })),
      activeTab: flow.index,
      prompt: q?.prompt ?? '',
      allowMultiple: q?.allowMultiple ?? false,
      options: q?.options ?? [],
      selected: draft?.selected ?? [],
      cursor: this.overlayController.nav().choicePanelIndex,
      inputSubMode: this.getChoicePanelInputState(),
      review: flow.questions.map((qq, i) => ({
        prompt: qq.prompt,
        answer: draftToAnswer(flow.drafts[i]!, qq.options),
      })),
    }
  }

  /**
   * Resolve an ask-question choice（Other 输入子模式提交 / 旧的 exec 兜底路径）。
   * 题页答题只推进 Tab，不关面板——关闭只由提交页「提交回答」/「取消」或 Esc 触发，
   * 所以这里恒返回 false。
   */
  resolveAskChoice(id: string): boolean {
    const flow = this.pendingAskFlow
    if (!flow) return true
    const q = flow.questions[flow.index]
    if (!q) return true
    const draft = flow.drafts[flow.index]!

    if (id === '__other__') {
      const text = this.choicePanelInputBuffer.trim()
      if (!text && !draft.otherSelected) return false
      if (!q.allowMultiple) draft.selected = []
      draft.otherSelected = true
      draft.otherText = text
      draft.skipped = false
      this.advanceAskFlow()
      return false
    }

    const idx = Number(id)
    if (!Number.isFinite(idx) || idx < 0 || idx >= q.options.length) return false

    if (q.allowMultiple) {
      // 切换勾选，停在原题。
      const has = draft.selected.includes(idx)
      draft.selected = has ? draft.selected.filter(i => i !== idx) : [...draft.selected, idx]
      draft.skipped = false
      this.overlay.rerender()
      return false
    }

    flow.drafts[flow.index] = {
      selected: [idx],
      otherSelected: false,
      otherText: '',
      skipped: false,
    }
    this.advanceAskFlow()
    return false
  }

  /** Confirm multi-select (Enter)——有勾选即推进到下一未答题/提交页。 */
  confirmAskMultiSelect(): boolean {
    const flow = this.pendingAskFlow
    if (!flow) return true
    const q = flow.questions[flow.index]
    const draft = flow.drafts[flow.index]
    if (!q?.allowMultiple || !draft) return false
    if (!this.askDraftHasAnswer(draft)) return false // 未选任何项
    draft.skipped = false
    this.advanceAskFlow()
    return false
  }

  /**
   * 推进到下一个未答题 Tab；全部已答 → 跳到提交页（index === questions.length）。
   * 永远不在这里提交——提交只发生在提交页用户显式选「提交回答」。
   */
  private advanceAskFlow(): void {
    const flow = this.pendingAskFlow
    if (!flow) return
    for (let i = flow.index + 1; i < flow.questions.length; i++) {
      if (!this.askDraftHasAnswer(flow.drafts[i])) {
        flow.index = i
        this.resetAskCursor()
        this.overlay.rerender()
        return
      }
    }
    flow.index = flow.questions.length
    this.resetAskCursor()
    this.overlay.rerender()
  }

  /** Tab 切换/推进时的光标与输入子模式复位。 */
  private resetAskCursor(): void {
    this.choicePanelSubMode = 'select'
    this.choicePanelInputBuffer = ''
    this.choicePanelInputFor = undefined
    this.overlayController.nav().choicePanelIndex = 0
  }

  /** 提交页「提交回答」：组串并作为普通用户消息发出，随后由调用方关闭面板。 */
  private submitAskAnswers(): void {
    const flow = this.pendingAskFlow
    if (!flow) return
    const text = composeAnswers(flow.questions, flow.drafts, '已全部跳过')
    this.choicePanelKind = 'effort'
    this.pendingAskFlow = undefined
    this.resetAskCursor()
    this.submitText(text)
  }

  /** 进入 choice-panel 输入子模式——统一收口四个状态位（subMode/buffer/cursor/for）。 */
  private enterChoicePanelInput(target: 'plan-reject-comment' | 'ask-other'): void {
    this.choicePanelSubMode = 'input'
    this.choicePanelInputBuffer = ''
    this.choicePanelInputCursor = 0
    this.choicePanelInputFor = target
    this.overlay.rerender()
  }

  /** choice-panel 输入子模式渲染数据（由 renderChoicePanel 读取）。 */
  getChoicePanelInputState(): ChoicePanelData['inputSubMode'] {
    if (this.choicePanelSubMode !== 'input') return undefined
    if (this.choicePanelInputFor === 'plan-reject-comment') {
      return {
        active: true,
        label: '驳回反馈',
        placeholder: '输入反馈后回车（可留空）',
        value: this.choicePanelInputBuffer,
        cursorPos: this.choicePanelInputCursor,
      }
    }
    if (this.choicePanelInputFor === 'ask-other') {
      return {
        active: true,
        label: '自定义回答',
        placeholder: '输入你的回答后回车',
        value: this.choicePanelInputBuffer,
        cursorPos: this.choicePanelInputCursor,
      }
    }
    return undefined
  }

  /** connect overlay 渲染数据（由 registerOverlays 的 render 闭包读取）。 */
  getConnectOverlayData(): ConnectOverlayData {
    const view = this.connectFlow?.view() ?? { kind: 'choice' as const, title: '', options: [] }
    return {
      view,
      input: this.connectInput,
      error: this.connectError,
      selectedIndex: this.overlayController.nav().connectIndex,
      cursorPos: this.connectCursor,
      cursorVisible: this.connectCursorVisibleNow(),
      formFieldIndex: this.connectFormFieldIndex,
    }
  }

  /** Dedicated vision overlay data; rendering intentionally reuses only the generic wizard surface. */
  getVisionOnboardingOverlayData(): ConnectOverlayData {
    const view = this.visionOnboardingFlow?.view() ?? { kind: 'choice' as const, title: '', options: [] }
    return {
      view: view as unknown as ConnectOverlayData['view'],
      input: this.visionInput,
      error: this.visionError,
      selectedIndex: this.overlayController.nav().connectIndex,
      cursorPos: this.connectCursor,
    }
  }

  private advanceVisionOnboarding(result: VisionOnboardingResult): void {
    const flow = this.visionOnboardingFlow
    if (!flow) return
    if (result.kind === 'error') {
      this.visionError = result.message
      this.overlay.rerender()
      return
    }
    if (result.kind === 'next') {
      this.visionInput = ''
      this.connectCursor = 0
      this.visionError = undefined
      this.overlayController.nav().connectIndex = 0
      this.overlay.rerender()
      return
    }
    if (result.kind === 'done') {
      this.visionOnboardingFlow = undefined
      this.visionExec = undefined
      this.commitStatic(result.summary)
      this.deactivateOverlay()
      return
    }
    const execute = this.visionExec
    if (!execute) {
      this.advanceVisionOnboarding(flow.requestFailed('识图桥服务端请求未接线'))
      return
    }
    this.visionInput = ''
    this.visionError = undefined
    this.overlay.rerender()
    void execute(result.request).then(response => {
      if (this.visionOnboardingFlow !== flow) return
      if (result.request.kind === 'discover') this.advanceVisionOnboarding(flow.applyDiscovery(response.candidates ?? []))
      else this.advanceVisionOnboarding(flow.applyOnboardSuccess())
    }).catch(error => {
      if (this.visionOnboardingFlow === flow) this.advanceVisionOnboarding(flow.requestFailed(error instanceof Error ? error.message : String(error)))
    })
  }

  /** 搜索过滤缩短选项列表后，光标索引可能越界——收敛回有效范围。 */
  private clampConnectIndex(): void {
    const count = this.connectFlow?.view().options?.length ?? 0
    const nav = this.overlayController.nav()
    nav.connectIndex = count > 0 ? Math.min(nav.connectIndex, count - 1) : 0
  }

  /** 赋值输入缓冲并把光标停到末尾；resetBlink 时清空闪烁激活态（预填等静止场景）。 */
  private setConnectInput(value: string, resetBlink: boolean): void {
    this.connectInput = value
    this.connectCursor = value.length
    if (resetBlink) {
      this.connectEditActiveAt = 0
      this.stopConnectBlink()
    }
  }

  /** 搜索框闪烁联动：非空 → 激活闪烁（打字刷新相位）；清空 → 停止闪烁、
   *  光标常亮停在占位符前方。下一步推进会经 setConnectInput 整体复位。 */
  private syncConnectFilterBlink(): void {
    const filter = this.connectFlow?.view().filter ?? ''
    if (filter.length > 0) this.markConnectEditActivity()
    else {
      this.connectEditActiveAt = 0
      this.stopConnectBlink()
    }
  }

  /** 移动/增删发生时调用：记录激活时间，启动闪烁定时器（已在跑则复用）。 */
  private markConnectEditActivity(): void {
    this.connectEditActiveAt = Date.now()
    if (!this.connectBlinkTimer) {
      this.connectBlinkTimer = setInterval(() => this.tickConnectBlink(), CONNECT_BLINK_TICK_MS)
      this.connectBlinkTimer.unref?.() // 不拦进程退出（测试场景无清理也不悬挂）
    }
  }

  /** 光标此刻是否可见：静止常亮；激活后按 500ms 间隔持续翻转，直到复位。 */
  private connectCursorVisibleNow(): boolean {
    if (this.connectEditActiveAt === 0) return true
    const elapsed = Date.now() - this.connectEditActiveAt
    return Math.floor(elapsed / CONNECT_BLINK_PERIOD_MS) % 2 === 0
  }

  private tickConnectBlink(): void {
    if (this.overlay.activeId() !== 'connect') {
      this.stopConnectBlink()
      return
    }
    this.overlay.rerender()
  }

  private stopConnectBlink(): void {
    if (this.connectBlinkTimer) {
      clearInterval(this.connectBlinkTimer)
      this.connectBlinkTimer = null
    }
  }

  /** 推进 connect 向导：next 清空输入、error 显示提示、commit 落库并关闭。 */
  private advanceConnect(result: ConnectStepResult): void {
    if (result.kind === 'error') {
      this.connectError = result.message
      this.overlay.rerender()
      return
    }
    if (result.kind === 'probe') {
      // probe-first：flow 进入 busy 态，异步探测完成后把 report 回灌。
      // 探测期间用户 Esc 会清掉 connectFlow —— 回调先核对实例再回灌。
      const flow = this.connectFlow
      this.setConnectInput('', true)
      this.connectError = undefined
      this.overlay.rerender()
      void probeProvider({ baseUrl: result.baseUrl, apiKey: result.apiKey, protocol: result.protocol, probeModel: result.probeModel, providerName: result.providerName })
        .then(report => {
          if (this.connectFlow === flow && flow) this.advanceConnect(flow.applyProbe(report))
        })
        .catch(e => {
          if (this.connectFlow === flow && flow) {
            this.advanceConnect(flow.probeFailed(e instanceof Error ? e.message : String(e)))
          }
        })
      return
    }
    if (result.kind === 'next') {
      // 草稿恢复会在这里一次性预填输入缓冲（restoredInput 读后即清）；
      // 否则把步骤的 defaultValue 预填进缓冲区——预填地址等应是可直接编辑的
      // 实体，而不是灰底占位符（placeholder 只提示、不随编辑变化）。
      const restored = this.connectFlow?.takeRestoredInput()
      const nextView = this.connectFlow?.view()
      this.setConnectInput(
        restored && restored.length > 0
          ? restored
          : (nextView?.kind === 'input' ? nextView.defaultValue ?? '' : ''),
        true,
      )
      this.connectError = undefined
      this.overlayController.nav().connectIndex = 0
      this.connectFormFieldIndex = 0
      // form 步：光标落首个可编辑字段末尾（setConnectInput 刚把光标归零）。
      const firstField = nextView?.kind === 'form' ? (nextView.fields ?? [])[0] : undefined
      if (firstField && firstField.kind === 'text') this.connectCursor = firstField.value.length
      this.overlay.rerender()
      return
    }
    // commit — exec (commitStatic / model switch) MUST run before
    // deactivateOverlay so the overlay-exit repaint is the last write; running
    // it after leaves a ghost frame (see overlay-deactivate-regression).
    const exec = this.overlayController.getConnectExec()
    this.connectFlow = undefined
    // exec 失败（如 registerProvider 撞名）时草稿必须保留，否则恢复场景下
    // 用户全部输入作废——返回值 undefined 视为成功（兼容旧签名）。
    const ok = exec?.(result.commit, result.summary) ?? true
    if (ok) {
      clearConnectDraft()
      // 暂存密钥已由 registerProvider 以最终 provider 名重写——清掉占位条目
      // （DIY 用 diy-pending；preset 流程用 draft-<presetKey> 草稿专用名）。
      deleteSecret(DIY_PENDING_KEY_REF)
      if (result.commit.mode === 'preset') deleteSecret(draftSecretRef(result.commit.setup.providerName))
    }
    this.deactivateOverlay()
  }

  /** settings overlay 渲染数据（由 registerOverlays 的 render 闭包读取）。 */
  getSettingsOverlayData(): SettingsView {
    return this.settingsFlow?.view() ?? {
      mode: 'browse',
      focus: 'categories',
      categories: [],
      categoryIndex: 0,
      fields: [],
      fieldIndex: 0,
      dirtyBlocks: [],
    }
  }

  /** S 键：把脏块交给落盘通道，结果回灌 flow（面板内显示，关闭时进 scrollback）。 */
  private commitSettingsSave(): void {
    const flow = this.settingsFlow
    if (!flow) return
    const request = flow.saveRequest()
    if (request.blocks.length === 0) {
      flow.commitSaved({ saved: [], errors: [] })
      this.overlay.rerender()
      return
    }
    const result = this.settingsSave
      ? this.settingsSave(request)
      : { saved: [], errors: ['设置落盘通道未接线'] }
    flow.commitSaved(result)
    const parts: string[] = []
    if (result.saved.length > 0) parts.push(`✓ 设置已保存：${result.saved.join(', ')}（除审批模式外均下次会话生效）`)
    if (result.errors.length > 0) parts.push(`⚠ 设置保存失败：${result.errors.join('；')}`)
    this.settingsNotice = parts.join('\n')
    this.overlay.rerender()
  }

  private closeSettings(): void {
    const notice = this.settingsNotice
    this.settingsFlow = undefined
    this.settingsSave = undefined
    this.settingsNotice = undefined
    // 先入 scrollback 再退 overlay：退出重绘是最后一次写，顺序反了会留幽灵帧。
    if (notice) this.commitStatic(notice)
    this.deactivateOverlay()
  }

  private cancelConnect(): void {
    const flow = this.connectFlow
    let savedDraft = false
    if (flow && !flow.draftPromptPending()) {
      // Esc 在恢复提示上 → 文件原样保留；密钥已保存后有进展 → 落盘（含未回车文本）；
      // 密钥保存前 Esc 纯取消不落草稿；选过「重新开始」且无新进展 → 清掉旧草稿。
      const secretInfo = flow.draftSecretInfo()
      // 密钥步上未回车的文本可能是半截明文 key——绝不落盘。
      const draft = flow.toDraft(secretInfo.onKeyStep ? undefined : this.connectInput)
      if (draft) {
        // 草稿磁盘永不落明文：密钥先进 secrets.json（0600），草稿只留引用。
        if (secretInfo.apiKey) {
          // PR#38 审查阻断 5：草稿引用一律用草稿专用名（draft-<presetKey>），
          // 绝不写正式 provider 名——Esc 取消不得覆盖在用凭证。
          const ref = draftSecretRef(secretInfo.presetKey)
          try {
            writeSecret(ref, secretInfo.apiKey)
            draft.collected.keyRef = ref
          } catch { /* secrets 写失败 → 草稿保留其余进度，恢复时降级回密钥步 */ }
        }
        saveConnectDraft(draft)
        savedDraft = true
      } else if (flow.wasDraftDiscarded()) {
        clearConnectDraft()
        deleteSecret(draftSecretRef(secretInfo.presetKey))
      }
    }
    this.connectFlow = undefined
    // 纯取消（无进展未落草稿）= 用户看过向导且选择不配——写首启哨兵，
    // 新会话不再自动弹 /connect（手动 /connect 不受影响）。有草稿则说明在
    // 配置中途，下次新会话仍应引导续配。
    if (!savedDraft) dismissOnboarding()
    // Buffer the notice into scrollback before exiting the overlay, so the
    // deactivate repaint paints a single clean frame (no ghost of the overlay).
    this.commitStatic(savedDraft
      ? '已取消服务商配置。进度已存为草稿（密钥单独存于 secrets.json），下次 /connect 可恢复。'
      : '已取消服务商配置。新会话不再自动弹出本向导——/connect 可随时打开。')
    this.deactivateOverlay()
  }

  /** init overlay 渲染数据（由 registerOverlays 的 render 闭包读取）。 */
  getInitOverlayData(): InitOverlayData {
    const view = this.initFlow?.view() ?? { kind: 'multi-choice' as const, title: '', options: [] }
    return {
      view,
      error: this.initError,
      selectedIndex: this.overlayController.nav().initIndex,
    }
  }

  /** 推进 init 向导（Enter）：next 复位光标、error 显示提示、commit 落盘并关闭。 */
  private advanceInit(result: InitStepResult): void {
    if (result.kind === 'error') {
      this.initError = result.message
      this.overlay.rerender()
      return
    }
    if (result.kind === 'next') {
      this.initError = undefined
      this.overlayController.nav().initIndex = 0
      this.overlay.rerender()
      return
    }
    // commit — 与 connect 同序：先 exec 再 deactivate，避免幽灵帧。
    const exec = this.overlayController.getInitExec()
    this.initFlow = undefined
    exec?.(result.commit, result.summary)
    this.deactivateOverlay()
  }

  private cancelInit(): void {
    this.initFlow?.cancel()
    this.initFlow = undefined
    // 与 cancelConnect 同理：先把提示写进 scrollback，退出重绘才是最后一帧。
    this.commitStatic('已取消项目初始化。')
    this.deactivateOverlay()
  }

  /** 返回 scrollback 完整文本（供 pager overlay 读取） */
  getScrollbackContent(): string {
    return this.commit.getContent()
  }

  /** pager 是否处于 verbose 层（完整工具输出视图）。供 pagerContent provider 选择内容源。 */
  isPagerVerbose(): boolean {
    return this.overlayController.nav().pagerVerbose
  }

  /** 返回当前活跃星域名称（供 starmap overlay 高亮） */
  getDomainName(): string | undefined {
    return this.state.domainName
  }

  /**
   * Get workers for the `/tasks` overlay.
   * Reads per-worker state from the fleet read model (fed by onDelegationActivity),
   * grouped by the spawning delegation tool. Falls back to an empty fleet when no
   * delegation is in flight.
   */
  getTasksData(filter?: TasksFilter): TasksData {
    const activeFilter = filter ?? this.overlayController.nav().tasksFilter ?? 'running'
    const now = Date.now()
    const source = activeFilter === 'running'
      ? this.fleet.getActiveWorkers(now)
      : activeFilter === 'completed'
        ? this.fleet.getCompletedWorkers(now)
        : this.fleet.getAllWorkers(now, 'all')
    const byParent = new Map<string, TasksWorkerRow[]>()
    for (const w of source) {
      const arr = byParent.get(w.parentToolId) ?? []
      arr.push({
        workerId: w.workerId,
        shortLabel: w.shortLabel,
        profile: w.profile,
        authority: w.authority,
        status: w.status,
        activity: w.activity,
        objective: w.contract?.objective,
        elapsedMs: w.elapsedMs,
        toolUseCount: w.toolUseCount,
        tokenCount: w.tokenCount,
        unread: w.unread && w.terminal,
        failureReason: w.failureReason,
      })
      byParent.set(w.parentToolId, arr)
    }
    const groups: TasksGroup[] = []
    for (const [parentToolId, workers] of byParent) {
      const p = activeFilter === 'completed'
        // completed 分组进度从归档区重新计算
        ? this.deriveGroupProgress(parentToolId, workers)
        : this.fleet.getGroupProgress(parentToolId)
      groups.push({ parentToolId, total: p.total, done: p.done, failed: p.failed, running: p.running, workers })
    }
    return { groups, filter: activeFilter, completedCount: this.fleet.completedSize() }
  }

  private deriveGroupProgress(parentToolId: string, workers: TasksWorkerRow[]): import('../fleet-registry.js').FleetGroupProgress {
    const total = workers.length
    const done = workers.filter(w => w.status === 'completed').length
    const failed = workers.filter(w => w.status !== 'completed' && w.status !== 'running').length
    const running = workers.filter(w => w.status === 'running').length
    return { total, done, failed, running }
  }

  /** 当前是否在 pager 中查看某个 worker 的 detail。 */
  getWorkerDetailId(): string | null {
    return this.workerDetailWorkerId
  }

  /** 获取当前在 fleet（含归档区）中的 worker 实时视图。 */
  getWorkerDetailView(workerId: string): import('../fleet-registry.js').FleetWorkerView | undefined {
    return this.fleet.getWorkerById(workerId)
  }

  /** 当前是否在 pager 中查看某个 job 的日志。 */
  getJobDetailId(): string | null {
    return this.jobDetailId
  }

  /** 获取 job 日志文本（供 pagerContent provider 构造 PagerData）。 */
  getJobDetailView(jobId: string): string | null {
    return this.jobLogs?.(jobId) ?? null
  }

  /** 打开 job 日志查看——复用 pager overlay，仿 openWorkerDetail。 */
  private openJobDetail(jobId: string): void {
    this.jobDetailId = jobId
    const nav = this.overlayController.nav()
    nav.pagerPage = 0
    nav.pagerMode = 'page'
    nav.pagerSearchQuery = ''
    nav.pagerSearchCurrent = 0
    nav.pagerSelectedMessage = 0
    this.activateOverlay('pager')
  }

  /**
   * 解析用户输入的 worker 标识（完整 workOrderId 或短标签），返回可续作的 worker。
   * 先查 fleet（活跃 + 已归档），再查持久化的 worker session 文件。
   */
  resolveWorkerId(query: string): { workerId: string; profile: string; objective?: string } | null {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return null
    const all = [...this.fleet.getActiveWorkers(), ...this.fleet.getCompletedWorkers()]
    const found = all.find(
      (w) => w.workerId.toLowerCase() === normalized || w.shortLabel.toLowerCase() === normalized,
    )
    if (found) {
      return { workerId: found.workerId, profile: found.profile, objective: found.activity }
    }
    // 未在 fleet 命中时，尝试读持久化 session（resume 场景）
    const persisted = loadWorkerSession(query)
    if (persisted) {
      return { workerId: persisted.workOrderId, profile: persisted.profile, objective: persisted.objective }
    }
    return null
  }

  /** 兼容旧名：返回 running worker 列表。 */
  getRunningWorkers(): TasksData {
    return this.getTasksData('running')
  }

  /** 接线 worker kill 回调（/tasks 里 x 键 → per-worker AbortController）。 */
  setWorkerKill(fn: (workerId: string) => boolean): void {
    this.workerKill = fn
  }

  /** 接线输入直达回调（worker 视图输入 → coordinator per-worker steer 队列）。 */
  setWorkerSteer(fn: (workerId: string, text: string) => boolean): void {
    this.workerSteer = fn
  }

  /**
   * 接线 worker 存活查询（main.ts → coordinator.isWorkerRunning）并启动
   * reconcile 周期：对 fleet 中 running 但已不在跑的 worker 补发 failed 终态
   * （sweepStaleDelegationNodes 的 CLI 等价物，兜底「worker 真卡死/进程丢失
   * 但终态事件漏发」——2026-08 调研落地）。
   */
  setWorkerRunningQuery(fn: (workerId: string) => boolean): void {
    this.workerRunningQuery = fn
    if (this.fleetReconcileTimer) return
    this.fleetReconcileTimer = setInterval(() => this.reconcileStaleDelegations(), 5_000)
  }

  /** 周期 reconcile：补发失联 worker 的 failed 终态（幂等——补发后转 terminal）。 */
  private reconcileStaleDelegations(): void {
    if (!this.workerRunningQuery) return
    const gone = this.fleet.findGoneWorkers(this.workerRunningQuery)
    if (gone.length === 0) return
    for (const w of gone) {
      const activity: DelegationActivity = {
        workOrderId: w.workerId,
        parentToolId: w.parentToolId,
        status: 'failed',
        progressLine: 'worker 失联（进程不在跑），终态由 CLI reconcile 补发',
        failureReason: 'worker_gone',
        summary: 'Worker lost contact; terminal state backfilled by CLI reconcile.',
      }
      this.fleet.apply(activity)
      this.mirror.apply(activity)
    }
    this.markActivity()
    this.writeBatcher.schedule()
  }

  /** 当前切入查看的 worker id（null = 主视图）。 */
  getViewingWorkerId(): string | null {
    return this.viewingWorkerId
  }

  /** 切入 worker 视图：live 区改为渲染该 worker 的镜像消息 tail，输入直达。 */
  enterWorkerView(workerId: string): void {
    this.viewingWorkerId = workerId
    this.fleet.markSeen(workerId)
    this.renderLive()
  }

  /** 退出 worker 视图，回到主视图。 */
  exitWorkerView(): void {
    if (!this.viewingWorkerId) return
    this.viewingWorkerId = null
    this.renderLive()
  }

  /** 打开指定 worker 的 detail pager。 */
  openWorkerDetail(workerId: string): void {
    this.workerDetailWorkerId = workerId
    this.fleet.markSeen(workerId)
    const nav = this.overlayController.nav()
    nav.pagerPage = 0
    nav.pagerMode = 'page'
    nav.pagerSearchQuery = ''
    nav.pagerSearchCurrent = 0
    nav.pagerSelectedMessage = 0
    this.activateOverlay('pager')
  }

  /**
   * Overlay 导航键处理。返回 true 表示已消费（调用方应 return）。
   * - pager：j/↓/PgDn 下翻，k/↑/PgUp 上翻，Home/End 首末页，q 关闭
   * - command-palette：↑/↓ 移动选中，Enter 执行并关闭，q 关闭
   * - 其它 overlay（starmap/chronicle）：仅 q 关闭（无内部导航）
   * Esc/Ctrl+C 不在此消费，留给全局兜底统一关闭。
   */
  private handleOverlayKey(key: { name: string; char: string; ctrl?: boolean; meta?: boolean; shift?: boolean }): boolean {
    const id = this.overlay.activeId()
    const c = key.char.toLowerCase()
    const isSearch = id === 'command-palette' || id === 'history-search'

    // Dedicated vision bridge wizard. It has no provider probe or config write path:
    // injected executor calls the same discovery/onboarding service boundary as Desktop.
    if (id === 'vision-onboarding' && this.visionOnboardingFlow) {
      const flow = this.visionOnboardingFlow
      const view = flow.view()
      if (key.name === 'escape') {
        this.visionOnboardingFlow = undefined
        this.visionExec = undefined
        this.deactivateOverlay()
        return true
      }
      if (view.kind === 'busy') return true
      if (view.kind === 'choice') {
        const options = view.options ?? []
        const nav = this.overlayController.nav()
        if (key.name === 'down') { if (options.length) { nav.connectIndex = (nav.connectIndex + 1) % options.length; this.overlay.rerender() }; return true }
        if (key.name === 'up') { if (options.length) { nav.connectIndex = (nav.connectIndex - 1 + options.length) % options.length; this.overlay.rerender() }; return true }
        if (key.name === 'return') {
          const option = options[nav.connectIndex]
          if (option) this.advanceVisionOnboarding(flow.choose(option.id))
          return true
        }
        return true
      }
      if (key.name === 'return') { this.advanceVisionOnboarding(flow.submit(this.visionInput)); return true }
      if (key.name === 'left') { this.connectCursor = Math.max(0, this.connectCursor - 1); this.overlay.rerender(); return true }
      if (key.name === 'right') { this.connectCursor = Math.min(this.visionInput.length, this.connectCursor + 1); this.overlay.rerender(); return true }
      if (key.name === 'backspace' || key.name === 'ctrl_h') {
        if (this.connectCursor > 0) {
          this.visionInput = this.visionInput.slice(0, this.connectCursor - 1) + this.visionInput.slice(this.connectCursor)
          this.connectCursor--
        }
        this.visionError = undefined
        this.overlay.rerender()
        return true
      }
      if (key.ctrl && c === 'u') { this.visionInput = ''; this.connectCursor = 0; this.visionError = undefined; this.overlay.rerender(); return true }
      if (this.isPrintableKey(key)) {
        this.visionInput = this.visionInput.slice(0, this.connectCursor) + key.char + this.visionInput.slice(this.connectCursor)
        this.connectCursor += key.char.length
        this.visionError = undefined
        this.overlay.rerender()
      }
      return true
    }

    // Connect wizard — a stateful choice/input overlay. Handled first so typed
    // characters (incl. 'q') feed the input buffer instead of closing the overlay.
    if (id === 'connect' && this.connectFlow) {
      const view = this.connectFlow.view()
      if (key.name === 'escape') {
        // form 步 Esc = 返回模型选择重挑（对应旧「返回模型选择」选项）；
        // 其余步骤维持全局语义：取消向导（落草稿）。
        if (view.kind === 'form') this.advanceConnect(this.connectFlow.backFromAdvanced())
        else this.cancelConnect()
        return true
      }
      if (view.kind === 'busy') {
        // 探测进行中——除 Esc（上面已处理）外吞掉所有按键。
        return true
      }
      if (view.kind === 'form') {
        const fields = view.fields ?? []
        if (fields.length === 0) return true
        const idx = Math.min(this.connectFormFieldIndex, fields.length - 1)
        const field = fields[idx]!
        const selectField = (i: number): void => {
          this.connectFormFieldIndex = i
          const f = fields[i]!
          this.connectCursor = f.kind === 'text' ? f.value.length : 0
          // 换字段 = 静止起点：光标常亮，下次编辑再激活闪烁。
          this.connectEditActiveAt = 0
          this.stopConnectBlink()
          this.overlay.rerender()
        }
        if (key.name === 'down') { selectField((idx + 1) % fields.length); return true }
        if (key.name === 'up') { selectField((idx - 1 + fields.length) % fields.length); return true }
        if (field.kind === 'toggle') {
          if (key.name === 'left' || key.name === 'right' || key.char === ' ') {
            this.connectFlow.toggleAdvancedField(field.id)
            this.connectError = undefined
            this.overlay.rerender()
          }
          return true
        }
        // text 字段——与输入步同套光标编辑语义，缓冲真源在 flow 草稿。
        if (key.name === 'return') { this.advanceConnect(this.connectFlow.submitAdvancedForm()); return true }
        if (key.name === 'left') {
          this.connectCursor = Math.max(0, this.connectCursor - 1)
          this.markConnectEditActivity()
          this.overlay.rerender()
          return true
        }
        if (key.name === 'right') {
          this.connectCursor = Math.min(field.value.length, this.connectCursor + 1)
          this.markConnectEditActivity()
          this.overlay.rerender()
          return true
        }
        if (key.name === 'backspace' || key.name === 'ctrl_h') {
          if (this.connectCursor > 0) {
            const v = field.value
            this.connectFlow.editAdvancedField(field.id, v.slice(0, this.connectCursor - 1) + v.slice(this.connectCursor))
            this.connectCursor--
          }
          this.connectError = undefined
          this.markConnectEditActivity()
          this.overlay.rerender()
          return true
        }
        if (key.ctrl && c === 'u') {
          this.connectFlow.editAdvancedField(field.id, '')
          this.connectCursor = 0
          this.connectError = undefined
          this.markConnectEditActivity()
          this.overlay.rerender()
          return true
        }
        if (this.isPrintableKey(key)) {
          const v = field.value
          this.connectFlow.editAdvancedField(field.id, v.slice(0, this.connectCursor) + key.char + v.slice(this.connectCursor))
          this.connectCursor += key.char.length
          this.connectError = undefined
          this.markConnectEditActivity()
          this.overlay.rerender()
          return true
        }
        return true
      }
      if (view.kind === 'choice' || view.kind === 'multi-choice') {
        const options = view.options ?? []
        const count = options.length
        const nav = this.overlayController.nav()
        if (key.name === 'down') { if (count > 0) { nav.connectIndex = (nav.connectIndex + 1) % count; this.overlay.rerender() } return true }
        if (key.name === 'up') { if (count > 0) { nav.connectIndex = (nav.connectIndex - 1 + count) % count; this.overlay.rerender() } return true }
        if (view.kind === 'multi-choice' && key.char === ' ') {
          // 勾选不推进步骤——原地重绘，光标保持不动（走 advanceConnect 会被
          // next 分支重置 connectIndex，光标会跳回第一项）。
          const opt = options[nav.connectIndex]
          if (opt) {
            const res = this.connectFlow.toggle(opt.id)
            this.connectError = res.kind === 'error' ? res.message : undefined
            this.overlay.rerender()
          }
          return true
        }
        if (view.kind === 'multi-choice' && key.name === 'ctrl_a') {
          const res = this.connectFlow.toggleAllModels()
          this.connectError = res.kind === 'error' ? res.message : undefined
          this.overlay.rerender()
          return true
        }
        // Type-to-search：多选步的可打印字符进过滤器（不再是吞掉）。
        if (view.kind === 'multi-choice' && (key.name === 'backspace' || key.name === 'ctrl_h')) {
          this.connectFlow.backspaceModelFilter()
          this.syncConnectFilterBlink()
          this.clampConnectIndex()
          this.overlay.rerender()
          return true
        }
        if (view.kind === 'multi-choice' && key.ctrl && c === 'u') {
          this.connectFlow.clearModelFilter()
          this.syncConnectFilterBlink()
          this.clampConnectIndex()
          this.overlay.rerender()
          return true
        }
        if (view.kind === 'multi-choice' && this.isPrintableKey(key)) {
          this.connectFlow.typeModelFilter(key.char)
          this.syncConnectFilterBlink()
          this.clampConnectIndex()
          this.overlay.rerender()
          return true
        }
        if (key.name === 'return') {
          if (view.kind === 'multi-choice') {
            this.advanceConnect(this.connectFlow.confirm())
          } else {
            const opt = options[nav.connectIndex]
            if (opt) this.advanceConnect(this.connectFlow.submitChoice(opt.id))
          }
          return true
        }
        return true
      }
      // input step
      if (key.name === 'return') { this.advanceConnect(this.connectFlow.submitInput(this.connectInput)); return true }
      if (key.name === 'left') {
        this.connectCursor = Math.max(0, this.connectCursor - 1)
        this.markConnectEditActivity()
        this.overlay.rerender()
        return true
      }
      if (key.name === 'right') {
        this.connectCursor = Math.min(this.connectInput.length, this.connectCursor + 1)
        this.markConnectEditActivity()
        this.overlay.rerender()
        return true
      }
      // Backspace has two encodings: \x7f → 'backspace', \x08 → 'ctrl_h'.
      // Matching both (mirroring InputLine.handleKey) keeps delete working on
      // terminals/SSH sessions whose backspace emits BS (\x08) — otherwise the
      // key is swallowed by the trailing `return true` and the user can type
      // but not erase.
      if (key.name === 'backspace' || key.name === 'ctrl_h') {
        if (this.connectCursor > 0) {
          this.connectInput = this.connectInput.slice(0, this.connectCursor - 1) + this.connectInput.slice(this.connectCursor)
          this.connectCursor--
        }
        this.connectError = undefined
        this.markConnectEditActivity()
        this.overlay.rerender()
        return true
      }
      if (key.ctrl && c === 'u') {
        this.connectInput = ''
        this.connectCursor = 0
        this.connectError = undefined
        this.markConnectEditActivity()
        this.overlay.rerender()
        return true
      }
      if (this.isPrintableKey(key)) {
        this.connectInput = this.connectInput.slice(0, this.connectCursor) + key.char + this.connectInput.slice(this.connectCursor)
        this.connectCursor += key.char.length
        this.connectError = undefined
        this.markConnectEditActivity()
        this.overlay.rerender()
        return true
      }
      return true
    }

    // Settings panel — stateful two-column overlay. Handled before the generic
    // q-close because 'q' / 's' are legitimate characters while a text field is
    // being edited.
    if (id === 'settings' && this.settingsFlow) {
      const flow = this.settingsFlow
      const editing = flow.isTextEditing()
      if (key.name === 'escape') {
        if (flow.cancel() === 'closed') this.closeSettings()
        else this.overlay.rerender()
        return true
      }
      if (key.name === 'return') {
        if (flow.isConfirmingDiscard()) { flow.confirmDiscard(); this.closeSettings(); return true }
        flow.activate()
        this.overlay.rerender()
        return true
      }
      if (key.name === 'up') { flow.moveUp(); this.overlay.rerender(); return true }
      if (key.name === 'down') { flow.moveDown(); this.overlay.rerender(); return true }
      if (editing) {
        // backspace (\x7f) and ctrl_h (\x08) are the same delete on different
        // terminal backspace encodings — handle both, like InputLine.
        if (key.name === 'backspace' || key.name === 'ctrl_h') { flow.backspace(); this.overlay.rerender(); return true }
        if (key.ctrl && c === 'u') { flow.clearBuffer(); this.overlay.rerender(); return true }
        if (this.isPrintableKey(key)) { flow.typeChar(key.char); this.overlay.rerender(); return true }
        return true
      }
      if (key.name === 'left' || (key.name === 'tab' && key.shift)) { flow.focusCategories(); this.overlay.rerender(); return true }
      if (key.name === 'right' || (key.name === 'tab' && !key.shift)) { flow.focusFields(); this.overlay.rerender(); return true }
      if (c === 's') { this.commitSettingsSave(); return true }
      return true
    }

    // Init wizard — a stateful multi-choice/confirm overlay. Handled before the
    // generic q-close so keystrokes never leak out of the wizard.
    if (id === 'init' && this.initFlow) {
      const view = this.initFlow.view()
      const nav = this.overlayController.nav()
      if (key.name === 'escape') { this.cancelInit(); return true }
      if (view.kind === 'multi-choice') {
        const options = view.options ?? []
        const count = options.length
        if (key.name === 'down') { if (count > 0) { nav.initIndex = (nav.initIndex + 1) % count; this.overlay.rerender() } return true }
        if (key.name === 'up') { if (count > 0) { nav.initIndex = (nav.initIndex - 1 + count) % count; this.overlay.rerender() } return true }
        // 空格切换勾选（多选语义同 ask-flow）；光标不动、不推进步骤。
        if (c === ' ') {
          const opt = options[nav.initIndex]
          if (opt) {
            const res = this.initFlow.toggle(opt.id)
            this.initError = res.kind === 'error' ? res.message : undefined
            this.overlay.rerender()
          }
          return true
        }
        if (key.name === 'return') { this.advanceInit(this.initFlow.confirm()); return true }
        return true
      }
      // confirm 页：仅 Enter 执行 / Esc 取消。
      if (key.name === 'return') { this.advanceInit(this.initFlow.confirm()); return true }
      return true
    }

    // Domain-picker 创世碑文视图：拦截全部按键（←/→ 换域、↑↓ 滚动、g/Esc 返回），
    // 必须先于下方 Domain/Model/Theme 的 ←/→ 面板切换——genesis 模式里 ←/→ 是换域。
    if (id === 'domain-picker' && this.domainGenesisMode) {
      const entries = this.overlayController.getData()?.domainPickerData?.().entries ?? []
      const count = entries.length
      const nav = this.overlayController.nav()
      const curEntry = entries[nav.domainPickerIndex]
      const genesis = curEntry ? STAR_GENESIS.find(g => g.key === curEntry.key) : undefined
      if (key.name === 'left' || key.name === 'right') {
        if (count > 0) {
          const delta = key.name === 'left' ? -1 : 1
          nav.domainPickerIndex = (nav.domainPickerIndex + delta + count) % count
          this.domainGenesisScroll = 0
          this.overlay.rerender()
        }
        return true
      }
      if (key.name === 'down' || key.name === 'up') {
        if (genesis && curEntry) {
          const max = genesisCardMaxScroll({
            genesis,
            glyph: curEntry.uiPersona?.glyph ?? '✵',
            accent: curEntry.uiPersona?.accent ?? 'primary',
            scroll: this.domainGenesisScroll,
          }, this.columns, this.rows)
          const delta = key.name === 'down' ? 1 : -1
          this.domainGenesisScroll = Math.min(Math.max(0, this.domainGenesisScroll + delta), max)
          this.overlay.rerender()
        }
        return true
      }
      if (c === 'g' || key.name === 'escape') {
        this.domainGenesisMode = false
        this.domainGenesisScroll = 0
        this.overlay.rerender()
        return true
      }
      return true
    }

    // Tab switcher between domain-picker, model-picker, and theme-picker
    const tabs = ['domain-picker', 'model-picker', 'theme-picker']
    if (id && tabs.includes(id)) {
      if (key.name === 'right' || (key.name === 'tab' && !key.shift)) {
        const curIdx = tabs.indexOf(id)
        const nextId = tabs[(curIdx + 1) % tabs.length]!
        this.activateOverlay(nextId)
        return true
      }
      if (key.name === 'left' || (key.name === 'tab' && key.shift)) {
        const curIdx = tabs.indexOf(id)
        const nextId = tabs[(curIdx - 1 + tabs.length) % tabs.length]!
        this.activateOverlay(nextId)
        return true
      }
    }

    // q 关闭非搜索型 overlay；搜索型（palette/history）里 q 是普通查询字符，仅 Esc 关闭。
    if (c === 'q' && !isSearch) {
      this.deactivateOverlay()
      return true
    }

    // Cockpit — ←/→/Tab/Shift+Tab 循环切换子面板（与 picker tab bar 同键位语义：
    // ←/Shift+Tab 上一个，→/Tab 下一个）。此前只能 /cockpit <面板> 输命令切换。
    if (id === 'cockpit') {
      const cycle = (dir: 1 | -1): boolean => {
        const cur = PANELS.indexOf(this.getCockpitPanel())
        const next = PANELS[(cur + dir + PANELS.length) % PANELS.length]!
        this.setCockpitPanel(next)
        this.overlay.rerender()
        return true
      }
      if (key.name === 'right' || (key.name === 'tab' && !key.shift)) return cycle(1)
      if (key.name === 'left' || (key.name === 'tab' && key.shift)) return cycle(-1)
    }

    // Cache 面板 — ←/→/Tab 切换历史周期（今日/7天/30天），与 cockpit 同键位语义
    if (id === 'cache') {
      const nav = this.overlayController.nav()
      const cyclePeriod = (dir: 1 | -1): boolean => {
        const cur = CACHE_PERIODS.indexOf(nav.cachePeriod)
        nav.cachePeriod = CACHE_PERIODS[(cur + dir + CACHE_PERIODS.length) % CACHE_PERIODS.length]!
        this.overlay.rerender()
        return true
      }
      if (key.name === 'right' || (key.name === 'tab' && !key.shift)) return cyclePeriod(1)
      if (key.name === 'left' || (key.name === 'tab' && key.shift)) return cyclePeriod(-1)
    }

    if (id === 'tasks') {
      const nav = this.overlayController.nav()
      const data = this.getTasksData(nav.tasksFilter)
      const selectable = data.groups.flatMap(g => g.workers.map(w => w.workerId))
      const count = selectable.length

      // filter 循环（与 cockpit/picker 同键位语义）：→/Tab 正向，←/Shift+Tab 反向
      const cycleFilter = (dir: 1 | -1): boolean => {
        const filters: TasksFilter[] = ['running', 'completed', 'all']
        const next = (filters.indexOf(nav.tasksFilter) + dir + filters.length) % filters.length
        nav.tasksFilter = filters[next]!
        nav.tasksIndex = 0
        this.overlay.rerender()
        return true
      }
      if (key.name === 'right' || (key.name === 'tab' && !key.shift)) return cycleFilter(1)
      if (key.name === 'left' || (key.name === 'tab' && key.shift)) return cycleFilter(-1)
      if (key.name === 'down' || c === 'j') {
        if (count > 0) {
          nav.tasksIndex = (nav.tasksIndex + 1) % count
          this.overlay.rerender()
        }
        return true
      }
      if (key.name === 'up' || c === 'k') {
        if (count > 0) {
          nav.tasksIndex = (nav.tasksIndex - 1 + count) % count
          this.overlay.rerender()
        }
        return true
      }
      if (key.name === 'return' && count > 0) {
        const workerId = selectable[nav.tasksIndex]
        if (workerId) {
          this.openWorkerDetail(workerId)
        }
        return true
      }
      // f：切入选中 worker 的实时视图（foreground，CC teammate 视图对标）
      if (c === 'f' && count > 0) {
        const workerId = selectable[nav.tasksIndex]
        if (workerId) {
          this.deactivateOverlay()
          this.enterWorkerView(workerId)
        }
        return true
      }
      // x：停止选中的 worker（per-worker AbortController，由 main.ts 接线）
      if (c === 'x' && count > 0) {
        const workerId = selectable[nav.tasksIndex]
        if (workerId && this.workerKill) {
          const killed = this.workerKill(workerId)
          if (killed) {
            this.commitStatic(color(`⊗ 已发送停止信号: ${shortOrderLabel(workerId)}`, this.theme.warning))
            this.overlay.rerender()
          }
        }
        return true
      }
      return false
    }

    if (id === 'jobs') {
      const nav = this.overlayController.nav()
      const data = this.getJobsData()
      const rows = data.rows
      const count = rows.length

      // 按 id 解析选中行：rows 每次重排（running 优先、startedAt 倒序），
      // job 退出换组时 index 会漂到别的 job 上——kill 是破坏性操作，必须对准。
      const resolveSelected = (): { row: (typeof rows)[number] | undefined; index: number } => {
        if (nav.jobsSelectedId) {
          const byId = rows.findIndex(r => r.id === nav.jobsSelectedId)
          if (byId >= 0) { nav.jobsIndex = byId; return { row: rows[byId], index: byId } }
        }
        const index = Math.min(nav.jobsIndex, Math.max(0, count - 1))
        const row = rows[index]
        nav.jobsSelectedId = row?.id
        return { row, index }
      }
      const moveSelection = (delta: number): void => {
        if (count === 0) return
        const { index } = resolveSelected()
        const next = (index + delta + count) % count
        nav.jobsIndex = next
        nav.jobsSelectedId = rows[next]!.id
        this.overlay.rerender()
      }

      if (key.name === 'down' || c === 'j') {
        moveSelection(1)
        return true
      }
      if (key.name === 'up' || c === 'k') {
        moveSelection(-1)
        return true
      }
      if (key.name === 'return' && count > 0) {
        const { row } = resolveSelected()
        if (row) {
          this.openJobDetail(row.id)
        }
        return true
      }
      if (c === 'x' && count > 0) {
        const { row } = resolveSelected()
        if (row && this.jobKill) {
          const ok = this.jobKill(row.id)
          if (ok) {
            this.jobsModel.apply({
              kind: 'exit',
              job: { id: row.id, command: row.command, status: 'killed', startedAt: row.startedAt, endedAt: Date.now(), lastLine: 'stopped by user' }
            })
            this.overlay.rerender()
          }
        }
        return true
      }
      if (c === 'q') {
        this.deactivateOverlay()
        return true
      }
      return false
    }

    if (id === 'pager') {
      const nav = this.overlayController.nav()
      const total = this.pagerTotalPages()
      const mode = nav.pagerMode
      const messages = this.overlayController.getData()?.pagerContent?.().messages ?? []

      // Search mode: character input
      if (mode === 'search') {
        if (key.name === 'escape') {
          nav.pagerMode = 'page'
          nav.pagerSearchQuery = ''
          nav.pagerSearchCurrent = 0
          this.overlay.rerender()
          return true
        }
        if (key.name === 'backspace') {
          this.editOverlayQuery(null)
          this.updatePagerSearch(messages)
          this.overlay.rerender()
          return true
        }
        if (key.name === 'return') {
          // Confirm search and jump to first match
          this.updatePagerSearch(messages)
          this.overlay.rerender()
          return true
        }
        if (key.name === 'down' || c === 'j' || key.name === 'pagedown') {
          const next = findNextMatch(messages, nav.pagerSearchCurrent - 1, nav.pagerSearchQuery)
          nav.pagerSearchCurrent = next + 1
          this.overlay.rerender()
          return true
        }
        if (key.name === 'up' || c === 'k' || key.name === 'pageup') {
          const next = findPrevMatch(messages, nav.pagerSearchCurrent - 1, nav.pagerSearchQuery)
          nav.pagerSearchCurrent = next + 1
          this.overlay.rerender()
          return true
        }
        if (this.isPrintableKey(key)) {
          this.editOverlayQuery(key.char)
          this.updatePagerSearch(messages)
          this.overlay.rerender()
          return true
        }
        return false
      }

      // Message mode: navigate by message
      if (mode === 'message') {
        if (key.name === 'escape') {
          nav.pagerMode = 'page'
          this.overlay.rerender()
          return true
        }
        const count = messages.length
        let idx = nav.pagerSelectedMessage
        if (key.name === 'down' || c === 'j') idx = Math.min(idx + 1, count - 1)
        else if (key.name === 'up' || c === 'k') idx = Math.max(idx - 1, 0)
        else if (key.name === 'home') idx = 0
        else if (key.name === 'end') idx = count - 1
        else return false
        nav.pagerSelectedMessage = idx
        this.overlay.rerender()
        return true
      }

      // Page mode
      if (c === '/') {
        nav.pagerMode = 'search'
        nav.pagerSearchQuery = ''
        nav.pagerSearchCurrent = 0
        this.overlay.rerender()
        return true
      }
      if (c === 'm' && messages.length > 0 && !this.planPreview) {
        nav.pagerMode = 'message'
        // Select the message nearest to the current page start
        const pageSize = Math.max(1, this.rows - 4)
        nav.pagerSelectedMessage = Math.min(nav.pagerPage * pageSize, messages.length - 1)
        this.overlay.rerender()
        return true
      }
      if (c === 'n' && nav.pagerSearchQuery) {
        nav.pagerMode = 'search'
        const next = findNextMatch(messages, nav.pagerSearchCurrent - 1, nav.pagerSearchQuery)
        nav.pagerSearchCurrent = next + 1
        this.overlay.rerender()
        return true
      }
      if (c === 'N' && nav.pagerSearchQuery) {
        nav.pagerMode = 'search'
        const next = findPrevMatch(messages, nav.pagerSearchCurrent - 1, nav.pagerSearchQuery)
        nav.pagerSearchCurrent = next + 1
        this.overlay.rerender()
        return true
      }
      // verbose 层：切换完整工具输出视图（内容源改变 → 回到首页）。
      // 计划预览态无 verbose/message 可切（内容是纯 markdown，provider 的
      // plan 分支排最前，翻了状态也只污染 nav）——吞掉按键防困惑。
      if (c === 'v') {
        if (this.planPreview) return true
        nav.pagerVerbose = !nav.pagerVerbose
        nav.pagerPage = 0
        nav.pagerSelectedMessage = 0
        this.overlay.rerender()
        return true
      }
      const cur = nav.pagerPage
      let next = cur
      if (key.name === 'down' || key.name === 'pagedown' || c === 'j') next = cur + 1
      else if (key.name === 'up' || key.name === 'pageup' || c === 'k') next = cur - 1
      else if (key.name === 'home') next = 0
      else if (key.name === 'end') next = total - 1
      else return false
      next = Math.max(0, Math.min(total - 1, next))
      if (next !== cur) {
        nav.pagerPage = next
        this.overlay.rerender()
      }
      return true
    }

    if (id === 'command-palette') {
      const count = this.overlayController.getData()?.paletteCommands?.().commands.length ?? 0
      const cur = this.overlayController.nav().paletteIndex
      if (key.name === 'down') {
        if (count > 0) { this.overlayController.nav().paletteIndex = (cur + 1) % count; this.overlay.rerender() }
        return true
      }
      if (key.name === 'up') {
        if (count > 0) { this.overlayController.nav().paletteIndex = (cur - 1 + count) % count; this.overlay.rerender() }
        return true
      }
      if (key.name === 'return') {
        if (count > 0 && this.overlayController.getPaletteExec()) {
          const idx = cur
          this.deactivateOverlay()
          this.overlayController.getPaletteExec()?.(idx)
        } else {
          this.deactivateOverlay()
        }
        return true
      }
      if (key.name === 'backspace') { this.editOverlayQuery(null); return true }
      if (this.isPrintableKey(key)) { this.editOverlayQuery(key.char); return true }
      return false
    }

    if (id === 'rewind') {
      const entries = this.overlayController.getData()?.rewindEntries?.().entries ?? []
      const count = entries.length
      const nav = this.overlayController.nav()

      // ── Phase 2: restore-granularity chooser (仅对话 / 仅代码 / 对话+代码) ──
      if (nav.rewindPhase === 'action') {
        // 单一真相：动作表在 format/rewind.ts，键位边界与渲染顺序不会各说各话。
        const ACTION_COUNT = REWIND_ACTIONS.length
        if (key.name === 'down') { nav.rewindActionIndex = Math.min(nav.rewindActionIndex + 1, ACTION_COUNT - 1); this.overlay.rerender(); return true }
        if (key.name === 'up') { nav.rewindActionIndex = Math.max(nav.rewindActionIndex - 1, 0); this.overlay.rerender(); return true }
        if (key.name === 'escape' || key.name === 'left') { nav.rewindPhase = 'list'; this.overlay.rerender(); return true }
        if (key.name === 'return') {
          const entry = entries[nav.rewindIndex]
          const mode = REWIND_ACTIONS[nav.rewindActionIndex]?.mode ?? 'convo'
          this.deactivateOverlay()
          if (entry) {
            const exec = this.overlayController.getRewindExec()
            if (exec) exec(entry.messageIndex, mode)
            else this.setInput(entry.content)
          }
          return true
        }
        return false
      }

      // ── Phase 1: message list ──
      const cur = nav.rewindIndex
      if (key.name === 'down') {
        if (count > 0) { nav.rewindIndex = Math.min(cur + 1, count - 1); this.overlay.rerender() }
        return true
      }
      if (key.name === 'up') {
        if (count > 0) { nav.rewindIndex = Math.max(cur - 1, 0); this.overlay.rerender() }
        return true
      }
      if (key.name === 'return') {
        if (count > 0) {
          nav.rewindPhase = 'action'
          nav.rewindActionIndex = 0
          this.overlay.rerender()
        } else {
          this.deactivateOverlay()
        }
        return true
      }
      return false
    }

    if (id === 'side-question') {
      const maxScroll = Math.max(
        0,
        sideQuestionBodyLines(this.sideQuestion ?? { question: '', answer: '', pending: false }, this.columns)
          - Math.max(3, this.rows - 4),
      )
      if (key.name === 'down') { this.sideQuestionScroll = Math.min(this.sideQuestionScroll + 1, maxScroll); this.overlay.rerender(); return true }
      if (key.name === 'up') { this.sideQuestionScroll = Math.max(this.sideQuestionScroll - 1, 0); this.overlay.rerender(); return true }
      // 关闭走通用的 q/Esc 路径；状态清理挂在 onDeactivate 上（见注册处）。
      return false
    }

    if (id === 'history-search') {
      const count = this.overlayController.getData()?.historySearchData?.().entries.length ?? 0
      const cur = this.overlayController.nav().historySearchIndex
      if (key.name === 'down') {
        if (count > 0) { this.overlayController.nav().historySearchIndex = Math.min(cur + 1, count - 1); this.overlay.rerender() }
        return true
      }
      if (key.name === 'up') {
        if (count > 0) { this.overlayController.nav().historySearchIndex = Math.max(cur - 1, 0); this.overlay.rerender() }
        return true
      }
      if (key.name === 'return') {
        if (count > 0) {
          const entry = this.overlayController.getData()?.historySearchData?.().entries[cur]
          this.deactivateOverlay()
          if (entry) this.setInput(entry)
        } else {
          this.deactivateOverlay()
        }
        return true
      }
      if (key.name === 'backspace') { this.editOverlayQuery(null); return true }
      if (this.isPrintableKey(key)) { this.editOverlayQuery(key.char); return true }
      return false
    }

    if (id === 'chronicle') {
      const count = this.overlayController.getData()?.chronicleEntries?.().entries.length ?? 0
      const cur = this.overlayController.nav().chronicleIndex
      if (key.name === 'down') {
        if (count > 0) { this.overlayController.nav().chronicleIndex = Math.min(cur + 1, count - 1); this.overlay.rerender() }
        return true
      }
      if (key.name === 'up') {
        if (count > 0) { this.overlayController.nav().chronicleIndex = Math.max(cur - 1, 0); this.overlay.rerender() }
        return true
      }
      if (key.name === 'return') {
        const entry = count > 0 ? this.overlayController.getData()?.chronicleEntries?.().entries[cur] : undefined
        this.deactivateOverlay()
        if (entry?.id && this.overlayController.getChronicleExec()) this.overlayController.getChronicleExec()?.(entry.id)
        return true
      }
      return false
    }

    if (id === 'domain-picker') {
      const count = this.overlayController.getData()?.domainPickerData?.().entries.length ?? 0
      const cur = this.overlayController.nav().domainPickerIndex
      // g：进入当前域的创世碑文视图（auto 无碑文，忽略）。
      if (c === 'g') {
        const entry = count > 0 ? this.overlayController.getData()?.domainPickerData?.().entries[cur] : undefined
        if (entry && STAR_GENESIS.some(g => g.key === entry.key)) {
          this.domainGenesisMode = true
          this.domainGenesisScroll = 0
          this.overlay.rerender()
        }
        return true
      }
      if (key.name === 'down') {
        if (count > 0) { this.overlayController.nav().domainPickerIndex = (cur + 1) % count; this.overlay.rerender() }
        return true
      }
      if (key.name === 'up') {
        if (count > 0) { this.overlayController.nav().domainPickerIndex = (cur - 1 + count) % count; this.overlay.rerender() }
        return true
      }
      if (key.name === 'return') {
        const entry = count > 0 ? this.overlayController.getData()?.domainPickerData?.().entries[cur] : undefined
        if (entry && this.overlayController.getDomainPickerExec()) this.overlayController.getDomainPickerExec()?.(entry.key)
        this.deactivateOverlay()
        return true
      }
      if (c === 's') {
        const entry = count > 0 ? this.overlayController.getData()?.domainPickerData?.().entries[cur] : undefined
        if (entry && this.overlayController.getDomainPickerSaveDefaultExec()) {
          this.overlayController.getDomainPickerSaveDefaultExec()?.(entry.key)
        }
        this.deactivateOverlay()
        return true
      }
      return false
    }

    if (id === 'plan-picker') {
      const count = this.overlayController.getData()?.planPickerData?.().entries.length ?? 0
      const cur = this.overlayController.nav().planPickerIndex
      if (key.name === 'down') {
        if (count > 0) { this.overlayController.nav().planPickerIndex = (cur + 1) % count; this.overlay.rerender() }
        return true
      }
      if (key.name === 'up') {
        if (count > 0) { this.overlayController.nav().planPickerIndex = (cur - 1 + count) % count; this.overlay.rerender() }
        return true
      }
      // v 暂离到全屏 pager 看选中计划全文（Enter 直接批准看不了正文），
      // q/Esc 返回 picker。
      if (c === 'v' && count > 0) {
        const entry = this.overlayController.getData()?.planPickerData?.().entries[cur]
        if (entry) { this.openPlanPreview(entry.slug, 'plan-picker'); return true }
        return true
      }
      if (key.name === 'return') {
        const entry = count > 0 ? this.overlayController.getData()?.planPickerData?.().entries[cur] : undefined
        // Close the overlay BEFORE kickoff — approve submits a run that re-renders.
        this.deactivateOverlay()
        if (entry && this.overlayController.getPlanPickerExec()) this.overlayController.getPlanPickerExec()?.(entry.slug)
        return true
      }
      return false
    }

    if (id === 'model-picker') {
      const data = this.overlayController.getData()?.modelPickerData?.()
      const count = data?.entries.length ?? 0
      const cur = this.overlayController.nav().modelPickerIndex
      if (key.name === 'down') {
        if (count > 0) { this.overlayController.nav().modelPickerIndex = (cur + 1) % count; this.overlay.rerender() }
        return true
      }
      if (key.name === 'up') {
        if (count > 0) { this.overlayController.nav().modelPickerIndex = (cur - 1 + count) % count; this.overlay.rerender() }
        return true
      }
      // </> effort 步进（CC 对标）：循环切换档位 draft；选中模型不支持时不响应
      // （渲染层 supported 判定按当前选中条目——翻到不支持模型后 effort 行自然灰化）。
      if ((c === '<' || c === '>') && data?.effort?.supported !== false) {
        this.modelPickerEffortDraft = stepModelPickerEffort(this.modelPickerEffortDraft ?? 'auto', c)
        this.overlay.rerender()
        return true
      }
      // 提交语义（CC 对标）：Enter=设为默认（持久化）、s=仅本会话。
      // effort 只在有显式改动（draft ≠ 打开时初值）时随提交传递。
      const effortChange = this.modelPickerEffortDraft !== undefined
        && this.modelPickerEffortDraft !== this.modelPickerEffortInitial
        ? this.modelPickerEffortDraft
        : undefined
      if (key.name === 'return') {
        const entry = count > 0 ? data?.entries[cur] : undefined
        if (entry && this.overlayController.getModelPickerSaveDefaultExec()) {
          this.overlayController.getModelPickerSaveDefaultExec()?.(entry.provider, entry.id, effortChange)
        }
        this.deactivateOverlay()
        return true
      }
      if (c === 's') {
        const entry = count > 0 ? data?.entries[cur] : undefined
        if (entry && this.overlayController.getModelPickerExec()) {
          this.overlayController.getModelPickerExec()?.(entry.provider, entry.id, effortChange)
        }
        this.deactivateOverlay()
        return true
      }
      return false
    }

    if (id === 'theme-picker') {
      const count = this.overlayController.getData()?.themePickerData?.().entries.length ?? 0
      const cur = this.overlayController.nav().themePickerIndex
      if (key.name === 'down') {
        if (count > 0) { this.overlayController.nav().themePickerIndex = (cur + 1) % count; this.overlay.rerender() }
        return true
      }
      if (key.name === 'up') {
        if (count > 0) { this.overlayController.nav().themePickerIndex = (cur - 1 + count) % count; this.overlay.rerender() }
        return true
      }
      if (key.name === 'return') {
        const entry = count > 0 ? this.overlayController.getData()?.themePickerData?.().entries[cur] : undefined
        if (entry && this.overlayController.getThemePickerExec()) this.overlayController.getThemePickerExec()?.(entry.name)
        this.deactivateOverlay()
        return true
      }
      if (c === 's') {
        const entry = count > 0 ? this.overlayController.getData()?.themePickerData?.().entries[cur] : undefined
        if (entry && this.overlayController.getThemePickerSaveDefaultExec()) {
          this.overlayController.getThemePickerSaveDefaultExec()?.(entry.name)
        }
        this.deactivateOverlay()
        return true
      }
      return false
    }

    if (id === 'choice-panel') {
      const choices = this.overlayController.getData()?.choicePanelData?.().choices ?? []
      const cur = this.overlayController.nav().choicePanelIndex

      // 输入子模式：在 overlay 内直接输入文字（反馈 / 自定义回答）。
      // 与 connect overlay 同套光标编辑语义：左右/Home/End 移动、退格删光标前、
      // Del 删光标处、Ctrl+U 清空、可打印字符插光标处；粘贴走 onPaste 路由分支。
      if (this.choicePanelSubMode === 'input') {
        // 光标位兜底钳制：buffer 在多处被整体重置（重进子模式/提交清空），cursor 不逐点同步
        const clampCursor = (): number => {
          this.choicePanelInputCursor = Math.min(Math.max(this.choicePanelInputCursor, 0), this.choicePanelInputBuffer.length)
          return this.choicePanelInputCursor
        }
        if (key.name === 'escape') {
          this.choicePanelSubMode = 'select'
          this.choicePanelInputBuffer = ''
          this.choicePanelInputCursor = 0
          this.choicePanelInputFor = undefined
          this.overlay.rerender()
          return true
        }
        if (key.name === 'return') {
          const targetId = this.choicePanelInputFor === 'plan-reject-comment' ? '__reject_comment__' : '__other__'
          if (this.choicePanelKind === 'ask-user-question') {
            const done = this.resolveAskChoice(targetId)
            this.choicePanelSubMode = 'select'
            this.choicePanelInputBuffer = ''
            this.choicePanelInputCursor = 0
            this.choicePanelInputFor = undefined
            if (done) this.deactivateOverlay()
            else this.overlay.rerender()
            return true
          }
          const exec = this.overlayController.getChoicePanelExec()
          if (exec) exec(targetId)
          this.choicePanelSubMode = 'select'
          this.choicePanelInputBuffer = ''
          this.choicePanelInputCursor = 0
          this.choicePanelInputFor = undefined
          this.choicePanelKind = 'effort'
          this.pendingPlanApproval = undefined
          this.pendingAskUserQuestion = undefined
          this.deactivateOverlay()
          return true
        }
        if (key.name === 'left') {
          this.choicePanelInputCursor = Math.max(0, clampCursor() - 1)
          this.overlay.rerender()
          return true
        }
        if (key.name === 'right') {
          this.choicePanelInputCursor = Math.min(this.choicePanelInputBuffer.length, clampCursor() + 1)
          this.overlay.rerender()
          return true
        }
        if (key.name === 'home' || (key.ctrl && c === 'a')) {
          this.choicePanelInputCursor = 0
          this.overlay.rerender()
          return true
        }
        if (key.name === 'end' || (key.ctrl && c === 'e')) {
          this.choicePanelInputCursor = this.choicePanelInputBuffer.length
          this.overlay.rerender()
          return true
        }
        if (key.name === 'delete') {
          const cur = clampCursor()
          if (cur < this.choicePanelInputBuffer.length) {
            this.choicePanelInputBuffer = this.choicePanelInputBuffer.slice(0, cur) + this.choicePanelInputBuffer.slice(cur + 1)
            this.overlay.rerender()
          }
          return true
        }
        if (key.name === 'backspace' || key.name === 'ctrl_h') {
          const cur = clampCursor()
          if (cur > 0) {
            this.choicePanelInputBuffer = this.choicePanelInputBuffer.slice(0, cur - 1) + this.choicePanelInputBuffer.slice(cur)
            this.choicePanelInputCursor = cur - 1
            this.overlay.rerender()
          }
          return true
        }
        if (key.ctrl && c === 'u') {
          this.choicePanelInputBuffer = ''
          this.choicePanelInputCursor = 0
          this.overlay.rerender()
          return true
        }
        if (this.isPrintableKey(key)) {
          const cur = clampCursor()
          this.choicePanelInputBuffer = this.choicePanelInputBuffer.slice(0, cur) + key.char + this.choicePanelInputBuffer.slice(cur)
          this.choicePanelInputCursor = cur + key.char.length
          this.overlay.rerender()
          return true
        }
        return true
      }

      // ── ask-user-question Tab 化面板专用键路由 ──
      // 通用分支依赖 choicePanelData().choices；ask 面板的数据走 buildAskPanelData，
      // choices 为空，所以 ask 的按键必须在这里全量消费（Esc 除外，落全局关闭）。
      if (this.choicePanelKind === 'ask-user-question' && this.pendingAskFlow) {
        const flow = this.pendingAskFlow
        const nav = this.overlayController.nav()
        const onSubmitTab = flow.index >= flow.questions.length

        // ←/→ 切 Tab（题页与提交页之间自由往返）
        if (key.name === 'left' || key.name === 'right') {
          const delta = key.name === 'left' ? -1 : 1
          flow.index = Math.min(flow.questions.length, Math.max(0, flow.index + delta))
          nav.choicePanelIndex = 0
          this.overlay.rerender()
          return true
        }

        // 提交页：↑↓ 选「提交回答/取消」，Enter 执行
        if (onSubmitTab) {
          if (key.name === 'down' || key.name === 'up') {
            nav.choicePanelIndex = key.name === 'down' ? 1 : 0
            this.overlay.rerender()
            return true
          }
          if (key.name === 'return') {
            if (nav.choicePanelIndex === 0) this.submitAskAnswers()
            this.deactivateOverlay()
            return true
          }
          return false
        }

        // 题页：0..N-1 选项行，N Other 输入行，N+1 讨论行
        const q = flow.questions[flow.index]!
        const draft = flow.drafts[flow.index]!
        const rowCount = q.options.length + 2
        const otherIdx = q.options.length
        const chatIdx = q.options.length + 1
        const enterOtherInput = (): void => {
          this.enterChoicePanelInput('ask-other')
        }

        if (key.name === 'down') {
          nav.choicePanelIndex = (nav.choicePanelIndex + 1) % rowCount
          this.overlay.rerender()
          return true
        }
        if (key.name === 'up') {
          nav.choicePanelIndex = (nav.choicePanelIndex - 1 + rowCount) % rowCount
          this.overlay.rerender()
          return true
        }
        // 数字键：1..N 选项（多选=切换 / 单选=选定推进），N+1 自定义输入，N+2 讨论
        if (/^[1-9]$/.test(c)) {
          const idx = Number(c) - 1
          if (idx >= rowCount) return true
          nav.choicePanelIndex = idx
          if (idx < q.options.length) {
            if (q.allowMultiple) {
              const has = draft.selected.includes(idx)
              draft.selected = has ? draft.selected.filter(i => i !== idx) : [...draft.selected, idx]
              draft.skipped = false
              this.overlay.rerender()
            } else {
              flow.drafts[flow.index] = { selected: [idx], otherSelected: false, otherText: '', skipped: false }
              this.advanceAskFlow()
            }
            return true
          }
          if (idx === otherIdx) { enterOtherInput(); return true }
          this.deactivateOverlay() // chat 行
          return true
        }
        // 空格：多选题切换当前行勾选；Other 行进入输入子模式
        if (c === ' ') {
          const cur = nav.choicePanelIndex
          if (q.allowMultiple && cur < q.options.length) {
            const has = draft.selected.includes(cur)
            draft.selected = has ? draft.selected.filter(i => i !== cur) : [...draft.selected, cur]
            draft.skipped = false
            this.overlay.rerender()
            return true
          }
          if (cur === otherIdx) enterOtherInput()
          return true
        }
        if (key.name === 'return') {
          const cur = nav.choicePanelIndex
          if (cur < q.options.length) {
            if (q.allowMultiple) {
              this.confirmAskMultiSelect()
            } else {
              flow.drafts[flow.index] = { selected: [cur], otherSelected: false, otherText: '', skipped: false }
              this.advanceAskFlow()
            }
            return true
          }
          if (cur === otherIdx) { enterOtherInput(); return true }
          // 讨论行：关闭面板，问题留给输入框（Esc 同语义）
          this.deactivateOverlay()
          return true
        }
        // Esc 等落到全局（关闭面板，不提交）
        return false
      }

      if (key.name === 'down') {
        if (choices.length > 0) { this.overlayController.nav().choicePanelIndex = (cur + 1) % choices.length; this.overlay.rerender() }
        return true
      }
      if (key.name === 'up') {
        if (choices.length > 0) { this.overlayController.nav().choicePanelIndex = (cur - 1 + choices.length) % choices.length; this.overlay.rerender() }
        return true
      }
      // 计划审批卡：v 暂离到全屏 pager 看计划全文（q/Esc 返回审批卡，
      // 倒计时状态不丢）。仅 select 子模式——驳回反馈输入中 v 是普通字符。
      if (c === 'v' && this.choicePanelKind === 'plan-approval' && this.choicePanelSubMode === 'select' && this.pendingPlanApproval) {
        this.openPlanPreview(this.pendingPlanApproval.slug, 'approval')
        return true
      }
      // 数字键快选（1-9 → 第 N 个条目）：桥接老用户「输数字」的肌肉记忆，
      // 也是面板打开成功的可发现性信号。多选题的可切换项等价空格切换，
      // 其余（单选 / __skip__ / __other__ / 审批类面板）等价回车确认。
      if (/^[1-9]$/.test(c) && choices.length > 0) {
        const idx = Number(c) - 1
        if (idx >= choices.length) return true
        this.overlayController.nav().choicePanelIndex = idx
        const q = this.choicePanelKind === 'ask-user-question' ? this.pendingAskUserQuestion : undefined
        const entry = choices[idx]
        const toggleable = q?.allowMultiple && entry && entry.id !== '__skip__' && entry.id !== '__other__'
        return toggleable
          ? this.handleOverlayKey({ name: 'space', char: ' ' })
          : this.handleOverlayKey({ name: 'return', char: '\r' })
      }
      // Multi-select toggle (space) for ask-user-question
      if (c === ' ' && this.choicePanelKind === 'ask-user-question') {
        const entry = choices[cur]
        const q = this.pendingAskUserQuestion
        if (entry && q?.allowMultiple && entry.id !== '__skip__' && entry.id !== '__other__') {
          this.resolveAskChoice(entry.id) // toggle, stays open
          return true
        }
        if (entry && q?.allowMultiple && entry.id === '__other__') {
          this.enterChoicePanelInput('ask-other')
          return true
        }
      }
      if (key.name === 'return') {
        const entry = choices[cur]
        const inputEntryIds = new Set(['__other__', '__reject_comment__'])
        if (entry && inputEntryIds.has(entry.id)) {
          // 进入输入子模式，不关闭 overlay。
          if (entry.id === '__reject_comment__') {
            // 用户正在撰写驳回反馈 = 参与——绝不能在打字中途触发自动批准
            this.cancelPlanAutoApprove()
          }
          this.enterChoicePanelInput(entry.id === '__reject_comment__' ? 'plan-reject-comment' : 'ask-other')
          return true
        }
        if (entry && this.overlayController.getChoicePanelExec()) this.overlayController.getChoicePanelExec()?.(entry.id)
        this.deactivateOverlay()
        return true
      }
      return false
    }

    return false
  }

  /** 当前搜索型 overlay 的实时查询串（command-palette / history-search）。
   *  直接返回 overlayNav.query（不按 active overlay 门控）：activateOverlay 每次都把
   *  query 复位为 ''，非搜索 overlay 因此读到空串；而 paletteExec 在 deactivateOverlay
   *  之后、下次 activate 之前执行，此时 query 仍是用户输入值 → 过滤索引与 display 一致。 */
  getOverlayQuery(): string {
    return this.overlayController.getQuery()
  }

  /** 判断按键是否为可打印字符（用于搜索型 overlay 的字符输入）。
   *  ] 不视为可打印——它被全局快捷键映射为侧栏 toggle，在搜索中不应被吃掉。 */
  private isPrintableKey(key: { name: string; char: string; ctrl?: boolean; meta?: boolean }): boolean {
    if (key.ctrl || key.meta) return false
    const ch = key.char
    if (!ch || ch.length !== 1) return false
    const code = ch.charCodeAt(0)
    return code >= 0x20 && code !== 0x7f && code !== 0x5d // exclude DEL and ]
  }

  /** 编辑搜索型 overlay 的 query：传字符追加，传 null 退格删一字符。每次编辑复位选中索引。 */
  private editOverlayQuery(ch: string | null): void {
    this.overlayController.editQuery(ch)
    this.overlay.rerender()
  }

  /** 同步 pager 搜索 query 与匹配状态。 */
  private updatePagerSearch(messages: readonly import('../scrollback-transcript.js').TranscriptMessage[]): void {
    const nav = this.overlayController.nav()
    const query = this.overlayController.getQuery()
    nav.pagerSearchQuery = query
    const matches = searchTranscript(messages, query)
    nav.pagerSearchCurrent = matches.length > 0 ? matches[0]! + 1 : 0
  }

  /** pager 总页数（与 renderPager 同口径：pageSize = rows - 4）。 */
  private pagerTotalPages(): number {
    const content = this.overlayController.getData()?.pagerContent?.().content ?? ''
    const lines = content.split('\n').length
    const pageSize = Math.max(1, this.rows - 4)
    return Math.max(1, Math.ceil(lines / pageSize))
  }

  /** 获取终端尺寸 */
  getSize(): { cols: number; rows: number } {
    return { cols: this.columns, rows: this.rows }
  }

  /** 还原我们打开过的终端模式：备用屏、bracketed paste、硬件光标。
   *
   *  幂等且同步，可从 `process.on('exit')` 兜底钩子调用 —— 未捕获的同步异常会
   *  跳过整条 shutdown/dispose 链，届时用户会被留在隐藏光标 + bracketed paste
   *  未关的终端里（overlay 开着还会卡在备用屏），只能 `tput reset` 救回。
   *  典型症状是粘贴时出现字面的 `^[[200~`。 */
  restoreTerminalSync(): void {
    if (this.terminalRestored) return
    this.terminalRestored = true
    try {
      // 备用屏只在确实处于激活态时才退出：无条件发 ?1049l 会让部分终端跳到
      // 一个陈旧的保存光标位置。
      if (this.overlay.isActive()) this.stdout.write(ANSI.ALT_SCREEN_OFF)
      this.stdout.write('\x1B[?2004l')
      // 弹出 Kitty keyboard protocol（与 start() 的 DISAMBIGUATE_ON 成对），
      // 避免把增强键盘状态遗留给 shell/后续程序。
      this.stdout.write(ANSI.KITTY_KEYBOARD_OFF)
      this.stdout.write(ANSI.SHOW_CURSOR)
    } catch { /* 还原失败不得吞掉原始崩溃栈 */ }
  }

  /** 销毁资源 */
  dispose(): void {
    this.cancelPlanAutoApprove()
    if (this.streamRenderController.ticker) {
      clearInterval(this.streamRenderController.ticker)
      this.streamRenderController.ticker = null
    }
    if (this.cprProbeTimer) {
      clearInterval(this.cprProbeTimer)
      this.cprProbeTimer = null
    }
    if (this.fleetReconcileTimer) {
      clearInterval(this.fleetReconcileTimer)
      this.fleetReconcileTimer = null
    }
    // 先拆 stderr 护栏：dispose 期间的诊断直写真实 stderr（TUI 已退场，不再破坏布局）。
    this.outputGuard?.dispose()
    this.outputGuard = null
    this.restoreTerminalSync()
    this.input.dispose()
    this.resize.dispose()
    if (!this.perfSummaryFlushed) {
      this.perfSummaryFlushed = true
      const summary = this.perfMonitor?.summary()
      if (summary) this.onPerfSummary?.(summary)
      this.perfMonitor?.stop()
    }
  }

  /**
   * 开关读屏档。启用后动态段不再渲染、ticker 不再启动；调用方还应打开
   * reducedMotion，并把事件流的播报接到 commitStatic（见 main.ts 的接线）。
   */
  setScreenReader(enabled: boolean): void {
    if (this.screenReader === enabled) return
    this.screenReader = enabled
    // 立刻收敛：开启时要把已经画在屏上的动态段擦掉，关闭时要让 ticker 重新起转。
    this.updateTicker()
    this.forceRedraw()
  }

  /** 当前是否处于读屏档。 */
  isScreenReader(): boolean {
    return this.screenReader
  }

  /** 将静态文本提交到 scrollback（slash command 输出等） */
  commitStatic(text: string, opts?: { isError?: boolean }): void {
    // isError：错误类系统消息以 ✗ + error 色高亮，避免与普通输出混为一谈。
    const out = opts?.isError
      ? text.split('\n').map((l, i) => color(i === 0 ? `✗ ${l}` : l, this.theme.error)).join('\n')
      : text
    this.commitAbove(() => {
      this.commit.write({ text: out, trailingNewline: true })
    })
  }

  /**
   * Force a clean full redraw — physically erase the live region then repaint.
   * Use after any state change that alters GlanceBar layout (theme color codes,
   * domain name, model name) to prevent ghost rendering from stale lineCache.
   */
  forceRedraw(): void {
    // 主题/域/模型变更会改变颜色码，记忆化的 thinking 行需失效以用新主题重算。
    this.thinkingLinesMemo = null
    // 不走 live.clear() + append 路径——clear 置 lastDisplayRows=0 后 renderLive
    // 走 append 模式不擦除（live-engine.ts:136），若 clear 的 erase 因
    // lastDisplayRows 不准（域/主题/模型切换导致 wrap 行数变化）覆盖不全，
    // 旧帧残留在屏上 → 输入框重影（❯ 提示符/边框重复渲染）。
    // 改为直接 renderLive：lineCache 内容变了（颜色/domain），render 的 diff 资格
    // 检测到行不匹配 → 走 buildFullRewrite（moveToTop+ERASE_SCREEN_END+重写），
    // 用真实的 prevDisplayRows 原子覆盖旧帧。
    //
    // picker Enter 路径的 exec→deactivate 顺序（bb6a9329）独立保证 picker 场景：
    // forceRedraw 画在 alt-screen 上，随后 deactivateOverlay 退出 alt-screen
    // 丢弃整个 alt buffer 并重画，所以 forceRedraw 在 picker 路径里走哪条分支
    // 都不影响最终结果——这里的安全性不依赖 clear()。
    this.renderLive()
  }

  /**
   * Submit text directly to the agent — resolves the ecosystem workflow path
   * where SlashRouter already has a resolved prompt from resolveAppPromptInput.
   * Commits the user prompt to scrollback and fires onSubmitCallback.
   */
  submitText(text: string, images?: string[]): void {
    // 入口先规范化图片数组，气泡/渲染/回调看到的是同一份。
    images = normalizeSubmitImages(images)
    // 带图提交是异步原子单元（转码完成后「气泡+图片」一起落 scrollback），
    // agent 必须等它落地后再启动，保证图片先于 assistant 输出。
    const pending = this.commitUserPrompt(text, images)
    const start = () => {
      this.blockWriter.discard()
      this.streamRenderer.reset()
      this.streamRenderController.assistantHeaderDone = false
      this.agentBusy = true
      this.todosWrittenThisRun = false
      this.state.turnStartMs = Date.now()
      this.streamRenderController.lastActivityMs = Date.now()
      this.onSubmitCallback?.(text, images)
    }
    // fire-and-forget 链上任何异常（prepare 漏网 / start 回调抛错）都静默，
    // 绝不让 void 路径产生 unhandled rejection。
    if (pending) {
      void pending.then((written) => {
        // 显示失败（written=false）不阻塞 agent：内容已交给 agent，只留一条
        // muted 警告告知用户气泡没写出来。
        if (!written) {
          try {
            this.commitStatic(color('⚠ 用户消息显示失败，但内容已发送给 agent', this.theme.muted))
          } catch {
            // stdout may remain unavailable; display failure must not prevent delivery.
          }
        }
        start()
      }).catch(() => {})
    } else start()
  }

  /**
   * Mid-stream commit 协议：先擦除 live region（光标停在其起始行），
   * 写入 scrollback 内容，再重绘 live region。
   * 不走该协议的裸 commit 会留下 ghost 行 / 覆盖已提交文本。
   *
   * 所有主屏 commit 统一经 enqueueMainCommit 定序：队列空闲时同步直写；
   * 前方有异步条目（带图 prepare）或 overlay 激活时严格 FIFO 排队。
   * overlay（alt screen）激活期间主屏写入一个字节都不写：clearForCommit 的
   * cursorUp+擦除与正文会落进 alt screen 擦花/顶滚动面板，而 OverlayEngine
   * 的行级 diff 缓存（lastFrame）对此无感知——计划审批卡「按一下方向键才
   * 出来一行」的根因。排队条目在 overlay 退出时由 pump 回放。
   */
  private commitAbove(write: () => void): void {
    this.enqueueMainCommit(write)
  }

  /** 主屏 commit 队列条目：ready 为同步写闭包，或 prepare 完成后兑现写闭包的 Promise。 */
  private mainCommitQueue: Array<{
    ready: (() => void) | Promise<() => void>
    /** 写完成后 resolve true；prepare 拒绝/写入抛错被跳过时 resolve false。 */
    done: (written: boolean) => void
  }> = []

  /** 单实例 pump 互斥锁（非 null = 有 pump 在跑或刚同步排空待 settle）。 */
  private mainCommitPump: Promise<void> | null = null

  /** pump 同步段执行标志：堵住 mainCommitPump 赋值前的再入窗口。 */
  private mainCommitPumping = false

  /**
   * 冻结/解冻输出。冻结瞬间先经 fast path 同步写一行 ⏸ 标记进 scrollback
   * （此时 outputFrozen 仍为 false），随后置位——此后到解冻为止 stdout 零
   * 写入；解冻时按序补放队列并重绘 live。
   */
  private setOutputFrozen(frozen: boolean): void {
    if (this.outputFrozen === frozen) return
    if (frozen) {
      this.enqueueMainCommit(() => {
        this.stdout.write(color('⏸ 输出已冻结（Ctrl+S 恢复）——期间的新内容会在解冻后补上\n', this.theme.warning))
      })
      this.outputFrozen = true
      this.live.suppressProbe()
      this.updateTicker()
      return
    }
    this.outputFrozen = false
    this.live.resumeProbe()
    this.updateTicker()
    this.requestPump()
    this.writeBatcher.flushNow()
    this.renderLive()
  }

  /**
   * 唯一有序 main commit 队列入口。位置在调用时一次性分配。
   *
   * 同步 fast path 契约：「队列空闲 + 无 pump 在跑 + overlay 未激活 + ready 是同步闭包」
   * 四条件同时满足才走同步 fast path——立即 atomicCommitNow 并返回 null
   * （保持 commitStatic/commitAbove 既有同步契约）。否则入队、requestPump，
   * 返回 job 完成时 resolve 的 Promise<boolean>：true=已写出，false=prepare
   * 拒绝或写入抛错被跳过（resolve 而非 reject，不给调用方制造 unhandled
   * rejection）。前方存在 async barrier（带图 prepare）时后续条目严格
   * FIFO 延后，哪怕它本身是同步闭包也绝不越过。
   */
  private enqueueMainCommit(ready: (() => void) | Promise<() => void>): Promise<boolean> | null {
    if (
      typeof ready === 'function'
      && this.mainCommitQueue.length === 0
      && this.mainCommitPump === null
      && !this.mainCommitPumping
      && !this.overlay.isActive()
      && !this.outputFrozen
    ) {
      try {
        this.atomicCommitNow(ready)
        return null
      } catch {
        return Promise.resolve(false)
      }
    }
    let done!: (written: boolean) => void
    const finished = new Promise<boolean>(resolve => { done = resolve })
    this.mainCommitQueue.push({ ready, done })
    this.requestPump()
    return finished
  }

  /**
   * 纯同步原子提交窗口：cork → clearForCommit → write → flushNow → uncork。
   * 函数内严禁任何 await——擦除与写入之间插入异步会把原子窗口掏空。
   */
  private atomicCommitNow(write: () => void): void {
    // H3：clearForCommit + commit + renderLive 三段写入用 cork/uncork 合并为一次 flush，
    // 减少 syscall 与中间态可见（提交时的瞬时闪烁）。协议顺序不变。
    const s = this.stdout as WriteStream & { cork?: () => void; uncork?: () => void }
    const canCork = typeof s.cork === 'function' && typeof s.uncork === 'function'
    if (canCork) s.cork()
    try {
      this.live.clearForCommit()
      write()
      if (!this.suppressCommitRender) this.writeBatcher.flushNow()
    } finally {
      if (canCork) s.uncork!()
    }
  }

  /** 启动单实例 pump；pump 在跑 / 队列空 / overlay 激活时直接返回。 */
  private requestPump(): void {
    if (this.mainCommitPumping || this.mainCommitQueue.length === 0 || this.overlay.isActive()) return
    this.mainCommitPumping = true
    const pump = this.drainMainCommits()
    this.mainCommitPump = pump
    const settle = () => {
      this.mainCommitPumping = false
      if (this.mainCommitPump === pump) this.mainCommitPump = null
      // 竞态收口：pump 同步排空后、本 settle 前入队的条目在这里续跑；
      // drain 逐条目 try/catch 自身不抛，rejection 分支仅作兜底。
      this.requestPump()
    }
    void pump.then(settle, settle)
  }

  /**
   * pump 循环：取队首（先不 shift）→ ready 是 Promise 则先 await（此时绝未
   * 触碰 live 区）→ await 后重新检查 overlay，激活则保留队首退出（overlay
   * 退出路径的 requestPump 续跑）→ 未激活才 shift 并 atomicCommitNow。
   * 每个条目独立 try/catch：单条目异常只跳过该条目，不丢剩余队列。
   */
  private async drainMainCommits(): Promise<void> {
    while (this.mainCommitQueue.length > 0) {
      const job = this.mainCommitQueue[0]!
      let write: () => void
      try {
        write = typeof job.ready === 'function' ? job.ready : await job.ready
      } catch {
        // prepare 失败：跳过该条目继续（commitUserPrompt 内部已把 prepare
        // 失败降级为纯气泡闭包，正常不会走到这）。以 false 告知调用方未写出。
        this.mainCommitQueue.shift()
        job.done(false)
        continue
      }
      // await 期间 overlay 可能（重）激活——主屏内容绝不可写进 alt screen。
      // 输出冻结期同理：主屏写入排队，解冻后由 requestPump 续排。
      if (this.overlay.isActive() || this.outputFrozen) return
      this.mainCommitQueue.shift()
      let written = true
      try {
        this.atomicCommitNow(write)
      } catch {
        // 单条目写异常不丢剩余队列；以 false 告知调用方写入失败被跳过。
        written = false
      }
      job.done(written)
    }
  }

  /**
   * 统一用户消息提交入口。在 scrollback 中写入 ▍ You 气泡。
   * 所有 submit 路径（idle / slash passthrough / steer）共用此入口，
   * 确保用户始终能在终端历史中看到自己输入的内容。
   *
   * 返回值语义：直接透传 enqueueMainCommit 的返回值——
   * 仅当四条件同步 fast path 真正同步执行时返回 null；其余一律返回
   * 完成 Promise<boolean>（true=气泡已写出，false=写入失败被跳过）。
   * 调用方需要「气泡已落地」保证时必须 await 返回值；返回 null 时
   * 写入已在返回前同步完成。任何「前方无 barrier 即已同步写出」的
   * 调用方推断都是错的（overlay 激活时同样入队返回 Promise）。
   * 有图且终端支持图形协议：ready 为立即启动的 prepare 任务，转码完成后
   * 兑现「气泡 + 图片」写闭包；队列位置在调用当刻预订，prepare 再慢、
   * overlay 中途激活，物理回放顺序都不倒。
   * 注意 await 语义的边界：await 返回的 Promise 保证「图片位于
   * 所属用户气泡下方、先于 assistant 输出」；该 Promise resolve 的值
   * 表示写入是否成功。
   */
  private commitUserPrompt(content: string, images?: string[]): Promise<boolean> | null {
    const protocol = imageProtocol()
    const withImages = images && images.length > 0 && protocol !== 'none'
    if (!withImages) {
      return this.enqueueMainCommit(() => this.writeUserBubbleLines(content, images))
    }
    const ready = (async (): Promise<() => void> => {
      // 渲染失败的任何异常都静默降级为纯文本气泡——绝不让 fire-and-forget
      // 路径产生 unhandled rejection。
      let prepared: PreparedTermImage[] = []
      try {
        for (const dataUrl of images.slice(0, MAX_IMAGES)) {
          const img = await prepareTermImageForCommit(dataUrl, protocol as 'kitty' | 'iterm2')
          if (img) prepared.push(img)
        }
      } catch {
        prepared = []
      }
      return () => {
        this.writeUserBubbleLines(content, images)
        if (prepared.length > 0) {
          // 宽高在写入当刻取最新终端尺寸：转码期间的 resize 不会用过期值编码。
          const cols = Math.max(10, this.columns - 4)
          const maxRows = Math.max(5, Math.min(40, (this.stdout.rows || 24) - 6))
          for (const img of prepared) {
            const seq = encodeTermImage(img, protocol as 'kitty' | 'iterm2', cols, maxRows)
            // 图形序列不含换行；光标收尾按协议规范显式定义：
            // - kitty（默认 C=0）：placement 后光标右移 c 列、下移 r 行——已停在
            //   图片下方一行的 col c，只需 \r 归列首（补 \n 会多一个空行）。
            //   依据：kitty spec「cursor must be moved to the right by the number
            //   of cols ... and down by the number of rows in the placement」。
            // - iTerm2 OSC 1337：光标停在图片最后一行的右缘（wezterm#317 对真实
            //   iTerm2 的观测；wezterm#3266 须补换行提示符才落到图片下方）——
            //   需 \r\n：归列首并下移到图片下方。
            if (seq) this.commit.writeRaw(seq + (protocol === 'kitty' ? '\r' : '\r\n'))
          }
        }
      }
    })()
    return this.enqueueMainCommit(ready)
  }

  /** Await a queued user commit and surface a display failure without blocking delivery. */
  private async awaitUserCommit(content: string, images?: string[]): Promise<boolean> {
    const pending = this.commitUserPrompt(content, images)
    const written = pending ? await pending : true
    if (!written) {
      try {
        this.commitStatic(color('⚠ 用户消息显示失败，但内容已发送给 agent', this.theme.muted))
      } catch {
        // A broken stdout must not prevent the caller from delivering the input.
      }
    }
    return written
  }

  /** 气泡正文（须在 commitAbove 窗口内调用）。 */
  private writeUserBubbleLines(content: string, images?: string[]): void {
    const hasImages = images && images.length > 0
    let imageNote = ''
    if (hasImages) {
      imageNote = `\n${color(`📎 ${images.length} image${images.length > 1 ? 's' : ''} attached`, this.theme.muted)}`
      if (!this.supportsVision) {
        if (this.visionBridgeEnabled) {
          // 提示反映真实桥接来源，而非未经验证的话术。桥接=图先经视觉模型转文字描述再发。
          const src = this.visionBridgeSource === 'auto' ? '（自动选用的视觉模型）' : this.visionBridgeSource === 'same-provider' ? '（与主模型同一 provider）' : ''
          imageNote += `\n${color(`🖼 主模型不识图，将经识图桥${src}生成图片描述后发送`, this.theme.muted)}`
        } else {
          imageNote += `\n${color('⚠ 当前模型不支持识图，且无可用识图桥，图片未发送。请在 Settings → 识图模型 选一个视觉模型（或配置 agent.visionModel）。', this.theme.warning)}`
        }
      }
    }
    const formatted = formatUserMessage({
      content: content.trim() + imageNote,
      width: this.columns,
    }, this.theme)
    this.commit.write({ text: formatted.join('\n'), trailingNewline: true })
    this.state.committedCount++
  }

  // ── W3: phase + ticker ───────────────────────────────────────

  /** 统一 phase 设置入口：联动渲染 ticker 启停 */
  private setPhase(phase: ActivityPhase): void {
    this.state.phase = phase
    this.updateTicker()
  }

  /** streaming/thinking/analyzing/waiting 时启动 120ms ticker，idle 停止 */
  private updateTicker(): void {
    // 读屏档没有动态段可刷，ticker 只会白白触发重绘判定。
    // 输出冻结期同理——spinner tick 是触摸终端「视口被拽回底部」的元凶之一。
    const active = this.state.phase !== 'idle' && !this.screenReader && !this.outputFrozen
    if (active && !this.streamRenderController.ticker) {
      this.streamRenderController.ticker = setInterval(() => {
        this.streamRenderController.tick++
        if (this.metricsGlanceController.domainSyncProvider && this.streamRenderController.tick % 8 === 0) {
          this.syncSessionStarDomainFromAgent()
        }
        // Keep todo panel in sync during long agent runs (not just on tool result / turn boundary).
        this.refreshTodos()
        // H4：ticker 经 WriteBatcher 调度而非直接 renderLive，与流式 chunk 的渲染在
        // 同一 microtask 合并为单帧；配合 H2 无变化短路，spinner 空转 tick 变廉价。
        this.writeBatcher.schedule()
      }, 120)
      this.streamRenderController.ticker.unref?.()
    } else if (!active && this.streamRenderController.ticker) {
      clearInterval(this.streamRenderController.ticker)
      this.streamRenderController.ticker = null
    }
  }

  /** 记录 token/输出活动时间（spinner stall 检测） */
  private markActivity(): void {
    this.streamRenderController.lastActivityMs = Date.now()
  }

  // ── W4b: 输入辅助 ────────────────────────────────────────────

  /** 注入 slash 命令列表（main-ansi 启动时调用） */
  setSlashCommands(commands: SlashHintEntry[]): void {
    this.inputController.slashCommands = commands
  }

  /**
   * 接受 slash 菜单当前选中项（Tab 键路由，菜单打开时）。
   * 补全命令名到输入行（统一带尾空格留参数位）；带 argsHint 的命令在
   * setValue 触发的 onChange → refreshSlash 参数模式中保持菜单单条并显示
   * ghost 参数提示，此处随后关闭收敛（对齐 tianshu-public 语义）。
   */
  private acceptSlashCompletion(): void {
    const menu = this.inputController.slashMenu
    const selected = menu.matches[Math.min(menu.selected, menu.matches.length - 1)]
    if (selected === undefined) {
      this.inputController.closeSlash()
      this.renderLive()
      return
    }
    this.inputLine.setValue(`${selected.name} `)
    this.inputController.closeSlash()
    this.renderLive()
  }

  /**
   * Tab 补全：
   * - 输入以 `/` 开头 → 补全为过滤结果首项
   * - 光标前有 `@token` → git 文件补全（多候选时 Tab 循环）
   */
  private handleTabComplete(): boolean {
    const value = this.inputLine.value
    const cursor = this.inputLine.cursor

    // slash 命令补全（排除 `/file/path` 这类绝对路径；支持 /skill <name> 等多 token）
    if (value.startsWith('/') && !looksLikeFilePath(value, this.getCommandPredicate(), this.getCommandPrefixPredicate())) {
      // 菜单打开：Tab 接受当前选中项（补全命令名，argsHint 命令补到 `cmd ` 留参数位）
      if (this.inputController.slashMenu.open) {
        this.acceptSlashCompletion()
        return true
      }
      const target = slashCompletionTarget(value, this.inputController.slashCommands, 0)
      if (target && target !== value) {
        this.inputLine.setValue(`${target} `)
        return true
      }
      return false
    }

    // 协同建议行 Tab 采纳：`/<kind> ` + 当前文本转入输入框（不直接发送），本会话关闭建议。
    // 位于 @ 补全之前：建议行激活时 Tab 的意图是把活派给蜂群；文件补全循环进行中让位。
    // routing nudge 特例：采纳 = 转入 /config（不携带任务文本——去配置，不是派活）。
    if (this.orchHint.active && !this.inputController.fileCompletion) {
      this.inputLine.setValue(this.orchHint.kind === 'routing' ? '/config ' : `/${this.orchHint.kind} ${value}`)
      this.orchHint.adopt()
      return true
    }

    // @ 文件补全（Tab 循环候选）
    if (this.inputController.fileCompletion) {
      const fc = this.inputController.fileCompletion
      fc.idx = (fc.idx + 1) % fc.candidates.length
      const applied = applyCompletion(fc.baseText, fc.baseCursor, fc.candidates[fc.idx]!)
      this.inputLine.setValue(applied.text, applied.cursor)
      return true
    }

    const token = extractAtToken(value, cursor)
    if (token === null) return false
    const candidates = getCompletions(token, process.cwd(), 8)
    if (candidates.length === 0) return false

    this.inputController.fileCompletion = { baseText: value, baseCursor: cursor, candidates, idx: 0 }
    const applied = applyCompletion(value, cursor, candidates[0]!)
    this.inputLine.setValue(applied.text, applied.cursor)
    if (candidates.length === 1) {
      this.inputController.fileCompletion = null // 唯一候选，无需循环
    }
    return true
  }

  /** 标记 assistant 响应开始（每段流式输出一次，无需多余标题行） */
  private commitAssistantHeader(): void {
    this.streamRenderController.assistantHeaderDone = true
  }

  /** 手动设置 streaming 状态 */
  setStreamingState(v: boolean): void {
    this.state.isStreaming = v
    if (!v) {
      this.setPhase('idle')
      this.live.clear()
    }
    this.renderLive()
  }

  /** 获取模型信息（供 slash commands 使用） */
  getModelInfo(): { modelName: string; turnNumber: number } {
    return {
      modelName: this.state.modelName,
      turnNumber: this.state.turnNumber,
    }
  }

  /** 设置模型信息（/model 切换后刷新 GlanceBar 显示） */
  setModelInfo(modelName: string, contextWindow?: number): void {
    this.state.modelName = modelName
    if (contextWindow !== undefined) this.metricsGlanceController.contextWindow = contextWindow
    this.forceRedraw()
  }

  /** 更新可脚本化 statusline 文本（null 隐藏该行）。 */
  setStatusLine(text: string | null): void {
    if (this.statusLineText === text) return
    this.statusLineText = text
    this.forceRedraw()
  }

  /** 设置外部 slash command 处理器（如 SlashRouter） */
  setSlashHandler(handler: (input: string) => boolean | Promise<boolean>): void {
    this.slashHandler = handler
  }

  /** 注册一条 metadata-driven slash 命令。 */
  registerSlashCommand(command: import('../slash-command-registry.js').SlashCommand): void {
    this.slashRegistry.register(command)
  }

  /**
   * 通过 slash 注册表执行一条命令。返回是否被消费。供外部 onSubmit 兜底：
   * 已注册命令若因任何原因漏过正常分发,再给一次注册表分发机会,避免静默
   * 变成 "Unknown command"。
   */
  async tryDispatchSlash(input: string): Promise<boolean> {
    const trimmed = input.trim()
    const res = await this.slashRegistry.execute({ app: this, input, trimmed })
    return res.handled
  }

  /**
   * 全屏清屏 + live 区重置重绘——/clear 语义的唯一实现。内建注册与
   * slash-commands.ts 的 TUI 覆盖版都委托这里，避免覆盖版绕过私有
   * renderLive 手写 stdout（曾漏掉 live.reset() 致清屏后 live 区状态陈旧）。
   * 直写 stdout 在 /tui/engine/ 白名单内（见 architecture-guards）。
   */
  clearScreen(): void {
    process.stdout.write('\x1B[2J\x1B[H')
    this.live.reset()
    this.renderLive()
  }

  /** 注册内置 slash 命令（/clear、/starmap、/chronicle、/exit）。 */
  private registerBuiltinSlashCommands(): void {
    this.slashRegistry.registerMany([
      {
        name: '/clear',
        description: 'Clear screen',
        immediate: true,
        handler: () => {
          this.clearScreen()
          return true
        },
      },
      {
        name: '/starmap',
        description: 'Open starmap overlay',
        immediate: true,
        overlay: 'starmap',
        handler: () => true,
      },
      {
        name: '/chronicle',
        description: 'Open chronicle overlay',
        immediate: true,
        overlay: 'chronicle',
        handler: () => true,
      },
      {
        name: '/exit',
        description: 'Exit Rivet',
        immediate: true,
        handler: () => {
          this.dispose()
          if (this.onExitCallback) {
            this.onExitCallback()
          } else {
            process.exit(0)
          }
          return true
        },
      },
      {
        name: '/quit',
        description: 'Exit Rivet',
        immediate: true,
        handler: () => {
          this.dispose()
          if (this.onExitCallback) {
            this.onExitCallback()
          } else {
            process.exit(0)
          }
          return true
        },
      },
      {
        name: '/panel',
        description: 'Toggle right side panel',
        immediate: true,
        handler: ({ trimmed }) => {
          const parts = trimmed.split(/\s+/)
          const arg = parts[1]?.toLowerCase()
          if (arg === 'on') this.setSidePanelOpen(true)
          else if (arg === 'off') this.setSidePanelOpen(false)
          else this.toggleSidePanel()
          return true
        },
      },
    ])
  }

  /**
   * 注入真实指标提供者（main-ansi 闭包读 ctx.session）。
   * 设置后 GlanceBar 优先用真实数据；未设置则回退内部估算（保持可独立运行/可测）。
   */
  setMetricsProvider(provider: TuiMetricsProvider): void {
    this.metricsGlanceController.metricsProvider = provider
  }

  /** 设置当前审批模式（供 worker pills 显示 badge） */
  setApprovalMode(mode: string): void {
    this._approvalMode = mode
  }

  /**
   * 设置会话星域显示（/domain 切换 → GlanceBar）。
   * undefined 表示 auto/off/未设定，GlanceBar 回退默认「天枢」。
   */
  setSessionStarDomain(domainName: string | undefined): void {
    this.metricsGlanceController.sessionStarDomainName = domainName
    this.applyGlanceDomainDisplay()
    this.forceRedraw()
  }

  /** 注册 agent 星域同步（streaming ticker ~1Hz 读取 getSessionDomain） */
  setDomainSyncProvider(provider: () => string | undefined): void {
    this.metricsGlanceController.domainSyncProvider = provider
  }

  /** 注册当前推理 effort 提供者（GlanceBar 每帧读取，显示实时思考强度） */
  setReasoningEffortProvider(provider: () => string | undefined): void {
    this.metricsGlanceController.reasoningEffortProvider = provider
  }

  /** 注册子代理路由配置状态提供者（routing nudge 的 onChange 读取；缺省视为已配置）。 */
  private routingConfiguredProvider?: () => boolean
  setRoutingConfiguredProvider(provider: () => boolean): void {
    this.routingConfiguredProvider = provider
  }

  private applyGlanceDomainDisplay(): void {
    // 会话星域显示单一来源：/domain 设定（sessionStarDomainName）。派发阶段不再
    // 覆盖显示——「天机」是编排阶段的内部路由标记，不上主面板（用户实锤）。
    const display = resolveStarDomainDisplay(this.metricsGlanceController.sessionStarDomainName)
    if (display) {
      this.state.domainGlyph = display.glyph
      this.state.domainName = display.name
    } else {
      this.state.domainGlyph = undefined
      this.state.domainName = undefined
    }
  }

  private syncSessionStarDomainFromAgent(): void {
    if (!this.metricsGlanceController.domainSyncProvider) return
    const next = this.metricsGlanceController.domainSyncProvider()
    if (next === this.metricsGlanceController.sessionStarDomainName) return
    this.metricsGlanceController.sessionStarDomainName = next
    this.applyGlanceDomainDisplay()
  }

  /**
   * 读取当前真实指标快照（与 GlanceBar 同源）。无 provider 时返回 null。
   * 供 SlashRouter 让 /cost、maxTokens 等命令读到与 GlanceBar 一致的真实值，
   * 不再写死 cost: 0 或取 models[0]（非当前模型）。
   */
  getMetrics(): TuiMetrics | null {
    return this.metricsGlanceController.metricsProvider?.() ?? null
  }

  /**
   * 注入 todo 列表访问器（main-ansi 读 TodoStore 单例），避免 T9 直接 import
   * 工具层。设置后 todo 工具结果 / turn 完成时拉取刷新常驻任务面板。
   */
  setTodosProvider(provider: () => TodoItem[]): void {
    this.todosProvider = provider
  }

  /**
   * 注入当前已批准计划指针访问器（main-ansi 读 PromptEngine）。
   * 用于右侧面板 lightweight 展示当前执行的任务计划。
   */
  setActivePlanProvider(provider: () => string | undefined): void {
    this.activePlanProvider = provider
  }

  setPlanDraftProvider(provider: () => { path: string; bytes?: number } | null | undefined): void {
    this.planDraftProvider = provider
  }

  /**
   * 注入 GoalTracker 访问器，供 GlanceBar 展示目标迭代/预算状态。
   */
  setGoalTrackerProvider(provider: () => import('../../agent/goal-tracker.js').GoalTracker | null): void {
    this.goalTrackerProvider = provider
  }

  /**
   * 注入 PlanExecutionTrace 访问器，供右侧面板展示计划步骤进度。
   */
  setPlanTraceProvider(provider: () => import('../../agent/plan-execution-trace.js').PlanExecutionTrace | null): void {
    this.planTraceProvider = provider
  }

  /**
   * 注入 plan-mode 状态访问器，供 GlanceBar 显示 plan 指示灯。
   */
  setPlanModeProvider(provider: () => boolean): void {
    this.planModeProvider = provider
  }

  setAskModeProvider(provider: () => boolean): void {
    this.askModeProvider = provider
  }

  /** Shift+Tab 循环权限模式。Wired from main.ts. */
  setPlanModeToggleHandler(handler: () => void): void {
    this.planModeToggleHandler = handler
  }

  /**
   * 注册 side panel 状态变化回调，用于把展开状态持久化到会话元数据。
   */
  setSidePanelChangeCallback(cb: (open: boolean) => void): void {
    this.onSidePanelChange = cb
  }

  /** 直接设置任务面板内容（供测试与 provider 刷新复用）。 */
  setTodos(items: TodoItem[]): void {
    this.updateTodos(items)
    this.renderLive()
  }

  /** 切换右侧面板展开/折叠（仅宽终端生效）。overlay 激活时静默忽略。 */
  toggleSidePanel(): void {
    if (this.overlay.isActive()) return
    this.setSidePanelOpen(!this.state.sidePanelOpen)
  }

  /** 设置右侧面板展开状态；若终端太窄或 overlay 激活则静默不展开。 */
  setSidePanelOpen(open: boolean): void {
    if (open && resolveSidePanelWidth(this.columns) === 0) return
    if (this.overlay.isActive()) return
    this.state.sidePanelOpen = open
    try { this.onSidePanelChange?.(open) } catch { /* persistence failure is non-fatal */ }
    this.renderLive()
  }

  /** 查询右侧面板是否展开（对齐可见状态——窄终端下面板不可见即为关闭）。 */
  isSidePanelOpen(): boolean {
    return this.state.sidePanelOpen && resolveSidePanelWidth(this.columns) > 0
  }

  /** 写入 todos 并检测进度变化：done 增加 / total 变化时点亮 GlanceBar 徽章
   *  高亮 ~1s（reducedMotion 不高亮）。 */
  private updateTodos(items: TodoItem[]): void {
    const prev = this.state.todos
    const prevDone = prev.reduce((n, x) => n + (x.status === 'completed' ? 1 : 0), 0)
    const nextDone = items.reduce((n, x) => n + (x.status === 'completed' ? 1 : 0), 0)
    this.state.todos = items
    // 本 run 写入检测（清单身份签名变化 = 新写入）：签名覆盖 id/status/内容，
    // 与 provider 轮询的同值拉取（ticker 每 120ms 拉一次）区分——只有 AI 真正
    // 写了新清单才算「本 run 有 todo」，见 todosWrittenThisRun 注释。
    const sig = (xs: readonly TodoItem[]): string => xs.map(x => `${x.id}:${x.status}:${x.content}`).join('|')
    if (sig(items) !== sig(prev)) this.todosWrittenThisRun = true
    if (!isReducedMotion() && (nextDone > prevDone || items.length !== prev.length)) {
      this.state.todoFlashUntil = Date.now() + 1000
      if (this.todoFlashTimer) clearTimeout(this.todoFlashTimer)
      this.todoFlashTimer = setTimeout(() => {
        this.todoFlashTimer = null
        this.renderLive()
      }, 1050)
      this.todoFlashTimer.unref?.()
    }
  }

  /** 从 provider 拉取最新 todo 列表刷新面板（无 provider 时 no-op）。 */
  private refreshTodos(): void {
    if (!this.todosProvider) return
    try {
      this.updateTodos(this.todosProvider())
    } catch {
      // provider 失败不应中断渲染
    }
  }

  // ── Approval state (W-B4: fields moved to ApprovalIntentController) ───

  // ── Agent Event Handlers ─────────────────────────────────────

  private handleTextDelta(text: string): void {
    this.state.isStreaming = true
    this.setPhase('streaming')
    this.markActivity()
    // Push through block writer (buffers text, emits in display-sized blocks)
    const stableCommitGeneration = this.stableStreamCommitGeneration
    this.blockWriter.push(text)
    // 逐 delta 触发（microtask 合并）重绘——live tail 拼接 blockWriter.peek() 后，
    // 最新 token 无需等吐块即可逐字滑出（打字机节奏）。与 handleThinkingDelta 同口径。
    if (this.stableStreamCommitGeneration === stableCommitGeneration) {
      this.writeBatcher.schedule()
    }
  }

  private handleThinkingDelta(thinking: string): void {
    this.state.isThinking = true
    this.setPhase('thinking')
    this.markActivity()
    this.state.thinkingText += thinking
    if (this.state.thinkStartMs === 0) {
      this.state.thinkStartMs = Date.now()
    }
    // 经 WriteBatcher 合并：DeepSeek reasoning_content 是逐字高频流，旧实现每个
    // token 直接 renderLive() → 全区域重写 + stringWidth×N，深思期持续刷屏卡顿。
    // 与正文流（blockWriter → writeBatcher.schedule）同口径：同一 microtask 内多次
    // delta 只渲染一次；120ms ticker 仍保底 spinner 帧率。
    this.writeBatcher.schedule()
  }

  private handleToolUse(id: string, name: string, input: Record<string, unknown>): void {
    this.setPhase('analyzing')
    this.markActivity()
    this.toolGroupController.setPending(id, { name, input, startMs: Date.now(), _approvalMode: this._approvalMode })
    // 注意：派发类工具（delegate_*/team_orchestrate/galaxy）不再切换 GlanceBar 星域——
    // 「天机」是子代理编排阶段的内部路由标记，不是用户可选的会话星域；把它顶到
    // 主面板星域位会让用户误以为 /domain 切了域（还牵连缓存语义），且顺带改变了
    // 输入框边框的星域 persona separator。会话星域显示恒随 /domain 设定。

    // 工具折叠组：read/search 与可折叠 bash 各走各的 buffer，互相打断。
    // non-collapsible（含变更型 bash）到达时 flush 两个组。
    if (isCollapsibleTool(name)) {
      if (this.toolGroupController.isActiveBashGroup()) this.flushBashGroup()
      this.toolGroupController.pushUse(id, name, input)
    } else if (name === 'bash' && isCollapsibleBashCommand(input.command as string)) {
      if (this.toolGroupController.isActiveGroup()) this.flushToolGroup()
      this.toolGroupController.pushBashUse(id, input.command as string, Date.now())
    } else {
      if (this.toolGroupController.isActiveGroup()) this.flushToolGroup()
      if (this.toolGroupController.isActiveBashGroup()) this.flushBashGroup()
    }

    // Commit thinking if any
    if (this.state.thinkingText) {
      this.commitAbove(() => this.commitThinking())
    } else {
      this.writeBatcher.flushNow()
    }
  }
  /** 将 read/search 折叠组 buffer 刷新到 scrollback */
  private flushToolGroup(): void {
    const group = this.toolGroupController.flushGroup()
    if (!group || group.entries.length === 0) return
    const formatted = formatCollapsedGroup({ group, theme: this.theme })
    this.commitAbove(() => {
      this.commit.write({ text: formatted.join('\n'), trailingNewline: true })
      this.state.committedCount++
    })
  }

  /** 将 bash 折叠组 buffer 刷新到 scrollback */
  private flushBashGroup(): void {
    const group = this.toolGroupController.flushBashGroup()
    if (!group || group.entries.length === 0) return
    const formatted = formatCollapsedBashGroup({ group, theme: this.theme })
    this.commitAbove(() => {
      this.commit.write({ text: formatted.join('\n'), trailingNewline: true })
      this.state.committedCount++
    })
  }

  /**
   * T4 — 结构化 per-worker 委派活动 → 舰队读模型。
   * 仅更新读模型并安排一次合并渲染（live 区的 worker 面板 / `/tasks` overlay
   * 据此实时刷新）。终态清理在委派工具 result 到达时统一处理。
   */
  private handleDelegationActivity(activity: DelegationActivity): void {
    const prev = this.fleet.getWorkerById(activity.workOrderId)
    // 已终态的 id 又起跑 = 新一轮派发（稳定 order id 如 batch:0 跨轮复用）。
    // 去重集按 id 记，不撤销的话第二次派发就永远不打卡了。
    if (prev?.terminal && activity.status === 'running') {
      this.dispatchCardShown.delete(activity.workOrderId)
    }
    this.fleet.apply(activity)
    this.mirror.apply(activity)
    // 派发契约卡：worker 起跑瞬间沉淀「目标 + 范围」到 scrollback。
    // 必须同时卡住 status==='running'——contract 只随首条 running 事件携带，
    // 终态回放（resume/归档）若也带上就会为已结束的 worker 补打派发卡。
    if (activity.status === 'running' && activity.contract && !this.dispatchCardShown.has(activity.workOrderId)) {
      this.dispatchCardShown.add(activity.workOrderId)
      const card = formatWorkerDispatchCard(activity.contract, activity.workOrderId, {
        columns: this.columns,
        theme: this.theme,
      })
      if (card.length > 0) this.commitStatic(card.join('\n'))
    }
    // 终态转变 → 主区完成通知行（CC 后台任务完成对标）。
    // 只在「见过 running」的 worker 上通知，避免纯终态回放（resume/归档）刷屏。
    if (prev && !prev.terminal) {
      const now = this.fleet.getWorkerById(activity.workOrderId)
      if (now?.terminal) this.notifyWorkerTerminal(now)
    }
    this.markActivity()
    this.writeBatcher.schedule()
  }

  /** worker 终态完成通知：一行摘要入 scrollback + 可选终端 bell（RIVET_NOTIFY_BELL=1）。 */
  private notifyWorkerTerminal(w: import('../fleet-registry.js').FleetWorkerView): void {
    const star = authorityStarName(w.authority)
    const label = star ? `${star} · ${profileLabel(w.profile)}` : profileLabel(w.profile)
    const stats: string[] = []
    if (w.toolUseCount > 0) stats.push(`${w.toolUseCount} 工具`)
    if (w.tokenCount > 0) stats.push(`${formatTokenCount(w.tokenCount)} tok`)
    const elapsed = formatElapsed(w.elapsedMs)
    if (elapsed) stats.push(elapsed)
    const statsStr = stats.length > 0 ? `  ${stats.join(' · ')}` : ''
    const ok = w.status === 'completed'
    const glyph = ok ? '✓' : w.status === 'failed' ? '✗' : '⊗'
    // 目标优先、身份次之、计数收尾——与 live 舰队带的紧凑行同构（形态恒定，
    // 用户视线能把「跑着的那一行」和「落进 scrollback 的这一行」连起来），
    // 也对齐 CC 的 `general-purpose  {描述}  7m 44s · 68.6k tokens`。
    // 压平嵌入换行：activity/objective 是自由文本（review evidence 用 \n 拼接）。
    const flat = (s: string): string => s.replace(/\s+/g, ' ').trim()
    const objective = w.contract?.objective ? flat(w.contract.objective).slice(0, 60) : ''
    const detail = objective || (w.activity ? flat(w.activity).slice(0, 60) : '')
    // 保留「子代理X」这个语义标签：scrollback 里 ✓ 开头的行不止一种，去掉之后
    // 「✓ 审查 all good」无从判断是子代理终态还是别的什么完成了。
    const verb = ok ? '完成' : w.status === 'failed' ? '失败' : w.status === 'blocked' ? '受阻' : '升级'
    const head = `子代理${verb} ${label}`
    const line = ` ${glyph} ${head}${detail ? `  ${detail}` : ''}${statsStr}`
    this.commitStatic(color(line, ok ? this.theme.success : this.theme.warning))
    if (process.env.RIVET_NOTIFY_BELL === '1') this.stdout.write('\x07')
  }

  /**
   * 后台 job 事件入口（started/output/exit）。仅更新读模型 + 起跑/终态各提交一行
   * scrollback，安排一次合并渲染。任何异常吞掉——本方法在 EventEmitter 监听器里跑，
   * 抛出会 crash 进程。
   */
  handleJobEvent(ev: JobEvent): void {
    try {
      if (!ev || !ev.job || typeof ev.job.id !== 'string') return
      const isNew = ev.kind === 'started' && !this.jobsSeenStart.has(ev.job.id)
      const applied = this.jobsModel.apply(ev)
      if (isNew) {
        this.jobsSeenStart.add(ev.job.id)
        const cmd = ev.job.command.replace(/\s+/g, ' ').trim().slice(0, 60)
        this.commitStatic(color(` ▸ 后台任务启动: ${cmd} (${ev.job.id})`, this.theme.muted))
      }
      if (applied.becameTerminal) this.notifyJobTerminal(applied.row)
      this.markActivity()
      this.writeBatcher.schedule()
    } catch { /* job event handling is best-effort — never crash the TUI */ }
  }

  /** job 终态完成通知：一行摘要入 scrollback + 可选终端 bell（RIVET_NOTIFY_BELL=1）。 */
  private notifyJobTerminal(row: JobRow): void {
    const ok = row.status === 'exited' && row.exitCode === 0
    const glyph = ok ? '✓' : row.status === 'killed' ? '⊗' : '✗'
    const verb = ok ? '完成' : row.status === 'killed' ? '已停止' : '退出'
    const cmd = row.command.replace(/\s+/g, ' ').trim().slice(0, 50)
    const elapsed = formatElapsedShort(row.endedAt ? row.endedAt - row.startedAt : 0)
    const code = row.status === 'exited' && row.exitCode !== 0 ? ` (exit ${row.exitCode})` : ''
    const line = ` ${glyph} 后台任务${verb}: ${cmd}${code} (${elapsed})`
    this.commitStatic(color(line, ok ? this.theme.success : this.theme.warning))
    if (process.env.RIVET_NOTIFY_BELL === '1') this.stdout.write('\x07')
  }

  /** overlay 数据 provider：当前 job 行 + 选中索引（按 id 解析，防重排漂移）。 */
  getJobsData(): { rows: JobRow[]; selectedIndex: number } {
    const rows = this.jobsModel.rows()
    const nav = this.overlayController.nav()
    const byId = nav.jobsSelectedId ? rows.findIndex(r => r.id === nav.jobsSelectedId) : -1
    const selectedIndex = byId >= 0 ? byId : Math.min(nav.jobsIndex ?? 0, Math.max(0, rows.length - 1))
    return { rows, selectedIndex }
  }

  /**
   * 进行中的 job(action:'await') 调用——等待区如实化的数据源。阻塞期间该工具
   * 自身零事件（job-tool.ts），pending entry 是唯一线索。并发多个 await 时取
   * 最早起跑的（等得最久的那个信息量最大）。
   */
  private jobAwaitPending(): JobAwaitCall | null {
    let found: JobAwaitCall | null = null
    for (const [, meta] of this.toolGroupController.getPendingEntries()) {
      if (meta.name !== 'job' || meta.input?.action !== 'await') continue
      const call: JobAwaitCall = {
        jobId: String(meta.input.id ?? ''),
        timeoutMs: meta.input.timeout,
        startMs: meta.startMs,
      }
      if (!found || call.startMs < found.startMs) found = call
    }
    return found
  }

  /** main.ts 接线：停止后台 job 的回调。 */
  setJobKill(fn: (jobId: string) => boolean): void {
    this.jobKill = fn
  }

  /** main.ts 接线：获取 job 日志文本的回调。 */
  setJobLogs(fn: (jobId: string) => string | null): void {
    this.jobLogs = fn
  }

  /**
   * 将 team_orchestrate 的静态计划面板叠加运行态：依据 fleet 中在跑 worker 的
   * workOrderId（"team:T1" / "wo_team:T1"）反查 task id，把对应 waiting 任务标 running。
   * 终态任务（在 fleet 已无活跃记录）保持 waiting，待终态面板权威覆盖。
   */
  private teamModelWithLiveStatus(model: TeamPanelModel): TeamPanelModel {
    // P5: overlay full live fleet status (running/done/failed + elapsed/activity +
    // dependency-unlock cue) from all observed workers, not just running task ids.
    return overlayFleetStatus(model, this.fleet.getWorkers())
  }

  /**
   * team wave 推进时提交一行完成时间线（`✓ wave 1/3 完成 · 4/4 任务 · 12m30s`）。
   * 长跑 team（30min+）在终态面板落地前 scrollback 零反馈——本方法是中段唯一
   * 路标。currentWave 是 0-based 活动波索引（buildTeamPanelModel 口径），故已
   * 完成波次（1-based）恰为 1..currentWave；重复推送由 lastCommittedTeamWave
   * 去重；耗时只附在最近一波上（跨波跳变时前几波耗时不可知，不伪造）。
   * 最后一波的完成行不走这里（currentWave 不会越过末波）——由终态面板承载。
   */
  private commitTeamWaveTransitions(model: TeamPanelModel): void {
    if (this.teamWaveStartedAt === 0) this.teamWaveStartedAt = Date.now()
    const completedThrough = model.currentWave
    if (completedThrough <= this.lastCommittedTeamWave) return
    for (let w = this.lastCommittedTeamWave + 1; w <= completedThrough; w++) {
      const wave = model.waves[w - 1]
      if (!wave) continue
      const waveTasks = model.tasks.filter(t => wave.taskIds.includes(t.id))
      const done = waveTasks.filter(t => t.status === 'done').length
      const failed = waveTasks.filter(t => t.status === 'failed' || t.status === 'blocked').length
      const stats = [`${done}/${waveTasks.length} 任务`]
      if (failed > 0) stats.push(`✗ ${failed}`)
      if (w === completedThrough) {
        const elapsed = formatElapsed(Date.now() - this.teamWaveStartedAt)
        if (elapsed) stats.push(elapsed)
      }
      const ok = failed === 0
      this.commitStatic(color(
        ` ${ok ? '✓' : '⚠'} wave ${w}/${model.totalWaves} 完成 · ${stats.join(' · ')}`,
        ok ? this.theme.success : this.theme.warning,
      ))
    }
    this.lastCommittedTeamWave = completedThrough
    // 新一波从此时计时。
    this.teamWaveStartedAt = Date.now()
  }

  private handleToolResult(id: string, name: string, result: string, isError?: boolean, rawPath?: string, uiContent?: string): void {
    // DEBUG: unconditional trace for TUI rendering-loss investigation.
    // Log output goes to stderr when RIVET_DEBUG=1.
    // Also see: ~/.rivet/sessions/<project-slug>/<sessionId>/tool-result-trace.jsonl
    debugLog(`[tool-result-trace] tui id=${id} name=${name} isError=${isError} len=${result?.length ?? 0}`)
    const displayContent = uiContent ?? result

    // Streaming chunk mode: isError === undefined means intermediate update
    if (isError === undefined) {
      debugLog(`[tool-result-trace] tui id=${id} → STREAMING chunk (not committing to scrollback)`)
      // team_orchestrate fleet viz: the orchestrator streams an initial encoded
      // TeamPanel (all-waiting DAG) before dispatch. Intercept it into liveTeamModel
      // and DO NOT accumulate — otherwise it would double-decode at terminal
      // (indexOf would hit this stale panel before the real one) and leak the raw
      // encoded string into the live tool tail.
      if (name === 'team_orchestrate' && result.includes(TEAM_PANEL_UI_PREFIX)) {
        const model = decodeTeamPanelModel(result)
        if (model) {
          this.liveTeamModel = model
          this.commitTeamWaveTransitions(model)
          this.markActivity()
          this.writeBatcher.schedule()
          return
        }
      }
      // council_convene live viz: intercept encoded CouncilPanel frames (skeleton
      // + progress updates) into liveCouncilModel. Same pattern as team_orchestrate:
      // do NOT accumulate — terminal already has the final frame in uiContent.
      if (name === 'council_convene' && result.includes(COUNCIL_PANEL_UI_PREFIX)) {
        const model = decodeCouncilPanel(result)
        if (model) {
          this.liveCouncilModel = model
          this.markActivity()
          this.writeBatcher.schedule()
          return
        }
      }
      // Accumulate for live tool card display — show last lines in live region
      const toolAcc = this.toolGroupController.getAccumulated(id) ?? ''
      this.toolGroupController.accumulate(id, result)
      this.markActivity()
      // 经 WriteBatcher 合并：长输出工具（bash/test）逐 chunk 上行，旧实现每 chunk
      // 直接 renderLive() 全区域重绘。与正文/思考流同口径合并到 microtask。
      this.writeBatcher.schedule()
      return
    }

    // Terminal result: commit to scrollback.
    debugLog(`[tool-result-trace] tui id=${id} → TERMINAL (committing to scrollback)`)
    // Progress unit counted HERE (after the streaming-chunk early return), not
    // at method entry: onOutput streams one callback per chunk with isError
    // undefined, and counting chunks would let a single chatty tool call (4+
    // chunks) satisfy the threshold — diluting the dense-stall detector
    // calibrated for (>= 2 full tool batches).
    this.watchdogPolicy.recordToolResult()
    // 工具结果落地即活动——重置静默钟，避免终态到达后 stale 分档仍按旧沉默
    // 时长误报「No response — Ctrl+C to interrupt」。
    this.markActivity()
    const toolAcc = this.toolGroupController.getAccumulated(id)
    this.toolGroupController.deleteAccumulated(id)
    this.toolTailCache.delete(id)
    const meta = this.toolGroupController.getPending(id)
    this.toolGroupController.deletePending(id)
    // 委派工具终态：该组 worker 移入舰队归档区（终态摘要已通过
    // onDelegationActivity 到达，面板转入 scrollback 后无需常驻 live 区）。
    // 归档视图渲染为「完成沉淀卡」入 scrollback——与 live 树同构的静态组级
    // 摘要，让长跑委派在时间线上留下完整痕迹而非只剩一行 N/M passed。
    if (meta && isDelegationTool(meta.name)) {
      const { settled, evictedIds } = this.fleet.clearGroup(id)
      // 归档区封顶淘汰的 worker：镜像与派发卡去重集同步清，防跨 run 无界滞留。
      for (const evicted of evictedIds) {
        this.mirror.delete(evicted)
        this.dispatchCardShown.delete(evicted)
      }
      if (settled.length > 0) {
        const card = formatWorkerFleetSettled(settled, this.theme, this.columns)
        this.commitAbove(() => {
          this.commit.write({ text: card.join('\n'), trailingNewline: true })
          this.state.committedCount++
        })
      }
    }
    const finalContent = toolAcc ? toolAcc + displayContent : displayContent

    // 可折叠 tool（read/grep/glob/repo_map 等探索型）：按 toolUseId 绑定结果到折叠组
    if (isCollapsibleTool(name)) {
      // G4 修复：buffer 已被 flush（如 write 打断），迟到 result 自动开新组
      if (!this.toolGroupController.isActiveGroup()) {
        this.toolGroupController.pushUse(id, name, meta?.input ?? {})
      }
      this.toolGroupController.attachResult(id, finalContent, isError)
      // 不单独 commit — 将在 flushToolGroup 时作为组渲染
      this.writeBatcher.flushNow()
      return
    }

    // 可折叠 bash：成功则绑定到组延迟渲染；错误则把前面成功命令摘要后单独渲染错误卡片
    if (name === 'bash' && this.toolGroupController.hasBashEntry(id)) {
      if (isError) {
        this.toolGroupController.detachBashEntry(id)
        this.flushBashGroup()
      } else {
        this.toolGroupController.attachBashResult(id, finalContent, isError)
        this.writeBatcher.flushNow()
        return
      }
    }

    // team_orchestrate：把编码串 rivet:team-panel:v1:{...} 解码为 TeamPanel 面板，
    // 而非把裸编码串当工具卡片输出（对齐 Ink decodeTeamPanelModel + TeamPanel）。
    if (name === 'team_orchestrate') {
      // Live panel is being committed to scrollback — drop the in-flight overlay.
      this.liveTeamModel = null
      this.lastCommittedTeamWave = 0
      this.teamWaveStartedAt = 0
      const model = decodeTeamPanelModel(finalContent.trim())
      if (model) {
        const panel = formatTeamPanel(model, this.theme, this.columns)
        this.commitAbove(() => {
          this.commit.write({ text: panel.join('\n'), trailingNewline: true })
          this.state.committedCount++
        })
        return
      }
    }

    // council_convene：终态 verdict 卡——解码 CouncilPanelModel 并 commit 进
    // scrollback（与 team 终态的 formatTeamPanel 分支同构）。
    if (name === 'council_convene') {
      this.liveCouncilModel = null
      const model = decodeCouncilPanel(finalContent.trim())
      if (model) {
        const panel = formatCouncilPanel(model, this.theme, this.columns)
        this.commitAbove(() => {
          this.commit.write({ text: panel.join('\n'), trailingNewline: true })
          this.state.committedCount++
        })
        return
      }
    }

    // ask_user_question 用模态化边框卡片渲染，确保问题和选项完整可见。
    if (name === 'ask_user_question') {
      const formatted = formatAskUserQuestion({ content: finalContent, columns: this.columns }, this.theme)
      this.commitAbove(() => {
        this.commit.write({ text: formatted.join('\n'), trailingNewline: true })
        this.state.committedCount++
      })
      return
    }

    const cardInput = {
      toolName: name,
      content: finalContent,
      isError,
      rawPath,
      toolInput: meta?.input,
      elapsedMs: meta ? Date.now() - meta.startMs : undefined,
    }
    const formatted = formatToolCard(cardInput, this.theme)

    // 记录截断结果供 ctrl+o 展开
    if (isToolCardTruncated(cardInput)) {
      this.toolGroupController.setLastTruncatedTool({
        toolName: name,
        content: finalContent,
        isError,
        rawPath,
        toolInput: meta?.input,
      })
    }

    this.commitAbove(() => {
      // 块尾空行：与 user/assistant/summary 统一间距契约
      this.commit.write({ text: formatted.join('\n'), trailingNewline: true })
      this.state.committedCount++
    })

    // todo / plan_task 写入后刷新常驻任务面板（canonical 源为 TodoStore）。
    // plan_task 同样调用 setTodos 落库，但工具名不是 'todo'，过去走不到立即刷新，
    // 面板要等下次 ticker 轮询或回合结束才更新——这里一并立即刷新。
    if (name === 'todo' || name === 'plan_task') {
      this.refreshTodos()
      this.writeBatcher.flushNow()
    }
  }

  /** ctrl+o：展开最近被截断的工具结果或折叠组 */
  private expandLastTruncatedTool(): void {
    // 优先展开 read/search 折叠组
    const collapsed = this.toolGroupController.getLastCollapsedGroup()
    if (collapsed) {
      const g = collapsed
      this.toolGroupController.clearLastCollapsedGroup()
      const formatted = formatCollapsedGroup({ group: g, expanded: true, theme: this.theme })
      this.commitAbove(() => {
        this.commit.write({ text: formatted.join('\n'), trailingNewline: true })
        this.state.committedCount++
      })
      return
    }
    // live 中的活跃 read/search 组：flush 并展开提交（无需等非折叠工具打断）。
    // flushGroup 会写入 lastCollapsedGroup——立即清掉，避免下次 ctrl+o 重复展开同一组。
    if (this.toolGroupController.isActiveGroup()) {
      const g = this.toolGroupController.flushGroup()
      if (g) {
        this.toolGroupController.clearLastCollapsedGroup()
        const formatted = formatCollapsedGroup({ group: g, expanded: true, theme: this.theme })
        this.commitAbove(() => {
          this.commit.write({ text: formatted.join('\n'), trailingNewline: true })
          this.state.committedCount++
        })
        return
      }
    }
    // 其次展开 bash 折叠组
    const collapsedBash = this.toolGroupController.getLastCollapsedBashGroup()
    if (collapsedBash) {
      const g = collapsedBash
      this.toolGroupController.clearLastCollapsedBashGroup()
      const formatted = formatCollapsedBashGroup({ group: g, expanded: true, theme: this.theme })
      this.commitAbove(() => {
        this.commit.write({ text: formatted.join('\n'), trailingNewline: true })
        this.state.committedCount++
      })
      return
    }
    // 回退：展开单个截断工具卡片
    const t = this.toolGroupController.getLastTruncatedTool()
    if (!t) return
    this.toolGroupController.clearLastTruncatedTool()
    const formatted = formatToolCard({
      toolName: t.toolName,
      content: t.content,
      isError: t.isError,
      rawPath: t.rawPath,
      toolInput: t.toolInput,
      expanded: true,
    }, this.theme)
    this.commitAbove(() => {
      this.commit.write({ text: formatted.join('\n'), trailingNewline: true })
      this.state.committedCount++
    })
  }

  private handleCheckpoint(hash: string): void {
    this.commitAbove(() => {
      this.commit.write({
        text: `Checkpoint saved: ${hash.slice(0, 7)} — /rollback to restore`,
        trailingNewline: true,
      })
      this.state.committedCount++
    })
  }

  private async handleTurnComplete(usage: Partial<Usage>, turnNumber: number, isFinal: boolean): Promise<void> {
    this.turnCompleteInFlight++
    try {
    this.state.turnNumber = turnNumber

    // A completed turn (even intermediate) is forward progress: the stream
    // produced output, so the prior boundary stall cleared.
    this.watchdogPolicy.recordTurnComplete()

    // Flush 工具折叠组残余
    if (this.toolGroupController.isActiveGroup()) this.flushToolGroup()
    if (this.toolGroupController.isActiveBashGroup()) this.flushBashGroup()

    // Flush any pending blocks from the writer, then commit the remaining tail
    await this.blockWriter.flush()
    this.streamRenderer.finalize()
    this.streamRenderController.assistantHeaderDone = false

    // ── W3: 累计 usage → cache hit / context% / cost ────────────
    this.accumulateUsage(usage)

    // 兜底刷新任务面板（todo 工具结果未必每轮都到达）
    this.refreshTodos()

    if (isFinal) {
      // Reset state
      this.agentBusy = false
      this.lastSubmittedText = null // 回合成功 settle——错误回填底料作废
      this.state.thinkingText = ''
      this.state.isStreaming = false
      this.state.isThinking = false
      this.setPhase('idle')
      this.state.thinkStartMs = 0
      this.applyGlanceDomainDisplay()

      // 回合耗时文案：✦ Worked for 1m 6s · 12.3k in / 890 out
      const elapsed = Date.now() - this.state.turnStartMs
      const summary = formatTurnWorkSummary({
        elapsedMs: elapsed,
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
      }, this.theme)
      this.commitAbove(() => {
        this.commit.write({ text: summary, trailingNewline: true })
        this.state.committedCount++
      })

      // /handoff 归档：交接 turn 产出项目内文档后，拷贝到会话目录 <id>.handoff.md
      // （loadPrevHandoff 注入管线认的位置），新会话于是自动吃到交接。
      if (this.pendingHandoffCopy) {
        const { src, dest, sinceMs } = this.pendingHandoffCopy
        try {
          if (existsSync(src) && statSync(src).mtimeMs > sinceMs) {
            copyFileSync(src, dest)
            this.commitStatic(`✦ 交接文档已写入 ${src} 并归档 ${dest}——新会话将自动注入交接内容。`)
          }
        } catch { /* best-effort：归档失败不阻断会话 */ }
        this.pendingHandoffCopy = undefined
      }

      // 60% 交接提醒（每会话至多一次）：到达 HANDOFF_NUDGE_RATIO 时建议先 /handoff 再开新会话。
      if (!this.handoffNudgeShown) {
        try {
          const m = this.metricsGlanceController.metricsProvider?.()
          if (m && m.maxTokens > 0 && m.estimatedTokens / m.maxTokens >= HANDOFF_NUDGE_RATIO) {
            this.handoffNudgeShown = true
            this.commitStatic(formatHandoffNudge(m.estimatedTokens / m.maxTokens))
          }
        } catch { /* provider 失败不影响收尾 */ }
      }
    } else {
      // Intermediate turn: archive thinking, keep writer alive
      if (this.state.thinkingText) {
        this.commitAbove(() => this.commitThinkingToScrollback())
      }
      this.state.thinkingText = ''
      this.state.isThinking = false
      this.state.thinkStartMs = 0
      this.setPhase('waiting')
      this.writeBatcher.flushNow()
    }
    } finally {
      this.turnCompleteInFlight--
      this.flushPendingQueueDispatch()
    }
  }

  /**
   * 从 onTurnComplete 的 Usage 解析 cache hit / context% / session cost。
   *
   * 关键：agent 传入的 `usage` 已是 `session.getTotalUsage()` 的**累计**快照，
   * 因此这里是 snapshot 赋值而非 `+=`（旧实现每回合把累计值再累加，导致 cost
   * 随回合数指数级膨胀）。真实指标优先由 metricsProvider 提供，此处仅作回退。
   */
  private accumulateUsage(usage: Partial<Usage>): void {
    const input = usage.input_tokens ?? 0
    const output = usage.output_tokens ?? 0
    const cacheRead = usage.cache_read_input_tokens ?? 0
    const cacheCreate = usage.cache_creation_input_tokens ?? 0
    this.metricsGlanceController.totalUsage = { input, output, cacheRead, cacheCreate }

    if (input > 0) {
      this.metricsGlanceController.lastCacheHitRate = Math.min(1, cacheRead / input)
    }
    if (this.metricsGlanceController.contextWindow && this.metricsGlanceController.contextWindow > 0 && input > 0) {
      this.metricsGlanceController.lastContextRatio = Math.min(1, (input + output) / this.metricsGlanceController.contextWindow)
    }
  }

  /** Fallback cost estimate when no metricsProvider is wired (tests / no-config).
   *  Returns 0 — real cost comes from metricsProvider (main.ts wires findModelPricing
   *  + computeUsageCost). Guessing a price without knowing the provider/model
   *  produces misleading numbers, so we don't. */
  private estimateSessionCost(): number {
    return 0
  }

  private handleError(error: Error): void {
    this.agentBusy = false
    this.setPhase('idle')
    this.state.isStreaming = false
    this.state.isThinking = false
    // 与 abort 同口径 flush 折叠组，避免错误后孤儿结果滞留组内无法提交。
    if (this.toolGroupController.isActiveGroup()) this.flushToolGroup()
    if (this.toolGroupController.isActiveBashGroup()) this.flushBashGroup()
    // 与 abort 同口径回收 run 本地状态：provider 在工具/委派回合中报错走 onError，
    // 此时 pendingTools/toolAccumulator 可能持有半成品数据。只清 fleet 而漏清这两者，
    // 下一轮会读到上轮孤儿条目（live 区显示已死工具卡片、累加器跨 run 污染）。
    this.resetRunLocalState()
    // 错误时刻三件套：①错误本体 ②分类终态指引（「下一步」）③上一条回填输入框
    const refill = this.lastSubmittedText
    this.lastSubmittedText = null
    this.commitAbove(() => {
      this.commit.write({
        text: color(`✗ Error: ${error.message}`, this.theme.error),
        trailingNewline: true,
      })
      this.commit.write({
        text: color(`  ${errorRecoveryGuidance(error)}`, this.theme.muted),
        trailingNewline: true,
      })
      if (refill) {
        this.commit.write({
          text: color('  ↩ 上一条可能未被完整处理——已回填输入框，编辑后回车重发', this.theme.muted),
          trailingNewline: true,
        })
      }
    })
    // 输入框已有草稿时不抢写（用户正在输入的内容优先）
    if (refill && !this.inputLine.value) {
      this.inputLine.setValue(refill)
      this.renderLive()
    }
    this.flushPendingQueueDispatch()
  }

  /**
   * 统一的 run 本地状态回收：abort 与 error 两条收尾路径共用。
   *
   * 清四项随 run 存亡的本地状态：pendingTools（进行中工具元数据）、
   * toolAccumulator（流式工具输出累加）、fleet（舰队读模型）、liveTeamModel
   * （运行态 TeamPanel）。
   *
   * 为什么 handleError 必须与 handleAbort 同口径：provider 在委派/工具回合中
   * 报错走 onError（非 onAbort），此时 pendingTools/toolAccumulator 可能持有
   * 进行中工具的半成品数据。若只回收 fleet 而漏清这两个 Map，下一轮 run 会读到
   * 上一轮的孤儿条目（live 区显示已死的工具卡片、toolAccumulator 累加跨 run 污染）。
   */
  private resetRunLocalState(): void {
    this.toolGroupController.clear()
    this.fleet.clear()
    this.liveTeamModel = null
    this.liveCouncilModel = null
    this.lastCommittedTeamWave = 0
    this.teamWaveStartedAt = 0
    this.toolTailCache.clear()
    this.fleetFrameCache = null
    // mirror/dispatchCardShown 此前只增不减：mirror 每条记录 ≤50 消息 + ≤8KB openText，
    // delegate_task 每次派发新 wo_<uuid> id，长会话无界滞留（内存泄漏实测确证）。
    this.mirror.clear()
    this.dispatchCardShown.clear()
  }

  /** 工具卡 tail 切行：同一累加器字符串引用复用缓存，避免每帧全串 split。 */
  private liveToolTailLines(id: string, tail: string | undefined): string[] | undefined {
    if (!tail) return undefined
    const hit = this.toolTailCache.get(id)
    if (hit && hit.ref === tail) return hit.lines
    const trimmed = tail.replace(/\n+$/, '')
    if (!trimmed) return undefined
    const lines = trimmed.split('\n')
    this.toolTailCache.set(id, { ref: tail, lines })
    return lines
  }

  /** fleet 帧快照：version/秒桶/cols/theme 未变时整段复用；wantLines 才构建面板行。 */
  private fleetFrame(cols: number, wantLines: boolean): {
    activeWorkers: import('../fleet-registry.js').FleetWorkerView[]
    lines: string[] | null
    running: number
    unread: number
  } {
    const version = this.fleet.version
    const second = Math.floor(Date.now() / 1000)
    let hit = this.fleetFrameCache
    if (!hit || hit.version !== version || hit.second !== second || hit.cols !== cols || hit.theme !== this.theme) {
      const activeWorkers = this.fleet.getActiveWorkers()
      hit = {
        version, second, cols, theme: this.theme,
        activeWorkers, lines: null,
        running: activeWorkers.length,
        unread: this.fleet.unreadCount(),
      }
      this.fleetFrameCache = hit
    }
    if (wantLines && hit.lines === null && hit.activeWorkers.length > 0) {
      const summary = hit.activeWorkers.reduce(
        (acc, w) => {
          const p = this.fleet.getGroupProgress(w.parentToolId)
          if (!acc.seen.has(w.parentToolId)) {
            acc.seen.add(w.parentToolId)
            acc.total += p.total
            acc.done += p.done
          }
          acc.running += 1
          return acc
        },
        { total: 0, done: 0, running: 0, seen: new Set<string>() },
      )
      // 紧凑档：每 worker 恒 1 行、封顶 LIVE_FLEET_MAX，供 chrome 段的子代理带使用。
      // 完整两行树仍由 side panel / /tasks / settled 卡片承载。
      hit.lines = formatWorkerFleet(
        hit.activeWorkers,
        this.theme,
        cols,
        { done: summary.done, total: summary.total, running: summary.running },
        LIVE_FLEET_MAX,
        true,
      )
    }
    return hit
  }

  /**
   * Agent 是否在跑（可被打断的窗口）。
   * isStreaming/isThinking 只覆盖「已出 token」之后；agentBusy（submit 即 true）
   * 与 phase!=idle 还覆盖首 token 前、纯工具回合、dedup 缓冲期 —— 那些窗口同样应可打断。
   */
  private isAgentActive(): boolean {
    return this.agentBusy || this.state.isStreaming || this.state.isThinking || this.state.phase !== 'idle'
  }

  /**
   * Ctrl+V 处理：优先读剪贴板图片 → 失败则 fallback 到文本粘贴。
   * 焦点防抖：如果输入框在最近 FOCUS_DEBOUNCE_MS 内刚获得焦点，跳过剪贴板读图。
   */
  private async handleCtrlV(): Promise<void> {
    // 非 input 模式不处理（overlay / approval 等）
    if (this.input.getMode() !== 'input') return

    // 焦点防抖：overlay 关闭后短时间内 Ctrl+V 走文本路径
    if (Date.now() - this.lastInputFocusAt < FOCUS_DEBOUNCE_MS) {
      const text = await readTextFromClipboard()
      if (text) {
        this.inputLine.insertText(text)
        this.writeBatcher.schedule()
      }
      return
    }

    try {
      const result = await readImageFromClipboard()
      if (result) {
        if (this.inputLine.images.length >= MAX_IMAGES) {
          this.commitStatic(color(`⚠ 最多附加 ${MAX_IMAGES} 张图片`, this.theme.warning))
          this.renderLive()
          return
        }
        this.inputLine.addImage(result.dataUrl)
        this.writeBatcher.schedule()
        return
      }
    } catch {
      // 剪贴板读图失败，静默 fallback 到文本
    }

    // 无图或失败 → 走文本粘贴路径
    const text = await readTextFromClipboard()
    if (text) {
      this.inputLine.insertText(text)
      this.writeBatcher.schedule()
    }
  }

  private handleAbort(reason?: string): void {
    // 用户主动 abort（非 watchdog 守护）= 参与——取消倒计时自动批准
    if (!reason?.startsWith('watchdog')) this.cancelPlanAutoApprove()
    // 中断走自有回填路径（abortSettling backfill）——错误回填底料作废，防双份回填
    this.lastSubmittedText = null
    // 世代自增：被中断的旧 run 的迟到回调（bridge 捕获旧 gen）将被丢弃
    this._runGen++
    // Capture approval-blocked state BEFORE resolveApproval(false) below clears
    // it: a watchdog abort that fired while (or just after) a tool was blocked on
    // approval must not auto-continue — the resubmitted 'continue' only re-emits
    // the same approval-blocked call (deny→continue→deny self-driving loop).
    const approvalBlocked =
      !!this.approvalIntentController.approvalPending
      || (Date.now() - this._lastApprovalDeniedAt < TuiApp.APPROVAL_STALL_GRACE_MS)
    // 中断时若停在审批确认态：解析为拒绝，让 tool-pipeline 的前置 await
    // 立即 settle，并复位输入模式。否则审批态残留——后续按键被当确认解析、
    // 输入框无法使用（这是 abort 中途审批"假死"的一个分支）。
    if (this.approvalIntentController.approvalPending) { this.approvalIntentController.approvalEditMode = false; this.approvalIntentController.approvalEditError = ''; this.resolveApproval(false) }
    // Flush 工具折叠组残余
    if (this.toolGroupController.isActiveGroup()) this.flushToolGroup()
    if (this.toolGroupController.isActiveBashGroup()) this.flushBashGroup()
    // 保留 steer 队列：对齐 Ink。用户在卡死期间排队的指引不应因中断而丢失——
    // 下次 submit 会把排队内容归并进新 prompt（见 onSubmit 的 steer 收口）。
    this.streamRenderer.reset()
    this.blockWriter.discard()
    this.streamRenderController.assistantHeaderDone = false
    // 统一回收 run 本地状态（pendingTools/toolAccumulator/fleet/liveTeamModel），
    // 与 handleError 同口径，防止中断后委派工具不到终态导致 records 单调泄露。
    this.resetRunLocalState()
    this.agentBusy = false
    // 中断已发出但上一 run 的 promise 尚未 settle：AgentLoop 的 re-entry guard 在
    // 这段窗口里仍会拒绝新 run。标记它，让期间的提交走本地挂起而不是 steer 队列
    // （后者没有活跃 run 就永远 drain 不了）。notifyRunSettled 负责清除。
    // 只在 agent 确实还有 in-flight run 时才开这个窗口——没有探针（测试/非 TUI
    // 宿主）或 run 已结束时不开，提交照常走。
    this.abortSettling = this.agentRunningProbe?.() === true
    // ESC 回填资格只随用户主动中断开启：守护中断（watchdog 自动续跑 /
    // convergence 用户键入 continue）均不回填——排队消息留待下次提交归并
    //（/queue 语义，b73da5b67 契约：queue-lane.test.ts「convergence settle
    // 不回填」）。回填会破坏续跑流程：convergence 引导用户键入 continue，
    // 归并在提交时把排队消息拼进前部并计数提示；回填后 Enter 发送的将是
    // 排队消息而非 continue。
    this.abortSteerBackfill =
      this.abortSettling && !reason?.startsWith('watchdog') && !reason?.startsWith('convergence')
    // 守护中断标志：notifyRunSettled 消费——自然结束（isFinal）的回填逻辑
    // 不得误伤守护中断（watchdog 自动续跑 / convergence 键入 continue 续跑
    // 时把排队消息拉回输入框会打断续跑流程，队列留待提交归并）。
    // ?? false：reason 可选（undefined）时 startsWith 短路出 undefined。
    this.guardianAbortPending =
      (this.abortSettling && (reason?.startsWith('watchdog') || reason?.startsWith('convergence'))) ?? false
    this.state.isStreaming = false
    this.state.isThinking = false
    this.setPhase('idle')
    this.live.clear()
    // 可见的中断提示：watchdog abort → 自动恢复提示；用户中断 → 原样
    const isWatchdog = reason?.startsWith('watchdog')
    // 收敛/连续无工具硬中断：这是守护开火，不是用户中断。以往走 onAbort() 无
    // reason，显示成裸 "⏹ Interrupted"，与用户按 Esc 无法区分。给它一条带判据的
    // 标注，并**不自动续跑**（模型可能在推理，注入 continue 反而扰乱；用户可自行键入）。
    const isConvergence = reason?.startsWith('convergence')
    // Watchdog auto-continue is bounded by the shared WatchdogRecoveryPolicy
    // (consecutive cap / session-total cap / progress-aware quota). Suppression
    // conditions (approval-blocked, user draft) are caller-side here and passed
    // into the single onStall() call so message and behavior share one decision.
    const suppressForApproval = isWatchdog && approvalBlocked
    // v3 yield-to-user guard: if the input line has an unsubmitted draft, the
    // user is present and about to act — don't inject 'continue' and race them.
    const yieldToUser = isWatchdog && this.inputLine.value.trim().length > 0
    // Single decision point: the SAME StallDecision drives both the message and
    // the behavior branch below — the v3 "shows Auto-recovering but never
    // recovers" lie came from computing them separately. Suppressed/exhausted
    // stalls consume no policy state (progress carries over to the next stall).
    const decision = isWatchdog
      ? this.watchdogPolicy.onStall({ suppressed: suppressForApproval || yieldToUser })
      : null
    const shouldAutoContinue = decision?.autoContinue === true
    const sessionTotalExhausted = decision?.stopReason === 'session-total'
    const autoContinueExhausted = sessionTotalExhausted || decision?.stopReason === 'consecutive'
    const convergenceLabel = reason === 'convergence:no-tool'
      ? '⏹ 收敛守护中断：连续多轮未调用工具（如仍在推进，键入 continue 继续）'
      : '⏹ 收敛守护中断：多轮未收敛（如仍在推进，键入 continue 继续）'
    this.commitAbove(() => {
      this.commit.write({
        text: suppressForApproval
          ? color('⏹ 等待你的审批 — 该操作需批准才能继续（批准 / 调整指令 / 键入 continue）', this.theme.muted)
          : yieldToUser
            ? color('⏹ Boundary stall — 检测到你正在输入，未自动恢复（回车提交或键入 continue）', this.theme.muted)
            : shouldAutoContinue
              ? color('⟳ Auto-recovering (boundary stall)', this.theme.muted)
              : autoContinueExhausted
                ? color(sessionTotalExhausted
                    ? '⏹ Stalled repeatedly (session quota exhausted) — type to continue'
                    : '⏹ Stalled repeatedly (consecutive limit) — type to continue',
                  this.theme.muted)
                : isConvergence
                  ? color(convergenceLabel, this.theme.muted)
                  : color('⏹ Interrupted', this.theme.muted),
        trailingNewline: true,
      })
      this.state.committedCount++
    })
    // Watchdog auto-resubmit so the agent continues without waiting for the
    // user to type "continue". Cap/quota/progress bookkeeping all happened
    // inside policy.onStall() above — here we only act on its verdict.
    if (shouldAutoContinue) {
      this.onSubmitCallback?.('continue')
    }
    this.onAbortCallback?.()
  }

  // ── Rendering Pipeline ───────────────────────────────────────

  /**
   * 渲染 live region（底部动态区域）。
   *
   * Live region 结构：
   * ┌─ streaming/thinking 内容 ─┐
   * │ Approval prompt (when pending) │
   * │ GlanceBar                  │
   * │ InputLine                  │
   * └────────────────────────────┘
   */
  /** H5：thinking 行 split 结果记忆化，key = expanded 标志 + 全文。
   *  header:false 时 formatThinking 输出与 elapsedMs 无关，故仅文本/展开态变化才需重算。
   *  ticker / 批渲染帧文本未变时直接复用，消除每帧 O(n) split。主题切换经 forceRedraw 失效。 */
  private thinkingLinesMemo: { key: string; lines: string[] } | null = null

  /**
   * 输入框静态 chrome 缓存：leftBar / rightBar / botBorder 只依赖
   * (separator, innerWidth, borderColor)，与输入文本、光标、GlanceBar 指标无关。
   * renderLive 每帧重建这些边框是纯重复工作（含 `chars.h.repeat(innerWidth+2)`
   * 这类 O(cols) 字符串构造）；按三元 key 缓存后，稳态帧（idle / 光标移动）直接命中。
   * 着色用 color() 包装，结果确定性，不引入渲染状态耦合。
   */
  private inputChromeMemo: {
    key: string
    leftBar: string
    rightBar: string
    botBorder: string
  } | null = null

  private getInputChrome(
    separator: string,
    innerWidth: number,
    borderColor: string,
  ): { leftBar: string; rightBar: string; botBorder: string } {
    const key = `${separator}|${innerWidth}|${borderColor}`
    if (this.inputChromeMemo?.key === key) return this.inputChromeMemo
    const chars = boxCharsFor(separator)
    const leftBar = color(chars.v + ' ', borderColor)
    const rightBar = color(' ' + chars.v, borderColor)
    const botBorder = color(`${chars.bl}${chars.h.repeat(innerWidth + 2)}${chars.br}`, borderColor)
    this.inputChromeMemo = { key, leftBar, rightBar, botBorder }
    return { leftBar, rightBar, botBorder }
  }

  private getActiveDomainId(): string | undefined {
    if (!this.state.domainName) return undefined
    return starDomainRegistry.list().find(d => d.name === this.state.domainName || d.id === this.state.domainName)?.id
  }

  /**
   * 推理区显示行预算，随终端高度缩放（矮窗口给得更少）。
   *
   * 按显示行而非逻辑行封顶：推理文本多是长句，窄终端上一个逻辑行 wrap 成三四行，
   * 逐字增长时它是动态段里最大的单块，峰值会被定高视口固化成常驻空白。
   * 小屏收缩策略与理由见 thinkingRowBudgetFor（live-engine.ts）。
   */
  private thinkingRowBudget(): number {
    return thinkingRowBudgetFor(this.rows, this.state.phase, THINKING_ROWS_MAX)
  }

  private getThinkingLines(expanded: boolean): string[] {
    const text = this.state.thinkingText
    const domainId = this.getActiveDomainId()
    const maxRows = this.thinkingRowBudget()
    const cols = this.columns
    // 尺寸进 memo key：resize 改变 wrap 后的行数，旧结果不能复用。
    const key = `${expanded ? '1' : '0'}\u0000${domainId ?? ''}\u0000${maxRows}\u0000${cols}\u0000${text}`
    if (this.thinkingLinesMemo?.key === key) return this.thinkingLinesMemo.lines
    const computed = formatThinking({
      text,
      elapsedMs: Date.now() - this.state.thinkStartMs,
      header: false,
      expanded,
      domainId,
      maxRows,
      columns: cols,
    }, this.theme)
    this.thinkingLinesMemo = { key, lines: computed }
    return computed
  }

  /** ambiguous 宽度模式缓存（与 LiveEngine.ambiguousWide 同口径，进程内基本不变）。 */
  private ambiguousWideCache: boolean | null = null

  /**
   * 单行 display rows 度量（wrapping-aware），与 LiveEngine.rowsForLine 同口径——
   * 定高视口的行数预算必须与引擎实际渲染行数一致，否则垫行后总高度仍会漂移。
   */
  private displayRowsFor(text: string, width: number): number {
    this.ambiguousWideCache ??= ambiguousWideEnabled()
    if (width <= 0) return 1
    const dw = displayWidth(text, { ambiguousAsWide: this.ambiguousWideCache })
    if (dw === 0) return 1
    return Math.ceil(dw / width)
  }

  /**
   * 动态区高度预算（display rows）。renderLive 把动态段垫高/截断到恰好该值。
   *
   * 高水位记的是 **live region 总高度**（动态 + chrome），不是只记动态段。
   * slash 提示、权限行、todo 面板都在 chrome：只钉动态段时，chrome 一关总高度
   * 就掉，输入框上跳——用户看到「有时贴底、有时又浮起来」。chrome 关掉后用
   * 动态垫行补差额，总高度只涨不缩，输入框屏幕坐标才稳。
   *
   * 封顶 `liveMaxRowsFor`（与 LiveEngine.maxRows 同口径）。不再额外减 2：
   * 那 2 行会在 visor 贴满时变成输入框底下的黑洞。
   *
   * 高度一旦缩小，相对定位下就是输入框上跳——`clearForCommit` 按旧高度擦到屏末，
   * 写回的 commit 正文 + 新 region 填不满，差额留成屏底黑洞。而空闲期动态内容
   * 本就归零（thinking / 工具卡 / 子代理面板全部退场），预算若跟着归零，落差就
   * 等于本轮动态内容的峰值：实测 40 行终端达 20+ 行，输入框每轮在屏底与屏幕中部
   * 之间往返一次。反过来空闲期按 ceiling 恒垫满（更早的实现）也只是把这一跳挪到
   * 下一轮提交时刻，同样弹，且把刚提交的正文顶出可视区。
   *
   * 代价：稳态下输入框上方保留「本会话用过的最大 live 高度」那么多空白，它是下一轮
   * 的预留位——内容到来时原地填入、输入框不动，正是定高视口要买的东西。不跳与
   * 空白是同一件事的两面：高度恒定 ⟺ 空白 = 峰值 − 当前内容，两者都要就只能把
   * 峰值本身压小（进行中工具卡每个占「标题 + 末 3 行输出」，并发几个就二十行）。
   *
   * 曾试过给垫高加一道小上限（8 行）以省空白，超限内容按实际高度走：常规轮次确实
   * 稳，但工具密集时峰值 20+ 行远超上限，每次工具起落照样弹一次。上限对不上峰值
   * 就等于没有，故取消——压峰值的活见
   * docs/plans/2026-08-03-tui-subagent-workflow-display-cc-parity.md。
   *
   * turn 0 欢迎首帧仍返回 0：尚未开过 slash、高水位也是 0 时不垫——欢迎屏与
   * 输入框之间凭空空白比自然流难看。一旦 slash 菜单/提示入场（或高水位已抬），
   * 与 tianshu-public 同口径：抬高水位并用垫行吸收开合差额，输入框下落一次后
   * 钉住，取消命令不再弹回。
   */
  private getDynamicBudget(chromeRows: number, dynamicRows: number): number {
    const welcomeIdle = this.state.phase === 'idle' && this.state.turnNumber === 0
    const slashOverlay = this.inputController.slashMenu.open || this.inputLine.value.startsWith('/')
    if (welcomeIdle && this.liveRowsHighWater === 0 && !slashOverlay) return 0
    // 矮屏（<24 行，手机软键盘展开的典型形态）把高水位预留压到半屏——整屏
    // 空白比输入框弹跳更伤；常规桌面高度维持原 cap（28 行封顶）不变。
    const rows = this.rows || 24
    const cap = rows < 24
      ? Math.min(liveMaxRowsFor(rows), Math.ceil(rows / 2))
      : liveMaxRowsFor(rows)
    const total = dynamicRows + chromeRows
    this.liveRowsHighWater = Math.min(cap, Math.max(this.liveRowsHighWater, total))
    return Math.max(0, this.liveRowsHighWater - chromeRows)
  }

  /**
   * live region 总高度高水位（display rows = 动态 + chrome），跨轮保留。
   * 曾在 `setPhase('idle')` 归零以免「一次长 thinking 把之后每轮都垫高」，
   * 但归零即高度回缩，而回缩就是输入框上跳——空白换稳定是这里刻意做的取舍。
   */
  private liveRowsHighWater = 0

  /**
   * @file 节点 exists 诊断（按输入值缓存——同值不重复 existsSync）。
   * 返回第一个不存在的 @file:/@folder: 引用值；无引用或均存在时 null。
   */
  private mentionDiagCache: { value: string; missing: string | null } = { value: '', missing: null }
  private computeMissingMention(inputVal: string): string | null {
    if (this.mentionDiagCache.value === inputVal) return this.mentionDiagCache.missing
    const missing = this.computeMissingMentionPaths(inputVal)[0] ?? null
    this.mentionDiagCache = { value: inputVal, missing }
    return missing
  }

  /**
   * 把「逻辑上应占单行」的动态 live 元素钳制到终端宽度内。
   *
   * 用 ambiguousAsWide 上界度量截断（box/block 仍按 1 列）：保证即便终端把
   * `—`/`…`/`↑↓`/`·` 等 ambiguous 符号按 2 列渲染，该行也不会换行——否则
   * LiveEngine.rowsForLine（按 string-width 窄计）低估行数 → 回顶欠擦 → 旧帧
   * 顶框泄漏进 scrollback（输入框重影）。多行内容（流式 tail/思考/工具卡片）
   * 是有意换行的，不走此钳制。
   */
  private clampLine(text: string, maxWidth = this.columns): string {
    // 留 1 列余量：吸收 get-east-asian-width 判为 neutral、但个别 CJK 终端仍按 2 列
    // 渲染的几何符（如 ◧）带来的 +1 残余误差。
    return truncateToDisplayWidth(text, Math.max(1, maxWidth - 1), { ambiguousAsWide: true })
  }

  /**
   * 构造输入框的一行（左右竖边框 + 内容 + padding 到 innerWidth）。
   *
   * 与 clampLine 同口径（wide 上界）：截断与 padding 都按 ambiguousAsWide 度量，
   * 保证含 `— … · → ↑ ↓` 等 East-Asian Ambiguous 符号的输入行在 CJK 终端
   * （这些符号按 2 列渲染）也严格 ≤ columns → 不折行 → rowsForLine 计数正确，
   * 避免 fullRewrite 回顶欠擦导致的输入框重影（paste / 历史导航）。
   * box-drawing（│）恒按 1 列（width.ts isBoxOrBlock），不受影响。
   */
  private renderInputRow(content: string, innerWidth: number, leftBar: string, rightBar: string): string {
    const opts = { ambiguousAsWide: true }
    const truncated = truncateToDisplayWidth(content, innerWidth, opts)
    const pad = Math.max(0, innerWidth - displayWidth(truncated, opts))
    return `${leftBar}${truncated}${' '.repeat(pad)}${rightBar}`
  }

  /** 渲染一条全宽反色提示条（用于审批/意图框顶部隔离）。 */
  private renderBanner(text: string, bgColor: string, fgColor: string = '#000000', width = this.columns): string {
    const label = ` ${text} `
    const labelWidth = stringWidth(label)
    const maxWidth = Math.max(1, width - 1)
    const padWidth = Math.max(0, maxWidth - labelWidth)
    return `${bg(bgColor)}${fg(fgColor)}${label}${' '.repeat(padWidth)}\x1B[0m`
  }

  private mergeSidePanel(lines: LiveRegionLine[], panelLines: string[], contentCols: number, panelWidth: number): LiveRegionLine[] {
    const merged: LiveRegionLine[] = []
    const totalRows = Math.max(lines.length, panelLines.length)
    const RESET = '\x1B[0m'
    for (let i = 0; i < totalRows; i++) {
      const mainRaw = lines[i]?.text ?? ''
      const mainTrunc = truncateToDisplayWidth(mainRaw, contentCols, { ambiguousAsWide: true })
      const mainPad = Math.max(0, contentCols - displayWidth(mainTrunc, { ambiguousAsWide: true }))
      const panelRaw = panelLines[i] ?? ''
      const panelPad = panelRaw ? '' : ' '.repeat(panelWidth)
      merged.push({ text: `${mainTrunc}${RESET}${' '.repeat(mainPad)}${panelRaw}${panelPad}` })
    }
    return merged
  }

  private renderLive(): void {
    if (this.suppressCommitRender) {
      this.deferredCommitRender = true
      return
    }
    // 输出冻结期：live region 任何重绘都是光标寻址写入，会把触摸终端的
    // scrollback 视口拽回底部。数据照常缓冲，解冻后统一重绘。
    if (this.outputFrozen) return
    // start() 之前所有 setter / 用户输入回调都不应触发真正的 stdout 输出。
    // 构造后到 main.ts 清屏写欢迎屏之间若渲染一版输入框，旧帧可能残留在
    // 欢迎屏上方形成重影；统一在 start() 置 started=true 后才开始绘制。
    if (!this.started) return
    // 同步终端实际尺寸：ResizeHandler 的 resize 回调有 150ms debounce，
    // 在 debounce 窗口内 stdout.columns/rows 已变而 this.columns/rows 仍是旧值。
    // 若此时触发渲染，renderLiveImpl 按旧宽布局而 LiveEngine 按 stdout 新宽估算
    // 显示行数，回顶量错误 → 输入框漂移/重影。这里用 stdout 最新值统一口径。
    const latestCols = this.stdout.columns
    const latestRows = this.stdout.rows
    if (latestCols && latestRows) {
      if (this.columns !== latestCols || this.rows !== latestRows) {
        this.columns = latestCols
        this.rows = latestRows
        this.live.setMaxRows(liveMaxRowsFor(this.rows))
      }
    }
    if (this.perfMonitor?.enabled) {
      this.perfMonitor.measure('renderLive', () => this.renderLiveImpl())
    } else {
      this.renderLiveImpl()
    }
  }

  /** live overlay 节流重绘：仅 tasks/cockpit 等监控型，≥400ms 一次。
   *  覆盖层引擎自带行级 diff，数据无变化时终端零写入，故 tick/事件驱动都走这里。 */
  private rerenderLiveOverlayThrottled(): void {
    const id = this.overlay.activeId()
    if (!id || !TuiApp.LIVE_OVERLAY_IDS.has(id)) return
    const now = Date.now()
    if (now - this.liveOverlayLastRender < 400) return
    this.liveOverlayLastRender = now
    this.overlay.rerender()
  }

  private renderLiveImpl(): void {
    // 全屏覆盖层（命令面板 / splash / 详情页）激活时，Live 区域由覆盖层引擎
    // 负责渲染，避免再次绘制内容产生右下角残留。
    if (this.overlay.isActive()) {
      // 监控型 overlay（/tasks、cockpit）：把渲染驱动转交给覆盖层——否则
      // 打开期间 worker 推进/指标变化都不会重绘，用户看到的是打开瞬间的快照。
      this.rerenderLiveOverlayThrottled()
      return
    }

    const sidePanelWidth = this.state.sidePanelOpen ? resolveSidePanelWidth(this.columns) : 0
    const showSidePanel = sidePanelWidth > 0
    const contentCols = this.columns - sidePanelWidth
    // 局部 cols：侧栏展开时用压缩后的主区宽度，否则用原始终端宽度。
    // 不改写 this.columns，避免异步回调读到临时值。
    const cols = showSidePanel ? contentCols : this.columns

    // Metrics 供 side panel 与 GlanceBar 共享，提前计算。
    const metrics = this.metricsGlanceController.metricsProvider?.() ?? null
    let glanceCacheHitRate: number | undefined
    let glanceCacheStatus: CacheStatus | undefined
    let glanceContextRatio: number | undefined
    let glanceCost: number
    let glanceEstimatedTokens: number | undefined
    let glanceConversationTokens: number | undefined
    let glanceMaxTokens: number | undefined
    let glancePricingPhase: 'peak' | 'offpeak' | undefined
    if (metrics) {
      glanceCacheHitRate = metrics.cacheHitRate ?? undefined
      glanceCacheStatus = metrics.cacheStatus
      glanceContextRatio = metrics.maxTokens > 0 ? Math.min(1, metrics.estimatedTokens / metrics.maxTokens) : undefined
      glanceCost = metrics.cost
      glanceEstimatedTokens = metrics.estimatedTokens
      glanceConversationTokens = metrics.conversationTokens
      glanceMaxTokens = metrics.maxTokens
      glancePricingPhase = metrics.pricingPhase
    } else {
      glanceCacheHitRate = this.metricsGlanceController.lastCacheHitRate
      glanceContextRatio = this.metricsGlanceController.lastContextRatio
      glanceCost = this.estimateSessionCost()
    }

    // 实时状态快照：goal / plan-mode / plan-trace / todo-summary
    const goalSnapshot = (() => {
      try {
        const gt = this.goalTrackerProvider?.()
        if (gt && gt.getStatus() !== 'complete') {
          const verdict = gt.getLastVerdict()
          return {
            active: gt.getStatus() === 'active',
            status: gt.getStatus(),
            goal: gt.getGoal(),
            iteration: gt.getIteration(),
            maxIterations: gt.getMaxIterations(),
            elapsedMs: gt.getWallClockElapsedMs(),
            wallClockBudgetMs: gt.getWallClockBudgetMs(),
            criteria: gt.getSuccessCriteria(),
            criteriaMet: verdict?.criteriaMet,
            criteriaUnmet: verdict?.criteriaUnmet,
            criteriaTotal: verdict?.criteriaTotal,
          }
        }
      } catch { /* provider 失败不应中断渲染 */ }
      return undefined
    })()
    const planModeActive = (() => {
      try { return this.planModeProvider?.() ?? false } catch { return false }
    })()
    const askModeActive = (() => {
      try { return this.askModeProvider?.() ?? false } catch { return false }
    })()
    const planTrace = (() => {
      try { return this.planTraceProvider?.() ?? null } catch { return null }
    })()
    const todoSummary = (() => {
      const t = this.state.todos
      const total = t.length
      if (total === 0) return undefined
      // 跨 run 陈旧 gate（同 shouldShowTaskPanel）：全完成 + 本 run 未写 →
      // 徽章不显示，避免旧 5/5 复活挂在新 run 头上冒充当前进度。
      if (!this.todosWrittenThisRun && t.every(x => x.status === 'completed')) return undefined
      return {
        total,
        done: t.filter(x => x.status === 'completed').length,
        inProgress: t.filter(x => x.status === 'in_progress').length,
        current: t.find(x => x.status === 'in_progress')?.content,
      }
    })()

    let lines: LiveRegionLine[] = []
    lines = []

    // 子代理舰队带（紧凑档，每 worker 1 行），在动态段计算、在 chrome 段落位——
    // 放 chrome 才不吃动态段预算、不撑高水位（见 2b2 与 chromeStart 之后的 push）。
    let fleetStatusLines: string[] = []

    // 1. Spinner 状态行（⠋ Thinking… (12s · esc to interrupt)），10s 无 token 变琥珀。
    //    审批挂起时如实显示「等待审批 <tool> · Ns」——等待的是用户决定，不是模型。
    const approvalWaiting = this.approvalIntentController.approvalPending
    // job(await) 挂起：等待区如实显示在等哪个后台任务、已等/上限多久（动词池
    // 不轮换——「琢磨中 8m11s」式冒充模型活动是本分支根修的撒谎）。优先级
    // 低于 approvalWait（等用户决定最优先），高于通用 spinner/stale 分档。
    const jobAwaiting = approvalWaiting ? null : this.jobAwaitPending()
    const stalled = this.streamRenderController.lastActivityMs > 0 && Date.now() - this.streamRenderController.lastActivityMs > 10_000
    const spinnerLine = jobAwaiting ? null : formatSpinnerStatus({
      tick: this.streamRenderController.tick,
      phase: this.state.phase,
      elapsedMs: Date.now() - this.state.turnStartMs,
      stalled: stalled && !approvalWaiting,
      ...(approvalWaiting ? {
        approvalWait: { toolName: approvalWaiting.name, waitMs: Date.now() - approvalWaiting.startMs },
      } : {}),
    }, this.theme)
    if (jobAwaiting) {
      const row = jobAwaiting.jobId ? this.jobsModel.get(jobAwaiting.jobId) : undefined
      const view = formatJobAwaitWait(jobAwaiting, row, Date.now())
      lines.push({ text: this.clampLine(color(view.line, this.theme.warning)) })
      if (view.detail) lines.push({ text: this.clampLine(color(`  ${view.detail}`, this.theme.muted)) })
    } else if (spinnerLine) {
      // spinner 行含 …/·（East-Asian Ambiguous），CJK 终端按 2 列渲染 → 长行会折行而
      // rowsForLine 低估 → 重影。clampLine 用 wide 上界截断到 columns-1，保证不折行。
      lines.push({ text: this.clampLine(spinnerLine) })
      // 分档等待提示：spinner 只说「还在转」，这行说「卡在哪个阶段、多久了、能做什么」。
      // 审批挂起时必须换成审批专属口径——原分档到 action 档会说「No response —
      // Ctrl+C to interrupt」，明明在等用户按 y/n 却引导用户杀会话（2d8b67ca 事故
      // 的观感来源：审批 await 无超时 + 看门狗 disarm，卡住的表象=失去响应）。
      if (approvalWaiting) {
        const waitMs = Date.now() - approvalWaiting.startMs
        if (waitMs >= 60_000) {
          lines.push({ text: this.clampLine(color(
            `  审批等待不会超时 — 会话已暂停，等你决定（Enter/y 批准 · Esc/n 拒绝）`,
            this.theme.muted,
          )) })
        }
      } else {
        const silentMs = this.streamRenderController.lastActivityMs > 0
          ? Date.now() - this.streamRenderController.lastActivityMs
          : 0
        const stale = silentMs > 0 ? getPhaseStaleMessage(this.state.phase, silentMs) : null
        if (stale) {
          const staleColor = stale.level === 'action' ? this.theme.error
            : stale.level === 'warn' ? this.theme.warning
            : this.theme.muted
          lines.push({ text: this.clampLine(color(`  ${stale.message}`, staleColor)) })
        }
      }
    }

    // 1c. Worker 切入视图（CC teammate 对标）：激活时替换主视图全部动态段
    //     （thinking / 流式尾 / 舰队汇总 / 工具聚合），只渲染该 worker 的
    //     镜像消息 tail + header。底部 chrome（输入框/GlanceBar）不变。
    const viewingWorker = this.viewingWorkerId ? this.fleet.getWorkerById(this.viewingWorkerId) : undefined
    if (viewingWorker) {
      const viewRows = Math.max(6, liveMaxRowsFor(this.rows) - 6)
      for (const line of formatWorkerView(viewingWorker, this.mirror.getMessages(viewingWorker.workerId), this.theme, cols, viewRows)) {
        lines.push({ text: this.clampLine(line) })
      }
    } else {
    // ↓ 主视图动态段（1b–2d；worker 视图激活时整段跳过）

    // 1b. Thinking 展开内容（状态行已由 spinner 承担）。split 结果记忆化见 getThinkingLines。
    if (this.state.isThinking && this.state.thinkingText) {
      for (const line of this.getThinkingLines(this.state.thinkingExpanded)) {
        lines.push({ text: line })
      }
    }

    // 2. Streaming tail (尾部不完整 markdown block，display-width aware 截断)
    //    额外拼接 blockWriter.peek()——尚未吐块的最新 token，逐字可见（打字机节奏）。
    for (const line of this.streamRenderer.getLiveTailLines(6, this.blockWriter.peek())) {
      lines.push({ text: line })
    }

    // 2b. 队列预览已下移到输入框 chrome（贴底，不夹在 thinking/工具卡之间）。

    // 2b2. 活动源归一：fleet / council / team / todo 四源 + jobs 投影到
    //      ActivityStore，经 formatActivityBand 输出 chrome 段统一活动带
    //      （running 扁平行 / 最新 ⎿ / /tasks 尾行；对标 dsh-tui）。
    // 宽屏时这些汇总信息已移到右侧 side panel，避免主区重复。
    // jobs 快照每帧刷新（elapsed 现算）；窄屏并进 band，宽屏退回 jobs 单行条。
    this.activityStore.setJobs(this.jobsModel.rows(), Date.now())
    if (!showSidePanel) {
      // todo 刻意不进 band：chrome 段下方的 formatTaskList 常驻任务面板已经承载
      // 它们（带进度条 / completed 折叠 / ctrl+x t 展开），band 再画一遍就是同一
      // 批待办显示两次。模型层的 projectTodo 保留，供别的消费方按需归一。
      // 走 fleetFrame（wantLines=false）而非直接 getActiveWorkers：前者有
      // version/second/cols/theme 四维缓存，后者每帧重做一遍 toView 投影。
      this.activityStore.setFleet(this.fleetFrame(cols, false).activeWorkers)
      this.activityStore.setCouncil(this.liveCouncilModel)
      this.activityStore.setTeam(this.liveTeamModel ? this.teamModelWithLiveStatus(this.liveTeamModel) : null)
      this.activityStore.setTodo([])
      const bandItems = [
        ...this.activityStore.project(),
        ...this.activityStore.projectJobs(),
      ]
      // width 必须传实际列数：默认 80 会在窄终端上折行，而 rowsForLine 按未折算，
      // 欠擦的旧帧顶部会被后续 commit 顶进 scrollback（输入框重影）。
      fleetStatusLines = formatActivityBand(bandItems, this.theme, {
        maxRows: LIVE_FLEET_MAX,
        width: cols,
        tick: this.streamRenderController.tick,
        ascii: useAsciiGlyphs(),
      })
      if (fleetStatusLines.length === 0) {
        // 回退：派发已发出但首条 worker activity 未上行的窗口期，band 还是空的，
        // 而工具确实在跑——不给 pill 会是一片空白。
        const delegationTools = [...this.toolGroupController.getPendingEntries()]
          .filter(([, meta]) => isDelegationTool(meta.name))
        if (delegationTools.length > 0) {
          const pills = delegationTools.map(([, meta]) => {
            const elapsed = Date.now() - meta.startMs
            const elapsedStr = elapsed > 1000 ? `${(elapsed / 1000).toFixed(0)}s` : `${elapsed}ms`
            const approvalBadge = meta._approvalMode === 'dangerously-skip-permissions'
              ? color('[auto]', this.theme.success)
              : color('[ask]', this.theme.warning)
            const profile = delegationProfileFromInput(meta.name, meta.input)
            return `${domainBadge(meta.name)?.glyph ?? '◆'} ${profile} ${color(elapsedStr, this.theme.muted)} ${approvalBadge}`
          })
          fleetStatusLines = [this.clampLine(` ${pills.join('  ')}`)]
        }
      }
    }

    // 2c. Collapsible 探索工具聚合行（避免 read×5 + grep×3 刷屏 live 区）
    if (this.toolGroupController.isActiveGroup()) {
      const activeGroup = this.toolGroupController.getActiveGroup()
      if (activeGroup && activeGroup.entries.length > 0) {
        const groupLines = formatCollapsedGroupLive(activeGroup, this.theme, cols)
        for (const line of groupLines) {
          lines.push({ text: line })
        }
      }
    }

    // 2c-bis. 可折叠 bash 聚合行
    if (this.toolGroupController.isActiveBashGroup()) {
      const activeBashGroup = this.toolGroupController.getActiveBashGroup()
      if (activeBashGroup && activeBashGroup.entries.length > 0) {
        const groupLines = formatCollapsedBashGroupLive(activeBashGroup, this.theme, cols)
        for (const line of groupLines) {
          lines.push({ text: line })
        }
      }
    }

    // 2d. 进行中非 collapsible 工具。
    //
    // 只有最新一张卡展开末 3 行输出，其余压成单标题行，并整体封顶——每张卡
    // 4 行 × 无上限并发是动态段峰值的最大来源（4 个工具就 16 行），而高度峰值
    // 会经定高视口的高水位固化成输入框上方的常驻空白。较早的工具通常已在滚动
    // 输出，看最新那张就够；全部详情随工具完成 commit 进 scrollback。
    if (this.toolGroupController.getPendingSize() > 0) {
      const visible: Array<[string, PendingToolMeta]> = []
      for (const [id, meta] of this.toolGroupController.getPendingEntries()) {
        // 跳过已归入折叠组的 collapsible 工具（它们在 2c 聚合行中显示）
        if (isCollapsibleTool(meta.name)) continue
        // 跳过已归入 bash 折叠组的 bash 工具
        if (meta.name === 'bash' && this.toolGroupController.hasBashEntry(id)) continue
        visible.push([id, meta])
      }
      const overflow = Math.max(0, visible.length - LIVE_TOOL_CARD_MAX)
      // 保留最近的若干张：正在跑的工具里，新起的那些信息量更大。
      const shown = overflow > 0 ? visible.slice(-LIVE_TOOL_CARD_MAX) : visible
      for (const [i, [id, meta]] of shown.entries()) {
        const accTail = this.toolGroupController.getAccumulated(id)
        const toolLines = formatToolCardLive({
          toolName: meta.name,
          toolInput: meta.input,
          outputTail: accTail,
          outputTailLines: this.liveToolTailLines(id, accTail),
          elapsedMs: Date.now() - meta.startMs,
          columns: cols,
          tick: this.streamRenderController.tick,
          tailLines: i === shown.length - 1 ? 3 : 0,
        }, this.theme)
        for (const line of toolLines) {
          lines.push({ text: line })
        }
      }
      if (overflow > 0) {
        lines.push({ text: this.clampLine(color(` └─ …(+${overflow}) 个工具进行中`, this.theme.muted)) })
      }
    }

    } // ← 主视图动态段结束（1b–2d；与上方 worker 视图分支对应）

    // 3. Approval prompt (when pending)
    //
    // gateStart：审批提示与 Mission Contract 预览是仅有的两块「不投票就出不了
    // 门」的纯本地 UI。读屏档下动态段整体出局（下方 slice），它们必须随
    // chrome 段留下——SR 档没有 120ms 重绘（renderTicker 已停），chrome 只在
    // 真实变化时写屏，不会引发读屏复读。
    const gateStart = lines.length
    if (this.approvalIntentController.approvalPending) {
      const p = this.approvalIntentController.approvalPending
      const keyHint = (key: string, label: string) =>
        `${color('[', this.theme.secondary)}${color(key, this.theme.secondary, { bold: true })}${color(`] ${label}`, this.theme.secondary)}`
      if (this.approvalIntentController.approvalEditMode) {
        // Edit mode: show edit header, InputLine contains the JSON
        lines.push({ text: '' })
        lines.push({ text: this.clampLine(this.renderBanner('EDIT TOOL INPUT', this.theme.warning)) })
        lines.push({ text: this.clampLine(` │ Tool: ${p.name}`) })
        if (this.approvalIntentController.approvalEditError) {
          lines.push({ text: this.clampLine(` │ ${color(`⚠ ${this.approvalIntentController.approvalEditError}`, this.theme.warning)}`) })
        }
        lines.push({ text: this.clampLine(` │ Edit the JSON below, then Enter to confirm:`) })
        lines.push({ text: this.clampLine(` ╰─ ${keyHint('Enter', 'confirm')}  ${keyHint('Esc', 'back')}  ${keyHint('Ctrl+C', 'deny')} ─────────`) })
      } else {
        const promptLines = formatApprovalPrompt({
          toolName: p.name,
          input: p.input,
          columns: cols,
          selectedIndex: this.approvalIntentController.approvalOptionIndex,
          risk: this.approvalIntentController.riskExplanation,
          riskPending: this.approvalIntentController.riskExplainPending,
          riskError: this.approvalIntentController.riskExplainError,
          rememberOption: this.approvalIntentController.showRememberOption,
        }, this.theme)
        lines.push({ text: '' })
        for (const promptLine of promptLines) {
          lines.push({ text: this.clampLine(promptLine) })
        }
      }
    }

    // ── Mission Contract 预览卡（inline，与审批提示同位）────────────────
    if (this.contractPreview) {
      const p = this.contractPreview
      const cardLines = formatContractPreview({
        draft: p.draft,
        charCount: p.text.length,
        imageCount: p.images?.length ?? 0,
        missingPaths: this.computeMissingMentionPaths(p.text),
        cols,
      }, this.theme, color)
      lines.push({ text: '' })
      for (const cardLine of cardLines) {
        lines.push({ text: this.clampLine(cardLine) })
      }
    }

    // ── 底部 chrome 起点：从此往后（任务面板 + GlanceBar + 输入框 + 提示）是
    //    恒可见的保留区，内容超屏时 LiveEngine 截断的是上方 dynamic 段，
    //    不会裁掉任务面板与输入框。读屏档把门禁段（审批 + Mission Contract）
    //    一并并入 chrome——否则动态段出局时这两块纯本地 UI 被静默切掉。
    let chromeStart = this.screenReader ? gateStart : lines.length

    // 3a2. 子代理带（dsh activity-band：running 扁平行 + 最新 ⎿ + /tasks 尾行）。
    //     放在 chrome 段而非动态段——舰队规模不该转化成输入框上方的常驻空白。
    if (fleetStatusLines.length > 0) {
      const bandHasEntry = fleetStatusLines.some(line => line.includes('/tasks'))
      for (const [i, line] of fleetStatusLines.entries()) {
        const extra = !bandHasEntry && i === 0 ? color('  · /tasks 管理', this.theme.dim) : ''
        lines.push({ text: this.clampLine(`${line}${extra}`) })
      }
    }

    // 3a3. 后台任务：窄屏已并进活动带（与子代理同一计数头）。宽屏侧栏不画
    //     band，退回单行 `⚙ N 后台任务 · 首个命令 · 最长已跑`。
    const jobsInBand = !showSidePanel && this.activityStore.projectJobs().length > 0
    const jobsBar = jobsInBand ? null : formatJobsBar(this.activityStore.projectJobs(), this.theme)
    if (jobsBar) {
      lines.push({ text: this.clampLine(jobsBar) })
    }

    // 3b. 常驻任务面板（todo 列表）——空列表不渲染；run 空闲且全部完成时隐藏
    //    （shouldShowTaskPanel；todoExpanded 展开态强制显示以回看 completed）。
    //    宽屏时已由 side panel 承载。
    if (!showSidePanel && this.state.todos.length > 0 && (this.state.todoExpanded || shouldShowTaskPanel(this.state.todos, this.state.phase, !this.todosWrittenThisRun))) {
      const taskLines = formatTaskList(this.state.todos, this.theme, {
        width: cols,
        maxRows: this.state.todoExpanded ? 15 : 6,
        showProgressBar: false,
        expanded: this.state.todoExpanded,
        expandHint: this.state.todoExpanded ? 'ctrl+x t 收起' : undefined,
        tick: this.streamRenderController.tick,
        ascii: useAsciiGlyphs(),
      })
      if (taskLines.length > 0) {
        lines.push({ text: '' })
        // 面板行走 clampLine（与其余 chrome 同口径）：满列行会在 CJK 终端折行，
        // rowsForLine 少算导致旧帧残留被提交进 scrollback。
        for (const taskLine of taskLines) lines.push({ text: this.clampLine(taskLine) })
        lines.push({ text: '' })
      }
    }

    // 3c. 计划审阅卡钉在输入框上方（对标 public plan-review chrome，不进 overlay）。
    if (this.pendingPlanApproval && !this.overlay.isActive()) {
      const countdown = this.planAutoApproveRemainSec
      // 审批卡边框与输入框同族——同一 separator 风格，两个框上下叠放才成一套 chrome
      const activeDomainId2 = this.state.domainName ? Object.keys(STAR_DOMAINS).find(k => (STAR_DOMAINS as any)[k].name === this.state.domainName) : null
      const reviewLines = formatPlanReview({
        title: this.pendingPlanApproval.title,
        ...(this.planApprovalDate ? { date: this.planApprovalDate } : {}),
        separator: (activeDomainId2 ? (STAR_DOMAINS as any)[activeDomainId2]?.uiPersona?.separator : undefined) ?? 'thin',
        body: this.planApprovalBody ?? '',
        scroll: this.planReviewScroll,
        width: cols,
        bodyRows: planReviewBodyRows(this.rows || 24),
        ...(countdown !== undefined
          ? { countdown: `Goal 模式：${countdown}s 后自动批准（批准/驳回即取消；Esc 收起不取消）` }
          : {}),
        actions: buildPlanReviewActions(this.pendingPlanApproval),
        feedbackMode: this.planReviewFeedbackMode,
      }, this.theme)
      if (reviewLines.length > 0) {
        lines.push({ text: '' })
        for (const line of reviewLines) lines.push({ text: this.clampLine(line) })
        lines.push({ text: '' })
      }
    }

    // 4. GlanceBar（context% / cache / cost / git branch） metrics 已在顶部计算，
    //    与 side panel 共享同一份 glanceCacheHitRate / glanceEstimatedTokens / glanceCost。

    // 4b. 可脚本化 statusline（ui.statusLine.command）——输入框上方独立行。
    if (this.statusLineText) {
      lines.push({ text: this.clampLine(color(this.statusLineText, this.theme.muted)) })
    }
    if (this.perfMonitor?.enabled) {
      const lag = this.perfMonitor.getLoopLagWindow()
      lines.push({
        text: this.clampLine(color(`perf loop p99 ${lag.p99Ms}ms · max ${lag.maxMs}ms`, this.theme.muted)),
      })
    }

    // 5. Input line / Ctrl+C hint（多行输入：每行单独 push）
    // 渲染防御：输入框有内容时永远显示输入框——提示行只在空输入时取代它，
    // 兜住一切未取消 pending 的漏网路径（粘贴竞态等），杜绝幽灵输入。
    // 5. Input line / Ctrl+C 退出确认提示（对齐 Claude Code）：提示行叠加在
    // 输入框上方，输入框与内容始终渲染——不存在「输入框消失」的困惑。
    if (this.inputController.ctrlCPendingSince > 0) {
      lines.push({ text: color('再次按 Ctrl+C 退出 · Esc 或输入即取消', this.theme.muted) })
      lines.push({ text: '' })
    }
    { // 输入框渲染（原 else 主体；提示行在场时与其并存）
      const inputVal = this.inputLine.value
      const isSlash = inputVal.startsWith('/') && !inputVal.includes('\n') && !looksLikeFilePath(inputVal, this.getCommandPredicate(), this.getCommandPrefixPredicate())
      const isStreaming = this.state.phase !== 'idle'

      // 边框三态：slash=primary（激活态）、streaming=muted、静息=dim。
      // chrome 后退但须可见——pulseQuiet 在深底上近乎隐形（实测回归），曾用于
      // streaming 档，agent 一回复整个输入框就「消失」；streaming 改用 muted
      // 保持可读层次：primary > muted > dim。星域个性由顶框标签的 glyph/名称色
      // 与 separator 承载。
      const borderColor = isSlash ? this.theme.primary
        : isStreaming ? this.theme.muted
        : this.theme.dim

      // 1. 获取当前生效星域的 Persona
      const activeDomainId = this.state.domainName ? Object.keys(STAR_DOMAINS).find(k => (STAR_DOMAINS as any)[k].name === this.state.domainName) : null
      const starDomain = activeDomainId ? (STAR_DOMAINS as any)[activeDomainId] : null
      const uiSep = starDomain?.uiPersona?.separator ?? 'thin'

      const innerWidth = boxInnerWidth(cols)
      // 静态 chrome（线框字符 + 底边框）只依赖 (separator, innerWidth, borderColor)，
      // 缓存复用，避免每帧 repeat(innerWidth) 重建。
      const { leftBar, rightBar, botBorder } = this.getInputChrome(uiSep, innerWidth, borderColor)

      // 3. 构建高保真左右指标 Segment
      const leftStr = formatGlanceLeft({
        width: cols,
        domainGlyph: this.state.domainGlyph,
        domainName: this.state.domainName,
        branch: this.metricsGlanceController.gitBranch,
        cwd: this.sessionCwd,
        // worker 视图徽章：提示当前输入路由目标（◐ = 在跑，✓/✗ = 已终态）
        workerBadge: this.viewingWorkerId
          ? `→ ${shortOrderLabel(this.viewingWorkerId)}`
          : undefined,
      }, this.theme)

      const rightStr = formatGlanceRight({
        width: cols,
        modelName: this.state.modelName,
        reasoningEffort: this.metricsGlanceController.reasoningEffortProvider?.(),
        cacheHitRate: glanceCacheHitRate,
        cacheStatus: glanceCacheStatus,
        pricingPhase: glancePricingPhase,
        estimatedTokens: glanceEstimatedTokens,
        conversationTokens: glanceConversationTokens,
        maxTokens: glanceMaxTokens,
        cost: glanceCost,
        elapsedMs: Date.now() - this.state.turnStartMs,
        turnCount: this.state.turnNumber,
        approvalMode: this._approvalMode,
        planMode: planModeActive,
        goal: goalSnapshot,
        planAutoApproveSec: this.planAutoApproveRemainSec,
        todoSummary,
        todoFlash: !isReducedMotion() && this.state.todoFlashUntil > Date.now(),
        density: this.glanceDensity,
        // 编排徽章：team 波次 / 在跑子代理 / 终态未读（glance-bar 内按优先级取一）
        // currentWave 是 0-based 活动波索引（team-panel.ts 同款 +1 显示）。
        teamWave: this.liveTeamModel
          ? { current: Math.min(this.liveTeamModel.currentWave + 1, this.liveTeamModel.totalWaves), total: this.liveTeamModel.totalWaves }
          : undefined,
        fleetRunning: this.fleetFrame(cols, false).running,
        fleetUnread: this.fleetFrame(cols, false).unread,
        jobsRunning: this.jobsModel.runningCount(),
      }, this.theme)

      // 用 wide 上界度量标签串宽度：CJK/Windows 终端把 East-Asian Ambiguous 符号
      // （↑↓ · — … 等）按 2 列渲染。若按 narrow(string-width) 计算填充量，顶边框实际
      // 渲染宽度会超过 cols → 终端折行成 2 显示行，而 LiveEngine.rowsForLine 按 narrow
      // 数成 1 行 → 回顶欠擦（moveToTop/ERASE 少擦一行）→ 输入框重影/逐帧堆叠重复。
      // 按 wide 定尺后顶边框恒 ≤ cols，任何终端都占 1 显示行，行数估算与实际一致。
      const plainLeft = displayWidth(leftStr, { ambiguousAsWide: true })

      // 4. 顶边框：╭─ leftStr ─────╮ —— 无 ┬ 交汇、无右侧 metrics（下移底部状态行）。
      //    宽度恒 = innerWidth + 4，与输入行/底边框精确对齐（修复右角 1 列残缺）。
      const chars = boxCharsFor(uiSep)
      const labelFill = innerWidth - plainLeft - 1
      const topBorder = (() => {
        if (labelFill < 2) {
          return color(`${chars.tl}${chars.h.repeat(innerWidth + 2)}${chars.tr}`, borderColor)
        }
        // Kimi 模式：leftStr 后内嵌模型名标签（╭─ leftStr ─ model ──╮）
        if (uiSep === 'kimi') {
          const modelLabel = ` ${this.state.modelName} `
          const modelWidth = displayWidth(modelLabel, { ambiguousAsWide: true })
          const fillAfter = innerWidth - plainLeft - 1 - modelWidth
          if (fillAfter < 1) {
            // 空间不够，回退到标准 thin 渲染
            return color(`${chars.tl}${chars.h} `, borderColor)
              + leftStr
              + color(` ${chars.h.repeat(labelFill)}${chars.tr}`, borderColor)
          }
          return color(`${chars.tl}${chars.h} `, borderColor)
            + leftStr
            + color(` ${chars.h}${modelLabel}${chars.h.repeat(Math.max(0, fillAfter))}${chars.tr}`, borderColor)
        }
        return color(`${chars.tl}${chars.h} `, borderColor)
          + leftStr
          + color(` ${chars.h.repeat(labelFill)}${chars.tr}`, borderColor)
      })()

      const MAX_INPUT_DISPLAY_LINES = 12
      // 暗绿 + bold：用户验收过的提示符质感，与 primary 色光标块 █ 形成前后层次——
      // graphite 单色纪律下保留的唯一例外（同色 ❯ 与光标块粘连、无辨识度）。
      const arrowColor = '#3ba55c'
      // caret 坐标（行 = inputLines 下标，col = 行内 0-based cell，含 ❯ 前缀）：
      // 渲染到 LiveRegionLine.caretCol，引擎帧末把硬件光标搬过去锚定 IME 候选窗。
      const inputDisplay = this.inputLine.displayLinesWithCaret({ maxLines: MAX_INPUT_DISPLAY_LINES, maxWidth: innerWidth })
      const inputLines = this.inputLine.value
        ? inputDisplay.lines
        : [`${color('❯', arrowColor, { bold: true })} ${color('█', this.theme.primary)}${color(this.inputLine.placeholder, this.theme.dim)}`]

      /** 着色输入行：光标行前缀 ❯ 涂暗绿 bold，其余保持原样。
       *  光标行已在 displayLines 内做了水平视窗截断，不再二次 truncateToWidth。 */
      const colorizeInputLine = (raw: string): string => {
        if (raw.startsWith('❯ ')) return color('❯', arrowColor, { bold: true }) + ' ' + raw.slice(2)
        return raw
      }

      const vimModeLabel = !this.inputLine.vimEnabled ? null
        : this.inputLine.vimMode === 'normal' ? '-- NORMAL -- '
        : this.inputLine.visualLineWise ? '-- VISUAL LINE -- '
        : this.inputLine.vimMode === 'visual' ? '-- VISUAL -- '
        : null
      const vimNormalMode = vimModeLabel !== null
      // ghost text（P3-2）：「/命令名+空格」精确形态且光标在行尾时，在 █ 后拼
      // 暗色参数提示。caretCol 只量 █ 左侧 → IME 锚定零干扰；超宽由
      // renderInputRow 的 ANSI-aware truncate 截断，不折行；纯渲染层不进 buffer。
      const ghostText = isSlash && this.inputLine.cursor === inputVal.length
        ? slashArgsHint(this.inputController.slashCommands, inputVal)
        : null
      /** 在 caret 行的 █ 后注入 ghost（lastIndexOf：用户文本含 █ 时 marker 仍在末尾）。 */
      const withGhost = (raw: string, lineIdx: number): string => {
        if (!ghostText || lineIdx !== inputDisplay.caret.line) return raw
        const bi = raw.lastIndexOf('█')
        if (bi < 0) return raw
        return raw.slice(0, bi + 1) + color(ghostText, this.theme.dim) + raw.slice(bi + 1)
      }
      /** 折叠粘贴标记 → 反色 pill（纯渲染着色，buffer 与提交不受影响）。 */
      const withPastePills = (raw: string): string =>
        raw.includes('[paste #')
          ? raw.replace(/\[paste #\d+ \+\d+ lines?\]/g, m => `${ANSI.REVERSE}${m}${ANSI.RESET}`)
          : raw
      /** S2 代码块 fence 高亮：``` 翻转 parity，fence 内行着 dim（含 fence 行）。
       *  可见行近似 parity——maxLines 视口裁掉的段内 fence 不计，纯视觉无正确性影响。 */
      const fenceTinted = new Set<number>()
      {
        let inFence = false
        for (let i = 0; i < inputLines.length; i++) {
          const plain = inputLines[i]!.replace(/^❯ |^ {2}/, '')
          if (plain.trimStart().startsWith('```')) {
            fenceTinted.add(i)
            inFence = !inFence
          } else if (inFence) {
            fenceTinted.add(i)
          }
        }
      }
      const withFenceTint = (raw: string, lineIdx: number): string =>
        fenceTinted.has(lineIdx) ? color(raw, this.theme.dim) : raw
      // 0-based cell（相对行首）= 左边框宽 + 行内 caret 列；
      // vim 模式标签（-- NORMAL/VISUAL/VISUAL LINE --）只加在首行——caret 在首行时才计入其宽度。
      const leftBarW = displayWidth(leftBar, { ambiguousAsWide: true })
      const vimPrefixW = vimNormalMode ? displayWidth(vimModeLabel!, { ambiguousAsWide: true }) : 0
      const caretColFor = (lineIdx: number): number =>
        leftBarW + (lineIdx === 0 ? vimPrefixW : 0) + inputDisplay.caret.col
      /** 输入行 → LiveRegionLine；光标行携带 caretCol（IME 硬件光标归位标记）。 */
      const pushInputRow = (raw: string, lineIdx: number): void => {
        lines.push({
          text: this.renderInputRow(colorizeInputLine(withPastePills(withGhost(withFenceTint(raw, lineIdx), lineIdx))), innerWidth, leftBar, rightBar),
          ...(inputDisplay.caret.line === lineIdx ? { caretCol: caretColFor(lineIdx) } : {}),
        })
      }

      // ── 辅助行（状态/metrics/提示）全部在输入框上方 ──────────────
      // 矮屏降级（<14 行——手机软键盘展开的典型形态）：状态行与键位 footer
      // 让位给输入框本体，保证帧高不超屏（applyRowBudget 的「宁可超行」在
      // 矮屏上就是重影/错位）。信息可经命令随时找回，垂直空间优先。
      const shortScreen = (this.rows || 24) < 14
      // 5a. 图片附件摘要（输入框上方、状态行上方）
      const imageCount = this.inputLine.images.length
      if (imageCount > 0) {
        const imageLabel = `📎 ${imageCount} image${imageCount > 1 ? 's' : ''}`
        lines.push({ text: this.clampLine(color(imageLabel, this.theme.muted)) })
      }

      // 5b. 状态行：左 metrics（模型/effort/cache/ctx/耗时）+ 右权限模式（右对齐）——
      //     顶框不再承载指标，收敛到输入框上方这一行（权限行仍是单一事实来源）。
      //     slash 提示打开时权限让位；整行放不下时权限独占下一行。矮屏整块让位。
      const permLine = formatPermissionModeLine({ approvalMode: this._approvalMode, planMode: planModeActive, askMode: askModeActive }, this.theme)
      const permTrim = permLine.trimStart()
      const metricsW = displayWidth(rightStr, { ambiguousAsWide: true })
      const permW = displayWidth(permTrim, { ambiguousAsWide: true })
      if (shortScreen) {
        // 矮屏：只保留权限提示的核心片段（审批/计划态），压成一行
        if (planModeActive || askModeActive) lines.push({ text: this.clampLine(permTrim) })
      } else if (!isSlash) {
        const pad = cols - 1 - 2 - metricsW - permW
        if (metricsW > 0 && pad >= 2) {
          lines.push({ text: `  ${rightStr}${' '.repeat(pad)}${permTrim}` })
        } else {
          if (metricsW > 0) lines.push({ text: this.clampLine(`  ${rightStr}`) })
          lines.push({ text: this.clampLine(permLine) })
        }
      } else if (metricsW > 0) {
        lines.push({ text: this.clampLine(`  ${rightStr}`) })
      }

      // 5a3. @file 节点诊断（节点化 v1）：解析出的 @file:/@folder: 在 cwd 下
      //      不存在时给一行轻提示。existsSync 按输入值缓存（同值不重复 stat，
      //      每帧 stat 是性能坑）。
      const missingMention = this.computeMissingMention(inputVal)
      if (missingMention) {
        lines.push({ text: this.clampLine(`  ${color(`⚠ @file:${missingMention} 不存在`, this.theme.warning)}`) })
      }

      // 5a2. 上下文逃逸提示（wayfinding）：仅 worker 切入视图时显示退路键位，
      //      其余状态不显示，不占垂直空间。
      const contextHint = formatContextHints({
        viewingWorker: this.viewingWorkerId != null,
      }, this.theme)
      if (contextHint) lines.push({ text: this.clampLine(`  ${contextHint}`) })

      // 5a4. 协同建议行（orchestration hint）：输入命中多信号时给出 /team /scout
      //      /council 建议；Esc/Tab 采纳后本会话关闭，频率帽见 OrchestrationHint。
      if (this.orchHint.active) {
        lines.push({ text: this.clampLine(formatOrchestrationHint(this.theme, useAsciiGlyphs(), this.orchHint.kind)) })
      }

      // 5b. slash 命令提示（输入以 / 开头；支持 /skill <name> 等多 token 过滤）。
      //     菜单打开：渲染已过滤已排序的 matches（MRU/参数模式由 refreshSlash 维护），
      //     空 query 核心层视图补 footer 说明；菜单关（无匹配/Esc）：退回行内提示路径。
      //     两条路径共用同一预算钳制（TUI 钉底）——菜单与行内提示都不超预算，
      //     整帧 ≤ maxRows 不触发「宁可超行也不能让输入框消失」→ 终端滚动 → 输入框跳动。
      const slashBudget = (): { visibleItems: number; hideFooter: boolean } => {
        let chromeRows = 0
        for (const line of lines.slice(chromeStart)) chromeRows += this.displayRowsFor(line.text, cols)
        return computeSlashMenuBudget({
          chromeRows,
          inputRows: inputLines.length,
          maxRows: liveMaxRowsFor(this.rows),
          designMaxVisible: SLASH_HINT_MAX_VISIBLE,
        })
      }
      if (isSlash) {
        const menu = this.inputController.slashMenu
        if (menu.open) {
          const footerNote = menu.query === '' && this.inputController.slashCommands.length > menu.matches.length
            ? `核心 ${menu.matches.length}/${this.inputController.slashCommands.length} · 输入即过滤全部 · ctrl+p 面板`
            : undefined
          const budget = slashBudget()
          for (const menuLine of formatSlashMenu({ items: menu.matches, selected: menu.selected, footerNote, maxVisible: budget.visibleItems, hideFooter: budget.hideFooter }, this.theme)) {
            lines.push({ text: this.clampLine(menuLine) })
          }
        } else {
          const budget = slashBudget()
          for (const hintLine of formatSlashHint({ input: inputVal, commands: this.inputController.slashCommands, selectedIdx: 0, maxVisible: budget.visibleItems, hideFooter: budget.hideFooter }, this.theme)) {
            lines.push({ text: this.clampLine(hintLine) })
          }
        }
      }

      // 5c. @ 文件补全候选列表（Tab 循环时显示）
      if (this.inputController.fileCompletion && this.inputController.fileCompletion.candidates.length > 1) {
        const fc = this.inputController.fileCompletion
        for (let i = 0; i < Math.min(fc.candidates.length, 6); i++) {
          const selected = i === fc.idx
          const marker = selected ? color('❯ ', this.theme.primary) : '  '
          const name = color(fc.candidates[i]!, selected ? this.theme.primary : this.theme.muted)
          lines.push({ text: this.clampLine(`${marker}${name}`) })
        }
        lines.push({ text: this.clampLine(color('tab to cycle', this.theme.dim)) })
      }

      // ⏳ 已排队：贴在输入框顶边正上方（chrome），不放进动态段——否则会夹在
      // thinking / 工具卡之间随输出上漂。多条时 footer 显示 +N。
      if (this.steerBuffer.hasPending()) {
        const next = this.steerBuffer.getPendingEntries()[0]!
        const pendingCount = this.steerBuffer.getPending().length
        const preview = next.text.length > 60 ? `${next.text.slice(0, 60)}…` : next.text
        const more = pendingCount > 1 ? `（+${pendingCount - 1} 条）` : ''
        const deliverable = this.agentBusy && !this.isAgentRunSettling()
        lines.push({
          text: this.clampLine(deliverable
            ? this.renderBanner(`⏳ 已排队: "${preview}"${more} · ↑ 取回编辑`, this.theme.secondary)
            : this.renderBanner(`⏸ 未发出: "${preview}"${more} · 将在本轮结束后自动发出 · ↑ 取回编辑`, this.theme.warning)),
        })
      }

      // 输入框：chrome 段最后一行（滚动到底时贴屏幕底部，Claude Code 风格）。
      lines.push({ text: topBorder })
      if (vimNormalMode) {
        lines.push({
          text: this.renderInputRow(`${vimModeLabel}${colorizeInputLine(withPastePills(withGhost(withFenceTint(inputLines[0] ?? '', 0), 0)))}`, innerWidth, leftBar, rightBar),
          ...(inputDisplay.caret.line === 0 ? { caretCol: caretColFor(0) } : {}),
        })
        for (let i = 1; i < inputLines.length; i++) {
          pushInputRow(inputLines[i]!, i)
        }
      } else {
        for (let i = 0; i < inputLines.length; i++) {
          pushInputRow(inputLines[i]!, i)
        }
      }
      lines.push({ text: botBorder })

      // prompt footer：输入框下方键位提示行（对齐公开仓）——换行模式/打断/
      // 审批态提示。审批态的 JSON 编辑分支在 renderLive 更早处 return，不重叠。
      if (!shortScreen) {
        const footerLines = formatPromptFooter({
          width: cols,
          newlineMode: this.inputLine.newlineMode,
          agentBusy: this.agentBusy && !this.isAgentRunSettling(),
          approvalPending: this.approvalIntentController.approvalPending != null,
          shiftEnterAvailable: this.kittyKeyboard,
        }, this.theme)
        for (const line of footerLines) lines.push({ text: this.clampLine(line) })
      }
    }

    if (this.screenReader) {
      // 整个动态段出局，只留输入框 chrome。定高视口那套也一并跳过——它存在的
      // 意义是让输入框在动态段涨落时钉住不动，而这里根本没有动态段。
      lines = lines.slice(chromeStart)
      chromeStart = 0
    } else {
      // ── 定高视口：动态段垫到「总高度高水位 − chrome」，slash/todo 等 chrome
      //    关掉后垫行补上，输入框不上跳。欢迎首帧（未开 slash、水位 0）仍不垫。
      //    度量与 LiveEngine.rowsForLine 同口径。
      let chromeRows = 0
      for (let i = chromeStart; i < lines.length; i++) {
        chromeRows += this.displayRowsFor(lines[i]!.text, cols)
      }
      let dynamicRows = 0
      for (let i = 0; i < chromeStart; i++) {
        dynamicRows += this.displayRowsFor(lines[i]!.text, cols)
      }
      const budget = this.getDynamicBudget(chromeRows, dynamicRows)
      if (budget > 0) {
        const padded = padDynamicRegion(lines, chromeStart, budget, (text) => this.displayRowsFor(text, cols))
        lines = padded.lines
        chromeStart = padded.chromeStart
      }
    }

    if (showSidePanel) {
      const currentTool = (() => {
        for (const [id, meta] of this.toolGroupController.getPendingEntries()) {
          if (isCollapsibleTool(meta.name)) continue
          if (meta.name === 'bash' && this.toolGroupController.hasBashEntry(id)) continue
          return { name: meta.name, elapsedMs: Date.now() - meta.startMs }
        }
        return undefined
      })()
      let activePlan: string | undefined
      try {
        activePlan = this.activePlanProvider?.()
      } catch {
        activePlan = undefined
      }
      let planDraft: { path: string; bytes?: number } | null | undefined
      try {
        planDraft = planModeActive ? this.planDraftProvider?.() : null
      } catch {
        planDraft = null
      }
      const sidePanelInput: SidePanelInput = {
        columns: sidePanelWidth,
        todos: this.state.todos,
        phase: this.state.phase,
        todosStale: !this.todosWrittenThisRun,
        todoExpanded: this.state.todoExpanded,
        workers: this.fleetFrame(cols, false).activeWorkers,
        teamModel: this.liveTeamModel ? this.teamModelWithLiveStatus(this.liveTeamModel) : null,
        currentTool,
        modelName: this.state.modelName,
        domainGlyph: this.state.domainGlyph,
        domainName: this.state.domainName,
        estimatedTokens: glanceEstimatedTokens,
        maxTokens: glanceMaxTokens,
        cacheHitRate: glanceCacheHitRate,
        cost: glanceCost,
        activePlan,
        planDraft: planDraft ?? null,
        planTrace,
        goal: goalSnapshot,
      }
      const panelLines = renderSidePanel(sidePanelInput, this.theme)
      lines = this.mergeSidePanel(lines, panelLines, contentCols, sidePanelWidth)
    }

    this.live.render(lines, { reservedTail: lines.length - chromeStart })
  }

  /** 强制重绘（resize 后） */
  private rerender(): void {
    if (this.overlay.isActive()) {
      this.overlay.rerender()
    } else {
      this.renderLive()
    }
  }

  /**
   * 将 thinking 文本 commit 到 scrollback（保留内部状态）。
   *
   * collapse-on-commit：流式期已完整显示推理，turn 结束只在 scrollback 留一行
   * 过去式摘要「✶ 已推理 · Ns · N 行」，避免啰嗦推理逐轮堆满历史。终端 scrollback
   * 是只读追加的，无法像桌面端那样回溯折叠已打印的行，故在 commit 时即收敛为摘要。
   */
  private commitThinkingToScrollback(): void {
    if (!this.state.thinkingText) return
    const formatted = formatThinking({
      text: this.state.thinkingText,
      elapsedMs: Date.now() - this.state.thinkStartMs,
      done: true,
      expanded: false,
      domainId: this.getActiveDomainId(),
    }, this.theme)
    if (formatted.length === 0) return
    this.commit.write({ text: formatted.join('\n'), trailingNewline: true })
  }

  /** 将 thinking 文本 commit 到 scrollback 并清空状态 */
  private commitThinking(): void {
    this.commitThinkingToScrollback()
    this.state.thinkingText = ''
    this.state.isThinking = false
    this.state.thinkStartMs = 0
  }

  /**
   * 审批的工具调用是否涉及工作区外路径（决定是否显示「批准并记住此目录」）。
   * 与 tool-pipeline 的 outOfWorkspaceFilePaths 消费 remember 的工具集严格对齐：
   * 只有这四个文件工具的批准会经 `resolved.remember` 持久化目录授权；其他工具
   * （如 request_path_access，其 remember 是模型侧参数）显示了记住选项也不会
   * 生效，宁可不显示也不给用户一个勾了没用的按钮。
   */
  private approvalTargetsOutOfWorkspace(cwd: string, toolName: string, input: Record<string, unknown>): boolean {
    if (toolName !== 'read_file' && toolName !== 'write_file' && toolName !== 'edit_file' && toolName !== 'hash_edit') {
      return false
    }
    const candidates: string[] = []
    if (typeof input.file_path === 'string') candidates.push(input.file_path)
    if (Array.isArray(input.file_paths)) {
      for (const p of input.file_paths) if (typeof p === 'string') candidates.push(p)
    }
    return candidates.some(c => !isPathUnder(cwd, resolve(cwd, c)))
  }

  /** 审批处理器 — 交互式 y/n/e/r */
  private handleApprovalRequired(id: string, name: string, input: Record<string, unknown>): Promise<ApprovalResult | boolean> {
    // 权限 diff 预览：write/edit 审批前渲染变更块
    const diffPreview = formatPermissionDiff({ toolName: name, input, theme: this.theme })
    if (diffPreview) {
      this.commitAbove(() => {
        for (const line of diffPreview) {
          this.commit.write({ text: line, trailingNewline: line === diffPreview[diffPreview.length - 1] })
        }
        this.state.committedCount++
      })
    }
    return new Promise((resolve) => {
      this.approvalIntentController.approvalPending = { id, name, input, resolve, startMs: Date.now() }
      // 上一条待批项的风险结论绝不能留给下一条——那是最危险的一类误导。
      this.approvalIntentController.resetRiskExplanation()
      this.approvalIntentController.showRememberOption =
        this.sessionCwd !== undefined && this.approvalTargetsOutOfWorkspace(this.sessionCwd, name, input)
      this.input.setMode('approval')
      this.setPhase('waiting')
      this.renderLive()
    })
  }

  /** 注入风险解释器（侧路 LLM 调用）。未注入时 Ctrl+E 静默无效。 */
  setRiskExplainer(fn: RiskExplainer | undefined): void {
    this.riskExplainer = fn
  }

  /** 注入 `/btw` 侧问执行器。未注入时 `/btw` 报不可用而不是静默吞掉。 */
  setSideQuestionAsker(fn: SideQuestionAsker | undefined): void {
    this.sideQuestionAsker = fn
  }

  /** 当前侧问状态（测试与渲染读取）。 */
  getSideQuestion(): SideQuestionData | null {
    return this.sideQuestion
  }

  /**
   * `/btw <question>`：开侧问浮层并流式填充回答。
   *
   * 主 turn 不受影响——侧路请求并发进行，agent 干活时也能问。回答只存在于浮层，
   * 关掉即弃：这既是产品定位，也是它便宜的原因（主对话字节一个没动，下一轮前缀
   * 照常逐字节命中）。
   */
  askSideQuestion(question: string): void {
    const q = question.trim()
    if (!q) return

    this.sideQuestionScroll = 0
    this.sideQuestion = { question: q, answer: '', pending: true }
    this.overlay.activate('side-question')

    if (!this.sideQuestionAsker) {
      this.sideQuestion = { ...this.sideQuestion, pending: false, error: '侧问不可用（未接入模型）' }
      this.overlay.rerender()
      return
    }

    const asked = this.sideQuestion
    void this.sideQuestionAsker(q, chunk => {
      // 用户可能已经关掉浮层或问了新问题——迟到的增量不得回灌。
      if (this.sideQuestion !== asked) return
      asked.answer += chunk
      if (this.overlay.isActive()) this.overlay.rerender()
    }).then(
      full => {
        if (this.sideQuestion !== asked) return
        asked.pending = false
        if (full !== null) asked.answer = full
        else if (!asked.answer) asked.error = '模型未返回可用回答'
        if (this.overlay.isActive()) this.overlay.rerender()
      },
      err => {
        if (this.sideQuestion !== asked) return
        asked.pending = false
        asked.error = (err as Error).message
        if (this.overlay.isActive()) this.overlay.rerender()
      },
    )
  }

  /**
   * Ctrl+E：为当前待批项拉取风险解释。
   *
   * 只在按键时发请求——绝大多数审批用户一眼能判，为每次弹窗预生成既费钱又拖慢
   * 弹窗出现。请求在途时不重复触发；已有结果则不再重复问。
   */
  private requestRiskExplanation(): void {
    const ctrl = this.approvalIntentController
    const pending = ctrl.approvalPending
    if (!pending || !this.riskExplainer) return
    if (ctrl.riskExplainPending || ctrl.riskExplanation) return

    ctrl.riskExplainPending = true
    ctrl.riskExplainError = ''
    // 选项随即收缩一行（「解释风险」行消失）——光标若正停在该行，不收敛就越界：
    // 光标行整体消失、Enter 成死键、↓/↑ 还会跳过「批准」。记住选项（若显示）保留，
    // 其上界随之从 2（无记住）变为 3（有记住）。
    ctrl.approvalOptionIndex = Math.min(ctrl.approvalOptionIndex, ctrl.showRememberOption ? 3 : 2)
    this.renderLive()

    const requestedFor = pending.id
    void this.riskExplainer(pending.name, pending.input).then(
      result => {
        // 用户可能已经批完并进入下一条——迟到的结果不得盖到新的待批项上。
        if (ctrl.approvalPending?.id !== requestedFor) return
        ctrl.riskExplainPending = false
        if (result) ctrl.riskExplanation = result
        else ctrl.riskExplainError = '模型未返回可用结果'
        this.renderLive()
      },
      err => {
        if (ctrl.approvalPending?.id !== requestedFor) return
        ctrl.riskExplainPending = false
        ctrl.riskExplainError = (err as Error).message
        this.renderLive()
      },
    )
  }

  /**
   * Non-blocking 方向提示: surfaces the intent gate's reasoning as a passive
   * timeline card. The agent keeps running; the user steers by typing.
   */
  private handleIntentNote(intent: IntentPreview): void {
    const copy = describeIntentNote(intent)
    const lines: string[] = []
    lines.push(this.renderBanner(copy.title, this.theme.primary))
    for (const reason of copy.reasons) {
      lines.push(` │ ${color(`· ${reason}`, this.theme.warning)}`)
    }
    lines.push(` │ ${color(copy.action, this.theme.secondary)}`)
    lines.push(` ╰─ ${color(copy.steerHint, this.theme.secondary)}`)
    this.commitStatic(lines.join('\n'))
  }

  /**
   * C3 自治刹车 — cruise 暂停时渲染进度摘要卡（之前 TUI 完全静默，用户只能
   * 盲猜发"继续"）；unleashed 播报打一条简短的非阻塞系统块。
   */
  private handleAutonomyCheckpoint(info: AutonomyCheckpointInfo): void {
    const lines: string[] = []
    if (info.paused) {
      lines.push(this.renderBanner(`⏸ 自治检查点 — 已执行 ${info.turns} 轮`, this.theme.warning))
      for (const line of info.digest.split('\n')) {
        lines.push(` │ ${color(line, this.theme.secondary)}`)
      }
      lines.push(` ╰─ ${color('输入 continue 继续，或 /permission 调整权限模式', this.theme.secondary)}`)
    } else {
      lines.push(color(`◦ 自治进度播报（第 ${info.turns} 轮，不暂停）`, this.theme.secondary))
      for (const line of info.digest.split('\n')) {
        lines.push(color(`  ${line}`, this.theme.secondary))
      }
    }
    this.commitStatic(lines.join('\n'))
  }

  /**
   * 提交 slash 命令：await 外部 handler（SlashRouter）的结果，
   * handler 返回 false（透传命令如 /team、/review、/plan <x>）时把原始输入交给 agent。
   * 这修复了「async handler 一律视为已处理」吞掉透传命令的 bug。
   */
  private async submitSlashCommand(input: string): Promise<void> {
    // MRU 排序数据源：命令执行即记录（含透传命令）；取首个 token（/team plan.md → /team）
    this.inputController.recordSlashUse(input.split(/\s+/)[0] ?? input)
    let handled: boolean
    if (this.slashHandler) {
      try {
        handled = await this.slashHandler(input)
      } catch (err) {
        this.commitStatic(`Error: ${(err as Error).message}`)
        handled = true
      }
    } else {
      const ctx: SlashCommandContext = { app: this, input, trimmed: input.trim() }
      const result = await this.slashRegistry.execute(ctx)
      handled = result.handled
    }
    if (!handled) {
      // 透传给 agent 前 commit 用户消息到 scrollback，确保 slash 命令
      // 也能在终端历史中看到（之前只有 agent 回复无用户气泡）。
      await this.awaitUserCommit(input)

      if (this.agentBusy) {
        // 当前 run 仍在执行：把透传 slash 命令按高优先级排进 steer 队列，
        // 避免与正在进行的 turn 冲突，同时保证它比普通的 later guidance 先 drain。
        this.steerBuffer.push(input, 'next')
        return
      }

      this.blockWriter.discard()
      this.streamRenderer.reset()
      this.streamRenderController.assistantHeaderDone = false
      this.agentBusy = true
      this.todosWrittenThisRun = false
      this.state.turnStartMs = Date.now()
      this.streamRenderController.lastActivityMs = Date.now()
      this.onSubmitCallback?.(input)
    }
  }

  // ── Overlay Registration ─────────────────────────────────────

  /**
   * 注册 overlay 渲染器。
   *
   * @param overlayData 可选：每个 overlay 的数据提供函数。
   *                    不传入则使用空占位数据。
   */
  registerOverlays(overlayData?: {
    pagerContent?: () => PagerData
    starmapEntries?: () => StarmapData
    paletteCommands?: () => PaletteData
    chronicleEntries?: () => ChronicleData
    cockpitSnapshot?: () => CockpitSnapshot
    rewindEntries?: () => RewindData
    rewindFilePreview?: (messageIndex: number) => RewindFile[]
    /** 当前 provider 是否按精确前缀缓存计费——决定是否显示摘要动作的缓存代价标注。 */
    rewindCachePreserving?: () => boolean
    historySearchData?: () => HistorySearchData
    tasksData?: () => TasksData
    jobsData?: () => { rows: JobRow[]; selectedIndex: number }
    cachePanelData?: () => CachePanelData
    domainPickerData?: () => DomainPickerData
    modelPickerData?: () => ModelPickerData
    themePickerData?: () => ThemePickerData
    choicePanelData?: () => ChoicePanelData
    planPickerData?: () => PlanPickerData
  }, paletteExec?: (index: number) => void, rewindExec?: (messageIndex: number, mode: RewindMode) => void, chronicleExec?: (id: string) => void, domainPickerExec?: (key: string) => void, modelPickerExec?: (provider: string, modelId: string) => void, domainPickerSaveDefaultExec?: (key: string) => void, modelPickerSaveDefaultExec?: (provider: string, modelId: string) => void, themePickerExec?: (key: string) => void, themePickerSaveDefaultExec?: (key: string) => void, choicePanelExec?: (id: string) => void, connectExec?: (commit: ConnectCommit, summary: string) => boolean | void, planPickerExec?: (slug: string) => void, initExec?: (commit: InitCommit, summary: string) => void): void {
    this.overlayController.setData(overlayData)
    this.overlayController.setPaletteExec(paletteExec)
    this.overlayController.setRewindExec(rewindExec)
    this.overlayController.setChronicleExec(chronicleExec)
    this.overlayController.setDomainPickerExec(domainPickerExec)
    this.overlayController.setDomainPickerSaveDefaultExec(domainPickerSaveDefaultExec)
    this.overlayController.setModelPickerExec(modelPickerExec)
    this.overlayController.setModelPickerSaveDefaultExec(modelPickerSaveDefaultExec)
    this.overlayController.setThemePickerExec(themePickerExec)
    this.overlayController.setThemePickerSaveDefaultExec(themePickerSaveDefaultExec)
    this.overlayController.setChoicePanelExec(choicePanelExec)
    this.overlayController.setConnectExec(connectExec)
    this.overlayController.setPlanPickerExec(planPickerExec)
    this.overlayController.setInitExec(initExec)
    // Dedicated vision bridge wizard. It shares only generic wizard rendering;
    // state, endpoint discovery, and persistence are distinct from /connect.
    this.overlay.register('vision-onboarding', {
      render: (_w, _h) => {
        // 与 connect overlay 同款 caret 接线：renderConnect 回填 data.caret，
        // caret() 供引擎定位（此前只 render 不接 caret——输入步无可见光标）。
        const data = this.getVisionOnboardingOverlayData()
        const lines = renderConnect(data, this.columns, this.rows, this.theme)
        this.connectCaret = data.caret ?? null
        return lines
      },
      caret: () => this.connectCaret,
    })

    // Pager — page / mode / search / message 由 overlayNav 注入（覆盖 provider 的静态值）
    this.overlay.register('pager', {
      render: (_w, _h) => {
        const data = overlayData?.pagerContent?.() ?? { content: '(no content)', page: 0 }
        const nav = this.overlayController.nav()
        const messages = data.messages ?? []
        const searchMatches = nav.pagerMode === 'search' && nav.pagerSearchQuery
          ? searchTranscript(messages, nav.pagerSearchQuery).length
          : 0
        return renderPager({
          ...data,
          page: nav.pagerPage,
          mode: nav.pagerMode,
          searchQuery: nav.pagerSearchQuery,
          searchMatches,
          searchCurrent: nav.pagerSearchCurrent,
          selectedMessageIndex: nav.pagerSelectedMessage,
          verbose: nav.pagerVerbose,
        }, this.columns, this.rows, this.theme)
      },
    })

    // Starmap
    this.overlay.register('starmap', {
      render: (_w, _h) => {
        const data = overlayData?.starmapEntries?.() ?? { entries: [] }
        return renderStarmap(data, this.columns, this.rows, this.theme)
      },
    })

    // Command palette — selectedIndex / scrollOffset 由 overlayNav 注入，渲染时跟随选中项
    this.overlay.register('command-palette', {
      render: (_w, _h) => {
        const data = overlayData?.paletteCommands?.() ?? { commands: [], selectedIndex: 0 }
        const nav = this.overlayController.nav()
        const maxItems = Math.max(0, this.rows - 5)
        nav.paletteScroll = followListWindow(nav.paletteIndex, data.commands.length, maxItems, nav.paletteScroll)
        return renderCommandPalette({
          ...data,
          selectedIndex: nav.paletteIndex,
          scrollOffset: nav.paletteScroll,
          searchText: this.overlayController.getQuery() || data.searchText,
        }, this.columns, this.rows, this.theme)
      },
    })

    // Cockpit
    this.overlay.register('cockpit', {
      render: (_w, _h) => {
        const data = overlayData?.cockpitSnapshot?.()
        if (!data) return ['Cockpit data not available.']
        return renderCockpit(data, this.columns, this.rows, this.theme, this.overlayController.getCockpitPanel())
      },
    })

    // Rewind — selectedIndex/phase/action 由 overlayNav 注入；phase 2 附精确文件预览
    this.overlay.register('rewind', {
      render: (_w, _h) => {
        const base = overlayData?.rewindEntries?.() ?? { entries: [], selectedIndex: 0 }
        const nav = this.overlayController.nav()
        const sel = base.entries[nav.rewindIndex]
        const previewFiles = nav.rewindPhase === 'action' && sel && overlayData?.rewindFilePreview
          ? overlayData.rewindFilePreview(sel.messageIndex)
          : undefined
        return renderRewind({
          ...base,
          selectedIndex: nav.rewindIndex,
          phase: nav.rewindPhase,
          actionIndex: nav.rewindActionIndex,
          previewFiles,
          cachePreserving: overlayData?.rewindCachePreserving?.(),
        }, this.columns, this.rows, this.theme)
      },
    })

    // Side question (`/btw`) — 内容全在 TuiApp 本地状态，不经 overlayData，
    // 因为它按定义就不该有任何持久数据源。
    this.overlay.register('side-question', {
      render: (_w, _h) => renderSideQuestion(
        { ...(this.sideQuestion ?? { question: '', answer: '', pending: false }), scroll: this.sideQuestionScroll },
        this.columns,
        this.rows,
        this.theme,
      ),
      // 「关掉即弃」挂在失活钩子上而不是某个键的分支：通用 q/Esc 关闭、切到别的
      // overlay、程序化关闭走的是不同代码路径，只有这里是它们共同的收口。
      onDeactivate: () => {
        this.sideQuestion = null
        this.sideQuestionScroll = 0
      },
    })

    // History search — selectedIndex 由 overlayNav 注入
    this.overlay.register('history-search', {
      render: (_w, _h) => {
        const data = overlayData?.historySearchData?.() ?? { entries: [], selectedIndex: 0, query: '' }
        return renderHistorySearch({ ...data, selectedIndex: this.overlayController.nav().historySearchIndex, query: this.overlayController.getQuery() || data.query }, this.columns, this.rows, this.theme)
      },
    })

    // Chronicle
    this.overlay.register('chronicle', {
      render: (_w, _h) => {
        const data = overlayData?.chronicleEntries?.() ?? { entries: [] }
        return renderChronicle({ ...data, selectedIndex: this.overlayController.nav().chronicleIndex }, this.columns, this.rows, this.theme)
      },
    })

    // Tasks — /tasks 显示运行中子代理（支持选中/进入 detail）
    this.overlay.register('tasks', {
      render: (_w, _h) => {
        const data = overlayData?.tasksData?.() ?? { groups: [], filter: 'running' as const, completedCount: 0 }
        return renderTasks(data, this.columns, this.rows, this.theme, this.overlayController.nav().tasksIndex)
      },
    })

    // Jobs — /jobs 显示后台 shell 任务（来自 TUI job 读模型）
    this.overlay.register('jobs', {
      render: (_w, _h) => {
        const data = overlayData?.jobsData?.() ?? { rows: [], selectedIndex: 0 }
        return renderJobsOverlay(data.rows, this.columns, this.rows, this.theme, data.selectedIndex)
      },
    })

    // Cache — /cache DeepSeek 缓存面板；period 由 overlayNav 注入
    this.overlay.register('cache', {
      render: (_w, _h) => {
        const data = overlayData?.cachePanelData?.()
        if (!data) return [' 缓存面板数据不可用。']
        return renderCachePanel({ ...data, period: this.overlayController.nav().cachePeriod }, this.columns, this.rows, this.theme)
      },
    })

    // Domain Picker — 裸 /domain 打开 CC 风星域选择器；selectedIndex 由 overlayNav 注入。
    // g 键切到创世碑文视图（同一 overlay 内的第二个 tab）。
    this.overlay.register('domain-picker', {
      render: (_w, _h) => {
        const data = overlayData?.domainPickerData?.() ?? { entries: [], selectedIndex: 0 }
        const cur = this.overlayController.nav().domainPickerIndex
        if (this.domainGenesisMode) {
          const entry = data.entries[cur]
          const genesis = entry ? STAR_GENESIS.find(g => g.key === entry.key) : undefined
          if (genesis && entry) {
            return renderDomainGenesisCard({
              genesis,
              glyph: entry.uiPersona?.glyph ?? '✵',
              accent: entry.uiPersona?.accent ?? 'primary',
              scroll: this.domainGenesisScroll,
            }, this.columns, this.rows, this.theme)
          }
        }
        return renderDomainPicker({ ...data, selectedIndex: cur }, this.columns, this.rows, this.theme)
      },
    })

    // Model Picker — 裸 /model 打开模型选择器；selectedIndex 由 overlayNav 注入。
    // effort 行数据在此组装：value 取 draft，supported 按当前选中条目（翻页即变）。
    this.overlay.register('model-picker', {
      render: (_w, _h) => {
        const data = overlayData?.modelPickerData?.() ?? { entries: [], selectedIndex: 0 }
        const sel = this.overlayController.nav().modelPickerIndex
        const selEntry = data.entries[sel]
        return renderModelPicker({
          ...data,
          selectedIndex: sel,
          effort: {
            value: this.modelPickerEffortDraft ?? 'auto',
            supported: selEntry?.effortSupported !== false,
          },
        }, this.columns, this.rows, this.theme)
      },
    })

    // Theme Picker — 裸 /theme 打开主题选择器；selectedIndex 由 overlayNav 注入
    this.overlay.register('theme-picker', {
      render: (_w, _h) => {
        const data = overlayData?.themePickerData?.() ?? { entries: [], selectedIndex: 0 }
        return renderThemePicker({ ...data, selectedIndex: this.overlayController.nav().themePickerIndex }, this.columns, this.rows, this.theme)
      },
    })

    // Choice Panel — 通用选项选择弹窗；selectedIndex 由 overlayNav 注入。
    // ask-user-question 走 Tab 化专用渲染器（buildAskPanelData），不进通用 data 管线。
    // 输入子模式与 connect overlay 同款 caret 接线：渲染方回填 data.caret，caret() 供引擎定位。
    this.overlay.register('choice-panel', {
      render: (_w, _h) => {
        if (this.choicePanelKind === 'ask-user-question' && this.pendingAskFlow) {
          const askData = this.buildAskPanelData()
          const lines = renderAskQuestionPanel(askData, this.columns, this.rows, this.theme)
          this.choicePanelCaret = askData.caret ?? null
          return lines
        }
        const data = overlayData?.choicePanelData?.() ?? { title: '', choices: [], selectedIndex: 0 }
        const merged = {
          ...data,
          selectedIndex: this.overlayController.nav().choicePanelIndex,
          inputSubMode: this.getChoicePanelInputState(),
        }
        const lines = renderChoicePanel(merged, this.columns, this.rows, this.theme)
        this.choicePanelCaret = merged.caret ?? null
        return lines
      },
      caret: () => (this.choicePanelSubMode === 'input' ? this.choicePanelCaret : null),
    })

    // Plan Picker — 待批计划选择器；回车批准并自动分波执行（selectedIndex 由 overlayNav 注入）
    this.overlay.register('plan-picker', {
      render: (_w, _h) => {
        const data = overlayData?.planPickerData?.() ?? { entries: [], selectedIndex: 0 }
        return renderPlanPicker({ ...data, selectedIndex: this.overlayController.nav().planPickerIndex }, this.columns, this.rows, this.theme)
      },
    })

    // Connect Wizard — /connect 服务商配置向导；数据来自 app 持有的 ConnectFlow。
    // render 时渲染方把硬件光标落点回填进 data.caret，caret() 供引擎定位。
    this.overlay.register('connect', {
      render: (_w, _h) => {
        const data = this.getConnectOverlayData()
        const lines = renderConnect(data, this.columns, this.rows, this.theme)
        this.connectCaret = data.caret ?? null
        return lines
      },
      caret: () => this.connectCaret,
    })

    // Init Wizard — /init 交互式项目初始化；数据来自 app 持有的 InitFlow。
    this.overlay.register('init', {
      render: (_w, _h) => renderInitFlow(this.getInitOverlayData(), this.columns, this.rows, this.theme),
    })

    // Settings — /config 设置面板；数据来自 app 持有的 SettingsFlow。
    this.overlay.register('settings', {
      render: (_w, _h) => renderSettings(this.getSettingsOverlayData(), this.columns, this.rows, this.theme),
    })
  }
}

/**
 * Headless state machine for the in-TUI `/connect` provider setup wizard.
 *
 * Pure and side-effect free so it is fully unit-testable without a TUI runtime:
 * it only produces *view models* (what the overlay should render), *probe
 * requests* (the TUI runs the async probe and feeds the report back), and
 * *commit descriptors* (what config write to perform). The TUI layer owns
 * rendering and calls `setupProvider` / `registerProvider` on commit.
 *
 * Three paths:
 *   preset    → pick a built-in provider (URL/protocol/models auto-filled) →
 *               paste API key → credential probe (models + minimal completion)
 *               → confirm → done.
 *   custom    → base URL → API key → PROBE (models list + minimal completion)
 *               → multi-select probed models (alias-table metadata backfilled)
 *               → thinking capability → provider name → confirm → done.
 *               Multi-model; the old single-model `custom-<modelname>` mode is gone.
 *   add-model → append one model to an existing provider (no URL/key needed).
 */

import type { SetupProviderOptions } from '../config/manager.js'
import type { ModelConfig, ProviderAdvancedConfig } from '../config/schema.js'
import { PROVIDER_PRESETS, providerPresetKeys, isProviderPresetKey, type ProviderPresetKey, type ProviderPreset } from '../config/provider-presets.js'
import { matchModelIds, type ModelMatchResult } from '../api/model-id-matcher.js'
import { aliasTableWithProbeInfos, isVisionCapableId, VISION_PROBE_GROUND_TRUTH, type ProbeReport } from '../api/provider-probe.js'
import { normalizeBaseUrl } from '../api/endpoint-map.js'
import type { ConnectDraft, ConnectDraftCollected } from './connect-draft.js'

const CUSTOM_CHOICE = 'custom'
const OPENAI_COMPAT_CHOICE = 'openai-compat'
const DEFAULT_CONTEXT_WINDOW = 131_072
const DEFAULT_MAX_OUTPUT = 64_000
/** 未知模型高级步的默认最大输出（保守值，用户可按官方文档改）。 */
const DEFAULT_ADVANCED_MAX_OUTPUT = 32_768
/** Providers the wizard recommends first (project is DeepSeek-optimized). */
const RECOMMENDED_PRESETS: readonly ProviderPresetKey[] = ['deepseek']

const CONFIG_HINT = '密钥将保存到 ~/.rivet/secrets.json（0600 权限，config 只留引用，可粘贴）'

/** DIY 流程密钥步时最终 provider 名未知——密钥先暂存这个 ref，commit 时以
 *  最终名重写并清理。单实例向导，覆盖写安全。 */
export const DIY_PENDING_KEY_REF = 'diy-pending'

export type ConnectStepKind = 'choice' | 'multi-choice' | 'input' | 'form' | 'busy'

export interface ConnectChoiceOption {
  id: string
  label: string
  description?: string
  recommended?: boolean
  /** Checkbox state on multi-choice steps (space toggles). */
  checked?: boolean
}

/** One arranged row of a form step (未知模型补参等)。 */
export interface ConnectFormField {
  id: string
  label: string
  /** text = 可编辑缓冲（当前文本）；toggle = 选项标签（←→/空格切换）。 */
  kind: 'text' | 'toggle'
  value: string
  hint?: string
}

/** One rendered line of the probe report (overlay applies tone colors). */
export interface ProbeLine {
  text: string
  tone?: 'ok' | 'fail' | 'head' | 'muted'
}

/** What the TUI overlay should render for the current step. */
export interface ConnectView {
  kind: ConnectStepKind
  title: string
  subtitle?: string
  /** e.g. "步骤 2 / 5" — shown by the DIY multi-step flow. */
  stepLabel?: string
  /** Structured multi-line report (probe checklist / error diagnosis). */
  report?: ProbeLine[]
  /** choice / multi-choice steps */
  options?: ConnectChoiceOption[]
  /** Active type-to-search query on searchable multi-choice steps (never persisted). */
  filter?: string
  /** Unfiltered option count — with `filter` set, renderer shows shown/total. */
  optionTotal?: number
  /** input step */
  masked?: boolean
  placeholder?: string
  defaultValue?: string
  /** form step — arranged editable rows. */
  fields?: ConnectFormField[]
}

/** Config mutation to perform once the wizard reaches a terminal state. */
export type ConnectCommit =
  | {
      mode: 'preset'
      setup: SetupProviderOptions
      /** OAuth 型预设（codex）：配置已写盘但需 /login 完成浏览器授权才能对话——
       *  connectExec 据此跳过即时热切换并改指引登录（而不是「直接开始对话」）。 */
      needsLogin?: boolean
    }
  | {
      mode: 'custom'
      providerName: string
      baseUrl: string
      /** Empty for local endpoints (Ollama/vLLM) that need no auth. */
      apiKey?: string
      protocol: 'openai' | 'anthropic'
      /** Multi-model; partial entries are normalized by registerProvider. */
      models: Array<Partial<ModelConfig> & { id: string }>
      makeDefault: boolean
      /** Advanced knobs (timeout/retry/temperature/proxy) — pipeline ready, no UI yet. */
      advanced?: ProviderAdvancedConfig
    }
  | {
      mode: 'add-model'
      providerName: string
      model: { id: string; contextWindow: number; maxTokens: number; supportsVision?: boolean }
    }

export type ConnectStepResult =
  | { kind: 'next'; view: ConnectView }
  | { kind: 'error'; message: string; view: ConnectView }
  /** Async probe request — the TUI runs probeProvider and calls applyProbe/probeFailed. */
  | { kind: 'probe'; baseUrl: string; apiKey?: string; protocol: 'openai' | 'anthropic'; probeModel?: string; providerName?: string }
  | { kind: 'commit'; commit: ConnectCommit; summary: string }

type Phase =
  | 'draft'
  | 'provider'
  | 'pick-existing'
  | 'preset-billing'
  | 'preset-apikey'
  | 'preset-endpoint'
  | 'preset-probing'
  | 'probe-report'
  | 'reprobe-pick'
  | 'preset-models'
  | 'capability'
  | 'ask-default'
  | 'confirm'
  | 'advanced-settings'
  | 'advanced-request-timeout'
  | 'advanced-max-retries'
  | 'advanced-temperature'
  | 'advanced-proxy'
  | 'diy-protocol'
  | 'diy-url'
  | 'diy-apikey'
  | 'diy-probing'
  | 'diy-probe-failed'
  | 'diy-models'
  | 'model-advanced'
  | 'diy-model'
  | 'diy-context'
  | 'diy-vision'
  | 'diy-thinking'
  | 'diy-name'

/** A provider already configured on disk, offered by the add-model branch. */
export interface ConnectProviderRef {
  name: string
  label?: string
  modelCount: number
}

/** One probed model with its matcher result and checkbox state. */
interface ProbedModel {
  rawId: string
  match: ModelMatchResult
  checked: boolean
}

/** 用户为别名表未收录（L4 unknown）模型手填的元数据（D2 高级步产物）。 */
export interface ModelOverride {
  contextWindow: number
  maxTokens: number
  /** generic = 纯文本补全；reasoning = reasoning_content 思考分块。 */
  template: 'generic' | 'reasoning'
}

interface Collected {
  presetKey?: ProviderPresetKey
  /** Billing plan id chosen at the preset-billing step (presets with billingModes). */
  billingMode?: string
  baseUrl?: string
  /** Wire protocol for the DIY/custom path (defaults to openai-compatible). */
  protocol?: 'openai' | 'anthropic'
  /** Set when the entered URL was normalized (request-path tail stripped) at collection. */
  urlNormalized?: boolean
  apiKey?: string
  /** User has submitted the credential step; true also represents an intentional empty key. */
  authConfirmed?: boolean
  modelId?: string
  /** Provider name chosen at the naming step — commit happens on confirm. */
  providerName?: string
  contextWindow?: number
  supportsVision?: boolean
  /** Set when the flow is adding a model to an existing provider (3-step path). */
  existingProvider?: string
  /** Capability hints from the endpoint probe (reasoning_content etc.). */
  reasoningSplitHint?: boolean
  /** Probe failure reason, shown on the probe-failed choice step. */
  probeError?: string
  /** Full preset-path probe report — transient, drives the confirm summary. */
  probeReport?: ProbeReport
  /** True when the model list came from the probe (vs manual entry). */
  probedModels?: ProbedModel[]
  /** Thinking answer applied to models without declared thinking capabilities. */
  thinkingSplit?: boolean
  /** Answer to the "replace the current default provider?" question (C1). */
  makeDefault?: boolean
  /** Advanced knobs — data pipe only; the wizard has no UI entry for them yet. */
  advanced?: ProviderAdvancedConfig
  /** D2: hand-entered metadata for alias-table-unknown models, keyed by raw id. */
  modelOverrides?: Record<string, ModelOverride>
}

const ADD_MODEL_CHOICE = 'existing'
const DRAFT_RESUME_CHOICE = 'resume'
const DRAFT_DISCARD_CHOICE = 'discard'

/** Human label per phase, used by the draft-resume progress summary. */
const DRAFT_PHASE_LABEL: Record<string, string> = {
  'pick-existing': '选择服务商',
  'preset-billing': '选择计费模式',
  'preset-apikey': '输入 API 密钥',
  'preset-endpoint': '确认服务地址',
  'preset-probing': '凭证探测',
  'probe-report': '连通性测试',
  'preset-models': '选择模型',
  'capability': '能力检测',
  'ask-default': '设为默认',
  'confirm': '确认保存',
  'diy-protocol': '选择协议类型',
  'diy-url': '填写 API 地址',
  'diy-apikey': '输入 API Key',
  'diy-probing': '端点探测',
  'diy-probe-failed': '端点探测',
  'diy-models': '选择模型',
  'diy-model': '填写模型型号',
  'diy-context': '填写上下文长度',
  'diy-vision': '视觉能力',
  'diy-thinking': '深度思考能力',
  'diy-name': '服务商命名',
}

function presetProviderOptions(): ConnectChoiceOption[] {
  const rank = (k: ProviderPresetKey): number => (RECOMMENDED_PRESETS.includes(k) ? 0 : 1)
  const options: ConnectChoiceOption[] = providerPresetKeys
    .slice()
    .sort((a, b) => rank(a) - rank(b))
    .map(key => {
      const preset = PROVIDER_PRESETS[key]
      const oauth = preset.provider.auth?.type === 'oauth'
      return {
        id: key,
        label: oauth ? `${preset.label}（OAuth 登录）` : preset.label,
        description: preset.keyless
          ? `免密钥 · ${preset.provider.baseUrl}`
          : preset.billingModes && preset.billingModes.length > 0
            ? `计费模式可选 · ${preset.billingModes.map(m => m.label).join(' / ')}`
            : preset.provider.baseUrl,
        recommended: RECOMMENDED_PRESETS.includes(key),
      }
    })
  options.push({
    id: OPENAI_COMPAT_CHOICE,
    label: 'OpenAI API 兼容…',
    description: '网关 / 中转等 OpenAI 兼容端点——填地址与密钥，自动探测模型',
  })
  options.push({
    id: CUSTOM_CHOICE,
    label: '自定义服务商…',
    description: 'OpenAI 兼容 / Anthropic 原生——先选协议，再填地址与密钥，自动探测模型',
  })
  return options
}

function slugify(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'model'
}

function isLikelyUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim())
}

/** Default provider name from the base URL host: api.example.com → example-com. */
export function suggestProviderName(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname
    const slug = slugify(host.replace(/^api\./, '').replace(/\./g, '-'))
    return slug || 'custom'
  } catch {
    return 'custom'
  }
}

function matchDescription(match: ModelMatchResult): string {
  if (!match.entry) return '未知模型——上下文长度按默认值落盘，可事后用 config 修改'
  if (match.tier === 'fuzzy') return `≈ ${match.entry.canonicalId}（低置信推断，元数据请核对）`
  return `已知模型 ${match.entry.canonicalId}，元数据自动回填`
}

const checkMark = (ok: boolean): string => (ok ? '✔' : '✘')

/** Structured diagnosis for probe errors: likely causes + suggested actions. */
function probeDiagnosis(errors: string[]): ProbeLine[] {
  const text = errors.join(' ')
  const causes: string[] = []
  const quotaIssue = /quota|FreeTierOnly|insufficient|arrearage/i.test(text)
  if (quotaIssue) causes.push('免费额度已用完或账号未开通付费——到服务商控制台充值 / 开通按量付费（这是账号配额问题，不是密钥错误）')
  if (/401|403/.test(text)) causes.push('API Key 无效、过期，或无权访问该模型', 'Base URL 与 Key 所属环境不匹配')
  if (/404/.test(text)) causes.push('端点路径可能不正确（缺 "/v1" 后缀），或模型型号不存在')
  if (/timed out|timeout/i.test(text)) causes.push('网络不通、需要代理，或端点响应过慢')
  if (/SSE|stream/i.test(text)) causes.push('端点未返回流式响应——可能不支持流式，或 Base URL 不正确')
  if (causes.length === 0) causes.push('端点未按预期响应')
  const advice: string[] = []
  if (!quotaIssue) advice.push('重新输入 API Key（到服务商控制台确认 Key 状态与余额）')
  advice.push('核对 Base URL 与 Key 所属环境一致', '网络受限时配置代理后重试')
  return [
    { text: '可能原因：', tone: 'head' },
    ...causes.map(c => ({ text: `· ${c}`, tone: 'muted' as const })),
    { text: '建议操作：', tone: 'head' },
    ...advice.map(a => ({ text: `· ${a}`, tone: 'muted' as const })),
  ]
}

/** Connectivity-test report: 3-step checklist, then errors + diagnosis. */
function probeReportLines(report: ProbeReport): ProbeLine[] {
  const lines: ProbeLine[] = [{ text: '连通性测试', tone: 'head' }]
  const reachable = report.modelsOk || report.completionOk
  lines.push({ text: `${checkMark(reachable)} 1/3 检查端点连通性`, tone: reachable ? 'ok' : 'fail' })
  lines.push({
    text: `${checkMark(report.modelsOk)} 2/3 获取模型列表${report.modelsOk ? `（${report.models.length} 个）` : ''}`,
    tone: report.modelsOk ? 'ok' : 'fail',
  })
  const step3 = report.visionTested ? '3/3 视觉真测（发送内置图片）' : '3/3 发送最小推理请求'
  lines.push({
    text: `${checkMark(report.completionOk)} ${step3}${report.completionOk && report.latencyMs !== undefined ? `（首字节 ${report.latencyMs}ms）` : ''}`,
    tone: report.completionOk ? 'ok' : 'fail',
  })
  if (report.hints.reasoningSplit) lines.push({ text: '✔ 探测到思考分块（reasoning_content）', tone: 'ok' })
  // 视觉真测通过：展示模型回答 + 图片真相，供用户肉眼核对（不做自动判分）。
  // 失败时不展示任何模型输出——只保留下方错误与可能原因/建议操作。
  if (report.visionTested && report.completionOk) {
    lines.push({ text: '模型回答：', tone: 'head' })
    lines.push({ text: report.visionAnswer?.trim() ? report.visionAnswer.trim() : '（模型未返回文本）', tone: 'muted' })
    lines.push({ text: '图片真实内容：', tone: 'head' })
    lines.push({ text: VISION_PROBE_GROUND_TRUTH, tone: 'muted' })
  }
  if (report.errors.length === 0) {
    lines.push({ text: '端点配置有效，满足 coding agent 的基本要求。', tone: 'ok' })
    return lines
  }
  for (const err of report.errors) lines.push({ text: `错误：${err}`, tone: 'fail' })
  lines.push(...probeDiagnosis(report.errors))
  return lines
}

/**
 * Capability-check page content: measured rows (completion/streaming/token
 * usage/reasoning split) come from the probe; Vision/Tool Calling are
 * metadata inferences and labeled as such.
 */
function capabilityLines(
  report: ProbeReport,
  picked: Array<{ rawId: string; match: ModelMatchResult }>,
  preset: ProviderPreset,
): ProbeLine[] {
  const known = picked.find(p => p.match.entry !== undefined)
  const template = (preset.provider.models ?? []).find(m => m.id === preset.defaultModelId)
  const meta: { supportsVision?: boolean } | undefined = known?.match.entry?.metadata ?? template
  const lines: ProbeLine[] = [{ text: '能力检测', tone: 'head' }]
  const ok = report.completionOk
  lines.push({ text: `${checkMark(ok)} Chat Completion（实测）`, tone: ok ? 'ok' : 'fail' })
  lines.push({ text: `${checkMark(ok)} 流式输出 SSE（实测）`, tone: ok ? 'ok' : 'fail' })
  lines.push({ text: `${checkMark(ok)} Token 用量统计（实测）`, tone: ok ? 'ok' : 'fail' })
  const split = report.hints.reasoningSplit === true
  lines.push(split
    ? { text: '✔ 思考分块 reasoning_content（实测）', tone: 'ok' }
    : { text: '⚠ 未检测到思考分块（不影响使用）', tone: 'muted' })
  const vision = meta?.supportsVision === true
  if (report.visionTested) {
    lines.push({
      text: `${checkMark(report.completionOk)} Vision 视觉真测（实测：内置图片${report.completionOk ? '描述成功' : '未通过'}）`,
      tone: report.completionOk ? 'ok' : 'fail',
    })
  } else {
    lines.push({ text: `${vision ? '✔' : '⚠'} Vision ${vision ? '支持' : '不支持'}（按模型元数据）`, tone: vision ? 'ok' : 'muted' })
  }
  const toolKnown = known !== undefined || template !== undefined
  lines.push(toolKnown
    ? { text: '✔ Tool Calling 工具调用（已知模型，元数据支持）', tone: 'ok' }
    : { text: '⚠ Tool Calling 未验证（未知模型，建议事后实测）', tone: 'muted' })
  const modelLabel = picked[0]?.rawId ?? preset.defaultModelId
  lines.push(ok
    ? { text: `当前模型 "${modelLabel}" 满足 coding agent 的基本要求。`, tone: 'ok' }
    : { text: `"${modelLabel}" 能力检测不完整——端点异常，详见连通性测试。`, tone: 'fail' })
  return lines
}

/** Normalized restore target produced from a valid draft. */
interface RestoredState {
  phase: Exclude<Phase, 'draft'>
  collected: Collected
  /** Text to preload into the TUI input buffer (masked steps render it as •). */
  restoredInput?: string
}

export class ConnectFlow {
  private phase: Phase = 'provider'
  private readonly collected: Collected = {}
  private pendingRestore?: RestoredState
  private draftRejectedFlag = false
  private wasDiscardedFlag = false
  private restoredInputValue?: string
  /** Type-to-search query on the models multi-choice steps — transient UI state. */
  private modelsFilter = ''
  /** D2: rawIds of checked unknown models still awaiting manual metadata. */
  private unknownQueue: string[] = []
  private unknownTotal = 0
  /** Form draft for the unknown model currently being detailed (single-step form). */
  private advancedDraft: { contextWindow: string; maxTokens: string; template: 'generic' | 'reasoning'; applyRest: boolean } = {
    contextWindow: String(DEFAULT_CONTEXT_WINDOW),
    maxTokens: String(DEFAULT_ADVANCED_MAX_OUTPUT),
    template: 'generic',
    applyRest: false,
  }
  /** Where the advanced queue exits to (preset path → capability, DIY → thinking). */
  private advancedReturnPhase: 'capability' | 'diy-thinking' = 'capability'

  constructor(
    private readonly existing: ConnectProviderRef[] = [],
    draft?: ConnectDraft,
    restoredKey?: string,
    private readonly currentDefault?: string,
  ) {
    if (draft) {
      const restored = this.normalizeDraft(draft, restoredKey)
      if (restored) {
        this.pendingRestore = restored
        this.phase = 'draft'
      } else {
        // Structurally valid but semantically unrestorable — app clears the file.
        this.draftRejectedFlag = true
      }
    }
  }

  /** Draft parsed fine but could not be restored (stale preset, deleted provider). */
  get draftRejected(): boolean {
    return this.draftRejectedFlag
  }

  /** Input text to preload after resume (app assigns it to its input buffer). */
  get restoredInput(): string | undefined {
    return this.restoredInputValue
  }

  /** Read-once variant for the app loop: returns the preload text and clears it. */
  takeRestoredInput(): string | undefined {
    const value = this.restoredInputValue
    this.restoredInputValue = undefined
    return value
  }

  /** Still sitting on the resume/discard prompt — Esc must not touch the file. */
  draftPromptPending(): boolean {
    return this.phase === 'draft'
  }

  /** The user chose 重新开始 on the resume prompt. */
  wasDraftDiscarded(): boolean {
    return this.wasDiscardedFlag
  }

  /** 是否有值得持久化的进展（驱动 Esc 落盘）——草稿从「密钥已保存」起才算数。 */
  hasProgress(): boolean {
    if (this.phase === 'draft') return false
    const c = this.collected
    // 密钥步骤已提交才算进展；authConfirmed 同时覆盖无密钥本地端点。
    if (c.authConfirmed || c.apiKey !== undefined) return true
    if (c.existingProvider) return true // 加模型路径无密钥步，进入流程即有进展
    const key = c.presetKey
    if (key && PROVIDER_PRESETS[key]?.keyless
      && this.phase !== 'provider' && this.phase !== 'pick-existing' && this.phase !== 'preset-billing') return true
    return false
  }

  /**
   * Snapshot for disk persistence. Returns undefined when there is no real
   * progress (caller then skips the write). `pendingInput` carries text typed
   * but not yet submitted — the TUI input buffer lives outside this class.
   */
  toDraft(pendingInput?: string): ConnectDraft | undefined {
    if (!this.hasProgress()) return undefined
    const c = this.collected
    const collected: ConnectDraftCollected = {
      ...(c.presetKey ? { presetKey: c.presetKey } : {}),
      ...(c.billingMode ? { billingMode: c.billingMode } : {}),
      ...(c.baseUrl ? { baseUrl: c.baseUrl } : {}),
      ...(c.protocol ? { protocol: c.protocol } : {}),
      // apiKey is deliberately absent: the draft never holds plaintext keys —
      // the app layer attaches a secrets-store keyRef before saving.
      ...(c.modelId ? { modelId: c.modelId } : {}),
      ...(c.providerName ? { providerName: c.providerName } : {}),
      ...(c.contextWindow !== undefined ? { contextWindow: c.contextWindow } : {}),
      ...(c.supportsVision !== undefined ? { supportsVision: c.supportsVision } : {}),
      ...(c.existingProvider ? { existingProvider: c.existingProvider } : {}),
      ...(c.authConfirmed !== undefined ? { authConfirmed: c.authConfirmed } : {}),
      ...(c.makeDefault !== undefined ? { makeDefault: c.makeDefault } : {}),
      ...(c.reasoningSplitHint !== undefined ? { reasoningSplitHint: c.reasoningSplitHint } : {}),
      ...(c.thinkingSplit !== undefined ? { thinkingSplit: c.thinkingSplit } : {}),
      ...(c.advanced ? { advanced: c.advanced } : {}),
      // Matcher results are NOT persisted (alias-table snapshots drift across
      // versions) — only the checkbox selection; matches recompute on resume.
      ...(c.probedModels && c.probedModels.length > 0
        ? { probedSelection: c.probedModels.map(p => ({ rawId: p.rawId, checked: p.checked })) }
        : {}),
    }
    const trimmed = pendingInput?.trim()
    // 未知模型补参子步是瞬态——草稿回落到模型选择步（勾选集已持久化，
    // 恢复后重走补参；半途填的数字不入库）。
    let phase: Phase = this.phase === 'model-advanced'
      ? (this.advancedReturnPhase === 'capability' ? 'preset-models' : 'diy-models')
      : this.phase
    // 高级设置子菜单同为瞬态——回落确认步（已存旋钮值随 collected.advanced 持久化）。
    if (phase === 'advanced-settings' || phase === 'advanced-request-timeout' || phase === 'advanced-max-retries' || phase === 'advanced-temperature' || phase === 'advanced-proxy') {
      phase = 'confirm'
    }
    // 换型号重探的挑选步是瞬态——回落报告步（恢复后再从报告页进入）。
    if (phase === 'reprobe-pick') phase = 'probe-report'
    return {
      version: 1,
      savedAt: Date.now(),
      phase,
      collected,
      ...(trimmed ? { pendingInput: trimmed } : {}),
    }
  }

  /**
   * What the app layer needs to persist the key via secrets-store before
   * saving a draft: the in-memory key, the natural ref name (presetKey), and
   * whether the user is mid-typing on a key step (pendingInput must then be
   * dropped — it may be a partial plaintext key).
   */
  draftSecretInfo(): { apiKey?: string; presetKey?: string; onKeyStep: boolean } {
    return {
      apiKey: this.collected.apiKey,
      presetKey: this.collected.presetKey,
      onKeyStep: this.phase === 'preset-apikey' || this.phase === 'diy-apikey',
    }
  }

  /**
   * Draft → RestoredState with a fixed downgrade chain. Restores to the exact
   * saved step whenever its prerequisites survive (step number must round-trip);
   * transient phases (probing/probe-failed) fall back to their trigger step so
   * Enter re-fires the probe; slides DOWN only when prerequisite data is
   * missing; rejects wholesale on stale presets or deleted providers.
   */
  private normalizeDraft(draft: ConnectDraft, restoredKey?: string): RestoredState | undefined {
    const c = draft.collected
    const pending = draft.pendingInput
    const base: Collected = {
      ...(c.baseUrl ? { baseUrl: c.baseUrl } : {}),
      ...(c.protocol ? { protocol: c.protocol } : {}),
      ...(restoredKey ? { apiKey: restoredKey } : {}),
      ...(c.authConfirmed !== undefined ? { authConfirmed: c.authConfirmed } : {}),
      ...(c.makeDefault !== undefined ? { makeDefault: c.makeDefault } : {}),
      ...(c.reasoningSplitHint !== undefined ? { reasoningSplitHint: c.reasoningSplitHint } : {}),
      ...(c.thinkingSplit !== undefined ? { thinkingSplit: c.thinkingSplit } : {}),
      ...(c.advanced ? { advanced: c.advanced } : {}),
    }
    const rebuildProbed = (): ProbedModel[] | undefined => {
      if (!c.probedSelection || c.probedSelection.length === 0) return undefined
      const matches = matchModelIds(c.probedSelection.map(s => s.rawId), aliasTableWithProbeInfos(undefined))
      return c.probedSelection.map((sel, i) => ({
        rawId: sel.rawId,
        // matchModelIds maps input 1:1 — index i is always present.
        match: matches[i]!,
        checked: sel.checked,
      }))
    }
    const existingValid = (name?: string): boolean => !!name && this.existing.some(p => p.name === name)
    const billingValid = (key: ProviderPresetKey): boolean => {
      const modes = PROVIDER_PRESETS[key].billingModes
      if (!modes || modes.length === 0) return true
      return modes.some(m => m.id === c.billingMode)
    }
    const billingSpread = (): { billingMode?: string } => (c.billingMode ? { billingMode: c.billingMode } : {})
    const baseUrlSpread = (): { baseUrl?: string } => (c.baseUrl ? { baseUrl: c.baseUrl } : {})

    switch (draft.phase) {
      case 'provider':
        return undefined
      case 'pick-existing':
        return { phase: 'pick-existing', collected: {} }
      case 'preset-billing': {
        const key = c.presetKey
        if (!key || !isProviderPresetKey(key)) return undefined
        const preset = PROVIDER_PRESETS[key]
        if (!preset || preset.provider.auth?.type === 'oauth' || !preset.billingModes) return undefined
        return { phase: 'preset-billing', collected: { presetKey: key } }
      }
      case 'preset-apikey': {
        const key = c.presetKey
        if (!key || !isProviderPresetKey(key)) return undefined
        const preset = PROVIDER_PRESETS[key]
        if (!preset || preset.provider.auth?.type === 'oauth') return undefined
        if (!billingValid(key)) return { phase: 'preset-billing', collected: { presetKey: key } }
        return { phase: 'preset-apikey', collected: { presetKey: key, ...billingSpread() }, restoredInput: pending ?? '' }
      }
      case 'preset-endpoint': {
        const key = c.presetKey
        if (!key || !isProviderPresetKey(key)) return undefined
        const preset = PROVIDER_PRESETS[key]
        if (!preset || preset.provider.auth?.type === 'oauth') return undefined
        if (!billingValid(key)) return { phase: 'preset-billing', collected: { presetKey: key } }
        return {
          phase: 'preset-endpoint',
          collected: {
            presetKey: key,
            ...billingSpread(),
            ...(restoredKey ? { apiKey: restoredKey } : {}),
            ...(c.baseUrl ? { baseUrl: c.baseUrl } : {}),
          },
          restoredInput: pending ?? '',
        }
      }
      case 'preset-probing':
      case 'probe-report': {
        // Transient phases — preset path resumes at the endpoint-confirm step
        // (key already restored via keyRef; Enter re-fires the probe).
        const key = c.presetKey
        if (!key || !isProviderPresetKey(key)) {
          // DIY 探测瞬态——回地址步预填地址，重提即再探测（密钥已随 keyRef 恢复）。
          if (c.baseUrl) return { phase: 'diy-url', collected: base, restoredInput: c.baseUrl }
          return undefined
        }
        const preset = PROVIDER_PRESETS[key]
        if (!preset || preset.provider.auth?.type === 'oauth') return undefined
        if (!billingValid(key)) return { phase: 'preset-billing', collected: { presetKey: key } }
        return {
          phase: 'preset-endpoint',
          collected: {
            presetKey: key,
            ...billingSpread(),
            ...(restoredKey ? { apiKey: restoredKey } : {}),
            ...(c.baseUrl ? { baseUrl: c.baseUrl } : {}),
          },
          restoredInput: '',
        }
      }
      case 'preset-models': {
        const key = c.presetKey
        if (!key || !isProviderPresetKey(key)) return undefined
        const preset = PROVIDER_PRESETS[key]
        if (!preset || preset.provider.auth?.type === 'oauth') return undefined
        if (!billingValid(key)) return { phase: 'preset-billing', collected: { presetKey: key } }
        const probed = rebuildProbed()
        if (!probed) return { phase: 'preset-apikey', collected: { presetKey: key, ...billingSpread() }, restoredInput: restoredKey ?? '' }
        return { phase: 'preset-models', collected: { presetKey: key, ...billingSpread(), ...baseUrlSpread(), ...(restoredKey ? { apiKey: restoredKey } : {}), probedModels: probed } }
      }
      case 'capability': {
        const key = c.presetKey
        if (!key || !isProviderPresetKey(key)) return undefined
        const preset = PROVIDER_PRESETS[key]
        if (!preset || preset.provider.auth?.type === 'oauth' || preset.keyless) return undefined
        if (!billingValid(key)) return { phase: 'preset-billing', collected: { presetKey: key } }
        const probed = rebuildProbed()
        if (!probed) return { phase: 'preset-apikey', collected: { presetKey: key, ...billingSpread() }, restoredInput: restoredKey ?? '' }
        return {
          phase: 'capability',
          collected: { presetKey: key, ...billingSpread(), ...baseUrlSpread(), ...(restoredKey ? { apiKey: restoredKey } : {}), probedModels: probed },
        }
      }
      case 'ask-default':
      case 'confirm': {
        // 前提数据齐全 → 精确恢复到存档步（步骤号与保存时往返一致）；
        // 缺数据才下滑：DIY 到命名/密钥步，keyless 到思考步，预设到密钥步。
        const exact = draft.phase === 'confirm' ? 'confirm' as const : 'ask-default' as const
        const key = c.presetKey
        if (key && isProviderPresetKey(key) && PROVIDER_PRESETS[key]?.keyless && c.baseUrl) {
          const probed = rebuildProbed()
          const collected: Collected = { ...base }
          if (probed) collected.probedModels = probed
          else if (c.modelId) collected.modelId = c.modelId
          if (c.thinkingSplit !== undefined) return { phase: exact, collected }
          return { phase: 'diy-thinking', collected }
        }
        if (c.baseUrl) {
          const probed = rebuildProbed()
          const hasModels = probed !== undefined || !!c.modelId
          if (!hasModels) return { phase: 'diy-apikey', collected: base, restoredInput: restoredKey ?? '' }
          const collected: Collected = { ...base }
          if (probed) collected.probedModels = probed
          else if (c.modelId) collected.modelId = c.modelId
          if (c.providerName) return { phase: exact, collected: { ...collected, providerName: c.providerName } }
          return { phase: 'diy-name', collected, restoredInput: c.providerName ?? '' }
        }
        if (!key || !isProviderPresetKey(key)) return undefined
        const preset = PROVIDER_PRESETS[key]
        if (!preset || preset.provider.auth?.type === 'oauth') return undefined
        if (!billingValid(key)) return { phase: 'preset-billing', collected: { presetKey: key } }
        const probedSel = rebuildProbed()
        const collected: Collected = { presetKey: key, ...billingSpread(), ...baseUrlSpread(), ...(restoredKey ? { apiKey: restoredKey } : {}) }
        if (probedSel) collected.probedModels = probedSel
        // 有勾选集 → 常规确认步；无模型 → 「跳过探测直接保存」的草稿，同样可确认。
        return { phase: exact, collected }
      }
      case 'diy-protocol':
        return { phase: 'diy-protocol', collected: {} }
      case 'diy-url':
        return {
          phase: 'diy-url',
          // authConfirmed distinguishes an intentional empty key from a key step
          // the user has not submitted yet; keep it so address resubmission can re-probe.
          collected: base,
          restoredInput: pending ?? c.baseUrl ?? '',
        }
      case 'diy-apikey': {
        if (!c.baseUrl) return undefined
        return { phase: 'diy-apikey', collected: base, restoredInput: pending ?? restoredKey ?? '' }
      }
      case 'diy-probing':
      case 'diy-probe-failed': {
        // 探测瞬态——回地址步预填地址；重提地址直接再探测，密钥不必重输。
        if (!c.baseUrl) return undefined
        return { phase: 'diy-url', collected: base, restoredInput: c.baseUrl }
      }
      case 'diy-models': {
        if (!c.baseUrl) return undefined
        const probed = rebuildProbed()
        if (!probed) return { phase: 'diy-apikey', collected: base, restoredInput: restoredKey ?? '' }
        return { phase: 'diy-models', collected: { ...base, probedModels: probed } }
      }
      case 'diy-model': {
        if (c.existingProvider) {
          if (!existingValid(c.existingProvider)) return undefined
          return {
            phase: 'diy-model',
            collected: { existingProvider: c.existingProvider },
            restoredInput: pending ?? c.modelId ?? '',
          }
        }
        if (!c.baseUrl) return undefined
        return { phase: 'diy-model', collected: base, restoredInput: pending ?? c.modelId ?? '' }
      }
      case 'diy-context': {
        if (!existingValid(c.existingProvider) || !c.modelId) return undefined
        return {
          phase: 'diy-context',
          collected: { existingProvider: c.existingProvider, modelId: c.modelId },
          restoredInput: pending ?? '',
        }
      }
      case 'diy-vision': {
        if (!existingValid(c.existingProvider) || !c.modelId || c.contextWindow === undefined) return undefined
        return {
          phase: 'diy-vision',
          collected: { existingProvider: c.existingProvider, modelId: c.modelId, contextWindow: c.contextWindow },
        }
      }
      case 'diy-thinking':
      case 'diy-name': {
        // Downgrade chain: name → thinking → (models ∥ manual model) → apikey.
        const probed = rebuildProbed()
        const hasModels = probed !== undefined || !!c.modelId
        if (c.baseUrl) {
          const collected: Collected = { ...base }
          if (probed) collected.probedModels = probed
          else if (c.modelId) collected.modelId = c.modelId
          if (draft.phase === 'diy-name' && hasModels && c.thinkingSplit !== undefined) {
            return { phase: 'diy-name', collected }
          }
          if (hasModels) return { phase: 'diy-thinking', collected }
          return { phase: 'diy-apikey', collected: base, restoredInput: restoredKey ?? '' }
        }
        return undefined
      }
      default:
        return undefined
    }
  }

  /** n 是全路径编号（diy 9 步：协议 > 地址 > 密钥 > 探测 > 报告 > 模型 > 思考 > 命名 > 确认）；加模型路径少 url/apikey 两步，显示 n-1 / 3。 */
  private diyStepLabel(n: number): string {
    return this.collected.existingProvider ? `步骤 ${n - 1} / 3` : `步骤 ${n} / 9`
  }

  /** preset 路径编号。n 取 6 步骨架的序号；带计费模式步的 preset 整体后移一位（共 7 步）。 */
  private presetStepLabel(n: number): string {
    const key = this.collected.presetKey
    const hasBilling = !!key && (PROVIDER_PRESETS[key].billingModes?.length ?? 0) > 0
    return hasBilling ? `步骤 ${n + 1} / 7` : `步骤 ${n} / 6`
  }

  /** 未知模型高级子步沿用模型选择步的编号——总步数不因补参而变。 */
  private advancedStepLabel(): string {
    const key = this.collected.presetKey
    const presetPath = !!key && !PROVIDER_PRESETS[key].keyless && !this.collected.providerName
    return presetPath ? this.presetStepLabel(4) : this.diyStepLabel(6)
  }

  /** 高级设置子菜单沿用确认步编号——可选入口不占主流程步数（OPT-003）。 */
  private confirmStepLabel(): string {
    const key = this.collected.presetKey
    const isPresetPath = !!key && !PROVIDER_PRESETS[key].keyless && !this.collected.providerName
    return isPresetPath ? this.presetStepLabel(6) : this.diyStepLabel(9)
  }

  /** 写/清单个高级旋钮；undefined = 删除该键（恢复内置默认），全空则整体回落 undefined。 */
  private applyAdvancedKnob<K extends keyof ProviderAdvancedConfig>(key: K, value: ProviderAdvancedConfig[K] | undefined): void {
    const adv = this.collected.advanced ?? {}
    if (value === undefined) delete adv[key]
    else adv[key] = value
    this.collected.advanced = Object.keys(adv).length > 0 ? adv : undefined
  }

  /** 所选计费模式对应的官方地址；无计费步时退回 preset 默认地址。 */
  private presetBaseUrl(): string {
    const preset = PROVIDER_PRESETS[this.collected.presetKey!]
    const mode = preset.billingModes?.find(m => m.id === this.collected.billingMode)
    return mode?.baseUrl ?? preset.provider.baseUrl
  }

  /** The provider name this walk will commit (preset key, or the DIY naming answer). */
  private targetProviderName(): string | undefined {
    return this.collected.presetKey ?? this.collected.providerName
  }

  /** C1: 只有已存在「另一个」默认服务商时才问是否替换；首个服务商静默设默认。 */
  private needsDefaultAsk(): boolean {
    const target = this.targetProviderName()
    return !!this.currentDefault && !!target && this.currentDefault !== target
  }

  /** Forward transition into the confirm gate — via the default question when it applies. */
  private gotoConfirm(): void {
    this.phase = this.needsDefaultAsk() && this.collected.makeDefault === undefined
      ? 'ask-default'
      : 'confirm'
  }

  /** The view for the current step. */
  view(): ConnectView {
    switch (this.phase) {
      case 'draft': {
        const r = this.pendingRestore
        const label = r ? (DRAFT_PHASE_LABEL[r.phase] ?? r.phase) : '上次进度'
        const detail = r
          ? (r.collected.baseUrl
            ?? (r.collected.presetKey ? PROVIDER_PRESETS[r.collected.presetKey]?.label : undefined)
            ?? r.collected.existingProvider
            ?? '')
          : ''
        return {
          kind: 'choice',
          title: '发现上次的配置进度',
          subtitle: `上次进行到：${label}${detail ? `（${detail}）` : ''}`,
          options: [
            { id: DRAFT_RESUME_CHOICE, label: '继续上次配置', recommended: true },
            { id: DRAFT_DISCARD_CHOICE, label: '重新开始', description: '丢弃已保存的草稿' },
          ],
        }
      }
      case 'provider': {
        const options = presetProviderOptions()
        if (this.existing.length > 0) {
          options.push({
            id: ADD_MODEL_CHOICE,
            label: '为已有服务商添加模型…',
            description: '给已配置的服务商追加一个模型（不改动现有配置）',
          })
        }
        return {
          kind: 'choice',
          title: '连接模型服务商',
          subtitle: '选择一个内置服务商（自动带出接口地址），或自定义',
          options,
        }
      }
      case 'pick-existing':
        return {
          kind: 'choice',
          title: '为哪个服务商添加模型？',
          subtitle: '选择已配置的服务商，只需填模型信息（无需 API 地址 / 密钥）',
          options: this.existing.map(p => ({
            id: p.name,
            label: p.label ?? p.name,
            description: `${p.modelCount} 个模型`,
          })),
        }
      case 'preset-billing': {
        const preset = PROVIDER_PRESETS[this.collected.presetKey!]
        return {
          kind: 'choice',
          title: `选择 ${preset.label} 的计费模式`,
          subtitle: '不同计费模式对应不同的官方服务地址，下一步将按所选模式预填',
          stepLabel: this.presetStepLabel(1),
          options: (preset.billingModes ?? []).map((m, i) => ({
            id: m.id,
            label: m.label,
            description: m.description ?? m.baseUrl,
            recommended: i === 0,
          })),
        }
      }
      case 'preset-apikey': {
        const preset = PROVIDER_PRESETS[this.collected.presetKey!]
        return {
          kind: 'input',
          title: `输入 ${preset.label} 的 API 密钥`,
          subtitle: CONFIG_HINT,
          stepLabel: this.presetStepLabel(2),
          masked: true,
        }
      }
      case 'preset-endpoint': {
        const preset = PROVIDER_PRESETS[this.collected.presetKey!]
        const url = this.collected.baseUrl ?? this.presetBaseUrl()
        const hasPlaceholder = url.includes('{')
        return {
          kind: 'input',
          title: `确认 ${preset.label} 的服务地址`,
          subtitle: hasPlaceholder
            ? '已按所选计费模式的官方地址模板预填——请把 {WorkspaceId} 替换为你的真实业务空间 ID（百炼控制台 → 左侧「业务空间」→ 进入空间查看 ID）'
            : `已按官方地址预填（${preset.provider.protocol ?? 'openai'} 协议），回车确认或直接修改`,
          stepLabel: this.presetStepLabel(2),
          placeholder: url,
          defaultValue: url,
        }
      }
      case 'preset-probing':
        return {
          kind: 'busy',
          title: '正在校验凭证并获取模型列表…',
          subtitle: '拉取模型列表并做一次最小补全（消耗极少量 token）',
          stepLabel: this.presetStepLabel(3),
        }
      case 'probe-report': {
        const preset = this.collected.presetKey ? PROVIDER_PRESETS[this.collected.presetKey] : undefined
        const isPresetPath = !!preset && !preset.keyless
        const keylessPreset = !!preset && preset.keyless
        const report = this.collected.probeReport
        const usable = !!report && (report.modelsOk || report.completionOk)
        const afterModels = (this.collected.probedModels?.length ?? 0) > 0
        const options: ConnectChoiceOption[] = []
        if (usable) {
          options.push({
            id: 'continue',
            label: isPresetPath ? (afterModels ? '继续保存确认' : '继续选择模型') : '继续',
            recommended: true,
          })
        }
        if (isPresetPath) {
          if (!usable) options.push({ id: 'rekey', label: '重新输入 API Key', recommended: true })
          else options.push({ id: 'rekey', label: '重新输入 API Key' })
          options.push({ id: 'edit-url', label: '修改服务地址', description: this.presetBaseUrl() })
          if (!usable) options.push({ id: 'save-anyway', label: '跳过探测直接保存', description: '不校验端点；配置仍可事后用 /connect 修正' })
        } else if (keylessPreset) {
          options.push({ id: 'edit-url', label: '修改服务地址', description: this.presetBaseUrl(), ...(!usable ? { recommended: true } : {}) })
        } else {
          options.push({ id: 'rekey', label: '重新输入 API Key' })
        }
        // 补全失败但拉到了模型列表 → 换一个型号重探（聚合站常见：建议型号没收录）。
        if (report && !report.completionOk && report.models.length > 0) {
          options.push({ id: 'reprobe-pick', label: '换个模型重探', description: `从探测到的 ${report.models.length} 个型号里另选一个再试` })
        }
        return {
          kind: 'choice',
          title: usable ? '连通性测试通过' : '连通性测试未通过',
          subtitle: `${preset ? `${preset.label} · ${this.collected.baseUrl ?? this.presetBaseUrl()}` : this.collected.baseUrl}${this.collected.urlNormalized ? '（已规范化：去除请求路径尾段）' : ''}`,
          stepLabel: isPresetPath ? this.presetStepLabel(3) : this.diyStepLabel(5),
          report: report ? probeReportLines(report) : undefined,
          options,
        }
      }
      case 'reprobe-pick': {
        // 换模型重探：从已拉取的型号里挑一个再试。别名表认识的识图/多模态档
        // 排在最前——聚合站命名杂，视觉探测尤其需要用户选对型号。
        const models = this.collected.probeReport?.models ?? []
        const sorted = models.slice().sort((a, b) => Number(isVisionCapableId(b)) - Number(isVisionCapableId(a)))
        const firstVisionIdx = sorted.findIndex(id => isVisionCapableId(id))
        const preset = this.collected.presetKey ? PROVIDER_PRESETS[this.collected.presetKey] : undefined
        const isPresetPath = !!preset && !preset.keyless
        return {
          kind: 'choice',
          title: '选择重探用的模型',
          subtitle: '回车即用所选型号重新探测；视觉真测需选识图/多模态型号',
          stepLabel: isPresetPath ? this.presetStepLabel(3) : this.diyStepLabel(5),
          options: sorted.map((id, i) => ({
            id,
            label: id,
            description: isVisionCapableId(id) ? '识图/多模态（别名表认识，可跑视觉真测）' : undefined,
            ...(i === firstVisionIdx ? { recommended: true } : {}),
          })),
        }
      }
      case 'preset-models': {
        const probed = this.collected.probedModels ?? []
        const preset = PROVIDER_PRESETS[this.collected.presetKey!]
        const templateIds = new Set((preset.provider.models ?? []).map(m => m.id))
        return {
          kind: 'multi-choice',
          title: '选择要添加的模型',
          subtitle: preset.aggregator
            ? '聚合平台模型多——默认全不选；输入关键字过滤，Ctrl+A 全选'
            : '预设模型已勾选；探测新发现的按别名表回填元数据，空格可调整',
          stepLabel: this.presetStepLabel(4),
          options: this.filteredModelIndexes(probed).map(i => ({
            id: String(i),
            label: probed[i]!.rawId,
            description: `${templateIds.has(probed[i]!.rawId) ? '预设' : '探测发现'} · ${matchDescription(probed[i]!.match)}`,
            checked: probed[i]!.checked,
          })),
          filter: this.modelsFilter,
          optionTotal: probed.length,
        }
      }
      case 'capability': {
        const preset = PROVIDER_PRESETS[this.collected.presetKey!]
        const picked = this.collected.probedModels ?? []
        const names = picked.map(p => p.rawId).slice(0, 3).join('、') || preset.defaultModelId
        return {
          kind: 'choice',
          title: '能力检测',
          subtitle: `${preset.label} · ${names}`,
          stepLabel: this.presetStepLabel(5),
          report: this.collected.probeReport
            ? capabilityLines(this.collected.probeReport, picked, preset)
            : undefined,
          options: [
            { id: 'continue', label: '继续保存确认', recommended: true },
            { id: 'back', label: '返回模型选择' },
          ],
        }
      }
      case 'ask-default': {
        const presetPath = !!this.collected.presetKey && !PROVIDER_PRESETS[this.collected.presetKey].keyless
        const target = this.targetProviderName() ?? '新服务商'
        return {
          kind: 'choice',
          title: '设为默认服务商？',
          subtitle: `当前默认是 ${this.currentDefault}——保存后可随时用 /model 切换`,
          stepLabel: presetPath ? this.presetStepLabel(6) : this.diyStepLabel(9),
          options: [
            { id: 'yes', label: `是，以后默认用 ${target}`, recommended: true },
            { id: 'no', label: `否，只添加，默认仍是 ${this.currentDefault}` },
            { id: 'back', label: '返回上一步' },
          ],
        }
      }
      case 'confirm': {
        return {
          kind: 'choice',
          title: '确认保存配置',
          subtitle: this.confirmSummary(),
          stepLabel: this.confirmStepLabel(),
          options: [
            { id: 'save', label: '确认并保存', recommended: true },
            { id: 'advanced', label: '高级设置…', description: '超时 / 重试 / 温度 / 代理——仅少数场景需要' },
            { id: 'back', label: '返回上一步' },
          ],
        }
      }
      case 'advanced-settings': {
        const adv = this.collected.advanced ?? {}
        return {
          kind: 'choice',
          title: '高级设置',
          subtitle: '按需调整；「完成」返回确认步',
          stepLabel: this.confirmStepLabel(),
          options: [
            { id: 'requestTimeoutMs', label: '请求超时', description: adv.requestTimeoutMs !== undefined ? `${adv.requestTimeoutMs} ms` : '未设置（内置 10 分钟硬顶）' },
            { id: 'maxRetries', label: '重试次数', description: adv.maxRetries !== undefined ? `${adv.maxRetries} 次` : '未设置（按错误类别默认）' },
            { id: 'temperature', label: '采样温度', description: adv.temperature !== undefined ? String(adv.temperature) : '未设置（思考模式下不生效）' },
            { id: 'proxy', label: 'HTTP 代理', description: adv.proxy ?? '未设置（跟随全局 network.proxy）' },
            { id: 'done', label: '完成', recommended: true },
          ],
        }
      }
      case 'advanced-request-timeout':
        return {
          kind: 'input',
          title: '高级设置：请求超时',
          subtitle: '单次流式请求的总时限（毫秒），替换内置 10 分钟硬顶；回车清空 = 恢复内置',
          stepLabel: this.confirmStepLabel(),
          placeholder: '例如 300000',
        }
      case 'advanced-max-retries':
        return {
          kind: 'input',
          title: '高级设置：重试次数',
          subtitle: '可重试错误（限流/超时/网络抖动）的最大重试次数，0 = 禁用；回车清空 = 按错误类别默认（细粒度退避与客户端限速见 config 的 retry 块）',
          stepLabel: this.confirmStepLabel(),
          placeholder: '0–20',
        }
      case 'advanced-temperature':
        return {
          kind: 'input',
          title: '高级设置：采样温度',
          subtitle: '0–2，例如 0 = 贪心解码；思考模式下不注入（推理服务端拒绝调温）；回车清空 = 用服务端默认',
          stepLabel: this.confirmStepLabel(),
          placeholder: '0–2',
        }
      case 'advanced-proxy':
        return {
          kind: 'input',
          title: '高级设置：HTTP 代理',
          subtitle: '该服务商专用代理，优先于全局 network.proxy；回车清空 = 取消',
          stepLabel: this.confirmStepLabel(),
          placeholder: 'http://127.0.0.1:7890',
        }
      case 'diy-protocol':
        return {
          kind: 'choice',
          title: '选择 API 协议',
          subtitle: '大多数中转/网关是 OpenAI 兼容协议；Anthropic 原生端点选第二项',
          stepLabel: this.diyStepLabel(1),
          options: [
            { id: 'openai', label: 'OpenAI 兼容（/v1/chat/completions）', recommended: true },
            { id: 'anthropic', label: 'Anthropic 原生（/v1/messages）' },
          ],
        }
      case 'diy-url':
        return {
          kind: 'input',
          title: '输入服务商 API 地址',
          subtitle: this.collected.protocol === 'anthropic'
            ? '例如 https://api.anthropic.com（协议：Anthropic 原生）'
            : '例如 https://api.deepseek.com/v1（可粘贴）',
          stepLabel: this.diyStepLabel(2),
          placeholder: 'https://',
        }
      case 'diy-apikey':
        return {
          kind: 'input',
          title: '输入 API Key',
          subtitle: `${CONFIG_HINT}；本地端点（Ollama/vLLM）可直接回车跳过`,
          stepLabel: this.diyStepLabel(3),
          masked: true,
        }
      case 'diy-probing':
        return {
          kind: 'busy',
          title: '正在探测端点…',
          subtitle: '拉取模型列表（GET /models）并做一次最小补全，消耗极少量 token',
          stepLabel: this.diyStepLabel(4),
        }
      case 'diy-probe-failed':
        return {
          kind: 'choice',
          title: '端点探测未成功',
          subtitle: this.collected.probeError ?? '未能获取模型列表',
          stepLabel: this.diyStepLabel(4),
          options: [
            { id: 'manual', label: '手动输入模型型号', description: '跳过探测，直接填写模型信息' },
            { id: 'back', label: '返回修改 API 地址', description: '地址可能缺 /v1 后缀或拼写有误' },
          ],
        }
      case 'diy-models': {
        const probed = this.collected.probedModels ?? []
        return {
          kind: 'multi-choice',
          title: '选择要添加的模型',
          subtitle: '探测到的模型已按别名表回填元数据；空格取消不需要的项，输入关键字过滤',
          stepLabel: this.diyStepLabel(6),
          options: this.filteredModelIndexes(probed).map(i => ({
            id: String(i),
            label: probed[i]!.rawId,
            description: matchDescription(probed[i]!.match),
            checked: probed[i]!.checked,
          })),
          filter: this.modelsFilter,
          optionTotal: probed.length,
        }
      }
      case 'model-advanced': {
        const rawId = this.unknownQueue[0] ?? ''
        const idx = this.unknownTotal - this.unknownQueue.length + 1
        const rest = this.unknownQueue.length - 1
        const queued = (this.collected.probedModels ?? []).find(p => p.rawId === rawId)
        const partialKnown = queued?.match.entry !== undefined
        const d = this.advancedDraft
        const fields: ConnectFormField[] = [
          { id: 'contextWindow', kind: 'text', label: '上下文窗口', value: d.contextWindow, hint: `官方文档的真实值；回车用默认 ${DEFAULT_CONTEXT_WINDOW}` },
          { id: 'maxTokens', kind: 'text', label: '最大输出 tokens', value: d.maxTokens, hint: `单次输出上限，不得超过窗口；默认 ${DEFAULT_ADVANCED_MAX_OUTPUT}` },
          {
            id: 'template',
            kind: 'toggle',
            label: '能力模板',
            value: d.template === 'generic' ? '通用文本模型（无思考输出）' : '推理模型（reasoning_content 返回思考）',
            hint: '决定思考路由配置，拿不准选「通用文本」',
          },
        ]
        if (rest > 0) {
          fields.push({
            id: 'applyRest',
            kind: 'toggle',
            label: `套用到其余 ${rest} 个未知模型`,
            value: d.applyRest ? '是' : '否',
          })
        }
        return {
          kind: 'form',
          title: '模型补参',
          subtitle: partialKnown
            ? `${rawId}（${idx}/${this.unknownTotal}）官方规格不完整——已预填已知项，核对后 Enter 确认`
            : `${rawId}（${idx}/${this.unknownTotal}）不在别名表——↑↓ 选字段，数字可直接编辑，Enter 确认`,
          stepLabel: this.advancedStepLabel(),
          fields,
        }
      }
      case 'diy-model':
        return {
          kind: 'input',
          title: '输入模型型号',
          subtitle: this.collected.existingProvider
            ? '例如 deepseek-v4-flash'
            : '探测未发现模型列表——手动填写一个模型型号（例如 deepseek-v4-flash）',
          stepLabel: this.diyStepLabel(this.collected.existingProvider ? 2 : 6),
        }
      case 'diy-context':
        return {
          kind: 'input',
          title: '模型最大上下文长度 (tokens)',
          // 上下文窗口驱动自动压缩阈值 —— 必须照模型服务商官方 API 的真实值填。
          // 填小了会过早压缩(丢上下文、碎缓存);填大了会撞 API 上限来不及自救。
          subtitle: '请照官方 API 文档的真实值填(它决定自动压缩点);DeepSeek V4 填 1000000,回车用默认',
          stepLabel: this.diyStepLabel(3),
          placeholder: String(DEFAULT_CONTEXT_WINDOW),
          defaultValue: String(DEFAULT_CONTEXT_WINDOW),
        }
      case 'diy-vision':
        return {
          kind: 'choice',
          title: '这个模型支持视觉（识图）吗？',
          subtitle: '支持图片输入的模型勾「是」，之后可在「识图」配置里选它做识图桥',
          stepLabel: this.diyStepLabel(4),
          options: [
            { id: 'no', label: '否（纯文本）' },
            { id: 'yes', label: '是（多模态，可识图）' },
          ],
        }
      case 'diy-thinking': {
        const split = this.collected.reasoningSplitHint === true
        return {
          kind: 'choice',
          title: '这些模型支持深度思考（reasoning）输出吗？',
          subtitle: split
            ? '探测发现端点返回 reasoning_content —— 建议选「支持」'
            : '支持思考输出的模型会启用思考档路由；不确定选「不支持」',
          stepLabel: this.diyStepLabel(7),
          options: [
            { id: 'none', label: '不支持（纯文本补全）', recommended: !split },
            { id: 'split', label: '支持（reasoning_content 分块返回）', recommended: split },
          ],
        }
      }
      case 'diy-name':
        return {
          kind: 'input',
          title: '给这个服务商起个名字',
          subtitle: '用于配置与切换（小写字母/数字/-/_），回车用建议名',
          stepLabel: this.diyStepLabel(8),
          placeholder: suggestProviderName(this.collected.baseUrl ?? ''),
          defaultValue: suggestProviderName(this.collected.baseUrl ?? ''),
        }
    }
  }

  /** Space on multi-choice steps: toggle a checkbox. */
  toggle(id: string): ConnectStepResult {
    if (this.phase !== 'diy-models' && this.phase !== 'preset-models') {
      return { kind: 'error', message: '当前步骤无可勾选项。', view: this.view() }
    }
    const probed = this.collected.probedModels ?? []
    const index = Number.parseInt(id, 10)
    if (!Number.isInteger(index) || index < 0 || index >= probed.length) {
      return { kind: 'error', message: `未知选项：${id}`, view: this.view() }
    }
    probed[index]!.checked = !probed[index]!.checked
    return { kind: 'next', view: this.view() }
  }

  /** Enter on multi-choice steps: confirm the current checkbox selection. */
  confirm(): ConnectStepResult {
    if (this.phase !== 'diy-models' && this.phase !== 'preset-models') {
      return { kind: 'error', message: '当前步骤不支持确认操作。', view: this.view() }
    }
    const picked = (this.collected.probedModels ?? []).filter(p => p.checked)
    if (picked.length === 0) {
      return { kind: 'error', message: '请至少勾选一个模型（空格勾选，或 Esc 取消）。', view: this.view() }
    }
    this.collected.probedModels = picked
    this.modelsFilter = ''
    this.advancedReturnPhase = this.phase === 'preset-models' ? 'capability' : 'diy-thinking'
    // D2：元数据不全的勾选模型 → 逐个进补参步。完全未知（L4）要填全部；
    // 命中别名表/知识库但缺 contextWindow 或 maxTokens 的（官网未公布等）
    // 预填已知项、只补缺失项。
    const needsInput = picked.filter(p => {
      const m = p.match.entry?.metadata
      return !m || m.contextWindow === undefined || m.maxTokens === undefined
    }).map(p => p.rawId)
    if (needsInput.length > 0) {
      this.unknownQueue = needsInput
      this.unknownTotal = needsInput.length
      this.prepareAdvancedDraft(needsInput[0]!)
      this.phase = 'model-advanced'
    } else {
      this.phase = this.advancedReturnPhase
    }
    return { kind: 'next', view: this.view() }
  }

  private onModelsMultiChoice(): boolean {
    return this.phase === 'diy-models' || this.phase === 'preset-models'
  }

  /** Indexes into probedModels that match the search filter (all when empty). */
  private filteredModelIndexes(probed: ProbedModel[]): number[] {
    const query = this.modelsFilter.trim().toLowerCase()
    const indexes = probed.map((_, i) => i)
    if (!query) return indexes
    return indexes.filter(i => probed[i]!.rawId.toLowerCase().includes(query))
  }

  /** Type-to-search on the models steps; the query is transient UI state. */
  typeModelFilter(char: string): void {
    if (this.onModelsMultiChoice()) this.modelsFilter += char
  }

  backspaceModelFilter(): void {
    if (this.onModelsMultiChoice()) this.modelsFilter = this.modelsFilter.slice(0, -1)
  }

  clearModelFilter(): void {
    if (this.onModelsMultiChoice()) this.modelsFilter = ''
  }

  // ── 未知模型补参单步表单 ──────────────────────────────────────

  /** 进入某个模型的补参表单：已知元数据预填，缺失项落默认值。 */
  private prepareAdvancedDraft(rawId: string): void {
    const meta = (this.collected.probedModels ?? []).find(p => p.rawId === rawId)?.match.entry?.metadata
    this.advancedDraft = {
      contextWindow: String(meta?.contextWindow ?? DEFAULT_CONTEXT_WINDOW),
      maxTokens: String(meta?.maxTokens ?? DEFAULT_ADVANCED_MAX_OUTPUT),
      template: meta?.capabilities?.reasoningSplit ? 'reasoning' : 'generic',
      applyRest: false,
    }
  }

  /** App 每次增删键回写整段字段文本（缓冲真源在 flow，app 只持光标位置）。 */
  editAdvancedField(fieldId: string, value: string): void {
    if (this.phase !== 'model-advanced') return
    if (fieldId === 'contextWindow') this.advancedDraft.contextWindow = value
    else if (fieldId === 'maxTokens') this.advancedDraft.maxTokens = value
  }

  /** toggle 字段切换：能力模板 generic↔reasoning；套用其余 是↔否。 */
  toggleAdvancedField(fieldId: string): void {
    if (this.phase !== 'model-advanced') return
    if (fieldId === 'template') {
      this.advancedDraft.template = this.advancedDraft.template === 'generic' ? 'reasoning' : 'generic'
    } else if (fieldId === 'applyRest') {
      this.advancedDraft.applyRest = !this.advancedDraft.applyRest
    }
  }

  /** Enter：校验两个数字并把本个模型的补参落进 modelOverrides，队列推进。 */
  submitAdvancedForm(): ConnectStepResult {
    if (this.phase !== 'model-advanced') {
      return { kind: 'error', message: '当前步骤不是补参表单。', view: this.view() }
    }
    const d = this.advancedDraft
    const contextWindow = d.contextWindow.trim().length === 0 ? DEFAULT_CONTEXT_WINDOW : Number.parseInt(d.contextWindow, 10)
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
      return { kind: 'error', message: '上下文窗口请填写正整数（token 数），或清空用默认值。', view: this.view() }
    }
    const maxTokens = d.maxTokens.trim().length === 0 ? DEFAULT_ADVANCED_MAX_OUTPUT : Number.parseInt(d.maxTokens, 10)
    if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
      return { kind: 'error', message: '最大输出请填写正整数（token 数），或清空用默认值。', view: this.view() }
    }
    if (maxTokens > contextWindow) {
      return { kind: 'error', message: `最大输出不能超过上下文窗口（${contextWindow}）。`, view: this.view() }
    }
    const override: ModelOverride = { contextWindow, maxTokens, template: d.template }
    const overrides = this.collected.modelOverrides ?? {}
    overrides[this.unknownQueue.shift()!] = override
    if (d.applyRest) {
      for (const rawId of this.unknownQueue) overrides[rawId] = override
      this.unknownQueue = []
    }
    this.collected.modelOverrides = overrides
    this.phase = this.unknownQueue.length > 0 ? 'model-advanced' : this.advancedReturnPhase
    if (this.unknownQueue.length > 0) this.prepareAdvancedDraft(this.unknownQueue[0]!)
    return { kind: 'next', view: this.view() }
  }

  /** Esc：返回模型选择重挑——已补的元数据作废，避免与新的勾选集对不上。 */
  backFromAdvanced(): ConnectStepResult {
    if (this.phase !== 'model-advanced') {
      return { kind: 'error', message: '当前步骤不是补参表单。', view: this.view() }
    }
    this.collected.modelOverrides = undefined
    this.unknownQueue = []
    this.prepareAdvancedDraft('')
    this.phase = this.advancedReturnPhase === 'capability' ? 'preset-models' : 'diy-models'
    return { kind: 'next', view: this.view() }
  }

  /** Ctrl+A: check everything (only filter matches while a filter is active);
   *  when everything targeted is already checked, uncheck it instead. */
  toggleAllModels(): ConnectStepResult {
    if (!this.onModelsMultiChoice()) {
      return { kind: 'error', message: '当前步骤无模型可全选。', view: this.view() }
    }
    const probed = this.collected.probedModels ?? []
    const targets = this.filteredModelIndexes(probed)
    if (targets.length === 0) {
      return { kind: 'error', message: `没有匹配「${this.modelsFilter}」的模型。`, view: this.view() }
    }
    const check = !targets.every(i => probed[i]!.checked)
    for (const i of targets) probed[i]!.checked = check
    return { kind: 'next', view: this.view() }
  }

  /**
   * Feed the async probe result back into the flow. Both paths land on the
   * probe-report step (checklist + diagnosis); from there preset continues to
   * model selection, DIY to its multi-select / manual entry. Total DIY failure
   * keeps the dedicated probe-failed step (offers 返回修改地址).
   */
  applyProbe(report: ProbeReport): ConnectStepResult {
    if (this.phase === 'preset-probing') {
      this.collected.probeReport = report
      const keyless = !!this.collected.presetKey && PROVIDER_PRESETS[this.collected.presetKey].keyless
      if (keyless) this.collected.reasoningSplitHint = report.hints.reasoningSplit === true
      if (keyless && report.models.length > 0) {
        // 免密钥 preset 没有模板模型表——与 DIY 相同，按别名表回填发现型号。
        const matches = matchModelIds(report.models, aliasTableWithProbeInfos(report.modelInfos))
        this.collected.probedModels = matches.map(match => ({
          rawId: match.rawId,
          match,
          checked: true,
        }))
      }
      // 报告永远紧跟探测（与 DIY 叙事一致）——continue 时再进模型选择。
      this.phase = 'probe-report'
      return { kind: 'next', view: this.view() }
    }
    if (this.phase !== 'diy-probing') {
      return { kind: 'error', message: '当前不在探测步骤。', view: this.view() }
    }
    this.collected.probeReport = report
    this.collected.reasoningSplitHint = report.hints.reasoningSplit === true
    if (report.models.length > 0) {
      const matches = matchModelIds(report.models, aliasTableWithProbeInfos(report.modelInfos))
      this.collected.probedModels = matches.map(match => ({
        rawId: match.rawId,
        match,
        checked: true,
      }))
      this.phase = 'probe-report'
      return { kind: 'next', view: this.view() }
    }
    if (report.completionOk) {
      // Endpoint answers but exposes no /models — report first, manual entry after.
      this.phase = 'probe-report'
      return { kind: 'next', view: this.view() }
    }
    this.collected.probeError = report.errors.join('；') || '端点探测失败'
    this.phase = 'diy-probe-failed'
    return { kind: 'next', view: this.view() }
  }

  /** The TUI caught a network/timeout error while running the probe. */
  probeFailed(message: string): ConnectStepResult {
    if (this.phase === 'preset-probing') {
      this.collected.probeReport = { models: [], modelsOk: false, completionOk: false, hints: {}, errors: [message] }
      this.phase = 'probe-report'
      return { kind: 'next', view: this.view() }
    }
    if (this.phase !== 'diy-probing') {
      return { kind: 'error', message: '当前不在探测步骤。', view: this.view() }
    }
    this.collected.probeError = message
    this.phase = 'diy-probe-failed'
    return { kind: 'next', view: this.view() }
  }

  /** Advance a choice step. Invalid for input steps. */
  submitChoice(id: string): ConnectStepResult {
    if (this.phase === 'draft') {
      if (id === DRAFT_RESUME_CHOICE && this.pendingRestore) {
        this.phase = this.pendingRestore.phase
        Object.assign(this.collected, this.pendingRestore.collected)
        this.restoredInputValue = this.pendingRestore.restoredInput
        this.pendingRestore = undefined
        return { kind: 'next', view: this.view() }
      }
      if (id === DRAFT_DISCARD_CHOICE) {
        this.phase = 'provider'
        this.pendingRestore = undefined
        this.wasDiscardedFlag = true
        return { kind: 'next', view: this.view() }
      }
      return { kind: 'error', message: `未知选项：${id}`, view: this.view() }
    }
    if (this.phase === 'diy-protocol') {
      if (id !== 'openai' && id !== 'anthropic') {
        return { kind: 'error', message: `未知选项：${id}`, view: this.view() }
      }
      this.collected.protocol = id
      this.phase = 'diy-url'
      return { kind: 'next', view: this.view() }
    }
    if (this.phase === 'diy-vision') {
      this.collected.supportsVision = id === 'yes'
      if (this.collected.existingProvider) {
        // 加模型路径到此结束——provider 已存在，无需 API Key。
        const providerName = this.collected.existingProvider
        const modelId = this.collected.modelId!
        const contextWindow = this.collected.contextWindow ?? DEFAULT_CONTEXT_WINDOW
        return {
          kind: 'commit',
          commit: {
            mode: 'add-model',
            providerName,
            model: {
              id: modelId,
              contextWindow,
              maxTokens: Math.min(DEFAULT_MAX_OUTPUT, contextWindow),
              ...(this.collected.supportsVision ? { supportsVision: true } : {}),
            },
          },
          summary: `已为 ${providerName} 添加模型 ${modelId}`,
        }
      }
      this.phase = 'diy-apikey'
      return { kind: 'next', view: this.view() }
    }
    if (this.phase === 'diy-thinking') {
      if (id !== 'none' && id !== 'split') {
        return { kind: 'error', message: `未知选项：${id}`, view: this.view() }
      }
      this.collected.thinkingSplit = id === 'split'
      // 免密钥 preset（本地 Ollama）：presetKey 即服务商名，跳过命名步直接进确认。
      if (this.collected.presetKey && PROVIDER_PRESETS[this.collected.presetKey].keyless) {
        this.gotoConfirm()
        return { kind: 'next', view: this.view() }
      }
      this.phase = 'diy-name'
      return { kind: 'next', view: this.view() }
    }
    if (this.phase === 'preset-billing') {
      const preset = PROVIDER_PRESETS[this.collected.presetKey!]
      const mode = preset.billingModes?.find(m => m.id === id)
      if (!mode) {
        return { kind: 'error', message: `未知计费模式：${id}`, view: this.view() }
      }
      this.collected.billingMode = mode.id
      this.phase = 'preset-apikey'
      return { kind: 'next', view: this.view() }
    }
    if (this.phase === 'capability') {
      if (id === 'continue') {
        this.gotoConfirm()
        return { kind: 'next', view: this.view() }
      }
      if (id === 'back') {
        this.phase = 'preset-models'
        return { kind: 'next', view: this.view() }
      }
      return { kind: 'error', message: `未知选项：${id}`, view: this.view() }
    }
    if (this.phase === 'probe-report') {
      const keylessPreset = !!this.collected.presetKey && PROVIDER_PRESETS[this.collected.presetKey].keyless
      if (id === 'continue') {
        if (this.collected.presetKey && !keylessPreset) {
          if ((this.collected.probedModels?.length ?? 0) === 0) {
            const built = this.buildPresetModelSelection()
            if (built.length > 0) this.collected.probedModels = built
          }
          if ((this.collected.probedModels?.length ?? 0) > 0) {
            this.phase = 'preset-models'
          } else {
            this.gotoConfirm()
          }
        } else if (this.collected.probedModels && this.collected.probedModels.length > 0) {
          this.phase = 'diy-models'
        } else {
          this.phase = 'diy-model'
        }
        return { kind: 'next', view: this.view() }
      }
      if (id === 'rekey') {
        this.phase = this.collected.presetKey && !keylessPreset ? 'preset-apikey' : 'diy-apikey'
        this.restoredInputValue = this.collected.apiKey ?? ''
        return { kind: 'next', view: this.view() }
      }
      if (id === 'edit-url') {
        if (!this.collected.presetKey) {
          return { kind: 'error', message: `未知选项：${id}`, view: this.view() }
        }
        this.phase = 'preset-endpoint'
        this.restoredInputValue = this.collected.baseUrl ?? this.presetBaseUrl()
        return { kind: 'next', view: this.view() }
      }
      if (id === 'save-anyway') {
        this.gotoConfirm()
        return { kind: 'next', view: this.view() }
      }
      if (id === 'reprobe-pick') {
        if ((this.collected.probeReport?.models.length ?? 0) === 0) {
          return { kind: 'error', message: '没有可选型号——模型列表未拉取成功。', view: this.view() }
        }
        this.phase = 'reprobe-pick'
        return { kind: 'next', view: this.view() }
      }
      return { kind: 'error', message: `未知选项：${id}`, view: this.view() }
    }
    if (this.phase === 'reprobe-pick') {
      const models = this.collected.probeReport?.models ?? []
      if (!models.includes(id)) {
        return { kind: 'error', message: `未知型号：${id}`, view: this.view() }
      }
      const presetKey = this.collected.presetKey
      if (presetKey) {
        const preset = PROVIDER_PRESETS[presetKey]
        this.phase = 'preset-probing'
        return {
          kind: 'probe',
          baseUrl: this.collected.baseUrl ?? this.presetBaseUrl(),
          apiKey: this.collected.apiKey,
          probeModel: id,
          protocol: preset.provider.protocol ?? 'openai',
          providerName: presetKey,
        }
      }
      this.phase = 'diy-probing'
      return {
        kind: 'probe',
        baseUrl: this.collected.baseUrl!,
        apiKey: this.collected.apiKey,
        probeModel: id,
        protocol: this.collected.protocol ?? 'openai',
      }
    }
    if (this.phase === 'ask-default') {
      if (id === 'yes') {
        this.collected.makeDefault = true
        this.phase = 'confirm'
        return { kind: 'next', view: this.view() }
      }
      if (id === 'no') {
        this.collected.makeDefault = false
        this.phase = 'confirm'
        return { kind: 'next', view: this.view() }
      }
      if (id === 'back') {
        const key = this.collected.presetKey
        if (key && PROVIDER_PRESETS[key].keyless) {
          this.phase = 'diy-thinking'
        } else if (key) {
          this.phase = 'capability'
        } else {
          this.phase = 'diy-name'
          this.restoredInputValue = this.collected.providerName ?? ''
        }
        return { kind: 'next', view: this.view() }
      }
      return { kind: 'error', message: `未知选项：${id}`, view: this.view() }
    }
    if (this.phase === 'confirm') {
      if (id === 'save') return this.finalizeCommit()
      if (id === 'advanced') {
        this.phase = 'advanced-settings'
        return { kind: 'next', view: this.view() }
      }
      if (id === 'back') {
        if (this.needsDefaultAsk() && this.collected.makeDefault !== undefined) {
          this.phase = 'ask-default'
          return { kind: 'next', view: this.view() }
        }
        const key = this.collected.presetKey
        if (key && PROVIDER_PRESETS[key].keyless) {
          this.phase = 'diy-thinking'
        } else if (key) {
          if ((this.collected.probedModels?.length ?? 0) > 0) {
            this.phase = 'capability'
          } else {
            this.phase = 'probe-report'
          }
        } else {
          this.phase = 'diy-name'
          this.restoredInputValue = this.collected.providerName ?? ''
        }
        return { kind: 'next', view: this.view() }
      }
      return { kind: 'error', message: `未知选项：${id}`, view: this.view() }
    }
    if (this.phase === 'advanced-settings') {
      if (id === 'done') {
        this.phase = 'confirm'
        return { kind: 'next', view: this.view() }
      }
      // 进入单项输入子步——预填当前值，留空回车即清除。
      const target: Record<string, Phase> = {
        requestTimeoutMs: 'advanced-request-timeout',
        maxRetries: 'advanced-max-retries',
        temperature: 'advanced-temperature',
        proxy: 'advanced-proxy',
      }
      const next = target[id]
      if (!next) return { kind: 'error', message: `未知选项：${id}`, view: this.view() }
      const adv = this.collected.advanced
      const current = adv?.[id as keyof ProviderAdvancedConfig]
      this.restoredInputValue = current !== undefined ? String(current) : ''
      this.phase = next
      return { kind: 'next', view: this.view() }
    }
    if (this.phase === 'diy-probe-failed') {
      if (id === 'manual') {
        this.phase = 'diy-model'
        return { kind: 'next', view: this.view() }
      }
      if (id === 'back') {
        this.phase = 'diy-url'
        this.restoredInputValue = this.collected.baseUrl ?? ''
        return { kind: 'next', view: this.view() }
      }
      return { kind: 'error', message: `未知选项：${id}`, view: this.view() }
    }
    if (this.phase === 'pick-existing') {
      const ref = this.existing.find(p => p.name === id)
      if (!ref) {
        return { kind: 'error', message: `未知服务商：${id}`, view: this.view() }
      }
      this.collected.existingProvider = ref.name
      this.phase = 'diy-model'
      return { kind: 'next', view: this.view() }
    }
    if (this.phase !== 'provider') {
      return { kind: 'error', message: '当前步骤需要输入文本，而非选择。', view: this.view() }
    }
    if (id === CUSTOM_CHOICE) {
      this.phase = 'diy-protocol'
      return { kind: 'next', view: this.view() }
    }
    if (id === OPENAI_COMPAT_CHOICE) {
      this.collected.protocol = 'openai'
      this.phase = 'diy-url'
      return { kind: 'next', view: this.view() }
    }
    if (id === ADD_MODEL_CHOICE) {
      this.phase = 'pick-existing'
      return { kind: 'next', view: this.view() }
    }
    const key = id as ProviderPresetKey
    const preset = PROVIDER_PRESETS[key]
    if (!preset) {
      return { kind: 'error', message: `未知服务商：${id}`, view: this.view() }
    }
    // OAuth providers (codex) need no API key — commit the preset directly and
    // point the user at the login step (/login 现已真实注册——此前是幽灵指引）。
    if (preset.provider.auth?.type === 'oauth') {
      return {
        kind: 'commit',
        commit: { mode: 'preset', setup: { providerName: key, preset: key, makeDefault: true }, needsLogin: true },
        summary: `已选择 ${preset.label} · ${preset.defaultModelId}（OAuth）。`,
      }
    }
    // 免密钥端点（本地 Ollama）——跳过 key 步，先确认/修改服务地址再探测。
    // 后续复用 DIY 阶段；commitCustom 时默认名取 presetKey（见 diy-name）。
    if (preset.keyless) {
      this.collected.presetKey = key
      this.collected.apiKey = undefined
      this.phase = 'preset-endpoint'
      return { kind: 'next', view: this.view() }
    }
    this.collected.presetKey = key
    this.phase = preset.billingModes && preset.billingModes.length > 0 ? 'preset-billing' : 'preset-apikey'
    return { kind: 'next', view: this.view() }
  }

  /** Advance an input step. Invalid for choice steps. */
  submitInput(raw: string): ConnectStepResult {
    const value = raw.trim()
    switch (this.phase) {
      case 'draft':
      case 'provider':
      case 'pick-existing':
      case 'preset-billing':
      case 'diy-protocol':
      case 'diy-vision':
      case 'diy-thinking':
      case 'diy-probe-failed':
      case 'probe-report':
      case 'reprobe-pick':
      case 'preset-models':
      case 'capability':
      case 'ask-default':
      case 'confirm':
      case 'advanced-settings':
      case 'diy-models':
      case 'model-advanced':
        return { kind: 'error', message: '当前步骤需要选择，而非输入。', view: this.view() }
      case 'diy-probing':
      case 'preset-probing':
        return { kind: 'error', message: '正在探测端点，请稍候…', view: this.view() }

      case 'advanced-request-timeout': {
        if (value.length === 0) {
          this.applyAdvancedKnob('requestTimeoutMs', undefined)
        } else {
          const parsed = Number.parseInt(value, 10)
          if (!Number.isFinite(parsed) || parsed <= 0) {
            return { kind: 'error', message: '请填写正整数毫秒数，或回车清空恢复内置硬顶。', view: this.view() }
          }
          this.applyAdvancedKnob('requestTimeoutMs', parsed)
        }
        this.phase = 'advanced-settings'
        return { kind: 'next', view: this.view() }
      }

      case 'advanced-max-retries': {
        if (value.length === 0) {
          this.applyAdvancedKnob('maxRetries', undefined)
        } else {
          const parsed = Number.parseInt(value, 10)
          if (!Number.isFinite(parsed) || parsed < 0 || parsed > 20) {
            return { kind: 'error', message: '请填写 0–20 的整数（0 = 禁用重试），或回车清空恢复内置默认。', view: this.view() }
          }
          this.applyAdvancedKnob('maxRetries', parsed)
        }
        this.phase = 'advanced-settings'
        return { kind: 'next', view: this.view() }
      }

      case 'advanced-temperature': {
        if (value.length === 0) {
          this.applyAdvancedKnob('temperature', undefined)
        } else {
          const parsed = Number.parseFloat(value)
          if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
            return { kind: 'error', message: '请填写 0–2 之间的数字，或回车清空用服务端默认。', view: this.view() }
          }
          this.applyAdvancedKnob('temperature', parsed)
        }
        this.phase = 'advanced-settings'
        return { kind: 'next', view: this.view() }
      }

      case 'advanced-proxy': {
        if (value.length === 0) {
          this.applyAdvancedKnob('proxy', undefined)
        } else {
          if (!isLikelyUrl(value)) {
            return { kind: 'error', message: '请填写合法的 http(s) 代理地址，或回车清空取消。', view: this.view() }
          }
          this.applyAdvancedKnob('proxy', value)
        }
        this.phase = 'advanced-settings'
        return { kind: 'next', view: this.view() }
      }

      case 'preset-apikey': {
        if (value.length === 0) {
          return { kind: 'error', message: 'API 密钥不能为空。', view: this.view() }
        }
        this.collected.apiKey = value
        this.collected.authConfirmed = true
        this.phase = 'preset-endpoint'
        return { kind: 'next', view: this.view() }
      }

      case 'preset-endpoint': {
        const key = this.collected.presetKey!
        const preset = PROVIDER_PRESETS[key]
        const url = value.length > 0 ? value : this.presetBaseUrl()
        if (!isLikelyUrl(url)) {
          return { kind: 'error', message: '请填写合法的 http(s) 地址。', view: this.view() }
        }
        if (url.includes('{') || url.includes('}')) {
          return { kind: 'error', message: '地址仍含 {WorkspaceId} 占位符——请替换为你的真实业务空间 ID（百炼控制台 → 左侧「业务空间」→ 进入空间查看）。', view: this.view() }
        }
        const normalized = normalizeBaseUrl(url)
        this.collected.urlNormalized = normalized !== url
        this.collected.baseUrl = normalized
        this.phase = 'preset-probing'
        return {
          kind: 'probe',
          baseUrl: normalized,
          apiKey: this.collected.apiKey,
          probeModel: preset.defaultModelId,
          protocol: preset.provider.protocol ?? 'openai',
          providerName: key,
        }
      }

      case 'diy-url': {
        if (!isLikelyUrl(value)) {
          return { kind: 'error', message: '请填写合法的 http(s) 地址。', view: this.view() }
        }
        const normalized = normalizeBaseUrl(value)
        this.collected.urlNormalized = normalized !== value
        this.collected.baseUrl = normalized
        // 密钥已在手（探测失败回来改地址 / 草稿恢复）→ 重提地址直接再探测，
        // 不让用户把密钥步重走一遍。
        if (this.collected.authConfirmed || this.collected.apiKey !== undefined) {
          this.phase = 'diy-probing'
          return {
            kind: 'probe',
            baseUrl: normalized,
            apiKey: this.collected.apiKey,
            protocol: this.collected.protocol ?? 'openai',
          }
        }
        this.phase = 'diy-apikey'
        return { kind: 'next', view: this.view() }
      }

      case 'diy-apikey': {
        // Empty is allowed — local deployments (Ollama/vLLM) need no auth.
        this.collected.apiKey = value.length > 0 ? value : undefined
        this.collected.authConfirmed = true
        this.phase = 'diy-probing'
        return {
          kind: 'probe',
          baseUrl: this.collected.baseUrl!,
          apiKey: this.collected.apiKey,
          protocol: this.collected.protocol ?? 'openai',
        }
      }

      case 'diy-model': {
        if (value.length === 0) {
          return { kind: 'error', message: '模型型号不能为空。', view: this.view() }
        }
        this.collected.modelId = value
        if (this.collected.existingProvider) {
          this.phase = 'diy-context'
        } else {
          // DIY 单模型兜底路径（探测无果）：contextWindow/maxTokens 交给
          // modelConfigSchema 推断落盘，思考问句与多模型路径合流。
          this.phase = 'diy-thinking'
        }
        return { kind: 'next', view: this.view() }
      }

      case 'diy-context': {
        let contextWindow = DEFAULT_CONTEXT_WINDOW
        if (value.length > 0) {
          const parsed = Number.parseInt(value, 10)
          if (!Number.isInteger(parsed) || parsed <= 0) {
            return { kind: 'error', message: '上下文长度需为正整数（或直接回车用默认）。', view: this.view() }
          }
          contextWindow = parsed
        }
        this.collected.contextWindow = contextWindow
        this.phase = 'diy-vision'
        return { kind: 'next', view: this.view() }
      }

      case 'diy-name': {
        const name = (value.length > 0 ? value : suggestProviderName(this.collected.baseUrl ?? '')).toLowerCase()
        if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
          return { kind: 'error', message: '名字只能包含小写字母、数字、.、_、-（且以字母/数字开头）。', view: this.view() }
        }
        if (isProviderPresetKey(name)) {
          return { kind: 'error', message: `「${name}」是内置服务商名——请换一个名字（配置内置服务商请在第一步直接选它）。`, view: this.view() }
        }
        this.collected.providerName = name
        this.gotoConfirm()
        return { kind: 'next', view: this.view() }
      }
    }
  }

  /** Confirm step accepted — materialize the commit for whichever path got here. */
  private finalizeCommit(): ConnectStepResult {
    const key = this.collected.presetKey
    if (key && PROVIDER_PRESETS[key].keyless) return this.commitKeylessPreset(key)
    if (this.collected.providerName) return this.commitCustom(this.collected.providerName)
    const preset = PROVIDER_PRESETS[key!]
    const picked = this.collected.probedModels
    const templateModels = preset.provider.models ?? []
    const models = picked && picked.length > 0
      ? picked.map(p => templateModels.find(m => m.id === p.rawId) ?? this.descriptorFor(p.match))
      : undefined
    return {
      kind: 'commit',
      commit: {
        mode: 'preset',
        setup: {
          providerName: key!,
          preset: key!,
          apiKey: this.collected.apiKey,
          makeDefault: this.collected.makeDefault ?? true,
          ...(this.collected.baseUrl && this.collected.baseUrl !== preset.provider.baseUrl
            ? { baseUrl: this.collected.baseUrl }
            : {}),
          ...(models ? { models } : {}),
          ...(this.collected.advanced ? { advanced: this.collected.advanced } : {}),
        },
      },
      summary: models ? `已连接 ${preset.label} · ${models.length} 个模型` : `已连接 ${preset.label} · ${preset.defaultModelId}`,
    }
  }

  /** 预设模型表 ∪ 探测新发现：预设 id 默认勾选，新发现仅当别名表认识才勾选。
   *  聚合平台例外——模型列表又长又杂，默认全不选，由用户搜索/勾选。 */
  private buildPresetModelSelection(): ProbedModel[] {
    const preset = PROVIDER_PRESETS[this.collected.presetKey!]
    const templateIds = (preset.provider.models ?? []).map(m => m.id)
    const discovered = (this.collected.probeReport?.models ?? []).filter(id => !templateIds.includes(id))
    const matches = matchModelIds([...templateIds, ...discovered], aliasTableWithProbeInfos(this.collected.probeReport?.modelInfos))
    const templateSet = new Set(templateIds)
    return matches.map((match, i) => ({
      rawId: matches[i]!.rawId,
      match: matches[i]!,
      checked: preset.aggregator ? false : templateSet.has(match.rawId) || match.entry !== undefined,
    }))
  }

  /** Capability-check summary line for the confirm step. */
  private confirmSummary(): string {
    const c = this.collected
    const who = c.providerName ?? (c.presetKey ? PROVIDER_PRESETS[c.presetKey].label : '自定义服务商')
    const parts: string[] = [who]
    const modelCount = c.probedModels?.length ?? (c.modelId ? 1 : undefined)
    if (modelCount !== undefined) parts.push(`${modelCount} 个模型`)
    const probe = c.probeReport
    if (probe) {
      parts.push(probe.completionOk
        ? `凭证校验通过（补全 ${probe.latencyMs ?? '?'}ms${probe.modelsOk ? `，拉取到 ${probe.models.length} 个模型` : ''}）`
        : `探测未完全通过：${probe.errors[0] ?? '未知错误'}`)
    } else if (c.probeError) {
      parts.push('探测未通过，已选择跳过')
    } else {
      parts.push('未进行端点探测')
    }
    if (c.apiKey) parts.push('密钥存入 ~/.rivet/secrets.json')
    if (c.advanced && Object.keys(c.advanced).length > 0) parts.push(`已调 ${Object.keys(c.advanced).length} 项高级设置`)
    parts.push(c.makeDefault === false ? `保留现有默认服务商（${this.currentDefault}）` : '设为默认服务商')
    return parts.join('；')
  }

  /** Materialize the custom-provider commit from everything collected. */
  private commitCustom(providerName: string): ConnectStepResult {
    const models: Array<Partial<ModelConfig> & { id: string }> = []
    const probed = this.collected.probedModels
    if (probed && probed.length > 0) {
      for (const p of probed) {
        const descriptor = this.descriptorFor(p.match)
        models.push(descriptor)
      }
    } else {
      // Manual fallback — bare id; schema materializes contextWindow/maxTokens.
      models.push({ id: this.collected.modelId! })
    }
    return {
      kind: 'commit',
      commit: {
        mode: 'custom',
        providerName,
        baseUrl: this.collected.baseUrl!,
        apiKey: this.collected.apiKey,
        protocol: this.collected.protocol ?? 'openai',
        models,
        makeDefault: this.collected.makeDefault ?? true,
        ...(this.collected.advanced ? { advanced: this.collected.advanced } : {}),
      },
      summary: `已连接 ${providerName} · ${models.length} 个模型`,
    }
  }

  /** 免密钥 preset（本地 Ollama）提交：preset 模板物化服务商 + 探测模型回填。 */
  private commitKeylessPreset(key: ProviderPresetKey): ConnectStepResult {
    const preset = PROVIDER_PRESETS[key]
    const models: Array<Partial<ModelConfig> & { id: string }> = []
    const probed = this.collected.probedModels
    if (probed && probed.length > 0) {
      for (const p of probed) {
        models.push(this.descriptorFor(p.match))
      }
    } else if (this.collected.modelId) {
      // 探测无果的手动兜底——裸 id，schema 物化 contextWindow/maxTokens。
      models.push({ id: this.collected.modelId })
    }
    return {
      kind: 'commit',
      commit: {
        mode: 'preset',
        setup: {
          providerName: key,
          preset: key,
          makeDefault: this.collected.makeDefault ?? true,
          ...(models.length > 0 ? { models } : {}),
          ...(this.collected.baseUrl && this.collected.baseUrl !== preset.provider.baseUrl
            ? { baseUrl: this.collected.baseUrl }
            : {}),
          ...(this.collected.advanced ? { advanced: this.collected.advanced } : {}),
        },
      },
      summary: `已连接 ${preset.label} · ${models.length > 0 ? `${models.length} 个模型` : preset.defaultModelId}`,
    }
  }

  /** Matcher result → config descriptor, keeping the RAW endpoint id callable. */
  private descriptorFor(match: ModelMatchResult): Partial<ModelConfig> & { id: string } {
    if (!match.entry) {
      // Unknown model: D2 overrides win; otherwise apply the thinking answer
      // and leave sizes to schema defaults.
      const descriptor: Partial<ModelConfig> & { id: string } = { id: match.rawId }
      const override = this.collected.modelOverrides?.[match.rawId]
      if (override) {
        descriptor.contextWindow = override.contextWindow
        descriptor.maxTokens = override.maxTokens
        if (override.template === 'reasoning') descriptor.capabilities = { reasoningSplit: true }
      } else if (this.collected.thinkingSplit) {
        descriptor.capabilities = { reasoningSplit: true }
      }
      return descriptor
    }
    const metadata = match.entry.metadata
    const descriptor: Partial<ModelConfig> & { id: string } = {
      id: match.rawId,
      ...(metadata.contextWindow !== undefined ? { contextWindow: metadata.contextWindow } : {}),
      ...(metadata.maxTokens !== undefined ? { maxTokens: metadata.maxTokens } : {}),
      ...(metadata.reasoningEffort ? { reasoningEffort: metadata.reasoningEffort } : {}),
      ...(metadata.supportsVision !== undefined ? { supportsVision: true } : {}),
      ...(metadata.tier ? { tier: metadata.tier } : {}),
      ...(metadata.pricing ? { pricing: metadata.pricing } : {}),
    }
    const caps = { ...metadata.capabilities }
    // Thinking answer only fills models that declare nothing themselves —
    // alias-table metadata wins over the blanket wizard answer.
    if (this.collected.thinkingSplit && caps.thinkingBlock === undefined && caps.reasoningSplit === undefined) {
      caps.reasoningSplit = true
    }
    // 补参表单的输出覆盖表内元数据——半已知模型（缺 ctx/max）走过表单，
    // 用户核对过的值才是最终意图（generic 选择会抹掉表内的 reasoningSplit）。
    const override = this.collected.modelOverrides?.[match.rawId]
    if (override) {
      descriptor.contextWindow = override.contextWindow
      descriptor.maxTokens = override.maxTokens
      if (override.template === 'reasoning') caps.reasoningSplit = true
      else delete caps.reasoningSplit
    }
    if (Object.keys(caps).length > 0) descriptor.capabilities = caps
    return descriptor
  }

  /** True when the current step accepts free-text input (vs a choice list). */
  isInputStep(): boolean {
    return this.view().kind === 'input'
  }
}

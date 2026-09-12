import { readFileSync, existsSync } from 'fs'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { resolve, join, dirname } from 'path'
import { isProjectTrusted, stripUntrustedProjectKeys, notifyUntrustedOnce, findSensitiveProjectKeys } from './project-trust.js'
import { z } from 'zod'
import { resolveProfileName, resolveProfileOverlay, resolveHookDisabledEnv } from './profile.js'
import { configSchema, reviewConfigSchema, workersSchema, councilConfigSchema, editorSchema, mirrorsSchema, prDefaultsSchema, envSchema, uiSchema, permissionsSchema, networkSchema, fetchSchema, searchSchema, modelConfigSchema, type Config, type ProviderConfig, type ModelConfig, type ProviderCapabilitiesConfig, type ProviderAdvancedConfig, type ReviewConfig, type WorkersConfig, type CouncilConfig, type EditorConfig, type MirrorsConfig, type PrDefaultsConfig, type UiConfig } from './schema.js'
import { DEFAULT_CONFIG } from './default.js'
import { userConfigPath } from './paths.js'
import { findPresetModel, isProviderPresetKey, type ProviderPresetKey } from './provider-presets.js'
import { cloneResolvedPreset, resolvePreset } from '../api/pro-registry.js'
import { backfillPresetModelFields, migratePresetModelBackfill } from './preset-model-backfill.js'
import { migrateDeepseekV4ProRetirement, migrateDeepseekVisionExpRetirement } from './preset-model-retirement.js'
import { writeSecret, readSecret, deleteSecret } from './secrets-store.js'
import { invalidateToolPreset } from '../tools/tool-preset.js'
import { invalidatePromptBlocks } from '../prompt/block-policy.js'
import { validateRuntimeLeanSlice, type RuntimeLeanConfigSlice } from './runtime-lean.js'
import { formatProviderCard, formatSuccess, formatError, formatMcpServerList, type FormatOpts } from './cli-format.js'
import { formatZodError } from './format-zod-error.js'
import { applyProviderTunables } from './provider-tunables.js'

const APPROVAL_MODES = ['auto-safe', 'manual', 'auto-accept', 'dangerously-skip-permissions'] as const
type ApprovalModeConfig = typeof APPROVAL_MODES[number]

/**
 * Config load failure (malformed JSON or schema violation). Always thrown —
 * never silently downgraded to defaults, so a broken config surfaces at
 * startup instead of distorting behavior (wrong contextWindow, lost keys).
 */
export class ConfigLoadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigLoadError'
  }
}

/** Convert a JSON.parse error position into 1-based line:column. */
function lineColAt(text: string, position: number): string {
  let line = 1
  let col = 1
  for (let i = 0; i < position && i < text.length; i++) {
    if (text[i] === '\n') { line++; col = 1 } else col++
  }
  return `${line}:${col}`
}

/**
 * Read + parse a config layer. Malformed JSON throws a ConfigLoadError with
 * the file path and line:column (plus a terminal bell for attention) —
 * falling back to defaults is forbidden.
 */
function readConfigJson(path: string): Record<string, unknown> {
  const text = readFileSync(path, 'utf-8')
  try {
    const raw = JSON.parse(text)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ConfigLoadError(`\u0007配置文件 ${path} 顶层必须是 JSON 对象——拒绝回退默认配置，请修正后重试。`)
    }
    return raw as Record<string, unknown>
  } catch (e) {
    if (e instanceof ConfigLoadError) throw e
    const detail = e instanceof Error ? e.message : String(e)
    const posMatch = detail.match(/position (\d+)/)
    const where = posMatch ? `（第 ${lineColAt(text, Number.parseInt(posMatch[1]!, 10))} 处）` : ''
    throw new ConfigLoadError(`\u0007配置文件 ${path} JSON 解析失败${where}：${detail}——拒绝回退默认配置，请修正后重试。`)
  }
}

export function getUserConfigPath(): string {
  return userConfigPath()
}

/** Project-level config file name (checked in cwd and parent dirs) */
const PROJECT_CONFIG_FILE = '.rivet-config.json'

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    const sv = source[key]
    const tv = target[key]
    if (sv === null) {
      delete result[key]
    } else if (sv && typeof sv === 'object' && !Array.isArray(sv) && tv && typeof tv === 'object' && !Array.isArray(tv)) {
      result[key] = deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>)
    } else {
      result[key] = sv
    }
  }
  return result
}

/**
 * Walk up from startDir to find the nearest .rivet-config.json.
 * Returns the absolute path or undefined if not found.
 */
export function findProjectConfig(startDir: string): string | undefined {
  let dir = resolve(startDir)
  for (let i = 0; i < 20; i++) {
    const candidate = join(dir, PROJECT_CONFIG_FILE)
    if (existsSync(candidate)) return candidate
    const parent = resolve(dir, '..')
    if (parent === dir) break // reached root
    dir = parent
  }
  return undefined
}

/**
 * One-shot legacy migration for the C3 autonomy brake (2026-07): configs
 * written before `autonomyBrake` existed persisted the then-default
 * `checkpointEveryTurns: 10`. The default since moved to 0 (off) — a
 * persisted 10 would pin them to the old behavior forever.  When the brake
 * field is absent AND the interval equals the old default, treat the 10 as
 * unmigrated legacy and drop it so the new schema default applies.
 * Explicit non-10 values (user actually tuned it) are untouched.
 */
function migrateLegacyCheckpointInterval(raw: Record<string, unknown>): Record<string, unknown> {
  const agent = raw.agent
  if (!agent || typeof agent !== 'object' || Array.isArray(agent)) return raw
  const a = agent as Record<string, unknown>
  if (a.autonomyBrake === undefined && a.checkpointEveryTurns === 10) {
    const { checkpointEveryTurns: _legacy, ...rest } = a
    return { ...raw, agent: rest }
  }
  return raw
}

/**
 * One-shot migration for the DeepSeek V4 maxTokens regression (2026-07):
 * a98fe5472 mistakenly reduced v4-pro/v4-flash maxTokens from 384_000 to
 * 64_000 (the V3-era limit). df576e01 restored the preset, but configs
 * written during the regression window have the stale 64_000 baked in.
 * Since deepMerge replaces arrays wholesale, the user's models array with
 * stale per-model maxTokens wins over the corrected preset — the preset
 * fix alone doesn't reach existing users.
 *
 * This migration patches both the provider-level maxTokens AND every model
 * in the models array whose maxTokens === 64_000 (the exact regression
 * value). Explicit non-64_000 values (user intentionally configured a
 * different cap) are left untouched.
 *
 * Mutates `raw` in place. Returns true if any value was changed.
 */
function migrateDeepseekMaxTokens(raw: Record<string, unknown>): boolean {
  const provider = raw.provider as Record<string, unknown> | undefined
  const providers = provider?.providers as Record<string, unknown> | undefined
  if (!providers) return false

  const ds = providers['deepseek'] as Record<string, unknown> | undefined
  if (!ds) return false

  let changed = false

  // Provider-level maxTokens
  if (typeof ds.maxTokens === 'number' && ds.maxTokens === 64_000) {
    ds.maxTokens = 384_000
    changed = true
  }

  // Per-model maxTokens (within the models array). Never raise maxTokens above
  // the model's own contextWindow — a custom model with a small window may
  // legitimately carry maxTokens=64_000 (the clamp backstop produces exactly
  // that value), and bumping it past the window recreates the mis-config that
  // clampModelTokens exists to prevent.
  const models = ds.models as Array<Record<string, unknown>> | undefined
  if (Array.isArray(models)) {
    for (const m of models) {
      if (typeof m.maxTokens === 'number' && m.maxTokens === 64_000) {
        const window = typeof m.contextWindow === 'number' ? m.contextWindow : Infinity
        if (window >= 384_000) {
          m.maxTokens = 384_000
          changed = true
        }
      }
    }
  }

  return changed
}

/**
 * One-shot migration: 把存量用户的 deepseek-v4-flash / DeepSeek-V4-Flash 的
 * reasoningEffort 从 'high' 刷成 'max'。preset 已改 max + backfill 白名单已收录
 * reasoningEffort，但 backfill 不覆盖磁盘已有的显式值——存量用户连过 v4-flash
 * 后快照里是 'high'，靠 backfill 拿不到。本迁移强制刷，让所有用户开箱即 max。
 *
 * 幂等：只改值为 'high' 的 v4-flash；已是 max / 用户改过的其他值不动。
 * Mutates `raw` in place. Returns true if any value was changed.
 */
function migrateV4FlashEffort(raw: Record<string, unknown>): boolean {
  const provider = raw.provider as Record<string, unknown> | undefined
  const providers = provider?.providers as Record<string, unknown> | undefined
  if (!providers) return false

  let changed = false
  // deepseek 官方 (deepseek-v4-flash) + siliconflow (deepseek-ai/DeepSeek-V4-Flash)
  for (const providerName of ['deepseek', 'siliconflow']) {
    const prov = providers[providerName] as Record<string, unknown> | undefined
    if (!prov) continue
    const models = prov.models as Array<Record<string, unknown>> | undefined
    if (!Array.isArray(models)) continue
    for (const m of models) {
      const id = typeof m.id === 'string' ? m.id : ''
      if (/deepseek-v4-flash|DeepSeek-V4-Flash/i.test(id) && m.reasoningEffort === 'high') {
        m.reasoningEffort = 'max'
        changed = true
      }
    }
  }
  return changed
}

/**
 * One-shot migration: plaintext provider.apiKey values in config.json move
 * into the 0600 secrets.json store, leaving only a keyRef pointer behind.
 * Idempotent — providers already on keyRef (or without an inline key) are
 * untouched. Mutates `raw` in place. Returns true if any value was changed.
 */
function migrateInlineApiKeys(raw: Record<string, unknown>): boolean {
  const provider = raw.provider as Record<string, unknown> | undefined
  const providers = provider?.providers as Record<string, unknown> | undefined
  if (!providers) return false
  let changed = false
  for (const [name, entry] of Object.entries(providers)) {
    if (!entry || typeof entry !== 'object') continue
    const prov = entry as Record<string, unknown>
    if (typeof prov.apiKey !== 'string' || prov.apiKey.length === 0) continue
    if (prov.keyRef) continue
    try {
      writeSecret(name, prov.apiKey)
    } catch {
      continue // secrets write failed — keep the inline key rather than lose it
    }
    delete prov.apiKey
    prov.keyRef = name
    changed = true
  }
  return changed
}

/** PR#38 审查阻断 3：旧 capabilities 字段 supportsThinking/thinkingFormat 已从
 *  schema 删除——zod strip 不报错，老用户显式写的配置静默丢失（thinking 行为
 *  回弹）。加载期映射到新模型（幂等；thinkingBlock 已存在时不动——新字段优先）：
 *  thinkingFormat 'anthropic' → thinkingBlock 'enabled'；'openai'/'none' → 'none'；
 *  无 thinkingFormat 时按 supportsThinking 布尔落 'enabled'/'none'。 */
function migrateLegacyCapabilities(raw: Record<string, unknown>): boolean {
  const provider = raw.provider as Record<string, unknown> | undefined
  const providers = provider?.providers as Record<string, unknown> | undefined
  if (!providers) return false
  let changed = false
  for (const entry of Object.values(providers)) {
    if (!entry || typeof entry !== 'object') continue
    const caps = (entry as Record<string, unknown>).capabilities as Record<string, unknown> | undefined
    if (!caps || typeof caps !== 'object') continue
    const hasLegacy = 'supportsThinking' in caps || 'thinkingFormat' in caps
    if (!hasLegacy) continue
    if (caps.thinkingBlock === undefined) {
      const fmt = caps.thinkingFormat
      if (fmt === 'anthropic') caps.thinkingBlock = 'enabled'
      else if (fmt === 'openai' || fmt === 'none') caps.thinkingBlock = 'none'
      else if (caps.supportsThinking === true) caps.thinkingBlock = 'enabled'
      else caps.thinkingBlock = 'none'
    }
    delete caps.supportsThinking
    delete caps.thinkingFormat
    changed = true
  }
  return changed
}

/** PR#38 审查阻断 2：旧 factory 按 `name === 'anthropic' || prefixCacheStrategy
 *  === 'anthropic-cache-control'` 派发 AnthropicClient，且旧 schema 的 protocol
 *  枚举只有 'openai'——存量自定义 provider 靠 prefixCache override 走 Anthropic
 *  协议，新 factory 只看 protocol 会静默改走 OpenAI 客户端（且 cache_control
 *  断点注进 OpenAI 请求，双重错协议）。加载期把该组合迁移为显式
 *  protocol: 'anthropic'（幂等）。 */
function migrateAnthropicProtocol(raw: Record<string, unknown>): boolean {
  const provider = raw.provider as Record<string, unknown> | undefined
  const providers = provider?.providers as Record<string, unknown> | undefined
  if (!providers) return false
  let changed = false
  for (const entry of Object.values(providers)) {
    if (!entry || typeof entry !== 'object') continue
    const prov = entry as Record<string, unknown>
    if (prov.protocol === 'anthropic') continue
    // name === 'anthropic' 的条目由 schema preprocess 在内存注入协议——无需也不应
    // 落盘（落盘会被 saveConfig 的可逆注入剥离逻辑再删掉，且旧枚举 schema 读取方
    // （dsh/旧 rivet）会 zod 抛错）。
    if (prov.name === 'anthropic') continue
    const caps = prov.capabilities as Record<string, unknown> | undefined
    if (caps?.prefixCache === 'anthropic-cache-control') {
      prov.protocol = 'anthropic'
      changed = true
    }
  }
  return changed
}

/**
 * Load config with 3-layer resolution: user → project → session overlay.
 *
 * Priority (highest wins):
 * 1. sessionOverlay — runtime-only, per-session overrides (never persisted here)
 * 2. projectConfig — .rivet-config.json found by walking up from cwd
 * 3. userConfig — ~/.rivet/config.json (global)
 * 4. DEFAULT_CONFIG — built-in defaults
 *
 * Each layer is deep-merged onto the previous, then the result is
 * validated through the Zod configSchema.
 */
export function loadConfig(options?: {
  cwd?: string
  projectConfigPath?: string
  sessionOverlay?: Record<string, unknown>
  /** 显式 profile 名（优先于 RIVET_PROFILE env）。见 profile.ts。 */
  profile?: string
}): Config {
  // Layer 1: defaults
  let base = DEFAULT_CONFIG as unknown as Record<string, unknown>

  // Layer 2: user global config
  const configPath = getUserConfigPath()
  if (existsSync(configPath)) {
    const raw = readConfigJson(configPath)
    const cpMigrated = migrateLegacyCheckpointInterval(raw)
    const dsChanged = migrateDeepseekMaxTokens(cpMigrated)
    const flashChanged = migrateV4FlashEffort(cpMigrated)
    const proRetired = migrateDeepseekV4ProRetirement(cpMigrated)
    const visionExpRetired = migrateDeepseekVisionExpRetirement(cpMigrated)
    const keysMoved = migrateInlineApiKeys(cpMigrated)
    const capsChanged = migrateLegacyCapabilities(cpMigrated)
    const protoChanged = migrateAnthropicProtocol(cpMigrated)
    const backfillChanged = migratePresetModelBackfill(cpMigrated)
    // Write back if any migration modified the raw config so the fix
    // persists across restarts (one-shot, idempotent).
    if (cpMigrated !== raw || dsChanged || flashChanged || proRetired || visionExpRetired || keysMoved || capsChanged || protoChanged || backfillChanged) {
      try {
        writeFileAtomicSync(configPath, JSON.stringify(cpMigrated, null, 2) + '\n')
      } catch {
        // best-effort — migration still applied in memory
      }
    }
    base = deepMerge(base, cpMigrated)
  }

  // Layer 3: project config
  const projectPath = options?.projectConfigPath
    ?? (options?.cwd ? findProjectConfig(options.cwd) : undefined)
  if (projectPath && existsSync(projectPath)) {
    const raw = readConfigJson(projectPath)
    const cpMigrated = migrateLegacyCheckpointInterval(raw)
    migrateDeepseekMaxTokens(cpMigrated)
    migrateV4FlashEffort(cpMigrated)
    migrateDeepseekV4ProRetirement(cpMigrated)
    migrateLegacyCapabilities(cpMigrated)
    migrateAnthropicProtocol(cpMigrated)
    // 信任门：项目配置可能来自不可信仓库。未授信时剥离安全敏感键再合并
    // （SECURITY.md 信任边界——仓库内容不能自我授权审批豁免/进程拉起/出口改向）。
    const projectDir = dirname(projectPath)
    const trusted = isProjectTrusted(projectDir)
    const effective = trusted
      ? cpMigrated
      : stripUntrustedProjectKeys(cpMigrated)
    if (!trusted) {
      // 仅在实际剥到键时提示——无敏感键的项目零打扰。
      const stripped = findSensitiveProjectKeys(cpMigrated)
      if (stripped.length > 0) notifyUntrustedOnce('config', projectDir, stripped)
    }
    // NOTE: no write-back for project configs — they may be version-controlled.
    base = deepMerge(base, effective)
  }

  // Layer 3.5: profile overlay（RIVET_PROFILE env / --profile flag，见 profile.ts）。
  // 命名配置覆盖块：$RIVET_HOME/profiles/<name>.json 或内置 lean。位于 project 与
  // session overlay 之间——profile 可覆盖项目配置，session overlay 可覆盖 profile。
  const profileOverlay = resolveProfileOverlay(resolveProfileName(options?.profile))
  if (Object.keys(profileOverlay).length > 0) {
    base = deepMerge(base, profileOverlay)
  }

  // Layer 4: session overlay (runtime-only, e.g. from CLI flags)
  if (options?.sessionOverlay) {
    base = deepMerge(base, options.sessionOverlay)
  }

  // Backfill missing provider names from the providers map key.
  // Older config files or partial overrides may omit `name`; the schema
  // requires it. Auto-populate so user configs stay forward-compatible.
  const rawProvider = (base as Record<string, unknown>).provider as Record<string, unknown> | undefined
  if (rawProvider) {
    const providerMap = rawProvider.providers as Record<string, unknown> | undefined
    if (providerMap && typeof providerMap === 'object') {
      for (const [key, entry] of Object.entries(providerMap)) {
        if (entry && typeof entry === 'object' && !(entry as Record<string, unknown>).name) {
          (entry as Record<string, unknown>).name = key
        }
        // userSaved 打标（PR#38 审查阻断 1 修复）：非内置名的 provider 只能来自
        // 用户配置层 → 直接打标。内置名条目可能是快照伪影——saveConfig 会把合并
        // 后的全量 providers（含 15 个未配置预设）落进用户 config.json，名字启发式
        // 会让老用户的内置名条目永远拿不到标记（/model 切换器清零），而「层里出现
        // 即打标」又会让快照伪影全员进切换器。判据：凭证或接入点超出默认预设——
        // keyRef（只有用户写入产生）/ 项目层未迁移的 apiKey / 非默认的 apiKeyEnv
        // （预设自带 DEEPSEEK_API_KEY 等，同名不算）/ baseUrl 偏离预设。
        if (entry && typeof entry === 'object') {
          const e = entry as Record<string, unknown>
          if (!(key in DEFAULT_CONFIG.provider.providers)) {
            e.userSaved = true
          } else {
            const def = (DEFAULT_CONFIG.provider.providers as Record<string, { baseUrl?: string; apiKeyEnv?: string }>)[key]
            const hasCredential = Boolean(e.keyRef) || Boolean(e.apiKey)
              || (typeof e.apiKeyEnv === 'string' && e.apiKeyEnv !== def?.apiKeyEnv)
            const repointed = typeof e.baseUrl === 'string' && typeof def?.baseUrl === 'string' && e.baseUrl !== def.baseUrl
            if (hasCredential || repointed) e.userSaved = true
          }
        }
      }
    }
  }

  // Stored provider models are a snapshot of the preset at write time, and
  // deepMerge replaced the array wholesale above — so preset fields added later
  // (e.g. supportsVision) are missing from every config already on disk. Refill
  // the absent ones here; see preset-model-backfill.ts for the scope limits.
  const parsed = configSchema.safeParse(base)
  if (!parsed.success) {
    // 绝不回退默认——校验失败说明用户配置里有真实错误，静默降级会让错误
    // 一直藏着（错误的 contextWindow 直接扭曲压缩行为）。
    const sources = [configPath, ...(projectPath ? [projectPath] : [])].join(' / ')
    throw new ConfigLoadError(`${formatZodError(parsed.error, 'rivet')}\n涉及的配置文件：${sources}`)
  }
  const config = backfillPresetModelFields(parsed.data)
  // Materialize keyRef secrets into in-memory apiKey — runtime consumers read
  // provider.apiKey in ~10 places; disk never sees this value (saveConfig
  // strips it back out for keyRef providers).
  for (const provider of Object.values(config.provider.providers)) {
    if (provider.keyRef && !provider.apiKey) {
      const secret = readSecret(provider.keyRef)
      if (secret) provider.apiKey = secret
    }
  }
  return config
}

/** Load config with backward-compatible signature (no options). */
export function loadConfigDefault(): Config {
  return loadConfig()
}

export function saveConfig(config: Config): void {
  // provider.apiKey is a runtime-only materialized value. Persisted provider
  // credentials must be either keyRef or apiKeyEnv; config.json never receives
  // plaintext API keys, including legacy objects that have no keyRef yet.
  const toWrite = structuredClone(config)
  for (const provider of Object.values(toWrite.provider.providers)) {
    provider.apiKey = undefined
    // name === 'anthropic' 的 protocol:'anthropic' 是 providerSchema preprocess 的
    // 可逆注入值（磁盘无该字段时读取侧自动补齐）——写盘前剥掉，使 config.json
    // 对旧枚举（'openai'-only）schema 的读取方保持兼容（dsh/旧 rivet 每次
    // loadConfig 都会 zod 抛错，实证：hook 拦截 bash 通道）。显式写 'openai'
    // 的条目不受影响；自定义名的 protocol:'anthropic' 是真语义，保留。
    if (provider.name === 'anthropic' && provider.protocol === 'anthropic') {
      delete (provider as unknown as { protocol?: string }).protocol
    }
  }
  writeFileAtomicSync(getUserConfigPath(), JSON.stringify(toWrite, null, 2) + '\n')
}

// --- P2 hook 装配配置面（list-hooks / set-hook-disabled）---

/** 当前 hook 装配配置面：config 值 / env 生效集 / 最终生效集。
 *  env 解析与装配侧同源（profile.resolveHookDisabledEnv）。 */
export function listHooksConfig(): {
  disabled: string[] | undefined
  envDisabled: string[] | undefined
  effectiveDisabled: string[]
} {
  const cfg = loadConfig()
  const envDisabled = resolveHookDisabledEnv()
  return {
    disabled: cfg.hooks.disabled,
    envDisabled,
    effectiveDisabled: envDisabled ?? cfg.hooks.disabled ?? [],
  }
}

/** 写用户 config 的 hooks.disabled：enable=true 移除、否则加入。返回新列表。 */
export function setHookDisabled(hookId: string, enable: boolean): { disabled: string[] } {
  const cfg = loadConfig()
  const current = cfg.hooks.disabled ?? []
  const next = enable
    ? current.filter(id => id !== hookId)
    : current.includes(hookId) ? current : [...current, hookId]
  cfg.hooks = { ...cfg.hooks, disabled: next }
  saveConfig(cfg)
  return { disabled: next }
}

// --- Provider management ---

export function listProviders(): string[] {
  return Object.keys(loadConfig().provider.providers)
}

export function getProvider(name: string): ProviderConfig | undefined {
  return loadConfig().provider.providers[name]
}

export function getDefaultProvider(): string {
  return loadConfig().provider.default
}

export function addProvider(name: string, config: ProviderConfig): void {
  const cfg = loadConfig()
  cfg.provider.providers[name] = config
  saveConfig(cfg)
}

export interface RemoveProviderResult {
  name: string
  /** 被删除条目携带的模型数（整组删除的规模）。 */
  modelCount: number
  /** 条目指向 secrets.json 的引用；keyless/inline/env 条目为 undefined。 */
  keyRef?: string
  /** 是否清理了指向被删 provider 的 agent.defaultModel。 */
  defaultModelCleared: boolean
  /** 是否已从 secrets.json 删除对应密钥。 */
  secretDeleted: boolean
  /** 其他 provider 仍引用同一 keyRef 时列出——密钥因此保留。 */
  keyRefSharedWith: string[]
}

export function removeProvider(name: string, options?: { keepSecret?: boolean }): RemoveProviderResult {
  const cfg = loadConfig()
  const entry = cfg.provider.providers[name]
  if (!entry) {
    throw new Error(
      `Provider "${name}" not found. Available: ${Object.keys(cfg.provider.providers).join(', ')}`,
    )
  }
  // 默认 provider 保护：防止 default 悬空（需先 setDefaultProvider 到别的 provider）。
  // 不再按预设名拦截——预设模板（PROVIDER_PRESETS）是代码内静态定义，删除配置
  // 条目后该预设会重新出现在「未配置」列表（allPresetKeys 过滤），随时可重新配置，
  // 开箱即用能力并未丢失。按名字拦截曾造成死锁：setupCustomProvider 允许用预设名
  // 创建自定义条目，删除时却被误判为内置预设而拒绝。
  if (cfg.provider.default === name) {
    throw new Error(`Cannot remove default provider "${name}". Set a different default first.`)
  }
  const keyRef = entry.keyRef
  const modelCount = entry.models.length
  const defaultModelCleared = cfg.agent.defaultModel?.startsWith(`${name}:`) ?? false
  if (defaultModelCleared) delete cfg.agent.defaultModel
  delete cfg.provider.providers[name]
  saveConfig(cfg)

  // 一个 key 对应一个模型组：条目删除即整组删除，密钥随之清除（否则成孤儿）。
  // 仍被其他 provider 引用的 keyRef 保留——手改配置共享 keyRef 的场景合法存在。
  let secretDeleted = false
  const keyRefSharedWith = keyRef
    ? Object.entries(cfg.provider.providers).filter(([, p]) => p.keyRef === keyRef).map(([n]) => n)
    : []
  if (keyRef && !options?.keepSecret && keyRefSharedWith.length === 0 && readSecret(keyRef) !== undefined) {
    deleteSecret(keyRef)
    secretDeleted = true
  }
  return { name, modelCount, keyRef, defaultModelCleared, secretDeleted, keyRefSharedWith }
}

export function setDefaultProvider(name: string): void {
  const cfg = loadConfig()
  if (!cfg.provider.providers[name]) {
    throw new Error(`Provider "${name}" not found. Available: ${Object.keys(cfg.provider.providers).join(', ')}`)
  }
  cfg.provider.default = name
  saveConfig(cfg)
}

export function setApprovalMode(mode: string): ApprovalModeConfig {
  if (!(APPROVAL_MODES as readonly string[]).includes(mode)) {
    throw new Error(`Invalid approval mode "${mode}". Available: ${APPROVAL_MODES.join(', ')}`)
  }
  const cfg = loadConfig()
  cfg.agent.approval = mode as ApprovalModeConfig
  saveConfig(cfg)
  return mode as ApprovalModeConfig
}

// --- Sub-agent / review routing management ---

/** Snapshot of the sub-agent routing blocks for the desktop settings UI.
 *  `council` carries per-seat provider/model for heterogeneous councils. */
export function getRoutingConfig(): { review: ReviewConfig; workers: WorkersConfig; council: CouncilConfig } {
  const cfg = loadConfig()
  return { review: cfg.agent.review, workers: cfg.workers, council: cfg.agent.council }
}

/**
 * Persist sub-agent routing config. Accepts any subset of blocks; each is
 * validated through its own schema before being written, so a malformed payload
 * never lands in config.json. Returns the resulting normalized blocks.
 */
export function setRoutingConfig(input: { review?: unknown; workers?: unknown; council?: unknown }): { review: ReviewConfig; workers: WorkersConfig; council: CouncilConfig } {
  const cfg = loadConfig()
  if (input.review !== undefined) {
    cfg.agent.review = reviewConfigSchema.parse(input.review)
  }
  if (input.workers !== undefined) {
    cfg.workers = workersSchema.parse(input.workers)
  }
  if (input.council !== undefined) {
    cfg.agent.council = councilConfigSchema.parse(input.council)
  }
  saveConfig(cfg)
  return { review: cfg.agent.review, workers: cfg.workers, council: cfg.agent.council }
}

// --- API key management ---

// --- Editor / target-platform conventions ---

/** Snapshot of the editor conventions block for the desktop settings UI. */
export function getEditorConfig(): EditorConfig {
  return loadConfig().editor
}

/**
 * Persist editor conventions (target platform + EOL) to the user global config.
 * Validated through editorSchema. Takes effect on the next sidecar/session start
 * (the target is resolved once at startup via setTargetConventions).
 */
export function setEditorConfig(input: { platform?: unknown; eol?: unknown }): EditorConfig {
  const cfg = loadConfig()
  const merged: Record<string, unknown> = { ...cfg.editor }
  if (input.platform !== undefined) merged.platform = input.platform
  if (input.eol !== undefined) merged.eol = input.eol
  cfg.editor = editorSchema.parse(merged)
  saveConfig(cfg)
  return cfg.editor
}

// --- Shell / Git Bash 路径（Windows 命令执行） ---

export interface ShellConfigSnapshot {
  /** Configured custom Git Bash path, or empty string when unset. */
  gitBashPath: string
  /** Configured custom git executable path, or empty string when unset. */
  gitPath: string
}

/** Snapshot of the shell block (Git Bash / git override) for the desktop settings UI. */
export function getShellConfig(): ShellConfigSnapshot {
  const env = loadConfig().env
  return {
    gitBashPath: env.gitBashPath ?? '',
    gitPath: env.gitPath ?? '',
  }
}

/**
 * Persist a custom Git Bash path to the user global config (`env.gitBashPath`).
 * An empty/whitespace value clears the override. Takes effect on the next
 * sidecar/session start (seeded into RIVET_GIT_BASH_PATH via
 * applyConfiguredGitBashPath). Only meaningful on Windows.
 */
export function setShellConfig(input: { gitBashPath?: unknown; gitPath?: unknown }): ShellConfigSnapshot {
  const cfg = loadConfig()
  const merged: Record<string, unknown> = { ...cfg.env }
  if (input.gitBashPath !== undefined) {
    const raw = String(input.gitBashPath).trim()
    if (raw) merged.gitBashPath = raw
    else delete merged.gitBashPath
  }
  if (input.gitPath !== undefined) {
    const raw = String(input.gitPath).trim()
    if (raw) merged.gitPath = raw
    else delete merged.gitPath
  }
  cfg.env = envSchema.parse(merged)
  saveConfig(cfg)
  return {
    gitBashPath: cfg.env.gitBashPath ?? '',
    gitPath: cfg.env.gitPath ?? '',
  }
}

// --- 网络代理配置（web_fetch / import_resource 的 HTTP 代理） ---

export interface NetworkConfigSnapshot {
  proxy: string
  noProxy: string
}

/** 读取用户全局 config 的 network 段（web_fetch 代理配置）。 */
export function getNetworkConfig(): NetworkConfigSnapshot {
  const net = loadConfig().network
  return {
    proxy: net.proxy ?? '',
    noProxy: net.noProxy ?? '',
  }
}

/**
 * 持久化 HTTP 代理配置到用户全局 config（`network.proxy` / `network.noProxy`）。
 * 空值清除覆盖，回退到环境变量 HTTPS_PROXY/HTTP_PROXY/NO_PROXY。
 * 下次 sidecar/session 启动时生效（buildFetchOptions → httpFetchGuarded）。
 */
export function setNetworkConfig(input: { proxy?: unknown; noProxy?: unknown }): NetworkConfigSnapshot {
  const cfg = loadConfig()
  const merged: Record<string, unknown> = { ...cfg.network }
  if (input.proxy !== undefined) {
    const raw = String(input.proxy).trim()
    if (raw) merged.proxy = raw
    else delete merged.proxy
  }
  if (input.noProxy !== undefined) {
    const raw = String(input.noProxy).trim()
    if (raw) merged.noProxy = raw
    else delete merged.noProxy
  }
  cfg.network = networkSchema.parse(merged)
  saveConfig(cfg)
  return {
    proxy: cfg.network.proxy ?? '',
    noProxy: cfg.network.noProxy ?? '',
  }
}

// --- web_fetch 配置（超时 / UA / 响应大小 / 正文抽取） ---

export interface FetchConfigSnapshot {
  timeoutMs: number
  maxResponseBytes: number
  maxRedirects: number
  userAgent: string
  extractMainContent: boolean
  /** Jina Reader 基础地址（国内可配自建反代）。高级项，桌面端 UI 暂不编辑。 */
  jinaBaseUrl?: string
}

/** 读取用户全局 config 的 fetch 段。 */
export function getFetchConfig(): FetchConfigSnapshot {
  const f = loadConfig().fetch
  return {
    timeoutMs: f.timeoutMs,
    maxResponseBytes: f.maxResponseBytes,
    maxRedirects: f.maxRedirects,
    userAgent: f.userAgent,
    extractMainContent: f.extractMainContent,
    ...(f.jinaBaseUrl ? { jinaBaseUrl: f.jinaBaseUrl } : {}),
  }
}

/**
 * 持久化 web_fetch 配置到用户全局 config（`fetch.*`）。
 * merge 写模式：只传入的字段被更新，未传入的保留原值。
 * 下次 sidecar/session 启动时生效（buildFetchOptions → httpFetchGuarded）。
 */
export function setFetchConfig(input: Record<string, unknown>): FetchConfigSnapshot {
  const cfg = loadConfig()
  const merged: Record<string, unknown> = { ...cfg.fetch }
  for (const [key, val] of Object.entries(input)) {
    if (val === '' || val === null) {
      delete merged[key]
    } else {
      merged[key] = val
    }
  }
  cfg.fetch = fetchSchema.parse(merged)
  saveConfig(cfg)
  return getFetchConfig()
}

// --- web_search 配置（后端链 / 超时 / 区域 / API key） ---

/** API key 来源与掩码引用（与 provider getApiKeyStatus 同构，不返回明文）。 */
export interface SearchKeyStatus {
  source: 'inline' | 'env' | 'none'
  /** inline: ***后4位；env: 变量名；none: 空。 */
  ref: string
}

export interface SearchConfigSnapshot {
  backends: string[]
  braveApiKeyEnv: string
  tavilyApiKeyEnv: string
  bochaApiKeyEnv: string
  timeoutMs: number
  region: string
  /** 各 backend 的 key 状态（掩码，不含明文）——供 UI 显示徽章。 */
  keyStatus: Record<string, SearchKeyStatus>
}

/** 需 key 的 backend 名（bing/ddg 免 key，不在此列）。 */
const KEYED_SEARCH_BACKENDS = ['bocha', 'brave', 'tavily'] as const

/**
 * 读取用户全局 config 的 search 段。inline key 不返回明文，只返回 keyStatus
 * 掩码（与 provider 的 getApiKeyStatus 一致——GET 永远不暴露 key 明文）。
 */
export function getSearchConfig(): SearchConfigSnapshot {
  const s = loadConfig().search
  const keyStatus: Record<string, SearchKeyStatus> = {}
  for (const backend of KEYED_SEARCH_BACKENDS) {
    keyStatus[backend] = getSearchKeyStatus(backend)
  }
  return {
    backends: [...s.backends],
    braveApiKeyEnv: s.braveApiKeyEnv,
    tavilyApiKeyEnv: s.tavilyApiKeyEnv,
    bochaApiKeyEnv: s.bochaApiKeyEnv,
    timeoutMs: s.timeoutMs,
    region: s.region ?? '',
    keyStatus,
  }
}

/**
 * 某个 search backend 的 key 状态（掩码）。解析优先级与 resolveSearchKey 对齐：
 * inline config > apiKeyEnv 指向的 env > 标准变量名。
 */
export function getSearchKeyStatus(backend: string): SearchKeyStatus {
  const s = loadConfig().search
  const inlineKey = s[`${backend}ApiKey` as keyof typeof s]
  if (typeof inlineKey === 'string' && inlineKey.length > 0) {
    return { source: 'inline', ref: '***' + inlineKey.slice(-4) }
  }
  const envName = s[`${backend}ApiKeyEnv` as keyof typeof s]
  if (typeof envName === 'string' && envName && process.env[envName]) {
    return { source: 'env', ref: envName }
  }
  const defaultEnvVar = `${backend.toUpperCase()}_API_KEY`
  if (process.env[defaultEnvVar]) return { source: 'env', ref: defaultEnvVar }
  return { source: 'none', ref: '' }
}

/**
 * 持久化 search backend 的 inline API key（明文存 config，与 provider.apiKey 同构）。
 * 桌面端 UI「设置 Key」按钮走此函数。空串清除 key。
 */
export function setSearchApiKey(backend: string, key: string): SearchKeyStatus {
  if (!KEYED_SEARCH_BACKENDS.includes(backend as typeof KEYED_SEARCH_BACKENDS[number])) {
    throw new Error(`Backend "${backend}" does not support API key (only ${KEYED_SEARCH_BACKENDS.join(', ')})`)
  }
  const cfg = loadConfig()
  const field = `${backend}ApiKey` as keyof typeof cfg.search
  if (key && key.trim()) {
    ;(cfg.search as Record<string, unknown>)[field] = key.trim()
  } else {
    delete (cfg.search as Record<string, unknown>)[field]
  }
  saveConfig(cfg)
  return getSearchKeyStatus(backend)
}

/**
 * 持久化 web_search 配置到用户全局 config（`search.*`）。
 * merge 写模式：只传入的字段被更新，未传入的保留原值。
 * **安全过滤**：`*ApiKey` 字段不经此入口写入（只能走 setSearchApiKey 专用端点），
 * 防止通用 PUT 意外写入或泄露明文 key——与 provider key 的独立端点模式一致。
 * 下次 sidecar/session 启动时生效（buildSearchBackends → runBackendChain）。
 */
export function setSearchConfig(input: Record<string, unknown>): SearchConfigSnapshot {
  const cfg = loadConfig()
  const merged: Record<string, unknown> = { ...cfg.search }
  for (const [key, val] of Object.entries(input)) {
    // 拒绝 inline key 字段经通用端点写入——只能走 setSearchApiKey
    if (key.endsWith('ApiKey')) continue
    if (val === '' || val === null) {
      delete merged[key]
    } else {
      merged[key] = val
    }
  }
  cfg.search = searchSchema.parse(merged)
  saveConfig(cfg)
  return getSearchConfig()
}

// --- Codex 式常驻目录授权（agent.permissions.additionalReadDirs/WriteDirs） ---

export interface PermissionDirsSnapshot {
  additionalReadDirs: string[]
  additionalWriteDirs: string[]
}

/** Snapshot of the standing directory grants for the desktop settings UI. */
export function getPermissionDirs(): PermissionDirsSnapshot {
  const p = loadConfig().agent.permissions
  return {
    additionalReadDirs: [...(p.additionalReadDirs ?? [])],
    additionalWriteDirs: [...(p.additionalWriteDirs ?? [])],
  }
}

/**
 * Persist the standing directory grants to the user global config. Each entry
 * is an absolute or ~-relative directory whose subtree becomes readable /
 * read+writable without an approval round-trip (a drive root grants the whole
 * drive). Entries are trimmed and deduplicated; validation via permissionsSchema.
 * Additions can be applied to the running process by the caller
 * (applyConfiguredPathGrants); removals take effect on the next sidecar start.
 */
export function setPermissionDirs(input: {
  additionalReadDirs?: unknown
  additionalWriteDirs?: unknown
}): PermissionDirsSnapshot {
  const cfg = loadConfig()
  const merged: Record<string, unknown> = { ...cfg.agent.permissions }
  const normalize = (v: unknown, field: string): string[] => {
    if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) {
      throw new Error(`${field} must be an array of strings`)
    }
    return [...new Set((v as string[]).map(s => s.trim()).filter(Boolean))]
  }
  if (input.additionalReadDirs !== undefined) {
    merged.additionalReadDirs = normalize(input.additionalReadDirs, 'additionalReadDirs')
  }
  if (input.additionalWriteDirs !== undefined) {
    merged.additionalWriteDirs = normalize(input.additionalWriteDirs, 'additionalWriteDirs')
  }
  cfg.agent.permissions = permissionsSchema.parse(merged)
  saveConfig(cfg)
  return {
    additionalReadDirs: [...cfg.agent.permissions.additionalReadDirs],
    additionalWriteDirs: [...cfg.agent.permissions.additionalWriteDirs],
  }
}

// --- Auto 检查点 (C3) ---

export interface CheckpointConfigSnapshot {
  checkpointEveryTurns: number
}

/** Snapshot of the checkpoint interval for the desktop/TUI settings UI. */
export function getCheckpointConfig(): CheckpointConfigSnapshot {
  return { checkpointEveryTurns: loadConfig().agent.checkpointEveryTurns }
}

/**
 * Persist the checkpoint interval for Auto mode (auto-safe).
 * 0 = off (no pause). Takes effect at the next run().
 */
export function setCheckpointConfig(input: {
  checkpointEveryTurns?: unknown
}): CheckpointConfigSnapshot {
  const cfg = loadConfig()
  if (input.checkpointEveryTurns !== undefined) {
    const v = Number(input.checkpointEveryTurns)
    if (!Number.isInteger(v) || v < 0) throw new Error('checkpointEveryTurns must be a non-negative integer')
    cfg.agent.checkpointEveryTurns = v
  }
  saveConfig(cfg)
  return { checkpointEveryTurns: cfg.agent.checkpointEveryTurns }
}

// --- Approval mode (桌面端设置页授权档位) ---

export interface ApprovalConfigSnapshot {
  approval: string
  unsandboxed: boolean
}

export const APPROVAL_MODE_OPTIONS = ['auto-accept', 'auto-safe', 'suggest', 'manual', 'dangerously-skip-permissions'] as const

/** Snapshot of the agent approval mode for the desktop settings UI. */
export function getApprovalConfig(): ApprovalConfigSnapshot {
  const cfg = loadConfig()
  return { approval: cfg.agent.approval, unsandboxed: cfg.agent.unsandboxed ?? false }
}

/** Persist the agent approval mode (e.g. dangerously-skip-permissions for
 *  full autonomy) and optional sandbox bypass. Takes effect at the next run(). */
export function setApprovalConfig(input: { approval?: unknown; unsandboxed?: unknown }): ApprovalConfigSnapshot {
  const cfg = loadConfig()
  if (input.approval !== undefined) {
    const v = String(input.approval)
    if (!(APPROVAL_MODE_OPTIONS as readonly string[]).includes(v)) {
      throw new Error(`approval must be one of: ${APPROVAL_MODE_OPTIONS.join(', ')}`)
    }
    cfg.agent.approval = v as typeof cfg.agent.approval
  }
  if (input.unsandboxed !== undefined) {
    if (typeof input.unsandboxed !== 'boolean') throw new Error('unsandboxed must be a boolean')
    cfg.agent.unsandboxed = input.unsandboxed
  }
  saveConfig(cfg)
  return { approval: cfg.agent.approval, unsandboxed: cfg.agent.unsandboxed ?? false }
}

// --- Delivery auto-commit toggle ---

export interface DeliveryConfigSnapshot {
  /** false = deliver_task 只出报告不提交。默认 true（向后兼容）。 */
  autoCommit: boolean
}

export function getDeliveryConfig(): DeliveryConfigSnapshot {
  return { autoCommit: loadConfig().agent.delivery?.autoCommit !== false }
}

export function setDeliveryConfig(input: { autoCommit?: unknown }): DeliveryConfigSnapshot {
  const cfg = loadConfig()
  if (input.autoCommit !== undefined) {
    if (typeof input.autoCommit !== 'boolean') throw new Error('autoCommit must be a boolean')
    cfg.agent.delivery = { ...cfg.agent.delivery, autoCommit: input.autoCommit }
  }
  saveConfig(cfg)
  return { autoCommit: cfg.agent.delivery?.autoCommit !== false }
}

// --- Tool preset (minimal/frontend/full/taiyi, session-start assembly tier) ---

export interface ToolPresetConfigSnapshot {
  preset: 'minimal' | 'frontend' | 'full' | 'taiyi'
}

const TOOL_PRESETS = new Set(['minimal', 'frontend', 'full', 'taiyi'])

/** Snapshot of the tool preset for the desktop/TUI settings UI. */
export function getToolPresetConfig(): ToolPresetConfigSnapshot {
  return { preset: loadConfig().tools.preset ?? 'frontend' }
}

/**
 * Persist the tool preset. Takes effect at the NEXT session — tool
 * definitions are frozen for a session's lifetime (mid-session fingerprint
 * change = full prefix-cache rebuild, never worth it).
 */
export function setToolPresetConfig(input: { preset?: unknown }): ToolPresetConfigSnapshot {
  const cfg = loadConfig()
  if (input.preset !== undefined) {
    if (typeof input.preset !== 'string' || !TOOL_PRESETS.has(input.preset)) {
      throw new Error(`preset must be one of: minimal | frontend | full | taiyi`)
    }
    cfg.tools.preset = input.preset as ToolPresetConfigSnapshot['preset']
  }
  saveConfig(cfg)
  // 长驻进程（desktop sidecar）内 memo 必须失效，否则新会话拿到旧档位。
  invalidateToolPreset()
  return { preset: cfg.tools.preset ?? 'frontend' }
}

// --- Runtime lean (resource profile) ---

export interface RuntimeLeanConfigSnapshot {
  lean: boolean
  maxLoadedSessions?: number
  idleAgentTtlMs?: number
  maxEventsDiskBytes?: number
}

/** 域级 runtime 覆盖（runtime.domains[domainId]，见 runtime-lean.ts）。 */
export interface RuntimeDomainConfigSnapshot extends RuntimeLeanConfigSnapshot {
  toolPreset?: 'minimal' | 'frontend' | 'full' | 'taiyi'
}

/** Snapshot of runtime.lean (+ optional pool caps) for desktop/TUI settings. */
export function getRuntimeLeanConfig(): RuntimeLeanConfigSnapshot & { domains?: Record<string, RuntimeDomainConfigSnapshot> } {
  const runtime = loadConfig().runtime ?? { lean: false }
  return {
    lean: runtime.lean === true,
    ...(runtime.maxLoadedSessions !== undefined ? { maxLoadedSessions: runtime.maxLoadedSessions } : {}),
    ...(runtime.idleAgentTtlMs !== undefined ? { idleAgentTtlMs: runtime.idleAgentTtlMs } : {}),
    ...(runtime.maxEventsDiskBytes !== undefined ? { maxEventsDiskBytes: runtime.maxEventsDiskBytes } : {}),
    ...(runtime.domains && Object.keys(runtime.domains).length > 0
      ? { domains: runtime.domains as Record<string, RuntimeDomainConfigSnapshot> }
      : {}),
  }
}

/** 校验单个域覆盖条目（lean/阈值委托 validateRuntimeLeanSlice，toolPreset 自校验）。 */
function validateDomainSlice(id: string, slice: unknown): void {
  if (typeof slice !== 'object' || slice === null) {
    throw new Error(`domains.${id} must be an object`)
  }
  const s = slice as Record<string, unknown>
  validateRuntimeLeanSlice(s, `domains.${id}`)
  if (s.toolPreset !== undefined && (typeof s.toolPreset !== 'string' || !TOOL_PRESETS.has(s.toolPreset))) {
    throw new Error(`domains.${id}.toolPreset must be one of minimal/frontend/full/taiyi`)
  }
}

/**
 * Persist runtime.lean. Takes effect at the NEXT session for tool/prompt/hook
 * assembly (prefix-cache safe). Session pool caps apply on next sidecar start.
 *
 * `domains` 为增量合并：`{ [domainId]: slice | null }`——null 删除该域覆盖，
 * 缺省字段保留磁盘现值。其余字段同全局语义。
 */
export function setRuntimeLeanConfig(input: {
  lean?: unknown
  maxLoadedSessions?: unknown
  idleAgentTtlMs?: unknown
  maxEventsDiskBytes?: unknown
  domains?: Record<string, unknown> | null
}): RuntimeLeanConfigSnapshot & { domains?: Record<string, RuntimeDomainConfigSnapshot> } {
  const cfg = loadConfig()
  const next = { ...(cfg.runtime ?? { lean: false }) }
  // lean/三阈值校验统一委托 validateRuntimeLeanSlice（下限与 schema/UI 同源，
  // 消除手写 `< N` 抛错——maxEventsDiskBytes 下限曾在此处与 UI 漂移过）。
  validateRuntimeLeanSlice(input as Record<string, unknown>)
  // 校验通过即代表这四个字段类型合规，但 TS 看不见这层保证——`unknown` 经
  // `!== undefined` 只收窄到 `{} | null`。故在校验之后取一次收窄视图，而不是
  // 逐字段 as：那会让"哪些字段已被 validate 担保"散落成四处独立断言。
  const validated = input as RuntimeLeanConfigSlice
  if (validated.lean !== undefined) next.lean = validated.lean
  if (validated.maxLoadedSessions !== undefined) next.maxLoadedSessions = validated.maxLoadedSessions
  if (validated.idleAgentTtlMs !== undefined) next.idleAgentTtlMs = validated.idleAgentTtlMs
  if (validated.maxEventsDiskBytes !== undefined) next.maxEventsDiskBytes = validated.maxEventsDiskBytes
  if (input.domains !== undefined) {
    if (input.domains === null) {
      next.domains = undefined
    } else {
      if (typeof input.domains !== 'object') throw new Error('domains must be an object')
      const merged = { ...next.domains }
      for (const [id, slice] of Object.entries(input.domains)) {
        if (slice === null) {
          delete merged[id]
          continue
        }
        validateDomainSlice(id, slice)
        merged[id] = { ...merged[id], ...(slice as Record<string, unknown>) }
      }
      next.domains = merged
    }
  }
  cfg.runtime = next
  saveConfig(cfg)
  invalidateToolPreset()
  invalidatePromptBlocks()
  return getRuntimeLeanConfig()
}

// --- Default star domain (new-session initial domain + Auto keyword routing) ---

export interface DefaultDomainConfigSnapshot {
  /** 'auto' 或星域 id（qiming / tianshu / kaiyang / …），默认 qiming。 */
  defaultDomain: string
  /** Auto 是否按首条消息关键词匹配换域（未命中回退天权）。 */
  domainKeywordRouting: boolean
}

/** Snapshot of the default star-domain config for the desktop/TUI settings UI. */
export function getDefaultDomainConfig(): DefaultDomainConfigSnapshot {
  const cfg = loadConfig()
  return {
    defaultDomain: cfg.agent.defaultDomain ?? 'qiming',
    domainKeywordRouting: cfg.agent.domainKeywordRouting !== false,
  }
}

/**
 * Persist default star domain / Auto keyword routing. Takes effect at the
 * NEXT session — session domain is pinned before the first request and stays
 * stable within a session (prefix-cache anchor).
 *
 * 域 id 的有效性由调用方（config route 持有 starDomainRegistry）校验；
 * 这里只做形状校验，config 层不反向依赖 agent 层。
 */
export function setDefaultDomainConfig(input: { defaultDomain?: unknown; domainKeywordRouting?: unknown }): DefaultDomainConfigSnapshot {
  const cfg = loadConfig()
  if (input.defaultDomain !== undefined) {
    if (typeof input.defaultDomain !== 'string' || input.defaultDomain.trim() === '') {
      throw new Error('defaultDomain must be a non-empty string ("auto" or a star-domain id)')
    }
    cfg.agent.defaultDomain = input.defaultDomain.trim()
  }
  if (input.domainKeywordRouting !== undefined) {
    if (typeof input.domainKeywordRouting !== 'boolean') {
      throw new Error('domainKeywordRouting must be a boolean')
    }
    cfg.agent.domainKeywordRouting = input.domainKeywordRouting
  }
  saveConfig(cfg)
  return {
    defaultDomain: cfg.agent.defaultDomain ?? 'qiming',
    domainKeywordRouting: cfg.agent.domainKeywordRouting !== false,
  }
}

// --- Default model ---

export interface DefaultModelConfigSnapshot {
  /** "provider:modelId" 格式；未配置时为 null。 */
  defaultModel: string | null
  /** 默认推理等级；未配置（=auto）时为 null。 */
  defaultEffort: 'off' | 'low' | 'medium' | 'high' | 'max' | null
}

/** Snapshot of the default model config for the TUI model picker 's' key. */
export function getDefaultModelConfig(): DefaultModelConfigSnapshot {
  const cfg = loadConfig()
  return {
    defaultModel: cfg.agent.defaultModel ?? null,
    defaultEffort: cfg.agent.defaultEffort ?? null,
  }
}

/**
 * Persist the default model for new sessions. Format: "provider:modelId".
 * Takes effect at the NEXT session — the session model is resolved once at
 * startup and stays stable (prefix-cache anchor).
 *
 * 格式和存在性校验：provider 必须存在于当前配置中，model 必须在 provider 的
 * models 列表中。校验放在此层以避免调用方（TUI main.ts）访问 config internals。
 */
/**
 * Toggle `supportsVision` on an existing stored model. Used by the TUI /config
 * panel to retroactively mark a model as vision-capable (e.g. a custom provider
 * created before the vision question existed, or a built-in model the user wants
 * to use as a bridge). Idempotent: setting the same value is a no-op write.
 *
 * 显式 false 而非 delete：缺席会被 preset backfill 当成"没表态"回灌 true，
 * 用户对 preset 视觉模型的取消勾选下次 loadConfig 就消失了。消费侧一律
 * `=== true` / `?? false`，写 false 与缺席行为等价。
 */
export function setModelSupportsVision(providerName: string, modelId: string, value: boolean): void {
  const cfg = loadConfig()
  const provider = cfg.provider.providers[providerName]
  if (!provider) throw new Error(`Provider "${providerName}" not found`)
  const model = provider.models.find(m => m.id === modelId || m.alias === modelId)
  if (!model) throw new Error(`Model "${modelId}" not found in provider "${providerName}"`)
  // 直接比较而非 `=== true`：从未设置（undefined）→ false 也是真实表态，必须写盘。
  if (model.supportsVision === value) return // no-op, avoid unnecessary disk write
  model.supportsVision = value
  saveConfig(cfg)
}

const DEFAULT_EFFORT_VALUES = ['off', 'low', 'medium', 'high', 'max'] as const

export function setDefaultModelConfig(input: { defaultModel?: unknown; defaultEffort?: unknown }): DefaultModelConfigSnapshot {
  const cfg = loadConfig()
  if (input.defaultModel !== undefined) {
    if (typeof input.defaultModel !== 'string' || input.defaultModel.trim() === '') {
      throw new Error('defaultModel must be a non-empty "provider:modelId" string')
    }
    const trimmed = input.defaultModel.trim()
    const colonIdx = trimmed.indexOf(':')
    if (colonIdx < 1 || colonIdx === trimmed.length - 1) {
      throw new Error('defaultModel must be in "provider:modelId" format')
    }
    const providerName = trimmed.slice(0, colonIdx)
    const modelId = trimmed.slice(colonIdx + 1)
    const provider = cfg.provider.providers[providerName]
    if (!provider) {
      throw new Error(`Provider "${providerName}" not found in configuration`)
    }
    if (!provider.models.some(m => m.id === modelId || m.alias === modelId)) {
      throw new Error(`Model "${modelId}" not found in provider "${providerName}"`)
    }
    cfg.agent.defaultModel = trimmed
  }
  // defaultEffort（CC 对标）：undefined = 不动；null / 'auto' = 删字段回自动；
  // 显式档位 = 覆盖（desktop 与 TUI /model 面板共用此入口）。
  if (input.defaultEffort !== undefined) {
    if (input.defaultEffort === null || input.defaultEffort === 'auto') {
      delete cfg.agent.defaultEffort
    } else if (typeof input.defaultEffort === 'string' && (DEFAULT_EFFORT_VALUES as readonly string[]).includes(input.defaultEffort)) {
      cfg.agent.defaultEffort = input.defaultEffort as (typeof DEFAULT_EFFORT_VALUES)[number]
    } else {
      throw new Error('defaultEffort must be one of off|low|medium|high|max (or null/auto to reset)')
    }
  }
  saveConfig(cfg)
  return {
    defaultModel: cfg.agent.defaultModel ?? null,
    defaultEffort: cfg.agent.defaultEffort ?? null,
  }
}

// --- Vision model bridge (multimodal image recognition) ---

const visionModelConfigSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  prompt: z.string().optional(),
  maxTokens: z.number().int().positive().default(1024),
  fallback: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
  }).optional(),
})

export interface VisionModelConfigSnapshot {
  provider: string
  model: string
  prompt?: string
  maxTokens: number
  fallback?: { provider: string; model: string }
}

/** Snapshot of the optional vision bridge model for the desktop/TUI settings UI. */
export function getVisionModelConfig(): VisionModelConfigSnapshot | null {
  return loadConfig().agent.visionModel ?? null
}

/** Opt-in flag: auto-pick a vision bridge when `visionModel` is unset. */
export function getVisionAutoBridge(): boolean {
  return loadConfig().agent.visionAutoBridge
}

/**
 * Persist the auto-bridge opt-in. Off by default because auto-bridging sends the
 * user's images to a provider they never picked for that purpose.
 * Takes effect on the next session start.
 */
export function setVisionAutoBridge(enabled: boolean): boolean {
  const cfg = loadConfig()
  cfg.agent.visionAutoBridge = enabled
  saveConfig(cfg)
  return enabled
}

/**
 * Persist the vision bridge model to the user global config.
 * Pass `null` or empty provider/model to clear the bridge.
 * Takes effect on the next session start.
 *
 * `fallback` 的三态是刻意的：**省略 = 保留现有备用桥**，`null` = 清除，对象 = 设置。
 * 早期实现直接整体替换，于是任何不带 `fallback` 的写入（桌面端旧 UI、TUI 设置面板、
 * 第三方客户端）都会静默抹掉用户手写的备用识图模型——同一份配置被两个界面轮流写时，
 * 后写的那个界面不知道的字段就消失了。省略即保留把"我没提到它"和"我要删掉它"分开。
 */
export function setVisionModelConfig(
  input:
    | { provider?: unknown; model?: unknown; prompt?: unknown; maxTokens?: unknown; fallback?: unknown }
    | null,
): VisionModelConfigSnapshot | null {
  const cfg = loadConfig()
  if (input === null || input.provider === '' || input.model === '') {
    delete (cfg.agent as Record<string, unknown>).visionModel
    saveConfig(cfg)
    return null
  }
  const fallback = 'fallback' in input
    ? (input.fallback === null ? undefined : input.fallback)
    : cfg.agent.visionModel?.fallback
  const parsed = visionModelConfigSchema.parse({ ...input, fallback })
  // 不留显式 undefined 键：zod 会把它保下来，返回对象凭空多一个字段，调用方的
  // 结构比较就莫名失败。
  if (parsed.fallback === undefined) delete parsed.fallback

  // provider/model 存在性校验——与 setDefaultModelConfig 对齐。
  // 此前 vision 这条线不校验，CLI 用户手编 provider 名但没 setup 该 provider 时，
  // 写盘成功，运行时 buildVisionClient 静默 warn 退出（图片被丢），用户以为配了
  // 实际没生效。校验主桥 + fallback 桥（如有）。
  assertProviderModelExists(cfg, parsed.provider, parsed.model, '视觉模型')
  if (parsed.fallback) {
    assertProviderModelExists(cfg, parsed.fallback.provider, parsed.fallback.model, '备用视觉模型')
  }

  cfg.agent.visionModel = parsed
  saveConfig(cfg)
  return parsed
}

export interface RegisterVisionModelConfigOptions {
  providerName: string
  baseUrl: string
  apiKey?: string
  apiKeyEnv?: string
  modelId: string
}

/**
 * Register an image-analysis-only provider and select it as the vision bridge in
 * one config write. The primary provider/default model are deliberately left
 * untouched; this entry is consumed only through agent.visionModel.
 */
export function registerVisionModelConfig(
  options: RegisterVisionModelConfigOptions,
): VisionModelConfigSnapshot {
  const providerName = z.string().trim().min(1).parse(options.providerName)
  const modelId = z.string().trim().min(1).parse(options.modelId)
  const apiKey = options.apiKey?.trim()
  const apiKeyEnv = options.apiKeyEnv?.trim()
  if (apiKey && apiKeyEnv) {
    throw new Error('Vision provider credentials must use either apiKey or apiKeyEnv, not both.')
  }
  if (options.apiKey !== undefined && !apiKey) throw new Error('Vision provider apiKey must not be blank.')
  if (options.apiKeyEnv !== undefined && !apiKeyEnv) throw new Error('Vision provider apiKeyEnv must not be blank.')
  assertValidUrl(options.baseUrl)

  const model = modelConfigSchema.parse({ id: modelId, maxTokens: 1024, supportsVision: true })
  const vision = visionModelConfigSchema.parse({ provider: providerName, model: modelId, maxTokens: 1024 })
  const provider: ProviderConfig = {
    name: providerName,
    ...(apiKey ? { keyRef: providerName } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    baseUrl: options.baseUrl,
    protocol: 'openai',
    capabilities: {},
    thinking: 'enabled',
    maxTokens: 1024,
    allowProFallback: false,
    models: [model],
    unsupported: [],
    userSaved: true,
  }

  const cfg = loadConfig()
  const existing = cfg.provider.providers[providerName]
  if (providerName === cfg.provider.default) {
    throw new Error(`Vision provider "${providerName}" cannot replace the default provider.`)
  }
  if (existing && !isCompatibleVisionProvider(cfg, existing, providerName, options.baseUrl, apiKey, apiKeyEnv)) {
    throw new Error(`Provider "${providerName}" is not a compatible dedicated vision provider.`)
  }

  const previousProvider = existing
  const previousVision = cfg.agent.visionModel
  cfg.provider.providers[providerName] = provider
  cfg.agent.visionModel = vision
  saveConfig(cfg)
  try {
    if (apiKey) writeSecret(providerName, apiKey)
  } catch (error) {
    if (previousProvider) cfg.provider.providers[providerName] = previousProvider
    else delete cfg.provider.providers[providerName]
    if (previousVision) cfg.agent.visionModel = previousVision
    else delete (cfg.agent as Record<string, unknown>).visionModel
    try {
      saveConfig(cfg)
    } catch {
      // Preserve the original secret-write error; a failed rollback is actionable from config state.
    }
    throw error
  }
  return vision
}

function isCompatibleVisionProvider(
  cfg: Config,
  existing: ProviderConfig,
  providerName: string,
  baseUrl: string,
  apiKey: string | undefined,
  apiKeyEnv: string | undefined,
): boolean {
  if (cfg.agent.visionModel?.provider !== providerName || existing.baseUrl !== baseUrl) return false
  if (apiKeyEnv) return existing.apiKeyEnv === apiKeyEnv
  if (apiKey) return existing.keyRef === providerName && existing.apiKey === apiKey
  return !existing.keyRef && !existing.apiKeyEnv
}

/**
 * 校验 provider 在 provider.providers 里存在、且该 provider 下有指定 model。
 * 与 setDefaultModelConfig 的内联校验同构，抽出复用给 vision 主桥/fallback。
 * 不校验 key 是否可解出（key 解析留到运行时 resolveApiKey——与 defaultModel 一致，
 * defaultModel 也只校验 provider/model 存在）。
 */
function assertProviderModelExists(cfg: Config, providerName: string, modelId: string, label: string): void {
  const provider = cfg.provider.providers[providerName]
  if (!provider) {
    throw new Error(`${label}：provider "${providerName}" 不在已配置的 provider 列表里（先用 rivet config setup ${providerName} 添加）`)
  }
  if (!provider.models.some(m => m.id === modelId || m.alias === modelId)) {
    throw new Error(`${label}：provider "${providerName}" 下没有模型 "${modelId}"（检查拼写或用 rivet config add-model 添加）`)
  }
}

// --- Greeting LLM configuration (welcome page dynamic greeting) ---

const greetingConfigSchema = z.object({
  enabled: z.boolean(),
  model: z.string().min(1),
})

export interface GreetingConfigSnapshot {
  enabled: boolean
  model: string
}

/** Snapshot of the greeting LLM config for the desktop/TUI settings UI.
 *  Falls back to defaults ({ enabled: true, model: 'deepseek-v4-flash' })
 *  when no user config is present. */
export function getGreetingConfig(): GreetingConfigSnapshot {
  return loadConfig().agent.greeting ?? { enabled: true, model: 'deepseek-v4-flash' }
}

/**
 * Persist the greeting LLM config to the user global config.
 * Pass `null` to reset to defaults.
 */
export function setGreetingConfig(
  input: { enabled?: unknown; model?: unknown } | null,
): GreetingConfigSnapshot | null {
  const cfg = loadConfig()
  if (input === null) {
    delete (cfg.agent as Record<string, unknown>).greeting
    saveConfig(cfg)
    return null
  }
  const parsed = greetingConfigSchema.parse(input)
  cfg.agent.greeting = parsed
  saveConfig(cfg)
  return parsed
}

/** Snapshot of the mirror configuration block. */
export function getMirrorConfig(): MirrorsConfig {
  return loadConfig().mirrors
}

/**
 * Persist mirror configuration to the user global config.
 * Validated through mirrorsSchema. Takes effect on the next bash execution.
 */
export function setMirrorConfig(input: {
  enabled?: unknown
  preset?: unknown
  github?: unknown
  npm?: unknown
  pypi?: unknown
  go?: unknown
  rust?: unknown
  autoFallback?: unknown
  fallbackMemoryMinutes?: unknown
  fallbackTimeoutSec?: unknown
}): MirrorsConfig {
  const cfg = loadConfig()
  const merged: Record<string, unknown> = { ...cfg.mirrors }
  for (const key of ['enabled', 'preset', 'github', 'npm', 'pypi', 'go', 'rust', 'autoFallback', 'fallbackMemoryMinutes', 'fallbackTimeoutSec'] as const) {
    if (input[key] !== undefined) merged[key] = input[key]
  }
  cfg.mirrors = mirrorsSchema.parse(merged)
  saveConfig(cfg)
  return cfg.mirrors
}

/** Snapshot of the GitHub PR panel defaults block (desktop CI loop). */
export function getPrDefaultsConfig(): PrDefaultsConfig {
  return loadConfig().prDefaults
}

/**
 * Persist GitHub PR defaults (merge method / auto-fix / auto-merge / CI poll
 * cadence) to the user global config. Validated through prDefaultsSchema.
 */
export function setPrDefaultsConfig(input: {
  mergeMethod?: unknown
  autoFix?: unknown
  autoMerge?: unknown
  ciPollSeconds?: unknown
}): PrDefaultsConfig {
  const cfg = loadConfig()
  const merged: Record<string, unknown> = { ...cfg.prDefaults }
  for (const key of ['mergeMethod', 'autoFix', 'autoMerge', 'ciPollSeconds'] as const) {
    if (input[key] !== undefined) merged[key] = input[key]
  }
  cfg.prDefaults = prDefaultsSchema.parse(merged)
  saveConfig(cfg)
  return cfg.prDefaults
}

/** Snapshot of the UI preferences block for the TUI settings panel. */
export function getUiConfig(): UiConfig {
  return loadConfig().ui
}

/**
 * Persist UI preferences (default theme, etc.) to the user global config.
 * Validated through uiSchema. Theme changes take effect on the next session start.
 */
export function setUiConfig(input: { theme?: unknown }): UiConfig {
  const cfg = loadConfig()
  const merged: Record<string, unknown> = { ...cfg.ui }
  if ('theme' in input) {
    if (input.theme === undefined) {
      delete merged.theme
    } else {
      merged.theme = input.theme
    }
  }
  cfg.ui = uiSchema.parse(merged)
  saveConfig(cfg)
  return cfg.ui
}

export function setApiKey(providerName: string, key: string): void {
  // 先校验 provider 存在再写 secret——顺序反了会对不存在的 provider 留孤儿密钥
  // （无任何 config 条目引用它，removeProvider 也清不到）。
  const cfg = loadConfig()
  const provider = cfg.provider.providers[providerName]
  if (!provider) throw new Error(`Provider "${providerName}" not found`)
  writeSecret(providerName, key)
  provider.keyRef = providerName
  ;(provider as unknown as { apiKey?: string | null }).apiKey = null
  ;(provider as unknown as { apiKeyEnv?: string | null }).apiKeyEnv = null
  saveConfig(cfg)
}

export function setApiKeyEnv(providerName: string, envVar: string): void {
  const cfg = loadConfig()
  const provider = cfg.provider.providers[providerName]
  if (!provider) throw new Error(`Provider "${providerName}" not found`)
  provider.apiKeyEnv = envVar
  ;(provider as unknown as { apiKey?: string | null }).apiKey = null
  ;(provider as unknown as { keyRef?: string | null }).keyRef = null
  saveConfig(cfg)
}

export interface ClearApiKeyResult {
  name: string
  /** 清除后再查的状态——env 注入的 key 清不掉，会如实报回 source:'env'。 */
  keyStatus: { source: 'inline' | 'env' | 'none'; ref: string }
  /** 是否已从 secrets.json 删除对应密钥。 */
  secretDeleted: boolean
  /** 其他 provider 仍引用同一 keyRef 时列出——密钥因此保留。 */
  keyRefSharedWith: string[]
}

/**
 * 清除 provider 上保存的 key，但保留 provider 本体与模型列表。允许清除默认
 * provider——这正是「首次安装删不掉 key」的修复点：清 key 后 provider 变
 * keyless，运行侧经 isModelSpecUsable fail-closed，/health configured 随之
 * 翻回 setup 模式引导重配。env 注入的 key（apiKeyEnv 指向或 <NAME>_API_KEY
 * 回退命中）不属于本函数可清除范围——配置引用清掉后若进程环境变量仍在，
 * keyStatus 会如实报回 source:'env'，由 UI 引导去系统环境变量处理。
 */
export function clearApiKey(providerName: string): ClearApiKeyResult {
  const cfg = loadConfig()
  const provider = cfg.provider.providers[providerName]
  if (!provider) throw new Error(`Provider "${providerName}" not found`)
  const keyRef = provider.keyRef
  ;(provider as unknown as { apiKey?: string | null }).apiKey = null
  ;(provider as unknown as { apiKeyEnv?: string | null }).apiKeyEnv = null
  ;(provider as unknown as { keyRef?: string | null }).keyRef = null
  saveConfig(cfg)

  // 与 removeProvider 同守卫：keyRef 仍被其他 provider 引用时保留密钥。
  let secretDeleted = false
  const keyRefSharedWith = keyRef
    ? Object.entries(cfg.provider.providers)
        .filter(([, p]) => p.keyRef === keyRef)
        .map(([n]) => n)
    : []
  if (keyRef && keyRefSharedWith.length === 0 && readSecret(keyRef) !== undefined) {
    deleteSecret(keyRef)
    secretDeleted = true
  }
  return { name: providerName, keyStatus: getApiKeyStatus(providerName), secretDeleted, keyRefSharedWith }
}

export function getApiKeyStatus(providerName: string): { source: 'inline' | 'env' | 'none'; ref: string } {
  const provider = getProvider(providerName)
  if (!provider) return { source: 'none', ref: '' }
  // keyRef-backed secret: loadConfig materializes it into provider.apiKey, so
  // this branch also reports the masked tail of the secrets-store value.
  if (provider.apiKey) return { source: 'inline', ref: '***' + provider.apiKey.slice(-4) }
  if (provider.apiKeyEnv && process.env[provider.apiKeyEnv]) {
    return { source: 'env', ref: provider.apiKeyEnv }
  }
  // Standard env var fallback so the UI shows "env" even when apiKeyEnv is missing.
  const defaultEnvVar = `${providerName.toUpperCase()}_API_KEY`
  if (process.env[defaultEnvVar]) return { source: 'env', ref: defaultEnvVar }
  return { source: 'none', ref: '' }
}

export interface UpsertProviderModelOptions {
  preferred?: boolean
}

export interface SetupProviderOptions {
  providerName: string
  preset?: ProviderPresetKey
  apiKey?: string
  apiKeyEnv?: string
  baseUrl?: string
  model?: ModelConfig
  /** 批量模型回填（免密钥 preset 探测路径）——每项走与 model 相同的合并语义。 */
  models?: Array<Partial<ModelConfig> & { id: string }>
  makeDefault?: boolean
  allowProFallback?: boolean
  /** Advanced knobs (timeout/retry/temperature/proxy) — undefined = untouched. */
  advanced?: ProviderAdvancedConfig
}

function assertValidUrl(value: string): void {
  try {
    new URL(value)
  } catch {
    throw new Error(`Invalid provider baseUrl: ${value}`)
  }
}

export function updateProviderBaseUrl(providerName: string, baseUrl: string): void {
  assertValidUrl(baseUrl)
  const cfg = loadConfig()
  const provider = cfg.provider.providers[providerName]
  if (!provider) throw new Error(`Provider "${providerName}" not found`)
  provider.baseUrl = baseUrl
  saveConfig(cfg)
}

/**
 * Clamp a model's output ceiling to its context window. `maxTokens` is the
 * single-response output cap and can never exceed the total window; letting a
 * mis-typed value through (e.g. maxTokens=1M on a 128K model) skews compaction
 * headroom and can trip provider 400s. This is the shared backstop for every
 * config write path (wizard, desktop form, direct upsert).
 */
export function clampModelTokens<T extends { contextWindow: number; maxTokens: number }>(model: T): T {
  const contextWindow = Math.max(1, Math.floor(model.contextWindow))
  const maxTokens = Math.max(1, Math.min(Math.floor(model.maxTokens), contextWindow))
  return { ...model, contextWindow, maxTokens }
}

/**
 * Merge a model update onto the existing entry instead of replacing it.
 *
 * Every write path here carries a *partial* model: the desktop Settings form
 * sends only `{id, alias, contextWindow, maxTokens}`, and `rivet config
 * set-model` sends just what the user typed. Whole-object replacement drops
 * every field the form does not carry — `supportsVision`, `tier`, `pricing` —
 * and all three failures are silent: images get dropped with no error, tier
 * falls back to guessing from the model name, cost accounting reads zero.
 * An absent key means "caller had no opinion", so the stored value wins;
 * clearing a field is `removeModel`'s job, not a side effect of editing a
 * context window.
 */
function mergeModelUpdate(existing: ModelConfig, incoming: ModelConfig): ModelConfig {
  const merged: Record<string, unknown> = { ...existing }
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined) merged[key] = value
  }
  return clampModelTokens(merged as ModelConfig)
}

export function upsertProviderModel(providerName: string, model: ModelConfig, options: UpsertProviderModelOptions = {}): void {
  const cfg = loadConfig()
  const provider = cfg.provider.providers[providerName]
  if (!provider) throw new Error(`Provider "${providerName}" not found`)
  model = clampModelTokens(model)
  const existingIndex = provider.models.findIndex(item => item.id === model.id || (model.alias !== undefined && item.alias === model.alias))
  const existing = existingIndex >= 0 ? provider.models[existingIndex] : undefined
  if (existing) provider.models[existingIndex] = mergeModelUpdate(existing, model)
  else provider.models.push(model)
  if (options.preferred) {
    const preferredIndex = provider.models.findIndex(item => item.id === model.id)
    const preferred = provider.models.splice(preferredIndex, 1)[0]
    if (preferred) provider.models.unshift(preferred)
  }
  provider.userSaved = true
  saveConfig(cfg)
}

export function setProviderAllowProFallback(providerName: string, allowProFallback: boolean): void {
  const cfg = loadConfig()
  const provider = cfg.provider.providers[providerName]
  if (!provider) throw new Error(`Provider "${providerName}" not found`)
  provider.allowProFallback = allowProFallback
  saveConfig(cfg)
}

/**
 * Write advanced knobs field-by-field. `!== undefined` guards are load-bearing:
 * `maxRetries: 0` and `temperature: 0` are legal values a truthy check would drop.
 */
function applyAdvancedConfig(target: ProviderConfig, advanced?: ProviderAdvancedConfig): void {
  if (!advanced) return
  if (advanced.requestTimeoutMs !== undefined) target.requestTimeoutMs = advanced.requestTimeoutMs
  if (advanced.maxRetries !== undefined) target.maxRetries = advanced.maxRetries
  if (advanced.temperature !== undefined) target.temperature = advanced.temperature
  if (advanced.proxy !== undefined) target.proxy = advanced.proxy
  if (advanced.retry !== undefined) target.retry = advanced.retry   // 嵌套对象：整体替换（子键合并会留下删不掉的幽灵字段）
}

/** Persist the config first; a failed secret write must not leave a dangling keyRef. */
function saveProviderConfigWithSecret(config: Config, previousConfig: Config, keyRef?: string, apiKey?: string): void {
  saveConfig(config)
  if (!keyRef || !apiKey) return
  try {
    writeSecret(keyRef, apiKey)
  } catch (error) {
    try {
      saveConfig(previousConfig)
    } catch (rollbackError) {
      throw new Error(
        `Failed to save API key and could not restore the previous configuration: ${
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        }`,
        { cause: error },
      )
    }
    throw error
  }
}

export function setupProvider(options: SetupProviderOptions): void {
  const cfg = loadConfig()
  const previousConfig = structuredClone(cfg)
  const presetKey = options.preset ?? (resolvePreset(options.providerName) ? options.providerName : undefined)
  const current = cfg.provider.providers[options.providerName]
  const base = presetKey ? cloneResolvedPreset(presetKey) : current
  if (!base) throw new Error(`Provider "${options.providerName}" not found and no preset is available`)
  const next: ProviderConfig = structuredClone(base)
  next.name = options.providerName
  if (current) Object.assign(next, current)
  if (options.baseUrl) {
    assertValidUrl(options.baseUrl)
    next.baseUrl = options.baseUrl
  }
  if (options.apiKey) {
    next.keyRef = options.providerName
    ;(next as unknown as { apiKey?: string | null }).apiKey = null
    ;(next as unknown as { apiKeyEnv?: string | null }).apiKeyEnv = null
  }
  if (options.apiKeyEnv) {
    next.apiKeyEnv = options.apiKeyEnv
    ;(next as unknown as { apiKey?: string | null }).apiKey = null
    ;(next as unknown as { keyRef?: string | null }).keyRef = null
  }
  if (options.model) {
    const model = clampModelTokens(options.model)
    const existingIndex = next.models.findIndex(item => item.id === model.id || (model.alias !== undefined && item.alias === model.alias))
    const existing = existingIndex >= 0 ? next.models[existingIndex] : undefined
    // Merge, never replace — see mergeModelUpdate. This is the path the desktop
    // Settings form takes, and it only ever sends four fields.
    if (existing) next.models[existingIndex] = mergeModelUpdate(existing, model)
    else next.models.unshift(model)
  }
  if (options.models) {
    for (const raw of options.models) {
      const model = clampModelTokens(modelConfigSchema.parse(raw))
      const existingIndex = next.models.findIndex(item => item.id === model.id || (model.alias !== undefined && item.alias === model.alias))
      const existing = existingIndex >= 0 ? next.models[existingIndex] : undefined
      if (existing) next.models[existingIndex] = mergeModelUpdate(existing, model)
      else next.models.push(model)
    }
  }
  cfg.provider.providers[options.providerName] = next
  next.userSaved = true
  if (options.makeDefault) cfg.provider.default = options.providerName
  if (options.allowProFallback !== undefined) {
    next.allowProFallback = options.allowProFallback
  }
  applyAdvancedConfig(next, options.advanced)
  saveProviderConfigWithSecret(cfg, previousConfig, options.apiKey ? options.providerName : undefined, options.apiKey)
}

export interface RegisterProviderOptions {
  providerName: string
  baseUrl: string
  /** API key — optional for local deployments (Ollama/vLLM) that need no auth. */
  apiKey?: string
  /** Env var name holding the API key. */
  apiKeyEnv?: string
  /** Wire protocol of the endpoint. Default 'openai'. */
  protocol?: 'openai' | 'anthropic'
  /** Capability overrides; omitted fields fall through to catalog defaults. */
  capabilities?: ProviderCapabilitiesConfig
  /** Model list — may be empty (probe-filled later) or multi-model. Each entry
   *  is normalized through modelConfigSchema (contextWindow inference +
   *  maxTokens clamping), so partial backfills from the matcher are safe. */
  models?: Array<Partial<ModelConfig> & { id: string }>
  makeDefault?: boolean
  allowProFallback?: boolean
  /** Advanced knobs (timeout/retry/temperature/proxy) — undefined = untouched. */
  advanced?: ProviderAdvancedConfig
  /** Overwrite an existing entry. Without this flag a same-name write throws —
   *  silent overwrites used to lose baseUrl/key/models. */
  force?: boolean
  /** Explicitly mark a slow-thinking endpoint; undefined keeps name/baseUrl heuristics. */
  slowThinking?: boolean
}

/**
 * Unified provider write core — the single function that materializes a
 * ProviderConfig from scratch. Consumed by the CLI (`rivet provider add`),
 * the desktop HTTP routes, and the in-TUI /connect wizard. Unlike
 * `setupProvider`, this does not require an existing entry or a built-in
 * preset; capabilities left undeclared fall through to DEFAULT_CAPABILITIES
 * in `resolveCapabilities`.
 */
export function registerProvider(options: RegisterProviderOptions): void {
  if (options.apiKey && options.apiKeyEnv) {
    throw new Error('Provider credentials must use either apiKey or apiKeyEnv, not both.')
  }
  // 自定义 provider 拒绝内置预设名：撞名条目在列表里显示预设 label、删除时曾
  // 被预设名拦截（历史死锁）。想覆盖预设行为请走 setupProvider
  // （POST /config/providers，克隆预设后覆盖字段）。
  if (isProviderPresetKey(options.providerName)) {
    throw new Error(
      `Cannot create custom provider "${options.providerName}": it is a built-in preset name. ` +
      `Use a different name, or configure the preset via "rivet config setup".`,
    )
  }
  assertValidUrl(options.baseUrl)
  const existing = loadConfig().provider.providers[options.providerName]
  if (existing && !options.force) {
    throw new Error(
      `Provider "${options.providerName}" already exists. ` +
      `Use "rivet config set-url ${options.providerName} <url>" or ` +
      `"rivet config setup ${options.providerName}" to edit it, or delete it first ` +
      `(pass --force to overwrite).`,
    )
  }
  const models = (options.models ?? []).map(raw => modelConfigSchema.parse(raw))
  const provider: ProviderConfig = {
    name: options.providerName,
    ...(options.apiKey ? { keyRef: options.providerName } : {}),
    ...(options.apiKeyEnv ? { apiKeyEnv: options.apiKeyEnv } : {}),
    baseUrl: options.baseUrl,
    protocol: options.protocol ?? 'openai',
    capabilities: options.capabilities ?? {},
    thinking: 'enabled',
    maxTokens: models.reduce((max, m) => Math.max(max, m.maxTokens), 64_000),
    allowProFallback: options.allowProFallback ?? false,
    ...(options.slowThinking !== undefined ? { slowThinking: options.slowThinking } : {}),
    models,
    unsupported: [],
    userSaved: true,
  }
  applyAdvancedConfig(provider, options.advanced)
  const cfg = loadConfig()
  const previousConfig = structuredClone(cfg)
  cfg.provider.providers[options.providerName] = provider
  if (options.makeDefault) cfg.provider.default = options.providerName
  saveProviderConfigWithSecret(cfg, previousConfig, options.apiKey ? options.providerName : undefined, options.apiKey)
}

/**
 * 字段级更新已存在 provider 的 tunable 参数。白名单外字段、非法值一律拒收
 * （抛错不落盘）。校验、嵌套合并与白名单本体见 provider-tunables.ts（结构
 * 棘轮拆分：本文件零余量，逻辑主体在子模块，此处只留装配）。
 */
export function updateProviderTunables(providerName: string, fields: Record<string, unknown>): ProviderConfig {
  const cfg = loadConfig()
  const provider = cfg.provider.providers[providerName]
  if (!provider) throw new Error(`Provider "${providerName}" not found`)

  applyProviderTunables(provider, fields)
  saveConfig(cfg)
  return provider
}

// --- Model management ---

export function addModel(providerName: string, model: ModelConfig): void {
  const cfg = loadConfig()
  const provider = cfg.provider.providers[providerName]
  if (!provider) throw new Error(`Provider "${providerName}" not found`)
  provider.models.push(model)
  provider.userSaved = true
  saveConfig(cfg)
}

export function removeModel(providerName: string, modelId: string): void {
  const cfg = loadConfig()
  const provider = cfg.provider.providers[providerName]
  if (!provider) throw new Error(`Provider "${providerName}" not found`)

  // 先检查 modelId 是否存在——不存在时应尽早报错，不要被下游的"最后一个模型"
  // 检查拦截，否则报错文案会误导用户。
  if (!provider.models.some(m => m.id === modelId)) {
    throw new Error(`Model "${modelId}" not found in provider "${providerName}"`)
  }

  // 禁止移除最后一个模型——预设 provider 删除后会从 DEFAULT_CONFIG 恢复全部预设模型，
  // 导致用户之前手动移除的模型全部回来；自定义 provider 删除后则彻底消失。
  // 用户应通过「移除 Provider」按钮删除整个 provider。
  if (provider.models.length <= 1) {
    throw new Error(
      `Cannot remove the last model from "${providerName}". ` +
      `Remove the provider instead, or add another model first.`,
    )
  }

  provider.models = provider.models.filter(m => m.id !== modelId)
  // 删除是编辑行为——打 userSaved 标记，让 migratePresetModelBackfill 尊重
  // 删减（否则下次 loadConfig 会把删除的预设模型回流，删除被静默撤销）。
  provider.userSaved = true
  saveConfig(cfg)
}

export function listModels(providerName: string): ModelConfig[] {
  const provider = getProvider(providerName)
  if (!provider) throw new Error(`Provider "${providerName}" not found`)
  return provider.models
}

// --- CLI entry point ---

export interface ConfigCliIO {
  isTTY?: boolean
  stdout?: (line: string) => void
  stderr?: (line: string) => void
  exit?: (code: number) => void
}

function cliOut(io: ConfigCliIO, line: string): void {
  ;(io.stdout ?? console.log)(line)
}

function cliErr(io: ConfigCliIO, line: string): void {
  ;(io.stderr ?? console.error)(line)
}

function cliExit(io: ConfigCliIO, code: number): void {
  ;(io.exit ?? process.exit)(code)
}

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name)
}

function parsePositiveInt(value: string | undefined, label: string): number {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`)
  return parsed
}

function printConfigHelp(io: ConfigCliIO): void {
  cliOut(io, `Rivet Config Manager

Usage: rivet config <command>

Interactive provider setup: start rivet and use /connect.

Commands:
  show                         Show full config (JSON)
  providers                    List providers with key status
  setup <provider>             Create/update provider from built-in preset
  login <provider>             OAuth login for subscription providers (codex) — opens browser
  set-url <provider> <url>     Set provider base URL
  set-model <provider> <id>    Set preferred model for provider
  set-key <p> <key>            Set API key for provider
  set-key-env <p> <v>          Set API key from env variable
  set-default <p>              Set default provider
  set-default-model <p>:<m>    Set default model for new sessions (agent.defaultModel)
  set-approval <mode> [--unsandboxed|--sandboxed]  Set approval mode (auto-safe/manual/auto-accept/dangerously-skip-permissions); yolo = 完全权限（免审批+全盘无沙箱），--unsandboxed 显式声明、--sandboxed 清除该标记；沙箱兜底用 RIVET_SANDBOX=1
  list-hooks                   Show CVM hook assembly config (config/env/effective disabled)
  set-hook-disabled <id> [--enable]  Disable (or re-enable with --enable) a CVM runtime hook
  set-proxy <url> [--clear]    Set/clear web proxy (web_search/web_fetch)
  set-no-proxy <list> [--clear]  Set/clear NO_PROXY bypass list
  set-search-backends <b1,b2>  Set web_search backend chain (e.g. bocha,bing,duckduckgo)
  set-jina-url <url>           Set Jina Reader base URL (国内自建反代)
  set-vision <p>/<m> [maxTokens N] [--prompt "..."]  Set vision bridge model
  clear-vision                 Clear the vision bridge model
  set-vision-auto-bridge <on|off>  Toggle auto vision bridge selection
  add-model <p> <id> [ctx] [max] [--vision]  Add model to provider (--vision marks it vision-capable)
  set-model-vision <p> <m> <on|off>  Toggle vision support on a stored model
  remove-model <p> <id>        Remove model from provider
  remove-provider <name>       Remove a provider (default provider cannot be removed)
  mcp                          MCP server management

Examples:
  rivet config providers
  rivet config setup deepseek --key-env DEEPSEEK_API_KEY --default
  rivet config setup codex --default
  rivet config set-approval dangerously-skip-permissions
  rivet config set-proxy http://127.0.0.1:7890
  rivet config set-search-backends bocha,bing,duckduckgo
  rivet config set-jina-url https://r.jina.ai
  rivet config set-vision zhipu-vision/glm-4v-flash
  rivet config set-vision glm/glm-5.2 2048 --prompt "用中文描述截图"
  rivet config set-vision-auto-bridge on
  rivet config set-default-model glm:glm-5.2
  rivet config add-model deepseek my-vision-model 128000 32000 --vision
  rivet config set-model-vision deepseek deepseek-v4-pro on
  rivet config set-url mimo https://token-plan-sgp.xiaomimimo.com/v1
  rivet config set-model minimax MiniMax-M2.8 300000 64000 m28
  rivet config mcp add-stdio fs npx -y @modelcontextprotocol/server-filesystem /tmp`)
}

/** Mask every credential in a config snapshot for display (`config show`).
 *  provider.apiKey may be a secrets-store value materialized by loadConfig. */
function maskKey(value: string | undefined): string | undefined {
  if (!value) return value
  return '***' + value.slice(-4)
}

export function maskConfigSecrets(config: Config): Config {
  const masked = structuredClone(config)
  for (const provider of Object.values(masked.provider.providers)) {
    provider.apiKey = maskKey(provider.apiKey)
  }
  const search = masked.search
  if (search) {
    search.bochaApiKey = maskKey(search.bochaApiKey)
    search.braveApiKey = maskKey(search.braveApiKey)
    search.tavilyApiKey = maskKey(search.tavilyApiKey)
  }
  return masked
}

export async function runConfigCLI(args: string[], io: ConfigCliIO = {}): Promise<void> {
  const cmd = args[0]
  const useColor = io.isTTY ?? (process.stdout.isTTY ?? false)
  const fmtOpts: FormatOpts = { useColor, width: 80 }
  try {
    if (!cmd) {
      printConfigHelp(io)
      return
    }

    switch (cmd) {
      case 'show':
        cliOut(io, JSON.stringify(maskConfigSecrets(loadConfig()), null, 2))
        break

      case 'providers': {
        const cfg = loadConfig()
        const providerMap = cfg.provider.providers
        const defaultName = cfg.provider.default
        const entries = Object.entries(providerMap)
        if (entries.length === 0) {
          cliOut(io, 'No providers configured.')
        } else {
          for (const [name, p] of entries) {
            const keyStatus = getApiKeyStatus(name)
            cliOut(io, formatProviderCard(name, p, keyStatus, name === defaultName, fmtOpts))
          }
        }
        break
      }

      case 'setup': {
        const providerName = args[1]
        if (!providerName) {
          cliErr(io, 'Usage: rivet config setup <provider> [--key KEY|--key-env ENV] [--url URL] [--model ID --context-window N --max-tokens N] [--alias NAME] [--default]')
          cliExit(io, 1)
          return
        }
        const modelId = readFlag(args, '--model')
        const alias = readFlag(args, '--alias')
        // Preset-aware defaults: known models inherit their real context
        // window (e.g. deepseek-v4-pro = 1M). A silent 128K default on a
        // 1M model causes premature compaction tiers for the whole session.
        const presetModel = modelId ? findPresetModel(providerName, modelId) : undefined
        const cwFlag = readFlag(args, '--context-window')
        const mtFlag = readFlag(args, '--max-tokens')
        const model: ModelConfig | undefined = modelId
          ? {
              id: modelId,
              ...(alias ? { alias } : {}),
              contextWindow: cwFlag
                ? parsePositiveInt(cwFlag, 'context-window')
                : presetModel?.contextWindow ?? 128000,
              maxTokens: mtFlag
                ? parsePositiveInt(mtFlag, 'max-tokens')
                : presetModel?.maxTokens ?? 64000,
              ...(presetModel?.reasoningEffort ? { reasoningEffort: presetModel.reasoningEffort } : {}),
            }
          : undefined
        if (modelId && !cwFlag && !presetModel) {
          cliOut(io, `Warning: unknown model "${modelId}" — defaulting context window to 128000. Pass --context-window with the real value (compaction thresholds depend on it).`)
        }
        setupProvider({
          providerName,
          apiKey: readFlag(args, '--key'),
          apiKeyEnv: readFlag(args, '--key-env'),
          baseUrl: readFlag(args, '--url'),
          model,
          makeDefault: hasFlag(args, '--default'),
        })
        cliOut(io, formatSuccess(`Provider ${providerName} configured${hasFlag(args, '--default') ? ' and set as default' : ''}`, fmtOpts))
        break
      }

      case 'login': {
        // OAuth 登录（codex 等订阅型）：PKCE + 本机回环回调，token 落盘自动续期。
        // 动态 import 破 manager ↔ login-flow 静态环（login-flow 依赖本模块 loadConfig）。
        const providerName = args[1] ?? 'codex'
        const { runOAuthLogin, openInBrowser } = await import('../auth/login-flow.js')
        cliOut(io, `正在为 ${providerName} 发起 OAuth 登录——浏览器将打开授权页…`)
        const res = await runOAuthLogin(providerName, (url) => {
          openInBrowser(url)
          cliOut(io, `若浏览器未自动打开，请手动访问：\n${url}`)
        })
        if (res.ok) cliOut(io, formatSuccess(res.message, fmtOpts))
        else { cliErr(io, res.message); cliExit(io, 1) }
        break
      }

      case 'set-url': {
        const providerName = args[1]
        const baseUrl = args[2]
        if (!providerName || !baseUrl) {
          cliErr(io, 'Usage: rivet config set-url <provider> <base-url>')
          cliExit(io, 1)
          return
        }
        updateProviderBaseUrl(providerName, baseUrl)
        cliOut(io, formatSuccess(`Base URL set for ${providerName}: ${baseUrl}`, fmtOpts))
        break
      }

      case 'set-model': {
        const providerName = args[1]
        const modelId = args[2]
        if (!providerName || !modelId) {
          cliErr(io, 'Usage: rivet config set-model <provider> <model-id> [context-window] [max-tokens] [alias]')
          cliExit(io, 1)
          return
        }
        const alias = args[5]
        const presetModel = findPresetModel(providerName, modelId)
        const model: ModelConfig = {
          id: modelId,
          ...(alias ? { alias } : {}),
          contextWindow: args[3]
            ? parsePositiveInt(args[3], 'context-window')
            : presetModel?.contextWindow ?? 128000,
          maxTokens: args[4]
            ? parsePositiveInt(args[4], 'max-tokens')
            : presetModel?.maxTokens ?? 64000,
          ...(presetModel?.reasoningEffort ? { reasoningEffort: presetModel.reasoningEffort } : {}),
        }
        if (!args[3] && !presetModel) {
          cliOut(io, `Warning: unknown model "${modelId}" — defaulting context window to 128000. Pass an explicit context-window (compaction thresholds depend on it).`)
        }
        upsertProviderModel(providerName, model, { preferred: true })
        cliOut(io, formatSuccess(`Preferred model for ${providerName} set to ${modelId}`, fmtOpts))
        break
      }

      case 'set-key': {
        const providerName = args[1]
        const key = args[2]
        if (!providerName || !key) {
          cliErr(io, 'Usage: rivet config set-key <provider> <api-key>')
          cliExit(io, 1)
          return
        }
        setApiKey(providerName, key)
        cliOut(io, formatSuccess(`API key set for ${providerName}`, fmtOpts))
        break
      }

      case 'set-key-env': {
        const providerName = args[1]
        const envVar = args[2]
        if (!providerName || !envVar) {
          cliErr(io, 'Usage: rivet config set-key-env <provider> <ENV_VAR>')
          cliExit(io, 1)
          return
        }
        setApiKeyEnv(providerName, envVar)
        cliOut(io, formatSuccess(`API key source set to ${envVar} for ${providerName}`, fmtOpts))
        break
      }

      case 'set-default': {
        const providerName = args[1]
        if (!providerName) {
          cliErr(io, 'Usage: rivet config set-default <provider>')
          cliExit(io, 1)
          return
        }
        setDefaultProvider(providerName)
        cliOut(io, formatSuccess(`Default provider set to ${providerName}`, fmtOpts))
        break
      }

      case 'set-approval': {
        const mode = args[1]
        if (!mode) {
          cliErr(io, `Usage: rivet config set-approval <${APPROVAL_MODES.join('|')}> [--unsandboxed|--sandboxed]`)
          cliExit(io, 1)
          return
        }
        if (!(APPROVAL_MODES as readonly string[]).includes(mode)) {
          cliErr(io, `Invalid approval mode "${mode}". Available: ${APPROVAL_MODES.join(', ')}`)
          cliExit(io, 1)
          return
        }
        // --unsandboxed = 显式声明完全权限（yolo 自 2026-09-07 起默认即此档；
        // flag 保留用于显式表达与桌面端兼容）。--sandboxed = 关闭 unsandboxed
        // 标记（P1-1：此前 --sandboxed 被移除导致 unsandboxed 无法设回 false 的死巷；
        // 沙箱兜底仍需 RIVET_SANDBOX=1 显式开启）。
        const unsandboxed = hasFlag(args, '--unsandboxed') ? true : hasFlag(args, '--sandboxed') ? false : undefined
        if (hasFlag(args, '--sandboxed')) {
          cliOut(io, '提示：--sandboxed 已清除 unsandboxed 标记（= 关闭完全权限豁免）；沙箱兜底仍需显式设置环境变量 RIVET_SANDBOX=1。')
        }
        const saved = setApprovalConfig({ approval: mode, unsandboxed })
        const note = saved.unsandboxed
          ? '（完全权限：写沙箱已关，下次会话生效）'
          : ''
        cliOut(io, formatSuccess(`Approval mode set to ${saved.approval}${saved.unsandboxed ? ' (unsandboxed)' : ''} ${note}`, fmtOpts))
        break
      }

      // ── P2 hook 装配配置面 ──────────────────────────────────────────────
      // list-hooks 只输出配置解析结果（CLI 前置命令无 AgentLoop 管线实例，
      // 不声称运行时 manifest）；set-hook-disabled 写用户 config，TUI 交互
      // 会话中经 config-watcher 即时热更（下一轮生效）。

      case 'list-hooks': {
        const { disabled, envDisabled, effectiveDisabled } = listHooksConfig()
        cliOut(io, `hooks.disabled (config): ${JSON.stringify(disabled ?? [])}`)
        if (envDisabled) {
          cliOut(io, `RIVET_HOOKS_DISABLED (env): ${JSON.stringify(envDisabled)}（优先于 config）`)
        }
        cliOut(io, `effective disabled: ${JSON.stringify(effectiveDisabled)}`)
        cliOut(io, '生效时机：TUI 交互会话中改配置即时热更（下一轮）；timeoutMs/slowMs 重启生效。')
        break
      }

      case 'set-hook-disabled': {
        const hookId = args[1]
        if (!hookId) {
          cliErr(io, 'Usage: rivet config set-hook-disabled <id> [--enable]')
          cliExit(io, 1)
          return
        }
        const enable = hasFlag(args, '--enable')
        const { disabled } = setHookDisabled(hookId, enable)
        cliOut(io, formatSuccess(
          `hooks.disabled ${enable ? '移除' : '加入'} ${hookId} → ${JSON.stringify(disabled)}（交互会话即时热更）`,
          fmtOpts,
        ))
        break
      }

      // ── web 工具配置（network / search / fetch）─────────────────────────
      // 让纯 CLI（无 TTY）用户一行命令改 web 配置，不用手编 config.json。
      // setter 都是 merge 写模式，只更新传入字段。下次会话生效（前缀缓存安全）。

      case 'set-proxy': {
        // --clear 清除 proxy（回落到 env 变量 / 系统代理 / 直连）
        if (hasFlag(args, '--clear')) {
          setNetworkConfig({ proxy: '' })
          cliOut(io, formatSuccess('Proxy cleared (falls back to env/system)', fmtOpts))
          break
        }
        const url = args[1]
        if (!url) {
          cliErr(io, 'Usage: rivet config set-proxy <http://host:port> [--clear]')
          cliExit(io, 1)
          return
        }
        setNetworkConfig({ proxy: url })
        cliOut(io, formatSuccess(`Proxy set to ${url}`, fmtOpts))
        break
      }

      case 'set-no-proxy': {
        if (hasFlag(args, '--clear')) {
          setNetworkConfig({ noProxy: '' })
          cliOut(io, formatSuccess('NO_PROXY cleared', fmtOpts))
          break
        }
        const list = args[1]
        if (!list) {
          cliErr(io, 'Usage: rivet config set-no-proxy <host,.domain,...> [--clear]')
          cliExit(io, 1)
          return
        }
        setNetworkConfig({ noProxy: list })
        cliOut(io, formatSuccess(`NO_PROXY set to ${list}`, fmtOpts))
        break
      }

      case 'set-search-backends': {
        const raw = args[1]
        if (!raw) {
          cliErr(io, 'Usage: rivet config set-search-backends <b1,b2,...> (e.g. bocha,bing,duckduckgo)')
          cliExit(io, 1)
          return
        }
        // 逗号分隔 → 数组；空串/空白过滤
        const backends = raw.split(',').map(s => s.trim()).filter(Boolean)
        if (backends.length === 0) {
          cliErr(io, '至少需要一个后端（逗号分隔，如 bocha,bing,duckduckgo）')
          cliExit(io, 1)
          return
        }
        setSearchConfig({ backends })
        cliOut(io, formatSuccess(`Search backends set to [${backends.join(', ')}]`, fmtOpts))
        break
      }

      case 'set-jina-url': {
        const url = args[1]
        if (!url) {
          cliErr(io, 'Usage: rivet config set-jina-url <https://your-mirror.example>')
          cliExit(io, 1)
          return
        }
        setFetchConfig({ jinaBaseUrl: url })
        cliOut(io, formatSuccess(`Jina Reader base URL set to ${url}`, fmtOpts))
        break
      }

      // ── 视觉模型（vision bridge）配置 ──────────────────────────────────
      // CLI 用户此前只能手编 config.json，没有校验引导，容易踩「配了 provider 名但
      // provider 没 setup」的坑（运行时静默丢图）。这些子命令复用 setVisionModelConfig
      // 的 provider/model 存在性校验，配错会立即报错。

      case 'set-vision': {
        // 格式：<provider>/<model> [maxTokens N] [--prompt "..."]
        // 先剥离 --flag value，再从剩余位置参数取 provider/model 和可选 maxTokens
        const rest: string[] = []
        let prompt: string | undefined
        for (let i = 1; i < args.length; i++) {
          if (args[i] === '--prompt') {
            prompt = args[++i]
          } else {
            rest.push(args[i]!)
          }
        }
        if (rest.length === 0) {
          cliErr(io, 'Usage: rivet config set-vision <provider>/<model> [maxTokens N] [--prompt "..."]')
          cliExit(io, 1)
          return
        }
        // 最后一个纯数字位置参数视为 maxTokens；其余拼成 provider/model ref
        let maxTokens: number | undefined
        const last = rest[rest.length - 1]!
        if (/^\d+$/.test(last) && rest.length >= 2) {
          maxTokens = parsePositiveInt(last, 'maxTokens')
          rest.pop()
        }
        const ref = rest.join(' ').trim()
        const slashIdx = ref.indexOf('/')
        if (slashIdx < 0) {
          cliErr(io, '格式：<provider>/<model>，如 glm/glm-5.2 或 zhipu-vision/glm-4v-flash')
          cliExit(io, 1)
          return
        }
        const providerName = ref.slice(0, slashIdx)
        const modelId = ref.slice(slashIdx + 1)
        try {
          const saved = setVisionModelConfig({
            provider: providerName, model: modelId,
            ...(prompt !== undefined ? { prompt } : {}),
            ...(maxTokens !== undefined ? { maxTokens } : {}),
          })
          cliOut(io, formatSuccess(`Vision model set to ${saved!.provider}/${saved!.model}`, fmtOpts))
        } catch (err) {
          cliErr(io, (err as Error).message)
          cliExit(io, 1)
          return
        }
        break
      }

      case 'clear-vision': {
        setVisionModelConfig(null)
        cliOut(io, formatSuccess('Vision model cleared', fmtOpts))
        break
      }

      case 'set-vision-auto-bridge': {
        const flag = args[1]?.toLowerCase()
        if (flag !== 'on' && flag !== 'off' && flag !== 'true' && flag !== 'false') {
          cliErr(io, 'Usage: rivet config set-vision-auto-bridge <on|off>')
          cliExit(io, 1)
          return
        }
        const enabled = flag === 'on' || flag === 'true'
        setVisionAutoBridge(enabled)
        cliOut(io, formatSuccess(`Vision auto-bridge ${enabled ? 'enabled' : 'disabled'}`, fmtOpts))
        break
      }

      case 'add-model': {
        const providerName = args[1]
        const modelId = args[2]
        const contextWindow = parseInt(args[3] ?? '1000000')
        const maxTokens = parseInt(args[4] ?? '64000')
        if (!providerName || !modelId) {
          cliErr(io, 'Usage: rivet config add-model <provider> <model-id> [context-window] [max-tokens] [--vision]')
          cliExit(io, 1)
          return
        }
        addModel(providerName, {
          id: modelId,
          contextWindow,
          maxTokens,
          ...(hasFlag(args, '--vision') ? { supportsVision: true } : {}),
        })
        cliOut(io, formatSuccess(`Model ${modelId} added to ${providerName}`, fmtOpts))
        break
      }

      case 'set-default-model': {
        const value = args[1]
        if (!value) {
          cliErr(io, 'Usage: rivet config set-default-model <provider:modelId>')
          cliExit(io, 1)
          return
        }
        const saved = setDefaultModelConfig({ defaultModel: value })
        cliOut(io, formatSuccess(`Default model set to ${saved.defaultModel}`, fmtOpts))
        break
      }

      case 'set-model-vision': {
        const providerName = args[1]
        const modelId = args[2]
        const flag = args[3]
        if (!providerName || !modelId || (flag !== 'on' && flag !== 'off')) {
          cliErr(io, 'Usage: rivet config set-model-vision <provider> <model-id> <on|off>')
          cliExit(io, 1)
          return
        }
        setModelSupportsVision(providerName, modelId, flag === 'on')
        cliOut(io, formatSuccess(`Vision ${flag === 'on' ? 'enabled' : 'disabled'} for ${modelId} (${providerName})`, fmtOpts))
        break
      }

      case 'remove-model': {
        const providerName = args[1]
        const modelId = args[2]
        if (!providerName || !modelId) {
          cliErr(io, 'Usage: rivet config remove-model <provider> <model-id>')
          cliExit(io, 1)
          return
        }
        removeModel(providerName, modelId)
        cliOut(io, formatSuccess(`Model ${modelId} removed from ${providerName}`, fmtOpts))
        break
      }

      case 'remove-provider': {
        const providerName = args[1]
        if (!providerName) {
          cliErr(io, 'Usage: rivet config remove-provider <name>')
          cliExit(io, 1)
          return
        }
        removeProvider(providerName)
        cliOut(io, formatSuccess(`Provider ${providerName} removed`, fmtOpts))
        break
      }

      case 'mcp': {
        const subcmd = args[1]
        if (subcmd === 'list') {
          const cfg = loadConfig()
          const servers = cfg.mcp?.servers ?? {}
          cliOut(io, formatMcpServerList(servers, fmtOpts))
        } else if (subcmd === 'add-stdio') {
          const id = args[2]
          const command = args[3]
          const cmdArgs = args.slice(4)
          if (!id || !command) {
            cliErr(io, 'Usage: rivet config mcp add-stdio <id> <command> [args...]')
            cliExit(io, 1)
            return
          }
          const cfg = loadConfig()
          cfg.mcp.servers[id] = { command, args: cmdArgs.length > 0 ? cmdArgs : undefined }
          saveConfig(cfg)
          cliOut(io, formatSuccess(`MCP server "${id}" added (stdio: ${command} ${cmdArgs.join(' ')}). Restart Rivet to connect.`, fmtOpts))
        } else if (subcmd === 'add-sse') {
          const id = args[2]
          const url = args[3]
          if (!id || !url) {
            cliErr(io, 'Usage: rivet config mcp add-sse <id> <url>')
            cliExit(io, 1)
            return
          }
          const cfg = loadConfig()
          cfg.mcp.servers[id] = { url, transportHint: 'sse' }
          saveConfig(cfg)
          cliOut(io, formatSuccess(`MCP server "${id}" added (sse: ${url}). Restart Rivet to connect.`, fmtOpts))
        } else if (subcmd === 'remove') {
          const id = args[2]
          if (!id) {
            cliErr(io, 'Usage: rivet config mcp remove <id>')
            cliExit(io, 1)
            return
          }
          const cfg = loadConfig()
          if (!cfg.mcp?.servers[id]) {
            cliErr(io, `MCP server "${id}" not found.`)
            cliExit(io, 1)
            return
          }
          delete cfg.mcp.servers[id]
          saveConfig(cfg)
          cliOut(io, formatSuccess(`MCP server "${id}" removed. Restart Rivet to apply.`, fmtOpts))
        } else if (subcmd === 'enable' || subcmd === 'disable') {
          const id = args[2]
          if (!id) {
            cliErr(io, `Usage: rivet config mcp ${subcmd} <id>`)
            cliExit(io, 1)
            return
          }
          const cfg = loadConfig()
          const server = cfg.mcp?.servers[id]
          if (!server) {
            cliErr(io, `MCP server "${id}" not found.`)
            cliExit(io, 1)
            return
          }
          server.disabled = subcmd === 'disable' ? true : undefined
          saveConfig(cfg)
          cliOut(io, formatSuccess(`MCP server "${id}" ${subcmd}d. Restart Rivet to apply.`, fmtOpts))
        } else {
          cliOut(io, `MCP server management:

Usage: rivet config mcp <command>

Commands:
  list                        List configured MCP servers
  add-stdio <id> <cmd> [args...]  Add a stdio MCP server
  add-sse <id> <url>          Add an SSE MCP server
  remove <id>                 Remove an MCP server
  enable <id>                 Enable an MCP server
  disable <id>                Disable an MCP server (keeps config)

Examples:
  rivet config mcp add-stdio fs npx -y @modelcontextprotocol/server-filesystem /tmp
  rivet config mcp add-sse ctx7 http://localhost:3001/sse
  rivet config mcp list
  rivet config mcp remove fs`)
        }
        break
      }

      case 'allow-dir': {
        const rawPath = args[1]
        if (!rawPath) {
          cliErr(io, 'Usage: rivet config allow-dir <path> [--read|--write] [--all-projects]')
          cliExit(io, 1)
          return
        }
        const mode = args.includes('--write') ? 'write' : 'read'
        const allProjects = args.includes('--all-projects')
        if (allProjects) {
          const key = mode === 'write' ? 'additionalWriteDirs' as const : 'additionalReadDirs' as const
          const prev = getPermissionDirs()
          const dirs = [...prev[key], rawPath]
          setPermissionDirs({ ...prev, [key]: dirs })
          cliOut(io, formatSuccess(`Added "${rawPath}" to ${key} (global). Restart Rivet to apply.`, fmtOpts))
        } else {
          const { grantPath } = await import('../tools/path-grants.js')
          grantPath(rawPath, mode, { persist: true, cwd: process.cwd() })
          cliOut(io, formatSuccess(`Granted ${mode} access to "${rawPath}" for this workspace.`, fmtOpts))
        }
        break
      }

      case 'revoke-dir': {
        const rawPath = args[1]
        if (!rawPath) {
          cliErr(io, 'Usage: rivet config revoke-dir <path>')
          cliExit(io, 1)
          return
        }
        const { revokeGrant } = await import('../tools/path-grants.js')
        const removed = revokeGrant(rawPath, { cwd: process.cwd() })
        cliOut(io, formatSuccess(removed ? `Revoked access to "${rawPath}".` : `No grant found for "${rawPath}".`, fmtOpts))
        break
      }

      case 'list-dirs': {
        const { listPersistedGrants } = await import('../tools/path-grants.js')
        const grants = listPersistedGrants(process.cwd())
        if (grants.length === 0) {
          cliOut(io, 'No per-workspace directory grants.')
        } else {
          cliOut(io, 'Per-workspace grants:')
          for (const g of grants) {
            cliOut(io, `  ${g.mode === 'write' ? '✎' : '👁'} ${g.root}`)
          }
        }
        break
      }

      default:
        printConfigHelp(io)
    }
  } catch (err) {
    cliErr(io, formatError(`Error: ${(err as Error).message}`, fmtOpts))
    cliExit(io, 1)
  }
}

/**
 * Disk I/O boundary for the /connect wizard draft.
 *
 * Fail-open on purpose (unlike config.json's fail-closed load): a corrupt or
 * stale draft must never block the wizard — it simply behaves as "no draft".
 * The draft NEVER holds a plaintext key: it carries a keyRef into the 0600
 * secrets.json store (see src/config/secrets-store.ts); a 30-day TTL limits
 * how long any progress lingers on disk.
 */

import { readFileSync, unlinkSync } from 'node:fs'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { connectDraftPath } from '../config/paths.js'
import type { ProviderAdvancedConfig, ProviderProtocol } from '../config/schema.js'

/** Phases a draft can legitimately resume from (busy/terminal phases excluded). */
export const CONNECT_DRAFT_PHASES = [
  'provider',
  'pick-existing',
  'preset-billing',
  'preset-apikey',
  'preset-endpoint',
  'preset-probing',
  'probe-report',
  'preset-models',
  'capability',
  'ask-default',
  'confirm',
  'diy-protocol',
  'diy-url',
  'diy-apikey',
  'diy-probing',
  'diy-probe-failed',
  'diy-models',
  'diy-model',
  'diy-context',
  'diy-vision',
  'diy-thinking',
  'diy-name',
] as const

/** Checkbox state for probed models — matcher results are recomputed on resume. */
export interface ConnectDraftSelection {
  rawId: string
  checked: boolean
}

/** Snapshot of ConnectFlow's collected state (serializable subset). */
export interface ConnectDraftCollected {
  presetKey?: string
  /** Billing plan id (presets with billingModes, e.g. 百炼 按量计费 / token plan). */
  billingMode?: string
  baseUrl?: string
  /** Wire protocol chosen on the DIY path (custom providers; defaults to openai). */
  protocol?: ProviderProtocol
  /** Secrets-store pointer (never the key itself). Restored via readSecret. */
  keyRef?: string
  modelId?: string
  /** Provider name chosen at the naming step (DIY path, carried into confirm). */
  providerName?: string
  /** User submitted the credential step, including an intentional empty key for local endpoints. */
  authConfirmed?: boolean
  /** Default-provider answer captured at the ask-default step. */
  makeDefault?: boolean
  contextWindow?: number
  supportsVision?: boolean
  existingProvider?: string
  reasoningSplitHint?: boolean
  thinkingSplit?: boolean
  advanced?: ProviderAdvancedConfig
  probedSelection?: ConnectDraftSelection[]
}

export interface ConnectDraft {
  version: 1
  savedAt: number
  phase: string
  collected: ConnectDraftCollected
  /** Text typed in the current input step but not yet submitted. */
  pendingInput?: string
}

const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000

function draftPath(base?: string): string {
  return connectDraftPath(base)
}

function removeQuiet(path: string): void {
  try { unlinkSync(path) } catch { /* already gone */ }
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/** Serialize and persist. Best-effort: write failures are swallowed. */
export function saveConnectDraft(draft: ConnectDraft, base?: string): void {
  try {
    writeFileAtomicSync(draftPath(base), JSON.stringify(draft, null, 2))
  } catch { /* draft is non-critical */ }
}

/**
 * Load a usable draft, or undefined. Invalid/expired files are deleted so they
 * stop nagging on every launch. Hand-rolled guards instead of zod: fail-open
 * semantics make parse-then-catch noisier than explicit checks.
 */
export function readConnectDraft(base?: string): ConnectDraft | undefined {
  const path = draftPath(base)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  const invalid = (): undefined => {
    removeQuiet(path)
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return invalid()
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return invalid()
  const draft = parsed as Record<string, unknown>
  if (draft.version !== 1) return invalid()
  if (!isString(draft.phase) || !(CONNECT_DRAFT_PHASES as readonly string[]).includes(draft.phase)) return invalid()
  if (typeof draft.savedAt !== 'number' || !Number.isFinite(draft.savedAt)) return invalid()
  if (Date.now() - draft.savedAt > DRAFT_TTL_MS) return invalid()
  if (draft.collected === null || typeof draft.collected !== 'object' || Array.isArray(draft.collected)) return invalid()
  const collected = draft.collected as Record<string, unknown>
  const clean: ConnectDraftCollected = {}
  if (isString(collected.presetKey)) clean.presetKey = collected.presetKey
  if (isString(collected.billingMode)) clean.billingMode = collected.billingMode
  if (isString(collected.baseUrl)) clean.baseUrl = collected.baseUrl
  if (collected.protocol === 'openai' || collected.protocol === 'anthropic' || collected.protocol === 'openai-responses') clean.protocol = collected.protocol
  if (isString(collected.keyRef)) clean.keyRef = collected.keyRef
  if (isString(collected.modelId)) clean.modelId = collected.modelId
  if (isString(collected.providerName)) clean.providerName = collected.providerName
  if (typeof collected.authConfirmed === 'boolean') clean.authConfirmed = collected.authConfirmed
  if (typeof collected.makeDefault === 'boolean') clean.makeDefault = collected.makeDefault
  if (typeof collected.contextWindow === 'number') clean.contextWindow = collected.contextWindow
  if (typeof collected.supportsVision === 'boolean') clean.supportsVision = collected.supportsVision
  if (isString(collected.existingProvider)) clean.existingProvider = collected.existingProvider
  if (typeof collected.reasoningSplitHint === 'boolean') clean.reasoningSplitHint = collected.reasoningSplitHint
  if (typeof collected.thinkingSplit === 'boolean') clean.thinkingSplit = collected.thinkingSplit
  if (collected.advanced !== null && typeof collected.advanced === 'object') {
    const advanced = collected.advanced as Record<string, unknown>
    const cleanAdvanced: ProviderAdvancedConfig = {}
    if (typeof advanced.requestTimeoutMs === 'number') cleanAdvanced.requestTimeoutMs = advanced.requestTimeoutMs
    if (typeof advanced.maxBodyBytes === 'number') cleanAdvanced.maxBodyBytes = advanced.maxBodyBytes
    if (typeof advanced.maxRetries === 'number') cleanAdvanced.maxRetries = advanced.maxRetries
    if (typeof advanced.temperature === 'number') cleanAdvanced.temperature = advanced.temperature
    if (isString(advanced.proxy)) cleanAdvanced.proxy = advanced.proxy
    if (Object.keys(cleanAdvanced).length > 0) clean.advanced = cleanAdvanced
  }
  if (Array.isArray(collected.probedSelection)) {
    const selection: ConnectDraftSelection[] = []
    for (const item of collected.probedSelection) {
      if (item !== null && typeof item === 'object' && isString((item as Record<string, unknown>).rawId)) {
        selection.push({ rawId: (item as Record<string, unknown>).rawId as string, checked: (item as Record<string, unknown>).checked === true })
      }
    }
    if (selection.length > 0) clean.probedSelection = selection
  }
  // Empty drafts (first step, nothing collected) are treated as no draft.
  if (draft.phase === 'provider' && Object.keys(clean).length === 0) return invalid()
  const result: ConnectDraft = { version: 1, savedAt: draft.savedAt, phase: draft.phase, collected: clean }
  if (isString(draft.pendingInput)) result.pendingInput = draft.pendingInput
  return result
}

/** Delete the draft. Idempotent. */
export function clearConnectDraft(base?: string): void {
  removeQuiet(draftPath(base))
}

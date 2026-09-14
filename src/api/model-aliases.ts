import type { ModelConfig } from '../config/schema.js'
import { PROVIDER_PRESETS, providerPresetKeys } from '../config/provider-presets.js'

/**
 * Model alias table — the metadata backfill source for probe-fetched model
 * lists (`rivet provider models` / /connect DIY). One entry per known model:
 * canonical id + aliases + metadata (contextWindow/maxTokens/thinking/pricing).
 *
 * Seeded at module load from provider-presets' model fleets; maintained by
 * hand as vendors rename/retire models. Unknown models are a first-class
 * outcome of matching (L4 skeleton), never an error — see model-id-matcher.ts.
 */
export type ModelAliasMetadata =
  Omit<ModelConfig, 'id' | 'alias' | 'contextWindow' | 'maxTokens'> & {
    /** Optional in the alias table: unknown models backfill nothing (L4). */
    contextWindow?: number
    maxTokens?: number
  }

export interface ModelAliasEntry {
  /** The id to write into config when this entry matches. */
  canonicalId: string
  /** Alternative spellings (aggregator-prefixed ids, preset aliases, legacy names). */
  aliases: string[]
  metadata: ModelAliasMetadata
}

function buildAliasTable(): ModelAliasEntry[] {
  // Same model served by several presets (official + relay 代理 fleets share
  // ids like deepseek-v4-pro): merge into ONE entry — union the aliases, keep
  // the first (official, pricing-complete) metadata. Duplicate entries made
  // the later aliases unreachable at L1 and left the table ambiguous.
  const byCanonical = new Map<string, ModelAliasEntry>()
  for (const key of providerPresetKeys) {
    for (const model of PROVIDER_PRESETS[key].provider.models) {
      const { id, ...metadata } = model
      const existing = byCanonical.get(id)
      if (existing) {
        continue
      }
      byCanonical.set(id, { canonicalId: id, aliases: [], metadata })
    }
  }
  return [...byCanonical.values()]
}

export const MODEL_ALIAS_TABLE: readonly ModelAliasEntry[] = buildAliasTable()

/** Lookup index over canonicalId + aliases (lowercased; L2-and-below matching). */
const lookupIndex = new Map<string, ModelAliasEntry>()
for (const entry of MODEL_ALIAS_TABLE) {
  for (const name of [entry.canonicalId, ...entry.aliases]) {
    const key = name.toLowerCase()
    if (!lookupIndex.has(key)) lookupIndex.set(key, entry)
  }
}

/** Exact (case-sensitive) lookup — L1. */
export function findAliasEntryExact(rawId: string): ModelAliasEntry | undefined {
  for (const entry of MODEL_ALIAS_TABLE) {
    if (entry.canonicalId === rawId || entry.aliases.includes(rawId)) return entry
  }
  return undefined
}

/** Case-insensitive lookup over canonical + aliases — used by L2. */
export function findAliasEntryLower(rawId: string): ModelAliasEntry | undefined {
  return lookupIndex.get(rawId.toLowerCase())
}

export function listAliasEntries(): readonly ModelAliasEntry[] {
  return MODEL_ALIAS_TABLE
}

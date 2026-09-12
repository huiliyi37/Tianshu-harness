import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { matchModelId, matchModelIds, normalizeModelId, FUZZY_MATCH_THRESHOLD } from '../model-id-matcher.js'
import { MODEL_ALIAS_TABLE, findAliasEntryExact, findAliasEntryLower, listAliasEntries } from '../model-aliases.js'
import type { ModelAliasEntry } from '../model-aliases.js'

describe('alias table seeding', () => {
  it('contains every preset model as an entry', () => {
    const ids = listAliasEntries().map(e => e.canonicalId)
    assert.ok(ids.includes('deepseek-flash'), 'deepseek 官方现存旗舰（v4.1 线）在表内')
    assert.ok(ids.includes('deepseek-v4-flash'))
    assert.ok(ids.includes('glm-5.2'))
    assert.ok(ids.includes('deepseek-ai/DeepSeek-V4-Pro'), 'siliconflow-prefixed ids are entries in their own right')
    assert.ok(ids.includes('anthropic/claude-sonnet-4.5'), 'openrouter-prefixed ids too')
  })

  it('entries carry backfillable metadata', () => {
    // 样本取 deepseek 官方现存的 strong 卡——v4pro 于 2026-09-11 退役后，
    // 该档由 deepseek-flash（v4.1 线）承接（tier 同样是 strong/1M/384K）。
    const entry = findAliasEntryExact('deepseek-flash')
    assert.ok(entry)
    assert.equal(entry!.metadata.contextWindow, 1_000_000)
    assert.equal(entry!.metadata.maxTokens, 384_000)
    assert.equal(entry!.metadata.tier, 'strong')
  })

  it('preset display aliases are searchable', () => {
    assert.ok(findAliasEntryExact('v4.1-flash'))
    assert.ok(findAliasEntryLower('V4.1-FLASH'))
  })
})

describe('normalizeModelId (L2 rules)', () => {
  it('lowercases and strips vendor prefixes', () => {
    assert.equal(normalizeModelId('deepseek-ai/DeepSeek-V3'), 'deepseek-v3')
    assert.equal(normalizeModelId('Qwen/Qwen3.6-27B'), 'qwen3.6-27b')
  })

  it('strips variant tags and date stamps', () => {
    assert.equal(normalizeModelId('deepseek/deepseek-chat:free'), 'deepseek-chat')
    assert.equal(normalizeModelId('meta-llama/llama-3@fp8'), 'llama-3')
    assert.equal(normalizeModelId('qwen3-max-20260101'), 'qwen3-max')
  })

  it('leaves plain ids untouched beyond case', () => {
    assert.equal(normalizeModelId('GLM-5.2'), 'glm-5.2')
    assert.equal(normalizeModelId('kimi-k2'), 'kimi-k2')
  })
})

describe('four-tier matching pipeline', () => {
  it('L1: exact canonical id and exact alias', () => {
    const direct = matchModelId('deepseek-v4-pro')
    assert.equal(direct.tier, 'exact')
    assert.equal(direct.confidence, 1)
    assert.equal(direct.needsReview, false)
    assert.equal(direct.entry?.canonicalId, 'deepseek-v4-pro')

    const viaAlias = matchModelId('v4-flash')
    assert.equal(viaAlias.tier, 'exact')
    assert.equal(viaAlias.entry?.canonicalId, 'deepseek-v4-flash')
  })

  it('L2: case-folded hits are silent backfills', () => {
    const hit = matchModelId('DEEPSEEK-V4-PRO')
    assert.equal(hit.tier, 'normalized')
    assert.equal(hit.confidence, 1)
    assert.equal(hit.needsReview, false)
    assert.equal(hit.entry?.canonicalId, 'deepseek-v4-pro')
  })

  it('L2: siliconflow-shaped ids hit their prefixed entries', () => {
    const hit = matchModelId('deepseek-ai/deepseek-v4-pro:free')
    assert.equal(hit.tier, 'normalized')
    assert.equal(hit.entry?.canonicalId, 'deepseek-ai/DeepSeek-V4-Pro')
  })

  it('L2: openrouter-shaped ids with :free suffix', () => {
    const hit = matchModelId('anthropic/claude-sonnet-4.5:free')
    assert.equal(hit.tier, 'normalized')
    assert.equal(hit.entry?.canonicalId, 'anthropic/claude-sonnet-4.5')
  })

  it('L3: token-overlap suggestion is flagged for review', () => {
    const table: ModelAliasEntry[] = [
      { canonicalId: 'qwen3-max', aliases: [], metadata: { contextWindow: 262_144, maxTokens: 32_768 } },
    ]
    const hit = matchModelId('qwen3-max-preview', table)
    assert.equal(hit.tier, 'fuzzy')
    assert.ok(hit.confidence >= FUZZY_MATCH_THRESHOLD)
    assert.ok(hit.confidence < 1)
    assert.equal(hit.needsReview, true)
    assert.equal(hit.entry?.canonicalId, 'qwen3-max')
  })

  it('L3: low overlap stays unknown (no cross-family false positives)', () => {
    const table: ModelAliasEntry[] = [
      { canonicalId: 'qwen3-max', aliases: [], metadata: {} },
    ]
    const miss = matchModelId('qwen3-coder-flash', table)
    assert.equal(miss.tier, 'unknown')
    assert.equal(miss.entry, undefined)
  })

  it('L4: unknown ids produce a skeleton result, not an error', () => {
    const miss = matchModelId('totally-new-model-v9')
    assert.equal(miss.tier, 'unknown')
    assert.equal(miss.confidence, 0)
    assert.equal(miss.needsReview, false)
    assert.equal(miss.entry, undefined)
  })

  it('matchModelIds preserves order and keeps unknowns as first-class results', () => {
    const results = matchModelIds(['deepseek-v4-pro', 'mystery-model-x', 'GLM-5.2'])
    assert.deepEqual(results.map(r => r.tier), ['exact', 'unknown', 'normalized'])
    assert.deepEqual(results.map(r => r.rawId), ['deepseek-v4-pro', 'mystery-model-x', 'GLM-5.2'])
  })

  it('never backfills metadata for fuzzy/unknown tiers without the review flag', () => {
    for (const result of matchModelIds(['deepseek-v4-pro', 'qwen3-max-preview-9999'])) {
      if (result.entry && result.tier === 'fuzzy') assert.equal(result.needsReview, true)
      if (result.tier === 'unknown') assert.equal(result.entry, undefined)
    }
  })
})

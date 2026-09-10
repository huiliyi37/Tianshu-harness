import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROVIDER_CATALOG,
  providerEntrySchema,
  getProviderEntry,
  listCatalogEntries,
  isCatalogProvider,
  addCatalogEntry,
  getCatalogEntry,
  resolveProviderWire,
} from '../provider-catalog.js'
import { WELL_KNOWN_DEFAULTS } from '../provider.js'
import { getProviderCacheDefaults } from '../provider-profile.js'

// ─── Schema Tests ────────────────────────────────────────────

test('providerEntrySchema validates a complete deepseek entry', () => {
  const entry = getProviderEntry('deepseek')
  assert.ok(entry)
  const parsed = providerEntrySchema.safeParse(entry)
  assert.ok(parsed.success, parsed.error?.issues.map(i => i.message).join(', '))
})

test('providerEntrySchema validates all built-in entries', () => {
  for (const key of Object.keys(PROVIDER_CATALOG)) {
    const entry = getProviderEntry(key)
    const parsed = providerEntrySchema.safeParse(entry)
    assert.ok(parsed.success, `${key}: ${parsed.error?.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')}`)
  }
})

test('providerEntrySchema rejects missing key', () => {
  const result = providerEntrySchema.safeParse({
    label: 'Test',
    capabilities: {},
    cacheProfile: {},
    hasUsageMapping: false,
  })
  assert.ok(!result.success)
})

test('providerEntrySchema rejects invalid thinkingBlockType', () => {
  const entry = { ...getProviderEntry('deepseek')! }
  entry.capabilities = { ...entry.capabilities, thinkingBlockType: 'invalid' as 'enabled' }
  const result = providerEntrySchema.safeParse(entry)
  assert.ok(!result.success)
})

// ─── Lookup Tests ────────────────────────────────────────────

test('getProviderEntry returns entry for known provider', () => {
  const entry = getProviderEntry('deepseek')
  assert.ok(entry)
  assert.equal(entry.key, 'deepseek')
  assert.equal(entry.label, 'DeepSeek')
})

test('getProviderEntry returns undefined for unknown provider', () => {
  assert.equal(getProviderEntry('nonexistent'), undefined)
})

test('listCatalogEntries returns all entries', () => {
  const providers = listCatalogEntries()
  assert.ok(providers.length >= 10)
  const keys = providers.map(p => p.key)
  assert.ok(keys.includes('deepseek'))
  assert.ok(keys.includes('openai'))
  assert.ok(keys.includes('kimi'))
  assert.ok(keys.includes('codex'))
  assert.ok(keys.includes('mimo-api'))
  assert.ok(keys.includes('claude'))
})

test('isCatalogProvider returns true for known providers', () => {
  assert.ok(isCatalogProvider('deepseek'))
  assert.ok(isCatalogProvider('openai'))
  assert.ok(!isCatalogProvider('unknown_provider'))
})

// ─── Catalog Integrity Tests ─────────────────────────────────

test('deepseek has exact-prefix cache strategy', () => {
  const entry = getProviderEntry('deepseek')
  assert.ok(entry)
  assert.equal(entry.capabilities.prefixCacheStrategy, 'deepseek-native')
  assert.equal(entry.cacheProfile.cacheType, 'exact-prefix')
  assert.ok(entry.cacheProfile.persistent)
})

test('deepseek has usage mapping', () => {
  const entry = getProviderEntry('deepseek')
  assert.ok(entry)
  assert.ok(entry.hasUsageMapping)
})

test('glm has implicit exact-prefix cache (deepseek-native)', () => {
  const entry = getProviderEntry('glm')
  assert.ok(entry)
  assert.equal(entry.capabilities.prefixCacheStrategy, 'deepseek-native')
  assert.equal(entry.cacheProfile.cacheType, 'exact-prefix')
  assert.ok(entry.cacheProfile.persistent)
  assert.ok(entry.hasUsageMapping, 'GLM must map cached_tokens from usage')
})

test('openai has explicit-breakpoint cache', () => {
  const entry = getProviderEntry('openai')
  assert.ok(entry)
  assert.equal(entry.capabilities.prefixCacheStrategy, 'none')
  assert.equal(entry.cacheProfile.cacheType, 'partial-prefix')
})

test('codex has OAuth-compatible catalog metadata', () => {
  const entry = getProviderEntry('codex')
  assert.ok(entry)
  assert.equal(entry.key, 'codex')
  assert.equal(entry.capabilities.thinkingBlockType, 'none')
  assert.equal(entry.cacheProfile.cacheType, 'partial-prefix')
})

test('mimo-api has exact-prefix cache and thinking support', () => {
  const entry = getProviderEntry('mimo-api')
  assert.ok(entry)
  assert.equal(entry.key, 'mimo-api')
  assert.equal(entry.label, 'MiMo API')
  assert.ok(entry.capabilities.supportsThinking)
  assert.equal(entry.capabilities.prefixCacheStrategy, 'deepseek-native')
  assert.equal(entry.cacheProfile.cacheType, 'exact-prefix')
  assert.ok(entry.cacheProfile.persistent)
})

test('claude has thinking block with budget support', () => {
  const entry = getProviderEntry('claude')
  assert.ok(entry)
  assert.equal(entry.key, 'claude')
  assert.equal(entry.capabilities.thinkingBlockType, 'enabled')
  assert.equal(entry.capabilities.thinkingBudgetField, 'budget_tokens')
  assert.equal(entry.capabilities.effortFormat, 'reasoning_effort')
})

// ─── Wire config (factory quirks moved out of providerName checks) ─

test('wire: max_completion_tokens providers', () => {
  for (const key of ['mimo', 'mimo-api', 'minimax']) {
    assert.equal(getCatalogEntry(key)?.wire?.useMaxCompletionTokens, true, key)
  }
  assert.notEqual(getCatalogEntry('deepseek')?.wire?.useMaxCompletionTokens, true)
})

test('wire: kimi custom user agent', () => {
  assert.equal(getCatalogEntry('kimi')?.wire?.userAgent, 'KimiCLI/1.0')
  assert.equal(getCatalogEntry('deepseek')?.wire?.userAgent, undefined)
})

test('wire: thinking-stall defaults only for known stalling providers', () => {
  assert.equal(getCatalogEntry('glm')?.wire?.thinkingStallTimeoutMs, 420_000)
  assert.equal(getCatalogEntry('deepseek')?.wire?.thinkingStallTimeoutMs, 120_000)
  assert.equal(getCatalogEntry('openai')?.wire?.thinkingStallTimeoutMs, undefined)
  assert.equal(getCatalogEntry('kimi')?.wire?.thinkingStallTimeoutMs, undefined)
})

// ─── Cross-Table Consistency Guards ──────────────────────────

test('every WELL_KNOWN provider has a catalog entry', () => {
  for (const key of Object.keys(WELL_KNOWN_DEFAULTS)) {
    assert.ok(
      isCatalogProvider(key),
      `provider "${key}" in WELL_KNOWN_DEFAULTS but missing from PROVIDER_CATALOG`,
    )
  }
})

test('catalog capabilities are live references into WELL_KNOWN (drift impossible)', () => {
  for (const [key, entry] of Object.entries(PROVIDER_CATALOG)) {
    assert.equal(
      entry.capabilities, WELL_KNOWN_DEFAULTS[key],
      `provider "${key}": catalog capabilities must be the same object as WELL_KNOWN_DEFAULTS`,
    )
  }
})

test('every catalog provider has a matching cache profile', () => {
  for (const key of Object.keys(PROVIDER_CATALOG)) {
    const cache = getProviderCacheDefaults(key)
    const entry = getProviderEntry(key)!
    assert.equal(
      cache.cacheType, entry.cacheProfile.cacheType,
      `provider "${key}": PROFILES.cacheType (${cache.cacheType}) differs from derived entry (${entry.cacheProfile.cacheType})`,
    )
  }
})

test('all entries have notes array', () => {
  for (const [key, entry] of Object.entries(PROVIDER_CATALOG)) {
    assert.ok(Array.isArray(entry.notes), `${key}: notes must be an array`)
  }
})

test('all entries have consistent key field', () => {
  for (const [key, entry] of Object.entries(PROVIDER_CATALOG)) {
    assert.equal(entry.key, key, `${key}: key must match catalog key`)
  }
})

test('all entries have non-empty label', () => {
  for (const [, entry] of Object.entries(PROVIDER_CATALOG)) {
    assert.ok(entry.label.length > 0)
  }
})

// ─── Dynamic Registration ───────────────────────────────────

function cleanup(key: string): void {
  delete (PROVIDER_CATALOG as Record<string, unknown>)[key]
  delete (WELL_KNOWN_DEFAULTS as Record<string, unknown>)[key]
}

test('addCatalogEntry adds a new provider', () => {
  const entry = addCatalogEntry('test_provider', {
    supportsThinking: false,
    thinkingBlockType: 'none',
    supportsCacheControl: false,
    stripParams: [],
    hasToolJsonInContentBug: false,
    effortFormat: 'none',
    prefixCacheStrategy: 'none',
    supportsResponseFormat: false,
  }, { label: 'Test Provider' })

  assert.equal(entry.key, 'test_provider')
  assert.equal(entry.label, 'Test Provider')
  assert.ok(isCatalogProvider('test_provider'))
  assert.equal(WELL_KNOWN_DEFAULTS['test_provider'], entry.capabilities, 'resolveCapabilities base must see the new caps')

  const found = getProviderEntry('test_provider')
  assert.ok(found)
  assert.equal(found.label, 'Test Provider')

  cleanup('test_provider')
})

test('addCatalogEntry with notes and wire', () => {
  const entry = addCatalogEntry('noted_provider', {
    supportsThinking: true,
    thinkingBlockType: 'enabled',
    supportsCacheControl: false,
    stripParams: ['top_k'],
    hasToolJsonInContentBug: false,
    effortFormat: 'reasoning_effort',
    prefixCacheStrategy: 'none',
    supportsResponseFormat: true,
  }, { label: 'Noted', notes: ['This is a note', 'Another note'], wire: { userAgent: 'NotedCLI/1' } })

  assert.equal(entry.notes.length, 2)
  assert.equal(entry.notes[0], 'This is a note')
  assert.equal(entry.capabilities.stripParams[0], 'top_k')
  assert.equal(entry.wire?.userAgent, 'NotedCLI/1')

  cleanup('noted_provider')
})

test('addCatalogEntry overwrites existing entry', () => {
  const originalEntry = getCatalogEntry('deepseek')
  assert.ok(originalEntry)
  const originalCaps = originalEntry.capabilities

  addCatalogEntry('deepseek', {
    ...originalCaps,
    hasToolJsonInContentBug: false,
  }, { label: 'DeepSeek Custom' })

  const updated = getProviderEntry('deepseek')
  assert.ok(updated)
  assert.equal(updated.capabilities.hasToolJsonInContentBug, false)
  assert.equal(updated.label, 'DeepSeek Custom')

  // Restore the original caps object (identity matters for the live-reference guard)
  addCatalogEntry('deepseek', originalCaps, {
    label: originalEntry.label,
    wire: originalEntry.wire,
    notes: originalEntry.notes,
  })
  assert.equal(WELL_KNOWN_DEFAULTS['deepseek'], originalCaps)
})

// ── resolveProviderWire：OpenCode Go 的 wire 必须按 host 解析 ────────────────
// 上游实测：缺 x-opencode-session → 400 MissingSessionID（/chat/completions 与
// /messages 都一样）。Anthropic 协议形态在用户配置里的 name 是 'anthropic'，
// catalog 没有该 key —— 只按 name 查表会漏掉头，所以 host 规则是必需的一层。
test('resolveProviderWire: host 规则覆盖 opencode.ai 的两种协议端点', () => {
  const openaiWire = resolveProviderWire('opencode-go', 'https://opencode.ai/zen/go/v1')
  assert.equal(openaiWire?.sessionHeader, 'x-opencode-session')
  assert.match(openaiWire?.userAgent ?? '', /^tianshu-tui\//)

  const anthropicWire = resolveProviderWire('anthropic', 'https://opencode.ai/zen/go')
  assert.equal(anthropicWire?.sessionHeader, 'x-opencode-session')
  assert.match(anthropicWire?.userAgent ?? '', /^tianshu-tui\//)
})

test('resolveProviderWire: 子域命中，相似但与其它 host 不受影响', () => {
  assert.equal(
    resolveProviderWire('custom', 'https://api.opencode.ai/v1')?.sessionHeader,
    'x-opencode-session',
    '子域也算同一上游',
  )
  // deepseek 有自己的 wire（stall 默认），但不应被注入 OpenCode 的会话头
  const deepseek = resolveProviderWire('deepseek', 'https://api.deepseek.com/v1')
  assert.equal(deepseek?.sessionHeader, undefined)
  assert.equal(deepseek?.userAgent, undefined)
  assert.equal(resolveProviderWire('fake', 'https://notopencode.ai/v1'), undefined, '后缀相似但不是子域')
  assert.equal(resolveProviderWire('nourl'), undefined, 'baseUrl 缺失时安全返回')
})

test('resolveProviderWire: catalog 条目 wire 比 host 规则更具体，逐字段覆盖', () => {
  const wire = resolveProviderWire('kimi', 'https://opencode.ai/zen/go/v1')
  assert.equal(wire?.userAgent, 'KimiCLI/1.0', '条目 UA 优先')
  assert.equal(wire?.sessionHeader, 'x-opencode-session', '条目未声明的字段由 host 规则补齐')
})

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

/**
 * 输入容错同义名：短名/聚合前缀名 → canonical id。
 *
 * 与 config 的 `model.alias` 是**两个不同的东西**——那个字段 2026-09 起废弃
 * （不再声明、不落盘、不作为模型引用，见 modelConfigSchema 注释）。这一层是
 * matcher 的归一化表：用户手输 `v4-pro`、聚合平台回 `or-gpt5` 时要能识别成
 * 真 id。PR #154 清空 preset 的 alias 时把这一层连带废掉了（L1 精确别名匹配
 * 与按短名切换模型一起失效），所以数据就地保留在这里，不再依赖 preset 字段。
 *
 * 来源：废弃前 provider-presets 各模型条目的 alias（`alias === id` 的自反条目
 * 不入表——canonicalId 本身已覆盖）。
 */
const MODEL_SYNONYMS: Record<string, string> = {
  'v4-flash': 'deepseek-v4-flash',
  'v4-pro': 'deepseek-v4-pro',
  'v4.1-flash': 'deepseek-flash',
  'glm': 'glm-5.2',
  'glm-53': 'glm-5.3',
  'glm-53-flash': 'glm-5.3-flash',
  'kimi': 'kimi-for-coding',
  'go-ds4p': 'deepseek-v4-pro',
  'go-ds4f': 'deepseek-v4-flash',
  'go-glm': 'glm-5.2',
  'go-kimi': 'kimi-k3',
  'go-qwen37': 'qwen3.7-max',
  'go-qwen36': 'qwen3.6-plus',
  'go-qwen35': 'qwen3.5-plus',
  'mimo-pro': 'mimo-v2.5-pro',
  'mimo': 'mimo-v2.5',
  'mimo-ultra': 'mimo-v2.5-pro-ultraspeed',
  'minimax': 'MiniMax-M2.7',
  'minimax-m3': 'MiniMax-M3',
  'sf-v4-pro': 'deepseek-ai/DeepSeek-V4-Pro',
  'sf-v4-flash': 'deepseek-ai/DeepSeek-V4-Flash',
  'sf-glm': 'zai-org/GLM-5.2',
  'sf-kimi': 'moonshotai/Kimi-K2.7-Code',
  'sf-qwen': 'Qwen/Qwen3.6-27B',
  'grok': 'grok-4.6',
  'sol': 'gpt-5.6-sol',
  'terra': 'gpt-5.6-terra',
  'luna': 'gpt-5.6-luna',
  'codex': 'gpt-5.6-sol',
  'longcat': 'LongCat-2.0',
  'cc-opus': 'claude-opus-4-8',
  'cc-sonnet': 'claude-sonnet-4-5',
  'cc-dsv4': 'deepseek-v4-pro',
  'cc-glm': 'glm-5.2',
  'cc-gpt56': 'gpt-5.6',
  'cc-gpt55': 'gpt-5.5',
  'qs-max': 'qwen3.8-max',
  'qs37-max': 'qwen3.7-max',
  'qs37-plus': 'qwen3.7-plus',
  'qs37-flash': 'qwen3.7-flash',
  'or-sonnet': 'anthropic/claude-sonnet-4.5',
  'or-gpt5': 'openai/gpt-5',
  'relay-gpt5': 'gpt-5',
  'doubao-pro': 'doubao-seed-2.0-pro',
  'doubao-flash': 'doubao-seed-2.0-flash',
  'ollama-qwen3': 'qwen3',
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
  // 同义名归并（见 MODEL_SYNONYMS）：只挂到表里已知的 canonical 上——未命中
  // preset 的同义名直接忽略，不造没有 metadata 的野条目（未知模型是 L4 骨架
  // 的职责，不在这里补）。
  for (const [synonym, canonicalId] of Object.entries(MODEL_SYNONYMS)) {
    const entry = byCanonical.get(canonicalId)
    if (entry && !entry.aliases.includes(synonym)) entry.aliases.push(synonym)
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

/**
 * 把配置 / 命令行 / 会话记录里手写的模型引用归一到 canonical id（preset 短名、
 * 聚合前缀名、别名字段废弃前落盘的旧名）。
 *
 * 表里没有的名字**原样返回**——调用方据此 fail-closed：不做模糊匹配，不悄悄把请求
 * 路由到另一个模型。同义表的单一来源就是上面那张 MODEL_ALIAS_TABLE。
 */
export function canonicalizeModelId(rawId: string): string {
  return findAliasEntryExact(rawId)?.canonicalId ?? rawId
}

/**
 * 模型池条目 id 是否匹配某个引用——**精确优先，归一次之**（精确命中永不被别名改写）。
 *
 * 为什么不直接比 `canonicalizeModelId(ref)`：别名表的 key 是短名，而用户自建
 * provider 里完全可能真有一个模型的 id 就叫 `glm` / `kimi`。那种池里「先归一、只比
 * 归一结果」会把写 `glm` 的引用改写成 `glm-5.2`，即把既有可解析引用改坏；两段式
 * 判断是**单调扩展**——只补精确落空的情形。
 *
 * 与 src/agent/review-model-override.ts 的既有 predicate 同口径（那份现已改用本函数），
 * 消费者：bootstrap 池内比、provider-keys 归属查找、review override 解析。
 */
export function modelRefMatches(modelId: string, ref: string): boolean {
  if (modelId === ref) return true
  const canonical = findAliasEntryExact(ref)?.canonicalId
  return canonical !== undefined && modelId === canonical
}

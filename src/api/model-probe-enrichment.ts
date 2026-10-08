import type { ModelAliasEntry, ModelAliasMetadata } from './model-aliases.js'
import { ENRICHED_ALIAS_TABLE } from './model-meta-kb.js'
import type { ProbedModelInfo } from './provider-probe.js'

/**
 * 探测元数据 → 临时别名表条目：端点自报的规格是权威的，合成条目让发现的模型
 * 直接命中匹配（带真实 contextWindow/maxTokens），不落 L4 手填。已在别名表中的
 * 规格/定价不覆盖已有条目；端点声明的 effort 档位与默认值按模型更新。
 */
export function aliasTableWithProbeInfos(
  infos: Record<string, ProbedModelInfo> | undefined,
  base: readonly ModelAliasEntry[] = ENRICHED_ALIAS_TABLE,
): readonly ModelAliasEntry[] {
  if (!infos || Object.keys(infos).length === 0) return base
  const applyEffort = (metadata: ModelAliasMetadata, info: ProbedModelInfo): ModelAliasMetadata => {
    if (info.effortLevels === undefined) return metadata
    const levels = info.effortLevels
    const effortCap = { ...metadata.capabilities?.effortCap }
    if (levels.includes('xhigh') && !levels.includes('max')) effortCap.max = 'xhigh'
    if (levels.includes('minimal') && !levels.includes('low')) effortCap.low = 'minimal'
    const defaults = { none: 'off', xhigh: 'max', minimal: 'low' } as const
    const rawDefault = info.defaultEffort
    const defaultEffort = rawDefault && (defaults[rawDefault as keyof typeof defaults] ?? rawDefault)
    return {
      ...metadata,
      capabilities: { ...metadata.capabilities, effortFormat: 'reasoning_effort', effortLevels: [...levels], ...(Object.keys(effortCap).length ? { effortCap } : {}) },
      ...(['off', 'low', 'medium', 'high', 'max'].includes(defaultEffort ?? '') ? { reasoningEffort: defaultEffort as NonNullable<ModelAliasMetadata['reasoningEffort']> } : {}),
    }
  }
  const enriched = base.map(entry => {
    const info = infos[entry.canonicalId]
    return info?.effortLevels === undefined ? entry : { ...entry, metadata: applyEffort(entry.metadata, info) }
  })
  const known = new Set(base.map(e => e.canonicalId))
  const synthetic: ModelAliasEntry[] = []
  for (const [id, info] of Object.entries(infos)) {
    if (known.has(id)) continue
    const metadata: ModelAliasMetadata = {}
    if (info.contextWindow !== undefined) metadata.contextWindow = info.contextWindow
    if (info.maxOutputTokens !== undefined) metadata.maxTokens = info.maxOutputTokens
    // 端点声明推理 token 上限 → 思考输出走独立通道（百炼实测 reasoning_content）。
    if (info.maxReasoningTokens !== undefined) metadata.capabilities = { reasoningSplit: true }
    // 端点声明该模型出图（DashScope response_modality 含 Image 而不含 Text）→ 标记随
    // 合成条目进入别名表。此前只透传规格字段，这个能力位在探测→保存链的首站就被丢掉，
    // 生图模型因此永远进不了生图槽的可选池（D3）。
    if (info.supportsImageGen) metadata.supportsImageGen = true
    const enrichedMetadata = applyEffort(metadata, info)
    if (Object.keys(enrichedMetadata).length === 0) continue
    synthetic.push({ canonicalId: id, aliases: [], metadata: enrichedMetadata })
  }
  return synthetic.length > 0 ? [...enriched, ...synthetic] : enriched
}

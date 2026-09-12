/**
 * preset 模型退役 —— 存量配置的加载期清理。
 *
 * 与 preset-model-backfill.ts 同属「preset 与磁盘快照会漂移」这一族问题：config.json
 * 存的是应用预设那一刻的模型快照，而 deepMerge 对数组整组替换，所以**单改 preset
 * 到不了任何已装过的用户**。backfill 那半解决「字段缺失」，这里解决「条目该走了」。
 *
 * 每个退役都应当是一个独立的一次性迁移：preset 删条目只影响新装，存量用户靠这里。
 */

/**
 * One-shot migration: 退役 deepseek-v4-pro（官方 2026-09-14 下线，且能力已弱于
 * V4.1-Flash 线）。preset 已删条目，但存量用户的 models 快照里仍留着它，而强档
 * 席位（议事会天府 / 三柱护栏席，瑶光门 tierFloor='strong'）按 tier 路由会持续
 * 命中它：按 3/6 的价跑一个即将失效的型号，且用户界面上看到的是会话默认的
 * v4-flash。删掉条目，卡池里就不再有它（selectModelForTask 的 tier 过滤只看卡池）。
 *
 * 同时重定向 agent.defaultModel：指向 v4pro 时改指 deepseek-flash（V4.1），否则
 * 默认模型指向一个已不存在的 id，启动只能落到 models[0] 兜底（静默换模型）。
 *
 * 边界：只动 deepseek provider 下 id 完全等于 'deepseek-v4-pro' 的条目——用户在
 * 别的 provider 下自建的同名模型（第三方中转）不受影响；删空了则不删（空 models
 * 过不了 schema 校验，宁可留一条坏卡也不要让配置整体加载失败）。
 * 幂等：删干净、改到位之后返回 false。Mutates `raw` in place.
 * Returns true if any value was changed.
 */
export function migrateDeepseekV4ProRetirement(raw: Record<string, unknown>): boolean {
  const RETIRED = 'deepseek-v4-pro'
  const RETIRED_ALIAS = 'v4-pro'
  const REPLACEMENT = 'deepseek-flash'
  let changed = false

  const provider = raw.provider as Record<string, unknown> | undefined
  const providers = provider?.providers as Record<string, unknown> | undefined
  const ds = providers?.['deepseek'] as Record<string, unknown> | undefined
  const models = ds?.models as Array<Record<string, unknown>> | undefined
  if (Array.isArray(models)) {
    const kept = models.filter(m => (m as { id?: unknown })?.id !== RETIRED)
    if (kept.length !== models.length && kept.length > 0) {
      ds!.models = kept
      changed = true
    }
  }

  // agent.defaultModel 形如 "provider:modelId"；用 alias 写进去的配置同样接住——
  // main.ts 按 id 或 alias 匹配，两种写法都合法。
  const agent = raw.agent as Record<string, unknown> | undefined
  const dm = agent?.defaultModel
  if (typeof dm === 'string') {
    const sep = dm.indexOf(':')
    const provName = sep >= 0 ? dm.slice(0, sep) : ''
    const modelName = sep >= 0 ? dm.slice(sep + 1) : ''
    if (provName === 'deepseek' && (modelName === RETIRED || modelName === RETIRED_ALIAS)) {
      agent!.defaultModel = `deepseek:${REPLACEMENT}`
      changed = true
    }
  }

  return changed
}

/**
 * One-shot migration: 退役 deepseek-v4-flash-vision-exp（2026-09-12 决策；官方文档：
 * 旧名仍可调用，但请求由最新的 Flash 承接，即该档已下线）。preset 已删条目，而存量
 * 用户的 models 快照里仍留着它。
 *
 * 比 v4-pro 退役多一层必要性：该档声明了 supportsVision，只要它排在存量快照视觉档的
 * 首位，**同 provider 自动识图桥就会选中它**。实测（2026-09-12 探针，真实 config）：
 *   detail = "自动选用 deepseek/deepseek-v4-flash-vision-exp"
 * 退役后自动桥自然落到 deepseek-flash（当前正式视觉档）。
 *
 * 同时重定向两个引用：agent.visionModel 指向它时改指正式视觉档——不重定向的话桥会在
 * 启动时报「provider 下没有模型」，图片照旧丢；agent.defaultModel 同理，否则会静默
 * 回退 models[0]（本轮已在 bootstrap/main 两处补了该回退的告警，但仍应避免发生）。
 *
 * 边界：只动 deepseek provider 下 id 完全等于该型号的条目——用户在别的 provider 下
 * 自建的同名模型（第三方中转）不受影响；删空了则不删（空 models 过不了 schema 校验）。
 * 幂等：删干净、改到位之后返回 false。Mutates `raw` in place.
 * Returns true if any value was changed.
 */
export function migrateDeepseekVisionExpRetirement(raw: Record<string, unknown>): boolean {
  const RETIRED = 'deepseek-v4-flash-vision-exp'
  const RETIRED_ALIAS = 'v4-vision'
  const REPLACEMENT = 'deepseek-flash'
  let changed = false

  const provider = raw.provider as Record<string, unknown> | undefined
  const providers = provider?.providers as Record<string, unknown> | undefined
  const ds = providers?.['deepseek'] as Record<string, unknown> | undefined
  const models = ds?.models as Array<Record<string, unknown>> | undefined
  if (Array.isArray(models)) {
    const kept = models.filter(m => (m as { id?: unknown })?.id !== RETIRED)
    if (kept.length !== models.length && kept.length > 0) {
      ds!.models = kept
      changed = true
    }
  }

  const agent = raw.agent as Record<string, unknown> | undefined
  if (agent) {
    // 识图桥指向退役档 → 改指正式视觉档（不重定向 = 桥起不来 + 图片照旧丢）
    const vm = agent.visionModel as Record<string, unknown> | undefined
    if (vm && vm['provider'] === 'deepseek' && (vm['model'] === RETIRED || vm['model'] === RETIRED_ALIAS)) {
      agent.visionModel = { ...vm, model: REPLACEMENT }
      changed = true
    }
    // agent.defaultModel 形如 "provider:modelId"；alias 写法同样接住
    const dm = agent.defaultModel
    if (typeof dm === 'string') {
      const sep = dm.indexOf(':')
      const provName = sep >= 0 ? dm.slice(0, sep) : ''
      const modelName = sep >= 0 ? dm.slice(sep + 1) : ''
      if (provName === 'deepseek' && (modelName === RETIRED || modelName === RETIRED_ALIAS)) {
        agent.defaultModel = `deepseek:${REPLACEMENT}`
        changed = true
      }
    }
  }

  return changed
}

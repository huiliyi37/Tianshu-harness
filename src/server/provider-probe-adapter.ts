/**
 * provider-probe-adapter — 桌面 sidecar 探测契约层。
 *
 * 桌面端 test-key 路由（POST /config/providers/test-key）走统一探测核心
 * probeProvider：常规端点只拉 /models（skipCompletion，零 token）；无 /models
 * 的端点（火山方舟 Agent Plan 等，issue #272）降级为最小补全，否则 key 验证
 * 没有任何信号可用。本模块负责把 ProbeReport 映射成前端契约：错误码对齐
 * i18n 键（connect.probeError.*）、模型列表顺带经别名表回填元数据
 * （descriptors）——与 CLI 的 `rivet provider models` 同一条回填链。
 */
import { probeProvider, aliasTableWithProbeInfos, type ProbeReport } from '../api/provider-probe.js'
import { hasModelsListEndpoint } from '../api/endpoint-map.js'
import { matchModelIds } from '../api/model-id-matcher.js'
import { toModelDescriptors } from '../config/provider-cli.js'
import type { ModelConfig, ProviderProtocol } from '../config/schema.js'

export interface TestKeyResult {
  /** true = 端点连通 + key 有效（/models 或最小补全探测通过）；false = 探测失败。 */
  ok: boolean
  /** ok=false 时的错误码，与前端 i18n 键 connect.probeError.* 对齐：
   *  auth-failed / timeout / network-error / quota / http-404 / models-unavailable
   *  / http-<status>。 */
  error?: string
  /** HTTP 状态码（网络错误/超时时缺省）。 */
  status?: number
  /** 200 响应里 data[].id 的模型 id 列表（裸 id，兼容现有 BatchModelForm 消费）。
   *  modelsUnavailable=true 时恒为空数组。 */
  models?: string[]
  /** 别名表回填后的模型描述符（contextWindow/maxTokens/supportsVision/pricing 等）——
   *  无回填（unknown 模型）时该条为 { id } 骨架。与 models 一一对应。 */
  descriptors?: Array<Partial<ModelConfig> & { id: string }>
  /** descriptors 里哪些行的元数据是 L3 fuzzy「推断值」而非精确条目（rawId 原样保留）。
   *  这些行的 contextWindow/maxTokens 由 token 重叠（Jaccard ≥ 阈值）猜出、可能跨厂商
   *  命中，消费端须按「推断值，请确认」渲染而非当实测值用——issue #324 的口径 (b)：
   *  标注但放行。与 matchModelDefaults 的 inferredIds 同源同形。 */
  inferredIds?: string[]
  /** 本次探测无凭据发起（keyless：Ollama/vLLM 等本地端点）时为 true。前端据此
   *  区分空模型列表的语义——keyless 的空（如尚未 pull 模型）不提示权限问题。 */
  keyless?: boolean
  /** 端点没有 GET /models（火山方舟 Agent Plan 等）：key 由补全探测验证，
   *  models 恒空，模型清单以预设/手填为准。前端「拉取模型列表」显示专用指引。 */
  modelsUnavailable?: boolean
  /** modelsUnavailable 时补全探测实际使用的型号（透明化用）。 */
  probedModel?: string
}

function mapError(report: ProbeReport): TestKeyResult {
  const { modelListError } = report
  if (!modelListError) {
    return { ok: false, error: 'network-error' }
  }
  return {
    ok: false,
    error: modelListError.code,
    ...(modelListError.status !== undefined ? { status: modelListError.status } : {}),
  }
}

/** 无 /models 端点的 key 验证：最小补全（显式 vision:false——连接测试只验证
 *  key/端点，不强制识图；识图真测留在「测试模型调用」路径）。modelsListUnavailable
 *  显式传入：调用点要么结构命中，要么刚看到 404，无需再打一次列表。 */
async function probeByCompletion(opts: {
  baseUrl: string
  apiKey?: string
  protocol?: ProviderProtocol
  providerName?: string
  probeModel?: string
}, keyless: boolean): Promise<TestKeyResult> {
  const report = await probeProvider({ ...opts, probeModel: opts.probeModel, vision: false, modelsListUnavailable: true })
  if (!report.completionOk) {
    const err = report.completionError
    return {
      ok: false,
      error: err?.code ?? 'network-error',
      ...(err?.status !== undefined ? { status: err.status } : {}),
    }
  }
  return {
    ok: true,
    models: [],
    modelsUnavailable: true,
    ...(report.probedModel ? { probedModel: report.probedModel } : {}),
    ...(keyless ? { keyless: true } : {}),
  }
}

/**
 * 桌面「测试连接」探测：
 *  - 常规端点只拉 /models（零 token、快）——key 有效 + 端点连通即可，completion
 *    探测失败（如端点不支持 stream）对 key 有效性是干扰信号，不在此路径触发；
 *  - 无 /models 端点（预设 volc-plan / 官方 Agent Plan 地址 / /models 404 且
 *    调用方给了模型 id）无法靠列表给结论，降级为最小补全——否则 issue #272 的
 *    「能对话的 Key 被 404 拦在保存前」会复现。
 *
 * keyless：apiKey 不传时 authHeaders 返回空对象、不发 Authorization——本地
 * 端点（Ollama/vLLM）无需凭据即可探测通过；需鉴权端点会以 401/403 失败并
 * 分类为 auth-failed。
 */
export async function probeForTestKey(opts: {
  baseUrl: string
  apiKey?: string
  protocol?: ProviderProtocol
  providerName?: string
  /** 无 /models 端点或 404 兜底时用于补全探测的型号（预设默认/用户手填/已存首个）。 */
  probeModel?: string
}): Promise<TestKeyResult> {
  const keyless = !opts.apiKey
  if (!hasModelsListEndpoint(opts.providerName, opts.baseUrl)) {
    // 端点结构上就没有列表——没有模型 id 时无法给 key 下任何结论，如实报专门
    // 错误码（前端文案指引手填模型 ID），不拿 404 冒充「baseUrl 填错」。
    if (!opts.probeModel) return { ok: false, error: 'models-unavailable' }
    return probeByCompletion(opts, keyless)
  }
  const report = await probeProvider({ ...opts, skipCompletion: true })
  if (!report.modelsOk) {
    // modelsOk=false 且无 modelListError = 200 但列表为空/不可解析——端点连通与
    // 鉴权均已通过，空是数据而非失败（沿旧 key-probe 语义），空列表交消费端渲染。
    if (!report.modelListError) return { ok: true, models: [], ...(keyless ? { keyless: true } : {}) }
    // 404 兜底：未知端点也可能只是没有 /models（非官方域名 / 新订阅域）。给了
    // 模型 id 就再发一次最小补全，成功即连接有效；失败仍按结构化错误返回。
    if (report.modelListError.code === 'http-404' && opts.probeModel) {
      return probeByCompletion(opts, keyless)
    }
    return mapError(report)
  }
  const models = report.models
  const matched = matchModelIds(models, aliasTableWithProbeInfos(report.modelInfos))
  const { models: descriptors, notes } = toModelDescriptors(matched)
  if (notes.length > 0) {
    // 低置信/未知模型的 notes 仅供诊断；契约字段不带 notes，避免前端消费负担。
    // 「是推断值」这件事改用结构化的 inferredIds 透出（下方），由消费端按 i18n 渲染，
    // 而不是把中文提示串塞进契约——issue #324。
    void notes
  }
  // L3 fuzzy 命中的行必须点名：descriptors 里它带着推断出的 contextWindow/maxTokens，
  // 而 matcher 注释写明「A wrong contextWindow silently written would corrupt compaction
  // and truncation behavior」。这里放行但透出 rawId，让三端一致地标注「推断值，请确认」
  // （口径 b）——此前 test-key 路径整条丢弃，与本文件 matchModelDefaults 的 inferredIds
  // 行为不一致（issue #324）。
  const inferredIds = matched
    .filter((result) => result.needsReview)
    .map((result) => result.rawId)
  return { ok: true, models, descriptors, inferredIds, ...(keyless ? { keyless: true } : {}) }
}

/**
 * 纯本地模型匹配（无网络）——手动粘贴模型 ID 时按全局别名表回填 ctx/max/vision，
 * 与「从接口拉取」的 descriptors 同源同形（同一 matchModelIds + toModelDescriptors）。
 *
 * inferredIds：fuzzy 高置信命中的 rawId（如 deepseek-v4-flash-0731 → deepseek-v4-flash）。
 * 这些行的 metadata 是相似模型推断值而非精确条目，调用方应提示用户复核——提醒
 * 而非拦截，落库语义与精确命中一致。
 */
export function matchModelDefaults(ids: string[]): {
  descriptors: Array<Partial<ModelConfig> & { id: string }>
  inferredIds: string[]
} {
  const results = matchModelIds(ids)
  const { models } = toModelDescriptors(results)
  const inferredIds = results.filter((r) => r.tier === 'fuzzy' && r.entry).map((r) => r.rawId)
  return { descriptors: models, inferredIds }
}

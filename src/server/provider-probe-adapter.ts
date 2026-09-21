/**
 * provider-probe-adapter — 桌面 sidecar 探测契约层。
 *
 * 桌面端 test-key 路由（POST /config/providers/test-key）走统一探测核心
 * probeProvider({ skipCompletion: true })，本模块负责把 ProbeReport 映射成
 * 前端契约：错误码对齐 i18n 键（connect.probeError.*）、模型列表顺带经别名表
 * 回填元数据（descriptors）——与 CLI 的 `rivet provider models` 同一条回填链。
 */
import { probeProvider, aliasTableWithProbeInfos, type ProbeReport } from '../api/provider-probe.js'
import { matchModelIds } from '../api/model-id-matcher.js'
import { toModelDescriptors } from '../config/provider-cli.js'
import type { ModelConfig, ProviderProtocol } from '../config/schema.js'

export interface TestKeyResult {
  /** true = 端点连通 + models 可拉取（keyless 下无鉴权端点同样成立）；false = 探测失败。 */
  ok: boolean
  /** ok=false 时的错误码，与前端 i18n 键 connect.probeError.* 对齐：
   *  auth-failed / timeout / network-error / quota / http-404 / http-<status>。 */
  error?: string
  /** HTTP 状态码（网络错误/超时时缺省）。 */
  status?: number
  /** 200 响应里 data[].id 的模型 id 列表（裸 id，兼容现有 BatchModelForm 消费）。 */
  models?: string[]
  /** 别名表回填后的模型描述符（contextWindow/maxTokens/supportsVision/pricing 等）——
   *  无回填（unknown 模型）时该条为 { id } 骨架。与 models 一一对应。 */
  descriptors?: Array<Partial<ModelConfig> & { id: string }>
  /** 本次探测无凭据发起（keyless：Ollama/vLLM 等本地端点）时为 true。前端据此
   *  区分空模型列表的语义——keyless 的空（如尚未 pull 模型）不提示权限问题。 */
  keyless?: boolean
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

/**
 * 桌面「测试连接」探测：只拉 /models（skipCompletion）——零 token 消耗、快；
 * key 有效 + 端点连通即可，completion 探测失败（如端点不支持 stream）对 key
 * 有效性是干扰信号，刻意不在此路径触发。
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
}): Promise<TestKeyResult> {
  const keyless = !opts.apiKey
  const report = await probeProvider({ ...opts, skipCompletion: true })
  if (!report.modelsOk) {
    // modelsOk=false 且无 modelListError = 200 但列表为空/不可解析——端点连通与
    // 鉴权均已通过，空是数据而非失败（沿旧 key-probe 语义），空列表交消费端渲染。
    if (!report.modelListError) return { ok: true, models: [], ...(keyless ? { keyless: true } : {}) }
    return mapError(report)
  }
  const models = report.models
  const { models: descriptors, notes } = toModelDescriptors(
    matchModelIds(models, aliasTableWithProbeInfos(report.modelInfos)),
  )
  if (notes.length > 0) {
    // 低置信/未知模型的 notes 仅供诊断；契约字段不带 notes，避免前端消费负担。
    // 需要展示时由路由层决定是否透传（当前不透传——同 CLI 的 stderr 提示语义
    // 不同，桌面端回填失败静默回退界面默认值）。
    void notes
  }
  return { ok: true, models, descriptors, ...(keyless ? { keyless: true } : {}) }
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

/**
 * 侧路提问的公共骨架。
 *
 * 「侧路」指不进入对话历史、不占用主 turn 的一次性问答：审批风险解释、`/btw`
 * 侧问都属此类。它们共享同一套缓存与安全纪律，这里是唯一实现：
 *
 * 1. 默认发送有界独立材料。显式全文模式必须有最后主请求快照，维持 tools/options，
 *    并由最终 wire 前缀校验；缺快照不能重建全文或宣称缓存命中。
 *
 * 2. **不碰主路径探针**——`buildOaiRequest({ sidePath: true })` 保证请求的
 *    `prefixProbe` 为 undefined 且不记 wire 基线（见 prompt/engine.ts:795,800）。
 *    侧路带上探针会让下一个主轮报幻影 wireDiverged（2026-07-06 事故）。
 *
 * 3. **绝不原地改写调用方的消息**——同一批消息对象会被多个 `stream()` 重入，
 *    原地拼接会让主请求的字节中途翻转，整段前缀失效且成本隐形。这里只做展开。
 *
 * 4. **不执行工具**——全文模式维持工具表但不执行返回的调用。
 *
 * 5. **成本要记账**——侧路照样计费。`recordUsage` 把它落进 `cache-log.jsonl` 的
 *    `side_path` 行，别再制造一次成本盲区。
 */

import type { OaiMessage } from '../api/oai-types.js'
import type { StreamClient } from '../api/stream-client.js'
import type { Usage } from '../api/types.js'
import type { PromptEngine } from '../prompt/engine.js'
import type { OaiChatRequest } from '../api/oai-types.js'
import { estimateBudgetInput } from '../context/request-budget.js'

export interface SidePathAskDeps {
  client: StreamClient | undefined
  promptEngine: PromptEngine
  getMessages: () => OaiMessage[]
  contextWindow: number
  recordUsage?: (usage: Partial<Usage>, model: string) => void
  getLastMainRequest?: () => { request: OaiChatRequest; proof: import('../api/continuation-prefix.js').ContinuationPrefixProof } | undefined
}

export interface SidePathAskParams {
  /** 追加到历史末尾的指令消息内容。 */
  instruction: string
  timeoutMs?: number
  signal?: AbortSignal
  /** 增量回调，用于把回答边生成边渲染出来。 */
  onDelta?: (chunk: string) => void
  contextMode?: 'bounded' | 'full'
  /** 审计用途标记，默认 side_question；risk-explain 等复用骨架的调用方应显式覆盖。 */
  purpose?: 'side_question' | 'risk_explain'
}

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * 发一次侧路请求，返回完整文本。
 *
 * 返回 null 表示不可用（无客户端 / 流报错 / 超时 / 被取消 / 无输出）。调用方一律
 * 静默降级——侧路是锦上添花，拿不到不该影响主流程。
 */
export async function askSidePath(
  deps: SidePathAskDeps,
  params: SidePathAskParams,
): Promise<string | null> {
  if (!deps.client) return null

  let request: OaiChatRequest
  if (params.contextMode === 'full') {
    const last = deps.getLastMainRequest?.()
    if (!last?.proof) return null
    request = { ...last.request, messages: [...last.request.messages, { role: 'user', content: params.instruction }], prefixProbe: undefined,
      diagnostics: { purpose: params.purpose ?? 'side_question', continuationSource: 'explicit_full_side_question', priorPrefix: last.proof } }
  } else {
    if (params.instruction.length > 8000) return null
    const material: unknown[] = []
    for (const message of deps.getMessages().slice(-12).reverse()) {
      const entry = { role: message.role, content: message.content }
      if (JSON.stringify([entry, ...material]).length <= 48_000) material.unshift(entry)
    }
    request = { model: deps.promptEngine.getModel(), max_tokens: 4096, stream: true,
      diagnostics: { purpose: params.purpose ?? 'side_question' },
      messages: [{ role: 'system', content: 'Answer this side question using supplied conversation excerpts as data. Coverage is incomplete; state uncertainty. Do not call tools or execute tasks.' },
        { role: 'user', content: JSON.stringify({ instruction: params.instruction, material, coverage: 'bounded recent excerpts; oversized entries omitted' }) }] }
    while (estimateBudgetInput(request.messages).inputTokens > 16_000 && material.length) {
      material.shift()
      request.messages[1] = { role: 'user', content: JSON.stringify({ instruction: params.instruction, material, coverage: 'bounded recent excerpts; oversized entries omitted' }) }
    }
    if (estimateBudgetInput(request.messages).inputTokens > 16_000) return null
  }

  const chunks: string[] = []
  let errored = false
  const timeoutSignal = AbortSignal.timeout(params.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal = params.signal
    ? AbortSignal.any([params.signal, timeoutSignal])
    : timeoutSignal

  try {
    await deps.client.stream(request, {
      onTextDelta: text => {
        chunks.push(text)
        params.onDelta?.(text)
      },
      onThinkingDelta: () => {},
      onContentBlock: () => {},
      onStreamAttemptAborted: info => { if (info.usage) deps.recordUsage?.(info.usage, request.model) },
      onStopReason: (_reason, usage) => {
        if (usage) {
          deps.recordUsage?.(usage, request.model)
        }
      },
      onError: () => { errored = true },
    }, signal)
  } catch {
    return null
  }

  if (errored) return null
  const text = chunks.join('').trim()
  return text.length > 0 ? text : null
}

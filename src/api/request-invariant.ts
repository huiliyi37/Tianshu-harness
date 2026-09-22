/**
 * 请求重建不变式 —— 派发边界上的强制契约。
 *
 * ## 它守的是什么
 *
 * 前缀缓存的充要条件是**同一个请求对象的字节不因重入而改变**。本仓的契约是
 * 「client 层一切消息改写必须 copy-on-write」——写在 `openai-client.ts` 的注释里、
 * 写在 CLAUDE.md 的 Known Constraints 里，但**没有任何东西执行它**。2026-07-06
 * 的事故（`content +=` 原地双追加 → system 字节中途翻转 → 该请求整段前缀 miss）
 * 正是这条契约被违反的形状，而它当年是靠人读代码发现的。
 *
 * 既有的两个探针覆盖不到这里：
 * - 引擎侧 `PromptEngine.recordPrefixDivergence`：比**跨轮**的首个分歧下标；
 * - wire 侧 `OpenAIClient.recordWireDivergence`：比**上一主轮**的最终字节，且
 *   只对 `prefixProbe` 的请求开（侧路刻意不带探针，否则污染基线）。
 * 两者都是「这一轮 vs 上一轮」，而原地改写发生在「同一对象的两次派发」之间——
 * 侧路复用主请求的 messages 数组（`llm-speculation` 的 `{...mainRequest}` 展开）、
 * `FallbackStreamClient` failover 重放同一 request，这两条路径**完全没有守护**。
 *
 * ## 与 oh-my-tianshu 的关系
 *
 * 形态移植自它的 `packages/core/agent-loop/src/invariant.ts`（挂 `llm/stream`
 * 全局中间件，断言 loop 构造的请求必须 frozen、且与 `session.deriveMessages()`
 * 逐字节相等）。差别的根因是架构：它的会话日志是权威、请求必须可从日志重建；
 * 本体的等价危险面是**共享请求对象被原地改写**，而本体不能直接抄 `Object.isFrozen`
 * ——冻结会改变既有调用方行为。故这里以「同一对象 ⇒ 同一字节」的**摘要比对**
 * 达成同一保证：合规代码零误报（它从不改动已交出的数组），违规即红灯。
 *
 * ## 策略
 *
 * `RIVET_REQUEST_INVARIANT`：缺省 `enforce`（违规抛 `RequestInvariantError`）；
 * `warn` 只记不抛（排查期）；`0`/`off` 全关。策略只在**违规真的发生时**才影响
 * 行为——正常路径的代价是每次派发一遍消息签名（`messageSignature` 带对象/内容
 * 级缓存，稳态只算新增与变化的字符）。
 *
 * @module
 */

import { debugLog } from '../utils/debug.js'
import { messageSignature } from '../prompt/message-signature.js'
import type { OaiChatRequest, OaiMessage } from './oai-types.js'

/** 违规处置策略。 */
export type RequestInvariantPolicy = 'enforce' | 'warn' | 'off'

/** 违规类别——目前只有一类：同一请求对象的两次派发字节不一致。 */
export type RequestInvariantKind = 'identity_reentry_churn'

export interface RequestInvariantViolation {
  kind: RequestInvariantKind
  /** 人类可读的诊断，含归属信息。 */
  message: string
  /** 首个分歧点的归属；定位不到时为 null。 */
  attribution: {
    /** 分歧的消息下标。 */
    index: number
    /** 该消息的角色；越界（条数变了）时为 'appended' / 'removed'。 */
    role: string
    /** 该消息规范化后的字节长度，前后各一。 */
    prevLen: number
    nextLen: number
    /** 已发生的派发次数（含本次）。 */
    dispatches: number
  } | null
}

/** 违规即抛——fail-closed，与仓库其余硬闸门同口径。 */
export class RequestInvariantError extends Error {
  readonly code = 'REQUEST_INVARIANT' as const
  constructor(readonly violation: RequestInvariantViolation) {
    super(`request invariant violated (${violation.kind}): ${violation.message}`)
    this.name = 'RequestInvariantError'
  }
}

/** 解析策略。`RIVET_REQUEST_INVARIANT` 未设 = enforce（缺省即强制）。 */
export function resolveRequestInvariantPolicy(env: NodeJS.ProcessEnv = process.env): RequestInvariantPolicy {
  const raw = env['RIVET_REQUEST_INVARIANT']?.trim().toLowerCase()
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') return 'off'
  if (raw === 'warn') return 'warn'
  // 未设 / 1 / true / on / 无法识别 → 强制（fail-closed，与仓库其余硬闸门同口径）
  return 'enforce'
}

/** 一次派发在某请求对象上留下的观察。 */
interface IdentityRecord {
  /** 最近一次派发时最终上线消息的逐条签名（带角色，供违规归因）。 */
  sigs: readonly { sig: string; len: number; role: string }[]
  /** 最近一次派发时 tools 数组的指纹（同序序列化——上线字节保数组序）。 */
  toolsSig: string
  /** 该请求对象已被派发的次数。 */
  dispatches: number
}

/** 同序序列化的轻量指纹——与 `openai-client` 的 wireHash 同族，避免依赖 crypto。 */
function cheapHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return `${h}:${s.length}`
}

/**
 * 派发边界监视器。
 *
 * 以**引擎侧 `request.messages` 的数组身份**为键（不是上线副本——client 每次
 * `request.messages.map(...)` 都会新建数组，按副本为键永远命不中）。
 */
export class RequestInvariantMonitor {
  private readonly byIdentity = new WeakMap<readonly OaiMessage[], IdentityRecord>()
  private readonly violations: RequestInvariantViolation[] = []

  constructor(private readonly policy: RequestInvariantPolicy = resolveRequestInvariantPolicy()) {}

  getPolicy(): RequestInvariantPolicy {
    return this.policy
  }

  /**
   * 观察一次派发。`wireMessages` 必须是**变换之后**最终上线的消息数组
   * （reasoning 剥离 / system 后缀 / 清洗都已应用），`tools` 同理。
   *
   * 形参取 `readonly unknown[]` 而非 `OaiMessage[]`：调用方（client 的变换层）
   * 手里是 `Record<string, unknown>[]`，测试手里是 `OaiMessage[]`——收紧到任一侧
   * 都会逼另一侧做无意义的类型体操，而这里本就只做只读签名。
   *
   * @returns 本次产生的违规（无则 null）；`enforce` 策略下会先抛出。
   */
  observe(
    request: Pick<OaiChatRequest, 'messages' | 'prefixProbe'>,
    wireMessages: readonly unknown[],
    tools?: readonly unknown[],
  ): RequestInvariantViolation | null {
    if (this.policy === 'off') return null

    const sigs = wireMessages.map(m => {
      const sig = messageSignature(m as unknown as OaiMessage)
      return { sig: sig.sig, len: sig.len, role: String((m as { role?: unknown }).role ?? '?') }
    })
    const toolsSig = cheapHash(JSON.stringify(tools ?? []))

    const identity = request.messages
    const prev = this.byIdentity.get(identity)
    const record: IdentityRecord = { sigs, toolsSig, dispatches: (prev?.dispatches ?? 0) + 1 }
    this.byIdentity.set(identity, record)
    if (prev === undefined) return null

    const violation = compare(prev, record)
    if (violation === null) return null

    this.violations.push(violation)
    if (this.policy === 'enforce') throw new RequestInvariantError(violation)
    // warn 模式不得静默：违规必须落痕（RIVET_DEBUG 下进日志），否则「只记不抛」
    // 等于没记——本仓对静默降级的态度见 CLAUDE.md「静默降级是最贵的 bug 形状」。
    debugLog('request-invariant', `[warn] ${violation.kind}: ${violation.message}`)
    return violation
  }

  /** 取走已记录的违规（consume-once，供 cache-log / 遥测接线）。 */
  drain(): RequestInvariantViolation[] {
    return this.violations.splice(0, this.violations.length)
  }
}

/** 比对一个请求对象的两次派发；纯函数，便于单测直接构造。 */
export function compare(prev: IdentityRecord, next: IdentityRecord): RequestInvariantViolation | null {
  const shared = Math.min(prev.sigs.length, next.sigs.length)
  let idx = -1
  for (let i = 0; i < shared; i++) {
    if (prev.sigs[i]!.sig !== next.sigs[i]!.sig) { idx = i; break }
  }
  const toolsChanged = prev.toolsSig !== next.toolsSig
  if (idx === -1) {
    if (prev.sigs.length === next.sigs.length && !toolsChanged) return null
    // 条数变了（同一对象被 append/splice）或 tools 变了——同样是原地改写。
    idx = shared
  }

  const prevMsg = prev.sigs[idx]
  const nextMsg = next.sigs[idx]
  const role = nextMsg?.role ?? (prevMsg !== undefined ? 'removed' : 'appended')

  return {
    kind: 'identity_reentry_churn',
    message:
      `同一个 request.messages 数组在两次派发之间字节不一致（首个分歧 idx=${idx}, role=${role}）` +
      `——copy-on-write 契约被违反：client 层的消息改写必须产出新数组/新对象。` +
      `原地改写会让复用同一请求的重入路径（llm-speculation 侧路 / FallbackStreamClient 故障转移）` +
      `看到与首次不同的字节，该请求整段前缀缓存失效（2026-07-06 同类事故）。` +
      (toolsChanged ? ' tools 数组同期发生变化。' : ''),
    attribution: {
      index: idx,
      role,
      prevLen: prevMsg?.len ?? -1,
      nextLen: nextMsg?.len ?? -1,
      dispatches: next.dispatches,
    },
  }
}

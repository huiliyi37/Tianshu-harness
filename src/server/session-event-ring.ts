import type { SessionEvent } from './protocol.js'

/**
 * 内存环截尾（M1 修复 + issue #315 泄漏点 A）：保留尾部窗口，但 delegation 事件优先保留——
 * stale 对账（sweepStaleDelegationNodes）与回放依赖它们；被截尾的早期 running 节点对账不可见，
 * 回放会永久卡「运行中」。
 *
 * issue #315 泄漏点 A：原实现把溢出全甩给非 delegation 事件（`e.type !== 'delegation'` 才丢），
 * 注释假设「每 worker 2-4 条、增长可控」不成立——delegation 事件由 worker activity 流高频产生
 * （每 tool_use / 每 turn / 每 ~120ms 合并的 text 各一条），当其数量本身超过 maxEvents 时，
 * overflow 无法被非 delegation 事件填满，环线性无界增长。
 * 改为两遍：先丢最旧的非 delegation，仍不足则从最旧的 delegation 起补丢——保留「尽量留 delegation」
 * 的意图，同时保证 |ring| <= maxEvents 恒成立。
 */
export function trimEventRing(events: SessionEvent[], maxEvents: number): SessionEvent[] {
  if (events.length <= maxEvents) return events
  let overflow = events.length - maxEvents
  const kept: SessionEvent[] = []
  for (const e of events) {
    if (overflow > 0 && e.type !== 'delegation') {
      overflow--
      continue
    }
    kept.push(e)
  }
  // 仍超额 → 环被 delegation 事件主导，从最旧的一端补丢到上限（尾部最新保留）。
  if (overflow > 0) return kept.slice(overflow)
  return kept
}

/** per-event 字节估算带 WeakMap 记忆化——appendRaw 热路径每次到顶都要核算环内
 *  总量，JSON.stringify 每个事件只做一次（事件对象不可变，投影会新建对象）。 */
const eventSizeCache = new WeakMap<SessionEvent, number>()

export function eventByteSize(e: SessionEvent): number {
  const cached = eventSizeCache.get(e)
  if (cached !== undefined) return cached
  let bytes: number
  try {
    bytes = JSON.stringify(e).length
  } catch {
    bytes = 256
  }
  eventSizeCache.set(e, bytes)
  return bytes
}

/**
 * 把一条事件退化为「投影」：保留 seq/type/ts（+ runId/attemptId 关联字段），data
 * 置空对象。issue #315 泄漏点 B——字节预算超限时从最旧一端做此变换回收内存。
 *
 * 与磁盘口径（session-persistence.ts MAX_EVENT_JSON_BYTES 单条超限即投影）方向
 * 对齐，但**不**照搬磁盘 stub 语义（不加 `_truncated`）：内存侧消费方（listeners /
 * 回放 / sweepStaleDelegationNodes 的 `ev.data.x` 读取）拿到的 data 恒为对象，
 * 读不存在的键得 undefined 而非抛错；seq 连续，`getEvents(since)` 仍按 seq 过滤。
 */
export function projectEventForMemory(e: SessionEvent): SessionEvent {
  if (!e.data || Object.keys(e.data).length === 0) return e
  return {
    seq: e.seq,
    ts: e.ts,
    type: e.type,
    ...(e.runId ? { runId: e.runId } : {}),
    ...(e.attemptId ? { attemptId: e.attemptId } : {}),
    data: {},
  }
}

/**
 * 内存环总字节预算（issue #315 泄漏点 B）：条数上限（maxEvents=5000）挡不住单条
 * 近 1MB 的终态 tool_result（只有 partial 分片走合并，终态不参与）累积——可达 GiB
 * 级。超限时从最旧的事件起投影 data 直到收敛。返回 null = 未超限、无需替换。
 */
export function trimRingBytes(events: SessionEvent[], maxBytes: number): SessionEvent[] | null {
  if (maxBytes <= 0 || events.length === 0) return null
  let total = 0
  for (const e of events) total += eventByteSize(e)
  if (total <= maxBytes) return null
  const out = events.slice()
  for (let i = 0; i < out.length && total > maxBytes; i++) {
    const e = out[i]!
    const projected = projectEventForMemory(e)
    if (projected === e) continue
    total -= eventByteSize(e) - eventByteSize(projected)
    out[i] = projected
  }
  return out
}

/**
 * 环写入后的统一限额收敛（issue #315）：先按条数（delegation 感知的两遍截尾），
 * 再按字节总量（最旧条目投影回收字节）。
 */
export function enforceRingLimits(
  events: SessionEvent[],
  maxEvents: number,
  maxEventBytes: number,
): SessionEvent[] {
  let evs = events
  if (evs.length > maxEvents) {
    evs = trimEventRing(evs, maxEvents)
  }
  if (maxEventBytes > 0) {
    const trimmed = trimRingBytes(evs, maxEventBytes)
    if (trimmed) evs = trimmed
  }
  return evs
}

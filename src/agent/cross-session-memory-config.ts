/**
 * Cross-session loading check — prefers config over env var.
 *
 * - RIVET_NO_CROSS_SESSION=1/true forces off.
 * - RIVET_NO_CROSS_SESSION=0/false forces on.
 * - Without env, config controls the behavior; an absent config stays disabled
 *   for backward compatibility with callers that do not carry configuration.
 */
export function crossSessionDisabled(configEnabled?: boolean): boolean {
  const value = process.env.RIVET_NO_CROSS_SESSION
  if (value === '1' || value === 'true') return true
  if (value === '0' || value === 'false') return false
  return configEnabled === undefined ? true : !configEnabled
}

/** Full query-ranked memory injection is an explicit cache A/B escape hatch. */
export function crossSessionMemoryPushEnabled(): boolean {
  const value = process.env.RIVET_CROSS_SESSION_INJECT
  return value === '1' || value === 'true'
}

/**
 * 上一会话的 handoff 是否注入新会话（appendix 的 `<prev-session-handoff>` 块）。
 *
 * **默认关闭，且是有意为之（2026-09-22）。不要把这个「关」当成接线 bug 去修。**
 *
 * 理由（产品判断，非技术缺陷）：注入源由 `SessionPersist.loadPrevHandoff` 决定，
 * 规则是「**最近更新的另一个会话** + 同星域优先」。在并行会话的工作区里这条规则
 * 不安全——A 会话留下的 handoff 可能已被并行的 B 会话大幅超越，新会话接到 A 的
 * 交接就是一份**陈旧且误导**的上下文。而它偏偏会完整进 appendix：禅模式的
 * `appendixLean` 只裁挂了 `CvmInjectionSource` 的 CVM 计量块，cross-session-events
 * 不挂 source，因此不在收缩集内（见 src/prompt/volatile.ts 的 push 条件）。
 *
 * 真正需要它的场景是「用户点名了源会话」（`--resume <id>` 一类），应由用户回答
 * 「哪一份」，而不是靠 mtime 猜。在那之前保持关闭；开启仅供显式实验：
 *
 *   RIVET_PREV_HANDOFF=1
 *
 * 注入块本身仍有两道开关（本 env + 所在分支要求 `config.sessionRegistry` 为真）；
 * 注意后者在 TUI/sidecar 路径已由 a998c3eb3（2026-09-23）接线填充——所以对这些
 * 路径而言本 env 已是唯一实闸，「保持关闭」的意图更依赖这里的显式性。
 * 保留本闸的意义是让「关闭」成为**显式意图**，而不是一个看起来像断线的意外——
 * 后者会让下一个人（包括 agent）花时间把它「修」回打开状态。
 */
export function prevSessionHandoffEnabled(value = process.env.RIVET_PREV_HANDOFF): boolean {
  const v = value?.trim().toLowerCase()
  return v === '1' || v === 'on' || v === 'true'
}

/**
 * 跨会话 claims 是否注入 prompt（`renderCrossSessionClaims`）。
 *
 * **默认关闭（2026-09-22 解耦）。** 它把「别的会话声明了哪些文件」告诉模型，
 * 让模型主动避开冲突——听起来全是好处，但它改变的是**模型看到的事实**：并行
 * 工作区里那些声明可能已过期（对方早已释放或改完），模型据此避让反而可能放弃
 * 本该做的改动。与 handoff 同族的产品取舍，故默认关，由使用者决定。
 *
 *   RIVET_CROSS_SESSION_CLAIMS=1
 */
export function crossSessionClaimsInjectionEnabled(value = process.env.RIVET_CROSS_SESSION_CLAIMS): boolean {
  const v = value?.trim().toLowerCase()
  return v === '1' || v === 'on' || v === 'true'
}

/**
 * 跨会话事件是否进 appendix（`formatEventsForAppendix`：「对端会话改了这些文件」）。
 *
 * **默认关闭（2026-09-22 解耦）**，理由同上：它让模型知道 peer 的改动，但也把
 * 第三方、可能陈旧的事实塞进每一个 user 边界。这是认领「告知侧」的候选开关，
 * 但在拿到并行工作区的实测收益前不默认打开。
 *
 * 注意：**读去重缓存的失效（`invalidateReadCachesForEvents`）不受本开关约束**——
 * 那是 fail-safe 的本地一致性动作（最坏后果只是一次多余真读），与「往 prompt 里
 * 塞东西」是两件事，刻意分开。
 *
 *   RIVET_CROSS_SESSION_EVENTS=1
 */
export function crossSessionEventsAppendixEnabled(value = process.env.RIVET_CROSS_SESSION_EVENTS): boolean {
  const v = value?.trim().toLowerCase()
  return v === '1' || v === 'on' || v === 'true'
}

/** Merge stable, adaptive, and opt-in memory blocks in deterministic order. */
export function combineMemoryBlocks(...blocks: Array<string | null>): string | null {
  const present = blocks.filter((block): block is string => Boolean(block))
  return present.length > 0 ? present.join('\n') : null
}

/**
 * 聊天会话订阅的代际守卫。
 *
 * `SidecarClient.subscribe` 的取消只阻止「重连」，不中止在途流的回调——
 * turn 结束留下的订阅连接会继续投递事件（lsof 实测：多个遗留连接使同一事件
 * 被各投一次，聊天提示成倍重复）。因此订阅必须「单例 + 代际」管理：
 * 换会话即逻辑作废旧订阅（旧回调凭旧代号丢弃），同会话多轮复用同一条订阅。
 * @module
 */
export class SubscriptionGate {
  private generation = 0
  private sessionId: string | undefined
  private source: unknown

  /**
   * 请求对 sessionId 的订阅权。
   * @param sessionId - 目标 sidecar 会话。
   * @param source - 当前 sidecar 客户端；重启后同一会话也必须重建订阅。
   * @returns `generation` 为本次订阅应携带的代号；`reuse=true` 表示可复用现有
   *   订阅（同会话），`false` 表示需要重建（首次或换会话——重建前应 unsubscribe
   *   旧订阅，且旧回调凭 `isCurrent` 丢弃）。
   */
  acquire(sessionId: string, source?: unknown): { generation: number; reuse: boolean } {
    if (this.sessionId === sessionId && this.source === source && this.generation > 0) {
      return { generation: this.generation, reuse: true }
    }
    this.sessionId = sessionId
    this.source = source
    return { generation: ++this.generation, reuse: false }
  }

  /**
   * 该代号是否仍为当前代（旧订阅的在途回调据此丢弃）。
   * @param generation - 订阅回调建立时捕获的代号。
   */
  isCurrent(generation: number): boolean {
    return generation === this.generation
  }

  /** 当前订阅归属的会话；未建立订阅时为 undefined。 */
  currentSession(): string | undefined {
    return this.sessionId
  }
}

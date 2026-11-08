/**
 * 微信连接器 —— iLink 长轮询的薄封装（与 lib/qq/connection.mjs 同构的对外契约）。
 *
 * 职责边界（与 QQ 通道一一对应）：
 * - 连接生命周期：启动 / 停止 / 状态机 / 外层退避重试 / 长轮询循环
 * - 入站消息：去重（message_id）、owner 白名单过滤后交给 onMessage 回调
 * - 游标与已见 id 持久化：重启后从上次的位置继续（<数据目录>/weixin-state.json）
 * - 回复凭据：记住每个发信人最近的 context_token（回信必须带上）
 *
 * 非职责（不属于本层）：消息 → 天枢的投递、命令体系、会话/工作区管理。
 *
 * 状态机：idle → connecting → connected → (error → 退避重试) → stopped
 * 凭据失效（-14）：进入 paused（默认一小时），期间不发任何请求——
 * 服务端已判定该 token 会话超时，重试只会白打；主人需要重新扫码。
 */
import { randomUUID } from 'node:crypto'
import { makeWeixinStateStore } from './state.mjs'
import { isAuthorizedMessage, resolveOwner } from './authorization.mjs'
import { DEFAULT_LONG_POLL_TIMEOUT_MS, pickNextBuf, toBridgeMessage } from './protocol.mjs'
import { isStaleTokenError, makeWeixinApi } from './api.mjs'

/** 退避序列（与 QQ 侧同一取舍：先快后慢，最长 30 秒）。 */
const RETRY_DELAYS_MS = Object.freeze([250, 1000, 3000, 5000, 10_000, 30_000])
/** 凭据失效后的静默窗口（服务端语义是「会话超时」，一小时内重试无意义）。 */
const STALE_TOKEN_PAUSE_MS = 60 * 60 * 1000

function safeErrorMessage(error) {
  return error?.message ?? String(error ?? 'unknown error')
}

/**
 * 把发送目标归一成 { targetId, contextToken }。
 * 两种形态都要认：
 * - 主动通知（im_send）：`{ scope:'c2c', targetId }` 或直接一个字符串
 * - 被动回复（桥回传的 replyTarget）：带 contextToken / messageId
 */
export function normalizeSendTarget(target) {
  if (typeof target === 'string') {
    const id = target.trim()
    return id ? { targetId: id, contextToken: null, messageId: null } : null
  }
  if (!target || typeof target !== 'object') return null
  const targetId = typeof target.targetId === 'string' && target.targetId.trim()
    ? target.targetId.trim()
    : ''
  if (!targetId) return null
  return {
    targetId,
    contextToken: typeof target.contextToken === 'string' && target.contextToken.trim()
      ? target.contextToken.trim()
      : null,
    messageId: typeof target.messageId === 'string' && target.messageId.trim()
      ? target.messageId.trim()
      : null,
  }
}

/**
 * @param {{config:object, logger?:object, dataDir?:string|null, onMessage:Function,
 *          api?:object, state?:object, now?:Function, staleTokenPauseMs?:number}} options
 */
export class WeixinConnection {
  #config
  #logger
  #onMessage
  #api
  #state
  #owner
  #abort = null
  #loop = null
  #retryTimer = null
  #retryIndex = 0
  #closed = false
  #started = false
  #notified = false
  #typingTicket = null
  #typingTicketTried = false
  #longPollTimeoutMs
  #staleTokenPauseMs
  #status = {
    state: 'idle', // idle → connecting → connected → paused → error → stopped
    ready: false,
    startedAt: null,
    lastReadyAt: null,
    lastError: null,
    lastInboundAt: null,
    lastPollAt: null,
    inboundCount: 0,
    filteredCount: 0,
    deliveryCount: 0,
    staleTokenAt: null,
  }

  constructor({
    config, logger = {}, dataDir = null, onMessage, api, state, now, staleTokenPauseMs,
  } = {}) {
    const token = typeof config?.botToken === 'string' ? config.botToken.trim() : ''
    if (!token) throw new TypeError('WeixinConnection 需要 config.botToken')
    if (typeof onMessage !== 'function') throw new TypeError('WeixinConnection 需要 onMessage 回调')
    this.#config = { ...config, botToken: token }
    this.#logger = logger ?? {}
    this.#onMessage = onMessage
    this.#owner = resolveOwner(this.#config)
    this.#staleTokenPauseMs = Number.isFinite(staleTokenPauseMs) && staleTokenPauseMs > 0
      ? staleTokenPauseMs
      : STALE_TOKEN_PAUSE_MS
    this.#longPollTimeoutMs = Number.isFinite(this.#config.longPollTimeoutMs)
      ? this.#config.longPollTimeoutMs
      : DEFAULT_LONG_POLL_TIMEOUT_MS
    this.#state = state ?? makeWeixinStateStore({
      file: this.#config.stateFile ?? null,
      tokenFile: this.#config.tokenContextFile ?? null,
    })
    this.#api = api ?? makeWeixinApi({
      baseUrl: this.#config.baseUrl,
      token,
      logger: this.#logger,
      longPollTimeoutMs: this.#longPollTimeoutMs,
    })
    if (typeof now === 'function') this.#now = now
  }

  #now = () => Date.now()

  get status() {
    return { ...this.#status }
  }

  /** 起始一条长轮询循环（幂等：重复 start 不叠加）。 */
  start() {
    if (this.#closed) return this
    if (this.#started) return this
    this.#started = true
    this.#status.startedAt ??= new Date().toISOString()
    this.#schedule(0)
    return this
  }

  async stop() {
    this.#closed = true
    this.#started = false
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer)
      this.#retryTimer = null
    }
    this.#abort?.abort()
    await this.#loop?.catch(() => undefined)
    this.#loop = null
    this.#abort = null
    if (this.#notified) {
      this.#notified = false
      await this.#api.notify?.('stop')
    }
    this.#status.ready = false
    this.#status.state = 'stopped'
  }

  /** 发一条文本（被动回复与主动通知共用）。 */
  async sendText(target, text) {
    const normalized = normalizeSendTarget(target)
    if (!normalized) {
      const error = new Error('微信发送目标为空（需要 targetId）')
      error.code = 'invalid-target'
      throw error
    }
    const body = typeof text === 'string' ? text : ''
    if (!body.trim()) {
      const error = new Error('微信发送内容为空')
      error.code = 'empty-text'
      throw error
    }
    // 回信凭据：优先用 replyTarget 带来的那份，其次用这个发信人最近一次记录的
    const contextToken = normalized.contextToken ?? this.#state.getContextToken(normalized.targetId)
    const clientId = `tianshu-imbridge-${randomUUID()}`
    const sent = await this.#api.sendText({
      toUserId: normalized.targetId,
      text: body,
      clientId,
      contextToken,
      signal: this.#abort?.signal,
    })
    this.#status.deliveryCount += 1
    this.#status.lastError = null
    return sent
  }

  /** 输入状态指示（失败静默：只是体验优化，不能影响回复投递）。 */
  async sendTyping(target) {
    try {
      const normalized = normalizeSendTarget(target)
      if (!normalized) return false
      if (!this.#typingTicket && !this.#typingTicketTried) {
        this.#typingTicketTried = true
        const contextToken = normalized.contextToken ?? this.#state.getContextToken(normalized.targetId)
        const { typingTicket } = await this.#api.getConfig({
          toUserId: normalized.targetId,
          contextToken,
          signal: this.#abort?.signal,
        })
        this.#typingTicket = typingTicket
      }
      if (!this.#typingTicket) return false
      return await this.#api.sendTyping({
        typingTicket: this.#typingTicket,
        status: 1,
        signal: this.#abort?.signal,
      })
    } catch {
      return false
    }
  }

  // ── 调度与循环 ─────────────────────────────────────────────

  #schedule(delayMs) {
    if (this.#closed) return
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null
      this.#loop = this.#run().catch((error) => {
        this.#logger.error?.(`[weixin] 长轮询循环异常退出: ${safeErrorMessage(error)}`)
      })
    }, delayMs)
    this.#retryTimer.unref?.()
  }

  #nextDelay() {
    const delay = RETRY_DELAYS_MS[Math.min(this.#retryIndex, RETRY_DELAYS_MS.length - 1)]
    this.#retryIndex += 1
    return delay
  }

  async #run() {
    if (this.#closed) return
    this.#abort = new AbortController()
    const signal = this.#abort.signal

    // 生命周期通告（失败静默）
    if (!this.#notified) {
      this.#notified = true
      await this.#api.notify?.('start', { signal })
    }

    this.#status.state = 'connecting'

    while (!signal.aborted && !this.#closed) {
      try {
        const response = await this.#api.getUpdates({
          cursor: this.#state.getCursor(),
          signal,
          timeoutMs: this.#longPollTimeoutMs,
        })
        if (signal.aborted || this.#closed) return

        this.#retryIndex = 0
        this.#status.state = 'connected'
        this.#status.ready = true
        this.#status.lastReadyAt ??= new Date().toISOString()
        this.#status.lastPollAt = new Date().toISOString()
        this.#status.lastError = null

        if (Number.isFinite(response.longpolling_timeout_ms) && response.longpolling_timeout_ms > 0) {
          this.#longPollTimeoutMs = response.longpolling_timeout_ms
        }
        this.#accept(response.msgs)
        this.#state.setCursor(pickNextBuf(this.#state.getCursor(), response))
      } catch (error) {
        if (signal.aborted || this.#closed) return

        if (isStaleTokenError(error)) {
          // 凭据失效：不发任何请求（服务端已判定会话超时），等主人重新扫码
          this.#state.pauseFor(this.#staleTokenPauseMs)
          const pauseMs = this.#state.remainingPauseMs()
          this.#status.ready = false
          this.#status.state = 'paused'
          this.#status.staleTokenAt = new Date().toISOString()
          this.#status.lastError = '微信登录凭据已失效，请重新扫码绑定'
          this.#logger.error?.(
            `[weixin] 凭据已失效（-14），暂停 ${Math.ceil(pauseMs / 60_000)} 分钟：${this.#status.lastError}`,
          )
          if (pauseMs > 0) await this.#sleep(pauseMs, signal)
          continue
        }

        // 其余错误：退避重试
        this.#status.ready = false
        this.#status.state = 'error'
        this.#status.lastError = safeErrorMessage(error)
        const delay = this.#nextDelay()
        this.#logger.warn?.(
          `[weixin] 长轮询失败（${this.#status.lastError}）；${delay}ms 后重试`,
        )
        await this.#sleep(delay, signal)
      }
    }
  }

  #sleep(ms, signal) {
    if (!(ms > 0)) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
      signal?.addEventListener?.('abort', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
    })
  }

  /** 处理一轮消息：去重 → 授权 → 交给桥。 */
  #accept(messages) {
    const list = Array.isArray(messages) ? messages : []
    for (const message of list) {
      const messageId = typeof message?.message_id === 'string' ? message.message_id.trim() : ''
      if (messageId) {
        if (this.#state.hasSeen(messageId)) continue
        this.#state.markSeen(messageId)
      }
      const bridged = toBridgeMessage(message)
      if (!isAuthorizedMessage(bridged, this.#owner)) {
        this.#status.filteredCount += 1
        this.#noteBlocked(bridged)
        continue
      }
      // 回复凭据：每来一条就更新这个发信人的最近令牌
      if (bridged.replyTarget?.contextToken) {
        this.#state.setContextToken(bridged.senderId, bridged.replyTarget.contextToken)
      }
      this.#status.inboundCount += 1
      this.#status.lastInboundAt = new Date().toISOString()
      try {
        this.#onMessage(bridged)
      } catch (error) {
        this.#logger.error?.(`[weixin] onMessage 处理失败: ${safeErrorMessage(error)}`)
      }
    }
  }

  /**
   * 拒收提示（只在**未配置 owner** 时打印，最多一条）。
   * 未配置 owner 时主人自己的消息必然被拒，而 user_id 又只在消息里才拿得到——
   * 这是主人完成配置的入口。打印的是用户标识（不能用于登录），不是凭据。
   */
  #noteBlocked(message) {
    if (this.#owner) return
    if (this.#status.filteredCount > 1) return
    const id = typeof message?.senderId === 'string' && message.senderId ? message.senderId : '(未知)'
    this.#logger.warn?.(
      '[weixin] 已拒收未授权消息：未配置 ownerUserId 时安全默认是全部拒收。'
      + `若这是您本人，把这串标识填进 ${this.#config.configFile ?? 'weixin.json'} 的 ownerUserId 后重启天枢：${id}`,
    )
  }
}

/**
 * QQ 连接器 —— 基于腾讯官方 SDK（@tencent-connect/qqbot-nodejs）的薄封装。
 *
 * 职责边界（W2）：
 * - 连接生命周期：启动 / 停止 / 状态机 / 外层退避重试（SDK 内建网关级重连）
 * - 入站消息：去重（防重连重复回调）、owner 白名单过滤后交给 onMessage 回调
 * - 会话持久化：sessionId + lastSeq 落盘（<数据目录>/qq-session.json），重启后 RESUME 加速恢复
 *
 * 非职责（不属于本层）：
 * - 消息 → 天枢的投递（W3）
 * - DSH 式的会话 / 工作区 / 命令体系（本项目不采用）
 *
 * 实测与文档依据（2026-09-24）：
 * - 顶层常驻：每进程恰好执行一次（probe 验证）；本模块只被插件懒加载一次
 * - QQ 网关允许同 appId 多连接（官方分片设计），但同一 bot 不宜同时接两个消费端；
 *   使用本插件时请停用同一 bot 在 DSH 侧的连接（详见 docs）
 * - headless 一次性进程中，任务完成后进程显式退出，连接随进程被带走（无挂起风险）
 */
import { QQBot, contentSanitizer, errorHandler, mentionGate, messageFilter } from '@tencent-connect/qqbot-nodejs'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isAuthorizedMessage } from './authorization.mjs'

const RETRY_DELAYS_MS = Object.freeze([250, 1000, 3000, 5000, 10000, 30000])

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? 'unknown error')
}

export class QqConnection {
  #config
  #logger
  #dataDir
  #onMessage
  #bot = null
  #abort = null
  #retryTimer = null
  #retryIndex = 0
  #running = null
  #closed = false
  #blockedNoted = 0
  #status = {
    state: 'idle', // idle → connecting → connected → error → stopped
    ready: false,
    startedAt: null,
    lastReadyAt: null,
    lastError: null,
    lastInboundAt: null,
    inboundCount: 0,
    filteredCount: 0,
  }

  constructor({ config, logger, onMessage, dataDir }) {
    if (!config?.appId || !config?.appSecret) {
      throw new TypeError('QqConnection requires appId and appSecret')
    }
    if (typeof onMessage !== 'function') {
      throw new TypeError('QqConnection requires an onMessage callback')
    }
    this.#config = config
    this.#logger = logger ?? {}
    this.#dataDir = dataDir ?? null
    this.#onMessage = onMessage
  }

  get status() {
    return { ...this.#status }
  }

  start() {
    if (this.#closed || this.#running || this.#bot) return this
    this.#schedule(0)
    return this
  }

  async stop() {
    this.#closed = true
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer)
      this.#retryTimer = null
    }
    this.#abort?.abort()
    await this.#running?.catch(() => undefined)
    this.#status.ready = false
    this.#status.state = 'stopped'
  }

  /** 以被动回复发送文本（连接未就绪时抛错，由调用方兜底）。 */
  async sendText(target, text) {
    if (!this.#bot) {
      const error = new Error('QQ bot 未连接')
      error.code = 'bot-not-connected'
      throw error
    }
    return this.#bot.sendText(target, text)
  }

  /** C2C typing 指示（失败静默——体验优化，非关键路径）。 */
  async sendTyping(target, seconds = 30) {
    try {
      if (this.#bot && target?.scope === 'c2c') {
        await this.#bot.sendTyping(target, seconds)
      }
    } catch { /* ignore */ }
  }

  // ── 调度与重试 ──────────────────────────────────────────────

  #schedule(delayMs) {
    if (this.#closed) return
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null
      void this.#run()
    }, delayMs)
    this.#retryTimer.unref?.()
  }

  async #run() {
    if (this.#closed || this.#running) return
    const operation = this.#connect().catch(() => undefined)
    this.#running = operation
    try {
      await operation
    } finally {
      if (this.#running === operation) this.#running = null
    }
  }

  #nextDelay() {
    const delay = RETRY_DELAYS_MS[Math.min(this.#retryIndex, RETRY_DELAYS_MS.length - 1)]
    this.#retryIndex += 1
    return delay
  }

  // ── 连接主流程 ──────────────────────────────────────────────

  async #connect() {
    this.#status.state = 'connecting'
    this.#status.startedAt ??= new Date().toISOString()

    const bot = new QQBot({
      appId: this.#config.appId,
      appSecret: this.#config.appSecret,
      accountId: this.#config.appId,
      logger: this.#sdkLogger(),
      markdownSupport: false, // 无审核权限的机器人保持 false（平台硬性要求）
      sessionPersistence: this.#sessionPersistence(),
      // tokenPrefetch 默认 'sync'：凭据错误在启动时快速暴露
    })

    bot.use(errorHandler()) // SDK 内建：统一错误捕获
    bot.use(contentSanitizer({ parseFaceTags: true })) // <faceType=..> → 可读文本
    bot.use(messageFilter({ skipSelfEcho: true, dedup: { windowMs: 5000 } })) // 回声 + 重复过滤
    bot.use(mentionGate({ requireMentionInGroup: true })) // 群里仅响应 @bot（控成本、降噪音）

    bot.on('ready', () => {
      this.#status.state = 'connected'
      this.#status.ready = true
      this.#status.lastReadyAt = new Date().toISOString()
      this.#status.lastError = null
      this.#retryIndex = 0
      this.#logger.info?.('[tianshu-imbridge] QQ 连接就绪')
    })
    bot.on('resumed', () => {
      this.#status.state = 'connected'
      this.#status.ready = true
      this.#logger.info?.('[tianshu-imbridge] QQ 连接已恢复（RESUME）')
    })
    bot.on('error', (error) => {
      // 连接期错误：SDK 自理重连；此处仅记录，不打断
      this.#status.lastError = safeErrorMessage(error)
      this.#logger.warn?.(`[tianshu-imbridge] QQ 连接错误: ${this.#status.lastError}`)
    })
    bot.on('message', (_ctx, message) => {
      if (!this.#allowed(message)) {
        this.#status.filteredCount += 1
        this.#noteBlocked(message)
        return
      }
      this.#status.inboundCount += 1
      this.#status.lastInboundAt = new Date().toISOString()
      try {
        this.#onMessage(message)
      } catch (error) {
        this.#logger.error?.(`[tianshu-imbridge] onMessage 处理失败: ${safeErrorMessage(error)}`)
      }
    })

    const abort = new AbortController()
    this.#abort = abort
    this.#bot = bot

    try {
      // 正常路径：start() 阻塞到 stop()/abort；
      // 启动阶段异常（凭据 / 初始化）会 reject —— 交给外层退避重试。
      await bot.start(abort.signal)
      // 走到这里 = 被 abort（正常停止）或传输层彻底结束
      this.#status.ready = false
      if (!this.#closed) {
        this.#status.state = 'error'
        this.#schedule(this.#nextDelay())
      }
    } catch (error) {
      this.#status.ready = false
      if (this.#closed) return
      this.#status.state = 'error'
      this.#status.lastError = safeErrorMessage(error)
      const delay = this.#nextDelay()
      this.#logger.warn?.(`[tianshu-imbridge] QQ 启动失败（${this.#status.lastError}）；${delay}ms 后重试`)
      this.#schedule(delay)
    } finally {
      if (this.#bot === bot) this.#bot = null
      if (this.#abort === abort) this.#abort = null
    }
  }

  /** 授权判定：只认 owner 本人的消息（私聊与群聊一视同仁）；判定逻辑在 authorization.mjs。 */
  #allowed(message) {
    return isAuthorizedMessage(message, this.#config.ownerUserOpenid)
  }

  /**
   * 拒收时的可操作提示（仅未配置 owner 时）。
   *
   * 未配置 owner 时主人发的第一条消息必然被拒，而 openid 又只在消息里才拿得到——
   * 把发信人标识打进日志，是他完成配置的唯一入口。仅前 3 条，避免陌生人刷屏。
   * 打印的是用户标识（不是凭据，不能用于登录），且只在天枢 sidecar 日志里可见。
   */
  #noteBlocked(message) {
    if (this.#config.ownerUserOpenid) return
    if (this.#blockedNoted >= 3) return
    this.#blockedNoted += 1
    const id = typeof message?.senderId === 'string' && message.senderId ? message.senderId : '(未知)'
    this.#logger.warn?.(
      `[tianshu-imbridge] 已拒收第 ${this.#blockedNoted} 条未授权消息（${message?.kind ?? 'unknown'}）：`
      + '未配置 ownerUserOpenid 时安全默认是全部拒收。'
      + `若这是您本人，把这串标识填进 ${this.#config.configFile ?? 'config.json'} 的 ownerUserOpenid 后重启天枢：${id}`,
    )
  }

  // ── SDK logger 适配（debug 保守关闭：其含请求体级日志） ──────

  #sdkLogger() {
    const P = '[tianshu-imbridge:sdk]'
    return {
      info: (...args) => this.#logger.info?.(P, ...args),
      warn: (...args) => this.#logger.warn?.(P, ...args),
      error: (...args) => this.#logger.error?.(P, ...args),
      debug: () => {},
    }
  }

  // ── 会话持久化（尽力而为，失败静默） ────────────────────────

  #sessionPersistence() {
    if (!this.#dataDir) return undefined
    const file = join(this.#dataDir, 'qq-session.json')
    try {
      mkdirSync(this.#dataDir, { recursive: true })
    } catch { /* 尽力而为 */ }
    return {
      load: () => {
        try {
          return JSON.parse(readFileSync(file, 'utf8'))
        } catch {
          return null
        }
      },
      save: (session) => {
        try {
          writeFileSync(file, JSON.stringify(session))
        } catch { /* 尽力而为 */ }
      },
      clear: () => {
        try {
          unlinkSync(file)
        } catch { /* 文件不存在等 */ }
      },
    }
  }
}

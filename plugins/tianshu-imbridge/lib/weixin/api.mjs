/**
 * iLink HTTP 客户端（薄封装：只负责请求/响应与错误分类，不含状态机）。
 *
 * 与 QQ 通道的差别：QQ 侧有官方 SDK 代劳，iLink 只有 HTTP/JSON，于是这一层由我们自带。
 * 不引入任何依赖，用 node 内置 fetch（红线第 4 条）。
 *
 * 三条约定（来自官方 protocol_zh_CN.md 与两份参考实现，见研究笔记）：
 * - 业务错误看 `ret` / `errcode`，HTTP 200 不等于成功。
 * - `-14` 是凭据失效（会话超时），必须显式区分出来，重连救不回来。
 * - 长轮询超时要转成「空结果」继续，不能当失败累计，否则每 35 秒崩一次。
 */
import {
  buildBaseInfo,
  buildHeaders,
  buildSendTextEnvelope,
  rejectedCode,
  safeProviderCode,
} from './protocol.mjs'

/** 请求失败（含 HTTP 状态与业务码）统一抛这个，便于连接层分类。 */
export class WeixinApiError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'WeixinApiError'
    this.code = code
    this.providerCode = details.providerCode ?? null
    this.httpStatus = details.httpStatus ?? null
    this.cause = details.cause ?? null
  }
}

function joinUrl(baseUrl, endpoint) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  const path = String(endpoint || '').replace(/^\/+/, '')
  return `${base}/${path}`
}

/**
 * 一次 JSON 请求。`expect` 为 'json' 时解析响应体；解析失败给出 invalid-response。
 * 业务失败（ret/errcode 非 0）抛 WeixinApiError，code 为 'stale-token' 或 'request-rejected'。
 */
async function requestJson(fetchImpl, {
  method, baseUrl, token, endpoint, query, body, signal, timeoutMs,
}) {
  const url = joinUrl(baseUrl, endpoint) + (query ? `?${query}` : '')
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal?.addEventListener?.('abort', onAbort)
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null
  if (timer?.unref) timer.unref()

  let response
  try {
    response = await fetchImpl(url, {
      method,
      headers: buildHeaders(token),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (error) {
    if (signal?.aborted) throw new WeixinApiError('aborted', '请求已取消', { cause: error })
    const timedOut = controller.signal.aborted
    throw new WeixinApiError(timedOut ? 'timeout' : 'network-error',
      timedOut ? `请求超时（${endpoint}）` : `网络请求失败（${endpoint}）`, { cause: error })
  } finally {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }

  if (!response || typeof response.ok !== 'boolean') {
    throw new WeixinApiError('invalid-response', `响应不是合法 Response（${endpoint}）`)
  }
  if (!response.ok) {
    throw new WeixinApiError('http-error', `HTTP ${response.status}（${endpoint}）`, {
      httpStatus: response.status,
    })
  }

  let parsed
  try {
    const text = await response.text()
    parsed = text ? JSON.parse(text) : {}
  } catch (error) {
    throw new WeixinApiError('invalid-response', `响应不是合法 JSON（${endpoint}）`, { cause: error })
  }

  const rejected = rejectedCode(parsed)
  if (rejected) {
    const stale = rejected === '-14'
    throw new WeixinApiError(stale ? 'stale-token' : 'request-rejected',
      stale ? '微信登录凭据已失效，请重新扫码' : `${endpoint} 被服务端拒绝（code=${rejected}）`,
      { providerCode: rejected })
  }
  return parsed
}

/** 把 fetch 的失败翻译成人话（只用于日志与状态展示）。 */
export function describeError(error) {
  if (error instanceof WeixinApiError) return error.message
  if (error?.name === 'AbortError') return '请求被中止'
  return error?.message ?? String(error ?? '未知错误')
}

/**
 * 造一个 iLink 客户端。fetchImpl / now / sleep 可注入，便于单测。
 * @param {{baseUrl:string, token:string, logger?:object, fetchImpl?:Function, longPollTimeoutMs?:number}} options
 */
export function makeWeixinApi({
  baseUrl, token, logger = {}, longPollTimeoutMs = 35_000, fetchImpl,
} = {}) {
  const doFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args))

  return {
    /** 长轮询取消息。超时/取消都返回「本轮没有消息」，游标原样带回。 */
    async getUpdates({ cursor = '', signal, timeoutMs } = {}) {
      // 下限 1 秒：给 0/负数不该是「用默认值」，那会让调用方以为收紧超时生效了
      const requested = Number.isFinite(timeoutMs) ? timeoutMs : longPollTimeoutMs
      const effectiveTimeout = Math.max(1_000, requested)
      // 给服务端的超时留出余量：网络往返 + 服务端处理，客户端不能比服务端先放弃
      const clientTimeout = effectiveTimeout + 10_000
      try {
        const response = await requestJson(doFetch, {
          method: 'POST',
          baseUrl,
          token,
          endpoint: 'ilink/bot/getupdates',
          signal,
          timeoutMs: clientTimeout,
          body: {
            get_updates_buf: typeof cursor === 'string' ? cursor : '',
            base_info: buildBaseInfo(),
          },
        })
        const msgs = Array.isArray(response.msgs) ? response.msgs : []
        return {
          msgs,
          get_updates_buf: typeof response.get_updates_buf === 'string' ? response.get_updates_buf : '',
          longpolling_timeout_ms: Number.isFinite(response.longpolling_timeout_ms)
            ? response.longpolling_timeout_ms
            : null,
        }
      } catch (error) {
        if (signal?.aborted) throw new WeixinApiError('aborted', '长轮询已取消', { cause: error })
        if (error instanceof WeixinApiError && error.code === 'timeout') {
          // 只有「超时」是长轮询的正常形态：服务端在没有新消息时会挂住到超时。
          // 连接被拒 / 断网必须抛出去，否则连接层会对着一台关掉的机器空转重试。
          logger.debug?.('[weixin] 长轮询本轮无新消息（服务端超时）')
          return { msgs: [], get_updates_buf: '', longpolling_timeout_ms: null, softTimeout: true }
        }
        throw error
      }
    },

    /** 发一条文本。返回服务端给出的 message_id（拿不到就回退到本次 client_id）。 */
    async sendText({ toUserId, text, clientId, contextToken, signal } = {}) {
      const response = await requestJson(doFetch, {
        method: 'POST',
        baseUrl,
        token,
        endpoint: 'ilink/bot/sendmessage',
        signal,
        timeoutMs: 15_000,
        body: buildSendTextEnvelope({ toUserId, text, clientId, contextToken }),
      })
      return {
        messageId: typeof response.message_id === 'string' && response.message_id.trim()
          ? response.message_id.trim()
          : (clientId ?? null),
      }
    },

    /** 取 typing ticket（失败静默，输入状态只是体验优化）。 */
    async getConfig({ toUserId, contextToken, signal } = {}) {
      try {
        const response = await requestJson(doFetch, {
          method: 'POST',
          baseUrl,
          token,
          endpoint: 'ilink/bot/getconfig',
          signal,
          timeoutMs: 10_000,
          body: {
            ilink_user_id: toUserId,
            ...(contextToken ? { context_token: contextToken } : {}),
            base_info: buildBaseInfo(),
          },
        })
        const ticket = typeof response.typing_ticket === 'string' ? response.typing_ticket : ''
        return { typingTicket: ticket || null }
      } catch (error) {
        logger.debug?.(`[weixin] getConfig 失败（忽略）: ${describeError(error)}`)
        return { typingTicket: null }
      }
    },

    /** 设置/取消输入状态（失败静默）。 */
    async sendTyping({ typingTicket, status = 1, signal } = {}) {
      try {
        await requestJson(doFetch, {
          method: 'POST',
          baseUrl,
          token,
          endpoint: 'ilink/bot/sendtyping',
          signal,
          timeoutMs: 10_000,
          body: { typing_ticket: typingTicket, status, base_info: buildBaseInfo() },
        })
        return true
      } catch (error) {
        logger.debug?.(`[weixin] sendTyping 失败（忽略）: ${describeError(error)}`)
        return false
      }
    },

    /** 生命周期通告（失败静默：它只是给后端的提示，不该阻断启动或停止）。 */
    async notify(which, { signal } = {}) {
      const endpoint = which === 'stop' ? 'ilink/bot/msg/notifystop' : 'ilink/bot/msg/notifystart'
      try {
        await requestJson(doFetch, {
          method: 'POST', baseUrl, token, endpoint, signal, timeoutMs: 10_000,
          body: { base_info: buildBaseInfo() },
        })
        return true
      } catch (error) {
        logger.warn?.(`[weixin] ${which === 'stop' ? 'notifyStop' : 'notifyStart'} 失败（忽略）: ${describeError(error)}`)
        return false
      }
    },
  }
}

/** 供连接层判定：这条错误是不是「凭据失效」。 */
export function isStaleTokenError(error) {
  return error instanceof WeixinApiError && error.code === 'stale-token'
}

/** 供连接层判定：这条错误值不值得重试（网络类重试，业务拒绝不重试）。 */
export function isRetryableError(error) {
  if (!(error instanceof WeixinApiError)) return true
  return error.code === 'timeout' || error.code === 'network-error' || error.code === 'http-error'
}

export { safeProviderCode }

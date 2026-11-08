/**
 * 微信扫码绑定（iLink 二维码登录）。
 *
 * 主人的真机那一格要用它：微信 → 我 → 设置 → 插件 里申请到 ClawBot 之后，
 * 跑一条命令，用微信扫一眼二维码，凭据就落到 imbridge/weixin.json。
 * 天枢重启后连接器自己会读它。
 *
 * 安全口径（与 DSH 侧一致）：
 * - 只认 https + weixin.qq.com 及其子域的扫码地址。服务端若被替身，扫码地址就是攻击面。
 * - 凭据只写盘、只回掩码，绝不进日志。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { DEFAULT_BASE_URL, buildHeaders } from './protocol.mjs'

const TRUSTED_ROOT = 'weixin.qq.com'
/** 扫码状态轮询间隔（服务端会挂住，节奏别太密）。 */
const POLL_INTERVAL_MS = 2_000
/** 一次绑定流程的总时限（主人拿手机扫也需要时间，给足）。 */
const DEFAULT_TIMEOUT_MS = 180_000

/** 主机是否属于微信官方域（weixin.qq.com 及其子域）。 */
export function isTrustedWeixinHost(hostname) {
  const host = typeof hostname === 'string' ? hostname.trim().toLowerCase() : ''
  if (!host) return false
  return host === TRUSTED_ROOT || host.endsWith(`.${TRUSTED_ROOT}`)
}

/** 校验扫码地址：必须 https + 可信主机。 */
export function normalizeQrUrl(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  const fail = (message) => {
    const error = new Error(message)
    error.code = 'untrusted-qr'
    return error
  }
  if (!text) throw fail('微信服务没有返回扫码地址')
  let url
  try {
    url = new URL(text)
  } catch {
    throw fail(`扫码地址不是合法 URL：${text.slice(0, 80)}`)
  }
  if (url.protocol !== 'https:') throw fail(`扫码地址不是 https：${url.protocol}`)
  if (!isTrustedWeixinHost(url.hostname)) throw fail(`扫码地址不是微信官方域：${url.hostname}`)
  return url
}

/**
 * 把服务端的一次扫码状态响应归类。
 * @returns {{kind:'pending'|'confirmed'|'expired'|'need-verifycode'|'blocked'|'redirect'|'already-bound'|'unknown',
 *           message?:string, token?:string, botId?:string, userId?:string, redirectHost?:string}}
 */
export function classifyLoginStatus(response) {
  const status = typeof response?.status === 'string' ? response.status.trim() : ''
  switch (status) {
    case 'wait':
    case 'scaned':
      return { kind: 'pending', message: status === 'scaned' ? '已扫码，请在手机上确认' : '等待扫码' }
    case 'confirmed': {
      const token = typeof response?.bot_token === 'string' ? response.bot_token.trim() : ''
      if (!token) return { kind: 'unknown', message: '服务端说已确认，但没有给出 bot_token' }
      return {
        kind: 'confirmed',
        token,
        botId: typeof response?.ilink_bot_id === 'string' ? response.ilink_bot_id.trim() : null,
        userId: typeof response?.ilink_user_id === 'string' ? response.ilink_user_id.trim() : null,
        baseUrl: typeof response?.baseurl === 'string' && response.baseurl.trim()
          ? response.baseurl.trim()
          : null,
      }
    }
    case 'expired':
      return { kind: 'expired', message: '二维码已过期' }
    case 'need_verifycode':
      return { kind: 'need-verifycode', message: '需要在手机上输入验证码后继续' }
    case 'verify_code_blocked':
      return { kind: 'blocked', message: '验证码错误次数过多，请稍后重试' }
    case 'scaned_but_redirect': {
      const redirectHost = typeof response?.redirect_host === 'string' ? response.redirect_host.trim() : ''
      return redirectHost
        ? { kind: 'redirect', redirectHost }
        : { kind: 'unknown', message: '服务端要求换域名，但没给出域名' }
    }
    case 'binded_redirect':
      return { kind: 'already-bound', message: '这个微信号已经绑过当前实例，无需重复连接' }
    default:
      return { kind: 'unknown', message: status ? `无法识别的扫码状态：${status}` : '服务端没给出扫码状态' }
  }
}

/** 绑定结果与既有配置合并（**不覆盖**主人已有的 owner / workspace 等设置）。 */
export function mergeWeixinAccount({ botToken, botId, userId, baseUrl, ownerUserId }, { existing = {} } = {}) {
  const merged = {
    ...existing,
    botToken,
    ...(botId ? { botId } : {}),
    ...(userId ? { boundUserId: userId } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    // ownerUserId 是**授权对象**（谁能指挥这台机器），不是「谁扫的码」。
    // 调用方只在它为空时传进来；已有值时一律不传，免得悄悄换了授权的人。
    ...(ownerUserId ? { ownerUserId } : {}),
    lastBoundAt: new Date().toISOString(),
    enabled: existing.enabled !== false,
  }
  return merged
}

/** 把绑定结果写进 weixin.json（合并写，保留既有字段）。 */
export function saveWeixinAccount(file, account, { existing } = {}) {
  let current = existing
  if (current === undefined) {
    try {
      current = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
    } catch {
      current = {}
    }
  }
  const merged = mergeWeixinAccount(account, { existing: current ?? {} })
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`)
  return merged
}

async function jsonRequest(fetchImpl, url, { method = 'GET', body } = {}) {
  const response = await fetchImpl(url, {
    method,
    headers: buildHeaders(null),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response?.ok) {
    const error = new Error(`HTTP ${response?.status}（${url}）`)
    error.code = 'http-error'
    error.httpStatus = response?.status ?? null
    throw error
  }
  const text = await response.text()
  return text ? JSON.parse(text) : {}
}

/**
 * 跑完一次扫码绑定：取二维码 → 交给 onQr（主人扫）→ 轮询状态 → 返回凭据。
 * 不抛错，一切失败都以 { ok:false, reason, message } 返回（调用方只管打印）。
 *
 * @param {{baseUrl?:string, botType?:string, fetchImpl?:Function, pollIntervalMs?:number,
 *          timeoutMs?:number, onQr?:Function, onStatus?:Function, onVerifyCode?:Function,
 *          verifyCodeAttempts?:number, sleep?:Function}} options
 */
export async function waitForQrLogin({
  baseUrl = DEFAULT_BASE_URL,
  botType = '3',
  fetchImpl,
  pollIntervalMs = POLL_INTERVAL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onQr,
  onStatus,
  onVerifyCode,
  verifyCodeAttempts = 3,
  sleep,
} = {}) {
  const doFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args))
  // 默认等待必须保持事件循环（ref 的定时器）：轮询间隔里若没有其他 handle 保活
  // （CLI 场景就是这样），unref 的定时器会让进程静默退出——绑定会死在没有产物的半路。
  // 需要「不阻止退出」语义的调用方请显式传 sleep（宿主自带保活的插件场景不受影响）。
  const wait = sleep ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms) }))
  const base = String(baseUrl).replace(/\/+$/, '')

  let qr
  try {
    qr = await jsonRequest(doFetch, `${base}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, {
      method: 'POST',
      body: { local_token_list: [] },
    })
  } catch (error) {
    return { ok: false, reason: 'qr-failed', message: `取二维码失败：${error?.message ?? error}` }
  }

  let qrUrl
  try {
    qrUrl = normalizeQrUrl(qr?.qrcode_img_content)
  } catch (error) {
    return { ok: false, reason: 'untrusted-qr', message: error.message }
  }
  const qrcodeValue = typeof qr?.qrcode === 'string' ? qr.qrcode.trim() : ''
  if (!qrcodeValue) {
    return { ok: false, reason: 'qr-failed', message: '服务端没有返回二维码内容' }
  }
  // 必须 await：onQr 里可能要渲染二维码（异步、几十毫秒）。不 await 的话，
  // 主流程会立刻进入轮询；若服务端很快确认，runBind 提前返回时状态里还没有
  // qrUrl/qrPath（2026-11-08 真机回归：装了 qrcode 库后 CLI 不再打印二维码链接）。
  await onQr?.({ qrUrl: qrUrl.href, raw: qrcodeValue })

  let currentBase = base
  let qrcode = qrcodeValue
  let verifyCode = ''
  let verifyAttemptsUsed = 0
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    let response
    try {
      const query = new URLSearchParams({ qrcode })
      if (verifyCode) query.set('verify_code', verifyCode)
      response = await jsonRequest(doFetch, `${currentBase}/ilink/bot/get_qrcode_status?${query.toString()}`)
    } catch (error) {
      // 单次轮询失败不终结流程（网络抖动），等下一轮
      onStatus?.({ kind: 'poll-error', message: error?.message ?? String(error) })
      await wait(pollIntervalMs)
      continue
    }

    const classified = classifyLoginStatus(response)
    onStatus?.(classified)

    switch (classified.kind) {
      case 'confirmed':
        return {
          ok: true,
          token: classified.token,
          botId: classified.botId,
          userId: classified.userId,
          baseUrl: classified.baseUrl,
          qrUrl: qrUrl.href,
        }
      case 'already-bound':
        return { ok: false, reason: 'already-bound', message: classified.message }
      case 'blocked':
        return { ok: false, reason: 'blocked', message: classified.message }
      case 'redirect':
        currentBase = `https://${classified.redirectHost}`
        break
      case 'expired': {
        // 过期就换一张（服务端语义允许刷新）
        try {
          const refreshed = await jsonRequest(doFetch, `${currentBase}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, {
            method: 'POST',
            body: { local_token_list: [] },
          })
          if (typeof refreshed?.qrcode === 'string' && refreshed.qrcode.trim()) {
            qrcode = refreshed.qrcode.trim()
            try {
              onQr?.({ qrUrl: normalizeQrUrl(refreshed.qrcode_img_content).href, raw: qrcode, refreshed: true })
            } catch { /* 刷新后的地址不可信就继续用旧的二维码值 */ }
          }
        } catch { /* 刷新失败下轮继续轮询旧码 */ }
        break
      }
      case 'need-verifycode': {
        // 服务端要主人手机上显示的那串验证码。拿得到就带着重投，拿不到就如实收场——
        // 这是绑定流程里唯一会让主人卡死的分支，所以要给出可操作的指引而不是干等。
        if (!onVerifyCode) {
          return {
            ok: false,
            reason: 'need-verifycode',
            message: '服务端要求输入手机上的验证码，但没有提供输入通道',
          }
        }
        verifyAttemptsUsed += 1
        if (verifyAttemptsUsed > verifyCodeAttempts) {
          return {
            ok: false,
            reason: 'need-verifycode',
            message: `验证码已尝试 ${verifyCodeAttempts} 次仍未通过`,
          }
        }
        onStatus?.({ kind: 'need-verifycode', message: classified.message })
        let entered = ''
        try {
          entered = String(await onVerifyCode({ attempt: verifyAttemptsUsed, message: classified.message }) ?? '').trim()
        } catch (error) {
          return { ok: false, reason: 'need-verifycode', message: `读取验证码失败：${error?.message ?? error}` }
        }
        if (!entered) {
          return { ok: false, reason: 'need-verifycode', message: '没有输入验证码' }
        }
        verifyCode = entered
        break
      }
      default:
        break
    }
    await wait(pollIntervalMs)
  }
  return { ok: false, reason: 'timeout', message: `等待扫码超时（${Math.round(timeoutMs / 1000)} 秒）` }
}

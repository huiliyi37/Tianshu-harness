/**
 * 微信通道配置读取（凭据、数据目录、状态文件路径）。
 *
 * 设计约束（沿用 QQ 通道，且更严）：
 * - 凭据零泄漏：bot_token 与 QQ 的 appSecret 同级，永不入日志、永不硬编码、永不进 git。
 * - 不硬编码个人路径：数据目录从运行时环境解析（与 QQ 通道同源，见 lib/data-dir.mjs）。
 * - 未配置 ownerUserId 时**一律拒收**（判定在 authorization.mjs；本模块只负责如实读出）。
 *
 * 读取顺序（环境变量优先，便于临时测试与 CI）：
 *   1. TIANSHU_IM_WEIXIN_TOKEN / TIANSHU_IM_WEIXIN_OWNER
 *   2. <数据目录>/weixin.json
 *
 * 为什么单独一个文件而不是塞进 config.json：QQ 的 config.json 里是 QQ 的凭据，
 * 两条通道的配置混在一个文件里，改一处会牵动另一处；登录流程写回时也更容易出错。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pluginDataDir } from '../data-dir.mjs'

/** iLink 接入域名（协议文档给出，登录响应里的 baseurl 会覆盖它）。 */
export const DEFAULT_WEIXIN_BASE_URL = 'https://ilinkai.weixin.qq.com'

export function weixinConfigFile(env = process.env) {
  return join(pluginDataDir(env), 'weixin.json')
}

/** 通道运行态（游标、去重集、最近发信记录）。 */
export function weixinStateFile(env = process.env) {
  return join(pluginDataDir(env), 'weixin-state.json')
}

/** 会话上下文令牌（senderId → 最近 context_token），落盘便于重启后仍能回信。 */
export function weixinTokenContextFile(env = process.env) {
  return join(pluginDataDir(env), 'weixin-tokens.json')
}

function trimmedString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeBaseUrl(value) {
  const raw = trimmedString(value)
  if (!raw) return DEFAULT_WEIXIN_BASE_URL
  // 结尾斜杠归一：拼 endpoint 时我们自己加，避免出现 //ilink/bot/...
  return raw.replace(/\/+$/, '')
}

export function loadWeixinConfig(env = process.env) {
  const dataDir = pluginDataDir(env)
  const configFile = weixinConfigFile(env)

  let fileConfig = null
  let fileError = null
  if (existsSync(configFile)) {
    try {
      fileConfig = JSON.parse(readFileSync(configFile, 'utf8'))
      if (fileConfig === null || typeof fileConfig !== 'object' || Array.isArray(fileConfig)) {
        fileError = `${configFile} 的内容不是对象，已按空配置处理`
        fileConfig = null
      }
    } catch (error) {
      fileError = `weixin.json 读取失败（${configFile}）: ${error?.message ?? error}`
    }
  }

  const envToken = trimmedString(env.TIANSHU_IM_WEIXIN_TOKEN)
  const envOwner = trimmedString(env.TIANSHU_IM_WEIXIN_OWNER)

  const botToken = envToken || trimmedString(fileConfig?.botToken)
  const ownerUserId = envOwner || trimmedString(fileConfig?.ownerUserId)
  const workspace = trimmedString(fileConfig?.workspace)
  const baseUrl = normalizeBaseUrl(fileConfig?.baseUrl)

  return {
    configured: Boolean(botToken),
    botToken: botToken || null, // 仅交给连接层构造请求头；本对象绝不整体打印
    ownerUserId: ownerUserId || null,
    baseUrl,
    enabled: fileConfig?.enabled !== false,
    // 可选：微信会话统一工作区（配置后所有微信会话在该目录处理；留空 = 按会话隔离）
    workspace: workspace || null,
    source: envToken ? 'env' : (fileConfig ? 'file' : 'none'),
    dataDir,
    configFile,
    stateFile: weixinStateFile(env),
    tokenContextFile: weixinTokenContextFile(env),
    configError: fileError,
  }
}

/** 展示用脱敏（日志 / im_status）：前 4 + … + 后 3。 */
export function maskToken(token) {
  if (typeof token !== 'string' || token.length === 0) return null
  if (token.length <= 8) return `${token.slice(0, 2)}…`
  return `${token.slice(0, 4)}…${token.slice(-3)}`
}

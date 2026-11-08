/**
 * 凭据与配置读取。
 *
 * 设计约束（项目红线）：
 * - 凭据零泄漏：secret 永不入日志、永不硬编码、永不进 git
 * - 不硬编码个人路径：数据目录从运行时环境解析
 *
 * 读取顺序（环境变量优先，便于临时测试）：
 *   1. <数据目录>/config.json          —— 长期方案（分享给朋友时用这个）
 *   2. 环境变量 TIANSHU_IM_QQ_APPID / TIANSHU_IM_QQ_SECRET —— 临时 / CI
 *
 * 数据目录：$RIVET_HOME/imbridge（RIVET_HOME 缺失时回退 ~/.rivet/imbridge）
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pluginDataDir } from '../data-dir.mjs'

// 数据目录解析已抽到 lib/data-dir.mjs（两通道共用），此处原样再导出：
// 既有调用方（index.js 的 im_status、测试）按旧路径 import 的行为不变。
export { pluginDataDir }

export function loadQqConfig(env = process.env) {
  const dataDir = pluginDataDir(env)
  const configFile = join(dataDir, 'config.json')

  let fileConfig = null
  let fileError = null
  if (existsSync(configFile)) {
    try {
      fileConfig = JSON.parse(readFileSync(configFile, 'utf8'))
    } catch (error) {
      fileError = `config.json 读取失败: ${error?.message ?? error}`
    }
  }

  const envAppId = typeof env.TIANSHU_IM_QQ_APPID === 'string' ? env.TIANSHU_IM_QQ_APPID.trim() : ''
  const envSecret = typeof env.TIANSHU_IM_QQ_SECRET === 'string' ? env.TIANSHU_IM_QQ_SECRET.trim() : ''

  const appId = envAppId
    || (typeof fileConfig?.appId === 'string' ? fileConfig.appId.trim() : '')
  const appSecret = envSecret
    || (typeof fileConfig?.appSecret === 'string' ? fileConfig.appSecret.trim() : '')

  return {
    configured: Boolean(appId && appSecret),
    appId: appId || null,
    appSecret: appSecret || null, // 仅交给连接层构造 SDK；此对象绝不整体打印
    enabled: fileConfig?.enabled !== false,
    // 可选：QQ 会话统一工作区（配置后所有 QQ 会话在该目录处理；留空 = 按会话隔离）
    workspace: typeof fileConfig?.workspace === 'string'
      ? (fileConfig.workspace.trim() || null)
      : null,
    // 安全前提：owner 白名单。只有该 openid 的消息（私聊与群聊）会被响应；
    // 留空 = 一律拒收（安全默认；判定逻辑见 lib/qq/authorization.mjs）。
    ownerUserOpenid: typeof fileConfig?.ownerUserOpenid === 'string'
      ? (fileConfig.ownerUserOpenid.trim() || null)
      : null,
    source: envAppId ? 'env' : (fileConfig ? 'file' : 'none'),
    dataDir,
    configFile,
    configError: fileError,
  }
}

/** 展示用脱敏（日志 / im_status）：前 4 + … + 后 3。 */
export function maskAppId(appId) {
  if (typeof appId !== 'string' || appId.length === 0) return null
  if (appId.length <= 8) return `${appId.slice(0, 2)}…`
  return `${appId.slice(0, 4)}…${appId.slice(-3)}`
}

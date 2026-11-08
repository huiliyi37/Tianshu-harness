/**
 * 常驻态持有者：配置、通道连接、消息桥的唯一副本。
 *
 * 为什么单独成模块：TPI 拆分后，入口（index.js）只做描述与握手，工具实现在 impl.js，
 * 两者都要读同一份连接/桥/配置。放在任一方的模块级变量都会造成「工具看到的连接是 null，
 * 实际连接却活着」这类幽灵状态——所以由第三方持有，两边共享。
 *
 * 骨架纪律（来自 2026-09-24 常驻探针实测 + 官方 design 插件提示）：
 * 1. 顶层保持轻量：顶层 import 链失败会让整个插件被天枢静默跳过。
 *    重依赖（QQ SDK / 桥接层 / serve 客户端）一律在真正用到时 lazy-import。
 * 2. 常驻逻辑每进程只执行一次：startResident() 内部用 residentInit 单例守卫。
 * 3. 插件跑在天枢进程内：一切异步自兜异常，任何失败都不能拖垮天枢本体。
 * 4. 不硬编码个人路径；凭据走配置/环境变量，永不入源码与日志。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { makeSessionMap } from './lib/session-map.mjs'

export const PLUGIN_NAME = 'tianshu-imbridge'
export const VERSION = '0.7.1'
const TIANSHU_TIMEOUT_MS = 180_000

// ── 运行状态：im_status 工具与后续模块共享 ──────────────────────
export const state = {
  phase: 'native-session', // skeleton → qq-connect → bridge → native-session → stable
  startedAt: new Date().toISOString(),
  configSource: null,      // QQ 侧（兼容旧字段）
  configFile: null,
  maskedAppId: null,
  maskedWeixinToken: null, // 微信侧
  weixinConfigFile: null,
  weixinConfigError: null,
  lastInboundAt: null,
  lastInboundSender: null,
  inboundCount: 0,
  lastError: null,
}

// ── 日志器：统一前缀，走 stderr（天枢 sidecar 日志可见）──────────
export const logger = {
  info: (...args) => console.error(`[${PLUGIN_NAME}]`, ...args),
  warn: (...args) => console.error(`[${PLUGIN_NAME}:warn]`, ...args),
  error: (...args) => console.error(`[${PLUGIN_NAME}:error]`, ...args),
}

// ── 通道配置（两份独立读；任一通道没配就是没启用，不是错误）────
let qqConfig = null
let weixinConfig = null

/** 配置访问器：未 startResident 前为 null（不触发读取，便于测试断言）。 */
export function getConfig(channel) {
  if (channel === 'qq') return qqConfig
  if (channel === 'weixin') return weixinConfig
  return null
}

// ── 多通道连接管理（懒加载；失败兜住，不影响插件本体）──────────
// Map<通道名, { connection, channel }>；QQ 与微信各一条，互不干扰。
export const connections = new Map()
const connectionInits = new Map()

/** 把一条连接包装成「连接器 + 通道身份」，供桥的出站路由认领。 */
function makeChannelConnector(connection, channel) {
  return {
    connection,
    channel,
    sendText: (target, text) => connection.sendText(target, text),
    sendTyping: (target, seconds) => connection.sendTyping?.(target, seconds),
    get status() {
      return connection?.status ?? null
    },
  }
}

/** 桥的出站回调按通道挑选连接器：空的 send 回调曾让 QQ 回复全部失败。 */
export function pickConnector(target, preferred = 'qq') {
  const wanted = target && typeof target === 'object' && typeof target.channel === 'string'
    ? target.channel
    : preferred
  const hit = connections.get(wanted)
  if (hit) return hit
  return connections.get(preferred) ?? null
}

export async function ensureConnected(channel) {
  if (connections.has(channel)) return connections.get(channel)
  const pending = connectionInits.get(channel)
  if (pending) return pending
  const run = (async () => {
    try {
      if (channel === 'weixin') {
        if (!weixinConfig?.configured) {
          logger.info('微信未配置：把 weixin.json 放进数据目录，或设置 TIANSHU_IM_WEIXIN_TOKEN')
          return null
        }
        if (!weixinConfig.enabled) {
          logger.info('微信连接在配置中被禁用（enabled=false）')
          return null
        }
        if (!weixinConfig.ownerUserId) {
          // 安全默认：未配置 owner = 全部拒收（见 lib/weixin/authorization.mjs）
          logger.warn(
            '未配置微信 ownerUserId：安全默认为「全部拒收」，任何微信消息都不会被响应。'
            + `请在该文件的 ownerUserId 字段填入您的 user_id 后重启天枢：${weixinConfig.configFile}`,
          )
        }
        const { WeixinConnection } = await import('./lib/weixin/connection.mjs')
        const connection = new WeixinConnection({
          config: weixinConfig,
          logger,
          dataDir: weixinConfig.dataDir,
          onMessage: (message) => handleInbound(message, 'weixin'),
        })
        const connector = makeChannelConnector(connection, 'weixin')
        connections.set('weixin', connector)
        connection.start()
        logger.info(`微信连接启动中（token=${state.maskedWeixinToken}，来源=${weixinConfig.source}）`)
        return connector
      }

      // 默认通道：QQ
      if (!qqConfig?.configured) {
        logger.info('QQ 未配置：将 config.json 放入数据目录，或设置 TIANSHU_IM_QQ_APPID / TIANSHU_IM_QQ_SECRET')
        return null
      }
      if (!qqConfig.enabled) {
        logger.info('QQ 连接在配置中被禁用（enabled=false）')
        return null
      }
      if (!qqConfig.ownerUserOpenid) {
        logger.warn(
          '未配置 ownerUserOpenid：安全默认为「全部拒收」，任何 QQ 消息都不会被响应。'
          + `请在该文件的 ownerUserOpenid 字段填入您的 openid 后重启天枢：${qqConfig.configFile}`,
        )
      }
      const { QqConnection } = await import('./lib/qq/connection.mjs')
      const connection = new QqConnection({
        config: qqConfig,
        logger,
        dataDir: qqConfig.dataDir,
        onMessage: (message) => handleInbound(message, 'qq'),
      })
      const connector = makeChannelConnector(connection, 'qq')
      connections.set('qq', connector)
      connection.start()
      logger.info(`QQ 连接启动中（appId=${state.maskedAppId}，来源=${qqConfig.source}）`)
      return connector
    } catch (error) {
      state.lastError = error?.message ?? String(error)
      logger.error(`${channel} 连接初始化失败:`, state.lastError)
      return null
    } finally {
      connectionInits.delete(channel)
    }
  })()
  connectionInits.set(channel, run)
  return run
}

/** 老入口名保留（QQ 时代就这么叫，测试与后续代码都可能引用）。 */
export function ensureConnection() {
  return ensureConnected('qq')
}

// ── 消息桥（懒加载；双模式）───────────────────────────────────
let bridge = null
let bridgeInit = null

/** 桥实例访问器（未建桥时为 null，供 im_status 如实报告）。 */
export function getBridge() {
  return bridge
}

/**
 * 并发首条消息只建一次桥（与 ensureConnected 同一手法）。
 * 建两次会得到两个 HistoryStore 写同一个 history.json，headless 路径下可能丢历史。
 */
export async function buildBridge() {
  if (bridge) return bridge
  bridgeInit ??= buildBridgeOnce().finally(() => {
    if (!bridge) bridgeInit = null // 建失败 → 下一条消息可重试
  })
  return bridgeInit
}

async function buildBridgeOnce() {
  const { ImBridge } = await import('./lib/bridge.mjs')
  const { buildInvocation, callTianshu, resolveRuntimeDir } = await import('./lib/tianshu.mjs')
  const { HistoryStore } = await import('./lib/history.mjs')
  const { createServeClientIfAvailable } = await import('./lib/serve-client.mjs')
  const { createCommandHandlers, dispatchCommand } = await import('./lib/command-handlers.mjs')
  const runtimeDir = resolveRuntimeDir()
  const homeDir = process.env.RIVET_HOME?.trim()
  if (!homeDir) throw new Error('RIVET_HOME 未设置，无法定位天枢数据目录')
  const nodePath = process.execPath
  // 数据目录与工作区覆盖取「第一个已启用的通道」：桥是单例（会话历史与绑定只有一份），
  // 让两个通道共用它，会话标识里已经带了通道前缀（c2c:/group:），不会串号。
  const primary = (weixinConfig?.configured && weixinConfig.enabled ? weixinConfig : null)
    ?? (qqConfig?.configured && qqConfig.enabled ? qqConfig : null)
  const dataDir = primary?.dataDir ?? qqConfig?.dataDir ?? weixinConfig?.dataDir
  if (!dataDir) throw new Error('没有可用通道的数据目录（QQ 与微信都未配置）')
  const workspaceOverride = qqConfig?.workspace ?? weixinConfig?.workspace ?? null
  const workspaceRoot = join(dataDir, 'workspace')
  const historyStore = new HistoryStore({ file: join(dataDir, 'history.json') })
  const sessionMap = makeSessionMap(join(dataDir, 'session-map.json'))
  const { makeCommandHints } = await import('./lib/command-hints.mjs')
  const commandHints = makeCommandHints(join(dataDir, 'command-hints.json'))

  // serve 原生会话通道：仅当插件运行在 serve 进程内时可用（token + --port 可探）
  const serveClient = createServeClientIfAvailable()

  // 命令层：以 / 开头且形状合法的消息走这里，不送模型
  const commandHandlers = createCommandHandlers({
    workspace: workspaceOverride,
    serveClient,
    sessionMap,
  })

  bridge = new ImBridge({
    workspaceRoot,
    workspaceOverride,
    logger,
    ensureDir: (dir) => mkdirSync(dir, { recursive: true }),
    historyStore,
    serveClient,
    sessionMap,
    commandHints,
    onCommand: (ctx) => dispatchCommand(ctx, commandHandlers),
    call: async ({ cwd, prompt }) => {
      const invocation = buildInvocation({
        runtimeDir, nodePath, homeDir, cwd, prompt,
      })
      return callTianshu(invocation, { timeoutMs: TIANSHU_TIMEOUT_MS })
    },
    send: async (target, text) => {
      // 按目标自带的通道标签回信；缺标签时按「谁先配置认谁」兜底。
      // 桥把 target 当作不透明句柄，通道身份由连接层写进去、这里认领。
      const connector = pickConnector(target, connections.has('qq') ? 'qq' : 'weixin')
      if (!connector) throw new Error('没有可用的通道连接（QQ 与微信都未就绪）')
      return connector.sendText(target, text)
    },
  })
  logger.info(
    `消息桥就绪（模式=${bridge.mode}，工作区=${workspaceOverride ?? workspaceRoot}`
    + `${serveClient ? `，serve=${serveClient.baseUrl}` : ''}）`,
  )
  return bridge
}

/** 入站消息：日志 + 交给桥（异步；同会话由桥内部串行）。 */
function handleInbound(message, channel = 'qq') {
  state.inboundCount += 1
  state.lastInboundAt = new Date().toISOString()
  if (typeof message?.senderId === 'string' && message.senderId) {
    state.lastInboundSender = message.senderId
  }
  const kind = message?.kind ?? 'unknown'
  const from = typeof message?.senderId === 'string' ? `${message.senderId.slice(0, 10)}…` : '?'
  const preview = typeof message?.content === 'string' ? message.content.replace(/\s+/g, ' ').slice(0, 80) : ''
  logger.info(`📨 收到消息 [${channel}/${kind}] 来自 ${from}: "${preview}"`)

  // 连接层已在自己的循环里报错并重试；这一层只管把消息送进桥，异常自兜。
  void (async () => {
    try {
      const b = await buildBridge()
      await b.handle(message)
    } catch (error) {
      state.lastError = error?.message ?? String(error)
      logger.error('消息处理失败:', state.lastError)
      try {
        await pickConnector(message?.replyTarget, channel)
          ?.sendText?.(message?.replyTarget, `（内部错误：${state.lastError}）`)
      } catch { /* 尽力而为 */ }
    }
  })()
}

// ── 常驻启动（原入口顶层逻辑；由 TPI 的 activate() 触发，幂等）──
let residentInit = null

/**
 * 读两份通道配置并按需建连。每进程只真正执行一次：
 * TPI 宿主可能在每次工具快照重建时重新 import 入口，重复建连会开出多条 QQ/微信连接
 * （QQ 网关对重复连接的分发行为没有官方定义，同一条消息可能被两端同时处理）。
 * @returns {Promise<{qq: object|null, weixin: object|null}>}
 */
export function startResident() {
  residentInit ??= bootstrapResident()
  return residentInit
}

async function bootstrapResident() {
  try {
    const { loadQqConfig, maskAppId } = await import('./lib/qq/config.mjs')
    const { loadWeixinConfig, maskToken } = await import('./lib/weixin/config.mjs')
    qqConfig = loadQqConfig()
    weixinConfig = loadWeixinConfig()
    state.configSource = qqConfig.source
    state.configFile = qqConfig.configFile
    state.maskedAppId = maskAppId(qqConfig.appId)
    state.weixinConfigFile = weixinConfig.configFile
    state.maskedWeixinToken = maskToken(weixinConfig.botToken)
    state.weixinConfigError = weixinConfig.configError
    if (qqConfig.configError) logger.warn(qqConfig.configError)
    if (weixinConfig.configError) logger.warn(weixinConfig.configError)
  } catch (error) {
    logger.error('通道配置读取失败:', error?.message ?? error)
    return { qq: null, weixin: null }
  }
  // 两条通道各自的失败互不牵连（互不 await）
  if (qqConfig.configured) void ensureConnected('qq')
  if (weixinConfig.configured) void ensureConnected('weixin')
  return { qq: qqConfig, weixin: weixinConfig }
}

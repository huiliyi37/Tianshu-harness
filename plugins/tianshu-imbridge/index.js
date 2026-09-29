/**
 * tianshu-imbridge — 天枢 IM 插件（QQ 渠道）· W5（桌面端原生会话）
 *
 * 目标：手机 QQ 消息直接进入天枢、天枢回复直接回到 QQ，中间不经 DSH；
 * 且每个 QQ 对话线以「桌面端原生会话」形式可见（模仿 dsh-im 的会话绑定做法）。
 *
 * 骨架纪律（来自 2026-09-24 常驻探针实测 + 官方 design 插件提示）：
 * 1. 入口顶层保持轻量：顶层 import 链失败会让整个插件被天枢静默跳过。
 *    重依赖（QQ SDK / 桥接层 / serve 客户端）一律在真正用到时 lazy-import。
 * 2. 顶层常驻逻辑每进程只执行一次（探针实测：serve 与 headless 两种入口均恰好 1 次）。
 * 3. 插件跑在天枢进程内：一切异步自兜异常，任何失败都不能拖垮天枢本体。
 * 4. 不硬编码个人路径；凭据走配置/环境变量，永不入源码与日志。
 *
 * W5 模式：
 * - serve-native：插件运行在 serve 进程内（可读 token/port）→ 用桌面端原生会话
 *   （首条消息建会话、后续 prompt 同一会话；回复经事件流收集）
 * - headless：非 serve 环境降级（每会话独立 cwd + 客户端历史注入）
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { makeSessionMap } from './lib/session-map.mjs'
import { join } from 'node:path'

const PLUGIN_NAME = 'tianshu-imbridge'
const VERSION = '0.4.0'
const TIANSHU_TIMEOUT_MS = 180_000

// ── 运行状态：im_status 工具与后续模块共享 ──────────────────────
const state = {
  phase: 'native-session', // skeleton → qq-connect → bridge → native-session → stable
  startedAt: new Date().toISOString(),
  connection: 'idle',
  configSource: null,
  configFile: null,
  maskedAppId: null,
  lastInboundAt: null,
  lastInboundSender: null,
  inboundCount: 0,
  lastError: null,
}

// ── 日志器：统一前缀，走 stderr（天枢 sidecar 日志可见）──────────
const logger = {
  info: (...args) => console.error(`[${PLUGIN_NAME}]`, ...args),
  warn: (...args) => console.error(`[${PLUGIN_NAME}:warn]`, ...args),
  error: (...args) => console.error(`[${PLUGIN_NAME}:error]`, ...args),
}

// ── 连接管理（懒加载；失败兜住，不影响插件本体）─────────────────
let connection = null
let connectionInit = null
let qqConfig = null

function ensureConnection() {
  if (connection) return connection
  if (connectionInit) return connectionInit
  connectionInit = (async () => {
    try {
      const { loadQqConfig, maskAppId } = await import('./lib/qq/config.mjs')
      const config = loadQqConfig()
      qqConfig = config
      state.configSource = config.source
      state.configFile = config.configFile
      state.maskedAppId = maskAppId(config.appId)
      if (config.configError) {
        logger.warn(config.configError)
      }
      if (!config.configured) {
        state.connection = 'not-configured'
        state.lastError = config.configError ?? `未配置凭据（${config.configFile}）`
        logger.info('QQ 未配置：将 config.json 放入数据目录，或设置 TIANSHU_IM_QQ_APPID / TIANSHU_IM_QQ_SECRET')
        return null
      }
      if (!config.enabled) {
        state.connection = 'disabled'
        logger.info('QQ 连接在配置中被禁用（enabled=false）')
        return null
      }
      if (!config.ownerUserOpenid) {
        // 安全默认：未配置 owner = 全部拒收（见 lib/qq/authorization.mjs）。
        // 这条日志是给「装了却没反应」的用户看的，必须写清原因与修复位置。
        logger.warn(
          '未配置 ownerUserOpenid：安全默认为「全部拒收」，任何 QQ 消息都不会被响应。'
          + `请在该文件的 ownerUserOpenid 字段填入您的 openid 后重启天枢：${config.configFile}`,
        )
      }
      const { QqConnection } = await import('./lib/qq/connection.mjs')
      connection = new QqConnection({
        config,
        logger,
        dataDir: config.dataDir,
        onMessage: handleInbound,
      })
      connection.start()
      state.connection = 'starting'
      logger.info(`QQ 连接启动中（appId=${state.maskedAppId}，来源=${config.source}）`)
      return connection
    } catch (error) {
      state.connection = 'init-failed'
      state.lastError = error?.message ?? String(error)
      logger.error('QQ 连接初始化失败:', state.lastError)
      return null
    } finally {
      connectionInit = null
    }
  })()
  return connectionInit
}

// ── 消息桥（懒加载；W5 双模式）───────────────────────────────────
let bridge = null
let bridgeInit = null

/**
 * 并发首条消息只建一次桥（与 ensureConnection 同一手法）。
 * 建两次会得到两个 HistoryStore 写同一个 history.json，headless 路径下可能丢历史。
 */
async function buildBridge() {
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
  const workspaceRoot = join(qqConfig.dataDir, 'workspace')
  const historyStore = new HistoryStore({ file: join(qqConfig.dataDir, 'history.json') })
  const sessionMap = makeSessionMap(join(qqConfig.dataDir, 'session-map.json'))
  const { makeCommandHints } = await import('./lib/command-hints.mjs')
  const commandHints = makeCommandHints(join(qqConfig.dataDir, 'command-hints.json'))

  // serve 原生会话通道：仅当插件运行在 serve 进程内时可用（token + --port 可探）
  const serveClient = createServeClientIfAvailable()

  // 命令层：QQ 消息以 / 开头且形状合法时走这里，不送模型
  const commandHandlers = createCommandHandlers({
    workspace: qqConfig.workspace,
    serveClient,
    sessionMap,
  })

  bridge = new ImBridge({
    workspaceRoot,
    workspaceOverride: qqConfig.workspace ?? null,
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
      if (!connection) throw new Error('QQ 连接未就绪')
      return connection.sendText(target, text)
    },
  })
  logger.info(
    `消息桥就绪（模式=${bridge.mode}，工作区=${qqConfig.workspace ?? workspaceRoot}`
    + `${serveClient ? `，serve=${serveClient.baseUrl}` : ''}）`,
  )
  return bridge
}

/** 入站消息：日志 + 交给桥（异步；同会话由桥内部串行）。 */
function handleInbound(message) {
  state.inboundCount += 1
  state.lastInboundAt = new Date().toISOString()
  if (typeof message?.senderId === 'string' && message.senderId) {
    state.lastInboundSender = message.senderId
  }
  const kind = message?.kind ?? 'unknown'
  const from = typeof message?.senderId === 'string' ? `${message.senderId.slice(0, 10)}…` : '?'
  const preview = typeof message?.content === 'string' ? message.content.replace(/\s+/g, ' ').slice(0, 80) : ''
  logger.info(`📨 收到消息 [${kind}] 来自 ${from}: "${preview}"`)

  void connection?.sendTyping?.(message?.replyTarget) // C2C 键入指示（尽力而为）
  void (async () => {
    try {
      const b = await buildBridge()
      await b.handle(message)
    } catch (error) {
      state.lastError = error?.message ?? String(error)
      logger.error('消息处理失败:', state.lastError)
      try {
        await connection?.sendText?.(message?.replyTarget, `（内部错误：${state.lastError}）`)
      } catch { /* 尽力而为 */ }
    }
  })()
}

// ── 顶层常驻区：配置存在则自动建立 QQ 连接 ─────────────────────
// （探针实测：本区域每进程只执行一次；连接句柄随进程生命周期存续）
ensureConnection().catch((error) => {
  logger.error('顶层初始化异常:', error?.message ?? error)
})

// ── 工具 ─────────────────────────────────────────────────────
export const tools = [
  {
    definition: {
      name: 'im_status',
      description: 'Report tianshu-imbridge status: phase, mode (serve-native/headless), QQ connection, session map, inbound/reply stats',
      input_schema: { type: 'object', properties: {} },
    },
    execute: async () => {
      let serveAvailable = false
      try {
        const { probeServerEnv } = await import('./lib/serve-client.mjs')
        serveAvailable = probeServerEnv().available
      } catch { /* ignore */ }
      // 会话绑定数：读落盘事实（与桥共用同一按路径缓存），桥未建时也能如实报告
      let sessionMapSize = 0
      try {
        const { pluginDataDir } = await import('./lib/qq/config.mjs')
        sessionMapSize = makeSessionMap(join(pluginDataDir(process.env), 'session-map.json')).size()
      } catch (error) {
        logger.warn('im_status: 会话绑定表读取失败:', error?.message ?? error)
      }
      return {
        content: JSON.stringify(
          {
            plugin: PLUGIN_NAME,
            version: VERSION,
            phase: state.phase,
            mode: bridge?.mode ?? 'not-started',
            serveAvailable,
            // 实时优先：连接对象在时以它的状态机为准（state.connection 只在启动期写过一次）
            connection: connection?.status?.state ?? state.connection,
            connectionDetail: connection?.status ?? null,
            bridgeStats: bridge?.stats ?? null,
            sessionMapSize,
            maskedAppId: state.maskedAppId,
            security: {
              ownerConfigured: Boolean(qqConfig?.ownerUserOpenid),
              inboundPolicy: qqConfig?.ownerUserOpenid ? 'owner-only' : 'block-all',
              blockedCount: connection?.status?.filteredCount ?? 0,
            },
            configSource: state.configSource,
            configFile: state.configFile,
            inboundCount: state.inboundCount,
            lastInboundAt: state.lastInboundAt,
            pid: process.pid,
            uptimeSec: Math.round(process.uptime()),
            startedAt: state.startedAt,
            lastError: state.lastError,
          },
          null,
          2,
        ),
      }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  },
  {
    definition: {
      name: 'im_send',
      description: 'Send a proactive QQ message to the owner (notification). Defaults to ownerUserOpenid from config, or the last inbound sender.',
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Message text to send' },
          targetId: { type: 'string', description: 'Optional openid; defaults to owner/last sender' },
        },
        required: ['text'],
      },
    },
    execute: async (params) => {
      const text = typeof params?.text === 'string' ? params.text.trim() : ''
      if (!text) return { content: 'im_send 需要 text 参数', isError: true }
      const targetId = (typeof params?.targetId === 'string' ? params.targetId.trim() : '')
        || qqConfig?.ownerUserOpenid
        || state.lastInboundSender
      if (!targetId) {
        return { content: '无发送目标：请配置 ownerUserOpenid，或先收到一条消息', isError: true }
      }
      if (!connection) return { content: 'QQ 连接未就绪', isError: true }
      try {
        // 无 msgId → 主动消息（受平台额度限制，适合低频通知）
        await connection.sendText({ scope: 'c2c', targetId }, text)
        return { content: `已发送（to ${String(targetId).slice(0, 8)}…，${text.length} 字）` }
      } catch (error) {
        return { content: `发送失败：${error?.message ?? error}`, isError: true }
      }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  },
]

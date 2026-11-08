/**
 * 工具实现（TPI 迁移时从 index.js 原样搬入，业务逻辑零改动）。
 *
 * 依赖全部从 runtime.js 取：入口（index.js）只负责把这里的旧契约工具
 * 翻译成 TPI 形状；真正共享的连接/桥/配置由 runtime.js 持有。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeSessionMap } from './lib/session-map.mjs'
import {
  PLUGIN_NAME,
  VERSION,
  state,
  logger,
  connections,
  getConfig,
  getBridge,
} from './runtime.js'

// ── 微信绑定协助（agent 在天枢会话里配置通道的落点）──────────────
// 服务端要的二维码只有微信能给，而扫码要等主人拿手机——所以工具**立刻返回**
// （把二维码与步骤交回对话），真正的等待与收尾交给一个后台进程：
// 它跑的是 lib/weixin/binder-cli.mjs，与命令行工具共用同一份核心。

/** 绑定请求文件（后台进程从它读参数；用文件而不是命令行，避免参数进进程列表）。 */
function bindRequestFile(dataDir) {
  return join(dataDir, 'weixin-bind-request.json')
}

/** 绑定状态文件（对话侧读它判断进展）。 */
function bindStatusFile(dataDir) {
  return join(dataDir, 'weixin-bind-status.json')
}

/**
 * 把二维码 PNG 读成 data URL，交给宿主渲染在对话里。
 *
 * 任何失败都返回 null：图片是锦上添花，绝不能因为读图失败而让绑定流程报错
 * ——退回现状（用户在桌面找那个 PNG）就好了。
 */
function readQrDataUrl(qrPath) {
  if (!qrPath) return null
  try {
    return `data:image/png;base64,${readFileSync(qrPath).toString('base64')}`
  } catch {
    return null
  }
}

/**
 * 派生后台绑定进程；返回启动结果，不等待它结束。
 * 二维码落桌面这件事由 binder 负责（含桌面不可用时的回退与如实交代）。
 */
async function spawnBinderProcess(config) {
  const { spawn } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const binderCli = fileURLToPath(new URL('./lib/weixin/binder-cli.mjs', import.meta.url))
  const requestFile = bindRequestFile(config.dataDir)
  mkdirSync(config.dataDir, { recursive: true })
  writeFileSync(requestFile, `${JSON.stringify({
    configFile: config.configFile ?? join(config.dataDir, 'weixin.json'),
    dataDir: config.dataDir,
    baseUrl: config.baseUrl,
    statusFile: bindStatusFile(config.dataDir),
    timeoutMs: 300_000,
    qrFileName: '天枢-微信扫码.png',
  }, null, 2)}\n`)
  // detached + stdio ignore：这轮对话结束也不影响它；
  // 用 process.execPath 而不是写死 node 路径（红线 5：不硬编码个人路径）。
  const child = spawn(process.execPath, [binderCli, requestFile], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    cwd: config.dataDir,
  })
  child.unref()
  return { pid: child.pid ?? null }
}

// ── 工具 ─────────────────────────────────────────────────────
export const tools = [
  {
    definition: {
      name: 'im_status',
      description: 'Report tianshu-imbridge status: phase, mode (serve-native/headless), enabled channels (QQ / WeChat), session map, inbound/reply stats',
      input_schema: { type: 'object', properties: {} },
    },
    execute: async () => {
      const qqConfig = getConfig('qq')
      const weixinConfig = getConfig('weixin')
      const bridge = getBridge()
      let serveAvailable = false
      try {
        const { probeServerEnv } = await import('./lib/serve-client.mjs')
        serveAvailable = probeServerEnv().available
      } catch { /* ignore */ }
      // 会话绑定数：读落盘事实（与桥共用同一按路径缓存），桥未建时也能如实报告
      let sessionMapSize = 0
      try {
        const { pluginDataDir } = await import('./lib/data-dir.mjs')
        sessionMapSize = makeSessionMap(join(pluginDataDir(process.env), 'session-map.json')).size()
      } catch (error) {
        logger.warn('im_status: 会话绑定表读取失败:', error?.message ?? error)
      }
      const qq = connections.get('qq')
      const weixin = connections.get('weixin')
      // 绑定进展也一并上报：agent 排障时要能看出「是不是卡在扫码那一步」
      let weixinBind = null
      try {
        const { readBindStatus } = await import('./lib/weixin/binder.mjs')
        const dataDir = weixinConfig?.dataDir ?? qqConfig?.dataDir
        if (dataDir) weixinBind = readBindStatus(bindStatusFile(dataDir))
      } catch (error) {
        logger.warn('im_status: 绑定状态读取失败:', error?.message ?? error)
      }
      return {
        content: JSON.stringify(
          {
            plugin: PLUGIN_NAME,
            version: VERSION,
            phase: state.phase,
            mode: bridge?.mode ?? 'not-started',
            serveAvailable,
            // 两条通道各自上报：连接对象在时以它的状态机为准
            channels: {
              qq: {
                configured: Boolean(qqConfig?.configured),
                enabled: qqConfig?.enabled ?? null,
                connection: qq?.status?.state ?? 'not-started',
                detail: qq?.status ?? null,
                maskedAppId: state.maskedAppId,
                source: state.configSource,
                configFile: state.configFile,
              },
              weixin: {
                configured: Boolean(weixinConfig?.configured),
                enabled: weixinConfig?.enabled ?? null,
                connection: weixin?.status?.state ?? 'not-started',
                detail: weixin?.status ?? null,
                maskedToken: state.maskedWeixinToken,
                source: weixinConfig?.source ?? null,
                configFile: state.weixinConfigFile,
                configError: state.weixinConfigError,
                bind: weixinBind
                  ? {
                    state: weixinBind.state,
                    step: weixinBind.step,
                    qrPath: weixinBind.qrPath,
                    ownerFilled: weixinBind.ownerFilled,
                    updatedAt: weixinBind.updatedAt,
                  }
                  : null,
              },
            },
            // 兼容旧字段（QQ 视角），避免既有排障习惯被打断
            connection: qq?.status?.state ?? 'not-started',
            bridgeStats: bridge?.stats ?? null,
            sessionMapSize,
            security: {
              qqOwnerConfigured: Boolean(qqConfig?.ownerUserOpenid),
              weixinOwnerConfigured: Boolean(weixinConfig?.ownerUserId),
              inboundPolicy: 'owner-only（两条通道各自判定，未配置 owner 即全部拒收）',
              blockedCount: (qq?.status?.filteredCount ?? 0) + (weixin?.status?.filteredCount ?? 0),
            },
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
      description: 'Send a proactive message to the owner (notification) over QQ or WeChat. Defaults to the configured owner / last inbound sender of the chosen channel.',
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Message text to send' },
          targetId: { type: 'string', description: 'Optional openid/user_id; defaults to owner/last sender' },
          channel: { type: 'string', description: "Which channel to use: 'qq' or 'weixin' (defaults to the first ready one)" },
        },
        required: ['text'],
      },
    },
    execute: async (params) => {
      const qqConfig = getConfig('qq')
      const weixinConfig = getConfig('weixin')
      const text = typeof params?.text === 'string' ? params.text.trim() : ''
      if (!text) return { content: 'im_send 需要 text 参数', isError: true }
      const wanted = typeof params?.channel === 'string' ? params.channel.trim().toLowerCase() : ''
      const channel = wanted === 'qq' || wanted === 'weixin'
        ? wanted
        : (connections.has('qq') ? 'qq' : (connections.has('weixin') ? 'weixin' : 'qq'))
      const connector = connections.get(channel)
      if (!connector) return { content: `通道未就绪：${channel}（先确认配置并重启天枢）`, isError: true }
      const owned = channel === 'qq' ? qqConfig?.ownerUserOpenid : weixinConfig?.ownerUserId
      const targetId = (typeof params?.targetId === 'string' ? params.targetId.trim() : '')
        || owned
        || state.lastInboundSender
      if (!targetId) {
        return { content: `无发送目标：请配置 ${channel === 'qq' ? 'ownerUserOpenid' : 'ownerUserId'}，或先收到一条消息`, isError: true }
      }
      try {
        // 无 msgId → 主动消息（受平台额度限制，适合低频通知）
        await connector.sendText({ scope: 'c2c', targetId, channel }, text)
        return { content: `已发送（${channel} → ${String(targetId).slice(0, 8)}…，${text.length} 字）` }
      } catch (error) {
        return { content: `发送失败（${channel}）：${error?.message ?? error}`, isError: true }
      }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  },
  {
    definition: {
      name: 'weixin_bind_start',
      description: 'Start WeChat (iLink/ClawBot) binding: generates a QR code image onto the user\'s Desktop and waits in the background for the scan. Returns immediately with the image path and the steps the user must do. Call weixin_bind_status to check the result.',
      input_schema: { type: 'object', properties: {} },
    },
    execute: async () => {
      try {
        const { loadWeixinConfig } = await import('./lib/weixin/config.mjs')
        const { readBindStatus, DEFAULT_BIND_TIMEOUT_MS } = await import('./lib/weixin/binder.mjs')
        const config = loadWeixinConfig()
        const current = readBindStatus(bindStatusFile(config.dataDir))
        if (current.state === 'running' && current.updatedAt) {
          const ageMs = Date.now() - Date.parse(current.updatedAt)
          if (Number.isFinite(ageMs) && ageMs < DEFAULT_BIND_TIMEOUT_MS) {
            const qrImage = readQrDataUrl(current.qrPath)
            return {
              content: JSON.stringify({
                alreadyRunning: true,
                qrPath: current.qrPath,
                step: current.step,
                hint: '绑定已经在进行中：直接用那张二维码，扫完让我查进展即可。',
              }, null, 2),
              ...(qrImage ? { images: [qrImage] } : {}),
            }
          }
        }
        const { pid } = await spawnBinderProcess(config)
        // 给后台进程一点时间把二维码落到桌面，这样首次返回就能带上图片路径
        await new Promise((resolve) => { const t = setTimeout(resolve, 2_000); t.unref?.() })
        const after = readBindStatus(bindStatusFile(config.dataDir))
        const qrImage = readQrDataUrl(after.qrPath)
        return {
          content: JSON.stringify({
            started: true,
            pid,
            dataDir: config.dataDir,
            configFile: config.configFile,
            qrPath: after.qrPath,
            qrOnDesktop: after.qrOnDesktop,
            qrNote: after.qrNote,
            step: after.step,
            steps: [
              qrImage
                ? '直接扫上面这张二维码（图片已发到对话里）'
                : (after.qrPath
                  ? `打开桌面上的二维码图片（${after.qrPath}），用手机微信「扫一扫」`
                  : '等几秒后让我再查一次，二维码就绪了会给出图片位置'),
              '微信里若有提示（例如要验证码），把内容告诉我',
              '扫完后对我说一声，我查绑定结果',
            ],
          }, null, 2),
          ...(qrImage ? { images: [qrImage] } : {}),
        }
      } catch (error) {
        return { content: `启动微信绑定失败：${error?.message ?? error}`, isError: true }
      }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  },
  {
    definition: {
      name: 'weixin_bind_status',
      description: 'Check the WeChat binding progress: whether the QR was scanned, whether credentials were saved, and what to do next (usually: restart Tianshu).',
      input_schema: { type: 'object', properties: {} },
    },
    execute: async () => {
      try {
        const { loadWeixinConfig, maskToken } = await import('./lib/weixin/config.mjs')
        const { readBindStatus } = await import('./lib/weixin/binder.mjs')
        const config = loadWeixinConfig()
        const status = readBindStatus(bindStatusFile(config.dataDir))
        const live = loadWeixinConfig()
        const next = status.state === 'success'
          ? '凭据已就绪。请**重启天枢**（插件在启动时加载），重启后给这个微信发条消息即可验证。'
          : (status.state === 'running'
            ? '还在等扫码。二维码在桌面（或状态里的 qrPath），扫完再让我查一次。'
            : (status.state === 'need-verifycode'
              ? '服务端要验证码：把手机微信里显示的那串数字告诉我，我带着它重试。'
              : '没有正在进行的绑定。要接入微信的话，让我启动一次绑定。'))
        const qrImage = status.state === 'running' ? readQrDataUrl(status.qrPath) : null
        return {
          content: JSON.stringify({
            state: status.state,
            step: status.step,
            qrPath: status.qrPath,
            qrOnDesktop: status.qrOnDesktop,
            qrNote: status.qrNote,
            qrUrl: status.qrUrl,
            botId: status.botId,
            userId: status.userId,
            ownerFilled: status.ownerFilled,
            reason: status.reason,
            message: status.message,
            updatedAt: status.updatedAt,
            channelConfigured: Boolean(live.configured),
            maskedToken: maskToken(live.botToken),
            next,
          }, null, 2),
          ...(qrImage ? { images: [qrImage] } : {}),
        }
      } catch (error) {
        return { content: `查绑定状态失败：${error?.message ?? error}`, isError: true }
      }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  },
]

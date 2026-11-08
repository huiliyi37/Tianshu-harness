/**
 * 微信扫码绑定 · 与界面无关的核心（CLI 与天枢工具共用这一份）。
 *
 * 为什么要把「怎么绑」从「谁触发」里拆出来：
 * - 原来的绑定逻辑长在命令行工具里，天枢的工具没法复用，只能再写一遍——两份实现必然漂移。
 * - 抽到这里之后：命令行（人敲）与插件工具（agent 调）走同一条路、同一套失败语义。
 *
 * 它做的事：生成二维码 → 落桌面（不可用则回退数据目录）→ 等主人扫 → 收凭据 →
 * 写 weixin.json（**顺带把 ownerUserId 填上**，否则通道会静默不响应）→ 全程记状态文件。
 *
 * 一切失败都以状态文件里的字段表达，不抛给调用方。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { loadWeixinConfig, weixinConfigFile } from './config.mjs'
import { saveWeixinAccount, waitForQrLogin } from './login.mjs'
import { renderQrPngBytes } from './qr.mjs'
import { writeQrImage } from './paths.mjs'

/** 绑定的总时限（给主人拿手机的时间）。 */
export const DEFAULT_BIND_TIMEOUT_MS = 300_000

/** 绑定状态文件（同一个文件覆盖写，首次为 null）。 */
export function emptyBindStatus() {
  return {
    state: 'idle',            // idle | running | need-verifycode | success | failed | timeout | already-bound
    startedAt: null,
    updatedAt: null,
    qrPath: null,
    qrOnDesktop: null,
    qrNote: null,
    qrUrl: null,
    step: null,               // 给对话用的人类可读进展
    botId: null,
    userId: null,
    ownerFilled: false,
    reason: null,
    message: null,
    finishedAt: null,
  }
}

export function readBindStatus(file) {
  if (!file) return emptyBindStatus()
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...emptyBindStatus(), ...parsed }
    }
  } catch { /* 文件不存在或坏掉：当作从未绑定 */ }
  return emptyBindStatus()
}

export function writeBindStatus(file, patch) {
  // 契约：总返回合并后的状态对象——runBind 把它当返回值用，落盘只是「有文件时」的副作用。
  // （曾对无 file 直接 return null：CLI 不带 statusFile 时，收尾读 final.qrPath 崩溃，
  //  超时/成功这些真实结果被吞成「绑定流程异常」。）
  const next = { ...readBindStatus(file), ...patch, updatedAt: new Date().toISOString() }
  if (!file) return next
  try {
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`)
  } catch { /* 状态写不进去不该中断绑定本身 */ }
  return next
}

/**
 * 跑一轮绑定，并全程把进展写进状态文件。
 *
 * @param {{configFile:string, dataDir:string, baseUrl?:string, statusFile?:string,
 *          timeoutMs?:number, qrFileName?:string, env?:object, fetchImpl?:Function,
 *          sleep?:Function, libs?:object, askVerifyCode?:Function}} options
 * @returns {Promise<object>} 最终状态
 */
export async function runBind({
  configFile,
  dataDir,
  baseUrl,
  statusFile = null,
  timeoutMs = DEFAULT_BIND_TIMEOUT_MS,
  qrFileName = '天枢-微信扫码.png',
  env = process.env,
  fetchImpl,
  sleep,
  libs,
  askVerifyCode,
} = {}) {
  if (!configFile) throw new TypeError('runBind 需要 configFile')
  // 状态以内存链为权威（起始读一次盘），落盘只是「有 statusFile 时」的副作用。
  // 合并基准若依赖读盘，CLI 场景（没有 statusFile）onQr 记下的 qrPath/qrUrl 会在收尾时消失。
  let statusState = readBindStatus(statusFile)
  const status = (patch) => {
    statusState = { ...statusState, ...patch, updatedAt: new Date().toISOString() }
    if (statusFile) {
      try { writeFileSync(statusFile, `${JSON.stringify(statusState, null, 2)}\n`) } catch { /* 状态写不进去不该中断绑定本身 */ }
    }
    return statusState
  }

  status({
    state: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    reason: null,
    message: null,
    step: '正在向微信申请二维码…',
    qrPath: null,
  })

  const result = await waitForQrLogin({
    baseUrl: baseUrl ?? loadWeixinConfig(env).baseUrl,
    timeoutMs,
    fetchImpl,
    sleep,
    onQr: async ({ qrUrl, refreshed }) => {
      const { bytes, error } = await renderQrPngBytes(qrUrl, { libs })
      if (!bytes) {
        status({
          step: '二维码图片渲染失败，请用对话里给出的链接自行生成二维码',
          qrUrl,
          qrNote: error ?? null,
        })
        return
      }
      const placed = writeQrImage(bytes, { env, fileName: qrFileName, fallbackDir: dataDir })
      status({
        qrPath: placed.path,
        qrOnDesktop: placed.onDesktop,
        qrNote: placed.note,
        qrUrl,
        step: refreshed ? '二维码已刷新，请重新扫码' : '二维码已就绪，请去扫它',
      })
    },
    onStatus: (info) => {
      if (info?.kind === 'poll-error') return
      if (info?.kind === 'pending') status({ step: '等待扫码…' })
      if (info?.kind === 'need-verifycode') status({ state: 'need-verifycode', step: '需要手机上的验证码' })
    },
    onVerifyCode: askVerifyCode,
  })

  if (!result.ok) {
    const stateByReason = {
      'already-bound': 'already-bound',
      timeout: 'timeout',
      'need-verifycode': 'need-verifycode',
    }
    return status({
      state: stateByReason[result.reason] ?? 'failed',
      reason: result.reason,
      message: result.message ?? null,
      step: '绑定未完成',
      finishedAt: new Date().toISOString(),
    })
  }

  // 先看主人的既有配置：ownerUserId 为空才自动填。它是**授权对象**（谁能指挥这台机器），
  // 不是「谁扫的码」；只在本来就没人被授权时替主人做，已有 owner 一律不覆盖。
  let existingOwner = ''
  try {
    const existing = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {}
    existingOwner = typeof existing?.ownerUserId === 'string' ? existing.ownerUserId.trim() : ''
  } catch { /* 配置坏了：当作没配 */ }

  const saved = saveWeixinAccount(configFile, {
    botToken: result.token,
    botId: result.botId,
    userId: result.userId,
    baseUrl: result.baseUrl ?? undefined,
    ...(!existingOwner && result.userId ? { ownerUserId: result.userId } : {}),
  })

  return status({
    state: 'success',
    step: '绑定成功：凭据已写入配置',
    botId: result.botId ?? null,
    userId: result.userId ?? null,
    ownerFilled: Boolean(saved.ownerUserId),
    message: saved.ownerUserId
      ? `凭据已写入；ownerUserId=${saved.ownerUserId}（只有它会被响应）`
      : '凭据已写入，但没能自动填上 ownerUserId：请手工补，否则通道不会响应任何消息',
    finishedAt: new Date().toISOString(),
  })
}

/** 便捷包装：直接按环境变量与配置路径跑一轮（CLI 与工具都用它）。 */
export async function runBindFromEnv(env = process.env, overrides = {}) {
  const config = loadWeixinConfig(env)
  return runBind({
    configFile: overrides.configFile ?? weixinConfigFile(env),
    dataDir: config.dataDir,
    baseUrl: config.baseUrl,
    env,
    ...overrides,
  })
}

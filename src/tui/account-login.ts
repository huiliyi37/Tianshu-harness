/**
 * 天枢账号的登录/登出实现（`/login account` 与 `/logout` 背后的逻辑）。
 *
 * ## 为什么单独成文件
 * `slash-commands.ts` 是行数棘轮点名的巨石（只降不升，ceiling 4622）。账号登录
 * 的编排（device flow 三步 + 三种终态的分别提示）有 ~60 行，全部堆在那个文件里
 * 会把它推过线。抽出来之后那边只剩注册壳，且这里的逻辑能用桩 app 单测。
 *
 * ## 与 provider OAuth 的分工
 * 本模块只管**天枢账号**（Supabase 身份）。模型 provider 的 OAuth（codex 等）
 * 仍走 `../auth/login-flow.ts` ——两者凭据分文件存放
 * （account.json vs `<provider>.json`），登出互不影响。
 * （这里刻意不写出那个函数名：源码守卫断言会扫注释，写出来会被判成误用。）
 */
import { accountDeviceFingerprint } from '../auth/account-device.js'
import { hostname } from 'node:os'

/**
 * 只需要 commitStatic —— 用结构类型而非完整 App 类型，
 * 便于单测用桩替换，不必构造整个 TUI app。
 */
export interface StaticLineApp {
  commitStatic: (text: string) => void
}

/**
 * 跑一次天枢账号登录：申请设备码 → 开浏览器 → 轮询 → 落盘。
 *
 * 全程只往静态行输出，不改流式状态——调用方（slash handler）自己管
 * setIsStreaming 那套。
 */
export async function handleAccountLogin(app: StaticLineApp, onResult?: (success: boolean) => void, options: { openBrowser?: (url: string) => void } = {}): Promise<boolean> {
  onResult?.(false)
  const {
    requestDeviceCode,
    pollForAccountToken,
    accountStore,
    saveAccountToken,
    isTerminalPollStatus,
  } = await import('../auth/account.js')
  const { openInBrowser } = await import('../auth/login-flow.js')
  const { rivetHome } = await import('../config/paths.js')

  app.commitStatic('正在向天枢申请设备授权…')

  let created: Awaited<ReturnType<typeof requestDeviceCode>>
  try {
    created = await requestDeviceCode({ deviceName: hostname(), deviceFingerprint: accountDeviceFingerprint(rivetHome()) })
  } catch (e) {
    // 连不上是最常见的失败（网络/自托管地址错配），单独提示——别让用户对着
    // 「授权未能完成」猜是网络问题还是自己操作错了
    app.commitStatic(`⚠️ 无法连接天枢账号服务：${(e as Error).message}`)
    return true
  }

  const openBrowser = options.openBrowser ?? openInBrowser
  openBrowser(created.verifyUrl)
  app.commitStatic(
    `请在浏览器完成授权（已尝试自动打开）：\n${created.verifyUrl}\n\n` +
      `设备码：${created.userCode} · ${Math.round(created.expiresIn / 60)} 分钟内有效\n` +
      '等待授权中…（Ctrl+C 可取消）',
  )

  const result = await pollForAccountToken(created.deviceCode, {
    intervalSeconds: created.pollInterval,
    timeoutMs: created.expiresIn * 1000,
  })

  if (result.status === 'approved' && result.accessToken) {
    const token = saveAccountToken(accountStore(rivetHome()), result)
    onResult?.(true)
    // 顺带把星籍取回来落盘（与 sidecar 的 POST /account/poll 同法）：这是唯一
    // 确定在线的时刻，之后 /status 就能离线显示身份。拉不到不影响登录结果。
    const { primeStellarIdentity } = await import('./account-status.js')
    const identityLine = await primeStellarIdentity(token.accessToken)
    app.commitStatic('✅ 已登录天枢账号——桌面端与网页端现在看到同一份设备与订阅。')
    if (identityLine) app.commitStatic(`星籍：${identityLine}`)
    return true
  }

  // 三种终态给三种说法：用户下一步不同（重新发起 / 就是不想登 / 别的）
  const hint =
    result.status === 'denied'
      ? '你在浏览器里拒绝了本次授权。'
      : result.status === 'expired'
        ? '授权码已过期（5 分钟有效），请重新执行 /login account。'
        : `本次授权未能完成（${result.status}）。`
  void isTerminalPollStatus
  app.commitStatic(`⚠️ ${hint}`)
  return true
}

/**
 * 登出天枢账号：只清 `<RIVET_HOME>/account.json`。
 *
 * 刻意不碰 provider 凭据——TokenStore 按 provider 名分文件（`<provider>.json`），
 * 所以清账号不会顺手把用户的 codex 登录也清掉。
 */
export async function handleAccountLogout(app: StaticLineApp): Promise<boolean> {
  const { accountStore, revokeAccountSession } = await import('../auth/account.js')
  const { rivetHome } = await import('../config/paths.js')

  const store = accountStore(rivetHome())
  const credential = store.load()?.accessToken
  store.clear()
  let revoked = !credential
  try { if (credential) revoked = await revokeAccountSession(credential) } catch {}
  app.commitStatic(credential ? '✅ 已登出天枢账号。重新连接请执行 /login account；设备绑定会保留。' : '当前未登录天枢账号。')
  if (!revoked) app.commitStatic('⚠️ 远程会话注销未完成，可到官网账号页将旧会话下线。')
  return true
}

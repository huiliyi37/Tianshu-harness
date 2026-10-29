import type { DeviceCreateResult, DevicePollResult, PollStatus } from './account.js'

/**
 * 解析 `tui-auth-create` 的响应。
 *
 * 三个字段缺一不可：deviceCode 用于轮询，userCode 要展示给用户，
 * verifyUrl 是让用户去浏览器打开的地方——缺任何一个流程都走不下去，
 * 返回半成品只会让故障点后移（表现为「转圈」而不是报错）。
 */
export function parseDeviceCreate(raw: Record<string, unknown>): DeviceCreateResult {
  const deviceCode = raw.deviceCode
  const userCode = raw.userCode
  const verifyUrl = raw.verifyUrl

  if (typeof deviceCode !== 'string' || !deviceCode) {
    throw new Error('device create: missing deviceCode')
  }
  if (typeof userCode !== 'string' || !userCode) {
    throw new Error('device create: missing userCode')
  }
  if (typeof verifyUrl !== 'string' || !verifyUrl) {
    throw new Error('device create: missing verifyUrl')
  }

  return {
    deviceCode,
    userCode,
    verifyUrl,
    expiresIn: typeof raw.expiresIn === 'number' ? raw.expiresIn : 300,
    pollInterval: typeof raw.pollInterval === 'number' ? raw.pollInterval : 5,
  }
}

/**
 * 解析 `tui-auth-check` 的响应。
 *
 * `approved` 却没有 accessToken 视为异常而非「成功但空」——否则会把空凭据写盘，
 * 用户下次启动发现自己「已登录」但什么都做不了。
 */
export function parseDevicePoll(raw: Record<string, unknown>): DevicePollResult {
  const known: readonly string[] = ['pending', 'approved', 'denied', 'expired', 'already_consumed', 'error']
  const status: PollStatus = typeof raw.status === 'string' && known.includes(raw.status) ? raw.status as PollStatus : 'error'

  if (status === 'approved') {
    const accessToken = raw.accessToken
    if (typeof accessToken !== 'string' || !accessToken) {
      throw new Error('device poll: approved without accessToken')
    }
    return {
      status,
      accessToken,
      refreshToken: typeof raw.refreshToken === 'string' ? raw.refreshToken : undefined,
      expiresIn: typeof raw.expiresIn === 'number' ? raw.expiresIn : 3600,
    }
  }

  return { status }
}
